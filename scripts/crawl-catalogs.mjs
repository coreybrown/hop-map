/**
 * Stage 1 of style enrichment: find each brewery's beer list and pull the text.
 *
 * Deliberately does NOT try to parse 168 different site structures into
 * structured beer records — that way lies a brittle mess of per-site
 * selectors. Instead it finds the most likely beer page, extracts clean
 * readable text, and hands that to Stage 2 (LLM classification), which is
 * far more robust to layout variation than any selector we could write.
 *
 * Politeness is not optional here: real robots.txt checks, per-host rate
 * limiting, an honest User-Agent, and a hard cap on pages per brewery.
 *
 *   node scripts/crawl-catalogs.mjs            # all breweries with a website
 *   node scripts/crawl-catalogs.mjs godspeed   # one, for debugging
 *   node scripts/crawl-catalogs.mjs --limit 20
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(here, '..', 'data');
const REGISTRY = path.join(DATA_DIR, 'registry.json');
const OUT = path.join(DATA_DIR, 'catalogs.json');

const UA = 'OntarioBeerMapBot/0.1 (+hobby project; respects robots.txt)';
const HOST_DELAY_MS = 1500;
const FETCH_TIMEOUT_MS = 15000;
const MAX_TEXT = 6000;

const args = process.argv.slice(2);
const limitArg = args.indexOf('--limit');
const LIMIT = limitArg !== -1 ? Number(args[limitArg + 1]) : Infinity;
const ONLY = args.find((a) => !a.startsWith('--') && a !== String(LIMIT));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Paths a brewery's beer list actually tends to live at, best guesses first. */
const BEER_PATHS = [
  '/beers', '/beer', '/our-beer', '/our-beers', '/the-beer',
  '/products', '/shop', '/collections/all', '/collections/beer', '/beer-list',
  '/whats-on-tap', '/on-tap', '/taproom', '/lineup', '/brews',
  '/menu', '/menus', '/drinks', '/drink-menu', '/beer-menu', '/tap-list',
  // Bottle-shop pages are often the richest source: True History's /retail
  // lists every beer with an explicit style label and no marketing prose.
  '/retail', '/bottle-shop', '/bottleshop', '/fridge', '/store', '/cans',
];

const STYLE_WORDS =
  /\b(ipa|lager|pilsner|stout|porter|ale|saison|sour|gose|hazy|pale|wheat|witbier|kolsch|kölsch|hefeweizen|dunkel|helles|amber|brown|barleywine|tripel|dubbel|farmhouse|brett|radler|cider|seltzer)\b/i;

const robotsCache = new Map();
const lastHit = new Map();

async function politeFetch(url) {
  const host = new URL(url).host;
  const since = Date.now() - (lastHit.get(host) ?? 0);
  if (since < HOST_DELAY_MS) await sleep(HOST_DELAY_MS - since);
  lastHit.set(host, Date.now());

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/json' },
      redirect: 'follow',
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Minimal robots.txt honouring: reads Disallow rules for our UA and for *,
 * and refuses any path they cover. Not a full RFC implementation, but it
 * respects the intent, which is the point.
 */
async function allowed(url) {
  const { origin, pathname } = new URL(url);
  if (!robotsCache.has(origin)) {
    try {
      const res = await politeFetch(`${origin}/robots.txt`);
      const text = res.ok ? await res.text() : '';
      const rules = [];
      let applies = false;
      for (const raw of text.split('\n')) {
        const line = raw.split('#')[0].trim();
        if (!line) continue;
        const [rawKey, ...rest] = line.split(':');
        const key = rawKey.trim().toLowerCase();
        const value = rest.join(':').trim();
        if (key === 'user-agent') {
          applies = value === '*' || UA.toLowerCase().includes(value.toLowerCase());
        } else if (key === 'disallow' && applies && value) {
          rules.push(value);
        }
      }
      robotsCache.set(origin, rules);
    } catch {
      robotsCache.set(origin, []);
    }
  }
  return !robotsCache.get(origin).some((rule) => pathname.startsWith(rule));
}

/** Shopify stores hand us the catalog directly — always try this first. */
async function tryShopify(base) {
  const url = `${base}/products.json?limit=250`;
  if (!(await allowed(url))) return null;
  try {
    const res = await politeFetch(url);
    if (!res.ok) return null;
    if (!(res.headers.get('content-type') ?? '').includes('json')) return null;
    const { products } = await res.json();
    if (!Array.isArray(products) || products.length === 0) return null;

    const beers = products
      .map((p) => ({
        name: p.title.trim(),
        type: p.product_type ?? '',
        description: (p.body_html ?? '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 240),
      }))
      .filter((b) => STYLE_WORDS.test(`${b.name} ${b.type} ${b.description}`));

    return beers.length ? { method: 'shopify', source: url, beers } : null;
  } catch {
    return null;
  }
}

/**
 * Strip an HTML page down to readable text.
 *
 * Many brewery sites are JS-rendered: megabytes of markup, a couple of
 * hundred characters of visible text, and the real content sitting in an
 * embedded JSON payload. So when the rendered text comes up thin, we mine
 * the structured data those frameworks leave behind before giving up.
 */
function readableText(html) {
  const $ = cheerio.load(html);

  const embedded = [];
  $('script').each((_, el) => {
    const type = $(el).attr('type') ?? '';
    const id = $(el).attr('id') ?? '';
    const raw = $(el).contents().text();
    if (!raw) return;
    if (type.includes('ld+json') || id === '__NEXT_DATA__' || /Static(Query|Data)/.test(id)) {
      embedded.push(raw);
    }
  });

  $('script, style, nav, header, footer, noscript, svg, form, iframe').remove();
  const main = $('main').text().replace(/\s+/g, ' ').trim();
  const body = $('body').text().replace(/\s+/g, ' ').trim();
  let text = main.length > 400 ? main : body;

  if (text.length < 400 && embedded.length) {
    // Pull human-readable strings out of the payload; discard URLs, hashes
    // and the framework's own keys.
    const strings = embedded
      .join(' ')
      .match(/"[^"\\]{6,180}"/g)
      ?.map((s) => s.slice(1, -1))
      .filter(
        (s) =>
          /\s/.test(s) &&
          !/^https?:|^\/|^[a-f0-9]{16,}$|^[A-Za-z0-9+/=]{40,}$/.test(s) &&
          !/^(image|video|application)\//.test(s),
      );
    if (strings?.length) text = `${text} ${[...new Set(strings)].join(' · ')}`.trim();
  }

  return text;
}

/** Find a link on the homepage that looks like it leads to the beer list. */
function findBeerLink(html, base) {
  const $ = cheerio.load(html);
  const candidates = [];
  $('a[href]').each((_, el) => {
    const label = $(el).text().trim().toLowerCase();
    const href = $(el).attr('href') ?? '';
    if (!label || label.length > 40) return;
    if (
      /\b(beer|beers|brews|on tap|tap list|taproom|our beer|shop|products|lineup|menu|drinks?)\b/.test(
        label,
      )
    ) {
      try {
        candidates.push({ label, url: new URL(href, base).toString() });
      } catch {
        /* malformed href */
      }
    }
  });
  return candidates[0]?.url ?? null;
}

/** Markers of a news feed, blog roll or events page rather than a beer list. */
const EDITORIAL =
  /\b(latest news|read more|posted on|continue reading|blog|events?\b.*\bcategory|comments?\b|\d{1,2}(st|nd|rd|th) (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))/gi;

/**
 * Is this page actually a beer list?
 *
 * A URL of /beer proves nothing: Left Field's /beer page is their news feed,
 * full of posts about patio openings. It contained just enough style words to
 * pass a naive check, and the brewery got classified from noise — losing
 * Greenwood and Bluebird entirely.
 *
 * A real beer list is DENSE in style words. Prose about a brewery mentions
 * them in passing. So we measure density rather than presence, and reject
 * pages carrying obvious editorial furniture.
 */
function usable(text) {
  if (text.length < 220) return false;

  const styleHits = (text.match(STYLE_WORDS) ?? []).length;
  if (styleHits < 3) return false;

  const density = (styleHits / text.length) * 1000;
  const editorialHits = (text.match(EDITORIAL) ?? []).length;

  // A beer list runs 5–30 style words per 1000 characters. Below ~2.5 it is
  // prose that happens to mention beer.
  if (density < 2.5) return false;
  if (editorialHits >= 3 && density < 6) return false;

  return true;
}

/**
 * Homepage first, then follow the site's own navigation.
 *
 * Guessing paths blind meant up to nineteen requests per brewery, which is
 * both slow and rude. Asking the homepage where its beer lives is two or
 * three requests, and a link the site actually publishes beats a URL we
 * invented.
 */
async function tryHtml(base) {
  let home;
  try {
    if (!(await allowed(base))) return null;
    const res = await politeFetch(base);
    if (!res.ok) return null;
    home = await res.text();
  } catch {
    return null;
  }

  // 1 · The link the site itself points at.
  const link = findBeerLink(home, base);
  if (link) {
    try {
      if (await allowed(link)) {
        const res = await politeFetch(link);
        if (res.ok) {
          const text = readableText(await res.text());
          if (usable(text)) {
            return { method: 'html', source: link, text: text.slice(0, MAX_TEXT) };
          }
        }
      }
    } catch {
      /* fall through */
    }
  }

  // 2 · A short list of the highest-probability paths, not the whole guessbook.
  for (const p of BEER_PATHS.slice(0, 5)) {
    const url = `${base}${p}`;
    try {
      if (!(await allowed(url))) continue;
      const res = await politeFetch(url);
      if (!res.ok) continue;
      const text = readableText(await res.text());
      if (usable(text)) {
        return { method: 'html', source: url, text: text.slice(0, MAX_TEXT) };
      }
    } catch {
      /* try the next */
    }
  }

  // 3 · Small sites often list the core range on the homepage itself.
  const text = readableText(home);
  if (usable(text)) {
    return { method: 'homepage', source: base, text: text.slice(0, MAX_TEXT) };
  }

  return null;
}

async function main() {
  const { breweries } = JSON.parse(await readFile(REGISTRY, 'utf8'));
  const existing = existsSync(OUT)
    ? JSON.parse(await readFile(OUT, 'utf8')).catalogs
    : {};

  let targets = breweries.filter((b) => {
    const site = b.links?.website || b.website;
    return site && b.status !== 'closed';
  });
  if (ONLY) targets = targets.filter((b) => b.id === ONLY);
  targets = targets.slice(0, LIMIT);

  console.log(`Crawling ${targets.length} brewery sites…\n`);

  const catalogs = { ...existing };
  const stats = { shopify: 0, html: 0, homepage: 0, failed: 0, cached: 0 };

  for (const brewery of targets) {
    if (catalogs[brewery.id] && !ONLY) {
      stats.cached++;
      continue;
    }

    const base = (brewery.links?.website || brewery.website).replace(/\/+$/, '');
    process.stdout.write(`  ${brewery.name.slice(0, 36).padEnd(38)}`);

    let result = null;
    try {
      result = (await tryShopify(base)) ?? (await tryHtml(base));
    } catch (err) {
      process.stdout.write(`error: ${err.message} `);
    }

    if (result) {
      catalogs[brewery.id] = { ...result, name: brewery.name, crawledAt: new Date().toISOString() };
      stats[result.method]++;
      console.log(
        result.beers
          ? `${result.method} · ${result.beers.length} beers`
          : `${result.method} · ${result.text.length} chars`,
      );
    } else {
      stats.failed++;
      console.log('— nothing usable');
    }
  }

  await writeFile(
    OUT,
    JSON.stringify(
      { generatedAt: new Date().toISOString(), count: Object.keys(catalogs).length, catalogs },
      null,
      2,
    ),
  );

  const usable = stats.shopify + stats.html + stats.homepage;
  console.log(
    `\n${usable}/${targets.length - stats.cached} crawled successfully ` +
      `(${stats.shopify} structured store, ${stats.html} beer page, ${stats.homepage} homepage only).`,
  );
  console.log(`${stats.failed} had nothing usable. ${stats.cached} already cached.`);
  console.log(`Wrote ${path.relative(process.cwd(), OUT)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
