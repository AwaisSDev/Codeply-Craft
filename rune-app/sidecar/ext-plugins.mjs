// Integrations > Plugins and MCP servers, from the engine's own lists (codeply-cli/lib/plugins.js
// and mcp.js), instead of the sample: the plugins installed for you and this project, and the MCP
// servers the agent can reach (yours, the project's, and the ones plugins and apps bring).
//
//   GET  /ext/plugins                { plugins: [...], mcp: [...] }
//   POST /ext/plugins/toggle         { name, enabled }   a plugin on or off (plugins.json)
//   POST /ext/plugins/mcp-toggle     { name, enabled }   one of your own servers (~/.codeply/mcp.json)
//
// Emits `plugins_changed` after a change (skills from a plugin come and go with it).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const userMcp = () => path.join(os.homedir(), '.codeply', 'mcp.json');
const readMcp = (file) => { try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return j.mcpServers || j.servers || {}; } catch { return {}; } };
const runsOf = (s) => (s && s.url ? String(s.url) : s && s.command ? [s.command, ...(s.args || [])].join(' ') : '');

function view(ctx) {
  const P = ctx.need('plugins.js');
  const cwd = ctx.DEFAULT_CWD;
  const plugins = P.listPlugins(cwd).map((p) => {
    const sum = P.summarize ? P.summarize(p) : {};
    return {
      name: p.name, description: p.description || '', author: p.author || '', version: p.version || '',
      enabled: !!p.enabled, scope: p.scope || 'user', skills: sum.skills || 0, commands: sum.commands || 0,
      mcp: (sum.mcpServers || []).length,
    };
  });
  const mcp = [];
  const seen = new Set();
  const add = (name, spec, from, canToggle) => {
    if (seen.has(name) || !spec || !(spec.command || spec.url)) return;
    seen.add(name);
    mcp.push({ name, runs: runsOf(spec), from, on: !spec.disabled, canToggle });
  };
  for (const [n, s] of Object.entries(readMcp(userMcp()))) add(n, s, 'yours', true);
  if (cwd) for (const [n, s] of Object.entries(readMcp(path.join(cwd, '.codeply', 'mcp.json')))) add(n, s, 'this project', false);
  try { for (const [n, s] of Object.entries(P.mcpServers(cwd))) add(n, s, 'a plugin', false); } catch { /* none */ }
  try { const apps = ctx.need('apps.js'); for (const [n, s] of Object.entries(apps.mcpServers())) add(n, s, 'a connected app', false); } catch { /* none */ }
  return { plugins, mcp };
}

export async function route(ctx, req, res, url, p, reply) {
  if (!(p === '/ext/plugins' || p.startsWith('/ext/plugins/'))) return false;
  try {
    if (req.method === 'GET' && p === '/ext/plugins') { reply(200, view(ctx)); return true; }
    if (req.method !== 'POST') return false;
    const b = await ctx.readJson(req).catch(() => ({}));
    let r;
    if (p === '/ext/plugins/toggle') {
      r = ctx.need('plugins.js').setEnabled(String(b.name || ''), !!b.enabled, ctx.DEFAULT_CWD);
    } else if (p === '/ext/plugins/mcp-toggle') {
      const file = userMcp();
      let j = {};
      try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none yet */ }
      const servers = j.mcpServers || j.servers || {};
      const s = servers[String(b.name || '')];
      if (!s) r = { ok: false, error: 'Only servers you added yourself can be switched here.' };
      else {
        if (b.enabled) delete s.disabled; else s.disabled = true;
        fs.writeFileSync(file, JSON.stringify(j, null, 2));
        try { ctx.need('mcp.js').forget(String(b.name)); } catch { /* reconnects next time */ }
        r = { ok: true };
      }
    } else return false;
    if (r && r.ok) { try { ctx.emit(null, { type: 'plugins_changed' }); } catch { /* nobody listening */ } }
    reply(200, { ...(r || {}), ...view(ctx) });
  } catch (e) {
    reply(200, { ok: false, error: e.message, plugins: [], mcp: [] });
  }
  return true;
}
