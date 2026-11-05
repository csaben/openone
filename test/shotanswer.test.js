const test = require('node:test');
const assert = require('node:assert');
const { answerAfter } = require('../src/shotanswer');

const M = '[screen, from the hotkey]';

test('the messages after the marker, without tool calls', () => {
  const screen = [
    '> older question',
    '● old answer',
    `> ${M} why does this fail`,
    '  (their screen when they asked: C:\\x.png)',
    '',
    '● Read(C:\\x.png)',
    '  ⎿  Read image (120KB)',
    '',
    "● It's the shapes: A is (r, in) and you built it (in, r).",
    '  See https://claude.ai/artifact/abc123 for the walkthrough.',
    '',
    '● Bash(ls)',
    '  ⎿  file',
    '● Fix the transpose and rerun.',
    '',
    '✻ Baked for 12s · done 1:40 PM',
    '────────────────────────',
    '❯ ',
  ].join('\n');
  assert.strictEqual(answerAfter(screen, M),
    "It's the shapes: A is (r, in) and you built it (in, r).\nSee https://claude.ai/artifact/abc123 for the walkthrough.\n\nFix the transpose and rerun.");
});

test('nothing yet', () => {
  assert.strictEqual(answerAfter(`> ${M} hi\n\n✻ Thinking…`, M), '');
  assert.strictEqual(answerAfter('no marker here', M), '');
});
