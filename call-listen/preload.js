// The call helper window's only bridge to the main process (call-listen.js).
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => { const fn = (e, d) => cb(d); ipcRenderer.on(channel, fn); return () => ipcRenderer.removeListener(channel, fn); };

contextBridge.exposeInMainWorld('callhelp', {
  state: () => ipcRenderer.invoke('callhelp:state'),
  start: () => ipcRenderer.invoke('callhelp:start'),
  stop: () => ipcRenderer.invoke('callhelp:stop'),
  consent: (on) => ipcRenderer.invoke('callhelp:consent', on),
  dismiss: () => ipcRenderer.invoke('callhelp:dismiss'),
  handover: () => ipcRenderer.invoke('callhelp:handover'),
  takeover: () => ipcRenderer.invoke('callhelp:takeover'),
  notNow: () => ipcRenderer.invoke('callhelp:notNow'),
  endCall: () => ipcRenderer.invoke('callhelp:endCall'),
  settings: (patch) => ipcRenderer.invoke('callhelp:settings', patch),
  chunk: (who, pcm) => ipcRenderer.send('callhelp:chunk', { who, pcm }),
  devices: (d) => ipcRenderer.send('callhelp:devices', d),
  close: () => ipcRenderer.send('callhelp:close'),
  onState: on('callhelp:state'),
  onListen: on('callhelp:listen'),
  onAudio: on('callhelp:audio'),
});
