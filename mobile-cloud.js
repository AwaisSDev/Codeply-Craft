// Craft Cloud on the phone.
//
// Two ways in:
//  - Chatting through the PC with its Cloud chip on: the PC replays each cloud
//    step as normal chat events, so mobile.js draws them like any run; this
//    file only adds the live cloud card (window.CraftCloudPhone.card) and the
//    blue wash that marks a cloud chat.
//  - PC off: a full-screen cloud chat that talks to api.github.com directly.
//    The PC hands over its GitHub login once (GET /api/cloud/credentials) or a
//    token is pasted here; mirrors are found on GitHub itself. Each run's steps
//    come from the runner's check run and are drawn with the same markup as the
//    normal chat (tool rows with - and + lines, thinking, what happened).
//    Code changes wait on the mirror until Craft on the PC applies them.
//
// Loaded after mobile.js and uses its globals (request, state, escapeHtml,
// TOOL_VERB, clip).
(() => {
  const API = 'https://api.github.com';
  const WORKFLOW = 'craft-cloud.yml';
  const KEY_CREDS = 'craft-cloud-creds';
  const KEY_TASKS = 'craft-cloud-tasks';
  const KEY_PROJECT = 'craft-cloud-project';
  const ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 8.5a4 4 0 0 1 .5 7.97V18Z"/></svg>';
  const STATUS = { starting: 'Starting', queued: 'Waiting for a runner', running: 'Working', done: 'Finished in the cloud', failed: 'Cloud run failed', cancelled: 'Cancelled' };
  const LIVE = new Set(['starting', 'queued', 'running']);
  const MIRROR_DESCRIPTION = 'Craft workspace mirror: a private backup that Craft cloud runs work in.';

  // ─── The live card: rotating word, countdown to the ~50s runner start, elapsed ──
  const VERBS = ['Codeplying', 'Cooking', 'Baking', 'Brewing', 'Whisking', 'Simmering', 'Tinkering', 'Crafting'];
  const START_ETA = 50;
  const dur = (s) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`);
  function liveParts(t) {
    const secs = Math.max(0, Math.round((Date.now() - (t.startedAt || Date.now())) / 1000));
    const verb = `${VERBS[Math.floor(secs / 3) % VERBS.length]}...`;
    if (t.status === 'running') return { verb, note: `Working on GitHub · ${dur(secs)}`, pct: null };
    const left = START_ETA - secs;
    const what = t.status === 'queued' ? 'Waiting for a GitHub runner' : 'Starting a GitHub runner';
    return { verb, note: `${what} · ${left > 0 ? `about ${left}s left` : `any second now (${dur(secs)})`}`, pct: Math.min(95, Math.round((secs / START_ETA) * 95)) };
  }
  const liveHtml = (t) => { const p = liveParts(t); return `<div class="cloud-m-verb">${escapeHtml(p.verb)}</div><div class="cloud-m-note">${escapeHtml(p.note)}</div><div class="cloud-m-bar${p.pct == null ? ' working' : ''}"><i style="${p.pct == null ? '' : `width:${p.pct}%`}"></i></div>`; };
  function paintLive(node, t) {
    const p = liveParts(t);
    const v = node.querySelector('.cloud-m-verb'); const n = node.querySelector('.cloud-m-note'); const bar = node.querySelector('.cloud-m-bar');
    if (v) v.textContent = p.verb;
    if (n) n.textContent = p.note;
    if (bar) { bar.classList.toggle('working', p.pct == null); bar.firstElementChild.style.width = p.pct == null ? '' : `${p.pct}%`; }
  }

  const fileStats = (task) => {
    const stats = new Map((task.stats || []).map((s) => [s.file, s]));
    const files = task.files || [];
    return files.slice(0, 8).map((f) => {
      const s = stats.get(f);
      return `<li><code>${escapeHtml(f)}</code>${s && s.added != null ? `<span class="stat-add">+${s.added}</span><span class="stat-del">−${s.removed}</span>` : ''}</li>`;
    }).join('') + (files.length > 8 ? `<li class="cloud-m-dim">and ${files.length - 8} more</li>` : '');
  };

  /** The card for one run. `applyHtml` is the PC chat's Apply button; the PC-off chat explains instead. */
  function cardHtml(task, { applyHtml = '' } = {}) {
    const live = LIVE.has(task.status);
    const files = task.files || [];
    let foot = '';
    if (task.status === 'done' && files.length) {
      foot = `<div class="cloud-m-foot"><span class="cloud-m-dim">${task.pulledAt ? 'Applied' : 'Changed'} ${files.length} file${files.length === 1 ? '' : 's'}${task.pulledAt ? ' to the project' : ', pushed to GitHub'}</span>${task.pulledAt ? '' : applyHtml}</div><ul class="cloud-m-files">${fileStats(task)}</ul>`;
    }
    return `<div class="cloud-m-card-head"><span class="cloud-m-icon">${ICON}</span>${live ? `<div class="cloud-m-live-block">${liveHtml(task)}</div>` : `<strong>${escapeHtml(STATUS[task.status] || task.status)}</strong>`}
        ${task.runUrl ? `<a href="${escapeHtml(task.runUrl)}" target="_blank" rel="noopener">log</a>` : ''}</div>
      ${task.error ? `<div class="cloud-m-error">${escapeHtml(task.error)}</div>` : ''}${foot}`;
  }

  // ─── In the normal phone chat (messages sent through the PC) ────────────
  const chatLive = new Map();
  function chatCard(task) {
    const feed = document.getElementById('chatFeed');
    if (!feed || !task) return;
    const pending = String(task.id).startsWith('pending-');
    let node = feed.querySelector(`.cloud-m-card[data-id="${CSS.escape(task.id)}"]`);
    if (!node && !pending) node = [...feed.querySelectorAll('.cloud-m-card[data-pending="1"]')].pop();
    if (!node) { node = document.createElement('div'); feed.append(node); }
    for (const [id] of chatLive) if (id.startsWith('pending-') && !pending) chatLive.delete(id);
    if (LIVE.has(task.status)) chatLive.set(task.id, task); else chatLive.delete(task.id);
    node.className = `cloud-m-card ${task.status}`;
    node.dataset.id = task.id;
    node.dataset.pending = pending ? '1' : '0';
    node.innerHTML = cardHtml(task, { applyHtml: '<button type="button" class="cloud-m-apply">Apply to project</button>' });
    const apply = node.querySelector('.cloud-m-apply');
    if (apply) apply.addEventListener('click', async () => {
      apply.disabled = true; apply.textContent = 'Applying...';
      try { await request('/api/cloud/apply', { method: 'POST', body: JSON.stringify({ sessionId: state.sessionId, taskId: task.id }) }); }
      catch (e) { apply.disabled = false; apply.textContent = 'Apply to project'; alert(e.message); }
    });
  }
  window.CraftCloudPhone = { card: chatCard };

  // ─── GitHub ────────────────────────────────────────────────────────────
  const fmt = (text) => escapeHtml(text || '')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  let creds = load(KEY_CREDS, null);          // { token, projects: [{ name, repo }], at, source }
  let tasks = load(KEY_TASKS, []);            // newest first, each with its steps (events)
  let mode = 'Build';
  let pollTimer = null;
  let isOpen = false;
  // A full localStorage (big runs) drops the oldest runs' steps rather than failing to save.
  const saveTasks = () => {
    for (let keep = tasks.length; keep >= 0; keep--) {
      try { localStorage.setItem(KEY_TASKS, JSON.stringify(tasks.map((t, i) => (i < keep ? t : { ...t, events: [] })))); return; } catch {}
    }
  };

  async function gh(method, route, body) {
    const res = await fetch(`${API}${route}`, {
      method,
      headers: { Authorization: `Bearer ${creds.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    if (!res.ok) throw new Error(res.status === 401 ? 'GitHub signed this phone out. Connect GitHub again.' : `GitHub: ${(json && json.message) || res.status}`);
    return json;
  }

  async function discoverMirrors() {
    const repos = await gh('GET', '/user/repos?affiliation=owner&sort=pushed&per_page=100');
    return (repos || [])
      .filter((r) => r.private && r.name.startsWith('craft-workspace-') && r.description === MIRROR_DESCRIPTION)
      .map((r) => ({ name: r.name.replace(/^craft-workspace-/, ''), repo: r.full_name }));
  }

  /** The GitHub login from the PC when it's reachable (quietly), else a pasted token; mirrors from GitHub. */
  async function refreshCreds() {
    try {
      const c = await request('/api/cloud/credentials');
      if (c && c.token) { creds = { ...c, at: Date.now(), source: 'pc' }; save(KEY_CREDS, creds); }
    } catch {}
    if (creds && creds.token) {
      try {
        const found = await discoverMirrors();
        const names = new Map((creds.projects || []).map((p) => [p.repo, p.name]));
        creds = { ...creds, expired: false, projects: found.map((p) => ({ ...p, name: names.get(p.repo) || p.name })) };
        save(KEY_CREDS, creds);
      } catch (e) { if (/signed this phone out/.test(e.message)) { creds = { ...creds, expired: true }; save(KEY_CREDS, creds); } }
    }
    syncOfflineButton();
    return creds;
  }

  async function useToken(token) {
    creds = { token: token.trim(), projects: [], at: Date.now(), source: 'phone' };
    const me = await gh('GET', '/user');
    creds.login = me.login;
    creds.projects = await discoverMirrors();
    save(KEY_CREDS, creds);
  }

  let syncOfflineButton = () => {};
  const projectRepo = () => {
    if (!creds || !creds.projects || !creds.projects.length) return null;
    const want = localStorage.getItem(KEY_PROJECT);
    return (creds.projects.find((p) => p.repo === want) || creds.projects[0]).repo;
  };
  // One rolling chat per mirror, so follow-ups from the phone keep context.
  const sessionFor = (repo) => `phone${repo.replace(/[^A-Za-z0-9]/g, '').slice(-24)}`;

  async function start(prompt) {
    const repo = projectRepo();
    const id = `${Date.now().toString(36)}${Math.random().toString(16).slice(2, 8)}`;
    const task = { id, repo, prompt, mode, status: 'starting', startedAt: Date.now(), events: [] };
    tasks = [task, ...tasks].slice(0, 20);
    saveTasks();
    render();
    try {
      await gh('POST', `/repos/${repo}/actions/workflows/${WORKFLOW}/dispatches`, { ref: 'main', inputs: { prompt, mode, task_id: id, session_id: sessionFor(repo) } });
    } catch (e) {
      Object.assign(task, { status: 'failed', error: e.message });
    }
    saveTasks();
    render();
    schedule();
  }

  /** Why a run died before Craft reported back (same rules as the PC). */
  async function diagnose(repo, runId) {
    try {
      const jobs = (await gh('GET', `/repos/${repo}/actions/runs/${runId}/jobs`)).jobs || [];
      const job = jobs.find((j) => j.conclusion === 'failure' || j.conclusion === 'timed_out') || jobs[0];
      if (!job) return null;
      if (job.conclusion === 'timed_out') return 'The run hit its 60-minute limit and was stopped.';
      const step = (job.steps || []).find((s) => s.conclusion === 'failure');
      let log = '';
      try {
        const res = await fetch(`${API}/repos/${repo}/actions/jobs/${job.id}/logs`, { headers: { Authorization: `Bearer ${creds.token}` } });
        if (res.ok) log = await res.text();
      } catch {}
      if (/No matching version found for codeply-cli|notarget[\s\S]{0,200}codeply-cli/i.test(log)) return 'GitHub couldn\'t install Craft\'s cloud engine: that version isn\'t on npm yet. Publish it, then run again.';
      if (/Resource not accessible by integration/i.test(log)) return 'GitHub refused the run permission to save its work (mirror repo Settings > Actions > Workflow permissions).';
      if (step) return step.name === 'Run Craft' ? 'Craft stopped before it could report back. Open the log for details.' : `The "${step.name}" step failed on GitHub.`;
      return null;
    } catch { return null; }
  }

  async function pollOnce() {
    for (const t of tasks.filter((x) => LIVE.has(x.status))) {
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
        let data = {};
        try { data = JSON.parse((check && check.output && check.output.text) || '{}'); } catch {}
        if (Array.isArray(data.events)) t.events = data.events;
        if (check && check.status === 'completed') {
          Object.assign(t, { status: check.conclusion === 'success' ? 'done' : 'failed', answer: data.answer || '', files: data.files || [], stats: data.stats || [], error: data.error || null });
        } else if (run.status === 'completed') {
          Object.assign(t, { status: run.conclusion === 'cancelled' ? 'cancelled' : 'failed', error: run.conclusion === 'cancelled' ? null : (await diagnose(t.repo, run.id)) || 'The run ended before Craft could report back. The log has details.' });
        } else t.status = run.status === 'in_progress' ? 'running' : 'queued';
      } catch (e) { t.lastError = e.message; }
    }
    saveTasks();
    if (isOpen) render();
  }

  // One failed check (flaky phone network, a draw error) must never end the loop.
  let polling = false;
  async function pollSafe() {
    if (polling) return;
    polling = true;
    try { await pollOnce(); } catch (e) { console.warn('[cloud] check failed:', e.message); } finally { polling = false; }
  }
  function schedule() {
    clearTimeout(pollTimer);
    if (!tasks.some((t) => LIVE.has(t.status))) return;
    pollTimer = setTimeout(async () => { await pollSafe(); schedule(); }, 3000);
  }
  // Phones pause background pages; catch up the moment it's looked at again.
  const catchUp = () => { if (document.visibilityState === 'visible' && tasks.some((t) => LIVE.has(t.status))) pollSafe().then(schedule); };
  document.addEventListener('visibilitychange', catchUp);
  window.addEventListener('focus', catchUp);
  window.addEventListener('pageshow', catchUp);

  // ─── The cloud chat's rows: same markup as the normal phone chat ────────
  const CHEV = '<svg class="tool-chev" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M9 6l6 6-6 6"/></svg>';
  const clipLines = (s, n) => (typeof clip === 'function' ? clip(s, n) : String(s || ''));
  const verbFor = (name) => (typeof TOOL_VERB === 'object' && TOOL_VERB[name]) || name || 'Ran';

  function toolRow(e) {
    const failed = e.ok === false || (typeof e.exitCode === 'number' && e.exitCode !== 0);
    const stats = [];
    if (typeof e.added === 'number' && (e.name === 'edit_file' || e.name === 'write_file')) stats.push(`<span class="stat-add">+${e.added}</span>`);
    if (typeof e.removed === 'number' && e.name === 'edit_file') stats.push(`<span class="stat-del">−${e.removed}</span>`);
    if (typeof e.exitCode === 'number') stats.push(`<span class="${e.exitCode === 0 ? 'stat-ok' : 'stat-del'}">exit ${e.exitCode}</span>`);
    const a = e.args || {};
    let body = '';
    if (e.name === 'run' && a.command) body = `<div class="tool-body-label">Command</div><pre class="tool-code">${escapeHtml(a.command)}</pre>`;
    else if (e.name === 'edit_file' && (a.search || a.replace)) {
      body = `<div class="tool-body-label">${escapeHtml(a.path || '')}</div>`
        + `<pre class="tool-code diff-del">${escapeHtml(clipLines(a.search, 40)).replace(/^/gm, '− ')}</pre>`
        + `<pre class="tool-code diff-add">${escapeHtml(clipLines(a.replace, 40)).replace(/^/gm, '+ ')}</pre>`;
    } else if (e.name === 'write_file') body = `<div class="tool-body-label">${escapeHtml(a.path || '')}${typeof e.added === 'number' ? ` · ${e.added} lines` : ''}</div>`;
    else if (Object.keys(a).length) body = `<pre class="tool-code">${escapeHtml(clipLines(Object.entries(a).map(([k, v]) => `${k}: ${v}`).join('\n'), 20))}</pre>`;
    const label = e.summary || a.path || a.command || a.pattern || '';
    return `<details class="tool-item${failed ? ' failed' : ''}${body ? '' : ' no-body'}"><summary>
      <span class="tool-verb">${escapeHtml(verbFor(e.name))}</span><span class="tool-label">${escapeHtml(label)}</span>
      ${stats.length ? `<span class="tool-stats">${stats.join(' ')}</span>` : ''}${CHEV}</summary><div class="tool-body">${body}</div></details>`;
  }

  function eventHtml(e) {
    if (e.t === 'tool') return toolRow(e);
    if (e.t === 'text' || e.t === 'reasoning') {
      return `<details class="thinking-step"><summary><span>Thinking</span>${CHEV}</summary><div class="thinking-text">${fmt(e.text)}</div></details>`;
    }
    if (e.t === 'notice') return `<div class="cloud-m-notice">${escapeHtml(e.text)}</div>`;
    if (e.t === 'summary') {
      const check = (c) => {
        const passed = c.ok && (c.exitCode === undefined || c.exitCode === null || c.exitCode === 0);
        return `<div class="ts-check ${passed ? 'pass' : 'fail'}">${passed ? '✓' : '✗'} <code>${escapeHtml(c.label)}</code>${typeof c.exitCode === 'number' ? ` <span>exit ${c.exitCode}</span>` : ''}</div>`;
      };
      return `<div class="turn-summary"><div class="ts-head">What actually happened</div>
        ${(e.files || []).length ? `<div class="ts-files">${e.files.map((f) => `<span>${escapeHtml(f)}</span>`).join('')}</div>` : ''}${(e.checks || []).map(check).join('')}</div>`;
    }
    if (e.t === 'pushed') {
      const n = (e.files || []).length;
      return `<div class="cloud-m-pushed"><div class="cloud-m-pushed-head">${ICON}<span>Committed and pushed ${n} file${n === 1 ? '' : 's'} to <code>${escapeHtml(e.branch)}</code></span><span class="stat-add">+${e.added || 0}</span><span class="stat-del">−${e.removed || 0}</span></div>
        <ul class="cloud-m-files">${(e.files || []).slice(0, 12).map((f) => `<li><code>${escapeHtml(f.file)}</code>${f.added != null ? `<span class="stat-add">+${f.added}</span><span class="stat-del">−${f.removed}</span>` : ''}</li>`).join('')}</ul></div>`;
    }
    return '';
  }

  function taskHtml(t) {
    const events = (t.events || []).map(eventHtml).join('');
    const note = t.status === 'done' && (t.files || []).length ? '<div class="cloud-m-notice">Craft on your PC applies these changes: open the chat there, or the Cloud chip, and tap Apply.</div>' : '';
    return `<article class="message-bubble user">${escapeHtml(t.prompt)}</article>
      <div class="cloud-m-card ${t.status}" data-live="${escapeHtml(t.id)}">${cardHtml(t)}</div>
      ${events}
      ${t.answer ? `<article class="message-bubble agent">${fmt(t.answer)}</article>` : ''}${note}`;
  }

  // ─── The PC-off cloud chat screen ────────────────────────────────────────
  let el = null;
  function build() {
    el = document.createElement('section');
    el.className = 'cloud-chat hidden';
    el.id = 'cloudChat';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Cloud chat');
    el.innerHTML = `
      <header class="cloud-chat-top">
        <button class="icon-btn" data-act="back" aria-label="Back"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg></button>
        <span class="cloud-chat-mark">${ICON}</span>
        <div class="cloud-chat-title"><strong>Cloud</strong><select class="cloud-chat-project" aria-label="Project"></select></div>
      </header>
      <div class="cloud-chat-feed"></div>
      <form class="cloud-chat-composer">
        <textarea rows="1" placeholder="Ask Craft in the cloud..."></textarea>
        <div class="cloud-chat-row">
          <div class="cloud-m-modes">${['Build', 'Ask', 'Plan'].map((m) => `<button type="button" data-cmode="${m}">${m}</button>`).join('')}</div>
          <button type="submit" class="cloud-chat-send" aria-label="Send"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg></button>
        </div>
      </form>`;
    document.body.appendChild(el);
    el.querySelector('[data-act="back"]').addEventListener('click', close);
    el.querySelector('.cloud-chat-project').addEventListener('change', (e) => { localStorage.setItem(KEY_PROJECT, e.target.value); render(true); });
    el.querySelectorAll('[data-cmode]').forEach((b) => b.addEventListener('click', () => { mode = b.dataset.cmode; paintModes(); }));
    const input = el.querySelector('textarea');
    input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = `${Math.min(140, input.scrollHeight)}px`; });
    el.querySelector('.cloud-chat-composer').addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text || !projectRepo()) { input.focus(); return; }
      input.value = ''; input.style.height = 'auto';
      await start(text);
    });

    const btn = document.createElement('button');
    btn.className = 'icon-btn cloud-top-btn';
    btn.setAttribute('aria-label', 'Cloud chat');
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
      alt.addEventListener('click', open);
      find.insertBefore(alt, document.getElementById('findSignOutBtn'));
      syncOfflineButton = () => { alt.textContent = creds && creds.token ? 'Run in the cloud instead' : 'Use Craft Cloud instead'; };
      syncOfflineButton();
    }
  }

  function paintModes() { el.querySelectorAll('[data-cmode]').forEach((b) => b.classList.toggle('on', b.dataset.cmode === mode)); }

  async function open() {
    isOpen = true;
    el.classList.remove('hidden');
    render(true);
    await refreshCreds();
    render(true);
    await pollSafe();
    schedule();
  }
  function close() { isOpen = false; el.classList.add('hidden'); }

  let lastSig = '';
  function render(force = false) {
    const feed = el.querySelector('.cloud-chat-feed');
    const composer = el.querySelector('.cloud-chat-composer');
    const select = el.querySelector('.cloud-chat-project');
    paintModes();
    if (!creds || !creds.token || creds.expired) {
      composer.classList.add('hidden');
      select.classList.add('hidden');
      const link = 'https://github.com/settings/tokens/new?scopes=repo,workflow&description=Craft%20Cloud%20(phone)';
      feed.innerHTML = `<div class="cloud-chat-empty">
        <div class="cloud-chat-empty-mark">${ICON}</div>
        <h2>Craft Cloud</h2>
        <p>Runs on GitHub in your own account, even with your PC off. This phone needs to reach your GitHub first.</p>
        <p><b>Easiest:</b> open Craft on your PC once. This phone picks up your GitHub login on its own.</p>
        <p><b>PC is off right now?</b> <a href="${link}" target="_blank" rel="noopener">Create a GitHub token</a> (repo and workflow come ticked), then paste it here. It stays on this phone.</p>
        <input class="cloud-m-select cloud-m-token" type="password" autocomplete="off" placeholder="ghp_... or github_pat_...">
        <button type="button" class="cloud-m-run" data-act="token">Connect GitHub</button>
        <div class="cloud-m-error hidden" data-err></div></div>`;
      feed.querySelector('[data-act="token"]').addEventListener('click', async (e) => {
        const input = feed.querySelector('.cloud-m-token');
        const err = feed.querySelector('[data-err]');
        if (!input.value.trim()) { input.focus(); return; }
        e.target.disabled = true; e.target.textContent = 'Checking...';
        try { await useToken(input.value); syncOfflineButton(); render(true); }
        catch (ex) { creds = null; err.textContent = ex.message; err.classList.remove('hidden'); e.target.disabled = false; e.target.textContent = 'Connect GitHub'; }
      });
      lastSig = '';
      return;
    }
    if (!creds.projects || !creds.projects.length) {
      composer.classList.add('hidden');
      select.classList.add('hidden');
      feed.innerHTML = `<div class="cloud-chat-empty"><div class="cloud-chat-empty-mark">${ICON}</div><h2>No cloud projects yet</h2>
        <p>GitHub is connected${creds.login ? ` as <b>${escapeHtml(creds.login)}</b>` : ''}. In Craft on your PC, open a project, tap the <b>Cloud</b> chip under the message box, then <b>Set up</b>. It shows up here right after, even with the PC off.</p>
        <button type="button" class="cloud-m-run" data-act="recheck">Check again</button></div>`;
      feed.querySelector('[data-act="recheck"]').addEventListener('click', async () => { await refreshCreds(); render(true); });
      lastSig = '';
      return;
    }
    composer.classList.remove('hidden');
    select.classList.remove('hidden');
    const repo = projectRepo();
    const opts = creds.projects.map((p) => `<option value="${escapeHtml(p.repo)}" ${p.repo === repo ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('');
    if (select.innerHTML !== opts) select.innerHTML = opts;
    const list = tasks.filter((t) => t.repo === repo).slice().reverse();
    // Redraw only when something changed, so open rows stay open while it works.
    const sig = `${repo}|${list.map((t) => `${t.id}:${t.status}:${(t.events || []).length}:${t.answer ? 1 : 0}`).join(',')}`;
    if (!force && sig === lastSig) return;
    const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 120;
    const openRows = new Set([...feed.querySelectorAll('details[open]')].map((d) => d.dataset.k));
    feed.innerHTML = list.length ? list.map(taskHtml).join('') : `<div class="cloud-chat-empty"><div class="cloud-chat-empty-mark">${ICON}</div><h2>Ask anything</h2>
      <p>Craft works on the last backup of <b>${escapeHtml((creds.projects.find((p) => p.repo === repo) || {}).name || '')}</b> on GitHub. You'll see every command and change here, like a normal chat.</p></div>`;
    feed.querySelectorAll('details').forEach((d, i) => { d.dataset.k = String(i); if (openRows.has(d.dataset.k)) d.open = true; });
    if (nearBottom || force || sig.split('|')[1] !== lastSig.split('|')[1]) feed.scrollTop = feed.scrollHeight;
    lastSig = sig;
  }

  build();
  schedule();

  // Keep live cards moving, and mark cloud chats in the normal phone chat.
  setInterval(() => {
    if (isOpen) {
      for (const node of el.querySelectorAll('.cloud-m-card[data-live]')) {
        const t = tasks.find((x) => x.id === node.dataset.live);
        if (t && LIVE.has(t.status)) paintLive(node, t);
      }
    }
    for (const [id, t] of chatLive) {
      const node = document.querySelector(`#chatFeed .cloud-m-card[data-id="${CSS.escape(id)}"]`);
      if (node) paintLive(node, t); else chatLive.delete(id);
    }
    const panel = document.getElementById('chatPanel');
    if (panel && typeof state !== 'undefined') {
      const meta = (state.sessions || []).find((s) => s.id === state.sessionId);
      panel.classList.toggle('cloud-session', !!(meta && meta.cloud) || !!document.querySelector('#chatFeed .cloud-m-card'));
    }
  }, 1000);

  // Pick up the GitHub login from the PC whenever it's reachable, so the cloud
  // is ready before the PC is ever off. Quiet: a PC that's off just fails.
  const fromPc = () => creds && creds.source === 'pc' && creds.token && Date.now() - creds.at < 24 * 3600 * 1000;
  setTimeout(() => { if (!fromPc()) refreshCreds(); }, 4000);
  setInterval(() => { if (!fromPc()) refreshCreds(); }, 60000);
})();
