// Context intelligence in the desktop app (engine: codeply-cli/lib/context-*.js,
// local-runtime.js; design: LOCAL-INTELLIGENCE-ARCHITECTURE.md).
//
// What it does here, in the main process:
//   · opens the event queue (~/.codeply/context/context.db), with sensitive
//     text sealed under a key Windows / macOS protect (safeStorage), like Life
//   · builds the three backends: rules, the chat route (ai.chatJson with the
//     route the user chats on) and the local model (Codeply's llama-server
//     from local-runtime.js, or an OpenAI-compatible server the user points at)
//   · in any mode but legacy, the brain hands every finished exchange to the
//     engine (brain.setLearner), so Craft and Crew turns are extracted by the
//     backend the mode picks instead of the chat model in the same breath
//   · when the user allows it, Life items (heard, calls, Orbit, Gmail) become
//     events too, every 5 minutes, only for the Life sources that are on
//
// Settings: ~/.codeply/context/settings.json (see DEFAULT_SETTINGS); IPC:
// context:state, context:set, context:process, context:undo.
// Nothing changes for a user until they pick a mode: the default is legacy.
//
// main.js wires this in with init(deps); nothing here reaches into main.js.
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

let deps = null;
let store = null; let engine = null; let runtime = null; let lifeTimer = null;
let embedRuntime = null; let retriever = null;
const lib = (name) => require(path.join(deps.cliDir, 'lib', name));

const DIR = path.join(os.homedir(), '.codeply', 'context');
const SETTINGS_FILE = path.join(DIR, 'settings.json');
const KEY_FILE = path.join(DIR, 'key.bin');
const LIFE_EVERY_MS = 5 * 60000;

const DEFAULT_SETTINGS = {
  // legacy | cloud | auto | local | rules | off (context-model.js routeFor)
  mode: 'legacy',
  // A model from ~/.codeply/models (scripts/context/fetch-model.mjs); '' = the first one there.
  model: '',
  // Or a local OpenAI-compatible server the user already runs (Ollama: http://127.0.0.1:11434/v1).
  localUrl: '', localModel: '',
  threads: 0, ctx: 4096, idleMinutes: 5,
  minImportance: 0.35,
  // Life items into long-term memory: off until the user turns it on, then only these sources (and only while each is on in Life).
  life: { on: false, sources: ['heard', 'orbit', 'calls', 'gmail'] },
  // Meaning-based retrieval with a local embedding model (context-retrieval.js): off until turned on.
  embed: { on: false, model: 'nomic-embed-v1.5' },
  // Background work waits while the PC is on battery and in use (idle 2 minutes, or plugged in, and it runs).
  pauseOnBattery: true,
  // Iris counts (never text) sent once a day to help improve it: off until the user turns it on.
  shareCounts: false,
};
const IDLE_SECONDS = 120;
const COUNTS_EVERY_MS = 24 * 3600 * 1000;
let settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    settings = { ...DEFAULT_SETTINGS, ...raw, life: { ...DEFAULT_SETTINGS.life, ...(raw.life || {}) }, embed: { ...DEFAULT_SETTINGS.embed, ...(raw.embed || {}) } };
  } catch {}
}
function saveSettings() {
  try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); } catch (e) { console.warn('[context] settings:', e.message); }
}

function storeKey() {
  const { safeStorage } = deps;
  if (!safeStorage || !safeStorage.isEncryptionAvailable()) return null;
  try {
    if (fs.existsSync(KEY_FILE)) return Buffer.from(safeStorage.decryptString(fs.readFileSync(KEY_FILE)), 'base64');
  } catch (e) { console.warn('[context] the key could not be read; sensitive events are not kept on disk:', e.message); return null; }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(KEY_FILE, safeStorage.encryptString(key.toString('base64')));
  return key;
}

// ─── Backends ───────────────────────────────────────────────────────────────

function routeIsLocal() {
  try {
    const r = deps.currentRoute();
    const u = r && r.custom && r.custom.baseUrl;
    return !!u && lib('context-model.js').isLocalUrl(u);
  } catch { return false; }
}

function buildLocal() {
  const M = lib('context-model.js');
  const RT = lib('local-runtime.js');
  if (runtime) { runtime.stop(); runtime = null; }
  if (settings.localUrl) {
    return M.createLocalProvider({ baseUrl: settings.localUrl, model: settings.localModel, style: 'full' });
  }
  // Embedding models are not extraction models; Iris comes first when it is installed.
  const installed = RT.models().filter((m) => !m.embedding);
  const model = installed.find((m) => m.id === settings.model) || installed.find((m) => m.style === 'iris') || installed[0];
  if (!model) return M.createLocalProvider({ ensure: async () => { throw new Error('no local model installed'); }, canStart: () => false });
  if (model.style === 'iris') {
    const IR = lib('context-iris.js');
    // A model trained on an output format this app does not know is never loaded.
    if (model.contract && model.contract !== IR.VERSION) {
      console.warn(`[context] ${model.id} speaks ${model.contract}; this app understands ${IR.VERSION}. Update Codeply to use it.`);
      return IR.createIrisProvider({ id: 'iris', model: model.id, ensure: async () => { throw new Error('this Iris needs a newer Codeply'); }, canStart: () => false });
    }
    runtime = RT.createRuntime({ model, threads: settings.threads || undefined, ctx: model.ctx || settings.ctx, idleMs: settings.idleMinutes * 60000, args: ['-ctk', 'q8_0', '-ctv', 'q8_0'], log: (s) => console.log(s) });
    return IR.createIrisProvider({ id: 'iris', model: model.id, ensure: runtime.ensure, canStart: runtime.canStart });
  }
  runtime = RT.createRuntime({ model, threads: settings.threads || undefined, ctx: settings.ctx, idleMs: settings.idleMinutes * 60000, args: ['-ctk', 'q8_0', '-ctv', 'q8_0'], log: (s) => console.log(s) });
  // A Codeply-trained model (id starts with "codeply-") reads the short prompt it was trained on.
  return M.createLocalProvider({ id: 'local', model: model.id, ensure: runtime.ensure, canStart: runtime.canStart, extraBody: model.extra, style: /^codeply-/.test(model.id) ? 'compact' : 'full' });
}

// ─── Power: background work waits while the PC is on battery and in use ─────

function canRun() {
  const pm = deps && deps.powerMonitor;
  if (!settings.pauseOnBattery || !pm) return true;
  try {
    if (!pm.isOnBatteryPower()) return true;
    return pm.getSystemIdleTime() >= IDLE_SECONDS;
  } catch { return true; }
}

// ─── Iris: Settings, install, counts ─────────────────────────────────────────

const irisOn = () => settings.mode === 'local' && (!settings.model || settings.model === 'iris-1') && !settings.localUrl;

function irisState() {
  const RT = lib('local-runtime.js');
  const status = require('./iris-install').status(RT);
  const stats = engine ? engine.stats() : null;
  return { ...status, on: irisOn() && status.model, life: !!settings.life.on, pauseOnBattery: !!settings.pauseOnBattery, shareCounts: !!settings.shareCounts, queue: stats ? stats.queue : null, recent: irisRecent(20) };
}

/** What Iris did lately (actions and reasons, never the words). */
function irisRecent(n) {
  if (!store) return [];
  return store.recent(n).filter((e) => e.provider === 'iris').map((e) => ({
    at: e.at, source: e.source, status: e.status, ms: e.outcome ? e.outcome.ms : null,
    actions: e.outcome ? (e.outcome.actions || []).map((a) => a.action) : [], rejected: e.outcome ? (e.outcome.dropped || []).length : 0,
  }));
}

function send(channel, payload) { try { if (deps.send) deps.send(channel, payload); } catch {} }

async function irisInstall() {
  const RT = lib('local-runtime.js');
  const II = require('./iris-install');
  const auth = deps.authLib ? deps.authLib() : null;
  const r = await II.install(RT, {
    getToken: () => (auth ? auth.getAccessToken() : ''), supabaseUrl: auth ? auth.SUPABASE_URL : '', anonKey: auth ? auth.SUPABASE_ANON_KEY : '',
    onProgress: (p) => send('iris:progress', p),
  });
  if (!r.ok) return { ok: false, error: r.error, state: irisState() };
  // The new model gets a self-test before it is used for anything.
  settings = { ...settings, model: 'iris-1', localUrl: '' };
  prov.local = buildLocal();
  send('iris:progress', { step: 'check', done: 0, total: 1 });
  const t = await II.selfTest(prov.local, { tz: deps.life && deps.life.localTz ? deps.life.localTz() : undefined }).catch((e) => ({ ok: false, results: [{ error: e.message }] }));
  if (!t.ok) {
    II.remove(RT);
    prov.local = buildLocal();
    return { ok: false, error: 'Iris did not pass its check on this PC, so it was removed. Nothing in your memory changed.', test: t, state: irisState() };
  }
  setSettings({ mode: 'local', model: 'iris-1' });
  return { ok: true, test: t, state: irisState() };
}

function irisSet(patch = {}) {
  const next = {};
  if ('on' in patch) Object.assign(next, patch.on ? { mode: 'local', model: 'iris-1', localUrl: '' } : { mode: 'legacy' });
  if ('life' in patch) next.life = { on: !!patch.life };
  if ('pauseOnBattery' in patch) next.pauseOnBattery = !!patch.pauseOnBattery;
  if ('shareCounts' in patch) next.shareCounts = !!patch.shareCounts;
  setSettings(next);
  return irisState();
}

function irisRemove() {
  const RT = lib('local-runtime.js');
  if (runtime) { runtime.stop(); runtime = null; }
  require('./iris-install').remove(RT, { runtime: true });
  setSettings({ mode: 'legacy', model: '' });
  return irisState();
}

/**
 * Once a day, when the user allowed it: counts about Iris, never text, never memory.
 * How many batches, what kinds of operations, why the guard refused some, how fast, on what hardware.
 */
function countsSince(since) {
  const rows = store ? store.recent(2000).filter((e) => e.provider === 'iris' && e.at >= since && e.outcome) : [];
  const ops = {}; const refused = {}; const ms = [];
  let malformed = 0;
  for (const e of rows) {
    for (const a of e.outcome.actions || []) ops[a.action] = (ops[a.action] || 0) + 1;
    for (const r of e.outcome.dropped || []) refused[r] = (refused[r] || 0) + 1;
    if (e.outcome.valid === false) malformed += 1;
    if (e.outcome.ms) ms.push(e.outcome.ms);
  }
  ms.sort((a, b) => a - b);
  const pct = (p) => (ms.length ? ms[Math.min(ms.length - 1, Math.floor(ms.length * p))] : null);
  const hw = lib('local-runtime.js').hardware();
  return { batches: new Set(rows.map((e) => (e.outcome.batch || [e.id]).join(','))).size, ops, refused, malformed, p50_ms: pct(0.5), p95_ms: pct(0.95), cores: hw.physical, ram_gb: Math.round(hw.ramMB / 1024) };
}

async function sendCounts() {
  try {
    if (!settings.shareCounts || !store || !deps.authLib) return;
    const last = Number(store.getMeta('iris.counts.at', 0)) || 0;
    if (Date.now() - last < COUNTS_EVERY_MS) return;
    const auth = deps.authLib();
    const token = await auth.getAccessToken();
    if (!token) return;
    const counts = countsSince(last || Date.now() - COUNTS_EVERY_MS);
    if (!counts.batches) { store.setMeta('iris.counts.at', Date.now()); return; }
    const model = lib('local-runtime.js').models().find((m) => m.style === 'iris');
    const res = await fetch(`${auth.SUPABASE_URL}/rest/v1/iris_events`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, apikey: auth.SUPABASE_ANON_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ model: model ? model.id : '', model_sha256: model ? model.sha256 || '' : '', contract: model ? model.contract || '' : '', counts }),
    });
    if (res.ok) store.setMeta('iris.counts.at', Date.now());
  } catch (e) { console.warn('[context] iris counts:', e.message); }
}

function providers() {
  const M = lib('context-model.js');
  const telemetry = lib('telemetry.js');
  return {
    rules: M.createRulesProvider(),
    cloud: M.createCloudProvider({ chatJson: (messages) => telemetry.withProduct('crew', () => deps.aiLib().chatJson(messages, { route: deps.currentRoute() })), routeIsLocal }),
    local: buildLocal(),
  };
}

// ─── Meaning-based retrieval ────────────────────────────────────────────────

function applyEmbed() {
  const B = lib('brain.js');
  B.setRetriever(null);
  if (embedRuntime) { embedRuntime.stop(); embedRuntime = null; }
  if (retriever) { retriever.close(); retriever = null; }
  if (!settings.embed.on) return;
  const RT = lib('local-runtime.js');
  const CR = lib('context-retrieval.js');
  const model = RT.models().find((m) => m.id === settings.embed.model && m.embedding);
  if (!model) { console.warn(`[context] embedding model ${settings.embed.model} is not installed`); return; }
  embedRuntime = RT.createRuntime({ model, threads: 2, ctx: model.ctx, idleMs: settings.idleMinutes * 60000, args: ['--embedding', '--pooling', model.embedding.pooling, '-b', String(model.ctx), '-ub', String(model.ctx)], log: (s) => console.log(s) });
  retriever = CR.createRetriever({ brain: B, model: model.id, embed: CR.llamaEmbedder({ ensure: embedRuntime.ensure }), prefix: model.embedding.prefix, modulePaths: deps.modulePaths });
  B.setRetriever((q) => retriever.scores(q));
  // Index what the brain already knows in the background, so the first turns are not the slow ones.
  retriever.scores('warm up').catch(() => {});
}

// ─── The engine ─────────────────────────────────────────────────────────────

let prov = null;
function applyMode() {
  const B = lib('brain.js');
  // legacy: the old calls do the learning; off: nothing is learned or queued from chats.
  B.setLearner(settings.mode === 'legacy' ? null : settings.mode === 'off' ? () => [] : (x) => engine.learnHook(x));
}

function collectLife() {
  try {
    if (!settings.life.on || ['legacy', 'off'].includes(settings.mode) || !deps.life || !deps.life.isOn()) return;
    const lifeStore = deps.life.getStore();
    if (!lifeStore) return;
    const allowed = new Set(settings.life.sources.filter((s) => deps.life.sourceOn(s)));
    const C = lib('context-collectors.js');
    const since = store.getMeta('life.cursor', Date.now() - 86400000);
    const { events, cursor } = C.lifeEvents({ store: lifeStore, allowed, since });
    for (const ev of events) engine.ingest(ev);
    store.setMeta('life.cursor', cursor);
    if (events.length) console.log(`[context] ${events.length} Life item(s) queued`);
  } catch (e) { console.warn('[context] life:', e.message); }
}

function state() {
  const RT = lib('local-runtime.js');
  return {
    settings, modes: lib('context-model.js').MODES,
    stats: engine ? engine.stats() : null,
    runtime: runtime ? runtime.status() : null,
    embedRuntime: embedRuntime ? embedRuntime.status() : null,
    hardware: RT.hardware(), models: RT.models().map((m) => ({ id: m.id, license: m.license, params: m.params, arch: m.arch })),
    binary: !!RT.findBinary(),
    // What happened to recent events, never their text.
    recent: store ? store.recent(30).map((e) => ({ id: e.id, source: e.source, at: e.at, status: e.status, provider: e.provider, local: e.local, actions: e.outcome ? (e.outcome.actions || []).map((a) => ({ action: a.action, text: a.text, id: a.id })) : [], error: e.error })) : [],
  };
}

function setSettings(patch = {}) {
  const M = lib('context-model.js');
  const next = { ...settings, ...patch, life: { ...settings.life, ...(patch.life || {}) } };
  if (!M.MODES.includes(next.mode)) throw new Error(`Unknown mode "${next.mode}".`);
  if (next.localUrl && !M.isLocalUrl(next.localUrl)) throw new Error('The local model must run on this PC (localhost or 127.0.0.1).');
  const rebuild = ['model', 'localUrl', 'localModel', 'threads', 'ctx', 'idleMinutes'].some((k) => k in patch);
  settings = { ...next, embed: { ...settings.embed, ...(patch.embed || {}) } };
  saveSettings();
  if (rebuild) prov.local = buildLocal();
  if ('embed' in patch) applyEmbed();
  applyMode();
  return state();
}

function registerIpc(ipcMain) {
  ipcMain.handle('context:state', () => state());
  ipcMain.handle('context:set', (e, patch) => { try { return { ok: true, state: setSettings(patch) }; } catch (err) { return { ok: false, error: err.message }; } });
  ipcMain.handle('context:process', async () => (engine ? engine.process({ maxBatches: 5 }) : { batches: [] }));
  ipcMain.handle('context:undo', (e, id) => (engine ? engine.undo(String(id)) : null));
  ipcMain.handle('iris:state', () => irisState());
  ipcMain.handle('iris:install', () => irisInstall());
  ipcMain.handle('iris:set', (e, patch) => { try { return { ok: true, state: irisSet(patch) }; } catch (err) { return { ok: false, error: err.message }; } });
  ipcMain.handle('iris:remove', () => irisRemove());
}

function init(d) {
  deps = d;
  loadSettings();
  try {
    const EV = lib('context-events.js');
    store = EV.openEventStore({ key: storeKey(), modulePaths: deps.modulePaths });
    if (!store) { console.warn('[context] no SQLite driver: context intelligence is off'); return; }
    prov = providers();
    engine = lib('context-engine.js').createEngine({
      store, brain: lib('brain.js'), life: lib('life.js'), providers: prov,
      settings: () => ({ mode: settings.mode, minImportance: settings.minImportance }),
      tz: () => (deps.life && deps.life.localTz ? deps.life.localTz() : Intl.DateTimeFormat().resolvedOptions().timeZone),
      onChange: () => { try { if (deps.onBrainChange) deps.onBrainChange(); } catch {} },
      canRun,
      log: (s) => console.log(s),
    });
    applyMode();
    applyEmbed();
    engine.start();
    store.purge();
    lifeTimer = setInterval(() => { collectLife(); sendCounts(); }, LIFE_EVERY_MS);
    if (lifeTimer.unref) lifeTimer.unref();
    if (deps.ipcMain) registerIpc(deps.ipcMain);
  } catch (e) { console.warn('[context] init:', e.message); }
}

function stop() {
  try { if (lifeTimer) clearInterval(lifeTimer); } catch {}
  try { if (engine) engine.stop(); } catch {}
  try { if (runtime) runtime.stop(); } catch {}
  try { if (embedRuntime) embedRuntime.stop(); } catch {}
  try { if (retriever) retriever.close(); } catch {}
  try { lib('brain.js').setLearner(null); lib('brain.js').setRetriever(null); } catch {}
  try { if (store) store.close(); } catch {}
}

module.exports = { init, stop, state, setSettings, collectLife, irisState, irisSet, irisInstall, irisRemove, countsSince, canRun, DEFAULT_SETTINGS };
