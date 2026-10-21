const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Saved, docText } = require('../src/saved');

const post = (id, extra = {}) => ({ id, handle: 'someone', name: 'Some One', text: `post ${id}`, created_at: 'Mon Oct 19 03:08:00 +0000 2026', urls: [], media: [], ...extra });
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'saved-'));

test('bookmarks and likes are kept apart, newest first, and a post can be in both', () => {
  const s = new Saved({ dir: dir() });
  s.ingest({ tweets: [post('3'), post('2'), post('1')], kind: 'bookmark' });
  s.ingest({ tweets: [post('2'), post('9')], kind: 'like' });
  assert.deepStrictEqual(s.list('bookmark').map((b) => b.id), ['3', '2', '1']);
  assert.deepStrictEqual(s.list('like').map((b) => b.id), ['2', '9']);
  // all: bookmarks, then the likes that aren't bookmarked
  assert.deepStrictEqual(s.list('all').map((b) => b.id), ['3', '2', '1', '9']);
  assert.deepStrictEqual(s.list('all').find((b) => b.id === '2').kinds, ['bookmark', 'like']);
});

test('a catch-up from the top goes in front; the order flips', () => {
  const s = new Saved({ dir: dir() });
  s.ingest({ tweets: [post('2'), post('1')] });
  s.ingest({ tweets: [post('4'), post('3'), post('2')], front: true });
  assert.deepStrictEqual(s.recent().results.map((b) => b.id), ['4', '3', '2', '1']);
  assert.deepStrictEqual(s.recent({ order: 'oldest', n: 2 }).results.map((b) => b.id), ['1', '2']);
  assert.strictEqual(s.recent().total, 4);
});

test('a thread read later updates the saved post, and it survives a restart', () => {
  const d = dir();
  const s = new Saved({ dir: d });
  s.ingest({ tweets: [post('1')] });
  assert.deepStrictEqual(s.todo().map((t) => t.id), ['1']);
  s.ingest({ tweets: [{ id: '1', thread_checked: true, replies: [{ text: 'the paper', urls: [{ url: 'https://example.com/paper' }] }] }] });
  const again = new Saved({ dir: d });
  assert.deepStrictEqual(again.todo(), []);
  const b = again.list()[0];
  assert.strictEqual(b.text, 'post 1');
  assert.deepStrictEqual(b.links, ['https://example.com/paper']);
  assert.match(docText(b), /the paper/);
});

test('search ranks by meaning with a nudge for literal words', async () => {
  // a stand-in embedder: one dimension per topic word
  const topics = ['kernel', 'design'];
  const vec = (t) => { const v = topics.map((w) => (t.toLowerCase().includes(w) ? 1 : 0)); const n = Math.hypot(...v) || 1; return v.map((x) => x / n); };
  const s = new Saved({ dir: dir(), embedder: { vectors: async (ts) => ts.map(vec) } });
  s.ingest({ tweets: [post('1', { text: 'a design library' }), post('2', { text: 'fast triton kernel' })] });
  const r = await s.search('kernel');
  assert.strictEqual(r[0].id, '2');
  assert.ok(r[0].score > r[1].score);
});
