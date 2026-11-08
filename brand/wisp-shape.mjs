// The Wisp shape, from the Wisp Shape System: one soft hexagon (flat top and base) and
// two pill eyes. Every logo, icon and banner in brand/ is drawn from these numbers.
const TAU = Math.PI * 2, D = Math.PI / 180;
export const BLUE = '#2F6BFF';
export const HEX = { n: 6, normal: 90, smooth: 7, puff: .012, R: 45, cy: 52, ey: 50 };
// Eyes on the 100 box: 8 x 16 pills centred at x 40 and 60, y 50.
export const EYES = [[40, 50], [60, 50]];
export const EYE_W = 8, EYE_H = 16;

/** Points of the hexagon outline on the 100 x 100 box. */
export function hexPoints(N = 120) {
  const seg = TAU / HEX.n, nrm = HEX.normal * D, r = [];
  for (let i = 0; i < N; i++) { const t = TAU * i / N; const ph = (((t - nrm + seg / 2) % seg) + seg) % seg - seg / 2; r.push(Math.cos(Math.PI / HEX.n) / Math.cos(ph)); }
  const h = HEX.smooth >> 1;
  let s = r.map((_, i) => { let a = 0; for (let k = -h; k <= h; k++) a += r[(i + k + N) % N]; return a / (2 * h + 1); });
  const m = Math.max(...s);
  s = s.map((v, i) => v / m * (1 + HEX.puff * Math.cos(HEX.n * (TAU * i / N - nrm))));
  return s.map((v, i) => { const t = TAU * i / N; return [50 + Math.cos(t) * HEX.R * v, HEX.cy + Math.sin(t) * HEX.R * v]; });
}

const f = (v) => +v.toFixed(2);
/** A smooth closed path through points, after mapping each point with map(). */
export function pathFrom(pts, map = (p) => p) {
  const q = pts.map(map), n = q.length;
  let d = `M${f(q[0][0])} ${f(q[0][1])}`;
  for (let i = 0; i < n; i++) {
    const a = q[(i - 1 + n) % n], b = q[i], c = q[(i + 1) % n], e = q[(i + 2) % n];
    d += `C${f(b[0] + (c[0] - a[0]) / 6)} ${f(b[1] + (c[1] - a[1]) / 6)} ${f(c[0] - (e[0] - b[0]) / 6)} ${f(c[1] - (e[1] - b[1]) / 6)} ${f(c[0])} ${f(c[1])}`;
  }
  return d + 'Z';
}

/** A pill (rounded rect, fully round ends) as a path. */
export function pillPath(cx, cy, w, h) {
  const r = w / 2, x0 = cx - r, x1 = cx + r, y0 = cy - h / 2 + r, y1 = cy + h / 2 - r;
  return `M${f(x0)} ${f(y0)}A${f(r)} ${f(r)} 0 0 1 ${f(x1)} ${f(y0)}V${f(y1)}A${f(r)} ${f(r)} 0 0 1 ${f(x0)} ${f(y1)}Z`;
}

/** The body path on a frame: the 100 box scaled by s and moved so (50, cy) lands on (X, Y). */
export function bodyPath({ X = 50, Y = HEX.cy, s = 1 } = {}) {
  return pathFrom(hexPoints(), ([x, y]) => [X + (x - 50) * s, Y + (y - HEX.cy) * s]);
}
// micro: below 24 px the eyes grow to 10 x 20 and move out to x 38 / 62, or the face is lost.
export function eyesPath({ X = 50, Y = HEX.cy, s = 1, look = [0, 0], micro = false } = {}) {
  const w = micro ? 10 : EYE_W, h = micro ? 20 : EYE_H;
  return EYES.map(([x, y]) => pillPath(X + ((micro ? (x < 50 ? 38 : 62) : x) - 50 + look[0]) * s, Y + (y - HEX.cy + look[1]) * s, w * s, h * s)).join('');
}
