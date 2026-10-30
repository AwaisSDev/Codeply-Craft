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
};
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
  const installed = RT.models();
  const model = installed.find((m) => m.id === settings.model) || installed[0];
  if (!model) return M.createLocalProvider({ ensure: async () => { throw new Error('no local model installed'); }, canStart: () => false });
  runtime = RT.createRuntime({ model, threads: settings.threads || undefined, ctx: settings.ctx, idleMs: settings.idleMinutes * 60000, args: ['-ctk', 'q8_0', '-ctv', 'q8_0'], log: (s) => console.log(s) });
  // A Codeply-trained model (id starts with "codeply-") reads the short prompt it was trained on.
  return M.createLocalProvider({ id: 'local', model: model.id, ensure: runtime.ensure, canStart: runtime.canStart, extraBody: model.extra, style: /^codeply-/.test(model.id) ? 'compact' : 'full' });
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
      log: (s) => console.log(s),
    });
    applyMode();
    applyEmbed();
    engine.start();
    store.purge();
    lifeTimer = setInterval(collectLife, LIFE_EVERY_MS);
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

module.exports = { init, stop, state, setSettings, collectLife, DEFAULT_SETTINGS };
