/**
 * `codeply serve`: the engine as a local HTTP API with a live event stream, so
 * the terminal, the desktop app, a phone, an editor plugin or a script are all
 * thin clients of one engine. Same idea as opencode's server, same agent loop as
 * the TUI and the desktop app.
 *
 *   GET    /health                          liveness (no auth)
 *   GET    /config                          version, storage driver, default folder
 *   GET    /doc                             this route list
 *   GET    /event[?session=ID]              server-sent events (Last-Event-ID replays what was missed)
 *   GET    /session                         chats, newest first
 *   POST   /session            {cwd,title}  new chat
 *   GET    /session/:id                     one chat with all messages
 *   PATCH  /session/:id        {title}
 *   DELETE /session/:id
 *   POST   /session/:id/message {text,mode,bypass,images,model}   starts a run, returns 202
 *   POST   /session/:id/abort
 *   GET    /session/:id/pending             approvals and questions waiting for an answer
 *   POST   /session/:id/checkpoint/:cid {undo}   undo or redo one message's file changes
 *   GET    /session/:id/export[?format=md|html|json][&thinking=1]   (md and html hide keys and local paths)
 *   POST   /permission/:requestId {verdict: once|always|reject}
 *   POST   /question/:requestId   {answer}
 *   GET    /search?q=                       search every message of every chat
 *
 * Auth: every route except /health needs the password, as `Authorization: Bearer <pw>`,
 * HTTP Basic (any user name), or `?token=<pw>` (for EventSource, which cannot set headers).
 * Browsers are refused unless their Origin is listed in `allowedOrigins`.
 */
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 12 * 1024 * 1024;
const RING = 1000;

const newId = (p) => p + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
const checkpointView = (c) => ({ id: c.id, files: c.files, total: c.total, undone: !!c.undone, at: c.at });

function sessionMeta(s) {
  const last = s.messages[s.messages.length - 1];
  return { id: s.id, title: s.title, cwd: s.cwd, createdAt: s.createdAt, updatedAt: s.updatedAt, preview: (last && (last.text || last.label)) || '', messageCount: s.messages.length };
}

/**
 * @param {object} o
 * @param {number} [o.port=4096]   0 picks a free one
 * @param {string} [o.host='127.0.0.1']
 * @param {string} [o.password]    generated when omitted
 * @param {string} [o.cwd]         default project folder for new chats
 * @param {string} [o.dataDir]     where the chat database lives (default ~/.codeply/server)
 * @param {string[]} [o.allowedOrigins]
 * @param {object} [o.route]       model route override (tests, embedding)
 */
export async function startServer(o = {}) {
  const host = o.host || '127.0.0.1';
  const password = o.password || crypto.randomBytes(18).toString('base64url');
  const defaultCwd = path.resolve(o.cwd || process.cwd());
  const dataDir = o.dataDir || path.join(os.homedir(), '.codeply', 'server');
  const allowedOrigins = new Set(o.allowedOrigins || []);
  fs.mkdirSync(dataDir, { recursive: true });

  const pkg = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));
  const config = require('./config.js');
  const subagents = require('./subagents.js');
  const permissions = require('./permissions.js');
  const snapshot = require('./snapshot.js');
  const { buildHistory } = require('./history.js');
  const { openSessionDb } = require('./session-db.js');
  const share = require('./share.js');
  const { runAgent } = await import(pathToFileURL(path.join(HERE, 'agent.mjs')).href);

  // ── storage: SQLite when the runtime has it, one JSON file otherwise ──
  const db = openSessionDb(path.join(dataDir, 'sessions.db'));
  const jsonFile = path.join(dataDir, 'sessions.json');
  const store = { sessions: [] };
  if (db) Object.assign(store, db.load());
  else { try { Object.assign(store, JSON.parse(fs.readFileSync(jsonFile, 'utf8'))); } catch {} }
  if (!Array.isArray(store.sessions)) store.sessions = [];
  let persistTimer = null;
  const persistNow = () => {
    clearTimeout(persistTimer); persistTimer = null;
    try { if (db) db.save(store); else fs.writeFileSync(jsonFile, JSON.stringify(store)); } catch (e) { console.warn('[serve] could not save chats:', e.message); }
  };
  const persist = () => { if (!persistTimer) persistTimer = setTimeout(persistNow, 250); };

  // ── event stream ──
  let seq = 0;
  const ring = [];
  const clients = new Set(); // { res, session }
  const frame = (evt) => `id: ${evt.seq}\ndata: ${JSON.stringify(evt)}\n\n`;
  function emit(sessionId, event) {
    const evt = { seq: ++seq, sessionId, ...event };
    ring.push(evt);
    if (ring.length > RING) ring.shift();
    for (const c of clients) {
      if (c.session && c.session !== sessionId) continue;
      try { c.res.write(frame(evt)); } catch { clients.delete(c); }
    }
  }

  // ── runs, approvals, questions ──
  const runs = new Map(); // sessionId -> { abortController }
  const pending = new Map(); // requestId -> { kind, sessionId, request, resolve }
  const findSession = (id) => store.sessions.find((s) => s.id === id) || null;

  function settlePending(sessionId, value) {
    for (const [, p] of [...pending]) if (p.sessionId === sessionId) p.resolve(p.kind === 'question' ? null : value);
  }

  function makeApprove(session, { bypass }) {
    const signal = runs.get(session.id).abortController.signal;
    if (!Array.isArray(session.alwaysAllowed)) session.alwaysAllowed = [];
    const always = new Set(session.alwaysAllowed.filter((t) => t !== 'fetch_image'));
    const runAllowed = (req) => !req.danger && Array.isArray(req.patterns) && req.patterns.length > 0 && req.patterns.every((p) => always.has(`run:${p}`));
    const autoAllowed = (req) => {
      if (req.tool === 'fetch_image') return false;
      if (req.tool === 'run') return always.has('run') || runAllowed(req);
      return always.has(req.tool);
    };

    const approve = async (req) => {
      if (signal.aborted) return 'reject';
      const rule = permissions.decide(req, session.cwd);
      if (rule.decision === 'deny') {
        emit(session.id, { type: 'notice', level: 'warn', text: `Blocked by your permissions file (rule "${rule.rule}"): ${req.title}` });
        return 'reject';
      }
      if (rule.decision === 'allow' && req.tool !== 'fetch_image') { emit(session.id, { type: 'approval_auto', tool: req.tool, title: req.title, bypass: false }); return 'once'; }
      if (bypass || autoAllowed(req)) { emit(session.id, { type: 'approval_auto', tool: req.tool, title: req.title, bypass: !!bypass }); return 'once'; }
      // The server has no image picker: a fetched image is approved or refused like anything else.
      const requestId = newId('p_');
      const view = {
        requestId, tool: req.tool, title: req.title, detail: req.detail || '', danger: !!req.danger, diff: req.diff || null,
        alwaysScope: req.tool === 'run' ? (!req.danger && Array.isArray(req.patterns) ? req.patterns : []) : null,
      };
      emit(session.id, { type: 'approval_request', ...view });
      return new Promise((resolve) => {
        pending.set(requestId, {
          kind: 'approval', sessionId: session.id, request: view,
          resolve: (verdict) => {
            pending.delete(requestId);
            if (verdict === 'always') {
              if (req.tool === 'run') { if (!req.danger && Array.isArray(req.patterns)) for (const p of req.patterns) always.add(`run:${p}`); }
              else if (req.tool !== 'fetch_image') always.add(req.tool);
              session.alwaysAllowed = [...always];
              persist();
            }
            emit(session.id, { type: 'approval_resolved', requestId, verdict });
            resolve(verdict === 'always' && req.tool === 'fetch_image' ? 'once' : verdict);
          },
        });
      });
    };
    if (!bypass) {
      approve.ask = ({ question, options }) => {
        if (signal.aborted) return Promise.resolve(null);
        const requestId = newId('q_');
        const q = { kind: 'question', requestId, question, options: options || [], at: Date.now() };
        emit(session.id, { type: 'question_request', ...q });
        return new Promise((resolve) => {
          pending.set(requestId, {
            kind: 'question', sessionId: session.id, request: q,
            resolve: (answer) => {
              pending.delete(requestId);
              const text = answer == null ? null : String(answer).trim().slice(0, 2000) || null;
              session.messages.push({ ...q, answer: text });
              emit(session.id, { type: 'question_resolved', requestId, answer: text });
              resolve(text);
            },
          });
        });
      };
    }
    return approve;
  }

  function resolveRoute(modelId) {
    if (modelId) {
      const m = config.getModel && config.getModel(modelId);
      if (m) return { custom: m };
    }
    if (o.route) return o.route;
    const sel = config.getSelectedModel && config.getSelectedModel();
    return sel ? { custom: sel } : undefined; // undefined: the provider set with `codeply provider`
  }

  async function startRun(session, { text, mode, bypass, images, model }) {
    const abortController = new AbortController();
    runs.set(session.id, { abortController });
    const signal = abortController.signal;
    const history = buildHistory(session);
    session.messages.push({ kind: 'user', text, images: images && images.length ? images : undefined, at: Date.now() });
    if (session.messages.filter((m) => m.kind === 'user').length === 1 && (!session.title || session.title === 'New chat')) {
      session.title = text.length > 46 ? `${text.slice(0, 46)}...` : text;
    }
    session.updatedAt = Date.now();
    persistNow();
    emit(session.id, { type: 'run_started', session: sessionMeta(session), message: session.messages[session.messages.length - 1] });

    (async () => {
      const approve = makeApprove(session, { bypass });
      let beforeTree = null;
      if (mode === 'Build') { try { beforeTree = await snapshot.track(session.cwd); } catch {} }
      try {
        const run = runAgent({
          userMessage: text, history, mode, cwd: session.cwd, approve, images, signal,
          route: resolveRoute(model), roleId: subagents.detectRole(text) || session.stickyRole || undefined,
        });
        for await (const ev of run) {
          if (ev.type === 'text') session.messages.push({ kind: 'assistant', text: ev.text, interim: !!ev.interim, at: Date.now() });
          else if (ev.type === 'reasoning') session.messages.push({ kind: 'reasoning', text: ev.text, ms: ev.ms, at: Date.now() });
          else if (ev.type === 'tool_end') {
            const args = ev.args && ev.name === 'write_file' ? { path: ev.args.path }
              : ev.args && ev.name === 'apply_patch' ? { files: (ev.meta && ev.meta.files) || [] } : ev.args;
            session.messages.push({
              kind: 'tool', name: ev.name, label: ev.summary || (ev.args && (ev.args.path || ev.args.command || ev.args.pattern)) || '', ok: ev.ok, args, at: Date.now(),
              exitCode: ev.meta && typeof ev.meta.exitCode === 'number' ? ev.meta.exitCode : undefined,
              added: ev.meta && typeof ev.meta.added === 'number' ? ev.meta.added : undefined,
              removed: ev.meta && typeof ev.meta.removed === 'number' ? ev.meta.removed : undefined,
            });
          } else if (ev.type === 'notice') session.messages.push({ kind: 'notice', level: ev.level || 'info', text: ev.text, at: Date.now() });
          else if (ev.type === 'error') session.messages.push({ kind: 'notice', level: 'error', text: ev.error, at: Date.now() });
          session.updatedAt = Date.now();
          emit(session.id, ev);
          persist();
          if (ev.type === 'done' || ev.type === 'error' || ev.type === 'aborted') break;
        }
      } catch (err) {
        session.messages.push({ kind: 'notice', level: 'error', text: `Something went wrong: ${err.message}`, at: Date.now() });
        emit(session.id, { type: 'error', error: err.message });
      } finally {
        if (beforeTree) {
          try {
            const afterTree = await snapshot.track(session.cwd);
            const changes = await snapshot.changedFiles(session.cwd, beforeTree, afterTree);
            if (changes.length) {
              const checkpoint = { kind: 'checkpoint', id: newId('k'), beforeTree, afterTree, cwd: session.cwd, files: changes.slice(0, 200), total: changes.length, undone: false, at: Date.now() };
              session.messages.push(checkpoint);
              emit(session.id, { type: 'checkpoint', checkpoint: checkpointView(checkpoint) });
            }
          } catch {}
        }
        settlePending(session.id, 'reject');
        runs.delete(session.id);
        persistNow();
        emit(session.id, { type: 'run_finished' });
        emit(session.id, { type: 'session_sync', session: sessionMeta(session) });
      }
    })();
  }

  async function setCheckpoint(session, cid, undo) {
    const c = session.messages.find((m) => m.kind === 'checkpoint' && m.id === cid);
    if (!c) return { status: 404, body: { error: 'That change set is no longer available.' } };
    if (runs.has(session.id)) return { status: 409, body: { error: 'Wait for the current run to finish (or abort it) first.' } };
    if (!!c.undone === !!undo) return { status: 200, body: { ok: true, checkpoint: checkpointView(c) } };
    const later = session.messages.slice(session.messages.indexOf(c) + 1).filter((m) => m.kind === 'checkpoint' && !m.undone);
    const mine = new Set(c.files.map((f) => f.file));
    if (undo && later.some((m) => m.files.some((f) => mine.has(f.file)))) return { status: 409, body: { error: 'A later message changed some of the same files. Undo that one first.' } };
    const r = await snapshot.restore(c.cwd, undo ? c.beforeTree : c.afterTree, c.files.map((f) => f.file));
    if (!r.ok && !r.restored.length && !r.removed.length) return { status: 500, body: { error: `Could not restore the files (${r.failed.slice(0, 3).join(', ')}).` } };
    c.undone = !!undo;
    session.updatedAt = Date.now();
    persistNow();
    emit(session.id, { type: 'checkpoint_update', checkpoint: checkpointView(c) });
    return { status: 200, body: { ok: true, checkpoint: checkpointView(c), failed: r.failed } };
  }

  // ── HTTP ──
  const failures = new Map(); // ip -> { n, since }
  const authorized = (req, url) => {
    let supplied = null;
    const h = req.headers.authorization || '';
    if (/^bearer /i.test(h)) supplied = h.slice(7).trim();
    else if (/^basic /i.test(h)) { const d = Buffer.from(h.slice(6), 'base64').toString('utf8'); supplied = d.slice(d.indexOf(':') + 1); }
    else if (url.searchParams.has('token')) supplied = url.searchParams.get('token');
    return supplied != null && crypto.timingSafeEqual(digest(supplied), digest(password));
  };

  const send = (res, status, body, headers = {}) => {
    const isText = typeof body === 'string';
    res.writeHead(status, { 'Content-Type': isText ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(isText ? body : JSON.stringify(body));
  };

  const readJson = (req) => new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error('Request too large.'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(Object.assign(new Error('Body must be JSON.'), { status: 400 })); } });
    req.on('error', reject);
  });

  const ROUTES = [
    'GET /health', 'GET /config', 'GET /doc', 'GET /event', 'GET /session', 'POST /session', 'GET /session/:id', 'PATCH /session/:id', 'DELETE /session/:id',
    'POST /session/:id/message', 'POST /session/:id/abort', 'GET /session/:id/pending', 'POST /session/:id/checkpoint/:cid', 'GET /session/:id/export',
    'POST /permission/:requestId', 'POST /question/:requestId', 'GET /search',
  ];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname.replace(/\/+$/, '') || '/';
    const origin = req.headers.origin;
    const cors = origin && allowedOrigins.has(origin)
      ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Last-Event-ID', 'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS' }
      : {};
    // A page in a browser can reach a loopback server; only origins the owner listed may.
    if (origin && !allowedOrigins.has(origin)) return send(res, 403, { error: 'Origin not allowed.' });
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    const reply = (status, body) => send(res, status, body, cors);

    if (req.method === 'GET' && p === '/health') return reply(200, { ok: true, name: 'codeply', version: pkg.version });

    const ip = req.socket.remoteAddress || '?';
    const f = failures.get(ip);
    if (f && Date.now() - f.since < 60000 && f.n >= 10) return reply(429, { error: 'Too many failed attempts. Wait a minute.' });
    if (!authorized(req, url)) {
      const now = Date.now();
      failures.set(ip, !f || now - f.since >= 60000 ? { n: 1, since: now } : { n: f.n + 1, since: f.since });
      return reply(401, { error: 'Missing or wrong password.' });
    }
    failures.delete(ip);

    try {
      if (req.method === 'GET' && p === '/doc') return reply(200, { routes: ROUTES });
      if (req.method === 'GET' && p === '/config') {
        const cfg = config.getConfig();
        return reply(200, { name: 'codeply', version: pkg.version, storage: db ? db.kind : 'json', cwd: defaultCwd, provider: config.describeProvider ? config.describeProvider(cfg) : cfg.provider });
      }

      if (req.method === 'GET' && p === '/event') {
        const wanted = url.searchParams.get('session') || null;
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...cors });
        const client = { res, session: wanted };
        res.write(`data: ${JSON.stringify({ seq, type: 'server_connected', version: pkg.version })}\n\n`);
        const last = Number(req.headers['last-event-id'] || url.searchParams.get('after') || 0);
        if (last > 0) for (const evt of ring) if (evt.seq > last && (!wanted || evt.sessionId === wanted)) res.write(frame(evt));
        clients.add(client);
        const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch { clearInterval(beat); clients.delete(client); } }, 15000);
        req.on('close', () => { clearInterval(beat); clients.delete(client); });
        return;
      }

      if (req.method === 'GET' && p === '/search') {
        if (!db) return reply(501, { error: 'Chat search needs the SQLite store, which this Node runtime does not provide.' });
        return reply(200, { results: db.search(url.searchParams.get('q') || '', 50) });
      }

      if (req.method === 'GET' && p === '/session') {
        return reply(200, { sessions: store.sessions.map(sessionMeta).sort((a, b) => b.updatedAt - a.updatedAt), running: [...runs.keys()] });
      }
      if (req.method === 'POST' && p === '/session') {
        const body = await readJson(req);
        const cwd = path.resolve(String(body.cwd || defaultCwd));
        if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) return reply(400, { error: `Folder not found: ${cwd}` });
        const s = { id: newId('c'), title: String(body.title || 'New chat').slice(0, 80), cwd, createdAt: Date.now(), updatedAt: Date.now(), messages: [], alwaysAllowed: [] };
        store.sessions.unshift(s);
        persistNow();
        emit(s.id, { type: 'session_sync', session: sessionMeta(s) });
        return reply(201, { session: sessionMeta(s) });
      }

      let m = /^\/session\/([^/]+)(?:\/([a-z]+)(?:\/([^/]+))?)?$/.exec(p);
      if (m) {
        const session = findSession(decodeURIComponent(m[1]));
        if (!session) return reply(404, { error: 'No such chat.' });
        const sub = m[2];
        if (!sub) {
          if (req.method === 'GET') return reply(200, { session: { ...session, messages: session.messages.map((x) => (x.kind === 'checkpoint' ? { ...checkpointView(x), kind: 'checkpoint' } : x)) }, running: runs.has(session.id) });
          if (req.method === 'PATCH') {
            const body = await readJson(req);
            if (typeof body.title === 'string' && body.title.trim()) session.title = body.title.trim().slice(0, 80);
            persistNow();
            emit(session.id, { type: 'session_sync', session: sessionMeta(session) });
            return reply(200, { session: sessionMeta(session) });
          }
          if (req.method === 'DELETE') {
            if (runs.has(session.id)) { runs.get(session.id).abortController.abort(); settlePending(session.id, 'reject'); }
            store.sessions = store.sessions.filter((s) => s !== session);
            persistNow();
            emit(session.id, { type: 'session_deleted' });
            return reply(200, { ok: true });
          }
        }
        if (sub === 'message' && req.method === 'POST') {
          const body = await readJson(req);
          const text = String(body.text || '').trim();
          const images = Array.isArray(body.images) ? body.images.filter((x) => typeof x === 'string' && x.startsWith('data:image/')).slice(0, 6) : [];
          if (!text && !images.length) return reply(400, { error: 'Write a task before sending it.' });
          if (runs.has(session.id)) return reply(409, { error: 'A run is already in progress for this chat.' });
          if (!fs.existsSync(session.cwd)) return reply(400, { error: `The project folder is gone: ${session.cwd}` });
          const mode = ['Build', 'Plan', 'Ask'].includes(body.mode) ? body.mode : 'Build';
          await startRun(session, { text, mode, bypass: body.bypass === true, images, model: body.model ? String(body.model) : null });
          return reply(202, { ok: true, sessionId: session.id });
        }
        if (sub === 'abort' && req.method === 'POST') {
          const run = runs.get(session.id);
          if (run) { run.abortController.abort(); settlePending(session.id, 'reject'); }
          return reply(200, { ok: true, wasRunning: !!run });
        }
        if (sub === 'pending' && req.method === 'GET') {
          return reply(200, { pending: [...pending.values()].filter((x) => x.sessionId === session.id).map((x) => ({ kind: x.kind, ...x.request })) });
        }
        if (sub === 'checkpoint' && req.method === 'POST' && m[3]) {
          const body = await readJson(req);
          const r = await setCheckpoint(session, decodeURIComponent(m[3]), body.undo !== false);
          return reply(r.status, r.body);
        }
        if (sub === 'export' && req.method === 'GET') {
          const fmt = url.searchParams.get('format');
          if (fmt === 'json') return reply(200, { title: session.title, cwd: session.cwd, messages: session.messages.filter((x) => x.kind !== 'checkpoint') });
          const opts = { includeThinking: url.searchParams.get('thinking') === '1' };
          if (fmt === 'html') return send(res, 200, share.toHtml(session, opts), { ...cors, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
          return send(res, 200, share.toMarkdown(session, opts), { ...cors, 'Content-Type': 'text/markdown; charset=utf-8' });
        }
      }

      m = /^\/(permission|question)\/([^/]+)$/.exec(p);
      if (m && req.method === 'POST') {
        const entry = pending.get(decodeURIComponent(m[2]));
        if (!entry || entry.kind !== (m[1] === 'permission' ? 'approval' : 'question')) return reply(404, { error: 'Nothing is waiting for that answer (already answered, or the run ended).' });
        const body = await readJson(req);
        if (m[1] === 'permission') {
          if (!['once', 'always', 'reject'].includes(body.verdict)) return reply(400, { error: 'verdict must be once, always or reject.' });
          entry.resolve(body.verdict);
        } else entry.resolve(body.answer == null ? null : String(body.answer));
        return reply(200, { ok: true });
      }

      return reply(404, { error: 'Not found. GET /doc lists the routes.' });
    } catch (err) {
      return reply(err.status || 500, { error: err.message || 'Server error.' });
    }
  });

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(o.port ?? 4096, host, resolve); });
  const port = server.address().port;

  return {
    url: `http://${host === '0.0.0.0' || host === '::' ? 'localhost' : host}:${port}`,
    host, port, password, storage: db ? db.kind : 'json',
    async close() {
      for (const [id, run] of runs) { run.abortController.abort(); settlePending(id, 'reject'); }
      for (const c of clients) { try { c.res.end(); } catch {} }
      clients.clear();
      persistNow();
      if (db) db.close();
      await new Promise((r) => { server.close(() => r()); server.closeAllConnections && server.closeAllConnections(); });
    },
  };
}
