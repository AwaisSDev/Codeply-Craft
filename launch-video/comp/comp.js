// Codeply 3.0 launch film. One function of time, window.__frame(t), draws the frame at t seconds.
// The render script calls it for every 1/60 s, in order, from 0. The app mockups are the website's own
// 3.0 markup and CSS (codeply.app/codeply, /specialists, /apps, /voice, /mobile).
(function () {
  'use strict';
  const W = 1920, H = 1080, BLUE = '#2F6BFF';
  const stage = document.getElementById('stage');

  // ─── math ─────────────────────────────────────────────────────────────────
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const lerp = (a, b, k) => a + (b - a) * k;
  const seg = (t, a, b) => clamp((t - a) / (b - a));
  const E = {
    lin: (x) => x,
    outCubic: (x) => 1 - Math.pow(1 - x, 3),
    inCubic: (x) => x * x * x,
    inOutCubic: (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
    outQuart: (x) => 1 - Math.pow(1 - x, 4),
    outQuint: (x) => 1 - Math.pow(1 - x, 5),
    outExpo: (x) => (x >= 1 ? 1 : 1 - Math.pow(2, -10 * x)),
    inExpo: (x) => (x <= 0 ? 0 : Math.pow(2, 10 * x - 10)),
    inOutExpo: (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x < 0.5 ? Math.pow(2, 20 * x - 10) / 2 : (2 - Math.pow(2, -20 * x + 10)) / 2),
    inOutQuint: (x) => (x < 0.5 ? 16 * Math.pow(x, 5) : 1 - Math.pow(-2 * x + 2, 5) / 2),
    outBack: (x, s = 1.7) => 1 + (s + 1) * Math.pow(x - 1, 3) + s * Math.pow(x - 1, 2),
    inBack: (x, s = 1.7) => (s + 1) * x * x * x - s * x * x,
  };
  // the step response of a damped spring, 0 -> 1, x in seconds
  function spring(x, f = 2.2, z = 0.5) {
    if (x <= 0) return 0;
    const w = 2 * Math.PI * f, wd = w * Math.sqrt(1 - z * z);
    return 1 - Math.exp(-z * w * x) * (Math.cos(wd * x) + (z * w / wd) * Math.sin(wd * x));
  }
  const hash = (i) => { const s = Math.sin(i * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };

  // ─── DOM ──────────────────────────────────────────────────────────────────
  function el(tag, cls, html, parent) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    (parent || stage).appendChild(e);
    return e;
  }
  // place by centre, with scale, rotation, opacity and blur
  function put(e, p) {
    const x = p.x == null ? W / 2 : p.x, y = p.y == null ? H / 2 : p.y;
    const s = p.s == null ? 1 : p.s, o = p.o == null ? 1 : p.o;
    let tr = 'translate(' + x.toFixed(2) + 'px,' + y.toFixed(2) + 'px) translate(-50%,-50%)';
    if (p.persp) tr += ' perspective(' + p.persp + 'px)';
    if (p.rx) tr += ' rotateX(' + p.rx.toFixed(3) + 'deg)';
    if (p.ry) tr += ' rotateY(' + p.ry.toFixed(3) + 'deg)';
    if (p.r) tr += ' rotate(' + p.r.toFixed(3) + 'deg)';
    tr += ' scale(' + (s * (p.sx || 1)).toFixed(4) + ',' + (s * (p.sy || 1)).toFixed(4) + ')';
    e.style.transform = tr;
    e.style.opacity = o.toFixed(3);
    const b = p.blur || 0;
    e.style.filter = b > 0.05 ? 'blur(' + b.toFixed(2) + 'px)' : 'none';
    e.style.display = o <= 0.002 ? 'none' : '';
  }
  // the reference's move: blur in with a little scale, blur out the same way
  function bio(t, a, b, c, d, opt = {}) {
    const din = opt.din == null ? 0.38 : opt.din, dout = opt.dout == null ? 0.26 : opt.dout;
    const i = E.outCubic(seg(t, a, a + din)), o = E.inCubic(seg(t, c, c + dout));
    if (t < a || t > c + dout) return { o: 0, blur: 0, s: 1, k: 0 };
    return {
      o: i * (1 - o),
      blur: (1 - i) * (opt.bin == null ? 18 : opt.bin) + o * (opt.bout == null ? 16 : opt.bout),
      s: lerp(opt.sin == null ? 1.06 : opt.sin, 1, i) * lerp(1, opt.sout == null ? 0.96 : opt.sout, o),
      k: i, ko: o,
    };
  }

  // ─── typing ───────────────────────────────────────────────────────────────
  // *word* is the accent (blue, or serif italic on the sky), ~word~ is dimmed
  function parse(str) {
    const out = []; let acc = false, dim = false;
    for (const ch of str) {
      if (ch === '*') { acc = !acc; continue; }
      if (ch === '~') { dim = !dim; continue; }
      out.push({ ch, cls: acc ? 'acc' : dim ? 'dim' : '' });
    }
    return out;
  }
  const CUES = [];
  window.CUES = CUES;
  function cue(t, kind, v) { CUES.push({ t: +(t + OFF).toFixed(4), kind, v: v == null ? 1 : v }); }
  // a typing line: each letter's time, a little uneven like a real person, spaces a beat longer
  function Typer(str, t0, cps, opt = {}) {
    const chars = parse(str), times = [];
    let tt = t0;
    chars.forEach((c, i) => { tt += (1 / cps) * (0.72 + 0.56 * hash(i + str.length * 7)) * (c.ch === ' ' ? 1.25 : 1); times.push(tt); });
    const T = { chars, times, t0, end: tt, str, opt, last: '' };
    if (!opt.silent) times.forEach((x) => cue(opt.silentOff ? x - OFF : x, 'key', opt.soft ? 0.6 : 1));
    return T;
  }
  function typeHTML(T, t, opt = {}) {
    let n = 0; while (n < T.times.length && T.times[n] <= t) n++;
    let html = '', cur = null, buf = '';
    const flush = () => { if (buf) html += cur ? '<span class="' + cur + '">' + buf + '</span>' : buf; buf = ''; };
    for (let i = 0; i < n; i++) {
      const age = t - T.times[i];
      let cls = T.chars[i].cls;
      if (opt.fresh !== false && age < 0.11) cls = (cls ? cls + ' ' : '') + 'fresh';
      if (cls !== cur) { flush(); cur = cls; }
      const c = T.chars[i].ch;
      buf += c === '<' ? '&lt;' : c === '&' ? '&amp;' : c;
    }
    flush();
    if (opt.cursor) {
      const on = t < T.end + 0.05 || ((t - T.end) % 0.9) < 0.48;
      const show = t >= T.t0 - (opt.lead == null ? 0.35 : opt.lead) && (opt.until == null || t < opt.until);
      if (show) html += '<i class="blk' + (on ? '' : ' off') + '"></i>';
    }
    return html;
  }
  function typeInto(e, T, t, opt) {
    const h = typeHTML(T, t, opt || {});
    if (e.__h !== h) { e.innerHTML = h; e.__h = h; }
  }
  function setText(e, s) { if (e.__s !== s) { e.textContent = s; e.__s = s; } }
  function setHTML(e, s) { if (e.__h !== s) { e.innerHTML = s; e.__h = s; } }

  // ─── one-shot events (class changes on the mockups), run in time order ────
  const EV = [];
  // OFF moves a whole scene on the timeline: its events, sounds and cursor keys are registered at
  // t + OFF, and the scene is drawn with its own clock (t - OFF), so the cuts land on the beat.
  let OFF = 0;
  function at(t, fn) { EV.push({ t: t + OFF, fn, done: false }); }

  // ─── layers ───────────────────────────────────────────────────────────────
  const skyWrap = el('div', 'full');
  const sky = el('div', '', null, skyWrap); sky.id = 'sky';
  const paperWrap = el('div', 'full');
  el('div', '', null, paperWrap).id = 'paper';
  el('div', '', null, paperWrap).id = 'paperSky';
  const vign = el('div', ''); vign.id = 'vignette';
  const scenes = el('div', 'full');
  const burst = el('canvas', ''); burst.id = 'burst'; burst.width = W; burst.height = H;
  const bctx = burst.getContext('2d');
  const flash = el('div', ''); flash.id = 'flash';
  const pingLayer = el('div', 'full');
  const cursor = el('div', '', '<svg viewBox="0 0 30 30"><path d="M6 4.5 6.4 24.2c0 1.5 1.8 2.2 2.8 1.1l4.3-5c.5-.6 1.3-.9 2.1-.9h7.1c1.5 0 2.2-1.8 1.1-2.8L8.7 3.4C7.7 2.5 6 3.2 6 4.5Z" fill="#3a6ee8" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>');
  cursor.id = 'cursor';

  const S = (html, parent) => el('div', 'L', html, parent || scenes);
  const SNIP = window.SNIP;
  function host(key, parent) {
    const h = el('div', 'host', SNIP[key], parent || scenes);
    if (window.Wisp) window.Wisp.mount(h);
    return h;
  }
  const iconImg = (src) => '<img src="' + src + '" alt="">';
  const LOBE = (n) => 'https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@1.95.1/icons/' + n + '.svg';

  // ─── the cursor: keyframes {t, x, y} (x,y can be functions), presses at times ─
  const CUR = [];      // [{t, at:()=>{x,y}}]
  const PRESS = [];    // [{t, at}]
  const PINGS = [];
  function curKey(t, x, y) { CUR.push({ t: t + OFF, x, y }); }
  function press(t, x, y) { PRESS.push(t + OFF); PINGS.push({ t: t + OFF, x, y }); cue(t, 'click'); }
  const val = (v, t) => (typeof v === 'function' ? v(t) : v);
  const center = (e, dx = 0, dy = 0) => () => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2 + dx, y: r.top + r.height / 2 + dy }; };
  function drawCursor(t) {
    // visible spans: runs of keys closer than 1.6s apart
    let a = null, b = null;
    for (let i = 0; i < CUR.length; i++) { if (CUR[i].t <= t) a = CUR[i]; if (CUR[i].t > t && !b) b = CUR[i]; }
    if (!a || (b && b.t - a.t > 2.4 && t - a.t > 0.4) || (!b && t - a.t > 0.45)) {
      cursor.style.display = 'none'; return;
    }
    let pa = val(a.x, t), x, y;
    if (typeof pa === 'object') { x = pa.x; y = pa.y; } else { x = pa; y = val(a.y, t); }
    let fadeOut = 1;
    if (b && b.t - a.t <= 2.4) {
      let pb = val(b.x, t), bx, by;
      if (typeof pb === 'object') { bx = pb.x; by = pb.y; } else { bx = pb; by = val(b.y, t); }
      const k = E.inOutCubic(seg(t, a.t, b.t));
      // a slight arc, like a hand moving a mouse
      const arc = Math.sin(k * Math.PI) * Math.min(60, Math.hypot(bx - x, by - y) * 0.12);
      x = lerp(x, bx, k) + arc * 0.3; y = lerp(y, by, k) - arc;
    } else fadeOut = 1 - seg(t, a.t + 0.1, a.t + 0.45);
    // first key: fade in
    const first = CUR.filter((c) => c.t <= t).reverse().find((c, i, arr) => !arr[i + 1] || c.t - arr[i + 1].t > 2.4);
    const fadeIn = first ? seg(t, first.t - 0.001, first.t + 0.2) : 1;
    let s = 1;
    for (const p of PRESS) { const d = t - p; if (d >= -0.06 && d < 0.2) s = Math.min(s, d < 0 ? lerp(1, 0.82, (d + 0.06) / 0.06) : lerp(0.82, 1, E.outCubic(d / 0.2))); }
    cursor.style.display = '';
    cursor.style.opacity = (fadeIn * fadeOut).toFixed(3);
    cursor.style.transform = 'translate(' + (x - 6).toFixed(1) + 'px,' + (y - 4).toFixed(1) + 'px) scale(' + s.toFixed(3) + ')';
  }
  const pingEls = [];
  function drawPings(t) {
    PINGS.forEach((p, i) => {
      const e = pingEls[i] || (pingEls[i] = el('div', 'ping', '', pingLayer));
      const d = t - p.t;
      if (d < 0 || d > 0.6) { e.style.display = 'none'; return; }
      if (!p.pos) { const v = val(p.x, t); p.pos = typeof v === 'object' ? v : { x: v, y: val(p.y, t) }; }
      const k = E.outCubic(d / 0.6);
      e.style.display = '';
      e.style.left = p.pos.x + 'px'; e.style.top = p.pos.y + 'px';
      e.style.transform = 'scale(' + (0.3 + k * 1.1).toFixed(3) + ')';
      e.style.opacity = (1 - k).toFixed(3);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  v2: slower, readable, Apple-style type (Inter Display), every beat says what the app does.
  //  120 BPM grid: a beat is 0.5 s, a bar 2 s. Cuts land on beats.
  //    0 – 6     hook: "Most AI waits for you to ask." / "Codeply is already on it."
  //    6 – 12    the mascot, the drop (8.0), the logo, "The biggest release yet."
  //   12 – 19    Wisp leads every chat (the 3.0 desktop app)
  //   19 – 26    a team of real specialists, @Name
  //   26 – 32    any app, one click away
  //   32 – 38    close the laptop, it keeps going
  //   38 – 46    make Codeply yours: wallpaper, font, text size, spacing
  //   46 – 49.6  voice
  //   49.6 – 54  ambient intelligence
  //   54 – 60    the end card (drop 2 at 54.0)
  // ═══════════════════════════════════════════════════════════════════════════

  // ─── backgrounds over time ────────────────────────────────────────────────
  const PAPER_IN = 11.6, PAPER_OUT = 49.55;
  function drawBackground(t) {
    const po = seg(t, PAPER_IN, PAPER_IN + 0.4) * (1 - seg(t, PAPER_OUT, PAPER_OUT + 0.4));
    paperWrap.style.opacity = po.toFixed(3);
    paperWrap.style.display = po < 0.002 ? 'none' : '';
    let blur = 0, sc = 1.1, px = 0, py = 0;
    if (t < 6.0) { blur = 4; sc = 1.12 + t * 0.006; px = -t * 5; }
    else if (t < 8.0) { blur = lerp(4, 16, E.inOutCubic(seg(t, 6.0, 7.0))); sc = 1.16; px = -30; }
    else if (t < 12.2) { const k = E.outCubic(seg(t, 8.0, 8.45)); blur = lerp(16, 0, k); sc = lerp(1.22, 1.10, E.outExpo(seg(t, 8.0, 8.9))) + (t - 8) * 0.008; px = -(t - 8) * 8; }
    else if (t < PAPER_OUT) { blur = 30; sc = 1.1; }
    else if (t < 54.0) { blur = lerp(10, 0, E.outCubic(seg(t, PAPER_OUT, 50.3))); sc = 1.06 + (t - 49.5) * 0.01; px = (t - 49.5) * 9; py = -(t - 49.5) * 3; }
    else { blur = lerp(0, 8, E.inOutCubic(seg(t, 54.0, 55.0))); sc = 1.12 + (t - 54) * 0.008; px = 40 - (t - 54) * 6; }
    sky.style.transform = 'translate(' + px.toFixed(1) + 'px,' + py.toFixed(1) + 'px) scale(' + sc.toFixed(4) + ')';
    sky.style.filter = blur > 0.1 ? 'blur(' + blur.toFixed(1) + 'px) saturate(1.08)' : 'saturate(1.08)';
    skyWrap.style.display = po >= 0.999 ? 'none' : '';
  }

  // ─── words that fade up one after another (Apple-style) ──────────────────
  // *word* is the accent: blue on the light stage, full white on the sky (the rest is softer)
  function Words(parent, text, t0, step, cls) {
    const box = el('div', 'words ' + (cls || ''), '', parent);
    const ws = [];
    let acc = false;
    text.split(' ').forEach((w, i) => {
      let a = acc;
      if (w.startsWith('*')) { a = true; w = w.slice(1); acc = true; }
      if (w.endsWith('*')) { w = w.slice(0, -1); acc = false; }
      const s = el('span', 'w' + (a ? ' acc' : ''), w, box);
      ws.push({ s, t: t0 + i * step });
    });
    return { box, ws, t0, end: t0 + (ws.length - 1) * step };
  }
  function drawWords(W_, t) {
    W_.ws.forEach(({ s, t: tw }) => {
      const k = spring(t - tw, 1.7, 0.72);
      const o = t < tw ? 0 : clamp(k * 1.3);
      const st = 'opacity:' + o.toFixed(3) + ';transform:translateY(' + ((1 - clamp(k)) * 0.35).toFixed(3) + 'em);filter:' + (k < 0.98 ? 'blur(' + ((1 - clamp(k)) * 10).toFixed(2) + 'px)' : 'none');
      if (s.__st !== st) { s.style.cssText = st; s.__st = st; }
    });
  }

  // ═══ H — the hook (0 – 6) ═════════════════════════════════════════════════
  const HK = {};
  HK.l1 = S(''); HK.W1 = Words(HK.l1, 'Most AI waits for you to *ask.*', 0.35, 0.2, 'onsky big');
  HK.l2 = S(''); HK.W2 = Words(HK.l2, 'Codeply is *already on it.*', 3.55, 0.24, 'onsky big');
  HK.W1.ws.forEach((w) => cue(w.t, 'thud', 0.35)); HK.W2.ws.forEach((w) => cue(w.t, 'thud', 0.4));
  function sceneH(t) {
    const vis = t < 6.2;
    [HK.l1, HK.l2].forEach((e) => (e.style.display = vis ? '' : 'none')); if (!vis) return;
    drawWords(HK.W1, t); drawWords(HK.W2, t);
    const o1 = E.inCubic(seg(t, 3.0, 3.4)), o2 = E.inCubic(seg(t, 5.7, 6.05));
    put(HK.l1, { x: 960, y: 520 - o1 * 40, o: t < 0.3 ? 0 : 1 - o1, blur: o1 * 18, s: 1 + t * 0.006 });
    put(HK.l2, { x: 960, y: 520 - o2 * 40, o: t < 3.5 ? 0 : 1 - o2, blur: o2 * 18, s: 1 + (t - 3.5) * 0.006 });
  }

  // ═══ D — the mascot, the drop, the logo (6 – 12) ═════════════════════════
  const D = {};
  D.shadow = S('<div class="shadow-blob"></div>');
  D.lock = S('<div class="lockup"></div>');
  D.name = S('<div class="lockup-name"></div>');
  D.badge = S('<div class="badge3">3.0</div>');
  D.wisp = S('<div class="bigwisp"><i data-wisp="" data-mood="neutral"></i></div>');
  window.Wisp.mount(D.wisp);
  D.W = D.wisp.querySelector('[data-wisp]').wisp;
  D.Tn = Typer('Codeply', 8.5, 20);
  D.sub = S(''); D.Ws = Words(D.sub, 'The biggest release *yet.*', 9.4, 0.2, 'onsky mid');
  D.rings = [0, 1, 2].map(() => S('<div class="ring"></div>'));
  at(6.1, () => D.W.setMood('happy')); at(6.9, () => D.W.setMood('neutral'));
  at(8.02, () => D.W.setMood('happy')); at(9.6, () => D.W.setMood('neutral'));
  cue(6.0, 'pop', 1); cue(8.0, 'impact'); cue(9.0, 'pop', 0.8); cue(11.6, 'whoosh', 0.9);
  const DOTS = []; for (let i = 0; i < 520; i++) DOTS.push({ a: hash(i) * Math.PI * 2, r: hash(i + 999), s: hash(i + 77) });
  function drawBurst(t, t0, cx, cy, scale) {
    const d = t - t0;
    if (d < 0 || d > 0.95) return false;
    const k = E.outCubic(d / 0.95);
    const R = (120 + 760 * k) * scale, band = (60 + 160 * k) * scale;
    DOTS.forEach((p) => {
      const rr = R - band * p.r;
      const x = cx + Math.cos(p.a) * rr * 1.25, y = cy + Math.sin(p.a) * rr * 0.9;
      const sz = (1 - k) * (2 + 5 * p.s) * scale;
      if (sz < 0.3) return;
      bctx.fillStyle = p.s > 0.6 ? 'rgba(255,255,255,' + (0.9 * (1 - k)).toFixed(3) + ')' : 'rgba(47,107,255,' + (0.75 * (1 - k)).toFixed(3) + ')';
      bctx.beginPath(); bctx.arc(x, y, sz, 0, Math.PI * 2); bctx.fill();
    });
    return true;
  }
  const LOCK_TOTAL = 40 + 112 + 34 + 330 + 26 + 118 + 40;
  // the mascot's path: pops up, floats, winds up, slams down on the drop, slides into the logo
  function landPose(t, tPop, tDrop, lockLeft, Y) {
    let x = 960, y = Y - 40, s = 1, sx = 1, sy = 1, r = 0;
    if (t < tPop + 0.6) {
      const k = spring(t - tPop, 1.5, 0.55);
      y = lerp(1300, Y - 40, k); s = lerp(0.6, 1, clamp(k)); r = (1 - clamp(k)) * 12;
    } else if (t < tDrop - 0.45) {
      const u = t - tPop - 0.6; y = Y - 40 + Math.sin(u * 3.6) * 10; r = Math.sin(u * 2.4) * 3;
    } else if (t < tDrop - 0.1) {
      const k = E.outCubic(seg(t, tDrop - 0.45, tDrop - 0.1));
      y = lerp(Y - 40, Y - 150, k); sy = lerp(1, 1.1, k); sx = lerp(1, 0.93, k);
    } else if (t < tDrop) {
      const k = E.inCubic(seg(t, tDrop - 0.1, tDrop));
      y = lerp(Y - 150, Y + 5, k); sy = lerp(1.1, 1.16, k); sx = lerp(0.93, 0.88, k);
    } else {
      const u = t - tDrop, sq = Math.exp(-u * 7) * Math.cos(u * 26);
      sx = 1 + 0.26 * sq; sy = 1 - 0.26 * sq;
      y = Y + 5 - Math.max(0, Math.sin(u * 9)) * 30 * Math.exp(-u * 6);
      const m = E.inOutQuint(seg(t, tDrop + 0.18, tDrop + 0.68));
      x = lerp(960, lockLeft + 96, m); y = lerp(y, Y, m); s = lerp(1, 0.6, m);
    }
    return { x, y, s, sx, sy, r };
  }
  function drawRings(rs, t, t0, cx, cy, big) {
    rs.forEach((r, i) => {
      const d = t - t0 - i * 0.07;
      if (d < 0 || d > 0.8) { r.style.display = 'none'; return; }
      const k = E.outCubic(d / 0.8), size = 220 + big * k;
      r.style.width = r.style.height = size + 'px';
      r.firstChild.style.borderWidth = (5 * (1 - k) + 1) + 'px';
      put(r, { x: cx, y: cy, o: (1 - k) * 0.9 });
    });
  }
  function sceneD(t) {
    const vis = t >= 5.9 && t < 12.2;
    [D.shadow, D.lock, D.name, D.badge, D.wisp, D.sub].concat(D.rings).forEach((e) => (e.style.display = vis ? '' : 'none'));
    if (!vis) return;
    const out = E.inCubic(seg(t, 11.55, 11.95)), zoom = 1 + out * 0.35;
    const left = 960 - LOCK_TOTAL / 2, Y = 500;
    const P = landPose(t, 5.95, 8.0, left, Y);
    const pw = lerp(150, LOCK_TOTAL, E.outExpo(seg(t, 8.32, 8.95)));
    D.lock.firstChild.style.width = pw + 'px';
    const pillLeft = t < 8.68 ? P.x - lerp(75, 96, E.inOutQuint(seg(t, 8.18, 8.68))) : left;
    put(D.lock, { x: pillLeft + pw / 2, y: Y, o: seg(t, 8.2, 8.32) * (1 - out), blur: out * 22, s: zoom, sy: lerp(0.85, 1, seg(t, 8.2, 8.4)) });
    typeInto(D.name.firstChild, D.Tn, t, { fresh: true });
    D.name.firstChild.style.width = '330px';
    put(D.name, { x: left + 40 + 112 + 34 + 165, y: Y, o: 1 - out, blur: out * 22, s: zoom });
    const bk = t < 9.0 ? 0 : E.outBack(seg(t, 9.0, 9.35), 2.6);
    put(D.badge, { x: left + LOCK_TOTAL - 40 - 59, y: Y, s: bk * zoom, o: (bk > 0 ? 1 : 0) * (1 - out), blur: out * 22, r: (1 - clamp(bk)) * -14 });
    put(D.wisp, { x: P.x, y: P.y, s: P.s * zoom, sx: P.sx, sy: P.sy, r: P.r, o: 1 - out, blur: out * 22 });
    put(D.shadow, { x: P.x, y: Y + 150, s: lerp(1.2, 0.7, clamp((Y + 150 - P.y) / 300)), o: (t < 8.15 ? 1 : 0) * 0.45 * seg(t, 6.3, 6.7) });
    drawRings(D.rings, t, 8.0, 960, Y + 5, 600);
    drawWords(D.Ws, t);
    put(D.sub, { x: 960, y: 680, o: (t > 9.3 ? 1 : 0) * (1 - out), blur: out * 18 });
  }

  // ═══ the feature header: eyebrow, title, and a plain line saying what it does ═
  const FH = S('<div class="fh2"><div class="fh-eye">New in Codeply 3.0</div><div class="fh-ttl"></div><div class="fh-sub"></div></div>');
  const FHt = FH.querySelector('.fh-ttl'), FHs = FH.querySelector('.fh-sub'), FHe = FH.querySelector('.fh-eye');
  const FEATS = [];
  function feature(a, b, title, sub) {
    const f = { a, b, title, sub, Wt: null, Ws: null };
    FEATS.push(f);
    cue(a, 'whoosh', 0.5);
    return f;
  }
  let curFeat = null;
  function drawHeader(t) {
    const f = FEATS.find((f) => t >= f.a - 0.02 && t < f.b + 0.05);
    if (!f) { FH.style.display = 'none'; return; }
    if (curFeat !== f) {
      FHt.innerHTML = ''; FHs.innerHTML = '';
      f.Wt = Words(FHt, f.title, f.a + 0.15, 0.13, 'paper big');
      f.Ws = Words(FHs, f.sub, f.a + 0.55, 0.045, 'paper small');
      curFeat = f;
    }
    drawWords(f.Wt, t); drawWords(f.Ws, t);
    const ek = E.outCubic(seg(t, f.a, f.a + 0.4));
    FHe.style.opacity = ek.toFixed(3); FHe.style.transform = 'translateY(' + ((1 - ek) * 12).toFixed(1) + 'px)';
    const out = E.inCubic(seg(t, f.b - 0.3, f.b));
    put(FH, { x: 960, y: 158 - out * 20, o: 1 - out, blur: out * 16 });
  }

  // a mockup that rises in and blurs out at the end of its beat
  function cardMove(t, a, b, x, y, sc, opt = {}) {
    const k = spring(t - a, opt.f || 1.2, opt.z || 0.72);
    const out = E.inCubic(seg(t, b - 0.3, b));
    const o = clamp((t - a) / 0.3) * (1 - out);
    return {
      x: x + (1 - k) * (opt.dx || 0), y: y + (1 - k) * (opt.dy == null ? 140 : opt.dy) - out * 30,
      s: sc * lerp(opt.s0 || 0.92, 1, k) * (1 - out * 0.04), o: t < a ? 0 : o, blur: (1 - clamp(k * 1.4)) * 14 + out * 16,
      rx: (1 - k) * (opt.rx == null ? 12 : opt.rx), persp: 1600,
    };
  }
  function note(html) { return S('<div class="note"><span class="dot"></span><span>' + html + '</span></div>'); }
  function drawNote(n, t, a, b, x, y) {
    const k = spring(t - a, 1.8, 0.65);
    const o = clamp((t - a) / 0.2) * (1 - E.inCubic(seg(t, b - 0.3, b)));
    put(n, { x: x + (1 - k) * -30, y, s: lerp(0.8, 1, k), o: t < a ? 0 : o, blur: (1 - clamp(k)) * 8 });
  }
  function appWindow(glass) {
    const tmp = document.createElement('div'); tmp.innerHTML = SNIP.codeply_6;
    const ap = tmp.querySelector('.ap');
    if (!glass) ap.classList.remove('ap-glass');
    ap.removeAttribute('style');
    ap.querySelectorAll('.wp-l').forEach((x) => x.remove());
    ap.querySelector('.ap-title').textContent = 'Checkout total is wrong';
    ap.querySelectorAll('.ap-row.cur').forEach((r) => r.classList.remove('cur'));
    const rows = ap.querySelectorAll('.ap-grp .ap-row'); if (rows[2]) { rows[2].textContent = 'Checkout total is wrong'; rows[2].classList.add('cur'); }
    ap.querySelector('.ap-u').textContent = 'The checkout total is wrong. Fix it before the launch';
    const did = ap.querySelector('.ap-did');
    did.querySelector('.shimmer').textContent = 'Brewing an answer';
    did.querySelector('.t').innerHTML = 'Brought in Frontend and Testing, edited 2 files, ran 24 tests, checked 1 page ' + (did.querySelector('.t svg') ? did.querySelector('.t svg').outerHTML : '');
    const a = ap.querySelector('.ap-a'), chg = a.querySelector('.ap-chg');
    a.innerHTML = '<p>Done. The <b>checkout total</b> is right again.</p><ul>' +
      '<li><b>Fix:</b> tax was added twice in <code>cart.ts</code>. Frontend fixed it.</li>' +
      '<li><b>Tests:</b> Testing added a tax test. All 24 pass.</li>' +
      '<li><b>Checked:</b> opened the checkout page, no console errors.</li></ul>';
    if (chg) { chg.querySelector('span').firstChild.textContent = 'Changed 2 files '; a.appendChild(chg); }
    const h = S(''); h.className = 'host'; h.appendChild(ap);
    window.Wisp.mount(h);
    return { h, ap };
  }

  // ═══ F1 — Wisp leads every chat (12 – 19) ═══════════════════════════════════
  const F1 = feature(12.0, 19.0, 'Wisp leads *every chat.*', 'Ask once. Wisp plans the work, writes the code and checks it in a real browser.');
  (function () {
    const w = appWindow(false); F1.host = w.h; F1.ap = w.ap;
    F1.typed = w.ap.querySelector('.ap-typed'); F1.lis = w.ap.querySelectorAll('.ap-a li');
    F1.face = w.ap.querySelector('.ap-did [data-wisp]'); F1.send = w.ap.querySelector('.ap-send');
  })();
  F1.T = Typer('The checkout total is wrong. Fix it before the launch', 12.95, 30, { soft: true });
  at(12.9, () => F1.ap.classList.add('typing'));
  at(15.0, () => { F1.ap.classList.remove('typing'); F1.ap.classList.add('sent'); });
  at(15.2, () => { F1.ap.classList.add('working'); if (F1.face && F1.face.wisp) F1.face.wisp.setMood('thinking'); });
  at(16.3, () => { F1.ap.classList.remove('working'); F1.ap.classList.add('did'); if (F1.face && F1.face.wisp) F1.face.wisp.setMood('happy'); });
  at(16.45, () => F1.ap.classList.add('answered'));
  [16.8, 17.2, 17.6].forEach((x, i) => at(x, () => F1.lis[i] && F1.lis[i].classList.add('on')));
  at(18.0, () => F1.ap.classList.add('changed'));
  F1.note = note('Wisp brought in <b>Frontend</b> and <b>Testing</b>');
  cue(15.0, 'send'); cue(16.45, 'pop', 0.5); cue(16.5, 'note');
  curKey(14.45, 1560, 1040); curKey(14.88, center(F1.send, 3, 5)); curKey(15.25, center(F1.send, 3, 5));
  press(14.95, center(F1.send));
  function sceneF1(t) {
    const vis = t > F1.a - 0.05 && t < F1.b + 0.05;
    F1.host.style.display = vis ? '' : 'none'; if (!vis) { F1.note.style.display = 'none'; return; }
    let n = 0; while (n < F1.T.times.length && F1.T.times[n] <= t) n++;
    setText(F1.typed, t < 15.0 ? F1.T.str.slice(0, n) : '');
    const m = cardMove(t, F1.a + 0.2, F1.b, 960, 705, 0.95, { dy: 260, rx: 14 });
    const push = E.inOutCubic(seg(t, 15.0, 18.7));
    m.s *= lerp(1, 1.07, push); m.y -= push * 20;
    put(F1.host, m);
    drawNote(F1.note, t, 16.5, F1.b, 1530, 380);
  }

  // ═══ F2 — a team of real specialists, @Name (19 – 26) ═══════════════════════
  const F2 = feature(19.0, 26.0, 'A team of *real specialists.*', 'Each one has its own face, colour and voice. Talk to any of them with @Name.');
  F2.team = host('specialists_0');
  F2.ch = host('specialists_1');
  F2.rows = F2.team.querySelectorAll('.team3-row');
  F2.pop = F2.ch.querySelector('.ch3-pop');
  F2.inp = F2.ch.querySelector('.ch3-in b');
  F2.u = F2.ch.querySelector('.ch3-u');
  F2.m = F2.ch.querySelector('.ch3-m');
  F2.Tin = Typer('@Em', 22.75, 6, { soft: true });
  F2.rows.forEach((r, i) => cue(19.6 + i * 0.25, 'pop', 0.35));
  cue(22.0, 'whoosh', 0.45); cue(23.5, 'send'); cue(24.2, 'pop', 0.6);
  function sceneF2(t) {
    const vis = t > F2.a - 0.05 && t < F2.b + 0.05;
    [F2.team, F2.ch].forEach((e) => (e.style.display = vis ? '' : 'none')); if (!vis) return;
    F2.rows.forEach((r, i) => {
      const k = spring(t - (19.6 + i * 0.25), 1.8, 0.7);
      r.style.opacity = (t < 19.6 + i * 0.25 ? 0 : clamp(k * 1.3)).toFixed(3); r.style.transform = 'translateY(' + ((1 - k) * 16).toFixed(2) + 'px)';
    });
    const slide = E.inOutQuint(seg(t, 21.8, 22.5));
    put(F2.team, cardMove(t, F2.a + 0.25, F2.b, lerp(960, 590, slide), 680, lerp(2.0, 1.85, slide), { dy: 200 }));
    put(F2.ch, cardMove(t, 22.0, F2.b, 1340, 680, 1.85, { dx: 240, dy: 30, rx: 0 }));
    setHTML(F2.inp, t < 23.45 ? typeHTML(F2.Tin, t, { fresh: false }) : '');
    const popk = E.outCubic(seg(t, 22.6, 22.85)) * (1 - seg(t, 23.4, 23.55));
    F2.pop.style.opacity = popk.toFixed(3); F2.pop.style.transform = 'translateY(' + ((1 - popk) * 10).toFixed(1) + 'px)';
    const popH = F2.pop.scrollHeight;
    const fold = 1 - E.inOutCubic(seg(t, 23.45, 23.75));
    F2.pop.style.overflow = 'hidden'; F2.pop.style.maxHeight = (t < 22.4 ? 0 : popH * (t < 23.45 ? E.outCubic(seg(t, 22.4, 22.65)) : fold)).toFixed(1) + 'px';
    F2.pop.style.marginBottom = (t < 23.45 && t >= 22.4 ? '' : '0px');
    // a soft highlight walks onto Emma in the menu
    const uk = spring(t - 23.5, 1.9, 0.65), mk = spring(t - 24.2, 1.8, 0.65);
    F2.u.style.opacity = (t < 23.5 ? 0 : clamp(uk * 1.4)).toFixed(3); F2.u.style.transform = 'translateY(' + ((1 - uk) * 16).toFixed(1) + 'px)';
    F2.m.style.opacity = (t < 24.2 ? 0 : clamp(mk * 1.4)).toFixed(3); F2.m.style.transform = 'translateY(' + ((1 - mk) * 16).toFixed(1) + 'px)';
    // the chat grows as each message arrives
    [[F2.u, 23.5], [F2.m, 24.2]].forEach(([e, t0]) => { const g = E.outCubic(seg(t, t0 - 0.05, t0 + 0.3)); e.style.maxHeight = g >= 1 ? '' : (e.scrollHeight * g).toFixed(1) + 'px'; e.style.overflow = g >= 1 ? '' : 'hidden'; e.style.marginTop = g > 0 ? '' : '0px'; e.style.marginBottom = g > 0 ? '' : '0px'; e.style.paddingTop = g > 0 ? '' : '0px'; e.style.paddingBottom = g > 0 ? '' : '0px'; });
  }

  // ═══ F3 — any app, one click away (26 – 32) ═════════════════════════════════
  const F3 = feature(26.0, 32.0, 'Any app, *one click away.*', 'Search 34,000+ apps in the MCP Registry, or pick Gmail, Slack, GitHub and more.');
  F3.h = host('apps_0');
  F3.search = F3.h.querySelector('.apps3-search em');
  F3.rows = F3.h.querySelectorAll('.apps3-row');
  F3.btn = [...F3.rows].map((r) => r.querySelector('em'));
  F3.flo = [['/assets/gmail.webp', 360, 420], ['/assets/slack.webp', 1560, 440], ['/assets/github.webp', 330, 830], ['/assets/vercel.webp', 1590, 850],
    ['/assets/supabase.webp', 520, 620], [LOBE('notion'), 1420, 650], [LOBE('zapier-color'), 1750, 640], [LOBE('figma-color'), 180, 630]]
    .map(([src, x, y], i) => ({ e: S('<div class="flo">' + iconImg(src) + '</div>'), x, y, i }));
  const connect = (i, tt) => {
    at(tt, () => { F3.btn[i].textContent = 'Connected'; F3.btn[i].style.background = 'rgba(76,195,138,.16)'; F3.btn[i].style.color = '#4cc38a'; F3.btn[i].style.borderColor = 'transparent'; });
    curKey(tt - 0.4, center(F3.btn[i])); curKey(tt + 0.15, center(F3.btn[i])); press(tt - 0.05, center(F3.btn[i]));
  };
  curKey(28.0, 1560, 1040);
  connect(1, 28.55); connect(2, 29.3); connect(3, 30.05);
  F3.flo.forEach((f) => cue(26.6 + f.i * 0.12, 'pop', 0.22));
  function sceneF3(t) {
    const vis = t > F3.a - 0.05 && t < F3.b + 0.05;
    [F3.h].concat(F3.flo.map((f) => f.e)).forEach((e) => (e.style.display = vis ? '' : 'none')); if (!vis) return;
    const n = Math.round(34000 * E.outQuart(seg(t, 26.5, 27.6)));
    setText(F3.search, 'Search ' + n.toLocaleString('en-US') + '+ apps');
    put(F3.h, cardMove(t, F3.a + 0.25, F3.b, 960, 690, 1.95, { dy: 200 }));
    F3.flo.forEach((f) => {
      const t0 = 26.6 + f.i * 0.12, k = spring(t - t0, 1.4, 0.6);
      const out = E.inCubic(seg(t, F3.b - 0.3, F3.b));
      const dx = (f.x - 960) * (1 - k) * -0.5, dy = (f.y - 640) * (1 - k) * -0.5;
      put(f.e, { x: f.x + dx, y: f.y + dy + Math.sin(t * 1.3 + f.i) * 8, s: lerp(0.4, 1, clamp(k)) * (f.i % 3 === 0 ? 1.08 : 0.92), o: (t < t0 ? 0 : clamp(k * 1.5)) * (1 - out), blur: out * 12 + (f.i % 2) * 1.5, r: Math.sin(t * 0.8 + f.i) * 4 });
    });
  }

  // ═══ F4 — close the laptop, it keeps going (32 – 38) ════════════════════════
  const F4 = feature(32.0, 38.0, 'Close the laptop. *It keeps going.*', 'Your chat moves to Codeply Cloud, finishes the job and opens a pull request.');
  F4.ph = host('codeply_1');
  F4.pa = F4.ph.querySelector('.pa'); F4.typed = F4.ph.querySelector('.pa-typed'); F4.u = F4.ph.querySelector('.pa-u'); F4.lis = F4.ph.querySelectorAll('.pa-a li');
  F4.ph.querySelector('.pv-wrap').style.setProperty('--s', '1');
  F4.card = S('<div style="width:330px">' + SNIP.gcard_pr + '</div>');
  F4.card.querySelector('.gcard').classList.add('on');
  F4.merge = F4.card.querySelector('em.pri'); F4.prTitle = F4.card.querySelector('b');
  F4.ask = "Add dark mode to settings. Keep going in the cloud, I'm heading out";
  F4.T = Typer(F4.ask, 32.75, 36, { soft: true });
  at(32.7, () => F4.pa.classList.add('typing'));
  at(34.75, () => { F4.pa.classList.remove('typing'); F4.pa.classList.add('sent'); F4.u.textContent = F4.ask; });
  at(34.95, () => F4.pa.classList.add('working'));
  at(35.6, () => { F4.pa.classList.remove('working'); F4.pa.classList.add('did'); });
  at(35.72, () => F4.pa.classList.add('answered'));
  [35.9, 36.15, 36.4].forEach((x, i) => at(x, () => F4.lis[i] && F4.lis[i].classList.add('on')));
  at(37.05, () => { F4.prTitle.textContent = 'Merged into main'; F4.merge.textContent = 'Merged'; });
  cue(34.75, 'send'); cue(36.0, 'notify');
  curKey(36.3, 1720, 1020); curKey(36.85, center(F4.merge, 6, 4)); curKey(37.4, center(F4.merge, 6, 4));
  press(37.0, center(F4.merge));
  function sceneF4(t) {
    const vis = t > F4.a - 0.05 && t < F4.b + 0.05;
    [F4.ph, F4.card].forEach((e) => (e.style.display = vis ? '' : 'none')); if (!vis) return;
    let n = 0; while (n < F4.T.times.length && F4.T.times[n] <= t) n++;
    setText(F4.typed, t < 34.75 ? F4.ask.slice(0, n) : '');
    put(F4.ph, cardMove(t, F4.a + 0.2, F4.b, 720, 690, 1.0, { dy: 300, rx: 10 }));
    const ck = spring(t - 36.0, 1.7, 0.6);
    const out = E.inCubic(seg(t, F4.b - 0.3, F4.b));
    const pressK = (t > 36.97 && t < 37.17) ? 1 - Math.sin(seg(t, 36.97, 37.17) * Math.PI) * 0.04 : 1;
    put(F4.card, { x: 1320, y: 600 + (1 - ck) * -60, s: 1.9 * lerp(0.85, 1, ck) * pressK, o: (t < 36.0 ? 0 : clamp(ck * 1.5)) * (1 - out), blur: (1 - clamp(ck)) * 12 + out * 14 });
  }

  // ═══ F5 — make Codeply yours: wallpaper, font, text size, spacing (38 – 46) ═
  const F5 = feature(38.0, 46.0, 'Make Codeply *yours.*', 'Pick a wallpaper, then the font, text size and spacing you like to read.');
  (function () {
    const w = appWindow(true); F5.host = w.h; F5.ap = w.ap;
    w.ap.classList.add('sent', 'did', 'answered', 'changed');
    w.ap.querySelectorAll('.ap-a li').forEach((l) => l.classList.add('on'));
    F5.walls = ['/assets/wallpaper.webp', '/assets/site/scene.webp', '/Background.png', 'linear-gradient(135deg,#1d3d7a,#7d4cff 55%,#ff9fc0)'];
    F5.layers = F5.walls.map((wp) => { const l = document.createElement('div'); l.className = 'wp-l'; l.style.backgroundImage = wp.startsWith('linear') ? wp : 'url(' + wp + ')'; l.style.transition = 'none'; l.style.position = 'absolute'; l.style.inset = '0'; w.ap.insertBefore(l, w.ap.firstChild); return l; });
    w.ap.querySelectorAll('.ap-bar,.ap-body').forEach((x) => { x.style.position = 'relative'; x.style.zIndex = 2; });
    F5.text = [w.ap.querySelector('.ap-a'), w.ap.querySelector('.ap-u')];
    F5.ul = w.ap.querySelector('.ap-a ul'); F5.p = w.ap.querySelector('.ap-a p');
    // the Appearance settings, drawn like the other 3.0 menus
    F5.set = S('<div class="ui3"><div class="ui3-card ap3">' +
      '<div class="ap3-h">Appearance</div>' +
      '<div class="ap3-l">Wallpaper</div><div class="ap3-wp">' + F5.walls.map((wp) => '<i style="background-image:' + (wp.startsWith('linear') ? wp : 'url(' + wp + ')') + '"></i>').join('') + '</div>' +
      '<div class="ap3-l">Font</div><div class="ap3-seg f"><span class="on">Default</span><span>Serif</span><span>Mono</span></div>' +
      '<div class="ap3-l">Text size <em>15 px</em></div><div class="ap3-size"><small>A</small><div class="ap3-track"><div class="ap3-fill"></div><div class="ap3-knob"></div></div><big>A</big></div>' +
      '<div class="ap3-l">Spacing</div><div class="ap3-seg s"><span class="on">Compact</span><span>Relaxed</span></div>' +
      '</div></div>');
    F5.wp = F5.set.querySelectorAll('.ap3-wp i');
    F5.fonts = F5.set.querySelectorAll('.ap3-seg.f span');
    F5.sp = F5.set.querySelectorAll('.ap3-seg.s span');
    F5.knob = F5.set.querySelector('.ap3-knob'); F5.fill = F5.set.querySelector('.ap3-fill'); F5.track = F5.set.querySelector('.ap3-track');
    F5.sizeLabel = F5.set.querySelector('.ap3-l em');
  })();
  // what gets picked, and when (on the beat)
  F5.wpPicks = [[38.0, 0], [39.0, 1], [43.5, 3]];
  F5.fontAt = 40.0; F5.sizeA = 41.0; F5.sizeB = 42.0; F5.relaxAt = 42.75;
  const FONTS = ["'Inter', sans-serif", "'Source Serif 4', Georgia, serif", "'Geist Mono', monospace"];
  curKey(38.55, 1700, 1060);
  [[39.0, () => F5.wp[1]], [40.0, () => F5.fonts[1]], [42.75, () => F5.sp[1]], [43.5, () => F5.wp[3]]].forEach(([tt, g]) => {
    curKey(tt - 0.35, () => center(g())()); curKey(tt + 0.12, () => center(g())()); press(tt - 0.04, () => center(g())());
  });
  // the text-size drag
  const knobAt = () => { const r = F5.knob.getBoundingClientRect(); return { x: r.left + r.width / 2 + 4, y: r.top + r.height / 2 + 6 }; };
  curKey(40.6, knobAt); curKey(F5.sizeA, knobAt); curKey(F5.sizeB, knobAt); curKey(42.3, knobAt);
  PRESS.push(F5.sizeA - 0.02); cue(F5.sizeA, 'tick', 0.6); cue(F5.sizeB, 'tick', 0.8);
  function sceneF5(t) {
    const vis = t > F5.a - 0.05 && t < F5.b + 0.05;
    [F5.host, F5.set].forEach((e) => (e.style.display = vis ? '' : 'none')); if (!vis) return;
    // wallpaper: the newest fades in over the last one and settles from a slight zoom
    let cur = 0, prev = 0, ts = 0;
    F5.wpPicks.forEach(([tt, i]) => { if (t >= tt) { prev = cur; cur = i; ts = tt; } });
    const k = E.outCubic(seg(t, ts, ts + 0.6));
    F5.layers.forEach((l, i) => {
      let o = 0, s = 1;
      if (i === cur) { o = ts === F5.wpPicks[0][0] ? 1 : k; s = lerp(1.06, 1, k); } else if (i === prev) o = 1;
      l.style.opacity = o; l.style.transform = 'scale(' + s.toFixed(4) + ')'; l.style.zIndex = i === cur ? 1 : 0;
    });
    F5.wp.forEach((d, i) => d.classList.toggle('on', i === cur));
    // font
    const serif = t >= F5.fontAt;
    F5.fonts.forEach((s, i) => s.classList.toggle('on', i === (serif ? 1 : 0)));
    const dip = t > F5.fontAt - 0.02 && t < F5.fontAt + 0.25 ? E.outCubic(seg(t, F5.fontAt, F5.fontAt + 0.25)) : 1;
    // size: 15 -> 19 px while the knob is dragged
    const sk = E.inOutCubic(seg(t, F5.sizeA, F5.sizeB));
    const px = lerp(15, 19, sk);
    F5.knob.style.left = 'calc(' + (sk * 100).toFixed(2) + '% - 13px)'; F5.fill.style.width = (sk * 100).toFixed(2) + '%';
    setText(F5.sizeLabel, Math.round(px) + ' px');
    // spacing: compact -> relaxed
    const rk = E.inOutCubic(seg(t, F5.relaxAt, F5.relaxAt + 0.5));
    F5.sp.forEach((s, i) => s.classList.toggle('on', i === (t >= F5.relaxAt ? 1 : 0)));
    F5.text.forEach((e) => { e.style.fontFamily = FONTS[serif ? 1 : 0]; e.style.fontSize = px.toFixed(2) + 'px'; e.style.lineHeight = lerp(1.5, 1.9, rk).toFixed(3); e.style.opacity = dip.toFixed(3); });
    F5.ul.style.gap = lerp(8, 18, rk).toFixed(1) + 'px'; F5.p.style.marginBottom = lerp(12, 22, rk).toFixed(1) + 'px';
    put(F5.host, cardMove(t, F5.a + 0.2, F5.b, 700, 700, 0.8, { dy: 240, rx: 12 }));
    put(F5.set, cardMove(t, F5.a + 0.45, F5.b, 1530, 700, 1.55, { dx: 200, dy: 40, rx: 0 }));
  }

  // ═══ F6 — talk to it, Wisp listens (46 – 49.6) ═══════════════════════════════
  const F6 = feature(46.0, 49.6, 'Talk to it. *Wisp listens.*', 'Live captions, and a face that follows how the conversation feels.');
  F6.h = host('voice_0');
  F6.cap = F6.h.querySelector('.vo3-cap'); F6.face = F6.h.querySelector('[data-wisp]');
  F6.T = Typer('The checkout fix shipped. All 24 tests pass.', 46.7, 26, { silent: true });
  at(46.5, () => F6.face.wisp && F6.face.wisp.setMood('thinking'));
  at(48.4, () => F6.face.wisp && F6.face.wisp.setMood('happy'));
  function sceneF6(t) {
    const vis = t > F6.a - 0.05 && t < F6.b + 0.05;
    F6.h.style.display = vis ? '' : 'none'; if (!vis) return;
    let n = 0; while (n < F6.T.times.length && F6.T.times[n] <= t) n++;
    setText(F6.cap, F6.T.str.slice(0, n));
    put(F6.h, cardMove(t, F6.a + 0.2, F6.b, 960, 680, 1.12, { dy: 240, rx: 12 }));
  }

  // ═══ AM — ambient intelligence (49.6 – 54), then the end card (54 – 60) ═══════
  const AM = {};
  AM.t1 = S(''); AM.W1 = Words(AM.t1, 'Ambient *intelligence.*', 50.0, 0.3, 'onsky huge');
  AM.t2 = S(''); AM.W2 = Words(AM.t2, 'It keeps track of your code, inbox and calendar, and calls you when something needs a yes.', 50.75, 0.05, 'onsky line');
  AM.W1.ws.forEach((w) => cue(w.t, 'thud', 0.7));
  const gcard = (inner) => '<div style="width:330px"><div class="gcard on">' + inner + '</div></div>';
  AM.cards = [
    [SNIP.gcard_pr.replace('<div class="gcard">', '<div class="gcard on">'), 330, 250, -3, 51.0],
    [gcard('<div class="gb"><span class="av" data-wisp="sm" data-shape="circle" data-color="#ff6fa3"></span><div><b>Emma</b><div class="gs">Plumber Thursday at 10. Added it to your calendar.</div></div></div>'), 1590, 245, 3, 51.5],
    [SNIP.gcard_call.replace('<div class="gcard">', '<div class="gcard on">'), 1560, 860, -2, 52.0],
    [gcard('<div class="gh"><span><i></i>Codeply · Calendar</span><span>now</span></div><b>Blocked 3 to 4 PM</b><div class="gs">A free hour for the pricing page. Nothing else moved.</div><div class="ga"><em class="pri">Keep</em><em>Undo</em></div>'), 370, 850, 2, 52.5],
  ].map(([html, x, y, r, t0]) => {
    const h = S(html.startsWith('<div style') ? html : '<div style="width:330px">' + html + '</div>');
    window.Wisp.mount(h);
    cue(t0, 'notify', 0.45);
    return { h, x, y, r, t0 };
  });
  // the end card
  const Z = {};
  Z.lock = S('<div class="lockup"></div>');
  Z.wisp = S('<div class="bigwisp"><i data-wisp="" data-mood="neutral"></i></div>');
  window.Wisp.mount(Z.wisp);
  Z.W = Z.wisp.querySelector('[data-wisp]').wisp;
  Z.name = S('<div class="lockup-name">Codeply</div>');
  Z.badge = S('<div class="badge3">3.0</div>');
  Z.btn = S('<div class="cta-btn"><svg viewBox="0 0 24 24"><path d="M3 5.6 10.4 4.6v7H3zM11.4 4.4 21 3v8.6h-9.6zM3 12.6h7.4v7L3 18.5zM11.4 12.6H21V21l-9.6-1.3z"/></svg><span>Download for Windows</span><span class="free">Free</span></div>');
  Z.sub = S('<div class="cta-sub">Windows · macOS · codeply.app</div>');
  Z.rings = [0, 1].map(() => S('<div class="ring"></div>'));
  at(54.02, () => Z.W.setMood('happy')); at(55.2, () => Z.W.setMood('neutral')); at(56.55, () => Z.W.setMood('happy'));
  cue(54.0, 'impact', 0.9); cue(55.0, 'pop', 0.7);
  curKey(55.6, 1720, 1050); curKey(56.35, center(Z.btn, 10, 12)); curKey(57.4, center(Z.btn, 10, 12));
  press(56.5, center(Z.btn));
  function sceneAM(t) {
    const vis = t > 49.5;
    [AM.t1, AM.t2].concat(AM.cards.map((c) => c.h)).forEach((e) => (e.style.display = vis ? '' : 'none'));
    [Z.lock, Z.wisp, Z.name, Z.badge, Z.btn, Z.sub].concat(Z.rings).forEach((e) => (e.style.display = t > 53.4 ? '' : 'none'));
    if (!vis) return;
    drawWords(AM.W1, t); drawWords(AM.W2, t);
    const out = E.inCubic(seg(t, 53.35, 53.75));
    put(AM.t1, { x: 960, y: 445 - out * 40, o: 1 - out, blur: out * 20, s: 1 + (t - 50) * 0.006 });
    put(AM.t2, { x: 960, y: 610 - out * 40, o: 1 - out, blur: out * 20 });
    // the glass cards drift in and stay around the end card
    AM.cards.forEach((c, i) => {
      const k = spring(t - c.t0, 1.3, 0.7);
      if (t < c.t0) { c.h.style.display = 'none'; return; }
      const fromX = c.x + (c.x < 960 ? -260 : 260);
      const later = seg(t, 54.0, 55.0);
      put(c.h, { x: lerp(fromX, c.x, k) + (c.x < 960 ? -1 : 1) * later * 30, y: c.y + Math.sin((t - c.t0) * 0.9 + i) * 8, s: 1.32 * lerp(0.85, 1, k) * (1 - later * 0.06), r: c.r * k, o: clamp(k * 1.5), blur: (1 - clamp(k)) * 14 + later * 1.5 });
    });
    if (t <= 53.4) return;
    // the mascot falls in on the downbeat (54.0) and becomes the logo
    const total = LOCK_TOTAL, left = 960 - total / 2, Y = 440;
    let x = 960, y, sx = 1, sy = 1, s = 1;
    if (t < 54.0) { const k = E.inCubic(seg(t, 53.6, 54.0)); y = lerp(-220, Y + 10, k); sy = lerp(1, 1.18, k); sx = lerp(1, 0.88, k); }
    else {
      const u = t - 54.0, sq = Math.exp(-u * 7) * Math.cos(u * 26);
      sx = 1 + 0.25 * sq; sy = 1 - 0.25 * sq; y = Y + 10 - Math.max(0, Math.sin(u * 9)) * 26 * Math.exp(-u * 6);
      const m = E.inOutQuint(seg(t, 54.2, 54.65)); x = lerp(960, left + 96, m); s = lerp(1, 0.6, m); y = lerp(y, Y, m);
    }
    const hop = t > 56.55 ? Math.max(0, Math.sin((t - 56.55) * 10)) * 26 * Math.exp(-(t - 56.55) * 4) : 0;
    const push = 1 + Math.max(0, t - 54.6) * 0.006;
    const P = (px, py) => ({ x: 960 + (px - 960) * push, y: 540 + (py - 540) * push });
    const pw = lerp(150, total, E.outExpo(seg(t, 54.26, 54.85)));
    Z.lock.firstChild.style.width = pw + 'px';
    const pillLeft = t < 54.65 ? x - lerp(75, 96, E.inOutQuint(seg(t, 54.2, 54.65))) : left;
    const lp = P(pillLeft + pw / 2, Y);
    put(Z.lock, { x: lp.x, y: lp.y, s: push, o: seg(t, 54.15, 54.26), sy: lerp(0.85, 1, seg(t, 54.15, 54.35)) });
    const nk = seg(t, 54.45, 54.75), np = P(left + 40 + 112 + 34 + 165, Y);
    Z.name.firstChild.style.width = '330px';
    put(Z.name, { x: np.x, y: np.y, s: push, o: nk, blur: (1 - nk) * 10 });
    const bk = t < 55.0 ? 0 : E.outBack(seg(t, 55.0, 55.35), 2.6), bp = P(left + total - 40 - 59, Y);
    put(Z.badge, { x: bp.x, y: bp.y, s: bk * push, o: bk > 0 ? 1 : 0, r: (1 - clamp(bk)) * -14 });
    const wp = P(x, y - hop);
    put(Z.wisp, { x: wp.x, y: wp.y, s: s * push, sx, sy });
    drawRings(Z.rings, t, 54.0, 960, Y + 10, 480);
    const bb = spring(t - 55.25, 1.6, 0.65), pd = t - 56.5;
    const pressS = pd > -0.06 && pd < 0.3 ? (pd < 0 ? 1 - (pd + 0.06) * 0.8 : lerp(0.95, 1, E.outBack(clamp(pd / 0.3)))) : 1;
    const btnP = P(960, 640);
    put(Z.btn, { x: btnP.x, y: btnP.y + (1 - bb) * 40, s: push * lerp(0.9, 1, bb) * pressS * 1.1, o: t < 55.25 ? 0 : clamp(bb * 1.5), blur: (1 - clamp(bb)) * 14 });
    const clicked = t >= 56.52;
    Z.btn.firstChild.style.background = clicked ? BLUE : '#fff';
    Z.btn.firstChild.style.color = clicked ? '#fff' : '#0b1628';
    const sb = spring(t - 55.6, 1.6, 0.65), sp = P(960, 752);
    put(Z.sub, { x: sp.x, y: sp.y + (1 - sb) * 20, s: push, o: t < 55.6 ? 0 : clamp(sb * 1.4), blur: (1 - clamp(sb)) * 10 });
  }

  // ─── the frame ────────────────────────────────────────────────────────────
  let lastT = null;
  window.__frame = function (t) {
    for (const e of EV) if (!e.done && t >= e.t) { e.done = true; e.fn(); }
    drawBackground(t);
    sceneH(t); sceneD(t);
    drawHeader(t);
    sceneF1(t); sceneF2(t); sceneF3(t); sceneF4(t); sceneF5(t); sceneF6(t);
    sceneAM(t);
    bctx.clearRect(0, 0, W, H);
    const b1 = drawBurst(t, 8.0, 960, 505, 1), b2 = drawBurst(t, 54.0, 960, 450, 0.8);
    burst.style.display = b1 || b2 ? '' : 'none';
    let fl = 0;
    fl = Math.max(fl, 0.5 * (1 - E.outCubic(seg(t, 8.0, 8.3))) * (t >= 8.0 ? 1 : 0));
    fl = Math.max(fl, 0.35 * (1 - E.outCubic(seg(t, 54.0, 54.25))) * (t >= 54.0 ? 1 : 0));
    flash.style.opacity = fl.toFixed(3);
    flash.style.display = fl < 0.002 ? 'none' : '';
    drawCursor(t); drawPings(t);
    const dt = lastT == null ? 0 : Math.max(0, t - lastT);
    for (const a of document.getAnimations()) {
      if (!a.__v) { a.__v = true; a.pause(); a.__t = 0; }
      else a.__t += dt * 1000;
      try { a.currentTime = a.__t; } catch (e) { /* finished */ }
    }
    lastT = t;
    return true;
  };
  window.__cues = function () { return CUES.slice().sort((a, b) => a.t - b.t); };
  window.__ready = true;
})();
