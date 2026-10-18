
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
import { startupMode, passengerUrl, locationProblem } from "./startup.js";
import { NominatimGeocoder } from "./geocoder.js";
import { MyPlaces, catalogue, passengerProfile, PLACE_SLOT, FareSetting, setupStep, findStops, parseLocation } from "./places.js";

const $ = (s) => document.querySelector(s);
const readText = (p) => fetch(p).then((r) => { if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`); return r.text(); });
const readBytes = (p) => fetch(p).then((r) => { if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`); return r.arrayBuffer(); });
const readJson = (p) => readText(p).then(JSON.parse);

const MODE = startupMode(location.search);
const effects = new PlatformEffects();
let session = null;     // { host, poller, stop() }
const keys = new RealtimeKeys({ onChange: onKeys });
const realtimeReady = keys.init();
let gtfsIndex = null;   // built once per page from the Route 21 GTFS subset
const places = MODE === "passenger" ? new MyPlaces() : null;
let cat = null;          // the landmark catalogue (config/landmarks.json)
let chosenPlace = null;  // the one of My Places in Glon's slot 1, once chosen
let lastFix = null;      // the latest GPS fix, in memory only (Use my current location)
let lastGpsError = null; // why there is no fix, if the browser said (setup explains it plainly)
const fare = MODE === "passenger" ? new FareSetting() : null;

const namesFor = (host, profile) => ({
  rtSource: session && session.poller ? "metlink" : "demo",
  stops: host && host.activePattern ? host.activePattern.stops.map((s) => s.name) : [],
  dests: places ? [profile.favourites[0].name, chosenPlace ? chosenPlace.name : "Your place"] : profile.favourites.map((f) => f.name),
  ...(places ? { places: places.places } : {}),
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
  const [realtime, loaded, region] = await Promise.all([
    readJson("fixtures/route21/realtime.json"), readJson("config/profile.json"), readJson("config/region.json"),
  ]);
  let profile = loaded;
  if (mode === "live") {
    cat = catalogue(await readJson("config/landmarks.json"));
    if (!cat.builtIn) throw new Error("config/landmarks.json has no default destination");
    profile = passengerProfile(loaded, cat.builtIn);
    chosenPlace = null;
  }
  if (!gtfsIndex) {
    const texts = await Promise.all(GTFS_FILES.map((f) => readText("fixtures/gtfs-wellington/" + f)));
    gtfsIndex = GtfsIndex.fromTexts(Object.fromEntries(GTFS_FILES.map((f, i) => [f, texts[i]])));
  }
  const transit = new GtfsTransitProvider({ index: gtfsIndex, realtime: mode === "live" ? { updates: [] } : realtime });
  const farePolicy = mode === "live" ? "config/fare-policy.metlink.glon" : "config/fare-policy.demo.glon";
  const { machine, proj } = await bootJourneyApp({ readText, readBytes, profile, region, farePolicy });
  let host = null;
  host = new JourneyHost(machine, proj, { effects, transit, onRender: (st) => paint(st, namesFor(host, profile)) });
  if (mode === "live") host.passengerType(fare.type);
  paint(host.state, namesFor(host, profile));

  if (mode === "live") {
    const gps = new BrowserLocationProvider();
    const clock = new SystemClock(region.timezone);
    await realtimeReady;
    const poller = new RealtimePoller({ source: keys.client, host, onStatus: showRt });
    const where = gps.available ? "Using your location · timetable" + (keys.client ? " · Metlink realtime" : "") : locationProblem(null);
    let located = false;
    gps.onError = (e) => { lastGpsError = e; if (!located || e.code !== 3) $("#status").textContent = locationProblem(e); };
    clock.start((t) => {
      host.clock(t); transit.tick(t.secs);
      const p = poller.tick(t.secs);
      if (p) p.catch(showError);
      showRt();
    });
    transit.start(host);
    gps.start((fix) => {
      if (!located) { located = true; $("#status").textContent = where; }
      lastFix = { lat: fix.lat, lon: fix.lon, accuracy: fix.accuracy };
      lastGpsError = null;
      host.position(fix);
    });
    $("#status").textContent = gps.available ? "Finding your location…" : where;
    session = { host, poller, profile, stop() { gps.stop(); clock.stop(); } };
    showRt();
    showMode();
    goNext();                 // Home setup, fare setup, or Where do you want to go?
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
  session = { host, poller: null, profile, title: sc.title, stop() { running = false; } };
  showRt();
  showMode();
}

function showMode() {
  const sim = session && !session.poller;
  $("#mode").hidden = !sim;
  if (!sim) return;
  const demo = (session.title || "").replace(/^Demo:\s*/, "");
  $("#mode-text").textContent = `Demo journey (${demo}): simulated, not your location or real bus times.`;
}
$("#leave-demo").onclick = () => location.assign(passengerUrl(location.href));

function showRt() {
  const s = session, live = s && s.poller;
  let t = statusText(live ? live.status : null, !!keys.client, s && s.host.lastClock ? s.host.lastClock.secs : 0);
  if (keys.client && !live) t = "The demo uses demonstration data; leave the demo for live times";
  if ($("#rt-status").textContent !== t) $("#rt-status").textContent = t;
}
function onKeys(view) {
  showMode();
  const entry = view.panel === "setup" || view.panel === "rejected" || view.panel === "replace";
  $("#rt-msg").textContent = view.message;
  $("#rt-msg").className = view.panel === "rejected" ? "note" : "";
  $("#rt-entry").hidden = !entry;
  $("#rt-cancel").hidden = view.panel !== "replace";
  $("#rt-manage").hidden = !(view.panel === "connected" || view.panel === "unverified");
  if (entry && MODE === "demo") $("#rt-panel").open = true;
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
  if (act === "add-place") { openPlaces(); return; }
  if (act === "settings") { openSettings(); return; }
  if (act === "place") {
    const p = places && places.get(b.dataset.value);
    if (!p) return;
    chosenPlace = p;
    session.host.destination(PLACE_SLOT, p);
    session.host.command("choose", String(PLACE_SLOT));
    return;
  }
  if (act === "choose") chosenPlace = null;
  if (b.dataset.value !== undefined) session.host.command(act, b.dataset.value);
  else session.host.command(act);
});

const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
function repaintView() { if (session) paint(session.host.state, namesFor(session.host, session.profile)); }
function placeMsg(t) { $("#place-msg").textContent = t || ""; }
const SCREENS = ["view", "setup-home", "setup-fare", "places", "settings", "myplaces"];
function show(id) {
  for (const s of SCREENS) $("#" + s).hidden = s !== id;
  if (id === "view") repaintView();
}
function goNext() {
  if (!places) return;
  const step = setupStep(places, fare);
  if (step === "home") openHomeSetup(false);
  else if (step === "fare") openFareSetup(false);
  else show("view");
}
let fromSettings = false;    // a setup screen opened from Settings returns there
function afterSetup() { if (fromSettings && setupStep(places, fare) === "ready") openSettings(); else goNext(); }

function homeMsg(t) { $("#home-msg").textContent = t || ""; }
function openHomeSetup(settings) {
  fromSettings = settings;
  $("#setup-home-title").textContent = places.home() ? "Change Home" : "Let's set up Home";
  $("#home-cancel").hidden = !settings;
  $("#home-pick").hidden = true; $("#home-stop").value = ""; $("#home-stops").replaceChildren(); $("#home-coords").value = "";
  homeMsg("");
  show("setup-home");
}
function setHome(point) { places.setHome(point); chosenPlace = null; afterSetup(); }
$("#home-here").onclick = () => {
  if (lastFix) { setHome(lastFix); return; }
  homeMsg(lastGpsError && lastGpsError.code === 1
    ? "This device is not sharing its location with the app. You can allow location for this site in your browser's settings, or choose another location."
    : "We can't see where you are yet. Wait a moment and try again, or choose another location.");
  $("#home-other").focus();
};
$("#home-other").onclick = () => { $("#home-pick").hidden = false; homeMsg(""); $("#home-stop").focus(); };
$("#home-stop").oninput = () => {
  if (!gtfsIndex) { homeMsg("Still loading the bus stops…"); return; }
  $("#home-stops").replaceChildren(...findStops(gtfsIndex.stops.values(), $("#home-stop").value).map((st) =>
    el("li", {}, el("span", { textContent: `${st.stop_name} (stop ${st.stop_id})` }),
      el("button", { type: "button", textContent: "Home is near here", onclick: () => setHome({ lat: st.lat, lon: st.lon }) }))));
};
$("#home-coords-use").onclick = () => {
  const p = parseLocation($("#home-coords").value);
  if (p) setHome(p);
  else homeMsg("That doesn't look like a location. Copy it from a map app, for example -41.2950, 174.7700.");
};
$("#home-cancel").onclick = () => openSettings();

function openFareSetup(settings) {
  fromSettings = settings;
  $("#fare-cancel").hidden = !settings;
  show("setup-fare");
}
for (const b of document.querySelectorAll("[data-fare]")) {
  b.onclick = () => {
    fare.set(b.dataset.fare);
    if (session) session.host.passengerType(fare.type);   // only the category; Glon judges the fare
    afterSetup();
  };
}
$("#fare-cancel").onclick = () => openSettings();

if (MODE === "passenger") { $("#settings-advanced").append($("#rt-panel")); $("#rt-panel").open = false; }

const FARE_WORDS = { supergold: "SuperGold card", standard: "Standard fare" };
function openSettings() {
  if (!places) return;
  fromSettings = false;
  $("#set-fare-now").textContent = fare.type ? FARE_WORDS[fare.type] : "Not chosen yet";
  $("#set-home").textContent = places.home() ? "Change Home" : "Set up Home";
  show("settings");
}
$("#set-home").onclick = () => openHomeSetup(true);
$("#set-myplaces").onclick = () => openMyPlaces();
$("#set-fare").onclick = () => openFareSetup(true);
$("#settings-close").onclick = () => goNext();

function openPlaces() {
  if (!places) return;
  $("#place-here-form").hidden = true; $("#place-search").value = ""; placeMsg("");
  found = []; renderFound();
  renderPlaces();
  show("places");
}
function closePlaces() { goNext(); }
function renderPlaces() {
  const q = $("#place-search").value;
  const have = new Set(places.places.map((p) => p.landmark).filter(Boolean));
  $("#place-results").replaceChildren(...cat.search(q).map((l) => el("li", {},
    el("span", { textContent: l.name }),
    have.has(l.id) ? el("span", { className: "sched", textContent: "Added" })
      : el("button", { type: "button", textContent: "Add", onclick: () => { places.addLandmark(l); placeMsg(`Added ${l.name}.`); renderPlaces(); repaintView(); } }))));
}

let removing = null;           // the place awaiting "Remove …?" confirmation
let renaming = null;           // the place being renamed
function openMyPlaces() {
  if (!places) return;
  removing = null; renaming = null;
  $("#myplaces-msg").textContent = "";
  renderMyPlaces();
  show("myplaces");
}
function renderMyPlaces() {
  const home = places.home();
  $("#myplaces-list").replaceChildren(
    ...(home ? [el("li", {}, el("span", { className: "pname", textContent: home.name }),
      el("button", { type: "button", textContent: "Change Home", onclick: () => openHomeSetup(true) }))] : []),
    ...places.places.filter((p) => !p.home).map((p) => el("li", {}, el("span", { className: "pname", textContent: p.name }),
      el("button", { type: "button", textContent: "Rename", onclick: () => askRename(p) }),
      el("button", { type: "button", textContent: "Remove", onclick: () => askRemove(p) }))));
  $("#myplaces-confirm").hidden = !removing;
  $("#myplaces-rename").hidden = !renaming;
  $("#myplaces-list").hidden = !!(removing || renaming);
}
function askRename(p) {
  renaming = p; removing = null;
  $("#myplaces-rename-title").textContent = `Rename ${p.name}`;
  $("#myplaces-rename-name").value = p.name;
  $("#myplaces-rename-msg").textContent = "";
  $("#myplaces-msg").textContent = "";
  renderMyPlaces();
  $("#myplaces-rename-name").focus();
}
$("#myplaces-rename-cancel").onclick = () => { renaming = null; renderMyPlaces(); };
$("#myplaces-rename-save").onclick = () => {
  const p = renaming;
  if (!p) return;
  try { places.rename(p.id, $("#myplaces-rename-name").value); }
  catch (err) { $("#myplaces-rename-msg").textContent = err.message; return; }   // e.g. "Home", or no name
  renaming = null;
  $("#myplaces-msg").textContent = `Renamed to ${p.name}.`;
  renderMyPlaces();
  repaintView();
};
$("#myplaces-rename-name").onkeydown = (e) => { if (e.key === "Enter") $("#myplaces-rename-save").click(); };
function askRemove(p) {
  removing = p; renaming = null;
  $("#myplaces-confirm-text").textContent = `Remove ${p.name}?`;
  $("#myplaces-msg").textContent = "";
  renderMyPlaces();
  $("#myplaces-cancel").focus();
}
$("#myplaces-cancel").onclick = () => { removing = null; renderMyPlaces(); };
$("#myplaces-remove").onclick = () => {
  const p = removing;
  removing = null;
  if (p) removePlace(p.id);
  $("#myplaces-msg").textContent = p ? `${p.name} removed.` : "";
  renderMyPlaces();
};
$("#myplaces-close").onclick = () => openSettings();
function removePlace(id) {
  if (!places.remove(id)) return;
  if (chosenPlace && chosenPlace.id === id) {
    chosenPlace = null;
    if (session && session.host.state.state !== "IDLE") session.host.command("cancel");
  }
  repaintView();
}
$("#place-here").onclick = () => {
  if (!lastFix) { placeMsg("Your location is not known yet. Allow location for this site, then try again."); return; }
  $("#place-here-form").hidden = false; $("#place-name").value = ""; $("#place-name").focus(); placeMsg("");
};
$("#place-save").onclick = () => {
  try { const p = places.addHere($("#place-name").value, lastFix); placeMsg(`Saved ${p.name}.`); $("#place-here-form").hidden = true; }
  catch (err) { placeMsg(err.message); }
  renderPlaces(); repaintView();
};
$("#place-name").onkeydown = (e) => { if (e.key === "Enter") $("#place-save").click(); };
$("#place-search").oninput = () => renderPlaces();       // filters the popular places, locally
$("#places-close").onclick = () => closePlaces();

const geocoder = MODE === "passenger" ? new NominatimGeocoder() : null;
let found = [];
function renderFound() {
  const saved = (r) => places.places.some((p) => p.name === r.name && Math.abs(p.lat - r.lat) < 1e-5 && Math.abs(p.lon - r.lon) < 1e-5);
  $("#place-found").replaceChildren(...found.map((r) => el("li", {},
    el("span", {}, el("span", { className: "pname", textContent: r.name }), el("span", { className: "pdetail", textContent: r.detail })),
    saved(r) ? el("span", { className: "sched", textContent: "Added" })
      : el("button", { type: "button", textContent: "Add", onclick: () => {
        try { places.addPlace(r.name, r); } catch (err) { placeMsg(err.message); return; }   // e.g. a second "Home"
        found = [];
        goNext();
      } }))));
}
$("#place-find").onsubmit = async (e) => {
  e.preventDefault();
  const text = $("#place-search").value.trim();
  found = [];
  if (text.length < 3) { placeMsg("Type a little more of the name or address."); renderFound(); return; }
  if (!geocoder || navigator.onLine === false) { placeMsg("Place search isn't available right now."); renderFound(); return; }
  placeMsg("Searching…");
  $("#place-find-go").disabled = true;
  try {
    found = await geocoder.search(text);
    placeMsg(found.length ? "" : "No places found in the Wellington region. Try another name or address.");
  } catch {
    found = [];
    placeMsg("Place search isn't available right now.");
  } finally {
    $("#place-find-go").disabled = false;
  }
  renderFound();
};

const scenariosReady = MODE !== "demo" ? null : readJson("config/profile.json").then((p) => {
  const ids = new Set(p.favourites.map((f) => f.id));
  for (const [k, s] of Object.entries(SCENARIOS)) if (ids.has(s.destId)) $("#scenario").add(new Option(s.title, k));
  $("#sim-panel").hidden = false;
});
$("#start-sim").onclick = () => { effects.prime(); start("sim").catch(showError); };
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
if (MODE === "demo") scenariosReady.then(() => start("sim")).catch(showError);
else start("live").catch(showError);
