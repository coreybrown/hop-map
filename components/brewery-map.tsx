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
import { isKnownForSelected, type ScoredBrewery, type StyleTag } from '@/lib/types';
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

/**
 * Southern Ontario, Windsor to Ottawa. The old box reached to 46.8°N, which is
 * mostly empty shield and pushed the populated south into the bottom third of
 * the screen. Every brewery in the registry sits inside this.
 */
const ONTARIO: LngLatBoundsLike = [
  [-83.6, 41.6],
  [-74.2, 46.1],
];

export function BreweryMap({
  results,
  routePath,
  routeApproximated,
  selectedStyles,
  overview,
  padding,
  selectedId,
  onSelect,
  theme,
}: {
  results: ScoredBrewery[];
  routePath: RoutePoint[] | null;
  /** True when routing failed and this line is a straight-line stand-in. */
  routeApproximated?: boolean;
  /** The styles asked for, so "known for" can mean "known for THAT". */
  selectedStyles: StyleTag[];
  /**
   * Every brewery, plotted small when there is no query yet. Landing on an
   * empty map would be a worse answer to "where can I go" than showing the
   * whole province and letting the search narrow it.
   */
  overview?: Array<{ id: string; name: string; lat: number; lng: number }>;
  /** Insets so fitBounds doesn't tuck results under the floating panel. */
  padding?: { top: number; bottom: number; left: number; right: number };
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
  // Read by the cluster click handler, which is built inside an effect that
  // must not re-run when only the insets change.
  const paddingRef = useRef(padding);
  paddingRef.current = padding ?? { top: 60, bottom: 60, left: 60, right: 60 };

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

    // Bottom-right belongs to the legend, so the zoom goes top-right and sits
    // BELOW the wordmark, which is also flush right — see the offset on
    // `.maplibregl-ctrl-top-right` in globals.css. Side by side, the wordmark
    // printed straight through the + button.
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    /*
     * No customAttribution. The vector source carries its own, and MapLibre
     * concatenates the two — the bar read "OpenFreeMap · © OpenStreetMap
     * contributors | OpenFreeMap © OpenMapTiles Data from OpenStreetMap",
     * 617px of the same credit twice.
     *
     * Note WHERE the source's copy comes from, because it is not where you
     * look first: not the style document, but the TileJSON at
     * tiles.openfreemap.org/planet, fetched when the source loads. Stripping
     * `sources[].attribution` in buildSurveyStyle does nothing — verified.
     *
     * ODbL is satisfied by that string: it links OpenFreeMap, OpenMapTiles and
     * OpenStreetMap. If the tile host ever stops sending it, attribution has
     * to come back here — check before switching tile providers.
     */
    m.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');
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

    /*
     * `compact` means collapsible, not collapsed — MapLibre ships the panel
     * open. On desktop that is right: bottom-left is free map and the credit
     * should simply be readable. On a phone it is 354px of a 375px screen, and
     * because the panel is a bottom sheet the corner it lives in is covered —
     * so it moves to the top row (see globals.css) and lands straight across
     * the wordmark. Collapse it to the ⓘ below the sheet's breakpoint; the
     * summary still opens it, which is the whole point of compact mode.
     *
     * Driven by the `open` property rather than the class, so MapLibre's own
     * toggle listener keeps `maplibregl-compact-show` in step with us.
     */
    const narrow = window.matchMedia('(max-width: 639px)');
    const syncAttribution = () => {
      const el = holder.current?.querySelector<HTMLDetailsElement>('.maplibregl-ctrl-attrib');
      if (el) el.open = !narrow.matches;
    };
    syncAttribution();
    narrow.addEventListener('change', syncAttribution);
    // AttributionControl rebuilds its contents on `styledata` and reopens
    // itself doing so, which quietly undid the call above — the collapse only
    // sticks if we reassert it after the style lands.
    m.on('styledata', syncAttribution);
    m.on('load', syncAttribution);

    map.current = m;
    return () => {
      ro.disconnect();
      narrow.removeEventListener('change', syncAttribution);
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

    // No query yet: plot everything small and unnumbered. These are context,
    // not recommendations, so they never take the copper/teal vocabulary —
    // nothing here has been matched against anything.
    if (results.length === 0 && overview?.length) {
      overview.forEach((b) => {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'obs-dot';
        el.title = b.name;
        el.setAttribute('aria-label', b.name);
        markers.current.set(
          b.id,
          new maplibregl.Marker({ element: el }).setLngLat([b.lng, b.lat]).addTo(m),
        );
      });
      return;
    }

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
        const known = isKnownForSelected(first.brewery.styles.knownFor, selectedStyles);
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
      const anyKnown = group.members.some((x) =>
        isKnownForSelected(x.brewery.styles.knownFor, selectedStyles),
      );
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
        // Panel-aware padding here too, or expanding a cluster scatters its
        // members straight underneath the list you're reading them in.
        m.fitBounds(b, {
          padding: paddingRef.current,
          maxZoom: Math.min(17, m.getZoom() + 3),
          duration: 500,
        });
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
  }, [results, zoomTick, selectedStyles, overview]);

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

  // Frame the answer whenever it changes shape — and frame the province when
  // there is no answer yet.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    /**
     * Pad by the PANEL, not by a uniform 60px. The panel is a 400px overlay
     * on the left (a bottom sheet on mobile), so uniform padding parked the
     * origin city underneath it — on a Kingston→Toronto route you could not
     * see Kingston. Nothing should sit under the panel unless the user put
     * it there by panning.
     */
    const pad = padding ?? { top: 60, bottom: 60, left: 60, right: 60 };
    const fit = () => {
      if (results.length === 0) {
        /*
         * The opening view. The constructor's `fitBoundsOptions` can't do this
         * job: it runs before the panel has been measured, and it pads
         * uniformly. On a 375×812 phone the sheet takes 58% of the height, so
         * a uniform fit centred the province and left the visible strip on
         * Timmins and North Bay — every brewery in the registry hidden behind
         * the sheet, on the one view whose entire purpose is "here is all of
         * Ontario". Re-fit with the real insets once they're known.
         */
        if (overview?.length) m.fitBounds(ONTARIO, { padding: pad, duration: 0 });
        return;
      }
      const b = new maplibregl.LngLatBounds();
      results.forEach((r) => b.extend([r.brewery.lng!, r.brewery.lat!]));
      (routePath ?? []).forEach((p) => b.extend([p.lng, p.lat]));
      m.fitBounds(b, { padding: pad, maxZoom: 12, duration: 700 });
    };
    if (ready.current) fit();
    else m.once('load', fit);
    // Intentionally not keyed on selectedId — re-framing on every click would
    // yank the map away from whatever the user was looking at.
  }, [results, routePath, padding, overview]);

  /**
   * Sized with h/w rather than `absolute inset-0`: MapLibre adds its own
   * `.maplibregl-map` class, whose stylesheet sets `position: relative`, and
   * it loads after Tailwind — so the absolute positioning lost and the
   * container collapsed to 0px tall with the canvas rendering nothing.
   */
  return <div ref={holder} className="h-full w-full" data-theme={theme} />;
}
