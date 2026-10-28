/**
 * apply_patch: multi-file edits in the Codex patch format.
 *
 *   *** Begin Patch
 *   *** Add File: path/new.txt
 *   +line
 *   *** Update File: path/old.txt
 *   *** Move to: path/renamed.txt      (optional)
 *   @@ optional context header
 *    unchanged line
 *   -removed line
 *   +added line
 *   *** Delete File: path/gone.txt
 *   *** End Patch
 *
 * Hunks match exactly first, then ignoring trailing and then all edge
 * whitespace. CRLF files stay CRLF. Nothing is written unless every hunk
 * of every file applies.
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolvePath, diffSummary } from './fs-tools.mjs';

export function parsePatch(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let i = lines.findIndex((l) => l.trim() === '*** Begin Patch');
  if (i < 0) throw new Error('Patch must start with "*** Begin Patch"');
  i++;
  const ops = [];
  let cur = null;
  let hunk = null;
  const flushHunk = () => { if (cur && hunk && (hunk.old.length || hunk.new.length)) cur.hunks.push(hunk); hunk = null; };
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '*** End Patch') { flushHunk(); return ops; }
    let m;
    if ((m = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(l))) {
      flushHunk();
      cur = { type: m[1].toLowerCase(), path: m[2].trim(), lines: [], hunks: [], moveTo: null };
      ops.push(cur);
      continue;
    }
    if (!cur) continue;
    if ((m = /^\*\*\* Move to: (.+)$/.exec(l))) { cur.moveTo = m[1].trim(); continue; }
    if (cur.type === 'add') { if (l.startsWith('+')) cur.lines.push(l.slice(1)); continue; }
    if (cur.type === 'update') {
      if (l.startsWith('@@')) { flushHunk(); hunk = { header: l.slice(2).trim(), old: [], new: [] }; continue; }
      if (l === '*** End of File') continue;
      hunk ||= { header: '', old: [], new: [] };
      if (l.startsWith('-')) hunk.old.push(l.slice(1));
      else if (l.startsWith('+')) hunk.new.push(l.slice(1));
      else { const c = l.startsWith(' ') ? l.slice(1) : l; hunk.old.push(c); hunk.new.push(c); }
    }
  }
  throw new Error('Patch must end with "*** End Patch"');
}

function findSeq(hay, needle, from) {
  const tries = [(s) => s, (s) => s.trimEnd(), (s) => s.trim()];
  for (const norm of tries) {
    for (let i = from; i + needle.length <= hay.length; i++) {
      let ok = true;
      for (let j = 0; j < needle.length; j++) if (norm(hay[i + j]) !== norm(needle[j])) { ok = false; break; }
      if (ok) return i;
    }
  }
  return -1;
}

function applyHunks(text, hunks, file) {
  const crlf = text.includes('\r\n');
  const endsNl = text.endsWith('\n');
  let lines = text.replace(/\r\n/g, '\n').split('\n');
  if (endsNl) lines.pop();
  let cursor = 0;
  for (const h of hunks) {
    if (h.header) {
      const at = lines.findIndex((l, k) => k >= cursor && l.includes(h.header));
      if (at >= 0) cursor = at;
    }
    let pos = h.old.length ? findSeq(lines, h.old, cursor) : lines.length;
    if (pos < 0 && cursor > 0) pos = findSeq(lines, h.old, 0);
    if (pos < 0) throw new Error(`Could not find the lines to change in ${file}:\n${h.old.slice(0, 6).join('\n')}`);
    lines = [...lines.slice(0, pos), ...h.new, ...lines.slice(pos + h.old.length)];
    cursor = pos + h.new.length;
  }
  let out = lines.join('\n') + (endsNl || !text ? '\n' : '');
  if (crlf) out = out.replace(/\n/g, '\r\n');
  return out;
}

export const applyPatchTool = {
  name: 'apply_patch',
  kind: 'edit',
  description: 'Apply a patch that adds, updates, moves or deletes files, in the "*** Begin Patch" format (see the format in this tool\'s input description). All changes apply or none do.',
  input_schema: {
    type: 'object',
    properties: {
      patch: { type: 'string', description: '*** Begin Patch\n*** Update File: a.py\n@@ def f():\n-    return 1\n+    return 2\n*** End Patch   (also *** Add File: / *** Delete File: / *** Move to:)' },
    },
    required: ['patch'],
  },
  target: (input, ctx) => {
    try { const first = parsePatch(input.patch)[0]; return first ? resolvePath(ctx, first.path) : ctx.cwd; } catch { return ctx.cwd; }
  },
  async run(input, ctx) {
    let ops;
    try { ops = parsePatch(input.patch); } catch (e) { return { isError: true, content: e.message }; }
    if (!ops.length) return { isError: true, content: 'The patch contains no file operations.' };
    const writes = [];
    try {
      for (const op of ops) {
        const file = resolvePath(ctx, op.path);
        if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error(`${file} is a symlink; refusing to write through it.`);
        if (op.type === 'add') {
          if (fs.existsSync(file)) throw new Error(`${file} already exists; use Update File.`);
          writes.push({ file, before: null, after: op.lines.join('\n') + '\n' });
        } else if (op.type === 'delete') {
          if (!fs.existsSync(file)) throw new Error(`${file} does not exist.`);
          writes.push({ file, before: fs.readFileSync(file, 'utf8'), after: null });
        } else {
          if (!fs.existsSync(file)) throw new Error(`${file} does not exist.`);
          const before = fs.readFileSync(file, 'utf8');
          const after = applyHunks(before, op.hunks, file);
          const dest = op.moveTo ? resolvePath(ctx, op.moveTo) : file;
          if (dest !== file) { writes.push({ file, before, after: null }); writes.push({ file: dest, before: fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : null, after }); }
          else writes.push({ file, before, after });
        }
      }
    } catch (e) { return { isError: true, content: `Patch not applied: ${e.message}` }; }
    const summary = [];
    for (const w of writes) {
      ctx.checkpoint?.(w.file, w.before);
      if (w.after === null) { fs.rmSync(w.file); summary.push(`D ${w.file}`); continue; }
      fs.mkdirSync(path.dirname(w.file), { recursive: true });
      fs.writeFileSync(w.file, w.after);
      ctx.readFiles?.set(w.file, fs.statSync(w.file).mtimeMs);
      const d = diffSummary(w.before ?? '', w.after);
      summary.push(`${w.before === null ? 'A' : 'M'} ${w.file} (+${d.added.length} -${d.removed.length})`);
    }
    return { content: `Applied patch:\n${summary.join('\n')}` };
  },
};
