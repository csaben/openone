const test = require('node:test');
const assert = require('node:assert');
const { Speech, sentences } = require('../src/speech');

test('speech: text splits at sentence ends, short ones ride together, long ones are cut', () => {
  assert.deepEqual(sentences('Done. The board is cleared. Want me to redraw it?'),
    ['Done.', 'The board is cleared. Want me to redraw it?']);
  assert.deepEqual(sentences('  '), []);
  const long = `${'word '.repeat(60)}end.`;
  const parts = sentences(long, 100);
  assert.ok(parts.length >= 3);
  assert.ok(parts.every((p) => p.length <= 101));
  assert.equal(parts.join(' ').replace(/\s+/g, ' '), long.trim());
  assert.deepEqual(sentences('No punctuation at all'), ['No punctuation at all']);
});

test('speech: parts come out in order, each once, as soon as the ones before are taken', async () => {
  const gates = [];
  const sp = new Speech({ synth: (text) => new Promise((r) => gates.push(() => r({ audio: Buffer.from(text), mime: 'audio/mpeg' }))) });
  const { parts } = sp.say({ text: 'The first sentence is long enough that it will not be merged with anything else around it. The second sentence is also long enough that it stays a part of its own here. The third sentence closes it out and is also long enough to stand by itself.', from: 'a@h' });
  assert.equal(parts, 3);
  assert.deepEqual(sp.take('desk'), []); // nothing made yet
  await new Promise((r) => setImmediate(r));
  gates.shift()();
  await new Promise((r) => setImmediate(r));
  const first = sp.take('desk');
  assert.deepEqual(first.map((x) => x.seq), [0]);
  assert.equal(first[0].from, 'a@h');
  assert.deepEqual(sp.take('phone'), []); // already taken
  assert.equal(String(sp.audio(first[0].id).audio), first[0].text);
  gates.shift()();
  await new Promise((r) => setImmediate(r));
  gates.shift()();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sp.take('desk').map((x) => x.seq), [1, 2]);
  sp.done(first[0].id);
  assert.equal(sp.audio(first[0].id), null);
});

test('speech: a failed part is skipped, and without a tts service it says so', async () => {
  let n = 0;
  const sp = new Speech({ synth: async () => { if (n++ === 0) throw new Error('boom'); return { audio: Buffer.from('x'), mime: 'audio/mpeg' }; } });
  sp.say({ text: 'This first sentence will fail to synthesize. The second sentence works fine though.' });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(sp.take('desk').map((x) => x.seq), [1]);
  assert.throws(() => new Speech().say({ text: 'hi' }), /tts/);
  assert.throws(() => sp.say({ text: '' }), /nothing to say/);
});

test('speech: "say" fixes how names are pronounced, whole words only', async () => {
  const { httpSynth } = require('../src/speech');
  const sent = [];
  const real = global.fetch;
  global.fetch = async (_u, o) => { sent.push(JSON.parse(o.body).text); return { ok: true, arrayBuffer: async () => new ArrayBuffer(1), headers: { get: () => 'audio/mpeg' } }; };
  try {
    await httpSynth({ url: 'x', say: { openone: 'oh one', 'openone@desk': 'oh one on desk' } })('Openone here. openone@desk too. reopenone stays.');
  } finally { global.fetch = real; }
  assert.deepEqual(sent, ['oh one here. oh one on desk too. reopenone stays.']);
});

test('speech goes to the phone only with headphones on and the desktops left alone', async () => {
  let t = 1000000;
  const s = new Speech({ synth: async () => ({ audio: Buffer.from('a'), mime: 'audio/mpeg' }), now: () => t, awayMs: 180000 });
  s.say({ text: 'One.' });
  await new Promise((r) => setImmediate(r));
  // nobody said what they are: a plain desktop, as before
  assert.equal(s.target(), 'desktop');
  s.seen('desk', { kind: 'desktop', idleMs: 5000 });
  s.seen('phone', { kind: 'phone', headset: true });
  assert.equal(s.target(), 'desktop'); // you're at the desk
  assert.deepEqual(s.take('phone'), []);
  s.seen('desk', { kind: 'desktop', idleMs: 200000 });
  assert.equal(s.target(), 'phone'); // away for over 3 minutes
  assert.deepEqual(s.take('desk'), []);
  assert.equal(s.take('phone').length, 1);
  // headphones off: back to the desktop
  s.seen('phone', { kind: 'phone', headset: false });
  assert.equal(s.target(), 'desktop');
  // a phone that stopped polling stops counting
  s.seen('phone', { kind: 'phone', headset: true });
  t += 80000;
  s.seen('desk', { kind: 'desktop', idleMs: 300000 });
  assert.equal(s.target(), 'desktop');
  // no desktop running at all: the phone
  const s2 = new Speech({ now: () => t });
  s2.seen('phone', { kind: 'phone', headset: true });
  assert.equal(s2.target(), 'phone');
});

test('speech: device sends it to the phone or the desktop whatever the target', async () => {
  const s = new Speech({ synth: async () => ({ audio: Buffer.from('a'), mime: 'audio/mpeg' }) });
  s.seen('desk', { kind: 'desktop', idleMs: 0 });
  s.seen('phone', { kind: 'phone', headset: true });
  s.say({ text: 'For the road.', device: 'phone' });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(s.take('desk'), []);
  assert.equal(s.take('phone').length, 1);
});

test('speech: by default, headphones on the phone win even at an active desktop', () => {
  const s = new Speech({});
  s.seen('desk', { kind: 'desktop', idleMs: 0 });
  assert.equal(s.target(), 'desktop');
  s.seen('phone', { kind: 'phone', headset: true });
  assert.equal(s.target(), 'phone');
});
