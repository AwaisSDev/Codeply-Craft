// Run: node sidecar/ext-agentsync.test.mjs
// Chat sync, job reports into a chat, standing orders and the specialist editor (ext-agentsync.mjs)
// against a fake Supabase client and a fake engine: no network, no model.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '..', '..', 'codeply-cli');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codeply-asy-'));
process.env.HOME = tmp;
process.env.USERPROFILE = tmp;
process.env.CODEPLY_WISP_DIR = path.join(tmp, 'wisp');
fs.mkdirSync(process.env.CODEPLY_WISP_DIR, { recursive: true });
const require = createRequire(path.join(CLI, 'lib', 'x.js'));
const real = (name) => require(path.join(CLI, 'lib', name));
const W = real('wisp.js');

// ---------- a tiny Supabase: tables of rows, the query calls the sync makes ----------
const tables = { chats: [], specialist_runs: [] };
function query(name) {
  const f = []; let lim = Infinity; let order = null; let pending = null;
  const q = {
    select() { return q; },
    gt(col, v) { f.push((r) => String(r[col]) > String(v)); return q; },
    in(col, vs) { f.push((r) => vs.includes(r[col])); return q; },
    eq(col, v) { f.push((r) => r[col] === v); return q; },
    order(col, o) { order = [col, o && o.ascending === false ? -1 : 1]; return q; },
    limit(n) { lim = n; return q; },
    upsert(rows) {
      pending = rows;
      for (const r of rows) {
        const i = tables[name].findIndex((x) => x.id === r.id);
        if (i >= 0) tables[name][i] = { ...r }; else tables[name].push({ ...r });
      }
      return q;
    },
    then(res, rej) {
      let data = pending ? null : tables[name].filter((r) => f.every((fn) => fn(r)));
      if (data && order) data = data.sort((a, b) => (String(a[order[0]]) < String(b[order[0]]) ? -1 : 1) * order[1]);
      if (data) data = data.slice(0, lim);
      return Promise.resolve({ data, error: null }).then(res, rej);
    },
  };
  return q;
}
const client = { from: query };
const auth = { getSession: async () => ({ user: { id: 'u1' } }), getClient: () => client };

// ---------- a fake engine ----------
const events = [];
const sessions = [];
const runsSet = new Set();
const started = [];
let idn = 0;
const api = {
  sessions: () => sessions,
  find: (id) => sessions.find((s) => s.id === id) || null,
  meta: (s) => ({ id: s.id, title: s.title }),
  save() {}, saveNow() {}, newId: (p) => `${p}${++idn}`, runs: runsSet,
  startRun: async (session, text, opts) => {
    started.push({ text, refs: opts && opts.refs });
    session.messages.push({ kind: 'user', text, at: Date.now() });
    session.messages.push({ kind: 'assistant', text: 'Got it.', at: Date.now() });
    return { ok: true, text: 'Got it.' };
  },
};
const ctx = {
  CLI, DATA: path.join(tmp, 'rune'), DEFAULT_CWD: tmp, missing: {}, shared: {}, hooks: { beforeMessage: [], prompt: [] },
  need: (n) => (n === 'auth.js' ? auth : real(n)),
  emit: (s, e) => events.push(e), readJson: async (req) => req.body, api,
};
fs.mkdirSync(ctx.DATA, { recursive: true });
const asy = await import('./ext-agentsync.mjs');
asy.start(ctx);
const T = asy.__test;

let failed = 0;
const check = async (name, fn) => { try { await fn(); console.log(`PASS  ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}\n      ${e.message}`); } };
const spec = W.listSpecialists().find((s) => !s.builtin) || W.createSpecialist({ name: 'Scout', focus: 'finding things', instructions: 'You find things and report them clearly and briefly.' }).specialist;
const specName = (W.findSpecialist(spec.name) || spec).name;
const route = async (method, p, body) => {
  let out = null;
  assert.ok(await asy.route(ctx, { method, body }, null, new URL(`http://x${p}`), p, (_s, o) => { out = o; }));
  return out;
};

await check('a phone chat with a specialist becomes a PC chat for that specialist', async () => {
  const now = Date.now();
  tables.chats.push({
    user_id: 'u1', id: 'ph1', deleted: false, updated_at: new Date(now).toISOString(),
    meta: { id: 'ph1', title: 'Chat with Scout', kind: 'chat', updatedAt: now, specialist: { id: spec.id, name: specName } },
    body: { messages: [{ role: 'user', content: 'hi', at: now - 2000 }, { role: 'assistant', content: `-# ${specName}\nhello`, at: now - 1000, sources: [] }], pcItems: [{ x: 1 }], tasks: [] },
  });
  await asy.__test.syncOnce();
  const s = api.find('ph1');
  assert.ok(s, 'chat taken');
  assert.equal(s.kind, 'agent');
  assert.equal(s.agent, specName);
  assert.deepEqual(s.messages.map((m) => [m.kind, m.text]), [['user', 'hi'], ['assistant', 'hello']]);
  assert.ok(events.some((e) => e.type === 'session_sync'));
});

await check('a PC chat goes up in the phone format, keeping what the phone added', async () => {
  const s = api.find('ph1');
  s.messages.push({ kind: 'tool', text: '', name: 'read' }, { kind: 'user', text: 'more', at: Date.now() }, { kind: 'assistant', text: 'sure', at: Date.now() + 1 });
  s.updatedAt = Date.now() + 1;
  await asy.__test.syncOnce();
  const row = tables.chats.find((r) => r.id === 'ph1');
  assert.deepEqual(row.body.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
  assert.match(row.body.messages[3].content, new RegExp(`^-# ${specName}\\nsure`));
  assert.deepEqual(row.body.pcItems, [{ x: 1 }], 'phone-only fields kept');
  assert.equal(row.meta.specialist.name, specName);
});

await check('a PC-only chat uploads; a code chat and a job chat do not', async () => {
  const t = Date.now();
  sessions.push({ id: 'pc1', title: 'Plan', cwd: tmp, messages: [{ kind: 'user', text: 'plan it', at: t }, { kind: 'assistant', text: 'ok', at: t + 1 }], updatedAt: t + 1, createdAt: t });
  sessions.push({ id: 'code1', title: 'Code', kind: 'code', cwd: tmp, messages: [{ kind: 'user', text: 'x', at: t }], updatedAt: t });
  await asy.__test.syncOnce();
  assert.ok(tables.chats.find((r) => r.id === 'pc1'));
  assert.equal(tables.chats.find((r) => r.id === 'code1'), undefined);
});

await check('syncing twice does not duplicate messages on either side', async () => {
  await asy.__test.syncOnce(); await asy.__test.syncOnce();
  assert.equal(api.find('ph1').messages.filter((m) => m.kind === 'user').length, 2);
  assert.equal(tables.chats.find((r) => r.id === 'ph1').body.messages.length, 4);
});

await check('a chat deleted on the phone is removed here; one deleted here is removed there', async () => {
  const row = tables.chats.find((r) => r.id === 'pc1');
  Object.assign(row, { deleted: true, updated_at: new Date(Date.now() + 5000).toISOString() });
  await asy.__test.syncOnce();
  assert.equal(api.find('pc1'), null);
  sessions.splice(sessions.indexOf(api.find('ph1')), 1);
  await asy.__test.syncOnce();
  assert.equal(tables.chats.find((r) => r.id === 'ph1').deleted, true);
});

await check('a standing order in a specialist chat is a real job that reports to that chat, and the app confirms it', async () => {
  const t = Date.now();
  const chat = { id: 'chatA', title: `Chat with ${specName}`, cwd: tmp, kind: 'agent', agent: specName, messages: [], updatedAt: t, createdAt: t };
  sessions.push(chat);
  const took = await asy.__test.beforeMessage(chat, 'every hour check the Hacker News front page for Rust posts');
  assert.equal(took, true);
  const job = W.store.loadSchedules().find((j) => j.chatId === 'chatA');
  assert.ok(job, 'job saved with chatId');
  assert.equal(job.specialist, spec.id);
  assert.match(job.task, /Hacker News/);
  assert.equal(started.length, 1);
  assert.equal(started[0].text, 'every hour check the Hacker News front page for Rust posts');
  const note = await ctx.hooks.prompt[0](chat, started[0].refs);
  assert.match(note, /saved this as your standing job/);
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(chat.messages.some((m) => m.kind === 'notice' && /Saved as .* standing job/.test(m.text)));
  // the same order again is not a second job
  await asy.__test.beforeMessage(chat, 'every hour check the Hacker News front page for Rust posts');
  assert.equal(W.store.loadSchedules().filter((j) => j.chatId === 'chatA').length, 1);
});

await check('ordinary messages and busy chats are left alone', async () => {
  const chat = api.find('chatA');
  assert.equal(await asy.__test.beforeMessage(chat, 'what is a monad?'), false);
  assert.equal(await asy.__test.beforeMessage(chat, 'does it run every hour?'), false);
  runsSet.add('chatA');
  assert.equal(await asy.__test.beforeMessage(chat, 'every day at 9 check the weather'), false);
  runsSet.delete('chatA');
  const plain = { id: 'plain', title: 'x', cwd: tmp, messages: [], kind: '' };
  assert.equal(await asy.__test.beforeMessage(plain, 'every hour check the weather'), false, 'no specialist, no deterministic job');
});

await check('a job report from the server lands in the job chat once, and is notified', async () => {
  const job = W.store.loadSchedules().find((j) => j.chatId === 'chatA');
  const at = new Date(Date.now() + 60000).toISOString();
  tables.specialist_runs.push({ id: 'run1', job_id: job.id, specialist: spec.id, task: job.task, output: '3 new Rust posts.', ok: true, origin: 'cloud', at });
  events.length = 0;
  await asy.__test.syncOnce();
  const chat = api.find('chatA');
  const m = chat.messages.filter((x) => x.report);
  assert.equal(m.length, 1);
  assert.equal(m[0].text, '3 new Rust posts.');
  assert.ok(events.some((e) => e.type === 'job_report' && e.chatId === 'chatA' && e.origin === 'cloud'));
  await asy.__test.syncOnce();
  assert.equal(chat.messages.filter((x) => x.report).length, 1, 'not again');
  const row = tables.chats.find((r) => r.id === 'chatA');
  assert.match(row.body.messages.find((x) => /3 new Rust/.test(x.content)).content, /standing job\n3 new Rust posts/);
  assert.ok(row.meta.runsSeenAt >= Date.parse(at), 'the phone will not land it twice');
});

await check('a failed run says so in the chat', async () => {
  const job = W.store.loadSchedules().find((j) => j.chatId === 'chatA');
  tables.specialist_runs.push({ id: 'run2', job_id: job.id, specialist: spec.id, task: '', output: 'no network', ok: false, origin: 'pc', at: new Date(Date.now() + 120000).toISOString() });
  await asy.__test.syncOnce();
  assert.ok(api.find('chatA').messages.some((m) => /did not finish: no network/.test(m.text)));
});

await check('specialist editor routes expose the face and take edits', async () => {
  const g = await route('GET', '/ext/agentsync/specialists');
  const s = g.specialists.find((x) => x.id === spec.id);
  assert.ok(s.shape && s.color && 'gear' in s && 'voice' in s);
  assert.ok(s.jobs.some((j) => j.chatId === 'chatA'));
  const u = await route('POST', '/ext/agentsync/specialists/update', { id: spec.id, voice: 'calm and warm', alwaysOn: true, color: '#112233' });
  assert.equal(u.ok, true);
  assert.equal(u.specialist.voice, 'calm and warm');
  assert.equal(u.specialist.alwaysOn, true);
  assert.equal(u.specialist.color, '#112233');
  assert.equal((await route('POST', '/ext/agentsync/specialists/update', { id: 'nope' })).ok, false);
});

await check('status route, and a missing chats table is "setup", not an error', async () => {
  const s = await route('GET', '/ext/agentsync');
  assert.equal(s.chats.state, 'on');
  assert.ok(s.reports.length >= 1);
  const was = client.from;
  client.from = () => ({ select: () => ({ gt: () => ({ order: () => ({ limit: async () => ({ data: null, error: { message: 'relation "public.chats" does not exist' } }) }) }) }) });
  const r = await asy.__test.syncOnce();
  client.from = was;
  assert.equal(r.state, 'setup');
});

process.exit(failed ? 1 : 0);
