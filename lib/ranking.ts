import type { Brewery, Release, ScoredBrewery, StyleTag } from './types';
import { STYLE_LABELS } from './types';

/** A release stops counting as "new" past this. */
const RELEASE_WINDOW_DAYS = 45;

function daysAgo(iso: string, now: Date): number {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return Infinity;
  return Math.floor((now.getTime() - then) / 86_400_000);
}

/**
 * The freshest in-stock release matching a style the group asked for.
 *
 * This is the "connect the dots" moment: the route picks the breweries, the
 * taste picks which of them fit, and a matching new release is what turns a
 * good stop into one worth making today. Releases are never browsed on their
 * own — they only ever appear as evidence inside a recommendation.
 */
function matchingRelease(
  brewery: Brewery,
  wanted: StyleTag[],
  now: Date,
): { release: Release; days: number; style: StyleTag } | null {
  if (!brewery.releases?.length || wanted.length === 0) return null;

  let best: { release: Release; days: number; style: StyleTag } | null = null;

  for (const release of brewery.releases) {
    if (!release.available) continue;
    const days = daysAgo(release.firstSeen, now);
    if (days > RELEASE_WINDOW_DAYS) continue;

    const style = release.styles.find((s) => wanted.includes(s));
    if (!style) continue;

    if (!best || days < best.days) best = { release, days, style };
  }

  return best;
}

/**
 * Untappd's weighted average is not comparable across styles: its own
 * published top-styles lists contain zero lagers, and enthusiast styles
 * (triple hazies, imperial stouts, barrel-aged) sit ~0.5 higher than
 * clean lagers brewed to the same standard.
 *
 * These are the approximate per-style baselines a competent example of the
 * style scores. We rank on the DIFFERENCE from baseline, so a 3.8 pilsner
 * brewery outranks a 3.9 hazy brewery — which is the whole point.
 */
const STYLE_BASELINE: Record<StyleTag, number> = {
  'hazy-ipa': 3.9,
  'west-coast-ipa': 3.8,
  'pale-ale': 3.6,
  'pilsner-lager': 3.4,
  'dark-lager': 3.5,
  'stout-porter': 3.8,
  sour: 3.8,
  'wild-ale': 3.9,
  'farmhouse-saison': 3.7,
  'wheat-belgian': 3.6,
  'barrel-aged': 4.0,
  'session-low-alc': 3.4,
  // NA beer is rated against beer, not against other NA beer, so the crowd
  // marks it down as a category. Judging it by the all-beer average would
  // make every NA specialist look bad at what they are actually good at.
  'non-alcoholic': 3.2,
  kolsch: 3.5,
  'amber-red': 3.5,
};

const EARTH_RADIUS_KM = 6371;
const toRad = (deg: number) => (deg * Math.PI) / 180;

export function haversineKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/**
 * How far a brewery sits off the straight line between origin and
 * destination, and how far along that line it falls (0 = origin, 1 =
 * destination). Uses an equirectangular projection, which is accurate
 * enough at Ontario scale and avoids a routing API call entirely.
 */
export function corridorPosition(
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number },
  point: { lat: number; lng: number },
): { offRouteKm: number; t: number } {
  const latScale = Math.cos(toRad((origin.lat + destination.lat) / 2));
  const project = (p: { lat: number; lng: number }) => ({
    x: toRad(p.lng) * latScale * EARTH_RADIUS_KM,
    y: toRad(p.lat) * EARTH_RADIUS_KM,
  });

  const a = project(origin);
  const b = project(destination);
  const p = project(point);

  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lenSq = abx * abx + aby * aby;
  if (lenSq === 0) {
    return { offRouteKm: haversineKm(origin, point), t: 0 };
  }

  const t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq;
  const clamped = Math.max(0, Math.min(1, t));
  const cx = a.x + clamped * abx;
  const cy = a.y + clamped * aby;
  const offRouteKm = Math.hypot(p.x - cx, p.y - cy);

  return { offRouteKm, t };
}

/**
 * Style fit, 0–1. A brewery's `styles` array is ordered by how central the
 * style is to what they do, so an early match counts for more than a late
 * one: Godspeed listing pilsner first means more than a brewery that
 * happens to make one.
 */
export interface StyleMatch {
  /** Styles they are genuinely known for — the reason to go. */
  knownFor: StyleTag[];
  /** Styles they merely stock — true, but not a reason to drive anywhere. */
  offersOnly: StyleTag[];
  fit: number;
}

/**
 * Score how well a brewery answers "I want X".
 *
 * A reputation match is worth roughly three times an availability match.
 * Most breweries have a hazy on tap, so "they have one" is close to no
 * information; "their hazy is the reason people drive out there" is the
 * entire value of the product.
 */
function styleFit(brewery: Brewery, wanted: StyleTag[]): StyleMatch {
  const knownFor = wanted.filter((s) => brewery.styles.knownFor.includes(s));
  const offersOnly = wanted.filter(
    (s) => !brewery.styles.knownFor.includes(s) && brewery.styles.offers.includes(s),
  );

  if (wanted.length === 0) return { knownFor, offersOnly, fit: 0.5 };

  const REPUTATION = 1;
  const AVAILABILITY = 0.32;

  let total = knownFor.length * REPUTATION + offersOnly.length * AVAILABILITY;

  // Where we have no reputation data at all, availability is the only signal
  // we have — so lean on it a little harder rather than ranking the brewery
  // as though we knew it was mediocre.
  if (brewery.styles.knownFor.length === 0 && offersOnly.length > 0) {
    total = offersOnly.length * 0.5;
  }

  return { knownFor, offersOnly, fit: Math.min(1, total / wanted.length) };
}

/**
 * Style-normalized beer quality, roughly -1..+1. Returns null when we have
 * no Untappd figure — most breweries in the seed don't, and a missing
 * signal must not be treated as a bad one.
 */
function normalizedBeerScore(brewery: Brewery): number | null {
  const raw = brewery.signals.untappd;
  if (raw === undefined) return null;

  // `styles` became {offers, knownFor} in the split; this call was left
  // reading it as a flat array and threw for every brewery that has an
  // Untappd figure. Normalizing a rating asks "hard styles or easy ones do
  // they brew" — that is `offers`, the quantitative field. `knownFor` is
  // reputation and is the wrong question here (and is empty for everyone).
  const baselines = brewery.styles.offers.map((s) => STYLE_BASELINE[s]);
  if (baselines.length === 0) return null;
  const expected = baselines.reduce((a, b) => a + b, 0) / baselines.length;

  return raw - expected;
}

/**
 * Venue quality from Google, with the review-count correction.
 *
 * Destination taprooms in industrial units collect a few hundred reviews
 * from people who went on purpose. Downtown tourist brewpubs collect
 * thousands from people who wanted a patio. A 4.8 from 238 reviewers is a
 * stronger signal about the beer than a 4.6 from 2,800.
 */
function venueScore(brewery: Brewery): number | null {
  const rating = brewery.signals.google;
  if (rating === undefined) return null;

  const count = brewery.signals.googleCount ?? 0;
  let countFactor = 1;
  if (count > 2500) countFactor = 0.6;
  else if (count > 1500) countFactor = 0.75;
  else if (count > 800) countFactor = 0.9;

  return (rating - 4.2) * countFactor;
}

export interface RankQuery {
  styles: StyleTag[];
  /** Search around a single point (hotel, "near me"). */
  anchor?: { lat: number; lng: number };
  /** Search along a route (the 401 case). Takes precedence over anchor. */
  route?: {
    origin: { lat: number; lng: number };
    destination: { lat: number; lng: number };
  };
  /** Max straight-line km from anchor, or max detour off a route. */
  radiusKm?: number;
  /**
   * Route mode only. Breweries this close to the origin are where you
   * already live — nobody driving Toronto to Ottawa wants a stop in
   * Toronto. Set to 0 to include them.
   */
  excludeNearOriginKm?: number;
  requireBottleShop?: boolean;
  requireFood?: boolean;
  requireShipping?: boolean;
  includeClosed?: boolean;
  /** Injectable so results are deterministic in tests. */
  now?: Date;
}

export function rankBreweries(
  breweries: Brewery[],
  query: RankQuery,
): ScoredBrewery[] {
  const radius = query.radiusKm ?? (query.route ? 15 : 25);
  const now = query.now ?? new Date();
  const results: ScoredBrewery[] = [];

  for (const brewery of breweries) {
    if (!query.includeClosed && brewery.status === 'closed') continue;
    if (query.requireBottleShop && !brewery.venue.bottleShop) continue;
    if (query.requireFood && !brewery.venue.food) continue;
    if (query.requireShipping && !brewery.venue.shipsOntario) continue;
    if (brewery.lat === null || brewery.lng === null) continue;

    const point = { lat: brewery.lat, lng: brewery.lng };
    const reasons: string[] = [];
    let distanceKm: number | undefined;
    let detourKm: number | undefined;
    let geoScore = 0;

    if (query.route) {
      const { offRouteKm, t } = corridorPosition(
        query.route.origin,
        query.route.destination,
        point,
      );
      // Drop anything behind the origin or past the destination.
      if (t < -0.05 || t > 1.05) continue;
      if (offRouteKm > radius) continue;

      const fromOrigin = haversineKm(query.route.origin, point);
      if (fromOrigin < (query.excludeNearOriginKm ?? 30)) continue;

      detourKm = Math.round(offRouteKm * 2);
      geoScore = 1 - offRouteKm / radius;
      reasons.push(
        detourKm <= 4
          ? 'Basically on the route'
          : `About a ${detourKm} km round-trip detour`,
      );
    } else if (query.anchor) {
      distanceKm = haversineKm(query.anchor, point);
      if (distanceKm > radius) continue;
      geoScore = 1 - distanceKm / radius;
      reasons.push(
        distanceKm < 1.5
          ? 'Walking distance'
          : `${distanceKm.toFixed(1)} km away`,
      );
    }

    const match = styleFit(brewery, query.styles);
    // Hard filter: with styles requested, a brewery that neither is known for
    // nor stocks any of them is not a near-miss, it's the wrong answer.
    if (query.styles.length > 0 && match.fit === 0) continue;

    const fit = match.fit;

    if (query.styles.length > 0) {
      const label = (list: StyleTag[]) =>
        list.map((s) => STYLE_LABELS[s]).join(' and ');

      // The reason to go: reputation, stated plainly and first.
      if (match.knownFor.length > 0) {
        reasons.push(
          brewery.styleProfile === 'broad'
            ? `Wide range, but it's the ${label(match.knownFor)} people go for`
            : `This is what they're known for — ${label(match.knownFor)}`,
        );
      }

      // Availability, stated honestly as the weaker fact it is.
      if (match.offersOnly.length > 0) {
        reasons.push(
          match.knownFor.length > 0
            ? `Also pours ${label(match.offersOnly)}`
            : `Has ${label(match.offersOnly)} on, though it isn't what they're known for`,
        );
      }

      if (
        query.styles.length > 1 &&
        match.knownFor.length + match.offersOnly.length === query.styles.length
      ) {
        reasons.push(
          match.knownFor.length === query.styles.length
            ? 'Strong on every style your group asked for'
            : 'One stop that covers the whole group',
        );
      }
    }

    const beer = normalizedBeerScore(brewery);
    if (beer !== null && beer > 0.15) {
      reasons.push(
        `Rated well above the norm for what it brews (${brewery.signals.untappd} on Untappd, where its styles usually top out lower)`,
      );
    }

    const venue = venueScore(brewery);
    if (
      venue !== null &&
      brewery.signals.google! >= 4.7 &&
      (brewery.signals.googleCount ?? 0) < 800
    ) {
      reasons.push(
        `${brewery.signals.google} on Google from ${brewery.signals.googleCount} visitors — a destination people go to on purpose`,
      );
    }

    // The closer: something new, in a style they want, that they'd have to
    // show up for. Inserted ahead of the generic reasons because it is the
    // most persuasive thing we can say about a stop.
    const fresh = matchingRelease(brewery, query.styles, now);
    if (fresh) {
      const when =
        fresh.days <= 1
          ? 'today'
          : fresh.days <= 7
            ? `${fresh.days} days ago`
            : `${Math.round(fresh.days / 7)} weeks ago`;
      reasons.unshift(
        `New ${STYLE_LABELS[fresh.style]} released ${when} — ${fresh.release.name}`,
      );
    }

    if (brewery.venue.bottleShop) reasons.push('Bottle shop for takeaway');

    // Never recommend an unconfirmed brewery without saying so — a wasted
    // drive to a closed taproom is the failure this product exists to avoid.
    if (brewery.status === 'unverified') {
      reasons.push("We haven't confirmed this one is still open — call ahead");
    }

    // A fresh matching release is a real tiebreaker but must never let a
    // mediocre brewery outrank a genuinely better one — it decays from +22
    // at same-day to nothing at the end of the window.
    const freshBoost = fresh
      ? 22 * (1 - Math.min(fresh.days, RELEASE_WINDOW_DAYS) / RELEASE_WINDOW_DAYS)
      : 0;

    const score =
      fit * 100 +
      geoScore * 40 +
      (beer ?? 0) * 45 +
      (venue ?? 0) * 15 +
      freshBoost +
      (brewery.venue.bottleShop ? 4 : 0) +
      (brewery.status === 'unverified' ? -25 : 0);

    results.push({
      brewery,
      score,
      reasons,
      distanceKm,
      detourKm,
      freshRelease: fresh
        ? { name: fresh.release.name, style: fresh.style, daysAgo: fresh.days, url: fresh.release.url }
        : undefined,
    });
  }

  return results.sort((a, b) => b.score - a.score);
}

/**
 * Turns a ranked list into an ordered crawl. Greedy nearest-neighbour from
 * the anchor: good enough for 2–4 stops, and it keeps the walk sensible
 * rather than sending people back and forth across town.
 */
export function buildCrawl(
  ranked: ScoredBrewery[],
  anchor: { lat: number; lng: number },
  stops: number,
): ScoredBrewery[] {
  const pool = ranked.slice(0, Math.max(stops * 3, 8));
  const route: ScoredBrewery[] = [];
  let current = anchor;

  while (route.length < stops && pool.length > 0) {
    let bestIdx = 0;
    let bestCost = Infinity;

    pool.forEach((candidate, i) => {
      const b = candidate.brewery;
      if (b.lat === null || b.lng === null) return;
      const walk = haversineKm(current, { lat: b.lat, lng: b.lng });
      // Balance quality against how far we're asking people to walk.
      const cost = walk * 12 - candidate.score;
      if (cost < bestCost) {
        bestCost = cost;
        bestIdx = i;
      }
    });

    const [chosen] = pool.splice(bestIdx, 1);
    route.push(chosen);
    if (chosen.brewery.lat !== null && chosen.brewery.lng !== null) {
      current = { lat: chosen.brewery.lat, lng: chosen.brewery.lng };
    }
  }

  return route;
}
