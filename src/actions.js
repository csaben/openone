// Answering and replying to an agent pane, shared by the desktop app and the server.
// `p` is a monitor record (has state, kind, session, windowIndex, paneId).

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A background session has no pane until it's opened in a window; open it, give
// `claude attach` a moment to draw, then act on that window's pane.
async function target(src, p) {
  if (!p.bg) return p;
  const pane = await src.attachBackground(p.bg);
  await sleep(2500);
  return { ...p, session: pane.session, windowIndex: pane.windowIndex, paneId: pane.paneId };
}

async function answer(src, p, n) {
  p = await target(src, p);
  await src.keys(p, [String(n)]);
}

async function reply(src, p, text) {
  p = await target(src, p);
  if (p.state === 'input') {
    // Esc declines the menu ("tell it what to do differently") and frees the input box
    await src.keys(p, ['Escape']);
    await sleep(350);
  } else if (p.kind === 'claude') {
    // one Ctrl+C clears any half-typed draft; a single press never exits Claude Code
    await src.keys(p, ['C-c']);
    await sleep(150);
  }
  await src.text(p, text);
  await sleep(60);
  await src.keys(p, ['Enter']);
  if (p.kind === 'claude') await confirmSent(src, p, text);
}

// Claude Code reads a long burst of typing as a paste and can swallow an Enter that lands
// while it's still taking the paste in, leaving the message sitting in the input box. Look
// at the box a moment later and press Enter again while the message is still there.
async function confirmSent(src, p, text, tries = 2) {
  for (let i = 0; i < tries; i++) {
    await sleep(900);
    let screen;
    try { screen = await src.screen(p, 60); } catch { return; }
    if (!stillTyped(screen, text)) return;
    await src.keys(p, ['Enter']);
  }
}

// The input box is the text between the last two horizontal rules on screen.
function stillTyped(screen, text) {
  const lines = String(screen || '').split('\n');
  const rules = lines.map((l, i) => (/^\s*─{10,}\s*$/.test(l) ? i : -1)).filter((i) => i >= 0);
  if (rules.length < 2) return false;
  const box = lines.slice(rules[rules.length - 2] + 1, rules[rules.length - 1]).join('').replace(/\s+/g, '');
  if (/\[Pastedtext/.test(box)) return true;
  const flat = String(text).replace(/\s+/g, '');
  const head = flat.slice(0, 24), tail = flat.slice(-24);
  return Boolean(flat) && (box.includes(head) || box.includes(tail));
}

module.exports = { answer, reply, target, stillTyped };
