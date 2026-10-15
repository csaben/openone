const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Monitor } = require('../src/monitor');

const fx = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const pane = (text, extra = {}) => [{ session: 's', windowIndex: '1', windowName: 'claude', paneId: '%1', path: '/home/a/Code/shop', title: '✳ Pricing page', text, ...extra }];

test('working -> idle fires one done event after two polls', () => {
  const m = new Monitor();
  assert.deepEqual(m.ingest('h', pane(fx('claude-working.txt'))), []);
  assert.deepEqual(m.ingest('h', pane(fx('claude-idle-done.txt'))), []);
  assert.deepEqual(m.ingest('h', pane(fx('claude-idle-done.txt'))).map((e) => e.type), ['done']);
  assert.deepEqual(m.ingest('h', pane(fx('claude-idle-done.txt'))), []);
  const v = m.view()[0];
  assert.equal(v.unseen, true);
  assert.equal(v.label, 'shop');
  assert.equal(v.title, 'Pricing page');
});

test('a one-poll flicker does not notify', () => {
  const m = new Monitor();
  m.ingest('h', pane(fx('claude-working.txt')));
  m.ingest('h', pane(fx('claude-idle-done.txt')));
  assert.deepEqual(m.ingest('h', pane(fx('claude-working.txt'))), []);
  assert.equal(m.view()[0].state, 'working');
});

test('input fires, carries options, and clears when the agent resumes', () => {
  const m = new Monitor();
  m.ingest('h', pane(fx('claude-working.txt')));
  m.ingest('h', pane(fx('claude-ask.txt')));
  assert.deepEqual(m.ingest('h', pane(fx('claude-ask.txt'))).map((e) => e.type), ['input']);
  assert.equal(m.view()[0].options.length, 3);
  m.ingest('h', pane(fx('claude-working.txt')));
  m.ingest('h', pane(fx('claude-working.txt')));
  assert.equal(m.view()[0].unseen, false);
});

test('pane already waiting at startup is in the inbox without a toast', () => {
  const m = new Monitor();
  assert.deepEqual(m.ingest('h', pane(fx('claude-permission.txt'))), []);
  assert.equal(m.view()[0].unseen, true);
});

test('host-name titles are ignored and closed panes drop out', () => {
  const m = new Monitor({ hostNames: ['DESKTOP-1'] });
  m.ingest('h', pane(fx('claude-idle-done.txt'), { title: 'DESKTOP-1', windowName: 'claude.exe.old.17914' }));
  assert.equal(m.view()[0].title, '');
  m.ingest('h', []);
  assert.equal(m.view().length, 0);
});

test('a turn that finishes between polls still fires done', () => {
  const m = new Monitor();
  const idle = (t) => pane(`● hi

✻ ${t} · done 12:58 AM
────────────
❯ 
────────────
  ⏵⏵ bypass permissions on
`);
  m.ingest('h', idle('Crunched for 9s'));
  m.ingest('h', idle('Crunched for 9s'));
  assert.deepEqual(m.ingest('h', idle('Worked for 1s')).map((e) => e.type), ['done']);
  assert.deepEqual(m.ingest('h', idle('Worked for 1s')), []);
});

test('monitor: last used is set by state changes and by opening, not by output', () => {
  const { Monitor } = require('../src/monitor');
  const m = new Monitor();
  const raw = (text) => ({ paneId: '%1', session: 's', windowIndex: '1', text, command: 'claude' });
  m.ingest('h', [raw('')], 1000);
  assert.equal(m.view()[0].used, 0);
  m.ingest('h', [raw('esc to interrupt')], 2000);
  m.ingest('h', [raw('esc to interrupt')], 3000); // counts on the second poll
  assert.equal(m.view()[0].used, 3000);
  m.markSeen('h|s|%1');
  assert.ok(m.view()[0].used > 3000);
});
