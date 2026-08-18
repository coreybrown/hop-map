/**
 * Canadian Brewing Awards medals → reputation evidence for `knownFor`.
 *
 * WHY THIS SOURCE. `knownFor` is the one field that can send someone on a
 * wasted drive, so it needs evidence a stranger can check. A CBA medal is
 * blind-judged by a panel against a written style spec, published publicly,
 * and attributable to a year and a category. That is the strongest claim
 * available to us without an API key.
 *
 * WHAT IT IS NOT. Medals only cover breweries that ENTER, and entry costs
 * money and effort. Plenty of well-regarded breweries never bother —
 * Bellwoods does not chase medals. So a medal is evidence FOR a style and
 * silence is evidence of NOTHING. This file must never be used to conclude a
 * brewery is not known for something.
 *
 * WHERE IT COMES FROM. canadianbrewingawards.com is mid-rebuild and currently
 * serves "Under construction" — every /YYYY-winners/ path 404s. The archived
 * copies of those same official pages are therefore the live source, reached
 * through the Wayback CDX index. When the real site returns, point BASE at it
 * and the parser should still work: the winners table has been the same five
 * columns (Category, Award, Beer, Brewery, Province) for a decade.
 *
 *   node scripts/fetch-awards.mjs             # all years
 *   node scripts/fetch-awards.mjs 2024 2023   # specific years
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, '..', 'data', 'awards.json');
const REGISTRY = path.join(here, '..', 'data', 'registry.json');

const YEARS = process.argv.slice(2).filter((a) => /^\d{4}$/.test(a));
const ALL_YEARS = ['2024', '2023', '2022', '2021', '2020', '2019', '2018', '2017', '2016', '2015', '2014'];

/** Full browser header set. A bare UA gets 403 from their WAF; this does not. */
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-CA,en-US;q=0.9,en;q=0.8',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Upgrade-Insecure-Requests': '1',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * CBA category name → our style tags.
 *
 * Ordered, first match wins, most specific first. A category may map to more
 * than one tag where the style genuinely spans them (barrel-aged sours are
 * both). Anything unmatched is REPORTED, never silently dropped — a category
 * we can't read is a gap in our taxonomy, which is exactly how the last three
 * tags got found.
 */
const CATEGORY_RULES = [
  [/non.?alcoholic|de.?alcohol|\b0\.5|alcohol.free/i, ['non-alcoholic']],
  [/kolsch|kölsch/i, ['kolsch']],
  [/barrel.?aged|wood.?aged|bourbon|whisky|whiskey/i, ['barrel-aged']],
  [/brett|wild|lambic|spontaneous|gueuze|mixed.?culture|mixed.?ferment/i, ['wild-ale']],
  [/sour|gose|berliner|kettle.?sour|fruit.?beer|fruited/i, ['sour']],
  [/saison|farmhouse|grisette|biere de garde|bière de garde/i, ['farmhouse-saison']],
  [/imperial stout|russian imperial|stout|porter|schwarzbier.*ale/i, ['stout-porter']],
  [/hazy|new england|juicy|northeast.?style ipa/i, ['hazy-ipa']],
  [/india pale ale|\bipa\b|india pale/i, ['west-coast-ipa']],
  [/black ale|cascadian dark/i, ['stout-porter']],
  [/belgo|belgian.?style ale/i, ['wheat-belgian']],
  // Cream ale sits between an ale and a lager and either call is arguable —
  // but classify-styles.mjs already files it under pale-ale, and two files
  // disagreeing about the same beer is worse than either answer. Matched
  // before the lager rule so it wins.
  [/pale ale|\bapa\b|bitter|blonde|golden ale|cream ale/i, ['pale-ale']],
  [/amber|red ale|irish red|altbier|\balt\b|brown ale|\bbrown\b|scotch ale|scottish/i, ['amber-red']],
  [/wheat|weizen|weiss|witbier|wit\b|belgian|dubbel|tripel|quad|abbey|trappist|blanche/i, ['wheat-belgian']],
  [/dark lager|schwarz|dunkel|black lager|bock|doppelbock|amber to dark/i, ['dark-lager']],
  [/pilsner|pils\b|lager|helles|kellerbier|zwickel|marzen|märzen|oktoberfest|festbier/i, ['pilsner-lager']],
  [/session|light beer|low alcohol|radler|shandy/i, ['session-low-alc']],
  // Deliberately unmapped, so they surface in the report rather than being
  // forced into a tag they don't belong to.
  [/cider|perry|mead|seltzer|cooler|spirit/i, []],
];

const MEDAL_WEIGHT = { gold: 1, silver: 0.6, bronze: 0.35 };

function tagsFor(category) {
  for (const [re, tags] of CATEGORY_RULES) if (re.test(category)) return tags;
  return null; // unmapped — reported
}

/** Newest, largest snapshot of a year's winners page — the largest is the one
 *  captured after results were actually published. */
async function bestSnapshot(year) {
  const url = `http://web.archive.org/cdx/search/cdx?url=canadianbrewingawards.com/${year}-winners/&output=json&fl=timestamp,length&filter=statuscode:200&limit=40`;
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(45_000) });
  if (!res.ok) throw new Error(`CDX HTTP ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length < 2) throw new Error('no snapshots');
  const best = rows.slice(1).sort((a, b) => Number(b[1]) - Number(a[1]))[0];
  return best[0];
}

/** Strip a page to ordered text lines, preserving cell boundaries. */
function toLines(htmlText) {
  let s = htmlText
    .replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(tr|p|div|li|h\d|td|th)>/gi, '\n')
    .replace(/<[^>]+>/g, '\n');
  // Decode entities properly. A blanket /&#?\w+;/ → ' ' turns "K&ouml;lsch"
  // into "K lsch", which silently dropped the entire Kölsch category.
  const NAMED = {
    nbsp: ' ', amp: '&', quot: '"', apos: "'", lsquo: '\u2018', rsquo: "'",
    ldquo: '"', rdquo: '"', ndash: '-', mdash: '—', hellip: '…',
    ouml: 'ö', auml: 'ä', uuml: 'ü', szlig: 'ß', eacute: 'é', egrave: 'è',
    Ouml: 'Ö', Auml: 'Ä', Uuml: 'Ü',
  };
  s = s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, code) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X'
        ? parseInt(code.slice(2), 16)
        : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : ' ';
    }
    return NAMED[code] ?? NAMED[code.toLowerCase()] ?? ' ';
  });
  return s
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

const MEDAL_RE = /^(gold|silver|bronze)$/i;

/**
 * The table renders as a flat run of cells: category, medal, beer, brewery,
 * province. Anchor on the MEDAL cell rather than assuming a fixed stride —
 * older years carry an extra column and a stride-5 walk silently shears the
 * whole table by one.
 */
function parseWinners(lines, year) {
  const out = [];
  for (let i = 1; i < lines.length - 2; i++) {
    if (!MEDAL_RE.test(lines[i])) continue;
    const category = lines[i - 1];
    const beer = lines[i + 1];
    const brewery = lines[i + 2];
    const province = lines[i + 3] ?? '';
    if (!category || !beer || !brewery) continue;
    if (category.length > 90 || brewery.length > 80) continue;
    if (MEDAL_RE.test(beer) || MEDAL_RE.test(brewery)) continue;
    out.push({
      year: Number(year),
      category: category.replace(/^\d+\s*[-–.]?\s*/, '').trim(),
      medal: lines[i].toLowerCase(),
      beer,
      brewery,
      province: province.trim(),
    });
  }
  return out;
}

async function main() {
  const years = YEARS.length ? YEARS : ALL_YEARS;
  const all = [];
  const unmapped = new Map();
  const perYear = {};

  for (const year of years) {
    process.stdout.write(`  ${year}  `);
    try {
      const ts = await bestSnapshot(year);
      const url = `https://web.archive.org/web/${ts}id_/https://canadianbrewingawards.com/${year}-winners/`;
      // The archive 429s and 503s under any sustained load, and a dropped
      // year looks exactly like "that year had no Ontario winners". Retry so
      // a transient failure never reads as an empty result.
      let body = null;
      for (let attempt = 1; attempt <= 4 && body === null; attempt++) {
        const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(60_000) });
        if (res.ok) {
          const text = await res.text();
          if (text.length > 5000) body = text;
        }
        if (body === null) await sleep(attempt * 4000);
      }
      if (body === null) throw new Error('archive unavailable after 4 tries');
      const rows = parseWinners(toLines(body), year);
      all.push(...rows);
      perYear[year] = rows.length;
      const on = rows.filter((r) => /ontario/i.test(r.province)).length;
      console.log(`${String(rows.length).padStart(4)} medals  (${on} Ontario)  snapshot ${ts}`);
    } catch (err) {
      perYear[year] = 0;
      console.log(`— ${String(err.message).slice(0, 60)}`);
    }
    await sleep(3000); // the archive rate-limits hard
  }

  /**
   * Ontario only — but resolved by matching the registry, not by reading the
   * province cell. The column moves between years (2018 parses 163 medals and
   * reports zero Ontario), and a brewery we can't resolve to a registry record
   * is useless to us anyway. Matching on identity answers both questions at
   * once and is what the downstream merge needs regardless.
   */
  const { breweries: registry } = JSON.parse(await readFile(REGISTRY, 'utf8'));
  const norm = (n) =>
    n.toLowerCase()
      .replace(/\b(brewing|brewery|breweries|brewers|brewhouse|beer|co|company|craft|ales?|inc|ltd|corp|the|and)\b/g, '')
      .replace(/[^a-z0-9]/g, '');
  const byName = new Map();
  for (const b of registry) {
    const k = norm(b.name);
    if (k.length >= 3 && !byName.has(k)) byName.set(k, b);
  }

  let unresolved = 0;
  const ontario = [];
  for (const r of all) {
    const k = norm(r.brewery);
    let hit = byName.get(k);
    if (!hit && k.length >= 5) {
      for (const [other, rec] of byName) {
        if (other.length >= 5 && (other.includes(k) || k.includes(other))) { hit = rec; break; }
      }
    }
    const saysOntario = /^(ontario|on)$/i.test((r.province || '').trim());
    if (hit) {
      r.breweryId = hit.id;
      r.registryName = hit.name;
      ontario.push(r);
    } else if (saysOntario) {
      // A real Ontario medal for a brewery we don't have a record for. Keep
      // it — it is a genuine coverage gap worth seeing, not a parse failure.
      r.breweryId = null;
      r.registryName = r.brewery;
      ontario.push(r);
      unresolved++;
    }
  }
  console.log(`\n${unresolved} Ontario medals name a brewery with no registry record (coverage gap).`);

  for (const r of ontario) {
    const tags = tagsFor(r.category);
    if (tags === null) unmapped.set(r.category, (unmapped.get(r.category) ?? 0) + 1);
    r.styles = tags ?? [];
  }

  // Roll medals up per brewery per style, decaying by age: a 2015 gold for a
  // beer they may not brew any more is real but not current.
  const byBrewery = {};
  const thisYear = new Date().getFullYear();
  for (const r of ontario) {
    if (!r.styles.length || !r.breweryId) continue;
    const rec = (byBrewery[r.breweryId] ??= {
      brewery: r.registryName,
      awardedAs: r.brewery,
      medals: [],
      styleScore: {},
    });
    rec.medals.push({ year: r.year, medal: r.medal, category: r.category, beer: r.beer, styles: r.styles });
    const age = Math.max(0, thisYear - r.year);
    const recency = Math.max(0.25, 1 - age * 0.08);
    for (const s of r.styles) {
      rec.styleScore[s] = Number(((rec.styleScore[s] ?? 0) + MEDAL_WEIGHT[r.medal] * recency).toFixed(3));
    }
  }

  await writeFile(
    OUT,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        source:
          'Canadian Brewing Awards official winners pages, via Internet Archive (site is mid-rebuild)',
        caveat:
          'Medals cover only breweries that entered. A medal is evidence FOR a style; absence is evidence of nothing.',
        years: perYear,
        totalMedals: all.length,
        ontarioMedals: ontario.length,
        unmappedCategories: Object.fromEntries([...unmapped].sort((a, b) => b[1] - a[1])),
        breweries: byBrewery,
      },
      null,
      2,
    ),
  );

  console.log(`\n${all.length} medals parsed, ${ontario.length} Ontario.`);
  console.log(`${Object.keys(byBrewery).length} Ontario breweries have at least one mapped medal.`);
  if (unmapped.size) {
    console.log(`\n${unmapped.size} categories did not map to a style tag:`);
    for (const [c, n] of [...unmapped].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
      console.log(`  ${String(n).padStart(3)}  ${c}`);
    }
  }
  console.log(`\nWrote ${path.relative(process.cwd(), OUT)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
