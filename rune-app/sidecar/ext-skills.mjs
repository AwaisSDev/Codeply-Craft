// Skills: the library the engine can follow (codeply-cli/lib/skills.js: the built-in set, plugin
// skills and yours in ~/.codeply/skills), for the composer's "/" menu and Settings > Skills; and
// what a message's "/skill" and "@mention" picks tell the agent.
//
//   GET /ext/skills           { skills: [{ name, description, source, plugin, daily, path }], count }
//   GET /ext/skills/one?name= { name, description, source, path, body }
//
// A message can carry refs (POST /session/:id/message { text, files, refs }), what the app's menus
// picked: { kind: 'skill', name }, { kind: 'file', path }, { kind: 'agent', name } and
// { kind: 'app', id, name }. engine.mjs asks every `hooks.prompt` for a note to put in front of the
// turn's prompt (never stored in the chat); this one turns refs into that note:
//   - a skill: its SKILL.md, to follow (the body as skills.js loads it, at most 8000 characters,
//     and the file's path for the rest);
//   - a file: its path, and its text when it is small;
//   - an agent: ask it with ask_bot, with what the message wants from it;
//   - an app: use it with use_app.
import fs from 'node:fs';
import path from 'node:path';

const CACHE_MS = 5000;
/** A mentioned file's text goes in the prompt up to this size; a bigger one goes by its path. */
export const MAX_FILE_CHARS = 20000;
const MAX_REFS = 12;

let cache = null; // { at, cwd, list }

/** Every skill, as skills.js lists them for `cwd` (plugins can depend on the project). */
export function listAll(ctx, cwd) {
  const now = Date.now();
  if (cache && cache.cwd === cwd && now - cache.at < CACHE_MS) return cache.list;
  const lib = ctx.need('skills.js');
  const list = lib.listSkills(cwd).map((s) => ({
    name: String(s.name || ''),
    description: String(s.description || '').replace(/\s+/g, ' ').trim(),
    source: s.source === 'user' ? 'user' : s.source === 'plugin' ? 'plugin' : 'built-in',
    plugin: s.plugin || '',
    daily: !!s.daily,
    path: s.dir ? path.join(s.dir, 'SKILL.md') : '',
  })).filter((s) => s.name);
  cache = { at: now, cwd, list };
  return list;
}

/** One skill with its body, or null. */
function loadSkill(ctx, cwd, name) {
  const s = listAll(ctx, cwd).find((x) => x.name === name) || listAll(ctx, cwd).find((x) => x.name.toLowerCase() === String(name).toLowerCase());
  if (!s) return null;
  let body = null;
  try { body = ctx.need('skills.js').loadSkillBody(s.name, cwd); } catch {}
  return { ...s, body: body || '' };
}

/** A project file for a mention: its path, and its text when small and not binary. */
function loadFile(ctx, cwd, rel) {
  for (const root of [...new Set([ctx.DEFAULT_CWD, cwd].filter(Boolean))]) {
    const abs = ctx.inside(root, rel);
    if (!abs) continue;
    let st;
    try { st = fs.statSync(abs); } catch { continue; }
    if (st.isDirectory()) return { path: rel, abs, dir: true };
    if (!st.isFile()) continue;
    if (st.size > MAX_FILE_CHARS) return { path: rel, abs, size: st.size };
    try {
      const buf = fs.readFileSync(abs);
      if (buf.subarray(0, 8000).includes(0)) return { path: rel, abs, size: st.size, binary: true };
      return { path: rel, abs, size: st.size, text: buf.toString('utf8') };
    } catch { return { path: rel, abs, size: st.size }; }
  }
  return null;
}

/** Only well-formed refs, without repeats, at most MAX_REFS. */
export function cleanRefs(refs) {
  if (!Array.isArray(refs)) return [];
  const out = [];
  const seen = new Set();
  for (const r of refs) {
    if (!r || typeof r !== 'object') continue;
    const kind = String(r.kind || '');
    const ref = kind === 'skill' ? { kind, name: String(r.name || '').trim() }
      : kind === 'file' ? { kind, path: String(r.path || '').trim() }
      : kind === 'agent' ? { kind, name: String(r.name || '').trim() }
      : kind === 'app' ? { kind, id: String(r.id || '').trim(), name: String(r.name || r.id || '').trim() }
      : null;
    if (!ref || !(ref.name || ref.path || ref.id)) continue;
    const key = `${kind}:${ref.name || ref.path || ref.id}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
    if (out.length >= MAX_REFS) break;
  }
  return out;
}

const fence = (text) => {
  const t = String(text);
  const ticks = t.includes('```') ? '````' : '```';
  return `${ticks}\n${t.replace(/\s+$/, '')}\n${ticks}`;
};

/**
 * The note for a message's refs, or ''. `env` looks things up (so tests can stub it):
 *   skill(name) -> { name, path, body } | null
 *   file(path)  -> { path, abs, text?, size?, dir?, binary? } | null
 *   agent(name) -> { name, role } | null
 *   app(id, name) -> { id, title } | null
 */
export function refsPrompt(refs, env) {
  const list = cleanRefs(refs);
  if (!list.length) return '';
  const parts = [];
  for (const r of list.filter((x) => x.kind === 'skill')) {
    const s = env.skill(r.name);
    if (!s) { parts.push(`The user picked the skill "/${r.name}", but there is no skill by that name. Say so, and do the task as well as you can.`); continue; }
    const where = s.path ? ` Its file is ${s.path}; read it (and anything it points to) if you need more than is here.` : '';
    parts.push(s.body
      ? `The user picked the skill "${s.name}" for this message. Follow it.${where}\n\nSKILL: ${s.name}\n${fence(s.body)}`
      : `The user picked the skill "${s.name}" for this message. Read its SKILL.md and follow it.${where}`);
  }
  const files = list.filter((x) => x.kind === 'file');
  if (files.length) {
    const lines = ['Files the user mentioned (paths are relative to the project folder):'];
    for (const r of files) {
      const f = env.file(r.path);
      if (!f) lines.push(`- ${r.path} (not found in the project)`);
      else if (f.dir) lines.push(`- ${r.path} (a folder: ${f.abs})`);
      else if (typeof f.text === 'string') lines.push(`- ${r.path} (${f.abs}):\n${fence(f.text)}`);
      else lines.push(`- ${r.path} (${f.abs}${f.binary ? ', not text' : f.size ? `, ${Math.round(f.size / 1024)} KB: read it with your tools` : ''})`);
    }
    parts.push(lines.join('\n'));
  }
  const agents = list.filter((x) => x.kind === 'agent').map((r) => env.agent(r.name) || { name: r.name, missing: true });
  const known = agents.filter((a) => !a.missing);
  if (known.length) {
    const names = known.map((a) => `${a.name}${a.role ? ` (${a.role})` : ''}`).join(', ');
    parts.push(`The user mentioned ${known.length === 1 ? 'the agent' : 'the agents'} ${names}. Ask ${known.length === 1 ? 'it' : 'each one'} with ask_bot (bot = the agent's name, task = what the message wants from ${known.length === 1 ? 'it' : 'that agent'}, with the context it needs), wait for the answer, and pass on what ${known.length === 1 ? 'it says' : 'they say'}. Do not do ${known.length === 1 ? 'its' : 'their'} part yourself.`);
  }
  for (const a of agents.filter((x) => x.missing)) parts.push(`The user mentioned "@${a.name}", but there is no agent by that name on the team. Say so.`);
  for (const r of list.filter((x) => x.kind === 'app')) {
    const a = env.app(r.id, r.name);
    parts.push(a
      ? `The user wants you to use the app ${a.title || a.id} for this. Call it with use_app (app = "${a.id}"), using the tools it lists under APPS AND MCP SERVERS.`
      : `The user mentioned the app "${r.name || r.id}", but it is not connected. Say so, and that they can connect it in Integrations > Apps.`);
  }
  return parts.length ? `[${parts.join('\n\n')}]\n\n` : '';
}

/** Whether refs ask for an agent (ask_bot must be on for that turn). */
export const wantsAgents = (refs) => cleanRefs(refs).some((r) => r.kind === 'agent');

export function start(ctx) {
  // engine.mjs startRun: the note for this turn's refs, put in front of its prompt.
  ctx.hooks.prompt = ctx.hooks.prompt || [];
  ctx.hooks.prompt.push(async (session, refs) => {
    if (!cleanRefs(refs).length) return '';
    const cwd = session.cwd || ctx.DEFAULT_CWD;
    let apps = {};
    try { apps = ctx.need('apps.js').mcpServers(); } catch {}
    const env = {
      skill: (name) => { try { return loadSkill(ctx, cwd, name); } catch { return null; } },
      file: (rel) => loadFile(ctx, cwd, rel),
      agent: (name) => (ctx.findMember ? ctx.findMember(name) : null),
      app: (id, name) => {
        if (apps[id]) return { id, title: apps[id].title || id };
        const byName = Object.entries(apps).find(([, v]) => String(v.title || '').toLowerCase() === String(name || '').toLowerCase());
        return byName ? { id: byName[0], title: byName[1].title || byName[0] } : null;
      },
    };
    return refsPrompt(refs, env);
  });
}

export async function route(ctx, req, res, url, p, reply) {
  if (req.method !== 'GET' || !p.startsWith('/ext/skills')) return false;
  const cwd = url.searchParams.get('cwd') && fs.existsSync(url.searchParams.get('cwd')) ? path.resolve(url.searchParams.get('cwd')) : ctx.DEFAULT_CWD;
  if (p === '/ext/skills') {
    try {
      const skills = listAll(ctx, cwd);
      reply(200, { skills, count: skills.length });
    } catch (e) { reply(e.status || 500, { skills: [], count: 0, error: e.message }); }
    return true;
  }
  if (p === '/ext/skills/one') {
    const s = loadSkill(ctx, cwd, url.searchParams.get('name') || '');
    if (!s) reply(404, { error: 'No skill by that name.' });
    else reply(200, s);
    return true;
  }
  return false;
}
