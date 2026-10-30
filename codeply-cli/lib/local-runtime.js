/**
 * The local runtime: Codeply's own llama.cpp server for context intelligence,
 * started when there is work and stopped when there is none.
 *
 * Phase 1 runs upstream llama.cpp `llama-server` (MIT) as a child process,
 * pinned to a commit (docs/local-intelligence/RUNTIME.md): a crash cannot take
 * the app down, there is no native module to rebuild for Electron, and the
 * same binary is what the Codeply Runtime fork will replace.
 *
 *   hardware()        cores, RAM, SIMD flags (AVX2, AVX-512, NEON)
 *   findBinary()      CODEPLY_LLAMA_SERVER, ~/.codeply/runtime/bin, PATH
 *   models()          ~/.codeply/models/manifest.json (what fetch-model wrote)
 *   createRuntime()   ensure() → { baseUrl, apiKey, model }: starts the server
 *                     on 127.0.0.1, a free port, a random key (in a 0600 file,
 *                     never on the command line), low priority, and waits for
 *                     /health; stops after idleMs with nothing to do.
 *
 * The context-model.js "local" backend takes ensure() and canStart(), so the
 * engine never knows whether the model came from here, Ollama or LM Studio.
 */
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn: realSpawn } = require('child_process');

const RUNTIME_DIR = () => process.env.CODEPLY_RUNTIME_DIR || path.join(os.homedir(), '.codeply', 'runtime');
const MODELS_DIR = () => process.env.CODEPLY_MODELS_DIR || path.join(os.homedir(), '.codeply', 'models');
const EXE = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';

/**
 * The models Codeply has evaluated (docs/local-intelligence/MODEL-SELECTION.md).
 * extra: per-model request settings the local backend sends.
 */
const CATALOG = {
  'qwen3-1.7b-q4': { repo: 'unsloth/Qwen3-1.7B-GGUF', file: 'Qwen3-1.7B-Q4_K_M.gguf', license: 'Apache-2.0', params: '1.7B', arch: 'dense transformer', ctx: 8192, extra: { chat_template_kwargs: { enable_thinking: false } } },
  'qwen3-0.6b-q4': { repo: 'unsloth/Qwen3-0.6B-GGUF', file: 'Qwen3-0.6B-Q4_K_M.gguf', license: 'Apache-2.0', params: '0.6B', arch: 'dense transformer', ctx: 8192, extra: { chat_template_kwargs: { enable_thinking: false } } },
  'llama3.2-1b-q4': { repo: 'bartowski/Llama-3.2-1B-Instruct-GGUF', file: 'Llama-3.2-1B-Instruct-Q4_K_M.gguf', license: 'Llama 3.2 Community License', params: '1.2B', arch: 'dense transformer', ctx: 8192 },
  'gemma3-1b-q4': { repo: 'ggml-org/gemma-3-1b-it-GGUF', file: 'gemma-3-1b-it-Q4_K_M.gguf', license: 'Gemma Terms of Use', params: '1.0B', arch: 'dense transformer', ctx: 8192 },
  'qwen2.5-1.5b-q4': { repo: 'Qwen/Qwen2.5-1.5B-Instruct-GGUF', file: 'qwen2.5-1.5b-instruct-q4_k_m.gguf', license: 'Apache-2.0', params: '1.5B', arch: 'dense transformer', ctx: 8192 },
  'qwen3.5-0.8b-q4': { repo: 'unsloth/Qwen3.5-0.8B-GGUF', file: 'Qwen3.5-0.8B-Q4_K_M.gguf', license: 'Apache-2.0', params: '0.8B', arch: 'hybrid (linear + full attention)', ctx: 8192, extra: { chat_template_kwargs: { enable_thinking: false } } },
  // The conv state is checkpointed one micro-batch before the end of the prompt: with the default
  // 512, only ~370 of ~880 tokens are reused; 128 reuses the whole system prompt (BENCHMARKS.md).
  'lfm2.5-1.2b-q4': { repo: 'LiquidAI/LFM2.5-1.2B-Instruct-GGUF', file: 'LFM2.5-1.2B-Instruct-Q4_K_M.gguf', license: 'LFM Open License v1.0', params: '1.2B', arch: 'hybrid (conv + attention)', ctx: 8192, serverArgs: ['-ub', '128'] },
  // LFM3 (2026-10-23): conv + sliding-window + global attention, 256K context, built for local agents.
  // Its chat template thinks by default (hundreds of tokens before the JSON): turned off like Qwen3.
  // --swa-full keeps the sliding-window cache whole, so the fixed system prompt is reused on every
  // call (744 of ~845 tokens instead of ~330; prompt time 5.5 s -> 1.2 s, +18 MB; BENCHMARKS.md).
  'lfm3-1.7b-q4': { repo: 'LiquidAI/LFM3-1.7B-GGUF', file: 'LFM3-1.7B-Q4_K_M.gguf', license: 'LFM Open License v1.0', params: '1.7B', arch: 'tri-hybrid (conv + sliding + global attention)', ctx: 8192, extra: { chat_template_kwargs: { enable_thinking: false } }, serverArgs: ['--swa-full'] },
  'lfm3-1.7b-qad-q4': { repo: 'LiquidAI/LFM3-1.7B-GGUF', file: 'LFM3-1.7B-QAD-Q4_0.gguf', license: 'LFM Open License v1.0', params: '1.7B', arch: 'tri-hybrid (conv + sliding + global attention), quantization-aware Q4_0', ctx: 8192, extra: { chat_template_kwargs: { enable_thinking: false } }, serverArgs: ['--swa-full'] },
  // Embedding models for meaning-based retrieval (context-retrieval.js).
  'nomic-embed-v1.5': { repo: 'nomic-ai/nomic-embed-text-v1.5-GGUF', file: 'nomic-embed-text-v1.5.Q8_0.gguf', license: 'Apache-2.0', params: '137M', arch: 'embedding (BERT)', ctx: 2048, embedding: { pooling: 'mean', prefix: { query: 'search_query: ', doc: 'search_document: ' } } },
  'bge-small-en-v1.5': { repo: 'CompendiumLabs/bge-small-en-v1.5-gguf', file: 'bge-small-en-v1.5-q8_0.gguf', license: 'MIT', params: '33M', arch: 'embedding (BERT)', ctx: 512, embedding: { pooling: 'cls', prefix: { query: 'Represent this sentence for searching relevant passages: ', doc: '' } } },
};

// ─── Hardware ───────────────────────────────────────────────────────────────

function hardware() {
  const cpus = os.cpus() || [];
  const logical = cpus.length || 1;
  let physical = logical;
  let flags = [];
  try {
    if (process.platform === 'linux') {
      const info = fs.readFileSync('/proc/cpuinfo', 'utf8');
      const cores = new Set();
      let phys = '0';
      for (const line of info.split('\n')) {
        const [k, v] = line.split(':').map((x) => (x || '').trim());
        if (k === 'physical id') phys = v;
        if (k === 'core id') cores.add(`${phys}:${v}`);
        if (k === 'flags' && !flags.length) flags = v.split(/\s+/);
        if (k === 'Features' && !flags.length) flags = v.split(/\s+/); // arm
      }
      if (cores.size) physical = cores.size;
    } else if (logical >= 4) physical = Math.max(1, Math.round(logical / 2)); // SMT is the usual case on desktops
  } catch {}
  const has = (f) => flags.includes(f);
  return {
    platform: process.platform, arch: process.arch, model: (cpus[0] && cpus[0].model) || '',
    logical, physical, ramMB: Math.round(os.totalmem() / 1048576), freeMB: Math.round(os.freemem() / 1048576),
    simd: {
      avx2: has('avx2'), avx512: has('avx512f'), avx512vnni: has('avx512_vnni'), avxvnni: has('avx_vnni'), fma: has('fma'), f16c: has('f16c'),
      neon: process.arch === 'arm64' || has('asimd') || has('neon'), dotprod: has('asimddp'),
    },
  };
}

/**
 * Threads for background work: every physical core but one on a 4+ core PC
 * (the user keeps a core), never more than 8 (memory bandwidth, not cores,
 * limits token generation on a laptop).
 */
function pickThreads(hw = hardware()) {
  return Math.max(1, Math.min(8, hw.physical >= 4 ? hw.physical - 1 : hw.physical));
}

// ─── Binary and models ──────────────────────────────────────────────────────

function onPath(name) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    const f = path.join(dir, name);
    try { fs.accessSync(f, fs.constants.X_OK); return f; } catch {}
  }
  return '';
}

function findBinary() {
  const env = process.env.CODEPLY_LLAMA_SERVER;
  if (env && fs.existsSync(env)) return env;
  const own = path.join(RUNTIME_DIR(), 'bin', EXE);
  if (fs.existsSync(own)) return own;
  return onPath(EXE);
}

/** Models fetched into ~/.codeply/models (manifest.json written by scripts/context/fetch-model.mjs). */
function models() {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(MODELS_DIR(), 'manifest.json'), 'utf8'));
    return (Array.isArray(list) ? list : []).filter((m) => m && m.id && m.file && fs.existsSync(path.isAbsolute(m.file) ? m.file : path.join(MODELS_DIR(), m.file)))
      .map((m) => ({ ...CATALOG[m.id], ...m, path: path.isAbsolute(m.file) ? m.file : path.join(MODELS_DIR(), m.file) }));
  } catch { return []; }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

/** Resident and peak memory of a process, in MB (Linux; null elsewhere). */
function memoryOf(pid) {
  try {
    const s = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const kb = (k) => { const m = new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(s); return m ? Math.round(Number(m[1]) / 1024) : null; };
    return { rssMB: kb('VmRSS'), peakMB: kb('VmHWM') };
  } catch { return null; }
}

// ─── The managed server ─────────────────────────────────────────────────────

/**
 * @param {object} o
 * @param {string} [o.binary]       llama-server path (default findBinary())
 * @param {{ id: string, path: string, ctx?: number, serverArgs?: string[] }} o.model   serverArgs: per-model llama-server flags (CATALOG)
 * @param {number} [o.threads]      default pickThreads()
 * @param {number} [o.ctx]          context size (default the model's, else 8192)
 * @param {number} [o.idleMs]       stop after this long with no request (default 5 min)
 * @param {string[]} [o.args]       extra llama-server arguments
 * @param {Function} [o.spawn]      child_process.spawn (tests pass a fake)
 * @param {(s: string) => void} [o.log]
 */
function createRuntime(o) {
  const spawn = o.spawn || realSpawn;
  const log = o.log || (() => {});
  const idleMs = o.idleMs == null ? 5 * 60000 : o.idleMs;
  let child = null; let starting = null; let target = null; let idleTimer = null; let keyFile = '';
  const stats = { starts: 0, lastStartMs: 0, lastError: '', exitCode: null };

  const canStart = () => !!(o.binary || findBinary()) && !!(o.model && o.model.path && fs.existsSync(o.model.path));

  function touch() {
    if (idleTimer) clearTimeout(idleTimer);
    if (!idleMs) return;
    idleTimer = setTimeout(() => { log('[runtime] idle: stopping the local model'); stop(); }, idleMs);
    if (idleTimer.unref) idleTimer.unref();
  }

  async function waitHealthy(baseUrl, apiKey, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (!child) throw new Error(`llama-server exited (code ${stats.exitCode})${stats.lastError ? `: ${stats.lastError}` : ''}`);
      try {
        const res = await fetch(`${baseUrl.replace(/\/v1$/, '')}/health`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(1500) });
        if (res.ok) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('the local model did not become ready in time');
  }

  async function start() {
    const binary = o.binary || findBinary();
    if (!binary) throw new Error('llama-server is not installed (see docs/local-intelligence/RUNTIME.md)');
    if (!o.model || !o.model.path || !fs.existsSync(o.model.path)) throw new Error('no local model file');
    const t0 = Date.now();
    const port = await freePort();
    const apiKey = crypto.randomBytes(24).toString('hex');
    // The key in a private file, not on the command line where any process listing shows it.
    fs.mkdirSync(RUNTIME_DIR(), { recursive: true });
    keyFile = path.join(RUNTIME_DIR(), `key-${process.pid}-${port}`);
    fs.writeFileSync(keyFile, `${apiKey}\n`, { mode: 0o600 });
    const threads = o.threads || pickThreads();
    const args = [
      '-m', o.model.path, '--host', '127.0.0.1', '--port', String(port), '--api-key-file', keyFile,
      '-t', String(threads), '-tb', String(threads), '-c', String(o.ctx || o.model.ctx || 8192), '-np', '1',
      '--no-webui', '--jinja', '--prio', '-1', '--log-disable', '--offline', ...(o.model.serverArgs || []), ...(o.args || []),
    ];
    log(`[runtime] starting ${path.basename(binary)} ${o.model.id} on 127.0.0.1:${port}, ${threads} threads`);
    child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    stats.exitCode = null;
    let errTail = '';
    if (child.stderr) child.stderr.on('data', (d) => { errTail = (errTail + d.toString()).slice(-2000); });
    child.on('exit', (code) => {
      stats.exitCode = code;
      if (code) stats.lastError = errTail.trim().split('\n').slice(-3).join(' | ').slice(0, 400);
      child = null; target = null;
      try { if (keyFile) fs.unlinkSync(keyFile); } catch {}
    });
    child.on('error', (e) => { stats.lastError = e.message; child = null; target = null; });
    try { os.setPriority(child.pid, 10); } catch {} // below normal, on every OS
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    await waitHealthy(baseUrl, apiKey, o.startTimeoutMs || 90000);
    stats.starts += 1; stats.lastStartMs = Date.now() - t0;
    target = { baseUrl, apiKey, model: o.model.id, pid: child.pid };
    log(`[runtime] ready in ${stats.lastStartMs} ms`);
    return target;
  }

  /** The running server (started if needed). */
  async function ensure() {
    touch();
    if (target && child) return target;
    if (!starting) starting = start().finally(() => { starting = null; });
    return starting;
  }

  function stop() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    if (child) { try { child.kill('SIGTERM'); } catch {} }
    child = null; target = null;
    try { if (keyFile) fs.unlinkSync(keyFile); } catch {}
  }

  return {
    ensure, stop, canStart,
    running: () => !!(child && target),
    status: () => ({ running: !!(child && target), model: o.model && o.model.id, pid: child ? child.pid : null, memory: child ? memoryOf(child.pid) : null, ...stats }),
  };
}

module.exports = { CATALOG, hardware, pickThreads, findBinary, models, createRuntime, memoryOf, MODELS_DIR, RUNTIME_DIR };
