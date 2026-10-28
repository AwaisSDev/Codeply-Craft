/**
 * grep and glob. grep shells out to ripgrep when it is installed and falls
 * back to a JavaScript scan otherwise, with the same output either way.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { matchGlob, walk } from '../util/glob.mjs';
import { resolvePath } from './fs-tools.mjs';

const MAX_RESULTS = 500;

let rgPath;
function ripgrep() {
  if (rgPath !== undefined) return rgPath;
  const r = spawnSync('rg', ['--version'], { encoding: 'utf8' });
  rgPath = r.status === 0 ? 'rg' : null;
  return rgPath;
}

function jsGrep(root, input) {
  const flags = input.case_insensitive ? 'i' : '';
  let re;
  try { re = new RegExp(input.pattern, flags); } catch (e) { return { error: `Invalid regex: ${e.message}` }; }
  const files = [];
  const lines = [];
  const counts = [];
  const isFile = fs.statSync(root).isFile();
  const list = isFile ? [path.basename(root)] : walk(root);
  const base = isFile ? path.dirname(root) : root;
  for (const rel of list) {
    if (input.glob && !matchGlob(input.glob, rel)) continue;
    let text;
    try {
      const buf = fs.readFileSync(path.join(base, rel));
      if (buf.subarray(0, 8000).includes(0)) continue;
      text = buf.toString('utf8');
    } catch { continue; }
    const fileLines = text.split('\n');
    let c = 0;
    fileLines.forEach((l, i) => {
      if (!re.test(l)) return;
      c++;
      if (input.output_mode === 'content') lines.push(`${rel}:${i + 1}:${l}`);
    });
    if (c) { files.push(rel); counts.push(`${rel}:${c}`); }
    if (files.length >= MAX_RESULTS * 4) break;
  }
  return { files, lines, counts };
}

function rgGrep(root, input) {
  const args = ['--no-heading', '--color', 'never', '--hidden', '--glob', '!.git'];
  if (input.case_insensitive) args.push('-i');
  if (input.glob) args.push('--glob', input.glob);
  const mode = input.output_mode || 'files_with_matches';
  if (mode === 'files_with_matches') args.push('-l');
  else if (mode === 'count') args.push('-c');
  else { args.push('-n'); if (input.context) args.push('-C', String(input.context)); }
  args.push('-e', input.pattern, '--', fs.statSync(root).isFile() ? path.basename(root) : '.');
  const r = spawnSync(ripgrep(), args, { cwd: fs.statSync(root).isFile() ? path.dirname(root) : root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status === 2) return { error: r.stderr.trim() };
  const out = (r.stdout || '').split('\n').filter(Boolean).map((l) => l.replace(/^\.\//, ''));
  if (mode === 'files_with_matches') return { files: out, lines: [], counts: [] };
  if (mode === 'count') return { files: [], lines: [], counts: out };
  return { files: [], lines: out, counts: [] };
}

export const grepTool = {
  name: 'grep',
  kind: 'read',
  description: 'Search file contents with a regular expression (ripgrep syntax). output_mode: files_with_matches (default), content (matching lines with line numbers), count. Filter files with glob, e.g. "*.ts" or "src/**/*.py".',
  input_schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      path: { type: 'string', description: 'File or directory (default: working directory)' },
      glob: { type: 'string' },
      output_mode: { type: 'string', enum: ['files_with_matches', 'content', 'count'] },
      case_insensitive: { type: 'boolean' },
      context: { type: 'integer', description: 'Lines of context for content mode' },
    },
    required: ['pattern'],
  },
  target: (input, ctx) => resolvePath(ctx, input.path || '.'),
  async run(input, ctx) {
    const root = resolvePath(ctx, input.path || '.');
    if (!fs.existsSync(root)) return { isError: true, content: `Path does not exist: ${root}` };
    const r = ripgrep() ? rgGrep(root, input) : jsGrep(root, input);
    if (r.error) return { isError: true, content: r.error };
    const mode = input.output_mode || 'files_with_matches';
    const items = mode === 'content' ? r.lines : mode === 'count' ? r.counts : r.files;
    if (!items.length) return { content: 'No matches found.' };
    const shown = items.slice(0, MAX_RESULTS);
    return { content: shown.join('\n') + (items.length > MAX_RESULTS ? `\n… ${items.length - MAX_RESULTS} more (narrow the search)` : '') };
  },
};

export const globTool = {
  name: 'glob',
  kind: 'read',
  description: 'Find files by glob pattern, e.g. "**/*.test.ts" or "src/**/index.*". Returns paths sorted by most recently modified. Skips .git, node_modules and build output.',
  input_schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      path: { type: 'string', description: 'Directory to search (default: working directory)' },
    },
    required: ['pattern'],
  },
  target: (input, ctx) => resolvePath(ctx, input.path || '.'),
  async run(input, ctx) {
    const root = resolvePath(ctx, input.path || '.');
    const hits = [];
    for (const rel of walk(root)) {
      if (!matchGlob(input.pattern, rel)) continue;
      let mtime = 0;
      try { mtime = fs.statSync(path.join(root, rel)).mtimeMs; } catch { /* raced */ }
      hits.push({ rel, mtime });
    }
    if (!hits.length) return { content: 'No files found.' };
    hits.sort((a, b) => b.mtime - a.mtime);
    const shown = hits.slice(0, MAX_RESULTS).map((h) => h.rel);
    return { content: shown.join('\n') + (hits.length > MAX_RESULTS ? `\n… ${hits.length - MAX_RESULTS} more` : '') };
  },
};
