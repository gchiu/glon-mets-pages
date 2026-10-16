
const BASE = "https://api.opendata.metlink.org.nz/v1/stop-predictions";

export const DELAY_MIN_S = -1800;
export const DELAY_MAX_S = 3 * 3600;

function wall(iso) {
  const m = typeof iso === "string" && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(iso);
  if (!m) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return { date: +m[1] * 10000 + +m[2] * 100 + +m[3], secs: +m[4] * 3600 + +m[5] * 60 + +(m[6] || 0), ms };
}
function dayOffset(date, serviceDate) {
  const d = (n) => Date.UTC(Math.floor(n / 10000), Math.floor(n / 100) % 100 - 1, n % 100);
  return Math.round((d(date) - d(serviceDate)) / 86400000);
}

export function isoDurationSecs(s) {
  const m = typeof s === "string" && /^(-)?PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(s);
  if (!m || s.endsWith("PT")) return null;
  const v = (+(m[2] || 0)) * 3600 + (+(m[3] || 0)) * 60 + (+(m[4] || 0));
  return Math.round(m[1] ? -v : v);
}

export function normalisePrediction(p, serviceDate) {
  const leg = p.departure && p.departure.aimed ? p.departure : p.arrival || {};
  const aimed = wall(leg.aimed), expected = leg.expected ? wall(leg.expected) : null;
  if (!p.trip_id || !aimed) return null;
  let delay = expected ? Math.round((expected.ms - aimed.ms) / 1000) : null;
  if (delay != null && (delay < DELAY_MIN_S || delay > DELAY_MAX_S)) delay = null;
  const cancelled = /cancel/i.test(String(p.status || ""));
  const live = p.monitored === true && delay != null && !cancelled;
  return {
    tripId: String(p.trip_id),
    stopId: String(p.stop_id ?? ""),
    route: p.service_id != null ? String(p.service_id) : "",
    direction: p.direction || "",
    headsign: p.trip_headsign || "",
    vehicleId: p.vehicle_id != null ? String(p.vehicle_id) : null,
    monitored: p.monitored === true,
    status: p.status ?? null,
    aimed: aimed.secs + 86400 * (serviceDate ? dayOffset(aimed.date, serviceDate) : 0),
    expected: expected ? expected.secs + 86400 * (serviceDate ? dayOffset(expected.date, serviceDate) : 0) : null,
    delay: live ? delay : null,
    reportedDelay: isoDurationSecs(p.delay),
    live,
  };
}

export function normaliseStopPredictions(json, serviceDate) {
  const list = Array.isArray(json) ? json : (json && Array.isArray(json.departures) ? json.departures : null);
  if (!list) return null;
  return list.map((p) => normalisePrediction(p, serviceDate)).filter(Boolean);
}

export const RATE = { perSecond: 10, burst: 20 };
export class TokenBucket {
  constructor({ perSecond = RATE.perSecond, burst = RATE.burst, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    this.rate = perSecond / 1000; this.burst = burst; this.tokens = burst; this.now = now; this.sleep = sleep; this.t = now();
    this.queue = Promise.resolve();
  }
  #refill() { const t = this.now(); this.tokens = Math.min(this.burst, this.tokens + (t - this.t) * this.rate); this.t = t; }
  take() {
    const turn = this.queue.then(async () => {
      this.#refill();
      while (this.tokens < 1) { await this.sleep(Math.ceil((1 - this.tokens) / this.rate)); this.#refill(); }
      this.tokens -= 1;
    });
    this.queue = turn.catch(() => {});
    return turn;
  }
}

export const API_ORIGIN = "https://api.opendata.metlink.org.nz";
const VERIFY = API_ORIGIN + "/v1/gtfs-rt/servicealerts";
export class MetlinkStopPredictions {
  constructor({ apiKey, fetchImpl = globalThis.fetch, timeoutMs = 8000, limiter = new TokenBucket() }) {
    if (!apiKey) throw new Error("a Metlink API key is required");
    const key = String(apiKey);
    this.headers = () => ({ Accept: "application/json", "x-api-key": key });
    this.fetch = (url, opts) => fetchImpl(url, opts);
    this.timeoutMs = timeoutMs;
    this.limiter = limiter;
  }

  async #get(url, read) {
    await this.limiter.take();
    const ctl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), this.timeoutMs) : null;
    try {
      const r = await this.fetch(url, { headers: this.headers(), signal: ctl ? ctl.signal : undefined, cache: "no-store", credentials: "omit" });
      if (!r.ok) return { ok: false, error: `http-${r.status}`, auth: r.status === 401 || r.status === 403 };
      return read(r);
    } catch (e) {
      return { ok: false, error: e && e.name === "AbortError" ? "timeout" : "network" };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  stop(stopId, serviceDate) {
    return this.#get(`${BASE}?stop_id=${encodeURIComponent(stopId)}`, async (r) => {
      const facts = normaliseStopPredictions(await r.json(), serviceDate);
      return facts ? { ok: true, facts } : { ok: false, error: "bad-response" };
    });
  }

  verify() { return this.#get(VERIFY, async () => ({ ok: true })); }
}

export class RealtimePoller {
  constructor({ source, host, intervalS = 30, maxStops = 8, onStatus = () => {} }) {
    this.source = source;
    this.host = host;
    this.intervalS = intervalS;
    this.maxStops = maxStops;
    this.onStatus = onStatus;
    this.lastPoll = -Infinity;
    this.lastGen = null;
    this.busy = false;
    this.status = { state: source ? "waiting" : "off", lastOk: null, stops: 0, detail: "" };
  }

  #set(patch) { this.status = { ...this.status, ...patch }; this.onStatus(this.status); }

  tick(secs) {
    if (!this.source || this.busy) return null;
    const p = this.host.state.realtime;
    if (!p) return null;
    if (p.gen === this.lastGen && secs - this.lastPoll < this.intervalS) return null;
    return this.poll();
  }

  async poll() {
    if (!this.source) return this.status;
    const stops = this.host.realtimeStops(this.maxStops);
    if (!stops.length) return this.status;
    const clock = this.host.lastClock;
    const seen = clock ? clock.secs : 0, date = clock ? clock.date : null;
    this.busy = true;
    this.lastPoll = seen;
    this.lastGen = this.host.state.realtime ? this.host.state.realtime.gen : null;
    try {
      const answers = await Promise.all(stops.map((s) => this.source.stop(s, date)));
      if (answers.some((a) => a.auth)) {
        this.host.realtimeLost();
        this.#set({ state: "auth", detail: answers.find((a) => a.auth).error, stops: 0 });
        return this.status;
      }
      let ok = 0;
      answers.forEach((a, i) => { if (a.ok) { ok++; this.host.stopRealtime(stops[i], a.facts, seen); } });
      if (ok) {
        this.host.realtimeEnd(seen);
        this.#set({ state: "live", lastOk: seen, stops: ok, detail: ok < stops.length ? `${stops.length - ok} stop(s) failed` : "" });
      } else {
        this.#set({ state: "error", detail: answers[0].error, stops: 0 });
      }
      return this.status;
    } finally {
      this.busy = false;
    }
  }
}
