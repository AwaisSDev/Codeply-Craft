/**
 * Lifecycle hooks.
 *
 * Sources (all collected, all run, each file once):
 *   <dir>/.dvn/hooks.v1.json, <dir>/.devin/hooks.v1.json   whole file = hooks object
 *   "hooks" in any config.json / config.local.json
 *   "hooks" in .claude/settings*.json, ~/.claude.json, ~/.claude/settings*.json
 *
 *   { "PreToolUse": [ { "matcher": "exec|write",
 *       "hooks": [ { "type": "command", "command": "./check.sh", "timeout": 10 } ] } ] }
 *
 * Events: SessionStart, SessionEnd, UserPromptSubmit, PreToolUse,
 * PermissionRequest, PostToolUse, Stop, PreCompact, PostCompact, PostCompaction.
 * The matcher is an unanchored regex on tool_name (or manual/auto for compaction).
 *
 * A command hook gets the event as JSON on stdin. Exit 0: stdout may be JSON
 * with decision approve|block, reason, stop, continue:false + stopReason, and
 * hookSpecificOutput.{additionalContext, updatedInput, updatedToolOutput}.
 * Exit 2: block, reason from stderr. Anything else is logged and ignored,
 * unless the hook set fail_closed, which turns a broken hook into a block.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readJsonFile, projectDirs } from '../config/config.mjs';
import { homeDir } from '../config/paths.mjs';

export const EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop', 'PreCompact', 'PostCompact', 'PostCompaction'];
const IGNORED_EVENTS = new Set(['Notification', 'SubagentStop']);
const DEFAULT_TIMEOUT_S = 60;

/** Gather hook definitions: [{ id, event, matcher, hook, source, projectDir }]. */
export function collectHooks({ cwd, config, readConfigFrom = {} }) {
  const sources = [];
  const seen = new Set();
  const addSource = (file, hooksObj, projectDir) => {
    if (!hooksObj || typeof hooksObj !== 'object') return;
    let key = file;
    try { key = fs.realpathSync(file); } catch { /* inline */ }
    if (seen.has(key)) return;
    seen.add(key);
    sources.push({ file, hooks: hooksObj, projectDir });
  };
  const root = config?.root || cwd;
  for (const h of config?.hooks || []) addSource(h.file, h.hooks, h.level === 'user' ? root : path.dirname(path.dirname(h.file)));
  for (const dir of projectDirs(cwd)) {
    for (const ns of ['.dvn', '.devin']) {
      if (ns === '.devin' && readConfigFrom.devin === false) continue;
      const f = path.join(dir, ns, 'hooks.v1.json');
      const data = readJsonFile(f);
      if (data) addSource(f, data, dir);
    }
    if (readConfigFrom.claude !== false) {
      for (const n of ['settings.json', 'settings.local.json']) {
        const f = path.join(dir, '.claude', n);
        const data = readJsonFile(f);
        if (data?.hooks) addSource(f, data.hooks, dir);
      }
    }
  }
  if (readConfigFrom.claude !== false) {
    for (const f of [path.join(homeDir(), '.claude.json'), path.join(homeDir(), '.claude', 'settings.json'), path.join(homeDir(), '.claude', 'settings.local.json')]) {
      const data = readJsonFile(f);
      if (data?.hooks) addSource(f, data.hooks, root);
    }
  }

  const out = [];
  let n = 1;
  for (const src of sources) {
    for (const [event, groups] of Object.entries(src.hooks)) {
      if (IGNORED_EVENTS.has(event) || !Array.isArray(groups)) continue;
      if (!EVENTS.includes(event)) continue;
      for (const g of groups) {
        for (const hook of Array.isArray(g?.hooks) ? g.hooks : []) {
          if (!hook || (hook.type !== 'command' && hook.type !== 'prompt')) continue;
          out.push({ id: `hook-${n++}`, event, matcher: g.matcher ?? '', hook, source: src.file, projectDir: src.projectDir });
        }
      }
    }
  }
  return out;
}

function matches(matcher, subject) {
  if (matcher === undefined || matcher === null || matcher === '' || matcher === '*') return true;
  const list = Array.isArray(matcher) ? matcher : [matcher];
  return list.some((m) => { try { return new RegExp(m).test(subject ?? ''); } catch { return m === subject; } });
}

function runCommand(def, payload) {
  const timeout = (Number(def.hook.timeout) || DEFAULT_TIMEOUT_S) * 1000;
  return new Promise((resolve) => {
    const env = { ...process.env, DVN_PROJECT_DIR: def.projectDir, DEVIN_PROJECT_DIR: def.projectDir, CLAUDE_PROJECT_DIR: def.projectDir };
    const child = spawn('bash', ['-c', def.hook.command], { cwd: def.projectDir, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const t = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { clearTimeout(t); resolve({ code: null, stdout, stderr: e.message, error: e.message }); });
    child.on('close', (code) => { clearTimeout(t); resolve({ code, stdout, stderr, error: timedOut ? `timed out after ${timeout / 1000}s` : null }); });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

export class HookRunner {
  /** promptJudge: async (promptText, payload) => {decision, reason} for type "prompt" hooks. */
  constructor({ hooks = [], sessionId, log = () => {}, promptJudge = null }) {
    this.hooks = hooks;
    this.sessionId = sessionId;
    this.promptId = null;
    this.log = log;
    this.promptJudge = promptJudge;
  }

  has(event) { return this.hooks.some((h) => h.event === event); }

  /**
   * Run every hook for `event` whose matcher fits `subject`.
   * Returns { block, reason, approve, stop, additionalContext[], updatedInput, updatedToolOutput }.
   */
  async run(event, fields = {}, subject = fields.tool_name) {
    const result = { block: false, reason: '', approve: false, stop: null, additionalContext: [], updatedInput: null, updatedToolOutput: null };
    const defs = this.hooks.filter((h) => h.event === event && matches(h.matcher, subject));
    if (!defs.length) return result;
    const payload = { hook_event_name: event, session_id: this.sessionId, ...(this.promptId ? { prompt_id: this.promptId } : {}), cwd: process.cwd(), ...fields };
    const outcomes = await Promise.all(defs.map(async (def) => {
      if (def.hook.type === 'prompt') {
        if (!this.promptJudge) return null;
        try { return { def, json: await this.promptJudge(def.hook.prompt, payload), code: 0 }; } catch (e) { return { def, code: null, error: e.message }; }
      }
      const r = await runCommand(def, payload);
      let json = null;
      if (r.code === 0 && r.stdout.trim()) { try { json = JSON.parse(r.stdout); } catch { json = { _text: r.stdout.trim() }; } }
      return { def, json, ...r };
    }));
    for (const o of outcomes) {
      if (!o) continue;
      const { def } = o;
      if (o.code === 2) {
        result.block = true;
        result.reason = [result.reason, o.stderr.trim() || `blocked by hook ${def.hook.command || 'prompt'}`].filter(Boolean).join('\n');
        continue;
      }
      if (o.code !== 0) {
        this.log(`hook ${def.id} (${def.event}, ${def.source}) failed: ${o.error || `exit ${o.code}`} ${o.stderr?.trim() || ''}`.trim());
        if (def.hook.fail_closed) { result.block = true; result.reason = [result.reason, `hook ${def.hook.command} failed and is fail_closed`].filter(Boolean).join('\n'); }
        continue;
      }
      const j = o.json;
      if (!j) continue;
      if (j._text !== undefined) {
        if (event === 'UserPromptSubmit' || event === 'SessionStart') result.additionalContext.push(j._text);
        continue;
      }
      if (j.decision === 'block' || j.decision === 'deny') { result.block = true; result.reason = [result.reason, j.reason].filter(Boolean).join('\n'); }
      if (j.decision === 'approve' || j.decision === 'allow') result.approve = true;
      if (j.stop) result.stop = String(j.stop);
      if (j.continue === false) result.stop = j.stopReason || 'stopped by hook';
      const hso = j.hookSpecificOutput || {};
      if (hso.additionalContext) result.additionalContext.push(String(hso.additionalContext));
      if (hso.updatedInput && typeof hso.updatedInput === 'object') result.updatedInput = { ...(result.updatedInput || {}), ...hso.updatedInput };
      if (hso.updatedToolOutput !== undefined) result.updatedToolOutput = typeof hso.updatedToolOutput === 'string' ? hso.updatedToolOutput : JSON.stringify(hso.updatedToolOutput);
      if (hso.permissionDecision === 'deny') { result.block = true; result.reason = [result.reason, hso.permissionDecisionReason].filter(Boolean).join('\n'); }
      if (hso.permissionDecision === 'allow') result.approve = true;
    }
    return result;
  }
}
