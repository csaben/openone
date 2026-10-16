// Drops: links, text and files sent between your phone and your computers, through the
// openone server (so it works wherever Tailscale does).
//
// A drop is addressed to a device: "phone", or a computer by its host name (the desktop
// app collects drops for its machine). Text with links opens them in the browser there;
// other text goes to the clipboard; files are saved to Downloads. A drop is deleted once
// the device has it, or after a day.
//
// Files are kept on the server's disk until then (~/.local/state/openone/drops).

const fs = require('fs');
const path = require('path');

const KEEP_MS = 24 * 3600000;
const MAX_TEXT = 100000;
const MAX_FILE = 512 << 20;
const SEEN_MS = 90000; // a computer that asked for drops this recently counts as online

const cleanName = (s) => String(s || 'file').replace(/[\\/:*?"<>|\r\n\0]+/g, '_').replace(/^\.+/, '').slice(0, 160) || 'file';
const device = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 40);

// the http(s) links in a piece of text, in order, without duplicates
function links(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/https?:\/\/[^\s<>"'`]+/g)) {
    const u = m[0].replace(/[),.;:!?\]]+$/, '');
    if (!out.includes(u)) out.push(u);
  }
  return out;
}

class Drops {
  constructor({ dir = '', now = Date.now, onChange = () => {} } = {}) {
    this.dir = dir;
    this.now = now;
    this.onChange = onChange;
    this.list = [];
    this.seen = new Map(); // computer -> last time it asked
    this.waiters = new Set();
    if (dir) {
      try { this.list = JSON.parse(fs.readFileSync(path.join(dir, 'drops.json'), 'utf8')).drops || []; } catch {}
    }
  }

  save() {
    if (this.dir) {
      try {
        fs.mkdirSync(this.dir, { recursive: true });
        fs.writeFileSync(path.join(this.dir, 'drops.json'), JSON.stringify({ drops: this.list }));
      } catch {}
    }
    for (const w of this.waiters) w();
    this.onChange();
  }

  newId() { return `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`; }

  add({ to, from, text }) {
    const t = String(text || '').trim();
    if (!t) throw new Error('nothing to send');
    if (t.length > MAX_TEXT) throw new Error('too long');
    const d = { id: this.newId(), at: this.now(), to: device(to), from: device(from) || 'someone', kind: 'text', text: t, links: links(t) };
    if (!d.to) throw new Error('to: which device');
    this.list.push(d);
    this.save();
    return d;
  }

  // stream: a readable with the file's bytes -> the drop, once it's all on disk
  async addFile({ to, from, name, mime, stream }) {
    if (!this.dir) throw new Error('no place to keep files');
    const d = { id: this.newId(), at: this.now(), to: device(to), from: device(from) || 'someone', kind: 'file', name: cleanName(name), mime: String(mime || 'application/octet-stream').slice(0, 100), size: 0 };
    if (!d.to) throw new Error('to: which device');
    fs.mkdirSync(path.join(this.dir, 'files'), { recursive: true });
    const file = this.filePath(d);
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(file);
      stream.on('data', (chunk) => {
        d.size += chunk.length;
        if (d.size > MAX_FILE) { stream.destroy(); out.destroy(); reject(new Error('file too big (512 MB max)')); }
      });
      stream.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
      stream.pipe(out);
    }).catch((e) => { fs.rmSync(file, { force: true }); throw e; });
    this.list.push(d);
    this.save();
    return d;
  }

  filePath(d) { return path.join(this.dir, 'files', d.id); }

  get(id) { return this.list.find((d) => d.id === id) || null; }

  // what's waiting for a device; a computer asking counts as it being online
  for(dev) {
    const k = device(dev);
    if (k && k !== 'phone') this.seen.set(k, this.now());
    return this.list.filter((d) => d.to === k);
  }

  // resolves when something changes, or after ms
  wait(ms) {
    return new Promise((resolve) => {
      const done = () => { clearTimeout(t); this.waiters.delete(done); resolve(); };
      const t = setTimeout(done, ms);
      this.waiters.add(done);
    });
  }

  // the device has it: forget it (and its file)
  take(id) {
    const d = this.get(id);
    if (!d) return null;
    this.list = this.list.filter((x) => x !== d);
    if (d.kind === 'file') fs.rmSync(this.filePath(d), { force: true });
    this.save();
    return d;
  }

  sweep() {
    const old = this.list.filter((d) => this.now() - d.at > KEEP_MS);
    for (const d of old) this.take(d.id);
  }

  // computers seen lately, most recent first; the phone is always a target
  devices() {
    const now = this.now();
    const pcs = [...this.seen.entries()].filter(([, t]) => now - t < SEEN_MS).sort((a, b) => b[1] - a[1]).map(([n]) => n);
    return [...pcs, 'phone'];
  }
}

module.exports = { Drops, links, cleanName, device };
