// Speech to text ON the phone for calls (phone-calls.js), in a worker so the
// call screen and the audio never stall while Whisper thinks.
//
// Model: Whisper tiny (English), 8-bit, through transformers.js. About 40 MB,
// downloaded once from Hugging Face; the browser keeps it in its cache after
// that. Nothing you say leaves the phone for speech to text.
//
// Messages in:  { type: 'load' } | { type: 'transcribe', id, audio: Float32Array (16 kHz mono) }
// Messages out: { type: 'progress', loaded, total } | { type: 'ready', device }
//               { type: 'result', id, text } | { type: 'error', id?, error }
const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js';
const MODEL = 'onnx-community/whisper-tiny.en';

let asr = null;
let loading = null;

function load() {
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
    // WebAssembly, not WebGPU: the 8-bit Whisper graph is mostly int8 ops
    // that WebGPU runs back on the CPU, and in testing its first run never
    // finished. The WebGPU-friendly files (fp32/fp16) are 2 to 3 times bigger.
    // A short warm-up proves the model really runs before we say "ready".
    const device = 'wasm';
    const p = await pipeline('automatic-speech-recognition', MODEL, { dtype: 'q8', device, progress_callback });
    await p(new Float32Array(8000));
    asr = p;
    postMessage({ type: 'ready', device });
    return p;
  })().catch((e) => { loading = null; throw e; });
  return loading;
}

// Whisper makes up words for noise: drop tags like [BLANK_AUDIO] or (music).
function clean(text) {
  const t = String(text || '').replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, ' ').replace(/\s+/g, ' ').trim();
  return /^[\s.,!?-]*$/.test(t) ? '' : t;
}

// One transcription at a time; the phone has one set of ears.
let queue = Promise.resolve();
self.onmessage = (e) => {
  const m = e.data || {};
  if (m.type === 'load') {
    load().catch((err) => postMessage({ type: 'error', error: String((err && err.message) || err) }));
  } else if (m.type === 'transcribe') {
    queue = queue.then(async () => {
      try {
        const p = await load();
        const out = await p(m.audio, { chunk_length_s: 30 });
        postMessage({ type: 'result', id: m.id, text: clean(out && out.text) });
      } catch (err) {
        postMessage({ type: 'error', id: m.id, error: String((err && err.message) || err) });
      }
    });
  }
};
