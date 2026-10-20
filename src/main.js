const { app, BrowserWindow, ipcMain, screen, powerMonitor, globalShortcut, Notification, Tray, Menu, nativeImage, nativeTheme, shell, clipboard, desktopCapturer } = require('electron');
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Monitor } = require('./monitor');
const { createSource } = require('./sources');
const { WindowsTerminal } = require('./wt');
const actions = require('./actions');
const projects = require('./projects');
const { Embedder, semantic, projectText } = require('./embed');
const { detect: detectConfig } = require('./setup');
const voice = require('./voice');

// Installed builds keep config in %APPDATA%\openone; a source checkout uses ./config.json.
const CONFIG = app.isPackaged ? path.join(app.getPath('userData'), 'config.json') : path.join(__dirname, '..', 'config.json');
// assets are unpacked from the asar so Windows (toasts) can read them as plain files
const ASSETS = path.join(__dirname, '..', 'assets').replace('app.asar', 'app.asar.unpacked');
// Taskbar and toasts follow the Windows "system" theme, not the app theme:
// white cloud on a dark shell, black cloud on a light one.
function lightShell() {
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
const wt = new WindowsTerminal();
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

function createWindow() {
  win = new BrowserWindow({
    width: SIZES.tab[0], height: SIZES.tab[1], frame: false, transparent: true, resizable: false, movable: false,
    // 'toolbar' makes it a Windows tool window, which never gets a taskbar button.
    // skipTaskbar alone only removes the button once, and Windows brings it back
    // (blank icon, flashing whenever focus() is refused).
    type: 'toolbar', skipTaskbar: true, alwaysOnTop: true, hasShadow: false, show: false, backgroundColor: '#00000000',
    icon: path.join(ASSETS, 'app-256.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
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

// Skip the toast for the pane you're already looking at.
async function isWatching(p) {
  if (!p.active) return false;
  const fg = await wt.request({ op: 'fg' }, 1500);
  const h = hosts[p.host];
  return !!(fg.ok && fg.wt && fg.tab && h && new RegExp(tabPattern(h.cfg), 'i').test(fg.tab));
}

async function notify(ev) {
  const p = monitor.get(ev.key);
  if (!p || !cfg.notify[ev.type] || muted) return;
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
      for (const ev of monitor.ingest(h.cfg.name, raws)) notify(ev);
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
    const h = { cfg: hc, src: createSource(hc), ok: false, error: 'connecting', running: true };
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
  monitor.markSeen(key);
  tellServer(key);
  push();
  win.webContents.send('collapse');
  const pane = r.p.bg ? await r.h.src.attachBackground(r.p.bg).catch(() => null) : r.p;
  if (pane) await r.h.src.focus(pane).catch(() => {});
  await showHost(r.h);
}

// a host's tab, by title (a regex); with none set, only its position (wtTabIndex) finds it
const tabPattern = (hc) => hc.wtTab || '(?!)';

// Brings the host's Windows Terminal tab forward (by name, or by position when the tab
// row is hidden, see wt-focus.ps1). Says so in a notification when it can't: the panel
// has already closed, so its own toast would go unseen.
async function showHost(h) {
  const res = await wt.focus(tabPattern(h.cfg), h.cfg.wtTabIndex);
  if (!res.ok) note(`Couldn't find the ${h.cfg.name} tab in Windows Terminal`, `${res.error || ''}. Set "wtTab" or "wtTabIndex" for ${h.cfg.name} in the config.`);
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
  await h.src.focus(pane).catch(() => {});
  await showHost(h);
  return `${h.cfg.name}|${pane.session}|${pane.paneId}`;
}

// { key } opens a pane's folder, { host, folder } a project's; remote hosts over Remote-SSH
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
    if (!h) throw new Error('no such host');
    dir = h.src.join(await h.src.resolve(projects.workspace(h.cfg)), projects.checkName(target.folder));
  }
  if (!dir || /["\r\n]/.test(dir)) throw new Error('no folder to open');
  const args = projects.vscodeArgs(h.cfg, dir).map((a) => `"${a}"`);
  // `code` is a .cmd, so it needs a shell; the folder was checked for quotes above
  spawn(`${cfg.vscode || 'code'} ${args.join(' ')}`, { shell: true, detached: true, stdio: 'ignore', windowsHide: true }).unref();
  win.webContents.send('collapse');
}

async function answer(key, n) {
  const r = lookup(key);
  if (!r) return;
  await actions.answer(r.h.src, r.p, n);
  monitor.markSeen(key);
  tellServer(key);
  push();
}

async function reply(key, text) {
  const r = lookup(key);
  if (!r || !text.trim()) return;
  await actions.reply(r.h.src, r.p, text);
  monitor.markSeen(key);
  tellServer(key);
  push();
}

function trayIcon() {
  const img = nativeImage.createFromPath(path.join(ASSETS, `tray-${shade()}-16.png`));
  const hi = nativeImage.createFromPath(path.join(ASSETS, `tray-${shade()}-32.png`));
  img.addRepresentation({ scaleFactor: 2, width: 32, height: 32, buffer: hi.toPNG() });
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
  win.show();
  win.focus();
  win.webContents.focus();
  win.webContents.send('expand', 'settings');
}

function toggle() {
  if (size !== 'full') { size = 'full'; place(); }
  if (win.isFocused()) { win.webContents.send('collapse'); win.blur(); return; }
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
  loadConfig();
  createWindow();
  wt.start();
  startHosts();
  voiceIpc();
  applyVoice();
  tray = new Tray(trayIcon());
  tray.setToolTip('openone');
  tray.on('click', toggle);
  nativeTheme.on('updated', () => tray.setImage(trayIcon()));
  tray.setContextMenu(Menu.buildFromTemplate(menuTemplate()));
  tray.on('right-click', () => tray.setContextMenu(Menu.buildFromTemplate(menuTemplate())));
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
  ipcMain.on('ui:focus', () => { win.focus(); win.webContents.focus(); win.flashFrame(false); });
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
  if (cfg.server) { pollMessages(); pollDrops(); pollSpeech(); sendToShortcut(); sendFilesFromArgs(process.argv); }
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
    if (quiet) boardWin.showInactive(); else { boardWin.show(); boardWin.focus(); }
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
    type: 'toolbar', resizable: false, movable: false, hasShadow: false, fullscreenable: false, show: false, webPreferences: boardPrefs(),
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setBounds(d.bounds);
  overlay = { win, mode: 'draw', shot, region };
  const q = new URLSearchParams({ overlay: '1', x: region.x, y: region.y, w: region.w, h: region.h, ...(region.hide ? { hide: region.hide } : {}) });
  win.loadURL(`${serverUrl()}/board?${q}`);
  win.once('ready-to-show', () => { win.show(); win.focus(); });
  win.on('closed', () => { if (overlay && overlay.win === win) overlay = null; });
}

function overlayMode(mode) {
  if (!overlay) return;
  overlay.mode = mode;
  overlay.win.setIgnoreMouseEvents(mode === 'through', { forward: true });
  if (mode === 'draw') overlay.win.focus();
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
      alwaysOnTop: true, show: false, hasShadow: false, type: 'toolbar',
      webPreferences: { preload: path.join(__dirname, 'pill-preload.js'), backgroundThrottling: false },
    });
    pillWin.setIgnoreMouseEvents(true);
    pillWin.setAlwaysOnTop(true, 'screen-saver');
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

// ---------- agents speaking (speak, speech.js on the server) ----------
const playQueue = [];
let nowPlaying = null;

async function pollSpeech() {
  if (vcfg().speak === false) return;
  for (;;) {
    try {
      const r = await fetch(`${serverUrl()}/api/speak?for=${encodeURIComponent(dropName())}&wait=25`, { signal: AbortSignal.timeout(40000) });
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

const VOICE_KEYS = ['speed', 'enabled', 'mode', 'target', 'targetLabel', 'targetHost', 'enter', 'beep', 'stt', 'model', 'speak'];

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
