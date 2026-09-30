/**
 * How many words name a shell command, so "always allow" can be scoped to
 * `npm run dev` or `git checkout` instead of every command there is.
 *
 * The ARITY table and the prefix() rule are from opencode
 * (packages/opencode/src/permission/arity.ts), MIT License,
 * Copyright (c) 2025 opencode - https://github.com/sst/opencode
 * Command splitting and tokenizing below are Codeply's own.
 */

const ARITY = require('./arity-table.json');

// "Always allow node" would allow every script there is. For interpreters the
// script (or module) is part of the name: `node server.js`, `python app.py`.
const INTERPRETERS = new Set(['node', 'python', 'python3', 'py', 'deno', 'bun', 'ruby', 'php', 'perl', 'bash', 'sh', 'zsh', 'powershell', 'pwsh', 'cmd', 'tsx', 'ts-node']);

/** Longest listed prefix wins; unlisted commands are named by their first word. */
function prefix(tokens) {
  if (tokens.length && INTERPRETERS.has(tokens[0]) && !ARITY[tokens.slice(0, 2).join(' ')]) return tokens.slice(0, 2);
  for (let len = tokens.length; len > 0; len--) {
    const arity = ARITY[tokens.slice(0, len).join(' ')];
    if (arity !== undefined) return tokens.slice(0, arity);
  }
  return tokens.slice(0, 1);
}

/** Split a command line into its separate commands (&&, ||, ;, |, newlines). Quotes are respected. */
function splitCommands(line) {
  const out = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    const n = line[i + 1];
    if (quote) { cur += c; if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if ((c === '&' && n === '&') || (c === '|' && n === '|')) { out.push(cur); cur = ''; i++; continue; }
    if (c === ';' || c === '|' || c === '\n' || c === '&') { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Words of one command, without leading VAR=value assignments or flags. */
function tokenize(cmd) {
  const words = cmd.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  const clean = words.map((w) => w.replace(/^["']|["']$/g, ''));
  let i = 0;
  while (i < clean.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(clean[i])) i++;
  const rest = clean.slice(i).filter((w) => !w.startsWith('-'));
  // A path to a program is still that program: C:\tools\git.exe -> git
  if (rest.length) rest[0] = rest[0].split(/[\\/]/).pop().replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
  return rest;
}

/**
 * The permission patterns a command line needs, one per command in it:
 *   'npm run dev && git status'  ->  ['npm run dev', 'git status']
 * Subshells, backticks and redirections into files return null: too dynamic
 * (or too destructive) to approve by name alone.
 */
function commandPatterns(line) {
  const text = String(line || '');
  if (/\$\(|`|>/.test(text)) return null;
  const pats = splitCommands(text).map((c) => prefix(tokenize(c)).join(' ')).filter(Boolean);
  return pats.length ? [...new Set(pats)] : null;
}

module.exports = { commandPatterns, prefix, tokenize, splitCommands };
