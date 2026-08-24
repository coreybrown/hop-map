'use client';

import { useEffect, useRef } from 'react';
/**
 * Pinned to maplibre-gl v5 deliberately.
 *
 * v6 loads the style, resolves the vector source's tile URLs, fetches sprites
 * and renders the raster relief layer — and then never requests a single
 * vector tile. No console error, no failed request; `isStyleLoaded()` simply
 * stays false forever, so the map paints its background and nothing else.
 *
 * Verified side by side against the identical OpenFreeMap style: v5 fetches
 * vector tiles and renders roads, water, parks and labels; v6 fetches zero.
 * The tiles, CORS, sprites and glyphs are all fine — this is the library.
 *
 * Revisit on a later v6 patch; until then v5 is the working version.
 */
import maplibregl, {
  type Map as MapLibreMap,
  type LngLatBoundsLike,
  type GeoJSONSource,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { ScoredBrewery } from '@/lib/types';
import type { RoutePoint } from '@/lib/route';
import { buildSurveyStyle, loadBaseStyle } from '@/lib/map-style';

/**
 * The map is the product surface, not an illustration on it.
 *
 * An earlier version drew a schematic SVG survey plot. It was prettier against
 * the design system and it was the wrong thing: you couldn't pan it, zoom it,
 * or see which road a detour actually leaves. The feeling this needs is "I am
 * on a map, searching for breweries" — that requires a real basemap.
 *
 * OpenFreeMap serves the vector tiles: free, no API key, no signup, and it
 * carries the OSM attribution we already owe under ODbL.
 *
 * Breweries are the only thing plotted. Everything else on screen is basemap.
 */

/** If the restyle can't be fetched, a stock map beats no map. */
const STOCK_FALLBACK = 'https://tiles.openfreemap.org/styles/liberty';

const ONTARIO: LngLatBoundsLike = [
  [-83.5, 41.6],
  [-74.0, 46.8],
];

export function BreweryMap({
  results,
  routePath,
  selectedId,
  onSelect,
  theme,
}: {
  results: ScoredBrewery[];
  routePath: RoutePoint[] | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  theme: 'light' | 'dark';
}) {
  const holder = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const markers = useRef<globalThis.Map<string, maplibregl.Marker>>(new globalThis.Map());
  const ready = useRef(false);
  // Keep the newest handler without re-running the setup effect.
  const select = useRef(onSelect);
  select.current = onSelect;
  const themeRef = useRef(theme);
  themeRef.current = theme;

  useEffect(() => {
    if (!holder.current || map.current) return;

    const m = new maplibregl.Map({
      container: holder.current,
      // Painted below once the base style resolves. Starting from an empty
      // style avoids a flash of stock OSM green before ours lands.
      style: { version: 8, sources: {}, layers: [] },
      bounds: ONTARIO,
      fitBoundsOptions: { padding: 40 },
      attributionControl: false,
    });

    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    m.addControl(
      new maplibregl.AttributionControl({
        compact: true,
        customAttribution:
          '<a href="https://openfreemap.org" target="_blank" rel="noreferrer">OpenFreeMap</a> · © OpenStreetMap contributors',
      }),
      'bottom-left',
    );
    // Clicking empty basemap clears the selection, like any map app.
    loadBaseStyle()
      .then((base) => m.setStyle(buildSurveyStyle(base, themeRef.current)))
      .catch(() => m.setStyle(STOCK_FALLBACK));

    m.on('click', () => select.current(null));
    m.on('error', (e) => console.error('[maplibre]', e?.error?.message ?? e));
    if (process.env.NODE_ENV !== 'production') {
      (window as unknown as { __map?: MapLibreMap }).__map = m;
    }
    // `styledata` fires on the initial style AND after every setStyle, which
    // is what makes the route survive a theme switch. `load` fires once.
    m.on('styledata', () => {
      if (m.getSource('route')) {
        ready.current = true;
        return;
      }
      ready.current = true;
      m.addSource('route', {
        type: 'geojson',
        data: { type: 'Feature', geometry: { type: 'LineString', coordinates: [] }, properties: {} },
      });
      // Casing under the line so the route stays legible over any basemap colour.
      m.addLayer({
        id: 'route-casing',
        type: 'line',
        source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#0b1a1f', 'line-width': 8, 'line-opacity': 0.35 },
      });
      m.addLayer({
        id: 'route-line',
        type: 'line',
        source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#c2532a', 'line-width': 4 },
      });
    });

    /**
     * Watch the container and tell MapLibre when it changes size.
     *
     * Without this the map measures its viewport once at construction. If the
     * container is 0x0 at that moment — which it is, because the panel and
     * fonts lay out a frame later — the map decides it has nothing to fill and
     * never requests a single tile. The symptom is a blank basemap with the
     * style, fonts and sprites all loading fine, which sends you looking at the
     * network when the problem is geometry.
     */
    const ro = new ResizeObserver(() => m.resize());
    ro.observe(holder.current);

    map.current = m;
    return () => {
      ro.disconnect();
      m.remove();
      map.current = null;
      ready.current = false;
    };
  }, []);

  /**
   * Repaint on theme change. `setStyle` drops every source and layer, so the
   * route has to be rebuilt afterwards — markers survive because they're DOM
   * elements MapLibre only positions, not style layers it owns.
   */
  useEffect(() => {
    const m = map.current;
    if (!m || !ready.current) return;
    let cancelled = false;
    loadBaseStyle().then((base) => {
      if (cancelled || !map.current) return;
      ready.current = false;
      m.setStyle(buildSurveyStyle(base, theme));
    });
    return () => {
      cancelled = true;
    };
  }, [theme]);

  // Route geometry.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const apply = () => {
      const src = m.getSource('route') as GeoJSONSource | undefined;
      if (!src) return;
      src.setData({
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates: (routePath ?? []).map((p) => [p.lng, p.lat]),
        },
      });
    };
    if (ready.current) apply();
    else m.once('load', apply);
  }, [routePath]);

  // Markers. Rebuilt when results change — 20 markers is cheap, and diffing
  // them would trade real complexity for no perceptible gain.
  useEffect(() => {
    const m = map.current;
    if (!m) return;

    for (const marker of markers.current.values()) marker.remove();
    markers.current.clear();

    results.forEach((r, i) => {
      const known = r.brewery.styles.knownFor.length > 0;
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'obs-marker';
      el.setAttribute('aria-label', `${i + 1}. ${r.brewery.name}`);
      el.dataset.known = String(known);
      el.textContent = String(i + 1);
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        select.current(r.brewery.id);
      });

      const marker = new maplibregl.Marker({ element: el })
        .setLngLat([r.brewery.lng!, r.brewery.lat!])
        .addTo(m);
      markers.current.set(r.brewery.id, marker);
    });
  }, [results]);

  // Selection styling, and a gentle pan so the chosen stop is on screen.
  useEffect(() => {
    for (const [id, marker] of markers.current) {
      marker.getElement().dataset.selected = String(id === selectedId);
    }
    const m = map.current;
    if (!m || !selectedId) return;
    const hit = results.find((r) => r.brewery.id === selectedId);
    if (hit) m.easeTo({ center: [hit.brewery.lng!, hit.brewery.lat!], duration: 500 });
  }, [selectedId, results]);

  // Frame the answer whenever it changes shape.
  useEffect(() => {
    const m = map.current;
    if (!m || results.length === 0) return;
    const fit = () => {
      const b = new maplibregl.LngLatBounds();
      results.forEach((r) => b.extend([r.brewery.lng!, r.brewery.lat!]));
      (routePath ?? []).forEach((p) => b.extend([p.lng, p.lat]));
      m.fitBounds(b, { padding: { top: 60, bottom: 60, left: 60, right: 60 }, maxZoom: 12, duration: 700 });
    };
    if (ready.current) fit();
    else m.once('load', fit);
    // Intentionally not keyed on selectedId — re-framing on every click would
    // yank the map away from whatever the user was looking at.
  }, [results, routePath]);

  /**
   * Sized with h/w rather than `absolute inset-0`: MapLibre adds its own
   * `.maplibregl-map` class, whose stylesheet sets `position: relative`, and
   * it loads after Tailwind — so the absolute positioning lost and the
   * container collapsed to 0px tall with the canvas rendering nothing.
   */
  return <div ref={holder} className="h-full w-full" data-theme={theme} />;
}
