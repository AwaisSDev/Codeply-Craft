/**
 * Meaning-based retrieval for the brain, on this PC: an embedding model (a
 * small GGUF on Codeply's llama-server, local-runtime.js) turns memories and
 * the request into vectors, and brain.contextBlock() adds how close each
 * memory is in meaning to its word-based ranking (brain.setRetriever).
 *
 * Why: the brain's ranking is by shared words, so "order lunch for me" never
 * finds "the user prefers nihari" (ml/eval/retrieval.mjs measured recall 0 for
 * requests like that). The brain still owns retrieval; this only scores.
 *
 *   createRetriever({ brain, embed, model })
 *     scores(query) → Map<memoryId, z>   z = standard deviations above the
 *                                         mean similarity over all memories
 *   Vectors are cached per memory (keyed by a hash of its text and the model)
 *   in ~/.codeply/context/vectors.db; a changed memory is embedded again.
 *   At most maxNewPerCall memories are embedded per call, so a large brain is
 *   indexed over a few turns instead of blocking one.
 *
 *   llamaEmbedder({ ensure })            the /v1/embeddings call of a llama-server
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { loadDriver } = require('./session-db.js');

const hash = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);

function vectorStore({ file, memory, modulePaths } = {}) {
  const driver = loadDriver(modulePaths);
  if (!driver) {
    const m = new Map();
    return { get: (id) => m.get(id) || null, put: (id, model, h, v) => m.set(id, { model, hash: h, vector: v }), close() {} };
  }
  const f = memory ? ':memory:' : (file || path.join(os.homedir(), '.codeply', 'context', 'vectors.db'));
  if (!memory) fs.mkdirSync(path.dirname(f), { recursive: true });
  const db = driver.open(f);
  db.exec('CREATE TABLE IF NOT EXISTS vectors (memory_id TEXT PRIMARY KEY, model TEXT NOT NULL, text_hash TEXT NOT NULL, vector BLOB NOT NULL)');
  const get = db.prepare('SELECT * FROM vectors WHERE memory_id = ?');
  const put = db.prepare('INSERT INTO vectors (memory_id, model, text_hash, vector) VALUES (?, ?, ?, ?) ON CONFLICT(memory_id) DO UPDATE SET model = excluded.model, text_hash = excluded.text_hash, vector = excluded.vector');
  return {
    get(id) {
      const r = get.get(id);
      if (!r) return null;
      const b = Buffer.from(r.vector);
      return { model: r.model, hash: r.text_hash, vector: new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4) };
    },
    put: (id, model, h, v) => put.run(id, model, h, Buffer.from(new Float32Array(v).buffer)),
    close: () => { try { db.close(); } catch {} },
  };
}

function normalize(v) {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}
function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }

/**
 * @param {object} o
 * @param {object} o.brain                   brain.js
 * @param {(texts: string[]) => Promise<number[][]>} o.embed
 * @param {string} o.model                   the embedding model's id (vectors from another model are re-made)
 * @param {{ query?: string, doc?: string }} [o.prefix]   e.g. nomic: { query: 'search_query: ', doc: 'search_document: ' }
 * @param {number} [o.maxNewPerCall]
 * @param {object} [o.store]                 vectorStore()
 */
function createRetriever(o) {
  const store = o.store || vectorStore({ modulePaths: o.modulePaths });
  const prefix = o.prefix || {};
  const maxNew = o.maxNewPerCall || 64;
  const docText = (m) => `${m.slot ? `${m.slot}: ` : ''}${m.text}`;

  async function scores(query) {
    const memories = o.brain.list({ limit: 1000 }).filter((m) => m.kind !== 'lesson');
    if (!memories.length) return new Map();
    const missing = [];
    const vecs = new Map();
    for (const m of memories) {
      const h = hash(docText(m));
      const cur = store.get(m.id);
      if (cur && cur.model === o.model && cur.hash === h) vecs.set(m.id, cur.vector);
      else missing.push({ m, h });
    }
    const todo = missing.slice(0, maxNew);
    const [qv, ...docs] = await o.embed([`${prefix.query || ''}${query}`, ...todo.map((x) => `${prefix.doc || ''}${docText(x.m)}`)]);
    todo.forEach((x, i) => { const v = normalize(docs[i]); store.put(x.m.id, o.model, x.h, v); vecs.set(x.m.id, v); });
    const q = normalize(qv);
    const sims = [...vecs.entries()].map(([id, v]) => [id, dot(q, v)]);
    if (sims.length < 2) return new Map(sims.map(([id]) => [id, 0]));
    const mean = sims.reduce((s, [, x]) => s + x, 0) / sims.length;
    const sd = Math.sqrt(sims.reduce((s, [, x]) => s + (x - mean) ** 2, 0) / sims.length) || 1;
    return new Map(sims.map(([id, x]) => [id, (x - mean) / sd]));
  }

  return { scores, close: () => store.close() };
}

/** Embeddings from an OpenAI-compatible server on this PC (llama-server with --embedding). */
function llamaEmbedder({ ensure, fetch: doFetch = globalThis.fetch, timeoutMs = 30000 }) {
  return async (texts) => {
    const t = await ensure();
    const res = await doFetch(`${t.baseUrl.replace(/\/+$/, '')}/embeddings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(t.apiKey ? { Authorization: `Bearer ${t.apiKey}` } : {}) },
      body: JSON.stringify({ input: texts, model: t.model || 'embed' }), signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`embeddings: HTTP ${res.status}`);
    const data = await res.json();
    return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  };
}

module.exports = { createRetriever, llamaEmbedder, vectorStore };
