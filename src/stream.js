// Live pane screens over tmux control mode (`psmux -C attach`), so panes never have to
// be read with capture-pane, which on psmux can flash the attached terminal.
//
// One control client per session. psmux sends each pane's current screen when the
// client attaches, then everything the pane prints as `%output %id <escaped bytes>`.
// Each pane's bytes feed a headless terminal emulator, which holds the screen and
// scrollback that capture-pane would have returned. The client asks for ignore-size, so
// it never changes the size of anyone's windows.

const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');

// control mode escapes bytes below 32 and backslash as \ooo; the rest is raw UTF-8
function unescape(s) {
  return Buffer.from(s.replace(/\\(\d{3})|\\\\/g, (m, o) => (o ? String.fromCharCode(parseInt(o, 8)) : '\\')), 'latin1').toString('utf8');
}

class SessionStream {
  // spawn(session) -> child process speaking control mode on stdin/stdout
  constructor(session, spawn) {
    this.session = session;
    this.spawnFn = spawn;
    this.panes = new Map(); // paneId -> { term, serial, seen }
    this.sizes = new Map();
    this.proc = null;
    this.alive = false;
    this.startedAt = 0;
    this.buf = '';
  }

  start() {
    const proc = this.spawnFn(this.session);
    this.proc = proc;
    this.alive = true;
    this.startedAt = Date.now();
    this.buf = '';
    proc.stdout.setEncoding('latin1');
    proc.stdout.on('data', (d) => this.read(d));
    proc.stderr.on('data', () => {});
    const down = () => { if (this.proc === proc) { this.alive = false; this.proc = null; this.endedAt = Date.now(); } };
    proc.on('exit', down);
    proc.on('error', down);
    proc.stdin.on('error', () => {});
    proc.stdin.write('refresh-client -f ignore-size\n');
  }

  read(d) {
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, '');
      this.buf = this.buf.slice(i + 1);
      const m = line.match(/^%output (%\d+) (.*)$/);
      if (m) {
        const p = this.pane(m[1]);
        const data = unescape(m[2]);
        p.lastOutput = Date.now();
        if (p.seeding) p.pending.push(data);
        else p.term.write(data);
      } else if (/^%exit\b/.test(line)) {
        this.close();
      }
    }
  }

  pane(id) {
    let p = this.panes.get(id);
    if (!p) {
      const [cols, rows] = this.sizes.get(id) || [80, 24];
      p = { term: new Terminal({ cols, rows, scrollback: 2000, allowProposedApi: true }), seeded: false, seeding: false, pending: [] };
      this.panes.set(id, p);
    }
    return p;
  }

  // keep each emulator the pane's real size, and drop panes that are gone
  sync(rows) {
    const keep = new Set();
    for (const r of rows) {
      keep.add(r.paneId);
      const cols = Number(r.width);
      const lines = Number(r.height);
      if (!(cols > 0 && lines > 0)) continue;
      this.sizes.set(r.paneId, [cols, lines]);
      const p = this.panes.get(r.paneId);
      if (p && (p.term.cols !== cols || p.term.rows !== lines)) p.term.resize(cols, lines);
    }
    for (const id of this.panes.keys()) {
      if (!keep.has(id)) { this.panes.get(id).term.dispose(); this.panes.delete(id); this.sizes.delete(id); }
    }
  }

  // A pane's screen is known once it has been seeded: psmux doesn't replay screens to a
  // new control client, and output alone may only redraw a few cells.
  ready(id) {
    if (!this.alive) return false;
    const p = this.panes.get(id);
    return !!(p && p.seeded);
  }

  // Seeding is one capture-pane -e. Output that arrives meanwhile is held, then applied
  // on top of the capture, so nothing printed during the read is lost.
  beginSeed(id) {
    const p = this.pane(id);
    p.seeding = true;
    p.pending = [];
  }

  // text is `capture-pane -p -e -S -n` (no -J): history, then exactly `rows` screen lines,
  // which have to land on the same rows as the real screen for later output to fit
  // `history`: how many history lines the capture holds, when known, which tells a blank
  // last screen row apart from the newline that ends the output (psmux may not print one)
  seed(id, text, { cursor = null, alt = false, rows = 0, history = null } = {}) {
    const p = this.pane(id);
    p.term.reset();
    let lines = String(text).replace(/\r/g, '').split('\n');
    const expected = rows && history !== null ? history + rows : null;
    if (lines.length && lines[lines.length - 1] === '' && (expected === null || lines.length > expected)) lines.pop();
    if (rows) {
      while (lines.length < rows) lines.push('');
      if (alt) lines = lines.slice(-rows);
    }
    let data = `${alt ? '\x1b[?1049h' : ''}${lines.join('\r\n')}`;
    if (cursor && cursor.every((v) => Number.isFinite(v))) data += `\x1b[${cursor[1] + 1};${cursor[0] + 1}H`;
    p.term.write(data);
    for (const d of p.pending) p.term.write(d);
    p.pending = [];
    p.seeding = false;
    p.seeded = true;
  }

  // the read failed: apply what arrived and try again later
  abortSeed(id) {
    const p = this.panes.get(id);
    if (!p) return;
    for (const d of p.pending) p.term.write(d);
    p.pending = [];
    p.seeding = false;
  }

  // like `capture-pane -p -J -S -n`: the last n lines of history plus the screen, with
  // wrapped lines joined
  text(id, n = 60) {
    const p = this.panes.get(id);
    if (!p) return '';
    const b = p.term.buffer.active;
    const from = Math.max(0, b.baseY - n);
    const out = [];
    for (let y = from; y < b.length; y++) {
      const line = b.getLine(y);
      if (!line) continue;
      const s = line.translateToString(true);
      if (line.isWrapped && out.length) out[out.length - 1] += s;
      else out.push(s);
    }
    return out.join('\n');
  }

  // when the pane last printed anything (0 if not since attaching)
  lastOutput(id) {
    const p = this.panes.get(id);
    return (p && p.lastOutput) || 0;
  }

  // the same with colors, as ANSI escapes (for the web viewer)
  ansi(id, n = 200) {
    const p = this.panes.get(id);
    if (!p) return '';
    if (!p.serial) { p.serial = new SerializeAddon(); p.term.loadAddon(p.serial); }
    return p.serial.serialize({ scrollback: n });
  }

  close() {
    this.alive = false;
    if (this.proc) { try { this.proc.kill(); } catch {} }
    this.proc = null;
    for (const p of this.panes.values()) p.term.dispose();
    this.panes.clear();
  }
}

// Default `list-clients` output (psmux 3.3 ignores -F): "/dev/pts/12: main: pwsh [200x50] (utf8) (control mode) [activity=2s ago]".
// With -F '#{client_name} #{session_name} #{client_control_mode} #{client_activity}' (tmux): "name sess 0 1792000000".
// -> [{ name, session, control, recent }] where a lower `recent` is more recently active.
function parseClients(out) {
  const now = Math.floor(Date.now() / 1000);
  return String(out).split(/\r?\n/).map((l) => {
    let m = l.match(/^(\S+): ([^:\s]+): /);
    if (m) {
      const a = l.match(/\[activity=(\d+)s ago\]/);
      return { name: m[1], session: m[2], control: /\(control mode\)/.test(l), recent: a ? Number(a[1]) : 0 };
    }
    m = l.trim().match(/^(\S+) (\S+) ([01]) (\d+)$/);
    if (m) return { name: m[1], session: m[2], control: m[3] === '1', recent: now - Number(m[4]) };
    return null;
  }).filter(Boolean);
}

module.exports = { SessionStream, parseClients, unescape };
