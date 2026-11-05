// What the saved posts page (served by the openone server) may ask of the desktop app:
// pulling your newest X bookmarks and likes in (src/xsync.js).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ooSaved', {
  // n newest of each -> { bookmark: { added, total, seen }, like: {...} } or { error }
  sync: (n) => ipcRenderer.invoke('saved:sync', Number(n)),
  // your X API balance -> { total_balance, usdPerPost, ... } or { error }
  credits: () => ipcRenderer.invoke('saved:credits'),
});
