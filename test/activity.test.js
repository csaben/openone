const test = require('node:test');
const assert = require('node:assert');
const { parseClaudeSessions } = require('../src/activity');

test('claude session files -> each pane\'s last status change, newest session per pane', () => {
  const files = [
    { tmux: '0:@3.%5', startedAt: 100, status: 'idle', statusUpdatedAt: 500, updatedAt: 500, name: 'old {x}' },
    { tmux: '0:@3.%5', startedAt: 900, status: 'idle', statusUpdatedAt: 950, updatedAt: 950 },
    { tmux: '0:@12.%22', startedAt: 10, status: 'busy', statusUpdatedAt: 20, updatedAt: 3000 },
    { cwd: 'C:\\x', startedAt: 1 },
  ].map((j) => JSON.stringify(j)).join('') + '{broken';
  const m = parseClaudeSessions(files);
  assert.equal(m.get('0|%5'), 950);
  assert.equal(m.get('0|%22'), 3000);
  assert.equal(m.size, 2);
});
