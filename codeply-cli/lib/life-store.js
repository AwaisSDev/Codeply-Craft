/**
 * The life store: what the user's bots know about their day, in one local
 * SQLite file (~/.codeply/life/life.db). Every bot reads the same store, so
 * they share one picture of the user's life instead of each knowing only its
 * own thread.
 *
 *   items    Things that happened or will happen: calendar events, email in
 *            and out, calls and their summaries, what the user has open on
 *            screen, Orbit questions, plans, bot mail, Slack messages.
 *            id = "<source>:<external id>", so a source can upsert the same
 *            thing again as it changes.
 *   people   Who the user deals with: names, addresses, how important they
 *            are, when each side last wrote.
 *   state    Small named values (a source's cursor, the current activity).
 *   nudges   What the bots reached out about, and the user's feedback on it.
 *   tasks    Work the bots took on by themselves (the autonomy loop).
 *   outbox   Outward actions waiting out their hold time.
 *   audit    Append-only: every action a bot took on its own.
 *
 * Sensitive items (call transcripts, private mail bodies) keep only their
 * title in clear text; body and data are sealed with AES-256-GCM under a key
 * the host keeps (Craft: a random key protected by Windows' own data
 * protection, safeStorage). With no key, sensitive bodies are not stored.
 *
 * Same SQLite drivers as session-db.js (node:sqlite, else better-sqlite3).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { loadDriver } = require('./session-db.js');

const SCHEMA_VERSION = 1;
const DAY = 86400000;
// How long things are kept. Screen activity is the noisiest, sensitive things the most private.
const KEEP_DAYS = { default: 90, activity: 14, sensitive: 30, audit: 365 };

function defaultFile() {
  return process.env.CODEPLY_LIFE_DB || path.join(os.homedir(), '.codeply', 'life', 'life.db');
}

// ─── Sealing ────────────────────────────────────────────────────────────────

function sealer(key) {
  if (!key) return null;
  const k = Buffer.isBuffer(key) ? key : Buffer.from(String(key), 'base64');
  if (k.length !== 32) throw new Error('The life store key must be 32 bytes.');
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

const clip = (s, n) => String(s == null ? '' : s).slice(0, n);
const json = (v, fallback) => { try { return v == null ? fallback : JSON.parse(v); } catch { return fallback; } };
const lower = (s) => String(s || '').trim().toLowerCase();

/**
 * @param {{ file?: string, key?: Buffer|string, modulePaths?: string[], now?: () => number }} [opts]
 * @returns the store, or null when no SQLite driver loads on this machine.
 */
function openLifeStore(opts = {}) {
  const driver = loadDriver(opts.modulePaths);
  if (!driver) return null;
  const file = opts.file || defaultFile();
  const now = opts.now || Date.now;
  const box = sealer(opts.key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = driver.open(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, kind TEXT NOT NULL,
      at INTEGER NOT NULL, end_at INTEGER, title TEXT NOT NULL DEFAULT '', body TEXT,
      people TEXT NOT NULL DEFAULT '[]', place TEXT, url TEXT, data TEXT,
      sensitive INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS items_at ON items (at);
    CREATE INDEX IF NOT EXISTS items_source ON items (source, at);
    CREATE TABLE IF NOT EXISTS people (
      id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', emails TEXT NOT NULL DEFAULT '[]',
      importance REAL NOT NULL DEFAULT 0, last_from INTEGER, last_to INTEGER, note TEXT, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS nudges (
      id TEXT PRIMARY KEY, trigger TEXT NOT NULL, key TEXT NOT NULL, bot_id TEXT, how TEXT, text TEXT,
      at INTEGER NOT NULL, feedback TEXT, feedback_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS nudges_key ON nudges (key, at);
    CREATE INDEX IF NOT EXISTS nudges_at ON nudges (at);
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, bot_id TEXT, source TEXT NOT NULL, requester TEXT NOT NULL, text TEXT NOT NULL,
      status TEXT NOT NULL, data TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tasks_status ON tasks (status, created_at);
    CREATE TABLE IF NOT EXISTS outbox (
      id TEXT PRIMARY KEY, task_id TEXT, bot_id TEXT, tool TEXT NOT NULL, title TEXT NOT NULL, detail TEXT,
      due_at INTEGER NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, bot_id TEXT, task_id TEXT, kind TEXT NOT NULL,
      tool TEXT, title TEXT, detail TEXT, verdict TEXT, ok INTEGER, result TEXT
    );
    CREATE INDEX IF NOT EXISTS audit_at ON audit (at);
  `);
  db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run('schema', String(SCHEMA_VERSION));

  const q = {
    upsertItem: db.prepare(`INSERT INTO items (id, source, kind, at, end_at, title, body, people, place, url, data, sensitive, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET source=excluded.source, kind=excluded.kind, at=excluded.at, end_at=excluded.end_at,
        title=excluded.title, body=excluded.body, people=excluded.people, place=excluded.place, url=excluded.url,
        data=excluded.data, sensitive=excluded.sensitive, updated_at=excluded.updated_at`),
    getItem: db.prepare('SELECT * FROM items WHERE id = ?'),
    deleteItem: db.prepare('DELETE FROM items WHERE id = ?'),
    deleteSource: db.prepare('DELETE FROM items WHERE source = ?'),
    countSource: db.prepare('SELECT source, COUNT(*) AS n, MAX(updated_at) AS last FROM items GROUP BY source'),
    upsertPerson: db.prepare(`INSERT INTO people (id, name, emails, importance, last_from, last_to, note, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, emails=excluded.emails, importance=excluded.importance,
        last_from=excluded.last_from, last_to=excluded.last_to, note=excluded.note, updated_at=excluded.updated_at`),
    getPerson: db.prepare('SELECT * FROM people WHERE id = ?'),
    findPeople: db.prepare("SELECT * FROM people WHERE name LIKE ? ESCAPE '\\' OR emails LIKE ? ESCAPE '\\' ORDER BY importance DESC LIMIT ?"),
    topPeople: db.prepare('SELECT * FROM people ORDER BY importance DESC, updated_at DESC LIMIT ?'),
    getState: db.prepare('SELECT value FROM state WHERE key = ?'),
    setState: db.prepare('INSERT INTO state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at'),
    deleteState: db.prepare('DELETE FROM state WHERE key = ?'),
    addNudge: db.prepare('INSERT OR REPLACE INTO nudges (id, trigger, key, bot_id, how, text, at, feedback, feedback_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    nudgeFeedback: db.prepare('UPDATE nudges SET feedback = ?, feedback_at = ? WHERE id = ?'),
    getNudge: db.prepare('SELECT * FROM nudges WHERE id = ?'),
    lastNudgeFor: db.prepare('SELECT * FROM nudges WHERE key = ? ORDER BY at DESC LIMIT 1'),
    nudgesSince: db.prepare('SELECT * FROM nudges WHERE at >= ? ORDER BY at DESC LIMIT ?'),
    upsertTask: db.prepare(`INSERT INTO tasks (id, bot_id, source, requester, text, status, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET bot_id=excluded.bot_id, status=excluded.status, data=excluded.data, updated_at=excluded.updated_at`),
    getTask: db.prepare('SELECT * FROM tasks WHERE id = ?'),
    tasksByStatus: db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY created_at ASC LIMIT ?'),
    recentTasks: db.prepare('SELECT * FROM tasks ORDER BY updated_at DESC LIMIT ?'),
    upsertOutbox: db.prepare(`INSERT INTO outbox (id, task_id, bot_id, tool, title, detail, due_at, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, due_at=excluded.due_at, updated_at=excluded.updated_at`),
    getOutbox: db.prepare('SELECT * FROM outbox WHERE id = ?'),
    outboxByStatus: db.prepare('SELECT * FROM outbox WHERE status = ? ORDER BY due_at ASC LIMIT ?'),
    addAudit: db.prepare('INSERT INTO audit (at, bot_id, task_id, kind, tool, title, detail, verdict, ok, result) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    auditSince: db.prepare('SELECT * FROM audit WHERE at >= ? ORDER BY seq DESC LIMIT ?'),
    auditCount: db.prepare('SELECT COUNT(*) AS n FROM audit WHERE at >= ? AND kind = ? AND (bot_id = ? OR ? IS NULL)'),
  };

  // ─── Items ────────────────────────────────────────────────────────────────

  function rowToItem(r) {
    if (!r) return null;
    const sensitive = !!r.sensitive;
    const open = (v) => {
      if (v == null) return null;
      if (!sensitive) return v;
      if (!box) return null;
      try { return box.open(v); } catch { return null; }
    };
    return {
      id: r.id, source: r.source, kind: r.kind, at: Number(r.at), end: r.end_at == null ? null : Number(r.end_at),
      title: r.title, body: open(r.body) || '', people: json(r.people, []), place: r.place || '', url: r.url || '',
      data: json(open(r.data), {}) || {}, sensitive, updatedAt: Number(r.updated_at),
    };
  }

  /**
   * item: { id, source, kind, at, end?, title, body?, people?, place?, url?, data?, sensitive? }
   * A sensitive item without a key keeps its title only.
   */
  function upsertItem(item) {
    if (!item || !item.id || !item.source || !item.kind) throw new Error('A life item needs id, source and kind.');
    const sensitive = !!item.sensitive;
    const seal = (v) => (v == null || v === '' ? null : sensitive ? (box ? box.seal(v) : null) : v);
    const data = item.data && Object.keys(item.data).length ? JSON.stringify(item.data) : null;
    q.upsertItem.run(
      clip(item.id, 300), clip(item.source, 40), clip(item.kind, 40), Math.round(Number(item.at) || now()),
      item.end == null ? null : Math.round(Number(item.end)), clip(item.title, 500), seal(item.body ? clip(item.body, 40000) : null),
      JSON.stringify((Array.isArray(item.people) ? item.people : []).map((p) => clip(p, 200)).slice(0, 40)),
      item.place ? clip(item.place, 300) : null, item.url ? clip(item.url, 1000) : null, seal(data), sensitive ? 1 : 0, now(),
    );
    return getItem(item.id);
  }
  const getItem = (id) => rowToItem(q.getItem.get(String(id)));

  /** Items by time window, source, kind; newest first unless order: 'asc'. */
  function items({ from, to, sources, kinds, limit = 50, order = 'desc', text } = {}) {
    const where = []; const args = [];
    if (from != null) { where.push('(at >= ? OR (end_at IS NOT NULL AND end_at >= ?))'); args.push(Math.round(from), Math.round(from)); }
    if (to != null) { where.push('at <= ?'); args.push(Math.round(to)); }
    if (sources && sources.length) { where.push(`source IN (${sources.map(() => '?').join(',')})`); args.push(...sources); }
    if (kinds && kinds.length) { where.push(`kind IN (${kinds.map(() => '?').join(',')})`); args.push(...kinds); }
    if (text) {
      const like = `%${String(text).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push("(title LIKE ? ESCAPE '\\' OR (sensitive = 0 AND body LIKE ? ESCAPE '\\') OR people LIKE ? ESCAPE '\\' OR place LIKE ? ESCAPE '\\')");
      args.push(like, like, like, like);
    }
    const sql = `SELECT * FROM items${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY at ${order === 'asc' ? 'ASC' : 'DESC'} LIMIT ?`;
    args.push(Math.max(1, Math.min(500, Number(limit) || 50)));
    return db.prepare(sql).all(...args).map(rowToItem);
  }

  /** Words anywhere (titles, bodies, people, places), newest first. Sensitive bodies are opened in memory. */
  function search(text, { limit = 20, sources } = {}) {
    const t = String(text || '').trim();
    if (!t) return [];
    const words = t.toLowerCase().split(/\s+/).filter((w) => w.length > 1).slice(0, 6);
    const pool = new Map();
    for (const w of words.length ? words : [t.toLowerCase()]) {
      for (const it of items({ text: w, limit: 200, sources })) pool.set(it.id, it);
    }
    // Sensitive bodies are not searchable in SQL: open the recent ones and look.
    if (box) {
      for (const r of db.prepare('SELECT * FROM items WHERE sensitive = 1 ORDER BY at DESC LIMIT 300').all()) {
        const it = rowToItem(r);
        if (sources && sources.length && !sources.includes(it.source)) continue;
        if (words.some((w) => it.body.toLowerCase().includes(w))) pool.set(it.id, it);
      }
    }
    const score = (it) => {
      const hay = `${it.title} ${it.body} ${it.people.join(' ')} ${it.place}`.toLowerCase();
      return words.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0);
    };
    return [...pool.values()].map((it) => ({ it, s: score(it) }))
      .sort((a, b) => b.s - a.s || b.it.at - a.it.at).slice(0, limit).map((x) => x.it);
  }

  // ─── People ───────────────────────────────────────────────────────────────

  const personId = (p) => (p.email ? lower(p.email) : `name:${lower(p.name)}`);
  function rowToPerson(r) {
    return r && { id: r.id, name: r.name, emails: json(r.emails, []), importance: Number(r.importance) || 0, lastFrom: r.last_from == null ? null : Number(r.last_from), lastTo: r.last_to == null ? null : Number(r.last_to), note: r.note || '' };
  }
  /** Merge what a source learned about someone: { email?, name?, importance?, lastFrom?, lastTo?, note? }. */
  function notePerson(p) {
    if (!p || (!p.email && !p.name)) return null;
    const id = personId(p);
    const cur = rowToPerson(q.getPerson.get(id)) || { name: '', emails: [], importance: 0, lastFrom: null, lastTo: null, note: '' };
    const emails = [...new Set([...cur.emails, ...(p.email ? [lower(p.email)] : [])])].slice(0, 10);
    const max = (a, b) => (a == null ? b : b == null ? a : Math.max(a, b));
    const next = {
      name: clip(p.name || cur.name, 120), emails,
      importance: p.importance == null ? cur.importance : Math.max(0, Math.min(10, Number(p.importance))),
      lastFrom: max(cur.lastFrom, p.lastFrom == null ? null : Number(p.lastFrom)),
      lastTo: max(cur.lastTo, p.lastTo == null ? null : Number(p.lastTo)),
      note: clip(p.note || cur.note, 400),
    };
    q.upsertPerson.run(id, next.name, JSON.stringify(next.emails), next.importance, next.lastFrom, next.lastTo, next.note || null, now());
    return { id, ...next };
  }
  const person = (emailOrName) => rowToPerson(q.getPerson.get(String(emailOrName).includes('@') ? lower(emailOrName) : `name:${lower(emailOrName)}`));
  function findPeople(text, limit = 5) {
    const like = `%${String(text || '').replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    return q.findPeople.all(like, like, limit).map(rowToPerson);
  }
  const topPeople = (limit = 10) => q.topPeople.all(limit).map(rowToPerson);

  // ─── State ────────────────────────────────────────────────────────────────

  const getState = (key, fallback = null) => { const r = q.getState.get(String(key)); return r ? json(r.value, fallback) : fallback; };
  const setState = (key, value) => { q.setState.run(String(key), JSON.stringify(value), now()); return value; };
  const deleteState = (key) => { q.deleteState.run(String(key)); };

  // ─── Nudges ───────────────────────────────────────────────────────────────

  const rowToNudge = (r) => r && { id: r.id, trigger: r.trigger, key: r.key, botId: r.bot_id, how: r.how, text: r.text, at: Number(r.at), feedback: r.feedback || null, feedbackAt: r.feedback_at == null ? null : Number(r.feedback_at) };
  function addNudge(n) {
    const id = n.id || `n${now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
    q.addNudge.run(id, clip(n.trigger, 40), clip(n.key, 300), n.botId || null, n.how || null, clip(n.text, 600), Math.round(n.at || now()), null, null);
    return rowToNudge(q.getNudge.get(id));
  }
  const nudgeFeedback = (id, feedback) => { q.nudgeFeedback.run(String(feedback), now(), String(id)); return rowToNudge(q.getNudge.get(String(id))); };
  const getNudge = (id) => rowToNudge(q.getNudge.get(String(id)));
  const lastNudgeFor = (key) => rowToNudge(q.lastNudgeFor.get(String(key)));
  const nudgesSince = (since, limit = 100) => q.nudgesSince.all(Math.round(since), limit).map(rowToNudge);

  // ─── Tasks, outbox, audit (the autonomy loop) ─────────────────────────────

  const rowToTask = (r) => r && { id: r.id, botId: r.bot_id, source: r.source, requester: r.requester, text: r.text, status: r.status, data: json(r.data, {}) || {}, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at) };
  function saveTask(t) {
    const id = t.id || `t${now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
    const cur = rowToTask(q.getTask.get(id));
    q.upsertTask.run(id, t.botId || (cur && cur.botId) || null, clip(t.source || (cur && cur.source) || 'crew', 30), clip(t.requester || (cur && cur.requester) || 'user', 30),
      clip(t.text || (cur && cur.text) || '', 4000), clip(t.status || (cur && cur.status) || 'queued', 20),
      JSON.stringify({ ...((cur && cur.data) || {}), ...(t.data || {}) }).slice(0, 60000), cur ? cur.createdAt : now(), now());
    return rowToTask(q.getTask.get(id));
  }
  const getTask = (id) => rowToTask(q.getTask.get(String(id)));
  const tasksByStatus = (status, limit = 50) => q.tasksByStatus.all(String(status), limit).map(rowToTask);
  const recentTasks = (limit = 30) => q.recentTasks.all(limit).map(rowToTask);

  const rowToOut = (r) => r && { id: r.id, taskId: r.task_id, botId: r.bot_id, tool: r.tool, title: r.title, detail: r.detail || '', dueAt: Number(r.due_at), status: r.status, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at) };
  function saveOutbox(o) {
    const id = o.id || `o${now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
    const cur = rowToOut(q.getOutbox.get(id));
    q.upsertOutbox.run(id, o.taskId || (cur && cur.taskId) || null, o.botId || (cur && cur.botId) || null, clip(o.tool || (cur && cur.tool), 60), clip(o.title || (cur && cur.title) || '', 300),
      clip(o.detail || (cur && cur.detail) || '', 4000), Math.round(o.dueAt || (cur && cur.dueAt) || now()), clip(o.status || (cur && cur.status) || 'waiting', 20), cur ? cur.createdAt : now(), now());
    return rowToOut(q.getOutbox.get(id));
  }
  const getOutbox = (id) => rowToOut(q.getOutbox.get(String(id)));
  const outboxByStatus = (status, limit = 50) => q.outboxByStatus.all(String(status), limit).map(rowToOut);

  const rowToAudit = (r) => r && { seq: Number(r.seq), at: Number(r.at), botId: r.bot_id, taskId: r.task_id, kind: r.kind, tool: r.tool, title: r.title, detail: r.detail || '', verdict: r.verdict, ok: r.ok == null ? null : !!r.ok, result: r.result || '' };
  function audit(e) {
    q.addAudit.run(Math.round(e.at || now()), e.botId || null, e.taskId || null, clip(e.kind || 'action', 30), e.tool ? clip(e.tool, 60) : null,
      clip(e.title, 300), clip(e.detail, 2000), e.verdict ? clip(e.verdict, 20) : null, e.ok == null ? null : (e.ok ? 1 : 0), clip(e.result, 2000));
  }
  const auditSince = (since, limit = 200) => q.auditSince.all(Math.round(since), limit).map(rowToAudit);
  const auditCount = (since, kind, botId = null) => Number(q.auditCount.get(Math.round(since), String(kind), botId, botId).n) || 0;

  // ─── Housekeeping ─────────────────────────────────────────────────────────

  function prune(t = now()) {
    db.prepare('DELETE FROM items WHERE source = ? AND at < ?').run('activity', t - KEEP_DAYS.activity * DAY);
    db.prepare('DELETE FROM items WHERE sensitive = 1 AND at < ?').run(t - KEEP_DAYS.sensitive * DAY);
    db.prepare('DELETE FROM items WHERE at < ? AND (end_at IS NULL OR end_at < ?)').run(t - KEEP_DAYS.default * DAY, t - KEEP_DAYS.default * DAY);
    db.prepare('DELETE FROM nudges WHERE at < ?').run(t - KEEP_DAYS.default * DAY);
    db.prepare('DELETE FROM audit WHERE at < ?').run(t - KEEP_DAYS.audit * DAY);
    db.prepare("DELETE FROM outbox WHERE status != 'waiting' AND updated_at < ?").run(t - KEEP_DAYS.default * DAY);
  }
  function sources() {
    return Object.fromEntries(q.countSource.all().map((r) => [r.source, { count: Number(r.n), last: Number(r.last) || 0 }]));
  }
  const removeSource = (source) => q.deleteSource.run(String(source)).changes;
  const deleteItem = (id) => q.deleteItem.run(String(id)).changes;
  function clearAll() {
    db.exec('DELETE FROM items; DELETE FROM people; DELETE FROM state; DELETE FROM nudges;');
  }
  const close = () => { try { db.close(); } catch {} };

  return {
    kind: driver.kind, file, canSeal: !!box,
    upsertItem, getItem, items, search, deleteItem, removeSource, sources,
    notePerson, person, findPeople, topPeople,
    getState, setState, deleteState,
    addNudge, nudgeFeedback, getNudge, lastNudgeFor, nudgesSince,
    saveTask, getTask, tasksByStatus, recentTasks,
    saveOutbox, getOutbox, outboxByStatus,
    audit, auditSince, auditCount,
    prune, clearAll, close,
  };
}

module.exports = { openLifeStore, sealer, defaultFile, KEEP_DAYS };
