// The Design tab's bridge to the main process (design/design-main.js).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('design', {
  list: () => ipcRenderer.invoke('design:list'),
  // opts: { category, from } (from: a design to use as the reference)
  create: (text, kind, images, opts = {}) => ipcRenderer.invoke('design:create', { text, kind, images, category: opts.category || null, from: opts.from || null }),
  catCreate: (name) => ipcRenderer.invoke('design:catCreate', name),
  catRename: (id, name) => ipcRenderer.invoke('design:catRename', { id, name }),
  catDelete: (id) => ipcRenderer.invoke('design:catDelete', id),
  move: (id, category) => ipcRenderer.invoke('design:move', { id, category }),
  send: (id, text, images) => ipcRenderer.invoke('design:send', { id, text, images }),
  open: (id) => ipcRenderer.invoke('design:open', id),
  close: () => ipcRenderer.send('design:close'),
  stop: (id) => ipcRenderer.send('design:stop', id),
  approve: (requestId, verdict) => ipcRenderer.send('design:approve', { requestId, verdict }),
  answer: (requestId, answer) => ipcRenderer.send('design:answer', { requestId, answer }),
  rename: (id, title) => ipcRenderer.invoke('design:rename', { id, title }),
  remove: (id) => ipcRenderer.invoke('design:delete', id),
  reveal: (id) => ipcRenderer.send('design:reveal', id),
  openFile: (id) => ipcRenderer.send('design:openFile', id),
  openFolder: () => ipcRenderer.send('design:openFolder'),
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
