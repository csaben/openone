// The whiteboard page: Excalidraw, kept in step with the openone server's shared board
// (src/board.js). Edits go up as they settle; other pages' edits and agents' drawings come
// down on the event stream. Agents' drawings arrive as ops this page turns into elements.
import React from 'https://esm.sh/react@18.3.1';
import { createRoot } from 'https://esm.sh/react-dom@18.3.1/client';
import {
  Excalidraw, MainMenu, convertToExcalidrawElements, exportToBlob, reconcileElements, restoreElements, CaptureUpdateAction,
} from 'https://esm.sh/@excalidraw/excalidraw@0.18.1?deps=react@18.3.1,react-dom@18.3.1';

const h = React.createElement;
let api = null;
let serverVersion = 0;
const sentVersions = new Map(); // element id -> version the server has
const sentFiles = new Set();
const opsSeen = new Set();
let syncTimer = null;
let snapTimer = null;

// Overlay mode (the desktop app's "draw on screen"): transparent, over one screen, showing
// the board region at (x, y), 1 board unit per screen pixel. `hide` is a pinned screenshot
// to leave out, so its marks sit on the live screen instead.
const params = new URLSearchParams(location.search);
const OVERLAY = params.get('overlay') === '1'
  ? { x: Number(params.get('x')) || 0, y: Number(params.get('y')) || 0, w: Number(params.get('w')) || 0, h: Number(params.get('h')) || 0, hide: params.get('hide') || '' }
  : null;
const shown = (els) => (OVERLAY && OVERLAY.hide ? els.filter((e) => e.id !== OVERLAY.hide) : els);
const mine = new Set(); // elements this page created (what Discard takes back)

async function call(method, url, body) {
  const r = await fetch(url, {
    method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

function status(msg, ms = 2500) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.style.display = msg ? 'block' : 'none';
  clearTimeout(status.t);
  if (msg && ms) status.t = setTimeout(() => { el.style.display = 'none'; }, ms);
}

const remember = (els) => { for (const e of els) sentVersions.set(e.id, e.version); };

// ---------- up: this page's edits ----------

function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(sync, 300);
}

async function sync() {
  if (!api) return;
  const els = api.getSceneElementsIncludingDeleted().filter((e) => sentVersions.get(e.id) !== e.version);
  for (const e of els) if (!sentVersions.has(e.id)) mine.add(e.id);
  const files = {};
  for (const [id, f] of Object.entries(api.getFiles())) if (!sentFiles.has(id)) files[id] = f;
  if (!els.length && !Object.keys(files).length) return;
  try {
    const r = await call('POST', 'api/board/scene', { elements: els, files });
    remember(els);
    for (const id of Object.keys(files)) sentFiles.add(id);
    serverVersion = r.version;
    scheduleSnapshot();
  } catch (e) { status(`Not saved: ${e.message}`, 5000); scheduleSync(); }
}

// a picture of the board after edits settle: what agents see when they read it
function scheduleSnapshot() {
  clearTimeout(snapTimer);
  snapTimer = setTimeout(snapshot, 1500);
}

async function snapshot() {
  if (!api) return;
  const elements = api.getSceneElements();
  if (!elements.length) return;
  try {
    const blob = await exportToBlob({
      elements, files: api.getFiles(), mimeType: 'image/png', maxWidthOrHeight: 1800,
      appState: { ...api.getAppState(), exportBackground: true, exportWithDarkMode: false, viewBackgroundColor: '#ffffff' },
    });
    await fetch(`api/board/snapshot?version=${serverVersion}`, { method: 'POST', body: blob });
  } catch {}
}

// ---------- down: everyone else's edits, and agents' drawings ----------

async function pull() {
  const s = await call('GET', 'api/board');
  serverVersion = s.version;
  const remote = restoreElements(s.elements, null);
  const merged = reconcileElements(api.getSceneElementsIncludingDeleted(), remote, api.getAppState());
  remember(remote);
  api.updateScene({ elements: shown(merged), captureUpdate: CaptureUpdateAction.NEVER });
  const newFiles = Object.values(s.files || {}).filter((f) => !api.getFiles()[f.id]);
  if (newFiles.length) { api.addFiles(newFiles); for (const f of newFiles) sentFiles.add(f.id); }
  for (const op of s.ops || []) if (!opsSeen.has(op.id)) drawOp(op);
}

async function drawOp(op) {
  opsSeen.add(op.id);
  if (!(await call('POST', `api/board/ops/${encodeURIComponent(op.id)}/claim`).catch(() => ({}))).ok) return; // another page has it
  try {
    let skeleton = op.elements || [];
    let files = {};
    if (op.mermaid) {
      const { parseMermaidToExcalidraw } = await import('https://esm.sh/@excalidraw/mermaid-to-excalidraw@2.2.2');
      const r = await parseMermaidToExcalidraw(op.mermaid);
      skeleton = r.elements;
      files = r.files || {};
    }
    let els = convertToExcalidrawElements(skeleton, { regenerateIds: false });
    if (op.place !== 'exact') els = place(els);
    api.addFiles(Object.values(files));
    api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), ...els], captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    const r = await call('POST', 'api/board/scene', { elements: els, files, done: [op.id], result: { [op.id]: { ids: els.map((e) => e.id) } } });
    remember(els);
    for (const id of Object.keys(files)) sentFiles.add(id);
    serverVersion = r.version;
    api.scrollToContent(els, { fitToViewport: true, viewportZoomFactor: 0.8, animate: true });
    status(`${op.from} drew on the board`);
    scheduleSnapshot();
  } catch (e) {
    status(`Couldn't draw ${op.from}'s drawing: ${e.message}`, 6000);
  }
}

// An agent's drawing goes next to what's there (to the right, top-aligned), or in the
// middle of the view on an empty board, so it never lands on top of yours.
function place(els) {
  const box = (list) => {
    const xs = list.flatMap((e) => [e.x, e.x + (e.width || 0)]);
    const ys = list.flatMap((e) => [e.y, e.y + (e.height || 0)]);
    return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
  };
  if (!els.length) return els;
  const mine = box(els);
  const live = api.getSceneElements();
  let dx;
  let dy;
  if (live.length) {
    const there = box(live);
    dx = there.x2 + 120 - mine.x1;
    dy = there.y1 - mine.y1;
  } else {
    const a = api.getAppState();
    const cx = -a.scrollX + a.width / 2 / a.zoom.value;
    const cy = -a.scrollY + a.height / 2 / a.zoom.value;
    dx = cx - (mine.x1 + mine.x2) / 2;
    dy = cy - (mine.y1 + mine.y2) / 2;
  }
  return els.map((e) => ({ ...e, x: e.x + dx, y: e.y + dy }));
}

function listen() {
  const es = new EventSource('api/events?board=1');
  es.addEventListener('board', (e) => {
    const { version } = JSON.parse(e.data);
    if (version > serverVersion) pull().catch(() => {});
  });
  es.addEventListener('open', () => pull().catch(() => {})); // after a reconnect, catch up
}

// ---------- the page ----------

const initial = call('GET', 'api/board').then((s) => {
  serverVersion = s.version;
  const elements = restoreElements(s.elements, null);
  remember(elements);
  for (const id of Object.keys(s.files || {})) sentFiles.add(id);
  if (OVERLAY) {
    // clear canvas, light theme (dark inverts colors), red pen, locked to the region
    return {
      elements: shown(elements), files: s.files,
      appState: {
        theme: 'light', viewBackgroundColor: 'transparent', scrollX: -OVERLAY.x, scrollY: -OVERLAY.y, zoom: { value: 1 },
        currentItemStrokeColor: '#e03131', currentItemStrokeWidth: 2, currentItemRoughness: 0,
      },
    };
  }
  setTimeout(() => { for (const op of s.ops || []) drawOp(op); }, 500);
  // dark mode inverts the canvas, so a white background shows as near-black
  return { elements, files: s.files, appState: { theme: 'dark', viewBackgroundColor: '#ffffff' }, scrollToContent: true };
});

function App() {
  return h(Excalidraw, {
    initialData: initial,
    excalidrawAPI: (a) => { api = a; window.ooBoardApi = a; if (OVERLAY) setTimeout(() => a.setActiveTool({ type: 'freedraw' }), 300); },
    onChange: (elements, appState) => { scheduleSync(); if (OVERLAY) lockView(appState); else watchSelection(elements, appState); },
    UIOptions: { canvasActions: { loadScene: false, saveToActiveFile: false } },
  }, h(MainMenu, null,
    h(MainMenu.DefaultItems.Export),
    h(MainMenu.DefaultItems.SaveAsImage),
    h(MainMenu.DefaultItems.ClearCanvas),
    h(MainMenu.Separator),
    h(MainMenu.DefaultItems.ToggleTheme),
    h(MainMenu.DefaultItems.ChangeCanvasBackground),
    h(MainMenu.DefaultItems.Help)));
}

// ---------- overlay ----------

// keep the overlay's view on its region, whatever scrolling or zooming happens
function lockView(a) {
  if (a.scrollX === -OVERLAY.x && a.scrollY === -OVERLAY.y && a.zoom.value === 1) return;
  setTimeout(() => api.updateScene({ appState: { scrollX: -OVERLAY.x, scrollY: -OVERLAY.y, zoom: { value: 1 } }, captureUpdate: CaptureUpdateAction.NEVER }), 0);
}

function overlayBar() {
  document.documentElement.classList.add('overlay');
  const bar = document.createElement('div');
  bar.id = 'ovbar';
  bar.innerHTML = '<span class="ovt">Drawing on screen</span><button data-a="done" class="go">Done · pin to board</button><button data-a="through">Click-through</button><button data-a="discard">Discard</button>';
  bar.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && window.ooDesk) window.ooDesk.overlay(b.dataset.a); });
  document.body.appendChild(bar);
  if (window.ooDesk) {
    window.ooDesk.onMode((mode) => {
      bar.classList.toggle('through', mode === 'through');
      bar.querySelector('.ovt').textContent = mode === 'through' ? 'Click-through · Ctrl+Shift+D to draw' : 'Drawing on screen';
    });
  }
}

// the desktop app calls this before it closes the overlay
window.ooOverlayFinish = async ({ discard, shot, name } = {}) => {
  clearTimeout(syncTimer);
  const all = api.getSceneElementsIncludingDeleted();
  if (discard) {
    api.updateScene({
      elements: all.map((e) => (mine.has(e.id) && !e.isDeleted
        ? { ...e, isDeleted: true, version: e.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 31), updated: Date.now() } : e)),
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  } else if (shot) {
    // the screenshot goes underneath (first in the scene), the label above the region
    const fileId = `shot-${Date.now().toString(36)}`;
    api.addFiles([{ id: fileId, mimeType: 'image/jpeg', dataURL: shot, created: Date.now() }]);
    const [img, label] = convertToExcalidrawElements([
      { type: 'image', x: OVERLAY.x, y: OVERLAY.y, width: OVERLAY.w, height: OVERLAY.h, fileId, locked: true, status: 'saved' },
      { type: 'text', x: OVERLAY.x, y: OVERLAY.y - 44, text: name || 'Screen', fontSize: 24, strokeColor: '#868e96' },
    ]);
    api.updateScene({ elements: [img, ...all, label], captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  }
  await new Promise((r) => setTimeout(r, 60)); // let Excalidraw settle the new order
  await sync();
  return true;
};

// ---------- the board window: put a pinned screenshot's region back on the screen ----------

let showBtn = null;
function watchSelection(elements, appState) {
  if (!window.ooDesk) return;
  const ids = Object.keys(appState.selectedElementIds || {}).filter((k) => appState.selectedElementIds[k]);
  const img = ids.length === 1 ? elements.find((e) => e.id === ids[0] && e.type === 'image' && !e.isDeleted) : null;
  if (!showBtn) {
    showBtn = document.createElement('button');
    showBtn.id = 'showbtn';
    showBtn.textContent = 'Show on screen';
    showBtn.title = 'Put this screenshot’s marks back over your screen';
    document.body.appendChild(showBtn);
    showBtn.addEventListener('click', () => {
      const e = showBtn.target;
      if (e) window.ooDesk.showOnScreen({ x: e.x, y: e.y, w: e.width, h: e.height, hide: e.id });
    });
  }
  showBtn.target = img;
  showBtn.style.display = img ? 'block' : 'none';
}

if (OVERLAY) overlayBar();
createRoot(document.getElementById('root')).render(h(App));
initial.then(listen).catch((e) => status(`Couldn't load the board: ${e.message}`, 0));
