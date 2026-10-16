
import { readState } from "./view-model.js";
import { patternSource } from "./glon-data.js";
export { readState };

const MATCH_S = 90;

export class JourneyHost {
  constructor(machine, proj, { onRender = () => {}, effects = null, transit = null } = {}) {
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
    this.loadedPatterns = new Set();  // patterns glon_load-ed this session (never twice)
    this.activePattern = null;        // the pattern of Glon's chosen trip (for names)
    this.answeredQ = -1;
    this.answeredG = "";
    this.depth = 0;
  }

  position({ lat, lon, accuracy = 10 }) {
    const [x, y] = this.proj.toXY(lat, lon);
    return this.#send("fix", `${x} ${y} ${Math.max(0, Math.round(accuracy))}`);
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

  #loadTrip(patNo, tripNo) {
    const p = this.transit.pattern(patNo);
    if (!this.loadedPatterns.has(patNo)) {
      this.machine.load(patternSource(p, this.proj), `pattern ${patNo}`);
      this.loadedPatterns.add(patNo);
    }
    const times = this.transit.tripTimes(tripNo);
    this.#send("trip-begin", `${tripNo} ${patNo}`);
    for (let k = 0; k < times.length; k += 7) this.#send("trip-times", [k, ...times.slice(k, k + 7).map((t) => t.dep)].join(" "));
    this.activePattern = p;
    return this.#send("trip-ready", String(tripNo));
  }

  #serve() {
    for (let guard = 0; guard < 8 && this.transit; guard++) {
      const q = this.state.request, g = this.state.need;
      if (q && q.gen !== this.answeredQ && this.lastClock) {
        this.answeredQ = q.gen;
        const [oLat, oLon] = this.proj.toLatLon(q.ox, q.oy), [dLat, dLon] = this.proj.toLatLon(q.dx, q.dy);
        this.candidates(this.transit.candidates({
          date: this.lastClock.date, now: this.lastClock.secs, origin: { lat: oLat, lon: oLon }, dest: { lat: dLat, lon: dLon },
          radiusO: q.radiusO, radiusD: q.radiusD, horizon: q.horizon,
        }), q.gen);
      } else if (g && `${g.pat}/${g.trip}` !== this.answeredG) {
        this.answeredG = `${g.pat}/${g.trip}`;
        this.#loadTrip(g.pat, g.trip);
      } else return;
    }
  }

  #send(token, value) {
    const prev = this.state;
    this.record = this.machine.event(token, value);
    this.state = readState(this.record);
    if (!this.state.need) this.answeredG = "";            // a later choice may ask again
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
