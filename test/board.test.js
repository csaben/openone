const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Board } = require('../src/board');

const el = (id, version, o = {}) => ({ id, type: 'rectangle', x: 0, y: 0, width: 10, height: 10, version, versionNonce: 5, ...o });

test('board: edits merge per element, newest version wins', () => {
  const b = new Board();
  b.merge([el('a', 1), el('b', 1)]);
  b.merge([el('a', 3, { x: 30 }), el('b', 0, { x: 99 })]);
  const s = b.scene();
  assert.equal(s.elements.find((e) => e.id === 'a').x, 30);
  assert.equal(s.elements.find((e) => e.id === 'b').x, 0); // older version ignored
  b.merge([el('a', 3, { x: 7, versionNonce: 1 })]); // same version, lower nonce wins (Excalidraw's tie-break)
  assert.equal(b.scene().elements.find((e) => e.id === 'a').x, 7);
  assert.equal(b.merge([{ nope: 1 }, null]), 0);
});

test('board: clear deletes everything as a newer version, so it merges everywhere', () => {
  const b = new Board();
  b.merge([el('a', 2)]);
  b.clear();
  const a = b.scene().elements[0];
  assert.equal(a.isDeleted, true);
  assert.equal(a.version, 3);
  b.merge([el('a', 2)]); // a stale copy from another page doesn't bring it back
  assert.equal(b.live().length, 0);
});

test('board: an agent op is claimed once, and its waiter hears when it is drawn', async () => {
  let t = 1000;
  const b = new Board({ now: () => t });
  const op = b.addOp({ from: 'recipe-api@devbox', elements: [{ type: 'rectangle', x: 0, y: 0 }] });
  assert.equal(b.scene().ops.length, 1);
  assert.equal(b.claim(op.id), true);
  assert.equal(b.claim(op.id), false); // someone else has it
  t += 21000;
  assert.equal(b.claim(op.id), true); // that claim lapsed
  const w = b.waitOp(op.id, 5000);
  b.finish([op.id], { [op.id]: { ids: ['x1'] } });
  assert.deepEqual(await w, { status: 'drawn', ids: ['x1'] });
  assert.equal(b.scene().ops.length, 0);
  assert.deepEqual(await b.waitOp('other', 10), { status: 'queued' });
  assert.throws(() => b.addOp({}), /draw what/);
});

test('board: the summary says what is where, labels and arrows included', () => {
  const b = new Board();
  b.merge([
    el('r1', 1, { x: 100, y: 50, width: 200, height: 80 }),
    { id: 't1', type: 'text', text: 'Login', containerId: 'r1', x: 0, y: 0, width: 1, height: 1, version: 1 },
    el('r2', 1, { x: 400, y: 50 }),
    { id: 'a1', type: 'arrow', x: 300, y: 90, width: 100, height: 0, version: 1, startBinding: { elementId: 'r1' }, endBinding: { elementId: 'r2' } },
    { id: 'n', type: 'text', text: 'fix this', x: 5, y: 5, width: 40, height: 20, version: 1 },
  ]);
  const s = b.summary();
  assert.match(s, /rectangle r1 at \(100, 50\) 200x80: "Login"/);
  assert.match(s, /arrow a1 .* from rectangle r1 "Login" to rectangle r2/);
  assert.match(s, /text n .*: "fix this"/);
  assert.doesNotMatch(s, /text t1/);
  assert.equal(new Board().summary(), 'The board is empty.');
});

test('board: kept on disk, snapshot included', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-'));
  const b = new Board({ dir });
  b.merge([el('a', 1)], { f1: { mimeType: 'image/png', dataURL: 'data:image/png;base64,AAAA' }, bad: { dataURL: 'javascript:1' } });
  b.setSnapshot(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]), b.version);
  const again = new Board({ dir });
  assert.equal(again.live().length, 1);
  assert.deepEqual(Object.keys(again.files), ['f1']);
  assert.equal(again.snapshot().png.length, 10);
});

test('board: elements come back in drawing order (fractional index), so a pinned screenshot stays behind', () => {
  const b = new Board();
  b.merge([el('stroke', 1, { index: 'a1' }), el('later', 1), el('shot', 1, { index: 'a0' }), el('top', 1, { index: 'a2' })]);
  assert.deepEqual(b.scene().elements.map((e) => e.id), ['shot', 'stroke', 'top', 'later']);
  assert.deepEqual(new Board().ordered(), []);
  // "Zz" < "a0" in plain string order, as Excalidraw's keys expect
  b.merge([el('first', 1, { index: 'Zz' })]);
  assert.equal(b.scene().elements[0].id, 'first');
});
