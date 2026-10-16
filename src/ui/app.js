const $ = (s) => document.querySelector(s);
const root = $('#root');
const body = $('#card-body');
// served by the openone server: the panel is the whole page and never collapses
const WEB = document.body.classList.contains('web');
const OPEN_HINT = WEB ? 'show pane' : 'open in terminal';

let S = { panes: [], hosts: [], muted: false };
let expanded = false;
let view = 'inbox';
let cur = null;
let kb = -1;
let sig = '';
let peekKey = null;
let peekTimer = null;
let hintTimer = null;
let query = null; // the agent list's "/" search: null when closed
let tidy = null; // "Tidy up": the set of agent keys picked to put to sleep, or null
const drafts = {};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ICON = {
  claude: '<svg viewBox="0 0 16 16" style="stroke:var(--claude);stroke-width:2.1"><path d="M8 1.8v12.4M1.8 8h12.4M3.6 3.6l8.8 8.8M12.4 3.6l-8.8 8.8"/></svg>',
  codex: '<svg viewBox="0 0 16 16" style="stroke:#e8e8e8"><path d="M8 1.6 13.6 4.8v6.4L8 14.4 2.4 11.2V4.8Z"/><path d="m5.6 6.6 1.8 1.4-1.8 1.4M8.6 9.6h2"/></svg>',
  shell: '<svg viewBox="0 0 16 16" style="color:var(--muted)"><path d="m4 5 3 3-3 3M8.5 11.5H12"/></svg>',
};
const X = '<svg viewBox="0 0 16 16"><path d="m4 4 8 8M12 4l-8 8"/></svg>';
const OPEN = '<svg viewBox="0 0 16 16"><path d="M9.5 3H13v3.5M13 3 7.5 8.5M11.5 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5.5a1 1 0 0 1 1-1h2.5"/></svg>';
const SEND = '<svg viewBox="0 0 16 16"><path d="M13.5 2.5 7 9M13.5 2.5l-4 11-2.5-4.5-4.5-2.5Z"/></svg>';

const status = (p) => (p.state === 'idle' && p.unseen ? 'done' : p.state);
const name = (p) => `${p.kind || 'shell'} · ${p.label}`;
// Agents that need you first (waiting, then just finished), then the rest by when they
// were last used, shells last. "Last used": working now, or the last turn openone saw
// start or finish, or you opened/answered/replied, or the agent's own "done at" time,
// which is also the time each idle row shows.
const RANK = { input: 0, done: 1, working: 2, idle: 2, shell: 3 };
function doneTime(s) {
  const m = String(s || '').match(/(\d{1,2}):(\d{2})\s*([AP])M/i);
  if (!m) return 0;
  const d = new Date();
  d.setHours((Number(m[1]) % 12) + (/p/i.test(m[3]) ? 12 : 0), Number(m[2]), 0, 0);
  if (d.getTime() > Date.now() + 60000) d.setDate(d.getDate() - 1); // a time later than now was yesterday
  return d.getTime();
}
const lastUsed = (p) => (p.state === 'working' ? Date.now() : Math.max(p.used || 0, doneTime(p.doneAt)));
const byPriority = (a, b) => RANK[status(a)] - RANK[status(b)] || lastUsed(b) - lastUsed(a) || b.since - a.since;
// questions put to you (the openone server's asks) come first, then the agents
const askItems = () => (S.asks || []).map((a) => ({ key: `ask:${a.id}`, ask: a }));
const inbox = () => [...askItems(), ...S.panes.filter((p) => p.unseen && p.kind).sort(byPriority)];
const curAsk = () => { const it = view === 'inbox' && askItems().find((x) => x.key === cur); return it ? it.ask : null; };
const find = (key) => S.panes.find((p) => p.key === key);

function ago(t) {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// idle panes show the agent's own finish time; live ones show how long they've been at it
function when(p) {
  const st = status(p);
  if ((st === 'idle' || st === 'done') && p.doneAt) return p.doneAt.replace(/s?([AP])M$/i, (m, x) => x.toLowerCase());
  if (st === 'shell') return '';
  return ago(p.since);
}

function subline(p) {
  const st = status(p);
  if (st === 'input') return `Waiting for your answer · ${p.host}`;
  if (st === 'working') return `Working · ${p.host}`;
  if (st === 'done') return `Finished${p.doneAt ? ` ${p.doneAt}` : ''} · ${p.host}`;
  if (st === 'shell') return `Shell · ${p.host}`;
  return `Idle${p.doneAt ? ` since ${p.doneAt}` : ''} · ${p.host}`;
}

function who(p, go = true) {
  return `<div class="who" data-jump="${esc(p.key)}" title="Open in terminal">
    <div class="avatar">${ICON[p.kind] || ICON.shell}<span class="st ${status(p)}"></span></div>
    <div><div class="name">${esc(name(p))}</div><div class="sub">${esc(subline(p))}</div></div>
    ${go ? `<span class="go">${OPEN}</span>` : ''}</div>`;
}

// the latest message this agent sent or got in the last half hour (agents messaging
// each other through openone's MCP tools), as one line for its row
function mailLine(p) {
  const m = (S.messages || []).filter((x) => (x.toKey === p.key || x.fromKey === p.key) && Date.now() - x.at < 30 * 60000).pop();
  if (!m) return '';
  const short = (n) => String(n).replace(/@.*/, '');
  const text = m.toKey === p.key
    ? `${m.status === 'queued' ? 'message waiting' : m.status === 'failed' ? 'undelivered' : 'from'} ${short(m.from)}`
    : `to ${short(m.to)}${m.status === 'queued' ? ' (waiting)' : m.status === 'failed' ? ' (failed)' : ''}`;
  return `<div class="t2 mail ${m.status}" title="${esc(m.content)}">✉ ${esc(text)}: ${esc(m.content)}</div>`;
}

function marks(list, max) {
  const shown = list.slice(0, max).map((p) => `<span class="st ${status(p)}"></span>`).join('');
  const more = list.length > max ? `<span class="more">+${list.length - max}</span>` : '';
  return shown + more || '<span class="st idle"></span>';
}

// ---------- render ----------

function setHtml(el, html) {
  if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
}

let shrinkTimer = null;
function fit() {
  clearTimeout(shrinkTimer);
  if (expanded) return window.oo.size('full');
  // let the close / peek-out transition finish before shrinking the window
  const want = $('#peek').classList.contains('show') ? 'peek' : 'tab';
  if (want === 'peek') window.oo.size('peek');
  else shrinkTimer = setTimeout(() => { if (!expanded && !$('#peek').classList.contains('show')) window.oo.size('tab'); }, 260);
}

function renderChrome() {
  const live = S.panes.filter((p) => p.kind && status(p) !== 'idle').sort(byPriority);
  setHtml($('#tab-marks'), marks(live, 7));
  setHtml($('#b-agents'), marks(live, 6));
  const n = inbox().length;
  const badge = $('#b-inbox .badge');
  badge.textContent = n;
  badge.classList.toggle('show', n > 0);
  $('#b-mute').classList.toggle('muted', !!S.muted);
  $('#b-inbox').classList.toggle('on', expanded && view === 'inbox');
  $('#b-agents').classList.toggle('on', expanded && view === 'agents');
}

function inboxCard(items) {
  if (!items.some((p) => p.key === cur)) cur = items[0].key;
  const idx = items.findIndex((p) => p.key === cur);
  const p = items[idx];
  const pager = items.length > 1
    ? `<div class="pager">${items.map((x, i) => `<i class="${i === idx ? 'cur' : ''}" data-cur="${esc(x.key)}"></i>`).join('')}</div>` : '';
  if (p.ask) return askCard(p.ask, items, pager);
  let mid = '';
  if (p.state === 'input') {
    mid = `<div class="q">${esc(p.question || 'Waiting for your answer')}</div>${p.detail ? `<pre class="cmd">${esc(p.detail)}</pre>` : ''}
      <div class="opts">${(p.options || []).map((o) => `<button class="opt" data-n="${o.n}"><span class="n">${o.n}</span><span class="l">${esc(o.label)}</span>${o.recommended ? '<span class="chip">Recommended</span>' : ''}</button>`).join('')}</div>`;
  } else {
    mid = `<div class="summary">${esc(p.summary || 'Finished.')}</div>`;
  }
  const html = `<div class="head"><h1>${esc((p.state === 'input' && p.topic) || p.title || p.label)}</h1>${pager}<button class="x" data-close>${X}</button></div>
    ${who(p)}${mid}
    <div class="reply"><input id="reply" placeholder="Reply to ${esc(name(p))}…" spellcheck="false" value="${esc(drafts[p.key] || '')}"><button data-send title="Send">${SEND}</button></div>`;
  const n = (p.options || []).length;
  const hint = p.state === 'input' && n
    ? `Press ${n <= 3 ? (p.options.map((o) => `<kbd>${o.n}</kbd>`).join(n === 3 ? ', ' : ' or ').replace(/, (?=[^,]*$)/, ' or ')) : `<kbd>1</kbd> – <kbd>${n}</kbd>`} to answer`
    : `<kbd>Enter</kbd> ${OPEN_HINT}${items.length > 1 ? ' · <kbd>j</kbd><kbd>k</kbd> next' : ''}`;
  return { html, hint: `${hint} · <kbd>r</kbd> reply · <kbd>Tab</kbd> list` };
}

const ASK = '<svg viewBox="0 0 16 16" style="color:var(--input, #e5a03a)"><path d="M6 6a2 2 0 1 1 2.8 1.8c-.5.3-.8.7-.8 1.2v.5"/><circle cx="8" cy="12" r=".6"/></svg>';
function askCard(a, items, pager) {
  const html = `<div class="head"><h1>Question</h1>${pager}<button class="x" data-close>${X}</button></div>
    <div class="who"><div class="avatar">${ASK}<span class="st input"></span></div>
      <div><div class="name">${esc(a.from)}</div><div class="sub">Asked ${ago(a.at) === 'now' ? 'just now' : `${ago(a.at)} ago`}${a.default ? ` · ${esc(a.options.find((o) => o.id === a.default).label)} if no answer` : ''}</div></div></div>
    <div class="q">${esc(a.title)}</div>${a.body ? `<div class="summary">${esc(a.body)}</div>` : ''}
    <div class="opts">${a.options.map((o, i) => `<button class="opt" data-ask="${esc(a.id)}" data-opt="${esc(o.id)}"><span class="n">${i + 1}</span><span class="l">${esc(o.label)}</span></button>`).join('')}</div>`;
  const n = a.options.length;
  const hint = `Press ${n === 1 ? '<kbd>1</kbd>' : `<kbd>1</kbd> – <kbd>${n}</kbd>`} to answer${items.length > 1 ? ' · <kbd>j</kbd><kbd>k</kbd> next' : ''} · <kbd>Tab</kbd> list`;
  return { html, hint };
}

// one at a time: each waits for its agent to print how to resume it
async function sleepAgents(keys) {
  for (const key of keys) {
    const p = find(key);
    toast(`Putting ${p ? p.label : 'it'} to sleep…`);
    try { await window.oo.sleep(key); } catch (err) { toast(`${p ? p.label : 'It'}: ${err.message}`); return; }
  }
  toast(keys.length > 1 ? `${keys.length} agents asleep` : 'Asleep. Wake it from the Sleeping list.');
}

async function wake(id) {
  const r = (S.sleeping || []).find((x) => x.id === id);
  toast(`Waking ${r ? r.label : 'it'}…`);
  try { const key = await window.oo.wake(id); if (WEB && key) window.oo.jump(key); } catch (err) { toast(err.message); }
}

function answerAsk(id, opt) {
  const el = body.querySelector(`.opt[data-opt="${CSS.escape(opt)}"]`);
  if (el) el.classList.add('kb');
  window.oo.answerAsk(id, opt).catch((err) => toast(err.message));
  setTimeout(() => { S.asks = (S.asks || []).filter((a) => a.id !== id); render(); }, 140);
}

// idle agents can be put to sleep (exited, resumable later); not ones waiting or working
const canSleep = (p) => !!window.oo.sleep && !!p.kind && !p.bg && p.state === 'idle';
const MOON = '<svg viewBox="0 0 16 16"><path d="M12.8 10.2A5.2 5.2 0 0 1 5.8 3.2a5.2 5.2 0 1 0 7 7Z"/></svg>';

// what tidy mode picks to start with: idle and untouched for an hour, already read
function tidyDefaults() {
  return new Set(S.panes.filter((p) => canSleep(p) && !p.unseen && Date.now() - lastUsed(p) > 3600000).map((p) => p.key));
}

function sleepingList() {
  const list = S.sleeping || [];
  if (!list.length) return '';
  const rows = list.slice().sort((a, b) => b.sleptAt - a.sleptAt).map((r) => `<div class="row sleeping">
      <span class="st sleep"></span>
      <div class="mid"><div class="t1"><span class="nm">${esc(r.label)}</span><span class="kind">${esc(r.kind)} · ${esc(r.host)}</span></div>
      <div class="t2">${esc(r.title || r.summary || r.path)}</div></div>
      <button class="pill" data-wake="${esc(r.id)}">Wake</button><button class="icon" data-forget="${esc(r.id)}" title="Forget it">${X}</button></div>`).join('');
  return `<div class="host"><span class="dot sleep"></span>Sleeping<span class="count">${list.length}</span></div>${rows}`;
}

function agentsCard() {
  const panes = S.panes.slice().sort(byPriority);
  const counts = { input: 0, working: 0, done: 0 };
  for (const p of panes) if (counts[status(p)] !== undefined) counts[status(p)]++;
  const parts = [];
  if (counts.input) parts.push(`${counts.input} waiting`);
  if (counts.working) parts.push(`${counts.working} working`);
  if (counts.done) parts.push(`${counts.done} done`);
  let i = 0;
  const row = (p, showHost) => {
    const line = status(p) === 'input' ? (p.question || 'Waiting for your answer') : (p.title || p.summary || subline(p));
    const pick = tidy && canSleep(p);
    const tail = pick ? `<span class="check ${tidy.has(p.key) ? 'on' : ''}"></span>`
      : canSleep(p) && !tidy ? `<button class="icon zz" data-sleep="${esc(p.key)}" title="Put to sleep">${MOON}</button>` : '';
    return `<div class="row ${p.kind ? '' : 'shell'} ${i++ === kb ? 'kb' : ''} ${tidy && !pick ? 'dim' : ''}" ${pick ? `data-pick="${esc(p.key)}"` : `data-jump="${esc(p.key)}"`}>
      <span class="st ${status(p)}"></span>
      <div class="mid"><div class="t1"><span class="nm">${esc(p.label)}</span><span class="kind">${esc(p.kind || 'shell')}${p.bg ? ' · background' : ''}${showHost ? ` · ${esc(p.host)}` : ''}</span></div>
      <div class="t2">${esc(line)}</div>${mailLine(p)}</div>
      <span class="age">${esc(when(p))}</span>${tail}</div>`;
  };
  let list;
  if (query !== null) {
    // searching: one list, best match first, host on each row
    const found = window.OOSearch.filter(query, panes);
    list = `<div class="search"><input id="q" placeholder="Search agents: name, host, or words from the chat" spellcheck="false" autocomplete="off" value="${esc(query)}"></div>
      ${found.map((p) => row(p, true)).join('') || '<div class="empty">No matches</div>'}`;
  } else {
    list = S.hosts.map((h) => {
      const rows = panes.filter((p) => p.host === h.name).map((p) => row(p, false)).join('');
      const head = `<div class="host"><span class="dot ${h.ok ? '' : 'down'}"></span>${esc(h.name)}${h.ok ? '' : `<span class="err">${esc(h.error)}</span>`}</div>`;
      return head + (rows || (h.ok ? '<div class="empty">No panes</div>' : ''));
    }).join('') + (tidy ? '' : sleepingList());
  }
  const sleepable = S.panes.filter(canSleep).length;
  const tools = tidy
    ? `<button class="pill go" data-tidy-go ${tidy.size ? '' : 'disabled'}>Sleep ${tidy.size}</button><button class="pill" data-tidy-x>Cancel</button>`
    : sleepable && query === null ? '<button class="pill" data-tidy title="Pick idle agents to put to sleep">Tidy up</button>' : '';
  const html = `<div class="head"><h1>${tidy ? 'Put to sleep' : 'Agents'}${parts.length && !tidy ? ` <span style="color:var(--muted);font-weight:500;font-size:12.5px">· ${parts.join(' · ')}</span>` : ''}</h1>${tools}<button class="x" data-close>${X}</button></div>
    ${tidy ? '<div class="note">Picked: idle for over an hour. Each exits and can be woken later in the same conversation.</div>' : ''}${list}`;
  const n = inbox().length;
  const hint = query !== null
    ? `<kbd>↑</kbd><kbd>↓</kbd> pick · <kbd>Enter</kbd> ${OPEN_HINT} · <kbd>Esc</kbd> clear`
    : `<kbd>j</kbd><kbd>k</kbd> pick · <kbd>Enter</kbd> open · <kbd>/</kbd> search · <kbd>n</kbd> project${n ? ` · <kbd>Tab</kbd> inbox` : ''}`;
  return { html, hint };
}

// ---------- projects: "n" starts or continues work in a workspace folder ----------
//
// Describe the work. Before offering to start fresh, it checks every host for work that
// already covers it: agents whose title/summary match (Enter jumps there), and project
// folders whose name or README match (with the words that matched). Then the confirm
// step: name and host for a new folder, the agent, continue or new chat, and whether
// what you typed goes to the agent as its first message.

// proj: { q, list, sel, pick, row, busy }
// pick: { name, host, create, agent, resume, send, prompt }
let proj = null;
let projCache = null;
const AGENT_KINDS = ['claude', 'codex'];
const base = (s) => String(s || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop().toLowerCase();
const SIMILAR = 0.42; // embedding similarity that means "about the same thing" (see src/embed.js)
const slug = (t) => String(t).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '').replace(/-{2,}/g, '-').slice(0, 40);

function openProjects() {
  view = 'project';
  proj = { q: '', list: projCache && Date.now() - projCache.at < 60000 ? projCache.list : null, sel: 0, pick: null, row: 0 };
  sig = '';
  render();
  const q = $('#pq');
  if (q) q.focus();
  if (!proj.list && window.oo.projects) {
    window.oo.projects().then((list) => {
      projCache = { list, at: Date.now() };
      if (proj) { proj.list = list; render(); }
    }).catch((e) => { if (proj) { proj.list = []; proj.error = e.message; render(); } });
  }
}

let meaningTimer = null;
function askMeaning() {
  clearTimeout(meaningTimer);
  meaningTimer = setTimeout(async () => {
    if (!proj || !window.oo.semantic) return;
    const { text } = projQuery();
    if (!text) return;
    const res = await window.oo.semantic(text).catch(() => null);
    if (proj && res && projQuery().text === text) { proj.sem = { q: text, ...res }; render(); }
  }, 150);
}

function closeProjects() {
  proj = null;
  view = 'agents';
  sig = '';
  if (document.activeElement) document.activeElement.blur();
  render();
  selectTop();
}

// "2 claude, 1 codex"
const counted = (panes) => Object.entries(panes.reduce((m, p) => ({ ...m, [p.kind]: (m[p.kind] || 0) + 1 }), {}))
  .map(([k, n]) => `${n} ${esc(k)}`).join(', ');
const running = (host, name) => S.panes.filter((p) => p.kind && p.host === host && base(p.path) === name.toLowerCase());

// words naming a host pick that host; the rest describes the work
function projQuery() {
  const names = (proj.list || []).map((x) => x.host.toLowerCase());
  const words = proj.q.trim().split(/\s+/).filter(Boolean);
  const host = words.map((w) => w.toLowerCase()).find((w) => names.includes(w)) || null;
  return { host, text: words.filter((w) => w.toLowerCase() !== host).join(' ') };
}

const hostName = (lower) => (lower && (proj.list || []).find((x) => x.host.toLowerCase() === lower) || {}).host || null;

// "google drive maintenance for my photos folder" -> "google-drive-maintenance"
function suggestName(text) {
  const keep = String(text).split(/\s+/).filter((w) => window.OOSearch.words(w).length).slice(0, 3);
  return slug(keep.join(' ') || text) || 'project';
}

// the words of `text` that matched, in bold
function marked(text, hits) {
  const stems = hits.map((h) => h.word);
  return esc(text).replace(/[A-Za-z0-9]+/g, (w) => (window.OOSearch.words(w).some((x) => stems.includes(x)) ? `<b>${w}</b>` : w));
}

// [{ type: 'agent'|'project'|'new', ... , section }]
function projRows() {
  const { host, text } = projQuery();
  const all = (proj.list || []).filter((x) => !host || x.host.toLowerCase() === host)
    .flatMap((x) => x.dirs.map((d) => ({ type: 'project', host: x.host, name: d.name, mtime: d.mtime, about: d.about || '' })));
  if (!text) {
    return all.sort((a, b) => running(b.host, b.name).length - running(a.host, a.name).length || b.mtime - a.mtime)
      .slice(0, 9).map((r) => ({ ...r, section: 'Recent projects' }));
  }
  const S2 = window.OOSearch;
  // matches by words (exact, explainable) and by meaning (embeddings, when the answer for
  // this text has arrived), blended: a strong meaning match counts like a name match
  const sem = proj.sem && proj.sem.q === text ? proj.sem : null;
  const blend = (kw, sim) => (kw ? kw.score : 0) + (sim >= SIMILAR ? sim * 10 : 0);
  const livePanes = S.panes.filter((p) => p.kind && (!host || p.host.toLowerCase() === host));
  const kwAgents = new Map(S2.related(text, livePanes.map((p) => ({ name: p.label, text: [p.title, p.question, p.summary].join(' '), p })), { min: 2 })
    .map((m) => [m.doc.p.key, m]));
  const agents = livePanes.map((p) => ({ p, kw: kwAgents.get(p.key), sim: sem ? sem.agents[p.key] || 0 : 0 }))
    .filter((x) => x.kw || x.sim >= SIMILAR + 0.03)
    .sort((a, b) => blend(b.kw, b.sim) - blend(a.kw, a.sim)).slice(0, 3)
    .map((x) => ({ type: 'agent', p: x.p, hits: x.kw ? x.kw.hits : [], sim: x.sim, section: 'Already running' }));
  const kwProjects = new Map(S2.related(text, all.map((r) => ({ name: r.name, text: r.about, r }))).map((m) => [`${m.doc.r.host}|${m.doc.r.name}`, m]));
  const projects = all.map((r) => ({ r, kw: kwProjects.get(`${r.host}|${r.name}`), sim: sem ? sem.projects[`${r.host}|${r.name}`] || 0 : 0 }))
    .filter((x) => x.kw || x.sim >= SIMILAR)
    .sort((a, b) => blend(b.kw, b.sim) - blend(a.kw, a.sim)).slice(0, 6)
    .map((x) => ({ ...x.r, hits: x.kw ? x.kw.hits : [], sim: x.sim, section: 'Existing projects' }));
  const name = suggestName(text);
  const rows = [...agents, ...projects];
  if (!all.some((r) => r.name.toLowerCase() === name)) {
    rows.push({ type: 'new', name, host: hostName(host) || ((proj.list || []).length === 1 ? proj.list[0].host : null), section: 'Start fresh' });
  }
  return rows;
}

// found by meaning rather than shared words
const likeTag = (r) => (r.sim >= SIMILAR && !(r.hits || []).length ? '<span class="like" title="Similar in meaning">similar</span>' : '');

function rowHtml(r, i) {
  const cls = `row ${i === proj.sel ? 'kb' : ''}`;
  if (r.type === 'agent') {
    const p = r.p;
    const line = p.title || p.summary || p.question || '';
    return `<div class="${cls}" data-proj="${i}"><span class="st ${status(p)}"></span>
      <div class="mid"><div class="t1"><span class="nm">${esc(p.label)}</span><span class="kind">${esc(p.kind)} · ${esc(p.host)}</span>${likeTag(r)}</div>
      <div class="t2">${marked(line, r.hits)}</div></div><span class="go">${OPEN}</span></div>`;
  }
  if (r.type === 'new') {
    return `<div class="${cls}" data-proj="${i}"><span class="st new"></span>
      <div class="mid"><div class="t1"><span class="nm">＋ ${esc(r.name)}</span></div>
      <div class="t2">New folder${r.host ? ` on ${esc(r.host)}` : ' · pick a host next'}</div></div></div>`;
  }
  const run = running(r.host, r.name);
  const why = r.hits && r.about ? marked(r.about, r.hits) : esc(r.about);
  return `<div class="${cls}" data-proj="${i}"><span class="st ${run.length ? 'live' : 'idle'}"></span>
    <div class="mid"><div class="t1"><span class="nm">${r.hits ? marked(r.name, r.hits.filter((h) => h.where === 'name')) : esc(r.name)}</span>
    <span class="kind">${esc(r.host)}${run.length ? ` · ${counted(run)} open` : ''}</span>${likeTag(r)}</div>
    ${why ? `<div class="t2 about">${why}</div>` : ''}</div></div>`;
}

function chips(values, current, row) {
  return values.map((v) => `<span class="chip2 ${v === current ? 'on' : ''}">${esc(v)}</span>`).join('') +
    (row === proj.row ? '<span class="arrows">← →</span>' : '');
}

function projectOptions() {
  const p = proj.pick;
  const opts = [];
  if (p.create) opts.push({ key: 'name', label: 'Name' });
  if (p.create) opts.push({ key: 'host', label: 'Host', values: (proj.list || []).filter((x) => !x.error).map((x) => x.host) });
  opts.push({ key: 'agent', label: 'Agent', values: AGENT_KINDS });
  if (!p.create) opts.push({ key: 'resume', label: 'Chat', values: ['continue last', 'new chat'] });
  if (p.prompt) opts.push({ key: 'send', label: 'Message', values: ['send it', "don't"] });
  return opts;
}

function projectCard() {
  const head = (t) => `<div class="head"><h1>${t}</h1><button class="x" data-close>${X}</button></div>`;
  if (!proj.pick) {
    const rows = proj.list ? projRows() : [];
    proj.sel = Math.min(proj.sel, Math.max(rows.length - 1, 0));
    const errs = (proj.list || []).filter((x) => x.error).map((x) => `<div class="empty">${esc(x.host)}: ${esc(x.error)}</div>`).join('');
    const found = rows.filter((r) => r.type !== 'new' && r.section !== 'Recent projects').length;
    const { text } = proj.list ? projQuery() : { text: '' };
    const verdict = !text ? '' : found
      ? `<div class="verdict">${found === 1 ? 'Something' : `${found} things`} might already cover this. Pick one to continue, or start fresh.</div>`
      : '<div class="verdict fresh">Nothing like this yet on any machine. Start fresh below.</div>';
    let section = '';
    const list = !proj.list ? '<div class="empty">Looking through your projects…</div>' : rows.map((r, i) => {
      const h = r.section !== section ? `<div class="host">${esc(r.section)}</div>` : '';
      section = r.section;
      return h + rowHtml(r, i);
    }).join('') + errs || '<div class="empty">Describe what you want to work on</div>';
    const html = `${head('What are you working on?')}<div class="search"><input id="pq" placeholder="e.g. google drive cleanup for my photos${(proj.list || []).length > 1 ? ` (say ${esc(proj.list.map((x) => x.host).join(' or '))} to pick)` : ''}" spellcheck="false" autocomplete="off" value="${esc(proj.q)}"></div>${verdict}${list}`;
    return { html, hint: `<kbd>↑</kbd><kbd>↓</kbd> pick · <kbd>Enter</kbd> choose · <kbd>Esc</kbd> back` };
  }
  const p = proj.pick;
  const ws = (proj.list || []).find((x) => x.host === p.host);
  const sep = ws && /\\/.test(ws.workspace) ? '\\' : '/';
  const where = ws ? `${p.create ? 'New folder: ' : ''}${esc(ws.workspace)}${sep}${esc(slug(p.name) || '…')}` : 'Pick a host';
  const opts = projectOptions();
  proj.row = Math.min(proj.row, opts.length - 1);
  const value = (o) => (o.key === 'resume' ? (p.resume ? 'continue last' : 'new chat') : o.key === 'send' ? (p.send ? 'send it' : "don't") : p[o.key]);
  const run = p.create || !p.host ? [] : running(p.host, p.name);
  const optHtml = opts.map((o, i) => {
    const body = o.key === 'name'
      ? `<input id="pn" value="${esc(p.name)}" spellcheck="false" autocomplete="off">`
      : chips(o.values, value(o), i);
    return `<div class="opt2 ${i === proj.row ? 'kb' : ''}" data-row="${i}"><span class="lbl">${o.label}</span>${body}</div>`;
  }).join('');
  const html = `${head(`${esc(slug(p.name) || p.name)}${p.host ? ` <span class="on-host">· ${esc(p.host)}</span>` : ''}`)}<div class="where">${where}</div>
    ${optHtml}
    ${p.prompt && p.send ? `<div class="first">First message: “${esc(p.prompt.length > 160 ? `${p.prompt.slice(0, 160)}…` : p.prompt)}”</div>` : ''}
    ${run.length ? `<div class="already">Already running here: ${run.map((x) => `<button class="go2" data-jump="${esc(x.key)}">${esc(x.kind)} · ${esc(String(x.title || `window ${x.windowIndex}`).slice(0, 28))}</button>`).join(' ')}</div>` : ''}
    <div class="acts"><button class="start" data-start>Start ${esc(p.agent)}</button>${window.oo.code && !p.create ? '<button class="go2" data-code>VS Code</button>' : ''}</div>
    ${proj.busy ? `<div class="empty">${esc(proj.busy)}</div>` : ''}`;
  return { html, hint: `<kbd>↑</kbd><kbd>↓</kbd> option · <kbd>←</kbd><kbd>→</kbd> change · <kbd>Enter</kbd> start${run.length ? ' · <kbd>g</kbd> go' : ''} · <kbd>Esc</kbd> back` };
}

// after a render, the name box has focus exactly when its row is selected
function focusProjectRow() {
  if (!proj || !proj.pick) return;
  const o = projectOptions()[proj.row];
  const pn = $('#pn');
  if (o && o.key === 'name' && pn) { if (document.activeElement !== pn) { pn.focus(); pn.select(); } }
  else if (document.activeElement && document.activeElement.id === 'pn') document.activeElement.blur();
}

function choose(i) {
  const r = projRows()[i];
  if (!r) return;
  if (r.type === 'agent') { jump(r.p.key); return; }
  const { text } = projQuery();
  // what you typed is worth sending when it says more than the folder's name
  const prompt = text && slug(text) !== r.name.toLowerCase() ? text : '';
  proj.pick = {
    name: r.name, host: r.host, create: r.type === 'new', agent: localStorage.getItem('oo.agent') || 'claude',
    resume: r.type !== 'new', send: !!prompt, prompt,
  };
  const opts = projectOptions();
  proj.row = r.type === 'new' && !r.host ? opts.findIndex((o) => o.key === 'host') : opts.findIndex((o) => o.key === 'agent');
  sig = '';
  if (document.activeElement) document.activeElement.blur();
  render();
  focusProjectRow();
}

function changeOption(d) {
  const o = projectOptions()[proj.row];
  const p = proj.pick;
  if (!o || o.key === 'name') return;
  if (o.key === 'resume') p.resume = !p.resume;
  else if (o.key === 'send') p.send = !p.send;
  else {
    const i = o.values.indexOf(p[o.key]);
    p[o.key] = o.values[((i < 0 ? (d > 0 ? -1 : 0) : i) + d + o.values.length) % o.values.length];
    if (o.key === 'agent') { try { localStorage.setItem('oo.agent', p.agent); } catch {} }
  }
  proj.busy = '';
  render();
}

function moveRow(d) {
  const n = projectOptions().length;
  proj.row = (proj.row + d + n) % n;
  render();
  focusProjectRow();
}

async function launch() {
  const p = proj.pick;
  const opts = projectOptions();
  if (p.create && !slug(p.name)) { proj.row = opts.findIndex((o) => o.key === 'name'); proj.busy = 'Give it a name'; render(); focusProjectRow(); return; }
  if (!p.host) { proj.row = opts.findIndex((o) => o.key === 'host'); proj.busy = 'Pick a host first (← →)'; render(); focusProjectRow(); return; }
  proj.busy = `Starting ${p.agent} on ${p.host}…`;
  render();
  try {
    await window.oo.startProject({
      host: p.host, folder: p.create ? slug(p.name) : p.name, create: p.create, agent: p.agent, resume: p.resume,
      prompt: p.send ? p.prompt : '',
    });
    projCache = null;
    proj = null;
    view = 'agents';
  } catch (e) {
    if (proj) { proj.busy = `Couldn't start: ${e.message}`; render(); }
  }
}

function projectKey(e) {
  if (!proj.pick) {
    const n = projRows().length;
    const down = e.key === 'ArrowDown' || (e.ctrlKey && (e.key === 'j' || e.key === 'n'));
    const up = e.key === 'ArrowUp' || (e.ctrlKey && (e.key === 'k' || e.key === 'p'));
    if (down || up) {
      e.preventDefault();
      if (n) { proj.sel = (proj.sel + (down ? 1 : -1) + n) % n; render(); const row = body.querySelector('.row.kb'); if (row) row.scrollIntoView({ block: 'nearest' }); }
    } else if (e.key === 'Enter') { e.preventDefault(); choose(proj.sel); }
    else if (e.key === 'Escape') { e.preventDefault(); if (proj.q) { proj.q = ''; proj.sel = 0; render(); } else closeProjects(); }
    else if (e.key === 'Tab') e.preventDefault();
    return;
  }
  const naming = e.target.id === 'pn'; // letters belong to the name box
  const run = proj.pick.create ? [] : running(proj.pick.host, proj.pick.name);
  if (e.key === 'Escape') { e.preventDefault(); proj.pick = null; proj.busy = ''; sig = ''; if (document.activeElement) document.activeElement.blur(); render(); const q = $('#pq'); if (q) q.focus(); }
  else if (e.key === 'ArrowDown' || (!naming && e.key === 'j') || e.key === 'Tab') { e.preventDefault(); moveRow(e.shiftKey ? -1 : 1); }
  else if (e.key === 'ArrowUp' || (!naming && e.key === 'k')) { e.preventDefault(); moveRow(-1); }
  else if (naming) { if (e.key === 'Enter') { e.preventDefault(); launch(); } }
  else if (e.key === 'ArrowRight' || e.key === 'l') { e.preventDefault(); changeOption(1); }
  else if (e.key === 'ArrowLeft' || e.key === 'h') { e.preventDefault(); changeOption(-1); }
  else if (e.key === 'Enter') { e.preventDefault(); if (!/^Starting/.test(proj.busy || '')) launch(); }
  else if (e.key === 'g' && run.length) jump(run[0].key);
  else if (e.key === 'o' && window.oo.code) {
    if (!proj.pick.host) { proj.busy = 'Pick a host first (← →)'; render(); return; }
    if (proj.pick.create) { proj.busy = 'Start it first; the folder doesn\'t exist yet'; render(); return; }
    window.oo.code({ host: proj.pick.host, folder: proj.pick.name }).catch((err) => { proj.busy = err.message; render(); });
  }
}

function render() {
  renderChrome();
  if (!expanded) return;
  const items = inbox();
  const showInbox = view === 'inbox' && items.length;
  const projecting = view === 'project' && proj;
  const { html, hint } = projecting ? projectCard() : showInbox ? inboxCard(items) : agentsCard();
  const next = `${projecting ? 'p' : showInbox ? 'i' : 'a'}|${html}|${hint}`;
  if (next !== sig) {
    // keep the reply or search box focused, caret and all, across the rebuild
    const a = document.activeElement;
    const focused = a && ['reply', 'q', 'pq', 'pn'].includes(a.id) ? a.id : null;
    const caret = focused ? a.selectionStart : 0;
    const top = body.scrollTop;
    body.innerHTML = html;
    body.scrollTop = top;
    if ($('#hint').dataset.text !== hint) { $('#hint').innerHTML = `<span>${hint}</span>`; $('#hint').dataset.text = hint; showHint(!!hint); }
    sig = next;
    const el = focused && document.getElementById(focused);
    if (el) { el.focus(); el.setSelectionRange(caret, caret); }
  }
  $('#b-inbox').classList.toggle('on', !!showInbox && !projecting);
  $('#b-agents').classList.toggle('on', !showInbox && !projecting);
  layout();
}

// The key hint is a reminder, not a control: show it for a few seconds when the card
// opens or its keys change, then get out of the way.
function showHint(on) {
  clearTimeout(hintTimer);
  $('#hint').classList.toggle('show', on);
  if (on) hintTimer = setTimeout(() => $('#hint').classList.remove('show'), 4000);
}

function layout() {
  const card = $('#card').getBoundingClientRect();
  const btn = ($('#b-inbox').classList.contains('on') ? $('#b-inbox') : $('#b-agents')).getBoundingClientRect();
  const y = btn.top + btn.height / 2 - card.top - 6;
  $('.caret').style.top = `${Math.max(16, Math.min(card.height - 28, y))}px`;
  $('#hint').style.top = `${card.bottom + 12}px`;
}

// ---------- actions ----------

function expand(v, key) {
  expanded = true;
  window.oo.size('full');
  view = v || (inbox().length ? 'inbox' : 'agents');
  if (key) cur = key;
  kb = -1;
  void root.offsetWidth;
  root.classList.replace('collapsed', 'expanded');
  hidePeek();
  sig = '';
  $('#hint').dataset.text = '';
  render();
  if (view === 'agents') selectTop();
  window.oo.focus();
}

function collapse() {
  if (!expanded || WEB) return;
  expanded = false;
  query = null;
  tidy = null;
  if (proj) { proj = null; view = 'agents'; }
  root.classList.replace('expanded', 'collapsed');
  showHint(false);
  fit();
  if (document.activeElement) document.activeElement.blur();
  render();
}

function seenLocally(key) {
  const p = find(key);
  if (p) p.unseen = false;
}

function jump(key) {
  seenLocally(key);
  collapse();
  window.oo.jump(key);
}

function answer(key, n) {
  const el = body.querySelector(`.opt[data-n="${n}"]`);
  if (el) el.classList.add('kb');
  window.oo.answer(key, n);
  setTimeout(() => { seenLocally(key); render(); }, 140);
}

function sendReply() {
  const input = $('#reply');
  const text = input && input.value.trim();
  if (!text || !cur) return;
  const key = cur;
  delete drafts[key];
  input.value = '';
  input.blur();
  window.oo.reply(key, text);
  seenLocally(key);
  render();
}

function switchView() {
  view = view === 'agents' && inbox().length ? 'inbox' : 'agents';
  kb = -1;
  sig = '';
  render();
  if (view === 'agents') selectTop();
}

function selectTop() {
  const top = S.panes.slice().sort(byPriority)[0];
  const rows = [...body.querySelectorAll('.row')];
  kb = Math.max(0, rows.findIndex((r) => top && r.dataset.jump === top.key));
  if (rows.length) render();
}

function step(d) {
  if (view === 'inbox' && inbox().length) {
    const items = inbox();
    const i = items.findIndex((p) => p.key === cur);
    cur = items[(i + d + items.length) % items.length].key;
  } else {
    const n = body.querySelectorAll('.row').length;
    if (!n) return;
    kb = kb < 0 ? (d > 0 ? 0 : n - 1) : (kb + d + n) % n;
  }
  render();
  const row = body.querySelector('.row.kb');
  if (row) row.scrollIntoView({ block: 'nearest' });
}

function hidePeek() {
  $('#peek').classList.remove('show');
  fit();
  peekKey = null;
}

function peek({ key, type }) {
  setTimeout(() => {
    const p = find(key);
    if (!p || expanded) return;
    peekKey = key;
    const line = type === 'input' ? (p.question || 'Waiting for your answer') : (p.summary || p.title || 'Finished');
    $('#peek').innerHTML = `${who(p, false)}<div class="line">${esc(line)}</div>`;
    window.oo.size('peek');
    void $('#peek').offsetWidth;
    $('#peek').classList.add('show');
    clearTimeout(peekTimer);
    peekTimer = setTimeout(() => { if (!$('#peek').matches(':hover')) hidePeek(); else peekTimer = setTimeout(hidePeek, 3000); }, 7000);
  }, 90);
}

// ---------- wiring ----------

let ignoring = true;
window.addEventListener('mousemove', (e) => {
  const hit = !!(e.target.closest && e.target.closest('.hit'));
  if (hit === ignoring) {
    ignoring = !hit;
    window.oo.ignore(ignoring);
  }
});

$('#tab').addEventListener('click', () => expand());
$('#peek').addEventListener('click', () => expand('inbox', peekKey));
$('#b-inbox').addEventListener('click', () => { view = 'inbox'; sig = ''; render(); });
$('#b-agents').addEventListener('click', () => { view = 'agents'; kb = -1; sig = ''; render(); });
$('#b-mute').addEventListener('click', () => window.oo.mute());
$('#b-more').addEventListener('click', () => window.oo.menu());
$('#b-term').addEventListener('click', () => {
  const p = (inbox().length && find(cur)) || S.panes.filter((x) => x.kind).sort(byPriority)[0];
  if (p) jump(p.key);
});

body.addEventListener('click', (e) => {
  const t = e.target.closest('[data-close],[data-jump],[data-n],[data-send],[data-cur],[data-proj],[data-row],[data-start],[data-code],[data-ask],[data-sleep],[data-wake],[data-forget],[data-pick],[data-tidy],[data-tidy-go],[data-tidy-x]');
  if (!t) return;
  if (t.dataset.sleep) { e.stopPropagation(); sleepAgents([t.dataset.sleep]); return; }
  if (t.dataset.wake) { wake(t.dataset.wake); return; }
  if (t.dataset.forget) { window.oo.forgetSleeping(t.dataset.forget).catch((err) => toast(err.message)); return; }
  if (t.dataset.pick) { if (tidy.has(t.dataset.pick)) tidy.delete(t.dataset.pick); else tidy.add(t.dataset.pick); render(); return; }
  if (t.dataset.tidy !== undefined) { tidy = tidyDefaults(); kb = -1; render(); return; }
  if (t.dataset.tidyX !== undefined) { tidy = null; render(); return; }
  if (t.dataset.tidyGo !== undefined) { const keys = [...tidy]; tidy = null; sleepAgents(keys); return; }
  if (t.dataset.ask) { answerAsk(t.dataset.ask, t.dataset.opt); return; }
  if (t.dataset.start !== undefined) { launch(); return; }
  if (t.dataset.code !== undefined) { window.oo.code({ host: proj.pick.host, folder: proj.pick.name }).catch((err) => toast(err.message)); return; }
  if (t.dataset.proj !== undefined) { proj.sel = Number(t.dataset.proj); choose(proj.sel); return; }
  if (t.dataset.row !== undefined) {
    proj.row = Number(t.dataset.row);
    if ((projectOptions()[proj.row] || {}).key === 'name') { render(); focusProjectRow(); } else changeOption(1);
    return;
  }
  if (t.dataset.close !== undefined) collapse();
  else if (t.dataset.jump) jump(t.dataset.jump);
  else if (t.dataset.n) answer(cur, Number(t.dataset.n));
  else if (t.dataset.send !== undefined) sendReply();
  else if (t.dataset.cur) { cur = t.dataset.cur; render(); }
});
body.addEventListener('input', (e) => {
  if (e.target.id === 'reply' && cur) drafts[cur] = e.target.value;
  if (e.target.id === 'q') { query = e.target.value; kb = 0; render(); body.scrollTop = 0; }
  if (e.target.id === 'pq' && proj) { proj.q = e.target.value; proj.sel = 0; render(); askMeaning(); }
  if (e.target.id === 'pn' && proj && proj.pick) { proj.pick.name = e.target.value; proj.busy = ''; render(); }
});

function openSearch() {
  view = 'agents';
  if (query === null) query = '';
  kb = 0;
  sig = '';
  render();
  const q = $('#q');
  if (q) { q.focus(); q.select(); }
}

function closeSearch() {
  query = null;
  sig = '';
  if (document.activeElement) document.activeElement.blur();
  render();
  selectTop();
}

// keys while the search box has focus: it keeps the letters, so moving is arrows or Ctrl+j/k/n/p
function searchKey(e) {
  const down = e.key === 'ArrowDown' || (e.ctrlKey && (e.key === 'j' || e.key === 'n'));
  const up = e.key === 'ArrowUp' || (e.ctrlKey && (e.key === 'k' || e.key === 'p'));
  if (down || up) { e.preventDefault(); step(down ? 1 : -1); }
  else if (e.key === 'Enter') { const row = body.querySelectorAll('.row')[Math.max(kb, 0)]; if (row) jump(row.dataset.jump); }
  else if (e.key === 'Escape') { e.preventDefault(); if (query) { query = ''; kb = 0; render(); } else closeSearch(); }
  else if (e.key === 'Tab') e.preventDefault();
}

document.addEventListener('keydown', (e) => {
  if (!expanded) return;
  // keys belong to the web build's overlays (pane viewer, forms) while they're open
  if (e.target.closest && e.target.closest('#sheet, #webmenu')) return;
  if (WEB && document.querySelector('#sheet.show')) return;
  const typing = e.target.tagName === 'INPUT';
  if (e.target.id === 'q') return searchKey(e);
  if (view === 'project' && proj) return projectKey(e);
  if (e.key === 'Escape' && tidy) { tidy = null; render(); return; }
  if (e.key === 'Escape' && query !== null && !typing) { closeSearch(); return; }
  if (e.key === 'Escape') { if (typing) e.target.blur(); else collapse(); return; }
  if (typing) { if (e.key === 'Enter' && e.target.id === 'reply') sendReply(); return; }
  const q = curAsk();
  if (q && /^[1-4]$/.test(e.key) && q.options[Number(e.key) - 1]) { answerAsk(q.id, q.options[Number(e.key) - 1].id); return; }
  if (q && (e.key === 'Enter' || e.key === 'r')) return;
  const p = view === 'inbox' && inbox().length ? find(cur) : null;
  if (p && p.state === 'input' && /^[1-9]$/.test(e.key) && (p.options || []).some((o) => o.n === Number(e.key))) {
    answer(p.key, Number(e.key));
  } else if (e.key === 'Tab' || e.key === 'a') { e.preventDefault(); switchView(); }
  else if (e.key === 'ArrowDown' || e.key === 'ArrowRight' || e.key === 'j') { e.preventDefault(); step(1); }
  else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'k') { e.preventDefault(); step(-1); }
  else if (e.key === 'Enter') {
    if (p) jump(p.key);
    else if (kb >= 0) { const row = body.querySelectorAll('.row')[kb]; if (row) jump(row.dataset.jump); }
  } else if (e.key === '/') { e.preventDefault(); openSearch(); }
  else if (e.key === 'n' && window.oo.projects) { e.preventDefault(); openProjects(); }
  else if (e.key === 'o' && window.oo.code && view === 'agents' && kb >= 0) {
    const row = body.querySelectorAll('.row')[kb];
    if (row) window.oo.code({ key: row.dataset.jump }).catch((err) => toast(err.message));
  }
  else if (e.key === 'r') {
    // from the agent list, reply to the selected agent if it's waiting in the inbox
    if (view === 'agents' && kb >= 0) {
      const row = body.querySelectorAll('.row')[kb];
      if (!row || !inbox().some((x) => x.key === row.dataset.jump)) return;
      cur = row.dataset.jump;
      view = 'inbox';
      sig = '';
      render();
    }
    const r = $('#reply');
    if (r) { e.preventDefault(); r.focus(); }
  }
});

window.oo.on('state', (s) => { S = s; render(); });
window.oo.on('peek', peek);
window.oo.on('collapse', collapse);
window.oo.on('expand', () => expand('agents'));
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3500);
}
window.oo.on('toast', toast);
window.ooProjects = openProjects; // the web build's menu opens it (no "n" key on a phone)
setInterval(() => { if (expanded && view === 'agents') render(); }, 30000);
window.oo.ready();
