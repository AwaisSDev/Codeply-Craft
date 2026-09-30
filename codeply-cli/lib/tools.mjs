/**
 * Codeply agent tools.
 *
 * Each tool is a plain async function returning { ok, output, meta }. `output`
 * is what gets fed back to the model, so it is always truncated to a sane size -
 * an untruncated file read is the fastest way to blow the context budget and
 * make the agent stupid halfway through a task.
 *
 * Anything that changes the user's machine (write_file, edit_file, run) goes
 * through ctx.approve() first and never side-steps it.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { exec } from 'child_process';
import { createRequire } from 'module';
import { searchLibrary, listCategories, designLibraryConfigured, CATEGORY_LABELS } from './design-library/query.mjs';

const require = createRequire(import.meta.url);
const editEngine = require('./edit-engine.js');
const terminalHints = require('./terminal-hints.js');
const diagnostics = require('./diagnostics.js');
const { commandPatterns } = require('./arity.js');
const mcpLib = require('./mcp.js');
const applyLimit = require('./apply-limit.js');
const config = require('./config.js');
const skills = require('./skills.js');
const oauth = require('./oauth-connectors.js');
const webTools = require('./web-tools.js');
const applyPatchLib = require('./apply-patch.js');

// Successful writes made while using the hosted model are logged (counts
// only) for the usage dashboard. There is no cap - see apply-limit.js.
const RECORDED_TOOLS = new Set(['write_file', 'edit_file']);

const MAX_TOOL_OUTPUT = 12000;   // chars fed back to the model per tool call
const MAX_READ_LINES = 600;
const MAX_SEARCH_HITS = 60;
const RUN_TIMEOUT_MS = 120000;

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'out', 'coverage',
  '.cache', '.turbo', 'vendor', '__pycache__', '.venv', 'venv', 'target',
]);

const TEXT_EXT = new Set([
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.json', '.html', '.htm',
  '.css', '.scss', '.sass', '.less', '.md', '.txt', '.py', '.rb', '.go',
  '.rs', '.java', '.c', '.h', '.cpp', '.hpp', '.cs', '.php', '.sh', '.yml',
  '.yaml', '.toml', '.xml', '.svg', '.vue', '.svelte', '.sql', '.env',
]);

// Oversized output is saved in full to a file the model can page through
// with read_file, instead of the rest just being lost. Same idea as
// opencode's tool/truncate.ts (MIT). Old files are swept after a week.
const SPILL_DIR = path.join(os.tmpdir(), 'codeply-tool-output');
const SPILL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
let spillSwept = false;

function spillToFile(text) {
  try {
    fs.mkdirSync(SPILL_DIR, { recursive: true });
    if (!spillSwept) {
      spillSwept = true;
      const cutoff = Date.now() - SPILL_MAX_AGE_MS;
      for (const f of fs.readdirSync(SPILL_DIR)) {
        const p = path.join(SPILL_DIR, f);
        try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch {}
      }
    }
    const file = path.join(SPILL_DIR, `out-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}.txt`);
    fs.writeFileSync(file, text, 'utf8');
    return file;
  } catch { return null; }
}

/**
 * @param {string} text
 * @param {number} [max]
 * @param {{keep?: 'head'|'ends', spill?: boolean}} [opts]
 *   keep 'ends' shows the start and the end (command output: errors and
 *   summaries are usually last). spill saves the full text to a file.
 */
function truncate(text, max = MAX_TOOL_OUTPUT, { keep = 'head', spill = true } = {}) {
  if (text.length <= max) return text;
  const file = spill ? spillToFile(text) : null;
  const where = file
    ? `The full output (${text.length} characters, ${text.split('\n').length} lines) is saved at ${file} - read_file it with offset/limit, or search inside it with <path>, instead of re-running.`
    : 'Narrow the request if you need the rest.';
  if (keep === 'ends') {
    const head = text.slice(0, Math.floor(max * 0.35));
    const tail = text.slice(text.length - Math.floor(max * 0.6));
    return `${head}\n\n[… ${text.length - head.length - tail.length} characters cut from the middle. ${where}]\n\n${tail}`;
  }
  return `${text.slice(0, max)}\n\n[… truncated, ${text.length - max} more characters. ${where}]`;
}

/** Resolve a model-supplied path against cwd and report whether it escapes it. */
function resolvePath(p, cwd) {
  const abs = path.isAbsolute(p) ? path.normalize(p) : path.resolve(cwd, p);
  const rel = path.relative(cwd, abs);
  const outside = rel.startsWith('..') || path.isAbsolute(rel);
  return { abs, rel: outside ? abs : rel.replace(/\\/g, '/') || '.', outside };
}

/** Minimal glob -> RegExp. `**` crosses separators, `*` and `?` do not. */
function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; }
        else re += '.*';
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]'.includes(c) || c === '\\') {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`, 'i');
}

/** Depth-first file walk that skips build/vendor noise and bails out early. */
function walkFiles(root, { maxFiles = 4000, maxDepth = 12 } = {}) {
  const out = [];
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length && out.length < maxFiles) {
    const { dir, depth } = stack.pop();
    if (depth > maxDepth) continue;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.env') {
        if (entry.isDirectory()) continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        stack.push({ dir: full, depth: depth + 1 });
      } else if (entry.isFile()) {
        out.push(full);
        if (out.length >= maxFiles) break;
      }
    }
  }
  return out;
}

// ─── Read helpers ───────────────────────────────────────────────────────────

const MAX_LINE_CHARS = 2000;

/** NUL bytes, or mostly non-printable bytes, in the first 4KB. */
function looksBinary(buf) {
  const n = Math.min(buf.length, 4096);
  if (!n) return false;
  let odd = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0) return true;
    if (b < 7 || (b > 13 && b < 32)) odd++;
  }
  return odd / n > 0.3;
}

/** Up to 3 existing files whose names resemble a missing one. */
function similarPaths(abs, cwd) {
  const want = path.basename(abs).toLowerCase();
  const stem = want.replace(/\.[^.]+$/, '');
  const scored = [];
  const consider = (full) => {
    const name = path.basename(full).toLowerCase();
    const s = name === want ? 1 : name.replace(/\.[^.]+$/, '') === stem ? 0.9 : lineSimilarity(name, want);
    if (s >= 0.55) scored.push([s, full]);
  };
  const dir = path.dirname(abs);
  try { if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) consider(path.join(dir, f)); } catch {}
  // Same name somewhere else in the project is the other common slip.
  for (const f of walkFiles(cwd, { maxFiles: 3000, maxDepth: 8 })) if (path.basename(f).toLowerCase() === want) scored.push([0.95, f]);
  return [...new Map(scored.sort((a, b) => b[0] - a[0]).map(([, f]) => [f, f])).keys()]
    .slice(0, 3)
    .map((f) => resolvePath(f, cwd).rel);
}

// ─── Edit helpers ───────────────────────────────────────────────────────────

// ctx.fileState maps an absolute path to the mtime it had when this turn last
// read or wrote it. If the file changes on disk after that (the user saved it
// in their editor, a formatter ran), an edit built from the old read would be
// matched against content the model has never seen, so it is refused until
// the file is read again.
function rememberDiskState(ctx, abs) {
  if (!ctx.fileState) return;
  try { ctx.fileState.set(abs, fs.statSync(abs).mtimeMs); } catch {}
}

function changedSinceSeen(ctx, abs) {
  if (!ctx.fileState || !ctx.fileState.has(abs)) return false;
  try { return fs.statSync(abs).mtimeMs !== ctx.fileState.get(abs); } catch { return false; }
}

function bigrams(s) {
  const out = new Map();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    out.set(g, (out.get(g) || 0) + 1);
  }
  return out;
}

/** Dice similarity of two trimmed lines, 0..1. */
function lineSimilarity(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const A = bigrams(a), B = bigrams(b);
  let overlap = 0;
  for (const [g, n] of A) overlap += Math.min(n, B.get(g) || 0);
  return (2 * overlap) / (a.length - 1 + b.length - 1);
}

/**
 * When a search block does not match, show the model the region of the file
 * it most likely meant, with line numbers, so it can copy the real text on
 * the next reply instead of re-reading a long file from the top or guessing
 * again from memory.
 */
function nearestMatchHint(content, search) {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const want = search.replace(/\r\n/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!want.length || !lines.length) return '';

  let best = -1, bestScore = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    // Score a candidate start by how well the next few file lines line up
    // with the first few search lines, not by one line alone - a single
    // closing brace or "return x;" matches all over a file.
    let score = 0, n = 0;
    for (let k = 0, fi = i; k < Math.min(3, want.length) && fi < lines.length; fi++) {
      const ft = lines[fi].trim();
      if (!ft) continue;
      score += lineSimilarity(ft, want[k]);
      n++; k++;
    }
    score = n ? score / Math.min(3, want.length) : 0;
    if (score > bestScore) { bestScore = score; best = i; }
  }
  if (best === -1 || bestScore < 0.45) return '';

  const from = Math.max(0, best - 2);
  const to = Math.min(lines.length, best + want.length + 3);
  const width = String(to).length;
  const excerpt = lines.slice(from, to).map((l, i) => `${String(from + i + 1).padStart(width)}│${l}`).join('\n');
  return `\nClosest match in the file right now (lines ${from + 1}-${to}). Copy your search text from here, without the line-number prefix:\n${excerpt}`;
}

/** 1-based line numbers where an exact block starts. */
function exactMatchLines(content, block) {
  const text = content.replace(/\r\n/g, '\n');
  const needle = block.replace(/\r\n/g, '\n');
  const out = [];
  for (let at = text.indexOf(needle); at !== -1 && out.length < 20; at = text.indexOf(needle, at + 1)) {
    out.push(text.slice(0, at).split('\n').length);
  }
  return out;
}

function isTruthy(v) {
  return /^(1|true|yes|all)$/i.test(String(v || '').trim());
}

// Plan mode's one exception to "read-only": the plan file itself.
const PLAN_DIR = '.codeply/plans';
function isPlanPath(p, cwd) {
  if (!p) return false;
  const { rel, outside } = resolvePath(String(p), cwd);
  return !outside && /^\.codeply\/plans\/[^/]+\.md$/i.test(rel);
}

// ─── Tools ──────────────────────────────────────────────────────────────────

async function list_dir(args, ctx) {
  const target = args.path || '.';
  const { abs, rel } = resolvePath(target, ctx.cwd);
  if (!fs.existsSync(abs)) return { ok: false, output: `No such directory: ${rel}` };
  if (!fs.statSync(abs).isDirectory()) return { ok: false, output: `Not a directory: ${rel}` };

  let entries;
  try { entries = fs.readdirSync(abs, { withFileTypes: true }); }
  catch (e) { return { ok: false, output: `Cannot read ${rel}: ${e.message}` }; }

  const dirs = [];
  const files = [];
  for (const e of entries) {
    if (e.isDirectory()) {
      dirs.push(IGNORED_DIRS.has(e.name) ? `${e.name}/  (skipped)` : `${e.name}/`);
    } else if (e.isFile()) {
      let size = '';
      try { size = `  ${fs.statSync(path.join(abs, e.name)).size}b`; } catch {}
      files.push(`${e.name}${size}`);
    }
  }
  dirs.sort(); files.sort();
  const body = [...dirs, ...files].join('\n') || '(empty)';
  return { ok: true, output: truncate(`${rel}/\n${body}`), meta: { label: rel, count: dirs.length + files.length } };
}

async function read_file(args, ctx) {
  const target = args.path;
  if (!target) return { ok: false, output: 'read_file needs a <path>.' };
  const { abs, rel } = resolvePath(target, ctx.cwd);
  if (!fs.existsSync(abs)) {
    const alts = similarPaths(abs, ctx.cwd);
    return { ok: false, output: `No such file: ${rel}${alts.length ? `. Did you mean: ${alts.join(', ')}?` : ''}` };
  }
  if (fs.statSync(abs).isDirectory()) return { ok: false, output: `${rel} is a directory - use list_dir.` };

  let buf;
  try { buf = fs.readFileSync(abs); }
  catch (e) { return { ok: false, output: `Cannot read ${rel}: ${e.message}` }; }
  if (looksBinary(buf)) {
    return { ok: false, output: `${rel} is a binary file (${buf.length} bytes), not text. Don't read it; use view_images for pictures, or a tool that understands the format.` };
  }
  const content = buf.toString('utf8');

  const allLines = content.split('\n');
  const offset = Math.max(0, parseInt(args.offset, 10) || 0);
  if (offset > 0 && offset >= allLines.length) {
    return { ok: false, output: `${rel} has only ${allLines.length} lines, so offset ${offset} is past the end. Use an offset below ${allLines.length}.` };
  }
  const limit = Math.min(parseInt(args.limit, 10) || MAX_READ_LINES, MAX_READ_LINES);
  const slice = allLines.slice(offset, offset + limit);
  const width = String(offset + slice.length).length;

  // Minified bundles put a whole file on one line; one of those would eat
  // the entire output budget. Lines are shown without a CRLF file's \r.
  const numbered = slice
    .map((l, i) => {
      const line = l.replace(/\r$/, '');
      const shown = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}… (line cut, ${line.length} chars)` : line;
      return `${String(offset + i + 1).padStart(width)}│${shown}`;
    })
    .join('\n');
  const more = allLines.length > offset + slice.length
    ? `\n[… ${allLines.length - offset - slice.length} more lines. Re-read with offset=${offset + slice.length}.]`
    : '';

  rememberDiskState(ctx, abs);
  return {
    ok: true,
    output: truncate(`${rel} (${allLines.length} lines)\n${numbered}${more}`, MAX_TOOL_OUTPUT, { spill: false }),
    // offset/linesShown/hasMore let agent.mjs auto-continue a later call on
    // this same path that omits <offset> - a model re-requesting "the rest"
    // of a long file doesn't reliably track and restate the right offset
    // itself, so leaving that entirely up to it meant it would often just
    // land back at the top again instead of actually seeing new content.
    meta: { label: rel, count: allLines.length, offset, linesShown: slice.length, hasMore: allLines.length > offset + slice.length },
  };
}

async function write_file(args, ctx) {
  const target = args.path;
  if (!target) return { ok: false, output: 'write_file needs a <path>.' };
  if (args.content == null) return { ok: false, output: 'write_file needs a <content> block.' };

  const { abs, rel, outside } = resolvePath(target, ctx.cwd);
  const existed = fs.existsSync(abs);
  const before = existed ? fs.readFileSync(abs, 'utf8') : '';
  const after = args.content;
  if (existed && before === after) {
    return { ok: true, output: `${rel} already has exactly this content - nothing written.`, meta: { label: rel, noop: true } };
  }

  const beforeLines = existed ? before.split('\n').length : 0;
  const afterLines = after.split('\n').length;

  const verdict = ctx.mode === 'Plan' && isPlanPath(target, ctx.cwd) ? 'allow' : await ctx.approve({
    tool: 'write_file',
    path: rel,
    title: existed ? `Overwrite ${rel}` : `Create ${rel}`,
    detail: existed
      ? `${beforeLines} lines → ${afterLines} lines`
      : `${afterLines} lines`,
    danger: outside,
  });
  if (verdict === 'reject') return { ok: false, output: `User declined the write to ${rel}.`, meta: { rejected: true } };

  try {
    const dir = path.dirname(abs);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(abs, after, 'utf8');
  } catch (e) {
    return { ok: false, output: `Cannot write ${rel}: ${e.message}` };
  }
  rememberDiskState(ctx, abs);
  const problems = await diagnostics.checkFile(abs, ctx.cwd);

  return {
    ok: true,
    output: `Wrote ${rel} (${afterLines} lines). The write succeeded exactly as you sent it - ` +
      `do NOT read the file back to confirm it.` + problemsNote(rel, problems),
    meta: { label: rel, added: afterLines, removed: beforeLines, wrote: true, problems },
  };
}

function problemsNote(rel, problems) {
  if (!problems.length) return '';
  return `\n\nSyntax check on ${rel} found ${problems.length === 1 ? 'a problem' : `${problems.length} problems`} ` +
    `(fix before moving on):\n${problems.map((p) => `- ${p}`).join('\n')}`;
}

async function edit_file(args, ctx) {
  const target = args.path;
  if (!target) return { ok: false, output: 'edit_file needs a <path>.' };
  if (!args.search) return { ok: false, output: 'edit_file needs a <search> block.' };
  if (args.replace == null) return { ok: false, output: 'edit_file needs a <replace> block.' };

  const { abs, rel, outside } = resolvePath(target, ctx.cwd);
  if (!fs.existsSync(abs)) return { ok: false, output: `No such file: ${rel}. Use write_file to create it.` };

  if (changedSinceSeen(ctx, abs)) {
    ctx.fileState.delete(abs);
    return {
      ok: false,
      output: `Edit to ${rel} did not apply: the file changed on disk after you last read it (edited outside this conversation). ` +
        'Read it again and build the edit from its current content.',
    };
  }

  const before = fs.readFileSync(abs, 'utf8');
  const replaceAll = isTruthy(args.all);
  // Dry-run through the same matcher that will do the real edit, so the user
  // is never asked to approve something that turns out not to apply.
  let attempt;
  let occurrences = 1;
  if (replaceAll) {
    // Every occurrence, exact text only: the whitespace-tolerant matcher is
    // for finding ONE intended block, and applying its guesses file-wide
    // would be a good way to change lines nobody meant to touch.
    const text = before.replace(/\r\n/g, '\n');
    const needle = args.search.replace(/\r\n/g, '\n');
    occurrences = needle ? text.split(needle).length - 1 : 0;
    attempt = occurrences > 0
      ? { ok: true, content: text.split(needle).join(args.replace.replace(/\r\n/g, '\n')) }
      : { ok: false, error: needle ? 'notfound' : 'empty' };
    if (attempt.ok && /\r\n/.test(before)) attempt.content = attempt.content.replace(/\n/g, '\r\n');
  } else {
    attempt = editEngine.applySearchReplace(before, args.search, args.replace);
  }
  if (!attempt.ok) {
    let why;
    if (attempt.error === 'notfound') {
      why = 'that exact text is not in the file.' + (nearestMatchHint(before, args.search) || ' Re-read the part you want to change and copy the block verbatim.');
    } else if (attempt.error === 'multiple') {
      const at = exactMatchLines(before, args.search);
      why = `that text appears more than once${at.length ? ` (starting at lines ${at.join(', ')})` : ''}. ` +
        'Include more surrounding lines so it matches exactly one place, or add <all>true</all> if every occurrence should change.';
    } else {
      why = 'the search block was empty.';
    }
    return { ok: false, output: `Edit to ${rel} did not apply: ${why}` };
  }

  const removed = args.search.split('\n').length * occurrences;
  const added = args.replace.split('\n').length * occurrences;

  const verdict = ctx.mode === 'Plan' && isPlanPath(target, ctx.cwd) ? 'allow' : await ctx.approve({
    tool: 'edit_file',
    path: rel,
    title: `Edit ${rel}`,
    detail: `-${removed} +${added} lines`,
    diff: { search: args.search, replace: args.replace },
    danger: outside,
  });
  if (verdict === 'reject') return { ok: false, output: `User declined the edit to ${rel}.`, meta: { rejected: true } };

  try { fs.writeFileSync(abs, attempt.content, 'utf8'); }
  catch (e) { return { ok: false, output: `Cannot write ${rel}: ${e.message}` }; }
  rememberDiskState(ctx, abs);
  const problems = await diagnostics.checkFile(abs, ctx.cwd);

  const nowLines = attempt.content.split('\n').length;
  return {
    ok: true,
    // The "do not re-read" line is load-bearing: without it the model burns a
    // whole extra round-trip reading the file back, and stuffs the entire file
    // into context again, which slows down every following step.
    output: `Edited ${rel} (-${removed} +${added} lines${occurrences > 1 ? `, ${occurrences} occurrences` : ''}). The file is now ${nowLines} lines. ` +
      `The change was matched and applied successfully - do NOT read the file back to confirm it.` +
      (attempt.fuzzy ? ' (Your search text did not match exactly; the closest unique block was used. Copy search text exactly next time.)' : '') +
      problemsNote(rel, problems),
    meta: { label: rel, added, removed, wrote: true, problems },
  };
}

const MAX_SEARCH_CONTEXT = 5;
const MAX_FOUND_FILES = 200;

/**
 * Content search, or a file-name search when only <glob> is given.
 *
 *   <pattern>   regex matched per line (case-insensitive)
 *   <glob>      limit to matching paths; alone, it lists matching files
 *   <path>      folder to search under (default: project root)
 *   <context>   lines of surrounding code to show per hit (0-5), so a hit
 *               can often be edited without a separate read_file
 *   <files_only> true: list each matching file once with its hit count
 */
async function search(args, ctx) {
  const pattern = args.pattern;
  const globRe = args.glob ? globToRegex(args.glob) : null;
  if (!pattern && !globRe) return { ok: false, output: 'search needs a <pattern>, or a <glob> to find files by name.' };

  let re = null;
  if (pattern) {
    try { re = new RegExp(pattern, 'i'); }
    catch (e) { return { ok: false, output: `Invalid regex: ${e.message}` }; }
  }

  const root = args.path ? resolvePath(args.path, ctx.cwd).abs : ctx.cwd;
  if (!fs.existsSync(root)) return { ok: false, output: `No such folder: ${args.path}` };
  // A single file works too (e.g. a saved long command output).
  const files = fs.statSync(root).isFile() ? [root] : walkFiles(root);

  if (!re) {
    // Also match against just the file name, so "*.test.js" finds nested files
    // without the model having to know to write "**/*.test.js".
    const found = files
      .map((f) => path.relative(ctx.cwd, f).replace(/\\/g, '/'))
      .filter((rel) => globRe.test(rel) || globRe.test(rel.split('/').pop()))
      .sort();
    const shown = found.slice(0, MAX_FOUND_FILES);
    const header = found.length
      ? `${found.length} file(s) matching ${args.glob}${found.length > shown.length ? ` (first ${shown.length} shown)` : ''}:`
      : `No files matching ${args.glob}.`;
    return { ok: true, output: truncate(`${header}\n${shown.join('\n')}`), meta: { label: args.glob, count: found.length } };
  }

  const context = Math.min(MAX_SEARCH_CONTEXT, Math.max(0, parseInt(args.context, 10) || 0));
  const filesOnly = isTruthy(args.files_only);

  // Context blocks spend several output lines per hit, so the cap scales with them.
  const maxLines = MAX_SEARCH_HITS * (context ? 4 : 1);
  const hits = [];
  const fileCounts = [];
  let totalHits = 0;
  let scanned = 0;
  for (const file of files) {
    const rel = path.relative(ctx.cwd, file).replace(/\\/g, '/');
    if (globRe && !globRe.test(rel) && !globRe.test(rel.split('/').pop())) continue;
    const ext = path.extname(file).toLowerCase();
    if (ext && !TEXT_EXT.has(ext)) continue;
    let content;
    try {
      if (fs.statSync(file).size > 2_000_000) continue;
      content = fs.readFileSync(file, 'utf8');
    } catch { continue; }
    if (content.includes('\u0000')) continue; // binary that happens to have a text extension
    scanned++;
    const lines = content.split('\n');
    let inFile = 0;
    let lastShown = -1;
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      inFile++;
      totalHits++;
      if (filesOnly || hits.length >= maxLines) continue;
      if (!context) {
        hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
        continue;
      }
      // Context blocks: hit line marked with ":", neighbours with "-", and
      // overlapping windows merged so nearby hits don't repeat lines.
      const from = Math.max(lastShown + 1, i - context);
      const to = Math.min(lines.length - 1, i + context);
      if (from > lastShown + 1 || lastShown === -1) hits.push(`--`);
      for (let k = from; k <= to; k++) {
        const mark = re.test(lines[k]) ? ':' : '-';
        hits.push(`${rel}${mark}${k + 1}${mark} ${lines[k].slice(0, 200)}`);
      }
      lastShown = to;
    }
    if (inFile) fileCounts.push(`${rel}  (${inFile})`);
    if (!filesOnly && hits.length >= maxLines) break;
  }

  if (filesOnly) {
    const header = fileCounts.length
      ? `${totalHits} match(es) in ${fileCounts.length} file(s), out of ${scanned} scanned:`
      : `No matches for /${pattern}/ across ${scanned} file(s).`;
    return { ok: true, output: truncate(`${header}\n${fileCounts.join('\n')}`), meta: { label: pattern, count: totalHits } };
  }

  const capped = hits.length >= maxLines;
  const header = totalHits
    ? `${totalHits}${capped ? '+' : ''} match(es) across ${scanned} file(s)${capped ? '. Output capped: narrow with <glob>/<path>, or use <files_only>true</files_only> to see which files match' : ''}:`
    : `No matches for /${pattern}/ across ${scanned} file(s).`;
  return { ok: true, output: truncate(`${header}\n${hits.join('\n')}`), meta: { label: pattern, count: totalHits } };
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB - plenty for web assets, small enough to not stall a turn
const FETCH_TIMEOUT_MS = 20000;

/**
 * Download an image from the internet and save it to disk. This is the
 * agent's only sanctioned path to the network for assets - `run` can already
 * reach curl/Invoke-WebRequest, but that gives the model no feedback about
 * whether it actually got an image back, no size cap, and a generic "Run
 * command" approval prompt instead of one that tells the user what's about
 * to land on their disk and from where.
 */
async function fetch_image(args, ctx) {
  const url = (args.url || '').trim();
  const target = (args.path || '').trim();
  if (!url) return { ok: false, output: 'fetch_image needs a <url>.' };
  if (!target) return { ok: false, output: 'fetch_image needs a <path> to save the image to.' };

  let parsed;
  try { parsed = new URL(url); }
  catch { return { ok: false, output: `Not a valid URL: ${url}` }; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, output: 'fetch_image only supports http:// and https:// URLs.' };
  }

  const { abs, rel, outside } = resolvePath(target, ctx.cwd);

  // `path` rides alongside `detail` (the original url) so a host that wants to
  // offer a real picker doesn't have to scrape the human-readable `title` text
  // to know where the image is headed.
  const verdict = await ctx.approve({
    tool: 'fetch_image',
    title: `Download image to ${rel}`,
    detail: url,
    path: rel,
    danger: outside,
  });
  const verdictAction = typeof verdict === 'string' ? verdict : verdict?.action;
  if (verdictAction === 'reject') return { ok: false, output: `User declined the download to ${rel}.`, meta: { rejected: true } };

  // A host UI (e.g. an image picker the user searched and clicked through)
  // can hand back a different URL than the one the model proposed - that
  // replaces it here, but everything downstream (fetch, validation, write)
  // is identical either way.
  const fetchUrl = (verdict && typeof verdict === 'object' && verdict.url) ? verdict.url : url;

  let res;
  try {
    res = await fetch(fetchUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' });
  } catch (e) {
    return { ok: false, output: `Could not reach ${fetchUrl}: ${e.message}` };
  }
  if (!res.ok) return { ok: false, output: `${fetchUrl} returned HTTP ${res.status}.` };

  const contentType = (res.headers.get('content-type') || '').split(';')[0].trim();
  if (!contentType.startsWith('image/')) {
    return { ok: false, output: `${fetchUrl} did not return an image (content-type: ${contentType || 'unknown'}). Nothing was saved.` };
  }

  let buf;
  try { buf = Buffer.from(await res.arrayBuffer()); }
  catch (e) { return { ok: false, output: `Failed reading the response from ${fetchUrl}: ${e.message}` }; }

  if (buf.length > MAX_IMAGE_BYTES) {
    return { ok: false, output: `Image is ${(buf.length / 1e6).toFixed(1)}MB, over the ${MAX_IMAGE_BYTES / 1e6}MB limit. Try a smaller/compressed source.` };
  }

  try {
    const dir = path.dirname(abs);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(abs, buf);
  } catch (e) {
    return { ok: false, output: `Cannot write ${rel}: ${e.message}` };
  }

  return {
    ok: true,
    output: `Downloaded ${rel} (${contentType}, ${(buf.length / 1024).toFixed(0)}KB) from ${fetchUrl}. ` +
      `Reference it in markup with a normal relative path - do NOT read the file back to confirm it.`,
    meta: { label: rel, wrote: true },
  };
}

/**
 * Gmail access tokens expire in ~1hr; the refresh token doesn't. Refreshed
 * transparently here before every call rather than waiting for a 401, since
 * "expired 4 minutes ago" and "expires in 4 minutes" both need the same
 * refresh anyway and there's no benefit to waiting for the failure first.
 */
async function getValidGmailToken() {
  const gmail = config.getIntegration('gmail');
  if (!gmail.accessToken) return null;
  if (gmail.expiresAt && Date.now() < gmail.expiresAt - 60000) return gmail.accessToken;
  if (!gmail.refreshToken) return gmail.accessToken; // nothing to refresh with - let the call itself fail if it's actually expired
  const refreshed = await oauth.refreshGmailToken(gmail.clientId, gmail.clientSecret, gmail.refreshToken);
  config.saveIntegration('gmail', { accessToken: refreshed.access_token, expiresAt: Date.now() + (refreshed.expires_in || 3600) * 1000 });
  return refreshed.access_token;
}

async function gmail_send(args, ctx) {
  const to = (args.to || '').trim();
  const subject = (args.subject || '').trim();
  const body = args.body || '';
  if (!to) return { ok: false, output: 'gmail_send needs a <to> address.' };
  if (!subject) return { ok: false, output: 'gmail_send needs a <subject>.' };

  const token = await getValidGmailToken();
  if (!token) return { ok: false, output: 'Gmail is not connected. Ask the user to connect it from Connect Apps (account menu → Connect Apps) first.' };

  const verdict = await ctx.approve({
    tool: 'gmail_send',
    title: `Send email to ${to}`,
    detail: `Subject: ${subject}\n\n${body}`,
    danger: false,
  });
  if (verdict === 'reject') return { ok: false, output: `User declined to send the email to ${to}.`, meta: { rejected: true } };

  try {
    const result = await oauth.gmailSend(token, { to, subject, body });
    return { ok: true, output: `Email sent to ${to} (message id ${result.id}).`, meta: { label: `to ${to}: ${subject}` } };
  } catch (e) {
    return { ok: false, output: `Gmail send failed: ${e.message}` };
  }
}

async function gmail_search(args, ctx) {
  const query = (args.query || '').trim();
  if (!query) return { ok: false, output: 'gmail_search needs a <query> (Gmail search syntax, e.g. "from:x@y.com is:unread").' };

  const token = await getValidGmailToken();
  if (!token) return { ok: false, output: 'Gmail is not connected. Ask the user to connect it from Connect Apps (account menu → Connect Apps) first.' };

  try {
    const results = await oauth.gmailSearch(token, query);
    if (!results.length) return { ok: true, output: `No messages matched "${query}".`, meta: { label: query } };
    const lines = results.map((m) => `- ${m.subject || '(no subject)'} - from ${m.from} - ${m.date}\n  ${m.snippet}`);
    return { ok: true, output: `${results.length} message(s) matching "${query}":\n\n${lines.join('\n')}`, meta: { label: query, count: results.length } };
  } catch (e) {
    return { ok: false, output: `Gmail search failed: ${e.message}` };
  }
}

// Slack's own docs are inconsistent about whether chat.postMessage accepts a
// bare channel name - it's legacy behavior some workspaces get and others
// don't. Resolving to a real ID via conversations.list first is the only
// reliable path, and it's one extra call, not a real cost.
async function resolveSlackChannel(accessToken, input) {
  const name = input.replace(/^#/, '').toLowerCase();
  if (/^[CGD][A-Z0-9]{8,}$/.test(input)) return input; // already looks like a real Slack ID
  const channels = await oauth.slackListChannels(accessToken);
  const match = channels.find((c) => c.name.toLowerCase() === name);
  if (!match) throw new Error(`No channel named "${input}" found (or the bot hasn't been added to it).`);
  return match.id;
}

async function slack_post_message(args, ctx) {
  const channelInput = (args.channel || '').trim();
  const text = args.text || '';
  if (!channelInput) return { ok: false, output: 'slack_post_message needs a <channel> (name like "general" or a channel ID).' };
  if (!text.trim()) return { ok: false, output: 'slack_post_message needs <text> to send.' };

  const slack = config.getIntegration('slack');
  if (!slack.accessToken) return { ok: false, output: 'Slack is not connected. Ask the user to connect it from Connect Apps (account menu → Connect Apps) first.' };

  const verdict = await ctx.approve({
    tool: 'slack_post_message',
    title: `Post to #${channelInput.replace(/^#/, '')}`,
    detail: text,
    danger: false,
  });
  if (verdict === 'reject') return { ok: false, output: `User declined to post to ${channelInput}.`, meta: { rejected: true } };

  try {
    // Channel lookup always uses the bot token - channels:read is a bot-only
    // scope in this app's setup regardless of which token ends up posting.
    const channelId = await resolveSlackChannel(slack.accessToken, channelInput);
    // Posting defaults to the user token when connected - messages read as
    // coming from the actual person, not the "Codeply Craft APP" bot. Falls
    // back to the bot token for anyone who connected before user-token
    // support existed, or who only approved the bot scopes.
    const useUserToken = !!slack.userAccessToken;
    const postToken = useUserToken ? slack.userAccessToken : slack.accessToken;
    await oauth.slackPostMessage(postToken, { channel: channelId, text }, { isUserToken: useUserToken });
    return { ok: true, output: `Posted to ${channelInput}${useUserToken ? ' as you' : ''}.`, meta: { label: `#${channelInput.replace(/^#/, '')}` } };
  } catch (e) {
    return { ok: false, output: `Slack post failed: ${e.message}` };
  }
}

function sanitizeProjectName(raw) {
  const base = (raw || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 52);
  return base || 'codeply-project';
}

/** Add/replace KEY=value lines in an .env file without disturbing anything else already in it. */
function upsertEnvFile(envPath, vars) {
  let existing = '';
  try { existing = fs.readFileSync(envPath, 'utf8'); } catch {}
  const lines = existing.length ? existing.split(/\r?\n/) : [];
  for (const { key, value } of vars) {
    const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
    const line = `${key}=${value}`;
    if (idx === -1) lines.push(line);
    else lines[idx] = line;
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  fs.writeFileSync(envPath, `${lines.join('\n')}\n`, 'utf8');
}

const VERCEL_MAX_INLINE_BYTES = 15 * 1024 * 1024; // inline base64 deploy body - plenty for a hand-built site, not an asset-heavy monorepo
const ENV_FILENAME_RE = /^\.env(\..*)?$/;

async function vercel_deploy(args, ctx) {
  const root = args.path ? resolvePath(args.path, ctx.cwd).abs : ctx.cwd;
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return { ok: false, output: `${args.path || '.'} is not a directory.` };
  }

  const vercel = config.getIntegration('vercel');
  if (!vercel.accessToken) return { ok: false, output: 'Vercel is not connected. Ask the user to connect it from Connect Apps (account menu → Connect Apps) first.' };

  // .env files never ship in the deployment bundle - they exist to become
  // Vercel project env vars (see supabase_create_project), not static files a
  // visitor could fetch by URL.
  const paths = walkFiles(root).filter((abs) => !ENV_FILENAME_RE.test(path.basename(abs)));
  if (!paths.length) return { ok: false, output: `No deployable files found under ${path.relative(ctx.cwd, root) || '.'}.` };

  const files = [];
  let totalBytes = 0;
  for (const abs of paths) {
    const rel = path.relative(root, abs).replace(/\\/g, '/');
    const buf = fs.readFileSync(abs);
    totalBytes += buf.length;
    if (totalBytes > VERCEL_MAX_INLINE_BYTES) {
      return {
        ok: false,
        output: `${path.relative(ctx.cwd, root) || 'This project'} is over the ${VERCEL_MAX_INLINE_BYTES / 1e6}MB inline-deploy limit ` +
          `(stopped at ${rel}). Remove large binary assets from the deploy folder, or deploy a smaller subdirectory.`,
      };
    }
    files.push({ file: rel, data: buf.toString('base64'), encoding: 'base64' });
  }

  const projectName = sanitizeProjectName(path.basename(root));

  const verdict = await ctx.approve({
    tool: 'vercel_deploy',
    title: `Deploy "${projectName}" to Vercel`,
    detail: `${files.length} file(s), ${(totalBytes / 1024).toFixed(0)}KB - production deployment`,
    danger: true,
  });
  if (verdict === 'reject') return { ok: false, output: `User declined the deploy of ${projectName}.`, meta: { rejected: true } };

  try {
    const deployment = await oauth.vercelDeploy(vercel.accessToken, vercel.teamId, projectName, files);
    // Every project gets `<project-name>.vercel.app` as its default, always-
    // public production domain - separate from (and not listed in) this
    // deployment response's own .url (a per-deploy generated URL with a
    // random hash) or .alias (a team-suffixed alias), both of which stay
    // gated behind Vercel Authentication under this account's protection
    // settings. Reporting either of those hands back a URL that looks broken
    // to anyone without a Vercel login, even though the deploy itself worked.
    const publicUrl = `https://${projectName}.vercel.app`;
    return {
      ok: true,
      output: `Deployed "${projectName}" to Vercel - ${publicUrl} (state: ${deployment.readyState || 'unknown'}). ` +
        `The build runs on Vercel's side - if that state isn't READY yet, it will finish shortly.`,
      meta: { label: projectName },
    };
  } catch (e) {
    return { ok: false, output: `Vercel deploy failed: ${e.message}` };
  }
}

async function supabase_create_project(args, ctx) {
  const supabaseToken = await getValidSupabaseToken();
  if (!supabaseToken) return { ok: false, output: SUPABASE_NOT_CONNECTED };

  const projectName = sanitizeProjectName(args.name || path.basename(ctx.cwd));

  let orgs;
  try { orgs = await oauth.supabaseListOrganizations(supabaseToken); }
  catch (e) { return { ok: false, output: `Could not look up Supabase organizations: ${e.message}` }; }
  if (!orgs?.length) return { ok: false, output: 'No Supabase organizations found for this account - create one at supabase.com first.' };
  const org = orgs[0];

  const vercel = config.getIntegration('vercel');
  const willPushToVercel = !!vercel.accessToken;
  const vercelProjectName = sanitizeProjectName(path.basename(ctx.cwd));

  const verdict = await ctx.approve({
    tool: 'supabase_create_project',
    title: `Create Supabase project "${projectName}"`,
    detail: `Organization: ${org.name} (${org.slug}). Writes SUPABASE_URL/SUPABASE_ANON_KEY/DATABASE_URL to .env` +
      (willPushToVercel ? ` and pushes the same to the "${vercelProjectName}" Vercel project.` : '.'),
    danger: false,
  });
  if (verdict === 'reject') return { ok: false, output: `User declined creating the Supabase project.`, meta: { rejected: true } };

  const dbPass = crypto.randomBytes(24).toString('base64url');

  let project;
  try {
    project = await oauth.supabaseCreateProject(supabaseToken, { name: projectName, organizationSlug: org.slug, dbPass });
  } catch (e) {
    return { ok: false, output: `Supabase project creation failed: ${e.message}` };
  }

  let keys;
  try {
    keys = await oauth.supabaseGetProjectKeys(supabaseToken, project.ref, dbPass);
  } catch (e) {
    return {
      ok: true,
      output: `Created Supabase project "${projectName}" (ref ${project.ref}), but could not fetch its API keys yet: ${e.message} ` +
        `The project exists - check the Supabase dashboard for its URL/anon key.`,
      meta: { label: projectName },
    };
  }

  const envVars = [
    { key: 'SUPABASE_URL', value: keys.url },
    { key: 'SUPABASE_ANON_KEY', value: keys.anonKey },
    { key: 'DATABASE_URL', value: keys.databaseUrl },
  ];

  try {
    upsertEnvFile(path.join(ctx.cwd, '.env'), envVars);
  } catch (e) {
    return {
      ok: true,
      output: `Created Supabase project "${projectName}" (${keys.url}), but could not write .env: ${e.message}\n` +
        envVars.map((v) => `${v.key}=${v.value}`).join('\n'),
      meta: { label: projectName },
    };
  }

  let vercelNote = '';
  if (willPushToVercel) {
    try {
      await oauth.vercelSetEnvVars(vercel.accessToken, vercel.teamId, vercelProjectName, envVars);
      vercelNote = ` Pushed the same env vars to the "${vercelProjectName}" Vercel project.`;
    } catch (e) {
      vercelNote = ` Wrote .env locally, but pushing env vars to Vercel failed: ${e.message} (Vercel project "${vercelProjectName}" may not exist yet - deploy it first.)`;
    }
  }

  return {
    ok: true,
    output: `Created Supabase project "${projectName}" (${keys.url}) and wrote SUPABASE_URL/SUPABASE_ANON_KEY/DATABASE_URL to .env.${vercelNote}`,
    meta: { label: projectName },
  };
}

async function supabase_delete_project(args, ctx) {
  const supabaseToken = await getValidSupabaseToken();
  if (!supabaseToken) return { ok: false, output: SUPABASE_NOT_CONNECTED };

  const target = (args.ref || args.name || path.basename(ctx.cwd)).trim();
  if (!target) return { ok: false, output: 'supabase_delete_project needs a <name> or <ref> to identify the project.' };

  let projects;
  try { projects = await oauth.supabaseListProjects(supabaseToken); }
  catch (e) { return { ok: false, output: `Could not look up Supabase projects: ${e.message}` }; }

  // A ref (Supabase's project id, e.g. "abcdefghijklmnop") never collides
  // with a name, so try that first before falling back to a name match.
  let project = projects.find((p) => p.ref === target);
  if (!project) {
    const nameLower = sanitizeProjectName(target).toLowerCase();
    const matches = projects.filter((p) => p.name.toLowerCase() === nameLower);
    if (matches.length > 1) {
      return {
        ok: false,
        output: `Multiple Supabase projects are named "${target}" - specify which by <ref> instead: ` +
          matches.map((p) => `${p.ref} (${p.region})`).join(', '),
      };
    }
    project = matches[0];
  }
  if (!project) return { ok: false, output: `No Supabase project found matching "${target}".` };

  const verdict = await ctx.approve({
    tool: 'supabase_delete_project',
    title: `Delete Supabase project "${project.name}"`,
    detail: `ref ${project.ref} - this permanently deletes the project and its database. Supabase does not support undo or restore.`,
    danger: true,
  });
  if (verdict === 'reject') return { ok: false, output: `User declined deleting the Supabase project.`, meta: { rejected: true } };

  try {
    await oauth.supabaseDeleteProject(supabaseToken, project.ref);
  } catch (e) {
    return { ok: false, output: `Supabase project deletion failed: ${e.message}` };
  }

  return {
    ok: true,
    output: `Deleted Supabase project "${project.name}" (ref ${project.ref}). This did not touch .env or any Vercel env vars pointing at it - remove those separately if they're now stale.`,
    meta: { label: project.name },
  };
}

/** GitHub repo names allow more than Vercel/Supabase project names - letters (any case), digits, dot/dash/underscore. */
function sanitizeRepoName(raw) {
  const base = (raw || '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return base || 'codeply-project';
}

// Async on purpose, same as run()'s exec() below - this is the ONE thing
// every concurrently-running session shares (Electron's single main-process
// event loop), so a synchronous git call (execSync) here doesn't just block
// its own turn, it freezes every other session - the main chat included -
// for as long as it runs. That's harmless for a local `git init`/`commit`
// (milliseconds) but genuinely dangerous for `git push`, a real network
// call that can take seconds to tens of seconds: a synchronous push used to
// hang the entire app solid until it finished.
function execAsync(cmd, opts) {
  return new Promise((resolve, reject) => {
    exec(cmd, opts, (err, stdout) => {
      if (err) { reject(err); return; }
      resolve(stdout);
    });
  });
}

function runGit(args, cwd) {
  return execAsync(`git ${args}`, { cwd, windowsHide: true, encoding: 'utf8', timeout: RUN_TIMEOUT_MS });
}

async function github_create_repo(args, ctx) {
  const root = args.path ? resolvePath(args.path, ctx.cwd).abs : ctx.cwd;
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return { ok: false, output: `${args.path || '.'} is not a directory.` };
  }

  const github = config.getIntegration('github');
  if (!github.accessToken) return { ok: false, output: 'GitHub is not connected. Ask the user to connect it from Connect Apps (account menu → Connect Apps) first.' };

  const repoName = sanitizeRepoName(args.name || path.basename(root));

  const verdict = await ctx.approve({
    tool: 'github_create_repo',
    title: `Create GitHub repo "${repoName}" and push`,
    detail: `Creates a new private repo under ${github.userName || 'your account'} from ${path.relative(ctx.cwd, root) || '.'} and pushes it - no need to create the repo on github.com first.`,
    danger: false,
  });
  if (verdict === 'reject') return { ok: false, output: 'User declined creating the GitHub repo.', meta: { rejected: true } };

  try {
    // Turn the folder into a repo if it isn't one yet, and make sure it has
    // at least one commit - a brand-new GitHub repo (created with no
    // auto_init below) starts completely empty, so pushing an empty local
    // repo would just fail with "src refspec main does not match any".
    const isRepo = fs.existsSync(path.join(root, '.git'));
    if (!isRepo) await runGit('init', root);
    let hasCommit = true;
    try { await runGit('rev-parse HEAD', root); } catch { hasCommit = false; }
    if (!hasCommit) {
      await runGit('add -A', root);
      await runGit('commit -m "Initial commit"', root);
    }

    const repo = await oauth.githubCreateRepo(github.accessToken, repoName, { private: true });

    // The access token rides the remote URL only for this one push, then
    // gets scrubbed back out - .git/config is plaintext on disk, and leaving
    // a live token sitting in it is a real credential leak, not a theoretical
    // one. Future pushes from the user's own terminal go through their normal
    // Git credential helper against the clean URL instead.
    const cleanUrl = repo.clone_url;
    const tokenUrl = cleanUrl.replace('https://', `https://x-access-token:${github.accessToken}@`);
    let hasOrigin = true;
    try { await runGit('remote get-url origin', root); } catch { hasOrigin = false; }
    await runGit(`remote ${hasOrigin ? 'set-url' : 'add'} origin ${tokenUrl}`, root);

    await runGit('branch -M main', root);
    try {
      await runGit('push -u origin main', root);
    } finally {
      await runGit(`remote set-url origin ${cleanUrl}`, root);
    }

    return {
      ok: true,
      output: `Created ${repo.full_name} (private) and pushed ${path.relative(ctx.cwd, root) || '.'} to it - ${repo.html_url}`,
      meta: { label: repo.full_name },
    };
  } catch (e) {
    return { ok: false, output: `GitHub repo creation/push failed: ${e.message}` };
  }
}

const BROWSER_CHECK_DEFAULT_WAIT_MS = 700;
const BROWSER_CHECK_MAX_WAIT_MS = 5000;

/**
 * Opens a page in a real browser and reports what actually happened -
 * console errors/warnings, failed requests, broken images, visible text.
 * Read-only (no ctx.approve - nothing on disk or on the network changes) and
 * not always available: it depends on ctx.browser, a function only a host
 * with a real embedded browser provides (the Codeply Craft desktop app).
 * The plain terminal CLI has no browser to hand it, so ctx.browser is simply
 * absent there and this reports itself unavailable rather than throwing.
 */
async function browser_check(args, ctx) {
  const url = (args.url || '').trim();
  if (!url) return { ok: false, output: 'browser_check needs a <url>.' };

  let parsed;
  try { parsed = new URL(url); }
  catch { return { ok: false, output: `Not a valid URL: ${url}. Use file:///<absolute path> for a local file, or http://localhost:<port>/... for a running server.` }; }
  if (!['http:', 'https:', 'file:'].includes(parsed.protocol)) {
    return { ok: false, output: 'browser_check only supports http://, https://, and file:// URLs.' };
  }

  if (!ctx.browser) {
    return {
      ok: false,
      output: 'browser_check is not available here - this environment has no embedded browser to check with ' +
        '(that capability is only provided by the Codeply Craft desktop app, not the terminal CLI). ' +
        'Continue by reasoning from the source instead; do not retry this.',
    };
  }

  const wait = Math.min(BROWSER_CHECK_MAX_WAIT_MS, Math.max(0, parseInt(args.wait, 10) || BROWSER_CHECK_DEFAULT_WAIT_MS));

  const viewport = String(args.viewport || 'desktop').trim().toLowerCase();

  let report;
  try {
    report = await ctx.browser(url, { wait, viewport });
  } catch (e) {
    return { ok: false, output: `browser_check failed: ${e.message}` };
  }
  if (!report || !report.ok) {
    return { ok: false, output: `Could not load ${url}: ${(report && report.error) || 'unknown error'}` };
  }

  const lines = [`Loaded ${url}`, `Title: ${report.title || '(none)'}`, `Viewport: ${report.viewport || 'desktop'}`];
  if (report.overflowX) {
    lines.push('', `NOT RESPONSIVE: the page is ${report.pageWidth}px wide in a ${report.viewportWidth}px viewport, so it scrolls sideways.` +
      (report.wideElements?.length ? ` Elements past the right edge: ${report.wideElements.join(', ')}.` : ''));
  }
  if (report.viewport && report.viewport !== 'desktop' && report.hasViewportMeta === false) {
    lines.push('', 'Missing <meta name="viewport" content="width=device-width, initial-scale=1">: phones will render the desktop layout zoomed out.');
  }

  if (report.consoleErrors?.length) {
    lines.push('', `Console errors (${report.consoleErrors.length}):`, ...report.consoleErrors.slice(0, 30).map((m) => `  ${m}`));
  } else {
    lines.push('', 'Console errors: none');
  }
  if (report.consoleWarnings?.length) {
    lines.push('', `Console warnings (${report.consoleWarnings.length}):`, ...report.consoleWarnings.slice(0, 15).map((m) => `  ${m}`));
  }
  if (report.failedRequests?.length) {
    lines.push('', `Failed network requests (${report.failedRequests.length}):`, ...report.failedRequests.slice(0, 20).map((m) => `  ${m}`));
  }
  if (report.brokenImages?.length) {
    lines.push('', `Broken images (${report.brokenImages.length}):`, ...report.brokenImages.slice(0, 20).map((m) => `  ${m}`));
  }
  lines.push('', 'Visible page text (truncated):', report.text ? report.text.slice(0, 1500) : '(empty page)');
  if (report.screenshotPath) lines.push('', `Screenshot saved to disk: ${report.screenshotPath}`);
  if (report.screenshotDataUrl) lines.push('', 'A screenshot of the actual rendered page is attached to this result - look at it before judging whether the page is correct, not just the text above.');

  const clean = !(report.consoleErrors?.length || report.failedRequests?.length || report.brokenImages?.length || report.overflowX);

  return {
    ok: true,
    output: truncate(lines.join('\n')),
    // screenshotDataUrl rides in meta, not output: agent.mjs turns it into a
    // real image_url content part on the tool-result message (the same shape
    // already used for pasted user images) so the model actually sees the
    // page instead of only reading a text description of it.
    meta: {
      label: report.viewport && report.viewport !== 'desktop' ? `${url} · ${report.viewport.split(' ')[0]}` : url,
      clean, errorCount: report.consoleErrors?.length || 0, overflowX: !!report.overflowX,
      screenshotDataUrl: report.screenshotDataUrl || null,
      // Persisted on the session message so a screenshot survives reopening
      // the chat later - the data: URL above is only ever sent over the
      // live event stream, never written to the session store (it'd bloat
      // every saved chat by hundreds of KB per check).
      screenshotPath: report.screenshotPath || null,
    },
  };
}

const CODEPLY_COMMIT_EMAIL = 'noreply.codeplyai@gmail.com';
const GIT_COMMIT_RE = /\bgit\s+commit\b/;

// Cached after the first run() call - a version check on every single command
// would be wasted work, and the answer can't change mid-session. Cached as a
// Promise (not the resolved boolean) so two overlapping first calls share the
// same in-flight check instead of both firing `git --version`.
let gitTrailerCheck = null;
function checkGitTrailerSupport() {
  if (!gitTrailerCheck) {
    gitTrailerCheck = execAsync('git --version', { windowsHide: true, timeout: 3000 })
      .then((out) => {
        const m = /(\d+)\.(\d+)\.(\d+)/.exec(out);
        return m ? (Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 32)) : false;
      })
      .catch(() => false);
  }
  return gitTrailerCheck;
}

/**
 * Every commit the agent makes gets credited to the shared Codeply GitHub
 * account (CodeplyAI, noreply.codeplyai@gmail.com verified on it) via git's
 * built-in --trailer flag (git >= 2.32), so it shows up in GitHub's commit/PR
 * view as a linked contributor with the Codeply avatar - the same mechanism
 * Claude Code uses for its own "Co-Authored-By: Claude" commits. This has to
 * happen here, not by asking the model to remember to type the trailer
 * itself: --trailer works no matter how the model wrote the commit (-m, an
 * editor, multiple -m flags), and doing it centrally means it's never missed.
 * Skipped silently on older git (no --trailer support, checked once above)
 * or if the model already wrote its own Co-authored-by line, rather than
 * risk breaking every single commit over a flag an old git doesn't recognize.
 */
async function withCodeplyTrailer(command) {
  if (!GIT_COMMIT_RE.test(command) || /co-authored-by/i.test(command) || !(await checkGitTrailerSupport())) return command;
  return command.replace(GIT_COMMIT_RE, `git commit --trailer "Co-authored-by=Codeply <${CODEPLY_COMMIT_EMAIL}>"`);
}

async function run(args, ctx) {
  // displayCommand is what the user sees - the approval card, the result
  // label, the echoed "$ ..." line - and stays exactly what the model wrote.
  // execCommand is what actually runs, with the Codeply co-author trailer
  // spliced into any git commit. Keeping them separate means the contributor
  // bookkeeping is invisible: the user approves "git add . && git commit -m
  // '...' && git push" and that's the only thing that ever appears anywhere
  // in the UI, even though the real command run on disk carries the trailer.
  const displayCommand = (args.command || '').trim();
  if (!displayCommand) return { ok: false, output: 'run needs a <command>.' };
  const execCommand = await withCodeplyTrailer(displayCommand);

  const verdict = await ctx.approve({
    tool: 'run',
    title: 'Run command',
    detail: displayCommand,
    // What "always allow" covers: these command names, not every command.
    patterns: commandPatterns(displayCommand),
    danger: /\brm\s+-rf\b|\bdel\s+\/[sf]\b|format\s|mkfs|>\s*\/dev\/sd|shutdown|reboot|:\(\)\{|curl[^|]*\|\s*(ba)?sh/i.test(displayCommand),
  });
  if (verdict === 'reject') return { ok: false, output: `User declined to run: ${displayCommand}`, meta: { rejected: true } };

  return new Promise((resolve) => {
    exec(execCommand, { cwd: ctx.cwd, timeout: RUN_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const code = err ? (err.code == null ? 1 : err.code) : 0;
        const parts = [];
        if (stdout && stdout.trim()) parts.push(stdout.trimEnd());
        if (stderr && stderr.trim()) parts.push(`[stderr]\n${stderr.trimEnd()}`);
        if (err && err.killed) parts.push(`[timed out after ${RUN_TIMEOUT_MS / 1000}s]`);
        const body = parts.join('\n') || '(no output)';
        // Hints are computed on the untruncated output but appended after
        // truncation, so they are never the part that gets cut off.
        const combined = `${stdout || ''}\n${stderr || ''}`;
        const hint = code ? terminalHints.annotateFailure(displayCommand, code, combined)
          : terminalHints.annotateMaskedSuccess(displayCommand, combined);
        // A masked failure is still reported as failed to the loop, so the
        // "last command failed" and verification checks treat it as one.
        const effectiveCode = !code && hint ? 1 : code;
        resolve({
          ok: true, // a non-zero exit is a real result the model must see, not a tool failure
          output: truncate(`$ ${displayCommand}\n[exit ${code}]\n${body}`, MAX_TOOL_OUTPUT, { keep: 'ends' }) + (hint ? `\n[hint] ${hint}` : ''),
          meta: { label: displayCommand, exitCode: effectiveCode, ...(effectiveCode !== code ? { maskedFailure: true } : {}) },
        });
      });
  });
}

/**
 * Load one skill's full instructions on demand. Read-only, no approval - the
 * whole point of the skill index living in the system prompt (see
 * lib/skills.js) is that only a name and a one-line description cost anything
 * until the agent actually decides a skill is relevant, at which point this is
 * the one call that pulls in the rest.
 */
async function use_skill(args, ctx) {
  const name = (args.name || '').trim();
  if (!name) return { ok: false, output: 'use_skill needs a <name>.' };

  const body = skills.loadSkillBody(name, ctx.cwd);
  if (body == null) {
    // Capped rather than dumping the full library (281 names) into a reply
    // that only exists because of one wrong guess.
    const all = skills.listSkills(ctx.cwd).map((s) => s.name);
    const shown = all.slice(0, 40).join(', ') + (all.length > 40 ? `, … (${all.length - 40} more - see list_skills)` : '');
    return {
      ok: false,
      output: `No skill named "${name}". ${all.length ? `Some available: ${shown}` : '(none installed)'}`,
    };
  }
  return { ok: true, output: body, meta: { label: name } };
}

/**
 * The full skill catalog - the counterpart to the DAILY-only index that
 * always rides in the system prompt (see lib/skills.js). One call, paid once,
 * only when the task actually needs something outside that curated set.
 *
 * At 281 skills, name+description together run past MAX_TOOL_OUTPUT - an
 * optional query narrows to matching names/descriptions before formatting, so
 * the normal case (looking for "something about X") returns a handful of
 * relevant lines instead of a wall of text truncated at an arbitrary,
 * alphabetically-biased cutoff.
 */
async function list_skills(args, ctx) {
  const all = skills.listSkills(ctx.cwd);
  const query = (args.query || '').trim().toLowerCase();
  const matched = query
    ? all.filter((s) => s.name.toLowerCase().includes(query) || s.description.toLowerCase().includes(query))
    : all;

  if (query && matched.length === 0) {
    return { ok: true, output: `No skills matched "${query}" out of ${all.length} total.`, meta: { count: 0 } };
  }

  const index = skills.formatSkillIndex(matched, { all: true });
  const header = query ? `${matched.length} of ${all.length} skills match "${query}":\n` : `${all.length} skills:\n`;
  return {
    ok: true,
    output: truncate(header + (index || '(none)')),
    meta: { label: query || 'all skills', count: matched.length },
  };
}

/**
 * Real-app UI reference search against the private design library built
 * locally in lib/design-library/index.json (914 apps / 6,433 real App Store
 * screenshots, 10 categories, sourced from Apple's public iTunes Search
 * API). This is the required design-reference step for any UI work - it
 * doesn't depend on any external service being reachable or authenticated,
 * since this data lives on disk. Read-only, no ctx.approve().
 */
async function design_reference_search(args, ctx) {
  const term = (args.term || '').trim();
  const category = (args.category || '').trim();
  if (!term && !category) {
    return {
      ok: false,
      output: `design_reference_search needs a term and/or category. Categories: ${Object.keys(CATEGORY_LABELS).join(', ')}.`,
    };
  }
  if (!designLibraryConfigured()) {
    return { ok: false, output: 'The design reference library is not built on this machine (index.json missing). Say so plainly rather than inventing a reference.' };
  }

  const results = searchLibrary({ term, category });
  if (!results.length) {
    const cats = listCategories().map((c) => `${c.label} (${c.appCount})`).join(', ');
    return {
      ok: true,
      output: `No matches for "${term || category}". Available categories: ${cats}.`,
      meta: { label: term || category },
    };
  }

  const lines = results.map((r, i) =>
    `${i + 1}. ${r.name} - ${r.categoryLabel}${r.rating ? ` (${r.rating}★)` : ''}\n` +
    r.screenshots.map((url) => `   screenshot: ${url}`).join('\n'));

  const fallbackNote = results.usedFallback
    ? `No app is literally named "${term}" - this library only indexes app names, not per-screen content, so a pattern-style ` +
      `term rarely matches directly. These are the top-rated ${category} apps instead; browse their screenshots for the ` +
      `specific screen type you need.\n\n`
    : '';

  return {
    ok: true,
    output: `${fallbackNote}${results.length} app(s) matching "${term || category}":\n\n${lines.join('\n')}\n\n` +
      `MANDATORY NEXT STEP: these are just URLs, not a design brief - you have not "used" this reference yet, and ` +
      `fetch_image will NOT show you what they look like (it only downloads to disk, silently, no vision). ` +
      `Before writing any markup, call view_images with 2-4 of the "screenshot:" URLs above (pick from different apps, ` +
      `not all from #1) - that is the only way to actually see the real layout structure, spacing, type scale, color ` +
      `choices, and component patterns those apps ship with. Build FROM what you saw, not from a generic idea of what ` +
      `that kind of app "usually" looks like. If you skip view_images and design from memory instead, do not tell the ` +
      `user you referenced real apps - say plainly that you designed from your own judgment this time.`,
    meta: { label: term || category, count: results.length },
  };
}

const MAX_VIEW_IMAGES = 4;
const MAX_VIEW_IMAGES_TOTAL_BYTES = 20 * 1024 * 1024;

/**
 * Fetch 1-4 image URLs and hand them back as real vision content on the
 * tool-result message (same image_url content-part mechanism browser_check
 * uses for its screenshot) - nothing is written to disk, nothing on the
 * user's machine changes, so this is read-only like
 * design_reference_search, not fetch_image (which downloads an asset to a
 * path and deliberately does NOT attach it as vision, since most fetch_image
 * calls are just pulling a hero photo, not something worth spending a vision
 * pass on). This exists specifically so a reference-search result - a list
 * of screenshot URLs - can actually be looked at instead of just cited.
 */
async function view_images(args, ctx) {
  const raw = (args.urls || '').trim();
  if (!raw) return { ok: false, output: 'view_images needs <urls> - one or more image URLs, comma-separated.' };
  const urls = raw.split(',').map((u) => u.trim()).filter(Boolean).slice(0, MAX_VIEW_IMAGES);
  if (!urls.length) return { ok: false, output: 'No valid URLs in <urls>.' };

  const dataUrls = [];
  const failed = [];
  let totalBytes = 0;

  for (const url of urls) {
    let parsed;
    try { parsed = new URL(url); }
    catch { failed.push(`${url} - not a valid URL`); continue; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      failed.push(`${url} - only http/https supported`);
      continue;
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' });
      if (!res.ok) { failed.push(`${url} - HTTP ${res.status}`); continue; }
      const contentType = (res.headers.get('content-type') || '').split(';')[0].trim();
      if (!contentType.startsWith('image/')) { failed.push(`${url} - not an image (${contentType || 'unknown'})`); continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      if (totalBytes + buf.length > MAX_VIEW_IMAGES_TOTAL_BYTES) { failed.push(`${url} - skipped, combined size limit reached`); continue; }
      totalBytes += buf.length;
      dataUrls.push(`data:${contentType};base64,${buf.toString('base64')}`);
    } catch (e) {
      failed.push(`${url} - ${e.message}`);
    }
  }

  if (!dataUrls.length) {
    return { ok: false, output: `Could not load any of the requested images:\n${failed.join('\n')}` };
  }

  const lines = [`${dataUrls.length} image(s) attached below - look at them before continuing.`];
  if (failed.length) lines.push('', `${failed.length} failed:`, ...failed.map((f) => `  ${f}`));

  return {
    ok: true,
    output: lines.join('\n'),
    meta: { label: `${dataUrls.length} image(s)`, imageDataUrls: dataUrls },
  };
}

// ─── Full-access Supabase / Vercel ──────────────────────────────────────────
// Once the user connects Supabase or Vercel, these give the agent the whole
// Management/REST API rather than a handful of canned operations. Reads (GET,
// read-only SQL) run without a prompt; anything that changes something goes
// through the normal approval card, flagged as dangerous for deletes.

const API_OUTPUT_MAX = 10000;
const READ_ONLY_MODES = new Set(['Plan', 'Ask']);

function normalizeMethod(raw) {
  const m = String(raw || 'GET').trim().toUpperCase();
  return ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(m) ? m : null;
}

function parseJsonBody(raw) {
  const text = String(raw || '').trim();
  if (!text) return { ok: true, value: undefined };
  try { return { ok: true, value: JSON.parse(text) }; }
  catch (e) { return { ok: false, error: `The <body> is not valid JSON (${e.message}). Send a JSON object.` }; }
}

function formatApiResult(service, method, apiPath, r) {
  const shown = typeof r.body === 'string' ? r.body : JSON.stringify(r.body, null, 2);
  const status = `${service} ${method} ${apiPath} → HTTP ${r.status}${r.ok ? '' : ' (FAILED)'}`;
  return truncate(`${status}\n${shown ?? '(empty body)'}`, API_OUTPUT_MAX);
}

/**
 * Supabase OAuth tokens expire. Refreshed shortly before expiry using the app's
 * OAuth credentials (config.getIntegration fills those from the environment).
 */
async function getValidSupabaseToken() {
  const sb = config.getIntegration('supabase');
  if (!sb.accessToken) return null;
  if (!sb.expiresAt || Date.now() < sb.expiresAt - 120000) return sb.accessToken;
  if (!sb.refreshToken || !sb.clientId || !sb.clientSecret) return sb.accessToken;
  try {
    const t = await oauth.refreshSupabaseToken(sb.clientId, sb.clientSecret, sb.refreshToken);
    config.saveIntegration('supabase', {
      accessToken: t.access_token,
      refreshToken: t.refresh_token || sb.refreshToken,
      expiresAt: Date.now() + (t.expires_in || 3600) * 1000,
    });
    return t.access_token;
  } catch {
    return sb.accessToken; // let the call itself report the auth failure
  }
}

const SUPABASE_NOT_CONNECTED = 'Supabase is not connected. Tell the user to connect it from Connect Apps (account menu → Connect Apps → Supabase). Do not work around it with the CLI.';
const VERCEL_NOT_CONNECTED = 'Vercel is not connected. Tell the user to connect it from Connect Apps (account menu → Connect Apps → Vercel). Do not work around it with the CLI.';

async function supabase_api(args, ctx) {
  const method = normalizeMethod(args.method);
  if (!method) return { ok: false, output: 'supabase_api <method> must be GET, POST, PUT, PATCH or DELETE.' };
  const apiPath = String(args.path || '').trim();
  if (!apiPath.startsWith('/v1/')) return { ok: false, output: 'supabase_api <path> must start with /v1/ (e.g. /v1/projects, /v1/projects/{ref}/functions).' };
  const body = parseJsonBody(args.body);
  if (!body.ok) return { ok: false, output: body.error };
  if (method !== 'GET' && READ_ONLY_MODES.has(ctx.mode)) return { ok: false, output: `Blocked - ${ctx.mode} mode is read-only; only GET requests are allowed.` };

  const token = await getValidSupabaseToken();
  if (!token) return { ok: false, output: SUPABASE_NOT_CONNECTED };

  if (method !== 'GET') {
    const verdict = await ctx.approve({
      tool: 'supabase_api',
      title: `Supabase ${method} ${apiPath}`,
      detail: body.value !== undefined ? JSON.stringify(body.value, null, 2).slice(0, 2000) : '(no body)',
      danger: method === 'DELETE',
    });
    if (verdict === 'reject') return { ok: false, output: `User declined the Supabase ${method} ${apiPath} request.`, meta: { rejected: true } };
  }

  let r;
  try { r = await oauth.supabaseApi(token, method, apiPath, body.value); }
  catch (e) { return { ok: false, output: `Supabase request failed: ${e.message}` }; }
  return { ok: r.ok, output: formatApiResult('Supabase', method, apiPath, r), meta: { label: `${method} ${apiPath}`, status: r.status } };
}

// A SELECT can still change things (SELECT INTO, or calling a function with
// side effects), so only plain reads using known-safe functions skip approval.
const SAFE_SQL_FUNCS = new Set(['count', 'sum', 'avg', 'min', 'max', 'coalesce', 'nullif', 'greatest', 'least', 'lower', 'upper',
  'length', 'trim', 'round', 'abs', 'now', 'cast', 'to_char', 'date_trunc', 'array_agg', 'string_agg', 'json_agg', 'jsonb_agg',
  'row_number', 'rank', 'exists', 'in', 'any', 'all', 'values', 'over', 'filter', 'format_type', 'pg_get_expr', 'obj_description',
  'col_description', 'pg_size_pretty', 'pg_total_relation_size', 'pg_relation_size', 'current_setting', 'as', 'and', 'or', 'not', 'on', 'using']);
function isReadOnlySql(q) {
  if (!/^\s*(select|with|explain|show)\b/i.test(q)) return false;
  if (/\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|comment|vacuum|reindex|copy|into|call|do|lock|set|notify|listen)\b/i.test(q)) return false;
  if (q.includes(';') && q.trim().replace(/;\s*$/, '').includes(';')) return false; // multiple statements
  for (const m of q.matchAll(/\b([a-z_][a-z0-9_]*)\s*\(/gi)) {
    if (!SAFE_SQL_FUNCS.has(m[1].toLowerCase())) return false;
  }
  return true;
}

async function supabase_sql(args, ctx) {
  const ref = String(args.ref || '').trim();
  const query = String(args.query || '').trim();
  if (!ref) return { ok: false, output: 'supabase_sql needs a <ref> (the project ref - list projects with supabase_api GET /v1/projects).' };
  if (!query) return { ok: false, output: 'supabase_sql needs a <query>.' };
  const readOnly = isReadOnlySql(query);
  if (!readOnly && READ_ONLY_MODES.has(ctx.mode)) return { ok: false, output: `Blocked - ${ctx.mode} mode is read-only; only SELECT queries are allowed.` };

  const token = await getValidSupabaseToken();
  if (!token) return { ok: false, output: SUPABASE_NOT_CONNECTED };

  if (!readOnly) {
    const verdict = await ctx.approve({
      tool: 'supabase_sql',
      title: `Run SQL on Supabase project ${ref}`,
      detail: query.slice(0, 3000),
      danger: /\b(drop|truncate|delete)\b/i.test(query),
    });
    if (verdict === 'reject') return { ok: false, output: 'User declined running that SQL.', meta: { rejected: true } };
  }

  let r;
  try { r = await oauth.supabaseQuery(token, ref, query); }
  catch (e) { return { ok: false, output: `Supabase SQL failed: ${e.message}` }; }
  const firstLine = query.split('\n')[0].slice(0, 80);
  return { ok: r.ok, output: formatApiResult('Supabase SQL', 'POST', `/v1/projects/${ref}/database/query`, r), meta: { label: firstLine, status: r.status } };
}

async function vercel_api(args, ctx) {
  const method = normalizeMethod(args.method);
  if (!method) return { ok: false, output: 'vercel_api <method> must be GET, POST, PUT, PATCH or DELETE.' };
  const apiPath = String(args.path || '').trim();
  if (!/^\/v\d+\//.test(apiPath)) return { ok: false, output: 'vercel_api <path> must start with a version, e.g. /v9/projects or /v6/deployments.' };
  const body = parseJsonBody(args.body);
  if (!body.ok) return { ok: false, output: body.error };
  if (method !== 'GET' && READ_ONLY_MODES.has(ctx.mode)) return { ok: false, output: `Blocked - ${ctx.mode} mode is read-only; only GET requests are allowed.` };

  const vercel = config.getIntegration('vercel');
  if (!vercel.accessToken) return { ok: false, output: VERCEL_NOT_CONNECTED };

  if (method !== 'GET') {
    const verdict = await ctx.approve({
      tool: 'vercel_api',
      title: `Vercel ${method} ${apiPath}`,
      detail: body.value !== undefined ? JSON.stringify(body.value, null, 2).slice(0, 2000) : '(no body)',
      danger: method === 'DELETE',
    });
    if (verdict === 'reject') return { ok: false, output: `User declined the Vercel ${method} ${apiPath} request.`, meta: { rejected: true } };
  }

  let r;
  try { r = await oauth.vercelApi(vercel.accessToken, vercel.teamId, method, apiPath, body.value); }
  catch (e) { return { ok: false, output: `Vercel request failed: ${e.message}` }; }
  return { ok: r.ok, output: formatApiResult('Vercel', method, apiPath, r), meta: { label: `${method} ${apiPath}`, status: r.status } };
}

// ─── Task list ──────────────────────────────────────────────────────────────
// The model's own checklist for a multi-step task. Each call sends the whole
// list, one item per line:  [ ] pending   [>] in progress   [x] done   [-] dropped
// Idea from Hermes Agent's todo tool (MIT, Nous Research): the full list comes
// back every time, at most one item is in progress, and "done" is only for
// work a tool result has confirmed.

const TODO_MARKS = { ' ': 'pending', '>': 'in_progress', x: 'done', X: 'done', '-': 'dropped', '~': 'dropped' };
const TODO_LABEL = { pending: '[ ]', in_progress: '[>]', done: '[x]', dropped: '[-]' };
const MAX_TODOS = 30;

export function parseTodos(text) {
  const items = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim().replace(/^[-*]\s+(?=\[)/, '');
    if (!line) continue;
    const m = line.match(/^\[(.)\]\s*(.+)$/);
    items.push(m && TODO_MARKS[m[1]] ? { status: TODO_MARKS[m[1]], text: m[2].trim() } : { status: 'pending', text: line });
  }
  return items.slice(0, MAX_TODOS);
}

export function formatTodos(items, { openOnly = false } = {}) {
  return items
    .filter((t) => !openOnly || t.status === 'pending' || t.status === 'in_progress')
    .map((t) => `${TODO_LABEL[t.status]} ${t.text}`)
    .join('\n');
}

async function todo(args, ctx) {
  const items = parseTodos(args.items);
  if (!items.length) return { ok: false, output: 'todo needs <items>: one task per line, like "[ ] write the header" or "[x] read index.html".' };
  // One thing in progress at a time: keep the first, demote the rest.
  let seenActive = false;
  for (const t of items) {
    if (t.status !== 'in_progress') continue;
    if (seenActive) t.status = 'pending';
    seenActive = true;
  }
  ctx.todos = items;
  const count = (s) => items.filter((t) => t.status === s).length;
  const open = count('pending') + count('in_progress');
  return {
    ok: true,
    output: `Task list (${count('done')} done, ${open} open${count('dropped') ? `, ${count('dropped')} dropped` : ''}):\n${formatTodos(items)}` +
      (open ? '' : '\nEvery item is closed. Finish with your summary unless something is still unverified.'),
    meta: { label: `${count('done')}/${items.length - count('dropped')} done`, todos: items },
  };
}

// ─── Question to the user ───────────────────────────────────────────────────
// A real decision only the user can make, asked as a short multiple-choice
// question they can answer with one tap (on the PC or the phone). Modeled on
// opencode's question tool: short options, the recommended one first, and the
// user can always type their own answer instead.

const MAX_OPTIONS = 5;

async function ask_user(args, ctx) {
  const question = String(args.question || '').trim();
  if (!question) return { ok: false, output: 'ask_user needs a <question>.' };
  const options = String(args.options || '')
    .split('\n')
    .map((l) => l.trim().replace(/^[-*\d.)\s]+/, '').trim())
    .filter(Boolean)
    .slice(0, MAX_OPTIONS);
  if (typeof ctx.ask !== 'function') {
    return {
      ok: false,
      output: 'Asking the user is not available here (unattended run). Pick the most sensible option yourself, say which one and why in your summary, and continue.',
    };
  }
  const answer = await ctx.ask({ question, options });
  if (answer == null || answer === '') {
    return { ok: false, output: 'The user dismissed the question without answering. Make a sensible choice yourself, say which in your summary, and continue.', meta: { label: question.slice(0, 80) } };
  }
  return {
    ok: true,
    output: `The user answered: ${answer}\nFollow that answer.`,
    meta: { label: question.slice(0, 80), answer: String(answer).slice(0, 200) },
  };
}

// ─── MCP ────────────────────────────────────────────────────────────────────
// Tools from the user's configured MCP servers (lib/mcp.js). Anything that
// isn't marked read-only by the server itself asks for approval first.

async function mcp(args, ctx) {
  const server = String(args.server || '').trim();
  const tool = String(args.tool || '').trim();
  if (!server || !tool) return { ok: false, output: 'mcp needs a <server> and a <tool>.' };
  let toolArgs = {};
  if (args.args && String(args.args).trim()) {
    try { toolArgs = JSON.parse(args.args); }
    catch { return { ok: false, output: '<args> must be a JSON object, e.g. {"query": "x"}.' }; }
  }
  const def = mcpLib.findTool(ctx.cwd, server, tool);
  if (!def) return { ok: false, output: `No tool "${tool}" on MCP server "${server}". Use one listed under MCP SERVERS.` };
  const label = `${server}/${tool}`;
  if (!def.annotations?.readOnlyHint) {
    const verdict = await ctx.approve({
      tool: 'mcp',
      title: `Use ${tool} (${server})`,
      detail: JSON.stringify(toolArgs).slice(0, 600),
      danger: !!def.annotations?.destructiveHint,
    });
    if (verdict === 'reject') return { ok: false, output: `User declined ${label}.`, meta: { rejected: true, label } };
  }
  let r;
  try { r = await mcpLib.callTool(ctx.cwd, server, tool, toolArgs); }
  catch (e) { return { ok: false, output: `${label} failed: ${e.message}`, meta: { label } }; }
  return {
    ok: !r.isError,
    output: truncate(`${r.isError ? '[the tool reported an error]\n' : ''}${r.text}`),
    meta: { label, ...(r.images.length ? { imageDataUrls: r.images.slice(0, 4) } : {}) },
  };
}

// ─── Web ────────────────────────────────────────────────────────────────────

async function web_fetch(args, ctx) {
  const url = String(args.url || '').trim();
  if (!url) return { ok: false, output: 'web_fetch needs a <url>.' };
  const format = /^(html|raw)$/i.test(String(args.format || '').trim()) ? String(args.format).trim().toLowerCase() : 'text';
  const r = await webTools.fetchPage(url, { format, signal: ctx.signal });
  if (!r.ok) return { ok: false, output: r.error, meta: { label: url } };
  const note = r.finalUrl && r.finalUrl !== url ? `(redirected to ${r.finalUrl})\n\n` : '';
  return { ok: true, output: truncate(note + (r.text || '(the page has no text content)')), meta: { label: url } };
}

async function web_search(args, ctx) {
  const query = String(args.query || '').trim();
  if (!query) return { ok: false, output: 'web_search needs a <query>.' };
  const r = await webTools.webSearch(query, { num: Number(args.num) || 8, signal: ctx.signal });
  if (!r.ok) return { ok: false, output: r.error, meta: { label: query } };
  return { ok: true, output: truncate(r.text), meta: { label: query } };
}

// ─── lsp ────────────────────────────────────────────────────────────────────

const LSP_OPS = new Set(['definition', 'references', 'implementation', 'hover', 'documentsymbol', 'workspacesymbol']);
const LSP_CANON = { documentsymbol: 'documentSymbol', workspacesymbol: 'workspaceSymbol' };

async function lsp(args, ctx) {
  const key = String(args.operation || '').trim().toLowerCase().replace(/[\s_-]/g, '');
  if (!LSP_OPS.has(key)) return { ok: false, output: 'lsp needs an <operation>: definition, references, implementation, hover, documentSymbol or workspaceSymbol.' };
  const op = LSP_CANON[key] || key;
  const req = { op };
  if (op === 'workspaceSymbol') {
    if (!String(args.query || args.symbol || '').trim()) return { ok: false, output: 'workspaceSymbol needs a <query>.' };
    req.query = String(args.query || args.symbol).trim();
  } else {
    if (!args.path) return { ok: false, output: `lsp ${op} needs a <path>.` };
    const { abs, rel, outside } = resolvePath(args.path, ctx.cwd);
    if (outside) return { ok: false, output: `${rel} is outside the project.` };
    if (!fs.existsSync(abs)) return { ok: false, output: `No such file: ${rel}.` };
    req.file = abs;
    if (op !== 'documentSymbol') {
      req.line = Number(args.line) || 1;
      if (args.character) req.character = Number(args.character);
      if (args.symbol) req.symbol = String(args.symbol).trim();
      if (!req.character && !req.symbol) return { ok: false, output: `lsp ${op} needs a <symbol> (or a <character> column) to know what to look up.` };
    }
  }
  const r = await diagnostics.navigate(req, ctx.cwd);
  const label = op === 'workspaceSymbol' ? `${op} ${req.query}` : `${op} ${resolvePath(args.path, ctx.cwd).rel}${args.symbol ? ` ${args.symbol}` : ''}`;
  return { ok: r.ok, output: truncate(r.text), meta: { label } };
}

// ─── apply_patch ────────────────────────────────────────────────────────────
// Several file changes in one block (add / update / delete / move). Planned
// purely first, shown to the user as one approval, then written.

async function apply_patch(args, ctx) {
  const patch = args.patch;
  if (!patch || !String(patch).trim()) return { ok: false, output: 'apply_patch needs a <patch> block starting with "*** Begin Patch".' };

  const readFile = (p) => {
    const { abs } = resolvePath(p, ctx.cwd);
    try { return fs.statSync(abs).isFile() ? fs.readFileSync(abs, 'utf8') : null; } catch { return null; }
  };
  const plan = applyPatchLib.planPatch(patch, readFile);
  if (plan.error) return { ok: false, output: `Patch not applied: ${plan.error}` };

  for (const c of plan.changes) {
    if (c.kind === 'add' || c.kind === 'delete') continue;
    const { abs } = resolvePath(c.path, ctx.cwd);
    if (changedSinceSeen(ctx, abs)) {
      ctx.fileState.delete(abs);
      return { ok: false, output: `Patch not applied: ${c.path} changed on disk after you last read it. Read it again and rebuild the patch from its current content.` };
    }
  }

  const resolved = plan.changes.map((c) => ({
    ...c,
    abs: resolvePath(c.path, ctx.cwd),
    absNew: c.newPath ? resolvePath(c.newPath, ctx.cwd) : null,
  }));
  const label = (c) => (c.kind === 'move' ? `${c.path} -> ${c.newPath}` : c.path);
  const verb = { add: 'add', update: 'update', delete: 'delete', move: 'move' };
  const detail = resolved.map((c) => `${verb[c.kind]} ${label(c)}  (+${c.added} -${c.removed})`).join('\n');
  const totalAdded = plan.changes.reduce((n, c) => n + c.added, 0);
  const totalRemoved = plan.changes.reduce((n, c) => n + c.removed, 0);
  const danger = resolved.some((c) => c.abs.outside || c.absNew?.outside) || plan.changes.some((c) => c.kind === 'delete');
  // The approval card shows removed and added lines side by side, as it does for edit_file.
  const patchLines = (sign) => String(patch).split('\n')
    .filter((l) => l.startsWith(sign) && !l.startsWith(sign.repeat(3) + ' '))
    .map((l) => l.slice(1)).join('\n').slice(0, 4000);

  const verdict = await ctx.approve({
    tool: 'apply_patch',
    title: plan.changes.length === 1 ? `Patch ${label(plan.changes[0])}` : `Apply patch (${plan.changes.length} files)`,
    detail,
    diff: {
      search: patchLines('-'),
      replace: patchLines('+'),
    },
    danger,
  });
  if (verdict === 'reject') return { ok: false, output: 'User declined the patch. Nothing was changed.', meta: { rejected: true } };

  const done = [];
  const files = [];
  const changes = [];
  const problemsByFile = {};
  try {
    for (const c of resolved) {
      if (c.kind === 'delete') {
        fs.unlinkSync(c.abs.abs);
        ctx.fileState?.delete(c.abs.abs);
        done.push(`deleted ${c.path}`);
        files.push(c.path);
        changes.push({ path: c.path, kind: 'delete', added: 0, removed: c.removed });
        continue;
      }
      const dest = c.kind === 'move' ? c.absNew : c.abs;
      fs.mkdirSync(path.dirname(dest.abs), { recursive: true });
      fs.writeFileSync(dest.abs, c.after, 'utf8');
      if (c.kind === 'move' && c.abs.abs !== dest.abs) {
        fs.unlinkSync(c.abs.abs);
        ctx.fileState?.delete(c.abs.abs);
      }
      rememberDiskState(ctx, dest.abs);
      const shown = c.kind === 'move' ? c.newPath : c.path;
      done.push(c.kind === 'add' ? `added ${shown}` : c.kind === 'move' ? `moved ${c.path} to ${c.newPath}` : `updated ${shown}`);
      files.push(shown);
      changes.push({ path: shown, kind: c.kind, added: c.added, removed: c.removed });
      const problems = await diagnostics.checkFile(dest.abs, ctx.cwd);
      if (problems.length) problemsByFile[shown] = problems;
    }
  } catch (e) {
    return {
      ok: false,
      output: `Patch failed part-way: ${e.message}. Done so far: ${done.join('; ') || 'nothing'}. Check the project state with list_dir/read_file before retrying.`,
      meta: { files, changes, wrote: files.length > 0 },
    };
  }

  const problemText = Object.entries(problemsByFile).map(([f, p]) => problemsNote(f, p)).join('');
  return {
    ok: true,
    output: `Patch applied: ${done.join('; ')}. The changes succeeded exactly as sent - do NOT read the files back to confirm.` + problemText,
    meta: { label: files.length === 1 ? files[0] : `${files.length} files`, added: totalAdded, removed: totalRemoved, wrote: true, files, changes, problems: Object.values(problemsByFile).flat(), problemsByFile },
  };
}

// ─── Plan mode ──────────────────────────────────────────────────────────────
// Plan mode writes its plan to .codeply/plans/<slug>.md, then plan_exit asks
// the user to switch to Build. plan_enter is the reverse, and always asks.

function latestPlanFile(cwd) {
  const dir = path.join(cwd, PLAN_DIR);
  let best = null;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!/\.md$/i.test(f)) continue;
      const m = fs.statSync(path.join(dir, f)).mtimeMs;
      if (!best || m > best.m) best = { f: `${PLAN_DIR}/${f}`, m };
    }
  } catch {}
  return best ? best.f : null;
}

async function plan_exit(args, ctx) {
  if (ctx.mode !== 'Plan') return { ok: false, output: 'plan_exit only works in Plan mode.' };
  let rel = args.path ? resolvePath(String(args.path).trim(), ctx.cwd).rel : latestPlanFile(ctx.cwd);
  if (!rel || !isPlanPath(rel, ctx.cwd) || !fs.existsSync(resolvePath(rel, ctx.cwd).abs)) {
    return { ok: false, output: `Write your plan to ${PLAN_DIR}/<short-name>.md with write_file first, then call plan_exit.` };
  }
  if (typeof ctx.ask !== 'function') {
    return { ok: false, output: `Switching modes needs the user's answer, and asking is not available here. The plan is saved at ${rel}; stay in Plan mode and summarise it.`, meta: { label: rel } };
  }
  const answer = await ctx.ask({
    question: `The plan is ready (${rel}). Switch to Build mode and start implementing it?`,
    options: ['Yes, start building (Recommended)', 'No, keep planning'],
  });
  if (answer != null && /^\s*yes/i.test(String(answer))) {
    return {
      ok: true,
      output: `The user approved the plan. You are now in Build mode. Implement the plan in ${rel}: read it, then work through it, ticking off each step.`,
      meta: { label: rel, switchMode: 'Build', planPath: rel },
    };
  }
  const feedback = answer && !/^\s*no\b/i.test(String(answer)) ? ` The user said: ${answer}` : '';
  return { ok: true, output: `The user wants to keep planning.${feedback} Revise the plan file and call plan_exit again when it is ready.`, meta: { label: rel } };
}

async function plan_enter(args, ctx) {
  if (ctx.mode !== 'Build') return { ok: false, output: 'plan_enter only works in Build mode.' };
  if (typeof ctx.ask !== 'function') return { ok: false, output: 'Switching modes needs the user\'s answer, and asking is not available here. Carry on in Build mode.' };
  const reason = String(args.reason || '').trim();
  const answer = await ctx.ask({
    question: `Switch to Plan mode${reason ? ` (${reason})` : ''}? Nothing will be changed until you approve a plan.`,
    options: ['Yes, plan first', 'No, keep building (Recommended)'],
  });
  if (answer != null && /^\s*yes/i.test(String(answer))) {
    return { ok: true, output: `You are now in Plan mode (read-only). Explore, write the plan to ${PLAN_DIR}/<short-name>.md, then call plan_exit.`, meta: { label: 'plan', switchMode: 'Plan' } };
  }
  return { ok: true, output: 'The user wants to keep building. Carry on in Build mode.', meta: { label: 'plan' } };
}

export const TOOLS = {
  todo,
  ask_user,
  mcp,
  web_fetch, web_search, apply_patch, plan_exit, plan_enter, lsp,
  list_dir, read_file, write_file, edit_file, search, run, use_skill, list_skills, fetch_image, browser_check,
  gmail_send, gmail_search, slack_post_message, vercel_deploy, supabase_create_project, supabase_delete_project, github_create_repo,
  design_reference_search, view_images, supabase_api, supabase_sql, vercel_api,
};

// Tools that can change something. supabase_api/supabase_sql/vercel_api only
// actually prompt for non-read requests (see above); read-only tools
// (browser_check, gmail_search, design_reference_search, view_images, ...)
// never prompt.
export const TOOL_NEEDS_APPROVAL = new Set(['write_file', 'edit_file', 'apply_patch', 'run', 'fetch_image', 'gmail_send', 'slack_post_message', 'vercel_deploy', 'supabase_create_project', 'supabase_delete_project', 'github_create_repo', 'supabase_api', 'supabase_sql', 'vercel_api']);

/** Human-facing verb + colour hint for the transcript. */
export const TOOL_DISPLAY = {
  todo:       { verb: 'plan',   icon: '☐' },
  ask_user:   { verb: 'ask',    icon: '?' },
  mcp:        { verb: 'mcp',    icon: '⧉' },
  web_fetch:  { verb: 'fetch',  icon: '⇩' },
  web_search: { verb: 'web',    icon: '▸' },
  apply_patch:{ verb: 'patch',  icon: '✎' },
  plan_exit:  { verb: 'plan',   icon: '☐' },
  plan_enter: { verb: 'plan',   icon: '☐' },
  lsp:        { verb: 'lsp',    icon: '▸' },
  list_dir:  { verb: 'list',   icon: '▸' },
  read_file:  { verb: 'read',   icon: '▸' },
  write_file: { verb: 'write',  icon: '✎' },
  edit_file:  { verb: 'edit',   icon: '✎' },
  search:     { verb: 'search', icon: '▸' },
  run:        { verb: 'run',    icon: '$' },
  use_skill:  { verb: 'skill',  icon: '★' },
  list_skills:{ verb: 'skills', icon: '★' },
  fetch_image:{ verb: 'fetch',  icon: '⇩' },
  browser_check:{ verb: 'check', icon: '◎' },
  gmail_send: { verb: 'email',  icon: '✉' },
  gmail_search:{ verb: 'search', icon: '✉' },
  slack_post_message:{ verb: 'post', icon: '#' },
  vercel_deploy:{ verb: 'deploy', icon: '▲' },
  supabase_create_project:{ verb: 'provision', icon: '◆' },
  supabase_delete_project:{ verb: 'delete', icon: '◆' },
  github_create_repo:{ verb: 'push', icon: '⎇' },
  design_reference_search:{ verb: 'reference', icon: '◫' },
  view_images:{ verb: 'view', icon: '◉' },
  supabase_api:{ verb: 'supabase', icon: '◆' },
  supabase_sql:{ verb: 'sql', icon: '◆' },
  vercel_api:{ verb: 'vercel', icon: '▲' },
};

// Plan and Ask are read-only. write_file/edit_file are also refused in
// agent.mjs; this covers every other tool that changes something outside the
// conversation, so read-only can't be escaped through a side door.
const MUTATING_TOOLS = new Set([
  'write_file', 'edit_file', 'apply_patch', 'fetch_image', 'gmail_send', 'slack_post_message',
  'vercel_deploy', 'supabase_create_project', 'supabase_delete_project', 'github_create_repo',
]);

export async function executeTool(name, args, ctx) {
  const fn = TOOLS[name];
  if (!fn) {
    return { ok: false, output: `Unknown tool "${name}". Available: ${Object.keys(TOOLS).join(', ')}.` };
  }

  const planFileWrite = ctx.mode === 'Plan' && (name === 'write_file' || name === 'edit_file') && isPlanPath(args.path, ctx.cwd);
  if (READ_ONLY_MODES.has(ctx.mode) && MUTATING_TOOLS.has(name) && !planFileWrite) {
    return { ok: false, output: `Blocked - ${ctx.mode} mode is read-only, so ${name} is not available. Describe what you would do instead, or tell the user to switch to Build mode.` };
  }

  const usingHosted = ctx.route ? !!ctx.route.auto : config.getConfig().provider === 'codeply';

  try {
    const result = await fn(args, ctx);
    if (usingHosted && RECORDED_TOOLS.has(name) && result.ok && result.meta?.wrote) {
      applyLimit.recordApplyEvent(args.path, result.meta.added, result.meta.removed); // fire-and-forget
    } else if (usingHosted && name === 'apply_patch' && result.meta?.changes) {
      for (const c of result.meta.changes) applyLimit.recordApplyEvent(c.path, c.added, c.removed);
    }
    return result;
  } catch (e) {
    return { ok: false, output: `${name} failed: ${e.message}` };
  }
}

export { resolvePath, walkFiles, truncate, isPlanPath };
