
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const mins = (s) => (s < 0 ? 0 : Math.ceil(s / 60));
const clock = (s) => `${String(Math.floor(s / 3600) % 24).padStart(2, "0")}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}`;

const STATE_LABEL = {
  IDLE: "Ready", DESTINATION_SELECTED: "Destination chosen", JOURNEY_PROPOSED: "Your journey",
  WALKING_TO_STOP: "Walking to stop", WAITING_FOR_BUS: "Waiting for bus", ON_BUS: "On bus",
  WALKING_FINAL: "Walking final", ARRIVED: "Arrived",
};
const ALERT_LABEL = { STAY_ON: "STAY ON", GET_READY: "GET READY", PRESS_STOP: "PRESS STOP NOW", GET_OFF: "GET OFF NEXT" };
const ALERT_ADVICE = {
  STAY_ON: "Stay on.", GET_READY: "Get ready, your stop is coming up.",
  PRESS_STOP: "Press the stop button now.", GET_OFF: "Get off at the next stop.",
};
const NOTES = {
  1: "LIKELY MISSED the earlier bus. Showing the next option.",
  2: "You passed your stop. Get off at the next stop.",
  5: "is not set up yet (D1).",
  6: "Live times changed: this is now the better bus.",
};
const ACT_LABEL = { accept: "Start journey", board: "I'm on the bus", alight: "I'm off the bus",
  where: "Where am I?", cancel: "End journey", done: "Done" };

export function whereAmI(v, names) {
  const stop = (k) => names.stops[k] || `stop ${k}`;
  const dest = names.dests[v.dest] || "your destination";
  const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
  switch (v.state) {
    case "ON_BUS":
      return `You are on Route ${v.route} heading to ${v.head}. Your stop, ${stop(v.bus.alight)}, is ` +
        `${n(v.bus.togo, "stop", "stops")} away. ${ALERT_ADVICE[v.alert] || ""}`.trim();
    case "WALKING_TO_STOP":
      return `You are walking to ${stop(v.board)}, ${v.walkM} m away.` +
        (v.option ? ` Your bus ${v.route} arrives in ${n(mins(v.option.eta), "min", "min")}.` : "");
    case "WAITING_FOR_BUS":
      return `You are at ${stop(v.board)}.` +
        (v.option ? ` Your bus ${v.route} arrives in ${n(mins(v.option.eta), "min", "min")}. Wait here.` : "");
    case "WALKING_FINAL":
      return `You are off the bus. ${dest} is ${v.destWalk.metres} m ${v.destWalk.dir}.`;
    case "JOURNEY_PROPOSED":
      if (v.walkOnly) return `You can walk to ${dest}.`;
      return v.option ? `Your bus ${v.route} leaves ${stop(v.board)} at ${clock(v.option.boardTime)}.`
                      : "No bus is available in the timetable data.";
    default:
      return "You have no active journey.";
  }
}

function leaveBox(v) {
  switch (v.leave) {
    case "WAIT": return `<div class="leave l-WAIT">WAIT HERE</div>`;
    case "LEAVE_IN": return `<div class="leave l-LEAVE_IN">Leave in ${mins(v.option.leaveIn)} min</div>`;
    case "LEAVE_NOW": return `<div class="leave l-LEAVE_NOW">LEAVE NOW</div>`;
    default: return `<div class="leave l-MISSED">LIKELY MISSED · use next option</div>`;
  }
}

function fareLine(v) {
  const word = { free: "Free", paid: "Paid", concession: "Concession", unknown: "Unknown" }[v.fare] || "Unknown";
  return `<div class="fare">Fare: <b>${word}</b>${v.fareReason ? " · " + esc(v.fareReason) : ""}</div>`;
}

export function timeTag(o, source = "metlink") {
  if (!o.live) return `<b>${clock(o.boardTime)}</b> <span class="sched">Scheduled</span>`;
  const tt = clock(o.boardTime - (o.delay || 0)), late = tt !== clock(o.boardTime) ? ` · timetable ${tt}` : "";
  const word = source === "metlink" ? "Live" : "Demo";
  return `<b>${clock(o.boardTime)}</b> <span class="${source === "metlink" ? "live" : "sched"}">${word}</span>${late}`;
}

function busCard(v, names) {
  if (!v.option) {
    return `<div class="card"><div class="k">NO BUS</div><div class="leave l-MISSED">LIKELY MISSED</div>` +
      `<p>No later service in the timetable data.</p></div>`;
  }
  const o = v.option;
  const eta = o.eta >= 60 ? `Arriving in ${mins(o.eta)} min` : o.eta >= 0 ? "Arriving now" : "Due";
  const walk = v.state === "WAITING_FOR_BUS" ? "You are at the stop"
    : `Walk ${mins(v.walkS)} min (${v.walkM} m) to ${esc(names.stops[v.board] || "")}`;
  return `<div class="card bus"><div class="k">YOUR BUS</div><div class="route">${esc(v.route)}</div>` +
    `<div class="sub">to ${esc(v.head)}</div><div class="eta">${eta}</div>` +
    `<div class="conf">${timeTag(o, names.rtSource)} from ${esc(names.stops[v.board] || "")}</div>` +
    leaveBox(v) + `<div class="walk">${walk}</div>` + fareLine(v) + `</div>`;
}

function strip(v, names) {
  const s = v.strip, st = (k) => esc(names.stops[k] || `stop ${k}`);
  let h = `<ol class="strip">`;
  if (s.prev >= 0) h += `<li class="p">○ ${st(s.prev)}</li>`;
  h += `<li class="you">● YOU</li>`;
  for (const k of s.upcoming) h += `<li>○ ${st(k)}</li>`;
  if (s.elided > 0) h += `<li class="gap">⋮ ${s.elided} more</li>`;
  return h + `<li class="tgt">★ ${st(s.target)}</li></ol>`;
}

function body(v, names) {
  const dest = esc(names.dests[v.dest] || "");
  switch (v.state) {
    case "IDLE":
      return "";
    case "DESTINATION_SELECTED":
      return `<h1>${dest}</h1><p>${v.fix ? "Finding your bus…" : "Waiting for your location…"}</p>`;
    case "ON_BUS": {
      const b = v.bus;
      return `<div class="alert a-${v.alert}">${ALERT_LABEL[v.alert] || ""}</div>` +
        `<div class="route">${esc(v.route)} → ${esc(v.head)}</div><div class="info">` +
        (b.next < names.stops.length ? `Next stop: <b>${esc(names.stops[b.next])}</b><br>` : "") +
        `${b.togo} ${b.togo === 1 ? "stop" : "stops"} to go · about ${mins(b.rem)} min</div>` + strip(v, names) +
        `<div class="conf">Position: phone GPS · ${v.rt ? (names.rtSource === "metlink" ? "live data OK" : "demo data") : "timetable"}</div>`;
    }
    case "WALKING_FINAL":
      return `<div class="alert a-WALK">WALKING FINAL</div><h1>${dest}</h1><div class="card"><p>Walk <b>` +
        `${v.destWalk.metres} m</b> ${v.destWalk.dir}</p><p>about ${mins(v.destWalk.walkS)} min</p></div>`;
    case "ARRIVED":
      return `<div class="alert a-ARRIVED">ARRIVED</div><h1>${dest}</h1><p>You have arrived.</p>`;
    default:
      if (v.walkOnly) {
        return `<h1>${dest}</h1><div class="card"><div class="k">NO BUS NEEDED</div><p>Walk <b>${v.destWalk.metres} m</b> ` +
          `${v.destWalk.dir} · about ${mins(v.destWalk.walkS)} min</p></div>`;
      }
      return `<h1>${dest}</h1>` + busCard(v, names);
  }
}

export function renderView(v, names) {
  let h = `<div class="bar"><b>DoorDash</b><span>${STATE_LABEL[v.state] || ""}</span></div>` + body(v, names);
  if (v.note) h += `<p class="note">${v.note === 5 ? esc(names.dests[v.dest] || "") + " " : ""}${NOTES[v.note] || ""}</p>`;
  if (v.where) h += `<div class="where"><p>${esc(whereAmI(v, names))}</p></div>`;
  let a = "";
  if (v.where) a += `<button data-act="where-close" class="act-where-close">OK</button>`;
  const acts = v.acts.filter((x) => x !== "choose" && !(x === "where" && v.where));
  if (acts.length) {
    const label = (x) => (x === "accept" && v.walkOnly ? "Start walking" : ACT_LABEL[x]);
    a += acts.map((x) => `<button data-act="${x}" class="act-${x}">${label(x)}</button>`).join("");
  }
  if (v.state === "IDLE" && names.places) {
    a = `<h1>Where to?</h1><div class="dests">` +
      `<button class="dest" data-act="choose" data-value="0">${esc(names.dests[0])}</button>` +
      names.places.map((p) => `<button class="dest mine" data-act="place" data-value="${esc(p.id)}">${esc(p.name)}</button>`).join("") +
      `<button class="dest add" data-act="add-place">+ Add a place</button></div>`;
  } else if (v.state === "IDLE") {
    a = `<h1>Where to?</h1><div class="dests">` +
      names.dests.map((d, k) => `<button class="dest" data-act="choose" data-value="${k}">${esc(d)}</button>`).join("") + `</div>`;
  }
  if (v.state !== "IDLE" && a) a = `<div class="acts">${a}</div>`;
  return { body: h, acts: a };
}
