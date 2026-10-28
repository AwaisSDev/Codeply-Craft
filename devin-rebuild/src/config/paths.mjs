/**
 * Where dvn keeps things. Same XDG layout Devin CLI was observed to use
 * (REA process captures, see docs/REVERSE-ENGINEERING.md), under our own name:
 *
 *   $XDG_CONFIG_HOME/dvn/config.json        user config
 *   $XDG_CONFIG_HOME/dvn/mcp_config.json    user MCP servers
 *   $XDG_CONFIG_HOME/dvn/{rules,skills,agents}/
 *   $XDG_DATA_HOME/dvn/cli/sessions/        saved conversations
 *   $XDG_DATA_HOME/dvn/cli/logs/
 *   $XDG_DATA_HOME/dvn/credentials.json
 *   <project>/.dvn/                         project config, rules, skills, hooks
 *
 * DVN_HOME overrides every user-level root at once (tests use it).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const NAME = 'dvn';
export const PROJECT_DIR = '.dvn';

function home() { return process.env.HOME || os.homedir(); }

function xdg(envName, fallback) {
  if (process.env.DVN_HOME) return process.env.DVN_HOME;
  const v = process.env[envName];
  return v && path.isAbsolute(v) ? v : path.join(home(), fallback);
}

export function configDir() { return process.env.DVN_HOME ? path.join(process.env.DVN_HOME, 'config') : path.join(xdg('XDG_CONFIG_HOME', '.config'), NAME); }
export function dataDir() { return process.env.DVN_HOME ? path.join(process.env.DVN_HOME, 'data') : path.join(xdg('XDG_DATA_HOME', '.local/share'), NAME); }
export function cacheDir() { return process.env.DVN_HOME ? path.join(process.env.DVN_HOME, 'cache') : path.join(xdg('XDG_CACHE_HOME', '.cache'), NAME); }

export const userConfigFile = () => path.join(configDir(), 'config.json');
export const userMcpFile = () => path.join(configDir(), 'mcp_config.json');
export const credentialsFile = () => path.join(dataDir(), 'credentials.json');
export const sessionsDir = () => path.join(dataDir(), 'cli', 'sessions');
export const logsDir = () => path.join(dataDir(), 'cli', 'logs');
export const exportsDir = () => path.join(dataDir(), 'cli', 'exports');
export const trustFile = () => path.join(dataDir(), 'cli', 'trusted_folders.json');
export const pluginsDir = () => path.join(dataDir(), 'cli', 'plugins');

export function homeDir() { return home(); }

/** "~/.config/dvn/x" for display, like Devin prints user paths. */
export function tildify(p) {
  const h = home();
  return p === h ? '~' : p.startsWith(h + path.sep) ? '~' + p.slice(h.length) : p;
}

/** The git root above cwd, or cwd itself. Project config lives here. */
export function projectRoot(cwd = process.cwd()) {
  let dir = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return path.resolve(cwd);
    dir = up;
  }
}
