// Specialists in the user's account (supabase/specialists.sql), so the PC, the
// phone and the server timer share one team and one set of standing jobs.
//
//   sync     Both ways, by state: every row carries the time it last changed,
//            and the newer side wins. A specialist or job this PC had synced
//            before and no longer has was removed here, so it is removed
//            there too (and the other way round, through `deleted`).
//   claim    Before this PC runs a job, it claims that run in the account. A
//            run another device (or the server timer) claimed is skipped, so
//            a job never runs twice when two PCs, or a PC and the cloud, are on.
//   runs     What the cloud and the phone ran, for the team window's history.
//
// Until that SQL has been run, or while signed out, sync stays quietly off and
// everything works on this PC alone, as before.
'use strict';

const fs = require('fs');
const path = require('path');

let host = null; // { wisp(), supabase(), userId(), deviceId(), dataDir, onChange() }
let offUntil = 0;
let lastError = '';
let lastSync = 0;
let running = null;
let soonTimer = null;
let cloudRuns = [];
const missingTable = (msg) => /does not exist|could not find the table|schema cache|relation .* does not exist/i.test(String(msg || ''));
const stateFile = () => path.join(host.dataDir, 'specialists-sync.json');
function loadState() { try { return { known: { spec: [], job: [] }, ...JSON.parse(fs.readFileSync(stateFile(), 'utf8')) }; } catch { return { known: { spec: [], job: [] } }; } }
function saveState(s) { try { fs.writeFileSync(stateFile(), JSON.stringify(s)); } catch {} }
const iso = (ms) => new Date(ms || Date.now()).toISOString();
const ms = (t) => (t ? Date.parse(t) || 0 : 0);
const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } })();

async function account() {
  if (!host || Date.now() < offUntil || !host.supabase) return null;
  const c = host.supabase();
  const uid = c ? await host.userId() : null;
  return c && uid ? { c, uid } : null;
}
function fail(err) {
  lastError = String((err && err.message) || err || '');
  if (missingTable(lastError)) { offUntil = Date.now() + 5 * 60000; lastError = 'setup'; }
}

/**
 * Newer side wins. local: Map id -> { stamp, value }; remote: rows with data/updated_at/deleted.
 * Returns { take: [[id, data]], drop: [id], push: [{ id, value, deleted }] }.
 */
function merge(local, remote, known) {
  const out = { take: [], drop: [], push: [] };
  const rmap = new Map(remote.map((r) => [r.id, r]));
  for (const id of new Set([...local.keys(), ...rmap.keys()])) {
    const l = local.get(id);
    const r = rmap.get(id);
    const lt = l ? l.stamp : 0;
    const rt = r ? ms(r.updated_at) : 0;
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
  const a = await account();
  if (!a) return { ok: false };
  const W = host.wisp();
  const S = W.store;
  const st = loadState();
  let changed = false;

  // ── Specialists: the ones the user made, and their settings on the built-ins ──
  const [{ data: specRows, error: e1 }, { data: jobRows, error: e2 }] = await Promise.all([
    a.c.from('specialists').select('id, data, always_on, deleted, updated_at'),
    a.c.from('specialist_jobs').select('id, specialist, data, next_at, claimed_by, claimed_until, deleted, updated_at'),
  ]);
  if (e1 || e2) { fail(e1 || e2); return { ok: false }; }

  const custom = S.loadCustom();
  const builtinSet = S.loadBuiltinSettings();
  const team = W.listSpecialists();
  const local = new Map();
  for (const s of custom) {
    const { history, ...value } = s;
    local.set(s.id, { stamp: s.updatedAt || s.createdAt || 0, value: { ...value, history: (history || []).slice(-8) } });
  }
  for (const b of team.filter((x) => x.builtin)) {
    const own = builtinSet[b.id] || {};
    const d = W.detail(b);
    // The server needs the guide to run a built-in with the PC off; the phone needs its look.
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
    S.saveCustom(list);
    S.saveBuiltinSettings(builtinSet);
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

  // ── Standing jobs ──
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
      // Just ran here: let go of the claim, so the next run is anyone's.
      ...(p.value && p.value.lastAt && p.value.lastAt >= (p.value.updatedAt || 0) - 5000 ? { claimed_by: null, claimed_until: null } : {}),
    }));
    // A deleted job keeps its specialist column: read it from the account's copy.
    for (const r of rows) if (!r.specialist) r.specialist = ((jobRows || []).find((x) => x.id === r.id) || {}).specialist || '?';
    const { error } = await a.c.from('specialist_jobs').upsert(rows);
    if (error) { fail(error); return { ok: false }; }
  }

  // What the cloud and the phone ran lately (the team window shows it with the PC's own history).
  const { data: runs } = await a.c.from('specialist_runs').select('id, job_id, specialist, task, output, ok, origin, at').neq('origin', 'pc').order('at', { ascending: false }).limit(40);
  if (Array.isArray(runs)) cloudRuns = runs.filter((r) => r.job_id !== 'chat');

  st.known.spec = [...new Set([...S.loadCustom().map((s) => s.id), ...team.filter((x) => x.builtin).map((b) => `builtin:${b.id}`)])];
  st.known.job = S.loadSchedules().map((j) => j.id);
  saveState(st);
  lastSync = Date.now();
  lastError = '';
  if (changed && host.onChange) host.onChange();
  return { ok: true, changed };
}

/** One sync at a time; a call while one runs waits for it. */
function syncNow() {
  if (!running) running = syncOnce().catch((e) => { fail(e); return { ok: false }; }).finally(() => { running = null; });
  return running;
}
function syncSoon(wait = 1500) {
  clearTimeout(soonTimer);
  soonTimer = setTimeout(() => { syncNow(); }, wait);
  if (soonTimer.unref) soonTimer.unref();
}

/**
 * This PC is about to run a job: claim the run in the account. true = go ahead.
 * Offline, signed out or not set up: true (this PC is the only one that knows).
 */
async function claim(job) {
  const a = await account();
  if (!a) return true;
  const now = Date.now();
  const { data, error } = await a.c.from('specialist_jobs')
    .update({ claimed_by: host.deviceId(), claimed_until: iso(now + 15 * 60000) })
    .eq('id', job.id).lte('next_at', iso(now + 60000))
    .or(`claimed_until.is.null,claimed_until.lt.${iso(now)},claimed_by.eq.${host.deviceId()}`)
    .select('id');
  if (error) { fail(error); return true; }
  if (Array.isArray(data) && data.length) return true;
  syncSoon(200); // someone else has it (or it moved): take their version
  return false;
}

/** A run this PC finished: in the account's history, so the phone sees it too. */
async function recordRun(job, { ok = true, output = '' } = {}) {
  const a = await account();
  if (!a) return;
  await a.c.from('specialist_runs').insert({ user_id: a.uid, job_id: job.id, specialist: job.specialist, task: String(job.task || '').slice(0, 2000), output: String(output || '').slice(0, 20000), ok, origin: 'pc' }).then(() => {}, () => {});
}

function status() {
  if (!host) return { state: 'off' };
  if (lastError === 'setup') return { state: 'setup' };
  if (lastSync) return { state: 'on', at: lastSync };
  return { state: lastError ? 'error' : 'waiting', error: lastError };
}

function init(h) { host = h; }

module.exports = { init, syncNow, syncSoon, claim, recordRun, status, runs: () => cloudRuns, TZ };
