/**
 * Adversarial tests for the brewery matcher.
 *
 * Every FALSE case here is a sentence that would write a `knownFor` claim onto
 * the wrong brewery if matching were naive. Those are the expensive failures:
 * a missed mention costs coverage, a false one costs someone a drive.
 */
import { readFileSync } from 'node:fs';
import { buildMatcher, findMentions } from '../lib/brewery-match.mjs';

const { breweries } = JSON.parse(readFileSync(new URL('../data/registry.json', import.meta.url), 'utf8'));
const matcher = buildMatcher(breweries.filter((b) => b.isBrewery !== false && b.status !== 'closed'));

const CASES = [
  // --- must NOT match: ordinary English that happens to contain a name ---
  ['I sat on the bench outside the stadium', 'bench', false],
  ['That answer came completely out of left field', 'left-field', false],
  ['The halo effect is a cognitive bias', 'halo', false],
  ['We walked the dog through High Park on Sunday', 'high-park-brewery', false],
  ['It was a third moon landing documentary', 'third-moon', false],
  ['Common good requires common sacrifice', 'common-good', false],
  ['My old dog sleeps all day', 'old-dog', false],

  // --- MUST match: the same names in real beer talk ---
  ['Left Field Brewery makes a great stout', 'left-field', true],
  ['Halo Brewery in Toronto does wild stuff', 'halo', true],
  ['grabbed a few cans at Bench last weekend, their IPA is solid', 'bench', true],
  ['High Park Brewery has a good patio and decent lager', 'high-park-brewery', true],
  ['Third Moon has the best hazy IPA in Ontario right now', 'third-moon', true],

  // --- distinctive names match unaided ---
  ['Bellwoods Jelly King is the best sour in the province', 'bellwoods', true],
  ['Godspeed does incredible Czech lagers', 'godspeed', true],
  ['rorschach has a great imperial stout', 'rorschach', true],
  ['Blood Brothers Paradise Lost is a classic', 'blood-brothers', true],

  // --- punctuation / spacing drift ---
  ["C'est What? pours cask ale downtown", 'c-est-what', true],

  // --- one name containing another must not fire both ---
  ['Blood Brothers Paradise Lost is a classic', 'brothers-brewing', false],
  ['Brothers Brewing in Guelph is underrated', 'brothers-brewing', true],
];

let pass = 0, fail = 0;
for (const [text, id, expected] of CASES) {
  const hits = findMentions(text, matcher);
  const got = hits.some((h) => h.id === id);
  const ok = got === expected;
  if (ok) pass++; else fail++;
  const detail = hits.length ? hits.map((h) => `${h.id}${h.confident ? '' : '?'}`).join(',') : '—';
  console.log(
    `${ok ? '  ok  ' : '  FAIL'} expect ${String(expected).padEnd(5)} ${id.padEnd(14)} got[${detail.slice(0, 46).padEnd(46)}] "${text.slice(0, 44)}"`,
  );
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
