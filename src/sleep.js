// Sleep and wake: fewer agents lying around, none lost.
//
// Sleeping an idle agent exits it the way you would (/exit), reads the resume command it
// prints on the way out ("claude --resume <id>", "codex resume <id>"), closes its window
// and remembers it. Waking opens a window in the same folder and resumes that
// conversation. With no id printed in time it leaves the window open; records without one
// (older ones) wake into the folder's latest
// conversation (--continue / resume --last).
//
// Kept in a JSON file next to the asks (~/.local/state/openone/sleeping.json).

const fs = require('fs');
const path = require('path');
const { agents, commandLine, slug } = require('./projects');

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const RESUME = {
  claude: new RegExp(`claude (?:--resume|-r) (${UUID})`, 'g'),
  codex: new RegExp(`codex resume (${UUID})`, 'g'),
};
const EXIT = { claude: '/exit', codex: '/quit' };

// the last resume id printed on a screen, or ''
function resumeId(kind, text) {
  const re = RESUME[kind];
  if (!re) return '';
  const all = [...String(text || '').matchAll(re)];
  return all.length ? all[all.length - 1][1] : '';
}

// the command that brings it back, built on the configured start command so its flags stay
function wakeCommand(cfg, kind, id) {
  const a = agents(cfg)[kind];
  if (!a) throw new Error(`can't wake a ${kind}`);
  if (!id) return a.resume;
  if (kind === 'claude') return `${a.start} --resume ${id}`;
  return `${a.start} resume ${id}`;
}

class Sleepers {
  constructor({ file = '', now = Date.now } = {}) {
    this.file = file;
    this.now = now;
    this.list = [];
    try { this.list = JSON.parse(fs.readFileSync(file, 'utf8')).sleeping || []; } catch {}
  }

  save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(`${this.file}.tmp`, JSON.stringify({ sleeping: this.list }, null, 1));
      fs.renameSync(`${this.file}.tmp`, this.file);
    } catch {}
  }

  add(rec) {
    const r = { id: `z${Math.random().toString(36).slice(2, 9)}`, sleptAt: this.now(), ...rec };
    this.list.push(r);
    this.save();
    return r;
  }

  take(id) {
    const r = this.list.find((x) => x.id === id);
    if (!r) throw Object.assign(new Error('no such sleeping agent'), { code: 404 });
    this.list = this.list.filter((x) => x !== r);
    this.save();
    return r;
  }

  put(r) { this.list.push(r); this.save(); }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// p: a pane record from the monitor; h: its host. -> what to remember
// Claude can take 10-30s to print its resume line (it writes a summary on the way out)
async function sleepAgent(h, p, { timeoutMs = 90000 } = {}) {
  if (!EXIT[p.kind]) throw new Error('only Claude and Codex agents can sleep');
  if (p.bg) throw new Error("background sessions can't sleep yet");
  if (p.state !== 'idle') throw new Error(p.state === 'working' ? "it's working; let it finish first" : 'it is waiting on you; answer it first');
  if (!p.path) throw new Error("don't know its folder");
  if (p.kind === 'claude') {
    // one Ctrl+C clears a half-typed draft that would end up in front of /exit (see actions.js)
    await h.src.keys(p, ['C-c']);
    await wait(150);
  }
  await h.src.text(p, EXIT[p.kind]);
  await h.src.keys(p, ['Enter']);
  let id = '';
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await wait(700);
    const text = await h.src.screen(p, 60).catch(() => '');
    id = resumeId(p.kind, text);
    if (id) break;
  }
  // no id: leave the window, so the conversation isn't lost to a guess at "the latest one"
  if (!id) throw new Error(`it didn't print a resume id within ${Math.round(timeoutMs / 1000)}s; left its window open`);
  await h.src.batch([['kill-pane', '-t', h.src.target(p)]]).catch(() => {});
  return {
    host: p.host, kind: p.kind, label: p.label, title: p.title || '', summary: p.summary || '',
    path: p.path, resume: id,
  };
}

// -> the new pane
async function wakeAgent(h, cfg, r) {
  const line = commandLine(h.src.shell, r.path, false, wakeCommand(cfg, r.kind, r.resume));
  return h.src.newWindow({ name: slug(r.label).replace(/\+/g, '-').slice(0, 40) || r.kind, line });
}

module.exports = { Sleepers, sleepAgent, wakeAgent, resumeId, wakeCommand };
