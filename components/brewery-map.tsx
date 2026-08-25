'use client';

import { useEffect, useRef, useState } from 'react';
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
  routeApproximated,
  selectedId,
  onSelect,
  theme,
}: {
  results: ScoredBrewery[];
  routePath: RoutePoint[] | null;
  /** True when routing failed and this line is a straight-line stand-in. */
  routeApproximated?: boolean;
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

  /**
   * Route geometry and its styling, in one effect.
   *
   * Retries until the source exists rather than listening once. `styledata`
   * fires repeatedly and can land BEFORE the route source has been added — a
   * `once` listener then bails, never fires again, and the route silently
   * never draws. That's exactly what happened: the layer existed, the fetch
   * succeeded, and the source held zero coordinates.
   */
  useEffect(() => {
    const m = map.current;
    if (!m) return;

    const apply = (): boolean => {
      const src = m.getSource('route') as GeoJSONSource | undefined;
      if (!src) return false;

      src.setData({
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates: (routePath ?? []).map((p) => [p.lng, p.lat]),
        },
      });

      /**
       * A straight-line fallback must not LOOK like a road.
       *
       * When routing fails we still draw the two-point line so the map isn't
       * empty — but in the same solid stroke as real geometry it claims a
       * drive that was never computed, and it visibly cuts across Lake
       * Ontario. Dashed and thinner reads as schematic, which is what it is.
       */
      if (m.getLayer('route-line')) {
        const approx = Boolean(routeApproximated);
        // Round caps render dashes as dots; butt keeps them as dashes.
        m.setLayoutProperty('route-line', 'line-cap', approx ? 'butt' : 'round');
        m.setPaintProperty('route-line', 'line-dasharray', approx ? [2, 2] : [1, 0]);
        m.setPaintProperty('route-line', 'line-width', approx ? 3 : 4);
        m.setPaintProperty('route-casing', 'line-opacity', approx ? 0 : 0.35);
      }
      return true;
    };

    apply();

    /**
     * Stay subscribed for the life of the effect, rather than unsubscribing on
     * first success. `setStyle` — which a theme change triggers, and which the
     * initial paint triggers too — drops every source, taking the route with
     * it. Unsubscribing after the first apply left the line permanently blank
     * after any later restyle: source present, layer present, zero coordinates.
     *
     * setData is cheap and idempotent, so re-applying on each styledata is the
     * simplest thing that stays correct.
     */
    const onData = () => {
      apply();
    };
    m.on('styledata', onData);
    return () => {
      m.off('styledata', onData);
    };
  }, [routePath, routeApproximated, theme]);

  /**
   * Markers, clustered by pixel proximity.
   *
   * Measured before this: 8 of 24 marker pairs sat within 20px at 1440x900,
   * and in Toronto an award-backed marker was completely hidden behind another
   * one. A hidden marker is a brewery that doesn't exist to the user, and it
   * was disproportionately hiding the pins that carry evidence — the exact
   * opposite of what the map should surface.
   *
   * MapLibre's native clustering wants a GeoJSON source with circle layers.
   * These are DOM markers on purpose: they carry the copper/teal distinction
   * from the design system and they're real <button>s, so they're keyboard
   * reachable and screen-reader legible. So the grouping is done here instead.
   *
   * Grouping depends only on ZOOM, not pan — the pixel gap between two fixed
   * coordinates is constant as you pan — so this recomputes on zoom, not on
   * every frame of a drag.
   */
  const [zoomTick, setZoomTick] = useState(0);
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const onZoom = () => setZoomTick((n) => n + 1);
    m.on('zoomend', onZoom);
    return () => {
      m.off('zoomend', onZoom);
    };
  }, []);

  useEffect(() => {
    const m = map.current;
    if (!m) return;

    for (const marker of markers.current.values()) marker.remove();
    markers.current.clear();

    // Marker is 26px; 34 leaves a visible gap between neighbours.
    const CLUSTER_PX = 34;
    const placed: Array<{ x: number; y: number; members: typeof results }> = [];

    results.forEach((r) => {
      const pt = m.project([r.brewery.lng!, r.brewery.lat!]);
      const near = placed.find((g) => Math.hypot(g.x - pt.x, g.y - pt.y) < CLUSTER_PX);
      if (near) near.members.push(r);
      else placed.push({ x: pt.x, y: pt.y, members: [r] });
    });

    placed.forEach((group) => {
      const first = group.members[0];
      const index = results.indexOf(first) + 1;

      if (group.members.length === 1) {
        const known = first.brewery.styles.knownFor.length > 0;
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'obs-marker';
        el.dataset.known = String(known);
        el.textContent = String(index);
        // Native tooltip: identifying a pin shouldn't cost a click.
        el.title = `${first.brewery.name}${first.brewery.city ? ` — ${first.brewery.city}` : ''}`;
        el.setAttribute(
          'aria-label',
          `${index}. ${first.brewery.name}${known ? ', has reputation evidence' : ''}`,
        );
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          select.current(first.brewery.id);
        });
        markers.current.set(
          first.brewery.id,
          new maplibregl.Marker({ element: el })
            .setLngLat([first.brewery.lng!, first.brewery.lat!])
            .addTo(m),
        );
        return;
      }

      // A cluster still has to answer "is anything good in here?", so it
      // carries the copper ring when any member has reputation evidence.
      const anyKnown = group.members.some((x) => x.brewery.styles.knownFor.length > 0);
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'obs-cluster';
      el.dataset.known = String(anyKnown);
      el.textContent = String(group.members.length);
      const names = group.members.slice(0, 6).map((x) => x.brewery.name);
      el.title =
        `${group.members.length} breweries — ${names.join(', ')}` +
        (group.members.length > names.length ? '…' : '') +
        '\nClick to zoom in';
      el.setAttribute('aria-label', `${group.members.length} breweries here. Click to zoom in.`);
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const b = new maplibregl.LngLatBounds();
        group.members.forEach((x) => b.extend([x.brewery.lng!, x.brewery.lat!]));
        // A tight cluster has near-identical bounds, so fitBounds alone barely
        // moves; stepping the zoom guarantees the group actually separates.
        m.fitBounds(b, { padding: 120, maxZoom: Math.min(17, m.getZoom() + 3), duration: 500 });
      });
      // Record membership so the selection effect can light up a cluster that
      // CONTAINS the selected brewery — otherwise searching for a brewery that
      // happens to be clustered selects it in the list and shows nothing on
      // the map, which reads as the search having failed.
      el.dataset.members = group.members.map((x) => x.brewery.id).join(' ');
      markers.current.set(
        `cluster-${first.brewery.id}`,
        new maplibregl.Marker({ element: el })
          .setLngLat([first.brewery.lng!, first.brewery.lat!])
          .addTo(m),
      );
    });
  }, [results, zoomTick]);

  // Selection styling, and a gentle pan so the chosen stop is on screen.
  useEffect(() => {
    for (const [id, marker] of markers.current) {
      const el = marker.getElement();
      const holdsIt =
        Boolean(selectedId) &&
        (id === selectedId || (el.dataset.members ?? '').split(' ').includes(selectedId!));
      el.dataset.selected = String(holdsIt);
    }
    const m = map.current;
    if (!m || !selectedId) return;
    const hit = results.find((r) => r.brewery.id === selectedId);
    if (hit) m.easeTo({ center: [hit.brewery.lng!, hit.brewery.lat!], duration: 500 });
  }, [selectedId, results, zoomTick]);

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
