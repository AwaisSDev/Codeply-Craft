// Codeply Crew window: the sidebar of bots, a home screen, one thread per bot,
// the bot editor and sign-in. Calls live in call.js (window.CrewCall).
(() => {
  const api = window.crew;
  const A = window.CraftAvatar;
  const { md, esc } = window.CrewMarkdown;
  const $ = (sel, root = document) => root.querySelector(sel);

  const state = {
    user: null, models: { selected: 'auto', models: [] }, catalog: { bots: [], templates: [], tones: {}, approvals: {} },
    threads: {}, settings: {}, workspace: '', current: null, messages: [], busy: new Set(), live: null, groups: [], currentGroup: null,
  };
  window.CrewState = state;

  const ICON = {
    phone: '<svg viewBox="0 0 24 24"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/></svg>',
    up: '<svg viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
    stop: '<svg viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>',
    more: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/></svg>',
    chev: '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
    x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    ok: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    bad: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 8v5M12 16h.01"/></svg>',
    edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
    group: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><circle cx="17" cy="9" r="2.6"/><path d="M16 14.2a4.6 4.6 0 0 1 5 4.8"/></svg>',
    plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
    folder: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  };

  const VERB = {
    read_file: 'Read', write_file: 'Wrote', edit_file: 'Edited', apply_patch: 'Patched', run: 'Ran', search: 'Searched',
    list_dir: 'Looked in', web_search: 'Searched the web for', web_fetch: 'Read', gmail_search: 'Searched Gmail', gmail_send: 'Emailed',
    slack_post_message: 'Posted to Slack', browser_check: 'Checked', fetch_image: 'Downloaded', todo: 'Updated the plan',
    use_skill: 'Used skill', view_images: 'Looked at', ask_user: 'Asked you', mcp: 'Used', vercel_deploy: 'Deployed',
  };

  const bot = (id) => state.catalog.bots.find((b) => b.id === id) || null;
  // Always on: the bot watches Gmail in the background (bots-watch.js) and reaches you when something is important.
  const AO_DEFAULT = { on: false, watch: ['gmail'], reach: 'push', draft: true, quiet: { on: true, from: '22:00', to: '07:00' }, cloud: false };
  function alwaysOnHtml(d, c) {
    const ao = d.alwaysOn = { ...AO_DEFAULT, ...(d.alwaysOn || {}), quiet: { ...AO_DEFAULT.quiet, ...((d.alwaysOn && d.alwaysOn.quiet) || {}) } };
    const reach = state.catalog.reach || { message: 'Message me in Craft', push: 'Notify my phone', call: 'Call me when it is very important' };
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

  // An important email an always-on bot found (crew-main.js addMail).
  function mailCardHtml(m) {
    return `<div class="mailcard${m.level === 'very' ? ' very' : ''}"><div class="mailcard-head"><b>${esc(m.text)}</b>${m.cloud ? '<span class="dim">while your PC was off</span>' : ''}</div>
      ${m.summary ? `<div class="mailcard-sum">${esc(m.summary)}</div>` : ''}
      ${m.reply ? `<details class="mailcard-reply"><summary>The draft</summary><div>${esc(m.reply)}</div></details>` : ''}
      ${m.error ? `<div class="note err">Could not draft a reply: ${esc(m.error)}</div>` : ''}
      <div class="mailcard-actions">${m.gmailUrl ? `<button class="btn" data-open-url="${esc(m.gmailUrl)}">Open email</button>` : ''}${m.drafted && m.draftUrl ? `<button class="btn primary" data-open-url="${esc(m.draftUrl)}">Open draft</button>` : ''}</div></div>`;
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('[data-open-url]');
    if (b) api.openExternal(b.dataset.openUrl);
  });
  const av = (b, size, opts) => A.renderAvatar(b ? b.avatar : { shape: 'burst9', eyes: 'pills', color: '#8e8e93' }, size, opts);

  // ─── Small helpers ──────────────────────────────────────────────────────
  function toast(text, kind) {
    const t = document.createElement('div');
    t.className = `toast${kind === 'error' ? ' err' : ''}`;
    t.textContent = text;
    $('#toasts').appendChild(t);
    setTimeout(() => { t.style.transition = 'opacity .3s'; t.style.opacity = '0'; setTimeout(() => t.remove(), 320); }, kind === 'error' ? 5200 : 2600);
  }
  window.crewToast = toast;

  let menuClose = null;
  function openMenu(anchor, items, align = 'left') {
    closeMenu();
    const m = $('#menu');
    m.innerHTML = items.map((it, i) => {
      if (it === '-') return '<hr>';
      if (it.note) return `<div class="menu-note">${esc(it.note)}</div>`;
      return `<button data-i="${i}" class="${it.on ? 'on' : ''} ${it.danger ? 'danger' : ''}">${it.icon || ''}<span>${esc(it.label)}</span></button>`;
    }).join('');
    m.classList.remove('hidden');
    const r = anchor.getBoundingClientRect();
    const below = r.bottom + 6 + m.offsetHeight < window.innerHeight;
    m.style.top = `${below ? r.bottom + 6 : r.top - m.offsetHeight - 6}px`;
    m.style.left = `${Math.max(8, Math.min(window.innerWidth - m.offsetWidth - 8, align === 'right' ? r.right - m.offsetWidth : r.left))}px`;
    m.querySelectorAll('button[data-i]').forEach((b) => b.addEventListener('click', () => { const it = items[Number(b.dataset.i)]; closeMenu(); it.run(); }));
    const onDoc = (e) => { if (!m.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) closeMenu(); };
    const onKey = (e) => { if (e.key === 'Escape') closeMenu(); };
    setTimeout(() => { document.addEventListener('mousedown', onDoc); document.addEventListener('keydown', onKey); });
    menuClose = () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }
  function closeMenu() { $('#menu').classList.add('hidden'); if (menuClose) { menuClose(); menuClose = null; } }

  function modal(html, small) {
    const m = $('#modal');
    m.className = `modal${small ? ' small' : ''}`;
    m.innerHTML = html;
    $('#modalBack').classList.remove('hidden');
    return m;
  }
  function closeModal() { $('#modalBack').classList.add('hidden'); $('#modal').innerHTML = ''; }
  $('#modalBack').addEventListener('mousedown', (e) => { if (e.target.id === 'modalBack') closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modalBack').classList.contains('hidden')) closeModal(); });

  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-ext]');
    if (a) { e.preventDefault(); api.openExternal(a.getAttribute('href')); }
  });

  // ─── Titlebar ───────────────────────────────────────────────────────────
  document.querySelectorAll('[data-win]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.win === 'min') api.minimize(); else if (b.dataset.win === 'max') api.maximize(); else api.close();
  }));

  // ─── Sidebar ────────────────────────────────────────────────────────────
  function renderSide() {
    const list = $('#botList');
    const bots = [...state.catalog.bots].sort((a, b) => ((state.threads[b.id] || {}).updatedAt || b.createdAt) - ((state.threads[a.id] || {}).updatedAt || a.createdAt));
    list.innerHTML = bots.length ? bots.map((b) => {
      const t = state.threads[b.id];
      return `<button class="bot-item${state.current === b.id ? ' on' : ''}" data-id="${esc(b.id)}">
        <span class="av${state.busy.has(b.id) ? ' busy' : ''}">${av(b, 32, { still: true })}</span>
        <span class="bot-item-text"><div class="bot-item-name">${esc(b.name)}</div><div class="bot-item-sub">${esc((t && t.last) || b.specialty || 'Say hi')}</div></span>
      </button>`;
    }).join('') : '<div class="side-empty">No bots yet.</div>';
    list.querySelectorAll('.bot-item').forEach((el) => el.addEventListener('click', () => openBot(el.dataset.id)));
    if (window.CrewGroups) window.CrewGroups.renderSide();
    renderAccount();
  }

  function renderAccount() {
    const btn = $('#accountBtn');
    const u = state.user;
    btn.innerHTML = u
      ? `<span class="account-av">${esc(u.email[0].toUpperCase())}</span><span class="account-text"><b>${esc(u.email)}</b><span>${esc(modelName())}</span></span>`
      : `<span class="account-av">?</span><span class="account-text"><b>Sign in</b><span>Same account as Craft</span></span>`;
    // Signed out still gets the menu: people on their own models need Voices too.
    btn.onclick = () => openMenu(btn, [
      { note: u ? u.email : `Not signed in, using ${modelName()}` },
      { label: 'Open the bots\' folder', icon: ICON.folder, run: () => api.openFolder(state.workspace) },
      '-',
      u ? { label: 'Sign out', danger: true, run: async () => { await api.signOut(); state.user = null; renderAccount(); toast('Signed out.'); } }
        : { label: 'Sign in', run: signIn },
    ]);
  }

  // ─── Voices ─────────────────────────────────────────────────────────────
  const ENGINES = {
    deepgram: { label: 'Deepgram', note: 'The most natural voices. Included with your Codeply account (a daily allowance), or unlimited with your own Deepgram key.' },
    edge: { label: 'Edge', note: 'Natural and free. Needs internet.' },
    kokoro: { label: 'Kokoro', note: 'Offline, on this PC. The first call downloads it (about 90 MB).' },
  };
  const engineLabel = (k) => (ENGINES[k] || ENGINES.edge).label;
  /** Deepgram voices work signed in (through Codeply) or with the user's own key. */
  const deepgramOk = () => !!(state.user || state.settings.hasDeepgramKey);

  function voiceSettings(back) {
    const ui = { key: '', error: '', busy: false };
    const paint = () => {
      const st = state.settings;
      const cur = ENGINES[st.voiceEngine] ? st.voiceEngine : 'edge';
      const m = modal(`
        <div class="modal-head"><div class="modal-title">Voices</div><button class="icon-btn" data-act="close" aria-label="Close">${ICON.x}</button></div>
        <div class="modal-body">
          <div class="field"><div class="field-label">Default voice engine <span class="dim">for bots without their own voice</span></div>
            <div class="seg">${Object.entries(ENGINES).map(([k, e]) => `<button class="${cur === k ? 'on' : ''}" data-engine="${k}" ${k === 'deepgram' && !deepgramOk() ? 'disabled title="Sign in or add a Deepgram key first"' : ''}>${e.label}</button>`).join('')}</div>
            <div class="dim" style="margin-top:6px">${esc(ENGINES[cur].note)}</div></div>
          <div class="field"><div class="field-label">Your own Deepgram key <span class="dim">optional</span> ${st.hasDeepgramKey ? '<span class="ok-text">Saved</span>' : ''}</div>
            ${st.hasDeepgramKey
              ? '<div class="key-row"><span class="dim">Stored encrypted on this PC. Bots can use any Deepgram voice.</span><button class="btn danger" data-act="remove-key">Remove</button></div>'
              : `<div class="key-row"><input class="input" id="dgKey" type="password" autocomplete="off" spellcheck="false" placeholder="Paste your Deepgram key" value="${esc(ui.key)}"><button class="btn primary" data-act="save-key" ${ui.busy ? 'disabled' : ''}>${ui.busy ? 'Checking...' : 'Save'}</button></div>
                 <div class="dim" style="margin-top:6px">Get one at console.deepgram.com. It is checked once, then stored encrypted on this PC and never leaves it except to talk to Deepgram.</div>`}
            <span class="err-text">${esc(ui.error)}</span></div>
        </div>
        <div class="modal-foot"><span class="grow"></span><button class="btn primary" data-act="close">Done</button></div>`, true);
      m.querySelectorAll('[data-act="close"]').forEach((b) => b.addEventListener('click', () => (back ? back() : closeModal())));
      m.querySelectorAll('[data-engine]').forEach((b) => b.addEventListener('click', async () => {
        const r = await api.setSettings({ voiceEngine: b.dataset.engine });
        if (!r.error) { state.settings = r; renderAccount(); paint(); }
      }));
      const save = m.querySelector('[data-act="save-key"]');
      if (save) {
        const input = m.querySelector('#dgKey');
        input.addEventListener('input', () => { ui.key = input.value; });
        const go = async () => {
          if (!ui.key.trim()) { ui.error = 'Paste the key first.'; paint(); return; }
          ui.busy = true; ui.error = ''; paint();
          const r = await api.setDeepgramKey(ui.key);
          ui.busy = false;
          if (r.error) { ui.error = r.error; paint(); return; }
          ui.key = ''; state.settings = r; voices = null; renderAccount(); paint();
          toast('Deepgram is set up. Pick a voice for each bot in its settings.');
        };
        save.addEventListener('click', go);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
        input.focus();
      }
      const rm = m.querySelector('[data-act="remove-key"]');
      if (rm) rm.addEventListener('click', async () => {
        const r = await api.setDeepgramKey('');
        if (!r.error) { state.settings = r; renderAccount(); paint(); toast('Removed the Deepgram key.'); }
      });
    };
    paint();
  }

  /** The editor's voice options: every engine, grouped, Deepgram first when it is set up. */
  function voiceOptions(selected) {
    const v = voices || {};
    const groups = [
      ['Deepgram Aura-2', v.deepgram || [], deepgramOk()],
      ['Edge, free', v.edge || [], true],
      ['Kokoro, offline', v.kokoro || [], true],
    ];
    if (!deepgramOk()) groups.push(groups.shift());
    return `<option value="">Pick for me (${esc(engineLabel(state.settings.voiceEngine))})</option>` + groups.map(([label, list, ok]) =>
      `<optgroup label="${esc(label)}${ok ? '' : ' (sign in to use these)'}">${list.map((x) => `<option value="${esc(x.id)}" ${selected === x.id ? 'selected' : ''} ${ok ? '' : 'disabled'}>${esc(x.label)}</option>`).join('')}</optgroup>`).join('');
  }

  let previewAudio = null;
  async function previewVoice(voiceId, d, ui, btn) {
    if (previewAudio) { previewAudio.pause(); previewAudio = null; }
    btn.disabled = true; btn.textContent = 'Loading...';
    const r = await api.voicePreview(voiceId, ui.id || '', d.name);
    btn.disabled = false; btn.textContent = 'Preview';
    if (r.error) { toast(r.error, 'error'); return; }
    const url = URL.createObjectURL(new Blob([r.data instanceof Uint8Array ? r.data : new Uint8Array(r.data)], { type: r.mime }));
    previewAudio = new Audio(url);
    previewAudio.onended = () => URL.revokeObjectURL(url);
    previewAudio.play().catch(() => {});
  }

  function modelName() {
    if (state.models.selected === 'auto' || !state.models.selected) return 'Auto';
    const m = state.models.models.find((x) => x.id === state.models.selected);
    return m ? m.name : 'Auto';
  }

  $('[data-act="home"]').addEventListener('click', () => goHome());
  $('[data-act="new-bot"]').addEventListener('click', () => newBot());

  // ─── Home ───────────────────────────────────────────────────────────────
  function greeting() {
    const h = new Date().getHours();
    return h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  }

  function goHome() {
    state.current = null;
    state.currentGroup = null;
    try { localStorage.removeItem('crew.last'); } catch {}
    renderSide();
    const bots = state.catalog.bots;
    const used = new Set(bots.map((b) => b.template).filter(Boolean));
    const view = $('#view');
    view.innerHTML = `<div class="home">
      <h1 class="home-title">${greeting()}.</h1>
      <p class="home-sub">${bots.length ? 'Who do you need today?' : 'Build your crew. Each bot has one job, its own voice, and a memory that grows.'}</p>
      ${bots.length ? `<div class="crew-row">${bots.map((b) => `<button class="crew-card" data-id="${esc(b.id)}">${av(b, 64)}<b>${esc(b.name)}</b><span>${esc(b.specialty || '')}</span></button>`).join('')}</div>` : ''}
      ${bots.length >= 2 ? `<button class="btn group-cta" id="groupCta">${ICON.group}Start a group chat</button>` : ''}
      <div class="describe">
        <div class="describe-label">Describe a new bot</div>
        <div class="composer"><textarea rows="1" id="describeInput" placeholder="A patient tutor who explains math with simple examples"></textarea>
          <div class="composer-row"><span class="grow"></span><button class="send" id="describeGo" aria-label="Create bot">${ICON.up}</button></div></div>
        <div class="tpl-row">${state.catalog.templates.map((t) => `<button class="tpl" data-tpl="${esc(t.key)}" ${used.has(t.key) ? 'disabled' : ''} title="${esc(t.specialty)}">${A.renderAvatar(t.avatar, 26, { still: true })}${esc(t.name)} <span class="dim">${esc(t.key)}</span></button>`).join('')}</div>
      </div>
    </div>`;
    view.querySelectorAll('.crew-card').forEach((c) => c.addEventListener('click', () => openBot(c.dataset.id)));
    if ($('#groupCta')) $('#groupCta').addEventListener('click', () => window.CrewGroups.create());
    view.querySelectorAll('.tpl').forEach((c) => c.addEventListener('click', async () => {
      c.disabled = true;
      const r = await api.botsFromTemplate(c.dataset.tpl);
      if (r.error) { toast(r.error, 'error'); c.disabled = false; return; }
      state.catalog = r;
      toast(`${r.bot.name} joined your crew.`);
      openBot(r.bot.id);
    }));
    const input = $('#describeInput');
    autosize(input);
    const go = async () => {
      const text = input.value.trim();
      if (!text) { input.focus(); return; }
      const btn = $('#describeGo');
      btn.disabled = true; input.disabled = true;
      $('.describe-label').textContent = 'Designing your bot...';
      const r = await api.botsDescribe(text);
      btn.disabled = false; input.disabled = false;
      $('.describe-label').textContent = 'Describe a new bot';
      if (r.error) { toast(r.error, 'error'); return; }
      editBot(null, r.draft, 'Drafted from your description. Change anything, then create it.');
    };
    $('#describeGo').addEventListener('click', go);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); } });
  }

  // ─── Thread ─────────────────────────────────────────────────────────────
  async function openBot(id) {
    const b = bot(id);
    if (!b) { goHome(); return; }
    state.current = id;
    state.currentGroup = null;
    try { localStorage.setItem('crew.last', id); } catch {}
    const r = await api.thread(id);
    if (state.current !== id) return;
    state.messages = Array.isArray(r) ? r : [];
    renderSide();
    renderThread();
  }

  function suggestions(b) {
    const s = (b.specialty || '').toLowerCase();
    if (/research|fact|docs/.test(s)) return ['What changed in AI this week?', 'Compare two tools for me', 'Find the docs for something'];
    if (/outreach|email|post|message/.test(s)) return ['Draft a follow-up email', 'Write a LinkedIn post', 'Reply to this message'];
    if (/analy|data|number/.test(s)) return ['Explain this number', 'Find patterns in my data', 'Is this a good idea?'];
    if (/report|summar|status/.test(s)) return ['Summarize my week', 'Turn notes into a status update', 'Make this shorter'];
    if (/code|execut|ship/.test(s)) return ['Build a small web page', 'Write a script for me', 'Fix an error'];
    return ['What can you do?', 'Help me plan my day', 'Let\'s brainstorm'];
  }

  function renderThread() {
    const b = bot(state.current);
    if (!b) return goHome();
    const busy = state.busy.has(b.id);
    const empty = !state.messages.length && !busy;
    const view = $('#view');
    view.innerHTML = `
      <div class="thread-head">
        <button class="th-who" id="whoBtn">${av(b, 34)}<span style="min-width:0;text-align:left"><div class="th-name">${esc(b.name)}</div><div class="th-sub">${esc(b.specialty || '')}</div></span></button>
        <span class="th-spacer"></span>
        <button class="call-btn" id="callBtn">${ICON.phone}Call</button>
        <button class="icon-btn" id="moreBtn" aria-label="More">${ICON.more}</button>
      </div>
      ${empty ? `<div class="empty">
          ${av(b, 112)}
          <div class="empty-name">${esc(b.name)}</div>
          <p class="empty-sub">${esc(b.specialty || 'Ask anything.')}</p>
          ${composerHtml(b)}
          <div class="chips">${suggestions(b).map((s) => `<button class="chip">${esc(s)}</button>`).join('')}</div>
        </div>`
        : `<div class="scroller" id="scroller"><div class="msgs" id="msgs"></div></div>${composerHtml(b)}`}`;
    $('#callBtn').addEventListener('click', () => window.CrewCall.start(b.id));
    $('#whoBtn').addEventListener('click', () => editBot(bot(state.current) || b));
    $('#moreBtn').addEventListener('click', (e) => openMenu(e.currentTarget, [
      { label: 'Edit bot', icon: ICON.edit, run: () => editBot(bot(state.current)) },
      { label: 'Open the bots\' folder', icon: ICON.folder, run: () => api.openFolder(state.workspace) },
      '-',
      { label: 'Clear this chat', icon: ICON.trash, danger: true, run: clearChat },
    ], 'right'));
    view.querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => { $('#input').value = c.textContent; send(); }));
    wireComposer();
    if (!empty) {
      const box = $('#msgs');
      box.innerHTML = '';
      renderStored(box, state.messages, b);
      if (busy) resumeLive(box, b);
      const sc = $('#scroller');
      sc.addEventListener('scroll', () => $('.thread-head').classList.toggle('scrolled', sc.scrollTop > 4));
      scrollDown(true);
    }
    $('#input').focus();
  }

  async function clearChat() {
    const b = bot(state.current);
    if (!b) return;
    if (state.busy.has(b.id)) { toast(`${b.name} is still working.`, 'error'); return; }
    await api.clearThread(b.id);
    state.messages = [];
    state.threads[b.id] = { updatedAt: Date.now(), last: '' };
    renderSide(); renderThread();
  }

  function composerHtml(b) {
    const busy = state.busy.has(b.id);
    return `<div class="composer-wrap"><div class="composer">
      <textarea id="input" rows="1" placeholder="Message ${esc(b.name)}"></textarea>
      <div class="composer-row">
        <button class="model-chip" id="modelBtn">${esc(modelName())}${ICON.chev}</button>
        <span class="grow"></span>
        <button class="icon-btn" id="callBtn2" aria-label="Call ${esc(b.name)}" title="Call ${esc(b.name)}">${ICON.phone}</button>
        <button class="send${busy ? ' stop' : ''}" id="sendBtn" aria-label="${busy ? 'Stop' : 'Send'}">${busy ? ICON.stop : ICON.up}</button>
      </div></div></div>`;
  }

  function autosize(t) {
    const fit = () => { t.style.height = 'auto'; t.style.height = `${Math.min(220, t.scrollHeight)}px`; };
    t.addEventListener('input', fit);
    fit();
  }

  function wireComposer() {
    const input = $('#input');
    autosize(input);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
    $('#sendBtn').addEventListener('click', () => (state.busy.has(state.current) ? api.stop(state.current) : send()));
    $('#callBtn2').addEventListener('click', () => window.CrewCall.start(state.current));
    $('#modelBtn').addEventListener('click', (e) => openMenu(e.currentTarget, [
      { label: 'Auto', on: state.models.selected === 'auto' || !state.models.selected, run: () => pickModel('auto') },
      ...state.models.models.map((m) => ({ label: m.name, on: state.models.selected === m.id, run: () => pickModel(m.id) })),
      '-',
      { note: 'Add your own models in Craft. They show up here too.' },
    ]));
  }

  async function pickModel(id) {
    const r = await api.selectModel(id);
    if (r.error) { toast(r.error, 'error'); return; }
    state.models = r;
    const chip = $('#modelBtn');
    if (chip) chip.innerHTML = `${esc(modelName())}${ICON.chev}`;
    renderAccount();
  }

  function setSendState() {
    const btn = $('#sendBtn');
    if (!btn) return;
    const busy = state.busy.has(state.current);
    btn.classList.toggle('stop', busy);
    btn.innerHTML = busy ? ICON.stop : ICON.up;
    btn.setAttribute('aria-label', busy ? 'Stop' : 'Send');
  }

  async function send() {
    const b = bot(state.current);
    const input = $('#input');
    if (!b || !input) return;
    const text = input.value.trim();
    if (!text || state.busy.has(b.id)) return;
    state.messages.push({ kind: 'user', text, at: Date.now() });
    if (!$('#msgs')) renderThread(); // leaving the empty state: draws the thread with this message in it
    else { input.value = ''; input.dispatchEvent(new Event('input')); appendUser($('#msgs'), text); }
    scrollDown(true);
    const r = await api.send(b.id, text);
    if (r.error) {
      state.messages.pop();
      renderThread();
      $('#input').value = text; $('#input').dispatchEvent(new Event('input'));
      toast(r.error, 'error');
      if (/sign in/i.test(r.error) && !state.user) signIn();
      return;
    }
    state.threads[b.id] = { updatedAt: Date.now(), last: text.slice(0, 90) };
  }

  // ─── Rendering messages ─────────────────────────────────────────────────
  function appendUser(box, text) {
    const el = document.createElement('div');
    el.className = 'm-user';
    el.textContent = text;
    box.appendChild(el);
  }

  function botBlock(box, b, working) {
    const el = document.createElement('div');
    el.className = 'm-bot';
    el.innerHTML = `<div class="av">${av(b, 28, { state: working ? 'working' : 'idle' })}</div><div class="m-bot-body"><div class="m-bot-name">${esc(b.name)}</div></div>`;
    box.appendChild(el);
    return el;
  }

  function stepHtml(m) {
    if (m.name === 'ask_bot' && m.delegation) {
      const d = m.delegation;
      const hb = d.bot && bot(d.bot.id) ? bot(d.bot.id) : d.bot;
      return `<div class="helper">${A.renderAvatar((hb && hb.avatar) || {}, 26, { still: true })}<span class="lbl">Asked <b>${esc((hb && hb.name) || 'a teammate')}</b>${d.summary ? `: ${esc(d.summary)}` : ''}</span>${d.ok === false ? `<span style="color:var(--red)">${ICON.bad}</span>` : ''}</div>`;
    }
    const verb = VERB[m.name] || m.name.replace(/_/g, ' ');
    return `<div class="step${m.ok === false ? ' bad' : ''}">${m.ok === false ? ICON.bad : ICON.ok}<span class="lbl"><b>${esc(verb)}</b> ${esc(m.label || '')}</span></div>` +
      (m.ok === false && m.error ? `<div class="step-err">${esc(m.error)}</div>` : '');
  }

  function addToBody(body, html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html.trim();
    const nodes = [...tpl.content.childNodes];
    const thinking = body.querySelector(':scope > .thinking');
    nodes.forEach((n) => body.insertBefore(n, thinking || null));
    return nodes[0];
  }

  function callCardHtml(m, b) {
    const s = Math.round((m.ms || 0) / 1000);
    const turns = (m.turns || []);
    return `<div class="callcard" data-call>${'<span class="callcard-ic">' + ICON.phone + '</span>'}<span><b>Voice call</b><span>${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} · ${turns.length} line${turns.length === 1 ? '' : 's'} · click for transcript</span></span></div>
      <div class="call-transcript hidden">${turns.map((t) => `<div><b>${t.who === 'bot' ? esc(b.name) : 'You'}</b>${esc(t.text)}</div>`).join('') || '<div class="dim">Nothing was said.</div>'}</div>`;
  }

  function renderStored(box, list, b) {
    let body = null;
    for (const m of list) {
      if (m.kind === 'user') { appendUser(box, m.text); body = null; continue; }
      if (m.kind === 'call') {
        const wrap = document.createElement('div');
        wrap.innerHTML = callCardHtml(m, b);
        box.append(...wrap.childNodes);
        body = null; continue;
      }
      if (!body) body = botBlock(box, b, false).querySelector('.m-bot-body');
      if (m.kind === 'assistant') addToBody(body, `<div class="m-text">${md(m.text)}</div>`);
      else if (m.kind === 'tool') addToBody(body, stepHtml(m));
      else if (m.kind === 'error') addToBody(body, `<div class="note err">${esc(m.text)}</div>`);
      else if (m.kind === 'mail') addToBody(body, mailCardHtml(m));
    }
    box.querySelectorAll('[data-call]').forEach(wireCallCard);
  }
  function wireCallCard(card) {
    card.addEventListener('click', () => card.nextElementSibling.classList.toggle('hidden'));
  }

  // The live block for a bot that is answering right now.
  function liveBody(b) {
    const box = $('#msgs');
    if (!box || state.current !== b.id) return null;
    if (!state.live || state.live.botId !== b.id || !box.contains(state.live.el)) {
      const el = botBlock(box, b, true);
      const body = el.querySelector('.m-bot-body');
      const th = document.createElement('div');
      th.className = 'thinking';
      th.innerHTML = '<span class="shimmer">Thinking</span><span class="detail"></span>';
      body.appendChild(th);
      state.live = { botId: b.id, el, body, thinking: th };
    }
    return state.live.body;
  }
  function resumeLive(box, b) { liveBody(b); }

  function scrollDown(force) {
    const sc = $('#scroller');
    if (!sc) return;
    const near = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 160;
    if (force || near) sc.scrollTop = sc.scrollHeight;
  }

  // ─── Engine events ──────────────────────────────────────────────────────
  api.onEvent((ev) => {
    if (ev.groupId) { if (window.CrewGroups) window.CrewGroups.onEvent(ev); return; }
    if (ev.call) { if (window.CrewCall) window.CrewCall.onEvent(ev); return; }
    const b = bot(ev.botId);
    if (!b) return;
    const here = state.current === ev.botId;
    const t = state.threads[b.id] || (state.threads[b.id] = { updatedAt: Date.now(), last: '' });
    switch (ev.type) {
      case 'start':
        state.busy.add(b.id); renderSide(); setSendState();
        if (here) { liveBody(b); scrollDown(true); }
        break;
      case 'thinking':
        if (here && liveBody(b)) { state.live.thinking.querySelector('.detail').textContent = String(ev.text || '').replace(/\s+/g, ' ').slice(0, 160); }
        break;
      case 'tool_start':
        if (here && liveBody(b)) state.live.thinking.querySelector('.detail').textContent = `${VERB[ev.name] || ev.name} ${ev.label || ''}`;
        break;
      case 'tool':
        if (here) { state.messages.push({ kind: 'tool', ...ev }); if (liveBody(b)) addToBody(state.live.body, stepHtml(ev)); scrollDown(); }
        break;
      case 'helper':
        if (here && liveBody(b)) state.live.thinking.querySelector('.detail').textContent = ev.working ? `${ev.bot.name} is working on it...` : '';
        break;
      case 'helper_step':
        if (here && liveBody(b)) state.live.thinking.querySelector('.detail').textContent = `${ev.bot.name}: ${VERB[ev.name] || ev.name} ${ev.label || ''}`;
        break;
      case 'text':
        t.last = String(ev.text).replace(/\s+/g, ' ').slice(0, 90); t.updatedAt = Date.now();
        if (here) { state.messages.push({ kind: 'assistant', text: ev.text }); if (liveBody(b)) addToBody(state.live.body, `<div class="m-text">${md(ev.text)}</div>`); scrollDown(); }
        break;
      case 'notice':
        if (here && liveBody(b)) addToBody(state.live.body, `<div class="note">${esc(ev.text)}</div>`);
        break;
      case 'error':
        if (here) { state.messages.push({ kind: 'error', text: ev.text }); if (liveBody(b)) addToBody(state.live.body, `<div class="note err">${esc(ev.text)}</div>`); scrollDown(); }
        else toast(`${b.name}: ${ev.text}`, 'error');
        break;
      case 'approval':
        if (!here) toast(`${b.name} needs your OK. Open the chat to answer.`);
        if (liveBody(b)) { addToBody(state.live.body, approvalHtml(ev)); wireApproval(ev.requestId); scrollDown(true); }
        break;
      case 'approval_done': {
        const card = document.querySelector(`.approve[data-req="${ev.requestId}"]`);
        if (card) card.outerHTML = `<div class="note">${ev.verdict === 'reject' ? 'You said no.' : ev.verdict === 'draft' ? 'Saved as a draft.' : 'You allowed it.'}</div>`;
        break;
      }
      case 'mail':
        t.last = String(ev.msg.text || ''); t.updatedAt = Date.now();
        if (here) {
          state.messages.push(ev.msg);
          const box = $('#msgs');
          if (box) { addToBody(botBlock(box, b, false).querySelector('.m-bot-body'), mailCardHtml(ev.msg)); scrollDown(true); }
        } else toast(`${b.name}: ${ev.msg.text}`);
        renderSide();
        break;
      case 'open':
        openBot(b.id);
        break;
      case 'learned':
        state.catalog = ev.catalog || state.catalog;
        if (here) toast(`${b.name} will remember: ${ev.facts[0]}`);
        break;
      case 'reflected':
        state.catalog = ev.catalog || state.catalog;
        if (here && ev.playbook) toast(`${b.name} ${ev.updated ? 'got better at' : 'learned how to do'}: ${ev.playbook}`);
        break;
      case 'done':
        state.busy.delete(b.id);
        if (state.live && state.live.botId === b.id) {
          state.live.thinking.remove();
          A.setAvatarState(state.live.el.querySelector('.av'), 'done');
          const el = state.live.el;
          setTimeout(() => A.setAvatarState(el.querySelector('.av'), 'idle'), 1600);
          if (!state.live.body.querySelector('.m-text, .step, .note, .helper')) el.remove();
          state.live = null;
        }
        renderSide(); setSendState();
        break;
      default: break;
    }
  });

  function approvalHtml(ev) {
    if (ev.draft) {
      // An email: To, Subject and Body are editable; what is left there is what goes out.
      const d = ev.draft;
      return `<div class="approve email${ev.danger ? ' danger' : ''}" data-req="${esc(ev.requestId)}">
      <div class="approve-title">${esc(ev.title || 'Send this email?')}</div>
      <label class="email-field"><span>To</span><input data-f="to" type="text" spellcheck="false" value="${esc(d.to)}"></label>
      <label class="email-field"><span>Subject</span><input data-f="subject" type="text" value="${esc(d.subject)}"></label>
      <textarea class="email-body" data-f="body" rows="6">${esc(d.body)}</textarea>
      <div class="approve-row"><button class="btn" data-v="reject">Don't send</button>${ev.draftOnly ? '' : '<button class="btn" data-v="draft">Save as draft</button>'}<button class="btn primary" data-v="once">${ev.draftOnly ? 'Save draft' : 'Send'}</button></div></div>`;
    }
    return `<div class="approve${ev.danger ? ' danger' : ''}" data-req="${esc(ev.requestId)}">
      <div class="approve-title">${esc(ev.title || 'Allow this?')}</div>
      ${ev.detail ? `<pre>${esc(ev.detail)}</pre>` : ''}
      <div class="approve-row"><button class="btn" data-v="reject">Don't allow</button><button class="btn" data-v="always">Always in this chat</button><button class="btn primary" data-v="once">Allow</button></div></div>`;
  }
  function wireApproval(id) {
    const card = document.querySelector(`.approve[data-req="${id}"]`);
    if (!card) return;
    card.querySelectorAll('[data-v]').forEach((b) => b.addEventListener('click', () => {
      const fields = card.querySelectorAll('[data-f]');
      if (!fields.length || b.dataset.v === 'reject') { api.respond(id, b.dataset.v); return; }
      const edits = {};
      fields.forEach((f) => { edits[f.dataset.f] = f.value; });
      api.respond(id, { verdict: b.dataset.v, edits });
    }));
  }

  // ─── Bot editor ─────────────────────────────────────────────────────────
  const PICKERS = [
    { key: 'shape', label: 'Shape', list: () => Object.entries(A.SHAPES), preview: (d, k) => ({ ...d.avatar, shape: k, glasses: 'none', accessory: 'none' }) },
    { key: 'eyes', label: 'Eyes', face: true, list: () => Object.entries(A.EYES), preview: (d, k) => ({ ...d.avatar, eyes: k, glasses: 'none', accessory: 'none', mouth: 'none' }) },
    { key: 'mouth', label: 'Mouth', face: true, list: () => Object.entries(A.MOUTHS), preview: (d, k) => ({ ...d.avatar, mouth: k, glasses: 'none', accessory: 'none' }) },
    { key: 'glasses', label: 'Optics', face: true, list: () => Object.entries(A.GLASSES), preview: (d, k) => ({ ...d.avatar, glasses: k, accessory: 'none' }) },
    { key: 'accessory', label: 'Extra', list: () => Object.entries(A.ACCESSORIES), preview: (d, k) => ({ ...d.avatar, accessory: k, glasses: 'none' }) },
  ];
  let voices = null;

  // New bot: describe it first (the model drafts everything), or start blank,
  // or take a template.
  const IDEAS = ['Reads my email every morning and tells me what matters', 'A patient tutor who explains math with simple examples', 'Writes my LinkedIn posts in my voice', 'Keeps an eye on my website and tells me if it breaks'];
  function newBot() {
    const used = new Set(state.catalog.bots.map((b) => b.template).filter(Boolean));
    const m = modal(`
      <div class="modal-head"><div class="modal-title">New bot</div><button class="icon-btn" data-act="close" aria-label="Close">${ICON.x}</button></div>
      <div class="modal-body">
        <div class="field"><div class="field-label">Describe your bot</div>
          <textarea class="input" id="nbText" rows="3" placeholder="What should it do, and how should it talk?"></textarea></div>
        <div class="chips nb-ideas">${IDEAS.map((t) => `<button class="chip">${esc(t)}</button>`).join('')}</div>
        <div class="nb-or"><span>or start from a template</span></div>
        <div class="tpl-row">${state.catalog.templates.map((t) => `<button class="tpl" data-tpl="${esc(t.key)}" ${used.has(t.key) ? 'disabled' : ''} title="${esc(t.specialty)}">${A.renderAvatar(t.avatar, 26, { still: true })}${esc(t.name)} <span class="dim">${esc(t.key)}</span></button>`).join('')}</div>
      </div>
      <div class="modal-foot">
        <button class="btn" data-act="blank">Start blank</button>
        <span class="grow err-text" id="nbErr"></span>
        <button class="btn primary" data-act="build">Build bot</button>
      </div>`, true);
    m.classList.add('wide');
    const input = $('#nbText', m);
    m.querySelectorAll('[data-act="close"]').forEach((b) => b.addEventListener('click', closeModal));
    m.querySelectorAll('.nb-ideas .chip').forEach((c) => c.addEventListener('click', () => { input.value = c.textContent; input.focus(); }));
    m.querySelector('[data-act="blank"]').addEventListener('click', () => editBot(null, { name: '', role: 'specialist', avatar: A.randomAvatar(Date.now()) }));
    m.querySelectorAll('.tpl').forEach((c) => c.addEventListener('click', async () => {
      c.disabled = true;
      const r = await api.botsFromTemplate(c.dataset.tpl);
      if (r.error) { toast(r.error, 'error'); c.disabled = false; return; }
      state.catalog = r; closeModal(); toast(`${r.bot.name} joined your crew.`); openBot(r.bot.id);
    }));
    const build = async () => {
      const text = input.value.trim();
      if (!text) { input.focus(); return; }
      const btn = m.querySelector('[data-act="build"]');
      btn.disabled = true; input.disabled = true; btn.textContent = 'Building...';
      $('#nbErr', m).textContent = '';
      const r = await api.botsDescribe(text);
      if (r.error) { btn.disabled = false; input.disabled = false; btn.textContent = 'Build bot'; $('#nbErr', m).textContent = r.error; return; }
      editBot(null, r.draft, 'Built from your description. Change anything, then create it.');
    };
    m.querySelector('[data-act="build"]').addEventListener('click', build);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); build(); } });
    input.focus();
  }

  async function editBot(b, draft, note) {
    if (!voices) { try { voices = await api.voiceVoices(); } catch { voices = { edge: [], kokoro: [] }; } }
    const d = b ? JSON.parse(JSON.stringify(b)) : {
      name: '', role: 'specialist', specialty: '', instructions: '', tone: { preset: 'friendly', custom: '' }, sources: '',
      approval: Object.keys(state.catalog.approvals), memory: [], ...(draft || {}),
    };
    d.avatar = A.normalizeAvatar(d.avatar);
    d.tone = d.tone || { preset: 'friendly', custom: '' };
    const ui = { id: b ? b.id : null, note, error: '', confirmDelete: false, voice: b ? (b.voice || (state.settings.voices || {})[b.id] || '') : '' };
    paintEditor(d, ui);
  }

  // Experience: what the bot learned from its own work (lessons, playbooks, tool tips, open threads).
  function experienceHtml(d) {
    const lessons = d.lessons || []; const playbooks = d.playbooks || []; const tips = d.toolTips || []; const threads = d.openThreads || [];
    const total = lessons.length + playbooks.length + tips.length + threads.length;
    const del = (kind, i) => `<button data-xforget="${kind}:${i}" title="Forget">${ICON.x}</button>`;
    const group = (title, kind, list, row) => (list.length
      ? `<div class="xp-sub">${title}</div><ul class="mem">${list.map((x, i) => `<li>${row(x)}${del(kind, i)}</li>`).reverse().join('')}</ul>` : '');
    const pb = (p) => `<details class="xp-pb"><summary>${esc(p.app)} / ${esc(p.task)}${p.uses > 1 ? ` <span class="dim">used ${p.uses} times</span>` : ''}</summary>
      ${p.when ? `<div class="dim">${esc(p.when)}</div>` : ''}<ol>${(p.steps || []).map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
      ${(p.precautions || []).length ? `<div class="dim">Watch out: ${p.precautions.map(esc).join(' · ')}</div>` : ''}${p.params ? `<div class="dim">What worked: ${esc(p.params)}</div>` : ''}</details>`;
    const counts = [[lessons.length, 'lesson'], [playbooks.length, 'playbook'], [tips.length, 'tool tip']].filter(([n]) => n).map(([n, w]) => `${n} ${w}${n === 1 ? '' : 's'}`).join(', ');
    return `<div class="field xp" data-experience><div class="field-label">Experience <span class="dim">${total ? counts || 'open threads' : 'from its own work'}</span>${total ? '<button class="link" data-act="clear-xp">Clear all</button>' : ''}</div>
      ${total ? [
    group('Lessons', 'lessons', lessons, (l) => `<span>When ${esc(l.situation)}: ${esc(l.strategy)}</span>`),
    group('Playbooks', 'playbooks', playbooks, (p) => `<span>${pb(p)}</span>`),
    group('Tool tips', 'toolTips', tips, (t) => `<span>${esc(t.tip)}</span>`),
    group('Open threads', 'openThreads', threads, (t) => `<span>${esc(t.text)}</span>`),
  ].join('') : '<div class="dim">Nothing yet. After it works with its tools, it keeps what worked: lessons, step by step playbooks and tool tips.</div>'}</div>`;
  }

  function paintEditor(d, ui) {
    const isNew = !ui.id;
    const m = modal(`
      <div class="modal-head"><div class="modal-title">${isNew ? 'New bot' : esc(d.name || 'Bot')}</div><button class="icon-btn" data-act="close" aria-label="Close">${ICON.x}</button></div>
      <div class="modal-body"><div class="editor">
        <div>
          <div class="stage" id="stage">${A.renderAvatar(d.avatar, 150)}</div>
          <div class="stage-actions"><button class="btn" data-act="surprise">Surprise me</button></div>
          ${PICKERS.map((p) => `<div class="pick-label">${p.label}</div><div class="pick-row" data-pick="${p.key}">${p.list().map(([k, v]) => `<button class="pick${d.avatar[p.key] === k ? ' on' : ''}" data-val="${esc(k)}" title="${esc(v.label)}">${A.renderAvatar(p.preview(d, k), 38, { still: true, flat: true, zoom: p.face ? 'face' : '' })}</button>`).join('')}</div>`).join('')}
          <div class="pick-label">Color</div><div class="pick-row">${Object.entries(A.COLORS).map(([k, hex]) => `<button class="swatch${d.avatar.color === k ? ' on' : ''}" data-color="${k}" style="--sw:${hex}" title="${k}"></button>`).join('')}</div>
        </div>
        <div>
          ${ui.note ? `<p class="dim" style="margin:0 0 14px">${esc(ui.note)}</p>` : ''}
          <div class="field"><div class="field-label">Name</div><input class="input" data-f="name" maxlength="40" value="${esc(d.name)}" placeholder="Stella"></div>
          <div class="field"><div class="field-label">What it does</div><input class="input" data-f="specialty" maxlength="200" value="${esc(d.specialty)}" placeholder="Plans my week and keeps me on track"></div>
          <div class="field"><div class="field-label">How it works</div><textarea class="input" data-f="instructions" rows="4" placeholder="What it always does, what it never does.">${esc(d.instructions)}</textarea></div>
          <div class="field"><div class="field-label">Tone</div><div class="tones">${Object.entries(state.catalog.tones).map(([k, t]) => `<button class="tone${d.tone.preset === k ? ' on' : ''}" data-tone="${k}" title="${esc(t.text)}">${esc(t.label)}</button>`).join('')}</div>
            <input class="input" data-tone-custom maxlength="400" value="${esc(d.tone.custom || '')}" placeholder="Anything else about how it talks (optional)"></div>
          <div class="field"><div class="field-label" style="display:flex">Voice on calls<button class="link voice-settings-link" data-act="voice-settings">Voice settings</button></div>
            <div class="voice-row"><select class="input" data-voice>${voiceOptions(ui.voice)}</select><button class="btn" data-act="preview-voice">Preview</button></div></div>
          <div class="field"><div class="field-label">Role</div><div class="seg"><button class="${d.role === 'specialist' ? 'on' : ''}" data-role="specialist">Specialist</button><button class="${d.role === 'orchestrator' ? 'on' : ''}" data-role="orchestrator">Orchestrator</button></div>
            <div class="dim" style="margin-top:6px">${d.role === 'orchestrator' ? 'Splits a big goal into steps and hands each to the right teammate.' : 'One clear job. Teammates can ask it for help.'}</div></div>
          <div class="field"><div class="field-label">Must ask you before</div><div class="checks">${Object.entries(state.catalog.approvals).map(([k, label]) => `<label class="check"><input type="checkbox" data-approval="${k}" ${d.approval.includes(k) ? 'checked' : ''}>${esc(label)}</label>`).join('')}</div></div>
          ${alwaysOnHtml(d, { field: 'field', label: 'field-label', check: 'check', input: 'input', dim: 'dim' })}
          ${isNew ? '' : `<div class="field"><div class="field-label">Memory <span class="dim">${d.memory.length} things</span>${d.memory.length ? '<button class="link" data-act="clear-mem">Clear all</button>' : ''}</div>
            ${d.memory.length ? `<ul class="mem">${d.memory.map((x, i) => `<li><span>${esc(x.fact)}</span><button data-forget="${i}" title="Forget">${ICON.x}</button></li>`).reverse().join('')}</ul>` : '<div class="dim">Nothing yet. It learns your preferences as you chat and call.</div>'}</div>
          ${experienceHtml(d)}`}
        </div>
      </div></div>
      <div class="modal-foot">
        ${isNew ? '' : `<button class="btn danger" data-act="delete">${ui.confirmDelete ? 'Click again to delete' : 'Delete'}</button>`}
        <span class="grow err-text">${esc(ui.error)}</span>
        <button class="btn" data-act="close">Cancel</button>
        <button class="btn primary" data-act="save">${isNew ? 'Create bot' : 'Save'}</button>
      </div>`);
    const on = (act, fn) => m.querySelectorAll(`[data-act="${act}"]`).forEach((el) => el.addEventListener('click', fn));
    const restage = () => { $('#stage').innerHTML = A.renderAvatar(d.avatar, 150); };
    m.querySelectorAll('[data-f]').forEach((el) => el.addEventListener('input', () => { d[el.dataset.f] = el.value; }));
    $('[data-tone-custom]', m).addEventListener('input', (e) => { d.tone.custom = e.target.value; });
    $('[data-voice]', m).addEventListener('change', (e) => { ui.voice = e.target.value; });
    on('preview-voice', (e) => previewVoice(ui.voice, d, ui, e.currentTarget));
    on('voice-settings', () => voiceSettings(() => paintEditor(d, ui)));
    m.querySelectorAll('[data-tone]').forEach((el) => el.addEventListener('click', () => { d.tone.preset = el.dataset.tone; m.querySelectorAll('[data-tone]').forEach((x) => x.classList.toggle('on', x === el)); }));
    m.querySelectorAll('[data-role]').forEach((el) => el.addEventListener('click', () => { d.role = el.dataset.role; paintEditor(d, ui); }));
    m.querySelectorAll('[data-approval]').forEach((el) => el.addEventListener('change', () => {
      d.approval = el.checked ? [...new Set([...d.approval, el.dataset.approval])] : d.approval.filter((x) => x !== el.dataset.approval);
    }));
    wireAlwaysOn(m, d);
    m.querySelectorAll('.pick-row[data-pick]').forEach((row) => row.addEventListener('click', (e) => {
      const tile = e.target.closest('.pick');
      if (!tile) return;
      d.avatar[row.dataset.pick] = tile.dataset.val;
      row.querySelectorAll('.pick').forEach((x) => x.classList.toggle('on', x === tile));
      restage();
    }));
    m.querySelectorAll('[data-color]').forEach((el) => el.addEventListener('click', () => {
      d.avatar.color = el.dataset.color;
      m.querySelectorAll('[data-color]').forEach((x) => x.classList.toggle('on', x === el));
      restage();
    }));
    on('surprise', () => { d.avatar = A.randomAvatar(Math.random()); paintEditor(d, ui); });
    on('close', closeModal);
    m.querySelectorAll('[data-forget]').forEach((el) => el.addEventListener('click', async () => {
      const r = await api.botsForget(ui.id, Number(el.dataset.forget));
      if (r.error) { toast(r.error, 'error'); return; }
      state.catalog = r; d.memory = r.bot.memory; paintEditor(d, ui);
    }));
    const setXp = (bot) => { for (const k of ['lessons', 'playbooks', 'toolTips', 'openThreads']) d[k] = bot[k] || []; };
    m.querySelectorAll('[data-xforget]').forEach((el) => el.addEventListener('click', async (e) => {
      e.preventDefault();
      const [kind, i] = el.dataset.xforget.split(':');
      const r = await api.botsForgetExperience(ui.id, kind, Number(i));
      if (r.error) { toast(r.error, 'error'); return; }
      state.catalog = r; setXp(r.bot); paintEditor(d, ui);
    }));
    on('clear-xp', async () => {
      const r = await api.botsForgetExperience(ui.id, 'all', -1);
      if (r.error) { toast(r.error, 'error'); return; }
      state.catalog = r; setXp(r.bot); paintEditor(d, ui);
    });
    on('clear-mem', async () => {
      const r = await api.botsClearMemory(ui.id);
      if (r.error) { toast(r.error, 'error'); return; }
      state.catalog = r; d.memory = []; paintEditor(d, ui);
    });
    on('delete', async () => {
      if (!ui.confirmDelete) { ui.confirmDelete = true; paintEditor(d, ui); return; }
      const r = await api.botsRemove(ui.id);
      if (r.error) { toast(r.error, 'error'); return; }
      state.catalog = r; delete state.threads[ui.id];
      if (r.groups) state.groups = r.groups;
      closeModal(); toast(`${d.name} left the crew.`);
      if (state.current === ui.id) goHome(); else if (state.currentGroup && window.CrewGroups) window.CrewGroups.open(state.currentGroup); else renderSide();
    });
    on('save', async () => {
      if (!String(d.name || '').trim()) { ui.error = 'Give it a name.'; paintEditor(d, ui); return; }
      const patch = { name: d.name, role: d.role, specialty: d.specialty, instructions: d.instructions, tone: d.tone, sources: d.sources || '', approval: d.approval, avatar: d.avatar, voice: ui.voice, alwaysOn: d.alwaysOn };
      const r = ui.id ? await api.botsUpdate(ui.id, patch) : await api.botsCreate(patch);
      if (r.error) { ui.error = r.error; paintEditor(d, ui); return; }
      state.catalog = r;
      const s = await api.setSettings({ voice: { botId: r.bot.id, id: ui.voice } });
      if (!s.error) state.settings = s;
      closeModal();
      toast(ui.id ? `Saved ${r.bot.name}.` : `${r.bot.name} joined your crew.`);
      if (!ui.id || state.current === r.bot.id) openBot(r.bot.id); else renderSide();
    });
  }

  // ─── Sign in ────────────────────────────────────────────────────────────
  function signIn() {
    const m = modal(`
      <div class="modal-head"><div class="modal-title">Sign in to Codeply</div><button class="icon-btn" data-act="close" aria-label="Close">${ICON.x}</button></div>
      <div class="modal-body signin">
        <p>Use your Codeply account. If you're signed in to Craft on this PC, Crew already uses it.</p>
        <input class="input" id="siEmail" type="email" placeholder="Email" autocomplete="email">
        <input class="input" id="siPass" type="password" placeholder="Password" autocomplete="current-password">
        <span class="err-text" id="siErr"></span>
        <p class="dim">Signed up with Google? Sign in to Craft once and Crew picks it up. You can also pick your own model from the model menu and skip signing in.</p>
      </div>
      <div class="modal-foot"><span class="grow"></span><button class="btn" data-act="close">Not now</button><button class="btn primary" id="siGo">Sign in</button></div>`, true);
    m.querySelectorAll('[data-act="close"]').forEach((b) => b.addEventListener('click', closeModal));
    const go = async () => {
      $('#siGo').disabled = true;
      const r = await api.signIn($('#siEmail').value, $('#siPass').value);
      $('#siGo').disabled = false;
      if (r.error) { $('#siErr').textContent = r.error; return; }
      state.user = r.user; closeModal(); renderAccount(); toast(`Signed in as ${r.user.email}.`);
    };
    $('#siGo').addEventListener('click', go);
    $('#siPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    $('#siEmail').focus();
  }

  // ─── Start ──────────────────────────────────────────────────────────────
  async function boot() {
    const r = await api.init();
    if (r.error) {
      $('#view').innerHTML = `<div class="empty"><div class="empty-name">Crew could not start</div><p class="empty-sub">${esc(r.error)}</p></div>`;
      return;
    }
    Object.assign(state, { user: r.user, models: r.models, catalog: r.catalog, threads: r.threads || {}, groups: r.groups || [], settings: r.settings || {}, workspace: r.workspace });
    let last = null;
    try { last = localStorage.getItem('crew.last'); } catch {}
    if (last && last.startsWith('g:') && state.groups.some((g) => `g:${g.id}` === last)) window.CrewGroups.open(last.slice(2));
    else if (last && bot(last)) openBot(last); else goHome();
    if (r.openBot && bot(r.openBot)) openBot(r.openBot); // a notification was clicked
  }

  // Bots are shared with Craft: pick up ones made or changed there.
  window.addEventListener('focus', async () => {
    const r = await api.botsList();
    if (!r || r.error) return;
    const before = JSON.stringify(state.catalog.bots.map((b) => [b.id, b.name, b.updatedAt]));
    state.catalog = r;
    if (JSON.stringify(r.bots.map((b) => [b.id, b.name, b.updatedAt])) !== before) {
      if (state.current && !bot(state.current)) goHome(); else if (state.currentGroup && window.CrewGroups) window.CrewGroups.open(state.currentGroup); else renderSide();
    }
  });

  window.CrewUI = {
    bot, av, toast, openBot, goHome, renderSide, ICON, VERB, md, esc, modal, closeModal, openMenu, autosize, modelName, pickModel,
    botBlock, stepHtml, addToBody, appendUser, scrollDown, approvalHtml, wireApproval,
    refreshThread: () => state.current && openBot(state.current),
  };
  // After every script (groups.js, call.js) has loaded, so a restored group chat can open.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
