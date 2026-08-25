import { OPEN_BREWERIES, PLACES, REGISTRY_TOWNS } from '@/lib/data';
import { parseTrip } from '@/lib/trip-url';
import { MapApp, type Place } from '@/components/map-app';

/**
 * A map you search breweries on.
 *
 * The server's only jobs are to read the shared link and to hand over the
 * dataset; everything after that is client-side, because on a map a full page
 * navigation for "also show me sours" reads as broken. The registry trims to
 * ~25KB gzipped, which is cheaper than a round trip per filter change.
 */
export default async function Home(props: PageProps<'/'>) {
  const trip = parseTrip(await props.searchParams);

  /**
   * The named cities first, then every town the registry can answer for.
   * Anything beyond these is looked up live — see PlaceSearch.
   */
  const named = Object.entries(PLACES).map(([key, p]) => ({ key, ...p }));
  const namedLabels = new Set(named.map((p) => p.label));
  const places: Place[] = [
    ...named,
    ...REGISTRY_TOWNS.filter((t) => !namedLabels.has(t.label)),
  ];

  return <MapApp breweries={OPEN_BREWERIES} places={places} initialTrip={trip} />;
}
