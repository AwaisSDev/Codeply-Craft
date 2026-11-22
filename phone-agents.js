// Agents: your team on the phone, as the desktop app shows it. Codeply (Wisp) and how things stand,
// what needs you first, each specialist with its own face and what it is doing, the loops (standing
// jobs) with a switch each, and a plain record of what they did. The data and the sheets are
// phone-specialists.js's (the same account tables the PC uses), so a change here shows on the PC.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const P = () => window.CraftPhone || {};
  const S = () => window.CraftSpecialists || {};
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const svg = (d, w = 20) => `<svg viewBox="0 0 24 24" width="${w}" height="${w}" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const I = {
    back: svg('<path d="M15 5l-7 7 7 7"/>', 22),
    plus: svg('<path d="M12 5v14M5 12h14"/>', 22),
    chev: '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>',
    clock: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
    target: svg('<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1"/>'),
    bell: svg('<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15Z"/><path d="M10 20a2 2 0 0 0 4 0"/>'),
    ok: '<svg class="ok" viewBox="0 0 16 16" width="16" height="16" aria-label="Done"><circle cx="8" cy="8" r="7.2" fill="currentColor"/><path d="M4.9 8.2l2.1 2.1 4.1-4.4" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    bad: '<svg class="bad" viewBox="0 0 16 16" width="16" height="16" aria-label="Did not finish"><circle cx="8" cy="8" r="7.2" fill="currentColor"/><path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></svg>',
  };
  const ago = (t) => {
    const s = Math.round((Date.now() - t) / 1000);
    return s < 90 ? 'now' : s < 5400 ? `${Math.round(s / 60)}m` : s < 129600 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
  };
  const at = (t) => new Date(t).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  const DAY = 86400000;

  let sample = null; // preview data (phone-app.js ?preview=agents)
  const data = () => sample || S().team || { list: [], jobs: [], runs: [], loaded: false };

  function face(slot, s, size = 'sm', mood = 'happy') {
    if (!slot) return;
    slot.innerHTML = '';
    if (S().face) { S().face(slot, s, size, mood); return; }
    const W = window.CraftWisp;
    try { if (W && W.avatar) slot.appendChild(W.avatar({ size, mood, look: s && s.shape ? { shape: s.shape, color: s.color, gear: s.gear || undefined } : undefined })); } catch { /* no face */ }
  }

  /** One line for what a specialist is up to, and how it is doing: { text, tone: on|warn|bad|'' }. */
  function stateOf(s, d) {
    const jobs = d.jobs.filter((j) => j.specialist === s.id && j.enabled !== false);
    const last = d.runs.find((r) => r.specialist === s.id && r.job_id !== 'chat');
    const stuck = jobs.find((j) => j.needsYou);
    if (stuck) return { text: 'Needs you', tone: 'warn' };
    const retry = jobs.find((j) => j.failures && j.nextAt);
    if (retry) return { text: `Trying again ${at(retry.nextAt)}`, tone: 'warn' };
    if (last && !last.ok && Date.now() - Date.parse(last.at) < DAY) return { text: 'Last job did not finish', tone: 'bad' };
    if (last && Date.now() - Date.parse(last.at) < 2 * 3600e3) return { text: `Worked ${ago(Date.parse(last.at))} ago`, tone: 'on' };
    if (jobs.length) {
      const next = jobs.filter((j) => j.nextAt).sort((a, b) => a.nextAt - b.nextAt)[0];
      return { text: next ? `Next ${at(next.nextAt)}` : `${jobs.length} loop${jobs.length > 1 ? 's' : ''}`, tone: s.alwaysOn ? 'on' : '' };
    }
    return { text: s.alwaysOn ? 'Always on' : 'Ready when you are', tone: s.alwaysOn ? 'on' : '' };
  }

  /** What needs the user, newest first: a loop that gave up, a job that failed today. */
  function needsOf(d) {
    const out = [];
    for (const j of d.jobs) {
      if (!j.needsYou) continue;
      const s = d.list.find((x) => x.id === j.specialist);
      out.push({ s, title: `${s ? s.name : 'A specialist'}: ${String(j.task || '').slice(0, 80)}`, why: j.needsYou });
    }
    for (const r of d.runs) {
      if (r.ok || r.job_id === 'chat' || Date.now() - Date.parse(r.at) > DAY) continue;
      const s = d.list.find((x) => x.id === r.specialist);
      if (out.some((n) => n.s && s && n.s.id === s.id)) continue;
      out.push({ s, title: `${s ? s.name : 'A job'} did not finish`, why: String(r.output || r.task || '').replace(/\s+/g, ' ').slice(0, 140) });
    }
    return out.slice(0, 4);
  }

  function panel() {
    let p = $('agentsPanel');
    if (p) return p;
    p = document.createElement('section');
    p.className = 'panel hidden'; p.id = 'agentsPanel'; p.setAttribute('role', 'dialog'); p.setAttribute('aria-modal', 'true'); p.setAttribute('aria-label', 'Agents');
    p.innerHTML = `<header class="top"><button class="icon-btn" data-back aria-label="Back">${I.back}</button><div class="top-title ag-bar-title" aria-hidden="true">Agents</div><button class="icon-btn" data-new aria-label="New agent">${I.plus}</button></header><div class="panel-body"></div>`;
    document.body.appendChild(p);
    p.querySelector('[data-back]').addEventListener('click', () => p.classList.add('hidden'));
    p.querySelector('[data-new]').addEventListener('click', () => S().makeSheet && S().makeSheet());
    // The large title settles into the bar as you scroll (iOS).
    const body = p.querySelector('.panel-body');
    const bar = p.querySelector('.ag-bar-title');
    bar.style.opacity = '0';
    body.addEventListener('scroll', () => { bar.style.opacity = body.scrollTop > 34 ? '1' : '0'; }, { passive: true });
    bar.style.transition = 'opacity .18s ease';
    return p;
  }

  async function open(opts = {}) {
    sample = opts.sample || null;
    const p = panel();
    p.parentNode.appendChild(p);
    p.classList.remove('hidden');
    render();
    if (!sample && S().loadTeam) { await S().loadTeam(); render(); }
  }

  function render() {
    const p = $('agentsPanel'); if (!p) return;
    const body = p.querySelector('.panel-body');
    const d = data();
    if (d.missing) { body.innerHTML = `<h1 class="v5-large ag-large">Agents</h1><p class="ag-empty">Your team isn't set up in your account yet. Open Codeply on your PC once and it shows up here.</p>`; return; }
    if (!d.loaded && !d.list.length) { body.innerHTML = `<h1 class="v5-large ag-large">Agents</h1><p class="ag-empty">Getting your team…</p>`; return; }
    const needs = needsOf(d);
    const loops = d.jobs.slice().sort((a, b) => (a.nextAt || Infinity) - (b.nextAt || Infinity));
    const runs = d.runs.filter((r) => r.job_id !== 'chat').slice(0, 6);
    const working = d.list.filter((s) => stateOf(s, d).tone === 'on').length;
    const heroLine = needs.length ? `${needs.length} thing${needs.length > 1 ? 's' : ''} need${needs.length > 1 ? '' : 's'} you` : 'All on track';
    const heroSub = `${d.list.length} on your team${loops.length ? `, ${loops.length} loop${loops.length > 1 ? 's' : ''}` : ''}${working ? `, ${working} active` : ''}`;
    const name = (id) => (d.list.find((s) => s.id === id) || {}).name || id;
    body.innerHTML = `
      <h1 class="v5-large ag-large">Agents</h1>
      <button type="button" class="ag-hero" data-wisp><span class="ag-hero-face"></span><span><b>Codeply</b><small>${esc(heroLine)}. ${esc(heroSub)}.</small></span>${I.chev}</button>
      ${needs.length ? `<div class="ag-sec"><h2>Needs you</h2></div><div class="ag-needs">${needs.map((n, i) => `<button type="button" class="ag-need" data-need="${i}"><span class="ag-face"></span><span><b>${esc(n.title)}</b><small>${esc(n.why)}</small></span></button>`).join('')}</div>` : ''}
      <div class="ag-sec"><h2>Team</h2><span>${d.list.length}</span></div>
      <div class="ag-grid">${d.list.map((s, i) => { const st = stateOf(s, d); return `<button type="button" class="ag-card" data-spec="${i}" aria-label="${esc(s.name)}, ${esc(st.text)}"><span class="ag-face"></span><b>${esc(s.name)}</b><small>${esc(s.focus || '')}</small><span class="ag-state"><i class="ag-dot ${st.tone}"></i>${esc(st.text)}</span></button>`; }).join('')}
        <button type="button" class="ag-card ag-new" data-make>${I.plus}<b>New agent</b><small>Describe it; Codeply writes it.</small></button></div>
      <div class="ag-sec"><h2>Loops</h2>${loops.length ? `<span>${loops.length}</span>` : ''}</div>
      ${loops.length ? `<div class="ag-list">${loops.map((j, i) => `<div class="ag-row" data-loop="${i}"><span class="ag-ico">${I.clock}</span><span class="ag-main"><b>${esc(j.task)}</b><small>${esc(name(j.specialist))} · ${esc(j.when || (S().describeRule ? S().describeRule(j.rule) : ''))}${j.needsYou ? ' · needs you' : j.failures ? ' · trying again' : ''}</small></span><label class="ag-switch"><input type="checkbox" ${j.enabled !== false ? 'checked' : ''} aria-label="Run ${esc(j.task)}"><i></i></label></div>`).join('')}</div>`
        : `<p class="ag-empty">No loops yet. Tell any agent "every morning, check…" in a chat and it becomes one.</p>`}
      <div class="ag-sec"><h2>Shortcuts</h2></div>
      <div class="ag-list">
        <button type="button" class="ag-row" data-go="tasks"><span class="ag-ico">${I.target}</span><span class="ag-main"><b>Mission control</b><small>Work on your PC and in the cloud</small></span>${I.chev}</button>
        <button type="button" class="ag-row" data-go="reminders"><span class="ag-ico">${I.bell}</span><span class="ag-main"><b>Reminders</b><small>What's coming up</small></span>${I.chev}</button>
      </div>
      ${runs.length ? `<div class="ag-sec"><h2>Activity</h2></div><div class="ag-list">${runs.map((r, i) => `<button type="button" class="ag-row" data-run="${i}"><span class="ag-face"></span><span class="ag-main"><b>${esc(r.task || 'A job')}</b><small>${esc(name(r.specialist))} · ${esc({ pc: 'on your PC', cloud: 'in the cloud', phone: 'on this phone' }[r.origin] || '')}</small></span>${r.ok ? I.ok : I.bad}<time>${esc(ago(Date.parse(r.at)))}</time></button>`).join('')}</div>` : ''}
      <p class="ag-foot">Type @ and a name in any chat to hand a job to one of them. Always-on agents keep their loops running with your PC off.</p>`;

    face(body.querySelector('.ag-hero-face'), null, 'md', needs.length ? 'thinking' : 'happy');
    body.querySelectorAll('[data-spec]').forEach((b) => face(b.querySelector('.ag-face'), d.list[Number(b.dataset.spec)], 'sm'));
    body.querySelectorAll('[data-need]').forEach((b) => face(b.querySelector('.ag-face'), needs[Number(b.dataset.need)].s, 'sm', 'worried'));
    body.querySelectorAll('[data-run]').forEach((b) => face(b.querySelector('.ag-face'), d.list.find((s) => s.id === runs[Number(b.dataset.run)].specialist), 'sm'));

    const sheetFor = (s) => { if (s && S().detailSheet && !sample) S().detailSheet(s); };
    body.querySelectorAll('[data-spec]').forEach((b) => b.addEventListener('click', () => sheetFor(d.list[Number(b.dataset.spec)])));
    body.querySelectorAll('[data-need]').forEach((b) => b.addEventListener('click', () => sheetFor(needs[Number(b.dataset.need)].s)));
    body.querySelectorAll('[data-run]').forEach((b) => b.addEventListener('click', () => sheetFor(d.list.find((s) => s.id === runs[Number(b.dataset.run)].specialist))));
    const make = body.querySelector('[data-make]');
    if (make) make.addEventListener('click', () => S().makeSheet && S().makeSheet());
    body.querySelector('[data-wisp]').addEventListener('click', () => { p.classList.add('hidden'); const nc = $('newChatTopBtn'); if (nc && !sample) nc.click(); });
    body.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => {
      if (sample) return;
      p.classList.add('hidden');
      if (b.dataset.go === 'tasks') { const t = $('drawerTasks'); if (t) t.click(); } else if (window.CraftReminders && window.CraftReminders.openPanel) window.CraftReminders.openPanel();
    }));
    body.querySelectorAll('[data-loop]').forEach((row) => {
      const j = loops[Number(row.dataset.loop)];
      row.querySelector('input').addEventListener('change', (e) => toggle(j, e.target.checked, e.target));
    });
  }

  /** Turn a loop on or off, in the account, so the PC and the server timer see it too. */
  async function toggle(j, on, input) {
    if (sample) { j.enabled = on; hop(); return; }
    const sb = P().sb;
    try {
      if (!sb) throw new Error('Sign in to Codeply first.');
      const now = Date.now();
      const next = { ...j, enabled: on, updatedAt: now };
      delete next.nextAt;
      const { error } = await sb.from('specialist_jobs').update({ data: { ...next, nextAt: j.nextAt || null }, updated_at: new Date(now).toISOString() }).eq('id', j.id);
      if (error) throw error;
      j.enabled = on;
      if (on) hop();
      if (S().toast) S().toast(on ? 'Loop is on' : 'Loop is off');
    } catch (err) {
      input.checked = !on;
      if (S().toast) S().toast(err.message || 'Could not change it.');
    }
  }

  /** Codeply's face does a small hop: something good just happened. */
  function hop() {
    const f = document.querySelector('#agentsPanel .ag-hero-face');
    if (!f) return;
    f.classList.remove('v5-hop'); void f.offsetWidth; f.classList.add('v5-hop');
  }

  /** The sidebar row: Agents, with the first few faces and a count of what needs you. */
  function drawerRow() {
    const nav = $('drawerNav');
    if (!nav || $('drawerAgents')) return;
    const b = document.createElement('button');
    b.className = 'drawer-item'; b.id = 'drawerAgents'; b.type = 'button';
    b.innerHTML = `${svg('<circle cx="9" cy="9" r="3.2"/><path d="M3.5 19c.6-3 2.8-4.8 5.5-4.8s4.9 1.8 5.5 4.8"/><circle cx="17" cy="10" r="2.6"/><path d="M15.5 14.4c2.4-.3 4.4 1.2 5 4.1"/>', 22)}<span>Agents</span><span class="v5-faces" aria-hidden="true"></span><span class="v5-count hidden" id="agentsBadge"></span>`;
    const after = $('drawerNewChat');
    if (after && after.nextSibling) nav.insertBefore(b, after.nextSibling); else nav.appendChild(b);
    b.addEventListener('click', () => { if (P().closeDrawer) P().closeDrawer(); open(); });
  }
  function refreshDrawer() {
    const d = data();
    const faces = document.querySelector('#drawerAgents .v5-faces');
    if (faces && !faces.childElementCount && d.list.length) {
      d.list.slice(0, 3).forEach((s) => { const slot = document.createElement('span'); faces.appendChild(slot); face(slot, s, 'sm'); });
    }
    // Home: one line on how the team is doing, under the greeting; tap it for Agents.
    const home = $('homeStatus');
    if (home && d.loaded && d.list.length) {
      const n = needsOf(d).length;
      home.querySelector('span').textContent = n ? `${n} thing${n > 1 ? 's' : ''} need${n > 1 ? '' : 's'} you` : `Your team is on track`;
      home.classList.toggle('warn', !!n);
      home.classList.remove('hidden');
      if (!home.dataset.wired) { home.dataset.wired = '1'; home.addEventListener('click', () => open()); }
    }
    const badge = $('agentsBadge');
    if (badge) { const n = needsOf(d).length; badge.textContent = String(n); badge.classList.toggle('hidden', !n); badge.classList.toggle('on', !!n); }
  }

  function init() {
    drawerRow();
    const menu = $('menuBtn');
    if (menu) menu.addEventListener('click', () => setTimeout(refreshDrawer, 0));
    setTimeout(() => { if (S().loadTeam && P().state && P().state.user) S().loadTeam().then(refreshDrawer).catch(() => {}); }, 3000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

  window.CraftAgents = { open, render, refreshDrawer };
})();
