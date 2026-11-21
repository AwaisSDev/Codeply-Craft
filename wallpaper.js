// Settings > Appearance > Background: a picture behind the main area, with the
// composer, the tray and dialogs turned to frosted glass over it (wallpaper.css).
//
// The picture sits behind the sidebar and the main area (the sidebar stays
// solid unless the user picks Glass). It is drawn once into one <canvas> the size of the screen and then
// left alone, so at idle it costs one screen-sized bitmap and no repaints:
//   - the built-ins are drawn here from gradients (nothing to download or ship),
//   - the user's own images come from this PC's app data (wallpapers-desktop.js),
//   - blur is baked into the drawing, the dot pattern is a one-time ordered
//     dither into small cells with dark gaps and grain, and dim is a plain
//     dark layer on top that the slider changes live.
// The choice lives in this window's localStorage, so it is per device.
(function () {
  'use strict';
  const KEY = 'craft-wallpaper';
  const DEFAULTS = { id: 'none', dim: 15, blur: 0, dither: true, sidebar: 'glass', follow: true };
  const api = window.craft || null;

  // ─── The built-ins: drawn at any size from a few gradients ─────────────────
  // Each draws the whole w x h area. Shapes are in fractions of the size so a
  // 160px thumbnail and a 4K screen show the same picture.
  const BUILTINS = [
    { id: 'orbit', name: 'Orbit', draw: drawOrbit },
    { id: 'dusk', name: 'Dusk', draw: drawDusk },
    { id: 'aurora', name: 'Aurora', draw: drawAurora },
    { id: 'dune', name: 'Dune', draw: drawDune },
  ];

  // Earth's edge seen from orbit: night side below, a thin orange band, the
  // white glow of the upper air, blue fading into black space.
  function drawOrbit(ctx, w, h) {
    const s = Math.max(w, h);
    const cx = -0.62 * s, cy = 1.32 * s, R = 1.32 * s;
    ctx.fillStyle = '#010205';
    ctx.fillRect(0, 0, w, h);
    const g = ctx.createRadialGradient(cx, cy, R * 0.93, cx, cy, R * 1.24);
    // stops are positions between 0.93R and 1.24R
    const at = (r) => (r - 0.93) / (1.24 - 0.93);
    g.addColorStop(0, '#000000');
    g.addColorStop(at(0.975), '#120502');
    g.addColorStop(at(0.988), '#7a2a08');
    g.addColorStop(at(0.995), '#e8761e');
    g.addColorStop(at(0.9995), '#ffc890');
    g.addColorStop(at(1.004), '#fdf6ec');
    g.addColorStop(at(1.012), '#cfeafe');
    g.addColorStop(at(1.03), '#7cc0f2');
    g.addColorStop(at(1.06), '#2f86cf');
    g.addColorStop(at(1.11), '#0d3b72');
    g.addColorStop(at(1.17), '#04142b');
    g.addColorStop(1, '#010205');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    // the far side of the limb fades into the night, so the band isn't a ruler line
    const fade = ctx.createLinearGradient(w * 0.15, h * -0.1, w * 0.95, h * 1.05);
    fade.addColorStop(0, 'rgba(1,2,5,0.55)');
    fade.addColorStop(0.35, 'rgba(1,2,5,0)');
    fade.addColorStop(0.75, 'rgba(1,2,5,0)');
    fade.addColorStop(1, 'rgba(1,2,5,0.5)');
    ctx.fillStyle = fade;
    ctx.fillRect(0, 0, w, h);
  }

  // A low sun behind a dark ridge, violet sky above.
  function drawDusk(ctx, w, h) {
    const sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, '#0a0d24');
    sky.addColorStop(0.38, '#2d1f55');
    sky.addColorStop(0.58, '#a24b78');
    sky.addColorStop(0.7, '#f19a6c');
    sky.addColorStop(0.76, '#ffd3a1');
    sky.addColorStop(1, '#ffd3a1');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);
    const sun = ctx.createRadialGradient(w * 0.66, h * 0.76, 0, w * 0.66, h * 0.76, h * 0.42);
    sun.addColorStop(0, 'rgba(255,240,214,0.95)');
    sun.addColorStop(0.12, 'rgba(255,200,140,0.65)');
    sun.addColorStop(1, 'rgba(255,140,110,0)');
    ctx.fillStyle = sun;
    ctx.fillRect(0, 0, w, h);
    ridge(ctx, w, h, 0.74, 0.035, '#3a1c35', 3.1);
    ridge(ctx, w, h, 0.8, 0.04, '#1d0f1f', 1.7);
    ridge(ctx, w, h, 0.88, 0.03, '#0c070e', 2.4);
  }
  function ridge(ctx, w, h, y, amp, color, k) {
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let i = 0; i <= 64; i++) {
      const x = i / 64;
      const yy = y + amp * (Math.sin(x * k * 3.1 + k) * 0.6 + Math.sin(x * k * 7.3 + 1.7 * k) * 0.3 + Math.sin(x * 23 + k) * 0.1);
      ctx.lineTo(x * w, yy * h);
    }
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }

  // Soft green and violet curtains over a deep blue night.
  function drawAurora(ctx, w, h) {
    const sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, '#02060f');
    sky.addColorStop(0.6, '#04182a');
    sky.addColorStop(1, '#03222b');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);
    const s = Math.max(w, h);
    ctx.save();
    ctx.filter = `blur(${Math.max(2, s * 0.035)}px)`;
    ctx.globalCompositeOperation = 'lighter';
    const band = (y0, y1, c, width, alpha) => {
      ctx.beginPath();
      ctx.moveTo(-0.1 * w, y0 * h);
      ctx.bezierCurveTo(0.3 * w, (y0 - 0.35) * h, 0.55 * w, (y1 + 0.3) * h, 1.1 * w, y1 * h);
      ctx.strokeStyle = c;
      ctx.globalAlpha = alpha;
      ctx.lineWidth = width * s;
      ctx.stroke();
    };
    band(0.62, 0.3, '#1fd39a', 0.07, 0.75);
    band(0.7, 0.42, '#41f0c0', 0.025, 0.7);
    band(0.5, 0.2, '#6a5cff', 0.06, 0.45);
    band(0.78, 0.55, '#18a7c9', 0.05, 0.4);
    ctx.restore();
    ctx.globalAlpha = 1;
    ridge(ctx, w, h, 0.9, 0.025, '#01070c', 2.2);
  }

  // Warm sand dunes under a pale sky: the light one.
  function drawDune(ctx, w, h) {
    const sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, '#f6efe6');
    sky.addColorStop(0.45, '#f7dcc0');
    sky.addColorStop(1, '#efc39b');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);
    const glow = ctx.createRadialGradient(w * 0.3, h * 0.35, 0, w * 0.3, h * 0.35, Math.max(w, h) * 0.5);
    glow.addColorStop(0, 'rgba(255,255,255,0.75)');
    glow.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);
    const dune = (y, amp, k, top, bottom) => {
      ctx.beginPath();
      ctx.moveTo(0, h);
      for (let i = 0; i <= 64; i++) {
        const x = i / 64;
        ctx.lineTo(x * w, (y + amp * Math.sin(x * k + y * 9)) * h);
      }
      ctx.lineTo(w, h);
      ctx.closePath();
      const g = ctx.createLinearGradient(0, (y - amp) * h, 0, h);
      g.addColorStop(0, top);
      g.addColorStop(1, bottom);
      ctx.fillStyle = g;
      ctx.fill();
    };
    dune(0.58, 0.05, 3.2, '#eab587', '#d9925f');
    dune(0.7, 0.06, 2.4, '#e3a26f', '#c27445');
    dune(0.84, 0.05, 3.9, '#cf8250', '#9c5530');
  }

  // ─── The saved choice ───────────────────────────────────────────────────────
  function get() {
    try {
      const v = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (v && typeof v === 'object') return { ...DEFAULTS, ...v };
    } catch {}
    return { ...DEFAULTS };
  }
  function save(v) {
    try {
      if (!v || v.id === 'none') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, JSON.stringify(v));
    } catch {}
  }

  // ─── Drawing ────────────────────────────────────────────────────────────────
  let layer = null;     // the <canvas>
  let dimEl = null;     // the dark layer over it
  let drawn = '';       // what the canvas holds now, so the same thing isn't drawn twice
  let token = 0;        // a newer apply() wins over a slower older one
  const imgCache = { id: '', bitmap: null };

  function ensureLayers() {
    const main = document.querySelector('.app');
    if (!main) return null;
    if (!layer) {
      layer = document.createElement('canvas');
      layer.className = 'wp-layer';
      layer.setAttribute('aria-hidden', 'true');
      dimEl = document.createElement('div');
      dimEl.className = 'wp-dim';
      dimEl.setAttribute('aria-hidden', 'true');
      main.prepend(dimEl);
      main.prepend(layer);
    }
    return main;
  }

  // The canvas is the screen's size in device pixels, shown 1:1, so the dots
  // stay crisp and the main area is always covered whatever the window does.
  function targetSize() {
    const dpr = window.devicePixelRatio || 1;
    const main = document.querySelector('.app');
    const r = main ? main.getBoundingClientRect() : { width: 0, height: 0 };
    const cssW = Math.max(screen.width || 0, Math.ceil(r.width), 320);
    const cssH = Math.max(screen.height || 0, Math.ceil(r.height), 240);
    const scale = Math.min(dpr, 3840 / cssW, 2400 / cssH); // a 4K ceiling
    return { cssW, cssH, W: Math.round(cssW * scale), H: Math.round(cssH * scale), dpr: scale };
  }

  async function loadUserImage(id) {
    if (imgCache.id === id && imgCache.bitmap) return imgCache.bitmap;
    if (!api || !api.wallpaperRead) return null;
    const bytes = await api.wallpaperRead(id);
    if (!bytes) return null;
    const blob = new Blob([bytes]);
    const bmp = await createImageBitmap(blob);
    if (imgCache.bitmap && imgCache.bitmap.close) imgCache.bitmap.close();
    imgCache.id = id;
    imgCache.bitmap = bmp;
    return bmp;
  }
  function dropImageCache() {
    if (imgCache.bitmap && imgCache.bitmap.close) imgCache.bitmap.close();
    imgCache.id = '';
    imgCache.bitmap = null;
  }

  // Draws the source (a built-in or a bitmap) covering w x h, blurred if asked.
  function drawSource(ctx, src, w, h, blurPx) {
    ctx.save();
    const pad = blurPx ? Math.ceil(blurPx * 2) : 0; // overscan so a blur doesn't pull dark in from the edges
    if (blurPx) ctx.filter = `blur(${blurPx}px)`;
    if (typeof src === 'function') {
      ctx.translate(-pad, -pad);
      src(ctx, w + pad * 2, h + pad * 2);
    } else {
      const sw = src.width, sh = src.height;
      const k = Math.max((w + pad * 2) / sw, (h + pad * 2) / sh);
      const dw = sw * k, dh = sh * k;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(src, (w - dw) / 2, (h - dh) / 2, dw, dh);
    }
    ctx.restore();
  }

  // A 4x4 Bayer matrix: the threshold pattern of ordered dithering.
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16 - 0.5);
  function rand(i) { // a fixed hash, so the grain is the same every time it's drawn
    let x = (i ^ 0x9e3779b9) >>> 0;
    x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
    x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
    return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
  }

  // The dot pattern: the picture shrunk to one value per cell, each cell
  // ordered-dithered to a few levels per channel, drawn as a square with a
  // dark gap around it, and a scatter of darker cells for grain.
  function ditherInto(ctx, src, W, H, dpr, blurPx) {
    const cell = Math.max(3, Math.round(3 * dpr));
    const gap = Math.max(1, Math.round(dpr));
    const gw = Math.ceil(W / cell), gh = Math.ceil(H / cell);
    const small = document.createElement('canvas');
    small.width = gw; small.height = gh;
    const sctx = small.getContext('2d', { willReadFrequently: true });
    drawSource(sctx, src, gw, gh, blurPx / cell);
    const s = sctx.getImageData(0, 0, gw, gh).data;
    small.width = small.height = 0;

    const LV = 5; // levels per channel
    const q = (v, t) => {
      const x = Math.round((v / 255) * (LV - 1) + t);
      return x <= 0 ? 0 : x >= LV - 1 ? 255 : (x * 255) / (LV - 1);
    };
    // One color per cell, then each pixel row of the output copies its cell.
    const cr = new Uint8ClampedArray(gw * gh * 3);
    const gf = new Float32Array(gw * gh); // how dark each cell's gap is: deep on dark cells, light on bright ones
    let lum = 0;
    for (let gy = 0; gy < gh; gy++) {
      for (let gx = 0; gx < gw; gx++) {
        const i = gy * gw + gx;
        let r = s[i * 4], g = s[i * 4 + 1], b = s[i * 4 + 2];
        const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
        lum += l * 255;
        gf[i] = 0.22 + 0.62 * l;
        // a touch more color, like printed dots
        const m = (r + g + b) / 3;
        r = m + (r - m) * 1.18; g = m + (g - m) * 1.18; b = m + (b - m) * 1.18;
        const n = rand(i);
        const t = BAYER[(gy & 3) * 4 + (gx & 3)] + (rand(i + 7919) - 0.5) * 0.5;
        let k = 1;
        if (n < 0.14) k = 1 - (0.72 - n * 2) * (1 - 0.7 * l); // grain: some cells sit darker, gently on bright ones
        cr[i * 3] = q(r, t) * k;
        cr[i * 3 + 1] = q(g, t) * k;
        cr[i * 3 + 2] = q(b, t) * k;
      }
    }
    const out = ctx.createImageData(W, H);
    const d = out.data;
    // Each cell row is two pixel rows (the dots, and the gap under them), built
    // once and copied down, so the work is per cell, not per pixel.
    const inner = cell - gap;
    const dots = new Uint8ClampedArray(W * 4), under = new Uint8ClampedArray(W * 4);
    for (let gy = 0; gy < gh; gy++) {
      for (let x = 0, o = 0; x < W; x++, o += 4) {
        const gx = (x / cell) | 0;
        const c = (gy * gw + gx) * 3;
        const gfx = gf[gy * gw + gx];
        const f = x - gx * cell >= inner ? gfx : 1;
        dots[o] = cr[c] * f; dots[o + 1] = cr[c + 1] * f; dots[o + 2] = cr[c + 2] * f; dots[o + 3] = 255;
        under[o] = cr[c] * gfx; under[o + 1] = cr[c + 1] * gfx; under[o + 2] = cr[c + 2] * gfx; under[o + 3] = 255;
      }
      const y0 = gy * cell;
      for (let k = 0; k < cell && y0 + k < H; k++) d.set(k < inner ? dots : under, (y0 + k) * W * 4);
    }
    ctx.putImageData(out, 0, 0);
    grid = { cr, gf, gw, gh, cell, inner, dpr };
    return lum / (gw * gh) / 255;
  }

  // Smooth mode: the picture as it is. Its brightness is read from a 32x20 copy,
  // so nothing reads the big canvas back.
  function drawSmooth(ctx, src, W, H, blurPx) {
    drawSource(ctx, src, W, H, blurPx);
    const s = document.createElement('canvas');
    s.width = 32; s.height = 20;
    const sc = s.getContext('2d', { willReadFrequently: true });
    sc.drawImage(ctx.canvas, 0, 0, 32, 20);
    const d = sc.getImageData(0, 0, 32, 20).data;
    let lum = 0;
    for (let i = 0; i < d.length; i += 4) lum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    return lum / (d.length / 4) / 255;
  }

  function setDim(v) {
    if (!dimEl) return;
    const a = Math.max(0, Math.min(85, Number(v) || 0)) / 100;
    dimEl.style.opacity = String(a);
    setTone();
    retone();
  }
  // Light or dark picture (after dimming), so text that sits right on it picks the readable color.
  let baseLum = 0;
  function setTone() {
    const v = get();
    const lum = baseLum * (1 - Math.max(0, Math.min(85, v.dim)) / 100);
    document.body.dataset.wpTone = lum > 0.55 ? 'light' : 'dark';
  }

  async function apply(v = get()) {
    const my = ++token;
    if (!v || v.id === 'none') {
      document.body.classList.remove('has-wallpaper', 'wp-glass-sidebar', 'wp-follow');
      delete document.body.dataset.wpTone;
      if (layer) {
        layer.classList.remove('on');
        // free the bitmap once it has faded out
        setTimeout(() => { if (my === token && layer) { layer.width = layer.height = 0; drawn = ''; grid = null; if (mover) { mover.width = mover.height = 0; mover.style.display = 'none'; } } }, 450);
      }
      dropImageCache();
      return;
    }
    if (!ensureLayers()) return;
    const { cssW, cssH, W, H, dpr } = targetSize();
    const builtin = BUILTINS.find((b) => b.id === v.id);
    const key = [v.id, v.blur, v.dither, W, H].join('|');
    if (key !== drawn) {
      let src = builtin ? builtin.draw : null;
      if (!src) {
        try { src = await loadUserImage(v.id); } catch { src = null; }
        if (my !== token) return;
        if (!src) { apply({ ...v, id: 'none' }); return; } // the image is gone
      }
      const t0 = performance.now();
      layer.width = W; layer.height = H;
      layer.style.width = cssW + 'px';
      layer.style.height = cssH + 'px';
      const ctx = layer.getContext('2d', { alpha: false });
      const blurPx = (Number(v.blur) || 0) * dpr;
      grid = null;
      if (mover) mover.style.display = 'none';
      baseLum = v.dither ? ditherInto(ctx, src, W, H, dpr, blurPx) : drawSmooth(ctx, src, W, H, blurPx);
      drawn = key;
      window.CraftWallpaper.lastDrawMs = Math.round(performance.now() - t0);
      if (builtin) dropImageCache();
    }
    setDim(v.dim);
    document.body.classList.add('has-wallpaper');
    document.body.classList.toggle('wp-glass-sidebar', v.sidebar === 'glass');
    document.body.classList.toggle('wp-follow', !!(v.dither && v.follow));
    requestAnimationFrame(() => { if (layer) layer.classList.add('on'); retone(); });
  }

  // A bigger window than the screen (spread over two monitors): draw again to cover it.
  let resizeT = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => {
      if (!layer || get().id === 'none') return;
      retone();
      const { W, H } = targetSize();
      if (W !== layer.width || H !== layer.height) { drawn = ''; apply(); }
    }, 300);
  });

  // Dots that move with the cursor: near the pointer each dot wobbles a pixel
  // or so on its own random path, strongest close by and fading smoothly with
  // distance, then settles once the pointer rests. Every dot has its own
  // direction and timing, so no rays or shapes can line up across the grid.
  // A small canvas over that spot draws those cells again; the big picture is
  // never redrawn, and nothing runs while the pointer is still.
  let grid = null;      // the dot pattern's cells, kept from ditherInto()
  let mover = null, moverCtx = null, moverImg = null;
  let px = 0, py = 0, cx = 0, cy = 0, str = 0, want = 0, raf = 0, inside = false, idleT = 0;
  const SIGMA = 90;     // css px: how far out the dots still move
  const AMP = 1.4;      // css px: the most a dot moves
  const REACH = 3 * SIGMA;
  function ensureMover() {
    if (mover || !layer) return;
    mover = document.createElement('canvas');
    mover.className = 'wp-mover';
    mover.setAttribute('aria-hidden', 'true');
    layer.after(mover);
  }
  function drawMover(now) {
    const g = grid;
    if (!g || !mover) return;
    const { cr, gf, gw, gh, cell, inner, dpr } = g;
    const R = Math.round(REACH * dpr);
    const n = Math.ceil((2 * R) / cell) + 1; // cells across the patch
    const size = n * cell;
    if (mover.width !== size) {
      mover.width = mover.height = size;
      moverCtx = mover.getContext('2d', { alpha: false });
      moverImg = moverCtx.createImageData(size, size);
    }
    const d = moverImg.data;
    const gx0 = Math.round(cx / cell) - (n >> 1), gy0 = Math.round(cy / cell) - (n >> 1);
    const sig2 = (SIGMA * dpr) ** 2, amp = AMP * dpr * str, t = now / 1000;
    // 1. every cell's gap color where it sits, so the patch matches the picture at rest
    for (let j = 0; j < n; j++) {
      const gy = gy0 + j;
      for (let i = 0; i < n; i++) {
        const gx = gx0 + i;
        const ok = gx >= 0 && gy >= 0 && gx < gw && gy < gh;
        const si = gy * gw + gx, c = si * 3, f = ok ? gf[si] : 0;
        const r = ok ? cr[c] * f : 0, gg = ok ? cr[c + 1] * f : 0, b = ok ? cr[c + 2] * f : 0;
        for (let y = 0; y < cell; y++) {
          let o = ((j * cell + y) * size + i * cell) * 4;
          for (let x = 0; x < cell; x++, o += 4) { d[o] = r; d[o + 1] = gg; d[o + 2] = b; d[o + 3] = 255; }
        }
      }
    }
    // 2. each dot, nudged along its own slow circle
    for (let j = 0; j < n; j++) {
      const gy = gy0 + j;
      if (gy < 0 || gy >= gh) continue;
      for (let i = 0; i < n; i++) {
        const gx = gx0 + i;
        if (gx < 0 || gx >= gw) continue;
        const si = gy * gw + gx;
        const mx = gx * cell - cx, my = gy * cell - cy;
        const w = Math.exp(-(mx * mx + my * my) / (2 * sig2));
        let ox = i * cell, oy = j * cell;
        if (w > 0.03) {
          const ph = rand(si + 104729) * 6.2832, sp = 1.6 + rand(si + 1299709) * 2.2;
          ox += Math.round(Math.cos(ph + t * sp) * amp * w);
          oy += Math.round(Math.sin(ph + t * sp * 0.9) * amp * w);
        }
        const c = si * 3;
        const r = cr[c], gg = cr[c + 1], b = cr[c + 2];
        for (let y = 0; y < inner; y++) {
          const yy = oy + y;
          if (yy < 0 || yy >= size) continue;
          let o = (yy * size + ox) * 4;
          for (let x = 0; x < inner; x++, o += 4) {
            const xx = ox + x;
            if (xx < 0 || xx >= size) continue;
            d[o] = r; d[o + 1] = gg; d[o + 2] = b;
          }
        }
      }
    }
    moverCtx.putImageData(moverImg, 0, 0);
    // place the patch over the same cells of the picture
    const lr = layer.getBoundingClientRect(), ar = layer.parentElement.getBoundingClientRect();
    const k = lr.width / layer.width; // device px -> css px
    mover.style.width = mover.style.height = size * k + 'px';
    mover.style.transform = `translate3d(${lr.left - ar.left + gx0 * cell * k}px, ${lr.top - ar.top + gy0 * cell * k}px, 0)`;
  }
  // Runs only while the dots are moving or settling, then stops.
  function moverStep(now) {
    raf = 0;
    cx += (px - cx) * 0.2; cy += (py - cy) * 0.2;
    str += (want - str) * (want ? 0.12 : 0.07);
    if (str <= 0.01 && want === 0) { str = 0; if (mover) mover.style.display = 'none'; return; }
    if (mover) mover.style.display = 'block';
    drawMover(now);
    raf = requestAnimationFrame(moverStep);
  }
  window.addEventListener('pointermove', (e) => {
    if (!grid || !layer || !document.body.classList.contains('wp-follow')) return;
    ensureMover();
    const lr = layer.getBoundingClientRect();
    const k = layer.width / lr.width;
    px = (e.clientX - lr.left) * k; py = (e.clientY - lr.top) * k;
    if (!inside || str === 0) { cx = px; cy = py; inside = true; }
    want = 1;
    // settle half a second after the pointer rests
    clearTimeout(idleT);
    idleT = setTimeout(() => { want = 0; }, 500);
    if (!raf) raf = requestAnimationFrame(moverStep);
  }, { passive: true });
  const leave = () => { inside = false; want = 0; clearTimeout(idleT); };
  document.addEventListener('mouseleave', leave);
  window.addEventListener('blur', leave);

  // How bright the picture is right behind an element (0 to 1), from a 16x4 sample of the canvas.
  function lumUnder(el) {
    if (!layer || !layer.width || !el) return -1;
    const r = el.getBoundingClientRect(), lr = layer.getBoundingClientRect();
    if (!r.width || !lr.width) return -1;
    const k = layer.width / lr.width;
    const sx = Math.max(0, (r.left - lr.left) * k), sy = Math.max(0, (r.top - lr.top) * k);
    const sw = Math.min(layer.width - sx, r.width * k), sh = Math.min(layer.height - sy, r.height * k);
    if (sw <= 0 || sh <= 0) return -1;
    const c = document.createElement('canvas');
    c.width = 16; c.height = 4;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(layer, sx, sy, sw, sh, 0, 0, 16, 4);
    const d = x.getImageData(0, 0, 16, 4).data;
    let l = 0;
    for (let i = 0; i < d.length; i += 4) l += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    return l / 64 / 255;
  }
  // The home question picks white or ink from what is right behind it.
  function retone() {
    const t = document.querySelector('#viewHome .home-title');
    if (!document.body.classList.contains('has-wallpaper') || !t || !t.offsetParent) return;
    const l = lumUnder(t);
    if (l < 0) return;
    const dim = Math.max(0, Math.min(85, get().dim)) / 100;
    document.body.dataset.wpTitleTone = l * (1 - dim) > 0.6 ? 'light' : 'dark';
  }

  function set(patch) {
    const v = { ...get(), ...patch };
    save(v);
    if (Object.keys(patch).length === 1 && 'dim' in patch) { setDim(v.dim); return; }
    if (Object.keys(patch).length === 1 && 'follow' in patch) { document.body.classList.toggle('wp-follow', !!(v.dither && v.follow)); return; }
    if (Object.keys(patch).length === 1 && 'sidebar' in patch) { document.body.classList.toggle('wp-glass-sidebar', v.sidebar === 'glass'); return; }
    apply(v);
  }

  // ─── The picker (Settings > Appearance) ─────────────────────────────────────
  const thumbs = {};
  function builtinThumb(b) {
    if (thumbs[b.id]) return thumbs[b.id];
    const c = document.createElement('canvas');
    c.width = 192; c.height = 120;
    b.draw(c.getContext('2d'), 192, 120);
    thumbs[b.id] = c.toDataURL('image/jpeg', 0.86);
    return thumbs[b.id];
  }
  let userList = null;
  async function refreshUserList() {
    try { userList = api && api.wallpaperList ? await api.wallpaperList() : []; } catch { userList = []; }
    return userList;
  }

  const escAttr = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function tile(id, name, thumb, { cur, removable, extra = '' } = {}) {
    const on = id === cur;
    return `<div class="wp-tile-wrap"><button type="button" class="wp-tile${on ? ' on' : ''}${extra}" data-wp="${escAttr(id)}" role="radio" aria-checked="${on}" aria-label="${escAttr(name)}">` +
      (thumb ? `<img src="${escAttr(thumb)}" alt="" draggable="false">` : '') +
      `</button><span class="wp-name">${escAttr(name)}</span>` +
      (removable ? `<button type="button" class="wp-remove" data-wp-remove="${escAttr(id)}" title="Remove" aria-label="Remove ${escAttr(name)}">${window.icon ? window.icon('close', 'ico-sm') : '×'}</button>` : '') +
      `</div>`;
  }

  // The rows for Settings > Appearance. The user's images are filled in by
  // hydrate() once the list comes back from the main process.
  function settingsHtml() {
    const v = get();
    const on = v.id !== 'none';
    const canAdd = !!(api && api.wallpaperAdd);
    const tiles = [
      tile('none', 'None', '', { cur: v.id, extra: ' wp-none' }),
      ...BUILTINS.map((b) => tile(b.id, b.name, builtinThumb(b), { cur: v.id })),
      ...(userList || []).map((u) => tile(u.id, u.name, u.thumb, { cur: v.id, removable: true })),
      canAdd ? `<div class="wp-tile-wrap"><button type="button" class="wp-tile wp-add" data-wp-add aria-label="Add your own">${window.icon ? window.icon('plus', 'ico-md') : '+'}</button><span class="wp-name">Add your own</span></div>` : '',
    ].join('');
    const range = (key, min, max, val, unit, label) =>
      `<div class="set-range"><input type="range" min="${min}" max="${max}" step="1" value="${val}" data-wp-range="${key}" aria-label="${label}"><span class="set-val">${val}${unit}</span></div>`;
    return `<div class="set-row set-row-block wp-picker">
        <div class="set-text"><div class="set-title">Background</div><div class="set-desc">A picture behind the chat, with the box and dialogs turned to frosted glass. Your own images stay on this PC.</div></div>
        <div class="wp-grid" role="radiogroup" aria-label="Background">${tiles}</div>
        <div class="wp-error hidden" role="alert"></div>
      </div>` +
      (on ? [
        `<div class="set-row"><div class="set-text"><div class="set-title">Sidebar</div><div class="set-desc">Keep it solid, or let the picture show through it too.</div></div><div class="set-ctl"><div class="segmented segmented-sm set-seg" role="radiogroup" data-wp-seg="sidebar">${[['solid', 'Solid'], ['glass', 'Glass']].map(([k, l]) => `<button type="button" role="radio" class="segmented-item${v.sidebar === k ? ' active' : ''}" data-wp-val="${k}" aria-checked="${v.sidebar === k}">${l}</button>`).join('')}</div></div></div>`,
        `<div class="set-row"><div class="set-text"><div class="set-title">Dot pattern</div><div class="set-desc">Draw the picture as fine dots, like a print.</div></div><div class="set-ctl"><input type="checkbox" class="switch" role="switch" data-wp-dither aria-label="Dot pattern"${v.dither ? ' checked' : ''}></div></div>`,
        v.dither ? `<div class="set-row"><div class="set-text"><div class="set-title">Dots move with the cursor</div><div class="set-desc">The dots near your pointer wobble gently while it moves.</div></div><div class="set-ctl"><input type="checkbox" class="switch" role="switch" data-wp-follow aria-label="Dots move with the cursor"${v.follow ? ' checked' : ''}></div></div>` : '',
        `<div class="set-row"><div class="set-text"><div class="set-title">Dim</div></div><div class="set-ctl">${range('dim', 0, 80, v.dim, '%', 'Dim')}</div></div>`,
        `<div class="set-row"><div class="set-text"><div class="set-title">Blur</div></div><div class="set-ctl">${range('blur', 0, 40, v.blur, 'px', 'Blur')}</div></div>`,
      ].join('') : '');
  }

  // Wires the picker inside a settings pane; redraw() draws the pane again.
  let redrawPane = null;
  function bind(pane, redraw) {
    redrawPane = redraw;
    if (pane.dataset.wpBound) return;
    pane.dataset.wpBound = '1';
    pane.addEventListener('click', async (e) => {
      const rm = e.target.closest('[data-wp-remove]');
      if (rm) {
        e.stopPropagation();
        const id = rm.dataset.wpRemove;
        if (api && api.wallpaperRemove) await api.wallpaperRemove(id);
        if (get().id === id) set({ id: 'none' });
        await refreshUserList();
        redraw();
        return;
      }
      if (e.target.closest('[data-wp-add]')) {
        const r = await api.wallpaperAdd();
        if (!r) return;
        if (r.error) {
          const err = pane.querySelector('.wp-error');
          if (err) { err.textContent = r.error; err.classList.remove('hidden'); }
          return;
        }
        await refreshUserList();
        set({ id: r.id });
        redraw();
        return;
      }
      const sg = e.target.closest('[data-wp-seg] [data-wp-val]');
      if (sg) { set({ [sg.parentElement.dataset.wpSeg]: sg.dataset.wpVal }); redraw(); return; }
      const t = e.target.closest('[data-wp]');
      if (t) {
        set({ id: t.dataset.wp });
        redraw();
      }
    });
    pane.addEventListener('input', (e) => {
      const r = e.target.closest('[data-wp-range]');
      if (!r) return;
      const k = r.dataset.wpRange;
      r.parentElement.querySelector('.set-val').textContent = r.value + (k === 'dim' ? '%' : 'px');
      if (k === 'dim') set({ dim: Number(r.value) });
    });
    pane.addEventListener('change', (e) => {
      const r = e.target.closest('[data-wp-range]');
      if (r && r.dataset.wpRange === 'blur') { set({ blur: Number(r.value) }); return; }
      const d = e.target.closest('[data-wp-dither]');
      if (d) { set({ dither: d.checked }); redrawPane && redrawPane(); return; }
      const f = e.target.closest('[data-wp-follow]');
      if (f) set({ follow: f.checked });
    });
  }

  // Loads the user's list the first time the picker opens, then draws it again with them in.
  async function hydrate(redraw) {
    if (userList) return;
    await refreshUserList();
    if (userList.length || get().id !== 'none') redraw();
  }

  // Settings is opening: read the user's images again on the next hydrate().
  function forget() { userList = null; }

  window.CraftWallpaper = { get, set, apply, retone, settingsHtml, bind, hydrate, forget, builtins: BUILTINS.map((b) => b.id), lastDrawMs: 0 };

  // On start: draw the saved choice once the window has settled.
  if (get().id !== 'none') {
    const go = () => apply();
    if (window.requestIdleCallback) requestIdleCallback(go, { timeout: 600 }); else setTimeout(go, 60);
  }
})();
