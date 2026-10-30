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

  /** Memories the model should see, so it reuses their slots (that is how the brain dedupes). */
  function knownFor(batch) {
    try {
      const B = o.brain;
      const project = (batch.find((e) => e.project) || {}).project || '';
      const pk = project ? B.knownKey(project) : '';
      const scopes = ['me', ...(pk ? [`project:${pk}`] : [])];
      const want = B.terms(batch.map((e) => e.text).join(' '));
      return B.list({ scopes, limit: 300 })
        .filter((m) => m.kind !== 'lesson')
        .map((m) => ({ m, s: want.reduce((n, w) => n + (`${m.slot} ${m.value} ${m.text}`.toLowerCase().includes(w) ? 1 : 0), 0) + (m.status === 'confirmed' ? 0.2 : 0) }))
        .sort((a, b) => b.s - a.s).slice(0, 30)
        .map(({ m }) => ({ kind: m.kind, slot: m.slot, value: m.value, text: m.text, project: m.project }));
    } catch { return []; }
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
        const r = await runExtraction(route.provider, { events, known: knownFor(batch), now: now(), tz: o.tz ? o.tz() : undefined, projects: safeProjects() }, { minImportance: s.minImportance });
        const meta = { provider: r.provider, model: r.model, local: r.local };
        if (!r.ok) {
          for (const e of batch) o.store.mark(e.id, 'failed', { ...meta, error: `${route.why}: ${r.error}` });
          status.lastError = r.error;
          out.push({ events: batch.length, error: r.error, ...meta });
          continue;
        }
        const applied = apply(events, r);
        const outcome = {
          route: route.why, ms: r.ms, kept: r.observations.length, dropped: r.dropped.map((d) => d.why).slice(0, 10),
          actions: applied.actions, plans: applied.plans, redacted: [...new Set(redactions)], batch: batch.map((e) => e.id),
        };
        for (const e of batch) o.store.mark(e.id, 'done', { ...meta, outcome });
        status.batches += 1;
        out.push({ events: batch.length, ...meta, ...outcome });
        if (applied.actions.some((a) => ['added', 'replaced', 'reinforced', 'challenged'].includes(a.action)) && o.onChange) { try { o.onChange({ type: 'brain', actions: applied.actions }); } catch {} }
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
    firstQueuedAt = 0;
    const s = settings();
    const started = now();
    // One batch per tick; the duty cycle decides when the next may start.
    const r = await process({ maxBatches: 1 }).catch((e) => { status.lastError = e.message; return { batches: [] }; });
    const took = now() - started;
    nextEarliest = now() + Math.round(took * (1 - s.duty) / Math.max(0.05, s.duty));
    if (r.batches.length && o.store.pending(1).length) schedule();
  }

  function start() { stopped = false; if (o.store.pending(1).length) schedule(); }
  function stop() { stopped = true; if (timer) clearTimeout(timer); timer = null; }

  /** Undo what one event taught: memories it added are forgotten; changed ones are listed for review. */
  function undo(eventId) {
    const e = o.store.get(eventId);
    if (!e || !e.outcome) return { forgotten: [], review: [] };
    const forgotten = []; const review = [];
    for (const a of e.outcome.actions || []) {
      if (!a.id) continue;
      if (a.action === 'added' && o.brain.forget(a.id)) forgotten.push(a.id);
      else if (['replaced', 'challenged', 'reinforced'].includes(a.action)) review.push(a.id);
    }
    return { forgotten, review };
  }

  return {
    ingest, learnHook, process, start, stop, undo, settings,
    stats: () => ({ ...status, queue: o.store.counts(), mode: settings().mode }),
  };
}

module.exports = { createEngine, DEFAULTS };
