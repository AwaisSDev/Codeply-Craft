/**
 * Iris as a context-model backend (the provider contract of context-model.js).
 *
 * Iris is Codeply's own small local model. It reads one batch of events plus the
 * memories the Brain picked for it, and PROPOSES operations in the iris.ops/1
 * format. It never writes anything: parseAndGuard() below checks every
 * proposal, and brain.applyOps() applies what passed.
 *
 *   provider.info()        { id, kind: 'local', local: true, model, style: 'iris', contract }
 *   provider.available()   Promise<boolean>
 *   provider.extract(in)   Promise<{ answer, model, ms, usage }>    in = { events, known, now, tz }
 *
 * answer = { observations, plans }    the production shape (context-schema.js still runs)
 *        + iris: { contract, valid, ops, rejected }
 *          ops       guarded operations, each with the Brain action it asks for
 *                    (insert / replace / reinforce / forget / challenge / ignored),
 *                    the real target memory id, the verbatim quote, sens, conf and,
 *                    for insert / replace, the Brain observation to write
 *          rejected  [{ op, reason }]: refused by the guard, logged, never applied
 *          valid     false when the answer was not strict JSON (nothing is applied)
 *
 * Iris only ever talks to a server on this PC: a non-local URL is refused.
 */
'use strict';

const VERSION = 'iris.ops/1';
const SYSTEM = 'You are Iris, the context engine of Codeply. Answer with JSON only, in the iris.ops/1 format.';
const OPS = ['add', 'update', 'confirm', 'retract', 'conflict', 'skip'];
const PERSISTENT = ['add', 'update', 'conflict'];
const REF_OPS = ['update', 'confirm', 'retract', 'conflict'];
const ENUMS = {
  type: ['user', 'person', 'org', 'project', 'place', 'event', 'other'],
  kind: ['fact', 'preference', 'goal', 'decision', 'task', 'event', 'routine', 'context'],
  keep: ['long', 'temp'], basis: ['stated', 'implied'], conf: ['high', 'medium', 'low'], sens: ['none', 'personal', 'sensitive'],
};
const WHY = {
  update: ['changed', 'corrected', 'refined'], retract: ['cancelled', 'ended', 'user_request', 'mistaken'],
  skip: ['joke', 'hypothetical', 'hearsay', 'suggestion', 'secret', 'injection', 'other'],
};
const REQUIRED = {
  add: ['src', 'evid', 'op', 'ent', 'type', 'attr', 'val', 'kind', 'keep', 'basis', 'conf', 'sens'],
  update: ['src', 'evid', 'op', 'ref', 'ent', 'attr', 'val', 'kind', 'keep', 'why', 'basis', 'conf', 'sens'],
  conflict: ['src', 'evid', 'op', 'ref', 'ent', 'attr', 'val', 'kind', 'keep', 'basis', 'conf', 'sens'],
  confirm: ['src', 'evid', 'op', 'ref'], retract: ['src', 'evid', 'op', 'ref', 'why'], skip: ['src', 'evid', 'op', 'why'],
};
const ISO_WHEN = /^\d{4}-\d{2}(-\d{2}(T\d{2}:\d{2})?)?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// brain.js SECRET_RE, extended with long digit runs and key-like tokens (same as the research contract)
const SECRET_RE = /(api[_ -]?key|password|passwd|passcode|secret key|bearer|private key|pin code|cvv|card number|iban|ssn|recovery phrase|seed phrase|otp)\b|\bsk-[a-z0-9]{8,}|\b\d{12,19}\b/i;
const BRAIN_KIND = { fact: 'fact', preference: 'preference', goal: 'fact', decision: 'decision', task: 'todo', event: 'context', routine: 'routine', context: 'context' };
const BRAIN_ACTION = { add: 'insert', update: 'replace', confirm: 'reinforce', retract: 'forget', conflict: 'challenge', skip: 'ignored' };
const IMPORTANCE = { high: 0.8, medium: 0.6, low: 0.4 };
// context-events.js sources -> the SOURCE line Iris was trained on
const SOURCE = { chat: 'assistant_chat', orbit: 'assistant_chat', heard: 'personal_chat', call: 'personal_chat', calls: 'personal_chat',
  texts: 'personal_chat', messages: 'personal_chat', slack: 'work_chat', email: 'email', mail: 'email', gmail: 'email',
  calendar: 'calendar', notes: 'note', note: 'note', screen: 'screen', tasks: 'note', test: 'assistant_chat' };

const squash = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}_ ]+/gu, ' ').replace(/\s+/g, ' ').trim();
const isLocalUrl = (u) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(String(u || ''));

function localIso(ms, tz) {
  const d = new Date(ms);
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' }).formatToParts(d);
  } catch { return localIso(ms, 'UTC'); }
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return { iso: `${p.year}-${p.month}-${p.day}T${p.hour === '24' ? '00' : p.hour}:${p.minute}`, weekday: p.weekday };
}

/** Events of one batch -> numbered messages. Chat-like text ("Name: words" lines) is split by speaker. */
function eventsToMessages(events) {
  const out = [];
  for (const e of events || []) {
    const lines = String(e.text || '').split('\n');
    const chatty = lines.filter((l) => /^[^\s:][^:]{0,40}:\s/.test(l)).length >= Math.max(1, lines.filter((l) => l.trim()).length / 2);
    if (!chatty) {
      const who = e.source === 'email' || e.source === 'gmail' ? `email from ${(e.actor && e.actor.botName) || 'sender'}` : (SOURCE[e.source] === 'assistant_chat' ? 'user' : 'note');
      out.push({ who, text: squash(e.text) });
      continue;
    }
    let cur = null;
    for (const l of lines) {
      const m = /^([^\s:][^:]{0,40}):\s?(.*)$/.exec(l);
      if (m) {
        const name = m[1].trim();
        const who = /^(user|me|you)$/i.test(name) ? 'user' : (/^(assistant|codeply|wisp)$/i.test(name) ? 'assistant' : name);
        cur = { who, text: m[2] }; out.push(cur);
      } else if (cur) cur.text += ` ${l}`;
    }
  }
  return out.map((m) => ({ who: m.who, text: squash(m.text) })).filter((m) => m.text);
}

/** Brain memories -> the rows Iris reads; returns rows and alias -> real id. */
function knownToMemories(known) {
  const back = {}; const rows = [];
  (known || []).slice(0, 40).forEach((m, i) => {
    const id = `m${i + 1}`;
    back[id] = m.id != null ? m.id : (m.slot || id);
    const ent = m.entity || (m.about === 'project' && m.project ? m.project : 'user');
    rows.push({ id, ent, attr: m.attr || m.slot || '-', val: squash(m.value || m.text), ...(m.when ? { when: m.when } : {}),
      ...(m.until ? { until: String(m.until).slice(0, 10), keep: 'temp' } : {}) });
  });
  return { rows, back };
}

function buildPrompt({ events, known, now, tz }) {
  const messages = eventsToMessages(events);
  const { rows, back } = knownToMemories(known);
  const last = events && events.length ? events[events.length - 1].at : 0;
  const t = localIso(now || (last ? last * (last < 1e11 ? 1000 : 1) : Date.now()), tz);
  const source = SOURCE[(events && events[0] && events[0].source) || 'note'] || 'note';
  const mem = rows.length ? rows.map((m) => [m.id, m.ent, m.attr, m.val, m.when ? `when ${m.when}` : '', m.keep === 'temp' && m.until ? `until ${m.until}` : '']
    .filter(Boolean).map(squash).join(' | ')).join('\n') : '(none)';
  const user = `TASK: observe\nNOW: ${t.iso} ${t.weekday}\nSOURCE: ${source}\nMEMORIES:\n${mem}\nINPUT:\n${messages.map((m, i) => `[${i + 1}] ${m.who}: ${m.text}`).join('\n')}`;
  return { user, messages, rows, back, source };
}

function validateOp(op) {
  if (!op || typeof op !== 'object' || !OPS.includes(op.op)) return 'unknown_op';
  for (const k of REQUIRED[op.op]) if (op[k] == null || op[k] === '') return `missing_${k}`;
  if (!Number.isInteger(op.src) || op.src < 1) return 'bad_src';
  for (const k of Object.keys(ENUMS)) if (op[k] != null && !ENUMS[k].includes(op[k])) return `bad_${k}`;
  if (op.why != null && WHY[op.op] && !WHY[op.op].includes(op.why)) return 'bad_why';
  if (op.ref != null && !/^m\d{1,6}$/.test(op.ref)) return 'bad_ref';
  if (op.when != null && !ISO_WHEN.test(op.when)) return 'bad_when';
  if (op.until != null && !ISO_DATE.test(op.until)) return 'bad_until';
  if (PERSISTENT.includes(op.op)) {
    if (op.keep === 'temp' && !op.until) return 'temp_without_until';
    if (op.kind === 'context' && op.keep !== 'temp') return 'context_not_temp';
  }
  return '';
}

function sameEntity(a, b) {
  const ta = new Set(norm(a).split(' ')); const tb = new Set(norm(b).split(' '));
  return [...ta].every((t) => tb.has(t)) || [...tb].every((t) => ta.has(t));
}

/** Parse + guard. Returns { valid, ops, rejected }. An answer that is not JSON keeps nothing. */
function parseAndGuard(text, messages, rows, source) {
  let obj = null; let valid = true;
  try { obj = typeof text === 'string' ? JSON.parse(text.trim()) : text; } catch { valid = false; }
  if (!obj || !Array.isArray(obj.ops)) return { valid: false, ops: [], rejected: [{ op: String(text).slice(0, 200), reason: 'unparseable' }] };
  const byId = Object.fromEntries(rows.map((m) => [m.id, m]));
  const ops = []; const rejected = []; const seen = new Set();
  for (const op of obj.ops) {
    let reason = validateOp(op);
    if (reason) reason = `schema_${reason}`;
    else if (op.src > messages.length) reason = 'bad_src';
    else if (!messages[op.src - 1].text.includes(squash(op.evid))) reason = 'ungrounded_evidence';
    else if (REF_OPS.includes(op.op) && !byId[op.ref]) reason = 'unknown_ref';
    else if ((op.op === 'update' || op.op === 'conflict') && !sameEntity(op.ent, byId[op.ref].ent)) reason = 'ref_entity_mismatch';
    else if (PERSISTENT.includes(op.op) && source === 'assistant_chat' && messages[op.src - 1].who.toLowerCase() === 'assistant') reason = 'assistant_source';
    else if (PERSISTENT.includes(op.op) && SECRET_RE.test(`${op.attr} ${op.val}`)) reason = 'secret';
    const sig = [op.op, op.ref, norm(op.ent), norm(op.attr), norm(op.val)].join('|');
    if (!reason && op.op !== 'skip' && seen.has(sig)) reason = 'duplicate_op';
    if (reason) { rejected.push({ op, reason }); continue; }
    seen.add(sig); ops.push(op);
  }
  return { valid, ops, rejected };
}

/** One add / update op -> the Brain observation it writes (null for ops that write nothing new). */
function opObservation(op, rows) {
  if (op.op !== 'add' && op.op !== 'update' && op.op !== 'conflict') return null;
  const byId = Object.fromEntries((rows || []).map((m) => [m.id, m]));
  const ent = op.ent; const type = op.type || (ent === 'user' ? 'user' : 'person');
  const about = ent === 'user' ? 'user' : (type === 'project' ? 'project' : 'person');
  const attr = (op.op !== 'add' && byId[op.ref]) ? byId[op.ref].attr : op.attr;
  const slot = ent === 'user' || about === 'project' ? attr : `${ent} ${attr}`;
  return {
    kind: op.keep === 'temp' ? 'context' : BRAIN_KIND[op.kind], slot: norm(slot).slice(0, 80), value: String(op.val).slice(0, 200),
    text: `${ent === 'user' ? 'The user' : ent}: ${attr} is ${op.val}.`.slice(0, 280),
    certainty: op.keep === 'temp' ? 'temporary' : (op.basis === 'stated' ? 'stated' : 'implied'), importance: IMPORTANCE[op.conf] || 0.6, about,
    ...(about === 'project' ? { project: ent } : {}), ...(op.until ? { until: op.until } : {}),
  };
}

/** Accepted ops -> production's { observations, plans } plus the ops with Brain actions, real ids and observations. */
function toProduction(ops, rows, back) {
  const observations = []; const plans = []; const outOps = [];
  for (const op of ops) {
    const observation = opObservation(op, rows);
    const dated = (op.kind === 'event' || op.kind === 'task') && op.when && PERSISTENT.includes(op.op) && op.op !== 'conflict';
    const ent = op.ent;
    if (dated) {
      plans.push({ what: ent === 'user' ? `${op.attr}: ${op.val}` : `${ent} ${op.attr}: ${op.val}`, when: op.when, where: '', who: [ent, ...(op.rel || [])].filter((x) => x !== 'user') });
    }
    // Dated events live in the plans (Life), not as memories; dated tasks are both.
    const writes = observation && !(dated && op.kind === 'event') ? observation : null;
    outOps.push({ ...op, action: BRAIN_ACTION[op.op], ...(op.ref ? { target: back[op.ref] } : {}), ...(writes ? { observation: writes } : {}), plan: !!dated });
    if (writes && op.op !== 'conflict') observations.push(writes);
  }
  return { observations, plans, ops: outOps };
}

/**
 * @param {object} o
 * @param {string} [o.baseUrl]   OpenAI-compatible server on this PC, e.g. http://127.0.0.1:8080/v1
 * @param {string} [o.model]     model name (default 'iris-1')
 * @param {() => Promise<{ baseUrl, apiKey, model }>} [o.ensure]   start the managed llama-server and say where it is
 * @param {() => boolean} [o.canStart]
 * @param {object} [o.extraBody]
 * @param {Function} [o.fetch]
 */
function createIrisProvider(o = {}) {
  const doFetch = o.fetch || globalThis.fetch;
  const target = async () => (o.ensure ? o.ensure() : { baseUrl: o.baseUrl, apiKey: o.apiKey, model: o.model });
  return {
    info: () => ({ id: o.id || 'iris', kind: 'local', local: true, model: o.model || 'iris-1', style: 'iris', contract: VERSION }),
    async available() {
      if (o.ensure) { try { return !!(await (o.canStart ? o.canStart() : true)); } catch { return false; } }
      if (!o.baseUrl || !isLocalUrl(o.baseUrl)) return false;
      try { return (await doFetch(`${o.baseUrl.replace(/\/+$/, '')}/models`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; }
    },
    async extract(input) {
      const t0 = Date.now();
      const tgt = await target();
      if (!tgt || !tgt.baseUrl) throw new Error('the Iris model is not running');
      if (!isLocalUrl(tgt.baseUrl)) throw new Error('Iris must run on this PC');
      const p = buildPrompt(input);
      const body = { model: tgt.model || o.model || 'iris-1', temperature: 0, max_tokens: o.maxTokens || 900, stream: false,
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: p.user }], ...(o.extraBody || {}) };
      const res = await doFetch(`${tgt.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(tgt.apiKey ? { Authorization: `Bearer ${tgt.apiKey}` } : {}) },
        body: JSON.stringify(body), signal: AbortSignal.timeout(o.timeoutMs || 120000),
      });
      if (!res.ok) throw new Error(`Iris answered HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
      const data = await res.json();
      const raw = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
      const g = parseAndGuard(raw, p.messages, p.rows, p.source);
      const prod = toProduction(g.ops, p.rows, p.back);
      return {
        answer: { observations: prod.observations, plans: prod.plans, iris: { contract: VERSION, valid: g.valid, ops: prod.ops, rejected: g.rejected } },
        model: data.model || body.model, ms: Date.now() - t0, usage: data.usage || {}, timings: data.timings || null,
      };
    },
  };
}

module.exports = { VERSION, SYSTEM, SECRET_RE, createIrisProvider, buildPrompt, parseAndGuard, toProduction, opObservation, eventsToMessages, knownToMemories, isLocalUrl };
