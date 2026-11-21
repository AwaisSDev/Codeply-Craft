/**
 * The autonomy loop's rules: what a bot may do with nobody watching.
 *
 * A task reaches a bot from the user (a chat, a call, their own email to the
 * bot, a Slack DM to the bot). The host (Craft's autopilot.js) runs it as the
 * bot's agent, then a checking turn, then reports back where it came from.
 * Every action the agent wants to take goes through decide():
 *
 *   run    go ahead (inside the bot's approval boundary, or allowed by its
 *          autonomy level, within its daily budget)
 *   hold   put it in the outbox for the bot's hold time; the user can cancel
 *          from Crew or the phone; then it goes by itself
 *   ask    wait for the user (in the outbox, with no timer)
 *   refuse not at all: the bot is set to suggest only (autonomy level none),
 *          so it drafts and says what it would do instead
 *
 * Always ask, at every level: anything the engine flags dangerous, deleting
 * a cloud project, anything when the request did not come from the user, and
 * everything while the user has stopped all bots.
 */
const bots = require('./bots.js');

const OUTWARD = new Set(['send', 'publish', 'databases', 'calendar']);
const NEVER_ALONE = new Set(['supabase_delete_project', 'add_model']);
// Which daily budget a category spends (bots.js normalizeAutonomy budgets).
const BUDGET_OF = { send: 'emails', publish: 'deploys' };

/**
 * req: the engine's approval request ({ tool, danger, ... }).
 * o: { requester: 'user'|'other', paused, budgetLeft(key) -> number }
 */
function decide(req, bot, o = {}) {
  const tool = String(req && req.tool || '');
  if (!bot || o.paused) return 'ask';
  if (bots.suggestOnly(bot, tool)) return 'refuse';
  if (req.danger || NEVER_ALONE.has(tool)) return 'ask';
  if (o.requester && o.requester !== 'user') return 'ask';
  const cat = bots.approvalCategory(tool);
  const budget = cat && BUDGET_OF[cat];
  const within = !budget || typeof o.budgetLeft !== 'function' || o.budgetLeft(budget) > 0;
  const a = bots.normalizeAutonomy(bot.autonomy);
  // Inside the bot's own approval boundary: what it never had to ask about.
  if (!cat || bots.canSkipApproval(bot, tool)) return within ? 'run' : 'ask';
  if (a.level === 'full') return a.allow.includes(cat) && within ? 'run' : 'ask';
  if (a.level === 'hold') {
    if (OUTWARD.has(cat)) return within ? 'hold' : 'ask';
    return a.allow.includes(cat) ? 'run' : 'ask';
  }
  return 'ask';
}

const SOURCE_NAME = { handoff: 'another bot handing work on', crew: 'a chat in Agents', call: 'a phone call', email: 'an email from the user', slack: 'Slack', phone: 'the phone app', nudge: 'a nudge' };

/** The first turn: the task, how it came in, and how to work without the user there. */
function taskMessage(task, { holdMinutes } = {}) {
  return `TASK (from ${SOURCE_NAME[task.source] || task.source}, while the user is away)
${String(task.text || '').trim()}

Work this end to end on your own: plan it with the todo tool, do it, and check it really worked. The user is not watching, so do not stop to ask questions you can answer yourself; when something truly needs them (a password, a choice only they can make, money), say exactly what in one line and do everything else.
Actions that send, publish, deploy or change a database may wait in the user's outbox${holdMinutes ? ` for ${holdMinutes} minutes` : ''} or need their OK: that is expected; carry on with the rest.`;
}

/** The checking turn: look at the real result, fix what is missing, end with a verdict line. */
function verifyMessage(task) {
  return `Now check the task really worked: "${String(task.text || '').slice(0, 400)}"
Look at the actual result, not your memory of it: read what changed, run the check, test or build that applies, open any page you published (browser_check), confirm an email or message has an id. Fix anything missing and check again.
End with ONE line, exactly: VERIFIED: yes|partly|no - <how you checked, or what is missing>`;
}

function parseVerdict(text) {
  const m = /VERIFIED:\s*(yes|partly|no)\b\s*[-:,]?\s*(.*)$/im.exec(String(text || ''));
  if (!m) return { verified: 'unknown', why: '' };
  return { verified: m[1].toLowerCase(), why: m[2].trim().slice(0, 300) };
}

/** The short report the user gets (push, email or Slack). */
function reportText(task, { reply, verdict, status }) {
  const body = String(reply || '').replace(/VERIFIED:.*$/im, '').replace(/\s+/g, ' ').trim();
  const head = status === 'done' ? (verdict.verified === 'yes' ? 'Done and checked' : verdict.verified === 'partly' ? 'Mostly done' : 'Done') : status === 'needs_you' ? 'Needs you' : 'Could not finish';
  const why = verdict.why ? ` (${verdict.why})` : '';
  return `${head}${why}: ${body.slice(0, 600) || String(task.text || '').slice(0, 120)}`;
}

/** The fix pass: one more go when the check says the task is not really done. */
function fixMessage(task, verdict, checkText = '') {
  const found = (verdict && verdict.why) || String(checkText || '').replace(/VERIFIED:.*$/im, '').trim().slice(0, 600) || 'the result did not match the task';
  return `The check of this task found a problem: ${found}
The task was: "${String(task.text || '').slice(0, 400)}"
Fix exactly what the check found, using the real files and tools, then check it again yourself. Do not start over, and do not redo what already works.
End with ONE line, exactly: VERIFIED: yes|partly|no - <how you checked, or what is missing>`;
}

/**
 * Run a background agent to its end and keep what it said. Unlike a bare
 * "throw on error", an unfinished run (step limit after every continuation)
 * still returns its summary, and a parked run (allowance used up) returns
 * where to pick it up. Throws only for a real error or a stop.
 * Returns { reply, parked: {until, ledger} | null, needsYou: string, unfinished: bool }.
 */
async function collectRun(gen, onEvent) {
  let reply = '';
  let parked = null;
  let needsYou = '';
  let unfinished = false;
  for await (const ev of gen) {
    if (ev.type === 'text' && !ev.interim) reply += (reply ? '\n\n' : '') + ev.text;
    else if (ev.type === 'parked') parked = { until: ev.until, ledger: ev.ledger };
    else if (ev.type === 'health' && ev.state === 'needs_you') needsYou = ev.reason || 'It needs you to finish.';
    else if (ev.type === 'error') throw new Error(ev.error || 'the run failed');
    else if (ev.type === 'aborted') throw new Error('Stopped.');
    else if (ev.type === 'done') { unfinished = !!ev.unfinished; if (onEvent) onEvent(ev); break; }
    if (onEvent) onEvent(ev);
  }
  return { reply, parked, needsYou, unfinished };
}

/** What a parked run stores on its task so the queue picks it up again at `until`. */
function parkFields(parked) {
  return { status: 'queued', notBefore: parked.until, resume: parked.ledger };
}

/** True when a queued task may start: no notBefore, or that time has passed. */
function isDue(task, now = Date.now()) {
  const at = Date.parse((task && (task.notBefore || (task.data && task.data.notBefore))) || '');
  return !Number.isFinite(at) || at <= now;
}

/** A short line for the user when a task is waiting on an allowance. */
function parkedText(parked) {
  const at = new Date(parked.until);
  const clock = Number.isNaN(at.getTime()) ? 'later' : at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `Paused until ${clock}: the AI allowance is used up for now. It carries on by itself from where it stopped.`;
}

module.exports = { OUTWARD, NEVER_ALONE, BUDGET_OF, decide, taskMessage, verifyMessage, parseVerdict, reportText, fixMessage, collectRun, parkFields, isDue, parkedText };
