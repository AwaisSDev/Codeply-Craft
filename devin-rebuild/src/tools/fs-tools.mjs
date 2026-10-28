/**
 * File tools: read, write, edit, ls.
 *
 * Each tool declares `kind` (read | edit | exec | network | mcp | meta),
 * which the permission engine maps to a mode decision, and `target(input)`,
 * the thing a permission rule like Read(src/**) or Write(*.md) matches.
 */
import fs from 'node:fs';
import path from 'node:path';

const MAX_LINES = 2000;
const MAX_LINE_CHARS = 2000;
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

export function resolvePath(ctx, p) {
  if (!p) throw new Error('file_path is required');
  const expanded = p.startsWith('~/') ? path.join(process.env.HOME || '', p.slice(2)) : p;
  return path.resolve(ctx.cwd, expanded);
}

function isBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export const readTool = {
  name: 'read',
  kind: 'read',
  description: 'Read a file from the local filesystem. Returns numbered lines (cat -n format). Use offset/limit for large files. Reads images (png, jpg, gif, webp) as images. Always read a file before editing it.',
  input_schema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute or workspace-relative path' },
      offset: { type: 'integer', description: '1-based line to start from' },
      limit: { type: 'integer', description: 'Number of lines to read (default 2000)' },
    },
    required: ['file_path'],
  },
  target: (input, ctx) => resolvePath(ctx, input.file_path),
  async run(input, ctx) {
    const file = resolvePath(ctx, input.file_path);
    let st;
    try { st = fs.statSync(file); } catch { return { isError: true, content: `File does not exist: ${file}` }; }
    if (st.isDirectory()) return { isError: true, content: `${file} is a directory. Use the ls or glob tool to list it.` };
    const ext = path.extname(file).toLowerCase();
    if (IMAGE_TYPES[ext]) {
      const data = fs.readFileSync(file).toString('base64');
      ctx.readFiles?.set(file, st.mtimeMs);
      return { content: [{ type: 'image', source: { type: 'base64', media_type: IMAGE_TYPES[ext], data } }] };
    }
    const buf = fs.readFileSync(file);
    if (isBinary(buf)) return { isError: true, content: `${file} is a binary file (${st.size} bytes) and cannot be shown as text.` };
    ctx.readFiles?.set(file, st.mtimeMs);
    const lines = buf.toString('utf8').split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    if (!lines.length) return { content: '<system-reminder>The file exists but is empty.</system-reminder>' };
    const start = Math.max(1, input.offset || 1);
    const limit = Math.max(1, input.limit || MAX_LINES);
    const slice = lines.slice(start - 1, start - 1 + limit);
    const width = String(start + slice.length - 1).length;
    let out = slice.map((l, i) => {
      const line = l.length > MAX_LINE_CHARS ? l.slice(0, MAX_LINE_CHARS) + '… [line truncated]' : l;
      return `${String(start + i).padStart(Math.max(width, 6))}\t${line}`;
    }).join('\n');
    const end = start - 1 + slice.length;
    if (end < lines.length) out += `\n\n[Showing lines ${start}-${end} of ${lines.length}. Use offset=${end + 1} to read more.]`;
    return { content: out };
  },
};

function mustHaveRead(ctx, file) {
  if (!fs.existsSync(file) || !ctx.readFiles) return null;
  const seen = ctx.readFiles.get(file);
  if (seen === undefined) return `You must read ${file} with the read tool before changing it.`;
  const now = fs.statSync(file).mtimeMs;
  if (now > seen + 1) return `${file} changed on disk since you last read it. Read it again before editing.`;
  return null;
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.dvn-${process.pid}.tmp`;
  let mode;
  try { mode = fs.statSync(file).mode; } catch { /* new file */ }
  fs.writeFileSync(tmp, text);
  if (mode !== undefined) fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

export function diffSummary(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length - 1;
  let eb = b.length - 1;
  while (ea >= s && eb >= s && a[ea] === b[eb]) { ea--; eb--; }
  const removed = a.slice(s, ea + 1);
  const added = b.slice(s, eb + 1);
  return { line: s + 1, removed, added };
}

export const writeTool = {
  name: 'write',
  kind: 'edit',
  description: 'Create a new file or completely overwrite an existing one. Prefer edit for changes to existing files. Existing files must be read first.',
  input_schema: {
    type: 'object',
    properties: {
      file_path: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['file_path', 'content'],
  },
  target: (input, ctx) => resolvePath(ctx, input.file_path),
  async run(input, ctx) {
    const file = resolvePath(ctx, input.file_path);
    const problem = mustHaveRead(ctx, file);
    if (problem) return { isError: true, content: problem };
    const existed = fs.existsSync(file);
    const before = existed ? fs.readFileSync(file, 'utf8') : '';
    ctx.checkpoint?.(file, existed ? before : null);
    writeAtomic(file, input.content);
    ctx.readFiles?.set(file, fs.statSync(file).mtimeMs);
    const lines = input.content.split('\n').length;
    return { content: existed ? `Overwrote ${file} (${lines} lines).` : `Created ${file} (${lines} lines).`, diff: diffSummary(before, input.content) };
  },
};

export const editTool = {
  name: 'edit',
  kind: 'edit',
  description: 'Replace exact text in a file. old_string must match the file exactly (including indentation) and be unique unless replace_all is true. Read the file first.',
  input_schema: {
    type: 'object',
    properties: {
      file_path: { type: 'string' },
      old_string: { type: 'string', description: 'Exact text to replace' },
      new_string: { type: 'string', description: 'Replacement text' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence' },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },
  target: (input, ctx) => resolvePath(ctx, input.file_path),
  async run(input, ctx) {
    const file = resolvePath(ctx, input.file_path);
    if (!fs.existsSync(file)) {
      if (input.old_string === '') return writeTool.run({ file_path: file, content: input.new_string }, ctx);
      return { isError: true, content: `File does not exist: ${file}` };
    }
    const problem = mustHaveRead(ctx, file);
    if (problem) return { isError: true, content: problem };
    const before = fs.readFileSync(file, 'utf8');
    const { old_string: oldS, new_string: newS } = input;
    if (oldS === newS) return { isError: true, content: 'old_string and new_string are identical; nothing to change.' };
    if (!oldS) return { isError: true, content: 'old_string is empty. Use write to replace a whole file.' };
    const count = before.split(oldS).length - 1;
    if (count === 0) {
      const hint = before.includes(oldS.trim()) ? ' (it matches after trimming whitespace: check indentation)' : '';
      return { isError: true, content: `old_string was not found in ${file}${hint}. Read the file again and copy the text exactly.` };
    }
    if (count > 1 && !input.replace_all) return { isError: true, content: `old_string occurs ${count} times in ${file}. Add surrounding lines to make it unique, or set replace_all.` };
    const after = input.replace_all ? before.split(oldS).join(newS) : before.replace(oldS, () => newS);
    ctx.checkpoint?.(file, before);
    writeAtomic(file, after);
    ctx.readFiles?.set(file, fs.statSync(file).mtimeMs);
    return { content: `Edited ${file}${input.replace_all && count > 1 ? ` (${count} replacements)` : ''}.`, diff: diffSummary(before, after) };
  },
};

export const lsTool = {
  name: 'ls',
  kind: 'read',
  description: 'List a directory. Directories end with /. Skips .git and node_modules contents.',
  input_schema: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Directory (default: working directory)' } },
  },
  target: (input, ctx) => resolvePath(ctx, input.path || '.'),
  async run(input, ctx) {
    const dir = resolvePath(ctx, input.path || '.');
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return { isError: true, content: `Cannot list ${dir}: ${e.code || e.message}` }; }
    entries.sort((x, y) => (x.isDirectory() === y.isDirectory() ? x.name.localeCompare(y.name) : x.isDirectory() ? -1 : 1));
    const lines = entries.slice(0, 1000).map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    if (entries.length > 1000) lines.push(`… ${entries.length - 1000} more`);
    return { content: lines.length ? `${dir}\n${lines.join('\n')}` : `${dir} is empty.` };
  },
};
