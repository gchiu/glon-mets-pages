
import { RouteMeasurer, routePoints, subdivide } from "./route-measure.js";

export const WINDOW_CONTIGUOUS = 5;      // base .. base+4: next-1 (ride remaining), next, and up to strip-max (4) - 1 beyond
export const WINDOW_MAX_ROWS = WINDOW_CONTIGUOUS + 2;   // plus the pinned boarding and target rows

const tdiv = (a, b) => Math.trunc(a / b);

export class ActiveTrip {
  constructor({ provider, tripNo, proj, geometry = "glon" }) {
    if (geometry !== "glon" && geometry !== "full") throw new Error("geometry is 'glon' or 'full'");
    this.provider = provider;
    this.tripNo = tripNo;
    this.patNo = provider.tripPattern(tripNo);
    this.pattern = provider.pattern(this.patNo);
    this.proj = proj;
    this.geometry = geometry;
    const times = provider.tripTimes(tripNo);
    if (times.length !== this.pattern.stops.length) throw new Error("trip times do not match the pattern's stops");
    this.rows = this.pattern.stops.map((s, k) => {
      const [x, y] = proj.toXY(s.lat, s.lon);
      return { k, s: Math.round(s.dist_m), sched: times[k].dep, x, y, seq: s.seq, stopId: s.stopId, name: s.name };
    });
    this.n = this.rows.length;
    this.measurer = null;
  }

  indexOfSeq(seq) {
    let a = 0, b = this.n - 1;
    while (a < b) { const m = tdiv(a + b, 2); if (this.rows[m].seq < seq) a = m + 1; else b = m; }
    return this.n && this.rows[a].seq === seq ? a : -1;
  }

  activation(bseq, aseq) {
    return { trip: this.tripNo, boardK: this.indexOfSeq(bseq), alightK: this.indexOfSeq(aseq), n: this.n };
  }

  static fact(r) { return [r.k, r.s, r.sched, r.x, r.y]; }

  window({ base, board = -1, target = -1 }) {
    const ks = new Set();
    for (let k = base; k < base + WINDOW_CONTIGUOUS; k++) if (k >= 0 && k < this.n) ks.add(k);
    for (const k of [board, target]) if (k >= 0 && k < this.n) ks.add(k);
    const out = [...ks].sort((a, b) => a - b).map((k) => this.rows[k]);
    if (out.length > WINDOW_MAX_ROWS) throw new Error("window bound exceeded");   // cannot happen by construction
    return out;
  }

  projection(req, fix) {
    if (req.kind === "pre") return { lo: req.lo, hi: req.hi, floor: req.floor };
    if (req.kind === "bus") {
      let dt = fix.t - req.t0;
      if (dt < 1) dt = 1;
      return { lo: req.lo, hi: req.base + tdiv(req.rate * dt, 100) + fix.acc, floor: req.floor };
    }
    throw new Error("unknown M request " + req.kind);
  }

  measure(req, fix) {
    if (!this.measurer) {
      const pts = this.geometry === "glon" ? routePoints(this.pattern.points, this.proj) : subdivide(routePoints(this.provider.rawShape(this.patNo), this.proj));
      this.measurer = new RouteMeasurer(pts);
    }
    const w = this.projection(req, fix);
    const m = this.measurer.measure({ x: fix.x, y: fix.y, ...w });
    return { ...w, s: m.s, lat: m.lat };
  }

  static stopsAhead(rows, next, target) {
    const by = new Map(rows.map((r) => [r.k, r]));
    const following = [];
    for (let k = next + 1; k < target && by.has(k); k++) following.push(by.get(k));
    const last = following.length ? following.at(-1).k : next;
    return { previous: by.get(next - 1) || null, next: by.get(next) || null, following, target: by.get(target) || null,
      hidden: Math.max(0, target - last - 1) };
  }
}
