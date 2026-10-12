// Pane sources. Each exposes snapshot(), focus(p), keys(p, [...]), text(p, s).
//   psmux: local Windows tmux clone, driven with one execFile per call.
//   ssh:   real tmux on a remote box, driven through one long-lived `ssh host bash`.
//
// psmux runs one server per session and pane ids repeat across them, so local
// targets are always `session:window.%id`. Plain `%id` silently hits session 0.

const { execFile, spawn } = require('child_process');

const SEP = '<|>';
const FIELDS = ['pane_id', 'session_name', 'window_index', 'window_name', 'pane_index', 'pane_current_command',
  'pane_current_path', 'pane_title', 'window_active', 'pane_active', 'session_attached',
  'history_size', 'cursor_x', 'cursor_y'];
const FMT = FIELDS.map((f) => `#{${f}}`).join(SEP);

function parseRow(line) {
  const v = line.split(SEP);
  if (v.length < FIELDS.length || !v[0].startsWith('%')) return null;
  return {
    paneId: v[0], session: v[1], windowIndex: v[2], windowName: v[3], paneIndex: v[4],
    command: v[5], path: v[6], title: v[7], windowActive: v[8], paneActive: v[9], attached: v[10] !== '0',
    sig: `${v[11]}/${v[12]}/${v[13]}`, text: '',
  };
}

class PsmuxSource {
  constructor(cfg) {
    this.cfg = cfg;
    this.bin = cfg.bin || 'psmux';
    this.cache = new Map();
  }

  run(args) {
    return new Promise((resolve, reject) => {
      execFile(this.bin, args, { windowsHide: true, maxBuffer: 16 << 20, timeout: 8000, encoding: 'utf8' },
        (err, out) => (err ? reject(err) : resolve(out)));
    });
  }

  target(p) { return `${p.session}:${p.windowIndex}.${p.paneId}`; }

  async snapshot() {
    const out = await this.run(['list-panes', '-a', '-F', FMT]);
    const panes = out.split(/\r?\n/).map(parseRow).filter(Boolean);
    // capture-pane makes the attached psmux client flash other windows now and then,
    // so only re-read a pane when its scrollback/cursor moved, plus a slow refresh.
    const now = Date.now();
    const keep = new Set();
    for (const p of panes) {
      const key = `${p.session}|${p.paneId}`;
      keep.add(key);
      const c = this.cache.get(key);
      if (c && c.sig === p.sig && now - c.at < (this.cfg.refreshMs || 20000)) { p.text = c.text; continue; }
      p.text = await this.run(['capture-pane', '-p', '-J', '-S', `-${this.cfg.lines || 60}`, '-t', this.target(p)]).catch(() => '');
      this.cache.set(key, { sig: p.sig, text: p.text, at: now });
    }
    for (const key of this.cache.keys()) if (!keep.has(key)) this.cache.delete(key);
    return panes;
  }

  async focus(p) {
    // the terminal shows whichever session is attached; bring this one onto it
    if (!p.attached) await this.run(['switch-client', '-t', p.session]).catch(() => {});
    await this.run(['select-window', '-t', `${p.session}:${p.windowIndex}`]);
    await this.run(['select-pane', '-t', this.target(p)]);
  }

  keys(p, keys) { return this.run(['send-keys', '-t', this.target(p), ...keys]); }

  text(p, s) { return this.run(['send-keys', '-t', this.target(p), '-l', s]); }
}

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

class SshSource {
  constructor(cfg) {
    this.cfg = cfg;
    this.bin = cfg.sshBin || 'C:\\Program Files\\OpenSSH\\ssh.exe';
    this.proc = null;
    this.buf = '';
    this.waiter = null;
    this.seq = 0;
    this.chain = Promise.resolve();
  }

  connect() {
    if (this.proc) return;
    const args = ['-T', '-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=15', '-o', 'ConnectTimeout=6',
      this.cfg.ssh, 'exec bash --norc --noprofile'];
    const proc = spawn(this.bin, args, { windowsHide: true });
    this.proc = proc;
    this.buf = '';
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
    this.buf = this.buf.slice(i + this.waiter.marker.length);
    const w = this.waiter;
    this.waiter = null;
    w.resolve(out);
  }

  // Runs a bash snippet on the remote shell; calls are serialized.
  exec(script, timeoutMs = 10000) {
    const run = () => new Promise((resolve, reject) => {
      this.connect();
      if (!this.proc) return reject(new Error('ssh not running'));
      const marker = `__OO_${++this.seq}__\n`;
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
      this.proc.stdin.write(`${script}\necho __OO_${this.seq}__\n`);
      this.pump();
    });
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  async snapshot() {
    const n = this.cfg.lines || 60;
    const out = await this.exec(
      `tmux list-panes -a -F ${q(FMT)} </dev/null 2>/dev/null | while IFS= read -r l; do ` +
      `printf '@@P %s\\n' "$l"; tmux capture-pane -p -J -S -${n} -t "\${l%%<|>*}" </dev/null 2>/dev/null; done`);
    const panes = [];
    let cur = null;
    for (const line of out.split('\n')) {
      if (line.startsWith('@@P ')) {
        cur = parseRow(line.slice(4));
        if (cur) panes.push(cur);
      } else if (cur) cur.text += `${line}\n`;
    }
    return panes;
  }

  focus(p) {
    const t = q(p.paneId);
    return this.exec(
      `c=$(tmux list-clients -F '#{client_activity} #{client_name}' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-); ` +
      `[ -n "$c" ] && tmux switch-client -c "$c" -t ${t}; tmux select-window -t ${t}; tmux select-pane -t ${t}`);
  }

  keys(p, keys) { return this.exec(`tmux send-keys -t ${q(p.paneId)} ${keys.map(q).join(' ')}`); }

  text(p, s) { return this.exec(`tmux send-keys -t ${q(p.paneId)} -l -- ${q(s)}`); }

  close() { if (this.proc) this.proc.kill(); }
}

function createSource(cfg) {
  if (cfg.type === 'ssh') return new SshSource(cfg);
  return new PsmuxSource(cfg);
}

module.exports = { createSource, PsmuxSource, SshSource, parseRow, FMT };
