// Cloud runs must survive crashes, finish, and tell the person (node scripts/cloud-resilience-test.mjs).
// Prints PASS/FAIL per check and exits non-zero when one fails. No network, no real GitHub, no model:
//   - the runner is the real runCloudRunner with scripted agents, a bare git repo as "GitHub's git"
//     and a small in-memory fake of GitHub's REST API (same idea as codeply-cli/test/handoff.test.mjs)
//   - the watchdog's decisions are the real ones (supabase/functions/handoff-watchdog/logic.ts); the
//     run_leases rules are mirrored in JS (supabase/handoff_v2.sql is checked against a real Postgres
//     too when CRAFT_TEST_PG="-h <dir> -p <port> -U <user> -d <db>" points psql at a scratch database)
//   - the workflow's "start again if the run died" step is run for real with bash and a mock `gh`
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.CODEPLY_SPINE_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'craft-resilience-ledger-')), 'ledger.db');
const cl = await import(pathToFileURL(path.join(ROOT, 'codeply-cli/lib/cloud.mjs')).href);
const ga = await import(pathToFileURL(path.join(ROOT, 'codeply-cli/lib/github-agent.mjs')).href);
const ho = await import(pathToFileURL(path.join(ROOT, 'codeply-cli/lib/handoff.mjs')).href);

let failures = 0; let total = 0;
function check(name, cond, extra = '') {
  total++;
  if (cond) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${extra ? `\n      ${String(extra).slice(0, 700)}` : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-resilience-'));
const ident = ['-c', 'user.name=t', '-c', 'user.email=t@example.com'];
const waitFor = async (fn, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(20); } return false; };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

// ─── A fake GitHub: the REST calls a runner makes, over a bare git repo ──────

function fakeGithub(bare) {
  const files = new Map(); // craft-sessions paths
  const G = { dispatches: [], merges: [], deleted: [], runs: new Map(), checks: [], n: 0 };
  const reply = (status, body) => ({ ok: status < 400, status, text: async () => (body == null ? '' : JSON.stringify(body)), headers: { get: () => null } });
  const fetchImpl = async (url, { method = 'GET', body } = {}) => {
    const u = new URL(url);
    const p = u.pathname;
    const b = body ? JSON.parse(body) : null;
    let m;
    if ((m = /\/contents\/(.+)$/.exec(p))) {
      const key = decodeURIComponent(m[1]);
      if (method === 'GET') {
        const f = files.get(key);
        if (f) return reply(200, { content: f.content, sha: f.sha, size: f.content.length });
        const kids = [...files.keys()].filter((k) => k.startsWith(`${key}/`));
        return kids.length ? reply(200, kids.map((k) => ({ name: k.split('/').pop(), path: k, sha: files.get(k).sha }))) : reply(404, { message: 'Not Found' });
      }
      if (method === 'PUT') { files.set(key, { content: b.content, sha: `s${++G.n}` }); return reply(201, {}); }
      if (method === 'DELETE') { files.delete(key); return reply(200, {}); }
    }
    if (method === 'POST' && /\/actions\/workflows\/craft-cloud\.yml\/dispatches$/.test(p)) { G.dispatches.push(b); return reply(204, null); }
    if ((m = /\/actions\/runs\/(\d+)$/.exec(p))) return G.runs.has(m[1]) ? reply(200, G.runs.get(m[1])) : reply(404, { message: 'Not Found' });
    if ((m = /\/branches\/(.+)$/.exec(p))) {
      try { sh(bare, 'rev-parse', '--verify', '-q', `refs/heads/${decodeURIComponent(m[1])}`); return reply(200, {}); } catch { return reply(404, { message: 'Not Found' }); }
    }
    if (method === 'DELETE' && (m = /\/git\/refs\/heads\/(.+)$/.exec(p))) {
      const ref = decodeURIComponent(m[1]);
      G.deleted.push(ref);
      try { sh(bare, 'update-ref', '-d', `refs/heads/${ref}`); } catch {}
      return reply(204, null);
    }
    if (p.includes('/git/ref/heads/')) return reply(200, { object: { sha: 'x' } });
    if (method === 'POST' && /\/merges$/.test(p)) { G.merges.push(b); return reply(201, { sha: 'merged1' }); }
    if (method === 'POST' && /\/check-runs$/.test(p)) { const c = { id: G.checks.length + 1, ...b }; G.checks.push(c); return reply(201, c); }
    if (/\/check-runs\//.test(p)) return reply(200, {});
    return reply(404, { message: `no fake for ${method} ${p}` });
  };
  const read = (p) => { const f = files.get(p); return f ? JSON.parse(Buffer.from(f.content, 'base64').toString('utf8')) : null; };
  const write = (p, obj) => files.set(p, { content: Buffer.from(JSON.stringify(obj)).toString('base64'), sha: `s${++G.n}` });
  return { ...G, G, fetchImpl, read, write, files };
}

/** A "GitHub" repo with a main branch, and a clone of it the way Actions checks out (shallow). */
function world(name) {
  const root = fs.mkdtempSync(path.join(tmp, `${name}-`));
  const bare = path.join(root, 'remote.git'); const seed = path.join(root, 'seed');
  fs.mkdirSync(bare); sh(root, 'init', '-q', '--bare', '-b', 'main', bare);
  sh(root, 'clone', '-q', bare, seed);
  fs.writeFileSync(path.join(seed, 'README.md'), '# project\n');
  sh(seed, 'add', '-A'); sh(seed, ...ident, 'commit', '-q', '-m', 'first'); sh(seed, 'push', '-q', 'origin', 'HEAD:main');
  const baseSha = sh(bare, 'rev-parse', 'main');
  let n = 0;
  const checkout = (branch = 'main') => {
    const dir = path.join(root, `runner${++n}`);
    sh(root, '-c', 'core.autocrlf=false', 'clone', '-q', '--depth', '1', '--branch', branch, '--single-branch', pathToFileURL(bare).href, dir);
    return dir;
  };
  const branchHas = (branch) => { try { return sh(bare, 'ls-tree', '-r', '--name-only', branch).split('\n'); } catch { return null; } };
  const show = (rev, file) => sh(bare, 'show', `${rev}:${file}`);
  return { root, bare, baseSha, checkout, branchHas, show };
}

const noticeLog = [];
const runner = (w, gh, o) => cl.runCloudRunner({
  env: { GITHUB_REPOSITORY: 'me/proj', GITHUB_SHA: w.baseSha, CRAFT_TASK_ID: o.id || 't1', CRAFT_SESSION_ID: '', CRAFT_PROMPT: o.prompt || 'Build a thing', CRAFT_MODE: o.mode || 'Build', CRAFT_BASE: 'main', GITHUB_RUN_ID: '4242', ...(o.env || {}) },
  cwd: o.dir, token: 'test-token', route: { auto: true }, fetchImpl: gh.fetchImpl, runAgentImpl: o.agent, browserImpl: null, idleMs: 0, updateMs: 0, touchMs: 60000, wipEveryMs: o.wipEveryMs || 60000,
  notifyImpl: o.notifyImpl || (async (n) => { noticeLog.push(n); return true; }), ...(o.extra || {}),
});
const writeStep = (cwd, file, text) => { fs.writeFileSync(path.join(cwd, file), text); return { type: 'tool_end', name: 'write_file', args: { path: file }, summary: file, ok: true }; };

// ═══ 1. A crash mid-run keeps the work, the run starts again from it and finishes ═══
{
  const gitCfgBefore = JSON.stringify(Object.entries(process.env).filter(([k]) => /^GIT_CONFIG/.test(k)));
  const w = world('crash'); const gh = fakeGithub(w.bare);
  const dir1 = w.checkout();
  const gate = deferred();
  const crashing = async function* ({ cwd }) {
    yield { type: 'text', text: 'Starting with a.txt', interim: true };
    yield writeStep(cwd, 'a.txt', 'first part\n');
    await gate.promise; // the WIP timer saves the work while the agent is busy
    throw new Error('the machine fell over');
  };
  const p1 = runner(w, gh, { dir: dir1, agent: crashing, wipEveryMs: 80 });
  const saved = await waitFor(() => (w.branchHas('craft/wip-task-t1') || []).includes('a.txt'));
  const state = saved ? JSON.parse(w.show('craft/wip-task-t1', '.craft-handoff.json')) : null;
  check('a run that is not a handoff saves its work to craft/wip-task-<id> about every minute (while it is still running)', saved && (w.branchHas('craft/wip-task-t1') || []).includes('.craft-handoff.json') && state && state.steps[0] === 'wrote a.txt', JSON.stringify(state));
  check('the save does not touch the checkout\'s HEAD or index', sh(dir1, 'rev-parse', 'HEAD') === w.baseSha && sh(dir1, 'diff', '--cached', '--name-only') === '' && /a\.txt/.test(sh(dir1, 'status', '--porcelain')));
  gate.resolve();
  const out1 = await p1;
  const d = gh.dispatches[0];
  check('a crash (a thrown failure) starts the workflow again with a resume flag, from the WIP branch', out1.status === 'retrying' && gh.dispatches.length === 1 && d.inputs.attempt === '2' && d.inputs.wip === 'craft/wip-task-t1' && d.inputs.task_id === 't1' && d.inputs.prompt === 'Build a thing' && d.ref === 'main', JSON.stringify(d));
  const doc1 = gh.read('tasks/t1.json');
  check('the task file says "retrying (attempt 2)" instead of failed', doc1.status === 'retrying' && doc1.attempt === 2 && doc1.retry.attempt === 2 && doc1.retry.of === 3 && /fell over/.test(doc1.retry.reason) && !doc1.notify, JSON.stringify(doc1).slice(0, 400));
  check('no notification for a run that is starting again', noticeLog.length === 0);

  // What a polling client sees.
  const home = path.join(w.root, 'home'); fs.mkdirSync(home);
  const projDir = path.join(w.root, 'client'); fs.mkdirSync(projDir);
  cl.rememberTask(projDir, { id: 't1', repo: 'me/proj', prompt: 'Build a thing', mode: 'Build', sessionId: '', status: 'running', attempt: 1, startedAt: Date.now() }, home);
  const sent = [];
  const view = await cl.cloudRunStatus({ cwd: projDir, taskId: 't1', token: 'x', home, apiUrl: 'https://api.test', fetchImpl: gh.fetchImpl, notifyImpl: async (n) => { sent.push(n); return true; } });
  check('a polling client shows "Retrying (attempt 2)", not failed', view.status === 'running' && view.progress === 'Retrying (attempt 2)' && view.retry.attempt === 2 && view.attempt === 2, JSON.stringify({ s: view.status, p: view.progress }));

  // The new run: Actions checks out the WIP branch and passes the resume flag.
  const dir2 = w.checkout('craft/wip-task-t1');
  let seen = null;
  const finishing = async function* (args) {
    seen = args;
    yield writeStep(args.cwd, 'b.txt', 'second part\n');
    yield { type: 'text', text: 'Both parts are in.', interim: false };
    yield { type: 'done', actions: [] };
  };
  const out2 = await runner(w, gh, { dir: dir2, agent: finishing, env: { CRAFT_ATTEMPT: '2', CRAFT_WIP: 'craft/wip-task-t1' } });
  check('the restarted run gets a continuation prompt with the steps already done, and never sees the state file', out2.status === 'done' && /\[Resume\]/.test(seen.userMessage) && /1\. wrote a\.txt/.test(seen.userMessage) && /^Build a thing/.test(seen.userMessage) && !fs.existsSync(path.join(dir2, ho.STATE_FILE)), seen && seen.userMessage);
  check('the agent is asked to work in the background (long model retries)', seen.background === true);
  const doc2 = gh.read('tasks/t1.json');
  check('it finishes: the task file is done at attempt 2 with the work of both runs and the earlier steps kept', doc2.status === 'done' && doc2.attempt === 2 && doc2.files.slice().sort().join() === 'a.txt,b.txt' && doc2.events.filter((e) => e.t === 'tool').length >= 1 && doc2.events.some((e) => e.t === 'notice' && /started again \(attempt 2 of 3\)/.test(e.text)), JSON.stringify(doc2).slice(0, 500));
  const branch = doc2.branch;
  check('the result is one clean commit on the base, with both files and no state file', !!branch && (w.branchHas(branch) || []).includes('a.txt') && (w.branchHas(branch) || []).includes('b.txt') && !(w.branchHas(branch) || []).includes(ho.STATE_FILE) && sh(w.bare, 'rev-list', '--count', `main..${branch}`) === '1', branch);
  check('it is merged into the base branch and the WIP branch is removed', gh.merges.length === 1 && gh.deleted.includes('craft/wip-task-t1') && w.branchHas('craft/wip-task-t1') === null);
  const view2 = await cl.cloudRunStatus({ cwd: projDir, taskId: 't1', token: 'x', home, apiUrl: 'https://api.test', fetchImpl: gh.fetchImpl, notifyImpl: async (n) => { sent.push(n); return true; } });
  check('the client now sees done, with no "retrying" left', view2.status === 'done' && view2.retry === null && view2.result.files.includes('b.txt'));
  check('the git login given to the agent is gone after the run, and the machine\'s own git settings are as they were', JSON.stringify(Object.entries(process.env).filter(([k]) => /^GIT_CONFIG/.test(k))) === gitCfgBefore);
  check('the runner told the person it is done (a push, with the notice kept in the task file)', noticeLog.length === 1 && noticeLog[0].kind === 'done' && /Both parts/.test(noticeLog[0].body) && doc2.notify.kind === 'done' && doc2.notify.pushed === true && doc2.notify.title === 'Your cloud task is done', JSON.stringify(doc2.notify));
  check('so the PC does not send it a second time', sent.length === 0);
}

// ═══ 2. Retries are capped at 2; keys and sign-ins are not retried ═══
{
  const w = world('cap'); const gh = fakeGithub(w.bare);
  const boom = async function* () { yield { type: 'text', text: 'trying', interim: true }; throw new Error('upstream exploded'); };
  noticeLog.length = 0;
  const outs = [];
  for (const attempt of [1, 2, 3]) outs.push(await runner(w, gh, { dir: w.checkout(), agent: boom, id: 'cap1', env: { CRAFT_ATTEMPT: String(attempt) } }));
  check('retries are capped at 2: tries 1 and 2 start again, try 3 gives up', outs.map((o) => o.status).join() === 'retrying,retrying,failed' && gh.dispatches.length === 2 && gh.dispatches.map((x) => x.inputs.attempt).join() === '2,3', outs.map((o) => o.status).join());
  const doc = gh.read('tasks/cap1.json');
  check('the final failure is in plain words, says how many tries, and notifies once', doc.status === 'failed' && /upstream exploded/.test(doc.error) && /tried 3 times/i.test(doc.error) && doc.notify.kind === 'failed' && noticeLog.length === 1 && noticeLog[0].kind === 'failed' && doc.attempt === 3, JSON.stringify(doc).slice(0, 400));

  const gh2 = fakeGithub(w.bare);
  const keyFail = async function* () { throw new Error('401 invalid api key'); };
  const o = await runner(w, gh2, { dir: w.checkout(), agent: keyFail, id: 'key1' });
  check('a bad key is not retried (it cannot get better), it fails at once', o.status === 'failed' && gh2.dispatches.length === 0 && gh2.read('tasks/key1.json').status === 'failed');

  // When even the dispatch is refused, the failure is final, not silent.
  const gh3 = fakeGithub(w.bare);
  const refuse = async (url, init) => (/dispatches$/.test(new URL(url).pathname) ? { ok: false, status: 403, text: async () => '{"message":"Resource not accessible by integration"}', headers: { get: () => null } } : gh3.fetchImpl(url, init));
  const o3 = await cl.runCloudRunner({ env: { GITHUB_REPOSITORY: 'me/proj', GITHUB_SHA: w.baseSha, CRAFT_TASK_ID: 'ref1', CRAFT_SESSION_ID: '', CRAFT_PROMPT: 'x', CRAFT_MODE: 'Build', CRAFT_BASE: 'main' }, cwd: w.checkout(), token: 't', route: { auto: true }, fetchImpl: refuse, runAgentImpl: boom, browserImpl: null, idleMs: 0, updateMs: 0, notifyImpl: async () => true });
  check('if starting again is refused, the task fails for good instead of staying "running"', o3.status === 'failed' && gh3.read('tasks/ref1.json').status === 'failed');
}

// ═══ 2b. A handoff run (carried on from the PC) that fails is started again too, and tells the PC only when it gives up ═══
{
  const w = world('hand'); const gh = fakeGithub(w.bare);
  const proj = path.join(w.root, 'pcproj'); const home = path.join(w.root, 'pchome'); fs.mkdirSync(proj); fs.mkdirSync(home);
  fs.writeFileSync(path.join(proj, 'step1.txt'), 'from the PC\n');
  const st = ho.newRunState({ sessionId: 'chatH', mode: 'Build', userMessage: 'Build the H thing', history: [] });
  ho.recordEvent(st, { type: 'tool_end', name: 'write_file', args: { path: 'step1.txt' }, summary: 'step1.txt', ok: true });
  await ho.pushWip({ cwd: proj, home, repo: 'me/proj', sessionId: 'chatH', state: st, force: true, remoteUrl: w.bare });
  const boom = async function* () { throw new Error('the model fell over'); };
  const env = { CRAFT_HANDOFF: 'resume', CRAFT_SESSION_ID: 'chatH', CRAFT_LEASE: 'tok' };
  const a1 = await runner(w, gh, { dir: w.checkout('craft/wip-chatH'), agent: boom, id: 'tH', env: { ...env, CRAFT_ATTEMPT: '1' }, extra: { leaseImpl: null } });
  const inputs = gh.dispatches[0] && gh.dispatches[0].inputs;
  check('handoff run, try 1 fails: started again as a resume run, keeping the lease token, with no "failed" told to the PC', a1.status === 'retrying' && inputs.handoff === 'resume' && inputs.attempt === '2' && inputs.lease === 'tok' && inputs.session_id === 'chatH' && inputs.prompt === 'Build the H thing' && gh.read('handback/chatH/done.json') === null, JSON.stringify(inputs));
  check('its work so far is on craft/wip-<chat>, ready for the new run', (w.branchHas('craft/wip-chatH') || []).includes('step1.txt'));
  await runner(w, gh, { dir: w.checkout('craft/wip-chatH'), agent: boom, id: 'tH', env: { ...env, CRAFT_ATTEMPT: '2' }, extra: { leaseImpl: null } });
  const a3 = await runner(w, gh, { dir: w.checkout('craft/wip-chatH'), agent: boom, id: 'tH', env: { ...env, CRAFT_ATTEMPT: '3' }, extra: { leaseImpl: null } });
  check('after the last try the PC is told it failed (done.json) so it carries on from the saved work', a3.status === 'failed' && gh.dispatches.length === 2 && gh.read('handback/chatH/done.json').status === 'failed' && gh.read('tasks/tH.json').status === 'failed');
}

// ═══ 3. Running out of time (the budget guard) ═══
{
  const w = world('budget'); const gh = fakeGithub(w.bare);
  const slow = async function* ({ cwd, signal }) {
    yield writeStep(cwd, 'slow.txt', 'some progress\n');
    for (;;) { if (signal.aborted) { yield { type: 'aborted' }; return; } await sleep(15); }
  };
  const out = await runner(w, gh, { dir: w.checkout(), agent: slow, id: 'slow1', extra: { deadlineAt: Date.now() + 300 } });
  const d = gh.dispatches[0];
  check('the agent is stopped before the hard limit and the task starts again from its save', out.status === 'retrying' && d && d.inputs.wip === 'craft/wip-task-slow1' && (w.branchHas('craft/wip-task-slow1') || []).includes('slow.txt') && /used up its time/.test(gh.read('tasks/slow1.json').retry.reason), JSON.stringify(gh.read('tasks/slow1.json')).slice(0, 300));
}

// ═══ 4. "Needs you", unattended skips, health and parked events ═══
{
  const w = world('needs'); const gh = fakeGithub(w.bare);
  noticeLog.length = 0;
  let seen = null; let verdict = null; let login = null;
  const risky = async function* (args) {
    seen = args;
    // The login the agent's own `git push` uses: answers for GitHub only, and the token is not in the environment.
    const helper = Object.entries(process.env).find(([k, v]) => /^GIT_CONFIG_VALUE_/.test(k) && /^!sh /.test(v));
    if (helper) {
      const ask = (host) => spawnSync('sh', [helper[1].slice(4), 'get'], { input: `protocol=https\nhost=${host}\n`, encoding: 'utf8' }).stdout;
      login = { github: ask('github.com'), other: ask('evil.example'), leaked: Object.values(process.env).some((v) => String(v).includes('test-token')) };
    }
    verdict = await args.approve({ tool: 'vercel_deploy', title: 'Deploy my-site to Vercel', detail: 'production', danger: true });
    yield writeStep(args.cwd, 'ready.txt', 'prepared, not deployed\n');
    yield { type: 'text', text: 'Prepared the change; the deploy still needs your OK.', interim: false };
    yield { type: 'done', actions: [] };
  };
  const out = await runner(w, gh, { dir: w.checkout(), agent: risky, id: 'need1' });
  const doc = gh.read('tasks/need1.json');
  check('a skipped dangerous action is recorded as "needs you" in the task file', out.status === 'done' && verdict === 'reject' && doc.needsYou.length === 1 && doc.needsYou[0].title === 'Deploy my-site to Vercel' && doc.needsYou[0].why === 'not_allowed', JSON.stringify(doc.needsYou));
  check('the model is told up front to take a safe alternative and keep going', /safe alternative and keep going/.test(seen.userMessage) && /what still needs the user's OK/.test(seen.userMessage));
  check('the notification says it needs you', doc.notify.kind === 'needs_you' && /Deploy my-site/.test(doc.notify.body) && noticeLog[0].kind === 'needs_you', JSON.stringify(doc.notify));
  check('git login for the agent\'s own push: answers for github.com only, token not in the environment', login && /password=test-token/.test(login.github) && login.other === '' && login.leaked === false, JSON.stringify(login));
  check('the agent is told which branch it may push to, and only that one', new RegExp(`git push origin HEAD:${doc.branch}`).test(seen.userMessage) && /every other push is blocked/.test(seen.userMessage));

  // The model struggling, then the agent parking the run.
  const w2 = world('parked'); const gh2 = fakeGithub(w2.bare);
  const parking = async function* ({ cwd }) {
    yield writeStep(cwd, 'p.txt', 'p\n');
    yield { type: 'health', state: 'degraded', attempt: 3, until: Date.now() + 600000, reason: 'the model is overloaded' };
    yield { type: 'parked', until: Date.now() + 600000, ledger: { turns: 7, note: 'half done' } };
  };
  const o2 = await runner(w2, gh2, { dir: w2.checkout(), agent: parking, id: 'park1' });
  const pd = gh2.read('tasks/park1.json');
  check('a parked agent run starts again from its save, with the agent\'s ledger kept', o2.status === 'retrying' && pd.parked && /overloaded|not available/i.test(pd.retry.reason + pd.parked.reason) && JSON.parse(w2.show('craft/wip-task-park1', ho.STATE_FILE)).ledger.turns === 7, JSON.stringify(pd).slice(0, 300));
  let resumed = null;
  const again = async function* (args) { resumed = args; yield { type: 'text', text: 'done', interim: false }; yield { type: 'done', actions: [] }; };
  await runner(w2, gh2, { dir: w2.checkout('craft/wip-task-park1'), agent: again, id: 'park1', env: { CRAFT_ATTEMPT: '2', CRAFT_WIP: 'craft/wip-task-park1' } });
  check('the restarted run hands the ledger back to the agent (resume)', resumed && resumed.resume && resumed.resume.turns === 7);
  // A health event on a run that goes on to finish shows while it lasts, and is gone after.
  const w3 = world('health'); const gh3 = fakeGithub(w3.bare);
  let during = null;
  const flaky = async function* () {
    yield { type: 'health', state: 'degraded', attempt: 1, reason: 'slow answers' };
    during = gh3.read('tasks/h1.json') && gh3.read('tasks/h1.json').health;
    yield { type: 'health', state: 'ok' };
    yield { type: 'text', text: 'ok', interim: false }; yield { type: 'done', actions: [] };
  };
  await runner(w3, gh3, { dir: w3.checkout(), agent: flaky, id: 'h1' });
  check('a struggling model shows in the task file while it lasts, and clears', during && during.state === 'degraded' && !gh3.read('tasks/h1.json').health);
}

// ═══ 5. The agent may push to its own branch only ═══
{
  const own = ['craft/add-greeting-abc123', 'craft/wip-task-t1'];
  const v = (c) => ga.pushVerdict(c, own);
  check('push: to the run\'s own branch is allowed', v('git push origin HEAD:craft/add-greeting-abc123') === 'ok' && v('git push -u origin craft/wip-task-t1') === 'ok' && v('git add -A && git commit -m x && git push origin HEAD:refs/heads/craft/add-greeting-abc123') === 'ok');
  check('push: never the default branch, never forced, never a deletion', ['git push origin main', 'git push origin HEAD:main', 'git push --force origin HEAD:craft/add-greeting-abc123', 'git push -f origin HEAD:craft/add-greeting-abc123', 'git push origin +HEAD:craft/add-greeting-abc123', 'git push --force-with-lease origin HEAD:craft/add-greeting-abc123', 'git push origin :craft/add-greeting-abc123', 'git push --delete origin craft/add-greeting-abc123', 'git push origin HEAD:craft/someone-elses-branch'].every((c) => v(c) === 'bad'), ['git push origin main', 'git push origin HEAD:main'].map(v).join());
  check('push: not "everything", not a bare push, not another remote, not hidden in another command', ['git push', 'git push origin', 'git push --all origin', 'git push --mirror origin', 'git push --tags origin', 'git push evil HEAD:craft/add-greeting-abc123', 'git push origin HEAD', 'bash -c "git push origin HEAD:main"', 'echo x | git push origin HEAD:craft/add-greeting-abc123', 'git -C . push origin HEAD:craft/add-greeting-abc123', 'git push origin HEAD:craft/add-greeting-abc123 && git push origin main'].every((c) => v(c) === 'bad'));
  check('push: gh stays blocked, ordinary commands are untouched', v('gh pr create') === 'bad' && v('gh api repos/x/y') === 'bad' && v('npm test') === 'none' && v('git commit -am x') === 'none' && v('echo "pushing soon"') === 'none');
  const approve = ga.ciApprove(ROOT, { pushBranches: own });
  const approveNone = ga.ciApprove(ROOT);
  check('ciApprove: pushing to the run\'s own branch is approved, everything else stays rejected as before',
    (await approve({ tool: 'run', title: 'Run command', detail: 'git push origin HEAD:craft/add-greeting-abc123' })) === 'once'
    && (await approve({ tool: 'run', title: 'Run command', detail: 'git push origin HEAD:main' })) === 'reject'
    && (await approveNone({ tool: 'run', title: 'Run command', detail: 'git push origin HEAD:craft/add-greeting-abc123' })) === 'reject'
    && (await approve({ tool: 'run', title: 'Run command', detail: 'gh pr create' })) === 'reject'
    && (await approve({ tool: 'run', title: 'Run command', detail: 'ls' })) === 'once'
    && (await approve({ tool: 'vercel_deploy', title: 'Deploy', danger: true })) === 'reject'
    && (await ga.ciApprove(ROOT, { canAsk: true })({ tool: 'vercel_deploy', title: 'Deploy', danger: true })) === 'ask'
    && (await ga.ciApprove(ROOT, { permission: 'full' })({ tool: 'vercel_deploy', title: 'Deploy', danger: true })) === 'once');
}

// ═══ 6. The lease: the cloud runner renews it, a dead runner's lease is reclaimed ═══
// A JS mirror of supabase/handoff_v2.sql (handoff_claim_v2, handoff_cloud_beat, handoff_dispatch_failed).
function leaseTable(clock = () => Date.now()) {
  const rows = new Map();
  const t = {
    rows,
    addPc(over = {}) { const r = { session_id: 's1', holder: 'pc', epoch: 1, state: 'running', beat_at: clock(), repo: 'me/proj', base: 'main', mode: 'Build', prompt: 'Build X', wip_sha: 'abc123', cloud_task_id: null, cloud_from_sha: null, attempt: 0, dispatch_attempts: 0, next_try_at: null, notice: null, note: null, ...over }; rows.set(r.session_id, r); return r; },
    claim({ stale = 60, cloudStale = 180, maxReclaims = 2 } = {}) {
      const now = clock(); const out = [];
      for (const r of rows.values()) {
        if (r.holder === 'cloud' && r.state === 'running' && r.attempt >= maxReclaims && r.beat_at < now - cloudStale * 1000) Object.assign(r, { state: 'cloud_failed', notice: `The cloud run stopped responding${r.attempt ? ` and was restarted ${r.attempt} time${r.attempt === 1 ? '' : 's'}` : ''}, but it did not finish.` });
      }
      for (const r of rows.values()) {
        const pcStale = r.holder === 'pc' && r.state === 'running' && r.beat_at < now - stale * 1000;
        const cloudDead = r.holder === 'cloud' && r.state === 'running' && r.attempt < maxReclaims && r.beat_at < now - cloudStale * 1000;
        const retryDue = r.holder === 'cloud' && r.state === 'dispatch_retry' && r.next_try_at <= now;
        if (!(pcStale || cloudDead || retryDue)) continue;
        const wasPc = r.holder === 'pc';
        Object.assign(r, {
          holder: 'cloud', epoch: r.epoch + (retryDue ? 0 : 1), state: 'running', beat_at: now, next_try_at: null,
          cloud_from_sha: wasPc ? r.wip_sha : r.cloud_from_sha, cloud_task_id: wasPc ? `task${now.toString(36)}` : r.cloud_task_id,
          attempt: r.attempt + (cloudDead ? 1 : 0), dispatch_attempts: retryDue ? r.dispatch_attempts : 0, note: null,
        });
        out.push({ ...r });
      }
      return out;
    },
    cloudBeat(sid, task, epoch, finish = false) {
      const r = rows.get(sid);
      if (!r || r.holder !== 'cloud' || r.cloud_task_id !== task || r.epoch !== epoch || r.state !== 'running') return 'lost';
      r.beat_at = clock(); if (finish) r.state = 'cloud_done';
      return finish ? 'finished' : 'running';
    },
    dispatchFailed(sid, epoch, plan) {
      const r = rows.get(sid);
      if (!r || r.epoch !== epoch || r.holder !== 'cloud') return;
      r.dispatch_attempts++; r.note = plan.note;
      if (plan.delaySeconds == null) Object.assign(r, { state: plan.state, next_try_at: null, notice: plan.note });
      else Object.assign(r, { state: 'dispatch_retry', next_try_at: clock() + plan.delaySeconds * 1000 });
    },
  };
  return t;
}
let logic = null;
try { logic = await import(pathToFileURL(path.join(ROOT, 'supabase/functions/handoff-watchdog/logic.ts')).href); } catch (e) { console.log(`SKIP  watchdog logic tests (this Node cannot load TypeScript: ${e.message.split('\n')[0]})`); }

{
  // The runner renews its lease while it works, and finishes it at the end.
  const w = world('lease'); const gh = fakeGithub(w.bare);
  const table = leaseTable();
  const row = table.addPc({ beat_at: 0 }); table.claim(); // the PC went quiet: claimed, holder cloud, epoch 2
  const task = row.cloud_task_id; const epoch = row.epoch;
  let beats = 0;
  const lease = { beat: async (finish) => { beats++; return table.cloudBeat('s1', task, epoch, finish); } };
  const longRun = async function* ({ cwd }) {
    for (let i = 0; i < 12; i++) { await sleep(40); if (i === 3) yield writeStep(cwd, 'x.txt', 'x\n'); }
    yield { type: 'text', text: 'finished', interim: false }; yield { type: 'done', actions: [] };
  };
  const checks = [];
  const watcher = setInterval(() => { checks.push(table.claim({ cloudStale: 0.2 }).length); }, 50); // a watchdog that considers 200 ms of silence dead
  const out = await runner(w, gh, { dir: w.checkout(), agent: longRun, id: task, env: { CRAFT_SESSION_ID: 's1' }, extra: { leaseImpl: lease, beatMs: 30 } });
  clearInterval(watcher);
  check('the cloud runner renews its lease (so a live run is never reclaimed, even over 450 ms with a 200 ms stale limit)', out.status === 'done' && beats > 8 && checks.every((n) => n === 0) && row.attempt === 0, `beats ${beats} claims ${checks.join()}`);
  check('and finishes it when the work is on the branch (cloud_done: the PC picks it up, nobody re-dispatches)', row.state === 'cloud_done' && table.claim({ cloudStale: 0 }).length === 0);

  // A run that is no longer the owner stops at once and leaves its results alone.
  const table2 = leaseTable(); const r2 = table2.addPc({ session_id: 's2', beat_at: 0 }); table2.claim();
  const gh2 = fakeGithub(w.bare);
  let wroteAfter = false; let ranAgent = false;
  const lease2 = { beat: async (finish) => table2.cloudBeat('s2', r2.cloud_task_id, 2, finish) };
  const dir2 = w.checkout();
  const hang = async function* ({ cwd, signal }) {
    ranAgent = true;
    yield writeStep(cwd, 'dead.txt', 'work of a replaced runner\n');
    for (;;) { if (signal.aborted) { yield { type: 'aborted' }; return; } await sleep(15); }
  };
  const p = runner(w, gh2, { dir: dir2, agent: hang, id: r2.cloud_task_id, env: { CRAFT_SESSION_ID: 's2' }, extra: { leaseImpl: lease2, beatMs: 30 } });
  await waitFor(() => ranAgent); await sleep(60);
  r2.beat_at = 0; const re = table2.claim({ cloudStale: 1 }); // the watchdog decides it is dead and dispatches a replacement (epoch 3)
  const out2 = await p;
  wroteAfter = gh2.read(`tasks/${r2.cloud_task_id}.json`) && gh2.read(`tasks/${r2.cloud_task_id}.json`).status === 'done';
  check('a runner whose lease was reclaimed stops (its token is fenced out by the new epoch) and publishes no result', re.length === 1 && re[0].epoch === 3 && re[0].attempt === 1 && re[0].cloud_task_id === r2.cloud_task_id && out2.status === 'stopped' && !wroteAfter && gh2.dispatches.length === 0);
  const out3 = await runner(w, fakeGithub(w.bare), { dir: w.checkout(), agent: hang, id: 'late1', env: { CRAFT_SESSION_ID: 's2' }, extra: { leaseImpl: { beat: async () => 'lost' } } });
  check('a queued runner that finds its lease already replaced does not start', out3.status === 'stopped' && !out3.results.length);

  // A dead cloud runner: reclaimed twice, then the lease fails with a notice in plain words.
  const t = { now: 1000000 }; const table3 = leaseTable(() => t.now);
  const r3 = table3.addPc({ session_id: 's3', beat_at: t.now });
  t.now += 70000; const c1 = table3.claim();
  check('a stale PC lease is taken by the cloud (new task id)', c1.length === 1 && c1[0].holder === 'cloud' && c1[0].epoch === 2 && !!c1[0].cloud_task_id);
  t.now += 100000; check('a cloud lease is not reclaimed while it is fresh enough (100 s of 180)', table3.claim().length === 0);
  t.now += 100000; const c2 = table3.claim();
  check('a dead cloud runner (no renewal for 3 minutes) is replaced: same task, new epoch, attempt 1', c2.length === 1 && c2[0].epoch === 3 && c2[0].attempt === 1 && c2[0].cloud_task_id === c1[0].cloud_task_id);
  t.now += 200000; const c3 = table3.claim();
  t.now += 200000; const c4 = table3.claim();
  check('replaced at most twice; then the lease fails with a notice and nothing more is dispatched', c3.length === 1 && c3[0].attempt === 2 && c4.length === 0 && r3.state === 'cloud_failed' && /restarted 2 times/.test(r3.notice) && table3.claim().length === 0, JSON.stringify(r3));
}

// ═══ 7. The watchdog: dispatch retries with backoff, final failure in plain words, no WIP yet ═══
if (logic) {
  check('backoff: 30 s, 1 min, 2 min, 4 min, then give up', [1, 2, 3, 4, 5].map((n) => logic.backoffSeconds(n)).join() === '30,60,120,240,' && logic.backoffSeconds(1) === 30 && logic.backoffSeconds(5) === null);
  const token = await logic.leaseToken('secret', 's1', 'task1', 2);
  check('the runner\'s lease token is bound to the task and epoch (an older runner\'s token stops working)', logic.sameToken(token, await logic.leaseToken('secret', 's1', 'task1', 2)) && !logic.sameToken(token, await logic.leaseToken('secret', 's1', 'task1', 3)) && !logic.sameToken(token, await logic.leaseToken('other', 's1', 'task1', 2)) && /^[0-9a-f]{64}$/.test(token));

  // index.ts's loop, with the same pieces: claim, dispatch, record the outcome.
  const watchdog = async (table, github, branches = {}) => {
    const results = [];
    for (const row of table.claim()) {
      const wipExists = row.wip_sha ? true : !!branches[`craft/wip-${row.session_id}`];
      const taskWipExists = wipExists ? false : !!branches[logic.taskWipBranch(row.cloud_task_id)];
      if (!github.creds) { table.dispatchFailed(row.session_id, row.epoch, logic.planDispatchFailure(row, { kind: 'no_credentials' })); results.push('no creds'); continue; }
      if (logic.nothingToResume(row, { wipExists, taskWipExists })) { table.dispatchFailed(row.session_id, row.epoch, { state: 'cloud_failed', delaySeconds: null, note: 'nothing to resume' }); results.push('nothing'); continue; }
      const inputs = logic.dispatchInputs(row, { wipExists, taskWipExists, lease: 'tok' });
      const status = github.dispatch(inputs);
      if (status === 204) { results.push(inputs); continue; }
      table.dispatchFailed(row.session_id, row.epoch, logic.planDispatchFailure(row, { kind: 'http', status }));
      results.push(status);
    }
    return results;
  };
  const clock = { now: 5000000 }; const table = leaseTable(() => clock.now);
  const row = table.addPc({ beat_at: clock.now }); clock.now += 61000;
  const calls = []; const statuses = [502, 502, 204];
  const github = { creds: true, dispatch: (i) => { calls.push(i); return statuses.shift(); } };
  const adv = async (s) => { clock.now += s * 1000; return watchdog(table, github); };
  const r1 = await watchdog(table, github);
  check('dispatch failure 1: not given up, retried in 30 s, with a plain note', r1[0] === 502 && row.state === 'dispatch_retry' && row.dispatch_attempts === 1 && row.next_try_at - clock.now === 30000 && /GitHub is having trouble right now\. Trying again in 30 seconds \(try 1 of 5\)/.test(row.note), row.note);
  check('nothing happens before the backoff has passed', (await adv(10)).length === 0 && calls.length === 1);
  const r2 = await adv(21);
  check('dispatch failure 2: tried again, now waits a minute', r2[0] === 502 && row.dispatch_attempts === 2 && row.next_try_at - clock.now === 60000 && /Trying again in a minute/.test(row.note));
  const r3 = await adv(61);
  check('try 3 succeeds: the run is dispatched once with the lease token, attempt 1 and the WIP resume flag; the lease is running again', typeof r3[0] === 'object' && r3[0].handoff === 'resume' && r3[0].attempt === '1' && r3[0].lease === 'tok' && r3[0].task_id === row.cloud_task_id && row.state === 'running' && row.epoch === 2 && calls.length === 3, JSON.stringify(r3));

  const always = { creds: true, dispatch: () => 500 };
  const clock2 = { now: 9000000 }; const table2 = leaseTable(() => clock2.now); const row2 = table2.addPc({ beat_at: clock2.now });
  clock2.now += 61000; const seenDelays = [];
  for (let i = 0; i < 8; i++) { await watchdog(table2, always); if (row2.state !== 'dispatch_retry') break; seenDelays.push(row2.next_try_at - clock2.now); clock2.now = row2.next_try_at + 1; }
  check('a refusal that never ends: 5 tries with growing waits, then a final failure the person can read', seenDelays.join() === '30000,60000,120000,240000' && row2.state === 'cloud_failed' && row2.dispatch_attempts === 5 && /GitHub is having trouble right now\. Codeply tried 5 times and gave up, so the task carries on on your PC/.test(row2.notice) && !/\d{3}\b/.test(row2.notice.split('.')[0]), row2.notice);
  const clock3 = { now: 1 }; const table3 = leaseTable(() => clock3.now); const row3 = table3.addPc({ beat_at: 0 }); clock3.now = 70000;
  for (let i = 0; i < 8 && (i === 0 || row3.state === 'dispatch_retry'); i++) { await watchdog(table3, { creds: false, dispatch: () => 204 }); clock3.now = (row3.next_try_at || clock3.now) + 1; }
  check('no GitHub access: retried too (it may get connected), then "no_credentials" in plain words', row3.state === 'no_credentials' && /Connect GitHub in Codeply or install the Codeply GitHub app/.test(row3.notice) && row3.dispatch_attempts === 5, row3.notice);

  // No WIP commit yet (the PC died before its first save)
  const t4 = { now: 70000 }; const table4 = leaseTable(() => t4.now);
  const row4 = table4.addPc({ session_id: 's4', beat_at: 0, wip_sha: null, prompt: 'Add a dark mode' });
  const inputs4 = await watchdog(table4, { creds: true, dispatch: () => 204 });
  check('wip_sha null: the cloud starts from the base branch with the run\'s own prompt (no resume flag)', inputs4[0].handoff === '' && inputs4[0].prompt === 'Add a dark mode' && !('wip' in inputs4[0]) && inputs4[0].mode === 'Build', JSON.stringify(inputs4));
  const row5 = table4.addPc({ session_id: 's5', beat_at: 0, wip_sha: null, prompt: 'Fix the footer' }); t4.now += 1;
  const i5 = await watchdog(table4, { creds: true, dispatch: () => 204 }, {});
  const dead5 = row5.cloud_task_id; row5.beat_at = 0; t4.now += 400000;
  const i5b = await watchdog(table4, { creds: true, dispatch: () => 204 }, { [logic.taskWipBranch(dead5)]: true });
  check('a dead runner that left craft/wip-task-<id> is replaced by one that resumes from it', i5[0].handoff === '' && i5b.length >= 1 && i5b.some((x) => x.wip === logic.taskWipBranch(dead5) && x.attempt === '2'), JSON.stringify(i5b));
  const row6 = table4.addPc({ session_id: 's6', beat_at: 0, wip_sha: null, prompt: null }); t4.now += 1;
  const r6 = await watchdog(table4, { creds: true, dispatch: () => 204 });
  check('nothing saved and no known prompt: a final failure at once instead of an empty run', r6.includes('nothing') && row6.state === 'cloud_failed');
}

// ═══ 8. The notification, and clients that poll ═══
{
  const w = world('notify'); const gh = fakeGithub(w.bare);
  const ok = async function* ({ cwd }) { yield writeStep(cwd, 'n.txt', 'n\n'); yield { type: 'text', text: 'All done.', interim: false }; yield { type: 'done', actions: [] }; };
  await runner(w, gh, { dir: w.checkout(), agent: ok, id: 'nt1', notifyImpl: async () => false }); // no usage key, or Codeply said no
  const doc = gh.read('tasks/nt1.json');
  check('a notice the runner could not push is still in the task file, ready for an app to raise', doc.status === 'done' && doc.notify.kind === 'done' && doc.notify.pushed === false && doc.notify.title && doc.notify.body === 'All done.');
  const home = path.join(w.root, 'home'); fs.mkdirSync(home); const projDir = path.join(w.root, 'client'); fs.mkdirSync(projDir);
  cl.rememberTask(projDir, { id: 'nt1', repo: 'me/proj', prompt: 'p', mode: 'Build', sessionId: '', status: 'running', startedAt: Date.now() }, home);
  const sent = [];
  const st = await cl.cloudRunStatus({ cwd: projDir, taskId: 'nt1', token: 'x', home, apiUrl: 'https://api.test', fetchImpl: gh.fetchImpl, notifyImpl: async (n) => { sent.push(n); return true; } });
  await cl.cloudRunStatus({ cwd: projDir, taskId: 'nt1', token: 'x', home, apiUrl: 'https://api.test', fetchImpl: gh.fetchImpl, notifyImpl: async (n) => { sent.push(n); return true; } });
  check('the PC raises it once, with the person\'s own sign-in', st.status === 'done' && sent.length === 1 && sent[0].kind === 'done' && st.notify.kind === 'done');
  // The push plumbing: the reminders function with the run's usage key, nothing else.
  const reqs = [];
  const okFetch = async (url, init) => { reqs.push({ url, init }); return { ok: true, json: async () => ({ success: true }) }; };
  const pushed = await cl.pushNotice({ env: { CODEPLY_TRACK_KEY: 'trk_test' }, notice: { kind: 'done', title: 'Your cloud task is done', body: 'All done.' }, fetchImpl: okFetch });
  const sentBody = reqs[0] && JSON.parse(reqs[0].init.body);
  check('push: one call to the reminders function with the usage key and a reminder due now', pushed === true && /\/functions\/v1\/reminders$/.test(reqs[0].url) && reqs[0].init.headers['x-codeply-track-key'] === 'trk_test' && !reqs[0].init.headers.Authorization && sentBody.action === 'create' && sentBody.reminder.kind === 'remind' && /Your cloud task is done\. All done\./.test(sentBody.reminder.text) && Math.abs(Date.parse(sentBody.reminder.due_at) - Date.now()) < 5000, JSON.stringify(sentBody));
  check('push: nothing is sent without a usage key, or when it is switched off, and a refusal is not fatal', (await cl.pushNotice({ env: {}, notice: { title: 't', body: 'b' }, fetchImpl: okFetch })) === false && reqs.length === 1 && (await cl.pushNotice({ env: { CODEPLY_TRACK_KEY: 'k', CRAFT_NOTIFY: 'off' }, notice: { title: 't', body: 'b' }, fetchImpl: okFetch })) === false && (await cl.pushNotice({ env: { CODEPLY_TRACK_KEY: 'k' }, notice: { title: 't', body: 'b' }, fetchImpl: async () => ({ ok: false, json: async () => ({ error: 'no' }) }) })) === false);

  // A runner that died without a word: the poller sees a stale "running" file and a finished workflow run, and starts it again.
  const ghd = fakeGithub(w.bare);
  ghd.write('tasks/dead1.json', { id: 'dead1', status: 'running', attempt: 1, runId: '77', updatedAt: Date.now() - 10 * 60000, startedAt: Date.now() - 20 * 60000, events: [] });
  ghd.runs.set('77', { id: 77, status: 'completed', conclusion: 'failure' });
  cl.rememberTask(projDir, { id: 'dead1', repo: 'me/proj', prompt: 'redo it', mode: 'Build', sessionId: 'chatX', status: 'running', attempt: 1, startedAt: Date.now() }, home);
  const sd = await cl.cloudRunStatus({ cwd: projDir, taskId: 'dead1', token: 'x', home, apiUrl: 'https://api.test', fetchImpl: ghd.fetchImpl });
  check('a poller notices a runner that died silently and starts it again (attempt 2)', sd.status === 'running' && sd.retry.attempt === 2 && ghd.dispatches.length === 1 && ghd.dispatches[0].inputs.attempt === '2' && ghd.dispatches[0].inputs.prompt === 'redo it' && ghd.read('tasks/dead1.json').status === 'retrying', JSON.stringify(sd).slice(0, 300));
  ghd.write('tasks/dead2.json', { id: 'dead2', status: 'running', attempt: 3, runId: '78', updatedAt: Date.now() - 10 * 60000, startedAt: Date.now() - 20 * 60000, events: [] });
  ghd.runs.set('78', { id: 78, status: 'completed', conclusion: 'failure' });
  cl.rememberTask(projDir, { id: 'dead2', repo: 'me/proj', prompt: 'redo it', mode: 'Build', sessionId: '', status: 'running', attempt: 3, startedAt: Date.now() }, home);
  const sd2 = await cl.cloudRunStatus({ cwd: projDir, taskId: 'dead2', token: 'x', home, apiUrl: 'https://api.test', fetchImpl: ghd.fetchImpl });
  check('after the last try it is failed, in plain words', sd2.status === 'failed' && /did not help/.test(sd2.error) && ghd.dispatches.length === 1);
  // Stopping a task on purpose: not started again.
  ghd.write('tasks/stop1.json', { id: 'stop1', status: 'running', attempt: 1, runId: '79', updatedAt: Date.now() - 10 * 60000, startedAt: Date.now(), events: [] });
  ghd.runs.set('79', { id: 79, status: 'completed', conclusion: 'cancelled' });
  ghd.write('cancel/stop1.json', { at: Date.now() });
  cl.rememberTask(projDir, { id: 'stop1', repo: 'me/proj', prompt: 'x', mode: 'Build', sessionId: '', status: 'running', attempt: 1, startedAt: Date.now() }, home);
  const ss = await cl.cloudRunStatus({ cwd: projDir, taskId: 'stop1', token: 'x', home, apiUrl: 'https://api.test', fetchImpl: ghd.fetchImpl });
  check('a task the person stopped is not started again', ghd.dispatches.length === 1 && ss.status === 'running' && !ss.retry);
  const cancelled = await runner(w, ghd, { dir: w.checkout(), agent: ok, id: 'stop1', env: { CRAFT_ATTEMPT: '2' } });
  check('and a retry that was already queued when they pressed Stop does not run', cancelled.status === 'stopped');
}

// ═══ 9. The workflow: the step that starts a dead run again, run for real with bash and a mock gh ═══
{
  const wf = cl.CLOUD_WORKFLOW;
  const m = /- name: Start again if the run died\n[\s\S]*?\n {8}run: \|\n([\s\S]*)$/.exec(wf);
  check('workflow: the guard runs only on failure or cancel, has the new inputs, can dispatch, and splices no input into the shell', !!m && /if: failure\(\) \|\| cancelled\(\)/.test(wf) && /actions: write/.test(wf) && /attempt:\n {8}description/.test(wf) && /wip:\n {8}description/.test(wf) && /lease:\n {8}description/.test(wf) && /CRAFT_ATTEMPT: \$\{\{ inputs\.attempt \}\}/.test(wf) && /CRAFT_WIP:/.test(wf) && /CRAFT_LEASE:/.test(wf) && !/run:[^\n]*\$\{\{\s*inputs/.test(wf) && !(m && /\$\{\{/.test(m[1])) && /timeout-minutes: 60/.test(wf), m ? '' : 'step not found');
  check('workflow: the shipped .github/workflows/craft-cloud.yml is this workflow', fs.readFileSync(path.join(ROOT, '.github/workflows/craft-cloud.yml'), 'utf8') === wf);
  const script = m ? m[1].split('\n').map((l) => l.replace(/^ {10}/, '')).join('\n') : '';
  const bin = path.join(tmp, 'bin'); const store = path.join(tmp, 'ghstore'); fs.mkdirSync(bin, { recursive: true }); fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}
const fs = require('fs'); const path = require('path');
const store = process.env.GH_STORE; const a = process.argv.slice(2);
const file = (p) => path.join(store, 'files', p.split('?')[0]);
const flag = (name) => { const out = []; a.forEach((x, i) => { if (x === name) out.push(a[i + 1]); }); return out; };
if (a[0] === 'workflow' && a[1] === 'run') { fs.appendFileSync(path.join(store, 'dispatch.log'), JSON.stringify({ args: a.slice(2) }) + '\\n'); process.exit(0); }
if (a[0] === 'api') {
  const target = a.find((x) => /^repos\\//.test(x));
  const put = a.includes('-X') && a[a.indexOf('-X') + 1] === 'PUT';
  const m = /^repos\\/[^/]+\\/[^/]+\\/(contents|branches)\\/(.+)$/.exec(target || '');
  if (!m) process.exit(1);
  if (m[1] === 'branches') process.exit(fs.existsSync(path.join(store, 'branches', m[2])) ? 0 : 1);
  const f = file(m[2]);
  if (put) { fs.mkdirSync(path.dirname(f), { recursive: true }); const content = flag('-f').find((x) => x.startsWith('content=')).slice(8); fs.writeFileSync(f, Buffer.from(content, 'base64')); process.exit(0); }
  if (!fs.existsSync(f)) process.exit(1);
  if (a.includes('--jq')) { process.stdout.write('sha1'); process.exit(0); }
  process.stdout.write(fs.readFileSync(f, 'utf8')); process.exit(0);
}
process.exit(1);
`, { mode: 0o755 });
  const guard = (files, env, branches = []) => {
    fs.rmSync(store, { recursive: true, force: true }); fs.mkdirSync(path.join(store, 'files'), { recursive: true }); fs.mkdirSync(path.join(store, 'branches', 'craft'), { recursive: true });
    for (const [p, obj] of Object.entries(files)) { const f = path.join(store, 'files', p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(obj)); }
    for (const b of branches) { fs.mkdirSync(path.dirname(path.join(store, 'branches', b)), { recursive: true }); fs.writeFileSync(path.join(store, 'branches', b), ''); }
    const r = spawnSync('bash', ['-e', '-c', script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_STORE: store, GITHUB_REPOSITORY: 'me/proj', TASK_ID: 'g1', SESSION_ID: 'chatG', ATTEMPT: '1', PROMPT: 'Make it fast', MODE: 'Build', HANDOFF: '', LEASE: 'tok', BASE: 'main', ...env }, encoding: 'utf8' });
    const doc = fs.existsSync(path.join(store, 'files', 'tasks/g1.json')) ? JSON.parse(fs.readFileSync(path.join(store, 'files', 'tasks/g1.json'), 'utf8')) : null;
    const dispatches = fs.existsSync(path.join(store, 'dispatch.log')) ? fs.readFileSync(path.join(store, 'dispatch.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).args) : [];
    return { r, doc, dispatches };
  };
  const g1 = guard({ 'tasks/g1.json': { id: 'g1', status: 'running', startedAt: 1, events: [{ t: 'tool' }] } }, {}, ['craft/wip-task-g1']);
  const flags = (d) => Object.fromEntries(d.filter((x) => x.includes('=')).map((x) => [x.split('=')[0], x.slice(x.indexOf('=') + 1)]));
  const f1 = g1.dispatches[0] ? flags(g1.dispatches[0]) : {};
  check('guard: a run that died (task file still "running") is started again from its WIP branch, attempt 2, and the file says retrying', g1.r.status === 0 && g1.dispatches.length === 1 && g1.dispatches[0].slice(0, 3).join(' ') === 'craft-cloud.yml --ref main' && f1.attempt === '2' && f1.wip === 'craft/wip-task-g1' && f1.task_id === 'g1' && f1.session_id === 'chatG' && f1.prompt === 'Make it fast' && f1.lease === 'tok' && g1.doc.status === 'retrying' && g1.doc.retry.attempt === 2 && g1.doc.events.length === 1, g1.r.stderr + JSON.stringify(g1.dispatches));
  const g2 = guard({ 'tasks/g1.json': { id: 'g1', status: 'running' } }, { ATTEMPT: '2' });
  check('guard: without a WIP branch it starts from the base (empty wip), and a handoff resume run keeps its flag', g2.dispatches.length === 1 && flags(g2.dispatches[0]).wip === '' && flags(g2.dispatches[0]).attempt === '3' && guard({ 'tasks/g1.json': { id: 'g1', status: 'running' } }, { HANDOFF: 'resume' }).dispatches.map(flags)[0].handoff === 'resume');
  const g3 = guard({ 'tasks/g1.json': { id: 'g1', status: 'running' } }, { ATTEMPT: '3' });
  check('guard: after the last try it marks the task failed, in plain words, with a notice, and starts nothing', g3.dispatches.length === 0 && g3.doc.status === 'failed' && /did not help/.test(g3.doc.error) && g3.doc.notify.kind === 'failed');
  check('guard: leaves alone a run that already reported (done, failed, retrying) or that was cancelled on purpose or reached no status file only when cancelled',
    ['done', 'failed', 'retrying'].every((s) => guard({ 'tasks/g1.json': { id: 'g1', status: s } }, {}).dispatches.length === 0)
    && guard({ 'tasks/g1.json': { id: 'g1', status: 'running' }, 'cancel/g1.json': { at: 1 } }, {}).dispatches.length === 0);
  const g5 = guard({}, {});
  check('guard: a run that died before writing any status file is started again too', g5.dispatches.length === 1 && g5.doc && g5.doc.status === 'retrying');
}

// ═══ 10. handoff_v2.sql against a real Postgres (when CRAFT_TEST_PG is set) ═══
if (process.env.CRAFT_TEST_PG) {
  const args = process.env.CRAFT_TEST_PG.split(/\s+/).filter(Boolean);
  const psql = (sql, file) => spawnSync('psql', [...args, '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A', ...(file ? ['-f', file] : ['-c', sql])], { encoding: 'utf8' });
  const v1 = psql(null, path.join(ROOT, 'supabase/handoff.sql'));
  const v2 = psql(null, path.join(ROOT, 'supabase/handoff_v2.sql'));
  const v2b = psql(null, path.join(ROOT, 'supabase/handoff_v2.sql'));
  check('sql: handoff_v2.sql applies on top of handoff.sql and again (idempotent)', v1.status === 0 && v2.status === 0 && v2b.status === 0, v1.stderr + v2.stderr + v2b.stderr);
  const scn = psql(`
    delete from public.run_leases; insert into auth.users values ('22222222-2222-2222-2222-222222222222') on conflict do nothing;
    set app.uid = '22222222-2222-2222-2222-222222222222';
    select handoff_begin('q1','d','pc','me/r','main','repo','p','Build', null, false);
    select handoff_set_prompt('q1', 1, 'build the thing');
    update run_leases set beat_at = now() - interval '70 seconds';
    select 'claim', holder, epoch, prompt from handoff_claim_v2(60,180,2);
    select handoff_dispatch_failed('q1', 2, 'try later', 'cloud_failed', 30);
    select 'retry', state, dispatch_attempts from run_leases;
    update run_leases set next_try_at = now() - interval '1 second';
    select 'again', state, epoch from handoff_claim_v2(60,180,2);
    select 'beat', handoff_cloud_beat('q1', (select cloud_task_id from run_leases), 2, false);
    select 'old', handoff_cloud_beat('q1', (select cloud_task_id from run_leases), 1, false);
    update run_leases set beat_at = now() - interval '200 seconds';
    select 'dead', attempt, epoch from handoff_claim_v2(60,180,2);
    select 'finish', handoff_cloud_beat('q1', (select cloud_task_id from run_leases), 3, true);
    select 'state', state from run_leases;`);
  const out = scn.stdout || '';
  check('sql: claim, dispatch retry, cloud beat, reclaim and finish behave as the JS mirror does', scn.status === 0 && /claim\|cloud\|2\|build the thing/.test(out) && /retry\|dispatch_retry\|1/.test(out) && /again\|running\|2/.test(out) && /beat\|running/.test(out) && /old\|lost/.test(out) && /dead\|1\|3/.test(out) && /finish\|finished/.test(out) && /state\|cloud_done/.test(out), scn.stderr + out);
} else console.log('SKIP  sql checks against a real Postgres (set CRAFT_TEST_PG to run them)');

console.log(`\n${total - failures} of ${total} checks passed${failures ? `, ${failures} FAILED` : ''}`);
process.exit(failures ? 1 : 0);
