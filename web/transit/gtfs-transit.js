
import { assembleCandidates, DEFAULT_LIMITS } from "./candidates.js";
import { metres } from "../gtfs/gtfs-index.js";

const RAD = Math.PI / 180;

function simplify(points, tolM, keep) {
  const k0 = points[0][0] * RAD, xy = points.map(([la, lo]) => [lo * RAD * Math.cos(k0) * 6371000, la * RAD * 6371000]);
  const out = new Uint8Array(points.length);
  out[0] = out[points.length - 1] = 1;
  for (const i of keep) out[i] = 1;
  const anchors = [...out.keys()].filter((i) => out[i]);
  for (let a = 0; a < anchors.length - 1; a++) {
    const st = [[anchors[a], anchors[a + 1]]];
    while (st.length) {
      const [i, j] = st.pop();
      const [ax, ay] = xy[i], [bx, by] = xy[j], L = Math.hypot(bx - ax, by - ay) || 1;
      let best = -1, bi = -1;
      for (let m = i + 1; m < j; m++) {
        const d = Math.abs((bx - ax) * (ay - xy[m][1]) - (ax - xy[m][0]) * (by - ay)) / L;
        if (d > best) { best = d; bi = m; }
      }
      if (best > tolM) { out[bi] = 1; st.push([i, bi], [bi, j]); }
    }
  }
  return points.filter((_, i) => out[i]);
}

export const MAX_PATTERN_POINTS = 400;

export class GtfsTransitProvider {
  constructor({ index, realtime = null, simplifyM = 2, maxPoints = MAX_PATTERN_POINTS, limits = DEFAULT_LIMITS }) {
    this.index = index;
    this.simplifyM = simplifyM;
    this.maxPoints = maxPoints;
    this.limits = limits;
    this.tripIds = [...index.trips.keys()].sort();
    this.tripNoOf = new Map(this.tripIds.map((id, i) => [id, i]));
    this.patIds = [...index.patterns.keys()];
    this.patNoOf = new Map(this.patIds.map((id, i) => [id, i]));
    this.updates = (realtime && realtime.updates) || [];
    this.sink = null;
    this.live = true;
    this.last = -1;
    this.patternCache = new Map();
  }

  candidates(query) {
    const set = assembleCandidates(this.index, { ...query, limits: this.limits });
    for (const t of set.trips) { t.tripNo = this.tripNoOf.get(t.tripId); t.patNo = this.patNoOf.get(t.patternId); }
    return set;
  }

  pattern(patNo) {
    if (this.patternCache.has(patNo)) return this.patternCache.get(patNo);
    const p = this.index.patterns.get(this.patIds[patNo]);
    const shape = this.index.shape(p.shapeId);
    const sample = this.index.tripTimes.get(p.trips[0]);
    let from = 0;
    const keep = [];
    const stops = sample.map((row) => {
      const s = this.index.stops.get(row.stopId);
      let bi = from, bd = Infinity;
      for (let i = from; i < shape.length; i++) {
        const d = metres(s.lat, s.lon, shape[i][0], shape[i][1]);
        if (d < bd) { bd = d; bi = i; }
        if (d < 0.5) break;
      }
      from = bi;
      keep.push(bi);
      return { stopId: row.stopId, name: s.stop_name, lat: s.lat, lon: s.lon, dist_m: shape[bi][2], seq: row.seq };
    });
    let tol = this.simplifyM, points = simplify(shape, tol, keep);
    while (points.length > this.maxPoints && tol < 50) { tol *= 1.25; points = simplify(shape, tol, keep); }
    points = points.map(([la, lo, d]) => [la, lo, d]);
    const route = this.index.routes.get(p.routeId) || {};
    const out = { patNo, name: route.route_short_name || p.routeId, headsign: p.headsign, points, stops };
    this.patternCache.set(patNo, out);
    return out;
  }

  rawShape(patNo) {
    const p = this.index.patterns.get(this.patIds[patNo]);
    return this.index.shape(p.shapeId).map(([la, lo, d]) => [la, lo, d]);
  }

  tripTimes(tripNo) {
    return this.index.tripTimes.get(this.tripIds[tripNo]).map((r) => ({ seq: r.seq, dep: r.dep, arr: r.arr }));
  }
  tripPattern(tripNo) { return this.patNoOf.get(this.index.tripPattern.get(this.tripIds[tripNo])); }

  start(sink) { this.sink = sink; }
  tick(secs) {
    if (!this.sink || !this.live) { this.last = secs; return; }
    for (const u of this.updates) {
      const from = u.fromSecs ?? hmsToSecs(u.from);
      if (secs < from) continue;
      const due = Math.floor((secs - from) / u.every_s);
      const prev = this.last < from ? -1 : Math.floor((this.last - from) / u.every_s);
      if (due !== prev && this.tripNoOf.has(u.trip_id)) this.sink.realtime({ trip: this.tripNoOf.get(u.trip_id), delay: u.delay });
    }
    this.last = secs;
  }
  delayFor(tripNo) {
    const u = this.updates.find((x) => x.trip_id === this.tripIds[tripNo]);
    return u ? u.delay : 0;
  }
  dropRealtime() { this.live = false; if (this.sink) this.sink.realtimeLost(); }
  restoreRealtime() { this.live = true; this.last = -1; }
}

function hmsToSecs(t) { const [h, m, s = 0] = t.split(":").map(Number); return h * 3600 + m * 60 + s; }
