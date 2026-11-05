// Voice clips other programs record for you (player-one: hold View+Start on the controller):
// they POST the audio here, and openone transcribes it and types it into an agent like
// push-to-talk does. The sender only records and posts; it never says who a clip is for.
//
//   POST http://127.0.0.1:8955/voice      body: the audio (audio/mpeg, audio/webm, audio/wav...)
//   X-Player-One-App / X-Player-One-Window  what you were in (goes in the tag)
//   X-Player-One-Mode: hold (you held the buttons: always delivered) or always (an always-listening
//   mic heard you: only sent on when it's clearly for an agent)
//   -> 202 at once; the transcribing and sending happen after

const http = require('http');

const MAX = 25 * 1024 * 1024;

// the tag in front of the text: "[voice] [player-one · eden] "; [voice] first so the agent
// answers out loud too (speak in mcp.js)
function tag(headers) {
  const from = String(headers['x-player-one-event'] ? 'player-one' : headers['x-voice-from'] || 'voice clip').slice(0, 40);
  const app = String(headers['x-player-one-app'] || '').replace(/\.exe$/i, '').slice(0, 40);
  return `[voice] [${[from, app].filter(Boolean).join(' · ')}] `;
}

// -> server; onClip({ audio, mime, tag, ms, window }) is called for each clip
function listen({ port = 8955, host = '127.0.0.1', onClip, log = () => {} }) {
  const server = http.createServer((req, res) => {
    const end = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/') return end(200, { ok: true, post: '/voice' });
    if (req.method !== 'POST' || url.pathname !== '/voice') return end(404, { error: 'POST /voice' });
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim();
    if (!mime.startsWith('audio/')) return end(415, { error: 'send the audio as the body, with an audio/* content-type' });
    const chunks = [];
    let size = 0;
    req.on('data', (d) => {
      size += d.length;
      if (size > MAX) { end(413, { error: 'clip too big' }); req.destroy(); return; }
      chunks.push(d);
    });
    req.on('end', () => {
      if (size > MAX) return;
      const audio = Buffer.concat(chunks);
      if (audio.length < 1000) return end(400, { error: 'clip too short' });
      end(202, { ok: true, bytes: audio.length });
      let window = '';
      try { window = decodeURIComponent(String(req.headers['x-player-one-window'] || '')); } catch {}
      Promise.resolve()
        .then(() => onClip({
          audio, mime, tag: tag(req.headers), window,
          mode: /always/i.test(String(req.headers['x-player-one-mode'] || '')) ? 'always' : 'hold',
          ms: Number(req.headers['x-player-one-duration-ms']) || 0,
        }))
        .catch((e) => log(`voice clip: ${e.message}`));
    });
  });
  server.on('error', (e) => log(`voice clips: can't listen on ${host}:${port}: ${e.message}`));
  server.listen(port, host);
  return server;
}

// "take me to my fastudio project" -> "fastudio": a jump, not a message; '' when it isn't one.
// Speech recognition mangles the verb ("go too fast studio", "take me 2 ..."), so "to" can be
// heard as too/two/2. bare: a clip that's only a name ("fast studio.") counts too, for a clip
// you held the buttons for (findPane then has to match it closely).
const NAV = /^(?:(?:hey|ok(?:ay)?|yo)[\s,]+)?(?:(?:claude|zero[\s-]?one|open[\s-]?(?:one|1))[\s,.:!-]+)?(?:(?:can|could|would) you\s+|please\s+)?(?:(?:take|bring|get)\s+me(?:\s+back)?\s+(?:to|too|two|2)|(?:go|jump|switch|hop|flip)(?:\s+back)?\s+(?:to|too|two|2|over\s+to)|bring\s+up|pull\s+up|open(?:\s+up)?|show\s+me|focus(?:\s+on)?)\s+(.+?)[\s.!?]*$/i;
const FILLER = /\b(?:my|the|a|an|that|this|project|agent|pane|chat|session|tab|window|terminal|tmux|t-mux|up|please|now|for me)\b/gi;
const tidy = (s) => s.replace(FILLER, ' ').replace(/[^\w\s-]/g, ' ').replace(/\s+/g, ' ').trim();
function navTarget(text, { bare = false } = {}) {
  const t = String(text || '').trim();
  const m = t.match(NAV);
  const q = m ? tidy(m[1]) : bare ? tidy(t) : '';
  return q && q.split(' ').length <= (m ? 5 : 3) ? q : '';
}

// the pane a spoken name means: its label or folder, ignoring spaces ("fast studio"), or its
// machine ("the mac" -> macbook); agents before shells, then the one used last. null when
// nothing fits at least min (3 exact, 2.5 a letter or two off, 2 the name inside what was said).
function findPane(q, panes, min = 0.5) {
  const flat = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const want = flat(q);
  if (!want) return null;
  const fit = (n) => {
    const name = flat(n);
    if (name.length < 2) return 0;
    if (name === want) return 3;
    // speech recognition spells names its own way: a letter or two off still counts
    if (name.length >= 5 && distance(name, want) <= (name.length >= 8 ? 2 : 1)) return 2.5;
    if (name.length >= 3 && want.includes(name)) return 2;
    if (want.length >= 4 && name.startsWith(want)) return 1;
    return 0;
  };
  const words = String(q).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  const host = (h) => { const name = flat(h); return name && words.some((w) => name.startsWith(w)) ? 0.75 : 0; };
  let best = null;
  let bestScore = 0;
  for (const p of panes) {
    const score = Math.max(fit(p.label), fit(String(p.path || '').split(/[\\/]/).filter(Boolean).pop()), fit(p.host) && 0.9, host(p.host));
    if (score < min) continue;
    const better = score > bestScore || (score === bestScore && ((!!p.kind > !!best.kind) || (!!p.kind === !!best.kind && (p.used || 0) > (best.used || 0))));
    if (better) { best = p; bestScore = score; }
  }
  return best;
}

// edits to turn a into b
function distance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

module.exports = { listen, tag, navTarget, findPane };
