/**
 * Layered configuration.
 *
 *   user     ~/.config/dvn/config.json          (or --config <path>)
 *   project  <dir>/.dvn/config.json             for every dir from the project
 *   local    <dir>/.dvn/config.local.json       root down to cwd
 *
 * Devin's own .devin/config*.json files are read as a compatible source at
 * the same levels, so a repo already set up for Devin works unchanged.
 *
 * Precedence (high to low): session > local > project > user. Only
 * permissions, hooks and read_config_from are multi-level; everything else
 * is user-only. Permission lists are unioned with their level remembered,
 * hooks from every file all run, read_config_from is overridden per key.
 * A broken file produces a warning and is skipped; it never takes the
 * other files down with it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse, setIn } from './jsonc.mjs';
import { PROJECT_DIR, projectRoot, userConfigFile } from './paths.mjs';

export const COMPAT_DIR = '.devin';
export const LEVELS = ['user', 'project', 'local', 'session'];
export const READ_CONFIG_KEYS = ['devin', 'agents_standard', 'cursor', 'windsurf', 'claude', 'copilot', 'opencode', 'zed'];

export const DEFAULTS = {
  agent: { model: null, subagent_model: null, show_history_on_continue: true, compaction_threshold_tokens: null, verbosity: 1 },
  theme_mode: null,
  show_hints: true,
  respect_gitignore: false,
  attribution: true,
  subagents_enabled: true,
  notify: 'smart',
  disabled_tools: [],
  skip_workspace_trust: false,
  'workspace-dirs': [],
  shell: { exec_shell: 'bash' },
  models: {},
};

export function readJsonFile(file, warnings) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  if (!text.trim()) return {};
  try {
    const v = parse(text);
    if (!v || typeof v !== 'object' || Array.isArray(v)) { warnings?.push(`${file}: expected a JSON object; ignored`); return null; }
    return v;
  } catch (e) {
    warnings?.push(`${file}: ${e.message}; ignored`);
    return null;
  }
}

/** Directories from the project root down to cwd (root first). */
export function projectDirs(cwd) {
  const root = projectRoot(cwd);
  const dirs = [];
  let d = path.resolve(cwd);
  for (;;) {
    dirs.unshift(d);
    if (d === root) break;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return dirs;
}

function deepMerge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
  const out = { ...(base && typeof base === 'object' && !Array.isArray(base) ? base : {}) };
  for (const [k, v] of Object.entries(over)) out[k] = deepMerge(out[k], v);
  return out;
}

/**
 * Load every layer for cwd. Returns
 *   { settings, permissions: [{effect, rule, level, source}], hooks: [{file, hooks}],
 *     readConfigFrom, files: [{level, file}], warnings, root }
 */
export function loadConfig({ cwd = process.cwd(), configPath } = {}) {
  const warnings = [];
  const files = [];
  const userFile = configPath ? path.resolve(configPath) : userConfigFile();
  const user = readJsonFile(userFile, warnings) || {};
  files.push({ level: 'user', file: userFile, data: user, exists: fs.existsSync(userFile) });

  const root = projectRoot(cwd);
  for (const dir of projectDirs(cwd)) {
    for (const ns of [COMPAT_DIR, PROJECT_DIR]) {
      for (const [level, name] of [['project', 'config.json'], ['local', 'config.local.json']]) {
        const file = path.join(dir, ns, name);
        const data = readJsonFile(file, warnings);
        if (data) files.push({ level, file, data, exists: true });
      }
    }
  }

  // User-only settings come from the user file alone.
  const settings = deepMerge(DEFAULTS, user);
  for (const f of files) {
    if (f.level === 'user') continue;
    const extra = Object.keys(f.data).filter((k) => !['permissions', 'hooks', 'read_config_from', 'requiredPlugins', 'optionalPlugins', 'forbiddenPlugins', 'mcpServers', '$schema'].includes(k));
    if (extra.length) warnings.push(`${f.file}: ${extra.join(', ')} only take effect in the user config; ignored here`);
  }

  const permissions = [];
  for (const f of files) {
    const p = f.data.permissions || {};
    for (const effect of ['allow', 'deny', 'ask']) {
      for (const rule of Array.isArray(p[effect]) ? p[effect] : []) permissions.push({ effect, rule: String(rule), level: f.level, source: f.file });
    }
  }

  const hooks = files.filter((f) => f.data.hooks && typeof f.data.hooks === 'object').map((f) => ({ file: f.file, hooks: f.data.hooks, level: f.level }));

  const readConfigFrom = Object.fromEntries(READ_CONFIG_KEYS.map((k) => [k, true]));
  // user < project < local: later files override per key; null means true.
  const order = [...files].sort((a, b) => LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level));
  for (const f of order) {
    for (const [k, v] of Object.entries(f.data.read_config_from || {})) readConfigFrom[k] = v === null ? true : !!v;
  }

  return { settings, permissions, hooks, readConfigFrom, files, warnings, root, userFile };
}

/** Write one key into a config file, keeping the rest of its text intact. */
export function updateConfigFile(file, keys, value) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* new file */ }
  const next = setIn(text, keys, value);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next.endsWith('\n') ? next : next + '\n');
}

/** Append a permission rule at a level ("project" | "local" | "user"). */
export function persistPermission({ level, effect = 'allow', rule, root, userFile }) {
  const file = level === 'user' ? userFile || userConfigFile()
    : path.join(root, PROJECT_DIR, level === 'local' ? 'config.local.json' : 'config.json');
  const data = readJsonFile(file) || {};
  const list = Array.isArray(data.permissions?.[effect]) ? data.permissions[effect] : [];
  if (list.includes(rule)) return file;
  updateConfigFile(file, ['permissions', effect], [...list, rule]);
  if (level === 'local') ensureGitExcluded(root, path.relative(root, file));
  return file;
}

/** Files with ".local." in their name stay out of git via .git/info/exclude. */
export function ensureGitExcluded(root, rel) {
  const gitDir = path.join(root, '.git');
  if (!fs.existsSync(gitDir) || !fs.statSync(gitDir).isDirectory()) return;
  const file = path.join(gitDir, 'info', 'exclude');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* none yet */ }
  const entry = rel.split(path.sep).join('/');
  if (text.split('\n').some((l) => l.trim() === entry)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text + (text && !text.endsWith('\n') ? '\n' : '') + entry + '\n');
}
