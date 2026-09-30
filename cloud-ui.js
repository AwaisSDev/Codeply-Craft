// Craft Cloud in the desktop window: the Cloud chip in each composer, the
// Cloud sheet (setup, switches, backups, runs started from the phone) and the
// cloud cards in a chat. Loaded after app.js and uses its globals (api, state,
// chatColumn, esc, mdToHtml, showToast, scrollToBottom, nearBottom).
(() => {
  if (!window.craft || !window.craft.cloudState) return;

  const ICON = '<svg viewBox="0 0 24 24"><path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 8.5a4 4 0 0 1 .5 7.97V18Z"/></svg>';
  const STATUS = { starting: 'Starting on GitHub', queued: 'Waiting for a GitHub runner', running: 'Working in the cloud', done: 'Finished in the cloud', failed: 'Cloud run failed', cancelled: 'Cloud run cancelled' };
  let current = null;       // last cloud state for state.project
  let lastProject = null;

  // ─── Chip ────────────────────────────────────────────────────────────────
  function addChips() {
    document.querySelectorAll('.composer-bottom-left').forEach((row) => {
      if (row.querySelector('.cloud-chip')) return;
      const b = document.createElement('button');
      b.className = 'approve-toggle cloud-chip';
      b.type = 'button';
      b.innerHTML = `${ICON}<span>Cloud</span>`;
      b.title = 'Run on GitHub while this PC is off';
      b.addEventListener('click', openSheet);
      row.appendChild(b);
    });
  }

  function paintChips() {
    const on = !!(current && current.project && current.project.cloudOn);
    document.querySelectorAll('.cloud-chip').forEach((b) => {
      b.classList.toggle('on', on);
      b.querySelector('span').textContent = on ? 'Cloud on' : 'Cloud';
      b.title = on ? 'New messages run on GitHub. Click for cloud settings.' : 'Run on GitHub while this PC is off';
    });
    document.querySelectorAll('.composer').forEach((c) => c.classList.toggle('cloud-mode', on));
  }

  async function refresh() {
    const cwd = typeof state !== 'undefined' ? state.project : null;
    lastProject = cwd;
    if (!cwd) { current = null; paintChips(); return current; }
    try { current = await api.cloudState(cwd); } catch { current = null; }
    paintChips();
    return current;
  }

  // ─── Sheet ───────────────────────────────────────────────────────────────
  let backdrop = null;
  function sheet() {
    if (backdrop) return backdrop;
    backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop hidden';
    backdrop.innerHTML = '<div class="cloud-modal" role="dialog" aria-modal="true" aria-label="Cloud runs"></div>';
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeSheet(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !backdrop.classList.contains('hidden')) closeSheet(); });
    document.body.appendChild(backdrop);
    return backdrop;
  }
  function closeSheet() { if (backdrop) backdrop.classList.add('hidden'); }

  async function openSheet() {
    if (!state.project) { showToast('Pick a project folder first.', 'error'); return; }
    sheet().classList.remove('hidden');
    renderSheet({ loading: true });
    await refresh();
    renderSheet({});
  }

  const ago = (t) => {
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return new Date(t).toLocaleDateString();
  };
  const projectName = () => String(state.project || '').split(/[\\/]/).filter(Boolean).pop() || 'this project';

  function renderSheet({ loading, busy, error }) {
    const box = sheet().querySelector('.cloud-modal');
    const s = current;
    const head = `<div class="cloud-head"><div class="cloud-title">${ICON}<span>Cloud runs</span></div>
      <button class="sb-icon-btn" data-act="close" aria-label="Close"><svg viewBox="0 0 24 24"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg></button></div>`;
    if (loading || !s) { box.innerHTML = `${head}<div class="cloud-body"><p class="cloud-dim">${loading ? 'Checking...' : 'Cloud runs are not available.'}</p></div>`; wire(box); return; }
    const err = error ? `<div class="cloud-error">${esc(error)}</div>` : '';

    if (!s.project) {
      let action;
      if (!s.github.connected) action = '<button class="cloud-primary" data-act="github">Connect GitHub</button>';
      else if (!s.github.scopesOk) action = '<button class="cloud-primary" data-act="github">Reconnect GitHub</button><p class="cloud-dim">Craft needs permission to create a private repo and a workflow file.</p>';
      else if (!s.model.ok) action = `<button class="cloud-primary" disabled>Set up</button><p class="cloud-dim">${esc(s.model.error)} Choose one from the model menu, then come back.</p>`;
      else action = `<button class="cloud-primary" data-act="setup" ${busy ? 'disabled' : ''}>${busy ? 'Setting up...' : 'Set up'}</button>`;
      box.innerHTML = `${head}<div class="cloud-body">
        <p class="cloud-lead">Craft keeps working on <b>${esc(projectName())}</b> when this PC is off, on GitHub's machines in your own account. Nothing runs on Codeply's servers.</p>
        <ul class="cloud-points">
          <li>Creates a <b>private</b> repo, <code>craft-workspace-${esc(projectName().toLowerCase().replace(/[^a-z0-9._-]+/g, '-'))}</code>, on ${s.github.userName ? `<b>${esc(s.github.userName)}</b>'s` : 'your'} GitHub. Your real repo is never touched.</li>
          <li>Backs this folder up there after every run. <code>.env</code> files, keys, and anything in <code>.gitignore</code> stay on this PC.</li>
          <li>Stores your model key${s.model.ok ? ` (${esc(s.model.name)})` : ''} as an encrypted GitHub secret.</li>
          <li>Uses your own GitHub Actions minutes. A run takes 30 to 60 seconds to start, and can't ask you questions midway.</li>
        </ul>${err}<div class="cloud-actions">${action}</div></div>`;
      wire(box);
      return;
    }

    const p = s.project;
    const skipped = p.lastPush && p.lastPush.skipped && p.lastPush.skipped.length
      ? `<details class="cloud-skipped"><summary>${p.lastPush.skipped.length} file${p.lastPush.skipped.length === 1 ? '' : 's'} kept off GitHub</summary><ul>${p.lastPush.skipped.map((f) => `<li><code>${esc(f.path)}</code> ${esc(f.reason)}</li>`).join('')}</ul></details>` : '';
    const tasks = p.tasks.length ? p.tasks.slice(0, 8).map((t) => {
      const canApply = t.status === 'done' && t.files.length && !t.pulledAt;
      return `<li class="cloud-task">
        <div class="cloud-task-main"><span class="cloud-dot ${t.status}"></span><span class="cloud-task-prompt">${esc(t.prompt.split('\n')[0].slice(0, 90))}</span></div>
        <div class="cloud-task-meta">${esc(STATUS[t.status] || t.status)}${t.remote ? ' · from another device' : ''} · ${ago(t.startedAt)}${t.files.length ? ` · ${t.files.length} file${t.files.length === 1 ? '' : 's'}` : ''}${t.pulledAt ? ' · applied' : ''}
          ${t.runUrl ? `<a href="#" data-url="${esc(t.runUrl)}">log</a>` : ''}
          ${canApply ? `<button class="cp-action" data-act="apply-task" data-id="${esc(t.id)}">Apply</button>` : ''}</div></li>`;
    }).join('') : '<li class="cloud-dim">No cloud runs yet. Turn the switch on and send a message.</li>';
    box.innerHTML = `${head}<div class="cloud-body">
      <label class="cloud-switch"><input type="checkbox" data-act="cloudOn" ${p.cloudOn ? 'checked' : ''}><span><b>Send new messages to the cloud</b><br><span class="cloud-dim">Runs with ${esc(p.modelName || s.model.name)} on GitHub. Turn off to work on this PC again.</span></span></label>
      <label class="cloud-switch"><input type="checkbox" data-act="autoBackup" ${p.autoBackup ? 'checked' : ''}><span><b>Back up after every run</b><br><span class="cloud-dim">So a cloud run started from your phone has your latest code.</span></span></label>
      <div class="cloud-row"><span>Mirror: <a href="#" data-url="${esc(p.url)}">${esc(p.repo)}</a> (private)</span>
        <span class="cloud-dim">${p.lastPush ? `backed up ${ago(p.lastPush.at)}` : 'not backed up yet'}</span>
        <button class="cp-action" data-act="backup" ${busy ? 'disabled' : ''}>${busy === 'backup' ? 'Backing up...' : 'Back up now'}</button></div>
      ${skipped}${err}
      <div class="cloud-sub">Recent cloud runs</div><ul class="cloud-tasks">${tasks}</ul></div>`;
    wire(box);
  }

  function wire(box) {
    box.querySelectorAll('[data-act="close"]').forEach((b) => b.addEventListener('click', closeSheet));
    box.querySelectorAll('[data-url]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); api.openExternal(a.dataset.url); }));
    const on = (act, fn) => box.querySelectorAll(`[data-act="${act}"]`).forEach((el) => el.addEventListener(el.type === 'checkbox' ? 'change' : 'click', fn));
    on('github', async () => {
      const r = await api.connectGithub();
      if (r && r.error) renderSheet({ error: r.error });
      await refresh(); renderSheet({});
    });
    on('setup', async () => {
      renderSheet({ busy: true });
      const r = await api.cloudSetup(state.project);
      if (r.error) { await refresh(); renderSheet({ error: r.error }); return; }
      current = r.state; paintChips(); renderSheet({});
      showToast(`Cloud runs are ready. ${r.skipped && r.skipped.length ? `${r.skipped.length} file(s) with keys were kept off GitHub.` : ''}`.trim());
    });
    on('cloudOn', async (e) => {
      const r = await api.cloudOptions(state.project, { cloudOn: e.target.checked });
      if (r.error) { renderSheet({ error: r.error }); return; }
      current = r.state; paintChips();
      showToast(e.target.checked ? 'New messages now run on GitHub.' : 'New messages run on this PC again.');
    });
    on('autoBackup', async (e) => {
      const r = await api.cloudOptions(state.project, { autoBackup: e.target.checked });
      if (!r.error) current = r.state;
    });
    on('backup', async () => {
      renderSheet({ busy: 'backup' });
      const r = await api.cloudBackupNow(state.project);
      if (r.error) { renderSheet({ error: r.error }); return; }
      current = r.state; renderSheet({});
      showToast(r.pushed ? 'Backed up to GitHub.' : 'Already up to date.');
    });
    on('apply-task', async (e) => {
      e.target.disabled = true;
      const r = await api.cloudApplyTask(state.project, e.target.dataset.id);
      if (r.error) { renderSheet({ error: r.error }); return; }
      current = r.state; renderSheet({});
      showToast(r.conflicts && r.conflicts.length ? `Applied, with conflicts in ${r.conflicts.join(', ')}.` : `Applied ${r.files.length} file(s).`, r.conflicts && r.conflicts.length ? 'error' : '');
    });
  }

  // ─── Card in a chat ────────────────────────────────────────────────────────
  function render(task) {
    if (!task || typeof chatColumn === 'undefined') return;
    let card = chatColumn.querySelector(`.cloud-card[data-task-id="${CSS.escape(task.id)}"]`);
    // The first event has a placeholder id; the real one replaces it on the same card.
    if (!card && !String(task.id).startsWith('pending-')) {
      const pending = [...chatColumn.querySelectorAll('.cloud-card[data-pending="1"]')].pop();
      if (pending) card = pending;
    }
    const stick = nearBottom();
    if (!card) { card = document.createElement('div'); chatColumn.appendChild(card); }
    card.className = `cloud-card ${task.status}`;
    card.dataset.taskId = task.id;
    card.dataset.pending = String(task.id).startsWith('pending-') ? '1' : '0';
    const live = task.status === 'starting' || task.status === 'queued' || task.status === 'running';
    // When a run ends its progress text becomes the answer, which the chat already shows.
    const steps = live ? String(task.progress || '').split('\n').filter((l) => l.startsWith('- ')).slice(-6) : [];
    const note = String(task.progress || '').split('\n')[0];
    const files = task.files || [];
    let foot = '';
    if (task.status === 'done' && files.length) {
      foot = task.pulledAt
        ? `<div class="cloud-foot"><span>Applied ${files.length} file${files.length === 1 ? '' : 's'} to the project.</span></div>`
        : `<div class="cloud-foot"><span>Changed ${files.length} file${files.length === 1 ? '' : 's'} on GitHub: ${files.slice(0, 4).map((f) => `<code>${esc(f)}</code>`).join(', ')}${files.length > 4 ? ` and ${files.length - 4} more` : ''}</span>
           <button class="cp-action" data-act="apply">Apply to project</button></div>`;
    } else if (task.status === 'done' && task.mode === 'Build') {
      foot = '<div class="cloud-foot"><span class="cloud-dim">No files changed.</span></div>';
    }
    card.innerHTML = `<div class="cloud-card-head">${ICON}<span class="cloud-card-status">${esc(STATUS[task.status] || task.status)}${live ? '<span class="cloud-pulse"></span>' : ''}</span>
        ${task.runUrl ? '<a href="#" class="cloud-link" data-act="log">View run</a>' : ''}
        ${live && !String(task.id).startsWith('pending-') ? '<button class="cloud-link" data-act="cancel">Cancel</button>' : ''}</div>
      ${live && note ? `<div class="cloud-card-note">${esc(note)}</div>` : ''}
      ${steps.length ? `<div class="cloud-steps">${steps.map((l) => `<div>${esc(l.slice(2))}</div>`).join('')}</div>` : ''}
      ${task.error ? `<div class="cloud-error">${esc(task.error)}</div>` : ''}${foot}`;
    const log = card.querySelector('[data-act="log"]');
    if (log) log.addEventListener('click', (e) => { e.preventDefault(); api.openExternal(task.runUrl); });
    const cancel = card.querySelector('[data-act="cancel"]');
    if (cancel) cancel.addEventListener('click', async () => {
      cancel.disabled = true;
      const r = await api.cloudCancel(state.currentSessionId, task.id);
      if (r.error) showToast(r.error, 'error');
    });
    const apply = card.querySelector('[data-act="apply"]');
    if (apply) apply.addEventListener('click', async () => {
      apply.disabled = true; apply.textContent = 'Applying...';
      const r = await api.cloudApply(state.currentSessionId, task.id);
      if (r.error) { apply.disabled = false; apply.textContent = 'Apply to project'; showToast(r.error, 'error'); }
    });
    if (stick) scrollToBottom();
  }

  window.CraftCloud = { render, refresh, openSheet };

  addChips();
  refresh();
  // The composer is rebuilt in places and the project changes from several screens; keep up cheaply.
  setInterval(() => {
    addChips();
    if (state.project !== lastProject) refresh();
  }, 1500);
  window.addEventListener('focus', refresh);
})();
