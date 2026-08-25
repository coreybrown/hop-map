import registryData from '@/data/registry.json';
import releasesData from '@/data/releases.json';
import type { Brewery, Release } from './types';

/**
 * Single source of truth for the app: the geocoded registry joined with
 * best-effort release data. Static JSON committed to the repo and refreshed
 * by the scripts in /scripts, so the whole product runs with no database and
 * no runtime API calls.
 *
 * Reads `registry.json`, NOT `breweries.json`. The latter is the hand-curated
 * seed of 63 that `build-registry.mjs` consumes as one input among several —
 * serving it directly would show a quarter of Ontario and none of the OSM
 * coverage, contact details, awards or corrections.
 */
const releases = (releasesData as { releases: Record<string, Release[]> }).releases;

const ALL: Brewery[] = (registryData.breweries as unknown as Brewery[]).map((brewery) => ({
  ...brewery,
  releases: releases[brewery.id],
}));

/**
 * What the product actually offers.
 *
 * Excludes the 18 records a human confirmed are not breweries (pubs OSM swept
 * in under `craft=brewery`, a distillery, a coffee shop) and anything closed.
 * Both judgements live in `data/corrections.json` and are applied at build
 * time by `build-registry.mjs` — see that file before changing this filter.
 */
export const BREWERIES: Brewery[] = ALL.filter(
  (b) => (b as Brewery & { isBrewery?: boolean }).isBrewery !== false,
);

export const OPEN_BREWERIES = BREWERIES.filter((b) => b.status !== 'closed');

/** Everything, closed and excluded included — for maps and admin views. */
export const ALL_RECORDS = ALL;

export const RELEASES_GENERATED_AT = releasesData.generatedAt;
export const REGISTRY_GENERATED_AT = registryData.generatedAt;

/** ODbL requires attribution wherever OSM-derived data is shown. */
export const ATTRIBUTION = registryData.attribution;

/** Places people actually name when saying where they're going. */
export const PLACES: Record<string, { label: string; lat: number; lng: number }> = {
  toronto: { label: 'Toronto', lat: 43.6532, lng: -79.3832 },
  ottawa: { label: 'Ottawa', lat: 45.4215, lng: -75.6972 },
  kingston: { label: 'Kingston', lat: 44.2312, lng: -76.486 },
  hamilton: { label: 'Hamilton', lat: 43.2557, lng: -79.8711 },
  london: { label: 'London', lat: 42.9849, lng: -81.2453 },
  kitchener: { label: 'Kitchener', lat: 43.4516, lng: -80.4925 },
  guelph: { label: 'Guelph', lat: 43.5448, lng: -80.2482 },
  niagara: { label: 'Niagara Falls', lat: 43.0896, lng: -79.0849 },
  windsor: { label: 'Windsor', lat: 42.3149, lng: -83.0364 },
  barrie: { label: 'Barrie', lat: 44.3894, lng: -79.6903 },
  peterborough: { label: 'Peterborough', lat: 44.3091, lng: -78.3197 },
  belleville: { label: 'Belleville', lat: 44.1628, lng: -77.3832 },
  picton: { label: 'Picton', lat: 44.0084, lng: -77.1372 },
  gravenhurst: { label: 'Gravenhurst', lat: 44.9167, lng: -79.3667 },
  sudbury: { label: 'Sudbury', lat: 46.49, lng: -80.9906 },
};

export const PLACE_KEYS = Object.keys(PLACES);

/**
 * Every town that actually has a brewery, derived from the registry.
 *
 * The 15 hand-listed cities above are the ones people name in the abstract;
 * these are the ones the data can answer for. Coordinates are the centroid of
 * that town's breweries, which is a better anchor than a civic centre — it is
 * the middle of the thing you came for.
 *
 * OSM's `city` field is unreliable on roughly half these records (it often
 * holds a street address), so anything starting with a digit or reading like a
 * street is dropped rather than offered as a town.
 */
const LOOKS_LIKE_STREET = /^\d|\b(street|road|avenue|ave|rd|st|drive|hwy|highway|line|concession)\b/i;

export const REGISTRY_TOWNS: Array<{ key: string; label: string; lat: number; lng: number }> =
  Object.entries(
    BREWERIES.filter((b) => b.status !== 'closed').reduce<Record<string, Brewery[]>>(
      (acc, b) => {
        const city = (b.city ?? '').trim();
        if (!city || LOOKS_LIKE_STREET.test(city)) return acc;
        (acc[city] ??= []).push(b);
        return acc;
      },
      {},
    ),
  ).map(([label, list]) => ({
    key: `@${(list.reduce((n, b) => n + b.lat!, 0) / list.length).toFixed(4)},${(
      list.reduce((n, b) => n + b.lng!, 0) / list.length
    ).toFixed(4)}`,
    label,
    lat: list.reduce((n, b) => n + b.lat!, 0) / list.length,
    lng: list.reduce((n, b) => n + b.lng!, 0) / list.length,
  }));
