/**
 * Standing permission rules, set once in a file instead of clicked per chat.
 *
 *   ~/.codeply/permissions.json            (every project)
 *   <project>/.codeply/permissions.json    (this project, checked first)
 *
 *   {
 *     "deny":  ["run:git push*", "run:rm*", "write_file:*.env", "supabase_delete_project"],
 *     "allow": ["run:npm test", "run:npm run *", "run:git status", "edit_file:src/**"]
 *   }
 *
 * A rule is "<tool>" or "<tool>:<pattern>". For run the pattern matches the
 * command's name (npm run dev, git checkout) and the full command line; for
 * file tools it matches the path relative to the project. * matches within a
 * path segment, ** across them, and a trailing " *" also matches the bare
 * command. Deny beats allow; project rules beat global ones; anything no rule
 * mentions is asked as usual. Evaluation is the same idea as opencode's
 * permission/ rulesets.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

function readRules(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = (k) => (Array.isArray(j[k]) ? j[k].map(String).filter(Boolean) : []);
    return { allow: list('allow'), deny: list('deny') };
  } catch { return { allow: [], deny: [] }; }
}

function wildcard(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') { re += '.*'; i++; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '.';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  // "npm run *" should also cover plain "npm run".
  re = re.replace(/ \[\^\/\]\*$/, '(?: .*)?').replace(/ \.\*$/, '(?: .*)?');
  return new RegExp(`^${re}$`, process.platform === 'win32' ? 'i' : '');
}

/** Strings a request can be matched against for its tool. */
function subjects(req, cwd) {
  if (req.tool === 'run') {
    const cmd = String(req.detail || '').trim();
    // Commands match by name AND as full text, so "run:npm run *" and
    // "run:git push*" both work.
    return { cmd, names: Array.isArray(req.patterns) ? req.patterns : [] };
  }
  if (req.path) {
    const abs = path.isAbsolute(req.path) ? req.path : path.resolve(cwd || '.', req.path);
    const rel = path.relative(cwd || '.', abs).replace(/\\/g, '/');
    return { path: rel.startsWith('..') ? abs.replace(/\\/g, '/') : rel };
  }
  return {};
}

function ruleMatches(rule, req, subj) {
  const i = rule.indexOf(':');
  const tool = (i === -1 ? rule : rule.slice(0, i)).trim();
  const pattern = i === -1 ? null : rule.slice(i + 1).trim();
  if (tool !== req.tool && tool !== '*') return false;
  if (!pattern || pattern === '*') return true;
  const re = wildcard(pattern);
  if (req.tool === 'run') {
    if (re.test(subj.cmd)) return true;
    // For allow on a compound command every part must be covered (checked by
    // the caller); here a single name matching is enough to count.
    return subj.names.some((n) => re.test(n));
  }
  return subj.path ? re.test(subj.path) : false;
}

/**
 * @param {object} req  the approval request ({tool, detail, patterns, path, danger})
 * @returns {{decision: 'allow'|'deny'|null, rule?: string, file?: string}}
 */
function decide(req, cwd) {
  const files = [cwd && path.join(cwd, '.codeply', 'permissions.json'), path.join(os.homedir(), '.codeply', 'permissions.json')].filter(Boolean);
  const sets = files.map((f) => ({ file: f, ...readRules(f) }));
  const subj = subjects(req, cwd);
  for (const s of sets) {
    const hit = s.deny.find((r) => ruleMatches(r, req, subj));
    if (hit) return { decision: 'deny', rule: hit, file: s.file };
  }
  // Risky-looking commands (rm -rf, format, curl | sh...) always ask.
  if (req.danger) return { decision: null };
  for (const s of sets) {
    if (req.tool === 'run') {
      // Allow is judged per command, never on the whole line: "npm run *"
      // must not let "npm run build && npm install" through. A line that
      // can't be split into named commands (subshells, redirects) is never
      // auto-allowed.
      if (!subj.names.length) continue;
      const parts = subj.names.length === 1 ? [{ cmd: subj.cmd, names: subj.names }] : subj.names.map((n) => ({ cmd: n, names: [n] }));
      if (parts.every((p) => s.allow.some((r) => ruleMatches(r, req, p)))) return { decision: 'allow', rule: 'allow rules', file: s.file };
      continue;
    }
    const hit = s.allow.find((r) => ruleMatches(r, req, subj));
    if (hit) return { decision: 'allow', rule: hit, file: s.file };
  }
  return { decision: null };
}

module.exports = { decide, wildcard };
