import { checkCatalogue, checkPackage, loadNetwork, NetworkError } from "./gtfs/network.js";

export const ROUTES_KEY = "dd-routes-v1";
export const NETWORK_CACHE = "glon-mets-network-v1";

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export class NetworkStore {
  constructor({ base = "network/", fetch = (...a) => globalThis.fetch(...a), caches = globalThis.caches,
    storage = globalThis.localStorage, subtle = globalThis.crypto && globalThis.crypto.subtle } = {}) {
    this.base = base;
    this.fetch = fetch;
    this.caches = caches;
    this.storage = storage;
    this.subtle = subtle;
    this.memory = new Map();            // used only where Cache Storage is unavailable
    this.downloaded = 0;                // bytes fetched from the network by this store (measurement)
  }

  selection() {
    let raw = null;
    try { raw = this.storage ? this.storage.getItem(ROUTES_KEY) : null; } catch { raw = null; }
    try {
      const d = raw && JSON.parse(raw);
      if (d && d.v === 1 && typeof d.feed === "string" && Array.isArray(d.routes) &&
          d.routes.every((r) => r && typeof r.routeId === "string" && typeof r.file === "string" && /^[0-9a-f]{64}$/.test(r.sha256))) return d;
    } catch { /* unreadable: treated as nothing installed */ }
    return { v: 1, feed: "", routes: [] };
  }
  #save(sel) { try { this.storage.setItem(ROUTES_KEY, JSON.stringify(sel)); } catch { /* kept for this session only */ } }

  #url(name) { return this.base + name; }
  async #put(name, text) {
    if (!this.caches) { this.memory.set(name, text); return; }
    const c = await this.caches.open(NETWORK_CACHE);
    await c.put(this.#url(name), new Response(text, { headers: { "Content-Type": "application/json" } }));
  }
  async #get(name) {
    if (!this.caches) return this.memory.has(name) ? this.memory.get(name) : null;
    const c = await this.caches.open(NETWORK_CACHE);
    const r = await c.match(this.#url(name));
    return r ? r.text() : null;
  }
  async #drop(name) {
    if (!this.caches) { this.memory.delete(name); return; }
    const c = await this.caches.open(NETWORK_CACHE);
    await c.delete(this.#url(name));
  }
  async #download(name) {
    const r = await this.fetch(this.#url(name), { cache: "no-store" });
    if (!r.ok) throw new NetworkError(`${name}: HTTP ${r.status}`);
    const text = await r.text();
    this.downloaded += text.length;
    return text;
  }
  async #sha256(text) { return hex(await this.subtle.digest("SHA-256", new TextEncoder().encode(text))); }

  async latestCatalogue() {
    try {
      const text = await this.#download("catalogue.json");
      const cat = checkCatalogue(JSON.parse(text));
      await this.#put("catalogue.json", text);
      return { catalogue: cat, offline: false };
    } catch (err) {
      for (const name of ["catalogue.json", "installed/catalogue.json"]) {
        const text = await this.#get(name);
        if (text) return { catalogue: checkCatalogue(JSON.parse(text)), offline: true };
      }
      throw err instanceof NetworkError ? err : new NetworkError("The route list could not be downloaded. Check the connection and try again.");
    }
  }
  async installedCatalogue() {
    const text = await this.#get("installed/catalogue.json");
    return text ? checkCatalogue(JSON.parse(text)) : null;
  }

  async #package(cat, routeId) {
    const m = cat.packages[routeId];
    if (!m) throw new NetworkError(`route ${routeId} is not in the timetable`);
    let text = await this.#get(m.file), fresh = false;
    if (text === null) { text = await this.#download(m.file); fresh = true; }
    if (await this.#sha256(text) !== m.sha256) {
      if (!fresh) await this.#drop(m.file);
      throw new NetworkError(`route ${routeId}: the downloaded timetable does not match the catalogue`);
    }
    return { routeId, file: m.file, sha256: m.sha256, text, pkg: checkPackage(cat, JSON.parse(text)) };
  }

  async install(routeIds, cat) {
    checkCatalogue(cat);
    const ids = [...new Set(routeIds)];
    if (!ids.length) throw new NetworkError("Choose at least one route.");
    const got = [];
    for (const id of ids) got.push(await this.#package(cat, id));   // throws before anything changes
    for (const g of got) await this.#put(g.file, g.text);
    await this.#put("installed/catalogue.json", JSON.stringify(cat));
    const before = this.selection();
    const sel = { v: 1, feed: cat.feed.id, routes: got.map(({ routeId, file, sha256 }) => ({ routeId, file, sha256 })) };
    this.#save(sel);
    const keep = new Set(sel.routes.map((r) => r.file));
    for (const r of before.routes) if (!keep.has(r.file)) await this.#drop(r.file);
    return sel;
  }
  async add(routeIds, cat) { return this.install([...this.selection().routes.map((r) => r.routeId), ...routeIds], cat); }
  async remove(routeId) {
    const sel = this.selection(), left = sel.routes.filter((r) => r.routeId !== routeId);
    if (left.length === sel.routes.length) return sel;
    if (!left.length) throw new NetworkError("Keep at least one route.");
    const next = { ...sel, routes: left };
    this.#save(next);
    for (const r of sel.routes) if (r.routeId === routeId && !left.some((x) => x.file === r.file)) await this.#drop(r.file);
    return next;
  }

  async loadIndex() {
    const sel = this.selection();
    if (!sel.routes.length) return null;
    const cat = await this.installedCatalogue();
    if (!cat || cat.feed.id !== sel.feed) throw new NetworkError("The installed timetable is incomplete. Choose your routes again.");
    const pkgs = [];
    for (const r of sel.routes) {
      const p = await this.#package(cat, r.routeId);
      if (p.sha256 !== r.sha256) throw new NetworkError(`route ${r.routeId}: installed timetable does not match its record`);
      await this.#put(p.file, p.text);                                // re-kept if it had to be fetched again
      pkgs.push(p.pkg);
    }
    return { index: loadNetwork(cat, pkgs), catalogue: cat, selection: sel };
  }

  async loadRoutes(cat, routeIds) {
    const pkgs = [];
    for (const id of routeIds) {
      const m = cat.packages[id];
      if (!m) throw new NetworkError(`route ${id} is not in the timetable`);
      const text = await this.#download(m.file);
      if (await this.#sha256(text) !== m.sha256) throw new NetworkError(`route ${id}: the downloaded timetable does not match the catalogue`);
      pkgs.push(JSON.parse(text));
    }
    return loadNetwork(cat, pkgs);
  }

  updateStatus(latest) {
    const sel = this.selection();
    if (!sel.routes.length || !latest) return { current: true, feedChanged: false, changed: [], withdrawn: [] };
    const withdrawn = sel.routes.filter((r) => !latest.packages[r.routeId]).map((r) => r.routeId);
    const changed = sel.routes.filter((r) => latest.packages[r.routeId] && latest.packages[r.routeId].sha256 !== r.sha256).map((r) => r.routeId);
    const feedChanged = latest.feed.id !== sel.feed;
    return { current: !feedChanged && !changed.length && !withdrawn.length, feedChanged, changed, withdrawn, feed: latest.feed };
  }
  async update(latest) {
    const ids = this.selection().routes.map((r) => r.routeId).filter((id) => latest.packages[id]);
    return this.install(ids, latest);
  }
}
