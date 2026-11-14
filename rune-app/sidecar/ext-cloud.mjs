// One Codeply across this PC, the phone, the web and the cloud: the Electron app's account-side
// features for the Rune app's engine. Four parts, each safe to run signed out or offline (a part
// that can't reach the account stays quiet and tries again, it never throws into the engine):
//
//   1. Sync        specialists (the team) and standing jobs, both ways, through the account's
//                  `specialists` / `specialist_jobs` tables (specialists-sync.js; supabase/specialists.sql).
//                  At launch, after sign-in, every 2 minutes, and a moment after a local change.
//                  Other agents use it through ctx.shared.sync: claim(job), recordRun(job, ...).
//   2. The phone   what main.js serves the phone and the web with: the Supabase Realtime relay
//                  (channel craft-<user>-<secret>) and the same-network server on port 45671, both only
//                  for a phone signed in as this PC's account, running the same /api/* bridge on this
//                  engine's chats (bootstrap, session, send, stop, approvals, models, cloud, team).
//   3. Cloud       the per-project Craft Cloud switch: a message in a project with it on runs on GitHub
//                  Actions (cloud-desktop.js), its steps and its finished answer come back as chat rows.
//   4. Handoff     a local run is protected: its lease is renewed in the account, the working tree is
//                  snapshotted to craft/wip-<chat>, the cloud takes over when this PC goes away and
//                  hands back when it returns (handoff-desktop.js; codeply-cli/lib/handoff.mjs).
//
// Routes (for the app): GET /ext/cloud, POST /ext/cloud/{sync,setup,options,apply,cancel,pull,answer},
// GET /ext/cloud/handoff. Events it emits: handoff, cloud_task, team_changed.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';

let C = null;
const LAN_PORT = 45671;
const MOBILE_APP_URL = process.env.CRAFT_MOBILE_URL || 'https://mobile.codeply.app';
const note = (...a) => console.warn('[cloud]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms) => Promise.race([Promise.resolve(p), new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), ms))]);
const iso = (t) => new Date(t || Date.now()).toISOString();
const ms = (t) => (t ? Date.parse(t) || 0 : 0);

// ---------- the account ----------
const authLib = () => { try { return C.need('auth.js'); } catch { return null; } };
const sb = () => { const a = authLib(); return a ? a.getClient() : null; };
let acct = { at: 0, v: null };
/** The signed-in account ({ id, email }) or null. Cached for a few seconds; never throws, never hangs. */
async function account(fresh = false) {
  if (!fresh && Date.now() - acct.at < 4000) return acct.v;
  let v = null;
  try {
    const a = authLib();
    const s = a ? await withTimeout(a.getSession(), 9000) : null;
    if (s && s.user) v = { id: s.user.id, email: s.user.email || '' };
  } catch { /* offline or no auth: signed out for now */ }
  acct = { at: Date.now(), v };
  return v;
}
const userId = async () => { const a = await account(); return a ? a.id : null; };

let deviceIdCache = null;
function deviceId() {
  if (deviceIdCache) return deviceIdCache;
  const file = path.join(C.DATA, 'cloud-device.json');
  try { deviceIdCache = JSON.parse(fs.readFileSync(file, 'utf8')).id; } catch { /* first run */ }
  if (!deviceIdCache) {
    deviceIdCache = `d_${crypto.randomBytes(8).toString('hex')}`;
    try { fs.writeFileSync(file, JSON.stringify({ id: deviceIdCache })); } catch { /* kept in memory */ }
  }
  return deviceIdCache;
}

const githubToken = () => { try { const gh = C.need('config.js').getIntegration('github'); return gh && gh.accessToken ? gh.accessToken : null; } catch { return null; } };
const githubInfo = () => { try { return C.need('config.js').getIntegration('github') || {}; } catch { return {}; } };

let clMod = null; let hoMod = null;
async function cloudLib() { if (!clMod) clMod = await C.lib('cloud.mjs'); return clMod; }
async function handoffLib() { if (!hoMod) hoMod = await C.lib('handoff.mjs'); return hoMod; }
/** cloud.mjs and handoff.mjs, or null when this engine can't load them (the routes then say so). */
async function libsOrNull() { try { return { cl: await cloudLib(), ho: await handoffLib() }; } catch (e) { note('cloud libs unavailable:', e.message); return null; } }

// =====================================================================================
// 1. Sync: specialists and standing jobs (specialists-sync.js)
// =====================================================================================
const sync = (() => {
  let offUntil = 0; let lastError = ''; let lastSync = 0; let running = null; let soonTimer = null; let cloudRuns = [];
  const missingTable = (msg) => /does not exist|could not find the table|schema cache|relation .* does not exist/i.test(String(msg || ''));
  const stateFile = () => path.join(C.DATA, 'specialists-sync.json');
  const loadState = () => { try { return { known: { spec: [], job: [] }, ...JSON.parse(fs.readFileSync(stateFile(), 'utf8')) }; } catch { return { known: { spec: [], job: [] } }; } };
  const saveState = (s) => { try { fs.writeFileSync(stateFile(), JSON.stringify(s)); } catch { /* next time */ } };
  const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } })();
  const wisp = () => C.need('wisp.js');

  async function acc() {
    if (Date.now() < offUntil) return null;
    const a = await account();
    const c = a ? sb() : null;
    return c && a ? { c, uid: a.id } : null;
  }
  function fail(err) {
    lastError = String((err && err.message) || err || '');
    if (missingTable(lastError)) { offUntil = Date.now() + 5 * 60000; lastError = 'setup'; } else offUntil = Date.now() + 30000;
  }

  /** Newer side wins. local: Map id -> { stamp, value }; remote: rows. Returns { take, drop, push }. */
  function merge(local, remote, known) {
    const out = { take: [], drop: [], push: [] };
    const rmap = new Map(remote.map((r) => [r.id, r]));
    for (const id of new Set([...local.keys(), ...rmap.keys()])) {
      const l = local.get(id); const r = rmap.get(id);
      const lt = l ? l.stamp : 0; const rt = r ? ms(r.updated_at) : 0;
      if (r && r.deleted) {
        if (l && lt > rt + 1000) out.push.push({ id, value: l.value });
        else if (l) out.drop.push(id);
        continue;
      }
      if (r && !l) {
        if (known.has(id)) out.push.push({ id, deleted: true }); // removed on this PC
        else out.take.push([id, r.data]);
        continue;
      }
      if (l && !r) { out.push.push({ id, value: l.value }); continue; }
      if (lt > rt + 1000) out.push.push({ id, value: l.value });
      else if (rt > lt + 1000) out.take.push([id, r.data]);
    }
    return out;
  }

  async function syncOnce() {
    const a = await acc();
    if (!a) return { ok: false };
    const W = wisp(); const S = W.store;
    const st = loadState();
    let changed = false;
    const [{ data: specRows, error: e1 }, { data: jobRows, error: e2 }] = await Promise.all([
      a.c.from('specialists').select('id, data, always_on, deleted, updated_at'),
      a.c.from('specialist_jobs').select('id, specialist, data, next_at, claimed_by, claimed_until, deleted, updated_at'),
    ]);
    if (e1 || e2) { fail(e1 || e2); return { ok: false }; }

    const custom = S.loadCustom(); const builtinSet = S.loadBuiltinSettings();
    const team = W.listSpecialists();
    const local = new Map();
    for (const s of custom) {
      const { history, ...value } = s;
      local.set(s.id, { stamp: s.updatedAt || s.createdAt || 0, value: { ...value, history: (history || []).slice(-8) } });
    }
    for (const b of team.filter((x) => x.builtin)) {
      const own = builtinSet[b.id] || {}; const d = W.detail(b);
      local.set(`builtin:${b.id}`, { stamp: own.updatedAt || 1, value: { builtin: true, name: b.name, focus: b.focus, shape: b.shape, color: b.color, gear: b.gear, voice: b.voice || '', instructions: d.guide || '', notes: own.notes || '', model: own.model || 'auto', alwaysOn: !!own.alwaysOn, updatedAt: own.updatedAt || 1 } });
    }
    const sm = merge(local, specRows || [], new Set(st.known.spec));
    if (sm.take.length || sm.drop.length) {
      let list = custom.slice();
      for (const id of sm.drop) list = list.filter((s) => s.id !== id);
      for (const [id, data] of sm.take) {
        if (id.startsWith('builtin:')) {
          const bid = id.slice(8);
          builtinSet[bid] = { ...(builtinSet[bid] || {}), model: data.model || 'auto', notes: data.notes || '', alwaysOn: !!data.alwaysOn, updatedAt: data.updatedAt || Date.now() };
          continue;
        }
        if (!data || !data.name) continue;
        const i = list.findIndex((s) => s.id === id);
        const prev = i >= 0 ? list[i] : {};
        const next = { ...prev, ...data, id, history: prev.history || data.history || [], uses: Math.max(prev.uses || 0, data.uses || 0) };
        if (i >= 0) list[i] = next; else list.push(next);
      }
      S.saveCustom(list); S.saveBuiltinSettings(builtinSet);
      changed = true;
    }
    if (sm.push.length) {
      const rows = sm.push.map((p) => ({
        user_id: a.uid, id: p.id, data: p.value || {}, always_on: !!(p.value && p.value.alwaysOn), deleted: !!p.deleted,
        updated_at: iso(p.deleted ? Date.now() : (p.value.updatedAt || p.value.createdAt || 1)),
      }));
      const { error } = await a.c.from('specialists').upsert(rows);
      if (error) { fail(error); return { ok: false }; }
    }

    const jobs = S.loadSchedules();
    const jlocal = new Map(jobs.map((j) => [j.id, { stamp: j.updatedAt || j.createdAt || 0, value: { tz: TZ, ...j } }]));
    const jm = merge(jlocal, jobRows || [], new Set(st.known.job));
    if (jm.take.length || jm.drop.length) {
      let list = jobs.slice();
      for (const id of jm.drop) list = list.filter((j) => j.id !== id);
      for (const [id, data] of jm.take) {
        if (!data || !data.specialist) continue;
        const i = list.findIndex((j) => j.id === id);
        const next = { ...(i >= 0 ? list[i] : {}), ...data, id };
        if (i >= 0) list[i] = next; else list.push(next);
      }
      S.saveSchedules(list);
      changed = true;
    }
    if (jm.push.length) {
      const rows = jm.push.map((p) => ({
        user_id: a.uid, id: p.id, specialist: p.value ? p.value.specialist : '', data: p.value || {},
        next_at: p.value && p.value.nextAt ? iso(p.value.nextAt) : null, deleted: !!p.deleted || !(p.value && p.value.nextAt),
        updated_at: iso(p.deleted ? Date.now() : (p.value.updatedAt || p.value.createdAt || 1)),
        ...(p.value && p.value.lastAt && p.value.lastAt >= (p.value.updatedAt || 0) - 5000 ? { claimed_by: null, claimed_until: null } : {}),
      }));
      for (const r of rows) if (!r.specialist) r.specialist = ((jobRows || []).find((x) => x.id === r.id) || {}).specialist || '?';
      const { error } = await a.c.from('specialist_jobs').upsert(rows);
      if (error) { fail(error); return { ok: false }; }
    }

    const { data: runs } = await a.c.from('specialist_runs').select('id, job_id, specialist, task, output, ok, origin, at').neq('origin', 'pc').order('at', { ascending: false }).limit(40);
    if (Array.isArray(runs)) cloudRuns = runs.filter((r) => r.job_id !== 'chat');

    st.known.spec = [...new Set([...S.loadCustom().map((s) => s.id), ...team.filter((x) => x.builtin).map((b) => `builtin:${b.id}`)])];
    st.known.job = S.loadSchedules().map((j) => j.id);
    saveState(st);
    lastSync = Date.now(); lastError = '';
    if (changed) C.emit(null, { type: 'team_changed' });
    return { ok: true, changed };
  }

  function syncNow() {
    if (!running) running = syncOnce().catch((e) => { fail(e); return { ok: false }; }).finally(() => { running = null; });
    return running;
  }
  function syncSoon(wait = 1500) {
    clearTimeout(soonTimer);
    soonTimer = setTimeout(() => { syncNow(); }, wait);
    if (soonTimer.unref) soonTimer.unref();
  }
  /** This PC is about to run a standing job: claim the run in the account. true = go ahead (also offline or signed out). */
  async function claim(job) {
    const a = await acc();
    if (!a) return true;
    const now = Date.now();
    try {
      const { data, error } = await a.c.from('specialist_jobs')
        .update({ claimed_by: deviceId(), claimed_until: iso(now + 15 * 60000) })
        .eq('id', job.id).lte('next_at', iso(now + 60000))
        .or(`claimed_until.is.null,claimed_until.lt.${iso(now)},claimed_by.eq.${deviceId()}`)
        .select('id');
      if (error) { fail(error); return true; }
      if (Array.isArray(data) && data.length) return true;
    } catch (e) { fail(e); return true; }
    syncSoon(200);
    return false;
  }
  async function recordRun(job, { ok = true, output = '' } = {}) {
    const a = await acc();
    if (!a) return;
    await a.c.from('specialist_runs').insert({ user_id: a.uid, job_id: job.id, specialist: job.specialist, task: String(job.task || '').slice(0, 2000), output: String(output || '').slice(0, 20000), ok, origin: 'pc' }).then(() => {}, () => {});
  }
  function status() {
    if (lastError === 'setup') return { state: 'setup' };
    if (lastSync) return { state: 'on', at: lastSync };
    return { state: lastError ? 'error' : 'waiting', error: lastError };
  }
  // A change on this PC (the files wisp.js keeps) goes up a moment later.
  const watched = () => { const d = process.env.CODEPLY_WISP_DIR || path.join(os.homedir(), '.codeply', 'wisp'); return ['specialists.json', 'builtins.json', 'schedules.json'].map((n) => path.join(d, n)); };
  let stamps = '';
  function watchLocal() {
    let s = '';
    for (const f of watched()) { try { s += `${fs.statSync(f).mtimeMs};`; } catch { s += '0;'; } }
    if (stamps && s !== stamps) syncSoon(1500);
    stamps = s;
  }
  return { syncNow, syncSoon, claim, recordRun, status, runs: () => cloudRuns, watchLocal, TZ };
})();

// =====================================================================================
// 3. Craft Cloud: runs on GitHub Actions (cloud-desktop.js)
// =====================================================================================
const TERMINAL = new Set(['done', 'failed', 'cancelled']);
const pollers = new Map(); // taskId -> timeout
const backupTimers = new Map();
const backingUp = new Set();
const cardOf = (session, taskId) => session.messages.find((m) => m.kind === 'cloud_task' && m.task && m.task.id === taskId);
const emitCard = (session, card) => C.emit(session.id, { type: 'cloud_task', task: card.task });
const persist = () => C.api.save();
const isRunning = (id) => C.api.runs.has(id);

function taskView(t, p) {
  const r = t.result || {};
  return {
    id: t.id, status: t.status, prompt: t.prompt, mode: t.mode, repo: t.repo, runUrl: t.runUrl || null,
    progress: t.progress || '', error: t.error || null, startedAt: t.startedAt, finishedAt: t.finishedAt || null,
    files: r.files || [], stats: r.stats || [], branch: r.branch || null, answer: r.answer || '', pulledAt: t.pulledAt || null, conflicts: t.conflicts || [],
    remote: !!t.remote, queued: !!t.queued, ask: t.ask || null,
    kind: t.kind || (p && p.kind === 'repo' ? 'repo' : 'mirror'),
    base: (r.merged && r.merged.base) || (p && p.base) || 'main',
    merged: r.merged || null,
  };
}

function projectRow(cl, cwd) {
  const p = cl ? cl.getProject(cwd) : null;
  const ready = !!(p && p.repo);
  return {
    cwd, name: path.basename(cwd), ready, repo: ready ? p.repo : '', kind: ready && p.kind === 'repo' ? 'repo' : 'mirror', base: (p && p.base) || 'main',
    cloudOn: !!(p && p.cloudOn), handoff: !p || p.handoff !== false, autoBackup: !p || p.autoBackup !== false,
    lastPush: p && p.lastPush ? p.lastPush.at : null,
    tasks: ready ? (p.tasks || []).slice(0, 5).map((t) => taskView(t, p)) : [],
  };
}

/** Folders the app knows (its chats' projects and the default), as projects for the Cloud page. */
function knownFolders() {
  const seen = new Map();
  const add = (cwd) => { if (!cwd) return; const k = path.resolve(cwd).toLowerCase(); if (!seen.has(k) && fs.existsSync(cwd)) seen.set(k, path.resolve(cwd)); };
  const list = [...C.api.sessions()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  for (const s of list) add(s.cwd);
  add(C.DEFAULT_CWD);
  return [...seen.values()];
}

async function cloudState() {
  const libs = await libsOrNull();
  const a = await account();
  const gh = githubInfo();
  const folders = knownFolders();
  return {
    signedIn: !!a, email: a ? a.email : '',
    github: { connected: !!gh.accessToken, userName: gh.userName || '' },
    sync: sync.status(),
    phone: phoneStatus(),
    available: !!libs,
    projects: folders.map((f) => projectRow(libs && libs.cl, f)),
    device: os.hostname(),
  };
}

async function githubScopesOk() {
  const gh = githubInfo();
  if (!gh.accessToken) return false;
  if (typeof gh.scope === 'string' && gh.scope) { const s = gh.scope.split(/[\s,]+/); return s.includes('repo') && s.includes('workflow'); }
  try { const c = await cloudLib(); return (await c.checkToken(c.githubApi({ token: gh.accessToken }))).ok; } catch { return true; }
}

async function setup(cwd, opts = {}) {
  if (!cwd || !fs.existsSync(cwd)) return { error: 'Pick a project folder first.' };
  if (!githubToken()) return { error: 'Connect GitHub first (Settings > Connections).', needsGithub: true };
  if (!(await githubScopesOk())) return { error: 'Reconnect GitHub so Codeply may create private repos and workflow files.', needsGithub: true };
  try {
    const c = await cloudLib();
    const config = C.need('config.js');
    const model = config.getSelectedModel();
    const check = c.cloudModelConfig(model);
    if (check.error) return { error: check.error, needsModel: true };
    const target = opts.target === 'mirror' ? 'mirror' : opts.target === 'repo' ? 'repo' : undefined;
    const r = await c.setupCloud({ cwd, token: githubToken(), model, target });
    c.setProjectOptions(cwd, { cloudOn: true });
    return { ok: true, repo: r && r.repo, state: await cloudState() };
  } catch (e) { return { error: e.message }; }
}

async function setOptions(cwd, opts) {
  try {
    const c = await cloudLib();
    const p = c.getProject(cwd);
    if (!p || !p.repo) return { error: 'Set up the cloud for this project first.', needsSetup: true };
    c.setProjectOptions(cwd, opts || {});
    return { ok: true, state: await cloudState() };
  } catch (e) { return { error: e.message }; }
}

/** The Cloud switch of the chat's project, as the engine's message path asks it. */
async function takeMessage(session, text) {
  let c;
  try { c = await cloudLib(); } catch { return false; }
  const p = c.getProject(session.cwd);
  if (!(p && p.repo && p.cloudOn)) return false;
  if (isRunning(session.id)) return false; // a local run is going: queue it like any message
  startFromChat(session, text, c);
  return true;
}

function startFromChat(session, text, c) {
  const cwd = session.cwd;
  session.messages.push({ kind: 'user', text, at: Date.now() });
  if (session.messages.filter((m) => m.kind === 'user').length === 1 && (!session.title || session.title === 'New chat')) {
    session.title = text.length > 46 ? `${text.slice(0, 46)}...` : text;
  }
  session.updatedAt = Date.now();
  const pendingId = `pending-${Date.now().toString(36)}`;
  const card = { kind: 'cloud_task', task: { id: pendingId, status: 'starting', prompt: text, mode: 'Build', startedAt: Date.now() }, at: Date.now() };
  session.messages.push(card);
  C.api.saveNow();
  C.emit(session.id, { type: 'run_started', session: C.api.meta(session), message: session.messages[session.messages.length - 2] });
  emitCard(session, card);
  C.emit(session.id, { type: 'run_finished' });
  (async () => {
    try {
      const token = githubToken();
      if (!token) throw new Error('GitHub is not connected any more. Reconnect it in Settings > Connections.');
      const model = C.need('config.js').getSelectedModel();
      const task = await c.startCloudRun({ cwd, token, prompt: text, mode: 'Build', sessionId: session.id, model, startedAt: card.task.startedAt });
      card.task = taskView(task, c.getProject(cwd));
      persist(); emitCard(session, card);
      poll(session.id, cwd, task.id, 0);
    } catch (e) {
      card.task = { ...card.task, status: 'failed', error: e.message, progress: '' };
      persist(); emitCard(session, card);
    }
  })();
}

/** A run's step record as chat rows and events, like a local run's. `card.seen` counts what was shown. */
function replay(session, card, events) {
  if (!Array.isArray(events)) return;
  for (let i = card.seen || 0; i < events.length; i++) {
    const e = events[i];
    if (e.t === 'text') {
      session.messages.push({ kind: 'assistant', text: e.text, interim: true, at: Date.now() });
      C.emit(session.id, { type: 'text', text: e.text, interim: true });
    } else if (e.t === 'tool') {
      const label = e.summary || (e.args && (e.args.path || e.args.command || e.args.pattern)) || '';
      session.messages.push({ kind: 'tool', name: e.name, label, ok: e.ok, args: e.args, at: Date.now(), exitCode: e.exitCode, added: e.added, removed: e.removed });
      C.emit(session.id, { type: 'tool_end', name: e.name, args: e.args, ok: e.ok, summary: e.summary, meta: { exitCode: e.exitCode, added: e.added, removed: e.removed } });
    } else if (e.t === 'notice') {
      session.messages.push({ kind: 'notice', level: e.level || 'info', text: e.text, at: Date.now() });
      C.emit(session.id, { type: 'notice', level: e.level || 'info', text: e.text });
    } else if (e.t === 'pushed') {
      const n = (e.files || []).length;
      const text = `Committed ${n} file${n === 1 ? '' : 's'} (+${e.added || 0} -${e.removed || 0}) on ${e.branch}.`;
      session.messages.push({ kind: 'notice', level: 'info', text, at: Date.now() });
      C.emit(session.id, { type: 'notice', level: 'info', text });
    }
    card.seen = i + 1;
  }
}

function poll(sessionId, cwd, taskId, attempt) {
  clearTimeout(pollers.get(taskId));
  const wait = attempt > 120 ? 15000 : 5000;
  const t = setTimeout(async () => {
    pollers.delete(taskId);
    const session = C.api.find(sessionId);
    const card = session && cardOf(session, taskId);
    if (!card) return;
    let task; let c;
    try {
      c = await cloudLib();
      task = await c.cloudRunStatus({ cwd, taskId, token: githubToken() });
    } catch { return poll(sessionId, cwd, taskId, attempt + 12); } // offline or GitHub hiccup: a little slower
    const sig = () => card.task.status + (card.task.progress || '') + (card.seen || 0) + (card.task.ask ? card.task.ask.id : '');
    const before = sig();
    card.task = { ...taskView(task, c.getProject(cwd)), pulledAt: card.task.pulledAt || task.pulledAt || null };
    try { replay(session, card, task.events); } catch (e) { note('replay failed:', e.message); }
    if (TERMINAL.has(task.status)) return finishCloud(session, card, task);
    if (before !== sig()) { persist(); emitCard(session, card); }
    poll(sessionId, cwd, taskId, attempt + 1);
  }, wait);
  pollers.set(taskId, t);
}

function finishCloud(session, card, task) {
  const r = task.result || {};
  if (task.status === 'done' && r.answer) {
    session.messages.push({ kind: 'assistant', text: r.answer, at: Date.now() });
    C.emit(session.id, { type: 'text', text: r.answer, interim: false });
  }
  session.updatedAt = Date.now();
  persist();
  emitCard(session, card);
  C.emit(session.id, { type: 'run_finished' });
  C.emit(session.id, { type: 'session_sync', session: C.api.meta(session) });
}

/** Cards left running when the app closed pick up where they were. */
function resumePolling() {
  for (const session of C.api.sessions()) {
    for (const m of session.messages) {
      if (m.kind === 'cloud_task' && m.task && !TERMINAL.has(m.task.status)) {
        if (String(m.task.id).startsWith('pending-')) { m.task = { ...m.task, status: 'failed', error: 'Codeply closed before the run started.' }; persist(); } else poll(session.id, session.cwd, m.task.id, 0);
      }
    }
  }
}

/** Bring a finished run's changes into the project, as an undoable checkpoint. */
async function applyRun(sessionId, taskId) {
  const session = C.api.find(sessionId);
  if (!session) return { error: 'That chat is gone.' };
  if (isRunning(sessionId)) return { error: 'Wait for the current run to finish first.' };
  try {
    const c = await cloudLib();
    const cwd = session.cwd;
    let snap = null; try { snap = C.need('snapshot.js'); } catch { /* no undo */ }
    let beforeTree = null;
    try { if (snap) beforeTree = await snap.track(cwd); } catch { /* no checkpoint */ }
    await c.cloudRunStatus({ cwd, taskId, token: githubToken() });
    const r = await c.pullCloudRun({ cwd, taskId, token: githubToken() });
    if (r.applied && beforeTree && snap) {
      try {
        const afterTree = await snap.track(cwd);
        const changes = await snap.changedFiles(cwd, beforeTree, afterTree);
        if (changes.length) {
          const checkpoint = { kind: 'checkpoint', id: `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, beforeTree, afterTree, cwd, files: changes.slice(0, 200), total: changes.length, undone: false, at: Date.now() };
          session.messages.push(checkpoint);
          C.emit(session.id, { type: 'checkpoint', checkpoint: { id: checkpoint.id, total: checkpoint.total, files: checkpoint.files } });
        }
      } catch { /* applied, just no checkpoint */ }
    }
    const card = cardOf(session, taskId);
    if (card) { card.task = taskView(c.getTask(cwd, taskId) || { ...card.task, pulledAt: Date.now() }, c.getProject(cwd)); emitCard(session, card); }
    if (r.conflicts && r.conflicts.length) {
      const text = `Applied, with conflicts to resolve in ${r.conflicts.join(', ')} (you changed the same lines while the cloud run worked; look for <<<<<<< markers).`;
      session.messages.push({ kind: 'notice', level: 'warn', text, at: Date.now() });
      C.emit(session.id, { type: 'notice', level: 'warn', text });
    }
    persist();
    if (r.applied) afterLocalRun(cwd);
    return { ok: true, ...r };
  } catch (e) { return { error: e.message }; }
}

async function applyTask(cwd, taskId) {
  try {
    const c = await cloudLib();
    await c.cloudRunStatus({ cwd, taskId, token: githubToken() });
    const r = await c.pullCloudRun({ cwd, taskId, token: githubToken() });
    if (r.applied) afterLocalRun(cwd);
    return { ok: true, ...r, state: await cloudState() };
  } catch (e) { return { error: e.message }; }
}

async function cancelRun(sessionId, taskId) {
  const session = C.api.find(sessionId);
  if (!session) return { error: 'That chat is gone.' };
  try { const c = await cloudLib(); await c.cancelCloudRun({ cwd: session.cwd, taskId, token: githubToken() }); return { ok: true }; } catch (e) { return { error: e.message }; }
}

async function answerAsk(sessionId, taskId, askId, approve) {
  const session = C.api.find(sessionId);
  const card = session && cardOf(session, taskId);
  if (!card) return { error: 'That cloud run is gone.' };
  const token = githubToken();
  if (!token) return { error: 'GitHub is not connected any more. Reconnect it in Settings > Connections.' };
  try {
    const c = await cloudLib();
    await c.answerCloudAsk({ cwd: session.cwd, token, taskId, askId, approve: !!approve });
    card.task = { ...card.task, ask: null };
    persist(); emitCard(session, card);
    return { ok: true };
  } catch (e) { return { error: e.message }; }
}

async function pullProject(cwd) {
  if (!cwd) return { error: 'Pick a project folder first.' };
  try { const c = await cloudLib(); const r = await c.pullLatest(cwd, { token: githubToken() }); return { ok: true, pulled: r.pulled || 0 }; } catch (e) { return { error: e.message }; }
}

async function refreshRemote(cwd) {
  try {
    const c = await cloudLib();
    if (githubToken() && c.getProject(cwd)) await withTimeout(c.importRemoteTasks({ cwd, token: githubToken() }), 20000).catch(() => {});
  } catch { /* offline */ }
  return cloudState();
}

/** After a local run: back a mirror project up quietly, so a cloud run started from the phone sees the latest code. */
function afterLocalRun(cwd) {
  if (!clMod || !cwd) return;
  const p = clMod.getProject(cwd);
  if (!p || !p.repo || p.kind === 'repo' || p.autoBackup === false || !githubToken()) return;
  clearTimeout(backupTimers.get(cwd));
  backupTimers.set(cwd, setTimeout(async () => {
    backupTimers.delete(cwd);
    if (backingUp.has(cwd)) return afterLocalRun(cwd);
    backingUp.add(cwd);
    try { await clMod.pushSnapshot({ cwd, token: githubToken() }); } catch (e) { note('backup failed:', e.message); } finally { backingUp.delete(cwd); }
  }, 3000));
}

// =====================================================================================
// 4. Handoff: a protected local run, the lease, WIP snapshots, hand-back (handoff-desktop.js)
// =====================================================================================
const RECOVER_MS = 15000;
const HANDBACK_WAIT_MS = 15 * 60 * 1000;
const NO_START_MS = 5 * 60 * 1000;
const hruns = new Map();        // sessionId -> live protected run
const recovering = new Set();
const ending = new Map();       // sessionId -> Promise: a lease still closing
let savedTokenHash = null;

const leaseStore = {
  async begin(row) {
    const { data, error } = await sb().rpc('handoff_begin', {
      p_session_id: row.sessionId, p_device_id: deviceId(), p_device_name: os.hostname(), p_repo: row.repo, p_base: row.base,
      p_kind: row.kind, p_project_name: row.projectName, p_mode: row.mode, p_wip_sha: row.wipSha, p_takeover: !!row.takeover,
    });
    if (error) return { error: error.message };
    return { epoch: data };
  },
  async beat({ sessionId, epoch, wipSha }) {
    const { data, error } = await sb().rpc('handoff_beat', { p_session_id: sessionId, p_epoch: epoch, p_wip_sha: wipSha || null });
    if (error) throw new Error(error.message);
    const row = Array.isArray(data) ? data[0] : data;
    return { ok: !!row && row.holder === 'pc' && row.epoch === epoch && row.state === 'running', row };
  },
  async end({ sessionId, epoch, state }) {
    const { error } = await sb().rpc('handoff_end', { p_session_id: sessionId, p_epoch: epoch, p_state: state });
    if (error) throw new Error(error.message);
  },
  async get(sessionId) {
    const { data, error } = await sb().from('run_leases').select('*').eq('session_id', sessionId).maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  },
};

function handoffOn(cwd) {
  if (!clMod || !cwd) return false;
  const p = clMod.getProject(cwd);
  return !!(p && p.repo && p.handoff !== false && githubToken());
}
function isLocalModel(route) {
  const m = route && route.custom;
  return !!(m && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(String(m.baseUrl || '')) && !/-cloud$/i.test(String(m.model || '')));
}
const hEmit = (session, status, extra = {}) => C.emit(session.id, { type: 'handoff', status, ...extra });
function hNote(session, text, level = 'info') {
  session.messages.push({ kind: 'notice', level, text, at: Date.now() });
  C.emit(session.id, { type: 'notice', level, text });
}
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

async function ensureAccess(repo) {
  const token = githubToken();
  if (!token) return;
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  if (savedTokenHash === hash) return;
  const installed = await sb().functions.invoke('handoff-watchdog', { body: { action: 'app', repo } }).then(({ data, error }) => !error && !!(data && data.installed)).catch(() => false);
  if (installed) { await sb().rpc('handoff_forget_token').catch(() => {}); savedTokenHash = hash; return; }
  const { error } = await sb().rpc('handoff_save_token', { p_token: token });
  if (!error) savedTokenHash = hash;
}

/** The chat so far as the model-facing turns the cloud run starts from. */
function historyOf(session) {
  const out = [];
  for (const m of session.messages) {
    if (m.kind === 'user') out.push({ role: 'user', content: m.text });
    else if (m.kind === 'assistant' && !m.interim && m.text) out.push({ role: 'assistant', content: m.text });
  }
  return out.slice(0, -1); // without the message being run now
}

/** DSH's tool names as handoff.mjs knows them: edits and commands are the steps that change files. */
function normalizeStep(ev) {
  if (!ev || ev.type !== 'tool_end') return ev;
  const raw = String(ev.name || '').replace(/^dsh:/, '');
  const a = ev.args && typeof ev.args === 'object' ? ev.args : {};
  const args = { ...a, path: a.path || a.file_path || a.filePath || '', command: a.command || a.cmd || '' };
  let name = raw;
  if (/^(write|create)$/i.test(raw)) name = 'write_file';
  else if (/^(edit|str_replace_editor|multi_edit|multiedit)$/i.test(raw)) name = 'edit_file';
  else if (/^(pwsh|powershell|bash|sh|shell|run_command|exec|cmd)$/i.test(raw)) name = 'run';
  return { ...ev, name, args };
}

/** The run is registered: start its lease and its first save in the background. */
function hBegin(session, info) {
  const opts = (info && info.opts) || {};
  const resume = opts.handoff || null;
  if (!clMod || !hoMod || !handoffOn(session.cwd)) return;
  const ho = hoMod; const cl = clMod;
  const cwd = session.cwd;
  const p = cl.getProject(cwd);
  let route = { auto: true };
  try { const m = C.need('config.js').getSelectedModel(); if (m) route = { custom: m }; } catch { /* Haze 2 */ }
  const state = resume ? { ...resume.state, side: 'pc' } : ho.newRunState({ sessionId: session.id, mode: 'Build', userMessage: info.text, history: historyOf(session) });
  const run = {
    session, cwd, repo: p.repo, state, wipSha: (session.handoff && session.handoff.wipSha) || null, lease: null,
    pushing: false, again: false, debounce: null, every: null, ended: false, startedAt: Date.now(), local: isLocalModel(route),
  };
  hruns.set(session.id, run);
  session.handoff = { status: 'starting', wipSha: run.wipSha, at: Date.now(), state };
  hEmit(session, 'starting');
  (async () => {
    try {
      await cl.ensureHandoffReady({ cwd, token: githubToken() });
      await ensureAccess(p.repo).catch(() => {});
      if (run.ended) return;
      if (ending.has(session.id)) await ending.get(session.id).catch(() => {});
      if (run.ended) return;
      run.lease = ho.makeLease({
        store: leaseStore, sessionId: session.id, keepGoingOffline: run.local,
        onFence: (why) => fenced(run, why),
        onOffline: (off) => hEmit(session, off ? (run.local ? 'offline_local' : 'offline') : 'protected', { savedAt: run.savedAt || null, since: run.savedAt || run.startedAt }),
      });
      let epoch;
      try {
        epoch = await run.lease.start({ repo: p.repo, base: p.base || 'main', kind: p.kind || 'mirror', projectName: path.basename(cwd), mode: 'Build', wipSha: run.wipSha, takeover: !!(resume && resume.takeover) });
      } catch (e) {
        if (/cloud holds/i.test(e.message)) { session.handoff = { ...session.handoff, epoch: null }; fenced(run, 'taken'); return; }
        throw e;
      }
      if (run.ended || hruns.get(session.id) !== run) { run.lease.stop(); await run.lease.end('done'); return; }
      const w = await ho.pushWip({ cwd, token: githubToken(), repo: p.repo, sessionId: session.id, state: run.state, parent: run.wipSha, force: true });
      run.wipSha = w.sha;
      run.lease.saved(w.sha);
      await run.lease.beat();
      if (run.ended || hruns.get(session.id) !== run) { if (!run.fenced) { run.lease.stop(); await run.lease.end('done'); } return; }
      run.savedAt = Date.now();
      session.handoff = { status: 'running', epoch, wipSha: w.sha, at: Date.now(), state: run.state, since: run.startedAt };
      persist();
      run.every = setInterval(() => hPush(run), ho.WIP_EVERY_MS);
      hEmit(session, 'protected', { savedAt: run.savedAt });
    } catch (e) {
      note('could not protect this run:', e.message);
      if (run.lease) run.lease.stop();
      if (hruns.get(session.id) !== run) return;
      hruns.delete(session.id);
      session.handoff = null;
      hEmit(session, 'off');
    }
  })();
}

function hSee(session, ev) {
  const run = hruns.get(session.id);
  if (!run || run.ended || !hoMod) return;
  if (hoMod.recordEvent(run.state, normalizeStep(ev))) {
    clearTimeout(run.debounce);
    run.debounce = setTimeout(() => hPush(run), hoMod.WIP_DEBOUNCE_MS);
  }
}

async function hPush(run) {
  if (run.ended || !run.lease || run.fenced) return;
  if (run.pushing) { run.again = true; return; }
  run.pushing = true;
  try {
    const w = await hoMod.pushWip({ cwd: run.cwd, token: githubToken(), repo: run.repo, sessionId: run.session.id, state: run.state, parent: run.wipSha });
    if (w.pushed) { run.wipSha = w.sha; run.lease.saved(w.sha); run.lease.beat().catch(() => {}); }
    run.savedAt = Date.now();
    run.session.handoff = { ...run.session.handoff, wipSha: run.wipSha, state: run.state };
    C.api.save();
    if (!run.lease.offline) hEmit(run.session, 'protected', { savedAt: run.savedAt });
  } catch (e) { note('WIP push failed:', e.message); } finally {
    run.pushing = false;
    if (run.again && !run.ended) { run.again = false; hPush(run); }
  }
}

/** This side must stop editing: no renewal for 40 s, or the cloud holds the chat. */
function fenced(run, why) {
  const { session } = run;
  if (run.fenced) return;
  if (run.ended || hruns.get(session.id) !== run) { run.fenced = why; if (run.lease) run.lease.stop(); return; }
  run.fenced = why;
  session.handoff = { ...session.handoff, status: why === 'taken' ? 'cloud' : 'paused', state: run.state, pausedAt: Date.now() };
  hNote(session, why === 'taken'
    ? 'This PC was offline, so the cloud took over this task. It comes back here when you are online.'
    : 'Lost connection, so this task is paused here. If you stay offline, the cloud carries it on from the last save, and it comes back here when you are online.', 'warn');
  persist();
  hEmit(session, why === 'taken' ? 'cloud' : 'paused');
  C.api.stopRun(session.id);
}

async function hEnd(session, { aborted = false } = {}) {
  const run = hruns.get(session.id);
  if (!run) return;
  run.ended = true;
  hruns.delete(session.id);
  clearTimeout(run.debounce); clearInterval(run.every);
  if (run.fenced) return; // paused or in the cloud: recovery brings it back
  if (run.lease) {
    run.lease.stop();
    const closing = Promise.resolve(withTimeout(run.lease.end(aborted ? 'stopped' : 'done'), 8000)).catch(() => {});
    ending.set(session.id, closing);
    await closing;
    if (ending.get(session.id) === closing) ending.delete(session.id);
  }
  session.handoff = null;
  persist();
  hEmit(session, 'off');
}

const waitingForBack = () => C.api.sessions().filter((s) => s.handoff && !hruns.has(s.id) && !isRunning(s.id) && !recovering.has(s.id));

async function recoverAll() {
  if (!(await account())) return;
  const todo = waitingForBack();
  if (!todo.length) return;
  if (!(await libsOrNull())) return;
  for (const session of todo) {
    recovering.add(session.id);
    recover(session).catch((e) => note('could not bring the chat back:', e.message)).finally(() => recovering.delete(session.id));
  }
}

async function recover(session) {
  const h = session.handoff;
  let row;
  try { row = await withTimeout(leaseStore.get(session.id), 15000); } catch { return; } // still offline: next time
  if (!row || row.holder === 'none') { session.handoff = null; persist(); hEmit(session, 'off'); return; }
  if (row.holder === 'pc' && row.state === 'running' && row.epoch === h.epoch) {
    hNote(session, h.status === 'paused' ? 'Back online. Carrying on.' : 'Codeply closed in the middle of this task. Carrying on from the last save.');
    return resumeHere(session, h.state, false);
  }
  if (row.state === 'no_credentials' || row.state === 'cloud_failed') {
    hNote(session, `${row.note || 'The cloud could not take over.'} Carrying on here.`, 'warn');
    return resumeHere(session, h.state, true);
  }
  if (row.holder === 'cloud') return handBack(session, row);
  session.handoff = null; persist(); hEmit(session, 'off');
}

function resumeHere(session, state, takeover) {
  session.handoff = { ...session.handoff, status: 'resuming' };
  if (!state) { session.handoff = null; persist(); hEmit(session, 'off'); return null; }
  hEmit(session, 'resuming');
  const prompt = hoMod.continuationPrompt(state, state.side === 'cloud' ? 'pc' : 'self');
  C.api.startRun(session, prompt, { resume: true, handoff: { state, takeover } });
  return null;
}

/** Ask the cloud for the chat back, bring its steps and changes here, carry on. */
async function handBack(session, row) {
  const token = githubToken();
  if (!token) { hNote(session, 'The cloud has this task, but GitHub is not connected here any more. Reconnect it in Settings > Connections to bring it back.', 'warn'); return; }
  const cl = clMod; const ho = hoMod;
  const api = cl.githubApi({ token });
  const files = cl.branchFiles(api, row.repo);
  const sid = session.id;
  session.handoff = { ...session.handoff, status: 'returning' };
  hEmit(session, 'returning');
  if (!(await files.read(ho.HANDBACK.want(sid)).catch(() => null))) {
    await files.write(ho.HANDBACK.want(sid), { device: deviceId(), at: Date.now(), taskId: row.cloud_task_id }, `Craft hand-back ${sid}`);
  }
  const t0 = Date.now();
  let done = null; let doc = null;
  while (Date.now() - t0 < HANDBACK_WAIT_MS) {
    const f = await files.read(ho.HANDBACK.done(sid)).catch(() => null);
    if (f && f.json && (!row.cloud_task_id || f.json.taskId === row.cloud_task_id)) { done = { ...f.json, fileSha: f.sha }; break; }
    doc = await cl.readTaskDoc(api, row.repo, row.cloud_task_id).catch(() => null);
    if (!doc && Date.now() - t0 > NO_START_MS) break; // the cloud run never started
    await sleep(5000);
  }
  doc = await cl.readTaskDoc(api, row.repo, row.cloud_task_id).catch(() => doc);

  const events = (doc && doc.events) || [];
  const steps = events.filter((e) => e.t === 'tool').length;
  const wentAt = session.handoff.pausedAt || session.handoff.at || Date.now();
  hNote(session, `Your PC went offline at ${clock(wentAt)}. The cloud carried on: ${steps} step${steps === 1 ? '' : 's'}.`);
  try { replay(session, { seen: 0 }, events); } catch (e) { note('replay failed:', e.message); }

  let state = session.handoff.state;
  if (done) {
    let snap = null; try { snap = C.need('snapshot.js'); } catch { /* no checkpoint */ }
    let beforeTree = null;
    try { if (snap) beforeTree = await snap.track(session.cwd); } catch { /* no checkpoint */ }
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
          C.emit(sid, { type: 'checkpoint', checkpoint: { id: checkpoint.id, total: checkpoint.total, files: checkpoint.files } });
        }
      }
      if (r.conflicts.length) hNote(session, `The cloud and this PC changed the same lines in ${r.conflicts.join(', ')}. Look for <<<<<<< markers there.`, 'warn');
    } catch (e) {
      hNote(session, `Could not bring the cloud's changes here: ${e.message}. They are on the ${ho.wipBranch(sid)} branch of ${row.repo}.`, 'error');
    }
    await files.remove(ho.HANDBACK.done(sid), done.fileSha).catch(() => {});
  } else {
    hNote(session, 'The cloud did not answer, so this PC carries on from its own last save.', 'warn');
    await files.remove(ho.HANDBACK.want(sid)).catch(() => {});
  }

  if (done && done.status === 'done') {
    if (doc && doc.answer) {
      session.messages.push({ kind: 'assistant', text: doc.answer, at: Date.now() });
      C.emit(sid, { type: 'text', text: doc.answer, interim: false });
    }
    await leaseStore.end({ sessionId: sid, epoch: row.epoch, state: 'handed_back' }).catch(() => {});
    session.handoff = null;
    session.updatedAt = Date.now();
    persist();
    hEmit(session, 'back');
    C.emit(sid, { type: 'session_sync', session: C.api.meta(session) });
    return null;
  }
  hNote(session, 'Back on this PC. Carrying on.');
  return resumeHere(session, state, true);
}

function handoffStatus(sessionId) {
  const run = hruns.get(sessionId);
  if (run) return { status: run.lease ? (run.lease.offline ? (run.local ? 'offline_local' : 'offline') : 'protected') : 'starting', savedAt: run.savedAt || null, since: run.startedAt };
  const s = C.api.find(sessionId);
  return s && s.handoff ? { status: s.handoff.status } : { status: 'off' };
}

// =====================================================================================
// 2. The phone and the web reaching this PC (main.js: the relay and the same-network server)
// =====================================================================================
const remoteTokens = new Map(); // bridge token -> { userId, email, createdAt }
const sseClients = new Set();
let lanServer = null; let lanError = '';
let relayChannel = null; let relayUserId = null; let relayStatus = 'off'; let relayError = '';
const relayParts = new Map();
const relayAuthCache = new Map();
const RELAY_CHUNK = 60000;

function localUrls() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.')) out.push(`http://${i.address}:${LAN_PORT}`);
  }
  return out;
}
function phoneStatus() {
  return {
    relay: relayStatus === 'SUBSCRIBED', relayStatus, relayError, lan: !!lanServer, lanError, urls: lanServer ? localUrls() : [],
    phones: new Set([...remoteTokens.values()].map((t) => t.createdAt)).size, device: os.hostname(), mobileUrl: MOBILE_APP_URL,
  };
}

const modelLabel = () => { try { const m = C.need('config.js').getSelectedModel(); return m ? (m.name || m.model) : 'Haze 2'; } catch { return 'Haze 2'; } };
function modelsForPhone() {
  try {
    const config = C.need('config.js');
    let phoneStatusOf = () => ({ synced: false });
    try { const ms = C.need('model-sync.js'); phoneStatusOf = (m) => ms.phoneStatus(m, acct.v && acct.v.id); } catch { /* names only */ }
    return { selected: config.getSelectedModelId(), models: config.getModels().filter((m) => m.kind !== 'chatgpt').map((m) => ({ id: m.id, name: m.name, kind: m.kind, model: m.model, synced: !!phoneStatusOf(m).synced })) };
  } catch { return { selected: 'auto', models: [] }; }
}
function teamForPhone() {
  try {
    const W = C.need('wisp.js');
    return {
      enabled: true, team: W.listSpecialists().map((s) => W.detail(s)), models: [],
      schedules: W.listSchedules().map((j) => ({ ...j, specialistName: (W.findSpecialist(j.specialist) || {}).name || j.specialist })),
      shapes: W.SHAPES, moods: W.MOODS, sync: sync.status(), cloudRuns: sync.runs(),
    };
  } catch (e) { return { enabled: true, team: [], models: [], schedules: [], error: e.message }; }
}
const NOT_HERE = { status: 404, body: { error: 'The Codeply desktop app does not offer that to the phone yet.' } };

/** Every JSON route the phone uses, on this engine's chats (main.js handleBridgeApi). */
async function bridge(method, pathname, query, body) {
  body = body || {};
  const A = C.api;
  if (method === 'GET' && pathname === '/api/ping') return { status: 200, body: { app: 'codeply-craft', device: os.hostname(), deviceId: deviceId() } };
  if (pathname === '/api/cloud/state' && method === 'GET') return { status: 200, body: await phoneCloudState(query.get('cwd') || '') };
  if (pathname === '/api/cloud/credentials' && method === 'GET') {
    const token = githubToken();
    if (!token) return { status: 409, body: { error: 'GitHub is not connected on the PC.' } };
    const c = await cloudLib();
    const projects = Object.values(c.readState().projects).filter((p) => p.repo).map((p) => ({ cwd: p.cwd, name: path.basename(p.cwd), repo: p.repo }));
    return { status: 200, body: { token, projects } };
  }
  if (pathname === '/api/cloud/setup' && method === 'POST') { const r = await setup(body.cwd, { target: body.target }); return { status: r.error ? 400 : 200, body: r }; }
  if (pathname === '/api/cloud/options' && method === 'POST') { const r = await setOptions(body.cwd, body); return { status: r.error ? 400 : 200, body: r }; }
  if (pathname === '/api/cloud/checkBehind') { try { const c = await cloudLib(); return { status: 200, body: await c.checkBehind(method === 'GET' ? query.get('cwd') || '' : body.cwd, { token: githubToken() }) }; } catch (e) { return { status: 200, body: { ok: false, reason: e.message } }; } }
  if (pathname === '/api/cloud/pull' && method === 'POST') { const s = body.sessionId ? A.find(body.sessionId) : null; const r = await pullProject(body.cwd || (s && s.cwd)); return { status: r.error ? 409 : 200, body: r }; }
  if (pathname === '/api/cloud/apply' && method === 'POST') { const r = body.sessionId ? await applyRun(body.sessionId, body.taskId) : await applyTask(body.cwd, body.taskId); return { status: r.error ? 409 : 200, body: r }; }
  if (pathname === '/api/cloud/cancel' && method === 'POST') { const r = await cancelRun(body.sessionId, body.taskId); return { status: r.error ? 409 : 200, body: r }; }
  if (pathname.startsWith('/api/cloud/')) return NOT_HERE;

  if (method === 'GET' && pathname === '/api/wisp/team') return { status: 200, body: teamForPhone() };
  if (method === 'GET' && pathname === '/api/bootstrap') {
    const a = await account();
    const sessions = [...A.sessions()].sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0));
    return {
      status: 200,
      body: {
        device: os.hostname(), projects: knownFolders(), lastProject: sessions[0] ? sessions[0].cwd : C.DEFAULT_CWD,
        sessions: sessions.map(A.meta), activeSessionIds: [...A.runs.keys()],
        account: { email: a ? a.email : '', signedIn: !!a }, model: modelLabel(), models: modelsForPhone(),
      },
    };
  }
  if (method === 'GET' && pathname === '/api/session') {
    const s = A.find(query.get('id'));
    return s ? { status: 200, body: s } : { status: 404, body: { error: 'Session not found.' } };
  }
  if (method === 'GET' && pathname === '/api/commands') return { status: 200, body: { commands: [] } };
  if (method === 'GET' && pathname === '/api/models') return { status: 200, body: modelsForPhone() };
  if (method === 'POST' && pathname === '/api/models/select') {
    try {
      const r = C.need('config.js').selectModel(String(body.id || 'auto'));
      if (!r.ok) return { status: 400, body: { error: r.error || 'Could not switch model.' } };
      C.emit(null, { type: 'models_changed' });
      return { status: 200, body: modelsForPhone() };
    } catch (e) { return { status: 400, body: { error: e.message } }; }
  }
  if (method === 'POST' && pathname === '/api/send') {
    const text = String(body.text || '').trim();
    if (!text) return { status: 200, body: { error: 'Write a task before sending it.' } };
    let s = body.sessionId ? A.find(String(body.sessionId)) : null;
    const cwd = String(body.cwd || (s && s.cwd) || C.DEFAULT_CWD);
    if (!s) {
      if (!fs.existsSync(cwd)) return { status: 200, body: { error: 'Pick a project folder first.' } };
      s = { id: A.newId('c'), title: 'New chat', cwd: path.resolve(cwd), createdAt: Date.now(), updatedAt: Date.now(), messages: [], engine: 'dsh' };
      A.sessions().unshift(s);
      A.saveNow();
      C.emit(s.id, { type: 'session_sync', session: A.meta(s), origin: body.clientId || null });
    }
    // Answers when the run is under way (the phone shows its own message at once).
    const r = await A.sendMessage(s, text);
    return { status: 200, body: { ...r, sessionId: s.id, title: s.title, cwd: s.cwd } };
  }
  if (method === 'POST' && pathname === '/api/stop') { A.stopRun(String(body.sessionId || '')); return { status: 200, body: { ok: true } }; }
  if (method === 'POST' && pathname === '/api/approval') {
    const e = A.pending.get(String(body.requestId || ''));
    if (!e) return { status: 200, body: { ok: true } }; // answered on the PC already
    if (['once', 'always', 'reject'].includes(body.verdict)) e.resolve(body.verdict);
    return { status: 200, body: { ok: true } };
  }
  if (method === 'POST' && pathname === '/api/session/rename') {
    const s = A.find(String(body.sessionId || ''));
    if (!s) return { status: 404, body: { error: 'Session not found.' } };
    const title = String(body.title || '').trim().slice(0, 120);
    if (!title) return { status: 400, body: { error: 'Title cannot be empty.' } };
    s.title = title; s.named = true; A.save();
    C.emit(s.id, { type: 'session_sync', session: A.meta(s) });
    return { status: 200, body: { ok: true } };
  }
  if (method === 'POST' && pathname === '/api/session/delete') {
    const id = String(body.sessionId || '');
    A.stopRun(id);
    const list = A.sessions();
    const i = list.findIndex((s) => s.id === id);
    if (i >= 0) list.splice(i, 1);
    A.saveNow();
    C.emit(id, { type: 'session_deleted', sessionId: id });
    return { status: 200, body: { ok: true } };
  }
  return NOT_HERE;
}

/** The phone's /api/cloud/state: the project's cloud card, as cloud-desktop.js state() gives it. */
async function phoneCloudState(cwd) {
  const st = await refreshRemote(cwd);
  const row = (st.projects || []).find((p) => p.cwd === cwd) || null;
  const gh = githubInfo();
  return { github: { connected: !!gh.accessToken, userName: gh.userName || '', scopesOk: await githubScopesOk() }, project: row && row.ready ? row : null };
}

// ----- what reaches the phone: the engine's events as the phone knows them -----
const PASS = new Set(['text', 'tool_end', 'notice', 'error', 'approval_request', 'approval_resolved', 'aborted', 'cloud_task', 'checkpoint', 'checkpoint_update', 'turn_summary', 'role_active', 'session_deleted', 'queued']);
function phoneEvents(e) {
  const { seq, ...ev } = e;
  const sid = e.sessionId;
  const A = C.api;
  const runsStatus = () => ({ type: 'runs_status', sessionId: null, active: [...A.runs.keys()] });
  switch (e.type) {
    case 'text_delta': return [{ sessionId: sid, type: 'text', text: e.text, interim: false }];
    case 'run_started': return [{ sessionId: sid, type: 'session_sync', session: e.session, message: e.message }, runsStatus()];
    case 'run_finished': { const s = A.find(sid); return [{ sessionId: sid, type: 'run_finished' }, runsStatus(), ...(s ? [{ sessionId: sid, type: 'session_sync', session: A.meta(s) }] : [])]; }
    case 'session_sync': return [{ sessionId: sid, type: 'session_sync', session: e.session }];
    default: return PASS.has(e.type) ? [ev] : [];
  }
}
/** Screenshot bytes and pasted images stay out of the phone's events. */
function safeEvent(event) {
  const out = { ...event };
  if (out.meta && (out.meta.screenshotDataUrl || out.meta.imageDataUrls)) { out.meta = { ...out.meta }; delete out.meta.screenshotDataUrl; delete out.meta.imageDataUrls; }
  if (out.message && out.message.images) out.message = { ...out.message, images: undefined };
  if (out.type === 'tool_end' && out.args && /^(write|write_file|create)$/.test(String(out.name))) out.args = { path: out.args.path || out.args.file_path };
  return out;
}
const syncTimers = new Map();
function relayEmit(event) {
  if (!relayChannel || relayStatus !== 'SUBSCRIBED') return;
  const payload = { ...safeEvent(event), from: deviceId() };
  if (event.type === 'session_sync' && !event.message) {
    const key = event.sessionId || '_';
    clearTimeout(syncTimers.get(key));
    syncTimers.set(key, setTimeout(() => { syncTimers.delete(key); relaySend('event', payload); }, 1200));
    return;
  }
  relaySend('event', payload);
}
function mirror(e) {
  if (!relayChannel && !sseClients.size) return;
  let list = [];
  try { list = phoneEvents(e); } catch { return; }
  for (const ev of list) {
    relayEmit(ev);
    const line = `event: agent\ndata: ${JSON.stringify(safeEvent(ev))}\n\n`;
    for (const c of sseClients) { try { c.write(line); } catch { sseClients.delete(c); } }
  }
}

// ----- the relay -----
const relayId = () => Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
function relaySend(event, obj) {
  if (!relayChannel || relayStatus !== 'SUBSCRIBED') return;
  const str = JSON.stringify(obj);
  const id = relayId();
  const n = Math.max(1, Math.ceil(str.length / RELAY_CHUNK));
  for (let i = 0; i < n; i++) {
    Promise.resolve(relayChannel.send({ type: 'broadcast', event, payload: { id, i, n, d: str.slice(i * RELAY_CHUNK, (i + 1) * RELAY_CHUNK) } })).catch(() => {});
  }
}
function relayAssemble(payload) {
  if (!payload || typeof payload.d !== 'string') return null;
  if (payload.n === 1) { try { return JSON.parse(payload.d); } catch { return null; } }
  if (payload.n > 200) return null;
  let entry = relayParts.get(payload.id);
  if (!entry) { entry = { n: payload.n, got: 0, chunks: [], at: Date.now() }; relayParts.set(payload.id, entry); }
  if (entry.chunks[payload.i] === undefined) { entry.chunks[payload.i] = payload.d; entry.got++; }
  for (const [k, e] of relayParts) if (Date.now() - e.at > 60000) relayParts.delete(k);
  if (entry.got < entry.n) return null;
  relayParts.delete(payload.id);
  try { return JSON.parse(entry.chunks.join('')); } catch { return null; }
}
async function verifyToken(token) {
  if (!token) return null;
  const cached = relayAuthCache.get(token);
  if (cached && cached.until > Date.now()) return cached.userId;
  const { data, error } = await withTimeout(sb().auth.getUser(token), 12000);
  if (error || !data || !data.user) return null;
  if (relayAuthCache.size > 50) relayAuthCache.clear();
  relayAuthCache.set(token, { userId: data.user.id, until: Date.now() + 5 * 60000 });
  return data.user.id;
}
async function handleRelayRequest(payload) {
  const msg = relayAssemble(payload);
  if (!msg || !msg.id) return;
  if (msg.to && msg.to !== deviceId()) return;
  const reply = (status, body) => relaySend('res', { id: msg.id, status, body });
  try {
    const phoneUser = await verifyToken(msg.accessToken);
    const me = await userId();
    if (!phoneUser) return reply(401, { error: 'Your sign-in expired. Sign in again.' });
    if (!me || phoneUser !== me) return reply(403, { error: 'This phone is signed in to a different account than your PC.' });
    const u = new URL(String(msg.path || '/'), 'http://relay');
    const r = await bridge(String(msg.method || 'GET').toUpperCase(), u.pathname, u.searchParams, msg.body);
    let body = r.body;
    if (u.pathname === '/api/session' && body && Array.isArray(body.messages)) body = { ...body, messages: body.messages.map((m) => (m.images ? { ...m, images: undefined, imageCount: m.images.length } : m)) };
    reply(r.status, body);
  } catch (e) { reply(400, { error: e.message || 'Request failed.' }); }
}
let relayStarting = null;
function startRelay() {
  if (!relayStarting) relayStarting = startRelayOnce().catch((e) => { relayError = e.message; note('relay could not start:', e.message); }).finally(() => { relayStarting = null; });
  return relayStarting;
}
async function startRelayOnce() {
  const a = await account();
  if (!a) return;
  const supabase = sb();
  if (!supabase) return;
  if (relayChannel && relayUserId === a.id) return;
  await stopRelay();
  const { data } = await withTimeout(supabase.auth.getSession(), 9000);
  const session = data && data.session;
  if (!session) return;
  let secret = session.user.user_metadata && session.user.user_metadata.craft_relay;
  if (!secret) {
    secret = crypto.randomBytes(18).toString('base64url');
    const { error } = await supabase.auth.updateUser({ data: { craft_relay: secret } });
    if (error) throw error;
  }
  relayUserId = session.user.id;
  relayError = '';
  const channel = supabase.channel(`craft-${relayUserId}-${secret}`, { config: { broadcast: { self: false }, presence: { key: deviceId() } } });
  channel.on('broadcast', { event: 'req' }, ({ payload }) => { handleRelayRequest(payload); });
  channel.subscribe(async (status) => {
    relayStatus = status;
    if (status === 'SUBSCRIBED') { try { await channel.track({ device: os.hostname(), since: Date.now() }); } catch { /* presence is a nicety */ } }
  });
  relayChannel = channel;
}
async function stopRelay() {
  const channel = relayChannel;
  relayChannel = null; relayUserId = null; relayStatus = 'off'; relayAuthCache.clear();
  if (channel) { try { await sb().removeChannel(channel); } catch { /* gone */ } }
}

// ----- the same-network server (port 45671) -----
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Max-Age': '600' };
const loginAttempts = [];
const loginThrottled = () => { const now = Date.now(); while (loginAttempts.length && now - loginAttempts[0] > 60000) loginAttempts.shift(); loginAttempts.push(now); return loginAttempts.length > 20; };
function readSmall(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 250000) { reject(new Error('Request is too large.')); req.destroy(); } });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('Invalid JSON.')); } });
    req.on('error', reject);
  });
}
function startLan() {
  if (lanServer) return;
  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS }); res.end(JSON.stringify(body)); };
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...CORS });
      return res.end(`<!doctype html><meta name="viewport" content="width=device-width"><title>Codeply</title><body style="font:16px system-ui;padding:24px"><p>This is Codeply on ${os.hostname()}.</p><p>Open <a href="${MOBILE_APP_URL}">${MOBILE_APP_URL}</a> on your phone and sign in with the same account.</p>`);
    }
    try {
      if (req.method === 'GET' && url.pathname === '/api/ping') return json(res, 200, { app: 'codeply-craft', device: os.hostname(), deviceId: deviceId() });
      if (req.method === 'POST' && url.pathname === '/api/login') {
        if (loginThrottled()) return json(res, 429, { error: 'Too many sign-in attempts. Wait a minute and try again.' });
        const body = await readSmall(req);
        const accessToken = String(body.accessToken || '');
        if (!accessToken) return json(res, 400, { error: 'Missing sign-in token.' });
        const desktop = await account(true);
        if (!desktop) return json(res, 403, { error: 'Codeply on your PC is signed out. Sign in there with the same account first.' });
        const { data, error } = await withTimeout(sb().auth.getUser(accessToken), 12000);
        if (error || !data || !data.user) return json(res, 401, { error: 'Your sign-in expired. Sign in again.' });
        if (data.user.id !== desktop.id) return json(res, 403, { error: `This PC is signed in to Codeply as ${desktop.email}. Sign in on your phone with that account.` });
        const token = crypto.randomBytes(32).toString('base64url');
        remoteTokens.set(token, { userId: data.user.id, email: data.user.email, createdAt: Date.now() });
        return json(res, 200, { token, device: os.hostname(), account: { email: data.user.email, signedIn: true } });
      }
      const given = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('token') || '';
      const entry = remoteTokens.get(given);
      const me = entry ? await userId() : null;
      if (!entry || !me || me !== entry.userId) return json(res, 401, { error: 'Sign in again to connect to your PC.' });
      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', ...CORS });
        res.write('retry: 2000\n\n');
        sseClients.add(res);
        const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch { clearInterval(beat); sseClients.delete(res); } }, 20000);
        req.on('close', () => { clearInterval(beat); sseClients.delete(res); });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/logout') { remoteTokens.delete(given); return json(res, 200, { ok: true }); }
      const body = req.method === 'POST' ? await readSmall(req) : {};
      const r = await bridge(req.method, url.pathname, url.searchParams, body);
      return json(res, r.status, r.body);
    } catch (e) { return json(res, 400, { error: e.message || 'Request failed.' }); }
  });
  srv.on('error', (err) => { lanServer = null; lanError = err.code === 'EADDRINUSE' ? `Port ${LAN_PORT} is in use (another copy of Codeply?). The phone still reaches this PC through the relay.` : err.message; });
  srv.listen(LAN_PORT, '0.0.0.0', () => { lanServer = srv; lanError = ''; });
}
function stopLan() {
  const s = lanServer; lanServer = null;
  remoteTokens.clear();
  for (const c of sseClients) { try { c.end(); } catch { /* closed */ } }
  sseClients.clear();
  if (s) try { s.close(); } catch { /* closed */ }
}

// ----- keeping it all running -----
let lastUser = null;
let supervising = false;
async function supervise() {
  if (supervising) return;
  supervising = true;
  try {
    const a = await account(true);
    const id = a ? a.id : null;
    if (id !== lastUser) {
      // Signed in (or out, or another account): the phone side and the sync follow.
      lastUser = id;
      if (id) { sync.syncNow().catch(() => {}); C.emit(null, { type: 'account_changed' }); } else { await stopRelay(); stopLan(); C.emit(null, { type: 'account_changed' }); }
    }
    if (id) {
      if (!relayChannel || relayUserId !== id) await startRelay();
      if (!lanServer && !lanError) startLan();
    }
    sync.watchLocal();
  } catch (e) { note('supervisor:', e.message); } finally { supervising = false; }
}

export function start(ctx) {
  C = ctx;
  ctx.shared.sync = sync;
  ctx.shared.cloud = { account, deviceId, githubToken, handoffStatus };
  // The phone mirrors every event of the chats.
  ctx.api.onEvent(mirror);
  // The project's Cloud switch takes a message before it runs here.
  ctx.hooks.beforeMessage.push(takeMessage);
  // A protected local run: its lease, its saves, its end.
  ctx.hooks.runStart.push((session, info) => { try { hBegin(session, info); } catch (e) { note('handoff:', e.message); } });
  ctx.hooks.runEvent.push((session, ev) => hSee(session, ev));
  ctx.hooks.runEnd.push(async (session, info) => { await hEnd(session, info); afterLocalRun(session.cwd); });
  // Background work starts a moment after launch and never blocks the engine.
  const t0 = setTimeout(async () => {
    await libsOrNull();
    resumePolling();
    supervise();
  }, 2500);
  if (t0.unref) t0.unref();
  for (const [fn, every] of [[supervise, 20000], [recoverAll, RECOVER_MS], [() => sync.syncNow(), 120000]]) {
    const t = setInterval(() => { Promise.resolve().then(fn).catch(() => {}); }, every);
    if (t.unref) t.unref();
  }
}

export async function route(ctx, req, res, url, p, reply) {
  if (p !== '/ext/cloud' && !p.startsWith('/ext/cloud/')) return false;
  const done = (r) => { reply(200, r); return true; };
  const rest = p.slice('/ext/cloud'.length);
  try {
    if (req.method === 'GET' && rest === '') return done(await cloudState());
    if (req.method === 'GET' && rest === '/handoff') return done(handoffStatus(url.searchParams.get('session') || ''));
    if (req.method === 'POST') {
      const body = await ctx.readJson(req);
      if (rest === '/sync') { await sync.syncNow(); supervise(); return done({ sync: sync.status(), phone: phoneStatus() }); }
      if (rest === '/refresh') return done(await refreshRemote(String(body.cwd || '')));
      if (rest === '/setup') return done(await setup(String(body.cwd || ''), body));
      if (rest === '/options') return done(await setOptions(String(body.cwd || ''), body));
      if (rest === '/apply') return done(body.sessionId ? await applyRun(String(body.sessionId), String(body.taskId || '')) : await applyTask(String(body.cwd || ''), String(body.taskId || '')));
      if (rest === '/cancel') return done(await cancelRun(String(body.sessionId || ''), String(body.taskId || '')));
      if (rest === '/pull') return done(await pullProject(String(body.cwd || '')));
      if (rest === '/answer') return done(await answerAsk(String(body.sessionId || ''), String(body.taskId || ''), String(body.askId || ''), !!body.approve));
    }
  } catch (e) { return done({ error: e.message || 'Something went wrong.' }); }
  reply(404, { error: 'Not found.' });
  return true;
}
