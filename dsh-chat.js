// Classic Craft's chats on the DSH harness (craft-dsh, Craft's fork of
// DeepSeek Harness): DSH's own loop and native tool calling do the work, and
// what it reports comes back as the same events runAgent() yields, so the
// chat looks and behaves as it always has.
//
//   - One engine per project folder (DSH's file tools resolve paths from the
//     engine's own folder), started early and kept warm; at most MAX_ENGINES
//     stay up, the least recently used idle one is closed first.
//   - One DSH session per Craft chat, saved on the chat and resumed after a
//     restart. A chat that started on the old agent hands its recent history
//     to its first DSH turn.
//   - The model is the one picked in Craft (Haze 2, or one of your own
//     models), reached through a loopback bridge here, so sign-in, keys and
//     Haze limits stay in this process. browser_check calls back here too and
//     opens the page in Craft's browser panel.
//   - Approvals go through Craft's own approve() (permissions file, Always
//     allow, bypass), so the cards and rules are the same as before.
//
// Needs Node 24.9+ for the engine; when it can't start, the chat runs on
// Classic's own agent instead (main.js decides).
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const MAX_ENGINES = 2;
const HISTORY_TURNS = 12;      // messages a chat's first DSH turn gets from before
const HISTORY_CHARS = 1500;    // per message

const PATCH = `# Written by Codeply: Classic's chats on the DSH harness.
- id: acp
  config:
    provider: haze
    model: haze-2
- id: system-prompt
  config:
    personaPrefix: >-
      You are Codeply, powered by the {{model}} model.
- insert:
    - id: llm-haze
      name: '@codeply/dsh-llm-haze'
    - id: codeply-edit-checks
      name: '@codeply/dsh-edit-checks'
    - id: codeply-edit-near-miss
      name: '@codeply/dsh-edit-near-miss'
    - id: codeply-shell-hints
      name: '@codeply/dsh-shell-hints'
    - id: codeply-claim-check
      name: '@codeply/dsh-claim-check'
    - id: codeply-web-search
      name: '@codeply/dsh-web-search'
    - id: codeply-browser-check
      name: '@codeply/dsh-browser-check'
- id: web
  config:
    searchProvider: codeply
    fetchProvider: http
`;

let host = null;   // { cliDir, aiLib(), configLib(), browserReport(args) }
let acp = null;    // codeply-cli/lib/dsh-acp.mjs
let bridge = null; // { server, url, token }
const engines = new Map(); // folder key -> { engine, usedAt }
const routes = new Map();  // DSH session id -> the turn's route

const folderKey = (cwd) => path.resolve(String(cwd || '')).toLowerCase();

async function loadAcp() {
  if (!acp) acp = await import(pathToFileURL(path.join(host.cliDir, 'lib', 'dsh-acp.mjs')).href);
  return acp;
}

/** Whether the harness can run here: built, and a new enough Node. */
async function available() {
  try {
    const found = (await loadAcp()).findDsh();
    return found.error ? { ok: false, error: found.error } : { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ─── Bridge ──────────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024 * 1024) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function startBridge() {
  if (bridge) return Promise.resolve(bridge);
  const token = crypto.randomBytes(32).toString('hex');
  const server = http.createServer(async (req, res) => {
    const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const got = Buffer.from(String(req.headers.authorization || ''));
    const want = Buffer.from(`Bearer ${token}`);
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return reply(401, { success: false, error: 'Unauthorized.' });
    // The model list for the engine's own picker: Craft's picker is the one used here.
    if (req.method === 'GET' && req.url === '/models') return reply(200, { models: [] });
    if (req.method !== 'POST') return reply(404, { success: false, error: 'Not found.' });
    if (req.url === '/browser-check') {
      try {
        const body = JSON.parse(await readBody(req));
        return reply(200, await host.browserReport({ url: String(body.url || ''), viewport: body.viewport, wait: body.wait }));
      } catch (e) {
        return reply(200, { ok: false, output: `browser_check failed: ${e && e.message ? e.message : e}` });
      }
    }
    if (req.url !== '/haze') return reply(404, { success: false, error: 'Not found.' });
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    try {
      const body = JSON.parse(await readBody(req));
      const ai = host.aiLib();
      if (!ai) return reply(503, { success: false, unreachable: true, error: 'Codeply\'s engine is still loading.' });
      const chatId = String(body.chatId || '');
      const ownId = typeof body.modelId === 'string' ? body.modelId : '';
      const own = ownId ? host.configLib()?.getModel(ownId) : null;
      const route = own ? { custom: own } : (routes.get(chatId) || { auto: true });
      const h = body.haze || {};
      const r = await ai.chat(Array.isArray(body.messages) ? body.messages : [], {
        route,
        ...(Array.isArray(body.tools) && body.tools.length ? { tools: body.tools } : {}),
        ...(Number.isFinite(body.maxTokens) ? { maxTokens: body.maxTokens } : {}),
        ...(Number.isFinite(body.temperature) ? { temperature: body.temperature } : {}),
        haze: {
          product: 'craft',
          surface: 'agent',
          chatId: `dsh:${chatId || 'none'}`,
          turnId: String(h.turnId || ''),
          step: Number(h.step) || 0,
          historyCount: Number(h.historyCount) || 0,
        },
        signal: ac.signal,
      });
      if (ac.signal.aborted) return;
      reply(200, r && typeof r === 'object' ? r : { success: false, error: 'The model returned nothing.' });
    } catch (e) {
      if (!ac.signal.aborted) reply(500, { success: false, error: e && e.message ? e.message : String(e) });
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      bridge = { server, token, url: `http://127.0.0.1:${server.address().port}/haze` };
      resolve(bridge);
    });
  });
}

// ─── Engines ─────────────────────────────────────────────────────────────────
async function engineFor(cwd) {
  const { DshEngine } = await loadAcp();
  const key = folderKey(cwd);
  let slot = engines.get(key);
  if (slot && !slot.engine.alive() && !slot.engine.starting) { engines.delete(key); slot = null; }
  if (!slot) {
    const b = await startBridge();
    slot = {
      engine: new DshEngine({
        cwd: path.resolve(cwd),
        patch: PATCH,
        patchName: 'craft-desktop.patch.yml',
        bridge: { url: b.url, token: b.token },
        defaultSession: false,
        // Classic's ~/.codeply/AGENTS.md and skills, for both engines.
        env: { DSH_AGENTS_HOME: path.join(os.homedir(), '.codeply') },
      }),
      usedAt: 0,
    };
    engines.set(key, slot);
    // Too many up: close the least recently used one that is not working.
    const idle = [...engines.entries()].filter(([k, s]) => k !== key && s.engine.busy === 0).sort((a, b2) => a[1].usedAt - b2[1].usedAt);
    while (engines.size > MAX_ENGINES && idle.length) {
      const [k, s] = idle.shift();
      s.engine.close();
      engines.delete(k);
    }
  }
  slot.usedAt = Date.now();
  return slot.engine;
}

/** Start a folder's engine in the background, so the first message there doesn't wait. */
function warm(cwd) {
  if (!host || !cwd) return;
  engineFor(cwd).then((e) => e.start()).catch(() => {});
}

// ─── One turn ────────────────────────────────────────────────────────────────
// DSH's tools under the names Classic's chat already knows how to show.
function classicTool(name, args) {
  const a = args && typeof args === 'object' ? args : {};
  const filePath = a.file_path || a.path || a.filePath || '';
  switch (name) {
    case 'read': return { name: 'read_file', args: { ...a, path: filePath } };
    case 'read_image': return { name: 'view_images', args: { ...a, path: filePath } };
    case 'write': return { name: 'write_file', args: { path: filePath } };
    case 'edit': return { name: 'edit_file', args: { ...a, path: filePath } };
    case 'str_replace_editor':
      if (a.command === 'view') return { name: 'read_file', args: { ...a, path: filePath } };
      if (a.command === 'create') return { name: 'write_file', args: { path: filePath } };
      return { name: 'edit_file', args: { ...a, path: filePath } };
    case 'pwsh': case 'bash': return { name: 'run', args: { ...a, command: a.command || a.cmd || '' } };
    case 'grep': case 'glob': return { name: 'search', args: { ...a, pattern: a.pattern || a.query || '' } };
    default: return { name, args: a };
  }
}

/** The exit code a shell result reports, when it says one. */
function exitCodeOf(output) {
  const m = /exit(?:ed with)?(?: code)?[:\s]+(-?\d+)/i.exec(String(output || ''));
  return m ? Number(m[1]) : undefined;
}

const READ_ONLY = new Set(['read', 'read_image', 'grep', 'glob', 'web_search', 'web_fetch', 'todo_write', 'browser_check']);

/** What the chat said before, for a chat's first DSH turn. */
function historyPreamble(history) {
  const lines = (Array.isArray(history) ? history : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-HISTORY_TURNS)
    .map((m) => `${m.role === 'user' ? 'User' : 'You'}: ${m.content.trim().slice(0, HISTORY_CHARS)}`);
  if (!lines.length) return '';
  return `Earlier in this chat (for context):\n\n${lines.join('\n\n')}\n\n---\n\n`;
}

/**
 * Run one chat turn on the harness, yielding runAgent()-shaped events.
 * @param {object} o
 * @param {object} o.session - the Craft chat; its DSH session id is kept on it.
 * @param {string} o.userMessage
 * @param {Array} o.history - Classic history ({ role, content }) for a first DSH turn.
 * @param {string} o.cwd
 * @param {Function} o.approve - Craft's approve(request) for this run.
 * @param {AbortSignal} o.signal
 * @param {object} o.route - Craft's route for this turn ({ auto } or { custom }).
 */
async function* runTurn({ session, userMessage, history, cwd, approve, signal, route }) {
  const engine = await engineFor(cwd);
  const key = folderKey(cwd);
  const saved = session.dsh && session.dsh.folder === key ? session.dsh.sessionId : null;
  const sid = await engine.openSession(saved || undefined);
  const fresh = sid !== saved;
  session.dsh = { folder: key, sessionId: sid };
  routes.set(sid, route || { auto: true });
  const prompt = (fresh ? historyPreamble(history) : '') + userMessage;

  // DSH asks before a write, an edit or a command; reads just run, as in Classic.
  const dshApprove = async (req) => {
    const raw = String(req.tool || '').replace(/^dsh:/, '');
    if (READ_ONLY.has(raw)) return 'once';
    const { name, args } = classicTool(raw, req.args);
    if (name === 'run') {
      const { commandPatterns } = require(path.join(host.cliDir, 'lib', 'arity.js'));
      const command = String(args.command || '');
      let patterns = [];
      try { patterns = commandPatterns(command); } catch {}
      return approve({ tool: 'run', title: 'Run a command', detail: command, patterns, danger: /\brm\s+-rf\b|\bRemove-Item\b.*-Recurse|\bformat\b|\bdel\s+\/s\b/i.test(command) });
    }
    if (name === 'write_file' || name === 'edit_file') {
      return approve({ tool: name, title: name === 'write_file' ? `Write ${args.path}` : `Edit ${args.path}`, detail: args.path || '', danger: false });
    }
    return approve({ tool: name, title: `Use ${name}`, detail: req.detail || '', danger: false });
  };

  let text = '';
  let thought = '';
  let stepStart = Date.now(); // when the model started on this step, for "Thought for Xs"
  const flush = function* () {
    if (thought.trim()) { yield { type: 'reasoning', text: thought.trim(), ms: Date.now() - stepStart }; }
    thought = '';
    if (text.trim()) { yield { type: 'text', text: text.trim() }; }
    text = '';
  };
  const actions = [];
  const written = new Set();
  try {
    for await (const ev of engine.prompt(prompt, { approve: dshApprove, signal, sessionId: sid })) {
      if (ev.type === 'text') { text += ev.text; continue; }
      if (ev.type === 'reasoning') { thought += ev.text; continue; }
      if (ev.type === 'tool_start' || ev.type === 'tool_end') {
        if (ev.name === 'todo_write') continue; // DSH's own list; Classic shows no row for it
        yield* flush();
        const { name, args } = classicTool(ev.name, ev.args);
        if (ev.type === 'tool_start') { yield { type: 'tool_start', name, args }; continue; }
        const output = String(ev.output || '');
        const exitCode = name === 'run' ? exitCodeOf(output) : undefined;
        const ok = ev.ok !== false && (exitCode === undefined || exitCode === 0);
        const label = args.path || args.command || args.pattern || args.url || args.query || '';
        if (ok && (name === 'write_file' || name === 'edit_file') && args.path) written.add(args.path);
        actions.push({ tool: name, label, ok, exitCode, files: args.path ? [args.path] : undefined });
        stepStart = Date.now();
        yield {
          type: 'tool_end', name, args, ok,
          error: ok ? undefined : (ev.error || output).slice(0, 600),
          meta: { output: name === 'run' ? output.slice(-4000) : undefined, exitCode },
        };
        continue;
      }
      if (ev.type === 'done') {
        yield* flush();
        yield { type: 'done', steps: ev.steps, secs: ev.secs, actions, madeAnyEdit: written.size > 0, writtenFiles: [...written], engine: 'dsh' };
        return;
      }
      if (ev.type === 'error' || ev.type === 'aborted') {
        yield* flush();
        yield ev;
        return;
      }
    }
  } finally {
    routes.delete(sid);
  }
}

function init(h) {
  host = h;
}

function dispose() {
  for (const { engine } of engines.values()) engine.close();
  engines.clear();
  if (bridge) { try { bridge.server.close(); } catch {} bridge = null; }
}

module.exports = { init, available, warm, runTurn, dispose };
