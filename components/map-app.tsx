'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { rankBreweries } from '@/lib/ranking';
import {
  STYLE_LABELS,
  STYLE_TAGS,
  isKnownForSelected,
  type Brewery,
  type StyleTag,
} from '@/lib/types';
import { fetchDrivingRoute, formatDuration, type DrivingRoute } from '@/lib/route';
import { tripToSearch, parseTrip, parseAnchor, type Trip } from '@/lib/trip-url';
import { PlaceSearch, type SearchChoice } from '@/components/place-search';
import { StopRow } from '@/components/stop-row';
import { ShareTrip } from '@/components/share-trip';

/**
 * The whole product: a map you search breweries on.
 *
 * Ranking runs on the client. All 246 breweries are ~25KB gzipped, which is
 * cheaper than a round trip — and it means changing a style re-ranks instantly
 * instead of navigating the page. On a map, a full reload for "also show me
 * sours" would feel broken.
 *
 * The URL still carries the plan; it is updated with replaceState so the link
 * stays shareable without pushing a history entry per keystroke.
 */

// MapLibre touches window on import, so it cannot be server-rendered.
const BreweryMap = dynamic(
  () => import('@/components/brewery-map').then((m) => m.BreweryMap),
  {
    ssr: false,
    loading: () => <div className="survey-grid-bg absolute inset-0" />,
  },
);

export interface Place {
  key: string;
  label: string;
  lat: number;
  lng: number;
}

export function MapApp({
  breweries,
  places,
  initialTrip,
}: {
  breweries: Brewery[];
  places: Place[];
  initialTrip: Trip;
}) {
  const [mode, setMode] = useState<'place' | 'route'>(initialTrip.from ? 'route' : 'place');
  const [from, setFrom] = useState(initialTrip.from ?? '');
  const [to, setTo] = useState(initialTrip.to ?? 'toronto');
  const [styles, setStyles] = useState<StyleTag[]>(initialTrip.styles);
  // Parsed and bounds-checked in trip-url, then never passed on — `?radius=`
  // in a shared link silently did nothing.
  const radiusKm = initialTrip.radiusKm;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [route, setRoute] = useState<DrivingRoute | null>(null);
  const [routing, setRouting] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);

  const originPlace = useMemo(
    () => (mode === 'route' ? parseAnchor(from) : null),
    [mode, from],
  );
  const destPlace = useMemo(() => parseAnchor(to), [to]);

  // Driving geometry, refetched when the endpoints change. Aborted on change
  // so a slow response can't overwrite a newer one.
  useEffect(() => {
    if (!originPlace || !destPlace) {
      setRoute(null);
      return;
    }
    const ac = new AbortController();
    setRouting(true);
    fetchDrivingRoute(originPlace, destPlace, ac.signal)
      .then((r) => {
        if (!ac.signal.aborted) setRoute(r);
      })
      .finally(() => {
        if (!ac.signal.aborted) setRouting(false);
      });
    return () => ac.abort();
  }, [originPlace, destPlace]);

  const results = useMemo(() => {
    if (!destPlace) return [];
    return rankBreweries(breweries, {
      styles,
      ...(originPlace
        ? {
            route: { origin: originPlace, destination: destPlace },
            routePath: route?.path,
          }
        : { anchor: destPlace }),
      radiusKm,
    }).slice(0, 24);
  }, [breweries, styles, originPlace, destPlace, route, radiusKm]);

  // Keep the URL in step so the plan stays shareable.
  const trip: Trip = useMemo(
    () => ({
      from: mode === 'route' ? from || undefined : undefined,
      to: to || undefined,
      styles,
    }),
    [mode, from, to, styles],
  );
  /**
   * History, split by intent.
   *
   * Every change used to call replaceState, which meant Back left the app
   * entirely and took the trip with it — the most-used control in the browser,
   * broken. But pushing an entry per style-chip toggle is just as bad: Back
   * then takes six presses to undo one search.
   *
   * So: changing WHERE you're going is a new search and gets a history entry.
   * Toggling a style refines the search you're already looking at and replaces.
   */
  const lastPlaces = useRef<string>('');
  const suppressSync = useRef(false);
  useEffect(() => {
    const search = tripToSearch(trip);
    if (suppressSync.current) {
      // We're here because of a popstate; the URL is already correct and
      // writing again would clobber the entry we just navigated to.
      suppressSync.current = false;
      lastPlaces.current = `${trip.from ?? ''}|${trip.to ?? ''}`;
      return;
    }
    if (search === window.location.search) return;

    const places = `${trip.from ?? ''}|${trip.to ?? ''}`;
    const isNewSearch = lastPlaces.current !== '' && places !== lastPlaces.current;
    lastPlaces.current = places;

    window.history[isNewSearch ? 'pushState' : 'replaceState'](null, '', `/${search}`);
  }, [trip]);

  // Back/forward must actually move the app, not just the address bar.
  useEffect(() => {
    const onPop = () => {
      const params = Object.fromEntries(new URLSearchParams(window.location.search));
      const t = parseTrip(params);
      suppressSync.current = true;
      setMode(t.from ? 'route' : 'place');
      setFrom(t.from ?? '');
      setTo(t.to ?? 'toronto');
      setStyles(t.styles);
      setSelectedId(null);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  /**
   * Live theme, not a one-shot read. Starts 'light' so the server and the
   * first client render agree — reading matchMedia during render would
   * hydrate-mismatch — then corrects on mount and follows the OS afterwards,
   * so the basemap repaints if someone flips to dark mid-trip.
   */
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const sync = () => setTheme(mq.matches ? 'dark' : 'light');
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  const onChooseDestination = useCallback((choice: SearchChoice) => {
    setTo(choice.value);
    // Picking a brewery by name means "show me around here" AND "that one" —
    // requiring a second click on the pin you just named would be silly.
    setSelectedId(choice.breweryId ?? null);
  }, []);

  const toggleStyle = (tag: StyleTag) =>
    setStyles((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));

  const listRef = useRef<HTMLDivElement>(null);
  const onSelect = useCallback((id: string | null) => {
    setSelectedId(id);
    if (id) {
      document
        .getElementById(`row-${id}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, []);

  const label = originPlace
    ? `${originPlace.label} → ${destPlace?.label ?? ''}`
    : (destPlace?.label ?? '');
  /**
   * Counted the same way the markers are coloured and the legend is worded —
   * all three used to disagree. `knownFor.length > 0` answers "holds a medal
   * in anything", which is not the question the user asked.
   */
  const withRep = results.filter((r) =>
    isKnownForSelected(r.brewery.styles.knownFor, styles),
  ).length;

  return (
    <div className="relative h-[100dvh] w-full overflow-hidden">
      <BreweryMap
        results={results}
        routePath={route?.path ?? null}
        routeApproximated={route?.approximated}
        selectedStyles={styles}
        selectedId={selectedId}
        onSelect={onSelect}
        theme={theme}
      />

      {/*
        The legend. It went missing in the move from the SVG map to MapLibre,
        which left the copper/teal distinction — the product's entire thesis —
        as unexplained decoration. Worded as a claim about confidence, not as
        a colour key, because that is what the colours actually encode.
      */}
      <div className="pointer-events-none absolute bottom-3 right-3 z-[var(--z-map-ui)] hidden rounded-survey border border-line bg-surface-raised/95 px-3 py-2 text-xs shadow-lg sm:block">
        <p className="flex items-center gap-2 text-ink">
          <span
            className="inline-block size-3 shrink-0 rounded-full bg-accent"
            aria-hidden="true"
          />
          {styles.length ? 'Known for what you asked for' : 'Medal winner'}
        </p>
        <p className="mt-1.5 flex items-center gap-2 text-muted">
          <span
            className="inline-block size-3 shrink-0 rounded-full border-2 border-primary"
            aria-hidden="true"
          />
          {styles.length ? 'Stocks it — no medal for that style' : 'No medals on record'}
        </p>
      </div>

      {/*
        The panel floats over the map rather than sitting beside it, so the map
        is never boxed into a corner.

        On a phone it is a BOTTOM SHEET capped at 58dvh. A full-height panel
        covered 97% of the map on a 375px screen, which defeats the premise —
        you are supposed to be on a map. Anchoring it to the bottom also puts
        the controls under the thumb rather than up by the notch.
      */}
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 z-[var(--z-map-ui)] flex flex-col p-2 sm:inset-y-0 sm:right-auto sm:left-0 sm:w-[400px] sm:p-4"
      >
        <div className="pointer-events-auto flex max-h-[58dvh] flex-col overflow-hidden rounded-survey-lg border border-line bg-surface-raised shadow-xl sm:max-h-full">
          <div className="border-b border-line p-3 sm:p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h1 className="survey-display text-base text-ink">Hop Map</h1>
              <button
                type="button"
                onClick={() => setPanelOpen((v) => !v)}
                className="survey-label min-h-[32px] rounded-survey px-2 py-1 hover:text-ink sm:hidden"
                aria-expanded={panelOpen}
              >
                {panelOpen ? 'Hide list' : 'Show list'}
              </button>
            </div>

            <div
              role="radiogroup"
              aria-label="Search shape"
              className="mb-3 inline-flex w-fit rounded-survey border border-line bg-surface p-0.5"
            >
              {(['place', 'route'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={mode === m}
                  onClick={() => setMode(m)}
                  className={`rounded-[2px] px-3 py-1.5 text-sm font-medium transition-colors duration-150 ${
                    mode === m ? 'bg-primary text-on-primary' : 'text-muted hover:text-ink'
                  }`}
                >
                  {m === 'place' ? 'Near a place' : 'Along a route'}
                </button>
              ))}
            </div>

            <div className="grid gap-2">
              {mode === 'route' && (
                <PlaceSearch
                  label="From"
                  current={originPlace}
                  places={places}
                  breweries={breweries}
                  placeholder="Town or brewery…"
                  onChoose={(c) => setFrom(c.value)}
                />
              )}
              <PlaceSearch
                label={mode === 'route' ? 'To' : 'Near'}
                current={destPlace}
                places={places}
                breweries={breweries}
                placeholder="Town or brewery…"
                onChoose={onChooseDestination}
              />
            </div>

            {panelOpen && (
              <div className="mt-3 flex flex-wrap gap-1">
                {STYLE_TAGS.map((tag) => {
                  const on = styles.includes(tag);
                  return (
                    <button
                      key={tag}
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggleStyle(tag)}
                      className={`rounded-survey border px-2 py-1 text-xs transition-colors duration-150 ${
                        on
                          ? 'border-primary bg-primary-soft font-medium text-primary'
                          : 'border-line bg-surface text-muted hover:border-line-strong hover:text-ink'
                      }`}
                    >
                      {STYLE_LABELS[tag]}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {panelOpen && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2 sm:px-4">
                <p className="survey-data text-xs text-muted">
                  {results.length === 0
                    ? 'no matches'
                    : `${results.length} ${results.length === 1 ? 'brewery' : 'breweries'}`}
                  {` · ${withRep} ${styles.length ? 'known for your styles' : 'with medals'}`}
                  {route && !route.approximated && (
                    <>
                      {' · '}
                      {Math.round(route.distanceKm)} km · {formatDuration(route.durationMin)}
                    </>
                  )}
                  {routing && ' · routing…'}
                </p>
                {results.length > 0 && <ShareTrip label={label} />}
              </div>

              {/*
                Never present a straight line as a route.

                When OSRM is unreachable, fetchDrivingRoute falls back to a
                two-point line so the page still works — but silently showing
                that as driving directions is the product's governing rule
                broken in the UI: never claim more than the data supports. The
                detour figures below are straight-line too, so say that.
              */}
              {route?.approximated && (
                <p className="border-b border-line bg-warn-soft px-3 py-2 text-xs text-warn sm:px-4">
                  Couldn’t reach the routing service, so this is a straight line
                  between the two points — not driving directions. Detours below are
                  as-the-crow-flies and will read shorter than the real drive.
                </p>
              )}

              <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                {results.length === 0 ? (
                  <p className="px-4 py-8 text-center text-sm text-muted">
                    Nothing matched. Try fewer styles, or a larger centre nearby.
                  </p>
                ) : (
                  <ol className="px-2 sm:px-3">
                    {results.map((r, i) => (
                      <div key={r.brewery.id} id={`row-${r.brewery.id}`}>
                        <StopRow
                          result={r}
                          index={i}
                          // With nothing chosen yet, the top recommendation is
                          // open: the best answer shouldn't need a click, but
                          // the other 23 shouldn't cost 256px each either.
                          expanded={selectedId ? selectedId === r.brewery.id : i === 0}
                          onSelect={() =>
                            onSelect(selectedId === r.brewery.id ? null : r.brewery.id)
                          }
                        />
                      </div>
                    ))}
                  </ol>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
