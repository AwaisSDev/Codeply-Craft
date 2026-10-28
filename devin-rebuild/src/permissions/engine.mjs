/**
 * Permission rules and modes.
 *
 * Rules (strings in permissions.allow / deny / ask at any config level):
 *   Read(<glob>)  Write(<glob>)  Exec(<prefix>)  Fetch(<url pattern>|domain:<host>)
 *   read | edit | write | grep | glob | exec | webfetch | web_search   (whole tool)
 *   mcp__<server>__<tool> | mcp__<server>__* | mcp__*
 *
 * Evaluation for one action:
 *   1. any deny matches               -> deny (nothing overrides it)
 *   2. an ask matches                 -> ask, unless an Exec/MCP allow at the
 *                                        same level is at least as specific
 *   3. an allow matches               -> allow
 *   4. otherwise                      -> the mode's default
 * Shell commands are split on && || ; | & and every part must pass.
 *
 * Mode defaults:            normal  accept-edits  smart       bypass  autonomous
 *   read (in workspace)     allow   allow         allow       allow   allow
 *   edit/write              ask     allow(ws)     allow(ws)   allow   ask
 *   exec                    ask     ask           judged      allow   allow (sandboxed)
 *   fetch                   ask     ask           judged      allow   allow
 *   mcp                     ask     ask           judged      allow   ask
 */
import os from 'node:os';
import path from 'node:path';
import { globToRegExp } from '../util/glob.mjs';

export const MODES = ['normal', 'accept-edits', 'smart', 'bypass', 'autonomous'];
const MODE_ALIASES = { auto: 'normal', code: 'normal', dangerous: 'bypass', yolo: 'bypass', 'bypass-permissions': 'bypass', acceptedits: 'accept-edits', accept_edits: 'accept-edits' };

export function normalizeMode(m) {
  if (!m) return 'normal';
  const k = String(m).toLowerCase();
  const v = MODE_ALIASES[k] || k;
  if (!MODES.includes(v)) throw new Error(`invalid permission mode '${m}' (expected normal, accept-edits, smart, dangerous or autonomous)`);
  return v;
}

const TOOL_NAMES = new Set(['read', 'edit', 'write', 'grep', 'glob', 'exec', 'webfetch', 'web_search', 'ls', 'apply_patch', 'notebook_edit', 'notebook_read']);

export function parseRule(raw) {
  const s = String(raw).trim();
  const m = /^(Read|Write|Exec|Fetch)\((.*)\)$/s.exec(s);
  if (m) return { kind: 'scope', scope: m[1], pattern: m[2].trim(), raw: s };
  if (s.startsWith('mcp__')) {
    const [, server = '*', tool = '*'] = s.split('__');
    return { kind: 'mcp', server: server || '*', tool: tool || '*', raw: s };
  }
  if (TOOL_NAMES.has(s)) return { kind: 'tool', name: s, raw: s };
  return { kind: 'invalid', raw: s };
}

// ─── matching ────────────────────────────────────────────────────────────

function expandHome(p) { return p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p; }

/** Does a Read/Write glob cover an absolute path? Relative globs are cwd-relative. */
export function pathMatches(pattern, absPath, cwd) {
  let pat = expandHome(pattern);
  if (!path.isAbsolute(pat)) pat = path.join(cwd, pat);
  pat = pat.split(path.sep).join('/');
  const p = absPath.split(path.sep).join('/');
  if (p === pat || p.startsWith(pat.replace(/\/$/, '') + '/')) return true; // a directory covers its contents
  if (pat.endsWith('/**') && p === pat.slice(0, -3)) return true;          // /etc/** covers /etc
  return globToRegExp(pat).test(p);
}

const words = (s) => s.trim().split(/\s+/).filter(Boolean);

/** Exec(prefix): whole-word prefix; * wildcards; Exec(*) matches everything. */
export function commandMatches(pattern, command) {
  const pat = pattern.trim();
  if (pat === '*' || pat === '**') return true;
  const cw = words(command);
  if (pat.includes('*')) {
    const re = new RegExp('^' + words(pat).map((w) => (w === '*' || w === '**' ? '.*' : w.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('\\S*'))).join('\\s+').replace(/\\s\+\.\*$/, '(\\s.*)?') + '$');
    return re.test(cw.join(' '));
  }
  const pw = words(pat);
  return pw.length <= cw.length && pw.every((w, i) => w === cw[i]);
}

export function urlMatches(pattern, url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (pattern.startsWith('domain:')) return u.hostname === pattern.slice(7).trim().toLowerCase();
  const re = new RegExp('^' + pattern.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
  return re.test(u.href) || re.test(u.href.replace(/\/$/, ''));
}

/** Split a shell line into the commands it runs (outside quotes). */
export function splitCommands(line) {
  const parts = [];
  let cur = '';
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { cur += c; if (c === q) q = null; else if (c === '\\' && q === '"') cur += line[++i] ?? ''; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '\\') { cur += c + (line[++i] ?? ''); continue; }
    const two = line.slice(i, i + 2);
    if (two === '&&' || two === '||') { parts.push(cur); cur = ''; i++; continue; }
    if (c === ';' || c === '|' || c === '\n' || (c === '&' && line[i + 1] !== '>' && line[i - 1] !== '>')) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  // Strip leading env assignments and subshell parens, drop empties.
  return parts.map((p) => p.trim().replace(/^[({\s]+|[)}\s]+$/g, '').replace(/^(\w+=("[^"]*"|'[^']*'|\S*)\s+)+/, '').trim()).filter(Boolean);
}

/** The concrete action a tool call performs, for rule matching. */
export function actionFor(tool, input, ctx) {
  const name = tool.name;
  if (name.startsWith('mcp__')) {
    const [, server, t] = name.split('__');
    return { type: 'mcp', tool: name, server, mcpTool: t, readOnly: !!tool.readOnly };
  }
  switch (tool.kind) {
    case 'read': return { type: 'read', tool: name, path: tool.target?.(input, ctx) || null };
    case 'edit': return { type: 'write', tool: name, path: tool.target?.(input, ctx) || null };
    case 'exec': return { type: 'exec', tool: name, command: String(input.command || '') };
    case 'network': return { type: 'fetch', tool: name, url: String(tool.target?.(input, ctx) || '') };
    default: return { type: 'meta', tool: name };
  }
}

/** Specificity of a matching rule (higher = more specific), or -1. */
function ruleMatch(rule, action, cwd, command) {
  if (rule.kind === 'tool') return rule.name === action.tool || (rule.name === 'edit' && action.type === 'write') ? 0 : -1;
  if (rule.kind === 'mcp') {
    if (action.type !== 'mcp') return -1;
    if (rule.server !== '*' && rule.server !== action.server) return -1;
    if (rule.tool !== '*' && rule.tool !== action.mcpTool) return -1;
    return rule.server === '*' ? 1 : rule.tool === '*' ? 2 : 3;
  }
  if (rule.kind !== 'scope') return -1;
  if (rule.scope === 'Read' && action.type === 'read' && action.path) return pathMatches(rule.pattern, action.path, cwd) ? 1 : -1;
  if (rule.scope === 'Write' && action.type === 'write' && action.path) return pathMatches(rule.pattern, action.path, cwd) ? 1 : -1;
  if (rule.scope === 'Exec' && action.type === 'exec') {
    if (!commandMatches(rule.pattern, command)) return -1;
    if (rule.pattern === '*' || rule.pattern === '**') return 1;
    return 10 + words(rule.pattern).length * 10 + (words(rule.pattern).length === words(command).length ? 5 : 0);
  }
  if (rule.scope === 'Fetch' && action.type === 'fetch') return urlMatches(rule.pattern, action.url) ? 1 : -1;
  return -1;
}

const LEVEL_RANK = { user: 0, project: 1, local: 2, session: 3, skill: 3, org: 4 };

function evaluateOne(rules, action, cwd, command) {
  const hits = { deny: [], ask: [], allow: [] };
  for (const r of rules) {
    const s = ruleMatch(r.parsed, action, cwd, command);
    if (s >= 0) hits[r.effect].push({ ...r, specificity: s });
  }
  if (hits.deny.length) return { decision: 'deny', rule: hits.deny[0] };
  if (hits.ask.length) {
    const carve = action.type === 'exec' || action.type === 'mcp';
    const strongestAsk = hits.ask.reduce((a, b) => (b.specificity > a.specificity ? b : a));
    const beating = carve && hits.allow.find((a) => a.level === strongestAsk.level && a.specificity >= strongestAsk.specificity && a.parsed.kind !== 'tool');
    if (!beating) return { decision: 'ask', rule: strongestAsk };
    return { decision: 'allow', rule: beating };
  }
  if (hits.allow.length) return { decision: 'allow', rule: hits.allow.reduce((a, b) => (LEVEL_RANK[b.level] > LEVEL_RANK[a.level] ? b : a)) };
  return null;
}

// Commands smart mode never auto-runs, whatever the judge says.
const NEVER_AUTO = [
  /^(sudo|su|doas)\b/, /^rm\b/, /^(npm|pnpm|yarn|bun)\s+(i|install|add|ci)\b/, /^(pip|pip3|uv\s+pip|poetry|cargo|gem|go)\s+(install|add|get)\b/,
  /^(brew|apt|apt-get|dnf|yum|pacman|apk)\b/, /^git\s+(push|commit|reset|rebase|merge|checkout|switch|clean|stash|tag|branch\s+-[dD]|am|cherry-pick|revert|pull|fetch)\b/,
  /^kubectl\s+(delete|apply|replace|scale|drain)\b/, /^(aws|gcloud|az|terraform|pulumi)\b/, /\bcurl\b.*\|\s*(ba|z)?sh\b/, /^(chmod|chown|dd|mkfs|shutdown|reboot)\b/,
  /\.env\b/, /\bid_(rsa|ed25519)\b/, /\.(pem|key)\b/, /^(ssh|scp|rsync)\b/,
];
// Plainly read-only commands smart mode can run without asking the judge.
const READ_ONLY = [
  /^(ls|pwd|cat|head|tail|wc|file|stat|du|df|which|type|echo|printf|date|whoami|uname|env|printenv|tree|realpath|dirname|basename|sort|uniq|cut|diff|cmp|md5sum|sha256sum|jq)\b/,
  /^(rg|grep|egrep|fgrep|ag|fd)\b/, /^find\b(?!.*(-delete|-exec|-ok))/, /^git\s+(status|diff|log|show|branch|remote|rev-parse|ls-files|blame|describe|config\s+--get)\b/,
  /^(node|python3?|ruby|go|cargo|rustc|java|deno|bun|npm|pnpm|yarn)\s+(--version|-v|-V|version)\b/,
];

export function isReadOnlyCommand(cmd) { return READ_ONLY.some((r) => r.test(cmd)) && !/[^>]>[^>&]|>>/.test(cmd.replace(/[12]?>\s*\/dev\/null/g, '')); }
export function isNeverAuto(cmd) { return NEVER_AUTO.some((r) => r.test(cmd)); }

export class PermissionEngine {
  /**
   * rules: [{effect, rule, level, source}] from config
   * mode: normal | accept-edits | smart | bypass | autonomous
   * judge: optional async (action) => boolean, the smart-mode fast-model check
   */
  constructor({ rules = [], mode = 'normal', cwd, workspaceDirs = [], judge = null } = {}) {
    this.rules = [];
    this.invalid = [];
    for (const r of rules) this.add(r);
    this.mode = normalizeMode(mode);
    this.cwd = path.resolve(cwd || process.cwd());
    this.workspaceDirs = workspaceDirs.map((d) => path.resolve(d));
    this.judge = judge;
  }

  add({ effect, rule, level = 'session', source = 'session' }) {
    const parsed = parseRule(rule);
    if (parsed.kind === 'invalid') { this.invalid.push({ rule, source }); return; }
    this.rules.push({ effect, rule, level, source, parsed });
  }

  inWorkspace(p) {
    if (!p) return true;
    return [this.cwd, ...this.workspaceDirs].some((d) => p === d || p.startsWith(d + path.sep));
  }

  /** Decide without prompting: { decision: allow|deny|ask, reason, rule? }. */
  async decide(tool, input, ctx = {}) {
    const action = actionFor(tool, input, { cwd: this.cwd, ...ctx });
    if (action.type === 'meta') return { decision: 'allow', action, reason: 'no side effects' };

    const subjects = action.type === 'exec' ? splitCommands(action.command) : [null];
    if (action.type === 'exec' && !subjects.length) subjects.push(action.command);
    let ask = null;
    let allowedAll = true;
    for (const cmd of subjects) {
      const r = evaluateOne(this.rules, action, this.cwd, cmd ?? '');
      if (r?.decision === 'deny') return { decision: 'deny', action, rule: r.rule, reason: `denied by ${r.rule.rule} (${r.rule.level}: ${r.rule.source})` };
      if (r?.decision === 'ask') ask = ask || r;
      if (r?.decision !== 'allow') allowedAll = false;
    }
    if (ask) return { decision: 'ask', action, rule: ask.rule, reason: `ask rule ${ask.rule.rule}` };
    if (allowedAll) return { decision: 'allow', action, reason: 'allowed by rule' };
    return this.modeDefault(action, subjects);
  }

  async modeDefault(action, subjects) {
    const m = this.mode;
    if (action.type === 'read') {
      return this.inWorkspace(action.path) || m === 'bypass'
        ? { decision: 'allow', action, reason: 'read-only' }
        : { decision: 'ask', action, reason: 'read outside the workspace' };
    }
    if (m === 'bypass') return { decision: 'allow', action, reason: 'bypass mode' };
    if (action.type === 'write') {
      if ((m === 'accept-edits' || m === 'smart') && this.inWorkspace(action.path)) return { decision: 'allow', action, reason: `${m} mode` };
      return { decision: 'ask', action, reason: this.inWorkspace(action.path) ? 'file edit' : 'edit outside the workspace' };
    }
    if (m === 'autonomous' && (action.type === 'exec' || action.type === 'fetch')) return { decision: 'allow', action, reason: 'sandboxed' };
    if (m === 'smart') {
      if (action.type === 'exec') {
        if (subjects.some(isNeverAuto)) return { decision: 'ask', action, reason: 'always asks in smart mode' };
        if (subjects.every(isReadOnlyCommand)) return { decision: 'allow', action, reason: 'read-only command' };
      }
      if (action.type === 'mcp' && action.readOnly) return { decision: 'allow', action, reason: 'read-only MCP tool' };
      if (this.judge) {
        try { if (await this.judge(action)) return { decision: 'allow', action, reason: 'judged safe' }; } catch { /* fall through to asking */ }
      }
      return { decision: 'ask', action, reason: 'not judged clearly safe' };
    }
    return { decision: 'ask', action, reason: action.type === 'exec' ? 'shell command' : action.type === 'fetch' ? 'web fetch' : 'MCP tool' };
  }

  /** The rule an "always allow" answer should save for this action. */
  suggestRule(action) {
    if (action.type === 'exec') {
      const cmds = splitCommands(action.command);
      return [...new Set(cmds.map(suggestExecPrefix))].map((p) => `Exec(${p})`);
    }
    if (action.type === 'fetch') { try { return [`Fetch(domain:${new URL(action.url).hostname})`]; } catch { return []; } }
    if (action.type === 'mcp') return [action.tool];
    if (action.type === 'write' && action.path) return [`Write(${path.relative(this.cwd, action.path).startsWith('..') ? action.path : path.relative(this.cwd, action.path)})`];
    if (action.type === 'read' && action.path) return [`Read(${path.dirname(action.path)}/**)`];
    return [];
  }
}

const TWO_WORD = new Set(['git', 'npm', 'pnpm', 'yarn', 'bun', 'cargo', 'go', 'docker', 'kubectl', 'gh', 'make', 'deno', 'dotnet', 'mvn', 'gradle', 'pip', 'pip3', 'poetry', 'uv', 'bundle', 'rails', 'mix', 'swift']);
const RUNNERS = [['uv', 'run'], ['poetry', 'run'], ['pdm', 'run'], ['pipenv', 'run'], ['rye', 'run'], ['hatch', 'run'], ['pnpm', 'exec'], ['pnpm', 'dlx'], ['npm', 'exec'], ['yarn', 'dlx'], ['bun', 'run'], ['npx']];

/** "uv run ruff check src" -> "uv run ruff"; "git status -s" -> "git status"; "cat a/b" -> "cat". */
export function suggestExecPrefix(cmd) {
  const w = words(cmd).filter((x) => !/^\w+=/.test(x));
  for (const r of RUNNERS) {
    if (r.every((x, i) => w[i] === x) && w[r.length] && !w[r.length].startsWith('-')) return [...r, w[r.length]].join(' ');
  }
  const looksLikeArg = (x) => !x || x.startsWith('-') || /[/.~$"'=:]/.test(x);
  if (TWO_WORD.has(w[0]) && !looksLikeArg(w[1])) return `${w[0]} ${w[1]}`;
  return w[0] || cmd;
}
