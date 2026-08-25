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
  /** Human name for a coordinate anchor, so shared links stay legible. */
  toLabel?: string;
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

/**
 * An anchor can be a preset city key OR a raw coordinate, written `@lat,lng`.
 *
 * The 15 presets can't express "near this brewery" or "near where I'm standing",
 * and both are real cases — Corey's own example was standing in Toronto wanting
 * the best IPA nearby. The `@` form stays readable and hand-editable, which is
 * the same rule the rest of these parameters follow: a URL someone can read is
 * a URL someone can repair.
 */
const COORD = /^@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/;

export function parseAnchor(value: string | undefined): AnchorPoint | null {
  if (!value) return null;
  if (isPlace(value)) return { key: value, ...PLACES[value] };

  const m = COORD.exec(value);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  // Ontario-ish sanity bounds: a hand-edited or stale coordinate shouldn't
  // silently send the map to the middle of the Atlantic.
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < 41 || lat > 57 || lng < -96 || lng > -73) return null;
  return { key: value, label: labelFor(value) ?? 'Custom location', lat, lng };
}

/**
 * Names for coordinate anchors, carried in the URL as `&n=`.
 *
 * Without this, searching "Orangeville" set the anchor to @43.9193,-80.0974
 * and the field then read "Custom location" — the app forgetting the word you
 * just typed, and a shared link arriving with no idea where it points.
 */
const anchorLabels = new Map<string, string>();

export function rememberAnchorLabel(key: string, label: string): void {
  anchorLabels.set(key, label);
}

function labelFor(key: string): string | undefined {
  return anchorLabels.get(key);
}

export interface AnchorPoint {
  key: string;
  label: string;
  lat: number;
  lng: number;
}

/** Round hard: six decimals is centimetres and makes links needlessly long. */
export function coordKey(lat: number, lng: number): string {
  return `@${lat.toFixed(4)},${lng.toFixed(4)}`;
}
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
    from: parseAnchor(from) ? from : undefined,
    to: parseAnchor(to) ? to : undefined,
    styles: (one(params.styles) ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(isStyle),
    // A hand-edited radius of 9999 shouldn't return the whole province, and
    // NaN shouldn't silently become the default.
    radiusKm: Number.isFinite(radius) ? Math.min(Math.max(radius, 1), 150) : undefined,
    toLabel: one(params.n) || undefined,
    requireBottleShop: one(params.shop) === '1',
    requireFood: one(params.food) === '1',
  };
}

/** Only non-default values are written, so a simple trip has a short link. */
export function tripToSearch(trip: Trip): string {
  const p = new URLSearchParams();
  if (trip.from) p.set('from', trip.from);
  if (trip.to) p.set('to', trip.to);
  if (trip.toLabel) p.set('n', trip.toLabel);
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
  const to = parseAnchor(trip.to)?.label ?? '';
  const from = parseAnchor(trip.from)?.label;
  if (isRoute(trip) && from) return `${from} → ${to}`;
  return to;
}
