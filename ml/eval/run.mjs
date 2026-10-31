// Evaluate a context-intelligence backend on a dataset split, through the
// same path the app uses: normalize, redact, prompt, backend, guard, brain.
//
//   node ml/eval/run.mjs --provider rules                     [--set test-mini] [--limit N]
//   node ml/eval/run.mjs --provider local:qwen3-1.7b-q4       (starts llama-server via local-runtime.js)
//   node ml/eval/run.mjs --provider module:research/dtw/runtime/dtw-provider.mjs --name dtw-x   (an experimental backend file)
//   node ml/eval/run.mjs --provider local:qwen3-0.6b-q4 --no-schema   (plain JSON mode, no grammar; result name gets -noschema)
//   node ml/eval/run.mjs --provider openai --base-url http://127.0.0.1:11434/v1 --model qwen3:1.7b
//   CONTEXT_EVAL_API_KEY=... node ml/eval/run.mjs --provider openai --base-url https://... --model ...   (a cloud model, if you have a key)
//
// Sets: test-mini (92, every task), test (800), val (800), gold (hand-written,
// ml/eval/gold.jsonl). Writes ml/results/<name>.json; ml/eval/report.mjs
// turns all results into one table.
//
// Metrics (ml/eval/README.md has the definitions):
//   validity          the answer parsed and had an observations list
//   extraction        precision / recall / F1 of memorable observations (stated, implied, temporary)
//   kind, certainty   accuracy on matched pairs
//   false memories    jokes, hypotheticals and quotes the backend recorded as memorable
//   noise             examples with nothing to keep where nothing memorable came back
//   plans             precision / recall, and the date and time right
//   memory actions    the brain's action (added, reinforced, replaced, challenged, ignored) from the
//                     backend's answer equals the action from the gold answer, on the same seeded brain
//   temporal          live context with the right end time
//   importance        Spearman correlation with the gold importance
//   safety            secrets that reached memory; injected instructions that became memory
//   performance       latency per example, server CPU seconds and peak RSS
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const require = createRequire(import.meta.url);
const lib = (n) => require(path.join(ROOT, 'codeply-cli/lib', n));
const BR = lib('brain.js');
const S = lib('context-schema.js');
const M = lib('context-model.js');
const RT = lib('local-runtime.js');
const { redact } = lib('context-redact.js');
const { PROMPT_VERSION } = lib('context-prompt.js');

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const SET = opt('set', 'test-mini');
const PROVIDER = opt('provider', 'rules');
const LIMIT = Number(opt('limit', 0));
const STYLE = opt('style', 'full');
const SCHEMA = !args.includes('--no-schema');
const NAME = opt('name', `${PROVIDER.replace(/[^a-z0-9.-]+/gi, '_')}-${SET}${STYLE !== 'full' ? `-${STYLE}` : ''}${SCHEMA ? '' : '-noschema'}${PROMPT_VERSION > 1 ? `-p${PROMPT_VERSION}` : ''}`);
const OUT = path.resolve(opt('out', path.join(ROOT, 'ml/results')));
const THREADS = Number(opt('threads', 0)) || undefined;
const CTX = Number(opt('ctx', 4096));

// --set-file: any set in the same format (e.g. research/dtw/benchmark/bench.jsonl); --set then only names the run.
const setFile = opt('set-file') ? path.resolve(opt('set-file')) : SET === 'gold' ? path.join(HERE, 'gold.jsonl') : path.join(ROOT, 'ml/data/out', `${SET}.jsonl`);
let examples = fs.readFileSync(setFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
if (LIMIT) examples = examples.slice(0, LIMIT);

// ─── The backend ────────────────────────────────────────────────────────────

let runtime = null;
let extraRuntimes = []; // module providers may run more than one server (e.g. an encoder and a writer)
async function makeProvider() {
  if (PROVIDER === 'rules') return M.createRulesProvider();
  if (PROVIDER.startsWith('local:')) {
    const id = PROVIDER.slice(6);
    const model = RT.models().find((m) => m.id === id);
    if (!model) throw new Error(`Model ${id} is not installed (node scripts/context/fetch-model.mjs ${id}).`);
    runtime = RT.createRuntime({ model, threads: THREADS, ctx: CTX, idleMs: 0, args: ['-ctk', 'q8_0', '-ctv', 'q8_0'] });
    return M.createLocalProvider({ id, model: id, ensure: runtime.ensure, canStart: runtime.canStart, extraBody: model.extra, style: STYLE, schema: SCHEMA, timeoutMs: 300000 });
  }
  if (PROVIDER.startsWith('module:')) {
    // An experimental backend in its own file: export createProvider(ctx) -> { provider, runtimes? }.
    const mod = await import(path.resolve(PROVIDER.slice(7)));
    const made = await mod.createProvider({ args, opt, RT, M, S, threads: THREADS, ctx: CTX });
    extraRuntimes = made.runtimes || [];
    return made.provider;
  }
  if (PROVIDER === 'openai') {
    const baseUrl = opt('base-url', process.env.CONTEXT_EVAL_BASE_URL);
    const model = opt('model', process.env.CONTEXT_EVAL_MODEL);
    const apiKey = process.env.CONTEXT_EVAL_API_KEY || '';
    if (!baseUrl || !model) throw new Error('--base-url and --model are needed');
    if (M.isLocalUrl(baseUrl)) return M.createLocalProvider({ baseUrl, model, apiKey, style: STYLE, schema: SCHEMA });
    // A remote model: the cloud backend over a plain OpenAI-compatible call (only with a key you have).
    const chatJson = async (messages) => {
      const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ model, messages, temperature: 0, response_format: { type: 'json_object' } }) });
      if (!res.ok) return { success: false, error: `HTTP ${res.status}` };
      const data = await res.json();
      return { success: true, json: S.parseJsonObject(data.choices[0].message.content), usage: data.usage, modelUsed: model };
    };
    return M.createCloudProvider({ chatJson, model, style: STYLE });
  }
  throw new Error(`Unknown provider ${PROVIDER}`);
}

// ─── Matching ───────────────────────────────────────────────────────────────

const MEMORABLE = new Set(['stated', 'implied', 'temporary']);
const termsOf = (o) => BR.terms(`${o.slot} ${o.value}`);
function similarity(g, p) {
  const gt = termsOf(g); const pt = new Set([...termsOf(p), ...BR.terms(p.text)]);
  if (!gt.length) return 0;
  const hit = gt.filter((w) => pt.has(w)).length / gt.length;
  const vt = BR.terms(g.value);
  const vhit = vt.length ? vt.filter((w) => pt.has(w)).length / vt.length : 0;
  return Math.max(hit, vhit);
}
/** Greedy one-to-one matching of predicted to gold observations. */
function match(gold, pred, min = 0.5) {
  const pairs = []; const usedP = new Set();
  const cand = [];
  gold.forEach((g, gi) => pred.forEach((p, pi) => { const s = similarity(g, p); if (s >= min) cand.push({ gi, pi, s }); }));
  cand.sort((a, b) => b.s - a.s);
  const usedG = new Set();
  for (const c of cand) { if (usedG.has(c.gi) || usedP.has(c.pi)) continue; usedG.add(c.gi); usedP.add(c.pi); pairs.push(c); }
  return pairs;
}
function spearman(xs, ys) {
  if (xs.length < 3) return null;
  const rank = (a) => { const s = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = Array(a.length); s.forEach(([, i], k) => { r[i] = k; }); return r; };
  const rx = rank(xs); const ry = rank(ys); const n = xs.length;
  const d2 = rx.reduce((s, r, i) => s + (r - ry[i]) ** 2, 0);
  return 1 - (6 * d2) / (n * (n * n - 1));
}

// ─── Brain end to end ───────────────────────────────────────────────────────

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codeply-eval-'));
let brainN = 0;
/** The brain's action for each observation, on a fresh brain seeded with the known memories. */
function brainActions(ex, observations, now) {
  BR.configure({ file: path.join(tmp, `b${brainN++}.db`), now: () => now });
  for (const k of ex.input.known || []) BR.observe({ ...k, certainty: 'stated' }, { product: 'eval' });
  return observations.map((o) => BR.observe(o, { product: 'eval' }).action);
}

// ─── Run ────────────────────────────────────────────────────────────────────

/** CPU seconds a process has used (Linux /proc; utime + stime in clock ticks of 1/100 s). */
const pidCpu = (pid) => { try { const f = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' '); return (Number(f[11]) + Number(f[12])) / 100; } catch { return null; } };

/** Every metric for one example, from the guarded answer r = { ok, observations, plans, dropped, ... }. */
function score(ex, r) {
  const now = Date.parse(ex.input.now);
  const gold = ex.target.observations;
  const pred = r.observations;
  const gMem = gold.filter((o) => MEMORABLE.has(o.certainty));
  const pMem = pred.filter((o) => MEMORABLE.has(o.certainty));
  const pairs = match(gMem, pMem);
  // Ignored-certainty gold (jokes etc.) recorded as memorable by the backend = a false memory.
  const gIgn = gold.filter((o) => !MEMORABLE.has(o.certainty));
  const falseMem = match(gIgn, pMem).length;
  // Plans
  const pp = r.plans || [];
  const planPairs = [];
  for (const g of ex.target.plans) {
    const p = pp.find((x) => (x.who || []).some((w) => g.who.includes(w)) || BR.terms(x.what).some((w) => BR.terms(g.what).includes(w)));
    if (p) planPairs.push({ g, p, date: String(p.when || '').slice(0, 10) === g.when.slice(0, 10), time: String(p.when || '').slice(11, 16) === g.when.slice(11, 16) });
  }
  // Brain actions: gold vs backend, per gold observation (matched by slot/value)
  let actionOk = null;
  if (gold.length && ['duplicate', 'contradiction', 'preference', 'decision', 'temporary', 'joking', 'hypothetical', 'quoting'].includes(ex.task)) {
    const ga = brainActions(ex, gold, now);
    const pa = brainActions(ex, pred, now);
    const allPairs = match(gold, pred, 0.5);
    actionOk = gold.map((g, gi) => { const pr = allPairs.find((x) => x.gi === gi); const want = ga[gi]; const got = pr ? pa[pr.pi] : 'ignored'; return want === got; });
  }
  // Temporal: live context end time
  const temporal = gMem.filter((g) => g.kind === 'context').map((g) => { const pr = pairs.find((x) => gMem[x.gi] === g); const p = pr ? pMem[pr.pi] : null; return !!p && p.kind === 'context' && String(p.until || '').slice(0, 16) === String(g.until || '').slice(0, 16); });
  // Safety
  const memText = pMem.map((o) => `${o.slot} ${o.value} ${o.text}`).join(' ').toLowerCase();
  const leaked = (ex.expect.secrets || []).filter((s) => s && memText.includes(String(s).toLowerCase())).length;
  const injected = ex.expect.injected ? (() => { const t = BR.terms(ex.expect.injected); return t.filter((w) => memText.includes(w)).length >= Math.min(2, t.length); })() : null;
  return {
    id: ex.id, task: ex.task, unseen: !!ex.unseen, ok: r.ok, error: r.error || '', ms: r.ms || 0,
    usage: r.usage || {}, gold: gMem.length, pred: pMem.length, tp: pairs.length,
    kindOk: pairs.filter((x) => gMem[x.gi].kind === pMem[x.pi].kind).length,
    certOk: pairs.filter((x) => gMem[x.gi].certainty === pMem[x.pi].certainty).length,
    imp: pairs.map((x) => [gMem[x.gi].importance, pMem[x.pi].importance]),
    falseMem, ignGold: gIgn.length, empty: gold.length === 0 && ex.target.plans.length === 0, emptyOk: pMem.length === 0 && pp.length === 0,
    plansGold: ex.target.plans.length, plansPred: pp.length, plansTp: planPairs.length, planDate: planPairs.filter((x) => x.date).length, planTime: planPairs.filter((x) => x.time).length,
    actionOk, temporal, leaked, secrets: (ex.expect.secrets || []).length, injected,
    dropped: (r.dropped || []).map((d) => d.why),
    raw: typeof r.raw === 'string' ? r.raw : JSON.stringify(r.raw === undefined ? null : r.raw),
    predicted: pred, plans: pp,
  };
}

const eventsOf = (ex) => { const now = Date.parse(ex.input.now); return ex.input.events.map((e) => { const n = S.normalizeEvent({ ...e, at: Date.parse(e.at) }, now).event; return { ...n, text: redact(n.text).text }; }); };

/**
 * --rescore: the stored answers of an earlier run (details/<name>.jsonl) through
 * today's guard and metrics, without running the model again. Runs before the
 * full raw answer was kept are re-guarded from their stored observations; their
 * plan metrics are kept as they were (their plans were not stored).
 */
function rescoreRows() {
  const byId = new Map(examples.map((e) => [e.id, e]));
  const old = fs.readFileSync(path.join(OUT, 'details', `${NAME}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return old.filter((row) => byId.has(row.id)).map((row) => {
    const ex = byId.get(row.id);
    const events = eventsOf(ex);
    const full = row.plans ? S.parseJsonObject(row.raw) : null;
    const g = full ? S.checkExtraction(full, { events }) : S.checkExtraction({ observations: row.predicted, plans: row.plans || [] }, { events });
    const r = { ...g, ok: row.ok, error: row.error, ms: row.ms, usage: row.usage, raw: row.raw };
    if (!row.ok) { r.observations = []; r.plans = []; }
    const out = score(ex, r);
    if (!row.plans) Object.assign(out, { plansPred: row.plansPred, plansTp: row.plansTp, planDate: row.planDate, planTime: row.planTime, emptyOk: out.pred === 0 && !row.plansPred, plans: undefined });
    return out;
  });
}

async function main() {
  const rescore = args.includes('--rescore');
  const prev = rescore ? JSON.parse(fs.readFileSync(path.join(OUT, `${NAME}.json`), 'utf8')) : null;
  const provider = rescore ? null : await makeProvider();
  if (runtime) await runtime.ensure();
  for (const r of extraRuntimes) await r.ensure();
  const servers = () => [runtime, ...extraRuntimes].filter(Boolean);
  const cpuAll = () => { const v = servers().map((r) => pidCpu(r.status().pid)); return v.length && v.every((x) => x != null) ? v.reduce((a, b) => a + b, 0) : null; };
  const cpu0 = cpuAll();
  const rows = rescore ? rescoreRows() : [];
  const t0 = Date.now();
  for (const [i, ex] of (rescore ? [] : examples).entries()) {
    const now = Date.parse(ex.input.now);
    const events = eventsOf(ex);
    const r = await M.runExtraction(provider, { events, known: ex.input.known, now, tz: ex.input.tz, projects: [...new Set(events.map((e) => e.project).filter(Boolean))] }, { keepRaw: true });
    rows.push(score(ex, r));
    if (process.stdout.isTTY || (i + 1) % 10 === 0) process.stdout.write(`\r${i + 1}/${examples.length} (${Math.round((Date.now() - t0) / (i + 1))} ms/ex)   `);
  }
  const statuses = servers().map((r) => r.status());
  const status = statuses.length ? { lastStartMs: statuses[0].lastStartMs, memory: statuses.every((x) => x.memory) ? { peakMB: statuses.reduce((n, x) => n + x.memory.peakMB, 0) } : null } : null;
  const cpu1 = cpuAll();
  for (const r of servers()) r.stop();
  console.log('');

  // ─── Aggregate ──────────────────────────────────────────────────────────
  const sum = (k, rs = rows) => rs.reduce((n, r) => n + (Number(r[k]) || 0), 0);
  const prf = (rs) => { const tp = sum('tp', rs); const p = sum('pred', rs); const g = sum('gold', rs); const P = p ? tp / p : (g ? 0 : 1); const R = g ? tp / g : 1; return { precision: round(P), recall: round(R), f1: round(P + R ? 2 * P * R / (P + R) : 0), gold: g, pred: p, tp }; };
  const round = (x) => (x == null || Number.isNaN(x) ? null : Math.round(x * 1000) / 1000);
  const rate = (arr) => (arr.length ? round(arr.filter(Boolean).length / arr.length) : null);
  const tasks = [...new Set(rows.map((r) => r.task))].sort();
  const imp = rows.flatMap((r) => r.imp);
  const lat = rows.map((r) => r.ms).sort((a, b) => a - b);
  const result = {
    name: NAME, provider: PROVIDER, set: SET, style: STYLE, schema: SCHEMA, promptVersion: PROMPT_VERSION, examples: rows.length, at: new Date().toISOString(),
    host: { cpu: os.cpus()[0] && os.cpus()[0].model, logical: os.cpus().length, ramMB: Math.round(os.totalmem() / 1048576), threads: THREADS || (runtime ? RT.pickThreads() : null), ctx: runtime ? CTX : null },
    validity: rate(rows.map((r) => r.ok)),
    extraction: prf(rows),
    extractionUnseen: prf(rows.filter((r) => r.unseen)),
    kindAccuracy: round(sum('kindOk') / Math.max(1, sum('tp'))),
    certaintyAccuracy: round(sum('certOk') / Math.max(1, sum('tp'))),
    falseMemoryRate: round(sum('falseMem') / Math.max(1, sum('ignGold'))),
    noiseRejection: rate(rows.filter((r) => r.empty).map((r) => r.emptyOk)),
    plans: { precision: round(sum('plansTp') / Math.max(1, sum('plansPred'))), recall: round(sum('plansTp') / Math.max(1, sum('plansGold'))), dateAccuracy: round(sum('planDate') / Math.max(1, sum('plansTp'))), timeAccuracy: round(sum('planTime') / Math.max(1, sum('plansTp'))) },
    memoryActions: rate(rows.flatMap((r) => r.actionOk || [])),
    memoryActionsByTask: Object.fromEntries(['duplicate', 'contradiction', 'joking', 'hypothetical', 'quoting'].map((t) => [t, rate(rows.filter((r) => r.task === t).flatMap((r) => r.actionOk || []))])),
    temporal: rate(rows.flatMap((r) => r.temporal)),
    importanceSpearman: round(spearman(imp.map((x) => x[0]), imp.map((x) => x[1]))),
    importanceMAE: imp.length ? round(imp.reduce((s, [a, b]) => s + Math.abs(a - b), 0) / imp.length) : null,
    safety: { secretsLeaked: sum('leaked'), secretsTotal: sum('secrets'), injectionsFollowed: rows.filter((r) => r.injected === true).length, injectionsTotal: rows.filter((r) => r.injected !== null).length },
    byTask: Object.fromEntries(tasks.map((t) => { const rs = rows.filter((r) => r.task === t); return [t, { n: rs.length, ...prf(rs), validity: rate(rs.map((r) => r.ok)) }]; })),
    performance: {
      msMean: Math.round(sum('ms') / Math.max(1, rows.length)), msP50: lat[Math.floor(lat.length / 2)] || 0, msP95: lat[Math.floor(lat.length * 0.95)] || 0,
      promptTokensMean: Math.round(sum('pt', rows.map((r) => ({ pt: r.usage.prompt_tokens || 0 }))) / Math.max(1, rows.length)),
      completionTokensMean: Math.round(sum('ct', rows.map((r) => ({ ct: r.usage.completion_tokens || 0 }))) / Math.max(1, rows.length)),
      serverPeakMB: status && status.memory ? status.memory.peakMB : null, serverStartMs: status ? status.lastStartMs : null,
      serverCpuSecondsPerExample: cpu0 != null && cpu1 != null ? round((cpu1 - cpu0) / Math.max(1, rows.length)) : null,
      wallSeconds: Math.round((Date.now() - t0) / 1000),
    },
    errors: rows.filter((r) => !r.ok).slice(0, 5).map((r) => ({ id: r.id, error: r.error, raw: String(r.raw || '').slice(0, 600) })),
  };
  // A rescore keeps the measured run's speed and machine; only the scoring is new.
  if (prev) Object.assign(result, { performance: prev.performance, host: prev.host, at: prev.at, rescoredAt: new Date().toISOString() });
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `${NAME}.json`), `${JSON.stringify(result, null, 2)}\n`);
  fs.mkdirSync(path.join(OUT, 'details'), { recursive: true });
  fs.writeFileSync(path.join(OUT, 'details', `${NAME}.jsonl`), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  const { byTask, errors, ...head } = result;
  console.log(JSON.stringify(head, null, 1));
  fs.rmSync(tmp, { recursive: true, force: true });
}

main().catch((e) => { console.error(e.stack || e.message); for (const r of [runtime, ...extraRuntimes]) if (r) r.stop(); process.exit(1); });
