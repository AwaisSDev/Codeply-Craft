/**
 * Codeply Iris as a context-model provider (the contract of codeply-cli/lib/context-model.js):
 *
 *   const { createIrisProvider } = require('./iris-provider.js');
 *   const iris = createIrisProvider({ baseUrl: 'http://127.0.0.1:8080/v1', model: 'iris-1' });
 *   provider.info()        { id, kind, local, model, style }
 *   provider.available()   Promise<boolean>
 *   provider.extract(in)   Promise<{ answer, model, ms, usage }>     in = { events, known, now, tz, projects }
 *
 * `answer` has production's shape ({ observations, plans }), so runExtraction() and the guard in
 * context-schema.js work unchanged, plus `answer.iris`:
 *   ops       operations that passed the Iris guard, each with the Brain action it asks for
 *             (insert / replace / reinforce / forget / challenge), the target memory id, verbatim evidence,
 *             sensitivity and confidence: what a store that understands operations should apply
 *   rejected  [{ op, reason }] operations refused by the guard (never applied)
 *   valid     whether the model's answer was strict, schema-valid JSON
 *
 * Iris runs on a local OpenAI-compatible server (Codeply's managed llama-server with the Iris GGUF). The model
 * only proposes. Storage, permissions, retention and deletion stay in the Brain.
 *
 * This file is self-contained (no imports from the app) and is NOT wired into production: it lives under
 * research/iris/ until the owner decides to integrate it.
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
// brain.js SECRET_RE, extended with long digit runs and key-like tokens (same as contract.py)
const SECRET_RE = /(api[_ -]?key|password|passwd|passcode|secret key|bearer|private key|pin code|cvv|card number|iban|ssn|recovery phrase|seed phrase|otp)\b|\bsk-[a-z0-9]{8,}|\b\d{12,19}\b/i;
const BRAIN_KIND = { fact: 'fact', preference: 'preference', goal: 'fact', decision: 'decision', task: 'todo', event: 'context', routine: 'routine', context: 'context' };
const BRAIN_ACTION = { add: 'insert', update: 'replace', confirm: 'reinforce', retract: 'forget', conflict: 'challenge', skip: 'ignored' };
const IMPORTANCE = { high: 0.8, medium: 0.6, low: 0.4 };
const SOURCE = { chat: 'assistant_chat', texts: 'personal_chat', messages: 'personal_chat', slack: 'work_chat', email: 'email', mail: 'email',
  calendar: 'calendar', notes: 'note', note: 'note', screen: 'screen', tasks: 'note', calls: 'personal_chat' };
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const squash = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}_ ]+/gu, ' ').replace(/\s+/g, ' ').trim();
const isLocalUrl = (u) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(String(u || ''));

function localIso(ms, tz) {
  const d = new Date(ms);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' }).formatToParts(d).map((x) => [x.type, x.value]));
  return { iso: `${p.year}-${p.month}-${p.day}T${p.hour === '24' ? '00' : p.hour}:${p.minute}`, weekday: p.weekday };
}

/** Events of one batch -> numbered messages. Chat-like text ("Name: words" lines) is split by speaker. */
function eventsToMessages(events) {
  const out = [];
  for (const e of events || []) {
    const lines = String(e.text || '').split('\n');
    const chatty = lines.filter((l) => /^[^\s:][^:]{0,40}:\s/.test(l)).length >= Math.max(1, lines.filter((l) => l.trim()).length / 2);
    if (!chatty) { out.push({ who: e.source === 'email' ? `email from ${e.actor || 'sender'}` : (SOURCE[e.source] || 'note'), text: squash(e.text) }); continue; }
    let cur = null;
    for (const l of lines) {
      const m = /^([^\s:][^:]{0,40}):\s?(.*)$/.exec(l);
      if (m) { cur = { who: /^(user|me)$/i.test(m[1]) ? 'user' : (/^assistant$/i.test(m[1]) ? 'assistant' : m[1].trim()), text: m[2] }; out.push(cur); } else if (cur) cur.text += ` ${l}`;
    }
  }
  return out.map((m) => ({ who: m.who, text: squash(m.text) })).filter((m) => m.text);
}

/** Brain memories -> the rows Iris reads; returns rows and alias -> original id. */
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
  const t = localIso(now || (events && events.length ? events[events.length - 1].at * (events[events.length - 1].at < 1e11 ? 1000 : 1) : Date.now()), tz);
  const source = SOURCE[(events && events[0] && events[0].source) || 'notes'] || 'note';
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

/** Parse + guard. Returns { valid, ops, rejected }. Malformed output keeps nothing. */
function parseAndGuard(text, messages, rows, source) {
  let obj = null; let valid = true;
  try { obj = typeof text === 'string' ? JSON.parse(text.trim()) : text; } catch { valid = false; }
  if (!obj || !Array.isArray(obj.ops)) return { valid: false, ops: [], rejected: [{ op: String(text).slice(0, 200), reason: 'unparseable' }] };
  const byId = Object.fromEntries(rows.map((m) => [m.id, m]));
  const ops = []; const rejected = []; const seen = new Set();
  for (const op of obj.ops) {
    let reason = validateOp(op);
    if (reason) { valid = false; reason = `schema_${reason}`; }
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

/** Accepted ops -> production's { observations, plans } plus the op list with Brain actions and real ids. */
function toProduction(ops, rows, back) {
  const byId = Object.fromEntries(rows.map((m) => [m.id, m]));
  const observations = []; const plans = []; const outOps = [];
  for (const op of ops) {
    const o = { ...op, action: BRAIN_ACTION[op.op], ...(op.ref ? { target: back[op.ref] } : {}) };
    outOps.push(o);
    if (!PERSISTENT.includes(op.op) || op.op === 'conflict') continue;
    const ent = op.ent; const type = op.type || (ent === 'user' ? 'user' : 'person');
    const about = ent === 'user' ? 'user' : (type === 'project' ? 'project' : 'person');
    const slot = op.op === 'update' && byId[op.ref] ? (ent === 'user' ? byId[op.ref].attr : `${ent} ${byId[op.ref].attr}`) : (ent === 'user' ? op.attr : `${ent} ${op.attr}`);
    if ((op.kind === 'event' || op.kind === 'task') && op.when) {
      plans.push({ what: ent === 'user' ? `${op.attr}: ${op.val}` : `${ent} ${op.attr}: ${op.val}`, when: op.when, where: '', who: [ent, ...(op.rel || [])].filter((x) => x !== 'user') });
      if (op.kind === 'event') continue;                     // production keeps dated events as plans only
    }
    observations.push({
      kind: op.keep === 'temp' ? 'context' : BRAIN_KIND[op.kind], slot: norm(slot).slice(0, 80), value: op.val.slice(0, 200),
      text: `${ent === 'user' ? 'The user' : ent}: ${op.attr} is ${op.val}.`.slice(0, 280),
      certainty: op.keep === 'temp' ? 'temporary' : (op.basis === 'stated' ? 'stated' : 'implied'), importance: IMPORTANCE[op.conf], about,
      ...(type === 'project' ? { project: ent } : {}), ...(op.until ? { until: op.until } : {}),
    });
  }
  return { observations, plans, ops: outOps };
}

/**
 * @param {object} o
 * @param {string} [o.baseUrl]  OpenAI-compatible local server, e.g. http://127.0.0.1:8080/v1
 * @param {string} [o.model]    model name the server knows (default 'iris-1')
 * @param {() => Promise<{baseUrl, apiKey, model}>} [o.ensure]  start the managed server and say where it is
 * @param {boolean} [o.constrain]  send the JSON Schema for constrained decoding (default false: the guard decides)
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
      if (!isLocalUrl(tgt.baseUrl)) throw new Error('Iris must run on this PC');   // context never leaves the device through this provider
      const p = buildPrompt(input);
      const body = { model: tgt.model || o.model || 'iris-1', temperature: 0, max_tokens: o.maxTokens || 900, stream: false,
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: p.user }], ...(o.extraBody || {}) };
      const res = await doFetch(`${tgt.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(tgt.apiKey ? { Authorization: `Bearer ${tgt.apiKey}` } : {}) },
        body: JSON.stringify(body), signal: AbortSignal.timeout(o.timeoutMs || 180000),
      });
      if (!res.ok) throw new Error(`Iris answered HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
      const data = await res.json();
      const raw = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
      const g = parseAndGuard(raw, p.messages, p.rows, p.source);
      const prod = toProduction(g.ops, p.rows, p.back);
      return { answer: { observations: prod.observations, plans: prod.plans, iris: { contract: VERSION, valid: g.valid, ops: prod.ops, rejected: g.rejected } },
        model: data.model || body.model, ms: Date.now() - t0, usage: data.usage || {}, timings: data.timings || null };
    },
  };
}

module.exports = { VERSION, SYSTEM, createIrisProvider, buildPrompt, parseAndGuard, toProduction, eventsToMessages, knownToMemories };
