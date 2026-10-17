
const KARORI_START = { lat: -41.28410, lon: 174.73600 };            // ~170 m from Karori Mall stop
const AT_4385 = { lat: -41.28753813, lon: 174.7475018 };           // stop 4385's published position (GTFS stops.txt)
const TE_PAPA = { lat: -41.29060, lon: 174.78210 };                // public landmark (favourite id "te-papa")
const TOWN = { lat: -41.29130, lon: 174.77545 };                   // public landmark (favourite id "town")
const JOHNSONVILLE_START = { lat: -41.22300, lon: 174.80480 };      // near Johnsonville station (public)
const LAMBTON_QUAY = { lat: -41.28420, lon: 174.77505 };            // public landmark (favourite id "lambton-quay")
const JOHNSONVILLE = { lat: -41.22330, lon: 174.80570 };            // public landmark (favourite id "johnsonville")

const BASE = { date: 20261015, weekday: 4, startAt: "08:56:00", walkSpeed: 1.2, noiseM: 0, seed: 1 };

export const SCENARIOS = {
  "duthie-te-papa": {
    ...BASE, title: "Demo: Route 21 from stop 4385 (reference point) → Te Papa",
    origin: AT_4385, destId: "te-papa", dest: TE_PAPA,
  },
  "route21-te-papa": {
    ...BASE, title: "Demo: Route 21 from near Karori Mall → Te Papa",
    origin: KARORI_START, destId: "te-papa", dest: TE_PAPA,
  },
  "route21-town": {
    ...BASE, title: "Demo: Route 21 from near Karori Mall → Cuba Mall", seed: 2,
    origin: KARORI_START, destId: "town", dest: TOWN,
  },
  "route24-lambton": {
    ...BASE, title: "Demo: Route 24 from Johnsonville → Lambton Quay", seed: 3,
    origin: JOHNSONVILLE_START, destId: "lambton-quay", dest: LAMBTON_QUAY,
  },
  "route24-johnsonville": {
    ...BASE, title: "Demo: Route 24 from Lambton Quay → Johnsonville", seed: 4,
    origin: LAMBTON_QUAY, destId: "johnsonville", dest: JOHNSONVILLE,
  },
};

export function scenario(name, overrides = {}) {
  const s = SCENARIOS[name];
  if (!s) throw new Error("unknown scenario " + name);
  return { ...s, ...overrides };
}
