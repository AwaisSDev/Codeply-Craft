/**
 * Model catalogue and name resolution.
 *
 * Like Devin's --model and /model, a name can be a full id, an alias
 * ("opus"), a family slug ("claude-sonnet") or any unambiguous part of a
 * name. Built-in entries need ANTHROPIC_API_KEY or OPENAI_API_KEY; config
 * can add any OpenAI-compatible or Anthropic-compatible model:
 *
 *   "models": {
 *     "local-qwen": { "provider": "openai", "model": "qwen3-coder",
 *                     "base_url": "http://localhost:11434/v1" },
 *     "work-opus":  { "provider": "anthropic", "model": "claude-opus-5-5",
 *                     "api_key_env": "WORK_ANTHROPIC_KEY" }
 *   }
 */
import { anthropicProvider } from './anthropic.mjs';
import { openaiProvider } from './openai.mjs';

export const BUILTIN_MODELS = [
  { id: 'claude-opus-5-5', family: 'claude-opus', aliases: ['opus'], provider: 'anthropic', context: 200000 },
  { id: 'claude-sonnet-5-5', family: 'claude-sonnet', aliases: ['sonnet'], provider: 'anthropic', context: 200000 },
  { id: 'claude-haiku-5-5', family: 'claude-haiku', aliases: ['haiku'], provider: 'anthropic', context: 200000 },
  { id: 'claude-fable-5-1', family: 'claude-fable', aliases: ['fable'], provider: 'anthropic', context: 200000 },
  { id: 'gpt-5.1', family: 'gpt', aliases: ['gpt'], provider: 'openai', context: 400000 },
  { id: 'gpt-5.1-codex', family: 'codex', aliases: ['codex'], provider: 'openai', context: 400000 },
];

export function catalogue(config = {}) {
  const custom = Object.entries(config.models || {}).map(([name, m]) => ({
    id: name,
    model: m.model || name,
    family: m.family || name,
    aliases: m.aliases || [],
    provider: m.provider || 'openai',
    base_url: m.base_url,
    api_key: m.api_key,
    api_key_env: m.api_key_env,
    headers: m.headers,
    context: m.context_window || 128000,
    custom: true,
  }));
  return [...custom, ...BUILTIN_MODELS];
}

function hasKey(entry, env = process.env) {
  if (entry.api_key || (entry.api_key_env && env[entry.api_key_env])) return true;
  if (entry.custom && entry.base_url) return true; // local servers often need no key
  return entry.provider === 'anthropic' ? !!env.ANTHROPIC_API_KEY : !!env.OPENAI_API_KEY;
}

export function availableModels(config, env = process.env) {
  return catalogue(config).filter((m) => hasKey(m, env));
}

/** Resolve a user-typed name. Returns the entry or throws with suggestions. */
export function resolveModel(name, config = {}) {
  const all = catalogue(config);
  if (!name) {
    const avail = availableModels(config);
    if (!avail.length) throw new Error('No model is configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY, or add one under "models" in config.json.');
    return avail[0];
  }
  const q = String(name).toLowerCase();
  const exact = all.find((m) => m.id.toLowerCase() === q || m.aliases.some((a) => a.toLowerCase() === q));
  if (exact) return exact;
  const fam = all.filter((m) => m.family.toLowerCase() === q);
  if (fam.length) return fam[0];
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const partial = all.filter((m) => norm(m.id).includes(norm(q)));
  if (partial.length === 1 || (partial.length > 1 && partial.every((m) => m.family === partial[0].family))) return partial[0];
  if (partial.length > 1) throw new Error(`Model '${name}' is ambiguous: ${partial.map((m) => m.id).join(', ')}`);
  throw new Error(`Unknown model '${name}'. Run \`dvn models list\` to see available models.`);
}

export function providerFor(entry, env = process.env) {
  const apiKey = entry.api_key || (entry.api_key_env ? env[entry.api_key_env] : undefined)
    || (entry.provider === 'anthropic' ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY);
  if (entry.provider === 'anthropic') {
    return anthropicProvider({ apiKey, baseUrl: entry.base_url || env.ANTHROPIC_BASE_URL || undefined, headers: entry.headers });
  }
  return openaiProvider({ apiKey, baseUrl: entry.base_url || env.OPENAI_BASE_URL || undefined, headers: entry.headers });
}

export function modelId(entry) { return entry.model || entry.id; }
