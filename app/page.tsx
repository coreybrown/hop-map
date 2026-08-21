import { rankBreweries } from '@/lib/ranking';
import { OPEN_BREWERIES, PLACES, ATTRIBUTION, REGISTRY_GENERATED_AT } from '@/lib/data';
import { parseTrip, describeTrip, isRunnable, isRoute } from '@/lib/trip-url';
import { TripForm } from '@/components/trip-form';
import { StopRow } from '@/components/stop-row';
import { ShareTrip } from '@/components/share-trip';
import { SurveyMap } from '@/components/survey-map';

/**
 * The core loop on one page: where + what → a ranked plan with reasons → a link
 * that survives until travel day.
 *
 * One page rather than a wizard because the whole thing is one question, and
 * because re-running it with a different style is the main interaction — a
 * multi-step flow would make the cheapest, most common action the slowest one.
 *
 * `searchParams` is a Promise in Next 16, so this is async. Reading it opts the
 * page into dynamic rendering, which is correct here: the trip is the query.
 */
export default async function Home(props: PageProps<'/'>) {
  const trip = parseTrip(await props.searchParams);
  const runnable = isRunnable(trip);

  const results = runnable
    ? rankBreweries(OPEN_BREWERIES, {
        styles: trip.styles,
        ...(isRoute(trip)
          ? {
              route: {
                origin: { lat: PLACES[trip.from!].lat, lng: PLACES[trip.from!].lng },
                destination: { lat: PLACES[trip.to!].lat, lng: PLACES[trip.to!].lng },
              },
            }
          : {
              anchor: { lat: PLACES[trip.to!].lat, lng: PLACES[trip.to!].lng },
            }),
        radiusKm: trip.radiusKm,
        requireBottleShop: trip.requireBottleShop,
        requireFood: trip.requireFood,
      })
    : [];

  const shown = results.slice(0, 20);
  const withReputation = shown.filter((r) => r.brewery.styles.knownFor.length > 0).length;

  return (
    <div className="mx-auto w-full max-w-3xl px-5 py-10 sm:px-8 sm:py-14">
      <header className="mb-10">
        <h1 className="survey-display text-2xl text-ink sm:text-3xl">Ontario Beer Survey</h1>
        <p className="mt-2 max-w-[60ch] text-muted">
          The breweries worth the detour, matched to the beer you actually like — and the
          reasons why, so you can judge for yourself.
        </p>
      </header>

      <section className="rounded-survey-lg border border-line bg-surface p-5 sm:p-7">
        <TripForm initial={trip} />
      </section>

      {runnable && (
        <section className="mt-12" aria-live="polite">
          <div className="mb-6 flex flex-wrap items-end justify-between gap-4 border-b border-line-strong pb-3">
            <div>
              <h2 className="survey-display text-xl text-ink">{describeTrip(trip)}</h2>
              <p className="survey-data mt-1 text-sm text-muted">
                {results.length === 0
                  ? 'no matches'
                  : `${shown.length} of ${results.length} ${
                      results.length === 1 ? 'brewery' : 'breweries'
                    }`}
                {withReputation > 0 && ` · ${withReputation} with reputation evidence`}
              </p>
            </div>
            {results.length > 0 && <ShareTrip label={describeTrip(trip)} />}
          </div>

          {results.length === 0 ? (
            <NoMatches hasStyles={trip.styles.length > 0} filtered={Boolean(trip.requireBottleShop || trip.requireFood)} />
          ) : (
            <>
              {/* The map answers "is this near where I'll be?" faster than a
                  column of distances can. It sits above the list because that
                  is the question asked first. */}
              <div className="mb-6">
                <SurveyMap
                  results={shown}
                  all={OPEN_BREWERIES}
                  origin={trip.from}
                  destination={trip.to}
                  label={describeTrip(trip)}
                />
              </div>

              {/*
                Said once, at the top, rather than repeated as a disclaimer on
                every row. `knownFor` covers 25 of 246 breweries — pretending
                otherwise would be the exact failure this product is built to
                avoid, but so would burying every result under a hedge.
              */}
              {withReputation === 0 && (
                <p className="mb-6 rounded-survey border border-line bg-surface px-4 py-3 text-sm text-muted">
                  None of these have independent reputation evidence yet, so they’re ranked on
                  what they <strong className="font-medium text-ink">stock</strong> and how far
                  off your route they are. That’s a weaker signal than a recommendation — treat
                  it as a shortlist to check, not a verdict.
                </p>
              )}

              <ol className="grid">
                {shown.map((result, i) => (
                  <StopRow key={result.brewery.id} result={result} index={i} />
                ))}
              </ol>
            </>
          )}
        </section>
      )}

      {!runnable && (
        <section className="mt-12">
          <h2 className="survey-label mb-4">Try one of these</h2>
          <ul className="grid gap-2 sm:grid-cols-2">
            {[
              { href: '/?from=kingston&to=toronto&styles=hazy-ipa,pilsner-lager', label: 'Kingston → Toronto, hazy IPA and lager' },
              { href: '/?to=toronto&styles=pilsner-lager', label: 'Toronto, lagers and pilsners' },
              { href: '/?from=toronto&to=ottawa&styles=stout-porter', label: 'Toronto → Ottawa, stouts' },
              { href: '/?to=niagara&styles=sour,wild-ale', label: 'Niagara, sours and wild ales' },
            ].map((example) => (
              <li key={example.href}>
                <a
                  href={example.href}
                  className="block rounded-survey border border-line bg-surface-raised px-4 py-3 text-sm text-ink transition-colors duration-150 hover:border-line-strong"
                >
                  {example.label}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      <footer className="mt-16 border-t border-line pt-6 text-xs text-muted">
        <p>{ATTRIBUTION}</p>
        <p className="survey-data mt-1">
          Registry generated {REGISTRY_GENERATED_AT.slice(0, 10)} · reputation evidence from
          the Canadian Brewing Awards
        </p>
      </footer>
    </div>
  );
}

/**
 * Empty states that teach rather than shrug. Each names the most likely cause
 * and the specific control that fixes it.
 */
function NoMatches({ hasStyles, filtered }: { hasStyles: boolean; filtered: boolean }) {
  return (
    <div className="rounded-survey border border-line bg-surface px-5 py-8 text-center">
      <p className="survey-display text-ink">Nothing matched that.</p>
      <p className="mx-auto mt-2 max-w-[48ch] text-sm text-muted">
        {filtered
          ? 'The bottle-shop and food filters are strict: most records simply have no data either way, and we won’t promise a bottle shop we can’t confirm. Try clearing them first.'
          : hasStyles
            ? 'We only know the styles of about 4 in 10 Ontario breweries so far. Try fewer styles, or a bigger centre nearby.'
            : 'Nothing within range of there yet. Try a larger centre nearby.'}
      </p>
    </div>
  );
}
