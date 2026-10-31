// Synthetic Roman Urdu / mixed Urdu-English examples for pool v2. No licensed
// conversational data exists for these (DATA-SOURCES.md, Gaps), so Claude
// Sonnet 5.5 rewrites REAL personal English WildChat conversations (selected by
// screening) into Roman Urdu or code-switched Urdu-English, keeping the user's
// facts. Some get one added temporary situation with an end time (no real data
// has enough of these). The generator never writes labels: the rewritten
// conversation is labelled later by label.mjs like any other input.
// Every example is marked `source.synthetic` and reported separately.
//
//   node synth.mjs submit  --from ../data/wildchat-candidates.jsonl --screen ../out/screen-wildchat/screen.jsonl \
//        --n 300 --name synth-v1 --seed 1 [--exclude ids.txt] --cap 6
//   node synth.mjs collect --name synth-v1 [--wait]      -> ../data/synthetic-<name>.jsonl
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import { eventsOf } from '../prompt.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const cmd = args[0];
const opt = (n, d = '') => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const name = opt('name');
const dir = path.join(HERE, '..', 'out', name);
const MODEL = 'claude-sonnet-5-5';
const PROMPT_VERSION = 'synth-v1';
const rank = (id, seed) => crypto.createHash('sha1').update(`${seed}:${id}`).digest('hex');
const cost = (u) => 0.5 * ((u.input_tokens || 0) * 2 + (u.cache_creation_input_tokens || 0) * 2.5 + (u.cache_read_input_tokens || 0) * 0.2 + (u.output_tokens || 0) * 10) / 1e6;

const SYSTEM = `You rewrite real chat conversations between a user and an AI assistant into the way Pakistani users actually type, for a research dataset.

Rules:
- Keep every real fact the user reveals about themselves, their people, work, plans, preferences and routines, with the same meaning. Do not add new facts, except the one temporary situation when asked.
- Keep jokes, hypotheticals and things the user quotes from others as they are (still a joke, still a "what if", still someone else's view).
- Write naturally: lowercase, typos, short forms (h, nahi, kr, plz), emojis only if the original has that tone. No formal Urdu, no Urdu script.
- Shorten long pasted content or long task text to a sentence; keep the personal parts in full.
- Keep the assistant's replies short (one or two sentences), in the same language mix as the user.
- Format: one turn per line, each starting with "User: " or "Assistant: ".`;

const STYLE = {
  ur: 'Write the user\'s turns in Roman Urdu (Urdu in Latin letters), with only the English words Pakistanis normally keep in English (office, meeting, laptop, project names).',
  mixed: 'Write the user\'s turns in natural code-switching between English and Roman Urdu, switching inside sentences the way Pakistani professionals do ("kal ka meeting cancel ho gaya, so I\'m free after 3").',
};

const client = new Anthropic();

async function submit() {
  const n = Number(opt('n', 10)); const seed = opt('seed', '1'); const cap = Number(opt('cap'));
  if (!(cap > 0)) throw new Error('--cap required');
  const screen = new Map(fs.readFileSync(opt('screen'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((r) => [r.id, r]));
  const exclude = new Set(opt('exclude') ? fs.readFileSync(opt('exclude'), 'utf8').split('\n').filter(Boolean) : []);
  // --only: ids whose labels (Sonnet / Opus, never the screener) contain a memory
  const only = opt('only') ? new Set(fs.readFileSync(opt('only'), 'utf8').split('\n').filter(Boolean)) : null;
  const rows = fs.readFileSync(opt('from'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((r) => { const s = screen.get(r.id); return s && s.about_user && !s.task_only && !exclude.has(r.id) && (!only || only.has(r.id)); })
    .sort((a, b) => (rank(a.id, `${seed}synth`) < rank(b.id, `${seed}synth`) ? -1 : 1)).slice(0, n);
  const est = rows.length * 0.008;
  if (est > cap) throw new Error(`estimated $${est.toFixed(2)} > cap $${cap}`);
  const plan = rows.map((r, i) => ({ id: r.id, kind: i % 2 === 0 ? 'ur' : 'mixed', temporary: i % 3 === 0 }));
  const requests = rows.map((r, i) => {
    const p = plan[i];
    const text = eventsOf(r).map((e) => e.text).join('\n');
    const extra = p.temporary ? '\n- Add ONE realistic temporary situation of the user with an end time or day, woven into a user turn (for example busy at the office till 6, at a wedding this weekend, roza hai aaj, travelling till Thursday).' : '';
    return { custom_id: r.id, params: { model: MODEL, max_tokens: 8000, system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: `${STYLE[p.kind]}${extra}\n\nConversation:\n${text}` }],
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: { type: 'object', additionalProperties: false, required: ['conversation'], properties: { conversation: { type: 'string' } } } } } } };
  });
  fs.mkdirSync(dir, { recursive: true });
  const b = await client.messages.batches.create({ requests });
  fs.writeFileSync(path.join(dir, 'batches.json'), JSON.stringify({ id: b.id, model: MODEL, promptVersion: PROMPT_VERSION, from: opt('from'), plan, estUSD: est }, null, 1));
  console.log(`submitted ${b.id}: ${requests.length} (est. $${est.toFixed(2)})`);
}

async function collect() {
  const st = JSON.parse(fs.readFileSync(path.join(dir, 'batches.json'), 'utf8'));
  let x = await client.messages.batches.retrieve(st.id);
  while (x.processing_status !== 'ended' && args.includes('--wait')) { await new Promise((r) => setTimeout(r, 30000)); x = await client.messages.batches.retrieve(st.id); }
  if (x.processing_status !== 'ended') { console.log(`${st.id}: ${x.processing_status}`); return; }
  const src = new Map(fs.readFileSync(st.from, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((r) => [r.id, r]));
  const planOf = new Map(st.plan.map((p) => [p.id, p]));
  const out = []; let usd = 0; let bad = 0;
  for await (const r of await client.messages.batches.results(st.id)) {
    if (r.result.type !== 'succeeded') { bad++; continue; }
    const m = r.result.message; usd += cost(m.usage);
    let conv = '';
    try { conv = JSON.parse(m.content.filter((c) => c.type === 'text').map((c) => c.text).join('')).conversation.trim(); } catch { bad++; continue; }
    const lines = conv.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length || !lines.every((l) => /^(User|Assistant): /.test(l)) || !/^User: /.test(lines[0])) { bad++; continue; }
    const orig = src.get(r.custom_id); const p = planOf.get(r.custom_id);
    const ex = JSON.parse(JSON.stringify(orig));
    ex.id = `rl-syn${p.kind}-${orig.id.split('-').pop()}`;
    ex.input.events = [{ ...orig.input.events[0], text: lines.join('\n') }];
    ex.stratum = `syn-${p.kind}`;
    ex.source = { ...orig.source, synthetic: { generator: MODEL, effort: 'medium', promptVersion: PROMPT_VERSION, language: p.kind, addedTemporary: p.temporary, fromId: orig.id, batch: st.id } };
    out.push(ex);
  }
  const file = path.join(HERE, '..', 'data', `synthetic-${name}.jsonl`);
  fs.writeFileSync(file, out.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.log(JSON.stringify({ written: out.length, rejected: bad, ur: out.filter((r) => r.stratum === 'syn-ur').length, mixed: out.filter((r) => r.stratum === 'syn-mixed').length, usd: Math.round(usd * 1000) / 1000, file }, null, 1));
}

({ submit, collect }[cmd] || (() => { console.error('usage: synth.mjs submit|collect --name <run>'); process.exit(1); }))().catch((e) => { console.error(e.message || e); process.exit(1); });
