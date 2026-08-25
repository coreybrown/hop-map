import type { ScoredBrewery } from '@/lib/types';
import { STYLE_LABELS } from '@/lib/types';

/**
 * One recommended stop: a compact summary that expands when selected.
 *
 * The previous version rendered every row in full — three reason lines, award
 * citations, links, opening hours — which ran 256px tall. In a 400px panel
 * that left 1.8 rows visible, and a list you can only see two of cannot do the
 * one job a list has: comparison. You were reading a very tall single result.
 *
 * So the collapsed row carries exactly what you compare on — rank, name,
 * distance, and whether it's known for what you asked — at roughly 70px, and
 * the reasoning appears for the one you're actually considering. Standard map-
 * app behaviour, and it's what the map/list pairing already implied: the map
 * is for choosing, the row is for confirming.
 *
 * THE HONESTY RULE SURVIVES COLLAPSE. `knownFor` is sourced reputation and
 * keeps the accent even in the summary; `offers` is a catalog crawl and stays
 * quiet. A brewery we can vouch for and one that merely stocks the style must
 * never look the same, at any density.
 */
export function StopRow({
  result,
  index,
  expanded,
  onSelect,
}: {
  result: ScoredBrewery;
  index: number;
  expanded: boolean;
  onSelect: () => void;
}) {
  const { brewery, reasons, distanceKm, detourKm, freshRelease } = result;
  const knownFor = brewery.styles.knownFor ?? [];
  const evidence = brewery.reputationEvidence ?? [];
  const unverified = brewery.status === 'unverified';

  const measure =
    detourKm !== undefined
      ? { value: `+${detourKm.toFixed(detourKm < 10 ? 1 : 0)}`, unit: 'km detour' }
      : distanceKm !== undefined
        ? { value: distanceKm.toFixed(distanceKm < 10 ? 1 : 0), unit: 'km away' }
        : null;

  // The engine puts a fresh release first in `reasons`; it also renders as its
  // own chip below, so drop the prose copy rather than saying it twice.
  const prose = freshRelease ? reasons.filter((r) => !r.includes(freshRelease.name)) : reasons;

  return (
    <li id={`stop-${index + 1}`} className="scroll-mt-2 border-b border-line last:border-b-0">
      <button
        type="button"
        onClick={onSelect}
        aria-expanded={expanded}
        className={`flex w-full items-baseline gap-3 rounded-survey px-2 py-3 text-left transition-colors duration-150 ${
          expanded ? 'bg-primary-soft' : 'hover:bg-surface'
        }`}
      >
        <span className="survey-data w-5 shrink-0 text-xs text-muted" aria-hidden="true">
          {String(index + 1).padStart(2, '0')}
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="survey-display text-[0.95rem] leading-tight text-ink">
              {brewery.name}
            </span>
            {brewery.city && <span className="text-xs text-muted">{brewery.city}</span>}
          </span>

          {/* Reputation is the thing you compare on, so it stays in the summary. */}
          {knownFor.length > 0 && (
            <span className="mt-1 flex flex-wrap items-center gap-1">
              {knownFor.slice(0, 3).map((s) => (
                <span
                  key={s}
                  className="rounded-survey bg-accent-soft px-1.5 py-0.5 text-[0.7rem] font-medium text-accent"
                >
                  {STYLE_LABELS[s]}
                </span>
              ))}
            </span>
          )}

          {/* One-word state flags, so a collapsed row still warns. */}
          <span className="mt-1 flex flex-wrap items-center gap-x-3 text-[0.7rem]">
            {freshRelease && <span className="text-fresh">New release</span>}
            {unverified && <span className="text-warn">Unconfirmed</span>}
          </span>
        </span>

        {measure && (
          <span className="shrink-0 text-right">
            <span className="survey-data block text-sm leading-none text-ink">
              {measure.value}
            </span>
            <span className="survey-label mt-0.5 block">{measure.unit}</span>
          </span>
        )}
      </button>

      {expanded && (
        <div className="px-2 pb-4 pl-9">
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

          {/* Showing the working: "Gold, New England Style IPA, CBA 2024" is
              checkable in a way a star rating never is. */}
          {evidence.length > 0 && (
            <ul className="survey-data mt-3 grid gap-1 text-xs text-muted">
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

          {/* The controls that get used phone-in-hand at the brewery, sized to
              clear the 24px WCAG 2.2 minimum with room. */}
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
          </div>

          {brewery.openingHours && (
            <p className="survey-data mt-1 text-xs text-muted">{brewery.openingHours}</p>
          )}
        </div>
      )}
    </li>
  );
}
