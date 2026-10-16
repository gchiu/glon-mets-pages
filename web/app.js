
import { bootJourneyApp } from "./boot.js";
import { JourneyHost } from "./journey-host.js";
import { renderView } from "./ui.js";
import { PlatformEffects } from "./effects.js";
import { GtfsIndex, GTFS_FILES } from "./gtfs/gtfs-index.js";
import { GtfsTransitProvider } from "./transit/gtfs-transit.js";
import { BrowserLocationProvider } from "./location/location-providers.js";
import { SystemClock } from "./clock.js";
import { JourneySimulation } from "./sim/journey-sim.js";
import { SCENARIOS, scenario } from "./sim/scenarios.js";

const $ = (s) => document.querySelector(s);
const readText = (p) => fetch(p).then((r) => { if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`); return r.text(); });
const readBytes = (p) => fetch(p).then((r) => { if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`); return r.arrayBuffer(); });
const readJson = (p) => readText(p).then(JSON.parse);

const effects = new PlatformEffects();
let session = null;     // { host, stop() }
let gtfsIndex = null;   // built once per page from the Route 21 GTFS subset

const namesFor = (host, profile) => ({
  stops: host && host.activePattern ? host.activePattern.stops.map((s) => s.name) : [],
  dests: profile.favourites.map((f) => f.name),
});

function paint(state, names) {
  const { body, acts } = renderView(state, names);
  for (const [el, html] of [[$("#vb"), body], [$("#va"), acts]]) {
    if (el.dataset.last !== html) { el.innerHTML = html; el.dataset.last = html; }
  }
  $("#view").dataset.state = state.state;
}

async function start(mode) {
  if (session) session.stop();
  $("#vb").innerHTML = "<p>Loading Glon…</p>"; $("#va").innerHTML = "";
  const [realtime, profile, region] = await Promise.all([
    readJson("fixtures/route21/realtime.json"), readJson("config/profile.json"), readJson("config/region.json"),
  ]);
  if (!gtfsIndex) {
    const texts = await Promise.all(GTFS_FILES.map((f) => readText("fixtures/gtfs-route21/" + f)));
    gtfsIndex = GtfsIndex.fromTexts(Object.fromEntries(GTFS_FILES.map((f, i) => [f, texts[i]])));
  }
  const transit = new GtfsTransitProvider({ index: gtfsIndex, realtime: mode === "live" ? { updates: [] } : realtime });
  const { machine, proj } = await bootJourneyApp({ readText, readBytes, profile, region });
  let host = null;
  host = new JourneyHost(machine, proj, { effects, transit, onRender: (st) => paint(st, namesFor(host, profile)) });
  paint(host.state, namesFor(host, profile));

  if (mode === "live") {
    const gps = new BrowserLocationProvider();
    const clock = new SystemClock(region.timezone);
    gps.onError = (e) => { $("#status").textContent = "GPS: " + (e.message || e.code); };
    clock.start((t) => { host.clock(t); transit.tick(t.secs); });
    transit.start(host);
    gps.start((fix) => host.position(fix));
    $("#status").textContent = gps.available ? "Live GPS · GTFS timetable, no realtime (no Metlink key configured)" : "Geolocation unavailable";
    session = { host, stop() { gps.stop(); clock.stop(); } };
    return;
  }

  const sc = scenario($("#scenario").value, {
    noiseM: $("#noise").checked ? 12 : 0,
    autoTap: $("#autotap").checked,
  });
  const sim = new JourneySimulation({ scenario: sc, transit, host, favourites: profile.favourites });
  sim.begin();
  let running = true, last = performance.now(), owed = 0;
  const frame = () => {
    if (!running) return;
    const now = performance.now();
    owed += (now - last) / 1000 * Number($("#speed").value);
    last = now;
    const t0 = performance.now();
    while (owed >= 1 && !sim.done() && performance.now() - t0 < 30) { sim.step(); owed -= 1; }
    owed = Math.min(owed, 5);
    const c = sim.t;
    $("#status").textContent = `Simulation · ${String(Math.floor(c / 3600)).padStart(2, "0")}:` +
      `${String(Math.floor(c / 60) % 60).padStart(2, "0")}:${String(c % 60).padStart(2, "0")} · ${sc.title}`;
    if (!sim.done()) setTimeout(frame, 50);
  };
  setTimeout(frame, 50);
  $("#droprt").onclick = () => transit.dropRealtime();
  session = { host, stop() { running = false; } };
}

document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-act]");
  if (!b || !session) return;
  effects.prime();
  const act = b.dataset.act;
  if (b.dataset.value !== undefined) session.host.command(act, b.dataset.value);
  else session.host.command(act);
});

for (const [k, s] of Object.entries(SCENARIOS)) $("#scenario").add(new Option(s.title, k));
$("#start-sim").onclick = () => { effects.prime(); start("sim").catch(showError); };
$("#start-live").onclick = () => { effects.prime(); start("live").catch(showError); };
function showError(e) { $("#vb").innerHTML = `<p class="note">${String(e.message || e)}</p>`; console.error(e); }

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (hadController && !reloading) { reloading = true; location.reload(); }
  });
  navigator.serviceWorker.register("sw.js", { updateViaCache: "none" })
    .then((reg) => reg.update())
    .catch(() => { /* offline cache is optional */ });
}
start("sim").catch(showError);
