// Keeps one record per pane across polls and decides when to notify.
// A state only counts once it is seen on two polls in a row, so a pane flickering
// between frames never fires a toast.

const fs = require('fs');
const path = require('path');
const { detect } = require('./detect');

const KEEP = 14 * 86400000; // forget when a pane was last used after this long

const GENERIC = /^(claude|codex|node|bash|zsh|sh|fish|pwsh|powershell|cmd|tmux|psmux|trident)([.-].*)?$/i;
const SPIN = /^[\s✳✻✶✢✽·*⠁-⣿]+/;

function label(raw) {
  if (raw.windowName && !GENERIC.test(raw.windowName)) return raw.windowName;
  return path.posix.basename(String(raw.path || '').replace(/\\/g, '/')) || raw.windowName || raw.paneId;
}

function title(raw, hostNames) {
  const t = String(raw.title || '').replace(SPIN, '').trim();
  if (!t || hostNames.has(t.toLowerCase())) return '';
  return t;
}

class Monitor {
  // usedFile: where "last used" times are kept, so the agent list stays in recent-first
  // order across restarts (openone's, or the multiplexer's: then panes get new ids, so a
  // pane also matches on its folder and name)
  constructor({ hostNames = [], usedFile = null } = {}) {
    this.panes = new Map();
    this.hostNames = new Set(hostNames.map((h) => h.toLowerCase()));
    this.usedFile = usedFile;
    this.saved = {};
    if (usedFile) try { this.saved = JSON.parse(fs.readFileSync(usedFile, 'utf8')) || {}; } catch {}
    this.saveTimer = null;
  }

  static place(p) { return `@${p.host}|${String(p.path || '').replace(/\\/g, '/').toLowerCase()}|${p.label}`; }

  remember(p) {
    if (!this.usedFile || !p.used) return;
    this.saved[p.key] = p.used;
    const at = Monitor.place(p);
    this.saved[at] = Math.max(this.saved[at] || 0, p.used);
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.save(), 5000);
    if (this.saveTimer.unref) this.saveTimer.unref();
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const now = Date.now();
    for (const [k, t] of Object.entries(this.saved)) if (now - t > KEEP) delete this.saved[k];
    try {
      fs.mkdirSync(path.dirname(this.usedFile), { recursive: true });
      fs.writeFileSync(this.usedFile, JSON.stringify(this.saved));
    } catch {}
  }

  // Returns the notification events produced by this snapshot.
  ingest(host, raws, now = Date.now()) {
    const events = [];
    const seen = new Set();
    for (const raw of raws) {
      const key = `${host}|${raw.session}|${raw.paneId}`;
      seen.add(key);
      const d = detect(raw.text || '', { command: raw.command, windowName: raw.windowName });
      // the source knows better (Claude's own status for background sessions)
      if (raw.override) Object.assign(d, raw.override);
      let p = this.panes.get(key);
      const fresh = !p;
      if (fresh) {
        p = { key, host, state: d.state, since: now, unseen: d.state === 'input', pending: d.state, count: 2 };
        this.panes.set(key, p);
      }
      Object.assign(p, {
        session: raw.session, windowIndex: raw.windowIndex, windowName: raw.windowName,
        paneId: raw.paneId, path: raw.path, command: raw.command,
        active: raw.windowActive === '1' && raw.paneActive === '1' && raw.attached !== false,
        label: label(raw), title: title(raw, this.hostNames) || p.title || '', bg: raw.bg || null,
      });
      if (fresh) p.used = this.saved[key] || this.saved[Monitor.place(p)] || 0;
      if (d.kind) p.kind = d.kind;

      if (d.state === p.pending) p.count++;
      else { p.pending = d.state; p.count = 1; }

      if (!fresh && p.count >= 2 && d.state !== p.state) {
        const prev = p.state;
        p.state = d.state;
        p.since = now;
        p.used = now; // a turn started, finished or asked something: it's in use
        this.remember(p);
        // (raw output isn't a sign of use: background timers redraw idle panes)
        if (d.state === 'input') { p.unseen = true; events.push({ type: 'input', key }); }
        else if (d.state === 'idle' && prev === 'working') { p.unseen = true; events.push({ type: 'done', key }); }
        else if (d.state === 'working') p.unseen = false;
        if (d.turn) p.turn = d.turn;
      } else if (!fresh && p.state === 'idle' && d.state === 'idle' && d.turn && p.turn && d.turn !== p.turn) {
        // a whole turn ran between two polls (fast reply): the done line is new
        p.unseen = true;
        p.since = now;
        events.push({ type: 'done', key });
      }
      if (d.turn && p.state === d.state) p.turn = d.turn;
      if (p.state === d.state) {
        p.question = d.question || '';
        p.topic = d.topic || '';
        p.detail = d.detail || '';
        p.options = d.options || [];
        p.summary = d.summary || '';
        p.doneAt = d.doneAt || '';
      }
    }
    for (const [key, p] of this.panes) if (p.host === host && !seen.has(key)) this.panes.delete(key);
    return events;
  }

  get(key) { return this.panes.get(key); }

  markSeen(key) {
    const p = this.panes.get(key);
    if (p) { p.unseen = false; p.used = Date.now(); this.remember(p); } // opening, answering or replying is using it
  }

  view() {
    return [...this.panes.values()].map((p) => ({
      key: p.key, host: p.host, session: p.session, windowIndex: p.windowIndex, paneId: p.paneId,
      kind: p.kind || null, state: p.state, label: p.label, title: p.title, active: p.active,
      since: p.since, unseen: p.unseen, question: p.question, topic: p.topic, detail: p.detail, options: p.options,
      summary: p.summary, doneAt: p.doneAt, path: p.path, bg: p.bg, used: p.used || 0,
    }));
  }
}

module.exports = { Monitor };
