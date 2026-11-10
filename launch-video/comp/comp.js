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

  // ─── backgrounds over time ────────────────────────────────────────────────
  // which background shows: 'sky' (the site's hero scene) or 'paper' (the light stage)
  function drawBackground(t) {
    // paper opacity
    let po = 0;
    po = Math.max(po, seg(t, 7.3, 7.65) * (1 - seg(t, 10.05, 10.5)));
    po = Math.max(po, seg(t, 14.2, 14.55) * (1 - seg(t, 47.75, 48.1)));
    paperWrap.style.opacity = po.toFixed(3);
    paperWrap.style.display = po < 0.002 ? 'none' : '';
    // the sky: slow drift; blur in front of UI; sharp on the big moments
    let blur = 0, sc = 1.08, px = 0, py = 0;
    const drift = t * 0.004;
    if (t < 4.0) { blur = lerp(0, 3, seg(t, 0, 4)); sc = 1.10 + t * 0.006; px = -t * 6; }
    else if (t < 7.6) { blur = lerp(3, 18, E.outCubic(seg(t, 3.9, 4.6))); sc = 1.14 + (t - 4) * 0.01; px = -24 - (t - 4) * 4; }
    else if (t < 12.0) { blur = 26; sc = 1.16; px = 0; }
    else if (t < 14.6) { const k = E.outCubic(seg(t, 12.0, 12.45)); blur = lerp(26, 0, k); sc = lerp(1.24, 1.10, E.outExpo(seg(t, 12.0, 12.9))) + (t - 12) * 0.008; px = -(t - 12) * 8; }
    else if (t < 48.2) { blur = 30; sc = 1.1; }
    else if (t < 52.0) { blur = lerp(10, 0, E.outCubic(seg(t, 47.8, 48.5))); sc = 1.06 + (t - 48) * 0.012; px = (t - 48) * 10; py = -(t - 48) * 3; }
    else { blur = lerp(0, 8, E.inOutCubic(seg(t, 52.0, 53.0))); sc = 1.12 + (t - 52) * 0.008; px = 40 - (t - 52) * 6; }
    sky.style.transform = 'translate(' + px.toFixed(1) + 'px,' + py.toFixed(1) + 'px) scale(' + (sc + drift * 0).toFixed(4) + ')';
    sky.style.filter = blur > 0.1 ? 'blur(' + blur.toFixed(1) + 'px) saturate(1.08)' : 'saturate(1.08)';
    skyWrap.style.display = po >= 0.999 ? 'none' : '';
  }

  // ═══ SCENE A — the hook (0 – 4.2) ══════════════════════════════════════════
  const A = {};
  A.l1 = S(''); A.l1.className = 'tx white'; A.l1.style.font = "500 40px/1 'Geist'";
  A.T1 = Typer('This month, you asked your AI', 0.25, 36, { soft: true });
  A.cnt = S('<div class="counter" style="font-size:230px"></div>');
  A.counter = A.cnt.firstChild;
  // the digits of 1,284 roll like a slot machine; "prompts" sits after them
  A.cols = [];
  ['d', ',', 'd', 'd', 'd'].forEach((k) => {
    if (k === ',') { el('span', '', ',', A.counter); return; }
    const c = el('span', 'col', '', A.counter);
    const strip = el('span', 'strip', '', c);
    for (let r = 0; r < 3; r++) for (let d = 0; d <= 9; d++) el('span', '', String(d), strip);
    c.style.width = '0.5em';
    A.cols.push({ c, strip });
  });
  el('span', '', ' prompts', A.counter).style.paddingLeft = '0.12em';
  A.l2 = S(''); A.l2.className = 'tx white'; A.l2.style.font = "500 58px/1.1 'Geist'";
  A.T2 = Typer('And it waited for *every single one.*', 2.72, 30);
  cue(0.55, 'whoosh', 0.6); cue(2.45, 'swish', 0.5);
  function sceneA(t) {
    if (t > 4.4) { [A.l1, A.cnt, A.l2].forEach((e) => (e.style.display = 'none')); return; }
    const out1 = E.inCubic(seg(t, 2.42, 2.72));
    typeInto(A.l1, A.T1, t, { cursor: true, until: 0.62 });
    put(A.l1, { x: 960, y: 318 - out1 * 40, o: 1 - out1, blur: out1 * 14 });
    // counter
    const ci = E.outCubic(seg(t, 0.62, 1.05));
    const v = 1284 * E.outQuart(seg(t, 0.62, 2.05));
    const digits = [Math.floor(v / 1000) % 10, null, (v / 100) % 10, (v / 10) % 10, v % 10];
    let k = 0;
    digits.forEach((dv, i) => {
      if (dv === null) return;
      const col = A.cols[k++];
      // whole digits move on: each column rolls continuously, then settles exactly
      const settled = t >= 2.05;
      const target = [1, 2, 8, 4][k - 1];
      const pos = settled ? target + 10 : (i === 0 ? Math.floor(v / 1000) : dv) + 10;
      col.strip.style.transform = 'translateY(' + (-pos).toFixed(4) + 'em)';
      const speed = settled ? 0 : Math.abs(1284 * 4 * Math.pow(1 - seg(t, 0.62, 2.05), 3) / 1.43) / Math.pow(10, 3 - (k - 1));
      col.c.style.filter = speed > 3 ? 'blur(' + Math.min(5, speed * 0.05).toFixed(2) + 'px)' : 'none';
    });
    put(A.cnt, { x: 960, y: 575 + (1 - ci) * 60 - out1 * 50, o: ci * (1 - out1), blur: (1 - ci) * 22 + out1 * 22, s: lerp(0.94, 1, ci) });
    // second line
    const out2 = E.inCubic(seg(t, 4.0, 4.28));
    typeInto(A.l2, A.T2, t, { cursor: true, lead: 0.2 });
    put(A.l2, { x: 960, y: 532 - out2 * 30, o: (t > 2.5 ? 1 : 0) * (1 - out2), blur: out2 * 16, s: 1 + out2 * 0.04 });
  }

  // ═══ SCENE B — the 3.0 composer, huge, typing (3.9 – 7.6) ══════════════════
  const B = {};
  B.wrap = S('');
  B.wrap.className = 'L cmp-wrap';
  // the composer exactly as the 3.0 app draws it (from the site's app mockup)
  (function () {
    const tmp = document.createElement('div'); tmp.innerHTML = SNIP.codeply_6;
    const comp = tmp.querySelector('.ap-comp');
    B.ap = el('div', 'ap', '', B.wrap);
    B.ap.appendChild(comp);
    comp.style.width = '760px'; comp.style.margin = '0';
    B.typed = comp.querySelector('.ap-typed');
    B.send = comp.querySelector('.ap-send');
    B.car = comp.querySelector('.ap-car');
  })();
  B.T = Typer('Fix the checkout bug, test it and open a PR', 4.55, 26);
  B.camX = 0;
  at(4.5, () => B.ap.classList.add('typing'));
  at(6.86, () => { B.ap.classList.remove('typing'); });
  cue(3.95, 'whoosh', 0.8); cue(6.95, 'swoosh', 0.9);
  // the cursor comes in and presses send
  curKey(6.25, 1640, 1010);
  curKey(6.72, center(B.send, 4, 6));
  curKey(6.95, center(B.send, 4, 6));
  press(6.8, center(B.send));
  function sceneB(t) {
    if (t < 3.85 || t > 7.65) { B.wrap.style.display = 'none'; return; }
    // text
    let n = 0; while (n < B.T.times.length && B.T.times[n] <= t) n++;
    setText(B.typed, t < 6.86 ? B.T.str.slice(0, n) : '');
    // camera: big, following the caret; then pull back for the send
    const ein = spring(t - 3.92, 1.6, 0.62);
    const pull = E.inOutCubic(seg(t, 6.12, 6.7));
    const scBig = 3.1, scSmall = 1.55;
    let sc = lerp(lerp(1.7, scBig, ein), scSmall, pull);
    // caret on screen with no camera move
    const caretLocal = 16 + 18 + (B.typed.offsetWidth || 0);           // px from the composer's left edge
    const leftBig = 260 - 16 * scBig;                                  // where the composer's left edge sits when big
    const caretX = leftBig + caretLocal * scBig;
    const want = Math.min(0, 1380 - caretX);
    B.camX = lerp(B.camX, want, 0.16);
    const xBig = leftBig + (760 * scBig) / 2 + B.camX;
    let x = lerp(xBig, 960, pull), y = lerp(560, 560, pull);
    // entering from low right, blurred
    x += (1 - ein) * 420; y += (1 - ein) * 260;
    const r = (1 - ein) * -6;
    const out = E.inCubic(seg(t, 6.98, 7.5));
    const o = clamp(ein * 2) * (1 - out);
    put(B.wrap, { x, y, s: sc * (1 + out * 0.5), r, o, blur: (1 - clamp(ein * 1.4)) * 20 + out * 26 });
    // send press
    const pd = t - 6.8;
    B.send.style.transform = pd > -0.05 && pd < 0.25 ? 'scale(' + (pd < 0 ? 1 - (pd + 0.05) * 3 : 0.85 + 0.15 * E.outBack(pd / 0.25)).toFixed(3) + ')' : '';
  }

  // ═══ SCENE C — "What if it was already on it?" + the app carousel (7.35 – 10.6) ═
  const C = {};
  C.glow = S('<div class="car-glow"></div>');
  C.head = S(''); C.head.className = 'tx'; C.head.style.font = "500 56px/1.1 'Geist'";
  C.T = Typer('What if it was *already on it?*', 7.55, 30);
  C.pill = S('<div class="car-pill" style="width:600px;height:100px"></div>');
  C.plug = S('<div class="car-plug">' + OI.sparkle_c + '<span style="letter-spacing:3px">- -</span></div>');
  const CAR_ITEMS = [
    ['Gmail', iconImg('/assets/gmail.webp')], ['Slack', iconImg('/assets/slack.webp')], ['GitHub', iconImg('/assets/github.webp')],
    ['Calendar', '<span class="ic" style="display:grid;place-items:center;background:#eef3ff;color:#2F6BFF">' + OI.calendar_c + '</span>'],
    ['Vercel', iconImg('/assets/vercel.webp')], ['Supabase', iconImg('/assets/supabase.webp')],
    ['Claude Code', iconImg(LOBE('claude-color'))], ['Notion', iconImg(LOBE('notion'))], ['Zapier', iconImg(LOBE('zapier-color'))],
    ['Figma', iconImg(LOBE('figma-color'))], ['Cloudflare', iconImg(LOBE('cloudflare-color'))], ['Ollama', iconImg(LOBE('ollama'))],
    ['Gmail', iconImg('/assets/gmail.webp')], ['Codeply', '<img src="/assets/mascot.svg" alt="">'],
  ];
  C.items = CAR_ITEMS.map(([name, ic]) => S('<div class="car-item">' + ic + '<span>' + name + '</span></div>'));
  C.items[C.items.length - 1].querySelector('span').style.fontWeight = '600';
  // where the list stands at time t: ticks on the beat, then a spin that lands on Codeply
  const CK = [[7.62, 0], [8.0, 1], [8.5, 2], [8.85, 3], [9.12, 4], [9.32, 5], [9.47, 6]];
  CK.slice(1).forEach((k) => cue(k[0], 'tick'));
  cue(9.55, 'spin'); cue(9.98, 'land');
  function carPos(t) {
    if (t < CK[0][0]) return 0;
    for (let i = 1; i < CK.length; i++) {
      if (t < CK[i][0]) {
        const a = CK[i - 1], b = CK[i];
        return a[1] + (b[1] - a[1]) * E.outBack(clamp((t - a[0]) / 0.2), 2.2) * (t >= a[0] ? 1 : 0) + 0 * b[1];
      }
    }
    // the last tick, then spin from 6 to 13 and land with a bounce
    const t0 = 9.5, last = 13;
    if (t < t0) return 6;
    const k = seg(t, t0, 10.02);
    const p = 6 + (last - 6) * E.inOutQuint(k);
    if (t < 10.02) return p;
    return last + Math.sin((t - 10.02) * 22) * 0.12 * Math.exp(-(t - 10.02) * 9);
  }
  // fix the ticks: each tick moves one item over 0.2s, overshooting
  function carPos2(t) {
    if (t < 9.5) {
      let p = 0;
      for (let i = 1; i < CK.length; i++) if (t >= CK[i][0]) p = CK[i][1] - 1 + E.outBack(clamp((t - CK[i][0]) / 0.22), 2.4);
      return p;
    }
    return carPos(t);
  }
  function sceneC(t) {
    const vis = t > 7.3 && t < 10.8;
    [C.glow, C.head, C.pill, C.plug].concat(C.items).forEach((e) => (e.style.display = vis ? '' : 'none'));
    if (!vis) return;
    const hb = bio(t, 7.42, 0, 10.0, 0, { dout: 0.3 });
    typeInto(C.head, C.T, t, { cursor: true, lead: 0.15 });
    put(C.head, { x: 960, y: 300 - hb.ko * 30, o: hb.o, blur: hb.blur, s: hb.s });
    const pb = bio(t, 7.5, 0, 10.0, 0, { din: 0.45, dout: 0.35, sout: 1.08 });
    put(C.glow, { x: 960, y: 590, o: pb.o * 0.9 });
    put(C.pill, { x: 960, y: 590, o: pb.o, blur: pb.blur, s: pb.s });
    put(C.plug, { x: 960 - 300 + 56, y: 590, o: pb.o * (1 - seg(t, 9.95, 10.1)), blur: pb.blur, s: pb.s });
    // the list
    const p = carPos2(t), prev = carPos2(t - 1 / 60);
    const speed = Math.abs(p - prev) * 60; // items per second
    const ITEM = 86, LEFT = 960 - 300 + 136;
    C.items.forEach((it, i) => {
      const d = i - p, y = 590 + d * ITEM;
      const ad = Math.abs(d);
      const o = ad < 0.5 ? 1 : clamp(1 - (ad - 0.5) * 0.36) * 0.75;
      const blur = Math.min(10, speed * 0.32) + (ad > 0.5 ? (ad - 0.5) * 1.2 : 0);
      const sc = ad < 0.5 ? 1.06 : 0.92;
      const last = i === C.items.length - 1;
      // the Codeply row's text leaves as the mascot pops out
      const fade = last ? 1 - seg(t, 10.0, 10.18) : 1 - seg(t, 10.0, 10.2);
      put(it, { x: LEFT + (it.offsetWidth * sc) / 2, y, o: ad > 4.2 ? 0 : o * pb.o * fade, blur: blur + (last ? seg(t, 10.0, 10.18) * 10 : 0), s: sc });
    });
  }

  // ═══ SCENE D — the mascot drops, the logo, "3.0" (10.0 – 14.5) ═══════════
  const D = {};
  D.shadow = S('<div class="shadow-blob"></div>');
  D.lock = S('<div class="lockup"></div>');
  D.name = S('<div class="lockup-name"></div>');
  D.badge = S('<div class="badge3">3.0</div>');
  D.wisp = S('<div class="bigwisp"><i data-wisp="" data-mood="neutral"></i></div>');
  window.Wisp.mount(D.wisp);
  D.W = D.wisp.querySelector('[data-wisp]').wisp;
  D.Tn = Typer('Codeply', 12.5, 20, { silent: false });
  D.sub = S(''); D.sub.className = 'tx white'; D.sub.style.font = "500 48px/1.1 'Geist'";
  D.Ts = Typer('The biggest release *yet.*', 13.1, 28);
  D.rings = [0, 1, 2].map(() => S('<div class="ring"></div>'));
  at(12.02, () => D.W.setMood('happy'));
  at(13.35, () => D.W.setMood('neutral'));
  cue(10.0, 'pop', 1); cue(11.55, 'riser_end'); cue(12.0, 'impact'); cue(12.95, 'pop', 0.8); cue(14.2, 'whoosh', 0.9);
  // the halftone burst, like the reference's dotted ring
  const DOTS = []; for (let i = 0; i < 520; i++) DOTS.push({ a: hash(i) * Math.PI * 2, r: hash(i + 999), s: hash(i + 77) });
  function drawBurst(t, t0, cx, cy, scale) {
    const d = t - t0;
    if (d < 0 || d > 0.95) return false;
    const k = E.outCubic(d / 0.95);
    const R = (120 + 760 * k) * scale, band = (60 + 160 * k) * scale;
    bctx.globalAlpha = 1;
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
  function wispPose(t) {
    // returns {x, y, s, sx, sy, r}
    if (t < 10.0) return null;
    let x = 960, y = 500, s = 1, sx = 1, sy = 1, r = 0;
    if (t < 10.65) {
      // pops out of the pill (the Codeply row's icon) and grows
      const k = spring(t - 10.0, 1.7, 0.55);
      x = lerp(960 - 300 + 136 + 24, 960, clamp(k)); y = lerp(590, 500, k);
      s = lerp(50 / 260, 1, k);
      r = (1 - clamp(k)) * -20;
    } else if (t < 11.55) {
      const u = t - 10.65;
      y = 500 + Math.sin(u * 4.2) * 9; r = Math.sin(u * 2.6) * 3;
    } else if (t < 11.9) {
      const k = E.outCubic(seg(t, 11.55, 11.9));
      y = lerp(500 + Math.sin(0.9 * 4.2) * 9, 400, k); sy = lerp(1, 1.1, k); sx = lerp(1, 0.93, k);
    } else if (t < 12.0) {
      const k = E.inCubic(seg(t, 11.9, 12.0));
      y = lerp(400, 545, k); sy = lerp(1.1, 1.16, k); sx = lerp(0.93, 0.88, k);
    } else {
      // squash, then spring back, then move into the logo
      const u = t - 12.0;
      const sq = Math.exp(-u * 7) * Math.cos(u * 26);
      sx = 1 + 0.26 * sq; sy = 1 - 0.26 * sq;
      y = 545 - Math.max(0, Math.sin(u * 9)) * 30 * Math.exp(-u * 6);
      const m = E.inOutQuint(seg(t, 12.18, 12.68));
      x = lerp(960, D.lockLeft + 96, m); y = lerp(y, 540, m); s = lerp(1, 0.6, m);
    }
    return { x, y, s, sx, sy, r };
  }
  D.lockLeft = 960 - 380;
  function sceneD(t) {
    const vis = t >= 10.0 && t < 14.7;
    [D.shadow, D.lock, D.name, D.badge, D.wisp, D.sub].concat(D.rings).forEach((e) => (e.style.display = vis ? '' : 'none'));
    if (!vis) return;
    const out = E.inCubic(seg(t, 14.15, 14.55));
    const P = wispPose(t);
    // the lockup: a pill that opens to the right of the mascot
    const nameW = 330, badgeW = 118, total = 40 + 112 + 34 + nameW + 26 + badgeW + 40; // ≈ 700
    D.lockLeft = 960 - total / 2;
    const open = E.outExpo(seg(t, 12.32, 12.95));
    const pw = lerp(150, total, open);
    const lockO = seg(t, 12.25, 12.36);
    D.lock.firstChild.style.width = pw + 'px';
    const zoomOut = 1 + out * 0.35;
    put(D.lock, { x: D.lockLeft + pw / 2, y: 540, o: lockO * (1 - out), blur: out * 22, s: zoomOut });
    typeInto(D.name.firstChild, D.Tn, t, { fresh: true });
    put(D.name, { x: D.lockLeft + 40 + 112 + 34 + nameW / 2, y: 540, o: (1 - out), blur: out * 22, s: zoomOut });
    D.name.firstChild.style.width = nameW + 'px';
    const bk = t < 12.95 ? 0 : E.outBack(seg(t, 12.95, 13.3), 2.6);
    put(D.badge, { x: D.lockLeft + total - 40 - badgeW / 2, y: 540, s: bk * zoomOut, o: (bk > 0 ? 1 : 0) * (1 - out), blur: out * 22, r: (1 - clamp(bk)) * -14 });
    // the mascot
    const wo = (1 - out);
    put(D.wisp, { x: P.x, y: P.y, s: P.s * zoomOut, sx: P.sx, sy: P.sy, r: P.r, o: wo, blur: out * 22 });
    // its shadow on the "ground" while it floats
    const gs = t < 12.2 ? 1 : 0;
    put(D.shadow, { x: P.x, y: 680, s: lerp(1.2, 0.7, clamp((680 - P.y) / 300)), o: gs * 0.5 * seg(t, 10.3, 10.7) });
    // rings at the drop
    D.rings.forEach((r, i) => {
      const d = t - 12.0 - i * 0.07;
      if (d < 0 || d > 0.8) { r.style.display = 'none'; return; }
      const k = E.outCubic(d / 0.8), size = 240 + 1300 * k;
      r.style.width = r.style.height = size + 'px';
      r.style.borderWidth = (5 * (1 - k) + 1) + 'px';
      put(r, { x: 960, y: 545, o: (1 - k) * 0.9 });
    });
    // subtitle
    typeInto(D.sub, D.Ts, t, { cursor: true, lead: 0.15 });
    put(D.sub, { x: 960, y: 700, o: (t > 12.9 ? 1 : 0) * (1 - out), blur: out * 18 });
  }

  // ═══ FEATURE HEADER (shared) ═════════════════════════════════════════════
  const FH = S('<div class="fh"><span class="chipnew">New</span><span class="tx"></span></div>');
  const FHtx = FH.querySelector('.tx'), FHchip = FH.querySelector('.chipnew');
  const FEATS = [];
  function feature(a, b, title, chip) {
    const T = Typer(title, a + 0.18 + OFF, 34, { soft: true, silentOff: true });
    FEATS.push({ a: a + OFF, b: b + OFF, T, chip: chip !== false });
    cue(a - 0.05, 'whoosh', 0.55);
  }
  function drawHeader(t) {
    const f = FEATS.find((f) => t >= f.a - 0.02 && t < f.b + 0.3);
    if (!f) { FH.style.display = 'none'; return; }
    const B_ = bio(t, f.a, 0, f.b - 0.12, 0, { din: 0.3, dout: 0.24 });
    typeInto(FHtx, f.T, t, { cursor: true, lead: 0.15, until: f.T.end + 0.5 });
    FHchip.style.display = f.chip ? '' : 'none';
    const ck = E.outBack(seg(t, f.a, f.a + 0.3), 2);
    FHchip.style.transform = 'scale(' + ck.toFixed(3) + ')';
    put(FH, { x: 960, y: 128 - B_.ko * 20, o: B_.o, blur: B_.blur, s: B_.s });
  }

  // generic: a mockup host that blurs in from below and out at the end
  function cardMove(t, a, b, x, y, sc, opt = {}) {
    const k = spring(t - a, opt.f || 1.5, opt.z || 0.62);
    const o = clamp((t - a) / 0.22) * (1 - E.inCubic(seg(t, b - 0.14, b + 0.12)));
    const out = E.inCubic(seg(t, b - 0.14, b + 0.12));
    return {
      x: x + (1 - k) * (opt.dx || 0), y: y + (1 - k) * (opt.dy == null ? 140 : opt.dy) - out * 30,
      s: sc * lerp(opt.s0 || 0.9, 1, k) * (1 - out * 0.05), o, blur: (1 - clamp(k * 1.5)) * 16 + out * 16,
      rx: (1 - k) * (opt.rx == null ? 14 : opt.rx), persp: 1600,
    };
  }
  function note(html, parent) { return S('<div class="note"><span class="dot"></span><span>' + html + '</span></div>', parent); }
  function drawNote(n, t, a, b, x, y) {
    const k = spring(t - a, 2.1, 0.55);
    const o = clamp((t - a) / 0.16) * (1 - E.inCubic(seg(t, b - 0.14, b + 0.1)));
    put(n, { x: x + (1 - k) * -30, y, s: lerp(0.7, 1, k), o: t < a ? 0 : o, blur: (1 - clamp(k)) * 8 });
  }

  // ═══ F1 — Wisp leads every chat: the 3.0 desktop app (14.45 – 18.55) ═══════
  const F1 = { a: 14.45, b: 18.55 };
  feature(F1.a, F1.b, 'Wisp leads *every chat*');
  (function () {
    const tmp = document.createElement('div'); tmp.innerHTML = SNIP.codeply_6;
    const ap = tmp.querySelector('.ap');
    ap.classList.remove('ap-glass'); ap.removeAttribute('style');
    ap.querySelectorAll('.wp-l').forEach((x) => x.remove());
    F1.host = S(''); F1.host.className = 'host';
    F1.host.appendChild(ap); F1.ap = ap;
    ap.querySelector('.ap-title').textContent = 'Checkout total is wrong';
    ap.querySelectorAll('.ap-row.cur').forEach((r) => r.classList.remove('cur'));
    const rows = ap.querySelectorAll('.ap-grp .ap-row'); if (rows[2]) { rows[2].textContent = 'Checkout total is wrong'; rows[2].classList.add('cur'); }
    ap.querySelector('.ap-u').textContent = 'The checkout total is wrong. Fix it before the launch';
    const did = ap.querySelector('.ap-did');
    did.querySelector('.shimmer').textContent = 'Brewing an answer';
    did.querySelector('.t').innerHTML = 'Brought in Frontend and Testing, edited 2 files, ran 24 tests, checked 1 page ' + (did.querySelector('.t svg') ? did.querySelector('.t svg').outerHTML : '');
    const a = ap.querySelector('.ap-a');
    const chg = a.querySelector('.ap-chg');
    a.innerHTML = '<p>Done. The <b>checkout total</b> is right again.</p><ul>' +
      '<li><b>Fix:</b> tax was added twice in <code>cart.ts</code>. Frontend fixed it.</li>' +
      '<li><b>Tests:</b> Testing added a tax test. All 24 pass.</li>' +
      '<li><b>Checked:</b> opened the checkout page, no console errors.</li></ul>';
    if (chg) { chg.querySelector('span').firstChild.textContent = 'Changed 2 files '; a.appendChild(chg); }
    F1.typed = ap.querySelector('.ap-typed');
    F1.lis = ap.querySelectorAll('.ap-a li');
    F1.face = did.querySelector('[data-wisp]');
    F1.send = ap.querySelector('.ap-send');
    window.Wisp.mount(F1.host);
  })();
  F1.T = Typer('The checkout total is wrong. Fix it before the launch', 15.0, 44, { soft: true });
  at(14.95, () => F1.ap.classList.add('typing'));
  at(16.32, () => { F1.ap.classList.remove('typing'); F1.ap.classList.add('sent'); });
  at(16.5, () => { F1.ap.classList.add('working'); if (F1.face && F1.face.wisp) F1.face.wisp.setMood('thinking'); });
  at(17.1, () => { F1.ap.classList.remove('working'); F1.ap.classList.add('did'); if (F1.face && F1.face.wisp) F1.face.wisp.setMood('happy'); });
  at(17.22, () => F1.ap.classList.add('answered'));
  [17.4, 17.58, 17.76].forEach((x, i) => at(x, () => F1.lis[i] && F1.lis[i].classList.add('on')));
  at(17.95, () => F1.ap.classList.add('changed'));
  F1.note = note('Wisp brought in <b>Frontend</b> and <b>Testing</b>');
  cue(16.3, 'send'); cue(17.22, 'pop', 0.5); cue(17.4, 'note');
  curKey(15.95, 1500, 1040); curKey(16.22, center(F1.send, 3, 5)); curKey(16.5, center(F1.send, 3, 5));
  press(16.3, center(F1.send));
  function sceneF1(t) {
    const vis = t > F1.a - 0.05 && t < F1.b + 0.2;
    F1.host.style.display = vis ? '' : 'none'; if (!vis) { F1.note.style.display = 'none'; return; }
    let n = 0; while (n < F1.T.times.length && F1.T.times[n] <= t) n++;
    setText(F1.typed, t < 16.32 ? F1.T.str.slice(0, n) : '');
    const m = cardMove(t, F1.a + 0.05, F1.b, 960, 700, 1.2, { dy: 260, rx: 18 });
    // a slow push toward the answer
    const push = E.inOutCubic(seg(t, 16.3, 18.3));
    m.s *= lerp(1, 1.12, push); m.y -= push * 30; m.x -= push * 60;
    put(F1.host, m);
    drawNote(F1.note, t, 17.45, F1.b, 1500, 250);
  }

  // ═══ F2 — specialists, with faces; talk to one with @Name (18.5 – 22.55) ═══
  const F2 = { a: 18.5, b: 22.55 };
  feature(F2.a, F2.b, 'Specialists with their *own face and voice*');
  F2.team = host('specialists_0');
  F2.ch = host('specialists_1');
  F2.rows = F2.team.querySelectorAll('.team3-row');
  F2.pop = F2.ch.querySelector('.ch3-pop');
  F2.inp = F2.ch.querySelector('.ch3-in b');
  F2.u = F2.ch.querySelector('.ch3-u');
  F2.m = F2.ch.querySelector('.ch3-m');
  F2.Tin = Typer('@Em', 20.25, 9, { soft: true });
  F2.note = note('Talk to anyone with <b>@Name</b>');
  F2.rows.forEach((r, i) => cue(18.75 + i * 0.12, 'pop', 0.35));
  cue(20.05, 'whoosh', 0.5); cue(20.88, 'send'); cue(21.3, 'pop', 0.6);
  function sceneF2(t) {
    const vis = t > F2.a - 0.05 && t < F2.b + 0.2;
    [F2.team, F2.ch].forEach((e) => (e.style.display = vis ? '' : 'none')); if (!vis) { F2.note.style.display = 'none'; return; }
    // rows come in one by one
    F2.rows.forEach((r, i) => {
      const k = spring(t - (18.72 + i * 0.12), 2.4, 0.6);
      r.style.opacity = clamp(k * 1.4).toFixed(3); r.style.transform = 'translateY(' + ((1 - k) * 18).toFixed(2) + 'px)';
    });
    const slide = E.inOutQuint(seg(t, 19.85, 20.35));
    const m = cardMove(t, F2.a + 0.05, F2.b, lerp(960, 600, slide), 600, lerp(2.15, 1.95, slide), { dy: 200 });
    put(F2.team, m);
    const m2 = cardMove(t, 20.0, F2.b, 1330, 600, 1.95, { dx: 260, dy: 40, rx: 0 });
    put(F2.ch, m2);
    // @Em typed, the menu shows; then the message goes and Emma answers
    setHTML(F2.inp, t < 20.86 ? typeHTML(F2.Tin, t, { fresh: false }) : '');
    const popk = E.outCubic(seg(t, 20.2, 20.4)) * (1 - seg(t, 20.8, 20.9));
    F2.pop.style.opacity = popk.toFixed(3); F2.pop.style.transform = 'translateY(' + ((1 - popk) * 10).toFixed(1) + 'px)';
    const uk = spring(t - 20.88, 2.4, 0.6), mk = spring(t - 21.3, 2.2, 0.6);
    F2.u.style.opacity = (t < 20.88 ? 0 : clamp(uk * 1.5)).toFixed(3); F2.u.style.transform = 'translateY(' + ((1 - uk) * 16).toFixed(1) + 'px)';
    F2.m.style.opacity = (t < 21.3 ? 0 : clamp(mk * 1.5)).toFixed(3); F2.m.style.transform = 'translateY(' + ((1 - mk) * 16).toFixed(1) + 'px)';
    drawNote(F2.note, t, 21.55, F2.b, 1500, 268);
  }

  // ═══ F3 — close the laptop, it keeps going: the phone + PR ready (22.5 – 26.55) ═
  const F3 = { a: 22.5, b: 26.55 };
  feature(F3.a, F3.b, 'Close the laptop. *It keeps going.*');
  F3.ph = host('codeply_1');
  F3.pa = F3.ph.querySelector('.pa');
  F3.typed = F3.ph.querySelector('.pa-typed');
  F3.u = F3.ph.querySelector('.pa-u');
  F3.lis = F3.ph.querySelectorAll('.pa-a li');
  F3.ph.querySelector('.pv-wrap').style.setProperty('--s', '1');
  F3.card = S('<div style="width:330px">' + SNIP.gcard_pr + '</div>');
  F3.card.querySelector('.gcard').classList.add('on');
  F3.merge = F3.card.querySelector('em.pri');
  F3.title = F3.card.querySelector('b');
  F3.ask = "Add dark mode to settings. Keep going in the cloud, I'm heading out";
  F3.T = Typer(F3.ask, 22.85, 52, { soft: true });
  at(22.82, () => F3.pa.classList.add('typing'));
  at(24.2, () => { F3.pa.classList.remove('typing'); F3.pa.classList.add('sent'); F3.u.textContent = F3.ask; });
  at(24.4, () => F3.pa.classList.add('working'));
  at(24.95, () => { F3.pa.classList.remove('working'); F3.pa.classList.add('did'); });
  at(25.05, () => F3.pa.classList.add('answered'));
  [25.2, 25.35, 25.5].forEach((x, i) => at(x, () => F3.lis[i] && F3.lis[i].classList.add('on')));
  at(26.02, () => { F3.title.textContent = 'Merged into main'; F3.merge.textContent = 'Merged'; });
  F3.note = note('Runs in <b>Codeply Cloud</b> with your PC off');
  cue(24.2, 'send'); cue(25.12, 'notify'); cue(24.75, 'note');
  curKey(25.45, 1700, 1000); curKey(25.88, center(F3.merge, 6, 4)); curKey(26.3, center(F3.merge, 6, 4));
  press(25.95, center(F3.merge));
  function sceneF3(t) {
    const vis = t > F3.a - 0.05 && t < F3.b + 0.2;
    [F3.ph, F3.card].forEach((e) => (e.style.display = vis ? '' : 'none')); if (!vis) { F3.note.style.display = 'none'; return; }
    let n = 0; while (n < F3.T.times.length && F3.T.times[n] <= t) n++;
    setText(F3.typed, t < 24.2 ? F3.ask.slice(0, n) : '');
    const m = cardMove(t, F3.a + 0.05, F3.b, 700, 640, 1.16, { dy: 300, rx: 10 });
    put(F3.ph, m);
    const ck = spring(t - 25.1, 2.0, 0.55);
    const co = (t < 25.1 ? 0 : clamp(ck * 1.6)) * (1 - E.inCubic(seg(t, F3.b - 0.14, F3.b + 0.1)));
    const pressK = (t > 25.92 && t < 26.12) ? 1 - Math.sin(seg(t, 25.92, 26.12) * Math.PI) * 0.04 : 1;
    put(F3.card, { x: 1330, y: 470 + (1 - ck) * -60, s: 2.0 * lerp(0.85, 1, ck) * pressK, o: co, blur: (1 - clamp(ck)) * 12 + seg(t, F3.b - 0.14, F3.b + 0.1) * 14 });
    drawNote(F3.note, t, 24.7, F3.b, 1330, 800);
  }

  // ═══ F4 — pick a model, set the effort (26.5 – 30.55) ═══════════════════════
  const F4 = { a: 26.5, b: 30.55 };
  feature(F4.a, F4.b, 'Pick a model. *Set the effort.*');
  (function () {
    const tmp = document.createElement('div'); tmp.innerHTML = SNIP.codeply_4;
    const mp = tmp.querySelector('.mp'), ef = tmp.querySelector('.ef-card');
    F4.mp = S(''); F4.mp.className = 'host'; const u1 = el('div', 'ui3', '', F4.mp); u1.appendChild(mp);
    F4.ef = S(''); F4.ef.className = 'host'; const u2 = el('div', 'ui3', '', F4.ef); u2.appendChild(ef);
    F4.rows = mp.querySelectorAll('.mp-row');
    F4.opus = [...F4.rows].find((r) => /Opus/.test(r.textContent));
    F4.track = ef.querySelector('.ef-track');
    F4.label = ef.querySelector('.ef-head span');
    F4.stops = ef.querySelectorAll('.ef-stop');
    F4.knob = ef.querySelector('.ef-knob');
  })();
  F4.levels = ['Low', 'Medium', 'High', 'Max'];
  F4.steps = [[28.1, 0], [28.5, 1], [29.0, 2], [29.5, 3]];
  F4.steps.slice(1).forEach((s) => cue(s[0], 'tick'));
  F4.note = note('Levels from <b>each provider\'s own API</b>');
  curKey(27.15, 1500, 1000); curKey(27.7, center(F4.opus, 60, 2)); curKey(27.95, center(F4.opus, 60, 2));
  press(27.82, center(F4.opus, 60, 2));
  curKey(28.3, () => { const r = F4.knob.getBoundingClientRect(); return { x: r.left + r.width / 2 + 4, y: r.top + r.height / 2 + 6 }; });
  curKey(29.9, () => { const r = F4.knob.getBoundingClientRect(); return { x: r.left + r.width / 2 + 4, y: r.top + r.height / 2 + 6 }; });
  [28.5, 29.0, 29.5].forEach((x) => { PRESS.push(x - 0.04 + OFF); });
  function sceneF4(t) {
    const vis = t > F4.a - 0.05 && t < F4.b + 0.2;
    [F4.mp, F4.ef].forEach((e) => (e.style.display = vis ? '' : 'none')); if (!vis) { F4.note.style.display = 'none'; return; }
    const slide = E.inOutQuint(seg(t, 27.9, 28.4));
    put(F4.mp, cardMove(t, F4.a + 0.05, F4.b, lerp(960, 690, slide), 610, 2.0, { dy: 200 }));
    put(F4.ef, cardMove(t, 28.0, F4.b, 1310, 640, 2.0, { dx: 200, dy: 80, rx: 0 }));
    // hover, then the Opus row is picked
    const hov = t > 27.62 && t < 28.6;
    F4.opus.style.background = hov ? 'rgba(255,255,255,' + (t > 27.82 ? 0.12 : 0.07) + ')' : '';
    F4.opus.style.borderRadius = '8px';
    // the knob: eased between levels
    let f = 0, lvl = 0;
    F4.steps.forEach(([tt, l], i) => { if (t >= tt) { lvl = l; const prev = i ? F4.steps[i - 1][1] : 0; f = lerp(prev, l, E.outBack(seg(t, tt, tt + 0.28), 1.6)); } });
    F4.track.style.setProperty('--f', (f / 3).toFixed(4));
    setText(F4.label, F4.levels[lvl]);
    F4.stops.forEach((s, j) => s.classList.toggle('passed', j <= lvl));
    drawNote(F4.note, t, 29.2, F4.b, 1330, 820);
  }

  // ═══ F5 — four permission modes (30.5 – 33.75) ═══════════════════════════════
  const F5 = { a: 30.5, b: 33.55 };
  feature(F5.a, F5.b, 'Four ways to *say yes*');
  F5.h = host('codeply_5');
  F5.rows = F5.h.querySelectorAll('.pm3-row');
  F5.pick = [[30.5, 0], [31.0, 1], [31.5, 2], [32.0, 3]];
  F5.note = note('Change it <b>in the middle of a chat</b>');
  curKey(30.6, 1560, 1000);
  F5.pick.slice(1).forEach(([tt, i], k) => {
    curKey(tt - 0.22, center(F5.rows[i], -40, 0)); curKey(tt + 0.1, center(F5.rows[i], -40, 0));
    press(tt, center(F5.rows[i], -40, 0));
  });
  curKey(32.5, center(F5.rows[3], -40, 0));
  function sceneF5(t) {
    const vis = t > F5.a - 0.05 && t < F5.b + 0.2;
    F5.h.style.display = vis ? '' : 'none'; if (!vis) { F5.note.style.display = 'none'; return; }
    let on = 0; F5.pick.forEach(([tt, i]) => { if (t >= tt) on = i; });
    F5.rows.forEach((r, i) => r.classList.toggle('on', i === on));
    put(F5.h, cardMove(t, F5.a + 0.05, F5.b, 960, 620, 2.3, { dy: 200 }));
    drawNote(F5.note, t, 32.3, F5.b, 1530, 900);
  }

  // ═══ F6 — any app, one click away (33.7 – 37.75) ═══════════════════════════
  OFF = -0.2;
  const F6 = { a: 33.7, b: 37.75 };
  feature(F6.a, F6.b, 'Any app. *One click away.*');
  F6.h = host('apps_0');
  F6.search = F6.h.querySelector('.apps3-search em');
  F6.rows = F6.h.querySelectorAll('.apps3-row');
  F6.btn = [...F6.rows].map((r) => r.querySelector('em'));
  F6.flo = [['/assets/gmail.webp', 330, 330], ['/assets/slack.webp', 1590, 360], ['/assets/github.webp', 300, 760], ['/assets/vercel.webp', 1620, 790],
    ['/assets/supabase.webp', 470, 560], [LOBE('notion'), 1450, 580], [LOBE('zapier-color'), 1760, 560], [LOBE('figma-color'), 170, 560]]
    .map(([src, x, y], i) => ({ e: S('<div class="flo">' + iconImg(src) + '</div>'), x, y, i }));
  F6.note = note('<b>34,000+</b> apps from the MCP Registry');
  const connect = (i, tt) => {
    at(tt, () => { F6.btn[i].textContent = 'Connected'; F6.btn[i].style.background = 'rgba(76,195,138,.16)'; F6.btn[i].style.color = '#4cc38a'; F6.btn[i].style.borderColor = 'transparent'; });
    curKey(tt - 0.3, center(F6.btn[i])); curKey(tt + 0.12, center(F6.btn[i])); press(tt - 0.05, center(F6.btn[i]));
  };
  curKey(34.6, 1500, 1020);
  connect(1, 35.25); connect(2, 35.75); connect(3, 36.25);
  F6.flo.forEach((f) => cue(34.05 + f.i * 0.07, 'pop', 0.25));
  function sceneF6(t) {
    const vis = t > F6.a - 0.05 && t < F6.b + 0.2;
    [F6.h].concat(F6.flo.map((f) => f.e)).forEach((e) => (e.style.display = vis ? '' : 'none')); if (!vis) { F6.note.style.display = 'none'; return; }
    const n = Math.round(34000 * E.outQuart(seg(t, 34.0, 34.9)));
    setText(F6.search, 'Search ' + n.toLocaleString('en-US') + '+ apps');
    put(F6.h, cardMove(t, F6.a + 0.05, F6.b, 960, 630, 2.15, { dy: 200 }));
    F6.flo.forEach((f) => {
      const k = spring(t - (34.0 + f.i * 0.07), 1.8, 0.5);
      const out = E.inCubic(seg(t, F6.b - 0.16, F6.b + 0.1));
      const bob = Math.sin(t * 1.6 + f.i) * 8;
      const dx = (f.x - 960) * (1 - k) * -0.6, dy = (f.y - 600) * (1 - k) * -0.6;
      put(f.e, { x: f.x + dx, y: f.y + dy + bob, s: lerp(0.3, 1, clamp(k)) * (1 - out * 0.3) * (f.i % 3 === 0 ? 1.1 : 0.92), o: (t < 34.0 + f.i * 0.07 ? 0 : clamp(k * 1.6)) * (1 - out), blur: out * 12 + (f.i % 2) * 1.5, r: Math.sin(t + f.i) * 4 });
    });
    drawNote(F6.note, t, 36.35, F6.b, 1440, 950);
  }

  // ═══ F7 — wallpapers and glass (37.7 – 41.35) ═══════════════════════════════
  OFF = -0.2;
  const F7 = { a: 37.7, b: 41.35 };
  feature(F7.a, F7.b, 'Wallpapers and *glass*');
  (function () {
    const tmp = document.createElement('div'); tmp.innerHTML = SNIP.codeply_6;
    const ap = tmp.querySelector('.ap'); ap.removeAttribute('style');
    ap.querySelectorAll('.wp-l').forEach((x) => x.remove());
    F7.host = S(''); F7.host.className = 'host'; F7.host.appendChild(ap); F7.ap = ap;
    F7.dots = S(''); F7.dots.className = 'host';
    const d = tmp.querySelector('.wp-dots'); F7.dots.appendChild(d);
    F7.dotEls = d.querySelectorAll('i');
    F7.walls = ['/assets/wallpaper.webp', '/assets/site/scene.webp', '/Background.png', 'linear-gradient(135deg,#1d3d7a,#7d4cff 55%,#ff9fc0)'];
    F7.layers = F7.walls.map((w) => { const l = document.createElement('div'); l.className = 'wp-l'; l.style.backgroundImage = w.startsWith('linear') ? w : 'url(' + w + ')'; l.style.transition = 'none'; ap.insertBefore(l, ap.firstChild); return l; });
    window.Wisp.mount(F7.host);
  })();
  F7.sw = [[37.7, 0], [38.7, 1], [39.2, 2], [39.7, 3], [40.2, 0]];
  F7.sw.slice(1).forEach((s) => cue(s[0], 'tick', 0.8));
  F7.note = note('Your pictures <b>stay on your PC</b>');
  function sceneF7(t) {
    const vis = t > F7.a - 0.05 && t < F7.b + 0.2;
    [F7.host, F7.dots].forEach((e) => (e.style.display = vis ? '' : 'none')); if (!vis) { F7.note.style.display = 'none'; return; }
    // stack the wallpapers: the newest fades in over the last one and settles from a zoom
    let cur = 0, prev = 0, ts = 0;
    F7.sw.forEach(([tt, i], k) => { if (t >= tt) { prev = cur; cur = i; ts = tt; } });
    const k = E.outCubic(seg(t, ts, ts + 0.45));
    F7.layers.forEach((l, i) => {
      const li = F7.walls.length - 1 - i; // inserted in reverse
      let o = 0, s = 1;
      if (li === cur) { o = ts === F7.sw[0][0] ? 1 : k; s = lerp(1.06, 1, k); }
      else if (li === prev) { o = 1; }
      l.style.opacity = o; l.style.transform = 'scale(' + s.toFixed(4) + ')'; l.style.zIndex = li === cur ? 1 : 0;
      l.style.position = 'absolute'; l.style.inset = '0';
    });
    F7.ap.querySelectorAll('.ap-bar,.ap-body').forEach((x) => (x.style.zIndex = 2));
    F7.dotEls.forEach((d, i) => d.classList.toggle('on', i === cur));
    const m = cardMove(t, F7.a + 0.05, F7.b, 960, 585, 1.0, { dy: 240, rx: 16 });
    m.ry = lerp(-3, 3, E.inOutCubic(seg(t, F7.a, F7.b)));
    put(F7.host, m);
    const md = cardMove(t, F7.a + 0.2, F7.b, 960, 1010, 2.0, { dy: 60, rx: 0 });
    put(F7.dots, md);
    drawNote(F7.note, t, 39.6, F7.b, 1560, 300);
  }

  // ═══ F8 — talk to it: voice mode (41.3 – 44.45) ═════════════════════════════
  OFF = 0.2;
  const F8 = { a: 41.3, b: 44.45 };
  feature(F8.a, F8.b, 'Talk to it. *Wisp listens.*');
  F8.h = host('voice_0');
  F8.cap = F8.h.querySelector('.vo3-cap');
  F8.face = F8.h.querySelector('[data-wisp]');
  F8.T = Typer('The checkout fix shipped. All 24 tests pass.', 41.85, 30, { silent: true });
  at(41.7, () => F8.face.wisp && F8.face.wisp.setMood('thinking'));
  at(42.35, () => F8.face.wisp && F8.face.wisp.setMood('happy'));
  F8.note = note('Live captions. <b>Real moods.</b>');
  F8.note2 = note('Starts at <b>430 MB</b>, not 1.15 GB');
  function sceneF8(t) {
    const vis = t > F8.a - 0.05 && t < F8.b + 0.2;
    F8.h.style.display = vis ? '' : 'none'; if (!vis) { F8.note.style.display = 'none'; F8.note2.style.display = 'none'; return; }
    let n = 0; while (n < F8.T.times.length && F8.T.times[n] <= t) n++;
    setText(F8.cap, F8.T.str.slice(0, n));
    put(F8.h, cardMove(t, F8.a + 0.05, F8.b, 960, 640, 1.45, { dy: 240, rx: 12 }));
    drawNote(F8.note, t, 42.6, F8.b, 1440, 470);
    drawNote(F8.note2, t, 43.05, F8.b, 470, 760);
  }

  // ═══ M — everything, one app: the mind map (44.4 – 48.1) ═══════════════════
  OFF = 0.1;
  const M = {};
  M.head = S(''); M.head.className = 'tx'; M.head.style.font = "500 60px/1.1 'Geist'";
  M.T = Typer('Everything. *One app.*', 44.55, 24);
  M.svg = S('<svg id="mmLines" width="1920" height="1080" viewBox="0 0 1920 1080"></svg>');
  M.svg.style.width = '1920px'; M.svg.style.height = '1080px';
  M.lock = S('<div class="lockup" style="height:110px"></div>');
  M.wisp = S('<div class="bigwisp" style="width:84px;height:84px"><i data-wisp="" data-mood="neutral"></i></div>');
  window.Wisp.mount(M.wisp);
  M.name = S('<div class="lockup-name" style="font-size:52px">Codeply</div>');
  M.badge = S('<div class="badge3" style="height:46px;font-size:28px;line-height:46px;padding:0 16px">3.0</div>');
  const NODES = [
    ['users', 'Wisp + specialists', 'Up to 12, with @Name', 330, 330],
    ['cloud', 'Codeply Cloud', 'Works with your PC off', 270, 560],
    ['phone_c', 'A rebuilt phone app', 'Approve and merge anywhere', 330, 790],
    ['sparkle_c', 'Haze 2 + your models', 'With a real effort slider', 1590, 330],
    ['shield-check_c', 'Four permission modes', 'Nothing without your yes', 1650, 560],
    ['mail_c', '34,000+ apps', 'Gmail, Slack, GitHub…', 1590, 790],
    ['bulb_c', 'Voice mode', 'Wisp\'s face, live captions', 740, 930],
    ['image_c', 'Wallpapers and glass', 'A new look everywhere', 1180, 930],
  ];
  M.nodes = NODES.map(([ic, b, s, x, y], i) => {
    const e = S('<div class="mm-node"><span class="ic">' + (OI[ic] || '') + '</span><div><b>' + b + '</b><small>' + s + '</small></div></div>');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('fill', 'none'); p.setAttribute('stroke', BLUE); p.setAttribute('stroke-width', '2.5'); p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-opacity', '.45');
    M.svg.firstChild.appendChild(p);
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('r', '5'); dot.setAttribute('fill', BLUE);
    M.svg.firstChild.appendChild(dot);
    const t0 = 44.9 + i * 0.25;
    cue(t0, 'pop', 0.45);
    return { e, p, dot, x, y, t0 };
  });
  cue(47.25, 'impact', 0.6); cue(47.7, 'whoosh', 1);
  function sceneM(t) {
    const vis = t > 44.35 && t < 48.25;
    [M.head, M.svg, M.lock, M.wisp, M.name, M.badge].concat(M.nodes.map((n) => n.e)).forEach((e) => (e.style.display = vis ? '' : 'none'));
    if (!vis) return;
    const hb = bio(t, 44.45, 0, 47.55, 0);
    typeInto(M.head, M.T, t, { cursor: true, lead: 0.15, until: 46.8 });
    put(M.head, { x: 960, y: 150 - hb.ko * 20, o: hb.o, blur: hb.blur, s: hb.s });
    // the centre lockup
    const ck = spring(t - 44.5, 1.6, 0.6);
    const conv = E.inCubic(seg(t, 47.2, 47.55));           // nodes fly in
    const pulse = t > 47.5 ? Math.sin(seg(t, 47.5, 47.75) * Math.PI) * 0.08 : 0;
    const zout = E.inExpo(seg(t, 47.7, 48.1));
    const cs = 1.25 * lerp(0.7, 1, ck) * (1 + pulse) * (1 + zout * 1.6);
    const co = clamp(ck * 1.5) * (1 - zout);
    const LW = 470;
    M.lock.firstChild.style.width = LW + 'px';
    put(M.lock, { x: 960, y: 560, s: cs, o: co, blur: zout * 30 });
    const off = (dx) => 960 + dx * cs;
    put(M.wisp, { x: off(-LW / 2 + 70), y: 560, s: cs, o: co, blur: zout * 30 });
    put(M.name, { x: off(-LW / 2 + 128 + 100), y: 560, s: cs, o: co, blur: zout * 30 });
    put(M.badge, { x: off(LW / 2 - 70), y: 560, s: cs, o: co, blur: zout * 30 });
    M.nodes.forEach((n) => {
      const k = spring(t - n.t0, 2.0, 0.55);
      const ok = t < n.t0 ? 0 : clamp(k * 1.5);
      const x = lerp(n.x, 960, conv), y = lerp(n.y, 560, conv);
      put(n.e, { x, y, s: lerp(0.6, 1, k) * (1 - conv * 0.8), o: ok * (1 - conv), blur: (1 - clamp(k)) * 10 + conv * 10 });
      // the line: from the node toward the centre, drawn over 0.3s
      const lk = E.outCubic(seg(t, n.t0 + 0.08, n.t0 + 0.4)) * (1 - conv);
      const side = Math.abs(n.x - 960) > 300, nw = n.e.offsetWidth, nh = n.e.offsetHeight;
      const ex = 960 + Math.sign(n.x - 960) * (side ? (LW / 2) * cs + 14 : (n.x < 960 ? 60 : -60)), ey = side ? 560 : 560 + 66 * cs;
      const sx = side ? n.x - Math.sign(n.x - 960) * (nw / 2 + 10) : n.x, sy = side ? n.y : n.y - nh / 2 - 10;
      const mx = (sx + ex) / 2;
      const d = Math.abs(n.x - 960) > 300 ? 'M' + sx + ' ' + sy + ' C' + mx + ' ' + sy + ' ' + mx + ' ' + ey + ' ' + ex + ' ' + ey : 'M' + sx + ' ' + sy + ' C' + sx + ' ' + (sy - 80) + ' ' + ex + ' ' + (ey + 80) + ' ' + ex + ' ' + ey;
      n.p.setAttribute('d', d);
      const L = n.p.getTotalLength();
      n.p.setAttribute('stroke-dasharray', L.toFixed(1));
      n.p.setAttribute('stroke-dashoffset', (L * (1 - lk)).toFixed(1));
      n.p.setAttribute('opacity', (lk > 0 ? 1 : 0) * (1 - zout));
      const pt = n.p.getPointAtLength(L * lk);
      n.dot.setAttribute('cx', pt.x.toFixed(1)); n.dot.setAttribute('cy', pt.y.toFixed(1));
      n.dot.setAttribute('opacity', lk > 0.02 && lk < 0.999 ? 1 : lk >= 0.999 ? 0.6 : 0);
    });
    M.svg.style.opacity = 1;
  }

  // ═══ T — "AI that's already on it." (48.0 – 52.0) ══════════════════════════
  OFF = 0;
  const T = {};
  T.words = [['AI', 48.22, 0], ["that's", 48.47, 0], ['already', 48.97, 1], ['on', 49.22, 1], ['it.', 49.47, 1]].map(([w, tt, line]) => {
    const e = S(''); e.className = 'tx white'; e.style.font = "500 150px/1 'Geist'"; e.style.letterSpacing = '-0.045em';
    e.textContent = w; if (line) e.style.color = 'rgba(255,255,255,.66)';
    cue(tt, 'thud', line ? 0.7 : 0.9);
    return { e, tt, line, w };
  });
  T.laid = false;
  function sceneT(t) {
    const vis = t > 48.1 && t < 52.1;
    T.words.forEach((w) => (w.e.style.display = vis ? '' : 'none'));
    if (!vis) return;
    if (!T.laid) {
      // lay out two centred lines
      [0, 1].forEach((line) => {
        const ws = T.words.filter((w) => w.line === line);
        const gap = 34, widths = ws.map((w) => { w.e.style.display = ''; return w.e.offsetWidth; });
        const total = widths.reduce((a, b) => a + b, 0) + gap * (ws.length - 1);
        let x = 960 - total / 2;
        ws.forEach((w, i) => { w.cx = x + widths[i] / 2; x += widths[i] + gap; w.cy = line ? 610 : 450; });
      });
      T.laid = true;
    }
    const push = 1 + (t - 48) * 0.012;
    const out = E.inCubic(seg(t, 51.55, 51.95));
    T.words.forEach((w) => {
      const k = spring(t - w.tt, 1.6, 0.7);
      const o = (t < w.tt ? 0 : clamp(k * 1.4)) * (1 - out);
      put(w.e, { x: 960 + (w.cx - 960) * push, y: 530 + (w.cy - 530) * push + (1 - k) * 40 - out * 40, s: push * lerp(0.9, 1, k), o, blur: (1 - clamp(k)) * 22 + out * 20 });
    });
  }

  // ═══ E — the end card: mascot, logo, download (52.0 – 60.0) ═══════════════
  OFF = -0.4;
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
  at(52.42, () => Z.W.setMood('happy'));
  at(53.5, () => Z.W.setMood('neutral'));
  at(54.85, () => Z.W.setMood('happy'));
  cue(52.4, 'impact', 0.8); cue(53.05, 'pop', 0.7);
  curKey(53.85, 1700, 1040); curKey(54.62, center(Z.btn, 10, 12)); curKey(55.6, center(Z.btn, 10, 12));
  press(54.78, center(Z.btn));
  function sceneZ(t) {
    const vis = t > 51.95;
    [Z.lock, Z.wisp, Z.name, Z.badge, Z.btn, Z.sub].concat(Z.rings).forEach((e) => (e.style.display = vis ? '' : 'none'));
    if (!vis) return;
    const total = 700, left = 960 - total / 2, Y = 430;
    // the mascot falls in, squashes, settles into the logo
    let x = 960, y, sx = 1, sy = 1, s = 1;
    if (t < 52.4) { const k = E.inCubic(seg(t, 52.0, 52.4)); y = lerp(-220, Y + 10, k); sy = lerp(1, 1.18, k); sx = lerp(1, 0.88, k); }
    else {
      const u = t - 52.4, sq = Math.exp(-u * 7) * Math.cos(u * 26);
      sx = 1 + 0.25 * sq; sy = 1 - 0.25 * sq; y = Y + 10 - Math.max(0, Math.sin(u * 9)) * 26 * Math.exp(-u * 6);
      const m = E.inOutQuint(seg(t, 52.6, 53.05));
      x = lerp(960, left + 96, m); s = lerp(1, 0.6, m); y = lerp(y, Y, m);
    }
    // a happy hop on the click
    const hop = t > 54.85 ? Math.max(0, Math.sin((t - 54.85) * 10)) * 26 * Math.exp(-(t - 54.85) * 4) : 0;
    const push = 1 + Math.max(0, t - 53) * 0.006;
    const P = (px, py) => ({ x: 960 + (px - 960) * push, y: 540 + (py - 540) * push });
    const pw = lerp(150, total, E.outExpo(seg(t, 52.66, 53.25)));
    Z.lock.firstChild.style.width = pw + 'px';
    const lp = P(left + pw / 2, Y);
    put(Z.lock, { x: lp.x, y: lp.y, s: push, o: seg(t, 52.58, 52.68) });
    const np = P(left + 40 + 112 + 34 + 165, Y);
    const nk = seg(t, 52.85, 53.15);
    put(Z.name, { x: np.x, y: np.y, s: push, o: nk, blur: (1 - nk) * 10 });
    Z.name.firstChild.style.width = '330px';
    const bk = t < 53.05 ? 0 : E.outBack(seg(t, 53.05, 53.4), 2.6);
    const bp = P(left + total - 40 - 59, Y);
    put(Z.badge, { x: bp.x, y: bp.y, s: bk * push, o: bk > 0 ? 1 : 0, r: (1 - clamp(bk)) * -14 });
    const wp = P(x, y - hop);
    put(Z.wisp, { x: wp.x, y: wp.y, s: s * push, sx, sy });
    Z.rings.forEach((r, i) => {
      const d = t - 52.4 - i * 0.08;
      if (d < 0 || d > 0.7) { r.style.display = 'none'; return; }
      const k = E.outCubic(d / 0.7), size = 200 + 1000 * k;
      r.style.width = r.style.height = size + 'px'; r.style.borderWidth = (4 * (1 - k) + 1) + 'px';
      put(r, { x: 960, y: Y + 10, o: (1 - k) * 0.8 });
    });
    // the button
    const bb = spring(t - 53.25, 1.8, 0.6);
    const pd = t - 54.78;
    const pressS = pd > -0.06 && pd < 0.3 ? (pd < 0 ? 1 - (pd + 0.06) * 0.8 : lerp(0.95, 1, E.outBack(clamp(pd / 0.3)))) : 1;
    const btnP = P(960, 640);
    put(Z.btn, { x: btnP.x, y: btnP.y + (1 - bb) * 40, s: push * lerp(0.9, 1, bb) * pressS, o: t < 53.25 ? 0 : clamp(bb * 1.5), blur: (1 - clamp(bb)) * 14 });
    const clicked = t >= 54.8;
    Z.btn.firstChild.style.background = clicked ? BLUE : '#fff';
    Z.btn.firstChild.style.color = clicked ? '#fff' : '#0b1628';
    const sb = spring(t - 53.55, 1.8, 0.6);
    const sp = P(960, 742);
    put(Z.sub, { x: sp.x, y: sp.y + (1 - sb) * 20, s: push, o: t < 53.55 ? 0 : clamp(sb * 1.4), blur: (1 - clamp(sb)) * 10 });
    // the very end: a soft fade
    const end = E.inCubic(seg(t, 59.35, 60.0));
    stage.style.filter = end > 0.001 ? 'brightness(' + (1 - end * 0.0) + ')' : '';
    flash.style.background = end > 0 ? '#fff' : '#fff';
  }

  // ─── the frame ────────────────────────────────────────────────────────────
  let lastT = null;
  window.__frame = function (t) {
    // one-shot events, in order
    for (const e of EV) if (!e.done && t >= e.t) { e.done = true; e.fn(); }
    drawBackground(t);
    sceneA(t); sceneB(t); sceneC(t); sceneD(t);
    drawHeader(t);
    sceneF1(t); sceneF2(t); sceneF3(t); sceneF4(t); sceneF5(t); sceneF6(t + 0.2); sceneF7(t + 0.2); sceneF8(t - 0.2);
    sceneM(t - 0.1); sceneT(t); sceneZ(t + 0.4);
    // the burst canvas and the flash at the big hits
    bctx.clearRect(0, 0, W, H);
    const b1 = drawBurst(t, 12.0, 960, 545, 1), b2 = drawBurst(t, 52.0, 960, 440, 0.8);
    burst.style.display = b1 || b2 ? '' : 'none';
    let fl = 0;
    fl = Math.max(fl, 0.5 * (1 - E.outCubic(seg(t, 12.0, 12.3))) * (t >= 12.0 ? 1 : 0));
    fl = Math.max(fl, 0.35 * (1 - E.outCubic(seg(t, 52.0, 52.25))) * (t >= 52.0 ? 1 : 0));
    flash.style.opacity = fl.toFixed(3);
    flash.style.display = fl < 0.002 ? 'none' : '';
    drawCursor(t); drawPings(t);
    // step the site's own CSS transitions and animations with the film's clock
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
