// Runs the embedding model off the main thread (a worker), so indexing never stalls the
// dock. Messages: { id, model, texts } -> { id, vectors } (or { id, error }).
const { parentPort } = require('worker_threads');
const fs = require('fs');
const path = require('path');

let loaded = null; // { dir, tok, session, ort }

async function load(dir) {
  if (loaded && loaded.dir === dir) return loaded;
  const ort = require('onnxruntime-web');
  const { Tokenizer } = require('@huggingface/tokenizers');
  ort.env.wasm.numThreads = 1;
  const json = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const tok = new Tokenizer(json('tokenizer.json'), json('tokenizer_config.json'));
  const session = await ort.InferenceSession.create(fs.readFileSync(path.join(dir, 'model_quantized.onnx')));
  loaded = { dir, tok, session, ort };
  return loaded;
}

// mean-pooled, normalised sentence vector (all-MiniLM-L6-v2 style)
async function embed(m, text) {
  const ids = m.tok.encode(String(text)).ids.slice(0, 128);
  const n = ids.length;
  const big = (a) => BigInt64Array.from(a, (x) => BigInt(x));
  const feeds = {
    input_ids: new m.ort.Tensor('int64', big(ids), [1, n]),
    attention_mask: new m.ort.Tensor('int64', big(ids.map(() => 1)), [1, n]),
  };
  if (m.session.inputNames.includes('token_type_ids')) feeds.token_type_ids = new m.ort.Tensor('int64', big(ids.map(() => 0)), [1, n]);
  const out = await m.session.run(feeds);
  const h = out[m.session.outputNames[0]];
  const d = h.dims[2];
  const v = new Float32Array(d);
  for (let i = 0; i < n; i++) for (let j = 0; j < d; j++) v[j] += h.data[i * d + j] / n;
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  for (let j = 0; j < d; j++) v[j] /= norm;
  return v;
}

parentPort.on('message', async ({ id, model, texts }) => {
  try {
    const m = await load(model);
    const vectors = [];
    for (const t of texts) vectors.push(Array.from(await embed(m, t)));
    parentPort.postMessage({ id, vectors });
  } catch (e) {
    parentPort.postMessage({ id, error: String(e && e.message || e) });
  }
});
