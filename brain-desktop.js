// The shared brain in the desktop app (engine: codeply-cli/lib/brain.js).
//
// One personal context for Craft, Crew, the drop, Orbit and the phone: what
// the user likes, what they decided for each project, what is true right now,
// and what the bots learned on the job. Every agent run reads it (agent.mjs
// adds it to the prompt by itself); this file is the desktop's side:
//   · opens the store with Electron's SQLite driver
//   · learns from Craft chats (Crew chats learn in bots.learnFromTurn, in the
//     same model call the bot's own memory already makes)
//   · runs the coordination board: an agent's hand_off becomes a task for the
//     bot whose job it is (autopilot.js works it end to end), and the result
//     goes back to the bot that handed it on
//   · spots work for another bot with no model call: an important email
//     asking for a meeting goes from the email bot to the calendar bot
//   · the Brain page in Crew: see, correct, confirm and forget what it knows
//
// main.js wires this in with init(deps); nothing here reaches into main.js.
const path = require('path');

let deps = null;
const lib = (name) => require(path.join(deps.cliDir, 'lib', name));
const BRAIN = () => lib('brain.js');
const BOTS = () => lib('bots.js');
const short = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const LEARN_MIN_CHARS = 24;

// ─── Handoffs ───────────────────────────────────────────────────────────────

/** The coordinator brain.js calls: an open handoff becomes a task for its bot. */
async function queueHandoff(h) {
  if (!deps.intake) return { error: 'The autopilot is not running.' };
  const bot = BOTS().getBot(h.toBot);
  if (!bot) return { error: 'That bot is gone.' };
  const r = deps.intake({ botId: bot.id, source: 'handoff', requester: h.requester, text: BRAIN().handoffTask(h) });
  if (!r || r.error) return { error: (r && r.error) || 'not queued' };
  if (h.fromBot) note(h.fromBot, h, { status: 'working', text: `Handed to ${bot.name}: ${short(h.intent, 200)}` });
  push();
  return { taskId: r.task.id };
}

/**
 * The hand_off tool for one run. requester is who asked for this run in the
 * end ('user' for a chat, the task's own requester inside the autopilot).
 */
function handOffFor({ botId, requester = 'user', taskId = '' } = {}) {
  return (args) => {
    const fromBot = botId ? BOTS().getBot(botId) : null;
    // Inside a task that came from a handoff, the new one continues that chain.
    const parent = taskId ? (BRAIN().handoffForTask(taskId) || {}).id || '' : '';
    return BRAIN().handOff(args, { fromBot, requester, parent });
  };
}

/** autopilot.js: a task ended. If it came from a handoff, close it and tell whoever handed it on. */
function taskEnded(task, status, report) {
  try {
    const B = BRAIN();
    const h = B.handoffForTask(task.id);
    if (!h) return;
    const done = status === 'done';
    B.updateHandoff(h.id, { status: done ? 'done' : status === 'needs_you' ? 'needs_user' : status === 'cancelled' ? 'cancelled' : 'failed', result: report });
    if (h.fromBot) note(h.fromBot, h, { status: done ? 'done' : status === 'needs_you' ? 'needs_you' : 'failed', text: `Handed to ${h.toName || 'a teammate'}: ${short(h.intent, 200)}`, report: short(report, 600) });
    push();
  } catch (e) { console.warn('[brain] handoff end:', e.message); }
}

/** The handoff card in the sending bot's Crew thread; the same card updates when the work ends. */
function note(botId, h, card) {
  try { if (deps.crewThread) deps.crewThread(botId, { kind: 'handoff', id: `handoff:${h.id}`, to: h.toName || '', domain: h.domain || '', ...card }); } catch {}
}

// ─── Work spotted for another bot ───────────────────────────────────────────

/**
 * bots-watch.js: an important email arrived. A meeting request goes to the
 * bot that handles the calendar (never the same bot), as a request from
 * someone else: it can check and propose, and anything it books waits for
 * the user's OK.
 */
async function onImportantEmail(ev) {
  try {
    const B = BRAIN();
    if (!B.available() || !B.canHandOff() || !ev || ev.alert) return null;
    if (!B.looksLikeScheduling(ev.subject, ev.summary)) return null;
    const team = BOTS().listBots();
    const route = B.routeHandoff('calendar', team, { fromBotId: ev.botId, intent: `${ev.subject} ${ev.summary}` });
    if (!route.bot || !B.botDomains(route.bot).includes('calendar')) return null;
    const from = team.find((b) => b.id === ev.botId) || null;
    const facts = [
      `From: ${ev.fromName || ''} <${ev.fromEmail || ''}>`,
      `Subject: ${ev.subject || ''}`,
      `What it says: ${short(ev.summary, 400)}`,
      ev.threadId ? `Gmail thread: ${ev.threadId}` : '',
      ev.gmailUrl ? `Open it: ${ev.gmailUrl}` : '',
    ].filter(Boolean);
    return await B.handOff({
      to: route.bot.name,
      intent: `${ev.fromName || 'Someone'} is asking for a meeting. Check it against the user's calendar, their preferences (working hours, times they avoid) and what is already booked; then propose: the slot if it is free and sensible, else the best alternatives. Book nothing without the user's OK.`,
      facts,
      decision: ev.draftId ? `${from ? from.name : 'The email bot'} drafted a reply in Gmail (not sent). Say if the draft should change.` : '',
    }, { fromBot: from, requester: 'other', origin: { via: 'email', messageId: ev.messageId, threadId: ev.threadId } });
  } catch (e) { console.warn('[brain] email handoff:', e.message); return null; }
}

// ─── Learning from Craft chats ──────────────────────────────────────────────

/**
 * runOneTurn, after a reply. Chats with a bot learn in bots.learnFromTurn;
 * this covers plain Craft, so a decision made while coding is known in Crew
 * and on the phone too. One small model call, in the background.
 */
function learnFromCraft({ userText, replyText, cwd, route, withBot }) {
  try {
    const B = BRAIN();
    if (withBot || !B.available() || !replyText || String(userText || '').trim().length < LEARN_MIN_CHARS) return;
    if (/^\s*(continue|go on|ok|okay|yes|no|thanks|thank you|retry|try again|do it|fix it)\b/i.test(userText) && userText.length < 60) return;
    const project = B.projectOfFolder(cwd);
    B.learnFromExchange({ userText, replyText, project, src: { product: 'craft' } }, (messages) => deps.aiLib().chatJson(messages, { route }))
      .then((r) => { if (r && r.some((x) => ['added', 'replaced', 'reinforced'].includes(x.action))) push(); })
      .catch(() => {});
  } catch {}
}

// ─── The Brain page in Crew ─────────────────────────────────────────────────

function state() {
  const B = BRAIN();
  // Off (or no SQLite driver on this PC): the page still shows, with the switch.
  if (!B.enabled()) return { on: false, usable: B.usable(), memories: [], changes: [], projects: [], handoffs: [], bots: [], domains: B.DOMAIN_KEYS };
  B.prune();
  const bots = BOTS().listBots().map((b) => ({ id: b.id, name: b.name, handles: b.handles || [], inferred: B.botDomains({ ...b, handles: [] }), autonomy: (b.autonomy && b.autonomy.level) || 'ask' }));
  return {
    on: true, usable: true,
    memories: B.list({ limit: 400 }),
    changes: B.changes({ limit: 60 }),
    projects: B.projects(30),
    handoffs: B.recentHandoffs(20),
    bots, domains: B.DOMAIN_KEYS, kinds: Object.fromEntries(Object.entries(B.KINDS).map(([k, v]) => [k, v.label])),
  };
}

function push() { try { if (deps.crewEvent) deps.crewEvent({ type: 'brain', state: state() }); } catch {} }

function registerIpc(ipcMain) {
  const guard = (fn) => async (e, ...a) => { try { const r = await fn(...a); return r === undefined ? state() : r; } catch (err) { return { error: err.message }; } };
  const after = (fn) => guard(async (...a) => { await fn(...a); push(); return state(); });
  ipcMain.handle('crew:brain:state', guard(() => state()));
  ipcMain.handle('crew:brain:enable', after((on) => BRAIN().setEnabled(!!on)));
  ipcMain.handle('crew:brain:add', after((o) => {
    const r = BRAIN().observe({ ...(o || {}), certainty: 'stated' }, { product: 'you' });
    if (r.memory) BRAIN().confirm(r.memory.id);
    else if (r.action === 'ignored') throw new Error(r.why === 'looks like a secret' ? 'That looks like a secret. Codeply does not keep passwords or keys.' : 'Nothing to save.');
  }));
  ipcMain.handle('crew:brain:correct', after((id, patch) => BRAIN().correct(String(id), patch || {})));
  ipcMain.handle('crew:brain:confirm', after((id) => BRAIN().confirm(String(id))));
  ipcMain.handle('crew:brain:resolve', after((id, choice) => BRAIN().resolve(String(id), String(choice))));
  ipcMain.handle('crew:brain:forget', after((id) => BRAIN().forget(String(id))));
  ipcMain.handle('crew:brain:clear', after((scope) => BRAIN().clear(scope ? String(scope) : undefined)));
  ipcMain.handle('crew:brain:handles', after((botId, handles) => {
    const list = (Array.isArray(handles) ? handles : []).filter((d) => BRAIN().DOMAINS[d]);
    BOTS().updateBot(String(botId), { handles: list });
    if (deps.onBotsChange) deps.onBotsChange();
  }));
}

function init(d) {
  deps = d;
  try {
    BRAIN().configure({ modulePaths: d.modulePaths, scratch: d.scratchFolders ? d.scratchFolders() : [] });
    BRAIN().setCoordinator(queueHandoff);
  } catch (e) { console.warn('[brain] not available:', e.message); }
  registerIpc(d.ipcMain);
}

module.exports = { init, handOffFor, taskEnded, onImportantEmail, learnFromCraft, state, push };
