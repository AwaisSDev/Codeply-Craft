/**
 * Builds a ready-to-run Agent for a directory: config, rules, skills, MCP,
 * hooks, permissions and subagent profiles, plus the factory for subagents.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Agent } from './agent.mjs';
import { BUILTIN_SUBAGENTS, loadCustomSubagents } from './profiles.mjs';
import { loadConfig } from '../config/config.mjs';
import { logsDir } from '../config/paths.mjs';
import { discoverRules } from '../context/rules.mjs';
import { discoverSkills } from '../context/skills.mjs';
import { collectHooks, HookRunner } from '../hooks/hooks.mjs';
import { McpManager } from '../mcp/manager.mjs';
import { PermissionEngine, normalizeMode } from '../permissions/engine.mjs';
import { newSession } from '../sessions/store.mjs';
import { modelId, providerFor, resolveModel } from '../providers/models.mjs';
import { sandboxWrapper } from '../permissions/sandbox.mjs';

export function makeLogger() {
  const dir = logsDir();
  const file = path.join(dir, `dvn_${new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}_${process.pid}.log`);
  return (msg) => {
    try { fs.mkdirSync(dir, { recursive: true }); fs.appendFileSync(file, `${new Date().toISOString()} ${msg}\n`); } catch { /* logging must never break the agent */ }
  };
}

/** A small, cheap model call used by smart mode and prompt hooks. */
function fastJudge(config, log) {
  let entry;
  try { entry = resolveModel(config.settings.agent?.judge_model || 'haiku', config.settings); } catch { try { entry = resolveModel(null, config.settings); } catch { return null; } }
  const provider = providerFor(entry);
  return async (system, user) => {
    const r = await provider.complete({ model: modelId(entry), system, messages: [{ role: 'user', content: [{ type: 'text', text: user }] }], maxTokens: 300 });
    const text = r.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    log(`judge: ${text.slice(0, 200)}`);
    return text;
  };
}

export async function createRuntime({
  cwd = process.cwd(), configPath, model, mode, sandbox = false, session, ui, profile, startMcp = true, providerOverride, log = makeLogger(),
}) {
  const config = loadConfig({ cwd, configPath });
  for (const w of config.warnings) ui.warn?.(w);
  const rules = discoverRules({ cwd, readConfigFrom: config.readConfigFrom });
  const workspaceDirs = [...(config.settings['workspace-dirs'] || []), ...(session?.workspace_dirs || [])].map((d) => path.resolve(cwd, d));
  const skills = discoverSkills({ cwd, readConfigFrom: config.readConfigFrom, extraDirs: workspaceDirs });
  const subWarnings = [];
  const subagentProfiles = [...BUILTIN_SUBAGENTS, ...loadCustomSubagents({ cwd, readConfigFrom: config.readConfigFrom, warnings: subWarnings })];
  subWarnings.forEach((w) => log(w));

  const resolvedMode = normalizeMode(mode || session?.mode || 'normal');
  if (resolvedMode === 'autonomous' && !sandbox) throw new Error('autonomous mode needs --sandbox');
  const effectiveMode = sandbox ? 'autonomous' : resolvedMode;

  const judgeCall = fastJudge(config, log);
  const judge = judgeCall ? async (action) => {
    const what = action.type === 'exec' ? `Shell command: ${action.command}` : action.type === 'fetch' ? `HTTP GET ${action.url}` : `MCP tool ${action.tool}`;
    const ans = await judgeCall('You review actions a coding agent wants to take on a developer machine. Reply with exactly SAFE if the action is clearly read-only or harmless and confined to the project, otherwise UNSAFE. When unsure, reply UNSAFE.', `${what}\nProject directory: ${cwd}`);
    return /^\s*SAFE\b/.test(ans);
  } : null;

  const permissions = new PermissionEngine({ rules: config.permissions, mode: effectiveMode, cwd, workspaceDirs, judge });
  for (const inv of permissions.invalid) ui.warn?.(`Ignoring unrecognised permission rule '${inv.rule}' in ${inv.source}`);

  const sess = session || newSession({ cwd, model: null, mode: effectiveMode });
  sess.mode = effectiveMode;
  sess.workspace_dirs = workspaceDirs;
  const hooks = new HookRunner({
    hooks: collectHooks({ cwd, config, readConfigFrom: config.readConfigFrom }),
    sessionId: sess.id,
    log,
    promptJudge: judgeCall ? async (prompt, payload) => {
      const ans = await judgeCall('You are a policy hook. Read the rule and the event, then reply with JSON only: {"decision":"approve"|"block","reason":"..."}.', `Rule:\n${prompt}\n\nEvent:\n${JSON.stringify(payload).slice(0, 20000)}`);
      try { return JSON.parse(ans.slice(ans.indexOf('{'), ans.lastIndexOf('}') + 1)); } catch { return {}; }
    } : null,
  });

  const mcp = new McpManager({ cwd, readConfigFrom: config.readConfigFrom, log });
  if (startMcp) mcp.start();

  const agent = new Agent({
    session: sess, config, permissions, hooks, rules, skills, subagentProfiles, mcp, ui, cwd, profile: profile || sess.profile || 'normal',
    model: model || process.env.DVN_MODEL || sess.model || config.settings.agent?.model || null, log, providerOverride,
    sandboxWrap: sandbox ? sandboxWrapper({ cwd, workspaceDirs, config, permissions }) : null,
  });
  agent.createChild = (opts) => createChild(agent, opts);
  return { agent, config, rules, skills, mcp, hooks, permissions, session: sess, log };
}

/** A subagent: fresh conversation, same tools/codebase, its own profile. */
function createChild(parent, { profile, model, background, record }) {
  const session = { ...newSession({ cwd: parent.cwd, model: null, mode: parent.permissions.mode }), workspace_dirs: parent.session.workspace_dirs };
  let childModel = model || profile.model;
  if (!childModel && profile.useSubagentModel) childModel = parent.config.settings.agent?.subagent_model || parent.session.model;
  if (!childModel) childModel = parent.session.model;
  const allowed = profile.tools ? new Set(profile.tools) : null;
  const parentUi = parent.ui;
  const ui = {
    text: () => {}, thinking: () => {},
    toolStart: (call) => { record.toolCalls++; parentUi.subagentActivity?.(record, call); },
    toolEnd: () => {},
    warn: (m) => parentUi.warn?.(`[${record.profile}] ${m}`),
    notice: () => {},
    // Background subagents only get pre-approved tools; foreground ones ask the user, naming themselves.
    ask: background ? async () => 'deny' : (req) => parentUi.ask?.({ ...req, agentName: `${record.profile}: ${record.title}` }) ?? 'deny',
    askUser: null,
    usage: () => {},
  };
  const child = new Agent({
    session, config: parent.config, permissions: parent.permissions, hooks: parent.hooks,
    rules: parent.ruleTracker.rules.filter((r) => r.activation.alwaysOn || r.activation.decidable || r.activation.globs.length),
    skills: parent.skills, subagentProfiles: parent.subagentProfiles, mcp: parent.mcp, ui, cwd: parent.cwd,
    profile: 'normal', depth: parent.depth + 1, maxNesting: profile.maxNesting, model: childModel, log: parent.log,
    toolFilter: (t) => t.name !== 'ask_user_question' && (!allowed || allowed.has(t.name)),
    systemExtra: `<subagent_profile name="${profile.name}">\n${profile.prompt}\n</subagent_profile>`,
    sandboxWrap: parent.sandboxWrap, providerOverride: parent.providerOverride,
  });
  child.ephemeral = true;
  child.agentName = record.profile;
  child.createChild = (o) => createChild(child, o);
  return child;
}
