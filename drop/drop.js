// The Alt+C drop's window: one chat with Craft's agent, in the corner of the screen.
// Everything runs in the main process (drop.js there); this page sends messages
// and draws the events that come back: the agent's steps, its replies, and the
// cards it waits on (an OK for a deploy, a question, Undo).
(() => {
  const api = window.drop;
  const md = (t) => (window.CrewMarkdown ? window.CrewMarkdown.md(t) : esc(t));
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const S = {
    project: null, projects: [], models: { selected: 'auto', models: [] }, recent: [], recentMore: false, recentLoading: false,
    mode: 'Build', bypass: readBypass(), sessionId: null, running: false, sending: false, hotkey: null,
  };
  function readBypass() { try { return localStorage.getItem('craft-drop-bypass') === '1'; } catch { return false; } }
  const card = $('card'); const thread = $('thread'); const feed = $('feed'); const input = $('input'); const sendBtn = $('sendBtn');

  const ICON = {
    check: '<svg viewBox="0 0 16 16"><path d="M3.5 8.5 6.5 11.5 12.5 4.5"/></svg>',
    x: '<svg viewBox="0 0 16 16"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>',
    tick: '<svg class="tick" viewBox="0 0 16 16"><path d="M3.5 8.5 6.5 11.5 12.5 4.5"/></svg>',
    chat: '<svg viewBox="0 0 16 16"><path d="M3 4.5C3 3.7 3.7 3 4.5 3h7c.8 0 1.5.7 1.5 1.5v5c0 .8-.7 1.5-1.5 1.5H7l-3 2.5V11h0c-.6 0-1-.4-1-1z"/></svg>',
    folder: '<svg viewBox="0 0 16 16"><path d="M2 4.5c0-.8.7-1.5 1.5-1.5h2.6l1.4 1.5h5c.8 0 1.5.7 1.5 1.5v5.5c0 .8-.7 1.5-1.5 1.5h-9c-.8 0-1.5-.7-1.5-1.5z"/></svg>',
    plus: '<svg viewBox="0 0 16 16"><path d="M8 3.5v9M3.5 8h9"/></svg>',
  };

  // What a step says while it runs, and after.
  const VERB = {
    read_file: ['Reading', 'Read'], list_dir: ['Listing', 'Listed'], search: ['Searching', 'Searched'],
    write_file: ['Writing', 'Wrote'], edit_file: ['Editing', 'Edited'], apply_patch: ['Editing', 'Edited'],
    run: ['Running', 'Ran'], browser_check: ['Checking', 'Checked'], web_search: ['Searching the web for', 'Searched the web for'],
    image_search: ['Searching images for', 'Searched images for'], fetch_image: ['Downloading', 'Downloaded'],
    view_images: ['Looking at', 'Looked at'], todo: ['Updating the task list', 'Updated the task list'],
    use_skill: ['Loading skill', 'Loaded skill'], list_skills: ['Searching skills', 'Searched skills'],
    ask_user: ['Asking you', 'Asked you'], gmail_send: ['Emailing', 'Emailed'], gmail_search: ['Searching Gmail', 'Searched Gmail'],
    slack_post_message: ['Posting', 'Posted'], vercel_deploy: ['Deploying', 'Deployed'], publish_deploy: ['Publishing', 'Published'],
    publish_github: ['Pushing to GitHub', 'Pushed to GitHub'], github_create_repo: ['Creating repo', 'Created repo'],
    supabase_setup: ['Setting up database', 'Set up database'], supabase_schema: ['Applying schema', 'Applied schema'],
    supabase_sql: ['Running SQL', 'Ran SQL'], publish_check: ['Checking for publishing', 'Checked for publishing'],
    design_reference_search: ['Searching designs', 'Searched designs'], mcp: ['Using', 'Used'],
  };
  const TOOL_NAME = {
    write_file: 'write a file', edit_file: 'edit a file', apply_patch: 'edit files', run: 'run a command',
    fetch_image: 'download an image', gmail_send: 'send an email', slack_post_message: 'post to Slack',
    vercel_deploy: 'deploy to Vercel', publish_deploy: 'publish to Vercel', publish_github: 'push to GitHub',
    github_create_repo: 'create a GitHub repo', supabase_sql: 'run SQL on Supabase', supabase_schema: 'run SQL on Supabase',
    supabase_setup: 'set up the database', supabase_api: 'change Supabase', vercel_api: 'change Vercel',
    supabase_create_project: 'create a Supabase project', supabase_delete_project: 'delete a Supabase project',
  };
  const verb = (name, done) => (VERB[name] ? VERB[name][done ? 1 : 0] : (done ? 'Used ' : 'Using ') + String(name || 'a tool').replace(/_/g, ' '));
  const labelOf = (ev) => {
    if (ev.name === 'apply_patch' && Array.isArray(ev.meta?.files) && ev.meta.files.length) return ev.meta.files.join(', ');
    const a = ev.args || {};
    return ev.summary || ev.label || a.path || a.command || a.pattern || a.query || a.url || '';
  };
  const short = (p) => String(p || '').replace(/\\/g, '/').split('/').slice(-2).join('/');

  // ─── layout helpers ───────────────────────────────────────────────────────
  const nearBottom = () => thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
  function scrollDown(force) { if (force || nearBottom()) requestAnimationFrame(() => { thread.scrollTop = thread.scrollHeight; }); }
  function add(el, force) { const stick = force || nearBottom(); feed.appendChild(el); placeWorking(); scrollDown(stick); return el; }
  function h(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; }
  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 132) + 'px';
    input.style.overflowY = input.scrollHeight > 132 ? 'auto' : 'hidden';
  }

  // ─── header, chips, composer ──────────────────────────────────────────────
  function renderChips() {
    $('projName').textContent = S.project ? S.project.name : 'Choose a project';
    const sel = S.models.models.find((m) => m.id === S.models.selected);
    $('modelName').textContent = sel ? sel.name || sel.model : 'Haze 2';
    document.querySelectorAll('#modeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === S.mode));
    $('permName').textContent = S.bypass ? 'Full access' : 'Approve manually';
    $('permBtn').classList.toggle('full', S.bypass);
    $('emptySub').textContent = S.project
      ? `Ask anything, or give it a task in ${S.project.name}.`
      : 'Ask anything, or start something new. Craft makes the folder for you.';
    input.placeholder = S.sessionId ? 'Follow up' : 'Ask Craft or give it a task';
    syncSend();
  }
  function syncSend() {
    card.classList.toggle('running', S.running);
    sendBtn.disabled = !S.running && (S.sending || !input.value.trim());
    sendBtn.setAttribute('aria-label', S.running ? 'Stop' : 'Send');
  }

  const recentRow = (r) => {
    const b = h(`<button type="button" data-id="${esc(r.id)}">${ICON.chat}<span class="t">${esc(r.title)}</span><span class="when">${esc(ago(r.updatedAt))}</span></button>`);
    b.addEventListener('click', () => openChat(r.id));
    return b;
  };
  function renderRecent() {
    const box = $('recent');
    box.innerHTML = '';
    if (!S.recent.length) return;
    box.appendChild(h('<div class="recent-title">Recent</div>'));
    S.recent.forEach((r) => box.appendChild(recentRow(r)));
    fillRecent();
  }
  // Scrolling near the end of the list brings in the next page.
  async function moreRecent() {
    if (!S.recentMore || S.recentLoading || card.classList.contains('has-chat')) return;
    S.recentLoading = true;
    try {
      const page = await api.recent(S.recent.length);
      const seen = new Set(S.recent.map((r) => r.id));
      const fresh = (page.items || []).filter((r) => !seen.has(r.id));
      S.recent.push(...fresh);
      S.recentMore = !!page.more && fresh.length > 0;
      const box = $('recent');
      fresh.forEach((r) => box.appendChild(recentRow(r)));
    } finally { S.recentLoading = false; }
    fillRecent();
  }
  // A tall window and a short first page: keep loading until it can scroll.
  function fillRecent() {
    requestAnimationFrame(() => { if (S.recentMore && thread.scrollHeight <= thread.clientHeight + 40) moreRecent(); });
  }
  thread.addEventListener('scroll', () => {
    if (thread.scrollHeight - thread.scrollTop - thread.clientHeight < 160) moreRecent();
  });
  function ago(t) {
    const m = Math.round((Date.now() - (t || 0)) / 60000);
    if (m < 1) return 'now'; if (m < 60) return `${m}m`; const hr = Math.round(m / 60);
    if (hr < 24) return `${hr}h`; return `${Math.round(hr / 24)}d`;
  }

  async function loadState() {
    const st = await api.state();
    S.hotkey = st.hotkey;
    S.projects = st.projects || [];
    if (!S.sessionId || !S.project) S.project = st.project || S.project;
    S.models = st.models || S.models;
    S.recent = (st.recent && st.recent.items) || [];
    S.recentMore = !!(st.recent && st.recent.more);
    if (S.sessionId) S.running = (st.running || []).includes(S.sessionId);
    renderChips(); renderRecent();
    // The page was reloaded: pick the chat back up instead of starting blank.
    if (!restored) { restored = true; if (!S.sessionId && st.current) await openChat(st.current); }
  }
  let restored = false;

  // ─── menus ────────────────────────────────────────────────────────────────
  const menu = $('menu');
  function openMenu(anchor, html, below) {
    menu.innerHTML = html; menu.hidden = false;
    const a = anchor.getBoundingClientRect(); const c = card.getBoundingClientRect();
    menu.style.left = Math.max(6, Math.min(a.left - c.left, c.width - menu.offsetWidth - 6)) + 'px';
    if (below) { menu.style.top = (a.bottom - c.top + 4) + 'px'; menu.style.bottom = ''; }
    else { menu.style.bottom = (c.bottom - a.top + 4) + 'px'; menu.style.top = ''; }
    return menu;
  }
  function closeMenu() { menu.hidden = true; menu.innerHTML = ''; }
  document.addEventListener('mousedown', (e) => { if (!menu.hidden && !menu.contains(e.target) && !e.target.closest('.chip')) closeMenu(); });

  $('projBtn').addEventListener('click', (e) => {
    if (!menu.hidden) return closeMenu();
    const rows = S.projects.map((p) => `<button type="button" data-p="${esc(p.path)}">${ICON.folder}<span class="t">${esc(p.name)}</span>${S.project && S.project.path === p.path ? ICON.tick : ''}</button>`).join('');
    const m = openMenu(e.currentTarget, `<div class="lbl">Projects</div>${rows || ''}${rows ? '<hr>' : ''}<button type="button" data-open>${ICON.plus}<span class="t">Open a folder…</span></button>`, true);
    m.querySelectorAll('[data-p]').forEach((b) => b.addEventListener('click', async () => {
      closeMenu();
      const p = await api.useProject(b.dataset.p);
      if (p && (!S.project || S.project.path !== p.path)) { S.project = p; newChat(); }
    }));
    m.querySelector('[data-open]').addEventListener('click', async () => {
      closeMenu();
      const p = await api.chooseProject();
      if (p) { S.project = p; if (!S.projects.some((x) => x.path === p.path)) S.projects.unshift(p); newChat(); }
    });
  });

  $('modelBtn').addEventListener('click', (e) => {
    if (!menu.hidden) return closeMenu();
    const all = [{ id: 'auto', name: 'Haze 2', sub: 'Routes to the right model' }, ...S.models.models.map((m) => ({ id: m.id, name: m.name || m.model, sub: m.kind === 'ollama' ? 'Ollama' : '' }))];
    const m = openMenu(e.currentTarget, '<div class="lbl">Model</div>' + all.map((x) =>
      `<button type="button" data-id="${esc(x.id)}"><span class="t">${esc(x.name)}</span>${x.sub ? `<span class="s">${esc(x.sub)}</span>` : ''}${x.id === S.models.selected ? ICON.tick : ''}</button>`).join(''));
    m.querySelectorAll('[data-id]').forEach((b) => b.addEventListener('click', async () => {
      closeMenu();
      const r = await api.selectModel(b.dataset.id);
      if (r && r.ok && r.state) { S.models = r.state; renderChips(); }
      else if (r && r.error) addNote(r.error, 'error');
    }));
  });

  $('permBtn').addEventListener('click', (e) => {
    if (!menu.hidden) return closeMenu();
    const opts = [
      { full: false, name: 'Approve manually', sub: 'Asks before edits, commands and deploys' },
      { full: true, name: 'Full access', sub: 'Runs everything without asking' },
    ];
    const m = openMenu(e.currentTarget, '<div class="lbl">Permissions</div>' + opts.map((o) =>
      `<button type="button" data-full="${o.full ? 1 : 0}"><span class="t">${o.name}<span class="s sub">${o.sub}</span></span>${o.full === S.bypass ? ICON.tick : ''}</button>`).join(''));
    m.querySelectorAll('[data-full]').forEach((b) => b.addEventListener('click', () => {
      closeMenu();
      S.bypass = b.dataset.full === '1';
      try { localStorage.setItem('craft-drop-bypass', S.bypass ? '1' : '0'); } catch {}
      renderChips();
    }));
  });

  document.querySelectorAll('#modeSeg button').forEach((b) => b.addEventListener('click', () => { S.mode = b.dataset.mode; renderChips(); input.focus(); }));
  $('newBtn').addEventListener('click', () => { newChat(); input.focus(); });
  $('craftBtn').addEventListener('click', () => api.openInCraft(S.sessionId));
  $('hideBtn').addEventListener('click', () => api.hide());

  // ─── the chat ─────────────────────────────────────────────────────────────
  let steps = null;        // the open block of step rows
  let working = null;      // "Working…" row, kept at the bottom while running
  let workingTimer = null;
  let startedAt = 0;

  function newChat() {
    S.sessionId = null; S.running = false;
    feed.innerHTML = ''; steps = null; stopWorking();
    card.classList.remove('has-chat');
    api.showing(null);
    loadState();
  }

  function stepsBlock() {
    // every other kind of row resets `steps`, so consecutive steps share one block
    if (!steps) steps = add(h('<div class="steps"></div>'));
    return steps;
  }

  function stepRow(name, label, state, added, removed) {
    const st = state === 'run' ? '<span class="spin"></span>' : state === 'ok' ? ICON.check : ICON.x;
    const n = typeof added === 'number' && (added || removed)
      ? `<span class="n">${added ? `<span class="a">+${added}</span>` : ''}${removed ? `<span class="r">−${removed}</span>` : ''}</span>` : '';
    const l = label ? `<span class="l" title="${esc(label)}">${esc(name === 'run' ? label : short(label) || label)}</span>` : '';
    return h(`<div class="step ${state === 'run' ? 'run' : state}" data-tool="${esc(name)}"><span class="st">${st}</span><span class="v">${esc(verb(name, state !== 'run'))}</span>${l}${n}</div>`);
  }

  // Long runs: keep the last few steps in view, fold the rest.
  function foldSteps(block) {
    const rows = [...block.querySelectorAll('.step')];
    const hidden = rows.length - 5;
    let more = block.querySelector('.more');
    if (block.dataset.open === '1' || hidden <= 0) { if (more) more.remove(); rows.forEach((r) => { r.hidden = false; }); return; }
    rows.forEach((r, i) => { r.hidden = i < hidden; });
    if (!more) {
      more = h('<button type="button" class="more"></button>');
      more.addEventListener('click', () => { block.dataset.open = '1'; foldSteps(block); });
      block.prepend(more);
    }
    more.textContent = `${hidden} earlier step${hidden === 1 ? '' : 's'}`;
  }

  function addStep(name, label, state, added, removed) {
    const block = stepsBlock();
    const stick = nearBottom();
    block.appendChild(stepRow(name, label, state, added, removed));
    foldSteps(block);
    scrollDown(stick);
  }

  function endStep(ev) {
    const rows = [...feed.querySelectorAll(`.step.run[data-tool="${CSS.escape(ev.name)}"]`)];
    const row = rows[rows.length - 1];
    const fresh = stepRow(ev.name, labelOf(ev), ev.ok ? 'ok' : 'bad', ev.meta?.added, ev.meta?.removed);
    if (row) { fresh.hidden = row.hidden; row.replaceWith(fresh); } else addStep(ev.name, labelOf(ev), ev.ok ? 'ok' : 'bad', ev.meta?.added, ev.meta?.removed);
  }

  function addUser(text) { steps = null; add(h(`<div class="msg-user">${esc(text)}</div>`), true); }
  function addAi(text) { steps = null; const el = h('<div class="msg-ai"></div>'); el.innerHTML = md(text); add(el); }
  function addNote(text, level) { steps = null; add(h(`<div class="note ${esc(level || '')}">${esc(text)}</div>`)); }

  function startWorking() {
    startedAt = startedAt || Date.now();
    if (!working) {
      working = h('<div class="working"><span class="spin"></span><span class="shine">Working</span><span class="time"></span></div>');
      feed.appendChild(working);
      clearInterval(workingTimer);
      workingTimer = setInterval(tickWorking, 1000);
    }
    tickWorking(); scrollDown();
  }
  function tickWorking() {
    if (!working) return;
    const s = Math.round((Date.now() - startedAt) / 1000);
    working.querySelector('.time').textContent = s >= 3 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : '';
  }
  function stopWorking() { clearInterval(workingTimer); workingTimer = null; if (working) working.remove(); working = null; startedAt = 0; }
  function placeWorking() {
    if (!working) return;
    if (feed.lastElementChild !== working) feed.appendChild(working);
    // waiting on you, not working: the card says so
    working.hidden = !!feed.querySelector('.ask:not(.done)');
  }

  // The agent wants an OK.
  function addApproval(ev) {
    steps = null;
    const danger = !!ev.danger;
    const what = TOOL_NAME[ev.tool] || String(ev.tool || 'do this').replace(/_/g, ' ');
    const detail = ev.detail || (ev.draft ? `To: ${ev.draft.to || ''}\n${ev.draft.subject || ''}` : '');
    const always = ev.tool === 'run' ? Array.isArray(ev.alwaysScope) && ev.alwaysScope.length > 0 : !danger;
    const el = add(h(`<div class="ask ${danger ? 'danger' : ''}" data-req="${ev.requestId}">
      <h3>${danger ? 'This one needs a careful look' : `Allow Craft to ${esc(what)}?`}</h3>
      ${ev.title ? `<div class="what">${esc(ev.title)}</div>` : ''}
      ${detail ? `<pre>${esc(String(detail).slice(0, 1200))}</pre>` : ''}
      <div class="btns">
        <button type="button" class="btn primary" data-v="once">Allow</button>
        ${always ? `<button type="button" class="btn" data-v="always">${ev.tool === 'run' ? `Always allow ${esc(ev.alwaysScope.join(', '))}` : 'Always allow'}</button>` : ''}
        <button type="button" class="btn" data-v="reject">Don't allow</button>
      </div><div class="result" hidden></div></div>`), true);
    el.querySelectorAll('[data-v]').forEach((b) => b.addEventListener('click', () => {
      api.approve(ev.requestId, b.dataset.v);
      resolveCard(ev.requestId, b.dataset.v === 'reject' ? 'Not allowed' : 'Allowed');
    }));
  }

  // The agent asked a question.
  function addQuestion(ev) {
    steps = null;
    const opts = (ev.options || []).slice(0, 6);
    const el = add(h(`<div class="ask" data-req="${ev.requestId}">
      <h3>${esc(ev.question || 'Craft has a question')}</h3>
      ${opts.length ? `<div class="btns">${opts.map((o, i) => `<button type="button" class="btn ${i === 0 ? 'primary' : ''}" data-o="${esc(o)}">${esc(o)}</button>`).join('')}</div>` : ''}
      ${ev.connect ? '<div class="what">This needs a connection. Open Craft to connect it.</div><div class="btns"><button type="button" class="btn" data-craft>Open in Craft</button></div>' : ''}
      <input type="text" placeholder="${opts.length ? 'Or type an answer' : 'Type your answer'}" />
      <div class="result" hidden></div></div>`), true);
    const answer = (text) => { if (!text) return; api.answer(ev.requestId, text); resolveCard(ev.requestId, text); };
    el.querySelectorAll('[data-o]').forEach((b) => b.addEventListener('click', () => answer(b.dataset.o)));
    const c = el.querySelector('[data-craft]'); if (c) c.addEventListener('click', () => api.openInCraft(S.sessionId));
    const inp = el.querySelector('input');
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); answer(inp.value.trim()); } });
    setTimeout(() => { if (!opts.length) inp.focus(); }, 50);
  }

  function resolveCard(requestId, text) {
    const el = feed.querySelector(`.ask[data-req="${requestId}"]`);
    if (!el || el.classList.contains('done')) return;
    el.classList.add('done');
    const r = el.querySelector('.result'); r.hidden = false; r.textContent = text;
    placeWorking();
  }

  // Files this message changed, with Undo.
  function addChanged(cp) {
    steps = null;
    const n = cp.total || (cp.files || []).length;
    if (!n) return;
    const old = feed.querySelector(`.changed[data-cp="${CSS.escape(cp.id)}"]`);
    const el = h(`<div class="changed" data-cp="${esc(cp.id)}"><span class="t">${cp.undone ? 'Undone' : `${n} file${n === 1 ? '' : 's'} changed`}</span>
      <button type="button" class="btn" data-undo>${cp.undone ? 'Redo' : 'Undo'}</button></div>`);
    el.querySelector('[data-undo]').addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      const r = await api.undo(S.sessionId, cp.id, !cp.undone);
      if (r && r.error) addNote(r.error, 'error');
      else addChanged({ ...cp, undone: !cp.undone });
    });
    if (old) old.replaceWith(el); else add(el);
  }

  // ─── events from the main process ─────────────────────────────────────────
  api.onEvent((ev) => {
    // A new chat's first events arrive before send() returns its id.
    if (!S.sessionId && S.sending && ev.type === 'session_sync' && ev.origin === 'drop' && ev.message?.kind === 'user') {
      S.sessionId = ev.sessionId; api.showing(S.sessionId);
    }
    if (!S.sessionId || ev.sessionId !== S.sessionId) return;
    switch (ev.type) {
      case 'tool_start': startWorking(); addStep(ev.name, labelOf(ev), 'run'); break;
      case 'tool_end': endStep(ev); break;
      case 'text': if (ev.text && ev.text.trim()) addAi(ev.text); break;
      case 'notice': addNote(ev.text, ev.level); break;
      case 'error': addNote(ev.error, 'error'); break;
      case 'task_start': steps = null; add(h(`<div class="task">${esc(ev.text)}</div>`)); break;
      case 'approval_request': addApproval(ev); break;
      case 'approval_resolved': resolveCard(ev.requestId, ev.verdict === 'reject' ? 'Not allowed' : 'Allowed'); break;
      case 'question_request': addQuestion(ev); break;
      case 'question_resolved': resolveCard(ev.requestId, ev.answer || 'Skipped'); break;
      case 'image_pick_request':
        addNote('Craft wants you to pick an image. Open Craft to choose one.', 'warn'); break;
      case 'checkpoint': case 'checkpoint_update': addChanged(ev.checkpoint); break;
      case 'cloud_task': if (ev.task && ev.task.status) addNote(`Cloud: ${ev.task.status}`, ''); break;
      case 'run_finished': S.running = false; stopWorking(); syncSend(); break;
      case 'session_sync': if (ev.session?.title) S.title = ev.session.title; break;
      default: break;
    }
  });
  api.onRuns((active) => {
    if (S.sending && !S.sessionId) return; // a new chat: its id isn't known yet
    const was = S.running;
    S.running = !!S.sessionId && active.includes(S.sessionId);
    if (S.running && !was) startWorking();
    if (!S.running && was) stopWorking();
    syncSend();
  });
  api.onShown(() => { if (window.applyDropTheme) window.applyDropTheme(); loadState(); setTimeout(() => input.focus(), 30); });

  // ─── sending ──────────────────────────────────────────────────────────────
  async function send() {
    if (S.running) { api.stop(S.sessionId); return; }
    const text = input.value.trim();
    if (!text || S.sending) return;
    let newProject = null;
    if (!S.project && !S.sessionId) {
      newProject = typeof newProjectName === 'function' ? newProjectName(text) : null;
      if (!newProject) {
        const p = await api.chooseProject();
        if (!p) return;
        S.project = p; renderChips();
      }
    }
    S.sending = true; syncSend();
    card.classList.add('has-chat');
    addUser(text);
    input.value = ''; autosize();
    startWorking(); S.running = true; syncSend();
    let r;
    try { r = await api.send({ sessionId: S.sessionId, cwd: S.project ? S.project.path : null, mode: S.mode, bypass: S.bypass, text, newProject }); }
    catch (e) { r = { error: e.message }; }
    S.sending = false;
    if (!r || r.error) {
      S.running = false; stopWorking();
      addNote(r && r.error ? r.error : 'Craft could not start that.', 'error');
    } else {
      S.sessionId = r.sessionId; api.showing(S.sessionId);
      if (r.project && (!S.project || S.project.path !== r.project.path)) { S.project = r.project; }
    }
    renderChips();
  }

  // An earlier drop chat from the list.
  async function openChat(id) {
    const s = await api.session(id);
    if (!s) return;
    S.sessionId = s.id; S.running = !!s.running;
    if (s.cwd) S.project = { path: s.cwd, name: s.cwd.replace(/\\/g, '/').split('/').pop() };
    feed.innerHTML = ''; steps = null; stopWorking();
    card.classList.add('has-chat');
    for (const m of s.messages) {
      if (m.kind === 'user') addUser(m.text);
      else if (m.kind === 'assistant' && m.text) addAi(m.text);
      else if (m.kind === 'tool') addStep(m.name, m.label, m.ok ? 'ok' : 'bad', m.added, m.removed);
      else if (m.kind === 'notice') addNote(m.text, m.level);
      else if (m.kind === 'checkpoint') addChanged({ id: m.id, total: m.total, files: m.files, undone: m.undone });
    }
    if (S.running) startWorking();
    renderChips(); scrollDown(true); input.focus();
  }

  sendBtn.addEventListener('click', send);
  input.addEventListener('input', () => { autosize(); syncSend(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!S.running) send(); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!menu.hidden) { closeMenu(); return; }
    api.hide();
  });

  loadState().then(() => input.focus());
})();
