/**
 * Headless-render every brewery site and extract its beer list.
 *
 * Static fetching has a hard ceiling. True History's bottle shop lists eight
 * lagers with explicit style labels — and none of it exists in the HTML
 * source, because the page builds itself client-side. Roughly half of Ontario
 * brewery sites are like this. No amount of better path-guessing reaches them.
 *
 * This runs over EVERY site, not just the ones that failed statically: a page
 * that parsed fine can still be the wrong page. Left Field's /beer is their
 * news feed, and it produced a confidently wrong classification.
 *
 * Resumable by design — results are written after every brewery, so an
 * interrupted run loses at most one site.
 *
 *   node scripts/render-catalogs.mjs                # everything not yet done
 *   node scripts/render-catalogs.mjs --force        # redo all
 *   node scripts/render-catalogs.mjs --concurrency=8
 *   node scripts/render-catalogs.mjs true-history   # one, for debugging
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(here, '..', 'data');
const REGISTRY = path.join(DATA_DIR, 'registry.json');
const OUT = path.join(DATA_DIR, 'rendered-catalogs.json');

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const ONLY = args.find((a) => !a.startsWith('--'));

const NAV_TIMEOUT = 25_000;
const SETTLE_MS = 1800;
const POLITE_MS = 900;

/**
 * Breweries are crawled in parallel; the PAGES of one brewery are still
 * strictly sequential with a delay between them. That keeps the politeness
 * guarantee that matters — we never open more than one connection to any
 * single host — while not spending two hours waiting on other people's
 * timeouts one at a time. Every worker owns its own page, so there is no
 * shared browser state to race on.
 */
const CONCURRENCY = Number(
  (args.find((a) => a.startsWith('--concurrency=')) ?? '').split('=')[1] || 5,
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Pages that tend to hold a real beer list, in rough order of usefulness. */
const CANDIDATE_PATHS = [
  '/retail', '/bottle-shop', '/shop', '/beers', '/beer', '/our-beer',
  '/our-beers', '/beer-menu', '/tap-list', '/taplist', '/whats-on-tap',
  '/products', '/collections/all', '/collections/beer', '/collections/beers',
  '/menu', '/drinks', '/taproom', '/on-tap', '/now-pouring', '/current-beers',
];

const LINK_RE =
  /\b(beer|beers|brews|on tap|tap list|taproom|bottle ?shop|retail|shop|products|menu|drinks?|fridge|lineup)\b/i;

const STYLE_WORDS =
  /\b(ipa|lager|pilsner|pils|stout|porter|ale|saison|sour|gose|hazy|pale|wheat|witbier|kölsch|kolsch|hefeweizen|dunkel|helles|doppelbock|bock|amber|brown|barleywine|tripel|dubbel|farmhouse|brett|radler|schankbier|dortmunder|marzen|märzen)\b/gi;

const EDITORIAL =
  /\b(latest news|read more|posted on|continue reading|comments?|subscribe|newsletter)\b/gi;

/**
 * Density, not presence. A beer list is thick with style words; prose that
 * merely mentions beer is not. This is what catches news pages masquerading
 * as beer pages.
 */
function assess(text) {
  const hits = (text.match(STYLE_WORDS) ?? []).length;
  const density = text.length ? (hits / text.length) * 1000 : 0;
  const editorial = (text.match(EDITORIAL) ?? []).length;
  const usable = text.length > 200 && hits >= 4 && density >= 2.5 && !(editorial >= 3 && density < 6);
  return { hits, density, editorial, usable, score: density * Math.min(hits, 40) };
}

/**
 * Ontario brewery sites are alcohol sites, so a large share of them open with
 * a 19+ interstitial. Headless, that reads as a page containing no beer words
 * at all — which is exactly how a real beer list ends up scored "nothing
 * usable". Measured on the failures, roughly a quarter of them are this.
 *
 * So: detect the gate, affirm it, and re-read. The click is the same
 * self-attestation any visitor makes to view a public beer list, and the
 * cookie it sets is shared by the whole browser context, so each site is
 * asked once rather than once per page.
 */
const AGE_GATE =
  /\b(are you (of legal|19|21)|age verification|verify your age|over the age of|enter your (birth|date of birth)|must be (of legal drinking age|19|21)|legal drinking age|confirm your age|are you old enough)\b/i;

/** Affirmative controls, in the order we should prefer them. */
const YES_RE =
  /^(yes|yes[,!.]?\s*i.{0,12}(am|m)\b.*|i am (over )?(19|21|of legal).*|i.m (over )?(19|21).*|over (19|21).*|19\s*\+|21\s*\+|enter( site)?|confirm|continue|agree|i agree|accept)$/i;

/**
 * Cookie banners are NOT age gates and must never be auto-accepted. Creemore's
 * banner puts an "ENTER" control right next to "I consent to cookies", and a
 * naive affirmative-matcher clicks it — silently opting in to tracking on
 * someone else's behalf. Anything matching this is left alone.
 */
const CONSENT = /\b(cookie|consent|tracking|privacy preferences|gdpr)\b/i;

async function passAgeGate(page) {
  const text = await page.evaluate(() => document.body?.innerText ?? '');
  if (!AGE_GATE.test(text)) return false;

  const clicked = await page.evaluate(([src, consentSrc]) => {
    const yes = new RegExp(src, 'i');
    const consent = new RegExp(consentSrc, 'i');
    const candidates = [
      ...document.querySelectorAll(
        'button, a[role=button], input[type=button], input[type=submit], [class*=age] button, [id*=age] button, a',
      ),
    ];
    // Prefer an exact affirmative over anything merely containing "yes",
    // so we never click "No" or a "Yes, email me offers" newsletter opt-in.
    for (const el of candidates) {
      const label = (el.innerText || el.value || '').trim();
      const near = (el.closest('[class*=cookie],[class*=consent],[id*=cookie],[id*=consent]') ? 'consent' : '');
      if (
        label &&
        yes.test(label) &&
        !/no\b|under|exit|leave/i.test(label) &&
        !consent.test(label) &&
        !near
      ) {
        el.click();
        return label;
      }
    }
    return null;
  }, [YES_RE.source, CONSENT.source]);

  if (!clicked) return false;
  await page.waitForTimeout(1200);
  return true;
}

async function readPage(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  // Give client-side rendering a moment; networkidle hangs on sites with
  // long-polling or analytics beacons, so a fixed settle is more reliable.
  await page.waitForTimeout(SETTLE_MS);

  // A gate hides the whole page; clear it before deciding there's nothing here.
  if (await passAgeGate(page)) await page.waitForTimeout(SETTLE_MS);

  return page.evaluate(() => {
    document
      .querySelectorAll('script,style,noscript,svg,iframe,nav,header,footer')
      .forEach((el) => el.remove());
    const main = document.querySelector('main');
    const root = main && main.innerText.length > 300 ? main : document.body;
    return (root?.innerText ?? '').replace(/\s+/g, ' ').trim();
  });
}

async function findLinks(page, base) {
  return page.evaluate((origin) => {
    const out = [];
    document.querySelectorAll('a[href]').forEach((a) => {
      const label = (a.textContent ?? '').trim();
      if (!label || label.length > 42) return;
      try {
        const url = new URL(a.getAttribute('href'), origin).toString();
        if (url.startsWith(origin)) out.push({ label, url });
      } catch {
        /* ignore */
      }
    });
    return out;
  }, base);
}

async function crawlBrewery(page, brewery) {
  const base = (brewery.links?.website || brewery.website).replace(/\/+$/, '');
  const tried = new Set();
  const results = [];

  // The homepage tells us what the site calls its beer page.
  let navLinks = [];
  try {
    const homeText = await readPage(page, base);
    navLinks = await findLinks(page, base);
    const home = assess(homeText);
    if (home.usable) results.push({ url: base, text: homeText, ...home, via: 'homepage' });
    tried.add(base);
  } catch {
    /* homepage unreachable; still try direct paths */
  }

  const targets = [
    ...navLinks.filter((l) => LINK_RE.test(l.label)).map((l) => l.url),
    ...CANDIDATE_PATHS.map((p) => `${base}${p}`),
  ];

  for (const url of targets) {
    if (tried.has(url) || tried.size > 12) continue;
    tried.add(url);
    try {
      const text = await readPage(page, url);
      const a = assess(text);
      if (a.usable) results.push({ url, text, ...a, via: 'page' });
      // A really dense page is certainly the beer list; stop looking.
      if (a.usable && a.density > 8) break;
    } catch {
      /* try the next candidate */
    }
    await sleep(POLITE_MS);
  }

  if (!results.length) return null;

  // Keep the densest page found — that's the one most likely to be the
  // actual list rather than a page that mentions beer in passing.
  results.sort((a, b) => b.score - a.score);
  const best = results[0];
  return {
    name: brewery.name,
    method: 'rendered',
    source: best.url,
    text: best.text.slice(0, 8000),
    density: Number(best.density.toFixed(2)),
    styleHits: best.hits,
    renderedAt: new Date().toISOString(),
  };
}

async function main() {
  const { breweries } = JSON.parse(await readFile(REGISTRY, 'utf8'));
  const done = existsSync(OUT)
    ? JSON.parse(await readFile(OUT, 'utf8')).catalogs
    : {};

  let targets = breweries.filter((b) => {
    const site = b.links?.website || b.website;
    return site && b.status !== 'closed';
  });
  if (ONLY) targets = targets.filter((b) => b.id === ONLY);
  if (!FORCE && !ONLY) targets = targets.filter((b) => !done[b.id]);

  console.log(`Rendering ${targets.length} brewery sites (headless chromium)…\n`);

  const browser = await chromium.launch();
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) OntarioBeerMapBot/0.1 Chrome/151 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    // Images and fonts are pure cost here; we only want text.
    serviceWorkers: 'block',
  });
  await context.route('**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf,mp4,webm}', (r) =>
    r.abort(),
  );

  const catalogs = { ...done };
  let ok = 0;
  let fail = 0;
  let started = 0;

  // Writes still happen after every brewery, but several workers finish at
  // once — so they queue behind one another rather than interleaving and
  // truncating the file.
  let writing = Promise.resolve();
  const save = () => {
    writing = writing.then(() =>
      writeFile(
        OUT,
        JSON.stringify(
          { generatedAt: new Date().toISOString(), count: Object.keys(catalogs).length, catalogs },
          null,
          2,
        ),
      ),
    );
    return writing;
  };

  const queue = [...targets];
  const worker = async () => {
    while (queue.length) {
      const brewery = queue.shift();
      const n = ++started;
      const page = await context.newPage();
      page.setDefaultTimeout(NAV_TIMEOUT);

      const label = `  [${String(n).padStart(3)}/${targets.length}] ${brewery.name.slice(0, 34).padEnd(36)}`;
      try {
        const result = await crawlBrewery(page, brewery);
        if (result) {
          catalogs[brewery.id] = result;
          ok++;
          console.log(`${label}✓ density ${result.density} · ${result.styleHits} styles`);
        } else {
          fail++;
          console.log(`${label}— nothing usable`);
        }
      } catch (err) {
        fail++;
        console.log(`${label}— ${String(err.message).slice(0, 48)}`);
      } finally {
        await page.close().catch(() => {});
      }

      await save();
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  await writing;

  await context.close();
  await browser.close();

  console.log(`\n${ok} rendered successfully, ${fail} with nothing usable.`);
  console.log(`${Object.keys(catalogs).length} total in ${path.relative(process.cwd(), OUT)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
