// What the whiteboard page (served by the openone server) may ask of the desktop app:
// the overlay's buttons, and putting a pinned screenshot's region back on the screen.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ooDesk', {
  // 'done' | 'discard' | 'through' (keep the marks on screen, let the mouse through)
  overlay: (action) => ipcRenderer.invoke('board:overlay', String(action)),
  // { x, y, w, h, hide } in board coordinates: open the overlay showing that region
  showOnScreen: (region) => ipcRenderer.invoke('board:show-on-screen', region),
  onMode: (fn) => ipcRenderer.on('board:mode', (_e, mode) => fn(mode)),
});
