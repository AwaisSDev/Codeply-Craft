// Local <-> cloud handoff, end to end without the network:
//   node --test codeply-cli/test/handoff.test.mjs
//
// - a lease server stands in for run_leases (same rules as supabase/handoff.sql,
//   on the server's clock)
// - a bare git repo stands in for GitHub's git, a small fake for its contents API
// - the PC is a real child process (fixtures/handoff-pc.mjs), killed mid-task
// - the cloud is the real runner (runCloudRunner) with a scripted agent
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { spawn, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { makeLease, continuationPrompt, applyWip, wipBranch, HANDBACK, STATE_FILE } from '../lib/handoff.mjs';
import { runCloudRunner } from '../lib/cloud.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const BEAT = 150; const FENCE = 450; const STALE = 900; // the real 15 s / 40 s / 60 s, scaled down
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

// ─── run_leases, as supabase/handoff.sql defines it ─────────────────────

function leaseServer() {
  const rows = new Map();
  const ops = {
    begin(b) {
      const cur = rows.get(b.sessionId);
      if (cur && cur.holder === 'cloud' && cur.state === 'running' && !b.takeover) return { error: 'cloud holds this chat' };
      const epoch = (cur ? cur.epoch : 0) + 1;
      rows.set(b.sessionId, { session_id: b.sessionId, holder: 'pc', epoch, state: 'running', beat_at: Date.now(), wip_sha: b.wipSha, repo: b.repo, cloud_task_id: null, cloud_from_sha: null });
      return { epoch };
    },
    beat(b) {
      const r = rows.get(b.sessionId);
      if (r && r.holder === 'pc' && r.epoch === b.epoch && r.state === 'running') {
        r.beat_at = Date.now();
        if (b.wipSha) r.wip_sha = b.wipSha;
        return { ok: true, row: r };
      }
      return { ok: false, row: r || null };
    },
    end(b) { const r = rows.get(b.sessionId); if (r && r.epoch === b.epoch) Object.assign(r, { holder: 'none', state: b.state }); return {}; },
  };
  // The watchdog's handoff_claim_stale.
  const claimStale = () => {
    const out = [];
    for (const r of rows.values()) {
      if (r.holder === 'pc' && r.state === 'running' && r.wip_sha && Date.now() - r.beat_at > STALE) {
        Object.assign(r, { holder: 'cloud', epoch: r.epoch + 1, cloud_from_sha: r.wip_sha, cloud_task_id: `t${Date.now().toString(36)}` });
        out.push({ ...r });
      }
    }
    return out;
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const op = req.url.slice(1);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(ops[op] ? ops[op](JSON.parse(raw || '{}')) : { error: 'no such op' }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ rows, ops, claimStale, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

// ─── GitHub's contents API on craft-sessions, in memory ─────────────────

function fakeGithub() {
  const files = new Map(); // path -> { content (base64), sha }
  let n = 0;
  const reply = (status, body) => ({ ok: status < 300, status, text: async () => (body == null ? '' : JSON.stringify(body)), headers: { get: () => null } });
  const fetchImpl = async (url, { method = 'GET', body } = {}) => {
    const u = new URL(url);
    const m = /^\/repos\/[^/]+\/[^/]+\/(.*)$/.exec(u.pathname);
    const route = m ? m[1] : '';
    if (route.startsWith('contents/')) {
      const p = decodeURIComponent(route.slice('contents/'.length));
      if (method === 'GET') {
        const f = files.get(p);
        if (f) return reply(200, { content: f.content, sha: f.sha, size: f.content.length });
        const kids = [...files.keys()].filter((k) => k.startsWith(`${p}/`));
        return kids.length ? reply(200, kids.map((k) => ({ name: k.split('/').pop(), path: k, sha: files.get(k).sha }))) : reply(404, { message: 'Not Found' });
      }
      if (method === 'PUT') { const b = JSON.parse(body); files.set(p, { content: b.content, sha: `s${++n}` }); return reply(201, {}); }
      if (method === 'DELETE') { files.delete(p); return reply(200, {}); }
    }
    if (route.startsWith('git/ref/heads/')) return reply(200, { object: { sha: 'x' } });
    if (route === 'check-runs' && method === 'POST') return reply(201, { id: 1 });
    if (route.startsWith('check-runs/')) return reply(200, {});
    return reply(404, { message: 'Not Found' });
  };
  const read = (p) => { const f = files.get(p); return f ? JSON.parse(Buffer.from(f.content, 'base64').toString('utf8')) : null; };
  const write = (p, obj) => files.set(p, { content: Buffer.from(JSON.stringify(obj)).toString('base64'), sha: `s${++n}` });
  return { fetchImpl, read, write, files };
}

// ─── A project, a "GitHub" remote, and Craft's home folder ──────────────

function workspace(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `craft-handoff-${name}-`));
  const proj = path.join(root, 'proj'); const home = path.join(root, 'home'); const remote = path.join(root, 'remote.git');
  fs.mkdirSync(proj); fs.mkdirSync(home);
  git(root, 'init', '-q', '--bare', remote);
  fs.writeFileSync(path.join(proj, 'README.md'), '# The project\n');
  return { root, proj, home, remote };
}

/** The PC: run the fixture until it says READY, then pull the plug. */
async function runPcThenKill(ws, lease, sid, steps) {
  const child = spawn(process.execPath, [path.join(here, 'fixtures', 'handoff-pc.mjs')], {
    env: { ...process.env, PROJ: ws.proj, HOME_DIR: ws.home, REMOTE: ws.remote, SID: sid, LEASE_URL: lease.url, STEPS: String(steps), BEAT_MS: String(BEAT), FENCE_MS: String(FENCE) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const lastSha = await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => { out += d; const m = /READY (\w+)/.exec(out); if (m) resolve(m[1]); });
    child.on('exit', (code) => reject(new Error(`the PC exited early (${code})`)));
  });
  // Alive and renewing: the watchdog must not touch it.
  await sleep(STALE + 300);
  assert.equal(lease.claimStale().length, 0, 'a live PC must keep its lease');
  child.kill('SIGKILL');
  await new Promise((r) => child.once('exit', r));
  return { lastSha, killedAt: Date.now() };
}

/** The watchdog, every 100 ms until it claims the chat. */
async function watchdog(lease, sid) {
  for (let i = 0; i < 100; i++) {
    const claimed = lease.claimStale().find((r) => r.session_id === sid);
    if (claimed) return claimed;
    await sleep(100);
  }
  throw new Error('the watchdog never claimed the stale lease');
}

/** GitHub Actions: check out craft/wip-<chat> and run the real runner with a scripted agent. */
async function cloudRun(ws, gh, claimed, sid, { steps, onStep = async () => {} }) {
  const dir = path.join(ws.root, `runner-${claimed.cloud_task_id}`);
  git(ws.root, '-c', 'core.autocrlf=false', 'clone', '-q', '-c', 'core.autocrlf=false', '--branch', wipBranch(sid), '--single-branch', ws.remote, dir);
  const seen = {};
  const agent = async function* ({ userMessage, history, todos, signal, cwd }) {
    Object.assign(seen, { userMessage, history, todos, stateFileOnDisk: fs.existsSync(path.join(cwd, STATE_FILE)) });
    for (const i of steps) {
      if (signal.aborted) { yield { type: 'aborted' }; return; }
      if (i === 'edit-step1') fs.appendFileSync(path.join(cwd, 'step1.txt'), 'line two from the cloud\n');
      else fs.writeFileSync(path.join(cwd, `step${i}.txt`), `from the cloud, step ${i}\n`);
      await onStep(i);
      yield { type: 'tool_end', name: i === 'edit-step1' ? 'edit_file' : 'write_file', args: { path: i === 'edit-step1' ? 'step1.txt' : `step${i}.txt` }, ok: true };
    }
    yield { type: 'text', text: 'All six steps are done.', interim: false };
    yield { type: 'done', actions: [] };
  };
  const out = await runCloudRunner({
    env: { GITHUB_REPOSITORY: 'me/proj', CRAFT_TASK_ID: claimed.cloud_task_id, CRAFT_SESSION_ID: sid, GITHUB_SHA: git(dir, 'rev-parse', 'HEAD'), CRAFT_HANDOFF: 'resume', CRAFT_PERMISSIONS: '' },
    cwd: dir, token: 'test-token', route: { auto: true }, fetchImpl: gh.fetchImpl, runAgentImpl: agent, browserImpl: null, idleMs: 0, updateMs: 0, pollMs: 50,
  });
  return { out, seen, dir };
}

test('the PC is killed mid-task and Craft Cloud carries on from the same step', async () => {
  const lease = await leaseServer();
  const ws = workspace('kill');
  const gh = fakeGithub();
  const sid = 'chatkill1';
  try {
    const { lastSha } = await runPcThenKill(ws, lease, sid, 3);
    const claimed = await watchdog(lease, sid);
    assert.equal(claimed.holder, 'cloud');
    assert.equal(claimed.epoch, 2, 'the takeover moves the lease on by one');
    assert.equal(claimed.cloud_from_sha, lastSha, 'the cloud starts from the last WIP the PC pushed');

    const { out, seen, dir } = await cloudRun(ws, gh, claimed, sid, { steps: [4, 5, 6] });
    assert.equal(out.status, 'done', JSON.stringify(out.result && out.result.error));

    // It resumed at step 4, knowing steps 1-3 and the todo list, and never saw the state file.
    assert.match(seen.userMessage, /^Build the six-step thing/);
    assert.match(seen.userMessage, /1\. wrote step1\.txt\n2\. wrote step2\.txt\n3\. wrote step3\.txt/);
    assert.doesNotMatch(seen.userMessage, /4\. wrote/);
    assert.match(seen.userMessage, /\[x\] step 3\n\[~\] step 4\n\[ \] step 5/);
    assert.equal(seen.todos.length, 6);
    assert.deepEqual(seen.history.map((t) => t.role), ['user', 'assistant']);
    assert.equal(seen.stateFileOnDisk, false);

    // The cloud machine had the PC's files from steps 1-3 (the in-flight edit was never pushed).
    for (const i of [1, 2, 3]) assert.equal(fs.readFileSync(path.join(dir, `step${i}.txt`), 'utf8'), `line one from the PC, step ${i}\n`);
    assert.equal(fs.existsSync(path.join(dir, 'unpushed.txt')), false);

    // Its work is on craft/wip-<chat>, with the state saying all six steps are done.
    const files = git(ws.root, '--git-dir', ws.remote, 'ls-tree', '--name-only', wipBranch(sid)).split('\n');
    for (const i of [1, 2, 3, 4, 5, 6]) assert.ok(files.includes(`step${i}.txt`), `step${i}.txt on the WIP branch`);
    const state = JSON.parse(git(ws.root, '--git-dir', ws.remote, 'show', `${wipBranch(sid)}:${STATE_FILE}`));
    assert.equal(state.side, 'cloud');
    assert.equal(state.steps.length, 6);
    assert.deepEqual(gh.read(HANDBACK.done(sid)).status, 'done');
    assert.equal(out.result.handoff.handedBack, false);
  } finally { lease.close(); }
});

test('the PC fences itself before the cloud may take over', async () => {
  let t = 0;
  const offlineStore = { begin: async () => ({ epoch: 1 }), beat: async () => { throw new Error('offline'); }, end: async () => {} };
  const fenced = []; const offline = [];
  const lease = makeLease({ store: offlineStore, sessionId: 's', now: () => t, fenceMs: 40000, onFence: (w) => fenced.push([w, t]), onOffline: (o) => offline.push(o), setTimer: () => 1, clearTimer: () => {} });
  await lease.start({ wipSha: 'a' });
  for (t = 15000; t <= 60000; t += 15000) await lease.beat();
  assert.deepEqual(offline, [true]);
  assert.equal(fenced.length, 1);
  assert.equal(fenced[0][0], 'offline');
  assert.ok(fenced[0][1] < 60000, 'stopped before the 60 s takeover');

  // A local model keeps working offline: only the warning, no fence.
  t = 0; const warned = []; const fenced2 = [];
  const local = makeLease({ store: offlineStore, sessionId: 's', now: () => t, keepGoingOffline: true, onFence: (w) => fenced2.push(w), onOffline: (o) => warned.push(o), setTimer: () => 1, clearTimer: () => {} });
  await local.start({ wipSha: 'a' });
  for (t = 15000; t <= 120000; t += 15000) await local.beat();
  assert.deepEqual(warned, [true]);
  assert.deepEqual(fenced2, []);

  // Back online, but the cloud holds the chat now: stop at once.
  const taken = []; const takenStore = { ...offlineStore, beat: async () => ({ ok: false, row: { holder: 'cloud', epoch: 2 } }) };
  const back = makeLease({ store: takenStore, sessionId: 's', onFence: (w) => taken.push(w), setTimer: () => 1, clearTimer: () => {} });
  await back.start({ wipSha: 'a' });
  await back.beat();
  assert.deepEqual(taken, ['taken']);
});

test('the PC comes back: the cloud stops between steps and everything lands on the PC', async () => {
  const lease = await leaseServer();
  const ws = workspace('back');
  const gh = fakeGithub();
  const sid = 'chatback1';
  try {
    await runPcThenKill(ws, lease, sid, 2);
    const claimed = await watchdog(lease, sid);
    // While the cloud holds the chat, the PC may not start it again without taking it back.
    assert.ok(lease.ops.begin({ sessionId: sid, repo: 'me/proj', wipSha: 'z' }).error);

    // The PC comes back online after the cloud's first two steps and asks for the chat.
    const { out, dir } = await cloudRun(ws, gh, claimed, sid, {
      steps: [3, 'edit-step1', 4, 5, 6],
      onStep: async (i) => { if (i === 'edit-step1') gh.write(HANDBACK.want(sid), { device: 'pc', taskId: claimed.cloud_task_id }); },
    });
    assert.equal(out.status, 'done');
    assert.equal(out.result.handoff.handedBack, true);
    // It stopped right after the step it was on, never mid-tool, and did nothing after.
    assert.ok(fs.existsSync(path.join(dir, 'step3.txt')));
    assert.equal(fs.existsSync(path.join(dir, 'step4.txt')), false);
    const done = gh.read(HANDBACK.done(sid));
    assert.equal(done.status, 'paused');
    assert.equal(gh.read(HANDBACK.want(sid)), null, 'the request is cleared');

    // The PC still has the edit it made right before the power cut, and one more made since.
    fs.writeFileSync(path.join(ws.proj, 'notes.txt'), 'typed while the cloud worked\n');
    const r = await applyWip({ cwd: ws.proj, home: ws.home, repo: 'me/proj', sessionId: sid, fromSha: claimed.cloud_from_sha, remoteUrl: ws.remote });
    assert.deepEqual(r.conflicts, []);
    assert.deepEqual(r.files.sort(), ['step1.txt', 'step3.txt']);
    assert.equal(r.toSha, done.sha);
    assert.equal(fs.readFileSync(path.join(ws.proj, 'step1.txt'), 'utf8'), 'line one from the PC, step 1\nline two from the cloud\n');
    assert.equal(fs.readFileSync(path.join(ws.proj, 'step3.txt'), 'utf8'), 'from the cloud, step 3\n');
    assert.equal(fs.readFileSync(path.join(ws.proj, 'unpushed.txt'), 'utf8'), 'written right before the power cut\n');
    assert.equal(fs.readFileSync(path.join(ws.proj, 'notes.txt'), 'utf8'), 'typed while the cloud worked\n');
    assert.equal(fs.existsSync(path.join(ws.proj, STATE_FILE)), false);

    // The state the PC carries on from: all four steps, the PC's and the cloud's.
    assert.equal(r.state.side, 'cloud');
    assert.deepEqual(r.state.steps, ['wrote step1.txt', 'wrote step2.txt', 'wrote step3.txt', 'edited step1.txt']);
    const prompt = continuationPrompt(r.state, 'pc');
    assert.match(prompt, /carried on in Craft Cloud while the PC was offline/);
    assert.match(prompt, /4\. edited step1\.txt/);

    // And the PC takes the lease back: one writer again.
    const again = lease.ops.begin({ sessionId: sid, repo: 'me/proj', wipSha: r.toSha, takeover: true });
    assert.equal(again.epoch, claimed.epoch + 1);
    assert.equal(lease.rows.get(sid).holder, 'pc');
  } finally { lease.close(); }
});

test('an ordinary cloud run is unchanged (no handoff state, no WIP branch)', async () => {
  const ws = workspace('plain');
  const gh = fakeGithub();
  fs.writeFileSync(path.join(ws.proj, 'a.txt'), 'a\n');
  git(ws.proj, 'init', '-q'); git(ws.proj, 'add', '-A'); git(ws.proj, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  let seen = null;
  const agent = async function* (args) { seen = args; yield { type: 'text', text: 'It is a one-file project.', interim: false }; yield { type: 'done', actions: [] }; };
  const out = await runCloudRunner({
    env: { GITHUB_REPOSITORY: 'me/proj', CRAFT_TASK_ID: 'plain1', CRAFT_SESSION_ID: 'chatplain', CRAFT_PROMPT: 'What is in here?', CRAFT_MODE: 'Ask', GITHUB_SHA: git(ws.proj, 'rev-parse', 'HEAD') },
    cwd: ws.proj, token: 'test-token', route: { auto: true }, fetchImpl: gh.fetchImpl, runAgentImpl: agent, browserImpl: null, idleMs: 0, updateMs: 0,
  });
  assert.equal(out.status, 'done');
  assert.equal(out.result.answer, 'It is a one-file project.');
  assert.equal(out.handoff, undefined);
  assert.match(seen.userMessage, /^What is in here\?\n\n\(You are running unattended in Craft Cloud/);
  assert.equal(seen.todos, undefined);
  assert.equal(gh.read(HANDBACK.done('chatplain')), null);
});
