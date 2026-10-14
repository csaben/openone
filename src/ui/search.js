// Fuzzy search over panes for the panel's "/" filter. Every word of the query must match
// somewhere. Names (label, session, kind, host) count most: a prefix beats a substring,
// which beats letters in order ("erx" finds er-apex). Title, question and summary only
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

  return { score, filter };
});
