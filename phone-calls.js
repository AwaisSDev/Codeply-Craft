// Calls: talk to your bots out loud, from the phone.
//
// Bots live on the PC (~/.codeply/bots). The phone lists them over the relay
// (GET /api/bots, each with a ready prompt) and caches them, so a call still
// works when the PC is offline. A call runs entirely in this page:
//   tap Call -> ring (WebAudio) -> the bot greets -> we hear you -> the PC
//   (or Codeply's ai-proxy) answers as the bot -> the bot's own Deepgram
//   voice (tts-proxy) reads it out, sentence by sentence, through WebAudio.
//   If that voice is unavailable the phone's speechSynthesis voice takes over.
// Hearing: on iPhone/iPad, and wherever SpeechRecognition is missing, one
// microphone stream is opened on the first call and kept for the life of the
// page (only disabled between calls). Stopping it would make iOS home-screen
// apps ask for the microphone again on every call. A small voice detector
// cuts your words out of that stream and Whisper (phone-stt-worker.js)
// turns them into text on the phone itself. Elsewhere (Chrome) the browser's
// SpeechRecognition does it, and Whisper takes over if that fails.
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

  // With the PC online a call turn runs ON the PC as the bot's real agent, with
  // its tools (Gmail, files, the web): see bots-desktop.js /api/bots/voice.
  // These rules are only for when the PC is offline and the phone answers
  // through ai-proxy without tools (same text as bots.js VOICE_RULES_NO_TOOLS).
  const VOICE_RULES = `LIVE VOICE CALL
You are on a live voice call with the user, talking out loud. Everything you write is spoken by a voice engine.
- Reply in one to three short spoken sentences. Plain words, the way people talk.
- No markdown, no lists, no headings, no emojis, no code, no links, no long dash.
- Ask one short question back when it helps.
- Right now you cannot use your tools (email, files, the web), because the user's PC is offline. If they ask for that kind of work, say so in one sentence and offer to do it once their PC is on.`;

  const ICON = {
    plus: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
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
    const pending = cache.bots.filter((b) => b.pending);
    cache.bots = [...pending, ...r.bots];
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
    // Get Whisper ready in the background so the first call can hear at once.
    if (localEars()) sttLoad();
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

    html += `<button type="button" class="new-bot-btn" id="newBotBtn">${ICON.plus}<span>New bot</span><small>Describe it, Codeply builds it</small></button>`;
    if (bots.length) {
      html += '<div class="calls-label">Bots</div><div class="calls-list">';
      for (const b of bots) {
        html += `<div class="bot-row">
          <span class="bot-av">${avatarHtml(b, 44, { still: true })}</span>
          <span class="bot-main"><strong>${esc(b.name)}</strong><small>${b.pending ? 'On this phone, moves to your PC when it is online' : esc(b.specialty || (b.role === 'orchestrator' ? 'Orchestrator' : 'Specialist'))}</small></span>
          <button type="button" class="call-btn" data-call="${esc(b.id)}" aria-label="Call ${esc(b.name)}">${ICON.phone}</button>
        </div>`;
      }
      html += '</div>';
    } else if (!refreshing) {
      html += `<div class="calls-empty"><h2>Call your bots</h2><p>${online
        ? 'You have no bots yet. Build one above, or add a starter bot below.'
        : 'Build a bot above and call it right away. It moves to your PC the next time your PC is online.'}</p></div>`;
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
    html += `<p class="calls-foot">${localEars()
      ? 'Calls run in this app. What you say is turned into text on this phone, and each bot answers in its own voice.'
      : 'Calls run in this app with your browser\'s speech recognition, and each bot answers in its own voice.'} They use your Codeply daily limit.</p>`;
    root.innerHTML = html;
    root.querySelectorAll('[data-call]').forEach((b) => b.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      const bot = botById(b.dataset.call);
      if (bot) startCall(bot);
      else alert('That bot is not on your PC any more.');
    }));
    root.querySelectorAll('[data-tpl]').forEach((b) => b.addEventListener('click', () => addTemplate(b.dataset.tpl, b)));
    const nb = $('newBotBtn');
    if (nb) nb.addEventListener('click', () => openBuilder());
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

  // ─── Platform ─────────────────────────────────────────────────────────────
  // iPadOS in desktop mode says "MacIntel" but has touch.
  const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  let srBroken = false; // SpeechRecognition failed this session: hear with Whisper instead
  /** Hear with our own mic stream + Whisper (iOS, no SpeechRecognition, or it broke). */
  const localEars = () => IS_IOS || !SR || srBroken || !!api.localEars;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // One AudioContext for the page: the ring, the bot's voice and the mic tap.
  // Created and resumed inside the Call tap (iOS only unlocks audio there).
  let actx = null;
  function audioCtx() {
    if (!actx || actx.state === 'closed') {
      try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch { actx = null; }
    }
    if (actx && actx.state !== 'running') { try { actx.resume(); } catch {} }
    return actx;
  }
  // The bot's voice can also go through this <audio> element. iOS unlocks it
  // with a silent play inside the Call tap, and it keeps working when the
  // mic makes iOS suspend the AudioContext.
  let voiceEl = null;
  const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
  function unlockVoiceEl() {
    try {
      if (!voiceEl) { voiceEl = new Audio(); voiceEl.setAttribute('playsinline', ''); voiceEl.preload = 'auto'; }
      voiceEl.src = SILENT_WAV;
      const p = voiceEl.play();
      if (p && p.catch) p.catch(() => {});
    } catch {}
  }
  async function wake(ctx) {
    if (!ctx || ctx.state === 'running') return !!ctx;
    try { await Promise.race([ctx.resume(), sleep(800)]); } catch {}
    return ctx.state === 'running';
  }

  // ─── The kept microphone ──────────────────────────────────────────────────
  // iOS home-screen apps reset the mic permission whenever capture stops, so
  // the stream is NEVER stopped: between calls its track is only disabled.
  const mic = { stream: null, pending: null, wired: null, wiring: null };
  const micTrack = () => (mic.stream && mic.stream.getAudioTracks()[0]) || null;
  const micLive = () => { const t = micTrack(); return !!t && t.readyState === 'live'; };
  function micEnabled(on) { const t = micTrack(); if (t) t.enabled = !!on; }
  function getMic() {
    if (micLive()) { micEnabled(true); return Promise.resolve(mic.stream); }
    if (mic.pending) return mic.pending;
    const md = navigator.mediaDevices;
    if (!md || !md.getUserMedia) return Promise.reject(Object.assign(new Error('No microphone here.'), { name: 'NotFoundError' }));
    mic.pending = md.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      .then((s) => { mic.stream = s; return s; })
      .finally(() => { mic.pending = null; });
    return mic.pending;
  }

  // The tap: 1024-sample frames from the mic to the voice detector.
  const TAP_SRC = "class CraftTap extends AudioWorkletProcessor{constructor(){super();this.b=new Float32Array(1024);this.n=0}process(i){const x=i[0]&&i[0][0];if(x){for(let k=0;k<x.length;k++){this.b[this.n++]=x[k];if(this.n===1024){this.port.postMessage(this.b,[this.b.buffer]);this.b=new Float32Array(1024);this.n=0}}}return true}}registerProcessor('craft-tap',CraftTap)";
  let tapUrl = '';
  function wireMic(ctx) {
    const key = `${mic.stream && mic.stream.id}`;
    if (mic.wired && mic.wired.ctx === ctx && mic.wired.key === key) return Promise.resolve();
    if (mic.wiring) return mic.wiring;
    mic.wiring = (async () => {
      if (mic.wired) { try { mic.wired.source.disconnect(); mic.wired.node.disconnect(); } catch {} }
      const source = ctx.createMediaStreamSource(mic.stream);
      const sink = ctx.createGain();
      sink.gain.value = 0; // the tap must reach the output to run; silent
      sink.connect(ctx.destination);
      let node = null;
      if (ctx.audioWorklet && window.AudioWorkletNode) {
        try {
          if (!ctx.craftTap) {
            tapUrl = tapUrl || URL.createObjectURL(new Blob([TAP_SRC], { type: 'application/javascript' }));
            await ctx.audioWorklet.addModule(tapUrl);
            ctx.craftTap = true;
          }
          node = new AudioWorkletNode(ctx, 'craft-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
          node.port.onmessage = (e) => onMicFrame(e.data, ctx.sampleRate);
        } catch { node = null; }
      }
      if (!node) {
        node = ctx.createScriptProcessor(2048, 1, 1);
        node.onaudioprocess = (e) => onMicFrame(new Float32Array(e.inputBuffer.getChannelData(0)), ctx.sampleRate);
      }
      source.connect(node);
      node.connect(sink);
      mic.wired = { ctx, key, source, node };
    })().finally(() => { mic.wiring = null; });
    return mic.wiring;
  }

  // ─── Voice activity detector ──────────────────────────────────────────────
  // Energy based with an adaptive noise floor. Speech starts once the level
  // is clearly above the floor for ~150 ms out of the last 300 ms (syllables
  // have gaps), or 180 of 500 ms and much louder while the bot is talking so
  // its echo does not count. It ends after ~450 ms of quiet and keeps ~300 ms
  // from before the start so first syllables are not clipped.
  function makeVad(sampleRate, on) {
    const v = {
      sampleRate, botSpeaking: false, floor: 0.004, floorBot: 0.01,
      inSpeech: false, hist: [], quietMs: 0, voicedMs: 0, totalMs: 0, ring: [], ringMs: 0, frames: [],
    };
    const PRE_MS = 300; const END_MS = 450; const MIN_MS = 250; const MAX_MS = 15000;
    function finish() {
      const keep = v.voicedMs >= MIN_MS;
      const frames = v.frames;
      v.reset();
      if (!keep) { if (on.cancel) on.cancel(); return; }
      let n = 0; for (const f of frames) n += f.length;
      const all = new Float32Array(n);
      let o = 0; for (const f of frames) { all.set(f, o); o += f.length; }
      on.end(to16k(all, sampleRate));
    }
    v.feed = (frame) => {
      let sum = 0;
      for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
      const rms = Math.sqrt(sum / Math.max(1, frame.length));
      const ms = (frame.length / sampleRate) * 1000;
      const bot = v.botSpeaking;
      const floor = bot ? Math.max(v.floorBot, v.floor) : v.floor;
      if (!v.inSpeech) {
        const startThr = Math.max(floor * (bot ? 5 : 3), bot ? 0.03 : 0.012);
        const needMs = bot ? 180 : 150;
        const winMs = bot ? 500 : 300;
        const loud = rms > startThr;
        v.ring.push(frame); v.ringMs += ms;
        while (v.ring.length > 1 && v.ringMs - (v.ring[0].length / sampleRate) * 1000 >= PRE_MS + winMs + (bot ? 300 : 0)) {
          v.ringMs -= (v.ring.shift().length / sampleRate) * 1000;
        }
        v.hist.push(loud ? ms : 0);
        while (v.hist.length * ms > winMs) v.hist.shift();
        if (!loud) {
          // The floor follows the room: down fast, up slowly.
          const k = bot ? 'floorBot' : 'floor';
          v[k] = rms < v[k] ? v[k] * 0.9 + rms * 0.1 : v[k] * 0.995 + rms * 0.005;
          v[k] = Math.min(0.08, Math.max(0.0015, v[k]));
        }
        const loudMs = v.hist.reduce((a, b) => a + b, 0);
        if (loudMs >= needMs) {
          v.inSpeech = true;
          v.frames = v.ring; v.ring = []; v.ringMs = 0; v.hist = [];
          v.voicedMs = loudMs; v.totalMs = 0; v.quietMs = 0;
          if (on.start) on.start();
        }
        return;
      }
      v.frames.push(frame);
      v.totalMs += ms;
      const endThr = Math.max(floor * 2, bot ? 0.02 : 0.008);
      if (rms > endThr) { v.voicedMs += ms; v.quietMs = 0; } else v.quietMs += ms;
      if (v.quietMs >= END_MS || v.totalMs >= MAX_MS) finish();
    };
    v.flush = () => { if (v.inSpeech) finish(); };
    /** What has been said so far in the current utterance, at 16 kHz. */
    v.peek = () => {
      let n = 0; for (const f of v.frames) n += f.length;
      const all = new Float32Array(n);
      let o = 0; for (const f of v.frames) { all.set(f, o); o += f.length; }
      return to16k(all, sampleRate);
    };
    v.reset = () => { v.inSpeech = false; v.frames = []; v.hist = []; v.quietMs = 0; v.voicedMs = 0; v.totalMs = 0; };
    return v;
  }
  /** Mono Float32 at any rate to 16 kHz (box-filtered), a little louder if quiet. */
  function to16k(buf, sr) {
    let out = buf;
    if (sr !== 16000) {
      const ratio = sr / 16000;
      const n = Math.floor(buf.length / ratio);
      out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const a = Math.floor(i * ratio); const b = Math.min(buf.length, Math.max(a + 1, Math.floor((i + 1) * ratio)));
        let s = 0; for (let j = a; j < b; j++) s += buf[j];
        out[i] = s / (b - a);
      }
    }
    let peak = 0; for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
    if (peak > 0 && peak < 0.5) { const g = Math.min(8, 0.5 / peak); for (let i = 0; i < out.length; i++) out[i] *= g; }
    return out;
  }

  // ─── Whisper on the phone (phone-stt-worker.js) ───────────────────────────
  const STT_SEEN = 'craft-phone-stt-ready-2'; // -2: the Moonshine model
  const stt = { worker: null, state: 'idle', device: '', progress: 0, waits: new Map(), seq: 0, error: '' };
  function sttFailed(msg) {
    stt.state = 'failed';
    stt.error = msg || 'Speech model did not load.';
    if (stt.worker) { try { stt.worker.terminate(); } catch {} stt.worker = null; }
    for (const w of stt.waits.values()) w.reject(new Error(stt.error));
    stt.waits.clear();
    if (c && !c.ending && localEars() && !c.typing) useTyping("Voice input couldn't start on this phone. Type below and the bot still talks back.");
  }
  function sttLoad() {
    if (stt.worker || stt.state === 'failed') return;
    if (!window.Worker) return sttFailed('This browser has no workers.');
    try { stt.worker = new Worker('phone-stt-worker.js', { type: 'module' }); } catch (e) { return sttFailed(e.message); }
    stt.state = 'loading';
    // A load that stops moving for a minute (no download progress, no ready) has failed.
    let watchdog = null;
    const bump = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        if (stt.state !== 'loading') return;
        sttFailed('The speech model took too long to start.');
      }, 60000);
    };
    bump();
    stt.worker.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === 'progress') { bump(); stt.progress = m.total ? m.loaded / m.total : 0; showNote(); }
      else if (m.type === 'ready') {
        clearTimeout(watchdog);
        stt.state = 'ready'; stt.device = `${(m.model || '').split('/').pop()} ${m.device || ''}`.trim();
        save(STT_SEEN, true);
        showNote();
        if (c && c.queued) { const a = c.queued; c.queued = null; hearAudio(a); }
      } else if (m.type === 'result' || m.type === 'error') {
        const w = m.id != null && stt.waits.get(m.id);
        if (w) { stt.waits.delete(m.id); if (m.type === 'result') w.resolve(m.text || ''); else w.reject(new Error(m.error)); }
        else if (m.type === 'error') sttFailed(m.error);
      }
    };
    stt.worker.onerror = (e) => { if (e && e.preventDefault) e.preventDefault(); if (stt.state !== 'ready') sttFailed((e && e.message) || 'Speech worker failed.'); };
    stt.worker.postMessage({ type: 'load' });
    showNote();
  }
  /** 16 kHz mono Float32 -> text, on the phone. */
  function transcribe(audio16k) {
    sttLoad();
    if (stt.state === 'failed') return Promise.reject(new Error(stt.error));
    return new Promise((resolve, reject) => {
      const id = ++stt.seq;
      stt.waits.set(id, { resolve, reject });
      const copy = new Float32Array(audio16k);
      stt.worker.postMessage({ type: 'transcribe', id, audio: copy }, [copy.buffer]);
    });
  }

  // Frames from the tap -> the current call's voice detector.
  function onMicFrame(frame, sampleRate) {
    if (!c || !c.ears || c.muted || c.typing || c.ending || c.phase === 'ringing') return;
    if (!c.vad || c.vad.sampleRate !== sampleRate) {
      c.vad = makeVad(sampleRate, {
        start: () => {
          if (!c) return;
          // Over the bot's voice nothing stops it yet: the words decide (see bargeCheck).
          c.bargeAt = c.phase === 'speaking' ? performance.now() : 0;
          if (c.phase !== 'speaking') caption('...', 'user');
        },
        cancel: () => { if (c && c.phase === 'listening' && q('.call-caption').textContent === '...') caption('', 'user'); },
        end: (audio) => hearAudio(audio),
      });
    }
    c.vad.botSpeaking = c.phase === 'speaking';
    c.vad.feed(frame);
    bargeCheck();
  }
  // Talking over the bot: about 0.6 s into the sound, transcribe what was said
  // so far and stop the bot only for 2+ clear words that are not its own echo.
  // A cough, a door, music or the bot's voice from the speaker never stops it.
  const clearWords = (text) => words(text).filter((w) => w.length > 1 || /^[ai]$/.test(w));
  function isRealSpeech(text) {
    const w = clearWords(text);
    return w.length >= 2 && overlap(text, c && c.lastBotText) < 0.6;
  }
  async function bargeCheck() {
    const me = c;
    if (!me || !me.bargeAt || me.bargeBusy || me.phase !== 'speaking' || !me.vad || !me.vad.inSpeech) return;
    if (performance.now() - me.bargeAt < 600 || stt.state !== 'ready') return;
    me.bargeBusy = true;
    try {
      const text = await transcribe(me.vad.peek());
      if (c === me && me.phase === 'speaking' && isRealSpeech(text)) {
        me.bargeAt = 0;
        interrupt();
        setPhase('listening');
        caption(text, 'user');
      } else if (c === me) me.bargeAt = performance.now(); // check again a bit later
    } catch {} finally { me.bargeBusy = false; }
  }
  async function hearAudio(audio) {
    const me = c;
    if (!me || me.ending) return;
    if (stt.state !== 'ready') {
      me.queued = audio; // only the latest thing said waits for the model
      sttLoad();
      showNote();
      return;
    }
    let text = '';
    const t0 = performance.now();
    try { text = await transcribe(audio); } catch { return; }
    const ms = Math.round(performance.now() - t0);
    metrics.push({ kind: 'stt', ms, secs: +(audio.length / 16000).toFixed(2), model: stt.device, at: Date.now() });
    console.debug(`[calls] end of speech -> text: ${ms} ms after the 450 ms quiet wait (${(audio.length / 16000).toFixed(1)} s clip, ${stt.device})`);
    if (c !== me) return;
    if (!text) { if (me.phase === 'listening' && q('.call-caption').textContent === '...') caption('', 'user'); return; }
    // Said while the bot was still talking: only clear words count.
    if (me.phase === 'speaking' && !isRealSpeech(text)) return;
    heardText(text);
  }

  // ─── The bot's own voice (Deepgram, through Codeply's tts-proxy) ──────────
  const TTS_URL = String(P.AI_PROXY_URL || '').replace('/functions/v1/ai-proxy', '/functions/v1/tts-proxy');
  const VOICE_CHAT_URL = String(P.AI_PROXY_URL || '').replace('/functions/v1/ai-proxy', '/functions/v1/voice-chat');
  const VOICE_TURN_URL = String(P.AI_PROXY_URL || '').replace('/functions/v1/ai-proxy', '/functions/v1/voice-turn');
  // voice-turn runs next to the model and Deepgram (both in the US): fewer slow hops per sentence.
  const VOICE_REGION = { 'x-region': 'us-east-1' };
  const DG_VOICES = ['aura-2-thalia-en', 'aura-2-luna-en', 'aura-2-orion-en', 'aura-2-apollo-en', 'aura-2-athena-en', 'aura-2-arcas-en'];
  /** The bot's chosen Deepgram voice, or a stable default for it. */
  function deepgramVoice(bot) {
    const v = String((bot && bot.voice) || '').trim();
    return /^aura-/i.test(v) ? v : DG_VOICES[hash((bot && bot.id) || '') % DG_VOICES.length];
  }
  function decodeAudio(ctx, bytes) {
    return new Promise((resolve, reject) => {
      try { const p = ctx.decodeAudioData(bytes, resolve, reject); if (p && p.then) p.then(resolve, reject); } catch (e) { reject(e); }
    });
  }
  // Wake the tts-proxy function (a cold start costs seconds): a plain GET
  // answers 204 at once. Sent on the Call tap and after 4 idle minutes.
  let lastWarm = 0;
  function warmTts() {
    if (!TTS_URL) return;
    lastWarm = Date.now();
    try { fetch(TTS_URL, { method: 'GET', cache: 'no-store' }).catch(() => {}); } catch {}
    try { fetch(VOICE_TURN_URL, { method: 'GET', cache: 'no-store', headers: VOICE_REGION }).catch(() => {}); } catch {}
  }
  /** One chunk -> an AudioBuffer, or null (then the phone's voice says it). Decodes as soon as the bytes land. */
  async function ttsClip(text, token, authP, retried) {
    const me = c;
    if (!me || me.ttsOff || !TTS_URL || token !== me.token) return null;
    if (!me.ttsCtl || me.ttsCtl.token !== token) me.ttsCtl = { token, ctl: new AbortController() };
    const signal = me.ttsCtl.ctl.signal;
    const timer = new AbortController();
    const t = setTimeout(() => timer.abort(), 12000);
    const stop = () => timer.abort();
    signal.addEventListener('abort', stop, { once: true });
    me.lastTtsAt = Date.now();
    try {
      const auth = await (authP || P.accessToken());
      const res = await fetch(TTS_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${auth}`, apikey: P.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: String(text).slice(0, 600), voice: me.dgVoice }),
        signal: timer.signal,
      });
      const type = res.headers.get('content-type') || '';
      if (!res.ok || /json|text\//i.test(type)) {
        let err = '';
        try { const d = await res.json(); err = d.error || d.message || ''; } catch {}
        throw Object.assign(new Error(err || `Voice failed (${res.status}).`), { status: res.status });
      }
      const bytes = await res.arrayBuffer();
      if (!bytes.byteLength) throw new Error('Empty voice.');
      const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }));
      let buf = null;
      try { if (me.ctx && me.ctx.state !== 'closed') buf = await decodeAudio(me.ctx, bytes.slice(0)); } catch {}
      return { buf, url };
    } catch (e) {
      if (signal.aborted || c !== me) return null; // interrupted, not broken
      const lasting = e.status === 401 || e.status === 429 || e.status === 503;
      if (!lasting && !retried) { clearTimeout(t); return ttsClip(text, token, authP, true); }
      if (lasting || retried) {
        if (lasting) me.ttsOff = true; // the phone's voice for the rest of this call
        me.ttsNote = e.status === 429 ? "Daily voice limit reached, using the phone's voice"
          : e.status === 401 ? "Sign in again for the bot's voice, using the phone's voice"
          : e.status === 503 ? "Bot voices are not set up yet, using the phone's voice"
          : `Bot voice failed (${e.status || e.message}), using the phone's voice for that line`;
        showNote();
      }
      return null;
    } finally {
      clearTimeout(t);
      signal.removeEventListener('abort', stop);
    }
  }
  /** Play a clip through the call's AudioContext, its words appearing as they are said. Resolves false when cut off, 'fallback' if audio is locked. */
  async function playClip(clip, token, text, onStart) {
    const me = c;
    if (!me || token !== me.token) return false;
    const ctx = me.ctx;
    const running = ctx && clip.buf && (ctx.state === 'running' || (await wake(ctx)));
    if (c !== me || token !== me.token) return false;
    if (!running) return playEl(clip, token, text, onStart); // iOS suspended it when the mic started
    const buf = clip.buf;
    URL.revokeObjectURL(clip.url);
    return new Promise((resolve) => {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const gain = ctx.createGain();
      gain.gain.value = me.speaker ? 1 : 0.45;
      src.connect(gain);
      gain.connect(ctx.destination);
      let done = false;
      const fin = (ok) => {
        if (done) return; done = true;
        clearTimeout(safety);
        if (me.playing && me.playing.src === src) me.playing = null;
        try { src.disconnect(); gain.disconnect(); } catch {}
        if (ok === true && c === me && token === me.token) { stopReveal(); caption(text, 'bot'); }
        resolve(ok);
      };
      const safety = setTimeout(() => fin(true), buf.duration * 1000 + 1500);
      src.onended = () => fin(true);
      me.playing = { src, gain, fin };
      try { src.start(); } catch { fin('fallback'); return; }
      const startAt = ctx.currentTime;
      const lag = ctx.outputLatency || ctx.baseLatency || 0;
      revealTimed(text, () => ctx.currentTime - startAt - lag, buf.duration);
      if (onStart) onStart();
    });
  }
  /** The same clip through the unlocked <audio> element. */
  function playEl(clip, token, text, onStart) {
    const me = c;
    return new Promise((resolve) => {
      if (!voiceEl) { URL.revokeObjectURL(clip.url); resolve('fallback'); return; }
      const el = voiceEl;
      let done = false;
      const fin = (ok) => {
        if (done) return; done = true;
        clearTimeout(safety);
        el.onended = null; el.onerror = null; el.onplaying = null;
        URL.revokeObjectURL(clip.url);
        if (me.playing && me.playing.el === el) me.playing = null;
        if (ok === true && c === me && token === me.token) { stopReveal(); caption(text, 'bot'); }
        resolve(ok);
      };
      const safety = setTimeout(() => fin(true), 30000);
      el.onended = () => fin(true);
      el.onerror = () => fin('fallback');
      el.onplaying = () => {
        if (c !== me || token !== me.token) return;
        const dur = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : Math.max(0.6, text.length * 0.062);
        revealTimed(text, () => el.currentTime, dur);
        if (onStart) onStart();
      };
      me.playing = { el, fin };
      el.volume = me.speaker ? 1 : 0.45;
      el.src = clip.url;
      const p = el.play();
      if (p && p.catch) p.catch(() => fin('fallback'));
    });
  }
  function stopPlayback() {
    const p = c && c.playing;
    stopReveal();
    if (!p) return;
    c.playing = null;
    try { if (p.src) { p.src.onended = null; p.src.stop(); } if (p.el) p.el.pause(); } catch {}
    p.fin(false);
  }

  // ─── Word-synced captions ─────────────────────────────────────────────────
  // A chunk's words appear as they are said: each word gets time by its length
  // plus a little, with pauses after commas and full stops, spread over the
  // clip's real duration and driven by the audio clock.
  function wordPlan(text) {
    const toks = String(text || '').split(/\s+/).filter(Boolean);
    const starts = [];
    let acc = 0;
    for (const w of toks) {
      starts.push(acc);
      acc += w.replace(/[^A-Za-z0-9']/g, '').length + 2;
      if (/[.!?]["')\]]*$/.test(w)) acc += 6;
      else if (/[,;:]$/.test(w) || w === '-') acc += 3;
    }
    return { toks, starts, total: acc || 1 };
  }
  function revealTimed(text, clock, dur) {
    stopReveal();
    const me = c;
    if (!me) return;
    const plan = wordPlan(text);
    const lead = Math.min(0.06, dur * 0.05);
    const span = Math.max(0.2, dur - lead);
    const handle = { raf: 0 };
    let shown = -1;
    const step = () => {
      if (c !== me || me.reveal !== handle) return;
      const frac = (clock() - lead) / span;
      let n = 0;
      while (n < plan.toks.length && plan.starts[n] / plan.total <= frac) n++;
      if (n !== shown && n > 0) { shown = n; caption(plan.toks.slice(0, n).join(' '), 'bot'); } // the last chunk stays until this one's first word
      if (n < plan.toks.length) handle.raf = requestAnimationFrame(step);
    };
    me.reveal = handle;
    step();
  }
  function stopReveal() {
    if (c && c.reveal) { cancelAnimationFrame(c.reveal.raf); c.reveal = null; }
  }
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
  /** Speaking chunks: a SHORT first one so the voice starts sooner, then full sentences (short ones merged). */
  function chunks(text) {
    const raw = (String(text || '').match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) || []).map((x) => x.trim()).filter(Boolean);
    if (!raw.length) return [];
    const out = [];
    const w = raw.shift().split(/\s+/);
    if (w.length > 7) {
      let cut = -1;
      for (let i = 1; i < Math.min(w.length - 2, 8); i++) {
        if (/[,;:]$/.test(w[i]) || w[i + 1] === '-') { cut = i + 1; break; }
      }
      if (cut < 0) cut = 5;
      out.push(w.slice(0, cut).join(' '));
      raw.unshift(w.slice(cut).join(' ').replace(/^-\s*/, ''));
    } else out.push(w.join(' '));
    for (const p of raw) {
      const last = out.length > 1 ? out[out.length - 1] : null;
      if (last && (last.length < 28 || p.length < 6)) out[out.length - 1] += ` ${p}`;
      else out.push(p);
    }
    return out;
  }  /** Whatever the model sent, make it sayable: no markdown, no long dashes. */
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
  const metrics = []; // timings for tests: firstAudio (reply text -> sound), stt (end of speech -> text)

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

  // The phone's own voice (speechSynthesis), for when the Deepgram voice is
  // unavailable. Words follow its 'boundary' events, or a timed guess.
  function speakOne(text, token, onStart) {
    return new Promise((resolve) => {
      if (!c || token !== c.token) return resolve(false);
      const me = c;
      const estimate = (rate) => Math.max(0.6, (text.length * 0.062) / rate + 0.25);
      if (!synth) { // captions only
        const t0 = performance.now();
        revealTimed(text, () => (performance.now() - t0) / 1000, estimate(1));
        if (onStart) onStart();
        setTimeout(() => { if (c === me && token === me.token) { stopReveal(); caption(text, 'bot'); } resolve(true); }, Math.min(6000, 600 + text.length * 55));
        return;
      }
      let finished = false;
      const done = (ok) => {
        if (finished) return; finished = true;
        clearTimeout(safety);
        if (c === me && token === me.token) { stopReveal(); caption(text, 'bot'); }
        resolve(ok);
      };
      const u = new SpeechSynthesisUtterance(text);
      if (c.voice) { u.voice = c.voice; u.lang = c.voice.lang; } else u.lang = 'en-US';
      u.rate = 1.03;
      u.pitch = c.pitch;
      u.volume = c.speaker ? 1 : 0.45;
      let boundaries = false;
      u.onstart = () => {
        if (c !== me || token !== me.token) return;
        const t0 = performance.now();
        if (!boundaries) revealTimed(text, () => (performance.now() - t0) / 1000, estimate(u.rate));
        if (onStart) onStart();
      };
      u.onboundary = (e) => {
        if (c !== me || token !== me.token || (e.name && e.name !== 'word')) return;
        if (!boundaries) { boundaries = true; stopReveal(); }
        const i = e.charIndex || 0;
        const sp = text.indexOf(' ', i);
        const end = e.charLength ? i + e.charLength : (sp < 0 ? text.length : sp);
        caption(text.slice(0, end), 'bot');
      };
      u.onend = () => done(true);
      u.onerror = () => done(false);
      // Some engines never fire onend: move on after a generous guess.
      const safety = setTimeout(() => done(true), 2500 + text.length * 120);
      c.voiceLocked = true;
      try { synth.resume(); } catch {}
      synth.speak(u);
    });
  }
  // Each chunk in the bot's Deepgram voice. The next two chunks are fetched
  // (and decoded) while one plays; a chunk without a clip uses the phone's
  // voice. Nothing of a chunk is shown before its audio starts.
  async function say(text, token) {
    const list = chunks(text);
    if (!list.length || !c) return;
    const me = c;
    setPhase('speaking');
    stopReveal();
    caption('', 'bot');
    const t0 = performance.now();
    let first = true;
    const onStart = () => {
      if (!first) return;
      first = false;
      const ms = Math.round(performance.now() - t0);
      metrics.push({ kind: 'firstAudio', ms, at: Date.now(), via: me.ttsOff ? 'phone' : 'deepgram' });
      console.debug(`[calls] reply text -> first audio: ${ms} ms (${me.ttsOff ? 'phone voice' : 'Deepgram'})`);
    };
    const authP = me.ttsOff ? null : Promise.resolve().then(() => P.accessToken());
    if (authP) authP.catch(() => {});
    const clips = [];
    const want = (i) => { if (i < list.length && !clips[i] && !me.ttsOff) clips[i] = ttsClip(list[i], token, authP); };
    want(0); want(1);
    for (let i = 0; i < list.length; i++) {
      want(i);
      const buf = clips[i] ? await clips[i] : null;
      if (c !== me || token !== me.token) return;
      want(i + 1); want(i + 2);
      const played = buf ? await playClip(buf, token, list[i], onStart) : 'fallback';
      if (c !== me || token !== me.token) return;
      if (played === 'fallback') await speakOne(list[i], token, onStart);
      if (c !== me || token !== me.token) return;
    }
    if (c && token === c.token) {
      if (c.abort && c.stepLabel) setPhase('thinking', c.stepLabel); // said the opening line, the work is still running
      else setPhase('listening');
    }
  }

  // Approvals on the call screen for anything outside the bot's boundary.
  function askApproval(req, signal) {
    hideApproval();
    return new Promise((resolve) => {
      if (!c) { resolve('reject'); return; }
      const box = document.createElement('div');
      box.className = `call-approve${req.danger ? ' danger' : ''}`;
      box.innerHTML = `<div class="call-approve-title">${esc(req.title || 'Allow this?')}</div>
        ${req.detail ? `<pre>${esc(String(req.detail).slice(0, 500))}</pre>` : ''}
        <div class="call-approve-row"><button type="button" data-v="reject">Don't allow</button><button type="button" class="primary" data-v="once">Allow</button></div>`;
      const done = (v) => { box.remove(); resolve(v); };
      box.querySelectorAll('[data-v]').forEach((b) => b.addEventListener('click', () => done(b.dataset.v)));
      signal.addEventListener('abort', () => done('reject'), { once: true });
      root().appendChild(box);
      setPhase('thinking', 'Needs your OK');
    });
  }
  function hideApproval() {
    const box = c && q('.call-approve');
    if (box) box.remove();
  }

  function interrupt() {
    if (!c) return;
    c.token++;
    if (c.abort) { try { c.abort.abort(); } catch {} c.abort = null; }
    if (c.ttsCtl) { try { c.ttsCtl.ctl.abort(); } catch {} c.ttsCtl = null; }
    stopPlayback();
    if (synth) { try { synth.cancel(); } catch {} }
  }

  /** The quiet line under the bot: model download, voice limit, or the base note. */
  function showNote() {
    if (!c || c.ending) return;
    const el = q('.call-note');
    if (!el) return;
    const parts = [];
    if (localEars() && !c.typing && stt.state === 'loading') {
      const pct = stt.progress > 0 && stt.progress < 1 ? ` ${Math.round(stt.progress * 100)}%` : '';
      parts.push(load(STT_SEEN, false) ? `Getting voice ready...${pct}` : `Getting voice ready (about 30 MB, once)${pct}`);
    }
    if (c.ttsNote) parts.push(c.ttsNote);
    if (c.noteBase) parts.push(c.noteBase);
    el.textContent = parts.join(' · ');
  }

  // Answering, PC online: the turn runs on the PC with the bot's tools. The
  // relay has a time limit, so it is a job we poll; it reports what the bot is
  // doing and stops for approvals outside the bot's boundary.
  const abortError = () => Object.assign(new Error('Stopped.'), { name: 'AbortError' });
  async function askBotOnPc(bot, turns, signal, ui) {
    let r = await P.relayRequest('POST', '/api/bots/voice', { botId: bot.id, turns: turns.slice(-16).map((t) => ({ who: t.who, text: t.text })) });
    const jobId = r.jobId;
    const cancel = () => { P.relayRequest('POST', '/api/bots/voice/cancel', { jobId }).catch(() => {}); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      for (;;) {
        if (signal.aborted) throw abortError();
        if (r.status === 'done') return r.text || '';
        if (r.status === 'cancelled') throw abortError();
        if (r.status === 'error' || (r.error && !r.jobId)) throw new Error(r.error || 'Your PC could not answer.');
        if (r.step) ui.step(r.step);
        if (r.approval) {
          const verdict = await ui.approve(r.approval, signal);
          if (signal.aborted) throw abortError();
          await P.relayRequest('POST', '/api/bots/voice/answer', { jobId, requestId: r.approval.requestId, verdict });
        }
        r = await P.relayRequest('POST', '/api/bots/voice/poll', { jobId, version: r.version }, 20000);
      }
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  }

  // Answering, PC offline: the bot's prompt + the voice rules, through Codeply's ai-proxy.
  async function askBot(bot, turns, signal, ui) {
    // Bots made on the PC run there whenever it is reachable, tools and all.
    if (pcOnline() && ui) {
      try { return await askBotOnPc(bot, turns, signal, ui); } catch (e) {
        if (e.name === 'AbortError' || signal.aborted) throw e;
        if (!e.timeout && !/offline|didn't answer|not on this PC|404/i.test(e.message)) throw e;
        // The PC dropped off mid-call: answer from the phone instead.
      }
    }
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
  // The fast lane: Codeply's fast model answers at once, as the bot. It either
  // answers outright, or says a natural line and names the real work, which
  // then runs on the PC with the bot's tools.
  const FAST_RULES = `LIVE VOICE CALL, FAST REPLY
You are on a live voice call. Reply with ONLY a JSON object: {"say": "...", "work": null}
- "say" is spoken out loud right away: one to three short spoken sentences, plain words, no markdown, no lists, no emojis, no links, no long dash.
- If the user wants something that needs real tools (their email, calendar, files, code, sending a message, searching the web for current facts, anything on their computer), set "work" to one clear sentence describing the task for your tools, and make "say" a short natural line that fits what they asked, like you are starting on it now. Vary it. Never say "one sec" or "one moment". Do not invent results.
- Otherwise "work" is null and "say" is your full answer.`;
  const FAST_OFFLINE = '\n- Right now the user\'s PC is offline, so you cannot use tools: never set "work"; if they ask for that kind of thing, say so in one sentence and offer to do it when their PC is on.';
  async function askFast(bot, turns, signal) {
    const last = calls.find((x) => x.botId === bot.id && x.status === 'done' && x.turns.length);
    const recent = last ? last.turns.slice(-6).map((t) => `${t.who === 'bot' ? bot.name : 'User'}: ${String(t.text).slice(0, 300)}`).join('\n') : '';
    const base = bot.prompt || `You are ${bot.name}, one of the user's bots in Codeply.${bot.specialty ? ` Your job: ${bot.specialty}.` : ''}${bot.instructions ? `\n${bot.instructions}` : ''}`;
    const system = `${base}\n\n${FAST_RULES}${pcOnline() ? '' : FAST_OFFLINE}${recent ? `\n\nTHE LAST CALL BEFORE THIS ONE\n${recent}` : ''}`;
    const messages = [{ role: 'system', content: system },
      ...turns.slice(-14).map((t) => ({ role: t.who === 'bot' ? 'assistant' : 'user', content: String(t.text || '').slice(0, 1000) }))];
    const token = await P.accessToken();
    // voice-chat: built for calls (budget and model in parallel, minimal reasoning); ai-proxy if it is not there.
    let res = await fetch(VOICE_CHAT_URL, {
      method: 'POST', signal,
      headers: { Authorization: `Bearer ${token}`, apikey: P.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, maxTokens: 260 }),
    });
    if (res.status === 404) {
      res = await fetch(P.AI_PROXY_URL, {
        method: 'POST', signal,
        headers: { Authorization: `Bearer ${token}`, apikey: P.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages, opts: { json: true, maxTokens: 260, temperature: 0.7 }, meta: { source: 'phone-call-fast' } }),
      });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) throw new Error(data.error || `Codeply could not answer (${res.status}).`);
    const raw = (data.data && data.data.choices && data.data.choices[0] && data.data.choices[0].message && data.data.choices[0].message.content) || '';
    let j = null;
    try { j = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)); } catch {}
    if (!j || typeof j.say !== 'string') return { say: raw.replace(/[{}"]/g, '').trim(), work: null };
    return { say: j.say, work: typeof j.work === 'string' && j.work.trim() ? j.work.trim() : null };
  }

  /** Say a line now (logged), without waiting for it to finish. */
  function sayNow(text, token) {
    text = spoken(text);
    if (!text || !c) return Promise.resolve();
    c.lastBotText = text;
    log('bot', text);
    return say(text, token);
  }

  // ─── Streaming turn (voice-turn) ──────────────────────────────────────────
  const STREAM_RULES = `LIVE VOICE CALL
You are on a live voice call; everything you write is spoken out loud right away.
- Talk like a person on the phone: short spoken sentences, plain words. No markdown, no lists, no emojis, no links, no long dash. Usually one to three sentences.
- If the user wants something that needs real tools (their email, calendar, files, code, sending a message, current news, anything on their computer), say one short natural line that fits what they asked, as if you are starting on it now (vary it, never "one sec" or "one moment"), then on a new line write [[WORK: one clear sentence describing the task]] and stop. Do not invent results.
- Things you already know (facts, advice, ideas, jokes, math, small talk) are not work: just answer.`;
  const STREAM_OFFLINE = '\n- Right now the user\'s PC is offline, so you cannot use tools: never write [[WORK: ...]]; if they ask for that kind of thing, say so in one sentence and offer to do it when their PC is on.';

  function pcmToFloat(b64) {
    const bin = atob(b64);
    const n = bin.length >> 1;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) { let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8); if (v >= 32768) v -= 65536; out[i] = v / 32768; }
    return out;
  }
  function wavFromFloat(chunks, rate) {
    let n = 0; for (const c2 of chunks) n += c2.length;
    const buf = new ArrayBuffer(44 + n * 2); const v = new DataView(buf);
    const w = (o, str) => { for (let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
    let o = 44;
    for (const c2 of chunks) for (let i = 0; i < c2.length; i++, o += 2) v.setInt16(o, Math.max(-1, Math.min(1, c2[i])) * 0x7fff, true);
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  }

  /**
   * Plays a streamed reply. Live mode: each PCM piece is scheduled on the
   * AudioContext as it arrives. Gathered mode (iOS suspended the context):
   * each sentence becomes a WAV played through the unlocked <audio> element.
   * A sentence without audio is said by the phone's voice, in order.
   */
  function makeStreamPlayer(me, token, onFirstSound) {
    const ctx = me.ctx;
    const live = !!ctx && ctx.state === 'running';
    const sources = new Set();
    let nextAt = 0; let stopped = false; let soundStarted = false;
    const sent = []; // sentences: { text, chunks, ended, hadAudio, startAt, dur }
    let queue = Promise.resolve(); // gathered mode and no-audio sentences play in order
    const alive = () => !stopped && c === me && token === me.token;
    const firstSound = () => { if (!soundStarted) { soundStarted = true; setPhase('speaking'); if (onFirstSound) onFirstSound(); } };
    me.playing = { fin: () => stop() };
    function stop() {
      stopped = true;
      for (const src of sources) { try { src.onended = null; src.stop(); } catch {} }
      sources.clear();
      stopReveal();
    }
    function schedule(item, data) {
      const b = ctx.createBuffer(1, data.length, item.rate);
      b.copyToChannel(data, 0);
      const src = ctx.createBufferSource();
      src.buffer = b;
      const gain = ctx.createGain();
      gain.gain.value = me.speaker ? 1 : 0.45;
      src.connect(gain); gain.connect(ctx.destination);
      const at = Math.max(ctx.currentTime + 0.03, nextAt);
      if (item.startAt == null) {
        item.startAt = at;
        // Words appear as they are said, from this sentence's start on the audio clock.
        const est = Math.max(0.6, item.text.length * 0.064);
        const delay = Math.max(0, (at - ctx.currentTime) * 1000);
        setTimeout(() => { if (alive()) revealTimed(item.text, () => ctx.currentTime - item.startAt, item.dur || est); }, delay);
      }
      src.start(at);
      nextAt = at + b.duration;
      item.dur = (item.dur || 0) + b.duration;
      sources.add(src);
      src.onended = () => sources.delete(src);
      firstSound();
    }
    return {
      say(i, text) { sent[i] = { text, chunks: [], ended: false, hadAudio: false, rate: 24000, startAt: null, dur: 0 }; me.lastBotText = sent.map((x) => x && x.text).join(' '); },
      pcm(i, b64, rate) {
        const item = sent[i]; if (!item || !alive()) return;
        item.hadAudio = true; item.rate = rate || 24000;
        const data = pcmToFloat(b64);
        if (live) schedule(item, data); else item.chunks.push(data);
      },
      end(i) {
        const item = sent[i]; if (!item) return;
        item.ended = true;
        if (!live && item.hadAudio) {
          const url = wavFromFloat(item.chunks, item.rate);
          item.chunks = [];
          queue = queue.then(() => (alive() ? (firstSound(), playEl({ url }, token, item.text)) : null));
        }
      },
      /** A sentence that never got audio: the phone's voice, after what is already playing. */
      noAudio(i) {
        const item = sent[i]; if (!item || item.hadAudio) return;
        const wait = live ? Math.max(0, (nextAt - ctx.currentTime) * 1000) : 0;
        queue = queue.then(() => new Promise((r) => setTimeout(r, wait))).then(() => (alive() ? (firstSound(), speakOne(item.text, token)) : null))
          .then(() => { if (live && ctx) nextAt = Math.max(nextAt, ctx.currentTime); });
      },
      /** Resolves when everything has been heard (or it was stopped). */
      async finished() {
        await queue;
        if (live) {
          while (alive() && ctx.currentTime < nextAt - 0.02) await sleep(60);
        }
        if (alive()) { stopReveal(); const last = sent.filter(Boolean).pop(); if (last) caption(last.text, 'bot'); }
        if (me.playing && me.playing.fin === stop) me.playing = null;
      },
      text: () => sent.filter(Boolean).map((x) => x.text).join(' '),
      stop,
    };
  }

  async function respondStream(token) {
    const me = c;
    setPhase('thinking');
    const controller = new AbortController();
    me.abort = controller;
    const bot = me.bot;
    const last = calls.find((x) => x.botId === bot.id && x.status === 'done' && x.turns.length);
    const recent = last ? last.turns.slice(-6).map((t) => `${t.who === 'bot' ? bot.name : 'User'}: ${String(t.text).slice(0, 300)}`).join('\n') : '';
    const base = bot.prompt || `You are ${bot.name}, one of the user's bots in Codeply.${bot.specialty ? ` Your job: ${bot.specialty}.` : ''}${bot.instructions ? `\n${bot.instructions}` : ''}`;
    const system = `${base}\n\n${STREAM_RULES}${pcOnline() ? '' : STREAM_OFFLINE}${recent ? `\n\nTHE LAST CALL BEFORE THIS ONE\n${recent}` : ''}`;
    const messages = [{ role: 'system', content: system },
      ...me.turns.slice(-14).map((t) => ({ role: t.who === 'bot' ? 'assistant' : 'user', content: String(t.text || '').slice(0, 1000) }))];
    if (me.ctx && me.ctx.state !== 'running') await wake(me.ctx);
    const t0 = performance.now();
    const auth = await P.accessToken();
    const res = await fetch(VOICE_TURN_URL, {
      method: 'POST', signal: controller.signal,
      headers: { Authorization: `Bearer ${auth}`, apikey: P.SUPABASE_ANON_KEY, 'Content-Type': 'application/json', ...VOICE_REGION },
      body: JSON.stringify({ messages, voice: me.dgVoice, format: 'pcm', maxTokens: 320 }),
    });
    if (!res.ok || !res.body || !/ndjson/i.test(res.headers.get('content-type') || '')) {
      let err = ''; try { err = (await res.json()).error || ''; } catch {}
      throw Object.assign(new Error(err || `voice-turn ${res.status}`), { status: res.status });
    }
    const player = makeStreamPlayer(me, token, () => {
      const ms = Math.round(performance.now() - t0);
      metrics.push({ kind: 'firstAudio', ms, at: Date.now(), via: 'stream' });
      console.debug(`[calls] request -> first sound: ${ms} ms (streamed)`);
    });
    let work = null; let said = 0;
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (c !== me || token !== me.token) { player.stop(); return; }
        buf += value;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          let o; try { o = JSON.parse(line); } catch { continue; }
          if (o.t === 'say') { player.say(o.i, o.text); said++; }
          else if (o.t === 'pcm') player.pcm(o.i, o.b64, o.rate);
          else if (o.t === 'end') player.end(o.i);
          else if (o.t === 'work') work = o.task;
          else if (o.t === 'error' && !said) throw new Error(o.error || 'The voice server failed.');
        }
      }
    } catch (e) {
      player.stop();
      if (e.name === 'AbortError' || c !== me || token !== me.token) return;
      if (!said) throw e; // nothing heard yet: let the slower path answer
    }
    // Sentences that never got audio are said by the phone's voice.
    for (let i = 0; i < said; i++) player.noAudio(i);
    const text = player.text();
    if (text) log('bot', text);
    if (work && pcOnline()) {
      // The opening line plays while the PC starts on the job.
      const playing = player.finished();
      await runWork(me, token, controller, work, playing);
      return;
    }
    await player.finished();
    if (c === me && token === me.token) { me.abort = null; setPhase('listening'); }
  }

  /** Real work on the PC (with the bot's tools) after the opening line; short updates on long jobs. */
  async function runWork(me, token, controller, task, playing) {
    me.stepLabel = '';
    let lastSpokeAt = performance.now();
    let updates = 0;
    const ui = {
      step: (label) => {
        if (c !== me || token !== me.token) return;
        me.stepLabel = `${label}...`;
        if (me.phase !== 'speaking') setPhase('thinking', me.stepLabel);
        if (updates < 2 && me.phase !== 'speaking' && performance.now() - lastSpokeAt > 9000) {
          updates++;
          lastSpokeAt = performance.now();
          const lines = [`Still ${label.charAt(0).toLowerCase()}${label.slice(1)}.`, 'Almost there.', 'Nearly done, hang on.'];
          sayNow(lines[(updates - 1) % lines.length], token);
        }
      },
      approve: (req, signal) => askApproval(req, signal),
    };
    const turns = me.turns.map((t, i) => (i === me.turns.length - 1 && t.who === 'user' ? { ...t, text: `${t.text}\n(The task: ${task})` } : t));
    let result = '';
    try {
      result = spoken(await askBotOnPc(me.bot, turns, controller.signal, ui));
    } catch (e) {
      hideApproval();
      if (c !== me || token !== me.token || e.name === 'AbortError') return;
      await playing;
      await sayNow("Sorry, I couldn't get that done just now. Want me to try again?", token);
      return;
    }
    hideApproval();
    await playing;
    if (c !== me || token !== me.token) return;
    me.abort = null;
    showNote();
    await sayNow(result || 'Done.', token);
  }

  async function respond(token) {
    if (api.stream !== false && VOICE_TURN_URL && !(c && c.noStream)) {
      try { return await respondStream(token); } catch (e) {
        if (!c || token !== c.token || e.name === 'AbortError') return;
        if (e.status === 404 || e.status === 429) c.noStream = true; // not deployed / limit: stop trying this call
        console.debug('[calls] streaming turn failed, using the fast lane:', e.message);
      }
    }
    if (api.fast !== false) {
      try { return await respondFast(token); } catch (e) {
        if (!c || token !== c.token || e.name === 'AbortError') return;
        console.debug('[calls] fast lane failed, using the full path:', e.message);
      }
    }
    return respondFull(token);
  }

  async function respondFast(token) {
    const me = c;
    setPhase('thinking');
    const controller = new AbortController();
    me.abort = controller;
    const t0 = performance.now();
    const fast = await api.fast_(me.bot, me.turns, controller.signal);
    if (c !== me || token !== me.token) return;
    metrics.push({ kind: 'fastReply', ms: Math.round(performance.now() - t0), work: !!fast.work, at: Date.now() });
    console.debug(`[calls] fast reply in ${Math.round(performance.now() - t0)} ms${fast.work ? ` (work: ${fast.work})` : ''}`);
    if (!fast.work || !pcOnline()) {
      me.abort = null;
      await sayNow(fast.say || 'Mm hm.', token);
      return;
    }
    // Real work: say the line now, run the job on the PC meanwhile.
    const ack = sayNow(fast.say, token);
    me.stepLabel = '';
    let lastSpokeAt = performance.now();
    let updates = 0;
    const ui = {
      step: (label) => {
        if (c !== me || token !== me.token) return;
        me.stepLabel = `${label}...`;
        if (me.phase !== 'speaking') setPhase('thinking', me.stepLabel);
        // A short, varied update on long jobs instead of silence.
        if (updates < 2 && me.phase !== 'speaking' && performance.now() - lastSpokeAt > 9000) {
          updates++;
          lastSpokeAt = performance.now();
          const lines = [`Still ${label.charAt(0).toLowerCase()}${label.slice(1)}.`, 'Almost there.', 'Nearly done, hang on.'];
          sayNow(lines[(updates - 1) % lines.length], token);
        }
      },
      approve: (req, signal) => askApproval(req, signal),
    };
    const turns = me.turns.map((t, i) => (i === me.turns.length - 1 && t.who === 'user' ? { ...t, text: `${t.text}\n(The task: ${fast.work})` } : t));
    let result = '';
    try {
      result = spoken(await askBotOnPc(me.bot, turns, controller.signal, ui));
    } catch (e) {
      hideApproval();
      if (c !== me || token !== me.token || e.name === 'AbortError') return;
      await ack;
      await sayNow("Sorry, I couldn't get that done just now. Want me to try again?", token);
      return;
    }
    hideApproval();
    await ack;
    if (c !== me || token !== me.token) return;
    me.abort = null;
    showNote();
    await sayNow(result || 'Done.', token);
  }

  async function respondFull(token) {
    setPhase('thinking');
    const controller = new AbortController();
    c.abort = controller;
    let text = '';
    c.filler = null;
    c.stepLabel = '';
    const ui = {
      step: (label) => {
        if (!c || token !== c.token) return;
        c.stepLabel = `${label}...`;
        if (c.phase !== 'speaking') setPhase('thinking', c.stepLabel);
      },
      approve: (req, signal) => askApproval(req, signal),
    };
    try {
      text = spoken(await api.reply(c.bot, c.turns, controller.signal, ui));
      hideApproval();
      if (c && c.filler) await c.filler;
    } catch (e) {
      hideApproval();
      if (!c || token !== c.token || e.name === 'AbortError') return;
      q('.call-note').textContent = /fetch|network/i.test(e.message) ? "Can't reach Codeply. Check your internet connection." : e.message;
      await say('Sorry, I lost my train of thought. Say that again?', token);
      return;
    }
    if (!c || token !== c.token) return;
    c.abort = null;
    showNote();
    text = text || 'Mm hm.';
    c.lastBotText = text;
    log('bot', text);
    await say(text, token);
  }

  // Hearing, our own way: the kept mic stream -> voice detector -> Whisper.
  const MIC_DENIED = 'Codeply needs the microphone for calls. Allow it for this app in your settings, or type below.';
  async function startLocalEars() {
    const me = c;
    if (!me || me.typing || me.muted || me.ending) return;
    if (!me.ctx) return useTyping("This browser can't hear you. Type below and the bot still talks back.");
    sttLoad();
    try {
      await getMic();
      if (c !== me || me.ending) return;
      if (me.muted) { micEnabled(false); return; }
      await wireMic(me.ctx);
      await wake(me.ctx);
    } catch (e) {
      if (c !== me) return;
      const n = (e && e.name) || '';
      if (n === 'NotAllowedError' || n === 'SecurityError') return useTyping(MIC_DENIED);
      if (n === 'NotFoundError' || n === 'OverconstrainedError') return useTyping('No microphone found. Type below instead.');
      return useTyping("Voice input isn't working here. Type below and the bot still talks back.");
    }
    if (c !== me || me.typing || me.muted) return;
    me.ears = true;
    if (stt.state === 'failed') useTyping("Voice input couldn't start on this phone. Type below and the bot still talks back.");
  }
  /** SpeechRecognition gave up: switch this call (and the session) to Whisper. */
  function switchToLocalEars() {
    if (!c) return;
    srBroken = true;
    stopListening();
    startLocalEars();
  }

  // Hearing with the browser's SpeechRecognition (Chrome), restarted after every result.
  function startListening() {
    if (!c || c.typing || c.muted || c.ending) return;
    if (localEars()) { startLocalEars(); return; }
    if (!SR || c.rec) return;
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
      if (err === 'not-allowed') return useTyping(MIC_DENIED);
      if (err === 'audio-capture') return useTyping('No microphone found. Type below instead.');
      // The browser's recognizer itself is unavailable (offline, blocked service): use Whisper.
      if (err === 'service-not-allowed' || err === 'network' || err === 'language-not-supported') return switchToLocalEars();
    };
    rec.onend = () => {
      if (c !== me) return;
      c.rec = null;
      const quick = Date.now() - me.recAt < 1200;
      me.fails = quick ? (me.fails || 0) + 1 : 0;
      if (me.fails >= 6) return switchToLocalEars();
      setTimeout(startListening, quick ? 400 : 60);
    };
    try { me.recAt = Date.now(); rec.start(); } catch { c.rec = null; }
  }
  function stopListening() {
    if (!c) return;
    if (c.ears) { c.ears = false; if (c.vad) c.vad.reset(); }
    if (!c.rec) return;
    const r = c.rec; c.rec = null;
    r.onend = null; r.onresult = null; r.onerror = null;
    try { r.abort(); } catch {}
  }
  function useTyping(msg) {
    if (!c) return;
    stopListening();
    micEnabled(false);
    c.typing = true;
    root().classList.add('typing');
    c.noteBase = msg || '';
    showNote();
    if (c.phase === 'listening') setPhase('listening');
  }

  async function startCall(bot) {
    if (c) return;
    // Everything audio starts inside this tap: iOS only allows it from a user gesture.
    const ctx = audioCtx();
    const local = localEars();
    if (local) {
      // The kept mic: asked for once, then only re-enabled on later calls.
      try { if (navigator.audioSession) navigator.audioSession.type = 'play-and-record'; } catch {}
      getMic().catch(() => {}); // started inside the tap; startLocalEars() handles the outcome
      if (stt.state === 'failed') stt.state = 'idle'; // a new call gets a fresh try
      sttLoad();
    }
    if (synth) { try { synth.cancel(); const u = new SpeechSynthesisUtterance(' '); u.volume = 0; synth.speak(u); } catch {} }
    unlockVoiceEl(); // inside the tap, so iOS lets it play the bot's voice later
    warmTts(); // wakes the voice function while it rings

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

    const canHear = local ? !!(ctx && window.Worker && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) : !!SR;
    c = {
      id: newId(), bot, ctx, token: 0, turns: [], muted: false, speaker: true, typing: !canHear, phase: 'ringing',
      startedAt: Date.now(), connectedAt: 0, lastBotText: '', rec: null, abort: null, ending: false,
      voice: voiceFor(bot), pitch: 0.92 + (hash(`${bot.id}p`) % 17) / 100, fails: 0, recAt: 0,
      ears: false, vad: null, queued: null, dgVoice: deepgramVoice(bot), ttsOff: !TTS_URL, ttsCtl: null, ttsNote: '', playing: null, noteBase: '',
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
    if (!canHear) { c.noteBase = "This browser can't hear you. Type below and the bot still talks back."; showNote(); }
    else startListening(); // asks for the mic now, inside the tap; results are ignored while it rings

    c.stopRing = ctx ? ring(ctx) : () => {};
    await new Promise((res) => setTimeout(res, api.ringMs));
    if (c !== me || me.ending) return;
    c.stopRing();
    c.connectedAt = Date.now();
    c.timer = setInterval(tick, 500);
    // Keep the voice function warm through long quiet stretches.
    c.warmTimer = setInterval(() => { if (c && Date.now() - Math.max(c.lastTtsAt || 0, lastWarm) > 240000) warmTts(); }, 30000);
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
    if (c.muted) { stopListening(); micEnabled(false); } else startListening();
    if (c.phase === 'listening') setPhase('listening');
  }
  function toggleSpeaker() {
    if (!c) return;
    c.speaker = !c.speaker;
    q('[data-c="speaker"]').classList.toggle('on', c.speaker);
    if (c.playing) { try { const v = c.speaker ? 1 : 0.45; if (c.playing.gain) c.playing.gain.gain.value = v; if (c.playing.el) c.playing.el.volume = v; } catch {} }
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
    // Never stop the kept mic's track (iOS would ask again next call): just disable it.
    micEnabled(false);
    call.queued = null;
    clearInterval(call.timer);
    clearInterval(call.warmTimer);
    try { if (call.wake) call.wake.release(); } catch {}
    // The page keeps its one AudioContext; it is resumed in the next Call tap.
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
  // The kept stream normally survives this (iOS just pauses it); it is only
  // asked for again if iOS really ended it (say, a real phone call came in).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !c || c.ending) return;
    if (c.ctx) wake(c.ctx);
    if (localEars()) { if (!c.typing && !c.muted && (!c.ears || !micLive())) { c.ears = false; startLocalEars(); } }
    else if (!c.rec) startListening();
  });
  window.addEventListener('craft:pc-online', () => { pushPending().then(refreshBots).then(syncCalls); });

  $('drawerCalls').addEventListener('click', () => { P.closeDrawer(); openCalls(); });
  $('callsBack').addEventListener('click', closeCalls);

  // ─── Build a bot from a prompt ────────────────────────────────────────────
  // Same wording as codeply-cli/lib/bots.js describePrompt(); keep in sync.
  const TONES = ['friendly', 'concise', 'professional', 'playful', 'direct', 'teacher'];
  function describePrompt(text) {
    return `Design a helpful AI bot from this description: "${String(text).slice(0, 600)}"
Respond with ONLY a JSON object:
{"name": "a short, friendly first name (not a common word)", "specialty": "what it does, one line", "instructions": "how it works: what it always does and never does, 2 to 4 sentences", "tone": {"preset": one of ${JSON.stringify(TONES)}, "custom": "optional extra tone note"}, "role": "specialist" or "orchestrator" (orchestrator only if it should lead other bots)}`;
  }
  const BUILD_IDEAS = ['Reads my email every morning and tells me what matters', 'A patient tutor who explains math simply', 'Writes my LinkedIn posts in my voice', 'Keeps an eye on my website'];
  const BUILD_VOICES = [
    ['', 'Pick for me'], ['aura-2-thalia-en', 'Thalia, clear and upbeat'], ['aura-2-luna-en', 'Luna, friendly'], ['aura-2-helena-en', 'Helena, warm'],
    ['aura-2-athena-en', 'Athena, calm'], ['aura-2-orion-en', 'Orion, easygoing'], ['aura-2-apollo-en', 'Apollo, confident'],
    ['aura-2-arcas-en', 'Arcas, smooth'], ['aura-2-zeus-en', 'Zeus, deep'], ['aura-2-pandora-en', 'Pandora, British'], ['aura-2-draco-en', 'Draco, British'],
  ];
  const randomAvatar = (seed) => { try { return A() ? A().randomAvatar(seed) : {}; } catch { return {}; } };
  const cleanAvatar = (a) => { try { return A() ? A().normalizeAvatar(a) : a; } catch { return a; } };

  function draftFrom(json, text) {
    const j = json && typeof json === 'object' ? json : {};
    const name = String(j.name || '').trim().slice(0, 40) || 'Nova';
    return {
      name,
      specialty: String(j.specialty || text).trim().slice(0, 200),
      instructions: String(j.instructions || '').trim().slice(0, 4000),
      tone: { preset: TONES.includes(j.tone && j.tone.preset ? j.tone.preset : j.tone) ? (j.tone.preset || j.tone) : 'friendly', custom: String((j.tone && j.tone.custom) || '').slice(0, 400) },
      role: j.role === 'orchestrator' ? 'orchestrator' : 'specialist',
      avatar: cleanAvatar(j.avatar && typeof j.avatar === 'object' ? j.avatar : randomAvatar(`${name}${Date.now()}`)),
      voice: '',
    };
  }

  /** A draft bot from a description: the PC when it is online, else Codeply's AI from here. */
  async function draftBot(text) {
    if (pcOnline()) {
      try {
        const r = await P.relayRequest('POST', '/api/bots/describe', { text });
        if (r && r.draft) return { ...r.draft, avatar: cleanAvatar(r.draft.avatar), voice: r.draft.voice || '' };
        if (r && r.error) throw new Error(r.error);
      } catch (e) { if (!e.timeout && !/Not found|404/i.test(e.message)) throw e; }
    }
    const token = await P.accessToken();
    const res = await fetch(P.AI_PROXY_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, apikey: P.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: describePrompt(text) }], opts: { json: true, maxTokens: 500, temperature: 0.6 }, meta: { source: 'phone-bot-builder' } }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) throw new Error(data.error || `Codeply could not build it (${res.status}).`);
    const raw = (data.data && data.data.choices && data.data.choices[0] && data.data.choices[0].message && data.data.choices[0].message.content) || '';
    let json = {};
    try { json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)); } catch {}
    return draftFrom(json, text);
  }

  /** A bot made here while the PC was offline: callable now, saved on the PC later. */
  function pendingBot(d) {
    const id = `p_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const prompt = `BOT IDENTITY\nYou are ${d.name}, a specialist bot inside Codeply.${d.specialty ? `\n\nSPECIALTY\n${d.specialty}` : ''}${d.instructions ? `\n\nHOW YOU WORK\n${d.instructions}` : ''}\n\nTONE\nBe ${d.tone.preset}.`;
    return { ...d, id, pending: true, prompt, memory: [], updatedAt: Date.now() };
  }

  async function pushPending() {
    if (!pcOnline()) return;
    for (const b of cache.bots.filter((x) => x.pending)) {
      try {
        const r = await P.relayRequest('POST', '/api/bots/create', { bot: { name: b.name, role: b.role, specialty: b.specialty, instructions: b.instructions, tone: b.tone, avatar: b.avatar, voice: b.voice } });
        if (!r || !r.bot) continue;
        cache.bots = cache.bots.filter((x) => x.id !== b.id);
        for (const call of calls) if (call.botId === b.id) { call.botId = r.bot.id; call.synced = false; }
        storeCatalog(r);
        saveCalls();
      } catch { break; }
    }
    renderCallsIfOpen();
  }

  let previewing = null;
  async function previewVoice(voice, name, btn) {
    if (previewing) { try { previewing.pause(); } catch {} previewing = null; }
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Loading...';
    try {
      const token = await P.accessToken();
      const res = await fetch(TTS_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, apikey: P.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `Hi, I'm ${name || 'your new bot'}. This is how I sound on a call.`, voice: voice || deepgramVoice({ id: name }) }),
      });
      if (!res.ok || /json/i.test(res.headers.get('content-type') || '')) throw new Error((await res.json().catch(() => ({}))).error || 'The voice did not load.');
      const url = URL.createObjectURL(await res.blob());
      previewing = new Audio(url);
      previewing.onended = () => URL.revokeObjectURL(url);
      await previewing.play();
    } catch (e) { builderError(e.message); }
    btn.disabled = false; btn.textContent = label;
  }

  let builder = null;
  function builderError(msg) { const el = builder && builder.root.querySelector('.nb-err'); if (el) el.textContent = msg || ''; }
  function closeBuilder() { if (builder) { builder.root.remove(); builder = null; } }

  function openBuilder() {
    closeBuilder();
    const root = document.createElement('div');
    root.className = 'sheet nb-sheet';
    document.body.appendChild(root);
    builder = { root, step: 'describe', text: '', draft: null, busy: false };
    paintBuilder();
  }

  function paintBuilder() {
    const b = builder;
    if (!b) return;
    let body;
    if (b.step === 'describe') {
      body = `<h2 class="sheet-title">New bot</h2>
        <p class="sheet-text">Say what it should do and how it should talk. Codeply builds the rest.</p>
        <div class="field"><textarea id="nbText" rows="3" placeholder="A patient tutor who explains math with simple examples">${esc(b.text)}</textarea></div>
        <div class="nb-ideas">${BUILD_IDEAS.map((t) => `<button type="button" class="nb-idea">${esc(t)}</button>`).join('')}</div>
        <p class="nb-err"></p>
        <div class="sheet-actions"><button type="button" class="btn btn-quiet" data-nb="close">Cancel</button><button type="button" class="btn btn-primary" data-nb="build" ${b.busy ? 'disabled' : ''}>${b.busy ? 'Building...' : 'Build'}</button></div>`;
    } else {
      const d = b.draft;
      body = `<h2 class="sheet-title">Meet ${esc(d.name)}</h2>
        <div class="nb-stage">${avatarHtml(d, 120)}<button type="button" class="nb-surprise" data-nb="surprise">Surprise me</button></div>
        <div class="field"><label for="nbName">Name</label><input id="nbName" maxlength="40" value="${esc(d.name)}"></div>
        <div class="field"><label for="nbJob">What it does</label><input id="nbJob" maxlength="200" value="${esc(d.specialty)}"></div>
        <div class="field"><label for="nbVoice">Voice on calls</label>
          <div class="nb-voice"><select id="nbVoice">${BUILD_VOICES.map(([id, label]) => `<option value="${id}" ${d.voice === id ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select>
          <button type="button" class="btn btn-quiet nb-preview" data-nb="preview">Preview</button></div></div>
        <p class="nb-err"></p>
        <div class="sheet-actions"><button type="button" class="btn btn-quiet" data-nb="back">Back</button><button type="button" class="btn btn-primary" data-nb="create" ${b.busy ? 'disabled' : ''}>${b.busy ? 'Creating...' : 'Create bot'}</button></div>`;
    }
    b.root.innerHTML = `<div class="sheet-bg" data-nb="close"></div><div class="sheet-card"><div class="sheet-handle"></div>${body}</div>`;
    const q2 = (sel) => b.root.querySelector(sel);
    b.root.querySelectorAll('[data-nb="close"]').forEach((el) => el.addEventListener('click', closeBuilder));
    if (b.step === 'describe') {
      const t = q2('#nbText');
      t.addEventListener('input', () => { b.text = t.value; });
      b.root.querySelectorAll('.nb-idea').forEach((el) => el.addEventListener('click', () => { b.text = el.textContent; t.value = b.text; t.focus(); }));
      q2('[data-nb="build"]').addEventListener('click', async () => {
        if (!b.text.trim()) { t.focus(); return; }
        b.busy = true; paintBuilder();
        try { b.draft = await draftBot(b.text.trim()); b.step = 'review'; }
        catch (e) { b.busy = false; paintBuilder(); builderError(e.message); return; }
        b.busy = false; paintBuilder();
      });
      if (!b.busy) t.focus();
    } else {
      const d = b.draft;
      q2('#nbName').addEventListener('input', (e) => { d.name = e.target.value; });
      q2('#nbJob').addEventListener('input', (e) => { d.specialty = e.target.value; });
      q2('#nbVoice').addEventListener('change', (e) => { d.voice = e.target.value; });
      q2('[data-nb="surprise"]').addEventListener('click', () => { d.avatar = randomAvatar(Math.random()); paintBuilder(); });
      q2('[data-nb="preview"]').addEventListener('click', (e) => previewVoice(d.voice, d.name, e.currentTarget));
      q2('[data-nb="back"]').addEventListener('click', () => { b.step = 'describe'; paintBuilder(); });
      q2('[data-nb="create"]').addEventListener('click', async () => {
        if (!String(d.name || '').trim()) { builderError('Give it a name.'); return; }
        b.busy = true; paintBuilder();
        let made = null;
        try {
          if (pcOnline()) {
            const r = await P.relayRequest('POST', '/api/bots/create', { bot: { name: d.name, role: d.role, specialty: d.specialty, instructions: d.instructions, tone: d.tone, avatar: d.avatar, voice: d.voice } });
            if (r && r.error) throw new Error(r.error);
            storeCatalog(r);
            made = r.bot;
          }
        } catch (e) { if (!e.timeout && !/offline|didn't answer/i.test(e.message)) { b.busy = false; paintBuilder(); builderError(e.message); return; } }
        if (!made) {
          made = pendingBot(d);
          cache.bots = [made, ...cache.bots];
          save(KEY.bots, cache);
        } else {
          cache.bots = [made, ...cache.bots.filter((x) => x.id !== made.id)];
          save(KEY.bots, cache);
        }
        closeBuilder();
        renderCallsIfOpen();
        builtToast(made);
      });
    }
  }

  function builtToast(bot) {
    const t = document.createElement('div');
    t.className = 'nb-toast';
    t.innerHTML = `<span>${esc(bot.name)} is ready.</span><button type="button">${ICON.phone}Call</button>`;
    t.querySelector('button').addEventListener('click', () => { t.remove(); startCall(botById(bot.id) || bot); });
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 6000);
  }

  // reply/ringMs/endedMs are swappable for tests in the console; localEars
  // forces the kept-mic + Whisper path on browsers that have SpeechRecognition.
  const api = { reply: askBot, fast_: askFast, fast: true, stream: true, ringMs: 2400, endedMs: 1100, localEars: false };
  window.CraftCalls = {
    api, openCalls, closeCalls, startCall, endCall, refreshBots, syncCalls, spoken, sentences, VOICE_RULES, openBuilder, pushPending,
    heard: heardText, active: () => c, cache, calls: () => calls,
    supported: { recognition: !!SR, synthesis: !!synth, localEars: localEars(), ios: IS_IOS },
    _test: {
      transcribe, to16k, deepgramVoice, chunks, isRealSpeech: (t, said) => { const was = c && c.lastBotText; if (c) c.lastBotText = said || ''; const r = c ? isRealSpeech(t) : clearWords(t).length >= 2; if (c) c.lastBotText = was; return r; }, wordPlan, metrics, ttsUrl: TTS_URL, loadModel: sttLoad, stt: () => ({ state: stt.state, device: stt.device, progress: stt.progress, error: stt.error }),
      mic: () => ({ live: micLive(), enabled: !!(micTrack() && micTrack().enabled), streamId: mic.stream && mic.stream.id }),
      /** Push audio through a fresh voice detector; returns the 16 kHz utterances it cut out. */
      vadFeed(samples, sampleRate = 16000, opts = {}) {
        const out = [];
        const v = makeVad(sampleRate, { start: () => out.push({ startAt: done }), end: (a) => { out[out.length - 1].audio = a; } });
        v.botSpeaking = !!opts.botSpeaking;
        const n = Math.round(sampleRate * 1024 / 48000) || 1024;
        let done = 0;
        const quiet = new Float32Array(Math.round(sampleRate * 1.2)); // let the end be detected
        const all = new Float32Array(samples.length + quiet.length); all.set(samples);
        for (let i = 0; i < all.length; i += n) { v.feed(all.slice(i, i + n)); done = i + n; }
        v.flush();
        return out.filter((u) => u.audio);
      },
    },
  };
})();
