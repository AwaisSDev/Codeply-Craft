// The spine (codeply-cli/lib/spine.js): the ledger, read-back proof for
// calendar and Gmail, no double sends, recovery after a crash, the morning
// message and the shared context every surface reads (node scripts/spine-test.mjs).
// No network and no model: Google is a fake, every store a temp file.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'codeply-cli');
const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codeply-spine-'));
process.env.CODEPLY_SPINE_DB = path.join(tmp, 'ledger.db');
process.env.CODEPLY_BRAIN_DB = path.join(tmp, 'brain.db');
process.env.CODEPLY_BOTS_DIR = path.join(tmp, 'bots');

const S = require(path.join(CLI, 'lib/spine.js'));
const oauth = require(path.join(CLI, 'lib/oauth-connectors.js'));
const config = require(path.join(CLI, 'lib/config.js'));
const LS = require(path.join(CLI, 'lib/life-store.js'));
const L = require(path.join(CLI, 'lib/life.js'));
const T = require(path.join(CLI, 'lib/life-triggers.js'));
const M = require(path.join(CLI, 'lib/morning.js'));
const SC = require(path.join(CLI, 'lib/shared-context.js'));
const { executeTool, recoverInterrupted } = await import(pathToFileURL(path.join(CLI, 'lib/tools.mjs')).href);

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`  ok    ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${extra ? `\n        ${String(extra).slice(0, 800)}` : ''}`); }
}
const section = (name) => console.log(`\n${name}`);
const fresh = (name) => S.configure({ file: path.join(tmp, `${name}.db`) });

// A pretend Google that behaves like the real one where it matters: a
// client-chosen event id that exists is a 409, and everything reads back.
const g = { events: new Map(), sent: [], drafts: [], inserts: 0, lie: null };
const getIntegration = config.getIntegration;
config.getIntegration = (name) => (name === 'gmail' ? { accessToken: 'tok', expiresAt: Date.now() + 86400000, email: 'me@example.com', scope: Object.values(oauth.GOOGLE_SCOPE).join(' ') } : getIntegration(name));
oauth.calendarInsertEvent = async (tok, ev) => {
  g.inserts++;
  const id = ev.id || `ev${g.inserts}`;
  if (g.events.has(id)) throw Object.assign(new Error('The requested identifier already exists.'), { status: 409, duplicate: true });
  g.events.set(id, { ...ev, id, status: 'confirmed' });
  return { id, htmlLink: '' };
};
oauth.calendarGetEvent = async (tok, id) => {
  const e = g.events.get(id);
  if (!e) return null;
  return g.lie ? { ...e, ...g.lie } : e;
};
oauth.calendarPatchEvent = async (tok, id, patch) => { const e = g.events.get(id); Object.assign(e, patch); return e; };
oauth.calendarDeleteEvent = async (tok, id) => { const e = g.events.get(id); if (e) e.status = 'cancelled'; return { ok: true }; };
oauth.gmailSend = async (tok, m) => { g.sent.push(m); return { id: `s${g.sent.length}` }; };
oauth.gmailCreateDraft = async (tok, d) => { g.drafts.push(d); return { id: `d${g.drafts.length}`, message: { id: `dm${g.drafts.length}` } }; };
oauth.gmailGetMessage = async (tok, id) => {
  const s = /^s(\d+)$/.exec(id) ? g.sent[Number(id.slice(1)) - 1] : /^dm(\d+)$/.exec(id) ? g.drafts[Number(id.slice(2)) - 1] : null;
  if (!s) throw Object.assign(new Error('Not Found'), { status: 404 });
  return { id, labels: [id.startsWith('s') ? 'SENT' : 'DRAFT'], to: s.to || '', subject: s.subject || '', body: s.body || '' };
};

const approve = async () => 'once';
const ctxFor = (chatId, userMessage) => ({ cwd: tmp, mode: 'Build', approve, chatId, userMessage, route: { custom: {} } });

fresh('probe');
if (!S.available()) { console.log('No SQLite driver on this Node: the spine cannot be tested here.'); process.exit(1); }

// ─── The ledger ─────────────────────────────────────────────────────────────
section('Ledger');
{
  fresh('ledger');
  const t = S.startTask({ goal: 'book the dentist' });
  check('same task, tool and arguments: same key, whatever the order', S.actionKey(t, 'x', { a: 1, b: 2 }) === S.actionKey(t, 'x', { b: 2, a: 1 }));
  const a = S.beginAction(t, 'calendar_add', { title: 'Dentist' });
  check('an action is written before it runs', S.task(t).actions[0].status === 'started' && S.task(t).status === 'running');
  S.endAction(a.id, { ok: true, summary: 'Dentist', evidence: [{ type: 'api_readback', ok: true, detail: 'read back' }] });
  check('checked and passed: done_verified', S.task(t).status === 'done_verified', S.task(t).status);
  const b = S.beginAction(t, 'gmail_send', { to: 'x@y.z' });
  S.endAction(b.id, { ok: true, summary: 'to x@y.z' });
  check('one thing nothing checked: done_unverified', S.task(t).status === 'done_unverified', S.task(t).status);
  check('the line says so', /not verified/.test(S.actionLine(S.task(t).actions[1])), S.actionLine(S.task(t).actions[1]));
  const c = S.beginAction(t, 'calendar_update', { id: 'e1' });
  S.endAction(c.id, { ok: true, evidence: [{ type: 'api_readback', ok: false, detail: 'it starts at 10:00' }] });
  check('a failed check wins: check_failed', S.task(t).status === 'check_failed', S.task(t).status);
  const t2 = S.startTask({});
  S.endAction(S.beginAction(t2, 'gmail_send', {}).id, { ok: false, rejected: true });
  check('the user said no to all of it: declined', S.task(t2).status === 'declined');
  const t3 = S.startTask({ goal: 'my key is sk-abcdefghijklmnop1234' });
  check('secret-looking strings are masked in the ledger', !/sk-abcdef/.test(S.task(t3).goal), S.task(t3).goal);
}

// ─── Read-back proof through the real tools ────────────────────────────────
section('Proof');
{
  fresh('proof');
  const ctx = ctxFor('chat-a', 'put gym at 6pm on my calendar');
  const r = await executeTool('calendar_add', { title: 'Gym', start: '2026-11-02T18:00' }, ctx);
  check('calendar_add reads the event back', r.ok && /Checked: it is on the calendar/.test(r.output), r.output);
  const t = S.task(ctx.spineTaskId);
  check('the ledger has the task, its goal and verified proof', t && t.goal.includes('gym') && t.status === 'done_verified' && t.actions[0].evidence[0].type === 'api_readback', JSON.stringify(t));
  check('the event id comes from the ledger key', [...g.events.keys()].some((id) => id.startsWith('cp')));

  const again = await executeTool('calendar_add', { title: 'Gym', start: '2026-11-02T18:00' }, ctx);
  check('the same request again is one event, not two', g.events.size === 1 && /already added by an earlier try, so it was not added twice/.test(again.output), `${g.events.size} ${again.output}`);

  g.lie = { summary: 'Gym (moved)' };
  const ctx2 = ctxFor('chat-b', 'add standup');
  const bad = await executeTool('calendar_add', { title: 'Standup', start: '2026-11-03T09:00' }, ctx2);
  g.lie = null;
  check('a read-back that does not match says so to the model', /Warning: read back from Google Calendar, but its title is/.test(bad.output), bad.output);
  check('and the ledger records the failed check', S.task(ctx2.spineTaskId).status === 'check_failed');

  const ctx3 = ctxFor('chat-c', 'email Sara');
  const s1 = await executeTool('gmail_send', { to: 'sara@example.com', subject: 'Notes', body: 'Here they are.' }, ctx3);
  check('gmail_send finds it in Sent', /Checked: it is in Gmail Sent/.test(s1.output), s1.output);
  const s2 = await executeTool('gmail_send', { to: 'sara@example.com', subject: 'Notes', body: 'Here they are.' }, ctx3);
  check('the same email in the same task goes out once', g.sent.length === 1 && /Already done earlier in this task/.test(s2.output), `${g.sent.length} ${s2.output}`);
  const d = await executeTool('gmail_draft', { to: 'boss@example.com', subject: 'Leave', body: 'Friday off?' }, ctx3);
  check('gmail_draft finds it in Drafts', /Checked: it is in Gmail Drafts/.test(d.output), d.output);

  const ctx4 = ctxFor('chat-d', 'nothing');
  await executeTool('calendar_list', { from: 'today' }, ctx4);
  check('reading changes nothing in the ledger', !ctx4.spineTaskId);
}

// ─── A crash between doing and recording ───────────────────────────────────
section('Recovery');
{
  fresh('recovery');
  const t = S.startTask({ goal: 'crash test' });
  const landed = S.beginAction(t, 'calendar_add', { title: 'Landed' });
  g.events.set(`cp${landed.key.slice(0, 30)}`, { id: `cp${landed.key.slice(0, 30)}`, summary: 'Landed', status: 'confirmed' });
  S.beginAction(t, 'calendar_add', { title: 'Never made it' });
  S.beginAction(t, 'gmail_send', { to: 'a@b.c' });
  const settled = await recoverInterrupted({ olderThanMs: 0 });
  const by = (title) => S.task(t).actions.find((a) => a.args.includes(title));
  check('three interrupted actions settled', settled.length === 3, JSON.stringify(settled.map((a) => a && a.status)));
  check('the event that landed: done, with proof', by('Landed').status === 'done' && by('Landed').verified === 'yes');
  check('the event that did not: failed', by('Never made it').status === 'failed');
  check('an email we cannot confirm: unknown, never resent', by('a@b.c').status === 'unknown' && /not sure it went through/.test(S.actionLine(by('a@b.c'))));
}

// ─── The morning message ────────────────────────────────────────────────────
section('Morning');
{
  const tz = 'Asia/Karachi';
  const now = Date.parse('2026-11-02T03:30:00Z'); // 08:30 in Karachi
  let clock = now - 4 * 3600000; // the ledger's work happened overnight
  S.configure({ file: path.join(tmp, 'morning.db'), now: () => clock });
  const store = LS.openLifeStore({ file: path.join(tmp, 'life.db') });
  const night = now - 5 * 3600000;
  store.upsertItem({ id: 'gmail:1', source: 'gmail', kind: 'email_in', at: night, title: 'Contract for review', people: ['Usman Ali <usman@example.com>'], data: { level: 'very', score: 9 } });
  store.upsertItem({ id: 'gmail:2', source: 'gmail', kind: 'email_in', at: night, title: 'Weekly newsletter', people: ['News <n@example.com>'], data: { level: 'low', score: 1 } });
  store.upsertItem({ id: 'calendar:x', source: 'calendar', kind: 'event', at: Date.parse('2026-11-02T06:00:00Z'), end: Date.parse('2026-11-02T07:00:00Z'), title: 'Team sync', data: {} });
  store.setState('morning.drafts', [{ id: 'dr1', at: night, from: 'Usman Ali', subject: 'Contract for review' }]);
  const t = S.startTask({ goal: 'overnight work' });
  S.endAction(S.beginAction(t, 'calendar_add', { title: 'Dentist' }).id, { ok: true, summary: 'Dentist: Tue 10:00', evidence: [{ type: 'api_readback', ok: true, detail: 'read back from Google Calendar' }] });
  S.endAction(S.beginAction(t, 'slack_post_message', { text: 'hi' }).id, { ok: true, summary: 'Posted the update to #team' });
  const m = M.build({ store, snap: { tz, waiting: [{ from: 'Ayesha Khan', subject: 'Invoice' }] }, now, todos: [{ text: 'Buy Ayesha a gift' }] });
  const sec = (k) => (m.sections.find((s) => s.key === k) || { lines: [] }).lines.join(' | ');
  check('while you slept: the important email, not the newsletter', /Usman wrote "Contract for review"/.test(sec('slept')) && !/newsletter/i.test(sec('slept')), sec('slept'));
  check('what I did: checked work says checked', /Dentist: Tue 10:00 \(checked: read back from Google Calendar\)/.test(sec('did')), sec('did'));
  check('what I did: unchecked work says not verified', /Posted the update to #team \(not verified\)/.test(sec('did')), sec('did'));
  check('waiting on you: the overnight draft', /Draft reply to Usman/.test(sec('waiting')), sec('waiting'));
  check('your day: the meeting in local time, replies owed, to-dos', /11:00 Team sync/.test(sec('day')) && /Replies you owe: Ayesha/.test(sec('day')) && /Buy Ayesha a gift/.test(sec('day')), sec('day'));
  check('it ends by asking what to add', /Anything to add\?/.test(m.text));
  check('the notification line says what matters in words', m.summary === 'Good morning. Usman wrote "Contract for review". I did 2 things, 1 not confirmed. 1 thing needs your OK. First up: 11:00 Team sync.', m.summary);
  check('a quiet morning says so', M.build({ store: null, snap: { tz, waiting: [] }, now, since: now + 1 }).summary === 'Good morning. A quiet start: nothing new.');
  check('no long dash anywhere', !/[—–]/.test(m.text));

  const cands = T.GENERATORS.brief({ store, snap: { tz, waiting: [] }, now, atPc: true });
  check('the brief trigger carries the morning message, sent as written', cands.length === 1 && cands[0].verbatim && /Good morning/.test(cands[0].fallback));
  const at = (hm) => Date.parse(`2026-11-02T${hm}:00+05:00`);
  const gen = (hm, briefAt) => T.GENERATORS.brief({ store, snap: { tz, waiting: [] }, now: at(hm), atPc: false, settings: briefAt ? { briefAt } : {} }).length;
  check('a morning time the user picked: not a minute early, then for four hours', gen('18:12', '18:13') === 0 && gen('18:13', '18:13') === 1 && gen('22:12', '18:13') === 1 && gen('22:13', '18:13') === 0);
  check('the default 07:00 still waits for 09:00 when they are away from the PC', gen('08:00') === 0 && gen('09:30') === 1);
  const judged = T.parseJudge({ messages: [{ key: cands[0].key, send: true, text: 'Morning! Big day ahead.' }] }, cands);
  check('the judge cannot reword it', judged[0].text === cands[0].fallback);
  M.markSent(store, now);
  const later = M.build({ store, snap: { tz, waiting: [] }, now: now + 3600000 });
  check('after it went out, the next one starts from there', later.since === now && !/Draft reply/.test(later.text));
  store.close();
}

// ─── The shared context ─────────────────────────────────────────────────────
section('Shared context');
{
  fresh('shared');
  const t = S.startTask({ goal: 'add gym', chatId: 'crew-1' });
  S.endAction(S.beginAction(t, 'calendar_add', { title: 'Gym' }).id, { ok: true, summary: 'Gym: 18:00', evidence: [{ type: 'api_readback', ok: true, detail: 'read back from Google Calendar' }] });
  const block = SC.blockFor({ request: 'what did you do for me', chatId: 'craft-9', parts: ['recent'] });
  check('another chat sees what Codeply did, with its proof', /DONE LATELY IN CODEPLY/.test(block) && /Gym: 18:00 \(checked/.test(block), block);
  const own = SC.blockFor({ chatId: 'crew-1', parts: ['recent'] });
  check('the chat that did it is not told twice', own === '', own);
  const brain = SC.blockFor({ request: 'hello', parts: ['brain'] });
  check('the brain block comes through the same door', /CODEPLY BRAIN/.test(brain), brain.slice(0, 200));
  const r = await SC.runTool('remember', { kind: 'preference', slot: 'reply length', value: 'short', text: 'The user wants short replies.', certainty: 'stated' });
  const back = await SC.runTool('recall', { query: 'reply' });
  check('remember in one surface, recall in another', r.ok && /short replies/.test(back.output), `${r.output} / ${back.output}`);
}

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
