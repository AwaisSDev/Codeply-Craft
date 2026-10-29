/**
 * The spine: one ledger of what the agent was asked to do, what it actually
 * did, and the proof that it happened.
 *
 *   task      one piece of work (a chat turn that changed something, an
 *             autopilot task, a routine). Its status is worked out from its
 *             actions, never from what the model said.
 *   action    one side effect (send, add, write, deploy). Written BEFORE the
 *             tool runs, with an idempotency key, so a crash in the middle
 *             leaves a row that says "started, no result".
 *   evidence  what proves an action: an API read-back, a test run, a check.
 *             An action with no evidence is "not verified", and says so.
 *
 * Every part of Codeply reads the same ledger (chats, agents, the autopilot,
 * the morning message), so "what did you do" always has one answer.
 *
 * Hosts point it at a file with configure(); with no SQLite driver it is off
 * and every call is a harmless no-op.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { loadDriver } = require('./session-db.js');

const MIN = 60 * 1000;
const STALE_MS = 2 * MIN;

let cfg = { file: null, modulePaths: null, now: null };
let db = null; let q = null; let failed = false;

const now = () => (cfg.now ? cfg.now() : Date.now());
const json = (v, fallback) => { try { return v == null ? fallback : JSON.parse(v); } catch { return fallback; } };
const clip = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const newId = (p) => `${p}${now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
const SECRETISH = /\b(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|[A-Za-z0-9_-]{40,})\b/g;
const mask = (s) => String(s || '').replace(SECRETISH, '[hidden]');

function defaultFile() {
  return process.env.CODEPLY_SPINE_DB || path.join(os.homedir(), '.codeply', 'brain', 'ledger.db');
}

function configure(o = {}) {
  close();
  cfg = { ...cfg, ...o };
  failed = false;
}

function open() {
  if (db) return true;
  if (failed || process.env.CODEPLY_SPINE === 'off') return false;
  const driver = loadDriver(cfg.modulePaths || undefined);
  if (!driver) { failed = true; return false; }
  try {
    const file = cfg.file || defaultFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    db = driver.open(file);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, goal TEXT NOT NULL DEFAULT '', origin TEXT NOT NULL DEFAULT 'chat', requester TEXT NOT NULL DEFAULT 'user',
        chat_id TEXT, bot_id TEXT, product TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tasks_updated ON tasks (updated_at);
      CREATE TABLE IF NOT EXISTS actions (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, tool TEXT NOT NULL, key TEXT NOT NULL UNIQUE, args TEXT,
        status TEXT NOT NULL, verified TEXT NOT NULL DEFAULT 'none', summary TEXT, output TEXT,
        started_at INTEGER NOT NULL, ended_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS actions_task ON actions (task_id, started_at);
      CREATE INDEX IF NOT EXISTS actions_status ON actions (status, started_at);
      CREATE TABLE IF NOT EXISTS evidence (
        id TEXT PRIMARY KEY, action_id TEXT, task_id TEXT NOT NULL, type TEXT NOT NULL, ok INTEGER NOT NULL,
        detail TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS evidence_action ON evidence (action_id);
    `);
    db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run('schema', '1');
    q = {
      insTask: db.prepare('INSERT INTO tasks (id, goal, origin, requester, chat_id, bot_id, product, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
      touchTask: db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?'),
      getTask: db.prepare('SELECT * FROM tasks WHERE id = ?'),
      tasksSince: db.prepare('SELECT * FROM tasks WHERE updated_at >= ? ORDER BY created_at ASC LIMIT ?'),
      insAction: db.prepare('INSERT INTO actions (id, task_id, tool, key, args, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      byKey: db.prepare('SELECT * FROM actions WHERE key = ?'),
      getAction: db.prepare('SELECT * FROM actions WHERE id = ?'),
      endAction: db.prepare('UPDATE actions SET status = ?, verified = ?, summary = ?, output = ?, ended_at = ? WHERE id = ?'),
      actionsOf: db.prepare('SELECT * FROM actions WHERE task_id = ? ORDER BY started_at ASC'),
      pending: db.prepare("SELECT * FROM actions WHERE status = 'started' AND started_at <= ? ORDER BY started_at ASC LIMIT 100"),
      insEvidence: db.prepare('INSERT INTO evidence (id, action_id, task_id, type, ok, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      evidenceOf: db.prepare('SELECT * FROM evidence WHERE action_id = ? ORDER BY at ASC'),
    };
    return true;
  } catch (e) {
    if (process.env.CODEPLY_DEBUG) console.warn('[spine] open:', e.message);
    failed = true; db = null; q = null;
    return false;
  }
}

function close() {
  if (db) { try { db.close(); } catch {} }
  db = null; q = null;
}

function available() { return open(); }

// ─── Keys ───────────────────────────────────────────────────────────────────

function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}

/** The same task asking for the same thing twice is one action, not two. 64 hex chars. */
function actionKey(taskId, tool, args) {
  return crypto.createHash('sha256').update(`${taskId}\n${tool}\n${stable(args || {})}`).digest('hex');
}

// ─── Tasks and actions ──────────────────────────────────────────────────────

/** @returns {string|null} the task id */
function startTask(o = {}) {
  if (!open()) return null;
  const id = newId('t');
  const t = now();
  q.insTask.run(id, clip(mask(o.goal), 500), String(o.origin || 'chat'), String(o.requester || 'user'), o.chatId ? String(o.chatId) : null, o.botId ? String(o.botId) : null, o.product ? String(o.product) : null, t, t);
  return id;
}

/**
 * Before a side effect. Returns { id, key, repeat } or null (ledger off).
 * repeat: an action with this key already exists; its row comes back as
 * `previous` so the caller can read back instead of doing it again.
 */
function beginAction(taskId, tool, args) {
  if (!taskId || !open()) return null;
  const key = actionKey(taskId, tool, args);
  const prev = q.byKey.get(key);
  if (prev) return { id: prev.id, key, repeat: true, previous: rowToAction(prev) };
  const id = newId('a');
  q.insAction.run(id, taskId, String(tool), key, clip(mask(JSON.stringify(args || {})), 800), 'started', now());
  q.touchTask.run(now(), taskId);
  return { id, key, repeat: false };
}

/**
 * After the side effect. evidence: [{ type, ok, detail }]. verified is 'yes'
 * only when there is evidence and all of it passed, 'no' when any failed,
 * 'none' when nothing checked it.
 */
function endAction(actionId, r = {}) {
  if (!actionId || !open()) return null;
  const row = q.getAction.get(actionId);
  if (!row) return null;
  const ev = Array.isArray(r.evidence) ? r.evidence.filter((e) => e && e.type) : [];
  for (const e of ev) addEvidence(row.task_id, actionId, e);
  const all = q.evidenceOf.all(actionId);
  const verified = !all.length ? 'none' : all.every((e) => e.ok) ? 'yes' : 'no';
  const status = r.rejected ? 'rejected' : r.status || (r.ok ? 'done' : 'failed');
  q.endAction.run(status, verified, clip(r.summary || '', 200), clip(mask(r.output), 600), now(), actionId);
  q.touchTask.run(now(), row.task_id);
  return rowToAction(q.getAction.get(actionId));
}

function addEvidence(taskId, actionId, e) {
  if (!open()) return;
  q.insEvidence.run(newId('e'), actionId || null, taskId, String(e.type), e.ok ? 1 : 0, clip(mask(e.detail), 400), now());
}

/** Used by tools.mjs executeTool: one task per agent run, made on its first side effect. */
function beginFor(ctx, tool, args) {
  if (!ctx || !open()) return null;
  if (!ctx.spineTaskId) {
    ctx.spineTaskId = startTask({
      goal: ctx.spineGoal || (typeof ctx.userMessage === 'string' ? ctx.userMessage : ''), origin: ctx.spineOrigin || (ctx.botId ? 'bot' : 'chat'),
      requester: ctx.requester || 'user', chatId: ctx.chatId, botId: ctx.botId, product: ctx.product,
    });
  }
  return beginAction(ctx.spineTaskId, tool, args);
}

// ─── Reading ────────────────────────────────────────────────────────────────

function rowToAction(r) {
  if (!r) return null;
  return {
    id: r.id, taskId: r.task_id, tool: r.tool, key: r.key, args: r.args, status: r.status, verified: r.verified,
    summary: r.summary || '', output: r.output || '', startedAt: r.started_at, endedAt: r.ended_at || null,
    evidence: q.evidenceOf.all(r.id).map((e) => ({ type: e.type, ok: !!e.ok, detail: e.detail, at: e.at })),
  };
}

/**
 * What a task's actions add up to:
 *   running          an action is still in flight
 *   done_verified    everything it did was checked and passed
 *   check_failed     something it did failed its check
 *   done_unverified  it did things nothing could check
 *   failed           it tried and nothing went through
 *   declined         the user said no to everything it asked
 *   no_actions       it only talked or read
 */
function statusOf(actions) {
  if (!actions.length) return 'no_actions';
  if (actions.some((a) => a.status === 'started')) return 'running';
  const done = actions.filter((a) => a.status === 'done' || a.status === 'unknown');
  if (done.some((a) => a.verified === 'no')) return 'check_failed';
  if (done.length && done.every((a) => a.verified === 'yes' && a.status === 'done')) return 'done_verified';
  if (done.length) return 'done_unverified';
  if (actions.every((a) => a.status === 'rejected')) return 'declined';
  return 'failed';
}

function task(id) {
  if (!open()) return null;
  const r = q.getTask.get(String(id));
  if (!r) return null;
  const actions = q.actionsOf.all(r.id).map(rowToAction);
  return {
    id: r.id, goal: r.goal, origin: r.origin, requester: r.requester, chatId: r.chat_id, botId: r.bot_id, product: r.product,
    createdAt: r.created_at, updatedAt: r.updated_at, actions, status: statusOf(actions),
  };
}

/** Tasks with any activity since t, oldest first. Talk-only turns are left out unless all: true. */
function tasksSince(t, o = {}) {
  if (!open()) return [];
  return q.tasksSince.all(Number(t) || 0, o.limit || 200).map((r) => task(r.id)).filter((x) => x && (o.all || x.actions.length));
}

/** Actions still "started" after STALE_MS: the process died or hung between doing and recording. */
function pendingActions(o = {}) {
  if (!open()) return [];
  return q.pending.all(now() - (o.olderThanMs == null ? STALE_MS : o.olderThanMs)).map(rowToAction);
}

/**
 * Settle interrupted actions. handlers[tool](action) reads the world back and
 * returns { status: 'done'|'failed', evidence } or null when it cannot tell.
 * Nothing is retried here: an action that cannot be confirmed is marked
 * 'unknown' so the user is told, instead of risking doing it twice.
 */
async function recover(handlers = {}, o = {}) {
  const out = [];
  for (const a of pendingActions(o)) {
    let r = null;
    try { if (handlers[a.tool]) r = await handlers[a.tool](a); } catch (e) { r = null; }
    if (r && (r.status === 'done' || r.status === 'failed')) {
      out.push(endAction(a.id, { status: r.status, summary: r.summary || a.summary, output: r.output || 'Settled after an interruption.', evidence: r.evidence }));
    } else {
      out.push(endAction(a.id, { status: 'unknown', output: 'Interrupted before the result was recorded. Could not confirm whether it happened, so it was not tried again.' }));
    }
  }
  return out;
}

// ─── Saying what happened ───────────────────────────────────────────────────

const VERB = {
  gmail_send: 'Sent an email', gmail_draft: 'Saved a draft', calendar_add: 'Added to the calendar', calendar_update: 'Changed the calendar',
  write_file: 'Wrote a file', edit_file: 'Edited a file', apply_patch: 'Changed files', slack_post_message: 'Posted to Slack',
  vercel_deploy: 'Deployed', publish_deploy: 'Published', bot_email_send: 'Sent an email',
};

/** One line per action, each saying how sure we are. Only what the ledger can back. */
function actionLine(a) {
  const what = a.summary || VERB[a.tool] || a.tool;
  if (a.status === 'rejected') return `${what}: you said no, so it did not happen.`;
  if (a.status === 'failed') return `${what}: failed. ${clip(a.output, 160)}`;
  if (a.status === 'started') return `${what}: still in progress.`;
  if (a.status === 'unknown') return `${what}: interrupted, not sure it went through. Please check.`;
  const proof = a.evidence.filter((e) => e.ok).map((e) => e.detail)[0];
  const bad = a.evidence.filter((e) => !e.ok).map((e) => e.detail)[0];
  if (a.verified === 'yes') return `${what} (checked: ${proof || 'confirmed'}).`;
  if (a.verified === 'no') return `${what}, but the check failed: ${bad || 'it did not match'}.`;
  return `${what} (not verified).`;
}

function report(taskId) {
  const t = task(taskId);
  if (!t) return [];
  return t.actions.map(actionLine);
}

module.exports = {
  configure, close, available, actionKey, startTask, beginAction, endAction, addEvidence, beginFor,
  task, tasksSince, pendingActions, recover, statusOf, actionLine, report, STALE_MS,
};
