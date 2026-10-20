// Agents talking back: an agent calls speak (MCP) with a few sentences, the server turns
// them into audio with a text-to-speech service ("tts" in the server config) one sentence
// at a time, and a desktop app picks each part up and plays it as soon as it's ready, so
// the first sentence plays while the rest are still being made.
//
// tts: { url, format: 'mp3'|'wav', field: 'text', say: { word: 'how to say it' } } -> POST url with
// JSON { text, format }, audio back. `say` fixes how names come out ("openone": "oh one").

const crypto = require('crypto');

const TTL = 10 * 60000;

// "First one. Second? Third!" -> parts of up to ~maxLen characters, cut at sentence ends
function sentences(text, maxLen = 220) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const raw = clean.match(/[^.!?]+(?:[.!?]+["')\]]*|$)/g) || [clean];
  const out = [];
  for (let s of raw.map((x) => x.trim()).filter(Boolean)) {
    // a long sentence: cut at a comma or a space
    while (s.length > maxLen) {
      let cut = s.lastIndexOf(', ', maxLen);
      if (cut < maxLen / 2) cut = s.lastIndexOf(' ', maxLen);
      if (cut <= 0) cut = maxLen;
      out.push(s.slice(0, cut + 1).trim());
      s = s.slice(cut + 1).trim();
    }
    // short sentences ride together, so the voice keeps its flow
    const last = out[out.length - 1];
    if (last && out.length > 1 && last.length + s.length < 90) out[out.length - 1] = `${last} ${s}`;
    else if (s) out.push(s);
  }
  return out;
}

class Speech {
  constructor({ synth, now = Date.now } = {}) {
    this.synth = synth; // async (text) -> { audio: Buffer, mime }
    this.now = now;
    this.items = []; // { id, group, seq, of, from, text, audio, mime, at, claimed, status }
    this.waiters = new Set();
  }

  // -> { group, parts }: made in the background, in order
  say({ text, from = '' }) {
    if (!this.synth) throw Object.assign(new Error('no text-to-speech service: set "tts" in the server config'), { code: 400 });
    const parts = sentences(String(text || '').slice(0, 4000));
    if (!parts.length) throw Object.assign(new Error('nothing to say'), { code: 400 });
    const group = crypto.randomBytes(5).toString('hex');
    const items = parts.map((t, seq) => ({ id: `${group}-${seq}`, group, seq, of: parts.length, from: String(from || ''), text: t, at: this.now(), status: 'making' }));
    this.items.push(...items);
    (async () => {
      for (const it of items) {
        try {
          const r = await this.synth(it.text);
          it.audio = r.audio;
          it.mime = r.mime;
          it.status = 'ready';
        } catch (e) {
          it.status = 'failed';
          it.error = String(e.message || e);
        }
        this.wake();
      }
    })();
    return { group, parts: parts.length };
  }

  prune() {
    const t = this.now();
    this.items = this.items.filter((x) => t - x.at < TTL);
  }

  // ready parts nobody has taken, in order; a part waits for the ones before it in its group
  take(by) {
    this.prune();
    const out = [];
    for (const it of this.items) {
      if (it.claimed || it.status === 'making') continue;
      const before = this.items.filter((x) => x.group === it.group && x.seq < it.seq);
      if (before.some((x) => x.status === 'making' || (!x.claimed && x.status === 'ready'))) continue;
      if (it.status === 'failed') { it.claimed = by; continue; }
      it.claimed = by;
      out.push(it);
    }
    return out.map(({ id, group, seq, of, from, text, mime }) => ({ id, group, seq, of, from, text, mime }));
  }

  audio(id) { return this.items.find((x) => x.id === id && x.audio) || null; }

  done(id) { this.items = this.items.filter((x) => x.id !== id); }

  wait(ms) {
    return new Promise((resolve) => {
      const w = () => { clearTimeout(t); this.waiters.delete(w); resolve(); };
      const t = setTimeout(w, ms);
      this.waiters.add(w);
    });
  }

  wake() { for (const w of [...this.waiters]) w(); }
}

// tts config -> synth function
function httpSynth(tts) {
  if (!tts || !tts.url) return null;
  const format = tts.format || 'mp3';
  // longest first, so "openone@inari" wins over "openone"
  const say = Object.entries(tts.say || {}).sort((a, b) => b[0].length - a[0].length)
    .map(([w, as]) => [new RegExp(`(?<![\\w@])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w@])`, 'gi'), as]);
  return async (raw) => {
    const text = say.reduce((t, [re, as]) => t.replace(re, as), raw);
    const r = await fetch(tts.url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ [tts.field || 'text']: text, format, ...(tts.extra || {}) }),
      signal: AbortSignal.timeout(tts.timeoutMs || 60000),
    });
    if (!r.ok) throw new Error(`text-to-speech: HTTP ${r.status}`);
    return { audio: Buffer.from(await r.arrayBuffer()), mime: r.headers.get('content-type') || (format === 'wav' ? 'audio/wav' : 'audio/mpeg') };
  };
}

module.exports = { Speech, sentences, httpSynth };
