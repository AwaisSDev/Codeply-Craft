// Every Codeply icon, drawn from the Wisp shape (wisp-shape.mjs). Flat: one blue, white eyes.
//   wisp      blue Wisp on transparent (favicons, small sizes)
//   tile      the profile logo: white square, blue Wisp running off the left edge (app icons)
//   glyph     white silhouette with the eyes cut out (status-bar badge, masked glyphs)
//   mark      the same silhouette on the 4295 frame the old knot used, for <symbol id="knot">
// Run: node brand/icons.mjs  -> brand/icons/*
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { BLUE, bodyPath, eyesPath } from './wisp-shape.mjs';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'icons');
mkdirSync(OUT, { recursive: true });

// ---- the drawings ----
const svg = (vb, body, bg = '') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}">${bg}${body}</svg>`;
const WISP = svg('4 6 92 92', `<path fill="${BLUE}" d="${bodyPath()}"/><path fill="#FFFFFF" d="${eyesPath()}"/>`);
const WISP_MICRO = svg('4 6 92 92', `<path fill="${BLUE}" d="${bodyPath()}"/><path fill="#FFFFFF" d="${eyesPath({ micro: true })}"/>`);
const GLYPH = svg('4 6 92 92', `<path fill="#FFFFFF" fill-rule="evenodd" d="${bodyPath()}${eyesPath()}"/>`);
const tileBody = `<path fill="${BLUE}" d="${bodyPath({ X: 150, Y: 200, s: 4 })}"/><path fill="#FFFFFF" d="${eyesPath({ X: 150, Y: 200, s: 4, look: [3.5, -1.5] })}"/>`;
const TILE = svg('0 0 400 400', tileBody, '<rect width="400" height="400" fill="#FFFFFF"/>');
// Rounded like an app icon: the corners are see-through.
const TILE_ROUND = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><defs><clipPath id="c"><rect width="400" height="400" rx="90"/></clipPath></defs><g clip-path="url(#c)"><rect width="400" height="400" fill="#FFFFFF"/>${tileBody}</g></svg>`;

// The mark replaces the knot path inside <symbol id="knot" viewBox="0 0 4295 4295">, centred where
// the knot sat so every viewBox that crops to it (560 560 3170 3170, 560 540 3200 3200) still fits.
const M = { X: 2157, Y: 2160, s: 3000 / 90 };
const MARK_D = bodyPath(M) + eyesPath(M);
const MARK_PATH = `<path transform="translate(0 0)" fill-rule="evenodd" d="${MARK_D}"/>`;
// White eyes to lay under the mark when it is drawn in colour (the eyes are holes in the mark).
const MARK_EYES_D = eyesPath(M);
const MARK = svg('0 0 4295 4295', `<path fill="${BLUE}" fill-rule="evenodd" d="${MARK_D}"/>`);

const files = {
  'wisp.svg': WISP, 'wisp-micro.svg': WISP_MICRO, 'glyph.svg': GLYPH, 'tile.svg': TILE, 'tile-round.svg': TILE_ROUND, 'mark.svg': MARK,
  'mark-path.txt': MARK_PATH, 'mark-eyes-d.txt': MARK_EYES_D,
};
for (const [n, s] of Object.entries(files)) writeFileSync(join(OUT, n), s);

// ---- PNGs ----
const PNGS = [
  ['wisp', WISP, [32, 48, 64, 128, 256]],
  ['wisp', WISP_MICRO, [16, 24]],
  ['glyph', GLYPH, [96, 388]],
  ['tile', TILE, [180, 192, 512, 1024]],
  ['tile-round', TILE_ROUND, [16, 24, 32, 48, 64, 128, 256, 512, 1024]],
];
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch();
const page = await browser.newPage();
const png = {};
for (const [name, s, sizes] of PNGS) {
  for (const px of sizes) {
    await page.setViewportSize({ width: px, height: px });
    await page.setContent(`<html><body style="margin:0;background:transparent">${s.replace('<svg ', `<svg width="${px}" height="${px}" style="display:block" `)}</body></html>`);
    const buf = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: px, height: px } });
    png[`${name}-${px}`] = buf;
    writeFileSync(join(OUT, `${name}-${px}.png`), buf);
  }
}
await browser.close();

// ---- ICO: PNG images packed in one file ----
function ico(bufs) {
  const head = Buffer.alloc(6 + 16 * bufs.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(bufs.length, 4);
  let off = head.length;
  bufs.forEach(([px, b], i) => {
    const o = 6 + 16 * i;
    head.writeUInt8(px >= 256 ? 0 : px, o); head.writeUInt8(px >= 256 ? 0 : px, o + 1);
    head.writeUInt16LE(1, o + 4); head.writeUInt16LE(32, o + 6);
    head.writeUInt32LE(b.length, o + 8); head.writeUInt32LE(off, o + 12);
    off += b.length;
  });
  return Buffer.concat([head, ...bufs.map(([, b]) => b)]);
}
// Site favicon: the Wisp alone reads best at tab size.
writeFileSync(join(OUT, 'favicon.ico'), ico([16, 32, 48].map((px) => [px, png[`wisp-${px}`]])));
// App icon: the Wisp alone where it's tiny, the rounded tile from 48 px up.
writeFileSync(join(OUT, 'app.ico'), ico([[16, png['wisp-16']], [24, png['wisp-24']], [32, png['wisp-32']], ...[48, 64, 128, 256].map((px) => [px, png[`tile-round-${px}`]])]));
console.log('wrote', Object.keys(png).length, 'PNGs, 2 ICOs and the SVGs to', OUT);
