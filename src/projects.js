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

async function list(h) {
  const root = await h.src.resolve(workspace(h.cfg));
  const dirs = await h.src.listDirs(workspace(h.cfg));
  return { host: h.cfg.name, workspace: root, dirs };
}

function commandLine(shell, dir, create, cmd) {
  if (shell === 'powershell') {
    const q = `'${dir.replace(/'/g, "''")}'`;
    return `${create ? `New-Item -ItemType Directory -Force -Path ${q} | Out-Null; ` : ''}Set-Location -LiteralPath ${q}; ${cmd}`;
  }
  const q = `'${dir.replace(/'/g, `'\\''`)}'`;
  return `${create ? `mkdir -p ${q} && ` : ''}cd ${q} && ${cmd}`;
}

// { folder, create, agent, resume } -> the new pane
async function start(h, cfg, { folder, create, agent, resume }) {
  const a = agents(cfg)[agent];
  if (!a) throw new Error(`unknown agent: ${agent}`);
  const root = await h.src.resolve(workspace(h.cfg));
  const dir = h.src.join(root, checkName(folder));
  const line = commandLine(h.src.shell, dir, !!create, resume ? a.resume : a.start);
  const name = slug(folder).replace(/\+/g, '-').slice(0, 40) || 'project';
  return h.src.newWindow({ name, line });
}

// argv for the `code` CLI: local folders open directly, remote ones over Remote-SSH
function vscodeArgs(hc, dir) {
  if (/^ssh/.test(hc.type || '')) return ['--remote', `ssh-remote+${hc.vscode || hc.ssh}`, dir];
  return [dir];
}

module.exports = { list, start, slug, checkName, commandLine, vscodeArgs, workspace, agents };
