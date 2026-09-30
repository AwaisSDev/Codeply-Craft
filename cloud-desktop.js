// Craft Cloud in the desktop app: the main-process side.
//
// A project with the Cloud chip on sends each new message to GitHub Actions
// (codeply-cli/lib/cloud.mjs) instead of running it on this PC. The chat gets
// a cloud card that this file keeps up to date by polling GitHub, and the
// finished answer as a normal reply. Code changes stay on the mirror until the
// user clicks Apply, which lands them as a checkpoint so Undo works as usual.
//
// After every local run the project is backed up to its mirror (auto-backup),
// so a cloud run started later from the phone sees the latest code.
//
// main.js wires this in with init(deps); everything it needs from main.js is
// passed in, so nothing here reaches into main.js state directly.
const path = require('path');
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
  return {
    github: { connected: !!gh.accessToken, userName: gh.userName || '', scopesOk: await githubScopesOk() },
    model: { name: model ? (model.name || model.model) : 'Auto', ok: !modelCheck.error, error: modelCheck.error || null },
    project: p && p.repo ? {
      repo: p.repo, url: `https://github.com/${p.repo}`, cloudOn: !!p.cloudOn, autoBackup: p.autoBackup !== false,
      modelName: p.modelName || '', lastPush: p.lastPush ? { at: p.lastPush.at, skipped: p.lastPush.skipped || [] } : null,
      tasks: (p.tasks || []).slice(0, 20).map(taskView),
    } : null,
  };
}

function taskView(t) {
  const r = t.result || {};
  return {
    id: t.id, status: t.status, prompt: t.prompt, mode: t.mode, repo: t.repo, runUrl: t.runUrl || null,
    progress: t.progress || '', error: t.error || null, startedAt: t.startedAt, finishedAt: t.finishedAt || null,
    files: r.files || [], branch: r.branch || null, answer: r.answer || '', pulledAt: t.pulledAt || null, conflicts: t.conflicts || [],
    remote: !!t.remote,
  };
}

async function setup(cwd) {
  if (!cwd) return { error: 'Pick a project folder first.' };
  if (!githubToken()) return { error: 'Connect GitHub first.', needsGithub: true };
  if (!(await githubScopesOk())) return { error: 'Reconnect GitHub so Craft may create private repos and workflow files.', needsGithub: true };
  const c = await lib();
  const model = deps.configLib().getSelectedModel();
  const check = c.cloudModelConfig(model);
  if (check.error) return { error: check.error, needsModel: true };
  try {
    const r = await c.setupCloud({ cwd, token: githubToken(), model });
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

/** True when main.js should hand this message to the cloud. Sync on purpose: startChatRun calls it inline. */
function wants(cwd) {
  if (!cl || !cwd) return false;
  const p = cl.getProject(cwd);
  return !!(p && p.repo && p.cloudOn);
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
  const card = { kind: 'cloud_task', task: { id: pendingId, status: 'starting', prompt: text, mode, progress: 'Backing up the project and starting a GitHub runner...' }, at: Date.now() };
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
      const task = await c.startCloudRun({ cwd, token, prompt: text, mode, sessionId: session.id, model });
      card.task = taskView(task);
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
    try {
      const c = await lib();
      task = await c.cloudRunStatus({ cwd, taskId, token: githubToken() });
    } catch (e) {
      // Offline or GitHub hiccup: keep trying, a little slower.
      poll(sessionId, cwd, taskId, attempt + 12);
      return;
    }
    const before = card.task.status + (card.task.progress || '');
    card.task = taskView(task);
    if (TERMINAL.has(task.status)) {
      finish(session, card, task);
      return;
    }
    if (before !== card.task.status + (card.task.progress || '')) { deps.persist(session); emitCard(session, card); }
    poll(sessionId, cwd, taskId, attempt + 1);
  }, wait));
}

function finish(session, card, task) {
  const r = task.result || {};
  if (task.status === 'done' && r.answer) {
    session.messages.push({ kind: 'assistant', text: r.answer, at: Date.now() });
    deps.sendEvent(session.id, { type: 'text', text: r.answer, interim: false });
  } else if (task.status !== 'done') {
    const text = task.error ? `The cloud run failed: ${task.error}` : 'The cloud run was cancelled.';
    session.messages.push({ kind: 'notice', level: task.status === 'cancelled' ? 'info' : 'error', text, at: Date.now() });
  }
  session.updatedAt = Date.now();
  deps.persist(session);
  emitCard(session, card);
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
    card.task = taskView(c.getTask(cwd, taskId) || { ...card.task, pulledAt: Date.now() });
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
  if (!p || !p.repo || p.autoBackup === false || !githubToken()) return;
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
  if (method === 'POST' && pathname === '/api/cloud/setup') { const r = await setup(body.cwd); return { status: r.error ? 400 : 200, body: r }; }
  if (method === 'POST' && pathname === '/api/cloud/options') { const r = await setOptions(body.cwd, body); return { status: r.error ? 400 : 200, body: r }; }
  if (method === 'POST' && pathname === '/api/cloud/apply') { const r = body.sessionId ? await apply(body.sessionId, body.taskId) : await applyTask(body.cwd, body.taskId); return { status: r.error ? 409 : 200, body: r }; }
  if (method === 'POST' && pathname === '/api/cloud/cancel') { const r = await cancel(body.sessionId, body.taskId); return { status: r.error ? 409 : 200, body: r }; }
  return null;
}

function init(d) {
  deps = d;
  const { ipcMain } = d;
  ipcMain.handle('cloud:state', (e, cwd) => refreshRemote(cwd));
  ipcMain.handle('cloud:setup', (e, cwd) => setup(cwd));
  ipcMain.handle('cloud:options', (e, cwd, opts) => setOptions(cwd, opts));
  ipcMain.handle('cloud:apply', (e, sessionId, taskId) => apply(sessionId, taskId));
  ipcMain.handle('cloud:applyTask', (e, cwd, taskId) => applyTask(cwd, taskId));
  ipcMain.handle('cloud:cancel', (e, sessionId, taskId) => cancel(sessionId, taskId));
  ipcMain.handle('cloud:backupNow', async (e, cwd) => {
    try { const c = await lib(); const r = await c.pushSnapshot({ cwd, token: githubToken() }); return { ok: true, pushed: r.pushed, skipped: r.skipped, state: await state(cwd) }; }
    catch (err) { return { error: err.message }; }
  });
  lib().then(resume).catch((e) => console.warn('[cloud] not available:', e.message));
}

module.exports = { init, wants, startFromChat, afterLocalRun, bridge };
