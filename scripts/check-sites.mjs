/**
 * Is each brewery's website still theirs?
 *
 * Two of the registry's 201 websites already fail this in ways a crawler
 * reads as "no beer found" rather than "this brewery is gone":
 * evergreencraftales.com now 301s to linktt4dku.website, a parked domain
 * someone else picked up. The crawl records that as an empty catalog. It is
 * actually the strongest closure signal in the dataset.
 *
 * So this asks one question per site — where does the domain land, and who
 * owns it now — and writes the answer as evidence. It does NOT set
 * `status: closed`; a site can die while the taproom thrives. It produces the
 * shortlist a human confirms, which is the honest limit of what a HEAD
 * request can tell you.
 *
 *   node scripts/check-sites.mjs
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(here, '..', 'data');
const REGISTRY = path.join(DATA_DIR, 'registry.json');
const OUT = path.join(DATA_DIR, 'site-health.json');

// A plain browser UA: several hosts refuse a named bot outright, and a 403
// we caused ourselves tells us nothing about whether the brewery still exists.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const TIMEOUT_MS = 15_000;
const POLITE_MS = 400;
const CONCURRENCY = 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Compare registrable domains, not hostnames — www.x.ca → x.ca is the same
 * owner, x.ca → linktt4dku.website is not. Ontario breweries are heavily
 * .ca/.com plus a few .beer, so a two-label suffix check covers the real
 * cases (co.uk-style suffixes don't appear in this dataset).
 */
function registrable(hostname) {
  const parts = hostname.replace(/^www\./, '').split('.');
  if (parts.length <= 2) return parts.join('.');
  const twoLevel = /^(co|com|net|org|gov|edu)\.[a-z]{2}$/.test(parts.slice(-2).join('.'));
  return parts.slice(twoLevel ? -3 : -2).join('.');
}

const PARKED =
  /\b(domain (is )?for sale|buy this domain|parked (free )?courtesy|this domain (may be )?for sale|godaddy|sedo|hugedomains|namecheap parking|under construction|coming soon)\b/i;

const CHALLENGE = /just a moment|checking your browser|cf-browser-verification|attention required/i;

/** Domain brokers. Landing on one is the clearest "they stopped paying" there is. */
const BROKER = /\b(hugedomains|sedo|afternic|dan\.com|undeveloped|domainmarket|buydomains)\b/i;

/**
 * Does the new domain still belong to this brewery?
 *
 * An off-host redirect is ambiguous on its own, and treating them all as
 * closures would be wrong more often than right: Side Launch shortened
 * sidelaunchbrewing.com to sidelaunch.com, Henderson points at its own
 * shophendersonbrewing.com, Beyond The Pale at btpshop.ca. Those breweries
 * are open and the redirect is just a move we should follow.
 *
 * Meanwhile stonecityales.com now serves a UK services firm and
 * meritbrewing.com is listed for sale. Same HTTP shape, opposite meaning.
 *
 * The thing that separates them is whether the destination still carries a
 * distinctive piece of the brewery's name.
 */
const GENERIC = /^(brew|brews|brewing|brewery|beer|beers|ales?|company|the|craft|works|co|inc|ltd|and)$/;

function looksLikeSameOwner(name, hostname) {
  // Match the FULL hostname, not the registrable domain: Covered Bridge moved
  // to coveredbridgebrewing.square.site, where the identity lives entirely in
  // the subdomain. Comparing only "square.site" reads that as a stranger.
  const host = hostname.replace(/^www\./, '').replace(/[^a-z0-9]/gi, '').toLowerCase();

  const words = name
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    // Words shared by half the dataset prove nothing; "brewing" matches anything.
    .filter((w) => w.length >= 4 && !GENERIC.test(w));

  if (words.some((w) => host.includes(w))) return true;

  // Initialisms, over the distinctive words only: "Beyond The Pale Brewing
  // Company" abbreviates to btp — as in btpshop.ca — not btpbc.
  const initials = name
    .toLowerCase()
    .replace(/[^a-z ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !GENERIC.test(w))
    .map((w) => w[0])
    .join('');
  return initials.length >= 3 && host.includes(initials);
}

async function check(site, breweryName) {
  const started = Date.now();
  try {
    const res = await fetch(site, {
      headers: { 'User-Agent': UA, Accept: 'text/html,*/*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const finalUrl = res.url || site;
    const from = registrable(new URL(site).hostname);
    const to = registrable(new URL(finalUrl).hostname);

    // Only read enough to spot a parking page; whole pages are the crawl's job.
    let body = '';
    try {
      body = (await res.text()).slice(0, 4000);
    } catch {
      /* body optional */
    }

    const offHost = from !== to;
    const parked = PARKED.test(body) || BROKER.test(to);
    const challenged = CHALLENGE.test(body);
    const sameOwner =
      offHost && !parked && looksLikeSameOwner(breweryName, new URL(finalUrl).hostname);

    let verdict;
    if (parked) verdict = 'domain-for-sale';
    else if (offHost && sameOwner) verdict = 'moved-own-domain';
    else if (offHost) verdict = 'domain-changed-hands';
    else if (res.status === 404) verdict = 'not-found';
    else if (res.status >= 500) verdict = 'server-error';
    else if (challenged) verdict = 'bot-challenge';
    else if (res.ok) verdict = 'live';
    else verdict = `http-${res.status}`;

    return {
      ok: res.ok && !parked && (!offHost || sameOwner),
      status: res.status,
      finalUrl,
      offHostRedirect: offHost ? to : null,
      parked,
      challenged,
      ms: Date.now() - started,
      verdict,
    };
  } catch (err) {
    const msg = String(err.message ?? err);
    return {
      ok: false,
      status: 0,
      finalUrl: null,
      offHostRedirect: null,
      parked: false,
      challenged: false,
      ms: Date.now() - started,
      verdict: /timeout|timed out/i.test(msg)
        ? 'timeout'
        : /ENOTFOUND|getaddrinfo|dns/i.test(msg)
          ? 'dns-failure'
          : /certificate|TLS|SSL/i.test(msg)
            ? 'tls-failure'
            : 'unreachable',
      error: msg.slice(0, 120),
    };
  }
}

async function main() {
  const { breweries } = JSON.parse(await readFile(REGISTRY, 'utf8'));
  const targets = breweries.filter((b) => b.links?.website || b.website);

  console.log(`Checking ${targets.length} brewery websites…\n`);

  const sites = {};
  const byVerdict = {};
  const queue = [...targets];

  const worker = async () => {
    while (queue.length) {
      const b = queue.shift();
      const site = b.links?.website || b.website;
      const result = await check(site, b.name);
      sites[b.id] = { name: b.name, website: site, ...result, checkedAt: new Date().toISOString() };
      byVerdict[result.verdict] = (byVerdict[result.verdict] ?? 0) + 1;

      if (result.verdict !== 'live') {
        console.log(
          `  ${result.verdict.padEnd(22)} ${b.name.slice(0, 32).padEnd(34)}` +
            (result.offHostRedirect ? ` → ${result.offHostRedirect}` : ''),
        );
      }
      await sleep(POLITE_MS);
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // Two different piles, because they need two different actions.
  const suspect = Object.entries(sites)
    .filter(([, s]) => ['domain-changed-hands', 'domain-for-sale', 'dns-failure'].includes(s.verdict))
    .map(([id, s]) => ({ id, name: s.name, verdict: s.verdict, was: s.website, now: s.finalUrl }));

  // These need no judgement at all — the brewery moved and told us where.
  const moved = Object.entries(sites)
    .filter(([, s]) => s.verdict === 'moved-own-domain')
    .map(([id, s]) => ({ id, name: s.name, was: s.website, now: s.finalUrl }));

  await writeFile(
    OUT,
    JSON.stringify(
      { generatedAt: new Date().toISOString(), count: targets.length, byVerdict, suspect, moved, sites },
      null,
      2,
    ),
  );

  console.log('\nVerdicts:', byVerdict);

  console.log(`\n${moved.length} moved to a domain they still own — safe to follow:`);
  for (const m of moved) console.log(`  ${m.name.padEnd(34)} ${m.was} → ${m.now}`);

  console.log(
    `\n${suspect.length} need a human look — domain for sale, or now someone else's:`,
  );
  for (const s of suspect) console.log(`  ${s.name.padEnd(34)} ${s.verdict.padEnd(22)} → ${s.now}`);
  console.log(`\nWrote ${path.relative(process.cwd(), OUT)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
