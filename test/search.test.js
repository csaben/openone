const test = require('node:test');
const assert = require('node:assert');
const { filter } = require('../src/ui/search');

const panes = [
  { key: 'a', label: 'rl-apex', kind: 'claude', host: 'desk', title: 'train the v3 policy', summary: '' },
  { key: 'b', label: 'shop', kind: 'claude', host: 'box', title: '', summary: 'Three tiers render side by side on the pricing page.' },
  { key: 'c', label: 'Code', kind: 'codex', host: 'desk', title: '', summary: '' },
  { key: 'd', label: 'apex-tools', kind: null, host: 'box', title: '', summary: '' },
];
const keys = (q) => filter(q, panes).map((p) => p.key);

test('search: name prefix beats a word in the summary', () => {
  assert.equal(keys('apex')[0], 'a');
  assert.deepEqual(keys('apex').sort(), ['a', 'd']);
});

test('search: letters in order find a name', () => {
  assert.equal(keys('rlx')[0], 'a');
});

test('search: words from the conversation find the agent', () => {
  assert.deepEqual(keys('pricing'), ['b']);
});

test('search: every word must match, across fields', () => {
  assert.deepEqual(keys('codex desk'), ['c']);
  assert.deepEqual(keys('codex box'), []);
});

test('search: an empty query keeps everything in order', () => {
  assert.deepEqual(keys('  '), ['a', 'b', 'c', 'd']);
});
