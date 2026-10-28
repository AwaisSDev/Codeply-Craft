/**
 * Skills: SKILL.md folders that become /slash commands and/or are offered to
 * the agent through the `skill` tool.
 *
 * Frontmatter (all optional): name, description, argument-hint, model,
 * subagent, agent, allowed-tools (auto-approved while the skill runs, not a
 * restriction), permissions {allow,deny,ask}, triggers (default [user, model]).
 * The body supports $ARGUMENTS and $1..$9 (shell-style argument split).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from './frontmatter.mjs';
import { configDir, homeDir, tildify } from '../config/paths.mjs';
import { projectDirs } from '../config/config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DOCS_DIR = path.resolve(here, '..', '..', 'docs');

export const BUILTIN_SKILLS = [
  {
    name: 'dvn-cli',
    description: 'Look up dvn documentation (commands, configuration, rules, skills, hooks, MCP, permissions)',
    triggers: ['model'],
    provider: 'Builtin',
    base_dir: DOCS_DIR,
    body: `The dvn documentation is in ${DOCS_DIR}. Use glob and read on that folder to answer questions about dvn itself: its commands, config files, permission rules, rules, skills, hooks and MCP setup.`,
  },
  {
    name: 'init',
    description: 'Write or refresh an AGENTS.md that tells agents how to build, test and work in this repository',
    triggers: ['user', 'model'],
    provider: 'Builtin',
    base_dir: '',
    body: 'Explore this repository (layout, languages, build and test commands, conventions in existing code, CI config) and write a concise AGENTS.md at the project root for future agents. Keep it short and specific: commands that actually work here, where things live, and rules a newcomer would get wrong. If AGENTS.md exists, improve it instead of replacing what is still accurate. $ARGUMENTS',
  },
];

function userLocations(enabled) {
  const h = homeDir();
  const out = [
    { dir: path.join(configDir(), 'skills'), provider: 'dvn' },
    { dir: path.join(h, '.agents', 'skills'), provider: 'Agents' },
  ];
  if (enabled.devin !== false) out.push({ dir: path.join(h, '.config', 'devin', 'skills'), provider: 'Devin' });
  if (enabled.windsurf !== false) for (const ch of ['windsurf', 'windsurf-next', 'windsurf-insiders']) out.push({ dir: path.join(h, '.codeium', ch, 'skills'), provider: 'Windsurf' });
  if (enabled.cursor !== false) out.push({ dir: path.join(h, '.cursor', 'skills'), provider: 'Cursor' });
  if (enabled.claude !== false) out.push({ dir: path.join(h, '.claude', 'skills'), provider: 'Claude', deep: true });
  if (enabled.copilot !== false) out.push({ dir: path.join(process.env.COPILOT_HOME || path.join(h, '.copilot'), 'skills'), provider: 'Copilot', deep: true });
  return out;
}

function projectLocations(dir, enabled) {
  const out = [
    { dir: path.join(dir, '.dvn', 'skills'), provider: 'dvn' },
    { dir: path.join(dir, '.agents', 'skills'), provider: 'Agents' },
  ];
  if (enabled.devin !== false) out.push({ dir: path.join(dir, '.devin', 'skills'), provider: 'Devin' });
  if (enabled.windsurf !== false) out.push({ dir: path.join(dir, '.windsurf', 'skills'), provider: 'Windsurf' });
  if (enabled.cursor !== false) out.push({ dir: path.join(dir, '.cursor', 'skills'), provider: 'Cursor' });
  if (enabled.claude !== false) {
    out.push({ dir: path.join(dir, '.claude', 'skills'), provider: 'Claude', deep: true });
    out.push({ dir: path.join(dir, '.claude', 'commands'), provider: 'Claude', commands: true });
  }
  if (enabled.copilot !== false) out.push({ dir: path.join(dir, '.github', 'skills'), provider: 'Copilot', deep: true });
  return out;
}

function findSkillFiles(loc) {
  const out = [];
  if (!fs.existsSync(loc.dir)) return out;
  if (loc.commands) {
    const visit = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) visit(p);
        else if (e.name.endsWith('.md')) out.push({ file: p, base: path.dirname(p), id: path.relative(loc.dir, p).replace(/\.md$/, '').split(path.sep).join(':') });
      }
    };
    visit(loc.dir);
    return out;
  }
  const visit = (d, depth) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      let isDir = e.isDirectory();
      if (e.isSymbolicLink()) { try { isDir = fs.statSync(p).isDirectory(); } catch { continue; } }
      if (!isDir) continue;
      const skill = path.join(p, 'SKILL.md');
      if (fs.existsSync(skill)) out.push({ file: skill, base: p, id: e.name });
      else if (loc.deep && depth < 4) visit(p, depth + 1);
    }
  };
  visit(loc.dir, 0);
  return out;
}

function asList(v, dflt) {
  if (v === undefined || v === null || v === '') return dflt;
  return (Array.isArray(v) ? v : String(v).split(/[,\s]+/)).map(String).filter(Boolean);
}

function loadSkill({ file, base, id }, provider, scope) {
  const text = fs.readFileSync(file, 'utf8');
  const { data, body } = parseFrontmatter(text);
  const warnings = [];
  const triggers = asList(data.triggers, ['user', 'model']).filter((t) => {
    if (t === 'user' || t === 'model') return true;
    warnings.push(`unknown trigger '${t}'`);
    return false;
  });
  return {
    name: String(data.name || id),
    id,
    description: data.description ? String(data.description) : '',
    argumentHint: data['argument-hint'] ? String(data['argument-hint']) : '',
    model: data.model ? String(data.model) : null,
    agent: data.agent ? String(data.agent) : data.subagent === true ? 'subagent_general' : null,
    allowedTools: asList(data['allowed-tools'], []),
    permissions: data.permissions && typeof data.permissions === 'object' ? data.permissions : null,
    triggers,
    provider,
    scope,
    base_dir: base,
    path: file,
    body,
    warnings,
    errors: [],
  };
}

export function discoverSkills({ cwd = process.cwd(), readConfigFrom = {}, extraDirs = [] } = {}) {
  const found = [];
  const seenReal = new Set();
  const take = (loc, scope) => {
    for (const s of findSkillFiles(loc)) {
      let real;
      try { real = fs.realpathSync(s.file); } catch { continue; }
      if (seenReal.has(real)) continue;
      seenReal.add(real);
      try { found.push(loadSkill(s, loc.provider, scope)); } catch (e) {
        found.push({ name: s.id, id: s.id, description: '', triggers: [], provider: loc.provider, scope, base_dir: s.base, path: s.file, body: '', warnings: [], errors: [e.message] });
      }
    }
  };
  for (const loc of userLocations(readConfigFrom)) take(loc, 'user');
  const project = [];
  const before = found.length;
  for (const dir of [...projectDirs(cwd), ...extraDirs]) for (const loc of projectLocations(dir, readConfigFrom)) take(loc, 'project');
  project.push(...found.splice(before));
  project.sort((a, b) => a.base_dir.localeCompare(b.base_dir));
  const all = [...found, ...project];

  // Same name from two places: keep both, prefixed by where they came from.
  const byName = new Map();
  for (const s of all) byName.set(s.name, (byName.get(s.name) || 0) + 1);
  for (const s of all) s.display_name = byName.get(s.name) > 1 ? `${s.provider.toLowerCase()}:${s.name}` : s.name;

  for (const b of BUILTIN_SKILLS) {
    if (byName.has(b.name)) continue;
    all.push({ ...b, id: b.name, display_name: b.name, path: '', argumentHint: '', model: null, agent: null, allowedTools: [], permissions: null, scope: 'builtin', warnings: [], errors: [] });
  }
  return all;
}

/** Split args like a shell: quotes group, backslash escapes. */
export function shellSplit(s) {
  const out = [];
  let cur = '';
  let q = null;
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
      else if (c === '\\' && q === '"' && i + 1 < s.length) cur += s[++i];
      else cur += c;
    } else if (c === '"' || c === "'") { q = c; has = true; }
    else if (c === '\\' && i + 1 < s.length) { cur += s[++i]; has = true; }
    else if (/\s/.test(c)) { if (cur || has) { out.push(cur); cur = ''; has = false; } }
    else { cur += c; has = true; }
  }
  if (cur || has) out.push(cur);
  return out;
}

export function renderSkill(skill, args = '') {
  const argv = shellSplit(args);
  let body = skill.body.replace(/\$ARGUMENTS\b/g, args).replace(/\$([1-9])\b/g, (_, n) => argv[Number(n) - 1] ?? '');
  if (args && !/\$ARGUMENTS|\$[1-9]/.test(skill.body)) body += `\n\nARGUMENTS: ${args}`;
  return body;
}

export function skillLocationLabel(s, cwd) {
  if (s.scope === 'builtin') return s.base_dir || 'built-in';
  if (s.scope === 'user') return tildify(s.base_dir);
  const rel = path.relative(cwd, s.base_dir);
  return rel.startsWith('..') ? s.base_dir : `./${rel}`;
}

export function skillPaths() {
  return {
    user: [path.join(configDir(), 'skills'), path.join(homeDir(), '.agents', 'skills'), path.join(homeDir(), '.config', 'devin', 'skills')].map((d) => `${d}/<skill-name>/SKILL.md`),
    project: ['.dvn/skills', '.agents/skills', '.devin/skills', '.claude/skills', '.windsurf/skills'].map((d) => `${d}/<skill-name>/SKILL.md`),
  };
}
