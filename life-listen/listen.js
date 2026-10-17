// The background listener's hidden window (main process: life-listen.js).
//
// The mic goes through a small voice detector at 16 kHz; every utterance (a
// pause ends it, 12 s at most) goes to Whisper in the main process. Nothing is
// recorded or kept here. If the mic goes away (unplugged, taken), it tries
// again every 30 seconds.
(() => {
  const api = window.lifelisten;
  const hearing = { ctx: null, stream: null, nodes: [] };

  function segmenter(stream) {
    const ctx = hearing.ctx;
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    let floor = 0.004; let speaking = false; let silent = 0; let buf = []; let pre = null;
    proc.onaudioprocess = (e) => {
      const x = e.inputBuffer.getChannelData(0);
      let sum = 0; for (let i = 0; i < x.length; i++) sum += x[i] * x[i];
      const rms = Math.sqrt(sum / x.length);
      // A room is noisier than a headset: a slightly higher bar than the call helper's.
      const loud = rms > Math.max(0.015, floor * 3.5);
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
      if (n >= 16000 * 0.8) {
        const pcm = new Float32Array(n); let o = 0;
        for (const b of buf) { pcm.set(b, o); o += b.length; }
        api.chunk(pcm);
      }
      buf = [];
    }
    const mute = ctx.createGain(); mute.gain.value = 0;
    src.connect(proc); proc.connect(mute); mute.connect(ctx.destination);
    hearing.nodes.push(src, proc, mute);
  }

  async function start() {
    if (hearing.ctx) return;
    try {
      hearing.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      hearing.ctx = new AudioContext({ sampleRate: 16000 });
      segmenter(hearing.stream);
      hearing.stream.getAudioTracks().forEach((t) => t.addEventListener('ended', restart));
      api.status({ on: true });
    } catch (e) {
      stop();
      api.status({ on: false, error: /denied|permission/i.test(e.message) ? 'The mic is blocked in Windows settings.' : 'No mic found.' });
      setTimeout(start, 30000);
    }
  }
  function stop() {
    for (const n of hearing.nodes) { try { n.disconnect(); } catch {} }
    if (hearing.stream) hearing.stream.getTracks().forEach((t) => t.stop());
    if (hearing.ctx) hearing.ctx.close().catch(() => {});
    Object.assign(hearing, { ctx: null, stream: null, nodes: [] });
  }
  function restart() { stop(); api.status({ on: false, error: 'The mic went away.' }); setTimeout(start, 30000); }

  navigator.mediaDevices.addEventListener('devicechange', () => { if (!hearing.ctx) start(); });
  start();
})();
