/**
 * Codeply CLI — model provider configuration.
 *
 * Lives in ~/.codeply/config.json, next to auth.json, deliberately OUTSIDE the
 * repo: it holds API keys and must never be committable. Environment
 * variables win over the file so a key can be supplied per-shell without ever
 * touching disk.
 *
 * Providers:
 *   codeply     the hosted ai-proxy (default; needs `codeply login`), shares
 *               a daily cap with the desktop app
 *   ollama      Ollama's OpenAI-compatible API — cloud (ollama.com, needs a
 *               key) or a local daemon (http://localhost:11434, no key)
 *   openrouter  bring your own OpenRouter key, no cap
 *   groq        bring your own Groq key, no cap
 *   anthropic   bring your own Anthropic key, no cap
 *   openai      bring your own OpenAI key, no cap
 *   google      bring your own Google AI Studio (Gemini) key, no cap — talks
 *               to Gemini's OpenAI-compatible endpoint, see lib/ai.js
 *   qwen        bring your own Alibaba Cloud Model Studio (Qwen) key, no cap —
 *               talks to its OpenAI-compatible endpoint. Unlike the other BYOK
 *               providers the base URL isn't fixed (Alibaba issues a
 *               deployment-specific host per account/region), so it's stored
 *               alongside the key rather than hardcoded — see baseUrl below.
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
  // numCtx: null means "let the server use its own default" — ollama.com's
  // cloud service and most well-resourced hosts default to something
  // reasonable already. It only needs setting for a constrained self-hosted
  // instance whose default context window (commonly 2048 tokens on a plain
  // `ollama pull` with no custom Modelfile) is too small to hold a real
  // conversation — see lib/ai.js's ollamaRequest for where this actually
  // gets sent, and Codeply Craft's MODEL_PRESETS for where 12B's is set.
  ollama:     { host: 'https://ollama.com', model: 'gemma4:31b', apiKey: '', apiKeyFallback: '', numCtx: null },
  openrouter: { model: 'openrouter/auto', apiKey: '' },
  groq:       { model: 'openai/gpt-oss-120b', apiKey: '' },
  anthropic:  { model: 'claude-sonnet-5', apiKey: '' },
  openai:     { model: 'gpt-4o-mini', apiKey: '' },
  google:     { model: 'gemini-3.7-flash', apiKey: '' },
  qwen:       { model: 'qwen3.8-max', apiKey: '', baseUrl: '' },
  // DeepSeek's own API (not via OpenRouter) — automatically caches repeated
  // request prefixes server-side (cache-hit input tokens run ~15-30x cheaper
  // than a cache miss, per their published pricing) with no special request
  // flag needed to enable it; it just applies whenever consecutive calls
  // share an identical prefix, which every step of one turn's action-block
  // loop already does (same TOOL_REFERENCE + persona + project context each
  // time) — this provider benefits from that automatically.
  deepseek:   { model: 'deepseek-v4-flash-vision-exp', apiKey: '' },
};

function readFile() {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
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
      // Only a couple of providers (qwen so far) need a configurable host —
      // this is a no-op empty string for the fixed-endpoint ones.
      ...('baseUrl' in DEFAULTS[name]
        ? { baseUrl: process.env[`${envPrefix}_BASE_URL`] || fileEntry.baseUrl || DEFAULTS[name].baseUrl }
        : {}),
    };
  }

  return {
    provider,
    ollama: {
      host: (process.env.OLLAMA_HOST || fileOllama.host || DEFAULTS.ollama.host).replace(/\/+$/, ''),
      model: process.env.OLLAMA_MODEL || fileOllama.model || DEFAULTS.ollama.model,
      apiKey: process.env.OLLAMA_API_KEY || fileOllama.apiKey || '',
      // Tried only when the primary key's request actually fails — a second
      // Ollama cloud account/key so one hitting its quota or erroring out
      // doesn't stop the whole app, see chatViaOllama in ai.js.
      apiKeyFallback: process.env.OLLAMA_API_KEY_FALLBACK || fileOllama.apiKeyFallback || '',
      // Explicit `0`/`null` in the file must still mean "unset", not fall
      // through to a stale value — only undefined (key absent) does that.
      numCtx: Number(process.env.OLLAMA_NUM_CTX) || fileOllama.numCtx || null,
    },
    ...byok,
  };
}

/** Merge a patch into the stored config. Written user-only where supported. */
function saveConfig(patch) {
  const current = readFile();
  const next = { ...current, ...patch };
  for (const name of ['ollama', ...BYOK_PROVIDERS]) {
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
// A separate concept from the AI providers above — these are action
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
  // the other — slack_post_message picks userAccessToken by default when
  // present, but the bot token still exists for anything that needs the app
  // identity specifically.
  slack: { clientId: '', clientSecret: '', accessToken: '', userAccessToken: '', userId: '', teamId: '', teamName: '' },
  // clientId/clientSecret ship empty — connecting is a no-op ("No Vercel
  // client ID/secret configured") until a real OAuth app is registered and
  // its credentials are placed here. The rest of the shape exists now so
  // the connect/disconnect UI and the eventual deploy tool have somewhere
  // real to read from the moment credentials are added.
  vercel: { clientId: '', clientSecret: '', slug: '', accessToken: '', teamId: '', userName: '' },
  supabase: { clientId: '', clientSecret: '', accessToken: '', refreshToken: '', expiresAt: 0, email: '' },
  github: { clientId: '', clientSecret: '', accessToken: '', userName: '' },
};

/** Effective integration config: defaults ← file. No env override — these are user-connected, not per-shell. */
function getIntegration(name) {
  if (!INTEGRATIONS.includes(name)) throw new Error(`Unknown integration: ${name}`);
  const file = readFile();
  return { ...INTEGRATION_DEFAULTS[name], ...(file[name] || {}) };
}

/** True once the OAuth flow has actually completed and an access token is stored. */
function isIntegrationConnected(name) {
  return !!getIntegration(name).accessToken;
}

/** Merge a patch into one integration's stored section — same merge-by-section semantics as saveConfig. */
function saveIntegration(name, patch) {
  if (!INTEGRATIONS.includes(name)) throw new Error(`Unknown integration: ${name}`);
  return saveConfig({ [name]: { ...getIntegration(name), ...patch } });
}

/** Disconnects by wiping the stored tokens — client id/secret are left in place so reconnecting doesn't need them re-entered. */
function disconnectIntegration(name) {
  if (!INTEGRATIONS.includes(name)) throw new Error(`Unknown integration: ${name}`);
  const current = getIntegration(name);
  return saveConfig({
    [name]: { ...current, accessToken: '', refreshToken: '', expiresAt: 0, email: '', teamId: '', teamName: '', userAccessToken: '', userId: '', userName: '' },
  });
}

/** Never render a key in full — this is what goes on screen and in logs. */
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

/** Same, but without naming the specific model — for passive UI chrome (the TUI status line). */
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

/** Suggested next step when the shared codeply account hits its daily cap. */
function byokHint() {
  return 'Have your own API key? Bring your own model instead, no shared daily cap: ' +
    'codeply provider openrouter --key <key> (or groq, anthropic, openai, qwen).';
}

module.exports = {
  getConfig, saveConfig, maskKey, describeProvider, describeProviderShort, byokHint,
  configPath, PROVIDERS, BYOK_PROVIDERS,
  getIntegration, saveIntegration, disconnectIntegration, isIntegrationConnected, INTEGRATIONS,
};
