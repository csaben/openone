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
}

module.exports = { answer, reply, target };
