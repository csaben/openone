const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { detect } = require('../src/detect');

const fx = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

test('permission prompt is input with numbered options', () => {
  const r = detect(fx('claude-permission.txt'));
  assert.equal(r.kind, 'claude');
  assert.equal(r.state, 'input');
  assert.equal(r.question, 'Do you want to proceed?');
  assert.deepEqual(r.options.map((o) => o.n), [1, 2, 3, 4]);
  assert.equal(r.options[0].label, 'Yes');
  assert.equal(r.options[3].label, 'No');
  assert.equal(r.topic, 'Bash command');
  assert.equal(r.detail, 'echo openone-fixture > out.txt');
});

test('AskUserQuestion menu keeps question, recommended flag, drops free-text rows', () => {
  const r = detect(fx('claude-ask.txt'));
  assert.equal(r.state, 'input');
  assert.equal(r.question, 'Which pricing layout do you want?');
  assert.deepEqual(r.options.map((o) => o.label), ['Three tiers + yearly toggle', 'Single plan', 'Comparison table']);
  assert.equal(r.options[0].recommended, true);
  assert.equal(r.topic, 'Pricing');
});

test('spinner footer is working', () => {
  assert.equal(detect(fx('claude-working.txt')).state, 'working');
  assert.equal(detect(fx('claude-working-tool.txt')).state, 'working');
  assert.equal(detect(fx('claude-working-nohint.txt')).state, 'working'); // newer Claude Code: no "esc to interrupt"
});

test('finished turn is idle with summary and finish time', () => {
  const r = detect(fx('claude-idle-done.txt'));
  assert.equal(r.kind, 'claude');
  assert.equal(r.state, 'idle');
  assert.equal(r.doneAt, '10:39 AM');
  assert.match(r.summary, /pricing page/);
  const fresh = detect(fx('claude-idle-fresh.txt'));
  assert.equal(fresh.state, 'idle');
  assert.match(fresh.summary, /^I ran echo openone-fixture/);
});

test('codex approval is input', () => {
  const r = detect(fx('codex-approval.synthetic.txt'), { command: 'codex' });
  assert.equal(r.kind, 'codex');
  assert.equal(r.state, 'input');
  assert.equal(r.question, 'Would you like to run the following command?');
  assert.equal(r.options[0].label, 'Yes, proceed');
});

test('numbered list in a finished message is not a menu', () => {
  const text = "● Options:\n  1. foo\n  2. bar\n\n✻ Baked for 3s · done 1:00 PM\n────────────\n❯ \n────────────\n  ⏵⏵ bypass permissions on (shift+tab to cycle)\n";
  assert.equal(detect(text).state, 'idle');
});

test('plain shell is not an agent', () => {
  assert.equal(detect('PS D:\Code> ls\n\n    Directory: D:\Code\n').state, 'shell');
});

test('findMenu stays fast on long, space-padded numbered lines', () => {
  const { detect } = require('../src/detect');
  const line = `  1. ${'word '.repeat(30)}${' '.repeat(200)}`;
  const screen = ['╭──', ...Array(40).fill(line), '❯ ', '──────', '  ? for shortcuts'].join('\n');
  const t = process.hrtime.bigint();
  for (let i = 0; i < 20; i++) detect(screen, { command: 'claude' });
  assert.ok(Number(process.hrtime.bigint() - t) / 1e6 < 200, 'took too long');
});
