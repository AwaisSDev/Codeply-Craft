/**
 * Claude Code as a background coding agent for Codeply.
 *
 * The user logs in to Claude Code once with their own Claude plan (Pro, Max,
 * Team) through `claude auth login`, the same browser sign-in the CLI does
 * itself. Claude Code keeps that login in its own config (~/.claude), so it
 * stays signed in between Codeply runs. Codeply never sees the token.
 *
 * Wisp (the main agent) then hands a coding task to Claude Code with the
 * claude_code tool. Claude Code runs headless (`claude -p`, stream-json) in
 * the chat's project folder; every step it takes comes back as an event, so
 * the chat shows its edits and commands like a specialist's, and Wisp gets
 * the factual record (files changed, commands with exit codes) to review.
 * The Claude session id is kept per chat, so Wisp can send it back with
 * fixes (`--resume`) and it remembers the work it did.
 *
 * Claude Code never publishes. It may not push, deploy or touch Vercel,
 * Supabase or GitHub; Codeply publishes with the user's own connected apps.
 *
 * This file is host-agnostic: no Electron. The desktop host is
 * claude-code-desktop.js (login card, approvals, the chat and terminal).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const IS_WIN = process.platform === 'win32';
const RUN_TIMEOUT_MS = 45 * 60 * 1000;
const STATUS_TIMEOUT_MS = 20 * 1000;

// ─── Finding the CLI ────────────────────────────────────────────────────────

/** Where Claude Code's installers put the binary, for apps started without the user's shell PATH. */
function candidates() {
  const home = os.homedir();
  const names = IS_WIN ? ['claude.exe', 'claude.cmd'] : ['claude'];
  const dirs = [];
  for (const p of String(process.env.PATH || '').split(path.delimiter)) if (p) dirs.push(p);
  dirs.push(path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local'));
  if (IS_WIN) {
    if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm'));
    if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'claude'));
  } else {
    dirs.push('/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.npm-global', 'bin'), path.join(home, '.bun', 'bin'));
  }
  const out = [];
  if (process.env.CODEPLY_CLAUDE_BIN) out.push(process.env.CODEPLY_CLAUDE_BIN);
  for (const d of dirs) for (const n of names) out.push(path.join(d, n));
  return [...new Set(out)];
}

let found = { at: 0, bin: null };

/** The claude binary, or null when Claude Code is not installed. Cached for a minute. */
function findClaude({ refresh = false } = {}) {
  if (!refresh && found.at && Date.now() - found.at < 60_000) return found.bin;
  let bin = null;
  for (const c of candidates()) {
    try { if (fs.statSync(c).isFile()) { bin = c; break; } } catch {}
  }
  found = { at: Date.now(), bin };
  return bin;
}

/** The installer command for this OS, to run in Codeply's terminal. */
function installCommand() {
  return IS_WIN
    ? 'irm https://claude.ai/install.ps1 | iex'
    : 'curl -fsSL https://claude.ai/install.sh | bash';
}

// A .cmd shim (npm's global install on Windows) only starts through the shell.
const winQuote = (a) => (/^[\w\-.,:=/\\@]+$/.test(a) ? a : `"${String(a).replace(/"/g, '""')}"`);

/** Starts the CLI with piped stdio. The bin's folder goes on PATH so its own helpers resolve. */
function spawnClaude(bin, args, { cwd, env } = {}) {
  const viaShell = IS_WIN && /\.cmd$/i.test(bin);
  const fullEnv = { ...process.env, ...(env || {}) };
  fullEnv.PATH = [path.dirname(bin), fullEnv.PATH || ''].filter(Boolean).join(path.delimiter);
  // Codeply drives it headless: no colour codes, no update prompts in the middle of a run.
  fullEnv.NO_COLOR = '1';
  fullEnv.DISABLE_AUTOUPDATER = fullEnv.DISABLE_AUTOUPDATER || '1';
  return spawn(viaShell ? winQuote(bin) : bin, viaShell ? args.map(winQuote) : args, {
    cwd: cwd && fs.existsSync(cwd) ? cwd : os.homedir(),
    env: fullEnv,
    shell: viaShell,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** Runs the CLI to the end. { code, stdout, stderr } */
function execClaude(bin, args, { timeout = STATUS_TIMEOUT_MS, input = null, cwd } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawnClaude(bin, args, { cwd }); } catch (e) { resolve({ code: -1, stdout: '', stderr: e.message }); return; }
    let stdout = ''; let stderr = '';
    const t = setTimeout(() => { try { child.kill(); } catch {} }, timeout);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { clearTimeout(t); resolve({ code: -1, stdout, stderr: stderr || e.message }); });
    child.on('close', (code) => { clearTimeout(t); resolve({ code: code == null ? -1 : code, stdout, stderr }); });
    if (input != null) child.stdin.end(input); else child.stdin.end();
  });
}

// ─── Login ──────────────────────────────────────────────────────────────────

/** What `claude auth status --json` says, in Codeply's words. Never throws. */
async function status({ refresh = false } = {}) {
  const bin = findClaude({ refresh });
  if (!bin) return { installed: false, loggedIn: false, installCommand: installCommand() };
  const r = await execClaude(bin, ['auth', 'status', '--json']);
  let j = null;
  try { j = JSON.parse(String(r.stdout).trim()); } catch {}
  if (!j) {
    // Older CLIs without `auth status`: they still answer --version.
    const v = await execClaude(bin, ['--version']);
    return { installed: v.code === 0, bin, version: String(v.stdout).trim().split(/\s/)[0] || '', loggedIn: false, unknown: true, error: (r.stderr || '').trim().slice(0, 300) };
  }
  const acct = j.account || j.oauthAccount || {};
  return {
    installed: true,
    bin,
    loggedIn: !!j.loggedIn,
    authMethod: j.authMethod || '',
    email: j.email || acct.email || acct.emailAddress || j.emailAddress || '',
    plan: j.subscriptionType || acct.subscriptionType || j.plan || '',
    org: j.orgName || acct.organizationName || j.organization || '',
    provider: j.apiProvider || '',
    expiresAt: j.loginExpiresAt || null,
  };
}

/**
 * `claude auth login`: Claude Code opens the browser for the user's Claude
 * account and saves the login itself. When the browser cannot hand the login
 * back on its own, the sign-in page shows a code; the user pastes it and
 * submitCode() passes it on.
 * @returns {{ child, submitCode(code), cancel(), done: Promise<{ok:boolean, error?:string}> }}
 */
function login({ console: useConsole = false, onUrl, onNeedCode, onOutput } = {}) {
  const bin = findClaude({ refresh: true });
  if (!bin) return { submitCode() {}, cancel() {}, done: Promise.resolve({ ok: false, error: 'Claude Code is not installed.' }) };
  const child = spawnClaude(bin, ['auth', 'login', useConsole ? '--console' : '--claudeai']);
  let buf = '';
  let urlSent = false; let askedCode = false; let settled = false;
  const onData = (d) => {
    const s = String(d);
    buf += s;
    if (onOutput) try { onOutput(s); } catch {}
    const m = !urlSent && buf.match(/https:\/\/\S+oauth\S*/i);
    if (m) { urlSent = true; if (onUrl) try { onUrl(m[0].replace(/[)\].,]+$/, '')); } catch {} }
    if (!askedCode && /paste (the )?code/i.test(buf)) { askedCode = true; if (onNeedCode) try { onNeedCode(); } catch {} }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  const done = new Promise((resolve) => {
    const t = setTimeout(() => { try { child.kill(); } catch {} }, 10 * 60 * 1000);
    child.on('error', (e) => { clearTimeout(t); settled = true; resolve({ ok: false, error: e.message }); });
    child.on('close', (code) => {
      clearTimeout(t);
      settled = true;
      if (code === 0) { resolve({ ok: true }); return; }
      const lines = buf.split(/\r?\n/).map((x) => x.trim()).filter((x) => x && !/^https:\/\//.test(x) && !/^if the browser/i.test(x));
      resolve({ ok: false, error: (lines.pop() || `Login stopped (exit ${code}).`).replace(/^paste code here if prompted\s*>\s*/i, '').slice(0, 300) });
    });
  });
  return {
    child,
    submitCode(code) { if (!settled && child.stdin.writable) child.stdin.write(`${String(code || '').trim()}\n`); },
    cancel() { if (!settled) try { child.kill(); } catch {} },
    done,
  };
}

async function logout() {
  const bin = findClaude();
  if (!bin) return { ok: false, error: 'Claude Code is not installed.' };
  const r = await execClaude(bin, ['auth', 'logout']);
  return r.code === 0 ? { ok: true } : { ok: false, error: (r.stderr || r.stdout || 'Logout failed').trim().slice(0, 300) };
}

// ─── Permissions ────────────────────────────────────────────────────────────

/** Never, at any level: Codeply publishes, Claude Code only builds. */
const DENY = [
  'Bash(git push:*)', 'Bash(git push *)', 'Bash(vercel:*)', 'Bash(vercel *)', 'Bash(npx vercel:*)', 'Bash(npx vercel *)',
  'Bash(supabase:*)', 'Bash(supabase *)', 'Bash(npx supabase:*)', 'Bash(npx supabase *)', 'Bash(gh:*)', 'Bash(gh *)',
  'Bash(netlify:*)', 'Bash(netlify *)', 'Bash(firebase deploy:*)', 'Bash(rm -rf /:*)', 'Bash(sudo:*)', 'Bash(sudo *)',
];

/** Everyday dev commands, for the default level. */
const DEV_COMMANDS = [
  'npm', 'npx', 'pnpm', 'yarn', 'bun', 'node', 'deno', 'tsc', 'vite', 'next', 'python', 'python3', 'pip', 'pip3', 'pytest',
  'ls', 'mkdir', 'cat', 'head', 'tail', 'wc', 'cp', 'mv', 'touch', 'echo', 'pwd', 'find', 'grep', 'sed', 'which',
  'git status', 'git diff', 'git log', 'git add', 'git init', 'git commit', 'git checkout', 'git branch', 'git show', 'git restore',
  'cargo', 'go', 'dotnet', 'php', 'composer', 'ruby', 'bundle', 'make',
];
const FILE_TOOLS = ['Read', 'Edit', 'MultiEdit', 'Write', 'Glob', 'Grep', 'LS', 'NotebookEdit', 'TodoWrite', 'WebSearch', 'WebFetch', 'Task'];

const LEVELS = ['edits', 'dev', 'full'];

/** --permission-mode / --allowedTools / --disallowedTools for a level. */
function permissionArgs(level) {
  const lv = LEVELS.includes(level) ? level : 'dev';
  if (lv === 'full') return { mode: 'bypassPermissions', allow: [], deny: DENY };
  const allow = [...FILE_TOOLS];
  if (lv === 'dev') for (const c of DEV_COMMANDS) allow.push(`Bash(${c}:*)`);
  return { mode: 'acceptEdits', allow, deny: DENY };
}

// ─── The brief ──────────────────────────────────────────────────────────────

const VISUAL = /\b(web ?site|landing|home ?page|page|site|ui|ux|design|screen|dashboard|portfolio|front-?end|css|html|tailwind|logo|poster|slides?|deck|hero|layout|style|theme|brand|component)\b/i;

/** Whether a task is something people look at, so the taste guide goes with it. */
function looksVisual(task) { return VISUAL.test(String(task || '')); }

/**
 * What Claude Code is told on top of its own system prompt: who it works
 * for, the house rules, and Codeply's taste guide and skills.
 * @param {{ skillsDir?: string, taste?: {dir:string, body:string}|null, skills?: {name:string, description?:string, file:string}[], level?: string }} o
 */
function systemAppend(o = {}) {
  const parts = [];
  parts.push(`YOU ARE WORKING FOR CODEPLY
Codeply is the user's own AI agent (its lead agent is called Wisp). The user asked Codeply for this work and Codeply handed the coding to you. Codeply reviews what you did: it reads which files you changed and which commands you ran (with their exit codes), opens the result in a browser, runs its design and code checks, and may send you back with fixes. So:
- Work only inside this project folder. Make the real thing, not a sketch: real copy, real states, no lorem ipsum, no TODO stubs.
- Never publish. Do not push, deploy, or create anything on Vercel, Supabase, Netlify, Firebase or GitHub, and do not ask for their tokens. Codeply publishes the project with the user's own connected accounts once it is ready. If something is only needed for publishing (environment variables, a database), write it down in your report.
- Do not start a dev server that keeps running. To check a page, build it or open it with a short command that exits.
- Check your own work before you finish (build, tests, a lint, the page's console).${o.level === 'edits' ? '\n- You may edit files but not run commands here. Say in your report which commands should be run.' : ''}
- Finish with a short report to Codeply, plain sentences: what you built or changed (the files), how you checked it and what the check showed, what is not done or uncertain, and what publishing will need.`);

  if (o.taste && o.taste.body) {
    const dir = o.taste.dir;
    parts.push(`CODEPLY TASTE (Codeply's design guide: follow it for anything people look at)
Codeply's tools in this guide are Codeply's, not yours: design_direction was already run by Codeply when the task has a DIRECTION sheet (follow that sheet: its idea, type, palette, imagery, sections and pitfalls), and Codeply runs design_lint on your result. Where the guide says read_file, use your Read tool on ${path.join(dir, 'references')}${path.sep}<name>.md. You can run the guide's static lint yourself: node "${path.join(dir, 'scripts', 'lint.mjs')}" <file or folder>. Where it says image_search / fetch_image, find real, credited photos with your web tools or leave a clearly named spot in assets/ and say so in your report.

${String(o.taste.body).replace(/^---[\s\S]*?---\s*/, '').trim()}`);
  }

  if (Array.isArray(o.skills) && o.skills.length) {
    parts.push(`CODEPLY SKILLS THAT FIT THIS TASK
Read the ones that apply before you start (Read the file):
${o.skills.map((s) => `- ${s.name}: ${String(s.description || '').replace(/\s+/g, ' ').slice(0, 200)} (${s.file})`).join('\n')}`);
  }
  return parts.join('\n\n');
}

/** The prompt for one round: the task, and on the first round the chat it came from. */
function buildPrompt({ task, chat, round = 1 }) {
  const t = String(task || '').trim();
  if (round > 1) {
    return `CODEPLY REVIEWED YOUR WORK AND SENDS YOU BACK (round ${round})\n${t}\n\nFix exactly this, check it, and report again the same way.`;
  }
  return `${t}${chat ? `\n\nTHE CHAT THIS CAME FROM (newest last; the user talks to Codeply, not to you):\n${chat}` : ''}`;
}

// ─── Running it ─────────────────────────────────────────────────────────────

const toText = (c) => (typeof c === 'string' ? c
  : Array.isArray(c) ? c.map((x) => (x && typeof x.text === 'string' ? x.text : '')).filter(Boolean).join('\n')
  : c == null ? '' : JSON.stringify(c));

/** One stream-json line from `claude -p`, as zero or more Codeply events. */
function normalize(e) {
  if (!e || typeof e !== 'object') return [];
  const sub = !!e.parent_tool_use_id;
  if (e.type === 'system' && e.subtype === 'init') {
    return [{ type: 'init', sessionId: e.session_id || '', model: e.model || '', cwd: e.cwd || '', version: e.claude_code_version || '' }];
  }
  if (e.type === 'system' && e.subtype === 'permission_denied') {
    return [{ type: 'denied', id: e.tool_use_id || '', tool: e.tool_name || '', reason: e.decision_reason || e.message || '' }];
  }
  if (e.type === 'assistant' && e.message && Array.isArray(e.message.content)) {
    const out = [];
    for (const c of e.message.content) {
      if (c.type === 'text' && String(c.text || '').trim()) out.push({ type: 'text', text: c.text, sub });
      else if (c.type === 'thinking' && String(c.thinking || '').trim()) out.push({ type: 'thinking', text: c.thinking, sub });
      else if (c.type === 'tool_use') out.push({ type: 'tool_start', id: c.id, name: c.name, input: c.input || {}, sub });
    }
    return out;
  }
  if (e.type === 'user' && e.message && Array.isArray(e.message.content)) {
    return e.message.content.filter((c) => c && c.type === 'tool_result').map((c) => ({
      type: 'tool_end', id: c.tool_use_id, ok: !c.is_error, output: toText(c.content), sub,
    }));
  }
  if (e.type === 'result') {
    const ok = e.subtype === 'success' && !e.is_error;
    return [{
      type: 'result', ok, text: typeof e.result === 'string' ? e.result : '',
      sessionId: e.session_id || '', costUsd: typeof e.total_cost_usd === 'number' ? e.total_cost_usd : null,
      turns: e.num_turns || 0, durationMs: e.duration_ms || 0,
      denials: Array.isArray(e.permission_denials) ? e.permission_denials.map((d) => ({ tool: d.tool_name, input: d.tool_input })) : [],
      error: ok ? '' : (e.subtype && e.subtype !== 'success' ? e.subtype.replace(/_/g, ' ') : '') || (typeof e.result === 'string' ? e.result : 'Claude Code stopped'),
    }];
  }
  return [];
}

const AUTH_ERR = /not logged in|please run .?\/?login|invalid api key|authentication|oauth token (has )?expired|401/i;

/**
 * Runs one Claude Code task headless and yields its events:
 *   init {sessionId, model}, text, thinking, tool_start {id, name, input},
 *   tool_end {id, ok, output}, denied {tool, reason},
 *   result {ok, text, sessionId, costUsd, turns, durationMs, denials, error, auth?}
 * Always ends with exactly one result. Stops when signal aborts.
 */
async function* run({ cwd, prompt, resume, model, level = 'dev', appendFile, addDirs = [], signal, timeoutMs = RUN_TIMEOUT_MS, bin: binIn } = {}) {
  const bin = binIn || findClaude();
  if (!bin) { yield { type: 'result', ok: false, error: 'Claude Code is not installed.', denials: [] }; return; }
  const perm = permissionArgs(level);
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', perm.mode];
  if (resume) args.push('--resume', String(resume));
  if (model && model !== 'default') args.push('--model', String(model));
  if (appendFile) args.push('--append-system-prompt-file', appendFile);
  for (const d of addDirs) if (d) args.push('--add-dir', d);
  if (perm.allow.length) args.push('--allowedTools', ...perm.allow);
  if (perm.deny.length) args.push('--disallowedTools', ...perm.deny);

  let child;
  try { child = spawnClaude(bin, args, { cwd }); } catch (e) { yield { type: 'result', ok: false, error: e.message, denials: [] }; return; }

  const queue = [];
  let wake = null;
  let closed = false; let exitCode = null; let stderr = ''; let lineBuf = '';
  const notify = () => { if (wake) { const w = wake; wake = null; w(); } };
  child.stdout.on('data', (d) => {
    lineBuf += d;
    let i;
    while ((i = lineBuf.indexOf('\n')) >= 0) {
      const line = lineBuf.slice(0, i).trim();
      lineBuf = lineBuf.slice(i + 1);
      if (!line || line[0] !== '{') continue;
      try { queue.push(...normalize(JSON.parse(line))); } catch {}
    }
    notify();
  });
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-8000); });
  child.on('error', (e) => { stderr += `\n${e.message}`; closed = true; notify(); });
  child.on('close', (code) => {
    if (lineBuf.trim().startsWith('{')) { try { queue.push(...normalize(JSON.parse(lineBuf.trim()))); } catch {} }
    exitCode = code; closed = true; notify();
  });
  const kill = () => { try { child.kill(); } catch {} };
  const timer = setTimeout(kill, timeoutMs);
  let aborted = false;
  const onAbort = () => { aborted = true; kill(); };
  if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
  child.stdin.end(String(prompt || ''));

  let gotResult = false; let sessionId = '';
  try {
    while (true) {
      while (queue.length) {
        const ev = queue.shift();
        if (ev.type === 'init' && ev.sessionId) sessionId = ev.sessionId;
        if (ev.type === 'result') {
          gotResult = true;
          if (!ev.ok && AUTH_ERR.test(`${ev.error} ${stderr}`)) ev.auth = true;
        }
        yield ev;
      }
      if (closed) break;
      await new Promise((r) => { wake = r; });
    }
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
    if (!closed) kill();
  }
  if (!gotResult) {
    const tail = stderr.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' ').slice(0, 400);
    yield {
      type: 'result', ok: false, sessionId, denials: [],
      error: aborted ? 'stopped' : tail || `Claude Code exited with code ${exitCode}`,
      ...(AUTH_ERR.test(tail) ? { auth: true } : {}),
      aborted,
    };
  }
}

// ─── Claude's steps in Codeply's words ──────────────────────────────────────

function rel(p, cwd) {
  const s = String(p || '');
  if (!s) return '';
  if (cwd && path.isAbsolute(s)) {
    const r = path.relative(cwd, s);
    if (r && !r.startsWith('..') && !path.isAbsolute(r)) return r.replace(/\\/g, '/');
  }
  return s.replace(/\\/g, '/');
}

/** A Claude Code tool call as the Codeply tool row the chat already knows how to draw. */
function asCodeplyTool(name, input, cwd) {
  const i = input || {};
  switch (name) {
    case 'Edit': case 'MultiEdit': return { name: 'edit_file', args: { path: rel(i.file_path, cwd) } };
    case 'Write': return { name: 'write_file', args: { path: rel(i.file_path, cwd) } };
    case 'NotebookEdit': return { name: 'edit_file', args: { path: rel(i.notebook_path, cwd) } };
    case 'Read': return { name: 'read_file', args: { path: rel(i.file_path, cwd) } };
    case 'Bash': case 'PowerShell': return { name: 'run', args: { command: String(i.command || '').slice(0, 500) } };
    case 'Glob': return { name: 'search', args: { pattern: String(i.pattern || '') } };
    case 'Grep': return { name: 'search', args: { pattern: String(i.pattern || '') } };
    case 'LS': return { name: 'list_dir', args: { path: rel(i.path, cwd) || '.' } };
    case 'WebFetch': return { name: 'web_fetch', args: { url: String(i.url || '') } };
    case 'WebSearch': return { name: 'web_search', args: { query: String(i.query || '') } };
    case 'TodoWrite': return { name: 'todo', args: {} };
    case 'Task': case 'Agent': return { name: 'claude_task', args: { label: String(i.description || 'a helper agent') } };
    default: return { name: 'claude_tool', args: { label: name } };
  }
}

/** The label a row shows for a mapped tool. */
function labelOf(t) {
  return String(t.args.path || t.args.command || t.args.pattern || t.args.url || t.args.query || t.args.label || '').slice(0, 200);
}

/** "Exit code 2" at the top of a failed Bash result. */
function exitCodeOf(output, ok) {
  const m = /^\s*Exit code (\d+)/i.exec(String(output || ''));
  if (m) return Number(m[1]);
  return ok ? 0 : undefined;
}

module.exports = {
  findClaude, installCommand, status, login, logout,
  permissionArgs, LEVELS, DENY,
  looksVisual, systemAppend, buildPrompt,
  run, normalize, asCodeplyTool, labelOf, exitCodeOf, rel,
};
