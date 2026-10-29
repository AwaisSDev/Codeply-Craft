// Stage the DSH engine for the installer (node scripts/package-dsh.mjs).
//
// craft-dsh is a pnpm workspace: its node_modules are symlinks into .pnpm,
// which an installer cannot carry. This walks the real dependency graph of
// the engine's CLI (apps/cli) from what is already installed and copies each
// package into a plain node_modules tree under dsh-runtime/engine, nested
// only where two versions of one package meet. No network, no pnpm.
// The Node that runs it is copied beside it (dsh-runtime/node.exe), because
// the engine needs Node 24.9+ and Electron's own Node is older.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DSH = path.join(ROOT, 'craft-dsh');
const OUT = path.join(ROOT, 'dsh-runtime');
const ENGINE = path.join(OUT, 'engine');
const ENTRY = path.join(DSH, 'apps', 'cli');
// Never needed at run time; some are large.
const SKIP_DIRS = new Set(['node_modules', 'tests', 'test', '__tests__', 'fixtures', 'snapshots', '.turbo', 'coverage', 'docs', 'benchmarks', '.github']);
const SKIP_FILES = /\.(map|tsbuildinfo|md|mdx)$|^(README|CHANGELOG|HISTORY)(\.|$)/i;

// Left out on purpose. Codeply starts the engine with the ACP profile (no web
// GUI of its own) and has its own voice input, so these never load:
//   LibreOffice (document rendering, ~180 MB), offline speech models, the
//   web GUI's client packages and the inspector, type definitions.
const EXCLUDE = [
  /^@deepseek-ai\/libreoffice-kit-/,
  /^sherpa-onnx-(win|linux|darwin)/,
  /^@deepseek-ai\/dsh-client-ui-/,
  /^@deepseek-ai\/dsh-web-frontend$/,
  /^@deepseek-ai\/dsh-experimental-inspector/,
  /^@types\//,
];
const excluded = (name) => EXCLUDE.some((re) => re.test(name));
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

/** Native prebuilds for other platforms: keep only this one's. */
function prunePrebuilds(dir) {
  const keep = `${process.platform}-${process.arch}`;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const p = path.join(dir, ent.name);
    if (ent.name === 'prebuilds') {
      for (const plat of fs.readdirSync(p)) if (plat !== keep) fs.rmSync(path.join(p, plat), { recursive: true, force: true });
    } else prunePrebuilds(p);
  }
}

/** Node's own lookup: <dir>/node_modules/<name>, then each parent's. */
function resolvePkg(fromDir, name) {
  let dir = fromDir;
  for (;;) {
    const cand = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(cand, 'package.json'))) return fs.realpathSync(cand);
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function copyPkg(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    let st;
    try { st = fs.statSync(s); } catch { continue; } // dangling link
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      copyPkg(s, d);
    } else if (!SKIP_FILES.test(ent.name) || ent.name === 'package.json') {
      fs.copyFileSync(s, d);
    }
  }
}

function deps(pkgDir) {
  const p = readJson(path.join(pkgDir, 'package.json'));
  return [...new Set([
    ...Object.keys(p.dependencies || {}),
    ...Object.keys(p.optionalDependencies || {}),
    ...Object.keys(p.peerDependencies || {}),
  ])];
}

// placed: install path -> real path. top: name -> real path at the top level.
const placed = new Map();
const top = new Map();
let missingOptional = 0;

/** Place one package for a dependent at `parentInstall` (its node_modules gets nested copies). */
function place(name, real, parentInstall) {
  if (!top.has(name)) { top.set(name, real); return walk(real, path.join(ENGINE, 'node_modules', name)); }
  if (top.get(name) === real) return;
  // Another version is on top: nest under the dependent (once per dependent).
  const nested = path.join(parentInstall, 'node_modules', name);
  if (placed.has(nested)) return;
  return walk(real, nested);
}

function walk(real, install) {
  if (placed.has(install)) return;
  placed.set(install, real);
  const p = readJson(path.join(real, 'package.json'));
  const optional = new Set([...Object.keys(p.optionalDependencies || {}), ...Object.keys(p.peerDependenciesMeta || {})]);
  for (const name of deps(real)) {
    if (excluded(name)) continue;
    const dep = resolvePkg(real, name);
    if (!dep) {
      if (optional.has(name) || (p.peerDependencies && p.peerDependencies[name])) { missingOptional++; continue; }
      throw new Error(`${p.name} needs ${name}, which is not installed. Run pnpm install in craft-dsh.`);
    }
    place(name, dep, install);
  }
}

if (!fs.existsSync(path.join(ENTRY, 'lib', 'bin.js'))) {
  console.error('The DSH engine is not built: in craft-dsh run pnpm install, then pnpm run build.');
  process.exit(1);
}
fs.rmSync(OUT, { recursive: true, force: true });

// The CLI itself is the engine's root package.
walk(fs.realpathSync(ENTRY), ENGINE);
let bytes = 0;
const count = { packages: 0 };
for (const [install, real] of placed) {
  copyPkg(real, install);
  count.packages++;
}
prunePrebuilds(ENGINE);
(function size(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, ent.name);
    if (ent.isDirectory()) size(f); else bytes += fs.statSync(f).size;
  }
})(ENGINE);

// The Node that runs it: the one running this script, if it is new enough.
const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < 24 || (maj === 24 && min < 9)) {
  console.error(`The engine needs Node 24.9 or newer to ship beside it; this is ${process.version}.`);
  process.exit(1);
}
const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
fs.copyFileSync(process.execPath, path.join(OUT, nodeName));
fs.writeFileSync(path.join(OUT, 'runtime.json'), JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, packages: count.packages, at: new Date().toISOString() }, null, 2));

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
console.log(`Staged ${count.packages} packages (${mb(bytes)}) and Node ${process.version} (${mb(fs.statSync(path.join(OUT, nodeName)).size)}) in dsh-runtime/. ${missingOptional} optional or peer packages were not installed and are left out.`);
