/**
 * The Growler Ontario → editorial evidence for `knownFor`.
 *
 * WHY THIS SOURCE, AND WHY IT SUDDENLY MATTERS. The plan was that Reddit would
 * carry style reputation. It cannot: self-service Data API app creation ended
 * under Reddit's Responsible Builder Policy and new apps are gated on a
 * moderation use case. All three per-beer rating sites (Untappd, RateBeer,
 * BeerAdvocate) are closed too. That leaves juried awards and editorial writing
 * as the only reachable third-party classes — see `source-register.md`. This is
 * the largest editorial source in Ontario and it is wide open.
 *
 * WHAT IT GIVES US that nothing else does: a "Featured beers" block naming the
 * beer, its ABV and a tasting description, written up per brewery. That is a
 * stated (brewery → beer → style → character) tuple rather than something we
 * have to infer from a product listing.
 *
 * IT IS LISTED PER LOCATION, which is the unit this project settled on.
 * "Refined Fool Brewing Co. (The Fool)" and "Refined Fool Brewing Co. (Sports)"
 * are separate entries, so this doubles as an independent second opinion on
 * which brands run more than one site.
 *
 * ⚠️  SPONSORSHIP. Listings carry a "Featured" flag and the site sells
 * advertising, so some copy is paid placement and some is brewery-supplied.
 * A brewery is never an independent witness for itself. `sponsored` and
 * `selfDescribed` are recorded on every record and the classifier MUST treat
 * those as class 5 (candidate only), never as the second independent class
 * that promotes a claim to Tier A. Getting this wrong reproduces the True
 * History failure with a magazine's byline on it.
 *
 * ACCESS. Structured index through the WordPress REST API
 * (`/wp-json/wp/v2/wpbdp_listing`, no auth, 265 records), prose from the
 * listing pages. robots is `index, follow`; there is no WAF and no challenge.
 * We still crawl slowly — one request at a time, with a pause.
 *
 *   node scripts/fetch-growler.mjs           # everything
 *   node scripts/fetch-growler.mjs --limit=5 # smoke test
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, '..', 'data', 'growler-listings.json');

const BASE = 'https://on.thegrowler.ca';
const API = `${BASE}/wp-json/wp/v2/wpbdp_listing`;

const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? Number(limitArg.split('=')[1]) : Infinity;

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-CA,en-US;q=0.9,en;q=0.8',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const decode = (s) =>
  s
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&(?:rsquo|lsquo);/g, "'")
    .replace(/&(?:rdquo|ldquo);/g, '"')
    .replace(/&(?:ndash|mdash);/g, '—');

/** Tags stripped to newlines, not to nothing: the page's structure IS the data. */
function toLines(htmlStr) {
  const stripped = htmlStr
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '\n');
  return decode(stripped)
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

async function getJSON(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

/** Walk the REST index. `x-wp-total` tells us when to stop. */
async function listAll() {
  const out = [];
  for (let page = 1; ; page++) {
    const res = await fetch(`${API}?per_page=100&page=${page}&_fields=id,link,title`, {
      headers: HEADERS,
    });
    if (res.status === 400) break; // past the last page
    if (!res.ok) throw new Error(`${res.status} listing index page ${page}`);
    const batch = await res.json();
    if (!batch.length) break;
    out.push(
      ...batch.map((b) => ({
        id: b.id,
        name: decode(b.title?.rendered ?? '').trim(),
        url: b.link,
      })),
    );
    const total = Number(res.headers.get('x-wp-totalpages') ?? 1);
    if (page >= total) break;
    await sleep(400);
  }
  return out;
}

/**
 * Pull the listing body.
 *
 * The page is a flat run of text with two labelled sections — "Featured beers:"
 * and "Find us:" — so we anchor on those labels rather than on CSS classes,
 * which a theme update would break. Everything between the brewery name and
 * the first label is the description.
 */
function parseListing(htmlStr, name) {
  const lines = toLines(htmlStr);

  // The listing body starts at the LAST occurrence of the brewery name before
  // the labels — earlier hits are the <title> and the breadcrumb.
  const beersAt = lines.findIndex((l) => /^featured beers:?$/i.test(l));
  const findAt = lines.findIndex((l) => /^find us:?$/i.test(l));
  const end = findAt >= 0 ? findAt : lines.length;
  const bodyStart = lines
    .slice(0, beersAt >= 0 ? beersAt : end)
    .findLastIndex((l) => l.toLowerCase().includes(name.toLowerCase().slice(0, 12)));

  const sponsored = lines
    .slice(Math.max(0, bodyStart), end)
    .some((l) => /^(featured|sponsored)$/i.test(l));

  const descLines = lines
    .slice(bodyStart + 1, beersAt >= 0 ? beersAt : end)
    .filter((l) => !/^(featured|sponsored)$/i.test(l) && l.length > 40);

  /**
   * Beers come as a name line, usually an ABV/IBU line, then prose. The ABV
   * line is the reliable delimiter; a name with no ABV still counts, so we
   * treat any short line following a prose block as the next beer.
   */
  const beers = [];
  if (beersAt >= 0) {
    let cur = null;
    for (const line of lines.slice(beersAt + 1, end)) {
      const abv = line.match(/ABV:?\s*([\d.]+)\s*%/i);
      const ibu = line.match(/IBU\s*([\d.]+)/i);
      if (abv || ibu) {
        if (cur) {
          if (abv) cur.abv = Number(abv[1]);
          if (ibu) cur.ibu = Number(ibu[1]);
        }
        continue;
      }
      if (line.length <= 60 && !/[.!?]$/.test(line)) {
        if (cur) beers.push(cur);
        cur = { name: line, notes: '' };
      } else if (cur) {
        cur.notes = cur.notes ? `${cur.notes} ${line}` : line;
      }
    }
    if (cur) beers.push(cur);
  }

  let address = null;
  let website = null;
  if (findAt >= 0) {
    for (const line of lines.slice(findAt + 1, findAt + 8)) {
      if (/^https?:\/\//i.test(line)) website ??= line;
      else if (/,\s*ON\b/i.test(line) || /[A-Z]\d[A-Z]\s?\d[A-Z]\d/.test(line)) address ??= line;
    }
  }

  return {
    description: descLines.join(' ').trim() || null,
    beers: beers.filter((b) => b.name && !/^find us/i.test(b.name)),
    address,
    website,
    sponsored,
  };
}

async function main() {
  console.log('Indexing listings…');
  const index = await listAll();
  console.log(`  ${index.length} listings`);

  const targets = index.slice(0, LIMIT === Infinity ? undefined : LIMIT);
  const records = [];
  let withBeers = 0;

  for (const [i, item] of targets.entries()) {
    try {
      const res = await fetch(item.url, { headers: HEADERS });
      if (!res.ok) throw new Error(String(res.status));
      const parsed = parseListing(await res.text(), item.name);
      if (parsed.beers.length) withBeers++;
      records.push({
        ...item,
        ...parsed,
        /**
         * Copy on a directory listing is usually supplied by the brewery. It
         * generates candidates; it can never confirm one. See the sponsorship
         * note at the top of this file.
         */
        selfDescribed: true,
        source: 'thegrowler-on',
        fetchedAt: new Date().toISOString().slice(0, 10),
      });
      process.stdout.write(
        `\r  ${i + 1}/${targets.length}  ${withBeers} with featured beers   `,
      );
    } catch (err) {
      console.warn(`\n  ! ${item.name}: ${err.message}`);
    }
    await sleep(1000); // one request per second, sequential. Be a good guest.
  }

  await writeFile(OUT, `${JSON.stringify(records, null, 2)}\n`);
  const beerCount = records.reduce((n, r) => n + r.beers.length, 0);
  console.log(`\n\nWrote ${path.relative(process.cwd(), OUT)}`);
  console.log(`  ${records.length} listings`);
  console.log(`  ${withBeers} with a Featured beers block, ${beerCount} beers named`);
  console.log(`  ${records.filter((r) => r.sponsored).length} flagged sponsored/featured`);
  console.log(`  ${records.filter((r) => r.website).length} with a website`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
