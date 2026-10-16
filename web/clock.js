
const WD = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function civilTime(date, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-NZ", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short",
  }).formatToParts(date).map((p) => [p.type, p.value]));
  return {
    secs: +parts.hour * 3600 + +parts.minute * 60 + +parts.second,
    date: +(parts.year + parts.month + parts.day),
    weekday: WD[parts.weekday],
  };
}

export class SystemClock {
  constructor(timeZone, periodMs = 1000) { this.tz = timeZone; this.periodMs = periodMs; this.timer = null; }
  now() { return civilTime(new Date(), this.tz); }
  start(onTime) { onTime(this.now()); this.timer = setInterval(() => onTime(this.now()), this.periodMs); }
  stop() { clearInterval(this.timer); this.timer = null; }
}

export class SimClock {
  constructor({ date, weekday }) { this.date = date; this.weekday = weekday; this.onTime = null; }
  start(onTime) { this.onTime = onTime; }
  stop() { this.onTime = null; }
  advance(secs) { if (this.onTime) this.onTime({ secs, date: this.date, weekday: this.weekday }); }
}

export function hms(text) { const [h, m, s = 0] = text.split(":").map(Number); return h * 3600 + m * 60 + s; }
