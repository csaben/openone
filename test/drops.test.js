const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { Drops, links, cleanName } = require('../src/drops');

test('drops: finds the links in shared text', () => {
  assert.deepEqual(links('look https://a.example/x?y=1, and (https://b.example/p).\nhttps://a.example/x?y=1'), ['https://a.example/x?y=1', 'https://b.example/p']);
  assert.deepEqual(links('no links here'), []);
});

test('drops: text goes to a device, is listed for it, and is gone once taken', () => {
  let t = 1000;
  const d = new Drops({ now: () => t });
  const a = d.add({ to: 'Desk', from: 'phone', text: 'https://a.example' });
  assert.equal(a.to, 'desk');
  assert.deepEqual(a.links, ['https://a.example']);
  assert.equal(d.for('desk').length, 1);
  assert.equal(d.for('phone').length, 0);
  d.take(a.id);
  assert.equal(d.for('desk').length, 0);
  assert.throws(() => d.add({ to: 'desk', text: '  ' }), /nothing/);
  assert.throws(() => d.add({ to: '', text: 'x' }), /which device/);
});

test('drops: a computer that asks is online for a while; the phone always is', () => {
  let t = 1000;
  const d = new Drops({ now: () => t });
  d.for('desk');
  t += 30000;
  d.for('devbox');
  assert.deepEqual(d.devices(), ['devbox', 'desk', 'phone']);
  t += 80000;
  assert.deepEqual(d.devices(), ['devbox', 'phone']);
});

test('drops: files are stored, listed, and deleted when taken or a day old', async () => {
  let t = 1000;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drops-'));
  const d = new Drops({ dir, now: () => t });
  const f = await d.addFile({ to: 'phone', from: 'desk', name: '../re:port?.pdf', mime: 'application/pdf', stream: Readable.from([Buffer.from('hello '), Buffer.from('world')]) });
  assert.equal(f.name, '_re_port_.pdf');
  assert.equal(f.size, 11);
  assert.equal(fs.readFileSync(d.filePath(f), 'utf8'), 'hello world');
  assert.equal(new Drops({ dir }).for('phone')[0].id, f.id); // survives a restart
  t += 25 * 3600000;
  d.sweep();
  assert.equal(d.for('phone').length, 0);
  assert.equal(fs.existsSync(d.filePath(f)), false);
});

test('drops: file names lose path and shell characters', () => {
  assert.equal(cleanName('C:\\x\\y.txt'), 'C_x_y.txt');
  assert.equal(cleanName('.hidden'), 'hidden');
  assert.equal(cleanName(''), 'file');
});
