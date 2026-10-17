
export const PLACES_KEY = "dd-places-v1";
export const PLACES_VERSION = 1;
export const NAME_MAX = 60;

const isCoord = (v, lim) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= lim;

export function cleanName(name) {
  const s = String(name == null ? "" : name).replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
  return s.slice(0, NAME_MAX);
}

function validPlace(p) {
  return p && typeof p === "object" && typeof p.id === "string" && /^p-[\w-]{1,40}$/.test(p.id) &&
    typeof p.name === "string" && cleanName(p.name).length > 0 && isCoord(p.lat, 90) && isCoord(p.lon, 180);
}

export function catalogue(data) {
  const list = (data && Array.isArray(data.landmarks) ? data.landmarks : [])
    .filter((l) => l && typeof l.id === "string" && typeof l.name === "string" && isCoord(l.lat, 90) && isCoord(l.lon, 180));
  const builtIn = list.find((l) => l.default) || null;
  return {
    builtIn,
    search(query) {
      const words = cleanName(query).toLowerCase().split(" ").filter(Boolean);
      return list.filter((l) => l !== builtIn && words.every((w) => l.name.toLowerCase().includes(w)));
    },
    byId: (id) => list.find((l) => l.id === id) || null,
  };
}

export class MyPlaces {
  constructor(storage = globalThis.localStorage) {
    this.storage = storage;
    this.places = [];
    this.recovered = false;    // the stored value was unreadable or of another version, and was ignored
    this.load();
  }

  load() {
    let raw = null;
    try { raw = this.storage ? this.storage.getItem(PLACES_KEY) : null; } catch { raw = null; }
    this.places = [];
    this.recovered = false;
    if (raw == null) return this.places;
    try {
      const doc = JSON.parse(raw);
      if (!doc || doc.v !== PLACES_VERSION || !Array.isArray(doc.places)) throw new Error("schema");
      const seen = new Set();
      for (const p of doc.places) {
        if (!validPlace(p) || seen.has(p.id)) { this.recovered = true; continue; }
        seen.add(p.id);
        this.places.push({ id: p.id, name: cleanName(p.name), lat: p.lat, lon: p.lon,
          ...(typeof p.landmark === "string" ? { landmark: p.landmark } : {}) });
      }
    } catch { this.places = []; this.recovered = true; }
    return this.places;
  }

  #save() {
    try {
      this.storage.setItem(PLACES_KEY, JSON.stringify({ v: PLACES_VERSION, places: this.places }));
      return true;
    } catch { return false; }
  }

  #newId() {
    let id;
    do { id = "p-" + Math.random().toString(36).slice(2, 10); } while (this.places.some((p) => p.id === id));
    return id;
  }

  get(id) { return this.places.find((p) => p.id === id) || null; }

  addHere(name, fix) {
    const n = cleanName(name);
    if (!n) throw new Error("Give the place a name.");
    if (!fix || !isCoord(fix.lat, 90) || !isCoord(fix.lon, 180)) throw new Error("Your location is not known yet.");
    const p = { id: this.#newId(), name: n, lat: fix.lat, lon: fix.lon };
    this.places.push(p);
    this.#save();
    return p;
  }

  addLandmark(l) {
    if (!l || !isCoord(l.lat, 90) || !isCoord(l.lon, 180)) throw new Error("Unknown landmark.");
    const have = this.places.find((p) => p.landmark === l.id);
    if (have) return have;
    const p = { id: this.#newId(), name: cleanName(l.name), lat: l.lat, lon: l.lon, landmark: l.id };
    this.places.push(p);
    this.#save();
    return p;
  }

  rename(id, name) {
    const p = this.get(id), n = cleanName(name);
    if (!p) throw new Error("No such place.");
    if (!n) throw new Error("Give the place a name.");
    p.name = n;
    this.#save();
    return p;
  }

  remove(id) {
    const before = this.places.length;
    this.places = this.places.filter((p) => p.id !== id);
    if (this.places.length !== before) this.#save();
    return this.places.length !== before;
  }
}

export const PLACE_SLOT = 1;
export function passengerProfile(profile, builtIn) {
  return { ...profile, favourites: [
    { id: builtIn.id, name: builtIn.name, lat: builtIn.lat, lon: builtIn.lon },
    { id: "my-place", name: "", lat: null, lon: null },
  ] };
}
