// Push-to-talk: hold a key combo or a mouse button, talk, let go. The audio goes to a
// speech-to-text server (OpenAI-style /v1/audio/transcriptions) and the text goes to an
// agent's chat, or is pasted into whatever window has focus.
//
// Keys and mouse buttons come from a global hook (uiohook-napi), the only way to see a
// key being let go, and mouse buttons, while another app has focus. The hook can't
// swallow them, so the combo still reaches that app too: pick one nothing else uses.
//
// A trigger is { keys: [keycode], button: 0 | 3 | 4 | 5 } (button: middle, back, forward).
// Everything here except the hook and the request is pure, for tests.

// left and right modifiers count as the same key
const SAME = { 3613: 29, 54: 42, 3640: 56, 3676: 3675 }; // CtrlRight, ShiftRight, AltRight, MetaRight
const MODS = new Set([29, 42, 56, 3675]);
const norm = (code) => SAME[code] || code;

const NAMES = {
  29: 'Ctrl', 42: 'Shift', 56: 'Alt', 3675: 'Win', 57: 'Space', 28: 'Enter', 15: 'Tab', 1: 'Esc', 14: 'Backspace',
  3639: 'PrintScreen', 70: 'ScrollLock', 3653: 'Pause', 3666: 'Insert', 3667: 'Delete', 3655: 'Home', 3663: 'End',
  3657: 'PageUp', 3665: 'PageDown', 57416: 'Up', 57424: 'Down', 57419: 'Left', 57421: 'Right', 58: 'CapsLock',
  41: '`', 12: '-', 13: '=', 26: '[', 27: ']', 43: '\\', 39: ';', 40: "'", 51: ',', 52: '.', 53: '/',
};
const ROWS = { 2: '1234567890', 16: 'QWERTYUIOP', 30: 'ASDFGHJKL', 44: 'ZXCVBNM' };
for (const [start, chars] of Object.entries(ROWS)) [...chars].forEach((c, i) => { NAMES[Number(start) + i] = c; });
[59, 60, 61, 62, 63, 64, 65, 66, 67, 68].forEach((code, i) => { NAMES[code] = `F${i + 1}`; });
NAMES[87] = 'F11';
NAMES[88] = 'F12';
for (let i = 13; i <= 24; i++) NAMES[91 + i - 13] = `F${i}`; // F13-F24: 91..102
const BUTTONS = { 3: 'Middle click', 4: 'Mouse back', 5: 'Mouse forward' };

const keyName = (code) => NAMES[norm(code)] || `Key ${code}`;

function label(t) {
  if (!t || (!t.button && !(t.keys || []).length)) return 'Not set';
  const rank = (k) => { const i = [29, 56, 42, 3675].indexOf(norm(k)); return i < 0 ? 9 : i; }; // Ctrl, Alt, Shift, Win, then the rest
  const keys = [...(t.keys || [])].sort((a, b) => rank(a) - rank(b));
  return [...keys.map(keyName), ...(t.button ? [BUTTONS[t.button] || `Mouse ${t.button}`] : [])].join(' + ');
}

// Watches hook events for the trigger. feed() -> 'press' when the combo completes,
// 'release' when a part of it is let go, else null.
class Trigger {
  constructor(t) {
    this.t = { keys: (t && t.keys || []).map(norm), button: (t && t.button) || 0 };
    this.held = new Set();
    this.on = false;
  }

  get set() { return !!(this.t.button || this.t.keys.length); }

  // ev: { type: 'keydown'|'keyup'|'mousedown'|'mouseup', keycode, button }
  feed(ev) {
    if (!this.set) return null;
    const id = ev.type.startsWith('mouse') ? `m${ev.button}` : `k${norm(ev.keycode)}`;
    const part = id === `m${this.t.button}` || this.t.keys.some((k) => id === `k${k}`);
    if (ev.type === 'keydown' || ev.type === 'mousedown') {
      if (this.held.has(id)) return null; // key repeat
      this.held.add(id);
      const all = this.t.keys.every((k) => this.held.has(`k${k}`)) && (!this.t.button || this.held.has(`m${this.t.button}`));
      if (!this.on && part && all) { this.on = true; return 'press'; }
      return null;
    }
    this.held.delete(id);
    if (this.on && part) { this.on = false; return 'release'; }
    return null;
  }
}

// Listens for a new trigger: the keys held together (done when they're all let go), or a
// middle/back/forward mouse button, with any keys held at the time. feed() -> null while
// listening, { trigger } when done, { cancel: true } on Esc, { error } for a bad pick.
class Capture {
  constructor() { this.held = new Set(); this.keys = new Set(); }

  feed(ev) {
    if (ev.type === 'mousedown') {
      if (![3, 4, 5].includes(ev.button)) return null; // left and right clicks are for clicking
      return { trigger: { keys: [...this.held], button: ev.button } };
    }
    const code = norm(ev.keycode);
    if (ev.type === 'keydown') {
      if (code === 1 && !this.keys.size) return { cancel: true };
      this.held.add(code);
      this.keys.add(code);
      return null;
    }
    if (ev.type !== 'keyup') return null;
    this.held.delete(code);
    if (this.held.size || !this.keys.size) return null;
    const keys = [...this.keys];
    // a lone letter, digit or Space would fire every time you type it
    if (keys.length === 1 && /^([A-Z0-9]|Space|Enter|Tab|Backspace)$/.test(keyName(keys[0]))) {
      this.keys.clear();
      return { error: `${keyName(keys[0])} alone would fire while you type; hold a modifier with it (Ctrl, Alt, Shift, Win)` };
    }
    if (keys.every((k) => MODS.has(k)) && keys.length === 1) {
      this.keys.clear();
      return { error: `${keyName(keys[0])} alone is used by every shortcut; add another key` };
    }
    return { trigger: { keys, button: 0 } };
  }
}

// audio bytes -> text
async function transcribe({ url, model, audio, mime = 'audio/webm', timeoutMs = 60000 }) {
  if (!url) throw new Error('no speech-to-text server set');
  const form = new FormData();
  form.append('file', new Blob([audio], { type: mime }), mime.includes('wav') ? 'speech.wav' : 'speech.webm');
  form.append('model', model || 'Systran/faster-whisper-small');
  const r = await fetch(url, { method: 'POST', body: form, signal: AbortSignal.timeout(timeoutMs) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error && (j.error.message || j.error) || `speech-to-text: HTTP ${r.status}`);
  return String(j.text || '').trim();
}

// The global hook, started once and shared. -> { on(fn), off(fn), paste(enter) }, or null
// (hookError says why) when it can't load
let hook = null;
let hookError = '';
function globalHook() {
  if (hook || hookError) return hook;
  try {
    const { uIOhook, UiohookKey } = require('uiohook-napi');
    const fns = new Set();
    for (const type of ['keydown', 'keyup', 'mousedown', 'mouseup']) {
      uIOhook.on(type, (e) => { for (const fn of fns) fn({ type, keycode: e.keycode, button: e.button }); });
    }
    uIOhook.start();
    hook = {
      on: (fn) => fns.add(fn),
      off: (fn) => fns.delete(fn),
      paste: (enter) => {
        uIOhook.keyTap(UiohookKey.V, [UiohookKey.Ctrl]);
        if (enter) setTimeout(() => uIOhook.keyTap(UiohookKey.Enter), 60);
      },
      stop: () => { try { uIOhook.stop(); } catch {} },
    };
  } catch (e) {
    hookError = e.message;
  }
  return hook;
}
const hookProblem = () => hookError;
const stopHook = () => { if (hook) hook.stop(); };

module.exports = { Trigger, Capture, label, keyName, transcribe, globalHook, hookProblem, stopHook, norm };
