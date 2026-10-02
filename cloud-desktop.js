// Craft Cloud in the desktop app: the main-process side.
//
// A project with the Cloud chip on sends each new message to the cloud
// (codeply-cli/lib/cloud.mjs) instead of running it on this PC. The chat gets
// a small cloud line that this file keeps up to date by polling GitHub, the
// run's steps as normal chat rows, and the finished answer as a normal reply.
//
// Two kinds of project:
//  - repo: the cloud works in the project's own GitHub repo, one branch per
//    task, merged into the base branch. The PC pulls (checkBehind, pullLatest).
//  - mirror: a private copy holds snapshots. Code changes stay there until the
//    user clicks Apply, which lands them as a checkpoint so Undo works as usual.
//    After every local run a mirror project is backed up (auto-backup), so a
//    cloud run started later from the phone sees the latest code.
//
// main.js wires this in with init(deps); everything it needs from main.js is
// passed in, so nothing here reaches into main.js state directly.
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const POLL_MS = 5000;
const POLL_SLOW_MS = 15000;
const TERMINAL = new Set(['done', 'failed', 'cancelled']);

let deps = null;
let cl = null;
const pollers = new Map();        // taskId -> timeout
const backupTimers = new Map();   // cwd -> timeout
const backingUp = new Set();

async function lib() {
  if (!(await deps.ensureEngine())) throw new Error('Engine not available.');
  if (!cl) cl = await import(pathToFileURL(path.join(deps.cliDir, 'lib', 'cloud.mjs')).href);
  return cl;
}

function githubToken() {
  const gh = deps.configLib().getIntegration('github');
  return gh && gh.accessToken ? gh.accessToken : null;
}

const scopeCache = new Map(); // token -> Promise<boolean>

/** Can this GitHub login create private repos and workflow files? Older connections have no recorded scope, so ask GitHub once. */
function githubScopesOk() {
  const gh = deps.configLib().getIntegration('github');
  if (!gh || !gh.accessToken) return Promise.resolve(false);
  if (typeof gh.scope === 'string' && gh.scope) {
    const scopes = gh.scope.split(/[\s,]+/);
    return Promise.resolve(scopes.includes('repo') && scopes.includes('workflow'));
  }
  if (!scopeCache.has(gh.accessToken)) {
    scopeCache.set(gh.accessToken, lib()
      .then((c) => c.checkToken(c.githubApi({ token: gh.accessToken })))
      .then((r) => r.ok)
      .catch(() => { scopeCache.delete(gh.accessToken); return true; }));
  }
  return scopeCache.get(gh.accessToken);
}

/** What the renderer shows on the Cloud chip and in the setup sheet. */
async function state(cwd) {
  const c = await lib();
  const gh = deps.configLib().getIntegration('github') || {};
  const model = deps.configLib().getSelectedModel();
  const modelCheck = c.cloudModelConfig(model);
  const p = cwd ? c.getProject(cwd) : null;
  const ready = !!(p && p.repo);
  return {
    github: { connected: !!gh.accessToken, userName: gh.userName || '', scopesOk: await githubScopesOk() },
    model: { name: model ? (model.name || model.model) : 'Auto', ok: !modelCheck.error, error: modelCheck.error || null },
    // Before setup: the project's own GitHub repo, offered as the default place to work.
    origin: !ready && cwd ? await originInfo(c, cwd) : null,
    project: ready ? {
      repo: p.repo, url: `https://github.com/${p.repo}`, kind: p.kind === 'repo' ? 'repo' : 'mirror', base: p.base || 'main',
      cloudOn: !!p.cloudOn, autoBackup: p.autoBackup !== false,
      modelName: p.modelName || '', lastPush: p.lastPush ? { at: p.lastPush.at, skipped: p.lastPush.skipped || [] } : null,
      env: envInfo(cwd),
      tasks: (p.tasks || []).slice(0, 20).map((t) => taskView(t, p)),
    } : null,
  };
}

const originCache = new Map(); // owner/name -> { base, canPush }, asked once per app start

/** The project's GitHub origin with its default branch and whether this login can push to it, or null. */
async function originInfo(c, cwd) {
  const repo = await c.githubOrigin(cwd).catch(() => null);
  if (!repo) return null;
  const token = githubToken();
  if (token && !originCache.has(repo)) {
    try {
      const r = await c.githubApi({ token })('GET', `/repos/${repo}`, null, { allow: [404] });
      if (r.status === 200) originCache.set(repo, { base: r.json.default_branch || 'main', canPush: !!(r.json.permissions && r.json.permissions.push) });
      else originCache.set(repo, { base: 'main', canPush: false });
    } catch { /* offline: ask again next time */ }
  }
  const info = originCache.get(repo);
  return { repo, base: info ? info.base : 'main', canPush: info ? info.canPush : null };
}

// The names (never the values) of the environment variables saved for a
// project, so the sheet can say what is set. The values only live in the GitHub secret.
function envFile() { return path.join(deps.userDataDir || '.', 'cloud-env.json'); }
const envKey = (cwd) => path.resolve(cwd).replace(/\\/g, '/').toLowerCase();
function readEnvNames() { try { return JSON.parse(fs.readFileSync(envFile(), 'utf8')) || {}; } catch { return {}; } }
function envInfo(cwd) { const e = readEnvNames()[envKey(cwd)]; return e ? { keys: e.keys || [], at: e.at || null } : { keys: [], at: null }; }
function saveEnvNames(cwd, envText) {
  const keys = String(envText || '').split(/\r?\n/).map((l) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(l)).filter(Boolean).map((m) => m[1]);
  const all = readEnvNames();
  if (keys.length) all[envKey(cwd)] = { keys, at: Date.now() }; else delete all[envKey(cwd)];
  try { fs.mkdirSync(path.dirname(envFile()), { recursive: true }); fs.writeFileSync(envFile(), JSON.stringify(all, null, 2)); } catch {}
}

function taskView(t, p) {
  const r = t.result || {};
  return {
    id: t.id, status: t.status, prompt: t.prompt, mode: t.mode, repo: t.repo, runUrl: t.runUrl || null,
    progress: t.progress || '', error: t.error || null, startedAt: t.startedAt, finishedAt: t.finishedAt || null,
    files: r.files || [], stats: r.stats || [], branch: r.branch || null, answer: r.answer || '', pulledAt: t.pulledAt || null, conflicts: t.conflicts || [],
    remote: !!t.remote, queued: !!t.queued,
    kind: t.kind || (p && p.kind === 'repo' ? 'repo' : 'mirror'),
    base: (r.merged && r.merged.base) || (p && p.base) || 'main',
    merged: r.merged || null,
  };
}

async function setup(cwd, opts = {}) {
  if (!cwd) return { error: 'Pick a project folder first.' };
  if (!githubToken()) return { error: 'Connect GitHub first.', needsGithub: true };
  if (!(await githubScopesOk())) return { error: 'Reconnect GitHub so Craft may create private repos and workflow files.', needsGithub: true };
  const c = await lib();
  const model = deps.configLib().getSelectedModel();
  const check = c.cloudModelConfig(model);
  if (check.error) return { error: check.error, needsModel: true };
  try {
    const target = opts.target === 'mirror' ? 'mirror' : opts.target === 'repo' ? 'repo' : undefined;
    const envText = typeof opts.envText === 'string' && opts.envText.trim() ? opts.envText : undefined;
    const r = await c.setupCloud({ cwd, token: githubToken(), model, target, envText });
    if (envText) saveEnvNames(cwd, envText);
    c.setProjectOptions(cwd, { cloudOn: true });
    return { ok: true, ...r, state: await state(cwd) };
  } catch (e) {
    return { error: e.message };
  }
}

async function setOptions(cwd, opts) {
  const c = await lib();
  const p = c.getProject(cwd);
  if (!p || !p.repo) return { error: 'Set up cloud runs for this project first.' };
  c.setProjectOptions(cwd, opts || {});
  return { ok: true, state: await state(cwd) };
}

/** Replace the project's test environment (KEY=value lines, kept as the encrypted CRAFT_ENV secret). Empty clears it. */
async function setEnv(cwd, envText) {
  const c = await lib();
  const p = c.getProject(cwd);
  if (!p || !p.repo) return { error: 'Set up cloud runs for this project first.' };
  if (!githubToken()) return { error: 'Connect GitHub first.', needsGithub: true };
  try {
    const count = await c.setProjectEnv({ api: c.githubApi({ token: githubToken() }), repo: p.repo, envText: String(envText || '') });
    saveEnvNames(cwd, envText);
    return { ok: true, count, state: await state(cwd) };
  } catch (e) { return { error: e.message }; }
}

/** Is the local branch behind GitHub? For any git project with an upstream. */
async function checkBehind(cwd) {
  if (!cwd) return { ok: false, reason: 'no project' };
  try { if (!fs.statSync(cwd).isDirectory()) return { ok: false, reason: 'not a folder' }; } catch { return { ok: false, reason: 'not a folder' }; }
  const c = await lib();
  return c.checkBehind(cwd);
}

/** Files git left with conflict markers, after a pull that could not merge cleanly. */
function conflictedFiles(cwd) {
  return new Promise((resolve) => {
    require('child_process').execFile('git', ['diff', '--name-only', '--diff-filter=U'], { cwd, windowsHide: true, timeout: 15000 }, (err, out) => {
      resolve(err ? [] : String(out).split('\n').map((s) => s.trim()).filter(Boolean));
    });
  });
}

/** Pull what GitHub has. With a chat card, the card remembers it was pulled. */
async function pull(cwd, sessionId, taskId) {
  if (!cwd) return { error: 'Pick a project folder first.' };
  if (sessionId && deps.isRunning(sessionId)) return { error: 'Wait for the current run to finish first.' };
  const c = await lib();
  let r;
  try { r = await c.pullLatest(cwd); } catch (e) {
    const clash = await conflictedFiles(cwd);
    if (clash.length) return { error: `GitHub's commits and yours change the same lines in ${clash.slice(0, 4).join(', ')}${clash.length > 4 ? ` and ${clash.length - 4} more` : ''}. Fix the <<<<<<< markers there, or run git merge --abort to undo the pull.`, conflicts: clash };
    return { error: e.message };
  }
  const session = sessionId ? deps.findSession(sessionId) : null;
  const card = session && taskId ? findCard(session, taskId) : null;
  if (card) {
    card.task = { ...card.task, pulledAt: Date.now() };
    deps.persist(session);
    emitCard(session, card);
  }
  return { ok: true, pulled: r.pulled || 0 };
}

/** True when main.js should hand this message to the cloud. Sync on purpose: startChatRun calls it inline. */
function wants(cwd) {
  if (!cl || !cwd) return false;
  const p = cl.getProject(cwd);
  return !!(p && p.repo && p.cloudOn);
}

/**
 * The runner's step-by-step record, turned into the same chat messages and
 * events a local run produces (main.js runOneTurn), so a cloud chat reads like
 * any other: commands, edits with + and - lines, narration, what happened.
 * Browser check screenshots are fetched into browser-checks, where local runs
 * keep theirs, so the PC chat and the phone show them the same way.
 */
async function replay(session, card, events) {
  if (!Array.isArray(events)) return;
  // A trimmed record starts with a "N earlier steps" note; never replay backwards.
  for (let i = card.seen || 0; i < events.length; i++) {
    const e = events[i];
    if (e.t === 'text') {
      session.messages.push({ kind: 'assistant', text: e.text, interim: true, at: Date.now() });
      deps.sendEvent(session.id, { type: 'text', text: e.text, interim: true });
    } else if (e.t === 'reasoning') {
      session.messages.push({ kind: 'reasoning', text: e.text, ms: e.ms, at: Date.now() });
      deps.sendEvent(session.id, { type: 'reasoning', text: e.text, ms: e.ms });
    } else if (e.t === 'tool') {
      const label = e.summary || (e.args && (e.args.path || e.args.command || e.args.pattern)) || '';
      const shot = e.screenshot ? await fetchShot(card.task, e.screenshot, i) : null;
      session.messages.push({ kind: 'tool', name: e.name, label, ok: e.ok, args: e.args, at: Date.now(), exitCode: e.exitCode, added: e.added, removed: e.removed, screenshotPath: shot ? shot.path : undefined });
      deps.sendEvent(session.id, {
        type: 'tool_end', name: e.name, args: e.args, ok: e.ok, summary: e.summary,
        meta: { exitCode: e.exitCode, added: e.added, removed: e.removed, ...(shot ? { screenshotPath: shot.path, screenshotDataUrl: shot.dataUrl } : {}) },
      });
    } else if (e.t === 'notice') {
      session.messages.push({ kind: 'notice', level: e.level || 'info', text: e.text, at: Date.now() });
      deps.sendEvent(session.id, { type: 'notice', level: e.level || 'info', text: e.text });
    } else if (e.t === 'summary') {
      const summary = { kind: 'turn_summary', files: e.files || [], checks: e.checks || [], unverified: e.unverified || [], at: Date.now() };
      session.messages.push(summary);
      deps.sendEvent(session.id, { type: 'turn_summary', ...summary });
    } else if (e.t === 'pushed') {
      const n = (e.files || []).length;
      const text = `Committed ${n} file${n === 1 ? '' : 's'} (+${e.added || 0} -${e.removed || 0}) on ${e.branch}.`;
      session.messages.push({ kind: 'notice', level: 'info', text, at: Date.now() });
      deps.sendEvent(session.id, { type: 'notice', level: 'info', text });
    }
    card.seen = i + 1;
  }
}

/** shots/<task>/<n>.png on GitHub, saved as browser-checks/<task>-<n>.png here. Null when it can't be had. */
async function fetchShot(task, rel, index) {
  try {
    const m = /([^/\\]+)\/(\d+)\.png$/i.exec(String(rel));
    const name = `${String(m ? m[1] : task.id).replace(/[^A-Za-z0-9_-]/g, '')}-${m ? m[2] : index}.png`;
    const dest = path.join(deps.userDataDir || '.', 'browser-checks', name);
    if (!fs.existsSync(dest)) {
      const c = await lib();
      const got = await c.downloadShot({ token: githubToken(), repo: task.repo, path: String(rel), dest });
      if (!got) return null;
    }
    return { path: dest, dataUrl: `data:image/png;base64,${fs.readFileSync(dest).toString('base64')}` };
  } catch (e) {
    console.warn('[cloud] screenshot download failed:', e.message);
    return null;
  }
}

function findCard(session, taskId) {
  return session.messages.find((m) => m.kind === 'cloud_task' && m.task && m.task.id === taskId);
}

function emitCard(session, card) {
  deps.sendEvent(session.id, { type: 'cloud_task', task: card.task });
}

/**
 * Called by startChatRun after the user's message is saved. Returns at once;
 * the run itself happens on GitHub.
 */
function startFromChat({ session, text, mode }) {
  const cwd = session.cwd;
  const pendingId = `pending-${Date.now().toString(36)}`;
  const card = { kind: 'cloud_task', task: { id: pendingId, status: 'starting', prompt: text, mode, startedAt: Date.now() }, at: Date.now() };
  session.messages.push(card);
  deps.persist(session);
  emitCard(session, card);
  deps.sendEvent(session.id, { type: 'run_finished' });

  (async () => {
    try {
      const c = await lib();
      const token = githubToken();
      if (!token) throw new Error('GitHub is not connected any more. Reconnect it in Connect Apps.');
      const model = deps.configLib().getSelectedModel();
      const task = await c.startCloudRun({ cwd, token, prompt: text, mode, sessionId: session.id, model, startedAt: card.task.startedAt });
      card.task = taskView(task, c.getProject(cwd));
      deps.persist(session);
      emitCard(session, card);
      poll(session.id, cwd, task.id, 0);
    } catch (e) {
      card.task = { ...card.task, status: 'failed', error: e.message, progress: '' };
      deps.persist(session);
      emitCard(session, card);
    }
  })();

  return { sessionId: session.id, title: session.title, route: { label: 'Cloud' } };
}

function poll(sessionId, cwd, taskId, attempt) {
  clearTimeout(pollers.get(taskId));
  // Long runs don't need a request every 5 seconds forever.
  const wait = attempt > 120 ? POLL_SLOW_MS : POLL_MS;
  pollers.set(taskId, setTimeout(async () => {
    pollers.delete(taskId);
    const session = deps.findSession(sessionId);
    if (!session) return;
    const card = findCard(session, taskId);
    if (!card) return;
    let task;
    let c;
    try {
      c = await lib();
      task = await c.cloudRunStatus({ cwd, taskId, token: githubToken() });
    } catch (e) {
      // Offline or GitHub hiccup: keep trying, a little slower.
      poll(sessionId, cwd, taskId, attempt + 12);
      return;
    }
    const before = card.task.status + (card.task.progress || '') + (card.seen || 0);
    card.task = { ...taskView(task, c.getProject(cwd)), pulledAt: card.task.pulledAt || task.pulledAt || null };
    try { await replay(session, card, task.events); } catch (e) { console.warn('[cloud] replay failed:', e.message); }
    if (TERMINAL.has(task.status)) {
      finish(session, card, task);
      return;
    }
    if (before !== card.task.status + (card.task.progress || '') + (card.seen || 0)) { deps.persist(session); emitCard(session, card); }
    poll(sessionId, cwd, taskId, attempt + 1);
  }, wait));
}

function finish(session, card, task) {
  const r = task.result || {};
  if (task.status === 'done' && r.answer) {
    session.messages.push({ kind: 'assistant', text: r.answer, at: Date.now() });
    deps.sendEvent(session.id, { type: 'text', text: r.answer, interim: false });
  }
  // A failed or cancelled run says why on its own cloud line; no second note.
  session.updatedAt = Date.now();
  deps.persist(session);
  emitCard(session, card);
  deps.sendEvent(session.id, { type: 'run_finished' });
  deps.sendEvent(session.id, { type: 'session_sync', session: deps.sessionMeta(session) });
  deps.notify(session);
}

/** Bring a finished run's changes into the project, as an undoable checkpoint. */
async function apply(sessionId, taskId) {
  const session = deps.findSession(sessionId);
  const card = session && findCard(session, taskId);
  const cwd = session ? session.cwd : null;
  const c = await lib();
  if (!cwd) return { error: 'That chat is gone.' };
  if (deps.isRunning(sessionId)) return { error: 'Wait for the current run to finish first.' };
  const snap = deps.snapshotLib();
  let beforeTree = null;
  try { if (snap) beforeTree = await snap.track(cwd); } catch {}
  let r;
  try {
    await c.cloudRunStatus({ cwd, taskId, token: githubToken() });
    r = await c.pullCloudRun({ cwd, taskId, token: githubToken() });
  } catch (e) {
    return { error: e.message };
  }
  if (r.applied && beforeTree && snap) {
    try {
      const afterTree = await snap.track(cwd);
      const changes = await snap.changedFiles(cwd, beforeTree, afterTree);
      if (changes.length) {
        const checkpoint = { kind: 'checkpoint', id: `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, beforeTree, afterTree, cwd, files: changes.slice(0, 200), total: changes.length, undone: false, at: Date.now() };
        session.messages.push(checkpoint);
        deps.sendEvent(session.id, { type: 'checkpoint', checkpoint: deps.checkpointView(checkpoint) });
      }
    } catch {}
  }
  if (card) {
    card.task = taskView(c.getTask(cwd, taskId) || { ...card.task, pulledAt: Date.now() }, c.getProject(cwd));
    emitCard(session, card);
  }
  if (r.conflicts && r.conflicts.length) {
    const text = `Applied, with conflicts to resolve in ${r.conflicts.join(', ')} (you changed the same lines while the cloud run worked; look for <<<<<<< markers).`;
    session.messages.push({ kind: 'notice', level: 'warn', text, at: Date.now() });
    deps.sendEvent(session.id, { type: 'notice', level: 'warn', text });
  }
  deps.persist(session);
  // The mirror should hold what the project looks like now, for the next run from the phone.
  if (r.applied) afterLocalRun(cwd);
  return { ok: true, ...r };
}

/** Apply a run started elsewhere (phone), shown in the Cloud sheet rather than a chat. */
async function applyTask(cwd, taskId) {
  const c = await lib();
  try {
    await c.cloudRunStatus({ cwd, taskId, token: githubToken() });
    const r = await c.pullCloudRun({ cwd, taskId, token: githubToken() });
    if (r.applied) afterLocalRun(cwd);
    return { ok: true, ...r, state: await state(cwd) };
  } catch (e) { return { error: e.message }; }
}

async function cancel(sessionId, taskId) {
  const session = deps.findSession(sessionId);
  if (!session) return { error: 'That chat is gone.' };
  try {
    const c = await lib();
    await c.cancelCloudRun({ cwd: session.cwd, taskId, token: githubToken() });
    return { ok: true };
  } catch (e) { return { error: e.message }; }
}

async function refreshRemote(cwd) {
  const c = await lib();
  const token = githubToken();
  if (!token || !c.getProject(cwd)) return state(cwd);
  try { await c.importRemoteTasks({ cwd, token }); } catch {}
  return state(cwd);
}

/** After a local run: back the project up to its mirror, quietly. */
function afterLocalRun(cwd) {
  if (!cl || !cwd) return;
  const p = cl.getProject(cwd);
  // A repo project's GitHub repo is the user's own: never push snapshots there.
  if (!p || !p.repo || p.kind === 'repo' || p.autoBackup === false || !githubToken()) return;
  clearTimeout(backupTimers.get(cwd));
  backupTimers.set(cwd, setTimeout(async () => {
    backupTimers.delete(cwd);
    if (backingUp.has(cwd)) return afterLocalRun(cwd);
    backingUp.add(cwd);
    try { await cl.pushSnapshot({ cwd, token: githubToken() }); } catch (e) { console.warn('[cloud] backup failed:', e.message); }
    finally { backingUp.delete(cwd); }
  }, 3000));
}

/** Cards left running when the app closed pick up where they were. */
function resume() {
  for (const session of deps.allSessions()) {
    for (const m of session.messages) {
      if (m.kind === 'cloud_task' && m.task && !TERMINAL.has(m.task.status)) {
        if (String(m.task.id).startsWith('pending-')) { m.task = { ...m.task, status: 'failed', error: 'Craft closed before the run started.' }; deps.persist(session); }
        else poll(session.id, session.cwd, m.task.id, 0);
      }
    }
  }
}

/**
 * The phone's routes (LAN or relay). /credentials hands a signed-in phone the
 * GitHub token and mirror names so it can start and follow cloud runs itself
 * while this PC is off.
 */
async function bridge(method, pathname, query, body) {
  body = body || {};
  if (method === 'GET' && pathname === '/api/cloud/state') return { status: 200, body: await refreshRemote(query.get('cwd') || '') };
  if (method === 'GET' && pathname === '/api/cloud/credentials') {
    const token = githubToken();
    if (!token) return { status: 409, body: { error: 'GitHub is not connected on the PC.' } };
    const c = await lib();
    const projects = Object.values(c.readState().projects).filter((p) => p.repo).map((p) => ({ cwd: p.cwd, name: path.basename(p.cwd), repo: p.repo }));
    return { status: 200, body: { token, projects } };
  }
  if (method === 'POST' && pathname === '/api/cloud/setup') { const r = await setup(body.cwd, { target: body.target, envText: body.envText }); return { status: r.error ? 400 : 200, body: r }; }
  if (method === 'POST' && pathname === '/api/cloud/env') { const r = await setEnv(body.cwd, body.envText); return { status: r.error ? 400 : 200, body: r }; }
  if ((method === 'GET' || method === 'POST') && pathname === '/api/cloud/checkBehind') {
    return { status: 200, body: await checkBehind(method === 'GET' ? query.get('cwd') || '' : body.cwd) };
  }
  if (method === 'POST' && pathname === '/api/cloud/pull') {
    const session = body.sessionId ? deps.findSession(body.sessionId) : null;
    const r = await pull(body.cwd || (session && session.cwd), body.sessionId, body.taskId);
    return { status: r.error ? 409 : 200, body: r };
  }
  if (method === 'POST' && pathname === '/api/cloud/options') { const r = await setOptions(body.cwd, body); return { status: r.error ? 400 : 200, body: r }; }
  if (method === 'POST' && pathname === '/api/cloud/apply') { const r = body.sessionId ? await apply(body.sessionId, body.taskId) : await applyTask(body.cwd, body.taskId); return { status: r.error ? 409 : 200, body: r }; }
  if (method === 'POST' && pathname === '/api/cloud/cancel') { const r = await cancel(body.sessionId, body.taskId); return { status: r.error ? 409 : 200, body: r }; }
  return null;
}

function init(d) {
  deps = d;
  const { ipcMain } = d;
  ipcMain.handle('cloud:state', (e, cwd) => refreshRemote(cwd));
  ipcMain.handle('cloud:setup', (e, cwd, opts) => setup(cwd, opts || {}));
  ipcMain.handle('cloud:env', (e, cwd, envText) => setEnv(cwd, envText));
  ipcMain.handle('cloud:checkBehind', (e, cwd) => checkBehind(cwd));
  ipcMain.handle('cloud:pull', (e, cwd, sessionId, taskId) => pull(cwd, sessionId, taskId));
  ipcMain.handle('cloud:options', (e, cwd, opts) => setOptions(cwd, opts));
  ipcMain.handle('cloud:apply', (e, sessionId, taskId) => apply(sessionId, taskId));
  ipcMain.handle('cloud:applyTask', (e, cwd, taskId) => applyTask(cwd, taskId));
  ipcMain.handle('cloud:cancel', (e, sessionId, taskId) => cancel(sessionId, taskId));
  ipcMain.handle('cloud:backupNow', async (e, cwd) => {
    try {
      const c = await lib();
      const p = c.getProject(cwd);
      if (p && p.kind === 'repo') return { error: 'This project works in its own GitHub repo, so there is no copy to back up.' };
      const r = await c.pushSnapshot({ cwd, token: githubToken() });
      return { ok: true, pushed: r.pushed, skipped: r.skipped, state: await state(cwd) };
    } catch (err) { return { error: err.message }; }
  });
  lib().then(resume).catch((e) => console.warn('[cloud] not available:', e.message));
}

module.exports = { init, wants, startFromChat, afterLocalRun, bridge };
