/**
 * Custom slash commands: a markdown file per command, same layout opencode
 * and Claude Code use, so existing ones can be copied over.
 *
 *   ~/.codeply/commands/<name>.md          (every project)
 *   <project>/.codeply/commands/<name>.md  (this project; same name wins)
 *
 *   ---
 *   description: Review the changed files for bugs
 *   mode: Plan            # optional: Build | Plan | Ask
 *   ---
 *   Review $ARGUMENTS for correctness bugs. Cite file:line.
 *
 * In the body, $ARGUMENTS is everything typed after the command, $1 $2 ...
 * are single words (the highest one takes the rest), and if the body has no
 * placeholder at all the arguments are appended on their own line.
 * Sub-folders become part of the name: commands/git/pr.md is /git/pr.
 * Installed plugins add theirs as /<plugin>:<name> (see plugins.js).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const plugins = require('./plugins.js');

const MAX_BODY = 20000;
const RESERVED = new Set(['goal', 'g', 'skills', 'skill', 'skill-list']);

function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+)\s*:\s*(.*)$/.exec(line);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return { meta, body: text.slice(m[0].length) };
}

function scan(dir, prefix, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) scan(full, `${prefix}${e.name}/`, out);
    else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
      const name = `${prefix}${e.name.slice(0, -3)}`.toLowerCase().replace(/\s+/g, '-');
      if (RESERVED.has(name)) continue;
      try {
        const { meta, body } = parseFrontmatter(fs.readFileSync(full, 'utf8').slice(0, MAX_BODY));
        const mode = ['Build', 'Plan', 'Ask'].find((x) => x.toLowerCase() === String(meta.mode || '').toLowerCase());
        out.set(name, {
          name,
          description: meta.description || body.trim().split('\n')[0].slice(0, 100),
          mode: mode || null,
          body: body.trim(),
          file: full,
        });
      } catch {}
    }
  }
}

/** @returns {Map<string, {name, description, mode, body, file}>} */
function loadCommands(cwd) {
  const out = new Map();
  for (const { plugin, dir } of plugins.commandDirs(cwd)) scan(dir, `${plugin}:`, out);
  scan(path.join(os.homedir(), '.codeply', 'commands'), '', out);
  if (cwd) scan(path.join(cwd, '.codeply', 'commands'), '', out);
  return out;
}

/** Fill a command's template with what was typed after it. */
function expand(cmd, argText) {
  const args = String(argText || '').trim();
  const words = args ? args.split(/\s+/) : [];
  let body = cmd.body;
  const nums = [...body.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
  const max = nums.length ? Math.max(...nums) : 0;
  const used = /\$ARGUMENTS|\$\d+/.test(body);
  body = body.replace(/\$(\d+)/g, (_, n) => {
    const i = Number(n) - 1;
    return Number(n) === max ? words.slice(i).join(' ') : (words[i] || '');
  });
  body = body.replace(/\$ARGUMENTS/g, args);
  if (!used && args) body = `${body}\n\n${args}`;
  return body.trim();
}

/**
 * If `text` starts with a known custom command, the expanded prompt and the
 * command; otherwise null. `/goal` and the app's built-ins are never matched.
 */
function resolve(text, cwd) {
  const m = /^\/([A-Za-z0-9_./:-]+)(?:\s+([\s\S]*))?$/.exec(String(text || '').trim());
  if (!m) return null;
  const name = m[1].toLowerCase();
  if (RESERVED.has(name)) return null;
  const cmd = loadCommands(cwd).get(name);
  if (!cmd) return null;
  return { command: cmd, prompt: expand(cmd, m[2] || '') };
}

module.exports = { loadCommands, expand, resolve, parseFrontmatter };
