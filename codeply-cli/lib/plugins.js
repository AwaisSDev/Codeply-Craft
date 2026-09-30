/**
 * Plugins: a folder (usually a git repo) that bundles things Craft already
 * knows how to load, so people can share a whole setup with one command.
 *
 *   my-plugin/
 *     codeply-plugin.json   { "name", "version", "description", "author", "homepage", "instructions": ["instructions.md"] }
 *     commands/*.md         slash commands, run as /my-plugin:name
 *     skills/<n>/SKILL.md   skills the agent can load
 *     mcp.json              { "mcpServers": { ... } }  (also .mcp.json)
 *     instructions.md       rules added to the agent's prompt
 *
 * Installed to ~/.codeply/plugins/<name> (every project) or
 * <project>/.codeply/plugins/<name> (this project; same name wins).
 * Plugins hold no executable hooks of their own: MCP servers are the only
 * thing that can start a process, and install shows their exact commands and
 * asks first. `.claude-plugin/plugin.json` and `.mcp.json` are read too, so
 * plugins written in that layout install as they are.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const MANIFEST_FILES = ['codeply-plugin.json', 'plugin.json', path.join('.claude-plugin', 'plugin.json')];
const RECORD_FILE = '.codeply-install.json';
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_INSTRUCTION_CHARS = 6000;
const SKIP_COPY = new Set(['.git', 'node_modules']);

const userRoot = () => path.join(os.homedir(), '.codeply', 'plugins');
const projectRoot = (cwd) => path.join(cwd, '.codeply', 'plugins');
const stateFile = () => path.join(os.homedir(), '.codeply', 'plugins.json');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function readState() {
  const s = readJson(stateFile());
  return { disabled: Array.isArray(s && s.disabled) ? s.disabled : [] };
}

function writeState(state) {
  fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
  fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2));
}

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

/** Inside `root` after resolving? Guards manifest paths against ../ escapes. */
function inside(root, rel) {
  const full = path.resolve(root, rel);
  return full === path.resolve(root) || full.startsWith(path.resolve(root) + path.sep) ? full : null;
}

/** Read a plugin folder; { error } if it is not one. */
function readPlugin(dir, fallbackName) {
  let manifest = null;
  for (const f of MANIFEST_FILES) {
    manifest = readJson(path.join(dir, f));
    if (manifest && typeof manifest === 'object') break;
    manifest = null;
  }
  const name = slug((manifest && manifest.name) || fallbackName || path.basename(dir));
  if (!NAME_RE.test(name)) return { error: `"${name}" is not a valid plugin name (lowercase letters, digits, dashes).` };

  const has = (p) => { try { return fs.statSync(path.join(dir, p)).isDirectory(); } catch { return false; } };
  const commandsDir = has('commands') ? path.join(dir, 'commands') : null;
  const skillsDir = has('skills') ? path.join(dir, 'skills') : null;
  const mcpFile = ['mcp.json', '.mcp.json'].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f)) || null;

  const wanted = Array.isArray(manifest && manifest.instructions) ? manifest.instructions
    : typeof (manifest && manifest.instructions) === 'string' ? [manifest.instructions]
    : ['instructions.md'];
  const instructionFiles = wanted
    .map((rel) => inside(dir, String(rel)))
    .filter((f) => f && fs.existsSync(f) && fs.statSync(f).isFile());

  let mcpServers = {};
  if (mcpFile) {
    const j = readJson(mcpFile);
    mcpServers = (j && (j.mcpServers || j.servers)) || {};
  }
  return {
    name,
    version: String((manifest && manifest.version) || ''),
    description: String((manifest && manifest.description) || ''),
    author: typeof (manifest && manifest.author) === 'object' && manifest.author ? String(manifest.author.name || '') : String((manifest && manifest.author) || ''),
    homepage: String((manifest && manifest.homepage) || ''),
    dir, commandsDir, skillsDir, mcpFile, mcpServers, instructionFiles,
    hasManifest: !!manifest,
  };
}

function countFiles(dir, test) {
  let n = 0;
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (e.isFile() && test(e.name)) n++;
    }
  };
  walk(dir);
  return n;
}

/** What a plugin contains, in a shape the installer can show before asking. */
function summarize(p) {
  return {
    name: p.name, version: p.version, description: p.description, author: p.author, homepage: p.homepage,
    commands: p.commandsDir ? countFiles(p.commandsDir, (n) => n.toLowerCase().endsWith('.md')) : 0,
    skills: p.skillsDir ? fs.readdirSync(p.skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(p.skillsDir, e.name, 'SKILL.md'))).length : 0,
    instructions: p.instructionFiles.length,
    mcpServers: Object.entries(p.mcpServers).map(([n, s]) => ({
      name: n,
      runs: s && s.command ? [s.command, ...(s.args || [])].join(' ') : '',
      url: s && s.url ? String(s.url) : '',
    })),
  };
}

function scanRoot(root, scope, out) {
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const p = readPlugin(path.join(root, e.name), e.name);
    if (p.error) continue;
    const record = readJson(path.join(root, e.name, RECORD_FILE)) || {};
    out.set(p.name, { ...p, scope, source: record.source || '', commit: record.commit || '' });
  }
}

/** Installed plugins for a project (project ones override user ones). */
function listPlugins(cwd, { includeDisabled = true } = {}) {
  const found = new Map();
  scanRoot(userRoot(), 'user', found);
  if (cwd) scanRoot(projectRoot(cwd), 'project', found);
  const { disabled } = readState();
  return [...found.values()]
    .map((p) => ({ ...p, enabled: !disabled.includes(p.name) }))
    .filter((p) => includeDisabled || p.enabled)
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ─── What the rest of the engine reads ──────────────────────────────────────

const active = (cwd) => listPlugins(cwd, { includeDisabled: false });

function commandDirs(cwd) {
  return active(cwd).filter((p) => p.commandsDir).map((p) => ({ plugin: p.name, dir: p.commandsDir }));
}

function skillDirs(cwd) {
  return active(cwd).filter((p) => p.skillsDir).map((p) => ({ plugin: p.name, dir: p.skillsDir }));
}

function subst(value, dir) {
  return typeof value === 'string'
    ? value.replace(/\$\{(?:CODEPLY_PLUGIN_ROOT|CLAUDE_PLUGIN_ROOT|PLUGIN_ROOT)\}/g, dir)
    : Array.isArray(value) ? value.map((v) => subst(v, dir))
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, subst(v, dir)]))
    : value;
}

/** MCP servers from plugins as `<plugin>-<server>`, with ${CODEPLY_PLUGIN_ROOT} filled in. */
function mcpServers(cwd) {
  const out = {};
  for (const p of active(cwd)) {
    for (const [n, spec] of Object.entries(p.mcpServers)) {
      if (spec && typeof spec === 'object') out[`${p.name}-${slug(n)}`] = subst(spec, p.dir);
    }
  }
  return out;
}

/** Prompt blocks: { plugin, file, text } for each enabled plugin instruction file. */
function instructionBlocks(cwd) {
  const out = [];
  for (const p of active(cwd)) {
    for (const file of p.instructionFiles) {
      try {
        let text = fs.readFileSync(file, 'utf8').trim();
        if (!text) continue;
        if (text.length > MAX_INSTRUCTION_CHARS) text = `${text.slice(0, MAX_INSTRUCTION_CHARS)}\n[... truncated, read ${file} for the rest]`;
        out.push({ plugin: p.name, file, text });
      } catch {}
    }
  }
  return out;
}

// ─── Installing ─────────────────────────────────────────────────────────────

function git(args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { timeout: 120000, windowsHide: true, maxBuffer: 8 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).toString().trim().split('\n').slice(-3).join(' ')));
      else resolve(String(stdout).trim());
    });
  });
}

/** owner/repo, github:owner/repo, a git URL, or a local folder (each optionally #ref). */
function parseSource(source) {
  let src = String(source || '').trim();
  let ref = '';
  const hash = src.lastIndexOf('#');
  if (hash > 0) { ref = src.slice(hash + 1); src = src.slice(0, hash); }
  if (ref && !/^[A-Za-z0-9._\/-]+$/.test(ref)) return { error: 'That #ref has characters a branch or tag cannot have.' };
  if (!src) return { error: 'No source given.' };
  if (fs.existsSync(src)) return { kind: 'local', path: path.resolve(src), ref: '' };
  src = src.replace(/^github:/i, '');
  if (/^[\w.-]+\/[\w.-]+$/.test(src)) return { kind: 'git', url: `https://github.com/${src.replace(/\.git$/, '')}.git`, ref };
  if (/^(https:\/\/|git@[\w.-]+:|ssh:\/\/)/.test(src)) return { kind: 'git', url: src, ref };
  if (/^http:\/\//.test(src)) return { error: 'Use https:// for a git source.' };
  return { error: `"${src}" is not a folder, an owner/repo, or a git URL.` };
}

function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP_COPY.has(e.name) || e.isSymbolicLink()) continue;
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyTree(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

/**
 * Step one of an install: fetch to a temp folder and read it. Nothing is
 * installed yet; the caller shows `summary` and then calls finishInstall().
 */
async function prepareInstall(source) {
  const src = parseSource(source);
  if (src.error) return { ok: false, error: src.error };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-plugin-'));
  const work = path.join(tmp, 'p');
  try {
    let commit = '';
    if (src.kind === 'local') {
      copyTree(src.path, work);
    } else {
      const args = ['-c', 'core.symlinks=false', 'clone', '--depth', '1', '--no-tags'];
      if (src.ref) args.push('--branch', src.ref);
      args.push('--', src.url, work);
      await git(args, { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
      commit = await git(['-C', work, 'rev-parse', 'HEAD']).catch(() => '');
      fs.rmSync(path.join(work, '.git'), { recursive: true, force: true });
    }
    const p = readPlugin(work, src.kind === 'local' ? path.basename(src.path) : path.basename(src.url).replace(/\.git$/, ''));
    if (p.error) throw new Error(p.error);
    const summary = summarize(p);
    if (!summary.commands && !summary.skills && !summary.instructions && !summary.mcpServers.length) {
      throw new Error('Nothing to install: no commands/, skills/, mcp.json or instructions.md in it.');
    }
    return { ok: true, tmp, work, name: p.name, summary, record: { source: String(source).trim(), commit } };
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return { ok: false, error: e.message };
  }
}

function discardInstall(prepared) {
  if (prepared && prepared.tmp) fs.rmSync(prepared.tmp, { recursive: true, force: true });
}

/** Step two: move a prepared plugin into place. */
function finishInstall(prepared, { scope = 'user', cwd, force = false } = {}) {
  try {
    if (scope === 'project' && !cwd) return { ok: false, error: 'A project install needs a project folder.' };
    const root = scope === 'project' ? projectRoot(cwd) : userRoot();
    const dest = path.join(root, prepared.name);
    if (fs.existsSync(dest) && !force) return { ok: false, error: `"${prepared.name}" is already installed. Use update, or install again with force.` };
    fs.mkdirSync(root, { recursive: true });
    fs.rmSync(dest, { recursive: true, force: true });
    copyTree(prepared.work, dest);
    fs.writeFileSync(path.join(dest, RECORD_FILE), JSON.stringify({ ...prepared.record, scope, installedAt: new Date().toISOString() }, null, 2));
    return { ok: true, name: prepared.name, dest, summary: prepared.summary };
  } finally {
    discardInstall(prepared);
  }
}

/** Prepare + finish in one go, for callers that already have consent. */
async function installPlugin(source, opts = {}) {
  const prepared = await prepareInstall(source);
  if (!prepared.ok) return prepared;
  return finishInstall(prepared, opts);
}

function findInstalled(name, cwd) {
  return listPlugins(cwd).find((p) => p.name === slug(name));
}

function removePlugin(name, cwd) {
  const p = findInstalled(name, cwd);
  if (!p) return { ok: false, error: `No plugin named "${name}".` };
  fs.rmSync(p.dir, { recursive: true, force: true });
  const state = readState();
  if (state.disabled.includes(p.name)) writeState({ disabled: state.disabled.filter((n) => n !== p.name) });
  return { ok: true, name: p.name };
}

function setEnabled(name, enabled, cwd) {
  const p = findInstalled(name, cwd);
  if (!p) return { ok: false, error: `No plugin named "${name}".` };
  const state = readState();
  const rest = state.disabled.filter((n) => n !== p.name);
  writeState({ disabled: enabled ? rest : [...rest, p.name] });
  return { ok: true, name: p.name, enabled: !!enabled };
}

/** Re-fetch from where it was installed. Returns the prepared install so the caller can show what changed. */
async function prepareUpdate(name, cwd) {
  const p = findInstalled(name, cwd);
  if (!p) return { ok: false, error: `No plugin named "${name}".` };
  if (!p.source) return { ok: false, error: `"${p.name}" has no recorded source to update from.` };
  const prepared = await prepareInstall(p.source);
  if (!prepared.ok) return prepared;
  if (prepared.name !== p.name) { discardInstall(prepared); return { ok: false, error: `The source now calls itself "${prepared.name}", not "${p.name}". Remove and install it again.` }; }
  return { ...prepared, scope: p.scope, before: summarize(p) };
}

/** Scaffold a new plugin folder ready to push to GitHub. */
function scaffoldPlugin(name, parentDir) {
  const n = slug(name);
  if (!NAME_RE.test(n)) return { ok: false, error: 'Use lowercase letters, digits and dashes for the name.' };
  const dir = path.join(parentDir, n);
  if (fs.existsSync(dir)) return { ok: false, error: `${dir} already exists.` };
  fs.mkdirSync(path.join(dir, 'commands'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'skills', 'example'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'codeply-plugin.json'), JSON.stringify({
    name: n, version: '0.1.0', description: 'What this plugin adds to Craft', author: '', homepage: '',
    instructions: ['instructions.md'],
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'commands', 'hello.md'), `---\ndescription: Say hello (example command, run it as /${n}:hello)\n---\nGreet the user and tell them which project this is. $ARGUMENTS\n`);
  fs.writeFileSync(path.join(dir, 'skills', 'example', 'SKILL.md'), `---\nname: ${n}-example\ndescription: Replace with when the agent should load this skill\n---\nStep by step instructions for the agent go here.\n`);
  fs.writeFileSync(path.join(dir, 'instructions.md'), `Rules the agent follows in every project where ${n} is installed. Delete this file if you have none.\n`);
  fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify({ mcpServers: {} }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${n}\n\nInstall: \`codeply plugin install <owner>/${n}\`\n\nPush this folder to GitHub and anyone can install it with that command.\n`);
  return { ok: true, dir, name: n };
}

module.exports = {
  listPlugins, readPlugin, summarize, parseSource,
  commandDirs, skillDirs, mcpServers, instructionBlocks,
  prepareInstall, finishInstall, discardInstall, installPlugin,
  prepareUpdate, removePlugin, setEnabled, scaffoldPlugin,
};
