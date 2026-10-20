// The push-to-talk indicator's link to the main process (see ui/pill.js).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ooPill', {
  onState: (fn) => ipcRenderer.on('pill', (_e, s) => fn(s || {})),
  onLevel: (fn) => ipcRenderer.on('level', (_e, v) => fn(Number(v) || 0)),
});
