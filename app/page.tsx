import { OPEN_BREWERIES, PLACES } from '@/lib/data';
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

  const places: Place[] = Object.entries(PLACES).map(([key, p]) => ({ key, ...p }));

  return <MapApp breweries={OPEN_BREWERIES} places={places} initialTrip={trip} />;
}
