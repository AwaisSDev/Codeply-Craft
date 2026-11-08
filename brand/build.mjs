// Builds the Codeply profile logo and X header banner. Flat and minimal: solid colours,
// no gradients, no shadows, no glow.
//   Logo: Wisp, the blue hexagon with two white pill eyes (Wisp Shape System).
//   Banner: Wisp with the built-in specialists as the app draws them (wisp.js shapes,
//   colours and gear), flattened.
// Run: node brand/build.mjs  -> writes SVGs, then renders PNGs with Playwright.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const OUT = dirname(fileURLToPath(import.meta.url));
const TAU = Math.PI * 2, D = Math.PI / 180;
const BLUE = '#2F6BFF', INK = '#0b0b0f';

// ---- smooth closed path through points ----
function pathFrom(pts) {
  const n = pts.length;
  let d = `M${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`;
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 1 + n) % n], b = pts[i], c = pts[(i + 1) % n], e = pts[(i + 2) % n];
    d += `C${(b[0] + (c[0] - a[0]) / 6).toFixed(2)} ${(b[1] + (c[1] - a[1]) / 6).toFixed(2)} ${(c[0] - (e[0] - b[0]) / 6).toFixed(2)} ${(c[1] - (e[1] - b[1]) / 6).toFixed(2)} ${c[0].toFixed(2)} ${c[1].toFixed(2)}`;
  }
  return d + 'Z';
}

// ---- Wisp: the hexagon from the Wisp Shape System (flat top and base) ----
const HEX = { n: 6, normal: 90, smooth: 7, puff: .012, R: 45, cy: 52, ey: 50 };
const WISP_PATH = (() => {
  const N = 120, seg = TAU / HEX.n, nrm = HEX.normal * D, r = [];
  for (let i = 0; i < N; i++) { const t = TAU * i / N; const ph = (((t - nrm + seg / 2) % seg) + seg) % seg - seg / 2; r.push(Math.cos(Math.PI / HEX.n) / Math.cos(ph)); }
  const h = HEX.smooth >> 1;
  let s = r.map((_, i) => { let a = 0; for (let k = -h; k <= h; k++) a += r[(i + k + N) % N]; return a / (2 * h + 1); });
  const m = Math.max(...s); s = s.map((v, i) => v / m * (1 + HEX.puff * Math.cos(HEX.n * (TAU * i / N - nrm))));
  return pathFrom(s.map((v, i) => { const t = TAU * i / N; return [50 + Math.cos(t) * HEX.R * v, HEX.cy + Math.sin(t) * HEX.R * v]; }));
})();
function wisp({ x, y, size, rot = 0, look = [0, 0], color = BLUE, eyeColor = '#fff' }) {
  const eyes = [40, 60].map(ex => `<rect x="${ex - 4 + look[0]}" y="${HEX.ey - 8 + look[1]}" width="8" height="16" rx="4" fill="${eyeColor}"/>`).join('');
  return `<g transform="translate(${x - size / 2} ${y - size / 2}) scale(${size / 100}) rotate(${rot} 50 ${HEX.cy})"><path d="${WISP_PATH}" fill="${color}"/>${eyes}</g>`;
}

// ---- specialists: shapes and gear as wisp.js draws them, flattened ----
const N = 144, CX = 50, CY = 54, R = 40;
function smooth(r, w) { if (w < 2) return r; const h = Math.floor(w / 2); return r.map((_, i) => { let s = 0; for (let k = -h; k <= h; k++) s += r[(i + k + N) % N]; return s / (2 * h + 1); }); }
function norm(r) { const m = Math.max(...r); return r.map(v => v / m); }
function polar(fn, w) { const r = []; for (let i = 0; i < N; i++) r.push(fn(-Math.PI / 2 + TAU * i / N)); return norm(smooth(r, w)); }
function poly(n, turn = 0) { return t => { const seg = TAU / n, phi = ((t + Math.PI / 2 - turn) % seg + seg) % seg - seg / 2; return Math.cos(Math.PI / n) / Math.cos(phi); }; }
const SHAPES = {
  circle: polar(() => 1, 1),
  square: polar(poly(4, Math.PI / 4), 27),
  triangle: polar(poly(3), 33),
  hexagon: polar(poly(6, Math.PI / 6), 7),
  star: polar(t => .8 + .2 * Math.cos(5 * (t + Math.PI / 2)), 11),
  spiky: polar(t => { const c = Math.cos(8 * (t + Math.PI / 2)); return .84 + .16 * Math.sign(c) * Math.pow(Math.abs(c), .6); }, 7),
  blob: polar(t => 1 + .07 * Math.sin(3 * t + 1) + .05 * Math.cos(5 * t - .4), 5),
  cloud: polar(t => .9 + .1 * Math.abs(Math.cos(3.5 * (t + Math.PI / 2))), 5),
};
function shapePts(name) { return SHAPES[name].map((v, i) => { const t = -Math.PI / 2 + TAU * i / N; return [CX + Math.cos(t) * R * v, CY + Math.sin(t) * R * v]; }); }
// Head gear is drawn for a head whose top is at y=14; it moves to the shape's real top.
const HEAD_GEAR = {
  beret: '<ellipse cx="46" cy="15" rx="21" ry="7.5" fill="#b8324a" transform="rotate(-12 46 15)"/><circle cx="46" cy="7.2" r="2.4" fill="#8f2236"/>',
  cap: '<path d="M29 21C30 8 70 8 71 21Z" fill="#2f5bd8"/><path d="M66 19.5C76 17.5 84 19 86 23C78 24.6 70 24 63 22Z" fill="#2348b5"/><circle cx="50" cy="9.6" r="1.8" fill="#2348b5"/>',
  bow: '<path d="M63 14L52 7.5L53.5 21.5Z M63 14L74 7.5L72.5 21.5Z" fill="#ff5fa8"/><circle cx="63" cy="14" r="3.2" fill="#e23d8a"/>',
  sprout: '<path d="M50 16C50 10 51 6 52 3" fill="none" stroke="#3d9e3f" stroke-width="2" stroke-linecap="round"/><path d="M52 5C56 -1 63 0 64 2C60 6 55 7 52 5Z" fill="#5cc45a"/><path d="M51 7C47 2 41 3 40 5C43 9 48 9 51 7Z" fill="#4db34b"/>',
  antennae: '<path d="M43 17C41 10 37 6 33 4 M57 17C59 10 63 6 67 4" fill="none" stroke="#5d4aa8" stroke-width="1.9" stroke-linecap="round"/><circle cx="33" cy="4" r="3.6" fill="#fff"/><circle cx="67" cy="4" r="3.6" fill="#fff"/><circle cx="33.6" cy="4.4" r="1.7" fill="#0b0b0f"/><circle cx="67.6" cy="4.4" r="1.7" fill="#0b0b0f"/>',
};
const FACE_GEAR = {
  glasses: '<g fill="none" stroke="#16161c" stroke-width="1.6"><circle cx="41.6" cy="44" r="6.8"/><circle cx="56.4" cy="44" r="6.8"/></g><path d="M48.4 43.2Q49 42.4 49.6 43.2" fill="none" stroke="#16161c" stroke-width="1.5"/><path d="M34.8 43.4L31.5 42.2M63.2 43.4L66.5 42.2" stroke="#16161c" stroke-width="1.5" stroke-linecap="round"/>',
  shades: '<circle cx="41.8" cy="44.4" r="6.3" fill="#111116"/><circle cx="56.2" cy="44.4" r="6.3" fill="#111116"/><path d="M48 43.2Q49 42.2 50 43.2" fill="none" stroke="#111116" stroke-width="1.5"/>',
};
const happyEye = x => `<path d="M${x - 4.2} 45.8Q${x} 39.4 ${x + 4.2} 45.8" fill="none" stroke="${INK}" stroke-width="2.3" stroke-linecap="round"/>`;
function specialist({ x, y, size, rot = 0, shape, color, gear }) {
  const pts = shapePts(shape);
  const top = Math.min(...pts.filter(p => Math.abs(p[0] - 50) < 8).map(p => p[1]));
  const head = HEAD_GEAR[gear] ? `<g transform="translate(0 ${(top - 14).toFixed(2)})">${HEAD_GEAR[gear]}</g>` : '';
  const face = gear === 'shades' ? '' : happyEye(43) + happyEye(55);
  // the shape's own 100 box is centred on (50, 54); centre it on (x, y)
  return `<g transform="translate(${x - size / 2} ${y - size * .54}) scale(${size / 100}) rotate(${rot} 50 54)"><path d="${pathFrom(pts)}" fill="${color}"/>${face}${FACE_GEAR[gear] || ''}${head}</g>`;
}

// ---- logo: Wisp, big and flat ----
function logo({ dark = false } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="400" height="400">
<rect width="400" height="400" fill="${dark ? '#000000' : '#FFFFFF'}"/>
${wisp({ x: 150, y: 192, size: 400, look: [3.5, -1.5] })}
</svg>`;
}

// ---- banner: the team in a flat heap, 1500 x 500 ----
function banner() {
  const back = [
    { x: 730, y: 200, size: 270, rot: -8, shape: 'cloud', color: '#E2B33A', gear: 'bow' },              // Docs
    { x: 965, y: 175, size: 265, rot: 10, shape: 'star', color: '#4CB977', gear: 'sprout' },           // Testing
    { x: 1200, y: 165, size: 285, rot: -6, shape: 'spiky', color: '#EC6A66', gear: 'shades' },         // Security
    { x: 1425, y: 200, size: 270, rot: 12, shape: 'triangle', color: '#8E70E6', gear: 'antennae' },    // DevOps
  ];
  const front = [
    { x: 600, y: 405, size: 275, rot: 7, shape: 'square', color: '#F39A62', gear: 'cap' },             // Backend
    { x: 825, y: 420, size: 285, rot: -5, shape: 'circle', color: '#EE6FA6', gear: 'beret' },          // Frontend
    { x: 1325, y: 415, size: 295, rot: 6, shape: 'hexagon', color: '#33B2A4', gear: 'glasses' },        // Database
  ];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1500 500" width="1500" height="500">
<rect width="1500" height="500" fill="#ECEEF2"/>
${back.map(specialist).join('\n')}
${front.map(specialist).join('\n')}
${wisp({ x: 1072, y: 378, size: 355, rot: -4, look: [-1.5, -2.5] })}
</svg>`;
}

const files = { 'codeply-logo.svg': logo(), 'codeply-logo-dark.svg': logo({ dark: true }), 'codeply-banner.svg': banner() };
for (const [name, svg] of Object.entries(files)) writeFileSync(join(OUT, name), svg);

const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch();
for (const [name, w, h] of [['codeply-logo', 400, 400], ['codeply-logo-dark', 400, 400], ['codeply-banner', 1500, 500]]) {
  for (const scale of [1, 2]) {
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: scale });
    await page.setContent(`<html><body style="margin:0">${files[name + '.svg']}</body></html>`);
    await page.screenshot({ path: join(OUT, `${name}${scale === 2 ? '@2x' : ''}.png`), clip: { x: 0, y: 0, width: w, height: h } });
    await page.close();
  }
}
await browser.close();
console.log('wrote', Object.keys(files).join(', '), '+ PNGs');
