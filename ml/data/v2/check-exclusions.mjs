// Guard for any v2 training or evaluation file: no excluded example may be in it (ml/data/v2/EXCLUDE.json).
//   node ml/data/v2/check-exclusions.mjs <file.jsonl> [...]        exit 1 if any excluded example is present
//   node ml/data/v2/check-exclusions.mjs --filter <in.jsonl> <out.jsonl>   write a copy without them
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const EX = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'EXCLUDE.json'), 'utf8'));
const ids = new Set(EX.exampleIds); const convs = new Set(EX.wildchatConversationIds);
export const excluded = (r) => ids.has(r.id) || !!(r.source && convs.has(r.source.original_id));
const rows = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

const args = process.argv.slice(2);
if (args[0] === '--filter') {
  const all = rows(args[1]); const keep = all.filter((r) => !excluded(r));
  fs.writeFileSync(args[2], keep.map((r) => JSON.stringify(r)).join('\n') + (keep.length ? '\n' : ''));
  console.log(`${args[1]}: ${all.length - keep.length} excluded, ${keep.length} kept -> ${args[2]}`);
} else {
  let bad = 0;
  for (const f of args) { const n = rows(f).filter(excluded).length; bad += n; console.log(`${n ? 'EXCLUDED PRESENT' : 'ok'}  ${f}: ${n}`); }
  process.exitCode = bad ? 1 : 0;
}
