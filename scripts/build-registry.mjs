/**
 * Merges the hand-curated seed with the OSM import into one registry.
 *
 * Two different jobs, deliberately kept apart:
 *   COVERAGE — every brewery in Ontario should be on the map. OSM provides it.
 *   DEPTH    — styles, quality signals and an editorial note make taste
 *              matching possible. Only hand-curation provides that, so far.
 *
 * A brewery with no style data still appears; it just can't be matched to a
 * taste query yet. Showing someone in Sudbury three unclassified breweries
 * beats showing them nothing.
 *
 *   node scripts/build-registry.mjs
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(here, '..', 'data');

const CURATED = path.join(DATA_DIR, 'breweries.json');
const OSM = path.join(DATA_DIR, 'osm-breweries.json');
const STYLES = path.join(DATA_DIR, 'styles.json');
const STORES = path.join(DATA_DIR, 'store-catalogs.json');
const HEALTH = path.join(DATA_DIR, 'site-health.json');
const AWARDS = path.join(DATA_DIR, 'awards.json');
const CORRECTIONS = path.join(DATA_DIR, 'corrections.json');
const OUT = path.join(DATA_DIR, 'registry.json');

const normalize = (name) =>
  name
    .toLowerCase()
    .replace(
      /\b(brewing|brewery|brewers|brewhouse|beer|co|company|craft|ales?|inc|ltd|the|and|blending|works|project)\b/g,
      '',
    )
    .replace(/[^a-z0-9]/g, '')
    .trim();

const EARTH_KM = 6371;
const rad = (d) => (d * Math.PI) / 180;
function distanceKm(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(rad(a.lat)) * Math.cos(rad(b.lat));
  return 2 * EARTH_KM * Math.asin(Math.sqrt(h));
}

/**
 * Name normalization alone misses "Barrel Heart Brewing" vs "Barrel Heart
 * Brewing & Blending". Treat two records as the same brewery when one
 * normalized name contains the other AND they sit within 2 km — close names
 * far apart are usually genuinely different businesses (there are several
 * unrelated "Bench" and "Stone" breweries in Ontario).
 */
function findExisting(map, key, coords) {
  if (map.has(key)) return map.get(key);
  if (!coords || key.length < 5) return null;

  for (const [otherKey, record] of map) {
    if (otherKey.length < 5) continue;
    if (!otherKey.includes(key) && !key.includes(otherKey)) continue;
    if (record.lat == null || record.lng == null) continue;
    if (distanceKm(coords, { lat: record.lat, lng: record.lng }) <= 2) return record;
  }
  return null;
}

const slug = (name) =>
  name
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);

/** Rough region assignment from coordinates, for grouping and filters. */
function regionFor(lat, lng) {
  if (lng > -76.6 && lat > 44.8) return 'ottawa-valley';
  if (lng > -77.6 && lat > 43.8) return 'quinte-kingston';
  if (lng > -77.6 && lat <= 43.8) return 'prince-edward-county';
  if (lat > 44.6) return 'muskoka-north';
  if (lng > -78.9 && lat > 43.75) return 'durham-northumberland';
  if (lng >= -79.65 && lng <= -79.1 && lat >= 43.55 && lat <= 43.85) return 'toronto';
  if (lng > -80.1 && lat > 43.3) return 'gta';
  if (lng > -80.1) return 'hamilton-niagara';
  if (lng > -81.0) return 'waterloo-wellington';
  return 'southwest';
}

/** Pull a city out of a free-text address when OSM didn't tag one. */
function cityFrom(address, fallback) {
  if (fallback) return fallback;
  if (!address) return '';
  const parts = address.split(',').map((p) => p.trim());
  return parts.length >= 2 ? parts[parts.length - 2] : '';
}

function classifyLinks(links) {
  if (links.shop) return 'shop';
  if (links.instagram) return 'instagram';
  if (links.facebook || links.untappd) return 'social';
  if (links.website) return 'social';
  return 'none';
}

/**
 * Contact and venue facts OSM knows and we were throwing away.
 *
 * Applied as fill-only: a curated value always survives, because someone
 * checked it. OSM answers where we have nothing, which is most of the
 * registry — 118 phone numbers and 103 sets of opening hours that the
 * previous import dropped on the floor.
 *
 * `venue` booleans stay three-valued on purpose. OSM not tagging a patio is
 * not the same as OSM saying there is no patio, and collapsing the two would
 * let the app filter breweries out over a fact nobody ever recorded.
 */
function applyOsmDetail(record, o) {
  record.contact ??= {};
  if (!record.contact.phone && o.phone) record.contact.phone = o.phone;
  if (!record.contact.email && o.email) record.contact.email = o.email;
  if (!record.openingHours && o.openingHours) record.openingHours = o.openingHours;

  for (const [key, url] of Object.entries(o.social ?? {})) {
    if (url && !record.links[key]) record.links[key] = url;
  }

  record.venue ??= {};
  for (const [key, value] of Object.entries(o.venue ?? {})) {
    if (value !== null && record.venue[key] == null) record.venue[key] = value;
  }

  if (!record.description && o.description) record.description = o.description;
  if (!record.operator && o.operator) record.operator = o.operator;
  if (!record.since && o.since) record.since = o.since;
  if (o.checkedOn) record.osmCheckedOn = o.checkedOn;

  // See fetch-osm-breweries: `brewery=*` lists the brands POURED here. A venue
  // pouring only other people's beer is a pub OSM swept in under craft=brewery
  // — the non-brewery problem we already know about. It is a review flag and
  // nothing more; it never touches styles.
  if (o.beersServed?.length) {
    record.beersServed = o.beersServed;
    if (o.poursOwnBeer === false) record.likelyNotBrewery = true;
  }
}

async function main() {
  const curated = JSON.parse(await readFile(CURATED, 'utf8'));
  const osm = JSON.parse(await readFile(OSM, 'utf8'));

  const byKey = new Map();

  // Curated records win on every contested field — they carry the styles,
  // signals and editorial voice that make the product work.
  for (const b of curated.breweries) {
    const links = { website: b.website };
    if (b.venue?.shipsOntario) links.shop = b.website;

    // NOTHING GETS LABELLED WITHOUT A SOURCE.
    //
    // True History was hand-seeded as "hazy-ipa" from pure assumption. Its
    // bottle shop is eight lagers and nothing else. Filing that guess under
    // `offers` instead of `knownFor` did not make it acceptable — it still
    // drove the recommendation, and it still told a hazy drinker to go to a
    // lager house.
    //
    // So hand-written styles are quarantined out of the live fields entirely.
    // They are kept only as a to-verify list, and nothing in the ranking
    // engine reads them. A brewery with no crawled evidence has no styles,
    // appears on the map, and honestly cannot answer a taste query yet.
    const { styles: handWritten, ...rest } = b;

    byKey.set(normalize(b.name), {
      ...rest,
      styles: { offers: [], knownFor: [] },
      reputationEvidence: [],
      unverifiedHypothesis: handWritten,
      links,
      releaseSource: classifyLinks(links),
      enrichment: 'curated',
    });
  }

  let added = 0;
  let improved = 0;

  let merged = 0;

  for (const o of osm.breweries) {
    const key = normalize(o.name);
    const existing = findExisting(byKey, key, { lat: o.lat, lng: o.lng });

    if (existing) {
      if (!byKey.has(key)) merged++;
      // OSM can still improve a curated record: it often has exact coordinates
      // where our seed only had a city centroid.
      if (existing.addressPrecision === 'city' && o.address) {
        existing.lat = o.lat;
        existing.lng = o.lng;
        existing.address = o.address;
        existing.addressPrecision = 'exact';
        existing.osmId = o.osmId;
        improved++;
      }
      if (!existing.links.website && o.website) existing.links.website = o.website;
      applyOsmDetail(existing, o);
      continue;
    }

    const links = {};
    if (o.website) links.website = o.website;

    const record = {
      id: slug(o.name),
      name: o.name,
      city: cityFrom(o.address, o.city),
      region: regionFor(o.lat, o.lng),
      address: o.address || `${o.city || 'Ontario'}, ON`,
      addressPrecision: o.address ? 'exact' : 'city',
      website: o.website || '',
      links,
      releaseSource: classifyLinks(links),
      enrichment: 'listed',
      status: 'unverified',
      lat: o.lat,
      lng: o.lng,
      styles: { offers: [], knownFor: [] },
      signals: {},
      // Unknown, not false. Only `taproom` is assumed — a brewery you can't
      // visit isn't a destination, and this product is about going there.
      venue: {
        taproom: true,
        bottleShop: null,
        food: null,
        patio: null,
        shipsOntario: null,
      },
      osmId: o.osmId,
      lastVerified: osm.generatedAt.slice(0, 10),
    };

    applyOsmDetail(record, o);
    byKey.set(key, record);
    added++;
  }

  // Fold in crawl-derived styles. Hand-curated styles always win — they
  // encode reputation, which a catalog crawl can only approximate.
  let classified = 0;
  if (existsSync(STYLES)) {
    const { styles } = JSON.parse(await readFile(STYLES, 'utf8'));
    for (const record of byKey.values()) {
      const found = styles[record.id];
      if (!found || found.confidence === 'none' || !found.styles.length) continue;

      record.styleConfidence = found.confidence;
      record.styleSource = found.method;
      record.styleEvidence = found.evidence;
      record.styleProfile = found.profile ?? 'unknown';

      // A crawl of the brewery's own product list is the only thing that can
      // put styles on a record.
      record.styles.offers = found.styles;
      classified++;
      if (!record.note && found.note) record.note = found.note;
    }
  }

  /**
   * Site health, folded in before anything tries to read a website.
   *
   * Two things happen here. A brewery that moved to a domain it still owns
   * gets its website rewritten to where it actually lives — Side Launch's
   * sidelaunchbrewing.com has been sidelaunch.com for a while, and every
   * crawl aimed at the old address was reading a redirect for nothing.
   *
   * A brewery whose domain is for sale or now belongs to a stranger keeps its
   * recorded website and gets a flag instead. meritbrewing.com being listed
   * on HugeDomains is strong evidence and still not proof, and `status` is
   * the field that decides whether we send someone on a drive. A human
   * confirms that one.
   */
  let redirected = 0;
  let flaggedDead = 0;
  if (existsSync(HEALTH)) {
    const health = JSON.parse(await readFile(HEALTH, 'utf8'));
    for (const record of byKey.values()) {
      const site = health.sites?.[record.id];
      if (!site) continue;

      record.siteHealth = { verdict: site.verdict, checkedAt: site.checkedAt };

      if (site.verdict === 'moved-own-domain' && site.finalUrl) {
        record.siteHealth.movedFrom = record.links.website;
        record.links.website = site.finalUrl;
        record.website = site.finalUrl;
        redirected++;
      } else if (site.verdict === 'domain-for-sale' || site.verdict === 'domain-changed-hands') {
        // Evidence for a human, never an automatic closure.
        record.siteHealth.landsOn = site.finalUrl;
        record.needsReview = 'website-no-longer-theirs';
        flaggedDead++;
      }
    }
  }

  // A readable store API is a real, checkable fact about a brewery: it means
  // we can see their product list and re-poll it for releases.
  let withStore = 0;
  if (existsSync(STORES)) {
    const { stores } = JSON.parse(await readFile(STORES, 'utf8'));
    for (const record of byKey.values()) {
      const store = stores[record.id];
      if (!store) continue;
      record.store = {
        platform: store.platform,
        endpoint: store.endpoint,
        productCount: store.productCount,
        truncated: store.truncated ?? false,
        fetchedAt: store.fetchedAt,
      };
      record.links.shop = store.website;
      record.releaseSource = 'shop';
      withStore++;
    }
  }

  /**
   * THE ONLY THING THAT MAY WRITE `knownFor`.
   *
   * `offers` says what they stock; `knownFor` says what is worth a detour, and
   * only the second one can cost someone a wasted drive. So it takes evidence
   * a stranger can check — here, a blind-judged medal in a named category in a
   * named year, kept in `reputationEvidence` so the UI can show its working.
   *
   * The threshold exists because one bronze from 2015 is not a reputation. A
   * recent gold clears it alone; older or lesser medals have to accumulate.
   *
   * What this must NEVER do is treat silence as a negative. Entering the CBA
   * costs money and effort and plenty of excellent breweries don't bother —
   * Bellwoods has no medals here and is arguably Ontario's most famous
   * brewery. No medals means no evidence, not a bad brewery.
   */
  const KNOWN_FOR_THRESHOLD = 0.5;
  let withKnownFor = 0;
  let knownForClaims = 0;
  if (existsSync(AWARDS)) {
    const awards = JSON.parse(await readFile(AWARDS, 'utf8'));
    for (const record of byKey.values()) {
      const won = awards.breweries?.[record.id];
      if (!won) continue;

      /**
       * MEDAL LIVENESS. A medal proves the brewery once made that style well;
       * it does not prove you can go drink it. Steam Whistle's 2020 English
       * Pale Ale Gold is real — and the beer is gone; their catalog is pilsner
       * only. Where we HOLD a crawled catalog (offers is non-empty), a medal
       * style absent from it is demoted: kept in reputationEvidence with
       * `live: false`, excluded from knownFor. Breweries with no catalog keep
       * the benefit of the doubt — absence of a crawl is not absence of the
       * beer. (source-register.md, "Award evidence must decay".)
       */
      const catalog = record.styles.offers ?? [];
      const qualifying = Object.entries(won.styleScore)
        .filter(([, score]) => score >= KNOWN_FOR_THRESHOLD)
        .filter(([style]) => !catalog.length || catalog.includes(style))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3);
      if (!qualifying.length) continue;

      record.styles.knownFor = qualifying.map(([style]) => style);
      record.reputationEvidence = qualifying.map(([style, score]) => {
        const best = won.medals
          .filter((m) => m.styles.includes(style))
          .sort((a, b) => (a.medal === 'gold' ? -1 : 1) - (b.medal === 'gold' ? -1 : 1) || b.year - a.year)[0];
        return {
          style,
          source: 'awards',
          detail: best
            ? `${best.medal[0].toUpperCase()}${best.medal.slice(1)}, ${best.category}, ${best.competition ?? 'Canadian Brewing Awards'} ${best.year} — ${best.beer}`
            : 'Canadian Brewing Awards medal',
          score,
        };
      });
      record.knownForSource = 'awards';
      withKnownFor++;
      knownForClaims += qualifying.length;
    }
  }

  /**
   * Human decisions, applied LAST so they beat every inferred field.
   *
   * This runs at the end for a reason: everything above is re-derived from
   * OSM and crawls on every build, so a judgement recorded anywhere else is
   * silently undone the next time this script runs. A person confirmed these,
   * and a person's answer outranks the pipeline's.
   *
   * Excluded venues keep their records and their OSM ids. Deleting them would
   * feel tidier and would be wrong — the next fetch-osm-breweries run would
   * pull all 17 straight back in with nothing to say they'd been judged.
   */
  let excluded = 0;
  let closed = 0;
  let corrected = 0;
  if (existsSync(CORRECTIONS)) {
    const fixes = JSON.parse(await readFile(CORRECTIONS, 'utf8'));
    const byId = new Map([...byKey.values()].map((b) => [b.id, b]));

    for (const [id, fix] of Object.entries(fixes.notBrewery ?? {})) {
      const record = byId.get(id);
      if (!record || id.startsWith('_')) continue;
      record.venueKind = fix.venueKind;
      record.isBrewery = false;
      record.excludedReason = fix.why;
      delete record.needsReview;
      // A pub menu crawled as a brewery catalog is exactly how Pheasant
      // Plucker ended up with four styles. Those aren't its beers.
      record.styles = { offers: [], knownFor: [] };
      excluded++;
    }

    for (const [id, fix] of Object.entries(fixes.closed ?? {})) {
      const record = byId.get(id);
      if (!record || id.startsWith('_')) continue;
      record.status = 'closed';
      record.closedReason = fix.why;
      if (fix.succeededBy) record.succeededBy = fix.succeededBy;
      delete record.needsReview;
      closed++;
    }

    for (const [id, fix] of Object.entries(fixes.websiteFix ?? {})) {
      const record = byId.get(id);
      if (!record || id.startsWith('_')) continue;
      if (fix.website) {
        record.links.website = fix.website;
        record.website = fix.website;
      }
      if (fix.status) record.status = fix.status;
      record.correctedReason = fix.why;
      delete record.needsReview;
      delete record.siteHealth;
      corrected++;
    }

    // Flagged dead by check-sites.mjs and confirmed alive by a human. The
    // flag must not come back on the next build just because the heuristic
    // still dislikes the redirect.
    for (const [id, fix] of Object.entries(fixes.falsePositive ?? {})) {
      const record = byId.get(id);
      if (!record || id.startsWith('_')) continue;
      if (fix.status) record.status = fix.status;
      record.reviewedClear = fix.why;
      delete record.needsReview;
      corrected++;
    }

    for (const [id, note] of Object.entries(fixes.notes ?? {})) {
      const record = byId.get(id);
      if (record) record.humanNote = note;
    }
  }

  const breweries = [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
  const curatedCount = breweries.filter((b) => b.enrichment === 'curated').length;
  const withStyles = breweries.filter((b) => b.styles.offers.length > 0 || b.styles.knownFor.length > 0).length;
  const pollable = breweries.filter((b) => b.releaseSource === 'shop').length;

  // What we can actually say about a brewery, field by field. This is the
  // number to watch: coverage is the whole job right now.
  const has = (fn) => breweries.filter(fn).length;
  const coverage = {
    website: has((b) => b.links?.website),
    phone: has((b) => b.contact?.phone),
    email: has((b) => b.contact?.email),
    openingHours: has((b) => b.openingHours),
    exactAddress: has((b) => b.addressPrecision === 'exact'),
    social: has((b) => b.links?.instagram || b.links?.facebook || b.links?.untappd),
    store: withStore,
    offers: has((b) => b.styles.offers.length),
    description: has((b) => b.description || b.note),
    flaggedNotBrewery: has((b) => b.likelyNotBrewery),
    knownFor: withKnownFor,
    excludedNotBrewery: excluded,
    closed: has((b) => b.status === 'closed'),
    liveWebsite: has((b) => b.siteHealth?.verdict === 'live'),
    needsReview: has((b) => b.needsReview),
  };

  await writeFile(
    OUT,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        attribution:
          'Contains data from OpenStreetMap contributors, licensed under ODbL.',
        count: breweries.length,
        curated: curatedCount,
        listed: breweries.length - curatedCount,
        withStyles,
        coverage,
        breweries,
      },
      null,
      2,
    ),
  );

  console.log(`Registry: ${breweries.length} Ontario breweries`);
  console.log(`  ${curatedCount} curated (styles + signals + note)`);
  console.log(`  ${breweries.length - curatedCount} listed (name + location only)`);
  console.log(`  ${improved} curated records had coordinates improved by OSM`);
  console.log(`  ${added} newly added from OSM`);
  console.log(`  ${merged} near-duplicate names merged by proximity`);
  console.log(`  ${classified} got styles from the catalog crawl`);
  console.log(`  ${withStyles} can currently answer a taste query`);
  console.log(`  ${pollable} have a pollable web store`);
  console.log(`  ${excluded} excluded as not-a-brewery, ${closed} marked closed, ${corrected} corrected (corrections.json)`);
  console.log(`  ${withKnownFor} have knownFor from awards (${knownForClaims} style claims)`);
  console.log(`  ${redirected} websites repointed to the domain the brewery moved to`);
  console.log(`  ${flaggedDead} flagged for review — domain for sale or reassigned`);
  console.log('\nField coverage across all records:');
  for (const [field, n] of Object.entries(coverage)) {
    const pct = Math.round((n / breweries.length) * 100);
    console.log(`  ${field.padEnd(18)} ${String(n).padStart(3)}  ${String(pct).padStart(3)}%`);
  }
  console.log(`\nWrote ${path.relative(process.cwd(), OUT)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
