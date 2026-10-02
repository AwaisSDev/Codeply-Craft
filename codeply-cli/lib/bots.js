/**
 * Bots: named agents with one clear job, a tone, a memory that grows, and a
 * little robot avatar.
 *
 * A bot is a JSON file in ~/.codeply/bots/<id>.json. When the user picks a bot
 * for a chat, buildBotPrompt() is added to that run's system prompt. After
 * each reply, learnFromTurn() asks the model for at most 3 durable facts to
 * remember, so the bot gets better at working with this user over time.
 *
 * Bots talk to each other through the ask_bot tool. delegate() runs the asked
 * bot as an isolated sub-run (its own prompt, only the task text it was
 * given) behind one global lock, so only ONE agent ever runs at a time: the
 * caller waits while the helper works, then gets a structured result back.
 * No self-calls, no cycles, at most 2 levels deep.
 *
 * Nothing here talks to a model directly: the host passes a chat function in
 * (ai.js chatJson in the app, a fake in the tests).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_MEMORY = 60;
const MAX_FACTS_PER_TURN = 3;
const MAX_DEPTH = 2;

let dirOverride = null;
function botsDir() {
  return dirOverride || process.env.CODEPLY_BOTS_DIR || path.join(os.homedir(), '.codeply', 'bots');
}
/** Tests (and only tests) point the store somewhere else. */
function setBotsDir(dir) { dirOverride = dir || null; }

// ─── Vocabulary ─────────────────────────────────────────────────────────────

const ROLES = { orchestrator: 'Orchestrator', specialist: 'Specialist' };

const TONES = {
  friendly: { label: 'Friendly', text: 'Warm and encouraging, plain words, a little personality.' },
  concise: { label: 'Concise', text: 'Short and to the point. Lead with the answer, skip the filler.' },
  professional: { label: 'Professional', text: 'Calm, precise and polished, like a senior colleague.' },
  playful: { label: 'Playful', text: 'Light, upbeat and a bit funny, without getting in the way of the work.' },
  direct: { label: 'Direct', text: 'Blunt and honest. Say what is wrong and what to do about it.' },
  teacher: { label: 'Teacher', text: 'Patient. Explain the why in simple steps and check understanding.' },
};

/** What a bot must ask the user before doing. Each maps to engine tools. */
const APPROVALS = {
  edit_files: { label: 'Editing files', tools: ['write_file', 'edit_file', 'apply_patch', 'fetch_image'] },
  run_commands: { label: 'Running commands', tools: ['run'] },
  send: { label: 'Sending anything (email, Slack)', tools: ['gmail_send', 'slack_post_message'] },
  publish: { label: 'Deploying or publishing', tools: ['vercel_deploy', 'github_create_repo', 'vercel_api'] },
  databases: { label: 'Changing databases or cloud projects', tools: ['supabase_create_project', 'supabase_delete_project', 'supabase_api', 'supabase_sql'] },
};
const ALL_APPROVALS = Object.keys(APPROVALS);

// Kept in sync with bot-avatar.js (the renderer). The engine only validates.
const AVATAR_KEYS = {
  shape: ['squircle', 'capsule', 'pill', 'hexagon', 'octagon', 'chip', 'orb', 'shield', 'dome', 'monitor'],
  eyes: ['led', 'pixel', 'lens', 'visor', 'arcs', 'slits', 'rings', 'plus'],
  glasses: ['none', 'frames', 'monocle', 'shades', 'hud'],
  accessory: ['none', 'antenna', 'twin', 'halo', 'headset', 'propeller', 'fins', 'badge'],
  mouth: ['none', 'line', 'curve', 'wave', 'grille'],
  color: ['green', 'blue', 'yellow', 'pink', 'orange', 'purple', 'red', 'teal', 'sky', 'lime'],
};

// Keys from the first avatar set, so bots saved before the redesign still
// load. Same table as LEGACY in bot-avatar.js.
const LEGACY_AVATAR = {
  shape: { bean: 'pill', blob: 'squircle', round: 'orb', pear: 'dome', cloud: 'capsule', heart: 'shield', frog: 'monitor', flower: 'octagon', star: 'hexagon', ghost: 'chip' },
  eyes: { diamond: 'lens', ovals: 'led', dots: 'pixel', happy: 'arcs', sleepy: 'slits', sparkle: 'plus', wide: 'rings' },
  glasses: { round: 'frames', square: 'hud', sunglasses: 'shades' },
  accessory: { beret: 'propeller', bowtie: 'badge', cap: 'antenna', headphones: 'headset', flower: 'fins', crown: 'halo' },
  mouth: { smile: 'curve', grin: 'wave', o: 'grille' },
};

function normalizeAvatar(a) {
  a = a && typeof a === 'object' ? a : {};
  const pick = (k, def) => {
    if (AVATAR_KEYS[k].includes(a[k])) return a[k];
    const old = Object.prototype.hasOwnProperty.call(LEGACY_AVATAR[k], a[k]) ? LEGACY_AVATAR[k][a[k]] : null;
    return old && AVATAR_KEYS[k].includes(old) ? old : def;
  };
  const color = AVATAR_KEYS.color.includes(a.color) || /^#[0-9a-f]{6}$/i.test(String(a.color || '')) ? String(a.color) : 'green';
  return {
    shape: pick('shape', 'squircle'), eyes: pick('eyes', 'led'), color,
    glasses: pick('glasses', 'none'), accessory: pick('accessory', 'none'), mouth: pick('mouth', 'none'), cheeks: !!a.cheeks,
  };
}

// ─── Starter templates (one per team role) ─────────────────────────────────────

const TEMPLATES = [
  {
    key: 'orchestrator', name: 'Orion', role: 'orchestrator',
    specialty: 'Breaks a big goal into steps and gets the right teammate on each one',
    instructions: 'Restate the objective in one line. Split it into a few small steps. Hand each step to the teammate whose domain fits, one at a time, with only the context they need. Read every result critically before moving on, redo or adjust when something is off, and finish with one merged answer that says what was done and what is left.',
    tone: { preset: 'friendly', custom: '' },
    approval: ['edit_files', 'run_commands', 'send', 'publish', 'databases'],
    avatar: { shape: 'hexagon', eyes: 'led', color: 'blue', accessory: 'antenna' },
  },
  {
    key: 'research', name: 'Vera', role: 'specialist',
    specialty: 'Research: finds facts, docs and prior art, and cites where they came from',
    instructions: 'Search the project and the web, read the primary source, and report what you found with links or file paths. Separate facts from guesses. Never change files.',
    tone: { preset: 'professional', custom: '' }, sources: 'Official docs first, then the project itself, then reputable articles.',
    approval: ['edit_files', 'run_commands', 'send', 'publish', 'databases'],
    avatar: { shape: 'dome', eyes: 'lens', color: 'yellow', accessory: 'badge' },
  },
  {
    key: 'outreach', name: 'Remy', role: 'specialist',
    specialty: 'Outreach: drafts emails, posts and messages that sound like the user',
    instructions: 'Write drafts the user can send as is: clear subject, short body, one ask. Match their voice from earlier messages. Never send anything yourself without the user saying yes.',
    tone: { preset: 'friendly', custom: '' },
    approval: ['edit_files', 'run_commands', 'send', 'publish', 'databases'],
    avatar: { shape: 'capsule', eyes: 'arcs', color: 'pink', mouth: 'wave', accessory: 'headset' },
  },
  {
    key: 'analysis', name: 'Quinn', role: 'specialist',
    specialty: 'Analysis: digs into code, data and numbers and explains what they mean',
    instructions: 'Read the real code or data before concluding anything. Show the key numbers, the reasoning, and a clear recommendation. Say how sure you are.',
    tone: { preset: 'direct', custom: '' },
    approval: ['edit_files', 'run_commands', 'send', 'publish', 'databases'],
    avatar: { shape: 'monitor', eyes: 'pixel', color: 'teal', glasses: 'hud', mouth: 'line' },
  },
  {
    key: 'reporting', name: 'Wren', role: 'specialist',
    specialty: 'Reporting: turns results into short, skimmable summaries and status updates',
    instructions: 'Lead with the outcome, then 3 to 5 bullets, then next steps. Plain words, no jargon, nothing invented.',
    tone: { preset: 'concise', custom: '' },
    approval: ['edit_files', 'run_commands', 'send', 'publish', 'databases'],
    avatar: { shape: 'squircle', eyes: 'rings', color: 'orange', accessory: 'propeller', mouth: 'curve', cheeks: true },
  },
  {
    key: 'execution', name: 'Axel', role: 'specialist',
    specialty: 'Execution: writes and changes code, runs the checks, ships the change',
    instructions: 'Make the smallest change that does the job, in the project\'s own style. Run the relevant check after every change and report what really happened.',
    tone: { preset: 'concise', custom: '' },
    approval: ['run_commands', 'send', 'publish', 'databases'],
    avatar: { shape: 'chip', eyes: 'visor', color: 'green', accessory: 'twin' },
  },
  {
    key: 'monitoring', name: 'Juno', role: 'specialist',
    specialty: 'Monitoring: checks that things still work and flags what changed or broke',
    instructions: 'Run the checks, compare with what was expected, and report only what changed or failed, with the exact error. Suggest the next step, do not fix it yourself.',
    tone: { preset: 'direct', custom: '' },
    approval: ['edit_files', 'send', 'publish', 'databases'],
    avatar: { shape: 'orb', eyes: 'slits', color: 'purple', mouth: 'grille' },
  },
];

// ─── Store ──────────────────────────────────────────────────────────────────

const clip = (v, n) => String(v == null ? '' : v).replace(/\r/g, '').trim().slice(0, n);

function newId(name) {
  const slug = String(name || 'bot').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'bot';
  return `${slug}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

function cleanMemory(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((m) => (typeof m === 'string' ? { fact: m, at: Date.now() } : m))
    .filter((m) => m && typeof m.fact === 'string' && m.fact.trim())
    .map((m) => ({ fact: clip(m.fact, 240), at: Number(m.at) || Date.now() }))
    .slice(-MAX_MEMORY);
}

/** Any partial bot (from the UI or the model) becomes a complete, valid one. */
function normalizeBot(input, existing) {
  const b = { ...(existing || {}), ...(input || {}) };
  const tone = b.tone && typeof b.tone === 'object' ? b.tone : { preset: typeof b.tone === 'string' ? b.tone : '' };
  return {
    id: existing ? existing.id : (typeof b.id === 'string' && /^[a-z0-9-]{1,60}$/.test(b.id) ? b.id : newId(b.name)),
    name: clip(b.name, 40) || 'New bot',
    role: b.role === 'orchestrator' ? 'orchestrator' : 'specialist',
    specialty: clip(b.specialty, 200),
    instructions: clip(b.instructions, 4000),
    tone: { preset: TONES[tone.preset] ? tone.preset : 'friendly', custom: clip(tone.custom, 400) },
    sources: clip(b.sources, 2000),
    approval: Array.isArray(b.approval) ? [...new Set(b.approval.filter((k) => APPROVALS[k]))] : ALL_APPROVALS.slice(),
    avatar: normalizeAvatar(b.avatar),
    memory: cleanMemory(b.memory),
    template: typeof b.template === 'string' ? b.template : undefined,
    createdAt: existing ? existing.createdAt : (Number(b.createdAt) || Date.now()),
    updatedAt: Date.now(),
  };
}

function fileFor(id) {
  if (!/^[a-z0-9-]{1,60}$/.test(String(id || ''))) throw new Error('Bad bot id.');
  return path.join(botsDir(), `${id}.json`);
}

function save(bot) {
  fs.mkdirSync(botsDir(), { recursive: true });
  const file = fileFor(bot.id);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(bot, null, 2));
  fs.renameSync(tmp, file);
  return bot;
}

function listBots() {
  let files = [];
  try { files = fs.readdirSync(botsDir()).filter((f) => f.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const f of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(botsDir(), f), 'utf8'));
      const bot = normalizeBot(raw, { id: f.replace(/\.json$/, ''), createdAt: raw.createdAt });
      bot.updatedAt = Number(raw.updatedAt) || bot.updatedAt;
      out.push(bot);
    } catch {}
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

function getBot(id) {
  if (!id) return null;
  try { return listBots().find((b) => b.id === id) || null; } catch { return null; }
}

/** By id, exact name, then a loose name match ("the research bot", "alfred"). */
function findBot(nameOrId, bots) {
  const q = String(nameOrId || '').trim().toLowerCase().replace(/^@/, '');
  if (!q) return null;
  const all = bots || listBots();
  return all.find((b) => b.id === q) ||
    all.find((b) => b.name.toLowerCase() === q) ||
    all.find((b) => q.split(/[^a-z0-9]+/).includes(b.name.toLowerCase())) ||
    all.find((b) => b.template && q.includes(b.template)) ||
    null;
}

function createBot(data) {
  const bot = normalizeBot({ ...(data || {}), memory: (data && data.memory) || [] });
  if (getBot(bot.id)) bot.id = newId(bot.name);
  return save(bot);
}

function createFromTemplate(key, overrides) {
  const t = TEMPLATES.find((x) => x.key === key);
  if (!t) throw new Error(`No template "${key}".`);
  const { key: tk, ...rest } = t;
  return createBot({ ...JSON.parse(JSON.stringify(rest)), template: tk, ...(overrides || {}) });
}

function updateBot(id, patch) {
  const cur = getBot(id);
  if (!cur) throw new Error('That bot is gone.');
  const { id: _i, createdAt: _c, ...rest } = patch || {};
  return save(normalizeBot(rest, cur));
}

function removeBot(id) {
  try { fs.unlinkSync(fileFor(id)); return true; } catch { return false; }
}

// ─── Memory ─────────────────────────────────────────────────────────────────

const factKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Same fact, or one that contains the other: the newer wording wins. */
function sameFact(a, b) {
  const x = factKey(a); const y = factKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const shorter = x.length < y.length ? x : y;
  return shorter.length >= 12 && (x.includes(y) || y.includes(x));
}

function mergeMemory(memory, facts, now = Date.now()) {
  let list = cleanMemory(memory);
  const added = [];
  for (const f of facts) {
    const fact = clip(f, 240);
    if (!fact) continue;
    list = list.filter((m) => !sameFact(m.fact, fact));
    list.push({ fact, at: now });
    added.push(fact);
  }
  return { memory: list.slice(-MAX_MEMORY), added };
}

function addMemory(botId, facts) {
  const bot = getBot(botId);
  if (!bot) return { added: [], bot: null };
  const r = mergeMemory(bot.memory, Array.isArray(facts) ? facts : [facts]);
  if (!r.added.length) return { added: [], bot };
  return { added: r.added, bot: save({ ...bot, memory: r.memory, updatedAt: Date.now() }) };
}

function forget(botId, index) {
  const bot = getBot(botId);
  if (!bot) throw new Error('That bot is gone.');
  const memory = bot.memory.slice();
  if (index >= 0 && index < memory.length) memory.splice(index, 1);
  return save({ ...bot, memory, updatedAt: Date.now() });
}

function clearMemory(botId) {
  const bot = getBot(botId);
  if (!bot) throw new Error('That bot is gone.');
  return save({ ...bot, memory: [], updatedAt: Date.now() });
}

/**
 * After a reply: ask the model what is worth remembering. chatFn has the
 * ai.js chatJson shape: (messages) => {success, json}. Never throws.
 */
async function learnFromTurn(bot, userText, replyText, chatFn) {
  try {
    if (!bot || !bot.id || typeof chatFn !== 'function') return { added: [] };
    const user = clip(userText, 3000);
    if (!user) return { added: [] };
    const known = (bot.memory || []).slice(-30).map((m) => `- ${m.fact}`).join('\n') || '(nothing yet)';
    const prompt = `You keep the long-term memory of an assistant called ${bot.name}${bot.specialty ? ` (${bot.specialty})` : ''}.
From the exchange below, pick at most ${MAX_FACTS_PER_TURN} durable things worth remembering for future conversations: the user's preferences, decisions, standing instructions, facts about them or their project, or feedback on how ${bot.name} should work.
Skip anything one-off, temporary, obvious, or already known. Never store passwords, keys or other secrets. Each item is one short sentence about the user or the work, written in the third person ("The user prefers ...").

Already known:
${known}

User: ${user}

${bot.name}: ${clip(replyText, 3000) || '(no reply)'}

Respond with ONLY a JSON object {"facts": ["..."]}. Use an empty list when nothing is worth keeping.`;
    const r = await chatFn([{ role: 'user', content: prompt }]);
    if (!r || !r.success || !r.json) return { added: [] };
    const facts = (Array.isArray(r.json.facts) ? r.json.facts : [])
      .filter((f) => typeof f === 'string')
      .map((f) => f.trim())
      .filter((f) => f.length >= 4 && !/(api[_ -]?key|password|secret|token)\s*[:=]/i.test(f))
      .filter((f) => !(bot.memory || []).some((m) => factKey(m.fact) === factKey(f)))
      .slice(0, MAX_FACTS_PER_TURN);
    if (!facts.length) return { added: [] };
    return addMemory(bot.id, facts);
  } catch {
    return { added: [] };
  }
}

// ─── Prompts ────────────────────────────────────────────────────────────────

function approvalLine(bot) {
  const must = (bot.approval || []).map((k) => APPROVALS[k] && APPROVALS[k].label.toLowerCase()).filter(Boolean);
  if (!must.length) return 'You may act without asking first. Still never do anything irreversible the user did not ask for.';
  return `Always get the user's approval before: ${must.join('; ')}. Craft enforces this too. Do reversible, read-only work (reading, searching, thinking) without asking.`;
}

function rosterLines(team, selfId) {
  return (team || []).filter((b) => b.id !== selfId)
    .map((b) => `- ${b.name} (${b.role === 'orchestrator' ? 'orchestrator' : 'specialist'}): ${b.specialty || 'general help'}`);
}

const ASK_BOT_FORMAT = `To ask a teammate, write:
<codeply:ask_bot>
<bot>Name</bot>
<task>
The one task, with every bit of context they need (they see nothing else).
</task>
</codeply:ask_bot>`;

/**
 * The system prompt addition for one bot.
 * @param {object} bot
 * @param {object} [o]
 * @param {object[]} [o.team]       every bot (the roster leaves this one out)
 * @param {boolean} [o.canDelegate] ask_bot is available in this run
 * @param {string}  [o.askedBy]     set for a delegated sub-run: who asked
 * @param {boolean} [o.native]      native function calling (no tag example)
 */
function buildBotPrompt(bot, o = {}) {
  if (!bot) return '';
  const parts = [];
  const role = bot.role === 'orchestrator' ? 'the orchestrator of a small team of bots' : 'a specialist bot';
  parts.push(`BOT IDENTITY\nYou are ${bot.name}, ${role} inside Codeply Craft. Speak as ${bot.name}. You are still the same careful agent with the same tools and rules; this is who you are for this chat.`);
  if (bot.specialty) parts.push(`SPECIALTY\n${bot.specialty}. Stay in this lane; if a request is clearly outside it, say so briefly and do the best you can.`);
  if (bot.instructions) parts.push(`HOW YOU WORK\n${bot.instructions}`);
  const tone = TONES[bot.tone && bot.tone.preset] || TONES.friendly;
  parts.push(`TONE\n${tone.text}${bot.tone && bot.tone.custom ? ` ${bot.tone.custom}` : ''}`);
  if (bot.sources) parts.push(`SOURCES AND NOTES\n${bot.sources}`);
  parts.push(`APPROVAL BOUNDARY\n${approvalLine(bot)}`);
  const memory = (bot.memory || []).slice(-MAX_MEMORY);
  if (memory.length) {
    parts.push(`WHAT YOU HAVE LEARNED ABOUT THIS USER\nFollow these unless the user says otherwise now:\n${memory.map((m) => `- ${m.fact}`).join('\n')}`);
  }
  if (o.askedBy) {
    parts.push(`DELEGATED TASK\n${o.askedBy} asked you to do one task. You only see that task, not the rest of the conversation. Do it fully with your tools, then reply in this shape:\nSummary: <one sentence with the outcome>\n<the details: findings, what you changed, anything ${o.askedBy} must know or check>`);
  }
  const roster = rosterLines(o.team, bot.id);
  if (o.canDelegate && roster.length) {
    const lead = bot.role === 'orchestrator'
      ? `You lead this team. For a goal with several parts: decompose it into small steps, give each step to the teammate whose domain fits with ask_bot, ONE AT A TIME (only one bot ever runs at once), read and check each result before the next step (ask again with a correction if it falls short), then merge everything into one clear answer. Do small or simple things yourself.`
      : `You can ask a teammate for help with ask_bot when part of the work is clearly in their domain. Only one bot runs at a time, and you wait for the answer.`;
    parts.push(`TEAM\n${lead}\nTeammates:\n${roster.join('\n')}${o.native ? '' : `\n\n${ASK_BOT_FORMAT}`}`);
  }
  return parts.join('\n\n');
}

/** The short roster note when the plain Craft agent (no bot chosen) can still ask bots. */
function teamPrompt(team, o = {}) {
  const roster = rosterLines(team, null);
  if (!roster.length) return '';
  return `BOTS\nThe user has these bots. When they ask for one by name, or a part of the work is clearly a bot's specialty, you can hand it that part with ask_bot. Only one bot runs at a time, and you wait for its answer.\n${roster.join('\n')}${o.native ? '' : `\n\n${ASK_BOT_FORMAT}`}`;
}

/** Which approval category a tool falls into, or null. */
function approvalCategory(tool) {
  for (const [k, v] of Object.entries(APPROVALS)) if (v.tools.includes(tool)) return k;
  return null;
}

/** True when this bot is allowed to do this tool without asking the user. */
function canSkipApproval(bot, tool) {
  if (!bot) return false;
  const cat = approvalCategory(tool);
  return !!cat && !(bot.approval || []).includes(cat);
}

// ─── One agent at a time ────────────────────────────────────────────────────

/**
 * A lock with an owner token. The run that holds it may take it again (a bot
 * asking a teammate while it waits), anyone else queues. So exactly one agent
 * chain runs at a time, and a nested ask never deadlocks.
 */
function createLock() {
  let owner = null;
  let holds = 0;
  const queue = [];
  function acquire(token, signal) {
    if (owner === token) { holds++; return Promise.resolve(); }
    if (owner === null) { owner = token; holds = 1; return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      const w = { token, resolve };
      queue.push(w);
      if (signal) {
        if (signal.aborted) { queue.splice(queue.indexOf(w), 1); reject(new Error('Stopped.')); return; }
        signal.addEventListener('abort', () => {
          const i = queue.indexOf(w);
          if (i >= 0) { queue.splice(i, 1); reject(new Error('Stopped.')); }
        }, { once: true });
      }
    });
  }
  function release(token) {
    if (owner !== token) return;
    if (--holds > 0) return;
    owner = null;
    const next = queue.shift();
    if (next) { owner = next.token; holds = 1; next.resolve(); }
  }
  async function run(token, fn, signal) {
    await acquire(token, signal);
    try { return await fn(); } finally { release(token); }
  }
  return { acquire, release, run, get owner() { return owner; }, get waiting() { return queue.length; } };
}

const globalLock = createLock();

/** "Summary: ..." first line, else the first sentence. */
function parseResult(text) {
  const t = String(text || '').trim();
  if (!t) return { summary: 'No answer.', details: '' };
  const m = t.match(/^\s*\**summary\**\s*[:\-]\s*(.+)$/im);
  if (m) {
    const details = t.replace(m[0], '').trim();
    return { summary: clip(m[1].replace(/\*+$/, ''), 300), details };
  }
  const first = t.split(/\n/)[0];
  const sentence = (first.match(/^.{10,300}?[.!?](\s|$)/) || [first])[0].trim();
  return { summary: clip(sentence, 300), details: t };
}

/**
 * The ask_bot tool, minus the actual model run (the host passes runBot).
 *
 * @param {object} o
 * @param {object|null} o.caller   the bot asking (null = plain Craft)
 * @param {string} o.name          who to ask
 * @param {string} o.task          the task, with its context
 * @param {number} o.depth         depth of the CALLER (top-level run = 0)
 * @param {string[]} [o.chain]     bot ids already in this delegation chain
 * @param {string} o.token         lock owner token for this chain
 * @param {AbortSignal} [o.signal]
 * @param {object[]} [o.team]      every bot (defaults to the store)
 * @param {object} [o.lock]        defaults to the global lock
 * @param {Function} o.runBot      async (bot, {prompt, task, depth, chain}) => reply text
 * @returns {Promise<{ok:boolean, output:string, meta:object}>}
 */
async function delegate(o) {
  const team = o.team || listBots();
  const task = clip(o.task, 8000);
  const target = findBot(o.name, team);
  const callerName = o.caller ? o.caller.name : 'Craft';
  const fail = (output) => ({ ok: false, output, meta: { label: `ask ${o.name || '?'}: refused`, delegation: { bot: target ? botCard(target) : { name: String(o.name || '?') }, task, ok: false, error: output } } });
  if (!target) return fail(`There is no bot called "${o.name}". Teammates: ${team.map((b) => b.name).join(', ') || 'none'}.`);
  if (!task) return fail('ask_bot needs a task: say exactly what you want done, with the context.');
  if (o.caller && target.id === o.caller.id) return fail(`You are ${target.name}; do it yourself instead of asking yourself.`);
  const chain = Array.isArray(o.chain) ? o.chain : [];
  if (chain.includes(target.id)) return fail(`${target.name} is already working on this chain of requests; asking it again would loop. Do it yourself or ask someone else.`);
  const depth = Number(o.depth) || 0;
  if (depth >= MAX_DEPTH) return fail(`Delegation is limited to ${MAX_DEPTH} levels. Do this part yourself.`);
  const lock = o.lock || globalLock;
  const started = Date.now();
  let reply;
  try {
    reply = await lock.run(o.token, () => o.runBot(target, {
      task, depth: depth + 1, chain: [...chain, ...(o.caller ? [o.caller.id] : []), target.id],
      prompt: buildBotPrompt(target, { team, askedBy: callerName, canDelegate: depth + 1 < MAX_DEPTH }),
    }), o.signal);
  } catch (e) {
    const output = `${target.name} could not finish: ${e.message}`;
    return { ok: false, output, meta: { label: `${target.name}: failed`, delegation: { bot: botCard(target), task, ok: false, error: e.message, ms: Date.now() - started } } };
  }
  const { summary, details } = parseResult(reply);
  return {
    ok: true,
    output: `RESULT FROM ${target.name.toUpperCase()}\nSummary: ${summary}\n\n${details || '(no details)'}\n\nCheck this against the goal before you build on it.`,
    meta: { label: `${target.name}: ${summary}`.slice(0, 160), delegation: { bot: botCard(target), task, ok: true, summary, details: clip(details, 6000), ms: Date.now() - started } },
  };
}

/** What a chat row or a chip needs to draw a bot. */
function botCard(b) {
  return b ? { id: b.id, name: b.name, role: b.role, avatar: b.avatar, specialty: b.specialty } : null;
}

// ─── "Describe your bot" ────────────────────────────────────────────────────

function describePrompt(description) {
  return `Design a helpful AI bot from this description. The bot lives inside Codeply Craft, a desktop coding agent app, and has the same tools (read and edit project files, run commands, search the web).

Description: ${clip(description, 2000)}

Respond with ONLY a JSON object:
{
  "name": "a short, friendly first name (one word)",
  "role": "specialist" or "orchestrator" (orchestrator only if it should coordinate other bots),
  "specialty": "one line: its single clear domain",
  "instructions": "2 to 4 sentences: how it works, what it always does, what it never does",
  "tone": {"preset": one of ${Object.keys(TONES).map((k) => `"${k}"`).join(', ')}, "custom": "optional extra tone note"},
  "sources": "where it should look first, or empty",
  "approval": a list from ${ALL_APPROVALS.map((k) => `"${k}"`).join(', ')}: what it must ask before doing (keep everything irreversible),
  "avatar": {"shape": one of ${AVATAR_KEYS.shape.map((k) => `"${k}"`).join(', ')}, "eyes": one of ${AVATAR_KEYS.eyes.map((k) => `"${k}"`).join(', ')}, "color": one of ${AVATAR_KEYS.color.map((k) => `"${k}"`).join(', ')}, "glasses": one of ${AVATAR_KEYS.glasses.map((k) => `"${k}"`).join(', ')}, "accessory": one of ${AVATAR_KEYS.accessory.map((k) => `"${k}"`).join(', ')}, "mouth": one of ${AVATAR_KEYS.mouth.map((k) => `"${k}"`).join(', ')}}
}
Pick an avatar that fits its personality. Never use the long dash character.`;
}

/** Turn what the model returned into bot fields (not saved). */
function fromDescription(json, description) {
  const j = json && typeof json === 'object' ? json : {};
  const draft = normalizeBot({
    name: j.name, role: j.role, specialty: j.specialty || clip(description, 120), instructions: j.instructions,
    tone: j.tone, sources: j.sources, approval: Array.isArray(j.approval) ? j.approval : undefined, avatar: j.avatar,
  });
  const dash = String.fromCharCode(0x2014); // the long dash, written without typing it
  const noDash = (s) => String(s || '').split(` ${dash} `).join(', ').split(dash).join('-');
  for (const k of ['name', 'specialty', 'instructions', 'sources']) draft[k] = noDash(draft[k]);
  draft.tone.custom = noDash(draft.tone.custom);
  // Irreversible actions always stay behind approval, whatever the model said.
  for (const k of ['send', 'publish', 'databases']) if (!draft.approval.includes(k)) draft.approval.push(k);
  delete draft.id; delete draft.memory; delete draft.createdAt; delete draft.updatedAt;
  return draft;
}

module.exports = {
  MAX_MEMORY, MAX_DEPTH, ROLES, TONES, APPROVALS, AVATAR_KEYS, TEMPLATES,
  botsDir, setBotsDir, normalizeBot, normalizeAvatar,
  listBots, getBot, findBot, createBot, createFromTemplate, updateBot, removeBot,
  mergeMemory, addMemory, forget, clearMemory, learnFromTurn,
  buildBotPrompt, teamPrompt, approvalCategory, canSkipApproval,
  createLock, globalLock, parseResult, delegate, botCard,
  describePrompt, fromDescription,
};
