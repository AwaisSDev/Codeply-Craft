/**
 * --sandbox: run exec commands inside an OS sandbox.
 *
 * Linux uses bubblewrap: the whole filesystem read-only, the workspace dirs
 * and granted Write(...) scopes writable, Deny(Read(...)) paths hidden behind
 * empty tmpfs mounts, a private /tmp. macOS uses sandbox-exec with an
 * equivalent profile. Network is shared unless sandbox.network_mode is
 * "none". Commands matching sandbox.excluded.allow run outside the sandbox.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { commandMatches, parseRule, splitCommands } from './engine.mjs';

export function sandboxPrerequisites() {
  if (process.platform === 'linux') {
    const have = (b) => spawnSync('which', [b]).status === 0;
    return { platform: 'linux', ok: have('bwrap'), message: `On Linux, --sandbox needs bubblewrap (\`bwrap\`). ${have('bwrap') ? 'bwrap is installed.' : 'bwrap is not installed: install the "bubblewrap" package.'} Under Windows use a WSL 2 distribution; WSL 1 cannot sandbox.` };
  }
  if (process.platform === 'darwin') return { platform: 'darwin', ok: true, message: 'On macOS, --sandbox uses the built-in Seatbelt (sandbox-exec). No setup needed.' };
  return { platform: process.platform, ok: false, message: 'The sandbox is not supported on this platform. On Windows, run dvn inside WSL 2.' };
}

function writeScopes(permissions, cwd) {
  return permissions.rules
    .filter((r) => r.effect === 'allow' && r.parsed.kind === 'scope' && r.parsed.scope === 'Write')
    .map((r) => r.parsed.pattern.replace(/\/?\*\*?.*$/, ''))
    .filter(Boolean)
    .map((p) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : path.resolve(cwd, p)));
}

function readDenies(permissions, cwd) {
  return permissions.rules
    .filter((r) => r.effect === 'deny' && r.parsed.kind === 'scope' && r.parsed.scope === 'Read')
    .map((r) => r.parsed.pattern.replace(/\/?\*\*?.*$/, ''))
    .filter(Boolean)
    .map((p) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : path.resolve(cwd, p)));
}

export function sandboxWrapper({ cwd, workspaceDirs = [], config, permissions }) {
  const pre = sandboxPrerequisites();
  if (!pre.ok) throw new Error(`--sandbox is unavailable: ${pre.message}`);
  const sb = config.settings.sandbox || {};
  const excluded = (sb.excluded?.allow || []).map(parseRule).filter((r) => r.kind === 'scope' && r.scope === 'Exec');
  return (command) => {
    if (excluded.length && splitCommands(command).every((c) => excluded.some((r) => commandMatches(r.pattern, c)))) return ['bash', ['-c', command]];
    const writable = [...new Set([cwd, ...workspaceDirs, ...writeScopes(permissions, cwd)])].filter((d) => fs.existsSync(d));
    const hidden = readDenies(permissions, cwd).filter((d) => fs.existsSync(d));
    if (process.platform === 'darwin') {
      const q = (p) => JSON.stringify(fs.realpathSync(p));
      const profile = [
        '(version 1)', '(allow default)', '(deny file-write*)',
        `(allow file-write* ${writable.map((d) => `(subpath ${q(d)})`).join(' ')} (subpath "/private/tmp") (subpath "/private/var/folders") (literal "/dev/null") (literal "/dev/tty"))`,
        ...hidden.map((d) => `(deny file-read* (subpath ${q(d)}))`),
        ...(sb.network_mode === 'none' ? ['(deny network*)'] : []),
      ].join('\n');
      return ['sandbox-exec', ['-p', profile, 'bash', '-c', command]];
    }
    const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--die-with-parent', '--new-session'];
    for (const d of writable) args.push('--bind', d, d);
    for (const d of hidden) args.push(fs.statSync(d).isDirectory() ? '--tmpfs' : '--ro-bind', ...(fs.statSync(d).isDirectory() ? [d] : ['/dev/null', d]));
    if (sb.network_mode === 'none') args.push('--unshare-net');
    args.push('--chdir', cwd, 'bash', '-c', command);
    return ['bwrap', args];
  };
}
