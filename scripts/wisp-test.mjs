// Wisp: the main agent and its team (npm run test:wisp).
// Drives the real runAgent loop and the real desktop host (wisp-desktop.js)
// against a scripted fake model: Wisp brings in a specialist, the specialist
// really edits and checks a file, Wisp reports it, and the claim audit lets
// that through because the specialist's tool record counts for Wisp's turn.
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import { createRequire } from 'module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'codeply-cli');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'codeply-wisp-'));
process.env.CODEPLY_BRAIN_DB = path.join(scratch, 'brain.db');
process.env.CODEPLY_WISP_DIR = path.join(scratch, 'wisp');
process.env.HOME = scratch; // models saved by these checks go to a throwaway ~/.codeply
process.env.USERPROFILE = scratch;
const agentMod = await import(pathToFileURL(path.join(CLI, 'lib/agent.mjs')).href);
const require = createRequire(import.meta.url);
const wisp = require(path.join(CLI, 'lib/wisp.js'));
const host = require(path.join(ROOT, 'wisp-desktop.js'));

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + String(extra).slice(0, 600)}`);
  if (!cond) failures++;
}

// ── The fake model ──
let script = [];
let bodies = [];
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    bodies.push(body);
    const next = script.shift() ?? 'All done.';
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (next && typeof next === 'object') {
      next.tool_calls.forEach((tc, index) => {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index, id: `call_${index}`, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.args) } }] } }] })}\n\n`);
      });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
    } else {
      for (const piece of String(next).match(/[\s\S]{1,40}/g) || ['']) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const textRoute = { custom: { id: 't', name: 'Fake', kind: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'fake', apiKey: 'x', toolMode: 'text' } };
const nativeRoute = { custom: { ...textRoute.custom, toolMode: 'native' } };
const systemOf = (b) => (b.messages || []).filter((m) => m.role === 'system').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
const lastUserOf = (b) => { const u = (b.messages || []).filter((m) => m.role === 'user' || m.role === 'tool').pop(); return u ? (typeof u.content === 'string' ? u.content : JSON.stringify(u.content)) : ''; };

// ── The host, with a fake window ──
const sent = [];
let wispOn = true;
host.init({
  ipcMain: { handle() {} },
  cliDir: CLI,
  sendEvent: (id, ev) => sent.push(ev),
  agentMod: () => agentMod,
  browser: null,
  recordToolEnd: (session, ev, extra) => session.messages.push({ kind: 'tool', name: ev.name, ok: ev.ok, ...extra }),
  settings: { get: () => wispOn, set: (on) => { wispOn = on; } },
});

async function wispTurn(replies, userMessage, { route = textRoute, session } = {}) {
  script = [...replies];
  bodies = [];
  sent.length = 0;
  const cwd = fs.mkdtempSync(path.join(scratch, 'proj-'));
  fs.writeFileSync(path.join(cwd, 'cart.js'), 'module.exports = (items) => items.reduce((s, i) => s + i.price * 1.2 * 1.2, 0);\n');
  session = session || { id: 's1', messages: [] };
  const approve = async () => 'once';
  const signal = new AbortController().signal;
  const w = host.forTurn({ session, approve, signal, route, cwd, mode: 'Build' });
  const events = [];
  for await (const raw of agentMod.runAgent({
    userMessage, history: [], mode: 'Build', cwd, approve, signal, route, maxSteps: 12,
    botPrompt: (native) => w.prompt(native), bringIn: w.bringIn, createSpecialist: w.createSpecialist, schedule: w.schedule, agentRole: w.agentRole,
  })) events.push(w.mood(raw));
  return { events, cwd, session, done: events.find((e) => e.type === 'done'), texts: events.filter((e) => e.type === 'text' && !e.interim).map((e) => e.text) };
}

// 1. The team and the library.
{
  const team = wisp.listSpecialists();
  check('team: seven built-in specialists', team.filter((s) => s.builtin).length === 7, team.map((s) => s.name).join());
  check('team: shown by their role names', ['Frontend', 'Backend', 'Database', 'DevOps', 'Security', 'Testing', 'Docs'].every((n) => team.some((s) => s.name === n)));
  check('find: "the frontend specialist" and the old name Pixel', wisp.findSpecialist('the frontend specialist')?.id === 'frontend' && wisp.findSpecialist('Pixel')?.id === 'frontend');
  check('create: a built-in name alone is refused', !wisp.createSpecialist({ name: 'Testing' }).ok);
  const tuned = wisp.createSpecialist({ name: 'Testing', instructions: 'Always run the whole suite, not one file.' });
  check('create: a built-in name with instructions tunes it (house rules)', tuned.ok && tuned.updated && /whole suite/.test(wisp.findSpecialist('testing').notes) && /HOUSE RULES[\s\S]*whole suite/.test(wisp.specialistPrompt(wisp.findSpecialist('testing'))));
  wisp.updateSpecialist('testing', { notes: '' });
  check('create: needs a focus and instructions', !wisp.createSpecialist({ name: 'Nobody' }).ok);
  const made = wisp.createSpecialist({ name: 'Copywriter', focus: 'Landing page copy', instructions: 'Write short, concrete copy. Read it aloud before you report.', shape: 'star' });
  check('create: a new specialist joins the team', made.ok && !made.updated && wisp.findSpecialist('copywriter')?.focus === 'Landing page copy', JSON.stringify(made));
  check('create: keeps the shape it asked for', made.specialist.shape === 'star');
  const again = wisp.createSpecialist({ name: 'copywriter', instructions: 'Write short copy. No exclamation marks.' });
  check('create: the same name refines it', again.ok && again.updated && again.specialist.version === 2 && again.specialist.focus === 'Landing page copy' && /No exclamation/.test(again.specialist.instructions));
  check('remove: a specialist Wisp made can go', wisp.removeSpecialist('copywriter') && !wisp.findSpecialist('Copywriter'));
  check('mood: tag split off', JSON.stringify(wisp.parseMood('[mood: proud]\nAll fixed.')) === JSON.stringify({ mood: 'proud', text: 'All fixed.' }));
  check('mood: unknown mood falls back to neutral', wisp.parseMood('[Mood=grumpy] ok').mood === 'neutral');
  check('mood: no tag, text untouched', wisp.parseMood('Hello').mood === null && wisp.parseMood('Hello').text === 'Hello');
}

// 2. The prompts.
{
  const lead = agentMod.buildSystemSections('Build', scratch, 'hi', { agentRole: 'lead', botPrompt: wisp.wispPrompt({ native: false }) });
  check('prompt: Wisp may bring people in (the one-agent rule is swapped)', /You are Codeply, the lead agent/.test(lead.core) && !/There is no one to delegate to/.test(lead.core));
  check('prompt: Wisp knows its team and the bring_in format', /YOUR TEAM\n- Frontend: /.test(lead.project) && lead.project.includes('<codeply:bring_in>') && /YOUR FACE/.test(lead.project));
  const nat = wisp.wispPrompt({ native: true });
  check('prompt: the agent is Codeply, not Wisp', /YOU ARE CODEPLY/.test(lead.project) && !/\bWisp\b/.test(lead.project + lead.core));
  check('prompt: one voice, specialists only when asked', /as one voice/.test(lead.project) && /If the user asks how you did it/.test(lead.project));
  check('prompt: native leaves out the tag format', !nat.includes('<codeply:bring_in>'));
  const plain = agentMod.buildSystemSections('Build', scratch, 'hi', {});
  check('prompt: plain Craft keeps the one-agent rule', /There is no one to delegate to/.test(plain.core));
  const spec = wisp.specialistPrompt(wisp.findSpecialist('testing'));
  check('prompt: a specialist gets its role guide and the report rules', /YOU ARE TESTING, A SPECIALIST ON CODEPLY'S TEAM/.test(spec) && /YOUR REPORT/.test(spec) && spec.length > 600);
}

// 3. Wisp brings in Frontend, Frontend really fixes and checks, Wisp reports it.
{
  const r = await wispTurn([
    '<codeply:bring_in>\n<specialist>Frontend</specialist>\n<task>\ncart.js adds tax twice. Make it add 20% tax once, then check it.\n</task>\n</codeply:bring_in>',
    // Frontend's run:
    '<codeply:write_file>\n<path>cart.js</path>\n<content>\nmodule.exports = (items) => items.reduce((s, i) => s + i.price * 1.2, 0);\n</content>\n</codeply:write_file>',
    '<codeply:run>\n<command>node --check cart.js</command>\n</codeply:run>',
    'Fixed cart.js: tax is applied once now. node --check cart.js passes.',
    // Wisp again:
    '[mood: proud]\nFixed. Frontend changed cart.js so tax is added once, and checked it with node --check (it passes).',
  ], 'The checkout total is wrong, fix it');
  const specBody = bodies[1];
  check('bring_in: the specialist runs with its own prompt', specBody && /YOU ARE FRONTEND, A SPECIALIST ON CODEPLY'S TEAM/.test(systemOf(specBody)) && /You are a specialist doing one task for Codeply/.test(systemOf(specBody)), systemOf(specBody || {}).slice(0, 300));
  check('bring_in: the specialist gets the task Wisp wrote', specBody && /adds tax twice/.test(lastUserOf(specBody)));
  check('bring_in: the specialist cannot bring in others', specBody && !/<codeply:bring_in>/.test(systemOf(specBody)));
  check('bring_in: the file really changed', fs.readFileSync(path.join(r.cwd, 'cart.js'), 'utf8').includes('i.price * 1.2, 0'));
  const back = bodies[4] ? lastUserOf(bodies[4]) : '';
  check('bring_in: Wisp gets the report and what really happened', /FRONTEND'S REPORT/.test(back) && /Files changed: cart\.js/.test(back) && /ran `node --check cart\.js`: passed/.test(back), back);
  check('bring_in: Wisp\'s claim is not sent back by the claim audit', bodies.length === 5 && r.texts.length === 1, `${bodies.length} calls; ${JSON.stringify(r.texts)}`);
  check('mood: the reply shows without its tag, the mood goes to the window', r.texts[0] && r.texts[0].startsWith('Fixed.') && sent.some((e) => e.type === 'wisp_mood' && e.mood === 'proud'), JSON.stringify(r.texts));
  check('done: the specialist\'s edit counts for the turn', r.done && r.done.madeAnyEdit && r.done.actions.some((a) => a.tool === 'write_file' && a.by === 'Frontend'), JSON.stringify(r.done && r.done.actions));
  const start = sent.find((e) => e.type === 'wisp_agent' && e.phase === 'start');
  const rep = sent.find((e) => e.type === 'wisp_agent' && e.phase === 'report');
  check('window: "Frontend is on it", then its report', start && start.agent.name === 'Frontend' && rep && rep.ok && rep.files.includes('cart.js') && rep.checks.some((c) => c.tool === 'run' && c.exitCode === 0), JSON.stringify(rep));
  check('window: the specialist\'s steps carry its id', sent.some((e) => e.type === 'tool_end' && e.name === 'write_file' && e.agent === 'frontend'));
  check('chat: start and report are saved for a reload', r.session.messages.filter((m) => m.kind === 'wisp_agent').map((m) => m.phase).join() === 'start,report');
  const hist = require(path.join(CLI, 'lib/history.js')).buildHistory({ messages: [{ kind: 'user', text: 'fix it' }, ...r.session.messages, { kind: 'assistant', text: 'Fixed.', wisp: true }] });
  const said = hist.map((t) => t.content).join('\n');
  check('history: Wisp can say later who it brought in', /brought in the Frontend specialist for: cart\.js adds tax twice/.test(said), said);
  check('history: a specialist\'s narration is not Wisp\'s words', hist.length === 2, JSON.stringify(hist));
  check('stats: the job counts toward Frontend', wisp.listSpecialists().find((s) => s.id === 'frontend').uses === 1);
}

// 4. No one fits: Wisp makes a specialist, then brings it in (native tool calls).
{
  const r = await wispTurn([
    { tool_calls: [{ name: 'create_specialist', args: { name: 'Copywriter', focus: 'Landing page copy', instructions: 'Write short, concrete copy. Read it aloud before you report.' } }] },
    { tool_calls: [{ name: 'bring_in', args: { specialist: 'Copywriter', task: 'Write a one-line hero for a tea shop.' } }] },
    'Steep slow. Sip slower.',
    '[mood: happy]\nCopywriter wrote the hero line: "Steep slow. Sip slower."',
  ], 'I need a hero line for my tea shop', { route: nativeRoute });
  check('create_specialist: the new one is on the team', wisp.findSpecialist('Copywriter')?.focus === 'Landing page copy');
  check('create_specialist: the window hears about it', sent.some((e) => e.type === 'wisp_agent' && e.phase === 'created' && e.agent.name === 'Copywriter'));
  check('create_specialist: its own instructions are its prompt', bodies[2] && /YOU ARE COPYWRITER/.test(systemOf(bodies[2])) && /Read it aloud/.test(systemOf(bodies[2])));
  check('native: bring_in and create_specialist are real tools for Wisp', (bodies[0].tools || []).some((t) => t.function.name === 'bring_in') && (bodies[0].tools || []).some((t) => t.function.name === 'create_specialist'));
  check('native: a specialist has neither', !(bodies[2].tools || []).some((t) => t.function.name === 'bring_in' || t.function.name === 'create_specialist'));
  check('native: Wisp\'s reply comes through', r.texts[0] === 'Copywriter wrote the hero line: "Steep slow. Sip slower."', JSON.stringify(r.texts));
  check('track record: a made specialist remembers its last job', /hero for a tea shop/.test(wisp.specialistPrompt(wisp.findSpecialist('Copywriter'))));
}

// 4b. Each specialist on its own model: pinned to one of the user's models, it runs there.
{
  const cfg = require(path.join(CLI, 'lib/config.js'));
  const saved = cfg.saveModel({ name: 'Qwen Coder', model: 'qwen-coder', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'x' });
  check('models: a test model saved in a throwaway config', saved && saved.ok !== false && cfg.getModels().some((m) => m.name === 'Qwen Coder'), JSON.stringify(saved));
  const r = await wispTurn([
    '<codeply:create_specialist>\n<name>Backend</name>\n<model>Qwen Coder</model>\n</codeply:create_specialist>',
    '<codeply:bring_in>\n<specialist>Backend</specialist>\n<task>\nSay which file holds the cart.\n</task>\n</codeply:bring_in>',
    'cart.js holds the cart.',
    '[mood: neutral]\ncart.js holds the cart.',
  ], 'run Backend on my Qwen model');
  check('models: Codeply can pin a built-in to one of the user\'s models', wisp.findSpecialist('backend').model === cfg.getModels().find((m) => m.name === 'Qwen Coder').id);
  check('models: the specialist runs on its own model, the main agent on the chat\'s', bodies[2] && bodies[2].model === 'qwen-coder' && bodies[0].model === 'fake', JSON.stringify(bodies.map((b) => b.model)));
  check('models: the main agent sees who runs on what', /Backend: Backend & API\. Runs on Qwen Coder/.test(wisp.wispPrompt({ models: [{ id: wisp.findSpecialist('backend').model, name: 'Qwen Coder' }] })));
  const bad = await wispTurn([
    '<codeply:create_specialist>\n<name>Backend</name>\n<model>GPT-9</model>\n</codeply:create_specialist>',
    '[mood: neutral]\nNo such model.',
  ], 'x');
  check('models: an unknown model is refused with the list', /no model called "GPT-9"[\s\S]*auto, Qwen Coder/.test(lastUserOf(bodies[1] || {})), lastUserOf(bodies[1] || {}));
  check('models: a removed model falls back to the chat\'s', host.routeFor({ model: 'm-gone' }, textRoute) === textRoute);
  wisp.updateSpecialist('backend', { model: 'auto' });
  check('models: auto uses the chat\'s route (Haze 2 picks per specialist)', host.routeFor(wisp.findSpecialist('backend'), textRoute) === textRoute);
  void bad;
}

// 4c. Standing jobs.
{
  const mon10 = new Date(2026, 10, 2, 10, 0).getTime(); // a Monday, 10:00
  const at = (t) => { const r = wisp.parseWhen(t, mon10); return r.error ? `ERR ${r.error}` : `${wisp.describeRule(r)} -> ${new Date(wisp.nextRun(r, mon10)).toString().slice(0, 21)}`; };
  check('when: every Monday at 9', at('every Monday at 9') === 'every Monday at 09:00 -> Mon Nov 09 2026 09:00', at('every Monday at 9'));
  check('when: every weekday at 6:30pm', at('every weekday at 6:30pm') === 'every weekday at 18:30 -> Mon Nov 02 2026 18:30', at('every weekday at 6:30pm'));
  check('when: every 2 hours', at('every 2 hours') === 'every 2 hours -> Mon Nov 02 2026 12:00', at('every 2 hours'));
  check('when: tomorrow at 9 is once', at('tomorrow at 9') === 'once, Tue 3 Nov 09:00 -> Tue Nov 03 2026 09:00', at('tomorrow at 9'));
  check('when: every tuesday and friday at noon', at('every tuesday and friday at noon').startsWith('every Tuesday and Friday at 12:00 -> Tue Nov 03'), at('every tuesday and friday at noon'));
  check('when: too often is refused', at('every 5 minutes').startsWith('ERR'));
  check('when: vague is refused', at('sometime next week').startsWith('ERR'));

  const r = await wispTurn([
    '<codeply:schedule>\n<action>add</action>\n<specialist>Security</specialist>\n<task>Check for leaked keys.</task>\n<when>every Monday at 9</when>\n</codeply:schedule>',
    '[mood: happy]\nDone. Security checks for leaked keys every Monday at 9.',
  ], 'have security check for leaked keys every monday at 9');
  const jobs = wisp.listSchedules();
  check('schedule: the main agent adds a standing job for a specialist', jobs.length === 1 && jobs[0].specialist === 'security' && jobs[0].cwd === r.cwd && /Scheduled j/.test(lastUserOf(bodies[1])), JSON.stringify(jobs));
  check('schedule: the specialist\'s detail shows it', wisp.detail(wisp.findSpecialist('security')).schedules.length === 1);
  const fired = [];
  host.init({ ipcMain: { handle() {} }, cliDir: CLI, sendEvent: () => {}, agentMod: () => agentMod, browser: null, recordToolEnd: () => {}, settings: { get: () => wispOn, set() {} }, startRun: async (p) => { fired.push(p); return { sessionId: 'job-chat' }; } });
  await host.tick();
  check('schedule: nothing fires before its time', fired.length === 0);
  const all = JSON.parse(fs.readFileSync(path.join(scratch, 'wisp', 'schedules.json'), 'utf8'));
  all[0].nextAt = Date.now() - 1000; fs.writeFileSync(path.join(scratch, 'wisp', 'schedules.json'), JSON.stringify(all));
  await host.tick();
  check('schedule: a due job fires as a message in its own chat', fired.length === 1 && /^Scheduled job for Security \(every Monday at 09:00\): Check for leaked keys\./.test(fired[0].text) && fired[0].cwd === r.cwd, JSON.stringify(fired));
  const after = wisp.listSchedules()[0];
  check('schedule: then waits for its next time, in the same chat', after.sessionId === 'job-chat' && after.runs === 1 && after.nextAt > Date.now() && new Date(after.nextAt).getDay() === 1);
  await host.tick();
  check('schedule: and does not fire twice', fired.length === 1);
  const lead = agentMod.buildSystemSections('Build', scratch, 'hi', { botPrompt: wisp.wispPrompt({}) }).project;
  check('schedule: the main agent knows what a firing job looks like', /starts with "Scheduled job for"/.test(lead));
  const listed = await wispTurn(['<codeply:schedule>\n<action>cancel</action>\n<id>' + after.id + '</id>\n</codeply:schedule>', '[mood: neutral]\nCancelled.'], 'stop that job');
  check('schedule: cancel stops it', wisp.listSchedules().length === 0);
  void listed;
}

// 4d. Permission rules the phone edits (lib/permissions.js).
{
  const perms = require(path.join(CLI, 'lib/permissions.js'));
  fs.mkdirSync(path.join(scratch, '.codeply'), { recursive: true });
  fs.writeFileSync(path.join(scratch, '.codeply', 'permissions.json'), JSON.stringify({ note: 'mine', allow: ['run:git status'] }));
  const saved = perms.saveGlobalRules({ allow: ['run:npm test', 'run:npm test', 'not a rule!', 'edit_file:src/**'], deny: ['run:git push*'] });
  check('permissions: rules saved, bad ones dropped, duplicates merged', JSON.stringify(saved.global) === JSON.stringify({ allow: ['run:npm test', 'edit_file:src/**'], deny: ['run:git push*'] }), JSON.stringify(saved));
  check('permissions: other keys in the file are kept', JSON.parse(fs.readFileSync(path.join(scratch, '.codeply', 'permissions.json'), 'utf8')).note === 'mine');
  check('permissions: a saved allow rule decides', perms.decide({ tool: 'run', detail: 'npm test', patterns: ['npm test'] }, null).decision === 'allow');
  check('permissions: a saved deny rule decides', perms.decide({ tool: 'run', detail: 'git push origin main', patterns: ['git push'] }, null).decision === 'deny');
  check('permissions: listRules reads them back', perms.listRules(null).global.deny[0] === 'run:git push*');
}

// 5. A name not on the team, and a specialist that fails.
{
  const r = await wispTurn([
    '<codeply:bring_in>\n<specialist>Astronaut</specialist>\n<task>\nfly\n</task>\n</codeply:bring_in>',
    '[mood: sad]\nI don\'t have an astronaut on the team.',
  ], 'send the astronaut');
  check('bring_in: unknown name lists the team', bodies[1] && /No one on your team is called "Astronaut"/.test(lastUserOf(bodies[1])) && /Frontend/.test(lastUserOf(bodies[1])));
  check('bring_in: nothing ran for an unknown name', !sent.some((e) => e.type === 'wisp_agent'));
}

// 6. Off, Crew bots and Design: not Wisp's chat.
{
  wispOn = false;
  check('off: no Wisp', host.forTurn({ session: { id: 'x', messages: [] }, mode: 'Build' }) === null);
  wispOn = true;
  check('a Crew bot\'s chat stays the bot\'s', host.forTurn({ session: { id: 'x', botId: 'b1', messages: [] }, mode: 'Build' }) === null);
  check('Design mode stays Design', host.forTurn({ session: { id: 'x', messages: [] }, mode: 'Design' }) === null);
  const v = host.forTurn({ session: { id: 'x', messages: [] }, mode: 'Build', verifyOnly: true });
  check('a checking turn is Wisp but brings no one in', v && !v.bringIn && !v.createSpecialist);
}

server.close();
console.log(failures ? `\n${failures} FAILED` : '\nAll Wisp checks passed.');
process.exit(failures ? 1 : 0);
