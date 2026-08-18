/**
 * Reddit threads → reputation evidence for `knownFor`.
 *
 * THE COUNTING RULE, which is the whole design:
 *
 *   Score a (brewery, style) pair by the number of DISTINCT AUTHORS who named
 *   that brewery for that style, across DISTINCT THREADS. Never by mentions.
 *
 * Raw mention counts measure three things that aren't reputation: how large a
 * thread was, how populous a city is, and how talkative one person feels. One
 * enthusiast posting six times about their local, or a brewery astroturfing
 * its own name, beats a genuine ten-person consensus under naive counting.
 * Requiring distinct authors kills the first two; requiring distinct threads
 * stops a single viral post from constituting a reputation on its own.
 *
 * WHAT COUNTS AS "FOR THAT STYLE". A style word must appear in the same
 * comment, near the brewery name. A comment that says "Bellwoods is great"
 * is evidence of esteem but names no style, and `knownFor` is a claim about
 * styles — so it's recorded as `unstyled` and used for nothing yet.
 *
 * SELF-PROMOTION. A comment naming exactly one brewery in glowing terms from
 * an author who never appears anywhere else is the astroturf signature. Such
 * authors are counted once and flagged, never excluded outright — a genuine
 * first-time poster looks identical, and silently dropping real opinions is
 * its own bias.
 *
 *   node scripts/classify-reputation.mjs
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMatcher, findMentions } from '../lib/brewery-match.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(here, '..', 'data');
const THREADS = path.join(DATA, 'reddit-threads.json');
const REGISTRY = path.join(DATA, 'registry.json');
const OUT = path.join(DATA, 'reputation.json');

/**
 * Style words → tags. Shares its shape with classify-styles.mjs but is
 * deliberately tighter: catalog text is written by the brewery and is precise,
 * whereas a Reddit comment says "lager" when it means any of six things. Only
 * unambiguous words earn a tag.
 */
const STYLE_WORDS = [
  ['non-alcoholic', /\b(non.?alc(oholic)?|\bNA beer\b|alcohol.?free|de.?alcoholi[sz]ed)\b/i],
  ['hazy-ipa', /\b(hazy|neipa|new england ipa|juicy ipa)\b/i],
  ['west-coast-ipa', /\b(west coast ipa|wcipa|clear ipa)\b/i],
  ['kolsch', /\b(k[oö]lsch|kolsh)\b/i],
  ['barrel-aged', /\b(barrel.?aged|bourbon barrel|whisky barrel|\bBA\b stout)\b/i],
  ['wild-ale', /\b(wild ale|brett|lambic|mixed ferment|spontaneous|foeder)\b/i],
  ['sour', /\b(sour(s|ed)?|gose|berliner|kettle sour|fruited)\b/i],
  ['farmhouse-saison', /\b(saison|farmhouse|grisette)\b/i],
  ['stout-porter', /\b(stout|porter)\b/i],
  ['dark-lager', /\b(dark lager|schwarzbier|dunkel|black lager|bock)\b/i],
  ['amber-red', /\b(amber ale|red ale|irish red|altbier)\b/i],
  ['wheat-belgian', /\b(witbier|hefeweizen|weizen|belgian|dubbel|tripel|wheat beer)\b/i],
  ['session-low-alc', /\b(session|low.?abv|radler|shandy|table beer)\b/i],
  ['pale-ale', /\b(pale ale|\bAPA\b|cream ale|blonde ale|golden ale)\b/i],
  ['pilsner-lager', /\b(pilsner|pils\b|lager|helles|kellerbier|czech)\b/i],
  ['hazy-ipa', /\bipa\b/i], // bare IPA falls to hazy — the dominant Ontario read
];

/** Words that make a mention a RECOMMENDATION rather than a passing reference. */
const POSITIVE =
  /\b(best|favourite|favorite|love|amazing|excellent|incredible|fantastic|top|go.?to|underrated|killer|nails? it|does .{0,12} well|can'?t beat|second to none|world.?class)\b/i;

/** Words that invert it. "Their lager is terrible" must never read as praise. */
const NEGATIVE =
  /\b(worst|awful|terrible|disappointing|overrated|avoid|meh|bland|skip it|not great|used to be|gone downhill|don'?t bother)\b/i;

function stylesIn(text) {
  const found = [];
  for (const [tag, re] of STYLE_WORDS) {
    if (re.test(text) && !found.includes(tag)) found.push(tag);
  }
  return found;
}

/**
 * Narrow the text to the neighbourhood of the brewery name before reading
 * styles off it. A long comment listing six breweries and four styles would
 * otherwise attribute every style to every brewery.
 */
function windowAround(text, name, radius = 160) {
  const i = text.toLowerCase().indexOf(name.toLowerCase().split(' ')[0]);
  if (i < 0) return text.slice(0, radius * 2);
  return text.slice(Math.max(0, i - radius), i + radius);
}

async function main() {
  if (!existsSync(THREADS)) {
    console.error(
      `\nNo ${path.relative(process.cwd(), THREADS)} yet.\n` +
        `Run scripts/fetch-reddit.mjs first — it needs REDDIT_CLIENT_ID and\n` +
        `REDDIT_CLIENT_SECRET (see that file's header for the 2-minute setup).\n`,
    );
    process.exit(1);
  }

  const { threads } = JSON.parse(await readFile(THREADS, 'utf8'));
  const { breweries } = JSON.parse(await readFile(REGISTRY, 'utf8'));
  const active = breweries.filter((b) => b.isBrewery !== false && b.status !== 'closed');
  const matcher = buildMatcher(active);

  // (breweryId, style) -> { authors:Set, threads:Set, quotes:[] }
  const pairs = new Map();
  const unstyled = new Map();
  const authorBreweries = new Map(); // for the self-promotion signature
  let commentsRead = 0;
  let mentionsFound = 0;

  for (const thread of Object.values(threads)) {
    const threadId = thread.id;

    // The post body counts as one contribution from its author, same as a
    // comment — the question itself often names breweries.
    const units = [
      { author: thread.author, body: `${thread.title}\n${thread.selftext ?? ''}`, id: `post_${threadId}` },
      ...(thread.comments ?? []).map((c) => ({ author: c.author, body: c.body, id: c.id, score: c.score })),
    ];

    for (const unit of units) {
      if (!unit.body || !unit.author || unit.author === '[deleted]') continue;
      commentsRead++;

      const mentions = findMentions(unit.body, matcher);
      if (!mentions.length) continue;
      mentionsFound += mentions.length;

      for (const m of mentions) {
        const near = windowAround(unit.body, m.name);
        if (NEGATIVE.test(near) && !POSITIVE.test(near)) continue; // criticism isn't reputation

        const set = authorBreweries.get(unit.author) ?? new Set();
        set.add(m.id);
        authorBreweries.set(unit.author, set);

        const styles = stylesIn(near);
        if (!styles.length) {
          const u = unstyled.get(m.id) ?? { authors: new Set(), threads: new Set() };
          u.authors.add(unit.author);
          u.threads.add(threadId);
          unstyled.set(m.id, u);
          continue;
        }

        for (const style of styles) {
          const key = `${m.id}|${style}`;
          const rec = pairs.get(key) ?? {
            breweryId: m.id,
            name: m.name,
            style,
            authors: new Set(),
            threads: new Set(),
            quotes: [],
            confidentMentions: 0,
          };
          rec.authors.add(unit.author);
          rec.threads.add(threadId);
          if (m.confident) rec.confidentMentions++;
          if (rec.quotes.length < 3) {
            rec.quotes.push({
              text: near.replace(/\s+/g, ' ').trim().slice(0, 200),
              author: unit.author,
              thread: `https://reddit.com${thread.permalink ?? ''}`,
              score: unit.score ?? null,
            });
          }
          pairs.set(key, rec);
        }
      }
    }
  }

  // Authors who ever named exactly one brewery, once — the astroturf shape.
  const singleBrewery = new Set(
    [...authorBreweries.entries()].filter(([, set]) => set.size === 1).map(([a]) => a),
  );

  const out = {};
  for (const rec of pairs.values()) {
    const authors = [...rec.authors];
    const independent = authors.filter((a) => !singleBrewery.has(a));
    const entry = {
      style: rec.style,
      distinctAuthors: authors.length,
      distinctThreads: rec.threads.size,
      independentAuthors: independent.length,
      singleBreweryAuthors: authors.length - independent.length,
      confidentMentions: rec.confidentMentions,
      quotes: rec.quotes,
    };
    (out[rec.breweryId] ??= { name: rec.name, styles: [], unstyledMentions: 0 }).styles.push(entry);
  }

  for (const [id, u] of unstyled) {
    const rec = (out[id] ??= { name: id, styles: [], unstyledMentions: 0 });
    rec.unstyledMentions = u.authors.size;
  }

  for (const rec of Object.values(out)) {
    rec.styles.sort((a, b) => b.distinctAuthors - a.distinctAuthors || b.distinctThreads - a.distinctThreads);
  }

  await writeFile(
    OUT,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        source: 'Reddit, public posts and comments via the official API',
        rule: 'Scored by DISTINCT AUTHORS across DISTINCT THREADS, never by raw mention count.',
        caveat:
          'Reddit skews Toronto and skews recent. Absence of mentions is not evidence against a brewery — it is likelier evidence that nobody posted about that region.',
        threadsRead: Object.keys(threads).length,
        commentsRead,
        mentionsFound,
        breweries: out,
      },
      null,
      2,
    ),
  );

  const ranked = Object.entries(out)
    .flatMap(([id, r]) => r.styles.map((s) => ({ id, name: r.name, ...s })))
    .sort((a, b) => b.distinctAuthors - a.distinctAuthors);

  console.log(`Read ${commentsRead} comments across ${Object.keys(threads).length} threads.`);
  console.log(`${mentionsFound} brewery mentions, ${Object.keys(out).length} breweries named.\n`);
  console.log('Strongest (brewery, style) pairs by distinct authors:');
  for (const r of ranked.slice(0, 20)) {
    console.log(
      `  ${String(r.distinctAuthors).padStart(3)} authors / ${String(r.distinctThreads).padStart(2)} threads  ` +
        `${r.name.slice(0, 26).padEnd(28)} ${r.style}`,
    );
  }
  console.log(`\nWrote ${path.relative(process.cwd(), OUT)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
