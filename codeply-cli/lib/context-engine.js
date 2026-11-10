/**
 * The Context Engine: queued events in, observations into the brain out.
 *
 *   collectors ─► ingest() ─► context-events.js (queue)
 *                                 │  batches: same trust, same sensitivity, same
 *                                 │  project and bot, within a token budget
 *                                 ▼
 *                 redact (context-redact.js) ─► routeFor (context-model.js)
 *                                 ▼
 *                 runExtraction: backend + guard (context-schema.js)
 *                                 ▼
 *                 brain.observe() for each observation, life.notePlans()
 *                                 ▼
 *                 the outcome on each event: backend, model, local or not,
 *                 and what every observation did in the brain (memory ids)
 *
 * The brain still decides everything about memory (dedupe by slot and text,
 * contradictions, locks, expiry, secrets); this engine only feeds it.
 *
 * Scheduling: a batch starts debounceMs after the last event (at most
 * maxWaitMs after the first), one batch at a time, and after a batch that took
 * t ms the next waits at least t * (1 - duty) / duty, so background work stays
 * near the duty cycle (default 25 % of one core's time while busy).
 */
const { redact } = require('./context-redact.js');
const { routeFor, runExtraction } = require('./context-model.js');
const { estimateTokens } = require('./context-prompt.js');
const { exchangeEvent } = require('./context-collectors.js');

const DEFAULTS = {
  mode: 'legacy',
  minImportance: 0.35,
  tokenBudget: 1800,
  maxBatchEvents: 8,
  debounceMs: 20000,
  maxWaitMs: 120000,
  duty: 0.25,
};

/**
 * @param {object} o
 * @param {object} o.store       context-events.js store
 * @param {object} o.brain       brain.js (the module)
 * @param {object} [o.life]      life.js (the module), for plans
 * @param {{ rules: object, cloud?: object, local?: object }} o.providers
 * @param {() => object} [o.settings]   current settings (merged over DEFAULTS)
 * @param {() => string} [o.tz]
 * @param {(what: object) => void} [o.onChange]  something reached the brain
 * @param {() => number} [o.now]
 * @param {(msg: string) => void} [o.log]
 */
function createEngine(o) {
  const now = o.now || Date.now;
  const settings = () => ({ ...DEFAULTS, ...((o.settings && o.settings()) || {}) });
  const log = o.log || (() => {});
  const status = { running: false, lastRun: null, lastError: '', batches: 0 };
  let timer = null; let firstQueuedAt = 0; let stopped = true; let nextEarliest = 0;

  // ─── Ingest ───────────────────────────────────────────────────────────────

  function ingest(raw) {
    const r = o.store.ingest(raw);
    if (r.status === 'queued') schedule();
    return r;
  }

  /**
   * What brain.setLearner() calls: a finished exchange (Craft or a Crew bot)
   * goes in the queue instead of an immediate call to the chat model.
   */
  function learnHook({ userText, replyText, project, src } = {}) {
    let product = src && src.product;
    if (!product) { try { product = require('./telemetry.js').currentProduct(); } catch {} }
    const raw = exchangeEvent({ userText, replyText, project, product, botId: src && src.botId, botName: src && src.botName, at: now() });
    if (!raw) return [];
    const r = ingest(raw);
    return [{ action: r.status, id: r.id }];
  }

  // ─── Batching ─────────────────────────────────────────────────────────────

  const groupKey = (e) => [e.trust, e.sensitive ? 's' : 'n', e.project || '', (e.actor && e.actor.botId) || '', e.product || ''].join('|');

  function nextBatch(events, s) {
    if (!events.length) return [];
    const key = groupKey(events[0]);
    const batch = []; let tokens = 0;
    for (const e of events) {
      if (groupKey(e) !== key) continue;
      const t = estimateTokens(e.text);
      if (batch.length && (tokens + t > s.tokenBudget || batch.length >= s.maxBatchEvents)) break;
      batch.push(e); tokens += t;
    }
    return batch;
  }

  /**
   * Memories the model should see, so it reuses their slots (that is how the brain dedupes).
   * Iris also gets their ids (it updates, confirms or retracts a memory by id), who each is
   * about and when a temporary one ends: up to 40 for Iris, 30 for the other backends.
   */
  function knownFor(batch, { iris = false } = {}) {
    try {
      const B = o.brain;
      const project = (batch.find((e) => e.project) || {}).project || '';
      const pk = project ? B.knownKey(project) : '';
      const scopes = ['me', ...(pk ? [`project:${pk}`] : [])];
      const want = B.terms(batch.map((e) => e.text).join(' '));
      return B.list({ scopes, limit: 300 })
        .filter((m) => m.kind !== 'lesson')
        .map((m) => ({ m, s: want.reduce((n, w) => n + (`${m.slot} ${m.value} ${m.text} ${m.ent || ''}`.toLowerCase().includes(w) ? 1 : 0), 0) + (m.status === 'confirmed' ? 0.2 : 0) }))
        .sort((a, b) => b.s - a.s).slice(0, iris ? 40 : 30)
        .map(({ m }) => (iris ? irisRow(m) : { kind: m.kind, slot: m.slot, value: m.value, text: m.text, project: m.project }));
    } catch { return []; }
  }

  /** A Brain memory as Iris reads it: { id, entity, attr, value, until }. */
  function irisRow(m) {
    const ent = m.ent || (m.project ? m.project : 'user');
    let attr = (m.slot || '').replace(/^now /, '');
    // Person facts are stored under "<name> <attr>": Iris reads the name and the attribute apart.
    if (ent !== 'user' && attr.toLowerCase().startsWith(`${ent.toLowerCase()} `)) attr = attr.slice(ent.length + 1);
    const until = m.expiresAt ? new Date(m.expiresAt).toISOString().slice(0, 10) : '';
    return { id: m.id, entity: ent, attr: attr || m.kind, value: m.value || m.text, ...(until ? { until } : {}) };
  }

  /**
   * The trust rules, for Iris's operations (context-schema.js applies the same ones to observations):
   *   external (someone else's words, an email): never the user's own preference or routine, never
   *            stated, and never a forget (a retraction becomes a challenge the user reviews)
   *   mixed    (heard around the user, a call): stated becomes implied
   */
  function clampIris(ops, trust) {
    const kept = []; const refused = [];
    for (const op0 of ops) {
      const op = { ...op0, ...(op0.observation ? { observation: { ...op0.observation } } : {}) };
      if (trust === 'external' && ['insert', 'replace', 'challenge'].includes(op.action) && op.ent === 'user' && ['preference', 'routine'].includes(op.kind)) {
        refused.push({ op: op0, reason: 'external_user_preference' }); continue;
      }
      if (trust === 'external' && op.action === 'forget') op.action = 'challenge';
      if ((trust === 'external' || trust === 'mixed') && op.observation && op.observation.certainty === 'stated') op.observation.certainty = 'implied';
      kept.push(op);
    }
    return { kept, refused };
  }

  /** Write Iris's guarded operations into the brain (brain.applyOps) and its dated items into life. */
  function applyIris(batch, r) {
    const first = batch[0];
    const src = { product: first.product || 'craft', botId: first.actor ? first.actor.botId : '', botName: first.actor ? first.actor.botName : '' };
    const trust = batch.some((e) => e.trust === 'external') ? 'external' : batch.some((e) => e.trust === 'mixed') ? 'mixed' : 'user';
    const { kept, refused } = clampIris(r.iris.ops, trust);
    // A dated event is a plan only (Life): nothing for the brain to write.
    const writes = kept.filter((op) => !(op.plan && !op.observation && op.action === 'insert'));
    const items = writes.map((op) => ({
      action: op.action, target: op.target || '', observation: op.observation || null, ent: op.ent || '', sens: op.sens || 'none',
      why: op.why || '', evid: op.evid || '', conf: op.conf || '',
    }));
    const results = o.brain.applyOps(items, src);
    const actions = results.map((res, i) => ({
      op: writes[i].op, text: items[i].observation ? items[i].observation.text : items[i].evid,
      action: res.action, id: res.memory ? res.memory.id : (items[i].target || ''), why: res.why || items[i].why || '',
      sens: items[i].sens, ...(res.before ? { before: res.before } : {}),
    }));
    let plans = 0;
    const planOps = kept.filter((op) => op.plan);
    if (planOps.length && r.plans.length && o.life && o.life.available && o.life.available()) {
      try { plans = o.life.notePlans(r.plans, { source: first.source === 'chat' ? 'chat' : first.source, botId: src.botId || null, tz: o.tz ? o.tz() : undefined }).length; } catch {}
    }
    const rejected = [...(r.iris.rejected || []), ...refused].map((x) => x.reason);
    return { actions, plans, rejected, valid: r.iris.valid !== false };
  }

  /** Write a guarded extraction into the brain (and plans into life). */
  function apply(batch, r) {
    const first = batch[0];
    const src = { product: first.product || 'craft', botId: first.actor ? first.actor.botId : '', botName: first.actor ? first.actor.botName : '' };
    const actions = r.observations.map((obs) => {
      const res = o.brain.observe(obs, src);
      return { text: obs.text, kind: obs.kind, slot: obs.slot, certainty: obs.certainty, importance: obs.importance, action: res.action, id: res.memory ? res.memory.id : '', why: res.why || '' };
    });
    let plans = 0;
    if (r.plans.length && o.life && o.life.available && o.life.available()) {
      try { plans = o.life.notePlans(r.plans, { source: first.source === 'chat' ? 'chat' : first.source, botId: src.botId || null, tz: o.tz ? o.tz() : undefined }).length; } catch {}
    }
    return { actions, plans };
  }

  /**
   * Process what is queued. Returns a summary per batch.
   * @param {{ maxBatches?: number }} [p]
   */
  async function process(p = {}) {
    if (status.running) return { busy: true, batches: [] };
    status.running = true;
    const out = [];
    try {
      const s = settings();
      for (let i = 0; i < (p.maxBatches || 50); i++) {
        const batch = nextBatch(o.store.pending(60), s);
        if (!batch.length) break;
        for (const e of batch) o.store.mark(e.id, 'processing');
        const redactions = [];
        const events = batch.map((e) => { const r = redact(e.text); if (r.found.length) redactions.push(...r.found); return { ...e, text: r.text }; });
        const sensitive = batch.some((e) => e.sensitive);
        const route = await routeFor({ mode: s.mode, sensitive, providers: o.providers });
        if (!route.provider) {
          for (const e of batch) o.store.mark(e.id, 'skipped', { error: route.why });
          out.push({ events: batch.length, skipped: route.why });
          continue;
        }
        const isIris = route.provider.info().style === 'iris';
        const r = await runExtraction(route.provider, { events, known: knownFor(batch, { iris: isIris }), now: now(), tz: o.tz ? o.tz() : undefined, projects: safeProjects() }, { minImportance: s.minImportance });
        const meta = { provider: r.provider, model: r.model, local: r.local };
        if (!r.ok) {
          for (const e of batch) o.store.mark(e.id, 'failed', { ...meta, error: `${route.why}: ${r.error}` });
          status.lastError = r.error;
          out.push({ events: batch.length, error: r.error, ...meta });
          continue;
        }
        const applied = r.iris ? applyIris(batch, r) : apply(events, r);
        const outcome = {
          route: route.why, ms: r.ms,
          kept: r.iris ? applied.actions.filter((a) => a.action !== 'ignored').length : r.observations.length,
          dropped: r.iris ? applied.rejected.slice(0, 10) : r.dropped.map((d) => d.why).slice(0, 10),
          actions: applied.actions, plans: applied.plans, redacted: [...new Set(redactions)], batch: batch.map((e) => e.id),
          ...(r.iris ? { contract: r.iris.contract, valid: applied.valid } : {}),
        };
        for (const e of batch) o.store.mark(e.id, 'done', { ...meta, outcome });
        status.batches += 1;
        out.push({ events: batch.length, ...meta, ...outcome });
        if (applied.actions.some((a) => ['added', 'replaced', 'reinforced', 'challenged', 'forgotten'].includes(a.action)) && o.onChange) { try { o.onChange({ type: 'brain', actions: applied.actions }); } catch {} }
        log(`[context] ${batch.length} event(s) via ${r.provider}${r.local ? ' (local)' : ''}: ${applied.actions.map((a) => a.action).join(', ') || 'nothing kept'}`);
      }
    } finally {
      status.running = false;
      status.lastRun = now();
    }
    return { batches: out };
  }

  function safeProjects() { try { return o.brain.projects(12).map((p) => p.name); } catch { return []; } }

  // ─── Scheduling ───────────────────────────────────────────────────────────

  function schedule() {
    if (stopped) return;
    const s = settings();
    const t = now();
    if (!firstQueuedAt) firstQueuedAt = t;
    const due = Math.max(nextEarliest, Math.min(t + s.debounceMs, firstQueuedAt + s.maxWaitMs));
    if (timer) clearTimeout(timer);
    timer = setTimeout(tick, Math.max(0, due - t));
    if (timer.unref) timer.unref();
  }

  async function tick() {
    timer = null;
    if (stopped) return;
    // The host can hold background work back (on battery and in use): try again later, nothing is lost.
    if (o.canRun && !safeCanRun()) {
      timer = setTimeout(tick, o.retryMs || 5 * 60000);
      if (timer.unref) timer.unref();
      return;
    }
    firstQueuedAt = 0;
    const s = settings();
    const started = now();
    // One batch per tick; the duty cycle decides when the next may start.
    const r = await process({ maxBatches: 1 }).catch((e) => { status.lastError = e.message; return { batches: [] }; });
    const took = now() - started;
    nextEarliest = now() + Math.round(took * (1 - s.duty) / Math.max(0.05, s.duty));
    if (r.batches.length && o.store.pending(1).length) schedule();
  }

  function safeCanRun() { try { return !!o.canRun(); } catch { return true; } }

  function start() { stopped = false; if (o.store.pending(1).length) schedule(); }
  function stop() { stopped = true; if (timer) clearTimeout(timer); timer = null; }

  /** Undo what one event taught: memories it added are forgotten; changed ones are listed for review. */
  function undo(eventId) {
    const e = o.store.get(eventId);
    if (!e || !e.outcome) return { forgotten: [], review: [] };
    const forgotten = []; const review = [];
    const restored = [];
    for (const a of e.outcome.actions || []) {
      if (!a.id) continue;
      if (a.action === 'added' && o.brain.forget(a.id)) forgotten.push(a.id);
      // Iris retracted a memory: it comes back as it was.
      else if (a.action === 'forgotten' && a.before && o.brain.restore && o.brain.restore(a.before)) restored.push(a.id);
      else if (['replaced', 'challenged', 'reinforced'].includes(a.action)) review.push(a.id);
    }
    return { forgotten, review, restored };
  }

  return {
    ingest, learnHook, process, start, stop, undo, settings,
    stats: () => ({ ...status, queue: o.store.counts(), mode: settings().mode }),
  };
}

module.exports = { createEngine, DEFAULTS };
