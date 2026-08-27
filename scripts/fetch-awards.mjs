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

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, '..', 'data', 'awards.json');
/**
 * Per-year raw-row cache. The Internet Archive throttles hard, and every
 * re-run used to refetch years that had already parsed cleanly — which is
 * both impolite and how a run dies half-done. A year with a cache file is
 * served from disk; delete the file to force a refetch. Untracked, like the
 * rest of data/harvest/.
 */
const CACHE = path.join(here, '..', 'data', 'harvest', 'awards-cache');
const REGISTRY = path.join(here, '..', 'data', 'registry.json');

const YEARS = process.argv.slice(2).filter((a) => /^\d{4}$/.test(a));
/**
 * --live-only: skip years that would need the Internet Archive (no cache, no
 * live ALT source). The archive throttles for hours at a stretch and the
 * output only writes when the loop COMPLETES — so a throttled tail year used
 * to hold the seven good years hostage. Write what is solid now; backfill
 * archive years when the throttle lifts (the cache keeps every success).
 */
const LIVE_ONLY = process.argv.includes('--live-only');
const ALL_YEARS = ['2025', '2024', '2023', '2022', '2021', '2020', '2019', '2018', '2017', '2016', '2015', '2014'];

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
  // 'Fruit Beer' deliberately NOT here: fruit is an adjunct, not a base —
  // Godspeed's Yuzu (a citrus SAISON) took Silver in Fruit Beer 2025 and the
  // old mapping promoted 'sour' from it. Ambiguous category → no tag.
  [/sour|gose|berliner|kettle.?sour|fruited sour/i, ['sour']],
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

/**
 * Snapshot CANDIDATES for a year, largest first.
 *
 * One URL shape is not enough: the winners pages moved between the bare host
 * and www, with and without a trailing slash, and 2017 also lived at
 * /2017-winner-list/. The old single-shape query returned "no snapshots" for
 * 2015-2017, 2019 and 2021, which surfaced as five years parsing ZERO medals
 * — invisible inside a healthy-looking 789 total until Great Lakes' 2014
 * sweep failed to appear. Query every shape, merge, and let the caller try
 * candidates until one parses.
 */
async function snapshotCandidates(year) {
  const shapes = [
    `canadianbrewingawards.com/${year}-winners/`,
    `www.canadianbrewingawards.com/${year}-winners/`,
    `canadianbrewingawards.com/${year}-winners`,
    `www.canadianbrewingawards.com/${year}-winners`,
    `www.canadianbrewingawards.com/${year}-winner-list/`,
  ];
  const seen = new Map();
  for (const shape of shapes) {
    const url = `http://web.archive.org/cdx/search/cdx?url=${shape}&output=json&fl=timestamp,length,original&filter=statuscode:200&limit=40`;
    try {
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(45_000) });
      if (!res.ok) continue;
      const rows = await res.json();
      if (!Array.isArray(rows)) continue;
      for (const [ts, len, original] of rows.slice(1)) {
        if (!seen.has(ts)) seen.set(ts, { ts, len: Number(len), original });
      }
    } catch { /* one shape failing must not sink the year */ }
    await sleep(500);
  }
  if (!seen.size) throw new Error('no snapshots in any URL shape');
  /*
   * NOT top-N by length globally: the rebuilt (Next.js) site's captures are
   * the LARGEST files and parse to zero — 2024's real table lost every length
   * contest to a JS shell. Take the two largest per distinct URL, so every
   * era of the site gets its shot, then order across shapes by length.
   */
  const byUrl = new Map();
  for (const c of [...seen.values()].sort((a, b) => b.len - a.len)) {
    const list = byUrl.get(c.original) ?? [];
    if (list.length < 2) { list.push(c); byUrl.set(c.original, list); }
  }
  return [...byUrl.values()].flat().sort((a, b) => b.len - a.len).slice(0, 8);
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
  const push = (out, category, medal, beer, brewery, province) => {
    if (!category || !beer || !brewery) return;
    if (category.length > 90 || brewery.length > 80) return;
    if (MEDAL_RE.test(beer) || MEDAL_RE.test(brewery)) return;
    out.push({
      year: Number(year),
      category: category.replace(/^\d+\s*[)\-–.]?\s*/, '').replace(/\s*\(\+\d+\)\s*$/, '').trim(),
      medal: medal.toLowerCase(),
      beer,
      brewery,
      province: (province ?? '').trim(),
    });
  };
  // Order A — the CBA site's own tables: category, MEDAL, beer, brewery, province.
  const a = [];
  for (let i = 1; i < lines.length - 2; i++) {
    if (!MEDAL_RE.test(lines[i])) continue;
    push(a, lines[i - 1], lines[i], lines[i + 1], lines[i + 2], lines[i + 3]);
  }
  // Order B — republished lists (American Craft Beer, 2025): MEDAL, category,
  // beer, brewery, province — the medal opens the block instead of closing it.
  const b = [];
  for (let i = 0; i < lines.length - 4; i++) {
    if (!MEDAL_RE.test(lines[i])) continue;
    push(b, lines[i + 1], lines[i], lines[i + 2], lines[i + 3], lines[i + 4]);
  }
  /*
   * Order C — the beer press's per-line format, used by beerinfo (2019, 2020)
   * and Matter of Beer (2021, 2022):
   *
   *   GOLD: Kinabik Pilsner | Snake Lake Brewing Company | Alberta
   *   Gold: Jagged Little Pilsner – Stray Dog Brewing Company – Ontario
   *
   * The separator must be SPACED (' | ' or ' – ') — bare dashes appear inside
   * beer names. The nearest preceding non-medal line is the category.
   */
  const c = [];
  {
    let category = '';
    for (const line of lines) {
      const m = line.match(/^(gold|silver|bronze)\s*:\s*(.+)$/i);
      if (!m) {
        if (line.length <= 90 && !/^(gold|silver|bronze)/i.test(line)) category = line;
        continue;
      }
      const parts = m[2].split(/\s+[|\u2013\u2014-]\s+/).map((x) => x.trim()).filter(Boolean);
      // Three parts on national lists (beer | brewery | province); TWO on
      // Ontario-only lists (Gold: Mile Hill – OutSpoken Brewing) — no
      // province column exists when every row is Ontario.
      if (parts.length >= 3) push(c, category, m[1], parts[0], parts[1], parts[parts.length - 1]);
      else if (parts.length === 2) push(c, category, m[1], parts[0], parts[1], '');
    }
  }

  /*
   * Same anchor, two readings — the wrong order shears every field by one and
   * produces PLAUSIBLE-LOOKING garbage (a beer name where the brewery goes, a
   * brewery where the province goes) that the length guards cannot catch. Row
   * count cannot pick the winner: both parses find every medal anchor. What
   * discriminates is the PROVINCE column — only the correctly-ordered parse
   * puts recognizable provinces there. 2025 parsed 130 rows with zero Ontario
   * before this check existed.
   */
  const PROV = /^(ontario|on|qu[ée]bec|qc|british columbia|bc|alberta|ab|manitoba|mb|saskatchewan|sk|nova scotia|ns|new brunswick|nb|newfoundland.*|nl|prince edward island|pei?|yukon|yt|northwest territories|nt|nunavut|nu)$/i;
  const provScore = (rows) =>
    rows.length ? rows.filter((r) => PROV.test(r.province.trim())).length / rows.length : 0;
  const scored = [a, b, c].map((rows) => ({ rows, score: provScore(rows) }));
  const best = scored.filter((x) => x.score >= 0.3).sort((x, y) => y.rows.length - x.rows.length)[0];
  if (best) return best.rows;
  return scored.sort((x, y) => y.rows.length - x.rows.length)[0].rows; // no province column anywhere
}

async function main() {
  const years = YEARS.length ? YEARS : ALL_YEARS;
  const all = [];
  const unmapped = new Map();
  const perYear = {};

  /**
   * 2025's official page is a Next.js shell in every archived capture — the
   * medals were client-fetched and never made it into the snapshot. American
   * Craft Beer republished the full list; that page is live, fetchable, and
   * parses under order B. Fewer rows than the official 183 (they trimmed some
   * categories) — recorded in the source note rather than papered over.
   */
  const ALT_SOURCE = {
    2025: 'https://www.americancraftbeer.com/the-2025-canadian-brewing-awards-winners/',
    2024: 'https://www.americancraftbeer.com/the-2024-canadian-brewing-awards-winners/',
    2023: 'https://www.americancraftbeer.com/the-2023-canadian-brewing-awards-winners/',
    2022: 'https://matterofbeer.com/2022/05/14/2022-canadian-brewing-awards-winners/',
    2021: 'https://matterofbeer.com/2021/09/20/2021-canadian-brewing-awards-winners/',
    2020: 'https://beerinfo.com/the-2020-canadian-brewing-awards/',
    2019: 'https://beerinfo.com/canadian_brewing_awards_2019/',
    2017: 'https://ontariobev.net/winners-announced-2017-canadian-brewing-awards/',
  };
  /**
   * Ontario Brewing Awards — the second juried competition, Ontario-only and
   * cheaper to enter, so it catches breweries that skip the national one.
   * The official .ca site is dead; beerinfo republishes per-year lists in the
   * same MEDAL:-prefixed format. Only these years exist there — the archive
   * can backfill the rest when its index endpoint recovers.
   */
  const OBA_SOURCES = [
    { year: 2024, url: 'https://beerinfo.com/2024-ontario-brewing-awards-medal-winners/' },
    { year: 2019, url: 'https://beerinfo.com/2019-ontario-brewing-awards-medal-winners/' },
    { year: 2018, url: 'https://beerinfo.com/2018-ontario-brewing-awards-medal-winners/' },
  ];

  await mkdir(CACHE, { recursive: true });
  for (const year of years) {
    process.stdout.write(`  ${year}  `);
    try {
      let rows = [];
      let how = '';
      try {
        const cached = JSON.parse(await readFile(path.join(CACHE, `${year}.json`), 'utf8'));
        if (Array.isArray(cached) && cached.length >= 20) { rows = cached; how = 'cache'; }
      } catch { /* no cache — fetch */ }
      if (rows.length < 20 && LIVE_ONLY && !ALT_SOURCE[year]) {
        perYear[year] = 0;
        console.log('— skipped (--live-only: archive-dependent)');
        await sleep(200);
        continue;
      }
      if (rows.length < 20 && ALT_SOURCE[year]) {
        const res = await fetch(ALT_SOURCE[year], { headers: HEADERS, signal: AbortSignal.timeout(60_000) });
        if (res.ok) {
          rows = parseWinners(toLines(await res.text()), year);
          how = 'americancraftbeer.com';
        }
      }
      if (rows.length < 20) {
        // Try archive candidates, largest first, until one actually parses.
        // A snapshot can be a redirect stub or a rebuilt-site shell; "fetched
        // fine, parsed zero" must try the next capture, not conclude the year
        // was empty.
        const candidates = await snapshotCandidates(year);
        let fetched = 0;
        for (const c of candidates) {
          let body = null;
          for (let attempt = 1; attempt <= 4 && body === null; attempt++) {
            // The fetch itself can THROW (undici 'fetch failed' on a reset
            // connection), not just return !ok — and an unguarded throw here
            // escaped the candidate loop and killed the whole year. A network
            // throw is just a failed attempt: back off and try again.
            try {
              const res = await fetch(`https://web.archive.org/web/${c.ts}id_/${c.original}`, {
                headers: HEADERS, signal: AbortSignal.timeout(60_000),
              });
              if (res.status === 429) {
                // The archive said SLOW DOWN. Believe it. 4s backoffs just
                // spend the attempt budget inside the same throttle window —
                // a 429 needs minutes, and it 429ed a whole run into
                // 'parse failures' before this branch existed.
                process.stdout.write('⏳');
                await sleep(120_000);
                continue;
              }
              if (res.ok) {
                const text = await res.text();
                if (text.length > 5000) { body = text; fetched++; }
              }
            } catch { /* network throw — treat as a failed attempt */ }
            if (body === null) await sleep(attempt * 5000);
          }
          if (body === null) continue;
          rows = parseWinners(toLines(body), year);
          how = `snapshot ${c.ts} (${new URL(c.original).host}${new URL(c.original).pathname})`;
          if (rows.length >= 20) break;
          await sleep(8000);
        }
        // Distinguish starvation from a real parse failure — they demand
        // opposite responses (wait vs fix the parser), and conflating them
        // cost an afternoon.
        if (rows.length < 20 && fetched === 0)
          throw new Error('archive throttled/unreachable — no candidate body retrieved');
      }
      if (rows.length < 20) throw new Error(`best parse was ${rows.length} rows across ${typeof fetched === 'number' ? fetched : '?'} fetched candidates`);
      if (how !== 'cache') await writeFile(path.join(CACHE, `${year}.json`), JSON.stringify(rows));
      for (const r of rows) r.competition ??= 'Canadian Brewing Awards';
      all.push(...rows);
      perYear[year] = rows.length;
      const on = rows.filter((r) => /ontario|^on$/i.test(r.province)).length;
      console.log(`${String(rows.length).padStart(4)} medals  (${on} say Ontario)  ${how}`);
    } catch (err) {
      perYear[year] = 0;
      console.log(`— ${String(err.message).slice(0, 70)}`);
    }
    await sleep(8000); // the archive rate-limits hard — be genuinely slow
  }

  for (const { year, url } of OBA_SOURCES) {
    process.stdout.write(`  OBA ${year}  `);
    try {
      let rows = [];
      try {
        const cached = JSON.parse(await readFile(path.join(CACHE, `oba-${year}.json`), 'utf8'));
        if (Array.isArray(cached) && cached.length >= 20) rows = cached;
      } catch { /* fetch */ }
      if (rows.length < 20) {
        const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(60_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        rows = parseWinners(toLines(await res.text()), year);
        // An Ontario-only competition has no province column; every row is Ontario.
        for (const r of rows) r.province ||= 'Ontario';
        if (rows.length >= 20) await writeFile(path.join(CACHE, `oba-${year}.json`), JSON.stringify(rows));
      }
      if (rows.length < 20) throw new Error(`parsed only ${rows.length}`);
      for (const r of rows) { r.competition = 'Ontario Brewing Awards'; r.province ||= 'Ontario'; }
      all.push(...rows);
      perYear[`OBA-${year}`] = rows.length;
      console.log(`${String(rows.length).padStart(4)} medals`);
    } catch (err) {
      perYear[`OBA-${year}`] = 0;
      console.log(`— ${String(err.message).slice(0, 60)}`);
    }
    await sleep(2000);
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
  const collisions = [];
  for (const b of registry) {
    const k = norm(b.name);
    if (k.length < 3) continue;
    if (byName.has(k)) collisions.push(`${byName.get(k).id} <> ${b.id} (both '${k}')`);
    else byName.set(k, b);
  }
  if (collisions.length)
    console.log(`  name collisions (first record wins — check these): ${collisions.join('; ')}`);

  let unresolved = 0;
  const ontario = [];
  for (const r of all) {
    const k = norm(r.brewery);
    let hit = byName.get(k);
    if (!hit && k.length >= 5) {
      // Substring fallback, guarded: the shorter key must be most of the
      // longer one, or 'greatlakes' happily swallows 'lakes' and every
      // 'brewing' fragment finds a home it should not have.
      for (const [other, rec] of byName) {
        if (other.length < 5) continue;
        const [shorter, longer] = other.length < k.length ? [other, k] : [k, other];
        if (longer.includes(shorter) && shorter.length / longer.length >= 0.6) { hit = rec; break; }
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
    rec.medals.push({ year: r.year, medal: r.medal, category: r.category, beer: r.beer, styles: r.styles, competition: r.competition });
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
