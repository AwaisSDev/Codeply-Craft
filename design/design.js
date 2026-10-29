// The Design tab's page: your designs in the sidebar, Craft's home for starting
// one, and one design at a time with its chat beside a live canvas. The canvas is
// the design's own index.html in a sandboxed frame (served as codeply-design://),
// reloaded as the agent writes it (design-main.js watches the folder).
(() => {
  const api = window.design;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const md = (t) => (window.CrewMarkdown ? window.CrewMarkdown.md(t) : esc(t));
  const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; };

  const KINDS = [
    { id: 'website', label: 'Website', hint: 'A landing page for a small coffee roaster in Lahore, warm and editorial', icon: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M3 9h18"/><path d="M6.5 6.8h.01M9 6.8h.01"/>' },
    { id: 'app', label: 'App', hint: 'A habit tracker app: today, one habit, and the weekly view', icon: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M10.5 18.5h3"/>' },
    { id: 'slides', label: 'Slides', hint: 'A 6-slide pitch deck for a student food delivery startup', icon: '<rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M12 17v3.5M8.5 20.5h7"/>' },
    { id: 'doc', label: 'Document', hint: 'A one-page resume for a junior product designer', icon: '<path d="M6 2.8h8l4.5 4.5v13.9H6z"/><path d="M14 2.8v4.5h4.5M9 12h6.5M9 15.5h6.5"/>' },
    { id: 'poster', label: 'Poster', hint: 'A poster for a jazz night this Friday at 9 on a rooftop', icon: '<rect x="5.5" y="2.5" width="13" height="19" rx="1.5"/><path d="M8.5 16h7M8.5 18.5h4.5"/><circle cx="12" cy="9" r="2.5"/>' },
    { id: 'social', label: 'Social post', hint: 'An Instagram post announcing our summer sale, 30% off', icon: '<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><path d="M17 7h.01"/>' },
    { id: 'logo', label: 'Logo', hint: 'A logo for Kite, a calm budgeting app', icon: '<path d="M12 2.8 20.5 12 12 21.2 3.5 12z"/><path d="M12 8v8"/>' },
  ];
  const kindOf = (id) => KINDS.find((k) => k.id === id) || KINDS[0];
  const kindSvg = (id) => `<svg viewBox="0 0 24 24">${kindOf(id).icon}</svg>`;
  const ICON = {
    check: '<svg viewBox="0 0 24 24"><path d="M5 12.5 9.5 17 19 7"/></svg>',
    x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    chev: '<svg class="chev" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>',
    image: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="8.5" cy="9.5" r="1.8"/><path d="m4 18 5.2-5 4 3.5 3-2.6L20 17"/></svg>',
    pdf: '<svg viewBox="0 0 24 24"><path d="M6 2.8h8l4.5 4.5v13.9H6z"/><path d="M14 2.8v4.5h4.5M9 13h6.5M9 16.5h4.5"/></svg>',
    folder: '<svg viewBox="0 0 24 24"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.6l2 2.2h7.4A2.5 2.5 0 0 1 21 9.7v7.8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/></svg>',
    pen: '<svg viewBox="0 0 24 24"><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M9.5 7V4.5h5V7M6 7l1 13h10l1-13"/></svg>',
    browser: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/></svg>',
    down: '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
    plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
    more: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>',
    edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16Z"/><path d="M13.5 6.5l4 4"/></svg>',
    chat: '<svg viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4Z"/><path d="M12 8v5M9.5 10.5h5"/></svg>',
    folderPlus: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M12 11v5M9.5 13.5h5"/></svg>',
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
  const ago = (t) => { const m = Math.round((Date.now() - (t || 0)) / 60000); if (m < 1) return 'now'; if (m < 60) return `${m}m ago`; const hr = Math.floor(m / 60); return hr < 24 ? `${hr}h ago` : `${Math.floor(hr / 24)}d ago`; };
  const slug = (t) => String(t || 'design').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'design';

  const S = {
    designs: [], categories: [], cur: null, sessionId: null, running: false, sending: false, kind: null, width: 1440, active: [], query: '', att: { start: [], chat: [] },
    category: null, from: null,   // a new design's category, and the design it uses as its reference
    editCat: null, freshCat: null, // the category whose name is being typed (fresh: just made)
  };

  // ─── sidebar: a few actions, then your designs in categories ──────────────
  // Each category folds away (remembered on this PC) and shows five designs, then
  // five more at a time. A design's row has Edit and "New chat from this" on hover;
  // right-click (or the menu key) files it in another category.
  const STEP = 5;
  const LOOSE = '_';         // the section for designs without a category
  const shown = new Map();   // section id -> how many of its designs show
  const local = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };
  const closed = new Set(local.get('dz.closedSections', []));

  document.querySelectorAll('.app-switch-btn').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.app === 'craft') api.toCraft(); else if (b.dataset.app === 'crew') api.toCrew();
  }));
  $('newBtn').addEventListener('click', () => showStart());
  $('catBtn').addEventListener('click', () => newCategory());

  // Search: an inline field that filters every row. Ctrl+K opens it, Escape closes it.
  function setSearch(open) {
    $('searchBox').hidden = !open;
    $('searchBtn').setAttribute('aria-expanded', String(open));
    if (open) { $('searchInput').focus(); $('searchInput').select(); return; }
    if (S.query || $('searchInput').value) { S.query = ''; $('searchInput').value = ''; renderList(); }
  }
  $('searchBtn').addEventListener('click', () => setSearch($('searchBox').hidden));
  $('searchInput').addEventListener('input', (e) => { S.query = e.target.value.trim().toLowerCase(); renderList(); });
  $('searchInput').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); setSearch(false); $('searchBtn').focus(); } });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); setSearch(true); }
  });

  const thumb = (d, cls = 'pic') => `<span class="${cls}">${d.thumbUrl ? `<img src="${esc(d.thumbUrl)}" alt="" loading="lazy">` : kindSvg(d.kind)}</span>`;
  const known = (id) => !!id && S.categories.some((c) => c.id === id);
  function sectionsOf() {
    const out = S.categories.map((c) => ({ id: c.id, name: c.name, cat: true, rows: S.designs.filter((d) => d.category === c.id) }));
    const loose = S.designs.filter((d) => !known(d.category));
    if (loose.length || !out.length) out.push({ id: LOOSE, name: out.length ? 'Uncategorized' : 'Designs', cat: false, rows: loose });
    return out;
  }
  const hit = (d) => d.title.toLowerCase().includes(S.query) || kindOf(d.kind).label.toLowerCase().includes(S.query);

  // Redrawn whole; keyboard focus stays on the same control. Not while a category's name is being typed.
  function renderList(force) {
    if (S.editCat && !force) return;
    const box = $('list');
    const keep = box.contains(document.activeElement) ? document.activeElement.dataset.k : null;
    box.innerHTML = '';
    let hits = 0;
    for (const s of sectionsOf()) {
      const rows = !S.query || s.name.toLowerCase().includes(S.query) ? s.rows : s.rows.filter(hit);
      if (S.query && !rows.length && S.editCat !== s.id) continue;
      hits += rows.length;
      box.appendChild(section(s, rows));
    }
    if (S.query && !hits) box.appendChild(h(`<div class="dz-none">No designs match "${esc($('searchInput').value.trim())}".</div>`));
    const naming = box.querySelector('.dz-sec-input');
    if (naming) { naming.focus(); naming.select(); naming.scrollIntoView({ block: 'nearest' }); }
    else if (keep) { const el = box.querySelector(`[data-k="${CSS.escape(keep)}"]`); if (el) el.focus(); }
  }

  function section(s, rows) {
    const isClosed = closed.has(s.id) && !S.query;
    const editing = S.editCat === s.id;
    const at = S.cur ? rows.findIndex((d) => d.id === S.cur.id) : -1;
    // The open design always shows, even past the first five.
    const limit = S.query ? rows.length : Math.max(shown.get(s.id) || STEP, Math.ceil((at + 1) / STEP) * STEP);
    const add = s.cat ? `New design in ${s.name}` : 'New design';
    const el = h(`<section class="dz-sec${isClosed ? ' closed' : ''}">
      <div class="dz-sec-head">
        ${editing ? `<input class="dz-sec-input" value="${esc(s.name)}" aria-label="Category name" maxlength="60" spellcheck="false">`
          : `<button type="button" class="dz-sec-toggle" data-k="tog:${esc(s.id)}" aria-expanded="${!isClosed}" aria-controls="sec-${esc(s.id)}"><span>${esc(s.name)}</span>${ICON.down}</button>
        <button type="button" class="dz-sec-tool" data-k="opt:${esc(s.id)}" data-menu aria-label="${esc(s.name)} options" title="Options">${ICON.more}</button>
        <button type="button" class="dz-sec-tool" data-k="add:${esc(s.id)}" aria-label="${esc(add)}" title="${esc(add)}">${ICON.plus}</button>`}
      </div>
      <div class="dz-sec-body" id="sec-${esc(s.id)}"><div class="dz-sec-rows"></div></div>
    </section>`);
    const body = el.querySelector('.dz-sec-body');
    body.inert = isClosed;
    const list = el.querySelector('.dz-sec-rows');
    for (const d of rows.slice(0, limit)) list.appendChild(designRow(d));
    if (!rows.length) list.appendChild(h(`<div class="dz-none">${s.cat ? 'No designs here yet' : 'No designs yet'}</div>`));
    const left = rows.length - limit;
    if (left > 0) {
      const more = h(`<button type="button" class="dz-more" data-k="show:${esc(s.id)}">${ICON.down}Show ${Math.min(STEP, left)} more</button>`);
      more.addEventListener('click', () => {
        shown.set(s.id, limit + STEP);
        renderList();
        const next = $('list').querySelector(`[data-k="${CSS.escape('row:' + rows[limit].id)}"]`);
        if (next) next.focus();
      });
      list.appendChild(more);
    }

    const head = el.querySelector('.dz-sec-head');
    const tog = el.querySelector('.dz-sec-toggle');
    if (tog) {
      tog.addEventListener('click', () => {
        const shut = !el.classList.contains('closed');
        el.classList.toggle('closed', shut);
        tog.setAttribute('aria-expanded', String(!shut));
        body.inert = shut;
        if (shut) closed.add(s.id); else closed.delete(s.id);
        local.set('dz.closedSections', [...closed]);
      });
      const [opt, plus] = el.querySelectorAll('.dz-sec-tool');
      plus.addEventListener('click', () => showStart({ category: s.cat ? s.id : null }));
      opt.addEventListener('click', () => { if (!menu.hidden && menuFrom === opt) closeMenu(); else catMenu(s, opt); });
      head.addEventListener('contextmenu', (e) => { e.preventDefault(); catMenu(s, tog, pointOf(e)); });
    }
    const inp = el.querySelector('.dz-sec-input');
    if (inp) {
      // Enter keeps the name, Escape takes it back, clicking away keeps it.
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); finishCat(s.id, inp.value); }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finishCat(s.id, ''); }
      });
      inp.addEventListener('blur', () => finishCat(s.id, inp.value));
    }
    return el;
  }

  // One line: a small thumbnail, the title, and on hover Edit and "New chat from this".
  function designRow(d) {
    const running = d.sessionId && S.active.includes(d.sessionId);
    const cur = S.cur && S.cur.id === d.id;
    const tools = [`<button type="button" class="dz-tool" data-k="edit:${esc(d.id)}" aria-label="Edit ${esc(d.title)}" title="Edit">${ICON.edit}</button>`];
    if (d.ready) tools.push(`<button type="button" class="dz-tool" data-k="from:${esc(d.id)}" aria-label="New chat from ${esc(d.title)}" title="New chat from this">${ICON.chat}</button>`);
    const el = h(`<div class="dz-line" style="--n:${tools.length}">
      <button type="button" class="dz-row dz-design" data-k="row:${esc(d.id)}"${cur ? ' aria-current="true"' : ''} title="${esc(`${d.title} · ${kindOf(d.kind).label} · ${ago(d.updatedAt)}`)}">${thumb(d, 'dz-sw')}<span class="label">${esc(d.title)}</span><span class="grow"></span>${running ? '<span class="busy" role="img" aria-label="Designing"></span>' : ''}</button>
      <div class="dz-tools">${tools.join('')}</div>
    </div>`);
    const row = el.querySelector('.dz-design');
    row.addEventListener('click', () => openDesign(d.id));
    el.querySelector('[data-k^="edit:"]').addEventListener('click', () => openDesign(d.id));
    const from = el.querySelector('[data-k^="from:"]');
    if (from) from.addEventListener('click', () => newFrom(d));
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); designMenu(d, row, pointOf(e)); });
    return el;
  }

  // "New chat from this": the start screen with this design as the reference (and its kind and
  // category). design-main.js gives the agent its page, pictures and thumbnail with the first message.
  function newFrom(d) { showStart({ from: d.id, category: known(d.category) ? d.category : null, kind: d.kind }); }

  async function newCategory(moveId) {
    if (S.editCat) return;
    const c = await api.catCreate('New category');
    if (!c) return;
    if (moveId) await api.move(moveId, c.id);
    closed.delete(c.id);
    if (S.query) setSearch(false);
    await loadList();
    S.editCat = c.id; S.freshCat = c.id;
    renderList(true);
  }
  async function finishCat(id, name) {
    if (S.editCat !== id) return;
    const fresh = S.freshCat === id;
    S.editCat = null; S.freshCat = null;
    name = String(name || '').trim();
    // Escape on a category just made (with nothing in it yet) takes it back.
    if (name) await api.catRename(id, name);
    else if (fresh && !S.designs.some((d) => d.category === id)) await api.catDelete(id);
    await loadList();
    const t = $('list').querySelector(`[data-k="${CSS.escape('tog:' + id)}"]`);
    if (document.activeElement === document.body) (t || $('catBtn')).focus();
  }

  function renderRecent() {
    const box = $('recent');
    box.innerHTML = '';
    for (const d of S.designs.filter((x) => x.ready).slice(0, 4)) {
      const c = h(`<button type="button" class="dz-card">${thumb(d, 'pic')}<b>${esc(d.title)}</b><small>${esc(kindOf(d.kind).label)} · ${esc(ago(d.updatedAt))}</small></button>`);
      c.addEventListener('click', () => openDesign(d.id));
      box.appendChild(c);
    }
  }
  async function loadList() {
    const r = await api.list();
    S.designs = r.designs || [];
    S.categories = r.categories || [];
    if (S.cur) { const fresh = S.designs.find((x) => x.id === S.cur.id); if (fresh) S.cur = { ...S.cur, ...fresh }; }
    renderList(); renderRecent();
    if (!$('start').hidden) renderCtx();
  }

  // ─── reference images (start box and chat) ────────────────────────────────
  // Shrunk to 1600px JPEG before they go to the model.
  function shrink(file) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, 1600 / Math.max(img.width, img.height));
        const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', 0.86));
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    });
  }
  function renderAtt(which) {
    const row = $(which === 'start' ? 'startAtt' : 'chatAtt');
    const list = S.att[which];
    row.hidden = !list.length;
    row.innerHTML = list.map((src, i) => `<span class="dz-att"><img src="${src}" alt=""><button type="button" data-i="${i}" aria-label="Remove">${ICON.x}</button></span>`).join('');
    row.querySelectorAll('[data-i]').forEach((b) => b.addEventListener('click', () => { list.splice(Number(b.dataset.i), 1); renderAtt(which); syncStart(); syncSend(); }));
  }
  function wireAttach(which, btn, inputId) {
    $(btn).addEventListener('click', () => $(inputId).click());
    $(inputId).addEventListener('change', async (e) => {
      for (const f of [...e.target.files].slice(0, 4 - S.att[which].length)) { const d = await shrink(f); if (d) S.att[which].push(d); }
      e.target.value = '';
      renderAtt(which); syncStart(); syncSend();
    });
  }
  wireAttach('start', 'startAttach', 'startFile');
  wireAttach('chat', 'chatAttach', 'chatFile');

  // ─── start ────────────────────────────────────────────────────────────────
  const startInput = $('startInput');
  function renderKinds() {
    const box = $('kinds');
    box.innerHTML = '';
    for (const k of KINDS) {
      const b = h(`<button type="button" class="tray-btn ${S.kind === k.id ? 'on' : ''}" title="${k.label}"><svg viewBox="0 0 24 24">${k.icon}</svg><span>${k.label}</span></button>`);
      b.addEventListener('click', () => { S.kind = S.kind === k.id ? null : k.id; renderKinds(); startInput.focus(); });
      box.appendChild(b);
    }
    startInput.placeholder = S.from ? 'What should it be? A pricing page in the same style, a matching poster'
      : S.kind ? kindOf(S.kind).hint : 'Describe what to design: what it is, who it\'s for, the feel';
  }
  // o: { category, from, kind } from a category's + or a design's "New chat from this"
  function showStart(o = {}) {
    if (S.cur) api.close();
    S.cur = null; S.sessionId = null;
    S.category = o.category || null; S.from = o.from || null;
    if (o.kind) S.kind = o.kind;
    $('work').hidden = true; $('start').hidden = false;
    renderList(); renderRecent(); renderCtx(); renderKinds();
    setTimeout(() => startInput.focus(), 30);
  }
  // What the new design starts with, above the box: its reference design and its category.
  function renderCtx() {
    const ref = S.from ? S.designs.find((d) => d.id === S.from) : null;
    const cat = S.category ? S.categories.find((c) => c.id === S.category) : null;
    if (!ref) S.from = null;
    if (!cat) S.category = null;
    const row = $('startCtx');
    row.hidden = !ref && !cat;
    row.innerHTML = (ref ? `<span class="dz-ctx">${thumb(ref, 'dz-sw')}<span class="t"><span class="k">Reference</span>${esc(ref.title)}</span><button type="button" data-x="from" aria-label="Don't use ${esc(ref.title)} as the reference" title="Remove">${ICON.x}</button></span>` : '')
      + (cat ? `<span class="dz-ctx">${ICON.folder}<span class="t"><span class="k">In</span>${esc(cat.name)}</span><button type="button" data-x="category" aria-label="Don't put it in ${esc(cat.name)}" title="Remove">${ICON.x}</button></span>` : '');
    row.querySelectorAll('[data-x]').forEach((b) => b.addEventListener('click', () => { S[b.dataset.x] = null; renderCtx(); renderKinds(); startInput.focus(); }));
  }
  const autosize = (t, max) => { t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, max) + 'px'; };
  const syncStart = () => { $('startSend').disabled = S.sending || !startInput.value.trim(); };
  startInput.addEventListener('input', () => { autosize(startInput, 220); syncStart(); });
  startInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); create(); } });
  $('startSend').addEventListener('click', create);

  async function create() {
    const text = startInput.value.trim();
    if (!text || S.sending) return;
    S.sending = true; syncStart();
    const r = await api.create(text, S.kind, S.att.start, { category: S.category, from: S.from });
    S.sending = false;
    if (!r || r.error || !r.design) { syncStart(); startInput.placeholder = r && r.error ? r.error : 'Codeply could not start that.'; return; }
    startInput.value = ''; autosize(startInput, 220); S.kind = null; S.category = null; S.from = null; S.att.start = []; renderAtt('start'); renderCtx(); renderKinds(); syncStart();
    await loadList();
    await openDesign(r.design.id);
  }

  // ─── one design ───────────────────────────────────────────────────────────
  const feed = $('feed'); const thread = $('thread'); const input = $('input'); const sendBtn = $('sendBtn');
  const frame = $('frame'); const wrap = $('frameWrap'); const canvas = $('canvas'); const viewport = $('viewport');

  async function openDesign(id) {
    const r = await api.open(id);
    if (!r) { await loadList(); return; }
    S.cur = r.design; S.sessionId = r.design.sessionId; S.running = !!r.running;
    S.width = S.cur.kind === 'website' ? (S.width || 1440) : S.cur.size.w;
    $('start').hidden = true; $('work').hidden = false;
    feed.innerHTML = ''; steps = null; stopWorking();
    for (const m of r.messages) {
      if (m.kind === 'user') addUser(m.text, m.images);
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
    $('dKindIco').innerHTML = kindSvg(d.kind);
    $('dKindIco').title = kindOf(d.kind).label;
    $('sizes').hidden = d.kind !== 'website';
    $('buildBtn').hidden = !(d.kind === 'website' || d.kind === 'app');
    document.querySelectorAll('#sizes button').forEach((b) => b.classList.toggle('on', Number(b.dataset.w) === S.width));
    $('chromeUrl').textContent = `${slug(d.title)}.design`;
  }
  document.querySelectorAll('#sizes button').forEach((b) => b.addEventListener('click', () => { S.width = Number(b.dataset.w); renderHead(); fitFrame(); }));

  // Rename: the pencil, or double-click the title; Enter keeps it.
  const startRename = () => { const t = $('dTitle'); t.contentEditable = 'true'; t.focus(); document.getSelection().selectAllChildren(t); };
  $('renameBtn').addEventListener('click', startRename);
  $('dTitle').addEventListener('dblclick', startRename);
  $('dTitle').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } if (e.key === 'Escape') { e.currentTarget.textContent = S.cur.title; e.currentTarget.blur(); } });
  $('dTitle').addEventListener('blur', async (e) => {
    e.currentTarget.contentEditable = 'false';
    const title = e.currentTarget.textContent.trim();
    if (S.cur && title && title !== S.cur.title) { const v = await api.rename(S.cur.id, title); if (v) { S.cur = { ...S.cur, ...v }; await loadList(); renderHead(); } }
    else if (S.cur) e.currentTarget.textContent = S.cur.title;
  });

  // ─── the canvas ───────────────────────────────────────────────────────────
  function loadFrame(force) {
    const d = S.cur;
    $('waiting').hidden = !!d.ready;
    wrap.hidden = !d.ready;
    if (!d.ready) return;
    if (force || frame.dataset.for !== d.id) frame.dataset.for = d.id;
    frame.src = `${d.previewUrl}?v=${Date.now()}`;
    fitFrame();
  }
  $('reloadBtn').addEventListener('click', () => S.cur && loadFrame(true));
  $('openBtn').addEventListener('click', () => S.cur && api.openFile(S.cur.id));

  // The design at its real size, scaled to fit. A website shows in a browser window,
  // or a phone at phone width; posters, posts and logos are shown whole.
  function fitFrame() {
    const d = S.cur;
    if (!d || !d.ready) return;
    const site = d.kind === 'website' || d.kind === 'app';
    const phone = d.kind === 'website' && S.width < 600;
    const whole = ['poster', 'social', 'logo'].includes(d.kind);
    const w = d.kind === 'website' ? S.width : d.size.w;
    const chrome = site && !phone ? 32 : 0;
    const pad = phone ? 64 : 48;
    const cw = canvas.clientWidth - pad; const ch = canvas.clientHeight - pad;
    const fullH = whole ? d.size.h : phone ? 844 : null;
    const scale = Math.min(1, cw / w, fullH ? (ch - chrome) / fullH : 1);
    const vh = fullH || Math.max(240, (ch - chrome) / scale);
    wrap.classList.toggle('phone', phone);
    wrap.classList.toggle('bare', !site);
    frame.style.width = w + 'px'; frame.style.height = vh + 'px';
    frame.style.transform = `scale(${scale})`;
    viewport.style.width = Math.round(w * scale) + 'px'; viewport.style.height = Math.round(vh * scale) + 'px';
    const fw = Math.round(w * scale); const fh = Math.round(vh * scale) + chrome;
    wrap.style.width = fw + 'px';
    wrap.style.left = Math.round((canvas.clientWidth - fw) / 2) + 'px';
    wrap.style.top = Math.max(pad / 2, Math.round((canvas.clientHeight - fh) / 2)) + 'px';
    $('sizeLabel').textContent = `${w} × ${fullH || (d.kind === 'website' ? 900 : d.size.h)} · ${Math.round(scale * 100)}%`;
  }
  new ResizeObserver(fitFrame).observe(canvas);
  api.onChanged(({ id, design }) => {
    const i = S.designs.findIndex((x) => x.id === id);
    if (i >= 0 && design) S.designs[i] = { ...S.designs[i], ...design };
    if (!S.cur || S.cur.id !== id || !design) { renderList(); return; }
    const kindChanged = design.kind !== S.cur.kind;
    S.cur = { ...S.cur, ...design };
    if (kindChanged) S.width = design.kind === 'website' ? 1440 : design.size.w;
    renderHead(); renderList(); loadFrame(false);
  });

  // ─── menus ────────────────────────────────────────────────────────────────
  const menu = $('menu');
  let menuFrom = null; // what opened the menu, for focus to go back to
  // Below the anchor, right-aligned; or at a point (a right-click). Kept on screen.
  function openMenu(anchor, html, at) {
    menu.innerHTML = html; menu.hidden = false; menuFrom = anchor;
    const a = anchor.getBoundingClientRect();
    const x = at ? at.x : a.right - menu.offsetWidth; const y = at ? at.y : a.bottom + 6;
    menu.style.top = Math.round(Math.max(8, Math.min(y, window.innerHeight - menu.offsetHeight - 8))) + 'px';
    menu.style.left = Math.round(Math.max(8, Math.min(x, window.innerWidth - menu.offsetWidth - 8))) + 'px';
    return menu;
  }
  function closeMenu() { menu.hidden = true; menu.innerHTML = ''; menuFrom = null; }
  // A right-click opens at the pointer; the menu key (no pointer) under the row.
  const pointOf = (e) => (e && (e.clientX || e.clientY) ? { x: e.clientX, y: e.clientY } : null);
  const atRow = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + 8, y: r.bottom + 4 }; };
  document.addEventListener('mousedown', (e) => { if (!menu.hidden && !menu.contains(e.target) && !e.target.closest('[data-menu]')) closeMenu(); });
  window.addEventListener('blur', closeMenu);
  menu.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...menu.querySelectorAll('button')];
    if (!items.length) return;
    e.preventDefault();
    const i = items.indexOf(document.activeElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
  });
  const on = (m, sel, fn) => { const b = m.querySelector(sel); if (b) b.addEventListener('click', () => { closeMenu(); fn(); }); };

  // A design's menu in the sidebar: edit it, start from it, rename, file it in a category, or bin it.
  function designMenu(d, row, at) {
    const here = (id) => (id ? d.category === id : !known(d.category));
    const move = (id, name) => `<button type="button" data-move="${esc(id)}"${here(id) ? ' aria-current="true"' : ''}>${here(id) ? ICON.check : ICON.folder}<span class="t">${esc(name)}</span></button>`;
    const m = openMenu(row, `
      <button type="button" data-a="edit">${ICON.edit}<span class="t">Edit</span></button>
      ${d.ready ? `<button type="button" data-a="from">${ICON.chat}<span class="t">New chat from this<small>Uses its look, layout and colors</small></span></button>` : ''}
      <button type="button" data-a="rename">${ICON.pen}<span class="t">Rename</span></button>
      <hr><div class="dz-menu-label">Move to</div>
      ${S.categories.map((c) => move(c.id, c.name)).join('')}${move('', 'Uncategorized')}
      <button type="button" data-a="newcat">${ICON.folderPlus}<span class="t">New category</span></button>
      <hr><button type="button" data-a="reveal">${ICON.folder}<span class="t">Show in folder</span></button>
      <button type="button" class="danger" data-a="del">${ICON.trash}<span class="t">Move to Recycle Bin</span></button>`, at || atRow(row));
    on(m, '[data-a="edit"]', () => openDesign(d.id));
    on(m, '[data-a="from"]', () => newFrom(d));
    on(m, '[data-a="rename"]', async () => { if (!S.cur || S.cur.id !== d.id) await openDesign(d.id); if (S.cur && S.cur.id === d.id) startRename(); });
    on(m, '[data-a="newcat"]', () => newCategory(d.id));
    on(m, '[data-a="reveal"]', () => api.reveal(d.id));
    on(m, '[data-a="del"]', () => removeDesign(d.id));
    m.querySelectorAll('[data-move]').forEach((b) => b.addEventListener('click', async () => {
      closeMenu();
      const to = b.dataset.move || null;
      if (to) { closed.delete(to); local.set('dz.closedSections', [...closed]); }
      await api.move(d.id, to);
      await loadList();
    }));
    m.querySelector('button').focus();
  }

  // A category's menu: rename, a new design in it, or delete it (its designs go back to Uncategorized).
  function catMenu(s, anchor, at) {
    const m = openMenu(anchor, s.cat ? `
      <button type="button" data-a="add">${ICON.plus}<span class="t">New design here</span></button>
      <button type="button" data-a="rename">${ICON.pen}<span class="t">Rename</span></button>
      <hr><button type="button" data-a="folder">${ICON.folder}<span class="t">Open the designs folder</span></button>
      <hr><button type="button" class="danger" data-a="del">${ICON.trash}<span class="t">Delete category<small>Its designs move to Uncategorized</small></span></button>` : `
      <button type="button" data-a="add">${ICON.plus}<span class="t">New design</span></button>
      <button type="button" data-a="newcat">${ICON.folderPlus}<span class="t">New category</span></button>
      <hr><button type="button" data-a="folder">${ICON.folder}<span class="t">Open the designs folder</span></button>`, at || atRow(anchor));
    on(m, '[data-a="add"]', () => showStart({ category: s.cat ? s.id : null }));
    on(m, '[data-a="rename"]', () => { S.editCat = s.id; S.freshCat = null; renderList(true); });
    on(m, '[data-a="newcat"]', () => newCategory());
    on(m, '[data-a="folder"]', () => api.openFolder());
    on(m, '[data-a="del"]', async () => {
      await api.catDelete(s.id);
      closed.delete(s.id); local.set('dz.closedSections', [...closed]);
      await loadList();
      $('catBtn').focus();
    });
    m.querySelector('button').focus();
  }

  async function removeDesign(id) {
    const r = await api.remove(id);
    const open = S.cur && S.cur.id === id;
    if (r && r.error) { if (open) note(r.error, true); return; }
    await loadList();
    if (open) showStart();
  }

  $('exportBtn').addEventListener('click', (e) => {
    if (!menu.hidden) return closeMenu();
    const d = S.cur;
    const m = openMenu(e.currentTarget, `
      <button type="button" data-f="png">${ICON.image}<span class="t">PNG image<small>${d.kind === 'website' || d.kind === 'app' ? 'The whole page, at full size' : 'Every page or slide, at full size'}</small></span></button>
      <button type="button" data-f="pdf">${ICON.pdf}<span class="t">PDF<small>${d.kind === 'slides' ? 'A page per slide' : d.kind === 'doc' ? 'Ready to print' : 'For sharing'}</small></span></button>
      <hr><button type="button" data-open>${ICON.browser}<span class="t">Open in your browser</span></button>
      <button type="button" data-reveal>${ICON.folder}<span class="t">Show in folder<small>The HTML file and its pictures</small></span></button>`);
    m.querySelectorAll('[data-f]').forEach((b) => b.addEventListener('click', async () => {
      closeMenu();
      note('Exporting…');
      const r = await api.exportAs(S.cur.id, b.dataset.f);
      note(r && r.error ? r.error : r && r.ok ? 'Exported.' : '', r && r.error);
    }));
    m.querySelector('[data-open]').addEventListener('click', () => { closeMenu(); api.openFile(S.cur.id); });
    m.querySelector('[data-reveal]').addEventListener('click', () => { closeMenu(); api.reveal(S.cur.id); });
  });
  $('moreBtn').addEventListener('click', (e) => {
    if (!menu.hidden) return closeMenu();
    const d = S.cur;
    const m = openMenu(e.currentTarget, `
      <button type="button" data-rename>${ICON.pen}<span class="t">Rename</span></button>
      ${d.ready ? `<button type="button" data-from>${ICON.chat}<span class="t">New chat from this<small>Uses its look, layout and colors</small></span></button>` : ''}
      <button type="button" data-reveal>${ICON.folder}<span class="t">Show in folder</span></button>
      <hr><button type="button" class="danger" data-del>${ICON.trash}<span class="t">Move to Recycle Bin</span></button>`);
    m.querySelector('[data-rename]').addEventListener('click', () => { closeMenu(); startRename(); });
    on(m, '[data-from]', () => newFrom(d));
    m.querySelector('[data-reveal]').addEventListener('click', () => { closeMenu(); api.reveal(S.cur.id); });
    m.querySelector('[data-del]').addEventListener('click', () => { closeMenu(); removeDesign(d.id); });
  });
  let noteTimer = null;
  function note(text, bad) {
    const n = $('chatNote'); n.textContent = text || ''; n.classList.toggle('bad', !!bad);
    clearTimeout(noteTimer); if (text && !bad) noteTimer = setTimeout(() => { n.textContent = ''; }, 4000);
  }

  $('buildBtn').addEventListener('click', async () => {
    const b = $('buildBtn'); b.disabled = true;
    note('Setting up a project in Codeply…');
    const r = await api.build(S.cur.id);
    b.disabled = false;
    note(r && r.error ? r.error : '', !!(r && r.error));
  });

  // ─── the chat: Craft's messages, with the agent's steps folded into one row ──
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
  function addUser(text, images) {
    steps = null;
    const pics = Array.isArray(images) && images.length ? `<div class="bubble-images">${images.map((src) => `<img src="${esc(src)}" alt="">`).join('')}</div>` : '';
    add(h(`<div class="msg user">${pics}<div class="bubble">${esc(text)}</div></div>`), true);
  }
  function addAi(text) { steps = null; const el = h('<div class="msg assistant"></div>'); el.innerHTML = md(text); add(el); updateGroups(); }
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
      case 'session_sync': if (ev.message && ev.message.kind === 'user' && !feed.querySelector('.msg.user')) addUser(ev.message.text, ev.message.images); break;
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
    sendBtn.title = S.running ? 'Stop' : 'Send';
  }
  async function send() {
    if (S.running) { api.stop(S.cur.id); return; }
    const text = input.value.trim();
    if (!text || S.sending || !S.cur) return;
    const images = S.att.chat.slice();
    S.sending = true; syncSend();
    addUser(text, images); input.value = ''; autosize(input, 180); S.att.chat = []; renderAtt('chat');
    startWorking(); S.running = true; syncSend();
    const r = await api.send(S.cur.id, text, images);
    S.sending = false;
    if (!r || r.error) { S.running = false; stopWorking(); addNote(r && r.error ? r.error : 'Codeply could not start that.', 'error'); }
    else if (r.sessionId) S.sessionId = r.sessionId;
    syncSend();
  }
  sendBtn.addEventListener('click', send);
  input.addEventListener('input', () => { autosize(input, 180); syncSend(); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!S.running) send(); } });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!menu.hidden) {
      const from = menuFrom; const inMenu = menu.contains(document.activeElement);
      closeMenu();
      if (inMenu && from && from.isConnected) from.focus();
    } else if (!$('searchBox').hidden && $('side').contains(document.activeElement)) { setSearch(false); $('searchBtn').focus(); }
  });

  if (api.onSynced) api.onSynced(() => loadList());
  api.onShown(() => { if (window.applyDropTheme) window.applyDropTheme(); loadList(); if (S.cur) fitFrame(); });

  renderKinds();
  loadList().then(() => { if (!S.cur) showStart(); });
})();
