// Settings, Life and memory (window.CrewLifeMem): the Memory, What bots can
// see, Reaching you, Calls, Teamwork and Privacy pages inside Crew's Settings.
//
//   Memory          what the bots know (brain-desktop.js): search, tell it
//                   something, Keep / Forget on unsure ones, correct, per
//                   project, lessons from the team, what changed
//   What bots see   Life on or off, the mic and the screen, every source,
//                   and a search over what they saw (life-desktop.js)
//   Reaching you    nudges: how often, quiet hours, phone, topics, who says it
//   Calls           the call helper, the consent tick, listen now
//   Teamwork        who handles what, handoffs, the autopilot, bot email
//   Privacy         who sees calls and health, forget what the bots saw
//
// settings.js draws the page frame and calls html(id) then wire(id, body).
// Everything comes from the main process through window.crew.life* and
// window.crew.brain*; this file only draws and sends the user's choices back.
// Live updates arrive through CrewLife.onState and CrewBrain.onState, which
// this file wraps so the old pages keep working too.
(() => {
  const api = window.crew;
  const UI = window.CrewUI;
  const S = () => window.CrewState;
  const esc = (s) => UI.esc(s);
  const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let life = null;
  let brain = null;
  let body = null; // the mounted .set-body
  let page = '';
  let pending = false; // a live update came while a menu or dialog was open
  const ui = { filter: '', adding: false, draft: { text: '', kind: 'preference', project: '' }, editing: '', editText: '', open: new Set(), find: '', hits: null };

  // ─── Words ──────────────────────────────────────────────────────────────
  const G = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  const I = {
    brain: '<path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 1V6a2 2 0 0 0-3-2Z"/><path d="M15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 1"/>',
    eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>',
    calendar: '<rect x="4" y="5" width="16" height="15" rx="3"/><path d="M4 10h16M9 3v4M15 3v4"/>',
    mail: '<rect x="3.5" y="6" width="17" height="12.5" rx="2.5"/><path d="m4.5 7.5 7.5 6 7.5-6"/>',
    phone: '<path d="M6.5 4.5h3l1.5 4-2 1.3a10 10 0 0 0 5.2 5.2l1.3-2 4 1.5v3a1.5 1.5 0 0 1-1.6 1.5A15 15 0 0 1 5 6.1a1.5 1.5 0 0 1 1.5-1.6z"/>',
    folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.2h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
    screen: '<rect x="3.5" y="4.5" width="17" height="11.5" rx="2"/><path d="M8.5 20h7M12 16v4"/>',
    star: '<path d="M12 4.5 13.8 10l5.7.2-4.5 3.4 1.6 5.4L12 15.8 7.4 19l1.6-5.4L4.5 10.2l5.7-.2z"/>',
    team: '<circle cx="9" cy="9" r="3"/><circle cx="16.5" cy="10" r="2.5"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0M14 19a4.5 4.5 0 0 1 7 0"/>',
    at: '<circle cx="12" cy="12" r="3.5"/><path d="M15.5 12v1.5a2.5 2.5 0 0 0 5 0V12a8.5 8.5 0 1 0-3.4 6.8"/>',
    hash: '<path d="M9.5 4v16M14.5 4v16M4 9.5h16M4 14.5h16"/>',
    tasks: '<rect x="4" y="4" width="16" height="16" rx="3.5"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
    heart: '<path d="M12 19.5s-7-4.3-7-9.5a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.2-7 9.5-7 9.5z"/>',
    mic: '<rect x="9" y="3.5" width="6" height="11" rx="3"/><path d="M6 11.5a6 6 0 0 0 12 0M12 17.5V21"/>',
    text: '<path d="M5 6h14M5 10h14M5 14h9M5 18h6"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    lock: '<rect x="5" y="10.5" width="14" height="9.5" rx="2.5"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
    shield: '<path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6Z"/>',
    alert: '<circle cx="12" cy="12" r="8.5"/><path d="M12 8v5M12 16h.01"/>',
    hand: '<path d="M4 12h12M12 7l5 5-5 5"/><path d="M20 5v14"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    edit: '<path d="M5 19h3.5L18 9.5 14.5 6 5 15.5z"/><path d="m13 7.5 3.5 3.5"/>',
    bin: '<path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/>',
    chevDown: '<path d="M6 9l6 6 6-6"/>',
    chevRight: '<path d="m9 6 6 6-6 6"/>',
    minus: '<path d="M6 12h12"/>',
    plus: '<path d="M12 6v12M6 12h12"/>',
  };

  // What a memory is, in the user's words (brain.js KINDS are written for the model).
  const KIND = { preference: 'Preference', fact: 'Fact', routine: 'Routine', style: 'How you like to work', decision: 'Decision', idea: 'Idea', requirement: 'Requirement', todo: 'To-do', context: 'For now', lesson: 'Lesson' };
  const KIND_ORDER = ['preference', 'fact', 'routine', 'style', 'decision', 'idea', 'requirement', 'todo', 'context'];
  const PROJECT_KINDS = ['decision', 'idea', 'requirement', 'todo'];
  const kindLabel = (k) => KIND[k] || ((brain && brain.kinds) || {})[k] || k;
  const CHANGE = { added: 'Learned', confirmed: 'Confirmed', reinforced: 'Heard again', replaced: 'Replaced', challenged: 'Heard different', kept: 'Kept', ignored: 'Ignored', forgotten: 'Forgot', corrected: 'Corrected' };
  const PRODUCT = { craft: 'Craft', crew: 'Crew', orbit: 'Orbit', phone: 'your phone', drop: 'the drop' };
  const DOMAIN = { calendar: 'Calendar', email: 'Email', reminders: 'Reminders', calls: 'Calls', texts: 'Texts', research: 'Research', code: 'Code', social: 'Social', health: 'Health', money: 'Money' };
  const HANDOFF = { open: 'Waiting', queued: 'Working', done: 'Done', needs_user: 'Needs you', failed: 'Could not finish', cancelled: 'Cancelled', unrouted: 'Nobody for it' };
  const TASK = { queued: 'Waiting to start', running: 'Working', verifying: 'Checking its work', needs_you: 'Needs you', done: 'Done', failed: 'Could not finish', cancelled: 'Cancelled' };
  const HEARD = { todo: 'To-do', decision: 'Decided', person: 'Person', idea: 'Idea', info: 'Note' };

  // Each source in one short sentence, with its icon; life.js notes are longer.
  const SRC = {
    calendar: { i: I.calendar, d: 'Your events, who is in them and where.', google: true },
    gmail: { i: I.mail, d: 'Who wrote, and who is still waiting on your reply.', google: true },
    calls: { i: I.phone, d: 'Short summaries of your calls.' },
    projects: { i: I.folder, d: 'What you are building and when you last pushed.' },
    activity: { i: I.screen, d: 'Which app is in front, skipping private windows.' },
    orbit: { i: I.star, d: 'What you asked them.' },
    plans: { i: I.team, d: 'Plans your bots heard about in chats, calls and email.' },
    botmail: { i: I.at, d: 'Mail to and from your bots\' own addresses.' },
    slack: { i: I.hash, d: 'Direct messages and mentions.' },
    tasks: { i: I.tasks, d: 'Work your bots took on by themselves.' },
    health: { i: I.heart, d: 'Steps, sleep and workouts from your phone or watch.' },
  };
  const ALWAYS = ['heard', 'screen'];
  const TRIG = {
    leaving: 'Keys, wallet and when to leave.',
    meeting: 'Who it is with and what you last talked about.',
    email: 'An important email unanswered for a day.',
    deadline: 'A deadline soon and no recent work on it.',
    watched: 'How something you watched went, a few hours later.',
    brief: 'Your day in a few lines, once a morning.',
    activity: 'A gentle check-in if your steps drop for days.',
  };
  const firstSentence = (s) => { const t = String(s || '').trim(); const m = t.match(/^.*?[.!?](\s|$)/); return m ? m[0].trim() : t; };
  // Google answers 403 accessNotConfigured when the API is off in the app's Cloud project: no sign-in fixes that.
  const apiOff = (p) => /accessNotConfigured|has not been used|is disabled/i.test(String(p || ''));

  const ago = (t) => {
    if (!t) return '';
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} h ago`;
    const d = Math.round(h / 24);
    return d === 1 ? 'yesterday' : `${d} days ago`;
  };
  const until = (t) => {
    const m = Math.round((t - Date.now()) / 60000);
    if (m <= 0) return 'ending now';
    if (m < 60) return `for ${m} more min`;
    const h = Math.round(m / 60);
    return h < 48 ? `for ${h} more h` : `for ${Math.round(h / 24)} more days`;
  };
  const clock = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const dayTime = (t) => {
    const d = new Date(t);
    if (d.toDateString() === new Date().toDateString()) return clock(t);
    if (d.toDateString() === new Date(Date.now() + 86400000).toDateString()) return `tomorrow ${clock(t)}`;
    return d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  };
  const listWords = (a) => (a.length <= 1 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);
  const bots = () => (S().catalog && S().catalog.bots) || [];
  const botName = (id) => (UI.bot(id) || {}).name || '';
  // Where a memory came from: "you", or "Orion in Crew".
  const where = (m) => {
    const s = (m.sources || [])[(m.sources || []).length - 1];
    if (!s) return '';
    if (s.product === 'you') return 'you';
    const p = PRODUCT[s.product] || s.product || '';
    return s.botName ? `${s.botName}${p ? ` in ${p}` : ''}` : p;
  };

  // brain.js labels a source "Wren in crew": the product name as the user knows it.
  const said = (t) => String(t || '').replace(/ in (craft|crew|orbit|phone|drop)$/i, (m, p) => ` in ${PRODUCT[p.toLowerCase()]}`);

  // ─── Building blocks (the .set-* vocabulary from crew.css) ─────────────
  const A = (act, id) => `data-act="${act}"${id != null ? ` data-id="${esc(id)}"` : ''}`;
  const row = ({ title, desc = '', ctl = '', lead = '', cls = '', attrs = '' }) => `<div class="set-row${lead ? ' lm-has-lead' : ''}${cls ? ` ${cls}` : ''}" ${attrs}>${lead}<div class="set-row-text"><div class="set-row-title">${title}</div>${desc ? `<div class="set-row-desc">${desc}</div>` : ''}</div>${ctl ? `<div class="set-row-ctl">${ctl}</div>` : ''}</div>`;
  let hid = 0;
  const section = (title, rows, { sub = '', aside = '' } = {}) => {
    const h = `lm-h-${++hid}`;
    return `<section class="set-section"${title ? ` aria-labelledby="${h}"` : ''}>${title || aside ? `<div class="lm-head">${title ? `<h2 class="set-h2" id="${h}">${title}</h2>` : '<span></span>'}${aside}</div>` : ''}${sub ? `<p class="set-sub">${sub}</p>` : ''}<div class="set-card">${rows.join('')}</div></section>`;
  };
  const sw = (act, id, on, label, disabled = false) => `<label class="set-switch"><input type="checkbox" role="switch" ${A(act, id)} aria-label="${esc(label)}" ${on ? 'checked' : ''} ${disabled ? 'disabled' : ''}><span></span></label>`;
  const pill = (act, id, label, aria, extra = '') => `<button type="button" class="set-pill" ${A(act, id)} aria-haspopup="menu" aria-expanded="false" aria-label="${esc(aria)}">${extra}<span>${esc(label)}</span>${G(I.chevDown)}</button>`;
  const btn = (act, id, label, kind = '', more = '') => `<button type="button" class="set-btn${kind ? ` ${kind}` : ''}" ${A(act, id)} ${more}>${label}</button>`;
  const iconBtn = (act, id, icon, label, cls = '') => `<button type="button" class="lm-icon-btn${cls ? ` ${cls}` : ''}" ${A(act, id)} aria-label="${esc(label)}" title="${esc(label)}">${G(icon)}</button>`;
  const lead = (icon) => `<span class="lm-lead" aria-hidden="true">${G(icon)}</span>`;
  const avatar = (b, size) => { try { return UI.av(b, size, { still: true }); } catch { return ''; } };
  const leadAv = (b) => `<span class="lm-lead lm-av" aria-hidden="true">${avatar(b, 30)}</span>`;
  const fold = (key, title, desc) => `<button type="button" class="set-row lm-more" ${A('fold', key)} aria-expanded="${ui.open.has(key)}"><div class="set-row-text"><div class="set-row-title">${title}</div>${desc ? `<div class="set-row-desc">${desc}</div>` : ''}</div>${G(I.chevRight).replace('<svg', '<svg class="lm-chev"')}</button>`;
  const folded = (key, rows) => (ui.open.has(key) ? `<div class="lm-fold">${rows.join('')}</div>` : '');
  const danger = (note, act, label) => `<div class="lm-danger"><span>${note}</span><button type="button" class="lm-link lm-red" ${A(act)}>${label}</button></div>`;
  const note = (text) => `<p class="set-sub lm-note">${text}</p>`;
  const badge = (t) => `<span class="lm-badge">${esc(t)}</span>`;
  const live = (t) => `<span class="lm-live">${t}</span>`;
  const problem = (text) => section('', [row({ lead: lead(I.alert), title: 'This did not load', desc: esc(text) })]);
  const botPill = (act, id, cur, aria) => { const b = cur && UI.bot(cur); return pill(act, id, b ? b.name : 'Best bot', `${aria}: ${b ? b.name : 'Best bot'}`, b ? `<span class="lm-pill-av" aria-hidden="true">${avatar(b, 18)}</span>` : ''); };

  // ─── Memory ─────────────────────────────────────────────────────────────
  const mems = () => (brain && brain.memories) || [];
  const memById = (id) => mems().find((m) => m.id === id);
  const needsLook = (m) => m.review || (m.challenger && m.challenger.count >= 1);
  const projName = (k) => (((brain && brain.projects) || []).find((p) => p.key === k) || {}).name || k;

  function memRow(m) {
    if (ui.editing === m.id) {
      return `<div class="set-row lm-edit-row" data-row="${esc(m.id)}"><div class="set-row-text"><input class="lm-field" ${A('edit-text', m.id)} value="${esc(ui.editText)}" maxlength="280" aria-label="Correct this memory"></div><div class="set-row-ctl">${btn('edit-cancel', m.id, 'Cancel', 'lm-small')}${btn('edit-save', m.id, 'Save', 'lm-small primary')}</div></div>`;
    }
    const unsure = m.status === 'tentative';
    const bits = m.kind === 'context'
      ? [m.expiresAt ? until(m.expiresAt) : '', m.locked ? 'Set by you' : where(m) ? `from ${where(m)}` : '']
      : [m.kind === 'lesson' ? '' : kindLabel(m.kind), m.locked ? 'Set by you' : where(m) ? `from ${where(m)}` : '', ago(m.updatedAt)];
    const meta = `${unsure ? badge('Not sure yet') : ''}${esc(bits.filter(Boolean).join(' · '))}`;
    const ctl = unsure
      ? `${btn('keep', m.id, 'Keep', 'lm-small', `aria-label="Keep: ${esc(m.text)}"`)}${btn('forget', m.id, 'Forget', 'lm-small', `aria-label="Forget: ${esc(m.text)}"`)}`
      : `${iconBtn('edit', m.id, I.edit, 'Correct it')}${iconBtn('forget', m.id, I.x, 'Forget it', 'lm-red-hover')}`;
    return `<div class="set-row" data-row="${esc(m.id)}"><div class="set-row-text"><div class="lm-mem">${esc(m.text)}</div><div class="lm-meta">${meta}</div></div><div class="set-row-ctl">${ctl}</div></div>`;
  }
  function reviewRow(m) {
    const heard = m.challenger;
    const prev = (m.history || [])[(m.history || []).length - 1];
    const meta = heard
      ? `But ${said(heard.from) || 'a bot'} heard: "${heard.text}"${heard.count > 1 ? ` (${heard.count} times)` : ''}`
      : prev ? `Changed from "${prev.text}" because it came up again.` : 'Changed because it came up again.';
    const ctl = heard
      ? `${btn('review-keep', m.id, 'Keep', 'lm-small')}${btn('review-switch', m.id, 'Switch', 'lm-small')}`
      : `${btn('keep', m.id, 'That\'s right', 'lm-small')}${prev ? btn('review-undo', m.id, 'Undo', 'lm-small') : ''}`;
    return `<div class="set-row" data-row="${esc(m.id)}"><div class="set-row-text"><div class="lm-mem">${esc(m.text)}</div><div class="lm-meta">${esc(meta)}</div></div><div class="set-row-ctl">${ctl}</div></div>`;
  }

  function memoryPage() {
    const b = brain;
    if (!b || (b.error && !b.memories)) return problem((b && b.error) || 'Your memories did not load.');
    const cant = !b.on && b.usable === false;
    const out = [section('', [row({ title: 'Remember things', desc: cant ? 'This PC cannot keep memories, so this stays off.' : 'Bots learn from your chats in Craft, Crew, Orbit and your phone.', ctl: sw('mem-on', null, b.on, 'Remember things', cant) })])];
    if (!b.on) { out.push(note('Off. Nothing new is learned, and no bot sees what was learned before.')); return out.join(''); }

    const d = ui.draft;
    const projs = b.projects || [];
    const about = d.project ? projName(d.project) : 'About you';
    const add = ui.adding ? `<form class="set-card lm-add" ${A('add-form')}>
        <input class="lm-field" ${A('add-text')} value="${esc(d.text)}" placeholder="For example: I prefer short replies" maxlength="280" aria-label="Something to remember" autocomplete="off">
        <div class="lm-add-bar">${pill('kind-menu', null, kindLabel(d.kind), `Kind: ${kindLabel(d.kind)}`)}${PROJECT_KINDS.includes(d.kind) && projs.length ? pill('about-menu', null, about, `What it is about: ${about}`) : ''}<span class="lm-grow"></span>${btn('add-cancel', null, 'Cancel', 'lm-small')}<button type="submit" class="set-btn lm-small primary" ${A('add-submit')} ${d.text.trim() ? '' : 'disabled'}>Remember</button></div>
      </form>` : '';
    out.push(`<div><div class="lm-tools"><label class="lm-search">${G(I.search)}<span class="lm-vh">Find something it knows</span><input type="search" ${A('filter')} value="${esc(ui.filter)}" placeholder="Find something it knows" autocomplete="off"></label>${btn('add-open', null, `${G(I.plus)}Tell it something`, '', `aria-expanded="${ui.adding}"`)}</div>${add}</div>`);

    const f = ui.filter.trim().toLowerCase();
    const hit = (m) => !f || `${m.text} ${kindLabel(m.kind)} ${where(m)} ${m.project ? projName(m.project) : ''} ${m.challenger ? m.challenger.text : ''}`.toLowerCase().includes(f);
    const list = mems().filter(hit);
    let shown = 0;
    const review = list.filter(needsLook);
    const later = new Set(review.map((m) => m.id));
    if (review.length) {
      shown += review.length;
      out.push(section('Needs a look', review.map(reviewRow), { aside: '<span class="lm-aside">Your bots heard two different things</span>' }));
    }
    const me = list.filter((m) => m.scope === 'me' && m.kind !== 'context' && !later.has(m.id));
    shown += me.length;
    if (me.length || !f) out.push(section('About you', me.length ? me.map(memRow) : ['<div class="lm-empty">Nothing yet. Your bots learn as you talk to them.</div>']));
    const now = list.filter((m) => m.kind === 'context' && !later.has(m.id));
    shown += now.length;
    if (now.length) out.push(section('Right now', now.map(memRow), { aside: '<span class="lm-aside">Runs out by itself</span>' }));
    const byProject = new Map();
    for (const m of list) if (m.project && m.kind !== 'context' && !later.has(m.id)) { if (!byProject.has(m.project)) byProject.set(m.project, []); byProject.get(m.project).push(m); }
    for (const [key, rows] of byProject) {
      shown += rows.length;
      out.push(section(esc(projName(key)), rows.map(memRow), { aside: `<button type="button" class="lm-link lm-red" ${A('forget-project', key)}>Forget this project</button>` }));
    }
    const lessons = list.filter((m) => m.scope === 'team' && !later.has(m.id));
    shown += lessons.length;
    if (lessons.length) {
      if (f) ui.open.add('lessons');
      const unsure = lessons.filter((m) => m.status === 'tentative').length;
      out.push(section('From your bots', [
        fold('lessons', `${lessons.length} ${lessons.length === 1 ? 'thing' : 'things'} your bots learned`, `A bot sees a lesson only when it fits.${unsure ? ` ${unsure} not sure yet.` : ''}`),
        folded('lessons', lessons.map(memRow)),
      ]));
    }
    if (f && !shown) out.push(`<div class="set-card"><div class="lm-empty">Nothing it knows matches "${esc(ui.filter.trim())}".</div></div>`);
    const ch = b.changes || [];
    if (!f && ch.length) {
      out.push(section('', [
        fold('changes', 'What changed', `${ch.length} recent ${ch.length === 1 ? 'change' : 'changes'}, newest first.`),
        folded('changes', ch.map((c) => `<div class="set-row lm-li"><span class="lm-what">${esc(CHANGE[c.action] || c.action)}</span><span class="lm-txt">${esc(String(c.text || '').replace(/ -> /g, ', now '))}${c.source ? ` <span class="lm-when">from ${esc(said(c.source))}</span>` : ''}</span><span class="lm-when">${esc(ago(c.at))}</span></div>`)),
      ]));
    }
    out.push(danger('Stays on this PC. Jokes, sarcasm and secrets are never kept.', 'forget-all', 'Forget everything'));
    return out.join('');
  }

  // ─── What bots can see ──────────────────────────────────────────────────
  const src = (k) => ((life && life.sources) || []).find((s) => s.key === k) || {};
  function seePage() {
    const l = life;
    if (!l || (l.error && !l.sources)) return problem((l && l.error) || 'This did not load.');
    const out = [section('', [row({ title: 'Let bots see your day', desc: 'So they can help before you ask.', ctl: sw('life-on', null, l.on, 'Let bots see your day') })])];
    if (!l.on) { out.push(note('Off. Your bots only know what you tell them in chat.')); return out.join(''); }
    if (l.error) out.push(section('', [row({ lead: lead(I.alert), title: 'Something is not working', desc: esc(firstSentence(l.error)) })]));

    const heard = src('heard'); const screen = src('screen');
    const ls = l.listen || {};
    const saved = l.heardToday || [];
    const heardDesc = !heard.on ? 'Keeps the important bits as text, never the audio.'
      : ls.paused === 'call' ? 'Paused while the call helper listens.'
        : ls.error ? esc(firstSentence(ls.error))
          : ls.mic ? `${live(ls.thinking ? 'Saving what matters' : 'Listening')}${saved.length ? `, ${saved.length} saved today.` : '.'}`
            : 'Starting the mic.';
    const screenDesc = !screen.on ? 'Reads the words in the window in front, and keeps no images.'
      : l.screen ? `${live(`Reading ${esc(l.screen.app || 'your screen')}`)}.` : 'Reads when you use your PC.';
    const bg = [
      row({ lead: lead(I.mic), title: 'Listen in the background', desc: heardDesc, ctl: sw('heard', null, heard.on, 'Listen in the background') }),
      row({ lead: lead(I.text), title: 'Read my screen', desc: screenDesc, ctl: sw('screen', null, screen.on, 'Read my screen') }),
    ];
    if (saved.length) {
      bg.push(fold('heard', 'Saved today', `${saved.length} important ${saved.length === 1 ? 'bit' : 'bits'} it heard.`));
      bg.push(folded('heard', saved.map((x) => `<div class="set-row" data-row="${esc(x.id)}"><div class="set-row-text"><div class="lm-mem">${esc(x.title)}</div><div class="lm-meta">${esc(`${HEARD[x.kind] || 'Note'} · ${clock(x.at)}`)}</div></div><div class="set-row-ctl">${iconBtn('forget-item', x.id, I.x, 'Forget this', 'lm-red-hover')}</div></div>`)));
    }
    out.push(section('In the background', bg));

    const rows = [];
    if (!l.google) rows.push(row({ lead: lead(I.link), title: 'Connect Google', desc: 'One sign-in adds your calendar and email.', ctl: btn('connect', null, 'Connect') }));
    for (const s of (l.sources || []).filter((x) => !ALWAYS.includes(x.key))) {
      const info = SRC[s.key] || { i: I.tasks, d: firstSentence(s.note) };
      const noGoogle = info.google && !l.google;
      let ctl;
      if (s.problem && apiOff(s.problem)) ctl = `<span class="lm-when" title="${esc(s.problem)}">Not available right now</span>`;
      else if (s.problem && !noGoogle) ctl = btn('connect', s.key, 'Reconnect', 'lm-small', `title="${esc(s.problem)}" aria-label="Reconnect ${esc(s.label)}"`);
      else ctl = `<span class="lm-when">${esc(noGoogle ? 'Not connected' : !s.on ? 'Off' : s.last ? `Synced ${ago(s.last)}` : 'Nothing yet')}</span>`;
      if (s.count && !noGoogle) ctl += iconBtn('forget-source', s.key, I.bin, `Forget what ${s.label} showed`, 'lm-red-hover');
      ctl += sw('src', s.key, s.on && !noGoogle, s.label, noGoogle);
      rows.push(row({ lead: lead(info.i), title: `${esc(s.label)}${s.sensitive ? badge('Private') : ''}`, desc: esc(info.d), cls: s.on && !noGoogle ? '' : 'lm-off', ctl }));
    }
    if (!l.canSeal) rows.push(row({ lead: lead(I.lock), title: 'Call notes are not kept', desc: 'This PC cannot lock them away, so they are skipped.', cls: 'lm-off' }));
    out.push(section('Sources', rows, { sub: 'Everything stays on this PC. Turn off anything you do not want used.' }));

    const hits = ui.hits;
    const found = !ui.find.trim() ? '' : hits == null ? '<div class="lm-empty">Looking...</div>'
      : !hits.length ? `<div class="lm-empty">Nothing they saw matches "${esc(ui.find.trim())}".</div>`
        : hits.slice(0, 12).map((x) => `<div class="set-row" data-row="${esc(x.id)}"><div class="set-row-text"><div class="lm-mem">${esc(x.title)}</div><div class="lm-meta">${esc([x.source, dayTime(x.at), (x.people || []).slice(0, 2).join(', ')].filter(Boolean).join(' · '))}</div></div><div class="set-row-ctl">${iconBtn('forget-hit', x.id, I.x, 'Forget this', 'lm-red-hover')}</div></div>`).join('');
    out.push(`<section class="set-section" aria-labelledby="lm-find-h"><div class="lm-head"><h2 class="set-h2" id="lm-find-h">Find something they saw</h2></div><label class="lm-search">${G(I.search)}<span class="lm-vh">Find something they saw</span><input type="search" ${A('find')} value="${esc(ui.find)}" placeholder="A name, a place or a word" autocomplete="off"></label>${found ? `<div class="set-card lm-results">${found}</div>` : ''}</section>`);
    return out.join('');
  }

  // ─── Reaching you ───────────────────────────────────────────────────────
  function reachPage() {
    const l = life;
    if (!l || !l.nudges) return problem((l && l.error) || 'This did not load.');
    const n = l.nudges;
    const out = [];
    if (!l.on) out.push(section('', [row({ lead: lead(I.eye), title: 'Your bots cannot see your day', desc: 'They need it to know when to reach you.', ctl: btn('go', 'see', 'Turn it on') })]));
    out.push(section('', [row({ title: 'Message me first', desc: 'Your bots reach out when something needs you.', ctl: sw('nudge-on', null, n.on, 'Message me first') })]));
    if (!n.on) { out.push(note('Off. Your bots only answer when you write to them.')); return out.join(''); }
    const per = Math.max(1, Number(n.perDay) || 1);
    const q = n.quiet || {};
    out.push(section('', [
      row({ title: 'How often', desc: `At most ${per} ${per === 1 ? 'message' : 'messages'} a day.`, ctl: `<div class="lm-stepper" role="group" aria-label="Messages a day"><button type="button" ${A('step', '-1')} aria-label="Fewer" ${per <= 1 ? 'disabled' : ''}>${G(I.minus)}</button><output aria-live="polite">${per}</output><button type="button" ${A('step', '1')} aria-label="More" ${per >= 30 ? 'disabled' : ''}>${G(I.plus)}</button></div>` }),
      row({ title: 'Quiet hours', desc: q.on ? 'Nothing comes in between these times.' : 'No quiet time set.', ctl: `${q.on ? `<span class="lm-times"><input type="time" class="lm-time" ${A('quiet-from')} value="${esc(q.from)}" aria-label="Quiet from">to<input type="time" class="lm-time" ${A('quiet-to')} value="${esc(q.to)}" aria-label="Quiet until"></span>` : ''}${sw('quiet-on', null, q.on, 'Quiet hours')}` }),
      row({ title: 'Use my phone when I am away', desc: 'Messages go to the Codeply app when this PC is idle.', ctl: sw('phone', null, n.phone !== false, 'Use my phone when I am away') }),
    ]));
    out.push(section('Message me about', (n.triggers || []).map((t) => row({
      title: esc(t.label), desc: esc(TRIG[t.key] || firstSentence(t.note)), cls: t.on ? '' : 'lm-off',
      ctl: `${t.on ? botPill('who-menu', t.key, (n.botFor || {})[t.key], 'Who says it') : ''}${sw('trigger', t.key, t.on, t.label)}`,
    }))));
    const recent = n.list || [];
    if (recent.length) {
      const fb = { helpful: 'Helpful', later: 'Not now', stop: 'Stopped' };
      out.push(section('', [
        fold('recent', 'Recent messages', `${recent.length} in the last week.`),
        folded('recent', recent.slice(0, 20).map((x) => { const b = UI.bot(x.botId); return row({ lead: b ? leadAv(b) : lead(I.alert), title: `<span class="lm-mem">${esc(x.text)}</span>`, desc: esc([b ? b.name : 'Codeply', dayTime(x.at), fb[x.feedback] || ''].filter(Boolean).join(' · ')) }); })),
      ]));
    }
    return out.join('');
  }

  // ─── Calls ──────────────────────────────────────────────────────────────
  const MODES = [['ask', 'Ask each call'], ['always', 'Always'], ['off', 'Off']];
  function callsPage() {
    const l = life;
    if (!l || !l.calls) return problem((l && l.error) || 'This did not load.');
    const c = l.calls;
    const mode = MODES.some(([k]) => k === c.listen) ? c.listen : 'ask';
    const seg = `<div class="lm-seg" role="radiogroup" aria-label="Help on my calls">${MODES.map(([k, label]) => `<button type="button" role="radio" ${A('mode', k)} aria-checked="${mode === k}" tabindex="${mode === k ? 0 : -1}">${label}</button>`).join('')}</div>`;
    const out = [section('', [row({ title: 'Help on my calls', desc: 'Notes, tips while you talk, and a polite way out when you mute.', ctl: seg })])];
    if (mode === 'off') { out.push(note('Off. No bot listens to your calls.')); return out.join(''); }
    out.push(section('', [
      `<label class="set-row lm-check-row"><input type="checkbox" ${A('consent')} ${c.consentAck ? 'checked' : ''}><div class="set-row-text"><div class="set-row-title">I will tell people an assistant is listening</div><div class="set-row-desc">Many places require everyone's consent before a call is written down.</div></div></label>`,
      row({ title: 'Whisper tips out loud', desc: 'Use headphones, so only you hear them.', ctl: sw('whisper', null, !!c.whisperVoice, 'Whisper tips out loud') }),
      row({ title: 'Who helps', desc: 'The bot that listens and gives tips.', ctl: botPill('call-who', null, c.botId, 'Who helps') }),
    ]));
    const now = l.callNow || {};
    const app = now.app && now.app !== 'Call' ? `your ${esc(now.app)} call` : 'your call';
    out.push(section('', [now.active
      ? row({ title: live(`Listening to ${app}`), desc: 'Notes and tips show while you talk.', ctl: `${btn('call-show', null, 'Show')}${btn('call-stop', null, 'Stop')}` })
      : row({ title: 'Listen to a call now', desc: c.consentAck ? 'For a call this PC did not spot, like a phone on speaker.' : 'Tick the box above first.', ctl: btn('listen-now', null, 'Start listening', '', c.consentAck ? '' : 'disabled') })]));
    if (l.takeoverReady === false) out.push(section('', [row({ lead: lead(I.alert), title: 'Let a bot speak on calls', desc: 'Install the free VB-CABLE and pick CABLE Output as the mic in your call app.', cls: 'lm-off' })]));
    return out.join('');
  }

  // ─── Teamwork ───────────────────────────────────────────────────────────
  function teamPage() {
    const out = [];
    const b = brain;
    const team = (b && b.on && b.bots) || [];
    let rows;
    if (!b || !b.on) rows = [row({ lead: lead(I.brain), title: 'Turn on Remember things first', desc: 'Who handles what is kept with your memories.', ctl: btn('go', 'memory', 'Open Memory') })];
    else if (!team.length) rows = [row({ title: 'No bots yet', desc: 'Make one from the home screen.', cls: 'lm-off' })];
    else {
      rows = team.map((x) => {
        const set = (x.handles || []).length > 0;
        const jobs = (set ? x.handles : x.inferred || []).map((d) => DOMAIN[d] || d);
        const desc = `${!jobs.length ? 'No jobs yet, pick some with Edit.' : `${listWords(jobs)}. ${set ? 'Set by you.' : 'Guessed from its job.'}`}${x.autonomy === 'none' ? ' It only suggests.' : ''}`;
        const cat = UI.bot(x.id);
        return row({ lead: cat ? leadAv(cat) : lead(I.team), title: esc(x.name), desc: esc(desc), ctl: pill('handles', x.id, 'Edit', `Jobs ${x.name} takes`) });
      });
      const taken = new Set(team.flatMap((x) => ((x.handles || []).length ? x.handles : x.inferred || [])));
      const free = (b.domains || Object.keys(DOMAIN)).filter((k) => !taken.has(k)).map((k) => DOMAIN[k] || k);
      if (free.length) rows.push(row({ lead: lead(I.shield), title: 'Nobody takes these yet', desc: esc(`${listWords(free)}. Your bots will say so if you ask.`), cls: 'lm-off' }));
      const hs = b.handoffs || [];
      if (hs.length) {
        rows.push(fold('handoffs', 'Work passed between bots', `${hs.length} recent ${hs.length === 1 ? 'handoff' : 'handoffs'}.`));
        rows.push(folded('handoffs', hs.map((h) => row({ lead: lead(I.hand), title: `<span class="lm-mem">${esc(h.intent)}</span>`, desc: esc([`${h.fromName || 'Codeply'} to ${h.toName || 'nobody'}`, HANDOFF[h.status] || h.status, ago(h.updatedAt)].filter(Boolean).join(' · ')) }))));
      }
    }
    out.push(section('Who handles what', rows, { sub: 'Bots pass work to each other by this.' }));

    const l = life;
    if (l && l.autopilot) {
      const a = l.autopilot;
      const own = [row({ title: 'Work on their own', desc: a.paused ? 'Stopped. Nothing runs until you turn this back on.' : 'They plan, do, check and report back, and deleting things or money always wait for you.', ctl: sw('auto', null, !a.paused, 'Work on their own') })];
      for (const o of a.outbox || []) {
        const bt = UI.bot(o.botId);
        own.push(row({ lead: bt ? leadAv(bt) : lead(I.mail), title: `<span class="lm-mem">${esc(o.title)}</span>`, desc: esc(`${bt ? `${bt.name} · ` : ''}${o.status === 'needs_you' ? 'Needs your OK' : `Goes out ${dayTime(o.dueAt)}`}`), ctl: `${btn('outbox-now', o.id, 'Send now', 'lm-small')}${btn('outbox-cancel', o.id, 'Cancel', 'lm-small')}` }));
      }
      for (const t of (a.tasks || []).filter((x) => ['queued', 'running', 'verifying', 'needs_you'].includes(x.status))) {
        const bt = UI.bot(t.botId);
        own.push(row({ lead: bt ? leadAv(bt) : lead(I.tasks), title: `<span class="lm-mem">${esc(t.text)}</span>`, desc: esc(`${bt ? `${bt.name} · ` : ''}${TASK[t.status] || t.status}`), ctl: btn('task-cancel', t.id, 'Cancel', 'lm-small') }));
      }
      const audit = a.audit || [];
      if (audit.length) {
        own.push(fold('audit', 'Everything they did alone', `${audit.length} ${audit.length === 1 ? 'thing' : 'things'} this week.`));
        own.push(folded('audit', audit.map((x) => { const bt = UI.bot(x.botId); return row({ lead: bt ? leadAv(bt) : lead(I.tasks), title: `<span class="lm-mem">${esc(x.title)}${x.result ? `: ${esc(x.result)}` : ''}</span>`, desc: esc([bt ? bt.name : 'Codeply', dayTime(x.at)].join(' · ')) }); })));
      }
      out.push(section('On their own', own));
    }

    const m = l && l.mail;
    if (m) {
      let rowsM;
      if (m.error && !(m.boxes || []).length) rowsM = [row({ title: 'Email addresses for your bots', desc: esc(firstSentence(m.error)), ctl: '<span class="set-status">Not ready</span>', cls: 'lm-off' })];
      else {
        rowsM = [m.error
          ? row({ title: 'Bot email is not reachable', desc: 'Mail waits until it is back.', ctl: '<span class="set-status">Offline</span>' })
          : row({ title: `${m.used.month} of ${m.limits.month} emails this month`, desc: `${m.used.day} of ${m.limits.day} today.`, ctl: `<span class="lm-meter" role="img" aria-label="${Math.min(100, Math.round((m.used.month / Math.max(1, m.limits.month)) * 100))} percent used"><span style="width:${Math.min(100, Math.round((m.used.month / Math.max(1, m.limits.month)) * 100))}%"></span></span>` })];
        rowsM.push(...((m.boxes || []).length ? m.boxes.map((x) => row({ title: esc(x.botName || 'A bot'), desc: esc(x.address) })) : [row({ title: 'No addresses yet', desc: 'Give a bot one in its settings, under Email.', cls: 'lm-off' })]));
      }
      out.push(section('Bot email', rowsM));
    }
    if (l && l.autopilot) out.push(danger('Stops every task right now.', 'stop-all', 'Stop all bots'));
    return out.join('');
  }

  // ─── Privacy ────────────────────────────────────────────────────────────
  const privateBots = () => bots().filter((b) => b.life && b.life.sensitive && b.life.read !== false);
  function privacyPage() {
    const names = privateBots().map((b) => b.name);
    const rows = [
      row({ lead: lead(I.lock), title: 'Stays on this PC', desc: 'Memories and what your bots see are kept here, not online.' }),
      row({ lead: lead(I.shield), title: 'Never kept', desc: 'Jokes, sarcasm, passwords and secrets are thrown away.' }),
      row({ lead: lead(I.eye), title: 'Who sees private things', desc: esc(names.length ? `Calls and health: only ${listWords(names)}.` : 'Calls and health: no bot.'), ctl: bots().length ? pill('private-menu', null, names.length ? `${names.length} ${names.length === 1 ? 'bot' : 'bots'}` : 'No bots', 'Bots that see private things') : '' }),
    ];
    if (life && life.canSeal === false) rows.push(row({ lead: lead(I.alert), title: 'Call notes are not kept', desc: 'This PC cannot lock them away, so they are skipped.', cls: 'lm-off' }));
    return [section('', rows), danger('Memories are not touched.', 'forget-life', 'Forget what your bots saw')].join('');
  }

  const PAGES = { memory: memoryPage, see: seePage, reach: reachPage, calls: callsPage, team: teamPage, privacy: privacyPage };

  // ─── Loading and painting ───────────────────────────────────────────────
  async function loadLife() { try { const r = await api.lifeState(); life = r && !r.error ? r : (life || r); } catch (e) { life = life || { error: e.message }; } }
  async function loadBrain() { try { const r = await api.brainState(); brain = r && !r.error ? r : (brain || r); } catch (e) { brain = brain || { error: e.message }; } }

  /** settings.js: the page's rows, fresh from the main process. */
  async function html(id) {
    await Promise.all([loadLife(), loadBrain()]);
    hid = 0;
    return (PAGES[id] || memoryPage)();
  }

  const keyOf = (e) => `${e.dataset.act}|${e.dataset.id || ''}`;
  const h1 = () => body && body.parentElement && body.parentElement.querySelector('.set-h1');
  const menuOpen = () => !menu.hidden;

  // Repaints the page and puts focus (and the caret) back where it was.
  function repaint(focusKey) {
    if (!body || !body.isConnected) { body = null; return; }
    if (menuOpen() || dlg.open) { pending = true; return; }
    pending = false;
    const a = document.activeElement;
    let fk = focusKey || null; let sel = null;
    if (!fk && a && a.dataset && a.dataset.act && body.contains(a)) {
      fk = keyOf(a);
      try { if (typeof a.selectionStart === 'number') sel = [a.selectionStart, a.selectionEnd]; } catch { sel = null; }
    }
    hid = 0;
    body.innerHTML = (PAGES[page] || memoryPage)();
    if (window.CrewSettings && window.CrewSettings.paintCounts) window.CrewSettings.paintCounts();
    if (fk) {
      const el = [...body.querySelectorAll('[data-act]')].find((e) => keyOf(e) === fk && !e.disabled);
      if (el) {
        el.focus({ preventScroll: true });
        if (sel) try { el.setSelectionRange(sel[0], sel[1]); } catch { /* not a text field */ }
      } else if (a && !a.isConnected) focusTop();
    }
  }
  function focusTop() { const h = h1(); if (h) h.focus({ preventScroll: true }); }

  // Fades a row out, runs the change, then moves focus to the row that took its place.
  function removeRow(id, change) {
    const el = body && body.querySelector(`[data-row="${CSS.escape(id)}"]`);
    const next = el && (el.nextElementSibling || el.previousElementSibling);
    const nextId = next && next.dataset && next.dataset.row;
    const done = async () => {
      await change();
      const target = nextId && body && body.querySelector(`[data-row="${CSS.escape(nextId)}"] button`);
      if (target) target.focus({ preventScroll: true }); else focusTop();
    };
    if (!el || reduced()) return done();
    el.classList.add('lm-leaving');
    return new Promise((r) => setTimeout(() => done().then(r), 160));
  }

  // ─── Talking to the main process ────────────────────────────────────────
  const fail = (r) => { UI.toast((r && r.error) || 'That did not work.', 'error'); };
  async function setLife(patch, focusKey) {
    const r = await api.lifeSet(patch);
    if (!r || r.error) { fail(r); repaint(focusKey); return null; }
    life = { ...life, ...r };
    repaint(focusKey);
    return life;
  }
  async function lifeCall(p, focusKey) {
    const r = await p;
    if (r && r.error) { fail(r); return null; }
    if (r && r.sources) life = { ...life, ...r }; else await loadLife();
    repaint(focusKey);
    return r;
  }
  async function brainCall(p, focusKey) {
    const r = await p;
    if (!r || r.error) { fail(r); repaint(focusKey); return null; }
    brain = r;
    repaint(focusKey);
    return r;
  }

  // ─── Toast with Undo ────────────────────────────────────────────────────
  const toastEl = document.createElement('div');
  toastEl.className = 'lm-toast';
  toastEl.setAttribute('role', 'status');
  toastEl.setAttribute('aria-live', 'polite');
  toastEl.hidden = true;
  toastEl.innerHTML = '<span></span><button type="button" class="set-btn lm-small">Undo</button>';
  document.body.appendChild(toastEl);
  const toastUndo = toastEl.querySelector('button');
  let toastTimer = null; let undoFn = null;
  function toast(text, undo) {
    clearTimeout(toastTimer);
    toastEl.querySelector('span').textContent = text;
    undoFn = undo || null;
    toastUndo.hidden = !undo;
    toastEl.hidden = false;
    toastTimer = setTimeout(hideToast, undo ? 6000 : 3500);
  }
  function hideToast() { toastEl.hidden = true; undoFn = null; }
  toastUndo.addEventListener('click', () => { const f = undoFn; hideToast(); if (f) f(); });

  // ─── Confirm dialog ─────────────────────────────────────────────────────
  const dlg = document.createElement('dialog');
  dlg.className = 'lm-dlg';
  dlg.setAttribute('aria-labelledby', 'lmDlgTitle');
  dlg.setAttribute('aria-describedby', 'lmDlgText');
  dlg.innerHTML = `<form method="dialog"><h2 id="lmDlgTitle"></h2><p id="lmDlgText"></p>
    <label class="lm-dlg-check" hidden><input type="checkbox"><span></span></label>
    <div class="lm-dlg-actions"><button class="set-btn" value="cancel">Cancel</button><button class="set-btn" value="ok">OK</button></div></form>`;
  document.body.appendChild(dlg);
  function confirmIt({ title, text, ok, check }) {
    return new Promise((resolve) => {
      const back = document.activeElement;
      dlg.querySelector('#lmDlgTitle').textContent = title;
      dlg.querySelector('#lmDlgText').textContent = text;
      const okBtn = dlg.querySelector('[value="ok"]');
      okBtn.textContent = ok;
      okBtn.className = check ? 'set-btn primary' : 'set-btn lm-danger-solid';
      const wrap = dlg.querySelector('.lm-dlg-check'); const box = wrap.querySelector('input');
      wrap.hidden = !check; box.checked = false;
      okBtn.disabled = !!check;
      if (check) wrap.querySelector('span').textContent = check;
      box.onchange = () => { okBtn.disabled = !box.checked; };
      // Settled from the buttons and Escape themselves: the close event can wait for the next frame.
      let done = false;
      const finish = (yes) => {
        if (done) return;
        done = true;
        dlg.onclick = null; dlg.oncancel = null; dlg.onclose = null;
        if (dlg.open) dlg.close(yes ? 'ok' : 'cancel');
        if (pending) repaint();
        if (!yes && back && back.isConnected) back.focus({ preventScroll: true });
        resolve(yes);
      };
      dlg.onclick = (e) => {
        const b = e.target.closest('button[value]');
        if (b) { e.preventDefault(); if (!b.disabled) finish(b.value === 'ok'); }
      };
      dlg.oncancel = (e) => { e.preventDefault(); finish(false); };
      dlg.onclose = () => finish(dlg.returnValue === 'ok');
      dlg.returnValue = '';
      dlg.showModal();
      dlg.querySelector('[value="cancel"]').focus();
    });
  }

  // ─── Menus (position: fixed, never clipped) ─────────────────────────────
  const menu = document.createElement('div');
  menu.className = 'lm-menu';
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  document.body.appendChild(menu);
  let menuKey = null; let menuBuild = null;
  const anchorEl = () => menuKey && body && [...body.querySelectorAll('[data-act]')].find((e) => keyOf(e) === menuKey);
  function placeMenu(anchor) {
    const r = anchor.getBoundingClientRect();
    menu.style.maxHeight = `${window.innerHeight - 16}px`;
    const w = menu.offsetWidth; const h = menu.offsetHeight;
    let left = r.right - w;
    if (left < 8) left = Math.min(r.left, window.innerWidth - w - 8);
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - 8) top = r.top - h - 6;
    top = Math.max(8, Math.min(top, window.innerHeight - h - 8));
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
  }
  function paintMenu() {
    const { title, items } = menuBuild();
    menu.innerHTML = `${title ? `<div class="lm-menu-note">${esc(title)}</div>` : ''}${items.map((it, i) => {
      if (it.sep) return '<hr>';
      const role = it.multi ? 'menuitemcheckbox' : it.checked != null ? 'menuitemradio' : 'menuitem';
      return `<button type="button" class="lm-menu-item${it.multi ? ' lm-box' : ''}" role="${role}" data-i="${i}" tabindex="-1" ${it.checked != null ? `aria-checked="${!!it.checked}"` : ''}>${it.bot ? `<span class="lm-mi-av" aria-hidden="true">${avatar(it.bot, 20)}</span>` : ''}<span class="lm-mi-text">${esc(it.label)}${it.desc ? `<span class="lm-mi-desc">${esc(it.desc)}</span>` : ''}</span>${it.checked != null ? G(I.check).replace('<svg', '<svg class="lm-tick"') : ''}</button>`;
    }).join('')}`;
    menu.setAttribute('aria-label', title || 'Options');
    return items;
  }
  function openMenu(anchor, build) {
    if (menuKey === keyOf(anchor) && menuOpen()) { closeMenu(true); return; }
    closeMenu(false);
    menuKey = keyOf(anchor); menuBuild = build;
    const items = paintMenu();
    menu.hidden = false;
    menu.classList.remove('lm-in'); void menu.offsetWidth; menu.classList.add('lm-in');
    placeMenu(anchor);
    anchor.setAttribute('aria-expanded', 'true');
    const first = items.findIndex((it) => it.checked && !it.multi);
    const btns = [...menu.querySelectorAll('.lm-menu-item')];
    (btns.find((b) => Number(b.dataset.i) === first) || btns[0]).focus();
  }
  function closeMenu(refocus) {
    if (!menuOpen()) return;
    menu.hidden = true;
    const a = anchorEl();
    if (a) { a.setAttribute('aria-expanded', 'false'); if (refocus) a.focus(); }
    menuKey = null; menuBuild = null;
    if (pending) repaint();
  }
  let busy = false;
  menu.addEventListener('click', async (e) => {
    const b = e.target.closest('.lm-menu-item');
    if (!b || busy) return;
    const it = menuBuild().items[Number(b.dataset.i)];
    if (it.multi || it.keep) {
      busy = true;
      try { await it.run(); } finally { busy = false; }
      if (!menuOpen()) return;
      const i = b.dataset.i; const key = menuKey;
      menu.hidden = true; repaint(key); menu.hidden = false;
      const a = anchorEl(); if (a) a.setAttribute('aria-expanded', 'true');
      paintMenu();
      const again = menu.querySelector(`[data-i="${i}"]`); if (again) again.focus();
      if (a) placeMenu(a);
    } else {
      const key = menuKey;
      closeMenu(false);
      await it.run();
      const a = body && [...body.querySelectorAll('[data-act]')].find((x) => keyOf(x) === key);
      if (a) a.focus({ preventScroll: true });
    }
  });
  menu.addEventListener('keydown', (e) => {
    const btns = [...menu.querySelectorAll('.lm-menu-item')];
    const i = btns.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); btns[(i + 1) % btns.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); btns[(i - 1 + btns.length) % btns.length].focus(); }
    else if (e.key === 'Home') { e.preventDefault(); btns[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); btns[btns.length - 1].focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(true); }
    else if (e.key === 'Tab') closeMenu(true);
  });
  document.addEventListener('mousedown', (e) => { if (menuOpen() && !menu.contains(e.target) && !(anchorEl() || document.body).contains(e.target)) closeMenu(false); });
  window.addEventListener('resize', () => closeMenu(false));
  document.addEventListener('scroll', () => closeMenu(false), { capture: true, passive: true });

  const botItems = (cur, run) => [
    { label: 'Best bot', desc: 'Whoever fits the moment', checked: !cur, run: () => run('') },
    ...(bots().length ? [{ sep: true }] : []),
    ...bots().map((b) => ({ label: b.name, bot: b, checked: cur === b.id, run: () => run(b.id) })),
  ];

  // ─── Actions ────────────────────────────────────────────────────────────
  function forgetMemory(id) {
    const m = memById(id);
    if (!m) return;
    removeRow(id, () => brainCall(api.brainForget(id), false));
    toast(m.kind === 'lesson' ? 'Forgot that lesson.' : 'Forgot it.', () => brainCall(api.brainAdd({ text: m.text, kind: m.kind, project: m.project || '' })));
  }
  async function saveEdit(id) {
    const m = memById(id);
    const text = ui.editText.trim();
    ui.editing = '';
    if (!m || !text || text === m.text) { repaint(`edit|${id}`); return; }
    const before = m.text;
    if (await brainCall(api.brainCorrect(id, { text }), `edit|${id}`)) toast('Corrected. No bot can change it now.', () => brainCall(api.brainCorrect(id, { text: before })));
  }
  async function addMemory() {
    const d = ui.draft; const text = d.text.trim();
    if (!text) return;
    const had = new Set(mems().map((m) => m.id));
    const r = await api.brainAdd({ text, kind: d.kind, project: PROJECT_KINDS.includes(d.kind) ? d.project : '' });
    if (!r || r.error) { fail(r); return; }
    brain = r;
    const added = mems().filter((m) => !had.has(m.id)).map((m) => m.id);
    d.text = ''; ui.adding = false;
    repaint('add-open|');
    toast('Remembered.', added.length ? async () => { for (const id of added) await brainCall(api.brainForget(id)); } : null);
  }
  async function stepNudges(by) {
    const per = Math.max(1, Math.min(30, (Number(life.nudges.perDay) || 1) + by));
    await setLife({ nudges: { perDay: per } }, `step|${by}`);
  }
  let findTimer = null;
  async function runFind() {
    const q = ui.find.trim();
    if (!q) { ui.hits = null; repaint(); return; }
    const r = await api.lifeSearch(q).catch(() => []);
    if (ui.find.trim() !== q) return;
    ui.hits = Array.isArray(r) ? r : [];
    repaint();
  }

  const CLICK = {
    go: (el) => window.CrewSettings && window.CrewSettings.show(el.dataset.id),
    fold: (el) => { const k = el.dataset.id; if (ui.open.has(k)) ui.open.delete(k); else ui.open.add(k); repaint(); },
    // Memory
    'add-open': () => { ui.adding = !ui.adding; repaint(); if (ui.adding) { const i = body.querySelector('[data-act="add-text"]'); if (i) i.focus(); } },
    'add-cancel': () => { ui.adding = false; ui.draft.text = ''; repaint('add-open|'); },
    'kind-menu': (el) => openMenu(el, () => ({ title: 'Kind', items: KIND_ORDER.map((k) => ({ label: kindLabel(k), checked: ui.draft.kind === k, run: () => { ui.draft.kind = k; repaint(); } })) })),
    'about-menu': (el) => openMenu(el, () => ({ title: 'What it is about', items: [{ key: '', name: 'About you' }, ...((brain && brain.projects) || [])].map((p) => ({ label: p.key ? `Project: ${p.name}` : 'About you', checked: ui.draft.project === p.key, run: () => { ui.draft.project = p.key; repaint(); } })) })),
    keep: async (el) => { const id = el.dataset.id; if (await brainCall(api.brainConfirm(id), `edit|${id}`)) toast('Kept. Your bots treat it as true now.'); },
    forget: (el) => forgetMemory(el.dataset.id),
    edit: (el) => { const m = memById(el.dataset.id); if (!m) return; ui.editing = m.id; ui.editText = m.text; repaint(`edit-text|${m.id}`); const i = body.querySelector('[data-act="edit-text"]'); if (i) i.select(); },
    'edit-cancel': (el) => { ui.editing = ''; repaint(`edit|${el.dataset.id}`); },
    'edit-save': (el) => saveEdit(el.dataset.id),
    'review-keep': (el) => { const id = el.dataset.id; removeRow(id, () => brainCall(api.brainResolve(id, 'keep'), false)); toast('Kept what it knew.'); },
    'review-switch': (el) => {
      const id = el.dataset.id; const m = memById(id);
      removeRow(id, () => brainCall(api.brainResolve(id, 'switch'), false));
      toast(`Switched to what ${(m && m.challenger && said(m.challenger.from)) || 'your bot'} heard.`, () => brainCall(api.brainResolve(id, 'undo')));
    },
    'review-undo': (el) => { const id = el.dataset.id; removeRow(id, () => brainCall(api.brainResolve(id, 'undo'), false)); toast('Changed it back.'); },
    'forget-project': async (el) => {
      const key = el.dataset.id; const name = projName(key);
      if (!await confirmIt({ title: `Forget ${name}?`, text: 'Your bots forget its decisions, ideas, requirements and to-dos, and the project itself is not touched.', ok: 'Forget project' })) return;
      if (await brainCall(api.brainClear(`project:${key}`), false)) { focusTop(); toast(`Forgot ${name}.`); }
    },
    'forget-all': async () => {
      if (!await confirmIt({ title: 'Forget everything?', text: 'Every memory and lesson on this PC is deleted, and this cannot be undone.', ok: 'Forget everything' })) return;
      if (await brainCall(api.brainClear(''), false)) { focusTop(); toast('Forgot everything.'); }
    },
    // What bots can see
    connect: () => api.openConnect(),
    'forget-source': async (el) => {
      const s = src(el.dataset.id);
      if (!await confirmIt({ title: `Forget what ${s.label || 'it'} showed?`, text: 'What your bots saw from it on this PC is deleted, and this cannot be undone.', ok: 'Forget it' })) return;
      if (await lifeCall(api.lifeForgetSource(el.dataset.id), `src|${el.dataset.id}`)) toast(`Forgot what ${s.label || 'it'} showed.`);
    },
    'forget-item': (el) => { const id = el.dataset.id; removeRow(id, () => lifeCall(api.lifeForgetItem(id), false)); toast('Forgot it.'); },
    'forget-hit': (el) => {
      const id = el.dataset.id;
      removeRow(id, async () => { await api.lifeForgetItem(id); ui.hits = (ui.hits || []).filter((x) => x.id !== id); await loadLife(); repaint(false); });
      toast('Forgot it.');
    },
    // Reaching you
    step: (el) => stepNudges(Number(el.dataset.id)),
    'who-menu': (el) => {
      const t = ((life.nudges || {}).triggers || []).find((x) => x.key === el.dataset.id);
      openMenu(el, () => ({ title: `Who says "${t ? t.label : ''}"`, items: botItems((life.nudges.botFor || {})[el.dataset.id], (id) => setLife({ nudges: { botFor: { [el.dataset.id]: id } } })) }));
    },
    // Calls
    mode: (el) => setLife({ calls: { listen: el.dataset.id } }, `mode|${el.dataset.id}`),
    'call-who': (el) => openMenu(el, () => ({ title: 'Who helps on calls', items: botItems(life.calls.botId, (id) => setLife({ calls: { botId: id } })) })),
    'listen-now': async (el) => { el.disabled = true; await lifeCall(api.lifeListenNow(), 'call-stop|'); },
    'call-show': () => api.lifeCallShow(),
    'call-stop': async () => { if (await lifeCall(api.lifeCallStop(), 'listen-now|')) toast('Stopped listening. The notes are saved.'); },
    // Teamwork
    handles: (el) => {
      const id = el.dataset.id;
      const cur = () => (brain.bots || []).find((x) => x.id === id) || { handles: [], inferred: [] };
      openMenu(el, () => {
        const x = cur();
        const set = (x.handles || []).length > 0;
        const have = new Set(set ? x.handles : x.inferred || []);
        const domains = brain.domains || Object.keys(DOMAIN);
        const items = domains.map((d) => ({
          label: DOMAIN[d] || d, multi: true, checked: have.has(d),
          run: () => { if (have.has(d)) have.delete(d); else have.add(d); return brainCall(api.brainHandles(id, domains.filter((k) => have.has(k))), `handles|${id}`); },
        }));
        if (set) items.push({ sep: true }, { label: 'Go back to its guess', desc: (x.inferred || []).length ? listWords(x.inferred.map((d) => DOMAIN[d] || d)) : 'No jobs', keep: true, run: () => brainCall(api.brainHandles(id, []), `handles|${id}`) });
        return { title: `Jobs ${x.name || ''} takes`, items };
      });
    },
    'outbox-now': async (el) => { if (await lifeCall(api.lifeOutbox(el.dataset.id, 'now'), false)) { focusTop(); toast('Sent.'); } },
    'outbox-cancel': async (el) => { if (await lifeCall(api.lifeOutbox(el.dataset.id, 'cancel'), false)) { focusTop(); toast('Cancelled. It will not go out.'); } },
    'task-cancel': async (el) => { if (await lifeCall(api.lifeTask(el.dataset.id, 'cancel'), false)) { focusTop(); toast('Cancelled.'); } },
    'stop-all': async () => {
      if (!await confirmIt({ title: 'Stop all bots?', text: 'Every task stops now and nothing waiting goes out, until you turn Work on their own back on.', ok: 'Stop all bots' })) return;
      if (await lifeCall(api.lifeStopAll(), 'auto|')) toast('Stopped every bot.');
    },
    // Privacy
    'private-menu': (el) => openMenu(el, () => ({
      title: 'Who sees calls and health',
      items: bots().map((b) => ({
        label: b.name, bot: b, multi: true, checked: !!(b.life && b.life.sensitive && b.life.read !== false),
        run: async () => {
          const lf = { ...(b.life || {}) };
          const on = !(lf.sensitive && lf.read !== false);
          lf.sensitive = on; if (on) lf.read = true;
          const r = await api.botsUpdate(b.id, { life: lf });
          if (!r || r.error) { fail(r); return; }
          S().catalog = r;
        },
      })),
    })),
    'forget-life': async () => {
      if (!await confirmIt({ title: 'Forget what your bots saw?', text: 'Calendar, email, call notes and everything else they saw on this PC is deleted, and this cannot be undone.', ok: 'Forget it all' })) return;
      if (await lifeCall(api.lifeClear(), false)) { focusTop(); toast('Forgot what your bots saw.'); }
    },
  };

  async function onChange(el) {
    const v = el.checked; const id = el.dataset.id; const k = `${el.dataset.act}|${id || ''}`;
    switch (el.dataset.act) {
      case 'mem-on': if (await brainCall(api.brainEnable(v), k)) toast(v ? 'Remembering again.' : 'Off. Nothing new is learned.'); return;
      case 'life-on': await setLife({ on: v }, k); return;
      case 'heard':
        if (v && !(life.calls || {}).consentAck) {
          el.checked = false;
          if (await confirmIt({ title: 'Turn on the mic?', text: 'Your mic stays on while Craft runs, and only the important bits are kept as text.', ok: 'Turn on', check: 'I will tell people an assistant is listening' })) await setLife({ calls: { consentAck: true }, sources: { heard: true } }, k);
          return;
        }
        await setLife({ sources: { heard: v } }, k); return;
      case 'screen': await setLife({ sources: { screen: v } }, k); return;
      case 'src': await setLife({ sources: { [id]: v } }, k); return;
      case 'nudge-on': await setLife({ nudges: { on: v } }, k); return;
      case 'phone': await setLife({ nudges: { phone: v } }, k); return;
      case 'quiet-on': await setLife({ nudges: { quiet: { on: v } } }, k); return;
      case 'quiet-from': case 'quiet-to':
        if (/^\d\d:\d\d$/.test(el.value)) await setLife({ nudges: { quiet: { [el.dataset.act === 'quiet-from' ? 'from' : 'to']: el.value } } }, k);
        return;
      case 'trigger': await setLife({ nudges: { triggers: { [id]: v } } }, k); return;
      case 'consent': await setLife({ calls: { consentAck: v } }, k); return;
      case 'whisper': await setLife({ calls: { whisperVoice: v } }, k); return;
      case 'auto': if (await setLife({ autopilot: { paused: !v } }, k)) toast(v ? 'Your bots can work on their own again.' : 'Stopped. Nothing runs on its own.'); return;
      default:
    }
  }

  /** settings.js: wire the page it just painted. Listeners sit on the body, so repaints keep them. */
  function wire(id, el) {
    body = el; page = PAGES[id] ? id : 'memory';
    ui.editing = '';
    el.classList.add('lm');
    el.addEventListener('click', (e) => {
      const t = e.target.closest('[data-act]');
      if (!t || !el.contains(t) || t.matches('input')) return;
      const f = CLICK[t.dataset.act];
      if (f) { e.preventDefault(); f(t, e); }
    });
    el.addEventListener('change', (e) => { const t = e.target; if (t.dataset && t.dataset.act) onChange(t); });
    el.addEventListener('input', (e) => {
      const t = e.target; if (!t.dataset) return;
      if (t.dataset.act === 'filter') { ui.filter = t.value; repaint(); }
      else if (t.dataset.act === 'add-text') { ui.draft.text = t.value; const s = el.querySelector('[data-act="add-submit"]'); if (s) s.disabled = !t.value.trim(); }
      else if (t.dataset.act === 'edit-text') ui.editText = t.value;
      else if (t.dataset.act === 'find') { ui.find = t.value; ui.hits = null; clearTimeout(findTimer); findTimer = setTimeout(runFind, 250); }
    });
    el.addEventListener('submit', (e) => { e.preventDefault(); if (e.target.dataset.act === 'add-form') addMemory(); });
    el.addEventListener('keydown', (e) => {
      const t = e.target; if (!t.dataset) return;
      if (t.dataset.act === 'edit-text') {
        if (e.key === 'Enter') { e.preventDefault(); saveEdit(t.dataset.id); }
        if (e.key === 'Escape') { e.preventDefault(); ui.editing = ''; repaint(`edit|${t.dataset.id}`); }
      } else if (t.dataset.act === 'add-text' && e.key === 'Escape') {
        e.preventDefault(); CLICK['add-cancel']();
      } else if (t.dataset.act === 'mode' && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
        e.preventDefault();
        const order = MODES.map(([k]) => k);
        const i = order.indexOf(life.calls.listen) + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1);
        const next = order[(i + order.length) % order.length];
        setLife({ calls: { listen: next } }, `mode|${next}`);
      }
    });
    if (window.CrewSettings && window.CrewSettings.paintCounts) window.CrewSettings.paintCounts();
  }

  /** settings.js: Escape here belongs to a menu, a dialog or a field, not to leaving Settings. */
  function ownsEscape(e) {
    if (menuOpen() || dlg.open) return true;
    const t = e && e.target;
    return !!(t && t.dataset && body && body.contains(t) && ['edit-text', 'add-text'].includes(t.dataset.act));
  }

  /** The number on a settings menu item: memories that need a look. */
  function count(id) {
    if (id !== 'memory' || !brain || !brain.on) return 0;
    return mems().filter((m) => needsLook(m) || (m.status === 'tentative' && m.kind !== 'context')).length;
  }

  // Live updates: the old pages keep theirs, these pages repaint too.
  const wrap = (obj, fn) => {
    if (!obj || typeof obj.onState !== 'function') return;
    const orig = obj.onState;
    obj.onState = (st) => { try { orig(st); } finally { fn(st); } };
  };
  wrap(window.CrewLife, (st) => { if (st) { life = { ...(life || {}), ...st }; if (body && !ui.editing) repaint(); } });
  wrap(window.CrewBrain, (st) => { if (st) { brain = st; if (body && !ui.editing) repaint(); else if (window.CrewSettings && window.CrewSettings.paintCounts) window.CrewSettings.paintCounts(); } });
  loadBrain().then(() => { if (window.CrewSettings && window.CrewSettings.paintCounts) window.CrewSettings.paintCounts(); });

  window.CrewLifeMem = { html, wire, count, ownsEscape };
})();
