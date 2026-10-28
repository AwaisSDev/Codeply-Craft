/**
 * MCP server configuration.
 *
 * Own scopes (what `dvn mcp add -s` writes):
 *   local    .dvn/mcp_config.local.json   (default; kept out of git)
 *   project  .dvn/mcp_config.json
 *   user     ~/.config/dvn/mcp_config.json
 * Imported (read-only here, toggled by read_config_from):
 *   devin    .devin/mcp_config.local.json, .devin/mcp_config.json, ~/.config/devin/mcp_config.json
 *   claude   .mcp.json, .claude/settings*.json, ~/.claude.json, ~/.claude/settings*.json
 *   cursor   .cursor/mcp.json, ~/.cursor/mcp.json
 *   windsurf ~/.codeium/windsurf{,-next,-insiders}/mcp_config.json
 *   opencode opencode.json, ~/.config/opencode/opencode.json   ("mcp" key)
 *   zed      .zed/settings.json, ~/.config/zed/settings.json  ("context_servers")
 * Servers merge by name; the first source in that order wins.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readJsonFile } from '../config/config.mjs';
import { configDir, homeDir, projectRoot, PROJECT_DIR } from '../config/paths.mjs';

export const SCOPES = ['local', 'project', 'user'];

export function scopeFile(scope, cwd) {
  const root = projectRoot(cwd);
  if (scope === 'user') return path.join(configDir(), 'mcp_config.json');
  return path.join(root, PROJECT_DIR, scope === 'local' ? 'mcp_config.local.json' : 'mcp_config.json');
}

export const scopeLabel = { local: 'local project config', project: 'project config', user: 'user config' };

function fromOpencode(obj) {
  const out = {};
  for (const [name, s] of Object.entries(obj?.mcp || {})) {
    if (s.type === 'remote' || s.url) out[name] = { url: s.url, headers: s.headers, disabled: s.enabled === false };
    else {
      const cmd = Array.isArray(s.command) ? s.command : String(s.command || '').split(/\s+/);
      out[name] = { command: cmd[0], args: cmd.slice(1), env: s.environment, disabled: s.enabled === false };
    }
  }
  return out;
}

function fromZed(obj) {
  const out = {};
  for (const [name, s] of Object.entries(obj?.context_servers || {})) {
    if (s.url) { out[name] = { url: s.url, headers: s.headers }; continue; }
    const c = s.command && typeof s.command === 'object' ? s.command : s;
    out[name] = { command: c.path || c.command, args: c.args || [], env: c.env };
  }
  return out;
}

/** Every source in precedence order: [{ provider, scope?, file, servers }]. */
export function mcpSources({ cwd = process.cwd(), readConfigFrom = {} } = {}) {
  const root = projectRoot(cwd);
  const h = homeDir();
  const list = [];
  const add = (provider, scope, file, pick = (j) => j?.mcpServers) => {
    const data = readJsonFile(file);
    if (!data) return;
    const servers = pick(data);
    if (servers && typeof servers === 'object') list.push({ provider, scope, file, servers });
  };
  for (const scope of SCOPES) add('dvn', scope, scopeFile(scope, cwd));
  const on = (k) => readConfigFrom[k] !== false;
  if (on('devin')) {
    add('Devin', null, path.join(root, '.devin', 'mcp_config.local.json'));
    add('Devin', null, path.join(root, '.devin', 'mcp_config.json'));
    add('Devin', null, path.join(h, '.config', 'devin', 'mcp_config.json'));
  }
  if (on('claude')) {
    add('Claude', null, path.join(root, '.mcp.json'));
    add('Claude', null, path.join(root, '.claude', 'settings.local.json'));
    add('Claude', null, path.join(root, '.claude', 'settings.json'));
    add('Claude', null, path.join(h, '.claude.json'), (j) => ({ ...(j.mcpServers || {}), ...(j.projects?.[root]?.mcpServers || {}) }));
    add('Claude', null, path.join(h, '.claude', 'settings.local.json'));
    add('Claude', null, path.join(h, '.claude', 'settings.json'));
    add('Claude', null, path.join(h, '.claude', 'mcp_servers.json'), (j) => j.mcpServers || j);
  }
  if (on('cursor')) {
    add('Cursor', null, path.join(root, '.cursor', 'mcp.json'));
    add('Cursor', null, path.join(h, '.cursor', 'mcp.json'));
  }
  if (on('windsurf')) for (const ch of ['windsurf', 'windsurf-next', 'windsurf-insiders']) add('Windsurf', null, path.join(h, '.codeium', ch, 'mcp_config.json'));
  if (on('opencode')) {
    add('OpenCode', null, path.join(root, 'opencode.json'), fromOpencode);
    add('OpenCode', null, path.join(h, '.config', 'opencode', 'opencode.json'), fromOpencode);
  }
  if (on('zed')) {
    add('Zed', null, path.join(root, '.zed', 'settings.json'), fromZed);
    add('Zed', null, path.join(h, '.config', 'zed', 'settings.json'), fromZed);
  }
  return list;
}

/** Merged servers by name: { name: { ...config, source, provider, scope } }. */
export function loadMcpServers(opts = {}) {
  const merged = {};
  for (const src of mcpSources(opts)) {
    for (const [name, cfg] of Object.entries(src.servers)) {
      if (merged[name] || !cfg || typeof cfg !== 'object') continue;
      merged[name] = { ...cfg, source: src.file, provider: src.provider, scope: src.scope };
    }
  }
  return merged;
}

/** ${env:VAR}, ${VAR}, ${VAR:-default} and ${file:/path} inside server fields. */
export function expandServer(cfg, env = process.env) {
  const sub = (v) => {
    if (typeof v === 'string') {
      return v.replace(/\$\{(env:|file:)?([^}:]+?)(?::-([^}]*))?\}/g, (_, kind, name, dflt) => {
        if (kind === 'file:') { try { return fs.readFileSync(name.replace(/^~/, homeDir()), 'utf8').trim(); } catch { return dflt ?? ''; } }
        return env[name] ?? dflt ?? '';
      });
    }
    if (Array.isArray(v)) return v.map(sub);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x)]));
    return v;
  };
  return sub(cfg);
}

export function describeServer(s) {
  if (s.url || s.serverUrl) return `URL: ${s.url || s.serverUrl}`;
  return `Command: ${[s.command, ...(s.args || [])].join(' ')}`;
}

export function serverTransport(s) {
  return s.transport || s.type?.replace('streamable-http', 'http') || (s.url || s.serverUrl ? 'http' : 'stdio');
}

export function fileExists(f) { return fs.existsSync(f); }
