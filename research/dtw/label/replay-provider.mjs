// Scores Claude-as-labeller with the unchanged evaluation harness: replays the
// labels collected by label.mjs as a backend, so the labeller's numbers go through
// the same guard, matching and brain actions as every other system.
//
//   node ml/eval/run.mjs --provider module:research/dtw/label/replay-provider.mjs \
//        --labels research/dtw/label/out/<run>/results.jsonl --set bench --set-file research/dtw/benchmark/bench.jsonl --name claude-x-bench
import fs from 'fs';
import { inputKey, toAnswer } from './prompt.mjs';

export async function createProvider({ opt }) {
  const byKey = new Map();
  for (const l of fs.readFileSync(opt('labels'), 'utf8').split('\n')) {
    if (!l.trim()) continue;
    const r = JSON.parse(l);
    if (r.key && r.output) byKey.set(r.key, r);
  }
  let model = '';
  const provider = {
    id: 'replay', kind: 'cloud', local: false,
    info: () => ({ id: 'replay', kind: 'cloud', local: false, model: `replay:${model}`, ctx: 0 }),
    available: async () => true,
    async extract(input) {
      const r = byKey.get(inputKey(input));
      if (!r) return { answer: { observations: [], plans: [] }, model: 'replay:missing', ms: 0, usage: { missing: 1 } };
      model = r.model;
      return { answer: toAnswer(r.output), model: r.model, ms: 0, usage: { prompt_tokens: (r.usage && r.usage.input_tokens) || 0, completion_tokens: (r.usage && r.usage.output_tokens) || 0, usd: r.cost || 0 } };
    },
  };
  return { provider, runtimes: [] };
}
