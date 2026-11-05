const test = require('node:test');
const assert = require('node:assert');
const { parseTabs, pick, commandLine } = require('../src/macterm');

const row = (...v) => v.join('\u001f');
const tabs = parseTabs([
  row(11, 1, 'true', 'true', 'true', '/dev/ttys001', ' login -zsh  arelius — -zsh — 80×24'),
  row(11, 2, 'false', 'true', 'true', '/dev/ttys002', ' login -zsh tmux'),
  row(22, 1, 'true', 'false', 'true', '/dev/ttys003', 'gpu-box login ssh gpu-box'),
  'junk',
].join('\n'));

test('macterm: tabs parse, junk lines dropped', () => {
  assert.equal(tabs.length, 3);
  assert.deepEqual(tabs[0], { window: 11, index: 1, selected: true, front: true, fg: true, tty: '/dev/ttys001', title: 'login -zsh  arelius — -zsh — 80×24' });
  assert.deepEqual(parseTabs('@@OFF'), []);
});

test('macterm: a tab is found by its programs or title, then by position', () => {
  assert.equal(pick(tabs, 'tmux').index, 2);
  assert.equal(pick(tabs, '^nope$|gpu-box').window, 22);
  assert.equal(pick(tabs, 'nope', 1).index, 2);
  assert.equal(pick(tabs, 'nope'), undefined);
  assert.equal(pick(tabs, '(bad', 0).index, 1);
});

test('macterm: the tab already showing wins', () => {
  assert.equal(pick(tabs, 'login').window, 11);
  assert.equal(pick(tabs, 'login').index, 1);
});

test('macterm: a tty beats a title, and an unknown one falls back to it', () => {
  assert.equal(pick(tabs, 'gpu-box', undefined, '/dev/ttys002').index, 2);
  assert.equal(pick(tabs, 'gpu-box', undefined, '/dev/ttys999').window, 22);
});

test('macterm: command lines survive the shell', () => {
  assert.equal(commandLine(['tmux', 'attach', '-t', 'my work']), "tmux attach -t 'my work'");
  assert.equal(commandLine(['ssh', "'a b'"]), "ssh ''\\''a b'\\'''");
});
