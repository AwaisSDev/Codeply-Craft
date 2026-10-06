const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('craft', {
  // Codeply Crew (your bots) opens in its own window with the Crew logo.
  openCrew: () => ipcRenderer.invoke('crew:open'),
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
  chatgptStatus: (opts) => ipcRenderer.invoke('chatgpt:status', opts),
  chatgptSignIn: () => ipcRenderer.invoke('chatgpt:signIn'),
  chatgptSignOut: () => ipcRenderer.invoke('chatgpt:signOut'),

  // Research Mode (local Ollama / Ollama Cloud); the key is only ever returned masked
  researchGet: () => ipcRenderer.invoke('research:get'),
  researchSave: (patch) => ipcRenderer.invoke('research:save', patch),
  researchStatus: () => ipcRenderer.invoke('research:status'),
  researchTest: () => ipcRenderer.invoke('research:test'),
  onResearchToken: (cb) => ipcRenderer.on('research:token', (e, t) => cb(t)),

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
  searchSessions: (query) => ipcRenderer.invoke('sessions:search', query),
  shareSession: (id, kind, thinking) => ipcRenderer.invoke('session:share', { id, kind, thinking }),

  // agent
  send: (payload) => ipcRenderer.invoke('chat:send', payload),
  // Bots (bots-desktop.js)
  botsList: () => ipcRenderer.invoke('bots:list'),
  botsCreate: (data) => ipcRenderer.invoke('bots:create', data),
  botsFromTemplate: (key) => ipcRenderer.invoke('bots:fromTemplate', key),
  botsUpdate: (id, patch) => ipcRenderer.invoke('bots:update', id, patch),
  botsRemove: (id) => ipcRenderer.invoke('bots:remove', id),
  botsForget: (id, index) => ipcRenderer.invoke('bots:forget', id, index),
  botsClearMemory: (id) => ipcRenderer.invoke('bots:clearMemory', id),
  botsForgetExperience: (id, kind, index) => ipcRenderer.invoke('bots:forgetExperience', id, kind, index),
  botsDescribe: (text) => ipcRenderer.invoke('bots:describe', text),
  // Craft Cloud (cloud-desktop.js)
  cloudState: (cwd) => ipcRenderer.invoke('cloud:state', cwd),
  cloudSetup: (cwd, opts) => ipcRenderer.invoke('cloud:setup', cwd, opts),
  cloudEnv: (cwd, envText) => ipcRenderer.invoke('cloud:env', cwd, envText),
  cloudCheckBehind: (cwd) => ipcRenderer.invoke('cloud:checkBehind', cwd),
  cloudPull: (cwd, sessionId, taskId) => ipcRenderer.invoke('cloud:pull', cwd, sessionId, taskId),
  cloudOptions: (cwd, opts) => ipcRenderer.invoke('cloud:options', cwd, opts),
  cloudApply: (sessionId, taskId) => ipcRenderer.invoke('cloud:apply', sessionId, taskId),
  cloudApplyTask: (cwd, taskId) => ipcRenderer.invoke('cloud:applyTask', cwd, taskId),
  cloudCancel: (sessionId, taskId) => ipcRenderer.invoke('cloud:cancel', sessionId, taskId),
  cloudBackupNow: (cwd) => ipcRenderer.invoke('cloud:backupNow', cwd),
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
  // custom slash commands (.codeply/commands/*.md) for a project
  listCommands: (cwd) => ipcRenderer.invoke('commands:list', cwd),
  listPlugins: (cwd) => ipcRenderer.invoke('plugins:list', cwd),
  preparePlugin: (source) => ipcRenderer.invoke('plugins:prepare', { source }),
  prepareUpdatePlugin: (name, cwd) => ipcRenderer.invoke('plugins:prepareUpdate', { name, cwd }),
  finishPlugin: (token, scope, cwd) => ipcRenderer.invoke('plugins:finish', { token, scope, cwd }),
  cancelPlugin: (token) => ipcRenderer.invoke('plugins:cancel', { token }),
  removePlugin: (name, cwd) => ipcRenderer.invoke('plugins:remove', { name, cwd }),
  togglePlugin: (name, enabled, cwd) => ipcRenderer.invoke('plugins:toggle', { name, enabled, cwd }),
  // answer an ask_user question (null = let the agent decide)
  respondQuestion: (requestId, answer) => ipcRenderer.send('question:respond', { requestId, answer }),
  // undo (true) or redo (false) everything one message changed
  setCheckpoint: (sessionId, checkpointId, undo) => ipcRenderer.invoke('checkpoint:set', { sessionId, checkpointId, undo }),
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
  browserPanelViewport: (name) => ipcRenderer.send('browserpanel:viewport', name),
  onBrowserPanelViewport: (cb) => ipcRenderer.on('browserpanel:viewport', (e, data) => cb(data)),
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
