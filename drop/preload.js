// The Alt+C drop's bridge to the main process (drop.js).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('drop', {
  state: () => ipcRenderer.invoke('drop:state'),
  session: (id) => ipcRenderer.invoke('drop:session', id),
  recent: (offset) => ipcRenderer.invoke('drop:recent', { offset }),
  showing: (id) => ipcRenderer.send('drop:showing', id),
  send: (payload) => ipcRenderer.invoke('drop:send', payload),
  stop: (id) => ipcRenderer.send('drop:stop', id),
  approve: (requestId, verdict) => ipcRenderer.send('drop:approve', { requestId, verdict }),
  answer: (requestId, answer) => ipcRenderer.send('drop:answer', { requestId, answer }),
  undo: (sessionId, checkpointId, undo) => ipcRenderer.invoke('drop:undo', { sessionId, checkpointId, undo }),
  useProject: (p) => ipcRenderer.invoke('drop:useProject', p),
  chooseProject: () => ipcRenderer.invoke('drop:chooseProject'),
  selectModel: (id) => ipcRenderer.invoke('drop:selectModel', id),
  openInCraft: (id) => ipcRenderer.send('drop:openInCraft', id),
  hide: () => ipcRenderer.send('drop:hide'),
  fit: (height) => ipcRenderer.send('drop:fit', height),
  onEvent: (cb) => ipcRenderer.on('drop:event', (e, d) => cb(d)),
  onRuns: (cb) => ipcRenderer.on('drop:runs', (e, d) => cb(d)),
  onShown: (cb) => ipcRenderer.on('drop:shown', (e, d) => cb(d)),
  onVoiceText: (cb) => ipcRenderer.on('drop:voiceText', (e, d) => cb(d)),
});
