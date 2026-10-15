const test = require('node:test');
const assert = require('node:assert');
const { LocalSource, FMT } = require('../src/sources');

// A fake psmux: one pane whose cursor moves on every poll, like a working agent.
function fake(type) {
  const src = new LocalSource({ type, stream: false });
  let tick = 0;
  src.captures = 0;
  src.batch = async (argvs) => argvs.map((a) => {
    if (a[0] === 'list-panes') {
      tick++;
      return ['%1', 's', '1', 'claude', '1', 'node', '/x', 't', '1', '1', '1', '100', '0', String(tick)].join('<|>');
    }
    src.captures++;
    return `screen ${tick}`;
  });
  return src;
}

test('psmux: a pane that changes every poll is captured at most every 4s', async () => {
  const src = fake('psmux');
  const realNow = Date.now;
  let t = 1_000_000;
  Date.now = () => t;
  try {
    for (let i = 0; i < 8; i++) { await src.snapshot(); t += 1500; } // 12s of 1.5s polls
  } finally { Date.now = realNow; }
  assert.equal(src.captures, 3); // t=0, t=4.5s, t=9s
});

test('tmux: changing panes are captured every poll', async () => {
  const src = fake('tmux');
  for (let i = 0; i < 5; i++) await src.snapshot();
  assert.equal(src.captures, 5);
});

test('format string has no spaces (it crosses cmd.exe for remote psmux)', () => {
  assert.ok(!/\s/.test(FMT));
});

test('psmux: the slow refresh re-reads one overdue pane per poll, not all at once', async () => {
  const src = new LocalSource({ type: 'psmux', refreshMs: 20000, stream: false });
  src.captures = 0;
  const row = (id) => [id, 's', '1', 'claude', '1', 'node', '/x', 't', '1', '1', '1', '100', '0', '5'].join('<|>');
  src.batch = async (argvs) => argvs.map((a) => {
    if (a[0] === 'list-panes') return ['%1', '%2', '%3', '%4', '%5'].map(row).join('\n');
    src.captures++;
    return 'idle screen';
  });
  const realNow = Date.now;
  let t = 1_000_000;
  Date.now = () => t;
  const perPoll = [];
  try {
    for (let i = 0; i < 20; i++) { const before = src.captures; await src.snapshot(); perPoll.push(src.captures - before); t += 1500; }
  } finally { Date.now = realNow; }
  assert.equal(perPoll[0], 5);                       // first poll reads everything once
  assert.ok(perPoll.slice(1).every((n) => n <= 1));   // after that, never a burst
  assert.ok(perPoll.slice(1).reduce((a, b) => a + b, 0) >= 5); // but every pane does get refreshed
});
