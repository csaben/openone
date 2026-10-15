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
const ORDER = { input: 0, done: 1, working: 2, idle: 3, shell: 4 };

const status = (p) => (p.state === 'idle' && p.unseen ? 'done' : p.state);
const name = (p) => `${p.kind || 'shell'} · ${p.label}`;
const byPriority = (a, b) => ORDER[status(a)] - ORDER[status(b)] || b.since - a.since;
const inbox = () => S.panes.filter((p) => p.unseen && p.kind).sort(byPriority);
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
    return `<div class="row ${p.kind ? '' : 'shell'} ${i++ === kb ? 'kb' : ''}" data-jump="${esc(p.key)}">
      <span class="st ${status(p)}"></span>
      <div class="mid"><div class="t1"><span class="nm">${esc(p.label)}</span><span class="kind">${esc(p.kind || 'shell')}${p.bg ? ' · background' : ''}${showHost ? ` · ${esc(p.host)}` : ''}</span></div>
      <div class="t2">${esc(line)}</div></div>
      <span class="age">${esc(when(p))}</span></div>`;
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
    }).join('');
  }
  const html = `<div class="head"><h1>Agents${parts.length ? ` <span style="color:var(--muted);font-weight:500;font-size:12.5px">· ${parts.join(' · ')}</span>` : ''}</h1><button class="x" data-close>${X}</button></div>${list}`;
  const n = inbox().length;
  const hint = query !== null
    ? `<kbd>↑</kbd><kbd>↓</kbd> pick · <kbd>Enter</kbd> ${OPEN_HINT} · <kbd>Esc</kbd> clear`
    : `<kbd>j</kbd><kbd>k</kbd> pick · <kbd>Enter</kbd> ${OPEN_HINT} · <kbd>/</kbd> search · <kbd>n</kbd> project${n ? ` · <kbd>Tab</kbd> inbox (${n})` : ''}`;
  return { html, hint };
}

// ---------- projects: "n" starts or continues work in a workspace folder ----------

// proj: { q, list, at, sel, pick, row, busy }; pick: { name, host, create, agent, resume }
let proj = null;
let projCache = null;
const AGENT_KINDS = ['claude', 'codex'];
const base = (s) => String(s || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop().toLowerCase();
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

// words naming a host pick that host; the rest is the project
function projQuery() {
  const names = (proj.list || []).map((x) => x.host.toLowerCase());
  const words = proj.q.trim().split(/\s+/).filter(Boolean);
  const host = words.map((w) => w.toLowerCase()).find((w) => names.includes(w)) || null;
  return { host, text: words.filter((w) => w.toLowerCase() !== host).join(' ') };
}

function projRows() {
  const { host, text } = projQuery();
  const all = (proj.list || []).filter((x) => !host || x.host.toLowerCase() === host)
    .flatMap((x) => x.dirs.map((d) => ({ host: x.host, name: d.name, mtime: d.mtime })));
  let rows;
  if (!text) rows = all.slice().sort((a, b) => running(b.host, b.name).length - running(a.host, a.name).length || b.mtime - a.mtime);
  else rows = all.map((r) => ({ r, s: window.OOSearch.score(text, { label: r.name }) })).filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || running(b.r.host, b.r.name).length - running(a.r.host, a.r.name).length || b.r.mtime - a.r.mtime)
    .map((x) => x.r);
  rows = rows.slice(0, 9);
  const name = slug(text);
  if (name && !all.some((r) => r.name.toLowerCase() === name)) {
    const hostName = host && (proj.list || []).find((x) => x.host.toLowerCase() === host).host;
    rows.push({ create: true, name, host: hostName || ((proj.list || []).length === 1 ? proj.list[0].host : null) });
  }
  return rows;
}

function chips(values, current, row) {
  return values.map((v) => `<span class="chip2 ${v === current ? 'on' : ''}">${esc(v)}</span>`).join('') +
    (row === proj.row ? '<span class="arrows">← →</span>' : '');
}

function projectOptions() {
  const p = proj.pick;
  const opts = [];
  if (p.create) opts.push({ key: 'host', label: 'Host', values: (proj.list || []).filter((x) => !x.error).map((x) => x.host) });
  opts.push({ key: 'agent', label: 'Agent', values: AGENT_KINDS });
  if (!p.create) opts.push({ key: 'resume', label: 'Chat', values: ['continue last', 'new chat'] });
  return opts;
}

function projectCard() {
  const head = (t) => `<div class="head"><h1>${t}</h1><button class="x" data-close>${X}</button></div>`;
  if (!proj.pick) {
    const rows = proj.list ? projRows() : [];
    proj.sel = Math.min(proj.sel, Math.max(rows.length - 1, 0));
    const errs = (proj.list || []).filter((x) => x.error).map((x) => `<div class="empty">${esc(x.host)}: ${esc(x.error)}</div>`).join('');
    const list = !proj.list ? '<div class="empty">Reading folders…</div>' : rows.map((r, i) => {
      const run = r.create ? [] : running(r.host, r.name);
      const sub = r.create ? `New folder${r.host ? ` on ${esc(r.host)}` : ' · pick a host next'}`
        : run.length ? `${esc(r.host)} · ${counted(run)} open here` : esc(r.host);
      return `<div class="row ${i === proj.sel ? 'kb' : ''}" data-proj="${i}">
        <span class="st ${r.create ? 'new' : run.length ? 'live' : 'idle'}"></span>
        <div class="mid"><div class="t1"><span class="nm">${r.create ? '＋ ' : ''}${esc(r.name)}</span></div><div class="t2">${sub}</div></div></div>`;
    }).join('') + errs || '<div class="empty">Type a name to start a new project</div>';
    const html = `${head('Project')}<div class="search"><input id="pq" placeholder="What are you working on?  (add inari/cradle to pick)" spellcheck="false" autocomplete="off" value="${esc(proj.q)}"></div>${list}`;
    return { html, hint: `<kbd>↑</kbd><kbd>↓</kbd> pick · <kbd>Enter</kbd> choose · <kbd>Esc</kbd> back` };
  }
  const p = proj.pick;
  const ws = (proj.list || []).find((x) => x.host === p.host);
  const where = p.create ? `New folder${ws ? ` in ${esc(ws.workspace)}` : ''}` : esc(ws ? `${ws.workspace}${/\\/.test(ws.workspace) ? '\\' : '/'}${p.name}` : p.name);
  const opts = projectOptions();
  proj.row = Math.min(proj.row, opts.length - 1);
  const value = (o) => (o.key === 'resume' ? (p.resume ? 'continue last' : 'new chat') : p[o.key]);
  const run = p.create || !p.host ? [] : running(p.host, p.name);
  const html = `${head(`${esc(p.name)}${p.host ? ` <span class="on-host">· ${esc(p.host)}</span>` : ''}`)}<div class="where">${where}</div>
    ${opts.map((o, i) => `<div class="opt2 ${i === proj.row ? 'kb' : ''}" data-row="${i}"><span class="lbl">${o.label}</span>${chips(o.values, value(o), i)}</div>`).join('')}
    ${run.length ? `<div class="already">Already running here: ${run.map((x) => `<button class="go2" data-jump="${esc(x.key)}">${esc(x.kind)} · ${esc(String(x.title || `window ${x.windowIndex}`).slice(0, 28))}</button>`).join(' ')}</div>` : ''}
    <div class="acts"><button class="start" data-start>Start ${esc(p.agent)}</button>${window.oo.code && !p.create ? '<button class="go2" data-code>VS Code</button>' : ''}</div>
    ${proj.busy ? `<div class="empty">${esc(proj.busy)}</div>` : ''}`;
  return { html, hint: `<kbd>←</kbd><kbd>→</kbd> change · <kbd>Enter</kbd> start${window.oo.code ? ' · <kbd>o</kbd> code' : ''}${run.length ? ' · <kbd>g</kbd> go' : ''} · <kbd>Esc</kbd> back` };
}

function choose(i) {
  const r = projRows()[i];
  if (!r) return;
  proj.pick = { name: r.name, host: r.host, create: !!r.create, agent: localStorage.getItem('oo.agent') || 'claude', resume: !r.create };
  proj.row = r.create && !r.host ? 0 : projectOptions().findIndex((o) => o.key === 'agent');
  sig = '';
  render();
  if (document.activeElement) document.activeElement.blur();
}

function changeOption(d) {
  const o = projectOptions()[proj.row];
  const p = proj.pick;
  if (o.key === 'resume') p.resume = !p.resume;
  else {
    const i = o.values.indexOf(p[o.key]);
    p[o.key] = o.values[((i < 0 ? (d > 0 ? -1 : 0) : i) + d + o.values.length) % o.values.length];
    if (o.key === 'agent') { try { localStorage.setItem('oo.agent', p.agent); } catch {} }
  }
  render();
}

async function launch() {
  const p = proj.pick;
  if (!p.host) { proj.row = 0; proj.busy = 'Pick a host first (← →)'; render(); return; }
  proj.busy = `Starting ${p.agent} on ${p.host}…`;
  render();
  try {
    await window.oo.startProject({ host: p.host, folder: p.name, create: p.create, agent: p.agent, resume: p.resume });
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
    if (down || up) { e.preventDefault(); if (n) { proj.sel = (proj.sel + (down ? 1 : -1) + n) % n; render(); } }
    else if (e.key === 'Enter') { e.preventDefault(); choose(proj.sel); }
    else if (e.key === 'Escape') { e.preventDefault(); if (proj.q) { proj.q = ''; proj.sel = 0; render(); } else closeProjects(); }
    else if (e.key === 'Tab') e.preventDefault();
    return;
  }
  const opts = projectOptions().length;
  const run = proj.pick.create ? [] : running(proj.pick.host, proj.pick.name);
  if (e.key === 'Escape') { e.preventDefault(); proj.pick = null; proj.busy = ''; sig = ''; render(); const q = $('#pq'); if (q) q.focus(); }
  else if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); proj.row = (proj.row + 1) % opts; render(); }
  else if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); proj.row = (proj.row - 1 + opts) % opts; render(); }
  else if (e.key === 'ArrowRight' || e.key === 'l' || e.key === 'Tab') { e.preventDefault(); changeOption(1); }
  else if (e.key === 'ArrowLeft' || e.key === 'h') { e.preventDefault(); changeOption(-1); }
  else if (e.key === 'Enter') { e.preventDefault(); if (!proj.busy || !/^Starting/.test(proj.busy)) launch(); }
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
    const focused = a && (a.id === 'reply' || a.id === 'q' || a.id === 'pq') ? a.id : null;
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
  const t = e.target.closest('[data-close],[data-jump],[data-n],[data-send],[data-cur],[data-proj],[data-row],[data-start],[data-code]');
  if (!t) return;
  if (t.dataset.start !== undefined) { launch(); return; }
  if (t.dataset.code !== undefined) { window.oo.code({ host: proj.pick.host, folder: proj.pick.name }).catch((err) => toast(err.message)); return; }
  if (t.dataset.proj !== undefined) { proj.sel = Number(t.dataset.proj); choose(proj.sel); return; }
  if (t.dataset.row !== undefined) { proj.row = Number(t.dataset.row); changeOption(1); return; }
  if (t.dataset.close !== undefined) collapse();
  else if (t.dataset.jump) jump(t.dataset.jump);
  else if (t.dataset.n) answer(cur, Number(t.dataset.n));
  else if (t.dataset.send !== undefined) sendReply();
  else if (t.dataset.cur) { cur = t.dataset.cur; render(); }
});
body.addEventListener('input', (e) => {
  if (e.target.id === 'reply' && cur) drafts[cur] = e.target.value;
  if (e.target.id === 'q') { query = e.target.value; kb = 0; render(); body.scrollTop = 0; }
  if (e.target.id === 'pq' && proj) { proj.q = e.target.value; proj.sel = 0; render(); }
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
  if (e.key === 'Escape' && query !== null && !typing) { closeSearch(); return; }
  if (e.key === 'Escape') { if (typing) e.target.blur(); else collapse(); return; }
  if (typing) { if (e.key === 'Enter' && e.target.id === 'reply') sendReply(); return; }
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
