const test = require('node:test');
const assert = require('node:assert');
const { MacTerminal, parseTabs, pick, commandLine, appsFor, inLoginShell } = require('../src/macterm');

const row = (...v) => v.join('\u001f');
const tabs = parseTabs([
  row(11, 1, 'true', 'true', 'true', '/dev/ttys001', 'Terminal', ' login -zsh  arelius — -zsh — 80×24'),
  row(11, 2, 'false', 'true', 'true', '/dev/ttys002', 'Terminal', ' login -zsh tmux'),
  row(22, 1, 'true', 'false', 'true', '/dev/ttys003', 'gpu-box', 'gpu-box login ssh gpu-box'),
  'junk',
].join('\n'));

test('macterm: tabs parse, junk lines dropped', () => {
  assert.equal(tabs.length, 3);
  assert.deepEqual(tabs[0], { target: '11', index: 1, selected: true, front: true, fg: true, tty: '/dev/ttys001', label: 'Terminal', title: 'login -zsh  arelius — -zsh — 80×24' });
  assert.deepEqual(parseTabs('@@OFF'), []);
});

test('macterm: a tab is found by its programs or title, then by position', () => {
  assert.equal(pick(tabs, 'tmux').index, 2);
  assert.equal(pick(tabs, '^nope$|gpu-box').target, '22');
  assert.equal(pick(tabs, 'nope', 1).index, 2);
  assert.equal(pick(tabs, 'nope'), undefined);
  assert.equal(pick(tabs, '(bad', 0).index, 1);
});

test('macterm: the tab already showing wins', () => {
  assert.equal(pick(tabs, 'login').target, '11');
  assert.equal(pick(tabs, 'login').index, 1);
});

test('macterm: a tty beats a title, and an unknown one falls back to it', () => {
  assert.equal(pick(tabs, 'gpu-box', undefined, '/dev/ttys002').index, 2);
  assert.equal(pick(tabs, 'gpu-box', undefined, '/dev/ttys999').target, '22');
});

test('macterm: the name openone gave a tab beats a title, and a tty beats both', () => {
  assert.equal(pick(tabs, 'login', undefined, '', 'gpu-box').target, '22');
  assert.equal(pick(tabs, 'nope', undefined, '/dev/ttys002', 'gpu-box').index, 2);
  assert.equal(pick(tabs, '^nope$', undefined, '', 'nobody'), undefined);
});

test('macterm: command lines survive the shell', () => {
  assert.equal(commandLine(['tmux', 'attach', '-t', 'my work']), "tmux attach -t 'my work'");
  assert.equal(commandLine(['ssh', "'a b'"]), "ssh ''\\''a b'\\'''");
});

test('macterm: new tabs go to Ghostty when it is there, and panes are looked for in both', () => {
  assert.deepEqual(appsFor(true).map((a) => a.name), ['Ghostty', 'Terminal']);
  assert.deepEqual(appsFor(false).map((a) => a.name), ['Terminal']);
});

test('macterm: Ghostty ids stay text, and its commands get a login shell', () => {
  const [t] = parseTabs(row('7F9C-BD3B', 1, 'true', 'true', 'true', '/dev/ttys004', '', 'tmux tmux'));
  assert.equal(t.target, '7F9C-BD3B');
  assert.match(inLoginShell("tmux attach -t 'a b'"), / -lc 'tmux attach -t '\\''a b'\\'''$/);
});

// a fake osascript: answers by which script it was handed
const fake = (answers) => {
  const calls = [];
  const run = async (script, args = []) => { const [name, out] = answers.find(([, , match]) => script === match) || ['?', '']; calls.push(`${name} ${args.join(' ')}`.trim()); if (out instanceof Error) throw out; return out; };
  return { run, calls };
};
const [G, T] = appsFor(true);

test('macterm: a tty goes straight to its tab, without listing anything', async () => {
  const f = fake([['g', '', G.byTty], ['t', 'ok', T.byTty]]);
  assert.deepEqual(await new MacTerminal([G, T], f.run).focus('tmux', 0, '/dev/ttys001', 'host'), { ok: true });
  assert.deepEqual(f.calls, ['g /dev/ttys001', 't /dev/ttys001']);
});

test('macterm: a tty no tab has is not guessed from titles', async () => {
  const f = fake([['g', '', G.byTty], ['t', '', T.byTty], ['list', 'x', G.list]]);
  const r = await new MacTerminal([G, T], f.run).focus('tmux', 0, '/dev/ttys001', 'host');
  assert.equal(r.ok, false);
  assert.ok(!f.calls.includes('list'));
});

test('macterm: without a tty, the name openone gave the tab, then titles', async () => {
  const hit = fake([['g', 'ok', G.byLabel]]);
  assert.deepEqual(await new MacTerminal([G], hit.run).focus('x', undefined, '', 'cradle'), { ok: true });
  const miss = fake([['g', '', G.byLabel], ['list', `a\u001f1\u001ftrue\u001ftrue\u001ftrue\u001f/dev/ttys1\u001f\u001ftmux`, G.list], ['focus', '', G.focus]]);
  assert.deepEqual(await new MacTerminal([G], miss.run).focus('tmux', undefined, '', 'cradle'), { ok: true });
  assert.deepEqual(miss.calls, ['g cradle', 'list', 'focus a 1']);
});

test('macterm: ttys come from every terminal, or null when one can\'t be asked', async () => {
  const ok = fake([['g', '/dev/ttys004, /dev/ttys000', G.ttys], ['t', '/dev/ttys006', T.ttys]]);
  assert.deepEqual([...await new MacTerminal([G, T], ok.run).ttys()], ['/dev/ttys004', '/dev/ttys000', '/dev/ttys006']);
  const no = fake([['g', new Error('not allowed'), G.ttys], ['t', '', T.ttys]]);
  assert.equal(await new MacTerminal([G, T], no.run).ttys(), null);
});
