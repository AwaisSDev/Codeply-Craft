// The only bridge between the Crew window and the main process (crew/crew-main.js).
// Every channel is prefixed with "crew:" so it never collides with Craft's.
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const fn = (e, data) => cb(data);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
};

contextBridge.exposeInMainWorld('crew', {
  init: () => ipcRenderer.invoke('crew:app:init'),
  toCraft: () => ipcRenderer.send('crew:toCraft'),
  toDesign: () => ipcRenderer.send('crew:toDesign'),
  connections: () => ipcRenderer.invoke('crew:connections'),
  gmailPhone: () => ipcRenderer.invoke('crew:gmailPhone:get'),
  setGmailPhone: (on) => ipcRenderer.invoke('crew:gmailPhone:set', on),
  openConnect: () => ipcRenderer.send('crew:openConnect'),
  signIn: (email, password) => ipcRenderer.invoke('crew:auth:signIn', { email, password }),
  signOut: () => ipcRenderer.invoke('crew:auth:signOut'),
  selectModel: (id) => ipcRenderer.invoke('crew:models:select', id),
  setSettings: (patch) => ipcRenderer.invoke('crew:settings:set', patch),

  botsList: () => ipcRenderer.invoke('crew:bots:list'),
  botsCreate: (data) => ipcRenderer.invoke('crew:bots:create', data),
  botsFromTemplate: (key) => ipcRenderer.invoke('crew:bots:fromTemplate', key),
  botsUpdate: (id, patch) => ipcRenderer.invoke('crew:bots:update', id, patch),
  botsRemove: (id) => ipcRenderer.invoke('crew:bots:remove', id),
  botsForget: (id, i) => ipcRenderer.invoke('crew:bots:forget', id, i),
  botsClearMemory: (id) => ipcRenderer.invoke('crew:bots:clearMemory', id),
  botsForgetExperience: (id, kind, i) => ipcRenderer.invoke('crew:bots:forgetExperience', id, kind, i),
  botsDescribe: (text) => ipcRenderer.invoke('crew:bots:describe', text),

  thread: (botId) => ipcRenderer.invoke('crew:thread:get', botId),
  clearThread: (botId) => ipcRenderer.invoke('crew:thread:clear', botId),
  send: (botId, text) => ipcRenderer.invoke('crew:chat:send', { botId, text }),
  stop: (botId) => ipcRenderer.send('crew:chat:stop', botId),
  respond: (requestId, verdict) => ipcRenderer.send('crew:approval:respond', { requestId, verdict }),
  // What a chat may do without asking: a bot id, or "group:<id>".
  accessGet: (key) => ipcRenderer.invoke('crew:access:get', key),
  accessSet: (key, patch) => ipcRenderer.invoke('crew:access:set', key, patch),
  accessList: () => ipcRenderer.invoke('crew:access:list'),
  onEvent: on('crew:event'),

  groupsList: () => ipcRenderer.invoke('crew:groups:list'),
  groupsCreate: (data) => ipcRenderer.invoke('crew:groups:create', data),
  groupsUpdate: (id, patch) => ipcRenderer.invoke('crew:groups:update', id, patch),
  groupsRemove: (id) => ipcRenderer.invoke('crew:groups:remove', id),
  groupMessages: (id) => ipcRenderer.invoke('crew:groups:messages', id),
  groupClear: (id) => ipcRenderer.invoke('crew:groups:clear', id),
  groupSend: (groupId, text) => ipcRenderer.invoke('crew:groups:send', { groupId, text }),
  groupStop: (id) => ipcRenderer.send('crew:groups:stop', id),

  voicePrepare: () => ipcRenderer.invoke('crew:voice:prepare'),
  voiceVoices: () => ipcRenderer.invoke('crew:voice:voices'),
  stt: (pcm) => ipcRenderer.invoke('crew:voice:stt', pcm),
  tts: (botId, text) => ipcRenderer.invoke('crew:voice:tts', { botId, text }),
  voiceReply: (botId, turns) => ipcRenderer.invoke('crew:voice:reply', { botId, turns }),
  voiceCancel: (botId) => ipcRenderer.send('crew:voice:cancel', botId),
  voicePreview: (voiceId, botId, name) => ipcRenderer.invoke('crew:voice:preview', { voiceId, botId, name }),
  setDeepgramKey: (key) => ipcRenderer.invoke('crew:settings:deepgramKey', key),
  saveCall: (botId, ms, turns) => ipcRenderer.invoke('crew:call:save', { botId, ms, turns }),

  // Life (life-desktop.js, bots-mail.js, autopilot.js)
  lifeState: () => ipcRenderer.invoke('crew:life:state'),
  lifeSet: (patch) => ipcRenderer.invoke('crew:life:set', patch),
  lifeSearch: (q) => ipcRenderer.invoke('crew:life:search', q),
  lifeForgetSource: (key) => ipcRenderer.invoke('crew:life:forgetSource', key),
  lifeForgetItem: (id) => ipcRenderer.invoke('crew:life:forgetItem', id),
  lifeClear: () => ipcRenderer.invoke('crew:life:clear'),
  lifeNudge: (id, verdict) => ipcRenderer.invoke('crew:life:nudge', id, verdict),
  lifeStopAll: () => ipcRenderer.invoke('crew:life:stopAll'),
  lifeOutbox: (id, action) => ipcRenderer.invoke('crew:life:outbox', id, action),
  lifeTask: (id, action) => ipcRenderer.invoke('crew:life:task', id, action),
  lifeListenNow: () => ipcRenderer.invoke('crew:life:listenNow'),
  lifeCallShow: () => ipcRenderer.invoke('crew:life:callShow'),
  lifeCallStop: () => ipcRenderer.invoke('crew:life:callStop'),
  // Brain (brain-desktop.js): the shared personal context and the handoff board
  brainState: () => ipcRenderer.invoke('crew:brain:state'),
  brainEnable: (on) => ipcRenderer.invoke('crew:brain:enable', on),
  brainAdd: (o) => ipcRenderer.invoke('crew:brain:add', o),
  brainCorrect: (id, patch) => ipcRenderer.invoke('crew:brain:correct', id, patch),
  brainConfirm: (id) => ipcRenderer.invoke('crew:brain:confirm', id),
  brainResolve: (id, choice) => ipcRenderer.invoke('crew:brain:resolve', id, choice),
  brainForget: (id) => ipcRenderer.invoke('crew:brain:forget', id),
  brainClear: (scope) => ipcRenderer.invoke('crew:brain:clear', scope),
  brainHandles: (botId, handles) => ipcRenderer.invoke('crew:brain:handles', botId, handles),
  botMailClaim: (botId, local) => ipcRenderer.invoke('crew:botmail:claim', botId, local),
  botMailRelease: (botId) => ipcRenderer.invoke('crew:botmail:release', botId),
  botMailReply: (id) => ipcRenderer.invoke('crew:botmail:reply', id),

  openExternal: (url) => ipcRenderer.invoke('crew:shell:open', url),
  openFolder: (p) => ipcRenderer.invoke('crew:shell:openPath', p),
  minimize: () => ipcRenderer.send('crew:win:minimize'),
  maximize: () => ipcRenderer.send('crew:win:maximize'),
  close: () => ipcRenderer.send('crew:win:close'),
  onWinState: on('crew:win:state'),
});
