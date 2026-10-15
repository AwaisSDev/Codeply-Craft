// Speech to text for voice mode, in its own process (Electron utilityProcess),
// so the app and the person's cursor never wait while Whisper works. It uses a
// few CPU cores, not all of them, for the same reason.
//
// In:  { type: 'load' } | { type: 'transcribe', id, pcm: Float32Array (16 kHz mono) }
// Out: { type: 'ready', ms } | { type: 'result', id, text, ms } | { type: 'error', id?, error }
const os = require('os');

const MODEL = 'onnx-community/whisper-base.en';
const THREADS = Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2)));
const cacheDir = process.argv[2];

let asr = null;
let loading = null;

function load() {
  if (asr) return Promise.resolve(asr);
  if (!loading) {
    loading = (async () => {
      const t0 = Date.now();
      const T = require('@huggingface/transformers');
      if (cacheDir) T.env.cacheDir = cacheDir;
      T.env.allowLocalModels = false;
      const p = await T.pipeline('automatic-speech-recognition', MODEL, {
        dtype: 'q8', device: 'cpu', session_options: { intraOpNumThreads: THREADS, interOpNumThreads: 1 },
      });
      await p(new Float32Array(8000)); // first run is the slow one: do it now
      asr = p;
      process.parentPort.postMessage({ type: 'ready', ms: Date.now() - t0 });
      return p;
    })().catch((e) => { loading = null; throw e; });
  }
  return loading;
}

// Whisper's usual guesses for silence or noise.
function clean(text) {
  const t = String(text || '').replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, ' ').replace(/\s+/g, ' ').trim();
  return /^[\s.,!?-]*$/.test(t) ? '' : t;
}

let queue = Promise.resolve();
process.parentPort.on('message', (e) => {
  const m = e.data || {};
  if (m.type === 'load') {
    load().catch((err) => process.parentPort.postMessage({ type: 'error', error: String(err && err.message || err) }));
  } else if (m.type === 'transcribe') {
    queue = queue.then(async () => {
      try {
        const p = await load();
        const t0 = Date.now();
        const audio = m.pcm instanceof Float32Array ? m.pcm : Float32Array.from(Object.values(m.pcm || {}));
        const out = await p(audio);
        process.parentPort.postMessage({ type: 'result', id: m.id, text: clean(out && out.text), ms: Date.now() - t0 });
      } catch (err) {
        process.parentPort.postMessage({ type: 'error', id: m.id, error: String(err && err.message || err) });
      }
    });
  }
});
