const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('oo', {
  on: (channel, fn) => {
    if (['state', 'peek', 'collapse', 'expand', 'toast'].includes(channel)) {
      ipcRenderer.on(channel, (_e, data) => fn(data));
    }
  },
  ignore: (v) => ipcRenderer.send('ui:ignore', v),
  size: (s) => ipcRenderer.send('ui:size', s),
  focus: () => ipcRenderer.send('ui:focus'),
  menu: () => ipcRenderer.send('ui:menu'),
  mute: () => ipcRenderer.send('ui:mute'),
  ready: () => ipcRenderer.send('ui:ready'),
  jump: (key) => ipcRenderer.invoke('pane:jump', key),
  answer: (key, n) => ipcRenderer.invoke('pane:answer', key, n),
  reply: (key, text) => ipcRenderer.invoke('pane:reply', key, text),
  seen: (key) => ipcRenderer.send('pane:seen', key),
});
