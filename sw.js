const VERSION = "dd-u1-sw2";
const OWN = (k) => k.startsWith("dd-");
const SHELL = [
  "./", "index.html", "manifest.webmanifest",
  "web/style.css", "web/icon.svg", "web/app.js", "web/boot.js", "web/glon-machine.js", "web/glon-data.js",
  "web/geo.js", "web/clock.js", "web/journey-host.js", "web/view-model.js", "web/ui.js", "web/effects.js",
  "web/location/location-providers.js", "web/transit/gtfs-transit.js", "web/transit/candidates.js",
  "web/transit/metlink-realtime.js", "web/realtime-settings.js", "web/transit/active-trip.js", "web/transit/route-measure.js",
  "web/gtfs/gtfs-index.js", "web/startup.js", "web/places.js", "config/landmarks.json",
  "web/sim/journey-sim.js", "web/sim/scenarios.js",
  "vendor/glon/glon-kaka.wasm", "vendor/glon/prelude.glon", "vendor/glon/strings.glon", "vendor/glon/kaka-lib-subset.glon",
  "glon/dd-support.glon", "glon/route-match.glon", "glon/fare.glon", "glon/journey.glon", "glon/candidates.glon", "glon/view.glon", "glon/app.glon",
  "config/profile.json", "config/region.json", "config/journey-config.glon", "config/fare-policy.glon",
  "fixtures/route21/realtime.json",
  ...["feed_info", "routes", "trips", "stop_times", "stops", "shapes", "calendar", "calendar_dates"]
    .map((f) => "fixtures/gtfs-wellington/" + f + ".txt"),
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION)
    .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  const activated = (async () => {
    const old = (await caches.keys()).filter((k) => OWN(k) && k !== VERSION);
    await Promise.all(old.map((k) => caches.delete(k)));
    await self.clients.claim();
    return old.length > 0;
  })();
  e.waitUntil(activated);
  activated.then(async (upgraded) => {
    if (!upgraded) return;
    for (const w of await self.clients.matchAll({ type: "window" })) w.navigate(w.url).catch(() => {});
  });
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;   // never cache third-party APIs
  if (url.pathname.endsWith("/config/api-key.txt")) return;                         // the local realtime key: never cached
  e.respondWith((async () => {
    try {
      const res = await fetch(e.request, { cache: "no-store" });
      if (res.ok && res.type === "basic") {
        const copy = res.clone();
        e.waitUntil(caches.open(VERSION).then((c) => c.put(e.request, copy)));
      }
      return res;
    } catch (err) {
      const hit = await caches.match(e.request);
      if (hit) return hit;
      throw err;
    }
  })());
});

self.addEventListener("message", (e) => {
  if (e.data === "version" && e.source) e.source.postMessage({ version: VERSION });
});
