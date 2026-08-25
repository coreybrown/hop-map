// Core domain types for the Ontario beer discovery map.

/**
 * Style tags are the product's differentiator. Untappd-style ratings are not
 * comparable across styles (a 3.7 hazy IPA and a 3.7 pilsner mean different
 * things), so we rank on style fit first and use ratings only within a style.
 */
export const STYLE_TAGS = [
  'hazy-ipa',
  'west-coast-ipa',
  'pale-ale',
  'pilsner-lager',
  'dark-lager',
  'stout-porter',
  'sour',
  'wild-ale',
  'farmhouse-saison',
  'wheat-belgian',
  'barrel-aged',
  'session-low-alc',
  /**
   * The three below came out of the held-out test set, where an expert named
   * things our tags could not hold. They were recorded in `unmapped` rather
   * than rounded to the nearest existing tag, which is why we can see them.
   */
  // Bellwoods' NA Jelly King is a headline product, not a concession.
  'non-alcoholic',
  // Was folded into pale-ale. Named separately by an expert for two different
  // breweries (Godspeed, True History), so the fold was losing real signal.
  'kolsch',
  'amber-red',
] as const;

export type StyleTag = (typeof STYLE_TAGS)[number];

/**
 * Does this brewery's reputation answer the question that was ASKED?
 *
 * The map and the results header both used `knownFor.length > 0` — any medal,
 * in any style — while the legend read "Known for what you asked for". Those
 * are different claims, and the legend's was false: search for sours and a
 * brewery holding a stout medal was highlighted as though it had answered you.
 *
 * That is the governing rule failing in the one place the product is supposed
 * to enforce it, so the highlight now means what the label says. With no
 * styles selected there is no question to answer, and any medal qualifies.
 */
export function isKnownForSelected(
  knownFor: readonly StyleTag[],
  selected: readonly StyleTag[],
): boolean {
  if (selected.length === 0) return knownFor.length > 0;
  return knownFor.some((s) => selected.includes(s));
}

export const STYLE_LABELS: Record<StyleTag, string> = {
  'hazy-ipa': 'Hazy IPA',
  'west-coast-ipa': 'West Coast IPA',
  'pale-ale': 'Pale Ale',
  'pilsner-lager': 'Pilsner & Lager',
  'dark-lager': 'Dark Lager',
  'stout-porter': 'Stout & Porter',
  sour: 'Sour',
  'wild-ale': 'Wild & Mixed Ferm',
  'farmhouse-saison': 'Farmhouse & Saison',
  'wheat-belgian': 'Wheat & Belgian',
  'barrel-aged': 'Barrel-Aged',
  'session-low-alc': 'Session & Low-ABV',
  'non-alcoholic': 'Non-Alcoholic',
  kolsch: 'Kölsch',
  'amber-red': 'Amber & Red',
};

/**
 * How a beer drinks, which is NOT what style it is.
 *
 * The test set forced this open. Asked what a brewery is worth going for,
 * an expert answered in terms our style tags couldn't hold — "old school
 * beers", "easy drinking", "experimental brews". Steam Whistle's answer used
 * `experimental` as a REASON NOT TO GO; Halo's used it as the whole appeal.
 * That is a preference axis pointing in opposite directions for two people,
 * not a style, and flattening it into one would lose the sign.
 *
 * Kept separate from StyleTag on purpose: a kölsch and a helles sit at the
 * same end of `easyDrinking` while being different styles, and a barrel-aged
 * sour is `experimental` and `challenging` at once.
 */
export const TASTE_AXES = ['easyDrinking', 'experimental'] as const;
export type TasteAxis = (typeof TASTE_AXES)[number];

export const AXIS_LABELS: Record<TasteAxis, { high: string; low: string }> = {
  easyDrinking: { high: 'Easy drinking', low: 'Challenging' },
  experimental: { high: 'Experimental', low: 'Classics done well' },
};

export type OntarioRegion =
  | 'toronto'
  | 'gta'
  | 'hamilton-niagara'
  | 'waterloo-wellington'
  | 'southwest'
  | 'durham-northumberland'
  | 'quinte-kingston'
  | 'ottawa-valley'
  | 'muskoka-north'
  | 'prince-edward-county';

export const REGION_LABELS: Record<OntarioRegion, string> = {
  toronto: 'Toronto',
  gta: 'Greater Toronto',
  'hamilton-niagara': 'Hamilton & Niagara',
  'waterloo-wellington': 'Waterloo & Wellington',
  southwest: 'Southwestern Ontario',
  'durham-northumberland': 'Durham & Northumberland',
  'quinte-kingston': 'Quinte & Kingston',
  'ottawa-valley': 'Ottawa Valley',
  'muskoka-north': 'Muskoka & North',
  'prince-edward-county': 'Prince Edward County',
};

/**
 * Operating status. Ontario saw ~29 craft brewery closures in 2025, so
 * liveness is a first-class field, not hygiene.
 */
export type BreweryStatus = 'open' | 'closed' | 'unverified';

export interface QualitySignals {
  /** Untappd brewery average — measures the BEER, blended across contexts. */
  untappd?: number;
  /** Google average — measures the VISIT (patio, food, service, tours). */
  google?: number;
  /**
   * Google review count. Load-bearing: destination taprooms in industrial
   * units get hundreds of enthusiast reviews; downtown tourist brewpubs get
   * thousands of general-audience ones. High rating + low count on a
   * production brewery is a stronger quality signal than the inverse.
   */
  googleCount?: number;
}

/**
 * Three-valued on purpose: `null` means nobody ever recorded this, which is
 * not the same as recording a "no".
 *
 * The OSM import used to write `false` for everything it wasn't told about,
 * so 200-odd breweries claimed to have no patio and no bottle shop on no
 * evidence at all. Filters read that as fact and quietly removed them.
 *
 * Callers should keep treating `null` as "can't promise this" when filtering
 * — an unconfirmed bottle shop must not be offered as one — but must not
 * render it as a stated absence.
 */
export interface VenueFacts {
  taproom: boolean | null;
  bottleShop: boolean | null;
  food: boolean | null;
  patio: boolean | null;
  /** Ships within Ontario from its own web store. */
  shipsOntario: boolean | null;
  /** From OSM `wheelchair`. */
  wheelchair?: boolean | null;
  takeaway?: boolean | null;
  wifi?: boolean | null;
  dogFriendly?: boolean | null;
}

/**
 * A recent beer release. NOT a browsable feed — releases exist here purely
 * as evidence inside a recommendation ("and they just dropped a hazy").
 *
 * That distinction is what makes this tractable: a release *radar* needs
 * exhaustive coverage or it recreates the regret it set out to fix, but an
 * evidence layer degrades gracefully. A brewery with no release data simply
 * doesn't get the extra reason line; its ranking still stands on style fit
 * and quality.
 */
export interface Release {
  name: string;
  /** Inferred from the product title/description; may be empty. */
  styles: StyleTag[];
  /** ISO date the product first appeared in the brewery's store. */
  firstSeen: string;
  url: string;
  available: boolean;
}

/**
 * Breweries publish what's new in whatever place suits them: a web store, an
 * Instagram feed, a Facebook page, a taproom chalkboard photographed once a
 * week. We can only automate the first of those, so the model records every
 * channel we know about and is honest about which one we can actually read.
 */
export interface BreweryLinks {
  website?: string;
  /** Web store — the only channel we can poll for releases automatically. */
  shop?: string;
  instagram?: string;
  facebook?: string;
  untappd?: string;
}

/**
 * How (and whether) we can learn about this brewery's new beer.
 * - `shop`      we poll their store; releases appear as evidence
 * - `instagram` we can't read it, but we can send the user there
 * - `social`    some other page exists
 * - `none`      no known channel; the brewery still appears, just without
 *               a freshness line
 */
export type ReleaseSource = 'shop' | 'instagram' | 'social' | 'none';

/**
 * How much we actually know about a brewery. Coverage and depth are separate
 * problems: a finder has to be inclusive (every brewery on the map) even where
 * it can't yet be smart (no style tags, so no taste matching).
 */
export type EnrichmentLevel =
  /** Hand-curated: styles, signals, editorial note. */
  | 'curated'
  /** Imported: real name and location, no style or quality data yet. */
  | 'listed';

export interface Brewery {
  id: string;
  name: string;
  city: string;
  region: OntarioRegion;
  address: string;
  /** Primary URL, kept for convenience. Full set lives in `links`. */
  website: string;
  links: BreweryLinks;
  releaseSource: ReleaseSource;
  enrichment: EnrichmentLevel;
  status: BreweryStatus;
  /** OpenStreetMap element this came from, when imported. ODbL attribution. */
  osmId?: string;

  /** Populated by scripts/geocode.mjs. Null until geocoded. */
  lat: number | null;
  lng: number | null;

  /**
   * OFFERS vs KNOWN FOR — the distinction the whole product turns on.
   *
   * These are different axes and conflating them produces bad advice.
   * Bellwoods offers pilsners and lagers alongside everything else, but is
   * known for hazies and sours. "Go to Bellwoods for a hazy" is right;
   * "go to Bellwoods for a lager" is wrong — you'd get a decent one and
   * miss nothing by skipping it. Badlands is narrow on both axes: offers
   * IPAs and stouts, known for IPAs. Easy call.
   *
   * `knownFor` drives recommendations. `offers` is a supporting fact, and
   * on its own is never a reason to make a detour — most breweries have a
   * hazy on tap; that doesn't mean you should go.
   */
  styles: {
    /** Quantitative: what's actually available. From catalog crawls. */
    offers: StyleTag[];
    /**
     * Qualitative: what's worth going for. From reputation signals —
     * competition medals, review emphasis, editorial and community regard.
     * Empty is an honest and common answer.
     */
    knownFor: StyleTag[];
  };

  /**
   * Shape of the OFFERING, not the reputation. A brewery can be broad here
   * and still have a narrow reputation (see Bellwoods).
   */
  styleProfile?: 'specialist' | 'broad' | 'unknown';
  styleConfidence?: 'high' | 'medium' | 'low' | 'none';
  styleSource?: string;
  styleEvidence?: string;

  /**
   * Where this brewery sits on each taste axis, 0..1, or absent when we can't
   * say. Derived from the composition of `offers`, so it carries the same
   * source as `offers` does — it is not an opinion we added.
   */
  axes?: Partial<Record<TasteAxis, number>>;
  /** Where each `knownFor` entry came from, so the UI can show its working. */
  reputationEvidence?: Array<{
    style: StyleTag;
    source: 'awards' | 'reviews' | 'editorial' | 'curated';
    detail: string;
  }>;

  signals: QualitySignals;
  venue: VenueFacts;

  /**
   * Editorial one-liner. Per discovery, a recommendation that shows its
   * reasoning is what earns a detour; a bare star rating is not.
   */
  note?: string;

  /**
   * Best-effort, from the brewery's own web store. Optional by design —
   * absence costs a reason line, never a recommendation.
   */
  releases?: Release[];

  /** From OSM. Present for roughly half the registry. */
  contact?: { phone?: string; email?: string };

  /**
   * Raw OSM `opening_hours` syntax ("Mo-Th 17:00-23:00; Fr 16:00-24:00"),
   * deliberately unparsed. It is the trip planner's most load-bearing fact —
   * a brewery that's shut is not a stop — and a half-right parser that
   * silently mishandles holidays would be worse than showing the string.
   */
  openingHours?: string;

  description?: string;
  operator?: string;
  /** OSM `start_date` — the year they opened. */
  since?: string;
  /** When an OSM contributor last surveyed this place on the ground. */
  osmCheckedOn?: string;

  /**
   * The brewery's own web store, read through its platform API. This is the
   * strongest catalog source we have and the only one that can be re-polled
   * cheaply for releases.
   */
  store?: {
    platform: 'shopify' | 'woocommerce' | 'squarespace';
    endpoint: string;
    productCount: number;
    /** Hit the pagination cap — the product list is incomplete. */
    truncated: boolean;
    fetchedAt: string;
  };

  siteHealth?: {
    verdict: string;
    checkedAt: string;
    /** Set when we followed a move to a domain the brewery still owns. */
    movedFrom?: string;
    /** Set when their old domain now serves someone else entirely. */
    landsOn?: string;
  };

  /**
   * Beer BRANDS POURED here, from OSM `brewery=*`. Never styles, and never
   * a source for `offers` — the tag on a pub lists Guinness and Molson.
   */
  beersServed?: string[];

  /**
   * Pours only other people's beer: almost certainly a pub that OSM's
   * craft=brewery sweep caught, not a brewery. A review flag, not a filter.
   */
  likelyNotBrewery?: boolean;

  /** Why a human should look at this record before we trust it. */
  needsReview?: string;

  lastVerified: string;
}

/** A scored brewery, produced by the ranking engine. */
export interface ScoredBrewery {
  brewery: Brewery;
  score: number;
  /** Human-readable reasons, in priority order. Rendered in the UI. */
  reasons: string[];
  /** Km from the query anchor, when the query had one. */
  distanceKm?: number;
  /** Km of detour off a route, for corridor queries. */
  detourKm?: number;
  /** Surfaced separately from `reasons` so the UI can give it its own treatment. */
  freshRelease?: {
    name: string;
    style: StyleTag;
    daysAgo: number;
    url: string;
  };
}
