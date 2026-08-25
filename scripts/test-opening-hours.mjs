/**
 * Asserts the opening-hours parser against the shapes OSM actually produces.
 *
 * Run: npx tsx scripts/test-opening-hours.mjs
 * (tsx, not `node --experimental-strip-types`, for the same reason
 * test-ranking.mjs uses it — it resolves the extensionless TS imports.)
 *
 * Two halves, and both matter. The hand-written cases pin the *output*: a
 * parser that returns 'open' for the right minute but renders "23:00" has
 * still failed the person reading it in a car. The registry sweep pins the
 * *coverage*: the failure mode this parser is most likely to regress into is
 * silently widening its 'unknown' fallback until the feature quietly reverts
 * to printing raw OSM syntax, and nothing in a type check would catch that.
 * So the sweep asserts a floor, not a report.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOpeningHours } from '../lib/opening-hours.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
const failures = [];

function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    passed++;
  } else {
    failures.push(`${label}\n      expected ${b}\n      actual   ${a}`);
  }
}

/**
 * 2026-08-23 is a Sunday, so `at('Mo', 14)` is a real local Monday afternoon.
 * Asserted below rather than assumed — if that anchor ever slipped, every
 * weekday case would quietly test the wrong day and still look green.
 */
const ANCHOR_SUNDAY = new Date(2026, 7, 23);
const DOW = { Su: 0, Mo: 1, Tu: 2, We: 3, Th: 4, Fr: 5, Sa: 6 };
const at = (day, hour, minute = 0) =>
  new Date(2026, 7, 23 + DOW[day], hour, minute);

check('anchor 2026-08-23 is a Sunday', ANCHOR_SUNDAY.getDay(), 0);

const status = (spec, when) => {
  const r = parseOpeningHours(spec, when);
  return { state: r.state, summary: r.summary };
};
const hoursFor = (spec, day) =>
  parseOpeningHours(spec, at('Mo', 12)).week.find((w) => w.day === day)?.hours;

// ---------------------------------------------------------------------------
// The four constructs named in the brief: day ranges, day lists, ";" rules,
// and a post-midnight close — all in one real registry string.
// ---------------------------------------------------------------------------
const MIXED = 'Mo-We 11:00-23:00; Th 11:00-24:00; Fr,Sa 11:00-01:00; Su 11:00-22:00';

check('Mo-We range covers Tuesday', hoursFor(MIXED, 'Tuesday'), '11am–11pm');
check('Fr,Sa list covers Saturday', hoursFor(MIXED, 'Saturday'), '11am–1am');
check('later ";" rule wins for Sunday', hoursFor(MIXED, 'Sunday'), '11am–10pm');
check('24:00 reads as midnight', hoursFor(MIXED, 'Thursday'), '11am–midnight');
check('open mid-afternoon Monday', status(MIXED, at('Mo', 14)), {
  state: 'open',
  summary: 'Open until 11pm',
});
check('closed before opening, same day', status(MIXED, at('Mo', 9)), {
  state: 'closed',
  summary: 'Closed — opens 11am',
});
check('closed after close, next day named', status(MIXED, at('Su', 23)), {
  state: 'closed',
  summary: 'Closed — opens 11am tomorrow',
});
check('full week breakdown', parseOpeningHours(MIXED, at('Mo', 14)).week, [
  { day: 'Monday', hours: '11am–11pm' },
  { day: 'Tuesday', hours: '11am–11pm' },
  { day: 'Wednesday', hours: '11am–11pm' },
  { day: 'Thursday', hours: '11am–midnight' },
  { day: 'Friday', hours: '11am–1am' },
  { day: 'Saturday', hours: '11am–1am' },
  { day: 'Sunday', hours: '11am–10pm' },
]);

// ---------------------------------------------------------------------------
// Post-midnight close at 00:30. The whole reason the model carries a 1am
// close as minute 1500 of Friday: at 00:30 Saturday the venue is still in
// Friday's session, and saying "closed" here is the expensive mistake.
// ---------------------------------------------------------------------------
check('00:30 Saturday is still Friday night', status(MIXED, at('Sa', 0, 30)), {
  state: 'open',
  summary: 'Open until 1am (closing soon)',
});
check('01:30 Saturday is genuinely closed', status(MIXED, at('Sa', 1, 30)), {
  state: 'closed',
  summary: 'Closed — opens 11am',
});
check('2am close from a daily rule', status('Mo-Su 10:00-02:00', at('We', 1)), {
  state: 'open',
  summary: 'Open until 2am (closing soon)',
});

// ---------------------------------------------------------------------------
// Multi-span days, evaluated inside the midday gap. A brewery that shuts
// between lunch and dinner must not read as open at 15:30.
// ---------------------------------------------------------------------------
const SPLIT = 'Mo 11:00-14:00,17:00-23:00; Tu-Su 11:00-23:00';
check('both spans render', hoursFor(SPLIT, 'Monday'), '11am–2pm, 5pm–11pm');
check('closed during the midday gap', status(SPLIT, at('Mo', 15, 30)), {
  state: 'closed',
  summary: 'Closed — opens 5pm',
});
check('open in the lunch span', status(SPLIT, at('Mo', 12)), {
  state: 'open',
  summary: 'Open until 2pm',
});
check('open in the dinner span', status(SPLIT, at('Mo', 19)), {
  state: 'open',
  summary: 'Open until 11pm',
});

// ---------------------------------------------------------------------------
// 24/7, in both spellings that appear in the wild.
// ---------------------------------------------------------------------------
check('24/7 at 3am', status('24/7', at('We', 3)), {
  state: 'open',
  summary: 'Open 24/7',
});
check('00:00-24:00 every day is the same thing', status('Mo-Su 00:00-24:00', at('We', 3)), {
  state: 'open',
  summary: 'Open 24/7',
});
check('24/7 week rows', hoursFor('24/7', 'Sunday'), 'Open 24 hours');

// ---------------------------------------------------------------------------
// Closed days: "Su off", a leading "Mo off", and an all-week shutdown.
// ---------------------------------------------------------------------------
check('Su off closes Sunday', hoursFor('Mo-Sa 12:00-20:00; Su off', 'Sunday'), 'Closed');
check('on a closed Sunday, next opening is named', status('Mo-Sa 12:00-20:00; Su off', at('Su', 13)), {
  state: 'closed',
  summary: 'Closed — opens noon tomorrow',
});
check('a dayless rule can still be overridden off', hoursFor('11:30-21:00; Fr-Sa 11:30-23:00; Tu off', 'Tuesday'), 'Closed');
check('weekday named when it is more than a day out', status('Sa 12:00-17:00', at('Su', 13)), {
  state: 'closed',
  summary: 'Closed — opens noon Saturday',
});
check('never open reports closed, not unknown', status('Mo-Su off', at('We', 12)), {
  state: 'closed',
  summary: 'Closed',
});

// ---------------------------------------------------------------------------
// Holiday rules are dropped, not obeyed. "PH off" applied literally would
// close a brewery seven days a week.
// ---------------------------------------------------------------------------
check('PH off does not close the week', status('Mo-Fr 09:00-17:00; PH off', at('We', 12)), {
  state: 'open',
  summary: 'Open until 5pm',
});
check('PH in a day list is dropped, the rest kept', hoursFor('Mo-Fr,PH 09:00-17:00', 'Friday'), '9am–5pm');
check('a PH-only spec has no regular hours to report', status('PH 12:00-18:00', at('We', 12)), {
  state: 'unknown',
  summary: '',
});

// ---------------------------------------------------------------------------
// Nothing is ever thrown; anything not fully understood degrades to unknown
// so the caller falls back to the raw string.
// ---------------------------------------------------------------------------
const EMPTY = { state: 'unknown', summary: '' };
check('empty string', status('', at('We', 12)), EMPTY);
check('whitespace only', status('   ', at('We', 12)), EMPTY);
check('bare separators', status(' ; ; ', at('We', 12)), EMPTY);
check('prose', status('whenever we feel like it', at('We', 12)), EMPTY);
check('days with no times', status('Mo-Fr', at('We', 12)), EMPTY);
check('impossible clock time', status('Mo-Fr 25:00-26:00', at('We', 12)), EMPTY);
check('unsupported month selector', status('Jan-Mar Mo-Fr 10:00-14:00', at('We', 12)), EMPTY);
check('unsupported open-ended span', status('Mo-Fr 18:00+', at('We', 12)), EMPTY);
check('unsupported variable times', status('Mo-Fr sunrise-sunset', at('We', 12)), EMPTY);
check('unknown returns an empty week, not a blank one', parseOpeningHours('garbage', at('We', 12)).week, []);
check('non-string input', status(undefined, at('We', 12)), EMPTY);
check('numeric input', status(42, at('We', 12)), EMPTY);
check('invalid now', status('Mo-Su 11:00-21:00', new Date('not a date')), EMPTY);
check('now defaults to the clock', typeof parseOpeningHours('Mo-Su 00:00-24:00').summary, 'string');

// ---------------------------------------------------------------------------
// Real-registry quirks that a stricter parser would have thrown away.
// ---------------------------------------------------------------------------
check('missing space after day token', hoursFor('Mo-We 12:00-21:00; Th-Sa 12:00-23:00; Su12:00-22:00', 'Sunday'), 'noon–10pm');
check('single-digit hour', hoursFor('Mo-We 11:00-24:00; Th 11:00-1:00', 'Thursday'), '11am–1am');
check('a dayless rule seeds the whole week', hoursFor('12:00-18:00', 'Wednesday'), 'noon–6pm');
check('wrapping day range Su-Th', hoursFor('Su-Th 11:00-22:00; Fr-Sa 11:00-24:00', 'Monday'), '11am–10pm');
check('comma-separated rules are additional, not overriding', hoursFor(
  'Su-Th 12:00-22:00 open "restaurant", Fr-Sa 12:00-24:00 open "restaurant", 12:00-22:00 open "retail store"',
  'Friday',
), 'noon–midnight');
check('midnight-split rules are rejoined into one evening', hoursFor(
  'Mo-Th 00:00-01:00,11:00-24:00; Fr-Su 00:00-02:00,11:00-24:00',
  'Thursday',
), '11am–2am');
check('and are evaluated as one evening too', status(
  'Mo-Th 00:00-01:00,11:00-24:00; Fr-Su 00:00-02:00,11:00-24:00',
  at('Tu', 0, 30),
), { state: 'open', summary: 'Open until 1am (closing soon)' });
check('a midnight close stays a midnight close when the next day has no early hours', hoursFor(
  'Mo-Fr 15:00-24:00; Sa,Su 00:00-01:00,15:00-24:00',
  'Monday',
), '3pm–midnight');
check('noon and midnight are words', hoursFor('Mo-Su 12:00-24:00', 'Monday'), 'noon–midnight');

// ---------------------------------------------------------------------------
// Coverage sweep across every registry record that carries hours.
// ---------------------------------------------------------------------------
const registry = JSON.parse(
  readFileSync(path.join(here, '..', 'data', 'registry.json'), 'utf8'),
);
const withHours = registry.breweries.filter((b) => b.openingHours);
const unparsed = [];
let parsedCount = 0;

for (const brewery of withHours) {
  const result = parseOpeningHours(brewery.openingHours, at('Mo', 14));
  if (result.state === 'unknown') {
    unparsed.push(`${brewery.name}: ${JSON.stringify(brewery.openingHours)}`);
    continue;
  }
  parsedCount++;
  // A parsed record that renders a blank line or a partial week would slip
  // past the state check and reach a user as an empty hours block.
  if (result.week.length !== 7 || result.week.some((d) => !d.hours) || !result.summary) {
    failures.push(`registry record produced an incomplete render: ${brewery.name}`);
  }
}

console.log(`\nReal registry coverage: ${parsedCount}/${withHours.length} parsed`);
if (unparsed.length) {
  console.log('Fell back to the raw string:');
  unparsed.forEach((line) => console.log(`  · ${line}`));
}

check('every registry record with hours parses', parsedCount, withHours.length);
check('the registry still has the expected number of records with hours', withHours.length, 101);

// ---------------------------------------------------------------------------

console.log(`\n${'='.repeat(72)}`);
if (failures.length) {
  console.log(`FAIL — ${passed} passed, ${failures.length} failed`);
  console.log('='.repeat(72));
  failures.forEach((f, i) => console.log(`\n  ${i + 1}. ${f}`));
  console.log('');
  process.exit(1);
}
console.log(`PASS — ${passed} assertions, 0 failures`);
console.log('='.repeat(72));
