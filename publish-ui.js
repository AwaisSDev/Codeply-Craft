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
  function render(p) {
    if (!p || !p.id || !p.steps) return;
    let card = chatColumn.querySelector(`.pub-card[data-id="${p.id}"]`);
    const fresh = !card;
    if (fresh) {
      card = document.createElement('div');
      card.className = 'pub-card';
      card.dataset.id = p.id;
    }
    const rows = STEPS.map(([key, label]) => {
      const s = p.steps[key] || { status: 'pending' };
      const detail = key === 'live' && p.url
        ? `<button type="button" class="pub-live" data-url="${esc(p.url)}">${esc(p.url.replace(/^https:\/\//, ''))}</button>`
        : esc(s.detail || STATUS_WORD[s.status] || '');
      return `<div class="pub-step ${esc(s.status)}"><span class="pub-dot"></span><span class="pub-name">${label}</span><span class="pub-detail">${detail}</span></div>`;
    }).join('');
    card.innerHTML = `<div class="pub-head">${p.url ? 'Your site is live' : 'Publishing'}</div>${rows}` +
      (p.url ? `<button type="button" class="pub-open" data-url="${esc(p.url)}">Open ${esc(p.url)}</button>` : '');
    card.querySelectorAll('[data-url]').forEach((b) => b.addEventListener('click', () => api.openExternal(b.dataset.url)));
    chatColumn.appendChild(card); // a known card moves down, under the latest step
    if (typeof scrollToBottom === 'function') scrollToBottom();
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
