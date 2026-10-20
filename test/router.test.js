const test = require('node:test');
const assert = require('node:assert/strict');
const { Router, cue, messages, parse } = require('../src/router');
const { typedLine } = require('../src/bus');

const AGENTS = [
  { name: 'shop@desk', kind: 'claude', title: 'Checkout page', summary: 'Want me to add the button?' },
  { name: 'api@box', kind: 'codex', title: '', summary: '' },
];

test('cue: spoken cues decide without the model', () => {
  assert.equal(cue('Note to self, buy milk').route, 'note');
  assert.equal(cue('note: the light was nice').route, 'note');
  assert.deepEqual(cue('Hey Claude, check the build'), { route: 'agent', why: 'addressed to an agent', text: 'check the build' });
  assert.equal(cue('Codex: run the tests').route, 'agent');
  assert.equal(cue('Zero one, check the build').text, 'check the build');
  assert.equal(cue('Okay so zero one: what broke?').text, 'what broke?');
  assert.equal(cue('Um, hey, open 1 ship it').text, 'ship it');
  assert.equal(cue('Zero-one. Ship it').text, 'Ship it');
  assert.equal(cue('Hey, 01, ship it').text, 'ship it');
  assert.equal(cue('I went to the store and bought zero one things'), null);
  assert.equal(cue('Notably the build is slow'), null);
  assert.equal(cue('I think the claude thing is neat'), null);
});

test('messages: roster with the default marked and last words', () => {
  const [sys, user] = messages('yeah do it', AGENTS, 'shop@desk');
  assert.match(sys.content, /"route"/);
  assert.match(user.content, /shop@desk \(claude, the default\): Checkout page \| last said: Want me to add the button\?/);
  assert.match(user.content, /- api@box \(codex\)\n/);
  assert.match(user.content, /Note:\nyeah do it$/);
});

test('parse: agent only with a known or default target; anything odd is a note', () => {
  const names = AGENTS.map((a) => a.name);
  assert.deepEqual(parse('{"route":"agent","to":"API@box","why":"asks it"}', names, 'shop@desk'), { route: 'agent', to: 'api@box', why: 'asks it' });
  assert.equal(parse('{"route":"agent","to":"nobody"}', names, 'shop@desk').to, 'shop@desk');
  assert.equal(parse('{"route":"agent","to":"nobody"}', names, '').route, 'note');
  assert.equal(parse('```json\n{"route":"note","why":"a thought"}\n```', names, 'shop@desk').route, 'note');
  assert.equal(parse('not json', names, 'shop@desk').route, 'note');
});

test('Router.route: model says agent -> sent as the user\'s words with the source tag', async (t) => {
  const sent = [];
  const r = new Router({ cfg: { url: 'http://llm/v1/chat/completions', model: 'm', to: 'shop@desk' }, roster: () => AGENTS, send: (to, text) => { sent.push([to, text]); return { id: 1 }; } });
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"route":"agent","to":"shop@desk","why":"reply"}' } }] }) }));
  const out = await r.route({ text: 'yeah add it', source: 'ring' });
  assert.equal(out.route, 'agent');
  assert.deepEqual(sent, [['shop@desk', '[ring] yeah add it']]);
});

test('Router.route: model down -> note, nothing sent', async (t) => {
  const sent = [];
  const r = new Router({ cfg: { url: 'http://llm', to: 'shop@desk' }, roster: () => AGENTS, send: (to, text) => sent.push(text) });
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('ECONNREFUSED'); });
  const out = await r.route({ text: 'what a day' });
  assert.equal(out.route, 'note');
  assert.match(out.why, /ECONNREFUSED/);
  assert.equal(sent.length, 0);
});

test('Router.route: a cue goes to the default agent, minus the cue; no default -> note', async () => {
  const sent = [];
  const r = new Router({ cfg: { to: 'shop@desk' }, roster: () => AGENTS, send: (to, text) => sent.push([to, text]) });
  assert.equal((await r.route({ text: 'Claude, ship it' })).route, 'agent');
  assert.deepEqual(sent, [['shop@desk', '[ring] ship it']]);
  const r2 = new Router({ cfg: { to: 'gone@desk' }, roster: () => AGENTS, send: () => {} });
  assert.equal((await r2.route({ text: 'Claude, ship it' })).route, 'note');
});

test('Router: the default is the first of "to" that is running, by key or name', async () => {
  const keys = { 'desk|0|%5': 'shop@desk' };
  const r = new Router({ cfg: { to: ['desk|0|%9', 'desk|0|%5', 'api@box'] }, roster: () => AGENTS, send: () => {}, resolve: (t) => keys[t] || (t.includes('@') ? t : '') });
  assert.equal(r.defaultTo(AGENTS), 'shop@desk');
  const r2 = new Router({ cfg: { to: 'gone|0|%1' }, roster: () => AGENTS, send: () => {}, resolve: () => { throw new Error('ambiguous'); } });
  assert.equal(r2.defaultTo(AGENTS), '');
});

test('Router: says where each note went, unless confirm is off', async (t) => {
  const said = [];
  const r = new Router({ cfg: { url: 'http://llm', to: 'shop@desk' }, roster: () => AGENTS, send: () => ({}), confirm: (s) => said.push(s) });
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"route":"note"}' } }] }) }));
  await r.route({ text: 'Claude, ship it' });
  r.sent = [];
  await r.route({ text: 'what a day' });
  assert.deepEqual(said, ['Sent to shop.', 'Noted.']);
  const quiet = new Router({ cfg: { confirm: false, to: 'shop@desk' }, roster: () => AGENTS, send: () => ({}), confirm: (s) => said.push(s) });
  await quiet.route({ text: 'Claude, ship it' });
  assert.equal(said.length, 2);
});

test('Router: recent notes sent to agents go to the model, so follow-ups stay in the conversation', async (t) => {
  const bodies = [];
  const r = new Router({ cfg: { url: 'http://llm', to: 'shop@desk' }, roster: () => AGENTS, send: () => ({}) });
  t.mock.method(globalThis, 'fetch', async (u, o) => { bodies.push(JSON.parse(o.body)); return { ok: true, json: async () => ({ choices: [{ message: { content: '{"route":"note"}' } }] }) }; });
  await r.route({ text: 'Claude, plan the move to the fast drive' });
  r.sent[0].at -= 11 * 60000; // past the sticky window, so the model decides
  await r.route({ text: 'is any of this worth it for me' });
  assert.match(bodies[0].messages[1].content, /Recent notes the user sent to agents:\n- 11 min ago, to shop@desk: plan the move to the fast drive/);
  const [user] = messages('x', AGENTS, 'shop@desk').slice(1);
  assert.doesNotMatch(user.content, /Recent notes/);
});

test('Router: within the sticky window a note follows the last one to its agent; "note" opts out', async (t) => {
  const sent = [];
  const r = new Router({ cfg: { url: 'http://llm', to: 'shop@desk' }, roster: () => AGENTS, send: (to, text) => sent.push([to, text]) });
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"route":"agent","to":"api@box"}' } }] }) }));
  await r.route({ text: 'deploy the api' }); // model -> api@box
  const out = await r.route({ text: 'hmm I wonder if that is worth it' });
  assert.equal(out.to, 'api@box');
  assert.equal(out.why, 'follows a note sent to it');
  assert.equal((await r.route({ text: 'note to self, buy milk' })).route, 'note');
  assert.equal(sent.length, 2);
});

test('Router + jev: scores the note; a low bar sends it, unsure ones carry a ref; not_for_me refiles', async (t) => {
  const sent = [];
  const said = [];
  const r = new Router({ cfg: { to: 'shop@desk', jev: { url: 'http://jev/v1/', key: 'k', threshold: 0.35, sureAt: 0.75 } }, roster: () => AGENTS, send: (to, text) => sent.push([to, text]), confirm: (s) => said.push(s) });
  let p = 0.5;
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (u, o) => {
    calls.push([u, o]);
    if (String(u).includes('/v1/systemone')) return { ok: true, json: async () => ({ answers: { for_agent: { type: 'noul', noul: p }, which: { type: 'choice', choice: 'api@box', confidence: 0.4 } } }) };
    return { ok: true, json: async () => ({}) }; // the refile URL
  });
  // unsure -> to the default (which-confidence too low), tagged with a ref
  const out = await r.route({ text: 'is any of this worth it', refile: 'http://notes/api/notes/n1/reprocess' });
  assert.equal(out.route, 'agent');
  assert.equal(out.to, 'shop@desk');
  assert.match(sent[0][1], /^\[ring\? 50% sure this is for you; if it isn't, call not_for_me with ref "(r\w+)"\] is any of this worth it$/);
  const body = JSON.parse(calls[0][1].body);
  assert.equal(calls[0][0], 'http://jev/v1/systemone');
  assert.equal(calls[0][1].headers.authorization, 'Bearer k');
  assert.equal(body.state.note, 'is any of this worth it');
  assert.ok(body.questions.for_agent && body.questions.which);
  const ref = sent[0][1].match(/ref "(r\w+)"/)[1];
  await r.notForMe(ref);
  assert.equal(calls[calls.length - 1][0], 'http://notes/api/notes/n1/reprocess');
  assert.deepEqual(said, ['Sent to shop.', 'Filed as a note.']);
  await assert.rejects(r.notForMe(ref), /no message with ref/);
  // sure -> plain tag; low -> note
  p = 0.9;
  await r.route({ text: 'deploy it' });
  assert.equal(sent[1][1], '[ring] deploy it');
  p = 0.1;
  assert.equal((await r.route({ text: 'what a day' })).route, 'note');
});

test('Router + jev down: falls back to sticky, then the chat model', async (t) => {
  const r = new Router({ cfg: { to: 'shop@desk', jev: { url: 'http://jev', key: 'k' } }, roster: () => AGENTS, send: () => ({}) });
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('ECONNREFUSED'); });
  const out = await r.route({ text: 'hmm' });
  assert.equal(out.route, 'note');
  assert.match(out.why, /no router model configured \(ECONNREFUSED\)/);
});

test('typedLine: the user\'s relayed words are typed as they are', () => {
  assert.equal(typedLine({ content: '[ring] check the build', from: 'voice', user: true }), '[ring] check the build');
});
