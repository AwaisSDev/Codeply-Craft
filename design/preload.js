// The Design tab's bridge to the main process (design/design-main.js).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('design', {
  list: () => ipcRenderer.invoke('design:list'),
  create: (text, kind) => ipcRenderer.invoke('design:create', { text, kind }),
  send: (id, text) => ipcRenderer.invoke('design:send', { id, text }),
  open: (id) => ipcRenderer.invoke('design:open', id),
  close: () => ipcRenderer.send('design:close'),
  stop: (id) => ipcRenderer.send('design:stop', id),
  approve: (requestId, verdict) => ipcRenderer.send('design:approve', { requestId, verdict }),
  answer: (requestId, answer) => ipcRenderer.send('design:answer', { requestId, answer }),
  rename: (id, title) => ipcRenderer.invoke('design:rename', { id, title }),
  remove: (id) => ipcRenderer.invoke('design:delete', id),
  reveal: (id) => ipcRenderer.send('design:reveal', id),
  exportAs: (id, format) => ipcRenderer.invoke('design:export', { id, format }),
  build: (id) => ipcRenderer.invoke('design:build', id),
  toCraft: () => ipcRenderer.send('design:toCraft'),
  toCrew: () => ipcRenderer.send('design:toCrew'),
  onEvent: (cb) => ipcRenderer.on('design:event', (e, d) => cb(d)),
  onRuns: (cb) => ipcRenderer.on('design:runs', (e, d) => cb(d)),
  onChanged: (cb) => ipcRenderer.on('design:changed', (e, d) => cb(d)),
  onShown: (cb) => ipcRenderer.on('design:shown', (e, d) => cb(d)),
  onSynced: (cb) => ipcRenderer.on('design:synced', (e, d) => cb(d)),
});
