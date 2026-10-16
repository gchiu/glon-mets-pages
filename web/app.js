
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
import { RealtimePoller } from "./transit/metlink-realtime.js";
import { RealtimeKeys, statusText, stopCheckRows } from "./realtime-settings.js";

const $ = (s) => document.querySelector(s);
const readText = (p) => fetch(p).then((r) => { if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`); return r.text(); });
const readBytes = (p) => fetch(p).then((r) => { if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`); return r.arrayBuffer(); });
const readJson = (p) => readText(p).then(JSON.parse);

const effects = new PlatformEffects();
let session = null;     // { host, poller, stop() }
const keys = new RealtimeKeys({ onChange: onKeys });
const realtimeReady = keys.init();
let gtfsIndex = null;   // built once per page from the Route 21 GTFS subset

const namesFor = (host, profile) => ({
  rtSource: session && session.poller ? "metlink" : "demo",
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
  session = null;
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
    await realtimeReady;
    const poller = new RealtimePoller({ source: keys.client, host, onStatus: showRt });
    gps.onError = (e) => { $("#status").textContent = "GPS: " + (e.message || e.code); };
    clock.start((t) => {
      host.clock(t); transit.tick(t.secs);
      const p = poller.tick(t.secs);
      if (p) p.catch(showError);
      showRt();
    });
    transit.start(host);
    gps.start((fix) => host.position(fix));
    $("#status").textContent = gps.available ? "Live GPS · GTFS timetable" + (keys.client ? " · Metlink realtime" : " · no realtime key") : "Geolocation unavailable";
    session = { host, poller, stop() { gps.stop(); clock.stop(); } };
    showRt();
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
  session = { host, poller: null, stop() { running = false; } };
  showRt();
}

function showRt() {
  const s = session, live = s && s.poller;
  let t = statusText(live ? live.status : null, !!keys.client, s && s.host.lastClock ? s.host.lastClock.secs : 0);
  if (keys.client && !live) t = "The simulation uses demo data; Use real GPS for live times";
  if ($("#rt-status").textContent !== t) $("#rt-status").textContent = t;
}
function onKeys(view) {
  const entry = view.panel === "setup" || view.panel === "rejected" || view.panel === "replace";
  $("#rt-msg").textContent = view.message;
  $("#rt-msg").className = view.panel === "rejected" ? "note" : "";
  $("#rt-entry").hidden = !entry;
  $("#rt-cancel").hidden = view.panel !== "replace";
  $("#rt-manage").hidden = !(view.panel === "connected" || view.panel === "unverified");
  if (entry) $("#rt-panel").open = true;
  if (session && session.poller && session.poller.source !== keys.client) {
    session.poller.source = keys.client;
    session.poller.lastGen = null;
    session.poller.status = { ...session.poller.status, state: keys.client ? "waiting" : "off" };
    if (!keys.client) session.host.realtimeLost();
  }
  if (!keys.client) $("#rt-check").innerHTML = "";
  showRt();
}
const saveKey = async () => {
  const value = $("#rt-key").value;
  $("#rt-key").value = "";                         // never left on screen
  $("#rt-save").disabled = true;
  $("#rt-msg").textContent = "Checking the key with Metlink…";
  try { await keys.save(value); } finally { $("#rt-save").disabled = false; }
};
$("#rt-save").onclick = () => { saveKey().catch(showError); };
$("#rt-key").onkeydown = (e) => { if (e.key === "Enter") $("#rt-save").click(); };
$("#rt-replace").onclick = () => keys.replace();
$("#rt-cancel").onclick = () => keys.cancelReplace();
$("#rt-forget").onclick = () => keys.forget();

$("#rt-check-form").onsubmit = async (e) => {
  e.preventDefault();
  const out = $("#rt-check"), stop = $("#rt-stop").value.trim();
  if (!keys.client) { out.textContent = "Enter your Metlink API key first."; return; }
  if (!/^\w{1,12}$/.test(stop)) { out.textContent = "Enter a stop number."; return; }
  if (!gtfsIndex) { out.textContent = "Start the app first (timetable not loaded)."; return; }
  out.textContent = "Asking Metlink…";
  const region = await readJson("config/region.json");
  const today = new SystemClock(region.timezone).now();
  const a = await keys.client.stop(stop, today.date);
  if (!a.ok) { out.textContent = `No answer (${a.error}).`; return; }
  const rows = stopCheckRows(a.facts, gtfsIndex);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  out.innerHTML = `<p>Stop ${esc(stop)} · ${rows.length} predictions · ${rows.filter((r) => r.matched).length} matched to GTFS trips</p>` +
    `<table><tr><th>Route</th><th>Timetable</th><th>Expected</th><th>GTFS trip</th></tr>` +
    rows.slice(0, 12).map((r) => `<tr><td>${esc(r.route)} ${esc(r.headsign)}</td><td>${r.aimed}</td>` +
      `<td>${r.live ? `<span class="live">${r.expected} Live</span>` : `<span class="sched">Scheduled</span>`}</td>` +
      `<td class="tc">${esc(r.gtfs)}</td></tr>`).join("") + `</table>`;
};

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
