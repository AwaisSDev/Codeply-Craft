// Reminders on the PC, the same ones the phone sets: they live in the account (Codeply's
// `reminders` edge function, which reminders-tick turns into a phone push or call when due), so a
// reminder made here shows on the phone and one made on the phone shows here. See phone-reminders.js.
//
//   GET  /ext/reminders          { reminders: [...], signedIn, error }  newest state, upcoming first
//   POST /ext/reminders          { text, at | when, repeat?, kind?, specialist? } or { ask }
//                                  at: an ISO time; when: plain words ("in 10 minutes", "at 5pm");
//                                  ask: "remind me at 5: call mom" read the way the phone reads it
//   POST /ext/reminders/cancel   { id } or { ask: "cancel my test reminder" }
//   POST /ext/reminders/snooze   { id, minutes? }
//
// Events: `reminders_changed` (the list changed here or on another device), and `reminder_due`
// { reminder } once when one comes due while Codeply is open: the app shows it as a desktop
// notification (the PC's counterpart of the phone's push).
//
// Other engine code uses ctx.shared.reminders: chatAsk(session, text) is what a chat message
// ("remind me in 2 minutes: test", "cancel my test reminder") runs through (ext-agentsync), and the
// agent's reach_me tool is wired to the same function, as main.js does for the Electron app.
const POLL_MS = 60_000;
const DUE_MS = 15_000;

let C = null;
let list = [];
let signature = '';
let lastError = '';
let signedIn = false;
let fetchedAt = 0;
const dueSeen = new Set();
const note = (...a) => console.warn('[reminders]', ...a);

const authLib = () => { try { return C.need('auth.js'); } catch { return null; } };
const tz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; } };
const emitChanged = () => { try { C.emit(null, { type: 'reminders_changed' }); } catch { /* nobody listening */ } };

/** One call of the reminders function, with the signed-in user's token (never logged). */
async function call(body) {
  const auth = authLib();
  const token = auth ? await auth.getAccessToken().catch(() => null) : null;
  if (!token) { const e = new Error('Sign in to Codeply to use reminders.'); e.signedOut = true; throw e; }
  const res = await fetch(`${auth.SUPABASE_URL}/functions/v1/reminders`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, apikey: auth.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success) throw Object.assign(new Error(data.error || `Reminders failed (${res.status}).`), { status: res.status });
  signedIn = true;
  return data;
}

const dueOf = (r) => Date.parse(r.due_at) || 0;
const isUpcoming = (r, now = Date.now()) => (r.status === 'pending' || r.status === 'snoozed') && dueOf(r) > now - 60000;

/** What the app needs of one reminder (camelCase), with the phone's own fields kept under their names too. */
function view(r, now = Date.now()) {
  return {
    id: r.id, text: r.text || '', dueAt: r.due_at, kind: r.kind || 'remind', repeat: r.repeat || '', status: r.status || 'pending',
    botId: r.bot_id || '', botName: r.bot_name || 'Codeply', sentAt: r.sent_at || '', createdAt: r.created_at || '',
    upcoming: isUpcoming(r, now),
  };
}
const sorted = (rows) => rows.slice().sort((a, b) => dueOf(a) - dueOf(b));

function setList(rows) {
  const next = sorted(rows || []);
  const sig = JSON.stringify(next.map((r) => [r.id, r.due_at, r.status, r.text]));
  list = next;
  fetchedAt = Date.now();
  if (sig !== signature) { signature = sig; emitChanged(); }
}

async function refresh() {
  try {
    setList(await call({ action: 'list' }).then((d) => d.reminders || []));
    signedIn = true; lastError = '';
  } catch (e) {
    signedIn = !e.signedOut && signedIn;
    lastError = e.signedOut ? '' : e.message;
  }
  return list;
}

// ---------- reading plain words (the phone's parseAsk, phone-reminders.js) ----------

const NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fifteen: 15, twenty: 20, thirty: 30, forty: 40, 'forty-five': 45, fifty: 50, sixty: 60 };
const UNIT = (u) => (/^s/.test(u) ? 1000 : /^(m|min)/.test(u) ? 60000 : /^h/.test(u) ? 3600000 : 86400000);
export function parseAsk(raw) {
  const t = String(raw || '').replace(/(^|\s)@[\w.-]+/g, ' ').replace(/\s+/g, ' ').trim();
  const low = t.toLowerCase();
  if (!/\b(remind (me|us)|set (a |an )?(reminder|alarm|timer)|reminder (for|to|in|at|about)|notify me|send me a (notification|reminder|ping)|ping me|alert me|wake me|call me (in|at|after|tomorrow|tonight|this|every)|text me (in|at|after|tomorrow|tonight|this|every))\b/.test(low)) return null;
  const now = Date.now();
  let due = null; let used = [];
  // in / after N minutes, an hour, half an hour
  let m = /\b(?:in|after|within)\s+(half an?|\d+(?:\.\d+)?|an?|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty-five|forty|fifty|sixty)\s*(seconds?|secs?|minutes?|mins?|m|hours?|hrs?|hr|h|days?)\b/.exec(low);
  if (m) {
    const n = /^half/.test(m[1]) ? 0.5 : NUM[m[1]] != null ? NUM[m[1]] : Number(m[1]);
    due = now + Math.max(n * UNIT(m[2]), 60000);
    used.push(m[0]);
  } else if ((m = /\b(?:in|after)\s+half an? hour\b/.exec(low))) { due = now + 1800000; used.push(m[0]); }
  // at 5, at 5pm, at 17:30, tomorrow, tonight, this evening
  if (due == null) {
    const d = new Date();
    let day = 0;
    const tm = /\btomorrow\b/.exec(low); if (tm) { day = 1; used.push(tm[0]); }
    const at = /\b(?:at|by|around)\s+(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?(?=\s|$|[,.;:!?])/.exec(low)
      || /\bfor\s+(\d{1,2})(?:[:.](\d{2})\s*(am|pm|a\.m\.|p\.m\.)?|()\s*(am|pm|a\.m\.|p\.m\.))(?=\s|$|[,.;:!?])/.exec(low); // "for 10:30", "for 5pm" (not "for 5": that could be minutes)
    if (at && at[5]) at[3] = at[5];
    const part = /\b(tonight|this evening|in the evening|this morning|in the morning|this afternoon|in the afternoon|noon|midday)\b/.exec(low);
    let h = null, min = 0, ap = '';
    if (at) { h = Number(at[1]); min = Number(at[2] || 0); ap = (at[3] || '').replace(/\./g, ''); used.push(at[0]); }
    if (part) used.push(part[0]);
    if (h == null && part) h = /night/.test(part[1]) ? 21 : /evening/.test(part[1]) ? 19 : /afternoon/.test(part[1]) ? 14 : /noon|midday/.test(part[1]) ? 12 : 9;
    if (h == null && day === 1) h = 9; // "tomorrow": the morning
    if (h != null && h <= 23 && min <= 59) {
      if (ap === 'pm' && h < 12) h += 12;
      if (ap === 'am' && h === 12) h = 0;
      if (!ap && h < 12 && part && /evening|night|afternoon/.test(part[1])) h += 12;
      const c = new Date(d.getFullYear(), d.getMonth(), d.getDate() + day, h, min, 0, 0);
      // "at 5" with no am/pm: the next 5 o'clock still ahead
      if (!ap && !part && day === 0 && h < 12 && c.getTime() <= now) { c.setHours(h + 12); }
      if (c.getTime() <= now) c.setDate(c.getDate() + 1);
      due = c.getTime();
    }
  }
  if (due == null) return null; // no clear time: the model asks
  const repeat = /\b(every ?day|daily|each day)\b/.test(low) ? 'daily' : /\b(weekdays|every weekday)\b/.test(low) ? 'weekdays' : /\b(every week|weekly)\b/.test(low) ? 'weekly' : 'none';
  const kind = /\bcall me\b/.test(low) ? 'call' : 'remind';
  // what it is about: after a colon, or "to / about / that ...", without the time words
  let text = '';
  // the time words out first, so "10:30" or "for 5pm" are never taken for what it is about
  let rest = t;
  for (const u of used) rest = rest.replace(new RegExp(u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), ' ');
  const colon = rest.search(/(?<!\d):(?!\d)/);
  if (colon >= 0 && colon < rest.length - 1) text = rest.slice(colon + 1);
  else {
    const after = rest.replace(/^.*?\b(remind (me|us)|notify me|ping me|alert me|call me|text me|wake me|reminder)\b/i, '');
    const w = /\b(?:to|about|that)\s+(.+)$/i.exec(after) || /\bfor\s+(.+)$/i.exec(after);
    if (w) text = w[1];
  }
  text = text.replace(/\b(every ?day|daily|each day|weekdays|every weekday|every week|weekly|tomorrow|today|later|please|pls|ok|okay)\b/gi, ' ').replace(/\s+/g, ' ').replace(/^[\s,.;:-]+|[\s,.;:!?-]+$/g, '').trim();
  if (!text) text = kind === 'call' ? 'Call from Codeply' : 'Reminder';
  return { at: new Date(due).toISOString(), repeat, kind, text: text.slice(0, 200) };
}

// ---------- the reminder a request becomes ----------

/** A tag ({ at, repeat, kind, text }) as the row the function stores. bot: { id, name, voice }. */
export function fromTag(t, bot) {
  const due = Date.parse(String(t.at || '').trim());
  if (!Number.isFinite(due)) throw new Error('The reminder time did not make sense.');
  if (due < Date.now() - 2 * 60000) throw new Error('That time has already passed.');
  const repeat = String(t.repeat || '').toLowerCase().trim();
  const kind = String(t.kind || '').toLowerCase().trim();
  const text = String(t.text || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  if (!text) throw new Error('The reminder had no text.');
  return {
    text, due_at: new Date(due).toISOString(), tz: tz() || null,
    repeat: ['daily', 'weekdays', 'weekly'].includes(repeat) ? repeat : null,
    kind: ['call', 'remind', 'task'].includes(kind) ? kind : 'remind',
    bot_id: (bot && bot.id) || null, bot_name: (bot && bot.name) || 'Codeply', bot_voice: (bot && bot.voice) || null,
    payload: kind === 'task' ? { task: text } : {},
  };
}

async function create(tag, bot) {
  const d = await call({ action: 'create', reminder: fromTag(tag, bot) });
  const r = d.reminder;
  if (r) setList([...list.filter((x) => x.id !== r.id), r]);
  return r;
}

async function remove(id) {
  await call({ action: 'delete', id });
  setList(list.filter((r) => r.id !== id));
}

const botOf = (name) => {
  if (!name) return null;
  try {
    const s = C.need('wisp.js').findSpecialist(String(name));
    return s ? { id: s.id, name: s.name, voice: s.voice || null } : { id: null, name: String(name).slice(0, 40), voice: null };
  } catch { return null; }
};

const whenLabel = (iso) => {
  const d = new Date(iso); const now = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(now)) / 86400000);
  const time = d.toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit' });
  if (diff === 0) return `Today ${time}`;
  if (diff === 1) return `Tomorrow ${time}`;
  if (diff > 1 && diff < 7) return `${d.toLocaleDateString('en', { weekday: 'short' })} ${time}`;
  return `${d.toLocaleDateString('en', { month: 'short', day: 'numeric' })}, ${time}`;
};

// ---------- cancelling in plain words (the phone's cancelAsk) ----------

const CANCEL = /\b(cancel|delete|remove|clear|stop|turn off|get rid of|undo|scrap|drop)\b[^.?!\n]{0,60}\b(reminders?|alarms?|alerts?)\b|\b(reminders?)\b[^.?!\n]{0,30}\b(cancel|delete|remove|off)\b|\b(don'?t|do not|no need to) (remind|call|ping|notify) me\b/i;
const STOP = new Set('a an the my me of to for about at in on and or please pls can could you u that this those these all every reminder reminders cancel delete remove clear stop turn off get rid undo scrap drop don dont do not no need remind call ping notify one ones last latest just set i is it its'.split(' '));

/** null when the text is not about cancelling, else { done: [rows], note }. */
export async function cancelAsk(raw) {
  const t = String(raw || '').replace(/(^|\s)@[\w.-]+/g, ' ').trim();
  if (!CANCEL.test(t)) return null;
  await refresh();
  const up = list.filter((r) => isUpcoming(r));
  if (!up.length) return { done: [], note: 'There were no upcoming reminders to cancel.' };
  const low = t.toLowerCase();
  let pick = [];
  if (/\b(all|every|each)\b/.test(low)) pick = up;
  else if (/\b(last|latest|newest|just set|that one|the one you just)\b/.test(low)) {
    pick = [up.slice().sort((a, b) => Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0) || dueOf(b) - dueOf(a))[0]];
  } else {
    const words = low.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w));
    const score = (r) => words.filter((w) => String(r.text).toLowerCase().includes(w)).length;
    const best = Math.max(0, ...up.map(score));
    if (best > 0) pick = up.filter((r) => score(r) === best);
    else if (up.length === 1) pick = up;
  }
  if (!pick.length) return { done: [], note: `Which one? Coming up: ${up.slice(0, 6).map((r) => `"${r.text}" (${whenLabel(r.due_at)})`).join(', ')}.` };
  const done = [];
  for (const r of pick) { try { await remove(r.id); done.push(r); } catch { /* left as it was */ } }
  return { done, note: done.length ? `Cancelled: ${done.map((r) => `"${r.text}" (${whenLabel(r.due_at)})`).join(', ')}.` : 'Could not cancel it just now. Try again from Reminders.' };
}

/**
 * A chat message that is a reminder request or a cancel. Resolves null when it is neither, else
 * { line, note }: line is the app's own confirmation (true whatever the model says) and note is
 * what the model is told, so it confirms in one sentence. session: the chat (a specialist's chat
 * names the reminder's sender).
 */
export async function chatAsk(session, text) {
  const cancelled = await cancelAsk(text).catch((e) => ({ done: [], note: `Could not cancel it: ${e.message}` }));
  if (cancelled) {
    return { line: `${cancelled.done.length ? '✓ ' : ''}${cancelled.note}`, note: `The app handled the request to cancel reminders: ${cancelled.note} Say this in one short sentence.`, changed: cancelled.done.length > 0 };
  }
  const plain = parseAsk(text);
  if (!plain) return null;
  const bot = session && session.kind === 'agent' && session.agent ? botOf(session.agent) : null;
  try {
    const rem = await create(plain, bot);
    return {
      line: `✓ Reminder set: ${rem.text}, ${whenLabel(rem.due_at)}${rem.kind === 'call' ? ' (a call)' : ''}.`,
      note: `The app just set a reminder the user asked for: "${rem.text}", ${whenLabel(rem.due_at)}. Confirm it in one short sentence.`,
      changed: true,
    };
  } catch (e) {
    const why = e.signedOut ? 'you are not signed in to Codeply on this PC' : e.message;
    return { line: `Could not set the reminder: ${why}`, note: `The app could not set the reminder (${why}). Say so in one short sentence.`, changed: false };
  }
}

// ---------- the agent's reach_me tool ----------

async function reach({ botName, botId, how, message, at }) {
  const bot = botOf(botName) || (botId ? botOf(botId) : null);
  try {
    const r = await create({ at: (at || new Date()).toISOString(), repeat: '', kind: how === 'call' ? 'call' : 'remind', text: message }, bot);
    return { ok: !!r, from: bot ? bot.name : 'Codeply' };
  } catch (e) {
    return { ok: false, output: e.signedOut ? 'The user is not signed in to Codeply on this PC, so the phone cannot be reached. Ask them to sign in.' : `Could not reach the phone: ${e.message}` };
  }
}

// ---------- due now: a desktop notification ----------

function checkDue(now = Date.now()) {
  for (const r of list) {
    if (r.status !== 'pending' && r.status !== 'snoozed') continue;
    const due = dueOf(r);
    const key = `${r.id}@${due}`;
    if (due > now || now - due > 10 * 60000 || dueSeen.has(key)) continue;
    dueSeen.add(key);
    try { C.emit(null, { type: 'reminder_due', reminder: view(r, now) }); } catch { /* nobody listening */ }
  }
}

export function start(ctx) {
  C = ctx;
  ctx.shared.reminders = { chatAsk, cancelAsk, parseAsk, refresh, list: () => list.map((r) => view(r)) };
  // The agent can set a reminder on the phone only when the host registered this (reach.js).
  try { const reachLib = ctx.need('reach.js'); if (!reachLib.available()) reachLib.setHandler({ reach }); } catch { /* the engine has no reach.js */ }
  setTimeout(() => { refresh().catch(() => {}); }, 4_000).unref?.();
  setInterval(() => { refresh().catch(() => {}); }, POLL_MS).unref?.();
  setInterval(() => { try { checkDue(); } catch (e) { note('due check failed:', e.message); } }, DUE_MS).unref?.();
}

export async function route(ctx, req, res, url, p, reply) {
  if (!p.startsWith('/ext/reminders')) return false;
  const snapshot = (extra = {}) => ({ reminders: list.map((r) => view(r)), signedIn, error: lastError, ...extra });
  try {
    if (req.method === 'GET' && p === '/ext/reminders') {
      if (Date.now() - fetchedAt > 5000) await refresh();
      reply(200, snapshot());
      return true;
    }
    if (req.method !== 'POST') return false;
    const b = await ctx.readJson(req).catch(() => ({}));
    if (p === '/ext/reminders') {
      let tag = null;
      if (b.ask) tag = parseAsk(String(b.ask));
      else if (b.when) {
        // the Reminders form: "in 10 minutes", "at 5pm", "tomorrow at 9", or a bare "5pm"
        const w = /^(in|at|after|by|around|for|tomorrow|tonight|this|every|daily|weekdays|weekly|noon|midday)\b/i.test(String(b.when).trim()) ? String(b.when).trim() : `at ${String(b.when).trim()}`;
        tag = parseAsk(`remind me ${w}: ${String(b.text || '').trim()}`);
        if (tag && b.repeat) tag.repeat = b.repeat;
        if (tag && b.kind) tag.kind = b.kind;
      } else if (b.at) tag = { at: b.at, repeat: b.repeat || '', kind: b.kind || 'remind', text: b.text };
      if (!tag) { reply(200, snapshot({ ok: false, error: 'Say when, like "in 10 minutes", "at 5pm" or "tomorrow at 9".' })); return true; }
      if (b.text && b.ask) tag.text = String(b.text);
      const r = await create(tag, botOf(b.specialist));
      reply(200, snapshot({ ok: true, reminder: view(r) }));
      return true;
    }
    if (p === '/ext/reminders/cancel') {
      if (b.ask) {
        const r = await cancelAsk(b.ask);
        reply(200, snapshot({ ok: !!(r && r.done.length), note: r ? r.note : 'That was not about cancelling a reminder.', cancelled: r ? r.done.map((x) => x.id) : [] }));
      } else if (b.id) {
        await remove(String(b.id));
        reply(200, snapshot({ ok: true, cancelled: [String(b.id)] }));
      } else reply(200, snapshot({ ok: false, error: 'Say which reminder (id).' }));
      return true;
    }
    if (p === '/ext/reminders/snooze') {
      const d = await call({ action: 'snooze', id: String(b.id || ''), minutes: Math.max(1, Math.min(1440, Number(b.minutes) || 10)) });
      if (d.reminder) setList([...list.filter((x) => x.id !== d.reminder.id), d.reminder]);
      reply(200, snapshot({ ok: true }));
      return true;
    }
  } catch (e) {
    reply(200, snapshot({ ok: false, error: e.signedOut ? 'Sign in to Codeply to use reminders.' : e.message, signedOut: !!e.signedOut }));
    return true;
  }
  return false;
}

// For the tests.
export const __state = { call, refresh, checkDue, view, setList: (rows) => setList(rows) };
