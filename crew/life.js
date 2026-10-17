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
  // Laid out like a settings app: a short header, today in four cards, one box
  // to ask what the bots know, then groups of rows (an icon, a name, one short
  // line, a switch). Long explanations live in the row's tooltip, not on screen.

  const G = (d, fill) => `<svg viewBox="0 0 24 24"${fill ? ' class="fill"' : ''}>${d}</svg>`;
  const SRC = {
    calendar: { c: '#ff453a', i: '<rect x="4" y="5" width="16" height="15" rx="3"/><path d="M4 10h16M9 3v4M15 3v4"/>' },
    gmail: { c: '#0a84ff', i: '<rect x="3.5" y="6" width="17" height="12.5" rx="2.5"/><path d="m4.5 7.5 7.5 6 7.5-6"/>' },
    calls: { c: '#30d158', i: '<path d="M6.5 4.5h3l1.5 4-2 1.3a10 10 0 0 0 5.2 5.2l1.3-2 4 1.5v3a1.5 1.5 0 0 1-1.6 1.5A15 15 0 0 1 5 6.1a1.5 1.5 0 0 1 1.5-1.6z"/>' },
    projects: { c: '#ff9f0a', i: '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.2h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>' },
    activity: { c: '#5e5ce6', i: '<rect x="3.5" y="4.5" width="17" height="11.5" rx="2"/><path d="M8.5 20h7M12 16v4"/>' },
    orbit: { c: '#64d2ff', i: '<path d="M12 4.5 13.8 10l5.7.2-4.5 3.4 1.6 5.4L12 15.8 7.4 19l1.6-5.4L4.5 10.2l5.7-.2z"/>' },
    plans: { c: '#ff375f', i: '<circle cx="9" cy="9" r="3"/><circle cx="16.5" cy="10" r="2.5"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0M14 19a4.5 4.5 0 0 1 7 0"/>' },
    botmail: { c: '#bf5af2', i: '<circle cx="12" cy="12" r="3.5"/><path d="M15.5 12v1.5a2.5 2.5 0 0 0 5 0V12a8.5 8.5 0 1 0-3.4 6.8"/>' },
    slack: { c: '#ac8e68', i: '<path d="M9.5 4v16M14.5 4v16M4 9.5h16M4 14.5h16"/>' },
    tasks: { c: '#8e8e93', i: '<rect x="4" y="4" width="16" height="16" rx="3.5"/><path d="m8.5 12 2.5 2.5 4.5-5"/>' },
  };
  const ROWICON = {
    bell: { c: '#ff9f0a', i: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>' },
    phone: { c: '#30d158', i: SRC.calls.i },
    moon: { c: '#5e5ce6', i: '<path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z"/>' },
    mobile: { c: '#0a84ff', i: '<rect x="7" y="3" width="10" height="18" rx="2.5"/><path d="M11 18h2"/>' },
    ear: { c: '#30d158', i: '<path d="M8 9a4 4 0 1 1 8 0c0 2.5-2.5 3.2-2.5 5.5a2.5 2.5 0 0 1-5 0"/><path d="M10.5 9.5a1.5 1.5 0 0 1 3 0"/>' },
    speaker: { c: '#64d2ff', i: '<path d="M5 9.5h3l4.5-4v13L8 14.5H5z"/><path d="M16 9a4 4 0 0 1 0 6"/>' },
    bot: { c: '#8e8e93', i: '<rect x="5" y="8" width="14" height="10" rx="3"/><path d="M12 4v4M9.5 13h.01M14.5 13h.01"/>' },
    mail: { c: '#bf5af2', i: SRC.botmail.i },
    robot: { c: '#0a84ff', i: '<path d="M12 3.5 14 9l5.5.5-4.2 3.6L16.6 19 12 16l-4.6 3 1.3-5.9L4.5 9.5 10 9z"/>' },
  };
  const tile = (ic) => `<span class="lf-ico" style="background:${ic.c}">${G(ic.i)}</span>`;
  const sw = (attrs, on) => `<label class="lf-switch"><input type="checkbox" ${attrs} ${on ? 'checked' : ''}><span></span></label>`;
  const row = ({ icon, title, sub, right, attr = '', cls = '' }) => `<div class="lf-row ${cls}" ${attr}>${icon ? tile(icon) : ''}<div class="lf-row-text"><div class="lf-row-title">${title}</div>${sub ? `<div class="lf-row-sub">${sub}</div>` : ''}</div><div class="lf-row-right">${right || ''}</div></div>`;
  const group = (title, body, aside = '') => `<section class="lf-group"><div class="lf-group-head"><h2>${title}</h2>${aside}</div><div class="lf-rows">${body}</div></section>`;

  // Today, in four cards: what's next, who is waiting on you, what you're on, your calls.
  function todayHtml(n, l) {
    if (!n) return '';
    const cal = (l.sources || []).find((s) => s.key === 'calendar');
    const next = n.next[0];
    const cards = [];
    cards.push(cal && cal.problem
      ? `<div class="lf-card warn" title="${esc(cal.problem)}">${tile(SRC.calendar)}<div class="lf-card-v">Calendar is off</div><div class="lf-card-l">Its sign-in expired</div><button class="lf-btn small" data-act="connect">Reconnect</button></div>`
      : `<div class="lf-card">${tile(SRC.calendar)}<div class="lf-card-v">${next ? esc(next.title) : 'Nothing next'}</div><div class="lf-card-l">${next ? esc(next.allDay ? 'All day' : next.live ? 'Happening now' : dayTime(next.at)) : 'Your calendar is clear'}</div></div>`);
    cards.push(`<div class="lf-card">${tile(SRC.gmail)}<div class="lf-card-v">${n.waiting.length ? `${n.waiting.length} waiting on you` : 'All caught up'}</div><div class="lf-card-l">${n.waiting.length ? esc(n.waiting.slice(0, 2).map((w) => w.from).join(', ')) : 'No one is waiting on a reply'}</div></div>`);
    cards.push(n.onCall
      ? `<div class="lf-card live">${tile(SRC.calls)}<div class="lf-card-v">On a call</div><div class="lf-card-l">${esc(n.onCall.app || 'Right now')}</div></div>`
      : `<div class="lf-card">${tile(SRC.activity)}<div class="lf-card-v">${n.doing ? esc(n.doing.app) : 'Away'}</div><div class="lf-card-l">${n.doing ? 'On your screen now' : 'Nothing in front right now'}</div></div>`);
    cards.push(`<div class="lf-card">${tile(SRC.calls)}<div class="lf-card-v">${n.calls.length ? `${n.calls.length} recent call${n.calls.length === 1 ? '' : 's'}` : 'No calls yet'}</div><div class="lf-card-l">${n.calls.length ? esc(n.calls[0].title) : 'Calls with your bots show here'}</div></div>`);
    return `<div class="lf-today">${cards.join('')}</div>
      <div class="lf-ask"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input id="lifeSearch" placeholder="Ask what your bots know about your day" value="${esc(searchText)}" autocomplete="off"></div>
      <div id="lifeHits" class="lf-hits"></div>`;
  }

  function sourcesHtml(l) {
    const rows = l.sources.map((s) => {
      const ic = SRC[s.key] || SRC.tasks;
      const right = s.problem
        ? `<button class="lf-btn small danger" data-act="connect" title="${esc(s.problem)}">Reconnect</button>${sw(`data-src="${esc(s.key)}"`, s.on)}`
        : `${s.count ? `<span class="lf-meta">${esc(ago(s.last))}</span><button class="lf-forget" data-forget-src="${esc(s.key)}" title="Forget what it saw">${G('<path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/>')}</button>` : ''}${sw(`data-src="${esc(s.key)}"`, s.on)}`;
      return row({ icon: ic, title: `${esc(s.label)}${s.sensitive ? '<span class="lf-pill">sealed</span>' : ''}`, sub: esc(s.note), right, cls: s.on ? '' : 'off' });
    }).join('');
    const tips = [];
    if (!l.google) tips.push(`<div class="lf-tip">${G('<circle cx="12" cy="12" r="8.5"/><path d="M12 8v5M12 16h.01"/>')}<span>Connect Google to add your calendar and email.</span><button class="lf-btn small" data-act="connect">Connect</button></div>`);
    if (!l.canSeal) tips.push(`<div class="lf-tip bad">${G('<circle cx="12" cy="12" r="8.5"/><path d="M12 8v5M12 16h.01"/>')}<span>This PC can't protect call notes, so they aren't kept.</span></div>`);
    return group('What your bots can see', rows, '<span class="lf-aside">Stays on this PC</span>') + tips.join('');
  }

  function nudgesHtml(l) {
    const n = l.nudges;
    const bots = S().catalog.bots || [];
    const who = (key) => `<select class="lf-select" data-who="${esc(key)}"><option value="">Best bot</option>${bots.map((b) => `<option value="${esc(b.id)}" ${(n.botFor || {})[key] === b.id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select>`;
    const fb = { helpful: 'Helpful', later: 'Not now', stop: 'Stopped' };
    let body = row({ icon: ROWICON.bell, title: 'Message me first', sub: 'Your bots reach out when something needs you', right: sw('data-nudge="on"', n.on) });
    if (n.on) {
      body += row({ icon: ROWICON.bell, title: 'How often', sub: 'The most in one day', right: `<div class="lf-stepper"><button data-step="-1" aria-label="Fewer">−</button><span>${Number(n.perDay)}</span><button data-step="1" aria-label="More">+</button></div>` });
      body += row({ icon: ROWICON.mobile, title: 'Use my phone when I\'m away', right: sw('data-nudge="phone"', n.phone !== false) });
      body += row({ icon: ROWICON.moon, title: 'Quiet hours', sub: n.quiet.on ? `<span class="lf-times"><input type="time" class="lf-time" data-nudge="from" value="${esc(n.quiet.from)}"> to <input type="time" class="lf-time" data-nudge="to" value="${esc(n.quiet.to)}"></span>` : 'No messages at night', right: sw('data-nudge="quiet"', n.quiet.on) });
      body += n.triggers.map((t) => row({ icon: null, cls: `lf-trig${t.on ? '' : ' off'}`, attr: `title="${esc(t.note)}"`, title: esc(t.label), right: `${t.on ? who(t.key) : ''}${sw(`data-trig="${esc(t.key)}"`, t.on)}` })).join('');
    }
    const recent = n.list.length
      ? `<details class="lf-more"><summary>Recent messages (${n.list.length})</summary>${n.list.slice(0, 12).map((x) => `<div class="lf-li"><b>${esc(botName(x.botId) || 'Codeply')}</b><span>${esc(x.text)}</span><em>${esc(dayTime(x.at))}${x.feedback ? ` · ${esc(fb[x.feedback] || '')}` : ''}</em></div>`).join('')}</details>` : '';
    return group('Reach out to me', body) + recent;
  }

  function callsHtml(l) {
    const c = l.calls || {};
    const st = l.callNow || null;
    const bots = S().catalog.bots || [];
    const seg = `<div class="lf-seg">${[['ask', 'Ask each call'], ['always', 'Always'], ['off', 'Off']].map(([k, label]) => `<button class="${c.listen === k ? 'on' : ''}" data-listen="${k}">${label}</button>`).join('')}</div>`;
    let body = row({ icon: ROWICON.ear, title: 'Help on my calls', sub: 'Notes, tips while you talk, and a polite exit when you mute', attr: 'title="Meet, Zoom, Teams, WhatsApp, Discord, or Phone Link calls on this PC. Speech to text runs here with Whisper; only the text is kept."', right: seg });
    if (c.listen !== 'off') {
      body += `<label class="lf-consent${c.consentAck ? ' ok' : ''}"><input type="checkbox" data-consent ${c.consentAck ? 'checked' : ''}><span><b>I'll tell people an assistant is listening</b><em>Many places require everyone's consent before a call is transcribed.</em></span></label>`;
      body += row({ icon: ROWICON.speaker, title: 'Whisper tips out loud', sub: 'Use headphones', right: sw('data-whisper-voice', c.whisperVoice) });
      body += row({ icon: ROWICON.bot, title: 'Who helps', right: `<select class="lf-select" data-call-bot><option value="">Best bot</option>${bots.map((b) => `<option value="${esc(b.id)}" ${c.botId === b.id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select>` });
    }
    const now = st && st.active
      ? `<div class="lf-banner live"><span class="lf-dot"></span>Listening to a ${esc(st.app || '')} call</div>`
      : c.listen !== 'off' ? `<button class="lf-btn primary wide" data-act="listen-now" ${c.consentAck ? '' : 'disabled'}>${G(ROWICON.ear.i)}${c.consentAck ? 'Listen to a call now' : 'Tick the box above to start'}</button>` : '';
    const cable = l.takeoverReady === false && c.listen !== 'off'
      ? '<div class="lf-tip">' + G('<circle cx="12" cy="12" r="8.5"/><path d="M12 8v5M12 16h.01"/>') + '<span>For a bot to speak in calls, install VB-CABLE (free) and pick "CABLE Output" as the mic in your call app.</span></div>' : '';
    return group('Calls', body) + now + cable;
  }

  function mailHtml(l) {
    const m = l.mail;
    if (!m) return '';
    const pct = Math.min(100, Math.round((m.used.month / Math.max(1, m.limits.month)) * 100));
    // A server problem reads as one plain line; the raw error stays in the tooltip.
    if (m.error && !(m.boxes || []).length) return group('Bot email', row({ icon: ROWICON.mail, title: 'Bot email isn\'t ready yet', sub: 'Its mail server isn\'t set up', attr: `title="${esc(m.error)}"` }));
    const usage = m.error
      ? row({ icon: ROWICON.mail, title: 'Bot email isn\'t reachable', sub: 'Mail waits until it\'s back', attr: `title="${esc(m.error)}"` })
      : row({ icon: ROWICON.mail, title: `${m.used.month} of ${m.limits.month} this month`, sub: `<div class="lf-meter"><span style="width:${pct}%"></span></div>`, right: `<span class="lf-meta">${m.used.day} of ${m.limits.day} today</span>` });
    const boxes = (m.boxes || []).length
      ? m.boxes.map((b) => row({ icon: null, title: esc(b.botName), sub: esc(b.address) })).join('')
      : row({ icon: null, title: 'No addresses yet', sub: 'Give a bot one in Edit bot, Email' });
    return group('Bot email', usage + boxes);
  }

  function autopilotHtml(l) {
    const a = l.autopilot || {};
    const outbox = a.outbox || []; const tasks = a.tasks || []; const auditList = a.audit || [];
    let body = a.paused
      ? row({ icon: ROWICON.robot, title: 'All bots are stopped', sub: 'Nothing runs on its own', right: '<button class="lf-btn primary small" data-act="resume">Resume</button>' })
      : row({ icon: ROWICON.robot, title: 'Bots work on their own', sub: 'They plan, do, check and report back', attr: 'title="Tasks come from you, calls, email, Slack or chat. Deleting things, money, and anything someone else asked for always wait for you."', right: `<button class="lf-btn danger small" data-act="stop-all">${ICON.stop}Stop all</button>` });
    body += outbox.map((o) => row({ icon: null, title: `${esc(botName(o.botId))}: ${esc(o.title)}`, sub: `Goes ${esc(dayTime(o.dueAt))}`, right: `<button class="lf-btn small" data-outbox-now="${esc(o.id)}">Send now</button><button class="lf-btn small" data-outbox-cancel="${esc(o.id)}">Cancel</button>` })).join('');
    body += tasks.map((t) => row({ icon: null, title: `${esc(botName(t.botId) || 'A bot')}: ${esc(t.text)}`, sub: t.data && t.data.report ? esc(t.data.report) : '', right: `<span class="lf-status s-${esc(t.status)}">${esc(t.status.replace('_', ' '))}</span>${['queued', 'running', 'needs_you'].includes(t.status) ? `<button class="lf-btn small" data-task-cancel="${esc(t.id)}">Cancel</button>` : ''}` })).join('');
    const audit = auditList.length
      ? `<details class="lf-more"><summary>Everything they did alone (${auditList.length})</summary>${auditList.map((x) => `<div class="lf-li"><b>${esc(botName(x.botId) || 'Codeply')}</b><span>${esc(x.title)}${x.result ? ` · ${esc(x.result)}` : ''}</span><em>${esc(dayTime(x.at))}${x.verdict ? ` · ${esc(x.verdict)}` : ''}</em></div>`).join('')}</details>` : '';
    return group('Autopilot', body) + audit;
  }

  // Off: what Life does, in three lines, and one button.
  function introHtml() {
    const b = (ic, t, s) => `<div class="lf-benefit">${tile(ic)}<div><b>${t}</b><span>${s}</span></div></div>`;
    return `<div class="lf-intro">
      <div class="lf-intro-mark">${G('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>')}</div>
      <h1>Let your bots see your day</h1>
      <p>So they can help before you ask.</p>
      <div class="lf-benefits">
        ${b(ROWICON.bell, 'A nudge at the right time', '"Got your keys?" before you head out')}
        ${b(SRC.gmail, 'Know who is waiting on you', 'Emails you haven\'t answered yet')}
        ${b(SRC.calls, 'Help on your calls', 'Notes and tips while you talk')}
      </div>
      <button class="lf-btn primary big" data-act="turn-on">Turn on Life</button>
      <div class="lf-private">${G('<rect x="5" y="10.5" width="14" height="9.5" rx="2.5"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>')}Stays on this PC. You choose what each bot sees.</div>
    </div>`;
  }

  function paint() {
    const view = $('#view');
    if (!view || !open) return;
    const l = life;
    if (!l || l.error && !l.sources) {
      view.innerHTML = `<div class="lf"><div class="lf-head"><h1>Life</h1></div><div class="lf-tip bad">${G('<circle cx="12" cy="12" r="8.5"/><path d="M12 8v5M12 16h.01"/>')}<span>${esc((l && l.error) || 'Life did not load.')}</span></div></div>`;
      return;
    }
    const scroll = view.querySelector('.lf') ? view.querySelector('.lf').scrollTop : 0;
    view.innerHTML = l.on
      ? `<div class="lf">
          <div class="lf-head"><div><h1>Life</h1><p>Your bots see your day, so they can help before you ask.</p></div>
            <label class="lf-onoff"><span>On</span>${sw('data-life-on', true)}</label></div>
          ${todayHtml(l.now, l)}${sourcesHtml(l)}${nudgesHtml(l)}${callsHtml(l)}${mailHtml(l)}${autopilotHtml(l)}
          <div class="lf-foot"><button class="lf-btn ghost danger" data-act="clear">Forget everything</button><span>Deletes what Life kept on this PC.</span></div>
        </div>`
      : `<div class="lf">${introHtml()}</div>`;
    if (view.querySelector('.lf')) view.querySelector('.lf').scrollTop = scroll;
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
      if (!el.dataset.sure) { el.dataset.sure = '1'; el.textContent = 'Click again to delete it all'; return; }
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
    on('[data-step]', 'click', (el) => set({ nudges: { perDay: Math.max(0, Math.min(30, Number(life.nudges.perDay) + Number(el.dataset.step))) } }));
    on('[data-act="connect"]', 'click', () => api.openConnect());
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
          ? hits.slice(0, 12).map((x) => `<div class="lf-hit"><div><b>${esc(x.title)}</b><span>${esc(x.source)} · ${esc(dayTime(x.at))}${x.people && x.people.length ? ` · ${esc(x.people.slice(0, 2).join(', '))}` : ''}</span></div><button class="lf-forget" data-forget-item="${esc(x.id)}" title="Forget this">${ICON.x}</button></div>`).join('')
          : '<div class="lf-none">Nothing found.</div>';
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
