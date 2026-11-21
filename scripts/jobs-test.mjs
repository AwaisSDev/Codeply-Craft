// Standing jobs that finish on their own: wisp.js markFired backoff, and the Rust app's job runner
// (rune-app/sidecar/ext-team.mjs) against a fake engine. No model, no network.
//   node scripts/jobs-test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codeply-jobs-'));
process.env.CODEPLY_WISP_DIR = tmp;
const require = createRequire(import.meta.url);
const W = require(path.join(root, 'codeply-cli', 'lib', 'wisp.js'));

let failed = 0;
const check = (name, ok, extra) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && extra !== undefined ? `  ${JSON.stringify(extra)}` : ''}`); if (!ok) failed++; };
const MIN = 60000;
const reset = () => W.store.saveSchedules([]);
const team = W.listSpecialists();
const spec = team[0];

// ---------- markFired ----------
{
  reset();
  const t0 = Date.parse('2026-11-23T10:00:00');
  const add = W.addSchedule({ specialist: spec.id, task: 'check the site', when: 'every day at 9', now: t0 });
  check('a daily job is added', add.ok, add);
  const id = add.schedule.id;
  let s = W.markFired(id, { error: 'busy', started: false }, t0);
  check('could not start: tries again in 2 minutes', s.nextAt === t0 + 2 * MIN, s.nextAt - t0);
  s = W.markFired(id, { error: 'busy', started: false }, t0);
  check('could not start twice: 4 minutes', s.nextAt === t0 + 4 * MIN, s.nextAt - t0);
  check('not starting never counts as a run', !s.runs && !s.failures, s);
  for (let i = 0; i < 6; i++) s = W.markFired(id, { error: 'busy', started: false }, t0);
  check('waits cap at 30 minutes', s.nextAt === t0 + 30 * MIN, s.nextAt - t0);
  s = W.markFired(id, { error: 'model down', started: true }, t0);
  check('failed run: tries again in 10 minutes', s.nextAt === t0 + 10 * MIN && s.failures === 1, { d: s.nextAt - t0, f: s.failures });
  s = W.markFired(id, { error: 'model down', started: true }, t0);
  check('failed twice: 20 minutes', s.nextAt === t0 + 20 * MIN, s.nextAt - t0);
  s = W.markFired(id, { error: 'model down', started: true }, t0);
  check('failed three times: 40 minutes', s.nextAt === t0 + 40 * MIN, s.nextAt - t0);
  s = W.markFired(id, { error: 'model down', started: true }, t0);
  check('four failures in a row: needs you, and waits for its next normal time', !!s.needsYou && s.nextAt === W.nextRun(s.rule, t0) && s.failures === 0, s);
  s = W.markFired(id, { sessionId: 'c1' }, t0);
  check('a run that worked clears the failure and counts', !s.needsYou && !s.lastError && s.runs === 1 && s.nextAt === W.nextRun(s.rule, t0), s);
  s = W.markFired(id, { sessionId: 'c1', needsYou: ['Send the email to Sam'] }, t0);
  check('a run that left an approval says what waits for your yes', /Send the email to Sam/.test(s.needsYou), s.needsYou);

  // a retry never lands after the next normal run
  const late = Date.parse('2026-11-23T08:55:00');
  s = W.markFired(id, { error: 'x', started: true }, late);
  check('a retry is never later than the next normal run', s.nextAt <= W.nextRun(s.rule, late), new Date(s.nextAt).toISOString());

  // a one-off that keeps failing has its tries, then goes
  const once = W.addSchedule({ specialist: spec.id, task: 'post the update', when: 'tomorrow at 9', now: t0 });
  const t1 = once.schedule.nextAt + MIN; // a one-off fires once its time has come
  let o = W.markFired(once.schedule.id, { error: 'x', started: true }, t1);
  check('a failing one-off is kept for another try', !!o && W.listSchedules().some((j) => j.id === once.schedule.id));
  for (let i = 0; i < 3; i++) o = W.markFired(once.schedule.id, { error: 'x', started: true }, t1);
  check('after its tries a failing one-off is dropped', !W.listSchedules().some((j) => j.id === once.schedule.id));
  const moved = W.setNextAt(id, t0 + 90 * MIN, t0);
  check('setNextAt parks a job until a time', moved && moved.nextAt === t0 + 90 * MIN);
}

// ---------- the Rust app's job runner ----------
{
  reset();
  const now = Date.now();
  const sessions = [];
  const events = [];
  const runs = new Map();
  const recorded = [];
  let behaviour = 'ok';
  let started = 0;
  const api = {
    sessions: () => sessions,
    find: (id) => sessions.find((x) => x.id === id) || null,
    meta: (x) => ({ id: x.id, title: x.title }),
    save() {}, saveNow() {},
    newId: (p) => p + Math.random().toString(36).slice(2, 8),
    runs, queues: new Map(), pending: new Map(),
    startRun: async (session, text, opts) => {
      started++;
      check('the scheduled run is unattended and says so in its message', opts && opts.unattended === true && /Nobody may be at the PC/.test(text));
      runs.set(session.id, true);
      await new Promise((r) => setTimeout(r, 30));
      runs.delete(session.id);
      if (behaviour === 'ok') return { ok: true, text: '[mood: happy]\nAll 3 pages load. Nothing to fix.', needsYou: [] };
      if (behaviour === 'approval') return { ok: true, text: 'Drafted the reply.', needsYou: ['Send the email to Sam'] };
      if (behaviour === 'limited') return { ok: false, error: 'limit', limited: true, resetsAt: Date.now() + 45 * MIN };
      return { ok: false, error: 'The AI service is temporarily unavailable (HTTP 503).' };
    },
  };
  let claimOk = true;
  const ctx = {
    need: (n) => (n === 'wisp.js' ? W : null),
    emit: (sid, ev) => events.push({ sid, ...ev }),
    readJson: async () => ({}),
    DEFAULT_CWD: tmp,
    api,
    shared: { sync: { claim: async () => claimOk, renew: async () => {}, recordRun: async (job, r) => { recorded.push({ job: job.id, ...r }); } } },
  };
  const team = await import(pathToFileURL(path.join(root, 'rune-app', 'sidecar', 'ext-team.mjs')).href);
  team.start(ctx);
  const due = () => {
    const l = W.store.loadSchedules();
    for (const j of l) j.nextAt = Date.now() - 1000;
    W.store.saveSchedules(l);
  };
  const add = W.addSchedule({ specialist: spec.id, task: 'check the site', when: 'every day at 9', now });
  const id = add.schedule.id;
  const tick = async () => {
    // the runner's own timer: call route-free tick through a due job and the 30 s interval is too slow, so poke it
    const mod = team;
    if (mod.__tick) await mod.__tick(); else throw new Error('ext-team has no __tick for tests');
  };
  const settle = () => new Promise((r) => setTimeout(r, 120));

  due(); await tick(); await settle();
  let j = W.listSchedules().find((x) => x.id === id);
  check('a finished run counts as a run', j.runs === 1 && !j.lastError, j);
  check('the report the phone sees is the run\'s own reply, without the mood tag', recorded[0] && recorded[0].ok && recorded[0].output === 'All 3 pages load. Nothing to fix.', recorded[0]);
  check('the app hears running, then done', events.some((e) => e.type === 'run_health' && e.state === 'running') && events.some((e) => e.type === 'run_health' && e.state === 'done'));

  behaviour = 'fail'; recorded.length = 0;
  due(); await tick(); await settle();
  j = W.listSchedules().find((x) => x.id === id);
  check('a failed run is retried by itself, not counted', j.failures === 1 && j.runs === 1 && j.nextAt > Date.now(), j);
  check('the account hears it did not finish and will try again', recorded[0] && !recorded[0].ok && /try again/.test(recorded[0].output), recorded[0]);
  check('the app hears retrying with the attempt', events.some((e) => e.type === 'run_health' && e.state === 'retrying' && e.attempt === 1));

  behaviour = 'limited';
  due(); await tick(); await settle();
  j = W.listSchedules().find((x) => x.id === id);
  check('out of model allowance: parked until it resets, not failed', j.nextAt > Date.now() + 40 * MIN && j.failures === 1, { d: (j.nextAt - Date.now()) / MIN, f: j.failures });
  check('the app hears parked with a time', events.some((e) => e.type === 'run_health' && e.state === 'parked' && e.until));

  behaviour = 'approval'; recorded.length = 0;
  due(); await tick(); await settle();
  j = W.listSchedules().find((x) => x.id === id);
  check('a run that skipped an approval reports what waits for your yes', /Send the email to Sam/.test(j.needsYou) && /Waiting for your yes/.test(recorded[0].output), { j: j.needsYou, r: recorded[0] });

  behaviour = 'ok';
  const before = started;
  due(); await Promise.all([tick(), tick(), tick()]); await settle();
  check('a job is never started twice while it runs', started === before + 1, started - before);

  claimOk = false;
  const before2 = started;
  due(); await tick(); await settle();
  check('a job another device claimed is left to it', started === before2);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `${failed} FAILED` : 'All job checks passed.');
process.exit(failed ? 1 : 0);
