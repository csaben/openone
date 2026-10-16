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
const projects = require('../src/projects');
const { Embedder, semantic, projectText } = require('../src/embed');
const { Bus, names } = require('../src/bus');
const { Asks, view: askView } = require('../src/asks');


const ROOT = path.join(__dirname, '..');
const CONFIG = process.env.OPENONE_CONFIG || path.join(__dirname, 'config.json');
const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const PORT = Number(process.env.PORT || cfg.port || 8950);
// meaning-based project search; the model and vectors live in ~/.cache/openone
const embedder = cfg.semantic === false ? null : new Embedder(path.join(require('os').homedir(), '.cache', 'openone'));
let lastProjects = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const monitor = new Monitor({ hostNames: cfg.hosts.map((h) => h.name) });
const hosts = {};
// agent-to-agent messages; typed into a pane through the same path as a reply
const bus = new Bus({
  monitor,
  deliver: async (p, text) => {
    const h = hosts[p.host];
    await actions.reply(h.src, p, text);
    monitor.markSeen(p.key);
    pushState();
  },
});
// questions for you, answered from the phone; kept in ~/.local/state/openone
const asks = new Asks({
  file: cfg.asksFile || path.join(require('os').homedir(), '.local', 'state', 'openone', 'asks.json'),
  onChange: () => pushState(),
  // an agent that stopped waiting gets the answer typed into its chat
  onAnswer: (a, delivered) => {
    // (a long-poller between two polls counts as waiting)
    if (delivered || !a.fromKey || Date.now() - (polled.get(a.id) || 0) < 5000) return;
    const text = a.status === 'answered'
      ? `The user answered your question "${a.title}": ${a.answerLabel}${a.by === 'default' ? ' (nobody answered, so the default applied)' : ''}`
      : `Your question "${a.title}" expired without an answer.`;
    try { bus.send({ fromName: 'openone', to: a.fromKey, content: text, note: true }); pushState(); } catch {}
  },
});
const polled = new Map(); // ask id -> last time someone long-polled it
setInterval(() => asks.sweep(), 15000);
const clients = new Set();
let lastState = '';

// ---------- polling ----------

function state() {
  return {
    panes: monitor.view(),
    messages: bus.recent(40),
    asks: asks.pending().map(askView),
    hosts: Object.values(hosts).map((h) => ({ name: h.cfg.name, type: h.cfg.type, ok: h.ok, error: h.error, fed: !!fedRecently(h) })),
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
  bus.pump().then(pushState);
}

// A host with "feed": true is read by the desktop app on that machine, which posts its
// snapshots here (see POST /api/hosts/:host/snapshot), so the panes are read once, not
// twice: on psmux every read can flash the terminal. Polls itself only while no feed
// has arrived for feedStaleMs.
const fedRecently = (h) => h.cfg.feed && Date.now() - (h.fedAt || 0) < (h.cfg.feedStaleMs || 20000);

async function poll(h) {
  for (;;) {
    if (fedRecently(h)) { await sleep(h.cfg.pollMs || 1500); continue; }
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

function readJson(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (d) => { raw += d; if (raw.length > limit) req.destroy(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(new Error('bad json')); } });
  });
}

const TYPES = { '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.html': 'text/html; charset=utf-8' };
const STATIC = {
  '/style.css': path.join(ROOT, 'src', 'ui', 'style.css'),
  '/app.js': path.join(ROOT, 'src', 'ui', 'app.js'),
  '/search.js': path.join(ROOT, 'src', 'ui', 'search.js'),
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

  if (m === 'GET' && a === 'projects' && b === 'semantic') {
    if (!embedder) return send(res, 200, { projects: {}, agents: {}, ready: false });
    const q = new URL(req.url, 'http://x').searchParams.get('q') || '';
    return send(res, 200, await semantic(embedder, q, lastProjects, monitor.view())
      .catch((e) => ({ projects: {}, agents: {}, ready: false, error: String(e.message || e) })));
  }

  if (a === 'projects' && !b) {
    if (m === 'GET') {
      lastProjects = await Promise.all(Object.values(hosts).map((h) => projects.list(h)
        .catch((e) => ({ host: h.cfg.name, error: String(e.message || e).split('\n')[0], dirs: [] }))));
      if (embedder) embedder.warm(lastProjects.flatMap((h) => h.dirs.map((d) => ({ text: projectText(d.name, d.about) }))));
      return send(res, 200, lastProjects);
    }
    if (m === 'POST') {
      const body = await readJson(req);
      const h = hosts[String(body.host || '')];
      if (!h) return send(res, 404, { error: 'no such host' });
      const np = await projects.start(h, cfg, {
        folder: String(body.folder || ''), create: !!body.create, agent: String(body.agent || 'claude'), resume: !!body.resume, prompt: String(body.prompt || ''),
      });
      await refresh(h);
      return send(res, 201, { key: `${h.cfg.name}|${np.session}|${np.paneId}` });
    }
  }

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
      // from the pane's stream when there is one (no capture-pane), with colors for the web viewer
      const text = await h.src.screen(p, lines, q.get('ansi') === '1');
      return send(res, 200, { key: p.key, text });
    }
    if (m === 'POST') {
      const body = await readJson(req);
      if (c === 'answer') { await actions.answer(h.src, p, Number(body.n)); monitor.markSeen(p.key); bus.touch(p.key); }
      else if (c === 'reply') { if (!String(body.text || '').trim()) return send(res, 400, { error: 'empty' }); await actions.reply(h.src, p, String(body.text)); monitor.markSeen(p.key); bus.touch(p.key); }
      else if (c === 'keys') {
        const keys = Array.isArray(body.keys) ? body.keys.map(String) : [];
        if (!keys.length || !keys.every((k) => KEY.test(k))) return send(res, 400, { error: 'keys: names like Enter, Escape, C-c, 1' });
        await h.src.keys(p, keys);
      } else if (c === 'text') { await h.src.text(p, String(body.text || '')); }
      else if (c === 'seen') { monitor.markSeen(p.key); bus.touch(p.key); }
      else if (c === 'focus') await h.src.focus(p.bg ? await h.src.attachBackground(p.bg) : p);
      else if (c === 'attach') {
        // background session -> a tmux window running `claude attach`; returns that pane's key
        if (!p.bg) return send(res, 200, { key: p.key });
        const np = await h.src.attachBackground(p.bg);
        await refresh(h);
        return send(res, 200, { key: `${h.cfg.name}|${np.session}|${np.paneId}` });
      }
      else return send(res, 404, { error: 'unknown action' });
      pushState();
      return send(res, 200, { ok: true });
    }
  }

  if (a === 'bus') return busApi(req, res, b);
  if (a === 'asks') return asksApi(req, res, b ? decodeURIComponent(b) : '', c);

  if (m === 'POST' && a === 'hosts' && b && c === 'snapshot') {
    const h = hosts[decodeURIComponent(b)];
    if (!h || !h.cfg.feed) return send(res, 404, { error: 'not a fed host' });
    const body = await readJson(req, 8e6);
    if (!Array.isArray(body.panes)) return send(res, 400, { error: 'panes: array' });
    const str = (v) => String(v ?? '');
    const raws = body.panes.filter((p) => p && /^%\d+$/.test(str(p.paneId))).map((p) => ({
      paneId: str(p.paneId), session: str(p.session), windowIndex: str(p.windowIndex), windowName: str(p.windowName),
      paneIndex: str(p.paneIndex), command: str(p.command), path: str(p.path), title: str(p.title),
      windowActive: str(p.windowActive), paneActive: str(p.paneActive), attached: !!p.attached, sig: str(p.sig), text: str(p.text),
    }));
    h.fedAt = Date.now();
    h.ok = true;
    h.error = '';
    for (const ev of monitor.ingest(h.cfg.name, raws)) broadcast('peek', ev);
    pushState();
    return send(res, 200, { ok: true });
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

// ---------- agent tools (tools/mcp.js calls these) ----------
//
// The caller says which pane it runs in ({ host, pane, session } from $TMUX_PANE etc.),
// which is how messages get a sender and replies find their way back.

async function busApi(req, res, what) {
  const m = req.method;
  const q = new URL(req.url, 'http://x').searchParams;
  const body = m === 'POST' ? await readJson(req) : {};
  const meArg = m === 'POST' ? body.me || {} : { host: q.get('host'), pane: q.get('pane'), session: q.get('session'), thread: q.get('thread'), cwd: q.get('cwd') };
  const me = bus.whoami(meArg);
  const myName = me ? bus.names().get(me.key) : '';
  const hostOf = (name) => {
    const h = hosts[String(name || '')];
    if (!h) throw Object.assign(new Error(`no host "${name}"; hosts: ${Object.keys(hosts).join(', ')}`), { code: 404 });
    return h;
  };

  if (m === 'GET' && what === 'roster') {
    return send(res, 200, { you: myName || null, hosts: Object.keys(hosts), agents: bus.roster(me) });
  }
  if (m === 'POST' && what === 'send') {
    const fromName = meArg.host ? `outside@${String(meArg.host).toLowerCase()}` : '';
    const msg = bus.send({ from: me, fromName, to: body.to, content: body.content });
    pushState();
    return send(res, 200, { id: msg.id, to: msg.to, status: msg.status, via: msg.via });
  }
  if (m === 'GET' && what === 'messages') return send(res, 200, bus.recent(Number(q.get('n')) || 40));
  if (m === 'GET' && what === 'peek') {
    const p = bus.resolve(q.get('name'));
    if (!p) return send(res, 404, { error: `no agent named "${q.get('name')}"` });
    const lines = Math.min(Number(q.get('lines')) || 60, 400);
    const text = String(await hosts[p.host].src.screen(p, lines)).replace(/\s+$/, '').split('\n').slice(-lines).join('\n');
    return send(res, 200, { name: bus.names().get(p.key), state: p.state, text });
  }
  if (m === 'GET' && what === 'projects') {
    const want = q.get('host') ? [hostOf(q.get('host'))] : Object.values(hosts);
    const nm = bus.names();
    const agents = bus.agents();
    const base = (s) => String(s || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop().toLowerCase();
    const out = await Promise.all(want.map(async (h) => {
      const l = await projects.list(h).catch((e) => ({ host: h.cfg.name, error: String(e.message || e).split('\n')[0], dirs: [] }));
      return {
        host: l.host, workspace: l.workspace, error: l.error,
        projects: l.dirs.map((d) => ({
          name: d.name, about: d.about || '',
          agents: agents.filter((p) => p.host === h.cfg.name && base(p.path) === d.name.toLowerCase()).map((p) => nm.get(p.key)),
        })),
      };
    }));
    return send(res, 200, out);
  }
  if (m === 'GET' && what === 'ls') {
    return send(res, 200, await projects.ls(hostOf(q.get('host')), q.get('path') || ''));
  }
  if (m === 'POST' && what === 'start') {
    const h = hostOf(body.host);
    let prompt = String(body.prompt || '').trim();
    if (prompt && myName) prompt = `[openone: started by ${myName}; report back with the openone send tool, to="${myName}"] ${prompt}`;
    const np = await projects.start(h, cfg, {
      folder: String(body.folder || ''), create: !!body.create, agent: String(body.agent || 'claude'), resume: !!body.resume, prompt,
    });
    await refresh(h);
    const key = `${h.cfg.name}|${np.session}|${np.paneId}`;
    const p = monitor.get(key);
    const name = p ? names([...bus.agents().filter((x) => x.key !== key), { ...p, kind: p.kind || 'agent' }]).get(key) : key;
    return send(res, 201, { name, key, note: 'it may take a few seconds to show up in roster' });
  }
  if (m === 'GET' && what === 'listen') {
    // a Claude session started with the openone channel: messages are pushed here
    if (!me) return send(res, 404, { error: 'not in a pane openone knows (yet)' });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(`event: hello\ndata: ${JSON.stringify({ you: myName })}\n\n`);
    const off = bus.listen(me.key, (msg) => res.write(`event: message\ndata: ${JSON.stringify({ from: msg.from, content: msg.content, id: msg.id })}\n\n`));
    const beat = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clearInterval(beat); off(); });
    return;
  }
  return send(res, 404, { error: 'not found' });
}

// ---------- asks: questions for you (src/asks.js) ----------
//
//   POST   /api/asks               { title, body?, options?, default?, ttlSec?, tag?, callback?, from?, project? }
//                                  (+ me: the MCP caller's pane, which signs it and gets late answers)
//   GET    /api/asks               pending ones; ?all=1 adds the recent settled ones
//   GET    /api/asks/:id?wait=55   the ask, once answered or after wait seconds (max 55)
//   POST   /api/asks/:id/answer    { option, by? }   option = id, label or number
//   DELETE /api/asks/:id           withdraw it

async function asksApi(req, res, id, action) {
  const m = req.method;
  const q = new URL(req.url, 'http://x').searchParams;
  if (!id) {
    if (m === 'GET') return send(res, 200, (q.get('all') ? asks.recent(50) : asks.pending()).map(askView));
    if (m === 'POST') {
      const body = await readJson(req);
      const me = body.me ? bus.whoami(body.me) : null;
      const from = me ? bus.names().get(me.key) : String(body.from || '');
      try {
        const a = asks.create({ ...body, from, fromKey: me ? me.key : null });
        broadcast('ask', askView(a));
        return send(res, 201, askView(a));
      } catch (e) { return send(res, 400, { error: e.message }); }
    }
    return send(res, 405, { error: 'method' });
  }
  if (m === 'GET' && !action) {
    polled.set(id, Date.now());
    const a = await asks.wait(id, Math.min(Number(q.get('wait')) || 0, 55) * 1000);
    polled.set(id, Date.now());
    if (polled.size > 500) polled.delete(polled.keys().next().value);
    return send(res, 200, askView(a));
  }
  if (m === 'POST' && action === 'answer') {
    const body = await readJson(req);
    try { return send(res, 200, askView(asks.answer(id, body.option, String(body.by || 'you').slice(0, 20)))); }
    catch (e) { return send(res, e.code || 400, { error: e.message }); }
  }
  if (m === 'DELETE' && !action) return send(res, 200, askView(asks.cancel(id)));
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
    // the how-it-works page and its screenshots
    if (url.pathname === '/guide') { res.writeHead(301, { location: 'guide/' }); return res.end(); }
    if (!file && url.pathname === '/guide/') file = path.join(__dirname, 'web', 'guide', 'index.html');
    if (!file && /^\/guide\/[\w-]+\.png$/.test(url.pathname)) file = path.join(__dirname, 'web', url.pathname);
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
