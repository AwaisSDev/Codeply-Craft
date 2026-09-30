// Craft Cloud on the phone: start and follow cloud runs straight on GitHub,
// so it works while the PC is off. The PC hands over its GitHub login and the
// mirror repo names once (GET /api/cloud/credentials, same-account phones
// only); after that this talks to api.github.com directly. Code changes wait
// on the mirror until Craft on the PC applies them (Cloud sheet > Apply).
// Loaded after mobile.js and uses its globals (request, escapeHtml,
// renderMarkdownLite, openSheet, closeSheet).
(() => {
  const API = 'https://api.github.com';
  const WORKFLOW = 'craft-cloud.yml';
  const KEY_CREDS = 'craft-cloud-creds';
  const KEY_TASKS = 'craft-cloud-tasks';
  const KEY_PROJECT = 'craft-cloud-project';
  const ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 8.5a4 4 0 0 1 .5 7.97V18Z"/></svg>';
  const STATUS = { starting: 'Starting', queued: 'Waiting for a runner', running: 'Working', done: 'Finished', failed: 'Failed', cancelled: 'Cancelled' };
  const LIVE = new Set(['starting', 'queued', 'running']);

  // Answers use `code` a lot; the chat's markdown helper only does bold and line breaks.
  const fmt = (text) => escapeHtml(text || '')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  let creds = load(KEY_CREDS, null);          // { token, projects: [{ cwd, name, repo }], at }
  let tasks = load(KEY_TASKS, []);            // newest first
  let mode = 'Build';
  let pollTimer = null;
  let sheetOpen = false;

  async function gh(method, route, body) {
    const res = await fetch(`${API}${route}`, {
      method,
      headers: { Authorization: `Bearer ${creds.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    if (!res.ok) throw new Error(res.status === 401 ? 'GitHub signed this phone out. Open Craft on your PC once to refresh it.' : `GitHub: ${(json && json.message) || res.status}`);
    return json;
  }

  /** Fresh credentials from the PC when it's reachable, the saved ones otherwise. */
  async function refreshCreds() {
    try {
      const c = await request('/api/cloud/credentials');
      if (c && c.token) { creds = { ...c, at: Date.now() }; save(KEY_CREDS, creds); }
    } catch {}
    return creds;
  }

  const projectRepo = () => {
    if (!creds || !creds.projects.length) return null;
    const want = localStorage.getItem(KEY_PROJECT);
    return (creds.projects.find((p) => p.repo === want) || creds.projects[0]).repo;
  };
  // One rolling chat per mirror, so follow-ups from the phone keep context.
  const sessionFor = (repo) => `phone${repo.replace(/[^A-Za-z0-9]/g, '').slice(-24)}`;

  async function start(prompt) {
    const repo = projectRepo();
    const id = `${Date.now().toString(36)}${Math.random().toString(16).slice(2, 8)}`;
    const task = { id, repo, prompt, mode, status: 'starting', startedAt: Date.now() };
    tasks = [task, ...tasks].slice(0, 30);
    save(KEY_TASKS, tasks);
    render();
    try {
      await gh('POST', `/repos/${repo}/actions/workflows/${WORKFLOW}/dispatches`, { ref: 'main', inputs: { prompt, mode, task_id: id, session_id: sessionFor(repo) } });
    } catch (e) {
      Object.assign(task, { status: 'failed', error: e.message });
    }
    save(KEY_TASKS, tasks);
    render();
    schedule();
  }

  async function pollOnce() {
    const live = tasks.filter((t) => LIVE.has(t.status));
    for (const t of live) {
      try {
        let run = null;
        if (t.runId) run = await gh('GET', `/repos/${t.repo}/actions/runs/${t.runId}`);
        else {
          const list = await gh('GET', `/repos/${t.repo}/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&per_page=20`);
          run = (list.workflow_runs || []).find((r) => r.display_title === `craft ${t.id}`) || null;
        }
        if (!run) { if (Date.now() - t.startedAt > 5 * 60 * 1000) Object.assign(t, { status: 'failed', error: 'GitHub never started the run.' }); continue; }
        t.runId = run.id; t.runUrl = run.html_url;
        const checks = await gh('GET', `/repos/${t.repo}/commits/${run.head_sha}/check-runs?check_name=${encodeURIComponent(`craft ${t.id}`)}`);
        const check = (checks.check_runs || [])[0];
        if (check && check.output) t.progress = check.output.summary || '';
        if (check && check.status === 'completed') {
          let result = {};
          try { result = JSON.parse(check.output.text || '{}'); } catch {}
          Object.assign(t, { status: check.conclusion === 'success' ? 'done' : 'failed', answer: result.answer || '', files: result.files || [], error: result.error || null });
        } else if (run.status === 'completed') {
          Object.assign(t, { status: run.conclusion === 'cancelled' ? 'cancelled' : 'failed', error: run.conclusion === 'cancelled' ? null : 'The run ended before Craft could report back.' });
        } else t.status = run.status === 'in_progress' ? 'running' : 'queued';
      } catch (e) { t.lastError = e.message; }
    }
    save(KEY_TASKS, tasks);
    if (sheetOpen) render();
  }

  function schedule() {
    clearTimeout(pollTimer);
    if (!tasks.some((t) => LIVE.has(t.status))) return;
    pollTimer = setTimeout(async () => { await pollOnce(); schedule(); }, 5000);
  }

  // ─── UI ────────────────────────────────────────────────────────────────
  let el = null;
  function build() {
    el = document.createElement('section');
    el.className = 'approval-sheet pick-sheet hidden';
    el.id = 'cloudSheet';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', 'Cloud runs');
    el.innerHTML = '<div class="sheet-backdrop" data-close-cloud></div><div class="sheet-container cloud-sheet"><div class="sheet-handle"></div><div class="cloud-sheet-body"></div></div>';
    el.querySelector('[data-close-cloud]').addEventListener('click', close);
    document.body.appendChild(el);

    const btn = document.createElement('button');
    btn.className = 'icon-btn cloud-top-btn';
    btn.setAttribute('aria-label', 'Cloud runs');
    btn.innerHTML = ICON;
    btn.addEventListener('click', open);
    const bar = document.querySelector('.topbar');
    if (bar) bar.appendChild(btn);

    // The moment it matters most: signed in, PC off.
    const find = document.getElementById('findCard');
    if (find) {
      const alt = document.createElement('button');
      alt.className = 'btn btn-block cloud-offline-btn';
      alt.type = 'button';
      alt.textContent = 'Run in the cloud instead';
      alt.addEventListener('click', open);
      find.insertBefore(alt, document.getElementById('findSignOutBtn'));
      const sync = () => { alt.classList.toggle('hidden', !(creds && creds.projects && creds.projects.length)); };
      sync();
      window.addEventListener('storage', sync);
    }
  }

  async function open() {
    sheetOpen = true;
    el.classList.remove('hidden');
    render();
    await refreshCreds();
    render();
    await pollOnce();
    schedule();
  }
  function close() { sheetOpen = false; el.classList.add('hidden'); }

  function render() {
    const body = el.querySelector('.cloud-sheet-body');
    if (!creds || !creds.projects || !creds.projects.length) {
      body.innerHTML = `<div class="pick-label">Cloud runs</div><p class="cloud-m-dim">Cloud runs work even when your PC is off. Set them up once in Craft on your PC: open a project, tap the Cloud chip, then Set up. Open this again while the PC is on and it's ready.</p>`;
      return;
    }
    const repo = projectRepo();
    const options = creds.projects.map((p) => `<option value="${escapeHtml(p.repo)}" ${p.repo === repo ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('');
    const list = tasks.filter((t) => t.repo === repo).slice(0, 10).map((t) => `
      <li class="cloud-m-task ${t.status}">
        <div class="cloud-m-task-head"><span class="cloud-m-dot"></span><strong>${escapeHtml(STATUS[t.status] || t.status)}</strong><span class="cloud-m-dim">${escapeHtml(t.mode)}</span>${t.runUrl ? `<a href="${escapeHtml(t.runUrl)}" target="_blank" rel="noopener">log</a>` : ''}</div>
        <div class="cloud-m-prompt">${escapeHtml(t.prompt)}</div>
        ${LIVE.has(t.status) && t.progress ? `<div class="cloud-m-dim">${escapeHtml(t.progress.split('\n').filter(Boolean).pop() || '')}</div>` : ''}
        ${t.answer ? `<div class="cloud-m-answer">${fmt(t.answer)}</div>` : ''}
        ${t.files && t.files.length ? `<div class="cloud-m-dim">Changed ${t.files.length} file${t.files.length === 1 ? '' : 's'} on GitHub. Apply them from Craft on your PC (Cloud chip).</div>` : ''}
        ${t.error ? `<div class="cloud-m-error">${escapeHtml(t.error)}</div>` : ''}
      </li>`).join('');
    body.innerHTML = `
      <div class="pick-label">Cloud runs</div>
      <p class="cloud-m-dim">Runs on GitHub in your account, even with the PC off. It works on the last backup of the project.</p>
      <select class="cloud-m-select" aria-label="Project">${options}</select>
      <textarea class="cloud-m-input" rows="3" placeholder="What should Craft do?"></textarea>
      <div class="cloud-m-row">
        <div class="cloud-m-modes">${['Build', 'Ask', 'Plan'].map((m) => `<button type="button" data-cmode="${m}" class="${m === mode ? 'on' : ''}">${m}</button>`).join('')}</div>
        <button type="button" class="cloud-m-run">Run in the cloud</button>
      </div>
      <ul class="cloud-m-tasks">${list || '<li class="cloud-m-dim">No cloud runs from this phone yet.</li>'}</ul>`;
    body.querySelector('.cloud-m-select').addEventListener('change', (e) => { localStorage.setItem(KEY_PROJECT, e.target.value); render(); });
    body.querySelectorAll('[data-cmode]').forEach((b) => b.addEventListener('click', () => { mode = b.dataset.cmode; render(); }));
    const input = body.querySelector('.cloud-m-input');
    body.querySelector('.cloud-m-run').addEventListener('click', async () => {
      const text = input.value.trim();
      if (!text) { input.focus(); return; }
      input.value = '';
      await start(text);
    });
  }

  build();
  schedule();
})();
