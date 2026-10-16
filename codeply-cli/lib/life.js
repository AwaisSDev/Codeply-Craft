/**
 * The Active Context Engine: one picture of the user's life that every bot
 * reads from (the store is lib/life-store.js, the sources lib/life-sources.js).
 *
 *   snapshot()     what matters right now: the time, what is on screen, the
 *                  next events and plans, who is waiting on a reply, recent
 *                  calls, projects that have gone quiet, what was watched.
 *   nowBlock()     the snapshot as a short block for a bot's prompt.
 *   contextTool()  the life_context tool: now, today, week, person, search,
 *                  calls, email, activity, plans.
 *   notePlans()    plans the bots heard about in chats, calls and email.
 *
 * Bots see only the sources their settings allow (bot.life, normalized in
 * bots.js). Sensitive things (call transcripts) need life.sensitive on top.
 *
 * The host (Craft's life-desktop.js) opens the store and attaches it here.
 * With nothing attached (the plain CLI) the tool is not offered.
 */

const DAY = 86400000;
const HOUR = 3600000;

/** Everything the engine can know, and how the Life panel names it. */
const SOURCES = {
  calendar: { label: 'Google Calendar', note: 'Your events, who is in them and where.' },
  gmail: { label: 'Gmail, sent and received', note: 'Who wrote, what about, and who is still waiting on your reply. Headers and the preview line only.' },
  calls: { label: 'Calls', note: 'Calls with your bots and calls the call helper heard on this PC, with a short summary.', sensitive: true },
  projects: { label: 'Craft projects', note: 'What you are building, and when you last pushed.' },
  activity: { label: 'What is on your screen', note: 'The app and window title in front, every 30 seconds. No screenshots. Private windows and password managers are skipped.' },
  orbit: { label: 'Orbit and the drop', note: 'What you asked them.' },
  plans: { label: 'Plans', note: 'Plans your bots heard about in chats, calls and email.' },
  botmail: { label: "Your bots' email", note: 'Mail to and from your bots\' own addresses.' },
  slack: { label: 'Slack', note: 'Direct messages and mentions.' },
  tasks: { label: 'Bot tasks', note: 'Work your bots took on by themselves.' },
};
const SOURCE_KEYS = Object.keys(SOURCES);

let store = null;
// enabled: () => Set of the sources the user has on (null = all).
let hostOpts = { tz: '', userName: '', onChange: null, enabled: null };

function attach(s, opts = {}) { store = s || null; hostOpts = { ...hostOpts, ...opts }; }
function detach() { store = null; }
function available() { return !!store; }
function getStore() { return store; }

// ─── Bot access ─────────────────────────────────────────────────────────────

function normalizeLife(l) {
  l = l && typeof l === 'object' ? l : {};
  const sources = Array.isArray(l.sources) ? l.sources.filter((k) => SOURCES[k]) : null;
  return {
    read: l.read !== false,
    sensitive: !!l.sensitive,
    // null = every source; a list = only these.
    sources: sources && sources.length ? [...new Set(sources)] : null,
    // Trigger kinds this bot speaks for (life-triggers.js), e.g. ['leaving', 'email'].
    speaksFor: (Array.isArray(l.speaksFor) ? l.speaksFor : []).filter((k) => typeof k === 'string').slice(0, 20),
  };
}

/** The sources this bot may read, as a Set (empty when it reads nothing). Sources the user switched off never count. */
function allowedFor(bot) {
  const on = typeof hostOpts.enabled === 'function' ? hostOpts.enabled() : null;
  const keep = (k) => !on || on.has(k);
  if (!bot) return new Set(SOURCE_KEYS.filter((k) => !SOURCES[k].sensitive && keep(k)));
  const l = normalizeLife(bot.life);
  if (!l.read) return new Set();
  const base = l.sources || SOURCE_KEYS;
  return new Set(base.filter((k) => (!SOURCES[k].sensitive || l.sensitive) && keep(k)));
}

// ─── Time helpers ───────────────────────────────────────────────────────────

const tzOf = (o) => (o && o.tz) || hostOpts.tz || (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; } })();
function fmt(t, tz, opts) {
  try { return new Intl.DateTimeFormat('en-GB', { timeZone: tz, ...opts }).format(new Date(t)); } catch { return new Date(t).toISOString(); }
}
const clock = (t, tz) => fmt(t, tz, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const dayKey = (t, tz) => fmt(t, tz, { year: 'numeric', month: '2-digit', day: '2-digit' });
function when(t, now, tz) {
  if (dayKey(t, tz) === dayKey(now, tz)) return clock(t, tz);
  if (dayKey(t, tz) === dayKey(now + DAY, tz)) return `tomorrow ${clock(t, tz)}`;
  if (dayKey(t, tz) === dayKey(now - DAY, tz)) return `yesterday ${clock(t, tz)}`;
  return fmt(t, tz, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}
function ago(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${Math.max(1, m)} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} days`;
}
function until(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `in ${Math.max(0, m)} min`;
  const h = Math.floor(m / 60);
  return `in ${h} h${m % 60 ? ` ${m % 60} min` : ''}`;
}
/** Start of the user's local day around t (close enough for windows of a day). */
function startOfDay(t, tz) {
  const off = (() => {
    try {
      const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
      return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - Math.floor(t / 1000) * 1000;
    } catch { return 0; }
  })();
  const local = t + off;
  return local - (local % DAY) - off;
}

const short = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const firstName = (p) => String(p || '').replace(/<.*>/, '').replace(/@.*/, '').trim().split(/\s+/)[0] || String(p || '');

// ─── The snapshot ───────────────────────────────────────────────────────────

/**
 * What matters right now, limited to the sources in `allowed` (a Set, or null for all).
 * Plain data: the prompt block, the Life panel and the trigger engine all read it.
 */
function snapshot(o = {}) {
  const s = o.store || store;
  const now = o.now || Date.now();
  const tz = tzOf(o);
  const allowed = o.allowed || null;
  const can = (k) => !allowed || allowed.has(k);
  const snap = { at: now, tz, local: fmt(now, tz, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }), doing: null, onCall: null, next: [], waiting: [], calls: [], projects: [], watched: [], plans: [], tasks: [], unread: [] };
  if (!s) return snap;

  if (can('activity')) {
    const cur = s.getState('activity.current');
    if (cur && now - (cur.seenAt || 0) < 3 * 60000) snap.doing = { app: cur.app, title: cur.title, kind: cur.kind || 'app', since: cur.since || cur.seenAt, minutes: Math.round((now - (cur.since || now)) / 60000) };
    snap.watched = s.items({ sources: ['activity'], kinds: ['watch'], from: now - DAY, limit: 5 })
      .filter((x) => (x.end || x.at) - x.at >= 3 * 60000)
      .map((x) => ({ title: x.title, at: x.at, minutes: Math.round(((x.end || x.at) - x.at) / 60000), url: x.url }));
  }
  const call = s.getState('call.current');
  if (call && now - (call.seenAt || 0) < 2 * 60000) snap.onCall = { app: call.app || '', since: call.since || call.seenAt, with: call.with || '' };

  if (can('calendar') || can('plans')) {
    const srcs = [can('calendar') && 'calendar', can('plans') && 'plans'].filter(Boolean);
    const upcoming = s.items({ sources: srcs, from: now - 15 * 60000, to: now + 36 * HOUR, limit: 30, order: 'asc' })
      .filter((x) => x.kind !== 'cancelled' && !(x.data && x.data.untimed) && (x.end || x.at + HOUR) > now && !(x.data && x.data.allDay && x.at < now));
    snap.next = upcoming.slice(0, 6).map((x) => ({ id: x.id, title: x.title, at: x.at, end: x.end, place: x.place, people: x.people, source: x.source, allDay: !!(x.data && x.data.allDay), live: x.at <= now }));
  }
  if (can('plans')) {
    snap.plans = s.items({ sources: ['plans'], from: now - HOUR, limit: 40, order: 'asc' })
      .filter((x) => !x.data.done).slice(0, 6).map((x) => ({ id: x.id, title: x.title, at: x.at, place: x.place, people: x.people, timed: !x.data.untimed }));
  }
  if (can('gmail')) {
    snap.waiting = (s.getState('gmail.waiting') || []).filter((w) => now - w.at >= 4 * HOUR).slice(0, 5)
      .map((w) => ({ from: w.fromName || w.from, email: w.from, subject: w.subject, at: w.at, hours: Math.round((now - w.at) / HOUR), threadId: w.threadId, important: !!w.important, url: w.url }));
  }
  if (can('calls') || can('botmail') || can('slack')) {
    // Calls are sensitive: a bot without that access does not get here (allowedFor).
    if (can('calls')) {
      snap.calls = s.items({ sources: ['calls'], from: now - 2 * DAY, limit: 3 })
        .map((x) => ({ title: x.title, at: x.at, summary: short(x.data.summary || '', 240), people: x.people }));
    }
    const unread = [];
    if (can('botmail')) for (const x of s.items({ sources: ['botmail'], kinds: ['mail_in'], from: now - 2 * DAY, limit: 5 })) if (!x.data.handled) unread.push({ via: 'email', title: x.title, from: x.people[0] || '', at: x.at });
    if (can('slack')) for (const x of s.items({ sources: ['slack'], kinds: ['dm', 'mention'], from: now - DAY, limit: 5 })) if (!x.data.handled) unread.push({ via: 'slack', title: x.title, from: x.people[0] || '', at: x.at });
    snap.unread = unread.slice(0, 5);
  }
  if (can('projects')) {
    snap.projects = s.items({ sources: ['projects'], kinds: ['project'], limit: 30 })
      .filter((x) => now - (x.data.lastActive || x.at) < 14 * DAY)
      .sort((a, b) => (b.data.lastActive || b.at) - (a.data.lastActive || a.at)).slice(0, 4)
      .map((x) => ({ name: x.title, path: x.data.path || '', lastActive: x.data.lastActive || x.at, lastPush: x.data.lastPush || null, unpushed: x.data.unpushed || 0, dirty: !!x.data.dirty, deadline: x.data.deadline || null }));
  }
  if (can('tasks')) {
    snap.tasks = s.recentTasks(10).filter((t) => ['queued', 'running', 'needs_you', 'verifying'].includes(t.status)).slice(0, 4)
      .map((t) => ({ id: t.id, text: short(t.text, 120), status: t.status, botId: t.botId }));
  }
  return snap;
}

/** The snapshot as a short block for a bot's system prompt. Empty when there is nothing to say. */
function nowBlock(snap, o = {}) {
  if (!snap) return '';
  const now = snap.at; const tz = snap.tz;
  const lines = [`- ${snap.local} (${tz})`];
  if (snap.onCall) lines.push(`- The user is on a call right now${snap.onCall.app ? ` (${snap.onCall.app})` : ''}.`);
  if (snap.doing) lines.push(`- On screen: ${snap.doing.app}${snap.doing.title ? `, "${short(snap.doing.title, 90)}"` : ''}${snap.doing.minutes >= 2 ? ` (${snap.doing.minutes} min)` : ''}`);
  if (snap.next.length) {
    lines.push(`- Coming up: ${snap.next.slice(0, 4).map((e) => `${e.allDay ? 'all day' : e.live ? 'now' : when(e.at, now, tz)} ${short(e.title, 60)}${e.place ? ` at ${short(e.place, 40)}` : ''}${e.people.length ? ` with ${e.people.slice(0, 3).map(firstName).join(', ')}` : ''}${!e.allDay && !e.live && e.at - now < 3 * HOUR ? ` (${until(e.at - now)})` : ''}`).join('; ')}`);
  }
  const loosePlans = snap.plans.filter((p) => !snap.next.some((e) => e.id === p.id));
  if (loosePlans.length) lines.push(`- Plans: ${loosePlans.slice(0, 3).map((p) => `${short(p.title, 60)}${p.timed ? ` (${when(p.at, now, tz)})` : ''}`).join('; ')}`);
  if (snap.waiting.length) lines.push(`- Waiting on the user's reply: ${snap.waiting.slice(0, 3).map((w) => `${w.from}, "${short(w.subject, 50)}" (${w.hours} h)`).join('; ')}`);
  if (snap.unread.length) lines.push(`- New for the bots: ${snap.unread.slice(0, 3).map((u) => `${u.via} from ${u.from || 'someone'}: "${short(u.title, 50)}"`).join('; ')}`);
  if (snap.calls.length) lines.push(`- Recent calls: ${snap.calls.slice(0, 2).map((c) => `${short(c.title, 50)} ${when(c.at, now, tz)}${c.summary ? `: ${short(c.summary, 120)}` : ''}`).join('; ')}`);
  if (snap.projects.length) {
    lines.push(`- Projects: ${snap.projects.slice(0, 3).map((p) => `${p.name}${p.lastPush ? `, last push ${ago(now - p.lastPush)} ago` : ''}${p.unpushed ? `, ${p.unpushed} commit${p.unpushed === 1 ? '' : 's'} not pushed` : ''}${p.dirty ? ', uncommitted changes' : ''}`).join('; ')}`);
  }
  if (snap.watched.length) lines.push(`- Watched lately: ${snap.watched.slice(0, 2).map((w) => `"${short(w.title, 60)}"`).join('; ')}`);
  if (snap.tasks.length) lines.push(`- Bot tasks in progress: ${snap.tasks.slice(0, 3).map((t) => `${short(t.text, 60)} (${t.status.replace('_', ' ')})`).join('; ')}`);
  if (lines.length === 1 && o.skipEmpty) return '';
  return `RIGHT NOW (the user's life context, shared by all their bots)
${lines.join('\n')}
Use this when it helps: plan around the user's time, mention a clash, link what they ask to what is going on. Do not recite it back, and do not bring up what is on their screen unless it is relevant or they ask. For more, use life_context.`;
}

// ─── The life_context tool ──────────────────────────────────────────────────

const ABOUT = {
  now: 'now', current: 'now', snapshot: 'now', today: 'today', day: 'today', tomorrow: 'tomorrow', week: 'week', upcoming: 'week',
  person: 'person', people: 'person', who: 'person', contact: 'person', search: 'search', find: 'search',
  calls: 'calls', call: 'calls', email: 'email', mail: 'email', inbox: 'email', activity: 'activity', screen: 'activity', watched: 'activity',
  plans: 'plans', plan: 'plans', projects: 'projects', project: 'projects', slack: 'slack', tasks: 'tasks',
};

function itemLine(x, now, tz) {
  const t = x.end && x.end - x.at > 30 * 60000 && x.source !== 'activity' ? `${when(x.at, now, tz)} to ${clock(x.end, tz)}` : when(x.at, now, tz);
  const who = x.people && x.people.length ? ` [${x.people.slice(0, 4).join(', ')}]` : '';
  const extra = x.data && (x.data.summary || x.data.snippet) ? `: ${short(x.data.summary || x.data.snippet, 220)}` : x.body && !x.sensitive ? `: ${short(x.body, 220)}` : '';
  return `- ${t} · ${x.source}/${x.kind} · ${short(x.title, 120)}${x.place ? ` @ ${short(x.place, 60)}` : ''}${who}${extra}`;
}

async function contextTool(args, ctx = {}) {
  if (!store) return { ok: false, output: 'The life context is only available in the Craft app.' };
  const bot = ctx.bot || null;
  const allowed = ctx.allowed || allowedFor(bot);
  if (!allowed.size) return { ok: false, output: 'This bot is not allowed to read the user\'s life context. The user can turn it on in Crew, Life.' };
  const about = ABOUT[String(args.about || 'now').trim().toLowerCase()] || 'search';
  const query = String(args.query || args.about || '').trim();
  const now = ctx.now || Date.now();
  const tz = tzOf(ctx);
  const srcs = [...allowed];
  const lines = (list) => (list.length ? list.map((x) => itemLine(x, now, tz)).join('\n') : '(nothing)');
  const pick = (want) => want.filter((k) => allowed.has(k));
  let out = '';
  if (about === 'now') out = nowBlock(snapshot({ now, tz, allowed })) || 'Nothing known right now.';
  else if (about === 'today' || about === 'tomorrow') {
    const start = startOfDay(now, tz) + (about === 'tomorrow' ? DAY : 0);
    out = `${about === 'today' ? 'Today' : 'Tomorrow'}:\n${lines(store.items({ sources: pick(['calendar', 'plans', 'calls', 'gmail', 'botmail', 'slack', 'tasks']), from: start, to: start + DAY, limit: 60, order: 'asc' }).filter((x) => x.kind !== 'cancelled'))}`;
  } else if (about === 'week') out = `The next 7 days:\n${lines(store.items({ sources: pick(['calendar', 'plans']), from: now, to: now + 7 * DAY, limit: 60, order: 'asc' }).filter((x) => x.kind !== 'cancelled'))}`;
  else if (about === 'person') {
    if (!query) return { ok: false, output: 'life_context about=person needs <query>: a name or an email address.' };
    const people = store.findPeople(query, 3);
    const hits = store.search(query, { limit: 15, sources: srcs });
    out = `${people.length ? people.map((p) => `${p.name || p.emails[0]} <${p.emails.join(', ')}>, importance ${p.importance}/10${p.lastFrom ? `, last wrote ${ago(now - p.lastFrom)} ago` : ''}${p.lastTo ? `, you last wrote ${ago(now - p.lastTo)} ago` : ''}${p.note ? `. ${p.note}` : ''}`).join('\n') : `No contact card for "${query}".`}\nRecent:\n${lines(hits)}`;
  } else if (about === 'calls') {
    if (!allowed.has('calls')) return { ok: false, output: 'This bot is not allowed to read calls. The user can allow it in the bot\'s Life settings.' };
    out = `Recent calls:\n${lines(store.items({ sources: ['calls'], from: now - 14 * DAY, limit: 10 }))}`;
  } else if (about === 'email') {
    const waiting = (store.getState('gmail.waiting') || []).slice(0, 8);
    out = `${waiting.length ? `Waiting on the user's reply:\n${waiting.map((w) => `- ${w.fromName || w.from} <${w.from}>: "${short(w.subject, 80)}", ${ago(now - w.at)} ago${w.important ? ' (important)' : ''}`).join('\n')}\n` : ''}Recent email:\n${lines(store.items({ sources: pick(['gmail', 'botmail']), from: now - 3 * DAY, limit: 15 }))}`;
  } else if (about === 'activity') out = `On screen, the last few hours:\n${lines(store.items({ sources: pick(['activity', 'orbit']), from: now - 6 * HOUR, limit: 25 }))}`;
  else if (about === 'plans') out = `Plans:\n${lines(store.items({ sources: pick(['plans']), from: now - DAY, limit: 20, order: 'asc' }))}`;
  else if (about === 'projects') out = `Projects:\n${lines(store.items({ sources: pick(['projects']), limit: 10 }))}`;
  else if (about === 'slack') out = `Slack:\n${lines(store.items({ sources: pick(['slack']), from: now - 3 * DAY, limit: 20 }))}`;
  else if (about === 'tasks') out = `Bot tasks:\n${store.recentTasks(10).map((t) => `- ${t.status}: ${short(t.text, 140)}`).join('\n') || '(nothing)'}`;
  else {
    if (!query) return { ok: false, output: 'life_context needs <about> (now, today, tomorrow, week, person, calls, email, activity, plans, projects, slack, tasks) or <query> to search.' };
    out = `Search "${query}":\n${lines(store.search(query, { limit: 15, sources: srcs }))}`;
  }
  return { ok: true, output: out.slice(0, 8000), meta: { label: `${about}${query && about !== 'now' ? `: ${short(query, 40)}` : ''}` } };
}

// ─── Plans ──────────────────────────────────────────────────────────────────

/** "2026-10-17T20:00" in the user's zone to epoch ms (or NaN). */
function localIso(s, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(String(s || '').trim());
  if (!m) { const d = Date.parse(s); return Number.isNaN(d) ? NaN : d; }
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 12), +(m[5] || 0));
  const off = (t) => {
    try {
      const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
      return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute) - Math.floor(t / 60000) * 60000;
    } catch { return 0; }
  };
  return guess - off(guess - off(guess));
}

/**
 * Plans the bots heard about: [{ what, when, where, who }] from learnFromTurn
 * or a call summary. A plan without a time is kept for a week as "untimed".
 */
function notePlans(plans, o = {}) {
  if (!store || !Array.isArray(plans)) return [];
  const tz = tzOf(o);
  const now = o.now || Date.now();
  const out = [];
  for (const p of plans.slice(0, 5)) {
    const what = short(p && p.what, 140);
    if (!what || what.length < 3) continue;
    let at = p.when ? localIso(p.when, tz) : NaN;
    const untimed = !Number.isFinite(at);
    if (untimed) at = now;
    if (!untimed && at < now - DAY) continue;
    const key = what.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 60);
    const id = `plans:${dayKey(at, tz)}:${key}`;
    const who = (Array.isArray(p.who) ? p.who : p.who ? [p.who] : []).map((x) => short(x, 60)).filter(Boolean).slice(0, 6);
    out.push(store.upsertItem({ id, source: 'plans', kind: 'plan', at, end: untimed ? now + 7 * DAY : null, title: what, place: short(p.where, 120), people: who, data: { untimed, from: o.source || 'chat', botId: o.botId || null } }));
  }
  if (out.length && hostOpts.onChange) { try { hostOpts.onChange('plans'); } catch {} }
  return out;
}

/** The part of learnFromTurn's prompt that asks for plans (bots.js). */
function plansAsk(now = Date.now(), tz = tzOf()) {
  return `Also list plans or commitments with a time or a place that the user mentioned (meeting someone, an appointment, a trip, a deadline): {"what": "Dinner with Ali", "when": "YYYY-MM-DDTHH:MM in the user's local time, or empty", "where": "", "who": ["Ali"]}. It is ${fmt(now, tz, { weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })} for the user now (${tz}). Most exchanges have none: use an empty list.`;
}

/** Something happened that the bots should know (a call ended, an Orbit question): one store write. */
function note(item) {
  if (!store || !item) return null;
  try { const r = store.upsertItem(item); if (hostOpts.onChange) hostOpts.onChange(item.source); return r; } catch { return null; }
}

module.exports = {
  SOURCES, SOURCE_KEYS, attach, detach, available, getStore,
  normalizeLife, allowedFor, snapshot, nowBlock, contextTool, notePlans, plansAsk, note,
  // for tests and the trigger engine
  when, ago, until, clock, dayKey, startOfDay, localIso, tzOf,
};
