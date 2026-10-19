
import { readState } from "./view-model.js";
import { pageCandidates } from "./transit/candidates.js";
import { ActiveTrip } from "./transit/active-trip.js";
export { readState };

const MATCH_S = 90;
const EVENT_BYTES = 200;
export function packInt(v) {
  if (!Number.isInteger(v) || Math.abs(v) >= 2 ** 27) throw new Error("packInt: not a 28-bit integer: " + v);
  let m = Math.abs(v), s = String.fromCharCode(80 + (m % 45));
  for (m = Math.floor(m / 45); m > 0; m = Math.floor(m / 45)) s = String.fromCharCode(35 + (m % 45)) + s;
  return (v < 0 ? "!" : "") + s;
}
const packRow = (...xs) => xs.map(packInt).join("");

export class JourneyHost {
  constructor(machine, proj, { onRender = () => {}, effects = null, transit = null, geometry = "full" } = {}) {
    this.machine = machine;
    this.proj = proj;
    this.onRender = onRender;
    this.effects = effects;
    this.transit = transit;
    this.record = machine.html;
    this.state = readState(this.record);
    this.lastClock = null;
    this.delays = new Map();          // trip-wide realtime per tripNo: { delay, seen }
    this.stopFacts = new Map();       // latest stop-predictions answer per stopId: { seen, facts }
    this.sentRt = new Map();          // call ref -> the realtime fact Glon last received for it
    this.geometry = geometry;         // measurement geometry: "full" GTFS shape (B1.2 Stage C), or "glon" (the old simplified one)
    this.active = null;               // the ActiveTrip Glon chose (the host keeps it whole)
    this.activePattern = null;        // its pattern (stop names, route name, headsign)
    this.heldRows = new Set();        // stop rows (k) Glon has been sent for the current window
    this.answeredQ = -1;
    this.answeredA = "";
    this.depth = 0;
  }

  position({ lat, lon, accuracy = 10 }) {
    const [x, y] = this.proj.toXY(lat, lon);
    const acc = Math.max(0, Math.round(accuracy));
    let s = -1, l = -1;
    const req = this.state.measure;
    if (req && this.active) {
      const m = this.active.measure(req, { x, y, acc, t: this.#now() });
      s = m.s; l = m.lat;
    }
    return this.#send("fix", `${x} ${y} ${acc} ${s} ${l}`);
  }
  clock(time) { this.lastClock = time; return this.#send("clock", `${time.secs} ${time.date} ${time.weekday}`); }
  realtime({ trip, delay, seen = this.#now() }) {
    this.delays.set(trip, { delay, seen });
    this.#sendCalls((c, t) => t.tripNo === trip);
    return this.realtimeEnd(seen);
  }
  stopRealtime(stopId, facts, seen) {
    this.stopFacts.set(String(stopId), { seen, facts });
    this.#sendCalls((c, t, s) => s.stopId === String(stopId));
  }
  realtimeEnd(seen = this.#now()) { return this.#send("cq-rt-end", String(seen)); }
  realtimeLost() {
    this.delays.clear();
    this.stopFacts.clear();
    this.sentRt.clear();
    return this.#send("rt-lost");
  }
  command(name, value) { return this.#send(name, value); }
  passengerType(type) {
    return this.#send("pax", String(type === "supergold" ? 2 : type === "standard" ? 1 : 0));
  }
  destination(k, { lat, lon }) {
    const [x, y] = this.proj.toXY(lat, lon);
    return this.#send("dest-at", `${k} ${x} ${y}`);
  }

  retained() {
    const set = this.candidateSet, r = this.state.retained;
    if (!set || !r || r.gen !== set.gen) return [];
    return r.alts.map((x, alt) => {
      const ci = set.callAt.get(`${x.trip}/${x.bseq}`);
      if (ci === undefined) return null;
      const call = set.calls[ci];
      return { alt, trip: set.trips[call.tripRef], stop: set.stops[call.stopRef], call };
    }).filter(Boolean);
  }

  realtimeStops(max = 8) {
    const p = this.state.realtime;
    if (!this.candidateSet || !p || p.gen !== this.candidateSet.gen) return [];
    return [...new Set(this.retained().map((x) => x.stop.stopId))].slice(0, max);
  }

  #now() { return this.lastClock ? this.lastClock.secs : 0; }

  #factFor(c, t, s) {
    const ans = this.stopFacts.get(s.stopId);
    if (ans) {
      let best = null;
      for (const f of ans.facts) {
        if (f.tripId !== t.tripId) continue;
        const off = Math.abs(f.aimed - c.secs);
        if (off <= MATCH_S && (!best || off < Math.abs(best.aimed - c.secs))) best = f;
      }
      return best && best.live ? { delay: best.expected - c.secs, seen: ans.seen } : { delay: 0, seen: -1 };
    }
    return this.delays.get(t.tripNo) || null;
  }
  #sendCalls(pred) {
    for (const { alt, trip: t, stop: s, call: c } of this.retained()) {
      if (!pred(c, t, s)) continue;
      const f = this.#factFor(c, t, s);
      if (!f) continue;
      const v = `${f.delay} ${f.seen}`, prev = this.sentRt.get(alt);
      if (prev === v || (f.seen < 0 && prev === undefined)) continue;
      this.sentRt.set(alt, v);
      this.#send("cq-rt", `${alt} ${v}`);
    }
  }

  candidates(set, gen = 1, { pageOrder = null } = {}) {
    const xy = (p) => this.proj.toXY(p.lat, p.lon).join(" ");
    const paged = pageCandidates(set);
    const pages = pageOrder ? pageOrder.map((i) => paged[i]) : paged;
    const tripNo = (t) => t.tripNo ?? t.ref;
    this.candidateSet = { ...set, gen, pages: pages.length,
      callAt: new Map(set.calls.map((c, i) => [`${tripNo(set.trips[c.tripRef])}/${c.seq}`, i])) };
    this.sentRt.clear();
    if (!pages.length) {                                   // nothing at all: one empty, final page
      this.#send("cq-page", `${gen} 0`);
      return this.#send("cq-page-end", `${gen} 0 1 ${set.truncated ? 1 : 0}`);
    }
    pages.forEach((p, n) => {
      const sRef = new Map(p.stops.map((s, i) => [s, i])), dRef = new Map(p.dsts.map((d, i) => [d, i]));
      const tRef = new Map(p.trips.map((t, i) => [t, i]));
      this.#send("cq-page", `${gen} ${n}`);
      const xyv = (p) => this.proj.toXY(p.lat, p.lon);
      this.#batch("cq-stop", p.stops.map((s) => packRow(...xyv(set.stops[s]), 0, 0)));
      this.#batch("cq-dst", p.dsts.map((d) => packRow(...xyv(set.dsts[d]), 0)));
      let first = 0;
      this.#batch("cq-trip", p.trips.map((ti) => {
        const t = set.trips[ti], na = p.arrs.filter((a) => a >= t.firstArr && a <= t.lastArr).length;   // a trip's arrivals: its range
        const row = packRow(t.patNo ?? 0, t.dir, first, first + na - 1, tripNo(t), 0, 0, 0);
        first += na;
        return row;
      }));
      this.#batch("cq-call", p.calls.map((ci) => { const c = set.calls[ci]; return packRow(tRef.get(c.tripRef), sRef.get(c.stopRef), c.seq, c.secs, ci, 0, 0); }));
      p.calls.forEach((ci, local) => {
        const c = set.calls[ci];
        const f = this.#factFor(c, set.trips[c.tripRef], set.stops[c.stopRef]);
        if (f && f.seen >= 0) this.#send("cq-prt", `${local} ${f.delay} ${f.seen}`);
      });
      this.#batch("cq-arr", p.arrs.map((ai) => { const a = set.arrs[ai]; return packRow(dRef.get(a.dstRef), a.seq, a.secs, ai); }));
      this.#send("cq-page-end", `${gen} ${n} ${n === pages.length - 1 ? 1 : 0} ${p.truncated || set.truncated ? 1 : 0}`);
    });
    for (const { alt, trip: t, stop: s, call: c } of this.retained()) {
      const f = this.#factFor(c, t, s);
      if (f && f.seen >= 0) this.sentRt.set(alt, `${f.delay} ${f.seen}`);
    }
    return this.state;
  }
  #batch(token, rows) {
    for (let i = 0; i < rows.length;) {
      let v = rows[i++];
      while (i < rows.length && v.length + rows[i].length <= EVENT_BYTES) v += rows[i++];
      this.#send(token, v);
    }
  }
  candidateRealtime(tripRef, delay, seen = this.#now()) {
    const t = this.candidateSet.trips[tripRef];
    for (const x of this.retained()) {
      if (x.trip !== t) continue;
      this.sentRt.set(x.alt, `${delay} ${seen}`);
      this.#send("cq-rt", `${x.alt} ${delay} ${seen}`);
    }
    return this.realtimeEnd(seen);
  }

  #activate({ trip, bseq, aseq }) {
    this.active = new ActiveTrip({ provider: this.transit, tripNo: trip, proj: this.proj, geometry: this.geometry });
    this.activePattern = this.active.pattern;
    const a = this.active.activation(bseq, aseq);
    if (a.boardK < 0 || a.alightK < 0) throw new Error(`trip ${trip} has no call with stop_sequence ${a.boardK < 0 ? bseq : aseq}`);
    const rows = this.active.window({ base: a.boardK, board: a.boardK, target: a.alightK });
    this.heldRows = new Set(rows.map((r) => r.k));
    this.servedWindow = `${a.boardK} ${a.boardK} ${a.alightK}`;
    for (const r of rows) this.#send("jw", ActiveTrip.fact(r).join(" "));
    return this.#send("jt", `${a.trip} ${a.boardK} ${a.alightK} ${a.n}`);
  }

  #serveWindow(w) {
    const rows = this.active.window(w);
    this.servedWindow = `${w.base} ${w.board} ${w.target}`;
    const fresh = rows.filter((r) => !this.heldRows.has(r.k));
    this.heldRows = new Set(rows.map((r) => r.k));
    for (const r of fresh) this.#send("jw", ActiveTrip.fact(r).join(" "));
  }

  #serve() {
    for (let guard = 0; guard < 8 && this.transit; guard++) {
      const q = this.state.request, a = this.state.activate, w = this.state.window;
      if (q && q.gen !== this.answeredQ && this.lastClock) {
        this.answeredQ = q.gen;
        const [oLat, oLon] = this.proj.toLatLon(q.ox, q.oy), [dLat, dLon] = this.proj.toLatLon(q.dx, q.dy);
        this.candidates(this.transit.candidates({
          date: this.lastClock.date, now: this.lastClock.secs, origin: { lat: oLat, lon: oLon }, dest: { lat: dLat, lon: dLon },
          radiusO: q.radiusO, radiusD: q.radiusD, horizon: q.horizon, k: q.k, c: q.c, a: q.a, reach: q.reach,
        }), q.gen);
      } else if (a && `${a.trip}/${a.bseq}/${a.aseq}` !== this.answeredA) {
        this.answeredA = `${a.trip}/${a.bseq}/${a.aseq}`;
        this.#activate(a);
      } else if (w && this.active && `${w.base} ${w.board} ${w.target}` !== this.servedWindow) {
        this.#serveWindow(w);
      } else return;
    }
  }

  #send(token, value) {
    const prev = this.state;
    const record = this.machine.event(token, value);
    if (record === "") return this.state;
    this.record = record;
    this.state = readState(this.record);
    if (!this.state.activate) this.answeredA = "";        // a later choice may ask again
    if (this.activePattern) { this.state.route = this.activePattern.name; this.state.head = this.activePattern.headsign; }
    if (this.effects && this.state.buzz > 0 &&
        (this.state.alert !== prev.alert || this.state.state !== prev.state)) {
      this.effects.alert(this.state.buzz, this.state.alert !== "NONE" ? this.state.alert : this.state.state);
    }
    if (this.depth === 0) {
      this.depth++;
      try { this.#serve(); } finally { this.depth--; }
      this.onRender(this.state);
    }
    return this.state;
  }
}
