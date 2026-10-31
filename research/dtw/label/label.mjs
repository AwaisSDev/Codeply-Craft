// Claude as labeller, through the Message Batches API (half price), with a hard
// spending cap. Labels go through the same checks as the hand-written benchmark.
//
//   node research/dtw/label/label.mjs submit  --in <harness-format.jsonl> --name <run> --model sonnet|opus
//            [--effort high] [--offset 0] [--limit 50] --cap <USD for this run>
//   node research/dtw/label/label.mjs collect --name <run> [--wait]
//   node research/dtw/label/label.mjs status  --name <run>
//
// Output (research/dtw/label/out/<run>/): batches.json (state), results.jsonl
// (one line per example: id, key, model, stop, usage, cost, output, errors),
// summary.json. ANTHROPIC_API_KEY comes from the environment and is never written.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM, SCHEMA, userMessage, eventsOf, inputKey, check } from './prompt.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const cmd = args[0];
const opt = (n, d = '') => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const flag = (n) => args.includes(`--${n}`);

const MODELS = { sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' };
// USD per million tokens, standard API; batch is half. Cache writes 1.25x input.
const PRICE = { 'claude-sonnet-5-5': { in: 2, out: 10, cacheRead: 0.2 }, 'claude-opus-5-5': { in: 4, out: 20, cacheRead: 0.2 } };
const BATCH = 0.5;
export function cost(model, u) {
  const p = PRICE[model];
  return BATCH * ((u.input_tokens || 0) * p.in + (u.cache_creation_input_tokens || 0) * p.in * 1.25
    + (u.cache_read_input_tokens || 0) * p.cacheRead + (u.output_tokens || 0) * p.out) / 1e6;
}

const name = opt('name');
if (!name && cmd) { console.error('--name is required'); process.exit(1); }
const dir = path.join(HERE, 'out', name || '_');
const stateFile = path.join(dir, 'batches.json');
const resultsFile = path.join(dir, 'results.jsonl');
const loadState = () => (fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { batches: [] });
const saveState = (s) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(stateFile, `${JSON.stringify(s, null, 1)}\n`); };
const results = () => (fs.existsSync(resultsFile) ? fs.readFileSync(resultsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const spent = () => results().reduce((n, r) => n + (r.cost || 0), 0);
const cid = (id) => String(id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);

const client = new Anthropic();

function request(ex, model, effort) {
  const events = eventsOf(ex);
  const input = { events, known: ex.input.known || [], now: Date.parse(ex.input.now), tz: ex.input.tz };
  return {
    custom_id: cid(ex.id),
    params: {
      model, max_tokens: 16000,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userMessage(input) }],
      output_config: { effort, format: { type: 'json_schema', schema: SCHEMA } },
    },
  };
}

async function submit() {
  const model = MODELS[opt('model', 'sonnet')] || opt('model');
  if (!PRICE[model]) throw new Error(`unknown model ${model}`);
  const effort = opt('effort', 'high');
  const cap = Number(opt('cap'));
  if (!(cap > 0)) throw new Error('--cap <USD> is required');
  const state = loadState();
  const pending = state.batches.filter((b) => !b.collected);
  if (pending.length) throw new Error(`collect first: ${pending.map((b) => b.id).join(', ')}`);
  const already = spent();
  if (already >= cap) throw new Error(`cap reached: $${already.toFixed(2)} of $${cap}`);
  const done = new Set(results().map((r) => r.id));
  let rows = fs.readFileSync(opt('in'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  rows = rows.slice(Number(opt('offset', 0)));
  rows = rows.filter((r) => !done.has(r.id));
  if (opt('limit')) rows = rows.slice(0, Number(opt('limit')));
  if (!rows.length) { console.log('nothing to submit'); return; }
  // Estimate before spending: the cost per example measured so far, else a conservative guess.
  const prev = results();
  const per = prev.length ? already / prev.length : (model.includes('opus') ? 0.06 : 0.03);
  const est = per * rows.length;
  if (already + est > cap) {
    const fit = Math.max(0, Math.floor((cap - already) / per));
    if (!fit) throw new Error(`estimated $${est.toFixed(2)} would pass the cap ($${already.toFixed(2)} spent of $${cap})`);
    console.log(`cap: submitting ${fit} of ${rows.length} (est. $${per.toFixed(4)}/example)`);
    rows = rows.slice(0, fit);
  }
  const reqs = rows.map((r) => request(r, model, effort));
  const ids = Object.fromEntries(rows.map((r) => [cid(r.id), r.id]));
  const batch = await client.messages.batches.create({ requests: reqs });
  state.batches.push({ id: batch.id, model, effort, in: opt('in'), n: reqs.length, ids, at: new Date().toISOString(), collected: false, estUSD: Math.round(per * reqs.length * 100) / 100 });
  saveState(state);
  console.log(`submitted ${batch.id}: ${reqs.length} examples, ${model} effort ${effort}, est. $${(per * reqs.length).toFixed(2)} (spent so far $${already.toFixed(2)}, cap $${cap})`);
}

async function collect() {
  const state = loadState();
  const out = fs.createWriteStream(resultsFile, { flags: 'a' });
  for (const b of state.batches.filter((x) => !x.collected)) {
    let batch = await client.messages.batches.retrieve(b.id);
    while (batch.processing_status !== 'ended' && flag('wait')) {
      process.stdout.write(`\r${b.id}: ${batch.processing_status} ${JSON.stringify(batch.request_counts)}   `);
      await new Promise((r) => setTimeout(r, 30000));
      batch = await client.messages.batches.retrieve(b.id);
    }
    if (batch.processing_status !== 'ended') { console.log(`${b.id}: ${batch.processing_status} ${JSON.stringify(batch.request_counts)}`); continue; }
    const byId = new Map();
    for (const l of fs.readFileSync(b.in, 'utf8').split('\n')) if (l.trim()) { const ex = JSON.parse(l); if (b.ids[cid(ex.id)]) byId.set(ex.id, ex); }
    let n = 0;
    for await (const r of await client.messages.batches.results(b.id)) {
      const id = b.ids[r.custom_id] || r.custom_id;
      const ex = byId.get(id);
      const row = { id, model: b.model, effort: b.effort, batch: b.id };
      if (ex) { const events = eventsOf(ex); row.key = inputKey({ events, known: ex.input.known || [], now: ex.input.now }); }
      if (r.result.type !== 'succeeded') { row.error = r.result.type; out.write(`${JSON.stringify(row)}\n`); continue; }
      const m = r.result.message;
      row.stop = m.stop_reason; row.usage = m.usage; row.cost = cost(b.model, m.usage);
      const text = m.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
      try { row.output = JSON.parse(text); } catch { row.error = 'unparsable'; }
      if (row.output && ex) row.errors = check(row.output, { events: eventsOf(ex), known: ex.input.known || [] });
      out.write(`${JSON.stringify(row)}\n`); n++;
    }
    b.collected = true; b.collectedAt = new Date().toISOString();
    saveState(state);
    console.log(`\n${b.id}: collected ${n}`);
  }
  out.end();
  await new Promise((r) => out.on('finish', r));
  summary();
}

function summary() {
  const rs = results();
  const ok = rs.filter((r) => r.output && !r.error);
  const valid = ok.filter((r) => !r.errors || !r.errors.length);
  const tok = (k) => rs.reduce((n, r) => n + ((r.usage && r.usage[k]) || 0), 0);
  const s = {
    name, examples: rs.length, answered: ok.length, valid: valid.length, validRate: rs.length ? Math.round(valid.length / rs.length * 1000) / 1000 : null,
    refusals: rs.filter((r) => r.stop === 'refusal').length, maxTokens: rs.filter((r) => r.stop === 'max_tokens').length, errors: rs.filter((r) => r.error).length,
    usd: Math.round(spent() * 100) / 100, usdPerExample: rs.length ? Math.round(spent() / rs.length * 10000) / 10000 : null,
    tokens: { input: tok('input_tokens'), cacheWrite: tok('cache_creation_input_tokens'), cacheRead: tok('cache_read_input_tokens'), output: tok('output_tokens') },
    commonErrors: Object.entries(rs.flatMap((r) => (r.errors || []).map((e) => e.replace(/^(obs|plan) \d+: /, '').replace(/"[^"]*"/g, '"…"').replace(/\d+/g, 'N'))).reduce((m, e) => ({ ...m, [e]: (m[e] || 0) + 1 }), {})).sort((a, b) => b[1] - a[1]).slice(0, 8),
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'summary.json'), `${JSON.stringify(s, null, 1)}\n`);
  console.log(JSON.stringify(s, null, 1));
}

async function status() {
  for (const b of loadState().batches) {
    const batch = b.collected ? null : await client.messages.batches.retrieve(b.id);
    console.log(`${b.id} ${b.model} n=${b.n} ${b.collected ? 'collected' : `${batch.processing_status} ${JSON.stringify(batch.request_counts)}`}`);
  }
  if (fs.existsSync(resultsFile)) summary();
}

const run = { submit, collect, status }[cmd];
if (!run) { console.error('usage: label.mjs submit|collect|status --name <run> ...'); process.exit(1); }
run().catch((e) => { console.error(e.message || e); process.exit(1); });
