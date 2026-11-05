// Pulls your latest X bookmarks and likes into saved posts (src/saved.js), from the "Sync"
// button on /saved. A hidden window opens x.com/i/bookmarks (or your likes page) signed in as
// you, reads the posts out of X's own timeline responses as it scrolls, and stops at the count
// asked for. Only the first screen or two is loaded for the default 30, so it's quick and
// doesn't look like scraping. The sign-in is kept in its own session ("persist:x"); the first
// time, the window shows itself so you can log in, and carries on once you have.

// one post from X's GraphQL, kept compact (the shape src/saved.js stores)
function slim(r, depth = 0) {
  if (r && r.__typename === 'TweetWithVisibilityResults') r = r.tweet;
  if (!r || !r.legacy) return null;
  const L = r.legacy, U = r.core?.user_results?.result || {}, uc = U.core || {}, ul = U.legacy || {};
  const nt = r.note_tweet?.note_tweet_results?.result;
  const media = (L.extended_entities?.media || L.entities?.media || []).map((m) => ({
    type: m.type, url: m.media_url_https, w: m.original_info?.width, h: m.original_info?.height,
    video: m.video_info ? (m.video_info.variants || []).filter((v) => v.content_type === 'video/mp4').sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0]?.url : undefined,
  }));
  const urls = [...(L.entities?.urls || []), ...(nt?.entity_set?.urls || [])].map((u) => ({ short: u.url, url: u.expanded_url, display: u.display_url }));
  let card = null;
  if (r.card?.legacy) {
    const b = Object.fromEntries((r.card.legacy.binding_values || []).map((x) => [x.key, x.value]));
    const img = (b.summary_photo_image_large || b.photo_image_full_size_large || b.thumbnail_image_large || b.summary_photo_image || b.thumbnail_image)?.image_value?.url;
    card = { name: r.card.legacy.name, title: b.title?.string_value, description: b.description?.string_value, domain: b.domain?.string_value || b.vanity_url?.string_value, url: b.card_url?.string_value, image: img };
  }
  return {
    id: r.rest_id, name: uc.name || ul.name, handle: uc.screen_name || ul.screen_name, avatar: U.avatar?.image_url || ul.profile_image_url_https, verified: !!U.is_blue_verified,
    created_at: L.created_at, text: nt?.text || L.full_text || '', lang: L.lang, media, urls, card,
    quoted: depth < 1 ? slim(r.quoted_status_result?.result, depth + 1) : null,
    counts: { replies: L.reply_count, reposts: L.retweet_count, likes: L.favorite_count, views: r.views?.count ? Number(r.views.count) : undefined, quotes: L.quote_count, bookmarks: L.bookmark_count },
    reply_to: L.in_reply_to_screen_name || undefined, conversation: L.conversation_id_str, authorId: U.rest_id, replyToUser: L.in_reply_to_user_id_str,
  };
}

// every timeline entry's post in a response, in order (quoted posts stay inside their post)
function posts(body) {
  const out = [];
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) return o.forEach(walk);
    if (o.tweet_results?.result) { const t = slim(o.tweet_results.result); if (t && t.id) out.push(t); return; }
    for (const k in o) walk(o[k]);
  };
  walk(body);
  return out;
}

const TIMELINE = { bookmark: /\/graphql\/[^/]+\/Bookmarks\b/, like: /\/graphql\/[^/]+\/Likes\b/ };
const SIGN_IN = /x\.com\/(login|logout|i\/flow\/|i\/jf\/)|[?&]mode=login/;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let win = null, handle = null;

function xWindow() {
  if (win && !win.isDestroyed()) return win;
  const { BrowserWindow, session } = require('electron');
  const ses = session.fromPartition('persist:x');
  // X turns away browsers it doesn't know; look like the Chrome this is
  ses.setUserAgent(ses.getUserAgent().replace(/\s(openone|Electron)\/\S+/g, ''));
  win = new BrowserWindow({ width: 1000, height: 1100, show: false, title: 'X sign-in for openone', autoHideMenuBar: true, webPreferences: { session: ses, backgroundThrottling: false } });
  return win;
}

// signed in = X's auth_token cookie is there (signed out, X often just shows its public home
// page instead of redirecting to a login URL, so the URL alone can't tell)
const signedIn = async (w) => (await w.webContents.session.cookies.get({ name: 'auth_token' }).catch(() => [])).some((c) => /(^|\.)x\.com$/.test(c.domain.replace(/^\./, '')));

// X's pages can keep loading for good (live connections), so a load counts as done after 15 s
const go = (w, url) => Promise.race([w.loadURL(url).catch(() => {}), wait(15000)]);

// load a page; when you aren't signed in, show X's login and wait (up to 5 minutes) until you are
async function open(w, url) {
  if (!(await signedIn(w))) {
    w.setAlwaysOnTop(true, 'screen-saver'); // above the saved spotlight
    w.show(); w.focus();
    w.loadURL('https://x.com/i/flow/login').catch(() => {});
    const until = Date.now() + 5 * 60e3;
    while (!w.isDestroyed() && !(await signedIn(w))) {
      if (Date.now() > until) { w.setAlwaysOnTop(false); w.hide(); throw new Error('not signed in to X (log in in the window that opens)'); }
      await wait(1000);
    }
    if (w.isDestroyed()) throw new Error('the X window was closed before signing in');
    await wait(2000); // let X finish its redirect after login
    w.setAlwaysOnTop(false);
    w.hide();
  }
  await go(w, url);
  await wait(1500);
  if (SIGN_IN.test(w.webContents.getURL())) throw new Error('X asked to sign in again; press Sync once more');
}

async function myHandle(w) {
  if (handle) return handle;
  await open(w, 'https://x.com/home');
  for (let i = 0; i < 20 && !handle; i++) {
    const href = await w.webContents.executeJavaScript(`document.querySelector('a[data-testid="AppTabBar_Profile_Link"]')?.getAttribute('href') || ''`).catch(() => '');
    handle = href.replace(/^\//, '') || null;
    if (!handle) await wait(500);
  }
  if (!handle) throw new Error("couldn't find your X handle");
  return handle;
}

// the newest n posts of a list: 'bookmark' | 'like'
async function collect(kind, n) {
  const w = xWindow();
  // the debugger's commands wait for a page: a new window has none yet
  if (!w.webContents.getURL()) await go(w, 'about:blank');
  const dbg = w.webContents.debugger;
  if (!dbg.isAttached()) dbg.attach('1.3');
  await dbg.sendCommand('Network.enable');
  const got = new Map(), wanted = new Set();
  const onMsg = async (_e, method, p) => {
    if (method === 'Network.responseReceived' && TIMELINE[kind].test(p.response.url)) wanted.add(p.requestId);
    if (method !== 'Network.loadingFinished' || !wanted.has(p.requestId)) return;
    try {
      const { body } = await dbg.sendCommand('Network.getResponseBody', { requestId: p.requestId });
      for (const t of posts(JSON.parse(body))) if (!got.has(t.id)) got.set(t.id, t);
    } catch {}
  };
  dbg.on('message', onMsg);
  try {
    const url = kind === 'like' ? `https://x.com/${await myHandle(w)}/likes` : 'https://x.com/i/bookmarks';
    await open(w, url);
    // scroll for more until there are enough, or nothing new comes for a while
    let still = 0, last = -1;
    for (let i = 0; i < 60 && got.size < n && still < 6; i++) {
      await wait(1200);
      if (got.size === last) still++; else { still = 0; last = got.size; }
      if (got.size < n) await w.webContents.executeJavaScript('window.scrollTo(0, document.body.scrollHeight)').catch(() => {});
    }
  } finally {
    if (!w.isDestroyed()) {
      dbg.removeListener('message', onMsg);
      await dbg.sendCommand('Network.disable').catch(() => {});
      w.loadURL('about:blank').catch(() => {});
    }
  }
  return [...got.values()].slice(0, n);
}

module.exports = { collect, posts, slim };
