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
const { SessionStream, parseClients } = require('./stream');
const { Background, ID: BG_ID } = require('./bg');

const SEP = '<|>';
const FIELDS = ['pane_id', 'session_name', 'window_index', 'window_name', 'pane_index', 'pane_current_command',
  'pane_current_path', 'pane_title', 'window_active', 'pane_active', 'session_attached',
  'history_size', 'cursor_x', 'cursor_y', 'pane_width', 'pane_height', 'alternate_on'];
const REQUIRED = 14; // rows from before pane_width/pane_height still parse
const FMT = FIELDS.map((f) => `#{${f}}`).join(SEP);
const SESSION_NAME = /^[A-Za-z0-9_.-]{1,40}$/;

function parseRow(line) {
  const v = line.replace(/\r$/, '').split(SEP);
  if (v.length < REQUIRED || !v[0].startsWith('%')) return null;
  return {
    paneId: v[0], session: v[1], windowIndex: v[2], windowName: v[3], paneIndex: v[4],
    command: v[5], path: v[6], title: v[7], windowActive: v[8], paneActive: v[9], attached: v[10] !== '0',
    sig: `${v[11]}/${v[12]}/${v[13]}`, width: v[14], height: v[15], alt: v[16] === '1', cursor: [Number(v[12]), Number(v[13])], text: '',
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
    this.streams = new Map(); // session -> SessionStream
    this.clients = null;
  }

  target(p) { return `${p.session}:${p.windowIndex}.${p.paneId}`; }

  // Stream pane output over control mode instead of polling capture-pane: on by default
  // for psmux, where every capture can flash the attached terminal.
  get streaming() { return !!(this.controlSpawn && (this.cfg.stream ?? this.psmux)); }

  // keep one control client per session that has panes, restarting dead ones after 5s
  syncStreams(panes) {
    const now = Date.now();
    const bySession = new Map();
    for (const p of panes) {
      if (!bySession.has(p.session)) bySession.set(p.session, []);
      bySession.get(p.session).push(p);
    }
    for (const [name, st] of this.streams) if (!bySession.has(name)) { st.close(); this.streams.delete(name); }
    for (const [name, rows] of bySession) {
      if (!SESSION_NAME.test(name)) continue;
      let st = this.streams.get(name);
      if (!st) { st = new SessionStream(name, (sess) => this.controlSpawn(sess)); this.streams.set(name, st); }
      if (!st.alive && now - (st.endedAt || 0) > 5000) { try { st.start(); } catch { st.endedAt = now; } }
      st.sync(rows);
    }
  }

  // Clients other than control-mode ones (ours included), refreshed every few seconds.
  // session_attached counts control clients, so streamed sessions would all look attached.
  async realClients(maxAgeMs = 5000) {
    if (!this.clients || Date.now() - this.clients.at > maxAgeMs) {
      const [out] = await this.batch([['list-clients', '-F', '#{client_name} #{session_name} #{client_control_mode} #{client_activity}']]);
      this.clients = { at: Date.now(), list: parseClients(out).filter((c) => !c.control) };
    }
    return this.clients.list;
  }

  // a pane's screen for viewers: from the stream when it has one, else capture-pane
  async screen(p, lines = 200, color = false) {
    const st = this.streams.get(p.session);
    if (st && st.ready(p.paneId)) return color ? st.ansi(p.paneId, lines) : st.text(p.paneId, lines);
    const [text] = await this.batch([['capture-pane', '-p', ...(color ? ['-e'] : []), '-J', '-S', `-${lines}`, '-t', this.target(p)]]);
    return text.replace(/\r/g, '');
  }

  async snapshot() {
    const [list] = await this.batch([['list-panes', '-a', '-F', FMT]]);
    const all = list.split('\n').map(parseRow).filter(Boolean);
    const n = this.cfg.lines || 60;
    const streamed = new Set();
    if (this.streaming) {
      this.syncStreams(all);
      const real = new Set((await this.realClients().catch(() => [])).map((c) => c.session));
      const seed = [];
      for (const p of all) {
        p.attached = real.has(p.session);
        const st = this.streams.get(p.session);
        if (!st || !st.alive) continue;
        if (st.ready(p.paneId)) { p.text = st.text(p.paneId, n); streamed.add(p); continue; }
        // A pane that hasn't printed since the client attached has an unknown screen, so it's
        // read once with capture-pane. One pane per poll: a burst of captures flashes.
        if (seed.length < (this.cfg.seedPerPoll ?? 1)) seed.push(p);
        else { p.text = (this.cache.get(`${p.session}|${p.paneId}`) || {}).text || ''; streamed.add(p); }
      }
      if (seed.length) {
        for (const p of seed) this.streams.get(p.session).beginSeed(p.paneId);
        let texts = null;
        try {
          texts = await this.batch(seed.map((p) => ['capture-pane', '-p', '-e', '-S', `-${n}`, '-t', this.target(p)]));
        } finally {
          seed.forEach((p, i) => {
            const st = this.streams.get(p.session);
            if (!texts) { st.abortSeed(p.paneId); return; }
            const hist = Number(p.sig.split('/')[0]);
            st.seed(p.paneId, texts[i] || '', {
              cursor: p.cursor, alt: p.alt, rows: Number(p.height) || 0, history: Number.isFinite(hist) ? Math.min(hist, n) : null,
            });
            p.text = st.text(p.paneId, n);
            streamed.add(p);
          });
        }
      }
      for (const p of streamed) this.cache.set(`${p.session}|${p.paneId}`, { sig: p.sig, text: p.text, at: Date.now() });
    }
    const panes = all.filter((p) => !streamed.has(p));
    // Capturing is the expensive part, and on psmux each capture can flash another window
    // in the attached client. So only re-read a pane when its scrollback/cursor moved (at
    // most every captureEveryMs per pane), plus a slow refresh for in-place redraws that
    // don't move the cursor. The refresh is staggered, one overdue pane per poll, because
    // refreshing every pane at once flashed the terminal ~16 times in a burst.
    // Real tmux doesn't flash, so it isn't throttled by default.
    const now = Date.now();
    const gap = this.cfg.captureEveryMs ?? (this.psmux ? 4000 : 0);
    const refreshMs = this.cfg.refreshMs || (this.psmux ? 45000 : 20000);
    const perPoll = this.cfg.refreshPerPoll ?? (this.psmux ? 1 : Infinity);
    const stale = [];
    const overdue = [];
    for (const p of panes) {
      const c = this.cache.get(`${p.session}|${p.paneId}`);
      const age = c ? now - c.at : Infinity;
      if (!c || (c.sig !== p.sig && age >= gap)) stale.push(p);
      else {
        p.text = c.text;
        if (age >= refreshMs) overdue.push([age, p]);
      }
    }
    overdue.sort((a, b) => b[0] - a[0]).slice(0, perPoll).forEach(([, p]) => stale.push(p));
    const texts = stale.length ? await this.batch(stale.map((p) => ['capture-pane', '-p', '-J', '-S', `-${n}`, '-t', this.target(p)])) : [];
    stale.forEach((p, i) => {
      p.text = (texts[i] || '').replace(/\r/g, '');
      this.cache.set(`${p.session}|${p.paneId}`, { sig: p.sig, text: p.text, at: now });
    });
    const keep = new Set(all.map((p) => `${p.session}|${p.paneId}`));
    for (const key of this.cache.keys()) if (!keep.has(key)) this.cache.delete(key);
    // Claude background sessions run outside tmux; list them too (config "background": false turns it off)
    if (this.cfg.background !== false) {
      if (!this.bg) this.bg = new Background(this);
      all.push(...await this.bg.rows(all).catch(() => []));
    }
    return all;
  }

  async focus(p) {
    const cmds = [];
    const clients = (await this.realClients(0).catch(() => [])).sort((a, b) => a.recent - b.recent);
    if (!clients.some((c) => c.session === p.session)) {
      // move the most recently used terminal (never a control client) onto this pane's session
      cmds.push(clients[0] ? ['switch-client', '-c', clients[0].name, '-t', p.session] : ['switch-client', '-t', p.session]);
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

  // Opens a window in the session a terminal is showing (the attached one, most recently
  // active first), so it appears in that Windows Terminal tab, and types `line` into its
  // shell. With no session at all, starts one. Returns the new pane.
  async newWindow({ name, line }) {
    if (!SESSION_NAME.test(name || '')) throw new Error('window name: letters, digits, _ . - only');
    const [list] = await this.batch([['list-sessions', '-F', '#{session_attached} #{session_activity} #{session_name}']]);
    const shown = new Set((await this.realClients(0).catch(() => [])).map((c) => c.session));
    const sessions = list.split('\n').map((l) => l.trim().match(/^(\d+) (\d+) (\S+)$/)).filter(Boolean)
      .map((m) => [m[0], shown.size ? (shown.has(m[3]) ? '1' : '0') : m[1], m[2], m[3]])
      .sort((a, b) => (Number(b[1] !== '0') - Number(a[1] !== '0')) || Number(b[2]) - Number(a[2]));
    if (!sessions.length) return this.newSession({ name, cmd: line });
    const session = sessions[0][3];
    const [out] = await this.batch([['new-window', '-d', '-t', `${session}:`, '-n', name, '-P', '-F', FMT]]);
    const pane = out.split('\n').map(parseRow).filter(Boolean)[0];
    if (!pane) throw new Error(`could not open a window: ${out.trim().split('\n')[0] || 'no pane'}`);
    pane.attached = sessions[0][1] !== '0';
    await this.waitForPrompt(pane);
    if (line) {
      await this.text(pane, line);
      await this.keys(pane, ['Enter']);
    }
    return pane;
  }

  // Keys typed before the shell is ready are lost (PowerShell takes a few seconds to load
  // its profile), so wait until the last line looks like a prompt.
  async waitForPrompt(pane, timeoutMs = this.cfg.shellReadyMs || 10000) {
    const until = Date.now() + timeoutMs;
    const min = this.cfg.shellWarmMs ?? 400;
    await new Promise((r) => setTimeout(r, min));
    while (Date.now() < until) {
      const text = await this.screen(pane, 0);
      const last = text.replace(/\r/g, '').split('\n').map((l) => l.trimEnd()).filter(Boolean).pop() || '';
      if (/(^PS .*>|[$#>%❯])$/.test(last)) return true;
      await new Promise((r) => setTimeout(r, 300));
    }
    return false;
  }

  // Opens a Claude background session in a tmux window (so it can be seen and answered
  // like any pane), or returns the window that already shows it.
  async attachBackground(id) {
    if (!BG_ID.test(id || '')) throw new Error('bad background session id');
    const [list] = await this.batch([['list-panes', '-a', '-F', FMT]]);
    const open = list.split('\n').map(parseRow).filter(Boolean).find((p) => p.windowName === `bg-${id}`);
    if (open) return open;
    if (this.bg) this.bg.at = 0; // relist soon, so the row turns into the window
    return this.newWindow({ name: `bg-${id}`, line: `claude attach ${id}` });
  }

  // the shell new windows start in, which decides how project commands are written
  get shell() { return this.cfg.shell || (this.psmux ? 'powershell' : 'bash'); }

  join(dir, name) { return this.psmux ? `${dir.replace(/[\\/]+$/, '')}\\${name}` : `${dir.replace(/\/+$/, '')}/${name}`; }

  async resolve(dir) {
    return /^~(?=$|[\\/])/.test(dir) ? (await this.home()) + dir.slice(1) : dir;
  }

  async killSession(name) {
    if (!SESSION_NAME.test(name || '')) throw new Error('bad session name');
    await this.batch([['kill-session', '-t', name]]);
  }

  close() { for (const st of this.streams.values()) st.close(); this.streams.clear(); }
}

class LocalSource extends TmuxSource {
  constructor(cfg) {
    super(cfg);
    this.bin = cfg.bin || (cfg.type === 'tmux' ? 'tmux' : 'psmux');
  }

  get psmux() { return /psmux/i.test(this.bin); }

  controlSpawn(session) { return spawn(this.bin, ['-C', 'attach', '-t', session], { windowsHide: true }); }

  // services (systemd, login items) often lack ~/.local/bin, where claude installs itself
  claude(args) {
    const run = (bin) => new Promise((resolve, reject) => {
      execFile(bin, args, { windowsHide: true, maxBuffer: 16 << 20, timeout: 15000, encoding: 'utf8' },
        (err, out) => (err && !out ? reject(err) : resolve(out)));
    });
    if (this.cfg.claude) return run(this.cfg.claude);
    return run('claude').catch((e) => {
      if (e.code !== 'ENOENT') throw e;
      return run(require('path').join(require('os').homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude'));
    });
  }

  claudeAgents() { return this.claude(['agents', '--json']); }

  claudeLogs(id) { return this.claude(['logs', id]); }

  async home() { return require('os').homedir(); }

  // [{ name, mtime }] for the folders in dir, newest first
  async listDirs(dir) {
    const fs = require('fs');
    const path = require('path');
    const root = await this.resolve(dir);
    const out = [];
    for (const d of await fs.promises.readdir(root, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith('.')) continue;
      const st = await fs.promises.stat(path.join(root, d.name)).catch(() => null);
      out.push({ name: d.name, mtime: st ? st.mtimeMs : 0 });
    }
    return out.sort((a, b) => b.mtime - a.mtime);
  }

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

  close() { super.close(); if (this.proc) this.proc.kill(); }

  sshArgs(command) {
    return ['-T', '-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=15', '-o', 'ConnectTimeout=6', this.cfg.ssh, command];
  }
}

const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

class SshTmuxSource extends ShellSource {
  get remoteShell() { return 'exec bash --norc --noprofile'; }

  get homeCommand() { return 'echo "$HOME"'; }

  init() { return []; }

  render(argv) { return `tmux ${argv.map(sq).join(' ')} </dev/null 2>&1`; }

  controlSpawn(session) { return spawn(this.ssh, this.sshArgs(`tmux -C attach -t ${sq(session)}`), { windowsHide: true }); }

  // bash --norc doesn't have ~/.local/bin, where claude installs itself
  claudeCmd(args) { return `PATH="$HOME/.local/bin:$PATH" ${this.cfg.claude || 'claude'} ${args} </dev/null 2>/dev/null; echo`; }

  async claudeAgents() { return this.exec([this.claudeCmd('agents --json')]); }

  async claudeLogs(id) { return this.exec([this.claudeCmd(`logs ${id}`)]); }

  async listDirs(dir) {
    const root = await this.resolve(dir);
    const out = await this.exec([`find ${sq(root)} -mindepth 1 -maxdepth 1 -type d -not -name '.*' -printf '@@%T@ %f\\n' 2>/dev/null`]);
    return out.split('\n').map((l) => l.match(/^@@([\d.]+) (.+)$/)).filter(Boolean)
      .map((m) => ({ name: m[2], mtime: Number(m[1]) * 1000 })).sort((a, b) => b.mtime - a.mtime);
  }
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
  get psmux() { return true; }

  get remoteShell() { return 'cmd /q'; }

  async claudeAgents() { return this.clean(await this.exec([`${this.cfg.claude || 'claude'} agents --json 2>nul < NUL`])); }

  async claudeLogs(id) { return this.clean(await this.exec([`${this.cfg.claude || 'claude'} logs ${id} 2>nul < NUL`])); }

  controlSpawn(session) {
    return spawn(this.ssh, this.sshArgs(`"${this.cfg.psmux || 'psmux'}" -C attach -t ${session}`), { windowsHide: true });
  }

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

  async listDirs(dir) {
    const root = await this.resolve(dir);
    if (/["\r\n%]/.test(root)) throw new Error('bad workspace path');
    const out = this.clean(await this.exec([`dir /b /ad "${root}" 2>nul`, 'echo @@END']));
    return out.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && s !== '@@END' && !s.startsWith('.') && !/^dir \/b/i.test(s))
      .map((name) => ({ name, mtime: 0 }));
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
