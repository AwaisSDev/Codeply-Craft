const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('craft', {
  // window chrome
  minimize: () => ipcRenderer.send('win:minimize'),
  maximize: () => ipcRenderer.send('win:maximize'),
  close: () => ipcRenderer.send('win:close'),
  getWinState: () => ipcRenderer.invoke('win:getState'),
  onWinState: (cb) => ipcRenderer.on('win:state', (e, data) => cb(data)),

  // app bootstrap
  init: () => ipcRenderer.invoke('app:init'),

  // auth
  signInEmail: (email, password) => ipcRenderer.invoke('auth:signInEmail', { email, password }),
  signUpEmail: (email, password, name) => ipcRenderer.invoke('auth:signUpEmail', { email, password, name }),
  verifyOtp: (email, token, mode) => ipcRenderer.invoke('auth:verifyOtp', { email, token, mode }),
  resendOtp: (email, mode) => ipcRenderer.invoke('auth:resendOtp', { email, mode }),
  signInGoogle: () => ipcRenderer.invoke('auth:signInGoogle'),
  onAuthCallback: (cb) => ipcRenderer.on('auth:callback', (e, data) => cb(data)),
  logout: () => ipcRenderer.invoke('auth:logout'),

  // onboarding survey (referral source + country) - same profiles row the
  // Codeply desktop app writes to
  getProfile: () => ipcRenderer.invoke('profile:get'),
  saveOnboarding: (referralSource, country) => ipcRenderer.invoke('profile:saveOnboarding', { referralSource, country }),

  // models - "Auto" (hosted) or the user's own models. Keys stay in
  // ~/.codeply/config.json in the main process; the renderer only ever sees
  // a masked preview.
  listModels: () => ipcRenderer.invoke('models:list'),
  selectModel: (id) => ipcRenderer.invoke('models:select', id),
  saveModel: (input) => ipcRenderer.invoke('models:save', input),
  deleteModel: (id) => ipcRenderer.invoke('models:delete', id),
  detectOllama: (host) => ipcRenderer.invoke('models:detectOllama', host),
  onModelsChanged: (cb) => ipcRenderer.on('models:changed', (e, data) => cb(data)),

  // skills
  listSkills: () => ipcRenderer.invoke('skills:list'),

  // projects
  chooseProject: () => ipcRenderer.invoke('project:choose'),
  useProject: (p) => ipcRenderer.invoke('project:use', p),
  // List-only: forgets the folder, never deletes it.
  removeProject: (p) => ipcRenderer.invoke('project:remove', p),

  // sessions - chat history lives in Supabase (chat_sessions table), not
  // just the local cache file; refreshSessions() re-pulls it for whoever is
  // signed in right now (called after login, since app:init only runs once
  // at boot and won't otherwise notice an account switch mid-session).
  getSession: (id) => ipcRenderer.invoke('session:get', id),
  deleteSession: (id) => ipcRenderer.invoke('session:delete', id),
  renameSession: (id, title) => ipcRenderer.invoke('session:rename', { id, title }),
  refreshSessions: () => ipcRenderer.invoke('sessions:refresh'),
  listSessions: () => ipcRenderer.invoke('sessions:list'),

  // agent
  send: (payload) => ipcRenderer.invoke('chat:send', payload),
  // which chats have a run in flight, pushed whenever that changes
  onRunsStatus: (cb) => ipcRenderer.on('runs:status', (e, data) => cb(data)),
  remoteInfo: () => ipcRenderer.invoke('remote:info'),
  // auto-update
  getUpdateState: () => ipcRenderer.invoke('update:get'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  retryUpdate: () => ipcRenderer.invoke('update:retry'),
  onUpdateState: (cb) => ipcRenderer.on('update:state', (e, data) => cb(data)),
  setKeepAwake: (on) => ipcRenderer.invoke('remote:setKeepAwake', !!on),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  onRemoteServerError: (cb) => ipcRenderer.on('remote:server-error', (e, data) => cb(data)),
  stop: (sessionId) => ipcRenderer.send('chat:stop', sessionId),
  respondApproval: (requestId, verdict) => ipcRenderer.send('approval:respond', { requestId, verdict }),
  onAgentEvent: (cb) => ipcRenderer.on('agent:event', (e, data) => cb(data)),

  // image picker
  searchImages: (query) => ipcRenderer.invoke('images:search', query),
  respondImagePick: (requestId, chosenUrl) => ipcRenderer.send('imagepick:respond', { requestId, chosenUrl }),

  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),

  // embedded browser panel (docked BrowserView the agent's browser_check drives)
  toggleBrowserPanel: () => ipcRenderer.send('browserpanel:toggle'),
  browserPanelBack: () => ipcRenderer.send('browserpanel:back'),
  browserPanelForward: () => ipcRenderer.send('browserpanel:forward'),
  browserPanelReload: () => ipcRenderer.send('browserpanel:reload'),
  browserPanelNavigate: (url) => ipcRenderer.send('browserpanel:navigate', url),
  onBrowserPanelState: (cb) => ipcRenderer.on('browserpanel:state', (e, data) => cb(data)),
  onBrowserPanelUrl: (cb) => ipcRenderer.on('browserpanel:url', (e, data) => cb(data)),

  // embedded terminal - runs the user's own shell as a real child process
  terminalStart: (cwd) => ipcRenderer.invoke('terminal:start', cwd),
  terminalInput: (data) => ipcRenderer.send('terminal:input', data),
  terminalKill: () => ipcRenderer.send('terminal:kill'),
  onTerminalData: (cb) => ipcRenderer.on('terminal:data', (e, data) => cb(data)),
  onTerminalExit: (cb) => ipcRenderer.on('terminal:exit', (e, data) => cb(data)),

  // integrations (Gmail / Slack / Vercel / Supabase / GitHub) - real OAuth via the system browser
  integrationsStatus: () => ipcRenderer.invoke('integrations:status'),
  connectGmail: () => ipcRenderer.invoke('integrations:connectGmail'),
  connectSlack: () => ipcRenderer.invoke('integrations:connectSlack'),
  connectVercel: () => ipcRenderer.invoke('integrations:connectVercel'),
  connectSupabase: () => ipcRenderer.invoke('integrations:connectSupabase'),
  connectGithub: () => ipcRenderer.invoke('integrations:connectGithub'),
  disconnectIntegration: (name) => ipcRenderer.invoke('integrations:disconnect', name),
});
