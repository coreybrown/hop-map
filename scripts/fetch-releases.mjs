/**
 * Best-effort release enrichment from brewery web stores.
 *
 * Most Ontario breweries run Shopify, which exposes /products.json publicly.
 * We read it, keep things that look like beer, and infer a style from the
 * title and description.
 *
 * This is deliberately NOT a release radar. Releases are evidence inside a
 * recommendation, so partial coverage is fine: a brewery we can't read just
 * doesn't get the extra reason line. Nothing fails, nothing is promised.
 *
 *   node scripts/fetch-releases.mjs            # all breweries
 *   node scripts/fetch-releases.mjs bellwoods  # one, for debugging
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(here, '..', 'data');
const IN = path.join(DATA_DIR, 'breweries.json');
const OUT = path.join(DATA_DIR, 'releases.json');

const UA = 'OntarioBeerMap/0.1 (hobby project)';
const POLITE_DELAY_MS = 900;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const only = process.argv[2];

/** Title/body keywords → style tag. First match in list order wins. */
const STYLE_RULES = [
  // NA first: it is the most specific claim, and "first match wins" means
  // anything matching it must be tested before session/low-alc absorbs it.
  ['non-alcoholic', /\b(non.?alcoholic|non.?alc\b|alcohol.?free|de.?alcoholi[sz]ed|0\.0\s?%)\b/i],
  ['hazy-ipa', /\b(hazy|neipa|new england|juicy|ddh|double dry.?hop)\b/i],
  ['west-coast-ipa', /\b(west coast|wcipa|clear ipa)\b/i],
  ['kolsch', /\b(kölsch|kolsch|kolsh)\b/i],
  ['amber-red', /\b(amber ale|red ale|irish red|altbier)\b/i],
  ['session-low-alc', /\b(session|low.?abv|0\.5%|radler|shandy)\b/i],
  ['barrel-aged', /\b(barrel.?aged|bourbon|whisk(e)?y barrel|foeder)\b/i],
  ['wild-ale', /\b(wild|brett|mixed ferment|spontaneous|coolship)\b/i],
  ['sour', /\b(sour|gose|berliner|kettle sour|fruited)\b/i],
  ['farmhouse-saison', /\b(saison|farmhouse|grisette)\b/i],
  ['stout-porter', /\b(stout|porter|imperial stout|pastry)\b/i],
  ['dark-lager', /\b(dark lager|schwarzbier|tmav|dunkel|black lager)\b/i],
  ['pilsner-lager', /\b(pilsner|pils|lager|helles|kellerbier|ležák|czech)\b/i],
  ['wheat-belgian', /\b(witbier|hefeweizen|weizen|belgian|dubbel|tripel|blanche)\b/i],
  ['pale-ale', /\b(pale ale|apa|xpa|cream ale|blonde)\b/i],
  ['hazy-ipa', /\bipa\b/i], // generic IPA falls to hazy — dominant ON style
];

/** Things a brewery sells that are not beer. */
const NOT_BEER =
  /\b(glass(ware)?|t.?shirt|hoodie|tee\b|hat\b|toque|merch|sticker|gift card|keg deposit|rental|growler$|crowler$|coffee|soda|hot sauce|opener|coaster|tote)\b/i;

function inferStyles(product) {
  const hay = `${product.title} ${product.product_type ?? ''} ${(product.tags ?? []).join(' ')} ${(product.body_html ?? '').replace(/<[^>]+>/g, ' ')}`;
  const found = [];
  for (const [tag, re] of STYLE_RULES) {
    if (re.test(hay) && !found.includes(tag)) found.push(tag);
    if (found.length >= 3) break;
  }
  return found;
}

async function fetchShopify(website) {
  const base = website.replace(/\/+$/, '');
  const res = await fetch(`${base}/products.json?limit=250`, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('json')) throw new Error('not a Shopify store');

  const data = await res.json();
  if (!Array.isArray(data.products)) throw new Error('unexpected shape');
  return data.products;
}

async function main() {
  const { breweries } = JSON.parse(await readFile(IN, 'utf8'));
  const targets = breweries.filter(
    (b) => b.status !== 'closed' && (!only || b.id === only),
  );

  const out = {};
  let ok = 0;
  const skipped = [];

  for (const brewery of targets) {
    process.stdout.write(`  ${brewery.name.padEnd(38)}`);
    try {
      const products = await fetchShopify(brewery.website);

      const releases = products
        .filter((p) => p.published_at && !NOT_BEER.test(p.title))
        .map((p) => ({
          name: p.title.trim(),
          styles: inferStyles(p),
          firstSeen: p.published_at.slice(0, 10),
          url: `${brewery.website.replace(/\/+$/, '')}/products/${p.handle}`,
          available: (p.variants ?? []).some((v) => v.available),
        }))
        .filter((r) => r.styles.length > 0)
        .sort((a, b) => b.firstSeen.localeCompare(a.firstSeen))
        .slice(0, 12);

      if (releases.length) {
        out[brewery.id] = releases;
        ok++;
        console.log(`${releases.length} releases`);
      } else {
        console.log('no beer matched');
        skipped.push(brewery.name);
      }
    } catch (err) {
      console.log(`— ${err.message}`);
      skipped.push(brewery.name);
    }
    await sleep(POLITE_DELAY_MS);
  }

  await writeFile(
    OUT,
    JSON.stringify(
      { generatedAt: new Date().toISOString(), breweriesWithReleases: ok, releases: out },
      null,
      2,
    ),
  );

  console.log(
    `\n${ok}/${targets.length} breweries returned releases. ` +
      `${skipped.length} had no readable store — they simply lose a reason line.`,
  );
  console.log(`Wrote ${path.relative(process.cwd(), OUT)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
