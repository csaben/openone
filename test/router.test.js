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

test('typedLine: the user\'s relayed words are typed as they are', () => {
  assert.equal(typedLine({ content: '[ring] check the build', from: 'voice', user: true }), '[ring] check the build');
});
