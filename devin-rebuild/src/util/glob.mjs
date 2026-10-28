/**
 * Glob matching shared by the glob tool, rule `globs:` and permission
 * patterns. Supports *, **, ?, [abc], {a,b}. A pattern without a slash
 * matches the basename anywhere ("*.ts" matches "src/a.ts"), as in
 * .gitignore and Cursor rule globs.
 */
import fs from 'node:fs';
import path from 'node:path';

const cache = new Map();

export function globToRegExp(glob) {
  if (cache.has(glob)) return cache.get(glob);
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end < 0) { re += '\\['; continue; }
      re += '[' + glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']';
      i = end;
    } else if (c === '{') {
      const end = glob.indexOf('}', i + 1);
      if (end < 0) { re += '\\{'; continue; }
      re += '(?:' + glob.slice(i + 1, end).split(',').map((p) => globToRegExp(p).source.slice(1, -1)).join('|') + ')';
      i = end;
    } else re += c.replace(/[.+^$()|\\]/g, '\\$&');
  }
  const out = new RegExp(`^${re}$`);
  cache.set(glob, out);
  return out;
}

/** Does relPath (forward slashes) match glob? */
export function matchGlob(glob, relPath) {
  const p = relPath.split(path.sep).join('/').replace(/^\.\//, '');
  const g = glob.replace(/^\.\//, '');
  if (!g.includes('/')) return globToRegExp(g).test(p.split('/').pop()) || globToRegExp(g).test(p);
  return globToRegExp(g).test(p);
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.hg', '.svn', '__pycache__', '.venv', 'target', 'dist', 'build', '.next']);

/** Walk a tree yielding relative file paths, skipping heavy/vendored dirs. */
export function* walk(root, { includeHidden = true, skip = SKIP_DIRS, max = 200_000 } = {}) {
  const stack = [''];
  let n = 0;
  while (stack.length) {
    const rel = stack.pop();
    let entries;
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!includeHidden && e.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!skip.has(e.name)) stack.push(r); continue; }
      if (++n > max) return;
      yield r;
    }
  }
}
