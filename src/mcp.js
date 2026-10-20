#!/usr/bin/env node
// openone's MCP server for Claude Code and Codex: lets an agent see the other agents,
// message them, look at their screens, browse project folders and start new agents.
// A thin client of the openone server's /api/bus (see server/index.js); no dependencies.
//
//   OPENONE_URL   the openone server (default http://127.0.0.1:8950)
//   OPENONE_HOST  this machine's host name in the server's config (default: hostname)
//
// It finds its own pane from $TMUX_PANE (and the session), or from its parent processes,
// so messages carry a sender and replies come back to it. Codex runs one copy for all its
// sessions (from its app-server), so there each call carries the Codex thread id and that
// thread's folder instead, and the server works out the pane from those.
//
// A Claude session started with `--dangerously-load-development-channels server:openone`
// (or with OPENONE_CHANNEL=1) also gets messages pushed as channel events; any other
// session gets them typed in when it's idle.

const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { gb } = require('./resources');

const URL_ = (process.env.OPENONE_URL || 'http://127.0.0.1:8950').replace(/\/$/, '');
const HOST = (process.env.OPENONE_HOST || os.hostname()).toLowerCase();

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 8000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });

function whereAmI() {
  let pane = process.env.TMUX_PANE || '';
  let session = process.env.PSMUX_SESSION || '';
  if (pane && !session && process.env.TMUX) {
    try { session = sh('tmux', ['display-message', '-p', '-t', pane, '#{session_name}']).trim(); } catch {}
  }
  if (!pane) ({ pane, session } = fromAncestors());
  return { host: HOST, pane, session };
}

// Without $TMUX_PANE (Codex hands MCP servers a trimmed environment): walk up the
// parent processes to the one that is a pane's shell.
function fromAncestors() {
  const none = { pane: '', session: '' };
  try {
    const bin = process.platform === 'win32' ? 'psmux' : 'tmux';
    const panes = new Map();
    for (const l of sh(bin, ['list-panes', '-a', '-F', '#{pane_pid} #{pane_id} #{session_name}']).split(/\r?\n/)) {
      const m = l.trim().match(/^(\d+) (%\d+) (.+)$/);
      if (m) panes.set(Number(m[1]), { pane: m[2], session: m[3] });
    }
    const parent = new Map();
    if (process.platform === 'linux') {
      const up = (pid) => Number(fs.readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /, '').split(' ')[1]);
      for (let pid = process.pid, i = 0; pid > 1 && i < 30; i++) {
        if (panes.has(pid)) return panes.get(pid);
        try { pid = up(pid); } catch { return none; }
      }
      return none;
    }
    if (process.platform === 'win32') {
      const out = sh('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }']);
      for (const l of out.split(/\r?\n/)) { const [a, b] = l.trim().split(' ').map(Number); if (a) parent.set(a, b); }
      for (let pid = process.pid, i = 0; pid && i < 30; i++) {
        if (panes.has(pid)) return panes.get(pid);
        pid = parent.get(pid);
      }
    }
  } catch {}
  return none;
}
const ME = whereAmI();

// started with the openone channel? (the parent is the claude process)
function channelOn() {
  if (process.env.OPENONE_CHANNEL === '1') return true;
  try {
    let cmd = '';
    if (process.platform === 'linux') cmd = fs.readFileSync(`/proc/${process.ppid}/cmdline`, 'utf8').replace(/\0/g, ' ');
    else if (process.platform === 'win32') {
      cmd = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter 'ProcessId=${process.ppid}').CommandLine`], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    }
    return /--dangerously-load-development-channels\b[^\n]*server:openone\b/.test(cmd);
  } catch { return false; }
}

const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== '')).toString();

// Codex: the thread a tool call comes from, and the folder that thread runs in (from the
// first line of its session log, ~/.codex/sessions/YYYY/MM/DD/rollout-...-<thread>.jsonl)
const threadDirs = new Map();
function codexThread(meta) {
  const m = meta || {};
  const thread = String(m.threadId || (m['x-codex-turn-metadata'] || {}).thread_id || '');
  if (!/^[0-9a-f-]{20,}$/i.test(thread)) return null;
  if (!threadDirs.has(thread)) threadDirs.set(thread, findThreadDir(thread));
  return { thread, cwd: threadDirs.get(thread) };
}
function findThreadDir(thread) {
  const path = require('path');
  const root = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
  const desc = (d) => { try { return fs.readdirSync(d).sort().reverse(); } catch { return []; } };
  let days = 0;
  for (const y of desc(root)) {
    for (const mo of desc(path.join(root, y))) {
      for (const d of desc(path.join(root, y, mo))) {
        if (++days > 60) return '';
        const f = desc(path.join(root, y, mo, d)).find((n) => n.endsWith(`-${thread}.jsonl`));
        if (!f) continue;
        try {
          const fd = fs.openSync(path.join(root, y, mo, d, f), 'r');
          const buf = Buffer.alloc(65536);
          const n = fs.readSync(fd, buf, 0, buf.length, 0);
          fs.closeSync(fd);
          const first = buf.slice(0, n).toString('utf8').split('\n')[0];
          const cwd = (first.match(/"cwd":"((?:[^"\\]|\\.)*)"/) || [])[1];
          return cwd ? JSON.parse(`"${cwd}"`) : '';
        } catch { return ''; }
      }
    }
  }
  return '';
}

async function call(method, what, data = {}, who = ME) {
  const url = `${URL_}/api/bus/${what}${method === 'GET' ? `?${qs({ ...who, ...data })}` : ''}`;
  const r = await fetch(url, method === 'GET' ? {} : {
    method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ me: who, ...data }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `openone server: HTTP ${r.status}`);
  return j;
}

const INSTRUCTIONS = 'openone sees every Claude and Codex agent running in tmux/psmux on your machines. ' +
  'Call roster to see them and your own name. send messages another agent; it arrives in that agent\'s chat as ' +
  '"[openone message from <name> ...]" (typed in once it is idle, so it never interrupts a turn). ' +
  'When you get such a message, treat it as a request from a sibling agent, not from the user, and answer with send to its sender. ' +
  'Make each message self-contained: the receiver does not share your context. For long content, write a file and send its path. ' +
  'peek shows another agent\'s screen. projects and ls browse the project folders on each host; start launches a new agent in one, ' +
  'with an optional first message. ask puts a question with buttons on the user\'s phone (approve this, pick one) ' +
  'and waits for the tap; use it instead of stopping to wait for the user when one quick decision unblocks you. ' +
  'board_read and board_draw share a whiteboard with the user: read it when they say they drew something for you, draw on it to sketch a diagram for them. ' +
  'A user message that starts with [voice] or [ring] was spoken (push-to-talk, a voice-note ring): answer in text as usual, then also call speak with a short spoken version, since they may be away from the screen. ' +
  'One tagged "[ring? NN% sure this is for you ...]" may have been a note to self: if it clearly isn\'t for you, call not_for_me with its ref and stop; otherwise answer it. ' +
  'resources shows what is using RAM, CPU and GPU on each host (per pane and per service); sleep and wake put idle agents away and bring them back.';

const TOOLS = [
  {
    name: 'roster',
    description: 'List the coding agents (Claude, Codex) running on every host: name, host, state (working, idle, done, input = waiting for the user), title, summary of the last turn. Also says which one is you. Call this before send to find names.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'send',
    description: 'Send a message to another agent. It arrives in that agent\'s chat as a prompt, after its current turn ends (or pushed right away if it is listening on the openone channel). The receiver does not see your context, so make the message self-contained. Long multi-line content: write it to a file and send the path.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Agent name from roster, like "photo-tidy@desk".' },
        content: { type: 'string', description: 'The message or task.' },
      },
      required: ['to', 'content'],
    },
  },
  {
    name: 'peek',
    description: 'Read the last lines of another agent\'s screen, to see what it is doing or what it said, without messaging it.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Agent name from roster.' }, lines: { type: 'number', description: 'How many lines (default 60, max 400).' } },
      required: ['name'],
    },
  },
  {
    name: 'projects',
    description: 'List the project folders in each host\'s workspace, with a line about each (from its README) and the agents already running in it.',
    inputSchema: { type: 'object', properties: { host: { type: 'string', description: 'Only this host (default: all).' } } },
  },
  {
    name: 'ls',
    description: 'List the files and folders inside a host\'s workspace, e.g. path "photo-tidy" or "photo-tidy/src". Only paths under the workspace.',
    inputSchema: {
      type: 'object',
      properties: { host: { type: 'string' }, path: { type: 'string', description: 'Relative to the workspace; empty for the workspace itself.' } },
      required: ['host'],
    },
  },
  {
    name: 'start',
    description: 'Start a new agent in a project folder on a host, in a new window of the session that host\'s terminal shows. The optional prompt becomes its first message, tagged with your name so it can report back to you.',
    inputSchema: {
      type: 'object',
      properties: {
        host: { type: 'string' },
        folder: { type: 'string', description: 'Folder name in the host\'s workspace (see projects).' },
        agent: { type: 'string', enum: ['claude', 'codex'], description: 'Default claude.' },
        prompt: { type: 'string', description: 'First message for the new agent.' },
        create: { type: 'boolean', description: 'Create the folder if it does not exist.' },
        resume: { type: 'boolean', description: 'Continue the folder\'s last conversation instead of a new one.' },
      },
      required: ['host', 'folder'],
    },
  },
  {
    name: 'ask',
    description: 'Ask the user a quick question with up to 4 buttons. It shows on their phone (and the openone panel) as a notification they answer with one tap, without opening this chat. Waits up to "wait" seconds for the answer; if it comes later, it is typed into your chat as "[openone] The user answered ...". Use for decisions, not for long questions.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The question, short: "Add Dentist Thu 3pm to your calendar?"' },
        body: { type: 'string', description: 'Optional detail under it (a couple of lines).' },
        options: { type: 'array', items: { type: 'string' }, description: 'Button labels, 1 to 4 (default ["OK"]), e.g. ["Add", "Skip"].' },
        default: { type: 'string', description: 'Option that applies by itself when the ask expires (e.g. "Keep" for "Added X · Keep / Undo").' },
        ttl_minutes: { type: 'number', description: 'Expires after this many minutes (default 1440).' },
        wait: { type: 'number', description: 'Seconds to wait here for the answer (default 45, max 600; 0 = return at once).' },
      },
      required: ['title'],
    },
  },
];

TOOLS.push(
  {
    name: 'board_read',
    description: 'Look at the shared whiteboard the user draws on (openone board). Returns a picture of it plus a text list of its shapes, text, arrows and where they are. Use it when the user says they drew or wrote something for you on the board.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'board_draw',
    description: 'Draw on the shared whiteboard the user sees (openone board): diagrams, sketches, notes. Give either "mermaid" (a Mermaid flowchart/sequence diagram, turned into shapes) or "elements": Excalidraw element skeletons, e.g. ' +
      '{"type":"rectangle","x":0,"y":0,"width":180,"height":70,"id":"a","label":{"text":"API"},"backgroundColor":"#a5d8ff"}, ' +
      '{"type":"ellipse"|"diamond", ...same}, {"type":"text","x":0,"y":120,"text":"note","fontSize":20}, ' +
      '{"type":"arrow","x":180,"y":35,"start":{"id":"a"},"end":{"id":"b"},"label":{"text":"calls"}} (start/end bind to element ids), ' +
      '{"type":"line","x":0,"y":0,"points":[[0,0],[100,50]]}. Optional on shapes: strokeColor, fillStyle ("solid","hachure"), strokeWidth. ' +
      'By default the drawing is placed beside what is already there (coordinates are relative to each other); place:"exact" uses your coordinates as board coordinates (to annotate something board_read showed). ' +
      'It appears on the board right away when it is open; otherwise when they next open it.',
    inputSchema: {
      type: 'object',
      properties: {
        elements: { type: 'array', items: { type: 'object' }, description: 'Excalidraw element skeletons.' },
        mermaid: { type: 'string', description: 'A Mermaid diagram, instead of elements.' },
        place: { type: 'string', enum: ['auto', 'exact'], description: 'auto (default): beside existing content. exact: at the given coordinates.' },
      },
    },
  },
  {
    name: 'resources',
    description: 'What is using memory, CPU and GPU on each host: every tmux/psmux pane (agents and shells, with everything they started added up: the agent, its MCP servers, dev servers), the biggest things running outside panes (Linux: by systemd service, e.g. a model server), free RAM, and the agents put to sleep. Takes a few seconds. Use it when the user asks what is running, what is eating RAM, or what to turn off.',
    inputSchema: { type: 'object', properties: { host: { type: 'string', description: 'Only this host (default: all).' } } },
  },
  {
    name: 'speak',
    description: 'Say something out loud to the user, in a voice, on their computer. Use it when their message started with [voice] or [ring] (they talked to you), once, at the end of your turn; or mid-task when you need them (a question, an approval) and they may not be looking. ' +
      'Write for the ear, not the screen: one to three short sentences, usually under 40 words. Lead with the answer or what you need from them. ' +
      'No code, file paths, URLs, ids, markdown or lists; round numbers ("about six gigs"); name things the way a person would say them. ' +
      'Do not read your text reply aloud: say the gist and point to the screen for detail ("the list is on screen"). It plays right away; their push-to-talk key cuts it off.',
    inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'What to say, as you would say it.' } }, required: ['text'] },
  },
  {
    name: 'sleep',
    description: 'Put an idle agent to sleep: exit it (as /exit would), close its window and remember how to resume its conversation. Frees its memory. Only idle agents (not working, not waiting on the user). Undo with wake. Only when the user asks or agrees.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Agent name from roster.' } }, required: ['name'] },
  },
  {
    name: 'not_for_me',
    description: 'A voice note that reached you tagged "[ring? NN% sure this is for you ...]" may have been meant for the user\'s notes, not you. Read it; if it clearly isn\'t for you (a thought, a reminder, talk about something unrelated to your work with them), call this with its ref and do nothing else: the notes service files it as a note. If it is for you, or plausibly a follow-up to your conversation, just answer it.',
    inputSchema: { type: 'object', properties: { ref: { type: 'string', description: 'The ref in the tag, like "r1a2b3".' } }, required: ['ref'] },
  },
  {
    name: 'wake',
    description: 'Wake a sleeping agent: open a window in its folder and resume its conversation. Name or id from the "Asleep" list in resources.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Its label ("photo-tidy"), label@host, or id.' } }, required: ['name'] },
  },
  {
    name: 'board_clear',
    description: 'Erase the whole shared whiteboard. Only when the user asks for it.',
    inputSchema: { type: 'object', properties: {} },
  },
);

const ago = (ms) => {
  const m = Math.round(Math.max(0, ms) / 60000);
  return m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ''}` : `${Math.round(m / 1440)}d`;
};

function resourcesText(r) {
  const out = [];
  for (const h of r.hosts) {
    if (h.error) { out.push(`${h.host}: couldn't read processes (${h.error})`); continue; }
    const used = h.mem.total - h.mem.avail;
    out.push(`${h.host}: RAM ${gb(used)} of ${gb(h.mem.total)} in use, ${gb(h.mem.avail)} available`);
    const big = h.panes.filter((p) => p.rss >= 50 << 20);
    if (big.length) out.push('  Panes, biggest first:');
    for (const p of big.slice(0, 15)) {
      const who = p.name ? `${p.name} (${p.kind}, ${p.state}${p.idleMin ? ` ${ago(p.idleMin * 60000)}` : ''})`
        : p.guess ? `window ${p.where} (${p.guess}, not in roster yet, so sleep can't reach it)` : `shell ${p.where}`;
      out.push(`    ${who}: ${gb(p.rss)} RAM${p.gpu ? `, ${gb(p.gpu)} GPU` : ''}${p.cpu >= 1 ? `, ${Math.round(p.cpu)}% CPU` : ''}` +
        ` [${p.top.map((t) => `${t.name}${t.count > 1 ? ` x${t.count}` : ''} ${gb(t.rss)}`).join(', ')}]`);
    }
    if (big.length > 15) out.push(`    ...and ${big.length - 15} more`);
    out.push(`  Outside panes: ${h.others.map((g) => `${g.name}${g.count > 1 ? ` x${g.count}` : ''} ${gb(g.rss)}${g.gpu ? ` (+${gb(g.gpu)} GPU)` : ''}${g.cpu >= 5 ? ` ${Math.round(g.cpu)}% CPU` : ''}`).join(', ')}`);
  }
  if (r.sleeping && r.sleeping.length) {
    out.push(`Asleep: ${r.sleeping.map((s) => `${s.label}@${s.host} (${s.kind}, ${ago(Date.now() - s.sleptAt)} ago, id ${s.id})`).join(', ')}`);
  }
  out.push('(CPU is % of one core. Agents with a state can be put to sleep with sleep; shells and services you would stop yourself.)');
  return out.join('\n');
}

const size = (n) =>(n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(1)} KB` : `${(n / (1 << 20)).toFixed(1)} MB`);

async function run(name, a, who) {
  if (name === 'roster') {
    const r = await call('GET', 'roster', {}, who);
    const lines = r.agents.map((x) => `${x.you ? '* ' : '  '}${x.name} (${x.kind}${x.background ? ', background' : ''}) ${x.state}` +
      `${x.title ? ` · ${x.title}` : ''}${x.summary ? `\n      last: ${x.summary.slice(0, 200)}` : ''}`);
    return `${r.you ? `You are ${r.you}.` : `openone couldn't tell which pane you're in (host ${HOST}, pane ${who.pane || 'none'}${who.cwd ? `, folder ${who.cwd}` : ''}), so your messages go out unsigned.`}\n` +
      `Hosts: ${r.hosts.join(', ')}\n\n${lines.join('\n') || '(no agents)'}`;
  }
  if (name === 'send') {
    const r = await call('POST', 'send', { to: a.to, content: a.content }, who);
    if (r.status === 'delivered') return `Delivered to ${r.to} (${r.via}).`;
    return `Sent to ${r.to}. It's typed into its chat once it's idle; its reply will arrive in your chat the same way.`;
  }
  if (name === 'peek') {
    const r = await call('GET', 'peek', { name: a.name, lines: a.lines }, who);
    return `${r.name} (${r.state}):\n${String(r.text).replace(/\s+$/, '')}`;
  }
  if (name === 'projects') {
    const r = await call('GET', 'projects', { host: a.host }, who);
    return r.map((h) => `${h.host}: ${h.workspace || ''}${h.error ? ` (error: ${h.error})` : ''}\n` +
      h.projects.map((p) => `  ${p.name}${p.agents.length ? ` [running: ${p.agents.join(', ')}]` : ''}${p.about ? ` - ${p.about.slice(0, 160)}` : ''}`).join('\n')).join('\n\n');
  }
  if (name === 'ls') {
    const r = await call('GET', 'ls', { host: a.host, path: a.path }, who);
    return `${r.host}: ${r.path}\n${r.entries.map((e) => (e.dir ? `  ${e.name}/` : `  ${e.name}${e.size ? `  ${size(e.size)}` : ''}`)).join('\n') || '  (empty)'}`;
  }
  if (name === 'start') {
    const r = await call('POST', 'start', a, who);
    return `Started ${r.name}. ${r.note}.`;
  }
  if (name === 'resources') return resourcesText(await call('GET', 'resources', { host: a.host }, who));
  if (name === 'speak') {
    const r = await fetch(`${URL_}/api/speak`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: a.text, from: await myName(who) }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `openone server: HTTP ${r.status}`);
    return `Speaking (${j.parts} part${j.parts === 1 ? '' : 's'}); it plays on the user's computer as each is ready.`;
  }
  if (name === 'sleep') {
    const r = await call('POST', 'sleep', { name: a.name }, who);
    return `${r.label}@${r.host} is asleep${r.resume ? '' : " (it didn't print a resume id, so wake continues its folder's latest conversation)"}. Wake it with wake "${r.label}".`;
  }
  if (name === 'not_for_me') {
    const r = await fetch(`${URL_}/api/route/not-for-me`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ref: a.ref }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `openone server: HTTP ${r.status}`);
    return 'Handed back: it will be filed as a note. Nothing else to do.';
  }
  if (name === 'wake') {
    const r = await call('POST', 'wake', { name: a.name }, who);
    return `Woke ${r.label} on ${r.host}; it shows up in roster in a few seconds.`;
  }
  if (name === 'board_read') {
    const r = await boardCall('GET', '/read');
    const content = [];
    if (r.snapshot && r.snapshot.png) content.push({ type: 'image', data: r.snapshot.png, mimeType: 'image/png' });
    const age = r.snapshot ? Math.round((Date.now() - r.snapshot.at) / 1000) : null;
    const note = !r.snapshot ? '\n(No picture yet: nobody has opened the board since it changed.)'
      : r.snapshot.current ? '' : `\n(The picture is from ${age}s ago and may be missing the latest edits; the list above is current.)`;
    content.push({ type: 'text', text: `${r.summary}${note}` });
    return { content };
  }
  if (name === 'board_draw') {
    const r = await boardCall('POST', '/draw', { elements: a.elements, mermaid: a.mermaid, place: a.place, from: await myName(who), wait: 20 });
    if (r.status === 'drawn') return `Drawn on the board (${(r.ids || []).length} elements). Use board_read to see it.`;
    return r.viewers ? 'Sent; the open board is still drawing it.' : "Queued: the board isn't open anywhere right now, so it appears when the user opens it (the desktop app opens it for them).";
  }
  if (name === 'board_clear') {
    await boardCall('POST', '/clear', {});
    return 'The board is cleared.';
  }
  if (name === 'ask') {
    const a0 = await askCall('POST', '', {
      me: who, title: a.title, body: a.body, options: a.options, default: a.default,
      ttlSec: a.ttl_minutes ? Number(a.ttl_minutes) * 60 : undefined,
    });
    let ask = a0;
    const until = Date.now() + Math.min(Math.max(a.wait == null ? 45 : Number(a.wait), 0), 600) * 1000;
    while (ask.status === 'pending' && Date.now() < until) {
      ask = await askCall('GET', `/${ask.id}?wait=${Math.max(1, Math.min(55, Math.ceil((until - Date.now()) / 1000)))}`);
    }
    if (ask.status === 'answered') return `The user answered: ${ask.answerLabel}${ask.by === 'default' ? ' (the default, nobody tapped)' : ''}`;
    if (ask.status !== 'pending') return `The question ${ask.status}.`;
    return `Asked (id ${ask.id}); no answer yet. When the user taps a button, the answer is typed into your chat as "[openone] The user answered ...". Carry on with other work meanwhile, or end your turn.`;
  }
  throw new Error(`unknown tool: ${name}`);
}

// ---------- MCP over stdio (newline-delimited JSON-RPC) ----------

async function boardCall(method, rest, data) {
  const r = await fetch(`${URL_}/api/board${rest}`, method === 'GET' ? {} : {
    method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(data),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `openone server: HTTP ${r.status}`);
  return j;
}

// this agent's openone name, to sign its drawings
async function myName(who) {
  try { return (await call('GET', 'roster', {}, who)).you || 'an agent'; } catch { return 'an agent'; }
}

async function askCall(method, rest, data) {
  const r = await fetch(`${URL_}/api/asks${rest}`, method === 'GET' ? {} : {
    method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(data),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `openone server: HTTP ${r.status}`);
  return j;
}

const out = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const CHANNEL = channelOn();

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    out({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: (params && params.protocolVersion) || '2025-06-18',
        capabilities: { tools: {}, ...(CHANNEL ? { experimental: { 'claude/channel': {} } } : {}) },
        serverInfo: { name: 'openone', version: '0.1.0' },
        instructions: INSTRUCTIONS + (CHANNEL ? ' Messages may also arrive as <channel source="openone" from="<name>">; treat them the same way.' : ''),
      },
    });
    if (CHANNEL) listen();
    return;
  }
  if (method === 'tools/list') return out({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  if (method === 'tools/call') {
    try {
      const t = ME.pane ? null : codexThread(params._meta);
      const who = t ? { ...ME, thread: t.thread, cwd: t.cwd } : ME;
      const r = await run(params.name, params.arguments || {}, who);
      // tools answer with text, or with { content } when there's a picture
      out({ jsonrpc: '2.0', id, result: typeof r === 'string' ? { content: [{ type: 'text', text: r }] } : r });
    } catch (e) {
      out({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(e.message || e) }], isError: true } });
    }
    return;
  }
  if (method === 'ping') return out({ jsonrpc: '2.0', id, result: {} });
  if (id !== undefined) out({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
}

// channel: hold an event stream open to the server; each message becomes a channel event
let listening = false;
async function listen() {
  if (listening) return;
  listening = true;
  for (;;) {
    try {
      const r = await fetch(`${URL_}/api/bus/listen?${qs(ME)}`, { headers: { accept: 'text/event-stream' } });
      if (r.ok && r.body) {
        let buf = '';
        const dec = new TextDecoder();
        for await (const chunk of r.body) {
          buf += dec.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            if (!/^event: message$/m.test(frame)) continue;
            const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
            try {
              const m = JSON.parse(data);
              out({ jsonrpc: '2.0', method: 'notifications/claude/channel', params: { content: m.content, meta: { from: m.from } } });
            } catch {}
          }
        }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 5000)); // the server restarted, or this pane isn't known yet
  }
}

let inBuf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  inBuf += d;
  let i;
  while ((i = inBuf.indexOf('\n')) >= 0) {
    const line = inBuf.slice(0, i).trim();
    inBuf = inBuf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg).catch(() => {});
  }
});
process.stdin.on('end', () => process.exit(0));
