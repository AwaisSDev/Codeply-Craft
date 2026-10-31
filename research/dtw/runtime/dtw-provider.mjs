// Decide-then-Write as an extraction backend for the evaluation harness:
//
//   node ml/eval/run.mjs --provider module:research/dtw/runtime/dtw-provider.mjs \
//        --dtw-run <dir with backbone.gguf + heads.bin/json> [--dtw-writer lfm3] --name dtw-ettin150 --set bench
//
// Decide: one encoder pass (llama-server --embedding --pooling none) gives a
// state per token; the heads (heads.mjs) tag observation and plan spans and
// classify each (kind, certainty, about, importance, merge target, relation).
// Execute: code resolves dates and end times (time-resolve.mjs), copies the
// slot of the memory an item updates, and fills text from the user's words.
// Write (optional): LFM3 names new memories and titles plans, only when there
// is something memorable to name. The answer goes through the same guard and
// brain as every other backend.
import path from 'path';
import { buildInput, MAX_KNOWN } from './dtw-input.mjs';
import { createHeads } from './heads.mjs';
import * as TR from './time-resolve.mjs';

const MEMORABLE = new Set(['stated', 'implied', 'temporary']);
const STOP = new Set('the a an and or to of in on at for with my me i is are was be it this that we our you your from by as up so do not no im i\'m pls please just'.split(' '));

/** Character offsets of llama.cpp token pieces in `text` (pieces are strings or raw byte arrays). */
function pieceOffsets(text, tokens) {
  const bytes = Buffer.from(text, 'utf8');
  // byte offset -> UTF-16 offset
  const b2c = new Int32Array(bytes.length + 1);
  let bi = 0;
  for (let ci = 0; ci < text.length; ci++) {
    const cp = text.codePointAt(ci);
    const n = Buffer.byteLength(String.fromCodePoint(cp), 'utf8');
    for (let k = 0; k < n; k++) b2c[bi + k] = ci;
    bi += n;
    if (cp > 0xffff) ci++;
  }
  b2c[bytes.length] = text.length;
  const out = []; let cur = 0;
  tokens.forEach((t, i) => {
    const pb = Array.isArray(t.piece) ? Buffer.from(t.piece) : Buffer.from(String(t.piece), 'utf8');
    const special = (i === 0 || i === tokens.length - 1) && /^\[(CLS|SEP)\]$|^<\/?s>$/.test(String(t.piece));
    if (special || !pb.length) { out.push([b2c[cur], b2c[cur]]); return; }
    let at = cur;
    if (!bytes.subarray(at, at + pb.length).equals(pb)) {
      const j = bytes.indexOf(pb, cur);
      at = j >= 0 && j - cur < 8 ? j : cur;
    }
    out.push([b2c[at], b2c[Math.min(bytes.length, at + pb.length)]]);
    cur = Math.min(bytes.length, at + pb.length);
  });
  return out;
}

function decodeSpans(tags, inEvent, names) {
  const spans = []; let cur = null;
  tags.forEach((t, i) => {
    const n = names[t];
    if (!inEvent[i] || n === 'O') { if (cur) spans.push(cur); cur = null; return; }
    const type = n.slice(2);
    if (n.startsWith('B-') || !cur || cur.type !== type) { if (cur) spans.push(cur); cur = { type, a: i, b: i + 1 }; } else cur.b = i + 1;
  });
  if (cur) spans.push(cur);
  return spans;
}

const tidy = (s) => String(s || '').replace(/^[\s,.;:!?'"()-]+|[\s,.;:!?'"()-]+$/g, '').replace(/\s+/g, ' ');
const words = (s) => (String(s).toLowerCase().match(/[a-z0-9؀-ۿ][a-z0-9'؀-ۿ+#.-]*/g) || []).filter((w) => !STOP.has(w));

/** The clause holding [a, b) inside its event text: what the user said, without the "User:" label. */
function clauseOf(text, ev, a, b) {
  const seg = text.slice(ev.start, ev.end);
  const la = a - ev.start; const lb = b - ev.start;
  let s = Math.max(seg.lastIndexOf('\n', la - 1), ...['. ', '! ', '? ', '; '].map((p) => { const i = seg.lastIndexOf(p, la - 1); return i < 0 ? -1 : i + 1; })) + 1;
  const ends = ['\n', '. ', '! ', '? ', '; '].map((p) => seg.indexOf(p, lb)).filter((i) => i >= 0);
  const e = ends.length ? Math.min(...ends) : seg.length;
  return tidy(seg.slice(s, e).replace(/^(User|Assistant):\s*/, '')).slice(0, 200);
}

function planParts(span) {
  const where = (span.match(/\b(?:at|in)\s+((?:the\s+)?[A-Z][\w'-]*(?:\s+[A-Z][\w'-]*)*)/) || [])[1] || '';
  const skip = new Set(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday', 'Zoom', 'Meet', 'Teams', 'I', 'The', 'A']);
  const who = [...new Set((span.match(/\b[A-Z][a-z]+\b/g) || []).filter((w, i) => !skip.has(w) && (i > 0 || /with/i.test(span)) && !where.includes(w)))].slice(0, 4);
  return { where, who };
}

/** Writer: LFM3 names new memories and titles plans, in one constrained call. */
function createWriter(rt, model) {
  const system = 'You name memories for a personal assistant. For each ITEM give a slot (1-4 lowercase words for what it is about), a value (a few English words) and a text (one short third-person English sentence, e.g. "The user prefers short replies."), using only what the ITEM says. For each PLAN give a short English title. Return JSON only.';
  const schema = (ni, np) => ({
    type: 'object', additionalProperties: false, required: ['items', 'plans'],
    properties: {
      items: { type: 'array', minItems: ni, maxItems: ni, items: { type: 'object', additionalProperties: false, required: ['slot', 'value', 'text'], properties: { slot: { type: 'string', maxLength: 40 }, value: { type: 'string', maxLength: 80 }, text: { type: 'string', maxLength: 160 } } } },
      plans: { type: 'array', minItems: np, maxItems: np, items: { type: 'object', additionalProperties: false, required: ['what'], properties: { what: { type: 'string', maxLength: 60 } } } },
    },
  });
  return async (items, plans) => {
    const t = await rt.ensure();
    const user = [
      ...items.map((x, i) => `ITEM ${i + 1} [${x.kind}${x.about === 'person' ? ', about a person' : ''}${x.project ? `, project ${x.project}` : ''}]: "${x.clause}" (about: "${x.span}")`),
      ...plans.map((p, i) => `PLAN ${i + 1}: "${p.clause}"`),
    ].join('\n');
    const body = { messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0, max_tokens: 60 * items.length + 20 * plans.length + 20, cache_prompt: true,
      response_format: { type: 'json_schema', json_schema: { name: 'names', strict: true, schema: schema(items.length, plans.length) } }, ...(model.extra || {}) };
    const res = await fetch(`${t.baseUrl}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t.apiKey}` }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`writer HTTP ${res.status}`);
    const d = await res.json();
    return { out: JSON.parse(d.choices[0].message.content), usage: d.usage || {} };
  };
}

export async function createProvider({ opt, RT, threads }) {
  const run = path.resolve(opt('dtw-run'));
  const gguf = opt('dtw-gguf', path.join(run, 'backbone-q8_0.gguf'));
  const heads = createHeads(run);
  const gateMin = Number(opt('dtw-gate', 0));
  // Whole-input vector: [CLS] for encoders; the mean of the event tokens for a causal model (LFM3 + heads).
  const ctxMode = opt('dtw-ctx', heads.meta.ctx || 'cls');
  const encoder = RT.createRuntime({ model: { id: 'dtw-encoder', path: gguf, ctx: 2048 }, threads, ctx: 2048, idleMs: 0, args: ['--embedding', '--pooling', 'none', '-ub', '2048', '-b', '2048'] });
  const runtimes = [encoder];
  let writer = null;
  if (opt('dtw-writer', 'none') !== 'none') {
    const wm = RT.models().find((m) => m.id === opt('dtw-writer-model', 'lfm3-1.7b-qad-q4'));
    if (!wm) throw new Error('writer model not installed');
    const wrt = RT.createRuntime({ model: wm, threads, ctx: 4096, idleMs: 0, args: ['-ctk', 'q8_0', '-ctv', 'q8_0'] });
    runtimes.push(wrt);
    writer = createWriter(wrt, wm);
  }
  const post = async (t, p, body) => {
    const res = await fetch(`${t.baseUrl.replace(/\/v1$/, '')}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t.apiKey}` }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`encoder ${p} HTTP ${res.status}`);
    return res.json();
  };

  const provider = {
    id: 'dtw', kind: 'local', local: true,
    info: () => ({ id: 'dtw', kind: 'local', local: true, model: `dtw:${path.basename(run)}${writer ? '+writer' : ''}`, ctx: 2048 }),
    available: async () => true,
    async extract({ events, known = [], now, tz, projects = [] }) {
      const t0 = Date.now();
      const t = await encoder.ensure();
      const inp = buildInput({ events, known, now, tz, projects });
      const tok = (await post(t, '/tokenize', { content: inp.text, add_special: true, with_pieces: true })).tokens.slice(0, 2048);
      const offs = pieceOffsets(inp.text, tok);
      const emb = await post(t, '/embedding', { content: [tok.map((x) => x.id)] });
      const H = emb[0].embedding;
      const tEnc = Date.now() - t0;
      const inEvent = offs.map(([a, b]) => b > a && inp.events.some((e) => a >= e.start && b <= e.end));
      const memTok = inp.mems.map((m) => { const idx = offs.map(([a, b], i) => (b > a && a < m.end && b > m.start ? i : -1)).filter((i) => i >= 0); return idx.length ? [idx[0], idx[idx.length - 1] + 1] : null; });
      const mems = memTok.every(Boolean) ? memTok : [];
      let ctx = H[0];
      if (ctxMode === 'mean') {
        const rows = H.filter((_, i) => inEvent[i]); const d = H[0].length; ctx = new Float32Array(d);
        for (const r of rows) for (let j = 0; j < d; j++) ctx[j] += r[j] / rows.length;
      }
      const gate = heads.gate(ctx);
      const spans = gate < gateMin ? [] : decodeSpans(heads.tags(H), inEvent, heads.meta.tags);
      const times = TR.findTimes(inp.text).filter((x) => inp.events.some((e) => x.start >= e.start && x.end <= e.end));
      const observations = []; const plans = []; const toName = []; const toTitle = [];
      for (const sp of spans) {
        const a = offs[sp.a][0]; const b = offs[sp.b - 1][1];
        const ev = inp.events.find((e) => a >= e.start && b <= e.end) || inp.events[0];
        const ei = inp.events.indexOf(ev);
        const spanText = tidy(inp.text.slice(a, b));
        if (!spanText) continue;
        const clause = clauseOf(inp.text, ev, a, b);
        const project = (events[ei] && events[ei].project) || '';
        if (sp.type === 'PLAN') {
          const { when } = TR.planWhen(times, a, b, now, tz);
          if (!when) continue;
          const pp = planParts(spanText);
          const plan = { what: spanText.charAt(0).toUpperCase() + spanText.slice(1), when, where: pp.where, who: pp.who };
          plans.push(plan);
          toTitle.push({ plan, clause });
          continue;
        }
        const c = heads.span(H, ctx, sp.a, sp.b);
        let { kind, cert: certainty } = c;
        if (certainty === 'temporary') kind = 'context';
        else if (kind === 'context' && MEMORABLE.has(certainty)) certainty = 'temporary';
        const o = { kind, certainty, importance: Math.round(c.importance * 100) / 100, about: c.about, slot: '', value: spanText, text: clause || spanText, p: { kind: c.kindP, certainty: c.certP } };
        if (c.about === 'project' || ['decision', 'idea', 'requirement'].includes(kind)) { if (project || projects[0]) o.project = project || projects[0]; }
        const m = heads.merge(H, sp.a, sp.b, mems);
        if (m.target >= 0 && known[m.target]) {
          const k = known[m.target];
          o.slot = k.slot; if (k.project) o.project = k.project;
          if (m.relation === 'same') o.value = k.value;
          o.merge = { target: m.target, relation: m.relation, p: Math.round(m.p * 100) / 100 };
        } else {
          o.slot = words(spanText).slice(0, 4).join(' ') || spanText.toLowerCase().slice(0, 40);
          if (MEMORABLE.has(certainty)) toName.push({ o, clause, span: spanText });
        }
        if (kind === 'context') { const tt = TR.nearestTime(times, a, b, 120); o.until = TR.resolveUntil(tt ? tt.text : '', now, tz); }
        observations.push(o);
      }
      let usage = { prompt_tokens: 0, completion_tokens: 0 };
      if (writer && (toName.length || toTitle.length)) {
        try {
          const w = await writer(toName.map((x) => ({ kind: x.o.kind, about: x.o.about, project: x.o.project, clause: x.clause, span: x.span })), toTitle.map((x) => ({ clause: x.clause })));
          w.out.items.forEach((it, i) => { const o = toName[i] && toName[i].o; if (o) { o.slot = String(it.slot || o.slot).toLowerCase(); o.value = it.value || o.value; o.text = it.text || o.text; } });
          w.out.plans.forEach((p, i) => { if (toTitle[i] && p.what) toTitle[i].plan.what = p.what; });
          usage = { prompt_tokens: w.usage.prompt_tokens || 0, completion_tokens: w.usage.completion_tokens || 0 };
        } catch (e) { usage.writerError = String(e.message || e).slice(0, 200); }
      }
      return { answer: { observations, plans }, model: provider.info().model, ms: Date.now() - t0, usage: { ...usage, encoder_tokens: tok.length, encoder_ms: tEnc, gate: Math.round(gate * 1000) / 1000 } };
    },
  };
  return { provider, runtimes };
}
