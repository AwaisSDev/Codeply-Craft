// Inter-annotator agreement between the benchmark labels (A) and a blind
// second annotator (B) on the same 100 examples, with the harness's matching.
//   node agreement.mjs a.jsonl b.jsonl      (both in the built harness format)
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const require = createRequire(import.meta.url);
const BR = require(path.join(ROOT, 'codeply-cli/lib/brain.js'));
const load = (f) => new Map(fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => { const e = JSON.parse(l); return [e.id, e]; }));
const A = load(process.argv[2]); const B = load(process.argv[3]);
const MEM = new Set(['stated', 'implied', 'temporary']);
const termsOf = (o) => BR.terms(`${o.slot} ${o.value}`);
function sim(g, p) {
  const gt = termsOf(g); const pt = new Set([...termsOf(p), ...BR.terms(p.text)]);
  if (!gt.length) return 0;
  const vt = BR.terms(g.value);
  return Math.max(gt.filter((w) => pt.has(w)).length / gt.length, vt.length ? vt.filter((w) => pt.has(w)).length / vt.length : 0);
}
function match(a, b) {
  const c = []; a.forEach((x, i) => b.forEach((y, j) => { const s = Math.max(sim(x, y), sim(y, x)); if (s >= 0.5) c.push({ i, j, s }); }));
  c.sort((x, y) => y.s - x.s); const ui = new Set(); const uj = new Set(); const out = [];
  for (const m of c) { if (ui.has(m.i) || uj.has(m.j)) continue; ui.add(m.i); uj.add(m.j); out.push(m); }
  return out;
}
function kappa(pairs) {
  const n = pairs.length; if (!n) return null;
  const po = pairs.filter(([x, y]) => x === y).length / n;
  const labels = [...new Set(pairs.flat())];
  const pe = labels.reduce((s, l) => s + (pairs.filter(([x]) => x === l).length / n) * (pairs.filter(([, y]) => y === l).length / n), 0);
  return { n, agreement: Math.round(po * 1000) / 1000, kappa: pe < 1 ? Math.round(((po - pe) / (1 - pe)) * 1000) / 1000 : 1 };
}
const decision = (t) => { const o = t.observations; if (!o.length) return t.plans.length ? 'plan' : 'none'; return [...o].sort((x, y) => y.importance - x.importance)[0].certainty; };
let itemsA = 0; let itemsB = 0; let matched = 0; let memA = 0; let memB = 0; let memBoth = 0;
const kindP = []; const certP = []; const keepP = []; const decP = []; let plA = 0; let plB = 0; let plM = 0; let plDate = 0;
for (const [id, a] of A) {
  const b = B.get(id); if (!b) continue;
  const oa = a.target.observations; const ob = b.target.observations;
  itemsA += oa.length; itemsB += ob.length;
  const m = match(oa, ob); matched += m.length;
  for (const { i, j } of m) { kindP.push([oa[i].kind, ob[j].kind]); certP.push([oa[i].certainty, ob[j].certainty]); keepP.push([MEM.has(oa[i].certainty), MEM.has(ob[j].certainty)].map(String)); }
  const ma = oa.filter((o) => MEM.has(o.certainty)); const mb = ob.filter((o) => MEM.has(o.certainty));
  memA += ma.length; memB += mb.length; memBoth += match(ma, mb).length;
  decP.push([decision(a.target), decision(b.target)]);
  plA += a.target.plans.length; plB += b.target.plans.length;
  for (const g of a.target.plans) {
    const p = b.target.plans.find((x) => (x.who || []).some((w) => (g.who || []).includes(w)) || BR.terms(x.what).some((w) => BR.terms(g.what).includes(w)));
    if (p) { plM++; if (String(p.when).slice(0, 10) === String(g.when).slice(0, 10)) plDate++; }
  }
}
const f1 = (m, a, b) => Math.round((2 * m / Math.max(1, a + b)) * 1000) / 1000;
console.log(JSON.stringify({
  examples: [...A.keys()].filter((id) => B.has(id)).length,
  itemDetectionF1: f1(matched, itemsA, itemsB), itemsA, itemsB, matched,
  memorableItemF1: f1(memBoth, memA, memB), memorableA: memA, memorableB: memB,
  keepVsReject: kappa(keepP), certainty: kappa(certP), kind: kappa(kindP), perExampleDecision: kappa(decP),
  plans: { a: plA, b: plB, matched: plM, f1: f1(plM, plA, plB), sameDateOfMatched: plM ? Math.round(plDate / plM * 1000) / 1000 : null },
}, null, 1));
