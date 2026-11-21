// Run: node sidecar/ext-reminders.test.mjs
// Reminders on the PC (ext-reminders.mjs) against a fake `reminders` edge function: no network, no
// real sign-in. The fake keeps the account's rows the way the function does.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '..', '..', 'codeply-cli');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codeply-rem-'));
process.env.HOME = tmp;
process.env.USERPROFILE = tmp;
process.env.CODEPLY_WISP_DIR = path.join(tmp, 'wisp');
fs.mkdirSync(process.env.CODEPLY_WISP_DIR, { recursive: true });

const require = createRequire(path.join(CLI, 'lib', 'x.js'));
const real = (name) => require(path.join(CLI, 'lib', name));

// ---------- the fake account and function ----------
let token = 'tok-secret';
let rows = [];
let nextId = 1;
const calls = [];
globalThis.fetch = async (url, init) => {
  assert.match(String(url), /\/functions\/v1\/reminders$/);
  assert.equal(init.headers.Authorization, `Bearer ${token}`);
  const b = JSON.parse(init.body);
  calls.push(b);
  const ok = (extra) => ({ ok: true, status: 200, json: async () => ({ success: true, ...extra }) });
  if (b.action === 'list') return ok({ reminders: rows });
  if (b.action === 'create') { const r = { id: `r${nextId++}`, status: 'pending', created_at: new Date().toISOString(), ...b.reminder }; rows.push(r); return ok({ reminder: r }); }
  if (b.action === 'delete') { rows = rows.filter((r) => r.id !== b.id); return ok({}); }
  if (b.action === 'snooze') { const r = rows.find((x) => x.id === b.id); r.status = 'snoozed'; r.due_at = new Date(Date.now() + b.minutes * 60000).toISOString(); return ok({ reminder: r }); }
  return { ok: false, status: 400, json: async () => ({ success: false, error: 'bad action' }) };
};
const auth = { SUPABASE_URL: 'https://example.invalid', SUPABASE_ANON_KEY: 'anon', getAccessToken: async () => token };
const events = [];
const ctx = {
  CLI, DATA: path.join(tmp, 'rune'), missing: {}, shared: {}, hooks: {},
  need: (n) => (n === 'auth.js' ? auth : real(n)),
  emit: (_s, e) => events.push(e),
  readJson: async (req) => req.body,
};
fs.mkdirSync(ctx.DATA, { recursive: true });

const rem = await import('./ext-reminders.mjs');
const reach = real('reach.js');
rem.start(ctx);
assert.ok(ctx.shared.reminders, 'shared handle');
assert.ok(reach.available(), 'reach_me is wired to the phone reminders');

const call = async (method, p, body) => {
  let out = null;
  const handled = await rem.route(ctx, { method, body }, null, new URL(`http://x${p}`), p, (_s, o) => { out = o; });
  assert.ok(handled, `${method} ${p} handled`);
  return out;
};

let failed = 0;
const check = async (name, fn) => { try { await fn(); console.log(`PASS  ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}\n      ${e.message}`); } };

await check('parseAsk reads the phone phrases', () => {
  const a = rem.parseAsk('remind me in 20 minutes: call mom');
  assert.equal(a.text, 'call mom');
  assert.ok(Math.abs(Date.parse(a.at) - (Date.now() + 20 * 60000)) < 5000);
  assert.equal(rem.parseAsk('remind me every day at 9 to drink water').repeat, 'daily');
  assert.equal(rem.parseAsk('call me in 5 minutes').kind, 'call');
  assert.equal(rem.parseAsk('what is the weather'), null);
});

await check('POST /ext/reminders with an ISO time creates through the function', async () => {
  const at = new Date(Date.now() + 3600000).toISOString();
  const r = await call('POST', '/ext/reminders', { at, text: 'stand up', kind: 'remind' });
  assert.equal(r.ok, true);
  assert.equal(r.reminder.text, 'stand up');
  assert.equal(r.reminders.length, 1);
  assert.ok(events.some((e) => e.type === 'reminders_changed'));
  const sent = calls.find((c) => c.action === 'create').reminder;
  assert.equal(sent.bot_name, 'Codeply');
  assert.equal(sent.kind, 'remind');
});

await check('POST with plain words (when) and a specialist', async () => {
  const w = real('wisp.js');
  const s = w.listSpecialists()[0];
  const r = await call('POST', '/ext/reminders', { when: 'in 10 minutes', text: 'check the oven', specialist: s.name });
  assert.equal(r.ok, true, JSON.stringify(r));
  const sent = rows[rows.length - 1];
  assert.equal(sent.bot_id, s.id);
  assert.equal(sent.bot_name, s.name);
  assert.equal(sent.text, 'check the oven');
});

await check('a time that has passed is refused with a plain message', async () => {
  const r = await call('POST', '/ext/reminders', { at: new Date(Date.now() - 3600000).toISOString(), text: 'late' });
  assert.equal(r.ok, false);
  assert.match(r.error, /already passed/);
});

await check('GET lists upcoming ones, soonest first', async () => {
  const r = await call('GET', '/ext/reminders');
  assert.equal(r.signedIn, true);
  assert.equal(r.reminders.length, 2);
  assert.ok(Date.parse(r.reminders[0].dueAt) <= Date.parse(r.reminders[1].dueAt));
  assert.ok(r.reminders.every((x) => x.upcoming));
});

await check('cancel by id', async () => {
  const id = rows[0].id;
  const r = await call('POST', '/ext/reminders/cancel', { id });
  assert.equal(r.ok, true);
  assert.equal(rows.some((x) => x.id === id), false);
});

await check('cancel in plain words, from a chat', async () => {
  await call('POST', '/ext/reminders', { ask: 'remind me in 30 minutes: water the plants' });
  await call('POST', '/ext/reminders', { ask: 'remind me in 40 minutes: call the bank' });
  const r = await rem.chatAsk({ kind: '' }, 'cancel my water the plants reminder');
  assert.match(r.line, /Cancelled/);
  assert.equal(rows.some((x) => /plants/.test(x.text)), false);
  assert.equal(rows.some((x) => /bank/.test(x.text)), true);
  const all = await rem.chatAsk({ kind: '' }, 'delete all my reminders');
  assert.match(all.line, /Cancelled/);
  assert.equal(rows.length, 0);
  const none = await rem.chatAsk({ kind: '' }, 'cancel my reminders');
  assert.match(none.line, /no upcoming/);
});

await check('chatAsk sets a reminder, and says so itself', async () => {
  const r = await rem.chatAsk({ kind: '' }, 'remind me in 2 minutes: test');
  assert.match(r.line, /Reminder set: test/);
  assert.match(r.note, /Confirm it/);
  assert.equal(await rem.chatAsk({ kind: '' }, 'hello there'), null);
});

await check('reach_me (the agent tool) creates a reminder as the named specialist', async () => {
  const r = await reach.reachMe({ how: 'text', message: 'stretch', at: 'in 15 minutes' }, {});
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(rows[rows.length - 1].text, 'stretch');
});

await check('a due reminder is announced once', async () => {
  events.length = 0;
  rem.__state.setList([{ id: 'due1', text: 'now', due_at: new Date(Date.now() - 1000).toISOString(), status: 'pending', kind: 'remind' }]);
  rem.__state.checkDue();
  rem.__state.checkDue();
  assert.equal(events.filter((e) => e.type === 'reminder_due').length, 1);
});

await check('signed out: a clear message, no crash, no token sent', async () => {
  token = null;
  calls.length = 0;
  const r = await call('POST', '/ext/reminders', { when: 'in 5 minutes', text: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.signedOut, true);
  assert.equal(calls.length, 0);
  const g = await call('GET', '/ext/reminders');
  assert.equal(typeof g.error, 'string');
});

process.exit(failed ? 1 : 0);
