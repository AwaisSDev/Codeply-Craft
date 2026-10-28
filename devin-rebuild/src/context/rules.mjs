/**
 * Rules: always-on and triggered context, gathered from every format a
 * repo may already have.
 *
 *   Standard   AGENTS.md, AGENTS.local.md, AGENT.md, agents.md, .windsurfrules
 *   Claude     CLAUDE.md, ~/.claude/CLAUDE.md
 *   dvn        .dvn/rules/**.md, .dvn/global_rules.md, ~/.config/dvn/rules/
 *   Devin      .devin/rules/**.md, .devin/global_rules.md, ~/.devin/rules/
 *   Windsurf   .windsurf/rules/**.md, .windsurf/global_rules.md
 *   Cursor     .cursor/rules/**.md|.mdc
 *
 * Activation: always-on, glob (when the agent touches a matching file),
 * agent-decidable (listed by description; the agent reads it when relevant)
 * and manual (only when the user asks). Files in the project root load at
 * start; ones in subdirectories load when the agent first works there.
 * Each always-on file is capped at 32 KiB.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from './frontmatter.mjs';
import { configDir, homeDir } from '../config/paths.mjs';
import { projectDirs } from '../config/config.mjs';
import { matchGlob } from '../util/glob.mjs';

export const RULE_CAP = 32 * 1024;
const STANDARD_FILES = ['AGENTS.md', 'AGENTS.local.md', 'AGENT.md', 'agents.md', '.windsurfrules'];
const PROVIDER_ORDER = ['Cursor', 'dvn', 'Devin', 'Windsurf', 'Claude', 'Standard'];

function listMd(dir, exts = ['.md']) {
  const out = [];
  const visit = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) visit(p);
      else if (exts.includes(path.extname(e.name))) out.push(p);
    }
  };
  visit(dir);
  return out;
}

function asList(v) {
  if (v === undefined || v === null || v === '') return [];
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
  return String(v).split(',').map((s) => s.trim()).filter(Boolean);
}

function read(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function alwaysOnRule(file, provider, scopeDir) {
  const text = read(file);
  if (text === null) return null;
  const name = path.basename(file).replace(/\.md$/i, '').replace(/^\./, '');
  return { name, provider, path: file, activation: { alwaysOn: true, globs: [], decidable: false }, description: '', body: text, scopeDir };
}

/** Windsurf/Devin-format rule: `trigger:` always_on | manual | model_decision | agent | glob. */
function triggerRule(file, provider, scopeDir) {
  const text = read(file);
  if (text === null) return null;
  const { data, body } = parseFrontmatter(text);
  const trigger = String(data.trigger || (data.alwaysApply ? 'always_on' : data.globs ? 'glob' : data.description ? 'model_decision' : 'always_on'));
  const globs = asList(data.globs);
  return {
    name: path.basename(file).replace(/\.mdc?$/i, ''),
    provider,
    path: file,
    description: data.description ? String(data.description) : '',
    activation: {
      alwaysOn: trigger === 'always_on',
      globs: trigger === 'glob' ? globs : [],
      decidable: trigger === 'model_decision' || trigger === 'agent',
      manual: trigger === 'manual',
    },
    body,
    scopeDir,
  };
}

/** Cursor .mdc: alwaysApply / globs / description. */
function cursorRule(file, scopeDir) {
  const text = read(file);
  if (text === null) return null;
  const { data, body } = parseFrontmatter(text);
  const globs = asList(data.globs);
  const always = data.alwaysApply === true || data.alwaysApply === 'true';
  return {
    name: path.basename(file).replace(/\.mdc?$/i, ''),
    provider: 'Cursor',
    path: file,
    description: data.description ? String(data.description) : '',
    activation: { alwaysOn: always, globs: always ? [] : globs, decidable: !always && !!data.description, manual: !always && !globs.length && !data.description },
    body,
    scopeDir,
  };
}

export function activationLabel(r) {
  const parts = [];
  if (r.activation.globs.length) parts.push(`globs: ${r.activation.globs.join(', ')}`);
  if (r.activation.alwaysOn) parts.push('always-on');
  if (r.activation.decidable) parts.push('agent-decidable');
  if (!parts.length) parts.push('manual');
  return parts.join(', ');
}

/** Rules that live directly in one directory (not its .x/rules folders). */
function dirRules(dir, enabled) {
  const out = [];
  if (enabled.agents_standard !== false) {
    const seen = new Set();
    for (const n of STANDARD_FILES) {
      const f = path.join(dir, n);
      if (!fs.existsSync(f)) continue;
      const real = fs.realpathSync(f);
      if (seen.has(real.toLowerCase())) continue; // AGENTS.md vs agents.md on case-insensitive disks
      seen.add(real.toLowerCase());
      const r = alwaysOnRule(f, 'Standard', dir);
      if (r) out.push(r);
    }
  }
  if (enabled.claude !== false && fs.existsSync(path.join(dir, 'CLAUDE.md'))) {
    const r = alwaysOnRule(path.join(dir, 'CLAUDE.md'), 'Claude', dir);
    if (r) out.push(r);
  }
  return out;
}

function folderRules(dir, enabled) {
  const out = [];
  const add = (r) => { if (r) out.push(r); };
  for (const f of listMd(path.join(dir, '.dvn', 'rules'))) add(triggerRule(f, 'dvn', dir));
  if (enabled.devin !== false) for (const f of listMd(path.join(dir, '.devin', 'rules'))) add(triggerRule(f, 'Devin', dir));
  if (enabled.windsurf !== false) for (const f of listMd(path.join(dir, '.windsurf', 'rules'))) add(triggerRule(f, 'Windsurf', dir));
  if (enabled.cursor !== false) for (const f of listMd(path.join(dir, '.cursor', 'rules'), ['.md', '.mdc'])) add(cursorRule(f, dir));
  // One global_rules.md per directory: .dvn beats .devin beats .windsurf.
  const globals = [['.dvn', 'dvn', true], ['.devin', 'Devin', enabled.devin !== false], ['.windsurf', 'Windsurf', enabled.windsurf !== false]];
  for (const [ns, provider, on] of globals) {
    const f = path.join(dir, ns, 'global_rules.md');
    if (on && fs.existsSync(f)) { add(alwaysOnRule(f, provider, dir)); break; }
  }
  return out;
}

function userRules(enabled) {
  const out = [];
  const add = (r) => { if (r) out.push(r); };
  for (const n of ['AGENTS.md', 'AGENT.md']) {
    const f = path.join(configDir(), n);
    if (fs.existsSync(f)) add(alwaysOnRule(f, 'dvn', null));
  }
  for (const f of listMd(path.join(configDir(), 'rules'))) add(triggerRule(f, 'dvn', null));
  if (enabled.devin !== false) {
    for (const f of listMd(path.join(homeDir(), '.devin', 'rules'))) add(triggerRule(f, 'Devin', null));
    const g = path.join(homeDir(), '.devin', 'global_rules.md');
    if (fs.existsSync(g)) add(alwaysOnRule(g, 'Devin', null));
  }
  if (enabled.claude !== false) {
    const f = path.join(homeDir(), '.claude', 'CLAUDE.md');
    if (fs.existsSync(f)) add(alwaysOnRule(f, 'Claude', null));
  }
  return out;
}

/** All rules visible from cwd at session start. */
export function discoverRules({ cwd = process.cwd(), readConfigFrom = {} } = {}) {
  const rules = [...userRules(readConfigFrom)];
  for (const dir of projectDirs(cwd)) rules.push(...folderRules(dir, readConfigFrom), ...dirRules(dir, readConfigFrom));
  const seen = new Set();
  const unique = rules.filter((r) => { const k = fs.realpathSync(r.path); if (seen.has(k)) return false; seen.add(k); return true; });
  return unique.sort((a, b) => PROVIDER_ORDER.indexOf(a.provider) - PROVIDER_ORDER.indexOf(b.provider));
}

export function capped(r) {
  if (Buffer.byteLength(r.body) <= RULE_CAP) return r.body;
  return Buffer.from(r.body).subarray(0, RULE_CAP).toString('utf8').replace(/�$/, '')
    + `\n\n[Truncated at 32 KiB. Read ${r.path} for the rest.]`;
}

/**
 * Tracks which rules are in context and surfaces new ones as the agent
 * moves around the tree: nested AGENTS.md files and glob-triggered rules.
 */
export class RuleTracker {
  constructor({ cwd, readConfigFrom, rules }) {
    this.cwd = path.resolve(cwd);
    this.readConfigFrom = readConfigFrom;
    this.rules = rules;
    this.injected = new Set(rules.filter((r) => r.activation.alwaysOn).map((r) => r.path));
    this.visitedDirs = new Set(projectDirs(cwd));
  }

  /** Rules newly relevant because the agent touched `file`. Returns text or ''. */
  onPathTouched(file) {
    const abs = path.resolve(this.cwd, file);
    const fresh = [];
    // Nested always-on files between cwd and the file's directory.
    let dir = fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);
    const chain = [];
    while (dir.startsWith(this.cwd + path.sep) && !this.visitedDirs.has(dir)) { chain.unshift(dir); dir = path.dirname(dir); }
    for (const d of chain) {
      this.visitedDirs.add(d);
      const found = [...dirRules(d, this.readConfigFrom), ...folderRules(d, this.readConfigFrom)];
      this.rules.push(...found);
      fresh.push(...found.filter((r) => r.activation.alwaysOn));
    }
    // Glob rules matching this path, relative to the rule's own directory.
    for (const r of this.rules) {
      if (!r.activation.globs.length || this.injected.has(r.path)) continue;
      const base = r.scopeDir || this.cwd;
      const rel = path.relative(base, abs);
      if (rel.startsWith('..')) continue;
      if (r.activation.globs.some((g) => matchGlob(g, rel))) fresh.push(r);
    }
    const out = fresh.filter((r) => !this.injected.has(r.path));
    out.forEach((r) => this.injected.add(r.path));
    return out.map((r) => `<rule name="${r.name}" source="${r.path}">\n${capped(r).trim()}\n</rule>`).join('\n');
  }
}
