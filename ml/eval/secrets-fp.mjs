// False positives of the secret checks (SECURITY-SECRETS.md): on a labelled set, how
// many GOLD memories and plans (things that should be kept) the guard would refuse,
// how many non-secret event texts the redactor changes, and whether every gold secret
// is caught. No model: the gold answers themselves go through the guard.
//
//   node ml/eval/secrets-fp.mjs <set.jsonl> [more.jsonl ...] [--show N]
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const S = require(path.join(ROOT, 'codeply-cli/lib/context-schema.js'));
const { redact } = require(path.join(ROOT, 'codeply-cli/lib/context-redact.js'));
const args = process.argv.slice(2);
const show = Number(args.includes('--show') ? args[args.indexOf('--show') + 1] : 15);
const files = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--show');

const MEMORABLE = new Set(['stated', 'implied', 'temporary']);
for (const file of files) {
  const exs = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const t = { examples: exs.length, goldObs: 0, goldObsDropped: 0, goldPlans: 0, goldPlansDropped: 0, eventTexts: 0, textsRedactedNoSecret: 0, secretsTotal: 0, secretsCaughtInInput: 0 };
  const lost = []; const redacted = []; const missed = [];
  for (const ex of exs) {
    const now = Date.parse(ex.input.now || ex.input.at || Date.now());
    const secrets = []; const events = [];
    for (const e of ex.input.events) {
      const n = S.normalizeEvent({ ...e, at: Date.parse(e.at) || now }, now).event;
      if (!n) continue;
      const r = redact(n.text);
      secrets.push(...r.values);
      events.push({ ...n, text: r.text });
      t.eventTexts++;
      const gold = (ex.expect && ex.expect.secrets) || [];
      if (r.found.length && !gold.length) { t.textsRedactedNoSecret++; redacted.push({ id: ex.id, removed: r.values, kinds: r.found }); }
    }
    for (const g of (ex.expect && ex.expect.secrets) || []) {
      t.secretsTotal++;
      if (!events.some((e) => e.text.includes(g))) t.secretsCaughtInInput++; else missed.push({ id: ex.id, secret: g });
    }
    const gObs = ex.target.observations.filter((o) => MEMORABLE.has(o.certainty)).map(({ evidence, ...o }) => o);
    const gPlans = (ex.target.plans || []).map(({ evidence, time, ...p }) => p);
    const g = S.checkExtraction({ observations: gObs, plans: gPlans }, { events, secrets, minImportance: 0 });
    const kept = new Set(g.observations.map((o) => o.text));
    for (const o of gObs) {
      t.goldObs++;
      const d = g.dropped.find((x) => /secret/.test(x.why) && !kept.has(o.text));
      if (!kept.has(o.text) && g.dropped.some((x) => /secret/.test(x.why))) { t.goldObsDropped++; lost.push({ id: ex.id, task: ex.task, slot: o.slot, value: o.value, text: o.text, why: d && d.why }); }
    }
    t.goldPlans += gPlans.length;
    t.goldPlansDropped += Math.max(0, gPlans.length - g.plans.length);
    if (gPlans.length > g.plans.length) lost.push({ id: ex.id, plan: gPlans.map((p) => p.what).join('; '), why: g.dropped.filter((x) => x.item && x.item.plan).map((x) => x.why).join(', ') });
  }
  const pct = (a, b) => (b ? `${(100 * a / b).toFixed(2)}%` : 'n/a');
  console.log(`\n${path.basename(file)}: ${JSON.stringify(t)}`);
  console.log(`  gold memories refused: ${t.goldObsDropped}/${t.goldObs} (${pct(t.goldObsDropped, t.goldObs)}), gold plans refused: ${t.goldPlansDropped}/${t.goldPlans} (${pct(t.goldPlansDropped, t.goldPlans)})`);
  console.log(`  non-secret event texts changed by the redactor: ${t.textsRedactedNoSecret}/${t.eventTexts} (${pct(t.textsRedactedNoSecret, t.eventTexts)}); gold secrets removed from the input: ${t.secretsCaughtInInput}/${t.secretsTotal}`);
  for (const x of lost.slice(0, show)) console.log('  refused:', JSON.stringify(x));
  for (const x of redacted.slice(0, show)) console.log('  redacted:', JSON.stringify(x));
  for (const x of missed) console.log('  MISSED in input:', JSON.stringify(x));
}
