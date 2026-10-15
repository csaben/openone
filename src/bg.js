// Claude Code background sessions (`claude --bg`, or started by tools such as trident).
// They run under Claude's own daemon in a private terminal, not in tmux, so tmux can't
// list them. `claude agents --json` does, with Claude's own status, and `claude logs`
// prints a session's recent screen. Each becomes a pane-like row; opening one starts
// `claude attach <id>` in a tmux window named bg-<id>, which then stands in for the row.

const { Terminal } = require('@xterm/headless');

const ID = /^[0-9a-f]{6,40}$/i;

// `claude agents --json` -> the background sessions
function parseAgents(out) {
  const s = String(out);
  const at = s.indexOf('[');
  if (at < 0) return [];
  let list;
  try { list = JSON.parse(s.slice(at, s.lastIndexOf(']') + 1)); } catch { return []; }
  return (Array.isArray(list) ? list : [])
    .filter((a) => a && a.kind === 'background' && ID.test(String(a.id || '')))
    .map((a) => ({ id: String(a.id), cwd: String(a.cwd || ''), name: String(a.name || ''), status: String(a.status || ''), state: String(a.state || '') }));
}

// Claude's status -> openone's: blocked means it's waiting on you
function stateOf(a) {
  if (a.state === 'blocked') return 'input';
  if (a.status === 'busy') return 'working';
  return 'idle';
}

// replay `claude logs` output (raw terminal bytes) to get the screen as text
function screenText(data, cols = 200, rows = 60) {
  return new Promise((resolve) => {
    const term = new Terminal({ cols, rows, scrollback: 400, allowProposedApi: true });
    term.write(String(data).replace(/\r?\n/g, '\r\n'), () => {
      const b = term.buffer.active;
      const out = [];
      for (let y = Math.max(0, b.length - rows - 60); y < b.length; y++) {
        const line = b.getLine(y);
        if (!line) continue;
        const t = line.translateToString(true);
        if (line.isWrapped && out.length) out[out.length - 1] += t;
        else out.push(t);
      }
      term.dispose();
      resolve(out.join('\n'));
    });
  });
}

// Keeps the background sessions of one host, refreshing the list every `everyMs` and a
// session's screen when its state changes (or every `textMs`).
class Background {
  constructor(src, { everyMs = 5000, textMs = 60000 } = {}) {
    this.src = src;
    this.everyMs = everyMs;
    this.textMs = textMs;
    this.list = [];
    this.at = 0;
    this.texts = new Map(); // id -> { text, state, at }
    this.failed = false;
  }

  async rows(panes) {
    if (Date.now() - this.at >= this.everyMs) {
      this.at = Date.now();
      try { this.list = parseAgents(await this.src.claudeAgents()); this.failed = false; } catch { this.list = []; this.failed = true; }
    }
    const attached = new Set(panes.map((p) => p.windowName));
    const out = [];
    for (const a of this.list) {
      if (attached.has(`bg-${a.id}`)) continue; // open in a window: that pane is the row now
      const state = stateOf(a);
      let t = this.texts.get(a.id);
      if (!t || t.state !== state || Date.now() - t.at > this.textMs) {
        let text = t ? t.text : '';
        try { text = await screenText(await this.src.claudeLogs(a.id)); } catch {}
        t = { text, state, at: Date.now() };
        this.texts.set(a.id, t);
      }
      out.push({
        paneId: `bg:${a.id}`, session: 'bg', windowIndex: '', windowName: '', paneIndex: '0', command: 'claude',
        path: a.cwd, title: a.name, windowActive: '0', paneActive: '0', attached: false, sig: '', text: t.text,
        bg: a.id, override: { kind: 'claude', state },
      });
    }
    for (const id of this.texts.keys()) if (!this.list.some((a) => a.id === id)) this.texts.delete(id);
    return out;
  }
}

module.exports = { Background, parseAgents, stateOf, screenText, ID };
