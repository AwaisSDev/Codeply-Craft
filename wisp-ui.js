// Wisp in Craft's window: the face of the main agent.
//
//   - Home: Wisp, big, above the composer. It greets you for the time of day,
//     follows your cursor, and reads what you type as you type it (a mood, and
//     a shape when you name one: "make it feel like a cloud").
//   - Chat: a small Wisp sits on the composer and shows what is going on:
//     listening while you type, thinking, working while tools run, worried
//     when something needs your yes, then the mood of its reply (the reply's
//     [mood: x] tag, sent as wisp_mood). Left alone long enough, it dozes off.
//   - Each Wisp reply has Wisp's face and name above it, in that reply's mood.
//   - Specialists Wisp brings in work under their own face: "Frontend is on
//     it", their steps, then their report in the chat.
//   - Account menu: Wisp on or off, and Wisp's team.
//
// app.js calls in here (CraftWispUI.*); everything is a no-op when Wisp is off.
(function () {
  const api = window.craft || null;
  const W = () => window.CraftWisp;
  const $ = (id) => document.getElementById(id);
  const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let enabled = true;
  let team = [];            // cards: { id, name, focus, shape, color, builtin, uses }
  let homeWisp = null;
  let buddy = null;         // the chat composer's Wisp
  let buddyRest = 'neutral';
  let restTimer = null;
  let sleepTimer = null;
  let bubbleTimer = null;
  let running = false;

  const card = (id) => team.find((t) => t.id === id) || null;

  // ─── State ────────────────────────────────────────────────────────────────
  async function refresh() {
    if (!api || !api.wispState) { enabled = false; paint(); return; }
    try {
      const s = await api.wispState();
      enabled = s.enabled !== false;
      team = Array.isArray(s.team) ? s.team : [];
    } catch { /* keep what we had */ }
    paint();
  }

  function paint() {
    document.body.classList.toggle('wisp-on', enabled);
    document.querySelectorAll('.composer-input').forEach((el) => {
      if (!el.dataset.plainHint) el.dataset.plainHint = el.placeholder;
      if (!el.matches('.chat-composer .composer-input') || !running) {
        el.placeholder = enabled ? 'Ask Wisp anything, or type / for commands' : el.dataset.plainHint;
      }
    });
    if (enabled) { ensureHome(); ensureBuddy(); }
    if (window.CraftBots && window.CraftBots.paint) window.CraftBots.paint(); // the "who answers" chip says Wisp
  }

  // ─── Home ─────────────────────────────────────────────────────────────────
  function greeting() {
    const h = new Date().getHours();
    if (h < 5) return "Up late? I'm here.";
    if (h < 12) return 'Morning! What are we doing today?';
    if (h < 17) return 'Hi, I\'m Wisp. What are we building?';
    if (h < 22) return 'Evening. What needs doing?';
    return "Late one? I'm here.";
  }

  function say(el, text) {
    if (!el || el.textContent === text) return;
    el.classList.remove('on');
    void el.offsetWidth;
    el.textContent = text;
    el.classList.add('on');
  }

  function ensureHome() {
    const center = document.querySelector('#viewHome .home-center');
    if (!center || !W()) return;
    let stage = center.querySelector('.wisp-home');
    if (!stage) {
      stage = document.createElement('div');
      stage.className = 'wisp-home';
      stage.innerHTML = '<div class="wisp-home-char"></div><p class="wisp-say" aria-live="polite"></p>';
      center.insertBefore(stage, center.firstChild);
      homeWisp = W().mount(stage.querySelector('.wisp-home-char'), { size: 'lg', morph: true });
      const input = document.querySelector('[data-composer="home"] .composer-input');
      let t = null;
      if (input) {
        input.addEventListener('input', () => {
          clearTimeout(t);
          t = setTimeout(() => reactHome(input.value), 260);
        });
        input.addEventListener('focus', () => { if (!input.value.trim()) homeWisp.setMood('listening'); });
        input.addEventListener('blur', () => { if (!input.value.trim()) { homeWisp.setMood('neutral'); say(stage.querySelector('.wisp-say'), greeting()); } });
      }
    }
    say(stage.querySelector('.wisp-say'), greeting());
  }

  function reactHome(text) {
    if (!homeWisp || !enabled) return;
    const sayEl = document.querySelector('.wisp-home .wisp-say');
    if (!String(text || '').trim()) { homeWisp.setMood('listening'); homeWisp.setShape('pentagon'); say(sayEl, greeting()); return; }
    const r = W().read(text);
    const mood = r.mood === 'neutral' ? 'listening' : r.mood;
    homeWisp.setMood(mood, !!r.shape);
    if (r.shape) homeWisp.setShape(r.shape);
    if (r.line && (r.shape || r.mood !== 'neutral')) say(sayEl, r.line);
    homeWisp.talk(500);
  }

  /** The home Wisp when a message goes out from home: a quick happy hop. */
  function homeSent() {
    if (!homeWisp || !enabled) return;
    homeWisp.setMood('happy');
    homeWisp.boop();
    setTimeout(() => { if (homeWisp) { homeWisp.setMood('neutral'); homeWisp.setShape('pentagon'); say(document.querySelector('.wisp-home .wisp-say'), greeting()); } }, 900);
  }

  // ─── The chat's Wisp ──────────────────────────────────────────────────────
  function ensureBuddy() {
    if (buddy && buddy.el.isConnected) return;
    const composer = document.querySelector('.chat-composer .composer');
    if (!composer || !W()) return;
    const holder = document.createElement('div');
    holder.className = 'wisp-buddy';
    holder.innerHTML = '<span class="wisp-buddy-char" title="Wisp"></span><span class="wisp-bubble" aria-live="polite"></span>';
    composer.appendChild(holder);
    buddy = W().mount(holder.querySelector('.wisp-buddy-char'), { size: 'md', morph: true });
    const input = composer.querySelector('.composer-input');
    let t = null;
    if (input) {
      input.addEventListener('input', () => {
        clearTimeout(t);
        t = setTimeout(() => {
          if (!enabled || running) return;
          const v = input.value.trim();
          if (!v) { setBuddy('neutral'); return; }
          const r = W().read(v);
          buddy.setMood(r.mood === 'neutral' ? 'listening' : r.mood, !!r.shape);
          if (r.shape) buddy.setShape(r.shape);
          poke();
        }, 260);
      });
    }
    poke();
  }

  function bubble(text, ms) {
    const el = document.querySelector('.wisp-buddy .wisp-bubble');
    if (!el) return;
    clearTimeout(bubbleTimer);
    if (!text) { el.classList.remove('on'); return; }
    el.textContent = text;
    el.classList.add('on');
    bubbleTimer = setTimeout(() => el.classList.remove('on'), ms || 3200);
  }

  /** Sets the chat Wisp's face; with hold, it goes back to calm after a while. */
  function setBuddy(mood, hold) {
    if (!buddy || !enabled) return;
    clearTimeout(restTimer);
    buddy.setMood(mood);
    if (hold) restTimer = setTimeout(() => { if (!running) buddy.setMood('neutral'); }, hold);
    poke();
  }

  // Left alone (no pointer, no keys, nothing running) for 3 minutes: it dozes off. Anything wakes it.
  function poke() {
    clearTimeout(sleepTimer);
    if (buddy && buddy.mood === 'sleepy') { buddy.setMood('surprised'); setTimeout(() => { if (buddy && buddy.mood === 'surprised' && !running) buddy.setMood('neutral'); }, 700); }
    sleepTimer = setTimeout(() => { if (buddy && !running && enabled) buddy.setMood('sleepy'); }, 180000);
  }
  addEventListener('pointermove', () => { if (buddy && buddy.mood === 'sleepy') poke(); }, { passive: true });
  addEventListener('keydown', () => poke(), { passive: true });

  /** Every event of the open chat, before app.js draws it. */
  function onEvent(data) {
    if (!enabled || !buddy) return;
    switch (data.type) {
      case 'tool_start': {
        const who = data.agent ? card(data.agent) : null;
        setBuddy('working');
        if (data.name === 'create_specialist') bubble('Making a new specialist…');
        else if (!who && data.name === 'remember') bubble('Noted.', 1600);
        break;
      }
      case 'verifying': setBuddy('thinking'); break;
      case 'approval_request':
      case 'image_pick_request': setBuddy('worried'); bubble('Needs your yes'); break;
      case 'question_request': setBuddy('thinking'); bubble('Quick question for you'); break;
      case 'approval_resolved':
      case 'question_resolved': setBuddy('working'); break;
      case 'wisp_agent':
        if (data.phase === 'start') { setBuddy('working'); bubble(`${data.agent.name} is on it`); }
        else if (data.phase === 'report') { setBuddy(data.ok ? 'thinking' : 'worried'); bubble(data.ok ? `${data.agent.name} reported back` : `${data.agent.name} hit a snag`); }
        else if (data.phase === 'created') { setBuddy('excited', 2400); bubble(`New on the team: ${data.agent.name}`); }
        break;
      case 'wisp_mood': buddyRest = data.mood || 'neutral'; break;
      case 'text':
        if (!data.interim) { bubble(''); setBuddy(data.mood || buddyRest || 'happy', 7000); buddy.talk(Math.min(4000, 400 + String(data.text || '').length * 6)); buddyRest = 'neutral'; }
        break;
      case 'error': setBuddy('sad', 6000); break;
      case 'aborted': setBuddy('neutral'); bubble(''); break;
      case 'run_finished': running = false; paint(); if (buddy.mood === 'working' || buddy.mood === 'thinking') setBuddy('neutral'); break;
      case 'wisp_team': refresh(); break;
    }
  }

  /** A message went out from this window. */
  function onSend(fromHome) {
    if (!enabled) return;
    running = true;
    if (fromHome) homeSent();
    ensureBuddy();
    setBuddy('thinking');
    bubble('');
  }

  // ─── In the chat ──────────────────────────────────────────────────────────
  /** Wisp's face and name above one of its replies. */
  function byline(mood) {
    if (!enabled || !W()) return null;
    const el = document.createElement('div');
    el.className = 'wisp-byline';
    const av = W().avatar({ size: 'xs', mood: mood || 'neutral', morph: false });
    el.appendChild(av);
    const name = document.createElement('span');
    name.textContent = 'Wisp';
    el.appendChild(name);
    return el;
  }

  function agentAvatar(agent, mood, size) {
    const a = card(agent && agent.id) || agent || {};
    return W().avatar({ size: size || 'xs', mood: mood || 'neutral', shape: a.shape || 'blob', color: a.color || '#58b9e6', morph: false });
  }

  /** The face for a specialist's work line (the activity group's icon). */
  function activityIcon(agentId) {
    const a = card(agentId);
    if (!a || !W()) return null;
    return agentAvatar(a, 'working', 'xs');
  }

  /** "Frontend is on it": the line that opens a specialist's work. */
  function agentStart(data) {
    const el = document.createElement('div');
    el.className = 'wisp-agent-start';
    el.style.setProperty('--agent', (data.agent && data.agent.color) || 'var(--accent)');
    el.appendChild(agentAvatar(data.agent, 'thinking', 'xs'));
    const text = document.createElement('div');
    text.className = 'wisp-agent-start-text';
    text.innerHTML = `<span class="wisp-agent-line"><b>Wisp</b> brought in <b class="wisp-agent-name">${escHtml(data.agent.name)}</b></span>` +
      (data.task ? `<span class="wisp-agent-task">${escHtml(String(data.task).split('\n')[0].slice(0, 200))}</span>` : '');
    if (data.task) {
      text.title = data.task;
      text.querySelector('.wisp-agent-task').addEventListener('click', (e) => {
        const t = e.currentTarget;
        t.classList.toggle('open');
        t.textContent = t.classList.contains('open') ? String(data.task) : String(data.task).split('\n')[0].slice(0, 200);
      });
    }
    el.appendChild(text);
    return el;
  }

  /** A specialist's report: its own face and name, its words, and what it really changed and checked. */
  function agentReport(data, render) {
    const el = document.createElement('div');
    el.className = 'wisp-agent-report' + (data.ok ? '' : ' failed');
    el.style.setProperty('--agent', (data.agent && data.agent.color) || 'var(--accent)');
    const head = document.createElement('div');
    head.className = 'wisp-agent-head';
    head.appendChild(agentAvatar(data.agent, data.ok ? 'happy' : 'sad', 'sm'));
    head.insertAdjacentHTML('beforeend', `<div><b>${escHtml(data.agent.name)}</b><small>${data.ok ? 'reported to Wisp' : 'could not finish'}</small></div>`);
    el.appendChild(head);
    const body = document.createElement('div');
    body.className = 'wisp-agent-body msg assistant';
    body.innerHTML = render ? render(data.text || '') : escHtml(data.text || '');
    el.appendChild(body);
    const files = Array.isArray(data.files) ? data.files : [];
    const checks = Array.isArray(data.checks) ? data.checks : [];
    if (files.length || checks.length) {
      const facts = document.createElement('div');
      facts.className = 'wisp-agent-facts';
      if (files.length) facts.insertAdjacentHTML('beforeend', `<span class="wf-label">Changed</span>${files.slice(0, 8).map((f) => `<code>${escHtml(f)}</code>`).join('')}${files.length > 8 ? `<span class="wf-more">+${files.length - 8}</span>` : ''}`);
      for (const c of checks.slice(-4)) {
        const passed = c.ok && (c.exitCode === undefined || c.exitCode === null || c.exitCode === 0);
        const label = c.tool === 'run' ? String(c.label || '').slice(0, 48) : 'page check';
        facts.insertAdjacentHTML('beforeend', `<span class="wf-check ${passed ? 'ok' : 'bad'}">${passed ? '✓' : '✗'} ${escHtml(label)}${!passed && typeof c.exitCode === 'number' ? ` (exit ${c.exitCode})` : ''}</span>`);
      }
      el.appendChild(facts);
    }
    return el;
  }

  /** A new specialist on the team. */
  function agentCreated(data) {
    const el = document.createElement('div');
    el.className = 'wisp-agent-new';
    el.style.setProperty('--agent', (data.agent && data.agent.color) || 'var(--accent)');
    el.appendChild(agentAvatar(data.agent, 'excited', 'sm'));
    el.insertAdjacentHTML('beforeend', `<div><b>${escHtml(data.agent.name)}</b> ${data.phase === 'updated' ? 'got better at its job' : 'joined Wisp\'s team'}<small>${escHtml(data.agent.focus || '')}</small></div>`);
    return el;
  }

  // ─── Wisp's team (account menu) ───────────────────────────────────────────
  function closeTeam() { const b = $('wispTeamBackdrop'); if (b) b.remove(); }

  async function openTeam() {
    await refresh();
    closeTeam();
    const back = document.createElement('div');
    back.className = 'wisp-team-backdrop';
    back.id = 'wispTeamBackdrop';
    back.innerHTML = `<div class="wisp-team" role="dialog" aria-modal="true" aria-labelledby="wispTeamTitle">
      <div class="wisp-team-top"><div class="wisp-team-face"></div><div><h2 id="wispTeamTitle">Wisp</h2><p>The agent you talk to. It does small things itself and brings in a specialist for real work, then checks the result before it comes back to you.</p></div>
      <button class="icon-btn wisp-team-x" title="Close" aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
      <label class="wisp-switch"><input type="checkbox" ${enabled ? 'checked' : ''}><span class="wisp-switch-track"></span><span>Wisp leads every chat</span></label>
      <div class="wisp-team-head">The team <small>${team.length} specialists</small></div>
      <div class="wisp-team-list"></div>
      <p class="wisp-team-note">Wisp makes new specialists when a job needs one nobody on the team fits, and they stay for next time. Built-in ones can't be removed.</p>
    </div>`;
    document.body.appendChild(back);
    W().mount(back.querySelector('.wisp-team-face'), { size: 'md', morph: true, mood: 'happy' });
    const list = back.querySelector('.wisp-team-list');
    const drawList = () => {
      list.innerHTML = '';
      back.querySelector('.wisp-team-head small').textContent = `${team.length} specialists`;
      for (const s of team) {
        const row = document.createElement('div');
        row.className = 'wisp-team-row';
        row.appendChild(agentAvatar(s, 'neutral', 'sm'));
        row.insertAdjacentHTML('beforeend', `<div class="wtr-text"><b>${escHtml(s.name)}</b><small>${escHtml(s.focus || '')}</small></div><span class="wtr-meta">${s.builtin ? 'Built in' : 'Made by Wisp'}${s.uses ? ` · ${s.uses} job${s.uses === 1 ? '' : 's'}` : ''}</span>`);
        if (!s.builtin) {
          const rm = document.createElement('button');
          rm.className = 'wtr-remove';
          rm.title = `Remove ${s.name}`;
          rm.setAttribute('aria-label', `Remove ${s.name}`);
          rm.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
          rm.addEventListener('click', async () => {
            const r = await api.wispRemoveSpecialist(s.id);
            team = Array.isArray(r.team) ? r.team : team.filter((x) => x.id !== s.id);
            drawList();
          });
          row.appendChild(rm);
        }
        list.appendChild(row);
      }
    };
    drawList();
    back.querySelector('.wisp-switch input').addEventListener('change', async (e) => {
      const r = await api.wispSet(e.target.checked);
      enabled = r.enabled !== false;
      paint();
      if (!enabled) document.querySelectorAll('.wisp-home, .wisp-buddy').forEach((n) => n.remove());
      buddy = null; homeWisp = null;
      if (enabled) paint();
    });
    back.querySelector('.wisp-team-x').addEventListener('click', closeTeam);
    back.addEventListener('mousedown', (e) => { if (e.target === back) closeTeam(); });
    document.addEventListener('keydown', function onKey(e) { if (e.key === 'Escape') { closeTeam(); document.removeEventListener('keydown', onKey); } });
  }

  window.CraftWispUI = {
    get enabled() { return enabled; },
    refresh, onEvent, onSend, byline, activityIcon, agentStart, agentReport, agentCreated, openTeam, card,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', refresh);
  else refresh();
})();
