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
const claudeDesktop = require('./claude-code-desktop');
const fs = require('fs');
const os = require('os');
// The team and its standing jobs in the user's account: the phone and the server timer share them.
const sync = require('./specialists-sync');
let lastSyncTick = 0;

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
 * Who the user @mentioned in their message: { spec } for one specialist,
 * { back: true } for @Codeply, or null (no one, or two or more: Codeply
 * brings each in, wisp.js rule 10). Names can have spaces ("@Inbox Watch").
 */
function mentionedIn(text, W) {
  const s = String(text || '');
  if (!s.includes('@')) return null;
  const team = W.listSpecialists().slice().sort((a, b) => b.name.length - a.name.length); // "Inbox Watch" before "Inbox"
  const found = new Set();
  let back = false;
  const re = /(^|\s)@/g;
  let m;
  while ((m = re.exec(s))) {
    const rest = s.slice(m.index + m[0].length).toLowerCase();
    const ends = (n) => !/[\w-]/.test(rest.charAt(n));
    if (rest.startsWith('codeply') && ends(7)) { back = true; continue; }
    const hit = team.find((t) => rest.startsWith(t.name.toLowerCase()) && ends(t.name.length));
    if (hit) found.add(hit.id);
  }
  if (found.size === 1 && !back) return { spec: W.findSpecialist([...found][0]) };
  if (back && !found.size) return { back: true };
  return null;
}

/**
 * Everything a turn needs to run as Wisp, or null when this chat is not
 * Wisp's. Never throws. `request`: the user's message; an @mention of one
 * specialist switches the chat to it before the turn, so it answers this message itself.
 */
function forTurn({ session, approve, signal, route, cwd, mode, verifyOnly, request }) {
  if (!activeFor(session, mode)) return null;
  let W;
  try { W = wisp(); } catch (e) { console.warn('[wisp] not available:', e.message); return null; }
  const canDelegate = !verifyOnly;
  if (canDelegate && session && request) {
    let picked = null;
    try { picked = mentionedIn(request, W); } catch {}
    const to = picked && picked.spec ? picked.spec.id : null;
    if (picked && (picked.spec || session.speaker) && (session.speaker || null) !== to) {
      session.speaker = to;
      const card = picked.spec ? W.card(picked.spec) : null;
      push(session, { kind: 'wisp_speaker', agent: card });
      deps.sendEvent(session.id, { type: 'wisp_speaker', agent: card });
    }
  }
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

  // Claude Code (claude-code-desktop.js): the user's own Claude plan as a coding agent Wisp briefs and reviews.
  const claudeCode = canDelegate && claudeDesktop.ready()
    ? ({ task, fresh, model, effort, agent, wait, bare, browser, signal: sig }) => runClaude({ session, task, fresh, model, effort, agent, wait, bare, browser, approve, signal: sig || signal, cwd })
    : undefined;
  // A swarm: several Claude agents on one task at once, one combined report later.
  if (claudeCode) claudeCode.swarm = (o) => runSwarm({ session, approve, cwd, ...o });

  // talk_to: from the next message the user talks to that specialist itself (session.speaker),
  // with its own face and voice; "Codeply" hands them back. The face changes right away.
  const talkTo = async ({ specialist }) => {
    const q = String(specialist || '').trim();
    const back = !q || /^(codeply|wisp|you|back|main|lead)\b/i.test(q);
    const spec = back ? null : W.findSpecialist(q);
    if (!back && !spec) {
      const names = W.listSpecialists().map((s) => s.name).join(', ');
      return { ok: false, output: `No one on your team is called "${specialist}". Your team: ${names}. Pick one, or create_specialist first.` };
    }
    session.speaker = spec ? spec.id : null;
    const card = spec ? W.card(spec) : null;
    push(session, { kind: 'wisp_speaker', agent: card });
    deps.sendEvent(session.id, { type: 'wisp_speaker', agent: card });
    // The face on screen has already changed, so the rest of this answer is the new speaker saying hi.
    const voice = spec ? (spec.voice || `someone who lives and breathes ${spec.focus}`) : '';
    return {
      ok: true,
      output: card
        ? `Switched. The user now sees ${card.name}'s face and talks to ${card.name} from their next message. Finish this answer AS ${card.name} saying hi in one or two short lines, in its voice (${voice}), and ask what they need. Don't mention switching tools.`
        : 'Switched. The user now sees Codeply\'s face again. Finish this answer AS Codeply: a short, warm "welcome back" line in Codeply\'s voice. Don\'t mention switching tools.',
      meta: { label: card ? card.name : 'Codeply' },
    };
  };
  const mood = (ev) => {
    if (!ev || ev.type !== 'text' || typeof ev.text !== 'string') return ev;
    const { mood: m, text } = W.parseMood(ev.text);
    const out = { ...ev, text: W.stripMoodTags(text), wisp: true };
    if (m && !ev.interim) {
      out.mood = m;
      deps.sendEvent(session.id, { type: 'wisp_mood', mood: m });
    }
    return out;
  };

  // The user is talking to a specialist: it answers itself, on its own model, until it hands them back.
  const speaker = session && session.speaker ? W.findSpecialist(session.speaker) : null;
  if (session && session.speaker && !speaker) session.speaker = null; // removed from the team
  if (speaker) {
    return {
      prompt: () => W.chatPrompt(speaker),
      talkTo,
      agentRole: 'speaker',
      speaker: W.card(speaker),
      route: routeFor(speaker, route),
      mood,
    };
  }

  return {
    // Wisp's persona, its team and the ambient jobs. Built per prompt so a specialist made this turn is on the list next time.
    prompt: (native) => W.wispPrompt({ native, canDelegate, life, phone, models: userModels(), claudeCode: claudeDesktop.promptState() }),
    bringIn: canDelegate ? bringIn : undefined,
    claudeCode,
    createSpecialist: canDelegate ? createSpecialist : undefined,
    schedule: canDelegate ? (args) => scheduleTool(args, { cwd }) : undefined,
    talkTo: canDelegate ? talkTo : undefined,
    agentRole: 'lead',
    /** Splits the [mood: x] tag off a reply; the face goes to the window, the text stays clean. */
    mood,
  };
}

/** One specialist's run inside the chat. Returns the bring_in tool result. */
async function runSpecialist({ session, spec, task, approve, signal, route, cwd, mode }) {
  const W = wisp();
  const card = W.card(spec);
  const chat = recentChat(session);
  const track = W.trackRecord ? W.trackRecord(spec) : '';
  const brief = `${task}${chat ? `\n\nRECENT CHAT THIS CAME FROM (newest last). When the task points at something said here, it means this:\n${chat}` : ''}${track ? `\n\n${track}` : ''}`;
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

/** What Wisp reads when a Claude agent reports: its words, then what it really did. */
function claudeReport(r, auto) {
  const name = (r.agent && r.agent.name) || 'Claude Code';
  const facts = factsOf(r.actions || []);
  const lines = [];
  if (auto) lines.push(`[Automatic message from Codeply, not typed by the user: ${name} finished working in the background.]`, '');
  lines.push(`CLAUDE CODE'S REPORT (${name}, round ${r.round})`, r.text || (r.failed ? `It couldn't finish: ${r.failed}.` : 'Done, nothing to add.'), '', factsText(name, facts, facts.files, r.ok ? '' : r.failed));
  if (r.removed && r.removed.length) lines.push(`Files deleted: ${r.removed.join(', ')}`);
  if (r.denials && r.denials.length) lines.push(`Not allowed to run (Codeply's limits for Claude Code): ${r.denials.join('; ')}. Run what is still needed yourself with run (the user approves it), and publishing is yours.`);
  lines.push('', r.ok
    ? `Now review it: read the key files, browser_check the page, design_lint pages, run the build or tests. To send it back, call claude_code with agent ${name} and exactly what to fix; it remembers this round.${auto ? ' Then tell the user what was built and how you checked it.' : ''}`
    : r.auth ? 'Claude Code needs the user to log in again (Connect Apps, Claude Code). Tell them, and carry on yourself meanwhile.'
      : `Decide: send it back with claude_code (agent ${name}) and a clearer task, or finish the work yourself.`);
  return lines.join('\n');
}

/** One claude_swarm call: the swarm starts in the background; one combined report comes later. */
async function runSwarm({ session, task, parts, browser, url, model, effort, approve, cwd }) {
  const r = await claudeDesktop.swarmForChat({ session, task, parts, browser, url, model, effort, approve, cwd, onReport: (res) => claudeReport(res, true) });
  if (r.rejected) return { ok: false, output: `${r.failed} Do it yourself or with your team, or ask the user how they want it done.`, meta: { rejected: true } };
  if (!r.started) return { ok: false, output: r.failed || 'The swarm could not start.' };
  const names = r.swarm.agents.map((a) => a.name).join(', ');
  return {
    ok: true,
    output: `A swarm of ${r.swarm.agents.length} is working on it in the background: ${names}. Their board is ${r.swarm.board}.${browser ? ' They share a tab in Codeply\'s browser, each with its own cursor, so the user can watch.' : ''} Don't wait or check on them: one combined report arrives in this chat when the last one finishes. Tell the user in a line or two who is doing what, and that you'll review it all when they report.`,
    meta: { label: `Swarm of ${r.swarm.agents.length} is working` },
  };
}

/** One claude_code call. In the background by default: the report comes back as its own message (claude-code-desktop.js). */
async function runClaude({ session, task, fresh, model, effort, agent, wait, bare, browser, approve, signal, cwd }) {
  const r = await claudeDesktop.runForChat({ session, task, chat: recentChat(session), fresh, model, effort, agent, wait, bare, browser, approve, signal, cwd, onReport: (res) => claudeReport(res, true) });
  if (r.rejected) return { ok: false, output: `${r.failed} Do it yourself or with your team, or ask the user how they want it done.`, meta: { rejected: true } };
  if (r.started) {
    const a = r.agent;
    const how = [a.modelLabel, a.effortLabel ? `${a.effortLabel} effort` : ''].filter(Boolean).join(', ');
    return {
      ok: true,
      output: `${a.name} is working on it in the background${how ? ` (${how})` : ''}, in Background tasks, where the user can watch its log and message it. Don't wait or check on it: its report arrives in this chat as an automatic message when it finishes (agents started together report together, once the last one is done), and you review it then. Now tell the user in a line or two what you handed to ${a.name} and that you'll review it when it reports; you can keep talking with them meanwhile. For another part in parallel, call claude_code with a different agent name and separate files.`,
      meta: { label: `${a.name} is working${how ? ` (${how})` : ''}` },
    };
  }
  if (signal && signal.aborted) return { ok: false, output: 'Claude Code was stopped by the user.' };
  if (!r.actions && r.failed) return { ok: false, output: r.failed };
  const facts = factsOf(r.actions);
  const name = (r.agent && r.agent.name) || 'Claude Code';
  return {
    ok: r.ok,
    output: claudeReport(r, false),
    meta: {
      label: `${name}, round ${r.round}`,
      specialist: {
        id: claudeDesktop.CARD.id,
        name,
        actions: r.actions,
        succeeded: [...new Set(r.actions.filter((a) => a.ok).map((a) => a.tool))],
        madeAnyEdit: facts.files.length > 0,
        files: facts.files,
        // Nothing Claude Code wrote counts as checked until Wisp has looked at it.
        unverified: facts.files,
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
  // A job made on another PC (or the phone) may name a folder this PC does not have.
  const cwd = job.cwd && fs.existsSync(job.cwd) ? job.cwd : os.homedir();
  let r;
  try { r = await deps.startRun({ sessionId: job.sessionId || null, cwd, text }); } catch (e) { r = { error: e.message }; }
  W.markFired(job.id, r && r.error ? { error: r.error } : { sessionId: r && r.sessionId });
  if (!(r && r.error)) sync.recordRun(job, { ok: true, output: 'Ran on your PC. The report is in its chat in Codeply.' });
  sync.syncSoon(500);
  deps.sendEvent(null, { type: 'wisp_team' });
}

/** Always on: its jobs run on time even with the Codeply window closed (and, through the account, with the PC off). */
function alwaysOn(id) {
  try { const s = wisp().listSpecialists().find((x) => x.id === id); return !!(s && s.alwaysOn); } catch { return false; }
}

async function tick() {
  if (!enabled() || !deps.startRun) return;
  if (Date.now() - lastSyncTick > 2 * 60000) { lastSyncTick = Date.now(); await sync.syncNow(); }
  let due = [];
  try { due = wisp().dueSchedules(); } catch { return; }
  if (!due.length) return;
  // The account has the last word on timing: take the other devices' changes first.
  await sync.syncNow();
  try { due = wisp().dueSchedules(); } catch { return; }
  const shown = deps.windowShown ? deps.windowShown() : true;
  for (const job of due) { // one at a time; a busy chat retries in a few minutes
    if (!shown && !alwaysOn(job.specialist)) continue; // waits until Codeply is open
    if (!(await sync.claim(job))) continue; // another PC or the cloud runs this one
    await fire(job);
  }
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
      sync: sync.status(), cloudRuns: sync.runs(),
    };
  } catch (e) {
    return { enabled: enabled(), team: [], models: [], schedules: [], error: e.message };
  }
}

function init(d) {
  deps = d;
  sync.init({
    wisp, supabase: d.supabase, userId: d.userId, deviceId: d.deviceId || (() => 'pc'), dataDir: d.dataDir || os.tmpdir(),
    onChange: () => deps.sendEvent(null, { type: 'wisp_team' }),
  });
  // Any change from the window or from Wisp's tools goes to the account a moment later.
  d.ipcMain.handle('wisp:sync', async () => { await sync.syncNow(); return teamState(); });
  d.ipcMain.handle('wisp:state', () => teamState());
  d.ipcMain.handle('wisp:set', (e, on) => { deps.settings.set(!!on); return teamState(); });
  d.ipcMain.handle('wisp:removeSpecialist', (e, id) => {
    try { wisp().removeSpecialist(String(id || '')); } catch {}
    sync.syncSoon();
    return teamState();
  });
  d.ipcMain.handle('wisp:updateSpecialist', (e, id, patch) => {
    const p = { ...(patch || {}) };
    if (p.model !== undefined) { const m = resolveModel(p.model); p.model = m === undefined ? 'auto' : m; }
    try { wisp().updateSpecialist(String(id || ''), p); } catch {}
    if (p.alwaysOn === true && deps.keepRunning) deps.keepRunning();
    sync.syncSoon();
    return teamState();
  });
  // Make your own specialist: describe it, and Codeply writes its instructions (its system
  // prompt), a short focus, a name if you gave none, and a look. Nothing is saved until Create.
  d.ipcMain.handle('wisp:draftSpecialist', async (e, o) => {
    const description = String((o && o.description) || '').trim().slice(0, 4000);
    const wanted = String((o && o.name) || '').trim().slice(0, 40);
    if (!description) return { ok: false, error: 'Describe what it should do.' };
    if (!deps.draftJson) return { ok: false, error: 'Drafting is not available here.' };
    const W = wisp();
    const prompt = `You design a specialist agent for Codeply, a personal AI agent. The user describes what they want; write the specialist.

The user's description:
${description}
${wanted ? `\nIts name must be: ${wanted}` : ''}

Write its instructions as a system prompt in the second person ("You are ..."): its job, how it works step by step, its standards, what it must never do, how it checks its own work before reporting, and what its report to Codeply contains. Concrete and specific to this job, 120 to 300 words, plain sentences, no markdown headings. It works inside Codeply with Codeply's tools (files, commands, the web, the browser, the user's connected apps), and it reports back to Codeply, which answers the user.

Respond with ONLY a JSON object: {"name": "${wanted ? wanted : 'a short name, one or two words, like Copywriter or Price Watch'}", "focus": "what it is for, under 8 words", "instructions": "...", "voice": "how it talks when the user talks to it directly, one sentence", "shape": one of ${JSON.stringify(W.SHAPES.filter((x) => x !== 'pentagon'))}, "color": "#rrggbb, a vivid colour that fits it", "gear": one of ${JSON.stringify(W.GEAR)} or null}`;
    let r;
    try { r = await deps.draftJson(prompt); } catch (err) { return { ok: false, error: err.message }; }
    if (!r || !r.success || !r.json) return { ok: false, error: (r && r.error) || 'Could not write it. Try again.' };
    const j = r.json;
    return { ok: true, draft: {
      name: wanted || String(j.name || '').trim().slice(0, 40) || 'Specialist',
      focus: String(j.focus || '').trim().slice(0, 160),
      instructions: String(j.instructions || '').trim().slice(0, 4000),
      voice: String(j.voice || '').trim().slice(0, 300),
      shape: W.SHAPES.includes(j.shape) && j.shape !== 'pentagon' ? j.shape : 'circle',
      color: /^#[0-9a-f]{6}$/i.test(String(j.color || '')) ? String(j.color) : '#1f8bff',
      gear: W.GEAR.includes(j.gear) ? j.gear : null,
    } };
  });
  d.ipcMain.handle('wisp:createSpecialist', (e, o) => {
    const p = o && typeof o === 'object' ? o : {};
    let r;
    try {
      const m = p.model !== undefined ? resolveModel(p.model) : undefined;
      r = wisp().createSpecialist({ name: p.name, focus: p.focus, instructions: p.instructions, shape: p.shape, color: p.color, gear: p.gear || undefined, voice: p.voice, model: m === undefined ? undefined : m });
    } catch (err) { r = { ok: false, error: err.message }; }
    if (r && r.ok) { deps.sendEvent(null, { type: 'wisp_team' }); sync.syncSoon(); }
    return { ...teamState(), ok: !!(r && r.ok), error: r && r.error, id: r && r.specialist ? r.specialist.id : null };
  });
  d.ipcMain.handle('wisp:addSchedule', (e, o) => {
    const p = o && typeof o === 'object' ? o : {};
    let r;
    try { r = wisp().addSchedule({ specialist: String(p.specialist || ''), task: String(p.task || ''), when: String(p.when || ''), cwd: p.cwd || undefined }); } catch (err) { r = { ok: false, error: err.message }; }
    if (r && r.ok) { deps.sendEvent(null, { type: 'wisp_team' }); sync.syncSoon(); }
    return { ...teamState(), ok: !!(r && r.ok), error: r && r.error };
  });
  d.ipcMain.handle('wisp:cancelSchedule', (e, id) => { try { wisp().cancelSchedule(String(id || '')); } catch {} sync.syncSoon(); return teamState(); });
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
