// The Review popover (review-desktop.js reads git), opened from its button in the
// chat header. Like a pull request review:
//   - the PR's title (or the latest commit's), its state, branch -> base, how far
//     ahead or behind, what is not committed yet, and a bar of lines added/removed;
//   - Changes: the files git tracks, each with M/A/D/R, its +/- and its diff
//     (a picture shows as itself);
//   - Commits: the branch's own commits;
//   - New files: files git does not track yet, kept apart so they don't bury the work;
//   - the PR's checks, and "Ask Codeply to review", which sends a review request to the chat.
(() => {
  const api = window.craft;
  const box = document.getElementById('spReview');
  const panel = document.getElementById('reviewPanel');
  const btn = document.getElementById('reviewToggleBtn');
  if (!api || !api.reviewState || !box || !panel) return;
  const h = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ico = (n, c = 'ico-xs') => (typeof icon === 'function' ? icon(n, c) : '');
  const cwdNow = () => (typeof state !== 'undefined' && state ? state.project : '') || '';
  const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  let open = new Set();
  let last = null;
  let tab = 'changes';
  let loading = false;

  async function refresh() {
    const cwd = cwdNow();
    if (!cwd) { paint(null); return; }
    if (loading) return;
    loading = true;
    box.classList.add('loading');
    let r = null;
    try { r = await api.reviewState(cwd); } catch {}
    loading = false;
    box.classList.remove('loading');
    if (cwd !== cwdNow()) return;
    if (!last || last.cwd !== cwd) { open = new Set(); tab = 'changes'; }
    last = r ? { ...r, cwd } : null;
    paint(last);
  }

  function fileRow(f) {
    const i = f.path.lastIndexOf('/');
    const badge = f.tracked ? `<span class="rv-st st-${h(f.status)}" title="${{ M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed' }[f.status] || 'Changed'}">${h(f.status)}</span>` : '';
    const counts = f.binary ? '<span class="rv-bin">binary</span>' : `<span class="rv-add">${f.add ? `+${f.add}` : ''}</span><span class="rv-del">${f.del ? `−${f.del}` : ''}</span>`;
    return `<div class="rv-item${open.has(f.path) ? ' open' : ''}" data-path="${h(f.path)}">
      <button type="button" class="rv-file" title="${h(f.path)}">${badge}<span class="rv-path">${i >= 0 ? `<span class="rv-dir">${h(f.path.slice(0, i + 1))}</span>` : ''}${h(f.path.slice(i + 1))}</span>${f.tracked ? counts : f.binary ? '<span class="rv-bin">binary</span>' : `<span class="rv-add">${f.add ? `+${f.add}` : ''}</span>`}<span class="rv-chev">${ico('chevron-right')}</span></button>
      <div class="rv-diff"></div>
    </div>`;
  }

  function paint(r) {
    if (!r || !r.repo) {
      box.innerHTML = `<div class="rv-head"><span class="rv-label">Review</span></div><div class="rv-empty">${cwdNow() ? 'This project is not a git repository yet, so there is nothing to review.' : 'Open a project to review its changes.'}</div>`;
      return;
    }
    const pr = r.pr;
    const sameBase = r.base && r.base.startsWith('origin/');
    const st = pr ? (pr.state === 'MERGED' ? 'merged' : pr.draft ? 'draft' : pr.state === 'CLOSED' ? 'closed' : 'open') : sameBase ? (r.ahead ? 'unpushed' : 'synced') : 'nopr';
    const word = { merged: 'Merged', draft: 'Draft', closed: 'Closed', open: 'Open', unpushed: 'Not pushed', synced: 'Up to date', nopr: 'No pull request' }[st];
    const tracked = r.files.filter((f) => f.tracked);
    const fresh = r.files.filter((f) => !f.tracked);
    const checks = pr && pr.checks && pr.checks.total ? pr.checks : null;
    const total = (r.totals.add + r.totals.del) || 1;
    const facts = [
      r.ahead ? `${r.ahead} commit${r.ahead === 1 ? '' : 's'} ${sameBase ? 'not pushed' : 'ahead'}` : '',
      r.behind ? `${r.behind} behind` : '',
      r.dirty ? `${r.dirty} not committed` : '',
    ].filter(Boolean);
    if (!['changes', 'commits', 'new'].includes(tab)) tab = 'changes';
    const list = tab === 'commits' ? r.commits : tab === 'new' ? fresh : tracked;
    box.innerHTML = `
      <div class="rv-head"><span class="rv-label">Review</span><button type="button" class="rv-refresh" title="Refresh" aria-label="Refresh">${ico('refresh')}</button></div>
      <div class="rv-hero">
        <div class="rv-name"><span class="rv-title"></span>${pr ? `<span class="rv-num">#${h(pr.number)}</span>` : ''}</div>
        <div class="rv-meta">
          <span class="rv-pill ${st}">${st === 'merged' || st === 'synced' ? ico('check') : ''}${h(word)}</span>
          <span class="rv-branch">${ico('branch')}${h(r.branch)}</span>${r.base ? `<span class="rv-arrow">→</span><span class="rv-branch">${h(pr && pr.base ? pr.base : r.base)}</span>` : ''}
          ${pr && pr.url ? `<a class="rv-gh" href="#" data-url="${h(pr.url)}" title="Open on GitHub">${ico('external')}</a>` : ''}
        </div>
        ${facts.length ? `<div class="rv-facts">${h(facts.join(' · '))}</div>` : ''}
        ${tracked.length ? `<div class="rv-size"><span class="rv-bar"><i class="a" style="width:${(r.totals.add / total * 100).toFixed(1)}%"></i><i class="d" style="width:${(r.totals.del / total * 100).toFixed(1)}%"></i></span><span class="rv-add">+${r.totals.add.toLocaleString()}</span><span class="rv-del">−${r.totals.del.toLocaleString()}</span></div>` : ''}
      </div>
      <div class="rv-tabs" role="tablist">
        <button type="button" role="tab" data-tab="changes" class="${tab === 'changes' ? 'on' : ''}">Changes <span>${tracked.length}</span></button>
        <button type="button" role="tab" data-tab="commits" class="${tab === 'commits' ? 'on' : ''}">Commits <span>${r.commits.length}</span></button>
        ${fresh.length ? `<button type="button" role="tab" data-tab="new" class="${tab === 'new' ? 'on' : ''}">New files <span>${fresh.length}</span></button>` : ''}
      </div>
      <div class="rv-pane">${
        !list.length ? `<div class="rv-empty">${tab === 'commits' ? 'No commits on this branch yet.' : tab === 'new' ? 'No new files.' : 'No changes to review.'}</div>`
        : tab === 'commits' ? list.map((c) => `<div class="rv-commit"><span class="rv-sha">${h(c.sha)}</span><span class="rv-subj" title="${h(c.subject)}">${h(c.subject)}</span><span class="rv-when">${h(String(c.when).replace(/ ago$/, ''))}</span></div>`).join('')
        : `${tab === 'new' ? '<div class="rv-note">Not in git yet: these are not part of any commit.</div>' : ''}${list.map(fileRow).join('')}${tab === 'changes' && r.more ? `<div class="rv-more">and ${r.more} more</div>` : ''}`
      }</div>
      ${checks ? `<div class="rv-checks ${checks.failed ? 'bad' : checks.pending ? 'wait' : 'ok'}">${ico(checks.failed ? 'close' : checks.pending ? 'clock' : 'check')}<span>${checks.failed ? `${checks.failed} of ${checks.total} checks failed` : checks.pending ? `${checks.pending} of ${checks.total} checks running` : `${checks.passed} check${checks.passed === 1 ? '' : 's'} passed`}</span></div>` : ''}
      ${tracked.length || r.commits.length ? `<button type="button" class="rv-ask">${ico('sparkle', 'ico-sm')}<span>Ask Codeply to review</span></button>` : ''}`;
    box.querySelector('.rv-title').textContent = pr ? pr.title : r.last || r.branch;
    for (const p of open) { const it = box.querySelector(`.rv-item[data-path="${CSS.escape(p)}"]`); if (it) loadDiff(it); }
  }

  async function loadDiff(item) {
    const out = item.querySelector('.rv-diff');
    out.innerHTML = '<div class="rv-diff-wait">Loading…</div>';
    let r = null;
    try { r = await api.reviewDiff(last.cwd, item.dataset.path); } catch {}
    if (r && r.image) { out.innerHTML = `<div class="rv-img"><img alt="" src="${r.image}"><span>${h(kb(r.size || 0))}</span></div>`; return; }
    if (r && r.binary) { out.innerHTML = `<div class="rv-diff-wait">${r.deleted ? 'Deleted.' : `A binary file${r.size ? ` (${h(kb(r.size))})` : ''}: nothing readable to show.`}</div>`; return; }
    const lines = String((r && r.text) || '').split(/\r?\n/).filter((l) => !/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename (from|to) |Binary files )/.test(l));
    if (!lines.join('').trim()) { out.innerHTML = '<div class="rv-diff-wait">No text changes to show.</div>'; return; }
    out.innerHTML = lines.slice(0, 1500).map((l) => {
      const k = l.startsWith('@@') ? 'hunk' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : 'ctx';
      return `<div class="rv-l ${k}">${h(k === 'hunk' ? l.replace(/^@@ (.*?) @@.*$/, '$1') : l.slice(1) || ' ')}</div>`;
    }).join('') + (lines.length > 1500 ? `<div class="rv-diff-wait">+${lines.length - 1500} more lines</div>` : '');
  }

  function askReview() {
    if (!last) return;
    const tracked = last.files.filter((f) => f.tracked);
    const text = `Review the changes on ${last.branch}${last.base ? ` against ${last.base}` : ''}: ${tracked.length} files, +${last.totals.add} −${last.totals.del}${last.pr ? ` (pull request #${last.pr.number})` : ''}. Read the diffs, look for bugs, risky or unfinished changes and anything that does not match the rest of the code, and tell me what to fix first.`;
    show(false);
    if (typeof sendMessage === 'function' && typeof state !== 'undefined' && !state.running) { sendMessage(text); return; }
    const input = document.querySelector('.chat-composer .composer-input') || document.querySelector('.composer-input');
    if (input) { input.value = text; input.dispatchEvent(new Event('input')); input.focus(); }
  }

  box.addEventListener('click', (e) => {
    if (e.target.closest('.rv-refresh')) { refresh(); return; }
    if (e.target.closest('.rv-ask')) { askReview(); return; }
    const t = e.target.closest('[data-tab]');
    if (t) { tab = t.dataset.tab; paint(last); return; }
    const gh = e.target.closest('[data-url]');
    if (gh) { e.preventDefault(); if (api.openExternal) api.openExternal(gh.dataset.url); else window.open(gh.dataset.url); return; }
    const row = e.target.closest('.rv-file');
    if (!row) return;
    const item = row.closest('.rv-item');
    const p = item.dataset.path;
    const on = !open.has(p);
    if (on) open.add(p); else open.delete(p);
    item.classList.toggle('open', on);
    if (on) loadDiff(item);
  });

  // Its own button in the chat header; a click elsewhere or Escape closes it.
  function show(on) {
    panel.classList.toggle('hidden', !on);
    if (btn) btn.classList.toggle('active', on);
    if (on) { const side = document.getElementById('sidePanel'); if (side) side.classList.add('hidden'); refresh(); }
  }
  if (btn) btn.addEventListener('click', (e) => { e.stopPropagation(); show(panel.classList.contains('hidden')); });
  // The click's own path (taken when it happened): a tab click redraws the popover, so the
  // clicked element is already gone by now and panel.contains() would call it outside.
  document.addEventListener('click', (e) => { const path = e.composedPath(); if (!panel.classList.contains('hidden') && !path.includes(panel) && !(btn && path.includes(btn))) show(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.classList.contains('hidden')) show(false); });
  // After a run here ends its changes are new: refresh if open.
  let wasRunning = false;
  if (api.onRunsStatus) api.onRunsStatus((ids) => {
    const running = Array.isArray(ids) && ids.length > 0;
    if (wasRunning && !running && !panel.classList.contains('hidden')) setTimeout(refresh, 400);
    wasRunning = running;
  });
  window.CraftReview = { refresh, show };
})();
