'use strict';

// Endpoints and exact user-facing errors for Research Mode. Inference itself
// goes through lib/ai.js (chatViaOllamaNative), this only resolves where to
// send it and lists models (the equivalent of `ollama list`).

// Env overrides exist so tests can point at a fake server.
const localUrl = () => process.env.CODEPLY_RESEARCH_LOCAL_URL || 'http://localhost:11434';
const cloudUrl = () => process.env.CODEPLY_RESEARCH_CLOUD_URL || 'https://ollama.com';

const ERR_LOCAL_DOWN = 'Start Ollama with `ollama serve`';
const ERR_CLOUD_KEY = 'Add your Ollama Cloud API key in Settings';

/** Where a research settings object sends requests: { host, apiKey, error }. */
function resolveTarget(rm) {
  if (!rm || rm.mode !== 'local') {
    // Online: the person's own Ollama key if they added one, else Codeply's
    // own Ollama Cloud account (the keys Auto's fallback uses), so it just works.
    let apiKey = String((rm && rm.apiKey) || '').trim();
    if (!apiKey) {
      try { const o = require('../lib/config.js').getConfig().ollama; apiKey = String(o.apiKey || o.apiKeyFallback || '').trim(); } catch {}
    }
    if (!apiKey) return { host: cloudUrl(), apiKey: '', error: ERR_CLOUD_KEY };
    return { host: cloudUrl(), apiKey };
  }
  return { host: localUrl(), apiKey: '' };
}

/** GET /api/tags. Resolves { ok, models: [{name,size,params,family}], error }. */
async function listModels(rm) {
  const t = resolveTarget(rm);
  if (t.error) return { ok: false, models: [], error: t.error };
  const headers = t.apiKey ? { Authorization: `Bearer ${t.apiKey}` } : {};
  const local = !!(rm && rm.mode === 'local');
  try {
    const res = await fetch(`${t.host}/api/tags`, { headers, signal: AbortSignal.timeout(5000) });
    if (res.status === 401 || res.status === 403) return { ok: false, models: [], error: ERR_CLOUD_KEY };
    if (!res.ok) return { ok: false, models: [], error: `Ollama answered HTTP ${res.status}.` };
    const body = await res.json();
    const models = (body.models || []).map((x) => ({
      name: x.name || x.model, size: x.size || 0, family: x.details?.family || '', params: x.details?.parameter_size || '',
    })).filter((x) => x.name);
    return { ok: true, models };
  } catch {
    return { ok: false, models: [], error: local ? ERR_LOCAL_DOWN : 'Could not reach Ollama Cloud.' };
  }
}

module.exports = { localUrl, cloudUrl, ERR_LOCAL_DOWN, ERR_CLOUD_KEY, resolveTarget, listModels };
