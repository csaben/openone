const test = require('node:test');
const assert = require('node:assert');
const { Trigger, Capture, label } = require('../src/voice');

const down = (keycode) => ({ type: 'keydown', keycode });
const up = (keycode) => ({ type: 'keyup', keycode });
const mdown = (button) => ({ type: 'mousedown', button });
const mup = (button) => ({ type: 'mouseup', button });
const CTRL = 29;
const SHIFT = 42;
const SPACE = 57;

test('voice: a key combo presses once all of it is held and releases when any part lets go', () => {
  const t = new Trigger({ keys: [CTRL, SHIFT, SPACE] });
  assert.equal(t.feed(down(CTRL)), null);
  assert.equal(t.feed(down(SPACE)), null); // Shift isn't down yet
  assert.equal(t.feed(down(SHIFT)), 'press');
  assert.equal(t.feed(down(SPACE)), null); // key repeat
  assert.equal(t.feed(down(30)), null); // other keys don't matter
  assert.equal(t.feed(up(30)), null);
  assert.equal(t.feed(up(SHIFT)), 'release');
  assert.equal(t.feed(up(SPACE)), null);
  assert.equal(t.feed(down(SHIFT)), null); // Space is up again
  assert.equal(t.feed(down(SPACE)), 'press');
});

test('voice: right-hand modifiers count as the left ones', () => {
  const t = new Trigger({ keys: [CTRL, SPACE] });
  assert.equal(t.feed(down(3613)), null); // CtrlRight
  assert.equal(t.feed(down(SPACE)), 'press');
  assert.equal(t.feed(up(3613)), 'release');
});

test('voice: a mouse button, alone or with keys held', () => {
  const t = new Trigger({ keys: [], button: 5 });
  assert.equal(t.feed(mdown(1)), null);
  assert.equal(t.feed(mdown(5)), 'press');
  assert.equal(t.feed(mup(5)), 'release');
  const c = new Trigger({ keys: [CTRL], button: 4 });
  assert.equal(c.feed(mdown(4)), null);
  assert.equal(c.feed(mup(4)), null);
  c.feed(down(CTRL));
  assert.equal(c.feed(mdown(4)), 'press');
  assert.equal(new Trigger(null).feed(down(CTRL)), null);
});

test('voice: capturing takes the keys held together, or a side mouse button', () => {
  let c = new Capture();
  c.feed(down(CTRL));
  c.feed(down(SHIFT));
  c.feed(down(SPACE));
  assert.equal(c.feed(up(SPACE)), null); // still holding the others
  c.feed(up(CTRL));
  assert.deepEqual(c.feed(up(SHIFT)), { trigger: { keys: [CTRL, SHIFT, SPACE], button: 0 } });
  c = new Capture();
  c.feed(down(CTRL));
  assert.equal(c.feed(mdown(1)), null); // a plain click isn't a trigger
  assert.deepEqual(c.feed(mdown(5)), { trigger: { keys: [CTRL], button: 5 } });
  assert.deepEqual(new Capture().feed(down(1)), { cancel: true }); // Esc
  c = new Capture();
  c.feed(down(30));
  assert.match(c.feed(up(30)).error, /A alone would fire/);
  c.feed(down(3613));
  assert.match(c.feed(up(3613)).error, /Ctrl alone/);
  c.feed(down(91)); // F13 alone is fine
  assert.deepEqual(c.feed(up(91)), { trigger: { keys: [91], button: 0 } });
});

test('voice: labels read like shortcuts, modifiers first', () => {
  assert.equal(label({ keys: [SPACE, SHIFT, CTRL] }), 'Ctrl + Shift + Space');
  assert.equal(label({ keys: [CTRL], button: 5 }), 'Ctrl + Mouse forward');
  assert.equal(label({ keys: [], button: 4 }), 'Mouse back');
  assert.equal(label(null), 'Not set');
  assert.equal(label({ keys: [59] }), 'F1');
});
