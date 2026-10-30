// The top bar's page: one shape at the top of the screen. At rest it's a thin
// line with no words on it; it grows into a ping's message card, and into the
// chat when clicked (the drop's real window takes over where it lands), then
// shrinks back into the line. The main process (island.js there) says what
// Codeply is doing; this page sets classes and sizes for the CSS, and only
// while Orbit listens or talks draws the waveform with requestAnimationFrame.
//
// It talks to main only through window.islandApi = { on(type, fn), send(type, data) }
// (island/preload.js in the app, a stand-in in a browser preview):
//   main to page:  'state' { voice: idle|listening|thinking|speaking|teaching, running, title,
//                            attached (the chat is open), covered (the drop's real window is up over the
//                            shape; the app only), chat: { width, height } (the drop's size) }
//                  'level' { v: 0..1 }        the mic while Orbit listens
//                  'ping'  { title, text, id } a note: the line glows, then grows into a card with the text
//                  'blur'  { width, height }  the chat is closing (it lost focus, Escape, ...): shrink back
//                                             from its size into the line
//   page to main:  'click' {}                 the line itself (opens the chat, or closes it if it's up)
//                  'ping-click' { id }        the message card was clicked: it grows on into the chat
//                  'ping-done' { id }         the card went back into the line without a click
//                  'morph' { to: chat|popup|bar, width, height, phase: start|end }
//                                             the shape starts or finishes growing or shrinking; at the
//                                             end of 'chat' the app shows the drop at exactly that spot
//                  'size' { width, height }   the room the page needs: grows just before the shape grows
//                                             into the chat, back to the resting size after it shrinks
//                  'hover' { on }             the mouse is over the line or the card (a Mac lets the window
//                                             catch clicks only then)
// Pings wait their turn here: one after the other, never over Orbit or the open chat.
(() => {
  const BARS = 30;
  const WIDTH = 400;        // the window's width (island.js); the chat is 380 wide
  const REST_H = 100;       // its height at rest: the line and room for a message card
  const TOP = 8;            // the shape's top edge (island.css), where the chat lands too
  const MORPH_MS = 380;     // the grow and shrink (island.css)
  const GLOW_MS = 700;      // a ping's glow before the card grows (island.css)
  const POP_MS = 3000;      // how long a message stays out, unless the mouse is on it
  const TEXT_OUT_MS = 130;
  const CARD_W = 380;       // a message card's widest, the chat's width
  const CARD_TEXT_X = 54;   // where its text starts, right of the logo (island.css .msg)
  const CHAT = { width: 380, height: 320 }; // until the app says the drop's real size (and in a preview)

  const $ = (id) => document.getElementById(id);
  let api = null;
  let body; let shape; let msg; let measure;
  const bars = [];

  const S = { voice: 'idle', running: 0, title: '', attached: false, covered: false, chat: { ...CHAT } };
  const queue = [];          // pings waiting their turn
  let ping = null;           // the one playing now
  let shown = false;         // its card is out with the text in
  let glowTimer = null; let textTimer = null; let stayTimer = null; let morphTimer = null; let nextTimer = null;
  let overHit = false; let overShape = false;
  let mode = 'idle';
  let openedAt = 0;         // when a click last opened the chat

  const shapeIs = () => body.dataset.shape;

  // Restart a one-shot CSS animation, even when it's the same class again.
  function replay(cls, ms) {
    body.classList.remove(cls);
    void body.offsetWidth;
    body.classList.add(cls);
    clearTimeout(replay[cls]);
    replay[cls] = setTimeout(() => body.classList.remove(cls), ms);
  }

  // ─── what the line shows at rest ──────────────────────────────────────────
  function render() {
    mode = S.voice !== 'idle' && S.voice !== 'teaching' ? S.voice : S.running > 0 ? 'run' : 'idle';
    body.dataset.mode = mode;
    body.classList.toggle('attached', !!S.attached);
    body.classList.toggle('covered', !!S.covered);
    shape.setAttribute('aria-label', ping && shown ? `${ping.title}: ${ping.text}`
      : S.voice === 'listening' ? 'Codeply is listening' : S.voice === 'thinking' ? 'Codeply is thinking'
      : S.voice === 'speaking' ? 'Codeply is talking' : S.running > 0 ? `Codeply is working on ${S.title || 'a task'}` : 'Codeply');
    if (mode === 'listening' || mode === 'speaking') animate();
  }

  // The waveform. Listening, the mic's level drives it (fast up, slow down);
  // talking there's no level to follow, so it's a calm, slow swell.
  let raf = 0; let target = 0; let level = 0;
  function frame(now) {
    raf = 0;
    if (mode !== 'listening' && mode !== 'speaking') {
      level = 0; target = 0;
      for (const b of bars) b.style.transform = '';
      return;
    }
    const t = now / 1000;
    if (mode === 'speaking') target = 0.32 + 0.1 * Math.sin(t * 2.1);
    else target *= 0.9; // fades unless the mic keeps it up
    level += (target - level) * (target > level ? 0.45 : 0.14);
    for (let i = 0; i < BARS; i++) {
      const x = (i - (BARS - 1) / 2) / (BARS / 2); // -1 at the left end, 1 at the right
      const env = Math.exp(-x * x * 2.2);         // taller in the middle
      const wob = mode === 'speaking'
        ? 0.55 + 0.45 * Math.sin(t * 3 + i * 0.5)
        : 0.6 + 0.4 * Math.sin(t * 9 + i * 1.7) * Math.sin(t * 4.3 + i * 0.6);
      const s = 0.14 + Math.min(0.86, level * env * wob * 1.3);
      bars[i].style.transform = `scaleY(${s.toFixed(3)})`;
    }
    raf = requestAnimationFrame(frame);
  }
  function animate() { if (!raf) raf = requestAnimationFrame(frame); }

  // ─── the shape: grow and shrink ───────────────────────────────────────────
  // The chat's own look (drop/drop.css): just its message bar while empty, a darker panel with a chat.
  const chatLook = (h) => (h > 140 ? { radius: 22, color: '#121212' } : { radius: 24, color: '#1c1c1c' });
  function grow(to, w, h, radius, color) {
    body.dataset.shape = to;
    shape.style.width = `${w}px`;
    shape.style.height = `${h}px`;
    shape.style.borderRadius = `${radius}px`;
    shape.style.backgroundColor = color || '';
  }
  function settle(to, w, h, after) {
    clearTimeout(morphTimer);
    api.send('morph', { to, width: w, height: h, phase: 'start' });
    morphTimer = setTimeout(() => { api.send('morph', { to, width: w, height: h, phase: 'end' }); if (after) after(); }, MORPH_MS);
  }

  // Into the chat: the drop's window opens at once and grows out of the line
  // itself with its chat already in it (drop.css), so the shape just steps aside.
  // The chat's own window starts as exactly this line and grows into the chat
  // (drop.css), so the line steps aside at once and comes back when it's gone.
  function toChat() {
    const { width, height } = S.chat;
    body.classList.remove('text');
    if (shapeIs() !== 'bar') {
      jump(() => {
        body.dataset.shape = 'bar';
        shape.style.width = ''; shape.style.height = ''; shape.style.borderRadius = ''; shape.style.backgroundColor = '';
      });
    }
    S.covered = true; openedAt = Date.now();
    jump(render); // gone at once: the chat's window is that line now
    api.send('morph', { to: 'chat', width, height, phase: 'start' });
  }

  // A change with no animation (the shape is out of sight, or it must not be seen moving).
  function jump(fn) {
    shape.classList.add('snap');
    fn();
    void shape.offsetWidth;
    shape.classList.remove('snap');
  }

  // Back into the line, from the card or the chat.
  function toBar() {
    body.classList.remove('text');
    body.dataset.shape = 'bar';
    shape.style.width = ''; shape.style.height = ''; shape.style.borderRadius = ''; shape.style.backgroundColor = '';
    settle('bar', 0, 0, () => {
      if (shapeIs() !== 'bar') return;
      api.send('size', { width: WIDTH, height: REST_H });
      clearTimeout(nextTimer); nextTimer = setTimeout(next, 120);
    });
  }

  // The chat is closing. Usually it already shrank back into the line itself
  // (instant): the line is just there again. Otherwise the shape shows at the
  // chat's exact size and shrinks.
  function closeChat(d) {
    const width = Number(d && d.width) || S.chat.width;
    const height = Number(d && d.height) || S.chat.height;
    S.chat = { width, height };
    S.attached = false; S.covered = false; openedAt = 0;
    if (d && d.instant) {
      clearTimeout(morphTimer);
      jump(() => {
        body.dataset.shape = 'bar';
        shape.style.width = ''; shape.style.height = ''; shape.style.borderRadius = ''; shape.style.backgroundColor = '';
        render();
      });
      api.send('size', { width: WIDTH, height: REST_H });
      clearTimeout(nextTimer); nextTimer = setTimeout(next, 300);
      return;
    }
    const look = chatLook(height);
    api.send('size', { width: WIDTH, height: Math.max(REST_H, TOP + height + 32) });
    shape.classList.add('snap');
    grow('chat', width, height, look.radius, look.color);
    render();
    void shape.offsetWidth;
    shape.classList.remove('snap');
    toBar(); // after the reflow above, so the shrink animates from the chat's size
  }

  // ─── pings: a glow, the card with the text, then the next one ─────────────
  const free = () => (S.voice === 'idle' || S.voice === 'teaching') && !S.attached && !wordsUp;

  // ─── Orbit's words: a card under the line with what it heard and what it says ──
  let wordsUp = false;
  function words(w) {
    const card = $('say');
    if (w.clear) {
      card.classList.remove('on');
      wordsUp = false;
      setTimeout(() => { if (!wordsUp) { $('heard').textContent = ''; $('said').textContent = ''; api.send('size', { width: WIDTH, height: REST_H }); clearTimeout(nextTimer); nextTimer = setTimeout(next, 200); } }, 220);
      return;
    }
    if (w.heard !== undefined) { $('heard').textContent = w.heard; $('said').textContent = ''; }
    if (w.hint !== undefined) $('hint').textContent = w.hint;
    if (w.say) $('said').textContent = `${$('said').textContent} ${w.say}`.trim();
    $('said').classList.toggle('note', !!w.note);
    if (!$('heard').textContent && !$('said').textContent) return;
    shelve();
    wordsUp = true;
    // Room for the card first (the window grows down, measured once the new text is laid out), then it shows.
    requestAnimationFrame(() => { sizeForWords(); card.classList.add('on'); });
  }
  // The window as tall as the card and its shadow; again whenever the card's text makes it grow.
  function sizeForWords() {
    const card = $('say');
    if (wordsUp) api.send('size', { width: WIDTH, height: Math.max(REST_H, card.offsetTop + card.offsetHeight + 40) });
  }
  new ResizeObserver(() => sizeForWords()).observe($('say'));
  function next() {
    if (ping || !queue.length || !free() || shapeIs() !== 'bar') return;
    ping = queue.shift();
    replay('pinging', GLOW_MS);
    clearTimeout(glowTimer);
    glowTimer = setTimeout(showCard, GLOW_MS - 120);
  }
  function showCard() {
    if (!ping) return;
    const text = ping.text || ping.title;
    msg.textContent = text;
    measure.textContent = text;
    // The logo on the left (28px, island.css), the text beside it; the card grows as tall as the text, three lines at most.
    const w = Math.round(Math.max(200, Math.min(CARD_W, Math.ceil(measure.offsetWidth) + CARD_TEXT_X + 18)));
    const h = Math.round(Math.max(52, Math.min(measure.offsetHeight, 63) + 26));
    grow('popup', w, h, 22);
    settle('popup', w, h);
    clearTimeout(textTimer);
    textTimer = setTimeout(() => { body.classList.add('text'); shown = true; render(); stay(POP_MS); }, MORPH_MS - 80);
  }
  function stay(ms) {
    clearTimeout(stayTimer);
    stayTimer = overHit || overShape ? null : setTimeout(() => endCard(true), ms);
  }
  // The text fades, then the card shrinks back into the line; the next ping follows.
  function endCard(timedOut) {
    clearTimeout(glowTimer); clearTimeout(textTimer); clearTimeout(stayTimer);
    if (!ping) return;
    if (timedOut) api.send('ping-done', { id: ping.id });
    ping = null; shown = false; overShape = false;
    body.classList.remove('text');
    render();
    setTimeout(() => { if (shapeIs() === 'popup') toBar(); }, TEXT_OUT_MS);
  }
  // Orbit or the chat took over: a ping still playing goes back to the front of the line.
  function shelve() {
    if (!ping) return;
    clearTimeout(glowTimer); clearTimeout(textTimer); clearTimeout(stayTimer);
    queue.unshift(ping); ping = null; shown = false;
    body.classList.remove('pinging', 'text');
    if (shapeIs() === 'popup') toBar();
  }

  // The window only needs the mouse while it's over the line or the card.
  let wasOver = false;
  function hovered() {
    const on = overHit || overShape;
    body.classList.toggle('hover', overHit);
    if (on === wasOver) return;
    wasOver = on;
    api.send('hover', { on });
    if (shown) { if (on) { clearTimeout(stayTimer); stayTimer = null; } else stay(POP_MS); }
  }

  // ─── wiring ───────────────────────────────────────────────────────────────
  function start() {
    api = window.islandApi;
    body = document.body; shape = $('shape'); msg = $('msg'); measure = $('measure');
    const wave = $('wave');
    for (let i = 0; i < BARS; i++) bars.push(wave.appendChild(document.createElement('i')));
    if (!api) { render(); return; } // opened on its own: just the line at rest
    api.send('size', { width: WIDTH, height: REST_H });

    api.on('state', (st) => {
      if (!st) return;
      const was = free();
      const wasAttached = S.attached;
      const voice = ['listening', 'thinking', 'speaking', 'teaching'].includes(st.voice) ? st.voice : 'idle';
      if (voice === 'listening' && S.voice !== 'listening') target = 0;
      S.voice = voice;
      S.running = Math.max(0, Number(st.running) || 0);
      S.title = String(st.title || '');
      S.attached = !!st.attached;
      body.classList.toggle('under', !!st.under); // an app covers the top: the resting line fades (island.css)
      // Just clicked open: the drop's window is still on its way, so stay out of sight meanwhile.
      S.covered = !!st.covered || Date.now() - openedAt < 600;
      if (st.chat && st.chat.width > 0 && st.chat.height > 0) S.chat = { width: Number(st.chat.width), height: Number(st.chat.height) };
      if (!free()) shelve();
      // Up without the shape having grown into it (opened some other way): be its size, out of sight, so closing shrinks from it.
      if (S.covered && shapeIs() !== 'chat') {
        clearTimeout(morphTimer);
        const look = chatLook(S.chat.height);
        api.send('size', { width: WIDTH, height: Math.max(REST_H, TOP + S.chat.height + 32) });
        shape.classList.add('snap');
        grow('chat', S.chat.width, S.chat.height, look.radius, look.color);
        void shape.offsetWidth;
        shape.classList.remove('snap');
      }
      render();
      // Gone without a 'blur' first: shrink back anyway.
      if (wasAttached && !S.attached && shapeIs() === 'chat') toBar();
      if (free() && !was) { clearTimeout(nextTimer); nextTimer = setTimeout(next, 300); }
    });
    api.on('words', (w) => { if (w) words(w); });
    api.on('level', (d) => {
      const v = Math.min(1, Math.max(0, Number(d && d.v) || 0));
      if (v > target) target = v;
    });
    api.on('ping', (p) => {
      if (!p || (!p.text && !p.title)) return;
      queue.push({ id: p.id, title: String(p.title || 'Codeply'), text: String(p.text || '') });
      next();
    });
    api.on('blur', (d) => { if (shapeIs() === 'chat' || S.attached) closeChat(d); });

    // The line: grows into the chat (or, if the chat is up, closes it).
    $('hit').addEventListener('click', () => {
      api.send('click', {});
      if (!S.attached && shapeIs() === 'bar') { shelve(); toChat(); }
    });
    // The message card: grows on into the chat, opened on what the message is about.
    shape.addEventListener('click', () => {
      if (shapeIs() !== 'popup' || !ping) return;
      const { id } = ping;
      clearTimeout(glowTimer); clearTimeout(textTimer); clearTimeout(stayTimer);
      ping = null; shown = false; overShape = false; hovered();
      api.send('ping-click', { id });
      toChat();
    });
    $('hit').addEventListener('mouseenter', () => { overHit = true; hovered(); });
    $('hit').addEventListener('mouseleave', () => { overHit = false; hovered(); });
    shape.addEventListener('mouseenter', () => { if (shapeIs() === 'popup') { overShape = true; hovered(); } });
    shape.addEventListener('mouseleave', () => { overShape = false; hovered(); });
    render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
