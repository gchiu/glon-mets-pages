
const W = 2 ** 28, H = 2 ** 27;
const wrap = (v) => { const r = ((v + H) % W + W) % W - H; return r; };
const add = (a, b) => wrap(a + b);
const sub = (a, b) => wrap(a - b);
const mul = (a, b) => wrap(a * b);                 // |a*b| < 2^53 for these inputs, so exact before wrapping
const div = (a, b) => wrap(Math.trunc(a / b));     // truncates towards zero (/ -7 2 = -3)
const lt = (a, b) => a < b;

const clampv = (v) => (v > 8000 ? 8000 : v < -8000 ? -8000 : v);
const sq = (v) => mul(v, v);
const d2 = (ax, ay, bx, by) => add(sq(clampv(sub(ax, bx))), sq(clampv(sub(ay, by))));
export function isq(n) {
  if (n < 2) return n;
  let x = n < 11586 ? n : 11586;
  for (;;) { const y = div(add(x, div(n, x)), 2); if (lt(y, x)) x = y; else return x; }
}

export function routePoints(points, proj) {
  const out = [];
  let lastD = -1;
  for (const [lat, lon, d] of points) {
    const dm = Math.round(d);
    if (dm <= lastD) continue;
    const [x, y] = proj.toXY(lat, lon);
    out.push([x, y, dm]);
    lastD = dm;
  }
  return out;
}

export const SEGMENT_MAX_M = 4000;
export function subdivide(pts, maxM = SEGMENT_MAX_M) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay, ad] = pts[i - 1], [bx, by, bd] = pts[i];
    const k = Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(by - ay)) / maxM);
    for (let j = 1; j < k; j++) {
      const d = Math.round(ad + (bd - ad) * j / k);
      if (d > out.at(-1)[2] && d < bd) out.push([Math.round(ax + (bx - ax) * j / k), Math.round(ay + (by - ay) * j / k), d]);
    }
    out.push(pts[i]);
  }
  return out;
}

export class RouteMeasurer {
  constructor(pts) {
    if (!Array.isArray(pts) || pts.length < 2) throw new Error("a route needs at least two points");
    this.pts = pts;
    this.n = pts.length;
    this.segmentsVisited = 0;      // instrumentation for benchmarks only
  }

  #proj(i, px, py) {
    const [ax, ay, d0] = this.pts[i], [bx, by, d1] = this.pts[i + 1];
    const ux = sub(bx, ax), uy = sub(by, ay);
    let len = sub(d1, d0);
    if (len < 1) len = 1;
    let tg = div(add(mul(clampv(sub(px, ax)), ux), mul(clampv(sub(py, ay)), uy)), len);
    if (tg < 0) tg = 0; else if (tg > len) tg = len;
    return { s: add(d0, tg), l2: d2(px, py, add(ax, div(mul(ux, tg), len)), add(ay, div(mul(uy, tg), len))) };
  }

  #score(i, px, py, floor) {
    this.segmentsVisited++;
    const p = this.#proj(i, px, py);
    const l2 = p.l2 > 60000000 ? 60000000 : p.l2;
    return p.s < floor ? add(l2, 70000000) : l2;
  }

  #best(a, b, px, py, floor) {
    if (a >= b) return { i: a, sc: this.#score(a, px, py, floor) };
    const m = div(add(a, b), 2);
    const L = this.#best(a, m, px, py, floor);
    const R = this.#best(add(m, 1), b, px, py, floor);
    return R.sc < L.sc ? R : L;
  }

  #find(a, b, s) {
    while (a < b) {
      const m = div(add(add(a, b), 1), 2);
      if (this.pts[m][2] <= s) a = m; else b = sub(m, 1);
    }
    return a;
  }

  measure({ x, y, lo, hi, floor }) {
    const top = this.n - 2;
    const a = this.#find(0, top, lo), b = this.#find(0, top, hi);
    const { i } = this.#best(a, b, x, y, floor);
    const p = this.#proj(i, x, y);
    return { s: p.s, lat: isq(p.l2), seg: i, l2: p.l2 };
  }
}
