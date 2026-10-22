
import { bootJourneyApp } from "./boot.js";
import { JourneyHost } from "./journey-host.js";
import { renderView, renderFrom, serviceText } from "./ui.js";
import { PlatformEffects } from "./effects.js";
import { resolveRoutes, routeChoices } from "./gtfs/network.js";
import { NetworkStore } from "./network-store.js";
import { GtfsTransitProvider } from "./transit/gtfs-transit.js";
import { BrowserLocationProvider } from "./location/location-providers.js";
import { SystemClock } from "./clock.js";
import { JourneySimulation } from "./sim/journey-sim.js";
import { SCENARIOS, scenario } from "./sim/scenarios.js";
import { RealtimePoller } from "./transit/metlink-realtime.js";
import { RealtimeKeys, statusText, stopCheckRows } from "./realtime-settings.js";
import { startupMode, passengerUrl, locationProblem } from "./startup.js";
import { NominatimGeocoder } from "./geocoder.js";
import { JourneyStore, checkJourney } from "./active-journey.js";
import { MyPlaces, catalogue, passengerProfile, PLACE_SLOT, FareSetting, OriginSetting, setupStep, findStops, parseLocation } from "./places.js";

const $ = (s) => document.querySelector(s);
const readText = (p) => fetch(p).then((r) => { if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`); return r.text(); });
const readBytes = (p) => fetch(p).then((r) => { if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`); return r.arrayBuffer(); });
const readJson = (p) => readText(p).then(JSON.parse);

const MODE = startupMode(location.search);
const effects = new PlatformEffects();
let session = null;     // { host, poller, stop() }
const keys = new RealtimeKeys({ onChange: onKeys });
const realtimeReady = keys.init();
let gtfsIndex = null;   // the planner's index: built from the installed route packages (web/network-store.js)
const network = new NetworkStore();
let latestCat = null;   // the newest catalogue seen (for choosing routes and update checks)
let installedCat = null; // the catalogue the installed packages belong to
const DEMO_ROUTES = "21 24";   // the routes the ?demo=1 simulations use
const places = MODE === "passenger" ? new MyPlaces() : null;
let cat = null;          // the landmark catalogue (config/landmarks.json)
let chosenPlace = null;  // the one of My Places in Glon's slot 1, once chosen
let lastFix = null;      // the latest GPS fix, in memory only (Use my current location)
const currentFix = () => (lastFix && session && session.host.state.fix ? lastFix : null);
let lastGpsError = null; // why there is no fix, if the browser said (setup explains it plainly)
const fare = MODE === "passenger" ? new FareSetting() : null;
const origin = MODE === "passenger" ? new OriginSetting() : null;
const fromPoint = () => (origin ? origin.resolve(places) : null);
const journeys = MODE === "passenger" ? new JourneyStore() : null;
let journeyReady = false;

const namesFor = (host, profile) => ({
  rtSource: session && session.poller ? "metlink" : "demo",
  stops: host && host.activePattern ? host.activePattern.stops.map((s) => s.name) : [],
  dests: places ? [profile.favourites[0].name, chosenPlace ? chosenPlace.name : "Your place"] : profile.favourites.map((f) => f.name),
  ...(places ? { places: places.places, from: fromPoint() } : {}),
});

function paint(state, names) {
  const { body, acts } = renderView(state, names);
  const from = renderFrom(state, names);
  for (const [el, html] of [[$("#vf"), from], [$("#vb"), body], [$("#va"), acts]]) {
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
    if (!latestCat) latestCat = (await network.latestCatalogue()).catalogue;
    if (mode === "live") {
      let loaded = null;
      try { loaded = await network.loadIndex(); }
      catch (err) { openRoutesSetup(); routesMsg("#routes-msg", err.message || String(err)); return; }   // never plan from a partial timetable
      if (!loaded) { openRoutesSetup(); return; }        // first run: nothing to plan with until routes are chosen
      gtfsIndex = loaded.index;
      installedCat = loaded.catalogue;
    } else {
      gtfsIndex = await network.loadRoutes(latestCat, resolveRoutes(latestCat, DEMO_ROUTES).routes.map((r) => r.routeId));
    }
  }
  const transit = new GtfsTransitProvider({ index: gtfsIndex, realtime: mode === "live" ? { updates: [] } : realtime });
  const farePolicy = mode === "live" ? "config/fare-policy.metlink.glon" : "config/fare-policy.demo.glon";
  const { machine, proj } = await bootJourneyApp({ readText, readBytes, profile, region, farePolicy });
  let host = null;
  journeyReady = false;
  host = new JourneyHost(machine, proj, { effects, transit,
    onRender: (st) => { paint(st, namesFor(host, profile)); keepJourney(host, profile); wantFix(st); } });
  if (mode === "live") host.passengerType(fare.type);
  const clock = mode === "live" ? new SystemClock(region.timezone) : null;
  if (mode === "live") { host.clock(clock.now()); restoreJourney(host, profile, transit); }
  journeyReady = true;
  if (mode === "live" && fromPoint() && host.state.state === "IDLE") host.origin(fromPoint());
  paint(host.state, namesFor(host, profile));

  if (mode === "live") {
    const gps = new BrowserLocationProvider();
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
    session = { host, poller, profile, transit, gps, stop() { gps.stop(); clock.stop(); } };
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

let fixAsked = 0;
function wantFix(st) {
  const gps = session && session.gps;
  if (!gps || st.fix || fromPoint() || st.state !== "DESTINATION_SELECTED") return;
  const t = Date.now();
  if (t - fixAsked < 10000) return;
  fixAsked = t;
  gps.refresh();
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && session && session.gps) { fixAsked = Date.now(); session.gps.refresh(); }
});

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
  if (act === "board-other") { openBoardOther(); return; }
  if (act === "board" && places) {
    const st = session.host.state;
    const ask = session.host.boardProposed({ at: currentFix(), dest: destOf(st.dest) });
    if (ask) showBoardChoices(ask, "which");
    return;
  }
  if (act === "change-from") { openFrom(); return; }
  if (act === "from-here") { setFrom(null); return; }
  if (act === "place") {
    const p = places && places.get(b.dataset.value);
    if (!p) return;
    chosenPlace = p;
    journeyMsg("");
    session.host.destination(PLACE_SLOT, p);
    session.host.command("choose", String(PLACE_SLOT));
    return;
  }
  if (act === "choose") { chosenPlace = null; journeyMsg(""); }
  if (act === "accept" && origin && origin.value) origin.clear();
  if (b.dataset.value !== undefined) session.host.command(act, b.dataset.value);
  else session.host.command(act);
});

const routeLabel = (c) => `${c.number} ${c.name}`;
function installedRoutes() {
  const cat = installedCat || latestCat, byId = new Map(cat ? routeChoices(cat).map((c) => [c.routeId, c]) : []);
  return network.selection().routes.map((r) => byId.get(r.routeId) || { routeId: r.routeId, number: r.routeId, name: "" });
}
function installedRouteWords() {
  const r = installedRoutes();
  return r.length ? "Route" + (r.length > 1 ? "s " : " ") + r.map((c) => c.number).join(", ") : "No routes chosen yet";
}
function routesMsg(id, t) { $(id).textContent = t || ""; }
function describeRoutes(text, listId, msgId) {
  if (!latestCat) { routesMsg(msgId, "Still loading the route list…"); return null; }
  const { routes, unknown } = resolveRoutes(latestCat, text);
  $(listId).replaceChildren(...routes.map((c) => el("li", {}, el("span", { className: "pname", textContent: routeLabel(c) }))));
  routesMsg(msgId, unknown.length ? `No route ${unknown.join(", ")} in the Metlink timetable.` : "");
  return routes;
}
async function changeRoutes(action, msgId) {
  routesMsg(msgId, "Downloading timetables…");
  try { await action(); }
  catch (err) { routesMsg(msgId, err.message || String(err)); return false; }
  gtfsIndex = null;
  installedCat = null;
  await start("live");
  return true;
}
function openRoutesSetup() {
  $("#status").textContent = "";
  $("#routes-input").value = ""; $("#routes-found").replaceChildren(); routesMsg("#routes-msg", "");
  show("setup-routes");
  $("#routes-input").focus();
}
$("#routes-input").oninput = () => describeRoutes($("#routes-input").value, "#routes-found", "#routes-msg");
$("#routes-form").onsubmit = (e) => {
  e.preventDefault();
  const routes = describeRoutes($("#routes-input").value, "#routes-found", "#routes-msg");
  if (!routes) return;
  if (!routes.length) { routesMsg("#routes-msg", "Type the number of at least one route you use, for example 2."); return; }
  $("#routes-go").disabled = true;
  changeRoutes(() => network.install(routes.map((c) => c.routeId), latestCat), "#routes-msg")
    .catch(showError).finally(() => { $("#routes-go").disabled = false; });
};
function openMyRoutes() {
  routesMsg("#myroutes-msg", ""); $("#myroutes-input").value = ""; $("#myroutes-found").replaceChildren();
  renderMyRoutes();
  show("myroutes");
}
function renderMyRoutes() {
  const list = installedRoutes();
  const riding = activeJourneyRoute();
  if (riding) routesMsg("#myroutes-msg", "Your bus journey uses one of these routes: it can be removed once the journey has ended.");
  $("#myroutes-list").replaceChildren(...list.map((c) => el("li", {}, el("span", { className: "pname", textContent: routeLabel(c) }),
    el("button", { type: "button", textContent: "Remove", disabled: list.length < 2 || c.routeId === riding,
      onclick: () => changeRoutes(() => network.remove(c.routeId), "#myroutes-msg").then((ok) => { if (ok) openMyRoutes(); }) }))));
}
$("#myroutes-input").oninput = () => describeRoutes($("#myroutes-input").value, "#myroutes-found", "#myroutes-msg");
$("#myroutes-form").onsubmit = (e) => {
  e.preventDefault();
  const routes = describeRoutes($("#myroutes-input").value, "#myroutes-found", "#myroutes-msg");
  if (!routes || !routes.length) return;
  const status = network.updateStatus(latestCat);
  const target = status.feedChanged ? latestCat : installedCat || latestCat;
  changeRoutes(() => network.add(routes.map((c) => c.routeId), target), "#myroutes-msg").then((ok) => { if (ok) openMyRoutes(); });
};
$("#myroutes-close").onclick = () => openSettings();
function showUpdate() {
  const s = network.updateStatus(latestCat);
  $("#routes-update").hidden = s.current;
  if (!s.current) $("#routes-update-text").textContent = s.feedChanged
    ? `A newer Metlink timetable is available (valid ${s.feed.start || "?"} to ${s.feed.end || "?"}).`
    : `Newer timetables are available for route ${s.changed.join(", ")}.`;
}
$("#routes-update-go").onclick = () => activeJourneyRoute()
  ? routesMsg("#routes-update-text", "Finish your bus journey first: a new timetable can't continue it.")
  : changeRoutes(() => network.update(latestCat), "#routes-update-text").then((ok) => { if (ok) openSettings(); });

const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
function repaintView() { if (session) paint(session.host.state, namesFor(session.host, session.profile)); }
function placeMsg(t) { $("#place-msg").textContent = t || ""; }
const SCREENS = ["view", "setup-routes", "setup-home", "setup-fare", "places", "settings", "myplaces", "myroutes", "from", "board-other"];
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
function setHome(point) {
  places.setHome(point); chosenPlace = null;
  if (session && origin && origin.value) session.host.origin(fromPoint());   // a FROM of Home moves with it
  afterSetup();
}
$("#home-here").onclick = () => {
  if (currentFix()) { setHome(currentFix()); return; }
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
  $("#set-routes-now").textContent = installedRouteWords();
  showUpdate();
  show("settings");
}
$("#set-home").onclick = () => openHomeSetup(true);
$("#set-myplaces").onclick = () => openMyPlaces();
$("#set-fare").onclick = () => openFareSetup(true);
$("#set-routes").onclick = () => openMyRoutes();
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

function journeyMsg(t) { $("#journey-msg").textContent = t || ""; $("#journey-msg").hidden = !t; }
function activeJourneyRoute() {
  const st = session && session.host.state.state;
  if (st !== "ON_BUS" && st !== "WALKING_FINAL") return null;
  const r = journeys && journeys.load().record;
  return r ? r.routeId : null;
}
function keepJourney(host, profile) {
  if (!journeys || !journeyReady || !host.lastClock) return;
  const r = host.journeyRecord();
  const was = journeys.load();
  if (!r) { if (was.record || was.problem) journeys.clear(); return; }
  const k = host.state.dest;
  const dest = k === PLACE_SLOT && chosenPlace
    ? { slot: k, name: chosenPlace.name, lat: chosenPlace.lat, lon: chosenPlace.lon, ...(chosenPlace.id ? { placeId: chosenPlace.id } : {}) }
    : { slot: k, name: profile.favourites[k].name, lat: profile.favourites[k].lat, lon: profile.favourites[k].lon };
  const rec = { v: 1, feed: network.selection().feed, date: host.lastClock.date, ...r, dest };
  if (!was.record || JSON.stringify(was.record) !== JSON.stringify(rec)) journeys.save(rec);
}
function restoreJourney(host, profile, transit) {
  if (!journeys) return;
  const { record: r, problem } = journeys.load();
  if (!r) { if (problem) { journeys.clear(); journeyMsg("Your earlier bus journey could not be read, so it was not restored. Where are you going?"); } return; }
  const why = checkJourney(r, { selection: network.selection(), index: transit.index, clock: host.lastClock, destCount: profile.favourites.length });
  if (why) { journeys.clear(); journeyMsg(`${why} Your earlier bus journey was not restored. Where are you going?`); return; }
  if (r.dest.slot === PLACE_SLOT) {
    chosenPlace = { id: r.dest.placeId, name: r.dest.name, lat: r.dest.lat, lon: r.dest.lon };
    host.destination(PLACE_SLOT, r.dest);
  }
  host.command("choose", String(r.dest.slot));
  let ok = host.boardService({ tripId: r.tripId, seq: r.boardSeq, alightSeq: r.alightSeq });
  if (ok && r.phase === "WALKING_FINAL") { host.command("alight"); ok = host.state.state === "WALKING_FINAL"; }
  if (!ok) {
    host.command("cancel");
    chosenPlace = null;
    journeys.clear();
    journeyMsg("Your earlier bus journey could not be restored. Where are you going?");
  }
}
const destOf = (k) => (k === PLACE_SLOT && chosenPlace ? chosenPlace : session.profile.favourites[k]);
function openBoardOther() {
  const s = session, st = s && s.host.state;
  if (!st || !(st.acts.includes("board") || st.acts.includes("reboard")) || !s.transit || !s.host.lastClock) return;
  const t = s.host.lastClock, dest = destOf(st.dest);
  const stop = st.state !== "ON_BUS" && s.host.activePattern && st.board >= 0 ? s.host.activePattern.stops[st.board] : null;
  const at = currentFix() || stop;
  showBoardChoices(at ? s.transit.boardable({ date: t.date, now: t.secs, at, dest }) : [], at ? "other" : "nowhere");
}
function showBoardChoices(list, kind) {
  const dest = destOf(session.host.state.dest);
  $("#board-other-msg").textContent = kind === "nowhere" ? "Your location is not known yet, so the buses near you can't be listed."
    : kind === "which" ? `Buses on route ${list[0].route} go both ways here. Which one did you get on?`
    : list.length ? `Buses on your routes that stop near you around now and go towards ${dest.name}:`
    : `No bus on your routes stops near you around now and goes towards ${dest.name}. Only buses going there can be followed.`;
  $("#board-other-list").replaceChildren(...list.map((c) => {
    const tx = serviceText(c, dest.name);
    return el("li", {},
      el("span", {}, el("span", { className: "pname", textContent: tx.title }), el("span", { className: "pdetail", textContent: tx.detail })),
      el("button", { type: "button", textContent: "I'm on this one", onclick: () => {
        if (session.host.boardService(c)) { show("view"); return; }
        $("#board-other-msg").textContent = `That bus can't be followed to ${dest.name}. Choose another, or go back.`;
      } }));
  }));
  show("board-other");
}
$("#board-other-cancel").onclick = () => show("view");

function openFrom() {
  if (!places) return;
  $("#from-stop").value = ""; $("#from-stops").replaceChildren();
  $("#from-search").value = ""; renderFromLandmarks();
  const mine = [...places.places.filter((p) => p.home), ...places.places.filter((p) => !p.home)];
  $("#from-mine").replaceChildren(...mine.map((p) => el("li", {}, el("span", { className: "pname", textContent: p.name }),
    el("button", { type: "button", textContent: "From here", onclick: () => setFrom({ kind: "place", ref: p.id }) }))));
  show("from");
}
function setFrom(o, back = true) {
  if (o) origin.set(o); else origin.clear();
  if (session) session.host.origin(fromPoint());
  if (back) show("view"); else repaintView();
}
function renderFromLandmarks() {
  const q = $("#from-search").value;
  $("#from-landmarks").replaceChildren(...(q.trim() ? cat.search(q) : []).slice(0, 8).map((l) => el("li", {},
    el("span", { textContent: l.name }),
    el("button", { type: "button", textContent: "From here", onclick: () => setFrom({ kind: "landmark", ref: l.id, name: l.name, lat: l.lat, lon: l.lon }) }))));
}
$("#from-here").onclick = () => setFrom(null);
$("#from-cancel").onclick = () => show("view");
$("#from-search").oninput = () => renderFromLandmarks();
$("#from-stop").oninput = () => {
  if (!gtfsIndex) { $("#from-stops").replaceChildren(); return; }
  $("#from-stops").replaceChildren(...findStops(gtfsIndex.stops.values(), $("#from-stop").value).map((st) =>
    el("li", {}, el("span", { textContent: `${st.stop_name} (stop ${st.stop_id})` }),
      el("button", { type: "button", textContent: "From here",
        onclick: () => setFrom({ kind: "stop", ref: String(st.stop_id), name: st.stop_name, lat: st.lat, lon: st.lon }) }))));
};

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
  if (origin && origin.value && origin.value.kind === "place" && origin.value.ref === id) setFrom(null, false);
  if (chosenPlace && chosenPlace.id === id) {
    chosenPlace = null;
    if (session && session.host.state.state !== "IDLE") session.host.command("cancel");
  }
  repaintView();
}
$("#place-here").onclick = () => {
  if (!currentFix()) { placeMsg("Your location is not known yet. Allow location for this site, then try again."); return; }
  $("#place-here-form").hidden = false; $("#place-name").value = ""; $("#place-name").focus(); placeMsg("");
};
$("#place-save").onclick = () => {
  try { const p = places.addHere($("#place-name").value, currentFix()); placeMsg(`Saved ${p.name}.`); $("#place-here-form").hidden = true; }
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
