// Codeply phone: the app around the conversation (phone.js).
//
//   Tabs   Home (an inbox: what needs you, what is running, recent work),
//          Chats (search and filter), Calls (phone-calls.js), You (account,
//          usage, your PC, permissions, settings).
//   Chat   a conversation opens over the tabs, with a back button.
//   Panels Usage, Permissions.
//   Auth   sign in or create an account, then onboarding.
//
// Every screen is drawn by a render function from plain data, so the same
// code draws real data (from CraftPhone) and the preview (?preview=<screen>).
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const P = () => window.CraftPhone || {};
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const W = () => window.CraftWisp;

  const I = {
    chev: '<svg class="row-chev" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
    code: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 8l-4 4 4 4M16 8l4 4-4 4"/></svg>',
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 18.5V6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v7a2.5 2.5 0 0 1-2.5 2.5H9l-4 2.5Z"/></svg>',
    cloud: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 18.5a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 9a4 4 0 0 1 .5 7.97V18.5Z"/></svg>',
    pc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>',
    shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6Z"/></svg>',
    spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/></svg>',
    bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15Z"/><path d="M10 20a2 2 0 0 0 4 0"/></svg>',
    palette: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.2a8.8 8.8 0 1 0 0 17.6c1.2 0 2-.9 2-2 0-.6-.3-1.1-.6-1.5-.3-.3-.5-.8-.5-1.2 0-1.1.9-2 2-2h2.4c2.4 0 4.4-2 4.4-4.4C21.7 6.6 17.3 3.2 12 3.2z"/></svg>',
    chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 20V10M12 20V4M19 20v-7"/></svg>',
    folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 7.5a2 2 0 0 1 2-2h3.6l2 2h7.4a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z"/></svg>',
    out: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l-4-4 4-4M6 12h10"/></svg>',
    x: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M7 7l10 10M17 7 7 17"/></svg>',
    phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 4h3.2l1.8 4.5-2.2 1.4a11 11 0 0 0 5.8 5.8l1.4-2.2 4.5 1.8v3.2a1.5 1.5 0 0 1-1.6 1.5A16.5 16.5 0 0 1 4 5.6 1.5 1.5 0 0 1 5.5 4Z"/></svg>',
  };
  const COLORS = { usage: '#2F6BFF', pc: '#0E0E10', perm: '#12A150', model: '#8463E0', cloud: '#2AA598', design: '#F08A4B', bell: '#F5A524', out: '#E5484D' };

  const ago = (t) => {
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return 'now'; if (s < 3600) return `${Math.round(s / 60)}m`; if (s < 86400) return `${Math.round(s / 3600)}h`;
    return `${Math.round(s / 86400)}d`;
  };
  const clock = (ms) => { const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; };
  const short = (n) => { n = Number(n) || 0; const f = (x) => (x >= 100 ? Math.round(x) : x.toFixed(1).replace(/\.0$/, '')); return n >= 1e9 ? f(n / 1e9) + 'bn' : n >= 1e6 ? f(n / 1e6) + 'm' : n >= 1e3 ? f(n / 1e3) + 'k' : String(Math.round(n)); };

  // ─── Views ────────────────────────────────────────────────────────────────
  let view = 'home';
  function setView(v) {
    view = v;
    document.body.dataset.view = v;
    document.querySelectorAll('#tabbar [data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === v));
  }

  // ─── Home ─────────────────────────────────────────────────────────────────
  /**
   * data: { pc: { name, online }, approvals: [{ id, kind, title, chat, cmd, danger, always, at }],
   *         running: [{ id, title, step, since }], recent: [{ id, title, kind, sub, at }] }
   */
  function renderHome(data) {
    const head = document.querySelector('#empty .empty-head');
    if (head && !head.querySelector('.home-status')) head.insertAdjacentHTML('beforeend', '<div class="home-status" id="homeStatus"></div>');
    const st = $('homeStatus');
    if (st) st.innerHTML = `<span class="pill${data.pc && data.pc.online ? ' on' : ''}"><i></i>${esc(data.pc && data.pc.name ? data.pc.name : 'Your PC')} · ${data.pc && data.pc.online ? 'online' : 'offline'}</span>`
      + (data.cloud ? '<span class="pill on"><i></i>Cloud ready</span>' : '');
    const box = $('inbox');
    if (!box) return;
    let h = '';
    const aps = data.approvals || [];
    if (aps.length) {
      h += `<div class="sec-title"><span><b>Needs you</b> · ${aps.length}</span></div>`;
      h += aps.map((a) => `<div class="card ap-card" data-ap="${esc(a.id)}">
        <div class="ap-top"><span class="ap-face"></span><div class="ap-what"><b>${esc(a.kind)}</b><small>${esc(a.chat)}</small></div><span class="ap-age">${esc(ago(a.at))}</span></div>
        ${a.cmd ? `<pre class="ap-cmd">${a.isCmd ? '<span>$ </span>' : ''}${esc(a.cmd)}</pre>` : ''}
        ${a.danger ? '<span class="risk-tag">Risky: outside the project or hard to undo</span>' : ''}
        <div class="ap-btns"><button type="button" class="btn btn-quiet" data-v="reject">Deny</button><button type="button" class="btn btn-primary" data-v="once">Allow once</button></div>
        ${a.always ? `<button type="button" class="ap-always" data-v="always">${esc(a.always)}</button>` : ''}
      </div>`).join('');
    }
    const run = data.running || [];
    if (run.length) {
      h += `<div class="sec-title"><span><b>Running</b> · ${run.length}</span></div>`;
      h += run.map((r) => `<button type="button" class="card run-card" data-open="${esc(r.id)}"><span class="spinner"></span><span class="rc-text"><b>${esc(r.title)}</b><small>${r.step ? `<code>${esc(r.step)}</code>` : 'Working'}</small><div class="run-bar"></div></span><span class="rc-time" data-since="${r.since || ''}">${r.since ? clock(Date.now() - r.since) : ''}</span></button>`).join('');
    }
    h += '<div class="sec-title"><span><b>Start something</b></span></div><div class="quick">'
      + `<button type="button" data-q="task">${I.code}<span>Agent task</span><small>On your PC or cloud</small></button>`
      + `<button type="button" data-q="call">${I.phone}<span>Call Wisp</span><small>Talk it through</small></button>`
      + `<button type="button" data-q="design">${I.palette}<span>Design</span><small>Screens, decks</small></button></div>`;
    const rec = data.recent || [];
    if (rec.length) {
      h += '<div class="sec-title"><span><b>Recent</b></span><button type="button" data-q="all">See all</button></div>';
      h += `<div class="card row-list">${rec.map(rowHtml).join('')}</div>`;
    }
    box.innerHTML = h;
    box.querySelectorAll('.ap-face').forEach((el) => { if (W()) W().mount(el, { size: 'sm', mood: 'worried' }); });
  }
  const kindOf = (k) => (k === 'cloud' ? 'cloud' : k === 'chat' ? 'chat' : k === 'design' ? 'design' : 'code');
  function rowHtml(r) {
    const k = kindOf(r.kind);
    const flag = r.flag === 'needs' ? '<em class="chat-flag needs">Needs you</em>' : r.flag === 'running' ? '<em class="chat-flag running"><i></i>Working</em>' : `<span>${esc(r.at ? ago(r.at) : '')}</span>`;
    const ico = { code: I.code, chat: I.chat, cloud: I.cloud, design: I.palette }[k];
    return `<button type="button" class="row" data-open="${esc(r.id)}"><span class="kind-ico ${k}">${ico}</span><span class="row-text"><b>${esc(r.title)}</b><small>${esc(r.sub || '')}</small></span><span class="row-end">${flag}</span></button>`;
  }

  // ─── Chats ────────────────────────────────────────────────────────────────
  /** data: { groups: [{ title, rows: [...] }] } */
  function renderChats(data) {
    const slot = $('chatsListSlot');
    if (!slot) return;
    slot.innerHTML = (data.groups || []).map((g) => `<div class="tv-group">${esc(g.title)}</div><div class="card row-list">${g.rows.map(rowHtml).join('')}</div>`).join('');
  }

  // ─── You ──────────────────────────────────────────────────────────────────
  /** data: { name, email, usage: { today, week, total, days: [n...14] }, pc: { name, online, projects }, perm, model, theme, notifications } */
  function renderYou(data) {
    const v = $('youView');
    if (!v) return;
    const u = data.usage || {};
    const days = u.days || [];
    const peak = Math.max(1, ...days);
    const permTitle = { ask: 'Ask first', edits: 'Auto-accept edits', full: 'Full access' }[data.perm] || 'Ask first';
    const row = (key, icon, title, sub, val = '', cls = '') => `<button type="button" class="set-row ${cls}" data-act="${key}"><span class="set-ico" style="background:${COLORS[icon] || '#2F6BFF'}">${I[{ usage: 'chart', pc: 'pc', perm: 'shield', model: 'spark', cloud: 'cloud', design: 'palette', bell: 'bell', out: 'out' }[icon]]}</span><span class="set-main">${esc(title)}${sub ? `<small>${esc(sub)}</small>` : ''}</span>${val ? `<span class="set-val">${val}</span>` : ''}${cls === 'danger' ? '' : I.chev}</button>`;
    v.innerHTML = `
      <header class="tv-head"><h1>You</h1></header>
      <div class="you-head"><span class="you-av">${esc((data.name || data.email || 'C')[0].toUpperCase())}</span><div><b>${esc(data.name || 'You')}</b><small>${esc(data.email || '')}</small></div><span class="you-wisp"></span></div>

      <div class="sec-title"><span><b>Usage</b></span><button type="button" data-act="usage">Details</button></div>
      <button type="button" class="card usage-card" data-act="usage">
        <div class="uc-nums"><div><b>${short(u.today)}</b><small>tokens today</small></div><div><b>${short(u.week)}</b><small>this week</small></div><div><b>${short(u.total)}</b><small>all time</small></div></div>
        <div class="bars">${days.map((n, i) => `<i class="${i === days.length - 1 ? 'today' : ''}" style="height:${Math.max(4, Math.round(n / peak * 100))}%"></i>`).join('')}</div>
        <div class="uc-foot"><span>Last 14 days</span><span>Chat and Code share one daily limit</span></div>
      </button>

      <div class="sec-title"><span><b>Your agent</b></span></div>
      <div class="card group">
        ${row('pc', 'pc', data.pc && data.pc.name ? data.pc.name : 'Your PC', data.pc && data.pc.online ? `Online · ${data.pc.projects || 0} projects` : 'Offline · open Codeply on your computer', `<span class="pill${data.pc && data.pc.online ? ' on' : ''}" style="height:24px"><i></i>${data.pc && data.pc.online ? 'Online' : 'Offline'}</span>`)}
        ${row('perm', 'perm', 'Permissions', 'What runs without asking', esc(permTitle))}
        ${row('model', 'model', 'Model', 'For chats and tasks', esc(data.model || 'Haze 2'))}
        ${row('cloud', 'cloud', 'Cloud', 'Keeps working with your PC off')}
        ${row('design', 'design', 'Design', 'Screens, sites and decks')}
      </div>

      <div class="sec-title"><span><b>This phone</b></span></div>
      <div class="card group">
        ${row('bell', 'bell', 'Notifications', 'Approvals, finished tasks, reminders', esc(data.notifications || 'Off'))}
        <div class="set-row" style="cursor:default"><span class="set-main">Appearance</span></div>
        <div class="seg wide" id="youTheme">${['system', 'light', 'dark'].map((t) => `<button type="button" data-theme="${t}" class="${data.theme === t ? 'on' : ''}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div>
      </div>

      <div class="sec-title"><span><b>Account</b></span></div>
      <div class="card group">
        ${row('signout', 'out', 'Sign out', '', '', 'danger')}
        ${row('delete', 'out', 'Delete account', 'Removes your account and data', '', 'danger')}
      </div>
      <p class="you-foot">Codeply · ${esc(data.email || '')}</p>`;
    const face = v.querySelector('.you-wisp');
    if (face && W()) W().mount(face, { size: 'md', mood: 'happy' });
  }

  // ─── Usage panel ──────────────────────────────────────────────────────────
  /** data: { today, week, month, total, days: [n...30], models: [{ name, tokens, calls }] } */
  function renderUsage(data) {
    const body = $('usageBody');
    if (!body) return;
    const days = data.days || [];
    const peak = Math.max(1, ...days);
    const models = data.models || [];
    const top = Math.max(1, ...models.map((m) => m.tokens));
    body.innerHTML = `
      <div class="card us-hero"><small>Tokens in the last 30 days</small><div class="big">${short(data.month)}</div><small>${short(data.today)} today · ${short(data.week)} this week · ${short(data.total)} all time</small>
        <div class="bars">${days.map((n, i) => `<i class="${i === days.length - 1 ? 'today' : ''}" style="height:${Math.max(3, Math.round(n / peak * 100))}%"></i>`).join('')}</div>
        <div class="us-axis"><span>30 days ago</span><span>Today</span></div></div>
      <div class="sec-title"><span><b>By model</b> · 30 days</span></div>
      <div class="card">${models.map((m) => `<div class="model-row"><div>${esc(m.name)}<span>${short(m.tokens)} · ${short(m.calls)} calls</span></div><div class="meter"><i style="width:${Math.round(m.tokens / top * 100)}%"></i></div></div>`).join('') || '<div class="rules-empty">No usage yet.</div>'}</div>
      <p class="note">Counts across Craft, Crew, the CLI, Cloud and this phone. Only counts, never what you wrote. Chat and Code share your Codeply daily limit; your own models use your own keys.</p>`;
  }

  // ─── Permissions panel ────────────────────────────────────────────────────
  const MODES = [
    ['ask', 'Ask first', 'You approve every edit and command from here.', ''],
    ['edits', 'Auto-accept edits', 'File edits in the project run on their own. Commands, deploys and messages still ask. Undo puts files back.', 'Recommended'],
    ['full', 'Full access', 'Edits and commands run without asking. Your "never" rules still hold.', ''],
  ];
  function modeCards(on) {
    return MODES.map(([v, t, s, tag]) => `<button type="button" class="mode-card${on === v ? ' on' : ''}" data-mode="${v}"><span class="radio"></span><span><b>${t}${tag ? `<em>${tag}</em>` : ''}</b><small>${s}</small></span></button>`).join('');
  }
  /** data: { perm, online, allow: [rule], deny: [rule] } */
  function ruleLabel(r) {
    const i = r.indexOf(':');
    const tool = i < 0 ? r : r.slice(0, i);
    const what = i < 0 ? 'everything' : r.slice(i + 1);
    const kind = { run: 'Command', edit_file: 'Edit', write_file: 'Create', apply_patch: 'Patch', fetch_image: 'Image' }[tool] || tool.replace(/_/g, ' ');
    return [kind, what];
  }
  function renderPerms(data) {
    const body = $('permsBody');
    if (!body) return;
    const list = (rules, which) => (rules.length ? rules.map((r) => { const [k, w] = ruleLabel(r); return `<div class="rule"><span class="rule-kind">${esc(k)}</span><code>${esc(w)}</code><button type="button" data-rm="${esc(which)}|${esc(r)}" aria-label="Remove ${esc(r)}">${I.x}</button></div>`; }).join('') : `<div class="rules-empty">${which === 'allow' ? 'Nothing yet. "Always allow" on an approval, or add one below.' : 'Nothing blocked yet.'}</div>`);
    body.innerHTML = `
      <div class="sec-title" style="margin-top:6px"><span><b>On your PC</b></span></div>
      ${modeCards(data.perm)}
      <div class="sec-title"><span><b>Always allowed</b></span></div>
      <div class="card">${list(data.allow || [], 'allow')}
        <div class="rule-add"><select aria-label="Kind"><option value="run">Command</option><option value="edit_file">Edit</option><option value="write_file">Create</option></select><input placeholder="npm test" aria-label="Pattern" autocapitalize="off" spellcheck="false"><button type="button" class="btn btn-primary" data-add="allow">Add</button></div></div>
      <div class="sec-title"><span><b>Never allowed</b></span></div>
      <div class="card">${list(data.deny || [], 'deny')}
        <div class="rule-add"><select aria-label="Kind"><option value="run">Command</option><option value="edit_file">Edit</option><option value="write_file">Create</option></select><input placeholder="git push*" aria-label="Pattern" autocapitalize="off" spellcheck="false"><button type="button" class="btn btn-quiet" data-add="deny">Block</button></div></div>
      <p class="note">${data.online ? 'Rules live on your PC and cover every project. "Never" wins over everything, Full access included. A risky command always asks. "Always allow" on an approval covers only that chat.' : 'Your PC is offline. Its rules show here once it is online.'}</p>`;
  }

  // ─── Onboarding ───────────────────────────────────────────────────────────
  let obStep = 0;
  function renderOnboard(step, data = {}) {
    obStep = step;
    const box = $('onboard');
    if (!box) return;
    const dots = `<div class="ob-dots">${[0, 1, 2, 3].map((i) => `<i class="${i === step ? 'on' : ''}"></i>`).join('')}</div>`;
    let body = ''; let actions = '';
    if (step === 0) {
      body = `<span class="ob-wisp"></span><h1>Hi${data.name ? ` ${esc(data.name)}` : ''}, I'm Codeply.</h1><p>Ask me anything, or give me real work. I build on your PC, keep going in the cloud when it is off, and ask before anything risky.</p>`;
      actions = '<button type="button" class="btn btn-primary" data-ob="next">Get started</button>';
    } else if (step === 1) {
      body = `<h1>Connect your PC</h1><p>Your agent runs on your own computer, with your files and tools.</p>
        <div class="ob-glass"><div class="ob-step"><i>1</i><span><b>Get Codeply for your computer</b><small>codeply.app/download, for Windows and Mac</small></span></div>
        <div class="ob-step"><i>2</i><span><b>Sign in with this account</b><small>${esc(data.email || 'The same email you just used')}</small></span></div>
        <div class="ob-step"><i>3</i><span><b>That's it</b><small>This phone finds it on its own, on any network</small></span></div></div>
        <div class="ob-found">${data.pcOnline ? `✓ Found ${esc(data.pcName || 'your PC')}` : '<span class="spinner"></span> Looking for your PC…'}</div>`;
      actions = `<button type="button" class="btn btn-primary" data-ob="next">${data.pcOnline ? 'Continue' : 'Continue without it'}</button><button type="button" class="btn btn-ghost" data-ob="cloud">I'll use the cloud instead</button>`;
    } else if (step === 2) {
      body = `<h1>How should I ask?</h1><p>You can change this any time in You, Permissions.</p><div class="ob-glass">${modeCards(data.perm || 'edits')}</div>`;
      actions = '<button type="button" class="btn btn-primary" data-ob="next">Continue</button>';
    } else {
      body = `<span class="ob-wisp"></span><h1>I'll tap you when I need you</h1><p>A notification when a task needs your OK or finishes, and the reminders you ask for. Nothing else.</p>`;
      actions = '<button type="button" class="btn btn-primary" data-ob="notify">Turn on notifications</button><button type="button" class="btn btn-ghost" data-ob="done">Not now</button>';
    }
    box.innerHTML = `<div class="ob-top">${dots}<button type="button" class="ob-skip" data-ob="done">Skip</button></div><div class="ob-body">${body}</div><div class="ob-actions">${actions}</div>`;
    const face = box.querySelector('.ob-wisp');
    if (face && W()) W().mount(face, { size: 'lg', mood: step === 3 ? 'happy' : 'neutral' });
    box.classList.remove('hidden');
  }

  // ─── Sign in / create account ─────────────────────────────────────────────
  function setAuthTab(t) {
    document.querySelectorAll('#authTabs [data-auth]').forEach((b) => { const on = b.dataset.auth === t; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); });
    $('loginForm').classList.toggle('hidden', t !== 'in');
    $('signupForm').classList.toggle('hidden', t !== 'up');
    $('authTitle').textContent = t === 'up' ? 'Create your account' : 'Welcome back';
    $('authSub').textContent = t === 'up' ? 'One account for Codeply on your phone, your PC and the CLI.' : 'Sign in with the same account as Codeply on your computer.';
  }

  // ─── Shell: tab bar, back button, the chats list slot ─────────────────────
  function shell() {
    // The menu button doubles as Back inside a chat.
    const mb = $('menuBtn');
    if (mb && !mb.querySelector('.ico-back')) {
      mb.querySelector('svg').classList.add('ico-menu');
      mb.insertAdjacentHTML('beforeend', '<svg class="ico-back" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>');
    }
    // The search box and chat list live in the Chats tab now.
    const slot = $('chatsSearchSlot');
    const si = $('searchInput');
    if (slot && si && !slot.contains(si)) { slot.replaceWith(si); si.placeholder = 'Search chats'; }
    document.querySelectorAll('#authTabs [data-auth]').forEach((b) => b.addEventListener('click', () => setAuthTab(b.dataset.auth)));
    document.querySelectorAll('#tabbar [data-tab]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.tab === 'calls' ? view : b.dataset.tab)));
    document.querySelectorAll('[data-close-panel]').forEach((b) => b.addEventListener('click', () => b.closest('.panel').classList.add('hidden')));
    document.querySelectorAll('#chatsFilter [data-f]').forEach((b) => b.addEventListener('click', () => { document.querySelectorAll('#chatsFilter [data-f]').forEach((x) => x.classList.toggle('on', x === b)); }));
    setView('home');
  }

  // ─── Preview: every screen with sample data (?preview=<screen>) ───────────
  const now = Date.now();
  const SAMPLE = {
    home: {
      pc: { name: 'Awais-PC', online: true }, cloud: true,
      approvals: [
        { id: 'a1', kind: 'Run a command', chat: 'Fix checkout total · shop-web', cmd: 'npm install stripe@14 && npm test', isCmd: true, always: 'Always allow "npm install" and "npm test" in this chat', at: now - 120e3 },
        { id: 'a2', kind: 'Push to GitHub', chat: 'Landing page · lumen-site', cmd: 'git push origin main', isCmd: true, danger: true, at: now - 9 * 60e3 },
      ],
      running: [{ id: 'c4', title: 'Add dark mode to settings', step: 'Running npm run build', since: now - 94e3 }],
      recent: [
        { id: 'c1', title: 'Fix checkout total', kind: 'code', sub: 'shop-web · on your PC', at: now - 3600e3 },
        { id: 'c2', title: 'Hero line for the tea shop', kind: 'chat', sub: 'Chat', at: now - 5 * 3600e3 },
        { id: 'c3', title: 'Nightly tests', kind: 'cloud', sub: 'lumen-site · cloud', at: now - 26 * 3600e3 },
      ],
    },
    chats: { groups: [
      { title: 'Needs you', rows: [{ id: 'c1', title: 'Fix checkout total', kind: 'code', sub: 'shop-web · on your PC', flag: 'needs' }, { id: 'c5', title: 'Landing page', kind: 'code', sub: 'lumen-site · on your PC', flag: 'needs' }] },
      { title: 'Running', rows: [{ id: 'c4', title: 'Add dark mode to settings', kind: 'cloud', sub: 'lumen-site · cloud', flag: 'running' }] },
      { title: 'Today', rows: [{ id: 'c2', title: 'Hero line for the tea shop', kind: 'chat', sub: 'Chat', at: now - 5 * 3600e3 }, { id: 'c6', title: 'Plan my day', kind: 'chat', sub: 'Chat', at: now - 7 * 3600e3 }] },
      { title: 'Earlier', rows: [{ id: 'c3', title: 'Nightly tests', kind: 'cloud', sub: 'lumen-site · cloud', at: now - 26 * 3600e3 }, { id: 'c7', title: 'Pricing page redesign', kind: 'design', sub: 'Design', at: now - 3 * 86400e3 }] },
    ] },
    you: { name: 'Awais', email: 'awais@codeply.app', perm: 'edits', model: 'Haze 2', theme: 'system', notifications: 'On', pc: { name: 'Awais-PC', online: true, projects: 6 },
      usage: { today: 182400, week: 1240000, total: 48600000, days: [120, 340, 80, 0, 260, 510, 420, 300, 610, 220, 90, 480, 700, 182].map((x) => x * 1000) } },
    usage: { today: 182400, week: 1240000, month: 5320000, total: 48600000,
      days: [90, 120, 60, 0, 30, 210, 340, 80, 0, 260, 510, 420, 300, 120, 0, 40, 610, 220, 90, 480, 700, 182, 330, 410, 150, 0, 260, 390, 520, 182].map((x) => x * 1000),
      models: [{ name: 'Haze 2', tokens: 3900000, calls: 412 }, { name: 'Qwen Coder (your key)', tokens: 960000, calls: 88 }, { name: 'Gemma 4 31B', tokens: 460000, calls: 51 }] },
    perms: { perm: 'edits', online: true, allow: ['run:npm test', 'run:npm run *', 'run:git status', 'edit_file:src/**'], deny: ['run:git push*', 'write_file:*.env'] },
  };
  function preview(screen) {
    document.body.classList.add('previewing');
    if (screen === 'signin' || screen === 'signup') {
      $('app').classList.add('hidden'); $('signin').classList.remove('hidden');
      P().signinStep && P().signinStep('login');
      setAuthTab(screen === 'signup' ? 'up' : 'in');
      return;
    }
    if (screen.startsWith('onboard')) { renderOnboard(Number(screen.slice(7)) || 0, { name: 'Awais', email: 'awais@codeply.app', pcOnline: screen === 'onboard1', pcName: 'Awais-PC', perm: 'edits' }); return; }
    if (screen === 'home') { setView('home'); renderHome(SAMPLE.home); $('homeBadge').textContent = '2'; $('homeBadge').classList.remove('hidden'); return; }
    if (screen === 'chats') { setView('chats'); renderChats(SAMPLE.chats); return; }
    if (screen === 'you') { setView('you'); renderYou(SAMPLE.you); return; }
    if (screen === 'usage') { setView('you'); renderYou(SAMPLE.you); renderUsage(SAMPLE.usage); $('usagePanel').classList.remove('hidden'); return; }
    if (screen === 'perms') { setView('you'); renderYou(SAMPLE.you); renderPerms(SAMPLE.perms); $('permsPanel').classList.remove('hidden'); return; }
  }

  window.CraftApp = { setView, renderHome, renderChats, renderYou, renderUsage, renderPerms, renderOnboard, setAuthTab, preview, SAMPLE };

  function start() {
    shell();
    const m = /[?&#]preview=([a-z0-9]+)/.exec(location.search + location.hash);
    if (m) setTimeout(() => preview(m[1]), 300);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
