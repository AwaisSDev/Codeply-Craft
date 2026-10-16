// Local <-> cloud handoff in the desktop app: the main-process side.
//
// A Build run in a project with Craft Cloud set up is protected (unless the
// project's "Keep going in the cloud if this PC turns off" switch is off):
//   - the run's lease lives in Supabase (run_leases); this file renews it
//   - the working tree and the run's state go to craft/wip-<chat> a moment
//     after every step that can change files, and every 20 s
//   - lost connection for 40 s: the run stops here (the cloud may take over at
//     60 s), unless the model is local and keeps working offline, which only
//     shows the orange "offline" warning
//   - back online, or Craft started again after a power cut: the chat comes
//     back. Nobody took over: it carries on here. The cloud took over: it is
//     asked to stop between steps, its steps land in the chat, its changes are
//     merged into the files here as one checkpoint, and the run carries on here.
//
// The engine side is codeply-cli/lib/handoff.mjs; the server side is
// supabase/handoff.sql and supabase/functions/handoff-watchdog.
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const RECOVER_MS = 15000;
const HANDBACK_WAIT_MS = 15 * 60 * 1000;
const NO_START_MS = 5 * 60 * 1000;

let deps = null;
let ho = null;   // handoff.mjs
let cl = null;   // cloud.mjs
const runs = new Map();        // sessionId -> live protected run
const recovering = new Set();  // sessionIds being brought back
let savedTokenHash = null;
let recoverTimer = null;

async function libs() {
  if (!(await deps.ensureEngine())) throw new Error('Engine not available.');
  if (!ho) ho = await import(pathToFileURL(path.join(deps.cliDir, 'lib', 'handoff.mjs')).href);
  if (!cl) cl = await import(pathToFileURL(path.join(deps.cliDir, 'lib', 'cloud.mjs')).href);
  return { ho, cl };
}

const db = () => deps.supabase();

/** run_leases through the RPCs in supabase/handoff.sql. A network failure throws. */
const store = {
  async begin(row) {
    const { data, error } = await db().rpc('handoff_begin', {
      p_session_id: row.sessionId, p_device_id: deps.deviceId(), p_device_name: deps.deviceName(), p_repo: row.repo, p_base: row.base,
      p_kind: row.kind, p_project_name: row.projectName, p_mode: row.mode, p_wip_sha: row.wipSha, p_takeover: !!row.takeover,
    });
    if (error) return { error: error.message };
    return { epoch: data };
  },
  async beat({ sessionId, epoch, wipSha }) {
    const { data, error } = await db().rpc('handoff_beat', { p_session_id: sessionId, p_epoch: epoch, p_wip_sha: wipSha || null });
    if (error) throw new Error(error.message);
    const row = Array.isArray(data) ? data[0] : data;
    return { ok: !!row && row.holder === 'pc' && row.epoch === epoch && row.state === 'running', row };
  },
  async end({ sessionId, epoch, state }) {
    const { error } = await db().rpc('handoff_end', { p_session_id: sessionId, p_epoch: epoch, p_state: state });
    if (error) throw new Error(error.message);
  },
  async get(sessionId) {
    const { data, error } = await db().from('run_leases').select('*').eq('session_id', sessionId).maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  },
};

/** Is this project's switch on? On by default once Craft Cloud is set up. */
function enabledFor(cwd) {
  if (!cl || !cwd) return false;
  const p = cl.getProject(cwd);
  return !!(p && p.repo && p.handoff !== false && deps.githubToken());
}

/** A model on this PC (a local Ollama) keeps working without internet. */
function isLocalModel(route) {
  const m = route && route.custom;
  return !!(m && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(String(m.baseUrl || '')) && !/-cloud$/i.test(String(m.model || '')));
}

function emit(session, status, extra = {}) {
  deps.sendEvent(session.id, { type: 'handoff', status, ...extra });
}

function note(session, text, level = 'info') {
  session.messages.push({ kind: 'notice', level, text, at: Date.now() });
  deps.sendEvent(session.id, { type: 'notice', level, text });
}

const clock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * Keep the user's GitHub connection where the watchdog can use it, unless the
 * Codeply GitHub App covers the repo. Once per token per app start.
 */
async function ensureAccess(repo) {
  const token = deps.githubToken();
  if (!token) return;
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  if (savedTokenHash === hash) return;
  const app = await appInstalled(repo).catch(() => false);
  if (app) { await db().rpc('handoff_forget_token').catch(() => {}); savedTokenHash = hash; return; }
  const { error } = await db().rpc('handoff_save_token', { p_token: token });
  if (!error) savedTokenHash = hash;
}

/** Whether the Codeply GitHub App is installed on a repo (asked of the watchdog). */
async function appInstalled(repo) {
  const { data, error } = await db().functions.invoke('handoff-watchdog', { body: { action: 'app', repo } });
  if (error) return false;
  return !!(data && data.installed);
}

/**
 * Called by startChatRun once the run is registered. `resume` is the state
 * to carry on from (the chat came back from the cloud or from a pause).
 */
function begin(session, { mode, userMessage, history, roleId, route, resume = null, takeover = false }) {
  if (mode !== 'Build' || !cl || !enabledFor(session.cwd)) return;
  const cwd = session.cwd;
  const p = cl.getProject(cwd);
  const state = resume ? { ...resume, side: 'pc' } : ho.newRunState({ sessionId: session.id, mode, userMessage, history, roleId });
  const run = {
    session, cwd, repo: p.repo, state, wipSha: (session.handoff && session.handoff.wipSha) || null, lease: null,
    pushing: false, again: false, debounce: null, every: null, ended: false, startedAt: Date.now(), local: isLocalModel(route),
  };
  runs.set(session.id, run);
  session.handoff = { status: 'starting', wipSha: run.wipSha, at: Date.now(), state };
  (async () => {
    try {
      await cl.ensureHandoffReady({ cwd, token: deps.githubToken() });
      await ensureAccess(p.repo).catch(() => {});
      if (run.ended) return;
      // The lease first: if the cloud claimed this chat a moment ago, this side must not edit.
      run.lease = ho.makeLease({
        store, sessionId: session.id, keepGoingOffline: run.local,
        onFence: (why) => fenced(run, why),
        onOffline: (off) => emit(session, off ? (run.local ? 'offline_local' : 'offline') : 'protected', { savedAt: run.savedAt || null, since: run.savedAt || run.startedAt }),
      });
      let epoch;
      try {
        epoch = await run.lease.start({ repo: p.repo, base: p.base || 'main', kind: p.kind || 'mirror', projectName: path.basename(cwd), mode, wipSha: run.wipSha, takeover });
      } catch (e) {
        if (/cloud holds/i.test(e.message)) { session.handoff = { ...session.handoff, epoch: null }; fenced(run, 'taken'); return; }
        throw e;
      }
      // The first push of a run starts the chain again, so it may replace an older one.
      const w = await ho.pushWip({ cwd, token: deps.githubToken(), repo: p.repo, sessionId: session.id, state: run.state, parent: run.wipSha, force: true });
      run.wipSha = w.sha;
      run.lease.saved(w.sha);
      await run.lease.beat();
      if (run.ended) return;
      run.savedAt = Date.now();
      session.handoff = { status: 'running', epoch, wipSha: w.sha, at: Date.now(), state: run.state, since: run.startedAt };
      deps.persist(session);
      run.every = setInterval(() => push(run), ho.WIP_EVERY_MS);
      emit(session, 'protected', { savedAt: run.savedAt });
    } catch (e) {
      console.warn('[handoff] could not protect this run:', e.message);
      runs.delete(session.id);
      session.handoff = null;
      emit(session, 'off');
    }
  })();
}

/** Every agent event of a protected run: record it, and push soon after a step that can change files. */
function see(session, ev) {
  const run = runs.get(session.id);
  if (!run || run.ended || !ho) return;
  if (ho.recordEvent(run.state, ev)) {
    clearTimeout(run.debounce);
    run.debounce = setTimeout(() => push(run), ho.WIP_DEBOUNCE_MS);
  }
}

async function push(run) {
  if (run.ended || !run.lease || run.fenced) return;
  if (run.pushing) { run.again = true; return; }
  run.pushing = true;
  try {
    const w = await ho.pushWip({ cwd: run.cwd, token: deps.githubToken(), repo: run.repo, sessionId: run.session.id, state: run.state, parent: run.wipSha });
    if (w.pushed) {
      run.wipSha = w.sha;
      run.lease.saved(w.sha);
      run.lease.beat().catch(() => {}); // tell the server where the cloud would start
    }
    run.savedAt = Date.now();
    run.session.handoff = { ...run.session.handoff, wipSha: run.wipSha, state: run.state };
    deps.saveLocal();
    if (!run.lease.offline) emit(run.session, 'protected', { savedAt: run.savedAt });
  } catch (e) {
    // Offline or a non-fast-forward (the cloud holds the chat): the lease decides what happens next.
    console.warn('[handoff] WIP push failed:', e.message);
  } finally {
    run.pushing = false;
    if (run.again && !run.ended) { run.again = false; push(run); }
  }
}

/** This side must stop editing: no renewal for 40 s, or the cloud holds the chat. */
function fenced(run, why) {
  const { session } = run;
  if (run.fenced) return;
  run.fenced = why;
  session.handoff = { ...session.handoff, status: why === 'taken' ? 'cloud' : 'paused', state: run.state, pausedAt: Date.now() };
  note(session, why === 'taken'
    ? 'This PC was offline, so Craft Cloud took over this task. It comes back here when you are online.'
    : 'Lost connection, so this task is paused here. If you stay offline, Craft Cloud carries it on from the last save, and it comes back here when you are online.', 'warn');
  deps.persist(session);
  emit(session, why === 'taken' ? 'cloud' : 'paused');
  deps.stopRun(session.id);
}

/** Called from startChatRun's finally. */
async function end(session, { aborted = false } = {}) {
  const run = runs.get(session.id);
  if (!run) return;
  run.ended = true;
  runs.delete(session.id);
  clearTimeout(run.debounce);
  clearInterval(run.every);
  if (run.fenced) return; // the chat is paused or in the cloud: recovery brings it back
  if (run.lease) { run.lease.stop(); await run.lease.end(aborted ? 'stopped' : 'done'); }
  session.handoff = null;
  deps.persist(session);
  emit(session, 'off');
}

// ─── Bringing a chat back ───────────────────────────────────────────────

/** Chats whose run did not finish here: paused, in the cloud, or cut off by a power cut. */
function pending() {
  return deps.allSessions().filter((s) => s.handoff && !runs.has(s.id) && !deps.isRunning(s.id) && !recovering.has(s.id));
}

async function recoverAll() {
  if (!deps || !(await deps.signedIn())) return;
  try { await libs(); } catch { return; }
  for (const session of pending()) {
    recovering.add(session.id);
    recover(session).catch((e) => console.warn('[handoff] could not bring the chat back:', e.message)).finally(() => recovering.delete(session.id));
  }
}

async function recover(session) {
  const h = session.handoff;
  let row;
  try { row = await store.get(session.id); } catch { return; } // still offline: next time
  if (!row || row.holder === 'none') {
    // Finished or stopped elsewhere (the phone's Stop).
    session.handoff = null; deps.persist(session); emit(session, 'off');
    return;
  }
  if (row.holder === 'pc' && row.state === 'running' && row.epoch === h.epoch) {
    // Nobody took over: carry on here from where this PC stopped.
    note(session, h.status === 'paused' ? 'Back online. Carrying on.' : 'Craft closed in the middle of this task. Carrying on from the last save.');
    return resumeHere(session, h.state, false);
  }
  if (row.state === 'no_credentials' || row.state === 'cloud_failed') {
    note(session, `${row.note || 'Craft Cloud could not take over.'} Carrying on here.`, 'warn');
    return resumeHere(session, h.state, true);
  }
  if (row.holder === 'cloud') return handBack(session, row);
  // A newer run (here or on another of this account's PCs) has the chat now.
  session.handoff = null; deps.persist(session); emit(session, 'off');
}

function resumeHere(session, state, takeover) {
  session.handoff = { ...session.handoff, status: 'resuming' };
  if (!state) { session.handoff = null; deps.persist(session); emit(session, 'off'); return null; }
  return deps.resumeRun(session, {
    prompt: ho.continuationPrompt(state, state.side === 'cloud' ? 'pc' : 'self'),
    history: state.history || [],
    todos: state.todos || [],
    mode: state.mode || 'Build',
    state,
    takeover,
  });
}

/** Ask the cloud for the chat back, bring its steps and changes here, carry on. */
async function handBack(session, row) {
  const token = deps.githubToken();
  if (!token) { note(session, 'Craft Cloud has this task, but GitHub is not connected here any more. Reconnect it in Connect Apps to bring it back.', 'warn'); return; }
  const api = cl.githubApi({ token });
  const files = cl.branchFiles(api, row.repo);
  const sid = session.id;
  session.handoff = { ...session.handoff, status: 'returning' };
  emit(session, 'returning');
  if (!(await files.read(ho.HANDBACK.want(sid)).catch(() => null))) {
    await files.write(ho.HANDBACK.want(sid), { device: deps.deviceId(), at: Date.now(), taskId: row.cloud_task_id }, `Craft hand-back ${sid}`);
  }
  const t0 = Date.now();
  let done = null; let doc = null;
  while (Date.now() - t0 < HANDBACK_WAIT_MS) {
    const f = await files.read(ho.HANDBACK.done(sid)).catch(() => null);
    if (f && f.json && (!row.cloud_task_id || f.json.taskId === row.cloud_task_id)) { done = { ...f.json, fileSha: f.sha }; break; }
    doc = await cl.readTaskDoc(api, row.repo, row.cloud_task_id).catch(() => null);
    if (!doc && Date.now() - t0 > NO_START_MS) break; // the cloud run never started
    await new Promise((r) => setTimeout(r, 5000));
  }
  doc = await cl.readTaskDoc(api, row.repo, row.cloud_task_id).catch(() => doc);

  const events = (doc && doc.events) || [];
  const steps = events.filter((e) => e.t === 'tool').length;
  const wentAt = session.handoff.pausedAt || session.handoff.at || Date.now();
  note(session, `Your PC went offline at ${clock(wentAt)}. Craft Cloud carried on: ${steps} step${steps === 1 ? '' : 's'}.`);
  try { await deps.replay(session, { id: row.cloud_task_id, repo: row.repo }, events); } catch (e) { console.warn('[handoff] replay failed:', e.message); }

  let state = session.handoff.state;
  if (done) {
    const snap = deps.snapshotLib();
    let beforeTree = null;
    try { if (snap) beforeTree = await snap.track(session.cwd); } catch {}
    try {
      const r = await ho.applyWip({ cwd: session.cwd, token, repo: row.repo, sessionId: sid, fromSha: row.cloud_from_sha });
      if (r.state) state = r.state;
      session.handoff.wipSha = r.toSha;
      if (beforeTree && snap) {
        const afterTree = await snap.track(session.cwd);
        const changes = await snap.changedFiles(session.cwd, beforeTree, afterTree);
        if (changes.length) {
          const checkpoint = { kind: 'checkpoint', id: `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, beforeTree, afterTree, cwd: session.cwd, files: changes.slice(0, 200), total: changes.length, undone: false, at: Date.now() };
          session.messages.push(checkpoint);
          deps.sendEvent(sid, { type: 'checkpoint', checkpoint: deps.checkpointView(checkpoint) });
        }
      }
      if (r.conflicts.length) note(session, `The cloud and this PC changed the same lines in ${r.conflicts.join(', ')}. Look for <<<<<<< markers there.`, 'warn');
    } catch (e) {
      note(session, `Could not bring the cloud's changes here: ${e.message}. They are on the ${ho.wipBranch(sid)} branch of ${row.repo}.`, 'error');
    }
    await files.remove(ho.HANDBACK.done(sid), done.fileSha).catch(() => {});
  } else {
    note(session, 'Craft Cloud did not answer, so this PC carries on from its own last save.', 'warn');
    await files.remove(ho.HANDBACK.want(sid)).catch(() => {});
  }

  if (done && done.status === 'done') {
    if (doc && doc.answer) {
      session.messages.push({ kind: 'assistant', text: doc.answer, at: Date.now() });
      deps.sendEvent(sid, { type: 'text', text: doc.answer, interim: false });
    }
    await store.end({ sessionId: sid, epoch: row.epoch, state: 'handed_back' }).catch(() => {});
    session.handoff = null;
    session.updatedAt = Date.now();
    deps.persist(session);
    emit(session, 'back');
    deps.sendEvent(sid, { type: 'session_sync', session: deps.sessionMeta(session) });
    deps.notify(session);
    return null;
  }
  note(session, 'Back on this PC. Carrying on.');
  return resumeHere(session, state, true);
}

/** For the renderer and the phone: the chat's handoff status, if any. */
function statusOf(sessionId) {
  const run = runs.get(sessionId);
  if (run) return { status: run.lease ? (run.lease.offline ? (run.local ? 'offline_local' : 'offline') : 'protected') : 'starting', savedAt: run.savedAt || null };
  const s = deps.findSession(sessionId);
  return s && s.handoff ? { status: s.handoff.status } : { status: 'off' };
}

function init(d) {
  deps = d;
  d.ipcMain.handle('handoff:status', (e, sessionId) => statusOf(sessionId));
  d.ipcMain.handle('handoff:appInstalled', async (e, repo) => { try { await libs(); return await appInstalled(repo); } catch { return false; } });
  libs().catch(() => {});
  clearInterval(recoverTimer);
  recoverTimer = setInterval(() => recoverAll(), RECOVER_MS);
}

module.exports = { init, begin, see, end, recoverAll, statusOf, isLocalModel };
