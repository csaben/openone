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
    : `<kbd>Enter</kbd> ${OPEN_HINT}${items.length > 1 ? ' · <kbd>Tab</kbd> next' : ''}`;
  return { html, hint };
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
  const groups = S.hosts.map((h) => {
    const rows = panes.filter((p) => p.host === h.name).map((p) => {
      const line = status(p) === 'input' ? (p.question || 'Waiting for your answer') : (p.title || p.summary || subline(p));
      return `<div class="row ${p.kind ? '' : 'shell'} ${i++ === kb ? 'kb' : ''}" data-jump="${esc(p.key)}">
        <span class="st ${status(p)}"></span>
        <div class="mid"><div class="t1"><span class="nm">${esc(p.label)}</span><span class="kind">${esc(p.kind || 'shell')}</span></div>
        <div class="t2">${esc(line)}</div></div>
        <span class="age">${esc(when(p))}</span></div>`;
    }).join('');
    const head = `<div class="host"><span class="dot ${h.ok ? '' : 'down'}"></span>${esc(h.name)}${h.ok ? '' : `<span class="err">${esc(h.error)}</span>`}</div>`;
    return head + (rows || (h.ok ? '<div class="empty">No panes</div>' : ''));
  }).join('');
  const html = `<div class="head"><h1>Agents${parts.length ? ` <span style="color:var(--muted);font-weight:500;font-size:12.5px">· ${parts.join(' · ')}</span>` : ''}</h1><button class="x" data-close>${X}</button></div>${groups}`;
  return { html, hint: `<kbd>↑</kbd><kbd>↓</kbd> pick · <kbd>Enter</kbd> ${OPEN_HINT}` };
}

function render() {
  renderChrome();
  if (!expanded) return;
  const items = inbox();
  const showInbox = view === 'inbox' && items.length;
  const { html, hint } = showInbox ? inboxCard(items) : agentsCard();
  const next = `${showInbox ? 'i' : 'a'}|${html}|${hint}`;
  if (next !== sig) {
    const focused = document.activeElement && document.activeElement.id === 'reply';
    const caret = focused ? document.activeElement.selectionStart : 0;
    body.innerHTML = html;
    if ($('#hint').dataset.text !== hint) { $('#hint').innerHTML = `<span>${hint}</span>`; $('#hint').dataset.text = hint; showHint(!!hint); }
    sig = next;
    if (focused && $('#reply')) { $('#reply').focus(); $('#reply').setSelectionRange(caret, caret); }
  }
  $('#b-inbox').classList.toggle('on', !!showInbox);
  $('#b-agents').classList.toggle('on', !showInbox);
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
  window.oo.focus();
}

function collapse() {
  if (!expanded || WEB) return;
  expanded = false;
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

function step(d) {
  if (view === 'inbox' && inbox().length) {
    const items = inbox();
    const i = items.findIndex((p) => p.key === cur);
    cur = items[(i + d + items.length) % items.length].key;
  } else {
    const n = S.panes.length;
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
  const t = e.target.closest('[data-close],[data-jump],[data-n],[data-send],[data-cur]');
  if (!t) return;
  if (t.dataset.close !== undefined) collapse();
  else if (t.dataset.jump) jump(t.dataset.jump);
  else if (t.dataset.n) answer(cur, Number(t.dataset.n));
  else if (t.dataset.send !== undefined) sendReply();
  else if (t.dataset.cur) { cur = t.dataset.cur; render(); }
});
body.addEventListener('input', (e) => { if (e.target.id === 'reply' && cur) drafts[cur] = e.target.value; });

document.addEventListener('keydown', (e) => {
  if (!expanded) return;
  // keys belong to the web build's overlays (pane viewer, forms) while they're open
  if (e.target.closest && e.target.closest('#sheet, #webmenu')) return;
  if (WEB && document.querySelector('#sheet.show')) return;
  const typing = e.target.tagName === 'INPUT';
  if (e.key === 'Escape') { if (typing) e.target.blur(); else collapse(); return; }
  if (typing) { if (e.key === 'Enter' && e.target.id === 'reply') sendReply(); return; }
  const p = view === 'inbox' && inbox().length ? find(cur) : null;
  if (p && p.state === 'input' && /^[1-9]$/.test(e.key) && (p.options || []).some((o) => o.n === Number(e.key))) {
    answer(p.key, Number(e.key));
  } else if (e.key === 'Tab' || e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); step(1); }
  else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
  else if (e.key === 'Enter') {
    if (p) jump(p.key);
    else if (kb >= 0) { const row = body.querySelectorAll('.row')[kb]; if (row) jump(row.dataset.jump); }
  } else if (e.key === 'a') { view = view === 'agents' ? 'inbox' : 'agents'; kb = -1; render(); }
  else if (e.key === 'r' || e.key === '/') { const r = $('#reply'); if (r) { e.preventDefault(); r.focus(); } }
});

window.oo.on('state', (s) => { S = s; render(); });
window.oo.on('peek', peek);
window.oo.on('collapse', collapse);
window.oo.on('expand', () => expand());
window.oo.on('toast', (msg) => {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3500);
});
setInterval(() => { if (expanded && view === 'agents') render(); }, 30000);
window.oo.ready();
