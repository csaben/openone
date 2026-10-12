const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const C = require('../server/web/chat');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const types = (text) => C.blocks(C.screen(text)).map((b) => b.type);

test('ansi: colors, bold and links become segments', () => {
  const [segs] = C.parseAnsi('\x1b[38;5;246m●\x1b[39m \x1b[1mBold\x1b[0m \x1b]8;;https://x.test\x1b\\link\x1b]8;;\x1b\\');
  assert.equal(C.plain(segs), '● Bold link');
  assert.equal(segs[0].fg, 246);
  assert.ok(segs.find((s) => s.t === 'Bold').b);
  assert.equal(segs.find((s) => s.t === 'link').link, 'https://x.test');
});

test('chat: prompts, replies, tools and status are told apart', () => {
  assert.deepEqual(types(fixture('claude-idle-done.txt')).slice(0, 2), ['reply', 'status']);
  const ask = types(fixture('claude-ask.txt'));
  assert.ok(ask.includes('tool') && ask.includes('reply') && ask.includes('user') && ask.includes('status'));
});

test('chat: the input box and menus under the last rule are left out', () => {
  const html = C.chat(fixture('claude-ask.txt'));
  assert.ok(html.includes('pricing layout'));       // the prompt that asked
  assert.ok(!html.includes('Single plan'));          // not the menu itself
  assert.ok(!html.includes('Enter to select'));
  assert.ok(!C.chat(fixture('claude-idle-done.txt')).includes('jk'));  // the draft in the input box
});

test('chat: lines the terminal wrapped are joined, short lines are not', () => {
  const long = 'word '.repeat(12).trim(); // fills the 61-column screen
  const text = [`● ${long}`, '  continues here.', '', '  Short line.', '  Next line.', '', '  - item one', '  - item two'].join('\n');
  const html = C.chat(text);
  assert.ok(html.includes(`${long} continues here`), html);
  assert.ok(html.includes('Short line.</p><p>Next line'), html);
  assert.equal((html.match(/class="li"/g) || []).length, 2);
});

test('chat: a side panel drawn after a vertical bar is cut off', () => {
  const rows = Array.from({ length: 8 }, (_, i) => `● reply line ${i}`.padEnd(50) + '│ panel text');
  const html = C.chat(rows.join('\n'));
  assert.ok(!html.includes('panel text'));
});

test('chat: keyboard hints are dropped', () => {
  const html = C.chat('● Read(x.js)\n  ⎿  Read 3 lines (ctrl+o to expand)\n');
  assert.ok(!html.includes('ctrl+o'));
});
