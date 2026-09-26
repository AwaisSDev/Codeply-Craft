// postinstall: installs the bundled engine's own dependencies (codeply-cli/).
// Runs npm inside that folder with the parent install's npm_config_* settings
// removed. Passing them through (e.g. `npm install --prefix codeply-cli`) made
// npm 10 re-run this app's own postinstall inside the nested install, forever.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const cwd = path.resolve(__dirname, '..', 'codeply-cli');
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_(config|lifecycle|package)_/i.test(k)));
const args = fs.existsSync(path.join(cwd, 'package-lock.json'))
  ? ['ci', '--no-audit', '--no-fund']
  : ['install', '--no-audit', '--no-fund'];

const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { cwd, env, stdio: 'inherit', shell: process.platform === 'win32' });
process.exit(r.status ?? 1);
