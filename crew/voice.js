// Voice for calls, all free, no account and no card.
//
// Hearing: Whisper (base.en, quantized) runs on this PC through
// transformers.js. The call screen only sends finished utterances (Silero VAD
// in the renderer decides when someone stopped talking), as 16 kHz mono PCM.
//
// Speaking, three engines:
//  - Deepgram Aura-2: very natural voices with the user's own API key
//    ($0.030 per 1,000 characters; Flux sounds a touch better but costs half
//    again as much). Each bot can have its own voice.
//  - Edge: Microsoft's neural voices through the free Edge read-aloud
//    service. Good quality, needs internet, no key.
//  - Kokoro: Kokoro-82M on this PC. Works offline after a one-time download.
// A voice that cannot be reached falls back down the list on its own.
const path = require('path');

let cacheDir = null;
let T = null; // @huggingface/transformers (CommonJS build)
let asr = null; let asrLoading = null;
let kokoro = null; let kokoroLoading = null;
const edgeByVoice = new Map();

const EDGE_VOICES = [
  { id: 'en-US-AvaMultilingualNeural', label: 'Ava (warm)' },
  { id: 'en-US-AndrewMultilingualNeural', label: 'Andrew (calm)' },
  { id: 'en-US-EmmaMultilingualNeural', label: 'Emma (bright)' },
  { id: 'en-US-BrianMultilingualNeural', label: 'Brian (easygoing)' },
  { id: 'en-US-JennyNeural', label: 'Jenny (friendly)' },
  { id: 'en-US-ChristopherNeural', label: 'Christopher (deep)' },
  { id: 'en-US-AnaNeural', label: 'Ana (young)' },
  { id: 'en-GB-SoniaNeural', label: 'Sonia (British)' },
  { id: 'en-GB-RyanNeural', label: 'Ryan (British)' },
];
const KOKORO_VOICES = [
  { id: 'af_heart', label: 'Heart' }, { id: 'af_bella', label: 'Bella' }, { id: 'af_nicole', label: 'Nicole' },
  { id: 'am_michael', label: 'Michael' }, { id: 'am_fenrir', label: 'Fenrir' }, { id: 'bf_emma', label: 'Emma (British)' },
  { id: 'bm_george', label: 'George (British)' },
];

// Deepgram Aura-2 English voices (developers.deepgram.com/docs/tts-models).
const aura = (name, desc) => ({ id: `aura-2-${name}-en`, label: `${name[0].toUpperCase()}${name.slice(1)} (${desc})` });
const DEEPGRAM_VOICES = [
  aura('thalia', 'clear, energetic'), aura('asteria', 'confident, knowledgeable'), aura('athena', 'calm, professional'),
  aura('luna', 'friendly, natural'), aura('helena', 'caring, a bit raspy'), aura('aurora', 'cheerful, expressive'),
  aura('andromeda', 'casual, expressive'), aura('callista', 'clear, smooth'), aura('cora', 'smooth, melodic'),
  aura('cordelia', 'warm, polite'), aura('delia', 'casual, breathy'), aura('electra', 'professional, engaging'),
  aura('harmonia', 'empathetic, calm'), aura('hera', 'smooth, warm'), aura('iris', 'cheerful, positive'),
  aura('janus', 'Southern, smooth'), aura('juno', 'melodic, breathy'), aura('minerva', 'positive, friendly'),
  aura('ophelia', 'enthusiastic, cheerful'), aura('phoebe', 'energetic, casual'), aura('selene', 'expressive, energetic'),
  aura('vesta', 'patient, empathetic'), aura('pandora', 'British, melodic'), aura('theia', 'Australian, sincere'),
  aura('amalthea', 'Filipino, cheerful'),
  aura('apollo', 'confident, casual'), aura('arcas', 'smooth, clear'), aura('aries', 'warm, energetic'),
  aura('atlas', 'enthusiastic, friendly'), aura('hermes', 'expressive, professional'), aura('jupiter', 'knowledgeable, baritone'),
  aura('mars', 'patient, baritone'), aura('neptune', 'patient, polite'), aura('odysseus', 'calm, professional'),
  aura('orion', 'calm, approachable'), aura('orpheus', 'clear, trustworthy'), aura('pluto', 'calm, baritone'),
  aura('saturn', 'confident, baritone'), aura('zeus', 'deep, smooth'), aura('draco', 'British, baritone'),
  aura('hyperion', 'Australian, warm'),
  // Flux TTS (developers.deepgram.com/docs/flux-tts/voices): newer and more natural, on /v2/speak.
  { id: 'flux-sienna-en', label: 'Sienna (Flux, calm, warm)' },
];

/** Which engine a voice id belongs to. */
function engineOf(id) {
  id = String(id || '');
  if (id.startsWith('aura-') || id.startsWith('flux-')) return 'deepgram';
  if (EDGE_VOICES.some((v) => v.id === id)) return 'edge';
  if (KOKORO_VOICES.some((v) => v.id === id)) return 'kokoro';
  return '';
}

function init(o) { cacheDir = o.cacheDir; }

function transformers() {
  if (!T) {
    T = require('@huggingface/transformers');
    T.env.cacheDir = cacheDir;
    T.env.allowLocalModels = false;
  }
  return T;
}

/** A stable default voice per bot, so each one sounds like itself. */
function defaultVoice(list, botId) {
  let h = 0;
  for (const ch of String(botId || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return list[h % list.length].id;
}

function voiceList() {
  return { deepgram: DEEPGRAM_VOICES, edge: EDGE_VOICES, kokoro: KOKORO_VOICES };
}

// ─── Deepgram ───────────────────────────────────────────────────────────────
async function deepgramFetch(url, key, init, ms = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { ...init, headers: { Authorization: `Token ${key}`, ...(init.headers || {}) }, signal: ctl.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      let msg = body.slice(0, 200);
      try { const j = JSON.parse(body); msg = j.err_msg || j.message || j.reason || msg; } catch {}
      const e = new Error(res.status === 401 || res.status === 403 ? 'Deepgram did not accept the API key.' : `Deepgram said ${res.status}: ${msg}`);
      e.status = res.status;
      throw e;
    }
    return res;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Deepgram timed out.');
    throw e;
  } finally { clearTimeout(t); }
}

/** One sentence as mp3 from an Aura-2 voice. */
async function deepgramSpeak(text, model, key) {
  const url = `https://api.deepgram.com/${String(model).startsWith('flux-') ? 'v2' : 'v1'}/speak?model=${encodeURIComponent(model)}&encoding=mp3`;
  const res = await deepgramFetch(url, key, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('Deepgram sent no audio.');
  return buf;
}

/** The same voices through Codeply's server (tts-proxy), billed to Codeply, for signed-in users. */
const TTS_PROXY = 'https://zswkhfkfseclgadhvobg.supabase.co/functions/v1/tts-proxy';
async function serverSpeak(text, model, token) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const res = await fetch(TTS_PROXY, {
      method: 'POST', signal: ctl.signal,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice: model }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      const e = new Error(j.error || `Codeply voices said ${res.status}`);
      e.status = res.status;
      throw e;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error('Codeply voices sent no audio.');
    return buf;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Codeply voices timed out.');
    throw e;
  } finally { clearTimeout(t); }
}

/** Is this key good? One tiny request (a couple of characters of speech). */
async function deepgramCheck(key) {
  await deepgramSpeak('Hi.', 'aura-2-thalia-en', key);
  return true;
}

// ─── Hearing ────────────────────────────────────────────────────────────────

function loadAsr() {
  if (asr) return Promise.resolve(asr);
  if (!asrLoading) {
    asrLoading = transformers().pipeline('automatic-speech-recognition', 'onnx-community/whisper-base.en', { dtype: 'q8', device: 'cpu' })
      .then((p) => { asr = p; return p; })
      .catch((e) => { asrLoading = null; throw e; });
  }
  return asrLoading;
}

/** Text from one utterance (Float32Array or plain array, 16 kHz mono). */
async function transcribe(pcm) {
  const audio = pcm instanceof Float32Array ? pcm : Float32Array.from(Object.values(pcm || {}));
  if (audio.length < 16000 * 0.25) return '';
  const p = await loadAsr();
  const r = await p(audio);
  const text = String((r && r.text) || '').trim();
  // Whisper's usual guesses for silence or noise.
  if (/^[\s.,!?-]*$/.test(text) || /^\(?\[?(blank_audio|music|silence|inaudible|noise)\]?\)?\.?$/i.test(text)) return '';
  return text;
}

// ─── Speaking ───────────────────────────────────────────────────────────────

async function edgeSpeak(text, voiceId) {
  const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
  let tts = edgeByVoice.get(voiceId);
  if (!tts) {
    tts = new MsEdgeTTS();
    await tts.setMetadata(voiceId, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    edgeByVoice.set(voiceId, tts);
  }
  try {
    return await new Promise((resolve, reject) => {
      const { audioStream } = tts.toStream(text);
      const chunks = [];
      const timer = setTimeout(() => reject(new Error('Edge voice timed out')), 15000);
      audioStream.on('data', (c) => chunks.push(c));
      audioStream.on('close', () => { clearTimeout(timer); const b = Buffer.concat(chunks); b.length ? resolve(b) : reject(new Error('Edge voice sent no audio')); });
      audioStream.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
  } catch (e) {
    edgeByVoice.delete(voiceId); // a dropped socket: start fresh next time
    try { tts.close(); } catch {}
    throw e;
  }
}

function loadKokoro() {
  if (kokoro) return Promise.resolve(kokoro);
  if (!kokoroLoading) {
    transformers();
    const { KokoroTTS } = require('kokoro-js');
    kokoroLoading = KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8', device: 'cpu' })
      .then((k) => { kokoro = k; return k; })
      .catch((e) => { kokoroLoading = null; throw e; });
  }
  return kokoroLoading;
}

function wav(samples, rate) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(Math.max(-1, Math.min(1, samples[i])) * 0x7fff | 0, 44 + i * 2);
  return buf;
}

async function kokoroSpeak(text, voiceId) {
  const k = await loadKokoro();
  const audio = await k.generate(text, { voice: voiceId });
  return wav(audio.audio, audio.sampling_rate);
}

/**
 * Audio for one sentence: { mime, data: Buffer }. The bot's own voice decides
 * the engine; with no voice picked, the default engine picks a stable one.
 */
async function speak(text, { engine, voice, botId, deepgramKey, serverToken } = {}) {
  text = String(text || '').trim().slice(0, 600);
  if (!text) throw new Error('Nothing to say.');
  const picked = engineOf(voice);
  let use = picked || engine;
  // Deepgram with the user's own key, else through Codeply's server when signed in.
  const token = !deepgramKey && use === 'deepgram' && serverToken ? await serverToken().catch(() => '') : '';
  if (use === 'deepgram' && !deepgramKey && !token) use = 'edge';
  if (use === 'deepgram') {
    const id = picked === 'deepgram' ? voice : defaultVoice(DEEPGRAM_VOICES, botId);
    try {
      const data = deepgramKey ? await deepgramSpeak(text, id, deepgramKey) : await serverSpeak(text, id, token);
      return { mime: 'audio/mpeg', data };
    } catch (e) {
      if (deepgramKey && (e.status === 401 || e.status === 403)) throw e; // a bad key should be seen, not hidden
      console.warn('[voice] Deepgram failed, using Edge:', e.message);
    }
  }
  if (use !== 'kokoro') {
    const id = EDGE_VOICES.some((v) => v.id === voice) ? voice : defaultVoice(EDGE_VOICES, botId);
    try { return { mime: 'audio/mpeg', data: await edgeSpeak(text, id) }; } catch (e) {
      console.warn('[voice] Edge failed, using Kokoro:', e.message);
    }
  }
  const id = KOKORO_VOICES.some((v) => v.id === voice) ? voice : defaultVoice(KOKORO_VOICES, botId);
  return { mime: 'audio/wav', data: await kokoroSpeak(text, id) };
}

/**
 * Before a call connects: load Whisper (and Kokoro when it is the engine) and
 * run each once, so the first real sentence is not the slow one.
 */
async function prepare(engine) {
  const started = Date.now();
  const p = await loadAsr();
  await p(new Float32Array(16000 * 0.5));
  if (engine === 'kokoro') { const k = await loadKokoro(); await k.generate('Hi.', { voice: 'af_heart' }); }
  return { ok: true, ms: Date.now() - started };
}

module.exports = { init, prepare, transcribe, speak, voiceList, engineOf, deepgramCheck };
