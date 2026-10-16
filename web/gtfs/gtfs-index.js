
export function parseCsv(text) {
  const rows = [];
  let head = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^﻿/, "");
    if (!line) continue;
    const c = [];
    let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
      else if (ch === '"') q = true; else if (ch === ",") { c.push(cur); cur = ""; } else cur += ch;
    }
    c.push(cur);
    if (!head) { head = c; continue; }
    const o = {};
    head.forEach((h, i) => { o[h] = c[i] === undefined ? "" : c[i]; });
    rows.push(o);
  }
  return rows;
}

export const secs = (hms) => { const [h, m, s] = hms.split(":").map(Number); return h * 3600 + m * 60 + s; };

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
export function weekdayName(yyyymmdd) {
  const y = Math.floor(yyyymmdd / 10000), m = Math.floor(yyyymmdd / 100) % 100, d = yyyymmdd % 100;
  return DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

const R = 6371000;
export function metres(aLat, aLon, bLat, bLon) {
  const x = (bLon - aLon) * Math.PI / 180 * Math.cos((aLat + bLat) / 2 * Math.PI / 180);
  return Math.hypot(x, (bLat - aLat) * Math.PI / 180) * R;
}

export const GTFS_FILES = ["feed_info.txt", "routes.txt", "trips.txt", "stop_times.txt", "stops.txt",
  "shapes.txt", "calendar.txt", "calendar_dates.txt"];

export class GtfsIndex {
  static fromTexts(files) {
    const t = (f) => (files[f] ? parseCsv(files[f]) : []);
    return new GtfsIndex({
      feedInfo: t("feed_info.txt")[0] || null, routes: t("routes.txt"), trips: t("trips.txt"),
      stopTimes: t("stop_times.txt"), stops: t("stops.txt"), shapes: t("shapes.txt"),
      calendar: t("calendar.txt"), calendarDates: t("calendar_dates.txt"),
    });
  }

  constructor({ feedInfo, routes, trips, stopTimes, stops, shapes, calendar, calendarDates }) {
    this.feedInfo = feedInfo;
    this.routes = new Map(routes.map((r) => [r.route_id, r]));
    this.trips = new Map(trips.map((x) => [x.trip_id, x]));
    this.stops = new Map(stops.filter((s) => s.location_type !== "1").map((s) => [s.stop_id, { ...s, lat: +s.stop_lat, lon: +s.stop_lon }]));
    this.calendar = new Map(calendar.map((c) => [c.service_id, c]));
    this.calendarDates = new Map();                       // date -> [{service_id, exception_type}]
    for (const d of calendarDates) {
      const k = +d.date;
      if (!this.calendarDates.has(k)) this.calendarDates.set(k, []);
      this.calendarDates.get(k).push(d);
    }

    this.tripTimes = new Map();
    this.stopCalls = new Map();
    for (const s of stopTimes) {
      const row = { tripId: s.trip_id, stopId: s.stop_id, seq: +s.stop_sequence,
        arr: secs(s.arrival_time || s.departure_time), dep: secs(s.departure_time || s.arrival_time) };
      if (!this.tripTimes.has(s.trip_id)) this.tripTimes.set(s.trip_id, []);
      this.tripTimes.get(s.trip_id).push(row);
      if (!this.stopCalls.has(s.stop_id)) this.stopCalls.set(s.stop_id, []);
      this.stopCalls.get(s.stop_id).push(row);
    }
    for (const v of this.tripTimes.values()) v.sort((a, b) => a.seq - b.seq);

    this.patterns = new Map();                            // patternId -> { id, routeId, dir, stopIds, shapeId, trips }
    this.tripPattern = new Map();
    for (const [tripId, rows] of this.tripTimes) {
      const tr = this.trips.get(tripId);
      if (!tr) continue;
      const key = `${tr.route_id}|${tr.direction_id}|${rows.map((r) => r.stopId).join(">")}`;
      if (!this.patterns.has(key)) {
        this.patterns.set(key, { id: key, routeId: tr.route_id, dir: +tr.direction_id, headsign: tr.trip_headsign,
          stopIds: rows.map((r) => r.stopId), shapeId: tr.shape_id, trips: [] });
      }
      this.patterns.get(key).trips.push(tripId);
      this.tripPattern.set(tripId, key);
    }

    this.shapes = new Map();
    for (const p of shapes) {
      if (!this.shapes.has(p.shape_id)) this.shapes.set(p.shape_id, []);
      this.shapes.get(p.shape_id).push([+p.shape_pt_lat, +p.shape_pt_lon, +p.shape_dist_traveled, +p.shape_pt_sequence]);
    }
    for (const v of this.shapes.values()) v.sort((a, b) => a[3] - b[3]);

    this.cell = 0.005;
    this.grid = new Map();
    for (const s of this.stops.values()) {
      const k = this.#cellKey(s.lat, s.lon);
      if (!this.grid.has(k)) this.grid.set(k, []);
      this.grid.get(k).push(s);
    }
  }

  #cellKey(lat, lon) { return `${Math.floor(lat / this.cell)},${Math.floor(lon / this.cell)}`; }

  activeServices(date, { calendarOnly = false } = {}) {
    const day = weekdayName(date), on = new Set();
    for (const [id, c] of this.calendar) {
      if (c[day] === "1" && +c.start_date <= date && date <= +c.end_date) on.add(id);
    }
    if (!calendarOnly) {
      for (const d of this.calendarDates.get(date) || []) {
        if (d.exception_type === "1") on.add(d.service_id); else if (d.exception_type === "2") on.delete(d.service_id);
      }
    }
    return on;
  }

  tripsOn(date) {
    const on = this.activeServices(date);
    return [...this.trips.values()].filter((t) => on.has(t.service_id));
  }

  stopsNear(lat, lon, radius) {
    const span = Math.ceil(radius / 400) + 1, out = [];
    const ci = Math.floor(lat / this.cell), cj = Math.floor(lon / this.cell);
    for (let i = ci - span; i <= ci + span; i++) {
      for (let j = cj - span; j <= cj + span; j++) {
        for (const s of this.grid.get(`${i},${j}`) || []) {
          const d = metres(lat, lon, s.lat, s.lon);
          if (d <= radius) out.push({ stop: s, d });
        }
      }
    }
    return out.sort((a, b) => a.d - b.d || (a.stop.stop_id < b.stop.stop_id ? -1 : 1));
  }

  shape(shapeId) { return this.shapes.get(shapeId) || []; }
}
