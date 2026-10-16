// The whiteboard: one shared Excalidraw scene kept by the openone server.
//
// Browsers (the board window on a computer, the phone) hold the live canvas and send
// their edits; the server merges them the way Excalidraw does (per element, the higher
// `version` wins, so edits from several places and deletions all converge) and tells
// everyone the board changed.
//
// Agents can't run Excalidraw, so their drawings arrive as *ops*: element skeletons
// (Excalidraw's convertToExcalidrawElements format) or a Mermaid diagram. A connected
// board page claims each op, turns it into real elements, places it and saves it. With no
// board open, ops wait; the desktop app opens the board when that happens. Pages also
// upload a PNG of the board after edits settle, which is what agents see on board_read.
//
// Kept in ~/.local/state/openone/board/ (board.json, snapshot.png).

const fs = require('fs');
const path = require('path');

const CLAIM_MS = 20000;
const MAX_FILES = 64 << 20; // pasted images, base64, all together

class Board {
  constructor({ dir = '', now = Date.now, onChange = () => {} } = {}) {
    this.dir = dir;
    this.now = now;
    this.onChange = onChange;
    this.elements = new Map(); // id -> element
    this.files = {}; // id -> { id, mimeType, dataURL, created }
    this.version = 0;
    this.ops = []; // { id, at, from, elements?, mermaid?, place, claimedAt, done }
    this.snap = null; // { version, at } with the PNG at snapshot.png
    this.waiters = new Map(); // op id -> [resolve]
    this.seq = 0;
    if (dir) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, 'board.json'), 'utf8'));
        for (const e of j.elements || []) this.elements.set(e.id, e);
        this.files = j.files || {};
        this.version = j.version || 0;
        this.ops = (j.ops || []).filter((o) => !o.done);
        this.snap = j.snap || null;
      } catch {}
    }
  }

  save() {
    this.version++;
    if (this.dir) {
      try {
        fs.mkdirSync(this.dir, { recursive: true });
        const f = path.join(this.dir, 'board.json');
        fs.writeFileSync(`${f}.tmp`, JSON.stringify({ version: this.version, elements: [...this.elements.values()], files: this.files, ops: this.ops, snap: this.snap }));
        fs.renameSync(`${f}.tmp`, f);
      } catch {}
    }
    this.onChange(this.version);
  }

  scene() {
    return { version: this.version, elements: [...this.elements.values()], files: this.files, ops: this.ops.filter((o) => !o.done) };
  }

  // the newer of each element wins; ties broken by versionNonce like Excalidraw does
  merge(elements = [], files = {}) {
    let changed = 0;
    for (const e of Array.isArray(elements) ? elements : []) {
      if (!e || typeof e.id !== 'string' || typeof e.type !== 'string') continue;
      const cur = this.elements.get(e.id);
      if (!cur || (e.version || 0) > (cur.version || 0) || ((e.version || 0) === (cur.version || 0) && (e.versionNonce || 0) < (cur.versionNonce || 0))) {
        this.elements.set(e.id, e);
        changed++;
      }
    }
    let size = Object.values(this.files).reduce((n, f) => n + String(f.dataURL || '').length, 0);
    for (const [id, f] of Object.entries(files || {})) {
      if (this.files[id] || !f || !/^data:image\//.test(String(f.dataURL || ''))) continue;
      size += f.dataURL.length;
      if (size > MAX_FILES) break;
      this.files[id] = { id, mimeType: f.mimeType, dataURL: f.dataURL, created: f.created || this.now() };
      changed++;
    }
    if (changed) this.save();
    return changed;
  }

  // an agent's drawing: { elements: [skeletons] } or { mermaid: "graph TD; A-->B" }
  addOp({ from = 'agent', elements, mermaid, place = 'auto' } = {}) {
    const hasEls = Array.isArray(elements) && elements.length;
    const m = String(mermaid || '').trim();
    if (!hasEls && !m) throw new Error('draw what? give elements or mermaid');
    if (hasEls && elements.length > 500) throw new Error('at most 500 elements per drawing');
    if (m.length > 20000) throw new Error('mermaid too long');
    const op = {
      id: `op${this.now().toString(36)}${(++this.seq).toString(36)}`, at: this.now(), from: String(from).slice(0, 80),
      elements: hasEls ? elements : undefined, mermaid: m || undefined, place: place === 'exact' ? 'exact' : 'auto', claimedAt: 0, done: false,
    };
    this.ops.push(op);
    this.save();
    return op;
  }

  // a page asks to do an op; only one gets it (a claim lapses if it never finishes)
  claim(id) {
    const op = this.ops.find((o) => o.id === id && !o.done);
    if (!op || (op.claimedAt && this.now() - op.claimedAt < CLAIM_MS)) return false;
    op.claimedAt = this.now();
    return true;
  }

  // the page finished these ops (their elements came in with the same request)
  finish(ids = [], result = {}) {
    let n = 0;
    for (const id of ids) {
      const op = this.ops.find((o) => o.id === id && !o.done);
      if (!op) continue;
      op.done = true;
      n++;
      for (const r of this.waiters.get(id) || []) r({ status: 'drawn', ...(result[id] || {}) });
      this.waiters.delete(id);
    }
    this.ops = this.ops.filter((o) => !o.done);
    if (n) this.save();
    return n;
  }

  // resolves when the op is drawn, or with { status: 'queued' } after ms
  waitOp(id, ms) {
    return new Promise((resolve) => {
      const list = this.waiters.get(id) || [];
      const t = setTimeout(() => resolve({ status: 'queued' }), ms);
      list.push((v) => { clearTimeout(t); resolve(v); });
      this.waiters.set(id, list);
    });
  }

  setSnapshot(png, version) {
    if (!this.dir || !Buffer.isBuffer(png) || png.length < 8) return;
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, 'snapshot.png'), png);
    this.snap = { version: Number(version) || this.version, at: this.now() };
    fs.writeFileSync(path.join(this.dir, 'board.json'), JSON.stringify({ version: this.version, elements: [...this.elements.values()], files: this.files, ops: this.ops, snap: this.snap }));
  }

  snapshot() {
    if (!this.dir || !this.snap) return null;
    try { return { png: fs.readFileSync(path.join(this.dir, 'snapshot.png')), ...this.snap }; } catch { return null; }
  }

  // everyone's copy goes blank: every element is deleted (as a newer version, so it merges)
  clear() {
    for (const [id, e] of this.elements) {
      if (!e.isDeleted) this.elements.set(id, { ...e, isDeleted: true, version: (e.version || 0) + 1, versionNonce: Math.floor(Math.random() * 2 ** 31), updated: this.now() });
    }
    this.files = {};
    this.ops = [];
    this.save();
  }

  live() { return [...this.elements.values()].filter((e) => !e.isDeleted); }

  // the board as text, for agents: what's where, what it says, what points at what
  summary() {
    const els = this.live();
    if (!els.length) return 'The board is empty.';
    const r = (n) => Math.round(Number(n) || 0);
    const byId = new Map(els.map((e) => [e.id, e]));
    const label = (e) => {
      const t = els.find((x) => x.type === 'text' && x.containerId === e.id);
      return t ? t.text : '';
    };
    const name = (id) => { const e = byId.get(id); return e ? `${e.type} ${e.id}${label(e) ? ` "${label(e).slice(0, 40)}"` : ''}` : id; };
    const minX = Math.min(...els.map((e) => r(e.x)));
    const minY = Math.min(...els.map((e) => r(e.y)));
    const maxX = Math.max(...els.map((e) => r(e.x) + r(e.width)));
    const maxY = Math.max(...els.map((e) => r(e.y) + r(e.height)));
    const lines = [`${els.length} elements, spanning x ${minX}..${maxX}, y ${minY}..${maxY}.`];
    let freehand = 0;
    for (const e of els) {
      if (e.type === 'text' && e.containerId) continue; // shown as its container's label
      const at = `at (${r(e.x)}, ${r(e.y)}) ${r(e.width)}x${r(e.height)}`;
      if (e.type === 'freedraw') { freehand++; lines.push(`- freehand stroke ${e.id} ${at}${e.strokeColor ? ` ${e.strokeColor}` : ''}`); continue; }
      if (e.type === 'text') { lines.push(`- text ${e.id} ${at}: "${String(e.text).slice(0, 300)}"`); continue; }
      if (e.type === 'arrow' || e.type === 'line') {
        const s = e.startBinding && e.startBinding.elementId;
        const t = e.endBinding && e.endBinding.elementId;
        lines.push(`- ${e.type} ${e.id} ${at}${s || t ? ` from ${s ? name(s) : 'nothing'} to ${t ? name(t) : 'nothing'}` : ''}${label(e) ? ` labeled "${label(e)}"` : ''}`);
        continue;
      }
      if (e.type === 'image') { lines.push(`- image ${e.id} ${at}`); continue; }
      lines.push(`- ${e.type} ${e.id} ${at}${label(e) ? `: "${label(e).slice(0, 200)}"` : ''}${e.backgroundColor && e.backgroundColor !== 'transparent' ? ` fill ${e.backgroundColor}` : ''}`);
    }
    if (freehand > 3) lines.push(`(${freehand} freehand strokes: the user drew by hand; look at the picture to read them)`);
    return lines.join('\n');
  }
}

module.exports = { Board };
