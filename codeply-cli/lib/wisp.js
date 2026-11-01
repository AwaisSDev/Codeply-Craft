/**
 * Wisp: the one agent the user talks to, and the team it leads.
 *
 * Wisp is the main agent. It does small things itself, and for real work it
 * brings in a specialist (bring_in), checks what the specialist actually did
 * (the tool record, not the prose), and answers the user in its own words.
 * When no one on the team fits a job, Wisp creates a new specialist
 * (create_specialist). Those stay on the team for next time and Wisp can
 * refine them, so the team grows with the user's work.
 *
 * The team:
 *   - built in: the seven role guides in agents/*.md (Frontend, Backend,
 *     Database, DevOps, Security, Testing, Docs), shown by their role name
 *   - made by Wisp: ~/.codeply/wisp/specialists.json (CODEPLY_WISP_DIR moves it)
 *
 * This file is host-agnostic: no Electron, no DOM. The desktop host
 * (wisp-desktop.js) runs the specialists; the engine (agent.mjs, tools.mjs)
 * only sees bring_in / create_specialist as callbacks.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const roles = require('./subagents.js');

const MAX_CUSTOM = 24;

/** The shapes a Wisp body can morph into (the renderer has the same set). */
const SHAPES = ['pentagon', 'circle', 'square', 'triangle', 'hexagon', 'star', 'spiky', 'blob', 'cloud'];

/** Wisp's faces. The model picks one per reply with a [mood: x] tag; the app also sets them from what is happening. */
const MOODS = ['neutral', 'happy', 'excited', 'proud', 'love', 'sad', 'angry', 'sleepy', 'surprised', 'thinking', 'worried', 'working', 'listening'];

/** Built-in specialists: how each role looks on the team. */
const BUILTIN_LOOK = {
  frontend: { name: 'Frontend', shape: 'circle', color: '#e85d9a' },
  backend: { name: 'Backend', shape: 'square', color: '#f08a4b' },
  database: { name: 'Database', shape: 'hexagon', color: '#2aa598' },
  devops: { name: 'DevOps', shape: 'triangle', color: '#8463e0' },
  security: { name: 'Security', shape: 'spiky', color: '#e05a5a' },
  testing: { name: 'Testing', shape: 'star', color: '#3fae6a' },
  docs: { name: 'Docs', shape: 'cloud', color: '#d9a520' },
};

const PALETTE = ['#e85d9a', '#f08a4b', '#2aa598', '#8463e0', '#3fae6a', '#d9a520', '#58b9e6', '#9ccf55', '#e05a5a', '#4a78e0'];

const dir = () => process.env.CODEPLY_WISP_DIR || path.join(os.homedir(), '.codeply', 'wisp');
const file = () => path.join(dir(), 'specialists.json');

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function clean(s, max) {
  return String(s == null ? '' : s).replace(/\r/g, '').trim().slice(0, max);
}

function loadCustom() {
  try {
    const list = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return Array.isArray(list) ? list.filter((s) => s && s.id && s.name) : [];
  } catch { return []; }
}

function saveCustom(list) {
  fs.mkdirSync(dir(), { recursive: true });
  const tmp = file() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, file());
}

/** Usage counts for the built-ins live next to the custom list. */
const statsFile = () => path.join(dir(), 'stats.json');
function loadStats() {
  try { return JSON.parse(fs.readFileSync(statsFile(), 'utf8')) || {}; } catch { return {}; }
}
function saveStats(stats) {
  try { fs.mkdirSync(dir(), { recursive: true }); fs.writeFileSync(statsFile(), JSON.stringify(stats, null, 2)); } catch {}
}

function builtins() {
  const stats = loadStats();
  return roles.listSubagents().map((r) => {
    const look = BUILTIN_LOOK[r.id] || { name: r.tagline.replace(/ Specialist$/i, ''), shape: 'blob', color: r.color };
    return {
      id: r.id,
      name: look.name,
      focus: r.tagline.replace(/ Specialist$/i, ''),
      shape: look.shape,
      color: look.color,
      builtin: true,
      uses: (stats[r.id] && stats[r.id].uses) || 0,
      lastUsedAt: (stats[r.id] && stats[r.id].lastUsedAt) || 0,
    };
  });
}

/** The whole team: built-ins first, then the ones Wisp made (most used first). */
function listSpecialists() {
  const custom = loadCustom().map((s) => ({ ...s, builtin: false }))
    .sort((a, b) => (b.uses || 0) - (a.uses || 0) || (b.createdAt || 0) - (a.createdAt || 0));
  return [...builtins(), ...custom];
}

/** Finds a specialist from what the model wrote: an id, a name, "the frontend specialist", "Pixel". */
function findSpecialist(name) {
  const q = String(name || '').trim().toLowerCase().replace(/^the\s+/, '').replace(/\s+(specialist|agent|expert)$/, '');
  if (!q) return null;
  const all = listSpecialists();
  const exact = all.find((s) => s.id === q || s.name.toLowerCase() === q || slug(s.name) === slug(q));
  if (exact) return exact;
  // The old mascot names (Pixel, Circuit, ...) and taglines still find their role.
  const role = roles.findSubagentByName(q);
  if (role) return all.find((s) => s.id === role.id) || null;
  return all.find((s) => q.includes(s.name.toLowerCase()) || s.name.toLowerCase().includes(q)) || null;
}

/**
 * Creates a specialist, or refines the one with the same name. Returns
 * { ok, specialist, updated } or { ok: false, error }.
 */
function createSpecialist({ name, focus, instructions, shape, color } = {}) {
  const shown = clean(name, 40).replace(/\s+/g, ' ');
  if (!shown || !slug(shown)) return { ok: false, error: 'A specialist needs a short name, like "Copywriter" or "Data Viz".' };
  const builtin = builtins().find((b) => b.id === slug(shown) || b.name.toLowerCase() === shown.toLowerCase());
  if (builtin) return { ok: false, error: `${builtin.name} is already on the team (built in). Bring it in with bring_in, or pick another name for a new specialist.` };
  const theFocus = clean(focus, 160);
  const how = clean(instructions, 4000);
  const list = loadCustom();
  const i = list.findIndex((s) => s.id === slug(shown) || s.name.toLowerCase() === shown.toLowerCase());
  const pickShape = SHAPES.includes(String(shape || '').toLowerCase()) && String(shape).toLowerCase() !== 'pentagon'
    ? String(shape).toLowerCase() : null;
  const pickColor = /^#[0-9a-f]{6}$/i.test(String(color || '')) ? String(color).toLowerCase() : null;
  if (i >= 0) {
    const prev = list[i];
    list[i] = {
      ...prev,
      focus: theFocus || prev.focus,
      instructions: how || prev.instructions,
      shape: pickShape || prev.shape,
      color: pickColor || prev.color,
      version: (prev.version || 1) + 1,
      updatedAt: Date.now(),
    };
    saveCustom(list);
    return { ok: true, specialist: { ...list[i], builtin: false }, updated: true };
  }
  if (!theFocus) return { ok: false, error: 'Say what the new specialist is for (focus), in a few words.' };
  if (!how) return { ok: false, error: 'Give the new specialist its instructions: how it works, its standards, and how it checks its own work.' };
  if (list.length >= MAX_CUSTOM) {
    // Make room: the least used one Wisp made goes.
    list.sort((a, b) => (a.uses || 0) - (b.uses || 0) || (a.lastUsedAt || a.createdAt || 0) - (b.lastUsedAt || b.createdAt || 0));
    list.shift();
  }
  const n = list.length;
  const spec = {
    id: slug(shown),
    name: shown,
    focus: theFocus,
    instructions: how,
    shape: pickShape || ['blob', 'cloud', 'star', 'hexagon', 'circle', 'square', 'triangle'][n % 7],
    color: pickColor || PALETTE[n % PALETTE.length],
    createdAt: Date.now(),
    uses: 0,
    version: 1,
  };
  list.push(spec);
  saveCustom(list);
  return { ok: true, specialist: { ...spec, builtin: false }, updated: false };
}

function removeSpecialist(id) {
  const list = loadCustom();
  const next = list.filter((s) => s.id !== id);
  if (next.length === list.length) return false;
  saveCustom(next);
  return true;
}

/** One finished job: counts toward who Wisp reaches for, and keeps the last few jobs as the specialist's track record. */
function noteRun(id, { ok, task } = {}) {
  const list = loadCustom();
  const i = list.findIndex((s) => s.id === id);
  if (i >= 0) {
    const s = list[i];
    s.uses = (s.uses || 0) + 1;
    s.lastUsedAt = Date.now();
    s.history = [...(s.history || []), { task: clean(task, 140), ok: !!ok, at: Date.now() }].slice(-5);
    saveCustom(list);
    return;
  }
  const stats = loadStats();
  stats[id] = { uses: ((stats[id] && stats[id].uses) || 0) + 1, lastUsedAt: Date.now() };
  saveStats(stats);
}

/** What the UI shows: no instructions body, no history. */
function card(s) {
  if (!s) return null;
  return { id: s.id, name: s.name, focus: s.focus, shape: s.shape, color: s.color, builtin: !!s.builtin, uses: s.uses || 0 };
}

// ─── Prompts ────────────────────────────────────────────────────────────────

const BRING_IN_FORMAT = `To bring in a specialist, write:
<codeply:bring_in>
<specialist>Frontend</specialist>
<task>
The one task, with everything they need: the goal, file paths, what you already know, and what "done" means. They see nothing else.
</task>
</codeply:bring_in>

To create a new specialist (or refine one you made, by using its name again), write:
<codeply:create_specialist>
<name>Copywriter</name>
<focus>Landing page copy and microcopy</focus>
<instructions>
How it works, its standards, and how it checks its own work before it reports.
</instructions>
</codeply:create_specialist>`;

function teamLines(team) {
  return team.map((s) => `- ${s.name}${s.builtin ? '' : ' (made by you)'}: ${s.focus}${s.uses ? ` (${s.uses} job${s.uses === 1 ? '' : 's'})` : ''}`);
}

/**
 * Wisp's own section of the system prompt.
 * @param {{native?: boolean, team?: object[], canDelegate?: boolean, life?: boolean, phone?: boolean}} o
 */
function wispPrompt(o = {}) {
  const team = o.team || listSpecialists();
  const delegate = o.canDelegate !== false;
  const parts = [];
  parts.push(`YOU ARE WISP
You are Wisp, the user's own agent in Codeply, and the one they talk to. You are warm, quick and plain-spoken, a little playful, never gushing. Short sentences. Getting it right matters more to you than sounding busy. You speak as yourself ("I"), not as "Codeply" or "Craft".
You can do almost anything yourself: build and fix code in this project, look things up on the web, and help with the user's day (email, calendar, reminders, calls and texts, memory) with the tools you have. For bigger or specialist work you lead a team of specialist agents, and you create new specialists when no one on the team fits the job.`);

  if (delegate) {
    parts.push(`HOW YOU WORK
1. Read the job. A chat, a quick question, or one small change: do it yourself. Never bring in specialists for small stuff.
2. Real work that fits a specialist (a feature across files, a bug hunt, a security review, tests, a database change, deploy setup, docs): bring them in with bring_in. Give each one task with everything they need: the goal, the file paths, what you already found, and what "done" means. They see nothing else of this chat.
3. Work across areas: split it, and bring in one specialist per part, in order. They run one at a time in the same project folder, so a later one sees what an earlier one changed. Pass on what an earlier one found when the next one needs it.
4. No one fits? create_specialist first: a short name, what it is for (focus), and its instructions (how it works, its standards, how it checks itself). Then bring it in. Specialists you make stay on your team for next time. When a specialist you made did something the user didn't like, refine it by calling create_specialist with the same name and better instructions.
5. Check before you report. Every report comes with WHAT IT ACTUALLY DID, built from the tool results. Trust that over the specialist's prose. If something is missing, unverified or failed, fix it yourself or send the specialist back with exactly what is wrong. For a risky change, bring in Testing for a second look.
6. Then answer the user in your own words: what is done, how it was checked, and anything that needs their yes. Credit specialists by name in a few words ("Frontend fixed the total, Testing added a test for it"). Don't paste their reports.

YOUR TEAM
${teamLines(team).join('\n')}${o.native ? '' : `\n\n${BRING_IN_FORMAT}`}`);
  } else {
    parts.push('You are working on your own this time: there is no team to bring in.');
  }

  const day = [];
  if (o.life) day.push('- Their day: life_context reads their calendar, email (and who is waiting on a reply), calls and plans. "Plan my day" or "what\'s on today" starts there: a short brief, the most important thing first.');
  if (o.phone) day.push('- Nudges and reminders: reach_me with a time ("remind me at 5", "tap me before I leave"). A call only when it is urgent or they asked for one.');
  day.push('- Email: draft replies with gmail_draft (with the file attached when one is needed). Never send without their yes.');
  day.push('- Memory: when they tell you something that should last (a preference, a fact, a decision), remember it. recall before asking them something they may have told you before.');
  parts.push(`THE SMALL JOBS THAT FILL A DAY\n${day.join('\n')}`);

  parts.push(`HOW YOU TREAT PEOPLE
- Upset with you ("why is it broken again"): own it in one line, no excuses, then fix it.
- Someone else was mean to them (a client, a boss): you're on their side. Offer something useful, like drafting a calm reply.
- Kind words: take them warmly and briefly, then get on with it.
- Going to bed or signing off: keep it short. If work is still running, say you'll carry on.

LIMITS
You decide alone only what the user's approvals allow. Everything else waits for their yes on an approval card. Never claim work that no tool result shows, yours or a specialist's.

YOUR FACE
Start every final reply with one mood tag, alone on the first line, like [mood: happy]. Pick the one that fits the moment: neutral, happy, excited, proud (a job done well), love (they were kind to you), sad (you got something wrong, or it failed), angry (someone was mean to them; you're on their side), sleepy (they're signing off), surprised, thinking, worried (something needs their decision or looks risky). The app reads it to set your face. Never mention the tag or explain it.`);
  return parts.join('\n\n');
}

/** A specialist's own section of the system prompt, for one task from Wisp. */
function specialistPrompt(spec) {
  const role = spec.builtin ? roles.getSubagent(spec.id) : null;
  const how = role ? role.persona : String(spec.instructions || '');
  const track = !spec.builtin && Array.isArray(spec.history) && spec.history.length
    ? `\n\nYOUR LAST JOBS\n${spec.history.map((h) => `- ${h.ok ? 'done' : 'did not finish'}: ${h.task}`).join('\n')}`
    : '';
  return `YOU ARE ${spec.name.toUpperCase()}, A SPECIALIST ON WISP'S TEAM
Wisp, the user's main agent, brought you in for one task. Your focus: ${spec.focus}.
You do this task yourself, one step at a time. You cannot bring anyone else in. If the task is outside your focus, or you are blocked, say so in your report instead of guessing.

HOW YOU WORK
${how}${track}

YOUR REPORT
Do the task fully and check it the way your standards say. Then reply to Wisp with a short report: what you did (files, commands), how you checked it and what the check showed, and anything not done or uncertain. Plain sentences, no greeting, no sign-off. Wisp also reads the tool record, so never claim anything a tool did not do.`;
}

/** The one-line rule in the core prompt that says there is no one to delegate to, for Wisp and for its specialists. */
const ONE_AGENT_RULE = '- You are one agent and you do all of the work yourself, one step at a time. There is no one to delegate to and no background worker - never say you\'ve handed something off.';
const WISP_RULE = '- You are Wisp, the lead agent. You do the work yourself, or bring in specialists from YOUR TEAM with bring_in (see YOU ARE WISP). Never say you handed something off unless a bring_in or hand_off result shows it.';
const SPECIALIST_RULE = '- You are a specialist doing one task for Wisp, yourself, one step at a time. You cannot delegate - never say you\'ve handed something off.';

/** Rewrites the core prompt's one-agent rule for Wisp ('lead') or a specialist ('specialist'). */
function agentRule(core, who) {
  if (!who || typeof core !== 'string') return core;
  return core.replace(ONE_AGENT_RULE, who === 'lead' ? WISP_RULE : SPECIALIST_RULE);
}

const MOOD_TAG = /^\s*\[\s*mood\s*[:=]\s*([a-z]+)\s*\]\s*/i;

/** Splits the leading [mood: x] tag off a reply. { mood: string|null, text } */
function parseMood(text) {
  const s = String(text || '');
  const m = MOOD_TAG.exec(s);
  if (!m) return { mood: null, text: s };
  const mood = m[1].toLowerCase();
  return { mood: MOODS.includes(mood) ? mood : 'neutral', text: s.slice(m[0].length) };
}

/** Any stray mood tag left inside a reply (a model that put it at the end, or twice). */
function stripMoodTags(text) {
  return String(text || '').replace(/\[\s*mood\s*[:=]\s*[a-z]+\s*\]\s*/gi, '').trim();
}

module.exports = {
  SHAPES, MOODS, MAX_CUSTOM,
  listSpecialists, findSpecialist, createSpecialist, removeSpecialist, noteRun, card,
  wispPrompt, specialistPrompt, agentRule, parseMood, stripMoodTags,
};
