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

  // Claude's own mark (the spark), as the Claude app draws it.
  const ICON = '<svg viewBox="0 0 248 248" aria-hidden="true"><path fill="#D97757" d="M52.4285 162.873L98.7844 136.879L99.5485 134.602L98.7844 133.334H96.4921L88.7237 132.862L62.2346 132.153L39.3113 131.207L17.0249 130.026L11.4214 128.844L6.2 121.873L6.7094 118.447L11.4214 115.257L18.171 115.847L33.0711 116.911L55.485 118.447L71.6586 119.392L95.728 121.873H99.5485L100.058 120.337L98.7844 119.392L97.7656 118.447L74.5877 102.732L49.4995 86.1905L36.3823 76.62L29.3779 71.7757L25.8121 67.2858L24.2839 57.3608L30.6515 50.2716L39.3113 50.8623L41.4763 51.4531L50.2636 58.1879L68.9842 72.7209L93.4357 90.6804L97.0015 93.6343L98.4374 92.6652L98.6571 91.9801L97.0015 89.2625L83.757 65.2772L69.621 40.8192L63.2534 30.6579L61.5978 24.632C60.9565 22.1032 60.579 20.0111 60.579 17.4246L67.8381 7.49965L71.9133 6.19995L81.7193 7.49965L85.7946 11.0443L91.9074 24.9865L101.714 46.8451L116.996 76.62L121.453 85.4816L123.873 93.6343L124.764 96.1155H126.292V94.6976L127.566 77.9197L129.858 57.3608L132.15 30.8942L132.915 23.4505L136.608 14.4708L143.994 9.62643L149.725 12.344L154.437 19.0788L153.8 23.4505L150.998 41.6463L145.522 70.1215L141.957 89.2625H143.994L146.414 86.7813L156.093 74.0206L172.266 53.698L179.398 45.6635L187.803 36.802L193.152 32.5484H203.34L210.726 43.6549L207.415 55.1159L196.972 68.3492L188.312 79.5739L175.896 96.2095L168.191 109.585L168.882 110.689L170.738 110.53L198.755 104.504L213.91 101.787L231.994 98.7149L240.144 102.496L241.036 106.395L237.852 114.311L218.495 119.037L195.826 123.645L162.07 131.592L161.696 131.893L162.137 132.547L177.36 133.925L183.855 134.279H199.774L229.447 136.524L237.215 141.605L241.8 147.867L241.036 152.711L229.065 158.737L213.019 154.956L175.45 145.977L162.587 142.787H160.805V143.85L171.502 154.366L191.242 172.089L215.82 195.011L217.094 200.682L213.91 205.172L210.599 204.699L188.949 188.394L180.544 181.069L161.696 165.118H160.422V166.772L164.752 173.152L187.803 207.771L188.949 218.405L187.294 221.832L181.308 223.959L174.813 222.777L161.187 203.754L147.305 182.486L136.098 163.345L134.745 164.2L128.075 235.42L125.019 239.082L117.887 241.8L111.902 237.31L108.718 229.984L111.902 215.452L115.722 196.547L118.779 181.541L121.58 162.873L123.291 156.636L123.14 156.219L121.773 156.449L107.699 175.752L86.304 204.699L69.3663 222.777L65.291 224.431L58.2867 220.768L58.9235 214.27L62.8713 208.48L86.304 178.705L100.44 160.155L109.551 149.507L109.462 147.967L108.959 147.924L46.6977 188.512L35.6182 189.93L30.7788 185.44L31.4156 178.115L33.7079 175.752L52.4285 162.873Z"/></svg>';
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

  // The sign-in page Claude Code printed; main opens it (only that page, see claude-code-desktop.js).
  $r('reopen').addEventListener('click', () => { if (loginUrl) api.claudeCodeOpenLogin(); });
  // Cancel ends the login at once here; main stops `claude auth login` and its children.
  $r('cancel').addEventListener('click', async () => {
    loggingIn = false; loginUrl = '';
    show('reopen', false);
    $r('codeForm').classList.add('hidden');
    card.querySelector('.cc-login-msg').textContent = 'Finish signing in with your Claude account in the browser.';
    msg('');
    paint();
    await api.claudeCodeCancelLogin();
  });
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
      msg(d.ok ? 'Logged in. Ask Wisp to use Claude for your next build.' : d.cancelled ? '' : d.error, !d.ok && !d.cancelled);
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
