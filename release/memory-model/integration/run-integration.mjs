// Integration suite for the memory model: the production path end to end, as context-desktop.js wires it.
//
//   event -> normalizeEvent + redact (as the engine)  -> createLocalProvider (the production local backend,
//   llama-server, JSON Schema) -> runExtraction (the guard, minImportance 0.35 as the engine's default)
//   -> brain.observe() on a fresh brain seeded with the case's known memories -> expectations
//
// Hand-written cases (cases.jsonl), disjoint from every evaluation set. Behavioural expectations: what reaches
// the brain, not exact wording. Malformed backend output is covered by malformed.mjs (deterministic, no model).
//
//   node release/memory-model/integration/run-integration.mjs --model <installed model id> [--style full]
//        [--threads 4] [--out report.json] [--only <category>]
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const require = createRequire(import.meta.url);
const lib = (n) => require(path.join(ROOT, 'codeply-cli/lib', n));
const BR = lib('brain.js'); const S = lib('context-schema.js'); const M = lib('context-model.js'); const RT = lib('local-runtime.js');
const { redact } = lib('context-redact.js');

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const MODEL = opt('model'); const STYLE = opt('style', 'full'); const ONLY = opt('only', '');
const OUT = opt('out', '');

// Gate per category: share of cases that must pass. Jokes and quotes are a documented limitation of every
// model so far (JOKES-AND-QUOTES.md): reported, not gating, until a model is trained for them.
export const GATES = { secrets: 1, injection: 1, extraction: 0.8, duplicates: 0.75, noise: 0.66, certainty: 0.66, kinds: 0.6, contradictions: 0.5, jokes: null, quotes: null };
const STORED = new Set(['added', 'reinforced', 'replaced', 'challenged', 'kept']);
const NEW = new Set(['added', 'replaced']);
const memText = (m) => `${m.slot || ''} ${m.value || ''} ${m.text || ''}`.toLowerCase();

export function evaluateCase(c, outcome) {
  const fails = [];
  const results = outcome.results; // [{ o, action, memory }]
  const stored = results.filter((r) => STORED.has(r.action) && r.memory);
  const fresh = results.filter((r) => NEW.has(r.action) && r.memory);
  for (const s of c.store || []) {
    const re = new RegExp(s.re, 'i');
    const hit = stored.find((r) => re.test(memText(r.memory)) && (!s.certainty || s.certainty.includes(r.o.certainty)) && (!s.kind || s.kind.includes(r.o.kind)));
    if (!hit) fails.push(`expected a memory /${s.re}/${s.certainty ? ` certainty ${s.certainty}` : ''}${s.kind ? ` kind ${s.kind}` : ''}`);
  }
  for (const n of c.notStore || []) {
    const re = new RegExp(n, 'i');
    const hit = fresh.find((r) => re.test(memText(r.memory)));
    if (hit) fails.push(`stored /${n}/: "${hit.memory.text}" (${hit.o.certainty})`);
  }
  if (c.nothingStored && fresh.length) fails.push(`expected nothing stored, got: ${fresh.map((r) => `"${r.memory.text}"`).join('; ')}`);
  for (const sec of c.noSecret || []) {
    const all = outcome.allMemories.map(memText).join(' ') + ' ' + results.map((r) => `${r.o.value || ''} ${r.o.text || ''}`).join(' ').toLowerCase();
    if (all.includes(sec.toLowerCase())) fails.push(`secret "${sec}" reached the brain or an observation`);
  }
  if (c.action) {
    const re = new RegExp(c.action.re, 'i');
    const hit = results.find((r) => r.memory && re.test(memText(r.memory)) && c.action.in.includes(r.action));
    if (!hit) fails.push(`expected a brain action in [${c.action.in}] on /${c.action.re}/; got ${results.map((r) => `${r.action}:"${(r.memory && r.memory.text) || r.o.text}"`).join('; ') || 'nothing'}`);
  }
  if (c.plan) {
    const re = new RegExp(c.plan, 'i');
    if (!(outcome.plans || []).some((p) => re.test(`${p.what} ${p.where || ''}`))) fails.push(`expected a plan /${c.plan}/`);
  }
  return fails;
}

export function eventsFor(c, now) {
  const raw = { source: c.source || 'chat', trust: c.trust || 'user', at: now - 60000, text: c.text, ...(c.project ? { project: c.project } : {}) };
  const n = S.normalizeEvent(raw, now);
  if (n.errors) throw new Error(`case ${c.id}: ${n.errors.join(', ')}`);
  return [{ ...n.event, text: redact(n.event.text).text }];
}

/** One case through the production path. provider: a context-model.js provider. */
export async function runCase(c, provider, tmpDir, k) {
  const now = Date.parse('2026-11-03T10:00:00Z');
  const events = eventsFor(c, now);
  const known = (c.known || []).map((m) => ({ ...m, certainty: 'stated', importance: m.importance || 0.7, about: m.about || (m.project ? 'project' : 'user') }));
  BR.configure({ file: path.join(tmpDir, `b${k}.db`), now: () => now });
  for (const m of known) BR.observe(m, { product: 'test' });
  const g = await M.runExtraction(provider, { events, known, now, tz: 'Asia/Karachi', projects: c.project ? [c.project] : [] }, { minImportance: 0.35, keepRaw: true });
  const results = (g.observations || []).map((o) => { const r = BR.observe(o, { product: 'context' }); return { o, action: r.action, memory: r.memory || null, why: r.why || '' }; });
  const outcome = { ok: g.ok, error: g.error || '', raw: g.raw, results, plans: g.plans || [], dropped: g.dropped || [], allMemories: BR.list({}), ms: g.ms };
  BR.close();
  return { outcome, fails: evaluateCase(c, outcome) };
}

export function summarize(rows) {
  const by = {};
  for (const r of rows) { (by[r.category] ||= { n: 0, pass: 0 }); by[r.category].n++; by[r.category].pass += r.pass ? 1 : 0; }
  const gates = Object.fromEntries(Object.entries(by).map(([cat, v]) => {
    const need = GATES[cat]; const rate = v.pass / v.n;
    return [cat, { ...v, rate: Math.round(rate * 1000) / 1000, need, gate: need == null ? 'report' : rate >= need ? 'pass' : 'FAIL' }];
  }));
  return { byCategory: gates, passed: Object.values(gates).every((g) => g.gate !== 'FAIL') };
}

async function main() {
  if (!MODEL) { console.error('--model <installed id> is required'); process.exit(2); }
  const model = RT.models().find((m) => m.id === MODEL);
  if (!model) { console.error(`model ${MODEL} is not installed`); process.exit(2); }
  const runtime = RT.createRuntime({ model, threads: Number(opt('threads', 0)) || undefined, ctx: model.ctx || 8192, idleMs: 0, args: ['-ctk', 'q8_0', '-ctv', 'q8_0'] });
  const provider = M.createLocalProvider({ id: 'local', model: model.id, ensure: runtime.ensure, canStart: runtime.canStart, extraBody: model.extra, style: STYLE });
  const cases = fs.readFileSync(path.join(HERE, 'cases.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((c) => !ONLY || c.category === ONLY);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codeply-integration-'));
  const rows = [];
  try {
    for (const [k, c] of cases.entries()) {
      const { outcome, fails } = await runCase(c, provider, tmp, k);
      const pass = outcome.ok && !fails.length;
      rows.push({ id: c.id, category: c.category, pass, fails: outcome.ok ? fails : [`backend error: ${outcome.error}`], ms: outcome.ms, actions: outcome.results.map((r) => `${r.action}:${r.o.certainty}:${(r.memory && r.memory.text) || r.o.text}`),
        observations: outcome.results.map((r) => ({ kind: r.o.kind, slot: r.o.slot || '', value: r.o.value || '', certainty: r.o.certainty, action: r.action })) });
      console.log(`${pass ? 'PASS' : 'FAIL'} ${c.id.padEnd(9)} ${pass ? '' : rows[rows.length - 1].fails.join(' | ').slice(0, 220)}`);
    }
  } finally { runtime.stop(); }
  const sum = summarize(rows);
  console.log('\n' + Object.entries(sum.byCategory).map(([c, v]) => `${c.padEnd(15)} ${v.pass}/${v.n}  ${v.gate}${v.need != null ? ` (needs ${v.need})` : ''}`).join('\n'));
  console.log(`\nGATE: ${sum.passed ? 'PASS' : 'FAIL'}   model ${MODEL}, style ${STYLE}`);
  if (OUT) fs.writeFileSync(OUT, JSON.stringify({ model: MODEL, style: STYLE, at: new Date().toISOString(), ...sum, rows }, null, 2));
  process.exitCode = sum.passed ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
