/**
 * Scores whatever style data is currently in the registry against Corey's
 * held-out answers. Run this before and after any classifier change.
 *
 * Two metrics, because they measure different failures:
 *
 *   HIT   — is the top style something he'd actually send someone for?
 *           Getting this wrong sends people on a bad detour.
 *   HARM  — do we recommend a style he explicitly said NOT to go for?
 *           This is the expensive error: confidently wrong beats absent.
 *
 *   node scripts/score-styles.mjs
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(here, '..', 'data');

const registry = JSON.parse(await readFile(path.join(DATA, 'registry.json'), 'utf8'));
const truth = JSON.parse(await readFile(path.join(DATA, 'ground-truth.json'), 'utf8'));

/**
 * OFFERS and KNOWN-FOR are scored separately, because they answer different
 * questions and only one of them can do harm.
 *
 * Henderson genuinely brews ten sours — the whole Radicle Gose series is in
 * their catalog. That makes "sour" a correct `offers` value. Corey still says
 * don't go there for sours. Counting that as a harmful recommendation, as an
 * earlier version of this script did, collapses the exact distinction the
 * product exists to make.
 *
 * Harm is only possible via `knownFor`, because only `knownFor` tells someone
 * a style is worth the trip.
 */
const rows = [];
let repHits = 0;
let repScored = 0;
let harms = 0;
let offersHits = 0;
let offersScored = 0;
let noReputation = 0;
let noData = 0;

for (const [id, expected] of Object.entries(truth.breweries)) {
  const brewery = registry.breweries.find((b) => b.id === id);
  const knownFor = brewery?.styles.knownFor ?? [];
  const offers = brewery?.styles.offers ?? [];

  const row = { id, knownFor: knownFor.join(', ') || '—', offers: offers.join(', ') || '—' };

  // Harm: we told someone to go for a style they'd have been disappointed by.
  const harmful = knownFor.filter((s) => expected.notFor.includes(s));
  if (harmful.length) {
    harms++;
    row.harm = harmful.join(', ');
  }

  // Reputation accuracy — the metric that decides whether we ship.
  if (knownFor.length) {
    if (!(expected.trueGeneralist && !expected.goFor.length)) {
      repScored++;
      row.repVerdict = expected.goFor.includes(knownFor[0]) ? 'hit' : 'MISS';
      if (row.repVerdict === 'hit') repHits++;
    }
  } else {
    noReputation++;
    row.repVerdict = 'none';
  }

  // Offers accuracy — a weaker check: does anything we say they pour overlap
  // with what an expert says is worth having? Wrong here is untidy, not unsafe.
  if (offers.length && expected.goFor.length) {
    offersScored++;
    if (offers.some((s) => expected.goFor.includes(s))) offersHits++;
    row.offersOverlap = offers.some((s) => expected.goFor.includes(s)) ? 'overlaps' : 'no overlap';
  } else if (!offers.length) {
    noData++;
    row.offersOverlap = 'no data';
  }

  row.expected = expected.goFor.join(', ') || 'broad range';
  rows.push(row);
}

console.log('=== SCORED AGAINST HELD-OUT EXPERT ANSWERS ===');
console.log('knownFor drives recommendations. offers is a supporting fact.\n');

for (const r of rows) {
  const flag = r.repVerdict === 'hit' ? ' ✓' : r.repVerdict === 'MISS' ? ' ✗' : ' ·';
  console.log(`${flag} ${r.id.padEnd(17)} known-for: ${r.knownFor}`);
  console.log(`${' '.repeat(20)} offers:    ${r.offers}  (${r.offersOverlap ?? '—'})`);
  console.log(`${' '.repeat(20)} expert:    ${r.expected}`);
  if (r.harm) console.log(`${' '.repeat(20)} ⚠ HARM — recommended a style he ruled out: ${r.harm}`);
  console.log('');
}

console.log('--- summary ---');
console.log(
  `reputation accuracy   ${repScored ? `${repHits}/${repScored} (${Math.round((repHits / repScored) * 100)}%)` : 'n/a — no reputation data yet'}`,
);
console.log(`harmful recommends    ${harms}   ← the only number that must be zero`);
console.log(`offers overlap        ${offersScored ? `${offersHits}/${offersScored}` : 'n/a'}   (weak signal, not a recommendation)`);
console.log(`no reputation data    ${noReputation}`);
console.log(`no data at all        ${noData}`);
