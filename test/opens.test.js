const test = require('node:test');
const assert = require('node:assert');
const { Opens } = require('../src/opens');

test('opens: no desktop polling, nothing to open it on', () => {
  const o = new Opens();
  assert.throws(() => o.add({ target: { host: 'a', folder: 'x' } }), /no openone desktop/);
});

test('opens: the desktop you touched last gets it, once', () => {
  let t = 1000000;
  const o = new Opens({ now: () => t });
  o.seen('desk', 5 * 60000); // away five minutes
  o.seen('laptop', 2000);
  const it = o.add({ target: { host: 'a', folder: 'x' }, from: 'me@a' });
  assert.deepEqual(o.take('desk'), []);
  assert.deepEqual(o.take('laptop'), [{ id: it.id, target: { host: 'a', folder: 'x' }, from: 'me@a' }]);
  assert.deepEqual(o.take('laptop'), []);
  // a desktop that stopped polling doesn't count
  t += 80000;
  o.seen('desk', 0);
  assert.equal(o.target(), 'desk');
});

test('opens: the caller gets the desktop\'s report, or the state after the wait', async () => {
  const o = new Opens();
  o.seen('desk', 0);
  const a = o.add({ target: { host: 'a', dir: '/x' } });
  const pending = o.result(a.id, 5000);
  o.take('desk');
  o.done(a.id, { ok: false, error: 'no code' });
  const r = await pending;
  assert.equal(r.status, 'failed');
  assert.equal(r.error, 'no code');
  const b = o.add({ target: { host: 'a', dir: '/y' } });
  assert.equal((await o.result(b.id, 20)).status, 'queued');
});
