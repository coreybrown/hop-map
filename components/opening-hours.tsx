'use client';

import { useEffect, useState } from 'react';
import { parseOpeningHours, type OpeningStatus } from '@/lib/opening-hours';

/**
 * "Open until 11pm" instead of `Mo-We 11:00-23:00; Th 11:00-24:00; …`.
 *
 * The raw OSM string was being shown verbatim to someone deciding whether to
 * drive somewhere — the last field they check before leaving, read on a phone,
 * in a car. `lib/types.ts` deliberately left it unparsed because a half-right
 * parser is worse than an honest string; this renders a status only when the
 * parser is confident and falls back to the raw string otherwise.
 *
 * COMPUTED AFTER MOUNT, NEVER DURING RENDER. This component is inside a client
 * tree that Next still prerenders on the server, and Vercel's server runs UTC —
 * so a render-time "open now" would be computed 4-5 hours off Ontario, ship
 * that wrong answer into the HTML, and then hydration-mismatch when the browser
 * disagrees. Waiting for mount costs one frame and is correct.
 */
export function OpeningHours({ spec }: { spec: string }) {
  const [status, setStatus] = useState<OpeningStatus | null>(null);
  const [showWeek, setShowWeek] = useState(false);

  useEffect(() => {
    setStatus(parseOpeningHours(spec));
    // Re-evaluate on focus: a page left open past closing keeps claiming open.
    const recheck = () => setStatus(parseOpeningHours(spec));
    window.addEventListener('focus', recheck);
    return () => window.removeEventListener('focus', recheck);
  }, [spec]);

  // Pre-mount, and whenever the parser can't be confident, show what we were
  // given rather than nothing — the raw string is ugly but it is true.
  if (!status || status.state === 'unknown') {
    return <p className="survey-data mt-1 text-xs text-muted">{spec}</p>;
  }

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setShowWeek((v) => !v)}
        aria-expanded={showWeek}
        className="inline-flex min-h-[32px] items-center gap-2 text-sm"
      >
        <span className={status.state === 'open' ? 'text-fresh' : 'text-muted'}>
          {status.summary}
        </span>
        <span className="survey-label">{showWeek ? 'Hide week' : 'All week'}</span>
      </button>

      {showWeek && (
        <dl className="survey-data mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-muted">
          {status.week.map((d) => (
            <div key={d.day} className="contents">
              <dt>{d.day.slice(0, 3)}</dt>
              <dd>{d.hours}</dd>
            </div>
          ))}
        </dl>
      )}

      {/* Hours come from OSM surveys, which go stale. Say where they're from
          rather than presenting them as something we verified. */}
      <p className="survey-label mt-1">From map data</p>
    </div>
  );
}
