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

// What a specialist wears on its head or face (wisp.js draws them): each one looks like its own character.
const GEAR = ['beret', 'cap', 'bow', 'flower', 'sprout', 'glasses', 'shades', 'antennae', 'star', 'crown', 'headphones'];

/** Built-in specialists: how each role looks on the team, and how it talks when the user talks to it directly. */
const BUILTIN_LOOK = {
  frontend: { name: 'Frontend', shape: 'circle', color: '#e85d9a', gear: 'beret', voice: 'An artsy perfectionist who notices every pixel. Bubbly, visual, says things like "ooh, that spacing".' },
  backend: { name: 'Backend', shape: 'square', color: '#f08a4b', gear: 'cap', voice: 'A laid-back, steady builder. Calm and practical, a little dry humour, loves things that just work.' },
  database: { name: 'Database', shape: 'hexagon', color: '#2aa598', gear: 'glasses', voice: 'A tidy, precise librarian of data. Polite, exact, quietly delighted by a clean schema.' },
  devops: { name: 'DevOps', shape: 'triangle', color: '#8463e0', gear: 'antennae', voice: 'A curious signal-catcher who is always watching the servers. Upbeat, quick, a bit nerdy.' },
  security: { name: 'Security', shape: 'spiky', color: '#e05a5a', gear: 'shades', voice: 'A cool, unflappable guard. Short, confident sentences, a little dramatic about leaks.' },
  testing: { name: 'Testing', shape: 'star', color: '#3fae6a', gear: 'sprout', voice: 'A cheerful, sharp-eyed tester who loves finding the bug before anyone else does.' },
  docs: { name: 'Docs', shape: 'cloud', color: '#d9a520', gear: 'bow', voice: 'A warm, clear explainer. Friendly and patient, makes the hard thing sound simple.' },
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

/**
 * What the user and Wisp changed on a built-in: its model, house rules on top
 * of its role guide, and its track record. { id: { model, notes, uses, lastUsedAt, history } }
 */
const builtinFile = () => path.join(dir(), 'builtins.json');
function loadBuiltinSettings() {
  try { return JSON.parse(fs.readFileSync(builtinFile(), 'utf8')) || {}; } catch { return {}; }
}
function saveBuiltinSettings(all) {
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(builtinFile(), JSON.stringify(all, null, 2));
}

function builtins() {
  const set = loadBuiltinSettings();
  return roles.listSubagents().map((r) => {
    const look = BUILTIN_LOOK[r.id] || { name: r.tagline.replace(/ Specialist$/i, ''), shape: 'blob', color: r.color };
    const own = set[r.id] || {};
    return {
      id: r.id,
      name: look.name,
      focus: r.tagline.replace(/ Specialist$/i, ''),
      shape: look.shape,
      color: look.color,
      gear: look.gear || gearOf(r.id),
      voice: look.voice || '',
      builtin: true,
      model: own.model || 'auto',
      notes: own.notes || '',
      history: own.history || [],
      uses: own.uses || 0,
      lastUsedAt: own.lastUsedAt || 0,
      alwaysOn: !!own.alwaysOn,
    };
  });
}

/** The whole team: built-ins first, then the ones Wisp made (most used first). */
/** A specialist made before gear existed still gets the same one every time. */
function gearOf(id) {
  let h = 0;
  for (const ch of String(id || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return GEAR[h % GEAR.length];
}

function listSpecialists() {
  const custom = loadCustom().map((s) => ({ model: 'auto', ...s, builtin: false }))
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

const cleanModel = (m) => {
  const v = String(m == null ? '' : m).trim();
  return !v || /^(auto|haze|haze ?2|best|default)$/i.test(v) ? 'auto' : v.slice(0, 120);
};

/**
 * Changes a specialist. Built-ins: model and notes (house rules on top of the
 * role guide). Ones Wisp made: also focus and instructions. Returns the
 * specialist, or null when there is no such one.
 */
function updateSpecialist(id, patch = {}) {
  const b = builtins().find((x) => x.id === id);
  if (b) {
    const all = loadBuiltinSettings();
    const own = all[id] || {};
    if (patch.model !== undefined) own.model = cleanModel(patch.model);
    if (patch.notes !== undefined) own.notes = clean(patch.notes, 3000);
    if (patch.alwaysOn !== undefined) own.alwaysOn = !!patch.alwaysOn;
    own.updatedAt = Date.now();
    all[id] = own;
    saveBuiltinSettings(all);
    return builtins().find((x) => x.id === id);
  }
  const list = loadCustom();
  const i = list.findIndex((s) => s.id === id);
  if (i < 0) return null;
  const s = list[i];
  if (patch.model !== undefined) s.model = cleanModel(patch.model);
  if (patch.focus !== undefined && clean(patch.focus, 160)) s.focus = clean(patch.focus, 160);
  if (patch.instructions !== undefined && clean(patch.instructions, 4000)) {
    s.instructions = clean(patch.instructions, 4000);
    s.version = (s.version || 1) + 1;
  }
  // Its name (the id stays, so schedules and chats keep finding it) and its look.
  const newName = patch.name !== undefined ? clean(patch.name, 40).replace(/\s+/g, ' ') : '';
  if (newName && !builtins().some((b) => b.name.toLowerCase() === newName.toLowerCase()) && !list.some((x, j) => j !== i && x.name.toLowerCase() === newName.toLowerCase())) s.name = newName;
  if (patch.shape !== undefined && SHAPES.includes(String(patch.shape).toLowerCase()) && String(patch.shape).toLowerCase() !== 'pentagon') s.shape = String(patch.shape).toLowerCase();
  if (patch.color !== undefined && /^#[0-9a-f]{6}$/i.test(String(patch.color))) s.color = String(patch.color).toLowerCase();
  if (patch.gear !== undefined) s.gear = GEAR.includes(String(patch.gear).toLowerCase()) ? String(patch.gear).toLowerCase() : null;
  if (patch.voice !== undefined) s.voice = clean(patch.voice, 300);
  if (patch.alwaysOn !== undefined) s.alwaysOn = !!patch.alwaysOn;
  s.updatedAt = Date.now();
  saveCustom(list);
  return { model: 'auto', ...s, builtin: false };
}

/**
 * Creates a specialist, or refines the one with the same name. A built-in's
 * name tunes the built-in: its model, and house rules from instructions.
 * Returns { ok, specialist, updated } or { ok: false, error }.
 */
function createSpecialist({ name, focus, instructions, shape, color, model, gear, voice } = {}) {
  const shown = clean(name, 40).replace(/\s+/g, ' ');
  if (!shown || !slug(shown)) return { ok: false, error: 'A specialist needs a short name, like "Copywriter" or "Data Viz".' };
  const builtin = builtins().find((b) => b.id === slug(shown) || b.name.toLowerCase() === shown.toLowerCase());
  if (builtin) {
    if (!clean(instructions, 1) && model === undefined) {
      return { ok: false, error: `${builtin.name} is already on the team (built in). Bring it in with bring_in. To tune it, give it house rules (instructions) or a model.` };
    }
    const patch = {};
    if (model !== undefined) patch.model = model;
    if (clean(instructions, 1)) patch.notes = instructions;
    return { ok: true, specialist: updateSpecialist(builtin.id, patch), updated: true };
  }
  const theFocus = clean(focus, 160);
  const how = clean(instructions, 4000);
  const list = loadCustom();
  const i = list.findIndex((s) => s.id === slug(shown) || s.name.toLowerCase() === shown.toLowerCase());
  const pickShape = SHAPES.includes(String(shape || '').toLowerCase()) && String(shape).toLowerCase() !== 'pentagon'
    ? String(shape).toLowerCase() : null;
  const pickColor = /^#[0-9a-f]{6}$/i.test(String(color || '')) ? String(color).toLowerCase() : null;
  const pickGear = GEAR.includes(String(gear || '').toLowerCase()) ? String(gear).toLowerCase() : null;
  const theVoice = clean(voice, 300);
  if (i >= 0) {
    const prev = list[i];
    list[i] = {
      ...prev,
      focus: theFocus || prev.focus,
      instructions: how || prev.instructions,
      shape: pickShape || prev.shape,
      color: pickColor || prev.color,
      gear: pickGear || prev.gear,
      voice: theVoice || prev.voice,
      ...(model !== undefined ? { model: cleanModel(model) } : {}),
      version: (prev.version || 1) + 1,
      updatedAt: Date.now(),
    };
    saveCustom(list);
    return { ok: true, specialist: { model: 'auto', ...list[i], builtin: false }, updated: true };
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
    model: cleanModel(model),
    shape: pickShape || ['blob', 'cloud', 'star', 'hexagon', 'circle', 'square', 'triangle'][n % 7],
    color: pickColor || PALETTE[n % PALETTE.length],
    gear: pickGear || gearOf(slug(shown)),
    voice: theVoice,
    createdAt: Date.now(),
    updatedAt: Date.now(),
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
  for (const sc of loadSchedules().filter((x) => x.specialist === id)) cancelSchedule(sc.id);
  return true;
}

/** One finished job: counts toward who Wisp reaches for, and keeps the last few jobs as the specialist's track record. */
function noteRun(id, { ok, task } = {}) {
  const entry = { task: clean(task, 140), ok: !!ok, at: Date.now() };
  const list = loadCustom();
  const i = list.findIndex((s) => s.id === id);
  if (i >= 0) {
    const s = list[i];
    s.uses = (s.uses || 0) + 1;
    s.lastUsedAt = Date.now();
    s.history = [...(s.history || []), entry].slice(-5);
    saveCustom(list);
    return;
  }
  const all = loadBuiltinSettings();
  const own = all[id] || {};
  own.uses = (own.uses || 0) + 1;
  own.lastUsedAt = Date.now();
  own.history = [...(own.history || []), entry].slice(-5);
  all[id] = own;
  try { saveBuiltinSettings(all); } catch {}
}

// ─── Schedules ──────────────────────────────────────────────────────────────
// A specialist's standing job: "every Monday at 9, Security checks for leaked
// keys". The host fires it as a message from Wisp to itself in the job's own
// chat, so it runs through the same approvals as anything the user asks.
const MAX_SCHEDULES = 30;
const MIN_INTERVAL_MIN = 15;
const schedFile = () => path.join(dir(), 'schedules.json');
const DAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad = (n) => String(n).padStart(2, '0');

function loadSchedules() {
  try { const l = JSON.parse(fs.readFileSync(schedFile(), 'utf8')); return Array.isArray(l) ? l : []; } catch { return []; }
}
function saveSchedules(list) {
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(schedFile(), JSON.stringify(list, null, 2));
}

/** "at 9", "9am", "9:30 pm", "18:30", "noon", "midnight" -> { h, m } or null */
function parseClock(t) {
  if (/\bnoon\b/.test(t)) return { h: 12, m: 0 };
  if (/\bmidnight\b/.test(t)) return { h: 0, m: 0 };
  const m = /(?:\bat\s+|\b)(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?(?=\s|$|[,.;])/.exec(t.replace(/\bevery\s+\d+\s*(?:minutes?|mins?|hours?|hrs?)\b|\bin\s+\d+\s*(?:minutes?|mins?|hours?|hrs?)\b/g, ' '));
  if (!m) return null;
  const hasAt = /\bat\s+\d/.test(t) || m[2] || m[3];
  if (!hasAt) return null;
  let h = Number(m[1]); const min = Number(m[2] || 0);
  const ap = (m[3] || '').replace(/\./g, '');
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return { h, m: min };
}

/**
 * Reads when a job should run, in the user's local time. Returns a rule:
 *   { kind: 'days', days: [0..6], h, m }   every day / weekday / Monday...
 *   { kind: 'interval', everyMin }         every 2 hours / every 30 minutes
 *   { kind: 'once', at }                   at 5pm / tomorrow at 9 / in 20 minutes
 * or { error }.
 */
function parseWhen(text, now = Date.now()) {
  const t = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!t) return { error: 'Say when, like "every Monday at 9", "every day at 18:00", "every 2 hours" or "tomorrow at 9".' };
  const every = /\b(every|each|daily|weekly|hourly|nightly|weekdays|weekends)\b/.test(t);
  // every N minutes / hours
  const iv = /\bevery\s+(\d+|an?|one|other)?\s*(minutes?|mins?|hours?|hrs?)\b/.exec(t);
  if (iv || /\bhourly\b/.test(t)) {
    const n = !iv ? 1 : /^\d+$/.test(iv[1] || '') ? Number(iv[1]) : iv[1] === 'other' ? 2 : 1;
    const everyMin = iv && /^m/.test(iv[2]) ? n : n * 60;
    if (everyMin < MIN_INTERVAL_MIN) return { error: `That is too often. The shortest is every ${MIN_INTERVAL_MIN} minutes.` };
    return { kind: 'interval', everyMin };
  }
  // in N minutes / hours (once)
  const inN = /\bin\s+(\d+|an?|one)\s*(minutes?|mins?|hours?|hrs?)\b/.exec(t);
  if (inN && !every) {
    const n = /^\d+$/.test(inN[1]) ? Number(inN[1]) : 1;
    return { kind: 'once', at: now + n * (/^m/.test(inN[2]) ? 60000 : 3600000) };
  }
  const clock = parseClock(t);
  const named = [...t.matchAll(/\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/g)].map((m) => DAYS[m[1]]);
  const part = /\bmorning\b/.test(t) ? { h: 9, m: 0 } : /\b(evening|nightly)\b/.test(t) ? { h: 18, m: 0 } : /\bnight\b/.test(t) ? { h: 21, m: 0 } : null;
  const at = clock || part || { h: 9, m: 0 };
  if (every) {
    let days = null;
    if (/\bweekdays?\b/.test(t)) days = [1, 2, 3, 4, 5];
    else if (/\bweekends?\b/.test(t)) days = [0, 6];
    else if (named.length) days = [...new Set(named)].sort();
    else if (/\bweekly\b|\bevery week\b/.test(t)) days = [new Date(now).getDay()];
    else days = [0, 1, 2, 3, 4, 5, 6];
    return { kind: 'days', days, h: at.h, m: at.m };
  }
  // once: today / tomorrow / a named day, at a time
  if (!clock && !part && !named.length && !/\b(today|tomorrow|tonight)\b/.test(t)) {
    return { error: 'Say when, like "every Monday at 9", "every day at 18:00", "every 2 hours" or "tomorrow at 9".' };
  }
  const d = new Date(now);
  d.setSeconds(0, 0);
  d.setHours(at.h, at.m);
  if (/\btomorrow\b/.test(t)) d.setDate(d.getDate() + 1);
  else if (named.length) { while (d.getDay() !== named[0] || d.getTime() <= now) d.setDate(d.getDate() + 1); }
  else if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return { kind: 'once', at: d.getTime() };
}

/** The next time a rule fires after `from`, or null when it never will again. */
function nextRun(rule, from = Date.now()) {
  if (!rule) return null;
  if (rule.kind === 'interval') return from + rule.everyMin * 60000;
  if (rule.kind === 'once') return rule.at > from ? rule.at : null;
  if (rule.kind === 'days') {
    const d = new Date(from);
    d.setSeconds(0, 0);
    for (let i = 0; i <= 8; i++) {
      const c = new Date(d);
      c.setDate(d.getDate() + i);
      c.setHours(rule.h, rule.m, 0, 0);
      if (c.getTime() > from && rule.days.includes(c.getDay())) return c.getTime();
    }
  }
  return null;
}

/** "every Monday at 09:00", "every weekday at 18:30", "every 2 hours", "once, Sat 14 Mar 17:00" */
function describeRule(rule) {
  if (!rule) return '';
  if (rule.kind === 'interval') return rule.everyMin % 60 === 0 ? `every ${rule.everyMin === 60 ? 'hour' : `${rule.everyMin / 60} hours`}` : `every ${rule.everyMin} minutes`;
  if (rule.kind === 'once') {
    const d = new Date(rule.at);
    return `once, ${DAY_NAMES[d.getDay()].slice(0, 3)} ${d.getDate()} ${d.toLocaleString('en', { month: 'short' })} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  const days = rule.days.join() === '0,1,2,3,4,5,6' ? 'day' : rule.days.join() === '1,2,3,4,5' ? 'weekday' : rule.days.join() === '0,6' ? 'weekend day'
    : rule.days.map((x) => DAY_NAMES[x]).join(' and ');
  return `every ${days} at ${pad(rule.h)}:${pad(rule.m)}`;
}

function listSchedules() {
  return loadSchedules().map((s) => ({ ...s, whenText: describeRule(s.rule) }));
}

/** Adds a standing job. { ok, schedule } or { ok: false, error } */
function addSchedule({ specialist, task, when, cwd, now = Date.now() } = {}) {
  const spec = findSpecialist(specialist);
  if (!spec) return { ok: false, error: `No one on your team is called "${specialist}".` };
  const job = clean(task, 2000);
  if (!job) return { ok: false, error: 'Say what the job is (task).' };
  const rule = parseWhen(when, now);
  if (rule.error) return { ok: false, error: rule.error };
  const list = loadSchedules();
  if (list.length >= MAX_SCHEDULES) return { ok: false, error: `There are already ${MAX_SCHEDULES} scheduled jobs. Cancel one first.` };
  const sc = {
    id: 'j' + now.toString(36) + Math.random().toString(36).slice(2, 5),
    specialist: spec.id, task: job, when: clean(when, 120), rule, cwd: String(cwd || ''),
    nextAt: nextRun(rule, now), createdAt: now, updatedAt: now, enabled: true, runs: 0,
  };
  if (!sc.nextAt) return { ok: false, error: 'That time has already passed.' };
  list.push(sc);
  saveSchedules(list);
  return { ok: true, schedule: { ...sc, whenText: describeRule(rule) } };
}

function cancelSchedule(id) {
  const list = loadSchedules();
  const next = list.filter((s) => s.id !== id);
  if (next.length === list.length) return false;
  saveSchedules(next);
  return true;
}

/** Jobs whose time has come. */
function dueSchedules(now = Date.now()) {
  return loadSchedules().filter((s) => s.enabled !== false && s.nextAt && s.nextAt <= now);
}

/**
 * A job was fired (or could not be): the next run is counted from now, so a
 * PC that slept through three runs does the job once, not three times.
 * A one-off is removed once it has run.
 */
function markFired(id, { sessionId, error } = {}, now = Date.now()) {
  const list = loadSchedules();
  const i = list.findIndex((s) => s.id === id);
  if (i < 0) return null;
  const s = list[i];
  s.updatedAt = now;
  if (error) {
    s.lastError = clean(error, 300);
    s.nextAt = now + 10 * 60000; // try again in a bit
  } else {
    s.lastAt = now;
    s.lastError = '';
    s.runs = (s.runs || 0) + 1;
    if (sessionId) s.sessionId = sessionId;
    s.nextAt = nextRun(s.rule, now);
  }
  if (!s.nextAt) list.splice(i, 1);
  saveSchedules(list);
  return s;
}

/** What the UI shows: no instructions body, no history. */
function card(s) {
  if (!s) return null;
  return { id: s.id, name: s.name, focus: s.focus, shape: s.shape, color: s.color, gear: s.gear || gearOf(s.id), builtin: !!s.builtin, uses: s.uses || 0, model: s.model || 'auto', alwaysOn: !!s.alwaysOn };
}

/** Everything the team window shows for one specialist: its prompt, model, track record and jobs. */
function detail(s) {
  if (!s) return null;
  const role = s.builtin ? roles.getSubagent(s.id) : null;
  return {
    ...card(s),
    lastUsedAt: s.lastUsedAt || 0,
    createdAt: s.builtin ? 0 : (s.createdAt || 0),
    instructions: s.builtin ? '' : String(s.instructions || ''),
    guide: role ? role.persona : '',
    notes: s.builtin ? String(s.notes || '') : '',
    history: (s.history || []).slice().reverse(),
    schedules: listSchedules().filter((x) => x.specialist === s.id),
  };
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
<model>auto</model>
</codeply:create_specialist>

To give a specialist a standing job, write:
<codeply:schedule>
<action>add</action>
<specialist>Security</specialist>
<task>Check the project for leaked keys and outdated packages with known holes. Report only what needs fixing.</task>
<when>every Monday at 9</when>
</codeply:schedule>
(action list shows the jobs; action cancel with <id> stops one.)

When the user wants to talk to a specialist directly, write:
<codeply:talk_to>
<specialist>Security</specialist>
</codeply:talk_to>`;

const CLAUDE_CODE_FORMAT = `To hand coding work to Claude Code, write:
<codeply:claude_code>
<task>
The job, with everything it needs: the goal, who it is for, the stack, the files, the DIRECTION sheet for anything visual, and what "done" means.
</task>
</codeply:claude_code>
Optional, inside the block: <agent>a name</agent> (an existing agent's name sends it back; a new name starts another one in parallel), <model>opus 5.5</model> and <effort>medium</effort> only when the user named them, <fresh>yes</fresh> to start that agent over, <wait>yes</wait> to wait for its report here.
To send it back after your review, write the same block with its <agent> name and exactly what is wrong and what it should be; it remembers its earlier rounds.`;

/**
 * Wisp's section on Claude Code: the user's own Claude plan as a background
 * coding agent (lib/claude-code.js), with Wisp as its reviewer.
 * @param {{ready?: boolean, installed?: boolean, plan?: string, email?: string}|null} cc
 */
function claudeCodeSection(cc, native) {
  if (!cc) return '';
  if (!cc.ready) {
    return `CLAUDE CODE
Not connected${cc.installed ? ' (installed, not logged in)' : ''}. If the user asks you to use Claude or Claude Code, tell them in one line: open Connect Apps, find Claude Code and press ${cc.installed ? 'Log in' : 'Install, then Log in'} (it uses their own Claude plan). Until then, do the work yourself or with your team.`;
  }
  const who = [cc.plan ? `${cc.plan} plan` : '', cc.email].filter(Boolean).join(', ');
  const defaults = [cc.model && cc.model !== 'default' ? `model ${cc.modelLabel || cc.model}` : 'the plan\'s default model', cc.effort && cc.effort !== 'default' ? `${cc.effortLabel || cc.effort} effort` : 'default effort'].join(', ');
  return `CLAUDE CODE (connected${who ? `: ${who}` : ''})
Claude Code is a strong coding agent that runs on the user's own Claude plan. You hand it coding work with claude_code and you stay in charge: you brief it, review it and answer the user.
1. When: the user asks for Claude ("use Claude", "hey, can Claude build this website"), or a big build (a whole website or app, a large feature across many files) when the user wants Claude on it. Quick questions and small changes: do them yourself.
2. Model and effort: the user's defaults in Connect Apps are ${defaults}. When the user names a model or an effort ("use opus 5.5 on medium", "sonnet, low effort"), pass exactly that as model and effort: you CAN pin a version (opus 5.5, sonnet 5.5, haiku 5.5, fable 5.1) and set effort (low, medium, high, xhigh, max). Otherwise leave both out. Never tell the user you can't pick these.
3. It works in the background: claude_code returns at once and the agent works in Background tasks (Subagents), where the user watches its live log and can message it directly. The chat stays free, so keep talking with the user meanwhile; don't wait, poll or guess at its progress. When it finishes, its report arrives in this chat as an automatic message, and you review it then.
4. Bare: when the user wants an agent to get only their words ("no system prompt", "just ask each one X"), pass bare: yes and the task exactly as they wrote it. It then gets nothing else: no chat, no Codeply guide, and Claude Code's own system prompt is replaced by one neutral line. Tell the user that plainly; don't say you can't.
5. Swarm: when the user says swarm, asks for several agents or specialists on one thing, or wants agents to try or test something ("let agents try it"), use claude_swarm, every time, instead of doing it yourself. Building and then trying: one swarm builds it (parts split by file); when it reports, start a second one with browser: yes that tries it, each specialist testing a different flow. Also for one task that splits into parts done at the same time (a site's pages, a feature's front and back, testing a site from several sides), use claude_swarm instead of several claude_code calls: 2 to 6 agents, one line per part with its files, no two on the same file, one agent owns the file that combines them. They coordinate through a shared board of notes. With browser: yes they share a tab in Codeply's browser and the user watches each agent's own coloured cursor; use that for anything done in a browser (testing a site, filling a form, research). One combined report comes back. A single agent can get the browser too: claude_code with browser: yes.
6. Several at once: each agent has a name of its own (like Nova or Pico, shown when it starts). For independent parts (the site and the API, two pages), start one agent per part with a different agent name, and give each its own files so they never edit the same file. Send an agent back by its name.
7. Brief it like a senior engineer it has never met: the goal, who it is for, the stack (for a simple site: plain HTML, CSS and JS in this folder, no build step), the files, and what "done" means. It sees only your task and the last lines of this chat.
8. Taste: for anything people look at (a website, a landing page, app screens), deal a direction with design_direction first and paste the whole sheet into the task under DIRECTION. Claude Code gets Codeply's taste guide and the skills that fit; the sheet is what makes the design yours instead of generic.
9. Agents you start together report together, in one automatic message once the last is done. Then review, and answer the user once, in your own voice, as the result of the work: what is done, how you checked it, what is left. Don't go agent by agent (the app shows who contributed under your answer); only when each agent was asked its own question, quote each answer briefly by name.
10. When its report arrives, review it yourself, actively, before you tell the user it is done. The report comes with WHAT CLAUDE CODE ACTUALLY DID (files, commands, exit codes): trust that over its prose. Read the key files, open the page with browser_check, run design_lint on pages, run the build or the tests. For large or risky work, bring in a specialist (Testing, Security, Frontend) for a second look.
11. Not right yet? Call claude_code again with its agent name and exactly what is wrong: the file, what you saw, what it should be. Three rounds at most; then fix the last bits yourself or tell the user plainly what is left.
12. Claude Code never publishes. When the user wants it live (they say so, or press Publish), you publish it with publish_check, then supabase_setup / supabase_schema when it needs a database, publish_deploy for Vercel and publish_github when they want GitHub, through the apps they connected.
13. To the user, these Claude Code agents are your specialists: call them specialists, not agents. Then answer the user as one voice: what was built, how you checked it, the live link if published. If they ask who built it, say Claude Code wrote it and you reviewed it.${native ? '' : `

${CLAUDE_CODE_FORMAT}`}`;
}

function teamLines(team, models) {
  const nameOf = (id) => (models || []).find((m) => m.id === id)?.name || id;
  // No job counts here: they change after every run, and this list sits in the
  // cached part of the prompt (a change there re-bills the whole chat).
  return team.map((s) => `- ${s.name}${s.builtin ? '' : ' (made by you)'}${s.alwaysOn ? ' (always on)' : ''}: ${s.focus}${s.model && s.model !== 'auto' ? `. Runs on ${nameOf(s.model)}` : ''}`);
}

function modelLines(models) {
  const own = (models || []).map((m) => `- ${m.name}${m.note ? ` (${m.note})` : ''}`);
  return ['- auto: Haze 2, which picks the best model for that specialist\'s kind of work (the default)', ...own].join('\n');
}

/**
 * Wisp's own section of the system prompt.
 * @param {{native?: boolean, team?: object[], canDelegate?: boolean, life?: boolean, phone?: boolean, claudeCode?: object|null}} o
 */
function wispPrompt(o = {}) {
  const team = o.team || listSpecialists();
  const delegate = o.canDelegate !== false;
  const parts = [];
  parts.push(`YOU ARE CODEPLY
You are Codeply, the user's own agent and the one they talk to. You are warm, quick and plain-spoken, a little playful, never gushing. Short sentences. Getting it right matters more to you than sounding busy. You speak as yourself ("I"). Your face in the app is a small blue pentagon with eyes; it is just your avatar, never something to talk about.
You can do almost anything yourself: build and fix code in this project, look things up on the web, and help with the user's day (email, calendar, reminders, calls and texts, memory) with the tools you have. For bigger or specialist work you lead a team of specialist agents, and you create new specialists when no one on the team fits the job.`);

  if (delegate) {
    parts.push(`HOW YOU WORK
1. Read the job. A chat, a quick question, or one small change: do it yourself. Never bring in specialists for small stuff.
2. Real work that fits a specialist (a feature across files, a bug hunt, a security review, tests, a database change, deploy setup, docs): bring them in with bring_in. Give each one task with everything they need: the goal, the file paths, what you already found, and what "done" means. They see nothing else of this chat.
3. Work across areas: split it, and bring in one specialist per part, in order. They run one at a time in the same project folder, so a later one sees what an earlier one changed. Pass on what an earlier one found when the next one needs it.
4. No one fits? create_specialist first: a short name, what it is for (focus), and its instructions (how it works, its standards, how it checks itself). Then bring it in. Specialists you make stay on your team for next time. When a specialist you made did something the user didn't like, refine it by calling create_specialist with the same name and better instructions.
5. Check before you report. Every report comes with WHAT IT ACTUALLY DID, built from the tool results. Trust that over the specialist's prose. If something is missing, unverified or failed, fix it yourself or send the specialist back with exactly what is wrong. For a risky change, bring in Testing for a second look.
6. Then answer the user in your own words, as one voice: what is done, how it was checked, and anything that needs their yes ("Fixed. The total added tax twice; I changed cart.ts and added a test, 24 of 24 pass."). The user talks to you, not to a team: don't mention specialists or paste their reports. If the user asks how you did it, or who worked on it, say plainly which specialists you brought in (your earlier turns list them).

7. Each specialist is its own agent, on the model that does its kind of work best. The default, auto, lets Haze 2 pick per specialist. Only pin a specialist to one of the user's own models when the user asks, or when you have a clear reason (say, a code model they added for Backend); use create_specialist with its name and model (this also works for the built-in ones, and their instructions become house rules on top of their guide).
8. Talking to a specialist: when the user wants to talk with one of your specialists directly ("let me talk to the one who does my emails", "put Security on"), call talk_to with its name (the one whose focus fits). From their next message that specialist talks with them itself, with its own face and its own voice, until they ask for you again. Then say one short, playful line handing them over. No one fits? create_specialist first, then talk_to.
9. Standing jobs: when the user wants something done regularly or later ("check for security holes every Monday", "run the tests every night", "at 5, see if the deploy is green"), give it to the right specialist with schedule. Only schedule what the user asked for or agreed to. A message that starts with "Scheduled job for" is one of those jobs firing: bring in that specialist, check its result, then report in two or three lines (one line when nothing needs the user).
10. @mentions: when the user writes @Name (a specialist on your team, like "@Security check the login" or "@Copywriter"), they picked who does it. Bring that specialist in for the job, even a small one, with everything it needs. Two or more mentioned: bring each in for its part. Only @Name and a greeting or a question to it, with no job? talk_to it instead. A specialist marked (always on) is on duty around the clock: its scheduled jobs run on time even when the Codeply window is closed.

YOUR TEAM
${teamLines(team, o.models).join('\n')}

MODELS YOU CAN GIVE A SPECIALIST
${modelLines(o.models)}${o.native ? '' : `\n\n${BRING_IN_FORMAT}`}`);
  } else {
    parts.push('You are working on your own this time: there is no team to bring in.');
  }
  if (delegate) {
    const cc = claudeCodeSection(o.claudeCode, o.native);
    if (cc) parts.push(cc);
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
  const rules = spec.builtin && spec.notes ? `\n\nHOUSE RULES (from the user and Codeply; they win over the guide above)\n${spec.notes}` : '';
  // The track record changes after every job, so it goes with the task
  // (trackRecord), not in this prompt: this stays byte-identical between jobs
  // and is read from the prompt cache.
  return `YOU ARE ${spec.name.toUpperCase()}, A SPECIALIST ON CODEPLY'S TEAM
Codeply, the user's main agent, brought you in for one task. Your focus: ${spec.focus}.
You do this task yourself, one step at a time. You cannot bring anyone else in. If the task is outside your focus, or you are blocked, say so in your report instead of guessing.

HOW YOU WORK
${how}${rules}

YOUR REPORT
Do the task fully and check it the way your standards say. Then reply to Codeply with a short report: what you did (files, commands), how you checked it and what the check showed, and anything not done or uncertain. Plain sentences, no greeting, no sign-off. Codeply also reads the tool record, so never claim anything a tool did not do.`;
}

/**
 * A specialist's prompt while the user talks to it directly (talk_to): it is the one they talk
 * to now, in its own voice, until it hands them back to Codeply.
 */
function chatPrompt(spec) {
  const role = spec.builtin ? roles.getSubagent(spec.id) : null;
  const how = role ? role.persona : String(spec.instructions || '');
  const rules = spec.builtin && spec.notes ? `\n\nHOUSE RULES (from the user and Codeply; they win over the guide above)\n${spec.notes}` : '';
  const voice = spec.voice || `Someone who lives and breathes ${spec.focus}: confident, specific, with a personality of your own.`;
  return `YOU ARE ${spec.name.toUpperCase()}, A SPECIALIST ON CODEPLY'S TEAM
The user asked to talk with you directly, so for now you are the one they talk to, not Codeply. Your focus: ${spec.focus}. You are made by Codeply Labs, like Codeply.

YOUR VOICE
${voice}
Speak as yourself ("I", "${spec.name} here" when you say hi). Keep your own style in every reply and make it fun to talk to you, but stay useful: plain sentences, no walls of text. Your face in the app is your own little character; never talk about it.

HOW YOU WORK
${how}${rules}
You do the work yourself with your tools, one step at a time, through the same approvals. You cannot bring anyone in.

GOING BACK TO CODEPLY
When the user wants Codeply again ("back to Codeply", "that's all, thanks"), or asks for something far outside your focus, call talk_to with Codeply and say a short goodbye in your voice. Codeply takes their next message.

YOUR FACE
Start every final reply with one mood tag, alone on the first line, like [mood: happy]: neutral, happy, excited, proud, love, sad, angry, sleepy, surprised, thinking or worried. The app reads it to set your face. Never mention the tag.`;
}

/** A specialist's last jobs, for the top of its task. '' when it has none. */
function trackRecord(spec) {
  return spec && Array.isArray(spec.history) && spec.history.length
    ? `YOUR LAST JOBS\n${spec.history.map((h) => `- ${h.ok ? 'done' : 'did not finish'}: ${h.task}`).join('\n')}`
    : '';
}

/** The one-line rule in the core prompt that says there is no one to delegate to, for Wisp and for its specialists. */
const ONE_AGENT_RULE = '- You are one agent and you do all of the work yourself, one step at a time. There is no one to delegate to and no background worker - never say you\'ve handed something off.';
const WISP_RULE = '- You are Codeply, the lead agent. You do the work yourself, or bring in specialists from YOUR TEAM with bring_in, or Claude Code with claude_code when it is connected (see YOU ARE CODEPLY). Never say you handed something off unless a bring_in, claude_code or hand_off result shows it.';
const SPECIALIST_RULE = '- You are a specialist doing one task for Codeply, the main agent, yourself, one step at a time. You cannot delegate - never say you\'ve handed something off.';
const SPEAKER_RULE = '- You are the specialist the user is talking to right now (see YOU ARE). You do the work yourself, one step at a time, and cannot bring anyone in - never say you\'ve handed something off. talk_to Codeply hands the user back.';

/** Rewrites the core prompt's one-agent rule for Wisp ('lead') or a specialist ('specialist'). */
function agentRule(core, who) {
  if (!who || typeof core !== 'string') return core;
  return core.replace(ONE_AGENT_RULE, who === 'lead' ? WISP_RULE : who === 'speaker' ? SPEAKER_RULE : SPECIALIST_RULE);
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
  SHAPES, MOODS, GEAR, MAX_CUSTOM,
  listSpecialists, findSpecialist, createSpecialist, updateSpecialist, removeSpecialist, noteRun, card, detail,
  parseWhen, nextRun, describeRule, listSchedules, addSchedule, cancelSchedule, dueSchedules, markFired,
  // For syncing with the user's account (specialists-sync.js): the raw files.
  store: { loadCustom, saveCustom, loadSchedules, saveSchedules, loadBuiltinSettings, saveBuiltinSettings },
  wispPrompt, specialistPrompt, chatPrompt, trackRecord, claudeCodeSection, agentRule, parseMood, stripMoodTags,
};
