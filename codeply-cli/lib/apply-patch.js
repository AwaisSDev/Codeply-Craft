/**
 * The "apply_patch" format: several file changes (add, update, delete, move) in
 * one block, as opencode's and Codex's apply_patch tools accept.
 *
 *   *** Begin Patch
 *   *** Add File: src/new.js
 *   +line one
 *   *** Update File: src/app.js
 *   *** Move to: src/main.js          (optional)
 *   @@ function start()               (optional anchor line)
 *    unchanged context
 *   -old line
 *   +new line
 *   *** Delete File: old.txt
 *   *** End Patch
 *
 * parsePatch() and planPatch() are pure (no disk writes) so a caller can show
 * the user the whole change, ask, and only then write it.
 */

function normalize(s) {
  return s.replace(/[‐-―−]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/ /g, ' ');
}

/** @returns {{hunks: object[]}|{error: string}} */
function parsePatch(text) {
  let lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  // Models sometimes wrap the patch in a heredoc or a code fence.
  while (lines.length && !lines[0].trim()) lines.shift();
  if (lines.length && /^(?:apply_patch\s*)?<<-?\s*['"]?\w+['"]?\s*$/.test(lines[0].trim())) lines.shift();
  if (lines.length && /^```/.test(lines[0].trim())) lines.shift();
  const begin = lines.findIndex((l) => l.trim() === '*** Begin Patch');
  if (begin === -1) return { error: 'The patch must start with "*** Begin Patch" on its own line.' };
  lines = lines.slice(begin + 1);
  let end = lines.findIndex((l) => l.trim() === '*** End Patch');
  if (end === -1) end = lines.length; // a missing footer is forgivable, the hunks are still complete lines
  lines = lines.slice(0, end);

  const hunks = [];
  let i = 0;
  const isHeader = (l) => /^\*\*\* (Add File|Update File|Delete File|Move to|End of File):?/.test(l);
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    let m;
    if ((m = /^\*\*\* Add File:\s*(.+)$/.exec(line))) {
      const body = [];
      i++;
      while (i < lines.length && !isHeader(lines[i]) ) {
        if (lines[i].startsWith('+')) body.push(lines[i].slice(1));
        else if (lines[i] === '') body.push('');
        else return { error: `In "Add File: ${m[1].trim()}", every line must start with "+" (got: ${JSON.stringify(lines[i].slice(0, 60))}).` };
        i++;
      }
      while (body.length > 1 && body[body.length - 1] === '') body.pop();
      hunks.push({ type: 'add', path: m[1].trim(), contents: body.join('\n') + (body.length ? '\n' : '') });
    } else if ((m = /^\*\*\* Delete File:\s*(.+)$/.exec(line))) {
      hunks.push({ type: 'delete', path: m[1].trim() });
      i++;
    } else if ((m = /^\*\*\* Update File:\s*(.+)$/.exec(line))) {
      const hunk = { type: 'update', path: m[1].trim(), movePath: null, chunks: [] };
      i++;
      if (i < lines.length && (m = /^\*\*\* Move to:\s*(.+)$/.exec(lines[i]))) { hunk.movePath = m[1].trim(); i++; }
      let cur = null;
      const flush = () => { if (cur && (cur.old.length || cur.new.length)) hunk.chunks.push(cur); cur = null; };
      while (i < lines.length && !/^\*\*\* (Add File|Update File|Delete File)/.test(lines[i])) {
        const l = lines[i];
        if (l.startsWith('@@')) {
          flush();
          cur = { ctx: l.slice(2).trim(), old: [], new: [], eof: false };
        } else if (l.trim() === '*** End of File') {
          if (cur) cur.eof = true;
        } else {
          if (!cur) cur = { ctx: '', old: [], new: [], eof: false };
          if (l.startsWith('+')) cur.new.push(l.slice(1));
          else if (l.startsWith('-')) cur.old.push(l.slice(1));
          else if (l.startsWith(' ')) { cur.old.push(l.slice(1)); cur.new.push(l.slice(1)); }
          else if (l === '') { cur.old.push(''); cur.new.push(''); }
          else return { error: `In "Update File: ${hunk.path}", a change line must start with " ", "-" or "+" (got: ${JSON.stringify(l.slice(0, 60))}).` };
        }
        i++;
      }
      flush();
      if (!hunk.chunks.length && !hunk.movePath) return { error: `"Update File: ${hunk.path}" has no changes.` };
      hunks.push(hunk);
    } else {
      return { error: `Unexpected line in the patch: ${JSON.stringify(line.slice(0, 80))}. Each section starts with "*** Add File:", "*** Update File:" or "*** Delete File:".` };
    }
  }
  if (!hunks.length) return { error: 'The patch has no changes.' };
  return { hunks };
}

/** Find `needle` (array of lines) in `hay` at or after `from`, loosening whitespace step by step. */
function seek(hay, needle, from, eof) {
  if (!needle.length) return from;
  const passes = [
    (s) => s,
    (s) => s.replace(/\s+$/, ''),
    (s) => s.trim(),
    (s) => normalize(s).trim(),
  ];
  for (const f of passes) {
    const start = eof ? Math.max(from, hay.length - needle.length) : from;
    for (let a = start; a + needle.length <= hay.length; a++) {
      let ok = true;
      for (let b = 0; b < needle.length; b++) if (f(hay[a + b]) !== f(needle[b])) { ok = false; break; }
      if (ok) return a;
    }
    if (eof) {
      // The end-of-file marker is a hint, not a promise: fall back to searching everywhere.
      for (let a = from; a + needle.length <= hay.length; a++) {
        let ok = true;
        for (let b = 0; b < needle.length; b++) if (f(hay[a + b]) !== f(needle[b])) { ok = false; break; }
        if (ok) return a;
      }
    }
  }
  return -1;
}

function applyChunks(original, chunks, label) {
  const crlf = /\r\n/.test(original);
  const text = original.replace(/\r\n/g, '\n');
  const hay = text.split('\n');
  const trailingNewline = hay.length > 1 && hay[hay.length - 1] === '';
  if (trailingNewline) hay.pop();

  const replacements = [];
  let cursor = 0;
  for (const c of chunks) {
    if (c.ctx) {
      const at = seek(hay, [c.ctx], cursor, false);
      if (at === -1) return { error: `${label}: could not find the anchor line "${c.ctx}". Copy it exactly from the file.` };
      cursor = at + 1;
    }
    if (!c.old.length) {
      // Pure insertion: at the end of the file, unless an anchor put us elsewhere.
      const at = c.ctx ? cursor : hay.length;
      replacements.push([at, 0, c.new]);
      continue;
    }
    let old = c.old;
    let neu = c.new;
    let at = seek(hay, old, cursor, c.eof);
    // A trailing blank line in the chunk often stands for the end of the file.
    if (at === -1 && old[old.length - 1] === '') {
      old = old.slice(0, -1);
      neu = neu[neu.length - 1] === '' ? neu.slice(0, -1) : neu;
      at = seek(hay, old, cursor, c.eof);
    }
    if (at === -1) {
      return { error: `${label}: could not find these lines to replace:\n${c.old.slice(0, 6).map((l) => `  ${l}`).join('\n')}\nRead the file again and copy the lines exactly.` };
    }
    replacements.push([at, old.length, neu]);
    cursor = at + old.length;
  }
  replacements.sort((a, b) => a[0] - b[0]);
  const out = hay.slice();
  for (let k = replacements.length - 1; k >= 0; k--) {
    const [at, len, neu] = replacements[k];
    out.splice(at, len, ...neu);
  }
  let result = out.join('\n') + (trailingNewline || !original ? '\n' : '');
  if (crlf) result = result.replace(/\n/g, '\r\n');
  return { content: result };
}

/**
 * Work out what a patch would do, without touching the disk.
 * @param {string} patchText
 * @param {(path:string)=>string|null} readFile  current content of a project path, null if it doesn't exist
 * @returns {{changes: Array<{kind:'add'|'update'|'delete'|'move', path:string, newPath?:string, before:string, after:string, added:number, removed:number}>}|{error:string}}
 */
function planPatch(patchText, readFile) {
  const parsed = parsePatch(patchText);
  if (parsed.error) return { error: parsed.error };
  const changes = [];
  const virtual = new Map(); // paths changed earlier in this same patch
  const current = (p) => (virtual.has(p) ? virtual.get(p) : readFile(p));
  for (const h of parsed.hunks) {
    if (h.type === 'add') {
      const existing = current(h.path);
      if (existing != null && existing !== '') return { error: `Cannot add ${h.path}: it already exists. Use "*** Update File:" to change it.` };
      changes.push({ kind: 'add', path: h.path, before: '', after: h.contents, added: h.contents.split('\n').length - 1, removed: 0 });
      virtual.set(h.path, h.contents);
    } else if (h.type === 'delete') {
      const existing = current(h.path);
      if (existing == null) return { error: `Cannot delete ${h.path}: no such file.` };
      changes.push({ kind: 'delete', path: h.path, before: existing, after: '', added: 0, removed: existing.split('\n').length });
      virtual.set(h.path, null);
    } else {
      const existing = current(h.path);
      if (existing == null) return { error: `Cannot update ${h.path}: no such file.` };
      let after = existing;
      if (h.chunks.length) {
        const r = applyChunks(existing, h.chunks, h.path);
        if (r.error) return { error: r.error };
        after = r.content;
      }
      const added = h.chunks.reduce((n, c) => n + c.new.length, 0);
      const removed = h.chunks.reduce((n, c) => n + c.old.length, 0);
      if (h.movePath) {
        if (current(h.movePath) != null) return { error: `Cannot move ${h.path} to ${h.movePath}: that file already exists.` };
        changes.push({ kind: 'move', path: h.path, newPath: h.movePath, before: existing, after, added, removed });
        virtual.set(h.path, null);
        virtual.set(h.movePath, after);
      } else {
        changes.push({ kind: 'update', path: h.path, before: existing, after, added, removed });
        virtual.set(h.path, after);
      }
    }
  }
  return { changes };
}

module.exports = { parsePatch, planPatch };
