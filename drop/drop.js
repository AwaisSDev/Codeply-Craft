// The Alt+C drop's window: one chat with Craft's agent, in the corner of the screen.
// Everything runs in the main process (drop.js there); this page sends messages
// and draws the events that come back: the agent's steps, its replies, and the
// cards it waits on (an OK for a deploy, a question, Undo).
//
// Empty, the drop is just the message bar. With a chat it grows upward into a
// panel, as tall as the conversation up to MAX_H, and the window follows: this
// page measures itself and tells the main process its height (fit()).
(() => {
  const api = window.drop;
  const md = (t) => (window.CrewMarkdown ? window.CrewMarkdown.md(t) : esc(t));
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const S = {
    project: null, projects: [], models: { selected: 'auto', models: [] }, recent: [], recentMore: false, recentLoading: false,
    mode: 'Build', bypass: readBypass(), sessionId: null, running: false, sending: false, hotkey: null, title: '',
  };
  function readBypass() { try { return localStorage.getItem('craft-drop-bypass') === '1'; } catch { return false; } }
  const card = $('card'); const thread = $('thread'); const feed = $('feed'); const input = $('input'); const sendBtn = $('sendBtn');
  const head = $('head'); const composer = $('composer');

  const ICON = {
    check: '<svg viewBox="0 0 16 16"><path d="M3.5 8.5 6.5 11.5 12.5 4.5"/></svg>',
    x: '<svg viewBox="0 0 16 16"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>',
    tick: '<svg class="tick" viewBox="0 0 16 16"><path d="M3.5 8.5 6.5 11.5 12.5 4.5"/></svg>',
    chat: '<svg viewBox="0 0 16 16"><path d="M3 4.5C3 3.7 3.7 3 4.5 3h7c.8 0 1.5.7 1.5 1.5v5c0 .8-.7 1.5-1.5 1.5H7l-3 2.5V11h0c-.6 0-1-.4-1-1z"/></svg>',
    folder: '<svg viewBox="0 0 16 16"><path d="M2 4.5c0-.8.7-1.5 1.5-1.5h2.6l1.4 1.5h5c.8 0 1.5.7 1.5 1.5v5.5c0 .8-.7 1.5-1.5 1.5h-9c-.8 0-1.5-.7-1.5-1.5z"/></svg>',
    plus: '<svg viewBox="0 0 16 16"><path d="M8 3.5v9M3.5 8h9"/></svg>',
    chev: '<svg class="chev" viewBox="0 0 16 16"><path d="M6 4l4 4-4 4"/></svg>',
  };

  // What a step says while it runs, and after.
  const VERB = {
    read_file: ['Reading', 'Read'], list_dir: ['Listing', 'Listed'], search: ['Searching', 'Searched'],
    write_file: ['Writing', 'Wrote'], edit_file: ['Editing', 'Edited'], apply_patch: ['Editing', 'Edited'],
    run: ['Running', 'Ran'], browser_check: ['Checking', 'Checked'], web_search: ['Searching the web for', 'Searched the web for'],
    image_search: ['Searching images for', 'Searched images for'], fetch_image: ['Downloading', 'Downloaded'],
    view_images: ['Looking at', 'Looked at'], look_at_screen: ['Looking at your screen', 'Looked at your screen'], todo: ['Updating the task list', 'Updated the task list'],
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

  // ─── the window's height ──────────────────────────────────────────────────
  const MAX_H = 500;       // the panel's tallest; the conversation scrolls past this
  const MIN_CHAT = 220;    // a fresh chat doesn't start as a sliver
  let fitRaf = 0; let lastFit = 0; let menuNeed = 0;
  function fit() {
    cancelAnimationFrame(fitRaf);
    fitRaf = requestAnimationFrame(() => {
      let h;
      if (card.classList.contains('has-chat')) {
        const cs = getComputedStyle(composer);
        const want = head.offsetHeight + feed.scrollHeight + 16 + composer.offsetHeight + parseFloat(cs.marginBottom || 0);
        h = Math.max(MIN_CHAT, Math.min(MAX_H, Math.ceil(want)));
        card.style.height = h + 'px';
      } else {
        card.style.height = '';
        h = card.scrollHeight;
      }
      const winH = Math.max(h, menu.hidden ? 0 : menuNeed);
      if (winH !== lastFit) { lastFit = winH; if (api.fit) api.fit(winH); }
    });
  }
  new ResizeObserver(fit).observe(feed);
  new ResizeObserver(fit).observe(composer);

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
  function setChat(on) {
    if (card.classList.contains('has-chat') === on) return;
    card.classList.toggle('has-chat', on);
    fit();
  }

  // ─── bar, chips, header ───────────────────────────────────────────────────
  function renderChips() {
    $('projName').textContent = S.project ? S.project.name : 'Project';
    const sel = S.models.models.find((m) => m.id === S.models.selected);
    $('modelName').textContent = sel ? sel.name || sel.model : 'Haze 2';
    $('modeName').textContent = S.mode;
    $('fullTag').hidden = !S.bypass;
    $('modeBtn').classList.toggle('full', S.bypass);
    $('modeBtn').title = S.bypass ? 'Full access: runs everything without asking' : 'Mode and permissions';
    input.placeholder = S.sessionId ? 'Follow up' : 'Ask Craft anything';
    $('title').textContent = S.title || 'New chat';
    syncSend();
  }
  function syncSend() {
    card.classList.toggle('running', S.running);
    sendBtn.disabled = !S.running && (S.sending || !input.value.trim());
    sendBtn.setAttribute('aria-label', S.running ? 'Stop' : 'Send');
  }
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
    renderChips();
    // The page was reloaded: pick the chat back up instead of starting blank.
    if (!restored) { restored = true; if (!S.sessionId && st.current) await openChat(st.current); }
  }
  let restored = false;

  // ─── menus ────────────────────────────────────────────────────────────────
  // They open above the button. While just the bar shows there is no room above
  // it, so the window grows for the menu and shrinks back when it closes.
  const menu = $('menu');
  let menuFor = null;
  function openMenu(anchor, html) {
    menuFor = anchor;
    menu.innerHTML = html; menu.hidden = false;
    const a = anchor.getBoundingClientRect();
    const fromBottom = window.innerHeight - a.top + 6;
    menu.style.bottom = fromBottom + 'px';
    menu.style.left = Math.max(8, Math.min(a.left, window.innerWidth - menu.offsetWidth - 8)) + 'px';
    menuNeed = Math.ceil(fromBottom + menu.offsetHeight + 8);
    fit();
    return menu;
  }
  function closeMenu() { if (menu.hidden) return; menu.hidden = true; menu.innerHTML = ''; menuFor = null; menuNeed = 0; fit(); }
  const toggleMenu = (btn, build) => { if (!menu.hidden && menuFor === btn) return closeMenu(); closeMenu(); build(); };
  document.addEventListener('mousedown', (e) => { if (!menu.hidden && !menu.contains(e.target) && !e.target.closest('[data-menu]')) closeMenu(); });
  window.addEventListener('blur', closeMenu);

  $('projBtn').addEventListener('click', (e) => toggleMenu(e.currentTarget, () => {
    const rows = S.projects.map((p) => `<button type="button" data-p="${esc(p.path)}">${ICON.folder}<span class="t">${esc(p.name)}</span>${S.project && S.project.path === p.path ? ICON.tick : ''}</button>`).join('');
    const m = openMenu($('projBtn'), `<div class="lbl">Projects</div>${rows}${rows ? '<hr>' : ''}<button type="button" data-open>${ICON.plus}<span class="t">Open a folder…</span></button>`);
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
  }));

  // Build or Ask, and whether it asks before edits, commands and deploys.
  $('modeBtn').addEventListener('click', (e) => toggleMenu(e.currentTarget, () => {
    const modes = [
      { mode: 'Build', sub: 'Makes the changes' },
      { mode: 'Ask', sub: 'Answers questions, no edits' },
    ];
    const perms = [
      { full: false, name: 'Approve manually', sub: 'Asks before edits, commands and deploys' },
      { full: true, name: 'Full access', sub: 'Runs everything without asking' },
    ];
    const m = openMenu($('modeBtn'), '<div class="lbl">Mode</div>'
      + modes.map((o) => `<button type="button" data-mode="${o.mode}"><span class="t">${o.mode}<span class="sub">${o.sub}</span></span>${o.mode === S.mode ? ICON.tick : ''}</button>`).join('')
      + '<hr><div class="lbl">Permissions</div>'
      + perms.map((o) => `<button type="button" data-full="${o.full ? 1 : 0}" class="${o.full ? 'warn' : ''}"><span class="t">${o.name}<span class="sub">${o.sub}</span></span>${o.full === S.bypass ? ICON.tick : ''}</button>`).join(''));
    m.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => { closeMenu(); S.mode = b.dataset.mode; renderChips(); input.focus(); }));
    m.querySelectorAll('[data-full]').forEach((b) => b.addEventListener('click', () => {
      closeMenu();
      S.bypass = b.dataset.full === '1';
      try { localStorage.setItem('craft-drop-bypass', S.bypass ? '1' : '0'); } catch {}
      renderChips(); input.focus();
    }));
  }));

  $('modelBtn').addEventListener('click', (e) => toggleMenu(e.currentTarget, () => {
    const all = [{ id: 'auto', name: 'Haze 2', sub: 'The routing brain' }, ...S.models.models.map((m) => ({ id: m.id, name: m.name || m.model, sub: m.kind === 'ollama' ? 'Ollama' : '' }))];
    const m = openMenu($('modelBtn'), '<div class="lbl">Model</div>' + all.map((x) =>
      `<button type="button" data-id="${esc(x.id)}"><span class="t">${esc(x.name)}</span>${x.sub ? `<span class="s">${esc(x.sub)}</span>` : ''}${x.id === S.models.selected ? ICON.tick : ''}</button>`).join(''));
    m.querySelectorAll('[data-id]').forEach((b) => b.addEventListener('click', async () => {
      closeMenu();
      const r = await api.selectModel(b.dataset.id);
      if (r && r.ok && r.state) { S.models = r.state; renderChips(); }
      else if (r && r.error) addNote(r.error, 'error');
    }));
  }));

  // Every chat (Craft's and the drop's), newest first; scrolling near the end brings in the next page.
  const recentRow = (r) => {
    const b = h(`<button type="button" data-id="${esc(r.id)}">${ICON.chat}<span class="t">${esc(r.title)}</span><span class="s">${esc(ago(r.updatedAt))}</span></button>`);
    b.addEventListener('click', () => { closeMenu(); openChat(r.id); });
    return b;
  };
  $('recentBtn').addEventListener('click', (e) => toggleMenu(e.currentTarget, () => {
    const m = openMenu($('recentBtn'), `<div class="lbl">Recent</div>${S.recent.length ? '' : '<div class="none">No chats yet.</div>'}`);
    S.recent.forEach((r) => m.appendChild(recentRow(r)));
    menuNeed = Math.ceil(window.innerHeight - $('recentBtn').getBoundingClientRect().top + 6 + m.offsetHeight + 8);
    m.style.left = Math.max(8, window.innerWidth - m.offsetWidth - 8) + 'px';
    fit();
  }));
  menu.addEventListener('scroll', () => {
    if (menuFor === $('recentBtn') && menu.scrollHeight - menu.scrollTop - menu.clientHeight < 80) moreRecent();
  });
  async function moreRecent() {
    if (!S.recentMore || S.recentLoading) return;
    S.recentLoading = true;
    try {
      const page = await api.recent(S.recent.length);
      const seen = new Set(S.recent.map((r) => r.id));
      const fresh = (page.items || []).filter((r) => !seen.has(r.id));
      S.recent.push(...fresh);
      S.recentMore = !!page.more && fresh.length > 0;
      if (menuFor === $('recentBtn')) fresh.forEach((r) => menu.appendChild(recentRow(r)));
    } finally { S.recentLoading = false; }
  }

  $('newBtn').addEventListener('click', () => { newChat(); input.focus(); });
  $('craftBtn').addEventListener('click', () => api.openInCraft(S.sessionId));
  $('hideBtn').addEventListener('click', () => api.hide());
  $('closeBtn').addEventListener('click', () => api.hide());

  // ─── the chat ─────────────────────────────────────────────────────────────
  let steps = null;        // the open group of step rows
  let working = null;      // "Working" row, kept at the bottom while running
  let workingTimer = null;
  let startedAt = 0;

  function newChat() {
    S.sessionId = null; S.running = false; S.title = '';
    feed.innerHTML = ''; steps = null; stopWorking();
    setChat(false);
    api.showing(null);
    loadState();
  }

  // Consecutive steps share one group; every other kind of row resets `steps`.
  function stepsBlock() {
    if (!steps) steps = add(h(`<details class="sg"><summary><span class="sg-ico"></span><span class="sg-text"></span>${ICON.chev}</summary><div class="sg-body"></div></details>`));
    return steps;
  }

  function stepRow(name, label, state, added, removed) {
    const st = state === 'run' ? '<span class="spin"></span>' : state === 'ok' ? ICON.check : ICON.x;
    const n = typeof added === 'number' && (added || removed)
      ? `<span class="n">${added ? `<span class="a">+${added}</span>` : ''}${removed ? `<span class="r">−${removed}</span>` : ''}</span>` : '';
    const l = label ? `<span class="l" title="${esc(label)}">${esc(name === 'run' ? label : short(label) || label)}</span>` : '';
    return h(`<div class="step ${state === 'run' ? 'run' : state}" data-tool="${esc(name)}"><span class="st">${st}</span><span class="v">${esc(verb(name, state !== 'run'))}</span>${l}${n}</div>`);
  }

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  function stepsSummary(rows) {
    const count = {}; let failed = 0; let other = 0;
    for (const r of rows) {
      if (r.classList.contains('bad')) failed++;
      const name = r.dataset.tool || '';
      const k = ['read_file', 'view_images'].includes(name) ? 'read' : ['edit_file', 'write_file', 'apply_patch'].includes(name) ? 'edit'
        : name === 'run' ? 'run' : ['search', 'list_dir', 'design_reference_search', 'list_skills', 'web_search'].includes(name) ? 'search' : 'other';
      if (k === 'other') other++; else count[k] = (count[k] || 0) + 1;
    }
    const parts = [];
    if (count.read) parts.push(`read ${plural(count.read, 'file', 'files')}`);
    if (count.search) parts.push(count.search === 1 ? 'searched' : `searched ${count.search} times`);
    if (count.edit) parts.push(`edited ${plural(count.edit, 'file', 'files')}`);
    if (count.run) parts.push(`ran ${plural(count.run, 'command', 'commands')}`);
    if (other) parts.push(`used ${plural(other, 'tool', 'tools')}`);
    let text = parts.join(', ') || 'worked on it';
    text = text[0].toUpperCase() + text.slice(1);
    return text + (failed ? ` · ${failed} failed` : '');
  }
  // Live while it's the newest thing in a running chat: a spinner and what's happening now.
  function updateGroup(g) {
    if (!g) return;
    const rows = [...g.querySelectorAll('.step')];
    const lastReal = [...feed.children].filter((n) => n !== working).pop();
    const live = S.running && g === lastReal;
    g.classList.toggle('live', live);
    let text;
    if (live) {
      const cur = rows[rows.length - 1];
      text = cur ? `${cur.querySelector('.v').textContent} ${cur.querySelector('.l') ? cur.querySelector('.l').textContent : ''}`.trim() : 'Working';
    } else text = stepsSummary(rows);
    g.querySelector('.sg-text').textContent = text;
    g.querySelector('.sg-ico').innerHTML = live ? '<span class="spin"></span>' : '';
  }
  const updateGroups = () => feed.querySelectorAll(':scope > .sg').forEach(updateGroup);

  function addStep(name, label, state, added, removed) {
    const block = stepsBlock();
    const stick = nearBottom();
    block.querySelector('.sg-body').appendChild(stepRow(name, label, state, added, removed));
    updateGroup(block); placeWorking();
    scrollDown(stick);
  }

  function endStep(ev) {
    const rows = [...feed.querySelectorAll(`.step.run[data-tool="${CSS.escape(ev.name)}"]`)];
    const row = rows[rows.length - 1];
    const fresh = stepRow(ev.name, labelOf(ev), ev.ok ? 'ok' : 'bad', ev.meta?.added, ev.meta?.removed);
    if (row) { const g = row.closest('.sg'); row.replaceWith(fresh); updateGroup(g); } else addStep(ev.name, labelOf(ev), ev.ok ? 'ok' : 'bad', ev.meta?.added, ev.meta?.removed);
  }

  function addUser(text) {
    steps = null;
    if (!S.title) { S.title = text.replace(/\s+/g, ' ').slice(0, 80); $('title').textContent = S.title; }
    add(h(`<div class="msg-user">${esc(text)}</div>`), true);
  }
  function addAi(text) { steps = null; const el = h('<div class="msg-ai"></div>'); el.innerHTML = md(text); add(el); updateGroups(); }
  function addNote(text, level) { steps = null; add(h(`<div class="note ${esc(level || '')}">${esc(text)}</div>`)); updateGroups(); }

  function startWorking() {
    startedAt = startedAt || Date.now();
    if (!working) {
      working = h('<div class="working"><span class="spin"></span><span class="shine">Working</span><span class="time"></span></div>');
      feed.appendChild(working);
      clearInterval(workingTimer);
      workingTimer = setInterval(tickWorking, 1000);
    }
    tickWorking(); placeWorking(); scrollDown();
  }
  function tickWorking() {
    if (!working) return;
    const s = Math.round((Date.now() - startedAt) / 1000);
    working.querySelector('.time').textContent = s >= 3 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : '';
  }
  function stopWorking() { clearInterval(workingTimer); workingTimer = null; if (working) working.remove(); working = null; startedAt = 0; updateGroups(); }
  function placeWorking() {
    if (!working) return;
    if (feed.lastElementChild !== working) feed.appendChild(working);
    // A live step group already says what's happening; a card waiting on you says it isn't working.
    const prev = working.previousElementSibling;
    working.hidden = !!feed.querySelector('.ask:not(.done)') || !!(prev && prev.classList.contains('sg'));
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
    updateGroups();
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
    updateGroups();
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
    updateGroups();
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
      case 'error': addNote(ev.error, ev.limited ? 'limit' : 'error'); break;
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
      case 'session_sync': if (ev.session?.title) { S.title = ev.session.title; $('title').textContent = S.title; } break;
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
  // Orbit: "Craft, do X" arrives as a task in a fresh chat; "Open in Drop" just fills the box.
  api.onVoiceText(async ({ text, run }) => {
    if (!text) return;
    if (run && (S.running || S.sending)) newChat();
    input.value = text; autosize(); syncSend();
    if (run) { await loadState(); send(); } else input.focus();
  });

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
    setChat(true);
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

  // An earlier chat from the list.
  async function openChat(id) {
    const s = await api.session(id);
    if (!s) return;
    S.sessionId = s.id; S.running = !!s.running; S.title = s.title || '';
    if (s.cwd) S.project = { path: s.cwd, name: s.cwd.replace(/\\/g, '/').split('/').pop() };
    feed.innerHTML = ''; steps = null; stopWorking();
    setChat(true);
    for (const m of s.messages) {
      if (m.kind === 'user') addUser(m.text);
      else if (m.kind === 'assistant' && m.text) addAi(m.text);
      else if (m.kind === 'tool') addStep(m.name, m.label, m.ok ? 'ok' : 'bad', m.added, m.removed);
      else if (m.kind === 'notice') addNote(m.text, m.level);
      else if (m.kind === 'checkpoint') addChanged({ id: m.id, total: m.total, files: m.files, undone: m.undone });
    }
    if (S.running) startWorking();
    updateGroups();
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

  fit();
  loadState().then(() => input.focus());
})();
