// Store only redacted text: run Codeply's own redaction (codeply-cli/lib/context-redact.js)
// over every event of the pool, in place. Run after build.py. Idempotent.
//   node research/dtw/label/sources/scrub.mjs research/dtw/label/data/pool.jsonl
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const { redact } = createRequire(import.meta.url)(path.join(ROOT, 'codeply-cli/lib/context-redact.js'));
const file = process.argv[2];
let changed = 0;
const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((r) => {
  let hit = false;
  for (const e of r.input.events) { const t = redact(e.text).text; if (t !== e.text) { e.text = t; hit = true; } }
  if (hit) { changed++; r.source.redacted = true; }
  return r;
});
fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.log(`redacted ${changed} examples of ${rows.length}`);
