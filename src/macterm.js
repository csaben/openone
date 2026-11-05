// Terminal.app, the macOS stand-in for wt.js: the same focus/fg requests, through AppleScript.
// A tab's title for matching is its custom title, the window's name when it's the selected
// tab, and the programs running in it, so "tmux" finds a tab that's attached to tmux.
//
// Nothing here starts Terminal except open(): "tell application" launches an app that isn't
// running, so every read checks first.

const { execFile } = require('child_process');

const SEP = '\u001f';

// one line per tab: window id, tab index, selected, window frontmost, Terminal frontmost, tty, title
const LIST = `
on join(xs)
  set text item delimiters of AppleScript to " "
  set s to xs as text
  set text item delimiters of AppleScript to ""
  return s
end join
on run
  if application "Terminal" is not running then return "@@OFF"
  set sep to character id 31
  set out to ""
  tell application "Terminal"
    set fg to frontmost
    set wn to 0
    repeat with w in windows
      set wn to wn + 1
      set tn to 0
      repeat with t in tabs of w
        set tn to tn + 1
        set title to (custom title of t) & " " & my join(processes of t)
        if selected of t then set title to title & " " & (name of w)
        set out to out & (id of w) & sep & tn & sep & (selected of t) & sep & (wn = 1) & sep & fg & sep & (tty of t) & sep & title & linefeed
      end repeat
    end repeat
  end tell
  return out
end run`;

const FOCUS = `
on run argv
  tell application "Terminal"
    set w to window id ((item 1 of argv) as integer)
    set selected tab of w to tab ((item 2 of argv) as integer) of w
    set index of w to 1
    activate
  end tell
end run`;

// a new window, since a new tab can only be had by pressing Cmd+T through System Events
const OPEN = `
on run argv
  tell application "Terminal"
    set t to do script (item 1 of argv)
    set custom title of t to (item 2 of argv)
    set title displays custom title of t to true
    activate
  end tell
end run`;

function parseTabs(out) {
  const tabs = [];
  for (const line of String(out || '').split('\n')) {
    const v = line.split(SEP);
    if (v.length < 7) continue;
    tabs.push({ window: Number(v[0]), index: Number(v[1]), selected: v[2] === 'true', front: v[3] === 'true', fg: v[4] === 'true', tty: v[5], title: v.slice(6).join(' ').trim() });
  }
  return tabs;
}

// the tab a tty is on, which is exact: several tabs can all be running tmux. Without one,
// the tab a pattern means: the one showing already, then the nearest window's, or by
// position among all the tabs when no title matches
function pick(tabs, pattern, index, tty) {
  const exact = tty && tabs.find((t) => t.tty === tty);
  if (exact) return exact;
  let re = null;
  try { re = pattern ? new RegExp(pattern, 'i') : null; } catch {}
  const hits = re ? tabs.filter((t) => re.test(t.title)) : [];
  return hits.find((t) => t.selected && t.front) || hits.find((t) => t.selected) || hits[0]
    || (Number.isInteger(index) ? tabs[index] : undefined);
}

const shq = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);
const commandLine = (argv) => argv.map(shq).join(' ');

function osa(script, args = [], timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script, ...args], { timeout: timeoutMs, encoding: 'utf8' },
      (err, out, errOut) => (err ? reject(new Error(String(errOut || err.message).trim())) : resolve(out)));
  });
}

class MacTerminal {
  start() {}

  stop() {}

  async tabs() {
    const out = await osa(LIST);
    return out.startsWith('@@OFF') ? [] : parseTabs(out);
  }

  async focus(tab, index, tty) {
    try {
      const t = pick(await this.tabs(), tab, index, tty);
      if (!t) return { ok: false, error: 'no matching Terminal tab' };
      await osa(FOCUS, [String(t.window), String(t.index)]);
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  // what wt.request({ op: 'fg' }) answers: is the terminal in front, and on which tab
  async request(req) {
    if (req.op !== 'fg') return { ok: false, error: 'unknown op' };
    try {
      const t = (await this.tabs()).find((x) => x.selected && x.front);
      return { ok: true, wt: !!(t && t.fg), tab: t ? t.title : '', tty: t ? t.tty : '' };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  async open(argv, title) {
    try {
      await osa(OPEN, [commandLine(argv), title], 15000);
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  }
}

module.exports = { MacTerminal, parseTabs, pick, commandLine, LIST };
