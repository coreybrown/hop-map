import type { ScoredBrewery } from '@/lib/types';
import { STYLE_LABELS } from '@/lib/types';

/**
 * One recommended stop.
 *
 * A row with a rule under it, not a card. Cards would box fifteen near-identical
 * blocks and make the list harder to scan, and the ordering is the information —
 * this is a ranked plan, so the number carries meaning rather than decoration.
 *
 * THE HONESTY RULE, which is the whole product:
 *
 *   A brewery we have reputation evidence for and a brewery that merely stocks
 *   the style MUST NOT look the same. `knownFor` is sourced — a blind-judged
 *   medal in a named category and year — and gets the accent, the evidence line
 *   and the top billing. `offers` is a catalog crawl; it is true, it is useful,
 *   and it is not a reason to drive anywhere. It stays quiet and grey.
 *
 * Getting this backwards is exactly the failure the data pipeline exists to
 * prevent: a confident recommendation costs someone a real detour.
 */
export function StopRow({ result, index }: { result: ScoredBrewery; index: number }) {
  const { brewery, reasons, distanceKm, detourKm, freshRelease } = result;
  const knownFor = brewery.styles.knownFor ?? [];
  const evidence = brewery.reputationEvidence ?? [];
  const unverified = brewery.status === 'unverified';

  // The measurement, whichever mode we're in. Mono + tabular so a column of
  // these can be compared at a glance.
  const measure =
    detourKm !== undefined
      ? { value: `+${detourKm.toFixed(detourKm < 10 ? 1 : 0)}`, unit: 'km detour' }
      : distanceKm !== undefined
        ? { value: distanceKm.toFixed(distanceKm < 10 ? 1 : 0), unit: 'km away' }
        : null;

  /**
   * The ranking engine puts a fresh release at the FRONT of `reasons` because
   * it is the most persuasive thing we can say. We also render it as its own
   * chip, which is more scannable. Showing both prints the same sentence twice,
   * so the prose version is dropped here — matched on the release name rather
   * than on the sentence's wording, which the engine owns and may reword.
   */
  const prose = freshRelease
    ? reasons.filter((r) => !r.includes(freshRelease.name))
    : reasons;

  return (
    <li
      id={`stop-${index + 1}`}
      className="group scroll-mt-4 border-b border-line py-6 last:border-b-0"
    >
      <div className="flex items-baseline gap-4">
        <span className="survey-data w-6 shrink-0 text-sm text-muted" aria-hidden="true">
          {String(index + 1).padStart(2, '0')}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h3 className="survey-display text-lg text-ink">{brewery.name}</h3>
            {brewery.city && <span className="text-sm text-muted">{brewery.city}</span>}
          </div>

          {/* Reputation first, and only when it is real. */}
          {knownFor.length > 0 && (
            <p className="mt-2 flex flex-wrap items-center gap-1.5 text-sm">
              <span className="font-medium text-accent">Known for</span>
              {knownFor.map((s) => (
                <span
                  key={s}
                  className="rounded-survey bg-accent-soft px-1.5 py-0.5 font-medium text-accent"
                >
                  {STYLE_LABELS[s]}
                </span>
              ))}
            </p>
          )}
        </div>

        {measure && (
          <div className="shrink-0 text-right">
            <div className="survey-data text-lg leading-none text-ink">{measure.value}</div>
            <div className="survey-label mt-1">{measure.unit}</div>
          </div>
        )}
      </div>

      <div className="mt-3 pl-10">
        {/* Why it's here. Plain list — these are already written as sentences
            by the ranking engine, which owns the reasoning. */}
        <ul className="grid gap-1 text-sm text-muted">
          {prose.map((reason) => (
            <li key={reason} className="flex gap-2">
              <span className="select-none text-line-strong" aria-hidden="true">
                ·
              </span>
              <span className={unverified && reason.includes('confirmed') ? 'text-warn' : ''}>
                {reason}
              </span>
            </li>
          ))}
        </ul>

        {/* The citation behind `knownFor`. Showing the working is the point —
            "Gold, New England Style IPA, CBA 2024" is checkable; a star isn't. */}
        {evidence.length > 0 && (
          <ul className="survey-data mt-3 grid gap-1 border-l-0 text-xs text-muted">
            {evidence.map((e) => (
              <li key={`${e.style}-${e.detail}`}>{e.detail}</li>
            ))}
          </ul>
        )}

        {freshRelease && (
          <p className="mt-3 inline-flex items-center gap-2 rounded-survey bg-fresh-soft px-2 py-1 text-sm text-fresh">
            <span className="font-medium">New:</span>
            <span>{freshRelease.name}</span>
            <span className="survey-data text-xs opacity-80">
              {freshRelease.daysAgo <= 1 ? 'today' : `${freshRelease.daysAgo}d ago`}
            </span>
          </p>
        )}

        {/* Tap targets, not just links. Per core-loop.md the planning happens
            at a desk but the EXECUTION happens on a phone in a car — these two
            are the controls that get used there, so they clear the 24px WCAG
            2.2 minimum with room rather than sitting at a desktop-ish 20px. */}
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          {brewery.links?.website && (
            <a
              href={brewery.links.website}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-[32px] items-center text-primary underline-offset-4 hover:underline"
            >
              Website
            </a>
          )}
          <a
            href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
              `${brewery.name} ${brewery.address ?? ''}`,
            )}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-[32px] items-center text-primary underline-offset-4 hover:underline"
          >
            Directions
          </a>
          {brewery.openingHours && (
            <span className="survey-data inline-flex min-h-[32px] items-center text-xs text-muted">
              {brewery.openingHours}
            </span>
          )}
        </div>
      </div>
    </li>
  );
}
