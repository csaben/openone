const test = require('node:test');
const assert = require('node:assert');
const { parseAgents, stateOf, screenText, Background } = require('../src/bg');

const LIST = JSON.stringify([
  { pid: 1, id: 'c9b4a42b', cwd: '/home/u/Code/x', kind: 'background', name: 'README.md setup', status: 'busy', state: 'blocked' },
  { pid: 2, cwd: '/home/u/Code/y', kind: 'interactive', name: 'y-1', status: 'idle' },
  { pid: 3, id: 'abcdef12', cwd: '/home/u/Code/z', kind: 'background', name: 'tests', status: 'busy' },
  { pid: 4, id: '; rm -rf ~', cwd: '/', kind: 'background', status: 'idle' },
]);

test('bg: only background sessions with safe ids are listed', () => {
  const list = parseAgents(`noise before\n${LIST}\n`);
  assert.deepEqual(list.map((a) => a.id), ['c9b4a42b', 'abcdef12']);
  assert.deepEqual(parseAgents('not json'), []);
});

test('bg: Claude status maps to openone state', () => {
  assert.equal(stateOf({ status: 'busy', state: 'blocked' }), 'input');
  assert.equal(stateOf({ status: 'busy' }), 'working');
  assert.equal(stateOf({ status: 'idle' }), 'idle');
});

test('bg: logs replay to the screen text', async () => {
  const text = await screenText('\x1b[2J\x1b[Hfirst\r\n\x1b[1mDo you want to proceed?\x1b[0m\r\n❯ 1. Yes', 40, 5);
  assert.deepEqual(text.split('\n').slice(0, 3), ['first', 'Do you want to proceed?', '❯ 1. Yes']);
});

test('bg: rows stand in for panes, and hide once opened in a bg-<id> window', async () => {
  const src = { claudeAgents: async () => LIST, claudeLogs: async () => 'screen' };
  const bg = new Background(src);
  const rows = await bg.rows([]);
  assert.deepEqual(rows.map((r) => [r.paneId, r.override.state, r.title]), [['bg:c9b4a42b', 'input', 'README.md setup'], ['bg:abcdef12', 'working', 'tests']]);
  const after = await bg.rows([{ windowName: 'bg-c9b4a42b' }]);
  assert.deepEqual(after.map((r) => r.bg), ['abcdef12']);
});
