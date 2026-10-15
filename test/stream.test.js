const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter, PassThrough } = require('stream');
const { SessionStream, parseClients, unescape } = require('../src/stream');

// a stand-in for `psmux -C attach`: we write its stdout, read what it was sent
function fakeControl() {
  const proc = new EventEmitter();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = new PassThrough();
  proc.kill = () => proc.emit('exit');
  return proc;
}

const flush = (st, id) => new Promise((r) => st.panes.get(id).term.write('', r));

test('stream: control-mode output becomes the pane screen', async () => {
  const proc = fakeControl();
  const st = new SessionStream('main', () => proc);
  st.sync([{ paneId: '%3', width: '40', height: '5' }]);
  st.start();
  assert.match(proc.stdin.read().toString(), /refresh-client -f ignore-size/);
  assert.equal(st.ready('%3'), false); // not until its first read
  st.seed('%3', '', { rows: 5, cursor: [0, 0] });
  proc.stdout.write('%begin 1 1 1\n%end 1 1 1\n');
  proc.stdout.write('%output %3 \\033[32mhello\\033[m\\015\\012second line\\015\\012\n');
  proc.stdout.write('%output %3 café \\134 done\n'); // raw UTF-8 and an escaped backslash
  await new Promise((r) => setImmediate(r));
  await flush(st, '%3');
  assert.ok(st.ready('%3'));
  assert.deepEqual(st.text('%3').split('\n').slice(0, 3), ['hello', 'second line', 'café \\ done']);
  assert.match(st.ansi('%3'), /\x1b\[32mhello/);
  st.close();
});

test('stream: lines the terminal wrapped come back joined, like capture-pane -J', async () => {
  const proc = fakeControl();
  const st = new SessionStream('main', () => proc);
  st.sync([{ paneId: '%1', width: '10', height: '4' }]);
  st.start();
  proc.stdout.write('%output %1 abcdefghijKLMNO\\015\\012next\n');
  await new Promise((r) => setImmediate(r));
  await flush(st, '%1');
  assert.deepEqual(st.text('%1').split('\n').slice(0, 2), ['abcdefghijKLMNO', 'next']);
  st.close();
});

test('stream: a dead control client is not ready, and panes that are gone are dropped', () => {
  const proc = fakeControl();
  const st = new SessionStream('main', () => proc);
  st.sync([{ paneId: '%1', width: '10', height: '4' }, { paneId: '%2', width: '10', height: '4' }]);
  st.start();
  proc.stdout.write('%output %1 x\n%output %2 y\n');
  return new Promise((r) => setImmediate(r)).then(() => {
    st.sync([{ paneId: '%1', width: '10', height: '4' }]);
    assert.deepEqual([...st.panes.keys()], ['%1']);
    proc.emit('exit');
    assert.equal(st.ready('%1'), false);
  });
});

test('stream: output during the first read is applied after it, rows in place', async () => {
  const proc = fakeControl();
  const st = new SessionStream('main', () => proc);
  st.sync([{ paneId: '%4', width: '20', height: '4' }]);
  st.start();
  st.beginSeed('%4');
  proc.stdout.write('%output %4 \\033[3;1Hnew row 3\n'); // arrives while capture-pane runs
  await new Promise((r) => setImmediate(r));
  st.seed('%4', 'old history\nrow 1\nrow 2\n\n\n', { rows: 4, cursor: [5, 1] });
  await flush(st, '%4');
  assert.ok(st.ready('%4'));
  assert.deepEqual(st.text('%4').split('\n'), ['old history', 'row 1', 'row 2', 'new row 3', '']);
  st.close();
});

test('stream: control-mode escapes', () => {
  assert.equal(unescape('a\\033[1mb\\134c'), 'a\x1b[1mb\\c');
});

test('clients: psmux default list and tmux -F list', () => {
  const ps = parseClients([
    '/dev/pts/21220: 0: claude [154x84] (utf8) [activity=12s ago]',
    '/dev/pts/12: 0: powershell [154x84] (utf8) (control mode) [activity=2s ago]',
  ].join('\n'));
  assert.deepEqual(ps.map((c) => [c.name, c.session, c.control, c.recent]), [['/dev/pts/21220', '0', false, 12], ['/dev/pts/12', '0', true, 2]]);
  const tm = parseClients('/dev/pts/3 trident 0 1792000000\n/dev/pts/4 trident 1 1792000000');
  assert.deepEqual(tm.map((c) => [c.session, c.control]), [['trident', false], ['trident', true]]);
});
