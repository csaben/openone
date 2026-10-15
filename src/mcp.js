#!/usr/bin/env node
// openone's MCP server for Claude Code and Codex: lets an agent see the other agents,
// message them, look at their screens, browse project folders and start new agents.
// A thin client of the openone server's /api/bus (see server/index.js); no dependencies.
//
//   OPENONE_URL   the openone server (default http://127.0.0.1:8950)
//   OPENONE_HOST  this machine's host name in the server's config (default: hostname)
//
// It finds its own pane from $TMUX_PANE (and the session), so messages carry a sender
// and replies come back to it. Codex passes only some variables to MCP servers: list
// TMUX, TMUX_PANE and PSMUX_SESSION in env_vars.
//
// A Claude session started with `--dangerously-load-development-channels server:openone`
// (or with OPENONE_CHANNEL=1) also gets messages pushed as channel events; any other
// session gets them typed in when it's idle.

const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');

const URL_ = (process.env.OPENONE_URL || 'http://127.0.0.1:8950').replace(/\/$/, '');
const HOST = (process.env.OPENONE_HOST || os.hostname()).toLowerCase();

function whereAmI() {
  const pane = process.env.TMUX_PANE || '';
  let session = process.env.PSMUX_SESSION || '';
  if (pane && !session && process.env.TMUX) {
    try { session = execFileSync('tmux', ['display-message', '-p', '-t', pane, '#{session_name}'], { encoding: 'utf8', timeout: 3000 }).trim(); } catch {}
  }
  return { host: HOST, pane, session };
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

async function call(method, what, data = {}) {
  const url = `${URL_}/api/bus/${what}${method === 'GET' ? `?${qs({ ...ME, ...data })}` : ''}`;
  const r = await fetch(url, method === 'GET' ? {} : {
    method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ me: ME, ...data }),
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
  'with an optional first message.';

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
        to: { type: 'string', description: 'Agent name from roster, like "photo-tidy@inari".' },
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
];

const size = (n) => (n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(1)} KB` : `${(n / (1 << 20)).toFixed(1)} MB`);

async function run(name, a) {
  if (name === 'roster') {
    const r = await call('GET', 'roster');
    const lines = r.agents.map((x) => `${x.you ? '* ' : '  '}${x.name} (${x.kind}${x.background ? ', background' : ''}) ${x.state}` +
      `${x.title ? ` · ${x.title}` : ''}${x.summary ? `\n      last: ${x.summary.slice(0, 200)}` : ''}`);
    return `${r.you ? `You are ${r.you}.` : `openone doesn't know which pane you're in (host ${HOST}, pane ${ME.pane || 'none'}), so your messages go out unsigned.`}\n` +
      `Hosts: ${r.hosts.join(', ')}\n\n${lines.join('\n') || '(no agents)'}`;
  }
  if (name === 'send') {
    const r = await call('POST', 'send', { to: a.to, content: a.content });
    if (r.status === 'delivered') return `Delivered to ${r.to} (${r.via}).`;
    return `Sent to ${r.to}. It's typed into its chat once it's idle; its reply will arrive in your chat the same way.`;
  }
  if (name === 'peek') {
    const r = await call('GET', 'peek', { name: a.name, lines: a.lines });
    return `${r.name} (${r.state}):\n${String(r.text).replace(/\s+$/, '')}`;
  }
  if (name === 'projects') {
    const r = await call('GET', 'projects', { host: a.host });
    return r.map((h) => `${h.host}: ${h.workspace || ''}${h.error ? ` (error: ${h.error})` : ''}\n` +
      h.projects.map((p) => `  ${p.name}${p.agents.length ? ` [running: ${p.agents.join(', ')}]` : ''}${p.about ? ` - ${p.about.slice(0, 160)}` : ''}`).join('\n')).join('\n\n');
  }
  if (name === 'ls') {
    const r = await call('GET', 'ls', { host: a.host, path: a.path });
    return `${r.host}: ${r.path}\n${r.entries.map((e) => (e.dir ? `  ${e.name}/` : `  ${e.name}${e.size ? `  ${size(e.size)}` : ''}`)).join('\n') || '  (empty)'}`;
  }
  if (name === 'start') {
    const r = await call('POST', 'start', a);
    return `Started ${r.name}. ${r.note}.`;
  }
  throw new Error(`unknown tool: ${name}`);
}

// ---------- MCP over stdio (newline-delimited JSON-RPC) ----------

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
      const text = await run(params.name, params.arguments || {});
      out({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
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
