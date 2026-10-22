/**
 * Proactive outreach: when a bot should reach out without being asked.
 *
 * Every minute the host (life-desktop.js) calls due() with the life store and
 * a snapshot (life.js). Each trigger looks for its moment with no model call:
 *
 *   leaving   an event or plan with a place starts in 5 to 20 minutes
 *   meeting   a meeting with people starts in 2 to 10 minutes
 *   email     an important email has waited 24 hours for the user's reply
 *   deadline  a deadline in the next 3 days, and no push to its project in 3 days
 *   watched   a while after something watched for 10+ minutes, ask how it went
 *   brief     once in the morning, the day in a few lines (off by default)
 *   activity  the user has moved far less than usual for two days, or stopped
 *             working out: one gentle "everything okay?" (needs health data)
 *
 * What comes out is checked against the user's limits: a daily budget, quiet
 * hours, never twice for the same thing, a gap between nudges, nothing but
 * "leaving" while they are on a call or in a meeting, and their feedback
 * (Not now waits an hour, Stop these turns the trigger off). Then ONE model
 * call (judgePrompt) decides which are worth sending and words them in the
 * bot's own voice; without a model the fallback lines go out.
 */
const L = require('./life.js');
const MW = require('./mail-watch.js');

const MIN = 60000; const HOUR = 3600000; const DAY = 86400000;

const TRIGGERS = {
  leaving: { label: 'Before you head out', note: 'Before a plan or event with a place: wallet, keys, when to leave.', domain: 'life' },
  meeting: { label: 'Before a meeting', note: 'A few minutes before a meeting: who it is with and what you last talked about.', domain: 'work' },
  email: { label: 'Someone is waiting on you', note: 'An important email you have not answered in 24 hours.', domain: 'work' },
  deadline: { label: 'Deadlines', note: 'A deadline in the next 3 days and no push to the project in 3 days.', domain: 'work' },
  watched: { label: 'Follow-ups', note: 'A few hours after you watched something for 10 minutes or more, a bot asks how it went.', domain: 'life' },
  brief: { label: 'Morning brief', note: 'Your day in a few lines, once in the morning.', domain: 'life', off: true },
  activity: { label: 'When you move less than usual', note: 'If your steps or workouts drop a lot for a couple of days, a bot gently asks if everything is okay.', domain: 'life' },
};
const PRIORITY = { leaving: 3, meeting: 2, email: 2, deadline: 2, watched: 1, brief: 1, activity: 1 };
const GAP_MS = 20 * MIN;
const DEADLINE_RE = /\b(deadline|due|launch|ship|release|submit|submission|demo|presentation|pitch|go live|hand ?in|exam)\b/i;
const ONLINE_RE = /^(https?:|www\.)|meet\.google|zoom\.us|teams\.microsoft|webex|online|virtual|google meet|zoom|teams call/i;

const triggerOn = (k, s) => (s && s.triggers && typeof s.triggers[k] === 'boolean' ? s.triggers[k] : !TRIGGERS[k].off);
const short = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const firstName = (p) => String(p || '').replace(/<.*>/, '').replace(/@.*/, '').trim().split(/\s+/)[0] || String(p || '');
const emailOf = (p) => ((/<([^>]+)>/.exec(String(p || '')) || [])[1] || (String(p || '').includes('@') ? String(p).trim() : '')).toLowerCase();
const localHour = (t, tz) => Number(L.clock(t, tz).slice(0, 2));

// ─── The triggers ───────────────────────────────────────────────────────────

function leaving({ snap, now }) {
  return snap.next.filter((e) => e.place && !ONLINE_RE.test(e.place) && !e.allDay && !e.live && e.at - now >= 5 * MIN && e.at - now <= 20 * MIN).map((e) => ({
    key: `leaving:${e.id}`, trigger: 'leaving', priority: PRIORITY.leaving, how: 'text',
    facts: [`"${e.title}" at ${e.place} starts ${L.until(e.at - now)} (${L.clock(e.at, snap.tz)})${e.people.length ? `, with ${e.people.slice(0, 3).map(firstName).join(', ')}` : ''}.`, 'Remind them to grab what they need (wallet, keys, phone, anything the plan needs) and to leave now if it is not close.'],
    fallback: `${short(e.title, 60)} at ${short(e.place, 40)} ${L.until(e.at - now)}. Got your wallet, keys and phone?`,
  }));
}

function meeting({ snap, store, now }) {
  return snap.next.filter((e) => e.source === 'calendar' && e.people.length && (!e.place || ONLINE_RE.test(e.place)) && !e.allDay && !e.live && e.at - now >= 2 * MIN && e.at - now <= 10 * MIN).map((e) => {
    const facts = [`"${e.title}" starts ${L.until(e.at - now)} with ${e.people.slice(0, 4).map(firstName).join(', ')}.`];
    for (const p of e.people.slice(0, 2)) {
      const email = emailOf(p);
      const last = email ? store.items({ sources: ['gmail'], text: email, limit: 1 })[0] : null;
      if (last) facts.push(`Last email with ${firstName(p)}: "${short(last.title, 80)}" (${L.ago(now - last.at)} ago).`);
    }
    return { key: `meeting:${e.id}`, trigger: 'meeting', priority: PRIORITY.meeting, how: 'text', facts, fallback: `${short(e.title, 60)} ${L.until(e.at - now)} with ${e.people.slice(0, 3).map(firstName).join(', ')}.` };
  });
}

function email({ store, now }) {
  const waiting = store.getState('gmail.waiting', []) || [];
  return waiting.filter((w) => now - w.at >= DAY && now - w.at < 7 * DAY).filter((w) => {
    const p = store.person(w.from);
    return w.important || (p && p.importance >= 5);
  }).map((w) => {
    const h = Math.round((now - w.at) / HOUR);
    return {
      key: `email:${w.threadId}`, trigger: 'email', priority: PRIORITY.email, how: 'text', url: w.url || '',
      facts: [`${w.fromName || w.from} <${w.from}> emailed "${w.subject}" ${h} hours ago and the user has not replied.`, 'Offer to draft the reply.'],
      fallback: `${w.fromName || w.from} has been waiting ${h} h for your reply to "${short(w.subject, 60)}". Want me to draft one?`,
    };
  });
}

function deadline({ store, snap, now }) {
  const tz = snap.tz;
  const h = localHour(now, tz);
  if (h < 10 || h >= 20) return [];
  const soon = store.items({ sources: ['calendar', 'plans'], from: now, to: now + 3 * DAY, limit: 60, order: 'asc' }).filter((x) => x.kind !== 'cancelled' && DEADLINE_RE.test(x.title));
  const out = [];
  for (const d of soon) {
    const words = d.title.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
    const projects = snap.projects.length ? snap.projects : [];
    const match = projects.find((p) => p.name.toLowerCase().split(/[^a-z0-9]+/).some((w) => w.length > 2 && words.includes(w))) || (projects.length === 1 ? projects[0] : null);
    if (!match) continue;
    const since = match.lastPush ? now - match.lastPush : Infinity;
    if (since < 3 * DAY) continue;
    const days = match.lastPush ? Math.floor(since / DAY) : null;
    out.push({
      key: `deadline:${d.id}:${L.dayKey(now, tz)}`, trigger: 'deadline', priority: PRIORITY.deadline, how: 'text',
      facts: [`"${d.title}" is ${L.when(d.at, now, tz)}.`, `Project ${match.name}: ${days == null ? 'never pushed' : `last push ${days} days ago`}${match.unpushed ? `, ${match.unpushed} commits waiting to be pushed` : ''}${match.dirty ? ', uncommitted changes' : ''}.`],
      fallback: `${short(d.title, 60)} is ${L.when(d.at, now, tz)}. You haven't pushed to ${match.name} ${days == null ? 'yet' : `in ${days} days`}.`,
    });
  }
  return out;
}

function watched({ store, now }) {
  return store.items({ sources: ['activity'], kinds: ['watch'], from: now - 30 * HOUR, limit: 20 })
    .filter((x) => (x.end || x.at) - x.at >= 10 * MIN && now - (x.end || x.at) >= 2 * HOUR)
    .slice(0, 1).map((x) => ({
      key: `watched:${x.id}`, trigger: 'watched', priority: PRIORITY.watched, how: 'text',
      facts: [`The user watched "${x.title}"${x.data.site ? ` on ${x.data.site}` : ''} for ${Math.round(((x.end || x.at) - x.at) / MIN)} minutes, ${L.ago(now - (x.end || x.at))} ago.`, 'Ask casually what came of it or whether there is anything to follow up on. One question.'],
      fallback: `So what happened with "${short(x.title, 70)}"? Anything worth following up on?`,
    }));
}

function brief({ store, snap, now, atPc }) {
  const tz = snap.tz;
  const h = localHour(now, tz);
  if (h < 7 || h >= 11) return [];
  if (!atPc && h < 9) return [];
  const start = L.startOfDay(now, tz);
  const today = store.items({ sources: ['calendar', 'plans'], from: start, to: start + DAY, limit: 20, order: 'asc' }).filter((x) => x.kind !== 'cancelled');
  const waiting = (store.getState('gmail.waiting', []) || []).length;
  const facts = [today.length ? `Today: ${today.map((x) => `${x.data && x.data.allDay ? 'all day' : L.clock(x.at, tz)} ${short(x.title, 50)}`).join('; ')}.` : 'Nothing on the calendar today.'];
  if (waiting) facts.push(`${waiting} email${waiting === 1 ? '' : 's'} waiting on a reply.`);
  return [{ key: `brief:${L.dayKey(now, tz)}`, trigger: 'brief', priority: PRIORITY.brief, how: 'text', facts, fallback: facts.join(' ') }];
}

function activity({ store, snap, now }) {
  const h = snap.health;
  const tz = snap.tz;
  const hour = localHour(now, tz);
  if (!h || hour < 9 || hour >= 21) return [];
  // At most one every 3 days, whatever the reason.
  if (store.nudgesSince(now - 3 * DAY, 200).some((n) => n.trigger === 'activity')) return [];
  const facts = [];
  let reason = '';
  const low = (v) => v != null && h.usualSteps && v < 0.45 * h.usualSteps;
  // The two latest days with data must both be low; today only counts once it is evening.
  const recent = [hour >= 17 && h.stepsToday != null ? ['so far today', h.stepsToday] : null, h.stepsYesterday != null ? ['yesterday', h.stepsYesterday] : null, h.stepsDayBefore != null ? ['the day before', h.stepsDayBefore] : null].filter(Boolean).slice(0, 2);
  if (h.usualSteps && h.stepDays >= 7 && recent.length === 2 && recent.every(([, v]) => low(v))) {
    reason = 'steps';
    facts.push(`Steps: ${recent.map(([when, v]) => `${v} ${when}`).join(', ')}; the user usually does about ${Math.round(h.usualSteps)} a day.`);
  } else if (h.workoutsBefore >= 3 && h.workoutsWeek === 0) {
    reason = 'workouts';
    facts.push(`No workouts in the last 7 days; the week before had ${h.workoutsBefore}.`);
  }
  if (!reason) return [];
  if (h.feelings.length) facts.push(`Lately they said: "${short(h.feelings[0].title, 80)}".`);
  facts.push('Ask gently, once, whether everything is okay. No lecture, no numbers unless they help, no medical advice; offer to move or lighten things on their calendar if that helps.');
  return [{
    key: `activity:${reason}:${L.dayKey(now, tz)}`, trigger: 'activity', priority: PRIORITY.activity, how: 'text', facts,
    fallback: reason === 'steps' ? 'You\'ve been moving a lot less than usual the last couple of days. Everything okay?' : 'No workouts this week, which isn\'t like you. All good?',
  }];
}

const GENERATORS = { leaving, meeting, email, deadline, watched, brief, activity };

// ─── The limits ─────────────────────────────────────────────────────────────

/**
 * What should go out now, best first. settings: the nudges settings
 * (on, perDay, quiet, triggers). Pure apart from reading the store.
 */
function due({ store, snap, settings = {}, now = Date.now(), atPc = false }) {
  if (!store || !snap) return [];
  const tz = snap.tz;
  const all = [];
  for (const [k, gen] of Object.entries(GENERATORS)) {
    if (!triggerOn(k, settings)) continue;
    try { all.push(...gen({ store, snap, now, atPc })); } catch {}
  }
  if (!all.length) return [];
  const today = store.nudgesSince(L.startOfDay(now, tz), 200);
  const perDay = Number.isFinite(Number(settings.perDay)) ? Number(settings.perDay) : 6;
  let left = perDay - today.length;
  let lastAt = today.length ? today[0].at : 0;
  const quiet = settings.quiet && MW.inQuietHours(settings.quiet, new Date(now));
  const busy = !!snap.onCall || snap.next.some((e) => e.live && e.source === 'calendar' && e.people.length && !e.allDay);
  const skipped = store.getState('nudge.skipped', {}) || {};
  const out = [];
  for (const c of all.sort((a, b) => b.priority - a.priority)) {
    const time = c.trigger === 'leaving';
    if (left <= 0) break;
    if ((quiet || busy) && !time) continue;
    if (!time && now - lastAt < GAP_MS) continue;
    if (skipped[c.key] && now - skipped[c.key] < 6 * HOUR) continue;
    const prev = store.lastNudgeFor(c.key);
    if (prev) {
      // Not now: once more, an hour later. Anything else: never twice.
      const again = prev.feedback === 'later' && now - (prev.feedbackAt || prev.at) >= HOUR && !store.getState(`nudge.again.${c.key}`);
      if (!again) continue;
      store.setState(`nudge.again.${c.key}`, now);
    }
    if (c.trigger === 'watched' && today.some((n) => n.trigger === 'watched')) continue;
    out.push(c);
    left--;
    // One at a time: the gap counts from this one too (leaving is time critical and never waits).
    if (!time) lastAt = now;
  }
  return out;
}

/** The judge said not now: leave it for 6 hours. */
function skip(store, c) {
  const s = store.getState('nudge.skipped', {}) || {};
  s[c.key] = Date.now();
  const keys = Object.keys(s);
  if (keys.length > 300) for (const k of keys.slice(0, keys.length - 300)) delete s[k];
  store.setState('nudge.skipped', s);
}
/** Not now: due() sends it once more an hour after the feedback. */
function later(store, nudge) { store.deleteState(`nudge.again.${nudge.key}`); }

// ─── Who says it ────────────────────────────────────────────────────────────

const DOMAIN_RE = {
  life: /\b(life|social|personal|friend|assistant|buddy|coach|health|wellbeing|planner|organi[sz]er|reminder)\b/i,
  work: /\b(work|code|coding|dev|developer|engineer|project|email|inbox|mail|ops|deploy|manager|chief of staff)\b/i,
};
/** The bot that speaks for this trigger: the user's pick, a bot that took it on, the best fit by job, the lead. */
function chooseBot(c, team, settings = {}) {
  const bots = (team || []).filter((b) => b && (!b.life || b.life.read !== false));
  if (!bots.length) return null;
  const picked = settings.botFor && settings.botFor[c.trigger];
  if (picked) { const b = bots.find((x) => x.id === picked); if (b) return b; }
  const taker = bots.find((b) => b.life && (b.life.speaksFor || []).includes(c.trigger));
  if (taker) return taker;
  const re = DOMAIN_RE[(TRIGGERS[c.trigger] || {}).domain];
  const fit = re && bots.find((b) => re.test(`${b.name} ${b.specialty || ''}`));
  if (fit) return fit;
  return bots.find((b) => b.role === 'orchestrator') || bots[0];
}

// ─── The judge ──────────────────────────────────────────────────────────────

function judgePrompt(cands, snap) {
  const toneOf = (b) => { try { return require('./bots.js').TONES[b.tone && b.tone.preset].text; } catch { return ''; } };
  const list = cands.map((c, i) => {
    const b = c.bot;
    const who = b ? `${b.name}${b.specialty ? ` (${short(b.specialty, 80)})` : ''}. Tone: ${toneOf(b)}${b.tone && b.tone.custom ? ` ${short(b.tone.custom, 120)}` : ''}` : 'Codeply, the user\'s assistant';
    return `${i + 1}. key=${c.key}\n   from: ${who}\n   ${c.facts.join('\n   ')}`;
  }).join('\n');
  return `You decide whether the user's bots reach out to the user right now, without being asked, and write what they say.

${L.nowBlock(snap)}

Candidates:
${list}

Rules:
- Send only what is useful to the user right now. Skip anything that would feel like nagging or that the situation above makes pointless.
- Each message is one or two short sentences in that bot's own voice, like a text from a friend who has the user's back. Plain words, no markdown, no long dash, no emoji unless the tone is playful.
- Never mention that you watch the screen or read their email, unless the message only makes sense with it (a follow-up on something they watched is fine).
- how is "text", or "call" only when it is urgent and time critical.

Respond with ONLY JSON: {"messages": [{"key": "<key>", "send": true, "how": "text", "text": "..."}]}`;
}

function parseJudge(json, cands) {
  const list = json && Array.isArray(json.messages) ? json.messages : null;
  if (!list) return null;
  const out = [];
  for (const c of cands) {
    const m = list.find((x) => x && x.key === c.key);
    if (!m) { out.push({ key: c.key, send: true, how: c.how || 'text', text: c.fallback }); continue; }
    const text = String(m.text || '').replace(/\s*\u2014\s*/g, ', ').replace(/\s+/g, ' ').trim().slice(0, 480);
    out.push({ key: c.key, send: m.send !== false && !!(text || c.fallback), how: m.how === 'call' ? 'call' : 'text', text: text || c.fallback });
  }
  return out;
}

module.exports = { TRIGGERS, GENERATORS, triggerOn, due, skip, later, chooseBot, judgePrompt, parseJudge, DEADLINE_RE };
