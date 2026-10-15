// Projects: the folders in each host's workspace, and starting (or resuming) an agent in
// one, in a new window of the tmux session that host's terminal tab shows.
//
// Host config:
//   workspace  folder that holds your projects (default ~/Code, ~\Code on Windows)
//   vscode     Remote-SSH host for "open in VS Code" (default: the host's `ssh`)
// Top-level config:
//   agents     { claude: { start, resume }, codex: { start, resume } } command lines

const AGENTS = {
  claude: { start: 'claude', resume: 'claude --continue' },
  codex: { start: 'codex', resume: 'codex resume --last' },
};

const agents = (cfg) => {
  const out = {};
  for (const [k, v] of Object.entries({ ...AGENTS, ...(cfg.agents || {}) })) out[k] = { ...AGENTS[k], ...v };
  return out;
};

const workspace = (hc) => hc.workspace || (/psmux/.test(hc.type || 'psmux') ? '~\\Code' : '~/Code');

// "Google Drive maintenance!" -> "google-drive-maintenance"
function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '').replace(/-{2,}/g, '-').slice(0, 40);
}

// Folder names go into shell commands, so only plain names are allowed.
function checkName(name) {
  if (!/^[A-Za-z0-9_][A-Za-z0-9 _.+-]{0,63}$/.test(name || '') || /\.\./.test(name)) throw new Error(`folder name not allowed: ${name}`);
  return name;
}

// A project's notes (README etc.) -> one line about it: title plus first paragraph.
function about(notes) {
  const s = String(notes || '');
  if (!s.trim()) return '';
  if (/^\s*\{/.test(s)) { const m = s.match(/"description"\s*:\s*"([^"]*)"/); return m ? m[1] : ''; }
  const m = s.match(/^\s*description\s*=\s*"([^"]*)"/m);
  if (m && !/^\s*#/.test(s)) return m[1];
  const lines = s.replace(/\r/g, '').replace(/<!--[\s\S]*?-->/g, '').split('\n');
  const title = (lines.find((l) => /^#\s+\S/.test(l)) || '').replace(/^#\s+/, '').trim();
  const para = [];
  for (const l of lines) {
    const t = l.trim();
    if (!t) { if (para.length) break; continue; }
    if (/^(#|!\[|\[!\[|<|\||```|---)/.test(t)) { if (para.length) break; continue; }
    para.push(t);
  }
  const text = para.join(' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '');
  return [title, text].filter(Boolean).join(': ').slice(0, 280);
}

function parseNotes(raw) {
  const out = {};
  let name = null;
  let buf = [];
  const flush = () => { if (name !== null) out[name] = about(buf.join('\n')); };
  for (const line of String(raw).replace(/\r/g, '').split('\n')) {
    const m = line.match(/^@@(.+)$/);
    if (m) { flush(); name = m[1].trim(); buf = []; } else buf.push(line);
  }
  flush();
  return out;
}

const notesCache = new Map(); // host -> { at, notes }

async function list(h) {
  const root = await h.src.resolve(workspace(h.cfg));
  const dirs = await h.src.listDirs(workspace(h.cfg));
  let c = notesCache.get(h.cfg.name);
  if (!c || Date.now() - c.at > 10 * 60000) {
    const notes = h.src.projectNotes ? parseNotes(await h.src.projectNotes(workspace(h.cfg)).catch(() => '')) : {};
    c = { at: Date.now(), notes };
    notesCache.set(h.cfg.name, c);
  }
  for (const d of dirs) d.about = c.notes[d.name] || '';
  return { host: h.cfg.name, workspace: root, dirs };
}

// `prompt`, if given, goes to the agent as its first message (one line, quoted for the shell).
// Windows PowerShell 5.1 mangles double quotes in arguments to programs, so they become '.
function commandLine(shell, dir, create, cmd, prompt = '') {
  const p = String(prompt || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 2000);
  if (shell === 'powershell') {
    const q = (v) => `'${v.replace(/'/g, "''")}'`;
    const arg = p ? ` ${q(p.replace(/"/g, "'"))}` : '';
    return `${create ? `New-Item -ItemType Directory -Force -Path ${q(dir)} | Out-Null; ` : ''}Set-Location -LiteralPath ${q(dir)}; ${cmd}${arg}`;
  }
  const q = (v) => `'${v.replace(/'/g, `'\\''`)}'`;
  return `${create ? `mkdir -p ${q(dir)} && ` : ''}cd ${q(dir)} && ${cmd}${p ? ` ${q(p)}` : ''}`;
}

// { folder, create, agent, resume, prompt } -> the new pane
async function start(h, cfg, { folder, create, agent, resume, prompt }) {
  const a = agents(cfg)[agent];
  if (!a) throw new Error(`unknown agent: ${agent}`);
  const root = await h.src.resolve(workspace(h.cfg));
  const dir = h.src.join(root, checkName(folder));
  // codex resume doesn't take a message; the others start (or continue) with it
  const first = resume && agent === 'codex' ? '' : prompt;
  const line = commandLine(h.src.shell, dir, !!create, resume ? a.resume : a.start, first);
  const name = slug(folder).replace(/\+/g, '-').slice(0, 40) || 'project';
  return h.src.newWindow({ name, line });
}

// argv for the `code` CLI: local folders open directly, remote ones over Remote-SSH
function vscodeArgs(hc, dir) {
  if (/^ssh/.test(hc.type || '')) return ['--remote', `ssh-remote+${hc.vscode || hc.ssh}`, dir];
  return [dir];
}

module.exports = { list, start, slug, checkName, commandLine, vscodeArgs, workspace, agents, about, parseNotes };
