/**
 * The system prompt. Original text (Devin's own prompt is not public); it
 * carries the same kinds of context Devin documents injecting: environment,
 * always-on rules, an index of agent-decidable rules and skills, and the
 * current agent profile's constraints.
 */
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { capped, activationLabel } from '../context/rules.mjs';

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 3000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

export function environmentBlock({ cwd, workspaceDirs = [], model }) {
  const branch = git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD');
  const status = branch ? git(cwd, 'status', '--short') : null;
  const lines = [
    `Working directory: ${cwd}`,
    ...workspaceDirs.map((d) => `Additional workspace directory: ${d}`),
    `Platform: ${process.platform} (${os.release()})`,
    `Shell: ${process.env.SHELL || 'bash'}`,
    `Date: ${new Date().toISOString().slice(0, 10)}`,
    `Model: ${model}`,
    branch ? `Git branch: ${branch}${status ? `\nGit status (short):\n${status.split('\n').slice(0, 40).join('\n')}` : '\nGit status: clean'}` : 'Not a git repository',
  ];
  return lines.join('\n');
}

const CORE = `You are dvn, an autonomous software engineering agent working in the user's terminal on their local machine. You read and change code, run commands, and see tasks through to a verified result.

How you work:
- Understand before changing: read the relevant files and search the codebase first. Match the existing style, naming and structure of the code around your change.
- Make the smallest change that fully solves the task. Don't add features, refactors or files nobody asked for.
- Verify your work: run the project's tests, build, linter or the program itself when you can. Never claim something works without evidence. If you could not verify, say so.
- When something fails, find the root cause instead of papering over it. Never weaken or delete tests to make them pass.
- For multi-step work keep a todo list with todo_write and update it as you go.
- Use the dedicated tools: read (not cat), edit/write (not sed or echo >), grep and glob (not grep/find in the shell). Use exec for builds, tests, git and everything else.
- Read a file before you edit it. Paths may be absolute or relative to the working directory.
- Long-running commands (servers, watchers) go in the background with run_in_background; check them with get_output.
- Ask the user (ask_user_question) only when a decision is genuinely theirs and you cannot infer it.
- Destructive or hard-to-reverse actions (deleting data, force-pushing, rewriting history, touching production) need the user's explicit go-ahead.
- Never commit, push or open pull requests unless asked.

Communicating:
- Be concise and direct. Lead with the answer or the outcome. Use GitHub-flavoured markdown; reference code as path:line.
- Report results faithfully: what you changed, what you verified, and anything that failed or was skipped.`;

const PROFILE_NOTES = {
  plan: `You are in PLAN mode. Do not modify files or run commands that change anything. Investigate with read-only tools, ask clarifying questions if needed, then write a concrete implementation plan (a heading, a one-paragraph summary, then numbered steps naming the files to change and how you will verify). When the plan is ready, call exit_plan_mode with it so the user can approve it.`,
  ask: `You are in ASK mode: answer the user's question using read-only tools. Do not modify files or run commands that change anything.`,
};

export function buildSystemPrompt({ cwd, workspaceDirs, model, profile = 'normal', rules = [], skills = [], subagentProfiles = [], mcpInstructions = [], extra = '' }) {
  const parts = [CORE];
  if (PROFILE_NOTES[profile]) parts.push(PROFILE_NOTES[profile]);
  parts.push(`<environment>\n${environmentBlock({ cwd, workspaceDirs, model })}\n</environment>`);

  const always = rules.filter((r) => r.activation.alwaysOn);
  if (always.length) {
    parts.push('The user and project have provided these instructions. Follow them; they override the defaults above.\n'
      + always.map((r) => `<rule name="${r.name}" source="${r.path}">\n${capped(r).trim()}\n</rule>`).join('\n'));
  }
  const optional = rules.filter((r) => !r.activation.alwaysOn && (r.activation.decidable || r.activation.globs.length));
  if (optional.length) {
    parts.push('More project rules exist. Read a rule file with the read tool when its description applies to your task (glob rules are also shown to you automatically when you touch matching files):\n'
      + optional.map((r) => `- ${r.name} (${activationLabel(r)})${r.description ? `: ${r.description}` : ''} — ${r.path}`).join('\n'));
  }
  const modelSkills = skills.filter((s) => s.triggers.includes('model'));
  if (modelSkills.length) {
    parts.push('Skills you can load with the skill tool when a task matches their description:\n'
      + modelSkills.map((s) => `- ${s.display_name}: ${s.description || '(no description)'}`).join('\n'));
  }
  if (subagentProfiles.length) {
    parts.push('Subagents (run_subagent) take a self-contained task and return a summary. Use subagent_explore for broad codebase searches you only need the conclusion from; use subagent_general for independent work. Profiles:\n'
      + subagentProfiles.map((p) => `- ${p.name}: ${p.description}`).join('\n'));
  }
  for (const m of mcpInstructions) parts.push(`<mcp_server name="${m.name}">\n${m.text}\n</mcp_server>`);
  if (extra) parts.push(extra);
  return parts.join('\n\n');
}
