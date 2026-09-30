/**
 * Undo for agent changes: a hidden git repository, kept outside the project,
 * that records the project's files before a message runs so exactly what that
 * message changed can be put back.
 *
 * The approach (a separate --git-dir pointed at the project as --work-tree,
 * trees written with write-tree, files restored with checkout) follows
 * opencode's snapshot/index.ts, MIT License, Copyright (c) 2025 opencode.
 *
 * It never touches the project's own .git: no commits, no index, no refs.
 * The project's .gitignore still applies, plus a built-in list of heavy
 * folders so a project without a .gitignore doesn't snapshot node_modules.
 * Every function fails soft (returns null/false) when git is missing.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const ROOT = path.join(os.homedir(), '.codeply', 'snapshots');
const TIMEOUT_MS = 30000;
const EXCLUDES = [
  'node_modules/', '.git/', 'dist/', 'build/', 'out/', '.next/', '.nuxt/', '.turbo/', '.cache/', 'coverage/',
  '__pycache__/', '.venv/', 'venv/', 'target/', '*.log', '.DS_Store', 'Thumbs.db',
];
const MAX_FILE_BYTES = 5 * 1024 * 1024;

function gitDirFor(cwd) {
  const key = crypto.createHash('sha1').update(path.resolve(cwd).toLowerCase()).digest('hex').slice(0, 16);
  return path.join(ROOT, key);
}

function git(cwd, args, { input } = {}) {
  const gitDir = gitDirFor(cwd);
  const full = [
    '-c', 'core.autocrlf=false', '-c', 'core.longpaths=true', '-c', 'core.fsmonitor=false',
    '-c', 'core.quotepath=false', '-c', `safe.directory=*`,
    `--git-dir=${gitDir}`, `--work-tree=${path.resolve(cwd)}`, ...args,
  ];
  return new Promise((resolve) => {
    const child = execFile('git', full, { cwd, timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || (err && err.message) || '') }));
    if (input != null) { child.stdin.end(input); }
  });
}

async function ensureRepo(cwd) {
  const gitDir = gitDirFor(cwd);
  if (!fs.existsSync(path.join(gitDir, 'HEAD'))) {
    fs.mkdirSync(gitDir, { recursive: true });
    const r = await git(cwd, ['init', '-q']);
    if (!r.ok) return false;
    fs.writeFileSync(path.join(gitDir, 'codeply-project.txt'), path.resolve(cwd));
  }
  // Refreshed every time so changes to the list reach existing repos.
  fs.mkdirSync(path.join(gitDir, 'info'), { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'info', 'exclude'), EXCLUDES.join('\n') + '\n');
  return true;
}

/** Big files (videos, datasets) that aren't gitignored are left out, like opencode does. */
async function excludeLargeUntracked(cwd) {
  const r = await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (!r.ok || !r.out) return [];
  const big = [];
  for (const rel of r.out.split('\0').filter(Boolean)) {
    try { if (fs.statSync(path.join(cwd, rel)).size > MAX_FILE_BYTES) big.push(rel); } catch {}
  }
  return big;
}

/**
 * Record the project's current files.
 * @returns {Promise<string|null>} a tree hash, or null if snapshots are unavailable
 */
async function track(cwd) {
  try {
    if (!cwd || !fs.existsSync(cwd) || !(await ensureRepo(cwd))) return null;
    const big = await excludeLargeUntracked(cwd);
    const add = await git(cwd, ['add', '-A', '--', '.', ...big.map((b) => `:(exclude,literal)${b}`)]);
    if (!add.ok) return null;
    const tree = await git(cwd, ['write-tree']);
    return tree.ok ? tree.out.trim() || null : null;
  } catch { return null; }
}

/** Files that differ between two recorded trees. */
async function changedFiles(cwd, fromTree, toTree) {
  if (!fromTree || !toTree || fromTree === toTree) return [];
  const r = await git(cwd, ['diff-tree', '-r', '--name-status', '--no-renames', '-z', fromTree, toTree]);
  if (!r.ok) return [];
  const parts = r.out.split('\0').filter(Boolean);
  const out = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    out.push({ status: parts[i], file: parts[i + 1] }); // A added, M modified, D deleted
  }
  return out;
}

/** Does `file` exist in `tree`? */
async function inTree(cwd, tree, file) {
  const r = await git(cwd, ['cat-file', '-e', `${tree}:${file}`]);
  return r.ok;
}

/**
 * Put `files` back the way they were in `tree`: restore the ones it had,
 * delete the ones it didn't (they were created after it).
 * @returns {Promise<{ok:boolean, restored:string[], removed:string[], failed:string[]}>}
 */
async function restore(cwd, tree, files) {
  const restored = [], removed = [], failed = [];
  if (!tree || !(await ensureRepo(cwd))) return { ok: false, restored, removed, failed: files.slice() };
  const existed = [];
  for (const f of files) {
    if (await inTree(cwd, tree, f)) existed.push(f);
    else {
      try { fs.rmSync(path.join(cwd, f), { force: true }); removed.push(f); } catch { failed.push(f); }
    }
  }
  for (let i = 0; i < existed.length; i += 100) {
    const batch = existed.slice(i, i + 100);
    const r = await git(cwd, ['checkout', tree, '--', ...batch]);
    if (r.ok) restored.push(...batch);
    else {
      // One bad path shouldn't block the rest.
      for (const f of batch) {
        const one = await git(cwd, ['checkout', tree, '--', f]);
        (one.ok ? restored : failed).push(f);
      }
    }
  }
  return { ok: failed.length === 0, restored, removed, failed };
}

/** Is git usable here at all? Cached. */
let gitAvailable;
function available() {
  if (gitAvailable !== undefined) return Promise.resolve(gitAvailable);
  return new Promise((resolve) => {
    execFile('git', ['--version'], { timeout: 5000, windowsHide: true }, (err) => { gitAvailable = !err; resolve(gitAvailable); });
  });
}

module.exports = { track, changedFiles, restore, available, gitDirFor };
