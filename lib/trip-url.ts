import { STYLE_TAGS, type StyleTag } from './types';
import { PLACES } from './data';

/**
 * The trip IS the URL.
 *
 * Per core-loop.md this is architecture, not a convenience: planning happens at
 * a desk days before travel and execution happens on a phone in a car. Anything
 * held in localStorage breaks that, because the plan has to cross devices. The
 * link is also how the plan reaches the three friends coming along, so sharing
 * and saving are the same action and there is nothing to log into.
 *
 * Every parameter is therefore readable and hand-editable — no opaque encoding.
 * A URL someone can read is a URL someone can trust and repair.
 */
export interface Trip {
  /** Route origin. Absent means this is a point search, not a corridor. */
  from?: string;
  /** Destination, or the anchor for a point search. */
  to?: string;
  styles: StyleTag[];
  radiusKm?: number;
  requireBottleShop?: boolean;
  requireFood?: boolean;
}

const isPlace = (v: unknown): v is string => typeof v === 'string' && v in PLACES;
const isStyle = (v: string): v is StyleTag => (STYLE_TAGS as readonly string[]).includes(v);

/** Next 16 hands `searchParams` in as a Promise; the caller awaits it. */
export type RawParams = Record<string, string | string[] | undefined>;

const one = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

export function parseTrip(params: RawParams): Trip {
  const from = one(params.from);
  const to = one(params.to);
  const radius = Number(one(params.radius));

  return {
    from: isPlace(from) ? from : undefined,
    to: isPlace(to) ? to : undefined,
    styles: (one(params.styles) ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(isStyle),
    // A hand-edited radius of 9999 shouldn't return the whole province, and
    // NaN shouldn't silently become the default.
    radiusKm: Number.isFinite(radius) ? Math.min(Math.max(radius, 1), 150) : undefined,
    requireBottleShop: one(params.shop) === '1',
    requireFood: one(params.food) === '1',
  };
}

/** Only non-default values are written, so a simple trip has a short link. */
export function tripToSearch(trip: Trip): string {
  const p = new URLSearchParams();
  if (trip.from) p.set('from', trip.from);
  if (trip.to) p.set('to', trip.to);
  if (trip.styles.length) p.set('styles', trip.styles.join(','));
  if (trip.radiusKm) p.set('radius', String(trip.radiusKm));
  if (trip.requireBottleShop) p.set('shop', '1');
  if (trip.requireFood) p.set('food', '1');
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** A trip with nowhere to go can't be ranked — used to pick the empty state. */
export function isRunnable(trip: Trip): boolean {
  return Boolean(trip.to);
}

export function isRoute(trip: Trip): boolean {
  return Boolean(trip.from && trip.to && trip.from !== trip.to);
}

/** Human-readable summary for headings and share text. */
export function describeTrip(trip: Trip): string {
  const to = trip.to ? PLACES[trip.to].label : '';
  if (isRoute(trip)) return `${PLACES[trip.from!].label} → ${to}`;
  return to;
}
