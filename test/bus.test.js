const test = require('node:test');
const assert = require('node:assert');
const { Bus, names, typedLine, HOPS } = require('../src/bus');

function setup(panes) {
  const typed = [];
  let t = 1000;
  const monitor = { view: () => panes };
  const bus = new Bus({ monitor, deliver: async (p, text) => { typed.push([p.key, text]); }, now: () => t });
  return { bus, typed, tick: (ms) => { t += ms; } };
}
const pane = (key, label, o = {}) => {
  const [host, session, paneId] = key.split('|');
  return { key, host, session, paneId, windowIndex: '1', label, kind: 'claude', state: 'idle', ...o };
};
const flush = () => new Promise((r) => setImmediate(r));

test('bus: names are label@host, with the pane number when a label repeats', () => {
  const nm = names([pane('a|0|%1', 'Photo Tidy'), pane('a|0|%2', 'api', { windowIndex: '2' }), pane('a|0|%3', 'api', { windowIndex: '3' }), pane('b|s|%1', 'api')]);
  assert.deepEqual([...nm.values()], ['photo-tidy@a', 'api.2@a', 'api.3@a', 'api@b']);
  const twice = names([pane('a|0|%2', 'x'), pane('a|1|%2', 'x'), pane('a|1|%3', 'x')]);
  assert.deepEqual([...twice.values()], ['x.0.2@a', 'x.1.2@a', 'x.3@a']);
});

test('bus: typed into an idle agent, held while it works, signed by the sender', async () => {
  const panes = [pane('a|0|%1', 'one'), pane('b|s|%2', 'two', { state: 'working' })];
  const { bus, typed } = setup(panes);
  const me = bus.whoami({ host: 'A', pane: '%1', session: '0' });
  assert.equal(me.key, 'a|0|%1');
  const m = bus.send({ from: me, to: 'two@b', content: 'hi\nthere' });
  await flush();
  assert.equal(m.status, 'queued');
  assert.equal(typed.length, 0);
  panes[1].state = 'idle';
  await bus.pump();
  assert.equal(m.status, 'delivered');
  assert.equal(m.via, 'typed');
  assert.deepEqual(typed, [['b|s|%2', typedLine(m)]]);
  assert.match(typed[0][1], /^\[openone message from one@a .*to="one@a"\] hi ⏎ there$/);
});

test('bus: bare labels resolve when unique; unknown and self are refused', () => {
  const { bus } = setup([pane('a|0|%1', 'one'), pane('b|s|%2', 'two'), pane('b|s|%3', 'sh', { kind: null })]);
  assert.equal(bus.resolve('two').key, 'b|s|%2');
  assert.equal(bus.resolve('sh'), null); // shells aren't agents
  assert.throws(() => bus.send({ from: null, to: 'nobody', content: 'x' }), /no agent named/);
  const me = bus.whoami({ host: 'a', pane: '%1' });
  assert.throws(() => bus.send({ from: me, to: 'one@a', content: 'x' }), /that's you/);
});

test('bus: channel listeners get messages right away, even mid-turn', async () => {
  const panes = [pane('a|0|%1', 'one'), pane('b|s|%2', 'two', { state: 'working' })];
  const { bus, typed } = setup(panes);
  const got = [];
  const off = bus.listen('b|s|%2', (m) => got.push(m.content));
  const m = bus.send({ from: bus.whoami({ host: 'a', pane: '%1' }), to: 'two', content: 'ping' });
  await flush();
  assert.deepEqual(got, ['ping']);
  assert.equal(m.via, 'channel');
  assert.equal(typed.length, 0);
  off();
  assert.equal(bus.channels.size, 0);
});

test('bus: reply chains stop at the hop limit; the user stepping in resets them', async () => {
  const panes = [pane('a|0|%1', 'one'), pane('b|s|%2', 'two')];
  const { bus, tick } = setup(panes);
  const one = bus.whoami({ host: 'a', pane: '%1' });
  const two = bus.whoami({ host: 'b', pane: '%2' });
  let from = one;
  let to = 'two';
  for (let i = 0; i < HOPS; i++) {
    bus.send({ from, to, content: `m${i}` });
    await bus.pump();
    tick(1000);
    [from, to] = from === one ? [two, 'one'] : [one, 'two'];
  }
  assert.throws(() => bus.send({ from, to, content: 'again' }), /hop limit/);
  bus.touch(from.key);
  assert.doesNotThrow(() => bus.send({ from, to, content: 'fresh start' }));
});

test('bus: a gone or exited target fails the message', async () => {
  const panes = [pane('a|0|%1', 'one'), pane('b|s|%2', 'two', { state: 'working' })];
  const { bus } = setup(panes);
  const m = bus.send({ from: null, fromName: 'outside@x', to: 'two', content: 'x' });
  assert.equal(m.from, 'outside@x');
  panes[1].state = 'shell';
  await bus.pump();
  assert.equal(m.status, 'failed');
  assert.match(m.error, /exited/);
});

test('bus: a Codex caller is the Codex pane in its folder, the working one if several', () => {
  const panes = [
    pane('b|s|%1', 'x', { kind: 'codex', path: '/w/app' }),
    pane('b|s|%2', 'y', { kind: 'codex', path: '/w/app', state: 'working' }),
    pane('b|s|%3', 'z', { kind: 'codex', path: '/w/other' }),
    pane('b|s|%4', 'c', { kind: 'claude', path: '/w/other' }),
  ];
  const { bus } = setup(panes);
  assert.equal(bus.whoami({ host: 'b', thread: 't-1', cwd: '/w/other/' }).key, 'b|s|%3');
  assert.equal(bus.whoami({ host: 'b', thread: 't-2', cwd: '/w/app' }).key, 'b|s|%2');
  panes[1].state = 'idle';
  assert.equal(bus.whoami({ host: 'b', thread: 't-2', cwd: '/w/app' }).key, 'b|s|%2'); // remembered
  assert.equal(bus.whoami({ host: 'b', thread: 't-3', cwd: '/w/app' }), null); // two idle ones: can't tell
});
