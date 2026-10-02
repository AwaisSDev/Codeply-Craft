// Bot avatars: small flat geometric robots, one inline SVG each.
//
// renderAvatar({ shape, eyes, color, glasses, accessory, mouth, cheeks }, size)
// returns an SVG string. It runs in the desktop window, the phone and plain
// Node (the engine tests render every combination), so it touches no DOM
// unless injectAvatarStyles() is called in a browser.
//
// Look: a crisp flat body in one solid color, a dark screen for a face, and
// eyes that glow in a pale tint of the body color. No textures, no blur.
// Idle: a slow float and a blink every few seconds. Class "ba-working" makes
// the eyes scan and the antenna light pulse, "ba-done" swaps in happy arcs.
// prefers-reduced-motion stops all of it.
//
// Older saves used other keys (bean, diamond, beret...). normalizeAvatar maps
// every one of them through LEGACY, so an old bot always renders.
(function (root, factory) {
  const lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  if (typeof window !== 'undefined') window.CraftAvatar = lib;
  else if (root) root.CraftAvatar = lib;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const COLORS = {
    green: '#2fbf71',
    blue: '#4f7cff',
    yellow: '#f5c142',
    pink: '#f2609e',
    orange: '#ff8a3d',
    purple: '#8b6cff',
    red: '#f25c5c',
    teal: '#1fb5a5',
    sky: '#45bff0',
    lime: '#98d24a',
  };

  const rr = (x, y, w, h, r) =>
    `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`;
  function poly(cx, cy, n, R, rot) {
    let d = '';
    for (let k = 0; k < n; k++) {
      const a = rot + (k * 2 * Math.PI) / n;
      d += `${k ? 'L' : 'M'}${(cx + R * Math.cos(a)).toFixed(1)} ${(cy + R * Math.sin(a)).toFixed(1)}`;
    }
    return `${d}Z`;
  }

  // Each body in a 120 x 120 box: its outline, an optional corner rounding
  // stroke (j), the face screen (x, y, w, h, r), the top of the head (top), the
  // left and right edges at eye level (sl, sr), the bottom (bot), where a badge
  // sits (bx, by) and optional parts drawn behind (back) or in front (front)
  // in a darker shade.
  const SHAPES = {
    squircle: {
      label: 'Squircle', d: rr(24, 30, 72, 70, 24),
      scr: [33, 44, 54, 36, 12], top: 30, sl: 24, sr: 96, bot: 100, bx: 80, by: 90,
    },
    capsule: {
      label: 'Capsule', d: rr(16, 40, 88, 58, 29),
      scr: [30, 50, 60, 36, 18], top: 40, sl: 16, sr: 104, bot: 98, bx: 92, by: 84,
    },
    pill: {
      label: 'Tall pill', d: rr(33, 20, 54, 86, 27),
      scr: [38, 38, 44, 34, 14], top: 20, sl: 33, sr: 87, bot: 106, bx: 60, by: 90,
    },
    hexagon: {
      label: 'Hexagon', d: poly(60, 64, 6, 39, -Math.PI / 2), j: 10,
      scr: [35, 48, 50, 32, 10], top: 20, sl: 22, sr: 98, bot: 108, bx: 60, by: 93,
    },
    octagon: {
      label: 'Octagon', d: poly(60, 65, 8, 40, Math.PI / 8), j: 10,
      scr: [34, 49, 52, 33, 10], top: 23, sl: 18, sr: 102, bot: 107, bx: 82, by: 92,
    },
    chip: {
      label: 'Chip', d: rr(30, 34, 60, 62, 10),
      scr: [37, 43, 46, 33, 7], top: 34, sl: 22, sr: 98, bot: 104, bx: 60, by: 87,
      back: (c) => {
        let p = '';
        for (const y of [50, 63, 76]) p += `<rect x="22" y="${y}" width="10" height="5" rx="2" fill="${c}"/><rect x="88" y="${y}" width="10" height="5" rx="2" fill="${c}"/>`;
        for (const x of [44, 57.5, 71]) p += `<rect x="${x}" y="92" width="5" height="10" rx="2" fill="${c}"/>`;
        return p;
      },
    },
    orb: {
      label: 'Orb', d: 'M24 64a36 36 0 1 0 72 0a36 36 0 1 0 -72 0Z',
      scr: [37, 47, 46, 30, 15], top: 28, sl: 24, sr: 96, bot: 100, bx: 60, by: 88,
      back: (c) => `<ellipse cx="60" cy="84" rx="50" ry="10" transform="rotate(-8 60 84)" fill="none" stroke="${c}" stroke-width="4"/>`,
      front: (c) => `<path d="M10 84A50 10 0 0 0 110 84" transform="rotate(-8 60 84)" fill="none" stroke="${c}" stroke-width="4" stroke-linecap="round"/>`,
    },
    shield: {
      label: 'Shield', d: 'M60 24L92 33Q95 34 95 38L95 60C95 82 80 96 60 104C40 96 25 82 25 60L25 38Q25 34 28 33Z', j: 8,
      scr: [35, 42, 50, 32, 10], top: 20, sl: 21, sr: 99, bot: 108, bx: 60, by: 88,
    },
    dome: {
      label: 'Dome', d: 'M22 94V68A38 38 0 0 1 98 68V94Q98 100 92 100H28Q22 100 22 94Z',
      scr: [33, 54, 54, 32, 12], top: 30, sl: 22, sr: 98, bot: 100, bx: 86, by: 92,
    },
    monitor: {
      label: 'Monitor', d: rr(18, 28, 84, 62, 13),
      scr: [27, 37, 66, 44, 7], top: 28, sl: 18, sr: 102, bot: 104, bx: 92, by: 84,
      back: (c) => `<rect x="54" y="86" width="12" height="12" fill="${c}"/><rect x="38" y="97" width="44" height="7" rx="3.5" fill="${c}"/>`,
    },
  };

  const EYES = {
    led: { label: 'LED bars' },
    pixel: { label: 'Pixels' },
    lens: { label: 'Lens' },
    visor: { label: 'Visor' },
    arcs: { label: 'Arcs' },
    slits: { label: 'Slits' },
    rings: { label: 'Rings' },
    plus: { label: 'Plus' },
  };
  const SINGLE = { lens: 1, visor: 1 };
  const MOUTHS = { none: { label: 'None' }, line: { label: 'Line' }, curve: { label: 'Curve' }, wave: { label: 'Wave' }, grille: { label: 'Grille' } };
  // "Optics": things worn over the screen.
  const GLASSES = { none: { label: 'None' }, frames: { label: 'Frames' }, monocle: { label: 'Monocle' }, shades: { label: 'Shades' }, hud: { label: 'HUD' } };
  const ACCESSORIES = {
    none: { label: 'None' }, antenna: { label: 'Antenna' }, twin: { label: 'Twin antennas' }, halo: { label: 'Halo' },
    headset: { label: 'Headset' }, propeller: { label: 'Propeller' }, fins: { label: 'Fins' }, badge: { label: 'Code badge' },
  };

  // Keys from the first avatar set, mapped to their closest new piece.
  const LEGACY = {
    shape: { bean: 'pill', blob: 'squircle', round: 'orb', pear: 'dome', cloud: 'capsule', heart: 'shield', frog: 'monitor', flower: 'octagon', star: 'hexagon', ghost: 'chip' },
    eyes: { diamond: 'lens', ovals: 'led', dots: 'pixel', happy: 'arcs', sleepy: 'slits', sparkle: 'plus', wide: 'rings' },
    glasses: { round: 'frames', square: 'hud', sunglasses: 'shades' },
    accessory: { beret: 'propeller', bowtie: 'badge', cap: 'antenna', headphones: 'headset', flower: 'fins', crown: 'halo' },
    mouth: { smile: 'curve', grin: 'wave', o: 'grille' },
  };

  const DEFAULT = { shape: 'squircle', eyes: 'led', color: 'green', glasses: 'none', accessory: 'none', mouth: 'none', cheeks: false };

  const HEX = /^#[0-9a-f]{6}$/i;
  function colorHex(c) {
    if (typeof c === 'string' && Object.prototype.hasOwnProperty.call(COLORS, c)) return COLORS[c];
    if (typeof c === 'string' && HEX.test(c)) return c.toLowerCase();
    if (typeof c === 'string' && /^#[0-9a-f]{3}$/i.test(c)) return `#${c.slice(1).split('').map((x) => x + x).join('')}`.toLowerCase();
    return COLORS.green;
  }
  function mix(hex, toward, amount) {
    const a = parseInt(hex.slice(1), 16);
    const b = parseInt(toward.slice(1), 16);
    const ch = (v, s) => (v >> s) & 255;
    const m = (s) => Math.round(ch(a, s) + (ch(b, s) - ch(a, s)) * amount);
    return `#${((1 << 24) + (m(16) << 16) + (m(8) << 8) + m(0)).toString(16).slice(1)}`;
  }

  /** Any partial, old or unknown avatar becomes a complete, valid one. */
  function normalizeAvatar(a) {
    a = a && typeof a === 'object' ? a : {};
    const has = (o, v) => typeof v === 'string' && Object.prototype.hasOwnProperty.call(o, v);
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
      eyes: pick(['led', 'led', 'pixel', 'lens', 'visor', 'arcs', 'rings', 'plus', 'slits']),
      color: pick(Object.keys(COLORS)),
      glasses: pick(['none', 'none', 'none', 'frames', 'hud', 'shades', 'monocle']),
      accessory: pick(['none', 'none', 'antenna', 'twin', 'halo', 'headset', 'propeller', 'fins', 'badge']),
      mouth: pick(['none', 'none', 'curve', 'line', 'wave', 'grille']),
      cheeks: pick([false, false, true]),
    });
  }

  // Face geometry derived from the screen.
  function face(s) {
    const [x, y, w, h] = s.scr;
    const cx = x + w / 2;
    const ex = Math.min(13, w * 0.22);
    return { cx, ey: y + h * 0.42, ex, l: cx - ex, r: cx + ex, my: y + h * 0.78 };
  }

  function eyesSvg(kind, f, c) {
    const one = (x) => {
      const t = `transform="translate(${x} ${f.ey.toFixed(1)})"`;
      switch (kind) {
        case 'pixel': return `<rect ${t} x="-4" y="-4" width="8" height="8" rx="1.5" fill="${c}"/>`;
        case 'arcs': return `<path ${t} d="M-5.5 2.5Q0 -5.5 5.5 2.5" fill="none" stroke="${c}" stroke-width="3" stroke-linecap="round"/>`;
        case 'slits': return `<rect ${t} x="-6" y="-1.75" width="12" height="3.5" rx="1.75" fill="${c}"/>`;
        case 'rings': return `<circle ${t} r="4.6" fill="none" stroke="${c}" stroke-width="2.6"/>`;
        case 'plus': return `<path ${t} d="M0 -5V5M-5 0H5" fill="none" stroke="${c}" stroke-width="3" stroke-linecap="round"/>`;
        default: return `<rect ${t} x="-3" y="-6" width="6" height="12" rx="3" fill="${c}"/>`; // led
      }
    };
    const t = `transform="translate(${f.cx} ${f.ey.toFixed(1)})"`;
    if (kind === 'lens') return `<g ${t}><circle r="8.5" fill="none" stroke="${c}" stroke-width="2.4"/><circle r="4" fill="${c}"/></g>`;
    if (kind === 'visor') {
      const w = f.ex * 2 + 12;
      return `<g ${t}><rect x="${-w / 2}" y="-3.25" width="${w}" height="6.5" rx="3.25" fill="${c}" opacity="0.35"/><rect class="ba-scan" x="${-w / 2}" y="-3.25" width="${Math.round(w * 0.38)}" height="6.5" rx="3.25" fill="${c}"/></g>`;
    }
    return one(f.l) + one(f.r);
  }

  function mouthSvg(kind, f, c) {
    const x = f.cx; const y = f.my.toFixed(1);
    const t = `transform="translate(${x} ${y})"`;
    if (kind === 'line') return `<path ${t} d="M-5 0H5" stroke="${c}" stroke-width="2.4" stroke-linecap="round"/>`;
    if (kind === 'curve') return `<path ${t} d="M-5.5 -1.5Q0 3.5 5.5 -1.5" fill="none" stroke="${c}" stroke-width="2.4" stroke-linecap="round"/>`;
    if (kind === 'wave') return `<path ${t} d="M-7.5 0Q-5.6 -2.6 -3.75 0T0 0T3.75 0T7.5 0" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round"/>`;
    if (kind === 'grille') return `<g ${t} fill="${c}">${[-6, -2, 2, 6].map((d) => `<rect x="${d - 1}" y="-2.5" width="2" height="5" rx="1"/>`).join('')}</g>`;
    return '';
  }

  function opticsSvg(kind, s, f, c, single) {
    const [x, y, w, h] = s.scr;
    if (kind === 'frames') {
      if (single) return `<rect x="${f.cx - f.ex - 9}" y="${(f.ey - 8).toFixed(1)}" width="${f.ex * 2 + 18}" height="16" rx="5" fill="none" stroke="${c}" stroke-width="1.8" opacity="0.7"/>`;
      return `<g fill="none" stroke="${c}" stroke-width="1.8" opacity="0.7"><rect x="${f.l - 8}" y="${(f.ey - 8).toFixed(1)}" width="16" height="16" rx="4.5"/><rect x="${f.r - 8}" y="${(f.ey - 8).toFixed(1)}" width="16" height="16" rx="4.5"/><path d="M${f.l + 8} ${f.ey.toFixed(1)}H${f.r - 8}"/></g>`;
    }
    if (kind === 'monocle') {
      const mx = single ? f.cx : f.r; const rad = single ? 12 : 8.5;
      return `<g fill="none" stroke="${c}" stroke-width="1.8" opacity="0.8"><circle cx="${mx}" cy="${f.ey.toFixed(1)}" r="${rad}"/><path d="M${mx + rad * 0.7} ${(f.ey + rad * 0.7).toFixed(1)}Q${mx + rad + 2} ${(y + h - 3).toFixed(1)} ${x + w - 4} ${y + h - 2}"/></g>`;
    }
    if (kind === 'shades') {
      const top = f.ey - 7.5;
      return `<g><rect x="${x + 4}" y="${top.toFixed(1)}" width="${w - 8}" height="13" rx="6.5" fill="#000" opacity="0.62"/><path d="M${x + 10} ${(top + 3).toFixed(1)}H${x + 18}" stroke="${c}" stroke-width="1.6" stroke-linecap="round" opacity="0.9"/></g>`;
    }
    if (kind === 'hud') {
      const k = 5; const i = 3.5;
      const L = x + i; const R = x + w - i; const T = y + i; const B = y + h - i;
      return `<path d="M${L} ${T + k}V${T}H${L + k}M${R - k} ${T}H${R}V${T + k}M${R} ${B - k}V${B}H${R - k}M${L + k} ${B}H${L}V${B - k}" fill="none" stroke="${c}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" opacity="0.75"/>`;
    }
    return '';
  }

  // Extras: [drawn behind the body, drawn in front of it].
  function extraSvg(kind, s, f, dark, glow, fill) {
    const cx = 60; const top = s.top;
    const ballY = top - 15;
    switch (kind) {
      case 'antenna':
        return [`<path d="M${cx} ${top + 6}V${ballY + 3}" stroke="${dark}" stroke-width="3.2" stroke-linecap="round"/>`,
          `<circle class="ba-led" cx="${cx}" cy="${ballY}" r="4.6" fill="${glow}" stroke="${dark}" stroke-width="2"/>`];
      case 'twin':
        return [`<path d="M${cx - 9} ${top + 8}L${cx - 16} ${top - 10}M${cx + 9} ${top + 8}L${cx + 16} ${top - 10}" stroke="${dark}" stroke-width="3" stroke-linecap="round"/>`,
          `<circle class="ba-led" cx="${cx - 16.5}" cy="${top - 11.5}" r="3.4" fill="${glow}" stroke="${dark}" stroke-width="1.8"/><circle class="ba-led" cx="${cx + 16.5}" cy="${top - 11.5}" r="3.4" fill="${glow}" stroke="${dark}" stroke-width="1.8"/>`];
      case 'halo':
        return ['', `<ellipse class="ba-halo" cx="${cx}" cy="${top - 9}" rx="19" ry="4.6" fill="none" stroke="#ffcc4d" stroke-width="3"/>`];
      case 'headset': {
        const y = f.ey;
        const L = s.sl - 4; const R = s.sr + 4;
        return [`<path d="M${L + 3} ${y - 6}C${L + 2} ${top - 18} ${R - 2} ${top - 18} ${R - 3} ${y - 6}" fill="none" stroke="${dark}" stroke-width="3.6" stroke-linecap="round"/>`,
          `<rect x="${L - 3}" y="${(y - 9).toFixed(1)}" width="10" height="18" rx="4" fill="${dark}"/><rect x="${R - 7}" y="${(y - 9).toFixed(1)}" width="10" height="18" rx="4" fill="${dark}"/>` +
          `<path d="M${L + 2} ${(y + 7).toFixed(1)}Q${L + 4} ${(f.my + 8).toFixed(1)} ${f.cx - 16} ${(f.my + 9).toFixed(1)}" fill="none" stroke="${dark}" stroke-width="2.4" stroke-linecap="round"/><circle cx="${f.cx - 15}" cy="${(f.my + 9).toFixed(1)}" r="2.8" fill="${dark}"/>`];
      }
      case 'propeller':
        return [`<path d="M${cx} ${top + 4}V${top - 8}" stroke="${dark}" stroke-width="3.2" stroke-linecap="round"/>`,
          `<g class="ba-prop" style="transform-origin:${cx}px ${top - 9}px"><ellipse cx="${cx - 9}" cy="${top - 9}" rx="9" ry="3" fill="${glow}" stroke="${dark}" stroke-width="1.6"/><ellipse cx="${cx + 9}" cy="${top - 9}" rx="9" ry="3" fill="${dark}"/></g><circle cx="${cx}" cy="${top - 9}" r="2.6" fill="${dark}"/>`];
      case 'fins': {
        const y = f.ey;
        const L = s.sl; const R = s.sr;
        return [`<path d="M${L + 6} ${(y - 10).toFixed(1)}L${L - 9} ${(y - 15).toFixed(1)}Q${L - 12} ${y.toFixed(1)} ${L - 9} ${(y + 15).toFixed(1)}L${L + 6} ${(y + 10).toFixed(1)}Z" fill="${dark}" stroke="${dark}" stroke-width="3" stroke-linejoin="round"/>` +
          `<path d="M${R - 6} ${(y - 10).toFixed(1)}L${R + 9} ${(y - 15).toFixed(1)}Q${R + 12} ${y.toFixed(1)} ${R + 9} ${(y + 15).toFixed(1)}L${R - 6} ${(y + 10).toFixed(1)}Z" fill="${dark}" stroke="${dark}" stroke-width="3" stroke-linejoin="round"/>`, ''];
      }
      case 'badge': {
        const x = s.bx; const y = s.by;
        return ['', `<g transform="translate(${x} ${y})"><rect x="-9" y="-6" width="18" height="12" rx="4" fill="${dark}"/><path d="M-3.5 -2.5L-6 0L-3.5 2.5M3.5 -2.5L6 0L3.5 2.5M1 -3L-1 3" fill="none" stroke="${mix(fill, '#ffffff', 0.8)}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></g>`];
      }
      default: return ['', ''];
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
    const f = face(s);
    const fill = colorHex(a.color);
    counter++;
    const flat = opts.flat || size < 30;
    const dark = mix(fill, '#14151b', 0.42);
    const screen = mix(fill, '#0c0d12', 0.86);
    const glow = mix(fill, '#ffffff', 0.74);
    const delay = (counter * 0.77) % 5;
    const state = opts.state === 'working' ? ' ba-working' : opts.state === 'done' ? ' ba-done' : '';
    const single = !!SINGLE[a.eyes];
    const [sx, sy, sw, sh, sr] = s.scr;
    const extra = extraSvg(a.accessory, s, f, dark, glow, fill);
    const body = s.j
      ? `<path d="${s.d}" fill="${fill}" stroke="${fill}" stroke-width="${s.j}" stroke-linejoin="round"/>`
      : `<path d="${s.d}" fill="${fill}"/>`;
    // A thin lighter rim along the top of the screen: the only "shine".
    const glare = flat ? '' : `<path d="M${sx + sr} ${sy + 3}H${sx + sw - sr}" stroke="#ffffff" stroke-opacity="0.09" stroke-width="2" stroke-linecap="round"/>`;
    const cheeks = a.cheeks
      ? `<g fill="#ff8fb4" opacity="0.8"><rect x="${f.l - (single ? 10 : 9)}" y="${(f.my - 2).toFixed(1)}" width="7" height="3.4" rx="1.7"/><rect x="${f.r + (single ? 3 : 2)}" y="${(f.my - 2).toFixed(1)}" width="7" height="3.4" rx="1.7"/></g>` : '';
    const title = opts.title ? `<title>${String(opts.title).replace(/[<&>"]/g, (c) => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;', '"': '&quot;' })[c])}</title>` : '';
    let vb = '0 0 120 120';
    if (opts.zoom === 'face') {
      const z = Math.max(sw, sh) + 14;
      vb = `${(sx + sw / 2 - z / 2).toFixed(1)} ${(sy + sh / 2 - z / 2).toFixed(1)} ${z} ${z}`;
    }
    return `<svg class="ba${state}${opts.still ? ' ba-still' : ''}" xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="${size}" height="${size}" role="img" aria-label="${a.shape} avatar" style="--ba-d:-${delay.toFixed(2)}s">${title}` +
      `<ellipse class="ba-shadow" cx="60" cy="${Math.min(115, s.bot + 6)}" rx="24" ry="3.2" fill="#000" opacity="0.13"/>` +
      `<g class="ba-float">` +
      extra[0] + (s.back ? s.back(dark) : '') + body + (s.front ? s.front(dark) : '') +
      `<rect x="${sx}" y="${sy}" width="${sw}" height="${sh}" rx="${sr}" fill="${screen}"/>` + glare +
      cheeks +
      `<g class="ba-look"><g class="ba-eyes ba-eyes-main">${eyesSvg(a.eyes, f, glow)}</g><g class="ba-eyes ba-eyes-happy">${eyesSvg('arcs', f, glow)}</g></g>` +
      mouthSvg(a.mouth, f, glow) + opticsSvg(a.glasses, s, f, glow, single) + extra[1] +
      `</g></svg>`;
  }

  const AVATAR_CSS = `
.ba { display: block; overflow: visible; flex-shrink: 0; }
.ba .ba-float { animation: ba-float 4.8s ease-in-out infinite; animation-delay: var(--ba-d, 0s); }
.ba .ba-shadow { transform-box: fill-box; transform-origin: 50% 50%; animation: ba-shadow 4.8s ease-in-out infinite; animation-delay: var(--ba-d, 0s); }
.ba .ba-eyes-main { transform-box: fill-box; transform-origin: 50% 50%; animation: ba-blink 5.6s infinite; animation-delay: var(--ba-d, 0s); }
.ba .ba-eyes-happy { display: none; }
.ba.ba-done .ba-eyes-main { display: none; }
.ba.ba-done .ba-eyes-happy { display: inline; }
.ba.ba-done .ba-float { animation: ba-hop 0.6s ease-out 1, ba-float 4.8s ease-in-out 0.6s infinite; }
.ba.ba-working .ba-look { animation: ba-look 1.4s ease-in-out infinite; }
.ba.ba-working .ba-float { animation-duration: 2.4s; }
.ba.ba-working .ba-led { animation: ba-led 0.9s ease-in-out infinite; }
.ba.ba-working .ba-prop { animation: ba-spin 0.5s linear infinite; }
.ba .ba-scan { transform-box: fill-box; animation: ba-scan 3.2s ease-in-out infinite; }
.ba.ba-working .ba-scan { animation-duration: 1.1s; }
.ba.ba-still *, .ba.ba-still { animation: none !important; }
@keyframes ba-float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-2.5px); } }
@keyframes ba-shadow { 0%, 100% { transform: scaleX(1); opacity: 0.13; } 50% { transform: scaleX(0.9); opacity: 0.09; } }
@keyframes ba-blink { 0%, 92%, 100% { transform: scaleY(1); } 95% { transform: scaleY(0.1); } }
@keyframes ba-look { 0%, 100% { transform: translateX(-3px); } 50% { transform: translateX(3px); } }
@keyframes ba-led { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
@keyframes ba-spin { 0% { transform: scaleX(1); } 50% { transform: scaleX(-1); } 100% { transform: scaleX(1); } }
@keyframes ba-scan { 0%, 100% { transform: translateX(0); } 50% { transform: translateX(163%); } }
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
