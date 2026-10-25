// Codeply Crew's native side, through Capacitor plugins:
//
//  Hearing on Android  The WebView's microphone + Whisper path does not hear
//                      reliably inside the Android app, so calls use the
//                      phone's own speech recognizer, dressed up as the
//                      browser's SpeechRecognition (window.CraftNativeSR,
//                      which phone-calls.js picks up). iPhone keeps the web path.
//  Agents reaching you Agents call or text you through Codeply's reminders
//                      (the reach_me tool, "call me at 5"). A native app gets
//                      no web push, so the app reads the reminders itself and
//                      turns them into phone notifications: upcoming ones are
//                      scheduled on the phone (they ring with the app closed),
//                      and ones that just went out show at once.
//
// Loaded before phone-calls.js, which reads window.CraftNativeSR at load.
'use strict';

(() => {
  const Cap = window.Capacitor;
  const native = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
  const platform = native ? Cap.getPlatform() : 'web';
  const plugin = (name) => (native && Cap.Plugins && Cap.Plugins[name]) || null;
  const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ─── Hearing: the phone's recognizer as SpeechRecognition ───────────────────
  // The plugin (Android SpeechRecognizer) reports "stopped" at the end of
  // speech and the final words just after it, and says nothing at all when
  // nobody spoke; so the final text waits a moment, and a watchdog ends a
  // session the recognizer gave up on.
  const SpeechPlugin = platform === 'android' ? plugin('SpeechRecognition') : null;
  class NativeSR {
    constructor() {
      this.lang = 'en-US'; this.continuous = false; this.interimResults = true; this.maxAlternatives = 1;
      this.onresult = null; this.onerror = null; this.onend = null;
      this._on = false; this._last = ''; this._subs = []; this._timer = null;
    }
    _emit(text, isFinal) {
      if (!text || !this.onresult) return;
      const result = Object.assign([{ transcript: text, confidence: 1 }], { isFinal });
      try { this.onresult({ resultIndex: 0, results: [result] }); } catch {}
    }
    async _finish() {
      if (!this._on) return;
      this._on = false;
      clearInterval(this._timer);
      for (const s of this._subs.splice(0)) { try { s.remove(); } catch {} }
      if (this._last) this._emit(this._last, true);
      this._last = '';
      if (this.onend) { try { this.onend(); } catch {} }
    }
    async start() {
      if (this._on) return;
      this._on = true;
      this._last = '';
      try {
        let p = await SpeechPlugin.checkPermissions();
        if (p.speechRecognition !== 'granted') p = await SpeechPlugin.requestPermissions();
        if (p.speechRecognition !== 'granted') { if (this.onerror) this.onerror({ error: 'not-allowed' }); this._finish(); return; }
        this._subs.push(await SpeechPlugin.addListener('partialResults', (d) => {
          const t = String((d && d.matches && d.matches[0]) || '').trim();
          if (t && this._on) { this._last = t; this._emit(t, false); }
        }));
        this._subs.push(await SpeechPlugin.addListener('listeningState', (d) => {
          if (d && d.status === 'stopped') setTimeout(() => this._finish(), 700); // the final words come just after
        }));
        await SpeechPlugin.start({ language: this.lang, maxResults: 1, partialResults: true, popup: false });
        const began = Date.now();
        this._timer = setInterval(async () => {
          if (!this._on || Date.now() - began < 1500) return;
          try { const r = await SpeechPlugin.isListening(); if (!r.listening) setTimeout(() => this._finish(), 700); } catch {}
        }, 900);
      } catch (e) {
        const m = String((e && e.message) || '');
        if (this.onerror) this.onerror({ error: /permission/i.test(m) ? 'not-allowed' : /busy/i.test(m) ? 'aborted' : 'no-speech' });
        this._finish();
      }
    }
    stop() { try { SpeechPlugin.stop(); } catch {} setTimeout(() => this._finish(), 700); }
    abort() { this.onresult = null; try { SpeechPlugin.stop(); } catch {} this._finish(); }
  }
  if (SpeechPlugin) window.CraftNativeSR = NativeSR;

  // ─── Agents reaching you: reminders as phone notifications ──────────────────
  const LN = plugin('LocalNotifications');
  const SEEN = 'crew-seen-reminders';
  let started = false;
  let syncing = false;

  /** A notification id from a reminder id (the plugin wants a 32-bit int). */
  function nid(id) {
    let h = 7;
    for (const ch of String(id)) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0;
    return Math.abs(h) % 2000000000 + 1;
  }
  const seenKey = (r) => `${r.id}@${r.due_at}`;
  const isCall = (r) => r.kind === 'call' || r.kind === 'task';
  function noteFor(r, at) {
    const who = r.bot_name || 'Codeply';
    return {
      id: nid(r.id),
      title: isCall(r) ? `${who} is calling` : who,
      body: isCall(r) ? (r.kind === 'task' ? `About: ${r.text}` : 'Incoming call. Tap to answer.') : r.text,
      largeBody: isCall(r) ? undefined : r.text,
      channelId: isCall(r) ? 'crew-calls' : 'crew-messages',
      actionTypeId: isCall(r) ? 'CREW_CALL' : undefined,
      smallIcon: 'ic_stat_crew',
      iconColor: '#4a80f5',
      schedule: at ? { at, allowWhileIdle: true } : undefined,
      extra: { crew: 1, reminderId: r.id, kind: r.kind, botId: r.bot_id || '', title: who, body: r.text, botVoice: r.bot_voice || '' },
    };
  }

  /** An agent's text lands in its chat, like a message you received. */
  function intoChat(r) {
    if (isCall(r) || !window.CrewApp) return;
    window.CrewApp.receive(r.bot_id, r.text, { id: `rem-${r.id}`, at: Date.parse(r.sent_at || r.due_at) || Date.now() });
  }
  /** Open what a notification is about: the incoming call, or the agent's chat. */
  function open(extra, answer) {
    if (!extra || !extra.reminderId) return;
    if (isCall(extra)) {
      const R = window.CraftReminders;
      if (R) R.openReminder(extra.reminderId, { body: extra.body, kind: extra.kind, botId: extra.botId, title: extra.title, botVoice: extra.botVoice }, !!answer);
    } else {
      intoChat({ id: extra.reminderId, bot_id: extra.botId, text: extra.body, kind: extra.kind });
      if (window.CrewApp && extra.botId) window.CrewApp.openThread(extra.botId);
    }
  }

  /** One that just went out (or is due now): ring or show it right away. */
  async function deliver(r) {
    intoChat(r);
    if (document.visibilityState === 'visible' && isCall(r) && window.CraftReminders) {
      window.CraftReminders.openReminder(r.id, null, false);
      return;
    }
    if (LN) { try { await LN.schedule({ notifications: [noteFor(r, new Date(Date.now() + 1000))] }); } catch {} }
  }

  async function sync() {
    const R = window.CraftReminders;
    if (!R || syncing) return;
    syncing = true;
    try {
      let list;
      try { list = await R.api.list(); } catch { return; }
      const now = Date.now();
      const seen = new Set(load(SEEN, []));
      const upcoming = new Map();
      for (const r of list) {
        const due = Date.parse(r.due_at);
        const waiting = r.status === 'pending' || r.status === 'snoozed';
        if (waiting && due > now + 15000 && due < now + 14 * 86400000) { upcoming.set(nid(r.id), r); continue; }
        // Went out in the last 15 minutes (the server sent it, or it is due now) and this phone never showed it.
        const at = Date.parse(r.sent_at || r.due_at);
        const fresh = (r.status === 'sent' || (waiting && due <= now + 15000)) && now - at < 15 * 60000;
        if (fresh && !seen.has(seenKey(r))) { seen.add(seenKey(r)); await deliver(r); }
      }
      if (LN) {
        let pending = [];
        try { pending = (await LN.getPending()).notifications || []; } catch {}
        const have = new Set();
        const drop = [];
        for (const n of pending) {
          const ours = n.extra && n.extra.crew;
          if (!ours) continue;
          const r = upcoming.get(n.id);
          if (r && n.extra.reminderId === r.id && Date.parse(n.schedule && n.schedule.at) === Date.parse(r.due_at)) have.add(n.id);
          else drop.push({ id: n.id });
        }
        if (drop.length) { try { await LN.cancel({ notifications: drop }); } catch {} }
        const add = [...upcoming.values()].filter((r) => !have.has(nid(r.id))).map((r) => noteFor(r, new Date(Date.parse(r.due_at))));
        if (add.length) { try { await LN.schedule({ notifications: add }); } catch (e) { console.warn('[crew] scheduling failed:', e.message); } }
        for (const r of upcoming.values()) seen.add(seenKey(r)); // the phone shows these itself when they are due
      }
      save(SEEN, [...seen].slice(-300));
    } finally { syncing = false; }
  }

  async function setUp() {
    if (!LN) return;
    try {
      let p = await LN.checkPermissions();
      if (p.display !== 'granted') p = await LN.requestPermissions();
      if (platform === 'android') {
        await LN.createChannel({ id: 'crew-calls', name: 'Calls from your agents', description: 'When an agent calls you', importance: 5, visibility: 1, vibration: true });
        await LN.createChannel({ id: 'crew-messages', name: 'Messages from your agents', description: 'When an agent texts you', importance: 4, visibility: 1, vibration: true });
      }
      await LN.registerActionTypes({ types: [{ id: 'CREW_CALL', actions: [
        { id: 'answer', title: 'Answer', foreground: true },
        { id: 'decline', title: 'Decline', destructive: true },
      ] }] });
      await LN.addListener('localNotificationActionPerformed', (e) => {
        const extra = e && e.notification && e.notification.extra;
        if (!extra || !extra.crew || e.actionId === 'decline') return;
        // Opened from the notification: wait for sign-in and the bots, then show it.
        (async () => { for (let i = 0; i < 40 && !(window.CraftCalls && window.CraftReminders); i++) await sleep(100); open(extra, e.actionId === 'answer'); })();
      });
      // Due while the app is open: ring at once instead of only showing a banner.
      await LN.addListener('localNotificationReceived', (n) => {
        const extra = n && n.extra;
        if (!extra || !extra.crew) return;
        if (isCall(extra) && document.visibilityState === 'visible') open(extra, false);
        else intoChat({ id: extra.reminderId, bot_id: extra.botId, text: extra.body, kind: extra.kind });
      });
    } catch (e) { console.warn('[crew] notifications:', e.message); }
  }

  /** Called once signed in (crew-app.js). */
  async function start() {
    if (started) return;
    started = true;
    await setUp();
    sync();
    setInterval(() => { if (document.visibilityState === 'visible') sync(); }, 20000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });
  }

  window.CrewNative = { native, platform, start, sync, hearing: SpeechPlugin ? 'phone' : 'web', notifications: !!LN };
})();
