/**
 * Agent profiles. Built in: normal (all tools), plan and ask (read-only),
 * and the subagent profiles subagent_explore and subagent_general. Custom
 * subagent profiles are markdown files:
 *
 *   .dvn/agents/<name>.md | .dvn/agents/<name>/AGENT.md
 *   .devin/agents/, .agents/agents/, ~/.config/dvn/agents/, .claude/agents/
 *
 *   ---
 *   name: reviewer
 *   description: Reviews a diff for bugs
 *   model: sonnet
 *   allowed-tools: [read, grep, glob, exec]   # a real restriction
 *   max-nesting: 1
 *   ---
 *   <system prompt for the subagent>
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from '../context/frontmatter.mjs';
import { configDir, homeDir } from '../config/paths.mjs';
import { projectDirs } from '../config/config.mjs';

export const READ_ONLY_TOOLS = ['read', 'grep', 'glob', 'ls', 'todo_write', 'webfetch', 'skill', 'get_output', 'mcp_list_servers', 'mcp_list_tools', 'mcp_read_resource'];

export const AGENT_PROFILES = {
  normal: { tools: null },
  plan: { tools: [...READ_ONLY_TOOLS, 'ask_user_question', 'exit_plan_mode'], allowReadOnlyMcp: true },
  ask: { tools: [...READ_ONLY_TOOLS, 'ask_user_question'] },
};

export const BUILTIN_SUBAGENTS = [
  {
    name: 'subagent_explore',
    description: 'Read-only codebase exploration: finds files, traces code paths and answers questions about the code. Cannot edit files or run commands.',
    tools: ['read', 'grep', 'glob', 'ls', 'todo_write'],
    model: null,
    useSubagentModel: true,
    prompt: 'You are an exploration subagent. Search and read the codebase to answer the task you were given. You cannot modify anything. Be thorough but efficient, then reply with a concise report: the answer, the key file paths (path:line), and anything you could not determine.',
  },
  {
    name: 'subagent_general',
    description: 'General-purpose subagent with the same tools as you, for an independent self-contained task.',
    tools: null,
    model: null,
    useParentModel: true,
    prompt: 'You are a subagent working on one self-contained task for another agent. Complete it fully, verify what you can, then reply with a concise report of what you did, what you verified and anything left unresolved. Your final message is all the parent agent will see.',
  },
];

function asList(v) {
  if (!v) return null;
  return (Array.isArray(v) ? v : String(v).split(/[,\s]+/)).map(String).filter(Boolean);
}

export function loadCustomSubagents({ cwd, readConfigFrom = {}, warnings = [] }) {
  const dirs = [path.join(configDir(), 'agents')];
  for (const d of projectDirs(cwd)) {
    dirs.push(path.join(d, '.dvn', 'agents'), path.join(d, '.agents', 'agents'));
    if (readConfigFrom.devin !== false) dirs.push(path.join(d, '.devin', 'agents'));
    if (readConfigFrom.claude !== false) dirs.push(path.join(d, '.claude', 'agents'));
  }
  if (readConfigFrom.devin !== false) dirs.push(path.join(homeDir(), '.config', 'devin', 'agents'));
  const out = new Map();
  for (const dir of dirs) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      let file;
      let id;
      if (e.isFile() && e.name.endsWith('.md')) { file = path.join(dir, e.name); id = e.name.slice(0, -3); }
      else if (e.isDirectory()) {
        const pick = ['AGENT.md', 'AGENTS.md', 'agent.md', 'agents.md'].map((n) => path.join(dir, e.name, n)).find((f) => fs.existsSync(f));
        if (!pick) continue;
        file = pick;
        id = e.name;
      } else continue;
      let parsed;
      try { parsed = parseFrontmatter(fs.readFileSync(file, 'utf8')); } catch (err) { warnings.push(`${file}: ${err.message}`); continue; }
      const d = parsed.data;
      const name = String(d.name || id);
      if (BUILTIN_SUBAGENTS.some((b) => b.name === name)) { warnings.push(`${file}: '${name}' collides with a built-in profile; skipped`); continue; }
      const known = new Set(['name', 'description', 'model', 'allowed-tools', 'tools', 'max-nesting']);
      const ignored = Object.keys(d).filter((k) => !known.has(k));
      if (ignored.length) warnings.push(`${file}: ignored keys ${ignored.join(', ')}`);
      out.set(name, {
        name,
        description: d.description ? String(d.description) : '',
        tools: asList(d['allowed-tools'] || d.tools),
        model: d.model ? String(d.model) : null,
        useSubagentModel: !d.model,
        maxNesting: Number.isInteger(d['max-nesting']) ? d['max-nesting'] : null,
        prompt: parsed.body.trim(),
        source: file,
      });
    }
  }
  return [...out.values()];
}
