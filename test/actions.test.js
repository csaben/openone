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
