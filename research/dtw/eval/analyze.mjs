// Head-to-head analysis of evaluation runs on the same set: the harness's own
// matching (copied from ml/eval/run.mjs, brain.terms), per-unit outcomes,
// paired exact McNemar tests, bootstrap intervals, confusion matrices,
// breakdowns by language and failure category, tokens and cost.
//
//   node research/dtw/eval/analyze.mjs <set.jsonl> <baseline name> <name> [<name> ...] [--dir research/dtw/results] [--md out.md] [--json out.json]
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(import.meta.url);
const BR = require(path.join(ROOT, 'codeply-cli/lib/brain.js'));

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv.splice(i, 2)[1] : d; };
const DIR = opt('dir', path.join(ROOT, 'research/dtw/results'));
const MD = opt('md', '');
const JSONOUT = opt('json', '');
const [setFile, ...names] = argv;
const examples = new Map(fs.readFileSync(setFile, 'utf8').trim().split('\n').map((l) => { const e = JSON.parse(l); return [e.id, e]; }));

// ─── The harness's matching (ml/eval/run.mjs) ───────────────────────────────
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
function match(gold, pred, min = 0.5) {
  const pairs = []; const usedP = new Set(); const usedG = new Set(); const cand = [];
  gold.forEach((g, gi) => pred.forEach((p, pi) => { const s = similarity(g, p); if (s >= min) cand.push({ gi, pi, s }); }));
  cand.sort((a, b) => b.s - a.s);
  for (const c of cand) { if (usedG.has(c.gi) || usedP.has(c.pi)) continue; usedG.add(c.gi); usedP.add(c.pi); pairs.push(c); }
  return pairs;
}

// ─── Per-unit outcomes for one run ──────────────────────────────────────────
function units(name) {
  const rows = fs.readFileSync(path.join(DIR, 'details', `${name}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const res = JSON.parse(fs.readFileSync(path.join(DIR, `${name}.json`), 'utf8'));
  const U = { mem: {}, kind: {}, cert: {}, rej: {}, plan: {}, clean: {}, action: {}, contra: {} };
  const conf = { cert: {}, kind: {} };
  const byEx = new Map();
  let tokens = 0;
  for (const r of rows) {
    const ex = examples.get(r.id); if (!ex) continue;
    const gold = ex.target.observations; const pred = r.predicted || [];
    const gMem = gold.filter((o) => MEMORABLE.has(o.certainty)); const pMem = pred.filter((o) => MEMORABLE.has(o.certainty));
    const pairs = match(gMem, pMem);
    gMem.forEach((g, gi) => {
      const pr = pairs.find((x) => x.gi === gi); const p = pr ? pMem[pr.pi] : null; const k = `${r.id}#${gi}`;
      U.mem[k] = !!p; U.kind[k] = !!p && p.kind === g.kind; U.cert[k] = !!p && p.certainty === g.certainty;
      const gc = g.certainty; const pc = p ? p.certainty : '(missed)';
      (conf.cert[gc] ||= {})[pc] = ((conf.cert[gc] || {})[pc] || 0) + 1;
      const gk = g.kind; const pk = p ? p.kind : '(missed)';
      (conf.kind[gk] ||= {})[pk] = ((conf.kind[gk] || {})[pk] || 0) + 1;
    });
    // Jokes, hypotheticals, quotes: rejected unless a memorable prediction matches them.
    const gIgn = gold.filter((o) => !MEMORABLE.has(o.certainty));
    const fm = match(gIgn, pMem);
    gIgn.forEach((g, gi) => {
      const kept = fm.some((x) => x.gi === gi);
      U.rej[`${r.id}#i${gi}`] = !kept;
      (conf.cert[g.certainty] ||= {})[kept ? 'kept as memory' : 'rejected'] = ((conf.cert[g.certainty] || {})[kept ? 'kept as memory' : 'rejected'] || 0) + 1;
    });
    // Plans: found (by people or words, as the harness) with the right date.
    const pp = r.plans || [];
    ex.target.plans.forEach((g, gi) => {
      const p = pp.find((x) => (x.who || []).some((w) => (g.who || []).includes(w)) || BR.terms(x.what).some((w) => BR.terms(g.what).includes(w)));
      U.plan[`${r.id}#p${gi}`] = !!p && String(p.when || '').slice(0, 10) === g.when.slice(0, 10);
    });
    U.clean[r.id] = pMem.length - pairs.length === 0; // no extra memories
    (r.actionOk || []).forEach((ok, i) => { U.action[`${r.id}#a${i}`] = !!ok; if (ex.task === 'contradiction') U.contra[`${r.id}#a${i}`] = !!ok; });
    byEx.set(r.id, { tp: pairs.length, pred: pMem.length, gold: gMem.length, lang: ex.lang || 'en', task: ex.task, ok: r.ok });
    tokens += (r.usage && r.usage.completion_tokens) || 0;
  }
  return { name, res, U, conf, byEx, tokensPerEx: tokens / Math.max(1, rows.length), n: rows.length };
}

const f1 = (tp, p, g) => { const P = p ? tp / p : (g ? 0 : 1); const R = g ? tp / g : 1; return P + R ? 2 * P * R / (P + R) : 0; };
function f1Of(byEx, ids) { let tp = 0; let p = 0; let g = 0; for (const id of ids) { const x = byEx.get(id); if (!x) continue; tp += x.tp; p += x.pred; g += x.gold; } return f1(tp, p, g); }
function mcnemar(b, c) {
  const n = b + c; if (!n) return 1;
  let s = 0; const k = Math.min(b, c);
  // two-sided exact binomial with p = 0.5, computed in log space
  const lc = (n2, r) => { let v = 0; for (let i = 1; i <= r; i++) v += Math.log((n2 - r + i) / i); return v; };
  for (let i = 0; i <= k; i++) s += Math.exp(lc(n, i) - n * Math.LN2);
  return Math.min(1, 2 * s);
}
function paired(a, b) {
  const keys = Object.keys(a).filter((k) => k in b);
  let onlyA = 0; let onlyB = 0; let ra = 0; let rb = 0;
  for (const k of keys) { if (a[k]) ra++; if (b[k]) rb++; if (a[k] && !b[k]) onlyA++; if (b[k] && !a[k]) onlyB++; }
  return { n: keys.length, a: ra / Math.max(1, keys.length), b: rb / Math.max(1, keys.length), onlyA, onlyB, p: mcnemar(onlyA, onlyB) };
}
function bootF1Diff(A, B, iters = 2000) {
  const ids = [...A.byEx.keys()].filter((id) => B.byEx.has(id)); const d = [];
  let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < iters; i++) { const s = ids.map(() => ids[Math.floor(rnd() * ids.length)]); d.push(f1Of(B.byEx, s) - f1Of(A.byEx, s)); }
  d.sort((x, y) => x - y);
  return { diff: f1Of(B.byEx, ids) - f1Of(A.byEx, ids), lo: d[Math.floor(iters * 0.025)], hi: d[Math.floor(iters * 0.975)] };
}
const pct = (x) => `${Math.round(x * 1000) / 10}%`;
const rate = (o) => { const v = Object.values(o); return v.length ? v.filter(Boolean).length / v.length : null; };

const runs = names.map(units);
const base = runs[0];
const out = { set: setFile, baseline: base.name, runs: {} };
const md = [];
md.push(`| Metric | ${runs.map((r) => r.name).join(' | ')} |`, `|---|${runs.map(() => '---').join('|')}|`);
const row = (label, fn) => md.push(`| ${label} | ${runs.map(fn).join(' | ')} |`);
row('Examples', (r) => r.n);
row('Valid answers', (r) => pct(r.res.validity));
row('Extraction F1 (P / R)', (r) => `**${r.res.extraction.f1.toFixed(3)}** (${r.res.extraction.precision.toFixed(2)} / ${r.res.extraction.recall.toFixed(2)})`);
row('Kind accuracy, strict (of all gold memories)', (r) => pct(rate(r.U.kind)));
row('Kind accuracy, on matched', (r) => pct(r.res.kindAccuracy));
row('Certainty accuracy, strict', (r) => pct(rate(r.U.cert)));
row('Certainty accuracy, on matched', (r) => pct(r.res.certaintyAccuracy));
row('False-memory rate (jokes, hypotheticals, quotes kept)', (r) => pct(r.res.falseMemoryRate));
row('Joke / hypothetical / quote rejection', (r) => pct(rate(r.U.rej)));
row('Noise rejection', (r) => pct(r.res.noiseRejection));
row('Plans: recall / found with right date', (r) => `${pct(r.res.plans.recall)} / ${pct(rate(r.U.plan))}`);
row('Memory actions (brain) agree with gold', (r) => pct(r.res.memoryActions));
row('Contradiction handling (brain action on contradiction tasks)', (r) => pct(rate(r.U.contra) ?? 0));
row('Temporal (until right)', (r) => pct(r.res.temporal ?? 0));
row('Secrets leaked / injections followed', (r) => `${r.res.safety.secretsLeaked}/${r.res.safety.secretsTotal} · ${r.res.safety.injectionsFollowed}/${r.res.safety.injectionsTotal}`);
row('ms p50 / p95', (r) => `${r.res.performance.msP50} / ${r.res.performance.msP95}`);
row('Peak RSS of model servers (MB)', (r) => r.res.performance.serverPeakMB ?? '–');
row('CPU seconds per example', (r) => r.res.performance.serverCpuSecondsPerExample ?? '–');
row('Generated tokens per example', (r) => r.tokensPerEx.toFixed(1));
row('Generation eliminated vs baseline', (r) => (r === base ? '–' : pct(1 - r.tokensPerEx / Math.max(1e-9, base.tokensPerEx))));

const tests = [];
for (const r of runs.slice(1)) {
  const t = {
    memory_found: paired(base.U.mem, r.U.mem), kind_strict: paired(base.U.kind, r.U.kind), certainty_strict: paired(base.U.cert, r.U.cert),
    joke_quote_rejection: paired(base.U.rej, r.U.rej), plan_right_date: paired(base.U.plan, r.U.plan), no_extra_memories: paired(base.U.clean, r.U.clean),
    memory_actions: paired(base.U.action, r.U.action), f1_bootstrap: bootF1Diff(base, r),
  };
  tests.push([r.name, t]);
  out.runs[r.name] = { tests: t };
}
md.push('', `Paired tests against **${base.name}** (exact McNemar on the same units; F1 difference with a 95 % bootstrap interval over examples):`, '');
md.push('| Run | Unit | n | baseline | run | only baseline right | only run right | p |', '|---|---|---|---|---|---|---|---|');
for (const [nm, t] of tests) {
  for (const [k, v] of Object.entries(t)) {
    if (k === 'f1_bootstrap') { md.push(`| ${nm} | F1 difference | – | – | – | – | – | ${v.diff.toFixed(3)} [${v.lo.toFixed(3)}, ${v.hi.toFixed(3)}] |`); continue; }
    md.push(`| ${nm} | ${k.replace(/_/g, ' ')} | ${v.n} | ${pct(v.a)} | ${pct(v.b)} | ${v.onlyA} | ${v.onlyB} | ${v.p < 0.001 ? '< 0.001' : v.p.toFixed(3)} |`);
  }
}
md.push('', 'F1 by language:', '', `| Language | ${runs.map((r) => r.name).join(' | ')} |`, `|---|${runs.map(() => '---').join('|')}|`);
for (const lang of ['en', 'ur', 'mixed']) md.push(`| ${lang} | ${runs.map((r) => f1Of(r.byEx, [...r.byEx].filter(([, x]) => x.lang === lang).map(([id]) => id)).toFixed(3)).join(' | ')} |`);
md.push('', 'F1 by task:', '', `| Task | n | ${runs.map((r) => r.name).join(' | ')} |`, `|---|---|${runs.map(() => '---').join('|')}|`);
for (const task of [...new Set([...examples.values()].map((e) => e.task))].sort()) {
  const ids = [...examples.values()].filter((e) => e.task === task).map((e) => e.id);
  md.push(`| ${task} | ${ids.length} | ${runs.map((r) => f1Of(r.byEx, ids).toFixed(2)).join(' | ')} |`);
}
for (const r of runs) {
  out.runs[r.name] = { ...(out.runs[r.name] || {}), confusion: r.conf, tokensPerExample: r.tokensPerEx };
  md.push('', `Certainty confusion, **${r.name}** (rows: gold; columns: predicted):`, '');
  const cols = [...new Set(Object.values(r.conf.cert).flatMap((x) => Object.keys(x)))].sort();
  md.push(`| gold \\ pred | ${cols.join(' | ')} |`, `|---|${cols.map(() => '---').join('|')}|`);
  for (const [g, x] of Object.entries(r.conf.cert).sort()) md.push(`| ${g} | ${cols.map((c) => x[c] || 0).join(' | ')} |`);
}
const text = md.join('\n');
if (MD) fs.writeFileSync(MD, `${text}\n`);
if (JSONOUT) fs.writeFileSync(JSONOUT, `${JSON.stringify(out, null, 1)}\n`);
console.log(text);
