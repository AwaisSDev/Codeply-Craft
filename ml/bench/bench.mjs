// CPU benchmarks of the candidate models with llama.cpp's llama-bench: prompt
// processing and generation speed at the sizes extraction uses, per thread
// count, plus the resident memory of a running server at the app's settings.
//
//   node ml/bench/bench.mjs [--models qwen3-1.7b-q4,llama3.2-1b-q4] [--threads 1,2,3,4] [--reps 3]
//   → ml/results/bench.json (and a table on stdout)
//
// Run on an idle machine: anything else using the CPU skews the numbers.
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const RT = require(path.join(ROOT, 'codeply-cli/lib/local-runtime.js'));
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const BENCH = opt('bench', path.join(path.dirname(RT.findBinary() ? require('fs').realpathSync(RT.findBinary()) : ''), 'llama-bench'));
const THREADS = opt('threads', '2,3,4');
const REPS = opt('reps', '3');
const installed = RT.models().filter((m) => !m.embedding);
const want = opt('models', '') ? opt('models').split(',') : installed.map((m) => m.id);

const rows = [];
for (const id of want) {
  const m = installed.find((x) => x.id === id);
  if (!m) { console.error(`skip ${id}: not installed`); continue; }
  // pp768 ≈ one batch of events after the cached system prompt; tg160 ≈ one answer.
  const out = execFileSync(BENCH, ['-m', m.path, '-p', '768', '-n', '160', '-t', THREADS, '-r', REPS, '-ctk', 'q8_0', '-ctv', 'q8_0', '-fa', 'on', '-o', 'json'], { encoding: 'utf8', maxBuffer: 1 << 24, stdio: ['ignore', 'pipe', 'ignore'] });
  for (const r of JSON.parse(out)) {
    rows.push({ model: id, threads: r.n_threads, test: r.n_prompt ? `pp${r.n_prompt}` : `tg${r.n_gen}`, tokensPerSecond: Math.round(r.avg_ts * 10) / 10, stddev: Math.round(r.stddev_ts * 10) / 10, sizeMB: Math.round(r.model_size / 1048576), params: r.model_n_params, type: r.model_type });
  }
  console.error(`done ${id}`);
}

// Resident memory of the server as the app runs it (ctx 4096, q8_0 KV), after one real request.
async function serverMemory(id) {
  const m = installed.find((x) => x.id === id);
  const rt = RT.createRuntime({ model: m, ctx: 4096, threads: 3, idleMs: 0, args: ['-ctk', 'q8_0', '-ctv', 'q8_0'] });
  try {
    const t = await rt.ensure();
    await fetch(`${t.baseUrl}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t.apiKey}` }, body: JSON.stringify({ messages: [{ role: 'user', content: 'Say hi in JSON {"hi": "..."}' }], max_tokens: 16 }) });
    return { model: id, ...rt.status().memory, startMs: rt.status().lastStartMs };
  } finally { rt.stop(); }
}
const memory = [];
for (const id of want) if (installed.find((x) => x.id === id)) memory.push(await serverMemory(id));

const result = { at: new Date().toISOString(), host: RT.hardware(), llamaCpp: 'aa588a3', kvCache: 'q8_0', rows, memory };
fs.mkdirSync(path.join(ROOT, 'ml/results'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'ml/results/bench.json'), `${JSON.stringify(result, null, 2)}\n`);
const models = [...new Set(rows.map((r) => r.model))];
console.log('| Model | Size MB | Threads | Prompt tok/s (pp768) | Generate tok/s (tg160) | Server RSS MB (ctx 4096) | Start ms |');
console.log('|---|---|---|---|---|---|---|');
for (const id of models) {
  const mem = memory.find((x) => x.model === id) || {};
  for (const t of [...new Set(rows.filter((r) => r.model === id).map((r) => r.threads))]) {
    const pp = rows.find((r) => r.model === id && r.threads === t && r.test.startsWith('pp'));
    const tg = rows.find((r) => r.model === id && r.threads === t && r.test.startsWith('tg'));
    console.log(`| ${id} | ${pp ? pp.sizeMB : ''} | ${t} | ${pp ? pp.tokensPerSecond : ''} | ${tg ? tg.tokensPerSecond : ''} | ${mem.peakMB ?? ''} | ${mem.startMs ?? ''} |`);
  }
}
