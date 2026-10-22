
export function serviceRow(index, tripId, r, toDest) {
  const tr = index.trips.get(tripId), rows = index.tripTimes.get(tripId), k = rows.findIndex((x) => x.seq === r.seq);
  const route = index.routes.get(tr.route_id) || {}, name = (x) => (x ? index.stops.get(x.stopId).stop_name : null);
  const dir = directionOf(tr);
  return { tripId, routeId: tr.route_id, route: route.route_short_name || tr.route_id, headsign: tr.trip_headsign, dir: dir === null ? null : +dir,
    stopId: r.stopId, stopName: name(r), seq: r.seq, secs: r.dep, next: name(rows[k + 1]), last: name(rows.at(-1)), toDest };
}
export const byNow = (now) => (x, y) => Math.abs(x.secs - now) - Math.abs(y.secs - now) || (x.tripId < y.tripId ? -1 : 1);
const directionOf = (tr) => (tr.direction_id === undefined || tr.direction_id === null || tr.direction_id === "" ? null : String(tr.direction_id));

export function directionRivals(index, { date, now, at, tripId, dest, radiusO = 300, radiusD = 800, before = 1200, after = 300 }) {
  const mine = index.trips.get(tripId);
  if (!mine) return [];
  const services = index.activeServices(date);
  const near = index.stopsNear(at.lat, at.lon, radiusO);
  const dNear = new Set(index.stopsNear(dest.lat, dest.lon, radiusD).map((x) => x.stop.stop_id));
  const nextOf = (id, seq) => { const rows = index.tripTimes.get(id), k = rows.findIndex((r) => r.seq === seq); return rows[k + 1] ? rows[k + 1].stopId : null; };
  const best = new Map();                                 // tripId -> { r, d } nearest call
  for (const { stop, d } of near) {
    for (const x of index.stopCalls.get(stop.stop_id) || []) {
      const tr = index.trips.get(x.tripId);
      if (!tr || x.tripId === tripId || tr.route_id !== mine.route_id || !services.has(tr.service_id)) continue;
      if (x.dep < now - before || x.dep > now + after) continue;
      const rows = index.tripTimes.get(x.tripId), r = rows.find((y) => y.seq === x.seq);
      if (!r || r === rows.at(-1)) continue;
      const b = best.get(x.tripId);
      if (!b || d < b.d || (d === b.d && r.seq < b.r.seq)) best.set(x.tripId, { r, d });
    }
  }
  const nearIds = new Set(near.map((n) => n.stop.stop_id));
  const myCall = index.tripTimes.get(tripId).find((y) => nearIds.has(y.stopId));
  const myNext = myCall ? nextOf(tripId, myCall.seq) : null;
  const out = [];
  for (const [id, { r }] of best) {
    const a = directionOf(index.trips.get(id)), b = directionOf(mine);
    if (a !== null && b !== null ? a === b : nextOf(id, r.seq) === myNext) continue;
    const rows = index.tripTimes.get(id);
    out.push(serviceRow(index, id, r, rows.some((y) => y.seq > r.seq && dNear.has(y.stopId))));
  }
  return out.sort(byNow(now));
}
