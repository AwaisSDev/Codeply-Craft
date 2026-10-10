// Always-on bots in the desktop app: the main-process side (engine:
// codeply-cli/lib/mail-watch.js).
//
// While Craft runs (it hides to the tray on close), bots switched to Always on
// watch the Gmail inbox every ~2 minutes with no model calls. For an email
// that scores as important, the bot writes a summary and a reply (one model
// call) and saves the reply as a Gmail draft. Then it tells the user:
//   · a desktop notification (silent in quiet hours), click opens the bot
//   · an entry in the bot's thread in Crew, with Open email and Open draft
//   · the phone, unless the bot is set to "Message me in Craft" or it is
//     quiet hours: a reminder due now through Codeply's reminders function,
//     so reminders-tick pushes it; kind "call" (the phone rings with the bot)
//     when the bot may call and the email is very important.
//
// Codeply Cloud (a bot with "Keep watching when this PC is off"): the Gmail
// sign-in and the watching bots go to the mail-watch function, which keeps
// it encrypted and polls from the server while this PC is silent. This PC
// sends a heartbeat with its cursor every poll, so the two never handle the
// same email, and picks up what the cloud did while it was off.
//
// main.js wires this in with init(deps); nothing here reaches into main.js.
const path = require('path');
const crypto = require('crypto');

let deps = null;
let watcher = null;
let status = { lastCheck: 0, lastError: '', watching: [], gmail: false, email: '', cloud: false };
let firstTick = true;

const lib = (name) => require(path.join(deps.cliDir, 'lib', name));
const mw = () => lib('mail-watch.js');

/** A fresh Gmail access token (refreshed a minute before it expires). */
async function gmailToken(force) {
  const config = deps.configLib();
  const gmail = config.getIntegration('gmail');
  if (!gmail.accessToken) return null;
  if (!force && gmail.expiresAt && Date.now() < gmail.expiresAt - 60000) return gmail.accessToken;
  if (!gmail.refreshToken) return gmail.accessToken;
  let r;
  try {
    r = await deps.oauthLib().refreshGmailToken(gmail.clientId, gmail.clientSecret, gmail.refreshToken);
  } catch (e) {
    if (e.code === 'invalid_grant') config.disconnectIntegration('gmail');
    throw e;
  }
  config.saveIntegration('gmail', { accessToken: r.access_token, expiresAt: Date.now() + (r.expires_in || 3600) * 1000 });
  return r.access_token;
}

// ─── Codeply's functions (reminders for the phone, mail-watch for the cloud) ──

async function callFunction(name, body) {
  const auth = deps.authLib();
  const token = await auth.getAccessToken();
  if (!token) { const e = new Error('Sign in to Codeply to reach your phone.'); e.signedOut = true; throw e; }
  const res = await fetch(`${auth.SUPABASE_URL}/functions/v1/${name}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, apikey: auth.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) throw new Error(data.error || `${name} failed (HTTP ${res.status}).`);
  return data;
}

const localTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; } };

/** The phone hears about it through a reminder due now (reminders-tick pushes it within a minute). */
async function tellPhone(ev, bot, forceKind) {
  const W = mw();
  const kind = forceKind || (bot.alwaysOn.reach === 'call' && ev.level === 'very' ? 'call' : 'remind');
  await callFunction('reminders', {
    action: 'create',
    reminder: {
      text: W.eventLine(ev).slice(0, 480), due_at: new Date().toISOString(), kind, tz: localTz(),
      bot_id: bot.id, bot_name: bot.name, bot_voice: bot.voice || null,
      payload: { mail: mailPayload(ev) },
    },
  });
}

function mailPayload(ev) {
  return {
    from: String(ev.fromName || '').slice(0, 120), subject: String(ev.subject || '').slice(0, 200),
    summary: String(ev.summary || '').slice(0, 600), reply: String(ev.reply || '').slice(0, 1500),
    drafted: !!ev.draftId, level: ev.level, gmailUrl: ev.gmailUrl, draftUrl: ev.draftUrl,
  };
}

// ─── Telling the user ───────────────────────────────────────────────────────

async function notify(ev) {
  const W = mw();
  const bot = lib('bots.js').getBot(ev.botId);
  if (!bot) return;
  const quiet = W.inQuietHours(bot.alwaysOn.quiet);
  const line = W.eventLine(ev);
  try { deps.crewThread(bot.id, { ...ev, text: line }); } catch (e) { console.warn('[always on] thread:', e.message); }
  const { Notification } = deps;
  if (Notification && Notification.isSupported()) {
    const n = new Notification({ title: bot.name, body: `${line}${ev.summary ? `\n${ev.summary}` : ''}`.slice(0, 240), silent: quiet });
    n.on('click', () => deps.openBot(bot.id));
    n.show();
  }
  if (ev.alert) {
    try { await tellPhone(ev, bot, ev.alert.how === 'call' ? 'call' : 'remind'); } catch (e) { if (!e.signedOut) console.warn('[always on] phone:', e.message); }
    if (!ev.alert.repeat) dropAlert(bot.id, ev.alert.from);
    return;
  }
  if (quiet || bot.alwaysOn.reach === 'message') return;
  try { await tellPhone(ev, bot); } catch (e) { if (!e.signedOut) console.warn('[always on] phone:', e.message); }
}

function dropAlert(botId, from) {
  try {
    const B = lib('bots.js');
    const bot = B.getBot(botId);
    if (!bot) return;
    B.updateBot(botId, { alwaysOn: { ...bot.alwaysOn, alerts: bot.alwaysOn.alerts.filter((a) => a.from !== from) } });
  } catch (e) { console.warn('[always on] alert:', e.message); }
}

// ─── Bots reaching the user from a chat (reach_me, watch_email in lib/reach.js) ─

/** A call or a text to the phone, now or at a time, as this bot (or as Codeply when no bot). */
async function reachPhone({ botId, botName, how, message, at }) {
  const B = lib('bots.js');
  // A named bot ("tell Shella to call me") comes first, then the bot running this.
  const named = botName ? B.findBot(botName, B.listBots()) : null;
  if (botName && !named) return { ok: false, output: `There is no bot called "${botName}". The user's bots: ${B.listBots().map((b) => b.name).join(', ') || 'none'}.` };
  const bot = named || (botId ? B.getBot(botId) : null);
  try {
    await callFunction('reminders', {
      action: 'create',
      reminder: {
        text: String(message).slice(0, 480), due_at: (at || new Date()).toISOString(), kind: how === 'call' ? 'call' : 'remind', tz: localTz(),
        bot_id: bot ? bot.id : null, bot_name: bot ? bot.name : 'Codeply', bot_voice: (bot && bot.voice) || null,
      },
    });
    return { ok: true, from: bot ? bot.name : 'Codeply' };
  } catch (e) {
    return { ok: false, output: e.signedOut ? 'The user is not signed in to Codeply on this PC, so the phone cannot be reached. Ask them to sign in.' : `Could not reach the phone: ${e.message}` };
  }
}

/** "Call / text me when X emails me": an alert on the bot, and the bot starts watching the inbox. */
async function addAlert({ botId, from, how, note, repeat }) {
  const B = lib('bots.js');
  const bot = botId ? B.getBot(botId) : null;
  if (!bot) return { ok: false, output: 'Only a bot can watch the inbox. Ask the user to pick one of their bots (or to make one in Crew) for this.' };
  if (!deps.configLib().getIntegration('gmail').accessToken) return { ok: false, output: 'Gmail is not connected. Ask the user to connect Gmail in Connect Apps first.' };
  const alerts = (bot.alwaysOn.alerts || []).filter((a) => a.from !== from);
  alerts.push({ from, how, note, repeat, at: Date.now() });
  B.updateBot(bot.id, { alwaysOn: { ...bot.alwaysOn, on: true, alerts } });
  poke();
  const signedIn = !!(await deps.authLib().getAccessToken().catch(() => null));
  return {
    ok: true,
    output: `Watching the inbox for email from ${from}. When one arrives, the user gets a ${how === 'call' ? 'call' : 'text'} on their phone${repeat ? ' every time' : ' (once)'}. ` +
      'This runs while Craft is open or in the tray.' + (signedIn ? '' : ' The user is not signed in to Codeply on this PC, so only a desktop notification will show until they sign in.'),
  };
}

// ─── Codeply Cloud hand-off ─────────────────────────────────────────────────

/** What the cloud needs to act as each bot (only bots with cloud on). */
function cloudBots(list, state) {
  return list.filter((b) => b.alwaysOn.cloud).map((b) => {
    const rules = state.rules[b.id] || {};
    return {
      id: b.id, name: b.name, voice: b.voice || '', specialty: b.specialty, instructions: b.instructions,
      tone: (b.tone && b.tone.custom) || '', memory: (b.memory || []).slice(-15).map((m) => m.fact),
      keywords: rules.keywords || [], senders: rules.senders || [],
      alerts: (b.alwaysOn.alerts || []).map((a) => ({ from: a.from, how: a.how, repeat: !!a.repeat })),
      reach: b.alwaysOn.reach, draft: b.alwaysOn.draft, quiet: b.alwaysOn.quiet, tz: localTz(),
    };
  });
}

/**
 * Keep the cloud in step: enable (or update) when the bots or the Gmail
 * sign-in changed, disable when no bot wants it, a heartbeat otherwise. On the
 * first poll after start, take over what the cloud did while this PC was off.
 */
async function syncCloud(list, state, newSeen) {
  const W = mw();
  const want = cloudBots(list, state);
  state.cloud = state.cloud || { enabled: false, hash: '', since: 0 };
  if (!want.length) {
    if (state.cloud.enabled) { await callFunction('mail-watch', { action: 'disable' }); state.cloud = { enabled: false, hash: '', since: 0 }; }
    status.cloud = false;
    return;
  }
  const gmail = deps.configLib().getIntegration('gmail');
  const hash = crypto.createHash('sha256').update(JSON.stringify([want, gmail.refreshToken, gmail.clientId])).digest('hex');
  if (!state.cloud.enabled || state.cloud.hash !== hash) {
    if (!gmail.refreshToken) throw new Error('Reconnect Gmail in Connect Apps so your bots can keep watching while this PC is off.');
    await callFunction('mail-watch', {
      action: 'enable', email: state.account, cursor: state.cursor, bots: want,
      gmail: { refreshToken: gmail.refreshToken, clientId: gmail.clientId, clientSecret: gmail.clientSecret },
    });
    state.cloud = { ...state.cloud, enabled: true, hash };
  }
  if (firstTick) {
    // Mail the cloud handled while this PC was off: its cursor, its seen ids, and its events for the threads.
    const s = await callFunction('mail-watch', { action: 'status', since: state.cloud.since || 0 });
    if (s.cursor && Number(s.cursor) > Number(state.cursor || 0)) state.cursor = String(s.cursor);
    for (const id of s.seen || []) if (!state.seen.includes(id)) state.seen.push(id);
    for (const ev of s.events || []) {
      try { deps.crewThread(ev.botId, { ...ev, text: W.eventLine(ev), cloud: true }); } catch {}
      if (ev.alert && !ev.alert.repeat) dropAlert(ev.botId, ev.alert.from);
      state.cloud.since = Math.max(state.cloud.since || 0, Number(ev.at) || 0);
    }
  }
  await callFunction('mail-watch', { action: 'heartbeat', cursor: state.cursor, seen: newSeen.slice(-200) });
  status.cloud = true;
}

// ─── The poll ───────────────────────────────────────────────────────────────

async function tick() {
  if (!(await deps.ensureEngine())) return false;
  const W = mw();
  const team = lib('bots.js').listBots();
  const list = W.watchingBots(team);
  status.watching = list.map((b) => b.id);
  let state = W.loadState();
  if (!list.length) {
    // Nobody is watching: no Gmail calls at all. Switch the cloud off if it was on.
    if (state.cloud && state.cloud.enabled) { try { await syncCloud([], state, []); W.saveState(state); } catch {} }
    return false;
  }
  const gmail = deps.configLib().getIntegration('gmail');
  status.gmail = !!gmail.accessToken;
  status.email = gmail.email || '';
  if (!gmail.accessToken) { status.lastError = 'Connect Gmail in Connect Apps so your bots can watch your inbox.'; return false; }
  // Gmail was reconnected with another account: start over for it (keep the bots' rules).
  if (gmail.email && state.account && gmail.email.toLowerCase() !== state.account) state = { ...W.emptyState(), rules: state.rules, cloud: state.cloud };

  const seenBefore = new Set(state.seen);
  const route = deps.currentRoute();
  try {
    await lib('telemetry.js').withProduct('crew', () => W.watchOnce({
      bots: list, state, save: false, notify, rawEmail: deps.oauthLib().rawEmail,
      api: W.gmailApi({ token: gmailToken }),
      chat: (messages) => deps.aiLib().chatJson(messages, { route }),
    }));
    status.lastCheck = Date.now();
    status.lastError = '';
  } catch (e) {
    state.lastError = status.lastError = e.message;
    state.failures = (state.failures || 0) + 1;
    W.saveState(state);
    throw e;
  }
  try {
    await syncCloud(list, state, state.seen.filter((id) => !seenBefore.has(id)));
    firstTick = false;
  } catch (e) {
    if (!e.signedOut) console.warn('[always on] cloud:', e.message);
  }
  W.saveState(state);
  return true;
}

function publicStatus() {
  let log = [];
  try { log = mw().loadState().log.slice(-10).reverse(); } catch {}
  return { ...status, log, nextMs: watcher ? watcher.nextDelay : 0 };
}

function init(d) {
  deps = d;
  const W = mw();
  watcher = W.createWatcher({
    tick,
    onError: (e, n) => { if (n <= 3) console.warn(`[always on] poll failed (${n}):`, e.message); },
  });
  watcher.start(15000);
  // Gmail on calls and phone chat is on by default: link it a little after start.
  setTimeout(() => { autoLinkGmailPhone().catch(() => {}); }, 20000);
  d.ipcMain.handle('bots:watchStatus', async () => { try { return publicStatus(); } catch (e) { return { error: e.message }; } });
}

/** Settings changed (a bot saved, Gmail connected): check soon instead of in 2 minutes. */
function poke() { if (watcher) watcher.poke(); autoLinkGmailPhone().catch(() => {}); }

// ─── Gmail on phone calls (Codeply's server reads it while this PC is off) ──

async function gmailPhoneStatus() {
  try { const r = await callFunction('mail-watch', { action: 'linkStatus' }); return { ok: true, linked: !!r.linked }; }
  catch (e) { return { ok: false, linked: false, error: e.signedOut ? 'Sign in to Codeply first.' : e.message }; }
}

/**
 * On by default: when Gmail is connected here and the person hasn't turned
 * "Gmail on calls" off, keep it linked on Codeply's server, so calls and phone
 * chat can read the inbox with this PC off. Links again when Gmail is
 * reconnected (a new refresh token). Turning it off is remembered
 * ("gmailPhone": false in ~/.codeply/config.json) and never undone here.
 */
let gmailLinkedSig = null;
async function autoLinkGmailPhone() {
  if (!deps) return;
  const config = deps.configLib();
  if (!config) { setTimeout(() => { autoLinkGmailPhone().catch(() => {}); }, 30000); return; } // engine still loading
  if (config.getConfig().gmailPhone === false) return;
  const g = config.getIntegration('gmail');
  if (!g.accessToken || !g.refreshToken) return;
  const sig = require('crypto').createHash('sha256').update(g.refreshToken).digest('hex');
  if (gmailLinkedSig === sig) return;
  gmailLinkedSig = sig; // one try per sign-in, not one per poke
  const st = await gmailPhoneStatus();
  if (!st.ok) { gmailLinkedSig = null; return; } // signed out or offline: try again later
  if (st.linked && config.getConfig().gmailPhoneSig === sig) return;
  const r = await gmailPhoneSet(true, { auto: true });
  if (r.ok) config.saveConfig({ gmailPhoneSig: sig });
  else gmailLinkedSig = null;
}

/** on: store the Gmail sign-in on Codeply's server, sealed; off: remove it there. */
async function gmailPhoneSet(on, { auto = false } = {}) {
  // Remember a person's own choice; the automatic link never overrides an "off".
  if (!auto) { try { deps.configLib().saveConfig({ gmailPhone: !!on }); } catch {} }
  try {
    if (!on) { await callFunction('mail-watch', { action: 'unlink' }); return { ok: true, linked: false }; }
    const g = deps.configLib().getIntegration('gmail');
    if (!g.accessToken) return { ok: false, linked: false, error: 'Connect Gmail in Connect Apps first.' };
    if (!g.refreshToken) return { ok: false, linked: false, error: 'Reconnect Gmail in Connect Apps (it needs a fresh sign-in for this).' };
    await callFunction('mail-watch', { action: 'link', email: g.email || '', gmail: { refreshToken: g.refreshToken, clientId: g.clientId, clientSecret: g.clientSecret } });
    return { ok: true, linked: true };
  } catch (e) {
    return { ok: false, linked: !on, error: e.signedOut ? 'Sign in to Codeply first.' : e.message };
  }
}

module.exports = { init, poke, reachPhone, addAlert, gmailPhoneStatus, gmailPhoneSet };
