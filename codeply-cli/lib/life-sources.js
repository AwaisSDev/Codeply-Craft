/**
 * Sources for the life context (lib/life.js): each turns one part of the
 * user's day into life items. Nothing here talks to a model, a window or the
 * network directly: the host passes the API calls in, so every source runs
 * against fakes in scripts/life-test.mjs.
 *
 *   calendar   Google Calendar, the next 7 days and the last day.
 *   gmail      Mail in and out (headers and the preview line), who matters,
 *              and the threads where someone is waiting on the user.
 *   projects   Craft's project folders: last push, commits not pushed.
 *   activity   The window in front, every 30 s: episodes like "watched X on
 *              YouTube for 12 min", or "on a Zoom call". Private windows,
 *              password managers and banks are never recorded.
 *   calls      A finished call: transcript (sealed) and a short summary.
 *   orbit      What the user asked Orbit or the drop.
 */
const path = require('path');
const MW = require('./mail-watch.js');

const DAY = 86400000;
const HOUR = 3600000;
const short = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const lower = (s) => String(s || '').trim().toLowerCase();

// ─── Calendar ───────────────────────────────────────────────────────────────

/** A Calendar API event as a life item (null for one that should not be kept). */
function calendarItem(ev, { localIso, tz }) {
  if (!ev || !ev.id) return null;
  const allDay = !!(ev.start && ev.start.date && !ev.start.dateTime);
  const startOf = (x) => (x && x.dateTime ? Date.parse(x.dateTime) : x && x.date ? localIso(`${x.date}T00:00`, tz) : NaN);
  const at = startOf(ev.start);
  if (!Number.isFinite(at)) return null;
  let end = startOf(ev.end);
  if (!Number.isFinite(end)) end = at + HOUR;
  const people = (ev.attendees || []).filter((a) => a && !a.self && !a.resource && a.email && a.responseStatus !== 'declined')
    .map((a) => (a.displayName ? `${a.displayName} <${lower(a.email)}>` : lower(a.email))).slice(0, 20);
  const meet = ev.hangoutLink || ((ev.conferenceData && ev.conferenceData.entryPoints) || []).map((e) => e.uri).find((u) => /^https:/.test(String(u || ''))) || '';
  const declined = (ev.attendees || []).some((a) => a && a.self && a.responseStatus === 'declined');
  return {
    id: `calendar:${ev.id}`, source: 'calendar', kind: ev.status === 'cancelled' || declined ? 'cancelled' : 'event', at, end,
    title: short(ev.summary || '(no title)', 300), place: short(ev.location, 300), people, url: /^https:\/\/www\.google\.com\/calendar/.test(String(ev.htmlLink || '')) ? ev.htmlLink : '',
    data: { allDay, meet, organizer: ev.organizer && ev.organizer.email ? lower(ev.organizer.email) : '', note: short(ev.description, 400), busy: ev.transparency !== 'transparent' },
  };
}

/**
 * Upserts the window [now - 1 day, now + 7 days] and drops events that are
 * gone from it. list({ timeMin, timeMax, maxResults }) is calendarListEvents with a token.
 */
async function syncCalendar({ store, list, now = Date.now(), life }) {
  const timeMin = new Date(now - DAY).toISOString();
  const timeMax = new Date(now + 7 * DAY).toISOString();
  const events = await list({ timeMin, timeMax, maxResults: 100 });
  const seen = new Set();
  let n = 0;
  for (const ev of events) {
    const it = calendarItem(ev, { localIso: life.localIso, tz: life.tzOf() });
    if (!it) continue;
    seen.add(it.id);
    store.upsertItem(it);
    n++;
    for (const p of it.people) {
      const m = /^(.*?)\s*<([^>]+)>$/.exec(p);
      store.notePerson(m ? { name: m[1], email: m[2] } : { email: p });
    }
  }
  // Deleted events no longer come back from the API: forget the ones in the window we did not see.
  for (const it of store.items({ sources: ['calendar'], from: now - DAY, to: now + 7 * DAY, limit: 500 })) {
    if (!seen.has(it.id) && it.at >= now - DAY) store.deleteItem(it.id);
  }
  store.setState('calendar.lastSync', now);
  return { events: n };
}

// ─── Gmail ──────────────────────────────────────────────────────────────────

const SKIP_LABELS = ['SPAM', 'TRASH', 'DRAFT', 'CHAT'];
const NOISE_LABELS = ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_FORUMS'];
/** Mail nobody expects an answer to: a no-reply sender anywhere in the address, or a sign-in, code or receipt. */
function automated(fromEmail, subject) {
  const local = String(fromEmail || '').toLowerCase().split('@')[0];
  if (/(^|[._+-])(no-?reply|do-?not-?reply|notifications?|mailer-daemon|postmaster)([._+-]|$)|^noreply|^donotreply/.test(local)) return true;
  return /\b(sign[- ]?in (link|code)|log[- ]?in (link|code)|verification code|verify your (email|account)|one[- ]time (code|password)|security code|password reset|reset your password|your (receipt|invoice) from)\b/i.test(String(subject || ''));
}
const MAX_WAITING = 30;

function gmailUrl(account, threadId) {
  return threadId ? `https://mail.google.com/mail/?authuser=${encodeURIComponent(account || '')}#all/${encodeURIComponent(threadId)}` : '';
}

/**
 * Reads the mail added since the last poll (both directions). First run: the
 * last 3 days, so the bots start with something. api is mail-watch.js gmailApi.
 */
async function syncGmail({ store, api, now = Date.now(), maxNew = 40 }) {
  let account = store.getState('gmail.account', '');
  let cursor = store.getState('gmail.cursor', '');
  let ids = [];
  const primed = !cursor || !account;
  if (primed) {
    const p = await api.profile();
    const was = account;
    account = lower(p.emailAddress);
    if (was && was !== account) { store.removeSource('gmail'); store.setState('gmail.waiting', []); }
    cursor = String(p.historyId || '');
    ids = await api.list('newer_than:3d -in:chats -in:spam -in:trash', maxNew);
  } else {
    try {
      const h = await api.history(cursor, null);
      ids = h.ids; cursor = h.historyId || cursor;
    } catch (e) {
      if (e.status !== 404) throw e;
      const since = Math.floor((store.getState('gmail.lastSync', now - HOUR)) / 1000) - 60;
      ids = await api.list(`after:${since} -in:chats`, maxNew);
      cursor = String((await api.profile()).historyId || cursor);
    }
  }
  const seen = new Set(store.getState('gmail.seen', []));
  const fresh = [...new Set(ids)].filter((id) => !seen.has(id)).slice(-maxNew);
  const msgs = [];
  for (const id of fresh) {
    seen.add(id);
    try { msgs.push(MW.parseMessage(await api.meta(id))); } catch (e) { if (e.status !== 404) throw e; }
  }
  // Oldest first, so a reply after a message clears the wait it started.
  msgs.sort((a, b) => a.internalDate - b.internalDate);
  let waiting = (store.getState('gmail.waiting', []) || []).filter((w) => now - w.at < 7 * DAY && !automated(w.from, w.subject));
  const counts = { in: 0, out: 0 };
  for (const m of msgs) {
    if (m.labels.some((l) => SKIP_LABELS.includes(l))) continue;
    const at = m.internalDate || now;
    if (m.labels.includes('SENT') || lower(m.fromEmail) === account) {
      counts.out++;
      const to = [...m.to, ...m.cc].filter((a) => a !== account);
      for (const a of to) store.notePerson({ email: a, lastTo: at });
      waiting = waiting.filter((w) => w.threadId !== m.threadId);
      store.upsertItem({ id: `gmail:${m.id}`, source: 'gmail', kind: 'email_out', at, title: short(m.subject || '(no subject)', 300), people: to.slice(0, 10), url: gmailUrl(account, m.threadId), data: { threadId: m.threadId, snippet: short(m.snippet, 300) } });
      continue;
    }
    if (!m.labels.includes('INBOX')) continue;
    const bulk = m.labels.some((l) => NOISE_LABELS.includes(l)) || !!m.listUnsubscribe || !!m.listId || /^(bulk|list|junk)$/i.test(String(m.precedence).trim());
    if (bulk) continue;
    counts.in++;
    const known = store.person(m.fromEmail);
    const knownSender = !!(known && known.lastTo);
    const s = MW.scoreMessage(m, { me: account, knownSender, rules: null });
    const importance = Math.max(known ? known.importance : 0, Math.max(0, Math.min(10, s.score)));
    store.notePerson({ email: m.fromEmail, name: m.fromName, lastFrom: at, importance });
    store.upsertItem({ id: `gmail:${m.id}`, source: 'gmail', kind: 'email_in', at, title: short(m.subject || '(no subject)', 300), people: [m.fromName && m.fromName !== m.fromEmail ? `${m.fromName} <${m.fromEmail}>` : m.fromEmail], url: gmailUrl(account, m.threadId), data: { threadId: m.threadId, snippet: short(m.snippet, 300), level: s.level, score: s.score } });
    // Someone is waiting on the user: a real person, to them directly, not a no-reply.
    const direct = (m.to || []).includes(account) || (m.cc || []).includes(account);
    // Already answered: the user wrote to them after this came in (seen through gmail_send before this sync).
    const answered = !!(known && known.lastTo && known.lastTo >= at);
    if (s.level !== 'low' && direct && !answered && !automated(m.fromEmail, m.subject)) {
      waiting = waiting.filter((w) => w.threadId !== m.threadId);
      waiting.push({ threadId: m.threadId, id: m.id, from: m.fromEmail, fromName: m.fromName, subject: short(m.subject, 200), at, important: s.level === 'very' || knownSender, url: gmailUrl(account, m.threadId) });
    }
  }
  waiting = waiting.sort((a, b) => a.at - b.at).slice(-MAX_WAITING);
  store.setState('gmail.waiting', waiting);
  store.setState('gmail.seen', [...seen].slice(-1500));
  store.setState('gmail.account', account);
  store.setState('gmail.cursor', cursor);
  store.setState('gmail.lastSync', now);
  return { primed, ...counts, waiting: waiting.length };
}

// ─── Projects ───────────────────────────────────────────────────────────────

/**
 * projects: [{ path, name?, lastActive? }] (Craft's recent projects and chats).
 * git(cwd, args) resolves to stdout or rejects; it is never given a shell.
 */
async function syncProjects({ store, projects, git, now = Date.now() }) {
  let n = 0;
  const keep = new Set();
  for (const p of (projects || []).slice(0, 25)) {
    if (!p || !p.path) continue;
    const key = path.resolve(p.path).replace(/\\/g, '/').toLowerCase();
    const id = `projects:${key}`;
    keep.add(id);
    const prev = store.getItem(id);
    const data = { path: p.path, lastActive: Math.max(Number(p.lastActive) || 0, (prev && prev.data.lastActive) || 0) || now, deadline: (prev && prev.data.deadline) || null };
    try {
      const inside = (await git(p.path, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true';
      if (inside) {
        data.git = true;
        data.branch = (await git(p.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
        data.lastCommit = Number((await git(p.path, ['log', '-1', '--format=%ct']).catch(() => '0')).trim()) * 1000 || null;
        data.dirty = (await git(p.path, ['status', '--porcelain', '--untracked-files=no']).catch(() => '')).trim().split('\n').filter(Boolean).length;
        const upstream = await git(p.path, ['log', '-1', '--format=%ct', '@{u}']).catch(() => '');
        if (upstream.trim()) {
          data.lastPush = Number(upstream.trim()) * 1000 || null;
          data.unpushed = Number((await git(p.path, ['rev-list', '--count', '@{u}..HEAD']).catch(() => '0')).trim()) || 0;
        } else { data.lastPush = null; data.unpushed = 0; data.noUpstream = true; }
      }
    } catch { data.git = false; }
    store.upsertItem({ id, source: 'projects', kind: 'project', at: data.lastActive, title: short(p.name || path.basename(p.path), 120), data });
    n++;
  }
  // A project that left Craft's list (removed, or a folder that never was one) leaves Life too.
  if (keep.size) for (const it of store.items({ sources: ['projects'], limit: 500 })) if (!keep.has(it.id)) store.deleteItem(it.id);
  store.setState('projects.lastSync', now);
  return { projects: n };
}

// ─── Activity (the window in front) ─────────────────────────────────────────

const PRIVATE_APPS = /^(1password|bitwarden|keepass(xc)?|lastpass|dashlane|enpass|nordpass|proton ?pass|keeper|credentialuibroker|consent|lockapp|logonui)$/i;
const PRIVATE_TITLE = /\b(inprivate|incognito|private browsing|private window)\b|\b(online banking|net ?banking|internet banking)\b|\bbank\b.*\b(log ?in|sign ?in|account)\b|\bpassword manager\b/i;
const BROWSERS = /^(chrome|msedge|firefox|brave|opera|vivaldi|arc|safari|zen|thorium|yandex)$/i;
const BROWSER_SUFFIX = /\s+[-\u2013]\s+(google chrome|microsoft\u200b? edge|mozilla firefox|firefox|brave|opera|vivaldi|arc|zen browser)\s*$/i;
const CODE_APPS = /^(code|code - insiders|cursor|windsurf|devenv|idea64|pycharm64|webstorm64|rider64|studio64|sublime_text|notepad\+\+|zed|codeply craft|electron)$/i;
const CALL_RULES = [
  { app: /^zoom$/i, title: /zoom (meeting|webinar)|meeting/i, label: 'Zoom' },
  { app: /^(ms-teams|teams)$/i, title: /\b(meeting|call)\b/i, label: 'Teams' },
  { app: /^discord$/i, title: /voice connected|\bcall\b/i, label: 'Discord' },
  { app: /^whatsapp(\.root)?$/i, title: /\b(voice|video)?\s*call\b/i, label: 'WhatsApp' },
  { app: /^(phoneexperiencehost|yourphone|phone link)$/i, title: /\bcall\b|ongoing|on call/i, label: 'Phone Link' },
  { app: /^skype$/i, title: /\bcall\b/i, label: 'Skype' },
  { app: /^slack$/i, title: /\bhuddle\b/i, label: 'Slack huddle' },
  { app: BROWSERS, title: /^meet\s+[-\u2013]\s+|google meet|\| microsoft teams.*(meeting|call)|zoom meeting/i, label: 'Google Meet' },
];
const WATCH_SITES = [
  { re: /^(.*?)\s+[-\u2013]\s+youtube(?: music)?(?:\s+[-\u2013]\s+[^-\u2013]{1,40})?$/i, site: 'YouTube' },
  { re: /^(.*?)\s+\|\s+netflix$/i, site: 'Netflix' },
  { re: /^(.*?)\s+[-\u2013]\s+twitch$/i, site: 'Twitch' },
  { re: /^watch (.*?) \| prime video$/i, site: 'Prime Video' },
];

/** What a window is: { kind: private|call|watch|code|browse|app, label, detail, site } */
function classifyWindow({ app, title } = {}) {
  const a = String(app || '').replace(/\.exe$/i, '').trim();
  const t0 = String(title || '').trim();
  if (!a && !t0) return { kind: 'none' };
  if (PRIVATE_APPS.test(a) || PRIVATE_TITLE.test(t0)) return { kind: 'private' };
  const browser = BROWSERS.test(a);
  const t = browser ? t0.replace(BROWSER_SUFFIX, '').replace(/\s+[-\u2013]\s+(personal|work|profile \d+)$/i, '').trim() : t0;
  for (const r of CALL_RULES) if (r.app.test(a) && r.title.test(t0)) return { kind: 'call', label: r.label, detail: short(t, 120) };
  if (browser) {
    for (const w of WATCH_SITES) { const m = w.re.exec(t); if (m && m[1] && !/^(home|youtube|subscriptions|history|watch later)$/i.test(m[1].trim())) return { kind: 'watch', label: w.site, detail: short(m[1].replace(/^\(\d+\)\s*/, ''), 160), site: w.site }; }
    const site = (/\s+[-\u2013|]\s+([^-\u2013|]{2,40})$/.exec(t) || [])[1];
    return { kind: 'browse', label: site ? site.trim() : 'the web', detail: short(t, 160) };
  }
  if (CODE_APPS.test(a)) return { kind: 'code', label: a, detail: short(t, 160) };
  return { kind: 'app', label: a || 'an app', detail: short(t, 160) };
}

const APP_NAMES = { code: 'VS Code', msedge: 'Edge', chrome: 'Chrome', firefox: 'Firefox', 'ms-teams': 'Teams', winword: 'Word', excel: 'Excel', powerpnt: 'PowerPoint', explorer: 'File Explorer', windowsterminal: 'Terminal', devenv: 'Visual Studio', 'codeply craft': 'Craft', electron: 'Craft' };
const appName = (a) => APP_NAMES[lower(String(a || '').replace(/\.exe$/i, ''))] || String(a || '').replace(/\.exe$/i, '');

/**
 * One sample of the window in front. Merges samples into episodes (one item
 * each, at least a minute long), keeps activity.current fresh, and marks a
 * call while a call window is in front.
 */
function activityTick({ store, sample, now = Date.now(), gapMs = 2 * 60000 }) {
  const c = classifyWindow(sample || {});
  const ep = store.getState('activity.episode', null);
  if (c.kind === 'none' || c.kind === 'private') {
    store.setState('activity.current', c.kind === 'private' ? { app: 'a private window', title: '', kind: 'private', since: now, seenAt: now } : null);
    if (ep) store.deleteState('activity.episode');
    return { kind: c.kind };
  }
  const name = appName(sample.app);
  const sig = `${c.kind}|${lower(name)}|${lower(c.detail)}`;
  let cur = ep && ep.sig === sig && now - ep.last < gapMs ? ep : null;
  if (!cur) cur = { id: `activity:${now.toString(36)}`, sig, since: now, last: now, written: false };
  cur.last = now;
  // An episode is worth keeping once it has lasted a minute (window-hopping is noise).
  if (now - cur.since >= 60000 || c.kind === 'call') {
    const kind = c.kind === 'watch' ? 'watch' : c.kind === 'call' ? 'call' : 'app';
    store.upsertItem({ id: cur.id, source: 'activity', kind, at: cur.since, end: now, title: c.kind === 'watch' ? c.detail : c.kind === 'call' ? `${c.label} call` : `${name}${c.detail ? `: ${c.detail}` : ''}`, data: { app: name, kind: c.kind, site: c.site || '', label: c.label } });
    cur.written = true;
  }
  store.setState('activity.episode', cur);
  store.setState('activity.current', { app: name, title: c.kind === 'watch' ? `${c.detail} (${c.site})` : c.detail, kind: c.kind, since: cur.since, seenAt: now });
  if (c.kind === 'call') {
    const call = store.getState('call.current', null);
    store.setState('call.current', { app: c.label, since: call && now - call.seenAt < gapMs ? call.since : now, seenAt: now, detail: c.detail });
  }
  return { kind: c.kind, episode: cur.id, written: cur.written };
}

// ─── Calls ──────────────────────────────────────────────────────────────────

/** The model prompt for a finished call (one call, JSON back). */
function callSummaryPrompt({ turns, botName, who, now, tz, plansAsk }) {
  const lines = (turns || []).slice(-120).map((t) => `${t.who === 'bot' ? (botName || 'Bot') : t.who === 'them' ? (who || 'Them') : 'User'}: ${short(t.text, 400)}`).join('\n');
  return `Summarize this call for the user's assistant bots, who share one memory of the user's life.
${lines}

${plansAsk || ''}
Respond with ONLY JSON: {"title": "short title, like Call with Ali about the launch", "summary": "two or three sentences: what was said and decided", "people": ["names of people on or mentioned in the call"], "plans": [...], "todo": ["things the user or a bot promised to do, as short imperative lines"], "forBot": ["only what the user explicitly asked their assistant to handle after the call, each with every detail needed; usually empty"]}`;
}

/**
 * A finished call as a sealed life item. summary is the parsed model JSON (or
 * null, then a plain title is used). source: crew (a call with a bot in
 * Crew), phone (the phone app), pc (the call helper).
 */
function callItem({ id, source = 'crew', botId, botName, turns, ms, at = Date.now(), summary, app }) {
  const s = summary && typeof summary === 'object' ? summary : {};
  const text = (turns || []).map((t) => `${t.who === 'bot' ? (botName || 'Bot') : t.who === 'them' ? 'Them' : 'Me'}: ${String(t.text || '')}`).join('\n');
  const title = short(s.title || (source === 'pc' ? `${app || 'A'} call` : `Call with ${botName || 'a bot'}`), 200);
  return {
    id: id || `calls:${source}:${at.toString(36)}`, source: 'calls', kind: 'call', at, end: at + (Number(ms) || 0), title,
    body: text.slice(0, 40000), people: (Array.isArray(s.people) ? s.people : []).map((p) => short(p, 80)).slice(0, 10), sensitive: true,
    data: { summary: short(s.summary, 800), todo: (Array.isArray(s.todo) ? s.todo : []).map((x) => short(x, 200)).slice(0, 8), forBot: (Array.isArray(s.forBot) ? s.forBot : []).map((x) => short(x, 600)).slice(0, 3), botId: botId || null, botName: botName || '', ms: Number(ms) || 0, via: source, app: app || '' },
  };
}

// ─── Orbit and the drop ─────────────────────────────────────────────────────

function orbitItem({ text, answer, via = 'orbit', at = Date.now() }) {
  const q = short(text, 300);
  if (!q) return null;
  return { id: `orbit:${at.toString(36)}`, source: 'orbit', kind: 'question', at, title: q, data: { via, answer: short(answer, 400) } };
}

module.exports = {
  calendarItem, syncCalendar, syncGmail, gmailUrl, syncProjects,
  classifyWindow, activityTick, appName, callSummaryPrompt, callItem, orbitItem,
};
