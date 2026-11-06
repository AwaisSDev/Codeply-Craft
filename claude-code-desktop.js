// Claude Code on the desktop: the user's own Claude plan as background coding
// agents that Wisp briefs, watches and reviews, and that the user can drive
// themselves from the Claude panel.
//
//   - Connect Apps has a Claude Code card: Install (runs the official
//     installer in Codeply's terminal), Log in (runs `claude auth login`, which
//     opens the browser; Claude Code saves the login itself, so it stays signed
//     in), Log out, the default model, effort and what it may do on its own.
//   - Agents: each is one Claude Code session with a name (Claude, Claude 2...).
//     Wisp starts them with its claude_code tool (one approval per chat and
//     folder, where the user can also pick the model and effort); the user can
//     start more from the Claude panel's + tab. Several run at once.
//   - An agent works in the background: the chat stays free. Its steps stream
//     to the Claude panel (claude-code-ui.js) as a terminal-like log, and the
//     user can type to it while it works (Claude Code's streaming input). When
//     a round Wisp started finishes, its report goes back to the chat as an
//     automatic message, and Wisp reviews it (deps.wake).
//   - The Claude session id is kept per agent on the chat, so the next round
//     resumes it and Claude remembers the earlier work.
//
// Codeply's taste guide and the skills that fit the task go to Claude Code on
// top of its own prompt (codeply-cli/lib/claude-code.js systemAppend).
const fs = require('fs');
const os = require('os');
const path = require('path');

// { ipcMain, cliDir, sendEvent, sendWindow(channel, data), recordToolEnd, store: { get(), set(patch) },
//   findSession(id), saveSession(session), wake(sessionId, text, credit) }
let deps = null;
let lib = null;
const cc = () => { if (!lib) lib = require(path.join(deps.cliDir, 'lib', 'claude-code.js')); return lib; };

const CARD = { id: 'claude-code', name: 'Claude Code', focus: 'Coding agent on your Claude plan', shape: 'star', color: '#d97757', builtin: true, kind: 'claude' };
const LEVELS = ['edits', 'dev', 'full'];
const STATUS_TTL = 10 * 60 * 1000;
const LOG_MAX = 800;

let cached = { at: 0, status: null };
let refreshing = null;
let loginRun = null;

function settings() {
  const s = (deps && deps.store.get()) || {};
  return {
    enabled: s.enabled !== false,
    model: cc().normalizeModel(s.model) || 'default',
    effort: cc().normalizeEffort(s.effort) || 'default',
    level: LEVELS.includes(s.level) ? s.level : 'dev',
  };
}

/** Claude Code's login state, refreshed in the background when it is old. */
function refresh() {
  if (refreshing) return refreshing;
  refreshing = cc().status({ refresh: true })
    .then((st) => { cached = { at: Date.now(), status: st }; return st; })
    .catch((e) => { cached = { at: Date.now(), status: { installed: false, loggedIn: false, error: e.message } }; return cached.status; })
    .finally(() => { refreshing = null; });
  return refreshing;
}

function current() {
  if (!cached.status || Date.now() - cached.at > STATUS_TTL) refresh().catch(() => {});
  return cached.status;
}

/** What Wisp's prompt says about Claude Code, or null while it is turned off. */
function promptState() {
  if (!deps || !settings().enabled) return null;
  const st = current();
  if (!st) return null; // first check still running: say nothing rather than something wrong
  const conf = settings();
  return {
    ready: !!(st.installed && st.loggedIn), installed: !!st.installed, plan: st.plan || '', email: st.email || '',
    model: conf.model, modelLabel: cc().modelLabel(conf.model), effort: conf.effort, effortLabel: cc().effortLabel(conf.effort),
  };
}

function ready() { const p = promptState(); return !!(p && p.ready); }

function publicState(st) {
  const s = st || cached.status || {};
  return {
    installed: !!s.installed, loggedIn: !!s.loggedIn, email: s.email || '', plan: s.plan || '', org: s.org || '',
    authMethod: s.authMethod || '', version: s.version || '', error: s.error || '',
    installCommand: cc().installCommand(), loggingIn: !!loginRun, settings: settings(),
    modelChoices: cc().MODEL_CHOICES, effortChoices: cc().EFFORT_CHOICES,
    working: [...agents.values()].filter((a) => a.status === 'working').length,
  };
}

// ─── The terminal mirror ────────────────────────────────────────────────────
const ESC = '\x1b[';
const C = { claude: `${ESC}38;5;173m`, dim: `${ESC}2m`, ok: `${ESC}32m`, bad: `${ESC}31m`, off: `${ESC}0m` };
function term(text) { try { deps.sendWindow('terminal:data', String(text).replace(/\r?\n/g, '\r\n')); } catch {} }
/** A folder's long, real form (C:\Users\ADMINI~1 -> C:\Users\Administrator), so paths compare and read the same everywhere. */
const realDir = (d) => { try { return fs.realpathSync.native(d); } catch { return d; } };
const oneLine = (s, n = 140) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

/** The skills Claude Code gets: Codeply taste for visual work, plus the few that match the task. */
function skillsFor(task, cwd) {
  let skillsLib;
  try { skillsLib = require(path.join(deps.cliDir, 'lib', 'skills.js')); } catch { return { taste: null, skills: [], dirs: [] }; }
  let all = [];
  try { all = skillsLib.listSkills(cwd); } catch {}
  // Taste goes to every job, visual or not: it lives in the system prompt
  // Claude Code caches, and one fixed prompt is cheaper than two that each miss.
  let taste = null;
  const tasteSkill = all.find((s) => s.name === 'codeply-taste');
  if (tasteSkill) {
    try { taste = { dir: tasteSkill.dir, body: fs.readFileSync(path.join(tasteSkill.dir, 'SKILL.md'), 'utf8') }; } catch {}
  }
  const skip = new Set(['codeply-taste', 'publish-website', 'taste']); // taste goes in whole; publishing is Codeply's
  let picked = [];
  try { picked = skillsLib.findRelevantSkills(task, all, { limit: 6 }).filter((s) => !skip.has(s.name)).slice(0, 4); } catch {}
  const skills = picked.map((s) => ({ name: s.name, description: s.description, file: path.join(s.dir, 'SKILL.md'), dir: s.dir }));
  const dirs = [taste && taste.dir, ...skills.map((s) => s.dir)].filter(Boolean);
  return { taste, skills, dirs };
}

/** The system prompt addition, one file per content so Claude Code's prompt cache keeps hitting. */
function appendFileFor(taste, level) {
  try {
    const text = cc().systemAppend({ taste, level });
    const dir = path.join(os.tmpdir(), 'codeply-claude');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `system-${require('crypto').createHash('sha1').update(text).digest('hex').slice(0, 12)}.md`);
    if (!fs.existsSync(file)) fs.writeFileSync(file, text, 'utf8');
    return file;
  } catch { return ''; }
}

// ─── Agents ─────────────────────────────────────────────────────────────────
// One agent = one Claude Code session in one folder. In memory while the app
// runs; the ones a chat started are also kept on the chat (session.claudeAgents)
// so Wisp can send them back after a restart.
const agents = new Map(); // id -> agent
let agentSeq = 0;

// Agents and their logs are kept between runs of the app (userData/claude-agents.json),
// so Background tasks still shows them, and what each did, after a restart.
const AGENTS_FILE = () => (deps && deps.dataDir ? path.join(deps.dataDir, 'claude-agents.json') : '');
let saveTimer = null;
function saveAgents() {
  if (!AGENTS_FILE() || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const keep = [...agents.values()].filter((a) => a.log.length || a.status === 'working').sort((x, y) => (x.endedAt || x.startedAt || 0) - (y.endedAt || y.startedAt || 0)).slice(-30);
    const out = keep.map((a) => ({
      id: a.id, name: a.name, chatId: a.chatId, cwd: a.cwd, claudeSession: a.claudeSession, model: a.model, effort: a.effort, level: a.level,
      status: a.status, round: a.round, startedAt: a.startedAt, endedAt: a.endedAt, by: a.by, task: a.task, files: a.files, skills: a.skills,
      approved: a.approved, look: a.look, bare: !!a.bare, browser: !!a.browser, liveModel: a.liveModel, seq: a.seq,
      swarm: a.swarm ? { id: a.swarm.id, goal: a.swarm.goal, dir: a.swarm.dir, board: a.swarm.board, notes: a.swarm.notes, team: a.swarm.team, part: a.swarm.part, files: a.swarm.files, browser: !!a.swarm.browser, url: a.swarm.url } : null,
      log: a.log.slice(-300),
    }));
    try { fs.writeFileSync(AGENTS_FILE(), JSON.stringify(out), 'utf8'); } catch {}
  }, 800);
}
function loadAgents() {
  let list = [];
  try { list = JSON.parse(fs.readFileSync(AGENTS_FILE(), 'utf8')); } catch { return; }
  for (const s of Array.isArray(list) ? list : []) {
    if (!s || !s.id || agents.has(s.id)) continue;
    const n = Number(String(s.id).replace(/\D/g, '')) || 0;
    if (n > agentSeq) agentSeq = n;
    agents.set(s.id, {
      ...s, files: s.files || [], skills: s.skills || [], log: Array.isArray(s.log) ? s.log : [], seq: s.seq || (s.log ? s.log.length : 0),
      // A run that was going when the app closed is over: Claude Code stopped with it.
      status: s.status === 'working' ? 'stopped' : s.status || 'idle',
      control: null, abort: null, queued: [], browserKey: null,
    });
  }
}

// Each agent is one of Wisp's family (wisp.js draws it): its own random mix of
// shape, colour and gear, so parallel agents are easy to tell apart. Codeply's
// own palette and gear; Wisp's blue pentagon stays Wisp's.
const LOOK_SHAPES = ['hexagon', 'star', 'square', 'circle', 'spiky', 'cloud', 'blob', 'triangle'];
const LOOK_COLORS = ['#1f8bff', '#86d41f', '#ffbe0b', '#ff2fa8', '#ff6b2c', '#8f5bff', '#00c2a8', '#ff3b5c', '#22b8f0', '#c45cff', '#2fd36b', '#ff9f1c'];
const LOOK_GEAR = ['cap', 'headphones', 'crown', 'sprout', 'antennae', 'star', 'flower', 'glasses', 'shades', ''];
const pick = (list) => list[Math.floor(Math.random() * list.length)];
/** A fresh look, unlike any agent's that is still around. */
function pickLook() {
  const worn = new Set([...agents.values()].map((a) => a.look && `${a.look.shape}|${a.look.color}`));
  const usedColors = new Set([...agents.values()].map((a) => a.look && a.look.color));
  for (let i = 0; i < 40; i++) {
    const look = { shape: pick(LOOK_SHAPES), color: pick(LOOK_COLORS), gear: pick(LOOK_GEAR) };
    if (worn.has(`${look.shape}|${look.color}`)) continue;
    if (i < 20 && usedColors.has(look.color)) continue; // a colour of its own while there are some left
    return look;
  }
  return { shape: pick(LOOK_SHAPES), color: pick(LOOK_COLORS), gear: pick(LOOK_GEAR) };
}

function summary(a) {
  return {
    id: a.id, name: a.name, chatId: a.chatId || '', cwd: a.cwd, folder: path.basename(a.cwd || '') || a.cwd || '',
    model: a.model, modelLabel: cc().modelLabel(a.liveModel || a.model), effort: a.effort,
    effortLabel: a.effort && a.effort !== 'default' ? cc().effortLabel(a.effort) : '',
    level: a.level, status: a.status, round: a.round, startedAt: a.startedAt, endedAt: a.endedAt, by: a.by,
    actualModel: a.liveModel ? cc().modelLabel(a.liveModel) : '', look: a.look,
    swarm: a.swarm ? { id: a.swarm.id, size: a.swarm.team.length, browser: !!a.swarm.browser } : null,
    task: oneLine(a.task, 240), files: a.files.length, live: !!(a.control && a.control.send && a.status === 'working'),
    queued: a.queued.length,
  };
}
function emit(data) { try { deps.sendWindow('claudeCode:agent', data); } catch {} }
function announce(a) { emit({ kind: 'agent', agent: summary(a) }); saveAgents(); }
function log(a, entry) {
  const e = { id: `e${++a.seq}`, at: Date.now(), ...entry };
  a.log.push(e);
  if (a.log.length > LOG_MAX) a.log.splice(0, a.log.length - LOG_MAX);
  emit({ kind: 'log', agentId: a.id, entry: e });
  saveAgents();
  return e;
}
function patchEntry(a, id, p) {
  const e = a.log.find((x) => x.id === id);
  if (e) Object.assign(e, p);
  emit({ kind: 'patch', agentId: a.id, id, patch: p });
}

// Names of their own, like teammates (a name Wisp or the user gives wins).
const NAMES = ['Nova', 'Pico', 'Maple', 'Ziggy', 'Bolt', 'Echo', 'Taro', 'Lumi', 'Kiwi', 'Remy', 'Sol', 'Nori', 'Fern', 'Jett', 'Basil', 'Indigo'];
function uniqueName(want) {
  const taken = new Set([...agents.values()].map((a) => a.name.toLowerCase()));
  if (!oneLine(want, 32)) {
    const free = NAMES.filter((n) => !taken.has(n.toLowerCase()));
    if (free.length) return free[Math.floor(Math.random() * free.length)];
  }
  const base = oneLine(want, 32) || 'Agent';
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}

function newAgent({ name, chatId, cwd, model, effort, level, by, saved }) {
  const a = {
    id: `cc${++agentSeq}`, name: saved ? saved.name : uniqueName(name), chatId: chatId || '', cwd: realDir(cwd),
    claudeSession: (saved && saved.sessionId) || '', model: model || 'default', effort: effort || 'default', level: level || 'dev',
    status: 'idle', round: (saved && saved.round) || 0, startedAt: 0, endedAt: (saved && saved.lastAt) || 0, by: by || 'wisp',
    task: '', log: [], seq: 0, control: null, abort: null, queued: [], files: [], skills: (saved && saved.skills) || [],
    approved: !!(saved && saved.approved), liveModel: '',
    look: saved && saved.look && LOOK_SHAPES.includes(saved.look.shape) && LOOK_COLORS.includes(saved.look.color) ? saved.look : pickLook(),
  };
  agents.set(a.id, a);
  if (!saved) announce(a); // one brought back from a chat shows once it works again
  return a;
}

/** Keeps a chat's agents on the chat, so a later round resumes the same Claude session. */
function persist(a) {
  if (!a.chatId || !deps.findSession) return;
  const session = deps.findSession(a.chatId);
  if (!session) return;
  const list = Array.isArray(session.claudeAgents) ? session.claudeAgents.filter((x) => x.name !== a.name) : [];
  list.push({ name: a.name, sessionId: a.claudeSession, cwd: a.cwd, round: a.round, skills: a.skills, approved: a.approved, model: a.model, effort: a.effort, look: a.look, lastAt: a.endedAt || Date.now() });
  session.claudeAgents = list.slice(-12);
  try { deps.saveSession(session); } catch {}
}

/** This chat's agents: the live ones, plus the ones kept on the chat from earlier runs. */
function agentsForChat(session) {
  const live = [...agents.values()].filter((a) => a.chatId === session.id);
  const saved = Array.isArray(session.claudeAgents) ? [...session.claudeAgents] : [];
  // The single session of earlier versions.
  if (session.claudeCode && session.claudeCode.sessionId && !saved.some((s) => s.sessionId === session.claudeCode.sessionId)) {
    saved.push({ name: 'Claude', sessionId: session.claudeCode.sessionId, cwd: session.claudeCode.cwd, round: session.claudeCode.round, skills: session.claudeCode.skills || [], approved: !!session.claudeCode.approved, lastAt: session.claudeCode.lastAt });
  }
  for (const s of saved) {
    if (live.some((a) => a.name.toLowerCase() === String(s.name).toLowerCase())) continue;
    if ([...agents.values()].some((a) => a.name.toLowerCase() === String(s.name).toLowerCase())) continue; // name taken elsewhere now
    live.push(newAgent({ chatId: session.id, cwd: s.cwd, model: s.model, effort: s.effort, by: 'wisp', saved: s }));
  }
  return live;
}

/**
 * One round of an agent: Claude Code works until it reports. Resolves to
 * { ok, text, actions, files, removed, denials, sessionId, round, cached, costUsd, failed, auth, aborted, agent }.
 * mirror: also show its steps as rows in the chat (the old wait-for-it way).
 */
async function runRound(a, { task, chat = '', by = 'wisp', session = null, mirror = false, signal = null }) {
  const resume = a.claudeSession || '';
  a.round += 1;
  const round = a.round;
  Object.assign(a, { task, by, startedAt: Date.now(), endedAt: 0, files: [], liveModel: a.liveModel });
  const ac = new AbortController();
  const control = {};
  a.abort = ac; a.control = control;
  if (signal) { if (signal.aborted) ac.abort(); else signal.addEventListener('abort', () => ac.abort(), { once: true }); }
  a.status = 'working';
  announce(a);
  log(a, { t: 'user', text: task, by, round });

  // A bare agent gets exactly the words: no chat, no skills, no Codeply guide (the user asked for that).
  const { taste, skills, dirs } = a.bare ? { taste: null, skills: [], dirs: [] } : skillsFor(task, a.cwd);
  // Skills already named on an earlier round are in Claude's context; only new ones are listed again.
  const named = new Set(resume ? a.skills : []);
  const fresh = skills.filter((s) => !named.has(s.name));
  const brief = a.bare ? task
    : by === 'user' && resume
      ? `THE USER WRITES TO YOU DIRECTLY (from Codeply's Claude panel):\n${task}${fresh.length ? `\n\n${cc().skillsNote(fresh)}` : ''}`
      : cc().buildPrompt({ task, chat: resume ? '' : chat, round: resume ? Math.max(2, round) : 1, skills: fresh });
  const appendFile = a.bare ? '' : appendFileFor(a.swarm && a.swarm.browser ? null : taste, a.level);
  const systemPrompt = a.bare ? BARE_SYSTEM : '';
  // A swarm member: who it works with, its part, and how they coordinate, on top of the task.
  const swarmBrief = a.swarm && !(by === 'user' && resume) ? `${swarmText(a)}\n\n` : '';
  const prompt = a.swarm && !resume ? `${swarmBrief}${a.swarm.part ? '' : `THE GOAL\n${task}`}`.trim() : `${swarmBrief}${brief}`;
  // Codeply's browser as its hands (codeply-browser MCP), with its own cursor colour on the page.
  let mcpConfig = '';
  if ((a.browser || (a.swarm && a.swarm.browser)) && deps.browser) {
    try {
      if (!a.browserKey) a.browserKey = deps.browser.register({ name: a.name, color: a.look && a.look.color, swarmId: a.swarm ? a.swarm.id : '' });
      mcpConfig = await deps.browser.mcpConfigFor(a.browserKey, { cliDir: deps.cliDir, dir: path.join(os.tmpdir(), 'codeply-claude') });
    } catch (e) { log(a, { t: 'sys', tone: 'warn', text: `Codeply's browser is not available: ${e.message}` }); }
  }

  const card = { ...CARD, name: a.name, round, look: a.look };
  if (session) {
    const startMsg = { kind: 'wisp_agent', phase: 'start', agent: card, task: oneLine(task, 600), agentId: a.id };
    session.messages.push({ ...startMsg, at: Date.now() });
    deps.sendEvent(session.id, { type: 'wisp_agent', ...startMsg });
  }
  term(`\n${C.claude}✳ ${a.name}${C.off} ${C.dim}round ${round}${resume ? ' (resumed)' : ''} in ${a.cwd}${C.off}\n${C.dim}${oneLine(task, 200)}${C.off}\n`);

  const before = cc().snapshot(a.cwd);
  const pending = new Map(); // tool_use id -> { name, args, label, entry }
  const actions = [];
  const denials = [];
  let result = null;
  let lastText = '';
  for (let attempt = 0; attempt < 2; attempt++) {
  // One Claude Code starts at a time: each waits for the one before it to sign in,
  // so parallel agents never refresh the shared Claude login at the same moment.
  const release = await startTurn();
  try {
    const runIt = cc().run({ cwd: a.cwd, prompt, resume: a.claudeSession || resume, model: a.model, effort: a.effort, level: a.level, appendFile, systemPrompt, mcpConfig, strictMcp: !!a.swarm, allowMore: mcpConfig ? ['mcp__codeply-browser'] : [], addDirs: dirs, signal: ac.signal, control });
    for await (const ev of runIt) {
      if (ev.type === 'init') {
        release();
        if (ev.sessionId) a.claudeSession = ev.sessionId;
        if (ev.model && ev.model !== a.liveModel) { a.liveModel = ev.model; announce(a); }
      } else if (ev.type === 'text') {
        if (ev.sub) continue;
        lastText = ev.text;
        log(a, { t: 'text', text: ev.text });
        if (mirror && session) {
          session.messages.push({ kind: 'assistant', text: ev.text, interim: true, agent: CARD.id, at: Date.now() });
          deps.sendEvent(session.id, { type: 'text', text: ev.text, interim: true, agent: CARD.id });
        }
      } else if (ev.type === 'thinking') {
        if (!ev.sub) log(a, { t: 'think', text: oneLine(ev.text, 600) });
      } else if (ev.type === 'tool_start') {
        const t = cc().asCodeplyTool(ev.name, ev.input, a.cwd);
        const label = cc().labelOf(t);
        const entry = log(a, { t: 'tool', name: ev.name, label, status: 'run', sub: !!ev.sub });
        pending.set(ev.id, { ...t, label, entry: entry.id });
        if (mirror && session) deps.sendEvent(session.id, { type: 'tool_start', name: t.name, args: t.args, agent: CARD.id });
      } else if (ev.type === 'tool_end') {
        const t = pending.get(ev.id);
        if (!t) continue;
        pending.delete(ev.id);
        const exitCode = t.name === 'run' ? cc().exitCodeOf(ev.output, ev.ok) : undefined;
        const outText = String(ev.output || '');
        const shown = outText.split(/\r?\n/).filter((l) => l.trim()).slice(0, 4).map((l) => l.slice(0, 240)).join('\n');
        patchEntry(a, t.entry, { status: ev.ok ? 'ok' : 'fail', out: shown, more: Math.max(0, outText.split(/\r?\n/).filter((l) => l.trim()).length - 4), exitCode });
        if (mirror && session && (!ev.sub || ['edit_file', 'write_file', 'run'].includes(t.name))) {
          const tail = t.name === 'run' ? outText.slice(-1500) : undefined;
          const out = {
            type: 'tool_end', name: t.name, args: t.args, ok: ev.ok, summary: t.label,
            meta: { label: t.label, ...(exitCode !== undefined ? { exitCode } : {}), ...(tail ? { output: tail } : {}) },
            error: ev.ok ? undefined : outText.slice(0, 800),
          };
          deps.recordToolEnd(session, out, { agent: CARD.id });
          deps.sendEvent(session.id, { ...out, agent: CARD.id });
        }
        actions.push({ tool: t.name, label: t.label, ok: ev.ok, ...(exitCode !== undefined ? { exitCode } : {}), by: a.name });
        if (ev.ok && ['edit_file', 'write_file'].includes(t.name) && t.label && !a.files.includes(t.label)) { a.files.push(t.label); announce(a); }
      } else if (ev.type === 'denied') {
        denials.push({ tool: ev.tool, reason: ev.reason });
        log(a, { t: 'sys', tone: 'warn', text: `Not allowed: ${ev.tool}${ev.reason ? ` (${oneLine(ev.reason, 140)})` : ''}` });
      } else if (ev.type === 'turn_end') {
        if (ev.sessionId) a.claudeSession = ev.sessionId;
      } else if (ev.type === 'result') {
        result = ev;
        if (ev.sessionId) a.claudeSession = ev.sessionId;
      }
    }
  } catch (e) {
    result = { ok: false, error: e.message || String(e), denials: [] };
  } finally {
    release();
  }
  // Signed out mid-start: often another Claude Code was just renewing the login.
  // Once the login checks out again, one more try, before calling it an error.
  if (attempt === 0 && result && result.auth && !ac.signal.aborted && !actions.length) {
    log(a, { t: 'sys', text: 'The Claude sign-in was renewing. Trying again…' });
    await new Promise((r) => setTimeout(r, 3000));
    const again = await refresh().catch(() => null);
    if (again && again.loggedIn && !ac.signal.aborted) { result = null; continue; }
  }
  break;
  }
  a.control = null;
  a.abort = null;

  if (result && result.auth) { cached = { at: 0, status: null }; refresh().catch(() => {}); }
  const aborted = !!(result && result.aborted) || ac.signal.aborted;
  const ok = !!(result && result.ok) && !aborted;
  const failed = ok ? '' : aborted ? 'stopped by the user' : (result && result.error) || 'Claude Code stopped';
  const text = String((result && result.text) || lastText || '').trim();
  // What it was not allowed to do, one line each: the result's list has the commands, the live events the reasons.
  const fromResult = ((result && result.denials) || []).map((d) => (d.input && d.input.command ? `${d.tool}: ${oneLine(d.input.command, 160)}` : d.tool));
  const notAllowed = [...new Set(fromResult.length ? fromResult : denials.map((d) => `${d.tool}${d.reason ? ` (${oneLine(d.reason, 120)})` : ''}`))].slice(0, 12);

  // Files changed by shell commands too (echo > file, generators): the folder before and after says.
  const disk = cc().diffSnapshots(before, cc().snapshot(a.cwd));
  const viaTools = new Set(actions.filter((x) => x.ok && ['edit_file', 'write_file'].includes(x.tool)).map((x) => x.label));
  for (const f of disk.added) if (!viaTools.has(f)) actions.push({ tool: 'write_file', label: f, ok: true, by: a.name, via: 'shell' });
  for (const f of disk.changed) if (!viaTools.has(f)) actions.push({ tool: 'edit_file', label: f, ok: true, by: a.name, via: 'shell' });
  const files = [...new Set(actions.filter((x) => x.ok && ['edit_file', 'write_file'].includes(x.tool)).map((x) => x.label).filter(Boolean))];
  a.files = files;
  a.skills = [...new Set([...named, ...skills.map((s) => s.name)])];
  a.endedAt = Date.now();
  a.status = ok ? 'done' : aborted ? 'stopped' : 'failed';
  const cachedShare = cc().cacheShare(result && result.usage);
  log(a, {
    t: 'done', ok, aborted, text: ok ? '' : failed, files: files.slice(0, 30), turns: (result && result.turns) || 0,
    costUsd: result && typeof result.costUsd === 'number' ? result.costUsd : null, ms: a.endedAt - a.startedAt,
    cached: cachedShare,
  });
  announce(a);
  persist(a);

  if (session) {
    const checks = actions.filter((x) => x.tool === 'run').map((x) => ({ tool: 'run', label: x.label, ok: x.ok, exitCode: x.exitCode }));
    const report = { phase: 'report', agent: card, agentId: a.id, text: text || (failed ? `Couldn't finish: ${failed}` : 'Done.'), ok, files: files.map((f) => f.split('/').pop()), checks: checks.slice(-10), costUsd: result && result.costUsd, turns: result && result.turns };
    session.messages.push({ kind: 'wisp_agent', ...report, at: Date.now() });
    session.updatedAt = Date.now();
    deps.sendEvent(session.id, { type: 'wisp_agent', ...report });
    try { deps.saveSession(session); } catch {}
  }
  term(ok
    ? `${C.ok}✓ ${a.name} finished${C.off} ${C.dim}${files.length} file${files.length === 1 ? '' : 's'} changed${result && result.turns ? `, ${result.turns} turns` : ''}${cachedShare != null ? `, ${Math.round(cachedShare * 100)}% of input from cache` : ''}${C.off}\n`
    : `${C.bad}✗ ${a.name} did not finish:${C.off} ${oneLine(failed, 200)}\n`);

  const out = { ok, text, actions, files, removed: disk.removed.slice(0, 40), denials: notAllowed, sessionId: a.claudeSession, round, cached: cachedShare, costUsd: result && result.costUsd, failed, auth: !!(result && result.auth), aborted, agent: summary(a) };

  // Messages the user typed after Claude stopped listening: the next round, straight away.
  if (a.queued.length && !aborted) {
    const next = a.queued.splice(0).join('\n\n');
    setTimeout(() => { runRound(a, { task: next, by: 'user' }).catch(() => {}); }, 50);
  } else {
    a.queued = [];
  }
  return out;
}

// The start line: Claude Code processes start one after another (each until it has
// signed in or 2.5 s have passed), never all at once.
let startLine = Promise.resolve();
function startTurn() {
  let done;
  const mine = new Promise((r) => { done = r; });
  const prev = startLine;
  startLine = prev.then(() => mine);
  return prev.then(() => {
    const t = setTimeout(() => done(), 2500);
    let freed = false;
    return () => { if (!freed) { freed = true; clearTimeout(t); done(); } };
  });
}

// ─── Swarms: several agents on one task ───────────────────────────────────────
// A swarm shares a board in the project (.codeply/swarm/<id>/): board.md with
// the goal and who does what, and one notes file per agent. Each agent writes
// only its own notes and its own files and reads the others', so they work on
// one thing together without ever editing the same file. With the browser,
// they share a tab in Codeply's browser, each with its own cursor.
const slug = (s) => String(s || 'agent').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent';

function swarmText(a) {
  const sw = a.swarm;
  const team = sw.team.map((m) => `- ${m.name}${m.name === a.name ? ' (you)' : ''}: ${m.part || 'claims a part (see its notes)'}${m.files && m.files.length ? `. Files: ${m.files.join(', ')}` : ''}. Notes: ${m.notes}`).join('\n');
  const lines = [
    `YOU ARE ${a.name.toUpperCase()}, ONE OF A SWARM OF ${sw.team.length} AGENTS`,
    `Codeply started ${sw.team.length} agents on one shared goal. You all work at the same time, in this folder.`,
    '',
    `THE GOAL\n${sw.goal}`,
    '',
    sw.part ? `YOUR PART\n${sw.part}${sw.files && sw.files.length ? `\nFiles that are yours: ${sw.files.join(', ')}` : ''}` : 'YOUR PART\nNot assigned: claim one (see below).',
    '',
    `THE TEAM\n${team}`,
    '',
    'HOW THE SWARM WORKS',
    `- The board is ${sw.board}: the goal and who does what. Your notes file is ${sw.notes}.`,
    '- Before you start, and every few steps, read your teammates\' notes files: what each has done, the files they made, what they need from you.',
    '- Write short lines to YOUR notes file only (add to the end): what you finished, files you made, what you need from whom. Never edit another agent\'s notes, and never edit a file a teammate owns or made: write the request in your notes instead.',
    '- A file that combines everyone\'s work (a page, an index) is edited only by the agent whose part names it. The others make their piece in their own files and say in their notes how to wire it in.',
    '- When your part is done, add a last line "DONE: <one line>" to your notes, then give your report.',
  ];
  if (!sw.part) lines.push('- Parts are not assigned. First read every teammate\'s notes. Pick a part of the goal nobody has claimed, write "CLAIM: <the part>" as the first line of your notes right away, then do it. If everything is claimed, help where a teammate\'s notes ask for it.');
  if (sw.browser) {
    lines.push('', `CODEPLY'S BROWSER\nYou have Codeply's browser through the codeply-browser tools (browser_open, browser_look, browser_click, browser_type, browser_keys, browser_scroll, browser_back). The user watches it: your cursor is ${a.look && a.look.color ? `${a.look.color} ` : ''}and labelled ${a.name}. The swarm shares one tab${sw.url ? `, which starts at ${sw.url}` : ''}: don't take it to another page while a teammate is working on it; use new_tab for a page of your own. Look before you click, and click by element number.`);
  }
  return lines.join('\n');
}

/** Starts a swarm: one board, one agent per part, all at once. Returns their summaries. */
function startSwarm({ chatId, cwd, goal, parts, browser, url, model, effort, by }) {
  const conf = settings();
  const id = `sw${Date.now().toString(36)}`;
  const dir = path.join(cwd, '.codeply', 'swarm', id);
  fs.mkdirSync(dir, { recursive: true });
  const members = parts.map((p) => {
    const a = newAgent({ name: p.name || '', chatId, cwd, model: model || conf.model, effort: effort || conf.effort, level: conf.level, by });
    a.approved = true;
    return { a, part: p.part || '', files: p.files || [] };
  });
  const team = members.map((m) => ({ name: m.a.name, part: m.part, files: m.files, notes: path.join(dir, `${slug(m.a.name)}.md`), color: m.a.look && m.a.look.color }));
  const board = path.join(dir, 'board.md');
  fs.writeFileSync(board, `# Swarm ${id}\n\n## Goal\n${goal}\n\n## Team\n${team.map((t) => `- **${t.name}** (${t.color || ''}): ${t.part || 'claims a part'}${t.files.length ? ` | files: ${t.files.join(', ')}` : ''} | notes: ${path.basename(t.notes)}`).join('\n')}\n${browser ? `\n## Browser\nThe swarm shares one tab in Codeply's browser${url ? `, starting at ${url}` : ''}.\n` : ''}`, 'utf8');
  for (const t of team) if (!fs.existsSync(t.notes)) fs.writeFileSync(t.notes, `# ${t.name}'s notes\n${t.part ? `\nPart: ${t.part}\n` : ''}\n`, 'utf8');
  for (const [i, m] of members.entries()) {
    m.a.swarm = { id, goal, dir, board, notes: team[i].notes, team, part: m.part, files: m.files, browser: !!browser, url: url || '' };
    announce(m.a);
  }
  if (browser && url && deps.browser) {
    // The shared tab opens on the start page before anyone works in it.
    const lead = members[0].a;
    lead.browserKey = deps.browser.register({ name: lead.name, color: lead.look && lead.look.color, swarmId: id });
    deps.browser.act(lead.browserKey, 'open', { url }).catch(() => {});
  }
  return { id, dir, members };
}

const parsePart = (line, i) => {
  const m = /^\s*([A-Za-z][\w .'-]{0,23}?)\s*:\s*(.+)$/.exec(line);
  let name = m ? m[1].trim() : '';
  let rest = m ? m[2] : line;
  if (/^(part|task|step|agent)\s*\d*$/i.test(name)) name = '';
  let files = [];
  const f = /\|\s*files?\s*:\s*(.+)$/i.exec(rest);
  if (f) { files = f[1].split(/[,\s]+/).map((x) => x.trim()).filter(Boolean); rest = rest.slice(0, f.index); }
  return { name, part: rest.trim(), files };
};

/** Wisp's claude_swarm: one approval, then the swarm works in the background; one report back. */
async function swarmForChat({ session, task, parts, browser, url, model, effort, approve, cwd, onReport }) {
  const notReady = checkReady();
  if (notReady) return notReady;
  cwd = realDir(cwd);
  const list = (Array.isArray(parts) ? parts : []).map(parsePart).filter((p) => p.part).slice(0, 6);
  const count = list.length || 0;
  if (count < 2) return { ok: false, failed: 'A swarm needs at least two parts, one line each ("Name: the part | files: a, b").' };
  const conf = settings();
  let useModel = (model && cc().normalizeModel(model)) || conf.model;
  let useEffort = (effort && cc().normalizeEffort(effort)) || conf.effort;
  const verdict = await approve({
    tool: 'claude_code',
    title: `Let a swarm of ${count} Claude agents work on this`,
    detail: `${oneLine(task, 400)}\n\n${list.map((p, i) => `${p.name || `Agent ${i + 1}`}: ${oneLine(p.part, 140)}`).join('\n')}\n\nFolder: ${cwd}${browser ? '\nThey share a tab in Codeply\'s browser, each with its own cursor. Your own mouse is not used.' : ''}\nThey use your Claude plan and coordinate through notes in .codeply/swarm. They cannot push, deploy or publish.`,
    danger: conf.level === 'full',
    choices: {
      model: { label: 'Model', value: useModel, options: cc().MODEL_CHOICES },
      effort: { label: 'Effort', value: useEffort, options: cc().EFFORT_CHOICES },
    },
  });
  const v = verdict && typeof verdict === 'object' ? String(verdict.verdict || verdict.action || '') : String(verdict || '');
  if (v === 'reject') return { ok: false, rejected: true, failed: 'The user said no to the swarm.' };
  const ed = verdict && typeof verdict === 'object' && verdict.edits ? verdict.edits : null;
  if (ed && cc().normalizeModel(ed.model)) useModel = cc().normalizeModel(ed.model);
  if (ed && cc().normalizeEffort(ed.effort)) useEffort = cc().normalizeEffort(ed.effort);

  const sw = startSwarm({ chatId: session.id, cwd, goal: task, parts: list, browser, url, model: useModel, effort: useEffort, by: 'wisp' });
  emit({ kind: 'focus', agentId: sw.members[0].a.id });
  for (const m of sw.members) {
    runRound(m.a, { task: m.part, chat: '', by: 'wisp', session }).then((r) => {
      if (r.aborted) return;
      let text = '';
      try { text = onReport ? onReport(r) : r.text; } catch { text = r.text; }
      holdReport(session.id, text, { actions: r.actions, files: r.files, succeeded: [...new Set(r.actions.filter((x) => x.ok).map((x) => x.tool))] }, r.agent ? { id: r.agent.id, name: r.agent.name, look: r.agent.look } : null);
    }).catch(() => {});
  }
  return { ok: true, started: true, swarm: { id: sw.id, board: path.join(sw.dir, 'board.md'), agents: sw.members.map((m) => summary(m.a)) } };
}

// A bare agent's whole system prompt (Claude Code's own is replaced).
const BARE_SYSTEM = 'You are Claude, a helpful assistant.';

// Agents Wisp started together report together: each report waits while the
// chat's other agents still work, then Wisp gets them all in one message (and
// reviews once), instead of being woken for each. At most 15 minutes of waiting.
const held = new Map(); // sessionId -> { items: [{ text, credit }], timer }
function holdReport(sessionId, text, credit, who) {
  const h = held.get(sessionId) || { items: [], timer: null };
  held.set(sessionId, h);
  h.items.push({ text, credit, who });
  const others = [...agents.values()].some((x) => x.chatId === sessionId && x.by === 'wisp' && x.status === 'working');
  if (others) { if (!h.timer) h.timer = setTimeout(() => flushReports(sessionId), 15 * 60 * 1000); return; }
  flushReports(sessionId);
}
function flushReports(sessionId) {
  const h = held.get(sessionId);
  if (!h) return;
  held.delete(sessionId);
  clearTimeout(h.timer);
  if (!h.items.length || !deps.wake) return;
  const credit = { actions: [], files: [], succeeded: [] };
  for (const it of h.items) {
    credit.actions.push(...((it.credit && it.credit.actions) || []));
    credit.files.push(...((it.credit && it.credit.files) || []));
    credit.succeeded.push(...((it.credit && it.credit.succeeded) || []));
  }
  credit.files = [...new Set(credit.files)];
  credit.succeeded = [...new Set(credit.succeeded)];
  // Who contributed: their faces show under Codeply's answer.
  const crew = h.items.map((it) => it.who).filter(Boolean);
  if (h.items.length === 1) { deps.wake(sessionId, h.items[0].text, credit, crew); return; }
  const body = h.items.map((it) => String(it.text).split('\n').filter((l) => !/^\[Automatic message from Codeply/.test(l)).join('\n').trim()).join('\n\n---\n\n');
  const still = [...agents.values()].filter((x) => x.chatId === sessionId && x.by === 'wisp' && x.status === 'working').map((x) => x.name);
  deps.wake(sessionId, `[Automatic message from Codeply, not typed by the user: ${h.items.length} agents finished working in the background.]\n\n${body}${still.length ? `\n\nStill working: ${still.join(', ')}. Their reports come later.` : ''}\n\nReview them together, then answer the user ONCE, in your own voice, as the result of the work: what is done, how you checked it, what is left. Don't go agent by agent; the app shows who contributed under your answer. Only when each agent answered its own question (say the user asked each one something) quote each answer briefly by name.`, credit, crew);
}

function checkReady() {
  const st = current();
  if (!settings().enabled) return { ok: false, failed: 'Claude Code is turned off in Connect Apps.' };
  if (!st || !st.installed) return { ok: false, failed: 'Claude Code is not installed on this PC. The user can install it from Connect Apps, Claude Code.' };
  if (!st.loggedIn) return { ok: false, auth: true, failed: 'Claude Code is not logged in. The user can log in from Connect Apps, Claude Code.' };
  return null;
}

/**
 * Wisp's claude_code call. Asks once per chat and folder (the card can change
 * the model and effort), then starts the agent's round. In the background by
 * default: returns { ok, started, agent } at once and, when the round ends,
 * wakes the chat with onReport(result). With wait, resolves to the round's result.
 */
async function runForChat({ session, task, chat, fresh, model, effort, agent: agentName, wait, bare, browser, approve, signal, cwd, onReport }) {
  const notReady = checkReady();
  if (notReady) return notReady;
  cwd = realDir(cwd);
  const conf = settings();
  const mine = agentsForChat(session).filter((x) => x.cwd === cwd);
  const want = oneLine(agentName, 40);
  const isNew = /^(new|another|next)$/i.test(want);
  let a = want && !isNew ? mine.find((x) => x.name.toLowerCase() === want.toLowerCase()) || null : null;
  if (!a && !want && !fresh) a = mine.filter((x) => x.status !== 'working').sort((x, y) => (y.endedAt || 0) - (x.endedAt || 0))[0] || null;
  if (a && a.status === 'working') {
    return { ok: false, failed: `${a.name} is still working. Its report arrives here when it finishes. To run something in parallel, use another agent name.` };
  }

  const mWant = model ? cc().normalizeModel(model) : null;
  const eWant = effort ? cc().normalizeEffort(effort) : null;
  let useModel = mWant || (a && a.model) || conf.model;
  let useEffort = eWant || (a && a.effort) || conf.effort;

  // One yes per chat and folder; later rounds and more agents go straight through.
  if (!mine.some((x) => x.approved)) {
    const can = conf.level === 'full' ? 'edit files and run any command here' : conf.level === 'edits' ? 'edit files here (no commands)' : 'edit files and run everyday dev commands here (npm, node, git status...)';
    const verdict = await approve({
      tool: 'claude_code',
      title: 'Let Claude Code work on this project',
      detail: `${oneLine(task, 600)}\n\nFolder: ${cwd}\nClaude Code uses your Claude plan and works in the background in the Claude panel. It can ${can}. It cannot push, deploy or publish; Codeply does that with your connected apps.`,
      danger: conf.level === 'full',
      choices: {
        model: { label: 'Model', value: useModel, options: cc().MODEL_CHOICES },
        effort: { label: 'Effort', value: useEffort, options: cc().EFFORT_CHOICES },
      },
    });
    const v = verdict && typeof verdict === 'object' ? String(verdict.verdict || verdict.action || '') : String(verdict || '');
    if (v === 'reject') return { ok: false, rejected: true, failed: 'The user said no to Claude Code for this.' };
    const ed = verdict && typeof verdict === 'object' && verdict.edits ? verdict.edits : null;
    if (ed && cc().normalizeModel(ed.model)) useModel = cc().normalizeModel(ed.model);
    if (ed && cc().normalizeEffort(ed.effort)) useEffort = cc().normalizeEffort(ed.effort);
  }

  if (!a) a = newAgent({ name: want && !isNew ? want : '', chatId: session.id, cwd, model: useModel, effort: useEffort, level: conf.level, by: 'wisp' });
  if (fresh) { a.claudeSession = ''; a.skills = []; }
  Object.assign(a, { model: useModel, effort: useEffort, level: conf.level, approved: true, cwd, bare: !!bare, browser: !!browser });

  if (wait) return runRound(a, { task, chat, by: 'wisp', session, mirror: true, signal });

  emit({ kind: 'focus', agentId: a.id });
  runRound(a, { task, chat, by: 'wisp', session }).then((r) => {
    if (r.aborted) return; // the user stopped it in the panel: their call, Wisp is not woken
    let text = '';
    try { text = onReport ? onReport(r) : r.text; } catch { text = r.text; }
    holdReport(session.id, text, { actions: r.actions, files: r.files, succeeded: [...new Set(r.actions.filter((x) => x.ok).map((x) => x.tool))] }, r.agent ? { id: r.agent.id, name: r.agent.name, look: r.agent.look } : null);
  }).catch(() => {});
  return { ok: true, started: true, agent: summary(a) };
}

// ─── From the Claude panel ──────────────────────────────────────────────────

function panelList() {
  return {
    agents: [...agents.values()].filter((a) => a.log.length || a.status === 'working').map((a) => ({ ...summary(a), log: a.log.slice(-400) })),
    state: publicState(),
  };
}

/** A new agent the user starts from the panel: no approval (they asked), no Wisp review. */
function startFromPanel(o) {
  const notReady = checkReady();
  if (notReady) return { ok: false, error: notReady.failed };
  const task = String((o && o.task) || '').trim();
  const cwd = String((o && o.cwd) || '');
  if (!task) return { ok: false, error: 'Write what Claude should do.' };
  if (!cwd || !fs.existsSync(cwd)) return { ok: false, error: 'Open a project folder first, so Claude knows where to work.' };
  const conf = settings();
  const model = cc().normalizeModel(o.model) || conf.model;
  const effort = cc().normalizeEffort(o.effort) || conf.effort;
  const n = Math.max(1, Math.min(6, Number(o.swarm) || 1));
  if (n > 1 || o.browser) {
    // A swarm from the panel: they split the goal themselves, claiming parts in their notes.
    const real = realDir(cwd);
    const sw = startSwarm({ chatId: '', cwd: real, goal: task, parts: Array.from({ length: Math.max(1, n) }, () => ({ name: '', part: '', files: [] })), browser: !!o.browser, url: String(o.url || '').trim(), model, effort, by: 'user' });
    for (const m of sw.members) runRound(m.a, { task, by: 'user' }).catch(() => {});
    return { ok: true, agent: summary(sw.members[0].a), agents: sw.members.map((m) => summary(m.a)) };
  }
  const a = newAgent({ name: o.name, chatId: '', cwd, by: 'user', level: conf.level, model, effort });
  a.approved = true;
  runRound(a, { task, by: 'user' }).catch(() => {});
  return { ok: true, agent: summary(a) };
}

/** The user types to an agent: into the running session, or as its next round. */
function sendToAgent({ agentId, text, model, effort } = {}) {
  const a = agents.get(String(agentId || ''));
  const msg = String(text || '').trim();
  if (!a) return { ok: false, error: 'That agent is gone.' };
  if (!msg) return { ok: false };
  if (a.status === 'working') {
    if (a.control && a.control.send && a.control.send(msg)) {
      log(a, { t: 'user', text: msg, by: 'user', live: true });
      return { ok: true, live: true };
    }
    a.queued.push(msg);
    log(a, { t: 'user', text: msg, by: 'user', queued: true });
    announce(a);
    return { ok: true, queued: true };
  }
  const notReady = checkReady();
  if (notReady) return { ok: false, error: notReady.failed };
  if (cc().normalizeModel(model)) a.model = cc().normalizeModel(model);
  if (cc().normalizeEffort(effort)) a.effort = cc().normalizeEffort(effort);
  runRound(a, { task: msg, by: 'user' }).catch(() => {});
  return { ok: true };
}

function stopAgent(agentId) {
  const a = agents.get(String(agentId || ''));
  if (!a || !a.abort) return { ok: false };
  a.queued = [];
  log(a, { t: 'sys', text: 'Stopping...' });
  a.abort.abort();
  return { ok: true };
}

function closeAgent(agentId) {
  const a = agents.get(String(agentId || ''));
  if (!a) return { ok: true };
  if (a.status === 'working') return { ok: false, error: 'Stop it first.' };
  agents.delete(a.id);
  emit({ kind: 'removed', agentId: a.id });
  saveAgents();
  return { ok: true };
}

function setAgent({ agentId, model, effort } = {}) {
  const a = agents.get(String(agentId || ''));
  if (!a) return { ok: false };
  if (cc().normalizeModel(model)) a.model = cc().normalizeModel(model);
  if (cc().normalizeEffort(effort)) a.effort = cc().normalizeEffort(effort);
  a.liveModel = '';
  announce(a);
  persist(a);
  return { ok: true, agent: summary(a) };
}

// ─── Login, from the Connect Apps card ──────────────────────────────────────

function loginEvent(data) { try { deps.sendWindow('claudeCode:login', data); } catch {} }

// The sign-in page Claude Code printed for the login in progress. "Open the sign-in page
// again" opens only this, and only on Claude's or Anthropic's own sites.
let loginUrl = '';
const LOGIN_HOSTS = /^(?:claude\.ai|claude\.com|(?:[a-z0-9-]+\.)?anthropic\.com)$/i;
function openLoginPage() {
  let u = null;
  try { u = new URL(loginUrl); } catch { return { ok: false }; }
  if (u.protocol !== 'https:' || !LOGIN_HOSTS.test(u.hostname)) return { ok: false };
  require('electron').shell.openExternal(u.href);
  return { ok: true };
}

function startLogin({ console: useConsole } = {}) {
  if (loginRun) return { ok: true, already: true };
  loginUrl = '';
  const run = cc().login({
    console: !!useConsole,
    onUrl: (url) => { loginUrl = url; loginEvent({ phase: 'url', url }); },
    onNeedCode: () => loginEvent({ phase: 'code' }),
    onOutput: (s) => term(`${C.dim}${s}${C.off}`),
  });
  loginRun = run;
  term(`\n${C.claude}✳ claude auth login${C.off} ${C.dim}(finish signing in in your browser)${C.off}\n`);
  run.done.then(async (r) => {
    loginRun = null;
    loginUrl = '';
    if (r.cancelled) {
      term(`${C.dim}Login cancelled.${C.off}\n`);
      loginEvent({ phase: 'done', ok: false, cancelled: true, error: '', state: publicState(await refresh()) });
      return;
    }
    const st = await refresh();
    const ok = !!(r.ok && st && st.loggedIn);
    term(ok ? `${C.ok}✓ Claude Code is logged in${st.email ? ` as ${st.email}` : ''}${C.off}\n` : `${C.bad}✗ ${r.error || 'Not logged in'}${C.off}\n`);
    loginEvent({ phase: 'done', ok, error: ok ? '' : (r.error || 'The login did not finish.'), state: publicState(st) });
  });
  return { ok: true };
}

function init(d) {
  deps = d;
  loadAgents();
  const h = (ch, fn) => d.ipcMain.handle(ch, fn);
  h('claudeCode:state', async (e, opts) => publicState(opts && opts.refresh ? await refresh() : (current() || await refresh())));
  h('claudeCode:login', (e, opts) => startLogin(opts || {}));
  h('claudeCode:code', (e, code) => { if (loginRun) loginRun.submitCode(code); return { ok: !!loginRun }; });
  h('claudeCode:cancelLogin', () => { if (loginRun) loginRun.cancel(); return { ok: true }; });
  h('claudeCode:openLogin', () => openLoginPage());
  h('claudeCode:logout', async () => { const r = await cc().logout(); const st = await refresh(); return { ...r, state: publicState(st) }; });
  h('claudeCode:settings', (e, patch) => {
    const p = patch && typeof patch === 'object' ? patch : {};
    const next = { ...settings() };
    if (p.enabled !== undefined) next.enabled = !!p.enabled;
    if (p.model !== undefined && cc().normalizeModel(p.model)) next.model = cc().normalizeModel(p.model);
    if (p.effort !== undefined && cc().normalizeEffort(p.effort)) next.effort = cc().normalizeEffort(p.effort);
    if (LEVELS.includes(p.level)) next.level = p.level;
    deps.store.set(next);
    return publicState();
  });
  // The Claude panel.
  h('claudeCode:agents', () => panelList());
  h('claudeCode:startAgent', (e, o) => startFromPanel(o || {}));
  h('claudeCode:send', (e, o) => sendToAgent(o || {}));
  h('claudeCode:stop', (e, id) => stopAgent(id));
  h('claudeCode:close', (e, id) => closeAgent(id));
  h('claudeCode:setAgent', (e, o) => setAgent(o || {}));
  refresh().catch(() => {});
}

/** Stops every agent (the app is quitting). */
function stopAll() { for (const a of agents.values()) if (a.abort) try { a.abort.abort(); } catch {} }

module.exports = { init, runForChat, swarmForChat, promptState, ready, refresh, stopAll, CARD };
