#!/usr/bin/env node
// openone server: watches tmux/psmux on every host over ssh, serves the web UI and an
// HTTP API to answer agents and start sessions. Holds no state of its own: tmux on each
// host is the truth; this keeps the latest snapshot and the "seen" flags in memory.
//
// Listens on loopback only. Expose it with `tailscale serve`, which adds HTTPS and the
// Tailscale-User-Login header used by the optional `allow` list.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { createSource } = require('../src/sources');
const { Monitor } = require('../src/monitor');
const actions = require('../src/actions');

const ROOT = path.join(__dirname, '..');
const CONFIG = process.env.OPENONE_CONFIG || path.join(__dirname, 'config.json');
const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const PORT = Number(process.env.PORT || cfg.port || 8950);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const monitor = new Monitor({ hostNames: cfg.hosts.map((h) => h.name) });
const hosts = {};
const clients = new Set();
let lastState = '';

// ---------- polling ----------

function state() {
  return {
    panes: monitor.view(),
    hosts: Object.values(hosts).map((h) => ({ name: h.cfg.name, type: h.cfg.type, ok: h.ok, error: h.error })),
  };
}

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

function pushState() {
  const s = JSON.stringify(state());
  if (s === lastState) return;
  lastState = s;
  broadcast('state', JSON.parse(s));
}

async function refresh(h) {
  const raws = await h.src.snapshot();
  h.ok = true;
  h.error = '';
  for (const ev of monitor.ingest(h.cfg.name, raws)) broadcast('peek', ev);
  pushState();
}

async function poll(h) {
  for (;;) {
    try {
      await refresh(h);
      await sleep(h.cfg.pollMs || 1500);
    } catch (e) {
      h.ok = false;
      h.error = String(e.message || e).split('\n')[0];
      monitor.ingest(h.cfg.name, []);
      pushState();
      await sleep(Math.max(5000, h.cfg.pollMs || 1500));
    }
  }
}

for (const hc of cfg.hosts.filter((h) => h.enabled !== false)) {
  hosts[hc.name] = { cfg: hc, src: createSource(hc), ok: false, error: 'connecting' };
  poll(hosts[hc.name]);
}

// ---------- http ----------

const LOCAL = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// tailscale serve proxies from loopback and sets Tailscale-User-Login (stripping any
// client-supplied copy). Nothing else can reach a loopback listener but local processes.
function allowed(req) {
  if (!LOCAL.has(req.socket.remoteAddress)) return false;
  const login = req.headers['tailscale-user-login'];
  if (!cfg.allow || !cfg.allow.length) return true;
  return login ? cfg.allow.includes(login) : cfg.allowLocal !== false;
}

function send(res, code, body, type = 'application/json') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (d) => { raw += d; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(new Error('bad json')); } });
  });
}

const TYPES = { '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const STATIC = {
  '/style.css': path.join(ROOT, 'src', 'ui', 'style.css'),
  '/app.js': path.join(ROOT, 'src', 'ui', 'app.js'),
  '/web.js': path.join(__dirname, 'web', 'web.js'),
  '/chat.js': path.join(__dirname, 'web', 'chat.js'),
  '/web.css': path.join(__dirname, 'web', 'web.css'),
  '/manifest.webmanifest': path.join(__dirname, 'web', 'manifest.webmanifest'),
};

// The desktop UI, plus the browser shim that stands in for Electron's preload.
function indexHtml() {
  return fs.readFileSync(path.join(ROOT, 'src', 'ui', 'index.html'), 'utf8')
    .replace('<meta charset="utf-8">', [
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
      '<meta name="theme-color" content="#0b0c0e">',
      '<link rel="manifest" href="manifest.webmanifest">',
      '<link rel="icon" href="assets/spiky-cloud-white-small.svg">',
      '<link rel="apple-touch-icon" href="assets/app-256.png">',
    ].join('\n  '))
    .replace('<link rel="stylesheet" href="style.css">', '<link rel="stylesheet" href="style.css">\n  <link rel="stylesheet" href="web.css">')
    .replace('<script src="app.js"></script>', '<script src="chat.js"></script>\n  <script src="web.js"></script>\n  <script src="app.js"></script>');
}

function pane(key) {
  const p = monitor.get(key);
  const h = p && hosts[p.host];
  if (!p || !h) throw Object.assign(new Error('no such pane'), { code: 404 });
  return { p, h };
}

const KEY = /^[A-Za-z0-9-]{1,20}$/;

async function api(req, res, parts) {
  const [, , a, b, c, d] = parts; // '', 'api', ...
  const m = req.method;
  if (m === 'GET' && a === 'state') return send(res, 200, state());
  if (m === 'GET' && a === 'hosts') return send(res, 200, state().hosts);

  if (m === 'GET' && a === 'events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(`event: state\ndata: ${JSON.stringify(state())}\n\n`);
    clients.add(res);
    const beat = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clearInterval(beat); clients.delete(res); });
    return;
  }

  if (a === 'panes' && b) {
    const { p, h } = pane(decodeURIComponent(b));
    if (m === 'GET' && c === 'screen') {
      const q = new URL(req.url, 'http://x').searchParams;
      const lines = Math.min(Number(q.get('lines')) || 200, 2000);
      const color = q.get('ansi') === '1' ? ['-e'] : []; // keep colors for the web viewer
      const [text] = await h.src.batch([['capture-pane', '-p', ...color, '-J', '-S', `-${lines}`, '-t', h.src.target(p)]]);
      return send(res, 200, { key: p.key, text: text.replace(/\r/g, '') });
    }
    if (m === 'POST') {
      const body = await readJson(req);
      if (c === 'answer') { await actions.answer(h.src, p, Number(body.n)); monitor.markSeen(p.key); }
      else if (c === 'reply') { if (!String(body.text || '').trim()) return send(res, 400, { error: 'empty' }); await actions.reply(h.src, p, String(body.text)); monitor.markSeen(p.key); }
      else if (c === 'keys') {
        const keys = Array.isArray(body.keys) ? body.keys.map(String) : [];
        if (!keys.length || !keys.every((k) => KEY.test(k))) return send(res, 400, { error: 'keys: names like Enter, Escape, C-c, 1' });
        await h.src.keys(p, keys);
      } else if (c === 'text') { await h.src.text(p, String(body.text || '')); }
      else if (c === 'seen') monitor.markSeen(p.key);
      else if (c === 'focus') await h.src.focus(p);
      else return send(res, 404, { error: 'unknown action' });
      pushState();
      return send(res, 200, { ok: true });
    }
  }

  if (a === 'hosts' && b && c === 'sessions') {
    const h = hosts[decodeURIComponent(b)];
    if (!h) return send(res, 404, { error: 'no such host' });
    if (m === 'POST' && !d) {
      const body = await readJson(req);
      const np = await h.src.newSession({ name: String(body.name || ''), cwd: body.cwd ? String(body.cwd) : '', cmd: body.cmd ? String(body.cmd) : '' });
      await refresh(h); // so the new pane is addressable right away, not after the next poll
      return send(res, 201, { host: h.cfg.name, session: np.session, paneId: np.paneId, key: `${h.cfg.name}|${np.session}|${np.paneId}` });
    }
    if (m === 'DELETE' && d) {
      await h.src.killSession(decodeURIComponent(d));
      return send(res, 200, { ok: true });
    }
  }
  return send(res, 404, { error: 'not found' });
}

const server = http.createServer(async (req, res) => {
  if (!allowed(req)) return send(res, 403, { error: 'forbidden' });
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/');
  try {
    if (parts[1] === 'api') return await api(req, res, parts);
    if (req.method !== 'GET') return send(res, 405, { error: 'method' });
    if (url.pathname === '/') return send(res, 200, indexHtml(), 'text/html; charset=utf-8');
    let file = STATIC[url.pathname];
    if (!file && /^\/assets\/[\w.-]+$/.test(url.pathname)) file = path.join(ROOT, url.pathname);
    if (file && fs.existsSync(file)) return send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] || 'application/octet-stream');
    return send(res, 404, 'not found', 'text/plain');
  } catch (e) {
    send(res, e.code === 404 ? 404 : 500, { error: String(e.message || e) });
  }
});

// Live reload: when the UI files change (an agent editing them, a git pull), tell open
// pages to reload. Stands in for a dev server's hot reload in the circleback loop.
let reloadTimer = null;
for (const dir of [path.join(ROOT, 'src', 'ui'), path.join(__dirname, 'web')]) {
  try {
    fs.watch(dir, () => {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => broadcast('reload', {}), 300);
    });
  } catch {}
}

server.listen(PORT, cfg.bind || '127.0.0.1', () => {
  console.log(`openone server on http://${cfg.bind || '127.0.0.1'}:${PORT} watching ${Object.keys(hosts).join(', ')}`);
});
