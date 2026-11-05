// The Claude Code card in Connect Apps (claude-code-desktop.js does the work).
//   Not installed  -> Install runs Claude Code's official installer in Codeply's terminal
//   Not logged in  -> Log in runs `claude auth login`: the browser opens, the
//                     user signs in with their Claude plan, and Claude Code keeps
//                     the login itself. When the page shows a code instead of
//                     finishing on its own, it is pasted here.
//   Connected      -> the model, what it may do on its own, and whether Wisp may use it.
// Loaded after app.js; uses its globals (openTerminal, addNote) when they exist.
(() => {
  const api = window.craft;
  if (!api || !api.claudeCodeState) return;
  const list = document.querySelector('#connectAppsBackdrop .connect-apps-list');
  if (!list) return;

  const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17l5-5-5-5"/><path d="M12 19h8"/><path d="M17 3.5v4M15 5.5h4"/></svg>';
  const card = document.createElement('div');
  card.className = 'app-card cc-card';
  card.id = 'caClaude';
  card.innerHTML = `
    <div class="app-card-logo cc-logo">${ICON}</div>
    <div class="app-card-body">
      <div class="app-card-top">
        <span class="app-card-name">Claude Code</span>
        <span class="app-card-badge" data-role="badge">Checking…</span>
      </div>
      <div class="app-card-desc">Wisp hands big coding jobs to Claude Code on your own Claude plan, reviews the work, and publishes it with your apps here</div>
      <div class="app-card-status hidden" data-role="status"></div>
      <div class="cc-login hidden" data-role="login">
        <div class="cc-login-msg">Finish signing in with your Claude account in the browser.</div>
        <div class="cc-login-row">
          <button type="button" class="pub-link" data-role="reopen">Open the sign-in page again</button>
          <button type="button" class="pub-link" data-role="cancel">Cancel</button>
        </div>
        <form class="pub-token cc-code hidden" data-role="codeForm">
          <input type="text" autocomplete="off" spellcheck="false" placeholder="Paste the code from the sign-in page">
          <button type="submit">Send</button>
        </form>
      </div>
      <div class="cc-opts hidden" data-role="opts">
        <label>Model
          <select data-role="model">
            <option value="default">Your plan's default</option>
            <option value="opus">Opus</option>
            <option value="sonnet">Sonnet</option>
            <option value="haiku">Haiku</option>
          </select>
        </label>
        <label>It may
          <select data-role="level">
            <option value="edits">Edit files</option>
            <option value="dev">Edit files and run dev commands</option>
            <option value="full">Run anything (never publish)</option>
          </select>
        </label>
        <label class="cc-toggle"><input type="checkbox" data-role="enabled"> Wisp can use it</label>
      </div>
      <div class="cc-msg hidden" data-role="msg"></div>
    </div>
    <div class="cc-actions">
      <button class="btn btn-primary btn-sm app-card-btn" data-role="action">Log in</button>
      <button class="btn btn-secondary btn-sm app-card-btn hidden" data-role="recheck">Check again</button>
    </div>`;
  list.prepend(card);

  const $r = (role) => card.querySelector(`[data-role="${role}"]`);
  const show = (role, on) => $r(role).classList.toggle('hidden', !on);
  let st = null;
  let loginUrl = '';
  let loggingIn = false;

  function msg(text, bad) {
    const el = $r('msg');
    el.textContent = text || '';
    el.classList.toggle('bad', !!bad);
    show('msg', !!text);
  }

  function paint() {
    const s = st || {};
    const connected = !!(s.installed && s.loggedIn);
    card.classList.toggle('connected', connected);
    $r('badge').textContent = !st ? 'Checking…' : !s.installed ? 'Not installed' : connected ? 'Connected' : 'Not connected';
    const who = [s.email, s.plan ? `${s.plan[0].toUpperCase()}${s.plan.slice(1)} plan` : '', s.org].filter(Boolean).join(' · ');
    $r('status').textContent = connected ? (who || 'Logged in') : '';
    show('status', connected);
    show('login', loggingIn);
    show('opts', connected);
    const btn = $r('action');
    btn.disabled = !st || loggingIn;
    btn.textContent = !s.installed ? 'Install' : connected ? 'Log out' : loggingIn ? 'Waiting…' : 'Log in';
    btn.classList.toggle('btn-primary', !connected);
    btn.classList.toggle('btn-secondary', connected);
    btn.classList.toggle('btn-danger-hover', connected);
    if (s.settings) {
      $r('model').value = s.settings.model;
      $r('level').value = s.settings.level;
      $r('enabled').checked = s.settings.enabled !== false;
    }
  }

  async function load(refresh) {
    try { st = await api.claudeCodeState({ refresh: !!refresh }); } catch (e) { msg(e.message, true); }
    loggingIn = !!(st && st.loggingIn);
    paint();
  }

  $r('action').addEventListener('click', async () => {
    if (!st) return;
    msg('');
    if (!st.installed) {
      // The official installer, in Codeply's own terminal, so the user sees what runs.
      if (typeof openTerminal === 'function') {
        await openTerminal();
        setTimeout(() => api.terminalInput(`${st.installCommand}\n`), 400);
        msg('Installing in the terminal below. When it says it is done, press Check again.');
      } else {
        msg(`Install it with: ${st.installCommand}`);
      }
      show('recheck', true);
      return;
    }
    if (st.loggedIn) {
      const r = await api.claudeCodeLogout();
      if (!r.ok) msg(r.error, true);
      st = r.state || st;
      paint();
      return;
    }
    loggingIn = true; loginUrl = '';
    $r('codeForm').classList.add('hidden');
    paint();
    const r = await api.claudeCodeLogin({});
    if (!r.ok) { loggingIn = false; msg(r.error || 'Could not start the login.', true); paint(); }
  });

  $r('recheck').addEventListener('click', async () => {
    msg('Checking…');
    await load(true);
    msg(st && st.installed ? (st.loggedIn ? '' : 'Installed. Now log in.') : 'Not found yet. If the installer finished, restart Codeply so it sees the new PATH.', st && !st.installed);
    show('recheck', !(st && st.installed));
  });

  $r('reopen').addEventListener('click', () => { if (loginUrl) api.openExternal(loginUrl); });
  $r('cancel').addEventListener('click', async () => { await api.claudeCodeCancelLogin(); });
  $r('codeForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $r('codeForm').querySelector('input');
    const code = input.value.trim();
    if (!code) return;
    input.value = '';
    $r('codeForm').classList.add('hidden');
    card.querySelector('.cc-login-msg').textContent = 'Checking the code…';
    await api.claudeCodeSubmitCode(code);
  });

  api.onClaudeCodeLogin((d) => {
    if (!d) return;
    if (d.phase === 'url') {
      loginUrl = d.url;
      show('reopen', true);
    } else if (d.phase === 'code') {
      card.querySelector('.cc-login-msg').textContent = 'Signed in? If the page shows a code, paste it here.';
      $r('codeForm').classList.remove('hidden');
    } else if (d.phase === 'done') {
      loggingIn = false;
      card.querySelector('.cc-login-msg').textContent = 'Finish signing in with your Claude account in the browser.';
      if (d.state) st = d.state;
      msg(d.ok ? 'Logged in. Ask Wisp to use Claude for your next build.' : d.error, !d.ok);
      paint();
    }
  });

  const save = async (patch) => { st = await api.claudeCodeSettings(patch); paint(); };
  $r('model').addEventListener('change', (e) => save({ model: e.target.value }));
  $r('level').addEventListener('change', (e) => save({ level: e.target.value }));
  $r('enabled').addEventListener('change', (e) => save({ enabled: e.target.checked }));

  // Fresh state each time Connect Apps opens.
  const backdrop = document.getElementById('connectAppsBackdrop');
  new MutationObserver(() => { if (!backdrop.classList.contains('hidden')) load(false); })
    .observe(backdrop, { attributes: true, attributeFilter: ['class'] });
  load(false);
})();
