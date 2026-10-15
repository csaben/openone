// Fuzzy search over panes for the panel's "/" filter. Every word of the query must match
// somewhere. Names (label, session, kind, host) count most: a prefix beats a substring,
// which beats letters in order ("ptd" finds photo-tidy). Title, question and summary only
// count as plain substrings, so a word from the conversation still finds its agent.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OOSearch = factory();
})(this, () => {
  const NAMES = [['label', 3], ['session', 2], ['kind', 1.5], ['host', 1.5]];
  const TEXT = [['title', 1], ['topic', 1], ['question', 1], ['summary', 0.6]];

  // letters of `q` in order in `s`; tighter runs score higher, 0 if they aren't all there
  function subseq(q, s) {
    let at = -1;
    let gaps = 0;
    for (const ch of q) {
      const i = s.indexOf(ch, at + 1);
      if (i < 0) return 0;
      if (at >= 0) gaps += i - at - 1;
      at = i;
    }
    return 1 / (1 + gaps * 0.3);
  }

  function word(w, p) {
    let best = 0;
    for (const [f, weight] of NAMES) {
      const s = String(p[f] || '').toLowerCase();
      if (!s) continue;
      let sc = 0;
      if (s === w) sc = 12;
      else if (s.startsWith(w) || s.split(/[\s._/-]+/).some((part) => part.startsWith(w))) sc = 9;
      else if (s.includes(w)) sc = 6;
      else if (w.length >= 2) sc = 4 * subseq(w, s);
      best = Math.max(best, sc * weight);
    }
    for (const [f, weight] of TEXT) {
      const s = String(p[f] || '').toLowerCase();
      if (s && s.includes(w)) best = Math.max(best, (new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(s) ? 5 : 3) * weight);
    }
    return best;
  }

  function score(query, p) {
    const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
    let total = 0;
    for (const w of words) {
      const s = word(w, p);
      if (!s) return 0;
      total += s;
    }
    return total;
  }

  // panes that match, best first; ties keep the given order
  function filter(query, panes) {
    if (!String(query).trim()) return panes.slice();
    return panes.map((p, i) => ({ p, i, s: score(query, p) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.i - b.i)
      .map((x) => x.p);
  }

  // ---------- related work: "does something already do this?" ----------

  const STOP = new Set(('a an the and or for of to in on at by with from into my me i we our you your it its this that these ' +
    'is are be was want wanna need like make build start continue keep work working thing stuff some new project app tool ' +
    'do does doing get set up using use via so just also please let lets').split(' '));

  // "Google Drive maintenance" -> ['google', 'drive', 'mainten'] (crude stem, so maintain ~ maintenance)
  function words(text) {
    return String(text || '').toLowerCase().replace(/([a-z])([A-Z])/g, '$1 $2').split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 2 && !STOP.has(w))
      .map((w) => (w.length > 5 ? w.replace(/(ances?|ences?|ings?|ations?|ers?|ed|es|s)$/, '') : w));
  }

  // docs: [{ name, text }]. Returns [{ doc, score, hits: [{ word, where }] }] for docs that
  // look like the same work, best first. A name match counts most; words that appear in
  // the description count once each.
  function related(query, docs, { min = 2.5 } = {}) {
    const q = [...new Set(words(query))];
    if (!q.length) return [];
    const out = [];
    for (const doc of docs) {
      const nameWords = words(String(doc.name || '').replace(/[-_.]/g, ' '));
      const compact = String(doc.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const text = new Set(words(doc.text));
      let score = 0;
      const hits = [];
      for (const w of q) {
        if (nameWords.some((n) => n === w || (w.length >= 3 && (n.startsWith(w) || w.startsWith(n) && n.length >= 3)))) { score += 3; hits.push({ word: w, where: 'name' }); }
        else if (w.length >= 4 && compact.includes(w)) { score += 2.5; hits.push({ word: w, where: 'name' }); }
        else if (text.has(w)) { score += 1; hits.push({ word: w, where: 'about' }); }
      }
      // most of what you said should be there, not one common word
      const coverage = hits.length / q.length;
      if (score >= min && (coverage >= 0.5 || score >= 6)) out.push({ doc, score: score * (0.5 + coverage), hits });
    }
    return out.sort((a, b) => b.score - a.score);
  }

  return { score, filter, words, related };
});
