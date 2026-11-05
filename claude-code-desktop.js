// Claude Code on the desktop: the user's own Claude plan as a background
// coding agent that Wisp briefs, watches and reviews.
//
//   - Connect Apps has a Claude Code card: Install (runs the official
//     installer in Codeply's terminal), Log in (runs `claude auth login`, which
//     opens the browser; Claude Code saves the login itself, so it stays signed
//     in), Log out, the model and what it may do on its own.
//   - Wisp's claude_code tool runs here (runForChat): one approval per chat,
//     then Claude Code works headless in the chat's project folder. Its steps
//     show in the chat as Claude Code's own rows (like a specialist's) and are
//     mirrored to the terminal panel; Wisp gets its report plus what it really
//     did. The Claude session id is kept on the chat, so the next round
//     resumes it and Claude remembers the earlier work.
//
// Codeply's taste guide and the skills that fit the task go to Claude Code on
// top of its own prompt (codeply-cli/lib/claude-code.js systemAppend).
const fs = require('fs');
const os = require('os');
const path = require('path');

let deps = null; // { ipcMain, cliDir, sendEvent, sendWindow(channel, data), recordToolEnd, store: { get(), set(patch) } }
let lib = null;
const cc = () => { if (!lib) lib = require(path.join(deps.cliDir, 'lib', 'claude-code.js')); return lib; };

const CARD = { id: 'claude-code', name: 'Claude Code', focus: 'Coding agent on your Claude plan', shape: 'star', color: '#d97757', builtin: true, kind: 'claude' };
const MODELS = ['default', 'opus', 'sonnet', 'haiku'];
const STATUS_TTL = 10 * 60 * 1000;

let cached = { at: 0, status: null };
let refreshing = null;
let loginRun = null;
const busyChats = new Set();

function settings() {
  const s = (deps && deps.store.get()) || {};
  return {
    enabled: s.enabled !== false,
    model: MODELS.includes(s.model) ? s.model : 'default',
    level: ['edits', 'dev', 'full'].includes(s.level) ? s.level : 'dev',
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
  return { ready: !!(st.installed && st.loggedIn), installed: !!st.installed, plan: st.plan || '', email: st.email || '' };
}

function ready() { const p = promptState(); return !!(p && p.ready); }

function publicState(st) {
  const s = st || cached.status || {};
  return {
    installed: !!s.installed, loggedIn: !!s.loggedIn, email: s.email || '', plan: s.plan || '', org: s.org || '',
    authMethod: s.authMethod || '', version: s.version || '', error: s.error || '',
    installCommand: cc().installCommand(), loggingIn: !!loginRun, settings: settings(),
  };
}

// ─── The terminal mirror ────────────────────────────────────────────────────
const ESC = '\x1b[';
const C = { claude: `${ESC}38;5;173m`, dim: `${ESC}2m`, ok: `${ESC}32m`, bad: `${ESC}31m`, off: `${ESC}0m` };
function term(text) { try { deps.sendWindow('terminal:data', String(text).replace(/\r?\n/g, '\r\n')); } catch {} }
const oneLine = (s, n = 140) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

// ─── One run in a chat ──────────────────────────────────────────────────────

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

/**
 * Runs Claude Code for one claude_code call in a chat. Returns
 * { ok, text, actions, files, denials (strings), sessionId, round, costUsd, failed, rejected, auth }.
 */
async function runForChat({ session, task, chat, fresh, model, approve, signal, cwd }) {
  const st = current();
  if (!settings().enabled) return { ok: false, failed: 'Claude Code is turned off in Connect Apps.' };
  if (!st || !st.installed) return { ok: false, failed: 'Claude Code is not installed on this PC. The user can install it from Connect Apps, Claude Code.' };
  if (!st.loggedIn) return { ok: false, auth: true, failed: 'Claude Code is not logged in. The user can log in from Connect Apps, Claude Code.' };
  if (busyChats.has(session.id)) return { ok: false, failed: 'Claude Code is already working in this chat. Wait for its report.' };

  const prev = session.claudeCode && session.claudeCode.cwd === cwd ? session.claudeCode : null;
  const resume = !fresh && prev && prev.sessionId ? prev.sessionId : '';
  const round = resume ? (prev.round || 1) + 1 : 1;
  const conf = settings();

  // One yes per chat and folder; the later review rounds go straight through.
  if (!(prev && prev.approved)) {
    const can = conf.level === 'full' ? 'edit files and run any command here' : conf.level === 'edits' ? 'edit files here (no commands)' : 'edit files and run everyday dev commands here (npm, node, git status...)';
    const verdict = await approve({
      tool: 'claude_code',
      title: 'Let Claude Code work on this project',
      detail: `${oneLine(task, 600)}\n\nFolder: ${cwd}\nClaude Code uses your Claude plan. It can ${can}. It cannot push, deploy or publish; Codeply does that with your connected apps.`,
      danger: conf.level === 'full',
    });
    const v = verdict && typeof verdict === 'object' ? String(verdict.verdict || verdict.action || '') : String(verdict || '');
    if (v === 'reject') return { ok: false, rejected: true, failed: 'The user said no to Claude Code for this.' };
  }

  busyChats.add(session.id);
  const { taste, skills, dirs } = skillsFor(task, cwd);
  // Skills already named on an earlier round are in Claude's context; only new ones are listed again.
  const named = new Set((prev && resume && prev.skills) || []);
  const brief = cc().buildPrompt({ task, chat: round === 1 ? chat : '', round, skills: skills.filter((s) => !named.has(s.name)) });
  let appendFile = '';
  try {
    // The same text every job: one file per content, written once.
    const text = cc().systemAppend({ taste, level: conf.level });
    const dir = path.join(os.tmpdir(), 'codeply-claude');
    fs.mkdirSync(dir, { recursive: true });
    appendFile = path.join(dir, `system-${require('crypto').createHash('sha1').update(text).digest('hex').slice(0, 12)}.md`);
    if (!fs.existsSync(appendFile)) fs.writeFileSync(appendFile, text, 'utf8');
  } catch { appendFile = ''; }

  const card = { ...CARD, round };
  const startMsg = { kind: 'wisp_agent', phase: 'start', agent: card, task: oneLine(task, 600) };
  session.messages.push({ ...startMsg, at: Date.now() });
  deps.sendEvent(session.id, { type: 'wisp_agent', phase: 'start', agent: card, task: oneLine(task, 600) });
  term(`\n${C.claude}✳ Claude Code${C.off} ${C.dim}round ${round}${resume ? ' (resumed)' : ''} in ${cwd}${C.off}\n${C.dim}${oneLine(task, 200)}${C.off}\n`);

  const before = cc().snapshot(cwd);
  const pending = new Map(); // tool_use id -> { name, args, label }
  const actions = [];
  const denials = [];
  let result = null;
  let sessionId = resume;
  let lastText = '';
  try {
    const want = MODELS.includes(String(model || '').toLowerCase()) ? String(model).toLowerCase() : conf.model;
    const runIt = cc().run({ cwd, prompt: brief, resume, model: want, level: conf.level, appendFile, addDirs: dirs, signal });
    for await (const ev of runIt) {
      if (ev.type === 'init') {
        if (ev.sessionId) sessionId = ev.sessionId;
        session.claudeCode = { ...(session.claudeCode || {}), sessionId, cwd, approved: true, round, model: ev.model || '' };
        if (ev.model) term(`${C.dim}model ${ev.model}${C.off}\n`);
      } else if (ev.type === 'text') {
        if (ev.sub) continue;
        lastText = ev.text;
        session.messages.push({ kind: 'assistant', text: ev.text, interim: true, agent: card.id, at: Date.now() });
        deps.sendEvent(session.id, { type: 'text', text: ev.text, interim: true, agent: card.id });
        term(`${C.claude}│${C.off} ${oneLine(ev.text, 300)}\n`);
      } else if (ev.type === 'tool_start') {
        const t = cc().asCodeplyTool(ev.name, ev.input, cwd);
        const label = cc().labelOf(t);
        pending.set(ev.id, { ...t, label, claudeName: ev.name });
        deps.sendEvent(session.id, { type: 'tool_start', name: t.name, args: t.args, agent: card.id });
        term(`${C.claude}▸${C.off} ${ev.name}${label ? ` ${C.dim}${oneLine(label, 160)}${C.off}` : ''}\n`);
      } else if (ev.type === 'tool_end') {
        const t = pending.get(ev.id);
        if (!t) continue;
        pending.delete(ev.id);
        const exitCode = t.name === 'run' ? cc().exitCodeOf(ev.output, ev.ok) : undefined;
        const tail = t.name === 'run' ? String(ev.output || '').slice(-1500) : undefined;
        const out = {
          type: 'tool_end', name: t.name, args: t.args, ok: ev.ok, summary: t.label,
          meta: { label: t.label, ...(exitCode !== undefined ? { exitCode } : {}), ...(tail ? { output: tail } : {}) },
          error: ev.ok ? undefined : String(ev.output || '').slice(0, 800),
        };
        if (!ev.sub || ['edit_file', 'write_file', 'run'].includes(t.name)) {
          deps.recordToolEnd(session, out, { agent: card.id });
          deps.sendEvent(session.id, { ...out, agent: card.id });
        }
        actions.push({ tool: t.name, label: t.label, ok: ev.ok, ...(exitCode !== undefined ? { exitCode } : {}), by: 'Claude Code' });
        if (!ev.ok) term(`  ${C.bad}✗ ${oneLine(ev.output, 200)}${C.off}\n`);
      } else if (ev.type === 'denied') {
        denials.push({ tool: ev.tool, reason: ev.reason });
        term(`  ${C.dim}not allowed: ${ev.tool}${ev.reason ? ` (${oneLine(ev.reason, 120)})` : ''}${C.off}\n`);
      } else if (ev.type === 'result') {
        result = ev;
        if (ev.sessionId) sessionId = ev.sessionId;
      }
    }
  } catch (e) {
    result = { ok: false, error: e.message || String(e), denials: [] };
  } finally {
    busyChats.delete(session.id);
  }

  if (result && result.auth) { cached = { at: 0, status: null }; refresh().catch(() => {}); }
  const ok = !!(result && result.ok);
  const failed = ok ? '' : (result && (result.aborted ? 'stopped by the user' : result.error)) || 'Claude Code stopped';
  const text = String((result && result.text) || lastText || '').trim();
  // What it was not allowed to do, one line each: the result's list has the commands, the live events the reasons.
  const fromResult = ((result && result.denials) || []).map((d) => (d.input && d.input.command ? `${d.tool}: ${oneLine(d.input.command, 160)}` : d.tool));
  const notAllowed = [...new Set(fromResult.length ? fromResult : denials.map((d) => `${d.tool}${d.reason ? ` (${oneLine(d.reason, 120)})` : ''}`))].slice(0, 12);
  session.claudeCode = { ...(session.claudeCode || {}), sessionId: sessionId || (session.claudeCode && session.claudeCode.sessionId) || '', cwd, approved: true, round, lastAt: Date.now(), skills: [...new Set([...named, ...skills.map((s) => s.name)])] };
  session.updatedAt = Date.now();

  // Files changed by shell commands too (echo > file, generators): the folder before and after says.
  const disk = cc().diffSnapshots(before, cc().snapshot(cwd));
  const viaTools = new Set(actions.filter((a) => a.ok && ['edit_file', 'write_file'].includes(a.tool)).map((a) => a.label));
  for (const f of disk.added) if (!viaTools.has(f)) actions.push({ tool: 'write_file', label: f, ok: true, by: 'Claude Code', via: 'shell' });
  for (const f of disk.changed) if (!viaTools.has(f)) actions.push({ tool: 'edit_file', label: f, ok: true, by: 'Claude Code', via: 'shell' });
  const files = [...new Set(actions.filter((a) => a.ok && ['edit_file', 'write_file'].includes(a.tool)).map((a) => a.label).filter(Boolean))];
  const checks = actions.filter((a) => a.tool === 'run').map((a) => ({ tool: 'run', label: a.label, ok: a.ok, exitCode: a.exitCode }));
  const report = { phase: 'report', agent: card, text: text || (failed ? `Couldn't finish: ${failed}` : 'Done.'), ok, files: files.map((f) => f.split('/').pop()), checks: checks.slice(-10), costUsd: result && result.costUsd, turns: result && result.turns };
  session.messages.push({ kind: 'wisp_agent', ...report, at: Date.now() });
  deps.sendEvent(session.id, { type: 'wisp_agent', ...report });
  const cached = cc().cacheShare(result && result.usage);
  term(ok
    ? `${C.ok}✓ Claude Code finished${C.off} ${C.dim}${files.length} file${files.length === 1 ? '' : 's'} changed${result && result.turns ? `, ${result.turns} turns` : ''}${cached != null ? `, ${Math.round(cached * 100)}% of input from cache` : ''}${C.off}\n`
    : `${C.bad}✗ Claude Code did not finish:${C.off} ${oneLine(failed, 200)}\n`);

  return { ok, text, actions, files, removed: disk.removed.slice(0, 40), denials: notAllowed, sessionId, round, cached, costUsd: result && result.costUsd, failed, auth: !!(result && result.auth) };
}

// ─── Login, from the Connect Apps card ──────────────────────────────────────

function loginEvent(data) { try { deps.sendWindow('claudeCode:login', data); } catch {} }

function startLogin({ console: useConsole } = {}) {
  if (loginRun) return { ok: true, already: true };
  const run = cc().login({
    console: !!useConsole,
    onUrl: (url) => loginEvent({ phase: 'url', url }),
    onNeedCode: () => loginEvent({ phase: 'code' }),
    onOutput: (s) => term(`${C.dim}${s}${C.off}`),
  });
  loginRun = run;
  term(`\n${C.claude}✳ claude auth login${C.off} ${C.dim}(finish signing in in your browser)${C.off}\n`);
  run.done.then(async (r) => {
    loginRun = null;
    const st = await refresh();
    const ok = !!(r.ok && st && st.loggedIn);
    term(ok ? `${C.ok}✓ Claude Code is logged in${st.email ? ` as ${st.email}` : ''}${C.off}\n` : `${C.bad}✗ ${r.error || 'Not logged in'}${C.off}\n`);
    loginEvent({ phase: 'done', ok, error: ok ? '' : (r.error || 'The login did not finish.'), state: publicState(st) });
  });
  return { ok: true };
}

function init(d) {
  deps = d;
  const h = (ch, fn) => d.ipcMain.handle(ch, fn);
  h('claudeCode:state', async (e, opts) => publicState(opts && opts.refresh ? await refresh() : (current() || await refresh())));
  h('claudeCode:login', (e, opts) => startLogin(opts || {}));
  h('claudeCode:code', (e, code) => { if (loginRun) loginRun.submitCode(code); return { ok: !!loginRun }; });
  h('claudeCode:cancelLogin', () => { if (loginRun) loginRun.cancel(); return { ok: true }; });
  h('claudeCode:logout', async () => { const r = await cc().logout(); const st = await refresh(); return { ...r, state: publicState(st) }; });
  h('claudeCode:settings', (e, patch) => {
    const p = patch && typeof patch === 'object' ? patch : {};
    const next = { ...settings() };
    if (p.enabled !== undefined) next.enabled = !!p.enabled;
    if (MODELS.includes(p.model)) next.model = p.model;
    if (['edits', 'dev', 'full'].includes(p.level)) next.level = p.level;
    deps.store.set(next);
    return publicState();
  });
  refresh().catch(() => {});
}

module.exports = { init, runForChat, promptState, ready, refresh, CARD };
