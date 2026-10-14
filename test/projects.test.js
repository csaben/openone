const test = require('node:test');
const assert = require('node:assert');
const P = require('../src/projects');
const { LocalSource } = require('../src/sources');

test('projects: names become folder slugs', () => {
  assert.equal(P.slug('Google Drive maintenance!'), 'google-drive-maintenance');
  assert.equal(P.slug('  --x--  '), 'x');
});

test('projects: only plain folder names get into commands', () => {
  assert.equal(P.checkName('gdrive-maint'), 'gdrive-maint');
  for (const bad of ['../etc', "a'; rm -rf ~", 'a"b', 'a\nb', '', '.hidden']) assert.throws(() => P.checkName(bad), bad);
});

test('projects: start lines for bash and PowerShell', () => {
  assert.equal(P.commandLine('bash', '/home/u/Code/x', true, 'claude'), "mkdir -p '/home/u/Code/x' && cd '/home/u/Code/x' && claude");
  assert.equal(P.commandLine('bash', '/home/u/Code/x', false, 'claude --continue'), "cd '/home/u/Code/x' && claude --continue");
  assert.equal(P.commandLine('powershell', 'D:\\Code\\x', true, 'codex'),
    "New-Item -ItemType Directory -Force -Path 'D:\\Code\\x' | Out-Null; Set-Location -LiteralPath 'D:\\Code\\x'; codex");
});

test('projects: VS Code opens remote folders over Remote-SSH', () => {
  assert.deepEqual(P.vscodeArgs({ type: 'ssh', ssh: 'me@box' }, '/home/me/Code/x'), ['--remote', 'ssh-remote+me@box', '/home/me/Code/x']);
  assert.deepEqual(P.vscodeArgs({ type: 'ssh', ssh: 'me@box', vscode: 'box' }, '/x'), ['--remote', 'ssh-remote+box', '/x']);
  assert.deepEqual(P.vscodeArgs({ type: 'psmux' }, 'D:\\Code\\x'), ['D:\\Code\\x']);
});

test('projects: agent commands can be overridden per agent', () => {
  const a = P.agents({ agents: { claude: { start: 'claude --model opus' } } });
  assert.equal(a.claude.start, 'claude --model opus');
  assert.equal(a.claude.resume, 'claude --continue');
  assert.equal(a.codex.resume, 'codex resume --last');
});

test('newWindow: opens in the attached session and types the start line', async () => {
  const src = new LocalSource({ type: 'tmux', shellWarmMs: 1, shellReadyMs: 50 });
  const calls = [];
  src.batch = async (argvs) => argvs.map((a) => {
    calls.push(a);
    if (a[0] === 'list-sessions') return '0 200 scratch\n1 100 main\n1 50 other';
    if (a[0] === 'new-window') return ['%9', 'main', '4', 'proj', '0', 'bash', '/x', 't', '0', '1', '1', '0', '0', '0'].join('<|>');
    return '';
  });
  const pane = await src.newWindow({ name: 'proj', line: 'cd /x && claude' });
  assert.equal(pane.session, 'main');
  assert.deepEqual(calls.find((a) => a[0] === 'new-window').slice(0, 6), ['new-window', '-d', '-t', 'main:', '-n', 'proj']);
  assert.ok(calls.some((a) => a[0] === 'send-keys' && a.includes('Enter')));
});
