// The converter's hidden page (render.html): it gets a job, draws, and replies.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('render', {
  onJob: (cb) => ipcRenderer.on('render:job', (e, job) => cb(job)),
  reply: (msg) => ipcRenderer.send('render:reply', msg),
});
