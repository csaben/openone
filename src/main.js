const { answerAfter } = require('./shotanswer');
const { app, BrowserWindow, ipcMain, screen, powerMonitor, globalShortcut, Notification, Tray, Menu, nativeImage, nativeTheme, shell, clipboard, desktopCapturer } = require('electron');
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Monitor } = require('./monitor');
const { createSource } = require('./sources');
const { WindowsTerminal } = require('./wt');
const { MacTerminal } = require('./macterm');
const actions = require('./actions');
const projects = require('./projects');
const { Embedder, semantic, projectText } = require('./embed');
const { detect: detectConfig } = require('./setup');
const voice = require('./voice');
const voicein = require('./voicein');

const MAC = process.platform === 'darwin';
// Apps started from Finder or at login get a bare PATH, without Homebrew's tmux or ~/.local/bin
if (MAC) process.env.PATH = [...new Set([...(process.env.PATH || '').split(':').filter(Boolean), '/opt/homebrew/bin', '/usr/local/bin', path.join(require('os').homedir(), '.local', 'bin')])].join(':');

// Installed builds keep config in %APPDATA%\openone (~/Library/Application Support/openone on
// a Mac); a source checkout uses ./config.json.
const CONFIG = app.isPackaged ? path.join(app.getPath('userData'), 'config.json') : path.join(__dirname, '..', 'config.json');
// assets are unpacked from the asar so Windows (toasts) can read them as plain files
const ASSETS = path.join(__dirname, '..', 'assets').replace('app.asar', 'app.asar.unpacked');
// Taskbar and toasts follow the Windows "system" theme, not the app theme:
// white cloud on a dark shell, black cloud on a light one.
function lightShell() {
  if (MAC) return !nativeTheme.shouldUseDarkColors;
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', '/v', 'SystemUsesLightTheme'],
      { encoding: 'utf8', windowsHide: true });
    return /0x1\s*$/m.test(out);
  } catch { return false; }
}
const shade = () => (lightShell() ? 'black' : 'white');
const toastIcon = () => path.join(ASSETS, `toast-${shade()}-256.png`);
// Only as big as what's showing: a full-size transparent topmost window makes the
// terminal underneath repaint, so collapsed it shrinks to the edge tab.
const SIZES = { tab: [34, 240], peek: [360, 240], full: [560, 660] };
let size = 'tab';
let lastState = '';

let cfg;
let win;
let tray;
let monitor;
let hosts = {};
let muted = false;
let pushTimer = null;
let messages = []; // agent-to-agent messages, from the openone server ("server" in the config)
let asks = []; // questions waiting on you, from the same server
const wt = MAC ? new MacTerminal() : new WindowsTerminal();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let firstRun = false;

function loadConfig() {
  if (!fs.existsSync(CONFIG)) {
    fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
    fs.writeFileSync(CONFIG, `${JSON.stringify(detectConfig(), null, 2)}\n`);
    firstRun = true;
  }
  cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  cfg.hosts = (cfg.hosts || []).filter((h) => h.enabled !== false);
  cfg.notify = { input: true, done: true, toast: true, sound: true, ...(cfg.notify || {}) };
}

function welcome() {
  const ssh = detectConfig().hosts.filter((h) => h.type === 'ssh').length;
  const n = new Notification({
    title: 'openone is running',
    body: `Wrote config.json${ssh ? ` with ${ssh} ssh host${ssh > 1 ? 's' : ''} from ~/.ssh/config, turned off` : ''}. Edit it, then Reload config from the tray.`,
    icon: toastIcon(),
  });
  n.on('click', () => shell.openPath(CONFIG));
  n.show();
}

function display() {
  const all = screen.getAllDisplays();
  return typeof cfg.display === 'number' && all[cfg.display] ? all[cfg.display] : screen.getPrimaryDisplay();
}

function bounds() {
  const a = display().workArea;
  const [w, h] = SIZES[size];
  return { x: a.x + a.width - w, y: a.y + Math.round((a.height - h) / 2), width: w, height: h };
}

function place() {
  if (win && !win.isDestroyed()) win.setBounds(bounds());
}

// Windows moves windows when monitors sleep, wake or reconnect, and display events
// arrive before the layout settles. So place again a little later, and check every
// few seconds that the dock is still flush with the edge.
function settle() {
  place();
  setTimeout(place, 1000);
  setTimeout(place, 4000);
}

function guard() {
  if (!win || win.isDestroyed()) return;
  const want = bounds();
  const got = win.getBounds();
  if (['x', 'y', 'width', 'height'].every((k) => got[k] === want[k])) return;
  const note = JSON.stringify([got, want]);
  if (note === guard.last) return place(); // log each kind of move once
  guard.last = note;
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'place.log'),
      `${new Date().toISOString()} moved back from ${JSON.stringify(got)} to ${JSON.stringify(want)} (${size})\n`);
  } catch {}
  place();
}

// 'toolbar' is a Windows tool window, which never gets a taskbar button; macOS has no such type
const TOOL = MAC ? {} : { type: 'toolbar' };
// macOS: stay on every Space and over full-screen apps, as a topmost window does on Windows
function everySpace(w) {
  if (MAC) w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
}
// with no Dock icon, showing a window doesn't bring the app forward by itself
function comeForward() {
  if (MAC) app.focus({ steal: true });
}

function createWindow() {
  win = new BrowserWindow({
    width: SIZES.tab[0], height: SIZES.tab[1], frame: false, transparent: true, resizable: false, movable: false,
    // 'toolbar' makes it a Windows tool window, which never gets a taskbar button.
    // skipTaskbar alone only removes the button once, and Windows brings it back
    // (blank icon, flashing whenever focus() is refused).
    ...TOOL, skipTaskbar: true, alwaysOnTop: true, hasShadow: false, show: false, backgroundColor: '#00000000',
    icon: path.join(ASSETS, 'app-256.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  everySpace(win);
  win.setIgnoreMouseEvents(true, { forward: true });
  place();
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.once('ready-to-show', () => win.showInactive());
  win.on('blur', () => win.webContents.send('collapse'));
  for (const ev of ['display-metrics-changed', 'display-added', 'display-removed']) screen.on(ev, settle);
  for (const ev of ['resume', 'unlock-screen']) powerMonitor.on(ev, settle);
  setInterval(guard, 3000);
}

function state() {
  const panes = monitor.view().filter((p) => cfg.showShells || p.state !== 'shell');
  return {
    panes,
    hosts: Object.values(hosts).map((h) => ({ name: h.cfg.name, ok: h.ok, error: h.error })),
    showShells: !!cfg.showShells,
    muted,
    messages,
    asks,
    voice: voiceView(),
    shot: shotView(),
  };
}

function push() {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    const s = JSON.stringify(state());
    if (s !== lastState && win && !win.isDestroyed()) win.webContents.send('state', JSON.parse(s));
    lastState = s;
    if (tray) {
      const n = monitor.view().filter((p) => p.unseen).length;
      tray.setToolTip(n ? `openone · ${n} waiting` : 'openone');
    }
  }, 30);
}

// the tty of the Mac terminal tab showing a local session, or ''
async function paneTty(h, session, ttys) {
  return MAC && h && h.cfg.type === 'tmux' ? h.src.clientTty(session, ttys).catch(() => '') : '';
}

// Skip the toast for the pane you're already looking at.
async function isWatching(p) {
  if (!p.active) return false;
  const fg = await wt.request({ op: 'fg' }, 1500);
  const h = hosts[p.host];
  const tty = fg.tty && await paneTty(h, p.session);
  if (tty) return !!(fg.ok && fg.wt && fg.tty === tty);
  return !!(fg.ok && fg.wt && fg.tab && h && (fg.label === h.cfg.name || new RegExp(tabPattern(h.cfg), 'i').test(fg.tab)));
}

// A turn a service started (plastic's RAM page sending its listener an update) ends without
// a ping: its answer goes back to that service, not to you. You still hear when it needs you.
const SERVICE_TURN = 15 * 60e3;
const touched = new Map(); // key -> when you last opened, answered or replied to it
function serviceTurn(key) {
  const m = messages.filter((x) => x.toKey === key && x.status === 'delivered').pop();
  return !!m && !m.fromKey && !m.note && /^outside@/.test(m.from || '')
    && Date.now() - m.at < SERVICE_TURN && m.at > (touched.get(key) || 0);
}

async function notify(ev) {
  const p = monitor.get(ev.key);
  if (!p || !cfg.notify[ev.type] || muted) return;
  if (ev.type === 'done' && serviceTurn(ev.key)) { p.unseen = false; push(); return; }
  if (await isWatching(p)) { monitor.markSeen(ev.key); push(); return; }
  win.webContents.send('peek', { key: ev.key, type: ev.type });
  if (!cfg.notify.toast || !Notification.isSupported()) return;
  const who = `${p.kind || 'agent'} · ${p.label}`;
  const n = new Notification(ev.type === 'input'
    ? { title: `${who} needs you`, body: p.question || 'Waiting for your answer', silent: !cfg.notify.sound, icon: toastIcon() }
    : { title: `${who} finished`, body: (p.summary || p.title || 'Idle').slice(0, 180), silent: !cfg.notify.sound, icon: toastIcon() });
  n.on('click', () => jump(ev.key));
  n.show();
}

async function pollHost(h) {
  while (h.running) {
    try {
      const raws = await h.src.snapshot();
      h.ok = true;
      h.error = '';
      for (const ev of monitor.ingest(h.cfg.name, raws)) {
        notify(ev);
        if (ev.type === 'done' && shotAnswers.has(ev.key)) fileAnswer(h, ev.key);
      }
      push();
      publish(h, raws);
      await sleep(h.cfg.pollMs || 1500);
    } catch (e) {
      h.ok = false;
      h.error = String(e.message || e).split('\n')[0];
      monitor.ingest(h.cfg.name, []);
      push();
      await sleep(Math.max(5000, h.cfg.pollMs || 1500));
    }
  }
}

// "publish": { "url": "https://server", "hosts": ["this-pc"] } sends this machine's pane
// snapshots to an openone server whose config marks the host "feed": true, so the server
// doesn't read the same panes again (each psmux read can flash the terminal). Sends on
// change, or every 8s as a heartbeat; one request at a time.
function publish(h, raws) {
  const pub = cfg.publish;
  if (!pub || !pub.url || !(pub.hosts || []).includes(h.cfg.name) || h.publishing) return;
  const body = JSON.stringify({ panes: raws });
  if (body === h.published && Date.now() - (h.publishedAt || 0) < 8000) return;
  h.publishing = true;
  fetch(`${pub.url.replace(/\/$/, '')}/api/hosts/${encodeURIComponent(h.cfg.name)}/snapshot`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(5000),
  }).then((r) => { if (r.ok) { h.published = body; h.publishedAt = Date.now(); } })
    .catch(() => {})
    .finally(() => { h.publishing = false; });
}

function startHosts() {
  for (const h of Object.values(hosts)) { h.running = false; if (h.src.close) h.src.close(); }
  hosts = {};
  monitor = new Monitor({ hostNames: [require('os').hostname(), ...cfg.hosts.map((h) => h.name)] });
  for (const hc of cfg.hosts) {
    const h = { cfg: hc, src: createSource({ ownClient: MAC && hc.type === 'ssh', ...hc }), ok: false, error: 'connecting', running: true };
    hosts[hc.name] = h;
    pollHost(h);
  }
}

function lookup(key) {
  const p = monitor.get(key);
  const h = p && hosts[p.host];
  return p && h ? { p, h } : null;
}

async function jump(key) {
  const r = lookup(key);
  if (!r) return;
  lastTouched = key;
  monitor.markSeen(key);
  tellServer(key);
  push();
  win.webContents.send('collapse');
  const pane = r.p.bg ? await r.h.src.attachBackground(r.p.bg).catch(() => null) : r.p;
  await showPane(r.h, pane);
}

// a host's tab, by title (a regex), or the tab openTab titled with its name; with neither
// found, only its position (wtTabIndex) finds it
const reEscape = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const tabPattern = (hc) => [hc.wtTab, `^${reEscape(hc.name)}$`].filter(Boolean).join('|');

// Points the host's terminal at the pane and brings its Windows Terminal tab forward (by
// name, or by position when the tab row is hidden, see wt-focus.ps1). When no terminal is
// attached to the host, or its tab can't be found, opens a new tab attached to the pane's
// session instead, so nothing has to be opened and attached by hand first.
async function showPane(h, pane) {
  const ttys = MAC && h.cfg.type === 'tmux' ? await wt.ttys() : h.src.cfg.ownClient ? await h.src.ownTtys().catch(() => null) : null;
  const attached = pane ? await h.src.focus(pane, ttys).catch(() => true) : true;
  if (attached) {
    const res = await wt.focus(tabPattern(h.cfg), h.cfg.wtTabIndex, pane ? await paneTty(h, pane.session, ttys) : '', h.cfg.name);
    if (res.ok) return;
    if (!pane) {
      // the panel has already closed, so its own toast would go unseen
      note(`Couldn't find the ${h.cfg.name} tab in Windows Terminal`, `${res.error || ''}. Set "wtTab" or "wtTabIndex" for ${h.cfg.name} in the config.`);
      return;
    }
  }
  openTab(h, pane.session);
}

// A new Windows Terminal tab (in the most recent window, or a new window) attached to a
// session, titled with the host's name and kept so, so tabPattern finds it next time.
function openTab(h, session) {
  const argv = h.src.attachArgv && h.src.attachArgv(session);
  if (argv && MAC) {
    wt.open(argv, h.cfg.name).then((r) => { if (!r.ok) note(`Couldn't open a terminal for ${h.cfg.name}`, r.error); });
    return;
  }
  if (!argv || process.platform !== 'win32') { note(`No terminal is showing ${h.cfg.name}`, `Attach to session ${session} to see it.`); return; }
  const child = spawn('wt.exe', ['-w', '0', 'new-tab', '--title', h.cfg.name, '--suppressApplicationTitle', '--', ...argv],
    { detached: true, stdio: 'ignore' });
  child.on('error', (e) => note(`Couldn't open Windows Terminal for ${h.cfg.name}`, String(e.message || e)));
  child.unref();
}

// ---------- projects ----------

let embedder = null;
let lastProjects = [];

async function listProjects() {
  lastProjects = await Promise.all(Object.values(hosts).map((h) => projects.list(h)
    .catch((e) => ({ host: h.cfg.name, error: String(e.message || e).split('\n')[0], dirs: [] }))));
  // index the READMEs now, so the first search by meaning is instant
  if (cfg.semantic !== false) {
    if (!embedder) embedder = new Embedder(app.getPath('userData'));
    embedder.warm(lastProjects.flatMap((h) => h.dirs.map((d) => ({ text: projectText(d.name, d.about) }))));
  }
  return lastProjects;
}

async function searchProjects(query) {
  if (cfg.semantic === false) return { projects: {}, agents: {}, ready: false };
  if (!embedder) embedder = new Embedder(app.getPath('userData'));
  return semantic(embedder, query, lastProjects, monitor.view())
    .catch((e) => ({ projects: {}, agents: {}, ready: false, error: String(e.message || e) }));
}

async function startProject(opts) {
  const h = hosts[opts && opts.host];
  if (!h) throw new Error('no such host');
  const pane = await projects.start(h, cfg, opts);
  win.webContents.send('collapse');
  await showPane(h, pane);
  return `${h.cfg.name}|${pane.session}|${pane.paneId}`;
}

// { key } opens a pane's folder, { host, folder } a project's, { host, dir } a folder by path
// (an agent's, from the server); remote hosts over Remote-SSH. Resolves once `code` has
// handed it to VS Code, or throws why not.
async function openInCode(target) {
  let h;
  let dir;
  if (target && target.key) {
    const r = lookup(target.key);
    if (!r) throw new Error('no such pane');
    h = r.h;
    dir = r.p.path;
  } else {
    h = hosts[target && target.host];
    if (!h) throw new Error(`no host "${target && target.host}" in this computer's openone config`);
    dir = target.dir || h.src.join(await h.src.resolve(projects.workspace(h.cfg)), projects.checkName(target.folder));
  }
  if (!dir || /["\r\n%]/.test(dir)) throw new Error('no folder to open');
  const args = projects.vscodeArgs(h.cfg, dir).map((a) => `"${a}"`);
  // `code` is a .cmd, so it needs a shell; the folder was checked for quotes above
  const child = spawn(`${cfg.vscode || 'code'} ${args.join(' ')}`, { shell: true, detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  win.webContents.send('collapse');
  // the CLI exits once VS Code has it; a missing `code` fails fast. Slow: assume it's on its way.
  const code = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(0), 10000);
    child.on('error', () => { clearTimeout(t); resolve(-1); });
    child.on('exit', (c) => { clearTimeout(t); resolve(c || 0); });
  });
  if (code) throw new Error(`${cfg.vscode || 'code'} exited with ${code} (is the VS Code CLI on PATH?)`);
}

// ---------- the code tool: an agent asks the server to open a project here ----------
async function pollOpens() {
  for (;;) {
    try {
      const idle = powerMonitor.getSystemIdleTime() * 1000;
      const r = await fetch(`${serverUrl()}/api/open?for=${encodeURIComponent(dropName())}&idle=${idle}&wait=25`, { signal: AbortSignal.timeout(40000) });
      if (!r.ok) { await sleep(5000); continue; }
      for (const it of await r.json()) {
        let report = { ok: true };
        try { await openInCode(it.target); } catch (e) { report = { ok: false, error: String(e.message || e) }; }
        vlog(`open in code for ${it.from || 'an agent'}: ${it.target.folder || it.target.dir} (${it.target.host}) ${report.ok ? 'ok' : report.error}`);
        await fetch(`${serverUrl()}/api/open/${encodeURIComponent(it.id)}`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(report),
        }).catch(() => {});
      }
    } catch { await sleep(5000); }
  }
}

async function answer(key, n) {
  const r = lookup(key);
  if (!r) return;
  await actions.answer(r.h.src, r.p, n);
  lastTouched = key;
  monitor.markSeen(key);
  tellServer(key);
  push();
}

async function reply(key, text) {
  const r = lookup(key);
  if (!r || !text.trim()) return;
  await actions.reply(r.h.src, r.p, text);
  lastTouched = key;
  monitor.markSeen(key);
  tellServer(key);
  push();
}

function trayIcon() {
  // a template image: macOS colors it to suit the menu bar
  const tone = MAC ? 'black' : shade();
  const img = nativeImage.createFromPath(path.join(ASSETS, `tray-${tone}-16.png`));
  const hi = nativeImage.createFromPath(path.join(ASSETS, `tray-${tone}-32.png`));
  img.addRepresentation({ scaleFactor: 2, width: 32, height: 32, buffer: hi.toPNG() });
  if (MAC) img.setTemplateImage(true);
  return img;
}

function menuTemplate() {
  return [
    { label: cfg.hotkey ? `Open panel  (${cfg.hotkey.replace('Control', 'Ctrl')})` : 'Open panel', click: toggle },
    { type: 'separator' },
    ...(cfg.server ? [
      { label: `Whiteboard${keyLabel(boardKey())}`, click: () => toggleBoard() },
      { label: `Draw on screen${keyLabel(overlayKey())}`, click: () => toggleOverlay() },
      { label: 'Send clipboard to phone', click: () => sendClipboard().catch((e) => note("Couldn't send", e.message)) },
      { type: 'separator' },
    ] : []),
    ...(plasticCfg() ? [{ label: 'plastic', click: () => openPlastic().catch((e) => note("Couldn't open plastic", e.message)) }, { type: 'separator' }] : []),
    { label: 'Settings (push-to-talk)', click: () => openSettings() },
    { label: 'Show shells too', type: 'checkbox', checked: !!cfg.showShells, click: () => { cfg.showShells = !cfg.showShells; push(); } },
    { label: 'Mute notifications', type: 'checkbox', checked: muted, click: () => { muted = !muted; push(); } },
    { label: 'Reload config', click: () => { loadConfig(); place(); startHosts(); } },
    { label: 'Open config', click: () => shell.openPath(CONFIG) },
    {
      label: 'Start at login', type: 'checkbox', checked: app.getLoginItemSettings(loginItem()).openAtLogin,
      click: (item) => app.setLoginItemSettings({ ...loginItem(), openAtLogin: item.checked }),
    },
    { type: 'separator' },
    { label: 'Restart openone', click: () => restartFromTray() },
    { label: 'Quit openone', click: () => app.quit() },
  ];
}

// electron.exe + this folder, so login launch works without a packaged build
function loginItem() {
  return app.isPackaged ? {} : { path: process.execPath, args: [path.resolve(__dirname, '..')] };
}

function openSettings() {
  if (size !== 'full') { size = 'full'; place(); }
  comeForward();
  win.show();
  win.focus();
  win.webContents.focus();
  win.webContents.send('expand', 'settings');
}

function toggle() {
  if (size !== 'full') { size = 'full'; place(); }
  if (win.isFocused()) { win.webContents.send('collapse'); win.blur(); return; }
  comeForward();
  win.show();
  win.focus();
  win.webContents.focus();
  win.flashFrame(false);
  win.webContents.send('expand');
}

// Chromium treats a mostly-transparent topmost window as occluded and stops painting it,
// freezing transitions half-way (ghost rail) and dropping frames (flicker).
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

// "Restart openone" (desktop shortcut, tray): openone.exe --restart asks the server to
// restart, ends every running copy of the app, and starts a fresh one. Works when the
// running copy is stuck, since nothing here goes through it.
async function restartAll() {
  let server = '';
  try { server = String(JSON.parse(fs.readFileSync(CONFIG, 'utf8')).server || '').replace(/\/$/, ''); } catch {}
  if (server) {
    try { await fetch(`${server}/api/restart`, { method: 'POST', signal: AbortSignal.timeout(5000) }); } catch {}
  }
  // packaged only: in dev the exe is electron.exe, shared with other apps
  if (process.platform === 'win32' && app.isPackaged) {
    const exe = path.basename(process.execPath).replace(/'/g, "''");
    try {
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='${exe}'" | Where-Object { $_.ProcessId -ne ${process.pid} -and $_.ParentProcessId -ne ${process.pid} } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`],
      { timeout: 20000, windowsHide: true });
    } catch {}
  }
  if (MAC && app.isPackaged) {
    try {
      const pids = execFileSync('pgrep', ['-x', path.basename(process.execPath)], { encoding: 'utf8', timeout: 5000 }).split('\n').map(Number);
      for (const pid of pids) if (pid && pid !== process.pid) try { process.kill(pid, 'SIGKILL'); } catch {}
    } catch {}
  }
  await sleep(1500);
  const args = app.isPackaged ? [] : [path.join(__dirname, '..')];
  spawn(process.execPath, args, { detached: true, stdio: 'ignore' }).unref();
  app.exit(0);
}

const RESTARTING = process.argv.includes('--restart');
if (RESTARTING) {
  restartAll();
} else if (!app.requestSingleInstanceLock()) app.quit();
// Explorer's "Send to > openone (phone)" starts openone.exe --send-to-phone <files>; when
// it's already running, that arrives here
app.on('second-instance', (_e, argv) => sendFilesFromArgs(argv));

app.whenReady().then(() => {
  if (RESTARTING) return;
  app.setAppUserModelId('com.csaben.openone');
  if (MAC) app.dock.hide();
  loadConfig();
  createWindow();
  wt.start();
  startHosts();
  voiceIpc();
  applyVoice();
  startVoiceIn();
  tray = new Tray(trayIcon());
  tray.setToolTip('openone');
  tray.on('click', toggle);
  nativeTheme.on('updated', () => tray.setImage(trayIcon()));
  // macOS opens a set context menu on every click, so "click" would never fire
  if (MAC) tray.on('right-click', () => tray.popUpContextMenu(Menu.buildFromTemplate(menuTemplate())));
  else {
    tray.setContextMenu(Menu.buildFromTemplate(menuTemplate()));
    tray.on('right-click', () => tray.setContextMenu(Menu.buildFromTemplate(menuTemplate())));
  }
  if (cfg.hotkey) {
    let ok = false;
    try { ok = globalShortcut.register(cfg.hotkey, toggle); } catch {}
    if (!ok) {
      new Notification({ title: 'openone hotkey not set', body: `${cfg.hotkey} is taken by another app or not a valid key. Change "hotkey" in the config.`, icon: toastIcon() }).show();
    }
  }
  if (process.env.OO_EXPAND) setTimeout(toggle, 4000);
  if (firstRun) welcome();
  // An installed copy starts at login by default, once. Turning it off in the tray sticks.
  const loginMarker = path.join(app.getPath('userData'), '.login-default');
  if (app.isPackaged && !fs.existsSync(loginMarker)) {
    app.setLoginItemSettings({ openAtLogin: true });
    fs.writeFileSync(loginMarker, '');
  }

  ipcMain.on('ui:size', (_e, s) => { if (SIZES[s] && s !== size) { size = s; place(); } });
  ipcMain.on('ui:ignore', (_e, ignore) => win.setIgnoreMouseEvents(!!ignore, { forward: true }));
  ipcMain.on('ui:focus', () => { comeForward(); win.focus(); win.webContents.focus(); win.flashFrame(false); });
  ipcMain.on('ui:menu', () => Menu.buildFromTemplate(menuTemplate()).popup({ window: win }));
  ipcMain.on('ui:ready', () => { lastState = ''; push(); });
  ipcMain.on('ui:mute', () => { muted = !muted; push(); });
  ipcMain.handle('pane:jump', (_e, key) => jump(key));
  ipcMain.handle('pane:answer', (_e, key, n) => answer(key, n));
  ipcMain.handle('pane:reply', (_e, key, text) => reply(key, text));
  ipcMain.handle('project:list', () => listProjects());
  ipcMain.handle('project:semantic', (_e, q) => searchProjects(String(q || '')));
  ipcMain.handle('project:start', (_e, opts) => startProject(opts));
  ipcMain.handle('project:code', (_e, target) => openInCode(target));
  ipcMain.handle('ask:answer', async (_e, id, option) => {
    const r = await fetch(`${serverUrl()}/api/asks/${encodeURIComponent(id)}/answer`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ option, by: 'desk' }), signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    asks = asks.filter((a) => a.id !== id);
    push();
  });
  // withdrawn without an answer: the agent isn't told (a stale question)
  ipcMain.handle('ask:dismiss', async (_e, id) => {
    const r = await fetch(`${serverUrl()}/api/asks/${encodeURIComponent(id)}`, { method: 'DELETE', signal: AbortSignal.timeout(8000) });
    if (!r.ok && r.status !== 404) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    asks = asks.filter((a) => a.id !== id);
    push();
  });
  ipcMain.on('pane:seen', (_e, key) => { monitor.markSeen(key); push(); tellServer(key); });
  if (cfg.server) {
    for (const [key, fn] of [[boardKey(), toggleBoard], [overlayKey(), toggleOverlay]]) {
      if (!key) continue;
      let ok = false;
      try { ok = globalShortcut.register(key, fn); } catch {}
      if (!ok) note(`openone: ${key} is taken`, 'Another app has that shortcut. Change "boardHotkey" / "overlayHotkey" in the config.');
    }
  }
  restartShortcut();
  keepPlastic();
  if (cfg.server) { pollMessages(); pollDrops(); pollSpeech(); pollOpens(); sendToShortcut(); sendFilesFromArgs(process.argv); }
});

// "server": "https://..." — the openone server that carries messages between agents.
// The dock shows them on each agent's row, and tells the server when you use an agent
// (which restarts that agent's reply chain count).
const serverUrl = () => String(cfg.server || '').replace(/\/$/, '');
async function pollMessages() {
  for (;;) {
    try {
      const r = await fetch(`${serverUrl()}/api/bus/messages?n=40`, { signal: AbortSignal.timeout(8000) });
      if (r.ok) { const m = await r.json(); if (JSON.stringify(m) !== JSON.stringify(messages)) { messages = m; push(); } }
      // an agent drew on the whiteboard and no board is open anywhere: open it, so it draws
      const bm = await fetch(`${serverUrl()}/api/board/meta`, { signal: AbortSignal.timeout(8000) }).then((x) => x.json()).catch(() => null);
      if (bm && bm.ops > 0 && bm.viewers === 0 && (!boardWin || boardWin.isDestroyed())) openBoard(true);
      const q = await fetch(`${serverUrl()}/api/asks`, { signal: AbortSignal.timeout(8000) });
      if (q.ok) { const a = await q.json(); if (JSON.stringify(a) !== JSON.stringify(asks)) { asks = a; push(); } }
    } catch {}
    await new Promise((r) => setTimeout(r, 4000));
  }
}
function tellServer(key) {
  if (key) touched.set(key, Date.now());
  if (!cfg.server || !key) return;
  fetch(`${serverUrl()}/api/panes/${encodeURIComponent(key)}/seen`, { method: 'POST', signal: AbortSignal.timeout(8000) }).catch(() => {});
}

// ---------- the whiteboard: the server's /board page in its own window ----------

let boardWin = null;
// quiet: an agent drew and nobody had it open; show it without taking the keyboard
// hotkeys: "boardHotkey" / "overlayHotkey" in the config ("" turns one off)
const boardKey = () => (cfg.boardHotkey ?? 'Control+Shift+B');
const overlayKey = () => (cfg.overlayHotkey ?? 'Control+Shift+D');
const keyLabel = (k) => (k ? `  (${k.replace('Control', 'Ctrl')})` : '');

// the hotkey: show it, or hide it when it's what you're looking at
function toggleBoard() {
  if (boardWin && !boardWin.isDestroyed() && boardWin.isVisible() && boardWin.isFocused()) { boardWin.hide(); return; }
  openBoard();
}

function boardPrefs() {
  return { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'board-preload.js') };
}

function openBoard(quiet = false) {
  if (!cfg.server) return;
  if (boardWin && !boardWin.isDestroyed()) {
    if (boardWin.isMinimized()) boardWin.restore();
    if (quiet) boardWin.showInactive(); else { comeForward(); boardWin.show(); boardWin.focus(); }
    return;
  }
  const area = display().workArea;
  boardWin = new BrowserWindow({
    width: Math.round(area.width * 0.75), height: Math.round(area.height * 0.8), title: 'openone board', show: false,
    backgroundColor: '#121212', autoHideMenuBar: true, icon: path.join(ASSETS, 'app-256.png'),
    webPreferences: boardPrefs(),
  });
  boardWin.loadURL(`${serverUrl()}/board`);
  boardWin.once('ready-to-show', () => { if (quiet) boardWin.showInactive(); else boardWin.show(); });
  // links on the board open in the browser, not in this window
  boardWin.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  boardWin.on('closed', () => { boardWin = null; });
}

// ---------- saved posts: a spotlight over the screen ----------
//
// "s" in the panel: the server's /saved page (your X bookmarks and likes, src/saved.js) in a
// frameless window in the middle of the screen under the mouse. It goes away when it loses
// focus or the page closes itself (Esc on an empty search). Links open in the browser.
// "savedUrl" in the config points it somewhere else.

let savedWin = null;

function openSaved() {
  const url = cfg.savedUrl || (cfg.server && `${serverUrl()}/saved`);
  if (!url) return;
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const w = Math.round(area.width * 0.78), h = Math.round(area.height * 0.82);
  const bounds = { x: area.x + Math.round((area.width - w) / 2), y: area.y + Math.round((area.height - h) / 2), width: w, height: h };
  if (savedWin && !savedWin.isDestroyed()) { savedWin.setBounds(bounds); comeForward(); savedWin.show(); savedWin.focus(); return; }
  savedWin = new BrowserWindow({
    ...bounds, frame: false, alwaysOnTop: true, skipTaskbar: true, show: false, resizable: true,
    backgroundColor: '#0c0a09', roundedCorners: true, // the page is dark unless you switch it
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'saved-preload.js') },
  });
  savedWin.loadURL(url);
  savedWin.once('ready-to-show', () => { comeForward(); savedWin.show(); savedWin.focus(); });
  savedWin.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  // hidden, not closed, so the next "s" is instant and keeps the last search
  savedWin.on('blur', () => { if (savedWin && !savedWin.webContents.isDevToolsOpened()) savedWin.hide(); });
  savedWin.on('closed', () => { savedWin = null; });
}

ipcMain.handle('saved:open', () => openSaved());

// ---------- plastic ----------
// plastic (D:\Code\plastic: the RAM of a study session, the lab, recap videos) is its own
// server. openone keeps it running (openone starts at login, so plastic comes back after a
// reboot) and "m" in the panel opens it in an app window. Started detached, so restarting
// openone doesn't end a session; its output goes to plastic.log in openone's data folder.
//   "plastic": { "dir": "D:/Code/plastic", "page": "/v2" }, or false to leave it alone
// (plasticRam, the shot code's setting, is where it listens: default http://127.0.0.1:8843)
const plasticCfg = () => (cfg.plastic === false ? null : { dir: 'D:/Code/plastic', page: '/v2', ...(cfg.plastic || {}) });
let plasticStarted = 0;
let plasticWin = null;

function plasticUp() {
  return new Promise((resolve) => {
    const u = new URL(plasticUrl());
    const sock = require('net').connect(Number(u.port) || 80, u.hostname);
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(1500, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

// -> true once it's listening
async function ensurePlastic() {
  const pc = plasticCfg();
  if (!pc) return false;
  if (await plasticUp()) return true;
  const server = path.join(pc.dir, 'ram', 'server.js');
  if (!fs.existsSync(server)) return false;
  // one start a minute: a server that dies at once shouldn't be restarted in a loop
  if (Date.now() - plasticStarted > 60000) {
    plasticStarted = Date.now();
    const log = fs.openSync(path.join(app.getPath('userData'), 'plastic.log'), 'a');
    const child = spawn('node', [server], { cwd: path.dirname(server), detached: true, windowsHide: true, stdio: ['ignore', log, log] });
    child.on('error', (e) => note("Couldn't start plastic", String(e.message || e)));
    child.unref();
    fs.closeSync(log);
  }
  for (let i = 0; i < 20; i++) { await sleep(500); if (await plasticUp()) return true; }
  return false;
}

function keepPlastic() {
  if (!plasticCfg()) return;
  ensurePlastic().catch(() => {});
  setInterval(() => ensurePlastic().catch(() => {}), 60000);
}

async function openPlastic() {
  if (plasticWin && !plasticWin.isDestroyed()) { comeForward(); plasticWin.show(); plasticWin.focus(); return; }
  if (!(await ensurePlastic())) throw new Error(`plastic isn't running and couldn't be started (see plastic.log in ${app.getPath('userData')})`);
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const w = Math.round(area.width * 0.8), h = Math.round(area.height * 0.85);
  plasticWin = new BrowserWindow({
    x: area.x + Math.round((area.width - w) / 2), y: area.y + Math.round((area.height - h) / 2), width: w, height: h,
    title: 'plastic', autoHideMenuBar: true, show: false, icon: toastIcon(),
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  const base = plasticUrl();
  plasticWin.loadURL(`${base}${plasticCfg().page || '/'}`);
  plasticWin.once('ready-to-show', () => { comeForward(); plasticWin.show(); plasticWin.focus(); });
  // plastic's own pages (the lab, a recap video) open in another app window; the web, in the browser
  plasticWin.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(base)) return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, icon: toastIcon() } };
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  plasticWin.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(base)) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } });
  plasticWin.on('closed', () => { plasticWin = null; });
}

ipcMain.handle('plastic:open', () => openPlastic().catch((e) => note("Couldn't open plastic", e.message)));

// "Sync" on /saved: your newest n bookmarks and likes from x.com (src/xsync.js), handed to the
// server like the browser relay does. One sync at a time; a second press joins the first.
let syncing = null;
ipcMain.handle('saved:sync', (_e, n) => syncing || (syncing = (async () => {
  const xsync = require('./xsync');
  n = Math.max(1, Math.min(Number(n) || 30, 500));
  const out = {};
  for (const kind of ['bookmark', 'like']) {
    const tweets = await xsync.collect(kind, n);
    const r = await fetch(`${serverUrl()}/api/saved/ingest`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tweets, kind, front: true }),
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) throw new Error(`server answered ${r.status}`);
    out[kind] = { ...(await r.json()), seen: tweets.length };
  }
  return out;
})().catch((e) => ({ error: e.message })).finally(() => { syncing = null; })));

// Your X API credit balance, for the same page: eager-friend holds the X sign-in, so its
// "credits" script asks (GET /2/usage/credits). "eagerFriend" in the config is its folder.
let credits = null; // { at, value }
ipcMain.handle('saved:credits', async () => {
  if (credits && Date.now() - credits.at < 10 * 60e3) return credits.value;
  const dir = cfg.eagerFriend || 'D:/Code/eager-friend';
  const value = await new Promise((resolve) => {
    const p = spawn('npx tsx src/bin/credits.ts', { cwd: dir, shell: true, windowsHide: true });
    let out = '';
    p.stdout.on('data', (c) => { out += c; });
    p.on('error', (e) => resolve({ error: e.message }));
    p.on('close', () => { try { resolve(JSON.parse(out.trim().split('\n').pop())); } catch { resolve({ error: 'eager-friend gave no balance' }); } });
  });
  if (!value.error) credits = { at: Date.now(), value };
  return value;
});

// ---------- learning: "p" in the panel ----------
//
// One long-lived coach agent in a folder of its own ("learn" in the config: { host, folder,
// agent }; by default the first host, folder "plastic", claude). "p" takes a picture of the
// screen under the mouse and asks what you're working on; what you type goes to the coach
// with the picture. Its own CLAUDE.md says how to coach (out loud, on the board, by opening the
// problem in your browser). Not running: it's started with --continue, so it remembers.

const learnCfg = () => ({ host: Object.keys(hosts)[0], folder: 'plastic', agent: 'claude', ...(cfg.learn || {}) });
const SHOTS = path.join(app.getPath('temp'), 'openone-learn');

// the screen you were looking at, as a PNG the coach can read; the last 20 are kept
async function learnShot() {
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(d.bounds.width * d.scaleFactor), height: Math.round(d.bounds.height * d.scaleFactor) } });
  const src = sources.find((x) => x.display_id === String(d.id)) || sources[0];
  if (!src) return null;
  fs.mkdirSync(SHOTS, { recursive: true });
  const file = path.join(SHOTS, `${Date.now()}.png`);
  fs.writeFileSync(file, src.thumbnail.toPNG());
  for (const old of fs.readdirSync(SHOTS).sort().slice(0, -20)) fs.rmSync(path.join(SHOTS, old), { force: true });
  return file;
}

async function learn({ text, shot }) {
  const L = learnCfg();
  const h = hosts[L.host];
  if (!h) throw new Error(`no host "${L.host}" for the coach`);
  if (!String(text || '').trim()) return;
  // a picture on this machine only helps a coach on this machine
  const local = !/^ssh/.test(h.cfg.type || '');
  const msg = `[learn, from the hotkey] ${String(text).trim()}${shot && local ? `\n(their screen when they asked: ${shot})` : ''}`;
  const base = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';
  const coach = monitor.view().find((p) => p.host === L.host && p.state !== 'shell' && base(p.path).toLowerCase() === L.folder.toLowerCase());
  if (coach) { const r = lookup(coach.key); if (r) return actions.reply(r.h.src, r.p, msg); }
  await projects.start(h, cfg, { folder: L.folder, agent: L.agent, resume: true, prompt: msg });
}

ipcMain.handle('learn:shot', () => learnShot().catch(() => null));
ipcMain.handle('learn:send', (_e, m) => learn(m || {}));

// ---------- your screen to an agent: "v" in the panel ----------
//
// "v" takes a picture of the screen under the mouse (the panel hides for it) and sends it to
// an agent with what you type, for a second pair of eyes. "shot" in the config:
//   target  'recent' (the agent you last messaged, answered or jumped to) or a pane key,
//           with targetLabel/targetHost to find it again after it restarts
//   ask     true: "v" opens a list of agents, the target picked; false: it sends at once
//   plastic true: during a plastic session the picture also goes into its RAM (plasticRam in
//           the config, default http://127.0.0.1:8843), whoever it was sent to
// Agents on an ssh host get a copy of the picture there, in /tmp/openone-shots.

let lastTouched = ''; // the agent you last messaged, answered or jumped to
const scfg = () => ({ target: 'recent', ask: true, plastic: true, ...(cfg.shot || {}) });

function recentAgent() {
  const agents = monitor.view().filter((p) => p.kind);
  return agents.find((p) => p.key === lastTouched) || agents.sort((a, b) => (b.used || 0) - (a.used || 0))[0] || null;
}

function shotTarget(s = scfg()) {
  if (!s.target || s.target === 'recent') return recentAgent();
  const agents = monitor.view().filter((p) => p.kind);
  return agents.find((p) => p.key === s.target) || agents.find((p) => p.label === s.targetLabel && p.host === s.targetHost) || null;
}

function shotView() {
  const s = scfg();
  const p = shotTarget(s);
  const recent = !s.target || s.target === 'recent';
  const r = recentAgent();
  return {
    target: recent ? 'recent' : s.target, ask: s.ask !== false, plastic: s.plastic !== false, key: p ? p.key : '', recentKey: r ? r.key : '',
    targetLabel: recent ? `The agent you used last${p ? ` (${p.label})` : ''}` : p ? `${p.label} · ${p.host}` : `${s.targetLabel || s.target} (not running)`,
  };
}

function saveShot(patch) {
  const raw = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  raw.shot = { ...(raw.shot || {}), ...patch };
  fs.writeFileSync(CONFIG, `${JSON.stringify(raw, null, 2)}\n`);
  cfg.shot = raw.shot;
  push();
}

// the screen without the panel on it
async function grabScreen() {
  const shown = win && !win.isDestroyed() && win.isVisible();
  if (shown) { win.setOpacity(0); await sleep(120); }
  try { return await learnShot(); } finally { if (shown) win.setOpacity(1); }
}

// a copy of the picture on an ssh host, where its agent can read it ('' when it can't be done)
function copyShot(h, file) {
  if (h.cfg.type !== 'ssh' || !h.src.sshArgs) return Promise.resolve('');
  const dest = `/tmp/openone-shots/${path.basename(file)}`;
  return new Promise((resolve) => {
    const p = spawn(h.src.ssh, h.src.sshArgs(`mkdir -p /tmp/openone-shots && cat > ${dest}`), { windowsHide: true });
    const t = setTimeout(() => { p.kill(); resolve(''); }, 20000);
    p.on('error', () => { clearTimeout(t); resolve(''); });
    p.on('exit', (code) => { clearTimeout(t); resolve(code === 0 ? dest : ''); });
    fs.createReadStream(file).pipe(p.stdin);
  });
}

// the running plastic session keeps it too (nothing happens when none is running), and then
// the agent's answer: when its turn ends, what it said after the screen goes in next to it
const plasticUrl = () => String(cfg.plasticRam || 'http://127.0.0.1:8843').replace(/\/$/, '');
const shotAnswers = new Map(); // pane key -> { id (the picture in the RAM), at }
function toPlastic(shot, text, to, key) {
  fetch(`${plasticUrl()}/api/shot`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: shot, text, to }), signal: AbortSignal.timeout(8000),
  }).then((r) => r.json()).then((j) => { if (j && j.id) shotAnswers.set(key, { id: j.id, at: Date.now() }); }).catch(() => {});
}
const SHOT_MARK = '[screen, from the hotkey]';
async function fileAnswer(h, key) {
  const w = shotAnswers.get(key);
  const p = monitor.get(key);
  if (!w || !p) return;
  if (Date.now() - w.at > 30 * 60e3) { shotAnswers.delete(key); return; }
  const text = answerAfter(await h.src.screen(p, 400).catch(() => ''), SHOT_MARK);
  if (!text) return; // a turn that ended before it got to the screen: wait for the next one
  shotAnswers.delete(key);
  fetch(`${plasticUrl()}/api/shot/answer`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: w.id, text, from: `${p.label} · ${p.host}` }), signal: AbortSignal.timeout(8000),
  }).catch(() => {});
}

async function sendShot({ key, text, shot }) {
  const r = lookup(key);
  if (!r) throw new Error("that agent isn't running");
  const local = !/^ssh/.test(r.h.cfg.type || '');
  const at = shot ? (local ? shot : await copyShot(r.h, shot)) : '';
  const ask = String(text || '').trim() || "Here's my screen. What do you make of it?";
  if (shot && scfg().plastic !== false) toPlastic(shot, String(text || '').trim(), `${r.p.label} · ${r.p.host}`, key);
  await reply(key, `[screen, from the hotkey] ${ask}${at ? `\n(their screen when they asked: ${at})` : shot ? '\n(a picture of their screen was taken but could not be copied to this host)' : ''}`);
  return r.p.label;
}

// "v" with ask off: straight to the target
async function shotNow() {
  const p = shotTarget();
  if (!p) throw new Error(scfg().target === 'recent' ? 'no agent to send it to yet' : `${scfg().targetLabel || 'that agent'} isn't running`);
  return sendShot({ key: p.key, text: '', shot: await grabScreen() });
}

ipcMain.handle('shot:grab', () => grabScreen().catch(() => null));
ipcMain.handle('shot:send', (_e, m) => sendShot(m || {}));
ipcMain.handle('shot:now', () => shotNow());
ipcMain.handle('shot:set', (_e, patch) => {
  const clean = {};
  for (const k of ['target', 'targetLabel', 'targetHost', 'ask', 'plastic']) if (patch && patch[k] !== undefined) clean[k] = patch[k];
  saveShot(clean);
});

// ---------- drawing on the screen ----------
//
// The hotkey takes a screenshot of the screen under the mouse, then lays the board over
// that screen, transparent, at a fresh spot to the right of everything on it, at 1 board
// unit per screen pixel. You draw on your screen; it's the board. Done pins the
// screenshot underneath your marks, so the board keeps both, lined up. Click-through
// leaves the marks showing while the mouse goes to the apps below; the hotkey brings
// the pen back. "Show on screen" on a pinned screenshot opens the overlay over that
// region instead, with the screenshot itself hidden, so its marks sit on the live screen.
// The window only exists while it's up: a full-screen transparent window costs the apps
// underneath repaints.

let overlay = null; // { win, mode: 'draw' | 'through', shot: nativeImage | null, region }

async function toggleOverlay() {
  if (!cfg.server) return;
  if (!overlay) return openOverlay().catch((e) => note("Couldn't open the overlay", e.message));
  if (overlay.mode === 'through') return overlayMode('draw');
  return finishOverlay('done');
}

async function openOverlay(region = null) {
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  let shot = null;
  if (!region) {
    const sources = await desktopCapturer.getSources({
      types: ['screen'], thumbnailSize: { width: Math.round(d.bounds.width * d.scaleFactor), height: Math.round(d.bounds.height * d.scaleFactor) },
    });
    const src = sources.find((x) => x.display_id === String(d.id)) || sources[0];
    shot = src ? src.thumbnail : null;
    const scene = await (await fetch(`${serverUrl()}/api/board`, { signal: AbortSignal.timeout(8000) })).json();
    const live = (scene.elements || []).filter((e) => !e.isDeleted);
    region = {
      x: live.length ? Math.round(Math.max(...live.map((e) => e.x + (e.width || 0))) + 240) : 0,
      y: live.length ? Math.round(Math.min(...live.map((e) => e.y))) : 0,
    };
  }
  region = { ...region, w: d.bounds.width, h: d.bounds.height };
  const win = new BrowserWindow({
    ...d.bounds, frame: false, transparent: true, backgroundColor: '#00000000', alwaysOnTop: true, skipTaskbar: true,
    ...TOOL, resizable: false, movable: false, hasShadow: false, fullscreenable: false, show: false, webPreferences: boardPrefs(),
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setBounds(d.bounds);
  overlay = { win, mode: 'draw', shot, region };
  const q = new URLSearchParams({ overlay: '1', x: region.x, y: region.y, w: region.w, h: region.h, ...(region.hide ? { hide: region.hide } : {}) });
  win.loadURL(`${serverUrl()}/board?${q}`);
  win.once('ready-to-show', () => { comeForward(); win.show(); win.focus(); });
  win.on('closed', () => { if (overlay && overlay.win === win) overlay = null; });
}

function overlayMode(mode) {
  if (!overlay) return;
  overlay.mode = mode;
  overlay.win.setIgnoreMouseEvents(mode === 'through', { forward: true });
  if (mode === 'draw') { comeForward(); overlay.win.focus(); }
  overlay.win.webContents.send('board:mode', mode);
}

// done: pin the screenshot (if this overlay took one) under the marks; discard: undo them
async function finishOverlay(action) {
  const o = overlay;
  if (!o) return;
  overlay = null;
  try {
    const name = new Date().toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const arg = action === 'discard' ? { discard: true }
      : { name: `Screen · ${name}`, shot: o.shot ? `data:image/jpeg;base64,${o.shot.toJPEG(82).toString('base64')}` : null };
    await o.win.webContents.executeJavaScript(`window.ooOverlayFinish(${JSON.stringify(arg)})`);
  } catch (e) {
    note('The overlay didn’t save', e.message);
  }
  o.win.destroy();
}

ipcMain.handle('board:overlay', (_e, action) => {
  if (action === 'through') overlayMode('through');
  else if (action === 'done' || action === 'discard') finishOverlay(action);
});

ipcMain.handle('board:show-on-screen', (_e, r) => {
  if (!r || ![r.x, r.y].every(Number.isFinite)) return;
  if (overlay) overlay.win.destroy();
  overlay = null;
  if (boardWin && !boardWin.isDestroyed()) boardWin.hide();
  return openOverlay({ x: Math.round(r.x), y: Math.round(r.y), hide: String(r.hide || '').slice(0, 80) });
});

// ---------- drops: links, text and files between the phone and this computer ----------
//
// Whatever the phone shares here: links open in the browser, text goes on the clipboard,
// files land in Downloads. The other way: the tray's "Send clipboard to phone", and
// Explorer's Send to menu for files.

const dropName = () => String(cfg.dropName || require('os').hostname()).toLowerCase();

function note(title, body, click) {
  const n = new Notification({ title, body: String(body || '').slice(0, 200), silent: true, icon: toastIcon() });
  if (click) n.on('click', click);
  n.show();
}

async function pollDrops() {
  for (;;) {
    try {
      const r = await fetch(`${serverUrl()}/api/drops?for=${encodeURIComponent(dropName())}&wait=25`, { signal: AbortSignal.timeout(40000) });
      if (r.ok) for (const d of await r.json()) await receiveDrop(d).catch((e) => note("Couldn't receive", e.message));
      else await sleep(5000);
    } catch { await sleep(5000); }
  }
}

async function receiveDrop(d) {
  const from = d.from === 'phone' ? 'your phone' : d.from;
  if (d.kind === 'text') {
    clipboard.writeText(d.text);
    for (const u of d.links || []) await shell.openExternal(u);
    note(d.links && d.links.length ? `Opened ${d.links.length === 1 ? 'a link' : `${d.links.length} links`} from ${from}` : `Copied text from ${from}`,
      d.links && d.links.length ? d.links.join('\n') : d.text);
  } else {
    const r = await fetch(`${serverUrl()}/api/drops/${encodeURIComponent(d.id)}/file`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const file = freeName(path.join(app.getPath('downloads'), d.name));
    fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    note(`Saved ${path.basename(file)} from ${from}`, 'In Downloads. Click to show it.', () => shell.showItemInFolder(file));
  }
  await fetch(`${serverUrl()}/api/drops/${encodeURIComponent(d.id)}`, { method: 'DELETE' });
}

// "report.pdf" -> "report (2).pdf" when it's taken
function freeName(file) {
  if (!fs.existsSync(file)) return file;
  const ext = path.extname(file);
  const stem = file.slice(0, file.length - ext.length);
  for (let i = 2; ; i++) if (!fs.existsSync(`${stem} (${i})${ext}`)) return `${stem} (${i})${ext}`;
}

async function sendText(text) {
  const r = await fetch(`${serverUrl()}/api/drops`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: 'phone', from: dropName(), text }),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
}

async function sendFile(file, name = path.basename(file), data = null) {
  const body = data || fs.readFileSync(file);
  const r = await fetch(`${serverUrl()}/api/drops/file?to=phone&from=${encodeURIComponent(dropName())}&name=${encodeURIComponent(name)}`, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body,
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
}

// text, or an image (a screenshot), whichever the clipboard has
async function sendClipboard() {
  const img = clipboard.readImage();
  const text = clipboard.readText();
  if (text.trim()) { await sendText(text); note('Sent to your phone', text); return; }
  if (!img.isEmpty()) { await sendFile(null, `clipboard-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`, img.toPNG()); note('Sent the image to your phone', ''); return; }
  note('Nothing to send', 'The clipboard is empty.');
}

async function sendFilesFromArgs(argv) {
  const i = argv.indexOf('--send-to-phone');
  if (i < 0 || !cfg || !cfg.server) return;
  const files = argv.slice(i + 1).filter((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } });
  for (const f of files) {
    try { await sendFile(f); } catch (e) { note(`Couldn't send ${path.basename(f)}`, e.message); return; }
  }
  if (files.length) note(`Sent ${files.length === 1 ? path.basename(files[0]) : `${files.length} files`} to your phone`, '');
}

// "Restart openone" on the desktop: cycles the app and the server when they get slow
function restartShortcut() {
  if (!app.isPackaged || process.platform !== 'win32') return;
  try {
    const link = path.join(app.getPath('desktop'), 'Restart openone.lnk');
    shell.writeShortcutLink(link, fs.existsSync(link) ? 'update' : 'create', {
      target: process.execPath, args: '--restart', description: 'Restart openone (this app and its server)', icon: process.execPath, iconIndex: 0,
    });
  } catch {}
}

function restartFromTray() {
  const args = app.isPackaged ? ['--restart'] : [path.join(__dirname, '..'), '--restart'];
  spawn(process.execPath, args, { detached: true, stdio: 'ignore' }).unref();
}

// Explorer's right-click > Send to > openone (phone)
function sendToShortcut() {
  if (!app.isPackaged || process.platform !== 'win32') return;
  try {
    const link = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'SendTo', 'openone (phone).lnk');
    shell.writeShortcutLink(link, fs.existsSync(link) ? 'update' : 'create', {
      target: process.execPath, args: '--send-to-phone', description: 'Send to your phone with openone', icon: process.execPath, iconIndex: 0,
    });
  } catch {}
}

// ---------- push-to-talk (voice.js) ----------
//
// "voice" in the config: { enabled, trigger, mode: 'hold'|'toggle', target: 'focused' or a
// pane key (+ targetLabel/targetHost to find it again), enter, beep, stt, model }. Set from
// the panel's settings view; the trigger is captured by pressing it.

let recWin = null;
let vState = { state: 'idle', capturing: false, last: null, error: '' }; // state: idle | rec | stt
let vTrigger = null;
let vCapture = null;
let recStarted = 0;
let recLen = 0;
let recTimer = null;

const vcfg = () => ({ enabled: false, trigger: null, mode: 'hold', target: 'focused', enter: false, beep: true, stt: '', model: '', ...(cfg.voice || {}) });

function voiceTarget(v) {
  if (!v.target || v.target === 'focused' || !monitor) return null;
  const view = monitor.view();
  return view.find((p) => p.key === v.target) || view.find((p) => p.kind && p.label === v.targetLabel && p.host === v.targetHost) || null;
}

function voiceView() {
  const v = vcfg();
  const p = voiceTarget(v);
  const focused = !v.target || v.target === 'focused';
  return {
    enabled: !!v.enabled, key: voice.label(v.trigger), hasKey: !!(v.trigger && (v.trigger.button || (v.trigger.keys || []).length)),
    mode: v.mode, target: focused ? 'focused' : v.target, focused,
    targetLabel: focused ? 'The focused window (paste)' : p ? `${p.label} · ${p.host}` : `${v.targetLabel || v.target} (not running)`,
    enter: !!v.enter, beep: v.beep !== false, stt: v.stt || '', speed: voiceSpeed(),
    clips: v.clips !== false, clipRoute: v.clipRoute === 'auto' ? 'auto' : 'fixed', clipTarget: v.clipTarget || '', clipTargetLabel: clipTargetLabel(v),
    state: vState.state, capturing: vState.capturing, last: vState.last, error: vState.error || voice.hookProblem(),
  };
}

// what happened, for when it seems to do nothing: %APPDATA%openoneoice.log
function vlog(msg) {
  try {
    const f = path.join(app.getPath('userData'), 'voice.log');
    if (fs.existsSync(f) && fs.statSync(f).size > 256 * 1024) fs.renameSync(f, `${f}.old`);
    fs.appendFileSync(f, `${new Date().toISOString()} ${msg}
`);
  } catch {}
}

// The indicator at the bottom of the screen the cursor is on: { mode: open|rec|stt|ok|err|hide, title, detail }
let pillWin = null;
let pillTimer = null;
function pill(s) {
  clearTimeout(pillTimer);
  if (s.mode === 'hide') { if (pillWin && !pillWin.isDestroyed()) pillWin.hide(); return; }
  const W = 440;
  const H = 64;
  if (!pillWin || pillWin.isDestroyed()) {
    pillWin = new BrowserWindow({
      width: W, height: H, frame: false, transparent: true, resizable: false, movable: false, focusable: false, skipTaskbar: true,
      alwaysOnTop: true, show: false, hasShadow: false, ...TOOL,
      webPreferences: { preload: path.join(__dirname, 'pill-preload.js'), backgroundThrottling: false },
    });
    pillWin.setIgnoreMouseEvents(true);
    pillWin.setAlwaysOnTop(true, 'screen-saver');
    everySpace(pillWin);
    pillWin.loadFile(path.join(__dirname, 'ui', 'pill.html'));
  }
  const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  pillWin.setBounds({ x: Math.round(wa.x + (wa.width - W) / 2), y: Math.round(wa.y + wa.height - H - 18), width: W, height: H });
  const send = () => { pillWin.webContents.send('pill', s); if (!pillWin.isVisible()) pillWin.showInactive(); };
  if (pillWin.webContents.isLoading()) pillWin.webContents.once('did-finish-load', send); else send();
  if (s.mode === 'ok' || s.mode === 'err') pillTimer = setTimeout(() => pill({ mode: 'hide' }), s.mode === 'ok' ? 3500 : 7000);
}

function recorder() {
  if (recWin && !recWin.isDestroyed()) return recWin;
  recWin = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, 'recorder-preload.js'), backgroundThrottling: false } });
  recWin.loadFile(path.join(__dirname, 'ui', 'recorder.html'));
  return recWin;
}

function onVoiceKey(ev) {
  if (vCapture) {
    const r = vCapture.feed(ev);
    if (!r) return;
    vCapture = null;
    vState.capturing = false;
    vlog(`captured ${JSON.stringify(r)}`);
    if (r.trigger) saveVoice({ trigger: r.trigger, enabled: true });
    else { vState.error = r.error || ''; push(); }
    return;
  }
  if (!vTrigger) return;
  const r = vTrigger.feed(ev);
  if (r) vlog(`${r} (${ev.type} ${ev.type.startsWith('mouse') ? `button ${ev.button}` : `key ${ev.keycode}`})`);
  if (r === 'press') {
    if (vcfg().mode === 'toggle' && vState.state === 'rec') stopRec(); else startRec();
  } else if (r === 'release' && vcfg().mode !== 'toggle') stopRec();
}

function applyVoice() {
  const v = vcfg();
  vTrigger = v.enabled && v.trigger ? new voice.Trigger(v.trigger) : null;
  if (vTrigger || vCapture) {
    const h = voice.globalHook();
    if (h) h.on(onVoiceKey);
    recorder(); // loaded ahead, so the first press records at once
  }
  push();
}

function saveVoice(patch) {
  const raw = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  raw.voice = { ...(raw.voice || {}), ...patch };
  fs.writeFileSync(CONFIG, `${JSON.stringify(raw, null, 2)}\n`);
  cfg.voice = raw.voice;
  vState.error = '';
  applyVoice();
}

function startRec() {
  if (vState.state === 'rec') return;
  stopSpeaking(); // talking over it cuts it off
  const w = recorder();
  vState = { ...vState, state: 'rec', error: '' };
  recStarted = Date.now();
  push();
  pill({ mode: 'open', title: 'Opening the mic…' });
  const go = () => w.webContents.send('rec:start', { beep: vcfg().beep !== false, mic: vcfg().mic || '' });
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', go); else go();
  clearTimeout(recTimer);
  recTimer = setTimeout(stopRec, (vcfg().maxSeconds || 180) * 1000);
}

function stopRec() {
  if (vState.state !== 'rec') return;
  clearTimeout(recTimer);
  recLen = Date.now() - recStarted;
  vState.state = 'stt';
  push();
  vlog(`stop after ${recLen} ms`);
  pill({ mode: 'stt', title: 'Transcribing…' });
  recWin.webContents.send('rec:stop', { beep: vcfg().beep !== false });
}

// paste into whatever has focus, then put the clipboard back
function pasteText(text, enter) {
  const h = voice.globalHook();
  if (!h) throw new Error(`can't type: ${voice.hookProblem()}`);
  const prevText = clipboard.readText();
  const prevImage = prevText ? null : clipboard.readImage();
  clipboard.writeText(text);
  h.paste(enter);
  setTimeout(() => {
    if (clipboard.readText() !== text) return;
    if (prevText) clipboard.writeText(prevText);
    else if (prevImage && !prevImage.isEmpty()) clipboard.writeImage(prevImage);
  }, 1000);
}

async function heard(audio) {
  const v = vcfg();
  vlog(`audio ${audio.length} bytes`);
  if (recLen < 350 || audio.length < 1000) { // a tap, not speech
    vState.state = 'idle';
    push();
    pill({ mode: 'err', title: 'Too short', detail: v.mode === 'toggle' ? 'press once to start, again to stop' : 'hold it while you talk' });
    return;
  }
  try {
    const t0 = Date.now();
    const text = await voice.transcribe({ url: v.stt, model: v.model, audio });
    vlog(`heard in ${Date.now() - t0} ms: ${text}`);
    if (!text) throw new Error("Didn't catch anything");
    const p = voiceTarget(v);
    if (v.target && v.target !== 'focused' && !p) throw new Error(`${v.targetLabel || 'That agent'} isn't running. Heard: ${text}`);
    // agents answer a [voice] message out loud too (see speak in mcp.js)
    if (p) await reply(p.key, `${v.tag ?? '[voice] '}${text}`);
    else pasteText(text, !!v.enter);
    vState = { ...vState, state: 'idle', last: { text, to: p ? p.label : 'focused window', at: Date.now() } };
    vlog(`sent to ${p ? p.key : 'focused window'}`);
    pill({ mode: 'ok', title: `Sent to ${p ? p.label : 'the focused window'}`, detail: text });
  } catch (e) {
    vState = { ...vState, state: 'idle', error: e.message };
    vlog(`error: ${e.message}`);
    pill({ mode: 'err', title: "Push-to-talk didn't work", detail: e.message });
  }
  push();
}

// Clips other programs post (voicein.js; player-one's controller). Transcribed, then:
//   "take me to fastudio"  jumps to that pane, like clicking it (checked first, it's instant)
//   clipRoute "fixed"      typed into one chat: clipTarget (a pane key, or "recent" for the one
//                          you used last), else the push-to-talk agent, else the one you used last
//   clipRoute "auto"       the server's router (jev) picks the agent
// A clip you held the buttons for is always delivered. One an always-listening mic overheard
// only goes on when the router is sure it was for an agent; otherwise it's dropped. Never
// pasted, since you're usually in a game then. "clips": false turns it off, "clipsPort" moves it.
let voiceIn = null;
function startVoiceIn() {
  const v = vcfg();
  if (v.clips === false || voiceIn) return;
  voiceIn = voicein.listen({ port: Number(v.clipsPort) || 8955, log: vlog, onClip: clip });
}

function clipTarget(v = vcfg()) {
  if (!monitor) return null;
  if (v.clipTarget === 'recent') return recentAgent();
  if (v.clipTarget) {
    const agents = monitor.view().filter((p) => p.kind);
    return agents.find((p) => p.key === v.clipTarget) || agents.find((p) => p.label === v.clipTargetLabel && p.host === v.clipTargetHost) || null;
  }
  return voiceTarget(v) || recentAgent();
}

function clipTargetLabel(v = vcfg()) {
  if (v.clipTarget === 'recent') return 'The agent you used last';
  const p = clipTarget(v);
  if (v.clipTarget) return p ? `${p.label} · ${p.host}` : `${v.clipTargetLabel || v.clipTarget} (not running)`;
  return 'Same as push to talk';
}

async function clip({ audio, mime, tag, mode, ms, window }) {
  const v = vcfg();
  const overheard = mode === 'always';
  const auto = v.clipRoute === 'auto';
  vlog(`clip ${mode} ${audio.length} bytes, ${ms} ms, ${tag.trim()}${window ? ` (${window})` : ''}`);
  const sent = (to, text) => {
    vState = { ...vState, last: { text, to, at: Date.now() } };
    pill({ mode: 'ok', title: `Sent to ${to}`, detail: text });
  };
  try {
    const text = await voice.transcribe({ url: v.stt, model: v.model, audio, mime });
    vlog(`clip heard: ${text}`);
    if (!text) { if (overheard) return; throw new Error("Didn't catch anything"); }
    // a jump: "take me to X", or (held) just a name, matched closely
    const q = voicein.navTarget(text);
    const bare = !q && !overheard && voicein.navTarget(text, { bare: true });
    const there = (q && voicein.findPane(q, monitor.view())) || (bare && voicein.findPane(bare, monitor.view(), 2.5));
    if (there) {
      await jump(there.key);
      vlog(`clip: jumped to ${there.key}`);
      pill({ mode: 'ok', title: `Jumped to ${there.label}`, detail: text });
      return;
    }
    const p = clipTarget(v);
    if (!auto && !overheard) {
      if (!p) throw new Error(`${v.clipTargetLabel || 'No agent'} isn't running. Heard: ${text}`);
      await reply(p.key, tag + text);
      vlog(`clip sent to ${p.key}`);
      sent(p.label, text);
      return;
    }
    if (!auto && !p) { vlog('clip dropped: the chosen chat isn\'t running'); return; }
    const r = await fetch(`${serverUrl()}/api/route`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ text, source: 'voice', strict: overheard, to: auto ? '' : p.key, fallback: overheard || !p ? '' : p.key, quiet: true }),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(out.error || `router: HTTP ${r.status}`);
    vlog(`clip routed: ${out.route} ${out.to || ''} (${out.why || ''})`);
    if (out.route !== 'agent') {
      if (overheard) return;
      throw new Error(`No agent to send it to. Heard: ${text}`);
    }
    sent(String(out.to).split('@')[0], text);
  } catch (e) {
    vlog(`clip error: ${e.message}`);
    pill({ mode: 'err', title: "Voice clip didn't send", detail: e.message });
  }
  push();
}

// ---------- agents speaking (speak, speech.js on the server) ----------
const playQueue = [];
let nowPlaying = null;

async function pollSpeech() {
  if (vcfg().speak === false) return;
  for (;;) {
    try {
      // how long you've been away from this computer: the server sends speech to a phone with
      // headphones instead once you've been away a while
      const idle = powerMonitor.getSystemIdleTime() * 1000;
      const r = await fetch(`${serverUrl()}/api/speak?for=${encodeURIComponent(dropName())}&kind=desktop&idle=${idle}&wait=25`, { signal: AbortSignal.timeout(40000) });
      if (r.ok) {
        for (const part of await r.json()) {
          const a = await fetch(`${serverUrl()}/api/speak/${encodeURIComponent(part.id)}/audio`, { signal: AbortSignal.timeout(20000) });
          if (!a.ok) continue;
          playQueue.push({ ...part, audio: await a.arrayBuffer() });
          vlog(`speak ${part.from} ${part.seq + 1}/${part.of}: ${part.text}`);
          playNext();
        }
      } else await sleep(5000);
    } catch { await sleep(5000); }
  }
}

function playNext() {
  if (nowPlaying || !playQueue.length) return;
  if (vState.state === 'rec') { playQueue.length = 0; return; }
  nowPlaying = playQueue.shift();
  const w = recorder();
  const go = () => w.webContents.send('play', { id: nowPlaying.id, audio: nowPlaying.audio, mime: nowPlaying.mime, speed: voiceSpeed() });
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', go); else go();
  pill({ mode: 'speak', title: String(nowPlaying.from || 'openone').replace(/@.*/, ''), detail: nowPlaying.text });
}

function stopSpeaking() {
  playQueue.length = 0;
  if (nowPlaying && recWin && !recWin.isDestroyed()) recWin.webContents.send('play:stop');
}

// how fast agents talk: 1.75x unless set ("speed" in "voice")
const voiceSpeed = () => Math.min(4, Math.max(0.5, Number(vcfg().speed) || 1.75));

const VOICE_KEYS = ['speed', 'enabled', 'mode', 'target', 'targetLabel', 'targetHost', 'enter', 'beep', 'stt', 'model', 'speak', 'clipRoute', 'clipTarget', 'clipTargetLabel', 'clipTargetHost'];

function voiceIpc() {
  ipcMain.on('rec:data', (_e, buf) => heard(Buffer.from(buf)));
  ipcMain.on('rec:error', (_e, msg) => { vState = { ...vState, state: 'idle', error: msg }; vlog(`mic error: ${msg}`); pill({ mode: 'err', title: "Couldn't open the mic", detail: msg }); push(); });
  ipcMain.on('rec:started', () => { vlog(`mic open after ${Date.now() - recStarted} ms`); if (vState.state === 'rec') pill({ mode: 'rec', title: 'Listening', detail: voice.label(vcfg().trigger) }); });
  ipcMain.on('play:done', (_e, id, err) => {
    if (err && err !== 'stopped') vlog(`play error: ${err}`);
    fetch(`${serverUrl()}/api/speak/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
    nowPlaying = null;
    if (playQueue.length) playNext();
    else if (vState.state === 'idle') pillTimer = setTimeout(() => pill({ mode: 'hide' }), 1200);
  });
  ipcMain.on('rec:level', (_e, v) => { if (pillWin && !pillWin.isDestroyed()) pillWin.webContents.send('level', v); });
  ipcMain.handle('voice:set', (_e, patch) => {
    const clean = {};
    for (const k of VOICE_KEYS) if (patch && patch[k] !== undefined) clean[k] = patch[k];
    saveVoice(clean);
  });
  ipcMain.handle('voice:capture', () => {
    if (!voice.globalHook()) throw new Error(`the key listener didn't load: ${voice.hookProblem()}`);
    vCapture = new voice.Capture();
    vState = { ...vState, capturing: true, error: '' };
    applyVoice();
  });
  ipcMain.handle('voice:cancel', () => { vCapture = null; vState.capturing = false; push(); });
}

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  voice.stopHook();
  wt.stop();
  for (const h of Object.values(hosts)) { h.running = false; if (h.src.close) h.src.close(); }
});
app.on('window-all-closed', () => app.quit());
