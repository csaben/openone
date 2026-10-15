// Meaning-based search for the project picker: "cloud backup for pictures" should find a
// README about archiving photos even though no word matches.
//
// A small sentence-embedding model (all-MiniLM-L6-v2, 8-bit ONNX, 23 MB) runs on the CPU
// through WebAssembly in a worker thread. It's downloaded on first use. Vectors are cached
// on disk by a hash of their text, so each README summary is embedded once, wherever it
// came from; a query takes a few milliseconds. The worker is stopped after a few idle
// minutes, so the model only takes memory while it's being used.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Worker } = require('worker_threads');

const MODEL = { id: 'Xenova/all-MiniLM-L6-v2', files: ['onnx/model_quantized.onnx', 'tokenizer.json', 'tokenizer_config.json'] };
const SIMILAR = 0.42; // cosine at which two texts are about the same thing, for this model

const hash = (t) => crypto.createHash('sha1').update(t).digest('base64').slice(0, 16);

function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

class Embedder {
  // dir: where the model and the vector cache live
  constructor(dir, { idleMs = 5 * 60000, workerPath = path.join(__dirname, 'embed-worker.js') } = {}) {
    this.dir = dir;
    this.modelDir = path.join(dir, 'models', 'all-MiniLM-L6-v2');
    this.cacheFile = path.join(dir, 'embeddings.json');
    this.idleMs = idleMs;
    this.workerPath = workerPath.replace('app.asar', 'app.asar.unpacked');
    this.cache = null;
    this.worker = null;
    this.pending = new Map();
    this.seq = 0;
    this.chain = Promise.resolve();
    this.downloading = null;
    this.error = '';
  }

  get ready() { return fs.existsSync(path.join(this.modelDir, 'model_quantized.onnx')); }

  async download() {
    if (this.ready) return;
    if (!this.downloading) {
      this.downloading = (async () => {
        fs.mkdirSync(this.modelDir, { recursive: true });
        for (const f of MODEL.files) {
          const res = await fetch(`https://huggingface.co/${MODEL.id}/resolve/main/${f}`, { signal: AbortSignal.timeout(120000) });
          if (!res.ok) throw new Error(`model download failed: ${res.status} ${f}`);
          const tmp = path.join(this.modelDir, `${path.basename(f)}.part`);
          fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
          fs.renameSync(tmp, path.join(this.modelDir, path.basename(f)));
        }
      })().finally(() => { this.downloading = null; });
    }
    return this.downloading;
  }

  loadCache() {
    if (this.cache) return;
    this.cache = new Map();
    try {
      for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(this.cacheFile, 'utf8')))) {
        const b = Buffer.from(v, 'base64');
        this.cache.set(k, new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)));
      }
    } catch {}
  }

  saveCache() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      const out = {};
      for (const [k, v] of this.cache) out[k] = Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64');
      try { fs.mkdirSync(this.dir, { recursive: true }); fs.writeFileSync(this.cacheFile, JSON.stringify(out)); } catch {}
    }, 2000);
  }

  spawn() {
    if (this.worker) return;
    this.worker = new Worker(this.workerPath);
    this.worker.on('message', ({ id, vectors, error }) => {
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (error) p.reject(new Error(error)); else p.resolve(vectors);
    });
    const fail = (e) => {
      for (const p of this.pending.values()) p.reject(e instanceof Error ? e : new Error('embedding worker stopped'));
      this.pending.clear();
      this.worker = null;
    };
    this.worker.on('error', fail);
    this.worker.on('exit', fail);
  }

  // stop the worker (and free the model) after idleMs without use
  touch() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { if (this.worker && !this.pending.size) { this.worker.terminate(); this.worker = null; } }, this.idleMs);
    if (this.idleTimer.unref) this.idleTimer.unref();
  }

  run(texts) {
    this.spawn();
    this.touch();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, model: this.modelDir, texts });
    });
  }

  // texts -> vectors (cached ones straight away, the rest in batches)
  async vectors(texts) {
    this.loadCache();
    const missing = [...new Set(texts.filter((t) => !this.cache.has(hash(t))))];
    if (missing.length) {
      await this.download();
      // one batch at a time, so a query isn't stuck behind a long indexing run
      const job = this.chain.then(async () => {
        for (let i = 0; i < missing.length; i += 16) {
          const part = missing.slice(i, i + 16).filter((t) => !this.cache.has(hash(t)));
          if (!part.length) continue;
          const vs = await this.run(part);
          part.forEach((t, j) => this.cache.set(hash(t), new Float32Array(vs[j])));
        }
      });
      this.chain = job.catch(() => {});
      await job;
      this.saveCache();
    }
    return texts.map((t) => this.cache.get(hash(t)));
  }

  // { query, docs: [{ id, text }] } -> { id: similarity } for docs at least `min` similar
  async search(query, docs, min = 0.3) {
    const [q] = await this.vectors([query]);
    const vs = await this.vectors(docs.map((d) => d.text));
    const out = {};
    docs.forEach((d, i) => { const s = cosine(q, vs[i]); if (s >= min) out[d.id] = Math.round(s * 1000) / 1000; });
    return out;
  }

  // embed docs ahead of the first query (errors are kept for display, never thrown)
  warm(docs) {
    this.vectors(docs.map((d) => d.text)).then(() => { this.error = ''; }).catch((e) => { this.error = e.message; });
  }

  close() { if (this.worker) this.worker.terminate(); this.worker = null; }
}

// What gets embedded for a project and for an agent
const projectText = (name, about) => `${String(name).replace(/[-_.]+/g, ' ')}: ${about || ''}`.trim();
const agentText = (p) => [p.label, p.title, p.question, p.summary].filter(Boolean).join('. ').slice(0, 600);

// The picker's question, "is this already being worked on?", by meaning: project folders
// (name + README summary) and agents (name, title, latest output) on every host.
// -> { projects: { "host|name": similarity }, agents: { paneKey: similarity }, ready }
async function semantic(embedder, query, projectLists, panes) {
  if (!String(query || '').trim()) return { projects: {}, agents: {}, ready: true };
  const docs = [];
  for (const h of projectLists || []) for (const d of h.dirs || []) docs.push({ id: `p:${h.host}|${d.name}`, text: projectText(d.name, d.about) });
  for (const p of panes || []) if (p.kind) docs.push({ id: `a:${p.key}`, text: agentText(p) });
  const scores = await embedder.search(query, docs);
  const out = { projects: {}, agents: {}, ready: true };
  for (const [id, s] of Object.entries(scores)) {
    if (id.startsWith('p:')) out.projects[id.slice(2)] = s; else out.agents[id.slice(2)] = s;
  }
  return out;
}

module.exports = { Embedder, cosine, hash, projectText, agentText, semantic, SIMILAR };
