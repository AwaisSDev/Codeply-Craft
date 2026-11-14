// The Rune app's engine sidecar: Codeply's chats on the DSH engine, served over the same local
// HTTP + SSE API as `codeply serve` (codeply-cli/lib/server.mjs), so the app's live store speaks
// to either one.
//
// The Rune app starts this with the Node and the codeply-cli that the installed Codeply app ships
// (resources/dsh-runtime/node.exe and resources/codeply-cli), so nothing else is installed:
//   - chats run on DSH (craft-dsh) through codeply-cli/lib/dsh-acp.mjs, one engine per project
//     folder, one DSH session per chat, resumed after a restart;
//   - the engine is wired like the Electron app's dsh-chat.js: the same plugin inserts, a bridge
//     with /haze, /apps, /team, /context, /brain and /design, and DSH_AGENTS_HOME, so use_app,
//     ask_bot, hand_off, web_search and the shared context exist here too;
//   - the model is Haze 2 through that bridge, signed in with the same account as the Codeply app
//     (~/.codeply/auth.json), so no token reaches the engine;
//   - if DSH can't start (no engine shipped, old Node), the chat runs on Classic (agent.mjs);
//   - approvals wait for an answer from the app (POST /permission/:id);
//   - the app's team (POST /config {team}) is led by Wisp: a chat titled with a member's name is
//     that agent's chat, every other chat is Wisp's, and Wisp hands work to the agents.
// It exits when the app does: the app holds its stdin, and it ends when the app goes.
//
// Left out because it needs Electron: browser_check (BrowserWindow; the plugin is not inserted),
// the DPAPI key for the life store (safeStorage; the store opens unkeyed, sensitive items stay
// sealed), and the Gmail/calendar pollers of life-desktop.js (they need the app's windows and
// sign-in), so the life store is attached but only holds what something else puts in it.
//
//   node engine.mjs --cli <codeply-cli dir> --port <n> --token <secret> --data <dir> --cwd <dir>
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

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
/** A CLI lib module (CommonJS), or null with the reason kept for the routes that need it. */
const missing = {};
const cliLib = (name) => {
  try { return require(path.join(CLI, 'lib', name)); } catch (e) { missing[name] = e.message; return null; }
};
const need = (name) => {
  const m = cliLib(name);
  if (!m) throw Object.assign(new Error(`${name} is not available in this engine (${missing[name]}).`), { status: 501 });
  return m;
};

// Never let a stray rejection take the sidecar (and every chat) down.
process.on('uncaughtException', (e) => console.error('uncaught:', e && e.stack || e));
process.on('unhandledRejection', (e) => console.error('unhandled:', e && e.stack || e));

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
  return { id: s.id, title: s.title, cwd: s.cwd, createdAt: s.createdAt, updatedAt: s.updatedAt, preview: (last && (last.text || last.label)) || '', messageCount: s.messages.length, engine: s.engine || 'dsh', running: runs.has(s.id), queued: (queues.get(s.id) || []).length };
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
    if (c.session && c.session !== e.sessionId) continue;
    try { c.res.write(frame(e)); } catch { clients.delete(c); }
  }
}

// ---------- settings, team ----------
// Set by the app (POST /config): 'ask' waits for an answer to every approval; 'auto' (the app's
// "Full access") allows each one at once. team: [{id, name, role}], led by Wisp.
const settings = { approval: 'ask', effort: 'High', team: [] };
const folderKey = (cwd) => path.resolve(String(cwd || '')).toLowerCase();
const norm = (s) => String(s || '').trim().toLowerCase().replace(/^@/, '');

/** A team member from what the model wrote: an id, a name, "the research agent", "@Docs". */
function findMember(name) {
  const q = norm(name).replace(/^the\s+/, '').replace(/\s+(specialist|agent|bot)$/, '');
  if (!q) return null;
  const t = settings.team;
  return t.find((m) => norm(m.id) === q) || t.find((m) => norm(m.name) === q)
    || t.find((m) => q.split(/[^a-z0-9]+/).includes(norm(m.name))) || t.find((m) => norm(m.role).includes(q) && q.length > 3) || null;
}
/** The member whose chat this is (a chat titled with the member's name), else null: Wisp leads it. */
const memberOf = (s) => settings.team.find((m) => norm(m.name) === norm(s.title)) || null;
const rosterLines = () => settings.team.map((m) => `- ${m.name}: ${m.role || 'general help'}`);

/** Short instruction put in front of what Wisp-led chats send to the engine (never stored in the chat). */
function promptPrefix(session) {
  const member = memberOf(session);
  if (member) {
    return `[You are ${member.name}${member.role ? `, the ${member.role} agent` : ''} on the user's Codeply team. Work in your own area, do the task fully with your tools, and report briefly what you did and what is left.]\n\n`;
  }
  if (!settings.team.length) {
    return '[You are Wisp, who leads the user\'s agents. If the task needs a specialist agent (for example mail with no Inbox agent), do what you can and suggest creating an agent for it.]\n\n';
  }
  return `[You are Wisp, who leads the user's team: ${settings.team.map((m) => `${m.name} (${m.role || 'general'})`).join(', ')}. Hand tasks to the matching teammate with ask_bot (bot = their name, task = exactly what to do, with the context they need); do small things yourself. If no teammate fits and the task needs a specialist (for example mail with no Inbox agent), do what you can and suggest creating an agent for it.]\n\n`;
}

// ---------- jobs: commands and delegated agent runs ----------
const jobs = new Map(); // id -> { id, kind, title, agent, detail, running, startedAt, kill }
const jobView = (j) => ({ id: j.id, kind: j.kind, title: j.title, agent: j.agent || '', detail: j.detail || '', running: !!j.running });
function emitTask(j, sessionId = null) { emit(sessionId, { type: 'task_update', task: jobView(j) }); }
function addJob(j, sessionId = null) {
  const job = { startedAt: Date.now(), running: true, ...j };
  jobs.set(job.id, job);
  // Keep the list short: drop the oldest finished ones.
  const done = [...jobs.values()].filter((x) => !x.running);
  for (const d of done.slice(0, Math.max(0, done.length - 40))) jobs.delete(d.id);
  emitTask(job, sessionId);
  return job;
}
function endJob(job, sessionId = null, patch = {}) {
  Object.assign(job, patch, { running: false });
  emitTask(job, sessionId);
}
function killTree(proc) {
  if (!proc || proc.exitCode !== null || !proc.pid) return;
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
  } else {
    try { process.kill(-proc.pid, 'SIGTERM'); } catch { try { proc.kill('SIGTERM'); } catch {} }
  }
}

/** POST /exec: a command in the project folder, streamed as term_output / term_exit. */
function execCommand(cmd, cwd) {
  const id = newId('j_');
  const job = addJob({ id, kind: 'command', title: cmd.slice(0, 80), detail: cmd.slice(0, 200) });
  let proc;
  try {
    proc = spawn(cmd, { cwd, shell: process.platform === 'win32' ? 'powershell.exe' : true, windowsHide: true, detached: process.platform !== 'win32', env: { ...process.env, NO_COLOR: '1' } });
  } catch (e) {
    emit(null, { type: 'term_output', jobId: id, stream: 'err', text: `${e.message}\n` });
    emit(null, { type: 'term_exit', jobId: id, code: -1 });
    endJob(job);
    return id;
  }
  job.kill = () => killTree(proc);
  proc.stdout.on('data', (c) => emit(null, { type: 'term_output', jobId: id, stream: 'out', text: c.toString('utf8') }));
  proc.stderr.on('data', (c) => emit(null, { type: 'term_output', jobId: id, stream: 'err', text: c.toString('utf8') }));
  let ended = false;
  const finish = (code) => {
    if (ended) return; ended = true;
    emit(null, { type: 'term_exit', jobId: id, code: code == null ? -1 : code });
    endJob(job);
  };
  proc.on('error', (e) => { emit(null, { type: 'term_output', jobId: id, stream: 'err', text: `${e.message}\n` }); finish(-1); });
  proc.on('close', (code) => finish(code));
  return id;
}

// ---------- host pieces the DSH bridge needs ----------
const appLists = new Map(); // folder -> the apps listing in flight, so steps don't connect twice
const teams = new Map();    // DSH session id -> a Wisp turn's { prompt, askBot, handOff }
const turns = new Map();    // DSH session id -> the turn's { cwd, approve, request }, for the user's apps

const APPS_HOW = 'Call one with the use_app tool (app, tool, and args as a JSON object).';
const APPS_WAIT_MS = 12_000;      // the prompt goes without an app still connecting
const APP_OUTPUT_CHARS = 30_000;  // what one app call may put in front of the model

function listApps(cwd) {
  const key = folderKey(cwd);
  let p = appLists.get(key);
  if (!p) {
    p = need('mcp.js').listServers(cwd, { appsOnly: true }).finally(() => appLists.delete(key));
    appLists.set(key, p);
  }
  return p;
}

/** What @codeply/dsh-apps adds to a step: the APPS AND MCP SERVERS section, and whether use_app is offered. */
async function appsState(cwd, turn) {
  if (!Object.keys(need('apps.js').mcpServers()).length) return {};
  let timer;
  const list = await Promise.race([
    listApps(cwd),
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), APPS_WAIT_MS); }),
  ]).finally(() => clearTimeout(timer));
  if (!list || !list.length) return {};
  const agent = await lib('agent.mjs');
  const ranked = agent.rankMcp(list, turn ? turn.request : '');
  return { prompt: agent.mcpServersSection(ranked, true, APPS_HOW), apps: list.length };
}

function appLabel(cwd, server, tool) {
  const mcp = need('mcp.js');
  const def = mcp.findTool(cwd, server, tool);
  const title = mcp.titleOf(cwd, server);
  const toolTitle = (def && (def.title || def.annotations?.title)) || tool;
  return title ? `${title}: ${toolTitle}` : `${server}/${tool}`;
}

/** One use_app call, as Classic's mcp tool runs it: a tool not marked read-only asks the user first. */
async function callApp(cwd, turn, a, res) {
  const answer = (ok, output) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok, output })); };
  const server = String(a.app || '').trim();
  const tool = String(a.tool || '').trim();
  if (!server || !tool) return answer(false, 'use_app needs an app and a tool.');
  let toolArgs = {};
  if (a.args && typeof a.args === 'object') toolArgs = a.args;
  else if (String(a.args ?? '').trim()) {
    try { toolArgs = JSON.parse(String(a.args)); } catch { return answer(false, 'args must be a JSON object, like {"query": "x"}.'); }
  }
  if (!toolArgs || typeof toolArgs !== 'object' || Array.isArray(toolArgs)) return answer(false, 'args must be a JSON object, like {"query": "x"}.');
  let list = [];
  try { list = await listApps(cwd); } catch {}
  const app = list.find((s) => s.name === server);
  if (!app) return answer(false, `No connected app "${server}". Use one listed under APPS AND MCP SERVERS.`);
  if (app.error) return answer(false, `${app.title || server} is not connected right now (${app.error.slice(0, 200)}).`);
  const mcp = need('mcp.js');
  const def = mcp.findTool(cwd, server, tool);
  if (!def) return answer(false, `No tool "${tool}" in ${app.title || server}. Use one listed under APPS AND MCP SERVERS.`);
  const label = appLabel(cwd, server, tool);
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });
  // Waiting on the user's answer can take minutes: answer at once and keep the line warm
  // (JSON allows leading spaces), so the engine's fetch never times out.
  res.writeHead(200, { 'content-type': 'application/json' });
  const warmLine = setInterval(() => { if (!res.writableEnded) res.write(' '); }, 30_000);
  let r;
  try {
    if (!def.annotations?.readOnlyHint) {
      if (!turn) {
        r = { ok: false, output: `${label} changes something, so it can only run in a chat where the user can approve it.` };
      } else {
        const verdict = await turn.approve({
          tool: 'mcp',
          title: `Use ${def.title || def.annotations?.title || tool} in ${app.title || server}`,
          detail: JSON.stringify(toolArgs).slice(0, 600),
          danger: !!def.annotations?.destructiveHint,
        });
        if (verdict === 'reject') r = { ok: false, output: `User declined ${label}.` };
      }
    }
    if (!r && !ac.signal.aborted) {
      const out = await mcp.callTool(cwd, server, tool, toolArgs);
      let text = `${out.isError ? '[the tool reported an error]\n' : ''}${out.text}`;
      if (text.length > APP_OUTPUT_CHARS) text = `${text.slice(0, APP_OUTPUT_CHARS)}\n[cut: ${text.length - APP_OUTPUT_CHARS} more characters]`;
      if (out.images.length) text += `\n[${out.images.length} image${out.images.length === 1 ? '' : 's'} returned, not shown here]`;
      r = { ok: !out.isError, output: text };
    }
  } catch (e) {
    r = { ok: false, output: `${label} failed: ${e && e.message ? e.message : e}` };
  } finally {
    clearInterval(warmLine);
  }
  if (ac.signal.aborted) return res.end();
  return res.end(JSON.stringify({ ok: !!(r && r.ok), output: String((r && r.output) || '') }));
}

// ---------- the DSH bridge (dsh-chat.js's, without the Electron-only parts) ----------
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

let bridge = null; // { server, url, token }
function startBridge() {
  if (bridge) return Promise.resolve(bridge);
  const token = crypto.randomBytes(32).toString('hex');
  const server = http.createServer(async (req, res) => {
    const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const got = Buffer.from(String(req.headers.authorization || ''));
    const want = Buffer.from(`Bearer ${token}`);
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return reply(401, { success: false, error: 'Unauthorized.' });
    if (req.method === 'GET' && req.url === '/models') return reply(200, { models: [] });
    if (req.method !== 'POST') return reply(404, { success: false, error: 'Not found.' });
    // browser_check needs Electron's browser panel (BrowserWindow): not offered here.
    if (req.url === '/browser-check') return reply(200, { ok: false, output: 'browser_check is not available in this app.' });
    // The shared context (brain, the user's day, what Codeply did lately) and its tools.
    if (req.url === '/context' || /^\/brain\/(remember|recall|life_context)$/.test(req.url || '')) {
      try {
        const body = JSON.parse(await readBody(req));
        const shared = need('shared-context.js');
        const o = { cwd: String(body.cwd || ''), chatId: String(body.chatId || ''), request: String(body.request || '') };
        if (req.url === '/context') return reply(200, { ok: true, text: shared.blockFor({ ...o, native: true }) });
        const r = await shared.runTool(req.url.slice('/brain/'.length), body.args && typeof body.args === 'object' ? body.args : {}, o);
        return reply(200, { ok: !!(r && r.ok), output: String((r && r.output) || '') });
      } catch (e) {
        return reply(200, { ok: false, output: `Codeply's shared context failed: ${e && e.message ? e.message : e}`, text: '' });
      }
    }
    // The team for a Wisp-led chat's turn: its prompt, and ask_bot and hand_off.
    if (req.url === '/team' || /^\/team\/(ask_bot|hand_off)$/.test(req.url || '')) {
      let body = {};
      try { body = JSON.parse(await readBody(req)); } catch {}
      const t = teams.get(String(body.chatId || ''));
      if (req.url === '/team') return reply(200, t ? { prompt: t.prompt, askBot: !!t.askBot, handOff: !!t.handOff } : {});
      const tool = req.url.slice('/team/'.length);
      const a = body.args && typeof body.args === 'object' ? body.args : {};
      if (!t || (tool === 'ask_bot' ? !t.askBot : !t.handOff)) return reply(200, { ok: false, output: `${tool} is not available here. Do the work yourself.` });
      if (tool === 'hand_off' && !String(a.intent || '').trim()) return reply(200, { ok: false, output: 'hand_off needs <intent>: what the other agent should get done.' });
      const ac = new AbortController();
      res.on('close', () => { if (!res.writableEnded) ac.abort(); });
      // An agent can work for many minutes: answer at once and keep the line warm
      // (JSON allows leading spaces), so the engine's fetch never times out waiting.
      res.writeHead(200, { 'content-type': 'application/json' });
      const warmLine = setInterval(() => { if (!res.writableEnded) res.write(' '); }, 30_000);
      let r;
      try {
        r = tool === 'ask_bot'
          ? await t.askBot({ name: String(a.bot || '').trim(), task: String(a.task || '').trim(), specialty: String(a.specialty || '').trim(), signal: ac.signal })
          : await t.handOff({ to: String(a.to || '').trim(), intent: String(a.intent || '').trim(), facts: a.facts, decision: a.decision });
      } catch (e) {
        r = { ok: false, output: `${tool} failed: ${e && e.message ? e.message : e}` };
      } finally {
        clearInterval(warmLine);
      }
      if (ac.signal.aborted) return res.end();
      return res.end(JSON.stringify({ ok: !!(r && r.ok), output: String((r && r.output) || '') }));
    }
    // The user's connected apps for a chat: the prompt, and use_app.
    if (req.url === '/apps' || req.url === '/apps/call') {
      let body = {};
      try { body = JSON.parse(await readBody(req)); } catch {}
      const turn = turns.get(String(body.chatId || ''));
      const cwd = turn ? turn.cwd : String(body.cwd || '');
      if (req.url === '/apps') {
        try { return reply(200, await appsState(cwd, turn)); } catch { return reply(200, {}); }
      }
      try {
        return await callApp(cwd, turn, body.args && typeof body.args === 'object' ? body.args : {}, res);
      } catch (e) {
        if (!res.headersSent) return reply(200, { ok: false, output: `use_app failed: ${e && e.message ? e.message : e}` });
        return res.end(JSON.stringify({ ok: false, output: `use_app failed: ${e && e.message ? e.message : e}` }));
      }
    }
    // The codeply-taste tools (design_direction, design_lint), run with Classic's code (no render here).
    const design = /^\/design\/(design_direction|design_lint)$/.exec(req.url || '');
    if (design) {
      try {
        const body = JSON.parse(await readBody(req));
        const cwd = String(body.cwd || '');
        if (!cwd || !fs.existsSync(cwd)) return reply(200, { ok: false, output: `${design[1]}: no project folder.` });
        const tools = await lib('design-tools.mjs');
        const r = await tools[design[1]](body.args && typeof body.args === 'object' ? body.args : {}, { cwd });
        return reply(200, { ok: !!(r && r.ok), output: String((r && r.output) || '') });
      } catch (e) {
        return reply(200, { ok: false, output: `${design[1]} failed: ${e && e.message ? e.message : e}` });
      }
    }
    if (req.url !== '/haze') return reply(404, { success: false, error: 'Not found.' });
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    try {
      const body = JSON.parse(await readBody(req));
      const ai = need('ai.js');
      const chatId = String(body.chatId || '');
      const h = body.haze || {};
      const r = await ai.chat(Array.isArray(body.messages) ? body.messages : [], {
        route: { auto: true },
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

// ---------- engines ----------
// Same patch as dsh-chat.js. Not inserted: @codeply/dsh-browser-check (browser_check needs Electron's browser panel).
const PATCH = `# Written by Codeply: the Rune app's chats on the DSH harness.
- id: acp
  config:
    provider: haze
    model: haze-2
- id: system-prompt
  config:
    personaPrefix: >-
      You are Codeply, powered by the {{model}} model. Codeply is made by Codeply Labs. If someone asks who made you or what you are, say you are Codeply, made by Codeply Labs. Never say OpenAI, Anthropic, Google or any other company made you, even though a model from one of them may run underneath.
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
    - id: codeply-design-tools
      name: '@codeply/dsh-design-tools'
    - id: codeply-shared-context
      name: '@codeply/dsh-shared-context'
    - id: codeply-team
      name: '@codeply/dsh-team'
    - id: codeply-apps
      name: '@codeply/dsh-apps'
- id: web
  config:
    searchProvider: codeply
    fetchProvider: http
`;

const engines = new Map(); // folder key -> { engine, used }
let acp = null;
let dshProblem = null;
async function engineFor(cwd) {
  if (!acp) acp = await lib('dsh-acp.mjs');
  const found = acp.findDsh();
  if (found.error) throw new Error(found.error);
  const key = folderKey(cwd);
  let e = engines.get(key);
  if (e && !e.engine.alive() && !e.engine.starting) { engines.delete(key); e = null; }
  if (!e) {
    const b = await startBridge();
    e = {
      engine: new acp.DshEngine({
        cwd: path.resolve(cwd),
        patch: PATCH,
        patchName: 'craft-desktop.patch.yml',
        bridge: { url: b.url, token: b.token },
        defaultSession: false,
        // Classic's ~/.codeply/AGENTS.md and skills, for both engines.
        env: { DSH_AGENTS_HOME: path.join(os.homedir(), '.codeply') },
      }),
      used: Date.now(),
    };
    engines.set(key, e);
    // Too many up: close the least recently used one that is not working.
    const idle = [...engines.entries()].filter(([k, v]) => k !== key && !v.engine.busy).sort((a, b2) => a[1].used - b2[1].used);
    while (engines.size > MAX_ENGINES && idle.length) {
      const [k, v] = idle.shift();
      try { v.engine.close(); } catch {}
      engines.delete(k);
    }
  }
  e.used = Date.now();
  return e.engine;
}

/** Apply the app's effort to one open DSH session; failures are ignored. */
async function applyEffort(engine, sessionId) {
  const v = settings.effort;
  if (!v || !sessionId) return;
  for (const value of [v, String(v).toLowerCase()]) {
    try { await engine.request('session/set_config_option', { sessionId, configId: 'reasoning_effort', value }); return; } catch {}
  }
}
async function applyEffortAll() {
  for (const [, e] of engines) {
    if (!e.engine.alive()) continue;
    for (const sid of [...e.engine.open]) await applyEffort(e.engine, sid).catch(() => {});
  }
}

// ---------- runs and approvals ----------
const runs = new Map();    // session id -> AbortController
const queues = new Map();  // session id -> messages sent while a reply was running, in order
const pending = new Map(); // request id -> { sessionId, request, resolve }
const idleWaiters = new Map(); // session id -> [resolve], for a delegated run that waits for a busy chat

function makeApprove(session, signal) {
  return (req) => new Promise((resolve) => {
    if (signal.aborted) return resolve('reject');
    if (settings.approval === 'auto') return resolve('once');
    const requestId = newId('p_');
    const request = { requestId, tool: req.tool || req.name || 'tool', title: req.title || 'Run a tool', detail: req.detail || '', danger: !!req.danger };
    pending.set(requestId, { sessionId: session.id, request, resolve: (v) => { pending.delete(requestId); emit(session.id, { type: 'approval_resolved', requestId, verdict: v }); resolve(v); } });
    emit(session.id, { type: 'approval_request', ...request });
    signal.addEventListener('abort', () => { const p = pending.get(requestId); if (p) p.resolve('reject'); }, { once: true });
  });
}

// DSH's tools under the names the app's approval cards know.
const SHELL_TOOLS = /^(pwsh|powershell|bash|sh|shell|run|run_command|exec|cmd)$/i;
const READ_ONLY = new Set(['read', 'read_image', 'grep', 'glob', 'web_search', 'web_fetch', 'todo_write', 'browser_check', 'use_app', 'ask_bot', 'hand_off', 'design_direction', 'design_lint', 'remember', 'recall', 'life_context']);
const commandOf = (args) => String((args && (args.command || args.cmd)) || '');

/** DSH asks before a write, an edit or a command; reads (and tools that ask on their own) just run. */
function dshApproveFor(approve) {
  return async (req) => {
    const raw = String(req.tool || '').replace(/^dsh:/, '');
    if (READ_ONLY.has(raw)) return 'once';
    const a = req.args && typeof req.args === 'object' ? req.args : {};
    const file = a.file_path || a.path || a.filePath || '';
    if (SHELL_TOOLS.test(raw)) {
      const command = commandOf(a);
      return approve({ tool: 'run', title: 'Run a command', detail: command, danger: /\brm\s+-rf\b|\bRemove-Item\b.*-Recurse|\bformat\b|\bdel\s+\/s\b/i.test(command) });
    }
    if (raw === 'write' || raw === 'edit' || raw === 'str_replace_editor') {
      const create = raw === 'write' || a.command === 'create';
      return approve({ tool: create ? 'write_file' : 'edit_file', title: create ? `Write ${file}` : `Edit ${file}`, detail: file, danger: false });
    }
    return approve(req);
  };
}

/** One turn on DSH: its text arrives in chunks, sent as `text_delta` and kept as one message. */
async function* runDsh(session, text, approve, signal) {
  const engine = await engineFor(session.cwd);
  const sessionId = await engine.openSession(session.dshSession);
  if (sessionId !== session.dshSession) { session.dshSession = sessionId; save(); await applyEffort(engine, sessionId); }
  turns.set(sessionId, { cwd: path.resolve(session.cwd), approve, request: String(text || '') });
  // Wisp leads every chat that is not a team member's own: it gets the team tools.
  if (!memberOf(session) && settings.team.length) {
    const ctx = { session, approve };
    teams.set(sessionId, {
      prompt: `YOUR TEAM\nYou lead these agents. Hand each task to the matching one with ask_bot and wait for its result (check it before you build on it); hand_off passes work on without waiting.\n${rosterLines().join('\n')}`,
      askBot: (o) => askBot(ctx, o),
      handOff: (o) => handOff(ctx, o),
    });
  }
  try {
    yield* engine.prompt(promptPrefix(session) + text, { approve: dshApproveFor(approve), signal, sessionId });
  } finally {
    teams.delete(sessionId);
    turns.delete(sessionId);
  }
}

/** One turn on Classic, when DSH can't run (or for a publish). */
async function* runClassic(session, text, approve, signal) {
  const { runAgent } = await lib('agent.mjs');
  const { buildHistory } = require('./history.js');
  const history = buildHistory({ ...session, messages: session.messages.slice(0, -1) });
  yield* runAgent({ userMessage: text, history, mode: 'Build', cwd: session.cwd, approve, signal, haze: { product: 'cli', chatId: session.id } });
}

/**
 * Run one message in a chat. Resolves when the reply is over, with { ok, text, error }.
 * opts: approvalSession (who the approval cards go to), signal (stops this run),
 * classic (run on Classic), onEvent(ev) (sees every engine event).
 */
async function startRun(session, text, opts = {}) {
  const ctl = new AbortController();
  runs.set(session.id, ctl);
  if (opts.signal) { if (opts.signal.aborted) ctl.abort(); else opts.signal.addEventListener('abort', () => ctl.abort(), { once: true }); }
  session.messages.push({ kind: 'user', text, at: Date.now() });
  const from = session.messages.length;
  if (session.messages.filter((m) => m.kind === 'user').length === 1 && (!session.title || session.title === 'New chat')) {
    session.title = text.length > 46 ? `${text.slice(0, 46)}...` : text;
  }
  session.updatedAt = Date.now();
  saveNow();
  emit(session.id, { type: 'run_started', session: meta(session), message: session.messages[session.messages.length - 1] });
  const approve = makeApprove(opts.approvalSession || session, ctl.signal);
  let reply = null; // the assistant message the current DSH chunks grow
  let kind = 'dsh';
  const result = { ok: true, text: '', error: '' };
  const shells = []; // commands DSH started and has not ended, oldest first
  const push = (m) => { session.messages.push(m); session.updatedAt = Date.now(); save(); };
  try {
    let run;
    if (opts.classic) {
      kind = 'classic';
      run = runClassic(session, text, approve, ctl.signal);
    } else {
      try {
        const dsh = runDsh(session, text, approve, ctl.signal);
        session.engine = 'dsh';
        // Pull the first event here so a DSH that can't start falls back before anything shows.
        const first = await dsh.next();
        run = (async function* () { if (!first.done) { yield first.value; yield* dsh; } })();
      } catch (e) {
        dshProblem = e.message;
        kind = 'classic';
        session.engine = 'classic';
        push({ kind: 'notice', level: 'info', text: `The DSH engine couldn't start (${e.message}). This reply runs on Classic.`, at: Date.now() });
        emit(session.id, { type: 'notice', level: 'info', text: `DSH unavailable, using Classic: ${e.message}` });
        run = runClassic(session, text, approve, ctl.signal);
      }
    }
    for await (let ev of run) {
      if (opts.onEvent) { try { opts.onEvent(ev); } catch {} }
      // Wisp's own commands show in the app's terminal too.
      if (ev.type === 'tool_start' && SHELL_TOOLS.test(String(ev.name || '')) && commandOf(ev.args)) {
        shells.push(commandOf(ev.args));
        emit(session.id, { type: 'term_agent', command: commandOf(ev.args) });
      } else if (ev.type === 'tool_end' && SHELL_TOOLS.test(String(ev.name || '')) && shells.length) {
        shells.shift();
        const out = String(ev.output || ev.error || '');
        if (out) emit(session.id, { type: 'term_output', jobId: 'agent', stream: ev.ok === false ? 'err' : 'out', text: out.endsWith('\n') ? out : `${out}\n` });
      }
      if (ev.type === 'text' && kind === 'dsh') {
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
        result.ok = false; result.error = String(ev.error);
      } else if (ev.type === 'aborted') { result.ok = false; result.error = 'Stopped.'; }
      if (ev.type !== 'reasoning' && ev.type !== 'tool_start') emit(session.id, ev);
      if (ev.type === 'done' || ev.type === 'error' || ev.type === 'aborted') break;
    }
  } catch (e) {
    push({ kind: 'notice', level: 'error', text: `Something went wrong: ${e.message}`, at: Date.now() });
    emit(session.id, { type: 'error', error: e.message });
    result.ok = false; result.error = e.message;
  } finally {
    result.text = session.messages.slice(from).filter((m) => m.kind === 'assistant' && !m.interim && m.text).map((m) => m.text).join('\n\n');
    runs.delete(session.id);
    saveNow();
    emit(session.id, { type: 'run_finished' });
    for (const w of idleWaiters.get(session.id) || []) w();
    idleWaiters.delete(session.id);
    // A message sent while this reply ran goes next, instead of being turned away.
    const queue = queues.get(session.id) || [];
    const next = queue.shift();
    if (!queue.length) queues.delete(session.id);
    emit(session.id, { type: 'session_sync', session: meta(session) });
    if (next !== undefined) setImmediate(() => startRun(session, next));
  }
  return result;
}

// ---------- team: Wisp hands work to the agents ----------
/** The agent's own chat (title = its name), made when missing. */
function agentSession(member, cwd) {
  const want = norm(member.name);
  const c = folderKey(cwd);
  let s = store.sessions.find((x) => norm(x.title) === want && folderKey(x.cwd) === c) || store.sessions.find((x) => norm(x.title) === want);
  if (!s) {
    s = { id: newId('c'), title: member.name, cwd: path.resolve(cwd), createdAt: Date.now(), updatedAt: Date.now(), messages: [], engine: 'dsh' };
    store.sessions.unshift(s);
    saveNow();
    emit(s.id, { type: 'session_sync', session: meta(s) });
  }
  return s;
}
const whenIdle = (id) => (runs.has(id) ? new Promise((r) => { idleWaiters.set(id, [...(idleWaiters.get(id) || []), r]); }) : Promise.resolve());
const summaryOf = (text) => {
  const t = String(text || '').trim();
  const m = /^summary:\s*(.+)$/im.exec(t);
  return (m ? m[1] : t.split('\n').find((l) => l.trim()) || '').replace(/\s+/g, ' ').slice(0, 300);
};

/** One delegated run in the agent's chat, on DSH. wait: false lets Wisp carry on. */
async function delegate({ session, approve }, member, task, signal) {
  const target = agentSession(member, session.cwd);
  const ac = new AbortController();
  if (signal) { if (signal.aborted) ac.abort(); else signal.addEventListener('abort', () => ac.abort(), { once: true }); }
  const job = addJob({ id: newId('a_'), kind: 'agent', title: `${member.name}: ${task.split('\n')[0].slice(0, 70)}`, agent: member.name, detail: task.slice(0, 300), kill: () => ac.abort() }, session.id);
  emit(session.id, { type: 'delegated', sessionId: session.id, agent: member.name, task: task.slice(0, 500) });
  let r;
  try {
    await whenIdle(target.id); // the user may be talking to this agent right now
    if (ac.signal.aborted) throw new Error('Stopped.');
    r = await startRun(target, task, { approvalSession: session, signal: ac.signal });
  } catch (e) {
    r = { ok: false, text: '', error: e.message };
  }
  const summary = r.ok ? summaryOf(r.text) : `Failed: ${r.error}`;
  endJob(job, session.id, { detail: summary });
  emit(session.id, { type: 'delegate_done', sessionId: session.id, agent: member.name, summary });
  return r;
}

const noMember = (name, specialty) => ({
  ok: false,
  output: `There is no agent called "${name}" on the team. The team: ${settings.team.map((m) => m.name).join(', ') || 'none yet'}. Do what you can yourself, and tell the user ${specialty ? `a "${specialty}" agent` : 'an agent for this'} could be created for it.`,
});

/** ask_bot: give one task to a team member and wait for its result. */
async function askBot(ctx, { name, task, specialty, signal }) {
  const member = findMember(name);
  if (!member) return noMember(name, specialty);
  if (!task) return { ok: false, output: 'ask_bot needs a task: say exactly what you want done, with the context.' };
  const r = await delegate(ctx, member, task, signal);
  if (!r.ok) return { ok: false, output: `${member.name} could not finish: ${r.error}` };
  return { ok: true, output: `RESULT FROM ${member.name.toUpperCase()}\nSummary: ${summaryOf(r.text)}\n\n${r.text || '(no details)'}\n\nCheck this against the goal before you build on it.` };
}

/** hand_off: pass work to a team member in the background, without waiting. */
async function handOff(ctx, { to, intent, facts, decision }) {
  const member = findMember(to);
  if (!member) return noMember(to, '');
  const extra = [facts ? `Facts: ${typeof facts === 'string' ? facts : JSON.stringify(facts)}` : '', decision ? `Decision needed: ${typeof decision === 'string' ? decision : JSON.stringify(decision)}` : ''].filter(Boolean);
  delegate(ctx, member, [intent, ...extra].join('\n\n')).catch(() => {});
  return { ok: true, output: `Handed to ${member.name}. It works on it in the background, in its own chat; do not wait for it.` };
}

// ---------- files ----------
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'target']);
const MAX_FILES = 2000;
const MAX_FILE = 1024 * 1024;

function listFiles(root) {
  const out = [];
  const stack = [''];
  while (stack.length && out.length < MAX_FILES) {
    const rel = stack.shift();
    let entries = [];
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const d of entries) {
      if (out.length >= MAX_FILES) break;
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        if (SKIP_DIRS.has(d.name) || d.name.startsWith('.')) continue;
        out.push(`${r}/`);
        stack.push(r);
      } else if (d.isFile()) out.push(r);
    }
  }
  return out;
}

/** A path inside the root, or null (outside it, or through a link that leaves it). */
function inside(root, rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) return null;
  const abs = path.resolve(root, rel);
  const within = (b, p) => { const r = path.relative(b, p); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
  if (!within(root, abs)) return null;
  try {
    const real = fs.realpathSync(fs.existsSync(abs) ? abs : path.dirname(abs));
    if (!within(fs.realpathSync(root), real)) return null;
  } catch { /* parent folders may not exist yet: PUT makes them */ }
  return abs;
}

// ---------- model helpers: /complete, /review ----------
const stripFences = (t) => String(t || '').replace(/^\s*```[a-z0-9_-]*\n?/i, '').replace(/\n?```\s*$/i, '');

async function completeCode({ path: file, prefix, suffix }) {
  try {
    const ai = need('ai.js');
    const messages = [
      { role: 'system', content: 'You complete code. Reply with only the text to insert at <CURSOR>, at most 2 lines, no fences' },
      { role: 'user', content: `File: ${String(file || '')}\n\n${String(prefix || '').slice(-3000)}<CURSOR>${String(suffix || '').slice(0, 1000)}` },
    ];
    const r = await ai.chat(messages, { route: { auto: true }, maxTokens: 64, temperature: 0.2, haze: { product: 'craft', surface: 'complete', chatId: 'rune-complete' } });
    if (!r || !r.success) return '';
    const text = stripFences(r.data && r.data.choices && r.data.choices[0] && r.data.choices[0].message && r.data.choices[0].message.content);
    return text.replace(/<CURSOR>/g, '').split('\n').slice(0, 2).join('\n');
  } catch { return ''; }
}

async function reviewCode({ path: file, text }) {
  const ai = need('ai.js');
  const numbered = String(text || '').slice(0, 60000).split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n');
  const messages = [
    { role: 'system', content: 'You review code. Find real problems only: bugs, unsafe code, broken logic, clear mistakes. Reply with a JSON object {"notes":[{"line":number,"severity":"error|warning|info","message":"short, plain","fix":"optional replacement text for that line"}]}. At most 8 notes, none if the code is fine.' },
    { role: 'user', content: `File: ${String(file || '')}\n\n${numbered}` },
  ];
  const r = await ai.chatJson(messages, { route: { auto: true }, haze: { product: 'craft', surface: 'review', chatId: 'rune-review' } });
  if (!r || !r.success) return { error: (r && r.error) || 'The review failed.' };
  const raw = Array.isArray(r.json && r.json.notes) ? r.json.notes : [];
  const notes = raw.filter((n) => n && typeof n.message === 'string' && n.message.trim()).slice(0, 8).map((n) => ({
    line: Math.max(1, Math.floor(Number(n.line)) || 1),
    severity: ['error', 'warning', 'info'].includes(n.severity) ? n.severity : 'info',
    message: n.message.trim().slice(0, 300),
    ...(typeof n.fix === 'string' && n.fix.trim() ? { fix: n.fix.slice(0, 500) } : {}),
  }));
  return { notes };
}

// ---------- apps catalog ----------
const appCatalog = new Map(); // id -> the registry/featured entry apps.connect wants

function appRows(q, search) {
  const apps = need('apps.js');
  const rows = new Map();
  const add = (id, e, connected) => {
    if (!id) return;
    appCatalog.set(id, e);
    if (!rows.has(id)) rows.set(id, { id, name: e.title || id, note: e.description || '', category: e.category || '', connected: !!connected, domain: e.domain || '', icon: e.icon || '' });
  };
  const ql = String(q || '').toLowerCase();
  for (const f of apps.featured()) {
    if (ql && !`${f.title} ${f.description} ${f.category}`.toLowerCase().includes(ql)) continue;
    add(f.connectedId || f.id, f, f.connectedId);
  }
  for (const s of search || []) add(s.connectedId || s.id || s.registry, s, s.connectedId);
  for (const c of apps.listConnected()) { if (!rows.has(c.id)) { rows.set(c.id, { id: c.id, name: c.title || c.id, note: c.description || '', category: c.category || '', connected: true, domain: c.domain || '', icon: c.icon || '' }); } else rows.get(c.id).connected = true; }
  return [...rows.values()];
}

// ---------- startup wiring (life-desktop.js, brain-desktop.js) ----------
// The life store opens without Electron's DPAPI key (key: null), so sensitive items stay sealed;
// attaching it is what lets mail/calendar lookups answer instead of "only works inside the app".
try {
  const L = cliLib('life.js');
  const S = cliLib('life-store.js');
  if (L && S) {
    const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } })();
    const lifeStore = S.openLifeStore({ key: null });
    if (lifeStore) L.attach(lifeStore, { tz, enabled: () => null }); // null = every source
    else missing['life-store'] = 'no SQLite driver';
  }
} catch (e) { missing.life = e.message; console.error('life:', e.message); }
try { const sp = cliLib('spine.js'); if (sp) sp.configure({}); } catch (e) { missing.spine = e.message; }

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
const rootFor = (url) => {
  const c = url.searchParams.get('cwd');
  return c && fs.existsSync(c) ? path.resolve(c) : DEFAULT_CWD;
};

// ---------- extensions ----------
// Each area of the app keeps its routes in its own module beside this file (sidecar/ext-*.mjs,
// built into the app and written out with this one; see EXTENSIONS in src/engine.rs). A module
// may export `start(ctx)` (called once at launch) and `route(ctx, req, res, url, p, reply)`, which
// returns true when it answered the request. Routes run after authentication, before the
// built-in ones. A module that fails to load is listed in GET /config's `missing`.
const extCtx = {
  CLI, DATA, DEFAULT_CWD, settings, missing,
  need, lib, emit, readJson, readBody,
  // Anything an extension shares with the others (a cache, a handle) goes here by name.
  shared: {},
};
const extensions = [];
{
  const here = path.dirname(fileURLToPath(import.meta.url));
  let names = [];
  try { names = fs.readdirSync(here).filter((n) => /^ext-[a-z0-9-]+\.mjs$/.test(n)).sort(); } catch {}
  for (const name of names) {
    try {
      const m = await import(pathToFileURL(path.join(here, name)).href);
      if (typeof m.start === 'function') await m.start(extCtx);
      extensions.push({ name, route: typeof m.route === 'function' ? m.route : null });
    } catch (e) { missing[name] = e.message; }
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const reply = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.method === 'GET' && p === '/health') return reply(200, { ok: true, name: 'codeply-sidecar', engine: dshProblem ? 'classic' : 'dsh' });
  if (!authed(req, url)) return reply(401, { error: 'Unauthorized.' });
  try {
    for (const ext of extensions) {
      if (ext.route && await ext.route(extCtx, req, res, url, p, reply)) return;
    }
    if (req.method === 'POST' && p === '/config') {
      const body = await readJson(req);
      if (body.approval === 'ask' || body.approval === 'auto') settings.approval = body.approval;
      if (typeof body.effort === 'string') { settings.effort = body.effort; applyEffortAll().catch(() => {}); }
      if (Array.isArray(body.team)) {
        settings.team = body.team.filter((m) => m && String(m.name || '').trim())
          .map((m) => ({ id: String(m.id || m.name), name: String(m.name).trim().slice(0, 40), role: String(m.role || '').trim().slice(0, 120) })).slice(0, 30);
      }
      // Answer anything already waiting, now that approvals don't need asking.
      if (settings.approval === 'auto') for (const [, entry] of pending) entry.resolve('once');
      return reply(200, { ok: true, settings });
    }
    if (req.method === 'GET' && p === '/config') {
      let dsh = 'unknown';
      try { if (!acp) acp = await lib('dsh-acp.mjs'); const f = acp.findDsh(); dsh = f.error ? `unavailable: ${f.error}` : 'ready'; } catch (e) { dsh = `unavailable: ${e.message}`; }
      let version = '';
      try { version = JSON.parse(fs.readFileSync(path.join(CLI, 'package.json'), 'utf8')).version || ''; } catch {}
      return reply(200, { name: 'codeply-sidecar', engine: dshProblem ? 'classic' : 'dsh', dsh, cwd: DEFAULT_CWD, cli: CLI, version, settings, missing });
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

    // ----- account -----
    if (p === '/account' && req.method === 'GET') {
      try {
        const s = await need('auth.js').getSession();
        const u = (s && s.user) || null;
        const md = (u && u.user_metadata) || {};
        return reply(200, { signedIn: !!u, email: (u && u.email) || '', name: md.full_name || md.name || '' });
      } catch (e) { return reply(200, { signedIn: false, email: '', name: '', error: e.message }); }
    }
    if (p === '/account/otp/send' && req.method === 'POST') {
      const body = await readJson(req);
      const email = String(body.email || '').trim();
      if (!/^\S+@\S+\.\S+$/.test(email)) return reply(400, { error: 'Enter a valid email address.' });
      try {
        const { error } = await need('auth.js').getClient().auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
        return error ? reply(200, { error: error.message }) : reply(200, { ok: true });
      } catch (e) { return reply(200, { error: e.message }); }
    }
    if (p === '/account/otp/verify' && req.method === 'POST') {
      const body = await readJson(req);
      const email = String(body.email || '').trim();
      const code = String(body.code || '').trim();
      if (!email || !code) return reply(400, { error: 'Email and code are needed.' });
      try {
        const { error } = await need('auth.js').getClient().auth.verifyOtp({ email, token: code, type: 'email' });
        return error ? reply(200, { error: error.message }) : reply(200, { ok: true });
      } catch (e) { return reply(200, { error: e.message }); }
    }
    if (p === '/account/signout' && req.method === 'POST') {
      try { await need('auth.js').logout(); return reply(200, { ok: true }); } catch (e) { return reply(200, { error: e.message }); }
    }

    // ----- apps -----
    if (p === '/apps' && req.method === 'GET') {
      const q = (url.searchParams.get('q') || '').trim();
      let search = [];
      let note = '';
      if (q) { try { const r = await need('apps.js').searchRegistry(q); search = r.apps || []; note = r.error || ''; } catch (e) { note = e.message; } }
      return reply(200, { apps: appRows(q, search), ...(note ? { error: note } : {}) });
    }
    if (p === '/apps/connect' && req.method === 'POST') {
      const body = await readJson(req);
      const id = String(body.id || '');
      const apps = need('apps.js');
      if (!appCatalog.size) appRows('', []);
      const entry = appCatalog.get(id) || apps.featured().find((f) => f.id === id);
      if (!entry || !entry.url) return reply(404, { error: 'Unknown app. List apps first, then connect one from the list.' });
      reply(202, { ok: true });
      apps.connect({ id: entry.id, url: entry.url, title: entry.title, description: entry.description, domain: entry.domain, category: entry.category, registry: entry.registry, icon: entry.icon },
        { openBrowser: (u) => emit(null, { type: 'open_url', url: u }) })
        .then(() => emit(null, { type: 'apps_changed' }))
        .catch((e) => emit(null, { type: 'notice', level: 'error', text: `Couldn't connect ${entry.title || id}: ${e && e.message ? e.message : e}` }));
      return;
    }
    const am = /^\/apps\/([^/]+)$/.exec(p);
    if (am && req.method === 'DELETE') {
      const ok = need('apps.js').removeApp(decodeURIComponent(am[1]));
      if (!ok) return reply(404, { error: 'That app is not connected.' });
      emit(null, { type: 'apps_changed' });
      return reply(200, { ok: true });
    }

    // ----- memory -----
    if (p === '/memory' && req.method === 'GET') {
      const brain = need('brain.js');
      const text = (url.searchParams.get('text') || '').trim();
      const list = brain.list({ ...(text ? { text } : {}), limit: 300 });
      return reply(200, { memories: list.map((x) => ({ id: x.id, kind: x.kind, text: x.text, scope: x.scope })) });
    }
    if (p === '/memory' && req.method === 'POST') {
      const body = await readJson(req);
      const text = String(body.text || '').trim();
      if (!text) return reply(400, { error: 'Write what to remember.' });
      const r = need('brain.js').observe({ kind: 'note', text, scope: 'me', certainty: 'stated' }, { product: 'craft' });
      if (!r || r.action === 'ignored') return reply(400, { error: `Not saved: ${(r && r.why) || 'nothing to keep'}.` });
      const x = r.memory || {};
      return reply(200, { ok: true, action: r.action, memory: { id: x.id, kind: x.kind, text: x.text, scope: x.scope } });
    }
    let mm = /^\/memory\/([^/]+)$/.exec(p);
    if (mm && req.method === 'DELETE') {
      return need('brain.js').forget(decodeURIComponent(mm[1])) ? reply(200, { ok: true }) : reply(404, { error: 'No such memory.' });
    }

    // ----- agents, jobs, terminal -----
    if (p === '/agents' && req.method === 'GET') {
      let specialists = [];
      try { specialists = need('wisp.js').listSpecialists().map((s) => ({ id: s.id, name: s.name, role: s.focus || '', kind: 'specialist', builtin: !!s.builtin })); } catch {}
      const team = settings.team.map((t) => ({ id: t.id, name: t.name, role: t.role, kind: 'team' }));
      return reply(200, { agents: [...team, ...specialists] });
    }
    if (p === '/exec' && req.method === 'POST') {
      const body = await readJson(req);
      const cmd = String(body.cmd || '').trim();
      if (!cmd) return reply(400, { error: 'Write a command to run.' });
      return reply(200, { id: execCommand(cmd, DEFAULT_CWD) });
    }
    if (p === '/jobs' && req.method === 'GET') {
      return reply(200, { tasks: [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt).map(jobView) });
    }
    mm = /^\/jobs\/([^/]+)$/.exec(p);
    if (mm && req.method === 'DELETE') {
      const j = jobs.get(decodeURIComponent(mm[1]));
      if (!j) return reply(404, { error: 'No such job.' });
      if (j.running && j.kill) { try { j.kill(); } catch {} }
      return reply(200, { ok: true, wasRunning: !!j.running });
    }

    // ----- files, completion, review, publish -----
    if (p === '/files' && req.method === 'GET') {
      const root = rootFor(url);
      return reply(200, { root, files: listFiles(root) });
    }
    if (p === '/file' && req.method === 'GET') {
      const root = rootFor(url);
      const rel = url.searchParams.get('path') || '';
      const abs = inside(root, rel);
      if (!abs) return reply(400, { error: 'That path is outside the project.' });
      let st;
      try { st = fs.statSync(abs); } catch { return reply(404, { error: 'No such file.' }); }
      if (!st.isFile()) return reply(400, { error: 'That is not a file.' });
      if (st.size > MAX_FILE) return reply(413, { error: 'That file is over 1 MB.' });
      const buf = fs.readFileSync(abs);
      if (buf.subarray(0, 8000).includes(0)) return reply(415, { error: 'That looks like a binary file.' });
      return reply(200, { path: rel, text: buf.toString('utf8') });
    }
    if (p === '/file' && req.method === 'PUT') {
      const body = await readJson(req);
      const root = rootFor(url);
      const abs = inside(root, String(body.path || ''));
      if (!abs || abs === root) return reply(400, { error: 'That path is outside the project.' });
      const text = String(body.text ?? '');
      if (Buffer.byteLength(text) > MAX_FILE) return reply(413, { error: 'That is over 1 MB.' });
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, text);
      return reply(200, { ok: true, path: body.path });
    }
    if (p === '/complete' && req.method === 'POST') {
      const body = await readJson(req);
      return reply(200, { text: await completeCode(body) });
    }
    if (p === '/review' && req.method === 'POST') {
      const body = await readJson(req);
      try { return reply(200, await reviewCode(body)); } catch (e) { return reply(e.status || 200, { notes: [], error: e.message }); }
    }
    if (p === '/publish' && req.method === 'POST') {
      const body = await readJson(req);
      const s = find(String(body.sessionId || ''));
      if (!s) return reply(404, { error: 'No such chat.' });
      if (runs.has(s.id)) return reply(409, { error: 'This chat is busy. Wait for the reply to finish, then publish.' });
      reply(202, { ok: true, sessionId: s.id });
      emit(s.id, { type: 'publish', running: true });
      let url2 = '';
      const grab = (ev) => {
        if (ev.type !== 'tool_end' || ev.name !== 'publish_deploy' || ev.ok === false) return;
        url2 = (ev.meta && ev.meta.liveUrl) || (/https?:\/\/[^\s)]+/.exec(`${ev.summary || ''} ${ev.output || ''}`) || [''])[0] || url2;
      };
      // A Classic run: the publish tools check the user's message for the intent to publish.
      startRun(s, 'Publish this project.', { classic: true, onEvent: grab }).then((r) => {
        if (!url2) { try { url2 = (cliLib('publish.js').readState(s.cwd).vercel || {}).url || ''; } catch {} }
        emit(s.id, { type: 'publish', running: false, url: url2, message: r.ok ? (r.text || '').slice(0, 400) : (r.error || 'Publishing failed.') });
      }).catch((e) => emit(s.id, { type: 'publish', running: false, url: '', message: e.message }));
      return;
    }

    // ----- chats -----
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
        if (runs.has(s.id)) {
          // Busy: queue it, show it at once, and run it when this reply ends.
          const q = queues.get(s.id) || [];
          q.push(text);
          queues.set(s.id, q);
          emit(s.id, { type: 'queued', text, position: q.length });
          return reply(202, { ok: true, sessionId: s.id, queued: q.length });
        }
        startRun(s, text);
        return reply(202, { ok: true, sessionId: s.id });
      }
      if (m[2] === 'abort' && req.method === 'POST') {
        const r = runs.get(s.id);
        // Stop means stop: drop what was queued behind this reply too.
        queues.delete(s.id);
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
    if (res.headersSent) { try { res.end(); } catch {} return; }
    return reply(e.status || 500, { error: e.message || 'Server error.' });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`codeply-sidecar listening http://127.0.0.1:${server.address().port}`);
});

// The app holds our stdin; when it goes, so do we (and every engine with us).
const shutdown = () => {
  for (const [, r] of runs) r.abort();
  for (const [, j] of jobs) { if (j.running && j.kill) { try { j.kill(); } catch {} } }
  for (const [, e] of engines) { try { e.engine.close(); } catch {} }
  if (bridge) { try { bridge.server.close(); } catch {} }
  saveNow();
  process.exit(0);
};
process.stdin.on('end', shutdown);
process.stdin.on('error', shutdown);
process.stdin.resume();
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
