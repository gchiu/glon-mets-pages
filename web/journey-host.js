
import { readState } from "./view-model.js";
import { ActiveTrip } from "./transit/active-trip.js";
export { readState };

const MATCH_S = 90;

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

  realtimeStops(max = 8) {
    const set = this.candidateSet, p = this.state.realtime;
    if (!set || !p || p.gen !== set.gen) return [];
    const refs = [...new Set(set.calls.map((c) => c.stopRef))].sort((a, b) => a - b);
    return refs.slice(0, max).map((r) => set.stops[r].stopId);
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
    const set = this.candidateSet;
    if (!set) return;
    set.calls.forEach((c, ref) => {
      const t = set.trips[c.tripRef], s = set.stops[c.stopRef];
      if (!pred(c, t, s)) return;
      const f = this.#factFor(c, t, s);
      if (!f) return;
      const v = `${f.delay} ${f.seen}`, prev = this.sentRt.get(ref);
      if (prev === v || (f.seen < 0 && prev === undefined)) return;
      this.sentRt.set(ref, v);
      this.#send("cq-rt", `${ref} ${v}`);
    });
  }

  candidates(set, gen = 1) {
    const xy = (p) => this.proj.toXY(p.lat, p.lon).join(" ");
    this.candidateSet = { ...set, gen };
    this.sentRt.clear();
    this.#send("cq-begin", `${gen} ${set.truncated ? 1 : 0}`);
    for (const s of set.stops) this.#send("cq-stop", xy(s));
    for (const s of set.dsts) this.#send("cq-dst", xy(s));
    for (const t of set.trips) this.#send("cq-trip", `${t.patNo ?? 0} ${t.dir} ${t.firstArr} ${t.lastArr} ${t.tripNo ?? t.ref}`);
    for (const c of set.calls) this.#send("cq-call", `${c.tripRef} ${c.stopRef} ${c.seq} ${c.secs}`);
    for (const a of set.arrs) this.#send("cq-arr", `${a.dstRef} ${a.seq} ${a.secs}`);
    this.#sendCalls(() => true);                          // known realtime, original observation times
    return this.#send("cq-end", String(gen));
  }
  candidateRealtime(tripRef, delay, seen = this.#now()) {
    this.candidateSet.calls.forEach((c, ref) => {
      if (c.tripRef === tripRef) { this.sentRt.set(ref, `${delay} ${seen}`); this.#send("cq-rt", `${ref} ${delay} ${seen}`); }
    });
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
          radiusO: q.radiusO, radiusD: q.radiusD, horizon: q.horizon,
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
    this.record = this.machine.event(token, value);
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
