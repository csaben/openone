// Where a spoken note goes. A note from a voice-notes service (a ring, a phone) is either
// something to keep (the notes service files it) or talk meant for an agent ("check why the
// build failed", "yeah go ahead"), which openone types into that agent's chat right away.
//
// A few spoken cues decide it outright ("note to self ...", "Claude, ..."). Otherwise a
// scoring model (jev) says how likely the note was meant for an agent, given the recent
// conversation; the bar is low, because an agent reading a stray note costs little and a
// missed message costs a repeat. When the score is unsure the agent is told so and decides:
// not_for_me hands it back to the notes service (the caller's refile URL) to file. Without
// jev, or when it fails: a note soon after one sent to an agent follows it there, then a
// small chat model decides, and when that's down too it's a note.
//
// router: { to, jev: { url, key, model, threshold, sureAt }, url: ".../v1/chat/completions",
//           model, apiKey, timeoutMs, stickyMin, confirm }
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
  The user talks to agents in a run of notes: if a recent note went to an agent and this one
  follows on from it (same subject, a follow-up question, a reaction to what the agent said or
  is working on), it is "agent", to that same agent, even when it sounds like thinking aloud.
- "note": anything else. Thoughts, ideas, observations, journal entries, things to remember, plans
  and to-dos for themself ("I need to ...", "remember to ..."), feature ideas without a request to
  act now, talk about other people. Most notes are this. When unsure, choose "note".

Reply with JSON only: {"route": "agent" or "note", "to": "<agent name from the roster, or empty>", "why": "<a few words>"}`;

// agents: roster entries { name, kind, title, summary, state }; recent: notes sent to agents
// lately, { to, text, mins }
function messages(text, agents, defaultTo, recent = []) {
  const line = (a) => `- ${a.name} (${a.kind}${a.name === defaultTo ? ', the default' : ''})${a.title ? `: ${a.title}` : ''}` +
    `${a.summary ? ` | last said: ${String(a.summary).replace(/\s+/g, ' ').slice(0, 300)}` : ''}`;
  const roster = agents.map(line).join('\n') || '(no agents running)';
  const lately = recent.length
    ? `\n\nRecent notes the user sent to agents:\n${recent.map((r) => `- ${r.mins} min ago, to ${r.to}: ${String(r.text).replace(/\s+/g, ' ').slice(0, 300)}`).join('\n')}`
    : '';
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `Default agent: ${defaultTo || '(none)'}\nRoster:\n${roster}${lately}\n\nNote:\n${String(text).slice(0, 4000)}` },
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
    this.sent = []; // { to, text, at }: notes that went to agents, for follow-ups
  }

  recent(now = Date.now()) {
    this.sent = this.sent.filter((r) => now - r.at < 20 * 60000).slice(-3);
    return this.sent.map((r) => ({ to: r.to, text: r.text, mins: Math.max(1, Math.round((now - r.at) / 60000)) }));
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

  // -> { route, to, why, p } from jev's yes/no score (and which agent, when there are several)
  async score(text, agents, defaultTo) {
    const j = this.cfg.jev;
    const def = agents.find((a) => a.name === defaultTo);
    const questions = {
      for_agent: {
        type: 'noul',
        instructions: 'The user recorded this voice note on a ring. Was it meant for one of their AI agents (an instruction, a request, a question for it, a reply to what it said, or a follow-up to the recent conversation with it), rather than a private note, thought or reminder for their notes doc?',
        criteria: { true: 'Talk meant for an agent to read and act on or answer.', false: 'A note to self: a thought, journal entry, idea or reminder, not addressed to an agent.' },
      },
    };
    if (agents.length > 1) {
      questions.which = {
        type: 'choice',
        instructions: 'If the note is meant for an agent, which one? Without a clear sign, the default agent.',
        criteria: Object.fromEntries(agents.map((a) => [a.name, `${a.title || a.kind}${a.name === defaultTo ? ' (the default agent)' : ''}`])),
      };
    }
    const state = {
      note: String(text).slice(0, 4000),
      default_agent: defaultTo || null,
      default_agent_last_said: def && def.summary ? String(def.summary).slice(0, 600) : null,
      recent_notes_sent_to_agents: this.recent(),
    };
    const r = await fetch(`${String(j.url).replace(/\/+$/, '')}/v1/systemone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${j.key}` },
      body: JSON.stringify({ model: j.model || 'jev-latest', state, questions }),
      signal: AbortSignal.timeout(j.timeoutMs || 5000),
    });
    if (!r.ok) throw new Error(`jev HTTP ${r.status}`);
    const a = (await r.json()).answers || {};
    const p = a.for_agent && typeof a.for_agent.noul === 'number' ? a.for_agent.noul : null;
    if (p === null) throw new Error('jev gave no score');
    const pick = a.which && a.which.confidence >= 0.6 && agents.some((x) => x.name === a.which.choice) ? a.which.choice : defaultTo;
    const pct = `${Math.round(p * 100)}%`;
    if (p >= (j.threshold ?? 0.35) && pick) return { route: 'agent', to: pick, why: `jev ${pct}`, p };
    return { route: 'note', to: '', why: `jev ${pct}`, p };
  }

  async classify(text, agents, defaultTo) {
    const names = agents.map((a) => a.name);
    const c = cue(text);
    if (c) return c.route === 'agent' ? { route: defaultTo ? 'agent' : 'note', to: defaultTo, why: c.why, text: c.text } : { route: 'note', to: '', why: c.why };
    let jevError = '';
    if (this.cfg.jev && this.cfg.jev.url && this.cfg.jev.key) {
      try { return await this.score(text, agents, defaultTo); } catch (e) { jevError = String(e.message || e); }
    }
    const out = await this.fallback(text, agents, defaultTo, names);
    if (jevError) out.why = `${out.why} (${jevError})`;
    return out;
  }

  async fallback(text, agents, defaultTo, names) {
    // mid-conversation: a note soon after one that went to an agent goes there too ("note" opts out)
    const last = this.sent[this.sent.length - 1];
    const sticky = (this.cfg.stickyMin ?? 10) * 60000;
    if (last && Date.now() - last.at < sticky && names.includes(last.to)) return { route: 'agent', to: last.to, why: 'follows a note sent to it' };
    if (!this.cfg.url) return { route: 'note', to: '', why: 'no router model configured' };
    try {
      const r = await fetch(this.cfg.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}) },
        body: JSON.stringify({
          model: this.cfg.model, temperature: 0, max_tokens: 120,
          response_format: { type: 'json_object' }, messages: messages(text, agents, defaultTo, this.recent()),
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

  // { text, source, refile } -> { route, to, why, p?, ms, sent? }
  // refile: a URL the caller wants POSTed if the agent says the note wasn't for it
  async route({ text, source = 'ring', refile = '' }) {
    const t0 = Date.now();
    const clean = String(text || '').trim();
    if (!clean) return { route: 'note', to: '', why: 'empty', ms: 0 };
    const agents = this.roster();
    const defaultTo = this.defaultTo(agents);
    const out = await this.classify(clean, agents, defaultTo);
    if (out.route === 'agent') {
      // unsure: say so, and give the agent a way to hand it back
      let tag = `[${source}]`;
      if (typeof out.p === 'number' && out.p < (this.cfg.jev && this.cfg.jev.sureAt || 0.75)) {
        const ref = this.keep(refile);
        tag = `[${source}? ${Math.round(out.p * 100)}% sure this is for you${ref ? `; if it isn't, call not_for_me with ref "${ref}"` : ''}]`;
      }
      try {
        out.sent = this.sendTo(out.to, `${tag} ${out.text || clean}`);
        this.sent.push({ to: out.to, text: out.text || clean, at: Date.now() });
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

  // refile URLs for unsure messages, by a short ref, for a day
  keep(url) {
    if (!/^https?:\/\//.test(String(url || ''))) return '';
    this.refiles = (this.refiles || new Map());
    for (const [k, v] of this.refiles) if (Date.now() - v.at > 86400000) this.refiles.delete(k);
    const ref = `r${Math.random().toString(36).slice(2, 7)}`;
    this.refiles.set(ref, { url, at: Date.now() });
    return ref;
  }

  // the agent says an unsure message wasn't for it: the notes service files it after all
  async notForMe(ref) {
    const r = this.refiles && this.refiles.get(String(ref || '').trim());
    if (!r) throw Object.assign(new Error(`no message with ref "${ref}" (refs last a day)`), { code: 404 });
    const res = await fetch(r.url, { method: 'POST', signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`the notes service answered HTTP ${res.status}`);
    this.refiles.delete(String(ref).trim());
    this.sent = this.sent.slice(0, -1); // and it doesn't count as the conversation going on
    if (this.confirm) try { this.confirm('Filed as a note.'); } catch {}
    return { ok: true };
  }
}

module.exports = { Router, cue, messages, parse };
