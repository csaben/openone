// Mac terminals, the macOS stand-in for wt.js: the same focus/fg requests, through AppleScript.
// Ghostty when it's installed, otherwise Terminal.app. Panes are looked for in both, since a
// tab can be attached in either; only new tabs prefer Ghostty.
//
// A tab's title for matching is its custom title, the window's name when it's the selected
// tab, and in Terminal the programs running in it, so "tmux" finds a tab attached to tmux.
//
// Nothing here starts a terminal except open(): "tell application" launches an app that
// isn't running, so every read checks first.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SEP = '\u001f';

// one line per tab: target, tab index, selected, window frontmost, app frontmost, tty, title
const TERMINAL_LIST = `
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

const TERMINAL_FOCUS = `
on run argv
  tell application "Terminal"
    set w to window id ((item 1 of argv) as integer)
    set selected tab of w to tab ((item 2 of argv) as integer) of w
    set index of w to 1
    activate
  end tell
end run`;

// a new window, since a new tab can only be had by pressing Cmd+T through System Events
const TERMINAL_OPEN = `
on run argv
  tell application "Terminal"
    set t to do script (item 1 of argv)
    set custom title of t to (item 2 of argv)
    set title displays custom title of t to true
    activate
  end tell
end run`;

// one line per terminal, as a tab can be split; the target is the terminal
const GHOSTTY_LIST = `
on run
  if application "Ghostty" is not running then return "@@OFF"
  set sep to character id 31
  set out to ""
  tell application "Ghostty"
    set fg to frontmost
    set frontId to ""
    if (count of windows) > 0 then set frontId to id of front window
    repeat with w in windows
      set isFront to ((id of w) = frontId)
      repeat with t in tabs of w
        set onTab to selected of t
        set focused to id of focused terminal of t
        repeat with c in terminals of t
          set out to out & (id of c) & sep & (index of t) & sep & (onTab and ((id of c) = focused)) & sep & isFront & sep & fg & sep & (tty of c) & sep & (name of t) & " " & (name of c) & linefeed
        end repeat
      end repeat
    end repeat
  end tell
  return out
end run`;

const GHOSTTY_FOCUS = `
on run argv
  tell application "Ghostty"
    focus (first terminal whose id is (item 1 of argv))
    activate
  end tell
end run`;

const GHOSTTY_OPEN = `
on run argv
  tell application "Ghostty"
    set cfg to new surface configuration
    set command of cfg to (item 1 of argv)
    if (count of windows) > 0 then
      set t to new tab in front window with configuration cfg
    else
      set t to selected tab of (new window with configuration cfg)
    end if
    set name override of t to (item 2 of argv)
    activate
  end tell
end run`;

const hasGhostty = () => ['/Applications', path.join(os.homedir(), 'Applications')].some((d) => fs.existsSync(path.join(d, 'Ghostty.app')));

// Ghostty runs a command without your login shell's PATH, where Homebrew's tmux is
const inLoginShell = (line) => commandLine([os.userInfo().shell || '/bin/zsh', '-lc', line]);

const GHOSTTY = { name: 'Ghostty', list: GHOSTTY_LIST, focus: GHOSTTY_FOCUS, open: GHOSTTY_OPEN, line: inLoginShell };
const TERMINAL = { name: 'Terminal', list: TERMINAL_LIST, focus: TERMINAL_FOCUS, open: TERMINAL_OPEN, line: (l) => l };

// the first is where new tabs go
const appsFor = (ghostty) => (ghostty ? [GHOSTTY, TERMINAL] : [TERMINAL]);

function parseTabs(out) {
  const tabs = [];
  for (const line of String(out || '').split('\n')) {
    const v = line.split(SEP);
    if (v.length < 7) continue;
    tabs.push({ target: v[0], index: Number(v[1]), selected: v[2] === 'true', front: v[3] === 'true', fg: v[4] === 'true', tty: v[5], title: v.slice(6).join(' ').trim() });
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
  constructor(apps = appsFor(hasGhostty())) { this.apps = apps; }

  start() {}

  stop() {}

  // one terminal refusing (Automation turned off for it) shouldn't hide the other's tabs
  async tabs() {
    const got = await Promise.allSettled(this.apps.map((app) => osa(app.list).then((out) => parseTabs(out).map((t) => ({ ...t, app })))));
    const ok = got.filter((g) => g.status === 'fulfilled');
    if (!ok.length) throw got[0].reason;
    return ok.flatMap((g) => g.value);
  }

  async focus(tab, index, tty) {
    try {
      const t = pick(await this.tabs(), tab, index, tty);
      if (!t) return { ok: false, error: 'no matching terminal tab' };
      await osa(t.app.focus, [t.target, String(t.index)]);
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  // what wt.request({ op: 'fg' }) answers: is a terminal in front, and on which tab
  async request(req) {
    if (req.op !== 'fg') return { ok: false, error: 'unknown op' };
    try {
      const showing = (await this.tabs()).filter((x) => x.selected && x.front);
      const t = showing.find((x) => x.fg) || showing[0];
      return { ok: true, wt: !!(t && t.fg), tab: t ? t.title : '', tty: t ? t.tty : '' };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  async open(argv, title) {
    const [app] = this.apps;
    try {
      await osa(app.open, [app.line(commandLine(argv)), title], 15000);
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  }
}

module.exports = { MacTerminal, parseTabs, pick, commandLine, appsFor, inLoginShell };
