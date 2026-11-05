// Opening a project in VS Code from an agent (the code tool): the server can't start VS Code
// on your computer, so it queues the request and the desktop app you're at picks it up, runs
// `code` (Remote-SSH for remote hosts) and reports back, and the agent's call returns that.
//
// "The desktop you're at": of the desktop apps polling, the one with the least idle time
// (each poll says how long since you touched that computer).

const crypto = require('crypto');

const SEEN_MS = 70000; // a desktop that hasn't polled this long doesn't count
const KEEP_MS = 2 * 60000; // not picked up by then: dropped

class Opens {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.items = []; // { id, target, from, at, status: queued|taken|done|failed, by, error }
    this.devices = new Map(); // name -> { idleMs, at }
    this.waiters = new Set();
  }

  seen(name, idleMs = 0) { this.devices.set(name, { idleMs: Number(idleMs) || 0, at: this.now() }); }

  // the desktop you're at, or '' when no desktop app is polling
  target() {
    const t = this.now();
    let best = '';
    let bestIdle = Infinity;
    for (const [name, d] of this.devices) {
      if (t - d.at >= SEEN_MS) continue;
      // idle grows while a desktop long-polls, so count the time since it asked
      const idle = d.idleMs + (t - d.at);
      if (idle < bestIdle) { best = name; bestIdle = idle; }
    }
    return best;
  }

  // target: { host, folder } a project, or { host, dir } an agent's folder
  add({ target, from = '' }) {
    if (!this.target()) throw Object.assign(new Error('no openone desktop app is connected to open VS Code in'), { code: 409 });
    const it = { id: crypto.randomBytes(5).toString('hex'), target, from: String(from || ''), at: this.now(), status: 'queued', by: '', error: '' };
    this.items.push(it);
    this.wake();
    return it;
  }

  // queued requests for this desktop, if it's the one you're at; each goes to one taker
  take(by) {
    const t = this.now();
    this.items = this.items.filter((x) => t - x.at < KEEP_MS || x.waiting);
    if (by !== this.target()) return [];
    const out = this.items.filter((x) => x.status === 'queued');
    for (const x of out) { x.status = 'taken'; x.by = by; }
    return out.map(({ id, target, from }) => ({ id, target, from }));
  }

  // the desktop's report
  done(id, { ok, error = '' }) {
    const it = this.items.find((x) => x.id === id);
    if (!it) return false;
    it.status = ok ? 'done' : 'failed';
    it.error = ok ? '' : String(error || 'failed');
    this.wake();
    return true;
  }

  // -> the item once done or failed, or as it stands after ms
  async result(id, ms) {
    const it = this.items.find((x) => x.id === id);
    if (!it) return null;
    const end = this.now() + ms;
    it.waiting = true;
    while ((it.status === 'queued' || it.status === 'taken') && this.now() < end) await this.wait(end - this.now());
    it.waiting = false;
    return it;
  }

  wait(ms) {
    return new Promise((resolve) => {
      const w = () => { clearTimeout(timer); this.waiters.delete(w); resolve(); };
      const timer = setTimeout(w, Math.max(0, ms));
      this.waiters.add(w);
    });
  }

  wake() { for (const w of [...this.waiters]) w(); }
}

module.exports = { Opens };
