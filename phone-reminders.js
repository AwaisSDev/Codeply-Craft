// Reminders from your bots: they remind you, plan your day and "call" you.
//
// A bot sets a reminder on a call or in a chat by writing a tag the user never
// hears or sees:
//   [[REMIND: <ISO 8601 local time with offset> | <none|daily|weekdays|weekly> | <call|remind|task> | <text>]]
// On calls the voice server (voice-turn) takes the tag out of the speech and
// sends it as a "remind" event; in a chat it is taken out of the reply here.
// Either way it is saved through Codeply's reminders function. When it is due,
// reminders-tick sends a Web Push; phone-sw.js shows it, and tapping it opens
// this app at /?call=<id>: an incoming call from that bot, who speaks first.
//
// A web app cannot make the phone ring like a real call: it is a notification
// that opens the call screen. On iPhone, push needs iOS 16.4+ and the app added
// to the Home Screen.
//
// Loaded before phone-calls.js (which builds its call rules from RULES here).
(() => {
  const P = window.CraftPhone;
  if (!P) return;
  const { esc, load, save } = P;
  const $ = (id) => document.getElementById(id);
  const FN = String(P.AI_PROXY_URL || '').replace(/\/ai-proxy$/, '');
  // Only the public half of the VAPID key pair lives here (the server signs with the private one).
  const VAPID_PUBLIC_KEY = 'BCTDfO2a3WXFjHjBURG2DVOaiPQwsgzGYztYT9nqHvh6T9eWpDEf6AlJ6nh4E1FCi6f9iUCWBncF08BeJPYM8co';
  const KEY = { list: 'craft-phone-reminders', card: 'craft-phone-remind-card', sub: 'craft-phone-push-sub' };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let list = load(KEY.list, []);
  let listError = '';
  let mounted = null; // { card, box }
  let lastRefresh = 0;

  // ─── The reminders function ───────────────────────────────────────────────
  async function call(fn, body) {
    const token = await P.accessToken();
    const res = await fetch(`${FN}/${fn}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, apikey: P.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) throw Object.assign(new Error(data.error || `Reminders failed (${res.status}).`), { status: res.status });
    return data;
  }
  const api = {
    list: () => call('reminders', { action: 'list' }).then((d) => d.reminders || []),
    get: (id) => call('reminders', { action: 'get', id }).then((d) => d.reminder),
    create: (reminder) => call('reminders', { action: 'create', reminder }).then((d) => d.reminder),
    update: (id, patch) => call('reminders', { action: 'update', id, patch }).then((d) => d.reminder),
    remove: (id) => call('reminders', { action: 'delete', id }),
    snooze: (id, minutes = 10) => call('reminders', { action: 'snooze', id, minutes }).then((d) => d.reminder),
  };

  // ─── What the model is told ───────────────────────────────────────────────
  const tz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; } };
  const pad = (n) => String(n).padStart(2, '0');
  function localIso(d = new Date()) {
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    const a = Math.abs(off);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
  }
  /** The user's own date, time and zone, so "at 5" or "tomorrow morning" can be worked out. */
  function nowContext() {
    const d = new Date();
    const said = d.toLocaleString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const day = (x) => `${x.toLocaleDateString('en-US', { weekday: 'long' })} ${localIso(x).slice(0, 10)}`;
    const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 12);
    return `NOW\nFor the user it is ${said} (local time ${localIso(d)}${tz() ? `, time zone ${tz()}` : ''}). Today is ${day(d)}; tomorrow is ${day(next)}. Anything later today ("tonight", "at 7" when it is not 7 yet) is on today's date.`;
  }
  const TAG_SPEC = '[[REMIND: <local date and time as ISO 8601 with the UTC offset from NOW, like 2026-10-03T17:00:00+05:00> | <none, daily, weekdays or weekly> | <call, remind or task> | <a few words on what it is about, like take your medicine or call mom, never starting with remind me>]]';
  const WHEN_RULE = 'Work the time out from NOW: "at 5" is the next 5 o\'clock still ahead, "in 20 minutes" counts from now, morning is 9 am, afternoon 2 pm, evening 7 pm, tonight 9 pm. If the time is really unclear, ask once instead.';
  /** Lines for the call rules (phone-calls.js STREAM_RULES). */
  const RULES = `- Reminders and calling them back: when the user asks you to remind them, call them, check in on them later or do something at a set time, say a short natural confirmation with the time said the way people say it, then on a new line write ${TAG_SPEC}. Use call when they want you to call them, task only for work you do yourself with your tools at that time (like summarizing their email; the last part is then the task), and remind for anything they do themselves. ${WHEN_RULE} Never say the tag or the ISO time out loud.
- Planning their day: if they ask you to plan their day, ask one or two quick questions only if you need to (what they have to get done, anything at a fixed time), then suggest a short plan out loud in a few spoken sentences with times, and ask if that works. Only after they say yes, say one short sentence that it is all set, then write one [[REMIND: ...]] line per item (remind, or call if they want calls).`;
  /** The same for a typed chat (phone.js chat mode). */
  const CHAT_RULES = `\n\nREMINDERS\nThis app can remind the user and call them back. When they ask for a reminder, a call later, or a plan for their day that they agree to, confirm it in plain words and add one line per reminder at the very end of your reply: ${TAG_SPEC}. Use call when they want a call, task only for work Codeply should do itself then, and remind for anything they do themselves. ${WHEN_RULE} The app turns these lines into reminders and hides them. For a day plan, propose it first and only add the lines once they say yes.`;
  const voiceRules = () => `\n\n${nowContext()}`;
  const chatRules = () => `${CHAT_RULES}\n\n${nowContext()}`;

  // ─── Tags -> reminders ────────────────────────────────────────────────────
  const TAG = /\[\[\s*REMIND\s*:\s*([\s\S]*?)\]\]/gi;
  function parseTag(inner) {
    const [at, repeat, kind, ...text] = String(inner).split('|').map((x) => x.trim());
    return { at, repeat, kind, text: text.join(' | ') };
  }
  /** A reply's text without the tags, and the reminders they asked for. */
  function extract(text) {
    const reminds = [];
    const clean = String(text || '').replace(TAG, (_, inner) => { reminds.push(parseTag(inner)); return ''; }).replace(/\n{3,}/g, '\n\n').trim();
    return { text: clean, reminds };
  }
  function fromTag(t, bot) {
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
  /** Save one tag's reminder; resolves to the saved row, rejects with a plain message. */
  async function createFromTag(t, bot) {
    const r = await api.create(fromTag(t, bot));
    list = [...list.filter((x) => x.id !== r.id), r].sort((a, b) => Date.parse(a.due_at) - Date.parse(b.due_at));
    save(KEY.list, list);
    paint();
    return r;
  }

  // ─── Push: permission, subscription ──────────────────────────────────────
  const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = () => navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  function iosVersion() {
    const m = /OS (\d+)_(\d+)/.exec(navigator.userAgent);
    return m ? Number(m[1]) + Number(m[2]) / 100 : 0;
  }
  /** 'ask' | 'granted' | 'denied' | 'ios-install' | 'ios-old' | 'unsupported' */
  function pushState() {
    if (IS_IOS && iosVersion() && iosVersion() < 16.04) return 'ios-old';
    if (IS_IOS && !standalone()) return 'ios-install';
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return IS_IOS ? 'ios-old' : 'unsupported';
    if (Notification.permission === 'denied') return 'denied';
    if (Notification.permission === 'granted') return 'granted';
    return 'ask';
  }
  function keyBytes(b64) {
    const s = (b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(s);
    return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  }
  async function swReg() {
    if (!('serviceWorker' in navigator)) throw new Error('No service worker here.');
    let reg = await navigator.serviceWorker.getRegistration();
    if (!reg) reg = await navigator.serviceWorker.register('phone-sw.js', { scope: './' });
    return Promise.race([navigator.serviceWorker.ready, sleep(8000).then(() => { throw new Error('The service worker did not start.'); })]);
  }
  /** Subscribe this phone (permission already granted) and tell Codeply where to reach it. */
  async function subscribe(force) {
    const reg = await swReg();
    let sub = await reg.pushManager.getSubscription();
    const opts = { userVisibleOnly: true, applicationServerKey: keyBytes(VAPID_PUBLIC_KEY) };
    if (!sub) {
      try { sub = await reg.pushManager.subscribe(opts); } catch (e) {
        // An old subscription made with another key: start over.
        const old = await reg.pushManager.getSubscription();
        if (!old) throw e;
        await old.unsubscribe();
        sub = await reg.pushManager.subscribe(opts);
      }
    }
    const j = sub.toJSON();
    const last = load(KEY.sub, {});
    if (!force && last.endpoint === j.endpoint && Date.now() - (last.at || 0) < 12 * 3600 * 1000) return true;
    await call('push-subscribe', { subscription: { endpoint: j.endpoint, keys: j.keys }, userAgent: navigator.userAgent });
    save(KEY.sub, { endpoint: j.endpoint, at: Date.now() });
    return true;
  }
  /** From the Allow tap: ask (iOS only asks from a tap), then subscribe. */
  async function enablePush(btn) {
    if (btn) { btn.disabled = true; btn.textContent = 'Allowing...'; }
    let perm = 'default';
    try { perm = await Notification.requestPermission(); } catch { perm = Notification.permission; }
    if (perm === 'granted') {
      try { await subscribe(true); save(KEY.card, 'done'); } catch (e) { listError = `Couldn't turn on reminders: ${e.message}`; }
    }
    paint();
  }

  // ─── The Calls area: a one-time card, and the upcoming reminders ─────────
  const ICON_X = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  function whenLabel(iso) {
    const d = new Date(iso); const now = new Date();
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day(d) - day(now)) / 86400000);
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (diff === 0) return `Today ${time}`;
    if (diff === 1) return `Tomorrow ${time}`;
    if (diff > 1 && diff < 7) return `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
    return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
  }
  const KIND_LABEL = { call: 'Call', remind: 'Reminder', task: 'Task' };
  const REPEAT_LABEL = { daily: 'Every day', weekdays: 'Weekdays', weekly: 'Every week' };
  function avatarFor(r, size) {
    const bot = botFor(r);
    try { if (window.CraftAvatar && bot.avatar) return window.CraftAvatar.renderAvatar(bot.avatar, size, { still: true, flat: true }); } catch {}
    return `<span class="av-fallback" style="width:${size}px;height:${size}px;background:var(--accent);font-size:${Math.round(size * 0.42)}px">${esc(String(bot.name || 'C').trim()[0] || 'C').toUpperCase()}</span>`;
  }
  const HINTS = {
    'ios-install': 'To get reminders and calls from your bots on iPhone, add Codeply to your Home Screen (Share, then Add to Home Screen) and open it from there.',
    'ios-old': 'Reminders from your bots need iOS 16.4 or later. Update your iPhone to get them.',
    unsupported: "This browser can't show reminders from your bots. Open Codeply in Chrome, or add it to your Home Screen.",
    denied: "Notifications are off for Codeply, so your bots can't remind you. Turn them on in your phone's settings.",
  };
  function cardHtml() {
    const st = pushState();
    const seen = load(KEY.card, '');
    if (st === 'granted' || seen === 'done' || seen === st) return '';
    if (st === 'ask') {
      return `<div class="rem-card"><div class="rem-card-main"><strong>Let your bots remind you</strong>
        <small>They can send you a reminder, or call you, at the time you ask for.</small></div>
        <div class="rem-card-row"><button type="button" class="btn btn-quiet" data-rc="later">Not now</button><button type="button" class="btn btn-primary" data-rc="allow">Allow</button></div></div>`;
    }
    return `<div class="rem-hint"><span>${esc(HINTS[st] || '')}</span><button type="button" class="rem-x" data-rc="hide" aria-label="Hide">${ICON_X}</button></div>`;
  }
  function listHtml() {
    const now = Date.now();
    const up = list.filter((r) => (r.status === 'pending' || r.status === 'snoozed') && Date.parse(r.due_at) > now - 60000);
    let html = '<div class="calls-label">Reminders</div>';
    if (listError) html += `<p class="calls-status err">${esc(listError)}</p>`;
    if (!up.length) return `${html}<p class="calls-none">None yet. On a call, say "remind me at 5" or "plan my day".</p>`;
    html += '<div class="calls-list">';
    for (const r of up) {
      const sub = [whenLabel(r.due_at), KIND_LABEL[r.kind] || '', REPEAT_LABEL[r.repeat] || '', r.status === 'snoozed' ? 'Snoozed' : ''].filter(Boolean).join(' · ');
      html += `<div class="bot-row rem-row">
        <span class="bot-av rem-av">${avatarFor(r, 36)}</span>
        <span class="bot-main"><strong>${esc(r.text)}</strong><small>${esc(r.bot_name || 'Codeply')} · ${esc(sub)}</small></span>
        <button type="button" class="rem-x" data-rdel="${esc(r.id)}" aria-label="Delete reminder">${ICON_X}</button>
      </div>`;
    }
    return `${html}</div>`;
  }
  function paint() {
    if (!mounted || !mounted.box.isConnected) { mounted = null; return; }
    mounted.card.innerHTML = cardHtml();
    mounted.box.innerHTML = listHtml();
    mounted.card.querySelectorAll('[data-rc]').forEach((b) => b.addEventListener('click', () => {
      const v = b.dataset.rc;
      if (v === 'allow') { enablePush(b); return; } // requestPermission runs inside this tap
      save(KEY.card, v === 'later' ? 'ask' : pushState());
      paint();
    }));
    mounted.box.querySelectorAll('[data-rdel]').forEach((b) => b.addEventListener('click', async () => {
      const id = b.dataset.rdel;
      b.disabled = true;
      try {
        await api.remove(id);
        list = list.filter((r) => r.id !== id);
        save(KEY.list, list);
        listError = '';
      } catch (e) { listError = e.message; }
      paint();
    }));
  }
  async function refresh() {
    try { list = await api.list(); save(KEY.list, list); listError = ''; } catch (e) { if (e.status !== 401) listError = navigator.onLine === false ? '' : e.message; }
    paint();
  }
  /** phone-calls.js renders the Calls panel and gives us two spots in it. */
  function mount(card, box) {
    if (!card || !box) return;
    mounted = { card, box };
    paint();
    // The Calls panel repaints often (bots arriving from the PC): fetch at most every 15 s.
    if (Date.now() - lastRefresh > 15000) { lastRefresh = Date.now(); refresh(); }
    if (pushState() === 'granted') subscribe(false).catch(() => {});
  }

  // ─── A bot calling you ────────────────────────────────────────────────────
  function botFor(r) {
    const C = window.CraftCalls;
    const known = C && C.cache && r.bot_id ? C.cache.bots.find((b) => b.id === r.bot_id) : null;
    if (known) return known;
    return { id: r.bot_id || `codeply-${r.bot_name || 'bot'}`, name: r.bot_name || 'Codeply', voice: r.bot_voice || '', avatar: null };
  }
  const phrase = (t) => {
    const s = String(t || '').trim().replace(/[.!?]+$/, '').replace(/^(please\s+)?remind (me|you|them)\s+(to|about|that)\s+/i, '');
    return /^[A-Z][a-z]/.test(s) && !/^I\b/.test(s) ? s[0].toLowerCase() + s.slice(1) : s;
  };
  // An always-on bot found an important email (bots-watch.js on the PC, or mail-watch-tick in the cloud).
  const mailOf = (r) => (r && r.payload && r.payload.mail && typeof r.payload.mail === 'object' ? r.payload.mail : null);
  function openingFor(r, bot, env) {
    const name = bot.name || 'Codeply';
    const t = phrase(r.text);
    const mail = mailOf(r);
    if (mail) {
      return mail.drafted
        ? `Hey, it's ${name}. You got an email from ${mail.from || 'someone'} about ${mail.subject || 'something'} that looked important, so I drafted a reply. It's in your Gmail drafts.`
        : `Hey, it's ${name}. You got an important email from ${mail.from || 'someone'} about ${mail.subject || 'something'}.`;
    }
    if (r.kind === 'task') {
      return env && env.canWork
        ? `Hey, it's ${name}. It's time for the task you gave me, ${t}, so I'm getting started on it now.`
        : `Hey, it's ${name}. It's time for the task you gave me, ${t}.`;
    }
    const lines = [
      `Heyyy, it's ${name}! Just wanted to remind you, ${t}.`,
      `Hey you, it's ${name}. Quick reminder, ${t}.`,
      `Hi, it's ${name}! You asked me to remind you, ${t}.`,
    ];
    return lines[Math.floor(Math.random() * lines.length)];
  }
  function contextFor(r) {
    const mail = mailOf(r);
    if (mail) {
      return `THIS CALL\nYou called the user yourself because an important email arrived while you watched their inbox.\nFrom: ${mail.from}\nSubject: ${mail.subject}\nSummary: ${mail.summary || '(none)'}\n` +
        (mail.drafted ? `You saved this reply as a draft in their Gmail (not sent):\n${mail.reply || '(not shown)'}\n` : '') +
        'You already said your opening line. Answer their questions about it, read the draft out if they ask, and say they can open it in Gmail to edit and send. You cannot send it yourself. Keep it short.';
    }
    if (r.kind === 'task') {
      return `THIS CALL\nYou called the user yourself because it is time for a task they scheduled with you: "${r.text}". You have just said you are starting on it. Keep it short and warm.`;
    }
    return `THIS CALL\nYou called the user yourself because of a reminder they asked for: "${r.text}"${r.repeat ? ` (it repeats: ${r.repeat})` : ''}. You already said your opening line about it. Keep it short and warm. If they want to be reminded again later ("in 10 minutes", "tonight"), write a new [[REMIND: ...]] for that time with the same text, kind call. If they say it's done or thank you, wrap up kindly.`;
  }
  let opening = '';
  async function closeNotification(id) {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) return;
      for (const n of await reg.getNotifications({ tag: `reminder-${id}` })) n.close();
    } catch {}
  }
  /** Show the incoming call for a reminder (from the URL, the service worker, or a push while open). */
  async function openReminder(id, data) {
    const C = window.CraftCalls;
    if (!id || !C || opening === id || (C.active && C.active())) return;
    opening = id;
    let r = null;
    try { r = await api.get(id); } catch {}
    if (!r && data) r = { id, text: data.body || '', kind: data.kind || 'remind', bot_id: data.botId || null, bot_name: data.title || 'Codeply', bot_voice: data.botVoice || null, repeat: null, payload: {} };
    if (!r) { opening = ''; return; }
    const bot = botFor(r);
    const work = r.kind === 'task' ? String((r.payload && r.payload.task) || r.text) : null;
    closeNotification(id);
    C.incoming(bot, {
      reminder: r,
      preview: r.text,
      opening: (env) => openingFor(r, bot, env),
      context: contextFor(r),
      work,
      onAnswer: () => {
        opening = '';
        if (!r.repeat && r.status !== 'done') api.update(r.id, { status: 'done' }).catch(() => {});
      },
      onDecline: () => { opening = ''; },
    });
  }
  async function fromUrl() {
    const params = new URLSearchParams(location.search);
    const id = params.get('call');
    if (!id) return;
    try { history.replaceState(null, '', location.pathname); } catch {}
    // Wait for the sign-in to come back (phone.js restores it on load).
    for (let i = 0; i < 60; i++) {
      try { await P.accessToken(); break; } catch { if (i === 59) return; await sleep(250); }
    }
    while (!window.CraftCalls) await sleep(50);
    openReminder(id);
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (e) => {
      const m = e.data || {};
      if (m.type === 'codeply-reminder-open') openReminder(m.id, m.data);
      else if (m.type === 'codeply-push' && m.data && m.data.reminderId) {
        if (document.visibilityState === 'visible') openReminder(m.data.reminderId, m.data);
        if (mounted) refresh();
      }
    });
  }
  fromUrl();

  window.CraftReminders = {
    api, RULES, voiceRules, chatRules, nowContext, extract, fromTag, createFromTag, pushState, enablePush, subscribe,
    mount, refresh, openReminder, whenLabel, list: () => list, VAPID_PUBLIC_KEY,
  };
})();
