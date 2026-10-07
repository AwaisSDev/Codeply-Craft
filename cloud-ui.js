// Craft Cloud in the desktop window: the Cloud chip in each composer, the
// Cloud sheet (setup, switches, environment, runs started from the phone), the
// small cloud line in a chat, and the "GitHub has new commits, pull?" bar.
// Loaded after app.js and uses its globals (api, state, chatColumn, esc,
// showToast, scrollToBottom, nearBottom, showThinking, hideThinking, thinkingEl).
(() => {
  if (!window.craft || !window.craft.cloudState) return;

  const ICON = '<svg viewBox="0 0 24 24"><path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 8.5a4 4 0 0 1 .5 7.97V18Z"/></svg>';
  const STATUS = { starting: 'Starting', queued: 'Working', running: 'Working', done: 'Done', failed: 'Failed', cancelled: 'Cancelled' };
  const LIVE = new Set(['starting', 'queued', 'running']);
  let current = null;       // last cloud state for state.project
  let lastProject = null;
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  // ─── Chip ────────────────────────────────────────────────────────────────
  function addChips() {
    document.querySelectorAll('.composer-bottom-left').forEach((row) => {
      if (row.querySelector('.cloud-chip')) return;
      const b = document.createElement('button');
      b.className = 'approve-toggle cloud-chip';
      b.type = 'button';
      b.innerHTML = `${ICON}<span>Cloud</span>`;
      b.addEventListener('click', chipClick);
      b.addEventListener('contextmenu', (e) => { e.preventDefault(); openSheet(); });
      const more = document.createElement('button');
      more.className = 'cloud-chip-more hidden';
      more.type = 'button';
      more.title = 'Cloud settings';
      more.setAttribute('aria-label', 'Cloud settings');
      more.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>';
      more.addEventListener('click', openSheet);
      row.appendChild(b);
      row.appendChild(more);
    });
  }

  /** Set up: one click turns cloud on or off. Not set up yet: the sheet explains and sets it up. */
  async function chipClick() {
    const p = current && current.project;
    if (!p) { openSheet(); return; }
    const on = !p.cloudOn;
    const r = await api.cloudOptions(state.project, { cloudOn: on });
    if (r.error) { showToast(r.error, 'error'); return; }
    current = r.state;
    paintChips();
    showToast(on ? 'Cloud on: new messages run in the cloud.' : 'Cloud off: messages run on this PC again.');
  }

  function paintChips() {
    const ready = !!(current && current.project);
    const on = !!(ready && current.project.cloudOn);
    document.querySelectorAll('.cloud-chip').forEach((b) => {
      b.classList.toggle('on', on);
      b.querySelector('span').textContent = on ? 'Cloud on' : 'Cloud';
      b.title = !ready ? 'Keep working while this PC is off (set up once)'
        : on ? 'Click to turn cloud off and run on this PC' : 'Click to send new messages to the cloud';
    });
    document.querySelectorAll('.cloud-chip-more').forEach((b) => b.classList.toggle('hidden', !ready));
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
  let setupTarget = null;   // 'repo' | 'mirror', chosen in the setup sheet
  let envDraft = '';        // what is typed in the environment box, kept across redraws
  let envEditing = false;
  function sheet() {
    if (backdrop) return backdrop;
    backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop hidden';
    backdrop.innerHTML = '<div class="modal modal-md cloud-modal" role="dialog" aria-modal="true" aria-label="Cloud runs"></div>';
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeSheet(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !backdrop.classList.contains('hidden')) closeSheet(); });
    document.body.appendChild(backdrop);
    return backdrop;
  }
  function closeSheet() { if (backdrop) backdrop.classList.add('hidden'); envEditing = false; envDraft = ''; }

  async function openSheet() {
    if (!state.project) { showToast('Pick a project folder first.', 'error'); return; }
    sheet().classList.remove('hidden');
    setupTarget = null;
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
  const ENV_NOTE = 'Stored as an encrypted GitHub secret and written to <code>.env</code> on the cloud machine for each run. Never committed.';
  const ENV_PLACEHOLDER = 'DATABASE_URL=postgres://...\nAPI_KEY=...';

  function renderSheet({ loading, busy, error }) {
    const box = sheet().querySelector('.cloud-modal');
    const s = current;
    const head = `<div class="cloud-head"><div class="cloud-title">${ICON}<span>Cloud runs</span></div>
      <button class="icon-btn icon-btn-sm modal-close" data-act="close" title="Close" aria-label="Close"><svg viewBox="0 0 24 24"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg></button></div>`;
    if (loading || !s) { box.innerHTML = `${head}<div class="cloud-body"><p class="cloud-dim">${loading ? 'Checking...' : 'Cloud runs are not available.'}</p></div>`; wire(box); return; }
    const err = error ? `<div class="cloud-error">${esc(error)}</div>` : '';
    // Keep what was typed in the environment box when the sheet redraws.
    const typed = box.querySelector('[data-env]');
    if (typed) envDraft = typed.value;

    if (!s.project) {
      const o = s.origin && s.origin.canPush !== false ? s.origin : null;
      const target = setupTarget || (o ? 'repo' : 'mirror');
      let action;
      if (!s.github.connected) action = '<button class="btn btn-primary cloud-primary" data-act="github">Connect GitHub</button>';
      else if (!s.github.scopesOk) action = '<button class="btn btn-primary cloud-primary" data-act="github">Reconnect GitHub</button><p class="cloud-dim">Craft needs permission to work in your repos.</p>';
      else if (!s.model.ok) action = `<button class="btn btn-primary cloud-primary" disabled>Set up</button><p class="cloud-dim">${esc(s.model.error)} Choose one from the model menu, then come back.</p>`;
      else action = `<button class="btn btn-primary cloud-primary" data-act="setup" ${busy ? 'disabled' : ''}>${busy ? 'Setting up...' : 'Set up'}</button>`;
      const mirrorName = `craft-workspace-${projectName().toLowerCase().replace(/[^a-z0-9._-]+/g, '-')}`;
      const choice = o ? `<div class="cloud-choice">
          <label><input type="radio" name="cloud-target" value="repo" data-act="target" ${target === 'repo' ? 'checked' : ''}>
            <span>Work in <b>${esc(o.repo)}</b> <span class="cloud-dim">(new branch per task, merged into <code>${esc(o.base)}</code>)</span></span></label>
          <label><input type="radio" name="cloud-target" value="mirror" data-act="target" ${target === 'mirror' ? 'checked' : ''}>
            <span>Use a private copy instead <span class="cloud-dim">(<code>${esc(mirrorName)}</code>, your repo is never touched)</span></span></label>
        </div>` : '';
      const points = target === 'repo'
        ? `<li>Each task gets its own branch, merged into <code>${esc(o.base)}</code> when it is done. Craft offers to pull the changes here.</li>
           <li>Adds one file to the repo: <code>.github/workflows/craft-cloud.yml</code>.</li>`
        : `<li>Creates a <b>private</b> repo, <code>${esc(mirrorName)}</code>, on ${s.github.userName ? `<b>${esc(s.github.userName)}</b>'s` : 'your'} GitHub, and backs this folder up there after every run. <code>.env</code> files, keys, and anything in <code>.gitignore</code> stay on this PC.</li>
           <li>Changes come back when you click Apply in the chat.</li>`;
      box.innerHTML = `${head}<div class="cloud-body">
        <p class="cloud-lead">Craft keeps working on <b>${esc(projectName())}</b> when this PC is off, on GitHub in your own account. Nothing runs on Codeply's servers.</p>
        ${choice}
        <ul class="cloud-points">${points}
          <li>Stores your model key${s.model.ok ? ` (${esc(s.model.name)})` : ''} as an encrypted GitHub secret. A run can't ask you questions midway.</li>
        </ul>
        <label class="cloud-env"><span class="cloud-env-label">Environment variables for testing <span class="cloud-dim">(optional, KEY=value per line)</span></span>
          <textarea data-env rows="3" spellcheck="false" placeholder="${esc(ENV_PLACEHOLDER)}">${esc(envDraft)}</textarea>
          <span class="cloud-dim">${ENV_NOTE}</span></label>
        ${err}<div class="cloud-actions">${action}</div></div>`;
      wire(box);
      return;
    }

    const p = s.project;
    const skipped = p.kind === 'mirror' && p.lastPush && p.lastPush.skipped && p.lastPush.skipped.length
      ? `<details class="cloud-skipped"><summary>${plural(p.lastPush.skipped.length, 'file')} kept off GitHub</summary><ul>${p.lastPush.skipped.map((f) => `<li><code>${esc(f.path)}</code> ${esc(f.reason)}</li>`).join('')}</ul></details>` : '';
    const tasks = p.tasks.length ? p.tasks.slice(0, 8).map((t) => {
      const canApply = t.kind !== 'repo' && t.status === 'done' && t.files.length && !t.pulledAt;
      const merged = t.kind === 'repo' && t.merged ? (t.merged.ok ? ` · merged into ${esc(t.merged.base || t.base)}` : ' · kept on its branch') : '';
      return `<li class="cloud-task">
        <div class="cloud-task-main"><span class="cloud-dot ${t.status}"></span><span class="cloud-task-prompt">${esc(t.prompt.split('\n')[0].slice(0, 90))}</span></div>
        <div class="cloud-task-meta">${esc(STATUS[t.status] || t.status)}${t.remote ? ' · from another device' : ''} · ${ago(t.startedAt)}${t.files.length ? ` · ${plural(t.files.length, 'file')}` : ''}${merged}${t.pulledAt ? (t.kind === 'repo' ? ' · pulled' : ' · applied') : ''}
          ${t.runUrl ? `<a href="#" data-url="${esc(t.runUrl)}">View run</a>` : ''}
          ${canApply ? `<button class="btn btn-secondary btn-sm cp-action" data-act="apply-task" data-id="${esc(t.id)}">Apply</button>` : ''}</div></li>`;
    }).join('') : '<li class="cloud-dim">No cloud runs yet. Turn the switch on and send a message.</li>';
    const where = p.kind === 'repo'
      ? `<div class="cloud-row"><span>Works in <a href="#" data-url="${esc(p.url)}">${esc(p.repo)}</a> <span class="cloud-dim">(new branch per task, merged into <code>${esc(p.base)}</code>)</span></span></div>`
      : `<label class="cloud-switch"><input type="checkbox" data-act="autoBackup" ${p.autoBackup ? 'checked' : ''}><span><b>Back up after every run</b><br><span class="cloud-dim">So a cloud run started from your phone has your latest code.</span></span></label>
        <div class="cloud-row"><span>Private copy: <a href="#" data-url="${esc(p.url)}">${esc(p.repo)}</a></span>
        <span class="cloud-dim">${p.lastPush ? `backed up ${ago(p.lastPush.at)}` : 'not backed up yet'}</span>
        <button class="btn btn-secondary btn-sm cp-action" data-act="backup" ${busy ? 'disabled' : ''}>${busy === 'backup' ? 'Backing up...' : 'Back up now'}</button></div>`;
    const keys = (p.env && p.env.keys) || [];
    const envRow = envEditing
      ? `<div class="cloud-env"><span class="cloud-env-label">Environment variables for testing <span class="cloud-dim">(KEY=value per line)</span></span>
          <textarea data-env rows="4" spellcheck="false" placeholder="${esc(ENV_PLACEHOLDER)}">${esc(envDraft)}</textarea>
          <span class="cloud-dim">${ENV_NOTE}${keys.length ? ' Saved values can\'t be read back, so enter every line again. Save it empty to remove them all.' : ''}</span>
          <div class="cloud-env-actions"><button class="btn btn-secondary btn-sm cp-action" data-act="env-save" ${busy === 'env' ? 'disabled' : ''}>${busy === 'env' ? 'Saving...' : 'Save'}</button><button class="cloud-link" data-act="env-cancel">Cancel</button></div></div>`
      : `<div class="cloud-row"><span>Environment: ${keys.length ? `<code>${keys.slice(0, 6).map(esc).join('</code> <code>')}</code>${keys.length > 6 ? ` and ${keys.length - 6} more` : ''}` : '<span class="cloud-dim">none</span>'}</span>
          <button class="btn btn-secondary btn-sm cp-action" data-act="env-edit">${keys.length ? 'Replace' : 'Add'}</button></div>`;
    box.innerHTML = `${head}<div class="cloud-body">
      <label class="cloud-switch"><input type="checkbox" data-act="cloudOn" ${p.cloudOn ? 'checked' : ''}><span><b>Send new messages to the cloud</b><br><span class="cloud-dim">Runs with ${esc(p.modelName || s.model.name)}. Turn off to work on this PC again.</span></span></label>
      ${where}${envRow}
      ${skipped}${err}
      <div class="cloud-sub">Recent cloud runs</div><ul class="cloud-tasks">${tasks}</ul></div>`;
    wire(box);
  }

  function wire(box) {
    box.querySelectorAll('[data-act="close"]').forEach((b) => b.addEventListener('click', closeSheet));
    box.querySelectorAll('[data-url]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); api.openExternal(a.dataset.url); }));
    const on = (act, fn) => box.querySelectorAll(`[data-act="${act}"]`).forEach((el) => el.addEventListener(el.type === 'checkbox' || el.type === 'radio' ? 'change' : 'click', fn));
    const envBox = box.querySelector('[data-env]');
    if (envBox) envBox.addEventListener('input', () => { envDraft = envBox.value; });
    on('github', async () => {
      const r = await api.connectGithub();
      if (r && r.error) renderSheet({ error: r.error });
      await refresh(); renderSheet({});
    });
    on('target', (e) => { setupTarget = e.target.value; renderSheet({}); });
    on('setup', async () => {
      const o = current && current.origin && current.origin.canPush !== false ? current.origin : null;
      const target = setupTarget || (o ? 'repo' : 'mirror');
      const envText = envDraft;
      renderSheet({ busy: true });
      const r = await api.cloudSetup(state.project, { target, envText });
      if (r.error) { await refresh(); renderSheet({ error: r.error }); return; }
      envDraft = '';
      current = r.state; paintChips(); renderSheet({});
      showToast(`Cloud runs are ready. ${r.skipped && r.skipped.length ? `${plural(r.skipped.length, 'file')} with keys were kept off GitHub.` : ''}`.trim());
    });
    on('cloudOn', async (e) => {
      const r = await api.cloudOptions(state.project, { cloudOn: e.target.checked });
      if (r.error) { renderSheet({ error: r.error }); return; }
      current = r.state; paintChips();
      showToast(e.target.checked ? 'New messages now run in the cloud.' : 'New messages run on this PC again.');
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
    on('env-edit', () => { envEditing = true; envDraft = ''; renderSheet({}); const t = box.querySelector('[data-env]'); if (t) t.focus(); });
    on('env-cancel', () => { envEditing = false; envDraft = ''; renderSheet({}); });
    on('env-save', async () => {
      const text = envDraft;
      renderSheet({ busy: 'env' });
      const r = await api.cloudEnv(state.project, text);
      if (r.error) { renderSheet({ error: r.error }); return; }
      envEditing = false; envDraft = '';
      current = r.state; renderSheet({});
      showToast(r.count ? `Saved ${plural(r.count, 'variable')}.` : 'Environment cleared.');
    });
    on('apply-task', async (e) => {
      e.target.disabled = true;
      const r = await api.cloudApplyTask(state.project, e.target.dataset.id);
      if (r.error) { renderSheet({ error: r.error }); return; }
      current = r.state; renderSheet({});
      showToast(r.conflicts && r.conflicts.length ? `Applied, with conflicts in ${r.conflicts.join(', ')}.` : `Applied ${plural(r.files.length, 'file')}.`, r.conflicts && r.conflicts.length ? 'error' : '');
    });
  }

  // ─── In a chat ─────────────────────────────────────────────────────────────
  // A cloud message reads like a local run: the app's own Working row at the
  // bottom while it runs, the replayed steps as normal rows, then the answer.
  // The only extra is one small line: "Running in the cloud" with Cancel while
  // live, then "Ran in the cloud" with what happened to the code.
  const liveTasks = new Map(); // task id -> task
  const cloudChats = new Set(); // chats with a cloud line, beyond what the sidebar list already knows

  // Cloud chats look like any chat, marked by a hollow blue cloud in the sidebar.
  const HOLLOW = '<svg class="cloud-mark" viewBox="0 0 24 24" aria-label="Cloud chat"><path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 8.5a4 4 0 0 1 .5 7.97V18Z"/></svg>';
  const isCloudChat = (id) => !!id && (cloudChats.has(id) || (state.sessions || []).some((s) => s.id === id && s.cloud));
  function markCloudChats() {
    document.querySelectorAll('.sb-chat-row').forEach((row) => {
      const on = isCloudChat(row.dataset.id);
      row.classList.toggle('cloud', on);
      const btn = row.querySelector('.sb-chat');
      const mark = btn && btn.querySelector('.cloud-mark');
      if (on && btn && !mark) btn.insertAdjacentHTML('afterbegin', HOLLOW);
      else if (!on && mark) mark.remove();
    });
    const view = document.getElementById('viewChat');
    if (view) view.classList.toggle('cloud-session', isCloudChat(state.currentSessionId) || !!chatColumn.querySelector('.cloud-card'));
  }
  setInterval(markCloudChats, 600);

  /** The app's Thinking row, reading "Working" and counting from the run's start, kept last in the chat. */
  function ensureWorking() {
    if (typeof chatColumn === 'undefined' || typeof showThinking !== 'function') return;
    const live = [...chatColumn.querySelectorAll('.cloud-card.live')].pop();
    const task = live && liveTasks.get(live.dataset.taskId);
    if (!task) {
      if (typeof thinkingEl !== 'undefined' && thinkingEl && thinkingEl.classList.contains('cloud-working')) hideThinking();
      return;
    }
    const stick = nearBottom();
    if (!thinkingEl) showThinking();
    if (!thinkingEl) return;
    if (chatColumn.lastElementChild !== thinkingEl) chatColumn.appendChild(thinkingEl);
    thinkingEl.classList.add('cloud-working');
    const label = thinkingEl.querySelector('.thinking-label');
    if (label && label.textContent !== 'Working') label.textContent = 'Working';
    if (task.startedAt) {
      try { thinkingStart = task.startedAt; } catch {}
      const time = thinkingEl.querySelector('.thinking-time');
      if (time) time.textContent = `${Math.max(0, Math.floor((Date.now() - task.startedAt) / 1000))}s`;
    }
    if (stick) scrollToBottom();
  }
  setInterval(ensureWorking, 1000);

  /** A finished run's line goes after its steps and answer, before the next message. */
  function moveToTurnEnd(card) {
    let last = card;
    for (let n = card.nextElementSibling; n && !n.classList.contains('user') && !n.classList.contains('cloud-card') && !n.classList.contains('thinking-row'); n = n.nextElementSibling) last = n;
    if (last !== card) last.after(card);
  }

  function resultHtml(task) {
    if (task.status !== 'done') return '';
    const files = task.files || [];
    if (task.kind === 'repo') {
      const m = task.merged;
      if (m && m.ok) {
        return `<span class="cloud-sep">·</span><span>Merged into <code>${esc(m.base || task.base)}</code></span>${task.pulledAt
          ? '<span class="cloud-sep">·</span><span>Pulled</span>'
          : '<button class="btn btn-secondary btn-sm cp-action cloud-line-btn" data-act="pull">Pull</button>'}`;
      }
      if (m && !m.ok) return `<span class="cloud-sep">·</span><span>Kept on <code>${esc(task.branch || 'its branch')}</code>${m.reason ? `: ${esc(m.reason)}` : ''}</span>`;
      return files.length ? `<span class="cloud-sep">·</span><span>Changed ${plural(files.length, 'file')}</span>` : '';
    }
    if (!files.length) return task.mode === 'Build' ? '<span class="cloud-sep">·</span><span>No files changed</span>' : '';
    return task.pulledAt
      ? `<span class="cloud-sep">·</span><span>Applied ${plural(files.length, 'file')}</span>`
      : `<span class="cloud-sep">·</span><span>Changed ${plural(files.length, 'file')}</span><button class="btn btn-secondary btn-sm cp-action cloud-line-btn" data-act="apply">Apply to project</button>`;
  }

  function render(task) {
    if (!task || typeof chatColumn === 'undefined') return;
    let card = chatColumn.querySelector(`.cloud-card[data-task-id="${CSS.escape(task.id)}"]`);
    // The first event has a placeholder id; the real one replaces it on the same line.
    if (!card && !String(task.id).startsWith('pending-')) {
      const pending = [...chatColumn.querySelectorAll('.cloud-card[data-pending="1"]')].pop();
      if (pending) card = pending;
    }
    const stick = nearBottom();
    if (!card) { card = document.createElement('div'); chatColumn.appendChild(card); }
    const live = LIVE.has(task.status);
    const pendingId = String(task.id).startsWith('pending-');
    card.className = `cloud-card ${task.status}${live ? ' live' : ''}`;
    card.dataset.taskId = task.id;
    card.dataset.pending = pendingId ? '1' : '0';
    if (state.currentSessionId) cloudChats.add(state.currentSessionId);
    for (const [id] of liveTasks) if (id.startsWith('pending-') && !pendingId) liveTasks.delete(id);
    if (live) liveTasks.set(task.id, task); else liveTasks.delete(task.id);

    const runLink = task.runUrl ? '<span class="cloud-sep">·</span><a href="#" class="cloud-link" data-act="log">View run</a>' : '';
    let text;
    if (live) text = 'Running in the cloud';
    else if (task.status === 'done') text = 'Ran in the cloud';
    else if (task.status === 'cancelled') text = 'Cloud run cancelled';
    else text = `Cloud run failed${task.error ? `: ${esc(task.error)}` : ''}`;
    card.innerHTML = `<span class="cloud-card-icon">${ICON}</span><span class="cloud-card-text">${text}</span>${resultHtml(task)}${runLink}${live && !pendingId ? '<span class="cloud-sep">·</span><button class="cloud-link" data-act="cancel">Cancel</button>' : ''}`;

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
    const pullBtn = card.querySelector('[data-act="pull"]');
    if (pullBtn) pullBtn.addEventListener('click', async () => {
      pullBtn.disabled = true; pullBtn.textContent = 'Pulling...';
      const r = await api.cloudPull(state.project, state.currentSessionId, task.id);
      if (r.error) { pullBtn.disabled = false; pullBtn.textContent = 'Pull'; showToast(r.error, 'error'); return; }
      showToast(r.pulled ? `Pulled ${plural(r.pulled, 'commit')}.` : 'Already up to date.');
      hidePullBar();
    });
    // After the rest of this turn has been drawn (reopening a chat draws it in order).
    setTimeout(() => {
      if (!card.isConnected) return;
      ensureWorking();
      if (!live) moveToTurnEnd(card);
      if (stick) scrollToBottom();
    }, 0);
  }

  // ─── Pull before coding ──────────────────────────────────────────────────
  // When a project opens and before a message goes out (at most once a minute
  // per project), ask git whether GitHub has commits this copy doesn't. Never blocks.
  const CHECK_EVERY = 60000;
  const lastCheck = new Map();   // cwd -> time
  const dismissed = new Map();   // cwd -> behind count the user said "Not now" to
  let pullInfo = null;           // { cwd, behind, branch, latest }

  function pullBars() {
    const bars = [];
    document.querySelectorAll('.composer').forEach((composer) => {
      const wrap = composer.closest('.composer-wrap') || composer.parentElement;
      let bar = wrap.querySelector(':scope > .pull-bar');
      if (!bar) {
        bar = document.createElement('div');
        bar.className = 'pull-bar hidden';
        wrap.prepend(bar);
      }
      bars.push(bar);
    });
    return bars;
  }
  function hidePullBar() { pullInfo = null; pullBars().forEach((b) => { b.classList.add('hidden'); b.innerHTML = ''; }); }
  function showPullBar(info, { busy, error } = {}) {
    pullInfo = info;
    const html = `<span class="pull-bar-text">GitHub has ${plural(info.behind, 'new commit')} on <code>${esc(info.branch)}</code>${info.latest ? ` (latest: ${esc(info.latest)})` : ''}. Pull ${info.behind === 1 ? 'it' : 'them'} first?</span>
      ${error ? `<span class="pull-bar-error">${esc(error)}</span>` : ''}
      <button class="btn btn-secondary btn-sm cp-action" data-act="pull" ${busy ? 'disabled' : ''}>${busy ? 'Pulling...' : 'Pull'}</button>
      <button class="cloud-link" data-act="later" ${busy ? 'disabled' : ''}>Not now</button>`;
    for (const bar of pullBars()) {
      bar.innerHTML = html;
      bar.classList.remove('hidden');
      bar.querySelector('[data-act="pull"]').addEventListener('click', doPull);
      bar.querySelector('[data-act="later"]').addEventListener('click', () => { dismissed.set(info.cwd, info.behind); hidePullBar(); });
    }
  }
  async function doPull() {
    const info = pullInfo;
    if (!info) return;
    showPullBar(info, { busy: true });
    let r;
    try { r = await api.cloudPull(info.cwd); } catch (e) { r = { error: e.message }; }
    if (r.error) { showPullBar(info, { error: r.error }); return; }
    hidePullBar();
    lastCheck.set(info.cwd, Date.now());
    showToast(r.pulled ? `Pulled ${plural(r.pulled, 'commit')}.` : 'Already up to date.');
  }
  async function checkPull(force = false) {
    const cwd = typeof state !== 'undefined' ? state.project : null;
    if (!cwd || !api.cloudCheckBehind) return;
    if (!force && Date.now() - (lastCheck.get(cwd) || 0) < CHECK_EVERY) return;
    lastCheck.set(cwd, Date.now());
    let r;
    try { r = await api.cloudCheckBehind(cwd); } catch { return; }
    if (state.project !== cwd) return;
    if (r && r.ok && r.behind > 0 && (dismissed.get(cwd) || 0) < r.behind) showPullBar({ cwd, behind: r.behind, branch: r.branch, latest: r.latest });
    else if (!pullInfo || pullInfo.cwd === cwd) hidePullBar();
  }

  window.CraftCloud = { render, refresh, openSheet, checkPull, beforeSend: () => { checkPull(); } };

  addChips();
  refresh();
  checkPull();
  // The composer is rebuilt in places and the project changes from several screens; keep up cheaply.
  setInterval(() => {
    addChips();
    if (state.project !== lastProject) {
      if (pullInfo && pullInfo.cwd !== state.project) hidePullBar();
      refresh();
      checkPull();
    }
  }, 1500);
  window.addEventListener('focus', refresh);
})();
