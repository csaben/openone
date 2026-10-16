// Next-step suggestions per project: "everything's idle, what should I pick up?"
//
// Runs `codex exec` read-only (and --ephemeral, so it leaves no session behind) over what
// the project is up to: recent commits, uncommitted changes, the README, and what its
// agents last said. Projects on the server's own machine are opened in place, so Codex can
// read the code too; on other hosts it works from that summary. Up to three suggestions
// come back, each with a ready-to-send first message for an agent; the server turns them
// into an ask ("Start 1 / Start 2 / Start 3") so one tap starts the work.
//
// One run at a time; results are kept in ~/.local/state/openone/suggestions.json.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'why', 'prompt'],
        properties: {
          title: { type: 'string', description: 'Imperative, at most 70 characters' },
          why: { type: 'string', description: 'One sentence, grounded in the evidence' },
          prompt: { type: 'string', description: 'First message for a coding agent that does it; self-contained' },
        },
      },
    },
  },
};

function buildPrompt({ host, folder, context, agents = [], readable }) {
  const said = agents.length
    ? agents.map((a) => `- ${a.kind} "${a.label}"${a.asleep ? ' (asleep)' : ''}: ${[a.title, a.summary].filter(Boolean).join(' / ').slice(0, 400)}`).join('\n')
    : '(none recently)';
  return [
    `The user is picking up work on the project "${folder}" (on the machine "${host}"). Nothing is running there now.`,
    'Suggest up to 3 concrete next steps they could start right away, most valuable first. Skip anything that already looks done.',
    readable
      ? 'You are in the project folder: read the code, notes and TODOs as needed. Do not modify anything.'
      : 'You cannot see the code; work from the summary below.',
    'For each: a short imperative title, one sentence on why (point at the evidence), and the first message to give a coding agent to do it.',
    'Write that message so it stands alone (the agent starts fresh in the project folder), under 600 characters. Fewer than 3 is fine if that is all that is worth doing.',
    '',
    context,
    '',
    `What its agents last reported:\n${said}`,
  ].join('\n');
}

// -> { items: [{ title, why, prompt }] }
function runCodex({ bin, cwd, prompt, timeoutMs = 8 * 60000 }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oo-suggest-'));
  const schema = path.join(tmp, 'schema.json');
  const out = path.join(tmp, 'out.json');
  fs.writeFileSync(schema, JSON.stringify(SCHEMA));
  const args = ['exec', '--sandbox', 'read-only', '--ephemeral', '--skip-git-repo-check', '--color', 'never',
    '-C', cwd || tmp, '--output-schema', schema, '-o', out, prompt];
  const run = (b) => new Promise((resolve, reject) => {
    execFile(b, args, { timeout: timeoutMs, maxBuffer: 32 << 20, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err && err.code === 'ENOENT') return reject(err);
      let j = null;
      try { j = JSON.parse(fs.readFileSync(out, 'utf8')); } catch {}
      if (j && Array.isArray(j.items)) return resolve(j);
      reject(new Error(err ? String(stderr || err.message).trim().split('\n').pop() : 'codex returned no suggestions'));
    });
  });
  const fallback = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
  return run(bin || 'codex')
    .catch((e) => (e.code === 'ENOENT' && !bin ? run(fallback) : Promise.reject(e)))
    .finally(() => fs.rmSync(tmp, { recursive: true, force: true }));
}

const clean = (items) => (items || []).slice(0, 3).map((x) => ({
  title: String(x.title || '').trim().slice(0, 100),
  why: String(x.why || '').trim().slice(0, 400),
  prompt: String(x.prompt || '').trim().slice(0, 2000),
})).filter((x) => x.title && x.prompt);

class Suggester {
  // run(job) -> { items }; job: { host, folder, ... }
  constructor({ file = '', run, now = Date.now, onDone = () => {} }) {
    this.file = file;
    this.run = run;
    this.now = now;
    this.onDone = onDone;
    this.queue = [];
    this.busy = null;
    this.latest = {}; // "host|folder" -> { at, items, error }
    try { this.latest = JSON.parse(fs.readFileSync(file, 'utf8')).latest || {}; } catch {}
  }

  save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ latest: this.latest }, null, 1));
    } catch {}
  }

  // -> its place in line (0 = running now)
  request(job) {
    const k = `${job.host}|${job.folder}`;
    if (this.busy && `${this.busy.host}|${this.busy.folder}` === k) return 0;
    const i = this.queue.findIndex((j) => `${j.host}|${j.folder}` === k);
    if (i >= 0) return i + 1;
    this.queue.push(job);
    this.pump();
    return this.busy === job ? 0 : this.queue.indexOf(job) + 1;
  }

  async pump() {
    if (this.busy || !this.queue.length) return;
    const job = this.queue.shift();
    this.busy = job;
    const k = `${job.host}|${job.folder}`;
    try {
      const r = await this.run(job);
      this.latest[k] = { at: this.now(), items: clean(r.items) };
    } catch (e) {
      this.latest[k] = { at: this.now(), items: [], error: String(e.message || e).slice(0, 300) };
    }
    this.busy = null;
    this.save();
    try { this.onDone(job, this.latest[k]); } catch {}
    this.pump();
  }

  status() {
    return { running: this.busy ? `${this.busy.host}|${this.busy.folder}` : null, queued: this.queue.map((j) => `${j.host}|${j.folder}`), latest: this.latest };
  }
}

// "HH:MM" -> ms until the next time it's that time
function msUntil(hhmm, now = new Date()) {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return -1;
  const t = new Date(now);
  t.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (t <= now) t.setDate(t.getDate() + 1);
  return t - now;
}

module.exports = { Suggester, runCodex, buildPrompt, msUntil, SCHEMA, clean };
