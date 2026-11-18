// When each agent pane last did something, from the agents' own records, so the agent
// list can sort by it even for turns openone never saw (it wasn't running, or restarted).
//
// Claude Code keeps ~/.claude/sessions/<pid>.json per session: its pane ("tmux":
// "0:@12.%22"), when it started, and when its status (busy/idle) last changed. A pane can
// have files from sessions that ended; the one that started last is the one in it now.

// the files' contents, concatenated (`type *.json` adds no separators) -> Map
// "session|%pane" -> ms
function parseClaudeSessions(text) {
  const best = new Map(); // key -> { started, at }
  for (const chunk of objects(String(text || ''))) {
    let j;
    try { j = JSON.parse(chunk); } catch { continue; }
    const m = String(j.tmux || '').match(/^(.+):@\d+\.(%\d+)$/);
    if (!m) continue;
    const key = `${m[1]}|${m[2]}`;
    const started = Number(j.startedAt) || 0;
    // busy: it's at work now, and updatedAt is its heartbeat
    const at = j.status === 'busy' ? Math.max(Number(j.updatedAt) || 0, Number(j.statusUpdatedAt) || 0) : Number(j.statusUpdatedAt) || Number(j.updatedAt) || 0;
    const had = best.get(key);
    if (!had || started > had.started) best.set(key, { started, at });
  }
  return new Map([...best].map(([k, v]) => [k, v.at]));
}

// top-level {...} objects in a string, skipping braces inside JSON strings
function* objects(s) {
  let depth = 0, start = -1, str = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (str) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') str = false; continue; }
    if (c === '"') str = true;
    else if (c === '{') { if (!depth++) start = i; }
    else if (c === '}' && depth && !--depth) yield s.slice(start, i + 1);
  }
}

module.exports = { parseClaudeSessions };
