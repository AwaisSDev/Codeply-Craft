// Calls: talk to your bots out loud, from the phone.
//
// Bots live on the PC (~/.codeply/bots). The phone lists them over the relay
// (GET /api/bots, each with a ready prompt) and caches them, so a call still
// works when the PC is offline. A call runs entirely in this page:
//   tap Call -> ring (WebAudio) -> the bot greets -> Web Speech recognition
//   hears you -> Codeply's ai-proxy answers as the bot (its prompt plus the
//   voice rules) -> speechSynthesis reads it out, sentence by sentence.
// Talk over the bot and it stops (barge-in); its own voice coming back
// through the mic is ignored (echo filter). Finished calls are kept here and
// sent to the PC (POST /api/bots/call) so the bot learns from them.
//
// This is a web page: it looks like the phone's own call screen, but it is
// not a phone call (no CallKit or Android telecom; that needs a native app).
(() => {
  const P = window.CraftPhone;
  if (!P) return;
  const { esc, load, save, newId } = P;
  const $ = (id) => document.getElementById(id);

  const KEY = { bots: 'craft-phone-bots', calls: 'craft-phone-calls' };
  const MAX_CALLS = 50;

  // Same rules as the desktop call (Codeply Crew main.js VOICE_RULES).
  const VOICE_RULES = `LIVE VOICE CALL
You are on a live voice call with the user, talking out loud. Everything you write is spoken by a voice engine.
- Reply in one to three short spoken sentences. Plain words, the way people talk.
- No markdown, no lists, no headings, no emojis, no code, no links, no long dash.
- Ask one short question back when it helps the conversation.
- You cannot use tools during the call. If they want real work done (files, code, emails), say you will take care of it in the chat after the call, and remember what they asked.`;

  const ICON = {
    phone: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1A17 17 0 0 1 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1z"/></svg>',
    end: '<svg viewBox="0 0 24 24" width="34" height="34" fill="currentColor"><path d="M12 9c-1.6 0-3.1.3-4.6.7v3.1c0 .4-.2.7-.6.9-1 .5-1.9 1.1-2.7 1.8-.2.2-.4.3-.7.3s-.5-.1-.7-.3L.3 13.1A1 1 0 0 1 0 12.4c0-.3.1-.5.3-.7C3.3 8.8 7.4 7 12 7s8.7 1.8 11.7 4.7c.2.2.3.4.3.7s-.1.5-.3.7l-2.4 2.4c-.2.2-.4.3-.7.3s-.5-.1-.7-.3c-.8-.7-1.7-1.3-2.7-1.8-.4-.2-.6-.5-.6-.9V9.7C15.1 9.3 13.6 9 12 9z"/></svg>',
    mic: '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
    micOff: '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M3 3l18 18M9 9v2a3 3 0 0 0 5.1 2.1M15 10V6a3 3 0 0 0-5.7-1.3M5 11a7 7 0 0 0 11.5 5.4M19 11a7 7 0 0 1-.6 2.8M12 18v3"/></svg>',
    speaker: '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/></svg>',
    text: '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16v11H9l-5 4z"/><path d="M8 9h8M8 12h5"/></svg>',
    send: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>',
    chev: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
  };

  const cache = { bots: [], templates: [], at: 0, ...load(KEY.bots, {}) };
  let calls = load(KEY.calls, []);
  let refreshing = false;
  let loadError = '';

  // ─── Avatars (bot-avatar.js, with a plain fallback) ──────────────────────
  const A = () => window.CraftAvatar || null;
  const PALETTE = { green: '#35c46a', blue: '#3d86f5', yellow: '#ffcf33', pink: '#ff4fa0', orange: '#ff8433', purple: '#9b68ff', red: '#ff5257', teal: '#1fbfb1', sky: '#5cc8ff', lime: '#a6e22e' };
  function tintOf(avatar) {
    const c = avatar && avatar.color;
    try { if (A() && A().colorHex) { const h = A().colorHex(c); if (/^#[0-9a-f]{6}$/i.test(h)) return h; } } catch {}
    return /^#[0-9a-f]{6}$/i.test(String(c || '')) ? c : PALETTE[c] || '#4b9dff';
  }
  function avatarHtml(bot, size, opts) {
    try { if (A()) return A().renderAvatar(bot.avatar || {}, size, opts || {}); } catch {}
    const initial = esc(String(bot.name || '?').trim()[0] || '?').toUpperCase();
    return `<span class="av-fallback" style="width:${size}px;height:${size}px;background:${tintOf(bot.avatar)};font-size:${Math.round(size * 0.42)}px">${initial}</span>`;
  }
  function setAvatarState(node, s) { try { if (A()) A().setAvatarState(node, s); } catch {} }
  function shade(hex, amount) {
    const n = parseInt(hex.slice(1), 16);
    const f = (v) => Math.round(v * (1 - amount)).toString(16).padStart(2, '0');
    return `#${f(n >> 16)}${f((n >> 8) & 255)}${f(n & 255)}`;
  }

  // ─── Bots from the PC ─────────────────────────────────────────────────────
  const pcOnline = () => !!(P.relay && P.relay.pcId);
  function storeCatalog(r) {
    if (!r || !Array.isArray(r.bots)) return;
    cache.bots = r.bots;
    cache.templates = Array.isArray(r.templates) ? r.templates : [];
    cache.at = Date.now();
    save(KEY.bots, cache);
  }
  async function refreshBots() {
    if (!pcOnline() || refreshing) return;
    refreshing = true;
    loadError = '';
    renderCallsIfOpen();
    try { storeCatalog(await P.relayRequest('GET', '/api/bots')); }
    catch (e) { loadError = /Not found/i.test(e.message) ? 'Update Codeply on your PC to call your bots from here.' : e.message; }
    finally { refreshing = false; renderCallsIfOpen(); }
  }
  async function addTemplate(key, btn) {
    if (btn) { btn.disabled = true; btn.textContent = 'Adding...'; }
    try { storeCatalog(await P.relayRequest('POST', '/api/bots/template', { key })); }
    catch (e) { loadError = e.message; }
    renderCallsIfOpen();
  }
  const botById = (id) => cache.bots.find((b) => b.id === id) || null;

  // ─── Call history ─────────────────────────────────────────────────────────
  function saveCalls() {
    calls = calls.slice(0, MAX_CALLS);
    while (!save(KEY.calls, calls) && calls.length > 5) calls = calls.slice(0, Math.floor(calls.length * 0.7));
  }
  /** Send finished calls to the PC so the bot learns. Quietly retried when the PC comes back. */
  async function syncCalls() {
    if (!pcOnline()) return;
    for (const call of calls.filter((x) => !x.synced && x.status === 'done' && x.turns.some((t) => t.who === 'user')).slice(0, 10)) {
      try {
        await P.relayRequest('POST', '/api/bots/call', { botId: call.botId, ms: call.ms, turns: call.turns });
        call.synced = true;
      } catch (e) {
        if (e.status === 404) call.synced = 'gone';
        else break;
      }
    }
    saveCalls();
    renderCallsIfOpen();
  }

  const dur = (ms) => { const s = Math.max(0, Math.floor((ms || 0) / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  function when(at) {
    const d = new Date(at); const now = new Date();
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day(now) - day(d)) / 86400000);
    if (diff === 0) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (diff === 1) return 'Yesterday';
    if (diff < 7) return d.toLocaleDateString([], { weekday: 'long' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  // ─── Calls panel ──────────────────────────────────────────────────────────
  const isOpen = () => !$('calls').classList.contains('hidden');
  function renderCallsIfOpen() { if (isOpen()) renderCalls(); }
  function openCalls() {
    $('calls').classList.remove('hidden');
    renderCalls();
    refreshBots();
    syncCalls();
  }
  function closeCalls() { $('calls').classList.add('hidden'); }

  function renderCalls() {
    const root = $('callsBody');
    const online = pcOnline();
    const bots = cache.bots;
    let html = '';
    const status = refreshing ? 'Getting your bots from your PC...'
      : online ? (loadError || 'Your bots, from your PC.')
      : bots.length ? 'Your PC is offline. You can still call these bots.' : '';
    if (status) html += `<p class="calls-status${loadError && !refreshing ? ' err' : ''}">${esc(status)}</p>`;

    if (bots.length) {
      html += '<div class="calls-label">Bots</div><div class="calls-list">';
      for (const b of bots) {
        html += `<div class="bot-row">
          <span class="bot-av">${avatarHtml(b, 44, { still: true })}</span>
          <span class="bot-main"><strong>${esc(b.name)}</strong><small>${esc(b.specialty || (b.role === 'orchestrator' ? 'Orchestrator' : 'Specialist'))}</small></span>
          <button type="button" class="call-btn" data-call="${esc(b.id)}" aria-label="Call ${esc(b.name)}">${ICON.phone}</button>
        </div>`;
      }
      html += '</div>';
    } else if (!refreshing) {
      html += `<div class="calls-empty"><h2>Call your bots</h2><p>${online
        ? 'You have no bots yet. Add a starter bot below, or make your own in Codeply on your PC.'
        : 'Make bots in Codeply on your PC, then open Calls here while your PC is online. After that you can call them any time.'}</p></div>`;
      if (online && cache.templates.length) {
        html += '<div class="calls-label">Starter bots</div><div class="calls-list">';
        for (const t of cache.templates) {
          html += `<div class="bot-row">
            <span class="bot-av">${avatarHtml(t, 44, { still: true })}</span>
            <span class="bot-main"><strong>${esc(t.name)}</strong><small>${esc(t.specialty || '')}</small></span>
            <button type="button" class="add-btn" data-tpl="${esc(t.key)}">Add</button>
          </div>`;
        }
        html += '</div>';
      }
    }

    html += '<div class="calls-label">Recent calls</div>';
    if (!calls.length) html += '<p class="calls-none">No calls yet.</p>';
    else {
      html += '<div class="calls-list">';
      for (const c of calls) {
        const missed = c.status !== 'done';
        const sub = missed ? 'Cancelled' : `${dur(c.ms)}${c.synced === true ? '' : c.turns.some((t) => t.who === 'user') ? ' · not on your PC yet' : ''}`;
        html += `<details class="call-row${missed ? ' missed' : ''}">
          <summary>
            <span class="bot-av">${avatarHtml({ name: c.name, avatar: c.avatar }, 36, { still: true, flat: true })}</span>
            <span class="bot-main"><strong>${esc(c.name)}</strong><small>${esc(sub)}</small></span>
            <span class="call-when">${esc(when(c.at))}</span>
            <button type="button" class="call-btn small" data-call="${esc(c.botId)}" aria-label="Call ${esc(c.name)} back">${ICON.phone}</button>
          </summary>
          ${c.turns.length ? `<div class="call-transcript">${c.turns.map((t) => `<p class="${t.who}"><b>${t.who === 'bot' ? esc(c.name) : 'You'}</b>${esc(t.text)}</p>`).join('')}</div>` : '<div class="call-transcript"><p class="none">Nothing was said.</p></div>'}
        </details>`;
      }
      html += '</div>';
    }
    html += '<p class="calls-foot">Calls run in this app with your phone\'s speech recognition and voice. They use your Codeply daily limit.</p>';
    root.innerHTML = html;
    root.querySelectorAll('[data-call]').forEach((b) => b.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      const bot = botById(b.dataset.call);
      if (bot) startCall(bot);
      else alert('That bot is not on your PC any more.');
    }));
    root.querySelectorAll('[data-tpl]').forEach((b) => b.addEventListener('click', () => addTemplate(b.dataset.tpl, b)));
  }

  // ─── Voices ───────────────────────────────────────────────────────────────
  const synth = window.speechSynthesis || null;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  function hash(s) { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
  /** A natural English voice, the same one for a bot every call. */
  function voiceFor(bot) {
    if (!synth) return null;
    const all = synth.getVoices().filter((v) => /^en[-_]/i.test(v.lang) || /^en$/i.test(v.lang));
    if (!all.length) return null;
    const good = all.filter((v) => /natural|neural|premium|enhanced|siri|samantha|ava|allison|daniel|karen|moira|serena|google (us|uk) english|aria|jenny|guy/i.test(v.name) && !/novelty|bells|bad news|bahh|bubbles|cellos|whisper|zarvox|trinoids|organ|jester|wobble|albert|boing|superstar|grandma|grandpa|rocko|shelley|flo|eddy|reed|sandy/i.test(v.name));
    const pool = (good.length ? good : all).slice().sort((a, b) => a.name.localeCompare(b.name));
    return pool[hash(bot.id) % pool.length];
  }
  if (synth && synth.addEventListener) synth.addEventListener('voiceschanged', () => { if (c && !c.voiceLocked) c.voice = voiceFor(c.bot); });

  // ─── Text helpers (from Codeply Crew) ─────────────────────────────────────
  function sentences(text) {
    const parts = String(text || '').match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) || [];
    const out = [];
    for (const p of parts.map((x) => x.trim()).filter(Boolean)) {
      if (out.length && (out[out.length - 1].length < 28 || p.length < 6)) out[out.length - 1] += ` ${p}`;
      else out.push(p);
    }
    return out;
  }
  /** Whatever the model sent, make it sayable: no markdown, no long dashes. */
  function spoken(s) {
    const dash = String.fromCharCode(0x2014);
    return String(s || '')
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/```[\s\S]*?```/g, '')
      .replace(/[*_#`>]+/g, '')
      .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
      .split(dash).join(', ')
      .replace(/\s+/g, ' ')
      .replace(/\s+([,.!?])/g, '$1')
      .replace(/,\s*,/g, ',')
      .trim();
  }
  const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
  function overlap(heardText, saidText) {
    const said = new Set(words(saidText));
    const heard = words(heardText);
    if (!heard.length || !said.size) return 0;
    return heard.filter((w) => said.has(w)).length / heard.length;
  }
  /** The mic heard the bot's own voice from the speaker, not the user. */
  const isEcho = (text) => !!c && words(text).length >= 1 && overlap(text, c.lastBotText) >= 0.8;

  // ─── The call ─────────────────────────────────────────────────────────────
  let c = null;

  function ring(ctx) {
    let stop = false; let t1 = null;
    const burst = () => {
      if (stop || ctx.state === 'closed') return;
      const t = ctx.currentTime;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.06, t + 0.05);
      g.gain.setValueAtTime(0.06, t + 1.0);
      g.gain.linearRampToValueAtTime(0, t + 1.1);
      g.connect(ctx.destination);
      for (const f of [440, 480]) { const o = ctx.createOscillator(); o.frequency.value = f; o.connect(g); o.start(t); o.stop(t + 1.15); }
      t1 = setTimeout(burst, 2600);
    };
    burst();
    return () => { stop = true; clearTimeout(t1); };
  }

  const root = () => $('call');
  const q = (sel) => root().querySelector(sel);
  function setPhase(phase, label) {
    if (!c) return;
    c.phase = phase;
    const r = root();
    r.dataset.phase = phase;
    const chip = q('.call-state');
    if (chip) chip.textContent = label || { ringing: '', listening: c.muted ? 'Muted' : (c.typing ? 'Type to talk' : 'Listening'), thinking: 'Thinking', speaking: '', ended: '' }[phase] || '';
    setAvatarState(q('.call-orb'), phase === 'thinking' ? 'working' : 'idle');
  }
  function caption(text, who) {
    if (!c) return;
    const cap = q('.call-caption');
    cap.textContent = text || '';
    cap.classList.toggle('you', who === 'user');
  }
  function log(who, text) {
    c.turns.push({ who, text, at: Date.now() });
    const box = q('.call-log-list');
    if (!box) return;
    const row = document.createElement('p');
    row.className = who;
    row.innerHTML = `<b>${who === 'bot' ? esc(c.bot.name) : 'You'}</b>${esc(text)}`;
    box.appendChild(row);
    box.scrollTop = box.scrollHeight;
  }
  function tick() {
    if (!c || !c.connectedAt) return;
    q('.call-status').textContent = dur(Date.now() - c.connectedAt);
  }

  // Speaking: speechSynthesis, one sentence at a time so it starts at once
  // and talking over it stops it between words.
  function speakOne(text, token) {
    return new Promise((resolve) => {
      if (!c || token !== c.token) return resolve(false);
      if (!synth) return setTimeout(() => resolve(true), Math.min(6000, 600 + text.length * 55)); // captions only
      let finished = false;
      const done = (ok) => { if (finished) return; finished = true; clearTimeout(safety); resolve(ok); };
      const u = new SpeechSynthesisUtterance(text);
      if (c.voice) { u.voice = c.voice; u.lang = c.voice.lang; } else u.lang = 'en-US';
      u.rate = 1.03;
      u.pitch = c.pitch;
      u.volume = c.speaker ? 1 : 0.45;
      u.onend = () => done(true);
      u.onerror = () => done(false);
      // Some engines never fire onend: move on after a generous guess.
      const safety = setTimeout(() => done(true), 2500 + text.length * 120);
      c.voiceLocked = true;
      try { synth.resume(); } catch {}
      synth.speak(u);
    });
  }
  async function say(text, token) {
    const list = sentences(text);
    if (!list.length || !c) return;
    setPhase('speaking');
    caption(text, 'bot');
    for (const s of list) {
      await speakOne(s, token);
      if (!c || token !== c.token) return;
    }
    if (c && token === c.token) setPhase('listening');
  }
  function interrupt() {
    if (!c) return;
    c.token++;
    if (c.abort) { try { c.abort.abort(); } catch {} c.abort = null; }
    if (synth) { try { synth.cancel(); } catch {} }
  }

  // Answering: the bot's prompt + the voice rules, through Codeply's ai-proxy.
  async function askBot(bot, turns, signal) {
    const last = calls.find((x) => x.botId === bot.id && x.status === 'done' && x.turns.length);
    const recent = last ? last.turns.slice(-6).map((t) => `${t.who === 'bot' ? bot.name : 'User'}: ${String(t.text).slice(0, 400)}`).join('\n') : '';
    const base = bot.prompt || `You are ${bot.name}, one of the user's bots in Codeply.${bot.specialty ? ` Your job: ${bot.specialty}.` : ''}${bot.instructions ? `\n${bot.instructions}` : ''}`;
    const system = `${base}\n\n${VOICE_RULES}${recent ? `\n\nTHE LAST CALL BEFORE THIS ONE\n${recent}` : ''}`;
    const messages = [{ role: 'system', content: system },
      ...turns.slice(-16).map((t) => ({ role: t.who === 'bot' ? 'assistant' : 'user', content: String(t.text || '').slice(0, 1200) }))];
    const token = await P.accessToken();
    const res = await fetch(P.AI_PROXY_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, apikey: P.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, opts: { maxTokens: 220, temperature: 0.7 }, meta: { source: 'phone-call' } }),
      signal,
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.success) {
      const choice = data.data && data.data.choices && data.data.choices[0];
      return (choice && choice.message && choice.message.content) || '';
    }
    if (res.status === 401 && !data.error) throw new Error('Your sign-in expired. Sign in again.');
    throw new Error(data.error || data.message || `Codeply could not answer (${res.status}).`);
  }

  async function heardText(text, typed = false) {
    if (!c || c.ending || c.phase === 'ringing') return;
    text = String(text || '').trim();
    if (!text || (!typed && isEcho(text))) return;
    interrupt();
    const token = c.token;
    log('user', text);
    caption(text, 'user');
    await respond(token);
  }
  async function respond(token) {
    setPhase('thinking');
    const controller = new AbortController();
    c.abort = controller;
    let text = '';
    try {
      text = spoken(await api.reply(c.bot, c.turns, controller.signal));
    } catch (e) {
      if (!c || token !== c.token || e.name === 'AbortError') return;
      q('.call-note').textContent = /fetch|network/i.test(e.message) ? "Can't reach Codeply. Check your internet connection." : e.message;
      await say('Sorry, I lost my train of thought. Say that again?', token);
      return;
    }
    if (!c || token !== c.token) return;
    c.abort = null;
    q('.call-note').textContent = c.noteBase || '';
    text = text || 'Mm hm.';
    c.lastBotText = text;
    log('bot', text);
    await say(text, token);
  }

  // Hearing: Web Speech recognition, restarted after every result.
  function startListening() {
    if (!c || c.typing || c.muted || c.ending || !SR) return;
    if (c.rec) return;
    const rec = new SR();
    rec.lang = 'en-US';
    rec.continuous = false; // iOS is far steadier restarting short sessions
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    c.rec = rec;
    const me = c;
    rec.onresult = (e) => {
      if (c !== me) return;
      let finalText = ''; let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript; else interim += r[0].transcript;
      }
      if (c.phase === 'ringing') return;
      // Barge-in: real words over the bot's voice (not its own echo) stop it.
      const live = (finalText || interim).trim();
      if (c.phase === 'speaking' && words(live).length >= 2 && overlap(live, c.lastBotText) < 0.6) {
        interrupt();
        setPhase('listening');
      }
      if (live && c.phase !== 'speaking') caption(live, 'user');
      if (finalText.trim()) heardText(finalText);
    };
    rec.onerror = (e) => {
      if (c !== me) return;
      const err = e.error || '';
      if (err === 'not-allowed' || err === 'service-not-allowed') return useTyping('Codeply needs the microphone for calls. Allow it for this site in your browser settings, or type below.');
      if (err === 'audio-capture') return useTyping('No microphone found. Type below instead.');
      if (err === 'network' || err === 'language-not-supported') me.fails = (me.fails || 0) + 3;
    };
    rec.onend = () => {
      if (c !== me) return;
      c.rec = null;
      const quick = Date.now() - me.recAt < 1200;
      me.fails = quick ? (me.fails || 0) + 1 : 0;
      if (me.fails >= 6) return useTyping("Voice input isn't working in this browser. Type below and the bot still talks back.");
      setTimeout(startListening, quick ? 400 : 60);
    };
    try { me.recAt = Date.now(); rec.start(); } catch { c.rec = null; }
  }
  function stopListening() {
    if (!c || !c.rec) return;
    const r = c.rec; c.rec = null;
    r.onend = null; r.onresult = null; r.onerror = null;
    try { r.abort(); } catch {}
  }
  function useTyping(msg) {
    if (!c) return;
    stopListening();
    c.typing = true;
    root().classList.add('typing');
    c.noteBase = msg || '';
    q('.call-note').textContent = c.noteBase;
    if (c.phase === 'listening') setPhase('listening');
  }

  async function startCall(bot) {
    if (c) return;
    // Everything audio starts inside this tap: iOS only allows it from a user gesture.
    let ctx = null;
    try { ctx = new (window.AudioContext || window.webkitAudioContext)(); ctx.resume && ctx.resume(); } catch {}
    if (synth) { try { synth.cancel(); const u = new SpeechSynthesisUtterance(' '); u.volume = 0; synth.speak(u); } catch {} }

    const tint = tintOf(bot.avatar);
    const r = root();
    r.style.setProperty('--tint', tint);
    r.style.setProperty('--tint-bg', shade(tint, 0.62));
    r.className = 'call';
    r.dataset.phase = 'ringing';
    r.innerHTML = `
      <div class="call-bg" aria-hidden="true"><div class="call-bg-blob">${avatarHtml(bot, 320, { still: true, flat: true })}</div></div>
      <div class="call-head">
        <div class="call-name">${esc(bot.name)}</div>
        <div class="call-status">calling...</div>
      </div>
      <div class="call-mid">
        <div class="call-face">
          <div class="call-orb">${avatarHtml(bot, 168)}</div>
          <div class="call-state"></div>
          <div class="call-caption"></div>
        </div>
        <div class="call-log"><div class="call-log-list"></div></div>
        <p class="call-note"></p>
        <form class="call-type">
          <input type="text" enterkeyhint="send" autocomplete="off" placeholder="Type to talk">
          <button type="submit" aria-label="Say it">${ICON.send}</button>
        </form>
      </div>
      <div class="call-grid">
        <div class="cb-wrap"><button type="button" class="cb" data-c="mute" aria-label="Mute">${ICON.mic}</button><span>mute</span></div>
        <div class="cb-wrap"><button type="button" class="cb" data-c="log" aria-label="Transcript">${ICON.text}</button><span>transcript</span></div>
        <div class="cb-wrap"><button type="button" class="cb on" data-c="speaker" aria-label="Speaker">${ICON.speaker}</button><span>speaker</span></div>
      </div>
      <button type="button" class="call-end" data-c="end" aria-label="End call">${ICON.end}</button>`;

    c = {
      id: newId(), bot, ctx, token: 0, turns: [], muted: false, speaker: true, typing: !SR, phase: 'ringing',
      startedAt: Date.now(), connectedAt: 0, lastBotText: '', rec: null, abort: null, ending: false,
      voice: voiceFor(bot), pitch: 0.92 + (hash(`${bot.id}p`) % 17) / 100, fails: 0, recAt: 0,
    };
    if (c.typing) root().classList.add('typing');
    q('[data-c="end"]').addEventListener('click', () => endCall());
    q('[data-c="mute"]').addEventListener('click', toggleMute);
    q('[data-c="speaker"]').addEventListener('click', toggleSpeaker);
    q('[data-c="log"]').addEventListener('click', toggleLog);
    q('.call-type').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = q('.call-type input');
      const t = input.value.trim();
      if (!t) return;
      input.value = '';
      heardText(t, true);
    });
    try { if (navigator.wakeLock) c.wake = await navigator.wakeLock.request('screen'); } catch {}
    const me = c;
    if (!SR) { c.noteBase = "This browser can't hear you. Type below and the bot still talks back."; q('.call-note').textContent = c.noteBase; }
    else startListening(); // asks for the mic now, inside the tap; results are ignored while it rings

    c.stopRing = ctx ? ring(ctx) : () => {};
    await new Promise((res) => setTimeout(res, api.ringMs));
    if (c !== me || me.ending) return;
    c.stopRing();
    c.connectedAt = Date.now();
    c.timer = setInterval(tick, 500);
    tick();
    const greet = (bot.memory && bot.memory.length) ? `Hey, it's ${bot.name} again. What's on your mind?` : `Hey, it's ${bot.name}. What can I do for you?`;
    c.lastBotText = greet;
    log('bot', greet);
    await say(greet, c.token);
  }

  function toggleMute() {
    if (!c) return;
    c.muted = !c.muted;
    const btn = q('[data-c="mute"]');
    btn.classList.toggle('on', c.muted);
    btn.innerHTML = c.muted ? ICON.micOff : ICON.mic;
    if (c.muted) stopListening(); else startListening();
    if (c.phase === 'listening') setPhase('listening');
  }
  function toggleSpeaker() {
    if (!c) return;
    c.speaker = !c.speaker;
    q('[data-c="speaker"]').classList.toggle('on', c.speaker);
  }
  function toggleLog() {
    if (!c) return;
    const on = root().classList.toggle('show-log');
    q('[data-c="log"]').classList.toggle('on', on);
    const box = q('.call-log-list');
    box.scrollTop = box.scrollHeight;
  }

  async function endCall() {
    if (!c || c.ending) return;
    const call = c;
    call.ending = true;
    if (call.stopRing) call.stopRing();
    interrupt();
    stopListening();
    clearInterval(call.timer);
    try { if (call.wake) call.wake.release(); } catch {}
    try { if (call.ctx) call.ctx.close(); } catch {}
    const connected = !!call.connectedAt;
    const ms = connected ? Date.now() - call.connectedAt : 0;
    root().dataset.phase = 'ended';
    root().classList.remove('show-log', 'typing');
    q('.call-note').textContent = '';
    q('.call-status').textContent = connected ? `Call ended ${dur(ms)}` : 'Call cancelled';
    q('.call-state').textContent = '';
    root().querySelectorAll('button').forEach((b) => { b.disabled = true; });
    calls.unshift({
      id: call.id, botId: call.bot.id, name: call.bot.name, avatar: call.bot.avatar, at: call.startedAt, ms,
      status: connected ? 'done' : 'cancelled', turns: call.turns.map((t) => ({ who: t.who, text: t.text })), synced: false,
    });
    saveCalls();
    setTimeout(() => {
      if (c === call) c = null;
      root().classList.add('hidden');
      root().innerHTML = '';
      renderCallsIfOpen();
      syncCalls();
    }, api.endedMs);
  }

  // Coming back to the app mid-call: the browser may have stopped the mic.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && c && !c.ending && !c.rec) startListening();
  });
  window.addEventListener('craft:pc-online', () => { refreshBots().then(syncCalls); });

  $('drawerCalls').addEventListener('click', () => { P.closeDrawer(); openCalls(); });
  $('callsBack').addEventListener('click', closeCalls);

  // reply/ringMs/endedMs are swappable for tests in the console.
  const api = { reply: askBot, ringMs: 2400, endedMs: 1100 };
  window.CraftCalls = {
    api, openCalls, closeCalls, startCall, endCall, refreshBots, syncCalls, spoken, sentences, VOICE_RULES,
    heard: heardText, active: () => c, cache, calls: () => calls, supported: { recognition: !!SR, synthesis: !!synth },
  };
})();
