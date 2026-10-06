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
  if (rm && rm.mode === 'cloud') {
    const apiKey = String(rm.apiKey || '').trim();
    if (!apiKey) return { host: cloudUrl(), apiKey: '', error: ERR_CLOUD_KEY };
    return { host: cloudUrl(), apiKey };
  }
  return { host: localUrl(), apiKey: '' };
}

