/**
 * Exercises the ranking engine against the scenarios from discovery.
 *
 * Run: npx tsx scripts/test-ranking.mjs
 * (`node --experimental-strip-types` can't resolve ranking.ts's extensionless
 * `./types` import; tsx can, and is already a dependency.)
 *
 * Reads registry.json, NOT breweries.json. The seed still carries the
 * pre-split flat `styles: []`, so ranking it throws on `styles.knownFor` —
 * and the seed is 63 records against the registry's 270. The registry is
 * what the product serves, so the test exercises what the product serves.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rankBreweries, buildCrawl } from '../lib/ranking.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(
  readFileSync(path.join(here, '..', 'data', 'registry.json'), 'utf8'),
);
const breweries = data.breweries;

const PLACES = {
  toronto: { lat: 43.6532, lng: -79.3832 },
  ottawa: { lat: 45.4215, lng: -75.6972 },
  kingston: { lat: 44.2312, lng: -76.486 },
  ossington: { lat: 43.6465, lng: -79.4197 },
};

function show(title, results, limit = 6) {
  console.log(`\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}`);
  if (!results.length) {
    console.log('  (no matches)');
    return;
  }
  results.slice(0, limit).forEach((r, i) => {
    const geo =
      r.detourKm !== undefined
        ? `${r.detourKm}km detour`
        : r.distanceKm !== undefined
          ? `${r.distanceKm.toFixed(1)}km`
          : '';
    console.log(
      `\n${i + 1}. ${r.brewery.name} — ${r.brewery.city} ${geo ? `(${geo})` : ''}  [score ${r.score.toFixed(0)}]`,
    );
    r.reasons.forEach((reason) => console.log(`     · ${reason}`));
  });
}

// Corey's original story: driving the 401 Toronto → Ottawa, wants good beer.
show(
  "401 corridor, Toronto → Ottawa, hazy IPA (Corey's original trip)",
  rankBreweries(breweries, {
    styles: ['hazy-ipa'],
    route: { origin: PLACES.toronto, destination: PLACES.ottawa },
    radiusKm: 20,
    requireBottleShop: true,
  }),
);

// The trip-planner example: Kingston → Toronto for a weekend.
show(
  'Kingston → Toronto weekend, group likes hazy IPA + pilsner',
  rankBreweries(breweries, {
    styles: ['hazy-ipa', 'pilsner-lager'],
    route: { origin: PLACES.kingston, destination: PLACES.toronto },
    radiusKm: 25,
  }),
);

// The style-bias test: does a lager query surface Godspeed over Steam Whistle?
show(
  'Toronto, 25km, PILSNER & LAGER — the style-bias test',
  rankBreweries(breweries, {
    styles: ['pilsner-lager'],
    anchor: PLACES.toronto,
    radiusKm: 25,
  }),
);

// Group crawl walkable from a hotel on Ossington.
const nearHotel = rankBreweries(breweries, {
  styles: ['hazy-ipa', 'sour'],
  anchor: PLACES.ossington,
  radiusKm: 6,
});
show(
  'Walkable crawl from an Ossington hotel — hazy + sour, 3 stops',
  buildCrawl(nearHotel, PLACES.ossington, 3),
  3,
);
