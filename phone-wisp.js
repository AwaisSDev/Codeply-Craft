// Wisp on the phone: the face of Codeply's agent (the character is wisp.js).
//
//   - The empty chat: Wisp, big, above the greeting. Its eyes follow your
//     finger, and it reads what you type as you type (a mood, and a shape
//     when you name one: "make it feel like a cloud").
//   - One face in a chat, on top: whoever you're talking to (Codeply or a
//     specialist), on a pill with its name. It shows the work: working while the
//     agent runs, worried while an approval waits, sad on an error, then the
//     mood of the reply (the [mood: x] the desktop sends). Answers carry no face.
//   - Approval sheets and sign-in show Wisp too.
//   - The title shows where the work runs: the PC's name and "online" or
//     "offline", in words, not just a coloured dot.
//
// It only watches the DOM phone.js draws (and reads CraftPhone.state), so the
// app's own logic is untouched.
(function () {
  'use strict';
  const W = window.CraftWisp;
  if (!W) return;
  const $ = (id) => document.getElementById(id);
  const P = () => window.CraftPhone || {};

  // ─── Empty chat and sign-in ───────────────────────────────────────────────
  let home = null;
  function mountHome() {
    const head = document.querySelector('#empty .empty-head');
    if (!head || head.querySelector('.empty-wisp')) return;
    const holder = document.createElement('div');
    holder.className = 'empty-wisp';
    const el = document.createElement('div');
    holder.appendChild(el);
    head.insertBefore(holder, head.firstChild);
    home = W.mount(el, { size: 'lg', morph: true });
    const input = $('input');
    let t = null;
    if (!input) return;
    input.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => {
        if (!home) return;
        const v = input.value.trim();
        if (!v) { home.setMood('listening'); home.setShape('hexagon'); return; }
        const r = W.read(v);
        home.setMood(r.mood === 'neutral' ? 'listening' : r.mood, !!r.shape);
        if (r.shape) home.setShape(r.shape);
      }, 240);
    });
    input.addEventListener('focus', () => { if (home && !input.value.trim()) home.setMood('listening'); });
    input.addEventListener('blur', () => { if (home && !input.value.trim()) { home.setMood('neutral'); home.setShape('hexagon'); } });
  }

  function mountSignin() {
    const inner = document.querySelector('#signin .signin-inner');
    if (!inner || inner.querySelector('.signin-wisp')) return;
    const holder = document.createElement('div');
    holder.className = 'signin-wisp';
    const el = document.createElement('div');
    holder.appendChild(el);
    inner.insertBefore(holder, inner.firstChild);
    const w = W.mount(el, { size: 'lg', mood: 'happy' });
    setTimeout(() => w.setMood('neutral'), 1600);
    ['loginEmail', 'loginPassword', 'loginOtp'].forEach((id) => {
      const i = $(id);
      if (i) { i.addEventListener('focus', () => w.setMood('listening')); i.addEventListener('blur', () => w.setMood('neutral')); }
    });
  }

  // ─── The face at the start of every answer ────────────────────────────────
  /** The mood each turn's reply ended on, in order, from the open chat's data. */
  function turnMoods() {
    const st = P().state;
    if (!st || !st.current) return [];
    const c = (st.chats || []).find((x) => x.id === st.current);
    const b = c && st.bodies && st.bodies.get(c.id);
    if (!b) return [];
    const moods = [];
    const items = c.kind === 'chat'
      ? (b.messages || []).map((m) => ({ user: m.role === 'user', mood: m.mood, text: m.content, error: m.role === 'error' }))
      : [...(b.prelude || []).map((m) => ({ user: m.role === 'user', text: m.content })), ...(b.pcItems || []).map((m) => ({ user: m.kind === 'user', mood: m.kind === 'assistant' && !m.interim ? m.mood : undefined, text: m.kind === 'assistant' && !m.interim ? m.text : m.kind === 'user' ? m.text : '', error: m.kind === 'notice' && m.level === 'error' }))];
    // Like voice mode: Wisp's face is how it feels about what you said (angry with you, a heart
    // for "love you"), or else the feeling of its own answer. A mood the agent sent ([mood: x]) wins.
    let react = null;
    for (const it of items) {
      if (it.user) { react = feel(it.text); moods.push(react || 'neutral'); }
      else if (!moods.length) continue;
      else if (it.mood) moods[moods.length - 1] = it.mood;
      else if (it.error) moods[moods.length - 1] = 'sad';
      else if (!react && it.text && moods[moods.length - 1] === 'neutral') moods[moods.length - 1] = feel(it.text) || 'neutral';
    }
    return moods;
  }

  const CALM = new Set(['neutral', 'thinking', 'listening']);
  /** The feeling in a line (wisp.js read), or null when it is just neutral. */
  function feel(text) {
    if (!text) return null;
    try { const m = W.read(String(text).slice(0, 600)).mood; return CALM.has(m) ? null : m; } catch { return null; }
  }
  /** How Wisp feels about the last thing you sent, while it answers. */
  function lastReaction() {
    const st = P().state;
    const c = st && (st.chats || []).find((x) => x.id === st.current);
    const b = c && st.bodies && st.bodies.get(c.id);
    if (!b) return null;
    const list = c.kind === 'chat' ? (b.messages || []).filter((m) => m.role === 'user').map((m) => m.content) : (b.pcItems || []).filter((m) => m.kind === 'user').map((m) => m.text);
    return feel(list[list.length - 1]);
  }
  function liveMood() {
    const st = P().state;
    if (!st || !st.current) return null;
    if ($('approvalSheet') && !$('approvalSheet').classList.contains('hidden')) return 'worried';
    if ($('imageSheet') && !$('imageSheet').classList.contains('hidden')) return 'worried';
    if (st.busy && st.busy.has(st.current)) return document.querySelector('#feed .steps-group.live') ? 'working' : lastReaction() || 'thinking';
    return null;
  }

  // One face, on top (setWho): no face beside each answer. It takes the newest
  // turn's mood (a heart for "love you", sad on an error), hops while the agent
  // works, and the pill under it says what is going on ("Thinking", "Needs your OK").
  let busyFaces = false;
  let saidKey = '';
  const LIVE_WORDS = { thinking: 'Thinking', working: 'Working', worried: 'Needs your OK' };
  function decorate() {
    const f = $('feed');
    if (!f || busyFaces) return;
    busyFaces = true;
    try {
      f.querySelectorAll(':scope > .turn-face').forEach((n) => n.remove());
      const moods = turnMoods();
      const live = liveMood();
      const mood = live || moods[moods.length - 1] || 'neutral';
      if (whoFace && whoFace.mood !== mood) {
        whoFace.setMood(mood);
        const key = `${moods.length}:${mood}`;
        if (!live && mood !== 'neutral' && key !== saidKey) { saidKey = key; whoFace.talk(1200); } // a new reply: it says it
      }
      const box = $('topWho');
      if (box) box.classList.toggle('live', live === 'thinking' || live === 'working');
      const said = $('topWhoState');
      // The pill morphs: the words slide in while it works and slide back out after
      // (the last words stay in place while they slide out, so it shrinks, not snaps).
      const words = (live && LIVE_WORDS[live]) || '';
      if (said) {
        if (words && said.textContent !== words) said.textContent = words;
        const on = words ? '1' : '';
        if ((said.dataset.on || '') !== on) said.dataset.on = on;
      }
    } finally { busyFaces = false; }
  }

  // ─── The thinking line: a new word now and then, so a wait feels like something is happening ───
  const THINK = ['Thinking', 'Pondering', 'Noodling', 'Mulling it over', 'Connecting the dots', 'Brewing an answer', 'Untangling it', 'Almost there'];
  const WORK = ['Working', 'Tinkering', 'Wiring it up', 'Crunching', 'Checking twice', 'Putting it together'];
  let thinkTurn = 0;
  function nextWord() {
    const els = document.querySelectorAll('#feed .working .think-word');
    if (!els.length) { thinkTurn = 0; return; }
    thinkTurn++;
    els.forEach((w) => {
      if (w.dataset.fixed) return; // says what is happening ("Searching the web")
      const list = /^(Working|Tinkering|Wiring|Crunching|Checking|Putting)/.test(w.textContent) || liveMood() === 'working' ? WORK : THINK;
      // the first word stays a moment; after that, move on, never the same twice in a row
      let word = list[thinkTurn % list.length];
      if (word === w.textContent) word = list[(thinkTurn + 1) % list.length];
      w.textContent = word;
      w.classList.remove('in'); void w.offsetWidth; w.classList.add('in');
    });
  }

  // ─── Who you're talking to, in the header ─────────────────────────────────
  // Its face on top, a small pill below with its name and where the work runs,
  // tinted in its colour: Codeply's blue, or the specialist the chat switched to
  // (phone-specialists.js calls setWho). On the empty chat the big Wisp is the face.
  const CODEPLY_COLOR = '#4C8DFF';
  let whoFace = null;
  let whoKey = null;
  function setWho(spec) {
    const box = $('topWho');
    const slot = $('topWhoFace');
    if (!box || !slot) return;
    const key = spec ? `${spec.id}|${spec.shape}|${spec.color}|${spec.gear || ''}` : 'codeply';
    if (whoFace && key === whoKey) return;
    const look = spec && spec.shape ? { shape: spec.shape, color: spec.color, gear: spec.gear || undefined } : null;
    box.style.setProperty('--who', (spec && spec.color) || CODEPLY_COLOR);
    const name = $('topWhoName');
    if (name) name.textContent = spec ? spec.name : 'Codeply';
    if (!whoFace) {
      const el = W.avatar({ size: 'sm', mood: 'happy', look: look || undefined });
      slot.appendChild(el);
      whoFace = el.wisp || null;
    } else if (whoFace.dress) whoFace.dress(look, whoKey !== null); // the costume change when the chat switches
    whoKey = key;
  }

  // ─── Where the work runs, in the title ────────────────────────────────────
  function presence() {
    const sub = $('topSub');
    const src = $('pcStatus');
    if (!sub || !src) return;
    const st = P().state || {};
    const known = !!(st.pc && st.pc.device) || src.classList.contains('on');
    const label = (src.querySelector('span') || {}).textContent || '';
    const on = src.classList.contains('on');
    const text = on ? `${label} · online` : `${(st.pc && st.pc.device) || 'Your PC'} · offline`;
    sub.classList.toggle('hidden', !known);
    sub.classList.toggle('on', on);
    const t = sub.querySelector('span');
    if (t && t.textContent !== text) t.textContent = text;
  }

  window.CraftPhoneWho = { set: setWho };

  function start() {
    mountHome();
    if (!whoFace) setWho(null);
    // Wisp shows on the empty chat, at each answer and in onboarding. Sign-in and sheets stay plain.
    let q = false;
    const soon = () => { if (q) return; q = true; requestAnimationFrame(() => { q = false; decorate(); presence(); }); };
    const f = $('feed');
    if (f) new MutationObserver(soon).observe(f, { childList: true });
    ['approvalSheet', 'imageSheet', 'pcStatus', 'composer'].forEach((id) => { const n = $(id); if (n) new MutationObserver(soon).observe(n, { attributes: true, attributeFilter: ['class'], subtree: id === 'pcStatus' || id === 'composer', childList: id === 'pcStatus', characterData: id === 'pcStatus' }); });
    // Approvals on Android buzz once; iOS ignores vibrate, and the face still says it.
    const ap = $('approvalSheet');
    if (ap) new MutationObserver(() => { if (!ap.classList.contains('hidden') && navigator.vibrate) { try { navigator.vibrate(18); } catch {} } }).observe(ap, { attributes: true, attributeFilter: ['class'] });
    soon();
    setInterval(soon, 4000); // the PC's presence and a run's state change without a DOM change sometimes
    if (!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches)) setInterval(nextWord, 2300);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
