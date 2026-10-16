
import { MetlinkStopPredictions } from "./transit/metlink-realtime.js";

export const LOCAL_KEY_FILE = "config/api-key.txt";
export const BROWSER_KEY = "dd-metlink-key";
const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|\[::1\]|[\w-]+\.localhost)$/;
export const isLocalHost = (h) => !!h && LOCAL_HOSTS.test(h);

export function browserKeyStore(storage = globalThis.localStorage) {
  return {
    get() { try { return cleanKey(storage.getItem(BROWSER_KEY)); } catch { return null; } },
    set(k) { try { storage.setItem(BROWSER_KEY, k); return true; } catch { return false; } },
    clear() { try { storage.removeItem(BROWSER_KEY); } catch { /* nothing stored */ } },
  };
}

export class RealtimeKeys {
  constructor({ hostname = globalThis.location && globalThis.location.hostname, fetchImpl = globalThis.fetch,
                storage, makeClient = (apiKey) => new MetlinkStopPredictions({ apiKey, fetchImpl }),
                onChange = () => {} } = {}) {
    this.hostname = hostname; this.fetchImpl = fetchImpl; this.store = browserKeyStore(storage);
    this.makeClient = makeClient; this.onChange = onChange;
    this.client = null; this.source = null;
    this.view = { panel: "setup", message: SETUP_TEXT };
  }
  #set(panel, message, client = this.client, source = this.source) {
    this.client = client; this.source = client ? source : null; this.view = { panel, message };
    this.onChange(this.view);
    return this.view;
  }

  async init() {
    const local = await loadLocalKey({ hostname: this.hostname, fetchImpl: this.fetchImpl });
    if (local) return this.#set("local", "Realtime connected · local development key", this.makeClient(local), "local-file");
    const saved = this.store.get();
    if (saved) return this.#set("connected", "Realtime connected", this.makeClient(saved), "browser");
    return this.#set("setup", SETUP_TEXT, null);
  }

  async save(input) {
    const k = cleanKey(input);
    if (!k) return this.#set(this.view.panel === "replace" ? "replace" : "setup", "Enter your Metlink API key.");
    if (!this.store.set(k)) return this.#set(this.view.panel, "This browser will not store the key (private window or blocked storage).");
    const client = this.makeClient(k);
    const r = await client.verify();
    if (r.ok) return this.#set("connected", "Realtime connected", client, "browser");
    if (r.auth || r.error === "network") {
      this.store.clear();
      return this.#set("rejected", r.auth ? "API key not accepted"
        : "API key not accepted (or Metlink could not be reached) · check the key and try again", null);
    }
    return this.#set("unverified", `Key saved · Metlink could not be reached (${r.error}) · will retry`, client, "browser");
  }

  replace() { return this.#set("replace", "Enter a new Metlink API key."); }
  cancelReplace() { return this.#set(this.client ? (this.source === "local-file" ? "local" : "connected") : "setup", this.client ? "Realtime connected" : SETUP_TEXT); }
  forget() { this.store.clear(); return this.#set("setup", SETUP_TEXT, null); }
}
export const SETUP_TEXT = "Enter your Metlink API key to enable live bus times.";

export async function loadLocalKey({ hostname = globalThis.location && globalThis.location.hostname, fetchImpl = globalThis.fetch } = {}) {
  if (!hostname || !LOCAL_HOSTS.test(hostname)) return null;
  try {
    const r = await fetchImpl(LOCAL_KEY_FILE, { cache: "no-store" });
    return r.ok ? cleanKey(await r.text()) : null;
  } catch { return null; }
}

export function cleanKey(s) {
  const k = String(s || "").trim();
  return k && /^[\x21-\x7e]{8,200}$/.test(k) ? k : null;
}

const hhmm = (s) => `${String(Math.floor(s / 3600) % 24).padStart(2, "0")}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}`;

export function statusText(st, hasKey, nowSecs) {
  if (!hasKey) return "Not connected · no realtime key · scheduled times only";
  switch (st && st.state) {
    case "live": return `Live · ${st.stops} stop${st.stops === 1 ? "" : "s"} · updated ${Math.max(0, nowSecs - st.lastOk)} s ago${st.detail ? " · " + st.detail : ""}`;
    case "error": return `Live data unavailable (${st.detail}) · scheduled times stand`;
    case "auth": return `Key refused (${st.detail}) · check the key · scheduled times only`;
    case "waiting": return "Realtime ready · connects when a journey needs live times";
    default: return "Realtime ready";
  }
}

export function stopCheckRows(facts, index) {
  return facts.map((f) => {
    const rows = index && index.tripTimes.get(f.tripId);
    const call = rows && rows.find((r) => r.stopId === f.stopId && Math.abs(r.dep - f.aimed) <= 90);
    return {
      route: f.route, headsign: f.headsign, aimed: hhmm(f.aimed),
      expected: f.expected != null ? hhmm(f.expected) : "—",
      live: f.live, delay: f.delay,
      gtfs: call ? `${f.tripId} (GTFS ${hhmm(call.dep)})` : rows ? "trip found, time differs" : "not in GTFS subset",
      matched: !!call,
    };
  });
}
