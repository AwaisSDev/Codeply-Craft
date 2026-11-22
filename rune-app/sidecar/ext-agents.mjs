// Subagents: Codeply's background agents, each with a name and a mascot of its own, that the main
// agent starts from a chat (one, or a swarm of up to six on one goal). They belong to that chat:
// the app lists them only there, in Background tasks > Subagents. Each one streams what it does
// to the app, can be messaged or stopped while it works (by you from its typing bar, or by the
// main agent with message_agent / stop_agent), and remembers its earlier rounds. A swarm shares a
// team channel (team_read / team_post); an agent given the browser gets its own tab in Codeply's
// browser, labelled with its name and mascot. When a group the main agent started is done, one
// report goes back to the chat and the main agent answers from it.
//
// The agents run on the agent runtime the Codeply app sets up (codeply-cli/lib/claude-code.js).
// None of that is shown: they are Codeply's agents, by name, everywhere the user looks.
//
// The app:
//   GET  /ext/agents                       { ready, why, agents: [...with log], swarms: [...] }
//   POST /ext/agents/send     { id, text } a message while it works, or its next round
//   POST /ext/agents/stop     { id }
//   POST /ext/agents/remove   { id }       a finished one, gone from the list
//   POST /ext/agents/team     { swarmId, text }  you, on a swarm's team channel
//   POST /ext/agents/browser  { reqId, ok, text }  the app's answer to a browser action
// Events (to the chat's session): subagent { agent }, subagent_log { agentId, entry },
//   subagent_patch { agentId, id, patch }, subagent_removed { agentId }, team_message { swarmId, message },
//   agent_browser { reqId, agentId, name, color, action, args } (the app acts in the agent's tab and
//   answers at /ext/agents/browser).
// The engine's bridge (the main agent's tools, @codeply/dsh-agents):
//   POST /agents { chatId } -> { prompt, enabled }   POST /agents/<start_agents|message_agent|stop_agent> { chatId, args }
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

let C = null;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG_MAX = 600;
const MAX_GROUP = 6;
const STATUS_TTL = 10 * 60 * 1000;

const rt = () => C.need('claude-code.js');
const oneLine = (s, n = 140) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const realDir = (d) => { try { return fs.realpathSync.native(d); } catch { return d; } };

// ---------- who they are ----------
const NAMES = ['Nova', 'Pico', 'Maple', 'Ziggy', 'Bolt', 'Echo', 'Taro', 'Lumi', 'Kiwi', 'Remy', 'Sol', 'Nori', 'Fern', 'Jett', 'Basil', 'Indigo'];
// The app's own mascot family (src/model.rs Shape and Gear names); Wisp's hexagon stays Wisp's.
const SHAPES = ['round', 'square', 'cloud', 'triangle', 'drop', 'pebble'];
const COLORS = ['#1f8bff', '#86d41f', '#ffbe0b', '#ff2fa8', '#ff6b2c', '#8f5bff', '#00c2a8', '#ff3b5c', '#22b8f0', '#c45cff', '#2fd36b', '#ff9f1c'];
const GEAR = ['cap', 'headphones', 'sprout', 'antennae', 'star', 'flower', 'glasses', 'shades', 'beret', 'bow', ''];
const pick = (list) => list[Math.floor(Math.random() * list.length)];

/** A look unlike any other agent's still around: its own colour while there are some left. */
function pickLook() {
  const worn = new Set([...agents.values()].map((a) => `${a.look.shape}|${a.look.color}`));
  const colors = new Set([...agents.values()].map((a) => a.look.color));
  for (let i = 0; i < 40; i++) {
    const look = { shape: pick(SHAPES), color: pick(COLORS), gear: pick(GEAR) };
    if (worn.has(`${look.shape}|${look.color}`) || (i < 20 && colors.has(look.color))) continue;
    return look;
  }
  return { shape: pick(SHAPES), color: pick(COLORS), gear: pick(GEAR) };
}
function uniqueName(want) {
  const taken = new Set([...agents.values()].map((a) => a.name.toLowerCase()));
  const w = oneLine(want, 24).replace(/[^\w .'-]/g, '');
  if (!w || /^(new|another|agent|helper)$/i.test(w)) {
    const free = NAMES.filter((n) => !taken.has(n.toLowerCase()));
    if (free.length) return pick(free);
  }
  const base = w ? w[0].toUpperCase() + w.slice(1) : 'Agent';
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}

// ---------- state ----------
const agents = new Map(); // id -> agent
const swarms = new Map(); // id -> { id, chatId, goal, members: [agent ids], messages: [], reads: { agentId: count } }
let seq = 0;
const FILE = () => path.join(C.DATA, 'agents.json');
let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const keep = [...agents.values()].sort((x, y) => (x.endedAt || x.startedAt) - (y.endedAt || y.startedAt)).slice(-60);
    const out = {
      agents: keep.map((a) => ({ ...summary(a), cliSession: a.cliSession, cwd: a.cwd, by: a.by, part: a.part, log: a.log.slice(-300), seq: a.seq })),
      swarms: [...swarms.values()].filter((s) => s.members.some((m) => agents.has(m))).map((s) => ({ ...s })),
    };
    try { fs.writeFileSync(`${FILE()}.tmp`, JSON.stringify(out)); fs.renameSync(`${FILE()}.tmp`, FILE()); } catch {}
  }, 600);
}
function load() {
  let d = {};
  try { d = JSON.parse(fs.readFileSync(FILE(), 'utf8')); } catch { return; }
  for (const s of Array.isArray(d.agents) ? d.agents : []) {
    if (!s || !s.id || agents.has(s.id)) continue;
    const n = Number(String(s.id).replace(/\D/g, '')) || 0;
    if (n > seq) seq = n;
    agents.set(s.id, {
      id: s.id, name: s.name, chatId: s.chatId, cwd: s.cwd, look: s.look || pickLook(), by: s.by || 'codeply',
      // A run that was going when the app closed is over.
      status: s.status === 'working' ? 'stopped' : s.status || 'idle', task: s.task || '', part: s.part || '',
      round: s.round || 0, startedAt: s.startedAt || 0, endedAt: s.endedAt || 0, files: s.files || [], browser: !!s.browser,
      swarmId: s.swarm || '', cliSession: s.cliSession || '', log: Array.isArray(s.log) ? s.log : [], seq: s.seq || 0,
      control: null, abort: null, queued: [], group: '',
    });
  }
  for (const s of Array.isArray(d.swarms) ? d.swarms : []) if (s && s.id) swarms.set(s.id, { reads: {}, messages: [], ...s });
}

function summary(a) {
  return {
    id: a.id, chatId: a.chatId, name: a.name, color: a.look.color, shape: a.look.shape, gear: a.look.gear || '',
    status: a.status, task: oneLine(a.part || a.task, 300), round: a.round, startedAt: a.startedAt, endedAt: a.endedAt,
    swarm: a.swarmId || '', browser: !!a.browser, files: a.files.length, live: !!(a.control && a.control.send && a.status === 'working'),
  };
}
const swarmView = (s) => ({ id: s.id, chatId: s.chatId, goal: oneLine(s.goal, 400), members: s.members, messages: s.messages.slice(-200) });
const announce = (a) => { C.emit(a.chatId || null, { type: 'subagent', agent: summary(a) }); save(); };
function log(a, entry) {
  const e = { id: `e${++a.seq}`, at: Date.now(), ...entry };
  a.log.push(e);
  if (a.log.length > LOG_MAX) a.log.splice(0, a.log.length - LOG_MAX);
  C.emit(a.chatId || null, { type: 'subagent_log', agentId: a.id, entry: e });
  save();
  return e;
}
function patchEntry(a, id, p) {
  const e = a.log.find((x) => x.id === id);
  if (e) Object.assign(e, p);
  C.emit(a.chatId || null, { type: 'subagent_patch', agentId: a.id, id, patch: p });
}

// ---------- the runtime: is it there ----------
let status = { at: 0, value: null, pending: null };
async function runtimeStatus(refresh = false) {
  if (!refresh && status.value && Date.now() - status.at < STATUS_TTL) return status.value;
  if (status.pending) return status.pending;
  status.pending = (async () => {
    try { const v = await rt().status({ refresh }); status = { at: Date.now(), value: v, pending: null }; return v; } catch (e) { status = { at: Date.now(), value: { installed: false, error: e.message }, pending: null }; return status.value; }
  })();
  return status.pending;
}
async function notReady() {
  let st;
  try { st = await runtimeStatus(); } catch { st = null; }
  if (!st || !st.installed) return 'Background agents are not set up on this PC yet. The user can set them up in the Codeply app, under Connect Apps.';
  if (!st.loggedIn) return 'Background agents are set up but not signed in. The user can sign them in from the Codeply app, under Connect Apps.';
  return '';
}

// ---------- what an agent is told ----------
function skillsFor(task, cwd) {
  let lib;
  try { lib = C.need('skills.js'); } catch { return { taste: null, skills: [], dirs: [] }; }
  let all = [];
  try { all = lib.listSkills(cwd); } catch {}
  let taste = null;
  const t = all.find((s) => s.name === 'codeply-taste');
  if (t) { try { taste = { dir: t.dir, body: fs.readFileSync(path.join(t.dir, 'SKILL.md'), 'utf8') }; } catch {} }
  const skip = new Set(['codeply-taste', 'publish-website', 'taste']);
  let picked = [];
  try { picked = lib.findRelevantSkills(task, all, { limit: 6 }).filter((s) => !skip.has(s.name)).slice(0, 4); } catch {}
  const skills = picked.map((s) => ({ name: s.name, description: s.description, file: path.join(s.dir, 'SKILL.md'), dir: s.dir }));
  return { taste, skills, dirs: [taste && taste.dir, ...skills.map((s) => s.dir)].filter(Boolean) };
}

/** Its system prompt addition: Codeply's house rules and taste, and who it is. One file per content (cached). */
function appendFile(a, taste) {
  let rules = '';
  try { rules = rt().systemAppend({ taste, level: 'full' }); } catch {}
  const text = `${rules}

WHO YOU ARE
Your name is ${a.name}. You are one of Codeply's agents, working in the background for the user's Codeply chat. If anyone asks who or what you are, say you are ${a.name}, one of Codeply's agents. Never say you are Claude or Claude Code, never say Anthropic made you, and never mention them in messages, notes, commits or reports. Sign nothing with those names.`;
  const dir = path.join(C.DATA, 'agents');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `system-${crypto.createHash('sha1').update(text).digest('hex').slice(0, 12)}.md`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, text, 'utf8');
  return file;
}

function teamText(a) {
  const s = swarms.get(a.swarmId);
  if (!s) return '';
  const team = s.members.map((id) => agents.get(id)).filter(Boolean)
    .map((m) => `- ${m.name}${m.id === a.id ? ' (you)' : ''}: ${m.part || 'picks a part (see the team channel)'}`).join('\n');
  return [
    `YOU ARE ${a.name.toUpperCase()}, ONE OF ${s.members.length} AGENTS WORKING TOGETHER`,
    'Codeply started you all at once on one shared goal, in this folder.',
    '', `THE GOAL\n${s.goal}`,
    '', a.part ? `YOUR PART\n${a.part}` : 'YOUR PART\nNot assigned: read the team channel, claim a part nobody has (team_post "CLAIM: <part>"), then do it.',
    '', `THE TEAM\n${team}`,
    '', 'THE TEAM CHANNEL',
    '- team_read shows the goal, who does what, and the messages since you last read. Read it before you start and every few steps.',
    '- team_post tells everyone what you finished, the files you made, and what you need from whom; with "to" it goes straight to one teammate, even mid-work.',
    '- Never edit a file a teammate owns or made: ask on the channel instead. A file that combines everyone\'s work is edited only by the one whose part names it.',
    '- When your part is done, team_post "DONE: <one line>", then give your report.',
    ...(a.browser ? ['', 'YOUR BROWSER TAB\nYou have your own tab in Codeply\'s browser (browser_open, browser_look, browser_click, browser_type, browser_keys, browser_scroll, browser_back). The user watches it, labelled with your name. Look before you click, and click by element number.'] : []),
  ].join('\n');
}
const browserText = (a) => (a.browser && !a.swarmId ? '\n\nYOUR BROWSER TAB\nYou have your own tab in Codeply\'s browser (browser_open, browser_look, browser_click, browser_type, browser_keys, browser_scroll, browser_back). The user watches it, labelled with your name. Look before you click, and click by element number.' : '');

// ---------- its tools (team channel, browser): agents-mcp.mjs, through this endpoint ----------
let toolServer = null; // { url, token }
const keys = new Map(); // key -> agent id
function startToolServer() {
  if (toolServer) return Promise.resolve(toolServer);
  const token = crypto.randomBytes(24).toString('hex');
  const server = http.createServer((req, res) => {
    const done = (body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method !== 'POST' || req.url !== '/act' || req.headers['x-codeply-token'] !== token) { res.writeHead(403); res.end(); return; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 2e6) req.destroy(); });
    req.on('end', async () => {
      try {
        const j = JSON.parse(body || '{}');
        const a = agents.get(keys.get(String(j.key || '')) || '');
        if (!a) return done({ ok: false, text: 'This agent is no longer known to Codeply.' });
        done(await act(a, String(j.tool || ''), j.args && typeof j.args === 'object' ? j.args : {}));
      } catch (e) { done({ ok: false, text: String(e && e.message || e) }); }
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { toolServer = { url: `http://127.0.0.1:${server.address().port}/act`, token }; resolve(toolServer); });
  });
}

async function mcpConfigFor(a) {
  const want = [a.swarmId ? 'team' : '', a.browser ? 'browser' : ''].filter(Boolean);
  if (!want.length) return '';
  const srv = await startToolServer();
  let key = [...keys.entries()].find(([, id]) => id === a.id)?.[0];
  if (!key) { key = crypto.randomBytes(12).toString('hex'); keys.set(key, a.id); }
  const node = process.execPath;
  const dir = path.join(C.DATA, 'agents');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `tools-${a.id}.json`);
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { codeply: { command: node, args: [path.join(HERE, 'agents-mcp.mjs')], env: {
    CODEPLY_AGENTS_URL: srv.url, CODEPLY_AGENTS_TOKEN: srv.token, CODEPLY_AGENT_KEY: key, CODEPLY_AGENT_TOOLS: want.join(','),
  } } } }));
  return file;
}

function teamRead(a, all) {
  const s = swarms.get(a.swarmId);
  if (!s) return { ok: false, text: 'You are not on a team.' };
  const from = all ? 0 : (s.reads[a.id] || 0);
  s.reads[a.id] = s.messages.length;
  const who = s.members.map((id) => agents.get(id)).filter(Boolean).map((m) => `- ${m.name}${m.id === a.id ? ' (you)' : ''} [${m.status}]: ${m.part || 'no part claimed yet'}`).join('\n');
  const msgs = s.messages.slice(from).map((m) => `${m.from}${m.to ? ` → ${m.to}` : ''}: ${m.text}`).join('\n');
  return { ok: true, text: `GOAL\n${s.goal}\n\nTEAM\n${who}\n\n${msgs ? `MESSAGES${all ? '' : ' (new)'}\n${msgs}` : 'No new messages.'}` };
}
function postTeam(s, from, text, to = '') {
  const message = { id: `m${s.messages.length + 1}`, from, to, text: oneLine(text, 2000), at: Date.now() };
  s.messages.push(message);
  C.emit(s.chatId || null, { type: 'team_message', swarmId: s.id, message });
  save();
  return message;
}
async function act(a, tool, args) {
  if (tool === 'team_read') return teamRead(a, !!args.all);
  if (tool === 'team_post') {
    const s = swarms.get(a.swarmId);
    if (!s) return { ok: false, text: 'You are not on a team.' };
    const text = String(args.text || '').trim();
    if (!text) return { ok: false, text: 'Write the message.' };
    const toName = String(args.to || '').trim();
    const to = toName ? s.members.map((id) => agents.get(id)).find((m) => m && m.name.toLowerCase() === toName.toLowerCase()) : null;
    if (toName && !to) return { ok: false, text: `No teammate called ${toName}. The team: ${s.members.map((id) => agents.get(id)?.name).filter(Boolean).join(', ')}.` };
    postTeam(s, a.name, text, to ? to.name : '');
    if (/^\s*CLAIM:/i.test(text) && !a.part) { a.part = text.replace(/^\s*CLAIM:\s*/i, '').slice(0, 300); announce(a); }
    if (to && to.id !== a.id) deliver(to, `[Team message from ${a.name}] ${text}`);
    return { ok: true, text: to ? `Sent to ${to.name}.` : 'Posted on the team channel.' };
  }
  if (tool.startsWith('browser_')) return browserAct(a, tool.slice('browser_'.length), args);
  return { ok: false, text: `Unknown tool ${tool}.` };
}

// ---------- the browser: the app acts in the agent's own tab ----------
const browserWaits = new Map(); // reqId -> resolve
function browserAct(a, action, args) {
  const reqId = `b${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { browserWaits.delete(reqId); resolve({ ok: false, text: 'Codeply\'s browser did not answer. Is the app open?' }); }, 60_000);
    browserWaits.set(reqId, (r) => { clearTimeout(timer); browserWaits.delete(reqId); resolve(r); });
    C.emit(a.chatId || null, { type: 'agent_browser', reqId, agentId: a.id, name: a.name, color: a.look.color, shape: a.look.shape, gear: a.look.gear || '', action, args });
  });
}

// ---------- rounds ----------
/** Into the running session if it listens, else queued for its next round. */
function deliver(a, text) {
  if (a.status === 'working' && a.control && a.control.send && a.control.send(text)) return 'live';
  if (a.status === 'working') { a.queued.push(text); return 'queued'; }
  return '';
}

/** Steps in plain words, never the runtime's own tool names. */
const STEP = { Read: 'Read', Edit: 'Edit', MultiEdit: 'Edit', Write: 'Write', NotebookEdit: 'Edit', Bash: 'Run', PowerShell: 'Run', Glob: 'Search', Grep: 'Search', LS: 'List', WebFetch: 'Open', WebSearch: 'Web search', TodoWrite: 'Plan', Task: 'Helper', Agent: 'Helper' };
function stepName(name) {
  const n = String(name || '');
  if (STEP[n]) return STEP[n];
  const m = /^mcp__codeply__(team|browser)_(\w+)$/.exec(n);
  if (m) return m[1] === 'team' ? (m[2] === 'post' ? 'Team message' : 'Team channel') : `Browser ${m[2]}`;
  return n.replace(/^mcp__[\w-]+__/, '').replace(/[_-]+/g, ' ') || 'Step';
}
/** The few self-references a model may still make, in the agent's own name. */
const clean = (a, s) => String(s || '').replace(/\bClaude Code\b/g, 'Codeply').replace(/\b(I am|I'm|this is) Claude\b/gi, `$1 ${a.name}`).replace(/\bAnthropic's\b/g, 'Codeply\'s');

async function runRound(a, { task, by = 'codeply' }) {
  const resume = a.cliSession || '';
  a.round += 1;
  Object.assign(a, { task, by, startedAt: Date.now(), endedAt: 0, status: 'working', files: [] });
  const ac = new AbortController();
  const control = {};
  a.abort = ac; a.control = control;
  announce(a);
  log(a, { t: 'user', by, text: task, round: a.round });

  const { taste, skills, dirs } = skillsFor(task, a.cwd);
  let prompt;
  if (resume) {
    prompt = by === 'you' ? `THE USER WRITES TO YOU DIRECTLY:\n${task}` : by === 'codeply' ? `CODEPLY SENDS YOU BACK (round ${a.round})\n${task}\n\nDo exactly this, check it, and report again the same way.` : task;
  } else {
    const brief = (() => { try { return rt().buildPrompt({ task, chat: '', round: 1, skills }); } catch { return task; } })();
    prompt = a.swarmId ? `${teamText(a)}\n\n${a.part ? `THE TASK\n${brief}` : ''}`.trim() : `${brief}${browserText(a)}`;
  }
  let mcpConfig = '';
  try { mcpConfig = await mcpConfigFor(a); } catch (e) { log(a, { t: 'sys', tone: 'warn', text: `Its tools could not start: ${e.message}` }); }
  const before = rt().snapshot(a.cwd);
  const pending = new Map();
  let result = null;
  let lastText = '';
  try {
    for await (const ev of rt().run({ cwd: a.cwd, prompt, resume, level: 'full', appendFile: appendFile(a, taste), mcpConfig, strictMcp: !!a.swarmId, allowMore: mcpConfig ? ['mcp__codeply'] : [], addDirs: dirs, signal: ac.signal, control })) {
      if (ev.type === 'init' && ev.sessionId) a.cliSession = ev.sessionId;
      else if (ev.type === 'text' && !ev.sub) { lastText = clean(a, ev.text); log(a, { t: 'text', text: lastText }); }
      else if (ev.type === 'thinking' && !ev.sub) log(a, { t: 'think', text: oneLine(clean(a, ev.text), 600) });
      else if (ev.type === 'tool_start') {
        if (ev.sub) continue;
        const t = rt().asCodeplyTool(ev.name, ev.input, a.cwd);
        const i = ev.input || {};
        // Its own tools (team channel, browser) say what they did, not their ids.
        const arg = /^mcp__codeply__/.test(String(ev.name))
          ? oneLine(i.to ? `to ${i.to}: ${i.text || ''}` : i.text || i.url || i.keys || (i.element != null ? `#${i.element}` : '') || i.direction || '', 120)
          : rt().labelOf(t);
        const entry = log(a, { t: 'tool', name: stepName(ev.name), arg, status: 'run' });
        pending.set(ev.id, { entry: entry.id, tool: t.name, arg });
      } else if (ev.type === 'tool_end') {
        const p = pending.get(ev.id);
        if (!p) continue;
        pending.delete(ev.id);
        const lines = String(ev.output || '').split(/\r?\n/).filter((l) => l.trim());
        patchEntry(a, p.entry, { status: ev.ok ? 'ok' : 'fail', out: clean(a, lines.slice(0, 4).map((l) => l.slice(0, 240)).join('\n')), more: Math.max(0, lines.length - 4) });
        if (ev.ok && ['edit_file', 'write_file'].includes(p.tool) && p.arg && !a.files.includes(p.arg)) { a.files.push(p.arg); announce(a); }
      } else if (ev.type === 'turn_end') { if (ev.sessionId) a.cliSession = ev.sessionId; }
      else if (ev.type === 'result') { result = ev; if (ev.sessionId) a.cliSession = ev.sessionId; }
    }
  } catch (e) {
    result = { ok: false, error: e.message || String(e) };
  }
  a.control = null; a.abort = null;
  const aborted = !!(result && result.aborted) || ac.signal.aborted;
  const ok = !!(result && result.ok) && !aborted;
  const failed = ok ? '' : aborted ? 'stopped' : oneLine(clean(a, (result && result.error) || 'it stopped'), 300);
  const diff = rt().diffSnapshots(before, rt().snapshot(a.cwd));
  // Alone in the folder, everything that changed is its doing; in a team only what it wrote itself.
  if (!a.swarmId) a.files = [...new Set([...a.files, ...diff.added, ...diff.changed])];
  a.endedAt = Date.now();
  a.status = ok ? 'done' : aborted ? 'stopped' : 'failed';
  const text = clean(a, String((result && result.text) || lastText || '').trim());
  log(a, { t: 'done', ok, aborted, text: ok ? '' : failed, files: a.files.slice(0, 30), ms: a.endedAt - a.startedAt });
  announce(a);
  // Messages that came after it stopped listening: its next round, straight away.
  if (a.queued.length && !aborted) {
    const next = a.queued.splice(0).join('\n\n');
    setTimeout(() => { runRound(a, { task: next, by: 'you' }).catch(() => {}); }, 50);
  } else a.queued = [];
  return { ok, aborted, text, failed, files: a.files };
}

// ---------- groups the main agent started: one report back ----------
const groups = new Map(); // group id -> { chatId, ids, results: Map }
function finishOne(groupId, a, r) {
  const g = groups.get(groupId);
  if (!g) return;
  g.results.set(a.id, r);
  if (g.ids.some((id) => !g.results.has(id))) return;
  groups.delete(groupId);
  const parts = g.ids.map((id) => ({ a: agents.get(id), r: g.results.get(id) })).filter((x) => x.a && !x.r.aborted);
  if (!parts.length) return; // you stopped them all: your call, the chat is not woken
  const body = parts.map(({ a: m, r: res }) => `${m.name}${m.part ? ` (${oneLine(m.part, 120)})` : ''}: ${res.ok ? 'done' : `did not finish (${res.failed})`}${res.files.length ? `\nFiles: ${res.files.slice(0, 20).join(', ')}` : ''}\n${res.text || '(no report)'}`).join('\n\n---\n\n');
  const names = parts.map((x) => x.a.name);
  wake(g.chatId, `[Automatic message from Codeply, not typed by the user: ${names.length === 1 ? `${names[0]} finished` : `${names.length} background agents finished (${names.join(', ')})`}.]\n\n${body}\n\nReview their work (open the files, run a check if it matters), then answer the user ONCE, in your own voice: what is done, how you checked it, what is left. You may name an agent by its name. Send one back with message_agent if something is wrong.`, names);
}
/** The report as the main agent's next turn, once the chat is free. */
async function wake(chatId, text, names) {
  const s = C.api.find(chatId);
  if (!s) return;
  while (C.api.runs.has(s.id)) await new Promise((r) => setTimeout(r, 1000));
  s.messages.push({ kind: 'notice', level: 'info', text: `${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} done. Codeply is reviewing ${names.length === 1 ? 'the work' : 'their work'}.`, at: Date.now() });
  C.emit(s.id, { type: 'notice', level: 'info', text: `${names.join(', ')} finished` });
  C.api.startRun(s, text, { resume: true }).catch(() => {});
}

function newAgent({ name, chatId, cwd, by, part = '', browser = false, swarmId = '' }) {
  const a = {
    id: `ag${++seq}`, name: uniqueName(name), chatId, cwd: realDir(cwd), look: pickLook(), by, status: 'idle', task: '', part,
    round: 0, startedAt: 0, endedAt: 0, files: [], browser: !!browser, swarmId, cliSession: '', log: [], seq: 0,
    control: null, abort: null, queued: [], group: '',
  };
  agents.set(a.id, a);
  announce(a);
  return a;
}
const byName = (chatId, name) => {
  const n = String(name || '').trim().toLowerCase().replace(/^@/, '');
  return [...agents.values()].filter((a) => a.chatId === chatId).find((a) => a.name.toLowerCase() === n) || null;
};

/** The main agent's start_agents: one agent, or a swarm with a team channel. Returns at once. */
async function startAgents(session, args) {
  const why = await notReady();
  if (why) return { ok: false, output: why };
  const goal = String(args.task || args.goal || '').trim();
  if (!goal) return { ok: false, output: 'start_agents needs <task>: the goal, with everything they need to know.' };
  let list = Array.isArray(args.agents) ? args.agents : [];
  list = list.map((x) => (typeof x === 'string' ? { part: x } : x || {})).map((x) => ({ name: String(x.name || ''), part: String(x.part || x.task || '').trim(), files: Array.isArray(x.files) ? x.files : [] })).slice(0, MAX_GROUP);
  const count = Math.max(1, Math.min(MAX_GROUP, list.length || Number(args.count) || 1));
  while (list.length < count) list.push({ name: '', part: '', files: [] });
  const browser = args.browser === true || args.browser === 'yes';
  const cwd = session.cwd;
  const groupId = `g${Date.now().toString(36)}`;
  let swarmId = '';
  if (count > 1) {
    swarmId = `sw${Date.now().toString(36)}`;
    swarms.set(swarmId, { id: swarmId, chatId: session.id, goal, members: [], messages: [], reads: {} });
  }
  const made = list.map((p) => {
    const part = p.part ? `${p.part}${p.files.length ? ` (files: ${p.files.join(', ')})` : ''}` : '';
    const a = newAgent({ name: p.name, chatId: session.id, cwd, by: 'codeply', part: count > 1 ? part : '', browser, swarmId });
    a.group = groupId;
    if (swarmId) swarms.get(swarmId).members.push(a.id);
    return a;
  });
  if (swarmId) postTeam(swarms.get(swarmId), 'Codeply', `Goal: ${oneLine(goal, 600)}`);
  groups.set(groupId, { chatId: session.id, ids: made.map((a) => a.id), results: new Map() });
  for (const a of made) {
    const task = count > 1 ? (a.part || goal) : goal;
    runRound(a, { task, by: 'codeply' }).then((r) => finishOne(groupId, a, r)).catch(() => {});
  }
  return {
    ok: true,
    output: `Started ${made.length === 1 ? made[0].name : `${made.length} agents: ${made.map((a) => `${a.name}${a.part ? ` (${oneLine(a.part, 80)})` : ''}`).join(', ')}`}. ${made.length === 1 ? 'It works' : 'They work'} in the background (the user watches in Background tasks > Subagents). Do not wait or poll: their report arrives in this chat as an automatic message. Meanwhile keep talking with the user. To redirect one, use message_agent with its name.`,
  };
}

function messageAgent(session, args) {
  const a = byName(session.id, args.agent || args.name);
  if (!a) return { ok: false, output: `No agent called "${args.agent || args.name}" in this chat. Yours: ${[...agents.values()].filter((x) => x.chatId === session.id).map((x) => x.name).join(', ') || 'none'}.` };
  const text = String(args.text || args.message || '').trim();
  if (!text) return { ok: false, output: 'Write the message.' };
  log(a, { t: 'user', by: 'codeply', text, live: a.status === 'working' });
  const how = deliver(a, `[Message from Codeply, who leads you] ${text}`);
  if (how) return { ok: true, output: how === 'live' ? `${a.name} got it while working.` : `${a.name} gets it as soon as its current step ends.` };
  const groupId = `g${Date.now().toString(36)}`;
  groups.set(groupId, { chatId: session.id, ids: [a.id], results: new Map() });
  runRound(a, { task: text, by: 'codeply' }).then((r) => finishOne(groupId, a, r)).catch(() => {});
  return { ok: true, output: `${a.name} started another round on it. Its report arrives here when it is done.` };
}

function stopAgent(a) {
  if (!a || !a.abort) return false;
  a.queued = [];
  log(a, { t: 'sys', text: 'Stopping…' });
  a.abort.abort();
  return true;
}

function promptFor(chatId) {
  const mine = [...agents.values()].filter((a) => a.chatId === chatId);
  const lines = mine.slice(-12).map((a) => `- ${a.name} [${a.status}]: ${oneLine(a.part || a.task, 140)}`);
  return `BACKGROUND AGENTS
You can start Codeply's background agents with start_agents: one agent for a coding job, or a swarm of 2 to 6 on one goal (one part each, split by file, no two on the same file) that share a team channel. With browser: true each gets its own tab in Codeply's browser (to try a site, test a flow, research). They work while you keep talking; their report comes back here as an automatic message, and you review it then. message_agent redirects or interrupts one by name (also when the user tells you to); stop_agent stops one. Use message_agent and stop_agent for these background agents (interrupt_agent and list_agents are only for the subagent tool's helpers). Call them by their names (agents, specialists); never call them Claude, and never say what runs them.${lines.length ? `\nIN THIS CHAT\n${lines.join('\n')}` : ''}`;
}

/** The main agent's tools, from the engine's bridge. */
async function bridge(req, res, reply) {
  const m = /^\/agents(?:\/(start_agents|message_agent|stop_agent))?$/.exec(req.url || '');
  if (!m) return false;
  let body = {};
  try { body = JSON.parse(await C.readBody(req)); } catch {}
  const turn = C.api.turnOf(String(body.chatId || ''));
  const session = turn && turn.session;
  if (!m[1]) return reply(200, session ? { enabled: true, prompt: promptFor(session.id) } : { enabled: false }), true;
  if (!session) return reply(200, { ok: false, output: 'Background agents are not available in this chat.' }), true;
  const args = body.args && typeof body.args === 'object' ? body.args : {};
  let r;
  try {
    if (m[1] === 'start_agents') r = await startAgents(session, args);
    else if (m[1] === 'message_agent') r = messageAgent(session, args);
    else {
      const a = byName(session.id, args.agent || args.name);
      r = !a ? { ok: false, output: `No agent called "${args.agent || args.name}" in this chat.` } : stopAgent(a) ? { ok: true, output: `Stopped ${a.name}.` } : { ok: true, output: `${a.name} was not working.` };
    }
  } catch (e) { r = { ok: false, output: `${m[1]} failed: ${e && e.message ? e.message : e}` }; }
  reply(200, r);
  return true;
}

// ---------- the extension ----------
export async function start(ctx) {
  C = ctx;
  load();
  C.bridgeRoutes.push(bridge);
  runtimeStatus().catch(() => {});
}

export async function route(ctx, req, res, url, p, reply) {
  // Exactly /ext/agents or below it: a bare prefix also matched /ext/agentsync and ate its request body.
  if (p !== '/ext/agents' && !p.startsWith('/ext/agents/')) return false;
  if (req.method === 'GET' && p === '/ext/agents') {
    const st = await runtimeStatus().catch(() => null);
    reply(200, {
      ready: !!(st && st.installed && st.loggedIn), why: await notReady(),
      agents: [...agents.values()].map((a) => ({ ...summary(a), log: a.log.slice(-300) })),
      swarms: [...swarms.values()].map(swarmView),
    });
    return true;
  }
  if (req.method !== 'POST') return false;
  const body = await ctx.readJson(req).catch(() => ({}));
  const a = agents.get(String(body.id || ''));
  if (p === '/ext/agents/send') {
    if (!a) return reply(404, { ok: false, error: 'That agent is gone.' }), true;
    const text = String(body.text || '').trim();
    if (!text) return reply(400, { ok: false, error: 'Write a message.' }), true;
    log(a, { t: 'user', by: 'you', text, live: a.status === 'working' });
    const how = deliver(a, `[The user writes to you directly] ${text}`);
    if (!how) {
      const why = await notReady();
      if (why) { log(a, { t: 'sys', tone: 'warn', text: why }); return reply(200, { ok: false, error: why }), true; }
      runRound(a, { task: text, by: 'you' }).catch(() => {});
    } else if (how === 'queued') announce(a);
    return reply(200, { ok: true, how: how || 'round' }), true;
  }
  if (p === '/ext/agents/stop') return reply(200, { ok: stopAgent(a) }), true;
  if (p === '/ext/agents/remove') {
    if (a && a.status === 'working') return reply(400, { ok: false, error: 'Stop it first.' }), true;
    if (a) { agents.delete(a.id); for (const [k, id] of keys) if (id === a.id) keys.delete(k); ctx.emit(a.chatId || null, { type: 'subagent_removed', agentId: a.id }); save(); }
    return reply(200, { ok: true }), true;
  }
  if (p === '/ext/agents/team') {
    const s = swarms.get(String(body.swarmId || ''));
    const text = String(body.text || '').trim();
    if (!s || !text) return reply(400, { ok: false, error: !s ? 'That team is gone.' : 'Write a message.' }), true;
    postTeam(s, 'You', text);
    // The ones still working read it next, and the ones listening get it at once.
    for (const id of s.members) { const m = agents.get(id); if (m && m.status === 'working') deliver(m, `[The user, on the team channel] ${text}`); }
    return reply(200, { ok: true }), true;
  }
  if (p === '/ext/agents/browser') {
    const done = browserWaits.get(String(body.reqId || ''));
    if (done) done({ ok: !!body.ok, text: String(body.text || (body.ok ? 'Done.' : 'It did not work.')).slice(0, 60000) });
    return reply(200, { ok: !!done }), true;
  }
  return false;
}

// For tests.
export const _internal = { agents, swarms, startAgents, messageAgent, stopAgent, act, promptFor, stepName, clean, groups };
