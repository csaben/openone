// Turns a pane capture (with ANSI colors, `capture-pane -e`) into HTML for a phone:
//  - raw(): the terminal as-is, but keeping its colors
//  - chat(): Claude Code / Codex screens as a conversation: your prompts as bubbles, replies
//    reflowed into readable paragraphs, tool calls folded into one-line chips.
// Plain functions over strings, so it runs in the browser and under node's test runner.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OOChat = factory();
})(this, () => {
  // ---------- ANSI -> styled segments ----------

  const BASE16 = ['#1c1d21', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#d6d8dc',
    '#5c6370', '#ef7f88', '#a9d98a', '#f0d08a', '#7cc0ff', '#d58ce6', '#6cd0dc', '#ffffff'];

  function color256(n) {
    if (n < 16) return BASE16[n];
    if (n >= 232) { const v = 8 + (n - 232) * 10; return `rgb(${v},${v},${v})`; }
    const i = n - 16;
    const c = (x) => (x ? 55 + x * 40 : 0);
    return `rgb(${c(Math.floor(i / 36))},${c(Math.floor(i / 6) % 6)},${c(i % 6)})`;
  }

  // One line -> [{ t, fg, bg, b, d, i, u, link }]; fg/bg keep the raw code ('5;246', '2;r;g;b', or 0-15).
  function parseAnsi(text) {
    const out = [];
    let st = {};
    for (const line of String(text).replace(/\r/g, '').split('\n')) {
      const segs = [];
      const push = (t) => {
        if (!t) return;
        const last = segs[segs.length - 1];
        if (last && same(last, st)) last.t += t;
        else segs.push({ ...st, t });
      };
      // colors, links, then any other control sequence (cursor moves etc.), which is dropped
      // except "cursor forward", which is spaces
      const re = /\x1b\[([0-9;:]*)m|\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]*)(?:\x07|\x1b\\)|\x1b\[(\d*)C|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;:?<=>]*[ -\/]*[@-~]|\x1b[@-Z\\-_]/g;
      let at = 0;
      let m;
      while ((m = re.exec(line))) {
        push(line.slice(at, m.index));
        at = re.lastIndex;
        if (m[1] !== undefined) st = sgr(st, m[1]);
        else if (m[2] !== undefined) st = { ...st, link: m[2] || undefined };
        else if (m[3] !== undefined) push(' '.repeat(Number(m[3]) || 1));
      }
      push(line.slice(at));
      out.push(segs);
    }
    return out;
  }

  function same(a, b) {
    return a.fg === b.fg && a.bg === b.bg && !a.b === !b.b && !a.d === !b.d && !a.i === !b.i && !a.u === !b.u && a.link === b.link;
  }

  function sgr(st, codes) {
    const s = { ...st };
    const p = codes === '' ? [0] : codes.split(/[;:]/).map(Number);
    for (let k = 0; k < p.length; k++) {
      const n = p[k];
      if (n === 0) { for (const key of ['fg', 'bg', 'b', 'd', 'i', 'u']) delete s[key]; }
      else if (n === 1) s.b = true;
      else if (n === 2) s.d = true;
      else if (n === 3) s.i = true;
      else if (n === 4) s.u = true;
      else if (n === 22) { delete s.b; delete s.d; }
      else if (n === 23) delete s.i;
      else if (n === 24) delete s.u;
      else if (n >= 30 && n <= 37) s.fg = n - 30;
      else if (n >= 90 && n <= 97) s.fg = n - 82;
      else if (n === 39) delete s.fg;
      else if (n >= 40 && n <= 47) s.bg = n - 40;
      else if (n >= 100 && n <= 107) s.bg = n - 92;
      else if (n === 49) delete s.bg;
      else if (n === 38 || n === 48) {
        const key = n === 38 ? 'fg' : 'bg';
        if (p[k + 1] === 5) { s[key] = Number(p[k + 2]); k += 2; }
        else if (p[k + 1] === 2) { s[key] = `rgb(${p[k + 2]},${p[k + 3]},${p[k + 4]})`; k += 4; }
      }
    }
    return s;
  }

  const css = (c) => (c === undefined ? '' : typeof c === 'number' ? color256(c) : c);
  const plain = (segs) => segs.map((s) => s.t).join('');

  // Cut segments to code points [from, to).
  function slice(segs, from, to = Infinity) {
    const out = [];
    let col = 0;
    for (const s of segs) {
      const cps = Array.from(s.t);
      const a = Math.max(from - col, 0);
      const b = Math.min(to - col, cps.length);
      if (b > a) out.push({ ...s, t: cps.slice(a, b).join('') });
      col += cps.length;
    }
    return out;
  }

  function trimStart(segs) {
    const out = segs.map((s) => ({ ...s }));
    while (out.length && !(out[0].t = out[0].t.replace(/^\s+/, ''))) out.shift();
    return out;
  }

  function trimEnd(segs) {
    const out = segs.map((s) => ({ ...s }));
    while (out.length) {
      const last = out[out.length - 1];
      last.t = last.t.replace(/\s+$/, '');
      if (last.t) break;
      out.pop();
    }
    return out;
  }

  // Claude Code can draw a side panel separated by a vertical bar. Find that column, if any.
  function panelColumn(lines) {
    const count = new Map();
    let rows = 0;
    for (const segs of lines) {
      const cps = Array.from(plain(segs));
      if (!cps.length) continue;
      rows++;
      cps.forEach((ch, i) => { if (ch === '│' && i >= 40) count.set(i, (count.get(i) || 0) + 1); });
    }
    let best = -1;
    let n = 0;
    for (const [col, c] of count) if (c > n) { best = col; n = c; }
    return n >= 6 && n >= rows * 0.5 ? best : -1;
  }

  function screen(text) {
    let lines = parseAnsi(text);
    const col = panelColumn(lines);
    if (col >= 0) lines = lines.map((segs) => slice(segs, 0, col));
    lines = lines.map(trimEnd);
    while (lines.length && !plain(lines[lines.length - 1]).trim()) lines.pop();
    return lines;
  }

  // ---------- HTML ----------

  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const URL_RE = /https?:\/\/[^\s<>"'`)\]]+[^\s<>"'`)\].,;:!?]/g;

  function linkify(t) {
    let out = '';
    let at = 0;
    for (const m of t.matchAll(URL_RE)) {
      out += esc(t.slice(at, m.index)) + `<a href="${esc(m[0])}" target="_blank" rel="noopener">${esc(m[0])}</a>`;
      at = m.index + m[0].length;
    }
    return out + esc(t.slice(at));
  }

  // opts.bg: keep backgrounds (raw view); opts.text: the reader's foreground, so "white" text isn't forced
  function segHtml(segs, opts = {}) {
    return segs.map((s) => {
      const style = [];
      const fg = css(s.fg);
      if (fg && !(opts.text && isPlainFg(s.fg))) style.push(`color:${fg}`);
      if (opts.bg && s.bg !== undefined) style.push(`background:${css(s.bg)}`);
      if (s.b) style.push('font-weight:600');
      if (s.d) style.push('opacity:.65');
      if (s.i) style.push('font-style:italic');
      if (s.u) style.push('text-decoration:underline');
      const body = s.link ? `<a href="${esc(s.link)}" target="_blank" rel="noopener">${esc(s.t)}</a>` : linkify(s.t);
      return style.length ? `<span style="${style.join(';')}">${body}</span>` : body;
    }).join('');
  }

  // tmux reports 256-color codes, psmux truecolor; compare them as rgb
  function rgb(fg) {
    const c = typeof fg === 'number' ? color256(fg) : fg;
    if (!c) return null;
    const m = c.match(/^#(..)(..)(..)$/);
    if (m) return m.slice(1).map((h) => parseInt(h, 16));
    const n = c.match(/\d+/g);
    return n && n.length === 3 ? n.map(Number) : null;
  }
  const neutral = (c) => Math.max(...c) - Math.min(...c) < 24;
  const isPlainFg = (fg) => { if (fg === undefined) return true; const c = rgb(fg); return !!c && neutral(c) && Math.min(...c) >= 200; };
  const isGrey = (fg) => { const c = rgb(fg); return !!c && neutral(c) && Math.max(...c) >= 70 && Math.max(...c) < 190; };

  function raw(text) {
    return screen(text).map((segs) => segHtml(segs, { bg: true })).join('\n');
  }

  // ---------- chat ----------

  const RULE = /^\s*[─━]{20,}\s*$/;
  const USER = /^[❯›>] ?(?=\S)/;
  const ASSIST = /^[●•⏺] /;
  const STATUS = /^[✻✶✳✢✽✺✹✷✸*·] \S/;
  const WARN = /^⚠ /;
  const TOOLWORD = /^(Ran|Read|Explored|Edited|Searched|Updated|Added|Deleted|Called|Waited|Listed|Wrote|Fetched|Compacted|Agent)\b/;
  const LIST = /^(\s*)([-*•◦▪]|\d{1,3}[.)]) +/;
  const BOX = /[┌┬┐├┼┤└┴┘│╭╮╰╯]/;

  // Drop the input box (and any menu drawn under it): from the first rule after the
  // last reply/status line, if that is near the bottom.
  function composerStart(lines) {
    let lastMark = -1;
    lines.forEach((segs, i) => { const t = plain(segs); if (ASSIST.test(t) || STATUS.test(t)) lastMark = i; });
    for (let i = Math.max(lastMark + 1, lines.length - 40); i < lines.length; i++) {
      if (RULE.test(plain(lines[i]))) return i;
    }
    return lines.length;
  }

  function stripMarker(segs, re) {
    const t = plain(segs);
    const m = t.match(re);
    return m ? { marker: segs[0], segs: slice(segs, Array.from(m[0]).length) } : { marker: null, segs };
  }

  function dedent(segs, n) {
    const lead = plain(segs).match(/^ */)[0].length;
    return slice(segs, Math.min(lead, n));
  }

  // Split a screen into blocks: user, reply, tool, meta, status, warn, raw.
  function blocks(lines) {
    const out = [];
    let cur = null;
    const open = (b) => { cur = b; out.push(b); return b; };
    for (let i = 0; i < lines.length; i++) {
      const segs = lines[i];
      const t = plain(segs);
      const blank = !t.trim();
      if (blank) {
        if (cur && (cur.type === 'reply' || cur.type === 'raw')) cur.lines.push(segs);
        else if (cur && cur.type !== 'raw') cur.closed = true;
        continue;
      }
      if (segs.logo) {
        if (cur && cur.type === 'meta' && !cur.closed) cur.lines.push(segs);
        else open({ type: 'meta', lines: [segs] });
        continue;
      }
      if (USER.test(t)) { open({ type: 'user', lines: [stripMarker(segs, USER).segs] }); continue; }
      if (STATUS.test(t)) { open({ type: 'status', lines: [segs] }); continue; }
      if (WARN.test(t)) { open({ type: 'warn', lines: [segs] }); continue; }
      if (ASSIST.test(t)) {
        const { marker, segs: rest } = stripMarker(segs, ASSIST);
        const body = plain(rest);
        const tool = !isPlainFg(marker && marker.fg) || TOOLWORD.test(body) || /^[\w.-]+\(.*\)?\s*$/.test(body)
          || (lines[i + 1] && /^\s+⎿/.test(plain(lines[i + 1])));
        open({ type: tool ? 'tool' : 'reply', lines: [rest], ok: marker && marker.fg });
        continue;
      }
      if (/^\s/.test(t)) {
        const sub = /^\s+⎿/.test(t);
        if (cur && cur.type === 'tool' && !cur.closed) { cur.lines.push(segs); continue; }
        if (sub) {
          const line = trimStart(slice(segs, t.indexOf('⎿') + 1));
          if (cur && cur.type === 'meta' && !cur.closed) cur.lines.push(line);
          else open({ type: 'meta', lines: [line] });
          continue;
        }
        if (cur && cur.type === 'user' && !cur.closed) { cur.lines.push(segs); continue; }
        if (cur && (cur.type === 'warn' || cur.type === 'meta') && !cur.closed) { cur.lines.push(segs); continue; }
        if (cur && cur.type === 'reply') { cur.lines.push(segs); continue; }
        if (cur && cur.type === 'status' && !cur.closed) { cur.lines.push(segs); continue; }
        open({ type: 'reply', lines: [segs], cont: true });
        continue;
      }
      if (cur && cur.type === 'raw') cur.lines.push(segs);
      else open({ type: 'raw', lines: [segs] });
    }
    // grey one-line paragraphs inside a reply ("Ran 2 shell commands") read better as chips
    const split = [];
    for (const b of out) {
      if (b.type !== 'reply') { split.push(b); continue; }
      let para = [];
      let reply = { ...b, lines: [] };
      const flush = () => {
        const only = para.length === 1 && para[0].every((s) => !s.t.trim() || isGrey(s.fg) || s.d);
        if (only) {
          if (reply.lines.some((l) => plain(l).trim())) split.push(reply);
          split.push({ type: 'meta', lines: para });
          reply = { type: 'reply', lines: [], cont: true };
        } else reply.lines.push(...para, []);
        para = [];
      };
      for (const l of b.lines) { if (plain(l).trim()) para.push(l); else flush(); }
      flush();
      if (reply.lines.some((l) => plain(l).trim())) split.push(reply);
    }
    // a tool line with nothing under it and a grey dot is a note ("Compacted while idle")
    const merged = [];
    for (const b of split) {
      const note = b.type === 'meta' || (b.type === 'tool' && b.lines.length === 1 && isGrey(b.ok));
      const prev = merged[merged.length - 1];
      if (note && prev && prev.type === 'meta') prev.lines.push(...b.lines);
      else merged.push(note ? { type: 'meta', lines: b.lines.slice() } : b);
    }
    return merged;
  }

  // Rejoin lines the terminal wrapped, so text reflows to the phone. A line was wrapped
  // if the next word would not have fit after it.
  function reflow(lines, width) {
    const out = [];
    for (const segs of lines) {
      const t = plain(segs);
      const prev = out[out.length - 1];
      if (prev && t.trim() && !prev.box && !BOX.test(t) && !LIST.test(t)) {
        const indent = t.match(/^ */)[0].length;
        const word = t.trim().split(/\s/)[0];
        if (prev.end + 1 + Array.from(word).length > width - 2 && indent >= prev.indent && indent <= prev.indent + 4) {
          prev.segs = prev.segs.concat([{ t: ' ' }], slice(segs, indent));
          prev.end = Array.from(t).length;
          continue;
        }
      }
      const lm = t.match(LIST);
      out.push({
        segs, end: Array.from(t).length, box: BOX.test(t), blank: !t.trim(),
        indent: lm ? lm[1].length + Array.from(lm[0]).length - lm[1].length : t.match(/^ */)[0].length,
      });
    }
    return out;
  }

  function paragraphs(lines, width, base) {
    const html = [];
    let box = [];
    const flushBox = () => {
      if (box.length) html.push(`<pre class="box">${box.map((s) => segHtml(s)).join('\n')}</pre>`);
      box = [];
    };
    for (const l of reflow(lines, width)) {
      if (l.box) { box.push(dedent(l.segs, base)); continue; }
      flushBox();
      if (l.blank) { if (html.length && html[html.length - 1] !== '<i class="gap"></i>') html.push('<i class="gap"></i>'); continue; }
      const segs = dedent(l.segs, base);
      const t = plain(segs);
      const lm = t.match(LIST);
      if (lm) {
        const lead = lm[1].length;
        const mark = lm[2];
        const rest = slice(segs, Array.from(lm[0]).length);
        html.push(`<div class="li" style="margin-left:${lead * 0.55}em"><span class="mk">${esc(/\d/.test(mark) ? mark : '•')}</span><span>${segHtml(rest, { text: true })}</span></div>`);
      } else {
        const lead = t.match(/^ */)[0].length;
        html.push(`<p${lead ? ` style="margin-left:${lead * 0.55}em"` : ''}>${segHtml(slice(segs, lead), { text: true })}</p>`);
      }
    }
    flushBox();
    while (html[html.length - 1] === '<i class="gap"></i>') html.pop();
    return html.join('');
  }

  // Keyboard hints and the logo art mean nothing on a phone.
  function noise(segs) {
    const t = plain(segs);
    const m = t.match(/ ?\((?:ctrl|shift)\+\w[^)]*\)/);
    if (m) {
      const at = Array.from(t.slice(0, m.index)).length;
      return noise(slice(segs, 0, at).concat(slice(segs, at + Array.from(m[0]).length)));
    }
    if (/[▐▛▜▌▝▘▗▖▀▄█]{2}/.test(t)) {
      return Object.assign(trimStart(segs.map((s) => ({ ...s, t: s.t.replace(/[▐▛▜▌▝▘▗▖▀▄█]+ */g, '') }))), { logo: true });
    }
    return segs;
  }

  // state: the pane's monitor state ({ state, kind }), for the live "working" status.
  function chat(text, state = {}) {
    let lines = screen(text).map(noise);
    lines = lines.slice(0, composerStart(lines));
    const width = Math.max(40, ...lines.map((s) => Array.from(plain(s)).length));
    const items = blocks(lines);
    const html = [];
    items.forEach((b, n) => {
      if (b.type === 'user') {
        html.push(`<div class="msg you">${paragraphs(b.lines.map((s) => dedent(s, 2)), width - 2, 0)}</div>`);
      } else if (b.type === 'reply') {
        html.push(`<div class="msg bot${b.cont ? ' cont' : ''}">${paragraphs(b.lines, width, 2)}</div>`);
      } else if (b.type === 'tool') {
        const head = segHtml(b.lines[0], { text: true });
        const body = b.lines.slice(1).map((s) => segHtml(dedent(s, 2), { bg: true })).join('\n');
        const c = rgb(b.ok);
        const cls = c && c[0] > 170 && c[1] < 120 ? ' err' : '';
        html.push(body
          ? `<details class="tool${cls}" data-k="${n}:${esc(plain(b.lines[0]).slice(0, 60))}"><summary>${head}</summary><pre>${body}</pre></details>`
          : `<div class="tool${cls}"><span>${head}</span></div>`);
      } else if (b.type === 'meta') {
        html.push(`<div class="meta">${b.lines.map((s) => segHtml(dedent(s, 2), { text: true })).join('<br>')}</div>`);
      } else if (b.type === 'status') {
        const live = n === items.length - 1 && state.state === 'working';
        html.push(`<div class="status${live ? ' live' : ''}">${b.lines.map((s) => segHtml(dedent(s, 2), { text: true })).join('<br>')}</div>`);
      } else if (b.type === 'warn') {
        html.push(`<div class="warn">${paragraphs(b.lines, width, 2)}</div>`);
      } else {
        html.push(`<pre class="term">${b.lines.map((s) => segHtml(s, { bg: true })).join('\n')}</pre>`);
      }
    });
    return html.join('');
  }

  return { parseAnsi, screen, raw, chat, blocks, plain };
});
