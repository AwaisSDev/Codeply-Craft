// Bots in the desktop app: the main-process side (engine: codeply-cli/lib/bots.js).
//
// The composer's bot chip sends botId with chat:send. Every turn of that chat
// then runs as that bot: its prompt joins the system prompt, its approval
// boundary wraps approve(), and it can ask teammates with ask_bot. Only one
// bot runs at a time across the whole app (the engine's global lock); a turn
// that would overlap waits, and a delegated teammate runs while its caller
// waits. After each reply the bot learns, in the background, and after work
// with tools it reflects on what it did (lessons, playbooks, tool tips).
//
// main.js wires this in with init(deps) and two small hooks (onSend in
// startChatRun, forTurn in runOneTurn); nothing here reaches into main.js.
const path = require('path');

let deps = null;
let lib = null;

function bots() {
  if (!lib) lib = require(path.join(deps.cliDir, 'lib', 'bots.js'));
  return lib;
}

const view = (b) => b && { ...b };

function catalog() {
  const b = bots();
  return {
    bots: b.listBots().map(view),
    templates: b.TEMPLATES,
    tones: b.TONES,
    approvals: Object.fromEntries(Object.entries(b.APPROVALS).map(([k, v]) => [k, v.label])),
    maxMemory: b.MAX_MEMORY,
  };
}

/** startChatRun: remember who answers in this chat. botId undefined (the phone) keeps the current choice. */
function onSend(session, botId) {
  if (typeof botId === 'string') session.botId = botId || null;
  session.lastBot = null; // every reply opens with its bot badge
}

function emitBadge(session, bot) {
  const key = bot ? bot.id : 'craft';
  if (session.lastBot === key) return;
  session.lastBot = key;
  if (!bot) return;
  const msg = { kind: 'bot_active', bot: bots().botCard(bot), at: Date.now() };
  session.messages.push(msg);
  deps.sendEvent(session.id, { type: 'bot_active', bot: msg.bot });
}

/** The bot's approval boundary on top of the chat's own approve(). */
function wrapApprove(approve, bot, session, cwd) {
  if (!bot) return approve;
  const wrapped = async (req) => {
    const skip = !req.danger && req.tool !== 'fetch_image' && bots().canSkipApproval(bot, req.tool);
    if (skip) {
      // The user's own deny rules still win over anything a bot is allowed.
      const perms = deps.permissionsLib && deps.permissionsLib();
      const rule = perms ? perms.decide(req, cwd) : { decision: null };
      if (rule.decision !== 'deny') {
        deps.sendEvent(session.id, { type: 'approval_auto', tool: req.tool, title: req.title, bypass: false });
        return 'once';
      }
    }
    return approve(req);
  };
  if (approve && approve.ask) wrapped.ask = approve.ask;
  return wrapped;
}

/**
 * The ask_bot tool for one run. depth is the depth of the run that holds this
 * function (top level = 0), chain the bots already working in this request.
 */
function makeAskBot(c) {
  const b = bots();
  return async ({ name, task, signal }) => {
    const steps = [];
    const r = await b.delegate({
      caller: c.caller, name, task, depth: c.depth, chain: c.chain, token: c.token, signal: signal || c.signal,
      runBot: (target, sub) => runSub(c, target, sub, steps),
    });
    if (r.meta && r.meta.delegation) r.meta.delegation.steps = steps.slice(-12);
    if (r.meta && r.meta.delegation && r.meta.delegation.bot) {
      deps.sendEvent(c.session.id, { type: 'bot_working', bot: r.meta.delegation.bot, working: false, ok: r.ok });
    }
    return r;
  };
}

/** One delegated teammate run: its own prompt, only the task, its own approval boundary. */
async function runSub(c, target, sub, steps) {
  const b = bots();
  const card = b.botCard(target);
  deps.sendEvent(c.session.id, { type: 'bot_working', bot: card, task: sub.task, working: true });
  const canAsk = sub.depth < b.MAX_DEPTH;
  const run = deps.agentMod().runAgent({
    userMessage: sub.task, history: [], mode: c.mode, cwd: c.cwd,
    approve: wrapApprove(c.approve, target, c.session, c.cwd), browser: deps.browser, signal: c.signal, route: c.route,
    maxSteps: 30, botPrompt: sub.prompt,
    askBot: canAsk ? makeAskBot({ ...c, caller: target, depth: sub.depth, chain: sub.chain }) : undefined,
  });
  let reply = '';
  const trajectory = []; // the teammate's own tool calls, for its reflection
  for await (const ev of run) {
    if (ev.type === 'text' && !ev.interim) reply += (reply ? '\n\n' : '') + ev.text;
    else if (ev.type === 'tool_end') {
      const label = ev.summary || (ev.args && (ev.args.path || ev.args.command || ev.args.pattern || ev.args.query)) || '';
      const step = { name: ev.name, label: String(label).slice(0, 140), ok: !!ev.ok };
      steps.push(step);
      if (trajectory.length < 60) trajectory.push(b.runStep(ev));
      deps.sendEvent(c.session.id, { type: 'bot_step', bot: card, ...step });
    } else if (ev.type === 'error') throw new Error(ev.error || 'the run failed');
    else if (ev.type === 'aborted') throw new Error('Stopped.');
    else if (ev.type === 'done') break;
  }
  if (reply && !(c.signal && c.signal.aborted)) reflect(target, { request: sub.task, steps: trajectory, reply }, c.route, null);
  return reply;
}

/**
 * runOneTurn: everything this turn needs to run as the chat's bot, or null
 * when the user has no bots (plain Craft, nothing changes). Never throws.
 */
async function forTurn({ session, approve, signal, route, cwd, mode, verifyOnly, request }) {
  let b; let team;
  try { b = bots(); team = b.listBots(); } catch (e) { console.warn('[bots] not available:', e.message); return null; }
  if (!team.length) return null;
  const bot = session.botId ? team.find((x) => x.id === session.botId) || null : null;
  const token = `chat:${session.id}:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  let held = false;
  if (bot) {
    if (b.globalLock.owner && b.globalLock.owner !== token) {
      deps.sendEvent(session.id, { type: 'notice', level: 'info', text: `Waiting for another bot to finish first. Only one bot runs at a time.` });
    }
    try { await b.globalLock.acquire(token, signal); held = true; } catch { return null; }
    emitBadge(session, bot);
  } else {
    emitBadge(session, null);
  }
  const c = { session, caller: bot, depth: 0, chain: bot ? [bot.id] : [], token, approve, signal, route, cwd, mode };
  const steps = []; // this turn's tool calls, for the bot's reflection
  return {
    bot,
    approve: wrapApprove(approve, bot, session, cwd),
    botPrompt: (native) => (bot ? b.buildBotPrompt(bot, { team, canDelegate: true, native, request }) : b.teamPrompt(team, { native })),
    askBot: makeAskBot(c),
    /** runOneTurn passes every run event here; tool calls become the trajectory. */
    see(ev) {
      if (ev && ev.type === 'tool_end' && steps.length < 60) steps.push(b.runStep(ev));
    },
    done(userText, replyText) {
      if (held) { held = false; b.globalLock.release(token); }
      if (!bot || verifyOnly || !replyText || signal.aborted) return;
      const chatFn = (messages) => deps.aiLib().chatJson(messages, { route });
      b.learnFromTurn(b.getBot(bot.id) || bot, userText, replyText, chatFn).then((r) => {
        if (r.added && r.added.length) deps.sendEvent(session.id, { type: 'bot_learned', bot: b.botCard(bot), facts: r.added });
      }).catch(() => {});
      reflect(bot, { request: userText, steps, reply: replyText }, route, session);
    },
  };
}

/**
 * MUSE-style reflection after a run that used tools, in the background: the
 * bot keeps lessons, playbooks, tool tips and open threads (bots.reflectOnRun).
 * A new or updated playbook shows up in the chat like a learned fact.
 */
function reflect(bot, run, route, session) {
  if (!bot || !run.steps || !run.steps.length) return;
  const b = bots();
  const chatFn = (messages) => deps.aiLib().chatJson(messages, { route });
  b.reflectOnRun(b.getBot(bot.id) || bot, run, chatFn).then((r) => {
    const a = r && r.added;
    if (!a || !session) return;
    const facts = [];
    if (a.playbook) facts.push(`${a.updated ? 'a better way to do' : 'how to do'} ${a.playbook}`);
    for (const l of a.lessons || []) facts.push(`when ${l.situation}, ${l.strategy}`);
    if (facts.length) deps.sendEvent(session.id, { type: 'bot_learned', bot: b.botCard(bot), facts });
  }).catch(() => {});
}

/** "Describe your bot": the model fills in a draft; nothing is saved until the user does. */
async function describe(description) {
  description = String(description || '').trim();
  if (description.length < 4) return { error: 'Say a few words about what the bot should do.' };
  if (!(await deps.ensureEngine())) return { error: 'Engine not available.' };
  const b = bots();
  const r = await deps.aiLib().chatJson([{ role: 'user', content: b.describePrompt(description) }], { route: deps.currentRoute() });
  if (!r.success) return { error: r.error || 'The model did not answer.' };
  return { draft: b.fromDescription(r.json, description) };
}

// ─── Phone bridge (calls) ───────────────────────────────────────────────────
// The phone has no bots of its own: it lists them from here (with a ready
// prompt each, so it can still call them while this PC is offline) and sends
// finished calls back so the bot learns from them.

/** What the phone needs to call a bot. Approval rules stay on the PC. */
function phoneBot(bot, team) {
  const b = bots();
  return {
    id: bot.id, name: bot.name, role: bot.role, specialty: bot.specialty, instructions: bot.instructions,
    tone: bot.tone, sources: bot.sources, avatar: bot.avatar, voice: bot.voice || '',
    memory: (bot.memory || []).map((m) => m.fact),
    prompt: b.buildBotPrompt(bot, { team }),
    updatedAt: bot.updatedAt || 0,
  };
}

function phoneCatalog() {
  const b = bots();
  const team = b.listBots();
  return {
    bots: team.map((x) => phoneBot(x, team)),
    templates: b.TEMPLATES.map((t) => ({ key: t.key, name: t.name, role: t.role, specialty: t.specialty, avatar: t.avatar })),
  };
}

/** A finished phone call: the bot learns from what the user said on it. */
async function saveCall({ botId, ms, turns }) {
  const b = bots();
  const bot = b.getBot(String(botId || ''));
  if (!bot) return { status: 404, body: { error: 'That bot is not on this PC any more.' } };
  const list = (Array.isArray(turns) ? turns : []).filter((t) => t && t.text)
    .map((t) => ({ who: t.who === 'bot' ? 'bot' : 'user', text: String(t.text).slice(0, 2000) })).slice(-80);
  if (!list.some((t) => t.who === 'user')) return { status: 200, body: { ok: true, learned: false } };
  const userSide = list.filter((t) => t.who === 'user').map((t) => t.text).join('\n');
  const botSide = list.filter((t) => t.who === 'bot').map((t) => t.text).join('\n');
  // Learning takes a model call; answer the phone now and learn in the background.
  (async () => {
    if (!(await deps.ensureEngine())) return;
    const route = deps.currentRoute();
    const chatFn = (messages) => deps.aiLib().chatJson(messages, { route });
    await b.learnFromTurn(bot, `(on a voice call, ${Math.round((Number(ms) || 0) / 1000)}s) ${userSide}`, botSide, chatFn);
  })().catch(() => {});
  return { status: 200, body: { ok: true, learned: true } };
}

// ─── Phone calls with tools ─────────────────────────────────────────────────
// A call turn from the phone runs here, on this PC, as the bot's real agent
// (bots.voiceTurn): Gmail, files, the web, all of it, in the bots' folder
// (~/Codeply Crew, the same one Codeply Crew uses). The relay is request and
// response with a time limit, so a turn is a job: the phone starts it, polls
// for what it is doing ("Checking your email"), answers approvals for anything
// outside the bot's boundary, and gets the spoken reply at the end.

const os = require('os');
const fs = require('fs');
const voiceJobs = new Map(); // jobId -> job
const JOB_WAIT_MS = 8000;

function botsFolder() {
  const dir = path.join(os.homedir(), 'Codeply Crew');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

function jobView(j) {
  return {
    jobId: j.id, version: j.version, status: j.status, step: j.step || '', text: j.text || '', error: j.error || '',
    approval: j.approval ? { requestId: j.approval.requestId, title: j.approval.title, detail: j.approval.detail, danger: j.approval.danger, draft: j.approval.draft || null, draftOnly: !!j.approval.draftOnly } : null,
  };
}

function bumpJob(j) {
  j.version++;
  const waiters = j.waiters.splice(0);
  for (const w of waiters) w();
}

/** Resolves when the job changes after `version`, or after `ms`. */
function waitJob(j, version, ms) {
  if (j.version !== version || j.status !== 'working') return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    j.waiters.push(() => { clearTimeout(t); resolve(); });
  });
}

async function startVoice({ botId, turns }) {
  const b = bots();
  const bot = b.getBot(String(botId || ''));
  if (!bot) return { status: 404, body: { error: 'That bot is not on this PC any more.' } };
  if (!(await deps.ensureEngine())) return { status: 503, body: { error: 'The engine is not ready on your PC.' } };
  // One turn per bot at a time: a new one replaces the old (the user talked over it).
  for (const j of voiceJobs.values()) if (j.botId === bot.id && j.status === 'working') j.controller.abort();
  const id = `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const controller = new AbortController();
  const j = { id, botId: bot.id, status: 'working', step: '', text: '', error: '', approval: null, version: 0, waiters: [], controller, at: Date.now() };
  voiceJobs.set(id, j);
  const { signal } = controller;
  const route = deps.currentRoute();
  const token = `phone-call:${id}`;
  const approve = async (req) => {
    if (signal.aborted) return 'reject';
    if (!req.danger && req.tool !== 'fetch_image' && b.canSkipApproval(bot, req.tool)) {
      const perms = deps.permissionsLib && deps.permissionsLib();
      const rule = perms ? perms.decide(req, botsFolder()) : { decision: null };
      if (rule.decision !== 'deny') return 'once';
    }
    const requestId = `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const verdict = await new Promise((resolve) => {
      // An email (gmail_send / gmail_draft) rides along so the phone can show it editable.
      const draft = req.draft ? { to: String(req.draft.to || ''), subject: String(req.draft.subject || ''), body: String(req.draft.body || '').slice(0, 20000) } : null;
      j.approval = { requestId, title: req.title, detail: String(req.detail || '').slice(0, 800), danger: !!req.danger, draft, draftOnly: !!req.draftOnly, resolve };
      bumpJob(j);
      signal.addEventListener('abort', () => resolve('reject'), { once: true });
    });
    j.approval = null;
    bumpJob(j);
    return verdict;
  };
  (async () => {
    try {
      const r = await b.globalLock.run(token, () => b.voiceTurn({
        bot, team: b.listBots(), turns, runAgent: deps.agentMod().runAgent, route, cwd: botsFolder(), signal, approve,
        onStep: (s) => { if (!s.done) { j.step = b.callStepLabel(s.name); bumpJob(j); } },
      }), signal);
      j.text = r.text; j.status = 'done';
      // The bot learns from the work it did on the call, in the background.
      if (r.reply) reflect(bot, { request: r.request, steps: r.steps, reply: r.reply }, route, null);
    } catch (e) {
      j.status = signal.aborted ? 'cancelled' : 'error';
      j.error = e.message;
    }
    bumpJob(j);
    setTimeout(() => voiceJobs.delete(id), 5 * 60 * 1000);
  })();
  await waitJob(j, 0, JOB_WAIT_MS);
  return { status: 200, body: jobView(j) };
}

async function pollVoice({ jobId, version }) {
  const j = voiceJobs.get(String(jobId || ''));
  if (!j) return { status: 404, body: { error: 'That call turn is gone.' } };
  await waitJob(j, Number.isFinite(Number(version)) ? Number(version) : j.version, JOB_WAIT_MS);
  return { status: 200, body: jobView(j) };
}

// verdict: 'once' | 'always' | 'draft' | 'reject' (or { verdict, edits }); edits: the
// email as the user left it on the card ({ to, subject, body }), when there was one.
function answerVoice({ jobId, requestId, verdict, edits }) {
  const j = voiceJobs.get(String(jobId || ''));
  if (!j || !j.approval || j.approval.requestId !== requestId) return { status: 404, body: { error: 'Nothing is waiting for that answer.' } };
  const v = verdict && typeof verdict === 'object' ? verdict.verdict : verdict;
  const e = edits || (verdict && typeof verdict === 'object' ? verdict.edits : null);
  const clean = v === 'once' || v === 'always' ? 'once' : v === 'draft' ? 'draft' : 'reject';
  const kept = j.approval.draft && e && typeof e === 'object'
    ? Object.fromEntries(['to', 'subject', 'body'].filter((k) => typeof e[k] === 'string').map((k) => [k, e[k].slice(0, 100000)]))
    : null;
  j.approval.resolve(kept && clean !== 'reject' ? { verdict: clean, edits: kept } : clean);
  return { status: 200, body: { ok: true } };
}

function cancelVoice({ jobId }) {
  const j = voiceJobs.get(String(jobId || ''));
  if (j && j.status === 'working') j.controller.abort();
  return { status: 200, body: { ok: true } };
}

/** A bot built on the phone. Only these fields come from the phone; the rest is the engine's defaults. */
const PHONE_FIELDS = ['name', 'role', 'specialty', 'instructions', 'tone', 'sources', 'approval', 'avatar', 'voice'];
function createFromPhone(data) {
  const picked = {};
  for (const k of PHONE_FIELDS) if (data[k] !== undefined) picked[k] = data[k];
  if (!String(picked.name || '').trim()) return { status: 400, body: { error: 'Give the bot a name.' } };
  const b = bots();
  const created = b.createBot(picked);
  return { status: 200, body: { ...phoneCatalog(), bot: phoneBot(created, b.listBots()) } };
}

/** handleBridgeApi hook: a response for /api/bots routes, or null. */
async function bridge(method, pathname, query, body) {
  try {
    if (method === 'POST' && pathname === '/api/bots/voice') return await startVoice(body || {});
    if (method === 'POST' && pathname === '/api/bots/voice/poll') return await pollVoice(body || {});
    if (method === 'POST' && pathname === '/api/bots/voice/answer') return answerVoice(body || {});
    if (method === 'POST' && pathname === '/api/bots/voice/cancel') return cancelVoice(body || {});
    if (method === 'GET' && pathname === '/api/bots') return { status: 200, body: phoneCatalog() };
    if (method === 'POST' && pathname === '/api/bots/template') {
      bots().createFromTemplate(String((body && body.key) || ''));
      return { status: 200, body: phoneCatalog() };
    }
    if (method === 'POST' && pathname === '/api/bots/call') return await saveCall(body || {});
    // "Build a bot from a prompt" on the phone: a draft first, then the bot.
    if (method === 'POST' && pathname === '/api/bots/describe') return { status: 200, body: await describe(body && body.text) };
    if (method === 'POST' && pathname === '/api/bots/create') return createFromPhone((body && body.bot) || {});
  } catch (e) {
    return { status: 500, body: { error: e.message } };
  }
  return null;
}

function guard(fn) {
  return async (...args) => {
    try { return await fn(...args); } catch (e) { return { error: e.message }; }
  };
}

function init(d) {
  deps = d;
  const { ipcMain } = d;
  ipcMain.handle('bots:list', guard(() => catalog()));
  ipcMain.handle('bots:create', guard((e, data) => ({ bot: bots().createBot(data), ...catalog() })));
  ipcMain.handle('bots:fromTemplate', guard((e, key) => ({ bot: bots().createFromTemplate(key), ...catalog() })));
  ipcMain.handle('bots:update', guard((e, id, patch) => ({ bot: bots().updateBot(id, patch), ...catalog() })));
  ipcMain.handle('bots:remove', guard((e, id) => { bots().removeBot(id); return catalog(); }));
  ipcMain.handle('bots:forget', guard((e, id, index) => ({ bot: bots().forget(id, Number(index)), ...catalog() })));
  ipcMain.handle('bots:clearMemory', guard((e, id) => ({ bot: bots().clearMemory(id), ...catalog() })));
  ipcMain.handle('bots:forgetExperience', guard((e, id, kind, index) => ({ bot: bots().forgetExperience(id, String(kind), Number(index)), ...catalog() })));
  ipcMain.handle('bots:describe', guard((e, text) => describe(text)));
}

module.exports = { init, onSend, forTurn, bridge };
