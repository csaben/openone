const test = require('node:test');
const assert = require('node:assert');
const { listen, tag } = require('../src/voicein');

test('voicein: tag says it was spoken, and where from', () => {
  assert.equal(tag({ 'x-player-one-event': 'voice', 'x-player-one-app': 'eden.exe' }), '[voice] [player-one · eden] ');
  assert.equal(tag({}), '[voice] [voice clip] ');
});

test('voicein: a clip is answered at once, then handed on', async () => {
  let got;
  const done = new Promise((resolve) => { got = resolve; });
  const server = listen({ port: 0, onClip: got });
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const r = await fetch(`${base}/voice`, {
      method: 'POST',
      headers: { 'content-type': 'audio/mpeg', 'x-player-one-event': 'voice', 'x-player-one-app': 'eden', 'x-player-one-window': 'Eden%20%7C%20Zelda', 'x-player-one-duration-ms': '2760' },
      body: Buffer.alloc(4000, 1),
    });
    assert.equal(r.status, 202);
    const c = await done;
    assert.equal(c.audio.length, 4000);
    assert.equal(c.mime, 'audio/mpeg');
    assert.equal(c.window, 'Eden | Zelda');
    assert.equal(c.ms, 2760);
    assert.equal(c.tag, '[voice] [player-one · eden] ');
    assert.equal((await fetch(`${base}/voice`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'hi' })).status, 415);
    assert.equal((await fetch(`${base}/voice`, { method: 'POST', headers: { 'content-type': 'audio/mpeg' }, body: 'x' })).status, 400);
  } finally { server.close(); }
});

test('voicein: "take me to X" is a jump, to the pane that name means', () => {
  const { navTarget, findPane } = require('../src/voicein');
  assert.equal(navTarget('Take me to my fastudio project.'), 'fastudio');
  assert.equal(navTarget('hey zero one, jump to the cblur agent'), 'cblur');
  assert.equal(navTarget('Can you take me to fast studio?'), 'fast studio');
  assert.equal(navTarget('I want to go to bed'), '');
  assert.equal(navTarget('show me the logs for the last build run today please'), '');
  const panes = [
    { key: 'a', label: 'fastudio', kind: 'claude', used: 1 },
    { key: 'b', label: 'cblur', kind: 'claude', used: 5 },
    { key: 'c', label: 'bash', path: '/home/x/fastudio', used: 9 },
    { key: 'd', label: 'cblur', kind: 'codex', used: 2 },
  ];
  assert.equal(findPane('fast studio', panes).key, 'a');
  assert.equal(findPane('cblur', panes).key, 'b');
  assert.equal(findPane('store', panes), null);
});

test('voicein: always-listening clips say so', async () => {
  let got;
  const done = new Promise((resolve) => { got = resolve; });
  const server = listen({ port: 0, onClip: got });
  await new Promise((r) => server.once('listening', r));
  try {
    await fetch(`http://127.0.0.1:${server.address().port}/voice`, { method: 'POST', headers: { 'content-type': 'audio/mpeg', 'x-player-one-mode': 'always' }, body: Buffer.alloc(2000, 1) });
    assert.equal((await done).mode, 'always');
  } finally { server.close(); }
});

test('voicein: jumps survive speech recognition: "go too", a bare name, a machine', () => {
  const { navTarget, findPane } = require('../src/voicein');
  const panes = [
    { key: 'f', label: 'fastudio', kind: 'claude', host: 'inari' },
    { key: 'o', label: 'openone', kind: 'claude', host: 'inari' },
    { key: 'm', label: 'zsh', host: 'macbook' },
  ];
  const go = (t, held = true) => {
    const q = navTarget(t);
    const bare = !q && held && navTarget(t, { bare: true });
    const p = (q && findPane(q, panes)) || (bare && findPane(bare, panes, 2.5));
    return p ? p.key : null;
  };
  assert.equal(go('Go Too Fast Studio.'), 'f');
  assert.equal(go('Take me 2 open one'), 'o');
  assert.equal(go('Open the Mac team up.'), 'm');
  assert.equal(go('Fast studio.'), 'f');
  assert.equal(go('Fast studio.', false), null);
  assert.equal(go('go to the store'), null);
  assert.equal(go('okay so here is the thing'), null);
});
