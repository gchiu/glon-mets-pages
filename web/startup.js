
export function startupMode(search) {
  return new URLSearchParams(search || "").get("demo") === "1" ? "demo" : "passenger";
}

export function passengerUrl(href) {
  const u = new URL(href);
  u.searchParams.delete("demo");
  return u.toString();
}

export function locationProblem(e) {
  switch (e && e.code) {
    case 1: return "Location access is off. Allow location for this site to plan a journey from where you are.";
    case 2: return "Your location is not available right now. Check that location services are on.";
    case 3: return "Still looking for your location…";
    default: return e && e.message ? `Location: ${e.message}` : "Location is not available.";
  }
}
