// Pane sources: every way of reaching a tmux (or psmux) server.
//   psmux      local Windows tmux clone, one execFile per command
//   tmux       local tmux (the Linux server), one execFile per command
//   ssh        remote tmux through one long-lived `ssh host bash`
//   ssh-psmux  remote Windows psmux through one long-lived `ssh host cmd`
//
// They all speak tmux commands, so the shared logic lives in TmuxSource and each
// subclass only implements batch(): run a list of tmux argv's, return their outputs.
//
// psmux runs one server per session and pane ids repeat across them, so targets are
// always `session:window.%id` (tmux accepts that form too). A bare `%id` silently
// resolves into psmux session 0.

const { execFile, spawn } = require('child_process');

const SEP = '<|>';
const FIELDS = ['pane_id', 'session_name', 'window_index', 'window_name', 'pane_index', 'pane_current_command',
  'pane_current_path', 'pane_title', 'window_active', 'pane_active', 'session_attached',
  'history_size', 'cursor_x', 'cursor_y'];
const FMT = FIELDS.map((f) => `#{${f}}`).join(SEP);
const SESSION_NAME = /^[A-Za-z0-9_.-]{1,40}$/;

function parseRow(line) {
  const v = line.replace(/\r$/, '').split(SEP);
  if (v.length < FIELDS.length || !v[0].startsWith('%')) return null;
  return {
    paneId: v[0], session: v[1], windowIndex: v[2], windowName: v[3], paneIndex: v[4],
    command: v[5], path: v[6], title: v[7], windowActive: v[8], paneActive: v[9], attached: v[10] !== '0',
    sig: `${v[11]}/${v[12]}/${v[13]}`, text: '',
  };
}

// send-keys -H takes raw bytes as hex, which sidesteps every shell's quoting rules
function hexChunks(s, size = 120) {
  const bytes = [...Buffer.from(s, 'utf8')].map((b) => b.toString(16).padStart(2, '0'));
  const out = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.slice(i, i + size));
  return out;
}

class TmuxSource {
  constructor(cfg) {
    this.cfg = cfg;
    this.cache = new Map();
  }

  target(p) { return `${p.session}:${p.windowIndex}.${p.paneId}`; }

  async snapshot() {
    const [list] = await this.batch([['list-panes', '-a', '-F', FMT]]);
    const panes = list.split('\n').map(parseRow).filter(Boolean);
    // Capturing is the expensive part (and on psmux it can flash the attached client),
    // so only re-read a pane when its scrollback/cursor moved, plus a slow refresh.
    const now = Date.now();
    const stale = [];
    for (const p of panes) {
      const c = this.cache.get(`${p.session}|${p.paneId}`);
      if (c && c.sig === p.sig && now - c.at < (this.cfg.refreshMs || 20000)) p.text = c.text;
      else stale.push(p);
    }
    const n = this.cfg.lines || 60;
    const texts = stale.length ? await this.batch(stale.map((p) => ['capture-pane', '-p', '-J', '-S', `-${n}`, '-t', this.target(p)])) : [];
    stale.forEach((p, i) => {
      p.text = (texts[i] || '').replace(/\r/g, '');
      this.cache.set(`${p.session}|${p.paneId}`, { sig: p.sig, text: p.text, at: now });
    });
    const keep = new Set(panes.map((p) => `${p.session}|${p.paneId}`));
    for (const key of this.cache.keys()) if (!keep.has(key)) this.cache.delete(key);
    return panes;
  }

  async focus(p) {
    const cmds = [];
    if (!p.attached) {
      // move the most recently used client onto this pane's session
      const [clients] = await this.batch([['list-clients', '-F', '#{client_activity} #{client_name}']]);
      const best = clients.split('\n').map((l) => l.trim().split(' ')).filter((x) => x.length === 2 && /^\d+$/.test(x[0]))
        .sort((a, b) => Number(b[0]) - Number(a[0]))[0];
      cmds.push(best ? ['switch-client', '-c', best[1], '-t', p.session] : ['switch-client', '-t', p.session]);
    }
    cmds.push(['select-window', '-t', `${p.session}:${p.windowIndex}`], ['select-pane', '-t', this.target(p)]);
    await this.batch(cmds);
  }

  async keys(p, keys) { await this.batch([['send-keys', '-t', this.target(p), ...keys]]); }

  async text(p, s) {
    await this.batch(hexChunks(s).map((hex) => ['send-keys', '-t', this.target(p), '-H', ...hex]));
  }

  // Starts a detached session (optionally in cwd) and types cmd into its shell, so the
  // shell survives when cmd exits. Returns the new pane.
  async newSession({ name, cwd, cmd }) {
    if (!SESSION_NAME.test(name || '')) throw new Error('session name: letters, digits, _ . - only');
    if (cwd && /["\r\n]/.test(cwd)) throw new Error('bad cwd');
    // tmux doesn't expand ~ in -c (it silently falls back to $HOME)
    if (cwd && /^~(?=$|[\\/])/.test(cwd)) cwd = (await this.home()) + cwd.slice(1);
    const typedCd = cwd && this.cdCommand ? this.cdCommand(cwd) : '';
    const create = async () => {
      const [out] = await this.batch([['new-session', '-d', '-s', name, ...(cwd && !typedCd ? ['-c', cwd] : [])]]);
      if (/duplicate session|already exists/i.test(out)) throw new Error(`session ${name} already exists`);
      return out;
    };
    const find = async () => {
      const [list] = await this.batch([['list-panes', '-t', name, '-F', FMT]]);
      return list.split('\n').map(parseRow).filter(Boolean)[0];
    };
    const out = await create();
    if (!(await find())) throw new Error(`could not start session: ${out.trim() || 'no pane'}`);
    await new Promise((r) => setTimeout(r, this.cfg.shellWarmMs || 1200));
    // psmux sometimes hands out a pre-started server that dies a moment later (seen right
    // after the ssh connection is re-established); check before typing, retry once
    let pane = await find();
    if (!pane) {
      await create();
      await new Promise((r) => setTimeout(r, this.cfg.shellWarmMs || 1200));
      pane = await find();
      if (!pane) throw new Error('session exited right after starting');
    }
    const line = [typedCd, cmd].filter(Boolean).join('; ');
    if (line) {
      await this.text(pane, line);
      await this.keys(pane, ['Enter']);
    }
    return pane;
  }

  async killSession(name) {
    if (!SESSION_NAME.test(name || '')) throw new Error('bad session name');
    await this.batch([['kill-session', '-t', name]]);
  }

  close() {}
}

class LocalSource extends TmuxSource {
  constructor(cfg) {
    super(cfg);
    this.bin = cfg.bin || (cfg.type === 'tmux' ? 'tmux' : 'psmux');
  }

  async home() { return require('os').homedir(); }

  run(args) {
    return new Promise((resolve) => {
      execFile(this.bin, args, { windowsHide: true, maxBuffer: 16 << 20, timeout: 8000, encoding: 'utf8' },
        (err, out, errOut) => resolve(err ? `${out || ''}${errOut || err.message}` : out));
    });
  }

  async batch(argvs) {
    const out = [];
    for (const a of argvs) out.push(await this.run(a));
    return out;
  }
}

// One persistent ssh session per host. Commands are written to the remote shell's
// stdin, each followed by an echoed delimiter, so one round trip runs a whole batch.
class ShellSource extends TmuxSource {
  constructor(cfg) {
    super(cfg);
    this.ssh = cfg.sshBin || (process.platform === 'win32' ? 'C:\\Program Files\\OpenSSH\\ssh.exe' : 'ssh');
    this.proc = null;
    this.buf = '';
    this.waiter = null;
    this.seq = 0;
    this.chain = Promise.resolve();
  }

  connect() {
    if (this.proc) return;
    const args = ['-T', '-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=15', '-o', 'ConnectTimeout=6', this.cfg.ssh, this.remoteShell];
    const proc = spawn(this.ssh, args, { windowsHide: true });
    this.proc = proc;
    this.buf = '';
    this.ready = false;
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => { this.buf += d; this.pump(); });
    proc.stderr.on('data', () => {});
    proc.on('exit', () => {
      if (this.proc === proc) this.proc = null;
      if (this.waiter) { this.waiter.reject(new Error('ssh closed')); this.waiter = null; }
    });
    proc.on('error', () => { if (this.proc === proc) this.proc = null; });
  }

  pump() {
    if (!this.waiter) return;
    const i = this.buf.indexOf(this.waiter.marker);
    if (i < 0) return;
    const out = this.buf.slice(0, i);
    this.buf = this.buf.slice(i + this.waiter.marker.length).replace(/^\r?\n/, '');
    const w = this.waiter;
    this.waiter = null;
    w.resolve(out);
  }

  // Runs raw shell lines; calls are serialized on the one connection.
  exec(lines) {
    const run = async () => {
      this.connect();
      if (!this.proc) throw new Error('ssh not running');
      // shell setup gets its own round trip so its noise never lands in real output
      if (!this.ready) {
        this.ready = true;
        await this.raw(this.init());
        await this.setup();
      }
      return this.raw(lines);
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  raw(lines, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const marker = `__OO_${++this.seq}__`;
      const timer = setTimeout(() => {
        this.waiter = null;
        if (this.proc) this.proc.kill();
        reject(new Error('ssh timeout'));
      }, timeoutMs);
      this.waiter = {
        marker,
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      };
      this.proc.stdin.write(`${[...lines, `echo ${marker}`].join('\n')}\n`);
      this.pump();
    });
  }

  async batch(argvs) {
    const id = ++this.seq;
    const lines = argvs.flatMap((a, i) => [this.render(a), `echo @@D${id}_${i}`]);
    const out = this.clean(await this.exec(lines));
    const parts = [];
    let rest = out;
    for (let i = 0; i < argvs.length; i++) {
      const tag = `@@D${id}_${i}`;
      const at = rest.indexOf(tag);
      parts.push(at < 0 ? rest : rest.slice(0, at));
      rest = at < 0 ? '' : rest.slice(at + tag.length).replace(/^\r?\n/, '');
    }
    return parts;
  }

  clean(s) { return s; }

  async setup() {}

  async home() {
    if (!this.homeDir) this.homeDir = this.clean(await this.exec([this.homeCommand])).trim().split(/\r?\n/).pop().trim();
    return this.homeDir;
  }

  close() { if (this.proc) this.proc.kill(); }
}

const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

class SshTmuxSource extends ShellSource {
  get remoteShell() { return 'exec bash --norc --noprofile'; }

  get homeCommand() { return 'echo "$HOME"'; }

  init() { return []; }

  render(argv) { return `tmux ${argv.map(sq).join(' ')} </dev/null 2>&1`; }
}

// Windows over ssh. In an ssh logon, PATH lookups can stall for minutes on a UNC entry
// (e.g. a dead \\wsl$ path), so this drives cmd.exe, starts from a minimal PATH, then
// rebuilds the user's real PATH without UNC or missing folders. Sessions started from
// here inherit that PATH, so they get the user's tools (git, node, claude...).
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const CLEAN_PATH = "(([Environment]::GetEnvironmentVariable('Path','Machine') + ';' + " +
  "[Environment]::GetEnvironmentVariable('Path','User')) -split ';' | " +
  "Where-Object { $_ -and $_ -notlike '\\\\*' -and (Test-Path -LiteralPath $_ -PathType Container) } | " +
  'Select-Object -Unique) -join \';\'';

class SshPsmuxSource extends ShellSource {
  get remoteShell() { return 'cmd /q'; }

  get homeCommand() { return 'echo %USERPROFILE%'; }

  init() { return ['prompt @OO@', 'set "PATH=C:\\Windows\\system32;C:\\Windows"', 'chcp 65001 >nul']; }

  // psmux drops a session created over ssh with `-c dir` within a second, so start in
  // the default folder and change directory inside its PowerShell instead.
  cdCommand(dir) { return `Set-Location -LiteralPath '${dir.replace(/'/g, "''")}'`; }

  async setup() {
    // < NUL: otherwise PowerShell reads (and swallows) the commands queued after it
    const out = this.clean(await this.raw([`${POWERSHELL} -NoLogo -NoProfile -NonInteractive -Command "${CLEAN_PATH}" < NUL`], 30000));
    const clean = out.split(/\r?\n/).map((s) => s.trim()).filter((s) => /system32/i.test(s)).pop();
    if (clean && !/["%]/.test(clean)) await this.raw([`set "PATH=${clean}"`]);
  }

  render(argv) {
    const bin = this.cfg.psmux || 'psmux';
    const arg = (a) => {
      if (/["\r\n]/.test(a)) throw new Error('argument not allowed over cmd');
      return /[\s<>|&^%#{}()]/.test(a) ? `"${a}"` : a;
    };
    return `"${bin}" ${argv.map(arg).join(' ')} 2>&1`;
  }

  // drop the banner and the prompt cmd prints before every command
  clean(s) { return s.replace(/@OO@/g, '').replace(/^Microsoft Windows \[Version[^\n]*\n(\(c\)[^\n]*\n)?\s*/m, ''); }
}

function createSource(cfg) {
  if (cfg.type === 'ssh') return new SshTmuxSource(cfg);
  if (cfg.type === 'ssh-psmux') return new SshPsmuxSource(cfg);
  return new LocalSource(cfg);
}

module.exports = { createSource, LocalSource, SshTmuxSource, SshPsmuxSource, parseRow, hexChunks, FMT };
