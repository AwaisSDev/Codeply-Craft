// Wisp: a soft blue pentagon with eyes, the same character as on codeply.app/wisp.
// The eyes follow your cursor and blink, the body breathes and morphs between
// shapes, and the mood changes the eyes, the colour and how it moves.
// Drawn in SVG, one animation loop for every Wisp in the window.
//
//   CraftWisp.mount(el, { size: 'lg'|'md'|'sm'|'xs', mood, shape, color, morph, look })
//     -> el.wisp: setMood(m, keepShape), setShape(name), setColor('#hex'|null),
//        dress(look|null, fun), talk(ms), boop(), lookAt({x,y}|null), destroy()
//   look: { shape, color, gear } is a specialist's own character (a beret, shades, a
//   sprout...); dress(look, true) is the costume change: a spin, a poof, a new face.
//   CraftWisp.read(text) -> { mood, shape|null, line }   what a message feels like
//
// Wisp is a pentagon everywhere: a mood changes its eyes, colour and how it
// moves, never its shape. Only the home screen's Wisp (morph: true, like the
// "Meet Wisp" demo on the website) takes a shape from a mood or a topic, and
// goes back to the pentagon after.
(function () {
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var N = 144, TAU = Math.PI * 2, CX = 50, CY = 54, R = 40;
  var NS = 'http://www.w3.org/2000/svg';

  // ---- shapes: a radius for every angle, all with N points so any two can morph ----
  function smooth(r, w) {
    if (w < 2) return r;
    var out = [], h = Math.floor(w / 2);
    for (var i = 0; i < N; i++) { var s = 0; for (var k = -h; k <= h; k++) s += r[(i + k + N) % N]; out.push(s / (2 * h + 1)); }
    return out;
  }
  function norm(r) { var m = Math.max.apply(null, r); return r.map(function (v) { return v / m; }); }
  function polar(fn, w) { var r = []; for (var i = 0; i < N; i++) r.push(fn(-Math.PI / 2 + TAU * i / N)); return norm(smooth(r, w)); }
  function poly(n, turn) {
    return function (t) { var seg = TAU / n, phi = ((t + Math.PI / 2 - (turn || 0)) % seg + seg) % seg - seg / 2; return Math.cos(Math.PI / n) / Math.cos(phi); };
  }
  // A heart, sampled from its parametric curve and turned into a radius per angle.
  function heart() {
    var pts = [], M = 720;
    for (var i = 0; i < M; i++) {
      var t = TAU * i / M;
      var x = 16 * Math.pow(Math.sin(t), 3);
      var y = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) + 1.5;
      pts.push([Math.atan2(y, x), Math.hypot(x, y)]);
    }
    pts.sort(function (a, b) { return a[0] - b[0]; });
    return function (a) {
      a = Math.atan2(Math.sin(a), Math.cos(a));
      var lo = 0, hi = pts.length - 1;
      while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (pts[mid][0] < a) lo = mid; else hi = mid; }
      var p = pts[lo], q = pts[hi], span = q[0] - p[0] || 1;
      return p[1] + (q[1] - p[1]) * Math.min(1, Math.max(0, (a - p[0]) / span));
    };
  }
  var SHAPES = {
    pentagon: polar(poly(5), 11),
    circle: polar(function () { return 1; }, 1),
    square: polar(poly(4, Math.PI / 4), 13),
    triangle: polar(poly(3), 15),
    hexagon: polar(poly(6), 11),
    star: polar(function (t) { return .8 + .2 * Math.cos(5 * (t + Math.PI / 2)); }, 5),
    spiky: polar(function (t) { var c = Math.cos(8 * (t + Math.PI / 2)); return .84 + .16 * Math.sign(c) * Math.pow(Math.abs(c), .6); }, 3),
    blob: polar(function (t) { return 1 + .07 * Math.sin(3 * t + 1) + .05 * Math.cos(5 * t - .4); }, 5),
    cloud: polar(function (t) { return .9 + .1 * Math.abs(Math.cos(3.5 * (t + Math.PI / 2))); }, 5),
    heart: polar(heart(), 7)
  };

  // ---- moods: eyes, a shape for the morphing Wisp, a colour, and how it moves ----
  var MOODS = {
    neutral: { shape: 'pentagon', c: ['#74a6ff', '#1f52e0'], blink: true },
    happy: { shape: 'circle', c: ['#7fb2ff', '#2a5fea'], bounce: true },
    excited: { shape: 'star', c: ['#86b9ff', '#2f6bff'], bounce: true, fast: true },
    proud: { shape: 'pentagon', c: ['#7cb0ff', '#2457e6'], puff: true },
    love: { shape: 'heart', c: ['#ff9ec4', '#e0457f'], bounce: true },
    sad: { shape: 'pentagon', c: ['#9db2e6', '#4e66b4'], blink: true, sag: true },
    angry: { shape: 'spiky', c: ['#ff8f7a', '#e0304a'], shake: true },
    sleepy: { shape: 'blob', c: ['#9fb4e8', '#4c64b8'], doze: true },
    surprised: { shape: 'pentagon', c: ['#8ab8ff', '#2f6bff'], blink: true, hop: true },
    thinking: { shape: 'pentagon', c: ['#86b0ff', '#3a5fe0'], blink: true },
    worried: { shape: 'pentagon', c: ['#8fb0ee', '#3d5bc4'], blink: true, tremble: true },
    working: { shape: 'pentagon', c: ['#7aaeff', '#1f5af0'], blink: true, busy: true },
    listening: { shape: 'pentagon', c: ['#7eb0ff', '#2457e6'], blink: true, lean: true }
  };
  var INK = '#0b0b0f';
  // ---- gear: what a specialist wears. Head gear is drawn for a head whose top is at y=14
  // (moved to the real top every frame); face gear sits on the eyes and follows them. ----
  var HEAD_GEAR = {
    beret: '<ellipse cx="46" cy="15" rx="21" ry="7.5" fill="#b8324a" transform="rotate(-12 46 15)"/><ellipse cx="42" cy="12.6" rx="9" ry="2.2" fill="#fff" fill-opacity=".22" transform="rotate(-12 42 12.6)"/><circle cx="46" cy="7.2" r="2.4" fill="#8f2236"/>',
    cap: '<path d="M29 21C30 8 70 8 71 21Z" fill="#2f5bd8"/><path d="M66 19.5C76 17.5 84 19 86 23C78 24.6 70 24 63 22Z" fill="#2348b5"/><circle cx="50" cy="9.6" r="1.8" fill="#2348b5"/>',
    bow: '<path d="M63 14L52 7.5L53.5 21.5Z M63 14L74 7.5L72.5 21.5Z" fill="#ff5fa8"/><circle cx="63" cy="14" r="3.2" fill="#e23d8a"/>',
    flower: '<g transform="translate(36 15)"><circle cy="-5" r="3.6" fill="#fff"/><circle cx="4.8" cy="-1.5" r="3.6" fill="#fff"/><circle cx="3" cy="4" r="3.6" fill="#fff"/><circle cx="-3" cy="4" r="3.6" fill="#fff"/><circle cx="-4.8" cy="-1.5" r="3.6" fill="#fff"/><circle r="2.6" fill="#ffc83d"/></g>',
    sprout: '<path d="M50 16C50 10 51 6 52 3" fill="none" stroke="#3d9e3f" stroke-width="2" stroke-linecap="round"/><path d="M52 5C56 -1 63 0 64 2C60 6 55 7 52 5Z" fill="#5cc45a"/><path d="M51 7C47 2 41 3 40 5C43 9 48 9 51 7Z" fill="#4db34b"/>',
    antennae: '<path d="M43 17C41 10 37 6 33 4 M57 17C59 10 63 6 67 4" fill="none" stroke="#9a9ab4" stroke-width="1.9" stroke-linecap="round"/><circle cx="33" cy="4" r="3.6" fill="#fff"/><circle cx="67" cy="4" r="3.6" fill="#fff"/><circle cx="33.6" cy="4.4" r="1.7" fill="#0b0b0f"/><circle cx="67.6" cy="4.4" r="1.7" fill="#0b0b0f"/>',
    star: '<path d="M66 7l2.2 4.5 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5-3.6-3.5 5-.7z" fill="#ffd23f" stroke="#e8a900" stroke-width=".8"/>',
    crown: '<path d="M36 17L34 5L42 11L50 2L58 11L66 5L64 17Z" fill="#ffcf3a" stroke="#e0a400" stroke-width=".8" stroke-linejoin="round"/><circle cx="50" cy="12" r="1.6" fill="#ff5f7a"/>',
    headphones: '<path d="M15 50C15 20 30 10 50 10S85 20 85 50" fill="none" stroke="#2a2a33" stroke-width="5" stroke-linecap="round"/><path d="M15 50C15 20 30 10 50 10S85 20 85 50" fill="none" stroke="#ff8a5c" stroke-width="2.8" stroke-linecap="round"/><rect x="8.5" y="42" width="10" height="17" rx="4.5" fill="#ff8a5c" stroke="#2a2a33" stroke-width="1.2"/><rect x="81.5" y="42" width="10" height="17" rx="4.5" fill="#ff8a5c" stroke="#2a2a33" stroke-width="1.2"/>'
  };
  var FACE_GEAR = {
    glasses: '<g fill="rgba(255,255,255,.18)" stroke="#16161c" stroke-width="1.4"><circle cx="41" cy="44" r="5.6"/><circle cx="57" cy="44" r="5.6"/></g><path d="M46.6 43.4Q49 42 51.4 43.4" fill="none" stroke="#16161c" stroke-width="1.3"/>',
    shades: '<path d="M34.5 40.5h13l-1 6.2a3.6 3.6 0 0 1-3.5 3h-4.2a3.6 3.6 0 0 1-3.5-3z M50.5 40.5h13l-1 6.2a3.6 3.6 0 0 1-3.5 3h-4.2a3.6 3.6 0 0 1-3.5-3z" fill="#111116"/><path d="M47.5 41.6h3" stroke="#111116" stroke-width="1.4"/><path d="M37 42.5l3 0" stroke="#fff" stroke-opacity=".5" stroke-width="1" stroke-linecap="round"/>'
  };
  var EYES = {
    neutral: function () { return '<ellipse rx="1.8" ry="2.9"/>'; },
    thinking: function () { return '<ellipse rx="1.7" ry="2.7"/>'; },
    working: function () { return '<ellipse rx="1.7" ry="2.6"/>'; },
    listening: function () { return '<ellipse rx="2.1" ry="3.2"/><circle r=".7" cx=".7" cy="-1.1" fill="#fff"/>'; },
    surprised: function () { return '<circle r="2.9"/><circle r=".9" cx=".8" cy="-1" fill="#fff"/>'; },
    happy: function () { return '<path d="M-4.2 1.8Q0 -4.6 4.2 1.8" fill="none" stroke="' + INK + '" stroke-width="2.3" stroke-linecap="round"/>'; },
    excited: function () { return '<path d="M0 -3.6L1 -1L3.6 -.9L1.5 .8L2.2 3.4L0 1.9L-2.2 3.4L-1.5 .8L-3.6 -.9L-1 -1Z"/>'; },
    proud: function (s) { return '<path d="M-4 .6Q0 -3.2 4 .6" fill="none" stroke="' + INK + '" stroke-width="2.2" stroke-linecap="round"/>' + (s > 0 ? '<path d="M5.4 -6.4l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5z" fill="#fff" opacity=".9"/>' : ''); },
    love: function () { return '<path d="M0 3.2C-3.6 .6 -4.4 -1.2 -3.4 -2.6C-2.4 -3.8 -.8 -3.4 0 -2C.8 -3.4 2.4 -3.8 3.4 -2.6C4.4 -1.2 3.6 .6 0 3.2Z" fill="#fff"/>'; },
    sleepy: function () { return '<path d="M-4 0Q0 2.6 4 0" fill="none" stroke="' + INK + '" stroke-width="2.1" stroke-linecap="round"/>'; },
    // sorry: small eyes looking down, brows tilted up in the middle
    sad: function (s) { return '<ellipse rx="1.7" ry="2.5" cy="1.4"/><path d="' + (s < 0 ? 'M-4 -3.4L1.6 -5.6' : 'M4 -3.4L-1.6 -5.6') + '" fill="none" stroke="' + INK + '" stroke-width="1.5" stroke-linecap="round"/>'; },
    // worried: brows raised in the middle (not slanted down, which reads as angry)
    worried: function (s) { return '<ellipse rx="1.6" ry="2.4" cy=".6"/><path d="' + (s < 0 ? 'M-3.4 -3.5L1.4 -5.1' : 'M3.4 -3.5L-1.4 -5.1') + '" fill="none" stroke="' + INK + '" stroke-width="1.4" stroke-linecap="round"/>'; },
    angry: function (s) { return s < 0 ? '<path d="M-3.8 -2.2L3.6 .6L-3.2 2.2Z"/>' : '<path d="M3.8 -2.2L-3.6 .6L3.2 2.2Z"/>'; }
  };

  function hexToRgb(h) { var n = parseInt(String(h).slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function mix(h, t, k) { var a = hexToRgb(h), b = hexToRgb(t); return 'rgb(' + a.map(function (v, i) { return Math.round(v + (b[i] - v) * k); }).join(',') + ')'; }
  function tint(hex) { return [mix(hex, '#ffffff', .38), mix(hex, '#000000', .12)]; }

  var all = [], uid = 0, px = null, py = null, lastMove = 0, running = false;

  function make(el, opts) {
    opts = opts || {};
    var id = 'cwg' + (++uid);
    var size = opts.size || el.dataset.wisp || 'md';
    el.classList.add('wisp-el', 'wisp-' + size);
    el.innerHTML = '<svg viewBox="0 0 100 100" aria-hidden="true"><defs><linearGradient id="' + id + '" x1=".2" y1="0" x2=".8" y2="1"><stop offset="0"/><stop offset="1"/></linearGradient>' +
      '<radialGradient id="' + id + 'h" cx=".35" cy=".25" r=".6"><stop offset="0" stop-color="#fff" stop-opacity=".45"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs>' +
      '<g class="w-body"><path class="w-shape" fill="url(#' + id + ')"/><path class="w-shine" fill="url(#' + id + 'h)"/><g class="w-eyes"><g class="w-eye l" transform="translate(41 44)"></g><g class="w-eye r" transform="translate(57 44)"></g></g><g class="w-face-gear"></g><g class="w-head-gear"></g></g></svg>';
    var look = opts.look && SHAPES[opts.look.shape] ? opts.look : null;
    var base = look ? look.shape : SHAPES[opts.shape] ? opts.shape : 'pentagon';
    var w = {
      el: el, svg: el.firstChild, body: el.querySelector('.w-body'), headGear: el.querySelector('.w-head-gear'), faceGear: el.querySelector('.w-face-gear'),
      gear: null, morph0: !!opts.morph, swapAt: 0, swapLook: undefined,
      path: el.querySelector('.w-shape'), shine: el.querySelector('.w-shine'), eyes: el.querySelector('.w-eyes'),
      eyeL: el.querySelector('.w-eye.l'), eyeR: el.querySelector('.w-eye.r'), stops: el.querySelectorAll('linearGradient stop'),
      r: SHAPES[base].slice(), from: null, to: SHAPES[base], t0: 0, dur: 560, base: base,
      lx: 0, ly: 0, blinkAt: performance.now() + 1500 + Math.random() * 3000, blink: 0,
      mood: null, phase: Math.random() * 10, visible: true, small: size === 'sm' || size === 'xs', kick: 0,
      morph: !!opts.morph && !look, color: (look && look.color) || opts.color || null,
      talkUntil: 0, look: null, hop: 0, io: null,
      // Idle glances: the eyes jump to a spot, rest, jump again (alive, not drifting).
      gx: 0, gy: 0, nextGlance: 0,
      // Small Wisps get bigger eyes, or the face is lost at 20px.
      eyeScale: { lg: 1.15, md: 1.45, sm: 1.7, xs: 1.9 }[size] || 1
    };
    w.setShape = function (name) {
      if (!SHAPES[name]) return;
      if (!w.morph && name !== w.base) return;
      var target = SHAPES[name]; if (target === w.to) return;
      w.from = w.r.slice(); w.to = target; w.t0 = performance.now();
    };
    w.paint = function () {
      var M = MOODS[w.mood] || MOODS.neutral;
      var c = w.color && w.mood !== 'angry' && w.mood !== 'love' ? tint(w.color) : M.c;
      w.stops[0].style.stopColor = c[0]; w.stops[1].style.stopColor = c[1];
    };
    w.setColor = function (hex) { w.color = /^#[0-9a-f]{6}$/i.test(hex || '') ? hex : null; w.paint(); };
    w.setMood = function (m, keepShape) {
      if (!MOODS[m]) m = 'neutral';
      var M = MOODS[m];
      if (m === w.mood) { w.kick = performance.now(); return; }
      w.mood = m; el.dataset.mood = m;
      var eye = EYES[m] || EYES.neutral;
      w.eyeL.innerHTML = eye(-1); w.eyeR.innerHTML = eye(1);
      w.paint();
      if (!keepShape) w.setShape(w.morph ? M.shape : w.base);
      if (M.hop) w.hop = performance.now();
      w.kick = performance.now();
    };
    // A specialist's character (its shape, colour and gear) or, with null, Codeply's own face.
    // A specialist keeps its shape through every mood; Codeply's morphing face goes back to morphing.
    function wear(look) {
      var on = look && SHAPES[look.shape] ? look : null;
      w.base = on ? on.shape : 'pentagon';
      w.morph = on ? false : w.morph0;
      w.gear = on && (HEAD_GEAR[on.gear] || FACE_GEAR[on.gear]) ? on.gear : null;
      w.headGear.innerHTML = w.gear && HEAD_GEAR[w.gear] ? HEAD_GEAR[w.gear] : '';
      w.faceGear.innerHTML = w.gear && FACE_GEAR[w.gear] ? FACE_GEAR[w.gear] : '';
      w.color = on && /^#[0-9a-f]{6}$/i.test(on.color || '') ? on.color : null;
      el.dataset.look = on ? on.gear || on.shape : '';
      var target = SHAPES[w.base];
      if (target !== w.to) { w.from = w.r.slice(); w.to = target; w.t0 = performance.now(); }
      w.paint();
    }
    w.dress = function (look, fun) {
      if (!fun || reduce) { wear(look); return; }
      // The costume change: it spins and shrinks, poofs into the new look halfway, and pops back.
      w.swapAt = performance.now(); w.swapLook = look || null;
      var poof = document.createElement('span');
      poof.className = 'wisp-poof';
      for (var k = 0; k < 8; k++) { var dot = document.createElement('i'); dot.style.setProperty('--a', (k * 45) + 'deg'); poof.appendChild(dot); }
      el.appendChild(poof);
      setTimeout(function () { poof.remove(); }, 900);
    };
    w.talk = function (ms) { w.talkUntil = performance.now() + (ms || 1200); };
    w.lookAt = function (p) { w.look = p || null; };
    w.boop = function () { w.hop = performance.now(); w.kick = performance.now(); };
    w.destroy = function () { var i = all.indexOf(w); if (i >= 0) all.splice(i, 1); if (w.io) w.io.disconnect(); el.wisp = null; };
    w.setMood(opts.mood || el.dataset.mood || 'neutral');
    if (look) wear(look);
    if ('IntersectionObserver' in window) {
      w.io = new IntersectionObserver(function (es) { w.visible = es[0].isIntersecting; });
      w.io.observe(el);
    }
    if (opts.interactive !== false) {
      // Click: a happy hop. Several quick clicks: it gets a little flustered, then loves it.
      var clicks = [];
      el.addEventListener('click', function () {
        var now = performance.now();
        clicks = clicks.filter(function (t) { return now - t < 1200; }); clicks.push(now);
        var prev = el.dataset.restMood || w.mood;
        if (prev === 'happy' || prev === 'love' || prev === 'surprised') prev = 'neutral';
        el.dataset.restMood = prev;
        w.setMood(clicks.length >= 4 ? 'love' : clicks.length === 3 ? 'surprised' : 'happy', !w.morph);
        w.boop();
        clearTimeout(w.backTimer);
        w.backTimer = setTimeout(function () { delete el.dataset.restMood; w.setMood(prev); }, 1500);
      });
    }
    all.push(w); el.wisp = w;
    if (!running) { running = true; requestAnimationFrame(frame); }
    return w;
  }

  function ease(t) { var c = 1.4; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); }

  function frame(now) {
    for (var j = all.length - 1; j >= 0; j--) {
      var w = all[j];
      if (!w.el.isConnected) { w.destroy(); continue; }
      // Off screen it rests, but a shape change it started always finishes: otherwise a face the
      // browser counts as off screen keeps the new mood's colour on the old shape (a pentagon).
      if (!w.visible && !w.from) continue;
      // morph
      if (w.from) {
        var k = Math.min(1, (now - w.t0) / w.dur), e = reduce ? 1 : ease(k);
        for (var i = 0; i < N; i++) w.r[i] = w.from[i] + (w.to[i] - w.from[i]) * e;
        if (k >= 1) w.from = null;
      }
      // body: a slow breath, plus whatever the mood does
      var M = MOODS[w.mood] || MOODS.neutral, since = (now - w.kick) / 1000;
      var breathe = reduce ? 0 : Math.sin(now / (M.busy ? 520 : 900) + w.phase) * (M.busy ? .026 : .018);
      var sx = 1 - breathe * .6, sy = 1 + breathe, ox = 0, oy = 0, rot = 0;
      if (!reduce) {
        if (M.bounce) { var bp = M.fast ? 190 : 260; oy = -Math.abs(Math.sin(now / bp)) * 3.2; sy += Math.abs(Math.sin(now / bp)) * .025; }
        if (M.shake && since < 1.6) ox = Math.sin(now / 28) * 1.6 * (1 - since / 1.6);
        if (M.tremble) ox = Math.sin(now / 45) * .45;
        if (M.doze) { sy -= .03; oy = 2 + Math.sin(now / 1400) * .8; }
        if (M.sag) { sy -= .045; sx += .02; oy = 2.6; }
        if (M.puff) { sx += .02; sy += .03; oy = -1; }
        if (M.lean) { sy += .015; oy = -.6; }
        if (M.busy) rot = Math.sin(now / 700 + w.phase) * 2.2;
        var hopT = (now - w.hop) / 420;
        if (hopT >= 0 && hopT < 1) { oy -= Math.sin(hopT * Math.PI) * 5; sy += Math.sin(hopT * Math.PI) * .04; }
        if (now < w.talkUntil) { var tk = Math.abs(Math.sin(now / 95)); sy += tk * .03; sx -= tk * .015; }
      }
      // The costume change (dress(look, true)): half a spin down, the new look, half a spin back up.
      var swapK = -1;
      if (w.swapAt) {
        swapK = Math.min(1, (now - w.swapAt) / 720);
        if (swapK >= .5 && w.swapLook !== undefined) { var nl = w.swapLook; w.swapLook = undefined; w.dress(nl, false); w.from = null; w.r = SHAPES[w.base].slice(); w.to = SHAPES[w.base]; w.hop = now; }
        if (swapK >= 1) { w.swapAt = 0; swapK = -1; }
      }
      var d = '', ca = Math.cos(rot * Math.PI / 180), sa = Math.sin(rot * Math.PI / 180);
      for (i = 0; i < N; i++) {
        var a = -Math.PI / 2 + TAU * i / N, rr = R * w.r[i];
        var vx = rr * Math.cos(a) * sx, vy = rr * Math.sin(a) * sy;
        var x = CX + ox + vx * ca - vy * sa, y = CY + oy + vx * sa + vy * ca;
        d += (i ? 'L' : 'M') + x.toFixed(2) + ' ' + y.toFixed(2);
      }
      d += 'Z';
      w.path.setAttribute('d', d);
      w.shine.setAttribute('d', d);
      // Head gear rides on top of the head (the shape's highest point), face gear on the eyes below.
      if (w.gear) {
        var top = CY + oy - R * w.r[0] * sy;
        w.headGear.setAttribute('transform', 'translate(' + ox.toFixed(2) + ' ' + (top - 14).toFixed(2) + ') rotate(' + rot.toFixed(2) + ' 50 ' + (54 - top + 14).toFixed(2) + ')');
      }
      if (swapK >= 0) {
        var sw = Math.sin(swapK * Math.PI), spin = swapK * 360;
        w.body.setAttribute('transform', 'rotate(' + spin.toFixed(1) + ' 50 54) translate(50 54) scale(' + (1 - .55 * sw).toFixed(3) + ') translate(-50 -54)');
      } else if (w.body.hasAttribute('transform')) w.body.removeAttribute('transform');
      // eyes: follow the cursor (or what Wisp is looking at), wander when nothing moves
      var tx = 0, ty = 0;
      if (w.mood === 'thinking') { tx = 4; ty = -4; }
      else if (w.mood === 'sleepy') { tx = 0; ty = 2; }
      else if (w.mood === 'sad') { tx = -1; ty = 2.6; }
      else if (w.mood === 'proud') { tx = 0; ty = -2; }
      else if (w.mood === 'working' && !reduce) { tx = Math.sin(now / 380 + w.phase) > 0 ? 3.6 : -3.6; ty = 1.6; }
      else if (w.mood === 'worried' && !reduce) { tx = Math.sin(now / 900) * 3; ty = .8; }
      else {
        var target = w.look || (px !== null && now - lastMove < 4000 ? { x: px, y: py } : null);
        if (target) {
          var b = w.svg.getBoundingClientRect(), cx = b.left + b.width / 2, cy = b.top + b.height * .44;
          var dx = target.x - cx, dy = target.y - cy, dist = Math.hypot(dx, dy) || 1, reach = Math.min(1, dist / (b.width * 2.2 + 120));
          tx = dx / dist * 6 * reach; ty = dy / dist * 4.5 * reach;
        } else if (!reduce) {
          if (now > w.nextGlance) {
            // Mostly a look somewhere, sometimes straight ahead; now and then a double blink.
            const r = Math.random();
            if (r < .22) { w.gx = 0; w.gy = 0; } else { w.gx = (Math.random() * 2 - 1) * 6; w.gy = (Math.random() * 2 - 1) * 4.2; }
            w.nextGlance = now + 650 + Math.random() * 2100;
            if (Math.random() < .18) { w.blink = now; w.blinkAt = now + 260; }
          }
          tx = w.gx; ty = w.gy;
        }
      }
      var lerp = reduce ? 1 : (w.mood === 'working' || (!w.look && (px === null || now - lastMove >= 4000)) ? .24 : .14); /* glances are quick, like real eyes */ w.lx += (tx - w.lx) * lerp; w.ly += (ty - w.ly) * lerp;
      // blink
      var sc = 1;
      if (M.blink && !reduce) {
        if (now > w.blinkAt) { w.blink = now; w.blinkAt = now + 2200 + Math.random() * 3800; }
        var bt = (now - w.blink) / 150; if (bt < 1) sc = Math.max(.08, Math.abs(1 - 2 * bt));
      }
      if (M.lean) sc *= 1.06;
      var es = w.eyeScale;
      w.eyes.setAttribute('transform', 'translate(' + (w.lx + ox).toFixed(2) + ' ' + (w.ly + oy).toFixed(2) + ') translate(49 46) scale(' + es + ' ' + (es * sc).toFixed(3) + ') translate(-49 -46)');
      // Glasses follow the eyes but never blink; shades look a little less far than the eyes do.
      if (w.gear && FACE_GEAR[w.gear]) w.faceGear.setAttribute('transform', 'translate(' + (w.lx * .7 + ox).toFixed(2) + ' ' + (w.ly * .7 + oy).toFixed(2) + ') translate(49 46) scale(' + es + ') translate(-49 -46)');
    }
    if (all.length) requestAnimationFrame(frame); else running = false;
  }

  addEventListener('pointermove', function (e) { px = e.clientX; py = e.clientY; lastMove = performance.now(); }, { passive: true });
  // On a phone there is no cursor: the eyes look where you tap, then go back to glancing.
  addEventListener('pointerdown', function (e) { px = e.clientX; py = e.clientY; lastMove = performance.now() - 2200; }, { passive: true });

  // ---- reading a message: the mood it carries, and a shape when it names one ----
  // Wisp reads who a feeling is aimed at. Upset with Wisp: it's sorry, not
  // defensive. Someone else being mean to you: it's on your side.
  var OTHERS = /\b(my )?(boss|manager|client|customer|teacher|coworker|co-worker|colleague|teammate|friend|ex|mom|dad|brother|sister|someone|somebody|people|he|she|they|this guy|that guy|some guy|reviewer)\b/i;
  var MEAN = /\b(yelled|shouted|screamed|was (so )?(mean|rude)|were (so )?(mean|rude)|(is|are) (so )?(mean|rude)|insulted|bull(y|ied|ying)|called me|laughed at me|blamed me|ignored me|made fun|mocked|disrespected|roasted me|hates? me|dissed)\b/i;
  var AT_WISP = /\b(you|your|u|ur|wisp)\b|\b(it'?s|this is|that'?s) (broken|wrong|bad|useless|garbage|trash)\b|\b(broke|broken|failed|wrong|again|useless|stupid|ugh|wtf)\b/i;
  var TOPICS = [
    [/\b(stars?|rating|favou?rite|shine|shiny|sparkle)\b/i, 'star', 'A star, coming up.'],
    [/\b(clouds?|sky|weather|rain|fluffy)\b/i, 'cloud', 'Very fluffy. Very cloud.'],
    [/\b(water|slime|liquid|melt|wobbly|jelly|chill)\b/i, 'blob', 'Going with the flow.'],
    [/\b(ball|round|circle|bubble|planet|moon)\b/i, 'circle', 'Round and ready.'],
    [/\b(bees?|honey|hexagon|hive)\b/i, 'hexagon', 'Hexagons. The best shape.'],
    [/\b(pyramid|triangle|mountain|pointy)\b/i, 'triangle', 'Pointy. On purpose.'],
    [/\b(box|square|cube|block|lego)\b/i, 'square', 'Squared away.'],
    [/\b(hearts?|valentine|crush)\b/i, 'heart', 'All heart.']
  ];
  var REPLY = {
    neutral: "I'm listening.", happy: 'Glad that helped. What next?', love: 'Aw. Right back at you.',
    sad: "Sorry. That's on me, fixing it right now.",
    angry: 'Nobody talks to you like that. Want me to draft a reply?',
    sleepy: "Still here. I'll keep going while you rest.", surprised: "Oh. Didn't see that coming.",
    thinking: 'Good question. Give me a second.', excited: "Ooh. Let's do it.", worried: 'Hmm. Let me look carefully.',
    working: "Sleep well. I'll keep working while you rest."
  };
  // Feelings the user has (not about Wisp): Wisp feels them with them.
  var FEEL_ANGRY = /\b(angry|mad|furious|pissed|frustrat\w*|annoyed|irritated|livid|fuming|infuriat\w*|fed up|sick of|hate (him|her|them|this|that|it|my|when|how)|drives me (crazy|nuts|mad)|so done with)\b/i;
  var FEEL_SAD = /\b(sad|upset|depressed|lonely|heartbroken|miserable|crying|cried|devastated|(bad|rough|terrible|awful) day|day was (bad|rough|terrible|awful)|feel(ing)? (down|low|awful|terrible)|i miss)\b|😢|😭/i;
  var FEEL_WORRIED = /\b(worried|nervous|anxious|scared|afraid|stressed|stressing|panick?ing|freaking out|overwhelmed)\b/i;
  var FEEL_LOVE = /\b(i (love|luv|adore) (you|u|ya)|love (you|u|ya|it|this)|ily|i like you|you('?re| are) (the best|amazing|awesome|great|cute|sweet|lovely))\b|<3|❤|💙|😍|🥰|😘/i;
  var AT_YOU = /\b(at|with|of) (you|u|wisp|codeply)\b|\byou('?re| are) (useless|stupid|annoying|slow|bad|terrible)\b/i;
  function moodOf(t) {
    var letters = t.replace(/[^a-z]/gi, ''), caps = letters.replace(/[^A-Z]/g, '').length;
    var shouting = (letters.length > 3 && caps / letters.length > .6) || /!!/.test(t);
    if (OTHERS.test(t) && MEAN.test(t)) return 'angry';
    if (FEEL_LOVE.test(t)) return 'love';
    // Angry at Wisp itself: it's sorry. Angry at anyone or anything else: it's angry with you.
    if (FEEL_ANGRY.test(t)) return AT_YOU.test(t) ? 'sad' : 'angry';
    if (shouting || (AT_WISP.test(t) && /\b(broke|broken|failed|wrong|again|useless|stupid|ugh|wtf|hate|bad|garbage|trash|annoying|slow)\b/i.test(t))) return 'sad';
    if (FEEL_SAD.test(t)) return 'sad';
    if (FEEL_WORRIED.test(t)) return 'worried';
    if (/\b(got the job|i won|we won|promoted|i passed|good news|it worked|we did it)\b/i.test(t)) return 'excited';
    if (/\b(thanks|thank you|thx|great|nice|awesome|good job|well done|perfect|amazing|cool|lol|haha|yay)\b|:\)/i.test(t)) return 'happy';
    // Going to sleep: Wisp doesn't. It keeps working while you rest.
    if (/\b(sleep|sleepy|tired|good ?night|bed|bye|signing off)\b/i.test(t)) return 'working';
    if (/\b(wow|omg|whoa|no way|really\?)\b/i.test(t)) return 'surprised';
    if (/\b(let'?s go|excited|can'?t wait|launch|ship it)\b|🚀/i.test(t)) return 'excited';
    if (/\?|\b(what|how|why|can you|could you)\b/i.test(t)) return 'thinking';
    return 'neutral';
  }
  function read(text) {
    var t = String(text || '').trim();
    if (!t) return { mood: 'neutral', shape: null, line: '' };
    var mood = moodOf(t), topic = null;
    for (var i = 0; i < TOPICS.length; i++) if (TOPICS[i][0].test(t)) { topic = TOPICS[i]; break; }
    var moody = mood === 'angry' || mood === 'sad';
    return {
      mood: mood,
      shape: topic && !moody ? topic[1] : null,
      line: topic && !moody && (mood === 'neutral' || mood === 'thinking') ? topic[2] : REPLY[mood] || ''
    };
  }

  /** A small static avatar for lists and chat rows (still animated, just not interactive). */
  function avatar(opts) {
    var el = document.createElement('span');
    el.className = 'wisp-av';
    make(el, Object.assign({ size: 'sm', morph: false, interactive: true }, opts || {}));
    return el;
  }

  window.CraftWisp = {
    mount: function (el, opts) { return el.wisp || make(el, opts); },
    avatar: avatar,
    read: read,
    SHAPES: Object.keys(SHAPES),
    GEAR: Object.keys(HEAD_GEAR).concat(Object.keys(FACE_GEAR)),
    MOODS: Object.keys(MOODS)
  };
})();
