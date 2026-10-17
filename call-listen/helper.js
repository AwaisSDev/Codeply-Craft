// The call helper window: the offer, the live transcript, cards, the whispered
// suggestion and the hand-over (main process: call-listen.js).
//
// Hearing: the user's mic ("me") and the PC's sound ("them", Windows system
// audio through getDisplayMedia loopback) each go through a small voice
// detector at 16 kHz; every utterance (a pause ends it, 12 s at most) goes to
// Whisper in the main process. Nothing is recorded or kept here.
// Speaking into the call: with VB-CABLE installed and picked as the call app's
// microphone, the user's own mic is routed through "CABLE Input" (when they
// turn that on) and the bot's voice joins it only while it has the call.
(() => {
  const api = window.callhelp;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let st = null;
  let consentDraft = false;

  // ─── Drawing ──────────────────────────────────────────────────────────────

  function paint() {
    if (!st) return;
    const bot = st.bot ? st.bot.name : 'Your bot';
    $('title').textContent = st.active ? `${st.app || 'Call'} call` : 'Call helper';
    $('dot').classList.toggle('on', !!st.active);
    const m = $('main');
    if (!st.active && st.offered) {
      m.innerHTML = `<div class="card"><b>${esc(st.app || 'A')} call</b><div>Want ${esc(bot)} to listen and help? It writes the call down on this PC, shows you what is relevant and can take over if you need to go.</div></div>
        ${st.consentAck ? '' : `<label class="check"><input type="checkbox" id="consent" ${consentDraft ? 'checked' : ''}><span>I will tell the other person an assistant is listening. Many places need everyone's consent before a call is recorded or transcribed.</span></label>`}
        <div class="row"><button class="btn primary" id="listen" ${st.consentAck || consentDraft ? '' : 'disabled'}>Listen</button><button class="btn" id="dismiss">Not this call</button></div>`;
      const c = $('consent');
      if (c) c.addEventListener('change', () => { consentDraft = c.checked; $('listen').disabled = !c.checked; });
      $('listen').addEventListener('click', async () => { if (!st.consentAck) await api.consent(true); st = await api.start(); paint(); });
      $('dismiss').addEventListener('click', () => api.dismiss());
      return;
    }
    if (!st.active) {
      m.innerHTML = `<div class="dim">${st.takeover && st.takeover.stage === 'done' ? 'Call ended. The summary is in Crew, Life.' : 'Not on a call.'}</div>`;
      return;
    }
    const t = st.takeover;
    let take = '';
    if (t && t.stage === 'offer') {
      take = `<div class="card take"><b>${esc(t.why || '')} Take the call?</b><div class="dim small">${esc(bot)} says it is your assistant, gives your excuse and says goodbye. ${st.endKeys ? 'Then it hangs up.' : 'Then you hang up.'}</div>
        <div class="row" style="margin-top:8px"><button class="btn primary" id="take">${esc(bot)}, take it</button><button class="btn" id="notnow">Not now</button></div></div>`;
    } else if (t && t.stage === 'speaking') {
      take = `<div class="card take"><b>${esc(bot)} has the call</b><div>${esc(t.text || 'Thinking of what to say...')}</div>${cable ? '' : '<div class="dim small">The other side only hears this with VB-CABLE set as your call app\'s microphone. Otherwise read it out, or hang up.</div>'}</div>`;
    } else if (t && t.stage === 'done') {
      take = `<div class="card take"><b>${t.hungUp ? 'Hung up.' : 'Hang up now.'}</b></div>`;
    }
    const lines = st.turns.slice(-12).map((x) => `<div class="line ${x.who}"><b>${x.who === 'me' ? 'You' : x.who === 'bot' ? esc(bot) : 'Them'}</b>${esc(x.text)}</div>`).join('');
    m.innerHTML = `${take}
      ${st.whisper ? `<div class="card whisper"><div class="label">Whisper</div><div>${esc(st.whisper)}</div></div>` : ''}
      ${st.cards.map((c) => `<div class="card"><b>${esc(c.title)}</b><div class="dim">${esc(c.text)}</div></div>`).join('')}
      <div class="sub">Live transcript</div>
      <div class="lines">${lines || `<div class="dim small">Listening. ${hearing.sys ? '' : 'Only your mic for now: allow system audio to hear the other side.'}</div>`}</div>
      <div class="row" style="margin-top:auto"><button class="btn" id="handover">Hand over</button><button class="btn danger" id="stop">Stop listening</button></div>
      <label class="check"><input type="checkbox" id="wv" ${st.whisperVoice ? 'checked' : ''}><span>Say the whispers in my headphones</span></label>
      ${cable ? `<label class="check"><input type="checkbox" id="route" ${st.routeMic ? 'checked' : ''}><span>Route my mic through CABLE Input (pick "CABLE Output" as the mic in your call app)</span></label>` : ''}`;
    const on = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
    on('take', () => api.takeover());
    on('notnow', () => api.notNow());
    on('handover', () => api.handover());
    on('stop', () => api.stop());
    const wv = $('wv'); if (wv) wv.addEventListener('change', () => api.settings({ whisperVoice: wv.checked }));
    const rt = $('route'); if (rt) rt.addEventListener('change', async () => { st = await api.settings({ routeMic: rt.checked }); routeMic(); });
  }

  setInterval(() => {
    if (st && st.active && st.startedAt) { const s = Math.floor((Date.now() - st.startedAt) / 1000); $('timer').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
    else $('timer').textContent = '';
  }, 1000);
  $('close').addEventListener('click', () => api.close());

  // ─── Hearing ──────────────────────────────────────────────────────────────

  const hearing = { ctx: null, streams: [], nodes: [], sys: false };
  function segmenter(stream, who) {
    const ctx = hearing.ctx;
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    let floor = 0.004; let speaking = false; let silent = 0; let buf = []; let pre = null;
    proc.onaudioprocess = (e) => {
      const x = e.inputBuffer.getChannelData(0);
      let sum = 0; for (let i = 0; i < x.length; i++) sum += x[i] * x[i];
      const rms = Math.sqrt(sum / x.length);
      const loud = rms > Math.max(0.012, floor * 3);
      if (!loud) floor = floor * 0.95 + rms * 0.05;
      const frame = new Float32Array(x);
      if (loud) {
        if (!speaking) { speaking = true; buf = pre ? [pre] : []; }
        buf.push(frame); silent = 0;
      } else if (speaking) {
        buf.push(frame);
        if (++silent >= 3) flush();
      }
      if (speaking && buf.length * 4096 >= 16000 * 12) flush();
      pre = frame;
    };
    function flush() {
      speaking = false; silent = 0;
      const n = buf.reduce((a, b) => a + b.length, 0);
      if (n >= 16000 * 0.6) {
        const pcm = new Float32Array(n); let o = 0;
        for (const b of buf) { pcm.set(b, o); o += b.length; }
        api.chunk(who, pcm);
      }
      buf = [];
    }
    const mute = ctx.createGain(); mute.gain.value = 0;
    src.connect(proc); proc.connect(mute); mute.connect(ctx.destination);
    hearing.nodes.push(src, proc, mute);
  }

  async function startHearing() {
    if (hearing.ctx) return;
    hearing.ctx = new AudioContext({ sampleRate: 16000 });
    try {
      const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      hearing.streams.push(mic); segmenter(mic, 'me');
      await findCable(); // device names only show once the mic is allowed
    } catch (e) { console.warn('mic:', e.message); }
    try {
      const sys = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
      sys.getVideoTracks().forEach((t) => t.stop());
      if (sys.getAudioTracks().length) { hearing.streams.push(sys); segmenter(new MediaStream(sys.getAudioTracks()), 'them'); hearing.sys = true; }
    } catch (e) { console.warn('system audio:', e.message); }
    routeMic();
    paint();
  }
  function stopHearing() {
    for (const n of hearing.nodes) { try { n.disconnect(); } catch {} }
    for (const s of hearing.streams) s.getTracks().forEach((t) => t.stop());
    if (hearing.ctx) hearing.ctx.close().catch(() => {});
    Object.assign(hearing, { ctx: null, streams: [], nodes: [], sys: false });
    stopRoute();
  }

  // ─── Speaking (headphones, or into the call through VB-CABLE) ─────────────

  let cable = null; // the "CABLE Input" output device id, when installed
  async function findCable() {
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      const d = list.find((x) => x.kind === 'audiooutput' && /cable input/i.test(x.label));
      cable = d ? d.deviceId : null;
    } catch { cable = null; }
    api.devices({ cable: !!cable });
  }
  const route = { ctx: null, gain: null, dest: null, el: null, mic: null };
  async function routeMic() {
    if (!cable || !st || !st.routeMic || !st.active) { stopRoute(); return; }
    if (route.ctx) return;
    try {
      route.ctx = new AudioContext();
      route.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      route.dest = route.ctx.createMediaStreamDestination();
      route.gain = route.ctx.createGain();
      route.ctx.createMediaStreamSource(route.mic).connect(route.gain).connect(route.dest);
      route.el = new Audio(); route.el.srcObject = route.dest.stream;
      await route.el.setSinkId(cable); await route.el.play();
    } catch (e) { console.warn('route:', e.message); stopRoute(); }
  }
  function stopRoute() {
    try { if (route.el) route.el.pause(); if (route.mic) route.mic.getTracks().forEach((t) => t.stop()); if (route.ctx) route.ctx.close(); } catch {}
    Object.assign(route, { ctx: null, gain: null, dest: null, el: null, mic: null });
  }

  api.onAudio(async (a) => {
    if (a.error || !a.data) { if (a.where === 'call') api.endCall(); return; }
    const blob = new Blob([a.data instanceof Uint8Array ? a.data : new Uint8Array(a.data)], { type: a.mime });
    const url = URL.createObjectURL(blob);
    const el = new Audio(url);
    if (a.where === 'call' && cable) {
      // The bot has the call: the user's routed mic goes quiet while it speaks.
      if (route.gain) route.gain.gain.value = 0;
      try { await el.setSinkId(cable); } catch {}
    }
    el.onended = () => {
      URL.revokeObjectURL(url);
      if (a.where === 'call') { if (route.gain) route.gain.gain.value = 1; api.endCall(); }
    };
    el.play().catch(() => { if (a.where === 'call') api.endCall(); });
  });

  // ─── State ────────────────────────────────────────────────────────────────

  api.onState((s) => { const was = st && st.active; st = s; paint(); if (st.active && !was) startHearing(); });
  api.onListen((on) => { if (on) startHearing(); else stopHearing(); });
  navigator.mediaDevices.addEventListener('devicechange', findCable);
  findCable();
  api.state().then((s) => { st = s; paint(); if (st.active) startHearing(); });
})();
