// The face of Codeply's main agent in Craft's window (the character is wisp.js).
//
//   - Home: the avatar, big, in place of the logo. Its eyes follow your cursor,
//     and it reads what you type as you type it (a mood, and a shape when you
//     name one: "make it feel like a cloud"). No words, just the face.
//   - Chat: every answer starts with the avatar, on the left. While the agent
//     works it shows how it's going (thinking, working, worried when
//     something needs your yes); then it takes the mood of the reply (the
//     reply's [mood: x] tag, sent as wisp_mood).
//   - Specialists the agent brings in work behind it: one quiet row inside the
//     answer's work line (agentNote).
//   - Account menu, Specialists: the team, each one's prompt, model, last jobs
//     and scheduled jobs.
//
// app.js calls in here (CraftWispUI.*); everything is a no-op when it's off.
(function () {
  const api = window.craft || null;
  const W = () => window.CraftWisp;
  const $ = (id) => document.getElementById(id);
  const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let enabled = true;
  let team = [];            // specialists (detail): { id, name, focus, builtin, uses, model, instructions, guide, notes, history, schedules }
  let models = [];          // the user's own models: { id, name, note }
  let schedules = [];       // every scheduled job
  let homeWisp = null;
  let turnFace = null;      // the avatar at the start of the answer being written now
  let restTimer = null;

  const card = (id) => team.find((t) => t.id === id) || null;

  // ─── State ────────────────────────────────────────────────────────────────
  async function refresh() {
    if (!api || !api.wispState) { enabled = false; paint(); return; }
    try {
      const s = await api.wispState();
      enabled = s.enabled !== false;
      team = Array.isArray(s.team) ? s.team : [];
      models = Array.isArray(s.models) ? s.models : [];
      schedules = Array.isArray(s.schedules) ? s.schedules : [];
    } catch { /* keep what we had */ }
    paint();
    if ($('wispTeamBackdrop')) drawTeam();
  }

  function paint() {
    document.body.classList.toggle('wisp-on', enabled);
    if (enabled) ensureHome();
    else document.querySelectorAll('.wisp-home').forEach((n) => { n.remove(); homeWisp = null; });
  }

  // ─── Home ─────────────────────────────────────────────────────────────────
  function ensureHome() {
    const center = document.querySelector('#viewHome .home-center');
    if (!center || !W() || center.querySelector('.wisp-home')) return;
    const stage = document.createElement('div');
    stage.className = 'wisp-home';
    stage.innerHTML = '<div class="wisp-home-char"></div>';
    center.insertBefore(stage, center.firstChild);
    homeWisp = W().mount(stage.querySelector('.wisp-home-char'), { size: 'lg', morph: true });
    const input = document.querySelector('[data-composer="home"] .composer-input');
    let t = null;
    if (!input) return;
    input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => reactHome(input.value), 260); });
    input.addEventListener('focus', () => { if (homeWisp && !input.value.trim()) homeWisp.setMood('listening'); });
    input.addEventListener('blur', () => { if (homeWisp && !input.value.trim()) homeWisp.setMood('neutral'); });
  }

  function reactHome(text) {
    if (!homeWisp || !enabled) return;
    if (!String(text || '').trim()) { homeWisp.setMood('listening'); homeWisp.setShape('hexagon'); return; }
    const r = W().read(text);
    homeWisp.setMood(r.mood === 'neutral' ? 'listening' : r.mood, !!r.shape);
    if (r.shape) homeWisp.setShape(r.shape);
  }

  /** A message went out from home: a quick happy hop, then back to the hexagon. */
  function homeSent() {
    if (!homeWisp) return;
    homeWisp.setMood('happy');
    homeWisp.boop();
    setTimeout(() => { if (homeWisp) { homeWisp.setMood('neutral'); homeWisp.setShape('hexagon'); } }, 900);
  }

  // ─── The avatar at the start of each answer ───────────────────────────────
  /**
   * Starts an answer: the avatar in the chat's left gutter, right after the
   * user's message. Returns the element to append, or null when off.
   */
  function turnStart(mood) {
    if (!enabled || !W()) return null;
    const el = document.createElement('div');
    el.className = 'wisp-turn';
    const face = W().avatar({ size: 'sm', mood: mood || 'neutral' });
    face.classList.add('wisp-turn-face');
    el.appendChild(face);
    turnFace = face.wisp;
    return el;
  }

  function setFace(mood, hold) {
    if (!turnFace || !turnFace.el.isConnected) return;
    clearTimeout(restTimer);
    turnFace.setMood(mood);
    if (hold) restTimer = setTimeout(() => { if (turnFace) turnFace.setMood('neutral'); }, hold);
  }

  /** The reply has landed: the answer's face takes its mood and says it. */
  function replyMood(mood, text) {
    if (!turnFace) return;
    setFace(mood || 'neutral');
    turnFace.talk(Math.min(4000, 400 + String(text || '').length * 6));
  }

  /** Every event of the open chat, before app.js draws it: the answer's face follows the work. */
  function onEvent(data) {
    if (!enabled) return;
    switch (data.type) {
      case 'tool_start': case 'approval_resolved': case 'question_resolved': setFace('working'); break;
      case 'wisp_agent': setFace(data.phase === 'report' ? 'thinking' : 'working'); break;
      case 'verifying': setFace('thinking'); break;
      case 'approval_request': case 'image_pick_request': setFace('worried'); break;
      case 'question_request': setFace('thinking'); break;
      case 'error': setFace('sad'); break;
      case 'aborted': setFace('neutral'); break;
      case 'run_finished': if (turnFace && (turnFace.mood === 'working' || turnFace.mood === 'thinking')) setFace('neutral'); break;
    }
  }

  /** A message went out from this window. */
  function onSend(fromHome) {
    if (!enabled) return;
    if (fromHome) homeSent();
  }

  /**
   * A specialist the agent brought in: one quiet row inside the answer's work
   * line, seen only when it is opened. You talk to Codeply; the team works behind it.
   */
  function agentNote(data) {
    if (!data || !data.agent) return null;
    const name = escHtml(data.agent.name);
    const el = document.createElement('div');
    el.className = 'wisp-note';
    if (data.phase === 'start') {
      el.innerHTML = `Brought in the ${name} specialist${data.task ? `<span class="wisp-note-task">${escHtml(String(data.task).replace(/\s+/g, ' ').slice(0, 220))}</span>` : ''}`;
      if (data.task) el.title = data.task;
    } else if (data.phase === 'report') {
      if (data.ok) return null; // the steps above already say what it did
      el.classList.add('bad');
      el.textContent = `The ${data.agent.name} specialist could not finish`;
    } else if (data.phase === 'created') {
      el.innerHTML = `Made a new specialist: ${name}${data.agent.focus ? `<span class="wisp-note-task">${escHtml(data.agent.focus)}</span>` : ''}`;
    } else if (data.phase === 'updated') {
      el.textContent = `Tuned the ${data.agent.name} specialist`;
    } else return null;
    return el;
  }

  // ─── Specialists (account menu) ───────────────────────────────────────────
  let openId = null; // the specialist shown open in the window
  const ago = (t) => {
    const s = Math.round((Date.now() - t) / 1000);
    return s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
  };
  const when = (t) => new Date(t).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });

  function closeTeam() { const b = $('wispTeamBackdrop'); if (b) b.remove(); openId = null; }

  async function openTeam() {
    closeTeam();
    const back = document.createElement('div');
    back.className = 'wisp-team-backdrop';
    back.id = 'wispTeamBackdrop';
    back.innerHTML = `<div class="wisp-team" role="dialog" aria-modal="true" aria-labelledby="wispTeamTitle">
      <div class="wisp-team-top"><div class="wisp-team-face"></div><div><h2 id="wispTeamTitle">Specialists</h2><p>For bigger jobs Codeply quietly brings in a specialist: its own agent with its own instructions and model. It makes new ones when nobody fits, and gives them standing jobs when you ask.</p></div>
      <button class="icon-btn wisp-team-x" title="Close" aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
      <label class="wisp-switch"><input type="checkbox"><span class="wisp-switch-track"></span><span>Let Codeply bring in specialists</span></label>
      <div class="wisp-team-body"></div>
    </div>`;
    document.body.appendChild(back);
    W().mount(back.querySelector('.wisp-team-face'), { size: 'md', mood: 'happy' });
    back.querySelector('.wisp-switch input').addEventListener('change', async (e) => {
      const r = await api.wispSet(e.target.checked);
      enabled = r.enabled !== false;
      paint();
      drawTeam();
    });
    back.querySelector('.wisp-team-x').addEventListener('click', closeTeam);
    back.addEventListener('mousedown', (e) => { if (e.target === back) closeTeam(); });
    document.addEventListener('keydown', function onKey(e) { if (e.key === 'Escape') { closeTeam(); document.removeEventListener('keydown', onKey); } });
    drawTeam();
    await refresh();
  }

  async function act(promise) {
    const r = await promise;
    if (r && Array.isArray(r.team)) { team = r.team; models = r.models || models; schedules = r.schedules || schedules; }
    drawTeam();
  }

  function modelSelect(s) {
    const opts = [{ id: 'auto', name: 'Best for the job (Haze 2 picks)' }, ...models];
    if (s.model && s.model !== 'auto' && !models.some((m) => m.id === s.model)) opts.push({ id: s.model, name: 'A model you removed' });
    return `<select class="wtd-model" aria-label="Model for ${escHtml(s.name)}">${opts.map((m) => `<option value="${escHtml(m.id)}"${(s.model || 'auto') === m.id ? ' selected' : ''}>${escHtml(m.name)}</option>`).join('')}</select>`;
  }

  function jobRow(j) {
    return `<div class="wtd-job" data-job="${escHtml(j.id)}"><div><b>${escHtml(j.whenText || j.when)}</b><small>${escHtml(j.task)}</small>` +
      `<small class="wtd-job-meta">${j.nextAt ? `Next ${escHtml(when(j.nextAt))}` : ''}${j.lastAt ? ` · last ran ${escHtml(ago(j.lastAt))}` : ''}${j.lastError ? ` · <span class="bad">couldn't run: ${escHtml(j.lastError)}</span>` : ''}</small></div>` +
      '<button class="btn btn-secondary btn-sm" data-act="run">Run now</button><button class="btn btn-ghost btn-sm" data-act="cancel">Cancel</button></div>';
  }

  function drawTeam() {
    const back = $('wispTeamBackdrop');
    if (!back) return;
    back.querySelector('.wisp-switch input').checked = enabled;
    const body = back.querySelector('.wisp-team-body');
    const rows = team.map((s) => {
      const open = s.id === openId;
      const modelName = s.model && s.model !== 'auto' ? (models.find((m) => m.id === s.model)?.name || 'a removed model') : 'Haze 2';
      const jobs = (s.schedules || []);
      const head = `<button class="wisp-team-row" data-open="${escHtml(s.id)}" aria-expanded="${open}"><span class="wtr-text"><b>${escHtml(s.name)}</b><small>${escHtml(s.focus || '')}</small></span>` +
        `<span class="wtr-meta">${escHtml(modelName)}${jobs.length ? ` · ${jobs.length} scheduled` : ''}${s.uses ? ` · ${s.uses} job${s.uses === 1 ? '' : 's'}` : ''}</span><svg class="wtr-chev" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></button>`;
      if (!open) return `<div class="wisp-team-item">${head}</div>`;
      const prompt = s.builtin
        ? `<label class="wtd-label">Its guide <small>built in</small></label><pre class="wtd-guide">${escHtml(s.guide || '')}</pre>
           <label class="wtd-label" for="wtdNotes">House rules <small>on top of the guide; Codeply can add to these</small></label>
           <textarea id="wtdNotes" class="wtd-text" rows="3" placeholder="e.g. Use Tailwind. Never touch the payments folder.">${escHtml(s.notes || '')}</textarea>`
        : `<label class="wtd-label" for="wtdNotes">Its instructions <small>its system prompt, written by Codeply</small></label>
           <textarea id="wtdNotes" class="wtd-text" rows="7">${escHtml(s.instructions || '')}</textarea>`;
      const history = (s.history || []).length
        ? `<label class="wtd-label">Last jobs</label><div class="wtd-history">${s.history.map((h) => `<div><span class="${h.ok ? 'ok' : 'bad'}">${h.ok ? '✓' : '✗'}</span> ${escHtml(h.task)} <small>${escHtml(ago(h.at))}</small></div>`).join('')}</div>` : '';
      const sched = `<label class="wtd-label">Scheduled jobs</label>${jobs.length ? jobs.map(jobRow).join('') : `<p class="wtd-empty">None. Ask Codeply, for example "have ${escHtml(s.name)} ${escHtml(s.id === 'security' ? 'check for leaked keys every Monday at 9' : s.id === 'testing' ? 'run the tests every night' : 'look over the project every Friday')}".</p>`}`;
      return `<div class="wisp-team-item open">${head}<div class="wisp-team-detail" data-id="${escHtml(s.id)}">
        <label class="wtd-label">Model</label>${modelSelect(s)}
        ${prompt}
        <div class="wtd-actions"><button class="btn btn-primary btn-sm" data-act="save">Save</button>${s.builtin ? '' : '<button class="btn btn-ghost btn-sm wtd-remove" data-act="remove">Remove specialist</button>'}</div>
        ${history}${sched}</div></div>`;
    }).join('');
    body.innerHTML = `<div class="wisp-team-head">The team <small>${team.length}</small></div><div class="wisp-team-list">${rows}</div>`;
    body.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => { openId = openId === b.dataset.open ? null : b.dataset.open; drawTeam(); }));
    const det = body.querySelector('.wisp-team-detail');
    if (!det) return;
    const id = det.dataset.id;
    const s = card(id);
    det.querySelector('.wtd-model').addEventListener('change', (e) => act(api.wispUpdateSpecialist(id, { model: e.target.value })));
    det.querySelector('[data-act="save"]').addEventListener('click', () => {
      const v = det.querySelector('#wtdNotes').value;
      act(api.wispUpdateSpecialist(id, s && s.builtin ? { notes: v } : { instructions: v }));
    });
    const rm = det.querySelector('[data-act="remove"]');
    if (rm) rm.addEventListener('click', () => { openId = null; act(api.wispRemoveSpecialist(id)); });
    det.querySelectorAll('.wtd-job').forEach((row) => {
      row.querySelector('[data-act="run"]').addEventListener('click', (e) => { e.currentTarget.disabled = true; act(api.wispRunSchedule(row.dataset.job)); });
      row.querySelector('[data-act="cancel"]').addEventListener('click', () => act(api.wispCancelSchedule(row.dataset.job)));
    });
  }

  window.CraftWispUI = {
    get enabled() { return enabled; },
    refresh, onEvent, onSend, turnStart, replyMood, agentNote, openTeam, card,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', refresh);
  else refresh();
})();
