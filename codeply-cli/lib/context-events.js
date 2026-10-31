/**
 * The event processor's store: a durable queue of normalized events
 * (~/.codeply/context/context.db). It is processing state, not memory: what
 * the events taught lives in the brain (brain.js), with its own audit log.
 *
 *   events   one row per event: identity, source, time, trust, sensitivity,
 *            the text a model reads, status (pending, processing, done,
 *            skipped, failed), attempts, and the outcome: which backend ran
 *            it, whether it ran on this PC, and what each observation did to
 *            the brain (memory ids), so it can be traced and undone
 *   meta     small values (collector cursors)
 *
 * Privacy:
 *   - sensitive text is stored only sealed with the host key (AES-256-GCM,
 *     the same sealing as life-store.js); without a key it is kept in memory
 *     until processed and never written
 *   - text is redacted (context-redact.js) before it is stored, so a secret
 *     typed in a chat never reaches this file, sealed or not
 *     (SECURITY-SECRETS.md); identity and dedupe use the words as received
 *   - the text of processed events is cleared after textDays (default 7);
 *     rows go after rowDays (default 90)
 *
 * Same SQLite drivers as session-db.js. With no driver, openEventStore()
 * returns an in-memory store with the same API (nothing survives a restart).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { loadDriver } = require('./session-db.js');
const { normalizeEvent } = require('./context-schema.js');
const { redact } = require('./context-redact.js');

const DAY = 86400000;
const MAX_ATTEMPTS = 3;
const STATUSES = ['pending', 'processing', 'done', 'skipped', 'failed'];

function defaultFile() {
  return process.env.CODEPLY_CONTEXT_DB || path.join(os.homedir(), '.codeply', 'context', 'context.db');
}

function sealer(key) {
  if (!key) return null;
  const k = Buffer.isBuffer(key) ? key : Buffer.from(String(key), 'base64');
  if (k.length !== 32) throw new Error('The context store key must be 32 bytes.');
  return {
    seal(text) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', k, iv);
      const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
      return `v1:${Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64')}`;
    },
    open(blob) {
      const s = String(blob || '');
      if (!s.startsWith('v1:')) return s;
      const b = Buffer.from(s.slice(3), 'base64');
      const d = crypto.createDecipheriv('aes-256-gcm', k, b.subarray(0, 12));
      d.setAuthTag(b.subarray(12, 28));
      return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
    },
  };
}

const json = (v, fallback) => { try { return v == null ? fallback : JSON.parse(v); } catch { return fallback; } };

/**
 * @param {{ file?: string, key?: Buffer|string, modulePaths?: string[], now?: () => number, memory?: boolean, textDays?: number, rowDays?: number }} [opts]
 */
function openEventStore(opts = {}) {
  const now = opts.now || Date.now;
  const box = sealer(opts.key);
  const driver = opts.memory ? null : loadDriver(opts.modulePaths);
  const file = opts.file || defaultFile();
  let db;
  if (driver) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    db = driver.open(file);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
  } else {
    const mem = loadDriver(opts.modulePaths);
    db = mem ? mem.open(':memory:') : null;
  }
  if (!db) return null;
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, product TEXT, at INTEGER NOT NULL, trust TEXT NOT NULL,
      sensitive INTEGER NOT NULL DEFAULT 0, project TEXT, actor TEXT, text TEXT, meta TEXT, content_hash TEXT NOT NULL,
      status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
      provider TEXT, model TEXT, local INTEGER, outcome TEXT, error TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_status ON events (status, next_at, at);
    CREATE INDEX IF NOT EXISTS events_hash ON events (content_hash, created_at);
  `);
  db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run('schema', '1');
  const q = {
    get: db.prepare('SELECT * FROM events WHERE id = ?'),
    byHash: db.prepare('SELECT id FROM events WHERE content_hash = ? AND created_at >= ? LIMIT 1'),
    insert: db.prepare(`INSERT INTO events (id, source, product, at, trust, sensitive, project, actor, text, meta, content_hash, status, attempts, next_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, 0, ?, ?)`),
    pending: db.prepare("SELECT * FROM events WHERE status = 'pending' AND next_at <= ? ORDER BY at ASC LIMIT ?"),
    setStatus: db.prepare('UPDATE events SET status = ?, attempts = ?, next_at = ?, provider = ?, model = ?, local = ?, outcome = ?, error = ?, updated_at = ? WHERE id = ?'),
    counts: db.prepare('SELECT status, COUNT(*) AS n FROM events GROUP BY status'),
    recent: db.prepare('SELECT * FROM events ORDER BY updated_at DESC LIMIT ?'),
    stuck: db.prepare("UPDATE events SET status = 'pending', updated_at = ? WHERE status = 'processing'"),
    clearText: db.prepare("UPDATE events SET text = NULL WHERE status IN ('done', 'skipped', 'failed') AND updated_at < ? AND text IS NOT NULL"),
    dropRows: db.prepare('DELETE FROM events WHERE updated_at < ?'),
    getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
    setMeta: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
  };
  // Sensitive text with no key never touches the disk: it waits here until processed.
  const volatile = new Map();
  // What the redactor removed from each event, kept in memory only (never written) so the guard
  // can refuse a model that writes one back. Gone after a restart; the guard has other checks.
  const removed = new Map();
  // A crash mid-batch leaves rows "processing": they go back in the queue.
  q.stuck.run(now());

  function rowToEvent(r) {
    if (!r) return null;
    let text = r.text;
    if (r.sensitive) {
      if (text && box) { try { text = box.open(text); } catch { text = null; } } else if (!text) text = volatile.get(r.id) || null;
    }
    return {
      id: r.id, source: r.source, product: r.product || '', at: Number(r.at), trust: r.trust, sensitive: !!r.sensitive,
      project: r.project || '', actor: json(r.actor, null), text: text || '', meta: json(r.meta, {}),
      status: r.status, attempts: Number(r.attempts), provider: r.provider || '', model: r.model || '',
      local: r.local == null ? null : !!r.local, outcome: json(r.outcome, null), error: r.error || '',
      createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
    };
  }

  /**
   * Validate and queue one raw event.
   * @returns {{ status: 'queued'|'duplicate'|'rejected', id?: string, errors?: string[] }}
   */
  function ingest(raw, o = {}) {
    const { event, errors } = normalizeEvent(raw, now());
    if (!event) return { status: 'rejected', errors };
    if (q.get.get(event.id)) return { status: 'duplicate', id: event.id };
    // The same words from the same source within a day is one event (a retry, a double hook).
    if (q.byHash.get(event.contentHash, now() - (o.dedupeMs || DAY))) return { status: 'duplicate', id: event.id };
    const red = redact(event.text);
    let text = red.text;
    // The kinds removed (never the values), so the engine's outcome still says what was redacted.
    const meta = red.found.length ? { ...(event.meta || {}), redacted: [...new Set(red.found)] } : (event.meta || {});
    if (red.values.length) removed.set(event.id, red.values);
    if (event.sensitive) {
      if (box) text = box.seal(text); else { volatile.set(event.id, text); text = null; }
    }
    const t = now();
    q.insert.run(event.id, event.source, event.product, event.at, event.trust, event.sensitive ? 1 : 0, event.project || null,
      event.actor ? JSON.stringify(event.actor) : null, text, JSON.stringify(meta), event.contentHash, t, t);
    return { status: 'queued', id: event.id };
  }

  /** Pending events, oldest first; a sensitive one whose text is gone (restart, no key) is skipped. */
  function pending(limit = 50) {
    const out = [];
    for (const r of q.pending.all(now(), limit)) {
      const e = rowToEvent(r);
      if (e.sensitive && !e.text) { mark(e.id, 'skipped', { error: 'sensitive text was not kept (no key) and the app restarted' }); continue; }
      out.push(e);
    }
    return out;
  }

  function mark(id, status, o = {}) {
    if (!STATUSES.includes(status)) throw new Error(`bad status ${status}`);
    const cur = q.get.get(String(id));
    if (!cur) return null;
    let attempts = Number(cur.attempts);
    let next = 0;
    let st = status;
    if (status === 'failed') {
      attempts += 1;
      // Back off and retry; after MAX_ATTEMPTS it stays failed.
      if (attempts < MAX_ATTEMPTS) { st = 'pending'; next = now() + Math.min(60, 2 ** attempts) * 60000; }
    }
    q.setStatus.run(st, attempts, next, o.provider || cur.provider || null, o.model || cur.model || null,
      o.local == null ? cur.local : o.local ? 1 : 0, o.outcome ? JSON.stringify(o.outcome).slice(0, 20000) : cur.outcome,
      o.error ? String(o.error).slice(0, 500) : null, now(), cur.id);
    if (st !== 'pending' && st !== 'processing') { volatile.delete(cur.id); removed.delete(cur.id); }
    return rowToEvent(q.get.get(cur.id));
  }

  function counts() {
    const out = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    for (const r of q.counts.all()) out[r.status] = Number(r.n);
    return out;
  }

  function purge({ textDays = opts.textDays || 7, rowDays = opts.rowDays || 90 } = {}) {
    q.clearText.run(now() - textDays * DAY);
    q.dropRows.run(now() - rowDays * DAY);
  }

  return {
    persistent: !!driver, sealed: !!box,
    ingest, pending, mark, counts, purge,
    get: (id) => rowToEvent(q.get.get(String(id))),
    /** The secrets redacted out of one queued event (in memory only; [] after a restart). Never store or show these. */
    secretsFor: (id) => removed.get(String(id)) || [],
    recent: (n = 30) => q.recent.all(n).map(rowToEvent),
    getMeta: (k, d) => { const r = q.getMeta.get(String(k)); return r ? json(r.value, d) : d; },
    setMeta: (k, v) => q.setMeta.run(String(k), JSON.stringify(v)),
    close: () => { try { db.close(); } catch {} },
  };
}

module.exports = { openEventStore, MAX_ATTEMPTS, STATUSES };
