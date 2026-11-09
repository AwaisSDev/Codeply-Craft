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
    paint(); badge();
    return r;
  }

  // ─── Asked in plain words ─────────────────────────────────────────────────
  // "remind me in 2 minutes: test", "notify me after 5 mins", "call me at 7pm about the report",
  // "remind me to drink water every day at 9": the app sets these itself, so a reminder never depends on
  // the model remembering to write its [[REMIND]] line. Returns a tag ({ at, repeat, kind, text }) or null.
  const NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fifteen: 15, twenty: 20, thirty: 30, forty: 40, 'forty-five': 45, fifty: 50, sixty: 60 };
  const UNIT = (u) => (/^s/.test(u) ? 1000 : /^(m|min)/.test(u) ? 60000 : /^h/.test(u) ? 3600000 : 86400000);
  function parseAsk(raw) {
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
    // Calls and texts that already went out today (a bot's "call me now").
    const DONE_LABEL = { call: 'Called you', remind: 'Texted you', task: 'Started your task' };
    const past = list.filter((r) => (r.status === 'sent' || r.status === 'done') && now - Date.parse(r.sent_at || r.due_at) < 24 * 3600000)
      .sort((a, b) => Date.parse(b.sent_at || b.due_at) - Date.parse(a.sent_at || a.due_at)).slice(0, 10);
    const pastHtml = past.length ? '<div class="calls-label">Earlier</div><div class="calls-list">' + past.map((r) => {
      const at = new Date(r.sent_at || r.due_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      return `<div class="bot-row rem-row rem-past">
        <span class="bot-av rem-av">${avatarFor(r, 36)}</span>
        <span class="bot-main"><strong>${esc(r.text)}</strong><small>${esc(r.bot_name || 'Codeply')} · ${esc(DONE_LABEL[r.kind] || 'Sent')} · ${esc(at)}</small></span>
        <button type="button" class="rem-x" data-rdel="${esc(r.id)}" aria-label="Remove">${ICON_X}</button>
      </div>`;
    }).join('') + '</div>' : '';
    if (!up.length) return `${html}<p class="calls-none">Nothing coming up. Add one above, or say "remind me at 5: call mom" in any chat.</p>${pastHtml}`;
    html += '<div class="calls-list">';
    for (const r of up) {
      const sub = [whenLabel(r.due_at), KIND_LABEL[r.kind] || '', REPEAT_LABEL[r.repeat] || '', r.status === 'snoozed' ? 'Snoozed' : ''].filter(Boolean).join(' · ');
      html += `<div class="bot-row rem-row">
        <span class="bot-av rem-av">${avatarFor(r, 36)}</span>
        <span class="bot-main"><strong>${esc(r.text)}</strong><small>${esc(r.bot_name || 'Codeply')} · ${esc(sub)}</small></span>
        <button type="button" class="rem-x" data-rdel="${esc(r.id)}" aria-label="Delete reminder">${ICON_X}</button>
      </div>`;
    }
    return `${html}</div>${pastHtml}`;
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
      paint(); badge();
    }));
  }
  async function refresh() {
    try { list = await api.list(); save(KEY.list, list); listError = ''; } catch (e) { if (e.status !== 401) listError = navigator.onLine === false ? '' : e.message; }
    paint(); badge();
  }
  const upcoming = () => list.filter((r) => (r.status === 'pending' || r.status === 'snoozed') && Date.parse(r.due_at) > Date.now() - 60000)
    .sort((a, b) => Date.parse(a.due_at) - Date.parse(b.due_at));
  /** The sidebar's count of what is coming up. */
  function badge() {
    const el = document.getElementById('remindersBadge');
    if (!el) return;
    const n = upcoming().length;
    el.textContent = n ? String(n) : '';
    el.classList.toggle('hidden', !n);
  }

  // ─── The Reminders screen (sidebar › Reminders) ───────────────────────────
  function openPanel() {
    const panel = document.getElementById('remindersPanel');
    if (!panel) return;
    if (window.CraftPhone && window.CraftPhone.closeDrawer) window.CraftPhone.closeDrawer();
    panel.parentNode.appendChild(panel); // on top of anything open
    panel.classList.remove('hidden');
    mount(document.getElementById('remCard'), document.getElementById('remList'));
    lastRefresh = Date.now(); refresh();
  }
  function wirePanel() {
    const btn = document.getElementById('drawerReminders');
    if (btn) btn.addEventListener('click', openPanel);
    const form = document.getElementById('remAdd');
    if (!form) return;
    const err = document.getElementById('remAddErr');
    const say = (m) => { err.textContent = m || ''; err.classList.toggle('hidden', !m); };
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const what = document.getElementById('remAddText').value.trim();
      const when = document.getElementById('remAddWhen').value.trim();
      if (!what || !when) { say('Write what to remember and when.'); return; }
      // the same reading as "remind me ...: ..." in a chat
      const w = /^(in|at|after|by|around|for|tomorrow|tonight|this|every|daily|weekdays|weekly|noon|midday)\b/i.test(when) ? when : `at ${when}`;
      const t = parseAsk(`remind me ${w}: ${what}`);
      if (!t) { say('Say when, like "in 10 minutes", "at 5pm" or "tomorrow at 9".'); return; }
      const b = document.getElementById('remAddBtn');
      b.disabled = true; say('');
      try {
        await createFromTag(t, null);
        document.getElementById('remAddText').value = ''; document.getElementById('remAddWhen').value = '';
        badge();
      } catch (x) { say(x.message); }
      b.disabled = false;
    });
  }
  setTimeout(() => { wirePanel(); badge(); }, 0);
  setTimeout(() => { refresh().catch(() => {}); }, 3500); // the sidebar count from the account, once signed in

  // ─── Cancel in plain words ────────────────────────────────────────────────
  // "cancel my test reminder", "delete all my reminders", "remove the last reminder", "don't remind me about
  // the meeting". Resolves null when the message is not about cancelling, else { done: [rows], note }.
  const CANCEL = /\b(cancel|delete|remove|clear|stop|turn off|get rid of|undo|scrap|drop)\b[^.?!\n]{0,60}\b(reminders?|alarms?|alerts?)\b|\b(reminders?)\b[^.?!\n]{0,30}\b(cancel|delete|remove|off)\b|\b(don'?t|do not|no need to) (remind|call|ping|notify) me\b/i;
  const STOP = new Set('a an the my me of to for about at in on and or please pls can could you u that this those these all every reminder reminders cancel delete remove clear stop turn off get rid undo scrap drop don dont do not no need remind call ping notify one ones last latest just set i is it its'.split(' '));
  async function cancelAsk(raw) {
    const t = String(raw || '').replace(/(^|\s)@[\w.-]+/g, ' ').trim();
    if (!CANCEL.test(t)) return null;
    try { list = await api.list(); save(KEY.list, list); } catch { /* the copy on this device */ }
    const up = upcoming();
    if (!up.length) return { done: [], note: 'There were no upcoming reminders to cancel.' };
    const low = t.toLowerCase();
    let pick = [];
    if (/\b(all|every|each)\b/.test(low)) pick = up;
    else if (/\b(last|latest|newest|just set|that one|the one you just)\b/.test(low)) {
      pick = [up.slice().sort((a, b) => Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0) || Date.parse(b.due_at) - Date.parse(a.due_at))[0]];
    } else {
      const words = low.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w));
      const score = (r) => words.filter((w) => String(r.text).toLowerCase().includes(w)).length;
      const best = Math.max(0, ...up.map(score));
      if (best > 0) pick = up.filter((r) => score(r) === best);
      else if (up.length === 1) pick = up;
    }
    if (!pick.length) return { done: [], note: `Which one? Coming up: ${up.slice(0, 6).map((r) => `"${r.text}" (${whenLabel(r.due_at)})`).join(', ')}.` };
    const done = [];
    for (const r of pick) { try { await api.remove(r.id); done.push(r); } catch { /* left as it was */ } }
    list = list.filter((r) => !done.some((d) => d.id === r.id));
    save(KEY.list, list); paint(); badge();
    return { done, note: done.length ? `Cancelled: ${done.map((r) => `"${r.text}" (${whenLabel(r.due_at)})`).join(', ')}.` : "Couldn't cancel it just now. Try again from Reminders in the menu." };
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
    // Codeply itself calls you now (voice mode); the bots are no longer separate voices.
    if (C && C.CODEPLY) return C.CODEPLY;
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
  async function openReminder(id, data, answer) {
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
      autoAnswer: !!answer,
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
    const answer = params.get('answer') === '1';
    if (!id) return;
    try { history.replaceState(null, '', location.pathname); } catch {}
    // Wait for the sign-in to come back (phone.js restores it on load).
    for (let i = 0; i < 60; i++) {
      try { await P.accessToken(); break; } catch { if (i === 59) return; await sleep(250); }
    }
    while (!window.CraftCalls) await sleep(50);
    openReminder(id, null, answer);
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (e) => {
      const m = e.data || {};
      if (m.type === 'codeply-reminder-open') openReminder(m.id, m.data, m.answer);
      else if (m.type === 'codeply-push' && m.data && m.data.reminderId) {
        if (document.visibilityState === 'visible') openReminder(m.data.reminderId, m.data);
        if (mounted) refresh();
      }
    });
  }
  fromUrl();

  // Keep this device's push address fresh on the server: on launch and whenever the app comes back,
  // not only from the Calls screen. iOS can drop or renew a subscription (a reinstall, a while unused),
  // and the server then sends to an address that goes nowhere until the app subscribes again.
  function keepPush() {
    if (pushState() !== 'granted') return;
    subscribe(false).catch((e) => console.debug('[reminders] push refresh:', e.message));
  }
  setTimeout(keepPush, 3000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') setTimeout(keepPush, 1500); });

  window.CraftReminders = {
    api, RULES, voiceRules, chatRules, nowContext, extract, fromTag, createFromTag, pushState, enablePush, subscribe, parseAsk, cancelAsk, openPanel,
    mount, refresh, openReminder, whenLabel, list: () => list, VAPID_PUBLIC_KEY,
  };
})();
