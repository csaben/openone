// The push-to-talk recorder window's link to the main process (see ui/recorder.js).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ooRec', {
  onStart: (fn) => ipcRenderer.on('rec:start', (_e, o) => fn(o || {})),
  onStop: (fn) => ipcRenderer.on('rec:stop', (_e, o) => fn(o || {})),
  started: () => ipcRenderer.send('rec:started'),
  data: (buf) => ipcRenderer.send('rec:data', buf),
  error: (msg) => ipcRenderer.send('rec:error', String(msg)),
});
