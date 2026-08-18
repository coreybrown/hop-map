/**
 * Pulls every tagged brewery in Ontario from OpenStreetMap via Overpass.
 *
 * Why OSM rather than scraping a competitor's directory:
 *   - free, no key, and explicitly licensed for reuse (ODbL, attribution required)
 *   - coordinates come attached, so no geocoding pass is needed
 *   - community-maintained, so closures and openings land without us noticing
 *
 * OSM gives us NAME + LOCATION + sometimes website/address. It does not give
 * style specializations or quality signals — those stay a separate enrichment
 * step. This script solves completeness, not depth.
 *
 *   node scripts/fetch-osm-breweries.mjs
 */

import { writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(here, '..', 'data');
const SEED = path.join(DATA_DIR, 'breweries.seed.json');
const OUT = path.join(DATA_DIR, 'osm-breweries.json');

// Several mirrors; Overpass instances rate-limit and go down independently.
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

/**
 * Ontario, by ISO code so we don't depend on a relation ID that could change.
 * Covers the tags Ontario breweries actually carry: craft=brewery is the
 * standard, microbrewery=yes is common on brewpubs, industrial=brewery
 * catches the larger production sites.
 */
const QUERY = `
[out:json][timeout:180];
area["ISO3166-2"="CA-ON"][admin_level=4]->.on;
(
  nwr["craft"="brewery"](area.on);
  nwr["microbrewery"="yes"](area.on);
  nwr["industrial"="brewery"](area.on);
  nwr["amenity"="pub"]["brewery"](area.on);
);
out center tags;
`;

async function overpass() {
  let lastError;
  for (const endpoint of ENDPOINTS) {
    try {
      process.stdout.write(`  querying ${new URL(endpoint).host}… `);
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'OntarioBeerMap/0.1 (hobby project)',
        },
        body: new URLSearchParams({ data: QUERY }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      console.log(`${json.elements?.length ?? 0} elements`);
      return json.elements ?? [];
    } catch (err) {
      console.log(`failed (${err.message})`);
      lastError = err;
    }
  }
  throw lastError ?? new Error('all Overpass endpoints failed');
}

/** Normalizes a name for duplicate detection against the hand-curated seed. */
function normalize(name) {
  return name
    .toLowerCase()
    .replace(/\b(brewing|brewery|brewers|beer|co|company|craft|ales?|inc|ltd|the)\b/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

/** OSM records a URL under any of these, inconsistently. Take the first real one. */
const first = (t, keys) => {
  for (const k of keys) {
    const v = (t[k] ?? '').trim();
    if (v) return v;
  }
  return '';
};

/** OSM booleans are "yes"/"no"/"limited"/"only" strings, not booleans. */
const yes = (v) => v === 'yes' || v === 'only' || v === 'designated';

function toRecord(el) {
  const t = el.tags ?? {};
  const lat = el.lat ?? el.center?.lat ?? null;
  const lng = el.lon ?? el.center?.lon ?? null;

  const street = [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ');
  const city = t['addr:city'] ?? '';
  const address = [street, city, 'ON'].filter(Boolean).join(', ');

  /**
   * `brewery=*` is a semicolon list of the beer BRANDS POURED here — not what
   * this place brews. Read the real values before trusting it: Morty's Pub
   * tags Molson_Canadian;Coors_Light;Bud_Light, and D'Arcy McGee's tags
   * guinness;heineken. Those are macro taps at an Irish pub.
   *
   * So this must never become `offers`. It is the reverse signal: a venue
   * pouring a list of other people's brands is a PUB that OSM's craft/
   * microbrewery tags swept in, which is the non-brewery problem we already
   * know we have. It reads as self-brewing only when the value names the
   * venue itself — Henderson tags "Henderson Brewing Company", Whitewater
   * Lakeside Brewpub tags "Whitewater Brewing Company".
   */
  const beersServed = (t.brewery ?? '')
    .split(';')
    .map((s) => s.trim().replace(/_/g, ' '))
    .filter((s) => s && s !== 'yes' && s !== 'no' && s.toLowerCase() !== 'various');

  return {
    osmId: `${el.type}/${el.id}`,
    name: (t.name ?? '').trim(),
    city,
    address: street ? address : city ? `${city}, ON` : '',
    website: first(t, ['website', 'contact:website', 'url', 'website:menu']),
    phone: first(t, ['phone', 'contact:phone', 'contact:mobile']),
    email: first(t, ['email', 'contact:email']),
    openingHours: t.opening_hours ?? '',
    lat,
    lng,

    // Socials are the fallback contact for breweries with no site of their own.
    social: {
      facebook: first(t, ['contact:facebook', 'facebook']),
      instagram: first(t, ['contact:instagram', 'instagram']),
      twitter: first(t, ['contact:twitter', 'twitter']),
      untappd: first(t, ['contact:untappd', 'untappd']),
    },

    // Venue facts the app needs for filtering, straight from the tag bag
    // rather than assumed. `null` means unmapped, which is not the same as false.
    venue: {
      taproom: t.amenity === 'pub' || t.amenity === 'bar' || t.taproom === 'yes' ? true : null,
      food: t.amenity === 'pub' || t.amenity === 'restaurant' || t.food === 'yes' ? true : null,
      patio: t.outdoor_seating ? yes(t.outdoor_seating) : null,
      wheelchair: t.wheelchair ? yes(t.wheelchair) : null,
      takeaway: t.takeaway ? yes(t.takeaway) : null,
      wifi: t['internet_access'] ? t['internet_access'] !== 'no' : null,
      dogFriendly: t.dog ? yes(t.dog) : null,
    },

    beersServed,

    /**
     * Does the taps list name this venue itself? `true` corroborates a real
     * brewpub, `false` says "pours other people's beer" — a filtering hint,
     * never a style label. `null` means the tag is absent and says nothing.
     */
    poursOwnBeer: beersServed.length
      ? beersServed.some((brand) => {
          const a = normalize(brand);
          const b = normalize(t.name ?? '');
          return a.length > 2 && b.length > 2 && (a.includes(b) || b.includes(a));
        })
      : null,

    description: t.description ?? '',
    operator: t.operator ?? t.brand ?? '',
    since: t['start_date'] ?? '',
    checkedOn: t['check_date'] ?? t['survey:date'] ?? '',

    tags: {
      craft: t.craft ?? null,
      microbrewery: t.microbrewery ?? null,
      amenity: t.amenity ?? null,
      industrial: t.industrial ?? null,
      shop: t.shop ?? null,
      cuisine: t.cuisine ?? null,
    },

    // Keep the untouched bag. Every field above is a lossy read of it, and
    // the next question we ask of this data will want a tag we didn't promote.
    rawTags: t,
  };
}

async function main() {
  const elements = await overpass();

  const seen = new Set();
  const records = [];

  for (const el of elements) {
    const rec = toRecord(el);
    if (!rec.name) continue;
    if (rec.lat === null || rec.lng === null) continue;

    // A brewery mapped as both a node and a building way is one brewery.
    const key = `${normalize(rec.name)}|${rec.lat.toFixed(3)},${rec.lng.toFixed(3)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    records.push(rec);
  }

  records.sort((a, b) => a.name.localeCompare(b.name));

  // Flag which of these we already cover by hand, so the enrichment work
  // can focus on the genuinely new ones.
  let alreadyCurated = 0;
  if (existsSync(SEED)) {
    const seed = JSON.parse(await readFile(SEED, 'utf8'));
    const curated = new Set(seed.breweries.map((b) => normalize(b.name)));
    for (const rec of records) {
      rec.inSeed = curated.has(normalize(rec.name));
      if (rec.inSeed) alreadyCurated++;
    }
  }

  const withWebsite = records.filter((r) => r.website).length;
  const coverage = {
    website: withWebsite,
    phone: records.filter((r) => r.phone).length,
    openingHours: records.filter((r) => r.openingHours).length,
    address: records.filter((r) => r.address).length,
    social: records.filter((r) => Object.values(r.social).some(Boolean)).length,
    beersServed: records.filter((r) => r.beersServed.length).length,
    poursOwnBeer: records.filter((r) => r.poursOwnBeer === true).length,
    poursOthersOnly: records.filter((r) => r.poursOwnBeer === false).length,
    description: records.filter((r) => r.description).length,
  };

  await writeFile(
    OUT,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        source: 'OpenStreetMap via Overpass API (ODbL — attribution required)',
        count: records.length,
        alreadyCurated,
        withWebsite,
        coverage,
        breweries: records,
      },
      null,
      2,
    ),
  );

  console.log(
    `\n${records.length} Ontario breweries from OSM ` +
      `(${alreadyCurated} already in our seed, ${records.length - alreadyCurated} new).`,
  );
  console.log(`${withWebsite} have a website tagged — those can be release-polled.`);
  console.log('Tag coverage:', coverage);
  console.log(`Wrote ${path.relative(process.cwd(), OUT)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
