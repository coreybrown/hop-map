/**
 * Geocodes the brewery seed via OpenStreetMap Nominatim and writes the
 * runtime dataset. Free, no API key, no Google ToS caching limits — the
 * coordinates are ours to keep.
 *
 * Nominatim's usage policy caps us at 1 request/second and requires a real
 * User-Agent. Results are cached in geocode-cache.json so reruns only hit
 * the network for entries that are new or whose address changed.
 *
 *   node scripts/geocode.mjs          # geocode missing entries
 *   node scripts/geocode.mjs --force  # re-geocode everything
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(here, '..', 'data');
const SEED = path.join(DATA_DIR, 'breweries.seed.json');
const CACHE = path.join(DATA_DIR, 'geocode-cache.json');
const OUT = path.join(DATA_DIR, 'breweries.json');

const USER_AGENT =
  'OntarioBeerMap/0.1 (hobby project; contact via repository)';
const RATE_LIMIT_MS = 1100;

const force = process.argv.includes('--force');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function geocode(query) {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '1');
  url.searchParams.set('countrycodes', 'ca');

  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`Nominatim ${res.status} for "${query}"`);

  const results = await res.json();
  if (!results.length) return null;

  return {
    lat: Number(results[0].lat),
    lng: Number(results[0].lon),
    matched: results[0].display_name,
  };
}

/**
 * Nominatim does better with a comma-normalized address, and unit numbers
 * ("Unit 4", "#12") reliably break the match — strip them before querying.
 */
function toQuery(brewery) {
  const cleaned = brewery.address
    .replace(/\b(unit|suite|ste\.?|#)\s*[\w-]+,?/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/,\s*,/g, ',')
    .trim();
  return cleaned.toLowerCase().includes('canada')
    ? cleaned
    : `${cleaned}, Canada`;
}

async function main() {
  const seed = JSON.parse(await readFile(SEED, 'utf8'));
  const cache = existsSync(CACHE)
    ? JSON.parse(await readFile(CACHE, 'utf8'))
    : {};

  const out = [];
  let fetched = 0;
  let cached = 0;
  const failures = [];

  for (const brewery of seed.breweries) {
    const query = toQuery(brewery);
    const cacheKey = `${brewery.id}::${query}`;

    let coords = force ? null : cache[cacheKey];

    if (coords) {
      cached++;
    } else {
      process.stdout.write(`  geocoding ${brewery.name}… `);
      try {
        coords = await geocode(query);
        if (coords) {
          cache[cacheKey] = coords;
          fetched++;
          console.log('ok');
        } else {
          console.log('NO MATCH');
          failures.push({ id: brewery.id, name: brewery.name, query });
        }
      } catch (err) {
        console.log(`FAILED (${err.message})`);
        failures.push({ id: brewery.id, name: brewery.name, query, error: err.message });
        coords = null;
      }
      await sleep(RATE_LIMIT_MS);
    }

    const { addressPrecision = 'exact', styleNote, ...rest } = brewery;
    out.push({
      ...rest,
      addressPrecision,
      lat: coords?.lat ?? null,
      lng: coords?.lng ?? null,
      geocodeMatch: coords?.matched ?? null,
    });
  }

  await writeFile(CACHE, JSON.stringify(cache, null, 2));
  await writeFile(
    OUT,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        count: out.length,
        geocoded: out.filter((b) => b.lat !== null).length,
        breweries: out,
      },
      null,
      2,
    ),
  );

  console.log(
    `\n${out.length} breweries — ${fetched} newly geocoded, ${cached} from cache, ` +
      `${out.filter((b) => b.lat === null).length} without coordinates.`,
  );
  if (failures.length) {
    console.log('\nNeeds a hand-checked address:');
    for (const f of failures) console.log(`  - ${f.name}: "${f.query}"`);
  }
  console.log(`\nWrote ${path.relative(process.cwd(), OUT)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
