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
  answerAsk: (id, option) => ipcRenderer.invoke('ask:answer', id, option),
  seen: (key) => ipcRenderer.send('pane:seen', key),
  projects: () => ipcRenderer.invoke('project:list'),
  semantic: (q) => ipcRenderer.invoke('project:semantic', q),
  startProject: (opts) => ipcRenderer.invoke('project:start', opts),
  code: (target) => ipcRenderer.invoke('project:code', target),
  saved: () => ipcRenderer.invoke('saved:open'),
  learnShot: () => ipcRenderer.invoke('learn:shot'),
  learn: (m) => ipcRenderer.invoke('learn:send', m),
  // push-to-talk settings (main.js "voice")
  voiceSet: (patch) => ipcRenderer.invoke('voice:set', patch),
  voiceCapture: () => ipcRenderer.invoke('voice:capture'),
  voiceCancel: () => ipcRenderer.invoke('voice:cancel'),
});
