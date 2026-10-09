/**
 * Bots: named agents with one clear job, a tone, a memory that grows, and a
 * soft sticker avatar.
 *
 * A bot is a JSON file in ~/.codeply/bots/<id>.json. When the user picks a bot
 * for a chat, buildBotPrompt() is added to that run's system prompt. After
 * each reply, learnFromTurn() asks the model for at most 3 durable facts to
 * remember, so the bot gets better at working with this user over time.
 * After a run that used tools, reflectOnRun() looks at what the bot did and
 * keeps experience (lessons, playbooks, tool tips, open threads), so the bot
 * also gets better at the work itself.
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
// Experience memory (MUSE style: learned from the bot's own work, not about the user).
const MAX_LESSONS = 12;
const MAX_PLAYBOOKS = 40;
const MAX_TOOL_TIPS = 15;
const MAX_OPEN_THREADS = 5;
const PLAYBOOKS_IN_FULL = 2;

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
  publish: { label: 'Deploying or publishing', tools: ['vercel_deploy', 'github_create_repo', 'vercel_api', 'publish_deploy', 'publish_github'] },
  databases: { label: 'Changing databases or cloud projects', tools: ['supabase_create_project', 'supabase_delete_project', 'supabase_api', 'supabase_sql', 'supabase_setup', 'supabase_schema'] },
  calendar: { label: 'Adding to your calendar', tools: ['calendar_add'] },
};
const ALL_APPROVALS = Object.keys(APPROVALS);
// The categories bots were saved with before `calendar` existed. A bot saved
// back then never chose about the newer ones, so it asks for them (listBots).
const FIRST_APPROVALS = ['edit_files', 'run_commands', 'send', 'publish', 'databases'];

// Always on (mail-watch.js): the bot watches in the background, with no model
// calls until something important arrives. What it can watch, and how it
// reaches the user when it finds something.
const WATCH_SOURCES = { gmail: 'Gmail inbox' };
const REACH = {
  message: 'Message me in Craft',
  push: 'Notify my phone',
  call: 'Call me when it is very important',
};
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function normalizeAlwaysOn(a) {
  a = a && typeof a === 'object' ? a : {};
  const q = a.quiet && typeof a.quiet === 'object' ? a.quiet : {};
  const watch = (Array.isArray(a.watch) ? a.watch : ['gmail']).filter((k) => WATCH_SOURCES[k]);
  return {
    on: !!a.on,
    watch: watch.length ? [...new Set(watch)] : ['gmail'],
    reach: REACH[a.reach] ? a.reach : 'push',
    // Draft a reply in Gmail for important mail (one model call each). Off = just tell me.
    draft: a.draft !== false,
    quiet: { on: q.on !== false, from: HHMM.test(q.from) ? q.from : '22:00', to: HHMM.test(q.to) ? q.to : '07:00' },
    // Keep watching from Codeply's server while this PC is off (stores the Gmail sign-in there, encrypted).
    cloud: !!a.cloud,
    // "Call me when X emails me" (watch_email): sender, call or text, once unless repeat.
    alerts: (Array.isArray(a.alerts) ? a.alerts : []).filter((x) => x && typeof x.from === 'string' && x.from.trim())
      .slice(-20).map((x) => ({ from: x.from.trim().toLowerCase().slice(0, 200), how: x.how === 'call' ? 'call' : 'text', note: String(x.note || '').slice(0, 200), repeat: !!x.repeat, at: Number(x.at) || Date.now() })),
  };
}

// Kept in sync with bot-avatar.js (the renderer). The engine only validates.
const AVATAR_KEYS = {
  shape: ['burst9', 'burst7', 'burst12', 'flower', 'cloud', 'star', 'squircle', 'pebble', 'drop'],
  eyes: ['pills', 'dots', 'ovals', 'sleepy', 'happy', 'sparkle', 'big'],
  glasses: ['none', 'round', 'visor', 'monocle'],
  accessory: ['none', 'antenna', 'halo', 'sprout', 'sparkles', 'star'],
  mouth: ['none', 'smile', 'o', 'flat'],
  color: ['graphite', 'green', 'blue', 'yellow', 'pink', 'orange', 'purple', 'red', 'teal', 'sky', 'lime'],
};

// Keys from the earlier avatar sets (the first plush set, then a robot set),
// so bots saved before the redesign still load. Same table as LEGACY in
// bot-avatar.js.
const LEGACY_AVATAR = {
  shape: {
    bean: 'pebble', blob: 'pebble', round: 'squircle', pear: 'drop', heart: 'flower', frog: 'cloud', ghost: 'drop',
    capsule: 'squircle', pill: 'pebble', hexagon: 'burst7', octagon: 'flower', chip: 'squircle', orb: 'burst12', shield: 'drop', dome: 'cloud', monitor: 'squircle',
  },
  eyes: {
    diamond: 'pills', wide: 'ovals',
    led: 'pills', pixel: 'dots', lens: 'big', visor: 'pills', arcs: 'happy', slits: 'sleepy', rings: 'ovals', plus: 'sparkle',
  },
  glasses: { square: 'round', sunglasses: 'visor', frames: 'round', shades: 'visor', hud: 'round' },
  accessory: {
    beret: 'sprout', bowtie: 'star', cap: 'antenna', headphones: 'antenna', flower: 'sprout', crown: 'halo',
    twin: 'antenna', headset: 'antenna', propeller: 'sprout', fins: 'sparkles', badge: 'star',
  },
  mouth: { grin: 'smile', line: 'flat', curve: 'smile', wave: 'smile', grille: 'flat' },
};

function normalizeAvatar(a) {
  a = a && typeof a === 'object' ? a : {};
  const pick = (k, def) => {
    if (AVATAR_KEYS[k].includes(a[k])) return a[k];
    const old = Object.prototype.hasOwnProperty.call(LEGACY_AVATAR[k], a[k]) ? LEGACY_AVATAR[k][a[k]] : null;
    return old && AVATAR_KEYS[k].includes(old) ? old : def;
  };
  const color = AVATAR_KEYS.color.includes(a.color) || /^#[0-9a-f]{6}$/i.test(String(a.color || '')) ? String(a.color) : 'graphite';
  return {
    shape: pick('shape', 'burst9'), eyes: pick('eyes', 'pills'), color,
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
    approval: ['edit_files', 'run_commands', 'send', 'publish', 'databases', 'calendar'],
    avatar: { shape: 'burst9', eyes: 'pills', color: 'graphite' },
  },
  {
    key: 'research', name: 'Vera', role: 'specialist',
    specialty: 'Research: finds facts, docs and prior art, and cites where they came from',
    instructions: 'Search the project and the web, read the primary source, and report what you found with links or file paths. Separate facts from guesses. Never change files.',
    tone: { preset: 'professional', custom: '' }, sources: 'Official docs first, then the project itself, then reputable articles.',
    approval: ['edit_files', 'run_commands', 'send', 'publish', 'databases', 'calendar'],
    avatar: { shape: 'drop', eyes: 'big', color: 'blue' },
  },
  {
    key: 'outreach', name: 'Remy', role: 'specialist',
    specialty: 'Outreach: drafts emails, posts and messages that sound like the user',
    instructions: 'Write drafts the user can send as is: clear subject, short body, one ask. Match their voice from earlier messages. Never send anything yourself without the user saying yes.',
    tone: { preset: 'friendly', custom: '' },
    approval: ['edit_files', 'run_commands', 'send', 'publish', 'databases', 'calendar'],
    avatar: { shape: 'cloud', eyes: 'happy', color: 'pink', cheeks: true },
  },
  {
    key: 'analysis', name: 'Quinn', role: 'specialist',
    specialty: 'Analysis: digs into code, data and numbers and explains what they mean',
    instructions: 'Read the real code or data before concluding anything. Show the key numbers, the reasoning, and a clear recommendation. Say how sure you are.',
    tone: { preset: 'direct', custom: '' },
    approval: ['edit_files', 'run_commands', 'send', 'publish', 'databases', 'calendar'],
    avatar: { shape: 'squircle', eyes: 'ovals', color: 'teal', glasses: 'round' },
  },
  {
    key: 'reporting', name: 'Wren', role: 'specialist',
    specialty: 'Reporting: turns results into short, skimmable summaries and status updates',
    instructions: 'Lead with the outcome, then 3 to 5 bullets, then next steps. Plain words, no jargon, nothing invented.',
    tone: { preset: 'concise', custom: '' },
    approval: ['edit_files', 'run_commands', 'send', 'publish', 'databases', 'calendar'],
    avatar: { shape: 'star', eyes: 'dots', color: 'orange', accessory: 'sprout' },
  },
  {
    key: 'execution', name: 'Axel', role: 'specialist',
    specialty: 'Execution: writes and changes code, runs the checks, ships the change',
    instructions: 'Make the smallest change that does the job, in the project\'s own style. Run the relevant check after every change and report what really happened.',
    tone: { preset: 'concise', custom: '' },
    approval: ['run_commands', 'send', 'publish', 'databases', 'calendar'],
    avatar: { shape: 'burst7', eyes: 'sleepy', color: 'red', accessory: 'antenna' },
  },
  {
    key: 'monitoring', name: 'Juno', role: 'specialist',
    specialty: 'Monitoring: checks that things still work and flags what changed or broke',
    instructions: 'Run the checks, compare with what was expected, and report only what changed or failed, with the exact error. Suggest the next step, do not fix it yourself.',
    tone: { preset: 'direct', custom: '' },
    approval: ['edit_files', 'send', 'publish', 'databases', 'calendar'],
    avatar: { shape: 'burst12', eyes: 'sparkle', color: 'purple', accessory: 'halo' },
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
    // Which categories existed when the user last chose; newer ones default to asking.
    approvalSeen: ALL_APPROVALS.slice(),
    avatar: normalizeAvatar(b.avatar),
    // The voice it speaks with on calls (a Deepgram, Edge or Kokoro voice id; '' = pick one).
    voice: typeof b.voice === 'string' && /^[\w.-]{0,80}$/.test(b.voice) ? b.voice : '',
    alwaysOn: normalizeAlwaysOn(b.alwaysOn),
    memory: cleanMemory(b.memory),
    // Experience (learned on the job, see reflectOnRun): lessons, playbooks, tool tips, open threads.
    lessons: cleanLessons(b.lessons),
    playbooks: cleanPlaybooks(b.playbooks),
    toolTips: cleanTips(b.toolTips),
    openThreads: cleanThreads(b.openThreads),
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
      if (Array.isArray(raw.approval)) {
        const seen = Array.isArray(raw.approvalSeen) ? raw.approvalSeen : FIRST_APPROVALS;
        for (const k of ALL_APPROVALS) if (!seen.includes(k) && !raw.approval.includes(k)) raw.approval.push(k);
      }
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

// ─── Experience: learning on the job ────────────────────────────────────────
// Memory (above) is about the USER. Experience is about the WORK, after MUSE
// ("Learning on the Job", arxiv 2510.08002): after a run that used tools, the
// bot reflects once on what it did (reflectOnRun) and keeps
//   - lessons:     short <situation, what works> pairs, always in its prompt
//   - playbooks:   named procedures for work that succeeded (app / task, when
//                  to use, steps with the real tool names, precautions); a
//                  one-line index is always in the prompt, the ones that fit
//                  the current request go in full
//   - toolTips:    how tools behaved for this bot and user
//   - openThreads: what it left unfinished, until a later run finishes it
// All bounded, deduplicated, and stored on the bot file like memory.

const SECRET_RE = /(api[_ -]?key|password|passwd|secret|token|bearer)\s*[:=]|\bsk-[a-z0-9]{8,}/i;
const noSecret = (s) => !SECRET_RE.test(String(s || ''));
const cleanList = (v, max, n) => (Array.isArray(v) ? v : [])
  .filter((s) => typeof s === 'string' && s.trim() && noSecret(s))
  .map((s) => clip(s, n)).slice(0, max);

function cleanLessons(list) {
  return (Array.isArray(list) ? list : [])
    .filter((l) => l && typeof l.situation === 'string' && typeof l.strategy === 'string' && l.situation.trim() && l.strategy.trim())
    .map((l) => ({ situation: clip(l.situation, 160), strategy: clip(l.strategy, 240), at: Number(l.at) || Date.now() }))
    .slice(-MAX_LESSONS);
}

function cleanPlaybook(p) {
  if (!p || typeof p !== 'object') return null;
  const app = clip(p.app, 40);
  const task = clip(p.task, 80);
  const steps = cleanList(p.steps, 10, 200);
  if (!app || !task || !steps.length) return null;
  return {
    app, task, when: clip(p.when, 200), steps,
    precautions: cleanList(p.precautions, 6, 200),
    params: noSecret(p.params) ? clip(p.params, 300) : '',
    uses: Math.max(1, Number(p.uses) || 1),
    at: Number(p.at) || Date.now(),
  };
}

function cleanPlaybooks(list) {
  return (Array.isArray(list) ? list : []).map(cleanPlaybook).filter(Boolean).slice(-MAX_PLAYBOOKS);
}

function cleanTips(list) {
  return (Array.isArray(list) ? list : [])
    .map((t) => (typeof t === 'string' ? { tip: t } : t))
    .filter((t) => t && typeof t.tip === 'string' && t.tip.trim())
    .map((t) => ({ tip: clip(t.tip, 200), at: Number(t.at) || Date.now() }))
    .slice(-MAX_TOOL_TIPS);
}

function cleanThreads(list) {
  return (Array.isArray(list) ? list : [])
    .map((t) => (typeof t === 'string' ? { text: t } : t))
    .filter((t) => t && typeof t.text === 'string' && t.text.trim())
    .map((t) => ({ text: clip(t.text, 200), at: Number(t.at) || Date.now() }))
    .slice(-MAX_OPEN_THREADS);
}

const playbookKey = (p) => `${factKey(p.app)}|${factKey(p.task)}`;
const playbookName = (p) => `${p.app} / ${p.task}`;
const uniqueStrings = (list, max) => {
  const out = [];
  for (const s of list) if (!out.some((x) => sameFact(x, s))) out.push(s);
  return out.slice(-max);
};

/**
 * Pure merge of one reflection into a bot's experience. Same lesson
 * situation, same tool tip, same app + task: the newer one replaces (a
 * playbook is updated in place, keeping its use count and precautions).
 * @returns {{experience:object, added:object}}
 */
function mergeExperience(exp, r, now = Date.now()) {
  let lessons = cleanLessons(exp && exp.lessons);
  let playbooks = cleanPlaybooks(exp && exp.playbooks);
  let toolTips = cleanTips(exp && exp.toolTips);
  let openThreads = cleanThreads(exp && exp.openThreads);
  const added = { lessons: [], toolTips: [], playbook: null, updated: false, unfinished: '', resolved: [] };
  for (const l of cleanLessons((r && r.lessons) || [])) {
    if (!noSecret(l.situation + l.strategy)) continue;
    lessons = lessons.filter((x) => !sameFact(x.situation, l.situation) && !sameFact(x.strategy, l.strategy));
    lessons.push({ ...l, at: now });
    added.lessons.push(l);
  }
  for (const t of cleanTips(((r && r.toolTips) || []).filter(noSecret))) {
    toolTips = toolTips.filter((x) => !sameFact(x.tip, t.tip));
    toolTips.push({ ...t, at: now });
    added.toolTips.push(t.tip);
  }
  const pb = r && r.playbook ? cleanPlaybook(r.playbook) : null;
  if (pb) {
    const old = playbooks.find((x) => playbookKey(x) === playbookKey(pb));
    const merged = old
      ? { ...pb, when: pb.when || old.when, params: pb.params || old.params, precautions: uniqueStrings([...old.precautions, ...pb.precautions], 6), uses: old.uses + 1, at: now }
      : { ...pb, uses: 1, at: now };
    playbooks = playbooks.filter((x) => x !== old);
    playbooks.push(merged); // most recently used last, so the oldest unused one goes first
    added.playbook = playbookName(merged);
    added.updated = !!old;
  }
  // Open threads: resolved ones go (by number or by text), a new one is added.
  const resolved = Array.isArray(r && r.resolved) ? r.resolved : [];
  if (resolved.length) {
    const before = openThreads;
    openThreads = openThreads.filter((t, i) => !resolved.some((x) => (typeof x === 'number' ? x === i + 1 : (/^\d+$/.test(String(x).trim()) ? Number(x) === i + 1 : sameFact(t.text, x)))));
    added.resolved = before.filter((t) => !openThreads.includes(t)).map((t) => t.text);
  }
  const unfinished = r && typeof r.unfinished === 'string' && noSecret(r.unfinished) ? clip(r.unfinished, 200) : '';
  if (unfinished && !/^(none|nothing|n\/a|no)\.?$/i.test(unfinished)) {
    openThreads = openThreads.filter((t) => !sameFact(t.text, unfinished));
    openThreads.push({ text: unfinished, at: now });
    added.unfinished = unfinished;
  }
  return {
    experience: {
      lessons: lessons.slice(-MAX_LESSONS), playbooks: playbooks.slice(-MAX_PLAYBOOKS),
      toolTips: toolTips.slice(-MAX_TOOL_TIPS), openThreads: openThreads.slice(-MAX_OPEN_THREADS),
    },
    added,
  };
}

/** Merge a reflection into the stored bot (re-read first, so a parallel learn is never lost). */
function addExperience(botId, reflection) {
  const bot = getBot(botId);
  if (!bot) return { bot: null, added: null };
  const { experience, added } = mergeExperience(bot, reflection);
  return { bot: save({ ...bot, ...experience, updatedAt: Date.now() }), added };
}

const EXPERIENCE_KINDS = ['lessons', 'playbooks', 'toolTips', 'openThreads'];

/** Forget one experience item (kind + index), or everything with kind 'all'. */
function forgetExperience(botId, kind, index) {
  const bot = getBot(botId);
  if (!bot) throw new Error('That bot is gone.');
  if (kind === 'all') return save({ ...bot, lessons: [], playbooks: [], toolTips: [], openThreads: [], updatedAt: Date.now() });
  if (!EXPERIENCE_KINDS.includes(kind)) throw new Error('Unknown kind of experience.');
  const list = bot[kind].slice();
  if (index >= 0 && index < list.length) list.splice(index, 1);
  return save({ ...bot, [kind]: list, updatedAt: Date.now() });
}

const STOP = new Set('the and for with that this from what when where which your you our are was were can could would should will have has had not but all any how who why into onto about please just some them they then than there these those its it him her his she use using want need make get got give show tell check look find out new one two'.split(' '));

/** Words that carry meaning, lightly stemmed ("emails" and "email" match). */
function terms(text) {
  return [...new Set(String(text || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP.has(w))
    .map((w) => (w.length > 4 ? w.replace(/(ing|es|s)$/, '') : w)))];
}

/** The playbooks that fit a request best (keyword overlap), at most `n`, best first. */
function rankPlaybooks(playbooks, request, n = PLAYBOOKS_IN_FULL) {
  const want = terms(request);
  if (!want.length) return [];
  return (playbooks || []).map((p, i) => {
    const head = terms(`${p.app} ${p.task}`);
    const body = terms(`${p.when} ${(p.steps || []).join(' ')}`);
    let score = 0;
    for (const w of want) score += head.includes(w) ? 2 : body.includes(w) ? 0.5 : 0;
    return { p, i, score };
  }).filter((x) => x.score >= 2 || (x.score >= 1 && want.length <= 2))
    .sort((a, b) => b.score - a.score || b.p.at - a.p.at)
    .slice(0, n).map((x) => x.p);
}

/** One line per tool call: name, short args, ok or the error. */
function trajectoryLines(steps) {
  return (Array.isArray(steps) ? steps : []).filter((s) => s && s.name).slice(-30).map((s, i) => {
    let args = '';
    if (s.args && typeof s.args === 'object') {
      const short = {};
      for (const [k, v] of Object.entries(s.args)) {
        if (/content|patch|body|text|old|new/i.test(k) && typeof v === 'string' && v.length > 60) short[k] = `(${v.length} chars)`;
        else short[k] = typeof v === 'string' ? clip(v, 80) : v;
      }
      args = clip(JSON.stringify(short), 200);
    } else if (s.label) args = clip(s.label, 140);
    const result = s.ok ? 'ok' : `error${s.error ? `: ${clip(s.error, 140)}` : ''}`;
    return `${i + 1}. ${s.name} ${args} -> ${result}`;
  });
}

function reflectPrompt(bot, { request, steps, reply }) {
  const index = (bot.playbooks || []).map((p) => `- ${playbookName(p)}`).join('\n') || '(none yet)';
  const lessons = (bot.lessons || []).map((l) => `- When ${l.situation}: ${l.strategy}`).join('\n') || '(none yet)';
  const threads = (bot.openThreads || []).map((t, i) => `${i + 1}. ${t.text}`).join('\n') || '(none)';
  return `You are the reflection step of an assistant called ${bot.name}${bot.specialty ? ` (${bot.specialty})` : ''}. It just finished a piece of work with its tools. Look at what it did and decide what it should learn for next time, so it gets better on the job.

The user's request:
${clip(request, 2000) || '(not given)'}

The tool calls, in order:
${trajectoryLines(steps).join('\n') || '(none)'}

${bot.name}'s final reply:
${clip(reply, 2000) || '(no reply)'}

Playbooks it already has (reuse the exact same app and task names to update one):
${index}

Lessons it already has:
${lessons}

Open threads it left unfinished before (numbered):
${threads}

Judge the outcome from the tool results, not from what the reply claims. Then respond with ONLY a JSON object:
{
  "outcome": "success" or "partial" or "failed",
  "playbook": null, or ONLY when it succeeded and the procedure is reusable: {"app": "the app or area, e.g. Gmail, Files, Web, Shell", "task": "short task name, e.g. find important emails", "when": "one line: when to use it", "steps": ["each key step, naming the real tool used, e.g. gmail_search with q=is:important newer_than:2d"], "precautions": ["what to watch out for"], "params": "parameters or values that worked, or empty"},
  "lessons": [{"situation": "a short kind of situation", "strategy": "what works there, or what to avoid"}] (at most 2, only new and general ones),
  "toolTips": ["tool_name: how it behaved, e.g. a query or argument that worked or failed"] (at most 2),
  "unfinished": "one line about anything the user asked for that is still not done, or empty",
  "resolved": [numbers of the open threads above that this work finished]
}
Never include passwords, keys, tokens or personal secrets. Keep every line short. Never use the long dash character.`;
}

/**
 * MUSE "Reflect + Memorize": after a run that used tools, one cheap model
 * call turns the trajectory into experience on the bot. chatFn has the
 * ai.js chatJson shape. Never throws.
 * @param {object} bot
 * @param {{request:string, steps:Array<{name:string,args?:object,label?:string,ok:boolean,error?:string}>, reply:string}} run
 * @returns {Promise<{outcome?:string, added:object|null, skipped?:string}>}
 */
async function reflectOnRun(bot, run, chatFn) {
  try {
    if (!bot || !bot.id || typeof chatFn !== 'function') return { added: null, skipped: 'no bot or model' };
    const steps = (run && Array.isArray(run.steps) ? run.steps : []).filter((s) => s && s.name);
    if (!steps.length) return { added: null, skipped: 'no tools used' };
    const fresh = getBot(bot.id) || normalizeBot(bot, bot);
    const r = await chatFn([{ role: 'user', content: reflectPrompt(fresh, { ...run, steps }) }]);
    if (!r || !r.success || !r.json || typeof r.json !== 'object') return { added: null, skipped: 'no answer' };
    const j = r.json;
    const outcome = ['success', 'partial', 'failed'].includes(j.outcome) ? j.outcome : 'partial';
    const reflection = {
      playbook: outcome === 'success' ? j.playbook : null,
      lessons: (Array.isArray(j.lessons) ? j.lessons : []).slice(0, 2),
      toolTips: (Array.isArray(j.toolTips) ? j.toolTips : []).slice(0, 2),
      unfinished: j.unfinished,
      resolved: j.resolved,
    };
    const { added } = addExperience(bot.id, reflection);
    return { outcome, added };
  } catch {
    return { added: null, skipped: 'failed' };
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
The one task, with every bit of context they need. Spell out the concrete details: email addresses, names, subjects, dates, file paths. Never write "the email from earlier" or "what they told you".
</task>
</codeply:ask_bot>`;

const PHONE_RULES = `YOUR LINE TO THE USER'S PHONE
You can reach the user on their phone with reach_me, and watch their inbox with watch_email (it keeps watching in the background).
- Urgent or time critical, or they asked for a call: reach_me with how=call (the phone rings and you speak).
- Anything else worth their attention: how=text (a notification).
- "Tell me / call me when X emails me": watch_email with from=X and how=call or text. Do not say you cannot run in the background.
- A reminder at a time: reach_me with at set to that time.
- "Have Shella call me": reach_me with bot set to that bot's name, so the call comes from them.`;
const PHONE_FORMAT = `To reach the phone or watch for an email, write:
<codeply:reach_me>
<how>call</how>
<message>Your Vercel deploy just failed on main.</message>
<at>17:30</at>
<bot>(optional: the bot it comes from)</bot>
</codeply:reach_me>
<codeply:watch_email>
<from>someone@example.com</from>
<how>call</how>
</codeply:watch_email>`;

const VERIFY_RULES = `BEFORE YOU SAY IT IS DONE
- Base every claim on what your tools actually returned in this run.
- Check the deliverable exists (the file is written, the message is sent, the command passed) before you say so.
- Never invent results, numbers, names or links. If something failed or you could not check it, say so plainly.`;

const shortDate = (at) => new Date(Number(at) || Date.now()).toISOString().slice(0, 10);

function playbookText(p) {
  const lines = [`${playbookName(p)}`];
  if (p.when) lines.push(`When to use: ${p.when}`);
  lines.push('Steps:', ...(p.steps || []).map((s, i) => `${i + 1}. ${s}`));
  if ((p.precautions || []).length) lines.push('Precautions:', ...p.precautions.map((s) => `- ${s}`));
  if (p.params) lines.push(`What worked: ${p.params}`);
  return lines.join('\n');
}

/** The experience sections of a bot's prompt; `request` picks the playbooks shown in full. */
function experienceParts(bot, request) {
  const parts = [];
  const lessons = bot.lessons || [];
  if (lessons.length) {
    parts.push(`WHAT YOU HAVE LEARNED FROM PAST WORK\nStrategies from your own earlier work. Use them when the situation fits:\n${lessons.map((l) => `- When ${l.situation}: ${l.strategy}`).join('\n')}`);
  }
  const tips = bot.toolTips || [];
  if (tips.length) parts.push(`TOOL TIPS\nHow your tools behaved before:\n${tips.map((t) => `- ${t.tip}`).join('\n')}`);
  const playbooks = bot.playbooks || [];
  if (playbooks.length) {
    const top = rankPlaybooks(playbooks, request);
    const index = playbooks.slice().reverse().map((p) => `- ${playbookName(p)}${p.when ? `: ${clip(p.when, 90)}` : ''}${top.includes(p) ? ' (in full below)' : ''}`);
    parts.push(`YOUR PLAYBOOKS\nProcedures that worked for you before (app / task). Follow the matching one, and adapt it if things changed:\n${index.join('\n')}`);
    if (top.length) parts.push(`PLAYBOOKS FOR THIS REQUEST\n${top.map(playbookText).join('\n\n')}`);
  }
  const threads = bot.openThreads || [];
  if (threads.length) {
    parts.push(`OPEN THREADS\nThings you left unfinished before. Bring one up when it fits, and finish it when the user wants:\n${threads.map((t) => `- (${shortDate(t.at)}) ${t.text}`).join('\n')}`);
  }
  return parts;
}

/**
 * The system prompt addition for one bot.
 * @param {object} bot
 * @param {object} [o]
 * @param {object[]} [o.team]       every bot (the roster leaves this one out)
 * @param {boolean} [o.canDelegate] ask_bot is available in this run
 * @param {string}  [o.askedBy]     set for a delegated sub-run: who asked
 * @param {boolean} [o.native]      native function calling (no tag example)
 * @param {string}  [o.request]     the user's message: picks the playbooks shown in full
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
    parts.push(`WHAT YOU HAVE LEARNED ABOUT THIS USER\nBackground only. The current request and the recent chat always win: never assume an old item here is what the user means now (an older email, project or task). If the request is unclear, say which one you picked, or ask.\n${memory.map((m) => `- ${m.fact}`).join('\n')}`);
  }
  parts.push(...experienceParts(bot, o.request));
  if (require('./reach.js').available()) parts.push(o.native ? PHONE_RULES : `${PHONE_RULES}\n\n${PHONE_FORMAT}`);
  parts.push(VERIFY_RULES);
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
  const phone = require('./reach.js').available()
    ? `\n\nWhen the user asks a bot to call or text them ("tell Shella to call me"), do it yourself with reach_me and bot set to that bot's name, so it comes from that bot. ${o.native ? '' : PHONE_FORMAT}`
    : '';
  return `BOTS\nThe user has these bots. When they ask for one by name, or a part of the work is clearly a bot's specialty, you can hand it that part with ask_bot. Only one bot runs at a time, and you wait for its answer.\n${roster.join('\n')}${o.native ? '' : `\n\n${ASK_BOT_FORMAT}`}${phone}`;
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
      prompt: buildBotPrompt(target, { team, askedBy: callerName, canDelegate: depth + 1 < MAX_DEPTH, request: task }),
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
  for (const k of ['send', 'publish', 'databases', 'calendar']) if (!draft.approval.includes(k)) draft.approval.push(k);
  delete draft.id; delete draft.memory; delete draft.createdAt; delete draft.updatedAt;
  delete draft.lessons; delete draft.playbooks; delete draft.toolTips; delete draft.openThreads;
  return draft;
}

// ─── Voice calls ────────────────────────────────────────────────────────────
// A call turn is a real agent run: the bot keeps its tools (Gmail, files, the
// web, commands) and its approval boundary, and only the way it answers
// changes, so "check my email" on a call really checks it.

const VOICE_RULES = `LIVE VOICE CALL
You are on a live voice call with the user, talking out loud. Your final reply is spoken by a voice engine.
- You still have all your tools. When the user asks for real work (check their email, look something up, read or change a file), do it now with your tools, then tell them the result.
- Speak the result in one to three short sentences, the way people talk. Summarize: for emails say who it is from and what it is about, never read out long text, links or ids.
- No markdown, no lists, no headings, no emojis, no code, no links, no long dash in what you say.
- Ask one short question back when it helps.
- Anything that needs the user's OK (sending, changing files, running commands) is asked on their screen; if they say no, tell them plainly.`;

const VOICE_RULES_NO_TOOLS = `LIVE VOICE CALL
You are on a live voice call with the user, talking out loud. Everything you write is spoken by a voice engine.
- Reply in one to three short spoken sentences. Plain words, the way people talk.
- No markdown, no lists, no headings, no emojis, no code, no links, no long dash.
- Ask one short question back when it helps.
- Right now you cannot use your tools (email, files, the web), because the user's PC is offline. If they ask for that kind of work, say so in one sentence and offer to do it once their PC is on.`;

/** Whatever the model sent, make it sayable: no markdown, no long dashes. */
function spoken(s) {
  const dash = String.fromCharCode(0x2014);
  return String(s || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_#`>]+/g, '')
    .split(dash).join(', ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The call so far as chat turns: the last thing the user said is the new message. */
function callTurns(turns) {
  const list = (Array.isArray(turns) ? turns : []).filter((t) => t && t.text).slice(-16)
    .map((t) => ({ role: t.who === 'bot' ? 'assistant' : 'user', content: String(t.text).slice(0, 1200) }));
  let lastUser = -1;
  list.forEach((t, i) => { if (t.role === 'user') lastUser = i; });
  if (lastUser < 0) return { history: [], userMessage: '' };
  const history = [];
  for (const t of list.slice(0, lastUser)) {
    const prev = history[history.length - 1];
    if (prev && prev.role === t.role) prev.content += `\n${t.content}`; else history.push({ ...t });
  }
  while (history.length && history[0].role !== 'user') history.shift();
  return { history, userMessage: list.slice(lastUser).filter((t) => t.role === 'user').map((t) => t.content).join('\n') };
}

/**
 * One spoken reply on a call, with tools. `runAgent` is the engine's agent
 * loop; `onStep({ name, label, done, ok })` reports tool use for the call
 * screen ("Checking Gmail..."). Returns { text } ready to speak, plus
 * { request, reply, steps } for reflectOnRun.
 */
async function voiceTurn({ bot, team, turns, recentChat, runAgent, route, cwd, signal, approve, onStep, maxSteps = 16 }) {
  const { history, userMessage } = callTurns(turns);
  if (!userMessage) return { text: '' };
  const extra = recentChat ? `\n\nRECENT CHAT BEFORE THIS CALL\n${recentChat}` : '';
  const run = runAgent({
    userMessage, history, mode: 'Build', cwd, signal, route, maxSteps, approve, botId: bot.id,
    botPrompt: () => `${buildBotPrompt(bot, { team, request: userMessage })}\n\n${VOICE_RULES}${extra}`,
  });
  let reply = '';
  const steps = []; // the trajectory, for reflectOnRun after the call turn
  for await (const ev of run) {
    if (ev.type === 'text' && !ev.interim) reply += (reply ? ' ' : '') + ev.text;
    else if (ev.type === 'tool_start' && onStep) onStep({ name: ev.name, args: ev.args || {} });
    else if (ev.type === 'tool_end') {
      steps.push(runStep(ev));
      if (onStep) onStep({ name: ev.name, args: ev.args || {}, done: true, ok: !!ev.ok });
    }
    else if (ev.type === 'error') throw new Error(ev.error || 'The run failed.');
    else if (ev.type === 'aborted') throw new Error('Stopped.');
    else if (ev.type === 'done') break;
  }
  if (signal && signal.aborted) throw new Error('Stopped.'); // hung up or talked over: nothing to say
  return { text: spoken(reply), request: userMessage, reply, steps };
}

/** One agent tool_end event as a trajectory step for reflectOnRun. */
function runStep(ev) {
  return { name: ev.name, args: ev.args || {}, ok: !!ev.ok, error: ev.ok ? undefined : clip(ev.summary || ev.error || '', 200) };
}

/** What the call screen says while a tool runs. */
const CALL_STEP = {
  gmail_search: 'Checking your email', gmail_send: 'Sending the email', gmail_draft: 'Saving a draft', drafts_list: 'Looking at your drafts',
  calendar_list: 'Checking your calendar', calendar_add: 'Adding it to your calendar', web_search: 'Searching the web', image_search: 'Looking for images', reach_me: 'Reaching your phone', watch_email: 'Setting an email alert', web_fetch: 'Reading a page',
  read_file: 'Reading a file', write_file: 'Writing a file', edit_file: 'Editing a file', apply_patch: 'Editing files', run: 'Running a command',
  search: 'Searching your files', list_dir: 'Looking through files', slack_post_message: 'Posting to Slack', browser_check: 'Checking the page',
  ask_bot: 'Asking a teammate', todo: 'Planning',
};
const callStepLabel = (name) => CALL_STEP[name] || 'Working on it';

module.exports = {
  VOICE_RULES, VOICE_RULES_NO_TOOLS, spoken, callTurns, voiceTurn, callStepLabel,
  MAX_MEMORY, MAX_DEPTH, ROLES, TONES, APPROVALS, AVATAR_KEYS, TEMPLATES, WATCH_SOURCES, REACH,
  botsDir, setBotsDir, normalizeBot, normalizeAvatar, normalizeAlwaysOn,
  listBots, getBot, findBot, createBot, createFromTemplate, updateBot, removeBot,
  mergeMemory, addMemory, forget, clearMemory, learnFromTurn,
  MAX_LESSONS, MAX_PLAYBOOKS, MAX_TOOL_TIPS, MAX_OPEN_THREADS,
  mergeExperience, addExperience, forgetExperience, rankPlaybooks, reflectOnRun, runStep,
  buildBotPrompt, teamPrompt, approvalCategory, canSkipApproval,
  createLock, globalLock, parseResult, delegate, botCard,
  describePrompt, fromDescription,
};
