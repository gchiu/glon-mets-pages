
export const DEFAULT_LIMITS = { stops: 40, dsts: 24, trips: 24, calls: 64, arrs: 48 };

export function assembleCandidates(index, { date, now, origin, dest, radiusO, radiusD, horizon, limits = DEFAULT_LIMITS }) {
  let truncated = false;
  const cut = (list, n) => { if (list.length > n) { truncated = true; return list.slice(0, n); } return list; };

  const oNear = cut(index.stopsNear(origin.lat, origin.lon, radiusO), limits.stops);
  const dNear = cut(index.stopsNear(dest.lat, dest.lon, radiusD), limits.dsts);
  const oRef = new Map(oNear.map((x, i) => [x.stop.stop_id, i]));
  const dRef = new Map(dNear.map((x, i) => [x.stop.stop_id, i]));
  const services = index.activeServices(date);

  const firstCall = new Map();                           // tripId -> earliest in-window origin-area departure
  for (const stopId of oRef.keys()) {
    for (const c of index.stopCalls.get(stopId) || []) {
      const tr = index.trips.get(c.tripId);
      if (!tr || !services.has(tr.service_id) || c.dep < now || c.dep > now + horizon) continue;
      if (!firstCall.has(c.tripId) || c.dep < firstCall.get(c.tripId)) firstCall.set(c.tripId, c.dep);
    }
  }
  const tripIds = cut([...firstCall.keys()].sort((a, b) => firstCall.get(a) - firstCall.get(b) || (a < b ? -1 : 1)), limits.trips);

  const trips = [], calls = [], arrs = [];
  for (const tripId of tripIds) {
    const tr = index.trips.get(tripId), rows = index.tripTimes.get(tripId);
    const route = index.routes.get(tr.route_id) || {};
    const ref = trips.length;
    const tc = rows.filter((r) => oRef.has(r.stopId) && r.dep >= now && r.dep <= now + horizon)
      .map((r) => ({ tripRef: ref, stopRef: oRef.get(r.stopId), seq: r.seq, secs: r.dep }));
    const ta = rows.filter((r) => dRef.has(r.stopId))
      .map((r) => ({ tripRef: ref, dstRef: dRef.get(r.stopId), seq: r.seq, secs: r.arr }));
    if (calls.length + tc.length > limits.calls || arrs.length + ta.length > limits.arrs) { truncated = true; break; }
    trips.push({ ref, tripId, patternId: index.tripPattern.get(tripId), route: route.route_short_name || tr.route_id,
      dir: +tr.direction_id, headsign: tr.trip_headsign, firstArr: arrs.length, lastArr: arrs.length + ta.length - 1 });
    calls.push(...tc);
    arrs.push(...ta);
  }

  return {
    query: { date, now, origin, dest, radiusO, radiusD, horizon },
    stops: oNear.map((x, i) => ({ ref: i, stopId: x.stop.stop_id, name: x.stop.stop_name, lat: x.stop.lat, lon: x.stop.lon })),
    dsts: dNear.map((x, i) => ({ ref: i, stopId: x.stop.stop_id, name: x.stop.stop_name, lat: x.stop.lat, lon: x.stop.lon })),
    trips,
    calls,
    arrs,
    truncated,
  };
}
