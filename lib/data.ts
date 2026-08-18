import breweriesData from '@/data/breweries.json';
import releasesData from '@/data/releases.json';
import type { Brewery, Release } from './types';

/**
 * Single source of truth for the app: the geocoded brewery registry joined
 * with best-effort release data. Both are static JSON committed to the repo
 * and refreshed by the scripts in /scripts, so the whole product runs with
 * no database and no runtime API calls.
 */
const releases = releasesData.releases as Record<string, Release[]>;

export const BREWERIES: Brewery[] = (
  breweriesData.breweries as unknown as Brewery[]
).map((brewery) => ({
  ...brewery,
  releases: releases[brewery.id],
}));

export const OPEN_BREWERIES = BREWERIES.filter((b) => b.status !== 'closed');

export const RELEASES_GENERATED_AT = releasesData.generatedAt;
export const BREWERIES_GENERATED_AT = breweriesData.generatedAt;

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
