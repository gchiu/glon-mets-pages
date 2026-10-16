
import { SimulatedLocationProvider } from "../location/location-providers.js";
import { SimClock, hms } from "../clock.js";
import { metresBetween } from "../geo.js";

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const lerp = (a, b, f) => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];

export class BusRun {
  constructor(transit, tripNo) {
    this.tripNo = tripNo;
    this.patNo = transit.tripPattern(tripNo);
    this.shape = transit.rawShape(this.patNo);
    this.stops = transit.pattern(this.patNo).stops;
    const delay = transit.delayFor(tripNo);
    const times = transit.tripTimes(tripNo);
    this.times = this.stops.map((st, k) => {
      const depart = times[k].dep + delay;
      const gap = k === 0 ? 120 : times[k].dep - times[k - 1].dep;
      const dwell = k === 0 ? 30 : Math.max(5, Math.min(15, Math.round(gap / 5)));
      return { arrive: depart - dwell, depart, s: st.dist_m };
    });
  }
  at(s) {
    const p = this.shape;
    if (s <= p[0][2]) return [p[0][0], p[0][1]];
    let lo = 0, hi = p.length - 1;
    if (s >= p[hi][2]) return [p[hi][0], p[hi][1]];
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (p[m][2] <= s) lo = m; else hi = m; }
    return lerp(p[lo], p[hi], (s - p[lo][2]) / Math.max(1e-9, p[hi][2] - p[lo][2]));
  }
  s(t) {
    const ts = this.times;
    if (t <= ts[0].depart) return ts[0].s;
    for (let k = 0; k < ts.length - 1; k++) {
      const a = ts[k], b = ts[k + 1];
      if (t < b.arrive) return a.s + (b.s - a.s) * Math.max(0, (t - a.depart) / Math.max(1, b.arrive - a.depart));
      if (t <= b.depart) return b.s;
    }
    return ts[ts.length - 1].s;
  }
  stopIndex(stopId) { return this.stops.findIndex((s) => s.stopId === stopId); }
}

export class JourneySimulation {
  constructor({ scenario, transit, host, favourites = [] }) {
    this.sc = scenario;
    this.destIndex = favourites.findIndex((f) => f.id === scenario.destId);
    if (this.destIndex < 0) throw new Error(`scenario destination ${scenario.destId} is not in the profile`);
    this.transit = transit;
    this.host = host;
    this.t = hms(scenario.startAt);
    this.end = this.t + (scenario.maxSeconds || 3 * 3600);
    this.rand = rng(scenario.seed || 1);
    this.clock = new SimClock({ date: scenario.date, weekday: scenario.weekday });
    this.location = new SimulatedLocationProvider((t) => this.fixAt(t));
    this.pos = [scenario.origin.lat, scenario.origin.lon];
    this.phase = "HOME";
    this.run = null;       // the bus being ridden
    this.bus = null;       // its stop times (for tests)
  }

  get view() { return this.host.state; }
  appStop(k) { return this.host.activePattern && k >= 0 ? this.host.activePattern.stops[k] : null; }

  act(t) {
    const sc = this.sc, v = this.view, speed = sc.walkSpeed || 1.2;
    const walkTo = ([la, lo]) => {
      const d = metresBetween(this.pos[0], this.pos[1], la, lo);
      this.pos = d <= speed ? [la, lo] : lerp(this.pos, [la, lo], speed / d);
      return d <= speed;
    };
    switch (this.phase) {
      case "HOME": {
        const go = sc.leaveAt ? t >= hms(sc.leaveAt)
          : (v.leave === "LEAVE_NOW" || v.leave === "WAIT" || v.leave === "WALK" || v.state === "WALKING_FINAL");
        if (go && v.state !== "JOURNEY_PROPOSED" && v.state !== "DESTINATION_SELECTED") {
          this.leaveAt = t;
          this.phase = v.walkOnly || v.state === "WALKING_FINAL" ? "TO_DEST" : "TO_STOP";
        }
        break;
      }
      case "TO_STOP": {
        const stop = this.appStop(v.board);
        if (stop && walkTo([stop.lat, stop.lon])) { this.phase = "AT_STOP"; this.atStop = t; this.boardStopId = stop.stopId; }
        break;
      }
      case "AT_STOP": {
        const stop = this.appStop(v.board);
        if (stop && stop.stopId !== this.boardStopId) { this.phase = "TO_STOP"; break; }   // the app re-planned
        if (!v.option) break;
        if (!this.pending || this.pending.tripNo !== v.option.trip) this.pending = new BusRun(this.transit, v.option.trip);
        const k = this.pending.stopIndex(this.boardStopId);
        if (k >= 0 && t >= this.pending.times[k].depart) {
          if (t - this.pending.times[k].depart <= 2) {               // the bus is here: board it
            this.run = this.pending; this.bus = this.run.times; this.boardAt = t; this.boardIdx = k;
            const target = sc.alightStopId ? this.run.stopIndex(sc.alightStopId) : this.host.state.bus ? this.host.state.bus.alight : v.alight;
            this.alightIdx = target;
            this.phase = "RIDING";
          }                                                          // else: missed it, keep waiting for the app
        }
        break;
      }
      case "RIDING": {
        if (!sc.alightStopId && this.view.bus) this.alightIdx = this.view.bus.alight;   // follow re-targeting
        this.pos = this.run.at(this.run.s(t));
        if (t >= this.run.times[this.alightIdx].arrive + 5) {
          this.alightAt = t;
          this.phase = "TO_DEST";
          const off = this.run.stops[this.alightIdx];
          this.arriveAt = t + metresBetween(off.lat, off.lon, sc.dest.lat, sc.dest.lon) / speed;
        }
        break;
      }
      case "TO_DEST":
        if (walkTo([sc.dest.lat, sc.dest.lon])) { this.phase = "AT_DEST"; this.arrivedAt = t; }
        break;
      default:
        break;
    }
  }

  trueS(t) { return this.phase === "RIDING" && this.run ? this.run.s(t) : null; }

  fixAt() {
    const [lat, lon] = this.pos;
    const sd = this.sc.noiseM || 0;
    if (!sd) return { lat, lon, accuracy: 8 };
    const g = () => Math.sqrt(-2 * Math.log(1 - this.rand())) * Math.cos(2 * Math.PI * this.rand());
    const dy = g() * sd, dx = g() * sd;
    return { lat: lat + dy / 111195, lon: lon + dx / (111195 * Math.cos(lat * Math.PI / 180)), accuracy: Math.round(sd * 1.5) };
  }

  begin() {
    this.clock.start((time) => this.host.clock(time));
    this.location.start((fix) => this.host.position(fix));
    this.transit.start(this.host);
    this.clock.advance(this.t);
    this.transit.tick(this.t);
    this.location.advance(this.t);
    if (this.sc.autoTap !== false) this.host.command("choose", String(this.destIndex));
  }

  step() {
    this.t += 1;
    const sc = this.sc;
    this.clock.advance(this.t);
    if (sc.dropRealtimeAt && this.t === hms(sc.dropRealtimeAt)) this.transit.dropRealtime();
    this.transit.tick(this.t);
    if (sc.autoTap !== false && this.t === hms(sc.startAt) + (sc.acceptAfter || 5)) this.host.command("accept");
    this.act(this.t);
    this.location.advance(this.t);
    return this.host.state;
  }

  done() { return this.host.state.state === "ARRIVED" || this.t >= this.end; }
}
