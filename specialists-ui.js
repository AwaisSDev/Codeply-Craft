// The Specialists window (sidebar: Specialists). Codeply's team: the built-in
// specialists and the ones you or Codeply made. Each has its own face,
// instructions (its system prompt), model and scheduled jobs.
//
//   - New specialist: describe what it should do (and a name if you like);
//     Codeply writes its instructions, a focus and a look. Edit anything, Create.
//     Or ask in any chat: "make me a specialist that ...", and Codeply does it.
//   - Open one: rename it, change its look, model and instructions, chat with it
//     directly, or give it scheduled jobs in plain words ("every Monday at 9").
// Codeply brings them in for bigger jobs; you can turn that off at the top.
// Loaded after wisp-ui.js; takes over CraftWispUI.openTeam.
(() => {
  const api = window.craft;
  if (!api || !api.wispState) return;
  const h = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ico = (n, c = 'ico-sm') => (typeof icon === 'function' ? icon(n, c) : '');
  const W = () => window.CraftWisp;
  const SHAPES = ['circle', 'blob', 'cloud', 'triangle', 'square', 'hexagon', 'star', 'spiky'];
  const COLORS = ['#1f8bff', '#86d41f', '#ffbe0b', '#ff2fa8', '#ff6b2c', '#8f5bff', '#00c2a8', '#ff3b5c', '#22b8f0', '#c45cff'];
  const GEAR = ['', 'glasses', 'shades', 'cap', 'headphones', 'crown', 'sprout', 'flower', 'antennae', 'star', 'bow', 'beret'];
  const ago = (t) => { const s = Math.round((Date.now() - t) / 1000); return s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };
  const when = (t) => new Date(t).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });

  let st = { enabled: true, team: [], models: [] };
  let sel = null;      // the open specialist's id, or 'new'
  let draft = null;    // the specialist being made
  let busy = false;
  let faces = [];      // mounted faces, removed on redraw

  const root = () => document.getElementById('specialistsBackdrop');
  const one = (id) => st.team.find((s) => s.id === id) || null;
  const lookOf = (s) => (s && s.shape ? { shape: s.shape, color: s.color, gear: s.gear || undefined } : null);
  function face(slot, s, size, mood) {
    if (!slot || !W()) return;
    const el = W().avatar({ size: size || 'sm', mood: mood || 'neutral', look: lookOf(s) || undefined });
    slot.appendChild(el);
    faces.push(el);
  }
  function dropFaces() { for (const f of faces) if (f.wisp) f.wisp.destroy(); faces = []; }

  async function load(next) {
    const r = next || await api.wispState().catch(() => null);
    if (r && Array.isArray(r.team)) st = r;
  }

  async function open(id) {
    close();
    const back = document.createElement('div');
    back.id = 'specialistsBackdrop';
    back.className = 'sx-backdrop';
    back.innerHTML = `<div class="sx" role="dialog" aria-modal="true" aria-label="Specialists">
      <aside class="sx-side">
        <div class="sx-side-top"><b>Specialists</b><button type="button" class="sx-x" aria-label="Close">${ico('close')}</button></div>
        <button type="button" class="sx-new">${ico('plus')}<span>New specialist</span></button>
        <div class="sx-list"></div>
        <label class="sx-switch"><input type="checkbox"><i></i><span>Codeply can bring them in</span></label>
        <div class="sx-sync"></div>
      </aside>
      <main class="sx-main"></main>
    </div>`;
    document.body.appendChild(back);
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
    back.querySelector('.sx-x').addEventListener('click', close);
    back.querySelector('.sx-new').addEventListener('click', () => { sel = 'new'; draft = null; paint(); });
    back.querySelector('.sx-switch input').addEventListener('change', async (e) => { await load(await api.wispSet(e.target.checked)); paint(); });
    document.addEventListener('keydown', onKey);
    await load();
    sel = id || (st.team.find((s) => !s.builtin) || st.team[0] || {}).id || 'new';
    paint();
    // Then whatever changed on the phone or in the cloud since the last sync.
    if (api.wispSync) api.wispSync().then((r) => { if (r && Array.isArray(r.team) && root()) { st = r; if (sel !== 'new') paint(); } }).catch(() => {});
  }
  function onKey(e) { if (e.key === 'Escape' && root() && !e.target.closest('textarea, input')) close(); }
  function close() { dropFaces(); const r = root(); if (r) r.remove(); document.removeEventListener('keydown', onKey); }

  function paint() {
    const back = root();
    if (!back) return;
    dropFaces();
    back.querySelector('.sx-switch input').checked = st.enabled !== false;
    const sy = st.sync || {};
    const syncEl = back.querySelector('.sx-sync');
    syncEl.className = `sx-sync ${sy.state || 'off'}`;
    syncEl.innerHTML = sy.state === 'on' ? '<i></i>Synced with your account and phone'
      : sy.state === 'setup' ? '<i></i>Account sync needs its database tables (supabase/specialists.sql)'
      : sy.state === 'error' ? `<i></i>Could not sync: ${h(sy.error || 'offline')}`
      : '<i></i>Sign in to sync with your phone';
    back.querySelector('.sx-new').classList.toggle('on', sel === 'new');
    const mine = st.team.filter((s) => !s.builtin);
    const built = st.team.filter((s) => s.builtin);
    const row = (s) => `<button type="button" class="sx-row${s.id === sel ? ' on' : ''}" data-id="${h(s.id)}"><span class="sx-face" data-face="${h(s.id)}"></span><span class="sx-row-text"><b>${h(s.name)}${s.alwaysOn ? '<i class="sx-on-dot" title="Always on"></i>' : ''}</b><small>${h(s.focus || '')}</small></span>${(s.schedules || []).length ? `<span class="sx-count" title="Scheduled jobs">${ico('clock', 'ico-xs')}${s.schedules.length}</span>` : ''}</button>`;
    back.querySelector('.sx-list').innerHTML = `${mine.length ? `<div class="sx-group">Yours</div>${mine.map(row).join('')}` : ''}<div class="sx-group">Built in</div>${built.map(row).join('')}`;
    back.querySelectorAll('.sx-list [data-face]').forEach((slot) => face(slot, one(slot.dataset.face), 'sm'));
    back.querySelectorAll('.sx-row').forEach((b) => b.addEventListener('click', () => { sel = b.dataset.id; paint(); }));
    const main = back.querySelector('.sx-main');
    if (sel === 'new') paintNew(main);
    else paintOne(main, one(sel));
  }

  // ── New specialist ──
  function paintNew(main) {
    if (!draft) {
      main.innerHTML = `
        <div class="sx-hero"><span class="sx-hero-face"></span><div><h2>Make a specialist</h2><p>Describe it like you'd brief a new teammate: what it does, for whom, how good looks. Codeply writes its instructions.</p></div></div>
        <form class="sx-make">
          <textarea class="sx-brief" rows="6" placeholder="e.g. Watches the prices of the three laptops I'm looking at every morning and tells me when one drops under $900. Short, just the numbers and a link."></textarea>
          <div class="sx-make-row">
            <input class="sx-input sx-name-in" type="text" maxlength="40" placeholder="Name (optional)">
            <span class="sx-grow"></span>
            <button type="submit" class="sx-primary">${busy ? '<span class="sx-writing">Writing…</span>' : 'Write it'}</button>
          </div>
          <div class="sx-err"></div>
        </form>
        <p class="sx-tip">Or just ask in any chat: "Codeply, make me a specialist that…"</p>`;
      face(main.querySelector('.sx-hero-face'), null, 'md', 'happy');
      const f = main.querySelector('form');
      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (busy) return;
        const description = f.querySelector('.sx-brief').value.trim();
        const name = f.querySelector('.sx-name-in').value.trim();
        if (!description) { f.querySelector('.sx-err').textContent = 'Describe what it should do.'; return; }
        busy = true;
        f.querySelector('.sx-primary').innerHTML = '<span class="sx-writing">Writing…</span>';
        f.querySelector('.sx-primary').disabled = true;
        const r = await api.wispDraftSpecialist({ description, name }).catch((err) => ({ ok: false, error: err.message }));
        busy = false;
        if (!r || !r.ok) { f.querySelector('.sx-primary').disabled = false; f.querySelector('.sx-primary').textContent = 'Write it'; f.querySelector('.sx-err').textContent = (r && r.error) || 'Could not write it.'; return; }
        draft = { ...r.draft, brief: description };
        paint();
      });
      setTimeout(() => { const t = main.querySelector('.sx-brief'); if (t) t.focus(); }, 30);
      return;
    }
    main.innerHTML = `
      <div class="sx-head"><span class="sx-head-face"></span><div class="sx-head-text">
        <input class="sx-title-in" value="${h(draft.name)}" maxlength="40" aria-label="Name">
        <input class="sx-focus-in" value="${h(draft.focus)}" maxlength="160" placeholder="What it is for" aria-label="Focus">
      </div></div>
      ${lookHtml(draft)}
      <label class="sx-label">Instructions <small>its system prompt, written by Codeply; edit anything</small></label>
      <textarea class="sx-text sx-instr" rows="11">${h(draft.instructions)}</textarea>
      <label class="sx-label">Model</label>${modelSelect('auto')}
      <div class="sx-actions"><button type="button" class="sx-ghost" data-act="again">Start over</button><span class="sx-grow"></span><button type="button" class="sx-primary" data-act="create">Create ${h(draft.name)}</button></div>
      <div class="sx-err"></div>`;
    const headFace = main.querySelector('.sx-head-face');
    face(headFace, draft, 'md', 'happy');
    wireLook(main, draft, (look) => { Object.assign(draft, look); const f = headFace.firstChild; if (f && f.wisp) f.wisp.dress(lookOf(draft), true); });
    main.querySelector('.sx-title-in').addEventListener('input', (e) => { draft.name = e.target.value; main.querySelector('[data-act="create"]').textContent = `Create ${e.target.value || 'it'}`; });
    main.querySelector('[data-act="again"]').addEventListener('click', () => { draft = null; paint(); });
    main.querySelector('[data-act="create"]').addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      const r = await api.wispCreateSpecialist({
        name: main.querySelector('.sx-title-in').value, focus: main.querySelector('.sx-focus-in').value,
        instructions: main.querySelector('.sx-instr').value, model: main.querySelector('.sx-model').value,
        shape: draft.shape, color: draft.color, gear: draft.gear, voice: draft.voice,
      });
      if (!r || !r.ok) { e.currentTarget.disabled = false; main.querySelector('.sx-err').textContent = (r && r.error) || 'Could not create it.'; return; }
      await load(r);
      draft = null;
      sel = r.id || sel;
      paint();
    });
  }

  function modelSelect(value) {
    const opts = [{ id: 'auto', name: 'Best for the job (Haze 2 picks)' }, ...(st.models || [])];
    return `<select class="sx-select sx-model">${opts.map((m) => `<option value="${h(m.id)}"${(value || 'auto') === m.id ? ' selected' : ''}>${h(m.name)}</option>`).join('')}</select>`;
  }
  function lookHtml(s) {
    return `<label class="sx-label">Look</label>
      <div class="sx-look">
        <div class="sx-chips" data-pick="shape">${SHAPES.map((x) => `<button type="button" class="${s.shape === x ? 'on' : ''}" data-v="${x}">${x}</button>`).join('')}</div>
        <div class="sx-swatches" data-pick="color">${COLORS.map((c) => `<button type="button" class="${String(s.color).toLowerCase() === c ? 'on' : ''}" data-v="${c}" style="--sw:${c}" aria-label="${c}"></button>`).join('')}</div>
        <div class="sx-chips" data-pick="gear">${GEAR.map((g) => `<button type="button" class="${(s.gear || '') === g ? 'on' : ''}" data-v="${g}">${g || 'none'}</button>`).join('')}</div>
      </div>`;
  }
  function wireLook(main, s, onChange) {
    main.querySelectorAll('[data-pick]').forEach((group) => group.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      group.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      const look = { shape: s.shape, color: s.color, gear: s.gear };
      look[group.dataset.pick] = b.dataset.v || null;
      onChange(look);
    }));
  }

  /** Its last jobs: the ones this PC ran, and the ones that ran in the cloud or from the phone. */
  function historyHtml(s) {
    const here = (s.history || []).map((x) => ({ task: x.task, ok: x.ok !== false, at: x.at || 0, where: '' }));
    const away = (st.cloudRuns || []).filter((r) => r.specialist === s.id)
      .map((r) => ({ task: r.task, ok: r.ok !== false, at: Date.parse(r.at) || 0, where: r.origin === 'cloud' ? 'Cloud' : 'Phone', output: r.output }));
    const all = [...here, ...away].sort((a, b) => b.at - a.at).slice(0, 10);
    if (!all.length) return '';
    return `<label class="sx-label">Recent jobs</label><div class="sx-history">${all.map((x) => `<div class="sx-hrow">
      <button type="button" class="sx-hline${x.output ? ' sx-run-out' : ''}"${x.output ? '' : ' disabled'}>${x.ok ? MARK_OK : MARK_BAD}<span class="sx-h-task">${h(x.task)}</span>${x.where ? `<span class="sx-where">${x.where}</span>` : ''}<small>${h(ago(x.at))}</small></button>
      ${x.output ? `<div class="sx-h-out">${h(x.output)}</div>` : ''}</div>`).join('')}</div>`;
  }
  const MARK_OK = '<svg class="sx-mark ok" viewBox="0 0 16 16" width="15" height="15"><circle cx="8" cy="8" r="7.2" fill="currentColor"/><path d="M4.9 8.2l2.1 2.1 4.1-4.4" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const MARK_BAD = '<svg class="sx-mark bad" viewBox="0 0 16 16" width="15" height="15"><circle cx="8" cy="8" r="7.2" fill="currentColor"/><path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></svg>';

  // ── One specialist ──
  function paintOne(main, s) {
    if (!s) { main.innerHTML = '<div class="sx-empty">Pick a specialist, or make a new one.</div>'; return; }
    const jobs = s.schedules || [];
    main.innerHTML = `
      <div class="sx-head"><span class="sx-head-face"></span><div class="sx-head-text">
        ${s.builtin ? `<div class="sx-title">${h(s.name)} <span class="sx-badge">Built in</span></div><div class="sx-focus">${h(s.focus || '')}</div>`
          : `<input class="sx-title-in" value="${h(s.name)}" maxlength="40" aria-label="Name"><input class="sx-focus-in" value="${h(s.focus || '')}" maxlength="160" placeholder="What it is for" aria-label="Focus">`}
      </div><button type="button" class="sx-primary sx-chat">${ico('chat')}<span>Chat with ${h(s.name)}</span></button></div>
      <label class="sx-always${s.alwaysOn ? ' on' : ''}"><span class="sx-always-text"><b>Always on</b><small>${s.alwaysOn
        ? 'On duty around the clock. Its jobs run on time with Codeply closed, and with your PC off they run in the cloud (web and research work).'
        : 'Off: its jobs wait until Codeply is open on this PC. Turn it on to keep it running with your PC off.'}</small></span>
        <span class="sx-switch sx-switch-inline"><input type="checkbox" class="sx-always-in"${s.alwaysOn ? ' checked' : ''}><i></i></span></label>
      ${s.builtin ? '' : lookHtml(s)}
      ${s.builtin
        ? `<label class="sx-label">Its guide <small>built in</small></label><pre class="sx-guide">${h(s.guide || '')}</pre>
           <label class="sx-label">House rules <small>on top of the guide</small></label><textarea class="sx-text sx-notes" rows="3" placeholder="e.g. Use Tailwind. Never touch the payments folder.">${h(s.notes || '')}</textarea>`
        : `<label class="sx-label">Instructions <small>its system prompt</small></label><textarea class="sx-text sx-instr" rows="9">${h(s.instructions || '')}</textarea>`}
      <div class="sx-row2"><div><label class="sx-label">Model</label>${modelSelect(s.model)}</div></div>
      <div class="sx-actions"><button type="button" class="sx-primary sx-save" disabled>Saved</button>${s.builtin ? '' : '<span class="sx-grow"></span><button type="button" class="sx-danger" data-act="remove">Remove</button>'}</div>
      <label class="sx-label">Scheduled jobs <small>it runs these on its own, each in a chat of its own</small></label>
      <div class="sx-jobs">${jobs.length ? jobs.map((j) => `<div class="sx-job" data-job="${h(j.id)}"><span class="sx-job-ic">${ico('clock', 'ico-xs')}</span><div><b>${h(j.whenText || j.when)}</b><small>${h(j.task)}</small><small class="sx-job-meta">${j.nextAt ? `Next ${h(when(j.nextAt))}` : ''}${j.lastAt ? ` · last ran ${h(ago(j.lastAt))}` : ''}${j.lastError ? ` · <span class="bad">${h(j.lastError)}</span>` : ''}</small></div><button type="button" class="sx-ghost" data-act="run">Run now</button><button type="button" class="sx-ghost" data-act="cancel">Cancel</button></div>`).join('') : '<p class="sx-none">Nothing scheduled yet.</p>'}</div>
      <form class="sx-sched"><input class="sx-input" name="task" placeholder="Job, e.g. check my inbox for invoices and list them" maxlength="600"><input class="sx-input sx-when" name="when" placeholder="When: every weekday at 9" maxlength="80"><button type="submit" class="sx-ghost">Add</button></form>
      <div class="sx-err sx-sched-err"></div>
      ${historyHtml(s)}`;
    const headFace = main.querySelector('.sx-head-face');
    face(headFace, s, 'md', 'happy');
    const save = main.querySelector('.sx-save');
    const pending = {};
    const dirty = () => { save.disabled = false; save.textContent = 'Save changes'; };
    main.querySelectorAll('.sx-title-in, .sx-focus-in, .sx-instr, .sx-notes').forEach((el) => el.addEventListener('input', dirty));
    if (!s.builtin) wireLook(main, s, async (look) => {
      // Keep this card current, so the next pick builds on this one (not on the look it had when opened).
      Object.assign(s, look);
      const f = headFace.firstChild;
      if (f && f.wisp) f.wisp.dress(lookOf(s), true);
      // Its face in the list on the left changes too, right away.
      const row = root() && root().querySelector(`.sx-list [data-face="${CSS.escape(s.id)}"]`);
      const rf = row && row.firstChild;
      if (rf && rf.wisp) rf.wisp.dress(lookOf(s), false);
      await load(await api.wispUpdateSpecialist(s.id, look));
      paintList();
    });
    main.querySelector('.sx-model').addEventListener('change', async (e) => { await load(await api.wispUpdateSpecialist(s.id, { model: e.target.value })); });
    save.addEventListener('click', async () => {
      const patch = { ...pending };
      if (s.builtin) patch.notes = main.querySelector('.sx-notes').value;
      else {
        patch.name = main.querySelector('.sx-title-in').value;
        patch.focus = main.querySelector('.sx-focus-in').value;
        patch.instructions = main.querySelector('.sx-instr').value;
      }
      save.disabled = true;
      await load(await api.wispUpdateSpecialist(s.id, patch));
      save.textContent = 'Saved';
      paintList();
    });
    const rm = main.querySelector('[data-act="remove"]');
    if (rm) rm.addEventListener('click', async () => {
      if (rm.dataset.sure !== '1') { rm.dataset.sure = '1'; rm.textContent = `Remove ${s.name}?`; return; }
      await load(await api.wispRemoveSpecialist(s.id));
      sel = (st.team[0] || {}).id || 'new';
      paint();
    });
    main.querySelector('.sx-chat').addEventListener('click', () => chatWith(s));
    main.querySelector('.sx-always-in').addEventListener('change', async (e) => { await load(await api.wispUpdateSpecialist(s.id, { alwaysOn: e.target.checked })); paint(); });
    main.querySelectorAll('.sx-run-out').forEach((b) => b.addEventListener('click', () => b.closest('.sx-hrow').classList.toggle('open')));
    main.querySelectorAll('.sx-job').forEach((row) => {
      row.querySelector('[data-act="run"]').addEventListener('click', async (e) => { e.currentTarget.disabled = true; e.currentTarget.textContent = 'Running…'; await load(await api.wispRunSchedule(row.dataset.job)); paint(); });
      row.querySelector('[data-act="cancel"]').addEventListener('click', async () => { await load(await api.wispCancelSchedule(row.dataset.job)); paint(); });
    });
    main.querySelector('.sx-sched').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.currentTarget;
      const task = f.task.value.trim();
      const whenTxt = f.when.value.trim();
      const err = main.querySelector('.sx-sched-err');
      if (!task || !whenTxt) { err.textContent = 'Write the job and when it runs.'; return; }
      const r = await api.wispAddSchedule({ specialist: s.id, task, when: whenTxt, cwd: typeof state !== 'undefined' && state ? state.project : '' });
      if (!r || !r.ok) { err.textContent = (r && r.error) || 'Could not schedule it.'; return; }
      await load(r);
      paint();
    });
  }
  function paintList() {
    // Refresh the left list (names, faces) without touching the open form.
    const back = root();
    if (!back) return;
    back.querySelectorAll('.sx-list .sx-row').forEach((b) => {
      const s = one(b.dataset.id);
      if (s) { b.querySelector('b').textContent = s.name; b.querySelector('small').textContent = s.focus || ''; }
    });
  }

  /** A new chat that talks to the specialist directly. */
  function chatWith(s) {
    close();
    const nb = document.getElementById('newChatBtn');
    if (nb) nb.click();
    setTimeout(() => { if (typeof sendMessage === 'function') sendMessage(`Let me talk to ${s.name} directly.`, true); }, 250);
  }

  // ── @mentions: type @ in the composer to talk to a specialist ──
  // "@Inbox Watch any invoices today?" switches the chat to that specialist and
  // it answers itself (wisp-desktop.js, mentionSpeaker). Two or more mentioned go
  // to Codeply, which brings each in (codeply-cli/lib/wisp.js, rule 10).
  // Just "@": your 3 most recent. Keep typing: everyone whose name matches.
  const RECENT_KEY = 'codeply.mentions.recent';
  function mentionTimes() { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '{}') || {}; } catch { return {}; } }
  function noteMention(id) {
    try { const t = mentionTimes(); t[id] = Date.now(); localStorage.setItem(RECENT_KEY, JSON.stringify(t)); } catch {}
  }
  /** When you last had anything to do with them: mentioned, used, or made. */
  function lastTouched(s, times) {
    const hist = (s.history || [])[0];
    return Math.max(times[s.id] || 0, s.lastUsedAt || 0, s.createdAt || 0, (hist && hist.at) || 0);
  }
  const CODEPLY = { id: 'codeply', name: 'Codeply', focus: 'Back to Codeply', builtin: true };
  function mentionChoices(q) {
    const times = mentionTimes();
    const speaking = window.CraftWispUI && typeof state !== 'undefined' && state && window.CraftWispUI.speakerOf(state.currentSessionId);
    const people = [...(speaking ? [CODEPLY] : []), ...st.team];
    if (!q) {
      // Most recent first; with nothing to go on, yours before the built-in ones.
      return people.map((s, i) => ({ s, i, t: s === CODEPLY ? Infinity : lastTouched(s, times) }))
        .sort((a, b) => b.t - a.t || (a.s.builtin === b.s.builtin ? a.i - b.i : a.s.builtin ? 1 : -1))
        .slice(0, 3).map((x) => x.s);
    }
    const starts = people.filter((s) => s.name.toLowerCase().startsWith(q));
    const words = people.filter((s) => !starts.includes(s) && s.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)));
    const inside = q.length > 1 ? people.filter((s) => !starts.includes(s) && !words.includes(s) && s.name.toLowerCase().includes(q)) : [];
    return [...starts, ...words, ...inside].slice(0, 6);
  }

  function wireMentions(composer) {
    const input = composer.querySelector('.composer-input');
    if (!input || input.dataset.mentions) return;
    input.dataset.mentions = '1';
    let menu = null;
    let items = [];
    let active = 0;
    let at = -1; // where the "@" is
    composer.mentionMenuOpen = () => !!menu;
    const shut = () => { if (menu) { menu.querySelectorAll('.wisp-av, .wisp-sm').forEach((f) => f.wisp && f.wisp.destroy()); menu.remove(); } menu = null; };
    function pick(s) {
      const v = input.value;
      const end = input.selectionStart;
      input.value = `${v.slice(0, at)}@${s.name} ${v.slice(end)}`;
      const caret = at + s.name.length + 2;
      input.setSelectionRange(caret, caret);
      if (s !== CODEPLY) noteMention(s.id);
      shut();
      input.dispatchEvent(new Event('input'));
      input.focus();
    }
    async function update() {
      const before = input.value.slice(0, input.selectionStart);
      const m = /(^|\s)@([\w .-]{0,24})$/.exec(before);
      if (!m || /\s{2}|\s$/.test(m[2]) && !m[2].trim()) { shut(); return; }
      // A fresh "@": reload the team, so one made a minute ago (here, on the phone, by Codeply) is there.
      if (!menu || !st.team.length) await load();
      const q = m[2].toLowerCase().trim();
      items = mentionChoices(q);
      if (!items.length || (items.length === 1 && items[0].name.toLowerCase() === q)) { shut(); return; }
      at = before.length - m[2].length - 1;
      active = 0;
      shut();
      menu = document.createElement('div');
      menu.className = 'menu mention-menu';
      menu.innerHTML = items.map((s, i) => `<button type="button" class="menu-item mention-item${i === 0 ? ' active' : ''}" data-i="${i}"><span class="mention-face"></span><b>${h(s.name)}</b><small>${h(s.focus || '')}</small></button>`).join('');
      menu.querySelectorAll('.mention-face').forEach((slot, i) => {
        if (!W()) return;
        slot.appendChild(W().avatar({ size: 'sm', mood: 'happy', look: lookOf(items[i]) || undefined }));
      });
      menu.addEventListener('mousedown', (e) => { e.preventDefault(); const b = e.target.closest('[data-i]'); if (b) pick(items[Number(b.dataset.i)]); });
      composer.style.position = 'relative';
      composer.appendChild(menu);
    }
    input.addEventListener('input', () => { update(); });
    input.addEventListener('keydown', (e) => {
      if (!menu) return;
      const rows = [...menu.querySelectorAll('.mention-item')];
      if (e.key === 'ArrowDown') active = (active + 1) % rows.length;
      else if (e.key === 'ArrowUp') active = (active - 1 + rows.length) % rows.length;
      else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopImmediatePropagation(); pick(items[active]); return; }
      else if (e.key === 'Escape') { shut(); return; }
      else return;
      e.preventDefault();
      rows.forEach((r, i) => r.classList.toggle('active', i === active));
    });
    input.addEventListener('blur', () => setTimeout(shut, 150));
  }
  document.querySelectorAll('.composer').forEach(wireMentions);

  window.CraftSpecialists = { open };
  if (window.CraftWispUI) window.CraftWispUI.openTeam = (id) => open(id);
  const nav = document.getElementById('specialistsBtn');
  if (nav) nav.addEventListener('click', () => open());
  // Codeply made or changed a specialist: the open window shows it.
  if (api.onAgentEvent) api.onAgentEvent((d) => { if (d && d.type === 'wisp_team' && root()) load().then(() => { if (sel !== 'new') paint(); }); });
})();
