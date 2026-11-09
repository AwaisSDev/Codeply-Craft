// Specialists on the phone, straight from the user's account (supabase/specialists.sql),
// so all of it works with the PC off:
//
//   - The team: the built-in specialists and the ones you made, with their faces.
//   - Make one: describe it; the server writes its instructions (the specialists
//     function, action "draft"). Edit anything, Create. The PC picks it up on its next sync.
//   - Open one: Always on, its instructions or house rules, its standing jobs
//     ("every weekday at 9"), Run now, Remove, and what it ran lately (PC, cloud, phone).
//   - Ask it now: runs it in Codeply's cloud (action "run") and shows the report.
//   - Chat with it: a chat of its own, where it answers in its own voice
//     (action "chat"), with the PC off. Rename or delete the ones you made.
//   - @mentions: type @ in the composer to pick one. "@Name ..." and you talk to
//     it from then on (its face on top, its colour), until "@Codeply". In a chat,
//     or with the PC off, it answers from the cloud with your own model; with the
//     PC online, a code chat goes to the PC, which hands the chat to it.
//
// Always-on specialists' jobs run on time with the PC off: the server timer
// (specialists-tick, every 2 minutes) runs any job a PC did not take, and the
// report comes to this phone as a notification.
(() => {
  'use strict';
  const P = () => window.CraftPhone;
  if (!window.CraftPhone) return;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const svg = (d, w = 20) => `<svg viewBox="0 0 24 24" width="${w}" height="${w}" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const ICON = {
    back: svg('<path d="M15 18l-6-6 6-6"/>'),
    plus: svg('<path d="M12 5v14M5 12h14"/>'),
    clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', 15),
  };
  const OK = '<svg class="sp-mark ok" viewBox="0 0 16 16" width="16" height="16"><circle cx="8" cy="8" r="7.2" fill="currentColor"/><path d="M4.9 8.2l2.1 2.1 4.1-4.4" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const BAD = '<svg class="sp-mark bad" viewBox="0 0 16 16" width="16" height="16"><circle cx="8" cy="8" r="7.2" fill="currentColor"/><path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></svg>';
  const SHAPES = ['circle', 'blob', 'cloud', 'triangle', 'square', 'hexagon', 'star', 'spiky'];
  const COLORS = ['#1f8bff', '#86d41f', '#ffbe0b', '#ff2fa8', '#ff6b2c', '#8f5bff', '#00c2a8', '#ff3b5c', '#22b8f0', '#c45cff'];
  const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } })();
  const ago = (t) => { const s = Math.round((Date.now() - t) / 1000); return s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };
  const whenAt = (t) => new Date(t).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const toast = (msg) => { const t = document.createElement('div'); t.className = 'wk-toast'; t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 3200); };
  const sb = () => P().sb;
  const uid = async () => { const s = P().currentSession ? await P().currentSession() : null; if (!s || !s.user) throw new Error('Sign in to Codeply first.'); return s.user.id; };

  // ─── When a job runs (the same words as on the PC: codeply-cli/lib/wisp.js) ──
  const MIN_INTERVAL_MIN = 15;
  const DAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const pad = (n) => String(n).padStart(2, '0');


  /** "at 9", "9am", "9:30 pm", "18:30", "noon", "midnight" -> { h, m } or null */
  function parseClock(t) {
    if (/\bnoon\b/.test(t)) return { h: 12, m: 0 };
    if (/\bmidnight\b/.test(t)) return { h: 0, m: 0 };
    const m = /(?:\bat\s+|\b)(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?(?=\s|$|[,.;])/.exec(t.replace(/\bevery\s+\d+\s*(?:minutes?|mins?|hours?|hrs?)\b|\bin\s+\d+\s*(?:minutes?|mins?|hours?|hrs?)\b/g, ' '));
    if (!m) return null;
    const hasAt = /\bat\s+\d/.test(t) || m[2] || m[3];
    if (!hasAt) return null;
    let h = Number(m[1]); const min = Number(m[2] || 0);
    const ap = (m[3] || '').replace(/\./g, '');
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    if (h > 23 || min > 59) return null;
    return { h, m: min };
  }

  /**
   * Reads when a job should run, in the user's local time. Returns a rule:
   *   { kind: 'days', days: [0..6], h, m }   every day / weekday / Monday...
   *   { kind: 'interval', everyMin }         every 2 hours / every 30 minutes
   *   { kind: 'once', at }                   at 5pm / tomorrow at 9 / in 20 minutes
   * or { error }.
   */
  function parseWhen(text, now = Date.now()) {
    const t = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!t) return { error: 'Say when, like "every Monday at 9", "every day at 18:00", "every 2 hours" or "tomorrow at 9".' };
    const every = /\b(every|each|daily|weekly|hourly|nightly|weekdays|weekends)\b/.test(t);
    // every N minutes / hours
    const iv = /\bevery\s+(\d+|an?|one|other)?\s*(minutes?|mins?|hours?|hrs?)\b/.exec(t);
    if (iv || /\bhourly\b/.test(t)) {
      const n = !iv ? 1 : /^\d+$/.test(iv[1] || '') ? Number(iv[1]) : iv[1] === 'other' ? 2 : 1;
      const everyMin = iv && /^m/.test(iv[2]) ? n : n * 60;
      if (everyMin < MIN_INTERVAL_MIN) return { error: `That is too often. The shortest is every ${MIN_INTERVAL_MIN} minutes.` };
      return { kind: 'interval', everyMin };
    }
    // in N minutes / hours (once)
    const inN = /\bin\s+(\d+|an?|one)\s*(minutes?|mins?|hours?|hrs?)\b/.exec(t);
    if (inN && !every) {
      const n = /^\d+$/.test(inN[1]) ? Number(inN[1]) : 1;
      return { kind: 'once', at: now + n * (/^m/.test(inN[2]) ? 60000 : 3600000) };
    }
    const clock = parseClock(t);
    const named = [...t.matchAll(/\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/g)].map((m) => DAYS[m[1]]);
    const part = /\bmorning\b/.test(t) ? { h: 9, m: 0 } : /\b(evening|nightly)\b/.test(t) ? { h: 18, m: 0 } : /\bnight\b/.test(t) ? { h: 21, m: 0 } : null;
    const at = clock || part || { h: 9, m: 0 };
    if (every) {
      let days = null;
      if (/\bweekdays?\b/.test(t)) days = [1, 2, 3, 4, 5];
      else if (/\bweekends?\b/.test(t)) days = [0, 6];
      else if (named.length) days = [...new Set(named)].sort();
      else if (/\bweekly\b|\bevery week\b/.test(t)) days = [new Date(now).getDay()];
      else days = [0, 1, 2, 3, 4, 5, 6];
      return { kind: 'days', days, h: at.h, m: at.m };
    }
    // once: today / tomorrow / a named day, at a time
    if (!clock && !part && !named.length && !/\b(today|tomorrow|tonight)\b/.test(t)) {
      return { error: 'Say when, like "every Monday at 9", "every day at 18:00", "every 2 hours" or "tomorrow at 9".' };
    }
    const d = new Date(now);
    d.setSeconds(0, 0);
    d.setHours(at.h, at.m);
    if (/\btomorrow\b/.test(t)) d.setDate(d.getDate() + 1);
    else if (named.length) { while (d.getDay() !== named[0] || d.getTime() <= now) d.setDate(d.getDate() + 1); }
    else if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return { kind: 'once', at: d.getTime() };
  }

  /** The next time a rule fires after `from`, or null when it never will again. */
  function nextRun(rule, from = Date.now()) {
    if (!rule) return null;
    if (rule.kind === 'interval') return from + rule.everyMin * 60000;
    if (rule.kind === 'once') return rule.at > from ? rule.at : null;
    if (rule.kind === 'days') {
      const d = new Date(from);
      d.setSeconds(0, 0);
      for (let i = 0; i <= 8; i++) {
        const c = new Date(d);
        c.setDate(d.getDate() + i);
        c.setHours(rule.h, rule.m, 0, 0);
        if (c.getTime() > from && rule.days.includes(c.getDay())) return c.getTime();
      }
    }
    return null;
  }

  /** "every Monday at 09:00", "every weekday at 18:30", "every 2 hours", "once, Sat 14 Mar 17:00" */
  function describeRule(rule) {
    if (!rule) return '';
    if (rule.kind === 'interval') return rule.everyMin % 60 === 0 ? `every ${rule.everyMin === 60 ? 'hour' : `${rule.everyMin / 60} hours`}` : `every ${rule.everyMin} minutes`;
    if (rule.kind === 'once') {
      const d = new Date(rule.at);
      return `once, ${DAY_NAMES[d.getDay()].slice(0, 3)} ${d.getDate()} ${d.toLocaleString('en', { month: 'short' })} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
    const days = rule.days.join() === '0,1,2,3,4,5,6' ? 'day' : rule.days.join() === '1,2,3,4,5' ? 'weekday' : rule.days.join() === '0,6' ? 'weekend day'
      : rule.days.map((x) => DAY_NAMES[x]).join(' and ');
    return `every ${days} at ${pad(rule.h)}:${pad(rule.m)}`;
  }

  // ─── The account ───────────────────────────────────────────────────────────
  const team = { list: [], jobs: [], runs: [], loaded: false, error: '', missing: false };
  const fromRow = (r) => ({ ...(r.data || {}), id: r.id.replace(/^builtin:/, ''), rowId: r.id, builtin: r.id.startsWith('builtin:'), alwaysOn: !!r.always_on, updatedAt: Date.parse(r.updated_at) || 0 });
  async function loadTeam() {
    try {
      const [a, b, c] = await Promise.all([
        sb().from('specialists').select('id, data, always_on, deleted, updated_at').eq('deleted', false),
        sb().from('specialist_jobs').select('id, specialist, data, next_at, deleted, updated_at').eq('deleted', false),
        sb().from('specialist_runs').select('id, job_id, specialist, task, output, ok, origin, at').order('at', { ascending: false }).limit(60),
      ]);
      const err = a.error || b.error || c.error;
      if (err) throw err;
      team.list = (a.data || []).map(fromRow).filter((s) => s.name).sort((x, y) => Number(x.builtin) - Number(y.builtin) || String(x.name).localeCompare(String(y.name)));
      team.jobs = (b.data || []).map((r) => ({ ...(r.data || {}), id: r.id, specialist: r.specialist, nextAt: r.next_at ? Date.parse(r.next_at) : null }));
      team.runs = c.data || [];
      team.error = ''; team.missing = false;
    } catch (e) {
      team.missing = /does not exist|schema cache|could not find/i.test(String(e.message || ''));
      team.error = team.missing ? '' : (e.message || 'Could not load your team.');
    }
    team.loaded = true;
    try { localStorage.setItem('craft-phone-specialists', JSON.stringify(team.list.map((s) => ({ id: s.id, name: s.name, focus: s.focus, shape: s.shape, color: s.color, gear: s.gear, builtin: !!s.builtin, createdAt: s.createdAt || 0, model: s.model || 'auto' })))); } catch {}
    return team;
  }
  const cachedTeam = () => { if (team.list.length) return team.list; try { return JSON.parse(localStorage.getItem('craft-phone-specialists') || '[]'); } catch { return []; } };

  /**
   * Your own model for a specialist's answer: the one it is set to on the PC, else the
   * model picked on this phone, else the PC's model, as long as it is synced here
   * ("Use on my phone"). null = Haze 2 (the server tries the free model only after those).
   */
  function ownModelFor(specId) {
    const st = P().state || {};
    const synced = st.synced || [];
    if (!synced.length) return null;
    const spec = cachedTeam().find((s) => s.id === specId);
    const byPc = (id) => id && id !== 'auto' && synced.find((m) => m.clientId === id);
    const picked = st.ui && st.ui.chatModel && st.ui.chatModel !== 'auto' && synced.find((m) => m.id === st.ui.chatModel);
    const m = byPc(spec && spec.model) || picked || byPc(st.pc && st.pc.models && st.pc.models.selected);
    return m ? m.id : null;
  }

  async function fn(body) {
    const token = await P().accessToken();
    if (!token) throw new Error('Sign in to Codeply first.');
    if (body.action === 'run' || body.action === 'chat') {
      // Your time zone, so "today's mail" in the inbox read means your today.
      body = { tz: TZ, ...body };
      const own = !body.modelId && ownModelFor(body.specialist);
      if (own) body = { ...body, modelId: own };
    }
    const device = P().deviceHeader ? P().deviceHeader() : {};
    const r = await fetch(`${P().SUPABASE_URL}/functions/v1/specialists`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, apikey: P().SUPABASE_ANON_KEY, 'Content-Type': 'application/json', ...device }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok && !j.error) throw new Error(`The server did not answer (HTTP ${r.status}).`);
    return j;
  }

  async function saveSpec(s, patch) {
    const data = { ...s, ...patch, updatedAt: Date.now() };
    delete data.rowId; delete data.id;
    const row = { user_id: await uid(), id: s.rowId || s.id, data: { ...data, id: s.builtin ? undefined : s.id }, always_on: !!data.alwaysOn, deleted: false, updated_at: new Date(data.updatedAt).toISOString() };
    const { error } = await sb().from('specialists').upsert(row);
    if (error) throw error;
  }

  // ─── Faces ─────────────────────────────────────────────────────────────────
  function face(slot, s, size = 'md', mood = 'happy') {
    const W = window.CraftWisp;
    if (!slot || !W) return;
    try {
      if (W.avatar) { slot.appendChild(W.avatar({ size, mood, look: s && s.shape ? { shape: s.shape, color: s.color, gear: s.gear || undefined } : undefined })); return; }
      const w = W.mount(slot, { size, shape: (s && s.shape) || 'pentagon', morph: false });
      if (s && s.color) w.setColor(s.color);
      w.setMood(mood, true);
    } catch {}
  }

  // ─── Screens ───────────────────────────────────────────────────────────────
  function panel() {
    let s = $('spxPanel');
    if (s) return s;
    s = document.createElement('section');
    s.className = 'panel hidden'; s.id = 'spxPanel'; s.setAttribute('role', 'dialog'); s.setAttribute('aria-modal', 'true'); s.setAttribute('aria-label', 'Specialists');
    s.innerHTML = `<header class="top"><button class="icon-btn" data-back aria-label="Back">${ICON.back}</button><div class="top-title">Specialists</div><button class="icon-btn" data-new aria-label="New specialist">${ICON.plus}</button></header><div class="panel-body"></div>`;
    document.body.appendChild(s);
    s.querySelector('[data-back]').addEventListener('click', () => s.classList.add('hidden'));
    s.querySelector('[data-new]').addEventListener('click', makeSheet);
    return s;
  }
  function sheet(html) {
    const s = document.createElement('div');
    s.className = 'wk-sheet sp-sheet';
    s.innerHTML = `<div class="wk-sheet-bg"></div><div class="wk-sheet-card"><div class="wk-handle"></div>${html}</div>`;
    document.body.appendChild(s);
    const close = () => s.remove();
    s.querySelector('.wk-sheet-bg').addEventListener('click', close);
    s.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) close(); });
    return { el: s, close, q: (sel) => s.querySelector(sel), qa: (sel) => s.querySelectorAll(sel) };
  }

  async function open() {
    const p = panel();
    p.parentNode.appendChild(p);
    p.classList.remove('hidden');
    if (!team.loaded) render();
    await loadTeam();
    render();
  }

  function render() {
    const p = $('spxPanel'); if (!p) return;
    const body = p.querySelector('.panel-body');
    if (team.missing) {
      body.innerHTML = '<p class="note">Specialists are not set up in your account yet. Once the database tables are added (supabase/specialists.sql), your team shows up here and works with your PC off.</p>';
      return;
    }
    if (!team.loaded) { body.innerHTML = '<p class="note">Getting your team…</p>'; return; }
    const mine = team.list.filter((s) => !s.builtin);
    const built = team.list.filter((s) => s.builtin);
    const jobsOf = (s) => team.jobs.filter((j) => j.specialist === s.id);
    const row = (s) => `<button type="button" class="sp-row" data-id="${esc(s.rowId)}"><span class="sp-face"></span>
      <span class="sp-main"><b>${esc(s.name)}${s.alwaysOn ? '<i class="sp-on" aria-label="Always on"></i>' : ''}</b><small>${esc(s.focus || '')}</small></span>
      ${jobsOf(s).length ? `<span class="sp-count">${ICON.clock}${jobsOf(s).length}</span>` : ''}</button>`;
    body.innerHTML = `${team.error ? `<p class="note wk-err">${esc(team.error)}</p>` : ''}
      <button type="button" class="sp-make">${ICON.plus}<span>Make a specialist</span></button>
      ${mine.length ? `<div class="sec"><h2>Yours</h2><span>${mine.length}</span></div><div class="sp-list">${mine.map(row).join('')}</div>` : ''}
      ${built.length ? `<div class="sec"><h2>Built in</h2><span>${built.length}</span></div><div class="sp-list">${built.map(row).join('')}</div>` : ''}
      ${!team.list.length ? '<p class="note" style="text-align:center;margin-top:30px">No team in your account yet. Open Codeply on your PC once (it syncs the team), or make one here.</p>' : ''}
      <p class="note sp-foot">Type @ in any chat to hand a job to one of them. Always-on ones run their jobs on time even with your PC off.</p>`;
    const all = [...mine, ...built];
    body.querySelectorAll('.sp-row').forEach((b, i) => { face(b.querySelector('.sp-face'), all[i], 'sm'); b.addEventListener('click', () => detailSheet(all[i])); });
    body.querySelector('.sp-make').addEventListener('click', makeSheet);
  }

  // ─── Make one ──────────────────────────────────────────────────────────────
  function makeSheet() {
    const sh = sheet(`<h2 class="wk-title">Make a specialist</h2>
      <p class="wk-text">Describe it like you'd brief a new teammate. Codeply writes its instructions.</p>
      <textarea class="sp-in sp-brief" rows="5" placeholder="e.g. Every morning, checks the prices of the three laptops I'm watching and tells me if one drops under $900."></textarea>
      <input class="sp-in" data-name maxlength="40" placeholder="Name (optional)">
      <p class="sp-err"></p>
      <div class="wk-actions"><button class="btn btn-quiet" data-close>Cancel</button><button class="btn btn-primary" data-write>Write it</button></div>`);
    setTimeout(() => sh.q('.sp-brief').focus(), 60);
    sh.q('[data-write]').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const description = sh.q('.sp-brief').value.trim();
      if (!description) { sh.q('.sp-err').textContent = 'Describe what it should do.'; return; }
      btn.disabled = true; btn.innerHTML = '<span class="sp-shine">Writing…</span>';
      let r;
      try { r = await fn({ action: 'draft', description, name: sh.q('[data-name]').value.trim() }); } catch (err) { r = { ok: false, error: err.message }; }
      if (!r || !r.ok) { btn.disabled = false; btn.textContent = 'Write it'; sh.q('.sp-err').textContent = (r && r.error) || 'Could not write it.'; return; }
      sh.close();
      draftSheet(r.draft);
    });
  }

  function lookPicker(d) {
    return `<div class="sp-chips" data-pick="shape">${SHAPES.map((x) => `<button type="button" class="${d.shape === x ? 'on' : ''}" data-v="${x}">${x}</button>`).join('')}</div>
      <div class="sp-swatches" data-pick="color">${COLORS.map((c) => `<button type="button" class="${String(d.color).toLowerCase() === c ? 'on' : ''}" data-v="${c}" style="--sw:${c}" aria-label="${c}"></button>`).join('')}</div>`;
  }
  function wireLook(sh, d, onChange) {
    sh.qa('[data-pick]').forEach((g) => g.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]'); if (!b) return;
      g.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      d[g.dataset.pick] = b.dataset.v;
      onChange();
    }));
  }

  function draftSheet(d) {
    const sh = sheet(`<div class="sp-head"><span class="sp-face sp-face-lg"></span><div class="sp-head-text">
        <input class="sp-in sp-title" value="${esc(d.name)}" maxlength="40" aria-label="Name">
        <input class="sp-in sp-sub" value="${esc(d.focus)}" maxlength="160" placeholder="What it is for" aria-label="Focus"></div></div>
      ${lookPicker(d)}
      <label class="sp-label">Instructions <small>its system prompt; edit anything</small></label>
      <textarea class="sp-in sp-instr" rows="9">${esc(d.instructions)}</textarea>
      <label class="sp-always"><span><b>Always on</b><small>Runs its jobs on time, even with your PC off.</small></span><span class="sp-switch"><input type="checkbox" data-always><i></i></span></label>
      <p class="sp-err"></p>
      <div class="wk-actions"><button class="btn btn-quiet" data-close>Cancel</button><button class="btn btn-primary" data-create>Create</button></div>`);
    const fslot = sh.q('.sp-face');
    const repaint = () => { fslot.innerHTML = ''; face(fslot, d, 'md'); };
    repaint();
    wireLook(sh, d, repaint);
    sh.q('[data-create]').addEventListener('click', async (e) => {
      const name = sh.q('.sp-title').value.trim().replace(/\s+/g, ' ');
      const id = slug(name);
      if (!id) { sh.q('.sp-err').textContent = 'Give it a short name.'; return; }
      if (team.list.some((s) => s.id === id || String(s.name).toLowerCase() === name.toLowerCase())) { sh.q('.sp-err').textContent = `${name} is already on your team.`; return; }
      e.currentTarget.disabled = true;
      const now = Date.now();
      try {
        await saveSpec({ id, rowId: id }, {
          name, focus: sh.q('.sp-sub').value.trim(), instructions: sh.q('.sp-instr').value.trim(), voice: d.voice || '', shape: d.shape, color: d.color, gear: d.gear || null,
          model: 'auto', alwaysOn: sh.q('[data-always]').checked, createdAt: now, uses: 0, version: 1,
        });
      } catch (err) { e.currentTarget.disabled = false; sh.q('.sp-err').textContent = err.message; return; }
      sh.close();
      toast(`${name} is on your team`);
      await loadTeam(); render();
    });
  }

  // ─── One specialist ────────────────────────────────────────────────────────
  function detailSheet(s) {
    const jobs = team.jobs.filter((j) => j.specialist === s.id);
    const runs = team.runs.filter((r) => r.specialist === s.id && r.job_id !== 'chat').slice(0, 8);
    const where = { pc: 'PC', cloud: 'Cloud', phone: 'Phone' };
    const sh = sheet(`<div class="sp-head"><span class="sp-face sp-face-lg"></span><div class="sp-head-text">${s.builtin
        ? `<h2 class="wk-title">${esc(s.name)} <span class="sp-badge">Built in</span></h2><p class="wk-text">${esc(s.focus || '')}</p>`
        : `<input class="sp-in sp-title" data-name value="${esc(s.name)}" maxlength="40" aria-label="Name"><input class="sp-in sp-sub" data-focus value="${esc(s.focus || '')}" maxlength="160" placeholder="What it is for" aria-label="Focus">`}</div></div>
      <button type="button" class="btn btn-primary sp-chat" data-chat>Chat with ${esc(s.name)}</button>
      <label class="sp-always${s.alwaysOn ? ' on' : ''}"><span><b>Always on</b><small>${s.alwaysOn ? 'On duty around the clock: its jobs run on time even with your PC off.' : 'Off: its jobs wait until Codeply is open on your PC.'}</small></span><span class="sp-switch"><input type="checkbox" data-always${s.alwaysOn ? ' checked' : ''}><i></i></span></label>
      <div class="sp-ask"><input class="sp-in" data-ask placeholder="Ask ${esc(s.name)} something now"><button class="btn btn-primary" data-run>Ask</button></div>
      <div class="sp-out hidden"></div>
      <label class="sp-label">Standing jobs</label>
      <div class="sp-jobs">${jobs.length ? jobs.map((j) => `<div class="sp-job" data-job="${esc(j.id)}"><div><b>${esc(j.when || describeRule(j.rule))}</b><small>${esc(j.task)}</small><small class="sp-meta">${j.nextAt ? `Next ${esc(whenAt(j.nextAt))}` : ''}${j.lastAt ? ` · ran ${esc(ago(j.lastAt))}` : ''}</small></div><button class="sp-ghost" data-act="run">Run</button><button class="sp-ghost" data-act="cancel">Cancel</button></div>`).join('') : '<p class="note">Nothing scheduled.</p>'}</div>
      <div class="sp-add"><input class="sp-in" data-task placeholder="Job, e.g. sum up AI news"><input class="sp-in sp-when" data-when placeholder="every day at 8"><button class="sp-ghost" data-add>Add</button></div>
      <p class="sp-err" data-job-err></p>
      <label class="sp-label">${s.builtin ? 'House rules <small>on top of its guide</small>' : 'Instructions <small>its system prompt</small>'}</label>
      <textarea class="sp-in sp-instr" rows="${s.builtin ? 3 : 7}" placeholder="${s.builtin ? 'e.g. Keep it short. Never touch the payments folder.' : ''}">${esc(s.builtin ? s.notes || '' : s.instructions || '')}</textarea>
      ${runs.length ? `<label class="sp-label">Recent</label><div class="sp-runs">${runs.map((r, i) => `<button type="button" class="sp-run" data-r="${i}">${r.ok ? OK : BAD}<span>${esc(r.task)}</span><em>${where[r.origin] || ''}</em><small>${esc(ago(Date.parse(r.at)))}</small></button><div class="sp-run-out hidden">${P().md ? P().md(r.output || '') : esc(r.output || '')}</div>`).join('')}</div>` : ''}
      <div class="wk-actions">${s.builtin ? '' : '<button class="btn btn-quiet sp-danger" data-remove>Delete</button>'}<button class="btn btn-quiet" data-close>Close</button><button class="btn btn-primary" data-save>Save</button></div>`);
    face(sh.q('.sp-face'), s, 'md');
    sh.q('[data-always]').addEventListener('change', async (e) => {
      try { await saveSpec(s, { alwaysOn: e.target.checked }); s.alwaysOn = e.target.checked; sh.q('.sp-always').classList.toggle('on', s.alwaysOn); toast(s.alwaysOn ? `${s.name} is always on` : `${s.name} waits for your PC`); loadTeam().then(render); }
      catch (err) { e.target.checked = !e.target.checked; toast(err.message); }
    });
    sh.q('[data-save]').addEventListener('click', async () => {
      const v = sh.q('.sp-instr').value.trim();
      const patch = s.builtin ? { notes: v } : { instructions: v || s.instructions };
      if (!s.builtin) {
        // A new name keeps its id, so its jobs, chats and history stay with it.
        const name = sh.q('[data-name]').value.trim().replace(/\s+/g, ' ');
        if (!name) { toast('Give it a name.'); return; }
        if (team.list.some((x) => x.rowId !== s.rowId && String(x.name).toLowerCase() === name.toLowerCase())) { toast(`${name} is already on your team.`); return; }
        patch.name = name;
        patch.focus = sh.q('[data-focus]').value.trim() || s.focus;
      }
      try { await saveSpec(s, patch); toast(patch.name && patch.name !== s.name ? `Renamed to ${patch.name}` : 'Saved'); sh.close(); loadTeam().then(render); } catch (err) { toast(err.message); }
    });
    sh.q('[data-chat]').addEventListener('click', () => { sh.close(); const p = $('spxPanel'); if (p) p.classList.add('hidden'); startChat(s); });
    const rm = sh.q('[data-remove]');
    if (rm) rm.addEventListener('click', async () => {
      if (rm.dataset.sure !== '1') { rm.dataset.sure = '1'; rm.textContent = `Delete ${s.name}?`; return; }
      const now = new Date().toISOString();
      await sb().from('specialists').update({ deleted: true, updated_at: now }).eq('id', s.rowId);
      await sb().from('specialist_jobs').update({ deleted: true, updated_at: now }).eq('specialist', s.id);
      sh.close(); toast(`${s.name} deleted`); loadTeam().then(render);
    });
    const out = sh.q('.sp-out');
    async function ask(task, jobId) {
      out.classList.remove('hidden');
      out.innerHTML = `<span class="sp-shine">${esc(s.name)} is working…</span>`;
      let r;
      const web = await webFor(task, null);
      try { r = await fn({ action: 'run', specialist: s.id, task: web.note ? `${task}\n\n${web.note}` : task, jobId }); } catch (err) { r = { ok: false, error: err.message }; }
      out.innerHTML = r && r.ok ? (P().md ? P().md(r.output) : esc(r.output)) : `<span class="sp-err">${esc((r && r.error) || 'It could not run.')}</span>`;
      loadTeam().then(render);
    }
    sh.q('[data-run]').addEventListener('click', () => { const t = sh.q('[data-ask]').value.trim(); if (t) ask(t); });
    sh.q('[data-ask]').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sh.q('[data-run]').click(); } });
    sh.qa('.sp-job').forEach((row) => {
      const j = jobs.find((x) => x.id === row.dataset.job);
      row.querySelector('[data-act="run"]').addEventListener('click', () => ask(j.task, j.id));
      row.querySelector('[data-act="cancel"]').addEventListener('click', async () => {
        await sb().from('specialist_jobs').update({ deleted: true, updated_at: new Date().toISOString() }).eq('id', j.id);
        row.remove(); loadTeam().then(render);
      });
    });
    sh.q('[data-add]').addEventListener('click', async () => {
      const task = sh.q('[data-task]').value.trim();
      const when = sh.q('[data-when]').value.trim();
      const err = sh.q('[data-job-err]');
      if (!task || !when) { err.textContent = 'Write the job and when it runs.'; return; }
      const now = Date.now();
      const rule = parseWhen(when, now);
      if (rule.error) { err.textContent = rule.error; return; }
      const nextAt = nextRun(rule, now);
      if (!nextAt) { err.textContent = 'That time has already passed.'; return; }
      const id = 'j' + now.toString(36) + Math.random().toString(36).slice(2, 5);
      const data = { id, specialist: s.id, task: task.slice(0, 2000), when: when.slice(0, 120), rule, tz: TZ, cwd: '', nextAt, createdAt: now, updatedAt: now, enabled: true, runs: 0 };
      const { error } = await sb().from('specialist_jobs').insert({ user_id: await uid(), id, specialist: s.id, data, next_at: new Date(nextAt).toISOString(), updated_at: new Date(now).toISOString() });
      if (error) { err.textContent = error.message; return; }
      toast(`${s.name}: ${describeRule(rule)}${s.alwaysOn ? '' : '. Turn on Always on to run it with your PC off.'}`);
      sh.close(); await loadTeam(); render(); detailSheet(team.list.find((x) => x.id === s.id) || s);
    });
    sh.qa('.sp-run').forEach((b) => b.addEventListener('click', () => b.nextElementSibling.classList.toggle('hidden')));
  }

  // ─── The web for a specialist ──────────────────────────────────────────────
  // The same search as the main chat (web-search.js): a message that needs the web (asked outright, or about
  // news, prices, weather, "latest"...) is searched first, and links in it are read. The results go to the
  // specialist with the message. force: search even if the message did not look like it needed it.
  async function webFor(text, prev, force = false) {
    const W = window.CodeplyWeb; const C = P();
    const out = { note: '', sources: [], searched: false };
    if (!W) return out;
    const links = force ? [] : W.linksIn(text);
    const query = force || W.needsSearch(text) ? W.queryFor(text, prev) : '';
    if (!links.length && !query) return out;
    const word = document.querySelector('#feed .working .think-word');
    if (word) { word.textContent = query ? 'Searching the web' : 'Reading the link'; word.dataset.fixed = '1'; }
    const token = await C.accessToken().catch(() => null);
    const [page, found] = await Promise.all([
      links.length ? W.read(links, { token }).catch((e) => ({ text: `(Could not read ${links.join(', ')}: ${e.message}.)`, sources: [] })) : null,
      query ? C.webSearch(query, { full: true }).catch((e) => ({ text: `(${e.message}. Answer from what you know, and say the web search did not work just now.)`, sources: [] })) : null,
    ]);
    if (word) { delete word.dataset.fixed; }
    const parts = [];
    if (page) { parts.push(`PAGES I LINKED (read just now):\n\n${page.text.slice(0, 12000)}`); out.sources.push(...page.sources); }
    if (found) { parts.push(`WEB RESULTS for "${query}" (the app searched the web just now, ${new Date().toDateString()}):\n\n${found.text.slice(0, 12000)}`); out.sources.push(...found.sources); out.searched = true; }
    out.note = `${parts.join('\n\n')}\n\nAnswer from these, the key facts first, and cite sources as markdown links.`;
    return out;
  }

  // ─── @mentions in the composer ─────────────────────────────────────────────
  function wireMentions() {
    const input = $('input');
    const form = $('composer');
    if (!input || !form || input.dataset.mentions) return;
    input.dataset.mentions = '1';
    let menu = null; let at = -1; let items = [];
    const shut = () => { if (menu) menu.remove(); menu = null; };
    // Just "@": the 3 you used last. Keep typing: everyone whose name matches.
    const RECENT = 'codeply.mentions.recent';
    const times = () => { try { return JSON.parse(localStorage.getItem(RECENT) || '{}') || {}; } catch { return {}; } };
    function choices(q) {
      const all = cachedTeam();
      if (!q) {
        const t = times();
        const lastRun = (s) => { const r = team.runs.find((x) => x.specialist === s.id); return r ? Date.parse(r.at) || 0 : 0; };
        const seen = (s) => Math.max(t[s.id] || 0, lastRun(s), s.createdAt || 0);
        return all.map((s, i) => ({ s, i, at: seen(s) }))
          .sort((a, b) => b.at - a.at || (a.s.builtin === b.s.builtin ? a.i - b.i : a.s.builtin ? 1 : -1))
          .slice(0, 3).map((x) => x.s);
      }
      const nm = (s) => String(s.name).toLowerCase();
      const starts = all.filter((s) => nm(s).startsWith(q));
      const words = all.filter((s) => !starts.includes(s) && nm(s).split(/\s+/).some((w) => w.startsWith(q)));
      const inside = q.length > 1 ? all.filter((s) => !starts.includes(s) && !words.includes(s) && nm(s).includes(q)) : [];
      return [...starts, ...words, ...inside].slice(0, 6);
    }
    function pick(s) {
      try { const t = times(); t[s.id] = Date.now(); localStorage.setItem(RECENT, JSON.stringify(t)); } catch {}
      const v = input.value; const end = input.selectionStart;
      input.value = `${v.slice(0, at)}@${s.name} ${v.slice(end)}`;
      const caret = at + s.name.length + 2;
      input.setSelectionRange(caret, caret);
      shut(); input.focus(); input.dispatchEvent(new Event('input'));
    }
    input.addEventListener('input', () => {
      const before = input.value.slice(0, input.selectionStart);
      const m = /(^|\s)@([\w .-]{0,24})$/.exec(before);
      if (!m) { shut(); return; }
      // A fresh "@": get the team (with its faces) if this phone does not have it yet, then show it.
      if (!menu && !team.list.length && !team.loaded) loadTeam().then(() => { if (!menu) input.dispatchEvent(new Event('input')); }).catch(() => {});
      const q = m[2].toLowerCase().trim();
      items = choices(q);
      if (!items.length || (items.length === 1 && items[0].name.toLowerCase() === q)) { shut(); return; }
      at = before.length - m[2].length - 1;
      shut();
      menu = document.createElement('div');
      menu.className = 'sp-mention';
      menu.innerHTML = items.map((s, i) => `<button type="button" data-i="${i}"><span class="sp-face"></span><b>${esc(s.name)}</b><small>${esc(s.focus || '')}</small></button>`).join('');
      menu.querySelectorAll('.sp-face').forEach((slot, i) => face(slot, items[i], 'sm'));
      menu.addEventListener('mousedown', (e) => e.preventDefault());
      menu.addEventListener('click', (e) => { const b = e.target.closest('[data-i]'); if (b) pick(items[Number(b.dataset.i)]); });
      form.appendChild(menu);
    });
    input.addEventListener('blur', () => setTimeout(shut, 200));
    // The team for @ (also kept on this phone, so @ works before the screen was opened).
    setTimeout(() => { if (!team.loaded) loadTeam().catch(() => {}); }, 2500);

    // "@Name ...": you talk to that specialist from now on, like on the PC. With the PC on and a
    // project, the PC switches the chat (wisp-desktop.js); otherwise this chat becomes its chat,
    // answered from the cloud, with its face on top and its colour. "@Codeply" hands you back.
    form.addEventListener('submit', (e) => {
      const text = input.value.trim();
      const st = P().state;
      const c0 = st.current && P().chatMeta && P().chatMeta(st.current);
      if (c0 && st.busy && st.busy.has(c0.id)) return;
      const low = text.toLowerCase();
      const ends = (n) => !/[\w-]/.test(low.charAt(n));
      const spec = low.startsWith('@') ? cachedTeam().slice().sort((a, b) => b.name.length - a.name.length).find((s) => { const n = String(s.name).toLowerCase(); return low.startsWith(`@${n}`) && ends(n.length + 1); }) : null;
      const back = low.startsWith('@codeply') && ends(8);
      const pcOn = !!(P().relay && P().relay.pcId);
      const toPc = pcOn && ((c0 && c0.kind === 'code') || (st.ui && st.ui.useProject));
      if (back && c0 && c0.specialist) {
        // Back to Codeply: this chat is Codeply's again; the message goes on as usual.
        delete c0.specialist;
        if (P().saveChats) P().saveChats();
        input.placeholder = 'Ask anything';
        return;
      }
      if (spec && !toPc) {
        e.preventDefault(); e.stopImmediatePropagation(); shut();
        const chat = c0 && c0.kind === 'chat' ? c0 : P().createChat('chat', { title: text.slice(0, 48) });
        chat.specialist = { id: spec.id, name: spec.name };
        if (P().saveChats) P().saveChats();
        input.placeholder = `Message ${spec.name}`;
        chatSend(chat, text);
        return;
      }
      if (spec) return; // the PC's Codeply hands the chat to it, with the project
      // A chat with one specialist: everything typed here goes to it.
      if (c0 && c0.specialist && text) { e.preventDefault(); e.stopImmediatePropagation(); shut(); chatSend(c0, text); return; }
    }, true);
  }

  // ─── A chat with one specialist ────────────────────────────────────────────
  const strip = (t) => String(t || '').replace(/^-# [^\n]*\n/, '');
  function startChat(s) {
    const C = P();
    const chat = C.createChat('chat', { title: `Chat with ${s.name}`, specialist: { id: s.id, name: s.name } });
    const b = C.chatBody(chat.id);
    b.messages.push({ role: 'assistant', content: `-# ${s.name}\nHi, I'm ${s.name}${s.focus ? `, here for ${String(s.focus).replace(/\.$/, '').toLowerCase()}` : ''}. What do you need?`, at: Date.now() });
    C.saveBody(chat.id); if (C.saveChats) C.saveChats();
    C.openChat(chat.id, { keepMode: true });
    setTimeout(() => { const i = $('input'); if (i) { i.placeholder = `Message ${s.name}`; i.focus(); } }, 100);
  }
  async function chatSend(chat, text) {
    const C = P(); const st = C.state;
    const b = C.chatBody(chat.id);
    b.messages.push({ role: 'user', content: text, at: Date.now() });
    C.saveBody(chat.id); if (C.saveChats) C.saveChats();
    const input = $('input'); input.value = ''; input.dispatchEvent(new Event('input'));
    st.busy.add(chat.id);
    C.openChat(chat.id, { keepMode: true });
    const messages = b.messages.filter((m) => m.role === 'user' || m.role === 'assistant').slice(-20).map((m) => ({ role: m.role, content: strip(m.content).slice(0, 4000) }));
    const prev = b.messages.filter((m) => m.role === 'user').slice(-2, -1).map((m) => m.content)[0];
    // The web, like the main chat: searched (or the links read) before the specialist answers
    const web = await webFor(text, prev);
    if (web.note) messages[messages.length - 1] = { role: 'user', content: `${text}\n\n${web.note}` };
    let r;
    try { r = await fn({ action: 'chat', specialist: chat.specialist.id, messages }); } catch (err) { r = { ok: false, error: err.message }; }
    // "I can't browse the web": search for it and ask once more
    if (r && r.ok && !web.searched && window.CodeplyWeb && window.CodeplyWeb.refused(r.reply)) {
      const again = await webFor(text, prev, true);
      if (again.note) {
        messages[messages.length - 1] = { role: 'user', content: `${text}\n\n${again.note}` };
        web.sources.push(...again.sources);
        try { const r2 = await fn({ action: 'chat', specialist: chat.specialist.id, messages }); if (r2 && r2.ok) r = r2; } catch { /* keep the first reply */ }
      }
    }
    st.busy.delete(chat.id);
    const seen = new Set();
    const sources = web.sources.filter((x) => x && x.url && !seen.has(x.url) && seen.add(x.url)).slice(0, 8);
    b.messages.push({ role: 'assistant', content: `-# ${chat.specialist.name}\n${r && r.ok ? r.reply : (r && r.error) || 'It could not answer.'}`, at: Date.now(), ...(r && r.ok && sources.length ? { sources } : {}) });
    C.saveBody(chat.id); if (C.saveChats) C.saveChats();
    if (st.current === chat.id) C.openChat(chat.id, { keepMode: true });
  }

  // ─── Its own face on its answers ───────────────────────────────────────────
  // phone-wisp.js puts Wisp's face above every answer. An answer from a
  // specialist (its chat, an @mention answered from the cloud: the answer starts
  // with "-# Name", or a PC chat the user switched to it: phone.js markSpeaker)
  // wears that specialist's look instead: its shape, colour and gear.
  const CODEPLY_COLOR = '#4C8DFF';
  /** Dark text on a light colour (yellow, lime), white on a deep one, so a bubble always reads. */
  function inkOn(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return '#fff';
    const n = parseInt(m[1], 16);
    const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const L = 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
    return L > 0.36 ? '#141414' : '#fff';
  }
  function paintBubble(el, color) {
    if (el.dataset.bubble === color) return;
    el.dataset.bubble = color;
    el.style.setProperty('--bubble', color);
    el.style.setProperty('--bubble-ink', inkOn(color));
  }

  function faceSpecialists() {
    const f = $('feed');
    if (!f) return;
    const list = cachedTeam();
    const st = P().state || {};
    const chat = st.current && P().chatMeta ? P().chatMeta(st.current) : null;
    const own = chat && chat.specialist ? list.find((x) => x.id === chat.specialist.id) : null;
    let speaking = null; // who the PC chat is talking to, as the feed goes
    [...f.children].forEach((face) => {
      if (face.classList.contains('msg') && face.classList.contains('user')) {
        if (face.dataset.speaker) {
          try { speaking = face.dataset.speaker === 'codeply' ? null : JSON.parse(face.dataset.speaker); } catch { speaking = null; }
        }
        return;
      }
      if (!face.classList.contains('turn-face')) return;
      let n = face.nextElementSibling;
      while (n && !(n.classList.contains('msg') && (n.classList.contains('agent') || n.classList.contains('user')))) n = n.nextElementSibling;
      const small = n && n.classList.contains('agent') ? n.querySelector(':scope > .md-small:first-child') : null;
      const name = small ? small.textContent.trim().toLowerCase() : '';
      // The card from the PC has the look; the team on this phone may have a newer one.
      const live = speaking && (list.find((x) => x.id === speaking.id) || speaking);
      const spec = (name && list.find((x) => String(x.name).toLowerCase() === name)) || live || own;
      const key = spec ? spec.id : '';
      if ((face.dataset.spec || '') === key) return;
      const holder = face.querySelector('.wisp-el');
      const w = holder && holder.wisp;
      if (!w || !w.dress) return;
      face.dataset.spec = key;
      w.dress(spec ? { shape: spec.shape || 'circle', color: spec.color, gear: spec.gear || undefined } : null, false);
    });
    // The header (phone-wisp.js): who answers your next message, in its colour.
    const now = (speaking && (list.find((x) => x.id === speaking.id) || speaking)) || own || null;
    if (window.CraftPhoneWho) window.CraftPhoneWho.set(now && now.shape ? now : now ? { ...now, shape: 'circle' } : null);
    // All your messages wear the colour of whoever is answering now (like Todd's green bubbles):
    // Codeply's blue, or the specialist's. Switch agents and the whole chat changes colour.
    const color = (now && now.color) || CODEPLY_COLOR;
    f.querySelectorAll(':scope > .msg.user').forEach((u) => paintBubble(u, color));
  }
  let faceQueued = false;
  const queueFaces = () => { if (faceQueued) return; faceQueued = true; requestAnimationFrame(() => { faceQueued = false; faceSpecialists(); }); };

  function wire() {
    wireMentions();
    // data-speaker: phone.js marks a turn with who answers it after the face is already drawn.
    new MutationObserver(queueFaces).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-speaker'] });
    queueFaces();
    // The drawer's Specialists opens this screen (phone-work.js adds the item).
    const hook = () => {
      if (window.CraftWork) window.CraftWork.openSpecialists = open;
      const item = $('drawerSpecialists');
      if (item && !item.dataset.spx) {
        item.dataset.spx = '1';
        const fresh = item.cloneNode(true);
        item.replaceWith(fresh);
        fresh.addEventListener('click', () => { if (P().closeDrawer) P().closeDrawer(); open(); });
      }
    };
    hook(); setTimeout(hook, 800);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
  window.CraftSpecialists = { open, loadTeam, team, startChat };
})();
