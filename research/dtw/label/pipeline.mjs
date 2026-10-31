// Hybrid labelling pipeline (owner's routing, 2026-10-31): Sonnet 5.5 labels the bulk;
// Opus 5.5 labels examples with known memories (merges, contradictions) and
// temporary context. Runs on the candidate pool built by sources/build.py.
//
//   node pipeline.mjs select   --run <run> --n 40 [--seed 1]    stratified draw -> out/<run>/stage1-{sonnet,opus}.jsonl
//   (label stage 1 with label.mjs: --name <run>-s1-sonnet / <run>-s1-opus)
//   node pipeline.mjs reroute  --run <run>                      Sonnet answers with temporary context -> stage1b-opus.jsonl
//   node pipeline.mjs merge    --run <run> --n 10               merge / contradiction examples -> stage2-opus.jsonl
//   (label stage 1b and 2 with Opus: --name <run>-s1b-opus / <run>-s2-opus)
//   node pipeline.mjs assemble --run <run>                      final labels -> data/<run>.jsonl, verify.json, AUDIT sheet
//
// Every step is deterministic given the pool, the seed and the collected labels.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import { check, toExample, eventsOf } from './prompt.mjs';
import * as TR from '../runtime/time-resolve.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const cmd = args[0];
const opt = (n, d = '') => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const run = opt('run');
const dir = path.join(HERE, 'out', run);
const POOL = path.resolve(HERE, opt('pool', path.join('data', 'pool.jsonl')));
const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const writeJsonl = (f, rows) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '')); };
const rank = (id, seed) => crypto.createHash('sha1').update(`${seed}:${id}`).digest('hex');
const MEMORABLE = new Set(['stated', 'implied', 'temporary']);
const results = (name) => readJsonl(path.join(HERE, 'out', name, 'results.jsonl'));
const srcOf = (ex) => ex.stratum || ex.id.split('-')[1];

function select() {
  const n = Number(opt('n', 40)); const seed = opt('seed', '1');
  const pool = readJsonl(POOL);
  const quota = opt('quota') ? JSON.parse(opt('quota')) : { wildchat: 0.6, multiwoz: 0.15, topical: 0.1, romanurdu: 0.15 };
  const taken = new Set(readJsonl(path.join(dir, 'exclude.jsonl')).map((r) => r.id));
  const out = [];
  for (const [src, share] of Object.entries(quota)) {
    const rows = pool.filter((r) => srcOf(r) === src && !taken.has(r.id)).sort((a, b) => (rank(a.id, seed) < rank(b.id, seed) ? -1 : 1));
    const k = Math.round(n * share);
    // Keep the temporary-route share of each source (at least one when the source has any).
    const temp = rows.filter((r) => r.route !== 'sonnet'); const rest = rows.filter((r) => r.route === 'sonnet');
    const kt = Math.min(temp.length, Math.max(temp.length ? 1 : 0, Math.round(k * temp.length / rows.length)));
    out.push(...temp.slice(0, kt), ...rest.slice(0, k - kt));
  }
  writeJsonl(path.join(dir, 'stage1-sonnet.jsonl'), out.filter((r) => r.route === 'sonnet'));
  writeJsonl(path.join(dir, 'stage1-opus.jsonl'), out.filter((r) => r.route !== 'sonnet'));
  console.log(`selected ${out.length}: sonnet ${out.filter((r) => r.route === 'sonnet').length}, opus (temporary) ${out.filter((r) => r.route !== 'sonnet').length}`);
}

function reroute() {
  // Sonnet answers that contain temporary context go to Opus as well (Opus's label wins).
  const s = results(`${run}-s1-sonnet`);
  const ids = new Set(s.filter((r) => r.output && r.output.observations.some((o) => o.certainty === 'temporary')).map((r) => r.id));
  const rows = readJsonl(path.join(dir, 'stage1-sonnet.jsonl')).filter((r) => ids.has(r.id)).map((r) => ({ ...r, route: 'opus-temporary-reroute' }));
  writeJsonl(path.join(dir, 'stage1b-opus.jsonl'), rows);
  console.log(`rerouted to Opus: ${rows.length}`);
}

/** Stage-1 final label per id: Opus over Sonnet. */
function stage1Final() {
  const m = new Map();
  for (const name of [`${run}-s1-sonnet`, `${run}-s1-opus`, `${run}-s1b-opus`]) for (const r of results(name)) if (r.output) m.set(r.id, r);
  return m;
}

async function olderValue(client, o) {
  const msg = await client.messages.create({
    model: 'claude-sonnet-5-5', max_tokens: 2000, output_config: { effort: 'low', format: { type: 'json_schema', schema: { type: 'object', additionalProperties: false, required: ['value', 'text'], properties: { value: { type: 'string' }, text: { type: 'string' } } } } },
    messages: [{ role: 'user', content: `A personal memory system stores short memories about a user. This memory comes from what the user just said:\nkind: ${o.kind}\nslot: ${o.slot}\nvalue: ${o.value}\ntext: ${o.text}\n\nWrite an EARLIER memory for the same slot with a different, plausible, specific value that the new statement would update or contradict (for example hosting "Heroku" before "Hetzner"). Return the earlier value (a few words) and its one-sentence third-person text.` }],
  });
  return { ...JSON.parse(msg.content.filter((c) => c.type === 'text').map((c) => c.text).join('')), usage: msg.usage };
}

async function merge() {
  const n = Number(opt('n', 10)); const seed = opt('seed', '1');
  const pool = new Map(readJsonl(POOL).map((r) => [r.id, r]));
  const fin = stage1Final();
  const mem = (r) => (r.output.observations || []).filter((o) => MEMORABLE.has(o.certainty) && o.kind !== 'context' && !(r.errors || []).length);
  const cands = [...fin.values()].filter((r) => mem(r).length && pool.has(r.id)).sort((a, b) => (rank(a.id, seed) < rank(b.id, seed) ? -1 : 1));
  const distractors = [...fin.values()].flatMap((r) => mem(r).map((o) => ({ ...o, from: r.id })));
  const client = new Anthropic();
  const out = []; let usd = 0;
  for (const [i, r] of cands.slice(0, n).entries()) {
    const ex = pool.get(r.id);
    const os = mem(r); const o = os[Number.parseInt(rank(r.id, `${seed}o`).slice(0, 6), 16) % os.length];
    const relation = i % 2 === 0 ? 'same' : 'different';
    let target = { kind: o.kind, slot: o.slot, value: o.value, text: o.text, ...(o.project ? { project: o.project } : {}) };
    if (relation === 'different') {
      const old = await olderValue(client, o);
      usd += (old.usage.input_tokens * 2 + old.usage.output_tokens * 10) / 1e6;
      target = { ...target, value: old.value, text: old.text };
    }
    const k = 1 + (Number.parseInt(rank(r.id, `${seed}k`).slice(0, 4), 16) % 4);
    const ds = distractors.filter((d) => d.from !== r.id && d.slot !== o.slot).sort((a, b) => (rank(a.from + a.slot, r.id) < rank(b.from + b.slot, r.id) ? -1 : 1)).slice(0, k)
      .map((d) => ({ kind: d.kind, slot: d.slot, value: d.value, text: d.text }));
    const all = [target, ...ds].sort((a, b) => (rank(a.slot, r.id) < rank(b.slot, r.id) ? -1 : 1)).map((m, j) => ({ id: `m${j + 1}`, ...m }));
    const tid = all.find((m) => m.slot === target.slot && m.value === target.value).id;
    out.push({ ...ex, id: `${ex.id}-mg`, route: 'opus-merge', input: { ...ex.input, known: all },
      construct: { target: tid, relation, slot: o.slot, from: r.id, older: relation === 'different' ? 'claude-sonnet-5-5 effort low' : null } });
  }
  writeJsonl(path.join(dir, 'stage2-opus.jsonl'), out);
  console.log(`merge examples: ${out.length} (same ${out.filter((x) => x.construct.relation === 'same').length}, different ${out.filter((x) => x.construct.relation === 'different').length}); older values $${usd.toFixed(4)}`);
}

function assemble() {
  const inputs = new Map();
  for (const f of ['stage1-sonnet', 'stage1-opus', 'stage2-opus']) for (const r of readJsonl(path.join(dir, `${f}.jsonl`))) inputs.set(r.id, r);
  const finals = new Map();
  for (const name of [`${run}-s1-sonnet`, `${run}-s1-opus`, `${run}-s1b-opus`, `${run}-s2-opus`]) for (const r of results(name)) if (r.output || !finals.has(r.id)) finals.set(r.id, r);
  const usd = ['s1-sonnet', 's1-opus', 's1b-opus', 's2-opus'].reduce((n, s) => n + results(`${run}-${s}`).reduce((m, r) => m + (r.cost || 0), 0), 0);
  const v = { examples: inputs.size, labelled: 0, checkerPass: 0, spansResolved: 0, kept: 0, empty: 0, plans: 0, planDateAgree: 0, planDateChecked: 0, untilAgree: 0, untilChecked: 0,
    merge: { examples: 0, targetRight: 0, relationRight: 0 }, provenanceComplete: 0, byModel: {}, bySource: {}, rejected: [] };
  const kept = []; const sheet = [];
  for (const [id, ex] of inputs) {
    const r = finals.get(id);
    if (!r || !r.output) { v.rejected.push({ id, why: r ? r.error || 'no output' : 'not labelled' }); continue; }
    v.labelled++;
    v.byModel[r.model] = (v.byModel[r.model] || 0) + 1;
    const events = eventsOf(ex); const known = ex.input.known || [];
    const errs = check(r.output, { events, known });
    if (errs.length) { v.rejected.push({ id, why: errs.join('; ') }); continue; }
    v.checkerPass++;
    const t = toExample(ex, r.output, { source: ex.source, route: ex.route, labeller: { model: r.model, effort: r.effort, batch: r.batch }, ...(ex.construct ? { construct: ex.construct } : {}) });
    if (!t) { v.rejected.push({ id, why: 'evidence not found in the raw text' }); continue; }
    v.spansResolved++;
    const s = ex.source || {};
    if (s.dataset && s.licence && s.url && s.revision && s.sha256 && s.original_id) v.provenanceComplete++;
    const now = Date.parse(ex.input.now); const tz = ex.input.tz;
    const memorable = r.output.observations.filter((o) => MEMORABLE.has(o.certainty));
    if (!memorable.length && !r.output.plans.length) v.empty++;
    for (const p of r.output.plans) {
      v.plans++;
      if (!p.time_text) continue;
      const w = TR.resolvePlan(p.time_text, now, tz);
      if (!w) continue;
      v.planDateChecked++;
      if (w.slice(0, 10) === p.when.slice(0, 10)) v.planDateAgree++;
    }
    for (const o of r.output.observations.filter((x) => x.certainty === 'temporary' && x.time_text)) {
      v.untilChecked++;
      if (TR.resolveUntil(o.time_text, now, tz) === o.until) v.untilAgree++;
    }
    if (ex.construct) {
      v.merge.examples++;
      const hit = r.output.observations.find((o) => o.merge_target === ex.construct.target);
      if (hit) { v.merge.targetRight++; if (hit.merge_relation === ex.construct.relation) v.merge.relationRight++; }
    }
    const src = srcOf(ex); v.bySource[src] = v.bySource[src] || { n: 0, empty: 0 }; v.bySource[src].n++;
    if (!memorable.length && !r.output.plans.length) v.bySource[src].empty++;
    kept.push(t);
    sheet.push([`### ${id} (${src}, ${ex.route}, ${r.model.replace('claude-', '')})`, '',
      ...known.map((k) => `- known ${k.id}: ${k.slot} = ${k.value}`),
      ...ex.input.events.map((e) => `> ${e.text.replace(/\n/g, '  \n> ')}`), '',
      ...(r.output.observations.length ? r.output.observations.map((o) => `- **${o.kind}** · ${o.certainty} · ${o.slot} = ${o.value}${o.until ? ` · until ${o.until}` : ''}${o.merge_target ? ` · merge ${o.merge_target} ${o.merge_relation}` : ''} — "${o.evidence}"`) : ['- (no observations)']),
      ...r.output.plans.map((p) => `- **plan** ${p.what} · ${p.when}${p.where ? ` · ${p.where}` : ''} — "${p.time_text}"`),
      ...(ex.construct ? [`- constructed: ${ex.construct.target} ${ex.construct.relation}`] : []), '', 'Review: ', ''].join('\n'));
  }
  v.kept = kept.length; v.usd = Math.round(usd * 100) / 100; v.usdPerExample = v.labelled ? Math.round(usd / v.labelled * 10000) / 10000 : null;
  v.emptyShare = v.kept ? Math.round(v.empty / v.kept * 100) / 100 : null;
  writeJsonl(path.join(HERE, 'data', `${run}.jsonl`), kept);
  fs.writeFileSync(path.join(dir, 'verify.json'), `${JSON.stringify(v, null, 1)}\n`);
  fs.writeFileSync(path.join(dir, 'REVIEW.md'), `# ${run}: every label, for manual review\n\n${sheet.join('\n')}`);
  console.log(JSON.stringify(v, null, 1));
}

const fn = { select, reroute, merge, assemble }[cmd];
if (!fn || !run) { console.error('usage: pipeline.mjs select|reroute|merge|assemble --run <run> ...'); process.exit(1); }
Promise.resolve(fn()).catch((e) => { console.error(e.message || e); process.exit(1); });
