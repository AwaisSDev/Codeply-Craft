// The production local backend (context-model.js createLocalProvider: same prompt, same JSON Schema,
// same sampling) plus token log-probabilities, from which each extracted observation gets a confidence:
//
//   p.exist  probability of the token where the model started this observation (the decision to add it)
//   p.mean   geometric mean probability of the observation's own tokens
//   p.min    the lowest token probability inside the observation
//
// Used to choose the automatic / pending / discard tiers (TIERS.md). Evaluation harness module:
//   node ml/eval/run.mjs --provider module:release/memory-model/conf-provider.mjs --conf-model <installed id> ...
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const { buildExtractionMessages } = require(path.join(ROOT, 'codeply-cli/lib/context-prompt.js'));
const { extractionJsonSchema } = require(path.join(ROOT, 'codeply-cli/lib/context-schema.js'));

/** Character spans [start, end) of the objects in the top-level "observations" array of a JSON text. */
export function observationSpans(text) {
  const key = text.search(/"observations"\s*:\s*\[/);
  if (key < 0) return [];
  let i = text.indexOf('[', key) + 1;
  const spans = []; let depth = 0; let start = -1; let inStr = false; let esc = false;
  for (; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') { if (depth === 0) start = i; depth++; } else if (c === '}') { depth--; if (depth === 0 && start >= 0) { spans.push([start, i + 1]); start = -1; } } else if (c === ']' && depth === 0) break;
  }
  return spans;
}

/** Per-observation confidences from the token log-probabilities of the answer. */
export function confidences(content, tokens) {
  const offs = []; let at = 0;
  for (const t of tokens) { const s = t.token || ''; offs.push([at, at + s.length]); at += s.length; }
  const rebuilt = tokens.map((t) => t.token || '').join('');
  if (rebuilt !== content) return null; // token texts do not reassemble the answer: no confidences
  return observationSpans(content).map(([a, b]) => {
    const inside = tokens.map((t, k) => ({ lp: t.logprob, o: offs[k] })).filter((x) => x.o[1] > a && x.o[0] < b);
    if (!inside.length) return null;
    const first = inside.find((x) => x.o[1] > a); // the token that opens the object
    const mean = Math.exp(inside.reduce((s, x) => s + x.lp, 0) / inside.length);
    return { exist: Math.exp(first.lp), mean, min: Math.exp(Math.min(...inside.map((x) => x.lp))) };
  });
}

export async function createProvider({ opt, RT, threads, ctx }) {
  const id = opt('conf-model');
  const model = RT.models().find((m) => m.id === id);
  if (!model) throw new Error(`model ${id} is not installed`);
  // Start timeout 5 min (evaluation only): a cold page cache or a busy CPU can exceed the runtime's 90 s default.
  const runtime = RT.createRuntime({ model, threads, ctx, idleMs: 0, startTimeoutMs: 300000, args: ['-ctk', 'q8_0', '-ctv', 'q8_0'] });
  const style = opt('style', 'full');
  const provider = {
    info: () => ({ id: 'local', kind: 'local', local: true, model: id, style }),
    available: async () => true,
    async extract(input) {
      const t0 = Date.now();
      const t = await runtime.ensure();
      const body = {
        model: t.model || id, messages: buildExtractionMessages({ ...input, style }),
        temperature: 0, max_tokens: 700, stream: false, cache_prompt: true,
        response_format: { type: 'json_schema', json_schema: { name: 'extraction', strict: true, schema: extractionJsonSchema() } },
        ...(model.extra || {}), logprobs: true, top_logprobs: 1,
      };
      const res = await fetch(`${t.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t.apiKey}` },
        body: JSON.stringify(body), signal: AbortSignal.timeout(300000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = await res.json();
      const ch = data.choices[0]; const content = ch.message.content || '';
      const conf = confidences(content, (ch.logprobs && ch.logprobs.content) || []);
      let answer = content;
      try {
        const j = JSON.parse(content);
        if (conf && Array.isArray(j.observations) && j.observations.length === conf.length) j.observations.forEach((o, k) => { if (conf[k]) o.p = conf[k]; });
        answer = JSON.stringify(j);
      } catch {}
      return { answer, model: data.model || id, ms: Date.now() - t0, usage: data.usage || {} };
    },
  };
  return { provider, runtimes: [runtime] };
}
