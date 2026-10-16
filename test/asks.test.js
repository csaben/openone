const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Asks, view } = require('../src/asks');

function setup(o = {}) {
  let t = 1000;
  const answered = [];
  const posted = [];
  const asks = new Asks({
    now: () => t, onAnswer: (a, delivered) => answered.push([a.id, a.answer, delivered]),
    post: async (url, body) => { posted.push([url, body]); }, ...o,
  });
  return { asks, answered, posted, tick: (ms) => { t += ms; } };
}

test('asks: options get ids, answers match by id, label or number', () => {
  const { asks } = setup();
  const a = asks.create({ title: 'Add Dentist Thu 3pm?', options: ['Add', 'Skip'], from: 'hermes' });
  assert.deepEqual(a.options, [{ id: 'add', label: 'Add' }, { id: 'skip', label: 'Skip' }]);
  assert.equal(asks.answer(a.id, 'Add').answer, 'add');
  const b = asks.create({ title: 'x', options: ['Add', 'Skip'] });
  assert.equal(asks.answer(b.id, '2').answerLabel, 'Skip');
  const c = asks.create({ title: 'x', options: [{ id: 'once', label: 'Allow once' }, 'Deny'] });
  assert.equal(asks.answer(c.id, 'once').answerLabel, 'Allow once');
  assert.throws(() => asks.answer(c.id, 'once'), /already answered: Allow once/);
  const d = asks.create({ title: 'x', options: ['A', 'B'] });
  assert.throws(() => asks.answer(d.id, 'C'), /not one of: A, B/);
});

test('asks: bad input is refused', () => {
  const { asks } = setup();
  assert.throws(() => asks.create({}), /title/);
  assert.throws(() => asks.create({ title: 'x', options: ['1', '2', '3', '4', '5'] }), /at most 4/);
  assert.throws(() => asks.create({ title: 'x', options: ['Same', 'same'] }), /differ/);
  assert.throws(() => asks.create({ title: 'x', options: ['A'], default: 'B' }), /default/);
  assert.throws(() => asks.create({ title: 'x', callback: 'file:///etc/passwd' }), /http/);
  assert.deepEqual(asks.create({ title: 'note' }).options, [{ id: 'ok', label: 'OK' }]);
});

test('asks: expiry applies the default, or marks it expired', () => {
  const { asks, answered, tick } = setup();
  const undo = asks.create({ title: 'Added Dentist Thu 3pm', options: ['Keep', 'Undo'], default: 'Keep', ttlSec: 60 });
  const plain = asks.create({ title: 'x', options: ['A', 'B'], ttlSec: 60 });
  tick(59000);
  asks.sweep();
  assert.equal(undo.status, 'pending');
  tick(2000);
  asks.sweep();
  assert.equal(undo.status, 'answered');
  assert.equal(undo.answer, 'keep');
  assert.equal(undo.by, 'default');
  assert.equal(plain.status, 'expired');
  assert.deepEqual(answered.map((x) => x[1]), ['keep', null]);
});

test('asks: one pending ask per tag', () => {
  const { asks } = setup();
  const a = asks.create({ title: 'key for fast-is-slow?', tag: 'ac:r_1', options: ['Allow', 'Deny'] });
  assert.equal(asks.create({ title: 'again', tag: 'ac:r_1' }).id, a.id);
  asks.answer(a.id, 'Deny');
  assert.notEqual(asks.create({ title: 'again', tag: 'ac:r_1' }).id, a.id);
});

test('asks: a waiter gets the answer; then it counts as delivered', async () => {
  const { asks, answered } = setup();
  const a = asks.create({ title: 'x', options: ['A', 'B'] });
  const w = asks.wait(a.id, 5000);
  asks.answer(a.id, 'B', 'phone');
  const got = await w;
  assert.equal(got.answer, 'b');
  assert.equal(got.by, 'phone');
  assert.deepEqual(answered, [[a.id, 'b', true]]);
  const b = asks.create({ title: 'y', options: ['A'] });
  assert.equal((await asks.wait(b.id, 10)).status, 'pending'); // timed out, still pending
  asks.answer(b.id, 'A');
  assert.deepEqual(answered[1], [b.id, 'a', false]); // nobody waiting: the server types it in
});

test('asks: callback gets the answer, without internal fields', async () => {
  const { asks, posted } = setup();
  const a = asks.create({ title: 'x', options: ['A'], callback: 'http://127.0.0.1:9/cb', fromKey: 'h|s|%1' });
  asks.answer(a.id, 'A');
  assert.equal(posted.length, 1);
  assert.equal(posted[0][0], 'http://127.0.0.1:9/cb');
  assert.equal(posted[0][1].answer, 'a');
  assert.equal('fromKey' in posted[0][1], false);
  assert.equal('callback' in view(a), false);
});

test('asks: pending ones survive a restart', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'asks-')), 'asks.json');
  const one = new Asks({ file });
  const a = one.create({ title: 'still waiting', options: ['Yes', 'No'] });
  const two = new Asks({ file });
  assert.equal(two.get(a.id).title, 'still waiting');
  assert.equal(two.pending().length, 1);
});
