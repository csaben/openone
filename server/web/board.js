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
  api.updateScene({ elements: merged, captureUpdate: CaptureUpdateAction.NEVER });
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
  setTimeout(() => { for (const op of s.ops || []) drawOp(op); }, 500);
  // dark mode inverts the canvas, so a white background shows as near-black
  return { elements, files: s.files, appState: { theme: 'dark', viewBackgroundColor: '#ffffff' }, scrollToContent: true };
});

function App() {
  return h(Excalidraw, {
    initialData: initial,
    excalidrawAPI: (a) => { api = a; },
    onChange: () => scheduleSync(),
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

createRoot(document.getElementById('root')).render(h(App));
initial.then(listen).catch((e) => status(`Couldn't load the board: ${e.message}`, 0));
