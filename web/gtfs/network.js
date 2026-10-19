import { GtfsIndex } from "./gtfs-index.js";

export const CATALOGUE_FORMAT = "doordash-network-catalogue";
export const PACKAGE_FORMAT = "doordash-route-package";
export const NETWORK_VERSION = 1;

export class NetworkError extends Error {}

const untable = (t) => t.rows.map((r) => Object.fromEntries(t.cols.map((c, i) => [c, r[i]])));
const col = (t, k) => t.cols.indexOf(k);

export function checkCatalogue(cat) {
  if (!cat || cat.format !== CATALOGUE_FORMAT || cat.version !== NETWORK_VERSION) throw new NetworkError("not a network catalogue this app can read");
  return cat;
}
export function checkPackage(cat, p) {
  if (!p || p.format !== PACKAGE_FORMAT || p.version !== NETWORK_VERSION) throw new NetworkError("not a route package this app can read");
  if (p.feed !== cat.feed.id) throw new NetworkError(`route ${p.routeId} belongs to another timetable (feed ${p.feed}, not ${cat.feed.id})`);
  if (!cat.packages[p.routeId]) throw new NetworkError(`route ${p.routeId} is not in this catalogue`);
  return p;
}

export function routeChoices(cat) {
  const R = cat.routes, id = col(R, "route_id"), sn = col(R, "route_short_name"), ln = col(R, "route_long_name"), ty = col(R, "route_type");
  return R.rows.filter((r) => cat.packages[r[id]])
    .map((r) => ({ routeId: r[id], number: r[sn], name: r[ln], type: +r[ty] }));
}

export function resolveRoutes(cat, text) {
  const words = String(text || "").split(/[\s,;]+/).map((w) => w.trim()).filter(Boolean);
  const choices = routeChoices(cat), found = [], unknown = [];
  for (const w of words) {
    const m = choices.filter((c) => c.number.toLowerCase() === w.toLowerCase());
    if (m.length) for (const c of m) { if (!found.some((f) => f.routeId === c.routeId)) found.push(c); }
    else if (!unknown.includes(w)) unknown.push(w);
  }
  return { routes: found, unknown };
}

export function loadNetwork(cat, packages) {
  checkCatalogue(cat);
  const pkgs = [...new Map(packages.map((p) => [checkPackage(cat, p).routeId, p])).values()];
  const merged = (key) => {
    const seen = new Set(), rows = [];
    for (const p of pkgs) for (const r of p[key].rows) { const k = JSON.stringify(r); if (!seen.has(k)) { seen.add(k); rows.push(r); } }
    return { cols: pkgs.length ? pkgs[0][key].cols : [], rows };
  };
  const index = new GtfsIndex({
    feedInfo: cat.feed.info, routes: untable(cat.routes), trips: untable(merged("trips")), stopTimes: [],
    stops: untable(cat.stops), shapes: [], calendar: untable(merged("calendar")), calendarDates: untable(merged("calendarDates")),
  });
  const tripTimes = new Map(), stopCalls = new Map();
  for (const p of pkgs) {
    const s = p.stopTimes;
    for (let i = 0; i < s.trip.length; i++) {
      const tripId = p.tripIds[s.trip[i]], stopId = p.stopIds[s.stop[i]];
      const row = { tripId, stopId, seq: s.seq[i], arr: s.arr[i], dep: s.dep[i] };
      let a = tripTimes.get(tripId); if (!a) tripTimes.set(tripId, (a = [])); a.push(row);
      let b = stopCalls.get(stopId); if (!b) stopCalls.set(stopId, (b = [])); b.push(row);
    }
  }
  for (const v of tripTimes.values()) v.sort((x, y) => x.seq - y.seq);
  index.tripTimes = tripTimes;
  index.stopCalls = stopCalls;
  index.patterns = new Map();
  index.tripPattern = new Map();
  for (const [tripId, rows] of tripTimes) {
    const tr = index.trips.get(tripId);
    if (!tr) continue;
    const key = `${tr.route_id}|${tr.direction_id}|${rows.map((r) => r.stopId).join(">")}`;
    if (!index.patterns.has(key)) {
      index.patterns.set(key, { id: key, routeId: tr.route_id, dir: +tr.direction_id, headsign: tr.trip_headsign,
        stopIds: rows.map((r) => r.stopId), shapeId: tr.shape_id, trips: [] });
    }
    index.patterns.get(key).trips.push(tripId);
    index.tripPattern.set(tripId, key);
  }
  const shapes = new Map();
  for (const p of pkgs) {
    const fresh = new Set(p.shapeIds.filter((id) => !shapes.has(id))), q = p.shapes;
    for (let i = 0; i < q.shape.length; i++) {
      const id = p.shapeIds[q.shape[i]];
      if (!fresh.has(id)) continue;
      let a = shapes.get(id); if (!a) shapes.set(id, (a = []));
      a.push([q.lat[i], q.lon[i], q.dist[i], q.seq[i]]);
    }
  }
  for (const v of shapes.values()) v.sort((x, y) => x[3] - y[3]);
  index.shapes = shapes;
  index.network = {
    feed: cat.feed.id, routes: pkgs.map((p) => p.routeId),
    callRules: Object.fromEntries(pkgs.map((p) => [p.routeId, { pickup: p.stopTimes.pickup, dropoff: p.stopTimes.dropoff, headsign: p.stopTimes.headsign }])),
    transfers: untable(merged("transfers")),
    parentStations: untable(cat.stops).filter((s) => s.location_type === "1"),
  };
  return index;
}
