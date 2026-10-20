const test = require('node:test');
const assert = require('node:assert');
const { Sleepers, sleepAgent, resumeId, wakeCommand } = require('../src/sleep');

const ID = 'f82f373a-fcc7-409a-85a8-510f4fea6216';

test('sleep: finds the resume id each agent prints on exit', () => {
  assert.equal(resumeId('claude', `bye\n\nResume this session with:\nclaude --resume ${ID}\n$ `), ID);
  assert.equal(resumeId('codex', `To reconnect, run:\n  codex resume ${ID}\n`), ID);
  assert.equal(resumeId('claude', `codex resume ${ID}`), '');
  assert.equal(resumeId('codex', 'no id here'), '');
});

test('sleep: wake keeps the configured start command', () => {
  assert.equal(wakeCommand({}, 'claude', ID), `claude --resume ${ID}`);
  assert.equal(wakeCommand({ agents: { claude: { start: 'claude --dangerously-skip-permissions' } } }, 'claude', ID),
    `claude --dangerously-skip-permissions --resume ${ID}`);
  assert.equal(wakeCommand({}, 'codex', ID), `codex resume ${ID}`);
  assert.equal(wakeCommand({}, 'claude', ''), 'claude --continue');
  assert.equal(wakeCommand({}, 'codex', ''), 'codex resume --last');
});

test('sleep: exits an idle agent, reads its id, closes the pane', async () => {
  const sent = [];
  let screen = '> ';
  const src = {
    target: (p) => `${p.session}:${p.windowIndex}.${p.paneId}`,
    keys: async (p, k) => { sent.push(['keys', ...k]); },
    text: async (p, t) => { sent.push(['text', t]); if (t === '/exit') screen = `Resume this session with:\nclaude --resume ${ID}\n$`; },
    screen: async () => screen,
    batch: async (argvs) => { sent.push(['batch', ...argvs[0]]); return ['']; },
  };
  const p = { host: 'devbox', kind: 'claude', label: 'recipe-api', path: '/home/u/Code/recipe-api', state: 'idle', session: 's', windowIndex: '2', paneId: '%5' };
  const rec = await sleepAgent({ src }, p, { timeoutMs: 3000 });
  assert.equal(rec.resume, ID);
  assert.equal(rec.path, '/home/u/Code/recipe-api');
  assert.deepEqual(sent.map((x) => x.join(' ')), ['keys C-c', 'text /exit', 'keys Enter', 'batch kill-pane -t s:2.%5']);
  await assert.rejects(sleepAgent({ src }, { ...p, state: 'working' }), /working/);
});

test('sleep: no resume id in time -> the pane stays open', async () => {
  const sent = [];
  const src = {
    target: () => 's:2.%5', keys: async () => {}, text: async () => {}, screen: async () => '> generating…',
    batch: async (argvs) => { sent.push(argvs[0][0]); return ['']; },
  };
  const p = { host: 'devbox', kind: 'claude', label: 'x', path: '/x', state: 'idle', session: 's', windowIndex: '2', paneId: '%5' };
  await assert.rejects(sleepAgent({ src }, p, { timeoutMs: 1000 }), /left its window open/);
  assert.deepEqual(sent, []);
});

test('sleep: records survive a restart; take removes', () => {
  const file = require('path').join(require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'z-')), 's.json');
  const a = new Sleepers({ file });
  const r = a.add({ host: 'devbox', kind: 'codex', label: 'notes-search', path: '/x', resume: ID });
  assert.equal(new Sleepers({ file }).list[0].id, r.id);
  a.take(r.id);
  assert.equal(new Sleepers({ file }).list.length, 0);
  assert.throws(() => a.take('nope'), /no such/);
});
