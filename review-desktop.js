// The Review area's data (review-ui.js draws it): what this project's branch
// changes, like a pull request review. Read-only: it never commits, pushes or
// touches the files.
//
//   review:state { cwd } -> { repo, branch, base, ahead, files: [{ path, add, del, status }],
//                             totals, pr: { number, title, state, url, draft, checks } | null }
//   review:diff  { cwd, path } -> { text }   the file's diff against the base
//
// The changes are everything since the branch left its base: commits on the
// branch, edits not committed yet, and new files git does not track yet.
// The pull request comes from the GitHub CLI (gh) when it is installed and signed in.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function run(cmd, args, cwd, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || (err && err.message) || '') });
    });
  });
}
const git = (args, cwd) => run('git', args, cwd);
const BINARY = /\.(png|jpe?g|gif|webp|avif|ico|bmp|tiff?|psd|zip|gz|tgz|rar|7z|pdf|mp[34]|mov|webm|wav|ogg|m4a|woff2?|ttf|otf|exe|dll|so|dylib|bin|node|wasm|sqlite|db)$/i;

/** The branch this one is compared with: origin's default branch, else main or master. */
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

async function state(cwd) {
  if (!cwd || !fs.existsSync(cwd)) return { repo: false };
  const inside = await git(['rev-parse', '--is-inside-work-tree'], cwd);
  if (!inside.ok || inside.out.trim() !== 'true') return { repo: false };
  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).out.trim() || 'HEAD';
  const base = await baseOf(cwd, branch);
  let from = 'HEAD';
  let ahead = 0; let behind = 0;
  if (base) {
    const mb = await git(['merge-base', base, 'HEAD'], cwd);
    if (mb.ok && mb.out.trim()) from = mb.out.trim();
    const n = await git(['rev-list', '--left-right', '--count', `${base}...HEAD`], cwd);
    const [b, a] = n.out.trim().split(/\s+/).map(Number);
    behind = b || 0; ahead = a || 0;
  }
  // The branch's own commits (newest first), and what is not committed yet.
  const log = await git(['log', '--format=%h%x09%s%x09%cr%x09%an', '-n', '40', `${from}..HEAD`], cwd);
  const commits = log.out.split(/\r?\n/).filter(Boolean).map((l) => { const [sha, subject, when, author] = l.split('\t'); return { sha, subject, when, author }; });
  const last = (await git(['log', '-1', '--format=%s'], cwd)).out.trim();
  const dirty = (await git(['status', '--porcelain', '--untracked-files=no'], cwd)).out.split(/\r?\n/).filter(Boolean).length;
  // Tracked changes since the base (committed and not), then new untracked files.
  const files = [];
  const seen = new Set();
  const num = await git(['diff', '--numstat', '-M', from], cwd);
  const names = await git(['diff', '--name-status', '-M', from], cwd);
  const status = new Map();
  for (const line of names.out.split(/\r?\n/)) {
    const parts = line.split('\t');
    if (parts.length >= 2) status.set(parts[parts.length - 1], parts[0][0]);
  }
  for (const line of num.out.split(/\r?\n/)) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!m) continue;
    let p = m[3];
    const ren = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(p) || /^(.*) => (.*)$/.exec(p);
    if (ren && ren.length === 5) p = `${ren[1]}${ren[3]}${ren[4]}`.replace(/\/\//g, '/');
    else if (ren && ren.length === 3) p = ren[2];
    seen.add(p);
    files.push({ path: p, add: m[1] === '-' ? 0 : Number(m[1]), del: m[2] === '-' ? 0 : Number(m[2]), status: status.get(p) || 'M', binary: m[1] === '-' || BINARY.test(p), tracked: true });
  }
  const untracked = await git(['ls-files', '--others', '--exclude-standard'], cwd);
  for (const p of untracked.out.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).slice(0, 300)) {
    if (seen.has(p)) continue;
    // Pictures, archives and other binaries have no lines to count.
    let add = 0; let binary = BINARY.test(p);
    if (!binary) {
      try {
        const st = fs.statSync(path.join(cwd, p));
        if (st.size < 2e6) {
          const buf = fs.readFileSync(path.join(cwd, p));
          if (buf.subarray(0, 8000).includes(0)) binary = true;
          else add = buf.toString('utf8').split(/\r?\n/).length;
        } else binary = true;
      } catch {}
    }
    files.push({ path: p, add, del: 0, status: 'A', untracked: true, binary });
  }
  // Code first (most changed lines on top), binaries after.
  files.sort((a, b) => (a.binary ? 1 : 0) - (b.binary ? 1 : 0) || (b.add + b.del) - (a.add + a.del));
  // The totals are the tracked changes: new files git does not track yet are listed apart.
  const totals = files.filter((f) => f.tracked).reduce((t, f) => ({ add: t.add + f.add, del: t.del + f.del }), { add: 0, del: 0 });

  // The pull request for this branch, when gh can say.
  let pr = null;
  if (branch !== 'HEAD' && (!base || base.replace(/^origin\//, '') !== branch)) {
    const r = await run('gh', ['pr', 'view', '--json', 'number,title,state,url,isDraft,statusCheckRollup,mergedAt,baseRefName'], cwd, 7000);
    if (r.ok) {
      try {
        const j = JSON.parse(r.out);
        const roll = Array.isArray(j.statusCheckRollup) ? j.statusCheckRollup : [];
        const res = roll.map((c) => String(c.conclusion || c.state || c.status || '').toUpperCase());
        const checks = {
          total: res.length,
          passed: res.filter((x) => x === 'SUCCESS' || x === 'NEUTRAL' || x === 'SKIPPED').length,
          failed: res.filter((x) => x === 'FAILURE' || x === 'ERROR' || x === 'TIMED_OUT' || x === 'CANCELLED' || x === 'ACTION_REQUIRED').length,
        };
        checks.pending = Math.max(0, checks.total - checks.passed - checks.failed);
        pr = { number: j.number, title: j.title, state: j.mergedAt ? 'MERGED' : j.state, draft: !!j.isDraft, url: j.url, base: j.baseRefName, checks };
      } catch {}
    }
  }
  // On main itself the base is origin's main: say so, not "main -> main".
  const baseLabel = base.replace(/^origin\//, '') === branch ? base : base.replace(/^origin\//, '');
  return { repo: true, branch, base: baseLabel, ahead, behind, dirty, last, commits, files: files.slice(0, 300), more: Math.max(0, files.length - 300), totals, pr };
}

const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|ico)$/i;
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon' };

async function diff(cwd, p) {
  if (!cwd || !p) return { text: '' };
  const rel = String(p);
  if (rel.includes('..') || path.isAbsolute(rel)) return { text: '' };
  // A picture shows as itself; other binaries have nothing readable to show.
  if (BINARY.test(rel)) {
    const abs = path.join(cwd, rel);
    if (IMAGE.test(rel)) {
      try {
        const st = fs.statSync(abs);
        if (st.size <= 6 * 1024 * 1024) return { image: `data:${MIME[rel.split('.').pop().toLowerCase()] || 'image/png'};base64,${fs.readFileSync(abs).toString('base64')}`, size: st.size };
        return { binary: true, size: st.size };
      } catch { return { binary: true, deleted: true }; }
    }
    try { return { binary: true, size: fs.statSync(abs).size }; } catch { return { binary: true, deleted: true }; }
  }
  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).out.trim();
  const base = await baseOf(cwd, branch);
  let from = 'HEAD';
  if (base) { const mb = await git(['merge-base', base, 'HEAD'], cwd); if (mb.ok && mb.out.trim()) from = mb.out.trim(); }
  const r = await git(['diff', '-M', '--unified=3', from, '--', rel], cwd);
  if (r.out.trim()) return { text: r.out.slice(0, 200000) };
  // A new file git does not track yet: all of it is added.
  try {
    const body = fs.readFileSync(path.join(cwd, rel), 'utf8');
    return { text: `@@ new file @@\n${body.split(/\r?\n/).slice(0, 2000).map((l) => `+${l}`).join('\n')}` };
  } catch { return { text: '' }; }
}

function init({ ipcMain }) {
  ipcMain.handle('review:state', (e, o) => state(o && o.cwd).catch((err) => ({ repo: false, error: err.message })));
  ipcMain.handle('review:diff', (e, o) => diff(o && o.cwd, o && o.path).catch(() => ({ text: '' })));
}

module.exports = { init, state, diff };
