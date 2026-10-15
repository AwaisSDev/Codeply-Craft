// The voice overlay's bridge to voice-mode.js.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('voice', {
  on: (cb) => ipcRenderer.on('voice:cmd', (e, m) => cb(m)),
  send: (type, data) => ipcRenderer.send('voice:from', { type, ...(data || {}) }),
});
