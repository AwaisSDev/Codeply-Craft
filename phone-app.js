// Codeply phone: the screens around the chat (phone.js), shaped like ChatGPT,
// Claude and DeepSeek. Chat is the app; the sidebar opens Tasks (Claude's
// agent list: All / Needs you / Running / Done, with Allow right on the card),
// Settings (account, usage, your PC, permissions, model, appearance), Usage
// and Permissions. Sign in or create an account, then onboarding.
// Every screen is drawn from plain data: real data (CraftPhone) and the
// preview (?preview=<screen>) share the code.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const P = () => window.CraftPhone || {};
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const W = () => window.CraftWisp;
  const svg = (d, w = 20) => `<svg viewBox="0 0 24 24" width="${w}" height="${w}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const I = {
    chev: '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>',
    check: '<svg class="check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7"/></svg>',
    pc: svg('<rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M8.5 20h7M12 16.5V20"/>'),
    cloud: svg('<path d="M7 18a4.5 4.5 0 0 1-.5-8.97A6 6 0 0 1 18 9.5a4 4 0 0 1 0 8.5Z"/>'),
    shield: svg('<path d="M12 3.5 19 6v5.5c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6Z"/>'),
    spark: svg('<path d="M12 4v4M12 16v4M4 12h4M16 12h4M6.3 6.3l2.4 2.4M15.3 15.3l2.4 2.4M6.3 17.7l2.4-2.4M15.3 8.7l2.4-2.4"/>'),
    bell: svg('<path d="M6.5 16v-5a5.5 5.5 0 0 1 11 0v5l1.5 2h-14Z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>'),
    sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/>'),
    chart: svg('<path d="M5 19V11M12 19V5M19 19v-6"/>'),
    design: svg('<path d="M4 20l4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10Z"/><path d="M13.5 7.5l3 3"/>'),
    out: svg('<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l-4-4 4-4M6 12h10"/>'),
    trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
    hand: svg('<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V11M11 10V4.5a1.5 1.5 0 0 1 3 0V11M14 10.5V6a1.5 1.5 0 0 1 3 0v8a6 6 0 0 1-6 6h-.5a6 6 0 0 1-4.6-2.2L3.5 14.6a1.5 1.5 0 0 1 2.2-2L8 15"/>', 18),
    done: svg('<path d="M5 12.5l4.5 4.5L19 7"/>', 18),
    x: svg('<path d="M7 7l10 10M17 7 7 17"/>', 14),
    agent: svg('<path d="M8.5 8 4.5 12l4 4M15.5 8l4 4-4 4"/>', 16),
    copy: svg('<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>'),
    speak: svg('<path d="M4 9.5v5h3.5L12 19V5L7.5 9.5Z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11"/>'),
    up: svg('<path d="M7 11v9H4v-9ZM7 11l4-7a2 2 0 0 1 3 2l-1 4h5.5a2 2 0 0 1 2 2.4l-1.3 6A2 2 0 0 1 17.2 20H7"/>'),
    down: svg('<path d="M7 13V4H4v9ZM7 13l4 7a2 2 0 0 0 3-2l-1-4h5.5a2 2 0 0 0 2-2.4l-1.3-6A2 2 0 0 0 17.2 4H7"/>'),
    again: svg('<path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v4h-4"/>'),
    share: svg('<path d="M12 15V4M8 8l4-4 4 4M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"/>'),
  };
  const ago = (t) => {
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return 'now'; if (s < 3600) return `${Math.round(s / 60)}m`; if (s < 86400) return `${Math.round(s / 3600)}h`;
    return new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
  };
  const clock = (ms) => { const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`; };
  const short = (n) => { n = Number(n) || 0; const f = (x) => (x >= 100 ? Math.round(x) : x.toFixed(1).replace(/\.0$/, '')); return n >= 1e9 ? f(n / 1e9) + 'B' : n >= 1e6 ? f(n / 1e6) + 'M' : n >= 1e3 ? f(n / 1e3) + 'K' : String(Math.round(n)); };
  const sec = (title, end = '') => `<div class="sec"><h2>${esc(title)}</h2>${end}</div>`;
  const open = (id) => { const el = $(id); if (el) el.classList.remove('hidden'); };

  // ─── Tasks (Claude's agent list) ──────────────────────────────────────────
  /** data: { filter, tasks: [{ id, title, state: 'needs'|'running'|'done'|'failed', where, cloud, step, since, at, ask: { text, cmd, isCmd, danger, always } }] } */
  let taskFilter = 'all';
  function renderTasks(data) {
    const body = $('tasksBody');
    if (!body) return;
    const tasks = data.tasks || [];
    const n = (s) => tasks.filter((t) => t.state === s).length;
    const shown = taskFilter === 'all' ? tasks : tasks.filter((t) => t.state === taskFilter);
    const chip = (k, label, count) => `<button type="button" data-filter="${k}" class="${taskFilter === k ? 'on' : ''}">${label}${count ? `<span>${count}</span>` : ''}</button>`;
    body.innerHTML = `<div class="chips">${chip('all', 'All', tasks.length)}${chip('needs', 'Needs you', n('needs'))}${chip('running', 'Running', n('running'))}${chip('done', 'Done', 0)}</div>`
      + shown.map((t) => {
        const ico = t.state === 'needs' ? `<span class="task-ico needs">${I.hand}</span>` : t.state === 'running' ? '<span class="task-ico"><span class="spinner"></span></span>' : `<span class="task-ico done">${I.done}</span>`;
        const sub = t.state === 'running' && t.step ? `<code>${esc(t.step)}</code>` : `${t.cloud ? I.cloud : I.pc}<span>${esc(t.where || '')}</span>`;
        const when = t.state === 'running' && t.since ? clock(Date.now() - t.since) : ago(t.at || Date.now());
        const ask = t.state === 'needs' && t.ask ? `<div class="task-ask">${esc(t.ask.text)}${t.ask.cmd ? `<pre>${t.ask.isCmd ? '<span>$ </span>' : ''}${esc(t.ask.cmd)}</pre>` : ''}</div>
          ${t.ask.danger ? '<div class="task-risk">Outside the project or hard to undo</div>' : ''}
          <button type="button" class="btn btn-outline" data-ap="${esc(t.id)}" data-v="once">Allow</button>
          <div class="task-more">${t.ask.always ? `<button type="button" data-ap="${esc(t.id)}" data-v="always">${esc(t.ask.always)}</button>` : ''}<button type="button" class="deny" data-ap="${esc(t.id)}" data-v="reject">Deny</button></div>` : '';
        return `<div class="task" data-open="${esc(t.id)}"><div class="task-top">${ico}<div class="task-main"><b>${esc(t.title)}</b><small>${sub}</small></div><time>${esc(when)}</time></div>${ask}</div>`;
      }).join('') + (shown.length ? '' : '<p class="note" style="text-align:center;margin-top:40px">Nothing here.</p>');
    body.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => { taskFilter = b.dataset.filter; renderTasks(data); }));
  }

  // ─── Settings ─────────────────────────────────────────────────────────────
  const PERM_TITLE = { ask: 'Ask first', edits: 'Accept edits', full: 'Full access' };
  /** data: { name, email, usage: { today, yesterday, days }, pc: { name, online, projects }, perm, model, theme, notifications } */
  function renderYou(data) {
    const v = $('youView');
    if (!v) return;
    const u = data.usage || {};
    const days = u.days || [];
    const peak = Math.max(1, ...days);
    const change = u.yesterday ? Math.round((u.today - u.yesterday) / u.yesterday * 100) : null;
    const li = (act, ico, title, val = '', cls = '') => `<button type="button" class="li ${cls}" data-act="${act}"><span class="li-ico">${ico}</span><span class="li-main"><b>${esc(title)}</b></span>${val ? `<span class="val">${val}</span>` : ''}${cls ? '' : I.chev}</button>`;
    v.innerHTML = `
      <div class="me"><span class="me-av">${esc((data.name || data.email || 'C')[0].toUpperCase())}</span><b>${esc(data.name || 'You')}</b><small>${esc(data.email || '')}</small></div>
      ${sec('Usage', '<button type="button" data-act="usage">Details</button>')}
      <div class="usage" data-act="usage">
        <small>Tokens today</small>
        <div class="big">${short(u.today)}</div>
        <div class="delta">${change == null ? '' : `<b class="${change < 0 ? 'down' : ''}">${change < 0 ? '↓' : '↑'} ${Math.abs(change)}%</b>`}<span>vs yesterday</span></div>
        <div class="bars">${days.map((n, i) => `<i class="${i === days.length - 1 ? 'today' : ''}" style="height:${Math.max(4, Math.round(n / peak * 100))}%"></i>`).join('')}</div>
        <div class="axis"><span>${days.length} days</span><span>Today</span></div>
      </div>
      ${sec('Your agent')}
      <div class="list">
        ${li('pc', I.pc, (data.pc && data.pc.name) || 'Your PC', `<span class="status${data.pc && data.pc.online ? ' on' : ''}"><i></i>${data.pc && data.pc.online ? 'Online' : 'Offline'}</span>`)}
        ${li('perm', I.shield, 'Permissions', esc(PERM_TITLE[data.perm] || 'Ask first'))}
        ${li('model', I.spark, 'Model', esc(data.model || 'Haze 2'))}
        ${li('cloud', I.cloud, 'Cloud')}
        ${li('design', I.design, 'Design')}
      </div>
      ${sec('App')}
      <div class="list">
        ${li('bell', I.bell, 'Notifications', esc(data.notifications || 'Off'))}
        <div class="li" style="flex-wrap:wrap"><span class="li-ico">${I.sun}</span><span class="li-main"><b>Appearance</b></span>
          <div class="seg wide" id="youTheme" style="width:100%;margin:6px 0 2px">${['system', 'light', 'dark'].map((t) => `<button type="button" data-theme="${t}" class="${data.theme === t ? 'on' : ''}">${t === 'system' ? 'System' : t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div></div>
      </div>
      ${sec('Account')}
      <div class="list">${li('signout', I.out, 'Sign out', '', 'danger')}${li('delete', I.trash, 'Delete account', '', 'danger')}</div>
      <p class="note" style="text-align:center;margin-top:18px">Codeply for phone</p>`;
  }

  // ─── Usage ────────────────────────────────────────────────────────────────
  /** data: { today, week, month, total, days: [n...30], models: [{ name, tokens, calls }] } */
  function renderUsage(data) {
    const body = $('usageBody');
    if (!body) return;
    const days = data.days || [];
    const peak = Math.max(1, ...days);
    const models = data.models || [];
    const top = Math.max(1, ...models.map((m) => m.tokens));
    body.innerHTML = `
      <div class="usage" style="margin-top:8px"><small>Last 30 days</small><div class="big">${short(data.month)} tokens</div>
        <div class="delta"><span>${short(data.today)} today · ${short(data.week)} this week · ${short(data.total)} all time</span></div>
        <div class="bars" style="height:120px">${days.map((n, i) => `<i class="${i === days.length - 1 ? 'today' : ''}" style="height:${Math.max(3, Math.round(n / peak * 100))}%"></i>`).join('')}</div>
        <div class="axis"><span>30 days ago</span><span>Today</span></div>
        <div class="seg wide"><button type="button">7D</button><button type="button">14D</button><button type="button" class="on">30D</button><button type="button">1Y</button></div></div>
      ${sec('By model', '<span>30 days</span>')}
      <div class="list">${models.map((m) => `<div class="li" style="flex-direction:column;align-items:stretch;gap:0"><div style="display:flex;justify-content:space-between;gap:8px"><b style="font-size:16px;font-weight:500">${esc(m.name)}</b><span style="color:var(--muted);font-size:15px">${short(m.tokens)}</span></div><small style="color:var(--muted);font-size:13.5px">${short(m.calls)} calls</small><div class="meter"><i style="width:${Math.round(m.tokens / top * 100)}%"></i></div></div>`).join('') || '<div class="li" style="color:var(--muted)">No usage yet.</div>'}</div>
      <p class="note">Counts from Craft, Crew, the CLI, Cloud and this phone. Counts only, never what you wrote. Chat and Code share one daily limit; your own models use your own keys.</p>`;
  }

  // ─── Permissions ──────────────────────────────────────────────────────────
  const MODES = [
    ['ask', 'Ask first', 'You approve every edit and command.', false],
    ['edits', 'Accept edits', 'File edits in the project run on their own. Commands, deploys and messages still ask.', true],
    ['full', 'Full access', 'Nothing asks. Your blocked rules still hold.', false],
  ];
  const modeList = (on) => `<div class="list">${MODES.map(([v, t, s, rec]) => `<button type="button" class="li${on === v ? ' on' : ''}" data-mode="${v}"><span class="li-main"><b>${t}${rec ? '<span class="rec">Recommended</span>' : ''}</b><small class="wrap">${s}</small></span>${I.check}</button>`).join('')}</div>`;
  function ruleLabel(r) {
    const i = r.indexOf(':');
    const tool = i < 0 ? r : r.slice(0, i);
    return [{ run: 'Command', edit_file: 'Edit', write_file: 'Create', apply_patch: 'Patch' }[tool] || tool.replace(/_/g, ' '), i < 0 ? 'everything' : r.slice(i + 1)];
  }
  /** data: { perm, online, allow: [rule], deny: [rule] } */
  function renderPerms(data) {
    const body = $('permsBody');
    if (!body) return;
    const rules = (list, which) => list.map((r) => { const [k, w] = ruleLabel(r); return `<div class="li" style="min-height:48px"><span class="rule-kind">${esc(k)}</span><span class="rule-pat">${esc(w)}</span><button type="button" class="rule-x" data-rm="${esc(which)}|${esc(r)}" aria-label="Remove ${esc(r)}">${I.x}</button></div>`; }).join('');
    const add = (which, ph) => `<div class="rule-add"><select aria-label="Kind"><option value="run">Command</option><option value="edit_file">Edit</option><option value="write_file">Create</option></select><input placeholder="${ph}" aria-label="Pattern" autocapitalize="off" spellcheck="false"><button type="button" data-add="${which}">Add</button></div>`;
    body.innerHTML = `
      ${sec('On your PC')}${modeList(data.perm)}
      <p class="note">Risky commands always ask, whatever you pick.</p>
      ${sec('Always allowed', `<span>${(data.allow || []).length}</span>`)}
      <div class="list">${rules(data.allow || [], 'allow')}${add('allow', 'npm test')}</div>
      ${sec('Blocked', `<span>${(data.deny || []).length}</span>`)}
      <div class="list">${rules(data.deny || [], 'deny')}${add('deny', 'git push*')}</div>
      <p class="note">${data.online ? 'Rules live on your PC and cover every project. Blocked wins over everything. "Always allow" on an approval only covers that chat.' : 'Your PC is offline. Its rules show here once it is online.'}</p>`;
  }

  // ─── Onboarding ───────────────────────────────────────────────────────────
  function renderOnboard(step, data = {}) {
    const box = $('onboard');
    if (!box) return;
    const dots = `<div class="ob-dots">${[0, 1, 2, 3].map((i) => `<i class="${i === step ? 'on' : ''}"></i>`).join('')}</div>`;
    let body = ''; let actions = '';
    if (step === 0) {
      body = `<span class="ob-wisp"></span><h1>Hi${data.name ? ` ${esc(data.name)}` : ''}, I'm Codeply.</h1><p>Ask me anything, or give me real work. I build on your PC, keep going in the cloud when it's off, and ask before anything risky.</p>`;
      actions = '<button type="button" class="btn btn-primary" data-ob="next">Continue</button>';
    } else if (step === 1) {
      body = `<h1>Connect your PC</h1><p>Your agent works on your own computer, with your files and tools.</p>
        <div class="list">
          <div class="li"><span class="ob-num">1</span><span class="li-main"><b>Get Codeply for your computer</b><small>codeply.app/download</small></span></div>
          <div class="li"><span class="ob-num">2</span><span class="li-main"><b>Sign in with this account</b><small>${esc(data.email || 'The email you just used')}</small></span></div>
          <div class="li"><span class="ob-num">3</span><span class="li-main"><b>Leave it open</b><small>This phone finds it on any network</small></span></div>
        </div>
        <div class="ob-found${data.pcOnline ? ' ok' : ''}">${data.pcOnline ? `${I.done} Found ${esc(data.pcName || 'your PC')}` : '<span class="spinner"></span> Looking for your PC'}</div>`;
      actions = `<button type="button" class="btn btn-primary" data-ob="next">${data.pcOnline ? 'Continue' : 'Continue without it'}</button><button type="button" class="btn btn-ghost" data-ob="cloud">Use the cloud instead</button>`;
    } else if (step === 2) {
      body = `<h1>How should I ask?</h1><p>You can change this any time in Settings.</p>${modeList(data.perm || 'edits')}`;
      actions = '<button type="button" class="btn btn-primary" data-ob="next">Continue</button>';
    } else {
      body = '<h1>A tap when I need you</h1><p>A notification when a task needs your OK or finishes, and the reminders you ask for. Nothing else.</p>';
      actions = '<button type="button" class="btn btn-primary" data-ob="notify">Allow notifications</button><button type="button" class="btn btn-ghost" data-ob="done">Not now</button>';
    }
    box.innerHTML = `<div class="ob-top">${dots}<button type="button" class="ob-skip" data-ob="done">Skip</button></div><div class="ob-body">${body}</div><div class="ob-actions">${actions}</div>`;
    const face = box.querySelector('.ob-wisp');
    if (face && W()) W().mount(face, { size: 'lg' });
    box.classList.remove('hidden');
  }

  // ─── Sign in / create account ─────────────────────────────────────────────
  function setAuthTab(t) {
    $('loginForm').classList.toggle('hidden', t !== 'in');
    $('signupForm').classList.toggle('hidden', t !== 'up');
    $('authTitle').textContent = t === 'up' ? 'Create your account' : 'Welcome back';
    $('authSub').textContent = t === 'up' ? 'One account for your phone, your PC and the CLI.' : 'Sign in with the same account as Codeply on your computer.';
    const sw = $('authSwitch');
    if (sw) sw.innerHTML = t === 'up' ? 'Have an account? <button type="button" data-to="in">Sign in</button>' : 'New to Codeply? <button type="button" data-to="up">Create an account</button>';
  }

  // ─── Under every answer: copy, read aloud, good, bad, again, share ────────
  function addActions() {
    const f = $('feed');
    if (!f) return;
    f.querySelectorAll(':scope > .msg.agent').forEach((m) => {
      if (m.nextElementSibling && m.nextElementSibling.classList.contains('msg-actions')) return;
      const row = document.createElement('div');
      row.className = 'msg-actions';
      row.innerHTML = [['copy', 'Copy'], ['speak', 'Read aloud'], ['up', 'Good answer'], ['down', 'Bad answer'], ['again', 'Try again'], ['share', 'Share']]
        .map(([k, l]) => `<button type="button" data-msg="${k}" aria-label="${l}">${I[k]}</button>`).join('');
      row.querySelector('[data-msg="copy"]').addEventListener('click', () => { try { navigator.clipboard.writeText(m.innerText); } catch {} });
      m.after(row);
    });
  }

  // ─── Shell ────────────────────────────────────────────────────────────────
  function shell() {
    document.body.dataset.view = 'chat';
    // Sign in: Wisp above the serif line, a line to switch forms.
    const inner = document.querySelector('#signin .signin-inner');
    if (inner && !inner.querySelector('.signin-face')) {
      const f = document.createElement('div'); f.className = 'signin-face'; const e = document.createElement('div'); f.appendChild(e);
      inner.insertBefore(f, inner.firstChild);
      if (W()) W().mount(e, { size: 'lg' });
      const sw = document.createElement('p'); sw.className = 'auth-switch'; sw.id = 'authSwitch';
      inner.appendChild(sw);
      sw.addEventListener('click', (ev) => { const b = ev.target.closest('[data-to]'); if (b) setAuthTab(b.dataset.to); });
      setAuthTab('in');
    }
    // Composer: an "Agent" chip next to +, like DeepSeek's Think and Search.
    const row = document.querySelector('#composer .box-row');
    if (row && !$('agentChip')) {
      row.querySelector('#plusBtn').insertAdjacentHTML('afterend', `<button type="button" class="chip-btn" id="agentChip">${I.agent}<span>Agent</span></button>`);
      $('agentChip').addEventListener('click', () => { if (P().openProjectPicker) P().openProjectPicker({ anchor: $('agentChip') }); });
      // The project the message goes to (phone.js's chip above the text) shows on this one chip instead.
      const sync = () => {
        const on = !$('ctxRow').classList.contains('hidden');
        const name = ($('projectChipName').textContent || '').trim();
        const mode = !$('codeModeChip').classList.contains('hidden') ? ($('codeModeName').textContent || '').trim() : '';
        $('agentChip').classList.toggle('on', on);
        $('agentChip').querySelector('span').textContent = on && name && name !== 'Project' ? `${name}${mode ? ` · ${mode}` : ''}` : 'Agent';
      };
      new MutationObserver(sync).observe($('ctxRow'), { attributes: true, subtree: true, childList: true, characterData: true });
      sync();
    }
    // Sidebar: Tasks, and the account row opens Settings.
    const t = $('drawerTasks');
    if (t) t.addEventListener('click', () => { if (P().closeDrawer) P().closeDrawer(); open('tasksPanel'); });
    const me = $('drawerMe');
    if (me) me.addEventListener('click', () => { if (P().closeDrawer) P().closeDrawer(); open('settingsPanel'); });
    document.querySelectorAll('[data-close-panel]').forEach((b) => b.addEventListener('click', () => b.closest('.panel').classList.add('hidden')));
    document.addEventListener('click', (ev) => {
      const a = ev.target.closest('#youView [data-act]');
      if (!a) return;
      if (a.dataset.act === 'usage') open('usagePanel');
      else if (a.dataset.act === 'perm') open('permsPanel');
    });
    const f = $('feed');
    if (f) new MutationObserver(addActions).observe(f, { childList: true });
  }

  // ─── Preview: every screen with sample data (?preview=<screen>) ───────────
  const now = Date.now();
  const SAMPLE = {
    tasks: { tasks: [
      { id: 't1', title: 'Fix checkout total', state: 'needs', where: 'shop-web · Awais-PC', at: now - 120e3, ask: { text: 'I need to install a newer Stripe package before the tests can pass.', cmd: 'npm install stripe@14 && npm test', isCmd: true, always: 'Always allow npm install' } },
      { id: 't2', title: 'Add dark mode to settings', state: 'running', cloud: true, step: 'npm run build', since: now - 94e3 },
      { id: 't3', title: 'Landing page', state: 'needs', where: 'lumen-site · Awais-PC', at: now - 9 * 60e3, ask: { text: 'Ready to publish. Push to main?', cmd: 'git push origin main', isCmd: true, danger: true } },
      { id: 't4', title: 'Nightly tests', state: 'done', cloud: true, where: 'lumen-site · 24 of 24 passed', at: now - 26 * 3600e3 },
    ] },
    you: { name: 'Awais Siddique', email: 'awais@codeply.app', perm: 'edits', model: 'Haze 2', theme: 'system', notifications: 'On', pc: { name: 'Awais-PC', online: true, projects: 6 },
      usage: { today: 182400, yesterday: 162000, days: [120, 340, 80, 0, 260, 510, 420, 300, 610, 220, 90, 480, 162, 182].map((x) => x * 1000) } },
    usage: { today: 182400, week: 1240000, month: 5320000, total: 48600000,
      days: [90, 120, 60, 0, 30, 210, 340, 80, 0, 260, 510, 420, 300, 120, 0, 40, 610, 220, 90, 480, 700, 182, 330, 410, 150, 0, 260, 390, 520, 182].map((x) => x * 1000),
      models: [{ name: 'Haze 2', tokens: 3900000, calls: 412 }, { name: 'Qwen Coder · your key', tokens: 960000, calls: 88 }, { name: 'Gemma 4 31B', tokens: 460000, calls: 51 }] },
    perms: { perm: 'edits', online: true, allow: ['run:npm test', 'run:npm run *', 'run:git status', 'edit_file:src/**'], deny: ['run:git push*', 'write_file:*.env'] },
  };
  function preview(screen) {
    document.body.classList.add('previewing');
    $('drawerName').textContent = 'Awais Siddique'; $('drawerAvatar').textContent = 'A';
    $('tasksBadge').textContent = '2'; $('tasksBadge').classList.remove('hidden');
    if (screen === 'signin' || screen === 'signup') {
      $('app').classList.add('hidden'); $('signin').classList.remove('hidden');
      if (P().signinStep) P().signinStep('login');
      setAuthTab(screen === 'signup' ? 'up' : 'in');
      return;
    }
    if (screen.startsWith('onboard')) { renderOnboard(Number(screen.slice(7)) || 0, { name: 'Awais', email: 'awais@codeply.app', pcOnline: true, pcName: 'Awais-PC', perm: 'edits' }); return; }
    if (screen === 'tasks') { renderTasks(SAMPLE.tasks); open('tasksPanel'); return; }
    if (screen === 'settings') { renderYou(SAMPLE.you); open('settingsPanel'); return; }
    if (screen === 'usage') { renderUsage(SAMPLE.usage); open('usagePanel'); return; }
    if (screen === 'perms') { renderPerms(SAMPLE.perms); open('permsPanel'); }
  }

  window.CraftApp = { renderTasks, renderYou, renderUsage, renderPerms, renderOnboard, setAuthTab, preview, SAMPLE };

  function start() {
    shell();
    const m = /[?&#]preview=([a-z0-9]+)/.exec(location.search + location.hash);
    if (m) setTimeout(() => preview(m[1]), 300);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
