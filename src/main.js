const { app, BrowserWindow, ipcMain, screen, powerMonitor, globalShortcut, Notification, Tray, Menu, nativeImage, nativeTheme, shell } = require('electron');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Monitor } = require('./monitor');
const { createSource } = require('./sources');
const { WindowsTerminal } = require('./wt');
const actions = require('./actions');
const { detect: detectConfig } = require('./setup');

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
    skipTaskbar: true, alwaysOnTop: true, hasShadow: false, show: false, backgroundColor: '#00000000',
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
  return !!(fg.ok && fg.wt && fg.tab && h && new RegExp(h.cfg.wtTab, 'i').test(fg.tab));
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
  push();
  win.webContents.send('collapse');
  await r.h.src.focus(r.p).catch(() => {});
  const res = await wt.focus(r.h.cfg.wtTab, r.h.cfg.wtTabIndex);
  if (!res.ok) win.webContents.send('toast', `Couldn't find the ${r.h.cfg.name} tab in Windows Terminal`);
}

async function answer(key, n) {
  const r = lookup(key);
  if (!r) return;
  await actions.answer(r.h.src, r.p, n);
  monitor.markSeen(key);
  push();
}

async function reply(key, text) {
  const r = lookup(key);
  if (!r || !text.trim()) return;
  await actions.reply(r.h.src, r.p, text);
  monitor.markSeen(key);
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
    { label: 'Show shells too', type: 'checkbox', checked: !!cfg.showShells, click: () => { cfg.showShells = !cfg.showShells; push(); } },
    { label: 'Mute notifications', type: 'checkbox', checked: muted, click: () => { muted = !muted; push(); } },
    { label: 'Reload config', click: () => { loadConfig(); place(); startHosts(); } },
    { label: 'Open config', click: () => shell.openPath(CONFIG) },
    {
      label: 'Start at login', type: 'checkbox', checked: app.getLoginItemSettings(loginItem()).openAtLogin,
      click: (item) => app.setLoginItemSettings({ ...loginItem(), openAtLogin: item.checked }),
    },
    { type: 'separator' },
    { label: 'Quit openone', click: () => app.quit() },
  ];
}

// electron.exe + this folder, so login launch works without a packaged build
function loginItem() {
  return app.isPackaged ? {} : { path: process.execPath, args: [path.resolve(__dirname, '..')] };
}

function toggle() {
  if (size !== 'full') { size = 'full'; place(); }
  if (win.isFocused()) { win.webContents.send('collapse'); win.blur(); return; }
  win.show();
  win.focus();
  win.webContents.focus();
  win.webContents.send('expand');
}

// Chromium treats a mostly-transparent topmost window as occluded and stops painting it,
// freezing transitions half-way (ghost rail) and dropping frames (flicker).
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

if (!app.requestSingleInstanceLock()) app.quit();

app.whenReady().then(() => {
  app.setAppUserModelId('com.csaben.openone');
  loadConfig();
  createWindow();
  wt.start();
  startHosts();
  tray = new Tray(trayIcon());
  tray.setToolTip('openone');
  tray.on('click', toggle);
  nativeTheme.on('updated', () => tray.setImage(trayIcon()));
  tray.setContextMenu(Menu.buildFromTemplate(menuTemplate()));
  tray.on('right-click', () => tray.setContextMenu(Menu.buildFromTemplate(menuTemplate())));
  if (cfg.hotkey) globalShortcut.register(cfg.hotkey, toggle);
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
  ipcMain.on('ui:focus', () => { win.focus(); win.webContents.focus(); });
  ipcMain.on('ui:menu', () => Menu.buildFromTemplate(menuTemplate()).popup({ window: win }));
  ipcMain.on('ui:ready', () => { lastState = ''; push(); });
  ipcMain.on('ui:mute', () => { muted = !muted; push(); });
  ipcMain.handle('pane:jump', (_e, key) => jump(key));
  ipcMain.handle('pane:answer', (_e, key, n) => answer(key, n));
  ipcMain.handle('pane:reply', (_e, key, text) => reply(key, text));
  ipcMain.on('pane:seen', (_e, key) => { monitor.markSeen(key); push(); });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  wt.stop();
  for (const h of Object.values(hosts)) { h.running = false; if (h.src.close) h.src.close(); }
});
app.on('window-all-closed', () => app.quit());
