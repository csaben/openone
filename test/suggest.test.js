const test = require('node:test');
const assert = require('node:assert');
const { Suggester, buildPrompt, msUntil, clean } = require('../src/suggest');

test('suggest: one run at a time, duplicates join the line, results kept per project', async () => {
  const runs = [];
  const done = [];
  let release;
  const s = new Suggester({
    run: (job) => { runs.push(job.folder); return new Promise((r) => { release = () => r({ items: [{ title: `Ship ${job.folder}`, why: 'w', prompt: 'p' }] }); }); },
    onDone: (job, res) => done.push([job.folder, res.items.length]),
  });
  assert.equal(s.request({ host: 'devbox', folder: 'recipe-api' }), 0);
  assert.equal(s.request({ host: 'devbox', folder: 'notes-search' }), 1);
  assert.equal(s.request({ host: 'devbox', folder: 'recipe-api' }), 0); // already running
  assert.equal(s.request({ host: 'devbox', folder: 'notes-search' }), 1); // already queued
  release();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(runs, ['recipe-api', 'notes-search']);
  release();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(done, [['recipe-api', 1], ['notes-search', 1]]);
  assert.equal(s.latest['devbox|recipe-api'].items[0].title, 'Ship recipe-api');
});

test('suggest: a failed run is kept as an error', async () => {
  const s = new Suggester({ run: async () => { throw new Error('codex: not logged in'); } });
  s.request({ host: 'devbox', folder: 'photo-tidy' });
  await new Promise((r) => setImmediate(r));
  assert.match(s.latest['devbox|photo-tidy'].error, /not logged in/);
});

test('suggest: at most 3, each needs a title and a prompt', () => {
  const items = clean([{ title: 'a', why: '', prompt: 'x' }, { title: '', prompt: 'y' }, { title: 'b', prompt: 'z' }, { title: 'c', prompt: 'w' }]);
  assert.deepEqual(items.map((x) => x.title), ['a', 'b']);
});

test('suggest: the prompt carries the context and what agents said', () => {
  const p = buildPrompt({ host: 'devbox', folder: 'recipe-api', context: 'Recent commits:\nabc fix login', agents: [{ kind: 'claude', label: 'recipe-api', title: 'Auth', summary: 'Login works; tests next', asleep: true }], readable: false });
  assert.match(p, /"recipe-api"/);
  assert.match(p, /abc fix login/);
  assert.match(p, /\(asleep\): Auth \/ Login works; tests next/);
  assert.match(p, /cannot see the code/);
});

test('suggest: msUntil the next HH:MM', () => {
  const now = new Date(2026, 9, 16, 8, 0, 0);
  assert.equal(msUntil('08:30', now), 30 * 60000);
  assert.equal(msUntil('07:00', now), 23 * 3600000);
  assert.equal(msUntil('nope', now), -1);
});
