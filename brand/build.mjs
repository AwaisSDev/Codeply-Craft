// Builds the Codeply profile logo and X header banner from the Wisp shape system:
// one hexagon, two white pill eyes, no mouth. Specialists get one colour and one accessory.
// Run: node brand/build.mjs  -> writes SVGs, then renders PNGs with Playwright.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const OUT = dirname(fileURLToPath(import.meta.url));
const N = 120, TAU = Math.PI * 2, D = Math.PI / 180;
const BLUE = '#2F6BFF', NAVY = '#0B1628';

// ---- the hexagon, same construction as the Wisp Shape System page ----
const HEX = { n: 6, normal: 90, smooth: 7, puff: .012, R: 45, cy: 52, ey: 50 };
function baseR(sh) {
  const seg = TAU / sh.n, nrm = sh.normal * D, r = [];
  for (let i = 0; i < N; i++) { const t = TAU * i / N; const ph = (((t - nrm + seg / 2) % seg) + seg) % seg - seg / 2; r.push(Math.cos(Math.PI / sh.n) / Math.cos(ph)); }
  const h = sh.smooth >> 1;
  const s = r.map((_, i) => { let a = 0; for (let k = -h; k <= h; k++) a += r[(i + k + N) % N]; return a / (2 * h + 1); });
  const m = Math.max(...s); return s.map(v => v / m);
}
function bodyPath(sh) {
  const nrm = sh.normal * D;
  const r = baseR(sh).map((v, i) => v * (1 + sh.puff * Math.cos(sh.n * (TAU * i / N - nrm))));
  const p = r.map((v, i) => { const t = TAU * i / N; return [50 + Math.cos(t) * sh.R * v, sh.cy + Math.sin(t) * sh.R * v]; });
  let d = `M${p[0][0].toFixed(2)} ${p[0][1].toFixed(2)}`;
  for (let i = 0; i < N; i++) {
    const a = p[(i - 1 + N) % N], b = p[i], c = p[(i + 1) % N], e = p[(i + 2) % N];
    d += `C${(b[0] + (c[0] - a[0]) / 6).toFixed(2)} ${(b[1] + (c[1] - a[1]) / 6).toFixed(2)} ${(c[0] - (e[0] - b[0]) / 6).toFixed(2)} ${(c[1] - (e[1] - b[1]) / 6).toFixed(2)} ${c[0].toFixed(2)} ${c[1].toFixed(2)}`;
  }
  return d + 'Z';
}
const BODY = bodyPath(HEX);

function mix(a, b, k) {
  const p = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const A = p(a), B = p(b);
  return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * k).toString(16).padStart(2, '0')).join('');
}

// ---- accessories (navy, drawn around eyes at y 50) ----
const ACC = {
  glasses: { over: `<g fill="none" stroke="${NAVY}" stroke-width="3" stroke-linecap="round"><circle cx="40" cy="50" r="10"/><circle cx="60" cy="50" r="10"/><path d="M50 49.5h0M30 47L19 44M70 47L81 44"/></g><path d="M34 44a8 8 0 0 1 5-3" stroke="#fff" stroke-opacity=".5" stroke-width="1.6" fill="none" stroke-linecap="round"/>` },
  headphones: { over: `<path d="M15 58C13 18 87 18 85 58" fill="none" stroke="${NAVY}" stroke-width="4.5" stroke-linecap="round"/><rect x="7" y="47" width="13" height="23" rx="6.5" fill="${NAVY}"/><rect x="80" y="47" width="13" height="23" rx="6.5" fill="${NAVY}"/><path d="M10 52v8M83 52v8" stroke="#fff" stroke-opacity=".28" stroke-width="2" stroke-linecap="round"/>` },
  hardhat: { over: `<path d="M27 33C27 13 73 13 73 33Z" fill="${NAVY}"/><rect x="19" y="30" width="62" height="8" rx="4" fill="${NAVY}"/><path d="M50 15V30" stroke="#fff" stroke-opacity=".25" stroke-width="3"/><path d="M35 28C36 24 39 21 43 20" stroke="#fff" stroke-opacity=".3" stroke-width="2" fill="none" stroke-linecap="round"/>` },
  visor: { under: `<rect x="16" y="38" width="68" height="24" rx="12" fill="${NAVY}"/><path d="M24 43h20" stroke="#fff" stroke-opacity=".22" stroke-width="2.4" stroke-linecap="round"/>` },
  lens: { over: `<circle cx="60" cy="50" r="13" fill="#fff" fill-opacity=".16" stroke="${NAVY}" stroke-width="3.5"/><path d="M69.5 59.5L81 72" stroke="${NAVY}" stroke-width="6.5" stroke-linecap="round"/><path d="M53 44a8 8 0 0 1 6-3" stroke="#fff" stroke-opacity=".6" stroke-width="1.8" fill="none" stroke-linecap="round"/>`, bigR: 1.3 },
};

// ---- one Wisp, soft and shaded ----
let uid = 0;
function wisp({ x, y, size, rot = 0, color = BLUE, acc = null, look = [0, 0], eyes = 'pill', eyeColor = '#fff', shadow = true, white = false }) {
  const id = 'w' + (++uid), a = ACC[acc] || {}, s = size / 100, dy = HEX.ey - 50;
  const hi = white ? '#ffffff' : mix(color, '#ffffff', .42);
  const mid = white ? '#f3f5fa' : color;
  const lo = white ? '#c9d1e2' : mix(color, '#000000', .22);
  const [ex, ey] = look;
  const eyeSvg = [40, 60].map((cx0, i) => {
    const cx = cx0 + ex, cy = HEX.ey + ey, k = i === 1 ? (a.bigR || 1) : 1;
    if (eyes === 'happy') return `<path d="M${cx - 5.5} ${cy + 3}Q${cx} ${cy - 8} ${cx + 5.5} ${cy + 3}" fill="none" stroke="${eyeColor}" stroke-width="5" stroke-linecap="round"/>`;
    const W = 8 * k, H = (eyes === 'focus' ? 10 : 16) * k;
    return `<rect x="${(cx - W / 2).toFixed(2)}" y="${(cy - H / 2).toFixed(2)}" width="${W}" height="${H}" rx="${W / 2}" fill="${eyeColor}"/>`;
  }).join('');
  return `<g transform="translate(${x - size / 2} ${y - size / 2}) scale(${s}) rotate(${rot} 50 ${HEX.cy})">
  <defs>
    <radialGradient id="${id}b" cx=".34" cy=".26" r=".9"><stop offset="0" stop-color="${hi}"/><stop offset=".5" stop-color="${mid}"/><stop offset="1" stop-color="${lo}"/></radialGradient>
    <radialGradient id="${id}h" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#fff" stop-opacity="${white ? .9 : .42}"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
    <clipPath id="${id}c"><path d="${BODY}"/></clipPath>
  </defs>
  ${shadow ? `<ellipse cx="50" cy="99" rx="34" ry="5" fill="${NAVY}" opacity=".16" filter="url(#soft)"/>` : ''}
  <path d="${BODY}" fill="url(#${id}b)"/>
  <g clip-path="url(#${id}c)">
    <path d="${BODY}" fill="none" stroke="${white ? '#ffffff' : mix(color, '#ffffff', .3)}" stroke-width="7" opacity=".55" filter="url(#inner)" transform="translate(0 -4)"/>
    <path d="${BODY}" fill="none" stroke="${mix(lo, '#000000', .3)}" stroke-width="8" opacity="${white ? .14 : .22}" filter="url(#inner)" transform="translate(-2 4)"/>
    <ellipse cx="36" cy="27" rx="24" ry="15" fill="url(#${id}h)"/>
  </g>
  <g transform="translate(0 ${dy})">${a.under || ''}</g>
  <g filter="url(#eyeglow)">${eyeSvg}</g>
  <g transform="translate(0 ${dy})">${a.over || ''}</g>
</g>`;
}
const FILTERS = `<filter id="soft" x="-50%" y="-200%" width="200%" height="500%"><feGaussianBlur stdDeviation="2.4"/></filter>
<filter id="inner" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="3.2"/></filter>
<filter id="eyeglow" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="0" dy=".6" stdDeviation=".8" flood-color="#0B1628" flood-opacity=".22"/></filter>
<filter id="lift" x="-30%" y="-30%" width="160%" height="170%"><feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="#0B1628" flood-opacity=".16"/></filter>`;

// ---- logo: blue Wisp on a soft light tile ----
function logo({ dark = false } = {}) {
  uid = 0;
  const bg = dark
    ? `<radialGradient id="bg" cx=".5" cy=".42" r=".75"><stop offset="0" stop-color="#18264a"/><stop offset="1" stop-color="#070B16"/></radialGradient>`
    : `<radialGradient id="bg" cx=".5" cy=".38" r=".8"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#E4EAF7"/></radialGradient>`;
  const glow = dark ? `<circle cx="200" cy="215" r="150" fill="${BLUE}" opacity=".28" filter="url(#halo)"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="400" height="400"><defs>${FILTERS}${bg}<filter id="halo" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="40"/></filter></defs>
<rect width="400" height="400" fill="url(#bg)"/>${glow}
<g filter="url(#lift)">${wisp({ x: 200, y: 205, size: 335, look: [2.6, -2.4], shadow: false })}</g>
</svg>`;
}

// ---- banner: the team in a happy heap, 1500 x 500 ----
function bubble(x, y, text, w, tail = 'left', rot = 0) {
  const h = 46, tx = tail === 'left' ? 22 : w - 22, dir = tail === 'left' ? -1 : 1;
  return `<g transform="translate(${x} ${y}) rotate(${rot})" filter="url(#bubble)">
  <rect x="0" y="0" width="${w}" height="${h}" rx="23" fill="url(#bub)"/>
  <path d="M${tx - 9} ${h - 4}L${tx + dir * 6} ${h + 13}L${tx + 9} ${h - 4}Z" fill="#3a74ff"/>
  <text x="${w / 2}" y="30.5" text-anchor="middle" font-family="Inter, sans-serif" font-weight="600" font-size="19" fill="#fff" letter-spacing="-.2">${text}</text>
</g>`;
}
function banner() {
  uid = 0;
  const team = [
    // back row
    { x: 890, y: 165, size: 205, rot: -10, color: '#E5484D', acc: 'lens', look: [-2, 2] },
    { x: 1235, y: 150, size: 195, rot: 9, color: '#FF7A1A', acc: 'visor', look: [-3, 1] },
    // front row, running off the bottom edge
    { x: 615, y: 420, size: 255, rot: -8, color: '#12A97E', acc: 'hardhat', look: [3, -2], shadow: false },
    { x: 1310, y: 420, size: 265, rot: 8, color: '#7A5CFF', acc: 'headphones', look: [-3, -2], shadow: false },
    { x: 835, y: 430, size: 265, rot: 5, color: '#FF4F8B', acc: 'glasses', look: [2, -2], eyes: 'happy', shadow: false },
    { x: 1068, y: 365, size: 340, rot: 0, color: BLUE, look: [-1.5, -3], shadow: false },
  ];
  const chars = team.map(t => wisp(t)).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1500 500" width="1500" height="500"><defs>${FILTERS}
<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#F4F7FD"/><stop offset="1" stop-color="#E2E8F5"/></linearGradient>
<radialGradient id="spot" cx=".68" cy=".55" r=".55"><stop offset="0" stop-color="#ffffff" stop-opacity=".95"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient>
<linearGradient id="bub" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5b8cff"/><stop offset="1" stop-color="#2a62f5"/></linearGradient>
<filter id="bubble" x="-20%" y="-40%" width="140%" height="200%"><feDropShadow dx="0" dy="6" stdDeviation="7" flood-color="#2F6BFF" flood-opacity=".28"/></filter>
<pattern id="dots" width="26" height="26" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.3" fill="#0B1628" opacity=".07"/></pattern>
</defs>
<rect width="1500" height="500" fill="url(#bg)"/>
<rect width="1500" height="500" fill="url(#dots)"/>
<rect width="1500" height="500" fill="url(#spot)"/>
${bubble(140, 64, 'hey, i’m wisp!', 176, 'right', -4)}
${bubble(350, 124, 'on it →', 116, 'right', 3)}
${bubble(210, 186, 'done ✓', 108, 'right', -2)}
${bubble(400, 232, 'your turn?', 140, 'right', -3)}
<g filter="url(#lift)">
${chars}
</g>
</svg>`;
}

const files = { 'codeply-logo.svg': logo(), 'codeply-logo-dark.svg': logo({ dark: true }), 'codeply-banner.svg': banner() };
for (const [name, svg] of Object.entries(files)) writeFileSync(join(OUT, name), svg);

// ---- render PNGs ----
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch();
const shots = [['codeply-logo', 400, 400], ['codeply-logo-dark', 400, 400], ['codeply-banner', 1500, 500]];
for (const [name, w, h] of shots) {
  for (const scale of [1, 2]) {
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: scale });
    await page.setContent(`<html><body style="margin:0">${files[name + '.svg']}</body></html>`);
    await page.screenshot({ path: join(OUT, `${name}${scale === 2 ? '@2x' : ''}.png`), clip: { x: 0, y: 0, width: w, height: h } });
    await page.close();
  }
}
await browser.close();
console.log('wrote', Object.keys(files).join(', '), '+ PNGs');
