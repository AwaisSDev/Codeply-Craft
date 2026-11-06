// Claude Code in Codeply's window (claude-code-desktop.js does the work).
//
// 1. The Claude Code card in Connect Apps:
//      Not installed  -> Install runs Claude Code's official installer in Codeply's terminal
//      Not logged in  -> Log in runs `claude auth login`: the browser opens, the
//                        user signs in with their Claude plan, and Claude Code keeps
//                        the login itself. When the page shows a code instead of
//                        finishing on its own, it is pasted here.
//      Connected      -> the default model and effort, what it may do on its own,
//                        and whether Wisp may use it.
// 2. Subagents, in the Background tasks column: one row per agent. Each agent
//    is one of Wisp's family (its own shape, colour and gear, drawn by wisp.js)
//    whose face follows its work: busy while it works, happy when it is done.
//    A row drops down into the agent's terminal: its live log, and a prompt to
//    message it while it works or send it another round. + New starts one.
// Loaded after app.js and wisp.js; uses their globals (openBgTasks, closeBgTasks,
// renderBgTasks, layoutDock, state, CraftWisp) when they exist.
(() => {
  const api = window.craft;
  if (!api || !api.claudeCodeState) return;

  const h = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ico = (name, cls = 'ico-sm') => (typeof icon === 'function' ? icon(name, cls) : '');

  // Claude's own mark, for the card that connects the Claude account.
  const SPARK = '<svg viewBox="0 0 248 248" aria-hidden="true"><path fill="#D97757" d="M52.4285 162.873L98.7844 136.879L99.5485 134.602L98.7844 133.334H96.4921L88.7237 132.862L62.2346 132.153L39.3113 131.207L17.0249 130.026L11.4214 128.844L6.2 121.873L6.7094 118.447L11.4214 115.257L18.171 115.847L33.0711 116.911L55.485 118.447L71.6586 119.392L95.728 121.873H99.5485L100.058 120.337L98.7844 119.392L97.7656 118.447L74.5877 102.732L49.4995 86.1905L36.3823 76.62L29.3779 71.7757L25.8121 67.2858L24.2839 57.3608L30.6515 50.2716L39.3113 50.8623L41.4763 51.4531L50.2636 58.1879L68.9842 72.7209L93.4357 90.6804L97.0015 93.6343L98.4374 92.6652L98.6571 91.9801L97.0015 89.2625L83.757 65.2772L69.621 40.8192L63.2534 30.6579L61.5978 24.632C60.9565 22.1032 60.579 20.0111 60.579 17.4246L67.8381 7.49965L71.9133 6.19995L81.7193 7.49965L85.7946 11.0443L91.9074 24.9865L101.714 46.8451L116.996 76.62L121.453 85.4816L123.873 93.6343L124.764 96.1155H126.292V94.6976L127.566 77.9197L129.858 57.3608L132.15 30.8942L132.915 23.4505L136.608 14.4708L143.994 9.62643L149.725 12.344L154.437 19.0788L153.8 23.4505L150.998 41.6463L145.522 70.1215L141.957 89.2625H143.994L146.414 86.7813L156.093 74.0206L172.266 53.698L179.398 45.6635L187.803 36.802L193.152 32.5484H203.34L210.726 43.6549L207.415 55.1159L196.972 68.3492L188.312 79.5739L175.896 96.2095L168.191 109.585L168.882 110.689L170.738 110.53L198.755 104.504L213.91 101.787L231.994 98.7149L240.144 102.496L241.036 106.395L237.852 114.311L218.495 119.037L195.826 123.645L162.07 131.592L161.696 131.893L162.137 132.547L177.36 133.925L183.855 134.279H199.774L229.447 136.524L237.215 141.605L241.8 147.867L241.036 152.711L229.065 158.737L213.019 154.956L175.45 145.977L162.587 142.787H160.805V143.85L171.502 154.366L191.242 172.089L215.82 195.011L217.094 200.682L213.91 205.172L210.599 204.699L188.949 188.394L180.544 181.069L161.696 165.118H160.422V166.772L164.752 173.152L187.803 207.771L188.949 218.405L187.294 221.832L181.308 223.959L174.813 222.777L161.187 203.754L147.305 182.486L136.098 163.345L134.745 164.2L128.075 235.42L125.019 239.082L117.887 241.8L111.902 237.31L108.718 229.984L111.902 215.452L115.722 196.547L118.779 181.541L121.58 162.873L123.291 156.636L123.14 156.219L121.773 156.449L107.699 175.752L86.304 204.699L69.3663 222.777L65.291 224.431L58.2867 220.768L58.9235 214.27L62.8713 208.48L86.304 178.705L100.44 160.155L109.551 149.507L109.462 147.967L108.959 147.924L46.6977 188.512L35.6182 189.93L30.7788 185.44L31.4156 178.115L33.7079 175.752L52.4285 162.873Z"/></svg>';

  // ═══ Choices ═══
  const MODEL_FALLBACK = [['default', "Your plan's default"], ['fable', 'Fable (newest)'], ['opus', 'Opus (newest)'], ['sonnet', 'Sonnet (newest)'], ['haiku', 'Haiku (newest)'], ['claude-fable-5-1', 'Fable 5.1'], ['claude-opus-5-5', 'Opus 5.5'], ['claude-sonnet-5-5', 'Sonnet 5.5'], ['claude-haiku-5-5', 'Haiku 5.5']];
  const EFFORT_FALLBACK = [['default', 'Default'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max']];
  let modelChoices = MODEL_FALLBACK;
  let effortChoices = EFFORT_FALLBACK;
  const options = (list, value) => {
    const has = list.some(([v]) => v === value);
    return (has ? list : [...list, [value, value]]).map(([v, l]) => `<option value="${h(v)}"${v === value ? ' selected' : ''}>${h(l)}</option>`).join('');
  };
  const modelGroups = (value) => {
    const latest = modelChoices.filter(([v]) => !/^claude-/.test(v));
    const pinned = modelChoices.filter(([v]) => /^claude-/.test(v));
    const extra = value && !modelChoices.some(([v]) => v === value) ? [[value, value]] : [];
    const o = (l) => l.map(([v, t]) => `<option value="${h(v)}"${v === value ? ' selected' : ''}>${h(t)}</option>`).join('');
    return `${o(latest)}${pinned.length ? `<optgroup label="Pin a version">${o(pinned)}</optgroup>` : ''}${o(extra)}`;
  };
  const effortOptions = (value) => options(effortChoices.map(([v, l]) => [v, v === 'default' ? 'Default effort' : `${l} effort`]), value || 'default');

  // ═══ 1. The Connect Apps card ═══════════════════════════════════════════════
  const list = document.querySelector('#connectAppsBackdrop .connect-apps-list');
  const card = document.createElement('div');
  if (list) {
    card.className = 'app-card cc-card';
    card.id = 'caClaude';
    card.innerHTML = `
      <div class="cc-head">
        <div class="cc-logo">${SPARK}</div>
        <div class="cc-title">
          <div class="cc-name">Claude Code <span class="cc-pill" data-role="badge"><i></i><span>Checking</span></span></div>
          <div class="cc-sub" data-role="sub">Your Claude plan as Codeply's coding agents</div>
        </div>
        <button type="button" class="cc-link hidden" data-role="logout">Log out</button>
      </div>
      <div class="cc-start hidden" data-role="start">
        <button class="cc-primary" data-role="action"><span>Log in with Claude</span></button>
        <button class="cc-link hidden" data-role="recheck">Check again</button>
        <span class="cc-fine">Signs in in your browser. Codeply never sees the login.</span>
      </div>
      <div class="cc-login hidden" data-role="login">
        <div class="cc-login-msg"><span class="cc-spin"></span><span data-role="loginMsg">Finish signing in with your Claude account in the browser.</span></div>
        <div class="cc-login-row">
          <button type="button" class="cc-link hidden" data-role="reopen">Open the sign-in page again</button>
          <button type="button" class="cc-link" data-role="cancel">Cancel</button>
        </div>
        <form class="cc-code hidden" data-role="codeForm">
          <input type="text" autocomplete="off" spellcheck="false" placeholder="Paste the code from the sign-in page">
          <button type="submit" class="cc-primary">Send</button>
        </form>
      </div>
      <div class="cc-opts hidden" data-role="opts">
        <div class="cc-line"><span class="cc-label">Model</span><select class="cc-select" data-role="model"></select></div>
        <div class="cc-line"><span class="cc-label">Effort</span><div class="cc-seg" data-role="effort" role="radiogroup" aria-label="Effort"></div></div>
        <div class="cc-line"><span class="cc-label">On its own</span>
          <div class="cc-seg" data-role="level" role="radiogroup" aria-label="What Claude Code may do">
            <button type="button" data-v="edits" role="radio" title="Edit files, no commands">Edit files</button>
            <button type="button" data-v="dev" role="radio" title="Edit files and run npm, node, git status...">Files + dev</button>
            <button type="button" data-v="full" role="radio" title="Run any command. It still never publishes.">Anything</button>
          </div>
        </div>
        <label class="cc-line cc-switch"><span class="cc-label">Wisp can use it</span><input type="checkbox" data-role="enabled"><i></i></label>
        <button type="button" class="cc-line cc-more" data-role="openPanel"><span class="cc-label" data-role="working">Specialists</span><span class="cc-more-go">Open ${ico('chevron-right', 'ico-xs')}</span></button>
      </div>
      <div class="cc-msg hidden" data-role="msg"></div>`;
    list.prepend(card);
  }

  const $r = (role) => card.querySelector(`[data-role="${role}"]`);
  const show = (role, on) => { const el = $r(role); if (el) el.classList.toggle('hidden', !on); };
  let st = null;
  let loginUrl = '';
  let loggingIn = false;

  function msg(text, bad) {
    const el = $r('msg');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('bad', !!bad);
    show('msg', !!text);
  }

  function paint() {
    if (!list) return;
    const s = st || {};
    if (Array.isArray(s.modelChoices) && s.modelChoices.length) modelChoices = s.modelChoices;
    if (Array.isArray(s.effortChoices) && s.effortChoices.length) effortChoices = s.effortChoices;
    const connected = !!(s.installed && s.loggedIn);
    card.classList.toggle('connected', connected);
    const badge = $r('badge');
    badge.dataset.s = !st ? 'wait' : connected ? 'on' : 'off';
    badge.querySelector('span').textContent = !st ? 'Checking' : !s.installed ? 'Not installed' : connected ? 'Connected' : 'Not connected';
    $r('sub').textContent = connected
      ? [s.email, s.plan ? `${s.plan[0].toUpperCase()}${s.plan.slice(1)} plan` : ''].filter(Boolean).join(' · ') || 'Logged in'
      : "Your Claude plan as Codeply's coding agents";
    show('logout', connected);
    show('start', !connected && !loggingIn && !!st);
    show('login', loggingIn);
    show('opts', connected);
    const btn = $r('action');
    btn.disabled = !st || loggingIn;
    btn.querySelector('span').textContent = !s.installed ? 'Install Claude Code' : 'Log in with Claude';
    if (s.settings) {
      $r('model').innerHTML = modelGroups(s.settings.model);
      $r('effort').innerHTML = effortChoices.map(([v, l]) => `<button type="button" role="radio" data-v="${h(v)}" aria-checked="${v === s.settings.effort}" class="${v === s.settings.effort ? 'on' : ''}">${h(l === 'Extra high' ? 'X-High' : l === 'Default' ? 'Auto' : l)}</button>`).join('');
      card.querySelectorAll('[data-role="level"] button').forEach((b) => { const on = b.dataset.v === s.settings.level; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
      $r('enabled').checked = s.settings.enabled !== false;
    }
    const n = Number(s.working) || 0;
    $r('working').textContent = n ? `Specialists · ${n} running` : 'Specialists';
  }

  async function load(refresh) {
    try { st = await api.claudeCodeState({ refresh: !!refresh }); } catch (e) { msg(e.message, true); }
    loggingIn = !!(st && st.loggingIn);
    paint();
  }

  if (list) {
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
      loggingIn = true; loginUrl = '';
      $r('codeForm').classList.add('hidden');
      paint();
      const r = await api.claudeCodeLogin({});
      if (!r.ok) { loggingIn = false; msg(r.error || 'Could not start the login.', true); paint(); }
    });
    $r('logout').addEventListener('click', async () => {
      msg('');
      const r = await api.claudeCodeLogout();
      if (!r.ok) msg(r.error, true);
      st = r.state || st;
      paint();
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
      $r('loginMsg').textContent = 'Finish signing in with your Claude account in the browser.';
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
      $r('loginMsg').textContent = 'Checking the code…';
      await api.claudeCodeSubmitCode(code);
    });

    const save = async (patch) => { st = await api.claudeCodeSettings(patch); paint(); };
    $r('model').addEventListener('change', (e) => save({ model: e.target.value }));
    $r('effort').addEventListener('click', (e) => { const b = e.target.closest('button[data-v]'); if (b) save({ effort: b.dataset.v }); });
    $r('level').addEventListener('click', (e) => { const b = e.target.closest('button[data-v]'); if (b) save({ level: b.dataset.v }); });
    $r('enabled').addEventListener('change', (e) => save({ enabled: e.target.checked }));
    $r('openPanel').addEventListener('click', () => {
      const close = document.querySelector('#connectAppsBackdrop [data-close], #connectAppsBackdrop .modal-close');
      if (close) close.click(); else document.getElementById('connectAppsBackdrop').classList.add('hidden');
      openPanel();
    });

    // Fresh state each time Connect Apps opens.
    const backdrop = document.getElementById('connectAppsBackdrop');
    new MutationObserver(() => { if (!backdrop.classList.contains('hidden')) load(false); })
      .observe(backdrop, { attributes: true, attributeFilter: ['class'] });
  }

  api.onClaudeCodeLogin((d) => {
    if (!d || !list) return;
    if (d.phase === 'url') {
      loginUrl = d.url;
      show('reopen', true);
    } else if (d.phase === 'code') {
      $r('loginMsg').textContent = 'Signed in? If the page shows a code, paste it here.';
      $r('codeForm').classList.remove('hidden');
    } else if (d.phase === 'done') {
      loggingIn = false;
      $r('loginMsg').textContent = 'Finish signing in with your Claude account in the browser.';
      if (d.state) st = d.state;
      msg(d.ok ? 'Logged in. Ask Wisp to use Claude, or start a subagent in Background tasks.' : d.cancelled ? '' : d.error, !d.ok && !d.cancelled);
      paint();
    }
  });
  load(false);

  // ═══ 2. Subagents (Background tasks column) ═════════════════════════════════
  const tasksPanel = document.getElementById('bgTasksPanel');
  const tasksBody = document.getElementById('bgTasksBody');
  if (!tasksPanel || !tasksBody) return;
  const CHEV = ico('chevron-right', 'ico-xs');
  const section = document.createElement('section');
  section.id = 'bgtSubagents';
  section.className = 'sa hidden';
  section.innerHTML = `
    <div class="sa-head">
      <button type="button" class="bgt-label sa-fold open" aria-expanded="true">${CHEV}<span>Specialists</span><span class="sa-count"></span></button>
      <button type="button" class="sa-new" title="Start a new specialist">${ico('plus', 'ico-xs')}<span>New</span></button>
    </div>
    <div class="sa-newbox hidden"></div>
    <div class="sa-list"></div>`;
  tasksBody.prepend(section);
  const listEl = section.querySelector('.sa-list');
  const newBox = section.querySelector('.sa-newbox');
  let folded = false;

  // The Subagents button beside Background tasks in the top bar.
  const anchor = document.getElementById('terminalToggleBtn');
  const toggle = document.createElement('button');
  toggle.className = 'icon-btn sa-toggle-btn';
  toggle.id = 'subagentsToggleBtn';
  toggle.title = 'Specialists';
  toggle.setAttribute('aria-label', 'Specialists');
  toggle.innerHTML = `${ico('users', 'ico-md')}<span class="sa-toggle-count hidden"></span>`;
  if (anchor) anchor.after(toggle);

  // A face from Wisp's family, mounted once and kept (moods change on it, it is never redrawn).
  const MOOD = { working: 'working', done: 'happy', failed: 'sad', stopped: 'sleepy', idle: 'neutral' };
  function face(look, mood, size) {
    if (!window.CraftWisp) { const s = document.createElement('span'); s.className = 'sa-face-fallback'; s.style.background = (look && look.color) || '#3b82ff'; return s; }
    return window.CraftWisp.avatar({ look: look && look.shape ? look : undefined, mood: mood || 'neutral', size: size || 'sm', interactive: false });
  }
  const setMood = (el, status) => { if (el && el.wisp) el.wisp.setMood(MOOD[status] || 'neutral', true); };
  const dropFace = (el) => { if (el && el.wisp) el.wisp.destroy(); };

  const agents = new Map(); // id -> { ...summary, log: [], item, view, open, order }
  let order = 0;
  const tasksOpen = () => !tasksPanel.classList.contains('hidden');
  const redrawTasks = () => { if (typeof renderBgTasks === 'function') renderBgTasks(); };

  function openPanel(id) {
    if (!tasksOpen() && typeof openBgTasks === 'function') openBgTasks();
    folded = false;
    section.querySelector('.sa-fold').classList.add('open');
    listEl.classList.remove('hidden');
    const a = id && agents.get(id);
    if (a) setOpen(a, true, true);
    else if (!agents.size) showNew(true);
    paintSection();
    (a ? a.item : section).scrollIntoView({ block: 'nearest' });
  }
  // ── Crew lines in the chat: "Nova edited styles.css", live, one per agent ──
  const shortHost = (u) => { try { return new URL(u).host || u; } catch { return String(u || '').replace(/^file:\/\/\/?/, '').split(/[\\/]/).pop(); } };
  function describe(e) {
    if (!e) return '';
    if (e.t === 'tool' && !e.sub) {
      const L = String(e.label || '');
      const file = L.split('/').pop();
      const bm = /^mcp__codeply-browser__browser_(\w+)$/.exec(String(e.name));
      if (bm) {
        const arg = L.replace(/^\w+\s*/, '');
        return { open: `opened ${shortHost(arg)}`, look: 'looked at the page', click: 'clicked on the page', type: `typed ${arg}`, keys: `pressed ${arg}`, scroll: 'scrolled the page', back: 'went back', wait: 'waited for the page' }[bm[1]] || `used the browser`;
      }
      return ({ Read: `read ${file}`, Edit: `edited ${file}`, MultiEdit: `edited ${file}`, Write: `wrote ${file}`, NotebookEdit: `edited ${file}`, Bash: `ran ${L.slice(0, 60)}`, PowerShell: `ran ${L.slice(0, 60)}`, Glob: 'looked through the files', Grep: `searched for ${L.slice(0, 40)}`, WebFetch: `read ${shortHost(L)}`, WebSearch: `searched the web for ${L.slice(0, 40)}`, TodoWrite: 'planned the steps', Task: 'asked a helper', Agent: 'asked a helper' })[e.name] || '';
    }
    if (e.t === 'text') { const s = String(e.text).replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s/)[0]; return s.length > 110 ? `${s.slice(0, 108)}…` : s; }
    if (e.t === 'user' && e.live) return 'got your message';
    return '';
  }
  // ── In the chat: Codeply speaks; the agents show as a crew ──
  // While they work, one row: their faces, how many, and the latest thing one of them did.
  // When they are done, Codeply's answer says what came of it, and a row under it shows
  // who contributed. Each agent's own words stay in its terminal in Background tasks.
  const faceOf = (look, mood) => {
    if (!window.CraftWisp) { const f = document.createElement('span'); f.className = 'crew-dot'; f.style.background = (look && look.color) || 'var(--accent)'; return f; }
    return window.CraftWisp.avatar({ look: look && look.shape ? look : undefined, mood, size: 'xs', interactive: false });
  };
  function crewRow(kind) {
    const el = document.createElement('div');
    el.className = `crew-sum ${kind}`;
    el.innerHTML = '<span class="crew-faces"></span><span class="crew-sum-text"></span><span class="crew-now"></span>';
    el.addEventListener('click', () => { const ids = (el.dataset.ids || '').split(',').filter(Boolean); openPanel(ids[0] || null); });
    el.title = 'Open them in Background tasks';
    return el;
  }
  function paintWorking(el) {
    const ids = (el.dataset.ids || '').split(',').filter(Boolean);
    const done = new Set((el.dataset.done || '').split(',').filter(Boolean));
    const left = ids.filter((x) => !done.has(x)).length;
    el.classList.toggle('all-done', !left);
    const n = left || ids.length;
    el.querySelector('.crew-sum-text').innerHTML = `<b>${n === 1 ? '1 specialist' : `${n} specialists`}</b> ${left ? 'running' : 'done'}`;
  }
  function crewLine(data, column) {
    const id = data.agentId;
    let el = [...column.querySelectorAll('.crew-sum.working')].find((g) => (g.dataset.ids || '').split(',').includes(id)) || null;
    if (!el && data.phase === 'start') {
      // Agents started one after another join the same row.
      const last = column.lastElementChild;
      el = last && last.classList.contains('crew-sum') && last.classList.contains('working') && !last.classList.contains('all-done') ? last : null;
      if (!el) { el = crewRow('working'); column.appendChild(el); }
      const ids = (el.dataset.ids || '').split(',').filter(Boolean);
      if (!ids.includes(id)) {
        ids.push(id);
        el.dataset.ids = ids.join(',');
        const f = faceOf(data.agent && data.agent.look, 'working');
        f.dataset.agent = id;
        f.title = (data.agent && data.agent.name) || '';
        el.querySelector('.crew-faces').appendChild(f);
      }
    }
    if (el && data.phase === 'report') {
      const done = new Set((el.dataset.done || '').split(',').filter(Boolean));
      done.add(id);
      el.dataset.done = [...done].join(',');
      const f = el.querySelector(`.crew-faces > [data-agent="${CSS.escape(id)}"]`);
      if (f && f.wisp) f.wisp.setMood(data.ok ? 'happy' : 'sad', true);
    }
    if (el) paintWorking(el);
    return el;
  }
  function liveCrew(a, entry) {
    const el = [...document.querySelectorAll('.crew-sum.working:not(.all-done)')].find((g) => (g.dataset.ids || '').split(',').includes(a.id));
    if (!el) return;
    const f = el.querySelector(`.crew-faces > [data-agent="${CSS.escape(a.id)}"]`);
    if (f && f.wisp && entry.t === 'tool') f.wisp.talk(500);
  }
  /** The row under Codeply's answer: who contributed. crew: [{ id, name, look }] */
  function contributed(crew) {
    const el = crewRow('contributed');
    const list = (Array.isArray(crew) ? crew : []).filter(Boolean);
    el.dataset.ids = list.map((c) => c.id || '').join(',');
    for (const c of list) { const f = faceOf(c.look, 'happy'); f.title = c.name || ''; el.querySelector('.crew-faces').appendChild(f); }
    el.querySelector('.crew-sum-text').innerHTML = `<b>${list.length === 1 ? '1 specialist' : `${list.length} specialists`}</b> contributed`;
    return el;
  }

  window.CraftClaudePanel = { open: openPanel, count: () => agents.size, crewLine, contributed };

  toggle.addEventListener('click', () => {
    if (tasksOpen() && !section.classList.contains('hidden')) { if (typeof closeBgTasks === 'function') closeBgTasks(); paintSection(); return; }
    const working = [...agents.values()].filter((a) => a.status === 'working').sort((x, y) => y.order - x.order)[0];
    openPanel(working ? working.id : null);
  });
  section.querySelector('.sa-fold').addEventListener('click', (e) => {
    folded = !folded;
    e.currentTarget.classList.toggle('open', !folded);
    e.currentTarget.setAttribute('aria-expanded', String(!folded));
    listEl.classList.toggle('hidden', folded);
  });
  section.querySelector('.sa-new').addEventListener('click', () => showNew(newBox.classList.contains('hidden')));

  function paintSection() {
    const n = agents.size;
    const working = [...agents.values()].filter((a) => a.status === 'working').length;
    section.classList.toggle('hidden', !n && newBox.classList.contains('hidden'));
    section.querySelector('.sa-count').textContent = n ? String(n) : '';
    const count = toggle.querySelector('.sa-toggle-count');
    count.textContent = working ? String(working) : '';
    count.classList.toggle('hidden', !working);
    toggle.classList.toggle('active', tasksOpen() && !section.classList.contains('hidden'));
  }

  // ── The log, line by line ──
  const TOOL_NAMES = { Edit: 'Update', MultiEdit: 'Update', Write: 'Write', Read: 'Read', Bash: 'Bash', PowerShell: 'PowerShell', Glob: 'Search', Grep: 'Search', LS: 'List', WebFetch: 'Fetch', WebSearch: 'Web Search', TodoWrite: 'Update Todos', Task: 'Agent', Agent: 'Agent', NotebookEdit: 'Update' };
  const dur = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`; };
  const SPIN = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
  const VERBS = ['Working', 'Building', 'Crafting', 'Tinkering', 'Wiring', 'Polishing', 'Thinking', 'Composing'];
  // How a finished specialist ended, as a small mark: a green tick, a red cross, a grey stop.
  const statusMark = (st) => {
    const title = { done: 'Done', failed: 'Stopped with an error', stopped: 'Stopped', idle: 'Ready' }[st] || st;
    const svg = st === 'done' ? '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="8" fill="currentColor"/><path d="M4.6 8.3l2.2 2.2 4.6-4.8" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      : st === 'failed' ? '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="8" fill="currentColor"/><path d="M5.4 5.4l5.2 5.2M10.6 5.4l-5.2 5.2" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/></svg>'
      : st === 'stopped' ? '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="8" fill="currentColor"/><rect x="5.4" y="5.4" width="5.2" height="5.2" rx="1.2" fill="#fff"/></svg>'
      : '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
    return `<span class="sa-mark sa-${h(st)}" title="${h(title)}" role="img" aria-label="${h(title)}">${svg}</span>`;
  };
  const STATUS_WORD = { working: '', done: 'Done', failed: 'Error', stopped: 'Stopped', idle: 'Ready' };

  const fmt = (text) => h(text).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  function entryHtml(e) {
    if (e.t === 'user') {
      const who = e.by === 'wisp' ? 'Codeply' : 'You';
      const tag = e.live ? 'while working' : e.queued ? 'next' : e.round > 1 ? `round ${e.round}` : '';
      return `<div class="ccl ccl-user"><span class="ccl-caret">›</span><div class="ccl-body"><div class="ccl-who">${h(who)}${tag ? ` · ${h(tag)}` : ''}</div><div class="ccl-text">${h(e.text)}</div></div></div>`;
    }
    if (e.t === 'text') return `<div class="ccl ccl-say"><span class="ccl-dot"></span><div class="ccl-text">${fmt(e.text)}</div></div>`;
    if (e.t === 'think') return `<details class="ccl ccl-think"><summary>Thinking…</summary><div class="ccl-text">${h(e.text)}</div></details>`;
    if (e.t === 'tool') {
      const bm = /^mcp__codeply-browser__browser_(\w+)$/.exec(String(e.name));
      const name = TOOL_NAMES[e.name] || (bm ? `Browser ${bm[1]}` : String(e.name).replace(/^mcp__[\w-]+__/, ''));
      const out = e.out ? `<div class="ccl-out"><span class="ccl-elbow">⎿</span><div>${h(e.out)}${e.more ? `<span class="ccl-more"> … +${e.more} lines</span>` : ''}</div></div>` : '';
      const exit = e.exitCode !== undefined && e.exitCode !== 0 && e.status === 'fail' ? ` <span class="ccl-exit">exit ${h(e.exitCode)}</span>` : '';
      return `<div class="ccl ccl-tool${e.sub ? ' sub' : ''}" data-s="${h(e.status)}"><span class="ccl-dot"></span><div class="ccl-body"><div class="ccl-call"><b>${h(name)}</b>${e.label ? `<span class="ccl-arg"> ${h(e.label)}</span>` : ''}${exit}</div>${out}</div></div>`;
    }
    if (e.t === 'sys') return `<div class="ccl ccl-sys${e.tone === 'warn' ? ' warn' : ''}">${h(e.text)}</div>`;
    if (e.t === 'done') {
      const bits = [e.ms ? dur(e.ms) : '', e.turns ? `${e.turns} turns` : '', e.files && e.files.length ? `${e.files.length} file${e.files.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');
      const head = e.ok ? 'Done' : e.aborted ? 'Stopped' : 'Did not finish';
      const files = e.files && e.files.length ? `<div class="ccl-files">${e.files.slice(0, 12).map((f) => `<span>${h(String(f).split('/').pop())}</span>`).join('')}${e.files.length > 12 ? `<span>+${e.files.length - 12}</span>` : ''}</div>` : '';
      return `<div class="ccl ccl-done${e.ok ? ' ok' : e.aborted ? ' stop' : ' bad'}"><div class="ccl-done-head"><b>${head}</b>${bits ? `<span>${h(bits)}</span>` : ''}</div>${e.text ? `<div class="ccl-text">${h(e.text)}</div>` : ''}${files}</div>`;
    }
    return '';
  }

  // ── One agent: a row with its face, and the terminal it drops down into ──
  function itemOf(a) {
    if (a.item) return a.item;
    const it = document.createElement('div');
    it.className = 'sa-item';
    it.dataset.id = a.id;
    it.innerHTML = `
      <div class="sa-row">
        <button type="button" class="sa-main" data-toggle>
          <span class="sa-face"></span>
          <span class="sa-text"><span class="sa-top"><span class="sa-name"></span><span class="sa-tag hidden"></span></span><span class="sa-task"></span></span>
        </button>
        <span class="sa-end"></span>
      </div>
      <div class="sa-term hidden"></div>`;
    a.faceEl = face(a.look, MOOD[a.status], 'sm');
    it.querySelector('.sa-face').appendChild(a.faceEl);
    a.item = it;
    listEl.prepend(it); // newest on top
    it.querySelector('.sa-row').addEventListener('click', async (e) => {
      if (e.target.closest('[data-stop]')) { e.target.closest('[data-stop]').disabled = true; api.claudeCodeStop(a.id); return; }
      if (e.target.closest('[data-close]')) { const r = await api.claudeCodeClose(a.id); if (r && r.ok) removeAgent(a.id); return; }
      if (e.target.closest('[data-toggle]')) setOpen(a, !a.open);
    });
    return it;
  }

  function paintRow(a) {
    const it = itemOf(a);
    const working = a.status === 'working';
    it.classList.toggle('working', working);
    it.classList.toggle('open', !!a.open);
    if (a.look && a.look.color) it.style.setProperty('--ag', a.look.color);
    it.querySelector('.sa-name').textContent = a.name;
    const tag = it.querySelector('.sa-tag');
    tag.classList.toggle('hidden', !a.swarm);
    if (a.swarm) tag.textContent = a.swarm.browser ? `swarm of ${a.swarm.size} · browser` : `swarm of ${a.swarm.size}`;
    it.querySelector('.sa-task').textContent = a.task || 'Waiting for a task';
    it.querySelector('.sa-main').title = a.task || a.name;
    it.querySelector('.sa-main').setAttribute('aria-expanded', String(!!a.open));
    const time = a.startedAt ? dur((working ? Date.now() : a.endedAt || Date.now()) - a.startedAt) : '';
    it.querySelector('.sa-end').innerHTML = working
      ? `<span class="sa-time">${h(time)}</span><button type="button" class="sa-stop" data-stop title="Stop" aria-label="Stop ${h(a.name)}"></button>`
      : `${statusMark(a.status)}<button type="button" class="sa-x" data-close title="Remove" aria-label="Remove ${h(a.name)}">${ico('close', 'ico-xs')}</button>`;
    setMood(a.faceEl, a.status);
  }

  function setOpen(a, on, focus) {
    a.open = on;
    paintRow(a);
    const term = a.item.querySelector('.sa-term');
    term.classList.toggle('hidden', !on);
    if (on) {
      if (!a.view) term.appendChild(buildView(a));
      // A terminal needs room: the column widens while one is open.
      if (!tasksPanel.classList.contains('expanded')) { tasksPanel.classList.add('expanded'); if (typeof layoutDock === 'function') layoutDock(); }
      stick(a, true);
      if (focus) setTimeout(() => { const box = a.view.querySelector('textarea'); if (box) box.focus(); }, 40);
    }
  }

  function buildView(a) {
    const v = document.createElement('div');
    v.className = 'ccx';
    v.innerHTML = `
      <div class="ccx-bar">
        <label class="ccp-chip" title="Model for the next round"><select data-act="model"></select></label>
        <label class="ccp-chip" title="Effort for the next round"><select data-act="effort"></select></label>
        <span class="ccx-where"></span>
      </div>
      <div class="ccx-screen" role="log" aria-live="polite">
        <div class="ccp-lines">${a.log.map((e) => `<div data-id="${h(e.id)}">${entryHtml(e)}</div>`).join('')}</div>
        <div class="ccp-working hidden"><span class="ccp-spin">✳</span><span class="ccp-verb">Working…</span><span class="ccp-time"></span></div>
      </div>
      <form class="ccx-input">
        <span class="ccx-prompt">›</span>
        <textarea rows="1" spellcheck="true"></textarea>
        <button type="submit" class="ccx-send" aria-label="Send">${ico('arrow-up')}</button>
      </form>`;
    a.view = v;
    const box = v.querySelector('textarea');
    const grow = () => { box.style.height = 'auto'; box.style.height = `${Math.min(box.scrollHeight, 140)}px`; };
    box.addEventListener('input', grow);
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); v.querySelector('form').requestSubmit(); }
      else if (e.key === 'Escape' && a.status === 'working') { e.preventDefault(); api.claudeCodeStop(a.id); }
    });
    v.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = box.value.trim();
      if (!text) return;
      box.value = ''; grow();
      const r = await api.claudeCodeSend({ agentId: a.id, text, model: a.model, effort: a.effort });
      if (r && r.error) sysNote(a, r.error);
    });
    v.querySelector('.ccx-bar').addEventListener('change', async (e) => {
      const s = e.target.closest('select[data-act]');
      if (!s) return;
      const r = await api.claudeCodeSetAgent({ agentId: a.id, [s.dataset.act]: s.value });
      if (r && r.agent) upsert(r.agent);
    });
    paintView(a);
    return v;
  }

  function paintView(a) {
    const v = a.view;
    if (!v) return;
    const working = a.status === 'working';
    const m = v.querySelector('[data-act="model"]');
    const ef = v.querySelector('[data-act="effort"]');
    if (document.activeElement !== m) m.innerHTML = modelGroups(a.model);
    if (document.activeElement !== ef) ef.innerHTML = effortOptions(a.effort);
    m.disabled = working; ef.disabled = working;
    v.querySelector('.ccx-where').textContent = [a.actualModel ? `on ${a.actualModel}` : '', a.folder].filter(Boolean).join(' · ');
    v.querySelector('.ccx-where').title = a.cwd || '';
    v.classList.toggle('working', working);
    v.querySelector('textarea').placeholder = working ? `Message ${a.name} while it works` : `Send ${a.name} another round`;
    v.querySelector('.ccp-working').classList.toggle('hidden', !working);
  }

  function sysNote(a, text) {
    if (!a.view) return;
    const d = document.createElement('div');
    d.innerHTML = entryHtml({ t: 'sys', tone: 'warn', text });
    a.view.querySelector('.ccp-lines').appendChild(d);
    stick(a, true);
  }
  const screenOf = (a) => a.view && a.view.querySelector('.ccx-screen');
  const nearEnd = (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  function stick(a, force) {
    const el = screenOf(a);
    if (el && (force || nearEnd(el))) el.scrollTop = el.scrollHeight;
  }

  function upsert(s) {
    let a = agents.get(s.id);
    const isNew = !a;
    if (!a) { a = { log: [], item: null, view: null, order: ++order, open: false }; agents.set(s.id, a); }
    Object.assign(a, s);
    paintRow(a);
    paintView(a);
    paintSection();
    if (isNew) redrawTasks();
    return a;
  }

  function removeAgent(id) {
    const a = agents.get(id);
    if (!a) return;
    dropFace(a.faceEl);
    if (a.item) a.item.remove();
    agents.delete(id);
    paintSection();
    redrawTasks();
  }

  // ── + New ──
  let newFace = null;
  function showNew(on) {
    newBox.classList.toggle('hidden', !on);
    section.querySelector('.sa-new').classList.toggle('active', on);
    dropFace(newFace); newFace = null;
    newBox.innerHTML = '';
    if (on) {
      const project = typeof state !== 'undefined' && state ? state.project : '';
      const folder = project ? String(project).split(/[\\/]/).filter(Boolean).pop() : '';
      const conf = (st && st.settings) || { model: 'default', effort: 'default' };
      const ready = st && st.installed && st.loggedIn;
      newBox.innerHTML = `
        <form class="sa-newform">
          <textarea rows="3" placeholder="${ready ? `What should it do in ${h(folder || 'this project')}?` : 'Connect Claude Code first (Connect Apps)'}"></textarea>
          <div class="sa-new-row">
            <span class="sa-new-label">Specialists</span>
            <div class="cc-seg sa-count-seg" data-count>${[1, 2, 3, 4].map((n) => `<button type="button" data-n="${n}" class="${n === 1 ? 'on' : ''}">${n}</button>`).join('')}</div>
            <label class="sa-check"><input type="checkbox" name="browser"><i></i><span>Browser</span></label>
            <input class="sa-new-url hidden" name="url" type="text" placeholder="Start page (optional)" spellcheck="false">
          </div>
          <div class="sa-new-row">
            <label class="ccp-chip"><select name="model">${modelGroups(conf.model)}</select></label>
            <label class="ccp-chip"><select name="effort">${effortOptions(conf.effort)}</select></label>
            <span class="ccp-grow"></span>
            <button type="button" class="cc-link" data-cancel>Cancel</button>
            <button type="submit" class="cc-primary" ${ready && folder ? '' : 'disabled'}><span>Start</span></button>
          </div>
          <div class="sa-new-err">${ready && !folder ? 'Open a project folder first.' : ''}</div>
        </form>`;
      const f = newBox.querySelector('form');
      let count = 1;
      f.querySelector('[data-count]').addEventListener('click', (e) => {
        const b = e.target.closest('button[data-n]');
        if (!b) return;
        count = Number(b.dataset.n);
        f.querySelectorAll('[data-count] button').forEach((x) => x.classList.toggle('on', x === b));
        f.querySelector('textarea').placeholder = count > 1 ? 'One goal for the swarm: they split it between them and coordinate' : f.querySelector('textarea').dataset.one;
      });
      f.querySelector('textarea').dataset.one = f.querySelector('textarea').placeholder;
      f.querySelector('[name="browser"]').addEventListener('change', (e) => f.querySelector('[name="url"]').classList.toggle('hidden', !e.target.checked));
      f.querySelector('[data-cancel]').addEventListener('click', () => showNew(false));
      f.querySelector('textarea').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); f.requestSubmit(); } });
      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        const task = f.querySelector('textarea').value.trim();
        const err = f.querySelector('.sa-new-err');
        if (!task) { err.textContent = 'Write what it should do.'; return; }
        const btn = f.querySelector('button[type="submit"]');
        btn.disabled = true;
        const proj = typeof state !== 'undefined' && state ? state.project : '';
        const browser = f.querySelector('[name="browser"]').checked;
        const r = await api.claudeCodeStartAgent({ task, cwd: proj, model: f.querySelector('[name="model"]').value, effort: f.querySelector('[name="effort"]').value, swarm: count, browser, url: browser ? f.querySelector('[name="url"]').value : '' });
        btn.disabled = false;
        if (!r || !r.ok) { err.textContent = (r && r.error) || 'Could not start it.'; return; }
        showNew(false);
        for (const s of r.agents || []) upsert(s);
        const a = upsert(r.agent);
        setOpen(a, true, true);
      });
      setTimeout(() => f.querySelector('textarea').focus(), 30);
    }
    paintSection();
  }

  // ── Live events from main ──
  api.onClaudeCodeAgent((d) => {
    if (!d) return;
    if (d.kind === 'agent') upsert(d.agent);
    else if (d.kind === 'removed') removeAgent(d.agentId);
    else if (d.kind === 'focus') openPanel(d.agentId);
    else if (d.kind === 'log' || d.kind === 'patch') {
      const a = agents.get(d.agentId);
      if (!a) return;
      const el = screenOf(a);
      const atEnd = el ? nearEnd(el) : true;
      if (d.kind === 'log') {
        a.log.push(d.entry);
        if (a.log.length > 800) a.log.splice(0, a.log.length - 800);
        if (a.view) {
          const div = document.createElement('div');
          div.dataset.id = d.entry.id;
          div.innerHTML = entryHtml(d.entry);
          a.view.querySelector('.ccp-lines').appendChild(div);
        }
        // Its face reacts to what it does: a quick bounce for each file it writes.
        if (d.entry.t === 'tool' && a.faceEl && a.faceEl.wisp) a.faceEl.wisp.talk(600);
        liveCrew(a, d.entry);
      } else {
        const e = a.log.find((x) => x.id === d.id);
        if (e) Object.assign(e, d.patch);
        const div = a.view && a.view.querySelector(`.ccp-lines > [data-id="${d.id}"]`);
        if (div && e) div.innerHTML = entryHtml(e);
        if (e && e.status === 'fail' && a.faceEl && a.faceEl.wisp) { a.faceEl.wisp.setMood('worried', true); setTimeout(() => setMood(a.faceEl, a.status), 1600); }
      }
      if (atEnd) stick(a, true);
    }
  });

  // Times on the rows, and the spinner of each open terminal.
  let tick = 0;
  setInterval(() => {
    tick += 1;
    if (!tasksOpen()) return;
    for (const a of agents.values()) {
      if (a.status !== 'working') continue;
      if (tick % 8 === 0 && a.item) { const t = a.item.querySelector('.sa-time'); if (t) t.textContent = dur(Date.now() - a.startedAt); }
      if (!a.open || !a.view) continue;
      const w = a.view.querySelector('.ccp-working');
      w.querySelector('.ccp-spin').textContent = SPIN[tick % SPIN.length];
      if (tick % 30 === 0 || !w.dataset.verb) w.dataset.verb = VERBS[Math.floor(Math.random() * VERBS.length)];
      w.querySelector('.ccp-verb').textContent = `${w.dataset.verb}…`;
      w.querySelector('.ccp-time').textContent = `${dur(Date.now() - a.startedAt)} · esc to stop`;
    }
  }, 120);

  // Agents already running (the window was reloaded).
  api.claudeCodeAgents().then((r) => {
    if (!r) return;
    if (r.state) { st = st || r.state; if (r.state.modelChoices) modelChoices = r.state.modelChoices; if (r.state.effortChoices) effortChoices = r.state.effortChoices; }
    for (const s of r.agents || []) { const a = upsert({ ...s, log: s.log || [] }); a.log = s.log || []; }
    paintSection();
  }).catch(() => {});
  paintSection();
})();
