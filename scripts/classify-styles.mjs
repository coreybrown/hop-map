/**
 * Stage 2 of style enrichment: turn crawled catalog text into ordered
 * style specializations.
 *
 * Two things matter more than raw accuracy here:
 *
 *  1. ORDER. "Makes an IPA" is nearly true of every brewery and carries no
 *     signal. "Known above all for lagers" is the whole product. The ranking
 *     engine weights the first style most heavily, so the ordering is the
 *     output that counts.
 *
 *  2. HONESTY. Every result carries a confidence and the evidence it came
 *     from. A brewery we couldn't read stays unclassified rather than being
 *     quietly guessed at — a confidently wrong recommendation is worse than
 *     an absent one, because it costs someone a real detour.
 *
 * Runs without an API key using frequency analysis over the catalog text.
 * With ANTHROPIC_API_KEY set, it additionally asks a model to judge the
 * ambiguous cases, which is where the counting approach is weakest.
 *
 *   node scripts/classify-styles.mjs
 *   node scripts/classify-styles.mjs --llm     # use the model for close calls
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(here, '..', 'data');
const CATALOGS = path.join(DATA_DIR, 'catalogs.json');
const STORE_CATALOGS = path.join(DATA_DIR, 'store-catalogs.json');
const RENDERED = path.join(DATA_DIR, 'rendered-catalogs.json');
const OUT = path.join(DATA_DIR, 'styles.json');

const useLlm = process.argv.includes('--llm');

/**
 * Three crawls feed this stage, and they are not equally trustworthy.
 *
 *   store-api  — the store's own product JSON. Discrete beers, each with a
 *                title, a product_type and a description. Nothing is inferred.
 *   catalog    — the earlier Shopify/HTML crawl. Also discrete beers.
 *   page-text  — headless render of a page, kept as one blob. A style has to
 *                be counted out of prose, which is where the wrong answers
 *                come from: Left Field's news page read as a beer list.
 *
 * Best source per brewery wins outright rather than being blended, so a weak
 * page-text read can never dilute a clean product list. Anything not listed
 * here has no catalog and stays unclassified.
 */
const SOURCE_RANK = { 'store-api': 3, catalog: 2, 'page-text': 1 };

/** Things a brewery's store sells that are not beer. */
const NOT_BEER =
  /\b(glass(ware)?|t.?shirt|hoodie|tee\b|hat\b|toque|cap\b|merch|sticker|poster|print\b|gift card|keg deposit|deposit\b|rental|coffee|hot sauce|opener|coaster|tote|apparel|artwork|ticket|event|donation|growler$|crowler$)\b/i;

const NOT_BEER_TYPE = /\b(apparel|goods|merch|food|artwork|glassware|gift|ticket|event|clothing)\b/i;

/** Store products → the {name,type,description} shape the scorer expects. */
function productsToBeers(products) {
  return products
    .filter((p) => p.title && !NOT_BEER.test(p.title) && !NOT_BEER_TYPE.test(p.type ?? ''))
    .map((p) => ({
      name: p.title,
      // Tags and variants carry style words the title often omits.
      type: [p.type, ...(p.tags ?? []), ...(p.variants ?? [])].filter(Boolean).join(' '),
      description: p.description ?? '',
    }));
}

/**
 * Merge every crawl into one keyed set, keeping the strongest source per
 * brewery and recording which sources existed so a thin result can be
 * traced back to a thin crawl rather than looking like a real negative.
 */
async function loadCatalogs() {
  const merged = {};
  const seenSources = {};

  /**
   * How much evidence an entry actually carries, used to break ties WITHIN a
   * rank. Two crawls can both return page text and not be remotely equal:
   * Halo's /beer page is 225 characters of bare beer names, where the only
   * style word is "Affogato Stout" — it classified them as a stout house.
   * Their /now-pouring page is 2400 characters that name the hazy IPA and the
   * pale ale. Same rank, twenty times the evidence.
   *
   * Without this, the winner was whichever file happened to load first.
   */
  const strength = (entry) =>
    entry.beers?.length ?? Object.values(score(entry.text ?? '')).reduce((a, b) => a + b, 0);

  const offer = (id, entry) => {
    (seenSources[id] ??= []).push(entry.method);
    const current = merged[id];
    if (!current) {
      merged[id] = entry;
      return;
    }
    const better =
      SOURCE_RANK[entry.method] - SOURCE_RANK[current.method] ||
      strength(entry) - strength(current);
    if (better > 0) merged[id] = entry;
  };

  if (existsSync(STORE_CATALOGS)) {
    const { stores } = JSON.parse(await readFile(STORE_CATALOGS, 'utf8'));
    for (const [id, store] of Object.entries(stores)) {
      const beers = productsToBeers(store.products ?? []);
      if (!beers.length) continue;
      offer(id, {
        name: store.name,
        method: 'store-api',
        platform: store.platform,
        source: store.endpoint,
        beers,
      });
    }
  }

  if (existsSync(CATALOGS)) {
    const { catalogs } = JSON.parse(await readFile(CATALOGS, 'utf8'));
    for (const [id, entry] of Object.entries(catalogs)) {
      if (!entry.beers?.length && !entry.text) continue;
      offer(id, {
        name: entry.name,
        method: entry.beers?.length ? 'catalog' : 'page-text',
        source: entry.source,
        beers: entry.beers,
        text: entry.text,
      });
    }
  }

  if (existsSync(RENDERED)) {
    const { catalogs } = JSON.parse(await readFile(RENDERED, 'utf8'));
    for (const [id, entry] of Object.entries(catalogs)) {
      if (!entry.text) continue;
      offer(id, {
        name: entry.name,
        method: 'page-text',
        source: entry.source,
        text: entry.text,
        density: entry.density,
      });
    }
  }

  return { merged, seenSources };
}

/**
 * Weighted patterns per style. Weights reflect how much a mention tells you:
 * a beer literally named "Czech Pilsner" is strong evidence; the word "hoppy"
 * in marketing copy is weak.
 */
const PATTERNS = {
  'hazy-ipa': [
    [/\b(hazy|neipa|new england ipa|juicy ipa)\b/gi, 3],
    [/\b(double dry.?hopped|ddh)\b/gi, 2],
    [/\bipa\b/gi, 1],
  ],
  'west-coast-ipa': [
    [/\bwest coast ipa\b/gi, 4],
    [/\b(dank|resinous|piney)\b/gi, 1],
  ],
  'pale-ale': [
    [/\b(pale ale|apa\b|extra pale)\b/gi, 3],
    [/\b(cream ale|blonde ale|golden ale)\b/gi, 2],
  ],
  // Split out of pale-ale: an expert named kölsch separately for two
  // different breweries, so folding it in was discarding real signal.
  kolsch: [[/\b(kölsch|kolsch|kolsh|köln|cologne.style)\b/gi, 4]],
  'amber-red': [
    [/\b(amber ale|red ale|irish red|amber lager|altbier|alt\b|rye ale)\b/gi, 3],
    [/\b(amber|ruby)\b/gi, 1],
  ],
  /**
   * Must out-weight session-low-alc, which also matches "non-alcoholic" —
   * whichever scores higher wins the beer's single vote, and an NA beer
   * belongs to NA. Bellwoods' NA Jelly King is a headline product.
   */
  'non-alcoholic': [
    [/\b(non.?alcoholic|non.?alc\b|alcohol.?free|de.?alcoholi[sz]ed|0\.0\s?%|0\.5\s?%|\bNA\s+(beer|ipa|lager|stout|pale))\b/g, 5],
  ],
  'pilsner-lager': [
    [/\b(pilsner|pilsener|pils\b|czech lager|helles|kellerbier|ležák|festbier|märzen|marzen)\b/gi, 3],
    [/\b(lager|vienna lager|italian pilsner)\b/gi, 2],
  ],
  'dark-lager': [
    [/\b(dark lager|schwarzbier|dunkel|black lager|tmavý|tmavy|baltic porter)\b/gi, 4],
  ],
  'stout-porter': [
    [/\b(imperial stout|russian imperial|pastry stout|milk stout|oatmeal stout)\b/gi, 3],
    [/\b(stout|porter)\b/gi, 2],
  ],
  sour: [
    [/\b(kettle sour|fruited sour|gose|berliner weisse|smoothie sour|catharina)\b/gi, 3],
    [/\bsour\b/gi, 2],
  ],
  'wild-ale': [
    [/\b(mixed fermentation|mixed.?ferment|spontaneous|coolship|foeder|brett\b|brettanomyces|lambic|wild ale)\b/gi, 4],
    [/\b(barrel.?fermented|blended)\b/gi, 1],
  ],
  'farmhouse-saison': [[/\b(saison|farmhouse|grisette|bière de garde)\b/gi, 3]],
  'wheat-belgian': [
    [/\b(witbier|hefeweizen|weizen|weissbier|dubbel|tripel|quadrupel|belgian (strong|blonde|golden|pale))\b/gi, 3],
    [/\b(wheat ale|blanche)\b/gi, 2],
  ],
  'barrel-aged': [
    [/\b(barrel.?aged|bourbon barrel|whisk(e)?y barrel|rye barrel|ba\s|imperial.*barrel)\b/gi, 3],
  ],
  // "non-alcoholic" deliberately dropped from here — it has its own tag now
  // and would otherwise split the vote with it.
  'session-low-alc': [
    [/\b(session|low.?abv|light lager|radler|shandy|table beer)\b/gi, 2],
  ],
};

/**
 * Taste axes, derived from what the classified beers actually are.
 *
 * Not a judgement we add on top — it is a restatement of `offers`, so it
 * carries the same evidence. A brewery with no classified beer gets no axis
 * value rather than a default, because 0.5 would read as "middling" when the
 * truth is "unknown".
 *
 * ONLY `easyDrinking` is emitted. It validates against the test set and it is
 * structurally a property of style: a helles is easier drinking than a
 * barrel-aged wild ale, and that is true by definition rather than by
 * reputation.
 *
 * `experimental` is NOT emitted, and the weights below are kept only so the
 * reason is legible. The expert calls Halo experimental; their style mix is
 * hazy IPA, pale ale, stout, pilsner and sour — indistinguishable from a
 * hundred ordinary breweries. What makes them experimental is what they do
 * INSIDE those styles ("Wild Construct: Primer", "Apeiron", "Event Horizon"),
 * which style composition cannot see. Fitting the weights until Halo scored
 * high would be tuning to a single example and would tell us nothing.
 *
 * It needs a reputation source, so it waits for one.
 */
const EMITTED_AXES = ['easyDrinking'];
const AXIS_WEIGHTS = {
  easyDrinking: {
    'session-low-alc': 1, 'non-alcoholic': 1, 'pilsner-lager': 0.9, kolsch: 0.9,
    'pale-ale': 0.7, 'amber-red': 0.6, 'wheat-belgian': 0.6, 'dark-lager': 0.5,
    'hazy-ipa': 0.4, 'farmhouse-saison': 0.35, 'stout-porter': 0.3,
    'west-coast-ipa': 0.25, sour: 0.2, 'barrel-aged': 0.1, 'wild-ale': 0.05,
  },
  experimental: {
    'wild-ale': 1, 'barrel-aged': 0.9, sour: 0.7, 'farmhouse-saison': 0.6,
    'hazy-ipa': 0.4, 'non-alcoholic': 0.4, 'wheat-belgian': 0.3,
    'stout-porter': 0.3, 'west-coast-ipa': 0.25, 'amber-red': 0.2,
    'dark-lager': 0.2, 'pale-ale': 0.2, kolsch: 0.1, 'pilsner-lager': 0.1,
    'session-low-alc': 0.1,
  },
};

/** Weighted by how much of the range each style accounts for, not a flat mean. */
function axesFor(counts) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total === 0) return undefined;

  const out = {};
  for (const [axis, weights] of Object.entries(AXIS_WEIGHTS)) {
    if (!EMITTED_AXES.includes(axis)) continue;
    let sum = 0;
    let seen = 0;
    for (const [style, n] of Object.entries(counts)) {
      if (weights[style] === undefined) continue;
      sum += weights[style] * n;
      seen += n;
    }
    if (seen > 0) out[axis] = Number((sum / seen).toFixed(2));
  }
  return Object.keys(out).length ? out : undefined;
}

/** Weighted evidence for each style in a blob of text. */
function score(text) {
  const scores = {};
  for (const [style, rules] of Object.entries(PATTERNS)) {
    let total = 0;
    for (const [re, weight] of rules) {
      const hits = text.match(re);
      if (hits) total += hits.length * weight;
    }
    if (total > 0) scores[style] = total;
  }
  return scores;
}

/**
 * Classify each beer individually, then count BEERS per style.
 *
 * Counting word mentions across a whole catalog measures verbosity, not
 * specialization: three barrel-aged specials with florid tasting notes will
 * out-mention fifteen IPAs listed as bare names. "How many of their beers
 * are hazy IPAs" is the question that actually matters, so where we have
 * discrete products, that's the unit we count.
 */
function scoreByBeer(beers) {
  const counts = {};
  let classified = 0;

  for (const beer of beers) {
    const text = `${beer.name} ${beer.type ?? ''} ${beer.description ?? ''}`;
    const beerScores = score(text);
    const ranked = Object.entries(beerScores).sort((a, b) => b[1] - a[1]);
    if (!ranked.length) continue;

    classified++;
    // Each beer votes once for its best match, and at most half a vote for a
    // clear secondary — so no single verbose listing can dominate.
    counts[ranked[0][0]] = (counts[ranked[0][0]] ?? 0) + 1;
    if (ranked[1] && ranked[1][1] >= ranked[0][1] * 0.6) {
      counts[ranked[1][0]] = (counts[ranked[1][0]] ?? 0) + 0.5;
    }
  }

  return { counts, classified };
}

function catalogText(entry) {
  if (entry.beers?.length) {
    return entry.beers
      .map((b) => `${b.name} ${b.type ?? ''} ${b.description ?? ''}`)
      .join('\n');
  }
  return entry.text ?? '';
}

/**
 * Specialist or generalist?
 *
 * Not every brewery has a headline style, and pretending otherwise is
 * actively misleading. Left Field is known for Greenwood (an IPA) *and*
 * Bluebird (an easy-drinking lager) *and* barrel-aged *and* sours. Ranking
 * any one of those first misrepresents them. Bellwoods is hazies and stouts
 * and Jelly King, all genuinely well regarded.
 *
 * So we read the SHAPE of the distribution, not just its order:
 *
 *   specialist — one style carries most of the range. Godspeed's lagers.
 *                Safe to say "known above all for X".
 *   broad      — several styles carried more or less evenly. Say so, and
 *                do not imply a headline. Breadth is a quality in itself,
 *                and it's exactly what a mixed group wants.
 */
function profileFor(ranked) {
  const total = ranked.reduce((sum, [, v]) => sum + v, 0);
  if (total === 0 || !ranked.length) return { profile: 'unknown', topShare: 0 };

  const topShare = ranked[0][1] / total;
  // Effective number of styles — a flat spread over four styles scores ~4,
  // a range dominated by one scores near 1.
  const effective =
    1 / ranked.reduce((sum, [, v]) => sum + (v / total) ** 2, 0);

  const specialist = topShare >= 0.45 && effective <= 2.6;
  return { profile: specialist ? 'specialist' : 'broad', topShare };
}

/**
 * Confidence reflects both the source and how decisive the evidence was.
 * A structured product list beats scraped page text; a clear winner beats
 * a three-way tie.
 */
function confidenceFor(entry, ranked, total) {
  if (!ranked.length || total === 0) return 'none';
  const share = ranked[0][1] / total;
  const structured = entry.method === 'store-api' || entry.method === 'catalog';

  if (structured && ranked[0][1] >= 6 && share >= 0.3) return 'high';
  if (structured || (ranked[0][1] >= 8 && share >= 0.35)) return 'medium';
  if (ranked[0][1] >= 4) return 'low';
  return 'none';
}

async function askModel(entry, ranked) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;

  const text = catalogText(entry).slice(0, 4000);
  const prompt = `Here is the beer catalog text for an Ontario brewery called "${entry.name}".

Identify what this brewery is KNOWN FOR — its specializations — not merely everything it brews. Almost every brewery makes an IPA; that is not a specialization. Order matters: the first style should be what a knowledgeable local would name first.

Choose only from these tags:
hazy-ipa, west-coast-ipa, pale-ale, pilsner-lager, dark-lager, stout-porter, sour, wild-ale, farmhouse-saison, wheat-belgian, barrel-aged, session-low-alc, non-alcoholic, kolsch, amber-red

Reply with JSON only: {"styles": ["tag", ...], "confidence": "high"|"medium"|"low", "note": "one short sentence a beer enthusiast would find useful, or null"}
Return at most 4 styles. If the text does not actually describe this brewery's beer, return {"styles": [], "confidence": "none", "note": null}.

CATALOG TEXT:
${text}`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-5',
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.stop_reason === 'refusal') return null;

    const block = data.content?.find((b) => b.type === 'text');
    if (!block) return null;
    const parsed = JSON.parse(block.text.replace(/^```json\s*|\s*```$/g, '').trim());
    return Array.isArray(parsed.styles) ? parsed : null;
  } catch {
    return null;
  }
}

async function main() {
  const { merged: catalogs, seenSources } = await loadCatalogs();
  const ids = Object.keys(catalogs);

  const out = {};
  const tally = { high: 0, medium: 0, low: 0, none: 0, llm: 0 };
  const bySource = {};

  for (const id of ids) {
    const entry = catalogs[id];
    bySource[entry.method] = (bySource[entry.method] ?? 0) + 1;
    const text = catalogText(entry);

    // Per-beer voting where we have discrete products; mention-counting only
    // as a fallback for scraped page text where beers can't be separated.
    const perBeer = entry.beers?.length ? scoreByBeer(entry.beers) : null;
    const scores = perBeer && perBeer.classified >= 3 ? perBeer.counts : score(text);

    const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    const total = ranked.reduce((sum, [, v]) => sum + v, 0);

    const { profile, topShare } = profileFor(ranked);

    // How aggressively we trim depends on which kind of brewery this is.
    // A specialist's long tail is noise. A generalist's long tail IS the
    // point — trimming it to a headline would misrepresent them.
    const cutoff = profile === 'specialist' ? 0.25 : 0.12;
    const keep = profile === 'specialist' ? 3 : 5;
    const meaningful = ranked.filter(
      ([, v]) => v >= Math.max(1, (ranked[0]?.[1] ?? 0) * cutoff),
    );

    let styles = meaningful.slice(0, keep).map(([s]) => s);
    let confidence = confidenceFor(entry, ranked, total);
    let note = null;
    let method = entry.method;

    // Ask the model only where counting is weak — that's where it pays.
    if (useLlm && (confidence === 'low' || confidence === 'none') && text.length > 200) {
      const judged = await askModel(entry, ranked);
      if (judged?.styles.length) {
        styles = judged.styles.slice(0, 4);
        confidence = judged.confidence ?? 'low';
        note = judged.note ?? null;
        method = 'model';
        tally.llm++;
      }
    }

    if (!styles.length) confidence = 'none';
    tally[confidence] = (tally[confidence] ?? 0) + 1;

    out[id] = {
      styles,
      axes: axesFor(scores),
      profile: styles.length ? profile : 'unknown',
      topShare: Number(topShare.toFixed(2)),
      confidence,
      note,
      method,
      platform: entry.platform ?? null,
      evidence: entry.source,
      beerCount: entry.beers?.length ?? null,
      // Which crawls reached this brewery at all. A `none` next to a single
      // page-text source is a crawl problem; a `none` next to a store-api
      // source is a genuine "their catalog doesn't say".
      sourcesAvailable: seenSources[id],
      classifiedAt: new Date().toISOString(),
    };
  }

  await writeFile(
    OUT,
    JSON.stringify(
      { generatedAt: new Date().toISOString(), count: ids.length, styles: out },
      null,
      2,
    ),
  );

  console.log(`Classified ${ids.length} breweries from crawled catalogs:`);
  console.log('  by strongest source:', bySource);
  console.log(`  high   ${tally.high}   (structured product list, decisive)`);
  console.log(`  medium ${tally.medium}`);
  console.log(`  low    ${tally.low}    (usable, flag in UI)`);
  console.log(`  none   ${tally.none}   (left unclassified rather than guessed)`);
  if (useLlm) console.log(`  ${tally.llm} resolved by the model`);
  console.log(`\nWrote ${path.relative(process.cwd(), OUT)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
