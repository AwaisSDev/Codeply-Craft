// Wisp on the desktop: the main agent you talk to in Craft, and the team it leads.
//
// Every Craft chat (not a Crew bot's chat) runs as Wisp when Wisp is on:
//   - Wisp's persona and team go into the turn's prompt (codeply-cli/lib/wisp.js)
//   - bring_in runs one specialist in this chat: its own prompt, only the task
//     Wisp wrote (plus the recent chat), the same approvals and project folder.
//     It works behind Wisp: its steps fold into Wisp's work line (one quiet
//     "Brought in ..." row), and Wisp gets its report plus what it REALLY did
//     (files, commands with exit codes) to check before it answers
//   - create_specialist adds a new specialist to the team (or refines one)
//   - the reply's [mood: x] tag becomes Wisp's face (wisp_mood) and is never shown
//
// Specialists run one at a time and cannot bring in others, so a chat never
// has two agents editing the same folder at once.
const path = require('path');

let deps = null; // { ipcMain, cliDir, sendEvent, agentMod(), browser, settings: { get(), set(on) }, recordToolEnd(session, ev, extra), startRun(payload) }
let lib = null;

function wisp() {
  if (!lib) lib = require(path.join(deps.cliDir, 'lib', 'wisp.js'));
  return lib;
}

const SPECIALIST_STEPS = 60;
const TICK_MS = 30_000;
let ticker = null;

const config = () => require(path.join(deps.cliDir, 'lib', 'config.js'));

/** The user's own models, for Wisp to give a specialist. */
function userModels() {
  try {
    return (config().getModels() || []).map((m) => ({ id: m.id, name: m.name || m.model || m.id, note: m.kind === 'ollama' ? 'local' : m.kind === 'chatgpt' ? 'ChatGPT plan' : '' }));
  } catch { return []; }
}

/** 'auto', or the id of one of the user's models, from what Wisp wrote (a name or an id). undefined when unknown. */
function resolveModel(v) {
  const q = String(v == null ? '' : v).trim().toLowerCase();
  if (!q || /^(auto|haze|haze ?2|best|default)$/.test(q)) return 'auto';
  const m = userModels().find((x) => x.id.toLowerCase() === q || x.name.toLowerCase() === q) ||
    userModels().find((x) => x.name.toLowerCase().includes(q) || q.includes(x.name.toLowerCase()));
  return m ? m.id : undefined;
}

/**
 * The model a specialist runs on. Pinned to one of the user's models: that one
 * (while it still exists). auto: Haze 2 picks per specialist, unless the user
 * chose their own model for this chat, which wins.
 */
function routeFor(spec, chatRoute) {
  if (spec.model && spec.model !== 'auto') {
    try { const m = config().getModel(spec.model); if (m) return { custom: m }; } catch {}
  }
  return chatRoute;
}

function enabled() {
  try { return deps.settings.get() !== false; } catch { return true; }
}

/** Whether this chat runs as Wisp: on, not a Crew bot's chat, not Design. */
function activeFor(session, mode) {
  return !!deps && enabled() && !(session && session.botId) && mode !== 'Design' && !(session && session.design);
}

/** The last few lines of the chat, so "that page" in Wisp's task means what the user meant. */
function recentChat(session, max = 6) {
  const msgs = (session && Array.isArray(session.messages) ? session.messages : [])
    .filter((m) => (m.kind === 'user' || (m.kind === 'assistant' && !m.interim && !m.agent)) && m.text)
    .slice(-max);
  return msgs.map((m) => `${m.kind === 'user' ? 'User' : 'Codeply'}: ${String(m.text).replace(/\s+/g, ' ').slice(0, 400)}`).join('\n');
}

const base = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || '');

/** The factual record of a specialist's run, built from its tool results. */
function factsOf(actions) {
  const changed = [];
  const checks = [];
  for (const a of actions || []) {
    if (a.ok && ['write_file', 'edit_file', 'apply_patch', 'fetch_image'].includes(a.tool)) {
      if (Array.isArray(a.files) && a.files.length) changed.push(...a.files);
      else if (a.label) changed.push(a.label);
    }
    if (['run', 'browser_check'].includes(a.tool)) checks.push({ tool: a.tool, label: a.label, ok: !!a.ok, exitCode: a.exitCode });
  }
  return { files: [...new Set(changed.map(String))].slice(0, 40), checks: checks.slice(-10) };
}

function factsText(name, facts, unverified, failed) {
  const lines = [`WHAT ${name.toUpperCase()} ACTUALLY DID (from tool results, not its prose)`];
  lines.push(facts.files.length ? `Files changed: ${facts.files.join(', ')}` : 'Files changed: none');
  if (facts.checks.length) {
    lines.push('Checks run:');
    for (const c of facts.checks) {
      const how = c.tool === 'run' ? `ran \`${String(c.label).slice(0, 120)}\`` : `opened ${String(c.label).slice(0, 120)} in the browser`;
      lines.push(`- ${how}: ${c.ok && (c.exitCode === undefined || c.exitCode === 0) ? 'passed' : `FAILED${c.exitCode !== undefined ? ` (exit ${c.exitCode})` : ''}`}`);
    }
  } else {
    lines.push('Checks run: none');
  }
  if (unverified && unverified.length) lines.push(`Changed but never checked: ${unverified.join(', ')}`);
  if (failed) lines.push(`The run did not finish: ${failed}`);
  return lines.join('\n');
}

function push(session, msg) {
  session.messages.push({ ...msg, at: Date.now() });
  session.updatedAt = Date.now();
}

/**
 * Everything a turn needs to run as Wisp, or null when this chat is not
 * Wisp's. Never throws.
 */
function forTurn({ session, approve, signal, route, cwd, mode, verifyOnly }) {
  if (!activeFor(session, mode)) return null;
  let W;
  try { W = wisp(); } catch (e) { console.warn('[wisp] not available:', e.message); return null; }
  const canDelegate = !verifyOnly;
  let life = false; let phone = false;
  try { life = require(path.join(deps.cliDir, 'lib', 'life.js')).available(); } catch {}
  try { phone = require(path.join(deps.cliDir, 'lib', 'reach.js')).available(); } catch {}

  const bringIn = async ({ specialist, task, signal: sig }) => {
    const spec = W.findSpecialist(specialist);
    if (!spec) {
      const names = W.listSpecialists().map((s) => s.name).join(', ');
      return { ok: false, output: `No one on your team is called "${specialist}". Your team: ${names}. Pick one of them, or create_specialist first.` };
    }
    return runSpecialist({ session, spec, task, approve, signal: sig || signal, route, cwd, mode });
  };

  const createSpecialist = async (args) => {
    args = { ...(args || {}) };
    if (args.model !== undefined && args.model !== null && String(args.model).trim()) {
      const id = resolveModel(args.model);
      if (id === undefined) {
        const names = ['auto', ...userModels().map((m) => m.name)].join(', ');
        return { ok: false, output: `There is no model called "${args.model}". Pick one of: ${names}.` };
      }
      args.model = id;
    } else delete args.model;
    const r = W.createSpecialist(args);
    if (!r.ok) return { ok: false, output: r.error };
    const card = W.card(r.specialist);
    const phase = r.updated ? 'updated' : 'created';
    push(session, { kind: 'wisp_agent', phase, agent: card });
    deps.sendEvent(session.id, { type: 'wisp_agent', phase, agent: card });
    deps.sendEvent(session.id, { type: 'wisp_team' });
    return {
      ok: true,
      output: r.updated
        ? `${card.name} is refined (version ${r.specialist.version}). Bring it in with bring_in when you need it.`
        : `${card.name} is on your team now (${card.focus}). Bring it in with bring_in.`,
      meta: { label: card.name },
    };
  };

  return {
    // Wisp's persona, its team and the ambient jobs. Built per prompt so a specialist made this turn is on the list next time.
    prompt: (native) => W.wispPrompt({ native, canDelegate, life, phone, models: userModels() }),
    bringIn: canDelegate ? bringIn : undefined,
    createSpecialist: canDelegate ? createSpecialist : undefined,
    schedule: canDelegate ? (args) => scheduleTool(args, { cwd }) : undefined,
    agentRole: 'lead',
    /** Splits the [mood: x] tag off a reply; the face goes to the window, the text stays clean. */
    mood(ev) {
      if (!ev || ev.type !== 'text' || typeof ev.text !== 'string') return ev;
      const { mood, text } = W.parseMood(ev.text);
      const out = { ...ev, text: W.stripMoodTags(text), wisp: true };
      if (mood && !ev.interim) {
        out.mood = mood;
        deps.sendEvent(session.id, { type: 'wisp_mood', mood });
      }
      return out;
    },
  };
}

/** One specialist's run inside the chat. Returns the bring_in tool result. */
async function runSpecialist({ session, spec, task, approve, signal, route, cwd, mode }) {
  const W = wisp();
  const card = W.card(spec);
  const chat = recentChat(session);
  const brief = `${task}${chat ? `\n\nRECENT CHAT THIS CAME FROM (newest last). When the task points at something said here, it means this:\n${chat}` : ''}`;
  push(session, { kind: 'wisp_agent', phase: 'start', agent: card, task: task.slice(0, 600) });
  deps.sendEvent(session.id, { type: 'wisp_agent', phase: 'start', agent: card, task: task.slice(0, 600) });

  let reply = '';
  let done = null;
  let failed = '';
  try {
    const run = deps.agentMod().runAgent({
      userMessage: brief, history: [], mode: mode || 'Build', cwd, approve, browser: deps.browser, signal, route: routeFor(spec, route),
      maxSteps: SPECIALIST_STEPS, botPrompt: () => W.specialistPrompt(spec), agentRole: 'specialist',
      haze: { product: 'craft', chatId: `${session.id}:${spec.id}`, specialist: spec.id, specialty: spec.focus },
    });
    for await (const ev of run) {
      const tagged = { ...ev, agent: card.id };
      if (ev.type === 'text') {
        if (ev.interim) {
          push(session, { kind: 'assistant', text: ev.text, interim: true, agent: card.id });
          deps.sendEvent(session.id, tagged);
        } else {
          reply += (reply ? '\n\n' : '') + W.stripMoodTags(ev.text);
        }
      } else if (ev.type === 'reasoning') {
        push(session, { kind: 'reasoning', text: ev.text, ms: ev.ms, agent: card.id });
        deps.sendEvent(session.id, tagged);
      } else if (ev.type === 'tool_start' || ev.type === 'verifying') {
        deps.sendEvent(session.id, tagged);
      } else if (ev.type === 'tool_end') {
        deps.recordToolEnd(session, ev, { agent: card.id });
        deps.sendEvent(session.id, tagged);
      } else if (ev.type === 'notice') {
        push(session, { kind: 'notice', level: ev.level || 'info', text: ev.text, agent: card.id });
        deps.sendEvent(session.id, tagged);
      } else if (ev.type === 'error') {
        failed = String(ev.error || 'the run failed');
        break;
      } else if (ev.type === 'aborted') {
        failed = 'stopped by the user';
        break;
      } else if (ev.type === 'done') {
        done = ev;
        break;
      }
    }
  } catch (e) {
    failed = e.message || String(e);
  }

  const actions = (done && Array.isArray(done.actions)) ? done.actions : [];
  const facts = factsOf(actions);
  const unverified = (done && done.unverifiedFiles) || [];
  const ok = !!done && !failed;
  const text = reply.trim() || (failed ? `I couldn't finish: ${failed}.` : 'Done, nothing to add.');
  const report = { phase: 'report', agent: card, text, ok, files: facts.files.map(base), checks: facts.checks };
  push(session, { kind: 'wisp_agent', ...report });
  deps.sendEvent(session.id, { type: 'wisp_agent', ...report });
  try { W.noteRun(spec.id, { ok, task }); } catch {}
  deps.sendEvent(session.id, { type: 'wisp_team' });

  if (signal && signal.aborted) return { ok: false, output: `${card.name} was stopped by the user.` };
  const output = `${card.name.toUpperCase()}'S REPORT\n${text}\n\n${factsText(card.name, facts, unverified, failed)}`;
  return {
    ok,
    output,
    meta: {
      label: card.name,
      specialist: {
        id: card.id,
        name: card.name,
        actions,
        succeeded: [...new Set(actions.filter((a) => a.ok).map((a) => a.tool))],
        madeAnyEdit: !!(done && done.madeAnyEdit),
        files: facts.files,
        unverified,
      },
    },
  };
}

/** The schedule tool: add, list or cancel a specialist's standing job. */
function scheduleTool({ action, specialist, task, when, id }, { cwd }) {
  const W = wisp();
  if (action === 'list') {
    const jobs = W.listSchedules();
    if (!jobs.length) return { ok: true, output: 'No scheduled jobs.' };
    return { ok: true, output: jobs.map((j) => `- ${j.id}: ${W.findSpecialist(j.specialist)?.name || j.specialist}, ${j.whenText}: ${j.task.slice(0, 120)}${j.nextAt ? ` (next ${new Date(j.nextAt).toLocaleString()})` : ''}${j.lastError ? ` [last try failed: ${j.lastError}]` : ''}`).join('\n') };
  }
  if (action === 'cancel' || action === 'remove' || action === 'delete') {
    if (!W.cancelSchedule(String(id || ''))) return { ok: false, output: `No scheduled job with id "${id}". Use action list to see them.` };
    deps.sendEvent(null, { type: 'wisp_team' });
    return { ok: true, output: `Cancelled ${id}.`, meta: { label: `cancelled ${id}` } };
  }
  const r = W.addSchedule({ specialist, task, when, cwd });
  if (!r.ok) return { ok: false, output: r.error };
  const name = W.findSpecialist(r.schedule.specialist)?.name || r.schedule.specialist;
  deps.sendEvent(null, { type: 'wisp_team' });
  return {
    ok: true,
    output: `Scheduled ${r.schedule.id}: ${name}, ${r.schedule.whenText}. First run ${new Date(r.schedule.nextAt).toLocaleString()}. Each run happens in its own chat, through the usual approvals.`,
    meta: { label: `${name}, ${r.schedule.whenText}` },
  };
}

/** Fires one job: a message from Wisp to itself in the job's own chat. */
async function fire(job) {
  const W = wisp();
  const spec = W.findSpecialist(job.specialist);
  if (!spec) { W.cancelSchedule(job.id); return; }
  const text = `Scheduled job for ${spec.name} (${W.describeRule(job.rule)}): ${job.task}`;
  let r;
  try { r = await deps.startRun({ sessionId: job.sessionId || null, cwd: job.cwd, text }); } catch (e) { r = { error: e.message }; }
  W.markFired(job.id, r && r.error ? { error: r.error } : { sessionId: r && r.sessionId });
  deps.sendEvent(null, { type: 'wisp_team' });
}

async function tick() {
  if (!enabled() || !deps.startRun) return;
  let due = [];
  try { due = wisp().dueSchedules(); } catch { return; }
  for (const job of due) await fire(job); // one at a time; a busy chat retries in a few minutes
}

function teamState() {
  try {
    const W = wisp();
    return {
      enabled: enabled(),
      team: W.listSpecialists().map((s) => W.detail(s)),
      models: userModels(),
      schedules: W.listSchedules().map((j) => ({ ...j, specialistName: W.findSpecialist(j.specialist)?.name || j.specialist })),
      shapes: W.SHAPES, moods: W.MOODS,
    };
  } catch (e) {
    return { enabled: enabled(), team: [], models: [], schedules: [], error: e.message };
  }
}

function init(d) {
  deps = d;
  d.ipcMain.handle('wisp:state', () => teamState());
  d.ipcMain.handle('wisp:set', (e, on) => { deps.settings.set(!!on); return teamState(); });
  d.ipcMain.handle('wisp:removeSpecialist', (e, id) => {
    try { wisp().removeSpecialist(String(id || '')); } catch {}
    return teamState();
  });
  d.ipcMain.handle('wisp:updateSpecialist', (e, id, patch) => {
    const p = { ...(patch || {}) };
    if (p.model !== undefined) { const m = resolveModel(p.model); p.model = m === undefined ? 'auto' : m; }
    try { wisp().updateSpecialist(String(id || ''), p); } catch {}
    return teamState();
  });
  d.ipcMain.handle('wisp:cancelSchedule', (e, id) => { try { wisp().cancelSchedule(String(id || '')); } catch {} return teamState(); });
  d.ipcMain.handle('wisp:runSchedule', async (e, id) => {
    const job = wisp().listSchedules().find((j) => j.id === id);
    if (job) await fire(job);
    return teamState();
  });
  if (!ticker && d.startRun) {
    ticker = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
    if (ticker.unref) ticker.unref();
  }
}

module.exports = { init, forTurn, enabled, activeFor, tick, routeFor, teamState };
