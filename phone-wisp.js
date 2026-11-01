// Wisp on the phone: the face of Codeply's agent (the character is wisp.js).
//
//   - The empty chat: Wisp, big, above the greeting. Its eyes follow your
//     finger, and it reads what you type as you type (a mood, and a shape
//     when you name one: "make it feel like a cloud").
//   - Every answer starts with Wisp's face. The newest one shows the work:
//     working while the agent runs, worried while an approval waits, sad on an
//     error, then the mood of the reply (the [mood: x] the desktop sends).
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
        if (!v) { home.setMood('listening'); home.setShape('pentagon'); return; }
        const r = W.read(v);
        home.setMood(r.mood === 'neutral' ? 'listening' : r.mood, !!r.shape);
        if (r.shape) home.setShape(r.shape);
      }, 240);
    });
    input.addEventListener('focus', () => { if (home && !input.value.trim()) home.setMood('listening'); });
    input.addEventListener('blur', () => { if (home && !input.value.trim()) { home.setMood('neutral'); home.setShape('pentagon'); } });
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
      ? (b.messages || []).map((m) => ({ user: m.role === 'user', mood: m.mood, error: m.role === 'error' }))
      : [...(b.prelude || []).map((m) => ({ user: m.role === 'user' })), ...(b.pcItems || []).map((m) => ({ user: m.kind === 'user', mood: m.kind === 'assistant' && !m.interim ? (m.mood || 'neutral') : undefined, error: m.kind === 'notice' && m.level === 'error' }))];
    for (const it of items) {
      if (it.user) moods.push('neutral');
      else if (moods.length && it.mood) moods[moods.length - 1] = it.mood;
      else if (moods.length && it.error) moods[moods.length - 1] = 'sad';
    }
    return moods;
  }

  function liveMood() {
    const st = P().state;
    if (!st || !st.current) return null;
    if ($('approvalSheet') && !$('approvalSheet').classList.contains('hidden')) return 'worried';
    if ($('imageSheet') && !$('imageSheet').classList.contains('hidden')) return 'worried';
    if (st.busy && st.busy.has(st.current)) return document.querySelector('#feed .steps-group.live') ? 'working' : 'thinking';
    return null;
  }

  let busyFaces = false;
  function decorate() {
    const f = $('feed');
    if (!f || busyFaces) return;
    busyFaces = true;
    try {
      const users = [...f.querySelectorAll(':scope > .msg.user')];
      // A user message that ends the feed has no answer yet, but the face shows it is coming.
      const moods = turnMoods();
      const live = liveMood();
      users.forEach((u, i) => {
        let face = u.nextElementSibling;
        // attachments sit after the user message; the face goes after them
        while (face && face.classList.contains('msg-files')) face = face.nextElementSibling;
        if (!face || !face.classList.contains('turn-face')) {
          const holder = document.createElement('div');
          holder.className = 'turn-face';
          holder.setAttribute('aria-hidden', 'true');
          const el = document.createElement('span');
          holder.appendChild(el);
          const state = document.createElement('span');
          state.className = 'turn-face-state';
          holder.appendChild(state);
          (face ? f.insertBefore(holder, face) : f.appendChild(holder));
          W.mount(el, { size: 'sm' });
          face = holder;
        }
        const last = i === users.length - 1;
        const mood = last && live ? live : moods[i] || 'neutral';
        const w = face.querySelector('.wisp-el') && face.querySelector('.wisp-el').wisp;
        if (w && w.mood !== mood) { w.setMood(mood); if (last && !live && mood !== 'neutral') w.talk(1200); }
        face.querySelector('.turn-face-state').textContent = last && live === 'worried' ? 'Needs your OK' : '';
      });
      // Faces whose user message went away (a redraw) go too.
      f.querySelectorAll(':scope > .turn-face').forEach((face) => {
        let prev = face.previousElementSibling;
        while (prev && prev.classList.contains('msg-files')) prev = prev.previousElementSibling;
        if (!prev || !prev.classList.contains('msg') || !prev.classList.contains('user')) face.remove();
      });
    } finally { busyFaces = false; }
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

  function start() {
    mountHome();
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
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
