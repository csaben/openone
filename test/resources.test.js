const test = require('node:test');
const assert = require('node:assert');
const r = require('../src/resources');

const row = (pid, ppid, mb, cpu, name, group = '', cmd = name) => `${pid}\t${ppid}\t${mb * 1048576}\t${cpu}\t${name}\t${group}\t${cmd}`;

test('resources: script output parses, Windows (.exe, CRLF) and Linux (services, GPU) alike', () => {
  const win = r.parse(['@@MEM 34359738368 4294967296', `${row(10, 1, 100, 5, 'powershell.exe')}\r`, 'junk', '@@END'].join('\n'));
  assert.deepEqual(win.mem, { total: 34359738368, avail: 4294967296 });
  assert.equal(win.procs.get(10).name, 'powershell');
  const lin = r.parse(['@@MEM 100 50', row(7, 1, 900, '01:02', 'python', 'tts-server'), '@@GPU', '7, 9000', '7, 100', '@@END'].join('\n'));
  assert.equal(lin.procs.get(7).group, 'tts-server');
  assert.equal(lin.procs.get(7).cpu, 62);
  assert.equal(lin.gpu.get(7), 9100 * 1048576);
  assert.equal(r.seconds('1-00:00:10'), 86410);
});

test('resources: keys in command lines are hidden', () => {
  assert.equal(r.redact('srv --api-key abc123 --port 1'), 'srv --api-key *** --port 1');
  assert.equal(r.redact('x TOKEN=zzz'), 'x TOKEN=***');
  assert.equal(r.redact('curl sk-abcdef123456789'), 'curl sk-abcdef***');
});

test('resources: a pane counts everything it started; the rest is grouped by service or name', () => {
  const a = r.parse(['@@MEM 100 40',
    row(100, 1, 10, 0, 'bash'), row(101, 100, 3000, 10, 'claude'), row(102, 101, 500, 0, 'node'), row(103, 102, 200, 0, 'node'),
    row(200, 1, 10, 0, 'bash'),
    row(300, 1, 4000, 0, 'python', 'vllm'), row(301, 300, 1000, 0, 'python', 'vllm'), row(400, 1, 700, 0, 'chrome'), row(401, 1, 300, 0, 'chrome'),
    '@@GPU', '300, 8000', '@@END'].join('\n'));
  const b = r.parse(['@@MEM 100 40',
    row(100, 1, 10, 0, 'bash'), row(101, 100, 3000, 12, 'claude'), row(102, 101, 500, 0, 'node'), row(103, 102, 200, 0, 'node'),
    row(200, 1, 10, 0, 'bash'),
    row(300, 1, 4000, 0, 'python', 'vllm'), row(301, 300, 1000, 0, 'python', 'vllm'), row(400, 1, 700, 0, 'chrome'), row(401, 1, 300, 0, 'chrome'),
    '@@END'].join('\n'));
  b.gpu = a.gpu;
  const now = 10 * 3600000;
  const s = r.summarize({
    sample: b, cpu: r.cpuRates(a, b, 2), now,
    panes: [{ key: 'h|0|%1', pid: 100, name: 'photo-tidy@h', state: 'idle', since: now - 3 * 3600000 }, { key: 'h|0|%2', pid: 200 }, { key: 'gone', pid: 999 }],
  });
  assert.equal(s.panes.length, 2);
  const [agent, shell] = s.panes;
  assert.equal(agent.name, 'photo-tidy@h');
  assert.equal(agent.rss, 3710 * 1048576);
  assert.equal(agent.count, 4);
  assert.equal(agent.cpu, 100); // 2 cpu seconds over 2 seconds
  assert.equal(agent.idleMin, 180);
  assert.deepEqual(agent.top.map((t) => [t.name, t.count]), [['claude', 1], ['node', 2], ['bash', 1]]);
  assert.equal(shell.rss, 10 * 1048576);
  assert.deepEqual(s.others.map((g) => [g.name, g.count]), [['vllm', 2], ['chrome', 2]]);
  assert.equal(s.others[0].gpu, 8000 * 1048576);
  assert.equal(r.gb(1.5 * 2 ** 30), '1.5 GB');
});

test('resources: a process tree with a cycle (reused pids) still ends', () => {
  const p = r.parse(['@@MEM 1 1', row(5, 6, 1, 0, 'a'), row(6, 5, 1, 0, 'b'), '@@END'].join('\n'));
  assert.deepEqual([...r.tree(p.procs, 5)].sort(), [5, 6]);
});
