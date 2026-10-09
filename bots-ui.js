// Bots in the desktop window: the Bots screen (gallery, templates, "Describe
// your bot", the editor with the avatar builder and memory), the bot chip in
// each composer that picks who answers, and the bot rows in a chat (the
// "Orion" badge on replies, "Asked Vera: ..." delegation rows).
// Loaded after app.js and bot-avatar.js; uses app.js globals (api, state,
// chatColumn, esc, mdToHtml, showToast, nearBottom, scrollToBottom).
(() => {
  if (!window.craft || !window.craft.botsList || !window.CraftAvatar) return;
  const A = window.CraftAvatar;
  const KEY = 'craft.bot';

  let cat = { bots: [], templates: [], tones: {}, approvals: {}, maxMemory: 60 };
  let selected = '';
  try { selected = localStorage.getItem(KEY) || ''; } catch {}

  const byId = (id) => cat.bots.find((b) => b.id === id) || null;
  const byName = (n) => cat.bots.find((b) => b.name.toLowerCase() === String(n || '').trim().toLowerCase()) || null;
  const av = (avatar, size, opts) => A.renderAvatar(avatar, size, opts);
  const ROLE = { orchestrator: 'Orchestrator', specialist: 'Specialist' };
  const ICON_X = '<svg viewBox="0 0 24 24"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>';
  const CRAFT_AVATAR = { shape: 'burst9', eyes: 'pills', color: '#8e8e93' }; // stand-in for an unknown bot
// Craft's own agents, the mascot balls: Craft (purple) picks a specialist by
  // itself; picking one here pins it for the chat ('role:<id>' goes to main.js).
  const ROLES = [
    { id: '', file: 'general.png', label: 'Craft', sub: 'Main agent, picks the right specialist' },
    { id: 'role:frontend', file: 'frontend.png', label: 'Frontend', sub: 'Pixel, UI and pages' },
    { id: 'role:backend', file: 'backend.png', label: 'Backend', sub: 'Circuit, servers and APIs' },
    { id: 'role:database', file: 'database.png', label: 'Database', sub: 'Index, data and schemas' },
    { id: 'role:testing', file: 'testing.png', label: 'QA', sub: 'Scout, tests and checks' },
    { id: 'role:security', file: 'security.png', label: 'Security', sub: 'Warden, safety review' },
    { id: 'role:devops', file: 'devops.png', label: 'DevOps', sub: 'Rocket, deploys and builds' },
    { id: 'role:docs', file: 'docs.png', label: 'Docs', sub: 'Scribe, writing and READMEs' },
  ];
  const roleOf = (id) => ROLES.find((r) => r.id === (id || '')) || null;
  const ball = (r, cls) => mascotHtml(r.file, cls, r.label);

  async function load() {
    try {
      const r = await api.botsList();
      if (r && !r.error) cat = r;
    } catch {}
    if (selected && !byId(selected) && !roleOf(selected)) setSelected('');
    paintChips();
    return cat;
  }

  function setSelected(id) {
    selected = id || '';
    try { localStorage.setItem(KEY, selected); } catch {}
    paintChips();
  }

  // ─── Composer chip ───────────────────────────────────────────────────────
  function addChips() {
    document.querySelectorAll('.composer-bottom-right').forEach((row) => {
      if (row.querySelector('.bot-chip')) return;
      const b = document.createElement('button');
      b.className = 'bot-chip';
      b.type = 'button';
      b.title = 'Choose who answers';
      b.addEventListener('click', (e) => { e.stopPropagation(); openMenu(b); });
      const model = row.querySelector('.model-btn');
      row.insertBefore(b, model || row.firstChild);
    });
    paintChips();
  }

  function paintChips() {
    const bot = byId(selected);
    const role = bot ? null : roleOf(selected) || ROLES[0];
    document.querySelectorAll('.bot-chip').forEach((b) => {
      const key = bot ? `${bot.id}:${JSON.stringify(bot.avatar)}:${bot.name}` : 'role' + role.id;
      if (b.dataset.key === key) return;
      b.dataset.key = key;
      b.classList.toggle('on', !!bot || !!role.id);
      b.innerHTML = bot
        ? `${av(bot.avatar, 20, { still: true })}<span>${esc(bot.name)}</span>`
        : `${ball(role, 'mascot-chip')}<span>${esc(role.label)}</span>`;
    });
    document.querySelectorAll('.composer-input').forEach((t) => {
      if (!t.dataset.basePlaceholder) t.dataset.basePlaceholder = t.placeholder;
      t.placeholder = bot ? `Ask ${bot.name} anything` : t.dataset.basePlaceholder;
    });
  }

  let menu = null;
  function closeMenu() { if (menu) { menu.remove(); menu = null; } }
  document.addEventListener('click', (e) => { if (menu && !menu.contains(e.target)) closeMenu(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

  function openMenu(anchor) {
    if (menu) { closeMenu(); return; }
    menu = document.createElement('div');
    menu.className = 'menu bot-menu';
    const item = (id, avatarHtml, name, sub) => `<button class="bot-menu-item${id === selected ? ' on' : ''}" data-id="${esc(id)}">${avatarHtml}<span class="bot-menu-text"><b>${esc(name)}</b><span>${esc(sub)}</span></span>${id === selected ? '<svg class="bot-menu-check" viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg>' : ''}</button>`;
    menu.innerHTML = `<div class="bot-menu-head">Who answers</div>` +
      ROLES.map((r) => item(r.id, ball(r, 'mascot-menu'), r.label, r.sub)).join('') +
      (cat.bots.length ? '<div class="bot-menu-sep"></div><div class="bot-menu-head">Your bots</div>' : '') +
      cat.bots.map((b) => item(b.id, av(b.avatar, 26, { still: true }), b.name, b.specialty || ROLE[b.role])).join('') +
      `<div class="bot-menu-sep"></div><button class="bot-menu-manage" data-act="manage">${cat.bots.length ? 'Manage bots' : 'Create a bot'}</button>`;
    document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect();
    const h = menu.offsetHeight;
    menu.style.left = `${Math.max(8, Math.min(window.innerWidth - menu.offsetWidth - 8, r.right - menu.offsetWidth))}px`;
    menu.style.top = `${r.top - h - 8 > 8 ? r.top - h - 8 : r.bottom + 8}px`;
    menu.querySelectorAll('.bot-menu-item').forEach((el) => el.addEventListener('click', () => {
      setSelected(el.dataset.id);
      closeMenu();
      const b = byId(el.dataset.id);
      const r = roleOf(el.dataset.id);
      showToast(b ? `${b.name} answers your next messages.` : r && r.id ? `${r.label} works on your next messages.` : 'Craft picks the right specialist again.');
    }));
    menu.querySelector('[data-act="manage"]').addEventListener('click', () => { closeMenu(); if (window.CraftCrew) window.CraftCrew.show(); else openModal(); });
  }

  // ─── Modal ───────────────────────────────────────────────────────────────
  let backdrop = null;
  let box = null;
  let screen = { view: 'gallery' };

  function modal() {
    if (backdrop) return backdrop;
    backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop hidden';
    backdrop.innerHTML = '<div class="modal bots-modal" role="dialog" aria-modal="true" aria-label="Bots"></div>';
    box = backdrop.firstElementChild;
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(); });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || backdrop.classList.contains('hidden')) return;
      if (screen.view === 'edit') { screen = { view: 'gallery' }; render(); } else closeModal();
    });
    document.body.appendChild(backdrop);
    return backdrop;
  }
  function closeModal() { if (backdrop) backdrop.classList.add('hidden'); }

  async function openModal(view) {
    modal().classList.remove('hidden');
    screen = view || { view: 'gallery' };
    render();
    await load();
    render();
  }

  function render() {
    if (!box) return;
    if (screen.view === 'edit') renderEditor();
    else renderGallery();
  }

  function head(title, sub, back) {
    return `<div class="bots-head">
      ${back ? '<button class="icon-btn icon-btn-sm bots-back" data-act="back" aria-label="Back"><svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg></button>' : ''}
      <div class="bots-head-text"><div class="bots-title">${esc(title)}</div>${sub ? `<div class="bots-sub">${esc(sub)}</div>` : ''}</div>
      <button class="icon-btn icon-btn-sm modal-close" data-act="close" title="Close" aria-label="Close">${ICON_X}</button></div>`;
  }

  function renderGallery() {
    const used = new Set(cat.bots.map((b) => b.template).filter(Boolean));
    const cards = cat.bots.map((b) => `<button class="bot-card" data-id="${esc(b.id)}">
        <div class="bot-card-av">${av(b.avatar, 76)}</div>
        <div class="bot-card-name">${esc(b.name)}${b.id === selected ? '<span class="bot-tag">In chat</span>' : ''}</div>
        <div class="bot-card-role">${esc(ROLE[b.role])}</div>
        <div class="bot-card-spec">${esc(b.specialty || 'No specialty yet')}</div>
        <div class="bot-card-mem">${b.memory.length ? `Remembers ${b.memory.length} thing${b.memory.length === 1 ? '' : 's'}` : 'Nothing learned yet'}</div>
      </button>`).join('');
    const templates = cat.templates.map((t) => `<button class="bot-tpl" data-tpl="${esc(t.key)}" title="${esc(t.specialty)}">
        ${av(t.avatar, 44, { still: true })}<span class="bot-tpl-text"><b>${esc(t.key[0].toUpperCase() + t.key.slice(1))}</b><span>${esc(t.name)}${used.has(t.key) ? ' · added' : ''}</span></span></button>`).join('');
    box.innerHTML = `${head('Bots', 'Little agents with one job, their own tone and a memory that grows. They can ask each other for help, one at a time.')}
      <div class="bots-body">
        <div class="bots-describe">
          <textarea class="bots-describe-input" rows="2" placeholder="Describe your bot: &quot;a patient reviewer who checks my pull requests for security issues and explains fixes simply&quot;">${esc(screen.describeText || '')}</textarea>
          <div class="bots-describe-row">
            <span class="bots-error">${screen.error ? esc(screen.error) : ''}</span>
            <button class="btn btn-secondary bots-btn" data-act="blank">Start blank</button>
            <button class="btn btn-primary bots-btn" data-act="describe" ${screen.busy ? 'disabled' : ''}>${screen.busy ? 'Designing...' : 'Create with Craft'}</button>
          </div>
        </div>
        <div class="bots-sub-title">Start from a template</div>
        <div class="bots-tpls">${templates}</div>
        <div class="bots-sub-title">Your bots</div>
        ${cat.bots.length ? `<div class="bots-grid">${cards}</div>` : '<div class="bots-empty">No bots yet. Pick a template or describe one above.</div>'}
      </div>`;
    wireCommon();
    box.querySelectorAll('.bot-card').forEach((c) => c.addEventListener('click', () => editBot(byId(c.dataset.id))));
    box.querySelectorAll('.bot-tpl').forEach((c) => c.addEventListener('click', async () => {
      c.disabled = true;
      const r = await api.botsFromTemplate(c.dataset.tpl);
      if (r.error) { showToast(r.error, 'error'); c.disabled = false; return; }
      cat = r; paintChips(); render();
      showToast(`Added ${r.bot.name}.`);
    }));
    const input = box.querySelector('.bots-describe-input');
    input.addEventListener('input', () => { screen.describeText = input.value; });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) box.querySelector('[data-act="describe"]').click(); });
    on('describe', async () => {
      const text = input.value.trim();
      if (!text) { input.focus(); return; }
      screen = { view: 'gallery', busy: true, describeText: text };
      render();
      const r = await api.botsDescribe(text);
      if (r.error) { screen = { view: 'gallery', error: r.error, describeText: text }; render(); return; }
      editDraft(r.draft, 'Craft drafted this bot from your description. Change anything you like, then create it.');
    });
    on('blank', () => editDraft({ name: '', role: 'specialist', avatar: A.randomAvatar(Date.now()) }));
  }

  function on(act, fn) { box.querySelectorAll(`[data-act="${act}"]`).forEach((el) => el.addEventListener('click', fn)); }
  function wireCommon() {
    on('close', closeModal);
    on('back', () => { screen = { view: 'gallery' }; render(); });
  }

  // Always on: the bot watches Gmail in the background (bots-watch.js) and reaches you when something is important.
  const AO_DEFAULT = { on: false, watch: ['gmail'], reach: 'push', draft: true, quiet: { on: true, from: '22:00', to: '07:00' }, cloud: false };
  function alwaysOnHtml(d, c) {
    const ao = d.alwaysOn = { ...AO_DEFAULT, ...(d.alwaysOn || {}), quiet: { ...AO_DEFAULT.quiet, ...((d.alwaysOn && d.alwaysOn.quiet) || {}) } };
    const reach = cat.reach || { message: 'Message me in Craft', push: 'Notify my phone', call: 'Call me when it is very important' };
    return `<div class="${c.field}" data-ao-box><div class="${c.label}">Always on</div>
      <label class="${c.check}"><input type="checkbox" data-ao="on" ${ao.on ? 'checked' : ''}><span>Watch my Gmail inbox in the background</span></label>
      <div class="ao-more"${ao.on ? '' : ' hidden'}>
        <div class="${c.dim}">No AI is used until an email looks important. Then it writes a summary and a reply.</div>
        <div class="ao-row"><span>Reach me</span><select class="${c.input}" data-ao="reach">${Object.entries(reach).map(([k, v]) => `<option value="${k}" ${ao.reach === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></div>
        <label class="${c.check}"><input type="checkbox" data-ao="draft" ${ao.draft ? 'checked' : ''}><span>Draft a reply in Gmail (never sends)</span></label>
        <div class="ao-row"><label class="${c.check}"><input type="checkbox" data-ao="quiet" ${ao.quiet.on ? 'checked' : ''}><span>Quiet hours</span></label>
          <input type="time" class="${c.input} ao-time" data-ao="from" value="${esc(ao.quiet.from)}"><span>to</span><input type="time" class="${c.input} ao-time" data-ao="to" value="${esc(ao.quiet.to)}"></div>
        <label class="${c.check}"><input type="checkbox" data-ao="cloud" ${ao.cloud ? 'checked' : ''}><span>Keep watching when this PC is off (stores your Gmail sign-in on Codeply's server, encrypted)</span></label>
      </div></div>`;
  }
  function wireAlwaysOn(root, d) {
    const ao = d.alwaysOn;
    root.querySelectorAll('[data-ao]').forEach((el) => el.addEventListener('change', () => {
      const k = el.dataset.ao;
      if (k === 'on') { ao.on = el.checked; const more = root.querySelector('[data-ao-box] .ao-more'); if (more) more.hidden = !el.checked; }
      else if (k === 'reach') ao.reach = el.value;
      else if (k === 'draft' || k === 'cloud') ao[k] = el.checked;
      else if (k === 'quiet') ao.quiet.on = el.checked;
      else if ((k === 'from' || k === 'to') && /^\d\d:\d\d$/.test(el.value)) ao.quiet[k] = el.value;
    }));
  }

  // ─── Editor ──────────────────────────────────────────────────────────────
  function editBot(bot) {
    if (!bot) return;
    screen = { view: 'edit', id: bot.id, draft: JSON.parse(JSON.stringify(bot)) };
    render();
  }
  function editDraft(draft, note) {
    const d = {
      name: '', role: 'specialist', specialty: '', instructions: '', tone: { preset: 'friendly', custom: '' }, sources: '',
      approval: Object.keys(cat.approvals), memory: [], ...draft,
    };
    d.avatar = A.normalizeAvatar(d.avatar);
    screen = { view: 'edit', id: null, draft: d, note };
    render();
  }

  const PICKERS = [
    { key: 'shape', label: 'Shape', full: true, list: () => Object.entries(A.SHAPES), preview: (d, k) => ({ ...d.avatar, shape: k, glasses: 'none', accessory: 'none' }) },
    { key: 'eyes', label: 'Eyes', list: () => Object.entries(A.EYES), preview: (d, k) => ({ ...d.avatar, shape: 'squircle', eyes: k, glasses: 'none', accessory: 'none', mouth: 'none' }) },
    { key: 'glasses', label: 'Optics', list: () => Object.entries(A.GLASSES), preview: (d, k) => ({ ...d.avatar, shape: 'squircle', glasses: k, accessory: 'none' }) },
    { key: 'accessory', label: 'Extra', full: true, list: () => Object.entries(A.ACCESSORIES), preview: (d, k) => ({ ...d.avatar, shape: 'squircle', accessory: k, glasses: 'none' }) },
    { key: 'mouth', label: 'Mouth', list: () => Object.entries(A.MOUTHS), preview: (d, k) => ({ ...d.avatar, shape: 'squircle', mouth: k, glasses: 'none', accessory: 'none' }) },
  ];

  function pickerHtml(p, d) {
    return `<div class="bot-pick"><div class="bot-pick-label">${p.label}</div><div class="bot-pick-row" data-pick="${p.key}">` +
      p.list().map(([k, v]) => `<button class="bot-pick-tile${d.avatar[p.key] === k ? ' on' : ''}" data-val="${esc(k)}" title="${esc(v.label)}" aria-label="${esc(v.label)}">${av(p.preview(d, k), 44, { still: true, flat: true, zoom: p.full ? '' : 'face' })}</button>`).join('') +
      '</div></div>';
  }

  function colorsHtml(d) {
    const custom = !A.COLORS[d.avatar.color];
    return `<div class="bot-pick"><div class="bot-pick-label">Color</div><div class="bot-colors">` +
      Object.entries(A.COLORS).map(([k, hex]) => `<button class="bot-swatch${d.avatar.color === k ? ' on' : ''}" data-color="${k}" style="--sw:${hex}" title="${k}" aria-label="${k}"></button>`).join('') +
      `<label class="bot-swatch custom${custom ? ' on' : ''}" title="Custom color" style="--sw:${A.colorHex(d.avatar.color)}"><input type="color" value="${A.colorHex(d.avatar.color)}" aria-label="Custom color"></label>` +
      `<label class="bot-check-inline"><input type="checkbox" data-cheeks ${d.avatar.cheeks ? 'checked' : ''}> Blush</label></div></div>`;
  }

  function memoryHtml(d) {
    if (!screen.id) return '';
    const items = (d.memory || []).map((m, i) => `<li><span>${esc(m.fact)}</span><button class="bot-mem-del" data-forget="${i}" title="Forget this" aria-label="Forget this">${ICON_X}</button></li>`).reverse().join('');
    return `<div class="bot-field"><div class="bot-field-label">Memory <span class="bots-dim">${(d.memory || []).length} of ${cat.maxMemory}, learned from your chats</span>
        ${(d.memory || []).length ? '<button class="bots-link" data-act="clear-mem">Clear all</button>' : ''}</div>
      ${items ? `<ul class="bot-mem">${items}</ul>` : '<div class="bots-dim">Nothing yet. It picks up your preferences and decisions as you chat.</div>'}</div>`;
  }

  // Experience: what the bot learned from its own work (lessons, playbooks, tool tips, open threads).
  function experienceHtml(d) {
    if (!screen.id) return '';
    const lessons = d.lessons || []; const playbooks = d.playbooks || []; const tips = d.toolTips || []; const threads = d.openThreads || [];
    const total = lessons.length + playbooks.length + tips.length + threads.length;
    const del = (kind, i) => `<button class="bot-mem-del" data-xforget="${kind}:${i}" title="Forget this" aria-label="Forget this">${ICON_X}</button>`;
    const group = (title, kind, list, row) => (list.length
      ? `<div class="bot-xp-sub">${title}</div><ul class="bot-mem">${list.map((x, i) => `<li>${row(x)}${del(kind, i)}</li>`).reverse().join('')}</ul>` : '');
    const pb = (p) => `<details class="bot-xp-pb"><summary>${esc(p.app)} / ${esc(p.task)}${p.uses > 1 ? ` <span class="bots-dim">used ${p.uses} times</span>` : ''}</summary>
      ${p.when ? `<div class="bots-dim">${esc(p.when)}</div>` : ''}<ol>${(p.steps || []).map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
      ${(p.precautions || []).length ? `<div class="bots-dim">Watch out: ${p.precautions.map(esc).join(' · ')}</div>` : ''}${p.params ? `<div class="bots-dim">What worked: ${esc(p.params)}</div>` : ''}</details>`;
    const counts = [[lessons.length, 'lesson'], [playbooks.length, 'playbook'], [tips.length, 'tool tip']].filter(([n]) => n).map(([n, w]) => `${n} ${w}${n === 1 ? '' : 's'}`).join(', ');
    return `<div class="bot-field bot-xp" data-experience><div class="bot-field-label">Experience <span class="bots-dim">${total ? `${counts || 'open threads'}, learned from its own work` : 'learned from its own work'}</span>
        ${total ? '<button class="bots-link" data-act="clear-xp">Clear all</button>' : ''}</div>
      ${total ? [
    group('Lessons', 'lessons', lessons, (l) => `<span>When ${esc(l.situation)}: ${esc(l.strategy)}</span>`),
    group('Playbooks', 'playbooks', playbooks, (p) => `<span>${pb(p)}</span>`),
    group('Tool tips', 'toolTips', tips, (t) => `<span>${esc(t.tip)}</span>`),
    group('Open threads', 'openThreads', threads, (t) => `<span>${esc(t.text)}</span>`),
  ].join('') : '<div class="bots-dim">Nothing yet. After it works with its tools, it keeps what worked: lessons, step by step playbooks and tool tips.</div>'}</div>`;
  }

  function renderEditor() {
    const d = screen.draft;
    const isNew = !screen.id;
    const tones = Object.entries(cat.tones).map(([k, t]) => `<button class="bot-tone${d.tone.preset === k ? ' on' : ''}" data-tone="${k}" title="${esc(t.text)}">${esc(t.label)}</button>`).join('');
    const approvals = Object.entries(cat.approvals).map(([k, label]) => `<label class="bot-approval"><input type="checkbox" data-approval="${k}" ${d.approval.includes(k) ? 'checked' : ''}><span>${esc(label)}</span></label>`).join('');
    box.innerHTML = `${head(isNew ? 'New bot' : d.name || 'Bot', isNew ? '' : `${ROLE[d.role]}${d.id === selected ? ' · answering in chat' : ''}`, true)}
      <div class="bots-body bots-editor">
        <div class="bots-ed-left">
          <div class="bots-stage">${av(d.avatar, 168)}</div>
          <div class="bots-stage-actions">
            <button class="btn btn-secondary bots-btn" data-act="surprise">Surprise me</button>
            <button class="btn btn-secondary bots-btn" data-act="preview-work">Try working</button>
          </div>
          ${PICKERS.map((p) => pickerHtml(p, d)).join('')}
          ${colorsHtml(d)}
        </div>
        <div class="bots-ed-right">
          ${screen.note ? `<div class="bots-note">${esc(screen.note)}</div>` : ''}
          <div class="bot-field"><label class="bot-field-label" for="botName">Name</label><input id="botName" class="bots-input" data-f="name" maxlength="40" value="${esc(d.name)}" placeholder="Stella"></div>
          <div class="bot-field"><div class="bot-field-label">Role</div>
            <div class="bots-seg"><button class="${d.role === 'specialist' ? 'on' : ''}" data-role="specialist">Specialist</button><button class="${d.role === 'orchestrator' ? 'on' : ''}" data-role="orchestrator">Orchestrator</button></div>
            <div class="bots-dim">${d.role === 'orchestrator' ? 'Breaks a goal into steps and asks the right teammate for each, one at a time.' : 'One clear domain. Others can ask it for help.'}</div></div>
          <div class="bot-field"><label class="bot-field-label" for="botSpec">Specialty</label><input id="botSpec" class="bots-input" data-f="specialty" maxlength="200" value="${esc(d.specialty)}" placeholder="Research: finds facts and cites sources"></div>
          <div class="bot-field"><label class="bot-field-label" for="botInstr">How it works</label><textarea id="botInstr" class="bots-input" data-f="instructions" rows="4" placeholder="What it always does, what it never does.">${esc(d.instructions)}</textarea></div>
          <div class="bot-field"><div class="bot-field-label">Tone</div><div class="bot-tones">${tones}</div>
            <input class="bots-input" data-tone-custom maxlength="400" value="${esc(d.tone.custom || '')}" placeholder="Anything else about how it talks (optional)"></div>
          <div class="bot-field"><label class="bot-field-label" for="botSources">Sources and notes</label><textarea id="botSources" class="bots-input" data-f="sources" rows="2" placeholder="Where it should look first, links, house rules (optional)">${esc(d.sources)}</textarea></div>
          <div class="bot-field"><div class="bot-field-label">Must ask before</div><div class="bot-approvals">${approvals}</div>
            <div class="bots-dim">Unchecked actions run without asking (your permission rules still apply). Keep anything irreversible checked.</div></div>
          ${alwaysOnHtml(d, { field: 'bot-field', label: 'bot-field-label', check: 'bot-approval', input: 'bots-input', dim: 'bots-dim' })}
          ${memoryHtml(d)}
          ${experienceHtml(d)}
        </div>
      </div>
      <div class="bots-foot">
        ${isNew ? '' : `<button class="btn btn-secondary btn-danger-hover bots-btn" data-act="delete">${screen.confirmDelete ? 'Click again to delete' : 'Delete bot'}</button>`}
        <span class="bots-error">${screen.error ? esc(screen.error) : ''}</span>
        ${isNew ? '' : `<button class="btn btn-secondary bots-btn" data-act="use">${d.id === selected ? 'In chat' : 'Use in chat'}</button>`}
        <button class="btn btn-primary bots-btn" data-act="save">${isNew ? 'Create bot' : 'Save'}</button>
      </div>`;
    wireCommon();
    wireEditor();
  }

  function repaintStage() {
    const st = box.querySelector('.bots-stage');
    if (st) st.innerHTML = av(screen.draft.avatar, 168);
  }

  function wireEditor() {
    const d = screen.draft;
    box.querySelectorAll('[data-f]').forEach((el) => el.addEventListener('input', () => { d[el.dataset.f] = el.value; }));
    const custom = box.querySelector('[data-tone-custom]');
    custom.addEventListener('input', () => { d.tone.custom = custom.value; });
    box.querySelectorAll('[data-tone]').forEach((el) => el.addEventListener('click', () => {
      d.tone.preset = el.dataset.tone;
      box.querySelectorAll('[data-tone]').forEach((x) => x.classList.toggle('on', x === el));
    }));
    box.querySelectorAll('[data-role]').forEach((el) => el.addEventListener('click', () => { d.role = el.dataset.role; renderEditor(); }));
    box.querySelectorAll('[data-approval]').forEach((el) => el.addEventListener('change', () => {
      const k = el.dataset.approval;
      d.approval = el.checked ? [...new Set([...d.approval, k])] : d.approval.filter((x) => x !== k);
    }));
    wireAlwaysOn(box, d);
    box.querySelectorAll('.bot-pick-row').forEach((row) => row.addEventListener('click', (e) => {
      const tile = e.target.closest('.bot-pick-tile');
      if (!tile) return;
      d.avatar[row.dataset.pick] = tile.dataset.val;
      row.querySelectorAll('.bot-pick-tile').forEach((t) => t.classList.toggle('on', t === tile));
      repaintStage();
      if (row.dataset.pick !== 'shape') return;
    }));
    box.querySelectorAll('[data-color]').forEach((el) => el.addEventListener('click', () => { d.avatar.color = el.dataset.color; renderEditor(); }));
    const picker = box.querySelector('.bot-swatch.custom input');
    picker.addEventListener('input', () => { d.avatar.color = picker.value; repaintStage(); picker.parentElement.style.setProperty('--sw', picker.value); });
    picker.addEventListener('change', () => renderEditor());
    box.querySelector('[data-cheeks]').addEventListener('change', (e) => { d.avatar.cheeks = e.target.checked; repaintStage(); });
    on('surprise', () => { d.avatar = A.randomAvatar(Math.random()); renderEditor(); });
    on('preview-work', () => {
      const st = box.querySelector('.bots-stage');
      A.setAvatarState(st, 'working');
      clearTimeout(screen.previewTimer);
      screen.previewTimer = setTimeout(() => {
        A.setAvatarState(st, 'done');
        screen.previewTimer = setTimeout(() => A.setAvatarState(st, 'idle'), 2200);
      }, 2600);
    });
    box.querySelectorAll('[data-forget]').forEach((el) => el.addEventListener('click', async () => {
      const r = await api.botsForget(screen.id, Number(el.dataset.forget));
      if (r.error) { showToast(r.error, 'error'); return; }
      cat = r; d.memory = r.bot.memory; renderEditor();
    }));
    const setXp = (bot) => { for (const k of ['lessons', 'playbooks', 'toolTips', 'openThreads']) d[k] = bot[k] || []; };
    box.querySelectorAll('[data-xforget]').forEach((el) => el.addEventListener('click', async (e) => {
      e.preventDefault();
      const [kind, i] = el.dataset.xforget.split(':');
      const r = await api.botsForgetExperience(screen.id, kind, Number(i));
      if (r.error) { showToast(r.error, 'error'); return; }
      cat = r; setXp(r.bot); renderEditor();
    }));
    on('clear-xp', async () => {
      const r = await api.botsForgetExperience(screen.id, 'all', -1);
      if (r.error) { showToast(r.error, 'error'); return; }
      cat = r; setXp(r.bot); renderEditor();
      showToast(`${d.name} forgot what it learned from its work.`);
    });
    on('clear-mem', async () => {
      const r = await api.botsClearMemory(screen.id);
      if (r.error) { showToast(r.error, 'error'); return; }
      cat = r; d.memory = []; renderEditor();
      showToast(`${d.name} forgot everything it learned.`);
    });
    on('delete', async () => {
      if (!screen.confirmDelete) { screen.confirmDelete = true; renderEditor(); return; }
      const r = await api.botsRemove(screen.id);
      if (r.error) { showToast(r.error, 'error'); return; }
      cat = r;
      if (selected === screen.id) setSelected('');
      showToast(`Deleted ${d.name || 'the bot'}.`);
      screen = { view: 'gallery' }; render(); paintChips();
    });
    on('use', () => {
      setSelected(screen.id);
      renderEditor();
      showToast(`${d.name} answers your next messages.`);
    });
    on('save', async () => {
      if (!String(d.name || '').trim()) { screen.error = 'Give it a name.'; renderEditor(); box.querySelector('#botName').focus(); return; }
      const patch = { name: d.name, role: d.role, specialty: d.specialty, instructions: d.instructions, tone: d.tone, sources: d.sources, approval: d.approval, avatar: d.avatar, alwaysOn: d.alwaysOn };
      const r = screen.id ? await api.botsUpdate(screen.id, patch) : await api.botsCreate(patch);
      if (r.error) { screen.error = r.error; renderEditor(); return; }
      cat = r;
      paintChips();
      showToast(screen.id ? `Saved ${r.bot.name}.` : `Created ${r.bot.name}.`);
      editBot(r.bot);
    });
  }

  // ─── In the chat ─────────────────────────────────────────────────────────
  /** The "Orion" badge at the top of a bot's reply. Merges into a role badge right before it. */
  let liveBadge = null;
  function renderBadge(bot, instant) {
    if (!bot || typeof chatColumn === 'undefined') return;
    const cur = byId(bot.id) || bot;
    const last = chatColumn.lastElementChild;
    const html = `<span class="bot-badge-av">${av(cur.avatar, 26, { state: instant ? 'idle' : 'working' })}</span>`;
    let el;
    if (last && last.classList.contains('role-badge') && !last.querySelector('.bot-badge-av')) {
      el = last;
      el.classList.add('with-bot');
      const mascot = el.querySelector('img, .mascot-xs');
      if (mascot) mascot.remove();
      el.insertAdjacentHTML('afterbegin', html);
      const text = el.querySelector('.role-badge-text');
      if (text) text.innerHTML = `<strong>${esc(cur.name)}</strong> ${text.innerHTML.replace(/^Working as/, '· working as')}`;
    } else {
      el = document.createElement('div');
      el.className = 'role-badge bot-badge with-bot';
      el.innerHTML = `${html}<span class="role-badge-text"><strong>${esc(cur.name)}</strong> · ${esc(ROLE[cur.role] || 'Bot')}</span>`;
      chatColumn.appendChild(el);
    }
    if (!instant) liveBadge = el;
    if (nearBottom()) scrollToBottom();
  }

  function findBotFor(args, delegation) {
    if (delegation && delegation.bot) return byId(delegation.bot.id) || delegation.bot;
    return byName(args && args.bot) || { name: (args && args.bot) || 'a bot', avatar: CRAFT_AVATAR };
  }

  /** Called by app.js addToolRow for ask_bot: running placeholder and the finished row. */
  function delegationRow({ ok, running, args, delegation }) {
    const bot = findBotFor(args, delegation);
    const task = (delegation && delegation.task) || (args && args.task) || '';
    const row = document.createElement('div');
    row.className = `bot-deleg${running ? ' running' : ''}${ok === false ? ' failed' : ''}`;
    const firstLine = String(task).split('\n')[0].slice(0, 140);
    const verb = running ? `Asking <b>${esc(bot.name)}</b>` : `Asked <b>${esc(bot.name)}</b>`;
    const d = delegation || {};
    const steps = (d.steps || []).map((s) => `<li class="${s.ok ? '' : 'fail'}"><code>${esc(s.name)}</code> ${esc(s.label || '')}</li>`).join('');
    const result = running ? '' : d.ok === false || ok === false
      ? `<div class="bot-deleg-error">${esc(d.error || 'It could not finish.')}</div>`
      : `${d.summary ? `<div class="bot-deleg-summary">${esc(d.summary)}</div>` : ''}${d.details ? `<div class="bot-deleg-details md">${mdToHtml(d.details)}</div>` : ''}`;
    row.innerHTML = `<div class="bot-deleg-head">
        <span class="bot-deleg-av">${av(bot.avatar, 24, { state: running ? 'working' : ok === false ? 'idle' : 'done' })}</span>
        <span class="bot-deleg-verb">${verb}</span><span class="bot-deleg-task">${esc(firstLine)}</span>
        ${running ? '<span class="spinner"></span>' : '<svg class="tool-chevron" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>'}</div>
      <div class="bot-deleg-body${running ? '' : ' hidden'}">
        ${task && task.length > firstLine.length ? `<div class="bot-deleg-fulltask">${esc(task)}</div>` : ''}
        <ul class="bot-deleg-steps">${steps}</ul>${result}</div>`;
    if (!running) {
      row.querySelector('.bot-deleg-head').addEventListener('click', () => {
        row.querySelector('.bot-deleg-body').classList.toggle('hidden');
        row.classList.toggle('expanded');
      });
      // The finished result is the interesting bit: show the summary line without a click.
      if (d.summary) row.querySelector('.bot-deleg-head').insertAdjacentHTML('afterend', `<div class="bot-deleg-peek">${esc(d.summary)}</div>`);
      setTimeout(() => { const s = row.querySelector('svg.ba'); if (s) A.setAvatarState(s, 'idle'); }, 2500);
    }
    if (typeof enqueueReveal === 'function' && !running) {
      row.classList.add('reveal-pending');
      chatColumn.appendChild(row);
      enqueueReveal((next) => { row.classList.remove('reveal-pending'); if (nearBottom()) scrollToBottom(); next(); });
    } else {
      chatColumn.appendChild(row);
      if (nearBottom()) scrollToBottom();
    }
    return row;
  }

  function addStep(data) {
    const rows = chatColumn.querySelectorAll('.bot-deleg.running');
    const row = rows[rows.length - 1];
    if (!row) return;
    const ul = row.querySelector('.bot-deleg-steps');
    ul.insertAdjacentHTML('beforeend', `<li class="${data.ok ? '' : 'fail'}"><code>${esc(data.name)}</code> ${esc(data.label || '')}</li>`);
    while (ul.children.length > 8) ul.firstElementChild.remove();
    if (nearBottom()) scrollToBottom();
  }

  /** tool_start carries no arguments, so the running row learns who is working from bot_working. */
  function markWorking(data) {
    const rows = chatColumn.querySelectorAll('.bot-deleg.running');
    const row = rows[rows.length - 1];
    if (!row || !data.bot) return;
    const bot = byId(data.bot.id) || data.bot;
    row.querySelector('.bot-deleg-av').innerHTML = av(bot.avatar, 24, { state: 'working' });
    row.querySelector('.bot-deleg-verb').innerHTML = `Asking <b>${esc(bot.name)}</b>`;
    row.querySelector('.bot-deleg-task').textContent = String(data.task || '').split('\n')[0].slice(0, 140);
  }

  api.onAgentEvent((data) => {
    if (!data || data.sessionId !== state.currentSessionId) return;
    if (data.type === 'bot_active') renderBadge(data.bot, false);
    else if (data.type === 'bot_working' && data.working) markWorking(data);
    else if (data.type === 'bot_step') addStep(data);
    else if (data.type === 'bot_learned' && data.facts && data.facts.length) {
      const note = document.createElement('div');
      note.className = 'bot-learned';
      const b = byId(data.bot.id) || data.bot;
      note.innerHTML = `${av(b.avatar, 18, { still: true })}<span><b>${esc(b.name)}</b> will remember: ${data.facts.map(esc).join(' · ')}</span>`;
      chatColumn.appendChild(note);
      if (nearBottom()) scrollToBottom();
      load();
    } else if (data.type === 'run_finished' && liveBadge) {
      const svg = liveBadge.querySelector('svg.ba');
      if (svg) {
        A.setAvatarState(svg, 'done');
        setTimeout(() => A.setAvatarState(svg, 'idle'), 2600);
      }
      liveBadge = null;
    }
  });

  window.CraftBots = { selectedId: () => selected, delegationRow, renderBadge, open: openModal, refresh: load, setSelected };

  addChips();
  load();
  // Composers get rebuilt in places; keep the chip there cheaply.
  setInterval(addChips, 1500);
  window.addEventListener('focus', load);
})();
