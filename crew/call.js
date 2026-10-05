// Calling a bot: a live, hands-free voice conversation, app to app.
//
// Mic -> Silero VAD (here, in the window) cuts the audio into utterances ->
// Whisper on this PC turns each into text -> the bot answers in a few spoken
// sentences -> Edge or Kokoro voice reads it out, sentence by sentence, so it
// starts talking before the whole answer is synthesized. Talk over the bot
// and it stops and listens, like a real call. Free: no number, no telecom,
// no paid speech API.
(() => {
  const api = window.crew;
  const A = window.CraftAvatar;
  const esc = window.CrewMarkdown.esc;
  const $ = (sel, root = document) => root.querySelector(sel);

  const ICON = {
    mic: '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
    micOff: '<svg viewBox="0 0 24 24"><path d="M3 3l18 18M9 9v2a3 3 0 0 0 5.1 2.1M15 10V6a3 3 0 0 0-5.7-1.3M5 11a7 7 0 0 0 11.5 5.4M19 11a7 7 0 0 1-.6 2.8M12 18v3"/></svg>',
    end: '<svg viewBox="0 0 24 24"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/></svg>',
    text: '<svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h10M4 18h13"/></svg>',
  };

  let c = null; // the call in progress

  function el() { return $('#call'); }

  function setStatus(kind, text) {
    if (!c) return;
    const root = el();
    root.classList.remove('ringing', 'listening', 'thinking', 'speaking');
    root.classList.add(kind);
    $('.call-status', root).textContent = text;
    A.setAvatarState($('.call-orb', root), kind === 'thinking' ? 'working' : 'idle');
  }

  function caption(text, who) {
    if (!c) return;
    const cap = $('.call-caption', el());
    cap.textContent = text || '';
    cap.classList.toggle('you', who === 'user');
  }

  function log(who, text) {
    c.turns.push({ who, text });
    const box = $('.call-log', el());
    if (!box) return;
    const row = document.createElement('div');
    row.innerHTML = `<b>${who === 'bot' ? esc(c.bot.name) : 'You'}</b>${esc(text)}`;
    box.appendChild(row);
    box.scrollTop = box.scrollHeight;
  }

  // ─── Ringing ────────────────────────────────────────────────────────────
  function ring(ctx) {
    let stop = false;
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
      setTimeout(burst, 2600);
    };
    burst();
    return () => { stop = true; };
  }

  // ─── Speaking ───────────────────────────────────────────────────────────
  function sentences(text) {
    const parts = String(text || '').match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) || [];
    const out = [];
    for (const p of parts.map((x) => x.trim()).filter(Boolean)) {
      if (out.length && (out[out.length - 1].length < 28 || p.length < 6)) out[out.length - 1] += ` ${p}`;
      else out.push(p);
    }
    return out;
  }

  function play(audio, token) {
    return new Promise((resolve) => {
      if (!c || token !== c.token) { resolve(false); return; }
      const blob = new Blob([audio.data], { type: audio.mime });
      const url = URL.createObjectURL(blob);
      const a = new Audio(url);
      c.playing = a;
      const src = c.ctx.createMediaElementSource(a);
      src.connect(c.analyser);
      const done = (ok) => { URL.revokeObjectURL(url); try { src.disconnect(); } catch {} if (c && c.playing === a) c.playing = null; resolve(ok); };
      a.onended = () => done(true);
      a.onerror = () => done(false);
      a.onpause = () => { if (!a.ended) done(false); };
      a.play().catch(() => done(false));
    });
  }

  function interrupt() {
    if (!c) return;
    c.token++;
    if (c.playing) { try { c.playing.pause(); } catch {} c.playing = null; }
    c.vad && c.vad.setOptions({ positiveSpeechThreshold: 0.55 });
  }

  /** Say text out loud, sentence by sentence. Stops if interrupted. */
  async function say(text, token) {
    const list = sentences(text);
    if (!list.length) return;
    setStatus('speaking', 'Speaking');
    caption(text, 'bot');
    // While the bot talks, only clear, sustained speech counts as you
    // cutting in, so its own voice from the speakers does not.
    c.vad && c.vad.setOptions({ positiveSpeechThreshold: 0.85 });
    let next = api.tts(c.bot.id, list[0]);
    for (let i = 0; i < list.length; i++) {
      const audio = await next;
      if (!c || token !== c.token) return;
      if (i + 1 < list.length) next = api.tts(c.bot.id, list[i + 1]);
      if (audio.error) { window.crewToast(`Voice: ${audio.error}`, 'error'); break; }
      audio.data = audio.data instanceof Uint8Array ? audio.data : new Uint8Array(audio.data);
      const ok = await play(audio, token);
      if (!ok || !c || token !== c.token) return;
    }
    if (c && token === c.token) {
      c.vad && c.vad.setOptions({ positiveSpeechThreshold: 0.55 });
      // A filler ("One sec.") ends while the bot is still working: back to its status.
      if (c.pending === token) setStatus('thinking', c.stepText || 'Working on it...');
      else setStatus('listening', c.muted ? 'Muted' : 'Listening');
    }
  }

  // ─── Hearing ────────────────────────────────────────────────────────────
  const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
  /** Whisper heard the bot's own voice from the speakers, not the user. */
  function isEcho(text) {
    const said = new Set(words(c.lastBotText));
    const heard = words(text);
    if (!heard.length || !said.size) return false;
    const hit = heard.filter((w) => said.has(w)).length;
    return heard.length >= 2 && hit / heard.length >= 0.8;
  }

  async function heard(audio) {
    if (!c || c.muted || c.ending) return;
    const token = ++c.token;
    setStatus('thinking', 'Listening...');
    if (c.prepP) {
      const ready = await Promise.race([c.prepP.then(() => true), new Promise((r) => setTimeout(() => r(false), 300))]);
      if (!ready) { setStatus('thinking', 'Getting ready to hear you (first time only)...'); await c.prepP; }
      if (!c || token !== c.token) return;
      c.prepP = null;
    }
    const r = await api.stt(audio);
    if (!c || token !== c.token) return;
    const text = (r && r.text) || '';
    if (r && r.error) { window.crewToast(`Could not hear that: ${r.error}`, 'error'); setStatus('listening', 'Listening'); return; }
    if (!text || isEcho(text)) { setStatus('listening', 'Listening'); return; }
    // Talking while the bot is still working on the last thing: drop that turn.
    if (c.pending) { api.voiceCancel(c.bot.id); c.pending = 0; hideApproval(); }
    log('user', text);
    caption(text, 'user');
    await respond(token);
  }

  async function respond(token) {
    setStatus('thinking', 'Thinking');
    Object.assign(c, { pending: token, stepText: '', filler: null });
    const r = await api.voiceReply(c.bot.id, c.turns);
    if (c && c.pending === token) c.pending = 0;
    if (!c || token !== c.token || r.cancelled) return;
    hideApproval();
    if (c.filler) await c.filler; // let "One sec." finish first
    if (!c || token !== c.token) return;
    if (r.error) {
      window.crewToast(r.error, 'error');
      await say('Sorry, I lost my train of thought. Say that again?', token);
      return;
    }
    const text = r.text || 'Mm hm.';
    c.lastBotText = text;
    log('bot', text);
    await say(text, token);
  }

  // ─── While the bot works (tools, approvals) ─────────────────────────────
  // Events from main.js for this call: which tool is running, and approvals
  // for anything outside the bot's boundary (sending an email, editing files).
  function onEvent(ev) {
    if (!c || ev.botId !== c.bot.id) return;
    if (ev.type === 'call_step') {
      if (ev.done) return;
      c.stepText = `${ev.label}...`;
      if (c.pending && !c.playing) setStatus('thinking', c.stepText);
      if (c.pending && !c.filler) {
        const turn = c.pending;
        c.lastBotText = 'One sec.';
        c.filler = say('One sec.', turn);
      }
    } else if (ev.type === 'approval') {
      showApproval(ev);
    } else if (ev.type === 'approval_done') {
      hideApproval(ev.requestId);
    }
  }

  function showApproval(ev) {
    hideApproval();
    const box = document.createElement('div');
    box.className = `call-approve${ev.danger ? ' danger' : ''}`;
    box.dataset.req = ev.requestId;
    if (ev.draft) {
      // An email: To, Subject and Body are editable before it goes out.
      box.classList.add('call-email');
      box.innerHTML = `<div class="call-approve-title">${esc(ev.title || 'Send this email?')}</div>
        <label class="email-field"><span>To</span><input data-f="to" type="text" spellcheck="false" value="${esc(ev.draft.to)}"></label>
        <label class="email-field"><span>Subject</span><input data-f="subject" type="text" value="${esc(ev.draft.subject)}"></label>
        <textarea class="email-body" data-f="body" rows="5">${esc(ev.draft.body)}</textarea>
        <div class="call-approve-row"><button data-v="reject">Don't send</button>${ev.draftOnly ? '' : '<button data-v="draft">Save as draft</button>'}<button class="primary" data-v="once">${ev.draftOnly ? 'Save draft' : 'Send'}</button></div>`;
    } else {
      box.innerHTML = `<div class="call-approve-title">${esc(ev.title || 'Allow this?')}</div>
        ${ev.detail ? `<pre>${esc(String(ev.detail).slice(0, 600))}</pre>` : ''}
        <div class="call-approve-row"><button data-v="reject">Don't allow</button><button class="primary" data-v="once">Allow</button></div>`;
    }
    const answer = (v) => {
      const fields = box.querySelectorAll('[data-f]');
      if (!fields.length || v === 'reject') return v;
      const edits = {};
      fields.forEach((f) => { edits[f.dataset.f] = f.value; });
      return { verdict: v, edits };
    };
    box.querySelectorAll('[data-v]').forEach((b) => b.addEventListener('click', () => { api.respond(ev.requestId, answer(b.dataset.v)); hideApproval(); }));
    el().appendChild(box);
    setStatus('thinking', 'Needs your OK');
  }
  function hideApproval(requestId) {
    const box = c && $('.call-approve', el());
    if (box && (!requestId || box.dataset.req === requestId)) box.remove();
  }

  // ─── Levels for the orb ─────────────────────────────────────────────────
  function animate() {
    if (!c) return;
    const buf = new Uint8Array(c.analyser.fftSize);
    c.analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) { const x = (v - 128) / 128; sum += x * x; }
    const level = Math.min(1, Math.sqrt(sum / buf.length) * 4);
    el().style.setProperty('--level', level.toFixed(3));
    el().style.setProperty('--mic', c.mic.toFixed(3));
    c.raf = requestAnimationFrame(animate);
  }

  function tick() {
    if (!c || !c.connectedAt) return;
    const s = Math.floor((Date.now() - c.connectedAt) / 1000);
    $('.call-timer', el()).textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  // ─── Start / end ────────────────────────────────────────────────────────
  async function start(botId) {
    if (c) return;
    const b = window.CrewUI.bot(botId);
    if (!b) return;
    const root = el();
    root.style.setProperty('--call-tint', A.colorHex(b.avatar.color));
    root.className = 'call ringing';
    root.innerHTML = `
      <div class="call-top"><span class="call-badge"><span class="dot"></span>Crew call, end to end on this PC</span><span class="call-timer"></span></div>
      <div class="call-center">
        <div class="call-orb">${A.renderAvatar(b.avatar, 168)}</div>
        <div class="call-name">${esc(b.name)}</div>
        <div class="call-status">Calling...</div>
        <div class="call-caption"></div>
      </div>
      <div class="call-log hidden"></div>
      <div class="call-controls">
        <div class="cc-wrap"><button class="cc" data-c="mute" aria-label="Mute">${ICON.mic}</button><div class="cc-label">Mute</div></div>
        <div class="cc-wrap"><button class="cc end" data-c="end" aria-label="End call">${ICON.end}</button><div class="cc-label">End</div></div>
        <div class="cc-wrap"><button class="cc" data-c="log" aria-label="Transcript">${ICON.text}</button><div class="cc-label">Transcript</div></div>
      </div>`;
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.connect(ctx.destination);
    c = { bot: b, ctx, analyser, token: 0, turns: [], muted: false, mic: 0, startedAt: Date.now(), connectedAt: 0, lastBotText: '', vad: null, playing: null, ending: false };
    root.querySelector('[data-c="end"]').addEventListener('click', end);
    root.querySelector('[data-c="mute"]').addEventListener('click', toggleMute);
    root.querySelector('[data-c="log"]').addEventListener('click', (e) => { $('.call-log', root).classList.toggle('hidden'); e.currentTarget.classList.toggle('on'); });
    document.addEventListener('keydown', onKey);
    animate();

    const stopRing = ring(ctx);
    c.stopRing = stopRing;
    const minRing = new Promise((r) => setTimeout(r, 2200));
    const me = c;
    try {
      // The speech model loads in the background (Crew starts it at launch); the
      // call never waits for it. The first thing said waits for it if needed.
      const prepP = api.voicePrepare().catch(() => null);
      me.prepP = prepP;
      const [vad] = await Promise.all([
        window.vad.MicVAD.new({
          model: 'v5',
          // Absolute: vad-web resolves relative paths against its own script.
          baseAssetPath: new URL('../node_modules/@ricky0123/vad-web/dist/', location.href).href,
          onnxWASMBasePath: new URL('../node_modules/onnxruntime-web/dist/', location.href).href,
          positiveSpeechThreshold: 0.55,
          negativeSpeechThreshold: 0.4,
          redemptionMs: 700,
          minSpeechMs: 250,
          preSpeechPadMs: 300,
          startOnLoad: false,
          getStream: () => navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } }),
          onSpeechRealStart: () => {
            if (!c || c.muted) return;
            if (c.playing) interrupt();
            if (!c.playing) setStatus('listening', 'Listening');
          },
          onSpeechEnd: (audio) => heard(audio),
          onFrameProcessed: (probs, frame) => {
            if (!c) return;
            let s = 0;
            for (let i = 0; i < frame.length; i += 4) s += frame[i] * frame[i];
            c.mic = c.muted ? 0 : Math.min(1, Math.sqrt(s / (frame.length / 4)) * 6);
          },
        }),
        minRing,
      ]);
      // Hung up while it was loading: the mic was never started, so there is little to free.
      if (c !== me) { Promise.resolve().then(() => vad.destroy()).catch(() => {}); return; }
      c.vad = vad;
      stopRing();
      c.connectedAt = Date.now();
      c.timer = setInterval(tick, 500);
      tick();
      await vad.start();
      const greet = (c.bot.memory && c.bot.memory.length) ? `Hey, it's ${c.bot.name} again. What's on your mind?` : `Hey, it's ${c.bot.name}. What can I do for you?`;
      c.lastBotText = greet;
      log('bot', greet);
      await say(greet, c.token);
    } catch (e) {
      stopRing();
      if (c !== me) return;
      const msg = /Permission|NotAllowed|denied/i.test(e.message) ? 'Crew needs your microphone for calls. Allow it in Windows Settings, Privacy, Microphone.' : e.message;
      setStatus('thinking', 'Call failed');
      caption(msg);
      window.crewToast(msg, 'error');
    }
  }

  async function toggleMute() {
    if (!c) return;
    c.muted = !c.muted;
    const btn = $('[data-c="mute"]', el());
    btn.classList.toggle('on', c.muted);
    btn.innerHTML = c.muted ? ICON.micOff : ICON.mic;
    btn.nextElementSibling.textContent = c.muted ? 'Unmute' : 'Mute';
    if (c.vad) { if (c.muted) await c.vad.pause(); else await c.vad.start(); }
    if (!c.playing) setStatus('listening', c.muted ? 'Muted' : 'Listening');
  }

  function onKey(e) {
    if (e.key === 'Escape') end();
    if (e.key.toLowerCase() === 'm' && !e.ctrlKey && !e.metaKey) toggleMute();
  }

  async function end() {
    if (!c || c.ending) return;
    const call = c;
    call.ending = true;
    if (call.pending) api.voiceCancel(call.bot.id);
    if (call.stopRing) call.stopRing(); // hung up while it was still ringing
    interrupt();
    document.removeEventListener('keydown', onKey);
    clearInterval(call.timer);
    cancelAnimationFrame(call.raf);
    try { if (call.vad) await call.vad.destroy(); } catch {}
    try { await call.ctx.close(); } catch {}
    c = null;
    el().classList.add('hidden');
    el().innerHTML = '';
    if (call.connectedAt) {
      await api.saveCall(call.bot.id, Date.now() - call.connectedAt, call.turns);
      window.CrewUI.refreshThread();
    }
  }

  window.CrewCall = { start, end, onEvent, active: () => !!c };
})();
