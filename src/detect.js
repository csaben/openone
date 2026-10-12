// Turns the visible text of a tmux pane into { kind, state, question, options, summary, draft }.
// Pure functions only: everything here is driven by fixtures in test/.

const RULE = /^\s*[─━╌]{3,}/;
const OPTION = /^\s*[│|]?\s*([❯›>])?\s*(\d)[.)]\s+(.+?)\s*[│|]?\s*$/;
const BOX_EDGE = /^\s*[│|╭╰]|[│|╮╯]\s*$/g;

function clean(line) {
  return line.replace(BOX_EDGE, '').replace(/\s+$/, '').trim();
}

function detectKind(text, meta = {}) {
  const hint = `${meta.command || ''} ${meta.windowName || ''}`.toLowerCase();
  if (/codex/.test(hint) || /OpenAI Codex|\d+% context left/.test(text.slice(-2500))) return 'codex';
  if (/claude/.test(hint)) return 'claude';
  if (/⏵⏵|⏸|\? for shortcuts|bypass permissions|accept edits on|plan mode on|Claude Code v\d/.test(text)) return 'claude';
  if (/^● [A-Z][A-Za-z]+\(/m.test(text) && /⎿/.test(text)) return 'claude';
  if (/^[✻✳✢✶✽·*] \S+ for \d/m.test(text) && /❯/.test(text)) return 'claude';
  return null;
}

// Finds a numbered menu near the bottom of the screen that a cursor is sitting on.
function findMenu(lines) {
  const tail = lines.slice(-30);
  let best = null;
  for (let i = 0; i < tail.length; i++) {
    const m = tail[i].match(OPTION);
    if (!m || m[2] !== '1') continue;
    const opts = [];
    let cursor = false;
    let expect = 1;
    for (let j = i; j < tail.length; j++) {
      const mm = tail[j].match(OPTION);
      if (mm && Number(mm[2]) === expect) {
        if (mm[1]) cursor = true;
        let label = mm[3].replace(/\s+\((?:y|a|esc|n)\)$/i, '').trim();
        const recommended = /\(recommended\)/i.test(label);
        label = label.replace(/\s*\(recommended\)\s*/i, ' ').trim();
        if (!/^(type something\.?|chat about this)$/i.test(label)) opts.push({ n: expect, label, recommended });
        expect++;
      } else if (opts.length && (/^\s{3,}\S/.test(tail[j]) || !tail[j].trim())) {
        continue; // option description or spacing
      } else if (opts.length) {
        break;
      }
    }
    if (opts.length >= 2 && cursor) best = { start: i, options: opts };
  }
  if (!best) return null;
  let question = '';
  for (let k = best.start - 1; k >= 0 && k >= best.start - 12; k--) {
    const l = clean(tail[k]);
    if (!l || RULE.test(l) || /^[☐☒✔□■]/.test(l)) continue;
    if (/\?$/.test(l)) { question = l; break; }
    if (!question) question = l;
  }
  // The dialog starts after the last solid rule: first line is its topic ("☐ Pricing",
  // "Bash command"); a block fenced by dashed ╌ rules is the command being approved.
  let top = 0;
  for (let k = best.start - 1; k >= 0; k--) if (/^\s*[─━]{3,}/.test(tail[k])) { top = k + 1; break; }
  const block = tail.slice(top, best.start).map(clean);
  const topic = (block.find((l) => l && !/^[╌]/.test(l)) || '').replace(/^[☐☒✔□■]\s*/, '');
  const fences = block.map((l, k) => (/^╌{3,}/.test(l) ? k : -1)).filter((k) => k >= 0);
  const detail = fences.length >= 2 ? block.slice(fences[0] + 1, fences[1]).filter(Boolean).join('\n') : '';
  return {
    question: question.replace(/^[?❓]\s*/, ''),
    topic: topic === question ? '' : topic.slice(0, 80),
    detail: detail.slice(0, 400),
    options: best.options.slice(0, 9),
  };
}

function lastMessage(lines) {
  let end = -1;
  for (let i = lines.length - 1; i >= 0 && end < 0; i--) {
    if (/^[✻✳✢✶✽] \S+ for /.test(lines[i])) end = i;
  }
  // no "done" line on screen: stop at the top border of the input box
  for (let i = lines.length - 1; i > 0 && end < 0; i--) {
    if (RULE.test(lines[i - 1]) && /^\s*[❯›>]/.test(lines[i])) end = i - 1;
  }
  if (end < 0) end = lines.length;
  lines = lines.map((x) => x.replace(/[│┃]/g, ' '));
  for (let i = end - 1; i >= 0; i--) {
    const l = lines[i];
    if (/^[●•] /.test(l) && !/^[●•] [A-Z][A-Za-z]+\(/.test(l)) {
      const body = lines.slice(i, end).map((x) => x.trim()).filter((x) => x && !/^⎿/.test(x));
      return body.join(' ').replace(/^[●•]\s*/, '').replace(/\s+/g, ' ').slice(0, 400);
    }
  }
  // message start scrolled off: take the visible tail of it
  const body = lines.slice(Math.max(0, end - 8), end).map((x) => x.trim()).filter((x) => x && !RULE.test(x));
  return body.join(' ').replace(/\s+/g, ' ').slice(0, 400);
}

// The "✻ Baked for 7s · done 12:45 AM" line: its time, and the whole line as a turn id.
function finished(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^[✻✳✢✶✽] \S+ for [^·]+· done (\d{1,2}:\d{2}\s?[AP]M)/);
    if (m) return { at: m[1], turn: lines[i].trim() };
  }
  return { at: '', turn: '' };
}

function detect(text, meta = {}) {
  const lines = text.replace(/\r/g, '').split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const kind = detectKind(text, meta);
  if (!kind) return { kind: null, state: 'shell' };
  const footer = lines.slice(-8).join('\n');
  const working = /esc to interrupt/i.test(footer);
  const menu = working ? null : findMenu(lines);
  const waitHint = /esc to cancel|enter to (select|confirm)|do you want to|would you like to/i.test(lines.slice(-30).join('\n'));
  if (menu && (waitHint || menu.options.length)) {
    return { kind, state: 'input', question: menu.question, topic: menu.topic, detail: menu.detail, options: menu.options };
  }
  if (working) return { kind, state: 'working' };
  const f = finished(lines);
  return { kind, state: 'idle', summary: lastMessage(lines), doneAt: f.at, turn: f.turn };
}

module.exports = { detect, detectKind, findMenu, lastMessage };
