export const JOURNEY_KEY = "dd-journey-v1";
export const PHASES = ["ON_BUS", "WALKING_FINAL"];
export const STALE_S = 4 * 3600;

const isInt = (v) => Number.isInteger(v);
const isStr = (v) => typeof v === "string" && v.length > 0 && v.length <= 200;
const isCoord = (v, lim) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= lim;

function valid(r) {
  if (!r || r.v !== 1) return false;
  if (![r.feed, r.routeId, r.tripId, r.boardStopId, r.alightStopId].every(isStr)) return false;
  if (![r.boardSeq, r.boardSecs, r.alightSeq, r.date].every(isInt) || r.alightSeq <= r.boardSeq) return false;
  if (!PHASES.includes(r.phase)) return false;
  const d = r.dest;
  return !!d && isInt(d.slot) && d.slot >= 0 && isStr(d.name) && isCoord(d.lat, 90) && isCoord(d.lon, 180) &&
    (d.placeId === undefined || isStr(d.placeId));
}

export class JourneyStore {
  constructor(storage = globalThis.localStorage) { this.storage = storage; }
  load() {
    let raw = null;
    try { raw = this.storage ? this.storage.getItem(JOURNEY_KEY) : null; } catch { raw = null; }
    if (raw == null) return { record: null, problem: null };
    let r = null;
    try { r = JSON.parse(raw); } catch { r = null; }
    return valid(r) ? { record: r, problem: null } : { record: null, problem: "unreadable" };
  }
  save(r) {
    if (!valid(r)) throw new Error("not an active journey");
    try { this.storage.setItem(JOURNEY_KEY, JSON.stringify(r)); return true; } catch { return false; }
  }
  clear() { try { this.storage.removeItem(JOURNEY_KEY); } catch { /* nothing kept */ } }
}

export function checkJourney(r, { selection, index, clock, destCount }) {
  if (!selection || r.feed !== selection.feed) return "The timetable on this device has changed since then.";
  if (!selection.routes.some((x) => x.routeId === r.routeId)) return "That bus route is no longer on this device.";
  const tr = index.trips.get(r.tripId), rows = index.tripTimes.get(r.tripId);
  if (!tr || !rows || tr.route_id !== r.routeId) return "That bus could not be found in the timetable.";
  const b = rows.find((x) => x.seq === r.boardSeq), a = rows.find((x) => x.seq === r.alightSeq);
  if (!b || !a || b.stopId !== r.boardStopId || a.stopId !== r.alightStopId) return "That bus could not be found in the timetable.";
  if (r.date !== clock.date || clock.secs - r.boardSecs > STALE_S || clock.secs < r.boardSecs - 3600) return "That bus journey is over.";
  if (r.dest.slot >= destCount) return "That journey's destination is not available.";
  return null;
}
