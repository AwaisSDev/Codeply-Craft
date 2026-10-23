// Settings: the sidebar turns into a settings menu and the page shows one
// section at a time as groups of rows (what it is on the left, the control
// on the right). Also the permissions chip in every composer: what this chat
// is always allowed to do, and a way to take it back.
(() => {
  const api = window.crew;
  const UI = window.CrewUI;
  const S = () => window.CrewState;
  const $ = (q, el = document) => el.querySelector(q);
  const esc = (s) => UI.esc(s);

  const ICON = {
    back: '<svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>',
    gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></svg>',
    shield: '<svg viewBox="0 0 24 24"><path d="M12 2l8 3v6c0 5-3.4 9.4-8 11-4.6-1.6-8-6-8-11V5Z"/><path d="M9 12l2 2 4-4"/></svg>',
    mic: '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
    plug: '<svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>',
    user: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
    life: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    brain: '<svg viewBox="0 0 24 24"><path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 1V6a2 2 0 0 0-3-2Z"/><path d="M15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 1"/></svg>',
    chev: '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
    out: '<svg viewBox="0 0 24 24"><path d="M14 4h5v5"/><path d="M19 4l-8 8"/><path d="M18 14v5H5V6h5"/></svg>',
  };
  const NAV = [
    { group: 'Crew' },
    { id: 'general', label: 'General', icon: ICON.gear },
    { id: 'permissions', label: 'Permissions', icon: ICON.shield },
    { id: 'voice', label: 'Voice', icon: ICON.mic },
    { group: 'Integrations' },
    { id: 'connections', label: 'Connections', icon: ICON.plug },
    { group: 'Your data' },
    { id: 'life', label: 'Life', icon: ICON.life, page: () => window.CrewLife && window.CrewLife.show() },
    { id: 'brain', label: 'Brain', icon: ICON.brain, page: () => window.CrewBrain && window.CrewBrain.show() },
    { group: 'You' },
    { id: 'account', label: 'Account', icon: ICON.user },
  ];

  // ─── What is allowed, in words ──────────────────────────────────────────
  const TOOL_WORDS = {
    use_computer: 'Using your mouse and keyboard', write_file: 'Writing files', edit_file: 'Editing files', apply_patch: 'Changing files',
    gmail_send: 'Sending email', gmail_draft: 'Saving email drafts', bot_email_send: 'Sending its own email', slack_post_message: 'Posting to Slack',
    calendar_add: 'Adding to your calendar', calendar_update: 'Changing your calendar', vercel_deploy: 'Deploying to Vercel', vercel_api: 'Changing Vercel',
    github_create_repo: 'Creating GitHub repos', supabase_sql: 'Running SQL on Supabase', supabase_api: 'Changing Supabase', supabase_create_project: 'Creating Supabase projects',
    supabase_delete_project: 'Deleting Supabase projects', add_model: 'Adding models', publish_deploy: 'Publishing', publish_github: 'Pushing to GitHub', run: 'Every command',
  };
  // The two ways a chat can ask (crew-main.js access).
  const MODES = {
    ask: { label: 'Always ask', desc: 'Asks before every command, click, email or edit.' },
    once: { label: 'Ask once', desc: 'Once you allow something, it is allowed for the rest of the chat. Emails still show every time.' },
  };
  const SCRIPTERS = { powershell: 'PowerShell', pwsh: 'PowerShell', cmd: 'cmd', bash: 'bash', sh: 'sh', node: 'node', python: 'Python', python3: 'Python', py: 'Python' };
  // "git" commands; a one-off script (allowed only exactly as it was) is shortened.
  function allowedWords(x) {
    if (!String(x).startsWith('run:')) return TOOL_WORDS[x] || String(x).replace(/_/g, ' ');
    const cmd = String(x).slice(4).trim();
    const [first, ...rest] = cmd.split(/\s+/);
    if (rest.length && (SCRIPTERS[first] || cmd.length > 40)) {
      const body = rest.join(' ');
      return `${SCRIPTERS[first] || first} script: "${body.length > 48 ? `${body.slice(0, 47).trim()}…` : body}"`;
    }
    return `"${cmd}" commands`;
  }
  const chatName = (key) => {
    if (String(key).startsWith('group:')) { const g = (S().groups || []).find((x) => x.id === key.slice(6)); return g ? g.name : 'A group chat'; }
    const b = UI.bot(key); return b ? b.name : 'A chat that is gone';
  };

  // ─── Building blocks ────────────────────────────────────────────────────
  const row = (title, desc, ctl = '', cls = '') => `<div class="set-row${cls ? ` ${cls}` : ''}"><div class="set-row-text"><div class="set-row-title">${title}</div>${desc ? `<div class="set-row-desc">${desc}</div>` : ''}</div>${ctl ? `<div class="set-row-ctl">${ctl}</div>` : ''}</div>`;
  const section = (title, rows, sub = '') => `<section class="set-section">${title ? `<h2 class="set-h2">${title}</h2>` : ''}${sub ? `<p class="set-sub">${sub}</p>` : ''}<div class="set-card">${rows.join('')}</div></section>`;
  const pill = (attrs, label) => `<button class="set-pill" ${attrs}>${esc(label)}${ICON.chev}</button>`;
  const button = (attrs, label, kind = '') => `<button class="set-btn${kind ? ` ${kind}` : ''}" ${attrs}>${label}</button>`;
  const toggle = (attrs, on) => `<label class="set-switch"><input type="checkbox" ${attrs} ${on ? 'checked' : ''}><span></span></label>`;

  let open = false;
  let page = 'general';
  let before = null; // where the user was, to go back to

  // ─── Pages ──────────────────────────────────────────────────────────────
  const PAGES = {
    general: { title: 'General', async html() {
      const st = S();
      return section('', [
        row('Model', 'Every bot in Crew answers with this model. Add your own models in Craft.', pill('data-act="model"', UI.modelName())),
        row('Saved work', `Where your bots save what they make.<br><span class="set-path">${esc(st.workspace || 'Not set yet')}</span>`, button('data-act="folder"', 'Open folder')),
        row('Craft', 'Your bots, models and connections are shared with Codeply Craft.', button('data-act="craft"', `Open Craft${ICON.out}`)),
      ]);
    } },

    permissions: { title: 'Permissions', sub: 'What your bots may do on this PC, and what they ask you first.', async html() {
      const st = S();
      const labels = st.catalog.approvals || {};
      let chats = [];
      try { chats = (api.accessList && await api.accessList()) || []; } catch {}
      const bots = st.catalog.bots || [];
      const botRows = bots.map((b) => {
        const asks = (b.approval || []).filter((k) => labels[k]);
        const free = Object.keys(labels).filter((k) => !asks.includes(k));
        const none = b.autonomy && b.autonomy.level === 'none';
        const desc = none ? 'Suggests only. It never acts, so it never asks.'
          : free.length ? `Acts without asking: ${free.map((k) => labels[k].toLowerCase()).join('; ')}.`
            : 'Asks you before every action.';
        return row(`<span class="set-who">${UI.av(b, 22, { still: true })}${esc(b.name)}</span>`, esc(desc), button(`data-act="edit-bot" data-id="${esc(b.id)}"`, 'Edit'));
      });
      const said = (list) => list.map((x, i) => (i ? allowedWords(x).replace(/^[A-Z]/, (c) => c.toLowerCase()) : allowedWords(x))).join(', ');
      const chatRows = chats.map((c) => row(esc(chatName(c.key)), `Allowed without asking: ${esc(said(c.always).replace(/^[A-Z]/, (c) => c.toLowerCase()))}.`, button(`data-act="forget-chat" data-key="${esc(c.key)}"`, 'Forget')));
      return [
        section('Approvals', [
          row('New chats', `${esc((MODES[st.settings.accessDefault] || MODES.ask).desc)} Change it for one chat with the shield in its message box.`, pill('data-act="default-mode"', (MODES[st.settings.accessDefault] || MODES.ask).label)),
          row('Allowing commands', 'Commands are allowed one name at a time, so allowing <i>git</i> never allows every command. Anything that looks risky always asks.'),
        ]),
        section('Each bot', botRows.length ? botRows : [row('No bots yet', 'Make one from the home screen.')], 'A bot can be trusted to skip asking for some kinds of actions. Change it in the bot\'s settings, under Approval.'),
        section('Always allowed in chats', chatRows.length ? chatRows : [row('Nothing yet', 'When you pick Always in this chat on a request, it shows up here, so you can take it back.', '', 'empty')]),
      ].join('');
    } },

    voice: { title: 'Voice', sub: 'How your bots sound on calls.', async html() {
      const st = S().settings || {};
      const ENG = { deepgram: 'Deepgram', edge: 'Edge', kokoro: 'Kokoro' };
      const NOTE = { deepgram: 'The most natural voices. Included with your Codeply account, or unlimited with your own key.', edge: 'Natural and free. Needs internet.', kokoro: 'Offline, on this PC. The first call downloads it, about 90 MB.' };
      const eng = ENG[st.voiceEngine] ? st.voiceEngine : 'edge';
      return section('', [
        row('Voice engine', esc(NOTE[eng]), pill('data-act="engine"', ENG[eng])),
        row('Your Deepgram key', st.hasDeepgramKey ? 'Saved, encrypted on this PC. Your bots use it for unlimited Deepgram voices.' : 'Optional. Without it, Deepgram voices use the daily allowance of your Codeply account.', button('data-act="voice"', st.hasDeepgramKey ? 'Manage' : 'Add key')),
        row('A voice for each bot', 'Pick it in each bot\'s settings, under Voice on calls.'),
      ]);
    } },

    connections: { title: 'Connections', sub: 'The apps your bots can use. They are the same connections as in Craft.', async html() {
      let conns = [];
      try { conns = (api.connections && await api.connections()) || []; } catch {}
      const LOGO = { gmail: '../Gmail.webp', slack: '../Slack.webp', github: '../Github.webp', vercel: '../Vercel.png', supabase: '../Supabase.jpg' };
      const gmail = conns.find((c) => c.id === 'gmail' && c.connected);
      const rows = conns.map((c) => row(`<span class="set-who"><img class="set-logo" src="${LOGO[c.id] || ''}" alt="">${esc(c.name)}</span>`, esc(c.connected ? (c.account || 'Connected') : 'Not connected'),
        `<span class="set-status${c.connected ? ' on' : ''}">${c.connected ? 'Connected' : 'Off'}</span>`));
      return section('', [
        ...rows,
        row('Manage connections', 'Connect or disconnect apps in Craft\'s Connect Apps.', button('data-act="connect"', `Open${ICON.out}`)),
      ]) + (gmail && api.gmailPhone ? section('Phone calls', [
        row('Gmail on calls', 'Bots read your inbox on phone calls, even with this PC off. Your sign-in is kept on Codeply\'s server, encrypted. Sending still asks.', toggle('data-act="gmail-phone" disabled', false)),
      ]) : '');
    } },

    account: { title: 'Account', async html() {
      const u = S().user;
      return section('', [
        row(u ? esc(u.email) : 'Not signed in', u ? 'Your Codeply account, the same one as in Craft.' : 'Sign in with the same account as Craft to use Haze 2 and voice.',
          u ? button('data-act="sign-out"', 'Sign out', 'danger') : button('data-act="sign-in"', 'Sign in', 'primary')),
      ]);
    } },
  };

  // ─── The sidebar menu ───────────────────────────────────────────────────
  function paintNav() {
    const el = $('#sideSettings');
    el.innerHTML = `<button class="set-back" data-nav="back">${ICON.back}<span>Back to Crew</span></button>
      <div class="set-side-title">Settings</div>
      <nav class="set-nav">${NAV.map((n) => (n.group
    ? `<div class="set-nav-group">${esc(n.group)}</div>`
    : `<button class="set-nav-item${n.id === page ? ' on' : ''}" data-nav="${n.id}">${n.icon}<span>${esc(n.label)}</span></button>`)).join('')}</nav>`;
    el.querySelectorAll('[data-nav]').forEach((b) => b.addEventListener('click', () => {
      const id = b.dataset.nav;
      if (id === 'back') { leave(); return; }
      const n = NAV.find((x) => x.id === id);
      if (n && n.page) { hide(); n.page(); return; }
      show(id);
    }));
  }

  async function paint() {
    const p = PAGES[page] || PAGES.general;
    const view = $('#view');
    view.innerHTML = `<div class="set-scroll"><div class="set-page"><h1 class="set-h1">${esc(p.title)}</h1>${p.sub ? `<p class="set-lede">${esc(p.sub)}</p>` : ''}<div class="set-body" aria-busy="true"></div></div></div>`;
    const body = $('.set-body', view);
    const html = await p.html();
    if (!open || PAGES[page] !== p) return;
    body.innerHTML = html;
    body.removeAttribute('aria-busy');
    wire(body);
  }

  function wire(body) {
    const st = S();
    const on = (act, fn) => body.querySelectorAll(`[data-act="${act}"]`).forEach((el) => el.addEventListener(el.type === 'checkbox' ? 'change' : 'click', (e) => fn(el, e)));
    on('model', (el) => UI.openMenu(el, [
      { label: 'Haze 2', on: st.models.selected === 'auto' || !st.models.selected, run: async () => { await UI.pickModel('auto'); paint(); } },
      ...st.models.models.map((m) => ({ label: m.name, on: st.models.selected === m.id, run: async () => { await UI.pickModel(m.id); paint(); } })),
    ], 'right'));
    on('folder', () => api.openFolder(st.workspace));
    on('craft', () => api.toCraft());
    on('connect', () => api.openConnect());
    on('edit-bot', (el) => { const b = UI.bot(el.dataset.id); if (b) UI.editBot(b); });
    on('forget-chat', async (el) => {
      el.disabled = true;
      await api.accessSet(el.dataset.key, { clearAlways: true });
      UI.toast(`${chatName(el.dataset.key)} asks again before everything.`);
      paint();
    });
    on('default-mode', (el) => UI.openMenu(el, Object.entries(MODES).map(([k, m]) => ({
      label: m.label, desc: m.desc, on: (st.settings.accessDefault || 'ask') === k,
      run: async () => { const r = await api.setSettings({ accessDefault: k }); if (r && !r.error) st.settings = r; paint(); },
    })), 'right'));
    on('engine', (el) => UI.openMenu(el, ['deepgram', 'edge', 'kokoro'].map((k) => ({
      label: { deepgram: 'Deepgram', edge: 'Edge', kokoro: 'Kokoro' }[k],
      on: (st.settings.voiceEngine || 'edge') === k,
      run: async () => { const r = await api.setSettings({ voiceEngine: k }); if (r && !r.error) st.settings = r; paint(); },
    })), 'right'));
    on('voice', () => UI.voiceSettings(() => { UI.closeModal(); paint(); }));
    on('sign-out', async () => { await api.signOut(); st.user = null; UI.renderAccount(); UI.toast('Signed out.'); paint(); });
    on('sign-in', () => UI.signIn());
    const gp = $('[data-act="gmail-phone"]', body);
    if (gp) {
      api.gmailPhone().then((r) => { gp.checked = !!(r && r.linked); gp.disabled = false; });
      gp.addEventListener('change', async () => {
        gp.disabled = true;
        const r = await api.setGmailPhone(gp.checked);
        gp.checked = !!(r && r.linked);
        gp.disabled = false;
        if (!(r && r.ok)) UI.toast((r && r.error) || 'That did not work.', 'error');
      });
    }
  }

  // ─── Open and close ─────────────────────────────────────────────────────
  function show(id = page) {
    if (!open) {
      const st = S();
      before = st.currentGroup ? { group: st.currentGroup } : st.current ? { bot: st.current } : null;
      if (window.CrewLife) window.CrewLife.hide();
      if (window.CrewBrain) window.CrewBrain.hide();
    }
    open = true;
    page = PAGES[id] ? id : 'general';
    document.body.classList.add('in-settings');
    $('#sideSettings').classList.remove('hidden');
    paintNav();
    paint();
  }
  /** Leave settings mode without going anywhere (something else is opening). */
  function hide() {
    if (!open) return;
    open = false;
    document.body.classList.remove('in-settings');
    $('#sideSettings').classList.add('hidden');
  }
  function leave() {
    const to = before;
    hide();
    if (to && to.group && window.CrewGroups) window.CrewGroups.open(to.group);
    else if (to && to.bot && UI.bot(to.bot)) UI.openBot(to.bot);
    else UI.goHome();
  }
  // Capture phase: this runs before a dialog or menu closes itself, so Escape there never also leaves settings.
  document.addEventListener('keydown', (e) => { if (open && e.key === 'Escape' && !document.querySelector('.modal-back:not(.hidden)') && $('#menu').classList.contains('hidden')) leave(); }, true);

  // ─── The permissions chip in a composer ─────────────────────────────────
  function chipHtml() {
    return `<button class="model-chip access-chip" id="accessBtn" title="How this chat asks before a bot acts">${ICON.shield}<span id="accessLabel">Always ask</span>${ICON.chev}</button>`;
  }
  async function wireChip(key) {
    const btn = $('#accessBtn');
    if (!btn || !api.accessGet) return;
    let acc = { mode: 'ask', always: [] };
    const paintChip = () => {
      $('#accessLabel', btn).textContent = (MODES[acc.mode] || MODES.ask).label;
    };
    try { acc = { mode: 'ask', always: [], ...((await api.accessGet(key)) || {}) }; } catch {}
    paintChip();
    const set = async (patch, said) => {
      try { acc = { ...acc, ...((await api.accessSet(key, patch)) || {}) }; } catch (e) { UI.toast(e.message, 'error'); return; }
      paintChip();
      if (said) UI.toast(said);
    };
    // Just the two ways to ask. What a chat has allowed is listed in Settings, Permissions.
    btn.addEventListener('click', (e) => UI.openMenu(e.currentTarget, [
      // Always ask means every time: what was allowed so far is taken back too.
      { label: MODES.ask.label, desc: MODES.ask.desc, on: acc.mode === 'ask', run: () => set({ mode: 'ask', clearAlways: true }, acc.always.length ? 'It asks every time again.' : '') },
      { label: MODES.once.label, desc: MODES.once.desc, on: acc.mode === 'once', run: () => set({ mode: 'once' }) },
    ]));
  }

  // The way in: a gear next to the account in the sidebar.
  const foot = $('.side-foot');
  if (foot && !$('#settingsBtn')) {
    foot.insertAdjacentHTML('beforeend', `<button class="icon-btn side-gear" id="settingsBtn" aria-label="Settings" title="Settings">${ICON.gear}</button>`);
    $('#settingsBtn').addEventListener('click', () => (open ? leave() : show('general')));
  }

  window.CrewSettings = { show, hide, leave, isOpen: () => open, chipHtml, wireChip, allowedWords };
})();
