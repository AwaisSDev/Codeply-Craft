// The drag + Shift wheel's and toast's bridge to the main process (convert-wheel.js).
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('cw', {
  // Where a dropped file is on disk ('' for one dragged out of a web page).
  pathFor: (file) => { try { return webUtils.getPathForFile(file) || ''; } catch { return ''; } },
  open: () => ipcRenderer.send('cw:open'),
  leave: () => ipcRenderer.send('cw:leave'),
  notFiles: () => ipcRenderer.send('cw:notFiles'),
  drop: (to, files) => ipcRenderer.send('cw:drop', { to, files }),
  reveal: (p) => ipcRenderer.send('cw:reveal', p),
  toastDone: () => ipcRenderer.send('cw:toastDone'),
  onArm: (cb) => ipcRenderer.on('cw:arm', (e, d) => cb(d)),
  onDisarm: (cb) => ipcRenderer.on('cw:disarm', () => cb()),
  onToast: (cb) => ipcRenderer.on('cw:toast', (e, d) => cb(d)),
});
