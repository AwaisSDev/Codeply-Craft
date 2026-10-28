/**
 * The agent loop.
 *
 * One user turn: UserPromptSubmit hooks, then model call -> tool calls ->
 * results, repeated until the model stops asking for tools and no Stop hook
 * objects. Every tool call goes PreToolUse hook -> permission rules/mode ->
 * (PermissionRequest hook / user prompt) -> run -> rule injection ->
 * PostToolUse hook. Context is compacted automatically near the model's
 * window. File edits are checkpointed per step so /revert can undo them.
 *
 * The UI is a set of callbacks so the same loop drives the REPL, print mode,
 * subagents and the ACP server:
 *   text(delta) thinking(delta) toolStart(call) toolEnd(call, result)
 *   ask(request) -> 'once'|'session'|'project'|'local'|'user'|'bypass'|'deny'|{deny, feedback}
 *   askUser(questions) -> answers | null     planApproval(plan) -> 'accept-edits'|'bypass'|'no'
 *   notice(msg) warn(msg) todos(list) usage(totals)
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildSystemPrompt } from './prompt.mjs';
import { AGENT_PROFILES } from './profiles.mjs';
import { baseTools } from '../tools/index.mjs';
import { modelId, providerFor, resolveModel } from '../providers/models.mjs';
import { RuleTracker } from '../context/rules.mjs';
import { saveSession } from '../sessions/store.mjs';
import { persistPermission } from '../config/config.mjs';

const DEFAULT_MAX_STEPS = 200;

function textOf(content) {
  if (typeof content === 'string') return content;
  return (content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
}

function toolResultBlock(id, result) {
  let content = result.content;
  if (typeof content !== 'string' && !Array.isArray(content)) content = JSON.stringify(content);
  if (Array.isArray(content) && !content.length) content = '(no output)';
  return { type: 'tool_result', tool_use_id: id, content, ...(result.isError ? { is_error: true } : {}) };
}

function validateInput(tool, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'Tool input must be a JSON object.';
  if (input._raw !== undefined) return `Tool input was not valid JSON: ${String(input._raw).slice(0, 200)}`;
  for (const k of tool.input_schema?.required || []) if (input[k] === undefined || input[k] === null) return `Missing required parameter '${k}'.`;
  return null;
}

export class Agent {
  /**
   * opts: { session, config, permissions (PermissionEngine), hooks (HookRunner),
   *   rules, skills, subagentProfiles, mcp (McpManager), ui, cwd, profile,
   *   depth, extraTools, toolFilter, systemExtra, printMode, sandboxWrap, log }
   */
  constructor(opts) {
    Object.assign(this, opts);
    this.cwd = opts.cwd || opts.session.working_directory;
    this.profile = opts.profile || opts.session.profile || 'normal';
    this.depth = opts.depth || 0;
    this.readFiles = new Map();
    this.ruleTracker = new RuleTracker({ cwd: this.cwd, readConfigFrom: opts.config.readConfigFrom, rules: [...(opts.rules || [])] });
    this.log = opts.log || (() => {});
    this.setModel(opts.model || opts.session.model);
    this.steps = opts.session.steps ||= [];
  }

  setModel(name) {
    this.modelEntry = resolveModel(name || this.config.settings.agent?.model, this.config.settings);
    this.provider = this.providerOverride || providerFor(this.modelEntry);
    this.session.model = this.modelEntry.id;
  }

  /** Tools for the current profile, after disabled_tools and filters. */
  tools() {
    const all = [...baseTools(this), ...(this.extraTools || []), ...(this.mcp ? [...this.mcp.tools(), ...this.mcp.managementTools()] : [])];
    const disabled = new Set(this.config.settings.disabled_tools || []);
    let list = all.filter((t) => !disabled.has(t.name));
    const prof = AGENT_PROFILES[this.profile];
    if (prof?.tools) list = list.filter((t) => prof.tools.includes(t.name) || (prof.allowReadOnlyMcp && t.kind === 'mcp' && t.readOnly));
    if (this.toolFilter) list = list.filter(this.toolFilter);
    const seen = new Set();
    return list.filter((t) => (seen.has(t.name) ? false : seen.add(t.name)));
  }

  systemPrompt() {
    return buildSystemPrompt({
      cwd: this.cwd,
      workspaceDirs: this.session.workspace_dirs,
      model: this.modelEntry.id,
      profile: this.profile,
      rules: this.ruleTracker.rules,
      skills: this.skills || [],
      subagentProfiles: this.tools().some((t) => t.name === 'run_subagent') ? this.subagentProfiles || [] : [],
      mcpInstructions: this.mcp ? [...this.mcp.state].filter(([, s]) => s.client?.instructions).map(([name, s]) => ({ name, text: s.client.instructions })) : [],
      extra: this.systemExtra,
    });
  }

  toolContext(signal) {
    return {
      cwd: this.cwd,
      env: {},
      signal,
      session: this.session,
      readFiles: this.readFiles,
      ui: this.ui,
      agent: this,
      sandboxWrap: this.sandboxWrap,
      checkpoint: (file, before) => {
        const step = this.steps[this.steps.length - 1];
        if (step && !(file in step.files)) step.files[file] = before;
      },
    };
  }

  // ─── turn ──────────────────────────────────────────────────────────────

  /**
   * Run one user turn. `prompt` is a string or content blocks.
   * Resolves { stopReason, text, blocked? }.
   */
  async run(prompt, { signal } = {}) {
    const promptText = typeof prompt === 'string' ? prompt : textOf(prompt);
    if (this.hooks) {
      this.hooks.promptId = `prompt-${Date.now().toString(36)}`;
      const h = await this.hooks.run('UserPromptSubmit', { prompt: promptText }, '');
      if (h.block) { this.ui.warn?.(`Prompt blocked by hook${h.reason ? `: ${h.reason}` : ''}`); return { stopReason: 'blocked', text: '', blocked: true }; }
      if (h.additionalContext.length) prompt = [{ type: 'text', text: promptText }, { type: 'text', text: `<hook_context>\n${h.additionalContext.join('\n')}\n</hook_context>` }];
    }
    const content = typeof prompt === 'string' ? [{ type: 'text', text: prompt }] : prompt;
    this.steps.push({ index: this.steps.length + 1, prompt: promptText.slice(0, 200), messageIndex: this.session.messages.length, files: {}, at: new Date().toISOString() });
    this.session.messages.push({ role: 'user', content });
    if (!this.session.title) this.session.title = promptText.replace(/\s+/g, ' ').trim().slice(0, 60);
    return this.loop(signal);
  }

  async loop(signal) {
    let stopHookActive = false;
    let lastText = '';
    for (let step = 0; step < (this.maxSteps || DEFAULT_MAX_STEPS); step++) {
      if (signal?.aborted) return { stopReason: 'cancelled', text: lastText };
      await this.maybeCompact(signal);
      let resp;
      try {
        resp = await this.callModel(signal);
      } catch (e) {
        if (signal?.aborted) return { stopReason: 'cancelled', text: lastText };
        throw e;
      }
      this.session.messages.push({ role: 'assistant', content: resp.content.length ? resp.content : [{ type: 'text', text: '' }] });
      const text = textOf(resp.content);
      if (text) lastText = text;
      this.persist();

      const calls = resp.content.filter((b) => b.type === 'tool_use');
      if (!calls.length) {
        if (resp.stopReason === 'max_tokens') { this.ui.warn?.('The response was cut off at the output token limit.'); return { stopReason: 'max_tokens', text: lastText }; }
        if (resp.stopReason === 'refusal') { this.ui.warn?.('The model declined this request.'); return { stopReason: 'refusal', text: lastText }; }
        if (this.hooks?.has('Stop')) {
          const h = await this.hooks.run('Stop', { stop_hook_active: stopHookActive, last_assistant_message: lastText }, '');
          if (h.block && h.reason) {
            stopHookActive = true;
            this.session.messages.push({ role: 'user', content: [{ type: 'text', text: `<stop_hook_feedback>\n${h.reason}\n</stop_hook_feedback>` }] });
            continue;
          }
        }
        return { stopReason: 'end_turn', text: lastText };
      }

      const results = [];
      let stopRequested = null;
      for (const call of calls) {
        if (signal?.aborted) { results.push(toolResultBlock(call.id, { isError: true, content: 'Cancelled by the user before this tool ran.' })); continue; }
        const r = await this.runTool(call, signal);
        if (r.stop) stopRequested = r.stop;
        results.push(toolResultBlock(call.id, r));
      }
      this.session.messages.push({ role: 'user', content: results });
      this.persist();
      if (signal?.aborted) return { stopReason: 'cancelled', text: lastText };
      if (stopRequested) { this.ui.notice?.(`Stopped by hook: ${stopRequested}`); return { stopReason: 'hook_stop', text: lastText }; }
      if (this.pendingProfileSwitch) { this.profile = this.pendingProfileSwitch; this.session.profile = this.profile; this.pendingProfileSwitch = null; }
    }
    this.ui.warn?.('Stopped after reaching the step limit for one turn.');
    return { stopReason: 'step_limit', text: lastText };
  }

  async callModel(signal) {
    const tools = this.tools();
    let attempt = 0;
    for (;;) {
      try {
        const resp = await this.provider.complete({
          model: modelId(this.modelEntry),
          system: this.systemPrompt(),
          messages: this.session.messages,
          tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
          maxTokens: this.modelEntry.max_output || 32000,
          thinking: this.thinkingBudget,
          signal,
          onText: (d) => this.ui.text?.(d),
          onThinking: (d) => this.ui.thinking?.(d),
        });
        const u = resp.usage || {};
        const tot = this.session.usage ||= { input_tokens: 0, output_tokens: 0 };
        tot.input_tokens += (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        tot.output_tokens += u.output_tokens || 0;
        this.lastContextTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
        this.ui.usage?.(tot, this.lastContextTokens);
        return resp;
      } catch (e) {
        // Context overflow: compact once and retry.
        if (attempt++ === 0 && (e.status === 400 || e.status === 413) && /context|too long|maximum|token/i.test(e.message)) {
          await this.compact({ reason: 'auto', signal });
          continue;
        }
        throw e;
      }
    }
  }

  // ─── tools ─────────────────────────────────────────────────────────────

  async runTool(call, signal) {
    const tools = this.tools();
    const tool = tools.find((t) => t.name === call.name);
    this.ui.toolStart?.(call);
    const finish = (r) => { this.ui.toolEnd?.(call, r); return r; };
    if (!tool) return finish({ isError: true, content: `Unknown tool '${call.name}'. Available: ${tools.map((t) => t.name).join(', ')}` });
    let input = call.input;
    const invalid = validateInput(tool, input);
    if (invalid) return finish({ isError: true, content: invalid });

    let preApproved = false;
    if (this.hooks) {
      const h = await this.hooks.run('PreToolUse', { tool_name: tool.name, tool_input: input, tool_provenance: tool.provenance });
      if (h.block) return finish({ isError: true, content: `Blocked by a PreToolUse hook: ${h.reason || 'no reason given'}` });
      if (h.updatedInput) { input = { ...input, ...h.updatedInput }; call.input = input; }
      if (h.approve) preApproved = true;
      if (h.stop) return finish({ isError: true, content: `Stopped by hook: ${h.stop}`, stop: h.stop });
    }

    const verdict = await this.permissions.decide(tool, input);
    if (verdict.decision === 'deny') return finish({ isError: true, content: `Permission denied: ${verdict.reason}. Do not retry this; find another way or ask the user.` });
    if (verdict.decision === 'ask' && !preApproved) {
      const answer = await this.requestPermission(tool, input, verdict);
      if (answer.denied) return finish({ isError: true, content: answer.feedback ? `The user denied this and said: ${answer.feedback}` : 'The user denied permission for this tool call. Do not retry it; ask how they want to proceed if you are blocked.' });
    }

    let result;
    try {
      result = await tool.run(input, this.toolContext(signal));
      if (typeof result === 'string') result = { content: result };
    } catch (e) {
      result = { isError: true, content: `${tool.name} failed: ${e.message}` };
    }

    // New rules triggered by touching this path (nested AGENTS.md, glob rules).
    const touched = tool.kind === 'read' || tool.kind === 'edit' ? tool.target?.(input, { cwd: this.cwd }) : null;
    if (touched && typeof touched === 'string') {
      const extra = this.ruleTracker.onPathTouched(touched);
      if (extra) result = { ...result, content: appendText(result.content, `\n\n<system-reminder>These project rules apply to files here:\n${extra}\n</system-reminder>`) };
    }

    if (this.hooks) {
      const outText = typeof result.content === 'string' ? result.content : textOf(result.content);
      const h = await this.hooks.run('PostToolUse', { tool_name: tool.name, tool_input: input, tool_response: { success: !result.isError, output: result.isError ? '' : outText, error: result.isError ? outText : null } });
      if (h.updatedToolOutput !== null) result = { ...result, content: h.updatedToolOutput };
      if (h.additionalContext.length) result = { ...result, content: appendText(result.content, `\n\n<hook_context>\n${h.additionalContext.join('\n')}\n</hook_context>`) };
      if (h.block && h.reason) result = { ...result, content: appendText(result.content, `\n\n<hook_feedback>\n${h.reason}\n</hook_feedback>`) };
      if (h.stop) result.stop = h.stop;
    }
    return finish(result);
  }

  async requestPermission(tool, input, verdict) {
    if (this.hooks?.has('PermissionRequest')) {
      const h = await this.hooks.run('PermissionRequest', { tool_name: tool.name, tool_input: input });
      if (h.approve) return { denied: false };
      if (h.block) return { denied: true, feedback: h.reason };
    }
    const suggestions = this.permissions.suggestRule(verdict.action);
    const reply = this.ui.ask ? await this.ui.ask({ tool, input, verdict, suggestions, agentName: this.agentName }) : 'deny';
    const answer = typeof reply === 'string' ? reply : reply?.decision || 'deny';
    if (answer === 'deny') return { denied: true, feedback: reply?.feedback };
    if (answer === 'bypass') { this.permissions.mode = 'bypass'; this.session.mode = 'bypass'; this.ui.notice?.('Switched to bypass mode.'); return { denied: false }; }
    if (answer === 'once') return { denied: false };
    const rules = reply?.rules || suggestions;
    for (const rule of rules) {
      this.permissions.add({ effect: 'allow', rule, level: 'session', source: 'session' });
      if (answer === 'project' || answer === 'local' || answer === 'user') {
        try {
          const file = persistPermission({ level: answer, rule, root: this.config.root, userFile: this.config.userFile });
          this.ui.notice?.(`Saved ${rule} to ${file}`);
        } catch (e) { this.ui.warn?.(`Could not save permission: ${e.message}`); }
      }
    }
    return { denied: false };
  }

  // ─── context management ───────────────────────────────────────────────

  compactionThreshold() {
    const configured = this.config.settings.agent?.compaction_threshold_tokens;
    const windowTokens = this.modelEntry.context || 200000;
    return Math.min(configured || Infinity, Math.floor(windowTokens * 0.8));
  }

  async maybeCompact(signal) {
    if (!this.lastContextTokens || this.lastContextTokens < this.compactionThreshold()) return;
    await this.compact({ reason: 'auto', signal });
  }

  /** Replace the history with a model-written summary. */
  async compact({ reason = 'manual', signal, instructions = '' } = {}) {
    if (this.session.messages.length < 2) return null;
    if (this.hooks) await this.hooks.run('PreCompact', { trigger: reason }, reason);
    const transcript = this.session.messages.map((m) => {
      const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
      return blocks.map((b) => {
        if (b.type === 'text') return `${m.role.toUpperCase()}: ${b.text}`;
        if (b.type === 'tool_use') return `TOOL CALL ${b.name}: ${JSON.stringify(b.input).slice(0, 2000)}`;
        if (b.type === 'tool_result') return `TOOL RESULT${b.is_error ? ' (error)' : ''}: ${(typeof b.content === 'string' ? b.content : textOf(b.content)).slice(0, 3000)}`;
        return '';
      }).filter(Boolean).join('\n');
    }).join('\n\n');
    const ask = `Summarize this coding session so another engineer can continue it seamlessly. Include: the user's goals and every explicit instruction or preference; what has been done (files changed, commands run, results); the current state, including anything broken or unverified; open questions; and the exact next steps. Keep file paths, function names, error messages and decisions precise.${instructions ? `\nAlso: ${instructions}` : ''}\n\n<transcript>\n${transcript.slice(-400_000)}\n</transcript>`;
    const resp = await this.provider.complete({ model: modelId(this.modelEntry), system: 'You write precise handover summaries of coding sessions.', messages: [{ role: 'user', content: [{ type: 'text', text: ask }] }], maxTokens: 8000, signal });
    const summary = textOf(resp.content).trim();
    if (!summary) return null;
    const before = this.session.messages.length;
    this.session.compactions = (this.session.compactions || 0) + 1;
    this.session.messages = [{ role: 'user', content: [{ type: 'text', text: `<conversation_summary>\nThe conversation so far was compacted. Summary:\n\n${summary}\n</conversation_summary>\n\nContinue from where things left off.` }] }];
    this.session.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'Understood. Continuing from the summary.' }] });
    for (const s of this.steps) s.messageIndex = 0;
    this.lastContextTokens = 0;
    this.persist();
    if (this.hooks) {
      await this.hooks.run('PostCompact', { trigger: reason }, reason);
      await this.hooks.run('PostCompaction', { summary });
    }
    this.log(`compacted ${before} messages (${reason})`);
    return summary;
  }

  /** Undo file changes made from step n onward and rewind the conversation. */
  revert(n) {
    const idx = this.steps.findIndex((s) => s.index === n);
    if (idx < 0) throw new Error(`No step ${n}`);
    const later = this.steps.slice(idx);
    const restored = [];
    for (const step of later.reverse()) {
      for (const [file, before] of Object.entries(step.files)) {
        if (before === null) { try { fs.rmSync(file); restored.push(`removed ${file}`); } catch { /* already gone */ } }
        else { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, before); restored.push(`restored ${file}`); }
      }
    }
    this.session.messages = this.session.messages.slice(0, this.steps[idx].messageIndex);
    this.steps.splice(idx);
    this.readFiles.clear();
    this.persist();
    return restored;
  }

  persist() {
    if (this.ephemeral) return;
    try { saveSession(this.session); } catch (e) { this.log(`could not save session: ${e.message}`); }
  }
}

function appendText(content, extra) {
  if (typeof content === 'string') return content + extra;
  return [...(content || []), { type: 'text', text: extra }];
}
