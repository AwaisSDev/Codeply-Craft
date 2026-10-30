// Render the dataset as chat-format SFT files, with the exact prompt the app
// sends at runtime (codeply-cli/lib/context-prompt.js) after the same
// redaction (context-redact.js). A model fine-tuned on these sees in training
// exactly what it sees on the user's PC.
//
//   node ml/data/export-sft.mjs [--in ml/data/out] [--style compact|full]
//
// Writes <in>/sft-train.jsonl and <in>/sft-val.jsonl, one
// {"messages": [system, user, assistant]} per line (TRL / Unsloth / Axolotl "messages" format).
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const require = createRequire(import.meta.url);
const { buildExtractionMessages } = require(path.join(ROOT, 'codeply-cli/lib/context-prompt.js'));
const { normalizeEvent } = require(path.join(ROOT, 'codeply-cli/lib/context-schema.js'));
const { redact } = require(path.join(ROOT, 'codeply-cli/lib/context-redact.js'));

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const IN = path.resolve(opt('in', path.join(HERE, 'out')));
const STYLE = opt('style', 'compact');

/** One dataset example as the runtime prompt plus the target answer. */
export function toMessages(ex, style = STYLE) {
  const now = Date.parse(ex.input.now);
  const events = ex.input.events.map((e) => {
    const n = normalizeEvent({ ...e, at: Date.parse(e.at) }, now).event;
    return { ...n, text: redact(n.text).text };
  });
  const msgs = buildExtractionMessages({ events, known: ex.input.known, now, tz: ex.input.tz, style });
  // The answer in a fixed key order, the shape the JSON Schema asks for.
  const answer = {
    observations: ex.target.observations.map((o) => ({
      kind: o.kind, slot: o.slot, value: o.value, text: o.text, certainty: o.certainty, importance: o.importance,
      ...(o.project ? { project: o.project } : {}), ...(o.until ? { until: o.until } : {}), ...(o.about ? { about: o.about } : {}),
    })),
    plans: ex.target.plans.map((p) => ({ what: p.what, when: p.when, where: p.where || '', who: p.who || [] })),
  };
  return [...msgs, { role: 'assistant', content: JSON.stringify(answer) }];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const split of ['train', 'val']) {
    const file = path.join(IN, `${split}.jsonl`);
    if (!fs.existsSync(file)) continue;
    const out = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.stringify({ messages: toMessages(JSON.parse(l)) }));
    fs.writeFileSync(path.join(IN, `sft-${split}.jsonl`), `${out.join('\n')}\n`);
    const chars = out.reduce((n, l) => n + l.length, 0);
    console.log(`${split}: ${out.length} examples, ~${Math.round(chars / 3.6 / out.length)} tokens each (${STYLE} prompt)`);
  }
}
