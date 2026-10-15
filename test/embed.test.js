const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Embedder, cosine, semantic, projectText, agentText } = require('../src/embed');

// an embedder whose "model" is a bag of letters, so tests need no download
function fake(dir) {
  const e = new Embedder(dir);
  e.download = async () => {};
  e.calls = 0;
  e.run = async (texts) => {
    e.calls += texts.length;
    return texts.map((t) => {
      const v = new Array(26).fill(0);
      for (const ch of t.toLowerCase()) { const i = ch.charCodeAt(0) - 97; if (i >= 0 && i < 26) v[i]++; }
      const n = Math.hypot(...v) || 1;
      return v.map((x) => x / n);
    });
  };
  return e;
}

test('embed: vectors are cached by text, on disk too', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oo-embed-'));
  const e = fake(dir);
  await e.vectors(['alpha', 'beta']);
  await e.vectors(['alpha', 'beta', 'gamma']);
  assert.equal(e.calls, 3); // alpha and beta only once
  e.saveCache();
  await new Promise((r) => setTimeout(r, 2200));
  const again = fake(dir);
  const [v] = await again.vectors(['gamma']);
  assert.equal(again.calls, 0);
  assert.ok(Math.abs(cosine(v, v) - 1) < 1e-5);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('embed: semantic search scores projects and agents by id', async () => {
  const e = fake(fs.mkdtempSync(path.join(os.tmpdir(), 'oo-embed-')));
  const lists = [{ host: 'box', dirs: [{ name: 'photo-tidy', about: 'archive photos' }, { name: 'zzz', about: 'qqq' }] }];
  const panes = [{ key: 'box|s|%1', kind: 'claude', label: 'photo-tidy', title: 'archive photos' }, { key: 'box|s|%2', kind: null, label: 'shell' }];
  const r = await semantic(e, 'photo archive', lists, panes);
  assert.ok(r.projects['box|photo-tidy'] > 0.8);
  assert.equal(r.projects['box|zzz'], undefined); // below the floor
  assert.ok(r.agents['box|s|%1'] > 0.8);
  assert.equal(r.agents['box|s|%2'], undefined); // shells aren't agents
  assert.deepEqual(await semantic(e, '  ', lists, panes), { projects: {}, agents: {}, ready: true });
});

test('embed: what gets embedded', () => {
  assert.equal(projectText('photo-tidy', 'dedupe photos'), 'photo tidy: dedupe photos');
  assert.equal(agentText({ label: 'x', title: 'T', summary: 'S' }), 'x. T. S');
});
