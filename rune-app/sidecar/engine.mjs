// The Rune app's engine sidecar: Codeply's chats on the DSH engine, served over the same local
// HTTP + SSE API as `codeply serve` (codeply-cli/lib/server.mjs), so the app's live store speaks
// to either one.
//
// The Rune app starts this with the Node and the codeply-cli that the installed Codeply app ships
// (resources/dsh-runtime/node.exe and resources/codeply-cli), so nothing else is installed:
//   - chats run on DSH (craft-dsh) through codeply-cli/lib/dsh-acp.mjs, one engine per project
//     folder, one DSH session per chat, resumed after a restart;
//   - the model is Haze 2 through dsh-acp's loopback bridge, signed in with the same account as
//     the Codeply app (~/.codeply/auth.json), so no token reaches the engine;
//   - if DSH can't start (no engine shipped, old Node), the chat runs on Classic (agent.mjs);
//   - approvals wait for an answer from the app (POST /permission/:id).
// It exits when the app does: the app holds its stdin, and it ends when the app goes.
//
//   node engine.mjs --cli <codeply-cli dir> --port <n> --token <secret> --data <dir> --cwd <dir>
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const CLI = path.resolve(arg('cli', ''));
const PORT = Number(arg('port', '0'));
const TOKEN = process.env.CODEPLY_SIDECAR_TOKEN || arg('token', '');
const DATA = path.resolve(arg('data', path.join(os.homedir(), '.codeply', 'rune')));
const DEFAULT_CWD = path.resolve(arg('cwd', os.homedir()));
const RING = 1000;
const MAX_ENGINES = 2;

if (!CLI || !fs.existsSync(path.join(CLI, 'lib'))) {
  console.error(`codeply-sidecar: no codeply-cli at ${CLI}`);
  process.exit(2);
}
if (!TOKEN) {
  console.error('codeply-sidecar: no token');
  process.exit(2);
}
const require = createRequire(path.join(CLI, 'lib', 'x.js'));
const lib = (name) => import(pathToFileURL(path.join(CLI, 'lib', name)).href);

// ---------- storage ----------
fs.mkdirSync(DATA, { recursive: true });
const FILE = path.join(DATA, 'sessions.json');
const store = { sessions: [] };
try { Object.assign(store, JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch {}
if (!Array.isArray(store.sessions)) store.sessions = [];
let saveTimer = null;
const saveNow = () => {
  clearTimeout(saveTimer); saveTimer = null;
  try { fs.writeFileSync(FILE + '.tmp', JSON.stringify(store)); fs.renameSync(FILE + '.tmp', FILE); } catch (e) { console.error('save:', e.message); }
};
const save = () => { if (!saveTimer) saveTimer = setTimeout(saveNow, 300); };
const newId = (p) => p + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
const meta = (s) => {
  const last = s.messages[s.messages.length - 1];
  return { id: s.id, title: s.title, cwd: s.cwd, createdAt: s.createdAt, updatedAt: s.updatedAt, preview: (last && (last.text || last.label)) || '', messageCount: s.messages.length, engine: s.engine || 'dsh' };
};
const find = (id) => store.sessions.find((s) => s.id === id) || null;

// ---------- events ----------
let seq = 0;
const ring = [];
const clients = new Set();
const frame = (e) => `id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`;
function emit(sessionId, event) {
  const e = { seq: ++seq, sessionId, ...event };
  ring.push(e);
  if (ring.length > RING) ring.shift();
  for (const c of clients) {
    if (c.session && c.session !== sessionId) continue;
    try { c.res.write(frame(e)); } catch { clients.delete(c); }
  }
}

// ---------- engines ----------
const engines = new Map(); // cwd -> { engine, used }
let acp = null;
let dshProblem = null;
async function engineFor(cwd) {
  if (!acp) acp = await lib('dsh-acp.mjs');
  const found = acp.findDsh();
  if (found.error) throw new Error(found.error);
  let e = engines.get(cwd);
  if (!e) {
    if (engines.size >= MAX_ENGINES) {
      const idle = [...engines.entries()].filter(([, v]) => !v.engine.busy).sort((a, b) => a[1].used - b[1].used)[0];
      if (idle) { try { idle[1].engine.close(); } catch {} engines.delete(idle[0]); }
    }
    e = { engine: new acp.DshEngine({ cwd, defaultSession: false }), used: Date.now() };
    engines.set(cwd, e);
  }
  e.used = Date.now();
  return e.engine;
}

// ---------- runs and approvals ----------
const runs = new Map();    // session id -> AbortController
const pending = new Map(); // request id -> { sessionId, request, resolve }

function makeApprove(session, signal) {
  return (req) => new Promise((resolve) => {
    if (signal.aborted) return resolve('reject');
    const requestId = newId('p_');
    const request = { requestId, tool: req.tool || req.name || 'tool', title: req.title || 'Run a tool', detail: req.detail || '', danger: !!req.danger };
    pending.set(requestId, { sessionId: session.id, request, resolve: (v) => { pending.delete(requestId); emit(session.id, { type: 'approval_resolved', requestId, verdict: v }); resolve(v); } });
    emit(session.id, { type: 'approval_request', ...request });
    signal.addEventListener('abort', () => { const p = pending.get(requestId); if (p) p.resolve('reject'); }, { once: true });
  });
}

/** One turn on DSH: its text arrives in chunks, sent as `text_delta` and kept as one message. */
async function* runDsh(session, text, approve, signal) {
  const engine = await engineFor(session.cwd);
  const sessionId = await engine.openSession(session.dshSession);
  if (sessionId !== session.dshSession) { session.dshSession = sessionId; save(); }
  yield* engine.prompt(text, { approve, signal, sessionId });
}

/** One turn on Classic, when DSH can't run. */
async function* runClassic(session, text, approve, signal) {
  const { runAgent } = await lib('agent.mjs');
  const { buildHistory } = require('./history.js');
  const history = buildHistory({ ...session, messages: session.messages.slice(0, -1) });
  yield* runAgent({ userMessage: text, history, mode: 'Build', cwd: session.cwd, approve, signal, haze: { product: 'cli', chatId: session.id } });
}

async function startRun(session, text) {
  const ctl = new AbortController();
  runs.set(session.id, ctl);
  session.messages.push({ kind: 'user', text, at: Date.now() });
  if (session.messages.filter((m) => m.kind === 'user').length === 1 && (!session.title || session.title === 'New chat')) {
    session.title = text.length > 46 ? `${text.slice(0, 46)}...` : text;
  }
  session.updatedAt = Date.now();
  saveNow();
  emit(session.id, { type: 'run_started', session: meta(session), message: session.messages[session.messages.length - 1] });
  const approve = makeApprove(session, ctl.signal);
  let reply = null; // the assistant message the current DSH chunks grow
  const push = (m) => { session.messages.push(m); session.updatedAt = Date.now(); save(); };
  try {
    let run;
    try {
      const dsh = runDsh(session, text, approve, ctl.signal);
      session.engine = 'dsh';
      // Pull the first event here so a DSH that can't start falls back before anything shows.
      const first = await dsh.next();
      run = (async function* () { if (!first.done) { yield first.value; yield* dsh; } })();
    } catch (e) {
      dshProblem = e.message;
      session.engine = 'classic';
      push({ kind: 'notice', level: 'info', text: `The DSH engine couldn't start (${e.message}). This reply runs on Classic.`, at: Date.now() });
      emit(session.id, { type: 'notice', level: 'info', text: `DSH unavailable, using Classic: ${e.message}` });
      run = runClassic(session, text, approve, ctl.signal);
    }
    for await (let ev of run) {
      if (ev.type === 'text' && session.engine === 'dsh') {
        if (!reply) { reply = { kind: 'assistant', text: '', at: Date.now() }; push(reply); }
        reply.text += ev.text;
        emit(session.id, { type: 'text_delta', text: ev.text });
        save();
        continue;
      }
      reply = null;
      if (ev.type === 'text') push({ kind: 'assistant', text: ev.text, interim: !!ev.interim, at: Date.now() });
      else if (ev.type === 'tool_end') push({ kind: 'tool', name: ev.name, label: ev.summary || '', ok: ev.ok, at: Date.now() });
      else if (ev.type === 'notice') push({ kind: 'notice', level: ev.level || 'info', text: ev.text, at: Date.now() });
      else if (ev.type === 'error') {
        // The engine speaks of "Craft"; here the fix is to sign in in the Codeply app.
        if (/sign in/i.test(String(ev.error))) ev = { ...ev, error: "You're not signed in. Open the Codeply app, sign in, then send this again." };
        push({ kind: 'notice', level: 'error', text: ev.error, at: Date.now() });
      }
      if (ev.type !== 'reasoning' && ev.type !== 'tool_start') emit(session.id, ev);
      if (ev.type === 'done' || ev.type === 'error' || ev.type === 'aborted') break;
    }
  } catch (e) {
    push({ kind: 'notice', level: 'error', text: `Something went wrong: ${e.message}`, at: Date.now() });
    emit(session.id, { type: 'error', error: e.message });
  } finally {
    runs.delete(session.id);
    saveNow();
    emit(session.id, { type: 'run_finished' });
    emit(session.id, { type: 'session_sync', session: meta(session) });
  }
}

// ---------- HTTP ----------
const readJson = (req) => new Promise((resolve, reject) => {
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 4e6) { reject(Object.assign(new Error('Too large.'), { status: 413 })); req.destroy(); } });
  req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(Object.assign(new Error('Bad JSON.'), { status: 400 })); } });
});
const authed = (req, url) => {
  const h = req.headers.authorization || '';
  const given = h.startsWith('Bearer ') ? h.slice(7) : url.searchParams.get('token') || '';
  const a = Buffer.from(given), b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const reply = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.method === 'GET' && p === '/health') return reply(200, { ok: true, name: 'codeply-sidecar', engine: dshProblem ? 'classic' : 'dsh' });
  if (!authed(req, url)) return reply(401, { error: 'Unauthorized.' });
  try {
    if (req.method === 'GET' && p === '/config') {
      let dsh = 'unknown';
      try { if (!acp) acp = await lib('dsh-acp.mjs'); const f = acp.findDsh(); dsh = f.error ? `unavailable: ${f.error}` : 'ready'; } catch (e) { dsh = `unavailable: ${e.message}`; }
      return reply(200, { name: 'codeply-sidecar', engine: 'dsh', dsh, cwd: DEFAULT_CWD, cli: CLI });
    }
    if (req.method === 'GET' && p === '/event') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      const client = { res, session: url.searchParams.get('session') || null };
      res.write(`data: ${JSON.stringify({ seq, type: 'server_connected', engine: 'dsh' })}\n\n`);
      const last = Number(req.headers['last-event-id'] || 0);
      if (last > 0) for (const e of ring) if (e.seq > last && (!client.session || e.sessionId === client.session)) res.write(frame(e));
      clients.add(client);
      const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
      req.on('close', () => { clearInterval(beat); clients.delete(client); });
      return;
    }
    if (req.method === 'GET' && p === '/session') {
      return reply(200, { sessions: store.sessions.map(meta).sort((a, b) => b.updatedAt - a.updatedAt), running: [...runs.keys()] });
    }
    if (req.method === 'POST' && p === '/session') {
      const body = await readJson(req);
      const cwd = path.resolve(String(body.cwd || DEFAULT_CWD));
      if (!fs.existsSync(cwd)) return reply(400, { error: `Folder not found: ${cwd}` });
      const s = { id: newId('c'), title: String(body.title || 'New chat').slice(0, 80), cwd, createdAt: Date.now(), updatedAt: Date.now(), messages: [], engine: 'dsh' };
      store.sessions.unshift(s);
      saveNow();
      emit(s.id, { type: 'session_sync', session: meta(s) });
      return reply(201, { session: meta(s) });
    }
    let m = /^\/session\/([^/]+)(?:\/([a-z]+))?$/.exec(p);
    if (m) {
      const s = find(decodeURIComponent(m[1]));
      if (!s) return reply(404, { error: 'No such chat.' });
      if (!m[2] && req.method === 'GET') return reply(200, { session: s, running: runs.has(s.id) });
      if (m[2] === 'message' && req.method === 'POST') {
        const body = await readJson(req);
        const text = String(body.text || '').trim();
        if (!text) return reply(400, { error: 'Write a task before sending it.' });
        if (runs.has(s.id)) return reply(409, { error: 'A run is already in progress for this chat.' });
        startRun(s, text);
        return reply(202, { ok: true, sessionId: s.id });
      }
      if (m[2] === 'abort' && req.method === 'POST') {
        const r = runs.get(s.id);
        if (r) r.abort();
        return reply(200, { ok: true, wasRunning: !!r });
      }
      if (m[2] === 'pending' && req.method === 'GET') {
        return reply(200, { pending: [...pending.values()].filter((x) => x.sessionId === s.id).map((x) => x.request) });
      }
    }
    m = /^\/permission\/([^/]+)$/.exec(p);
    if (m && req.method === 'POST') {
      const entry = pending.get(decodeURIComponent(m[1]));
      if (!entry) return reply(404, { error: 'Nothing is waiting for that answer.' });
      const body = await readJson(req);
      if (!['once', 'always', 'reject'].includes(body.verdict)) return reply(400, { error: 'verdict must be once, always or reject.' });
      entry.resolve(body.verdict);
      return reply(200, { ok: true });
    }
    return reply(404, { error: 'Not found.' });
  } catch (e) {
    return reply(e.status || 500, { error: e.message || 'Server error.' });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`codeply-sidecar listening http://127.0.0.1:${server.address().port}`);
});

// The app holds our stdin; when it goes, so do we (and every engine with us).
const shutdown = () => {
  for (const [, r] of runs) r.abort();
  for (const [, e] of engines) { try { e.engine.close(); } catch {} }
  saveNow();
  process.exit(0);
};
process.stdin.on('end', shutdown);
process.stdin.on('error', shutdown);
process.stdin.resume();
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
