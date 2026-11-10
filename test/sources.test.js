const test = require('node:test');
const assert = require('node:assert');
const { LocalSource, FMT, createSource } = require('../src/sources');

// A fake psmux: one pane whose cursor moves on every poll, like a working agent.
function fake(type) {
  const src = new LocalSource({ type, stream: false, background: false });
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
  const src = new LocalSource({ type: 'psmux', refreshMs: 20000, stream: false, background: false });
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

test('focus with no terminal attached selects the pane and says nothing is showing it', async () => {
  const src = new LocalSource({ type: 'tmux', stream: false, background: false });
  const sent = [];
  src.batch = async (argvs) => argvs.map((a) => { sent.push(a[0]); return ''; });
  assert.strictEqual(await src.focus({ session: 's', windowIndex: '1', paneId: '%1' }), false);
  assert.deepStrictEqual(sent, ['list-clients', 'select-window', 'select-pane']);
});

test('a new terminal tab attaches to the session, over ssh for remote hosts', () => {
  const { SshTmuxSource } = require('../src/sources');
  assert.deepStrictEqual(new LocalSource({ type: 'psmux' }).attachArgv('main'), ['psmux', 'attach', '-t', 'main']);
  const remote = new SshTmuxSource({ ssh: 'me@box', sshBin: 'ssh' });
  assert.deepStrictEqual(remote.attachArgv('work'), ['ssh', '-t', 'me@box', 'tmux', 'attach', '-t', "'work'"]);
  // no ";": Windows Terminal would split the command line there into a second tab
  const mac = new SshTmuxSource({ ssh: 'me@mac', sshBin: 'ssh', path: '/opt/homebrew/bin' });
  assert.deepStrictEqual(mac.attachArgv('work'), ['ssh', '-t', 'me@mac', 'env', 'PATH=/opt/homebrew/bin:$PATH', 'tmux', 'attach', '-t', "'work'"]);
});

test('ownClient: clients this computer opened are marked, and found again through ps', async () => {
  const src = createSource({ type: 'ssh', ssh: 'x', ownClient: true });
  assert.deepStrictEqual(src.attachArgv('main').slice(3), ['tmux', 'attach', '-f', 'no-detach-on-destroy', '-t', "'main'"]);
  src.exec = async () => 'pts/5 tmux attach -f no-detach-on-destroy -t trident\n?? grep -F attach -f no-detach-on-destroy\nttys001 tmux attach -f no-detach-on-destroy\n';
  assert.deepStrictEqual([...await src.ownTtys()], ['/dev/pts/5', '/dev/ttys001']);
});

test('focus: a client attached from elsewhere is left alone', async () => {
  const src = createSource({ type: 'tmux', name: 't' });
  const sent = [];
  src.batch = async (cmds) => { sent.push(...cmds); return cmds.map(() => ''); };
  src.realClients = async () => [{ name: '/dev/ttys001', session: 'b', recent: 0, flags: '' }, { name: '/dev/ttys004', session: 'a', recent: 5, flags: '' }];
  assert.equal(await src.focus({ session: 'c', windowIndex: '0', paneId: '%1' }, new Set(['/dev/ttys004'])), true);
  assert.deepStrictEqual(sent[0], ['switch-client', '-c', '/dev/ttys004', '-t', 'c']);
  assert.equal(await src.focus({ session: 'c', windowIndex: '0', paneId: '%1' }, new Set()), false);
  assert.equal(await src.clientTty('b', new Set(['/dev/ttys004'])), '');
});
