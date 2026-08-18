/**
 * Find brewery mentions in free conversational text.
 *
 * This is the risky half of the Reddit pass, so it lives on its own and is
 * tested on its own. Reputation evidence is only as good as the matching: a
 * false positive here writes a `knownFor` claim onto the wrong brewery, and
 * `knownFor` is the one field that can send someone on a wasted drive.
 *
 * The hard cases are breweries named after ordinary English words. Nine of
 * Ontario's 246 are: Bench, Halo, Left Field, Third Moon, Common Good, High
 * Park, Old Dog, Black Gold, Market. "I sat on the bench outside" and "that
 * came out of left field" must not become brewery mentions.
 *
 * The rule: a name made only of common words needs CORROBORATION — either the
 * brewing suffix is present ("Left Field Brewery"), or a beer word sits close
 * by. Distinctive names (Bellwoods, Rorschach, Godspeed) match on their own.
 */

/** Words that carry no identifying power on their own. */
const COMMON = new Set(
  ('the a an and or but for of in on at to from with by is it be as new old good bad big small ' +
    'great little young long short high low right left field bench batch stone halo common born ' +
    'free wild grand union station north south east west king queen river lake bay hill park side ' +
    'line road street market house home farm barn mill forge anchor crown royal red blue black ' +
    'white green gold silver iron steel bell moon sun star sky cloud storm rain snow fire water ' +
    'earth wood tree oak pine birch fox bear wolf dog cat bird crow raven eagle hawk lion horse ' +
    'deer moose elk goose duck swan fish trout bass pike perch third second first last next best ' +
    'top well spring summer fall winter dark light heavy full half double single').split(' '),
);

/** Suffixes that, when attached, make even a common-word name unambiguous. */
const SUFFIX =
  /\b(brew(ing|ery|eries|ers|house|pub)?|beer|beverage|ales?|taproom|bierhalle|bierworks)\b/i;

/** Nearby beer context that corroborates an otherwise-ambiguous name. */
const BEER_CONTEXT =
  /\b(beer|brew(ery|ing|pub)?|ipa|lager|pils(ner)?|stout|porter|ale|sour|saison|gose|kolsch|kölsch|hazy|pint|tap(room|s)?|can(s|ned)?|bottle|growler|crowler|flight|abv|hops?|malt|bottleshop|bottle shop)\b/i;

const STRIP =
  /\b(brewing|brewery|breweries|brewers|brewhouse|brewpub|beer|beverage|co|company|craft|ales?|inc|ltd|corp|the)\b/gi;

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The distinctive core of a name, with brewing boilerplate removed. */
export function coreOf(name) {
  return name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(STRIP, ' ')
    .replace(/[^a-z0-9' ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build a matcher over the registry.
 *
 * `ambiguous` names are the ones whose core is entirely common words. They
 * are still matched — Left Field IS a real brewery people discuss — but only
 * with corroboration, recorded on the hit so a caller can weigh it.
 */
export function buildMatcher(breweries) {
  const entries = [];

  for (const b of breweries) {
    const core = coreOf(b.name);
    if (!core || core.length < 3) continue;

    const words = core.split(' ').filter(Boolean);
    const ambiguous = words.every((w) => COMMON.has(w));

    // Single very short cores ("555") are too noisy to match on text alone.
    const tooShort = core.replace(/\s/g, '').length < 4;

    entries.push({
      id: b.id,
      name: b.name,
      core,
      ambiguous: ambiguous || tooShort,
      // Word-boundary match on the core, allowing internal punctuation drift
      // ("c'est what" vs "cest what").
      re: new RegExp(`\\b${esc(core).replace(/ /g, "[\\s'’.-]+")}\\b`, 'i'),
      // The same core followed by a brewing suffix — always unambiguous.
      reSuffixed: new RegExp(
        `\\b${esc(core).replace(/ /g, "[\\s'’.-]+")}[\\s'’.-]+(brew\\w*|beer|ales?|taproom|bierhalle|bierworks)\\b`,
        'i',
      ),
    });
  }

  // Longest core first, so "Bench Brewing" wins over a hypothetical "Bench".
  entries.sort((a, b) => b.core.length - a.core.length);
  return entries;
}

/**
 * All brewery mentions in `text`.
 *
 * Returns `{id, name, confident, via}`. `confident` is false when an ambiguous
 * name matched only on nearby beer context — caller decides whether that is
 * enough. Nothing ambiguous matches on the bare word alone.
 */
export function findMentions(text, matcher) {
  if (!text) return [];
  const found = [];

  for (const e of matcher) {
    const suffixed = text.match(e.reSuffixed);
    if (suffixed) {
      found.push({ id: e.id, name: e.name, confident: true, via: 'suffixed',
                   at: suffixed.index, len: suffixed[0].length });
      continue;
    }
    const m = text.match(e.re);
    if (!m) continue;

    if (!e.ambiguous) {
      found.push({ id: e.id, name: e.name, confident: true, via: 'distinctive',
                   at: m.index, len: m[0].length });
      continue;
    }

    // Ambiguous: require beer context within ~120 chars of the match.
    const window = text.slice(Math.max(0, m.index - 120), m.index + m[0].length + 120);
    if (BEER_CONTEXT.test(window)) {
      found.push({ id: e.id, name: e.name, confident: false, via: 'context',
                   at: m.index, len: m[0].length });
    }
  }

  /**
   * Drop a match whose span sits inside a longer one.
   *
   * "Blood Brothers Paradise Lost" matches Blood Brothers (Toronto) AND
   * Brothers Brewing (Guelph), because one name contains the other. Without
   * this, a comment praising Blood Brothers writes a reputation claim onto a
   * brewery 90 km away that was never mentioned.
   */
  found.sort((a, b) => b.len - a.len);
  const kept = [];
  for (const hit of found) {
    const covered = kept.some(
      (k) => hit.at >= k.at && hit.at + hit.len <= k.at + k.len,
    );
    if (!covered) kept.push(hit);
  }

  // De-dupe by id, preferring the more confident sighting.
  const byId = new Map();
  for (const h of kept) {
    const prev = byId.get(h.id);
    if (!prev || (!prev.confident && h.confident)) byId.set(h.id, h);
  }
  return [...byId.values()].map(({ id, name, confident, via }) => ({ id, name, confident, via }));
}
