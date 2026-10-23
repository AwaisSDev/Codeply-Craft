// The shared brain (codeply-cli/lib/brain.js): personal, project and live
// context, how statements become memory, corrections, shared lessons, the
// handoff board, and the suggest-only autonomy level (node scripts/brain-test.mjs).
// No network and no model: every model answer is a fake, every store a temp file.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codeply-brain-'));
process.env.CODEPLY_BOTS_DIR = path.join(tmp, 'bots');

const BR = require(path.join(ROOT, 'codeply-cli/lib/brain.js'));
const B = require(path.join(ROOT, 'codeply-cli/lib/bots.js'));
const AP = require(path.join(ROOT, 'codeply-cli/lib/autopilot.js'));

let failures = 0;
const only = process.argv[2] || '';
function check(name, cond, extra = '') {
  if (cond) console.log(`  ok    ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${extra ? `\n        ${String(extra).slice(0, 800)}` : ''}`); }
}
const section = (name) => { console.log(`\n${name}`); return !only || name.toLowerCase().includes(only.toLowerCase()); };

let NOW = Date.UTC(2026, 9, 22, 9, 0, 0);
const HOUR = 3600000;
const fresh = (name) => BR.configure({ file: path.join(tmp, `${name}.db`), now: () => NOW });
const crew = (botName = 'Mira') => ({ product: 'crew', botId: botName.toLowerCase(), botName });

// A pretend Google account: the oauth functions the tools call, and a
// connected Gmail in config (patched on the module, nothing written to disk).
const google = { sent: [], drafts: [], inserted: [], patched: [], deleted: [], inbox: [], events: [] };
function fakeGoogle() {
  const oauth = require(path.join(ROOT, 'codeply-cli/lib/oauth-connectors.js'));
  const config = require(path.join(ROOT, 'codeply-cli/lib/config.js'));
  const getIntegration = config.getIntegration;
  config.getIntegration = (name) => (name === 'gmail' ? { accessToken: 'tok', expiresAt: Date.now() + 86400000, email: 'me@example.com', scope: Object.values(oauth.GOOGLE_SCOPE).join(' ') } : getIntegration(name));
  oauth.gmailSend = async (tok, m) => { google.sent.push(m); return { id: `s${google.sent.length}` }; };
  oauth.gmailCreateDraft = async (tok, d) => { google.drafts.push(d); return { id: `d${google.drafts.length}`, message: { id: 'dm', threadId: '' } }; };
  oauth.gmailSearch = async () => google.inbox.map((m) => ({ id: m.id, subject: m.subject, from: m.from, date: m.date, snippet: m.body.slice(0, 40) }));
  oauth.gmailGetMessage = async (tok, id) => { const m = google.inbox.find((x) => x.id === id); if (!m) throw Object.assign(new Error('Not Found'), { status: 404 }); return { threadId: `t${id}`, to: 'me@example.com', ...m }; };
  oauth.calendarListEvents = async () => google.events;
  oauth.calendarInsertEvent = async (tok, ev) => { google.inserted.push(ev); return { id: `ev${google.inserted.length}`, htmlLink: '' }; };
  oauth.calendarPatchEvent = async (tok, id, patch) => { google.patched.push({ id, patch }); return { id, summary: patch.summary || 'Futsal' }; };
  oauth.calendarDeleteEvent = async (tok, id) => { google.deleted.push(id); return { ok: true }; };
}

fresh('probe');
if (!BR.usable()) {
  console.log('No SQLite driver on this Node: the brain cannot be tested here.');
  process.exit(1);
}

// ─── Statements become memory, or not ──────────────────────────────────────
if (section('Statements')) {
  fresh('statements');
  const red = BR.observe({ kind: 'preference', slot: 'favorite color', value: 'red', text: 'The user\'s favorite color is red.', certainty: 'stated' }, crew());
  check('said plainly: added as confirmed', red.action === 'added' && red.memory.status === 'confirmed', JSON.stringify(red));

  const pink = BR.observe({ kind: 'preference', slot: 'favorite color', value: 'pink', text: 'The user\'s favorite color is pink.', certainty: 'joking' }, crew());
  check('pink, said sarcastically in an argument: ignored', pink.action === 'ignored' && pink.why === 'joking');
  check('red is still the favorite color', BR.get(red.memory.id).value === 'red');
  check('the ignored remark shows in the changes', BR.changes({ limit: 5 }).some((c) => c.action === 'ignored' && /pink/.test(c.text)));

  const hypo = BR.observe({ kind: 'preference', slot: 'favorite color', value: 'green', text: 'If they had to pick, green.', certainty: 'hypothetical' }, crew());
  const quote = BR.observe({ kind: 'preference', slot: 'favorite color', value: 'blue', text: 'Their sister loves blue.', certainty: 'quoting' }, crew());
  check('hypotheticals and someone else\'s words: ignored', hypo.action === 'ignored' && quote.action === 'ignored');

  const once = BR.observe({ kind: 'preference', slot: 'favorite color', value: 'pink', text: 'The user seems to like pink.', certainty: 'implied' }, crew('Ivo'));
  check('contradicted once in passing: still red, pink noted as a challenger', once.action === 'challenged' && once.memory.value === 'red' && once.memory.challenger.count === 1, JSON.stringify(once));
  const twice = BR.observe({ kind: 'preference', slot: 'favorite color', value: 'pink', text: 'The user likes pink.', certainty: 'implied' }, crew());
  check('seen again: switches, but only as "not sure yet", flagged for review', twice.action === 'replaced' && twice.memory.value === 'pink' && twice.memory.status === 'tentative' && twice.memory.review, JSON.stringify(twice.memory));
  check('the old value is kept in its history', twice.memory.history.some((h) => h.value === 'red'));
  const undo = BR.resolve(twice.memory.id, 'undo');
  check('Undo goes back to red and locks it', undo.value === 'red' && undo.locked && !undo.review, JSON.stringify(undo));

  const blunt = BR.observe({ kind: 'preference', slot: 'favorite color', value: 'purple', text: 'The user\'s favorite color is purple now.', certainty: 'stated' }, crew());
  check('a bot cannot change what the user set: kept, disagreement flagged', blunt.action === 'kept' && BR.get(red.memory.id).value === 'red' && BR.get(red.memory.id).review);
  const sw = BR.resolve(red.memory.id, 'switch');
  check('Switch takes what was heard', sw.value === 'purple' && sw.locked && !sw.challenger);

  const short = BR.observe({ kind: 'style', slot: 'reply length', value: 'short', text: 'The user likes short replies.', certainty: 'implied' }, crew());
  check('implied: tentative', short.memory.status === 'tentative');
  const again = BR.observe({ kind: 'style', slot: 'reply length', value: 'short', text: 'The user wants short answers.', certainty: 'implied' }, { product: 'craft' });
  check('heard again from another app: confirmed, both sources kept', again.action === 'reinforced' && again.memory.status === 'confirmed' && again.memory.sources.length === 2);

  const fact = BR.observe({ kind: 'fact', slot: 'stated job', value: 'founder', text: 'The user is a startup founder.', certainty: 'stated' }, crew());
  const changed = BR.observe({ kind: 'fact', slot: 'stated job', value: 'student', text: 'The user is a student now.', certainty: 'stated' }, crew());
  check('a plain new statement replaces the old one, which stays in the history', changed.action === 'replaced' && changed.memory.status === 'confirmed' && changed.memory.history[0].value === 'founder' && fact.memory.id === changed.memory.id);

  const secret = BR.observe({ kind: 'fact', text: 'The user\'s password is hunter2.', certainty: 'stated' }, crew());
  const key = BR.observe({ kind: 'fact', text: 'Their key is sk-abcdefghijklmnop', certainty: 'stated' }, crew());
  check('secrets are never kept', secret.action === 'ignored' && key.action === 'ignored' && !BR.list({ text: 'hunter2' }).length);

  const fixed = BR.correct(short.memory.id, { text: 'The user wants very short replies.' });
  check('a correction by hand is locked and confirmed', fixed.locked && fixed.status === 'confirmed' && fixed.confidence === 1);
  check('forget removes it', BR.forget(short.memory.id) && !BR.get(short.memory.id));
}

// ─── Live context ───────────────────────────────────────────────────────────
if (section('Live context')) {
  fresh('live');
  const trip = BR.observe({ kind: 'context', text: 'The user is in Lahore this week.', certainty: 'stated', ttlHours: 48 }, crew());
  check('temporary context is kept with an expiry', trip.memory.status === 'temporary' && trip.memory.expiresAt === NOW + 48 * HOUR);
  BR.observe({ kind: 'fact', slot: 'home city', value: 'Karachi', text: 'The user lives in Karachi.', certainty: 'stated' }, crew());
  const temp = BR.observe({ kind: 'fact', text: 'The user is in a meeting until 5.', certainty: 'temporary', ttlHours: 3 }, crew());
  check('"temporary" certainty turns any kind into live context', temp.memory.kind === 'context');
  check('live context never touches what is known for good', BR.list({ kinds: ['fact'] })[0].value === 'Karachi');
  check('it is in the prompt while true', /Right now \(temporary\)[\s\S]*meeting until 5/.test(BR.contextBlock({})));
  NOW += 4 * HOUR;
  check('and gone from it once it runs out', !/meeting until 5/.test(BR.contextBlock({})) && /Lahore/.test(BR.contextBlock({})));
  NOW += 3 * 24 * HOUR;
  BR.prune();
  check('prune drops expired context', !BR.list({ kinds: ['context'], includeExpired: true }).length);
}

// ─── Projects follow the user between apps ─────────────────────────────────
if (section('Projects')) {
  fresh('projects');
  // A startup idea, talked through with a bot in Crew...
  BR.observe({ kind: 'idea', project: 'Startup Idea', text: 'A marketplace that matches students with tutors by voice.', certainty: 'stated' }, crew());
  BR.observe({ kind: 'decision', project: 'Startup Idea', slot: 'auth provider', value: 'Supabase', text: 'Auth uses Supabase with magic links.', certainty: 'stated' }, crew());
  BR.observe({ kind: 'requirement', project: 'Startup Idea', text: 'Payments in PKR through a local gateway.', certainty: 'stated' }, crew());
  BR.observe({ kind: 'decision', project: 'Other Thing', text: 'Other Thing ships as a Chrome extension.', certainty: 'stated' }, crew());
  // ...then the user opens the folder in Craft or Studio.
  const block = BR.contextBlock({ cwd: '/home/u/code/startup-idea', request: 'set up the login page' });
  check('Craft in that folder already knows the idea and the decisions', /Project "Startup Idea"/.test(block) && /magic links/.test(block) && /students with tutors/.test(block) && /PKR/.test(block), block);
  check('it says where each came from', /Mira in crew/.test(block));
  check('other projects stay out', !/Chrome extension/.test(block));
  const named = BR.contextBlock({ cwd: '/tmp/scratch', request: 'what did we decide for other thing?' });
  check('naming a project in a message brings its context in', /Chrome extension/.test(named), named);
  const r = BR.rememberTool({ kind: 'decision', text: 'Use Next.js app router.', slot: 'framework' }, { cwd: '/home/u/code/startup-idea' });
  check('remember from Craft files a decision under the folder\'s project', r.ok && BR.list({ scope: 'project:startup-idea', text: 'Next.js' }).length === 1, JSON.stringify(r));
  const scratch = BR.rememberTool({ kind: 'decision', text: 'Ship the landing page on Friday.' }, { cwd: path.join(os.homedir(), 'Codeply Crew') });
  check('a decision made in Crew\'s bots folder is not filed under that folder', scratch.ok && !BR.list({ scope: 'project:codeply-crew' }).length && BR.projectOfFolder(os.homedir()) === '');
  check('it is still in every prompt, as a standing decision', /About them:[\s\S]*landing page on Friday/.test(BR.contextBlock({ request: 'what should I do today?' })));
  const rc = BR.recallTool({ query: 'auth' }, {});
  check('recall finds it by word', rc.ok && /Supabase/.test(rc.output), rc.output);
}

// ─── The prompt block ───────────────────────────────────────────────────────
if (section('Prompt block')) {
  fresh('block');
  check('an empty brain still says how to save', /Nothing yet/.test(BR.contextBlock({})) && /codeply:remember/.test(BR.contextBlock({})));
  check('native tools: no tag example', !/codeply:remember/.test(BR.contextBlock({ native: true })));
  BR.observe({ kind: 'preference', slot: 'reply length', value: 'short', text: 'The user wants short replies.', certainty: 'stated' }, crew());
  BR.observe({ kind: 'routine', slot: 'gym', value: 'mornings', text: 'The user goes to the gym on weekday mornings.', certainty: 'implied' }, crew());
  const b = BR.contextBlock({ request: 'plan my gym week' });
  check('confirmed things are in "About them"', /About them:\n- The user wants short replies\./.test(b), b);
  check('a tentative thing that fits the request is shown as not sure', /Not sure yet[\s\S]*gym on weekday mornings/.test(b));
  check('a tentative thing that does not fit is left out', !/gym/.test(BR.contextBlock({ request: 'fix the css' })));
  BR.setEnabled(false);
  check('switched off: nothing in any prompt, nothing learned', BR.contextBlock({}) === '' && BR.observe({ kind: 'fact', text: 'Something new here.', certainty: 'stated' }).action === 'ignored');
  BR.setEnabled(true);
}

// ─── Standing rules and to-dos (found by the life simulation) ──────────────
if (section('Standing rules')) {
  fresh('rules');
  // A model may file "always CC hiring@" as a requirement with no project.
  BR.observe({ kind: 'requirement', slot: 'candidate email cc', value: 'hiring@acme.example', text: 'The user wants hiring@acme.example CC\'d on all candidate emails.', certainty: 'stated' }, crew());
  BR.observe({ kind: 'todo', text: 'Pay Ali Traders Rs 45,000 for rice on Friday.', certainty: 'stated' }, crew());
  BR.observe({ kind: 'idea', text: 'Open a second shop near the university.', certainty: 'stated' }, crew());
  const b = BR.contextBlock({ request: 'draft a rejection template for candidates' });
  check('a requirement with no project is a standing rule in every prompt', /About them:[\s\S]*hiring@acme\.example/.test(b), b);
  check('an open to-do shows even when the message does not mention it', /Open to-dos[\s\S]*Ali Traders/.test(BR.contextBlock({ request: 'aaj kya karna hai?' })));
  check('an idea shows only when the message is about it', !/second shop/.test(b) && /second shop/.test(BR.contextBlock({ request: 'should I open a second shop?' })));
  NOW += 30 * 24 * HOUR;
  check('to-dos untouched for three weeks drop out of the prompt', !/Ali Traders/.test(BR.contextBlock({})));
  check('"candidates" matches "candidate"', BR.terms('candidates')[0] === BR.terms('candidate')[0] && BR.terms('emails')[0] === 'email');
}

// ─── Health (life.js) ───────────────────────────────────────────────────────
if (section('Health')) {
  const LS = require(path.join(ROOT, 'codeply-cli/lib/life-store.js'));
  const L = require(path.join(ROOT, 'codeply-cli/lib/life.js'));
  const T = require(path.join(ROOT, 'codeply-cli/lib/life-triggers.js'));
  const tz = 'Asia/Karachi';
  const now = Date.UTC(2026, 10, 2, 14, 0); // Mon 19:00 in Karachi
  const DAY = 24 * HOUR;
  const store = LS.openLifeStore({ file: path.join(tmp, 'health.db'), key: Buffer.alloc(32, 7), now: () => now });
  L.attach(store, { tz });
  const samples = [];
  for (let d = 14; d >= 2; d--) samples.push({ kind: 'steps', at: now - d * DAY, value: 8000 + (d % 3) * 400 });
  for (const d of [3, 5, 8, 10, 12]) samples.push({ kind: 'workout', title: 'Walk in the park', at: now - d * DAY, end: now - d * DAY + 40 * 60000 });
  samples.push({ kind: 'steps', at: now - DAY, value: 1900 }, { kind: 'steps', at: now, value: 1200 });
  samples.push({ kind: 'feeling', at: now - 20 * HOUR, title: 'Left ankle hurts again' });
  samples.push({ kind: 'sleep', at: now - 18 * HOUR, end: now - 11 * HOUR });
  check('health samples are stored, sealed', L.noteHealth(samples, { tz }).length === samples.length && store.items({ sources: ['health'], limit: 1 })[0].sensitive);
  const snap = L.snapshot({ now, tz });
  check('the snapshot knows today, the usual day and the last workout', snap.health.stepsToday === 1200 && snap.health.usualSteps >= 8000 && /Walk/.test(snap.health.lastWorkout.title), JSON.stringify(snap.health));
  check('the prompt block says it plainly', /Health: 1,200 steps today \(usually about 8\d00 a day\)[\s\S]*ankle/.test(L.nowBlock(snap)), L.nowBlock(snap));
  const bot = B.createBot({ name: 'Coach', specialty: 'Health and fitness' });
  check('a bot without sensitive access cannot read health', !(await L.contextTool({ about: 'health' }, { bot, now, tz })).ok);
  const okBot = B.updateBot(bot.id, { life: { sensitive: true } });
  const r = await L.contextTool({ about: 'steps' }, { bot: okBot, now, tz });
  check('a bot allowed to can, with the 14 days', r.ok && /Daily steps:/.test(r.output) && /ankle/.test(r.output), r.output);
  const due = T.due({ store, snap, settings: { perDay: 6, quiet: { on: false } }, now });
  const act = due.find((c) => c.trigger === 'activity');
  check('two low days in a row: one gentle check-in', !!act && /1200 so far today, 1900 yesterday/.test(act.facts.join(' ')) && /ankle/.test(act.facts.join(' ')), JSON.stringify(due));
  check('it goes to a life bot', T.chooseBot(act, [B.createBot({ name: 'Ivo', specialty: 'Email inbox' }), okBot], {}).id === okBot.id);
  const buddy = B.createBot({ name: 'Buddy', role: 'orchestrator', specialty: 'Personal life: friends, girlfriend, plans, social stuff, reminders' });
  const pulse = B.createBot({ name: 'Pulse', specialty: 'Gym, steps, sleep', handles: ['health'] });
  check('the bot that handles health gets it, not the personal-life bot listed first', T.chooseBot(act, [buddy, pulse], {}).id === pulse.id);
  check('without one, a bot whose job is fitness gets it', T.chooseBot(act, [buddy, B.createBot({ name: 'Fit', specialty: 'Fitness coach' })], {}).name === 'Fit');
  check('other life nudges still go to the life bot', T.chooseBot({ trigger: 'leaving' }, [buddy, pulse], {}).id === buddy.id);
  store.addNudge({ trigger: 'activity', key: act.key, text: 'x', at: now - HOUR });
  check('and not again for three days', !T.due({ store, snap, settings: { perDay: 6, quiet: { on: false } }, now: now + DAY }).some((c) => c.trigger === 'activity'));
  L.detach(); store.close();
}

// ─── Lessons shared with the team ───────────────────────────────────────────
if (section('Lessons')) {
  fresh('lessons');
  const ivo = B.createBot({ name: 'Ivo', specialty: 'Email: triage the inbox and draft replies' });
  const cal = B.createBot({ name: 'Cleo', specialty: 'Calendar and scheduling: meetings, availability' });
  BR.shareLessons([{ situation: 'searching Gmail for invoices', strategy: 'use has:attachment filename:pdf newer_than:30d' }], { botId: ivo.id, botName: 'Ivo', domain: 'email' });
  const forCleo = BR.teamLessons({ excludeBotId: cal.id, request: 'find the invoices in gmail from last month' });
  check('a teammate gets a lesson that fits its request', forCleo.length === 1 && /filename:pdf/.test(forCleo[0].text));
  check('labelled as a teammate\'s experience, not a rule', /From teammates' experience[\s\S]*Ivo/.test(BR.contextBlock({ botId: cal.id, request: 'find the invoices in gmail' })));
  check('not when it does not fit', !BR.teamLessons({ excludeBotId: cal.id, request: 'book a dentist appointment' }).length);
  check('never its own lesson back', !BR.teamLessons({ excludeBotId: ivo.id, request: 'find the invoices in gmail' }).length);
  BR.shareLessons([{ situation: 'searching Gmail for invoices', strategy: 'use has:attachment filename:pdf newer_than:30d' }], { botId: cal.id, botName: 'Cleo', domain: 'calendar' });
  const l = BR.list({ kinds: ['lesson'] });
  check('the same lesson from two bots is one lesson, now confirmed', l.length === 1 && l[0].status === 'confirmed' && l[0].evidence === 2);
}

// ─── Handoffs ───────────────────────────────────────────────────────────────
if (section('Handoffs')) {
  fresh('handoffs');
  for (const b of B.listBots()) B.removeBot(b.id);
  const mail = B.createBot({ name: 'Ivo', specialty: 'Email: triage the inbox and draft replies' });
  const cal = B.createBot({ name: 'Cleo', specialty: 'Calendar and scheduling: meetings, availability' });
  const res = B.createBot({ name: 'Rae', specialty: 'Research: compare options and cite sources', handles: ['research'] });
  const team = B.listBots();
  check('domains are read from the job', BR.botDomains(mail).includes('email') && BR.botDomains(cal).includes('calendar'));
  check('or set by the user', JSON.stringify(BR.botDomains(team.find((b) => b.id === res.id))) === '["research"]');
  check('route by domain', BR.routeHandoff('calendar', team, { fromBotId: mail.id }).bot.id === cal.id);
  check('route by name', BR.routeHandoff('rae', team, {}).bot.id === res.id);
  check('route by words in the intent', BR.routeHandoff('', team, { fromBotId: mail.id, intent: 'find a free slot for the meeting' }).bot.id === cal.id);
  check('never back to the sender', BR.routeHandoff('email', team, { fromBotId: mail.id }).bot === null);

  const queued = [];
  BR.setCoordinator(async (h) => { queued.push(h); return { taskId: `task-${queued.length}` }; });
  const r = await BR.handOff({ to: 'calendar', intent: 'Mike proposed meeting tomorrow at 5am. Check and propose.', facts: 'From: Mike <mike@example.com>\nThread: 18c2', decision: 'Drafted a holding reply.' }, { fromBot: mail, requester: 'other' });
  check('handed on: queued for the calendar bot', r.ok && queued.length === 1 && queued[0].toBot === cal.id, JSON.stringify(r));
  const h = BR.getHandoff(queued[0].id);
  check('only the intent, the facts and the decision travel', h.facts.length === 2 && h.decision === 'Drafted a holding reply.' && h.status === 'queued' && h.taskId === 'task-1');
  const text = BR.handoffTask(h);
  check('the task says it came from someone else, so the receiver only proposes', /HANDOFF from Ivo/.test(text) && /someone other than the user/.test(text) && /mike@example.com/.test(text));
  check('the task links back to the handoff', BR.handoffForTask('task-1').id === h.id);
  // Cleo, working the handoff, cannot pass the same job straight back to Ivo, and chains stay short.
  const back = await BR.handOff({ to: 'Ivo', intent: 'Mike proposed meeting tomorrow at 5am, check and propose a time.' }, { fromBot: cal, parent: h.id });
  check('the same job never bounces back to the bot that sent it', !back.ok && /loop/.test(back.output) && queued.length === 1, back.output);
  const onward = await BR.handOff({ to: 'research', intent: 'Find a quiet cafe near the office for the meeting.' }, { fromBot: cal, parent: h.id });
  check('onward to someone new is fine', onward.ok && queued.length === 2 && queued[1].toBot === res.id && queued[1].parent === h.id);
  const reply = await BR.handOff({ to: 'email', intent: 'Email Mike the invite for Tuesday 10:00 with the agenda.' }, { fromBot: cal, parent: h.id });
  check('a new job back to the sender is fine too (book it here, email it there)', reply.ok && queued.length === 3 && queued[2].toBot === mail.id, reply.output);
  const c3 = BR.createHandoff({ to: 'calendar', intent: 'Book the cafe table', team, fromBot: res, parent: queued[1].id });
  const c4 = BR.createHandoff({ to: 'email', intent: 'y', team: [...team, B.createBot({ name: 'Zed', specialty: 'Email and inbox' })], fromBot: res, parent: c3.handoff.id });
  check('a chain stops after three handoffs', /handed on 3 times/.test(c4.error || ''), JSON.stringify(c4));
  const none = await BR.handOff({ to: 'money', intent: 'Pay the bill.' }, { fromBot: mail });
  check('nobody for it: says who handles what instead', !none.ok && /No bot handles/.test(none.output) && /Cleo \(calendar/.test(none.output), none.output);
  const secretFacts = BR.createHandoff({ to: 'calendar', intent: 'x', facts: ['password: hunter2', 'Room 4'], team, fromBot: mail });
  check('secrets never travel in a handoff', secretFacts.handoff.facts.length === 1 && secretFacts.handoff.facts[0] === 'Room 4');
  BR.setCoordinator(null);
  check('without the app running there is no hand_off', !BR.canHandOff() && !(await BR.handOff({ to: 'calendar', intent: 'x' })).ok);

  check('a meeting request with a time is spotted', BR.looksLikeScheduling('Quick sync?', 'Can we meet tomorrow at 5am to go over the deck?'));
  check('so is a reschedule', BR.looksLikeScheduling('Reschedule', 'Could we move our call to Friday 3pm?'));
  check('an invoice is not', !BR.looksLikeScheduling('Invoice #4411', 'Your invoice is attached. Due in 30 days.'));
  check('a meeting word with no time is not', !BR.looksLikeScheduling('Notes from the meeting', 'Attached are the notes.'));

  const p = B.buildBotPrompt(mail, { team, canDelegate: true, canHandOff: true });
  check('a bot that can hand off is told how, and who handles what', /HANDING WORK ON/.test(p) && /Cleo \(calendar/.test(p) && /<codeply:hand_off>/.test(p));
  check('and not when it cannot', !/HANDING WORK ON/.test(B.buildBotPrompt(mail, { team, canDelegate: true })));
}

// ─── Autonomy level 1: suggest only ─────────────────────────────────────────
if (section('Suggest only')) {
  const s = B.createBot({ name: 'Sage', specialty: 'Advice', approval: [], autonomy: { level: 'none' } });
  check('the level is kept', B.getBot(s.id).autonomy.level === 'none');
  check('it never skips approval, even with an empty boundary', !B.canSkipApproval(s, 'gmail_send') && !B.canSkipApproval(s, 'write_file'));
  check('every action is refused for it', B.suggestOnly(s, 'gmail_send') && B.suggestOnly(s, 'calendar_add') && B.suggestOnly(s, 'run') && B.suggestOnly(s, 'gmail_draft'));
  check('reading is not', !B.suggestOnly(s, 'read_file') && !B.suggestOnly(s, 'gmail_search') && !B.suggestOnly(s, 'calendar_list'));
  check('the autopilot refuses, it does not ask', AP.decide({ tool: 'gmail_send' }, s, { requester: 'user' }) === 'refuse');
  check('its prompt says it only suggests', /suggest only/.test(B.buildBotPrompt(s, {})));
  const full = B.createBot({ name: 'Doer', specialty: 'Ops', autonomy: { level: 'full', allow: ['send'] } });
  check('Level 3 still runs what it is allowed', AP.decide({ tool: 'gmail_send' }, full, { requester: 'user', budgetLeft: () => 5 }) === 'run');
  check('and still asks when someone else asked for it', AP.decide({ tool: 'gmail_send' }, full, { requester: 'other' }) === 'ask');
}

// ─── Learning from a chat (one model call, shared with the bot's memory) ────
if (section('Learning')) {
  fresh('learning');
  const bot = B.createBot({ name: 'Mira', specialty: 'Personal assistant' });
  let prompt = '';
  const fake = async (messages) => {
    prompt = messages[0].content;
    return { success: true, json: {
      facts: ['The user prefers mornings for meetings.'],
      observations: [
        { kind: 'preference', slot: 'meeting time', value: 'mornings', text: 'The user prefers meetings in the morning.', certainty: 'stated' },
        { kind: 'preference', slot: 'favorite color', value: 'pink', text: 'The user loves pink.', certainty: 'joking' },
        { kind: 'decision', project: 'Startup Idea', text: 'Launch in Lahore first.', certainty: 'stated' },
        { kind: 'context', text: 'The user is tired today.', certainty: 'temporary', ttlHours: 12 },
      ],
    } };
  };
  const r = await B.learnFromTurn(bot, 'Mornings are best for meetings. Pink? Sure, I LOVE pink, obviously. Anyway we launch in Lahore first. I am wiped today.', 'Noted.', fake);
  check('the bot\'s own memory call also asks for observations, and how to read the tone', /"observations"/.test(prompt) && /sarcasm/.test(prompt));
  check('the bot keeps its own fact', r.added.length === 1);
  const actions = (r.brain || []).map((x) => x.action);
  check('the brain keeps the plain ones and ignores the joke', JSON.stringify(actions) === JSON.stringify(['added', 'ignored', 'added', 'added']), JSON.stringify(r.brain));
  check('the decision is filed under its project', BR.list({ scope: 'project:startup-idea' }).length === 1);
  check('credited to the bot in Crew', BR.list({ kinds: ['preference'] })[0].sources[0].botName === 'Mira');

  const ex = await BR.learnFromExchange({ userText: 'Let us use Postgres for this one, not Mongo.', replyText: 'Switching to Postgres.', project: 'codeply-craft', src: { product: 'craft' } },
    async () => ({ success: true, json: { observations: [{ kind: 'decision', slot: 'database', value: 'Postgres', text: 'The database is Postgres, not Mongo.', certainty: 'stated' }] } }));
  check('a Craft chat with no bot learns too, under the folder\'s project', ex.length === 1 && ex[0].action === 'added' && BR.list({ scope: 'project:codeply-craft' })[0].sources[0].product === 'craft');
  check('a model that fails changes nothing and never throws', (await BR.learnFromExchange({ userText: 'something long enough to learn from', replyText: 'ok' }, async () => { throw new Error('down'); })).length === 0);
}

// ─── The engine tools ───────────────────────────────────────────────────────
if (section('Tools')) {
  fresh('tools');
  const T = await import(pathToFileURL(path.join(ROOT, 'codeply-cli/lib/tools.mjs')).href);
  const r = await T.executeTool('remember', { kind: 'preference', slot: 'editor theme', value: 'dark', text: 'The user codes in a dark theme.' }, { cwd: tmp, mode: 'Build' });
  check('remember runs through the engine', r.ok && /Saved/.test(r.output), JSON.stringify(r));
  const id = /\[(m[a-z0-9]+)\]/.exec(r.output)[1];
  const joke = await T.executeTool('remember', { kind: 'preference', slot: 'editor theme', value: 'light', text: 'Light mode, lol.', certainty: 'joking' }, { cwd: tmp, mode: 'Build' });
  check('a joke saved by a model is still refused', !joke.ok && BR.get(id).value === 'dark');
  const rc = await T.executeTool('recall', { query: 'theme' }, { cwd: tmp, mode: 'Ask' });
  check('recall works in read-only modes', rc.ok && /dark theme/.test(rc.output));
  const f = await T.executeTool('remember', { forget: id }, { cwd: tmp, mode: 'Build' });
  check('remember can forget by id', f.ok && !BR.get(id));
  const ho = await T.executeTool('hand_off', { to: 'calendar', intent: 'x' }, { cwd: tmp, mode: 'Build' });
  check('hand_off without a host says so', !ho.ok && /not available/.test(ho.output));
  const NT = await import(pathToFileURL(path.join(ROOT, 'codeply-cli/lib/native-tools.mjs')).href);
  const schemas = NT.buildToolSchemas({ remember: ['kind', 'text', 'certainty'], hand_off: ['to', 'intent'] });
  check('native tool definitions exist', schemas.length === 2 && JSON.stringify(schemas).includes('joking'));
}

// ─── Gmail and Calendar (cc, whole emails, guests, edits) ──────────────────
if (section('Gmail and Calendar')) {
  fakeGoogle();
  const LS = require(path.join(ROOT, 'codeply-cli/lib/life-store.js'));
  const L = require(path.join(ROOT, 'codeply-cli/lib/life.js'));
  const T = await import(pathToFileURL(path.join(ROOT, 'codeply-cli/lib/tools.mjs')).href);
  const approvals = [];
  const ctx = { cwd: tmp, mode: 'Build', approve: async (a) => { approvals.push(a); return 'once'; } };
  const now = Date.now();
  const store = LS.openLifeStore({ file: path.join(tmp, 'mail-life.db'), key: Buffer.alloc(32, 9), now: () => now });
  L.attach(store, { tz: 'Asia/Karachi' });
  store.setState('gmail.waiting', [{ from: 'sana@example.com', subject: 'Team name?', at: now - 30 * HOUR }, { from: 'usman@example.com', subject: 'Notes', at: now - 30 * HOUR }]);

  const s = await T.executeTool('gmail_send', { to: 'Sana <sana@example.com>', cc: 'hamza@example.com', subject: 'Team', body: 'We are in.' }, ctx);
  check('gmail_send copies the cc address', s.ok && google.sent[0].cc === 'hamza@example.com' && /cc hamza@example\.com/.test(s.output), JSON.stringify({ s, sent: google.sent }));
  check('the approval card shows the cc', /cc hamza/.test(approvals[0].title) && approvals[0].draft.cc === 'hamza@example.com', JSON.stringify(approvals[0]));
  check('whoever was answered is no longer waiting on the user', JSON.stringify(store.getState('gmail.waiting').map((w) => w.from)) === '["usman@example.com"]', JSON.stringify(store.getState('gmail.waiting')));
  check('noteSent takes a list and ignores strangers', L.noteSent(['nobody@example.com']) === 0 && L.noteSent('Usman <USMAN@example.com>') === 1 && store.getState('gmail.waiting').length === 0);
  const d = await T.executeTool('gmail_draft', { to: 'a@example.com', cc: 'b@example.com', subject: 'Hi', body: 'x' }, ctx);
  check('gmail_draft keeps the cc', d.ok && google.drafts[0].cc === 'b@example.com', JSON.stringify(google.drafts));

  google.inbox.push({ id: '18c2f0a9', from: 'Sana <sana@example.com>', cc: 'hamza@example.com', subject: 'Hackathon rules', date: 'Fri, 23 Oct 2026 10:00:00 GMT', body: `Hi Ali,\n\n${'Rule. '.repeat(40)}\nThe last line: bring your student card.` });
  const sr = await T.executeTool('gmail_search', { query: 'hackathon' }, ctx);
  check('gmail_search shows each email\'s id and how to read it', sr.ok && /\[18c2f0a9\] Hackathon rules/.test(sr.output) && /gmail_read/.test(sr.output), sr.output);
  const rd = await T.executeTool('gmail_read', { id: '[18c2f0a9]' }, ctx);
  check('gmail_read gives the whole email, cc and the last line too', rd.ok && /Cc: hamza@example\.com/.test(rd.output) && /bring your student card/.test(rd.output), rd.output);
  check('gmail_read on a missing id fails cleanly', !(await T.executeTool('gmail_read', { id: 'nope' }, ctx)).ok);

  const add = await T.executeTool('calendar_add', { title: 'Team sync', start: '2030-11-03T16:00', attendees: 'sana@example.com, not-an-address, hamza@example.com' }, ctx);
  check('calendar_add invites the guests (valid addresses only) and gives the event id', add.ok && JSON.stringify(google.inserted[0].attendees) === '[{"email":"sana@example.com"},{"email":"hamza@example.com"}]' && /invites sent/.test(add.output) && /Event id ev1/.test(add.output), add.output);
  google.events = [{ id: 'evF', summary: 'Futsal', start: { dateTime: '2030-11-05T20:00:00+05:00' }, end: { dateTime: '2030-11-05T21:00:00+05:00' }, attendees: [{ email: 'me@example.com', self: true }, { email: 'hamza@example.com' }] }];
  const ls = await T.executeTool('calendar_list', { from: '2030-11-05' }, ctx);
  check('calendar_list shows the id and the guests', ls.ok && /\[evF\] Futsal/.test(ls.output) && /with hamza@example\.com/.test(ls.output) && !/me@example/.test(ls.output), ls.output);
  const mv = await T.executeTool('calendar_update', { id: '[evF]', start: '2030-11-05T21:00', minutes: '90' }, ctx);
  const p = google.patched[0];
  check('calendar_update moves the event by id', mv.ok && p.id === 'evF' && /^2030-11-05T21:00/.test(p.patch.start.dateTime) && /^2030-11-05T22:30/.test(p.patch.end.dateTime) && /Updated "Futsal"/.test(mv.output), JSON.stringify({ mv, p }));
  check('and asks first', approvals.some((a) => a.tool === 'calendar_update'));
  const cn = await T.executeTool('calendar_update', { id: 'evF', cancel: 'yes' }, ctx);
  check('calendar_update cancel removes it', cn.ok && google.deleted[0] === 'evF');
  check('calendar_update with nothing to change says so', !(await T.executeTool('calendar_update', { id: 'evF' }, ctx)).ok);
  check('calendar_update is refused in a read-only mode', !(await T.executeTool('calendar_update', { id: 'evF', cancel: 'yes' }, { ...ctx, mode: 'Ask' })).ok && google.deleted.length === 1);
  const NT = await import(pathToFileURL(path.join(ROOT, 'codeply-cli/lib/native-tools.mjs')).href);
  const defs = JSON.stringify(NT.buildToolSchemas({ gmail_read: ['id'], calendar_update: ['id', 'start', 'cancel'], gmail_send: ['to', 'cc'] }));
  check('native definitions describe the new tools and cc', /whole email/.test(defs) && /never calendar_add a second one/.test(defs) && /addresses to copy/.test(defs), defs.slice(0, 300));

  // A 48 hour event shows the day it ends.
  const fri = Date.parse('2030-11-08T13:00:00Z');
  store.upsertItem({ id: 'calendar:hack', source: 'calendar', kind: 'event', at: fri, end: fri + 48 * HOUR, title: 'HackLahore 48h hackathon', place: 'NIC Lahore' });
  const wk = await L.contextTool({ about: 'week' }, { now: fri - 2 * 24 * HOUR, tz: 'Asia/Karachi' });
  check('an event ending on another day shows that day', /Fri 8 Nov.*18:00 to Sun 10 Nov.*18:00.*HackLahore/.test(wk.output) && !/18:00 to 18:00/.test(wk.output), wk.output);

  // A plan that is already on the calendar is not saved twice.
  const match = Date.parse('2030-11-06T15:00:00Z'); // 20:00 in Karachi
  store.upsertItem({ id: 'calendar:cricket', source: 'calendar', kind: 'event', at: match, end: match + 3 * HOUR, title: 'Cricket match at Gaddafi', place: 'Gaddafi Stadium' });
  const saved = L.notePlans([{ what: 'cricket match with Usman', when: '2030-11-06T19:30', where: 'Gaddafi Stadium' }, { what: 'Dinner with Ayesha', when: '2030-11-06T21:00', where: 'Cafe Aylanto' }], { now: match - 24 * HOUR, tz: 'Asia/Karachi' });
  check('a plan already on the calendar is skipped, a new one is kept', saved.length === 1 && /Dinner/.test(saved[0].title), JSON.stringify(saved.map((x) => x.title)));
  check('same words far apart in time are different events', !L.sameEvent({ title: 'Cricket match', at: match }, { title: 'Cricket practice', at: match + 5 * HOUR }) && L.sameEvent({ title: 'Cricket match', at: match }, { title: 'cricket with Usman', at: match - HOUR }));
  // Saved before this fix: the leaving nudge still goes out once.
  store.upsertItem({ id: 'plans:old:cricket', source: 'plans', kind: 'plan', at: match - 30 * 60000, title: 'Cricket with Usman', place: 'Gaddafi Stadium' });
  const TR = require(path.join(ROOT, 'codeply-cli/lib/life-triggers.js'));
  const at = match - 15 * 60000;
  const snap = L.snapshot({ now: at, tz: 'Asia/Karachi' });
  const leave = TR.due({ store, snap, settings: { perDay: 6, quiet: { on: false } }, now: at }).filter((c) => c.trigger === 'leaving');
  check('one "leave now" nudge for one match', leave.length === 1 && leave[0].key === 'leaving:calendar:cricket', JSON.stringify(leave.map((c) => c.key)));
  L.detach(); store.close();
}

// ─── End to end: a real agent run against a fake model ─────────────────────
if (section('Agent run')) {
  fresh('agent');
  const http = await import('http');
  let script = []; const bodies = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      bodies.push(JSON.parse(raw || '{}'));
      const text = script.shift() ?? 'Done.';
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const route = { custom: { id: 't', name: 'Fake', kind: 'openai', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'fake', apiKey: 'x', toolMode: 'text' } };
  const { runAgent } = await import(pathToFileURL(path.join(ROOT, 'codeply-cli/lib/agent.mjs')).href);
  const proj = path.join(tmp, 'startup-idea');
  fs.mkdirSync(proj, { recursive: true });
  const drive = async (replies, o = {}) => {
    script = [...replies]; bodies.length = 0;
    const events = [];
    for await (const ev of runAgent({ userMessage: o.message || 'set up the login page', history: [], mode: 'Build', cwd: proj, approve: async () => 'once', signal: new AbortController().signal, route, maxSteps: 6, handOff: o.handOff, botId: o.botId, botPrompt: o.botPrompt })) events.push(ev);
    return events;
  };

  // Talked through in Crew...
  BR.observe({ kind: 'decision', project: 'startup-idea', slot: 'auth provider', value: 'Supabase', text: 'Auth uses Supabase with magic links.', certainty: 'stated' }, crew());
  BR.observe({ kind: 'preference', slot: 'reply length', value: 'short', text: 'The user wants short replies.', certainty: 'stated' }, crew());
  // ...then built in Craft.
  await drive(['On it.']);
  const sent = JSON.stringify(bodies[0].messages);
  check('the model sees the Crew decision when the user codes in Craft', /CODEPLY BRAIN/.test(sent) && /magic links/.test(sent) && /short replies/.test(sent));

  await drive(['<codeply:remember>\n<kind>decision</kind>\n<slot>ui library</slot>\n<value>shadcn</value>\n<text>The UI uses shadcn components.</text>\n<certainty>stated</certainty>\n</codeply:remember>', 'Saved that.'], { message: 'we will use shadcn for the ui, remember that' });
  check('a remember block from the model lands in the brain, under this project', BR.list({ scope: 'project:startup-idea', text: 'shadcn' }).length === 1);
  const second = JSON.stringify(bodies[1] ? bodies[1].messages.slice(-1) : '');
  check('and the model is told it was saved', /Saved/.test(second), second.slice(0, 300));

  const queued = [];
  BR.setCoordinator(async (h) => { queued.push(h); return { taskId: 'tk' }; });
  for (const b of B.listBots()) B.removeBot(b.id);
  const cal = B.createBot({ name: 'Cleo', specialty: 'Calendar and scheduling' });
  const handOff = (args) => BR.handOff(args, { requester: 'user' });
  await drive(['<codeply:hand_off>\n<to>calendar</to>\n<intent>Book a 30 minute review with Sara on Friday at 15:00 (Asia/Karachi).</intent>\n<facts>Sara: sara@example.com</facts>\n</codeply:hand_off>', 'Handed the booking to Cleo.'], { message: 'and get a review with Sara on the calendar for friday 3pm', handOff });
  check('a hand_off block from the model reaches the calendar bot', queued.length === 1 && queued[0].toBot === cal.id && queued[0].requester === 'user' && queued[0].facts[0] === 'Sara: sara@example.com', JSON.stringify(queued));
  const noHost = await drive(['<codeply:hand_off>\n<to>calendar</to>\n<intent>x</intent>\n</codeply:hand_off>', 'ok'], { message: 'hand it on' });
  check('with no handOff for the run, the model is told to do it itself', JSON.stringify(bodies.map((b) => b.messages.slice(-1))).includes('not available'), JSON.stringify(noHost.filter((e) => e.type === 'tool_end')).slice(0, 300));
  BR.setCoordinator(null);

  // A long task: so much is written that the middle of the turn gets summarized.
  const big = (i) => `<codeply:write_file>\n<path>part${i}.txt</path>\n<content>\n${`line ${i} `.repeat(5000)}\n</content>\n</codeply:write_file>`;
  await drive([big(1), big(2), big(3), big(4), big(5), big(6), 'Objective: write the parts. Next Move: write part 7.', big(7), 'All seven parts are written.'], { message: 'write the seven big parts of the atlas export' });
  const summarized = bodies.findIndex((b) => JSON.stringify(b.messages).includes('[context summary]'));
  const after = summarized >= 0 ? JSON.stringify(bodies[summarized].messages) : '';
  check('a long task that gets summarized still carries the brain', summarized > 0 && /CODEPLY BRAIN/.test(after) && /magic links/.test(after), `summary at request ${summarized}`);

  // A closing promise to the user is a final answer; an announced step is not.
  await drive(['Good luck with the exam! I\'ll check in next week to see how it went.'], { message: 'thanks, that is all' });
  check('"I\'ll check in next week" ends the turn, no nudge', bodies.length === 1, JSON.stringify(bodies.map((b) => b.messages.slice(-1))).slice(0, 300));
  await drive(['Let me check the login file.', 'Done.'], { message: 'is the login ok' });
  check('"Let me check the login file." still gets the nudge', bodies.length === 2 && /announces what you are about to do/.test(JSON.stringify(bodies[1].messages.slice(-1))));

  // Companion bots do not get the coding skill library pushed at them.
  const life = B.createBot({ name: 'Buddy', specialty: 'Personal life: friends, plans, birthdays' });
  const coder = B.createBot({ name: 'Hack', specialty: 'Hackathon: team, code, the app', handles: ['code'] });
  await drive(['ok'], { message: 'build a remotion video and a blender scene for the billing page', botId: life.id, botPrompt: 'You are Buddy.' });
  const lifeSys = String(bodies[0].messages[0].content);
  check('a companion bot gets a one-line skills note, no catalog or matches', /Playbooks exist for specific kinds of work/.test(lifeSys) && !/LIKELY RELEVANT TO THIS REQUEST \(matched/.test(JSON.stringify(bodies[0].messages)) && !/Optional playbooks/.test(lifeSys), lifeSys.slice(lifeSys.lastIndexOf('SKILLS'), lifeSys.lastIndexOf('SKILLS') + 300));
  await drive(['ok'], { message: 'build a remotion video and a blender scene for the billing page', botId: coder.id, botPrompt: 'You are Hack.' });
  check('a code bot still gets the skills', !/Playbooks exist for specific kinds of work/.test(String(bodies[0].messages[0].content)) && /LIKELY RELEVANT TO THIS REQUEST \(matched/.test(JSON.stringify(bodies[0].messages)));

  // The new tags parse in text mode: cc on a send, an edit by id.
  fakeGoogle();
  google.sent.length = 0; google.patched.length = 0;
  await drive(['<codeply:gmail_send>\n<to>sana@example.com</to>\n<cc>hamza@example.com</cc>\n<subject>Team</subject>\n<body>\nIn.\n</body>\n</codeply:gmail_send>', 'Sent.'], { message: 'email sana, cc hamza' });
  check('a cc tag from the model reaches the email', google.sent.length === 1 && google.sent[0].cc === 'hamza@example.com', JSON.stringify(google.sent));
  await drive(['<codeply:calendar_update>\n<id>evF</id>\n<start>2030-11-05T21:00</start>\n</codeply:calendar_update>', 'Moved.'], { message: 'move futsal to 9' });
  check('a calendar_update block from the model moves the event', google.patched.length === 1 && google.patched[0].id === 'evF', JSON.stringify(google.patched));
  server.close();
}

BR.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : '\nAll passed');
process.exit(failures ? 1 : 0);
