/**
 * Codeply icons: flat, bright, clean. Each shape is one smooth gradient in a vivid colour,
 * with a thin glassy light along its upper edge and a faint deeper edge at the bottom.
 * No 3D, no floor shadows. Every icon is a 100 x 100 SVG.
 *
 *   CodeplyIcons.svg(name, { size })  -> SVG markup
 *   CodeplyIcons.names                -> the icon names
 *
 * Works in the browser (window.CodeplyIcons) and in Node (module.exports).
 */
(function (root) {
  'use strict';

  // ---------- colour ----------
  function hexToHsl(hex) {
    const n = parseInt(hex.slice(1), 16);
    let r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0; const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h /= 6;
    }
    return [h, s, l];
  }
  function hsl(h, s, l) {
    h = ((h % 1) + 1) % 1; s = Math.max(0, Math.min(1, s)); l = Math.max(0, Math.min(1, l));
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    const f = (t) => { t = ((t % 1) + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
    const x = (v) => Math.round(v * 255).toString(16).padStart(2, '0');
    return `#${x(f(h + 1 / 3))}${x(f(h))}${x(f(h - 1 / 3))}`;
  }
  // A light top and a deeper bottom, both still vivid. Warm colours lift toward yellow, cool toward cyan.
  function ramp(hex, o = {}) {
    const [h, s, l] = hexToHsl(hex);
    const warm = h < 0.2 || h > 0.85;
    const toward = (t, k) => { let d = t - h; if (d > 0.5) d -= 1; if (d < -0.5) d += 1; return h + d * k; };
    return {
      top: hsl(toward(warm ? 0.14 : 0.52, o.shift ?? 0.08), Math.min(1, s * 1.02), l + (1 - l) * (o.lift ?? 0.28)),
      mid: hex,
      bottom: hsl(toward(warm ? 0.98 : 0.66, o.shift ?? 0.06), Math.min(1, s * 1.05 + 0.04), l * (o.drop ?? 0.82)),
      edge: hsl(toward(warm ? 0.98 : 0.66, 0.08), Math.min(1, s * 1.1), l * 0.62),
    };
  }

  // ---------- shapes ----------
  const rr = (x, y, w, h, r) => `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`;
  const circle = (cx, cy, r) => `M${cx - r} ${cy}A${r} ${r} 0 1 0 ${cx + r} ${cy}A${r} ${r} 0 1 0 ${cx - r} ${cy}Z`;
  function roundedPolygon(pts, r) {
    const n = pts.length; let d = '';
    for (let i = 0; i < n; i++) {
      const [x0, y0] = pts[(i - 1 + n) % n], [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % n];
      const a = Math.hypot(x0 - x1, y0 - y1), b = Math.hypot(x2 - x1, y2 - y1);
      const s1 = [x1 + (x0 - x1) / a * r, y1 + (y0 - y1) / a * r], s2 = [x1 + (x2 - x1) / b * r, y1 + (y2 - y1) / b * r];
      d += `${i ? 'L' : 'M'}${s1[0].toFixed(2)} ${s1[1].toFixed(2)}Q${x1.toFixed(2)} ${y1.toFixed(2)} ${s2[0].toFixed(2)} ${s2[1].toFixed(2)}`;
    }
    return d + 'Z';
  }

  // ---------- the glass recipe ----------
  let uid = 0;
  /** One filled shape: gradient body, soft sheen, thin light top edge, faint deep bottom edge. */
  function part(d, color, o = {}) {
    const id = `ci${++uid}`; const c = ramp(color, o);
    const angle = o.angle ?? [0.2, 0, 0.8, 1];
    return `
<defs>
  <linearGradient id="${id}f" x1="${angle[0]}" y1="${angle[1]}" x2="${angle[2]}" y2="${angle[3]}">
    <stop offset="0" stop-color="${c.top}"/><stop offset="0.5" stop-color="${c.mid}"/><stop offset="1" stop-color="${c.bottom}"/>
  </linearGradient>
  <radialGradient id="${id}s" cx="0.3" cy="0.12" r="0.75"><stop offset="0" stop-color="#fff" stop-opacity="${o.sheen ?? 0.32}"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
  <linearGradient id="${id}e" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="${o.glass ?? 0.85}"/><stop offset="0.42" stop-color="#fff" stop-opacity="0"/></linearGradient>
  <linearGradient id="${id}b" x1="0" y1="0" x2="0" y2="1"><stop offset="0.55" stop-color="${c.edge}" stop-opacity="0"/><stop offset="1" stop-color="${c.edge}" stop-opacity="${o.base ?? 0.35}"/></linearGradient>
  <clipPath id="${id}c"><path d="${d}"/></clipPath>
</defs>
<path d="${d}" fill="url(#${id}f)"/>
<path d="${d}" fill="url(#${id}s)"/>
<path d="${d}" fill="none" stroke="url(#${id}b)" stroke-width="${o.edgeW ?? 4}" clip-path="url(#${id}c)"/>
<path d="${d}" fill="none" stroke="url(#${id}e)" stroke-width="${o.edgeW ?? 3}" clip-path="url(#${id}c)"/>`;
  }
  /** A flat detail (eyes, text, marks): solid, no glass, so the icon stays clean. */
  const flat = (d, fill, extra = '') => `<path d="${d}" fill="${fill}" ${extra}/>`;
  const line = (d, stroke, w, extra = '') => `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" ${extra}/>`;

  // ---------- palette ----------
  const P = {
    blue: '#2f7bff', sky: '#4fb3ff', navy: '#1a2b8c', green: '#1fc75f', red: '#ff4a4a', orange: '#ff8a1a',
    amber: '#ffb21a', yellow: '#ffcf2e', cream: '#ffe08a', violet: '#7b5cff', pink: '#ff5c9d', mist: '#e9f0fb', ink: '#232a3b',
  };
  const cloudPath = (x, y, s) => {
    // A soft cloud built from arcs, s = scale (1 = about 60 wide).
    const p = (v) => (v * s).toFixed(2);
    return `M${x + +p(8)} ${y + +p(30)}A${p(12)} ${p(12)} 0 0 1 ${x + +p(10)} ${y + +p(7)}A${p(17)} ${p(17)} 0 0 1 ${x + +p(42)} ${y + +p(4)}A${p(13)} ${p(13)} 0 0 1 ${x + +p(52)} ${y + +p(30)}Z`;
  };

  // Wisp's body: the codeply.app hexagon (points left and right, flat top and bottom), Codeply blue.
  // o.color repaints it (agents on Wisp's team wear their own colour).
  const wispBody = (o = {}) => part(roundedPolygon([[30, 15], [70, 15], [91, 53], [70, 91], [30, 91], [9, 53]], 10), o.color || '#2f6bff', { lift: 0.14, drop: 0.92, sheen: 0.16 });

  // Accessories: one small, flat piece per helper, so each is recognisable at sidebar size.
  function gear(kind, body) {
    if (!kind) return '';
    const dark = '#1b2238';
    switch (kind) {
      case 'beret': return part('M28 18C30 6 70 4 74 16C66 22 36 24 28 18Z', '#ff3d6e', { glass: 0.5 }) + flat(circle(52, 7, 3.4), '#ff3d6e');
      case 'headphones': return line('M16 40C16 10 84 10 84 40', '#2a3047', 5) + part(rr(8, 36, 14, 24, 7), '#2a3047', { glass: 0.4 }) + part(rr(78, 36, 14, 24, 7), '#2a3047', { glass: 0.4 });
      case 'glasses': return line('M30 50A8 8 0 1 0 46 50A8 8 0 1 0 30 50M54 50A8 8 0 1 0 70 50A8 8 0 1 0 54 50M46 50H54', dark, 3);
      case 'sprout': return line('M50 16V4', '#1fa855', 3.6) + part('M50 8C42 2 32 4 30 10C38 14 46 12 50 8Z', '#22c55e', { glass: 0.4 }) + part('M50 6C56 -1 68 0 70 6C62 11 54 10 50 6Z', '#22c55e', { glass: 0.4 });
      case 'antennae': return line('M38 16L32 3M62 16L68 3', dark, 3) + flat(circle(31, 3, 4), '#ffcf2e') + flat(circle(69, 3, 4), '#ffcf2e');
      case 'cap': return part('M26 20C28 4 72 4 74 20Z', '#1b2238', { glass: 0.5 }) + part(rr(56, 15, 30, 7, 3.5), '#1b2238', { glass: 0.3 });
      default: return '';
    }
  }

  // Small interface icons in the same style: one bright shape, a thin glass edge, a white detail.
  const UI = {
    compose: () => part(rr(14, 14, 72, 72, 22), '#2f6bff', { lift: 0.25 }) + line('M50 34V66M34 50H66', '#fff', 8),
    inbox: () => part(rr(12, 18, 76, 64, 18), '#22c55e', { lift: 0.25 }) + line('M24 52H38L43 61H57L62 52H76', '#fff', 6.5),
    routine: () => part(circle(50, 50, 38), '#7b5cff', { lift: 0.3 }) + line('M50 30V51L63 59', '#fff', 7),
    search: () => line('M64 64L82 82', '#2a3047', 12) + part(circle(43, 43, 29), '#4fb3ff', { lift: 0.35 }) + flat(circle(43, 43, 15), '#ffffff', 'opacity="0.9"'),
    gear: () => {
      const teeth = Array.from({ length: 8 }, (_, i) => { const a = (i / 8) * Math.PI * 2; return [50 + Math.cos(a) * 34, 50 + Math.sin(a) * 34]; });
      return teeth.map(([x, y]) => part(circle(x, y, 9), '#8a94ad', { glass: 0.3 })).join('') + part(circle(50, 50, 30), '#8a94ad', { lift: 0.4 }) + flat(circle(50, 50, 11), '#ffffff');
    },
    folder: () => part('M12 30A10 10 0 0 1 22 20H40L48 28H78A10 10 0 0 1 88 38V72A10 10 0 0 1 78 82H22A10 10 0 0 1 12 72Z', '#ffb21a', { lift: 0.3 }) + part(rr(12, 36, 76, 46, 10), '#ffc93c', { lift: 0.35, glass: 0.7 }),
    attach: () => part(circle(50, 50, 38), '#e9eef8', { lift: 0.6, base: 0.3 }) + line('M50 34V66M34 50H66', '#2a3047', 7),
    screen: () => part(rr(10, 16, 80, 54, 12), '#2a3047', { lift: 0.35 }) + part(rr(17, 23, 66, 40, 6), '#4fb3ff', { lift: 0.4, glass: 0.5 }) + line('M38 82H62M50 72V82', '#2a3047', 6),
    sun: () => [0, 45, 90, 135, 180, 225, 270, 315].map((d) => { const r = d * Math.PI / 180; return line(`M${50 + Math.cos(r) * 30} ${50 + Math.sin(r) * 30}L${50 + Math.cos(r) * 40} ${50 + Math.sin(r) * 40}`, '#ffb21a', 6); }).join('') + part(circle(50, 50, 21), '#ffb21a', { lift: 0.35 }),
  };

  const ICONS = {
    // Wisp, as on codeply.app: a flat-topped rounded hexagon, white pill eyes set a little left of centre.
    // o.color repaints it; o.gear adds an accessory. The eyes sit in <g class="w-eyes"> so a page can animate them.
    wisp(o = {}) {
      return wispBody(o) + `<g class="w-eyes"><g class="w-eye">${flat(rr(34.5, 43, 7, 14, 3.5), '#fff')}</g><g class="w-eye">${flat(rr(52.5, 43, 7, 14, 3.5), '#fff')}</g></g>` + gear(o.gear, o.color || '#2f6bff');
    },
    // Wisp, happy: the same body with "^^" eyes.
    'wisp-happy'(o = {}) {
      return wispBody(o) + line('M33.2 53.2Q38 45.8 42.8 53.2', '#fff', 3.6) + line('M51.2 53.2Q56 45.8 60.8 53.2', '#fff', 3.6) + gear(o.gear, o.color || '#2f6bff');
    },
    mail() {
      return part(rr(12, 24, 76, 54, 12), P.amber)
        + line('M16 30 L50 54 L84 30', '#ffffff', 5, 'opacity="0.9"')
        + part(circle(50, 52, 8), P.red, { glass: 0.7 });
    },
    calendar() {
      return part(rr(14, 18, 72, 68, 16), '#eef2f9', { lift: 0.6, base: 0.25 })
        + part(`M14 34V30A16 16 0 0 1 30 18H70A16 16 0 0 1 86 30V40H14Z`, P.red)
        + flat(rr(32, 11, 6, 15, 3), '#7d869c') + flat(rr(62, 11, 6, 15, 3), '#7d869c')
        + `<text x="50" y="35" text-anchor="middle" font-family="system-ui,-apple-system,Segoe UI,sans-serif" font-weight="800" font-size="11" fill="#fff" letter-spacing="0.5">THU</text>`
        + `<text x="50" y="74" text-anchor="middle" font-family="system-ui,-apple-system,Segoe UI,sans-serif" font-weight="800" font-size="30" fill="${P.ink}">13</text>`;
    },
    task() {
      return part(circle(50, 50, 38), P.green, { lift: 0.32 }) + line('M33 51 L45 63 L68 38', '#fff', 9);
    },
    briefing() {
      const rays = [-150, -115, -80, -45, -10].map((a) => {
        const r = (a * Math.PI) / 180; const cx = 62, cy = 40;
        return line(`M${(cx + Math.cos(r) * 27).toFixed(1)} ${(cy + Math.sin(r) * 27).toFixed(1)} L${(cx + Math.cos(r) * 33).toFixed(1)} ${(cy + Math.sin(r) * 33).toFixed(1)}`, P.amber, 5);
      }).join('');
      return rays + part(circle(62, 40, 19), P.amber, { lift: 0.35 }) + part(cloudPath(12, 46, 1.15), P.mist, { lift: 0.85, drop: 0.9, base: 0.45 });
    },
    voice() {
      return line('M28 50 A22 22 0 0 0 72 50', '#a8b3c7', 6) + line('M50 72 V82', '#a8b3c7', 6) + line('M38 84 H62', '#a8b3c7', 6)
        + part(rr(36, 12, 28, 50, 14), P.blue, { lift: 0.38 })
        + line('M42 30 H58', '#ffffff', 3, 'opacity="0.5"') + line('M42 38 H58', '#ffffff', 3, 'opacity="0.5"');
    },
    privacy() {
      return line('M34 44 V34 A16 16 0 0 1 66 34 V44', '#b4bdcf', 9)
        + part(rr(20, 40, 60, 46, 14), P.amber, { lift: 0.32 })
        + flat(`${circle(50, 58, 6)}`, '#a35a00') + flat(rr(47.5, 60, 5, 13, 2.5), '#a35a00');
    },
    cloudrun() {
      return part(cloudPath(10, 30, 1.35), P.sky, { lift: 0.45 }) + line('M50 70 V44', '#fff', 8) + line('M39 54 L50 43 L61 54', '#fff', 8);
    },
    streak() {
      const outer = 'M50 10 C58 26 76 34 76 58 A26 26 0 0 1 24 58 C24 44 32 38 36 28 C40 36 44 40 46 40 C46 28 46 20 50 10 Z';
      const inner = 'M50 46 C55 54 63 58 63 68 A13 13 0 0 1 37 68 C37 60 44 56 50 46 Z';
      return part(outer, P.orange, { lift: 0.3 }) + part(inner, P.yellow, { lift: 0.5, glass: 0.6 });
    },
    draft() {
      return `<g transform="rotate(45 50 50)">`
        + part(rr(37, 2, 26, 20, 9), P.pink, { glass: 0.6 })
        + part('M37 18H63V68H37Z', P.yellow)
        + part('M37 68H63L50 96Z', '#ffd9a8', { lift: 0.4 })
        + flat('M45.5 86.5H54.5L50 96Z', P.ink)
        + `</g>`;
    },
    chat() {
      const d = 'M50 16C72 16 88 29 88 46S72 76 50 76C45 76 40 75.4 35.6 74.2L20 82L23.6 68.4C16 62.8 12 55 12 46C12 29 28 16 50 16Z';
      return part(d, P.violet, { lift: 0.38 }) + flat(circle(36, 46, 5), '#fff') + flat(circle(50, 46, 5), '#fff') + flat(circle(64, 46, 5), '#fff');
    },
    quiet() {
      const moon = 'M58 14A36 36 0 1 0 86 62A28 28 0 1 1 58 14Z';
      const star = 'M76 16L79 25L88 28L79 31L76 40L73 31L64 28L73 25Z';
      return part(moon, P.amber, { lift: 0.4, angle: [0.1, 0, 0.9, 1] }) + part(star, P.yellow, { glass: 0.6, edgeW: 2 });
    },
  };

  function svg(name, o = {}) {
    const build = ICONS[name] || UI[name];
    if (!build) throw new Error(`No Codeply icon called "${name}".`);
    const size = o.size || 100;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}" role="img" aria-label="${name}">${build(o)}</svg>`;
  }

  const api = { svg, names: Object.keys(ICONS), ui: Object.keys(UI), gears: ['beret', 'headphones', 'glasses', 'sprout', 'antennae', 'cap'], palette: P };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CodeplyIcons = api;
})(typeof window !== 'undefined' ? window : globalThis);
