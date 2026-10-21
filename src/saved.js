// Saved posts: your X bookmarks and likes, searchable by meaning. The posts come out of x.com
// in your own browser (the /saved-receive page relays them here) with everything needed to
// draw them again: text, media, link card, quoted post, counts, and the author's follow-up
// replies, where the link often is. The /saved page lists and searches them.
//
// Kept in one file: { order: [bookmark ids], likes: [liked ids], tweets: { id: post } }, each
// list newest first. A post can be in both lists.

const fs = require('fs');
const path = require('path');
const { cosine } = require('./embed');

const iso = (d) => { const t = new Date(d); return isNaN(t) ? '' : t.toISOString(); };

// a stored post -> what the page draws
function view(t, kinds) {
  return {
    id: t.id, author_handle: t.handle || '', author_name: t.name || '', author_avatar: t.avatar || '',
    text: t.text || '', created_at: iso(t.created_at), url: `https://x.com/${t.handle}/status/${t.id}`,
    links: [...(t.urls || []), ...(t.replies || []).flatMap((r) => r.urls || [])].map((u) => u.url).filter(Boolean),
    media: t.media || [], quoted: t.quoted || null, card: t.card || null, counts: t.counts || null, urls: t.urls || [],
    replies: t.replies || [], kinds,
  };
}

// what gets embedded: the post, its links and card, what it quotes, and the author's replies
function docText(b) {
  return [
    `${b.author_name} @${b.author_handle}: ${b.text}`,
    b.links.join(' '),
    b.card && [b.card.title, b.card.description, b.card.domain].filter(Boolean).join(' - '),
    b.quoted && `quoting @${b.quoted.handle}: ${b.quoted.text}`,
    ...b.replies.map((r) => r.text),
  ].filter(Boolean).join('\n').slice(0, 1200);
}

class Saved {
  constructor({ dir, embedder = null }) {
    this.file = path.join(dir, 'archive.json');
    this.embedder = embedder;
    let a = {};
    try { a = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch {}
    this.order = a.order || [];
    this.likes = a.likes || [];
    this.tweets = a.tweets || {};
    this.index();
  }

  index() { this.bookmarked = new Set(this.order); this.liked = new Set(this.likes); }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify({ order: this.order, likes: this.likes, tweets: this.tweets }));
    fs.renameSync(this.file + '.tmp', this.file);
  }

  kindsOf(id) { return [this.bookmarked.has(id) && 'bookmark', this.liked.has(id) && 'like'].filter(Boolean); }

  // kind: 'all' | 'bookmark' | 'like'. 'all' is bookmarks, then likes not already bookmarked.
  list(kind = 'all') {
    const ids = kind === 'like' ? this.likes : kind === 'bookmark' ? this.order
      : [...this.order, ...this.likes.filter((id) => !this.bookmarked.has(id))];
    return ids.filter((id) => this.tweets[id]).map((id) => view(this.tweets[id], this.kindsOf(id)));
  }

  recent({ kind = 'all', order = 'newest', offset = 0, n = 40 } = {}) {
    const all = this.list(kind);
    if (order === 'oldest') all.reverse();
    return { results: all.slice(offset, offset + n), total: all.length };
  }

  // by meaning, plus a nudge for each word that's literally there
  async search(q, { kind = 'all', n = 24 } = {}) {
    if (!this.embedder) throw new Error('search needs the embedding model ("semantic" is off)');
    const all = this.list(kind);
    const texts = all.map(docText);
    const [qv] = await this.embedder.vectors([q]);
    const vs = await this.embedder.vectors(texts);
    const words = q.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
    return all.map((b, i) => {
      const t = texts[i].toLowerCase();
      const score = cosine(qv, vs[i]) + 0.05 * words.filter((w) => t.includes(w)).length;
      return { ...b, score: Math.round(score * 1000) / 1000 };
    }).sort((a, b) => b.score - a.score).slice(0, n);
  }

  // embed everything ahead of the first search
  warm() { if (this.embedder) this.embedder.warm(this.list().map((b) => ({ text: docText(b) }))); }

  // posts from the browser. kind: which list; front: they're newer than everything saved (a
  // catch-up from the top). A post already saved is updated in place (its thread, say).
  ingest({ tweets = [], kind = 'bookmark', front = false }) {
    const list = kind === 'like' ? this.likes : this.order;
    const have = kind === 'like' ? this.liked : this.bookmarked;
    const fresh = [];
    for (const t of tweets) {
      if (!t || !t.id) continue;
      if (!have.has(t.id)) { fresh.push(t.id); have.add(t.id); }
      this.tweets[t.id] = { ...this.tweets[t.id], ...t };
    }
    if (front) list.unshift(...fresh); else list.push(...fresh);
    this.save();
    return { added: fresh.length, kind, total: list.length };
  }

  // posts with no link of their own whose thread hasn't been read yet
  todo() {
    return Object.values(this.tweets).filter((t) => !t.thread_checked && !(t.urls || []).length && !t.card
      && !(t.quoted && ((t.quoted.urls || []).length || t.quoted.card)))
      .map((t) => ({ id: t.id, handle: t.handle, conversation: t.conversation }));
  }
}

module.exports = { Saved, docText, view };
