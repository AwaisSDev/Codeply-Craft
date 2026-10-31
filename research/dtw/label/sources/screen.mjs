// Screening for pool v2: Claude Haiku 5.5 answers yes / no questions about each
// candidate so the pool can be enriched with personal conversations. It only
// SELECTS data: its answers are never used as labels (the labels come from
// Sonnet / Opus in label.mjs, which never see these answers).
//
//   node screen.mjs submit  --in ../data/wildchat-candidates.jsonl --name screen-wildchat --cap 3
//   node screen.mjs collect --name screen-wildchat [--wait]       -> ../out/<name>/screen.jsonl
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import { eventsOf } from '../prompt.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const cmd = args[0];
const opt = (n, d = '') => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const name = opt('name');
const dir = path.join(HERE, '..', 'out', name);
const MODEL = 'claude-haiku-5-5';
// USD per million tokens for prompts under 100K tokens; batch is half.
const cost = (u) => 0.5 * ((u.input_tokens || 0) * 0.1 + (u.cache_creation_input_tokens || 0) * 0.125 + (u.cache_read_input_tokens || 0) * 0.01 + (u.output_tokens || 0) * 0.5) / 1e6;

const SYSTEM = `You screen conversations for a dataset. A user talks to an AI assistant. Answer four yes/no questions about what the USER reveals about their own real life (not fiction, role-play, homework, a pasted document, or a character they ask the assistant to write about).

- about_user: the user reveals something lasting and real about themselves, their people (family, partner, friends, colleagues), their work or projects, their preferences, routines or decisions.
- plan: the user mentions a real meeting, call, trip, appointment, booking or deadline of their own with a day or a time.
- temporary: the user mentions their own current, temporary situation (busy until a time, sick today, travelling this week, at the office tonight).
- task_only: the conversation is only a task (code, writing, translation, homework, questions about the world, role-play) with nothing real about the user.`;

const SCHEMA = { type: 'object', additionalProperties: false, required: ['about_user', 'plan', 'temporary', 'task_only'],
  properties: { about_user: { type: 'boolean' }, plan: { type: 'boolean' }, temporary: { type: 'boolean' }, task_only: { type: 'boolean' } } };

const client = new Anthropic();
const cid = (id) => String(id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);

async function submit() {
  const cap = Number(opt('cap'));
  if (!(cap > 0)) throw new Error('--cap required');
  const rows = fs.readFileSync(opt('in'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const est = rows.length * 0.00005; // ~450 input + ~20 output tokens each at batch prices
  if (est > cap) throw new Error(`estimated $${est.toFixed(2)} > cap $${cap}`);
  fs.mkdirSync(dir, { recursive: true });
  const batches = [];
  for (let i = 0; i < rows.length; i += 10000) {
    const part = rows.slice(i, i + 10000);
    const requests = part.map((ex) => ({
      custom_id: cid(ex.id),
      params: { model: MODEL, max_tokens: 200, thinking: { type: 'disabled' },
        system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: eventsOf(ex).map((e) => e.text).join('\n\n') }],
        output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } } },
    }));
    const b = await client.messages.batches.create({ requests });
    batches.push({ id: b.id, n: requests.length, ids: Object.fromEntries(part.map((ex) => [cid(ex.id), ex.id])) });
    console.log(`submitted ${b.id}: ${requests.length}`);
  }
  fs.writeFileSync(path.join(dir, 'batches.json'), JSON.stringify({ model: MODEL, in: opt('in'), estUSD: est, batches }, null, 1));
}

async function collect() {
  const st = JSON.parse(fs.readFileSync(path.join(dir, 'batches.json'), 'utf8'));
  const out = []; let usd = 0;
  for (const b of st.batches) {
    let x = await client.messages.batches.retrieve(b.id);
    while (x.processing_status !== 'ended' && args.includes('--wait')) { await new Promise((r) => setTimeout(r, 30000)); x = await client.messages.batches.retrieve(b.id); }
    if (x.processing_status !== 'ended') { console.log(`${b.id}: ${x.processing_status} ${JSON.stringify(x.request_counts)}`); return; }
    for await (const r of await client.messages.batches.results(b.id)) {
      const row = { id: b.ids[r.custom_id] || r.custom_id };
      if (r.result.type === 'succeeded') {
        const m = r.result.message; usd += cost(m.usage);
        try { Object.assign(row, JSON.parse(m.content.filter((c) => c.type === 'text').map((c) => c.text).join(''))); } catch { row.error = 'unparsable'; }
      } else row.error = r.result.type;
      out.push(row);
    }
  }
  fs.writeFileSync(path.join(dir, 'screen.jsonl'), out.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const n = (k) => out.filter((r) => r[k] === true).length;
  const s = { model: MODEL, screened: out.length, errors: out.filter((r) => r.error).length, about_user: n('about_user'), plan: n('plan'), temporary: n('temporary'), task_only: n('task_only'),
    selected: out.filter((r) => r.about_user || r.plan || r.temporary).length, usd: Math.round(usd * 100) / 100 };
  fs.writeFileSync(path.join(dir, 'summary.json'), `${JSON.stringify(s, null, 1)}\n`);
  console.log(JSON.stringify(s, null, 1));
}

({ submit, collect }[cmd] || (() => { console.error('usage: screen.mjs submit|collect --name <run>'); process.exit(1); }))().catch((e) => { console.error(e.message || e); process.exit(1); });
