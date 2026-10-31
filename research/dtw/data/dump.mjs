// Dump a dataset split as Decide-model inputs: the sequence text the runtime
// would build (dtw-input.mjs) from the events the evaluation harness would
// pass (normalised and redacted exactly as in ml/eval/run.mjs), plus the
// targets. Span alignment happens in align.py.
//
//   node research/dtw/data/dump.mjs ml/data/out/train.jsonl > /tmp/train.inputs.jsonl
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { buildInput } from '../runtime/dtw-input.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(import.meta.url);
const S = require(path.join(ROOT, 'codeply-cli/lib/context-schema.js'));
const { redact } = require(path.join(ROOT, 'codeply-cli/lib/context-redact.js'));

/** The events as ml/eval/run.mjs passes them to every backend. */
export function eventsOf(ex) {
  const now = Date.parse(ex.input.now);
  return ex.input.events.map((e) => {
    const n = S.normalizeEvent({ ...e, at: Date.parse(e.at) }, now).event;
    return { ...n, text: redact(n.text).text };
  });
}

const file = process.argv[2];
for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  const ex = JSON.parse(line);
  const events = eventsOf(ex);
  const now = Date.parse(ex.input.now);
  const projects = [...new Set(events.map((e) => e.project).filter(Boolean))];
  const inp = buildInput({ events, known: ex.input.known, now, tz: ex.input.tz, projects });
  process.stdout.write(`${JSON.stringify({
    id: ex.id, task: ex.task, lang: ex.lang || 'en', unseen: !!ex.unseen,
    text: inp.text, events: inp.events.map((s, i) => ({ ...s, raw: ex.input.events[i].text, red: events[i].text, trust: events[i].trust })),
    mems: inp.mems.map((m) => ({ ...m, ...(ex.input.known[m.index] || {}) })),
    now, tz: ex.input.tz, target: ex.target, expect: ex.expect || {},
  })}\n`);
}
