
const R = 6371000;

export function makeProjection({ lat, lon }) {
  const k = Math.cos(lat * Math.PI / 180);
  return {
    toXY(la, lo) {
      return [
        Math.round((lo - lon) * Math.PI / 180 * k * R),
        Math.round((la - lat) * Math.PI / 180 * R),
      ];
    },
    toLatLon(x, y) {
      return [lat + y / R * 180 / Math.PI, lon + x / (R * k) * 180 / Math.PI];
    },
  };
}

export function metresBetween(aLat, aLon, bLat, bLon) {
  const x = (bLon - aLon) * Math.PI / 180 * Math.cos((aLat + bLat) / 2 * Math.PI / 180);
  const y = (bLat - aLat) * Math.PI / 180;
  return Math.hypot(x, y) * R;
}
