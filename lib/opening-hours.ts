/**
 * OSM `opening_hours` → something a driver can read at a red light.
 *
 * types.ts left this field raw on purpose, and the reasoning there was sound:
 * a half-right parser that silently mishandles a rule is worse than showing
 * the string, because "is it open" is the last fact checked before someone
 * drives an hour. That objection is answered here by structure, not by
 * confidence — the parser is strict, and anything it does not fully
 * understand degrades to `state: 'unknown'` with an empty summary so the
 * caller can fall back to printing the raw string. It never guesses, and it
 * never throws.
 *
 * Scope is deliberately the subset that actually appears in this registry:
 * weekday selectors, time spans, `off`, `24/7`, and holiday rules. Date
 * ranges ("Jan-Mar"), nth-weekday ("Mo[1]"), variable times ("sunset"),
 * open-ended spans ("18:00+") and fallback rules ("||") are not supported,
 * and specs containing them return 'unknown' rather than a partial answer.
 *
 * Everything is computed in the runtime's local timezone. For a site whose
 * breweries are all in Ontario and whose users are mostly in Ontario, that
 * is right far more often than it is wrong, and it costs no dependency. A
 * user checking Toronto hours from Vancouver will see the wrong answer —
 * the fix for that is a tz database, not a smarter parser.
 */

export interface OpeningStatus {
  state: 'open' | 'closed' | 'unknown';
  /** Short human line, e.g. "Open until 11pm" / "Closed — opens 11am Thursday" / "" */
  summary: string;
  /** Per-day breakdown for a detail view: [{ day: 'Monday', hours: '11am–11pm' | 'Closed' }] */
  week: Array<{ day: string; hours: string }>;
}

/** Minutes from midnight of the day the span is listed under. `end` may exceed
 *  1440, which is how a 1am close is represented — as the same evening. */
interface Span {
  start: number;
  end: number;
}

const DAY_NAMES = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];

/** Monday-indexed, because OSM is and because business hours read Mo→Su. */
const DAY_INDEX: Record<string, number> = {
  Mo: 0,
  Tu: 1,
  We: 2,
  Th: 3,
  Fr: 4,
  Sa: 5,
  Su: 6,
};

const MINUTES_PER_DAY = 1440;

/** Day tokens are two letters and are never followed by another letter, which
 *  is what lets "Su12:00-22:00" (a real, space-less record) still parse. */
const DAY_TOKEN = /^(Mo|Tu|We|Th|Fr|Sa|Su|PH|SH)(?![A-Za-z])/;
const TIME_SPAN = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/;
const HAS_TIME_OR_STATE = /\d{1,2}:\d{2}|\boff\b|\bclosed\b|24\/7/i;

function unknown(): OpeningStatus {
  return { state: 'unknown', summary: '', week: [] };
}

/** "11:30pm", "noon", "midnight" — the words, not the clock face. */
function formatTime(minutes: number): string {
  const m = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  if (m === 0) return 'midnight';
  if (m === 720) return 'noon';
  const h24 = Math.floor(m / 60);
  const mm = m % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const suffix = h24 < 12 ? 'am' : 'pm';
  return mm === 0
    ? `${h12}${suffix}`
    : `${h12}:${String(mm).padStart(2, '0')}${suffix}`;
}

function formatSpan(span: Span): string {
  if (span.end - span.start >= MINUTES_PER_DAY) return 'Open 24 hours';
  return `${formatTime(span.start)}–${formatTime(span.end)}`;
}

function mergeSpans(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Span[] = [];
  for (const span of sorted) {
    const last = out[out.length - 1];
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else out.push({ ...span });
  }
  return out;
}

interface RawRule {
  text: string;
  /** True when a comma preceded this rule. OSM's comma means "additional
   *  rule" (adds hours) while the semicolon means "override" (replaces the
   *  day). Honouring the difference is what makes the one record here with
   *  separate restaurant and retail-store hours come out right. */
  additive: boolean;
}

/**
 * The comma is overloaded in this format: it separates days ("Fr,Sa"), time
 * spans ("11:00-14:00,17:00-23:00") AND whole rules ("Mo-We 11:00-23:00, Th
 * 11:00-24:00"). All three appear in this dataset. They are told apart by
 * position: a comma only ends a rule if the buffer already holds a time (or
 * an `off`) and the text after it starts a new day selector.
 */
function splitRules(spec: string): RawRule[] {
  const rules: RawRule[] = [];
  let buf = '';
  let additive = false;

  const flush = (nextAdditive: boolean) => {
    rules.push({ text: buf.trim(), additive });
    buf = '';
    additive = nextAdditive;
  };

  for (let i = 0; i < spec.length; i++) {
    const ch = spec[i];
    if (ch === ';') {
      flush(false);
      continue;
    }
    if (
      ch === ',' &&
      HAS_TIME_OR_STATE.test(buf) &&
      DAY_TOKEN.test(spec.slice(i + 1).trimStart())
    ) {
      flush(true);
      continue;
    }
    buf += ch;
  }
  flush(false);

  return rules.filter((r) => r.text.length > 0);
}

interface DaySelector {
  /** Empty means the rule carried no day selector at all — it applies to the
   *  whole week — UNLESS `holidayOnly`, in which case it applies to nothing. */
  days: number[];
  holidayOnly: boolean;
  rest: string;
}

function parseDaySelector(text: string): DaySelector | null {
  let cursor = text;
  const days: number[] = [];
  let sawHoliday = false;
  let sawAny = false;

  for (;;) {
    const match = DAY_TOKEN.exec(cursor);
    if (!match) {
      // A trailing comma with no day after it is malformed, not a day list.
      if (sawAny) return null;
      break;
    }
    sawAny = true;
    const from = match[1];
    cursor = cursor.slice(match[0].length).trimStart();

    let to: string | null = null;
    if (cursor.startsWith('-')) {
      const after = cursor.slice(1).trimStart();
      const endMatch = DAY_TOKEN.exec(after);
      if (!endMatch) return null;
      to = endMatch[1];
      cursor = after.slice(endMatch[0].length).trimStart();
    }

    if (from in DAY_INDEX && (to === null || to in DAY_INDEX)) {
      const start = DAY_INDEX[from];
      const end = to === null ? start : DAY_INDEX[to];
      // Ranges wrap: "Su-Th" is five days, not a mistake.
      for (let step = 0; step < 7; step++) {
        const day = (start + step) % 7;
        if (!days.includes(day)) days.push(day);
        if (day === end) break;
      }
    } else {
      // PH/SH, alone or as a range endpoint. Holidays are unknowable without
      // a calendar, so the rule is dropped rather than guessed at.
      sawHoliday = true;
    }

    if (cursor.startsWith(',')) {
      cursor = cursor.slice(1).trimStart();
      continue;
    }
    break;
  }

  return { days, holidayOnly: sawAny && days.length === 0 && sawHoliday, rest: cursor };
}

/** `null` means "this text is not a time list", which fails the whole spec. */
function parseSpans(text: string): Span[] | null {
  const spans: Span[] = [];
  for (const part of text.split(',')) {
    const piece = part.trim();
    if (!piece) return null;
    if (piece === '24/7') {
      spans.push({ start: 0, end: MINUTES_PER_DAY });
      continue;
    }
    const match = TIME_SPAN.exec(piece);
    if (!match) return null;

    const h1 = Number(match[1]);
    const m1 = Number(match[2]);
    const h2 = Number(match[3]);
    const m2 = Number(match[4]);
    if (h1 > 24 || h2 > 24 || m1 > 59 || m2 > 59) return null;

    const start = h1 * 60 + m1;
    let end = h2 * 60 + m2;
    // "11:30-00:00" means midnight tonight, not midnight this morning.
    if (end === 0) end = MINUTES_PER_DAY;
    // "11:00-01:00" closes tomorrow. Carrying it as minute 1500 of the same
    // evening keeps the span contiguous, which is how a customer experiences
    // it — the alternative (splitting it across two day buckets) makes
    // "open until 1am" impossible to say.
    if (end <= start) end += MINUTES_PER_DAY;
    if (start >= MINUTES_PER_DAY) return null;

    spans.push({ start, end });
  }
  return spans.length ? spans : null;
}

/**
 * Folds a day's leading midnight span into the previous evening.
 *
 * Some mappers encode a 1am close as two rules — "Mo 11:00-24:00" plus
 * "Tu 00:00-01:00" — instead of "Mo 11:00-01:00". Both mean the same night
 * out, but read literally the first form says Monday closes at midnight,
 * which would tell a customer standing at the bar at 23:45 to leave. Joining
 * them restores the intent for both the week view and the open/closed check.
 *
 * The guards matter: a day that already runs the full 24 hours is never
 * folded in either direction, or a 24/7 venue would collapse into one
 * enormous Monday.
 */
function stitchMidnightSpans(week: Span[][]): void {
  for (let day = 0; day < 7; day++) {
    const next = (day + 1) % 7;
    const evening = week[day][week[day].length - 1];
    const morning = week[next][0];
    if (!evening || !morning) continue;
    if (evening.end !== MINUTES_PER_DAY || evening.start === 0) continue;
    if (morning.start !== 0 || morning.end >= MINUTES_PER_DAY) continue;

    evening.end = MINUTES_PER_DAY + morning.end;
    week[next].shift();
  }
}

/** The span covering `minute` on `day`, counting last night's spillover. */
function spanAt(week: Span[][], day: number, minute: number): Span | null {
  let best: Span | null = null;

  for (const span of week[day]) {
    if (minute >= span.start && minute < span.end) {
      if (!best || span.end > best.end) best = span;
    }
  }

  const yesterday = (day + 6) % 7;
  for (const span of week[yesterday]) {
    if (span.end > MINUTES_PER_DAY && minute < span.end - MINUTES_PER_DAY) {
      const shifted = { start: span.start - MINUTES_PER_DAY, end: span.end - MINUTES_PER_DAY };
      if (!best || shifted.end > best.end) best = shifted;
    }
  }

  return best;
}

/** Days from today (0–7) and the wall time of the next opening, or null. */
function nextOpening(
  week: Span[][],
  day: number,
  minute: number,
): { offset: number; start: number } | null {
  for (let offset = 0; offset <= 7; offset++) {
    const spans = week[(day + offset) % 7];
    for (const span of spans) {
      if (offset * MINUTES_PER_DAY + span.start > minute) {
        return { offset, start: span.start };
      }
    }
  }
  return null;
}

export function parseOpeningHours(spec: string, now?: Date): OpeningStatus {
  try {
    if (typeof spec !== 'string') return unknown();

    // Comments ("open \"restaurant\"") carry no hours, and the `open` state
    // keyword is the default, so both are noise. `off`/`closed` are not.
    const cleaned = spec
      .replace(/"[^"]*"/g, ' ')
      .replace(/\bopen\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned) return unknown();

    const week: Span[][] = [[], [], [], [], [], [], []];
    let anyRuleApplied = false;

    for (const rule of splitRules(cleaned)) {
      if (rule.text === '24/7') {
        for (let day = 0; day < 7; day++) week[day] = [{ start: 0, end: MINUTES_PER_DAY }];
        anyRuleApplied = true;
        continue;
      }

      const selector = parseDaySelector(rule.text);
      if (!selector) return unknown();
      // A holiday-only rule is skipped, not applied to the week — otherwise
      // "PH off" would close the place seven days a week.
      if (selector.holidayOnly) continue;

      const days = selector.days.length ? selector.days : [0, 1, 2, 3, 4, 5, 6];
      const rest = selector.rest.trim();
      if (!rest) return unknown();

      if (/^(off|closed)\b/i.test(rest)) {
        // "Additive closed" has no meaning, so `off` always clears the day.
        for (const day of days) week[day] = [];
        anyRuleApplied = true;
        continue;
      }

      const spans = parseSpans(rest);
      if (!spans) return unknown();

      for (const day of days) {
        week[day] = mergeSpans(rule.additive ? [...week[day], ...spans] : spans);
      }
      anyRuleApplied = true;
    }

    if (!anyRuleApplied) return unknown();

    stitchMidnightSpans(week);

    const at = now ?? new Date();
    const time = at.getTime();
    if (Number.isNaN(time)) return unknown();
    // JS weeks start on Sunday; this table starts on Monday.
    const today = (at.getDay() + 6) % 7;
    const minute = at.getHours() * 60 + at.getMinutes();

    const alwaysOpen = week.every(
      (spans) => spans.length === 1 && spans[0].start === 0 && spans[0].end >= MINUTES_PER_DAY,
    );

    const rows = week.map((spans, day) => ({
      day: DAY_NAMES[day],
      hours: spans.length ? spans.map(formatSpan).join(', ') : 'Closed',
    }));

    if (alwaysOpen) return { state: 'open', summary: 'Open 24/7', week: rows };

    const current = spanAt(week, today, minute);
    if (current) {
      const closingSoon = current.end - minute <= 60;
      const line = `Open until ${formatTime(current.end)}`;
      return {
        state: 'open',
        summary: closingSoon ? `${line} (closing soon)` : line,
        week: rows,
      };
    }

    const next = nextOpening(week, today, minute);
    if (!next) return { state: 'closed', summary: 'Closed', week: rows };

    const when =
      next.offset === 0
        ? ''
        : next.offset === 1
          ? ' tomorrow'
          : ` ${DAY_NAMES[(today + next.offset) % 7]}`;

    return {
      state: 'closed',
      summary: `Closed — opens ${formatTime(next.start)}${when}`,
      week: rows,
    };
  } catch {
    // Nothing above should throw, but this field is user-generated data from
    // a third party and the caller has a working fallback. Never take the
    // page down over a mangled tag.
    return unknown();
  }
}
