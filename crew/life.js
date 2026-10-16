// Crew's Life page and the life parts of a bot (window.CrewLife).
//
//   Life page     one switch for the whole life context, what the bots know
//                 right now, each source on or off (and Forget), the nudges
//                 (which ones, how many a day, quiet hours, who says them),
//                 the call helper, the bots' own email, the autopilot with its
//                 outbox and action log, and Stop all bots.
//   Bot editor    what this bot may read, which nudges it sends, how much it
//                 may do alone, how it steps in on calls, its email address.
//   Thread cards  a nudge (Helpful / Not now / Stop these), an email to or
//                 from the bot, a task it did by itself.
//
// Everything comes from the main process (life-desktop.js) through
// window.crew.life*; this file only draws and sends the user's choices back.
(() => {
  const api = window.crew;
  const { esc } = window.CrewMarkdown;
  const $ = (sel, root = document) => root.querySelector(sel);
  const S = () => window.CrewState;
  let life = null;      // the last state from life-desktop.js
  let open = false;     // the Life page is showing
  let searchText = '';

  const ICON = {
    life: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
    stop: '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
    x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  };
  const ago = (t) => {
    if (!t) return 'never';
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
  };
  const clock = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const dayTime = (t) => {
    const d = new Date(t); const today = new Date();
    const same = d.toDateString() === today.toDateString();
    const tomorrow = d.toDateString() === new Date(Date.now() + 86400000).toDateString();
    return same ? clock(t) : tomorrow ? `tomorrow ${clock(t)}` : d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  };
  const botName = (id) => ((S().catalog.bots || []).find((b) => b.id === id) || {}).name || '';
  const toast = (t, k) => (window.crewToast ? window.crewToast(t, k) : null);

  async function refresh() {
    try { life = await api.lifeState(); } catch { life = null; }
    if (open) paint();
    return life;
  }

  // ─── The Life page ────────────────────────────────────────────────────────

  function nowHtml(n) {
    if (!n) return '';
    const rows = [];
    if (n.onCall) rows.push(['On a call', n.onCall.app || 'now']);
    if (n.doing) rows.push(['On screen', `${n.doing.app}${n.doing.title ? `, ${n.doing.title}` : ''}`]);
    for (const e of n.next.slice(0, 4)) rows.push([e.allDay ? 'All day' : e.live ? 'Now' : dayTime(e.at), `${e.title}${e.place ? ` at ${e.place}` : ''}`]);
    for (const w of n.waiting.slice(0, 3)) rows.push(['Waiting on you', `${w.from}, "${w.subject}" (${w.hours} h)`]);
    for (const p of n.projects.slice(0, 3)) rows.push(['Project', `${p.name}${p.lastPush ? `, pushed ${ago(p.lastPush)}` : ''}${p.unpushed ? `, ${p.unpushed} not pushed` : ''}`]);
    for (const c of n.calls.slice(0, 2)) rows.push(['Call', `${c.title}${c.summary ? `: ${c.summary}` : ''}`]);
    for (const w of n.watched.slice(0, 2)) rows.push(['Watched', `${w.title} (${w.minutes} min)`]);
    for (const t of n.tasks.slice(0, 3)) rows.push(['Bot task', `${t.text} (${t.status.replace('_', ' ')})`]);
    return `<section class="life-card">
      <div class="life-card-head"><b>Right now</b><span class="dim">${esc(n.local)}</span></div>
      ${rows.length ? `<div class="life-rows">${rows.map(([k, v]) => `<div class="life-row"><span>${esc(k)}</span><div>${esc(v)}</div></div>`).join('')}</div>` : '<div class="dim">Nothing yet. The sources below fill this in over the next few minutes.</div>'}
      <div class="life-search"><input class="input" id="lifeSearch" placeholder="Search what your bots know" value="${esc(searchText)}"><div id="lifeHits"></div></div>
    </section>`;
  }

  function sourcesHtml(l) {
    return `<section class="life-card"><div class="life-card-head"><b>What your bots can see</b><span class="dim">kept on this PC</span></div>
      ${l.sources.map((s) => `<div class="life-src${s.on ? '' : ' off'}">
        <label class="life-src-main"><input type="checkbox" data-src="${esc(s.key)}" ${s.on ? 'checked' : ''}><span><b>${esc(s.label)}${s.sensitive ? ' <span class="life-tag">sealed</span>' : ''}</b><span class="dim">${esc(s.note)}</span></span></label>
        <span class="life-src-meta">${s.problem ? `<span class="err-text" title="${esc(s.problem)}">Problem</span>` : s.count ? `${s.count} · ${esc(ago(s.last))}` : ''}${s.count ? `<button class="link" data-forget-src="${esc(s.key)}">Forget</button>` : ''}</span>
      </div>`).join('')}
      ${!l.google ? '<div class="note">Connect Gmail in Connect Apps to add your calendar and email.</div>' : ''}
      ${!l.canSeal ? '<div class="note err">This PC cannot protect the key for sealed items, so call transcripts are not kept.</div>' : ''}
      ${l.platform !== 'win32' ? '<div class="dim">Seeing the window in front works on Windows for now.</div>' : ''}
    </section>`;
  }

  function nudgesHtml(l) {
    const n = l.nudges;
    const bots = S().catalog.bots || [];
    const fb = { helpful: 'Helpful', later: 'Not now', stop: 'Stopped' };
    return `<section class="life-card"><div class="life-card-head"><b>Bots that reach out</b><label class="life-switch"><input type="checkbox" data-nudge="on" ${n.on ? 'checked' : ''}><span></span></label></div>
      <div class="dim">Your bots message or call you when something needs you, without being asked. A desktop notification while you are at this PC, your phone otherwise, and a note in the bot's chat.</div>
      <div class="life-grid">
        <label>At most <input class="input life-num" type="number" min="0" max="30" data-nudge="perDay" value="${Number(n.perDay)}"> a day</label>
        <label class="check"><input type="checkbox" data-nudge="phone" ${n.phone !== false ? 'checked' : ''}>Use my phone when I am away</label>
        <label class="check"><input type="checkbox" data-nudge="quiet" ${n.quiet.on ? 'checked' : ''}>Quiet hours</label>
        <span class="life-quiet"><input type="time" class="input ao-time" data-nudge="from" value="${esc(n.quiet.from)}"> to <input type="time" class="input ao-time" data-nudge="to" value="${esc(n.quiet.to)}"></span>
      </div>
      <div class="life-trigs">${n.triggers.map((t) => `<div class="life-trig">
        <label class="check"><input type="checkbox" data-trig="${esc(t.key)}" ${t.on ? 'checked' : ''}><span><b>${esc(t.label)}</b><span class="dim">${esc(t.note)}</span></span></label>
        <select class="input life-who" data-who="${esc(t.key)}"><option value="">Best fit</option>${bots.map((b) => `<option value="${esc(b.id)}" ${(n.botFor || {})[t.key] === b.id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select>
      </div>`).join('')}</div>
      ${n.list.length ? `<div class="life-sub">Lately</div><div class="life-list">${n.list.slice(0, 12).map((x) => `<div class="life-li"><span class="dim">${esc(dayTime(x.at))}</span><div><b>${esc(botName(x.botId) || 'Codeply')}</b> ${esc(x.text)}</div><span class="dim">${x.feedback ? esc(fb[x.feedback] || '') : ''}</span></div>`).join('')}</div>` : ''}
    </section>`;
  }

  function callsHtml(l) {
    const c = l.calls || {};
    const st = l.callNow || null;
    return `<section class="life-card"><div class="life-card-head"><b>Call helper</b><span class="dim">free, on this PC</span></div>
      <div class="dim">During a call on this PC (Meet, Zoom, Teams, WhatsApp, Discord, or a phone call through Phone Link) a bot listens, writes it down, shows you what is relevant, and whispers suggestions. Mute yourself and it offers to take over: it says it is your assistant, gives your excuse and ends the call. Speech to text runs on this PC with Whisper. No audio is kept, only the text.</div>
      <div class="seg life-seg">${[['ask', 'Ask me each call'], ['always', 'Always listen'], ['off', 'Off']].map(([k, label]) => `<button class="${c.listen === k ? 'on' : ''}" data-listen="${k}">${label}</button>`).join('')}</div>
      <label class="check life-consent"><input type="checkbox" data-consent ${c.consentAck ? 'checked' : ''}><span>I will tell the people on my calls that an assistant is listening. Many places require everyone's consent before a call is recorded or transcribed.</span></label>
      <label class="check"><input type="checkbox" data-whisper-voice ${c.whisperVoice ? 'checked' : ''}><span>Whisper suggestions out loud too (use headphones)</span></label>
      <div class="life-grid"><label>Who helps <select class="input life-who" data-call-bot><option value="">Best fit</option>${(S().catalog.bots || []).map((b) => `<option value="${esc(b.id)}" ${c.botId === b.id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></label>
        ${st && st.active ? `<span class="dim">Listening to a ${esc(st.app || '')} call now.</span>` : `<button class="btn" data-act="listen-now" ${c.consentAck ? '' : 'disabled title="Confirm the line above first"'}>Listen to a call now</button>`}</div>
      ${l.takeoverReady === false ? '<div class="dim">To let a bot speak in the call, install VB-CABLE (free) and pick "CABLE Output" as the microphone in your call app. Without it the bot can still listen and whisper.</div>' : ''}
    </section>`;
  }

  function mailHtml(l) {
    const m = l.mail;
    if (!m) return '';
    return `<section class="life-card"><div class="life-card-head"><b>Your bots' email</b><span class="dim">${m.domain ? esc(m.domain) : ''}</span></div>
      <div class="dim">Each bot can have its own address and send and receive mail as itself. Your crew shares ${m.limits.month} emails a month and ${m.limits.day} a day, sent and received together.</div>
      ${m.error ? `<div class="note err">${esc(m.error)}</div>` : `<div class="life-meter"><span style="width:${Math.min(100, Math.round((m.used.month / Math.max(1, m.limits.month)) * 100))}%"></span></div>
      <div class="dim">${m.used.month} of ${m.limits.month} this month, ${m.used.day} of ${m.limits.day} today</div>`}
      ${(m.boxes || []).length ? `<div class="life-list">${m.boxes.map((b) => `<div class="life-li"><b>${esc(b.botName)}</b><div>${esc(b.address)}</div></div>`).join('')}</div>` : '<div class="dim">Give a bot an address in its settings (Edit bot, Email).</div>'}
    </section>`;
  }

  function autopilotHtml(l) {
    const a = l.autopilot || {};
    const outbox = a.outbox || []; const tasks = a.tasks || []; const auditList = a.audit || [];
    return `<section class="life-card"><div class="life-card-head"><b>Autopilot</b><button class="btn danger" data-act="stop-all">${ICON.stop}Stop all bots</button></div>
      <div class="dim">Bots take tasks from you on calls, by email, on Slack or in chat, plan them, do them, check they worked, and report back. How much each bot may do alone is in its settings. Deleting things, money and anything someone else asked for always wait for you.</div>
      ${a.paused ? '<div class="note err">All bots are stopped. Nothing runs on its own until you resume.</div><button class="btn" data-act="resume">Resume</button>' : ''}
      ${outbox.length ? `<div class="life-sub">Waiting to go out</div><div class="life-list">${outbox.map((o) => `<div class="life-li"><span class="dim">goes ${esc(dayTime(o.dueAt))}</span><div><b>${esc(botName(o.botId))}</b> ${esc(o.title)}</div><span><button class="btn" data-outbox-now="${esc(o.id)}">Send now</button><button class="btn danger" data-outbox-cancel="${esc(o.id)}">Cancel</button></span></div>`).join('')}</div>` : ''}
      ${tasks.length ? `<div class="life-sub">Tasks</div><div class="life-list">${tasks.map((t) => `<div class="life-li"><span class="life-status s-${esc(t.status)}">${esc(t.status.replace('_', ' '))}</span><div><b>${esc(botName(t.botId) || 'A bot')}</b> ${esc(t.text)}${t.data && t.data.report ? `<div class="dim">${esc(t.data.report)}</div>` : ''}</div>${['queued', 'running', 'needs_you'].includes(t.status) ? `<button class="btn" data-task-cancel="${esc(t.id)}">Cancel</button>` : '<span></span>'}</div>`).join('')}</div>` : ''}
      ${auditList.length ? `<details class="life-audit"><summary>Everything the bots did alone (${auditList.length})</summary><div class="life-list">${auditList.map((x) => `<div class="life-li"><span class="dim">${esc(dayTime(x.at))}</span><div><b>${esc(botName(x.botId) || 'Codeply')}</b> ${esc(x.title)}${x.result ? `<div class="dim">${esc(x.result)}</div>` : ''}</div><span class="dim">${esc(x.verdict || '')}</span></div>`).join('')}</div></details>` : ''}
    </section>`;
  }

  function paint() {
    const view = $('#view');
    if (!view || !open) return;
    const l = life;
    if (!l || l.error && !l.sources) {
      view.innerHTML = `<div class="life"><h1 class="life-title">Life</h1><div class="note err">${esc((l && l.error) || 'The life context did not load.')}</div></div>`;
      return;
    }
    const scroll = view.querySelector('.life') ? view.querySelector('.life').scrollTop : 0;
    view.innerHTML = `<div class="life">
      <div class="life-head"><div><h1 class="life-title">Life</h1><p class="dim">One picture of your day that every bot reads, so they can help before you ask.</p></div>
        <label class="life-switch big"><input type="checkbox" data-life-on ${l.on ? 'checked' : ''}><span></span></label></div>
      ${l.on ? `${nowHtml(l.now)}${sourcesHtml(l)}${nudgesHtml(l)}${callsHtml(l)}${mailHtml(l)}${autopilotHtml(l)}
        <div class="life-foot"><button class="btn danger" data-act="clear">Forget everything</button><span class="dim">Turning Life off stops it; Forget everything also deletes what it kept.</span></div>`
    : `<section class="life-card life-intro"><b>Give your crew your context</b>
        <p class="dim">Turn this on and your bots share what is going on: your calendar, who emailed and who is waiting on you, your calls, your plans, your projects and pushes, and the window you have open (its title, every 30 seconds, never a screenshot). It stays on this PC. You choose each source, and each bot's access.</p>
        <button class="btn primary" data-act="turn-on">Turn on Life</button></section>`}
    </div>`;
    if (view.querySelector('.life')) view.querySelector('.life').scrollTop = scroll;
    wire(view);
  }

  async function set(patch) {
    const r = await api.lifeSet(patch);
    if (r && r.error) { toast(r.error, 'error'); return; }
    life = { ...life, ...r };
    paint();
  }

  function wire(view) {
    const on = (sel, ev, fn) => view.querySelectorAll(sel).forEach((el) => el.addEventListener(ev, (e) => fn(el, e)));
    on('[data-life-on]', 'change', (el) => set({ on: el.checked }));
    on('[data-act="turn-on"]', 'click', () => set({ on: true }));
    on('[data-src]', 'change', (el) => set({ sources: { [el.dataset.src]: el.checked } }));
    on('[data-forget-src]', 'click', async (el) => { const r = await api.lifeForgetSource(el.dataset.forgetSrc); if (!r.error) { life = { ...life, ...r }; paint(); } });
    on('[data-act="clear"]', 'click', async (el) => {
      if (!el.dataset.sure) { el.dataset.sure = '1'; el.textContent = 'Click again to forget everything'; return; }
      const r = await api.lifeClear(); if (!r.error) { life = { ...life, ...r }; paint(); toast('Forgot everything.'); }
    });
    on('[data-nudge]', 'change', (el) => {
      const k = el.dataset.nudge;
      if (k === 'on' || k === 'phone') set({ nudges: { [k]: el.checked } });
      else if (k === 'perDay') set({ nudges: { perDay: Number(el.value) } });
      else if (k === 'quiet') set({ nudges: { quiet: { on: el.checked } } });
      else if ((k === 'from' || k === 'to') && /^\d\d:\d\d$/.test(el.value)) set({ nudges: { quiet: { [k]: el.value } } });
    });
    on('[data-trig]', 'change', (el) => set({ nudges: { triggers: { [el.dataset.trig]: el.checked } } }));
    on('[data-who]', 'change', (el) => set({ nudges: { botFor: { [el.dataset.who]: el.value } } }));
    on('[data-listen]', 'click', (el) => set({ calls: { listen: el.dataset.listen } }));
    on('[data-consent]', 'change', (el) => set({ calls: { consentAck: el.checked } }));
    on('[data-whisper-voice]', 'change', (el) => set({ calls: { whisperVoice: el.checked } }));
    on('[data-call-bot]', 'change', (el) => set({ calls: { botId: el.value } }));
    on('[data-act="listen-now"]', 'click', async () => { const r = await api.lifeListenNow(); if (r && r.error) toast(r.error, 'error'); else refresh(); });
    on('[data-act="stop-all"]', 'click', async () => { const r = await api.lifeStopAll(); if (r && !r.error) { life = { ...life, ...r }; paint(); toast('Stopped every bot. Nothing runs on its own until you resume.', 'alert'); } });
    on('[data-act="resume"]', 'click', () => set({ autopilot: { paused: false } }));
    on('[data-outbox-cancel]', 'click', async (el) => { const r = await api.lifeOutbox(el.dataset.outboxCancel, 'cancel'); if (r && !r.error) refresh(); });
    on('[data-outbox-now]', 'click', async (el) => { const r = await api.lifeOutbox(el.dataset.outboxNow, 'now'); if (r && !r.error) refresh(); });
    on('[data-task-cancel]', 'click', async (el) => { const r = await api.lifeTask(el.dataset.taskCancel, 'cancel'); if (r && !r.error) refresh(); });
    const search = $('#lifeSearch', view);
    if (search) {
      let t = null;
      const go = async () => {
        searchText = search.value;
        const box = $('#lifeHits', view);
        if (!searchText.trim()) { box.innerHTML = ''; return; }
        const hits = await api.lifeSearch(searchText);
        box.innerHTML = Array.isArray(hits) && hits.length
          ? hits.slice(0, 12).map((x) => `<div class="life-hit"><span class="dim">${esc(dayTime(x.at))} · ${esc(x.source)}</span><div>${esc(x.title)}${x.people && x.people.length ? ` <span class="dim">${esc(x.people.slice(0, 2).join(', '))}</span>` : ''}</div><button class="icon-btn" data-forget-item="${esc(x.id)}" title="Forget this">${ICON.x}</button></div>`).join('')
          : '<div class="dim">Nothing found.</div>';
        box.querySelectorAll('[data-forget-item]').forEach((b) => b.addEventListener('click', async () => { await api.lifeForgetItem(b.dataset.forgetItem); go(); }));
      };
      search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(go, 250); });
      if (searchText) go();
    }
  }

  function show() {
    open = true;
    const st = S();
    st.current = null; st.currentGroup = null;
    document.querySelectorAll('.bot-item.on').forEach((x) => x.classList.remove('on'));
    const nav = $('#lifeNav'); if (nav) nav.classList.add('on');
    paint();
    refresh();
  }
  function hide() { open = false; const nav = $('#lifeNav'); if (nav) nav.classList.remove('on'); }

  // ─── The bot editor ───────────────────────────────────────────────────────

  const AUTONOMY = { ask: 'Ask me first', hold: 'Do it after a wait I can cancel', full: 'Just do it' };
  const STYLES = { friendly: 'Warm and casual', formal: 'Polite and formal', brief: 'Short and to the point', playful: 'Light and a bit funny' };
  function editorHtml(d, ui) {
    d.life = { read: true, sensitive: false, sources: null, speaksFor: [], ...(d.life || {}) };
    d.autonomy = { level: 'ask', holdMinutes: 10, allow: ['edit_files', 'run_commands'], budgets: { runs: 10, emails: 10, posts: 3, deploys: 3 }, ...(d.autonomy || {}) };
    d.callStyle = { style: 'friendly', excuses: [], ...(d.callStyle || {}) };
    d.email = { address: '', on: false, ...(d.email || {}) };
    const trig = (life && life.nudges && life.nudges.triggers) || [];
    const approvals = (S().catalog && S().catalog.approvals) || {};
    return `<div class="field life-bot"><div class="field-label">Life</div>
      <label class="check"><input type="checkbox" data-lb="read" ${d.life.read ? 'checked' : ''}><span>Reads your life context (calendar, email, plans, projects, what is on screen)</span></label>
      <label class="check"><input type="checkbox" data-lb="sensitive" ${d.life.sensitive ? 'checked' : ''}><span>Also your calls (transcripts and summaries)</span></label>
      ${trig.length ? `<div class="dim" style="margin:8px 0 4px">Reaches out about</div><div class="checks">${trig.map((t) => `<label class="check"><input type="checkbox" data-lb-trig="${esc(t.key)}" ${d.life.speaksFor.includes(t.key) ? 'checked' : ''}>${esc(t.label)}</label>`).join('')}</div>` : ''}
    </div>
    <div class="field life-bot"><div class="field-label">On its own</div>
      <select class="input" data-lb="level">${Object.entries(AUTONOMY).map(([k, v]) => `<option value="${k}" ${d.autonomy.level === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>
      <div class="life-more" ${d.autonomy.level === 'ask' ? 'hidden' : ''}>
        ${d.autonomy.level === 'hold' ? `<label class="dim">Wait <input class="input life-num" type="number" min="1" max="240" data-lb="hold" value="${Number(d.autonomy.holdMinutes)}"> minutes before emails, posts and deploys go out, so you can cancel from your phone.</label>` : ''}
        ${d.autonomy.level === 'full' ? `<div class="dim" style="margin:6px 0 4px">Does these at once</div><div class="checks">${Object.entries(approvals).map(([k, label]) => `<label class="check"><input type="checkbox" data-lb-allow="${k}" ${d.autonomy.allow.includes(k) ? 'checked' : ''}>${esc(label)}</label>`).join('')}</div>` : ''}
        <div class="dim" style="margin-top:6px">A day at most: <input class="input life-num" type="number" min="0" max="200" data-lb-budget="runs" value="${Number(d.autonomy.budgets.runs)}"> tasks, <input class="input life-num" type="number" min="0" max="200" data-lb-budget="emails" value="${Number(d.autonomy.budgets.emails)}"> emails, <input class="input life-num" type="number" min="0" max="50" data-lb-budget="deploys" value="${Number(d.autonomy.budgets.deploys)}"> deploys.</div>
      </div>
    </div>
    <div class="field life-bot"><div class="field-label">On calls</div>
      <select class="input" data-lb="style">${Object.entries(STYLES).map(([k, v]) => `<option value="${k}" ${d.callStyle.style === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>
      <textarea class="input" rows="2" data-lb="excuses" placeholder="Excuses it may give, one per line. Example: Awais's internet just dropped, he will call you back later.">${esc(d.callStyle.excuses.join('\n'))}</textarea>
      <div class="dim">It always says it is your assistant. It never pretends to be you.</div>
    </div>
    ${ui && ui.id ? `<div class="field life-bot"><div class="field-label">Email</div>
      ${d.email.address ? `<div class="life-addr"><b>${esc(d.email.address)}</b><button class="link" data-act="mail-release">Give it up</button></div><div class="dim">Mail to this address comes to ${esc(d.name || 'the bot')}. What it sends goes out from here, as itself.</div>`
    : `<div class="life-addr"><input class="input" data-lb="local" maxlength="40" placeholder="${esc(String(d.name || 'bot').toLowerCase().replace(/[^a-z0-9]+/g, '') || 'bot')}"><span class="dim">@codeply.app</span><button class="btn" data-act="mail-claim">Get address</button></div><span class="err-text" data-mail-err></span>`}
    </div>` : ''}`;
  }

  function wireEditor(m, d, ui, repaint) {
    const q = (sel) => m.querySelectorAll(sel);
    q('[data-lb]').forEach((el) => el.addEventListener(el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input', () => {
      const k = el.dataset.lb;
      if (k === 'read' || k === 'sensitive') d.life[k] = el.checked;
      else if (k === 'level') { d.autonomy.level = el.value; repaint(); }
      else if (k === 'hold') d.autonomy.holdMinutes = Number(el.value) || 10;
      else if (k === 'style') d.callStyle.style = el.value;
      else if (k === 'excuses') d.callStyle.excuses = el.value.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 8);
    }));
    q('[data-lb-trig]').forEach((el) => el.addEventListener('change', () => {
      const k = el.dataset.lbTrig;
      d.life.speaksFor = el.checked ? [...new Set([...d.life.speaksFor, k])] : d.life.speaksFor.filter((x) => x !== k);
    }));
    q('[data-lb-allow]').forEach((el) => el.addEventListener('change', () => {
      const k = el.dataset.lbAllow;
      d.autonomy.allow = el.checked ? [...new Set([...d.autonomy.allow, k])] : d.autonomy.allow.filter((x) => x !== k);
    }));
    q('[data-lb-budget]').forEach((el) => el.addEventListener('input', () => { d.autonomy.budgets[el.dataset.lbBudget] = Number(el.value) || 0; }));
    const claim = m.querySelector('[data-act="mail-claim"]');
    if (claim) claim.addEventListener('click', async () => {
      const local = (m.querySelector('[data-lb="local"]').value || m.querySelector('[data-lb="local"]').placeholder).trim();
      claim.disabled = true; claim.textContent = 'Getting it...';
      const r = await api.botMailClaim(ui.id, local);
      claim.disabled = false; claim.textContent = 'Get address';
      if (!r || r.error) { m.querySelector('[data-mail-err]').textContent = (r && r.error) || 'That did not work.'; return; }
      S().catalog = r.catalog || S().catalog; d.email = r.bot.email; repaint();
      toast(`${d.name} is ${r.bot.email.address} now.`);
    });
    const release = m.querySelector('[data-act="mail-release"]');
    if (release) release.addEventListener('click', async () => {
      if (!release.dataset.sure) { release.dataset.sure = '1'; release.textContent = 'Click again to give it up'; return; }
      const r = await api.botMailRelease(ui.id);
      if (!r || r.error) { toast((r && r.error) || 'That did not work.', 'error'); return; }
      S().catalog = r.catalog || S().catalog; d.email = r.bot.email; repaint();
    });
  }
  const editorPatch = (d) => ({ life: d.life, autonomy: d.autonomy, callStyle: d.callStyle });

  // ─── Cards in a bot's thread ──────────────────────────────────────────────

  function cardHtml(m) {
    if (m.kind === 'nudge') {
      const done = m.feedback ? { helpful: 'Thanks, noted.', later: 'Okay, later.', stop: 'Okay, no more of these.' }[m.feedback] : '';
      return `<div class="lcard nudge" data-nudge-id="${esc(m.id)}">
        ${m.label ? `<div class="lcard-kind">${esc(m.label)}</div>` : ''}<div>${esc(m.text)}</div>
        <div class="lcard-actions">${done ? `<span class="dim">${esc(done)}</span>` : `<button class="btn" data-fb="helpful">Helpful</button><button class="btn" data-fb="later">Not now</button><button class="btn" data-fb="stop">Stop these</button>`}${m.url ? `<button class="btn" data-open-url="${esc(m.url)}">Open</button>` : ''}</div></div>`;
    }
    if (m.kind === 'botmail') {
      const inbound = m.dir !== 'out';
      return `<div class="lcard mail${inbound ? '' : ' out'}"><div class="lcard-kind">${inbound ? `Email from ${esc(m.fromName || m.from || '')}` : `Emailed ${esc(m.to || '')}`}${m.held ? ' <span class="life-tag">held, from someone else</span>' : ''}</div>
        <b>${esc(m.subject || '(no subject)')}</b>${m.summary ? `<div class="dim">${esc(m.summary)}</div>` : ''}
        ${m.text ? `<details><summary>The email</summary><div class="lcard-body">${esc(m.text)}</div></details>` : ''}
        ${m.draft ? `<details open><summary>Reply ${inbound ? 'drafted' : ''}</summary><div class="lcard-body">${esc(m.draft)}</div></details><div class="lcard-actions">${m.replied ? '<span class="dim">Sent.</span>' : `<button class="btn primary" data-mail-send="${esc(m.id)}">Send reply</button>`}</div>` : ''}
      </div>`;
    }
    if (m.kind === 'slack') {
      return `<div class="lcard mail"><div class="lcard-kind">Slack from ${esc(m.fromName || 'someone')}</div>
        <div>${esc(m.text || '')}</div>${m.summary ? `<div class="dim">${esc(m.summary)}</div>` : ''}
        ${m.draft ? `<details open><summary>A reply you could send</summary><div class="lcard-body">${esc(m.draft)}</div></details>` : ''}
        <div class="lcard-actions">${m.draft ? `<button class="btn" data-copy="${esc(m.draft)}">Copy reply</button>` : ''}${m.url ? `<button class="btn" data-open-url="${esc(m.url)}">Open in Slack</button>` : ''}</div></div>`;
    }
    if (m.kind === 'task') {
      return `<div class="lcard task"><div class="lcard-kind">Task from ${esc(m.source || 'you')}<span class="life-status s-${esc(m.status || '')}">${esc(String(m.status || '').replace('_', ' '))}</span></div>
        <div>${esc(m.text || '')}</div>${m.report ? `<div class="lcard-body">${esc(m.report)}</div>` : ''}${m.checked ? `<div class="dim">Checked: ${esc(m.checked)}</div>` : ''}</div>`;
    }
    return '';
  }
  function wireCards(root) {
    root.querySelectorAll('.lcard.nudge [data-fb]').forEach((b) => {
      if (b.dataset.wired) return;
      b.dataset.wired = '1';
      b.addEventListener('click', async () => {
        const card = b.closest('[data-nudge-id]');
        const r = await api.lifeNudge(card.dataset.nudgeId, b.dataset.fb);
        if (r && !r.error) card.querySelector('.lcard-actions').innerHTML = `<span class="dim">${esc({ helpful: 'Thanks, noted.', later: 'Okay, later.', stop: 'Okay, no more of these.' }[b.dataset.fb])}</span>`;
      });
    });
    root.querySelectorAll('[data-copy]').forEach((b) => {
      if (b.dataset.wired) return;
      b.dataset.wired = '1';
      b.addEventListener('click', async () => { try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'Copied'; } catch { toast('Could not copy.', 'error'); } });
    });
    root.querySelectorAll('[data-mail-send]').forEach((b) => {
      if (b.dataset.wired) return;
      b.dataset.wired = '1';
      b.addEventListener('click', async () => {
        b.disabled = true; b.textContent = 'Sending...';
        const r = await api.botMailReply(b.dataset.mailSend);
        if (!r || r.error) { b.disabled = false; b.textContent = 'Send reply'; toast((r && r.error) || 'That did not send.', 'error'); return; }
        b.outerHTML = '<span class="dim">Sent.</span>';
      });
    });
  }

  function onState(st) { life = st; if (open) paint(); }

  // The sidebar entry, under New bot.
  function addNav() {
    const anchor = document.querySelector('.side-new');
    if (!anchor || $('#lifeNav')) return;
    anchor.insertAdjacentHTML('afterend', `<button class="side-new" id="lifeNav">${ICON.life}<span>Life</span></button>`);
    $('#lifeNav').addEventListener('click', () => show());
  }
  addNav();
  refresh();

  window.CrewLife = { show, hide, isOpen: () => open, refresh, onState, editorHtml, wireEditor, editorPatch, cardHtml, wireCards, state: () => life };
})();
