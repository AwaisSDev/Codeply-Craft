// Bot avatars: soft sticker characters, one inline SVG each.
//
// renderAvatar({ shape, eyes, color, glasses, accessory, mouth, cheeks }, size)
// returns an SVG string. It runs in the desktop window, the phone and plain
// Node (the engine tests render every combination), so it touches no DOM
// unless injectAvatarStyles() is called in a browser.
//
// Look: a puffy rounded silhouette (bursts, scallops, clouds...) with a thick
// white sticker outline, a matte body that is lighter in the middle and
// darker at the rim, and white eyes with a soft glow. Light bodies get dark
// eyes so they always read. Idle: a slow float and a blink. "ba-working"
// makes the eyes look around and the glow pulse, "ba-done" swaps in a happy
// squint. prefers-reduced-motion and {still:true} stop all of it.
//
// Older saves used other keys (the first plush set, then a robot set).
// normalizeAvatar maps every one of them through LEGACY, so no bot breaks.
(function (root, factory) {
  const lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  if (typeof window !== 'undefined') window.CraftAvatar = lib;
  else if (root) root.CraftAvatar = lib;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const INK = '#232328';
  const WHITE = '#ffffff';
  const PAD = 10; // sticker outline width

  const COLORS = {
    graphite: '#3b3c42',
    green: '#3fae6a',
    blue: '#4a78e0',
    yellow: '#f0c14b',
    pink: '#e85d9a',
    orange: '#f08a4b',
    purple: '#8463e0',
    red: '#e05a5a',
    teal: '#2aa598',
    sky: '#58b9e6',
    lime: '#9ccf55',
  };

  const f1 = (v) => (Math.round(v * 10) / 10).toString();

  // A smooth closed curve through points (Catmull-Rom as cubic Beziers).
  function smooth(pts, t = 1) {
    const n = pts.length;
    const P = (i) => pts[(i + n) % n];
    let d = `M${f1(pts[0][0])} ${f1(pts[0][1])}`;
    for (let i = 0; i < n; i++) {
      const p0 = P(i - 1); const p1 = P(i); const p2 = P(i + 1); const p3 = P(i + 2);
      const c1 = [p1[0] + ((p2[0] - p0[0]) / 6) * t, p1[1] + ((p2[1] - p0[1]) / 6) * t];
      const c2 = [p2[0] - ((p3[0] - p1[0]) / 6) * t, p2[1] - ((p3[1] - p1[1]) / 6) * t];
      d += `C${f1(c1[0])} ${f1(c1[1])} ${f1(c2[0])} ${f1(c2[1])} ${f1(p2[0])} ${f1(p2[1])}`;
    }
    return `${d}Z`;
  }
  // Rounded spikes: each tip is two close points so it ends in a soft dome.
  function burst(n, R, r, cx = 60, cy = 62, t = 1, tip = 0.16) {
    const pts = [];
    const step = (2 * Math.PI) / n;
    const at = (a, rad) => [cx + rad * Math.cos(a), cy + rad * Math.sin(a)];
    for (let k = 0; k < n; k++) {
      const a = -Math.PI / 2 + k * step;
      pts.push(at(a - step * tip, R * 0.985), at(a + step * tip, R * 0.985), at(a + step / 2, r));
    }
    return smooth(pts, t);
  }
  // Round bumps between sharp-ish valleys.
  function scallop(n, inner, outer, cx = 60, cy = 62, spread = 0.42) {
    let d = '';
    for (let k = 0; k < n; k++) {
      const a0 = -Math.PI / 2 + (k * 2 * Math.PI) / n;
      const a1 = -Math.PI / 2 + ((k + 1) * 2 * Math.PI) / n;
      const am = (a0 + a1) / 2;
      const p0 = [cx + inner * Math.cos(a0), cy + inner * Math.sin(a0)];
      const c1 = [cx + outer * Math.cos(am - spread), cy + outer * Math.sin(am - spread)];
      const c2 = [cx + outer * Math.cos(am + spread), cy + outer * Math.sin(am + spread)];
      const p1 = [cx + inner * Math.cos(a1), cy + inner * Math.sin(a1)];
      if (k === 0) d += `M${f1(p0[0])} ${f1(p0[1])}`;
      d += `C${f1(c1[0])} ${f1(c1[1])} ${f1(c2[0])} ${f1(c2[1])} ${f1(p1[0])} ${f1(p1[1])}`;
    }
    return `${d}Z`;
  }
  function superellipse(rx, ry, p, cx = 60, cy = 62) {
    const pts = [];
    for (let k = 0; k < 24; k++) {
      const a = (k * 2 * Math.PI) / 24;
      const c = Math.cos(a); const s = Math.sin(a);
      pts.push([cx + rx * Math.sign(c) * Math.abs(c) ** (2 / p), cy + ry * Math.sign(s) * Math.abs(s) ** (2 / p)]);
    }
    return smooth(pts);
  }

  // Each body in a 120 x 120 box: its outline, where the eyes sit (ey, ex)
  // and the top of the head (top) for extras.
  const SHAPES = {
    burst9: { label: 'Burst', d: burst(9, 46, 32, 60, 62, 1, 0.1), ey: 62, ex: 10, top: 17 },
    burst7: { label: 'Big burst', d: burst(7, 47, 30, 60, 63, 1, 0.09), ey: 63, ex: 10, top: 16 },
    burst12: { label: 'Sunny', d: burst(12, 45, 35, 60, 62, 1, 0.12), ey: 62, ex: 10, top: 18 },
    flower: { label: 'Scallop', d: scallop(8, 35, 50), ey: 62, ex: 10, top: 18 },
    cloud: {
      label: 'Cloud',
      d: 'M32 96C16 96 11 80 21 71C13 60 22 45 37 48C40 33 58 27 69 36C79 26 98 33 98 50C110 54 112 71 102 79C107 91 97 98 87 96Z',
      ey: 68, ex: 11, top: 31,
    },
    star: { label: 'Star', d: burst(5, 47, 27, 60, 65, 0.9, 0.08), ey: 66, ex: 9, top: 17 },
    squircle: { label: 'Puffy', d: superellipse(40, 38, 4.2), ey: 62, ex: 11, top: 24 },
    pebble: {
      label: 'Pebble',
      d: smooth([[60, 26], [86, 31], [100, 54], [96, 82], [72, 98], [44, 97], [22, 80], [20, 52], [36, 32]]),
      ey: 62, ex: 11, top: 26,
    },
    drop: {
      label: 'Drop',
      d: 'M60 16C70 32 98 50 98 74C98 95 81 106 60 106C39 106 22 95 22 74C22 50 50 32 60 16Z',
      ey: 74, ex: 11, top: 20,
    },
  };

  const EYES = {
    pills: { label: 'Glow pills' },
    dots: { label: 'Dots' },
    ovals: { label: 'Wide ovals' },
    sleepy: { label: 'Sleepy' },
    happy: { label: 'Happy' },
    sparkle: { label: 'Sparkle' },
    big: { label: 'One eye' },
  };
  const MOUTHS = { none: { label: 'None' }, smile: { label: 'Smile' }, o: { label: 'Oh' }, flat: { label: 'Flat' } };
  const GLASSES = { none: { label: 'None' }, round: { label: 'Rings' }, visor: { label: 'Visor' }, monocle: { label: 'Monocle' } };
  const ACCESSORIES = {
    none: { label: 'None' }, antenna: { label: 'Antenna' }, halo: { label: 'Halo' }, sprout: { label: 'Sprout' },
    sparkles: { label: 'Sparkles' }, star: { label: 'Star' },
  };

  // Keys from the earlier avatar sets, mapped to their closest new piece.
  const LEGACY = {
    shape: {
      bean: 'pebble', blob: 'pebble', round: 'squircle', pear: 'drop', heart: 'flower', frog: 'cloud', ghost: 'drop',
      capsule: 'squircle', pill: 'pebble', hexagon: 'burst7', octagon: 'flower', chip: 'squircle', orb: 'burst12', shield: 'drop', dome: 'cloud', monitor: 'squircle',
    },
    eyes: {
      diamond: 'pills', wide: 'ovals',
      led: 'pills', pixel: 'dots', lens: 'big', visor: 'pills', arcs: 'happy', slits: 'sleepy', rings: 'ovals', plus: 'sparkle',
    },
    glasses: { square: 'round', sunglasses: 'visor', frames: 'round', shades: 'visor', hud: 'round' },
    accessory: {
      beret: 'sprout', bowtie: 'star', cap: 'antenna', headphones: 'antenna', flower: 'sprout', crown: 'halo',
      twin: 'antenna', headset: 'antenna', propeller: 'sprout', fins: 'sparkles', badge: 'star',
    },
    mouth: { grin: 'smile', line: 'flat', curve: 'smile', wave: 'smile', grille: 'flat' },
  };

  const DEFAULT = { shape: 'burst9', eyes: 'pills', color: 'graphite', glasses: 'none', accessory: 'none', mouth: 'none', cheeks: false };

  const HEX = /^#[0-9a-f]{6}$/i;
  const has = (o, v) => typeof v === 'string' && Object.prototype.hasOwnProperty.call(o, v);
  function colorHex(c) {
    if (has(COLORS, c)) return COLORS[c];
    if (typeof c === 'string' && HEX.test(c)) return c.toLowerCase();
    if (typeof c === 'string' && /^#[0-9a-f]{3}$/i.test(c)) return `#${c.slice(1).split('').map((x) => x + x).join('')}`.toLowerCase();
    return COLORS.graphite;
  }
  function mix(hex, toward, amount) {
    const a = parseInt(hex.slice(1), 16);
    const b = parseInt(toward.slice(1), 16);
    const ch = (v, s) => (v >> s) & 255;
    const m = (s) => Math.round(ch(a, s) + (ch(b, s) - ch(a, s)) * amount);
    return `#${((1 << 24) + (m(16) << 16) + (m(8) << 8) + m(0)).toString(16).slice(1)}`;
  }
  function luma(hex) {
    const v = parseInt(hex.slice(1), 16);
    return (0.2126 * ((v >> 16) & 255) + 0.7152 * ((v >> 8) & 255) + 0.0722 * (v & 255)) / 255;
  }

  /** Any partial, old or unknown avatar becomes a complete, valid one. */
  function normalizeAvatar(a) {
    a = a && typeof a === 'object' ? a : {};
    const pick = (k, table, def) => {
      const v = a[k];
      if (has(table, v)) return v;
      return has(LEGACY[k], v) ? LEGACY[k][v] : def;
    };
    return {
      shape: pick('shape', SHAPES, DEFAULT.shape),
      eyes: pick('eyes', EYES, DEFAULT.eyes),
      color: has(COLORS, a.color) || HEX.test(String(a.color || '')) ? a.color : DEFAULT.color,
      glasses: pick('glasses', GLASSES, 'none'),
      accessory: pick('accessory', ACCESSORIES, 'none'),
      mouth: pick('mouth', MOUTHS, 'none'),
      cheeks: !!a.cheeks,
    };
  }

  /** A pleasant random avatar; the same seed always gives the same one. */
  function randomAvatar(seed) {
    let s = 0;
    for (const ch of String(seed == null ? Math.random() : seed)) s = (s * 31 + ch.charCodeAt(0)) >>> 0;
    const pick = (list) => { s = (s * 1103515245 + 12345) >>> 0; return list[(s >>> 8) % list.length]; };
    return normalizeAvatar({
      shape: pick(Object.keys(SHAPES)),
      eyes: pick(['pills', 'pills', 'pills', 'dots', 'ovals', 'happy', 'sparkle', 'big', 'sleepy']),
      color: pick(['graphite', 'graphite', ...Object.keys(COLORS)]),
      glasses: pick(['none', 'none', 'none', 'none', 'round', 'visor', 'monocle']),
      accessory: pick(['none', 'none', 'none', 'antenna', 'halo', 'sprout', 'sparkles', 'star']),
      mouth: pick(['none', 'none', 'none', 'smile', 'o']),
      cheeks: pick([false, false, false, true]),
    });
  }

  function eyeSvg(kind, x, y, c, side) {
    const t = `transform="translate(${f1(x)} ${f1(y)})"`;
    switch (kind) {
      case 'dots': return `<circle ${t} r="5.2" fill="${c}"/>`;
      case 'ovals': return `<ellipse ${t} rx="6.2" ry="8.6" fill="${c}"/>`;
      case 'sleepy': return `<path ${t} d="M-6 -1Q0 4.5 6 -1" fill="none" stroke="${c}" stroke-width="3.4" stroke-linecap="round"/>`;
      case 'happy': return `<path ${t} d="M-6 2.5Q0 -5.5 6 2.5" fill="none" stroke="${c}" stroke-width="3.4" stroke-linecap="round"/>`;
      case 'sparkle': return `<path ${t} d="M0 -8.5Q1.3 -1.3 8 0Q1.3 1.3 0 8.5Q-1.3 1.3 -8 0Q-1.3 -1.3 0 -8.5Z" fill="${c}"/>`;
      default: { // pills: the right one a touch shorter
        const h = side ? 18.5 : 21.5;
        return `<rect ${t} x="-5.2" y="${f1(-h / 2)}" width="10.4" height="${h}" rx="5.2" fill="${c}"/>`;
      }
    }
  }
  function eyesSvg(kind, s, c) {
    if (kind === 'big') return `<ellipse cx="60" cy="${s.ey}" rx="9.5" ry="12.5" fill="${c}"/>`;
    return eyeSvg(kind, 60 - s.ex, s.ey, c, 0) + eyeSvg(kind, 60 + s.ex, s.ey, c, 1);
  }

  function mouthSvg(kind, s, c) {
    const y = s.ey + (s.mouthDy || 17);
    if (kind === 'smile') return `<path d="M54 ${y}Q60 ${y + 5.5} 66 ${y}" fill="none" stroke="${c}" stroke-width="2.8" stroke-linecap="round"/>`;
    if (kind === 'o') return `<ellipse cx="60" cy="${y + 1.5}" rx="3" ry="3.8" fill="${c}"/>`;
    if (kind === 'flat') return `<path d="M56 ${y + 1}H64" stroke="${c}" stroke-width="2.8" stroke-linecap="round"/>`;
    return '';
  }

  function opticsSvg(kind, s, c, big) {
    const l = 60 - s.ex; const r = 60 + s.ex; const y = s.ey;
    if (kind === 'round') {
      if (big) return `<circle cx="60" cy="${y}" r="17" fill="none" stroke="${c}" stroke-width="2.2" opacity="0.8"/>`;
      return `<g fill="none" stroke="${c}" stroke-width="2.2" opacity="0.8"><circle cx="${l}" cy="${y}" r="11.5"/><circle cx="${r}" cy="${y}" r="11.5"/><path d="M${l + 9} ${y - 5}Q60 ${y - 9} ${r - 9} ${y - 5}"/></g>`;
    }
    if (kind === 'visor') {
      return `<rect x="${l - 15}" y="${y - 12.5}" width="${r - l + 30}" height="25" rx="12.5" fill="#000" opacity="0.28"/>` +
        `<rect x="${l - 15}" y="${y - 12.5}" width="${r - l + 30}" height="25" rx="12.5" fill="none" stroke="${c}" stroke-width="1.6" opacity="0.55"/>`;
    }
    if (kind === 'monocle') {
      const mx = big ? 60 : r; const rad = big ? 17 : 11.5;
      return `<g fill="none" stroke="${c}" stroke-width="2.2" opacity="0.8"><circle cx="${mx}" cy="${y}" r="${rad}"/><path d="M${mx + rad * 0.72} ${y + rad * 0.72}Q${mx + rad + 3} ${y + rad + 8} ${mx + rad - 2} ${y + rad + 16}"/></g>`;
    }
    return '';
  }

  function sparkPath(x, y, r) {
    const q = r * 0.18;
    return `M${f1(x)} ${f1(y - r)}Q${f1(x + q)} ${f1(y - q)} ${f1(x + r)} ${f1(y)}Q${f1(x + q)} ${f1(y + q)} ${f1(x)} ${f1(y + r)}Q${f1(x - q)} ${f1(y + q)} ${f1(x - r)} ${f1(y)}Q${f1(x - q)} ${f1(y - q)} ${f1(x)} ${f1(y - r)}Z`;
  }
  function starPath(x, y, R) {
    let d = '';
    for (let k = 0; k < 10; k++) {
      const a = -Math.PI / 2 + (k * Math.PI) / 5;
      const rad = k % 2 ? R * 0.48 : R;
      d += `${k ? 'L' : 'M'}${f1(x + rad * Math.cos(a))} ${f1(y + rad * Math.sin(a))}`;
    }
    return `${d}Z`;
  }

  // Extras: { sil(pad): parts that join the sticker outline, fill: the colored parts }.
  function extra(kind, s, body, eye) {
    const top = s.top;
    switch (kind) {
      case 'antenna': {
        const by = top - 14;
        return {
          sil: (p) => `<path d="M60 ${top + 6}V${by}" fill="none" stroke-width="${3.6 + p}"/><circle cx="60" cy="${by}" r="5.2" stroke-width="${p}"/>`,
          fill: `<path d="M60 ${top + 6}V${by}" stroke="${body}" stroke-width="3.6" stroke-linecap="round"/><circle class="ba-glow" cx="60" cy="${by}" r="5.2" fill="${eye}"/>`,
        };
      }
      case 'halo':
        return {
          sil: (p) => `<ellipse cx="60" cy="${top - 9}" rx="18" ry="5" fill="none" stroke-width="${3.4 + p * 0.7}"/>`,
          fill: `<ellipse class="ba-glow" cx="60" cy="${top - 9}" rx="18" ry="5" fill="none" stroke="#ffd866" stroke-width="3.4"/>`,
        };
      case 'sprout': {
        const leafL = `M60 ${top + 2}C54 ${top - 4} 46 ${top - 6} 42 ${top - 12}C50 ${top - 15} 58 ${top - 10} 60 ${top + 2}Z`;
        const leafR = `M60 ${top + 2}C64 ${top - 8} 72 ${top - 16} 80 ${top - 15}C78 ${top - 6} 70 ${top} 60 ${top + 2}Z`;
        return {
          sil: (p) => `<path d="${leafL}" stroke-width="${p}"/><path d="${leafR}" stroke-width="${p}"/>`,
          fill: `<path d="${leafL}" fill="#5cbf6e"/><path d="${leafR}" fill="#6fd37f"/>`,
        };
      }
      case 'sparkles': {
        const a = sparkPath(92, top + 2, 8); const b = sparkPath(101, top + 15, 4.5);
        return {
          sil: (p) => `<path d="${a}" stroke-width="${p * 0.8}"/><path d="${b}" stroke-width="${p * 0.8}"/>`,
          fill: `<path class="ba-glow" d="${a}" fill="#ffd866"/><path class="ba-glow" d="${b}" fill="#ffd866"/>`,
        };
      }
      case 'star': {
        const d = starPath(84, top + 6, 9);
        return { sil: (p) => `<path d="${d}" stroke-width="${p}"/>`, fill: `<path d="${d}" fill="#ffd866"/>` };
      }
      default: return { sil: () => '', fill: '' };
    }
  }

  let counter = 0;

  /**
   * @param {object} avatar  {shape, eyes, color, glasses, accessory, mouth, cheeks}
   * @param {number} [size]  pixel size of the square (default 64)
   * @param {object} [opts]  {state:'idle'|'working'|'done', still:boolean, flat:boolean, title:string, zoom:'face'}
   */
  function renderAvatar(avatar, size, opts) {
    const a = normalizeAvatar(avatar);
    size = Math.max(8, Math.round(Number(size) || 64));
    opts = opts || {};
    const s = SHAPES[a.shape];
    const fill = colorHex(a.color);
    counter++;
    const id = `ba${counter.toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    // Small avatars skip the blur and grain: they cost paint time and vanish at that size.
    const flat = opts.flat || size < 40;
    const lightBody = luma(fill) > 0.6;
    const eye = lightBody ? INK : WHITE;
    const ex = extra(a.accessory, s, mix(fill, '#000000', 0.12), lightBody ? '#ffffff' : '#ffffff');
    const big = a.eyes === 'big';
    const delay = (counter * 0.77) % 5;
    const state = opts.state === 'working' ? ' ba-working' : opts.state === 'done' ? ' ba-done' : '';
    const sil = (p) => `<path d="${s.d}" stroke-width="${p}"/>${ex.sil(p)}`;
    const defs = `<defs>` +
      `<radialGradient id="${id}s" cx="0.46" cy="0.42" r="0.62"><stop offset="0" stop-color="${mix(fill, '#ffffff', lightBody ? 0.24 : 0.2)}"/><stop offset="0.55" stop-color="${fill}"/><stop offset="1" stop-color="${mix(fill, '#000000', 0.3)}"/></radialGradient>` +
      (flat ? '' :
        `<filter id="${id}b" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="2.6"/></filter>` +
        `<filter id="${id}g" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="2.4"/></filter>` +
        `<filter id="${id}n" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="1.1" numOctaves="2" seed="${counter % 97}"/>` +
        `<feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.6 -0.25"/><feComposite in2="SourceGraphic" operator="in"/></filter>`) +
      `</defs>`;
    const shadow = `<g class="ba-shadow" fill="#000" stroke="#000" stroke-linejoin="round" stroke-linecap="round" opacity="${flat ? 0.1 : 0.2}" transform="translate(0 ${flat ? 2 : 3})"${flat ? '' : ` filter="url(#${id}b)"`}>${sil(PAD)}</g>`;
    const outline = `<g fill="${WHITE}" stroke="${WHITE}" stroke-linejoin="round" stroke-linecap="round">${sil(PAD)}</g>`;
    const bodySvg = `<path d="${s.d}" fill="url(#${id}s)"/>` + (flat ? '' : `<path d="${s.d}" fill="#fff" filter="url(#${id}n)" opacity="0.22"/>`);
    const eyesMain = eyesSvg(a.eyes, s, eye);
    const eyesHappy = eyesSvg('happy', s, eye);
    const glow = (svg) => (flat || lightBody ? '' : `<g class="ba-glow" filter="url(#${id}g)" opacity="0.85">${svg}</g>`);
    const cheeks = a.cheeks
      ? `<g fill="#ff8fb4" opacity="${lightBody ? 0.6 : 0.42}"><ellipse cx="${60 - s.ex - 10}" cy="${s.ey + 11}" rx="5.5" ry="3.3"/><ellipse cx="${60 + s.ex + 10}" cy="${s.ey + 11}" rx="5.5" ry="3.3"/></g>` : '';
    const title = opts.title ? `<title>${String(opts.title).replace(/[<&>"]/g, (c) => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;', '"': '&quot;' })[c])}</title>` : '';
    const vb = opts.zoom === 'face' ? `30 ${s.ey - 30} 60 60` : '0 0 120 120';
    return `<svg class="ba${state}${opts.still ? ' ba-still' : ''}" xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="${size}" height="${size}" role="img" aria-label="${a.shape} avatar" style="--ba-d:-${delay.toFixed(2)}s${opts.zoom === 'face' ? ';overflow:hidden' : ''}">${title}${defs}` +
      `<g class="ba-float">` + shadow + outline + bodySvg + ex.fill + cheeks +
      `<g class="ba-look"><g class="ba-eyes ba-eyes-main">${glow(eyesMain)}${eyesMain}</g><g class="ba-eyes ba-eyes-happy">${glow(eyesHappy)}${eyesHappy}</g></g>` +
      mouthSvg(a.mouth, s, eye) + opticsSvg(a.glasses, s, eye, big) +
      `</g></svg>`;
  }

  const AVATAR_CSS = `
.ba { display: block; overflow: visible; flex-shrink: 0; }
.ba .ba-float { animation: ba-float 5s ease-in-out infinite; animation-delay: var(--ba-d, 0s); }
.ba .ba-eyes-main { transform-box: fill-box; transform-origin: 50% 50%; animation: ba-blink 5.4s infinite; animation-delay: var(--ba-d, 0s); }
.ba .ba-eyes-happy { display: none; }
.ba.ba-done .ba-eyes-main { display: none; }
.ba.ba-done .ba-eyes-happy { display: inline; }
.ba.ba-done .ba-float { animation: ba-hop 0.7s ease-out 1, ba-float 5s ease-in-out 0.7s infinite; }
.ba.ba-working .ba-look { animation: ba-look 2.4s ease-in-out infinite; }
.ba.ba-working .ba-glow { animation: ba-pulse 1.2s ease-in-out infinite; }
.ba.ba-working .ba-float { animation-duration: 2.6s; }
.ba.ba-still *, .ba.ba-still { animation: none !important; }
@keyframes ba-float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-2.5px); } }
@keyframes ba-blink { 0%, 92%, 100% { transform: scaleY(1); } 95% { transform: scaleY(0.12); } }
@keyframes ba-look { 0%, 100% { transform: translate(0, 0); } 20% { transform: translate(-3.5px, -1px); } 45% { transform: translate(3.5px, -1px); } 70% { transform: translate(2px, 1.5px); } }
@keyframes ba-pulse { 0%, 100% { opacity: 0.9; } 50% { opacity: 0.35; } }
@keyframes ba-hop { 0% { transform: translateY(0); } 35% { transform: translateY(-7px); } 70% { transform: translateY(0); } 85% { transform: translateY(-1.5px); } 100% { transform: translateY(0); } }
@media (prefers-reduced-motion: reduce) { .ba *, .ba { animation: none !important; } }
`;

  function injectAvatarStyles(doc) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    if (!doc || doc.getElementById('craft-avatar-css')) return;
    const st = doc.createElement('style');
    st.id = 'craft-avatar-css';
    st.textContent = AVATAR_CSS;
    (doc.head || doc.documentElement).appendChild(st);
  }

  /** Switch a rendered avatar (the <svg> or an element holding it) between idle, working and done. */
  function setAvatarState(el, state) {
    const svg = el && (el.classList && el.classList.contains('ba') ? el : el.querySelector && el.querySelector('svg.ba'));
    if (!svg) return;
    svg.classList.toggle('ba-working', state === 'working');
    svg.classList.toggle('ba-done', state === 'done');
  }

  if (typeof document !== 'undefined') injectAvatarStyles();

  return {
    renderAvatar, normalizeAvatar, randomAvatar, colorHex, setAvatarState, injectAvatarStyles, AVATAR_CSS,
    SHAPES: Object.fromEntries(Object.entries(SHAPES).map(([k, v]) => [k, { label: v.label }])),
    EYES, GLASSES, ACCESSORIES, MOUTHS, COLORS, DEFAULT, LEGACY,
  };
});
