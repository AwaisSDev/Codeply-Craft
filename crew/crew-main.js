// Codeply Crew, inside Codeply Craft: the bots window.
//
// Crew used to be its own app. It now lives in Craft as a second window with
// its own logo (opened from Craft's sidebar), sharing Craft's engine
// (codeply-cli) and the same ~/.codeply folder: the same account, the same
// models and the same bots. Every IPC channel here is prefixed with "crew:"
// so nothing collides with Craft's own handlers.
//
// Each bot has one thread (like a messenger). A message runs the engine's
// agent as that bot, with its prompt, approval boundary and teammates. A call
// is a live voice conversation (voice.js): local speech-to-text, the model,
// and a natural voice back, all free.
const { app, BrowserWindow, ipcMain: rawIpc, shell, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');

// Every channel the Crew window uses gets a "crew:" prefix.
const ipcMain = {
  handle: (ch, fn) => rawIpc.handle(`crew:${ch}`, fn),
  on: (ch, fn) => rawIpc.on(`crew:${ch}`, fn),
};
let ENGINE = null; // Craft's codeply-cli folder, set by init()
// Crew's threads and settings stay where the standalone app kept them.
const CREW_DATA = path.join(app.getPath('appData'), 'Codeply Crew');
const voice = require('./voice');

let win = null;
let auth = null; let config = null; let ai = null; let bots = null; let history = null; let agentMod = null;

async function engine() {
  if (agentMod) return true;
  // Electron 29's Node has no global WebSocket; Supabase's client needs one.
  if (typeof globalThis.WebSocket === 'undefined') {
    try { globalThis.WebSocket = require(require.resolve('ws', { paths: [ENGINE] })); } catch {}
  }
  auth = require(path.join(ENGINE, 'lib', 'auth.js'));
  config = require(path.join(ENGINE, 'lib', 'config.js'));
  ai = require(path.join(ENGINE, 'lib', 'ai.js'));
  bots = require(path.join(ENGINE, 'lib', 'bots.js'));
  history = require(path.join(ENGINE, 'lib', 'history.js'));
  agentMod = await import(pathToFileURL(path.join(ENGINE, 'lib', 'agent.mjs')).href);
  return true;
}

// ─── Store ──────────────────────────────────────────────────────────────────
// One JSON file: a thread per bot, plus Crew's own settings (voices live here,
// not in the shared bot files, so Craft never sees fields it does not know).

let storePath = null;
let store = { threads: {}, groups: {}, settings: { voiceEngine: 'deepgram', voices: {} } };

function loadStore() {
  fs.mkdirSync(CREW_DATA, { recursive: true });
  storePath = path.join(CREW_DATA, 'crew-store.json');
  try {
    const raw = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    store = { ...store, ...raw, settings: { ...store.settings, ...(raw.settings || {}) } };
  } catch {}
  if (!store.settings.voicesV2) { if (store.settings.voiceEngine === 'edge') store.settings.voiceEngine = 'deepgram'; store.settings.voicesV2 = true; }
}
let saveTimer = null;
function saveStore() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const tmp = `${storePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(store));
      fs.renameSync(tmp, storePath);
    } catch (e) { console.warn('[store]', e.message); }
  }, 150);
}
function thread(botId) {
  if (!store.threads[botId]) store.threads[botId] = { messages: [], updatedAt: 0 };
  return store.threads[botId];
}
function push(botId, msg) {
  const t = thread(botId);
  t.messages.push({ at: Date.now(), ...msg });
  if (t.messages.length > 400) t.messages = t.messages.slice(-400);
  t.updatedAt = Date.now();
  saveStore();
}

// Bots work in their own folder unless the user points them somewhere else.
function workspace() {
  const dir = store.settings.workspace && fs.existsSync(store.settings.workspace)
    ? store.settings.workspace
    : path.join(os.homedir(), 'Codeply Crew');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── Window ─────────────────────────────────────────────────────────────────

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 840, minWidth: 860, minHeight: 600,
    show: false, frame: false, backgroundColor: '#0b0b0c',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    autoHideMenuBar: true,
    title: 'Codeply Crew',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.once('ready-to-show', () => win.show());
  win.setMenu(null);
  win.loadFile(path.join(__dirname, 'index.html'));
  win.on('closed', () => { win = null; });
  win.webContents.on('console-message', (e, level, message, line, src) => { if (level >= 2) console.log(`[renderer] ${message} (${src}:${line})`); });
  win.on('maximize', () => win.webContents.send('crew:win:state', { maximized: true }));
  win.on('unmaximize', () => win.webContents.send('crew:win:state', { maximized: false }));
  // The mic is only ever asked for by the call screen. (Craft shares this
  // session, so other permissions keep their default answer.)
  win.webContents.session.setPermissionRequestHandler((wc, permission, cb) => cb(permission === 'media' || permission === 'clipboard-sanitized-write' || permission === 'notifications'));
}

const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };

ipcMain.on('win:minimize', () => win && win.minimize());
ipcMain.on('win:maximize', () => win && (win.isMaximized() ? win.unmaximize() : win.maximize()));
ipcMain.on('win:close', () => win && win.close());
ipcMain.handle('shell:open', (e, url) => { if (/^https?:\/\//.test(String(url))) shell.openExternal(url); });
ipcMain.handle('shell:openPath', (e, p) => shell.openPath(p || workspace()));

// ─── Account and models (shared with Craft through ~/.codeply) ──────────────

function routeNow() {
  const m = config.getSelectedModel();
  return m ? { custom: m } : { auto: true };
}
function modelsState() {
  return {
    selected: config.getSelectedModelId(),
    models: config.getModels().map((m) => ({ id: m.id, name: m.name || m.model, kind: m.kind })),
  };
}
async function signedInUser() {
  try { const s = await auth.getSession(); return s ? { email: s.user.email } : null; } catch { return null; }
}

function guard(fn) {
  return async (...args) => {
    try { await engine(); return await fn(...args); } catch (e) { console.warn('[ipc]', e); return { error: e.message }; }
  };
}

ipcMain.handle('app:init', guard(async () => ({
  openBot: takePendingBot(),
  user: await signedInUser(),
  models: modelsState(),
  catalog: catalog(),
  threads: Object.fromEntries(Object.entries(store.threads).map(([id, t]) => [id, { updatedAt: t.updatedAt, last: lastLine(t) }])),
  groups: groupsList(),
  settings: publicSettings(),
  workspace: workspace(),
})));

ipcMain.handle('auth:signIn', guard(async (e, { email, password }) => {
  const { error } = await auth.getClient().auth.signInWithPassword({ email: String(email || '').trim(), password: String(password || '') });
  if (error) return { error: /invalid/i.test(error.message) ? 'Incorrect email or password.' : error.message };
  return { user: await signedInUser() };
}));
ipcMain.handle('auth:signOut', guard(async () => { await auth.getClient().auth.signOut(); return { ok: true }; }));
ipcMain.handle('models:select', guard((e, id) => {
  const r = config.selectModel(id || config.AUTO_MODEL_ID);
  return r.ok ? modelsState() : r;
}));
// The user's Deepgram key, encrypted with Windows' own data protection
// (safeStorage). It never goes to the window: the window only learns whether
// one is saved.
function deepgramKey() {
  const enc = store.settings.deepgramKeyEnc;
  if (!enc) return '';
  try { return safeStorage.decryptString(Buffer.from(enc, 'base64')); } catch { return ''; }
}
function publicSettings() {
  const { deepgramKeyEnc, ...rest } = store.settings;
  return { ...rest, hasDeepgramKey: !!deepgramKeyEnc };
}
/** The signed-in session's token, for Codeply's voice server. */
async function serverToken() {
  try { await engine(); const s = await auth.getSession(); return s ? s.access_token : ''; } catch { return ''; }
}
const voiceOpts = (botId, voiceId) => ({ engine: store.settings.voiceEngine, voice: voiceId, botId, deepgramKey: deepgramKey(), serverToken });

ipcMain.handle('settings:set', guard((e, patch) => {
  const p = patch || {};
  if (['deepgram', 'edge', 'kokoro'].includes(p.voiceEngine)) store.settings.voiceEngine = p.voiceEngine;
  if (p.voice && typeof p.voice.botId === 'string') store.settings.voices[p.voice.botId] = String(p.voice.id || '');
  saveStore();
  return publicSettings();
}));
ipcMain.handle('settings:deepgramKey', guard(async (e, key) => {
  key = String(key || '').trim();
  if (!key) {
    delete store.settings.deepgramKeyEnc;
    saveStore();
    return publicSettings();
  }
  if (!safeStorage.isEncryptionAvailable()) return { error: 'This PC cannot store the key securely.' };
  try { await voice.deepgramCheck(key); } catch (err) { return { error: err.message }; }
  store.settings.deepgramKeyEnc = safeStorage.encryptString(key).toString('base64');
  store.settings.voiceEngine = 'deepgram';
  saveStore();
  return publicSettings();
}));

// ─── Bots ───────────────────────────────────────────────────────────────────

function catalog() {
  return {
    bots: bots.listBots(),
    templates: bots.TEMPLATES,
    tones: bots.TONES,
    approvals: Object.fromEntries(Object.entries(bots.APPROVALS).map(([k, v]) => [k, v.label])),
    maxMemory: bots.MAX_MEMORY,
    watchSources: bots.WATCH_SOURCES, reach: bots.REACH,
  };
}
function lastLine(t) {
  const m = [...(t.messages || [])].reverse().find((x) => x.kind === 'user' || x.kind === 'assistant' || x.kind === 'call' || x.kind === 'mail');
  if (!m) return '';
  if (m.kind === 'call') return `Call, ${formatDuration(m.ms)}`;
  if (m.kind === 'mail') return String(m.text || '');
  return String(m.text || '').replace(/\s+/g, ' ').slice(0, 90);
}
function formatDuration(ms) {
  const s = Math.round((ms || 0) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

ipcMain.handle('bots:list', guard(() => catalog()));
ipcMain.handle('bots:create', guard((e, data) => ({ bot: bots.createBot(data), ...catalog() })));
ipcMain.handle('bots:fromTemplate', guard((e, key) => ({ bot: bots.createFromTemplate(key), ...catalog() })));
ipcMain.handle('bots:update', guard((e, id, patch) => { const r = { bot: bots.updateBot(id, patch), ...catalog() }; if (onChange) onChange(); return r; }));
ipcMain.handle('bots:remove', guard((e, id) => {
  bots.removeBot(id);
  delete store.threads[id];
  for (const g of Object.values(store.groups || {})) g.members = g.members.filter((x) => x !== id);
  saveStore();
  return { ...catalog(), groups: groupsList() };
}));
ipcMain.handle('bots:forget', guard((e, id, i) => ({ bot: bots.forget(id, Number(i)), ...catalog() })));
ipcMain.handle('bots:clearMemory', guard((e, id) => ({ bot: bots.clearMemory(id), ...catalog() })));
ipcMain.handle('bots:forgetExperience', guard((e, id, kind, i) => ({ bot: bots.forgetExperience(id, String(kind), Number(i)), ...catalog() })));
ipcMain.handle('bots:describe', guard(async (e, text) => {
  text = String(text || '').trim();
  if (text.length < 4) return { error: 'Say a few words about what the bot should do.' };
  const r = await ai.chatJson([{ role: 'user', content: bots.describePrompt(text) }], { route: routeNow() });
  if (!r.success) return { error: r.error || 'The model did not answer.' };
  return { draft: bots.fromDescription(r.json, text) };
}));

// ─── Chat ───────────────────────────────────────────────────────────────────

ipcMain.handle('thread:get', guard((e, botId) => thread(botId).messages));
ipcMain.handle('thread:clear', guard((e, botId) => { store.threads[botId] = { messages: [], updatedAt: Date.now() }; saveStore(); return { ok: true }; }));

const runs = new Map(); // botId -> AbortController
const approvals = new Map(); // requestId -> resolve

// verdict: 'once' | 'always' | 'draft' | 'reject', or { verdict, edits } when
// the user edited an email on the card (edits = { to, subject, body }).
ipcMain.on('approval:respond', (e, { requestId, verdict }) => {
  const r = approvals.get(requestId);
  if (!r) return;
  approvals.delete(requestId);
  const v = verdict && typeof verdict === 'object' ? verdict.verdict : verdict;
  const clean = v === 'once' || v === 'always' || v === 'draft' ? v : 'reject';
  const ed = verdict && typeof verdict === 'object' && verdict.edits && typeof verdict.edits === 'object' ? verdict.edits : null;
  const edits = ed && Object.fromEntries(['to', 'subject', 'body'].filter((k) => typeof ed[k] === 'string').map((k) => [k, ed[k].slice(0, 100000)]));
  r(edits && clean !== 'reject' ? { verdict: clean, edits } : clean);
});
ipcMain.on('chat:stop', (e, botId) => { const c = runs.get(botId); if (c) c.abort(); });

/**
 * The user's yes/no, asked in the chat. A bot's boundary can skip it.
 * `where` is a bot id (its own thread) or { groupId, botId } (a group chat).
 */
function approverFor(where, bot, signal) {
  const allowedAlways = new Set();
  const at = typeof where === 'string' ? { botId: where } : where;
  return async (req) => {
    if (signal.aborted) return 'reject';
    if (bot && !req.danger && req.tool !== 'fetch_image' && bots.canSkipApproval(bot, req.tool)) return 'once';
    if (allowedAlways.has(req.tool) && req.tool !== 'run') return 'once';
    const requestId = `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    send('crew:event', { ...at, type: 'approval', requestId, title: req.title, detail: String(req.detail || '').slice(0, 1600), danger: !!req.danger, tool: req.tool, draft: req.draft || null, draftOnly: !!req.draftOnly });
    const verdict = await new Promise((resolve) => {
      approvals.set(requestId, resolve);
      signal.addEventListener('abort', () => { if (approvals.delete(requestId)) resolve('reject'); }, { once: true });
    });
    send('crew:event', { ...at, type: 'approval_done', requestId, verdict: typeof verdict === 'object' ? verdict.verdict : verdict });
    if (verdict === 'always') allowedAlways.add(req.tool);
    return verdict;
  };
}

/** ask_bot for one run: a teammate works on just the task it was given. */
function makeAskBot(c) {
  return async ({ name, task, signal }) => bots.delegate({
    caller: c.caller, name, task, depth: c.depth, chain: c.chain, token: c.token, signal: signal || c.signal,
    runBot: async (target, sub) => {
      const card = bots.botCard(target);
      send('crew:event', { botId: c.botId, type: 'helper', bot: card, task: sub.task, working: true });
      const run = agentMod.runAgent({
        userMessage: sub.task, history: [], mode: 'Build', cwd: c.cwd, signal: c.signal, route: c.route, maxSteps: 30,
        approve: approverFor(c.botId, target, c.signal), botPrompt: sub.prompt,
        askBot: sub.depth < bots.MAX_DEPTH ? makeAskBot({ ...c, caller: target, depth: sub.depth, chain: sub.chain }) : undefined,
      });
      let reply = '';
      const steps = [];
      for await (const ev of run) {
        if (ev.type === 'text' && !ev.interim) reply += (reply ? '\n\n' : '') + ev.text;
        else if (ev.type === 'tool_end') { steps.push(bots.runStep(ev)); send('crew:event', { botId: c.botId, type: 'helper_step', bot: card, name: ev.name, label: toolLabel(ev), ok: !!ev.ok }); }
        else if (ev.type === 'error') throw new Error(ev.error || 'the run failed');
        else if (ev.type === 'aborted') throw new Error('Stopped.');
        else if (ev.type === 'done') break;
      }
      send('crew:event', { botId: c.botId, type: 'helper', bot: card, working: false });
      if (reply && !c.signal.aborted) reflect(target, { request: sub.task, steps, reply }, c.route);
      return reply;
    },
  });
}

function toolLabel(ev) {
  const a = ev.args || {};
  return String(ev.summary || a.path || a.command || a.query || a.pattern || a.url || '').slice(0, 140);
}

ipcMain.handle('chat:send', guard(async (e, { botId, text }) => {
  text = String(text || '').trim();
  if (!text) return { error: 'Write something first.' };
  const bot = bots.getBot(botId);
  if (!bot) return { error: 'That bot is gone.' };
  if (runs.has(botId)) return { error: `${bot.name} is still answering.` };
  const route = routeNow();
  if (route.auto && !(await signedInUser())) return { error: 'Sign in to use Auto, or pick one of your own models from the model menu.' };

  const t = thread(botId);
  const prior = history.buildHistory({ messages: t.messages });
  push(botId, { kind: 'user', text });
  const controller = new AbortController();
  runs.set(botId, controller);
  const { signal } = controller;
  const cwd = workspace();
  const token = `crew:${botId}:${Date.now().toString(36)}`;
  const team = bots.listBots();

  (async () => {
    let reply = '';
    const steps = []; // the run's tool calls, for the bot's reflection
    send('crew:event', { botId, type: 'start' });
    try {
      if (bots.globalLock.owner && bots.globalLock.owner !== token) send('crew:event', { botId, type: 'notice', text: 'Waiting for another bot to finish. Only one works at a time.' });
      await bots.globalLock.run(token, async () => {
        const run = agentMod.runAgent({
          userMessage: text, history: prior, mode: 'Build', cwd, signal, route, maxSteps: 40,
          approve: approverFor(botId, bot, signal),
          botPrompt: (native) => bots.buildBotPrompt(bot, { team, canDelegate: true, native, request: text }),
          askBot: makeAskBot({ botId, caller: bot, depth: 0, chain: [bot.id], token, signal, route, cwd }),
        });
        for await (const ev of run) {
          if (ev.type === 'text') {
            if (ev.interim) send('crew:event', { botId, type: 'thinking', text: ev.text });
            else { reply += (reply ? '\n\n' : '') + ev.text; push(botId, { kind: 'assistant', text: ev.text }); send('crew:event', { botId, type: 'text', text: ev.text }); }
          } else if (ev.type === 'reasoning') {
            send('crew:event', { botId, type: 'thinking', text: ev.text });
          } else if (ev.type === 'tool_start') {
            send('crew:event', { botId, type: 'tool_start', name: ev.name, label: toolLabel(ev) });
          } else if (ev.type === 'tool_end') {
            const row = { kind: 'tool', name: ev.name, label: toolLabel(ev), ok: !!ev.ok, error: ev.error };
            steps.push(bots.runStep(ev));
            if (ev.name === 'ask_bot' && ev.meta && ev.meta.delegation) row.delegation = ev.meta.delegation;
            push(botId, row);
            send('crew:event', { botId, type: 'tool', ...row });
          } else if (ev.type === 'notice') {
            send('crew:event', { botId, type: 'notice', text: ev.text });
          } else if (ev.type === 'error') {
            push(botId, { kind: 'error', text: ev.error });
            send('crew:event', { botId, type: 'error', text: ev.error });
          } else if (ev.type === 'aborted') {
            send('crew:event', { botId, type: 'notice', text: 'Stopped.' });
          } else if (ev.type === 'done') break;
        }
      }, signal);
    } catch (err) {
      if (!signal.aborted) { push(botId, { kind: 'error', text: err.message }); send('crew:event', { botId, type: 'error', text: err.message }); }
    } finally {
      runs.delete(botId);
      send('crew:event', { botId, type: 'done' });
      if (reply && !signal.aborted) { learn(bot, text, reply, route); reflect(bot, { request: text, steps, reply }, route); }
    }
  })();
  return { ok: true };
}));

/**
 * MUSE-style reflection after a run that used tools (bots.reflectOnRun), in
 * the background: the bot keeps lessons, playbooks, tool tips and open threads.
 */
function reflect(bot, run, route) {
  if (!bot || !run.steps || !run.steps.length) return;
  bots.reflectOnRun(bots.getBot(bot.id) || bot, run, (messages) => ai.chatJson(messages, { route }))
    .then((r) => { if (r && r.added) send('crew:event', { botId: bot.id, type: 'reflected', playbook: r.added.playbook, updated: r.added.updated, lessons: (r.added.lessons || []).length, catalog: catalog() }); })
    .catch(() => {});
}

function learn(bot, userText, replyText, route) {
  bots.learnFromTurn(bots.getBot(bot.id) || bot, userText, replyText, (messages) => ai.chatJson(messages, { route }))
    .then((r) => { if (r.added && r.added.length) send('crew:event', { botId: bot.id, type: 'learned', facts: r.added, catalog: catalog() }); })
    .catch(() => {});
}

// ─── Group chats ────────────────────────────────────────────────────────────
// A room with the user and two or more bots. A message goes to the bots it
// @mentions, or, if it names nobody, to the ones whose job fits (a quick model
// pick). Each bot answers in turn, one at a time, seeing the whole room. A bot
// that @mentions a teammate hands over to it, so the bots talk to each other.
// A message never sets off more than MAX_GROUP_TURNS bot replies.

const MAX_GROUP_TURNS = 6;

function groupCard(g) {
  return { id: g.id, name: g.name, members: g.members, updatedAt: g.updatedAt, createdAt: g.createdAt, last: groupLast(g) };
}
function groupLast(g) {
  const m = [...(g.messages || [])].reverse().find((x) => x.kind === 'user' || x.kind === 'assistant');
  if (!m) return '';
  const who = m.kind === 'user' ? 'You' : ((bots.getBot(m.botId) || {}).name || 'A bot');
  return `${who}: ${String(m.text || '').replace(/\s+/g, ' ')}`.slice(0, 90);
}
function groupsList() {
  return Object.values(store.groups || {}).map(groupCard);
}
function cleanMembers(list) {
  const known = new Set(bots.listBots().map((b) => b.id));
  return [...new Set((Array.isArray(list) ? list : []).filter((id) => known.has(id)))].slice(0, 8);
}
function groupPush(g, msg) {
  g.messages.push({ at: Date.now(), ...msg });
  if (g.messages.length > 600) g.messages = g.messages.slice(-600);
  g.updatedAt = Date.now();
  saveStore();
}

ipcMain.handle('groups:list', guard(() => groupsList()));
ipcMain.handle('groups:create', guard((e, { name, members } = {}) => {
  const m = cleanMembers(members);
  if (m.length < 2) return { error: 'Pick at least two bots.' };
  const id = `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const names = m.map((x) => bots.getBot(x).name);
  const g = { id, name: String(name || '').trim().slice(0, 40) || names.join(', ').slice(0, 40), members: m, messages: [], createdAt: Date.now(), updatedAt: Date.now() };
  if (!store.groups) store.groups = {};
  store.groups[id] = g;
  saveStore();
  return { group: groupCard(g), groups: groupsList() };
}));
ipcMain.handle('groups:update', guard((e, id, patch = {}) => {
  const g = store.groups && store.groups[id];
  if (!g) return { error: 'That group is gone.' };
  if (patch.name !== undefined) g.name = String(patch.name).trim().slice(0, 40) || g.name;
  if (patch.members !== undefined) {
    const m = cleanMembers(patch.members);
    if (m.length < 2) return { error: 'A group needs at least two bots.' };
    g.members = m;
  }
  g.updatedAt = Date.now();
  saveStore();
  return { group: groupCard(g), groups: groupsList() };
}));
ipcMain.handle('groups:remove', guard((e, id) => {
  if (runs.has(`g:${id}`)) return { error: 'The group is still talking. Stop it first.' };
  if (store.groups) delete store.groups[id];
  saveStore();
  return { groups: groupsList() };
}));
ipcMain.handle('groups:messages', guard((e, id) => (store.groups && store.groups[id] ? store.groups[id].messages : [])));
ipcMain.handle('groups:clear', guard((e, id) => {
  const g = store.groups && store.groups[id];
  if (!g) return { error: 'That group is gone.' };
  if (runs.has(`g:${id}`)) return { error: 'The group is still talking. Stop it first.' };
  g.messages = []; g.updatedAt = Date.now(); saveStore();
  return { ok: true };
}));
ipcMain.on('groups:stop', (e, id) => { const c = runs.get(`g:${id}`); if (c) c.abort(); });

const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The members a piece of text @mentions, in the order they appear. */
function mentionsIn(text, members, selfId) {
  const found = [];
  for (const b of members) {
    if (b.id === selfId) continue;
    const m = new RegExp(`@${escRe(b.name)}\\b`, 'i').exec(text);
    if (m) found.push({ id: b.id, at: m.index });
  }
  return found.sort((a, b) => a.at - b.at).map((x) => x.id);
}

/** Who answers the user's message: @mentions, @everyone, or a quick model pick. */
async function firstSpeakers(text, members, g, route) {
  if (/@(everyone|all|crew|team)\b/i.test(text)) return members.map((b) => b.id);
  const named = mentionsIn(text, members, null);
  if (named.length) return named;
  // A bot's plain name at the start ("Vera, can you...") counts too.
  const lead = members.find((b) => new RegExp(`^\\s*(hey\\s+|hi\\s+|ok\\s+)?${escRe(b.name)}\\b`, 'i').test(text));
  if (lead) return [lead.id];
  const recent = g.messages.slice(-8).filter((m) => m.kind === 'user' || m.kind === 'assistant')
    .map((m) => `${m.kind === 'user' ? 'User' : ((members.find((b) => b.id === m.botId) || {}).name || 'Bot')}: ${String(m.text).slice(0, 300)}`).join('\n');
  const prompt = `You route messages in a group chat between a user and their bots.\nBots:\n${members.map((b) => `- ${b.name}: ${b.specialty || 'general helper'}${b.role === 'orchestrator' ? ' (orchestrator, leads the team)' : ''}`).join('\n')}\n${recent ? `\nRecent chat:\n${recent}\n` : ''}\nNew message from the user: ${text}\n\nWhich bots should answer, in order? Pick only the ones whose job fits. A greeting or a question for the whole group can get two or three. Usually one is right. Reply with JSON only: {"speakers": ["Name", ...]}`;
  try {
    const r = await ai.chatJson([{ role: 'user', content: prompt }], { route });
    const names = r && r.success && r.json && Array.isArray(r.json.speakers) ? r.json.speakers : [];
    const ids = [...new Set(names.map((n) => (bots.findBot(n, members) || {}).id).filter(Boolean))].slice(0, 3);
    if (ids.length) return ids;
  } catch {}
  // No pick: the orchestrator if there is one, else whoever spoke last, else the first bot.
  const lead2 = members.find((b) => b.role === 'orchestrator');
  if (lead2) return [lead2.id];
  const lastBot = [...g.messages].reverse().find((m) => m.kind === 'assistant' && members.some((b) => b.id === m.botId));
  return [lastBot ? lastBot.botId : members[0].id];
}

function groupRules(bot, members) {
  const others = members.filter((b) => b.id !== bot.id);
  return `GROUP CHAT\nYou are in a group chat with the user and these teammates:\n${others.map((b) => `- ${b.name}: ${b.specialty || 'general helper'}`).join('\n')}\nMessages from others appear as "[Name]: text". The user's appear as "[User]: text".\n- Reply only as yourself, ${bot.name}. Never write lines for anyone else, and do not start with your own name.\n- Keep it short and conversational, like a chat message. Do not repeat what a teammate already said; add to it, agree briefly, or push back if they are wrong.\n- To hand something to a teammate, @mention them by name, for example "@${others[0] ? others[0].name : 'Name'} can you check this?". They answer right after you. Only mention someone when you really need them.\n- If nothing is left for you to add, say so in a few words.\n- You can still use your tools for real work when the user asks for it.`;
}

/** The room as this bot sees it: its own lines are "assistant", everything else "user". */
function groupHistoryFor(bot, g, members, upTo) {
  const nameOf = (id) => (members.find((b) => b.id === id) || bots.getBot(id) || {}).name || 'Bot';
  const turns = [];
  for (const m of g.messages.slice(0, upTo)) {
    let role; let content;
    if (m.kind === 'user') { role = 'user'; content = `[User]: ${m.text}`; }
    else if (m.kind === 'assistant' && m.botId === bot.id) { role = 'assistant'; content = m.text; }
    else if (m.kind === 'assistant') { role = 'user'; content = `[${nameOf(m.botId)}]: ${m.text}`; }
    else continue;
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content += `\n\n${content}`;
    else turns.push({ role, content });
  }
  return turns;
}

/** Drop a "Name:" or "[Name]:" the model put in front of its own reply. */
function stripSelfPrefix(text, bot) {
  return String(text || '').replace(new RegExp(`^\\s*\\[?${escRe(bot.name)}\\]?\\s*:\\s*`, 'i'), '');
}

ipcMain.handle('groups:send', guard(async (e, { groupId, text }) => {
  text = String(text || '').trim();
  const g = store.groups && store.groups[groupId];
  if (!text) return { error: 'Write something first.' };
  if (!g) return { error: 'That group is gone.' };
  const key = `g:${groupId}`;
  if (runs.has(key)) return { error: 'The group is still talking.' };
  const members = g.members.map((id) => bots.getBot(id)).filter(Boolean);
  if (members.length < 2) return { error: 'This group needs at least two bots. Add some in the group settings.' };
  const route = routeNow();
  if (route.auto && !(await signedInUser())) return { error: 'Sign in to use Auto, or pick one of your own models from the model menu.' };

  groupPush(g, { kind: 'user', text });
  const controller = new AbortController();
  runs.set(key, controller);
  const { signal } = controller;
  const cwd = workspace();
  const emit = (ev) => send('crew:event', { groupId, ...ev });

  (async () => {
    emit({ type: 'start' });
    let turnsLeft = MAX_GROUP_TURNS;
    try {
      const queue = await firstSpeakers(text, members, g, route);
      emit({ type: 'queue', botIds: queue });
      while (queue.length && turnsLeft > 0 && !signal.aborted) {
        const bot = bots.getBot(queue.shift());
        if (!bot) continue;
        turnsLeft--;
        // What happened since this bot last spoke is its new message.
        let lastOwn = -1;
        g.messages.forEach((m, i) => { if (m.kind === 'assistant' && m.botId === bot.id) lastOwn = i; });
        const history = groupHistoryFor(bot, g, members, lastOwn + 1);
        const fresh = g.messages.slice(lastOwn + 1).filter((m) => m.kind === 'user' || m.kind === 'assistant')
          .map((m) => (m.kind === 'user' ? `[User]: ${m.text}` : `[${(members.find((b) => b.id === m.botId) || {}).name || 'Bot'}]: ${m.text}`));
        const userMessage = `${fresh.join('\n\n')}\n\n(Your turn in the group, ${bot.name}.)`;
        const token = `crew:${key}:${bot.id}:${Date.now().toString(36)}`;
        if (bots.globalLock.owner && bots.globalLock.owner !== token) emit({ type: 'notice', botId: bot.id, text: 'Waiting for another bot to finish. Only one works at a time.' });
        emit({ type: 'turn', botId: bot.id });
        let reply = '';
        const steps = [];
        await bots.globalLock.run(token, async () => {
          const run = agentMod.runAgent({
            userMessage, history, mode: 'Build', cwd, signal, route, maxSteps: 30,
            approve: approverFor({ groupId, botId: bot.id }, bot, signal),
            botPrompt: () => `${bots.buildBotPrompt(bot, { team: members, request: text })}\n\n${groupRules(bot, members)}`,
          });
          for await (const ev of run) {
            if (ev.type === 'text') {
              if (ev.interim) emit({ type: 'thinking', botId: bot.id, text: ev.text });
              else {
                const t = stripSelfPrefix(ev.text, bot);
                if (!t.trim()) continue;
                reply += (reply ? '\n\n' : '') + t;
                groupPush(g, { kind: 'assistant', botId: bot.id, text: t });
                emit({ type: 'text', botId: bot.id, text: t });
              }
            } else if (ev.type === 'reasoning') {
              emit({ type: 'thinking', botId: bot.id, text: ev.text });
            } else if (ev.type === 'tool_start') {
              emit({ type: 'tool_start', botId: bot.id, name: ev.name, label: toolLabel(ev) });
            } else if (ev.type === 'tool_end') {
              const row = { kind: 'tool', botId: bot.id, name: ev.name, label: toolLabel(ev), ok: !!ev.ok, error: ev.error };
              steps.push(bots.runStep(ev));
              groupPush(g, row);
              emit({ type: 'tool', ...row });
            } else if (ev.type === 'error') {
              groupPush(g, { kind: 'error', botId: bot.id, text: ev.error });
              emit({ type: 'error', botId: bot.id, text: ev.error });
            } else if (ev.type === 'done' || ev.type === 'aborted') break;
          }
        }, signal);
        emit({ type: 'turn_done', botId: bot.id });
        if (reply && !signal.aborted) {
          learn(bot, text, reply, route);
          reflect(bot, { request: text, steps, reply }, route);
          for (const id of mentionsIn(reply, members, bot.id)) if (!queue.includes(id)) queue.push(id);
        }
      }
      if (queue.length && turnsLeft <= 0 && !signal.aborted) {
        emit({ type: 'notice', text: 'The crew paused here so they do not talk forever. Reply to keep going.' });
      }
    } catch (err) {
      if (!signal.aborted) { groupPush(g, { kind: 'error', text: err.message }); emit({ type: 'error', text: err.message }); }
    } finally {
      runs.delete(key);
      if (signal.aborted) emit({ type: 'notice', text: 'Stopped.' });
      emit({ type: 'done', last: groupLast(g) });
    }
  })();
  return { ok: true };
}));

// ─── Calls ──────────────────────────────────────────────────────────────────

// A call turn runs the bot's real agent (bots.voiceTurn): it keeps its tools,
// so "check my email" on a call checks it. It works in the same folder as the
// bot's chat, one bot at a time, and anything outside its approval boundary is
// asked on the call screen. Talking over the bot cancels the turn.
const callRuns = new Map(); // botId -> AbortController of the turn in progress

ipcMain.handle('voice:prepare', guard(async () => voice.prepare(store.settings.voiceEngine)));
ipcMain.handle('voice:stt', guard(async (e, pcm) => ({ text: await voice.transcribe(pcm) })));
/** The voice a bot speaks with: its own pick, else the one Crew saved before voices lived on the bot. */
function botVoice(botId) {
  const b = bots.getBot(botId);
  return (b && b.voice) || store.settings.voices[botId] || '';
}
ipcMain.handle('voice:tts', guard(async (e, { botId, text }) => {
  const r = await voice.speak(text, voiceOpts(botId, botVoice(botId)));
  return { mime: r.mime, data: r.data };
}));
// The editor's Preview button: a voice that is not saved yet.
ipcMain.handle('voice:preview', guard(async (e, { voiceId, botId, name }) => {
  const line = `Hi, I'm ${String(name || 'your new bot').slice(0, 40)}. This is how I sound on a call.`;
  const r = await voice.speak(line, voiceOpts(botId, voiceId));
  return { mime: r.mime, data: r.data };
}));
ipcMain.handle('voice:voices', guard(() => voice.voiceList()));
ipcMain.on('voice:cancel', (e, botId) => { const c = callRuns.get(botId); if (c) c.abort(); });
ipcMain.handle('voice:reply', guard(async (e, { botId, turns }) => {
  const bot = bots.getBot(botId);
  if (!bot) return { error: 'That bot is gone.' };
  const route = routeNow();
  if (route.auto && !(await signedInUser())) return { error: 'Sign in to use Auto, or pick one of your own models.' };
  const recentChat = thread(botId).messages.filter((m) => m.kind === 'user' || m.kind === 'assistant').slice(-6)
    .map((m) => `${m.kind === 'user' ? 'User' : bot.name}: ${String(m.text).slice(0, 400)}`).join('\n');
  if (callRuns.has(botId)) callRuns.get(botId).abort();
  const controller = new AbortController();
  callRuns.set(botId, controller);
  const { signal } = controller;
  const token = `call:${botId}:${Date.now().toString(36)}`;
  const at = { botId, call: true };
  try {
    const r = await bots.globalLock.run(token, () => bots.voiceTurn({
      bot, team: bots.listBots(), turns, recentChat, runAgent: agentMod.runAgent, route, cwd: workspace(), signal,
      approve: approverFor(at, bot, signal),
      onStep: (s) => send('crew:event', { ...at, type: 'call_step', name: s.name, label: bots.callStepLabel(s.name), done: !!s.done, ok: s.ok }),
    }), signal);
    // The work it did on the call (voiceTurn's tool steps) is something to learn from too.
    if (r.reply) reflect(bot, { request: r.request, steps: r.steps, reply: r.reply }, route);
    return { text: r.text };
  } catch (err) {
    if (signal.aborted) return { text: '', cancelled: true };
    return { error: err.message };
  } finally {
    if (callRuns.get(botId) === controller) callRuns.delete(botId);
  }
}));


ipcMain.handle('call:save', guard(async (e, { botId, ms, turns }) => {
  const bot = bots.getBot(botId);
  const list = (Array.isArray(turns) ? turns : []).filter((t) => t && t.text).map((t) => ({ who: t.who === 'bot' ? 'bot' : 'user', text: String(t.text).slice(0, 2000) }));
  push(botId, { kind: 'call', ms: Number(ms) || 0, turns: list });
  if (bot && list.some((t) => t.who === 'user')) {
    const userSide = list.filter((t) => t.who === 'user').map((t) => t.text).join('\n');
    const botSide = list.filter((t) => t.who === 'bot').map((t) => t.text).join('\n');
    learn(bot, `(on a voice call) ${userSide}`, botSide, routeNow());
  }
  return { ok: true };
}));

// ─── Always-on bots (Craft's bots-watch.js) ────────────────────────────────
// An always-on bot that found an important email says so in its own thread,
// with links to the email and to the draft it saved in Gmail.

let onChange = null;
let pendingBot = null;
function takePendingBot() { const id = pendingBot; pendingBot = null; return id; }

const gmailLink = (u) => (/^https:\/\/mail\.google\.com\//.test(String(u || '')) ? String(u) : '');
function addMail(engineDir, botId, ev) {
  init(engineDir);
  const msg = {
    kind: 'mail', text: String(ev.text || '').slice(0, 400), from: String(ev.fromName || '').slice(0, 120), fromEmail: String(ev.fromEmail || '').slice(0, 200),
    subject: String(ev.subject || '').slice(0, 300), summary: String(ev.summary || '').slice(0, 800), reply: String(ev.reply || '').slice(0, 8000),
    level: ev.level === 'very' ? 'very' : 'important', drafted: !!ev.draftId, gmailUrl: gmailLink(ev.gmailUrl), draftUrl: gmailLink(ev.draftUrl),
    cloud: !!ev.cloud, error: ev.error ? String(ev.error).slice(0, 300) : '',
  };
  push(botId, msg);
  send('crew:event', { botId, type: 'mail', msg: { at: Date.now(), ...msg } });
}

/** A notification was clicked: open Crew on that bot's thread. */
function showBot(engineDir, botId) {
  const ready = win && !win.isDestroyed();
  if (!ready) pendingBot = botId;
  open(engineDir);
  if (ready) send('crew:event', { botId, type: 'open' });
}

// ─── Lifecycle (called by Craft's main.js) ────────────────────────────────

let started = false;
/** Wire Crew to Craft's engine. Safe to call more than once. */
function init(engineDir) {
  if (started) return;
  started = true;
  ENGINE = engineDir;
  voice.init({ cacheDir: path.join(CREW_DATA, 'voice-models') });
  loadStore();
  engine().catch((e) => console.warn('[crew engine]', e.message));
  app.on('before-quit', () => {
    clearTimeout(saveTimer);
    try { if (storePath) fs.writeFileSync(storePath, JSON.stringify(store)); } catch {}
  });
}

/** Open the Crew window, or bring it to the front. */
function open(engineDir) {
  init(engineDir);
  if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); return; }
  createWindow();
  // Load the speech model a moment after the window opens so the first call can hear at once.
  setTimeout(() => { voice.prepare(store.settings.voiceEngine).catch((err) => console.warn('[voice] warm-up:', err.message)); }, 4000);
}

module.exports = { init, open, isOpen: () => !!(win && !win.isDestroyed()), addMail, showBot, setOnChange: (fn) => { onChange = fn; } };
