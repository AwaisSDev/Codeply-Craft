// Pull requests, for real: the project's own changes on this branch (review-desktop.js: what the
// branch changes against its base, committed or not), and its pull requests on GitHub through the
// GitHub CLI (`gh`, which the Electron app uses too; it keeps its own sign-in).
//
//   GET  /ext/prs                 { repo, branch, base, gh: { ok, error }, local: {...} | null, prs: [...] }
//   GET  /ext/prs/diff?n=N        { files: [{ path, lines: [[kind, text]] }] }   N = 0: this branch's changes
//   POST /ext/prs/merge  { n }    merges PR N (squash), then answers like GET /ext/prs
//   POST /ext/prs/create { title, body }   opens a PR from this branch
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

let C = null;
const BINARY = /\.(png|jpe?g|gif|webp|avif|ico|bmp|tiff?|psd|zip|gz|tgz|rar|7z|pdf|mp[34]|mov|webm|wav|ogg|m4a|woff2?|ttf|otf|exe|dll|so|dylib|bin|node|wasm|sqlite|db)$/i;
const MAX_FILES = 60;
const MAX_LINES = 400;

function run(cmd, args, cwd, timeout = 10000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || (err && err.message) || '').trim() });
    });
  });
}
const git = (args, cwd) => run('git', args, cwd);
const gh = (args, cwd, timeout = 15000) => run('gh', args, cwd, timeout);

/** The project the app works in: the chat's folder the engine was started in. */
const cwdOf = (url) => {
  const q = url && url.searchParams.get('cwd');
  return q && fs.existsSync(q) ? q : C.DEFAULT_CWD;
};

async function baseOf(cwd, branch) {
  const head = await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd);
  const candidates = [];
  if (head.ok && head.out.trim()) candidates.push(head.out.trim());
  candidates.push('origin/main', 'main', 'origin/master', 'master');
  for (const c of candidates) {
    if (c.replace(/^origin\//, '') === branch && !c.startsWith('origin/')) continue;
    const r = await git(['rev-parse', '--verify', '--quiet', c], cwd);
    if (r.ok && r.out.trim()) return c;
  }
  return '';
}

const ago = (iso) => {
  const t = Date.parse(iso || '');
  if (!t) return '';
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
};

function checksOf(roll) {
  const res = (Array.isArray(roll) ? roll : []).map((c) => String(c.conclusion || c.state || c.status || '').toUpperCase());
  const passed = res.filter((x) => x === 'SUCCESS' || x === 'NEUTRAL' || x === 'SKIPPED').length;
  const failed = res.filter((x) => ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED'].includes(x)).length;
  return { total: res.length, passed, failed, pending: Math.max(0, res.length - passed - failed) };
}

/** This branch's own changes against its base (commits and edits not committed yet). */
async function local(cwd) {
  const inside = await git(['rev-parse', '--is-inside-work-tree'], cwd);
  if (!inside.ok || inside.out.trim() !== 'true') return null;
  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).out.trim() || 'HEAD';
  const base = await baseOf(cwd, branch);
  let from = 'HEAD';
  if (base) {
    const mb = await git(['merge-base', base, 'HEAD'], cwd);
    if (mb.ok && mb.out.trim()) from = mb.out.trim();
  }
  const log = await git(['log', '--format=%h%x09%s%x09%cr%x09%an', '-n', '30', `${from}..HEAD`], cwd);
  const commits = log.out.split(/\r?\n/).filter(Boolean).map((l) => { const [sha, subject, when, author] = l.split('\t'); return { sha, subject, when, author }; });
  const num = await git(['diff', '--numstat', from], cwd);
  let add = 0; let del = 0; let files = 0;
  for (const line of num.out.split(/\r?\n/)) {
    const m = /^(\d+|-)\t(\d+|-)\t/.exec(line);
    if (!m) continue;
    files++; add += Number(m[1]) || 0; del += Number(m[2]) || 0;
  }
  const untracked = (await git(['ls-files', '--others', '--exclude-standard'], cwd)).out.split(/\r?\n/).filter(Boolean);
  const user = (await git(['config', 'user.name'], cwd)).out.trim();
  return { branch, base: base.replace(/^origin\//, ''), from, commits, files: files + untracked.length, add, del, author: user || (commits[0] && commits[0].author) || '' };
}

async function state(cwd) {
  const mine = await local(cwd);
  if (!mine) return { repo: false, gh: { ok: false, error: '' }, local: null, prs: [] };
  const list = await gh(['pr', 'list', '--state', 'all', '--limit', '40', '--json',
    'number,title,state,isDraft,author,headRefName,baseRefName,createdAt,mergedAt,url,additions,deletions,changedFiles,body,statusCheckRollup,reviewRequests,latestReviews'], cwd);
  let prs = []; let ghState = { ok: true, error: '' };
  if (!list.ok) {
    const e = list.err;
    ghState = { ok: false, error: /ENOENT|not found|not recognized/i.test(e) ? 'GitHub CLI (gh) isn\'t installed.' : /auth|login|token/i.test(e) ? 'Sign in to GitHub: run "gh auth login" in the terminal.' : /no git remote|not a git repository|could not determine|none of the git remotes/i.test(e) ? 'This project has no GitHub remote yet.' : e.split('\n')[0].slice(0, 200) };
  } else {
    try {
      prs = JSON.parse(list.out).map((p) => ({
        number: p.number, title: p.title, state: p.mergedAt ? 'MERGED' : (p.isDraft ? 'DRAFT' : p.state), url: p.url,
        by: (p.author && (p.author.name || p.author.login)) || '', branch: p.headRefName, base: p.baseRefName,
        age: ago(p.mergedAt || p.createdAt), add: p.additions || 0, del: p.deletions || 0, files: p.changedFiles || 0,
        body: String(p.body || '').slice(0, 8000), checks: checksOf(p.statusCheckRollup),
        reviewers: [...new Set([...(p.reviewRequests || []).map((r) => r.login || r.name), ...(p.latestReviews || []).map((r) => r.author && r.author.login)].filter(Boolean))],
      }));
    } catch (e) { ghState = { ok: false, error: e.message }; }
  }
  const mineOpen = prs.find((p) => p.branch === mine.branch && p.state !== 'MERGED' && p.state !== 'CLOSED');
  return { repo: true, branch: mine.branch, base: mine.base, gh: ghState, local: { ...mine, pr: mineOpen ? mineOpen.number : 0 }, prs };
}

/** A unified diff as files of [kind, text] lines ('+', '-', ' ', '@' for a hunk's head). */
function parseDiff(text) {
  const files = [];
  let cur = null;
  for (const line of String(text).split(/\r?\n/)) {
    const head = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (head) {
      if (files.length >= MAX_FILES) { cur = null; continue; }
      cur = { path: head[2], lines: [], more: 0 };
      files.push(cur);
      continue;
    }
    if (!cur || line === '') continue; // a context line is " ", so "" is only the text's last newline
    if (/^(index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename (from|to) |old mode|new mode)/.test(line)) continue;
    if (/^Binary files /.test(line)) { cur.lines.push([' ', 'Binary file, not shown']); continue; }
    const kind = line[0] === '@' ? '@' : line[0] === '+' ? '+' : line[0] === '-' ? '-' : ' ';
    if (cur.lines.length >= MAX_LINES) { cur.more++; continue; }
    cur.lines.push([kind, kind === '@' ? line.replace(/^@@[^@]*@@ ?/, '') || '...' : line.slice(1)]);
  }
  for (const f of files) if (f.more) f.lines.push([' ', `${f.more} more lines not shown`]);
  return files;
}

async function diffOf(cwd, n) {
  if (n > 0) {
    const r = await gh(['pr', 'diff', String(n), '--color', 'never'], cwd, 20000);
    if (!r.ok) return { files: [], error: r.err.split('\n')[0] };
    return { files: parseDiff(r.out) };
  }
  const mine = await local(cwd);
  if (!mine) return { files: [] };
  const r = await git(['diff', '-M', mine.from], cwd);
  const files = parseDiff(r.out);
  // New files git doesn't track yet, whole.
  const untracked = (await git(['ls-files', '--others', '--exclude-standard'], cwd)).out.split(/\r?\n/).filter(Boolean);
  for (const p of untracked.slice(0, Math.max(0, MAX_FILES - files.length))) {
    let lines = [[' ', 'Binary file, not shown']];
    if (!BINARY.test(p)) {
      try {
        const st = fs.statSync(path.join(cwd, p));
        if (st.size < 1e6) {
          const body = fs.readFileSync(path.join(cwd, p), 'utf8');
          if (!body.slice(0, 8000).includes('\0')) {
            const all = body.replace(/\r?\n$/, '').split(/\r?\n/);
            lines = all.slice(0, MAX_LINES).map((l) => ['+', l]);
            if (all.length > MAX_LINES) lines.push([' ', `${all.length - MAX_LINES} more lines not shown`]);
          }
        }
      } catch {}
    }
    files.push({ path: p, lines });
  }
  return { files };
}

export function start(ctx) { C = ctx; }

export async function route(ctx, req, res, url, p, reply) {
  if (!p.startsWith('/ext/prs')) return false;
  C = ctx;
  const cwd = cwdOf(url);
  try {
    if (req.method === 'GET' && p === '/ext/prs') { reply(200, await state(cwd)); return true; }
    if (req.method === 'GET' && p === '/ext/prs/diff') { reply(200, await diffOf(cwd, Number(url.searchParams.get('n')) || 0)); return true; }
    if (req.method !== 'POST') return false;
    const b = await ctx.readJson(req).catch(() => ({}));
    if (p === '/ext/prs/merge') {
      const r = await gh(['pr', 'merge', String(Number(b.n) || 0), '--squash'], cwd, 60000);
      reply(200, { ok: r.ok, error: r.ok ? '' : r.err.split('\n')[0], ...(await state(cwd)) });
      return true;
    }
    if (p === '/ext/prs/create') {
      const title = String(b.title || '').trim();
      const args = ['pr', 'create', '--body', String(b.body || '').trim() || 'Opened from Codeply.'];
      if (title) args.push('--title', title); else args.push('--fill');
      // A branch that was never pushed goes up first.
      const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).out.trim();
      if (branch && branch !== 'HEAD') await git(['push', '-u', 'origin', branch], cwd);
      const r = await gh(args, cwd, 60000);
      reply(200, { ok: r.ok, error: r.ok ? '' : r.err.split('\n')[0], url: r.ok ? r.out.trim() : '', ...(await state(cwd)) });
      return true;
    }
    return false;
  } catch (e) {
    reply(200, { ok: false, error: e.message, repo: false, gh: { ok: false, error: e.message }, local: null, prs: [] });
    return true;
  }
}
