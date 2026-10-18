
export const WELLINGTON = { west: 174.55, north: -40.65, east: 176.30, south: -41.65 };   // Greater Wellington region
export const MIN_GAP_MS = 1100;
export const MAX_RESULTS = 5;
export const TIMEOUT_MS = 8000;
export const ATTRIBUTION = "Place search © OpenStreetMap contributors";

export class SearchUnavailable extends Error {}

const inRegion = (lat, lon, r = WELLINGTON) => lat <= r.north && lat >= r.south && lon >= r.west && lon <= r.east;
const clean = (s) => String(s == null ? "" : s).replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();

export function describe(x) {
  const a = x.address || {};
  const street = clean([a.house_number, a.road || a.pedestrian || a.footway].filter(Boolean).join(" "));
  const area = clean(a.suburb || a.neighbourhood || a.quarter || a.village || a.hamlet || "");
  const town = clean(a.city || a.town || a.municipality || "");
  const name = clean(x.name) || street || clean(String(x.display_name || "").split(",")[0]);
  const detail = [street !== name ? street : "", area, town !== area ? town : ""].filter(Boolean).join(", ");
  return { name: name.slice(0, 60), detail: detail.slice(0, 90), lat: Number(x.lat), lon: Number(x.lon) };
}

export function appUrl(loc = globalThis.location) {
  return loc && /^https?:$/.test(loc.protocol) ? loc.origin + loc.pathname : undefined;
}

export class NominatimGeocoder {
  constructor({ fetchImpl = globalThis.fetch && globalThis.fetch.bind(globalThis), now = () => Date.now(),
                sleep = (ms) => new Promise((r) => setTimeout(r, ms)), base = "https://nominatim.openstreetmap.org/search",
                region = WELLINGTON, referrer = appUrl() } = {}) {
    Object.assign(this, { fetchImpl, now, sleep, base, region, referrer });
    this.cache = new Map();     // query -> results, this session only
    this.last = -Infinity;      // when the previous request was sent
  }

  url(query) {
    const r = this.region, p = new URLSearchParams({
      q: query, format: "jsonv2", addressdetails: "1", limit: String(MAX_RESULTS + 3),
      countrycodes: "nz", viewbox: `${r.west},${r.north},${r.east},${r.south}`, bounded: "1", "accept-language": "en",
    });
    return `${this.base}?${p}`;
  }

  async search(text) {
    const query = clean(text).slice(0, 120);
    if (query.length < 3) return [];
    const key = query.toLowerCase();
    if (this.cache.has(key)) return this.cache.get(key);
    if (!this.fetchImpl) throw new SearchUnavailable("no network");
    const wait = this.last + MIN_GAP_MS - this.now();
    if (wait > 0) await this.sleep(wait);
    this.last = this.now();
    const ctl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), TIMEOUT_MS) : null;
    let rows;
    try {
      const res = await this.fetchImpl(this.url(query), {
        method: "GET", credentials: "omit", cache: "no-store", headers: { Accept: "application/json" },
        ...(this.referrer ? { referrer: this.referrer, referrerPolicy: "no-referrer-when-downgrade" } : {}),
        ...(ctl ? { signal: ctl.signal } : {}),
      });
      if (!res || !res.ok) throw new SearchUnavailable("status " + (res && res.status));
      rows = await res.json();
      if (!Array.isArray(rows)) throw new SearchUnavailable("unexpected answer");
    } catch (e) {
      throw e instanceof SearchUnavailable ? e : new SearchUnavailable("request failed");
    } finally {
      if (timer) clearTimeout(timer);
    }
    const seen = new Set(), out = [];
    for (const x of rows) {
      const d = describe(x);
      if (!d.name || !Number.isFinite(d.lat) || !Number.isFinite(d.lon) || !inRegion(d.lat, d.lon, this.region)) continue;
      const k = `${d.name}|${d.detail}`.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(d);
      if (out.length >= MAX_RESULTS) break;
    }
    this.cache.set(key, out);
    return out;
  }
}
