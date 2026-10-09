// Publishing in the desktop window: the Publish button in the chat top bar,
// the progress card (Database, Vercel, GitHub, Live) drawn from each publish
// tool's meta.publish, the one-click Connect button on a publish_connect
// question, and the token fallback in Connect Apps. Loaded after app.js and
// uses its globals (api, state, chatColumn, esc, sendMessage, addNote,
// scrollToBottom, refreshIntegrations). Tokens go straight to the main
// process and are never read back or shown.
(() => {
  if (!window.craft) return;

  const LABEL = { supabase: 'Supabase', vercel: 'Vercel', github: 'GitHub' };
  const CONNECT = { supabase: () => api.connectSupabase(), vercel: () => api.connectVercel(), github: () => api.connectGithub() };
  const TOKEN_HELP = {
    vercel: 'https://vercel.com/account/settings/tokens',
    supabase: 'https://supabase.com/dashboard/account/tokens',
    github: 'https://github.com/settings/tokens',
  };
  const STEPS = [['database', 'Database'], ['vercel', 'Vercel'], ['github', 'GitHub'], ['live', 'Live']];
  const STATUS_WORD = { pending: 'Waiting', active: 'Working', waiting: 'Needs you', done: 'Done', skipped: 'Skipped', error: 'Problem' };
  const svg = (d) => `<svg viewBox="0 0 24 24">${d}</svg>`;
  const ICON_GLOBE = svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18"/><path d="M12 3a14 14 0 0 0 0 18"/>');
  const ICON_ALERT = svg('<circle cx="12" cy="12" r="9"/><path d="M12 8v5"/><path d="M12 16.5v.01"/>');
  const ICON_COPY = svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>');
  const ICON_CHECK = svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>');
  const ICON_REFRESH = svg('<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/>');
  const ICON_ARROW = svg('<path d="M7 17L17 7"/><path d="M9 7h8v8"/>');
  const SITE = { database: 'Supabase', vercel: 'Vercel', github: 'GitHub' };
  const STEP_ICON = {
    done: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
    active: '<span class="pub-spin sm"></span>',
    waiting: '<i class="pub-wait"></i>',
    pending: svg('<circle cx="12" cy="12" r="7"/>'),
    skipped: svg('<path d="M7 12h10"/>'),
    error: svg('<path d="M7 7l10 10M17 7L7 17"/>'),
  };

  // OAuth not set up in this build: the connect call says so, and the token form is the way in.
  const needsToken = (err) => /client ID|slug|configured/i.test(String(err || ''));

  function tokenForm(name, onDone) {
    const form = document.createElement('form');
    form.className = 'pub-token';
    form.innerHTML = `
      <input type="password" autocomplete="off" spellcheck="false" placeholder="Paste your ${LABEL[name]} access token">
      <button type="submit">Save</button>
      <button type="button" class="pub-link">Get a token</button>
      <div class="pub-token-msg"></div>`;
    const input = form.querySelector('input');
    const msg = form.querySelector('.pub-token-msg');
    form.querySelector('.pub-link').addEventListener('click', () => api.openExternal(TOKEN_HELP[name]));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const token = input.value.trim();
      if (!token) return;
      msg.textContent = 'Checking...';
      const r = await api.connectToken(name, token);
      input.value = '';
      if (!r.ok) { msg.textContent = r.error; return; }
      msg.textContent = `Connected${r.label ? ` as ${r.label}` : ''}.`;
      if (typeof refreshIntegrations === 'function') refreshIntegrations();
      if (onDone) onDone();
    });
    return form;
  }

  // ─── publish_connect question: Connect button, token form if OAuth is not set up ───
  function decorateQuestion(card, q, send) {
    const name = q.connect;
    if (!LABEL[name]) return;
    const box = document.createElement('div');
    box.className = 'pub-connect';
    box.innerHTML = `<button type="button" class="pub-connect-btn">Connect ${LABEL[name]}</button><button type="button" class="pub-link">Use a token instead</button>`;
    const btn = box.querySelector('.pub-connect-btn');
    let form = null;
    const showForm = () => {
      if (form) return;
      form = tokenForm(name, () => send('Connected'));
      box.appendChild(form);
      form.querySelector('input').focus();
    };
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Waiting for the browser...';
      const r = await CONNECT[name]();
      btn.disabled = false;
      btn.textContent = `Connect ${LABEL[name]}`;
      if (r.ok) { send('Connected'); return; }
      if (needsToken(r.error)) showForm();
      else addNote(`${LABEL[name]} connect failed: ${r.error}`, 'error');
    });
    box.querySelector('.pub-link').addEventListener('click', showForm);
    card.querySelector('.q-head').after(box);
  }

  // ─── The progress card ───
  // What the project already has (.codeply/publish.json), read on refresh. It fills in
  // steps an older card never saw, like a database set up in an earlier turn.
  function withSaved(p, saved) {
    if (!saved) return p;
    const steps = { ...p.steps };
    const settled = (k) => ['done', 'active', 'waiting', 'error'].includes((steps[k] || {}).status);
    if (saved.supabase && !settled('database')) steps.database = { status: 'done', detail: saved.supabase.name || 'Supabase', url: `https://supabase.com/dashboard/project/${saved.supabase.ref}` };
    if (saved.vercel && !settled('vercel')) steps.vercel = { status: 'done', detail: saved.vercel.name };
    if (saved.github && saved.github.repo && !settled('github')) steps.github = { status: 'done', detail: saved.github.linked ? `${saved.github.repo}, auto-deploy on` : saved.github.repo, url: `https://github.com/${saved.github.repo}` };
    else if (saved.github && saved.github.choice === 'no' && !settled('github')) steps.github = { status: 'skipped', detail: 'Direct deploy' };
    if (steps.vercel && steps.vercel.status === 'done' && !steps.vercel.url) steps.vercel = { ...steps.vercel, url: 'https://vercel.com/dashboard' };
    if (saved.supabase && steps.database && !steps.database.url) steps.database = { ...steps.database, url: `https://supabase.com/dashboard/project/${saved.supabase.ref}` };
    return { ...p, steps, url: p.url || (saved.vercel && saved.vercel.url) || '' };
  }

  async function refreshCard(card) {
    if (!card || !card._p || !api.publishState || typeof state === 'undefined' || !state.project) return;
    card.classList.add('refreshing');
    const minSpin = new Promise((r) => setTimeout(r, 700)); // reading the file is instant; let the spin be seen
    try {
      const r = await api.publishState(state.project);
      if (r && r.ok) card._saved = r;
    } catch {}
    await minSpin;
    card.classList.remove('refreshing');
    if (card.isConnected) render(card._p, true);
  }

  function render(p, inPlace) {
    if (!p || !p.id || !p.steps) return;
    // One card per chat: publishing again reuses it and moves it down to the latest turn.
    let card = chatColumn.querySelector('.pub-card');
    chatColumn.querySelectorAll('.pub-card').forEach((c) => { if (c !== card) c.remove(); });
    if (!card) {
      card = document.createElement('div');
      card.className = 'pub-card';
    }
    if (card.dataset.id !== p.id) delete card.dataset.open;
    if (card.dataset.id !== p.id) card._saved = null;
    card.dataset.id = p.id;
    card._p = p;
    const busy = Object.values(p.steps).some((x) => x && (x.status === 'active' || x.status === 'waiting'));
    if (!busy) p = withSaved(p, card._saved);
    const live = !!p.url;
    const raw = STEPS.filter(([key]) => key !== 'live').map(([key, label]) => ({ key, label, ...(p.steps[key] || { status: 'pending' }) }));
    // Once the site is live, a step nobody started was simply not part of this publish.
    const steps = raw.map((x) => (live && x.status === 'pending' ? { ...x, status: 'skipped', detail: 'Not set up' } : x));
    const failed = steps.find((s) => s.status === 'error');
    const current = steps.find((s) => s.status === 'active' || s.status === 'waiting');
    const host = live ? p.url.replace(/^https?:\/\//, '').replace(/\/$/, '') : '';
    const title = live ? host : failed ? 'Publishing stopped' : 'Publishing your site';
    const sub = live ? 'Live' : failed ? `${failed.label}: ${failed.detail || 'something went wrong'}`
      : current ? `${current.label}: ${current.detail || STATUS_WORD[current.status]}` : 'Getting ready';
    const words = (s) => s.detail || STATUS_WORD[s.status] || '';
    const chips = steps.map((s) => `<button type="button" class="pub-chip ${esc(s.status)}${card.dataset.open === s.key ? ' open' : ''}" data-step="${s.key}" ` +
      `title="${esc(s.label + ': ' + words(s))}">${STEP_ICON[s.status] || STEP_ICON.pending}${esc(s.label)}</button>`).join('');
    // Errors are always spelled out; any other step shows its detail when its chip is clicked.
    const note = (s, cls) => `<div class="pub-note ${cls}"><span><b>${esc(s.label)}</b> ${esc(words(s))}</span>` +
      (s.url ? `<button type="button" class="pub-note-open" data-url="${esc(s.url)}">Open in ${SITE[s.key]}${ICON_ARROW}</button>` : '') + '</div>';
    const opened = steps.find((s) => s.key === card.dataset.open && s.status !== 'error');
    const notes = steps.filter((s) => s.status === 'error' && (live || s !== failed))
      .map((s) => note(s, 'error')).join('') + (opened ? note(opened, '') : '');
    card.classList.toggle('live', live);
    card.classList.toggle('failed', !!failed && !live);
    card.innerHTML =
      `<div class="pub-top">
        <span class="pub-tile">${live ? ICON_GLOBE : failed ? ICON_ALERT : '<span class="pub-spin"></span>'}</span>
        <span class="pub-text"><span class="pub-title">${esc(title)}</span>
          <span class="pub-sub">${live ? '<i class="pub-ready"></i>' : ''}${esc(sub)}</span></span>
        ${!busy ? `<span class="pub-actions">
          <button type="button" class="pub-icon-btn pub-refresh" title="Refresh" aria-label="Refresh">${ICON_REFRESH}</button>${live ? `
          <button type="button" class="pub-icon-btn" data-copy="${esc(p.url)}" title="Copy link" aria-label="Copy link">${ICON_COPY}</button>
          <button type="button" class="pub-visit" data-url="${esc(p.url)}">Visit${ICON_ARROW}</button>` : ''}</span>` : ''}
      </div>
      <div class="pub-chips">${chips}</div>${notes}`;
    card.querySelectorAll('[data-url]').forEach((b) => b.addEventListener('click', () => api.openExternal(b.dataset.url)));
    card.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => {
      card.dataset.open = card.dataset.open === b.dataset.step ? '' : b.dataset.step;
      render(card._p, true);
    }));
    card.querySelector('.pub-refresh')?.addEventListener('click', () => refreshCard(card));
    card.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(b.dataset.copy); } catch { return; }
      b.innerHTML = ICON_CHECK;
      b.classList.add('copied');
      setTimeout(() => { b.innerHTML = ICON_COPY; b.classList.remove('copied'); }, 1400);
    }));
    if (inPlace) return;
    chatColumn.appendChild(card); // a known card moves down, under the latest step
    if (typeof scrollToBottom === 'function') scrollToBottom();
    if (!busy && !card._saved) refreshCard(card);
  }

  // ─── Publish button in the chat top bar ───
  function addPublishButton() {
    const bar = document.querySelector('#viewChat .topbar-icons');
    if (!bar || bar.querySelector('.pub-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'pub-btn';
    btn.type = 'button';
    btn.title = 'Publish this project to the web';
    btn.textContent = 'Publish';
    btn.addEventListener('click', () => {
      if (state.running) { addNote('Wait for the current reply to finish, then publish.', 'warn'); return; }
      sendMessage('Publish this website and give me the live link.');
    });
    bar.prepend(btn);
  }

  // ─── Token fallback in Connect Apps ───
  function addTokenLinks() {
    for (const [id, name] of [['caVercel', 'vercel'], ['caSupabase', 'supabase'], ['caGithub', 'github']]) {
      const row = document.getElementById(id);
      const body = row && row.querySelector('.app-card-body');
      if (!body || body.querySelector('.pub-link')) continue;
      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'pub-link';
      link.textContent = 'Use a token instead';
      link.addEventListener('click', () => {
        if (body.querySelector('.pub-token')) return;
        body.appendChild(tokenForm(name, () => body.querySelector('.pub-token')?.remove()));
      });
      body.appendChild(link);
    }
  }

  addPublishButton();
  addTokenLinks();
  window.CraftPublish = { render, decorateQuestion };
})();
