// Crew's Brain page (window.CrewBrain): what every Codeply app and bot knows
// about the user, in the user's hands.
//
//   Needs a look   memories the bots heard contradicted, with Keep / Switch / Undo
//   About you      preferences, facts, routines, how they like to work
//   Right now      temporary context, with when it runs out
//   Projects       decisions, ideas, requirements and to-dos, per project
//   From the team  lessons a bot learned and shared with the others
//   Who handles    which jobs each bot takes handoffs for
//   Handed on      work the bots passed to each other, and how it went
//   Changes        what was learned, replaced, ignored or forgotten, and when
//
// Everything comes from the main process (brain-desktop.js) through
// window.crew.brain*; this file only draws and sends the user's choices back.
(() => {
  const api = window.crew;
  const { esc } = window.CrewMarkdown;
  const $ = (sel, root = document) => root.querySelector(sel);
  const S = () => window.CrewState;
  let brain = null;
  let open = false;
  let filter = '';
  let editing = '';

  const G = (d) => `<svg viewBox="0 0 24 24">${d}</svg>`;
  const ICON = {
    brain: '<svg viewBox="0 0 24 24"><path d="M9 4.5a3 3 0 0 0-3 3 3 3 0 0 0-1.5 5.3A3 3 0 0 0 7 17.5a2.5 2.5 0 0 0 5 .5V5.5a2 2 0 0 0-3-1z"/><path d="M15 4.5a3 3 0 0 1 3 3 3 3 0 0 1 1.5 5.3 3 3 0 0 1-2.5 4.7 2.5 2.5 0 0 1-5 .5"/></svg>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    edit: '<path d="M5 19h3.5L18 9.5 14.5 6 5 15.5z"/><path d="m13 7.5 3.5 3.5"/>',
  };
  const TILE = {
    me: { c: '#0a84ff', i: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 19.5a7 7 0 0 1 14 0"/>' },
    now: { c: '#ff9f0a', i: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>' },
    project: { c: '#30d158', i: '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.2h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>' },
    team: { c: '#bf5af2', i: '<circle cx="9" cy="9" r="3"/><circle cx="16.5" cy="10" r="2.5"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0M14 19a4.5 4.5 0 0 1 7 0"/>' },
    review: { c: '#ff453a', i: '<path d="M12 4 21 19H3z"/><path d="M12 10v4M12 17h.01"/>' },
    hand: { c: '#64d2ff', i: '<path d="M4 12h12M12 7l5 5-5 5"/><path d="M20 5v14"/>' },
  };
  const DOMAIN_LABEL = { calendar: 'Calendar', email: 'Email', reminders: 'Reminders', calls: 'Calls', texts: 'Texts', research: 'Research', code: 'Code', social: 'Social', health: 'Health', money: 'Money' };
  const STATUS = { confirmed: 'Confirmed', tentative: 'Not sure yet', temporary: 'For now' };
  const HSTATUS = { open: 'waiting', queued: 'working', done: 'done', needs_user: 'needs you', failed: 'could not finish', cancelled: 'cancelled', unrouted: 'nobody for it' };

  const ago = (t) => {
    if (!t) return '';
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
  };
  const until = (t) => {
    const m = Math.round((t - Date.now()) / 60000);
    if (m <= 0) return 'ending';
    if (m < 60) return `for ${m} more min`;
    const h = Math.round(m / 60);
    return h < 48 ? `for ${h} more h` : `for ${Math.round(h / 24)} more days`;
  };
  const tile = (ic) => `<span class="lf-ico" style="background:${ic.c}">${G(ic.i)}</span>`;
  const sw = (attrs, on) => `<label class="lf-switch"><input type="checkbox" ${attrs} ${on ? 'checked' : ''}><span></span></label>`;
  const group = (title, body, aside = '') => `<section class="lf-group"><div class="lf-group-head"><h2>${title}</h2>${aside}</div><div class="lf-rows">${body}</div></section>`;
  const toast = (t, k) => (window.crewToast ? window.crewToast(t, k) : null);
  const where = (m) => {
    const s = (m.sources || [])[m.sources.length - 1];
    if (!s) return '';
    if (s.product === 'you') return 'you';
    return [s.botName, s.product && s.product[0].toUpperCase() + s.product.slice(1)].filter(Boolean).join(' in ');
  };

  async function refresh() {
    try { brain = await api.brainState(); } catch { brain = null; }
    if (open) paint();
    return brain;
  }

  // ─── Rows ─────────────────────────────────────────────────────────────────

  function memoryRow(m, icon) {
    if (editing === m.id) {
      return `<div class="lf-row br-edit" data-mem="${esc(m.id)}">${icon ? tile(icon) : ''}<input class="br-input" data-edit-text value="${esc(m.text)}" maxlength="280" aria-label="Memory"><div class="lf-row-right"><button class="lf-btn small primary" data-save="${esc(m.id)}">Save</button><button class="lf-btn small ghost" data-cancel-edit>Cancel</button></div></div>`;
    }
    const kind = (brain.kinds || {})[m.kind] || m.kind;
    const status = m.kind === 'context' ? '' : m.locked ? 'Set by you' : (STATUS[m.status] || m.status);
    const meta = [kind, status, m.kind === 'context' && m.expiresAt ? until(m.expiresAt) : '', m.evidence > 1 ? `heard ${m.evidence}x` : '', where(m) ? `from ${where(m)}` : '', ago(m.updatedAt)].filter(Boolean).join(' · ');
    const confirm = !m.locked && m.kind !== 'context' ? `<button class="br-act" data-confirm="${esc(m.id)}" title="That's right">${G(ICON.check)}</button>` : '';
    return `<div class="lf-row${m.status === 'tentative' ? ' br-unsure' : ''}" data-mem="${esc(m.id)}">${icon ? tile(icon) : ''}<div class="lf-row-text"><div class="lf-row-title br-text">${esc(m.text)}</div><div class="lf-row-sub">${esc(meta)}</div></div>
      <div class="lf-row-right">${confirm}<button class="br-act" data-edit="${esc(m.id)}" title="Correct it">${G(ICON.edit)}</button><button class="br-act danger" data-forget="${esc(m.id)}" title="Forget it">${G(ICON.x)}</button></div></div>`;
  }

  function reviewRow(m) {
    const prev = (m.history || [])[m.history.length - 1];
    const heard = m.challenger;
    const lines = heard
      ? `<div class="lf-row-title">${esc(m.text)}</div><div class="lf-row-sub">But ${esc(heard.from || 'a bot')} heard: "${esc(heard.text)}"${heard.count > 1 ? ` (${heard.count} times)` : ''}</div>`
      : `<div class="lf-row-title">${esc(m.text)}</div><div class="lf-row-sub">${prev ? `Was: "${esc(prev.text)}". ` : ''}Changed because it came up again.</div>`;
    const btns = heard
      ? `<button class="lf-btn small" data-resolve="${esc(m.id)}" data-choice="keep">Keep</button><button class="lf-btn small primary" data-resolve="${esc(m.id)}" data-choice="switch">Switch</button>`
      : `<button class="lf-btn small primary" data-confirm="${esc(m.id)}">That's right</button>${prev ? `<button class="lf-btn small" data-resolve="${esc(m.id)}" data-choice="undo">Undo</button>` : ''}`;
    return `<div class="lf-row" data-mem="${esc(m.id)}">${tile(TILE.review)}<div class="lf-row-text">${lines}</div><div class="lf-row-right">${btns}</div></div>`;
  }

  function handlesHtml(b) {
    const own = new Set(b.handles || []);
    const shown = own.size ? own : new Set(b.inferred || []);
    const chips = (brain.domains || []).map((d) => `<button class="br-chip${shown.has(d) ? ' on' : ''}${!own.size && shown.has(d) ? ' guessed' : ''}" data-handle="${esc(b.id)}" data-domain="${esc(d)}" aria-pressed="${shown.has(d)}">${esc(DOMAIN_LABEL[d] || d)}</button>`).join('');
    return `<div class="lf-row br-handles"><div class="lf-row-text"><div class="lf-row-title">${esc(b.name)}${b.autonomy === 'none' ? '<span class="lf-pill">suggests only</span>' : ''}</div><div class="lf-row-sub">${own.size ? 'Takes handoffs for these' : shown.size ? 'Guessed from its job; tap to set' : 'Takes no handoffs yet; tap a job'}</div><div class="br-chips">${chips}</div></div></div>`;
  }

  // ─── The page ─────────────────────────────────────────────────────────────

  function paint() {
    const view = $('#view');
    if (!view || !open) return;
    const b = brain;
    if (!b || b.error) {
      view.innerHTML = `<div class="lf"><div class="lf-head"><h1>Brain</h1></div><div class="lf-tip bad">${G('<circle cx="12" cy="12" r="8.5"/><path d="M12 8v5M12 16h.01"/>')}<span>${esc((b && b.error) || 'The brain did not load.')}</span></div></div>`;
      return;
    }
    const scroll = view.querySelector('.lf') ? view.querySelector('.lf').scrollTop : 0;
    const head = `<div class="lf-head"><div><h1>Brain</h1><p>What Codeply knows about you, from your chats, agents, voice and phone. Fix anything that's wrong.</p></div>
      <label class="lf-onoff"><span>${b.on ? 'On' : 'Off'}</span>${sw('data-brain-on', b.on)}</label></div>`;
    if (!b.on) {
      view.innerHTML = `<div class="lf">${head}<div class="lf-tip">${G('<circle cx="12" cy="12" r="8.5"/><path d="M12 8v5M12 16h.01"/>')}<span>${b.usable ? 'Off: nothing is learned, and no app or bot sees what was learned before.' : 'This PC has no SQLite driver, so the brain cannot be kept here.'}</span></div></div>`;
      wire(view);
      return;
    }
    const f = filter.trim().toLowerCase();
    const mems = (b.memories || []).filter((m) => !f || `${m.text} ${m.slot} ${m.value} ${m.project}`.toLowerCase().includes(f));
    const review = mems.filter((m) => m.review || (m.challenger && m.challenger.count >= 1));
    const reviewIds = new Set(review.map((m) => m.id));
    const personal = mems.filter((m) => m.scope === 'me' && m.kind !== 'context' && !reviewIds.has(m.id));
    const live = mems.filter((m) => m.kind === 'context');
    const lessons = mems.filter((m) => m.kind === 'lesson');
    const byProject = new Map();
    for (const m of mems) if (m.project && m.kind !== 'context' && !reviewIds.has(m.id)) { if (!byProject.has(m.project)) byProject.set(m.project, []); byProject.get(m.project).push(m); }
    const projName = (k) => ((b.projects || []).find((p) => p.key === k) || {}).name || k;

    let html = head;
    html += `<div class="lf-ask"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input id="brainFilter" placeholder="Find something it knows" value="${esc(filter)}" autocomplete="off"></div>`;
    html += `<form class="br-add" id="brainAdd"><input class="br-input" name="text" placeholder="Tell it something: I prefer short replies" maxlength="280" autocomplete="off" aria-label="Something to remember">
      <select class="lf-select" name="kind" aria-label="Kind">${['preference', 'fact', 'routine', 'style', 'decision', 'idea', 'requirement', 'todo', 'context'].map((k) => `<option value="${k}">${esc((b.kinds || {})[k] || k)}</option>`).join('')}</select>
      <select class="lf-select" name="project" aria-label="Project"><option value="">About me</option>${(b.projects || []).map((p) => `<option value="${esc(p.key)}">${esc(p.name)}</option>`).join('')}</select>
      <button class="lf-btn primary small" type="submit">Remember</button></form>`;
    if (review.length) html += group('Needs a look', review.map(reviewRow).join(''), '<span class="lf-aside">Heard something different</span>');
    html += group('About you', personal.length ? personal.map((m) => memoryRow(m, TILE.me)).join('') : '<div class="lf-row"><div class="lf-row-text"><div class="lf-row-sub">Nothing yet. Your bots learn as you talk to them, in any Codeply app.</div></div></div>');
    if (live.length) html += group('Right now', live.map((m) => memoryRow(m, TILE.now)).join(''), '<span class="lf-aside">Runs out by itself</span>');
    for (const [key, list] of byProject) {
      html += group(`Project: ${esc(projName(key))}`, list.map((m) => memoryRow(m, TILE.project)).join(''), `<button class="lf-btn small ghost" data-clear="project:${esc(key)}">Forget this project</button>`);
    }
    if (lessons.length) html += group('From the team', lessons.map((m) => memoryRow(m, TILE.team)).join(''), '<span class="lf-aside">Shown to a bot only when it fits</span>');
    if ((b.bots || []).length) html += group('Who handles what', b.bots.map(handlesHtml).join(''), '<span class="lf-aside">Bots hand work to each other by this</span>');
    const hs = b.handoffs || [];
    if (hs.length) {
      html += group('Handed on', hs.map((h) => `<div class="lf-row">${tile(TILE.hand)}<div class="lf-row-text"><div class="lf-row-title">${esc(h.fromName || 'Codeply')} → ${esc(h.toName || 'nobody')}</div><div class="lf-row-sub">${esc(h.intent)}${h.result ? ` · ${esc(h.result.slice(0, 200))}` : ''}</div></div><div class="lf-row-right"><span class="lf-status s-${esc(h.status === 'queued' ? 'running' : h.status === 'needs_user' ? 'needs_you' : h.status)}">${esc(HSTATUS[h.status] || h.status)}</span><span class="lf-meta">${esc(ago(h.updatedAt))}</span></div></div>`).join(''));
    }
    const ch = b.changes || [];
    if (ch.length) html += `<details class="lf-more"><summary>What changed (${ch.length})</summary>${ch.map((c) => `<div class="lf-li"><b>${esc(c.action)}</b><span>${esc(c.text)}${c.source ? ` · ${esc(c.source)}` : ''}</span><em>${esc(ago(c.at))}</em></div>`).join('')}</details>`;
    html += `<div class="lf-private">${G('<rect x="5" y="10.5" width="14" height="9.5" rx="2.5"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>')}Stays on this PC. Jokes, sarcasm and secrets are never kept.<button class="lf-btn small danger" data-clear="all">Forget everything</button></div>`;
    view.innerHTML = `<div class="lf br">${html}</div>`;
    if (view.querySelector('.lf')) view.querySelector('.lf').scrollTop = scroll;
    wire(view);
  }

  async function act(p) {
    const r = await p;
    if (r && r.error) { toast(r.error, 'error'); return; }
    if (r && !r.error) { brain = r; paint(); }
  }

  function wire(view) {
    const on = (sel, ev, fn) => view.querySelectorAll(sel).forEach((el) => el.addEventListener(ev, () => fn(el)));
    on('[data-brain-on]', 'change', (el) => act(api.brainEnable(el.checked)));
    on('[data-confirm]', 'click', (el) => act(api.brainConfirm(el.dataset.confirm)));
    on('[data-forget]', 'click', (el) => act(api.brainForget(el.dataset.forget)));
    on('[data-resolve]', 'click', (el) => act(api.brainResolve(el.dataset.resolve, el.dataset.choice)));
    on('[data-edit]', 'click', (el) => { editing = el.dataset.edit; paint(); const i = $('[data-edit-text]', view.ownerDocument); if (i) { i.focus(); i.select(); } });
    on('[data-cancel-edit]', 'click', () => { editing = ''; paint(); });
    on('[data-save]', 'click', (el) => {
      const i = $('[data-edit-text]', view);
      const text = i ? i.value.trim() : '';
      editing = '';
      act(api.brainCorrect(el.dataset.save, { text }));
    });
    view.querySelectorAll('[data-edit-text]').forEach((i) => i.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); const id = i.closest('[data-mem]').dataset.mem; editing = ''; act(api.brainCorrect(id, { text: i.value.trim() })); }
      if (e.key === 'Escape') { editing = ''; paint(); }
    }));
    on('[data-clear]', 'click', (el) => {
      const scope = el.dataset.clear === 'all' ? '' : el.dataset.clear;
      if (el.dataset.armed !== '1') { el.dataset.armed = '1'; el.textContent = 'Tap again to forget'; setTimeout(() => { if (el.isConnected) { el.dataset.armed = ''; paint(); } }, 3000); return; }
      act(api.brainClear(scope));
    });
    on('[data-handle]', 'click', (el) => {
      const bot = (brain.bots || []).find((x) => x.id === el.dataset.handle);
      if (!bot) return;
      const cur = new Set(bot.handles && bot.handles.length ? bot.handles : bot.inferred || []);
      if (cur.has(el.dataset.domain)) cur.delete(el.dataset.domain); else cur.add(el.dataset.domain);
      act(api.brainHandles(bot.id, [...cur]));
    });
    const fi = $('#brainFilter', view);
    if (fi) {
      let t = null;
      fi.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { filter = fi.value; paint(); const n = $('#brainFilter'); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } }, 200); });
    }
    const add = $('#brainAdd', view);
    if (add) add.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(add);
      const text = String(fd.get('text') || '').trim();
      if (!text) return;
      const kind = String(fd.get('kind'));
      const project = String(fd.get('project') || '');
      act(api.brainAdd({ text, kind, project: ['decision', 'idea', 'requirement', 'todo'].includes(kind) ? project : '' }));
    });
  }

  function show() {
    open = true;
    const st = S();
    st.current = null; st.currentGroup = null;
    if (window.CrewLife) window.CrewLife.hide();
    document.querySelectorAll('.bot-item.on').forEach((x) => x.classList.remove('on'));
    const nav = $('#brainNav'); if (nav) nav.classList.add('on');
    paint();
    refresh();
  }
  function hide() { open = false; editing = ''; const nav = $('#brainNav'); if (nav) nav.classList.remove('on'); }
  function onState(st) { brain = st; if (open && !editing) paint(); }

  // The sidebar entry, under Life.
  function addNav() {
    const anchor = document.querySelector('#lifeNav') || document.querySelector('.side-new');
    if (!anchor || $('#brainNav')) return;
    anchor.insertAdjacentHTML('afterend', `<button class="side-new" id="brainNav">${ICON.brain}<span>Brain</span></button>`);
    $('#brainNav').addEventListener('click', () => show());
  }
  addNav();

  window.CrewBrain = { show, hide, isOpen: () => open, refresh, onState };
})();
