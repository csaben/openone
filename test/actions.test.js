const test = require('node:test');
const assert = require('node:assert');
const { stillTyped } = require('../src/actions');

const rule = '─'.repeat(40);
const screen = (box, above = '● working on it') => [above, '', rule, ...box, rule, '  ⏵⏵ bypass permissions on'].join('\n');
const msg = '[ring] Put something on my calendar for the next hour and open Chrome on a video';

test('a message still in the input box, even wrapped, counts as unsent', () => {
  assert.ok(stillTyped(screen([`❯ ${msg.slice(0, 40)}`, `  ${msg.slice(40)}`]), msg));
});

test('a long message Claude Code folded into a paste marker counts as unsent', () => {
  assert.ok(stillTyped(screen(['❯ [Pasted text #1 +3 lines]']), msg));
});

test('an empty input box means it was sent, even with the message above it', () => {
  assert.ok(!stillTyped(screen(['❯ '], `❯ ${msg}`), msg));
});

test('a screen without the input box is left alone', () => {
  assert.ok(!stillTyped('PS D:\\Code> ', msg));
});

test('reply never presses Ctrl+C on an empty box (it kills background agents)', async () => {
  const { reply } = require('../src/actions');
  for (const [shown, draft] of [['❯ Try "fix typecheck errors"', false], ['❯ yeah post it', true]]) {
    const sent = [];
    let box = shown;
    const src = {
      text: async (_p, t) => { sent.push(`text ${t}`); box = t === '~' && !draft ? '❯ ~' : `${box}${t}`; },
      keys: async (_p, k) => { sent.push(`keys ${k.join(' ')}`); if (k[0] === 'C-c' || k[0] === 'Enter') box = '❯ '; },
      screen: async () => screen([box]),
    };
    await reply(src, { kind: 'claude', state: 'idle' }, 'hello');
    assert.deepStrictEqual(sent.slice(0, 2), ['text ~', draft ? 'keys C-c' : 'keys BSpace']);
    assert.ok(!sent.slice(2).includes('keys C-c'));
  }
});

test('the marker alone, even after a stale glyph, is an empty box', () => {
  const { inputBox, hasDraft } = require('../src/actions');
  assert.ok(!hasDraft(inputBox(screen(['❯ ~']))));
  assert.ok(!hasDraft(inputBox(screen(['❯f~']))));
  assert.ok(hasDraft(inputBox(screen(['❯ draft here~']))));
});
