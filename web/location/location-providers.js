
export class BrowserLocationProvider {
  constructor(geolocation = globalThis.navigator && globalThis.navigator.geolocation) {
    this.geo = geolocation;
    this.watch = null;
    this.onError = () => {};
  }
  get available() { return !!this.geo; }
  start(onFix) {
    if (!this.geo) { this.onError(new Error("Geolocation is not available in this browser")); return; }
    this.watch = this.geo.watchPosition(
      (p) => onFix({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy }),
      (e) => this.onError(e),
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
  }
  stop() { if (this.watch != null) this.geo.clearWatch(this.watch); this.watch = null; }
}

export class SimulatedLocationProvider {
  constructor(track) { this.track = track; this.onFix = null; }
  get available() { return true; }
  start(onFix) { this.onFix = onFix; }
  stop() { this.onFix = null; }
  advance(t) { if (this.onFix) this.onFix(this.track(t)); }
}
