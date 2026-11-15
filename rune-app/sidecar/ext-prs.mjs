// Pull requests, for real: the project's own changes on this branch (review-desktop.js: what the
// branch changes against its base, committed or not), and its pull requests on GitHub through the
// GitHub CLI (`gh`, which the Electron app uses too; it keeps its own sign-in).
//
//   GET  /ext/prs                 { repo, branch, base, gh: { ok, error }, local: {...} | null, prs: [...] }
//   GET  /ext/prs/diff?n=N        { files: [{ path, lines: [[kind, text]] }] }   N = 0: this branch's changes
//   POST /ext/prs/merge  { n }    merges PR N (squash), then answers like GET /ext/prs
//   POST /ext/prs/create { title, body }   opens a PR from this branch
//   POST /ext/prs/init                     git init in the project (and a first commit)
//   POST /ext/prs/clone { url }            clones a repository beside the project; answers { path }
//   POST /ext/prs/publish                  makes a private GitHub repo for the project and pushes it
//
// gh.code says what's missing, for the page's buttons: 'missing' (no GitHub CLI), 'auth' (not
// signed in), 'remote' (no GitHub remote), 'other', or '' when GitHub answered.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

let C = null;
const BINARY = /\.(png|jpe?g|gif|webp|avif|ico|bmp|tiff?|psd|zip|gz|tgz|rar|7z|pdf|mp[34]|mov|webm|wav|ogg|m4a|woff2?|ttf|otf|exe|dll|so|dylib|bin|node|wasm|sqlite|db)$/i;
const MAX_FILES = 60;
const MAX_LINES = 400;

function run(cmd, args, cwd, timeout = 10000, env = undefined) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024, env }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || (err && err.message) || '').trim() });
    });
  });
}
const git = (args, cwd, timeout) => run('git', args, cwd, timeout);

/** The GitHub CLI: on PATH, or where its Windows installer puts it (an engine started before the
 *  install doesn't see the new PATH). */
function ghPath() {
  if (process.platform !== 'win32') return 'gh';
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')]) {
    if (!base) continue;
    const exe = path.join(base, 'GitHub CLI', 'gh.exe');
    if (fs.existsSync(exe)) return exe;
  }
  return 'gh';
}
/** The GitHub sign-in the Electron app saved (Settings > Connections), for gh when gh has none
 *  of its own. */
function savedToken() {
  try { const g = C.need('config.js').getIntegration('github'); return g && g.accessToken ? g.accessToken : ''; } catch { return ''; }
}
const gh = (args, cwd, timeout = 15000) => {
  const token = !process.env.GH_TOKEN && !process.env.GITHUB_TOKEN ? savedToken() : '';
  return run(ghPath(), args, cwd, timeout, token ? { ...process.env, GH_TOKEN: token } : undefined);
};
/** What a failed gh call means, as a code and a sentence. */
function ghProblem(e) {
  if (/ENOENT|not found|not recognized/i.test(e)) return { code: 'missing', error: 'The GitHub CLI (gh) isn\'t installed.' };
  if (/auth|login|token|credentials/i.test(e)) return { code: 'auth', error: 'Sign in to GitHub to see pull requests.' };
  if (/no git remote|could not determine|none of the git remotes|not a git repository/i.test(e)) return { code: 'remote', error: 'This project has no GitHub remote yet.' };
  return { code: 'other', error: e.split('\n')[0].slice(0, 200) };
}

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
  const where = { cwd, name: path.basename(cwd) || cwd };
  if (!mine) return { ...where, repo: false, gh: { ok: false, error: '', code: '' }, local: null, prs: [] };
  const remote = (await git(['remote'], cwd)).out.trim() !== '';
  if (!remote) return { ...where, repo: true, remote, branch: mine.branch, base: mine.base, gh: { ok: false, ...ghProblem('no git remote') }, local: { ...mine, pr: 0 }, prs: [] };
  const list = await gh(['pr', 'list', '--state', 'all', '--limit', '40', '--json',
    'number,title,state,isDraft,author,headRefName,baseRefName,createdAt,mergedAt,url,additions,deletions,changedFiles,body,statusCheckRollup,reviewRequests,latestReviews'], cwd);
  let prs = []; let ghState = { ok: true, error: '', code: '' };
  if (!list.ok) {
    ghState = { ok: false, ...ghProblem(list.err) };
  } else {
    try {
      prs = JSON.parse(list.out).map((p) => ({
        number: p.number, title: p.title, state: p.mergedAt ? 'MERGED' : (p.isDraft ? 'DRAFT' : p.state), url: p.url,
        by: (p.author && (p.author.name || p.author.login)) || '', branch: p.headRefName, base: p.baseRefName,
        age: ago(p.mergedAt || p.createdAt), add: p.additions || 0, del: p.deletions || 0, files: p.changedFiles || 0,
        body: String(p.body || '').slice(0, 8000), checks: checksOf(p.statusCheckRollup),
        reviewers: [...new Set([...(p.reviewRequests || []).map((r) => r.login || r.name), ...(p.latestReviews || []).map((r) => r.author && r.author.login)].filter(Boolean))],
      }));
    } catch (e) { ghState = { ok: false, error: e.message, code: 'other' }; }
  }
  const mineOpen = prs.find((p) => p.branch === mine.branch && p.state !== 'MERGED' && p.state !== 'CLOSED');
  return { ...where, repo: true, remote, branch: mine.branch, base: mine.base, gh: ghState, local: { ...mine, pr: mineOpen ? mineOpen.number : 0 }, prs };
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
    if (p === '/ext/prs/init') {
      const r = await git(['init'], cwd);
      if (!r.ok) { reply(200, { ok: false, error: r.err.split('\n')[0], ...(await state(cwd)) }); return true; }
      // A first commit when there's something to commit and git knows who you are.
      await git(['add', '-A'], cwd, 60000);
      await git(['commit', '-m', 'Initial commit'], cwd, 60000);
      reply(200, { ok: true, error: '', ...(await state(cwd)) });
      return true;
    }
    if (p === '/ext/prs/clone') {
      const src = String(b.url || '').trim();
      if (!src) { reply(200, { ok: false, error: 'Paste a repository URL, like https://github.com/you/app.' }); return true; }
      const name = (src.replace(/\.git$/, '').split(/[/:\\]/).filter(Boolean).pop() || 'project').replace(/[^\w.-]/g, '-');
      // Beside the project (an empty default project folder holds the clone instead).
      const empty = (() => { try { return fs.readdirSync(cwd).filter((n) => !n.startsWith('.')).length === 0; } catch { return false; } })();
      const parent = empty ? cwd : path.dirname(cwd) || os.homedir();
      let dest = path.join(parent, name);
      for (let i = 2; fs.existsSync(dest); i++) dest = path.join(parent, `${name}-${i}`);
      const owned = /^[\w.-]+\/[\w.-]+$/.test(src);
      const r = owned ? await gh(['repo', 'clone', src, dest], parent, 300000) : await git(['clone', src, dest], parent, 300000);
      reply(200, r.ok ? { ok: true, path: dest } : { ok: false, error: (r.err.split('\n').filter(Boolean).pop() || 'The clone failed.').slice(0, 300) });
      return true;
    }
    if (p === '/ext/prs/publish') {
      const name = (path.basename(cwd) || 'project').replace(/[^\w.-]/g, '-');
      if ((await git(['rev-parse', '--verify', '--quiet', 'HEAD'], cwd)).out.trim() === '') {
        await git(['add', '-A'], cwd, 60000);
        await git(['commit', '-m', 'Initial commit'], cwd, 60000);
      }
      const r = await gh(['repo', 'create', name, '--private', '--source', '.', '--push'], cwd, 120000);
      const url = r.ok ? (/https:\/\/github\.com\/\S+/.exec(r.out + r.err) || [''])[0] : '';
      reply(200, { ok: r.ok, error: r.ok ? '' : ghProblem(r.err).error, url, ...(await state(cwd)) });
      return true;
    }
    return false;
  } catch (e) {
    reply(200, { ok: false, error: e.message, repo: false, gh: { ok: false, error: e.message }, local: null, prs: [] });
    return true;
  }
}
