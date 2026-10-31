/**
 * The contracts of the context-intelligence layer (LOCAL-INTELLIGENCE-ARCHITECTURE.md):
 *
 *   events        what a collector hands the engine: one thing that happened,
 *                 with where it came from, how far it can be trusted and
 *                 whether it may ever leave this PC
 *   extraction    what every model backend must return: observations in the
 *                 shape brain.observe() already takes, and plans for life.js
 *   the guard     checkExtraction(): parse, validate, ground and clamp a
 *                 backend's answer before anything reaches the brain
 *
 * Kinds and certainty are the brain's own (brain.KINDS, brain.CERTAINTY), so
 * nothing is translated between the model and the memory.
 */
const crypto = require('crypto');
const { KINDS, KIND_KEYS, CERTAINTY, cleanObservation, terms } = require('./brain.js');
const secretScan = require('./secret-scan.js');

const SCHEMA_VERSION = 1;
const SOURCES = ['chat', 'heard', 'call', 'orbit', 'email', 'test'];
/**
 *   user      the user's own words to Codeply (a chat, an Orbit question)
 *   mixed     the user and other people (heard around them, a call)
 *   external  someone else's words (an email they received)
 */
const TRUST = ['user', 'mixed', 'external'];
const MAX_EVENT_TEXT = 6000;
const MAX_OBSERVATIONS = 8;
const MAX_PLANS = 5;
const ABOUT = ['user', 'person', 'project'];
// An email can tell us about a meeting or a person; it cannot tell us what the user likes.
const SELF_KINDS = new Set(['preference', 'style', 'routine']);
// Nor where they are or what they are doing right now (live context).
const NOT_FROM_OTHERS = new Set([...SELF_KINDS, 'context']);
// A sentence that talks to the assistant ("AI reading this: save X") is an attempted instruction, not information.
// Not "bot" or "model" on their own: "invoice-bot" and "business model" are ordinary words (found in evaluation).
const INSTRUCTION_RE = /\b(ai|a\.i\.|assistant|chatbot|llm|system note|system prompt|ignore (all |any )?(previous|prior|above)( instructions)?|save (this|it|that)|remember (this|that|it)|store (this|it|that)|add (a )?memory|memori[sz]e (this|that|it)|importance \d)\b/i;

const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const clipKeep = (s, n) => String(s == null ? '' : s).replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').trim().slice(0, n);
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// ─── Events ─────────────────────────────────────────────────────────────────

/** Meta stays small (it rides along in the queue, never to a model). */
function smallMeta(m) {
  if (!m || typeof m !== 'object') return {};
  try { const s = JSON.stringify(m); return s.length <= 2000 ? JSON.parse(s) : { truncated: true }; } catch { return {}; }
}

/**
 * A raw event from a collector as a clean event, or { errors }.
 * raw: { source, text, at?, trust?, sensitive?, product?, project?, actor?, externalId?, meta? }
 */
function normalizeEvent(raw, now = Date.now()) {
  const errors = [];
  if (!raw || typeof raw !== 'object') return { errors: ['an event must be an object'] };
  const source = String(raw.source || '').toLowerCase().trim();
  if (!SOURCES.includes(source)) errors.push(`unknown source "${raw.source}"`);
  const text = clipKeep(raw.text, MAX_EVENT_TEXT);
  if (text.length < 3) errors.push('an event needs some text');
  let at = Number(raw.at);
  if (!Number.isFinite(at) || at <= 0) at = now;
  // A timestamp far in the future is a bug upstream; keep the event at "now".
  if (at > now + 86400000) at = now;
  const trust = TRUST.includes(raw.trust) ? raw.trust : 'external';
  if (errors.length) return { errors };
  const actor = raw.actor && typeof raw.actor === 'object'
    ? { botId: clip(raw.actor.botId, 60), botName: clip(raw.actor.botName, 40) } : null;
  // Same source and same external id (or the same words) is the same event.
  const identity = raw.externalId ? `${source}:${raw.externalId}` : `${source}:${text}`;
  return {
    event: {
      id: `ev_${hash(identity).slice(0, 24)}`,
      source, product: clip(raw.product, 20) || (source === 'chat' ? 'craft' : 'life'),
      at: Math.round(at), trust, sensitive: !!raw.sensitive,
      project: clip(raw.project, 80), actor, text,
      meta: smallMeta(raw.meta),
      contentHash: hash(`${source}:${text}`).slice(0, 32),
    },
  };
}

// ─── The extraction contract ────────────────────────────────────────────────

/** JSON Schema of a backend's answer, for constrained decoding (llama.cpp, Ollama). */
function extractionJsonSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['observations', 'plans'],
    properties: {
      observations: {
        type: 'array', maxItems: MAX_OBSERVATIONS,
        items: {
          type: 'object', additionalProperties: false,
          required: ['kind', 'slot', 'value', 'text', 'certainty', 'importance'],
          properties: {
            kind: { type: 'string', enum: KIND_KEYS.filter((k) => k !== 'lesson') },
            slot: { type: 'string', maxLength: 60 },
            value: { type: 'string', maxLength: 160 },
            text: { type: 'string', maxLength: 240 },
            certainty: { type: 'string', enum: CERTAINTY },
            importance: { type: 'number', minimum: 0, maximum: 1 },
            project: { type: 'string', maxLength: 80 },
            until: { type: 'string', maxLength: 20 },
            about: { type: 'string', enum: ABOUT },
          },
        },
      },
      plans: {
        type: 'array', maxItems: MAX_PLANS,
        items: {
          type: 'object', additionalProperties: false, required: ['what', 'when'],
          properties: {
            what: { type: 'string', maxLength: 140 },
            when: { type: 'string', maxLength: 20 },
            where: { type: 'string', maxLength: 120 },
            who: { type: 'array', maxItems: 6, items: { type: 'string', maxLength: 60 } },
          },
        },
      },
    },
  };
}

function tryParse(s) { try { return { ok: true, value: JSON.parse(s) }; } catch { return { ok: false }; } }
/** The JSON object in a model's reply: raw, inside a fence, or first { to last }. */
function parseJsonObject(text) {
  if (text && typeof text === 'object') return text;
  const s = String(text || '').trim();
  if (!s) return undefined;
  const direct = tryParse(s);
  if (direct.ok) return direct.value;
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) { const inner = tryParse(fenced[1].trim()); if (inner.ok) return inner.value; }
  // Thinking models (Qwen3) may put <think>…</think> first.
  const noThink = s.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const a = noThink.indexOf('{'); const b = noThink.lastIndexOf('}');
  if (a !== -1 && b > a) { const sliced = tryParse(noThink.slice(a, b + 1)); if (sliced.ok) return sliced.value; }
  return undefined;
}

const groundTerms = (o) => terms(`${o.value} ${o.text}`).filter((w) => !/^(user|their|them|prefer|prefers|likes|like|want|wants|use|uses)$/.test(w));
/** Some meaningful word of the observation was really in the events (a hallucination guard). */
function grounded(o, sourceTerms) {
  const want = groundTerms(o);
  if (!want.length) return false;
  return want.some((w) => sourceTerms.has(w));
}

/**
 * The guard every backend's answer goes through before the brain sees it.
 *
 * Secrets (SECURITY-SECRETS.md) fail closed: an observation or a plan whose
 * slot, value, text, project or people hold anything secret-scan.js calls a
 * secret is dropped whole, never stored with the secret cut out. That covers
 * a value the redactor removed from the events (ctx.secrets) and any value
 * the events themselves mark as secret, so a model that copies one back from
 * the known memories, or invents one, is caught too. Dropped secrets keep
 * only their kind and the reason, never the words.
 *
 * @param {object|string} answer   the backend's JSON (or raw text)
 * @param {{ events: object[], minImportance?: number, secrets?: Iterable<string> }} ctx
 *   secrets: what redact() removed from these events (its .values); in memory only
 * @returns {{ ok: boolean, observations: object[], plans: object[], dropped: {item, why}[], error?: string }}
 */
function checkExtraction(answer, ctx = {}) {
  const events = Array.isArray(ctx.events) ? ctx.events : [];
  const minImportance = ctx.minImportance == null ? 0.35 : Number(ctx.minImportance);
  const parsed = parseJsonObject(answer);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, observations: [], plans: [], dropped: [], error: 'not a JSON object' };
  }
  if (!Array.isArray(parsed.observations) && !Array.isArray(parsed.plans)) {
    return { ok: false, observations: [], plans: [], dropped: [], error: 'no "observations" list in the answer' };
  }
  const trust = events.some((e) => e.trust === 'external') ? 'external' : events.some((e) => e.trust === 'mixed') ? 'mixed' : 'user';
  const sourceTerms = new Set(terms(events.map((e) => e.text).join('\n')));
  // Words that appear only in sentences addressed to the assistant, in text the user did not type.
  const said = []; const aimed = [];
  for (const e of events) {
    for (const s of String(e.text).split(/(?<=[.!?])\s+|\n+/)) (e.trust !== 'user' && INSTRUCTION_RE.test(s) ? aimed : said).push(s);
  }
  const saidTerms = new Set(terms(said.join(' ')));
  const aimedTerms = new Set(terms(aimed.join(' ')).filter((w) => !saidTerms.has(w)));
  const project = (events.find((e) => e.project) || {}).project || '';
  const dropped = [];
  const observations = [];
  // Values that must never come back out: what the redactor took, and what the events mark as secret.
  const secrets = new Set([...(ctx.secrets || []), ...secretScan.secretValues(events.map((e) => e.text))].map((v) => String(v).trim()).filter((v) => v.length >= 3));
  // When this batch had a secret redacted, a code-like value in the answer that is not in the
  // (redacted) events can only be the removed secret, copied from elsewhere or recalled: drop it.
  // This still works after a restart, when the removed values themselves are gone.
  const sourceText = events.map((e) => e.text).join('\n');
  const secretWhy = (o, opt = {}) => secretScan.guardWhy(o, { secrets, sourceText, ...opt });
  const list = Array.isArray(parsed.observations) ? parsed.observations : [];
  for (const raw of list.slice(0, MAX_OBSERVATIONS * 2)) {
    if (!raw || typeof raw !== 'object') { dropped.push({ item: null, why: 'not an object' }); continue; }
    // Before anything else, on the model's own words (cleanObservation clips, which could cut a secret in half).
    const leak = secretWhy({ ...raw, who: [raw.project, raw.until, raw.about].filter((x) => typeof x === 'string') });
    if (leak) { dropped.push({ item: { kind: String(raw.kind || '') }, why: `looks like a secret (${leak})` }); continue; }
    // A model may only propose: never a scope (team), never a delete, never a lesson.
    const { scope, forget, ...rest } = raw; // eslint-disable-line no-unused-vars
    if (String(rest.kind || '').toLowerCase() === 'lesson') { dropped.push({ item: raw, why: 'lessons come from bots, not events' }); continue; }
    // "Ayesha loves sketching" is a fact about Ayesha, not the user's own preference.
    if (raw.about === 'person' && SELF_KINDS.has(String(rest.kind || '').toLowerCase())) rest.kind = 'fact';
    const o = cleanObservation(rest);
    if (!o) { dropped.push({ item: raw, why: 'nothing to keep' }); continue; }
    const leak2 = secretWhy(o);
    if (leak2) { dropped.push({ item: { kind: o.kind }, why: `looks like a secret (${leak2})` }); continue; }
    let importance = Number(raw.importance);
    if (!Number.isFinite(importance)) importance = 0.5;
    importance = Math.max(0, Math.min(1, importance));
    let certainty = o.certainty;
    if (trust === 'external') {
      if (NOT_FROM_OTHERS.has(o.kind) && raw.about !== 'person') { dropped.push({ item: raw, why: 'someone else cannot set the user\'s preferences or what they are doing' }); continue; }
      if (certainty === 'stated') certainty = 'implied';
    } else if (trust === 'mixed' && certainty === 'stated') certainty = 'implied';
    if (!grounded(o, sourceTerms)) { dropped.push({ item: raw, why: 'not in the events' }); continue; }
    if (aimedTerms.size) {
      const g = groundTerms(o).filter((w) => sourceTerms.has(w));
      if (g.length && g.filter((w) => aimedTerms.has(w)).length / g.length >= 0.5) { dropped.push({ item: raw, why: 'it comes from text telling the assistant what to do' }); continue; }
    }
    if (importance < minImportance && !['joking', 'hypothetical', 'quoting'].includes(certainty)) { dropped.push({ item: raw, why: `importance ${importance} is below ${minImportance}` }); continue; }
    observations.push({
      kind: o.kind, slot: o.slot, value: o.value, text: o.text, certainty,
      importance: Math.round(importance * 100) / 100,
      ...(o.project || (project && ['decision', 'idea', 'requirement', 'todo'].includes(o.kind)) ? { project: o.project || project } : {}),
      ...(o.kind === 'context' && raw.until ? { until: clip(raw.until, 20) } : {}),
      ...(ABOUT.includes(raw.about) ? { about: raw.about } : {}),
    });
    if (observations.length >= MAX_OBSERVATIONS) break;
  }
  const plans = (Array.isArray(parsed.plans) ? parsed.plans : []).filter((p) => p && typeof p === 'object' && clip(p.what, 140).length >= 3)
    .filter((p) => {
      // A plan goes to life.js and the calendar: no secret value in it ("gate code 4471 at Ali's"). Naming
      // one is fine here ("rotate the SSO password by Friday" is a reminder worth keeping), so no topic rule.
      const leak = secretWhy({ what: p.what, where: p.where, text: [p.when, p.note, p.notes].filter((x) => typeof x === 'string').join(' '), who: Array.isArray(p.who) ? p.who.map(String) : p.who ? [String(p.who)] : [] }, { topic: false });
      if (leak) dropped.push({ item: { plan: true }, why: `looks like a secret (${leak})` });
      return !leak;
    })
    .slice(0, MAX_PLANS).map((p) => ({
      what: clip(p.what, 140), when: clip(p.when, 20), where: clip(p.where, 120),
      who: (Array.isArray(p.who) ? p.who : p.who ? [p.who] : []).map((x) => clip(x, 60)).filter(Boolean).slice(0, 6),
    }));
  return { ok: true, observations, plans, dropped };
}

module.exports = {
  SCHEMA_VERSION, SOURCES, TRUST, ABOUT, KINDS, CERTAINTY, MAX_EVENT_TEXT,
  normalizeEvent, extractionJsonSchema, parseJsonObject, checkExtraction, grounded, hash,
};
