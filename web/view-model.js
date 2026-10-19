
export const STATES = ["IDLE", "DESTINATION_SELECTED", "JOURNEY_PROPOSED", "WALKING_TO_STOP",
  "WAITING_FOR_BUS", "ON_BUS", "WALKING_FINAL", "ARRIVED", "UNKNOWN"];
export const ALERTS = ["NONE", "STAY_ON", "GET_READY", "PRESS_STOP", "GET_OFF"];
export const LEAVES = ["NONE", "LEAVE_IN", "LEAVE_NOW", "MISSED", "WAIT", "WALK"];
export const FARES = ["unknown", "free", "paid", "concession"];
export const DIRS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
export const ACTS = ["choose", "accept", "board", "alight", "where", "cancel", "done"];

const ints = (s) => s.trim().split(/\s+/).filter(Boolean).map(Number);

export function readState(script) {
  const st = { acts: [], option: null, bus: null, destWalk: null, strip: null, fareReason: null, route: null, head: null,
    candidate: null, retained: null, request: null, activate: null, window: null, measure: null, realtime: null };
  for (const line of script.split("\n")) {
    if (!line) continue;
    const op = line[0], rest = line.slice(1);
    if (op === "S") {
      const [s, a, l, bz, dest, note, where, rt, fix, walk, acts] = ints(rest);
      Object.assign(st, { state: STATES[s], alert: ALERTS[a], leave: LEAVES[l], buzz: bz, dest, note,
        where, rt, fix, walkOnly: walk });
      st.acts = ACTS.filter((_, i) => acts & (1 << i));
    } else if (op === "O") {
      const [trip, eta, boardTime, live, leaveIn, walkS, walkM, fare, reason, board, alight, delay = 0] = ints(rest);
      st.option = trip < 0 ? null : { trip, eta, boardTime, live, leaveIn, delay };
      Object.assign(st, { walkS, walkM, fare: FARES[fare], fareReasonIndex: reason, board, alight });
    } else if (op === "B") {
      const [board, alight, next, togo, rem, progress] = ints(rest);
      st.bus = { board, alight, next, togo, rem, progress };
    } else if (op === "D") {
      const [metres, dir, walkS] = ints(rest);
      st.destWalk = { metres, dir: DIRS[dir], walkS };
    } else if (op === "T") {
      const [prev, target, elided, ...upcoming] = ints(rest);
      st.strip = { prev, target, elided, upcoming };
    } else if (op === "F") {
      st.fareReason = rest.trim();
    } else if (op === "C") {
      const [gen, call, arr, cost, stops, dsts, trips, calls, arrs, truncated, pages = 1, retained = 0] = ints(rest);
      st.candidate = { gen, call, arr, cost, counts: { stops, dsts, trips, calls, arrs }, truncated, pages, retained };
    } else if (op === "R") {
      const [gen, n, ...v] = ints(rest);
      st.retained = { gen, alts: Array.from({ length: n }, (_, i) => ({ trip: v[3 * i], bseq: v[3 * i + 1], secs: v[3 * i + 2] })) };
    } else if (op === "Q") {
      const [gen, radiusO, radiusD, horizon, ox, oy, dx, dy, k, c, a, reach] = ints(rest);
      st.request = { gen, radiusO, radiusD, horizon, ox, oy, dx, dy, k, c, a, reach };
    } else if (op === "A") {
      const [trip, bseq, aseq] = ints(rest);
      st.activate = { trip, bseq, aseq };
    } else if (op === "W") {
      const [base, board, target] = ints(rest);
      st.window = { base, board, target };
    } else if (op === "M") {
      const v = ints(rest);
      st.measure = v[0] === 0 ? { kind: "pre", lo: v[1], hi: v[2], floor: v[3] }
        : { kind: "bus", lo: v[1], floor: v[2], base: v[3], rate: v[4], t0: v[5] };
    } else if (op === "P") {
      const [gen] = ints(rest);
      st.realtime = { gen };
    }
  }
  if (st.bus) { st.next = st.bus.next; st.togo = st.bus.togo; st.target = st.bus.alight; st.progress = st.bus.progress; }
  return st;
}
