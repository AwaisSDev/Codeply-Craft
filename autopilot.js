// The autonomy loop in the desktop app (rules: codeply-cli/lib/autopilot.js).
//
// A task comes in (a call's to-do, the user's own email to a bot, a Slack DM
// to the bots, a nudge they said yes to) and is queued in the life store.
// One at a time (the engine's global lock, shared with Crew), the bot:
//   1. works it as its own agent, in the right folder
//   2. runs a checking turn on the real result (VERIFIED: yes / partly / no)
//   3. reports back: its Crew thread, a push or desktop notification, and an
//      answer where the task came from (an email reply, a Slack thread)
// Every action goes through decide(): run, hold in the outbox (the user can
// cancel from Crew or the phone), or wait for the user. Everything a bot does
// alone is written to the audit log. Stop all bots aborts what is running,
// cancels the outbox and keeps everything still until the user resumes.
//
// main.js wires this in with init(deps); nothing here reaches into main.js.
const path = require('path');
const fs = require('fs');
const os = require('os');

let deps = null;
let running = null;       // { task, controller }
let pumping = false;
const holds = new Map();  // outbox id -> { timer, resolve, run }
const DAY = 86400000;
const ASK_WAIT_MS = 30 * 60000;

const lib = (name) => require(path.join(deps.cliDir, 'lib', name));
const BOTS = () => lib('bots.js');
const RULES = () => lib('autopilot.js');
const store = () => deps.life.ensureStore();
const paused = () => !!deps.life.settings().autopilot.paused;
const short = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

function startOfDay() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }

// ─── Budgets and the audit log ──────────────────────────────────────────────

const BUDGET_TOOLS = {
  emails: new Set(['bot_email_send', 'gmail_send', 'slack_post_message']),
  deploys: new Set(['vercel_deploy', 'publish_deploy', 'publish_github', 'github_create_repo']),
};
/** What is left of a bot's daily budget: runs, emails, deploys. */
function budgetLeft(bot, key) {
  const s = store();
  if (!s || !bot) return 0;
  const b = BOTS().normalizeAutonomy(bot.autonomy).budgets;
  const since = startOfDay();
  if (key === 'runs') return b.runs - s.auditCount(since, 'task_start', bot.id);
  const tools = BUDGET_TOOLS[key];
  if (!tools) return Infinity;
  const used = s.auditSince(since, 1000).filter((e) => e.botId === bot.id && e.kind === 'action' && tools.has(e.tool) && e.ok).length;
  return (b[key] == null ? 0 : b[key]) - used;
}
function audit(e) {
  try { const s = store(); if (s) s.audit(e); } catch {}
  if (deps.life.pushState) deps.life.pushState('audit');
}

// ─── The outbox ─────────────────────────────────────────────────────────────

/**
 * An action waiting for its time (hold) or for the user (ask). Resolves to
 * 'go' or 'cancelled'. With run, the outbox runs it itself when it goes (bot
 * mail replies); without, the caller goes on (an agent's approval).
 */
function hold({ botId, taskId, tool, title, detail, minutes, run, ask = false }) {
  const s = store();
  const due = ask ? Date.now() + 365 * DAY : Date.now() + Math.max(1, Number(minutes) || 10) * 60000;
  const o = s.saveOutbox({ botId, taskId, tool, title: short(title, 280), detail: String(detail || '').slice(0, 4000), dueAt: due, status: ask ? 'needs_you' : 'waiting' });
  const bot = BOTS().getBot(botId);
  if (bot) tell(bot, ask ? `${bot.name} needs your OK: ${short(title, 160)}` : `${bot.name} will ${short(title, 140)} in ${Math.round((due - Date.now()) / 60000)} min unless you cancel.`, { outbox: o.id });
  deps.life.pushState('outbox');
  return new Promise((resolve) => {
    const settle = async (verdict) => {
      const h = holds.get(o.id);
      if (!h) return;
      clearTimeout(h.timer); holds.delete(o.id);
      if (verdict === 'go' && run) {
        let r = null;
        try { r = await run(); } catch (e) { r = { ok: false, error: e.message }; }
        s.saveOutbox({ id: o.id, status: r && r.ok ? 'sent' : 'failed' });
        audit({ kind: 'action', botId, taskId, tool, title, verdict: ask ? 'approved' : 'held', ok: !!(r && r.ok), result: r && r.ok ? 'went out' : (r && r.error) || 'failed' });
      } else s.saveOutbox({ id: o.id, status: verdict === 'go' ? 'sent' : 'cancelled' });
      if (verdict !== 'go') audit({ kind: 'cancelled', botId, taskId, tool, title, verdict: 'cancelled', ok: false, result: 'cancelled by you' });
      deps.life.pushState('outbox');
      resolve(verdict);
    };
    // An ask nobody answers in 30 minutes is skipped, so one question never holds every bot up.
    holds.set(o.id, { settle, timer: ask ? setTimeout(() => settle('cancelled'), ASK_WAIT_MS) : setTimeout(() => settle('go'), Math.max(0, due - Date.now())) });
  });
}
function outboxAction(id, action) {
  const h = holds.get(String(id));
  if (!h) {
    const s = store(); const o = s && s.getOutbox(id);
    if (o && ['waiting', 'needs_you'].includes(o.status)) s.saveOutbox({ id: o.id, status: 'expired' });
    return { error: 'That action is no longer waiting (Craft was restarted, or it already went).' };
  }
  h.settle(action === 'now' ? 'go' : 'cancelled');
  return { ok: true };
}

// ─── Telling the user ───────────────────────────────────────────────────────

async function tell(bot, text, extra = {}) {
  const atPc = deps.life.atPc ? deps.life.atPc() : true;
  if (atPc && deps.Notification && deps.Notification.isSupported()) {
    const n = new deps.Notification({ title: bot.name, body: short(text, 240), icon: deps.notifyIcon });
    n.on('click', () => deps.openBot(bot.id));
    n.show();
    return;
  }
  try {
    await deps.callFunction('reminders', { action: 'create', reminder: { text: short(text, 480), due_at: new Date().toISOString(), kind: 'remind', tz: deps.life.localTz(), bot_id: bot.id, bot_name: bot.name, bot_voice: bot.voice || null, payload: { autopilot: extra } } });
  } catch {}
}

function card(task, patch = {}) {
  const t = { ...task, ...patch };
  const data = t.data || {};
  if (t.botId) deps.crewThread(t.botId, { kind: 'task', id: t.id, source: t.source, status: t.status, text: short(t.text, 400), report: data.report || '', checked: data.checked || '' });
}

// ─── Tasks ──────────────────────────────────────────────────────────────────

/** A new task. requester 'user' only when it provably came from the user (their chat, call, verified email, linked Slack). */
function intake({ botId, source = 'crew', requester = 'user', text, reply = null, cwd = '' }) {
  const s = store();
  if (!s) return { error: 'The task store is not available on this PC.' };
  const bot = BOTS().getBot(botId);
  if (!bot) return { error: 'That bot is gone.' };
  const task = s.saveTask({ botId: bot.id, source, requester, text: String(text || '').slice(0, 4000), status: 'queued', data: { reply, cwd } });
  card(task);
  audit({ kind: 'task_in', botId: bot.id, taskId: task.id, title: `Task from ${source}: ${short(task.text, 140)}`, verdict: requester, ok: true });
  setTimeout(pump, 200);
  return { ok: true, task };
}

/** The folder a task works in: a Craft project it names, else the bots' folder. */
function folderFor(task) {
  if (task.data && task.data.cwd && fs.existsSync(task.data.cwd)) return task.data.cwd;
  const text = String(task.text || '').toLowerCase();
  for (const p of deps.projects ? deps.projects() : []) {
    const name = String(p.name || '').toLowerCase();
    if (name.length > 2 && text.includes(name) && fs.existsSync(p.path)) return p.path;
  }
  return deps.workspace();
}

async function pump() {
  if (pumping || running || paused()) return;
  pumping = true;
  try {
    const s = store();
    if (!s) return;
    const next = s.tasksByStatus('queued', 1)[0];
    if (!next) return;
    if (!(await deps.ensureEngine())) return;
    if (!next) return;
    const bot = BOTS().getBot(next.botId);
    if (!bot) { s.saveTask({ id: next.id, status: 'failed', data: { report: 'The bot is gone.' } }); return; }
    if (budgetLeft(bot, 'runs') <= 0) {
      const t = s.saveTask({ id: next.id, status: 'needs_you', data: { report: `${bot.name} reached its ${BOTS().normalizeAutonomy(bot.autonomy).budgets.runs} tasks for today. Raise it in its settings or run it yourself.` } });
      card(t); tell(bot, t.data.report);
      return;
    }
    await run(next, bot);
  } catch (e) { console.warn('[autopilot]', e.message); } finally {
    pumping = false;
    if (!paused()) setTimeout(pump, 500);
  }
}

async function collect(gen, onEvent) {
  let reply = '';
  for await (const ev of gen) {
    if (ev.type === 'text' && !ev.interim) reply += (reply ? '\n\n' : '') + ev.text;
    else if (ev.type === 'error') throw new Error(ev.error || 'the run failed');
    else if (ev.type === 'aborted') throw new Error('Stopped.');
    else if (ev.type === 'done') break;
    if (onEvent) onEvent(ev);
  }
  return reply;
}

async function run(task, bot) {
  const s = store();
  const R = RULES();
  const controller = new AbortController();
  const { signal } = controller;
  running = { task, controller };
  let t = s.saveTask({ id: task.id, status: 'running' });
  card(t);
  audit({ kind: 'task_start', botId: bot.id, taskId: task.id, title: short(task.text, 160), verdict: task.requester, ok: true });
  const agent = deps.agentMod();
  const route = deps.currentRoute();
  const cwd = folderFor(task);
  const a = BOTS().normalizeAutonomy(bot.autonomy);
  let needsYou = false;
  const approve = async (req) => {
    if (signal.aborted) return 'reject';
    const verdict = R.decide(req, BOTS().getBot(bot.id) || bot, { requester: task.requester, paused: paused(), budgetLeft: (k) => budgetLeft(bot, k) });
    if (verdict === 'run') { audit({ kind: 'approved', botId: bot.id, taskId: task.id, tool: req.tool, title: short(req.title, 200), verdict: 'auto', ok: true }); return 'once'; }
    // Suggest only (Level 1): never acts, never asks; the report carries the suggestion.
    if (verdict === 'refuse') { audit({ kind: 'refused', botId: bot.id, taskId: task.id, tool: req.tool, title: short(req.title, 200), verdict: 'suggest only', ok: false, result: 'set to suggest only' }); return 'reject'; }
    const asked = verdict === 'ask';
    const r = await hold({ botId: bot.id, taskId: task.id, tool: req.tool, title: req.title, detail: req.detail, minutes: a.holdMinutes, ask: asked });
    if (asked && r !== 'go') needsYou = true;
    return r === 'go' ? 'once' : 'reject';
  };
  const team = BOTS().listBots();
  const onEvent = (ev) => {
    if (ev.type === 'tool_end') audit({ kind: 'action', botId: bot.id, taskId: task.id, tool: ev.name, title: short(ev.summary || (ev.meta && ev.meta.label) || ev.name, 200), ok: !!ev.ok, result: ev.ok ? '' : short(ev.summary || ev.error, 200) });
  };
  let reply = ''; let verdict = { verified: 'unknown', why: '' }; let status = 'done';
  try {
    await BOTS().globalLock.run(`autopilot:${task.id}`, async () => {
      const userMessage = R.taskMessage(task, { holdMinutes: a.level === 'hold' ? a.holdMinutes : 0 });
      // A bot can pass part of the task on (brain.js); the receiver inherits who asked in the end.
      const handOff = deps.handOffFor ? deps.handOffFor({ botId: bot.id, requester: task.requester, taskId: task.id }) : undefined;
      const common = { mode: 'Build', cwd, signal, route, approve, botId: bot.id, handOff, haze: { product: 'crew', chatId: `task:${task.id}` }, botPrompt: (native) => BOTS().buildBotPrompt(bot, { team, native, request: task.text, canHandOff: !!handOff }) };
      reply = await collect(agent.runAgent({ ...common, userMessage, history: [], maxSteps: 40 }), onEvent);
      if (signal.aborted) throw new Error('Stopped.');
      t = s.saveTask({ id: task.id, status: 'verifying' });
      card(t);
      const check = await collect(agent.runAgent({ ...common, userMessage: R.verifyMessage(task), history: [{ role: 'user', content: userMessage }, { role: 'assistant', content: reply || '(no reply)' }], maxSteps: 16, verifyOnly: true }), onEvent);
      verdict = R.parseVerdict(check);
      reply = [reply, check.replace(/VERIFIED:.*$/im, '').trim()].filter(Boolean).join('\n\n');
      if (verdict.verified === 'no') status = 'failed';
    }, signal);
  } catch (e) {
    status = signal.aborted ? 'cancelled' : 'failed';
    reply = reply || e.message;
  } finally { running = null; }
  if (status === 'done' && needsYou) status = 'needs_you';
  const report = R.reportText(task, { reply, verdict, status });
  t = s.saveTask({ id: task.id, status, data: { report: short(report, 1200), checked: verdict.why || verdict.verified, verified: verdict.verified } });
  card(t);
  audit({ kind: 'task_end', botId: bot.id, taskId: task.id, title: short(task.text, 160), verdict: status, ok: status === 'done', result: short(report, 300) });
  if (deps.onTaskEnd) { try { deps.onTaskEnd(t, status, report); } catch {} }
  if (status !== 'cancelled') {
    await tell(bot, report);
    await answerOrigin(task, bot, report);
  }
  if (deps.life.pushState) deps.life.pushState('tasks');
}

/** Report back where the task came from: an email thread, a Slack thread. */
async function answerOrigin(task, bot, report) {
  const r = task.data && task.data.reply;
  if (!r || !deps.botsMail) return;
  try {
    if (r.via === 'email' && r.mailId) {
      const th = await deps.botsMail.thread(r.mailId);
      if (th) await deps.botsMail.send({ botId: bot.id, to: th.to, subject: th.subject, text: report, replyTo: r.mailId });
    } else if (r.via === 'slack' && r.channel) {
      await deps.botsMail.slackReply({ botId: bot.id, channel: r.channel, ts: r.ts, text: report });
    }
  } catch (e) { console.warn('[autopilot] report:', e.message); }
}

function cancelTask(id) {
  const s = store();
  const t = s && s.getTask(id);
  if (!t) return { error: 'That task is gone.' };
  if (running && running.task.id === t.id) running.controller.abort();
  else if (['queued', 'needs_you'].includes(t.status)) { const n = s.saveTask({ id: t.id, status: 'cancelled' }); card(n); }
  for (const o of s.outboxByStatus('needs_you', 100).concat(s.outboxByStatus('waiting', 100))) if (o.taskId === t.id) outboxAction(o.id, 'cancel');
  audit({ kind: 'cancelled', botId: t.botId, taskId: t.id, title: short(t.text, 160), verdict: 'cancelled', ok: false, result: 'cancelled by you' });
  return { ok: true };
}

/** Stop all bots: nothing runs, nothing waiting goes out, until the user resumes. */
function stopAll() {
  deps.life.setSettings({ autopilot: { paused: true } });
  if (running) running.controller.abort();
  for (const id of [...holds.keys()]) outboxAction(id, 'cancel');
  try { if (deps.stopCrew) deps.stopCrew(); } catch {}
  try { if (deps.stopCalls) deps.stopCalls(); } catch {}
  audit({ kind: 'stop', title: 'You stopped all bots', verdict: 'stop', ok: true });
  return deps.life.setSettings({});
}

function state() {
  const s = store();
  if (!s) return {};
  return {
    outbox: [...s.outboxByStatus('needs_you', 20), ...s.outboxByStatus('waiting', 20)].filter((o) => holds.has(o.id)),
    tasks: s.recentTasks(12),
    audit: s.auditSince(Date.now() - 7 * DAY, 60),
    running: running ? running.task.id : null,
  };
}

/** The phone's Bots at work card (main.js handleBridgeApi, over the relay). */
async function bridge(method, pathname, body) {
  const s = store();
  if (!s) return { status: 503, body: { error: 'Not ready.' } };
  if (method === 'GET' && pathname === '/api/life') {
    const st = state();
    const bots = BOTS().listBots().map((b) => ({ id: b.id, name: b.name }));
    return { status: 200, body: { paused: paused(), outbox: st.outbox.map((o) => ({ id: o.id, botId: o.botId, title: o.title, dueAt: o.dueAt, status: o.status })), tasks: st.tasks.filter((t) => ['queued', 'running', 'verifying', 'needs_you'].includes(t.status)).slice(0, 6).map((t) => ({ id: t.id, botId: t.botId, text: short(t.text, 120), status: t.status })), bots } };
  }
  if (method === 'POST' && pathname === '/api/life/outbox') { const r = outboxAction(body && body.id, body && body.action === 'now' ? 'now' : 'cancel'); return { status: r.error ? 409 : 200, body: r }; }
  if (method === 'POST' && pathname === '/api/life/stop') { stopAll(); return { status: 200, body: { ok: true } }; }
  if (method === 'POST' && pathname === '/api/life/resume') { deps.life.setSettings({ autopilot: { paused: false } }); setTimeout(pump, 200); return { status: 200, body: { ok: true } }; }
  if (method === 'POST' && pathname === '/api/life/nudge') { const r = deps.life.feedback(body && body.id, body && body.verdict); return { status: r.error ? 404 : 200, body: r }; }
  return null;
}

function registerIpc(ipcMain) {
  const guard = (fn) => async (e, ...a) => { try { return await fn(...a); } catch (err) { return { error: err.message }; } };
  ipcMain.handle('crew:life:stopAll', guard(() => stopAll()));
  ipcMain.handle('crew:life:outbox', guard((id, action) => outboxAction(id, action)));
  ipcMain.handle('crew:life:task', guard((id, action) => (action === 'cancel' ? cancelTask(id) : { error: 'Unknown action.' })));
}

function init(d) {
  deps = d;
  registerIpc(d.ipcMain);
  // Waiting actions from before a restart cannot go any more (their work is gone): mark them.
  setTimeout(() => {
    try {
      const s = store();
      if (!s) return;
      for (const st of ['waiting', 'needs_you']) for (const o of s.outboxByStatus(st, 200)) if (!holds.has(o.id)) s.saveOutbox({ id: o.id, status: 'expired' });
      for (const t of s.tasksByStatus('running', 50).concat(s.tasksByStatus('verifying', 50))) s.saveTask({ id: t.id, status: 'queued' });
      pump();
    } catch (e) { console.warn('[autopilot] start:', e.message); }
  }, 20000);
}

module.exports = { init, intake, hold, outboxAction, cancelTask, stopAll, budgetLeft, audit, state, pump, bridge };
