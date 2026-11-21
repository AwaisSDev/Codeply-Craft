// The top bar's bridge to the main process (island.js). The page only ever sees
// islandApi: on(type, fn) for what main sends, send(type, data) for the rest, so
// the same page also runs in a plain browser with a stand-in islandApi.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('islandApi', {
  on: (type, fn) => ipcRenderer.on('island:to', (e, m) => { if (m && m.type === type) fn(m.data); }),
  send: (type, data) => ipcRenderer.send('island:from', { type, data: data || {} }),
});
