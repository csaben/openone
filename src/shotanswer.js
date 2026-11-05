// The answer an agent gave to a message, read off its screen (Claude Code's layout): the
// "● " messages after the last line containing `marker`, without tool calls and their output.
// '' when it hasn't answered yet.

const RULE = /^\s*[─━]{8,}/;
const DONE = /^[✻✳✢✶✽] \S+ for /;
const TOOL = /^[●•] [A-Z][A-Za-z]+(\(|$)/; // "● Bash(...)", "● Read(...)"

function answerAfter(text, marker) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].includes(marker)) { start = i; break; }
  if (start < 0) return '';
  const out = [];
  let keep = false;
  for (const raw of lines.slice(start + 1)) {
    const l = raw.replace(/[│┃]/g, ' ').trimEnd();
    if (RULE.test(l) || DONE.test(l)) break; // the input box, or the "done" line: the turn ended
    if (/^[●•] /.test(l)) { keep = !TOOL.test(l); if (keep) out.push(l.replace(/^[●•] /, '')); continue; }
    if (/^\s*⎿/.test(l)) { keep = false; continue; }
    if (/^\s*[❯›>] /.test(l)) { keep = false; continue; } // another message of his
    if (keep) out.push(l.replace(/^ {2}/, ''));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

module.exports = { answerAfter };
