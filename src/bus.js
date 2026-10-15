// Messages between agents. An agent's openone MCP tools (tools/mcp.js) call the server,
// which queues each message here and delivers it the best way the target supports:
//
//   channel  a Claude session started with the openone channel gets it pushed as a
//            <channel source="openone"> event, without waiting for its turn to end
//   typed    anything else gets it typed in as a prompt, once the agent is idle (never
//            mid-turn or while it shows you a menu)
//
// Every message is logged, so the UI can show who said what to whom. Two guards keep
// agents from talking forever: a hop count on reply chains (a message sent by an agent
// that was itself just messaged is one hop further; you using the agent resets it) and
// a per-agent rate limit.

const HOPS = 6;
const HOP_WINDOW = 30 * 60000; // a message counts as a reply to one received this recently
const RATE = { n: 30, ms: 10 * 60000 };
const EXPIRE = 2 * 3600000; // queued this long without the target going idle: give up
const LOG = 200;

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';

// Unique names that stay put while the pane lives: "label@host", or "label.<pane>@host"
// when a host has several agents with the same label ("er-apex.52@inari" is pane %52),
// plus the session if pane numbers repeat (psmux numbers panes per session).
// -> Map key -> name
function names(panes) {
  const out = new Map();
  const forms = [
    (p) => `${slug(p.label)}@${p.host}`,
    (p) => `${slug(p.label)}.${String(p.paneId).replace('%', '')}@${p.host}`,
    (p) => `${slug(p.label)}.${slug(p.session)}.${String(p.paneId).replace('%', '')}@${p.host}`,
  ];
  for (const p of panes) {
    for (const f of forms) {
      const n = f(p);
      if (f === forms[forms.length - 1] || panes.filter((x) => f(x) === n).length === 1) { out.set(p.key, n); break; }
    }
  }
  return out;
}

// The one line typed into a pane. Newlines would submit early, so they become " ⏎ ".
function typedLine(m) {
  const body = String(m.content).replace(/\r/g, '').split('\n').map((l) => l.trimEnd()).join(' ⏎ ').trim();
  return `[openone message from ${m.from} · answer with the openone send tool, to="${m.from}"] ${body}`;
}

class Bus {
  // monitor: has view(); deliver(p, text): types into a pane; now(): clock (tests)
  constructor({ monitor, deliver, now = Date.now }) {
    this.monitor = monitor;
    this.deliver = deliver;
    this.now = now;
    this.log = [];
    this.seq = 0;
    this.channels = new Map(); // pane key -> push(message) for sessions listening on the channel
    this.hopIn = new Map(); // pane key -> { hop, at } of the last message it received
    this.sent = new Map(); // pane key -> [times]
    this.busy = false;
  }

  agents() { return this.monitor.view().filter((p) => p.kind); }

  names() { return names(this.agents()); }

  // the pane an MCP client runs in: { host, pane: "%12", session? } -> monitor record
  whoami({ host, pane, session } = {}) {
    if (!host || !pane) return null;
    const h = String(host).toLowerCase();
    const all = this.monitor.view().filter((p) => p.host.toLowerCase() === h && p.paneId === pane);
    return all.find((p) => !session || p.session === session) || null;
  }

  // "photo-tidy@inari", a pane key, or a bare label when it's unique
  resolve(to) {
    const t = String(to || '').trim();
    if (!t) return null;
    const agents = this.agents();
    const nm = names(agents);
    let hit = agents.find((p) => p.key === t || nm.get(p.key) === t.toLowerCase());
    if (hit) return hit;
    const bare = agents.filter((p) => nm.get(p.key).split('@')[0] === slug(t) || slug(p.label) === slug(t));
    if (bare.length === 1) return bare[0];
    if (bare.length > 1) throw new Error(`"${t}" matches ${bare.length} agents: ${bare.map((p) => nm.get(p.key)).join(', ')}`);
    return null;
  }

  roster(me) {
    const nm = this.names();
    return this.agents().map((p) => ({
      name: nm.get(p.key), host: p.host, kind: p.kind, state: p.state === 'idle' && p.unseen ? 'done' : p.state,
      title: p.title || '', summary: p.summary || '', path: p.path || '', you: !!(me && me.key === p.key) || undefined,
      channel: this.channels.has(p.key) || undefined, background: !!p.bg || undefined,
    }));
  }

  // from: the sender's pane record, or null with fromName for a caller outside any pane
  // -> the logged message. Throws on a bad target, the hop limit or the rate limit.
  send({ from, fromName, to, content }) {
    const text = String(content || '').trim();
    if (!text) throw new Error('empty message');
    if (text.length > 8000) throw new Error('message too long (8000 characters max); put long content in a file and send its path');
    const target = this.resolve(to);
    if (!target) throw new Error(`no agent named "${to}"; call roster to see who's running`);
    if (from && from.key === target.key) throw new Error("that's you");
    const now = this.now();
    let hop = 0;
    if (from) {
      const t = (this.sent.get(from.key) || []).filter((x) => now - x < RATE.ms);
      if (t.length >= RATE.n) throw new Error(`rate limit: ${RATE.n} messages per ${RATE.ms / 60000} minutes`);
      t.push(now);
      this.sent.set(from.key, t);
      const h = this.hopIn.get(from.key);
      if (h && now - h.at < HOP_WINDOW) hop = h.hop + 1;
      if (hop >= HOPS) throw new Error(`hop limit: this exchange has gone back and forth ${HOPS} times between agents without the user stepping in; stop here and leave a summary for the user`);
    }
    const nm = this.names();
    const m = {
      id: ++this.seq, at: now, hop,
      from: from ? nm.get(from.key) : (fromName || 'someone outside openone'), fromKey: from ? from.key : null,
      to: nm.get(target.key), toKey: target.key,
      content: text, status: 'queued', via: null, deliveredAt: 0, error: '',
    };
    this.log.push(m);
    if (this.log.length > LOG) this.log.splice(0, this.log.length - LOG);
    this.pump();
    return m;
  }

  // the user used this agent (opened, answered, replied): its reply chain starts over
  touch(key) { this.hopIn.delete(key); }

  // Delivers what can be delivered now. Called after every send and every poll.
  async pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const m of this.log) {
        if (m.status !== 'queued') continue;
        const now = this.now();
        const p = this.monitor.view().find((x) => x.key === m.toKey);
        if (!p) { m.status = 'failed'; m.error = 'the agent is gone'; continue; }
        if (now - m.at > EXPIRE) { m.status = 'failed'; m.error = 'it never went idle'; continue; }
        if (p.state === 'shell') { m.status = 'failed'; m.error = 'the agent exited'; continue; }
        const push = this.channels.get(m.toKey);
        try {
          if (push) {
            push(m);
            m.via = 'channel';
          } else {
            if (p.state !== 'idle') continue; // working or asking you something: wait
            await this.deliver(p, typedLine(m));
            m.via = 'typed';
          }
          m.status = 'delivered';
          m.deliveredAt = this.now();
          this.hopIn.set(m.toKey, { hop: m.hop, at: m.deliveredAt });
        } catch (e) {
          m.error = String(e.message || e).split('\n')[0];
          if (push) continue; // try typing next time
          m.status = 'failed';
        }
      }
    } finally {
      this.busy = false;
    }
  }

  // a session listening on the channel; returns the unsubscribe function
  listen(key, push) {
    this.channels.set(key, push);
    setImmediate(() => this.pump());
    return () => { if (this.channels.get(key) === push) this.channels.delete(key); };
  }

  recent(n = 40) {
    return this.log.slice(-n).map(({ id, at, from, to, fromKey, toKey, content, status, via, error, hop }) => ({
      id, at, from, to, fromKey, toKey, content: content.slice(0, 400), status, via, error, hop,
    }));
  }
}

module.exports = { Bus, names, typedLine, slug, HOPS };
