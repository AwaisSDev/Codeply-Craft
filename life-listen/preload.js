// The background listener's only bridge to the main process (life-listen.js).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lifelisten', {
  chunk: (pcm) => ipcRenderer.send('lifelisten:chunk', pcm),
  status: (s) => ipcRenderer.send('lifelisten:status', s),
});
