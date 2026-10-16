
const MAX_BLOCK = 511;     // elements per Glon block (a measured limit of the pinned runtime)
const MAX_SOURCE = 16383;  // glon_load source limit (ABI: len < 16384)
export const POINTS_PER_CHUNK = 170;   // 510 elements: must match PCH in glon/route-match.glon

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

function chunk(list, n) {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

export function patternSource(p, proj) {
  const pts = [];
  let lastD = -1;
  for (const [lat, lon, d] of p.points) {
    const dm = Math.round(d);
    if (dm <= lastD) continue;
    const [x, y] = proj.toXY(lat, lon);
    pts.push([x, y, dm]);
    lastD = dm;
  }
  if (p.stops.length * 5 > MAX_BLOCK) throw new Error("too many stops for one block");
  const chunks = chunk(pts, POINTS_PER_CHUNK).map((c) => "[ " + c.map((q) => q.join(" ")).join("  ") + " ]");
  const rows = p.stops.map((s) => { const [x, y] = proj.toXY(s.lat, s.lon); return `${Math.round(s.dist_m)} 0 ${x} ${y} ${s.seq}`; });
  return checkSource(
    `[\npat-put ${p.patNo} ${glonString(p.name)} ${glonString(p.headsign)} ${pts.length} [\n${chunks.join("\n")}\n]\n` +
    `${p.stops.length} [\n${rows.join("\n")}\n]\n]\n`, `pattern ${p.patNo}`);
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
    `[\ndest-n: ${profile.favourites.length}\ndest-row: [ ${rows.join("  ")} ]\n` +
    `pf-conc: ${conc}\nprefs: [ ${prefs.join(" ")} ]\n]\n`,
    "profile");
}
