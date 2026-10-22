
const MAX_SOURCE = 16383;  // glon_load source limit (ABI: len < 16384)

export function glonString(text) {
  const s = String(text)
    .replace(/"/g, "'")                           // Glon string literals have no escape
    .replace(/;;/g, "; ;")                        // the loader strips ";;" comments
    .replace(/<%/g, "< %");                       // the fragment renderer runs <% ... %>
  if (/[\x00-\x1f]/.test(s)) throw new Error("control character in text: " + JSON.stringify(text));
  if (new TextEncoder().encode(s).length > 200) throw new Error("text too long for display: " + text);
  return '"' + s + '"';
}

export function glonWord(w) {
  if (!/^[a-z][a-z0-9-]*$/.test(w)) throw new Error("not a safe Glon word: " + w);
  return w;
}

function checkSource(src, name) {
  if (new TextEncoder().encode(src).length > MAX_SOURCE) throw new Error(`${name}: Glon source over 16 KiB`);
  return src;
}

export function profileSource(profile, proj) {
  const rows = profile.favourites.map((f) => {
    if (f.lat == null || f.lon == null) return "0 0 0";
    const [x, y] = proj.toXY(f.lat, f.lon);
    return `1 ${x} ${y}`;
  });
  const prefs = Object.entries(profile.preferences)
    .filter(([k]) => !k.startsWith("_"))
    .map(([k, v]) => {
      if (!Number.isInteger(v)) throw new Error(`preference ${k} must be an integer`);
      return `[${glonWord(k)} ${v}]`;
    });
  const conc = profile.concession ? `'${glonWord(profile.concession)}` : "none";
  return checkSource(
    `[\ndest-n: ${profile.favourites.length}\ndest-row: [ ${["0 0 0", ...rows].join("  ")} ]\n` +
    `pf-conc: ${conc}\nprefs: [ ${prefs.join(" ")} ]\n]\n`,
    "profile");
}
