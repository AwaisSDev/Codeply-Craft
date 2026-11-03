// Opt-in feedback, counts only: what one model did to this user's brain and what the user did about it.
// Runs on the tester's machine, reads only their local stores, prints numbers (never memory text), so a tester
// can share the output without sharing their memories.
//
//   node release/memory-model/optin-report.mjs --events <context events db> --brain <brain db> --model <model id> [--json]
//
// Signals for the opt-in decision (DEPLOYMENT.md §2 step 6): share of the model's memories the user later
// forgot or corrected, pending memories confirmed vs expired, backend failures and latency.
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const lib = (n) => require(path.join(ROOT, 'codeply-cli/lib', n));

const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : null);
const quantile = (xs, q) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

/** Counts for one model, from an open event store and an open brain. */
export function optInReport(store, BR, model, limit = 100000) {
  const r = { model, batches: 0, failed: 0, observations: {}, tiers: { pending: 0, discarded: 0 }, latencyMs: { p50: null, p95: null },
    written: 0, now: { confirmed: 0, tentative: 0, temporary: 0, gone: 0 }, user: { forgot: 0, corrected: 0, confirmed: 0 } };
  const ms = []; const ids = new Set();
  for (const e of store.recent(limit)) {
    if (e.model !== model) continue;
    if (e.status === 'failed') { r.failed++; continue; }
    if (!e.outcome) continue;
    const batch = (e.outcome.batch && e.outcome.batch[0]) || e.id;
    if (batch !== e.id) continue; // count each batch once (every event of a batch carries its outcome)
    r.batches++;
    if (Number.isFinite(e.outcome.ms)) ms.push(e.outcome.ms);
    if (e.outcome.tiers) { r.tiers.pending += e.outcome.tiers.pending || 0; r.tiers.discarded += e.outcome.tiers.discarded || 0; }
    for (const a of e.outcome.actions || []) {
      r.observations[a.action] = (r.observations[a.action] || 0) + 1;
      if (a.id && (a.action === 'added' || a.action === 'replaced')) ids.add(a.id);
    }
  }
  r.latencyMs = { p50: quantile(ms, 0.5), p95: quantile(ms, 0.95) };
  r.written = ids.size;
  for (const id of ids) {
    const m = BR.get(id);
    if (!m) r.now.gone++; else r.now[m.status] = (r.now[m.status] || 0) + 1;
    const story = BR.changes({ id }).filter((c) => c.source === 'you');
    if (story.some((c) => c.action === 'forgotten')) r.user.forgot++;
    else if (story.some((c) => c.action === 'corrected' && !/^confirmed /.test(c.text))) r.user.corrected++;
    else if (story.some((c) => c.action === 'corrected' || c.action === 'confirmed')) r.user.confirmed++;
  }
  r.rates = { forgotOrCorrectedPct: pct(r.user.forgot + r.user.corrected, r.written), confirmedByUserPct: pct(r.user.confirmed, r.written), failedBatchPct: pct(r.failed, r.failed + r.batches) };
  return r;
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : ''; };
  const [events, brain, model] = [opt('events'), opt('brain'), opt('model')];
  if (!events || !brain || !model) { console.error('usage: --events <db> --brain <db> --model <id> [--json]'); process.exit(2); }
  const store = lib('context-events.js').openEventStore({ file: events });
  const BR = lib('brain.js'); BR.configure({ file: brain });
  const r = optInReport(store, BR, model);
  store.close(); BR.close();
  if (args.includes('--json')) { console.log(JSON.stringify(r, null, 1)); return; }
  console.log(`${model}: ${r.batches} batches (${r.failed} failed), latency p50 ${r.latencyMs.p50} ms / p95 ${r.latencyMs.p95} ms`);
  console.log(`observations: ${Object.entries(r.observations).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}; pending ${r.tiers.pending}, discarded ${r.tiers.discarded}`);
  console.log(`memories written: ${r.written}; now confirmed ${r.now.confirmed}, tentative ${r.now.tentative}, gone ${r.now.gone}`);
  console.log(`user: forgot ${r.user.forgot}, corrected ${r.user.corrected}, confirmed ${r.user.confirmed}  (forgot or corrected: ${r.rates.forgotOrCorrectedPct ?? '-'} %)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
