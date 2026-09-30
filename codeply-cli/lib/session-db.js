/**
 * SQLite-backed session store. Replaces rewriting one big JSON file on every
 * save: each session and each message is a row, and a save only writes the rows
 * whose content changed. Messages are searchable across every session.
 *
 * Driver order (first that loads wins), all with the same sync API:
 *   1. node:sqlite        (Node 22.5+, built in, nothing to install)
 *   2. better-sqlite3     (optional dependency; Electron 29 needs this one)
 * When neither loads, openSessionDb() returns null and the caller keeps its
 * JSON file, so a machine without SQLite never loses anything.
 *
 * Shape it stores (same as the old JSON store):
 *   { sessions: [{ id, title, cwd, messages: [...], alwaysAllowed, createdAt, updatedAt, ...extra }],
 *     <any other top-level key>: value }
 */
const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 1;

function loadDriver(modulePaths) {
  try {
    const { DatabaseSync } = require('node:sqlite');
    if (DatabaseSync) return { kind: 'node:sqlite', open: (f) => new DatabaseSync(f) };
  } catch {}
  try {
    let mod;
    try { mod = require('better-sqlite3'); }
    catch (e) {
      if (!modulePaths || !modulePaths.length) throw e;
      mod = require(require.resolve('better-sqlite3', { paths: modulePaths }));
    }
    return { kind: 'better-sqlite3', open: (f) => new mod(f) };
  } catch {}
  return null;
}

const CORE_SESSION_KEYS = new Set(['id', 'title', 'cwd', 'messages', 'alwaysAllowed', 'createdAt', 'updatedAt']);

/**
 * @param {string} file  database path (created if missing)
 * @param {{ modulePaths?: string[], driver?: 'node:sqlite'|'better-sqlite3' }} [opts]
 * @returns {null | { kind:string, file:string, isEmpty():boolean, load():object, save(store:object):void, search(q:string, limit?:number):object[], close():void }}
 */
function openSessionDb(file, opts = {}) {
  const driver = loadDriver(opts.modulePaths);
  if (!driver || (opts.driver && driver.kind !== opts.driver)) return null;
  let db;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    db = driver.open(file);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT,
        cwd TEXT,
        always_allowed TEXT,
        extra TEXT,
        created_at INTEGER,
        updated_at INTEGER,
        position INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS messages (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        idx INTEGER NOT NULL,
        kind TEXT,
        body TEXT,
        data TEXT NOT NULL,
        PRIMARY KEY (session_id, idx)
      );
      CREATE INDEX IF NOT EXISTS sessions_updated ON sessions(updated_at DESC);
    `);
    db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run('schema', String(SCHEMA_VERSION));
  } catch {
    try { db && db.close(); } catch {}
    return null;
  }

  const q = {
    countSessions: db.prepare('SELECT COUNT(*) AS n FROM sessions'),
    countKv: db.prepare('SELECT COUNT(*) AS n FROM kv'),
    allSessions: db.prepare('SELECT * FROM sessions ORDER BY position ASC'),
    sessionMessages: db.prepare('SELECT data FROM messages WHERE session_id = ? ORDER BY idx ASC'),
    allKv: db.prepare('SELECT key, value FROM kv'),
    upsertSession: db.prepare(`INSERT INTO sessions (id, title, cwd, always_allowed, extra, created_at, updated_at, position)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title, cwd=excluded.cwd, always_allowed=excluded.always_allowed,
        extra=excluded.extra, created_at=excluded.created_at, updated_at=excluded.updated_at, position=excluded.position`),
    deleteSession: db.prepare('DELETE FROM sessions WHERE id = ?'),
    listSessionIds: db.prepare('SELECT id FROM sessions'),
    upsertMessage: db.prepare(`INSERT INTO messages (session_id, idx, kind, body, data) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id, idx) DO UPDATE SET kind=excluded.kind, body=excluded.body, data=excluded.data`),
    trimMessages: db.prepare('DELETE FROM messages WHERE session_id = ? AND idx >= ?'),
    upsertKv: db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'),
    deleteKv: db.prepare('DELETE FROM kv WHERE key = ?'),
    search: db.prepare(`SELECT m.session_id AS sessionId, m.idx AS idx, m.kind AS kind, m.body AS body, s.title AS title, s.cwd AS cwd, s.updated_at AS updatedAt
      FROM messages m JOIN sessions s ON s.id = m.session_id
      WHERE m.body LIKE ? ESCAPE '\\' ORDER BY s.updated_at DESC, m.idx ASC LIMIT ?`),
  };

  // What the database already holds, so a save only writes what changed.
  const seenSession = new Map(); // id -> serialized session header
  const seenMessages = new Map(); // id -> string[] (serialized messages)
  const seenKv = new Map(); // key -> serialized value

  const tx = (fn) => {
    db.exec('BEGIN');
    try { fn(); db.exec('COMMIT'); } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
  };

  const bodyOf = (m) => {
    if (!m || typeof m !== 'object') return '';
    const t = m.text != null ? m.text : (m.label != null ? m.label : '');
    return typeof t === 'string' ? t.slice(0, 20000) : '';
  };

  return {
    kind: driver.kind,
    file,

    isEmpty() {
      return q.countSessions.get().n === 0 && q.countKv.get().n === 0;
    },

    load() {
      const store = {};
      for (const row of q.allKv.all()) {
        try { store[row.key] = JSON.parse(row.value); seenKv.set(row.key, row.value); } catch {}
      }
      store.sessions = q.allSessions.all().map((r, position) => {
        const messages = q.sessionMessages.all(r.id).map((m) => { try { return JSON.parse(m.data); } catch { return null; } }).filter(Boolean);
        let extra = {};
        try { extra = r.extra ? JSON.parse(r.extra) : {}; } catch {}
        let alwaysAllowed = [];
        try { alwaysAllowed = r.always_allowed ? JSON.parse(r.always_allowed) : []; } catch {}
        const s = { ...extra, id: r.id, title: r.title, cwd: r.cwd, messages, alwaysAllowed, createdAt: r.created_at, updatedAt: r.updated_at };
        seenSession.set(r.id, headerOf(s, position));
        seenMessages.set(r.id, messages.map((m) => JSON.stringify(m)));
        return s;
      });
      return store;
    },

    save(store) {
      const sessions = Array.isArray(store.sessions) ? store.sessions : [];
      tx(() => {
        const keep = new Set();
        sessions.forEach((s, position) => {
          if (!s || !s.id) return;
          keep.add(s.id);
          const header = headerOf(s, position);
          if (seenSession.get(s.id) !== header) {
            const extra = {};
            for (const k of Object.keys(s)) if (!CORE_SESSION_KEYS.has(k)) extra[k] = s[k];
            q.upsertSession.run(
              s.id, s.title == null ? null : String(s.title), s.cwd == null ? null : String(s.cwd),
              JSON.stringify(s.alwaysAllowed || []), JSON.stringify(extra),
              Number(s.createdAt) || Date.now(), Number(s.updatedAt) || Date.now(), position,
            );
            seenSession.set(s.id, header);
          }
          const msgs = Array.isArray(s.messages) ? s.messages : [];
          const prev = seenMessages.get(s.id) || [];
          const next = new Array(msgs.length);
          for (let i = 0; i < msgs.length; i++) {
            const ser = JSON.stringify(msgs[i]);
            next[i] = ser;
            if (prev[i] !== ser) q.upsertMessage.run(s.id, i, msgs[i] && msgs[i].kind ? String(msgs[i].kind) : null, bodyOf(msgs[i]), ser);
          }
          if (prev.length > msgs.length) q.trimMessages.run(s.id, msgs.length);
          seenMessages.set(s.id, next);
        });
        for (const { id } of q.listSessionIds.all()) {
          if (!keep.has(id)) { q.deleteSession.run(id); seenSession.delete(id); seenMessages.delete(id); }
        }
        const keys = new Set();
        for (const k of Object.keys(store)) {
          if (k === 'sessions') continue;
          keys.add(k);
          if (store[k] === undefined) continue;
          const ser = JSON.stringify(store[k]);
          if (seenKv.get(k) !== ser) { q.upsertKv.run(k, ser); seenKv.set(k, ser); }
        }
        for (const k of [...seenKv.keys()]) if (!keys.has(k)) { q.deleteKv.run(k); seenKv.delete(k); }
      });
    },

    search(query, limit = 50) {
      const term = String(query || '').trim();
      if (!term) return [];
      const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      return q.search.all(like, Math.min(Math.max(limit | 0, 1), 200)).map((r) => ({
        ...r, snippet: snippetAround(r.body, term),
      }));
    },

    close() { try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {} try { db.close(); } catch {} },
  };
}

function headerOf(s, position) {
  const extra = {};
  for (const k of Object.keys(s)) if (!CORE_SESSION_KEYS.has(k)) extra[k] = s[k];
  return JSON.stringify([s.title, s.cwd, s.alwaysAllowed || [], extra, Number(s.createdAt) || 0, Number(s.updatedAt) || 0, position]);
}

function snippetAround(text, term) {
  const t = String(text || '');
  const at = t.toLowerCase().indexOf(term.toLowerCase());
  if (at < 0) return t.slice(0, 120);
  const from = Math.max(0, at - 50);
  return `${from > 0 ? '...' : ''}${t.slice(from, at + term.length + 70).replace(/\s+/g, ' ')}${at + term.length + 70 < t.length ? '...' : ''}`;
}

module.exports = { openSessionDb };
