// postinstall (best effort): puts better-sqlite3 in node_modules with the binary that
// matches this app's Electron. Electron 29 runs Node 20, which has no built-in
// node:sqlite, so this is what gives the desktop app its SQLite chat store. If
// anything here fails the app still works: it falls back to the JSON store.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pkgDir = path.join(root, 'node_modules', 'better-sqlite3');
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_(config|lifecycle|package)_/i.test(k)));
const win = process.platform === 'win32';
const run = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, env, stdio: 'inherit', shell: win });

try {
  if (!fs.existsSync(pkgDir)) {
    run(win ? 'npm.cmd' : 'npm', ['install', 'better-sqlite3@11.10.0', '--no-save', '--ignore-scripts', '--no-audit', '--no-fund'], root);
  }
  if (fs.existsSync(pkgDir)) {
    let electronVersion = null;
    try { electronVersion = require(path.join(root, 'node_modules', 'electron', 'package.json')).version; } catch {}
    if (electronVersion) {
      const r = run(win ? 'npx.cmd' : 'npx', ['--yes', 'prebuild-install', '--runtime=electron', `--target=${electronVersion}`], pkgDir);
      if (r.status !== 0) console.warn('[install-sqlite] no prebuilt SQLite binary for this Electron; Craft will use its JSON store.');
    }
  }
} catch (e) {
  console.warn('[install-sqlite] skipped:', e.message);
}
process.exit(0);
