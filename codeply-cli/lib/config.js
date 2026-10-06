/**
 * Codeply CLI - model provider configuration.
 *
 * Lives in ~/.codeply/config.json, next to auth.json, deliberately OUTSIDE the
 * repo: it holds API keys and must never be committable. Environment
 * variables win over the file so a key can be supplied per-shell without ever
 * touching disk.
 *
 * Providers:
 *   codeply     the hosted ai-proxy (default; needs `codeply login`), shares
 *               a daily cap with the desktop app
 *   ollama      Ollama's OpenAI-compatible API - cloud (ollama.com, needs a
 *               key) or a local daemon (http://localhost:11434, no key)
 *   openrouter  bring your own OpenRouter key, no cap
 *   groq        bring your own Groq key, no cap
 *   anthropic   bring your own Anthropic key, no cap
 *   openai      bring your own OpenAI key, no cap
 *   google      bring your own Google AI Studio (Gemini) key, no cap - talks
 *               to Gemini's OpenAI-compatible endpoint, see lib/ai.js
 *   qwen        bring your own Alibaba Cloud Model Studio (Qwen) key, no cap -
 *               talks to its OpenAI-compatible endpoint. Unlike the other BYOK
 *               providers the base URL isn't fixed (Alibaba issues a
 *               deployment-specific host per account/region), so it's stored
 *               alongside the key rather than hardcoded - see baseUrl below.
 *
 * The last six are "BYOK": once a key is set, the CLI talks to that
 * provider directly and never touches the shared Codeply account limit.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const configDir = path.join(os.homedir(), '.codeply');
const configPath = path.join(configDir, 'config.json');

const PROVIDERS = ['codeply', 'ollama', 'openrouter', 'groq', 'anthropic', 'openai', 'google', 'qwen', 'deepseek'];
const BYOK_PROVIDERS = ['openrouter', 'groq', 'anthropic', 'openai', 'google', 'qwen', 'deepseek'];

const DEFAULTS = {
  provider: 'codeply',
  // numCtx: null means "let the server use its own default" - ollama.com's
  // cloud service and most well-resourced hosts default to something
  // reasonable already. It only needs setting for a constrained self-hosted
  // instance whose default context window (commonly 2048 tokens on a plain
  // `ollama pull` with no custom Modelfile) is too small to hold a real
  // conversation - see lib/ai.js's ollamaRequest for where this actually
  // gets sent, and Codeply Craft's MODEL_PRESETS for where 12B's is set.
  ollama:     { host: 'https://ollama.com', model: 'gemma4:31b', apiKey: '', apiKeyFallback: '', numCtx: null },
  openrouter: { model: 'openrouter/auto', apiKey: '' },
  groq:       { model: 'openai/gpt-oss-120b', apiKey: '' },
  anthropic:  { model: 'claude-sonnet-5', apiKey: '' },
  openai:     { model: 'gpt-4o-mini', apiKey: '' },
  google:     { model: 'gemini-3.7-flash', apiKey: '' },
  qwen:       { model: 'qwen3.8-max', apiKey: '', baseUrl: '' },
  // DeepSeek's own API (not via OpenRouter) - automatically caches repeated
  // request prefixes server-side (cache-hit input tokens run ~15-30x cheaper
  // than a cache miss, per their published pricing) with no special request
  // flag needed to enable it; it just applies whenever consecutive calls
  // share an identical prefix, which every step of one turn's action-block
  // loop already does (same TOOL_REFERENCE + persona + project context each
  // time) - this provider benefits from that automatically.
  deepseek:   { model: 'deepseek-v4-flash-vision-exp', apiKey: '' },
};

let lastReadFailed = false;
function readFile() {
  lastReadFailed = false;
  let raw;
  try { raw = fs.readFileSync(configPath, 'utf8'); } catch { return {}; } // no file yet
  try {
    return JSON.parse(raw);
  } catch {
    // Unreadable (e.g. hand-edited). Callers must not write back over it,
    // or every saved key and connection would be lost.
    lastReadFailed = true;
    return {};
  }
}

/** Effective config: defaults ← file ← environment. */
function getConfig() {
  const file = readFile();
  const provider = process.env.CODEPLY_PROVIDER || file.provider || DEFAULTS.provider;
  const fileOllama = file.ollama || {};

  const byok = {};
  for (const name of BYOK_PROVIDERS) {
    const fileEntry = file[name] || {};
    const envPrefix = name.toUpperCase();
    byok[name] = {
      model: process.env[`${envPrefix}_MODEL`] || fileEntry.model || DEFAULTS[name].model,
      apiKey: process.env[`${envPrefix}_API_KEY`] || fileEntry.apiKey || '',
      // Only a couple of providers (qwen so far) need a configurable host -
      // this is a no-op empty string for the fixed-endpoint ones.
      ...('baseUrl' in DEFAULTS[name]
        ? { baseUrl: process.env[`${envPrefix}_BASE_URL`] || fileEntry.baseUrl || DEFAULTS[name].baseUrl }
        : {}),
    };
  }

  // Research Mode (local Ollama or Ollama Cloud), see research-mode/.
  const fr = file.research || {};
  const research = {
    enabled: fr.enabled === true,
    mode: fr.mode === 'cloud' ? 'cloud' : 'local',
    model: String(fr.model || ''),
    apiKey: process.env.OLLAMA_API_KEY || fr.apiKey || '',
    context: String(fr.context || ''),
  };

  return {
    provider,
    research,
    ollama: {
      host: (process.env.OLLAMA_HOST || fileOllama.host || DEFAULTS.ollama.host).replace(/\/+$/, ''),
      model: process.env.OLLAMA_MODEL || fileOllama.model || DEFAULTS.ollama.model,
      apiKey: process.env.OLLAMA_API_KEY || fileOllama.apiKey || '',
      // Tried only when the primary key's request actually fails - a second
      // Ollama cloud account/key so one hitting its quota or erroring out
      // doesn't stop the whole app, see chatViaOllama in ai.js.
      apiKeyFallback: process.env.OLLAMA_API_KEY_FALLBACK || fileOllama.apiKeyFallback || '',
      // Explicit `0`/`null` in the file must still mean "unset", not fall
      // through to a stale value - only undefined (key absent) does that.
      numCtx: Number(process.env.OLLAMA_NUM_CTX) || fileOllama.numCtx || null,
    },
    ...byok,
  };
}

/** Merge a patch into the stored config. Written user-only where supported. */
function saveConfig(patch) {
  const current = readFile();
  if (lastReadFailed) return { ok: false, error: `${configPath} is not valid JSON. Fix or delete it, then try again.` };
  const next = { ...current, ...patch };
  for (const name of ['ollama', 'research', ...BYOK_PROVIDERS]) {
    if (current[name] || patch[name]) {
      next[name] = { ...(current[name] || {}), ...(patch[name] || {}) };
    }
  }
  try {
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(next, null, 2), { mode: 0o600 });
    // mkdir/writeFile modes are advisory on Windows; chmod is best-effort.
    try { fs.chmodSync(configPath, 0o600); } catch {}
    return { ok: true, path: configPath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ─── Third-party integrations (Gmail, Slack) ───────────────────────────────
// A separate concept from the AI providers above - these are action
// integrations the agent's tools call (send an email, post a Slack message),
// not places a chat completion comes from. Kept in their own top-level config
// sections rather than folded into PROVIDERS/BYOK_PROVIDERS so the two
// systems never get confused with each other.
const INTEGRATIONS = ['gmail', 'slack', 'vercel', 'supabase', 'github'];

const INTEGRATION_DEFAULTS = {
  gmail: { clientId: '', clientSecret: '', accessToken: '', refreshToken: '', expiresAt: 0, email: '' },
  // accessToken is the bot token (posts as "Codeply Craft APP"); userAccessToken
  // is the separate user token from the same OAuth exchange (posts as the
  // actual signed-in person). Kept side by side rather than one overwriting
  // the other - slack_post_message picks userAccessToken by default when
  // present, but the bot token still exists for anything that needs the app
  // identity specifically.
  slack: { clientId: '', clientSecret: '', accessToken: '', userAccessToken: '', userId: '', teamId: '', teamName: '' },
  // clientId/clientSecret ship empty - connecting is a no-op ("No Vercel
  // client ID/secret configured") until a real OAuth app is registered and
  // its credentials are placed here. The rest of the shape exists now so
  // the connect/disconnect UI and the eventual deploy tool have somewhere
  // real to read from the moment credentials are added.
  vercel: { clientId: '', clientSecret: '', slug: '', accessToken: '', teamId: '', userName: '' },
  supabase: { clientId: '', clientSecret: '', accessToken: '', refreshToken: '', expiresAt: 0, email: '' },
  github: { clientId: '', clientSecret: '', accessToken: '', userName: '' },
};

/**
 * Effective integration config: defaults ← file ← app-wide OAuth credentials.
 * The OAuth app's client id/secret come from the environment (a dev .env, or
 * the credentials baked into a release build - see main.js) whenever the
 * user's own file doesn't set them. They're filled in here at read time only
 * and never written back into the user's config file.
 */
function getIntegration(name) {
  if (!INTEGRATIONS.includes(name)) throw new Error(`Unknown integration: ${name}`);
  const file = readFile();
  const merged = { ...INTEGRATION_DEFAULTS[name], ...(file[name] || {}) };
  const envPrefix = name.toUpperCase();
  if (!merged.clientId) merged.clientId = process.env[`${envPrefix}_CLIENT_ID`] || '';
  if (!merged.clientSecret) merged.clientSecret = process.env[`${envPrefix}_CLIENT_SECRET`] || '';
  return merged;
}

/** True once the OAuth flow has actually completed and an access token is stored. */
function isIntegrationConnected(name) {
  return !!getIntegration(name).accessToken;
}

/** Merge a patch into one integration's stored section - same merge-by-section semantics as saveConfig. */
function saveIntegration(name, patch) {
  if (!INTEGRATIONS.includes(name)) throw new Error(`Unknown integration: ${name}`);
  const stored = readFile()[name] || {};
  return saveConfig({ [name]: { ...INTEGRATION_DEFAULTS[name], ...stored, ...patch } });
}

/** Disconnects by wiping the stored tokens - client id/secret are left in place so reconnecting doesn't need them re-entered. */
function disconnectIntegration(name) {
  if (!INTEGRATIONS.includes(name)) throw new Error(`Unknown integration: ${name}`);
  return saveIntegration(name, {
    accessToken: '', refreshToken: '', expiresAt: 0, email: '', teamId: '', teamName: '', userAccessToken: '', userId: '', userName: '',
  });
}

// ─── Models (the desktop app's model picker) ────────────────────────────────
// "Auto" is the hosted Codeply model (the ai-proxy, needs sign-in). Everything
// else is a model the user added themselves: a name, an OpenAI-compatible base
// URL, a model id and an optional API key - or an Ollama host. These live in
// this same file (~/.codeply/config.json, user-only permissions) and are only
// ever sent to the base URL the user typed in, never to Codeply.
//
//   selectedModel: 'auto' | <model id>
//   models: [{ id, name, kind: 'openai' | 'ollama', baseUrl, model, apiKey, createdAt }]

const AUTO_MODEL_ID = 'auto';

// Base URLs for importing the CLI's older per-provider keys (`codeply provider
// <name> --key`) as regular models the first time the models list is read.
const LEGACY_BASE_URLS = {
  openrouter: 'https://openrouter.ai/api/v1',
  groq: 'https://api.groq.com/openai/v1',
  openai: 'https://api.openai.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta/openai',
  deepseek: 'https://api.deepseek.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
};
const LEGACY_LABELS = {
  openrouter: 'OpenRouter', groq: 'Groq', openai: 'OpenAI', google: 'Gemini',
  qwen: 'Qwen', deepseek: 'DeepSeek', anthropic: 'Claude', ollama: 'Ollama',
};

function newModelId() {
  return 'm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function writeFile(next) {
  if (lastReadFailed) return { ok: false, error: `${configPath} is not valid JSON. Fix or delete it, then try again.` };
  try {
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(next, null, 2), { mode: 0o600 });
    try { fs.chmodSync(configPath, 0o600); } catch {}
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** One-time import of legacy provider keys, so an existing setup keeps working. */
function migrateLegacyModels(file) {
  const models = [];
  let selected = AUTO_MODEL_ID;
  for (const name of BYOK_PROVIDERS) {
    const entry = file[name];
    if (!entry || !entry.apiKey) continue;
    const baseUrl = name === 'qwen' ? entry.baseUrl : LEGACY_BASE_URLS[name];
    if (!baseUrl) continue;
    const model = entry.model || DEFAULTS[name].model;
    const m = { id: newModelId(), name: `${LEGACY_LABELS[name]} · ${model}`, kind: 'openai', baseUrl, model, apiKey: entry.apiKey, createdAt: Date.now() };
    models.push(m);
    if (file.provider === name) selected = m.id;
  }
  const ol = file.ollama;
  const olLocal = ol && /localhost|127\.0\.0\.1/.test(ol.host || '');
  if (ol && (ol.apiKey || olLocal) && ol.host) {
    const model = ol.model || DEFAULTS.ollama.model;
    const m = { id: newModelId(), name: `Ollama · ${model}`, kind: 'ollama', baseUrl: ol.host, model, apiKey: ol.apiKey || '', createdAt: Date.now() };
    models.push(m);
    if (file.provider === 'ollama') selected = m.id;
  }
  return { models, selected };
}

function readModelsState() {
  const file = readFile();
  if (!Array.isArray(file.models)) {
    const { models, selected } = migrateLegacyModels(file);
    file.models = models;
    file.selectedModel = selected;
    if (!lastReadFailed) writeFile(file);
  }
  return file;
}

function getModels() {
  return readModelsState().models;
}

function getSelectedModelId() {
  const file = readModelsState();
  const id = file.selectedModel || AUTO_MODEL_ID;
  if (id !== AUTO_MODEL_ID && !file.models.some((m) => m.id === id)) return AUTO_MODEL_ID;
  return id;
}

/** The model entry a turn should use, or null for Auto (the hosted Codeply model). */
function getSelectedModel() {
  const id = getSelectedModelId();
  if (id === AUTO_MODEL_ID) return null;
  return getModels().find((m) => m.id === id) || null;
}

function getModel(id) {
  if (!id || id === AUTO_MODEL_ID) return null;
  return getModels().find((m) => m.id === id) || null;
}

/**
 * Create or update a model. On update an omitted/undefined apiKey keeps the
 * stored one, so the UI never has to hold (or re-send) a saved key.
 */
function saveModel(input) {
  const file = readModelsState();
  const name = String(input.name || '').trim();
  const model = String(input.model || '').trim();
  const baseUrl = String(input.baseUrl || '').trim().replace(/\/+$/, '');
  const kind = input.kind === 'ollama' ? 'ollama' : 'openai';
  if (!model) return { ok: false, error: 'Enter the model id (for example gpt-4o-mini or llama3.1).' };
  if (!/^https?:\/\//i.test(baseUrl)) return { ok: false, error: 'The base URL must start with http:// or https://.' };

  const existing = input.id ? file.models.find((m) => m.id === input.id) : null;
  const entry = {
    id: existing ? existing.id : newModelId(),
    name: name || model,
    kind,
    baseUrl,
    model,
    apiKey: input.apiKey === undefined || input.apiKey === null ? (existing?.apiKey || '') : String(input.apiKey).trim(),
    createdAt: existing?.createdAt || Date.now(),
  };
  file.models = existing
    ? file.models.map((m) => (m.id === entry.id ? entry : m))
    : [...file.models, entry];
  const w = writeFile(file);
  return w.ok ? { ok: true, model: entry } : w;
}

function deleteModel(id) {
  const file = readModelsState();
  file.models = file.models.filter((m) => m.id !== id);
  if (file.selectedModel === id) file.selectedModel = AUTO_MODEL_ID;
  return writeFile(file);
}

function selectModel(id) {
  const file = readModelsState();
  if (id !== AUTO_MODEL_ID && !file.models.some((m) => m.id === id)) return { ok: false, error: 'Unknown model.' };
  file.selectedModel = id;
  return writeFile(file);
}

/**
 * The models the signed-in ChatGPT plan offers (see chatgpt.js), kept as
 * kind "chatgpt" entries so the pickers, routing and the phone all treat them
 * like any other model. No key is stored: chatgpt.js holds the tokens.
 * Passing [] removes them all (sign-out); the selection falls back to Auto if
 * the chosen one went away.
 */
function syncChatGPTModels(list) {
  const file = readModelsState();
  const existing = file.models.filter((m) => m.kind === 'chatgpt');
  const next = (list || []).map((x) => {
    const prev = existing.find((m) => m.model === x.slug);
    return {
      id: prev ? prev.id : newModelId(),
      name: x.name || x.slug,
      kind: 'chatgpt',
      baseUrl: 'https://api.openai.com/v1',
      model: x.slug,
      apiKey: '',
      createdAt: prev?.createdAt || Date.now(),
    };
  });
  file.models = [...file.models.filter((m) => m.kind !== 'chatgpt'), ...next];
  if (file.selectedModel !== AUTO_MODEL_ID && !file.models.some((m) => m.id === file.selectedModel)) file.selectedModel = AUTO_MODEL_ID;
  const w = writeFile(file);
  return w.ok ? { ok: true, models: next } : w;
}

/** Never render a key in full - this is what goes on screen and in logs. */
function maskKey(key) {
  if (!key) return '(none)';
  if (key.length <= 8) return '••••';
  return key.slice(0, 4) + '…' + key.slice(-4);
}

/** One-line description of where completions are coming from, model included (for `codeply provider`). */
function describeProvider(cfg = getConfig()) {
  if (cfg.provider === 'ollama') {
    const where = /localhost|127\.0\.0\.1/.test(cfg.ollama.host) ? 'local' : 'cloud';
    return `ollama ${where} · ${cfg.ollama.model}`;
  }
  if (BYOK_PROVIDERS.includes(cfg.provider)) {
    return `${cfg.provider} (own key) · ${cfg[cfg.provider].model}`;
  }
  return 'codeply proxy';
}

/** Same, but without naming the specific model - for passive UI chrome (the TUI status line). */
function describeProviderShort(cfg = getConfig()) {
  if (cfg.provider === 'ollama') {
    const where = /localhost|127\.0\.0\.1/.test(cfg.ollama.host) ? 'local' : 'cloud';
    return `ollama ${where}`;
  }
  if (BYOK_PROVIDERS.includes(cfg.provider)) {
    return `${cfg.provider} (own key)`;
  }
  return 'codeply proxy';
}

/** Suggested next step when the hosted model is busy or unavailable. */
function byokHint() {
  return 'You can also use your own model: in Codeply Craft click the model name next to Send and choose ' +
    '"Add a model" or "Connect Ollama" (CLI: codeply provider openrouter --key <key>).';
}

module.exports = {
  getConfig, saveConfig, maskKey, describeProvider, describeProviderShort, byokHint,
  configPath, PROVIDERS, BYOK_PROVIDERS,
  getIntegration, saveIntegration, disconnectIntegration, isIntegrationConnected, INTEGRATIONS,
  AUTO_MODEL_ID, getModels, getModel, getSelectedModel, getSelectedModelId, saveModel, deleteModel, selectModel, syncChatGPTModels,
};
