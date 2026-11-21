// One screen's voice overlay: the buddy, its bubble and what it draws.
// The overlay on the main screen also owns the mic and plays the voice.
(() => {
  const api = window.voice;
  const q = new URLSearchParams(location.search);
  const DISPLAY = q.get('display');
  const AUDIO = q.get('audio') === '1';
  const $ = (id) => document.getElementById(id);
  const buddy = $('buddy'); const pill = $('pill'); const note = $('note'); const label = $('label'); const knotEl = $('knot');
  const bubble = $('bubble'); const textEl = $('text'); const heard = $('heard'); const turnEl = $('turn'); const hint = $('hint');
  const ink = $('ink'); const drawings = $('drawings');
  const bars = [...document.querySelectorAll('#wave i')];
  const SVGNS = 'http://www.w3.org/2000/svg';

  // ─── Buddy motion ─────────────────────────────────────────────────────────
  const pos = { x: -100, y: -100 }; const target = { x: -100, y: -100 };
  let flight = null;      // { from, to, c, t0, ms } while flying to a point
  let shown = false;
  let detached = false;   // after you let go: the buddy is its own cursor

  // Keep a piece (pill, label, bubble) fully on screen: it sits at (ox, oy) from
  // the cursor tip, flips to the other side when there's no room, and squeezes in last.
  function fit(el, x, y, ox, oy, gap) {
    if (el.hidden) return;
    const w = el.offsetWidth; const h = el.offsetHeight;
    let left = ox; let top = oy;
    if (x + left + w > innerWidth - 8) left = x - w - gap >= 8 ? -w - gap : innerWidth - 8 - w - x;
    if (x + left < 8) left = 8 - x;
    if (y + top + h > innerHeight - 8) top = y - h - gap >= 8 ? -h - gap : innerHeight - 8 - h - y;
    if (y + top < 8) top = 8 - y;
    el.style.left = `${Math.round(left)}px`; el.style.top = `${Math.round(top)}px`;
  }
  // ─── Where the bubble goes ────────────────────────────────────────────────
  // Never on top of what it's explaining: it tries spots around the cursor and
  // the screen's corners, takes the one that covers the least of its drawings,
  // and glides there. Once you drag it, it stays where you put it.
  document.body.appendChild(bubble);
  bubble.classList.add('free');
  let bPos = null; let bChoice = -1; let pinned = null; let lastSent = '';
  const overlap = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  function avoidRects() {
    const out = [];
    for (const el of drawings.children) {
      try { const b = el.getBBox(); if (b.width || b.height) out.push({ x: b.x - 14, y: b.y - 14, w: b.width + 28, h: b.height + 28 }); } catch {}
    }
    document.querySelectorAll('[data-drawing]').forEach((n) => { const r = n.getBoundingClientRect(); out.push({ x: r.left - 8, y: r.top - 8, w: r.width + 16, h: r.height + 16 }); });
    if (!label.hidden) { const r = label.getBoundingClientRect(); out.push({ x: r.left - 6, y: r.top - 6, w: r.width + 12, h: r.height + 12 }); }
    out.push({ x: pos.x - 8, y: pos.y - 8, w: 34, h: 40 }); // the cursor itself
    return out;
  }
  function placeBubble(x, y) {
    const w = bubble.offsetWidth; const h = bubble.offsetHeight; const W = innerWidth; const H = innerHeight; const m = 12;
    let tx; let ty;
    if (pinned) { tx = pinned.x; ty = pinned.y; } else {
      const cands = [
        [x + 22, y + (label.hidden ? 22 : 54), 0], [x + 22, y - h - 14, 0], [x - w - 14, y + 22, 0], [x - w - 14, y - h - 14, 0],
        [m, m, 1], [W - w - m, m, 1], [m, H - h - m, 1], [W - w - m, H - h - m, 1],
      ];
      const avoid = avoidRects();
      let best = 0; let bestScore = Infinity; const scores = [];
      cands.forEach((c, i) => {
        c[0] = Math.max(m, Math.min(W - w - m, c[0])); c[1] = Math.max(m, Math.min(H - h - m, c[1]));
        const r = { x: c[0], y: c[1], w, h };
        let s = 0; for (const a of avoid) s += overlap(r, a);
        s = s * 4 + Math.hypot(c[0] + w / 2 - x, c[1] + h / 2 - y) * 0.6 + (c[2] ? 120 : 0);
        scores[i] = s;
        if (s < bestScore) { bestScore = s; best = i; }
      });
      if (bChoice >= 0 && scores[bChoice] <= bestScore + 60) best = bChoice; // no jumping around
      bChoice = best;
      [tx, ty] = cands[best];
    }
    if (!bPos) bPos = { x: tx, y: ty };
    bPos.x += (tx - bPos.x) * (pinned ? 1 : 0.22);
    bPos.y += (ty - bPos.y) * (pinned ? 1 : 0.22);
    bubble.style.left = `${Math.round(bPos.x)}px`; bubble.style.top = `${Math.round(bPos.y)}px`;
    // Tell the main process where it is, so the mouse can grab it there (and only there).
    // Hidden (the top bar is on and it isn't pointing at anything): it never catches the mouse.
    if (getComputedStyle(bubble).visibility === 'hidden') { if (lastSent) { lastSent = ''; api.send('bubble-rect', { display: DISPLAY, none: true }); } return; }
    const key = `${Math.round(bPos.x)},${Math.round(bPos.y)},${w},${h}`;
    if (key !== lastSent) { lastSent = key; api.send('bubble-rect', { display: DISPLAY, x: bPos.x, y: bPos.y, w, h }); }
  }
  function bubbleGone() {
    bPos = null; bChoice = -1; pinned = null;
    if (lastSent) { lastSent = ''; api.send('bubble-rect', { display: DISPLAY, none: true }); }
  }
  // Drag it anywhere.
  let drag = null;
  bubble.addEventListener('pointerdown', (e) => {
    if (!bPos) return;
    drag = { dx: e.clientX - bPos.x, dy: e.clientY - bPos.y };
    bubble.setPointerCapture(e.pointerId);
    bubble.classList.add('dragging');
    e.stopPropagation();
  });
  bubble.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const w = bubble.offsetWidth; const h = bubble.offsetHeight;
    pinned = { x: Math.max(4, Math.min(innerWidth - w - 4, e.clientX - drag.dx)), y: Math.max(4, Math.min(innerHeight - h - 4, e.clientY - drag.dy)) };
  });
  const endDrag = () => { drag = null; bubble.classList.remove('dragging'); };
  bubble.addEventListener('pointerup', endDrag);
  bubble.addEventListener('pointercancel', endDrag);

  function place(x, y) {
    buddy.style.transform = `translate(${x}px, ${y}px)`;
    if (!shown) return;
    if (detached) {
      fit(pill, x, y, 22, 22, 10);
      fit(label, x, y, 22, 22, 10);
      if (!bubble.hidden) placeBubble(x, y);
    } else {
      fit(knotEl, x, y, 16, 18, 10);
      fit(pill, x, y, parseFloat(knotEl.style.left) + 32, parseFloat(knotEl.style.top) + 1, 12);
    }
  }
  const clampX = (x) => Math.max(4, Math.min(innerWidth - 22, x));
  const clampY = (y) => Math.max(4, Math.min(innerHeight - 28, y));
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  function frame(now) {
    if (flight) {
      const t = Math.min(1, (now - flight.t0) / flight.ms);
      const e = ease(t);
      // a gentle arc, not a straight line
      const x = (1 - e) * (1 - e) * flight.from.x + 2 * (1 - e) * e * flight.c.x + e * e * flight.to.x;
      const y = (1 - e) * (1 - e) * flight.from.y + 2 * (1 - e) * e * flight.c.y + e * e * flight.to.y;
      pos.x = x; pos.y = y;
      if (t >= 1) { flight.done(); flight = null; }
    } else {
      pos.x += (target.x - pos.x) * 0.32;
      pos.y += (target.y - pos.y) * 0.32;
    }
    place(pos.x, pos.y);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  function showBuddy() {
    if (shown) return;
    shown = true;
    buddy.hidden = false; buddy.classList.remove('faded');
    pos.x = target.x; pos.y = target.y;
    requestAnimationFrame(() => buddy.classList.add('on'));
  }
  function hideBuddy() {
    shown = false; flight = null;
    detached = false;
    buddy.classList.remove('on', 'listening', 'thinking', 'speaking', 'arrived', 'your-turn', 'detached', 'working', 'moving');
    bubble.classList.remove('on'); bubble.hidden = true; label.hidden = true;
    buddy.hidden = true;
    bubbleGone();
  }

  function detach() {
    if (detached) return;
    detached = true;
    buddy.classList.add('detached');
  }

  // The second cursor's tip lands on (x, y).
  function flyTo(x, y, text, ms, quiet) {
    showBuddy();
    detach();
    const to = { x: clampX(x), y: clampY(y) }; // never off the edge of the screen
    if (!quiet) buddy.classList.remove('thinking', 'working'); // moving to act or point: the arrow is back
    const from = { x: pos.x, y: pos.y };
    const dx = to.x - from.x; const dy = to.y - from.y;
    const dist = Math.hypot(dx, dy);
    const c = { x: (from.x + to.x) / 2 - dy * 0.18, y: (from.y + to.y) / 2 + dx * 0.18 - Math.min(120, dist * 0.15) };
    buddy.classList.remove('arrived');
    buddy.classList.add('moving'); // with the top bar on, the arrow only shows while it's doing something (overlay.css)
    label.hidden = true;
    flight = {
      from, to, c, t0: performance.now(), ms: ms || Math.max(380, Math.min(900, 300 + dist * 0.45)),
      done: () => {
        buddy.classList.remove('moving');
        target.x = to.x; target.y = to.y;
        if (!quiet) buddy.classList.add('arrived');
        if (text) { label.textContent = text; label.hidden = false; }
      },
    };
  }

  // ─── Bubble ───────────────────────────────────────────────────────────────
  let revealTimer = null;
  const pendingWords = [];
  // Words, and $formulas$ drawn as real math (KaTeX), each one a unit that fades in.
  function tokens(text) {
    const out = [];
    let spaceBefore = false; // glue "." or "," straight onto a formula
    String(text).split(/(\$[^$]+\$)/).forEach((part) => {
      if (!part) return;
      if (part.length > 2 && part[0] === '$' && part[part.length - 1] === '$') {
        let html = '';
        try { html = window.katex ? window.katex.renderToString(part.slice(1, -1), { throwOnError: false }) : ''; } catch {}
        out.push({ html: html || null, text: part.slice(1, -1), glue: out.length > 0 && !spaceBefore });
        spaceBefore = false;
      } else {
        part.split(/\s+/).filter(Boolean).forEach((w, i) => out.push({ text: w, glue: i === 0 && out.length > 0 && !/^\s/.test(part) }));
        spaceBefore = /\s$/.test(part);
      }
    });
    return out;
  }
  function say(text, isNote) {
    detach();
    buddy.classList.remove('listening', 'thinking', 'working');
    buddy.classList.add('speaking');
    bubble.hidden = false;
    requestAnimationFrame(() => bubble.classList.add('on'));
    textEl.classList.toggle('note', !!isNote);
    // Each word lands in grey and settles to white, at about the pace it's spoken.
    for (const t of tokens(text)) {
      const s = document.createElement('span');
      s.className = 'w';
      if (t.html) s.innerHTML = t.html; else s.textContent = t.text;
      if (t.glue && textEl.lastChild && textEl.lastChild.nodeType === 3) textEl.lastChild.remove();
      textEl.appendChild(s);
      textEl.appendChild(document.createTextNode(' '));
      pendingWords.push(s);
    }
    if (!revealTimer) revealTimer = setInterval(() => {
      const w = pendingWords.shift();
      if (w) { w.classList.add('in'); textEl.scrollTop = textEl.scrollHeight; } else { clearInterval(revealTimer); revealTimer = null; }
    }, 300);
  }
  function clearBubble() {
    textEl.innerHTML = ''; heard.textContent = ''; pendingWords.length = 0; turnEl.hidden = true;
    clearInterval(revealTimer); revealTimer = null;
    bubble.classList.remove('on'); bubble.hidden = true;
    bubbleGone();
  }

  // ─── Drawings ─────────────────────────────────────────────────────────────
  function svg(tag, attrs) {
    const el = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  }
  function drawOn(el) {
    drawings.appendChild(el);
    const len = el.getTotalLength ? el.getTotalLength() : 0;
    if (len) { el.style.strokeDasharray = len; el.style.strokeDashoffset = len; el.classList.add('draw'); }
  }
  function arrow(a, b) {
    const dx = b[0] - a[0]; const dy = b[1] - a[1];
    const mx = (a[0] + b[0]) / 2 - dy * 0.15; const my = (a[1] + b[1]) / 2 + dx * 0.15;
    // stop just short of the target so the head doesn't cover it
    const L = Math.hypot(dx, dy) || 1; const ex = b[0] - (dx / L) * 10; const ey = b[1] - (dy / L) * 10;
    drawOn(svg('path', { class: 'arrow', d: `M${a[0]},${a[1]} Q${mx},${my} ${ex},${ey}`, 'marker-end': 'url(#head)' }));
  }
  function circle(c, r) {
    const el = svg('ellipse', { class: 'ring pulse', cx: c[0], cy: c[1], rx: r * 1.12, ry: r });
    drawOn(el);
  }
  function box(b) {
    drawings.appendChild(svg('rect', { class: 'box fade-in', x: b.x - 4, y: b.y - 4, width: b.w + 8, height: b.h + 8, rx: 8 }));
    if (b.label) tag(b.label, b.x, b.y + b.h + 10);
  }
  function tag(text, x, y) {
    const t = document.createElement('div');
    t.className = 'tag'; t.textContent = text;
    t.style.left = `${Math.min(innerWidth - 220, Math.max(8, x))}px`; t.style.top = `${Math.min(innerHeight - 40, y)}px`;
    t.dataset.drawing = '1';
    document.body.appendChild(t);
  }
  function clearDrawings() {
    drawings.innerHTML = '';
    document.querySelectorAll('[data-drawing]').forEach((n) => n.remove());
  }

  // ─── Circling things while talking ────────────────────────────────────────
  let stroke = null;
  addEventListener('pointerdown', (e) => {
    if (e.target.closest('.bubble')) return;
    stroke = { pts: [[e.clientX, e.clientY]], el: svg('path', { class: 'stroke', d: `M${e.clientX},${e.clientY}` }) };
    drawings.appendChild(stroke.el);
  });
  addEventListener('pointermove', (e) => {
    if (!stroke) return;
    stroke.pts.push([e.clientX, e.clientY]);
    stroke.el.setAttribute('d', 'M' + stroke.pts.map((p) => p.join(',')).join(' L'));
  });
  addEventListener('pointerup', () => {
    if (!stroke) return;
    const xs = stroke.pts.map((p) => p[0]); const ys = stroke.pts.map((p) => p[1]);
    const box = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    if (box.w > 8 || box.h > 8) api.send('stroke', { display: DISPLAY, box });
    else stroke.el.remove();
    stroke = null;
  });

  // ─── Mic (main screen only) ───────────────────────────────────────────────
  const mic = { stream: null, ctx: null, node: null, chunks: [], live: false, rate: 48000, lastLevel: 0, arming: null };
  async function micArm() {
    if (mic.arming) return mic.arming;
    mic.chunks = []; mic.live = false;
    mic.arming = (async () => {
      try {
        mic.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        mic.ctx = new AudioContext();
        mic.rate = mic.ctx.sampleRate;
        await mic.ctx.audioWorklet.addModule('mic-worklet.js');
        const src = mic.ctx.createMediaStreamSource(mic.stream);
        mic.node = new AudioWorkletNode(mic.ctx, 'mic-tap');
        mic.node.port.onmessage = (ev) => {
          const ch = ev.data;
          mic.chunks.push(ch);
          if (!mic.live) return;
          let sum = 0; for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
          const rms = Math.sqrt(sum / ch.length);
          const now = performance.now();
          if (now - mic.lastLevel > 33) { mic.lastLevel = now; api.send('level', { v: Math.min(1, rms * 9) }); }
        };
        src.connect(mic.node);
      } catch (e) {
        api.send('mic-error', { error: e && e.name === 'NotAllowedError' ? 'the microphone is blocked. Allow it for Codeply in your system settings.' : (e && e.message) || 'no microphone' });
        micRelease();
      }
    })();
    return mic.arming;
  }
  function micRelease() {
    try { if (mic.node) mic.node.port.onmessage = null; } catch {}
    try { if (mic.stream) mic.stream.getTracks().forEach((t) => t.stop()); } catch {}
    try { if (mic.ctx) mic.ctx.close(); } catch {}
    mic.stream = null; mic.ctx = null; mic.node = null; mic.live = false; mic.arming = null;
  }
  // The mic's own rate down to the 16 kHz mono Whisper wants.
  function to16k(chunks, rate) {
    let n = 0; for (const c of chunks) n += c.length;
    const all = new Float32Array(n); let o = 0;
    for (const c of chunks) { all.set(c, o); o += c.length; }
    if (rate === 16000) return all;
    const ratio = rate / 16000; const out = new Float32Array(Math.floor(n / ratio));
    for (let i = 0; i < out.length; i++) {
      const p = i * ratio; const j = Math.floor(p); const f = p - j;
      out[i] = all[j] * (1 - f) + (all[j + 1] || 0) * f;
    }
    return out;
  }

  // ─── Voice playback (main screen only) ────────────────────────────────────
  let player = null;
  function play(m) {
    stopAudio();
    const url = URL.createObjectURL(new Blob([m.data], { type: m.mime || 'audio/mpeg' }));
    const a = new Audio(url);
    player = { a, id: m.id, url };
    const done = () => { if (player && player.a === a) { URL.revokeObjectURL(url); player = null; } api.send('played', { id: m.id }); };
    a.onended = done; a.onerror = done;
    a.play().catch(done);
  }
  function stopAudio() {
    if (!player) return;
    const p = player; player = null;
    try { p.a.pause(); } catch {}
    URL.revokeObjectURL(p.url);
    api.send('played', { id: p.id });
  }

  // ─── Commands from voice-mode.js ──────────────────────────────────────────
  api.on(async (m) => {
    switch (m.type) {
      case 'cursor':
        if (flight || detached) break;
        target.x = m.x; target.y = m.y;
        if (pos.x < -50) { pos.x = target.x; pos.y = target.y; }
        if (!shown) showBuddy();
        buddy.classList.remove('arrived'); label.hidden = true;
        break;
      case 'mode':
        showBuddy();
        buddy.classList.remove('listening', 'thinking', 'speaking', 'your-turn', 'working');
        buddy.classList.add(m.mode);
        // The top bar shows the waveform and the words instead. A mode without `bar`
        // (mid-task "working") keeps the last setting. The bubble lives outside the
        // buddy (see above), so it hides by the body's class.
        if ('bar' in m) { buddy.classList.toggle('bar-on', !!m.bar); document.body.classList.toggle('bar-on', !!m.bar); }
        note.textContent = m.note || ''; note.classList.toggle('on', !!m.note);
        buddy.classList.toggle('has-note', !!m.note); // "Getting voice ready…" keeps its pill while loading
        if (m.hint) hint.textContent = m.hint;
        if (m.mode === 'listening') {
          detached = false; buddy.classList.remove('detached', 'arrived');
          pos.x = -100; // snap to the cursor on its next move, no swoop in from the corner
 clearBubble(); bars.forEach((b) => { b.style.height = '4px'; }); document.body.classList.add('catching'); }
        else document.body.classList.remove('catching');
        break;
      case 'level': {
        const v = m.v || 0;
        bars.forEach((b, i) => {
          const shape = 0.45 + 0.55 * Math.sin(((i + 1) / (bars.length + 1)) * Math.PI);
          const jitter = 0.75 + Math.random() * 0.5;
          b.style.height = `${Math.max(4, Math.min(18, 4 + v * 12 * shape * jitter))}px`;
        });
        break;
      }
      case 'catch': document.body.classList.toggle('catching', !!m.on); if (!m.on) stroke = null; break;
      case 'heard': heard.textContent = m.text; break;
      case 'say': say(m.text, m.note); break;
      case 'your-turn': turnEl.hidden = false; buddy.classList.add('your-turn'); break;
      case 'detach': {
        // Step off your cursor toward the middle of the screen, so it never ends up past an edge.
        showBuddy();
        const dx = pos.x > innerWidth - 220 ? -34 : 26;
        const dy = pos.y > innerHeight - 200 ? -40 : 24;
        flyTo(pos.x + dx, pos.y + dy, null, 260, true);
        break;
      }
      case 'point': flyTo(m.x, m.y, m.label); break;
      case 'arrow': arrow(m.from, m.to); break;
      case 'circle': circle(m.at, m.r); break;
      case 'box': box(m); break;
      case 'home': label.hidden = true; buddy.classList.remove('arrived'); break;
      case 'clear': clearBubble(); clearDrawings(); break;
      case 'clear-drawings': clearDrawings(); label.hidden = true; buddy.classList.remove('arrived', 'your-turn'); turnEl.hidden = true; break;
      case 'buddy-hide': hideBuddy(); break;
      case 'fade':
        buddy.classList.add('faded');
        ink.style.transition = 'opacity .35s ease'; ink.style.opacity = '0';
        document.querySelectorAll('[data-drawing]').forEach((n) => { n.style.transition = 'opacity .35s'; n.style.opacity = '0'; });
        setTimeout(() => { hideBuddy(); clearBubble(); clearDrawings(); ink.style.opacity = ''; }, 400);
        break;
      // audio, main screen only
      case 'mic-arm': if (AUDIO) micArm(); break;
      case 'mic-start': if (AUDIO) { await micArm(); mic.live = true; } break;
      case 'mic-cancel': if (AUDIO) { mic.chunks = []; micRelease(); } break;
      case 'mic-stop':
        if (!AUDIO) break;
        await (mic.arming || Promise.resolve());
        // a beat for the last syllable to arrive
        await new Promise((r) => setTimeout(r, 120));
        { const pcm = to16k(mic.chunks, mic.rate); mic.chunks = []; micRelease(); api.send('pcm', { id: m.id, pcm }); }
        break;
      case 'play': if (AUDIO) play(m); break;
      case 'stop-audio': if (AUDIO) stopAudio(); break;
      default: break;
    }
  });
})();
