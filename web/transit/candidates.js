
export const PAGE_LIMITS = { stops: 40, dsts: 24, trips: 24, calls: 64, arrs: 48 };
const NONE = Number.POSITIVE_INFINITY;

export function assembleCandidates(index, { date, now, origin, dest, radiusO, radiusD, horizon, k = NONE, c = NONE, a = NONE, reach = 0 }) {
  const oNear = index.stopsNear(origin.lat, origin.lon, radiusO);
  const dNear = index.stopsNear(dest.lat, dest.lon, radiusD);
  const oRef = new Map(oNear.map((x, i) => [x.stop.stop_id, i]));
  const dRef = new Map(dNear.map((x, i) => [x.stop.stop_id, i]));
  const services = index.activeServices(date);
  const stats = { originStops: oNear.length, destStops: dNear.length, tripsInWindow: 0, droppedNoDest: 0,
    callsInWindow: 0, droppedNextK: 0, droppedNearestC: 0, arrsSeen: 0, droppedNearestA: 0 };

  const callsOf = new Map();                              // tripId -> [{ stopId, seq, dep }]
  for (const stopId of oRef.keys()) {
    for (const x of index.stopCalls.get(stopId) || []) {
      const tr = index.trips.get(x.tripId);
      if (!tr || !services.has(tr.service_id) || x.dep < now || x.dep > now + horizon) continue;
      if (!callsOf.has(x.tripId)) callsOf.set(x.tripId, []);
    }
  }
  for (const tripId of callsOf.keys()) {
    for (const r of index.tripTimes.get(tripId)) if (oRef.has(r.stopId) && r.dep >= now && r.dep <= now + horizon) callsOf.get(tripId).push(r);
  }
  stats.tripsInWindow = callsOf.size;
  for (const v of callsOf.values()) stats.callsInWindow += v.length;

  for (const tripId of [...callsOf.keys()]) {
    if (!index.tripTimes.get(tripId).some((r) => dRef.has(r.stopId))) { stats.droppedNoDest++; callsOf.delete(tripId); }
  }

  if (k !== NONE) {
    const groups = new Map();                             // pattern|stop -> [{ tripId, r }]
    for (const [tripId, rows] of callsOf) {
      const key0 = index.tripPattern.get(tripId);
      for (const r of rows) {
        const key = `${key0}|${r.stopId}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ tripId, r });
      }
    }
    const drop = new Set();
    for (const list of groups.values()) {
      const d = oNear[oRef.get(list[0].r.stopId)].d;
      const reachable = now + (reach > 0 ? Math.floor(d * 100 / reach) : 0) + 60;
      list.sort((x, y) => x.r.dep - y.r.dep || (x.tripId < y.tripId ? -1 : 1));
      let kept = 0;
      for (const { r } of list) {
        if (r.dep < reachable) continue;                    // not yet reachable: kept
        if (kept < k) { kept++; continue; }
        drop.add(r);
      }
    }
    for (const [tripId, rows] of callsOf) {
      const keep = rows.filter((r) => !drop.has(r));
      stats.droppedNextK += rows.length - keep.length;
      if (keep.length) callsOf.set(tripId, keep); else callsOf.delete(tripId);
    }
  }

  const first = (tripId) => Math.min(...callsOf.get(tripId).map((r) => r.dep));
  const tripIds = [...callsOf.keys()].sort((x, y) => first(x) - first(y) || (x < y ? -1 : 1));

  const nearest = (rows, dist, n) => {
    if (rows.length <= n) return rows;
    const keep = new Set([...rows].sort((x, y) => dist(x) - dist(y) || x.seq - y.seq).slice(0, n));
    return rows.filter((r) => keep.has(r));
  };
  const trips = [], calls = [], arrs = [];
  for (const tripId of tripIds) {
    const tr = index.trips.get(tripId), rows = index.tripTimes.get(tripId);
    const route = index.routes.get(tr.route_id) || {};
    const ref = trips.length;
    const oc = callsOf.get(tripId), da = rows.filter((r) => dRef.has(r.stopId));
    stats.arrsSeen += da.length;
    const tc = nearest(oc, (r) => oNear[oRef.get(r.stopId)].d, c);
    const ta = nearest(da, (r) => dNear[dRef.get(r.stopId)].d, a);
    stats.droppedNearestC += oc.length - tc.length;
    stats.droppedNearestA += da.length - ta.length;
    trips.push({ ref, tripId, patternId: index.tripPattern.get(tripId), route: route.route_short_name || tr.route_id,
      dir: +tr.direction_id, headsign: tr.trip_headsign, firstArr: arrs.length, lastArr: arrs.length + ta.length - 1 });
    for (const r of tc) calls.push({ tripRef: ref, stopRef: oRef.get(r.stopId), seq: r.seq, secs: r.dep });
    for (const r of ta) arrs.push({ tripRef: ref, dstRef: dRef.get(r.stopId), seq: r.seq, secs: r.arr });
  }

  return {
    query: { date, now, origin, dest, radiusO, radiusD, horizon, k, c, a, reach },
    stops: oNear.map((x, i) => ({ ref: i, stopId: x.stop.stop_id, name: x.stop.stop_name, lat: x.stop.lat, lon: x.stop.lon })),
    dsts: dNear.map((x, i) => ({ ref: i, stopId: x.stop.stop_id, name: x.stop.stop_name, lat: x.stop.lat, lon: x.stop.lon })),
    trips,
    calls,
    arrs,
    truncated: false,
    stats,
  };
}

export function pageCandidates(set, limits = PAGE_LIMITS) {
  const callsOf = set.trips.map(() => []), arrsOf = set.trips.map(() => []);
  set.calls.forEach((x, i) => callsOf[x.tripRef].push(i));
  for (const t of set.trips) for (let i = t.firstArr; i <= t.lastArr; i++) arrsOf[t.ref].push(i);
  const pages = [];
  let page = null;
  const open = () => (page = { stops: [], dsts: [], trips: [], calls: [], arrs: [], truncated: false, stopSet: new Set(), dstSet: new Set() });
  for (const t of set.trips) {
    let cs = callsOf[t.ref], as = arrsOf[t.ref], truncated = false;
    const within = (rows, ref, cap) => {
      const keep = new Set([...new Set(rows.map(ref))].sort((x, y) => x - y).slice(0, cap));
      const out = rows.filter((i) => keep.has(ref(i)));
      if (out.length < rows.length) truncated = true;
      return out;
    };
    cs = within(cs, (i) => set.calls[i].stopRef, limits.stops);
    as = within(as, (i) => set.arrs[i].dstRef, limits.dsts);
    if (cs.length > limits.calls) { cs = cs.slice(0, limits.calls); truncated = true; }
    if (as.length > limits.arrs) { as = as.slice(0, limits.arrs); truncated = true; }
    const newStops = new Set(cs.map((i) => set.calls[i].stopRef)), newDsts = new Set(as.map((i) => set.arrs[i].dstRef));
    const fits = (p) => p.trips.length + 1 <= limits.trips && p.calls.length + cs.length <= limits.calls && p.arrs.length + as.length <= limits.arrs &&
      new Set([...p.stopSet, ...newStops]).size <= limits.stops && new Set([...p.dstSet, ...newDsts]).size <= limits.dsts;
    if (!page || !fits(page)) { if (page && page.trips.length) pages.push(page); open(); }
    page.trips.push(t.ref);
    page.calls.push(...cs);
    page.arrs.push(...as);
    for (const s of newStops) page.stopSet.add(s);
    for (const d of newDsts) page.dstSet.add(d);
    page.truncated = page.truncated || truncated;
  }
  if (page && page.trips.length) pages.push(page);
  for (const p of pages) { p.stops = [...p.stopSet].sort((x, y) => x - y); p.dsts = [...p.dstSet].sort((x, y) => x - y); delete p.stopSet; delete p.dstSet; }
  return pages;
}
