// The Design tab's page: the designs in the sidebar, a start screen that asks
// what to design, and one design at a time with its chat beside a live canvas.
// The canvas is the design's own index.html in a sandboxed frame, reloaded as
// the agent writes it (design-main.js watches the folder).
(() => {
  const api = window.design;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const md = (t) => (window.CrewMarkdown ? window.CrewMarkdown.md(t) : esc(t));
  const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; };

  const KINDS = [
    { id: 'website', label: 'Website', hint: 'A landing page for a small coffee roaster in Lahore, warm and editorial', icon: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M2 6h12"/>' },
    { id: 'app', label: 'App', hint: 'A habit tracker app: today, a habit, and the weekly view', icon: '<rect x="4.5" y="1.5" width="7" height="13" rx="1.6"/><path d="M7 12.5h2"/>' },
    { id: 'slides', label: 'Slides', hint: 'A 6-slide pitch deck for a student food delivery startup', icon: '<rect x="1.5" y="3" width="13" height="8.5" rx="1.2"/><path d="M8 11.5V14M5.5 14h5"/>' },
    { id: 'doc', label: 'Document', hint: 'A one-page resume for a junior product designer', icon: '<path d="M4 1.8h5.5L12.5 5v9.2H4z"/><path d="M9.5 1.8V5h3M6 8h4.5M6 10.5h4.5"/>' },
    { id: 'poster', label: 'Poster', hint: 'A poster for a jazz night on Friday at 9, in a rooftop cafe', icon: '<rect x="3.5" y="1.5" width="9" height="13" rx="1"/><path d="M5.5 10.5h5M5.5 12.5h3"/>' },
    { id: 'social', label: 'Social post', hint: 'An Instagram post announcing our summer sale, 30% off', icon: '<rect x="2" y="2" width="12" height="12" rx="3"/><circle cx="8" cy="8" r="2.6"/>' },
    { id: 'logo', label: 'Logo', hint: 'A logo for Kite, a calm budgeting app', icon: '<path d="M8 1.8 13.6 8 8 14.2 2.4 8z"/>' },
  ];
  const kindOf = (id) => KINDS.find((k) => k.id === id) || KINDS[0];
  const kindIcon = (id) => `<svg viewBox="0 0 16 16">${kindOf(id).icon}</svg>`;
  const ICON = {
    check: '<svg viewBox="0 0 16 16"><path d="M3.5 8.5 6.5 11.5 12.5 4.5"/></svg>',
    x: '<svg viewBox="0 0 16 16"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>',
    chev: '<svg class="chev" viewBox="0 0 16 16"><path d="M6 4l4 4-4 4"/></svg>',
    image: '<svg viewBox="0 0 16 16"><rect x="2" y="2.5" width="12" height="11" rx="1.5"/><circle cx="5.8" cy="6.2" r="1.2"/><path d="m2.5 12 3.8-3.6 2.7 2.4 2-1.8 2.5 2.2"/></svg>',
    pdf: '<svg viewBox="0 0 16 16"><path d="M4 1.8h5.5L12.5 5v9.2H4z"/><path d="M9.5 1.8V5h3M6 9.5h4.5M6 12h3"/></svg>',
    folder: '<svg viewBox="0 0 16 16"><path d="M2 4.5c0-.8.7-1.5 1.5-1.5h2.6l1.4 1.5h5c.8 0 1.5.7 1.5 1.5v5.5c0 .8-.7 1.5-1.5 1.5h-9c-.8 0-1.5-.7-1.5-1.5z"/></svg>',
    pen: '<svg viewBox="0 0 16 16"><path d="M10.8 2.7a1.6 1.6 0 0 1 2.3 2.3L6 12.1l-3 .8.8-3z"/></svg>',
    trash: '<svg viewBox="0 0 16 16"><path d="M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 9h6.6l.7-9"/></svg>',
  };
  const VERB = {
    read_file: ['Reading', 'Read'], list_dir: ['Listing', 'Listed'], search: ['Searching', 'Searched'], write_file: ['Writing', 'Wrote'],
    edit_file: ['Editing', 'Edited'], apply_patch: ['Editing', 'Edited'], fetch_image: ['Downloading', 'Downloaded'],
    image_search: ['Searching images for', 'Searched images for'], web_search: ['Searching the web for', 'Searched the web for'],
    web_fetch: ['Reading', 'Read'], view_images: ['Looking at', 'Looked at'], use_skill: ['Loading skill', 'Loaded skill'],
    design_direction: ['Choosing a direction', 'Chose a direction'], design_lint: ['Checking the design', 'Checked the design'],
    design_reference_search: ['Looking for references', 'Looked for references'], todo: ['Planning', 'Planned'], ask_user: ['Asking you', 'Asked you'],
  };
  const verb = (n, done) => (VERB[n] ? VERB[n][done ? 1 : 0] : (done ? 'Used ' : 'Using ') + String(n || 'a tool').replace(/_/g, ' '));
  const labelOf = (ev) => {
    if (ev.name === 'design_direction' || ev.name === 'use_skill' || ev.name === 'todo') return '';
    const a = ev.args || {};
    return ev.summary || ev.label || a.path || a.query || a.term || a.url || '';
  };
  const short = (p) => String(p || '').replace(/\\/g, '/').split('/').slice(-2).join('/');
  const ago = (t) => { const m = Math.round((Date.now() - (t || 0)) / 60000); if (m < 1) return 'now'; if (m < 60) return `${m}m ago`; const hr = Math.round(m / 60); return hr < 24 ? `${hr}h ago` : `${Math.round(hr / 24)}d ago`; };

  const S = { designs: [], cur: null, sessionId: null, running: false, sending: false, kind: null, width: 1440, active: [] };

  // ─── the sidebar ──────────────────────────────────────────────────────────
  document.querySelectorAll('.app-switch-btn').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.app === 'craft') api.toCraft(); else if (b.dataset.app === 'crew') api.toCrew();
  }));
  $('newBtn').addEventListener('click', () => showStart());

  function renderList() {
    const box = $('list');
    box.innerHTML = '';
    if (!S.designs.length) { box.appendChild(h('<div class="dz-none">No designs yet.</div>')); return; }
    for (const d of S.designs) {
      const running = d.sessionId && S.active.includes(d.sessionId);
      const b = h(`<button type="button" class="dz-item ${S.cur && S.cur.id === d.id ? 'on' : ''}"><span class="k">${kindIcon(d.kind)}</span><span class="t"><b>${esc(d.title)}</b><small>${esc(kindOf(d.kind).label)} · ${esc(ago(d.updatedAt))}</small></span>${running ? '<span class="spin"></span>' : ''}</button>`);
      b.addEventListener('click', () => openDesign(d.id));
      box.appendChild(b);
    }
  }
  async function loadList() {
    const r = await api.list();
    S.designs = r.designs || [];
    renderList();
  }

  // ─── start ────────────────────────────────────────────────────────────────
  const startInput = $('startInput');
  function renderKinds() {
    const box = $('kinds');
    box.innerHTML = '';
    for (const k of KINDS) {
      const b = h(`<button type="button" class="dz-kind-chip ${S.kind === k.id ? 'on' : ''}"><svg viewBox="0 0 16 16">${k.icon}</svg>${k.label}</button>`);
      b.addEventListener('click', () => { S.kind = S.kind === k.id ? null : k.id; renderKinds(); startInput.focus(); });
      box.appendChild(b);
    }
    startInput.placeholder = (S.kind ? kindOf(S.kind) : KINDS[0]).hint;
  }
  function showStart() {
    if (S.cur) api.close();
    S.cur = null; S.sessionId = null;
    $('work').hidden = true; $('start').hidden = false;
    renderList();
    setTimeout(() => startInput.focus(), 30);
  }
  const autosize = (t, max) => { t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, max) + 'px'; };
  startInput.addEventListener('input', () => { autosize(startInput, 220); $('startSend').disabled = !startInput.value.trim(); });
  startInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); create(); } });
  $('startSend').addEventListener('click', create);

  async function create() {
    const text = startInput.value.trim();
    if (!text || S.sending) return;
    S.sending = true; $('startSend').disabled = true;
    const r = await api.create(text, S.kind);
    S.sending = false;
    if (!r || r.error || !r.design) { $('startSend').disabled = false; alertNote(r && r.error ? r.error : 'Craft could not start that.'); return; }
    startInput.value = ''; autosize(startInput, 220); S.kind = null; renderKinds();
    await loadList();
    await openDesign(r.design.id);
  }
  function alertNote(text) { const n = $('start').querySelector('.dz-box-note'); if (n) { n.textContent = text; n.style.color = 'var(--red)'; } }

  // ─── one design ───────────────────────────────────────────────────────────
  const feed = $('feed'); const thread = $('thread'); const input = $('input'); const sendBtn = $('sendBtn');
  const frame = $('frame'); const wrap = $('frameWrap'); const canvas = $('canvas');

  async function openDesign(id) {
    const r = await api.open(id);
    if (!r) { await loadList(); return; }
    S.cur = r.design; S.sessionId = r.design.sessionId; S.running = !!r.running;
    if (S.cur.kind !== 'website') S.width = 1440;
    $('start').hidden = true; $('work').hidden = false;
    feed.innerHTML = ''; steps = null; stopWorking();
    for (const m of r.messages) {
      if (m.kind === 'user') addUser(m.text);
      else if (m.kind === 'assistant' && m.text) addAi(m.text);
      else if (m.kind === 'tool') addStep(m.name, m.label, m.ok ? 'ok' : 'bad');
      else if (m.kind === 'notice') addNote(m.text, m.level);
    }
    if (S.running) startWorking();
    updateGroups();
    renderHead(); renderList(); loadFrame(true); syncSend();
    thread.scrollTop = thread.scrollHeight;
    input.focus();
  }

  function renderHead() {
    const d = S.cur;
    $('dTitle').textContent = d.title;
    $('dKind').textContent = kindOf(d.kind).label;
    $('sizes').hidden = d.kind !== 'website';
    $('buildBtn').hidden = !(d.kind === 'website' || d.kind === 'app');
    document.querySelectorAll('#sizes .segmented-item').forEach((b) => b.classList.toggle('active', Number(b.dataset.w) === S.width));
  }
  document.querySelectorAll('#sizes .segmented-item').forEach((b) => b.addEventListener('click', () => { S.width = Number(b.dataset.w); renderHead(); fitFrame(); }));

  // Rename: double-click the title, Enter to keep it.
  $('dTitle').addEventListener('dblclick', () => {
    const t = $('dTitle'); t.contentEditable = 'true'; t.focus();
    document.getSelection().selectAllChildren(t);
  });
  $('dTitle').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } if (e.key === 'Escape') { e.currentTarget.textContent = S.cur.title; e.currentTarget.blur(); } });
  $('dTitle').addEventListener('blur', async (e) => {
    e.currentTarget.contentEditable = 'false';
    const title = e.currentTarget.textContent.trim();
    if (S.cur && title && title !== S.cur.title) { const v = await api.rename(S.cur.id, title); if (v) { S.cur = v; await loadList(); renderHead(); } }
    else if (S.cur) e.currentTarget.textContent = S.cur.title;
  });

  // ─── the canvas ───────────────────────────────────────────────────────────
  function loadFrame(force) {
    const d = S.cur;
    $('waiting').hidden = !!d.ready;
    wrap.hidden = !d.ready;
    if (!d.ready) return;
    const src = `${d.url}?v=${Date.now()}`;
    if (force || frame.dataset.for !== d.id) { frame.dataset.for = d.id; frame.src = src; } else frame.src = src;
    fitFrame();
  }
  // The design at its real size, scaled down to fit. Pages and decks scroll inside the frame;
  // posters, posts and logos are shown whole.
  function fitFrame() {
    const d = S.cur;
    if (!d || !d.ready) return;
    const w = d.kind === 'website' ? S.width : d.size.w;
    const cw = canvas.clientWidth - 48; const ch = canvas.clientHeight - 48;
    const whole = ['poster', 'social', 'logo'].includes(d.kind);
    const scale = Math.min(1, cw / w, whole ? ch / d.size.h : 1);
    const fh = whole ? d.size.h : Math.max(240, ch / scale);
    frame.style.width = w + 'px'; frame.style.height = fh + 'px';
    frame.style.transform = `scale(${scale})`;
    wrap.style.width = Math.round(w * scale) + 'px'; wrap.style.height = Math.round(fh * scale) + 'px';
    wrap.style.left = Math.round((canvas.clientWidth - w * scale) / 2) + 'px';
    wrap.style.top = (whole ? Math.max(24, Math.round((canvas.clientHeight - fh * scale) / 2)) : 24) + 'px';
  }
  new ResizeObserver(fitFrame).observe(canvas);
  api.onChanged(({ id, design }) => {
    const i = S.designs.findIndex((x) => x.id === id);
    if (i >= 0 && design) S.designs[i] = design;
    if (!S.cur || S.cur.id !== id || !design) { renderList(); return; }
    const kindChanged = design.kind !== S.cur.kind;
    S.cur = design;
    if (kindChanged && design.kind !== 'website') S.width = 1440;
    renderHead(); renderList(); loadFrame(false);
  });

  // ─── menus ────────────────────────────────────────────────────────────────
  const menu = $('menu');
  function openMenu(anchor, html, align = 'right') {
    menu.innerHTML = html; menu.hidden = false;
    const a = anchor.getBoundingClientRect();
    menu.style.top = Math.round(a.bottom + 6) + 'px';
    menu.style.left = Math.round(align === 'right' ? Math.max(8, a.right - menu.offsetWidth) : a.left) + 'px';
    return menu;
  }
  function closeMenu() { menu.hidden = true; menu.innerHTML = ''; }
  document.addEventListener('mousedown', (e) => { if (!menu.hidden && !menu.contains(e.target) && !e.target.closest('[data-menu]')) closeMenu(); });
  window.addEventListener('blur', closeMenu);

  $('exportBtn').addEventListener('click', (e) => {
    if (!menu.hidden) return closeMenu();
    const d = S.cur;
    const m = openMenu(e.currentTarget, `
      <button type="button" data-f="png">${ICON.image}<span class="t">PNG image<small>${d.kind === 'website' || d.kind === 'app' ? 'The whole page' : 'Every page or slide, as one picture'}</small></span></button>
      <button type="button" data-f="pdf">${ICON.pdf}<span class="t">PDF<small>${d.kind === 'slides' ? 'A page per slide' : d.kind === 'doc' ? 'Ready to print' : 'For sharing'}</small></span></button>
      <hr><button type="button" data-reveal>${ICON.folder}<span class="t">Show in folder<small>The HTML file and its pictures</small></span></button>`);
    m.querySelectorAll('[data-f]').forEach((b) => b.addEventListener('click', async () => {
      closeMenu();
      setChatNote('Exporting…');
      const r = await api.exportAs(S.cur.id, b.dataset.f);
      setChatNote(r && r.error ? r.error : r && r.ok ? 'Exported.' : '', r && r.error ? 'error' : '');
    }));
    m.querySelector('[data-reveal]').addEventListener('click', () => { closeMenu(); api.reveal(S.cur.id); });
  });
  $('moreBtn').addEventListener('click', (e) => {
    if (!menu.hidden) return closeMenu();
    const m = openMenu(e.currentTarget, `
      <button type="button" data-rename>${ICON.pen}<span class="t">Rename</span></button>
      <button type="button" data-reveal>${ICON.folder}<span class="t">Show in folder</span></button>
      <hr><button type="button" class="danger" data-del>${ICON.trash}<span class="t">Move to Recycle Bin</span></button>`);
    m.querySelector('[data-rename]').addEventListener('click', () => { closeMenu(); $('dTitle').dispatchEvent(new MouseEvent('dblclick')); });
    m.querySelector('[data-reveal]').addEventListener('click', () => { closeMenu(); api.reveal(S.cur.id); });
    m.querySelector('[data-del]').addEventListener('click', async () => {
      closeMenu();
      const r = await api.remove(S.cur.id);
      if (r && r.error) { setChatNote(r.error, 'error'); return; }
      await loadList(); showStart();
    });
  });
  let noteTimer = null;
  function setChatNote(text, level) {
    const n = $('chatNote'); n.textContent = text || ''; n.style.color = level === 'error' ? 'var(--red)' : '';
    clearTimeout(noteTimer); if (text && level !== 'error') noteTimer = setTimeout(() => { n.textContent = ''; }, 4000);
  }

  $('buildBtn').addEventListener('click', async () => {
    const b = $('buildBtn'); b.disabled = true;
    setChatNote('Setting up a project in Craft…');
    const r = await api.build(S.cur.id);
    b.disabled = false;
    setChatNote(r && r.error ? r.error : '', r && r.error ? 'error' : '');
  });

  // ─── the chat (the Drop's, with steps folded into one row) ────────────────
  let steps = null; let working = null; let workingTimer = null; let startedAt = 0;
  const nearBottom = () => thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
  function scrollDown(force) { if (force || nearBottom()) requestAnimationFrame(() => { thread.scrollTop = thread.scrollHeight; }); }
  function add(el, force) { const stick = force || nearBottom(); feed.appendChild(el); placeWorking(); scrollDown(stick); return el; }
  function stepsBlock() {
    if (!steps) steps = add(h(`<details class="sg"><summary><span class="sg-ico"></span><span class="sg-text"></span>${ICON.chev}</summary><div class="sg-body"></div></details>`));
    return steps;
  }
  function stepRow(name, label, state) {
    const st = state === 'run' ? '<span class="spin"></span>' : state === 'ok' ? ICON.check : ICON.x;
    const l = label ? `<span class="l" title="${esc(label)}">${esc(short(label) || label)}</span>` : '';
    return h(`<div class="step ${state === 'run' ? 'run' : state}" data-tool="${esc(name)}"><span class="st">${st}</span><span class="v">${esc(verb(name, state !== 'run'))}</span>${l}</div>`);
  }
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  function stepsSummary(rows) {
    const c = {}; let failed = 0;
    for (const r of rows) {
      if (r.classList.contains('bad')) failed++;
      const n = r.dataset.tool;
      const k = ['write_file', 'edit_file', 'apply_patch'].includes(n) ? 'edit' : n === 'design_lint' ? 'check' : ['image_search', 'fetch_image'].includes(n) ? 'pic'
        : ['design_reference_search', 'view_images', 'web_search', 'web_fetch'].includes(n) ? 'look' : n === 'design_direction' ? 'dir' : 'other';
      c[k] = (c[k] || 0) + 1;
    }
    const parts = [];
    if (c.dir) parts.push('chose a direction');
    if (c.look) parts.push('looked at references');
    if (c.pic) parts.push('found pictures');
    if (c.edit) parts.push(`made ${plural(c.edit, 'edit', 'edits')}`);
    if (c.check) parts.push(c.check === 1 ? 'checked it' : `checked it ${c.check} times`);
    let t = parts.join(', ') || 'worked on it';
    t = t[0].toUpperCase() + t.slice(1);
    return t + (failed ? ` · ${failed} failed` : '');
  }
  function updateGroup(g) {
    if (!g) return;
    const rows = [...g.querySelectorAll('.step')];
    const last = [...feed.children].filter((n) => n !== working).pop();
    const live = S.running && g === last;
    g.classList.toggle('live', live);
    const cur = rows[rows.length - 1];
    g.querySelector('.sg-text').textContent = live
      ? (cur ? `${cur.querySelector('.v').textContent} ${cur.querySelector('.l') ? cur.querySelector('.l').textContent : ''}`.trim() : 'Working')
      : stepsSummary(rows);
    g.querySelector('.sg-ico').innerHTML = live ? '<span class="spin"></span>' : '';
  }
  const updateGroups = () => feed.querySelectorAll(':scope > .sg').forEach(updateGroup);
  function addStep(name, label, state) { const b = stepsBlock(); b.querySelector('.sg-body').appendChild(stepRow(name, label, state)); updateGroup(b); placeWorking(); scrollDown(); }
  function endStep(ev) {
    const rows = [...feed.querySelectorAll(`.step.run[data-tool="${CSS.escape(ev.name)}"]`)];
    const row = rows[rows.length - 1];
    const fresh = stepRow(ev.name, labelOf(ev), ev.ok ? 'ok' : 'bad');
    if (row) { const g = row.closest('.sg'); row.replaceWith(fresh); updateGroup(g); } else addStep(ev.name, labelOf(ev), ev.ok ? 'ok' : 'bad');
  }
  function addUser(text) { steps = null; add(h(`<div class="msg-user">${esc(text)}</div>`), true); }
  function addAi(text) { steps = null; const el = h('<div class="msg-ai"></div>'); el.innerHTML = md(text); add(el); updateGroups(); }
  function addNote(text, level) { steps = null; add(h(`<div class="note ${esc(level || '')}">${esc(text)}</div>`)); updateGroups(); }
  function startWorking() {
    startedAt = startedAt || Date.now();
    if (!working) { working = h('<div class="working"><span class="spin"></span><span class="shine">Designing</span><span class="time"></span></div>'); feed.appendChild(working); clearInterval(workingTimer); workingTimer = setInterval(tick, 1000); }
    tick(); placeWorking(); scrollDown();
  }
  function tick() { if (!working) return; const s = Math.round((Date.now() - startedAt) / 1000); working.querySelector('.time').textContent = s >= 3 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : ''; }
  function stopWorking() { clearInterval(workingTimer); workingTimer = null; if (working) working.remove(); working = null; startedAt = 0; updateGroups(); }
  function placeWorking() {
    if (!working) return;
    if (feed.lastElementChild !== working) feed.appendChild(working);
    const prev = working.previousElementSibling;
    working.hidden = !!feed.querySelector('.ask:not(.done)') || !!(prev && prev.classList.contains('sg'));
  }
  function addApproval(ev) {
    steps = null;
    const el = add(h(`<div class="ask" data-req="${esc(ev.requestId)}"><h3>${esc(ev.title || 'Allow this?')}</h3>${ev.detail ? `<pre>${esc(String(ev.detail).slice(0, 1200))}</pre>` : ''}
      <div class="btns"><button type="button" class="btn btn-primary" data-v="once">Allow</button><button type="button" class="btn btn-secondary" data-v="reject">Don't allow</button></div><div class="result" hidden></div></div>`), true);
    el.querySelectorAll('[data-v]').forEach((b) => b.addEventListener('click', () => { api.approve(ev.requestId, b.dataset.v); resolveCard(ev.requestId, b.dataset.v === 'reject' ? 'Not allowed' : 'Allowed'); }));
  }
  function addQuestion(ev) {
    steps = null;
    const opts = (ev.options || []).slice(0, 6);
    const el = add(h(`<div class="ask" data-req="${esc(ev.requestId)}"><h3>${esc(ev.question || 'A question')}</h3>
      ${opts.length ? `<div class="btns">${opts.map((o, i) => `<button type="button" class="btn ${i === 0 ? 'btn-primary' : 'btn-secondary'}" data-o="${esc(o)}">${esc(o)}</button>`).join('')}</div>` : ''}
      <input type="text" placeholder="${opts.length ? 'Or type an answer' : 'Type your answer'}" /><div class="result" hidden></div></div>`), true);
    const answer = (t) => { if (!t) return; api.answer(ev.requestId, t); resolveCard(ev.requestId, t); };
    el.querySelectorAll('[data-o]').forEach((b) => b.addEventListener('click', () => answer(b.dataset.o)));
    const inp = el.querySelector('input');
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); answer(inp.value.trim()); } });
  }
  function resolveCard(requestId, text) {
    const el = feed.querySelector(`.ask[data-req="${CSS.escape(String(requestId))}"]`);
    if (!el || el.classList.contains('done')) return;
    el.classList.add('done'); const r = el.querySelector('.result'); r.hidden = false; r.textContent = text; placeWorking();
  }

  api.onEvent((ev) => {
    if (!S.cur) return;
    const mine = (ev.designId && ev.designId === S.cur.id) || (S.sessionId && ev.sessionId === S.sessionId);
    if (!mine) return;
    if (!S.sessionId && ev.sessionId) S.sessionId = ev.sessionId;
    switch (ev.type) {
      case 'tool_start': startWorking(); addStep(ev.name, labelOf(ev), 'run'); break;
      case 'tool_end': endStep(ev); break;
      case 'text': if (ev.text && ev.text.trim()) addAi(ev.text); break;
      case 'notice': addNote(ev.text, ev.level); break;
      case 'error': addNote(ev.error, 'error'); break;
      case 'approval_request': addApproval(ev); break;
      case 'approval_resolved': resolveCard(ev.requestId, ev.verdict === 'reject' ? 'Not allowed' : 'Allowed'); break;
      case 'question_request': addQuestion(ev); break;
      case 'question_resolved': resolveCard(ev.requestId, ev.answer || 'Skipped'); break;
      case 'run_finished': S.running = false; stopWorking(); syncSend(); loadList(); break;
      case 'session_sync': if (ev.message && ev.message.kind === 'user' && !feed.querySelector('.msg-user')) addUser(ev.message.text); break;
      default: break;
    }
  });
  api.onRuns((active) => {
    S.active = active || [];
    const was = S.running;
    S.running = !!S.sessionId && S.active.includes(S.sessionId);
    if (S.running && !was) startWorking();
    if (!S.running && was) stopWorking();
    syncSend(); renderList();
  });

  function syncSend() {
    $('work').classList.toggle('running', S.running);
    sendBtn.disabled = !S.running && (S.sending || !input.value.trim());
    sendBtn.setAttribute('aria-label', S.running ? 'Stop' : 'Send');
  }
  async function send() {
    if (S.running) { api.stop(S.cur.id); return; }
    const text = input.value.trim();
    if (!text || S.sending || !S.cur) return;
    S.sending = true; syncSend();
    addUser(text); input.value = ''; autosize(input, 160);
    startWorking(); S.running = true; syncSend();
    const r = await api.send(S.cur.id, text);
    S.sending = false;
    if (!r || r.error) { S.running = false; stopWorking(); addNote(r && r.error ? r.error : 'Craft could not start that.', 'error'); }
    else if (r.sessionId) S.sessionId = r.sessionId;
    syncSend();
  }
  sendBtn.addEventListener('click', send);
  input.addEventListener('input', () => { autosize(input, 160); syncSend(); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!S.running) send(); } });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) closeMenu(); });

  // Designs from the phone arrived (design-main.js pulls them when the tab opens).
  if (api.onSynced) api.onSynced(() => loadList());
  api.onShown(() => { if (window.applyDropTheme) window.applyDropTheme(); loadList(); if (S.cur) fitFrame(); });

  renderKinds();
  loadList().then(() => { if (!S.cur) showStart(); });
})();
