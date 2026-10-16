
export class PlatformEffects {
  constructor({ sound = true } = {}) {
    this.sound = sound;
    this.audio = null;
  }

  prime() {
    try {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (AC && !this.audio) this.audio = new AC();
    } catch { this.audio = null; }
    try {
      if (globalThis.Notification && Notification.permission === "default") Notification.requestPermission();
    } catch { /* not available */ }
  }

  alert(level, label) {
    const nav = globalThis.navigator;
    try { if (nav && nav.vibrate) nav.vibrate(level >= 2 ? [300, 120, 300, 120, 300] : [200]); } catch { /* ignore */ }
    if (this.sound) this.beep(level);
    try {
      if (level >= 2 && globalThis.Notification && Notification.permission === "granted" &&
          globalThis.document && document.visibilityState !== "visible") {
        new Notification("DoorDash", { body: label.replace(/_/g, " "), tag: "doordash-alert", renotify: true });
      }
    } catch { /* ignore */ }
  }

  beep(level) {
    const a = this.audio;
    if (!a) return;
    try {
      const n = level >= 2 ? 3 : 1;
      for (let i = 0; i < n; i++) {
        const o = a.createOscillator(), g = a.createGain();
        o.frequency.value = level >= 2 ? 880 : 660;
        g.gain.value = 0.15;
        o.connect(g).connect(a.destination);
        const t = a.currentTime + i * 0.25;
        o.start(t); o.stop(t + 0.15);
      }
    } catch { /* ignore */ }
  }
}
