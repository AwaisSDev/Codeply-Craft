// Speech to text ON the phone for calls (phone-calls.js), in a worker so the
// call screen and the audio never stall while the model thinks.
//
// Model: Moonshine tiny (English), 8-bit, through transformers.js. About
// 28 MB, downloaded once from Hugging Face; the browser keeps it in its cache
// after that. Moonshine's work grows with the clip, so a short reply is
// transcribed far faster than with Whisper, which always pads to 30 seconds.
// Whisper tiny is the fallback if Moonshine will not load. Nothing you say
// leaves the phone for speech to text.
//
// Messages in:  { type: 'load', model? } | { type: 'transcribe', id, audio: Float32Array (16 kHz mono) }
// Messages out: { type: 'progress', loaded, total } | { type: 'ready', device, model }
//               { type: 'result', id, text, ms } | { type: 'error', id?, error }
const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js';
const MODELS = [
  { id: 'onnx-community/moonshine-tiny-ONNX', opts: {} },
  { id: 'onnx-community/whisper-tiny.en', opts: { chunk_length_s: 30 } },
];

let asr = null;
let model = null;
let loading = null;

function load(only) {
  if (asr) return Promise.resolve(asr);
  if (loading) return loading;
  loading = (async () => {
    const { pipeline, env } = await import(TRANSFORMERS_URL);
    env.allowLocalModels = false;
    env.useBrowserCache = true;
    const files = {};
    const progress_callback = (p) => {
      if (!p || p.status !== 'progress' || !p.file) return;
      files[p.file] = { loaded: p.loaded || 0, total: p.total || 0 };
      let loaded = 0; let total = 0;
      for (const f of Object.values(files)) { loaded += f.loaded; total += f.total; }
      postMessage({ type: 'progress', loaded, total });
    };
    // WebAssembly, not WebGPU: these 8-bit graphs are mostly int8 ops that
    // WebGPU runs back on the CPU (in testing Whisper's first run on WebGPU
    // never finished), and the WebGPU-friendly files are 2 to 3 times bigger.
    // A short warm-up proves the model really runs before we say "ready".
    const device = 'wasm';
    let lastErr = null;
    for (const m of MODELS.filter((x) => !only || x.id === only)) {
      try {
        const p = await pipeline('automatic-speech-recognition', m.id, { dtype: 'q8', device, progress_callback });
        await p(new Float32Array(16000), m.opts);
        asr = p; model = m;
        postMessage({ type: 'ready', device, model: m.id });
        return p;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('Speech model did not load.');
  })().catch((e) => { loading = null; throw e; });
  return loading;
}

// Models make up words for noise: drop tags like [BLANK_AUDIO] or (music).
function clean(text) {
  const t = String(text || '').replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, ' ').replace(/\s+/g, ' ').trim();
  return /^[\s.,!?-]*$/.test(t) ? '' : t;
}

// One transcription at a time; the phone has one set of ears.
let queue = Promise.resolve();
self.onmessage = (e) => {
  const m = e.data || {};
  if (m.type === 'load') {
    load(m.model).catch((err) => postMessage({ type: 'error', error: String((err && err.message) || err) }));
  } else if (m.type === 'transcribe') {
    queue = queue.then(async () => {
      try {
        const p = await load();
        const t0 = performance.now();
        const out = await p(m.audio, model.opts);
        postMessage({ type: 'result', id: m.id, text: clean(out && out.text), ms: Math.round(performance.now() - t0) });
      } catch (err) {
        postMessage({ type: 'error', id: m.id, error: String((err && err.message) || err) });
      }
    });
  }
};
