
import { readState } from "./view-model.js";
import { patternSource } from "./glon-data.js";
export { readState };

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
    this.delays = new Map();          // latest realtime delay per tripNo (facts already sent)
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
  realtime({ trip, delay }) {
    this.delays.set(trip, delay);
    const ref = this.candidateSet ? this.candidateSet.trips.findIndex((t) => t.tripNo === trip) : -1;
    if (ref >= 0) this.#send("cq-rt", `${ref} ${delay}`);
    return this.#send("rt", `${trip} ${delay}`);
  }
  realtimeLost() {
    this.delays.clear();
    this.#send("cq-rt-lost");
    return this.#send("rt-lost");
  }
  command(name, value) { return this.#send(name, value); }

  candidates(set, gen = 1) {
    const xy = (p) => this.proj.toXY(p.lat, p.lon).join(" ");
    this.candidateSet = { ...set, gen };
    this.#send("cq-begin", `${gen} ${set.truncated ? 1 : 0}`);
    for (const s of set.stops) this.#send("cq-stop", xy(s));
    for (const s of set.dsts) this.#send("cq-dst", xy(s));
    for (const t of set.trips) this.#send("cq-trip", `${t.patNo ?? 0} ${t.dir} ${t.firstArr} ${t.lastArr} ${t.tripNo ?? t.ref}`);
    for (const c of set.calls) this.#send("cq-call", `${c.tripRef} ${c.stopRef} ${c.seq} ${c.secs}`);
    for (const a of set.arrs) this.#send("cq-arr", `${a.dstRef} ${a.seq} ${a.secs}`);
    set.trips.forEach((t, ref) => { if (this.delays.has(t.tripNo)) this.#send("cq-rt", `${ref} ${this.delays.get(t.tripNo)}`); });
    return this.#send("cq-end", String(gen));
  }
  candidateRealtime(tripRef, delay) { return this.#send("cq-rt", `${tripRef} ${delay}`); }

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
