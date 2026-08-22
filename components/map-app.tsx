'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { rankBreweries } from '@/lib/ranking';
import { STYLE_LABELS, STYLE_TAGS, type Brewery, type StyleTag } from '@/lib/types';
import { fetchDrivingRoute, formatDuration, type DrivingRoute } from '@/lib/route';
import { tripToSearch, type Trip } from '@/lib/trip-url';
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [route, setRoute] = useState<DrivingRoute | null>(null);
  const [routing, setRouting] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);

  const byKey = useMemo(() => new Map(places.map((p) => [p.key, p])), [places]);
  const originPlace = mode === 'route' ? byKey.get(from) : undefined;
  const destPlace = byKey.get(to);

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
    }).slice(0, 24);
  }, [breweries, styles, originPlace, destPlace, route]);

  // Keep the URL in step so the plan stays shareable.
  const trip: Trip = useMemo(
    () => ({
      from: mode === 'route' ? from || undefined : undefined,
      to: to || undefined,
      styles,
    }),
    [mode, from, to, styles],
  );
  useEffect(() => {
    window.history.replaceState(null, '', `/${tripToSearch(trip)}`);
  }, [trip]);

  const theme =
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';

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
  const withRep = results.filter((r) => r.brewery.styles.knownFor.length > 0).length;

  return (
    <div className="relative h-[100dvh] w-full overflow-hidden">
      <BreweryMap
        results={results}
        routePath={route?.path ?? null}
        selectedId={selectedId}
        onSelect={onSelect}
        theme={theme}
      />

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
                <Select
                  label="From"
                  value={from}
                  onChange={setFrom}
                  places={places}
                  placeholder="Starting point…"
                />
              )}
              <Select
                label={mode === 'route' ? 'To' : 'Near'}
                value={to}
                onChange={setTo}
                places={places}
                placeholder="Choose a place…"
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
                  {withRep > 0 && ` · ${withRep} with evidence`}
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

              <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                {results.length === 0 ? (
                  <p className="px-4 py-8 text-center text-sm text-muted">
                    Nothing matched. Try fewer styles, or a larger centre nearby.
                  </p>
                ) : (
                  <ol className="px-3 sm:px-4">
                    {results.map((r, i) => (
                      <div
                        key={r.brewery.id}
                        id={`row-${r.brewery.id}`}
                        onClick={() => onSelect(r.brewery.id)}
                        className={`cursor-pointer rounded-survey transition-colors duration-150 ${
                          selectedId === r.brewery.id ? 'bg-primary-soft' : ''
                        }`}
                      >
                        <StopRow result={r} index={i} />
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

function Select({
  label,
  value,
  onChange,
  places,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  places: Place[];
  placeholder: string;
}) {
  return (
    <label className="flex items-center gap-2">
      <span className="survey-label w-10 shrink-0">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-10 min-w-0 flex-1 rounded-survey border border-line bg-surface px-2 text-sm text-ink transition-colors duration-150 hover:border-line-strong"
      >
        <option value="">{placeholder}</option>
        {places.map((p) => (
          <option key={p.key} value={p.key}>
            {p.label}
          </option>
        ))}
      </select>
    </label>
  );
}
