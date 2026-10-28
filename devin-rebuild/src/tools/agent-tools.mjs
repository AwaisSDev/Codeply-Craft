/**
 * Tools that act on the agent itself: skill, run_subagent, read_subagent,
 * ask_user_question, exit_plan_mode.
 */
import fs from 'node:fs';
import path from 'node:path';
import { renderSkill } from '../context/skills.mjs';
import { BUILTIN_SUBAGENTS } from '../agent/profiles.mjs';
import { dataDir } from '../config/paths.mjs';

export function skillTool(agent) {
  return {
    name: 'skill',
    kind: 'meta',
    description: 'Load a skill by name: its instructions are returned for you to follow (or it runs as a subagent if the skill says so). Only skills listed in the system prompt are available.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string' }, arguments: { type: 'string', description: 'Arguments, as the user would type after /name' } },
      required: ['name'],
    },
    target: () => null,
    async run(input) {
      const s = (agent.skills || []).find((x) => (x.display_name === input.name || x.name === input.name) && x.triggers.includes('model'));
      if (!s) return { isError: true, content: `No model-invocable skill named '${input.name}'.` };
      return invokeSkill(agent, s, input.arguments || '', { fromModel: true });
    },
  };
}

/** Run a skill: inline (instructions returned) or as a foreground subagent. */
export async function invokeSkill(agent, s, args, { fromModel = false } = {}) {
  const body = renderSkill(s, args);
  if (s.agent && agent.depth === 0) {
    const r = await runSubagent(agent, { profile: s.agent, task: body, title: `/${s.display_name}`, model: s.model });
    return { content: r.content, isError: r.isError };
  }
  // allowed-tools and permissions apply while the skill's instructions are in play.
  for (const t of s.allowedTools || []) agent.permissions.add({ effect: 'allow', rule: t, level: 'skill', source: s.path });
  for (const effect of ['allow', 'deny', 'ask']) for (const r of s.permissions?.[effect] || []) agent.permissions.add({ effect, rule: r, level: 'skill', source: s.path });
  const header = `<skill name="${s.display_name}" base_dir="${s.base_dir}">`;
  const text = `${header}\n${body.trim()}\n</skill>`;
  return { content: fromModel ? `${text}\n\nFollow these instructions now.` : text };
}

// ─── subagents ───────────────────────────────────────────────────────────

const subagents = new Map();
let subagentSeq = 1;

function profileFor(agent, name) {
  return [...BUILTIN_SUBAGENTS, ...(agent.subagentProfiles || []).filter((p) => !BUILTIN_SUBAGENTS.some((b) => b.name === p.name))].find((p) => p.name === name);
}

export async function runSubagent(parent, { profile = 'subagent_general', task, title, background = false, model }) {
  const prof = profileFor(parent, profile);
  if (!prof) return { isError: true, content: `Unknown subagent profile '${profile}'.` };
  if (!parent.createChild) return { isError: true, content: 'Subagents are not available here.' };
  const id = `sub_${subagentSeq++}`;
  const rec = { id, profile: prof.name, title: title || task.slice(0, 60), status: 'running', started: Date.now(), result: null, toolCalls: 0 };
  subagents.set(id, rec);
  const child = parent.createChild({ profile: prof, model, background, record: rec });
  const promise = child.run(task).then((r) => {
    rec.status = r.stopReason === 'cancelled' ? 'cancelled' : 'completed';
    rec.result = r.text || '(the subagent produced no final message)';
    return rec;
  }, (e) => { rec.status = 'failed'; rec.result = e.message; return rec; });
  rec.promise = promise;
  parent.session.subagents = [...(parent.session.subagents || []), { id, profile: rec.profile, title: rec.title }];
  if (background) return { content: `Started ${prof.name} in the background as ${id}. Check it with read_subagent.` };
  await promise;
  return { isError: rec.status === 'failed', content: `[${prof.name} ${rec.status} after ${Math.round((Date.now() - rec.started) / 1000)}s, ${rec.toolCalls} tool calls]\n\n${rec.result}` };
}

export function runSubagentTool(agent) {
  return {
    name: 'run_subagent',
    kind: 'meta',
    description: 'Hand a self-contained task to a subagent with its own fresh context. It does not see this conversation, so give it everything it needs. Returns the subagent\'s final report. Use background=true to keep working while it runs, then read_subagent.',
    input_schema: {
      type: 'object',
      properties: {
        profile: { type: 'string', description: 'subagent_explore, subagent_general, or a custom profile' },
        task: { type: 'string', description: 'Complete instructions for the subagent' },
        title: { type: 'string', description: 'Three to six words shown to the user' },
        background: { type: 'boolean' },
      },
      required: ['profile', 'task'],
    },
    target: () => null,
    run: (input) => runSubagent(agent, input),
  };
}

export const readSubagentTool = {
  name: 'read_subagent',
  kind: 'meta',
  description: 'Get the status and (when finished) the report of a subagent started with run_subagent. Set wait=true to block until it finishes.',
  input_schema: { type: 'object', properties: { id: { type: 'string' }, wait: { type: 'boolean' } }, required: ['id'] },
  target: () => null,
  async run(input) {
    const rec = subagents.get(input.id);
    if (!rec) return { isError: true, content: `No subagent ${input.id}.` };
    if (input.wait && rec.status === 'running') await rec.promise;
    const secs = Math.round((Date.now() - rec.started) / 1000);
    return { content: `[${rec.profile} "${rec.title}": ${rec.status}, ${secs}s, ${rec.toolCalls} tool calls]${rec.result ? `\n\n${rec.result}` : ''}` };
  },
};

// ─── user interaction ────────────────────────────────────────────────────

export function askUserQuestionTool(agent) {
  return {
    name: 'ask_user_question',
    kind: 'meta',
    description: 'Ask the user one or more multiple-choice questions when a decision is genuinely theirs. Each question has a short header (max 16 chars), 2-4 options, and the user can always answer in their own words.',
    input_schema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string' },
              header: { type: 'string' },
              options: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, description: { type: 'string' } }, required: ['label'] } },
              multiSelect: { type: 'boolean' },
            },
            required: ['question', 'options'],
          },
        },
      },
      required: ['questions'],
    },
    target: () => null,
    async run(input) {
      if (!agent.ui.askUser) return { isError: true, content: 'The user cannot be asked questions in this mode (non-interactive). Make a reasonable choice, state it, and continue.' };
      const answers = await agent.ui.askUser(input.questions || []);
      if (!answers) return { content: 'The user dismissed the questions without answering.' };
      return { content: input.questions.map((q, i) => `Q: ${q.question}\nA: ${answers[i] ?? '(skipped)'}`).join('\n\n') };
    },
  };
}

export function exitPlanModeTool(agent) {
  return {
    name: 'exit_plan_mode',
    kind: 'meta',
    description: 'Present your finished plan for approval and leave plan mode. Only call this in plan mode, once the plan is concrete.',
    input_schema: { type: 'object', properties: { plan: { type: 'string', description: 'The plan in markdown' } }, required: ['plan'] },
    target: () => null,
    async run(input) {
      const dir = path.join(dataDir(), 'cli', 'plans');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${agent.session.id}.md`);
      fs.writeFileSync(file, input.plan);
      const choice = agent.ui.planApproval ? await agent.ui.planApproval(input.plan, file) : 'no';
      if (choice === 'no' || !choice) return { content: `The user wants changes to the plan (saved at ${file}). Ask what they would like changed, or revise it, and stay in plan mode.` };
      agent.pendingProfileSwitch = 'normal';
      agent.permissions.mode = choice === 'bypass' ? 'bypass' : 'accept-edits';
      agent.session.mode = agent.permissions.mode;
      return { content: `The user approved the plan (saved at ${file}). You are now out of plan mode, in ${agent.permissions.mode} mode. Implement the plan now.` };
    },
  };
}
