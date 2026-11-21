// Your team and its standing jobs, for real: the specialists in ~/.codeply/wisp (wisp.js), the
// same ones the Electron app, the phone and the account share (ext-cloud.mjs syncs them), and the
// jobs Wisp or you scheduled, fired on time while Codeply is open, as wisp-desktop.js does.
//
//   GET  /ext/team                  { team: [...], jobs: [...] }
//   POST /ext/team/create           { name, focus, instructions }      a new specialist
//   POST /ext/team/remove           { id }                             one you made
//   POST /ext/team/jobs             { specialist, task, when }         a standing job ("every Monday at 9")
//   POST /ext/team/jobs/toggle      { id, enabled }
//   POST /ext/team/jobs/cancel      { id }
// It emits `team_changed` after any change (and ext-cloud does after a sync), so the app refetches.
import fs from 'node:fs';
import os from 'node:os';

let C = null;
const TICK_MS = 30_000;
let ticking = false;

const W = () => C.need('wisp.js');
const changed = () => { try { C.emit(null, { type: 'team_changed' }); } catch {} };

const ago = (t) => {
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
};
const when = (t) => {
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, '0');
  const day = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(new Date().setHours(0, 0, 0, 0))) / 86400000);
  const name = day === 0 ? 'today' : day === 1 ? 'tomorrow' : d.toLocaleDateString('en', { weekday: 'short', day: 'numeric', month: 'short' });
  return `${name} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
/** One line for the loop's row: how it went last, or when it runs first. */
const status = (j) => j.enabled === false ? `Off · ${j.whenText}`
  : j.needsYou ? `Needs you: ${j.needsYou}`
  : j.lastError ? `${j.failures ? `Failed ${ago(j.updatedAt || Date.now())}, trying again` : `Waiting`} ${j.nextAt ? when(j.nextAt) : ''}: ${j.lastError}`
  : j.lastAt ? `Succeeded ${ago(j.lastAt)} · next ${j.nextAt ? when(j.nextAt) : 'not set'}`
  : `${j.whenText} · first run ${j.nextAt ? when(j.nextAt) : 'not set'}`;

function teamView() {
  const w = W();
  if (!w) return { team: [], jobs: [], error: 'The team is not available in this engine.' };
  const team = w.listSpecialists().map((s) => ({
    id: s.id, name: s.name, focus: s.focus || '', shape: s.shape || 'blob', color: s.color || '#4a78e0',
    builtin: !!s.builtin, alwaysOn: !!s.alwaysOn, uses: s.uses || 0, lastUsedAt: s.lastUsedAt || 0,
  }));
  const jobs = w.listSchedules().map((j) => ({
    id: j.id, specialist: j.specialist, name: (w.findSpecialist(j.specialist) || {}).name || j.specialist,
    task: j.task || '', when: j.whenText || '', enabled: j.enabled !== false,
    nextAt: j.nextAt || 0, lastAt: j.lastAt || 0, lastError: j.lastError || '', sessionId: j.sessionId || '',
    runs: j.runs || 0, status: status(j), failures: j.failures || 0, needsYou: j.needsYou || '', running: inFlight.has(j.id),
  }));
  return { team, jobs };
}

const inFlight = new Set(); // job ids whose run has not ended yet
// The app's run health line for a job's chat (CONTRACTS.md "run health").
const health = (session, job, state, extra = {}) => {
  try { C.emit(session ? session.id : null, { type: 'run_health', runId: `job:${job.id}`, chatId: session ? session.id : '', agent: job.specialist, jobId: job.id, where: 'pc', state, ...extra }); } catch {}
};

/**
 * Runs one due job in the job's own chat (made on its first run), as wisp-desktop.js fire().
 * It counts as run only when the run ends with a reply; that reply is the report the phone and
 * the account see. Nobody may be at the PC, so approval cards answer themselves after a while.
 */
async function fire(job) {
  const w = W();
  const spec = w.findSpecialist(job.specialist);
  if (!spec) { w.cancelSchedule(job.id); return; }
  const text = `Scheduled job for ${spec.name} (${w.describeRule(job.rule)}): ${job.task}

(Nobody may be at the PC right now. Get the whole job done on your own: if one way fails, try another way before giving up. If an action is declined, no one was there to approve it: do everything else, and end your report with what is waiting for the user's yes. Never claim anything a tool result does not show.)`;
  // A job made on another PC (or the phone) may name a folder this PC does not have.
  const cwd = job.cwd && fs.existsSync(job.cwd) ? job.cwd : (C.DEFAULT_CWD || os.homedir());
  const api = C.api;
  let session = job.sessionId ? api.find(job.sessionId) : null;
  if (!session) {
    session = { id: api.newId('c'), title: `${spec.name}: ${String(job.task).split('\n')[0].slice(0, 50)}`, cwd, createdAt: Date.now(), updatedAt: Date.now(), messages: [], engine: 'dsh', kind: 'agent', agent: spec.name };
    api.sessions().unshift(session);
    api.saveNow();
    C.emit(session.id, { type: 'session_sync', session: api.meta(session) });
  }
  const sync = C.shared.sync;
  const record = async (ok, output) => { if (sync) { try { await sync.recordRun(job, { ok, output }); } catch {} } };
  if (api.runs.has(session.id)) {
    // Its chat is busy with something else: try again soon, without counting it as a run.
    w.markFired(job.id, { error: 'its chat was busy', started: false, sessionId: session.id });
    health(session, job, 'retrying', { reason: 'Its chat was busy, so it will try again in a few minutes.' });
    changed();
    return;
  }
  health(session, job, 'running');
  const keep = sync && sync.renew ? setInterval(() => { sync.renew(job).catch(() => {}); }, 10 * 60000) : null;
  keep?.unref?.();
  let r;
  try { r = await api.startRun(session, text, { unattended: true }); } catch (e) { r = { ok: false, error: e.message }; } finally { if (keep) clearInterval(keep); }
  const needsYou = (r && r.needsYou) || [];
  if (r && r.limited) {
    // Out of model allowance: wait for it to come back instead of failing.
    const until = r.resetsAt && r.resetsAt > Date.now() ? r.resetsAt : Date.now() + 30 * 60000;
    w.markFired(job.id, { error: 'model limit reached', started: false, sessionId: session.id });
    if (w.setNextAt) w.setNextAt(job.id, until);
    health(session, job, 'parked', { until: new Date(until).toISOString(), reason: 'Codeply hit its model limit, so this job waits and carries on when it resets.' });
  } else if (r && r.ok && r.text) {
    w.markFired(job.id, { sessionId: session.id, needsYou });
    const extra = needsYou.length ? `\n\nWaiting for your yes: ${needsYou.join('; ')}` : '';
    await record(true, `${w.stripMoodTags ? w.stripMoodTags(r.text).trim() : r.text}${extra}`);
    health(session, job, needsYou.length ? 'needs_you' : 'done', needsYou.length ? { reason: `Waiting for your yes: ${needsYou.join('; ')}` } : {});
  } else {
    const error = (r && r.error) || 'it ended without a report';
    const after = w.markFired(job.id, { sessionId: session.id, error, started: true });
    await record(false, `It did not finish: ${error}. It will try again on its own.`);
    if (after && after.needsYou) health(session, job, 'needs_you', { reason: after.needsYou });
    else health(session, job, 'retrying', { attempt: (after && after.failures) || 1, until: after && after.nextAt ? new Date(after.nextAt).toISOString() : undefined, reason: `It did not finish (${error}), so it will try again on its own.` });
  }
  changed();
}

// ---------- a specialist from a few plain words ----------
const SHAPES = ['pentagon', 'circle', 'square', 'triangle', 'hexagon', 'star', 'spiky', 'blob', 'cloud'];
const DRAFT_SYSTEM = `You design specialists for Codeply, a team of AI agents led by Wisp. The user describes, in a few plain words, a specialist they want. Write that specialist.

Return only JSON: {"name": string, "focus": string, "instructions": string, "shape": string, "color": string}
- name: 1 to 3 words, a role or a friendly name ("Copywriter", "Data Viz", "Release Captain"). Use the user's name for it if they gave one.
- focus: what it is good at, under 60 characters, no full stop.
- instructions: its system prompt, 300 to 600 words, written to the specialist as "you". Cover: who it is and what it owns; how it works step by step on a task Wisp hands it; the standards it holds (quality bar, style, conventions to follow, what to never do); how it uses the project's files, the terminal, the web and connected apps when that fits; how it checks its own work before reporting (run it, test it, read it back, compare with the ask); and how it reports back to Wisp (what it did, what it checked, anything left open or risky). Specific to the user's description, practical, no fluff, no markdown headings.
- shape: one of ${SHAPES.join(', ')}.
- color: a #rrggbb that suits it and reads well on dark and light.`;

/** Name, focus and a full system prompt from the user's description; a plain template when the model can't be reached. */
async function draft(ctx, { name, describe }) {
  const ask = [name && `Name: ${name}`, `What it should do: ${describe}`].filter(Boolean).join('\n');
  try {
    const ai = ctx.need('ai.js');
    if (!ai) throw new Error('no model');
    const r = await ai.chatJson([{ role: 'system', content: DRAFT_SYSTEM }, { role: 'user', content: ask }],
      { route: { auto: true }, maxTokens: 2500, temperature: 0.5, haze: { product: 'craft', surface: 'specialist', chatId: 'rune-team' } });
    const j = r && r.success && r.json;
    const text = (v, n) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, n);
    if (j && text(j.instructions, 8000).length > 80) {
      return {
        name: text(name || j.name, 40) || 'Specialist',
        focus: text(j.focus, 80) || text(describe, 80),
        instructions: String(j.instructions).trim().slice(0, 8000),
        shape: SHAPES.includes(j.shape) ? j.shape : undefined,
        color: /^#[0-9a-f]{6}$/i.test(String(j.color || '')) ? j.color : undefined,
        drafted: true,
      };
    }
  } catch { /* fall back below */ }
  // Without the model: the name given, or "Helper 2" (the model would have named it).
  let shown = String(name || '').trim();
  if (!shown) {
    const taken = new Set((ctx.need('wisp.js')?.listSpecialists() || []).map((s) => s.name.toLowerCase()));
    let n = 1;
    while (taken.has(`helper ${n}`)) n++;
    shown = `Helper ${n}`;
  }
  return {
    name: shown.slice(0, 40),
    focus: String(describe).slice(0, 80),
    instructions: `You are ${shown}, the team's specialist for: ${describe}. Take the work Wisp hands you, follow the project's own conventions, keep changes small and focused, and check your own work (run it, test it, read it back) before you report what you did and anything left open.`,
    drafted: false,
  };
}

async function tick() {
  if (ticking || !C.api) return;
  ticking = true;
  try {
    const w = W();
    if (!w) return;
    let due = [];
    try { due = w.dueSchedules(); } catch { return; }
    for (const job of due) { // each in its own chat, side by side
      if (inFlight.has(job.id)) continue; // still running from an earlier tick
      const sync = C.shared.sync;
      if (sync) { try { if (!(await sync.claim(job))) continue; } catch {} } // another PC or the cloud runs it
      inFlight.add(job.id);
      fire(job).catch((e) => console.warn('[team] job failed:', e && e.message)).finally(() => inFlight.delete(job.id));
    }
  } finally { ticking = false; }
}

export function start(ctx) {
  C = ctx;
  setTimeout(() => { tick().catch(() => {}); }, 5_000).unref?.();
  setInterval(() => { tick().catch(() => {}); }, TICK_MS).unref?.();
}

export async function route(ctx, req, res, url, p, reply) {
  if (!p.startsWith('/ext/team')) return false;
  const w = W();
  if (!w) { reply(200, { team: [], jobs: [], error: 'The team is not available in this engine.' }); return true; }
  try {
    if (req.method === 'GET' && p === '/ext/team') { reply(200, teamView()); return true; }
    if (req.method !== 'POST') return false;
    const b = await ctx.readJson(req).catch(() => ({}));
    let r = null;
    if (p === '/ext/team/create') {
      // From the app's dialog: an optional name and a few plain words about it. The model writes
      // the rest: a name if none was given, its focus and a full system prompt for it.
      const name = String(b.name || '').trim();
      const describe = String(b.describe || b.focus || '').trim();
      if (!name && !describe) r = { ok: false, error: 'Say what your agent should do.' };
      else if (String(b.instructions || '').trim()) r = w.createSpecialist({ name, focus: describe, instructions: b.instructions });
      else {
        const d = await draft(ctx, { name, describe: describe || name });
        r = { ...w.createSpecialist(d), drafted: d.drafted };
      }
    } else if (p === '/ext/team/remove') {
      const s = w.listSpecialists().find((x) => x.id === b.id);
      if (!s) r = { ok: false, error: 'No one on your team has that id.' };
      else if (s.builtin) r = { ok: false, error: `${s.name} is built in and stays on the team.` };
      else r = { ok: !!w.removeSpecialist(b.id) };
    } else if (p === '/ext/team/jobs') {
      r = w.addSchedule({ specialist: b.specialist, task: b.task, when: b.when, cwd: b.cwd || ctx.DEFAULT_CWD });
    } else if (p === '/ext/team/jobs/toggle') {
      const list = w.store.loadSchedules();
      const job = list.find((j) => j.id === b.id);
      if (!job) r = { ok: false, error: 'No such job.' };
      else {
        job.enabled = !!b.enabled;
        job.updatedAt = Date.now();
        // Turned back on: its next run counts from now, so it doesn't fire for every run it missed.
        if (job.enabled) job.nextAt = w.nextRun(job.rule) || job.nextAt;
        w.store.saveSchedules(list);
        r = { ok: true };
      }
    } else if (p === '/ext/team/jobs/cancel') {
      r = { ok: w.cancelSchedule(String(b.id || '')) };
      if (!r.ok) r.error = 'No such job.';
    } else {
      return false;
    }
    if (r && r.ok !== false) { changed(); try { ctx.shared.sync && ctx.shared.sync.syncSoon && ctx.shared.sync.syncSoon(500); } catch {} }
    reply(200, { ...(r || {}), ...teamView() });
  } catch (e) {
    reply(200, { ok: false, error: e.message, ...teamView() });
  }
  return true;
}

// For scripts/jobs-test.mjs: one pass of the job timer, without waiting 30 seconds.
export const __tick = () => tick();
