// Bot-owned communication in the desktop app: each bot's own email address
// (bot-mail on Codeply's server, sent through Resend) and Slack messages for
// the bots (slack-events). Engine side: codeply-cli/lib/bot-mail.js.
//
// Every 2 minutes, while Craft runs and the user is signed in:
//   · mail to a bot's address comes in. From the user (their own address,
//     DMARC passing): it is a task for that bot (the autopilot takes it).
//     From anyone else: the bot reads it, sums it up and drafts a reply in its
//     own voice; it never takes on work for a stranger. The reply goes out the
//     way the bot's autonomy says: Ask (a Send button on the card), Hold (the
//     outbox, cancellable), Full (at once, within its daily budget).
//   · Slack: the user talking to their bots (a DM to the Codeply app, an
//     @mention) is a task; a DM to the user from someone else gets a summary
//     and a draft the user can send themselves. Bots never post as the user.
// Everything also goes into the life context (life-desktop.js) when Life is on.
//
// main.js wires this in with init(deps); nothing here reaches into main.js.
const path = require('path');
const fs = require('fs');
const os = require('os');

let deps = null;
let timer = null;
let polling = false;
const CACHE_FILE = path.join(os.homedir(), '.codeply', 'bot-mail.json');
let cache = { mail: {}, slackLink: '', usage: null, usageAt: 0 };

const lib = (name) => require(path.join(deps.cliDir, 'lib', name));
const BOTS = () => lib('bots.js');

function loadCache() { try { cache = { ...cache, ...JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) }; } catch {} }
function saveCache() {
  try {
    const ids = Object.keys(cache.mail);
    if (ids.length > 300) for (const k of ids.sort((a, b) => cache.mail[a].at - cache.mail[b].at).slice(0, ids.length - 300)) delete cache.mail[k];
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  } catch (e) { console.warn('[bot mail] cache:', e.message); }
}
const short = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const clean = (s) => String(s || '').replace(/\s*\u2014\s*/g, ', ').trim();

// ─── Sending ────────────────────────────────────────────────────────────────

/** One email as the bot. Used by bot_email_send, the Send reply button and the autopilot. */
async function send({ botId, to, subject, text, replyTo }) {
  const bot = BOTS().getBot(botId);
  if (!bot || !bot.email || !bot.email.address) return { ok: false, error: 'This bot has no email address.' };
  const thread = replyTo ? cache.mail[replyTo] : null;
  let r;
  try {
    r = await deps.callFunction('bot-mail', {
      action: 'send', botId, to, subject: subject || (thread ? reSubject(thread.subject) : ''), text,
      inReplyTo: thread ? thread.messageId || '' : '', references: thread ? thread.messageId || '' : '', key: `${Date.now().toString(36)}`,
    });
  } catch (e) { return { ok: false, error: e.signedOut ? 'Sign in to Codeply so your bots can send email.' : e.message }; }
  if (thread) { thread.replied = true; saveCache(); }
  const msg = { kind: 'botmail', id: `out-${r.id || Date.now().toString(36)}`, dir: 'out', to, subject: subject || (thread ? reSubject(thread.subject) : ''), text: short(text, 4000) };
  if (deps.crewThread) deps.crewThread(botId, msg);
  if (thread && deps.crewThread) deps.crewThread(botId, { kind: 'botmail', id: replyTo, replied: true });
  lifeNote({ id: `botmail:${msg.id}`, source: 'botmail', kind: 'mail_out', at: Date.now(), title: msg.subject, people: [to], body: text, sensitive: true, data: { botId, handled: true } });
  cache.usage = r.used && r.limits ? { used: r.used, limits: r.limits } : cache.usage;
  return { ok: true, used: r.used, limits: r.limits, from: r.from };
}
const reSubject = (s) => (/^\s*re\s*:/i.test(String(s || '')) ? String(s) : `Re: ${s || ''}`).slice(0, 200);

/** What a reply needs (engine: bot-mail.js threadOf). */
async function thread(id) {
  const t = cache.mail[id];
  return t ? { id, to: t.from, subject: reSubject(t.subject), messageId: t.messageId } : null;
}

function lifeNote(item) {
  const L = deps.life;
  if (!L || !L.isOn() || !L.sourceOn(item.source)) return;
  try { lib('life.js').note(item); } catch {}
}

// ─── Telling the user ───────────────────────────────────────────────────────

async function tell(bot, text) {
  const here = deps.life && deps.life.atPc ? deps.life.atPc() : true;
  if (here && deps.Notification && deps.Notification.isSupported()) {
    const n = new deps.Notification({ title: bot.name, body: short(text, 240), icon: deps.notifyIcon });
    n.on('click', () => deps.openBot(bot.id));
    n.show();
    return;
  }
  try {
    await deps.callFunction('reminders', { action: 'create', reminder: { text: short(text, 480), due_at: new Date().toISOString(), kind: 'remind', tz: deps.localTz(), bot_id: bot.id, bot_name: bot.name, bot_voice: bot.voice || null } });
  } catch {}
}

// ─── Triage: the bot reads what came in ─────────────────────────────────────

function triagePrompt(bot, { via, from, subject, text, owner }) {
  const tone = (BOTS().TONES[bot.tone && bot.tone.preset] || {}).text || '';
  return `You are ${bot.name}${bot.specialty ? `, ${bot.specialty}` : ''}, the AI assistant of ${owner || 'the user'}. Tone: ${tone}${bot.tone && bot.tone.custom ? ` ${bot.tone.custom}` : ''}
${via === 'email' ? `This email came to your own address (not the user's).` : `This Slack message was sent to the user.`}

From: ${from}
${subject ? `Subject: ${subject}\n` : ''}
${short(text, 6000)}

Rules:
- You speak for yourself, as the user's assistant. Never pretend to be the user.
- Never agree to do anything for the sender that changes something (code, deploys, payments, sharing files or data, meetings on the user's calendar). Say you will pass it to ${owner || 'the user'}.
- Spam, sales pitches and newsletters need no reply.
- A reply is short, polite and plain text, signed "${bot.name}"${via === 'slack' ? ', written for the user to send as themselves (no signature)' : ''}.

Respond with ONLY JSON: {"summary": "one sentence for the user", "needsReply": true, "reply": "the reply, or empty", "urgent": false, "spam": false}`;
}

async function triage(bot, m) {
  try {
    const r = await lib('telemetry.js').withProduct('crew', () => deps.aiLib().chatJson([{ role: 'user', content: triagePrompt(bot, m) }], { route: deps.currentRoute() }));
    if (r && r.success && r.json) return { summary: clean(short(r.json.summary, 300)), reply: clean(String(r.json.reply || '').slice(0, 6000)), needsReply: r.json.needsReply !== false && !r.json.spam, urgent: !!r.json.urgent, spam: !!r.json.spam };
  } catch (e) { console.warn('[bot mail] triage:', e.message); }
  return { summary: '', reply: '', needsReply: false, urgent: false, spam: false };
}

const ownerName = () => {
  try { const g = deps.configLib().getIntegration('gmail'); return String((g && g.name) || '').split(/\s+/)[0] || ''; } catch { return ''; }
};

// ─── Incoming mail ──────────────────────────────────────────────────────────

async function handleMail(m) {
  const bot = BOTS().getBot(m.botId);
  if (!bot) return;
  const at = Date.parse(m.at) || Date.now();
  cache.mail[m.id] = { botId: bot.id, from: m.from, fromName: m.fromName, subject: m.subject, messageId: m.messageId, at, fromUser: !!m.fromUser };
  saveCache();
  const card = { kind: 'botmail', id: m.id, dir: 'in', from: m.from, fromName: m.fromName, subject: m.subject, text: short(m.text, 6000), fromUser: !!m.fromUser };
  deps.crewThread(bot.id, card);
  lifeNote({ id: `botmail:${m.id}`, source: 'botmail', kind: 'mail_in', at, title: m.subject || '(no subject)', people: [m.fromName ? `${m.fromName} <${m.from}>` : m.from], body: m.text, sensitive: true, data: { botId: bot.id, fromUser: !!m.fromUser, mailId: m.id } });

  // From the user, really (their address, DMARC passed): a task, not a conversation.
  if (m.fromUser && deps.onTask) {
    deps.onTask({ botId: bot.id, source: 'email', requester: 'user', text: `${m.subject ? `${m.subject}\n\n` : ''}${m.text}`.trim(), reply: { via: 'email', mailId: m.id } });
    deps.crewThread(bot.id, { kind: 'botmail', id: m.id, summary: 'You sent this from your own address, so it is a task. Working on it.' });
    return;
  }
  const t = await triage(bot, { via: 'email', from: m.fromName ? `${m.fromName} <${m.from}>` : m.from, subject: m.subject, text: m.text, owner: ownerName() });
  cache.mail[m.id].draft = t.needsReply ? t.reply : '';
  saveCache();
  deps.crewThread(bot.id, { kind: 'botmail', id: m.id, summary: t.summary, draft: cache.mail[m.id].draft });
  if (!t.needsReply || !t.reply) { if (!t.spam) await tell(bot, `Email from ${m.fromName || m.from}: ${t.summary || m.subject}`); return; }

  const a = bot.autonomy || { level: 'ask' };
  const sendIt = () => send({ botId: bot.id, to: m.from, subject: reSubject(m.subject), text: t.reply, replyTo: m.id });
  const paused = deps.life && deps.life.settings && deps.life.settings().autopilot.paused;
  if (!paused && a.level === 'full' && (a.allow || []).includes('send') && deps.budgetLeft && deps.budgetLeft(bot, 'emails') > 0) {
    const r = await sendIt();
    if (deps.audit) deps.audit({ kind: 'action', botId: bot.id, tool: 'bot_email_send', title: `Replied to ${m.from}: ${reSubject(m.subject)}`, verdict: 'auto', ok: r.ok, result: r.ok ? 'sent' : r.error });
    await tell(bot, r.ok ? `Replied to ${m.fromName || m.from} about "${short(m.subject, 60)}".` : `Could not reply to ${m.from}: ${r.error}`);
  } else if (!paused && a.level === 'hold' && deps.hold) {
    deps.hold({ botId: bot.id, tool: 'bot_email_send', title: `Reply to ${m.fromName || m.from}: ${reSubject(m.subject)}`, detail: t.reply, minutes: a.holdMinutes, run: sendIt });
    await tell(bot, `${m.fromName || m.from} emailed me. I will reply in ${a.holdMinutes} min unless you cancel: ${short(t.summary, 140)}`);
  } else {
    await tell(bot, `Email from ${m.fromName || m.from}: ${short(t.summary || m.subject, 160)}. A reply is drafted.`);
  }
}

// ─── Slack ──────────────────────────────────────────────────────────────────

async function slackName(token, userId) {
  cache.names = cache.names || {};
  if (cache.names[userId]) return cache.names[userId];
  try {
    const res = await fetch(`https://slack.com/api/users.info?user=${encodeURIComponent(userId)}`, { headers: { Authorization: `Bearer ${token}` } });
    const b = await res.json();
    const name = b.ok ? (b.user.profile && (b.user.profile.display_name || b.user.profile.real_name)) || b.user.name : '';
    if (name) { cache.names[userId] = name; saveCache(); }
    return name || userId;
  } catch { return userId; }
}

/** Which bot the user meant ("Shella, ..."), else the lead, else the first. */
function botFor(text) {
  const team = BOTS().listBots();
  const t = String(text || '').replace(/<@[A-Z0-9]+>/g, '').trim();
  return team.find((b) => new RegExp(`^\\s*(hey\\s+|hi\\s+)?${b.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(t)) || team.find((b) => b.role === 'orchestrator') || team[0] || null;
}

async function handleSlack(ev, slack) {
  const who = await slackName(slack.accessToken, ev.user);
  const at = Date.parse(ev.at) || Date.now();
  const text = String(ev.text || '').replace(/<@([A-Z0-9]+)>/g, (m0, id) => (id === slack.botUserId ? '' : id === slack.userId ? '@you' : m0)).trim();
  const link = `https://app.slack.com/client/${encodeURIComponent(ev.teamId)}/${encodeURIComponent(ev.channel)}`;
  lifeNote({ id: `slack:${ev.id}`, source: 'slack', kind: ev.kind, at, title: short(text, 160), people: [who], data: { channel: ev.channel, ts: ev.ts, kind: ev.kind } });
  if (ev.kind === 'command') {
    const bot = botFor(text);
    if (!bot) return;
    deps.crewThread(bot.id, { kind: 'slack', id: ev.id, dir: 'in', fromName: 'You, on Slack', text: short(text, 3000), url: link, summary: 'A task from you on Slack.' });
    if (deps.onTask) deps.onTask({ botId: bot.id, source: 'slack', requester: 'user', text, reply: { via: 'slack', channel: ev.channel, ts: ev.threadTs || ev.ts } });
    return;
  }
  // Someone wrote to the user: the bot that handles their messages drafts an answer for them to send.
  const T = lib('life-triggers.js');
  const bot = T.chooseBot({ trigger: 'email' }, BOTS().listBots(), (deps.life && deps.life.settings().nudges) || {});
  if (!bot) return;
  const t = await triage(bot, { via: 'slack', from: who, text, owner: ownerName() });
  deps.crewThread(bot.id, { kind: 'slack', id: ev.id, dir: 'in', fromName: who, text: short(text, 3000), url: link, summary: t.summary, draft: t.needsReply ? t.reply : '' });
  if (!t.spam) await tell(bot, `${who} on Slack: ${short(t.summary || text, 160)}`);
}

async function linkSlack(slack) {
  const sig = `${slack.teamId}:${slack.userId}:${slack.botUserId || ''}`;
  if (!slack.teamId || !slack.userId || cache.slackLink === sig) return;
  await deps.callFunction('slack-events', { action: 'link', teamId: slack.teamId, slackUserId: slack.userId, botUserId: slack.botUserId || '' });
  cache.slackLink = sig; saveCache();
}

/** A bot answering on Slack as itself (a task's report back where it came from). */
async function slackReply({ botId, channel, ts, text }) {
  const slack = deps.configLib().getIntegration('slack');
  const bot = BOTS().getBot(botId);
  if (!slack.accessToken || !bot) return { ok: false };
  try { await deps.oauthLib().slackPostMessage(slack.accessToken, { channel, text, threadTs: ts }, { asName: `${bot.name} (assistant)` }); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}

// ─── The poll ───────────────────────────────────────────────────────────────

async function poll() {
  if (polling || !deps) return;
  polling = true;
  try {
    if (!(await deps.ensureEngine())) return;
    const anyAddress = BOTS().listBots().some((b) => b.email && b.email.address);
    if (anyAddress) {
      const r = await deps.callFunction('bot-mail', { action: 'inbox' });
      for (const m of r.mail || []) { try { await handleMail(m); } catch (e) { console.warn('[bot mail] in:', e.message); } }
    }
    const slack = deps.configLib().getIntegration('slack');
    if (slack && slack.accessToken && slack.userId) {
      await linkSlack(slack);
      const r = await deps.callFunction('slack-events', { action: 'inbox' });
      for (const ev of r.events || []) { try { await handleSlack(ev, slack); } catch (e) { console.warn('[slack] in:', e.message); } }
    }
  } catch (e) {
    if (!e.signedOut && !/not found|404|Unknown action/i.test(e.message)) console.warn('[bot mail] poll:', e.message);
  } finally { polling = false; }
}

/** The Life panel's mail card: addresses and this month's and today's share. */
async function usage(force) {
  if (!force && cache.usageAt && Date.now() - cache.usageAt < 2 * 60000 && cache.usageView) return cache.usageView;
  try {
    const r = await deps.callFunction('bot-mail', { action: 'list' });
    const names = Object.fromEntries(BOTS().listBots().map((b) => [b.id, b.name]));
    cache.usageView = { domain: r.domain, used: r.used, limits: r.limits, sending: r.sending, boxes: (r.boxes || []).map((b) => ({ address: b.address, botName: names[b.bot_id] || b.bot_name })) };
  } catch (e) {
    cache.usageView = { domain: '', used: { day: 0, month: 0 }, limits: { day: 10, month: 50 }, boxes: [], error: e.signedOut ? 'Sign in to Codeply to give your bots email.' : `Bot email is not reachable: ${short(e.message, 120)}` };
  }
  cache.usageAt = Date.now();
  return cache.usageView;
}

function catalogFor() {
  const B = BOTS();
  return { bots: B.listBots(), templates: B.TEMPLATES, tones: B.TONES, approvals: Object.fromEntries(Object.entries(B.APPROVALS).map(([k, v]) => [k, v.label])), maxMemory: B.MAX_MEMORY, watchSources: B.WATCH_SOURCES, reach: B.REACH };
}

function registerIpc(ipcMain) {
  const guard = (fn) => async (e, ...a) => { try { await deps.ensureEngine(); return await fn(...a); } catch (err) { return { error: err.signedOut ? 'Sign in to Codeply first.' : err.message }; } };
  ipcMain.handle('crew:botmail:claim', guard(async (botId, local) => {
    const bot = BOTS().getBot(String(botId));
    if (!bot) return { error: 'That bot is gone.' };
    const r = await deps.callFunction('bot-mail', { action: 'claim', botId: bot.id, botName: bot.name, local: String(local || bot.name), ownerName: ownerName() });
    const saved = BOTS().updateBot(bot.id, { email: { address: r.address, on: true } });
    cache.usageAt = 0;
    return { bot: saved, catalog: catalogFor() };
  }));
  ipcMain.handle('crew:botmail:release', guard(async (botId) => {
    const bot = BOTS().getBot(String(botId));
    if (!bot) return { error: 'That bot is gone.' };
    await deps.callFunction('bot-mail', { action: 'release', botId: bot.id });
    const saved = BOTS().updateBot(bot.id, { email: { address: '', on: false } });
    cache.usageAt = 0;
    return { bot: saved, catalog: catalogFor() };
  }));
  ipcMain.handle('crew:botmail:reply', guard(async (id) => {
    const t = cache.mail[String(id)];
    if (!t || !t.draft) return { error: 'There is no drafted reply for that email any more.' };
    const r = await send({ botId: t.botId, to: t.from, subject: reSubject(t.subject), text: t.draft, replyTo: String(id) });
    return r.ok ? { ok: true } : { error: r.error };
  }));
}

function init(d) {
  deps = d;
  loadCache();
  registerIpc(d.ipcMain);
  lib('bot-mail.js').setHandler({ send, thread });
  timer = setInterval(() => { poll(); }, 2 * 60000);
  if (timer.unref) timer.unref();
  setTimeout(() => { poll(); }, 30000);
}
function poke() { setTimeout(() => { poll(); }, 1000); }

module.exports = { init, poke, poll, send, slackReply, usage, handleMail, handleSlack, triagePrompt };
