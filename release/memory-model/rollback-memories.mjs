// Roll back what one extraction model did to a user's brain, from the context event store's per-batch outcomes
// (each processed event records the model and the brain action + memory id of every observation).
//
//   added     -> forget the memory (only if nothing else has touched it since: evidence 1, not locked)
//   replaced  -> undo to the previous value (brain.resolve(id, 'undo'))
//   reinforced, challenged, kept, ignored -> left alone (the memory existed before)
//
// Dry run by default: prints what it would do. --apply does it. Only events still in the store can be rolled back
// (the store drops old rows: context-events.js purge).
//
//   node release/memory-model/rollback-memories.mjs --events <context events db> --brain <brain db> --model <model id> [--apply]
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const lib = (n) => require(path.join(ROOT, 'codeply-cli/lib', n));

/** The rollback plan for a model, from an event store and an open brain. */
export function planRollback(store, BR, model, limit = 100000) {
  const plan = []; const seen = new Set();
  for (const e of store.recent(limit)) {
    if (e.model !== model || !e.outcome || !Array.isArray(e.outcome.actions)) continue;
    for (const a of e.outcome.actions) {
      if (!a.id || seen.has(a.id)) continue;
      const m = BR.get(a.id);
      if (!m) continue;
      if (a.action === 'added') {
        seen.add(a.id);
        if (m.locked) plan.push({ id: a.id, do: 'keep', why: 'the user confirmed or edited it', text: m.text });
        else if (m.evidence > 1) plan.push({ id: a.id, do: 'keep', why: `seen ${m.evidence} times since`, text: m.text });
        else plan.push({ id: a.id, do: 'forget', text: m.text });
      } else if (a.action === 'replaced') {
        seen.add(a.id);
        if (m.locked) plan.push({ id: a.id, do: 'keep', why: 'the user confirmed or edited it', text: m.text });
        else if (m.history.length) plan.push({ id: a.id, do: 'undo', text: m.text, back: m.history[m.history.length - 1].text });
      }
    }
  }
  return plan;
}

export function applyRollback(plan, BR) {
  let done = 0;
  for (const p of plan) {
    if (p.do === 'forget') { BR.forget(p.id); done++; }
    if (p.do === 'undo') { BR.resolve(p.id, 'undo'); done++; }
  }
  return done;
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : ''; };
  const [events, brain, model] = [opt('events'), opt('brain'), opt('model')];
  if (!events || !brain || !model) { console.error('usage: --events <db> --brain <db> --model <id> [--apply]'); process.exit(2); }
  const EV = lib('context-events.js'); const BR = lib('brain.js');
  const store = EV.openEventStore({ file: events });
  BR.configure({ file: brain });
  const plan = planRollback(store, BR, model);
  for (const p of plan) console.log(`${p.do.padEnd(6)} ${p.id}  ${p.text}${p.back ? `  ->  ${p.back}` : ''}${p.why ? `  (${p.why})` : ''}`);
  const n = { forget: plan.filter((p) => p.do === 'forget').length, undo: plan.filter((p) => p.do === 'undo').length, keep: plan.filter((p) => p.do === 'keep').length };
  console.log(`\n${model}: forget ${n.forget}, undo ${n.undo}, keep ${n.keep}${args.includes('--apply') ? '' : '  (dry run; --apply to do it)'}`);
  if (args.includes('--apply')) console.log(`applied ${applyRollback(plan, BR)} change(s)`);
  store.close(); BR.close();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
