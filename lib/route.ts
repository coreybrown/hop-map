/**
 * Real driving routes, so a "detour" means leaving an actual road.
 *
 * The straight-line corridor was a reasonable approximation with no network
 * cost, but it answers the wrong question: Kingston to Toronto is 264 km of
 * highway bending around Lake Ontario, and a chord across the water is not a
 * route anyone drives. It also can't answer "which roads do I take", which is
 * the thing a trip planner is for.
 *
 * OSRM's public demo server is used here because it needs no key and returns
 * full road geometry. It is explicitly NOT for production traffic — before
 * this gets real usage, move to a hosted OSRM, Valhalla, or a keyed provider.
 * Failure is handled by falling back to the straight-line corridor rather
 * than by breaking the page.
 */

export interface RoutePoint {
  lat: number;
  lng: number;
}

export interface DrivingRoute {
  /** Road geometry, origin → destination. */
  path: RoutePoint[];
  distanceKm: number;
  durationMin: number;
  /** True when routing failed and this is the straight line instead. */
  approximated: boolean;
}

const OSRM = 'https://router.project-osrm.org/route/v1/driving';

export async function fetchDrivingRoute(
  origin: RoutePoint,
  destination: RoutePoint,
  signal?: AbortSignal,
): Promise<DrivingRoute> {
  const straightLine: DrivingRoute = {
    path: [origin, destination],
    distanceKm: 0,
    durationMin: 0,
    approximated: true,
  };

  try {
    const url =
      `${OSRM}/${origin.lng},${origin.lat};${destination.lng},${destination.lat}` +
      `?overview=full&geometries=geojson`;
    const res = await fetch(url, { signal });
    if (!res.ok) return straightLine;

    const data = await res.json();
    const route = data?.routes?.[0];
    if (data?.code !== 'Ok' || !route?.geometry?.coordinates?.length) return straightLine;

    return {
      // GeoJSON is [lng, lat]; everything else here is {lat, lng}.
      path: route.geometry.coordinates.map(([lng, lat]: [number, number]) => ({ lat, lng })),
      distanceKm: route.distance / 1000,
      durationMin: route.duration / 60,
      approximated: false,
    };
  } catch {
    // Aborted, offline, or the demo server refused. A worse route beats a
    // broken page — the caller shows that it's approximate.
    return straightLine;
  }
}

/** "3 h 20 min" — the unit a driver thinks in. */
export function formatDuration(minutes: number): string {
  if (!minutes) return '';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}
