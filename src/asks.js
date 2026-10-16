// Questions for the user, answered from the phone (or the panel) with one tap.
//
// Anything can ask: an agent through the openone MCP `ask` tool, a script with
// `openone-ask` or a plain POST /api/asks (Hermes adding a calendar event, automic-clark
// handing out a key). Each ask has a title, an optional body and up to four options. The
// asker either waits for the answer (GET /api/asks/:id?wait=55, repeated), gets it POSTed
// to its callback URL, or, for an agent that stopped waiting, has it typed into its chat.
//
//   default   the option that applies by itself when the ask expires, e.g. "Keep" on
//             "Added Dentist Thu 3pm · Keep / Undo". Without one, an expired ask is just
//             "expired".
//   tag       one pending ask per tag: asking again with the same tag returns the pending
//             one instead of a duplicate (pollers like automic-clark's requests use this)
//
// Kept in a JSON file so a server restart doesn't drop what's waiting on you.

const fs = require('fs');
const path = require('path');

const MAX_OPTIONS = 4;
const KEEP = 200;
const DEFAULT_TTL = 24 * 3600;

const clip = (s, n) => String(s ?? '').replace(/\r/g, '').trim().slice(0, n);
const optId = (label, i) => String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || `o${i + 1}`;

class Asks {
  // file: where to keep them ('' = memory only); onChange(): something changed;
  // onAnswer(ask, delivered): answered, delivered = a waiter or callback got it
  constructor({ file = '', now = Date.now, onChange = () => {}, onAnswer = () => {}, post = defaultPost } = {}) {
    this.file = file;
    this.now = now;
    this.onChange = onChange;
    this.onAnswer = onAnswer;
    this.post = post;
    this.list = [];
    this.waiters = new Map(); // id -> Set(resolve)
    this.load();
  }

  load() {
    if (!this.file) return;
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(j.asks)) this.list = j.asks;
    } catch {}
  }

  save() {
    if (this.list.length > KEEP) {
      // drop the oldest settled ones first; pending ones always stay
      const settled = this.list.filter((a) => a.status !== 'pending');
      const drop = new Set(settled.slice(0, this.list.length - KEEP).map((a) => a.id));
      this.list = this.list.filter((a) => !drop.has(a.id));
    }
    if (this.file) {
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(`${this.file}.tmp`, JSON.stringify({ asks: this.list }));
        fs.renameSync(`${this.file}.tmp`, this.file);
      } catch {}
    }
    this.onChange();
  }

  newId() {
    let id;
    do id = `a${Math.random().toString(36).slice(2, 9)}`; while (this.get(id));
    return id;
  }

  // -> the ask (an existing pending one when the tag matches)
  create(o = {}) {
    const title = clip(o.title, 200);
    if (!title) throw new Error('title is required');
    const raw = Array.isArray(o.options) && o.options.length ? o.options : ['OK'];
    if (raw.length > MAX_OPTIONS) throw new Error(`at most ${MAX_OPTIONS} options`);
    const options = raw.map((x, i) => {
      const label = clip(typeof x === 'object' && x ? x.label : x, 40);
      if (!label) throw new Error('every option needs a label');
      return { id: clip(typeof x === 'object' && x && x.id ? x.id : optId(label, i), 40), label };
    });
    if (new Set(options.map((x) => x.id)).size !== options.length) throw new Error('option ids must differ');
    const def = o.default == null || o.default === '' ? null : this.pick(options, o.default);
    if (o.default != null && o.default !== '' && !def) throw new Error(`default "${o.default}" is not one of the options`);
    const callback = clip(o.callback, 500);
    if (callback && !/^https?:\/\//.test(callback)) throw new Error('callback must be an http(s) URL');
    const tag = clip(o.tag, 120);
    if (tag) {
      const same = this.list.find((a) => a.status === 'pending' && a.tag === tag);
      if (same) return same;
    }
    const now = this.now();
    const ttl = Math.max(30, Math.min(Number(o.ttlSec) || DEFAULT_TTL, 30 * 86400));
    const ask = {
      id: this.newId(), at: now, expiresAt: now + ttl * 1000,
      from: clip(o.from, 80) || 'someone', fromKey: o.fromKey || null,
      title, body: clip(o.body, 2000), options, default: def ? def.id : null,
      tag: tag || null, callback: callback || null, project: clip(o.project, 120) || null,
      status: 'pending', answer: null, answerLabel: null, answeredAt: 0, by: null,
    };
    this.list.push(ask);
    this.save();
    return ask;
  }

  pick(options, v) {
    const s = String(v ?? '').trim().toLowerCase();
    return options.find((x) => x.id === s) || options.find((x) => x.label.toLowerCase() === s) ||
      (/^\d$/.test(s) ? options[Number(s) - 1] : null) || null;
  }

  get(id) { return this.list.find((a) => a.id === id) || null; }

  pending() { return this.list.filter((a) => a.status === 'pending'); }

  recent(n = 30) { return this.list.slice(-n); }

  // option: its id, its label or its number (1-based). by: who answered ("phone", "panel")
  answer(id, option, by = 'you') {
    const a = this.get(id);
    if (!a) throw Object.assign(new Error('no such ask'), { code: 404 });
    if (a.status !== 'pending') throw Object.assign(new Error(`already ${a.status}${a.answerLabel ? `: ${a.answerLabel}` : ''}`), { code: 409 });
    const o = this.pick(a.options, option);
    if (!o) throw new Error(`"${option}" is not one of: ${a.options.map((x) => x.label).join(', ')}`);
    return this.settle(a, 'answered', o, by);
  }

  cancel(id) {
    const a = this.get(id);
    if (!a) throw Object.assign(new Error('no such ask'), { code: 404 });
    if (a.status === 'pending') this.settle(a, 'cancelled', null, null);
    return a;
  }

  // expired ones: their default answer if they have one
  sweep() {
    const now = this.now();
    for (const a of this.pending()) {
      if (now < a.expiresAt) continue;
      const def = a.default && a.options.find((x) => x.id === a.default);
      this.settle(a, def ? 'answered' : 'expired', def, def ? 'default' : null);
    }
  }

  settle(a, status, o, by) {
    a.status = status;
    a.answer = o ? o.id : null;
    a.answerLabel = o ? o.label : null;
    a.by = by;
    a.answeredAt = this.now();
    const ws = this.waiters.get(a.id);
    this.waiters.delete(a.id);
    let delivered = false;
    if (ws && ws.size) { delivered = true; for (const r of ws) r(a); }
    if (a.callback) { delivered = true; this.post(a.callback, view(a)).catch(() => {}); }
    this.save();
    if (status === 'answered' || status === 'expired') this.onAnswer(a, delivered);
    return a;
  }

  // resolves with the ask once it's settled, or as it is after ms
  wait(id, ms) {
    const a = this.get(id);
    if (!a) return Promise.reject(Object.assign(new Error('no such ask'), { code: 404 }));
    if (a.status !== 'pending' || ms <= 0) return Promise.resolve(a);
    return new Promise((resolve) => {
      if (!this.waiters.has(id)) this.waiters.set(id, new Set());
      const set = this.waiters.get(id);
      const done = () => { clearTimeout(timer); set.delete(done); resolve(this.get(id)); };
      const timer = setTimeout(done, ms);
      set.add(done);
    });
  }
}

// what clients see (no internal fields)
function view(a) {
  const { fromKey, callback, ...rest } = a;
  return rest;
}

async function defaultPost(url, body) {
  await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
}

module.exports = { Asks, view, MAX_OPTIONS };
