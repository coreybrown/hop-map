/**
 * Read every brewery's web store through its platform's own JSON API.
 *
 * This exists because `render-catalogs.mjs` is the expensive, lossy way to do
 * this job. Headless rendering reads a page of text and infers a beer list
 * from word density; a store API hands over the actual product records —
 * title, type, tags, description, availability, publish date — with no
 * guessing and no browser. Where a store API answers, it beats the crawl
 * outright, so it should be tried first and the crawl left to cover the rest.
 *
 * `fetch-releases.mjs` already does this for Shopify, but it reads
 * `breweries.json` — the hand-curated 63. The other ~137 registry breweries
 * with a website have never been asked. That is the gap this closes.
 *
 * Three platforms cover nearly all of them:
 *   Shopify      /products.json                     — the majority
 *   WooCommerce  /wp-json/wc/store/products         — most WordPress sites
 *   Squarespace  <page>?format=json-pretty          — needs a store path
 *
 * Nothing here writes styles. It captures the raw catalog; classification is
 * `classify-styles.mjs`'s job and stays a separate, auditable step.
 *
 *   node scripts/fetch-store-catalogs.mjs           # all with a website
 *   node scripts/fetch-store-catalogs.mjs --force   # re-poll ones already done
 *   node scripts/fetch-store-catalogs.mjs bellwoods # one, for debugging
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(here, '..', 'data');
const REGISTRY = path.join(DATA_DIR, 'registry.json');
const OUT = path.join(DATA_DIR, 'store-catalogs.json');

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const ONLY = args.find((a) => !a.startsWith('--'));

const UA = 'OntarioBeerMapBot/0.1 (hobby project; contact via github)';
const TIMEOUT_MS = 12_000;
const POLITE_MS = 700;
const CONCURRENCY = 6;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Everything here is best-effort against strangers' servers; never throw upward. */
async function getJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('json')) throw new Error('not json');
  return res.json();
}

const strip = (html) =>
  (html ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Shopify paginates at 250. Four pages is 1000 products — enough that only a
 * merch warehouse hits it, and `truncated` records when one does so a thin
 * result is never mistaken for a complete read.
 */
const SHOPIFY_MAX_PAGES = 4;

async function shopify(base) {
  const products = [];
  let truncated = false;
  for (let page = 1; page <= SHOPIFY_MAX_PAGES; page++) {
    const data = await getJson(`${base}/products.json?limit=250&page=${page}`);
    if (!Array.isArray(data.products)) throw new Error('unexpected shape');
    products.push(...data.products);
    if (data.products.length < 250) break;
    if (page === SHOPIFY_MAX_PAGES) truncated = true;
  }
  if (!products.length) throw new Error('empty store');

  return {
    platform: 'shopify',
    endpoint: `${base}/products.json`,
    truncated,
    products: products.map((p) => ({
      title: (p.title ?? '').trim(),
      type: p.product_type ?? '',
      tags: p.tags ?? [],
      description: strip(p.body_html).slice(0, 600),
      url: `${base}/products/${p.handle}`,
      publishedAt: p.published_at ? p.published_at.slice(0, 10) : '',
      available: (p.variants ?? []).some((v) => v.available),
      // ABV and format live in variant titles as often as anywhere else.
      variants: (p.variants ?? []).map((v) => v.title).filter((t) => t && t !== 'Default Title'),
    })),
  };
}

async function woocommerce(base) {
  const data = await getJson(`${base}/wp-json/wc/store/products?per_page=100`);
  if (!Array.isArray(data) || !data.length) throw new Error('empty store');
  return {
    platform: 'woocommerce',
    endpoint: `${base}/wp-json/wc/store/products`,
    products: data.map((p) => ({
      title: (p.name ?? '').trim(),
      type: (p.categories ?? []).map((c) => c.name).join(', '),
      tags: (p.tags ?? []).map((t) => t.name),
      description: strip(p.description || p.short_description).slice(0, 600),
      url: p.permalink ?? '',
      publishedAt: '',
      available: p.is_in_stock ?? true,
      variants: [],
    })),
  };
}

/**
 * Squarespace only answers on a real store page, and every site names that
 * page differently. Try the usual ones — a wrong guess costs one 404.
 */
const SQUARESPACE_PATHS = ['/shop', '/store', '/beer', '/beers', '/retail', '/bottle-shop', '/merch'];

async function squarespace(base) {
  for (const p of SQUARESPACE_PATHS) {
    try {
      const data = await getJson(`${base}${p}?format=json-pretty`);
      const items = data?.items;
      if (!Array.isArray(items) || !items.length) continue;
      const products = items
        .filter((it) => it.structuredContent?.productType != null || it.recordTypeLabel === 'product')
        .map((it) => ({
          title: (it.title ?? '').trim(),
          type: it.structuredContent?.productType === 2 ? 'digital' : 'physical',
          tags: it.tags ?? [],
          description: strip(it.excerpt || it.body).slice(0, 600),
          url: `${base}${p}/${it.urlId ?? ''}`,
          publishedAt: it.publishOn ? new Date(it.publishOn).toISOString().slice(0, 10) : '',
          available: !(it.structuredContent?.variants ?? []).every((v) => v.qtyInStock === 0),
          variants: (it.structuredContent?.variants ?? [])
            .map((v) => Object.values(v.attributes ?? {}).join(' '))
            .filter(Boolean),
        }));
      if (products.length) {
        return { platform: 'squarespace', endpoint: `${base}${p}?format=json-pretty`, products };
      }
    } catch {
      /* next path */
    }
  }
  throw new Error('no squarespace store found');
}

async function readStore(website) {
  const base = website.replace(/\/+$/, '');
  const errors = [];
  for (const [name, fn] of [
    ['shopify', shopify],
    ['woocommerce', woocommerce],
    ['squarespace', squarespace],
  ]) {
    try {
      return await fn(base);
    } catch (err) {
      errors.push(`${name}: ${err.message}`);
    }
  }
  throw new Error(errors.join(' · '));
}

async function main() {
  const { breweries } = JSON.parse(await readFile(REGISTRY, 'utf8'));
  const previous = existsSync(OUT) ? JSON.parse(await readFile(OUT, 'utf8')) : { stores: {} };
  const stores = { ...previous.stores };

  let targets = breweries.filter((b) => (b.links?.website || b.website) && b.status !== 'closed');
  if (ONLY) targets = targets.filter((b) => b.id === ONLY);
  else if (!FORCE) targets = targets.filter((b) => !stores[b.id]);

  console.log(`Polling ${targets.length} brewery store APIs…\n`);

  let ok = 0;
  let miss = 0;
  const byPlatform = {};

  // Small fixed pool: polite to each host, but 200 sequential timeouts would
  // take half an hour of mostly waiting.
  const queue = [...targets];
  const worker = async () => {
    while (queue.length) {
      const brewery = queue.shift();
      const site = brewery.links?.website || brewery.website;
      try {
        const store = await readStore(site);
        stores[brewery.id] = {
          name: brewery.name,
          website: site,
          ...store,
          productCount: store.products.length,
          fetchedAt: new Date().toISOString(),
        };
        ok++;
        byPlatform[store.platform] = (byPlatform[store.platform] ?? 0) + 1;
        console.log(
          `  ✓ ${brewery.name.slice(0, 34).padEnd(36)} ${store.platform.padEnd(12)} ${store.products.length} products`,
        );
      } catch (err) {
        miss++;
        console.log(`  — ${brewery.name.slice(0, 34).padEnd(36)} ${String(err.message).slice(0, 60)}`);
      }
      await sleep(POLITE_MS);
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  await writeFile(
    OUT,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        count: Object.keys(stores).length,
        byPlatform,
        stores,
      },
      null,
      2,
    ),
  );

  console.log(`\n${ok} stores read, ${miss} with no readable API.`);
  console.log('By platform:', byPlatform);
  console.log(`${Object.keys(stores).length} total in ${path.relative(process.cwd(), OUT)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
