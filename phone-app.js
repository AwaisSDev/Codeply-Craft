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
  // A panel opened from another (Usage from Settings) must land on top of it: move it last.
  const open = (id) => { const el = $(id); if (!el) return; el.parentNode.appendChild(el); el.classList.remove('hidden'); };

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
    body.innerHTML = (window.CraftWork && window.CraftWork.schedulesHtml ? window.CraftWork.schedulesHtml() : '')
      + `<div class="chips">${chip('all', 'All', tasks.length)}${chip('needs', 'Needs you', n('needs'))}${chip('running', 'Running', n('running'))}${chip('failed', 'Failed', n('failed'))}${chip('done', 'Done', n('done'))}</div>`
      + shown.map((t) => {
        const ico = t.state === 'needs' ? `<span class="task-ico needs">${I.hand}</span>` : t.state === 'running' ? '<span class="task-ico"><span class="spinner"></span></span>'
          : t.state === 'failed' ? `<span class="task-ico failed">${I.x}</span>` : `<span class="task-ico done">${I.done}</span>`;
        const sub = t.state === 'running' && t.step ? `<code>${esc(t.step)}</code>` : t.state === 'failed' && t.error ? `<span class="task-err">${esc(t.error)}</span>` : `${t.cloud ? I.cloud : I.pc}<span>${esc(t.where || '')}</span>`;
        const when = t.state === 'running' && t.since ? clock(Date.now() - t.since) : ago(t.at || Date.now());
        const ask = t.state === 'needs' && t.ask ? `<div class="task-ask">${esc(t.ask.text)}${t.ask.cmd ? `<pre>${t.ask.isCmd ? '<span>$ </span>' : ''}${esc(t.ask.cmd)}</pre>` : ''}</div>
          ${t.ask.danger ? '<div class="task-risk">Outside the project or hard to undo</div>' : ''}
          ${t.chatOnly ? '<div class="task-risk" style="color:inherit">Open the chat to answer</div>' : `<button type="button" class="btn btn-outline" data-ap="${esc(t.id)}" data-v="once">Allow</button>`}
          ${t.chatOnly ? '' : `<div class="task-more">${t.ask.always ? `<button type="button" data-ap="${esc(t.id)}" data-v="always">${esc(t.ask.always)}</button>` : ''}<button type="button" class="deny" data-ap="${esc(t.id)}" data-v="reject">Deny</button></div>`}` : '';
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
  // The period picker and the chart: 7D, 14D, 30D as days, 1Y as 52 weeks. Touch or drag
  // across the bars to read one day (or week); tap the number to go back to the total.
  const RANGES = [[7, '7D', 'Last 7 days', '7 days ago'], [14, '14D', 'Last 14 days', '14 days ago'], [30, '30D', 'Last 30 days', '30 days ago'], [365, '1Y', 'Last 12 months', '12 months ago']];
  let usageRange = 30;
  let usageSource = null; // range → the data renderUsage draws (live or preview)
  const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const dayName = (d) => d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  /** u: { byDay: {day: tokens}, mByDay: {day: {model: [tokens, calls]}}, today, week, total } → what the Usage page draws for a range */
  function usageView(u, range) {
    const now = new Date();
    const day = (i) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const val = (d) => (u.byDay && u.byDay[dayKey(d)]) || 0;
    const bars = []; const keys = [];
    if (range <= 30) {
      for (let i = range - 1; i >= 0; i--) { const d = day(i); keys.push(dayKey(d)); bars.push({ n: val(d), label: i === 0 ? 'Today' : i === 1 ? 'Yesterday' : dayName(d) }); }
    } else {
      for (let w = 51; w >= 0; w--) {
        let n = 0;
        for (let k = 0; k < 7; k++) { const d = day(w * 7 + k); n += val(d); keys.push(dayKey(d)); }
        bars.push({ n, label: w === 0 ? 'This week' : `Week of ${dayName(day(w * 7 + 6))}` });
      }
    }
    const models = {};
    for (const k of keys) for (const [m, v] of Object.entries((u.mByDay && u.mByDay[k]) || {})) { const x = models[m] || (models[m] = { tokens: 0, calls: 0 }); x.tokens += Number(v[0]) || 0; x.calls += Number(v[1]) || 0; }
    return {
      range, bars, sum: bars.reduce((x, b) => x + b.n, 0), today: u.today || 0, week: u.week || 0, total: u.total || 0,
      models: Object.entries(models).map(([name, v]) => ({ name, ...v })).filter((m) => m.tokens > 0).sort((a, b) => b.tokens - a.tokens).slice(0, 8),
    };
  }
  /** data: usageView(...) */
  function renderUsage(data) {
    const body = $('usageBody');
    if (!body) return;
    const r = RANGES.find((x) => x[0] === data.range) || RANGES[2];
    const bars = data.bars || [];
    const peak = Math.max(1, ...bars.map((b) => b.n));
    const models = data.models || [];
    const top = Math.max(1, ...models.map((m) => m.tokens));
    const head = `<small>${r[2]}</small><div class="big">${short(data.sum)} tokens</div>`;
    body.innerHTML = `
      <div class="usage" style="margin-top:8px"><button type="button" class="usage-head" data-total>${head}</button>
        <div class="delta"><span>${short(data.today)} today · ${short(data.week)} this week · ${short(data.total)} all time</span></div>
        <div class="bars${bars.length > 40 ? ' dense' : ''}" style="height:120px">${bars.map((b, i) => `<i class="${i === bars.length - 1 ? 'today' : ''}" style="height:${b.n ? Math.max(4, Math.round(b.n / peak * 100)) : 2}%"></i>`).join('')}</div>
        <div class="axis"><span>${r[3]}</span><span>${data.range > 30 ? 'This week' : 'Today'}</span></div>
        <div class="seg wide" role="tablist">${RANGES.map(([n, t]) => `<button type="button" role="tab" data-range="${n}" class="${n === r[0] ? 'on' : ''}" aria-selected="${n === r[0]}">${t}</button>`).join('')}</div></div>
      ${sec('By model', `<span>${r[2].replace('Last ', '')}</span>`)}
      <div class="list">${models.map((m) => `<div class="li" style="flex-direction:column;align-items:stretch;gap:0"><div style="display:flex;justify-content:space-between;gap:8px"><b style="font-size:16px;font-weight:500">${esc(m.name)}</b><span style="color:var(--muted);font-size:15px">${short(m.tokens)}</span></div><small style="color:var(--muted);font-size:13.5px">${short(m.calls)} calls</small><div class="meter"><i style="width:${Math.round(m.tokens / top * 100)}%"></i></div></div>`).join('') || '<div class="li" style="color:var(--muted)">No usage in this period.</div>'}</div>
      <p class="note">Counts from Craft, Crew, the CLI, Cloud and this phone. Counts only, never what you wrote. Chat and Code share one daily limit; your own models use your own keys.</p>`;
    // Read one bar: touch or drag across the chart
    const chart = body.querySelector('.bars');
    const headEl = body.querySelector('.usage-head');
    let sel = -1;
    const pick = (i) => {
      if (i === sel) return;
      sel = i;
      chart.querySelectorAll('i').forEach((el, j) => el.classList.toggle('sel', j === i));
      chart.classList.toggle('picking', i >= 0);
      headEl.innerHTML = i < 0 ? head : `<small>${esc(bars[i].label)}</small><div class="big">${short(bars[i].n)} tokens</div>`;
    };
    const at = (e) => { const rc = chart.getBoundingClientRect(); return Math.max(0, Math.min(bars.length - 1, Math.floor((e.clientX - rc.left) / rc.width * bars.length))); };
    let down = false;
    chart.addEventListener('pointerdown', (e) => { down = true; try { chart.setPointerCapture(e.pointerId); } catch {} pick(at(e)); });
    chart.addEventListener('pointermove', (e) => { if (down) pick(at(e)); });
    const up = () => { down = false; };
    chart.addEventListener('pointerup', up); chart.addEventListener('pointercancel', up);
    headEl.addEventListener('click', () => pick(-1));
  }
  // The period buttons (delegated, so they work after every redraw)
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('#usageBody [data-range]');
    if (!b) return;
    usageRange = Number(b.dataset.range) || 30;
    if (usageSource) renderUsage(usageSource(usageRange));
    try { if (navigator.vibrate) navigator.vibrate(8); } catch {}
  });

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
    // The bars float over the chat (glass): the chat leaves room for them, sized live.
    const app = $('app'); const topBar = app && app.querySelector(':scope > .top'); const comp = $('composer'); const sc = $('scroll');
    if (app && topBar && comp && sc && 'ResizeObserver' in window) {
      new ResizeObserver(() => {
        const bottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 40;
        app.style.setProperty('--top-h', `${topBar.offsetHeight}px`);
        app.style.setProperty('--composer-h', `${comp.offsetHeight}px`);
        if (bottom) sc.scrollTop = sc.scrollHeight; // typing a longer message keeps the last reply in view
      }).observe(comp);
      new ResizeObserver(() => app.style.setProperty('--top-h', `${topBar.offsetHeight}px`)).observe(topBar);
    }
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
    document.querySelectorAll('[data-close-panel]').forEach((b) => b.addEventListener('click', () => b.closest('.panel').classList.add('hidden')));
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
    if (screen === 'usage') {
      const u = SAMPLE.usage; const byDay = {}; const mByDay = {}; const now = new Date();
      for (let i = 0; i < 365; i++) {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
        const n = i < u.days.length ? u.days[u.days.length - 1 - i] : Math.round((Math.sin(i / 9) + 1.1) * 160000 * (i % 7 === 3 ? 0 : 1));
        byDay[dayKey(d)] = n;
        mByDay[dayKey(d)] = Object.fromEntries(u.models.map((m, j) => [m.name, [Math.round(n * [0.72, 0.18, 0.1][j]), Math.max(1, Math.round(n / 12000 * [0.72, 0.18, 0.1][j]))]]));
      }
      const cache = { byDay, mByDay, today: u.today, week: u.week, total: u.total };
      usageSource = (r) => usageView(cache, r);
      renderUsage(usageSource(usageRange)); open('usagePanel'); return;
    }
    if (screen === 'perms') { renderPerms(SAMPLE.perms); open('permsPanel'); }
  }

  // ═══ Live data and actions ═══════════════════════════════════════════════
  // Everything above draws; this feeds it from CraftPhone (phone.js) and wires
  // its buttons. Nothing here runs in the preview.
  const S = () => P().state || {};
  const pcOnline = () => !!(P().relay && P().relay.pcId);
  const userName = () => { const u = S().user || {}; const m = u.user_metadata || {}; return m.full_name || m.name || (u.email ? u.email.split('@')[0] : ''); };
  const toast = (msg) => { try { alert(msg); } catch {} };
  let usageCache = null;   // my_usage, loaded when Settings or Usage opens
  let rulesCache = null;   // { allow, deny } from the PC

  // ─── Tasks from real chats and approvals ───
  function chatTitleFor(sessionId) {
    const st = S();
    const c = (st.chats || []).find((x) => x.pcSessionId === sessionId);
    if (c) return c.title;
    const s2 = ((st.pc && st.pc.sessions) || []).find((x) => x.id === sessionId);
    return (s2 && s2.title) || 'A task on your PC';
  }
  function alwaysLabel(a) {
    const scope = Array.isArray(a.alwaysScope) ? a.alwaysScope : null;
    if (a.danger || (scope && !scope.length) || a.tool === 'fetch_image') return '';
    return scope ? `Always allow ${scope.join(' and ')}` : `Always allow ${String(a.tool || '').replace(/_/g, ' ')}`;
  }
  function tasksData() {
    const st = S();
    const tasks = [];
    for (const a of (st.approvals ? st.approvals.values() : [])) {
      tasks.push({ id: `ap:${a.requestId}`, title: chatTitleFor(a.sessionId), state: 'needs', where: st.pc && st.pc.device ? st.pc.device : 'Your PC', at: a.at || Date.now(), session: a.sessionId,
        ask: { text: a.title || 'Codeply needs your OK', cmd: a.detail || '', isCmd: a.tool === 'run', danger: !!a.danger, always: alwaysLabel(a) } });
    }
    const where = (c) => `${(c.project && c.project.name) || 'Project'} · ${c.cloud ? 'cloud' : (st.pc && st.pc.device) || 'your PC'}`;
    const code = (st.chats || []).filter((c) => c.kind === 'code').sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    for (const c of code) {
      if (tasks.some((t) => t.session && t.session === c.pcSessionId)) continue;
      if (c.cloud) {
        // A cloud task's state is what its run reported (phone.js pollTask), never a guess.
        const b = P().chatBody ? P().chatBody(c.id) : null;
        const last = b && b.tasks && b.tasks.length ? b.tasks[b.tasks.length - 1] : null;
        const s = last ? last.status : '';
        const state = last && last.ask ? 'needs' : s === 'done' ? 'done' : s === 'failed' || s === 'cancelled' ? 'failed' : last ? 'running' : 'done';
        tasks.push({ id: `c:${c.id}`, title: c.title || 'Untitled task', state, cloud: true, where: where(c),
          step: state === 'running' ? (s === 'starting' || last.queued ? 'Starting in the cloud' : 'Working in the cloud') : '',
          error: state === 'failed' ? (s === 'cancelled' ? 'Cancelled' : last.error || 'The cloud run failed.') : '',
          ask: state === 'needs' ? { text: last.ask.title || last.ask.text || 'Codeply needs your OK', cmd: last.ask.detail || '' } : null, chatOnly: state === 'needs',
          since: state === 'running' ? (last.startedAt || c.updatedAt) : 0, at: (last && last.finishedAt) || c.updatedAt || Date.now() });
      } else {
        const busy = st.busy && st.busy.has(c.id);
        tasks.push({ id: `c:${c.id}`, title: c.title || 'Untitled task', state: busy ? 'running' : 'done', cloud: false, where: where(c), step: busy ? 'Working' : '', since: busy ? c.updatedAt : 0, at: c.updatedAt || Date.now() });
      }
      if (tasks.length > 40) break;
    }
    if (window.CraftWork && window.CraftWork.scheduledTasks) tasks.push(...window.CraftWork.scheduledTasks());
    return { tasks };
  }
  function refreshTasks() {
    const n = S().approvals ? S().approvals.size : 0;
    const b = $('tasksBadge');
    if (b) { b.textContent = String(n); b.classList.toggle('hidden', !n); }
    if (!$('tasksPanel').classList.contains('hidden')) renderTasks(tasksData());
  }

  // ─── Usage (my_usage in the database, the same numbers as Craft on the PC) ───
  async function loadUsage() {
    const sb = P().sb;
    if (!sb) return null;
    try {
      const { data, error } = await sb.rpc('my_usage', { tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' });
      if (error) throw error;
      const byDay = {}; const models = {}; const mByDay = {};
      for (const r of (data && data.days) || []) {
        byDay[r.d] = Number(r.t) || 0;
        mByDay[r.d] = r.m || {};
        for (const [m, v] of Object.entries(r.m || {})) { const x = models[m] || (models[m] = { tokens: 0, calls: 0, recent: 0 }); x.tokens += Number(v[0]) || 0; x.calls += Number(v[1]) || 0; }
      }
      const series = (n) => { const out = []; const d = new Date(); for (let i = n - 1; i >= 0; i--) { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() - i); out.push(byDay[dayKey(x)] || 0); } return out; };
      const d30 = series(30);
      const sum = (a) => a.reduce((x, y) => x + y, 0);
      usageCache = {
        today: d30[29], yesterday: d30[28], week: sum(d30.slice(-7)), month: sum(d30), total: Number(data && data.tokens) || sum(Object.values(byDay)),
        days14: series(14), days30: d30, byDay, mByDay,
        models: Object.entries(models).map(([name, v]) => ({ name, tokens: v.tokens, calls: v.calls })).sort((a, b) => b.tokens - a.tokens).slice(0, 8),
      };
    } catch (e) { usageCache = usageCache || { error: e.message || 'Could not load your usage.' }; }
    return usageCache;
  }

  // ─── Settings ───
  function settingsData() {
    const st = S();
    const m = st.pc && st.pc.models;
    const cur = m && (m.models || []).find((x) => x.id === m.selected);
    const u = usageCache && !usageCache.error ? usageCache : { today: 0, yesterday: 0, days: [] };
    return {
      name: userName(), email: (st.user && st.user.email) || '', perm: st.perm || 'ask', model: cur ? cur.name : 'Haze 2',
      theme: P().themeChoice ? P().themeChoice() : 'system',
      notifications: ('Notification' in window) && Notification.permission === 'granted' ? 'On' : 'Off',
      pc: { name: (st.pc && st.pc.device) || 'Your PC', online: pcOnline(), projects: ((st.pc && st.pc.projects) || []).length },
      usage: { today: u.today, yesterday: u.yesterday, days: u.days14 || [] },
    };
  }
  async function openSettings() {
    renderYou(settingsData());
    open('settingsPanel');
    await loadUsage();
    if (!$('settingsPanel').classList.contains('hidden')) renderYou(settingsData());
  }
  async function openUsage() {
    usageSource = (r) => usageView(usageCache && !usageCache.error ? usageCache : {}, r);
    renderUsage(usageSource(usageRange));
    open('usagePanel');
    const u = await loadUsage();
    if (u && u.error) { $('usageBody').insertAdjacentHTML('afterbegin', `<p class="note" style="color:var(--red)">${esc(u.error)}</p>`); return; }
    if (u && !$('usagePanel').classList.contains('hidden')) renderUsage(usageSource(usageRange));
  }

  // ─── Permissions: the mode lives on this phone, the rules on the PC ───
  async function openPerms() {
    const draw = (extra = '') => { renderPerms({ perm: S().perm || 'ask', online: pcOnline(), allow: (rulesCache && rulesCache.allow) || [], deny: (rulesCache && rulesCache.deny) || [] }); if (extra) $('permsBody').insertAdjacentHTML('beforeend', `<p class="note" style="color:var(--red)">${esc(extra)}</p>`); };
    draw();
    open('permsPanel');
    if (!pcOnline()) return;
    try {
      const r = await P().relayRequest('GET', '/api/permissions');
      rulesCache = { allow: (r.global && r.global.allow) || [], deny: (r.global && r.global.deny) || [] };
      draw();
    } catch (e) { draw(/not found|unknown|404/i.test(e.message) ? 'Update Codeply on your PC to edit its rules from here.' : `Couldn't read the rules: ${e.message}`); }
  }
  async function saveRules(next) {
    try {
      const r = await P().relayRequest('POST', '/api/permissions', next);
      rulesCache = { allow: (r.global && r.global.allow) || [], deny: (r.global && r.global.deny) || [] };
    } catch (e) { toast(`Couldn't save the rule: ${e.message}`); }
    openPerms();
  }

  // ─── Onboarding (after creating an account) ───
  let obStep = 0; let obTimer = null;
  const obData = () => ({ name: (userName() || '').split(' ')[0], email: (S().user && S().user.email) || '', pcOnline: pcOnline(), pcName: S().pc && S().pc.device, perm: S().perm || 'edits' });
  function startOnboarding() {
    obStep = 0;
    if (P().setPermission && !localStorage.getItem('craft-permission')) P().setPermission('edits'); // the recommended mode, shown preselected
    renderOnboard(0, obData());
    clearInterval(obTimer);
    obTimer = setInterval(() => { if (obStep === 1) renderOnboard(1, obData()); }, 3000); // "Looking for your PC" turns to "Found"
  }
  function endOnboarding() {
    clearInterval(obTimer);
    try { localStorage.removeItem('craft-phone-onboard'); } catch {}
    $('onboard').classList.add('hidden');
  }

  // ─── Sign up ───
  async function signUp(e) {
    e.preventDefault();
    const err = $('signupError');
    err.classList.add('hidden');
    const name = $('signupName').value.trim();
    const email = $('signupEmail').value.trim();
    const password = $('signupPassword').value;
    const fail = (m) => { err.textContent = m; err.classList.remove('hidden'); };
    if (!name) return fail('Add your name.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('Enter a real email address.');
    if (password.length < 8) return fail('Use at least 8 characters for the password.');
    const btn = $('signupBtn');
    btn.disabled = true; btn.textContent = 'Creating your account...';
    try {
      const { data, error } = await P().sb.auth.signUp({ email, password, options: { data: { full_name: name } } });
      if (error) throw error;
      if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) return fail('There is already an account with this email. Sign in instead.');
      $('signupPassword').value = '';
      if (data.session) { // email confirmation is off for this project: straight in
        try { localStorage.setItem('craft-phone-onboard', 'pending'); } catch {}
        await P().enterApp();
        return;
      }
      $('otpForm').dataset.mode = 'signup';
      $('otpForm').dataset.email = email;
      $('otpSentTo').textContent = `We emailed a code to ${email}. Enter it to confirm your email.`;
      $('loginOtp').value = '';
      P().signinStep('otp');
      $('authTitle').textContent = 'Check your email';
      $('authSub').textContent = '';
      $('authSwitch').innerHTML = '';
      $('loginOtp').focus();
    } catch (x) {
      fail(P().friendlyAuthError ? P().friendlyAuthError(x, 'Could not create the account.') : x.message);
    } finally { btn.disabled = false; btn.textContent = 'Create account'; }
  }

  // ─── Account deletion (supabase/functions/delete-account) ───
  async function deleteAccount() {
    const email = (S().user && S().user.email) || '';
    const typed = prompt(`This deletes your Codeply account, your chats in the cloud and your usage. It can't be undone.\n\nType ${email} to confirm.`);
    if (typed == null) return;
    try {
      const token = await P().accessToken();
      const res = await fetch(`${P().SUPABASE_URL || 'https://zswkhfkfseclgadhvobg.supabase.co'}/functions/v1/delete-account`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: P().SUPABASE_ANON_KEY },
        body: JSON.stringify({ confirm: typed }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.status === 404) throw new Error('Account deletion is not switched on yet. Email hello@codeply.app and we will delete it for you.');
      if (!res.ok) throw new Error(j.error || `Codeply could not delete it (${res.status}).`);
      try { localStorage.clear(); } catch {}
      await P().signOut();
    } catch (e) { toast(e.message); }
  }

  // ─── Under every answer ───
  function answerAction(kind, m, btn) {
    const text = m.innerText;
    if (kind === 'speak') {
      if (!('speechSynthesis' in window)) return toast("This browser can't read aloud.");
      if (speechSynthesis.speaking) { speechSynthesis.cancel(); return; }
      speechSynthesis.speak(new SpeechSynthesisUtterance(text));
    } else if (kind === 'up' || kind === 'down') {
      const row = btn.parentElement;
      row.querySelectorAll('[data-msg="up"],[data-msg="down"]').forEach((b) => b.classList.toggle('on', b === btn && !b.classList.contains('on')));
    } else if (kind === 'again') {
      const users = [...$('feed').querySelectorAll(':scope > .msg.user')].filter((u) => u.compareDocumentPosition(m) & Node.DOCUMENT_POSITION_FOLLOWING);
      const last = users[users.length - 1];
      if (!last) return;
      $('input').value = last.innerText.trim();
      $('input').dispatchEvent(new Event('input'));
      $('composer').requestSubmit();
    } else if (kind === 'share') {
      if (navigator.share) navigator.share({ text }).catch(() => {});
      else { try { navigator.clipboard.writeText(text); } catch {} }
    }
  }

  function wire() {
    // Panels open with live data.
    $('drawerTasks').addEventListener('click', () => renderTasks(tasksData()), true);
    $('drawerMe').addEventListener('click', (e) => { e.stopImmediatePropagation(); if (P().closeDrawer) P().closeDrawer(); openSettings(); }, true);
    $('settingsBtn').addEventListener('click', (e) => { e.stopImmediatePropagation(); if (P().closeDrawer) P().closeDrawer(); openSettings(); }, true);
    document.addEventListener('craft:approvals', refreshTasks);
    document.addEventListener('craft:permission', () => { if (!$('permsPanel').classList.contains('hidden')) openPerms(); });
    setInterval(() => { if (!document.hidden) refreshTasks(); }, 4000);

    // Tasks: allow / always / deny on the card, or open the chat.
    $('tasksBody').addEventListener('click', (e) => {
      const b = e.target.closest('[data-ap]');
      if (b) { e.stopPropagation(); const id = Number(b.dataset.ap.slice(3)); b.disabled = true; P().answerApproval(b.dataset.v, id); setTimeout(refreshTasks, 50); return; }
      if (e.target.closest('[data-work]')) return; // the Schedules block (phone-work.js) handles its own taps
      const card = e.target.closest('[data-open]');
      if (!card) return;
      const id = card.dataset.open;
      const st = S();
      if (id.startsWith('s:')) { if (window.CraftWork) window.CraftWork.openRun(id.slice(2)); return; }
      $('tasksPanel').classList.add('hidden');
      if (id.startsWith('c:')) P().openChat(id.slice(2));
      else {
        const t = tasksData().tasks.find((x) => x.id === id);
        const local = t && (st.chats || []).find((c) => c.pcSessionId === t.session);
        if (local) P().openChat(local.id);
        else { const meta = ((st.pc && st.pc.sessions) || []).find((x) => x.id === (t && t.session)); if (meta) P().openPcSession(meta); }
      }
    });
    document.querySelector('#tasksPanel [data-q="new"]').addEventListener('click', () => { $('tasksPanel').classList.add('hidden'); P().newChat(); setTimeout(() => $('agentChip').click(), 50); });

    // Settings rows.
    $('youView').addEventListener('click', async (e) => {
      const t = e.target.closest('[data-theme]');
      if (t) { P().applyTheme(t.dataset.theme); renderYou(settingsData()); return; }
      const a = e.target.closest('[data-act]');
      if (!a) return;
      const act = a.dataset.act;
      e.stopImmediatePropagation();
      if (act === 'usage') openUsage();
      else if (act === 'perm') openPerms();
      else if (act === 'model') P().openModelPicker();
      else if (act === 'pc') P().openProjectPicker({ anchor: a });
      else if (act === 'cloud') { $('settingsPanel').classList.add('hidden'); P().openSetup({}); }
      else if (act === 'design') { $('settingsPanel').classList.add('hidden'); $('drawerDesign').click(); }
      else if (act === 'bell') { if (window.CraftReminders && window.CraftReminders.enablePush) { await window.CraftReminders.enablePush(); renderYou(settingsData()); } else toast("This phone can't show notifications from Codeply."); }
      else if (act === 'signout') { $('settingsPanel').classList.add('hidden'); P().signOut(); }
      else if (act === 'delete') deleteAccount();
    }, true);

    // Permissions: the mode, and the PC's rules.
    $('permsBody').addEventListener('click', (e) => {
      const m = e.target.closest('[data-mode]');
      if (m) { if (m.dataset.mode === 'full' && !confirm('Full access runs edits and commands on your PC without asking. Turn it on?')) return; P().setPermission(m.dataset.mode); openPerms(); return; }
      const rm = e.target.closest('[data-rm]');
      if (rm) { const [which, rule] = [rm.dataset.rm.slice(0, rm.dataset.rm.indexOf('|')), rm.dataset.rm.slice(rm.dataset.rm.indexOf('|') + 1)]; const next = { allow: [...((rulesCache && rulesCache.allow) || [])], deny: [...((rulesCache && rulesCache.deny) || [])] }; next[which] = next[which].filter((r) => r !== rule); saveRules(next); return; }
      const add = e.target.closest('[data-add]');
      if (add) {
        if (!pcOnline()) return toast('Your PC is offline. Rules live on it, so it has to be online.');
        const row = add.closest('.rule-add');
        const pat = row.querySelector('input').value.trim();
        if (!pat) return row.querySelector('input').focus();
        const rule = `${row.querySelector('select').value}:${pat}`;
        const next = { allow: [...((rulesCache && rulesCache.allow) || [])], deny: [...((rulesCache && rulesCache.deny) || [])] };
        next[add.dataset.add] = [...next[add.dataset.add].filter((r) => r !== rule), rule];
        saveRules(next);
      }
    });

    // Onboarding buttons.
    $('onboard').addEventListener('click', async (e) => {
      const m = e.target.closest('[data-mode]');
      if (m) { P().setPermission(m.dataset.mode); renderOnboard(2, obData()); return; }
      const b = e.target.closest('[data-ob]');
      if (!b) return;
      const v = b.dataset.ob;
      if (v === 'next') { obStep = Math.min(3, obStep + 1); renderOnboard(obStep, obData()); }
      else if (v === 'cloud') { endOnboarding(); P().openSetup({}); }
      else if (v === 'notify') { if (window.CraftReminders && window.CraftReminders.enablePush) { try { await window.CraftReminders.enablePush(); } catch {} } endOnboarding(); }
      else if (v === 'done') endOnboarding();
    });

    // Sign up; a plain sign-in code is never a sign-up code.
    $('signupForm').addEventListener('submit', signUp);
    $('useCodeBtn').addEventListener('click', () => { delete $('otpForm').dataset.mode; }, true);
    $('otpBackBtn').addEventListener('click', () => { delete $('otpForm').dataset.mode; setAuthTab('in'); });

    // The answer actions.
    $('feed').addEventListener('click', (e) => {
      const b = e.target.closest('.msg-actions [data-msg]');
      if (!b || b.dataset.msg === 'copy') return;
      answerAction(b.dataset.msg, b.parentElement.previousElementSibling, b);
    });

    // Signed in: who you are in the sidebar, and onboarding after a new account.
    const entered = async () => {
      if ($('app').classList.contains('hidden')) return;
      // phone.js shows the app a moment before it has the user; ask for it.
      // (and after signing out and into another account, the old user would show).
      try { const sess = await P().currentSession(); if (sess && sess.user) S().user = sess.user; } catch {}
      const n = userName();
      $('drawerName').textContent = n || 'Your account';
      $('drawerAvatar').textContent = (n || 'C')[0].toUpperCase();
      refreshTasks();
      let pending = false; try { pending = localStorage.getItem('craft-phone-onboard') === 'pending'; } catch {}
      if (pending && $('onboard').classList.contains('hidden')) startOnboarding();
    };
    new MutationObserver(entered).observe($('app'), { attributes: true, attributeFilter: ['class'] });
    entered();
  }

  window.CraftApp = { renderTasks, renderYou, renderUsage, renderPerms, renderOnboard, setAuthTab, preview, SAMPLE, openSettings, openUsage, openPerms, startOnboarding };

  function start() {
    shell();
    const m = /[?&#]preview=([a-z0-9]+)/.exec(location.search + location.hash);
    if (m) setTimeout(() => preview(m[1]), 300);
    else wire();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
