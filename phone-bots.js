// Your bots, with the PC off. While the PC is online it does this (bots-mail.js, autopilot.js); when it is
// offline the phone takes over, through the same functions and the same Codeply sign-in:
//   - email to a bot's own address (bot-mail inbox) and Slack messages (slack-events inbox) come in here;
//   - from you (your own address, or a Slack DM / @mention to the bots): a task. It runs in Codeply Cloud with
//     the bot's prompt, and the result goes back where it came from (an email from the bot, a Slack thread);
//   - from anyone else: the bot reads it and drafts a reply. Nothing is sent without your tap: with the PC off
//     the phone asks first, whatever the bot's autonomy says on the PC;
//   - Stop all bots pauses all of it here.
// It runs while the app is open (every 2 minutes, and when you come back to it). Items are kept on this phone.
(() => {
  'use strict';
  const P = () => window.CraftPhone;
  if (!window.CraftPhone) return;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const KEY = 'craft-phone-botwork';
  const load = () => { try { return { items: [], paused: false, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { items: [], paused: false }; } };
  let st = load();
  const save = () => { st.items = st.items.slice(-150); try { localStorage.setItem(KEY, JSON.stringify(st)); } catch {} };
  const short = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
  const pcOnline = () => !!(P().relay && P().relay.pcId);
  // The bots the PC last sent (phone-calls.js keeps them as { bots, templates, at }).
  const bots = () => { try { const c = JSON.parse(localStorage.getItem('craft-phone-bots') || '{}'); return Array.isArray(c) ? c : (c && c.bots) || []; } catch { return []; } };
  const botById = (id) => bots().find((b) => b.id === id) || null;
  const lead = () => { const t = bots(); return t.find((b) => b.role === 'orchestrator') || t[0] || null; };
  let mounted = null; let polling = false; let lastPoll = 0; let error = '';

  async function fn(name, body) {
    const token = await P().accessToken();
    if (!token) throw Object.assign(new Error('Sign in to Codeply first.'), { signedOut: true });
    const r = await fetch(`${P().SUPABASE_URL}/functions/v1/${name}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, apikey: P().SUPABASE_ANON_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.success === false) throw Object.assign(new Error(j.error || `${name} failed (HTTP ${r.status}).`), { status: r.status });
    return j;
  }
  async function ai(prompt) {
    const token = await P().accessToken();
    const r = await fetch(P().AI_PROXY_URL, { method: 'POST', headers: { Authorization: `Bearer ${token}`, apikey: P().SUPABASE_ANON_KEY, 'Content-Type': 'application/json', ...(P().deviceHeader ? P().deviceHeader() : {}) }, body: JSON.stringify({ messages: [{ role: 'user', content: prompt }] }) });
    const j = await r.json().catch(() => ({}));
    const text = j && j.data && j.data.choices && j.data.choices[0] && j.data.choices[0].message && j.data.choices[0].message.content;
    if (!r.ok || !text) throw new Error((j && j.error) || `The model didn't answer (HTTP ${r.status}).`);
    const m = String(text).match(/\{[\s\S]*\}/);
    return JSON.parse(m ? m[0] : text);
  }
  async function tell(bot, text) {
    if (!document.hidden) return; // you're looking at it
    try { await fn('reminders', { action: 'create', reminder: { text: short(text, 480), due_at: new Date().toISOString(), kind: 'remind', tz: Intl.DateTimeFormat().resolvedOptions().timeZone, bot_id: bot && bot.id, bot_name: bot && bot.name, bot_voice: (bot && bot.voice) || null } }); } catch {}
  }

  // The same reading the PC does (bots-mail.js triagePrompt), so a bot answers the same way from either.
  function triagePrompt(bot, { via, from, subject, text, owner }) {
    return `You are ${bot.name}${bot.specialty ? `, ${bot.specialty}` : ''}, the AI assistant of ${owner || 'the user'}.
${via === 'email' ? 'This email came to your own address (not the user\'s).' : 'This Slack message was sent to the user.'}

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

  // ─── Tasks: run in the cloud with the bot, answer where it came from ────────
  async function startTask(item, bot) {
    const env = P().cloudEnvForBots && P().cloudEnvForBots();
    if (!env) { item.state = 'blocked'; item.note = 'Codeply Cloud isn’t set up, so this task waits for your PC.'; return; }
    try {
      const { task } = await P().startCloudTask({ prompt: item.text, bot: bot.prompt ? { name: bot.name, prompt: bot.prompt } : null, kind: 'task', env });
      item.state = 'running'; item.task = task; item.repo = env.repo; item.note = 'Working on it in the cloud';
    } catch (e) { item.state = 'failed'; item.note = e.message; }
  }
  async function followTasks() {
    const envs = (P().state && P().state.envs) || {};
    for (const item of st.items.filter((i) => i.state === 'running' && i.task)) {
      const env = envs[item.repo] || (P().cloudEnvForBots && P().cloudEnvForBots());
      if (!env) continue;
      try { await P().pollCloudTask(env, item.task); } catch { continue; }
      const t = item.task;
      if (t.status !== 'done' && t.status !== 'failed' && t.status !== 'cancelled') continue;
      const bot = botById(item.botId) || lead();
      const result = t.status === 'done' ? (t.reply || t.answer || 'Done.') : `I couldn't finish it: ${t.error || 'the cloud run failed.'}`;
      item.state = t.status === 'done' ? 'done' : 'failed';
      item.note = short(result, 300);
      try { await answerTask(item, bot, result); item.answered = true; } catch (e) { item.note += ` (couldn't send the answer: ${e.message})`; }
      await tell(bot, `${t.status === 'done' ? 'Done' : 'Stuck'}: ${short(item.text, 80)}`);
    }
    save();
  }
  async function answerTask(item, bot, text) {
    if (item.kind === 'mail' && item.from) {
      await fn('bot-mail', { action: 'send', botId: bot.id, to: item.from, subject: /^re:/i.test(item.subject || '') ? item.subject : `Re: ${item.subject || 'your task'}`, text: short(text, 6000), inReplyTo: item.messageId || '', references: item.messageId || '', key: Date.now().toString(36) });
    } else if (item.kind === 'slack' && item.channel) {
      await slackPost(item.channel, text, item.ts, `${bot.name} (assistant)`);
    }
  }
  async function slackPost(channel, text, threadTs, asName) {
    const s = (await P().accountConnections()).slack;
    if (!s || !s.accessToken) throw new Error('Slack isn’t connected to your account.');
    // A form post: Slack answers browsers when the token is in the body, not a header.
    const body = new URLSearchParams({ token: s.accessToken, channel, text: short(text, 3800), ...(threadTs ? { thread_ts: threadTs } : {}), ...(asName ? { username: asName } : {}) });
    const r = await fetch('https://slack.com/api/chat.postMessage', { method: 'POST', body });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw new Error(`Slack said ${j.error || r.status}`);
  }

  // ─── Coming in ─────────────────────────────────────────────────────────────
  async function handleMail(m) {
    if (st.items.some((i) => i.id === `mail:${m.id}`)) return;
    const bot = botById(m.botId) || lead();
    if (!bot) return;
    const item = { id: `mail:${m.id}`, kind: 'mail', botId: bot.id, from: m.from, fromName: m.fromName, subject: m.subject, text: short(m.text, 6000), messageId: m.messageId, mailId: m.id, at: Date.parse(m.at) || Date.now(), state: 'new' };
    st.items.push(item);
    if (m.fromUser) { item.text = `${m.subject ? `${m.subject}\n\n` : ''}${m.text}`.trim(); await startTask(item, bot); save(); return; }
    try {
      const t = await ai(triagePrompt(bot, { via: 'email', from: m.fromName ? `${m.fromName} <${m.from}>` : m.from, subject: m.subject, text: m.text }));
      item.summary = short(t.summary, 300); item.draft = t.needsReply !== false && !t.spam ? String(t.reply || '').slice(0, 6000) : ''; item.spam = !!t.spam;
      item.state = item.draft ? 'draft' : 'seen';
    } catch (e) { item.state = 'seen'; item.note = `Couldn't read it with the model: ${e.message}`; }
    save();
    if (!item.spam) await tell(bot, `Email from ${m.fromName || m.from}: ${item.summary || m.subject}${item.draft ? '. A reply is drafted.' : ''}`);
  }
  async function handleSlack(ev) {
    if (st.items.some((i) => i.id === `slack:${ev.id}`)) return;
    const s = (await P().accountConnections().catch(() => ({}))).slack || {};
    const text = String(ev.text || '').replace(/<@([A-Z0-9]+)>/g, (m0, id) => (id === s.botUserId ? '' : id === s.userId ? '@you' : m0)).trim();
    const item = { id: `slack:${ev.id}`, kind: 'slack', text: short(text, 3000), channel: ev.channel, ts: ev.threadTs || ev.ts, at: Date.parse(ev.at) || Date.now(), url: `https://app.slack.com/client/${encodeURIComponent(ev.teamId || s.teamId || '')}/${encodeURIComponent(ev.channel)}`, state: 'new' };
    if (ev.kind === 'command') {
      const team = bots(); const t = text.replace(/^\s*(hey|hi)\s+/i, '');
      const bot = team.find((b) => new RegExp(`^${b.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(t)) || lead();
      if (!bot) return;
      item.botId = bot.id; item.fromName = 'You, on Slack'; st.items.push(item);
      await startTask(item, bot); save(); return;
    }
    const bot = lead();
    if (!bot) return;
    let who = ev.user || 'Someone';
    try { const r = await fetch('https://slack.com/api/users.info', { method: 'POST', body: new URLSearchParams({ token: s.accessToken, user: ev.user }) }); const j = await r.json(); if (j.ok) who = (j.user.profile && (j.user.profile.display_name || j.user.profile.real_name)) || j.user.name || who; } catch {}
    item.botId = bot.id; item.fromName = who; st.items.push(item);
    try {
      const t = await ai(triagePrompt(bot, { via: 'slack', from: item.fromName, text }));
      item.summary = short(t.summary, 300); item.draft = t.needsReply !== false && !t.spam ? String(t.reply || '').slice(0, 4000) : ''; item.spam = !!t.spam;
      item.state = item.draft ? 'draft' : 'seen';
    } catch (e) { item.state = 'seen'; item.note = `Couldn't read it with the model: ${e.message}`; }
    save();
    if (!item.spam) await tell(bot, `${item.fromName} on Slack: ${item.summary || short(text, 120)}`);
  }

  /** Checks the bots' inboxes. Only while the PC is offline (online, the PC handles them) and not paused. */
  async function poll(force) {
    if (polling || st.paused || pcOnline()) return;
    if (!force && Date.now() - lastPoll < 110000) return;
    polling = true; lastPoll = Date.now(); error = '';
    try {
      if (!(await P().accessToken())) return;
      const team = bots();
      if (team.some((b) => b.email && b.email.address)) {
        const r = await fn('bot-mail', { action: 'inbox' });
        for (const m of r.mail || []) { try { await handleMail(m); } catch (e) { console.warn('[bots] mail:', e.message); } }
      }
      const conns = await P().accountConnections().catch(() => ({}));
      if (conns.slack && conns.slack.accessToken && team.length) {
        const r = await fn('slack-events', { action: 'inbox' }).catch((e) => (/not found|404|Unknown action|not linked/i.test(e.message) ? { events: [] } : Promise.reject(e)));
        for (const ev of r.events || []) { try { await handleSlack(ev); } catch (e) { console.warn('[bots] slack:', e.message); } }
      }
      await followTasks();
    } catch (e) { error = e.signedOut ? '' : `Couldn't check your bots' inboxes: ${e.message}`; }
    finally { polling = false; save(); paint(); }
  }

  // ─── The card in Voice mode (where the PC's "Bots at work" shows when it's online) ─
  const WHEN = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  function html() {
    const open = st.items.filter((i) => !i.done && (i.state === 'draft' || i.state === 'running' || i.state === 'blocked' || ((i.state === 'done' || i.state === 'failed') && Date.now() - i.at < 3 * 86400000) || (i.state === 'seen' && !i.spam && Date.now() - i.at < 86400000))).slice(-12).reverse();
    const name = (id) => (botById(id) || {}).name || 'A bot';
    const head = `<div class="life-head"><strong>Bots at work</strong>${st.paused ? '<button type="button" class="life-btn" data-bw="resume">Resume</button>' : '<button type="button" class="life-btn danger" data-bw="stop">Stop all bots</button>'}</div>`;
    const status = st.paused ? 'All bots are stopped on this phone. Nothing is checked or run until you resume.'
      : 'Your PC is offline, so your bots work from this phone: they read their email and Slack, and run your tasks in the cloud. They ask before sending anything.';
    return `<div class="life-card">${head}<p class="calls-status">${esc(status)}</p>${error ? `<p class="calls-status err">${esc(error)}</p>` : ''}
      ${open.map((i) => `<div class="life-row bw-row"><span class="bot-main"><strong>${esc(i.kind === 'mail' ? (i.subject || '(no subject)') : short(i.text, 90))}</strong>
        <small>${esc(name(i.botId))} · ${esc(i.kind === 'mail' ? `email from ${i.fromName || i.from}` : `Slack · ${i.fromName || ''}`)} · ${esc(WHEN(i.at))}</small>
        ${i.summary ? `<small>${esc(i.summary)}</small>` : ''}${i.note ? `<small class="${i.state === 'failed' ? 'err' : ''}">${esc(i.note)}</small>` : ''}
        ${i.state === 'draft' ? `<textarea class="bw-draft" data-draft="${esc(i.id)}" rows="4">${esc(i.draft)}</textarea>` : ''}</span>
        <span class="bw-acts">${i.state === 'draft' ? (i.kind === 'mail' ? `<button type="button" class="life-btn" data-send="${esc(i.id)}">Send</button>` : `<button type="button" class="life-btn" data-copy="${esc(i.id)}">Copy reply</button>`) : i.state === 'running' ? '<span class="spinner"></span>' : ''}
        ${i.url ? `<a class="life-btn" href="${esc(i.url)}" target="_blank" rel="noopener">Open</a>` : ''}<button type="button" class="life-btn danger" data-dismiss="${esc(i.id)}">${i.state === 'running' ? 'Hide' : 'Dismiss'}</button></span></div>`).join('')}
      ${open.length ? '' : '<p class="calls-status">Nothing waiting right now.</p>'}</div>`;
  }
  function paint() {
    if (!mounted || !mounted.isConnected) { mounted = null; return; }
    mounted.innerHTML = html();
    mounted.querySelectorAll('[data-bw]').forEach((b) => b.addEventListener('click', () => { st.paused = b.dataset.bw === 'stop'; save(); paint(); if (!st.paused) poll(true); }));
    mounted.querySelectorAll('[data-dismiss]').forEach((b) => b.addEventListener('click', () => { const i = st.items.find((x) => x.id === b.dataset.dismiss); if (i) i.done = true; save(); paint(); }));
    mounted.querySelectorAll('[data-draft]').forEach((t) => t.addEventListener('input', () => { const i = st.items.find((x) => x.id === t.dataset.draft); if (i) { i.draft = t.value; save(); } }));
    // A Slack draft is for you to send as yourself (bots never post as you): copy it, then Open.
    mounted.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
      const i = st.items.find((x) => x.id === b.dataset.copy); if (!i) return;
      try { await navigator.clipboard.writeText(i.draft || ''); b.textContent = 'Copied'; } catch { b.textContent = 'Copy failed'; }
    }));
    mounted.querySelectorAll('[data-send]').forEach((b) => b.addEventListener('click', async () => {
      const i = st.items.find((x) => x.id === b.dataset.send); if (!i) return;
      const bot = botById(i.botId) || lead();
      b.disabled = true; b.textContent = 'Sending…';
      try {
        await fn('bot-mail', { action: 'send', botId: bot.id, to: i.from, subject: /^re:/i.test(i.subject || '') ? i.subject : `Re: ${i.subject || ''}`, text: i.draft, inReplyTo: i.messageId || '', references: i.messageId || '', key: Date.now().toString(36) });
        i.state = 'seen'; i.done = true; i.note = 'Sent';
      } catch (e) { i.note = `Not sent: ${e.message}`; b.disabled = false; b.textContent = 'Try again'; }
      save(); paint();
    }));
  }
  function mount(el) { if (!el) return; mounted = el; paint(); poll(true); }

  setInterval(() => { if (!document.hidden) poll(false); }, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(true); });
  setTimeout(() => poll(true), 4000);

  window.CraftBots = { mount, poll, state: () => st };
})();
