// Claude Code as Wisp's background coding agent (npm run test:claude-code).
// A fake `claude` binary (CODEPLY_CLAUDE_BIN) stands in for the real CLI: it
// answers `auth status --json`, does a `auth login` that asks for a pasted
// code, and runs `-p` jobs that really write a file and stream stream-json
// events. Then the real host (claude-code-desktop.js, wisp-desktop.js) and the
// real runAgent loop drive it against a scripted fake model: Wisp hands the
// build to Claude Code, reviews it, sends it back (the Claude session
// resumes), and the claim audit counts Claude's edits as the turn's own.
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import { createRequire } from 'module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'codeply-cli');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'codeply-cc-'));
process.env.CODEPLY_BRAIN_DB = path.join(scratch, 'brain.db');
process.env.CODEPLY_WISP_DIR = path.join(scratch, 'wisp');
process.env.HOME = scratch;
process.env.USERPROFILE = scratch;
const require = createRequire(import.meta.url);

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + String(extra).slice(0, 600)}`);
  if (!cond) failures++;
}

// ── The fake claude CLI ──
const LOG = path.join(scratch, 'claude-calls.jsonl');
const LOGGED = path.join(scratch, 'claude-logged-in');
const fake = path.join(scratch, process.platform === 'win32' ? 'claude.cmd' : 'claude');
const fakeJs = path.join(scratch, 'fake-claude.cjs');
fs.writeFileSync(fakeJs, `
const fs = require('fs'); const path = require('path');
const argv = process.argv.slice(2);
const LOG = ${JSON.stringify(LOG)}; const LOGGED = ${JSON.stringify(LOGGED)};
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let input = '';
process.stdin.on('data', (d) => { input += d; });
if (argv[0] === 'auth' && argv[1] === 'status') {
  const on = fs.existsSync(LOGGED);
  console.log(JSON.stringify(on ? { loggedIn: true, authMethod: 'claude.ai', email: 'awais@example.com', subscriptionType: 'max' } : { loggedIn: false }, null, 2));
  process.exit(on ? 0 : 1);
} else if (argv[0] === 'auth' && argv[1] === 'login') {
  process.stdout.write("Opening browser to sign in…\\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=abc\\nPaste code here if prompted > ");
  process.stdin.on('data', () => {
    if (input.includes('\\n')) {
      if (input.trim() === 'good-code') { fs.writeFileSync(LOGGED, '1'); console.log('Login successful.'); process.exit(0); }
      console.log('Invalid code. Please make sure the full code was copied.'); process.exit(1);
    }
  });
} else if (argv[0] === 'auth' && argv[1] === 'logout') {
  try { fs.unlinkSync(LOGGED); } catch {}
  process.exit(0);
} else if (argv[0] === '-p') {
  process.stdin.on('end', () => {
    const i = argv.indexOf('--resume');
    const sid = i >= 0 ? argv[i + 1] : 'sess-1';
    const f = argv.indexOf('--append-system-prompt-file');
    const sys = f >= 0 ? fs.readFileSync(argv[f + 1], 'utf8') : '';
    fs.appendFileSync(LOG, JSON.stringify({ argv, prompt: input, sys, cwd: process.cwd() }) + '\\n');
    if (!fs.existsSync(LOGGED)) { process.stderr.write('Not logged in · Please run /login\\n'); process.exit(1); }
    const round2 = i >= 0;
    out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-fake-1', cwd: process.cwd() });
    out({ type: 'assistant', message: { content: [{ type: 'text', text: round2 ? 'Fixing the contrast.' : 'Building the landing page.' }] }, session_id: sid });
    const file = path.join(process.cwd(), 'index.html');
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: round2 ? 'Edit' : 'Write', input: { file_path: file } }] }, session_id: sid });
    fs.writeFileSync(file, round2 ? '<h1 style="color:#111">Bakery</h1>\\n' : '<h1 style="color:#ccc">Bakery</h1>\\n');
    if (!round2) { fs.writeFileSync(path.join(process.cwd(), 'styles.css'), 'h1{}\\n'); try { fs.unlinkSync(path.join(process.cwd(), 'old.txt')); } catch {} }
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'File written', is_error: false }] }, session_id: sid });
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'node --check app.js' } }] }, session_id: sid });
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: round2 ? '' : 'Exit code 1\\nSyntaxError', is_error: !round2 }] }, session_id: sid });
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'vercel deploy' } }] }, session_id: sid });
    out({ type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: 't3', decision_reason: 'denied by rule' });
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't3', content: 'Permission denied', is_error: true }] }, session_id: sid });
    out({ type: 'result', subtype: 'success', is_error: false, result: round2 ? 'Darkened the headline to #111.' : 'Built index.html with the bakery hero.', session_id: sid, num_turns: 4, total_cost_usd: 0.01, duration_ms: 1200,
      permission_denials: [{ tool_name: 'Bash', tool_use_id: 't3', tool_input: { command: 'vercel deploy' } }] });
    process.exit(0);
  });
} else { console.log('2.9.0 (Claude Code)'); process.exit(0); }
`);
if (process.platform === 'win32') fs.writeFileSync(fake, `@node "${fakeJs}" %*\r\n`);
else { fs.writeFileSync(fake, `#!/bin/sh\nexec node "${fakeJs}" "$@"\n`); fs.chmodSync(fake, 0o755); }
process.env.CODEPLY_CLAUDE_BIN = fake;

const ccLib = require(path.join(CLI, 'lib/claude-code.js'));
const agentMod = await import(pathToFileURL(path.join(CLI, 'lib/agent.mjs')).href);
const wisp = require(path.join(CLI, 'lib/wisp.js'));
const claudeHost = require(path.join(ROOT, 'claude-code-desktop.js'));
const host = require(path.join(ROOT, 'wisp-desktop.js'));

// 1. The library on its own.
{
  check('find: the CLI from CODEPLY_CLAUDE_BIN', ccLib.findClaude({ refresh: true }) === fake);
  const off = await ccLib.status({ refresh: true });
  check('status: installed, not logged in', off.installed && !off.loggedIn, JSON.stringify(off));

  let url = ''; let asked = false;
  const bad = ccLib.login({ onUrl: (u) => { url = u; }, onNeedCode: () => { asked = true; } });
  await new Promise((r) => setTimeout(r, 300));
  bad.submitCode('wrong');
  const badR = await bad.done;
  check('login: the sign-in link and the code prompt come through', url.startsWith('https://claude.com/cai/oauth/authorize') && asked, url);
  check('login: a wrong code fails with the CLI\'s reason', !badR.ok && /Invalid code/.test(badR.error), JSON.stringify(badR));
  const good = ccLib.login({});
  await new Promise((r) => setTimeout(r, 300));
  good.submitCode('good-code');
  check('login: the right code logs in', (await good.done).ok);
  const on = await ccLib.status({ refresh: true });
  check('status: logged in, with the email and plan', on.loggedIn && on.email === 'awais@example.com' && on.plan === 'max', JSON.stringify(on));

  const dev = ccLib.permissionArgs('dev');
  check('permissions: dev edits and runs npm, never deploys', dev.mode === 'acceptEdits' && dev.allow.includes('Edit') && dev.allow.includes('Bash(npm:*)') && dev.deny.includes('Bash(vercel:*)') && dev.deny.includes('Bash(git push:*)'));
  check('permissions: edits runs no commands', !ccLib.permissionArgs('edits').allow.some((a) => a.startsWith('Bash')));
  check('permissions: full still never publishes', ccLib.permissionArgs('full').mode === 'bypassPermissions' && ccLib.permissionArgs('full').deny.includes('Bash(gh:*)'));
  check('visual: a website is visual, a migration is not', ccLib.looksVisual('Build a landing page for a bakery') && !ccLib.looksVisual('Add a migration for the orders table'));
  const taste = { dir: '/x/codeply-taste', body: '---\nname: codeply-taste\n---\n# Codeply taste\nOne idea.' };
  const sys = ccLib.systemAppend({ taste });
  check('brief: house rules and the taste body without frontmatter', /Never publish/.test(sys) && /# Codeply taste\nOne idea/.test(sys) && !/name: codeply-taste/.test(sys) && sys.includes('lint.mjs'));
  check('brief: the system part is the same for every job (cache)', ccLib.systemAppend({ taste }) === sys);
  const p1 = ccLib.buildPrompt({ task: 'Build it', skills: [{ name: 'seo', description: 'Search', file: '/x/seo/SKILL.md' }] });
  check('brief: the skills that fit go in the prompt, not the system part', p1.includes('/x/seo/SKILL.md') && !sys.includes('SKILL.md'));
  check('brief: a later round says it was reviewed', /REVIEWED YOUR WORK[\s\S]*round 2/.test(ccLib.buildPrompt({ task: 'Darken the h1', round: 2 })));
  check('map: Claude tools become Codeply rows', ccLib.asCodeplyTool('Edit', { file_path: '/p/src/a.js' }, '/p').name === 'edit_file' && ccLib.asCodeplyTool('Edit', { file_path: '/p/src/a.js' }, '/p').args.path === 'src/a.js' && ccLib.asCodeplyTool('Bash', { command: 'ls' }).name === 'run');
  check('map: exit code from a failed Bash result', ccLib.exitCodeOf('Exit code 2\nboom', false) === 2 && ccLib.exitCodeOf('ok', true) === 0);

  const proj = fs.mkdtempSync(path.join(scratch, 'lib-'));
  const evs = [];
  for await (const ev of ccLib.run({ cwd: proj, prompt: 'Build it' })) evs.push(ev);
  const res = evs.find((e) => e.type === 'result');
  check('run: init, steps and one result', evs[0].type === 'init' && evs[0].sessionId === 'sess-1' && evs.filter((e) => e.type === 'tool_start').length === 3 && evs.filter((e) => e.type === 'result').length === 1);
  check('run: the result text, cost and denials', res.ok && /bakery hero/.test(res.text) && res.costUsd === 0.01 && res.denials[0].input.command === 'vercel deploy', JSON.stringify(res));
  check('run: the file is really written in the project', fs.existsSync(path.join(proj, 'index.html')));
  const call = JSON.parse(fs.readFileSync(LOG, 'utf8').trim().split('\n').pop());
  check('run: headless stream-json, prompt on stdin, in the project folder', call.argv.includes('stream-json') && call.argv.includes('--verbose') && call.prompt === 'Build it' && fs.realpathSync(call.cwd) === fs.realpathSync(proj));

  const ac = new AbortController(); ac.abort();
  const stopped = [];
  for await (const ev of ccLib.run({ cwd: proj, prompt: 'x', signal: ac.signal })) stopped.push(ev);
  check('run: an aborted run still ends with one result', stopped.length >= 1 && stopped[stopped.length - 1].type === 'result' && !stopped[stopped.length - 1].ok);
}

// ── The fake model, for Wisp ──
let script = [];
let bodies = [];
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    bodies.push(raw ? JSON.parse(raw) : {});
    const next = script.shift() ?? 'All done.';
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const piece of String(next).match(/[\s\S]{1,40}/g) || ['']) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const route = { custom: { id: 't', name: 'Fake', kind: 'openai', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'fake', apiKey: 'x', toolMode: 'text' } };
const systemOf = (b) => (b.messages || []).filter((m) => m.role === 'system').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
const lastUserOf = (b) => { const u = (b.messages || []).filter((m) => m.role === 'user' || m.role === 'tool').pop(); return u ? (typeof u.content === 'string' ? u.content : JSON.stringify(u.content)) : ''; };

// ── The hosts, with a fake window ──
const sent = []; const termOut = []; const handlers = {};
let ccStore = {};
claudeHost.init({
  ipcMain: { handle(ch, fn) { handlers[ch] = fn; } },
  cliDir: CLI,
  sendEvent: (id, ev) => sent.push(ev),
  sendWindow: (ch, data) => { if (ch === 'terminal:data') termOut.push(data); },
  recordToolEnd: (session, ev, extra) => session.messages.push({ kind: 'tool', name: ev.name, ok: ev.ok, label: ev.summary, ...extra }),
  store: { get: () => ccStore, set: (next) => { ccStore = { ...ccStore, ...next }; } },
});
host.init({
  ipcMain: { handle() {} }, cliDir: CLI, sendEvent: (id, ev) => sent.push(ev), agentMod: () => agentMod, browser: null,
  recordToolEnd: (session, ev, extra) => session.messages.push({ kind: 'tool', name: ev.name, ok: ev.ok, ...extra }),
  settings: { get: () => true, set() {} },
});

// 2. The Connect Apps card's state and settings.
{
  const st = await handlers['claudeCode:state']({}, { refresh: true });
  check('card: connected, with who and the default settings', st.installed && st.loggedIn && st.email === 'awais@example.com' && st.settings.level === 'dev' && st.settings.model === 'default' && st.settings.enabled, JSON.stringify(st));
  const s2 = handlers['claudeCode:settings']({}, { model: 'opus', level: 'nonsense' });
  check('card: a model is saved, an unknown level is ignored', s2.settings.model === 'opus' && s2.settings.level === 'dev' && ccStore.model === 'opus');
  handlers['claudeCode:settings']({}, { model: 'default' });
}

// 3. The prompt.
{
  const ready = wisp.wispPrompt({ native: false, claudeCode: { ready: true, installed: true, plan: 'max', email: 'a@b.c' } });
  check('prompt: connected, it knows how to brief, review and publish', /CLAUDE CODE \(connected: max plan, a@b\.c\)/.test(ready) && /design_direction first/.test(ready) && /Review it yourself/.test(ready) && /Claude Code never publishes/.test(ready) && ready.includes('<codeply:claude_code>'));
  check('prompt: native leaves out the tag format', !wisp.wispPrompt({ native: true, claudeCode: { ready: true } }).includes('<codeply:claude_code>'));
  const notYet = wisp.wispPrompt({ native: false, claudeCode: { ready: false, installed: true } });
  check('prompt: not connected, it tells the user where to log in', /Not connected \(installed, not logged in\)/.test(notYet) && /Connect Apps/.test(notYet) && !notYet.includes('<codeply:claude_code>'));
  check('prompt: off, nothing about Claude Code', !/CLAUDE CODE/.test(wisp.wispPrompt({ native: false })));
  const lead = agentMod.buildSystemSections('Build', scratch, 'hi', { agentRole: 'lead', botPrompt: ready });
  check('prompt: the lead rule names claude_code', /or Claude Code with claude_code/.test(lead.core));
}

// 4. Wisp hands the build to Claude Code, reviews, sends it back, reports.
{
  const cwd = fs.mkdtempSync(path.join(scratch, 'proj-'));
  fs.writeFileSync(path.join(cwd, 'old.txt'), 'gone soon');
  const session = { id: 'chat-1', messages: [{ kind: 'user', text: 'hey wisp, can you use Claude to make a website for my bakery?' }] };
  let approvals = 0;
  const approve = async (req) => { approvals++; return req.tool === 'claude_code' ? 'once' : 'once'; };
  const signal = new AbortController().signal;
  fs.writeFileSync(LOG, '');
  script = [
    '<codeply:claude_code>\n<task>\nBuild a one-page website for a family bakery in index.html. DIRECTION: warm, editorial serif.\n</task>\n</codeply:claude_code>',
    '<codeply:claude_code>\n<task>\nThe h1 is #ccc on white, too faint. Make it #111.\n</task>\n</codeply:claude_code>',
    '[mood: proud]\nYour bakery site is built: Claude Code wrote index.html and I had it darken the headline after my review.',
  ];
  const w = host.forTurn({ session, approve, signal, route, cwd, mode: 'Build' });
  check('turn: Wisp gets claude_code once Claude Code is logged in', w && typeof w.claudeCode === 'function');
  const events = [];
  for await (const raw of agentMod.runAgent({
    userMessage: 'hey wisp, can you use Claude to make a website for my bakery?', history: [], mode: 'Build', cwd, approve, signal, route, maxSteps: 12,
    botPrompt: (native) => w.prompt(native), bringIn: w.bringIn, claudeCode: w.claudeCode, createSpecialist: w.createSpecialist, schedule: w.schedule, agentRole: w.agentRole,
  })) events.push(w.mood(raw));

  const calls = fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  check('turn: Claude Code ran twice', calls.length === 2, calls.length);
  check('turn: the first brief has the task and the chat it came from', /family bakery/.test(calls[0].prompt) && /THE CHAT THIS CAME FROM[\s\S]*bakery/.test(calls[0].prompt));
  check('turn: a website brief carries Codeply taste', /CODEPLY TASTE/.test(calls[0].sys) && /# Codeply taste/.test(calls[0].sys) && calls[0].argv.includes('--add-dir'));
  check('turn: both rounds get the same system part (Claude Code reads it from its cache)', calls[0].sys === calls[1].sys && calls[0].sys.length > 1000);
  check('turn: round 2 resumes the same Claude session', calls[1].argv.includes('--resume') && calls[1].argv[calls[1].argv.indexOf('--resume') + 1] === 'sess-1' && /round 2/.test(calls[1].prompt));
  check('turn: one approval for both rounds', approvals === 1, approvals);
  const report = lastUserOf(bodies[1]);
  check('turn: Wisp gets the report and what Claude Code really did', /CLAUDE CODE'S REPORT \(round 1\)/.test(report) && /Files changed: index\.html/.test(report) && /node --check app\.js`: FAILED \(exit 1\)/.test(report), report);
  check('turn: files written by shell commands and deletions are in the record too', /Files changed: [^\n]*styles\.css/.test(report) && /Files deleted: old\.txt/.test(report), report);
  check('turn: Wisp is told what was not allowed and to review', /Not allowed to run[\s\S]*vercel deploy/.test(report) && /Now review it/.test(report));
  check('turn: the file holds round 2\'s fix', /#111/.test(fs.readFileSync(path.join(cwd, 'index.html'), 'utf8')));
  const done = events.find((e) => e.type === 'done');
  check('turn: Claude\'s edits count as the turn\'s own (no false-claim audit)', done && done.madeAnyEdit && done.actions.some((a) => a.by === 'Claude Code' && a.tool === 'write_file'), JSON.stringify(done && done.actions));
  const final = events.filter((e) => e.type === 'text' && !e.interim).map((e) => e.text).join('\n');
  check('turn: Wisp answers in its own words', /bakery site is built/.test(final), final);
  const notes = sent.filter((e) => e.type === 'wisp_agent' && e.agent && e.agent.kind === 'claude');
  check('chat: start and report notes for each round', notes.filter((n) => n.phase === 'start').length === 2 && notes.filter((n) => n.phase === 'report').length === 2 && notes[2].agent.round === 2);
  check('chat: Claude\'s steps show as Codeply rows', sent.some((e) => e.type === 'tool_end' && e.agent === 'claude-code' && e.name === 'write_file' && e.args.path === 'index.html') && sent.some((e) => e.type === 'tool_end' && e.agent === 'claude-code' && e.name === 'run' && e.meta.exitCode === 1));
  check('chat: the session remembers the Claude session', session.claudeCode && session.claudeCode.sessionId === 'sess-1' && session.claudeCode.round === 2 && session.claudeCode.approved);
  check('terminal: the run is mirrored to the terminal', termOut.join('').includes('Claude Code') && termOut.join('').includes('Write') && termOut.join('').includes('\r\n'));
  check('prompt: Wisp saw the connected section', /CLAUDE CODE \(connected: max plan, awais@example\.com\)/.test(systemOf(bodies[0])));
}

// 5. Saying no, and a lost login.
{
  const cwd = fs.mkdtempSync(path.join(scratch, 'proj-'));
  const session = { id: 'chat-2', messages: [] };
  const w = host.forTurn({ session, approve: async () => 'reject', signal: new AbortController().signal, route, cwd, mode: 'Build' });
  const r = await w.claudeCode({ task: 'Build a site' });
  check('no: the user says no, nothing runs', !r.ok && r.meta && r.meta.rejected && !fs.existsSync(path.join(cwd, 'index.html')));
  fs.unlinkSync(LOGGED);
  await handlers['claudeCode:state']({}, { refresh: true });
  const w2 = host.forTurn({ session: { id: 'chat-3', messages: [] }, approve: async () => 'once', signal: new AbortController().signal, route, cwd, mode: 'Build' });
  check('logged out: claude_code is not offered', w2 && w2.claudeCode === undefined);
  check('logged out: the prompt tells the user where to log in', /Not connected \(installed, not logged in\)/.test(w2.prompt(false)));
  const plan = host.forTurn({ session: { id: 'chat-4', messages: [] }, approve: async () => 'once', signal: new AbortController().signal, route, cwd, mode: 'Build', verifyOnly: true });
  check('verify-only turns never hand work to Claude Code', !plan.claudeCode);
}

server.close();
try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
console.log(failures ? `\n${failures} FAILED` : '\nAll passed');
process.exit(failures ? 1 : 0);
