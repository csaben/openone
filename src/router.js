// Where a spoken note goes. A note from a voice-notes service (a ring, a phone) is either
// something to keep (the notes service files it) or talk meant for an agent ("check why the
// build failed", "yeah go ahead"), which openone types into that agent's chat right away.
//
// A few spoken cues decide it outright ("note to self ...", "Claude, ..."); anything else
// goes to a small, fast chat model ("router" in the server config) with the roster. When in
// doubt, or when the model is down, it's a note: a note is never lost, a message can be.
//
// router: { url: ".../v1/chat/completions", model, to, timeoutMs, apiKey }
//   to: the default agent: a name, a pane key, or a list of them (the first one running wins)

const NOTE_CUES = /^\s*(?:(?:a\s+)?note\s+to\s+self|note|memo|journal)\b[\s,:.-]*/i;
const AGENT_CUES = /^\s*(?:hey\s+|ok(?:ay)?\s+|yo\s+)?(?:claude|codex|agent)\b[\s,:.-]*/i;
// "zero one" (openone's name, as speech recognition writes it) within the first few words
const NAME_CUE = /^\s*(?:[\w']+[\s,.]+){0,4}?(?:zero[\s-]?one|open[\s-]?(?:one|1)|0[\s-]?1|oh[\s-]one)\b[\s,:.!?-]*/i;

// -> { route, why, text } when a cue decides it, else null
function cue(text) {
  const t = String(text || '');
  let m = t.match(NOTE_CUES);
  if (m) return { route: 'note', why: 'starts with a note cue', text: t };
  m = t.match(AGENT_CUES) || t.match(NAME_CUE);
  if (m) return { route: 'agent', why: 'addressed to an agent', text: t.slice(m[0].length) || t };
  return null;
}

const SYSTEM = `You sort the user's spoken notes. Each one was recorded on a ring and transcribed by speech
recognition (expect filler words and mis-heard words). Decide where it goes:

- "agent": the user is talking TO one of their AI agents: an instruction or request ("check
  why the build failed", "can you add a button"), a question for it, or a reply to what it last
  said ("yeah do that", "no, the other one"). A note that muses first and then asks for something
  to be done or answered ("figure that out", "look into it", "tell me", "report back", "let me
  know", "can you ...", "find out why ...") is "agent", even when the ask comes at the very end.
  Pick which agent from the roster; when it's not clear which, use the default agent.
- "note": anything else. Thoughts, ideas, observations, journal entries, things to remember, plans
  and to-dos for themself ("I need to ...", "remember to ..."), feature ideas without a request to
  act now, talk about other people. Most notes are this. When unsure, choose "note".

Reply with JSON only: {"route": "agent" or "note", "to": "<agent name from the roster, or empty>", "why": "<a few words>"}`;

// agents: roster entries { name, kind, title, summary, state }
function messages(text, agents, defaultTo) {
  const line = (a) => `- ${a.name} (${a.kind}${a.name === defaultTo ? ', the default' : ''})${a.title ? `: ${a.title}` : ''}` +
    `${a.summary ? ` | last said: ${String(a.summary).replace(/\s+/g, ' ').slice(0, 160)}` : ''}`;
  const roster = agents.map(line).join('\n') || '(no agents running)';
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `Default agent: ${defaultTo || '(none)'}\nRoster:\n${roster}\n\nNote:\n${String(text).slice(0, 4000)}` },
  ];
}

// the model's reply -> { route, to, why }
function parse(content, agentNames, defaultTo) {
  let j = {};
  try { j = JSON.parse(String(content || '').replace(/^\s*```(?:json)?|```\s*$/g, '').trim()); } catch {}
  if (j.route !== 'agent') return { route: 'note', to: '', why: String(j.why || (j.route ? '' : 'unreadable answer')) };
  const want = String(j.to || '').trim().toLowerCase();
  const to = agentNames.find((n) => n.toLowerCase() === want) || defaultTo || '';
  if (!to) return { route: 'note', to: '', why: 'no agent to send it to' };
  return { route: 'agent', to, why: String(j.why || '') };
}

class Router {
  // cfg: the "router" config; roster(): agents; send(to, text): delivers;
  // resolve(nameOrKey): the running agent's name, or ''; confirm(text): says where it went
  // out loud ("Sent to shop." / "Noted."), unless cfg.confirm is false
  constructor({ cfg = {}, roster, send, resolve, confirm }) {
    this.cfg = cfg;
    this.roster = roster;
    this.sendTo = send;
    this.resolve = resolve || ((t) => t);
    this.confirm = cfg.confirm === false ? null : confirm;
  }

  tell(out) {
    if (!this.confirm) return;
    try { this.confirm(out.route === 'agent' ? `Sent to ${out.to.split('@')[0].split('.')[0]}.` : 'Noted.'); } catch {}
  }

  defaultTo(agents) {
    for (const t of [].concat(this.cfg.to || [])) {
      let n = '';
      try { n = this.resolve(t) || ''; } catch {}
      if (n && agents.some((a) => a.name === n)) return n;
    }
    return '';
  }

  async classify(text, agents, defaultTo) {
    const names = agents.map((a) => a.name);
    const c = cue(text);
    if (c) return c.route === 'agent' ? { route: defaultTo ? 'agent' : 'note', to: defaultTo, why: c.why, text: c.text } : { route: 'note', to: '', why: c.why };
    if (!this.cfg.url) return { route: 'note', to: '', why: 'no router model configured' };
    try {
      const r = await fetch(this.cfg.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}) },
        body: JSON.stringify({
          model: this.cfg.model, temperature: 0, max_tokens: 120,
          response_format: { type: 'json_object' }, messages: messages(text, agents, defaultTo),
        }),
        signal: AbortSignal.timeout(this.cfg.timeoutMs || 4000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      return parse(j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content, names, defaultTo);
    } catch (e) {
      return { route: 'note', to: '', why: `router model failed: ${String(e.message || e)}` };
    }
  }

  // { text, source } -> { route, to, why, ms, sent? }
  async route({ text, source = 'ring' }) {
    const t0 = Date.now();
    const clean = String(text || '').trim();
    if (!clean) return { route: 'note', to: '', why: 'empty', ms: 0 };
    const agents = this.roster();
    const defaultTo = this.defaultTo(agents);
    const out = await this.classify(clean, agents, defaultTo);
    if (out.route === 'agent') {
      try {
        out.sent = this.sendTo(out.to, `[${source}] ${out.text || clean}`);
      } catch (e) {
        const failed = { route: 'note', to: '', why: `couldn't send: ${String(e.message || e)}`, ms: Date.now() - t0 };
        this.tell(failed);
        return failed;
      }
    }
    delete out.text;
    this.tell(out);
    return { ...out, ms: Date.now() - t0 };
  }
}

module.exports = { Router, cue, messages, parse };
