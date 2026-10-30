/**
 * Model backends for context intelligence, all behind one contract, so the
 * Context Engine never knows which model it is talking to:
 *
 *   provider.info()        { id, kind, local, model, style }
 *   provider.available()   Promise<boolean>, cheap (never loads a model)
 *   provider.extract(in)   Promise<{ answer, model, ms, usage }>
 *                          in = { events, known, now, tz, projects }
 *                          answer = the backend's JSON (or text); runExtraction()
 *                          puts it through the guard (context-schema.js)
 *
 *   rules    no model: patterns for plain statements; the floor every model
 *            must beat, and what runs when no model may or can be used
 *   cloud    the user's chat route through ai.chatJson (hosted, BYOK or a
 *            local Ollama: local is true only when the route is on this PC)
 *   local    any OpenAI-compatible server on this PC: Codeply's managed
 *            llama-server (local-runtime.js), Ollama, LM Studio. Sends the
 *            JSON Schema so the server constrains decoding.
 *
 * routeFor() picks one per batch from the user's mode (see the table in
 * LOCAL-INTELLIGENCE-ARCHITECTURE.md §4). Sensitive events never go to a
 * backend that is not local, in any mode.
 */
const { buildExtractionMessages } = require('./context-prompt.js');
const { checkExtraction, extractionJsonSchema } = require('./context-schema.js');

const MODES = ['legacy', 'cloud', 'auto', 'local', 'rules', 'off'];
const isLocalUrl = (u) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(String(u || ''));

// ─── rules: no model ────────────────────────────────────────────────────────

const JOKE_RE = /\b(lol|lmao|rofl|jk|just kidding|haha+|yeah right|as if|sure,? i (just )?love)\b|\/s\b|🙄|😂/i;
const HYPO_RE = /\b(what if|if i (were|was|had)|imagine|maybe|might|someday|would i|should i|i wish|i wonder)\b|\?\s*$/i;
const QUOTE_RE = /\b(my (friend|mom|mum|mother|dad|father|boss|sister|brother|neighbou?r|colleague|manager|wife|husband)|he|she|they) (says|said|thinks|told me|reckons)\b|\baccording to\b/i;
const TEMP_RE = /\b(today|tonight|this (week|weekend|morning|afternoon|evening)|right now|at the moment|for now|till|until)\b/i;
const RELATIONS = 'wife|husband|sister|brother|mom|mum|mother|dad|father|friend|girlfriend|boyfriend|son|daughter|partner|boss|cousin|uncle|aunt|colleague|cofounder|co-founder';
// Checked in order: "Supabase auth" is auth before Supabase is a database.
const TECH = {
  auth: /\b(clerk|auth0|supabase auth|nextauth|firebase auth|magic links?|oauth|passkeys?)\b/i,
  database: /\b(postgres(ql)?|mysql|mongo(db)?|sqlite|supabase|firebase|redis|dynamodb|planetscale|neon)\b/i,
  hosting: /\b(vercel|netlify|aws|gcp|azure|fly\.io|render|railway|cloudflare|heroku)\b/i,
  framework: /\b(next\.?js|react|vue|svelte|angular|django|rails|laravel|express|fastapi|flutter|react native|astro|remix)\b/i,
  language: /\b(typescript|javascript|python|go|golang|rust|java|kotlin|swift|ruby|php|c#)\b/i,
  styling: /\b(tailwind|css modules|styled[- ]components|bootstrap|sass)\b/i,
};
const sentenceSplit = (t) => String(t || '').split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
const tidy = (s, n = 80) => String(s || '').replace(/[.!?,;:]+$/, '').replace(/\s+/g, ' ').trim().slice(0, n);
const firstWords = (s, n) => tidy(s).toLowerCase().split(' ').filter((w) => !/^(the|a|an|my|our|to|of|and|really|very|so)$/.test(w)).slice(0, n).join(' ');

function userLines(e) {
  if (e.source === 'chat') {
    // Only what the user said: "User: …" lines (the assistant's reply is not a fact about them).
    const lines = []; let on = false;
    for (const l of String(e.text).split('\n')) {
      if (/^user:/i.test(l)) { on = true; lines.push(l.replace(/^user:\s*/i, '')); } else if (/^(assistant|[a-z]+):/i.test(l)) on = false; else if (on) lines.push(l);
    }
    return lines.join('\n');
  }
  return e.trust === 'external' ? '' : e.text;
}

function untilFrom(s) {
  const m = /\b(?:till|until|by)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(s);
  if (!m) return '';
  let h = +m[1];
  if (m[3] && /pm/i.test(m[3]) && h < 12) h += 12;
  if (!m[3] && h >= 1 && h <= 7) h += 12; // "till 4" in a day means the afternoon
  return `${String(h).padStart(2, '0')}:${m[2] || '00'}`;
}

/** The rules extractor: plain, first-person statements only. */
function rulesExtract({ events }) {
  const observations = [];
  const push = (o) => { if (observations.length < 8 && !observations.some((x) => x.slot === o.slot && x.kind === o.kind)) observations.push(o); };
  for (const e of events || []) {
    for (const s of sentenceSplit(userLines(e))) {
      const certainty = JOKE_RE.test(s) ? 'joking' : QUOTE_RE.test(s) ? 'quoting' : HYPO_RE.test(s) ? 'hypothetical' : 'stated';
      const base = { certainty, about: 'user', ...(e.project ? { project: e.project } : {}) };
      let m;
      if ((m = /\bmy (?:favou?rite) ([a-z ]{2,30}?) is ([^.!?]{2,60})/i.exec(s))) {
        push({ ...base, kind: 'preference', slot: `favorite ${tidy(m[1]).toLowerCase()}`, value: tidy(m[2], 60), text: `The user's favorite ${tidy(m[1]).toLowerCase()} is ${tidy(m[2], 60)}.`, importance: 0.7 });
      } else if ((m = new RegExp(`\\b[Mm]y (${RELATIONS}),? ([A-Z][a-z]+)(?:,)? (is|was|loves|likes|hates|works|lives)\\b([^.!?]{0,80})`).exec(s))) {
        const rel = m[1].toLowerCase(); const name = m[2];
        push({ ...base, about: 'person', kind: 'fact', slot: `${name.toLowerCase()} ${rel}`, value: tidy(`${m[3]}${m[4]}`, 80), text: `${name}, the user's ${rel}, ${tidy(`${m[3]}${m[4]}`, 100)}.`, importance: 0.65 });
      } else if ((m = /\bI(?:'m| am) (?:in|at|on|with) ([^.!?]{2,50}?)(?: (?:till|until|this|today|tonight|for now)\b[^.!?]*)$/i.exec(s)) && TEMP_RE.test(s)) {
        const until = untilFrom(s);
        push({ ...base, kind: 'context', certainty: certainty === 'stated' ? 'temporary' : certainty, slot: firstWords(m[1], 3), value: tidy(m[1], 60), text: `The user is ${s.match(/\b(in|at|on|with)\b/i)[1].toLowerCase()} ${tidy(m[1], 60)}.`, importance: 0.5, ...(until ? { until } : {}) });
      } else if ((m = /\bI (?:really |strongly )?(prefer|like|love|hate|dislike|can't stand|cannot stand|enjoy)\s+([^.!?]{2,80})/i.exec(s))) {
        const verb = m[1].toLowerCase(); const obj = tidy(m[2], 80);
        const neg = /hate|dislike|stand/.test(verb);
        push({ ...base, kind: 'preference', slot: firstWords(obj.replace(/\bover\b.*$/i, ''), 3), value: neg ? `dislikes ${obj}` : obj, text: `The user ${neg ? 'dislikes' : verb === 'prefer' ? 'prefers' : `${verb}s`} ${obj}.`, importance: 0.7 });
      } else if ((m = /\bI(?:'m| am) (?:a|an) ([a-z][a-z -]{2,40})\b/i.exec(s)) && !TEMP_RE.test(s)) {
        push({ ...base, kind: 'fact', slot: 'occupation', value: tidy(m[1], 40), text: `The user is a ${tidy(m[1], 40)}.`, importance: 0.75 });
      } else if ((m = /\bI (?:live|am based) in ([A-Z][a-zA-Z ]{1,40})/.exec(s))) {
        push({ ...base, kind: 'fact', slot: 'home city', value: tidy(m[1], 40), text: `The user lives in ${tidy(m[1], 40)}.`, importance: 0.75 });
      } else if ((m = /\b(?:let'?s|let us|we(?:'ll| will)|we decided to|we're going with|go with|switch(?:ing)? to|we use|use)\s+(?:use\s+)?([^.!?]{2,80})/i.exec(s))) {
        const what = tidy(m[1], 80);
        const area = Object.keys(TECH).find((k) => TECH[k].test(what)) || '';
        if (!area && !e.project) continue;
        push({ ...base, kind: 'decision', about: 'project', slot: area || firstWords(what, 3), value: area ? what.match(TECH[area])[0] : what, text: `${e.project ? `The ${e.project} project` : 'The project'} uses ${what}.`, importance: 0.8 });
      } else if ((m = /\b(?:remind me to|I need to|I have to|I must|don't let me forget to|todo:?)\s+([^.!?]{3,100})/i.exec(s))) {
        push({ ...base, kind: 'todo', slot: firstWords(m[1], 3), value: tidy(m[1], 80), text: `The user needs to ${tidy(m[1], 100)}.`, importance: 0.6 });
      } else if ((m = /\bI (?:usually|always|normally) ([^.!?]{3,80})/i.exec(s)) || (m = /\b(?:every (?:day|morning|evening|night|week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)),? I ([^.!?]{3,80})/i.exec(s))) {
        push({ ...base, kind: 'routine', slot: firstWords(m[1], 3), value: tidy(m[1], 80), text: `The user ${/^(usually|always|normally)/i.test(m[0].slice(2)) ? '' : 'regularly '}${tidy(m[1], 80)}.`.replace(/\s+/g, ' '), importance: 0.6 });
      }
    }
  }
  return { observations, plans: [] };
}

function createRulesProvider() {
  return {
    info: () => ({ id: 'rules', kind: 'rules', local: true, model: 'rules-v1', style: 'none' }),
    available: async () => true,
    async extract(input) {
      const t = Date.now();
      return { answer: rulesExtract(input), model: 'rules-v1', ms: Date.now() - t, usage: {} };
    },
  };
}

// ─── cloud: the chat route (ai.chatJson) ────────────────────────────────────

/**
 * @param {{ chatJson: (messages) => Promise<{success, json, error, usage, modelUsed}>, routeIsLocal?: () => boolean, style?: string }} o
 */
function createCloudProvider(o) {
  const local = () => { try { return !!(o.routeIsLocal && o.routeIsLocal()); } catch { return false; } };
  return {
    info: () => ({ id: 'cloud', kind: 'cloud', local: local(), model: o.model || 'chat route', style: o.style || 'full' }),
    available: async () => typeof o.chatJson === 'function',
    async extract(input) {
      const t = Date.now();
      const r = await o.chatJson(buildExtractionMessages({ ...input, style: o.style || 'full' }));
      if (!r || !r.success) throw new Error((r && r.error) || 'the chat model did not answer');
      return { answer: r.json, model: r.modelUsed || o.model || 'chat route', ms: Date.now() - t, usage: r.usage || {} };
    },
  };
}

// ─── local: an OpenAI-compatible server on this PC ──────────────────────────

/**
 * @param {object} o
 * @param {string} [o.baseUrl]   e.g. http://127.0.0.1:8080/v1 (Ollama: http://127.0.0.1:11434/v1)
 * @param {string} [o.model]
 * @param {string} [o.apiKey]
 * @param {() => Promise<{baseUrl, apiKey, model}>} [o.ensure]  start a managed server (local-runtime.js) and return where it is
 * @param {() => boolean|Promise<boolean>} [o.canStart]         whether ensure() could work (binary and model present)
 * @param {'full'|'compact'} [o.style]
 * @param {boolean} [o.schema]   send the JSON Schema (default true)
 * @param {object} [o.extraBody] e.g. { chat_template_kwargs: { enable_thinking: false } } for Qwen3
 * @param {number} [o.timeoutMs]
 * @param {Function} [o.fetch]
 */
function createLocalProvider(o = {}) {
  const doFetch = o.fetch || globalThis.fetch;
  const id = o.id || 'local';
  const target = async () => (o.ensure ? o.ensure() : { baseUrl: o.baseUrl, apiKey: o.apiKey, model: o.model });
  return {
    info: () => ({ id, kind: 'local', local: true, model: o.model || '', style: o.style || 'full' }),
    async available() {
      if (o.ensure) { try { return !!(await (o.canStart ? o.canStart() : true)); } catch { return false; } }
      if (!o.baseUrl || !isLocalUrl(o.baseUrl)) return false;
      try {
        const res = await doFetch(`${o.baseUrl.replace(/\/+$/, '')}/models`, { headers: o.apiKey ? { Authorization: `Bearer ${o.apiKey}` } : {}, signal: AbortSignal.timeout(2000) });
        return res.ok;
      } catch { return false; }
    },
    async extract(input) {
      const t0 = Date.now();
      const tgt = await target();
      if (!tgt || !tgt.baseUrl) throw new Error('the local model is not running');
      if (!isLocalUrl(tgt.baseUrl)) throw new Error('a local backend must be on this PC'); // never a remote URL under the local label
      const body = {
        model: tgt.model || o.model || 'local',
        messages: buildExtractionMessages({ ...input, style: o.style || 'full' }),
        temperature: 0, max_tokens: o.maxTokens || 700, stream: false, cache_prompt: true,
        ...(o.schema === false ? { response_format: { type: 'json_object' } } : { response_format: { type: 'json_schema', json_schema: { name: 'extraction', strict: true, schema: extractionJsonSchema() } } }),
        ...(o.extraBody || {}),
      };
      const res = await doFetch(`${tgt.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(tgt.apiKey ? { Authorization: `Bearer ${tgt.apiKey}` } : {}) },
        body: JSON.stringify(body), signal: AbortSignal.timeout(o.timeoutMs || 180000),
      });
      if (!res.ok) throw new Error(`the local model answered HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
      const data = await res.json();
      const msg = data.choices && data.choices[0] && data.choices[0].message;
      return { answer: (msg && msg.content) || '', model: data.model || body.model, ms: Date.now() - t0, usage: data.usage || {}, timings: data.timings || null };
    },
  };
}

// ─── Running one extraction through the guard ───────────────────────────────

/**
 * One batch: the backend proposes, the guard (context-schema.js) disposes.
 * Never throws: a failing backend comes back as { ok: false, error }.
 */
async function runExtraction(provider, input, opts = {}) {
  const info = provider.info();
  try {
    const r = await provider.extract(input);
    const g = checkExtraction(r.answer, { events: input.events, minImportance: opts.minImportance });
    return { ...g, provider: info.id, kind: info.kind, local: info.local, model: r.model || info.model, ms: r.ms, usage: r.usage || {}, timings: r.timings || null, raw: opts.keepRaw ? r.answer : undefined };
  } catch (e) {
    return { ok: false, observations: [], plans: [], dropped: [], error: String(e && e.message || e).slice(0, 300), provider: info.id, kind: info.kind, local: info.local, model: info.model };
  }
}

// ─── Routing ────────────────────────────────────────────────────────────────

/**
 * The backend for one batch.
 * @param {{ mode: string, sensitive: boolean, providers: { rules, cloud?, local? } }} o
 * @returns {Promise<{ provider: object|null, why: string }>}
 */
async function routeFor({ mode, sensitive, providers }) {
  const m = MODES.includes(mode) ? mode : 'legacy';
  const { rules, cloud, local } = providers;
  const localUp = local ? await local.available().catch(() => false) : false;
  const cloudUp = cloud ? await cloud.available().catch(() => false) : false;
  if (m === 'off') return { provider: null, why: 'context intelligence is off' };
  if (m === 'rules') return { provider: rules, why: 'rules mode' };
  // Sensitive: on this PC or not at all. A chat route on localhost counts as local.
  if (sensitive) {
    if (localUp) return { provider: local, why: 'sensitive: local model' };
    if (cloudUp && cloud.info().local) return { provider: cloud, why: 'sensitive: the chat route is on this PC' };
    return { provider: rules, why: 'sensitive and no local model: rules only' };
  }
  if (m === 'local') return localUp ? { provider: local, why: 'local mode' } : { provider: rules, why: 'local mode, no local model running: rules only (never the cloud)' };
  if (m === 'auto') {
    if (localUp) return { provider: local, why: 'auto: local model' };
    if (cloudUp) return { provider: cloud, why: 'auto: no local model, chat route (allowed by auto)' };
    return { provider: rules, why: 'auto: no model available' };
  }
  // cloud and legacy (legacy only reaches the engine for sources the user switched on)
  if (cloudUp) return { provider: cloud, why: `${m}: chat route` };
  return { provider: rules, why: `${m}: no chat route` };
}

module.exports = { MODES, isLocalUrl, rulesExtract, createRulesProvider, createCloudProvider, createLocalProvider, runExtraction, routeFor };
