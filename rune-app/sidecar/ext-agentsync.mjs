// What makes agents behave the same on the PC as on the phone, once the team itself is shared
// (ext-cloud syncs specialists and jobs; ext-team runs them). This file adds the rest:
//
//   1. Chats          the account's `chats` table (supabase/chats.sql), the one phone-sync.js uses, so a
//                     chat started on the phone, mobile.codeply.app or /chat is a chat here, and back.
//                     Messages are merged, never replaced: tool steps and cloud cards on this PC stay.
//   2. Job reports    a job saved from a chat carries `chatId`. Each report (specialist_runs, whatever
//                     ran it: the server timer, the phone or this PC) lands in that chat, as the
//                     phone's syncJobRuns does, and a desktop notification event is sent.
//   3. Standing orders  "every hour check X" typed in a specialist's chat becomes a real job for that
//                     specialist that reports to this chat; the specialist confirms it itself.
//                     "remind me ..." and "cancel my reminder" in any chat go to ext-reminders.
//
//   GET  /ext/agentsync                       { chats: { state, at, count, error }, reports: [...] }
//   POST /ext/agentsync/now                   sync now, same answer
//   GET  /ext/agentsync/specialists           { specialists: [{ id, name, focus, shape, color, gear, voice,
//                                               alwaysOn, builtin, model, instructions, notes, jobs: [...] }] }
//   POST /ext/agentsync/specialists/update    { id, name?, focus?, instructions?, voice?, alwaysOn?, shape?, color?, gear?, notes?, model? }
//
// Events: `session_sync` { session } for each chat that changed (the app's usual chat refresh),
// `job_report` { chatId, jobId, specialist, ok, text, at } for a landed report (notify), `team_changed`,
// `agentsync_changed` after any chat sync.
import fs from 'node:fs';
import path from 'node:path';

const PULL_MS = 30_000;
const PAGE = 200;
const MAX_BODY = 350_000; // characters of JSON per chat, as phone-sync.js
const FIRST_PULL_DAYS = 90; // a new PC does not take years of phone chats

let C = null;
const note = (...a) => console.warn('[agentsync]', ...a);
const W = () => C.need('wisp.js');
const authLib = () => { try { return C.need('auth.js'); } catch { return null; } };
const withTimeout = (p, ms) => Promise.race([Promise.resolve(p), new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), ms))]);
const isMissing = (e) => /does not exist|schema cache|PGRST205|42P01|relation .*chats/i.test(`${(e && e.code) || ''} ${(e && e.message) || ''}`);

// ---------- the account ----------
async function account() {
  try {
    const a = authLib();
    if (!a) return null;
    const s = await withTimeout(a.getSession(), 9000);
    const c = s && s.user ? a.getClient() : null;
    return c ? { c, uid: s.user.id } : null;
  } catch { return null; }
}

// ---------- state kept between launches ----------
const stateFile = () => path.join(C.DATA, 'agentsync.json');
let state = { since: 0, known: {}, seen: {} }; // known: chat id -> updatedAt last sent or taken; seen: chat id -> last job report landed (ms)
function loadState() { try { state = { since: 0, known: {}, seen: {}, ...JSON.parse(fs.readFileSync(stateFile(), 'utf8')) }; } catch { /* first run */ } }
function saveState() { try { fs.writeFileSync(stateFile(), JSON.stringify(state)); } catch { /* next time */ } }

// ---------- chat <-> phone format ----------
// A PC chat is { kind: 'user' | 'assistant' | 'tool' | 'notice' ... , text, at }; the phone's is
// { role: 'user' | 'assistant', content, at } with a "-# Name" line on a specialist's answers.
const HEADER = /^-# [^\n]*\n/;
export const bare = (text) => String(text || '').replace(HEADER, '').trim();
const keyOf = (role, at, text) => `${role}|${Math.round((Number(at) || 0) / 1000)}|${bare(text).slice(0, 60)}`;

const specOf = (session) => {
  if (!(session.kind === 'agent' && session.agent)) return null;
  try { const s = W().findSpecialist(session.agent); return s ? { id: s.id, name: s.name } : null; } catch { return null; }
};

/** The messages a phone can show, from a PC chat. */
export function toPhoneMessages(session, spec) {
  const out = [];
  for (const m of session.messages || []) {
    if (!m || !String(m.text || '').trim()) continue;
    if (m.kind === 'user') out.push({ role: 'user', content: m.text, at: m.at || 0 });
    else if (m.kind === 'assistant' && !m.interim) {
      const head = spec ? `-# ${spec.name}${m.report ? ' · standing job' : ''}\n` : '';
      out.push({ role: 'assistant', content: `${head}${m.text}`, at: m.at || 0 });
    }
  }
  return out;
}

/** Remote messages this chat does not have yet, as PC messages; and the chat's messages in time order after adding them. */
export function mergeIn(session, remoteMessages) {
  const have = new Set();
  for (const m of session.messages) if ((m.kind === 'user' || m.kind === 'assistant') && m.text) have.add(keyOf(m.kind, m.at, m.text));
  const add = [];
  for (const r of remoteMessages || []) {
    if (!r || (r.role !== 'user' && r.role !== 'assistant') || !String(r.content || '').trim()) continue;
    const k = keyOf(r.role, r.at, r.content);
    if (have.has(k)) continue;
    have.add(k);
    add.push({ kind: r.role, text: bare(r.content), at: Number(r.at) || Date.now(), synced: true });
  }
  if (!add.length) return 0;
  // Insert by time among the messages that carry one; tool steps and cards keep their place.
  for (const m of add) {
    let i = session.messages.length;
    while (i > 0 && (session.messages[i - 1].at || 0) > m.at) i--;
    session.messages.splice(i, 0, m);
  }
  return add.length;
}

/** Whether a PC chat goes to the account: your own chats and agents', not the code view or a job's own run chat. */
function syncable(session, jobChats) {
  if (!session || session.kind === 'code' || jobChats.has(session.id)) return false;
  if (String(session.id).startsWith('pending-')) return false;
  return (session.messages || []).some((m) => m.kind === 'user' || m.kind === 'assistant');
}

const jobChatIds = () => { try { return new Set(W().store.loadSchedules().map((j) => j.sessionId).filter(Boolean)); } catch { return new Set(); } };

// ---------- 1. chats ----------
let status = { state: 'waiting', at: 0, count: 0, error: '' };
let running = null;
const remote = new Map(); // chat id -> { meta, body } as last seen in the account, so a push keeps what the phone added
const changedIds = new Set();

function sessionChanged(session) { try { C.emit(session.id, { type: 'session_sync', session: C.api.meta(session) }); } catch { /* nobody listening */ } }

function applyRow(r, jobChats) {
  const api = C.api;
  const local = api.find(r.id);
  if (r.deleted) {
    remote.delete(r.id);
    if (!local || state.known[r.id] === undefined || api.runs.has(r.id)) return false;
    const list = api.sessions();
    list.splice(list.indexOf(local), 1);
    delete state.known[r.id];
    try { C.emit(r.id, { type: 'session_removed', sessionId: r.id }); } catch { /* nobody listening */ }
    return true;
  }
  const m = r.meta || {};
  if (m.pcSessionId) return false; // a window onto a PC chat: that chat is already here
  remote.set(r.id, { meta: m, body: r.body || {} });
  const theirs = Number(m.updatedAt) || Date.parse(r.updated_at) || 0;
  if (local) {
    if (jobChats.has(r.id) || api.runs.has(r.id)) return false;
    const added = mergeIn(local, (r.body || {}).messages);
    let changed = added > 0;
    if (theirs > (local.updatedAt || 0) && m.title && m.title !== local.title) { local.title = String(m.title).slice(0, 120); changed = true; }
    // known stays as it was: a chat with changes of its own still goes up (merged) on the next push.
    if (changed) local.updatedAt = Math.max(local.updatedAt || 0, theirs);
    return changed;
  }
  const spec = m.specialist && m.specialist.name ? m.specialist : null;
  const found = spec ? (() => { try { return W().findSpecialist(spec.id) || W().findSpecialist(spec.name); } catch { return null; } })() : null;
  const session = {
    id: r.id, title: String(m.title || (spec ? `Chat with ${spec.name}` : 'New chat')).slice(0, 120), cwd: C.DEFAULT_CWD,
    createdAt: Number(m.createdAt) || theirs || Date.now(), updatedAt: theirs || Date.now(), messages: [], engine: 'dsh',
    ...(found ? { kind: 'agent', agent: found.name } : {}), fromAccount: true,
  };
  mergeIn(session, (r.body || {}).messages);
  if (!session.messages.length) return false;
  api.sessions().unshift(session);
  state.known[r.id] = session.updatedAt;
  sessionChanged(session);
  return true;
}

async function pullChats(a, jobChats) {
  let since = state.since || (Date.now() - FIRST_PULL_DAYS * 86400000);
  let any = false;
  for (;;) {
    const { data, error } = await a.c.from('chats').select('id, meta, body, deleted, updated_at').gt('updated_at', new Date(since).toISOString()).order('updated_at', { ascending: true }).limit(PAGE);
    if (error) throw error;
    for (const r of data || []) {
      try { if (applyRow(r, jobChats)) { any = true; changedIds.add(r.id); } } catch (e) { note('could not take chat', r.id, e.message); }
      since = Math.max(since, Date.parse(r.updated_at) || 0);
    }
    if (!data || data.length < PAGE) break;
  }
  state.since = since;
  return any;
}

async function pushChats(a, jobChats) {
  const api = C.api;
  const rows = [];
  const now = new Date().toISOString();
  const sent = [];
  const todo = api.sessions().filter((s) => syncable(s, jobChats) && !api.runs.has(s.id) && state.known[s.id] !== (s.updatedAt || 0));
  // Read what the account has for these chats right before writing, so a message the phone added
  // since the last pull is kept instead of overwritten.
  if (todo.length) {
    for (let i = 0; i < todo.length; i += 50) {
      const ids = todo.slice(i, i + 50).map((s) => s.id);
      const { data, error } = await a.c.from('chats').select('id, meta, body, deleted').in('id', ids);
      if (error) throw error;
      for (const r of data || []) if (!r.deleted) remote.set(r.id, { meta: r.meta || {}, body: r.body || {} });
    }
  }
  for (const s of todo) {
    const spec = specOf(s);
    const prev = remote.get(s.id) || { meta: {}, body: {} };
    const ours = toPhoneMessages(s, spec);
    const seen = new Set(ours.map((m) => keyOf(m.role, m.at, m.content)));
    const kept = (prev.body.messages || []).filter((m) => !seen.has(keyOf(m.role, m.at, m.content)));
    let body = { messages: [], pcItems: [], tasks: [], ...prev.body, messages: [...kept, ...ours].sort((x, y) => (x.at || 0) - (y.at || 0)) };
    if (JSON.stringify(body).length > MAX_BODY) body = { ...body, pcItems: (body.pcItems || []).slice(-40), messages: body.messages.slice(-200) };
    const meta = {
      cloud: false, ...prev.meta, id: s.id, title: s.title || prev.meta.title || '', kind: prev.meta.kind || 'chat',
      createdAt: s.createdAt || prev.meta.createdAt || s.updatedAt, updatedAt: s.updatedAt || Date.now(),
      ...(spec ? { specialist: spec } : {}),
      ...(state.seen[s.id] ? { runsSeenAt: Math.max(state.seen[s.id], prev.meta.runsSeenAt || 0) } : {}),
    };
    rows.push({ user_id: a.uid, id: s.id, meta, body, deleted: false, updated_at: now });
    sent.push([s.id, meta.updatedAt]);
  }
  // A chat taken from the account and since removed here is removed there too. Many at once looks
  // like a lost or unreadable chat store, not the user deleting chats: then nothing is removed.
  const gone = Object.keys(state.known).filter((id) => !api.find(id));
  const known = Object.keys(state.known).length;
  if (gone.length && (gone.length <= 3 || gone.length <= known * 0.2)) {
    for (const id of gone) {
      rows.push({ user_id: a.uid, id, meta: {}, body: {}, deleted: true, updated_at: now });
      sent.push([id, null]);
    }
  } else if (gone.length) {
    status.error = `${gone.length} synced chats are missing here at once, so none were removed from your account.`;
  }
  for (let i = 0; i < rows.length; i += 20) {
    const chunk = rows.slice(i, i + 20);
    const { error } = await a.c.from('chats').upsert(chunk, { onConflict: 'user_id,id' });
    if (error) throw error;
    for (const r of chunk) {
      if (r.deleted) { delete state.known[r.id]; remote.delete(r.id); } else { state.known[r.id] = r.meta.updatedAt; remote.set(r.id, { meta: r.meta, body: r.body }); }
    }
  }
  return rows.length;
}

// ---------- 2. job reports into the job's chat ----------
const reports = []; // recent landings, for the app: newest first
async function landReports(a) {
  const W_ = W();
  const jobs = W_.store.loadSchedules().filter((j) => j.chatId);
  if (!jobs.length) return 0;
  const byChat = new Map();
  for (const j of jobs) { if (!byChat.has(j.chatId)) byChat.set(j.chatId, []); byChat.get(j.chatId).push(j); }
  const ids = jobs.map((j) => j.id);
  const floor = Math.min(...[...byChat.entries()].map(([cid, js]) => state.seen[cid] || Math.min(...js.map((j) => j.createdAt || Date.now()))));
  const { data, error } = await a.c.from('specialist_runs').select('id, job_id, specialist, task, output, ok, origin, at').in('job_id', ids).gt('at', new Date(floor).toISOString()).order('at', { ascending: true }).limit(200);
  if (error) throw error;
  let landed = 0;
  for (const [chatId, js] of byChat) {
    const session = C.api.find(chatId);
    if (!session) continue; // the chat is not on this PC (yet): its runs wait, the marker stays
    const jobIds = new Set(js.map((j) => j.id));
    const since = state.seen[chatId] || Math.min(...js.map((j) => j.createdAt || 0));
    const fresh = (data || []).filter((r) => jobIds.has(r.job_id) && r.output && Date.parse(r.at) > since);
    if (!fresh.length) continue;
    const spec = (() => { try { return W_.findSpecialist(js[0].specialist); } catch { return null; } })();
    for (const r of fresh) {
      const at = Date.parse(r.at);
      const text = r.ok ? r.output : `The job did not finish: ${r.output}`;
      if (!session.messages.some((m) => m.kind === 'assistant' && m.at === at && bare(m.text) === bare(text))) {
        session.messages.push({ kind: 'assistant', text, at, report: true, jobId: r.job_id });
      }
      session.updatedAt = Math.max(session.updatedAt || 0, at);
      state.seen[chatId] = Math.max(state.seen[chatId] || 0, at);
      reports.unshift({ chatId, jobId: r.job_id, specialist: (spec && spec.name) || r.specialist, ok: !!r.ok, at: r.at, origin: r.origin || '' });
      try { C.emit(chatId, { type: 'job_report', chatId, jobId: r.job_id, specialist: (spec && spec.name) || r.specialist, ok: !!r.ok, text: String(text).slice(0, 400), at: r.at, origin: r.origin || '' }); } catch { /* nobody listening */ }
      landed++;
    }
    reports.length = Math.min(reports.length, 20);
    sessionChanged(session);
  }
  if (landed) { C.api.save(); saveState(); }
  return landed;
}

async function syncOnce() {
  const a = await account();
  if (!a) { status = { ...status, state: 'off' }; return status; }
  const jobChats = jobChatIds();
  try {
    const pulled = await pullChats(a, jobChats);
    const landed = await landReports(a).catch((e) => { note('job reports:', e.message); return 0; });
    if (pulled || landed) C.api.save();
    const sent = await pushChats(a, jobChats);
    saveState();
    status = { state: 'on', at: Date.now(), count: Object.keys(state.known).length, error: '' };
    if (pulled || landed || sent) { try { C.emit(null, { type: 'agentsync_changed' }); } catch { /* nobody listening */ } }
  } catch (e) {
    status = isMissing(e) ? { state: 'setup', at: status.at, count: 0, error: '' } : { state: 'error', at: status.at, count: status.count, error: String((e && e.message) || e) };
  }
  return status;
}
const syncNow = () => { if (!running) running = syncOnce().finally(() => { running = null; }); return running; };

// ---------- 3. a chat message that is an order ----------
// The phone's own words (phone-specialists.js REPEAT/ORDER): the app saves the order itself, so
// the specialist really does it instead of saying it cannot.
const REPEAT = /\b(?:(?:every|each)\s+(?:\d+\s*|other\s+|an?\s+|one\s+)?(?:minutes?|mins?|hours?|hrs?|day|morning|evening|night|week(?:day|end)?|mon|tue|wed|thu|fri|sat|sun)[a-z]*(?:\s+(?:at|around)\s+\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?|\s+(?:morning|evening|night))?|hourly|daily(?:\s+at\s+\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?)?|nightly|weekly)\b/i;
const ORDER = /\b(need|want|keep|check|search|look|find|watch|scan|monitor|track|send|text|tell|ping|notify|message|remind|summari[sz]e|report|post|write|give|update|research|go\s+through)\b/i;
export function standingOrder(text, parseWhen) {
  const t = String(text || '');
  const m = REPEAT.exec(t);
  if (!m || !ORDER.test(t) || /^\s*(do|does|can|could|will|would|are|is)\b[^.!]*\?\s*$/i.test(t)) return null;
  const rule = parseWhen(m[0]);
  if (!rule || rule.error || rule.kind === 'once') return null;
  return { when: m[0].trim(), task: t.replace(/(^|\s)@[\w.-]+/g, ' ').replace(/\s+/g, ' ').trim() };
}

/** Saves the order as a job for this chat's specialist, reporting to this chat. Resolves { ok, rule, error, spec }. */
export function saveOrder(session, order) {
  const w = W();
  const spec = specOf(session) && w.findSpecialist(session.agent);
  if (!spec) return null;
  const dupe = w.store.loadSchedules().find((j) => j.specialist === spec.id && j.chatId === session.id && j.task === order.task);
  if (dupe) return { ok: true, rule: dupe.rule, spec, dupe: true };
  const r = w.addSchedule({ specialist: spec.id, task: order.task, when: order.when, cwd: session.cwd || C.DEFAULT_CWD });
  if (!r.ok) return { ok: false, error: r.error, spec };
  const list = w.store.loadSchedules();
  const job = list.find((j) => j.id === r.schedule.id);
  if (job) { job.chatId = session.id; job.tz = job.tz || (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; } })(); w.store.saveSchedules(list); }
  return { ok: true, rule: r.schedule.rule, spec, id: r.schedule.id };
}

const notes = new Map(); // chat id -> what the model is told for its next turn
let noteSeq = 0;

/** engine.mjs hooks.beforeMessage: takes a message that is a reminder, a cancel or a standing order, and runs the chat turn with the app's note. */
async function beforeMessage(session, text) {
  if (!session || session.kind === 'code' || C.api.runs.has(session.id)) return false;
  const t = String(text || '');
  let line = ''; let told = '';
  const R = C.shared.reminders;
  if (R) {
    const r = await R.chatAsk(session, t).catch(() => null);
    if (r) { line = r.line; told = r.note; }
  }
  if (!line) {
    let w = null;
    try { w = W(); } catch { /* no team here */ }
    const order = w && specOf(session) ? standingOrder(t, (x) => w.parseWhen(x)) : null;
    if (order) {
      const saved = saveOrder(session, order);
      if (saved) {
        const name = saved.spec.name;
        const when = saved.rule ? w.describeRule(saved.rule) : order.when;
        if (!saved.ok) { line = `Could not save this as ${name}'s standing job: ${saved.error}`; told = `The app tried to save this as your standing job but could not (${saved.error}). Say so in one line.`; }
        else {
          line = `✓ Saved as ${name}'s standing job, ${when}. Reports come to this chat${saved.spec.alwaysOn ? ', even with the PC off' : ' while this PC is on (turn on Always on to run it with the PC off)'}. Change or stop it in Agents.`;
          told = `The app saved this as your standing job, ${when}: "${order.task.slice(0, 300)}". Confirm it in one or two lines (what you will look for and when you will message me), then do a first check right now. Each run's report reaches me in this chat. Never say you cannot work on a schedule or message me.`;
          try { C.emit(null, { type: 'team_changed' }); } catch { /* nobody listening */ }
          try { C.shared.sync && C.shared.sync.syncSoon && C.shared.sync.syncSoon(500); } catch { /* next tick */ }
        }
      }
    }
  }
  if (!line) return false;
  const id = `n${++noteSeq}`;
  notes.set(id, `(App note: ${told})\n\n`);
  const turn = C.api.startRun(session, t, { refs: [{ kind: 'app-note', id }] });
  Promise.resolve(turn).catch(() => {}).finally(() => {
    notes.delete(id);
    // The app's own line, true whatever the model said (the phone's "-# ✓ Saved ..." line).
    session.messages.push({ kind: 'notice', level: 'info', text: line, at: Date.now() });
    session.updatedAt = Date.now();
    try { C.emit(session.id, { type: 'notice', level: 'info', text: line }); } catch { /* nobody listening */ }
    C.api.save();
  });
  return true;
}

// ---------- specialists, for the editor ----------
function specialistView(s) {
  const d = W().detail(s);
  return {
    id: s.id, name: s.name, focus: s.focus || '', shape: s.shape || 'blob', color: s.color || '#4a78e0', gear: s.gear || null,
    voice: s.voice || '', alwaysOn: !!s.alwaysOn, builtin: !!s.builtin, model: s.model || 'auto',
    instructions: d.instructions || '', guide: d.guide || '', notes: d.notes || '',
    jobs: (d.schedules || []).map((j) => ({ id: j.id, task: j.task, when: j.whenText || j.when || '', enabled: j.enabled !== false, chatId: j.chatId || '' })),
  };
}

export function start(ctx) {
  C = ctx;
  loadState();
  // engine.mjs: the note for a turn whose message the app handled (reminders, standing orders).
  ctx.hooks.prompt = ctx.hooks.prompt || [];
  ctx.hooks.prompt.push(async (_session, refs) => (refs || []).filter((r) => r && r.kind === 'app-note').map((r) => notes.get(r.id) || '').join(''));
  ctx.hooks.beforeMessage = ctx.hooks.beforeMessage || [];
  ctx.hooks.beforeMessage.push((session, text) => beforeMessage(session, text));
  ctx.shared.agentsync = { syncNow, standingOrder, saveOrder };
  setTimeout(() => { syncNow().catch(() => {}); }, 8_000).unref?.();
  setInterval(() => { syncNow().catch(() => {}); }, PULL_MS).unref?.();
}

export async function route(ctx, req, res, url, p, reply) {
  if (!p.startsWith('/ext/agentsync')) return false;
  const snap = (extra = {}) => ({ chats: status, reports: reports.slice(0, 10), ...extra });
  try {
    if (req.method === 'GET' && p === '/ext/agentsync') { reply(200, snap()); return true; }
    if (req.method === 'POST' && p === '/ext/agentsync/now') { await syncNow(); reply(200, snap()); return true; }
    if (req.method === 'GET' && p === '/ext/agentsync/specialists') { reply(200, { specialists: W().listSpecialists().map(specialistView) }); return true; }
    if (req.method === 'POST' && p === '/ext/agentsync/specialists/update') {
      const b = await ctx.readJson(req).catch(() => ({}));
      const w = W();
      const s = w.listSpecialists().find((x) => x.id === b.id);
      if (!s) { reply(200, { ok: false, error: 'No one on your team has that id.' }); return true; }
      const patch = {};
      for (const k of ['name', 'focus', 'instructions', 'voice', 'alwaysOn', 'shape', 'color', 'gear', 'notes', 'model']) if (b[k] !== undefined) patch[k] = b[k];
      const r = w.updateSpecialist(s.id, patch);
      try { ctx.emit(null, { type: 'team_changed' }); } catch { /* nobody listening */ }
      try { ctx.shared.sync && ctx.shared.sync.syncSoon && ctx.shared.sync.syncSoon(500); } catch { /* next tick */ }
      const now = w.listSpecialists().find((x) => x.id === s.id);
      reply(200, { ok: !!r, specialist: now ? specialistView(now) : null });
      return true;
    }
  } catch (e) {
    reply(200, snap({ ok: false, error: e.message }));
    return true;
  }
  return false;
}

export const __test = { syncOnce, landReports, applyRow, pushChats, beforeMessage, state: () => state, remote, reports };
