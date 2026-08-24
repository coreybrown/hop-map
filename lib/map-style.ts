import type { StyleSpecification, LayerSpecification } from 'maplibre-gl';

/**
 * Repaint the basemap in the Survey palette.
 *
 * OpenFreeMap's Liberty style is 111 layers of stock OSM colours — the green
 * parks, the yellow motorways, the blue water everyone recognises. It's a fine
 * map and it looks nothing like this product.
 *
 * Rather than author a style from scratch (111 layers of hand-tuned
 * cartography we'd then own forever), this takes Liberty's layer structure —
 * which is genuinely good, with proper road casings and zoom-dependent widths —
 * and swaps only the colours. Categorise each layer by its id, assign from the
 * palette, leave every geometry decision alone.
 *
 * Two rules beyond colour:
 *
 *   POIs ARE REMOVED. The brief is that breweries are the only things on this
 *   map. Stock POI pins would compete with ours for exactly the attention our
 *   markers need, so shops, restaurants and transit icons come out entirely.
 *
 *   BOTH THEMES ARE REAL. Planning happens at a desk in daylight, execution
 *   happens on a phone in a car at dusk — that's from the design system, and a
 *   basemap that only works in one of them breaks half the product.
 *
 * The hex values below are the globals.css OKLCH tokens converted to sRGB;
 * MapLibre's colour parser predates oklch() and can't read the tokens directly.
 */

export type MapTheme = 'light' | 'dark';

interface Palette {
  land: string;
  water: string;
  green: string;
  builtUp: string;
  building: string;
  roadFill: string;
  roadCasing: string;
  motorway: string;
  motorwayCasing: string;
  boundary: string;
  label: string;
  labelMinor: string;
  halo: string;
}

/**
 * THE BASEMAP IS NEUTRAL. THE BRAND COLOUR MARKS BREWERIES.
 *
 * The first pass got this backwards: land, parks, built-up areas and water
 * were all near-identical dark greens, and the roads were painted in the same
 * teal as the markers. The result read as "green on green on green with white
 * lines" — water was invisible against land, and the brewery pins had to
 * compete with a road network wearing their own colour.
 *
 * So three separations, in priority order:
 *
 *   1. HUE separates surfaces. Land is a near-neutral, water is genuinely
 *      blue, parks are genuinely green. You should never have to work out
 *      which one you're looking at.
 *   2. VALUE separates the road hierarchy. Roads are grey at varying
 *      lightness, never chromatic — a motorway is brighter than a lane, not
 *      a different colour.
 *   3. CHROMA is reserved. The only saturated things on this map are the
 *      brewery markers and the route line. Everything else gives way to them.
 */
const PALETTES: Record<MapTheme, Palette> = {
  light: {
    land: '#f2f5f4',
    water: '#c3d9e8',
    green: '#e2ece0',
    builtUp: '#e9eeed',
    building: '#dfe6e5',
    roadFill: '#ffffff',
    roadCasing: '#c9d3d5',
    motorway: '#ffffff',
    motorwayCasing: '#9aa8ab',
    boundary: '#aab8ba',
    label: '#142224',
    labelMinor: '#566768',
    halo: '#f2f5f4',
  },
  dark: {
    land: '#12181a',
    water: '#0b1d2b',
    green: '#151f1a',
    builtUp: '#171e20',
    building: '#1e2629',
    roadFill: '#454e52',
    roadCasing: '#10171a',
    motorway: '#6d787c',
    motorwayCasing: '#0f1618',
    boundary: '#3d4b4e',
    label: '#e8eef0',
    labelMinor: '#94a1a4',
    halo: '#12181a',
  },
};

/**
 * Stock POI and transit clutter. Our markers are the only points that matter.
 *
 * Aeroways go entirely: runways render as bright white X shapes that read as
 * a drawing error at city zoom, and nobody choosing a brewery is navigating by
 * taxiway.
 */
const DROP = /^(poi|airport|aeroway|building-3d|natural_earth)/;

function categorise(id: string): keyof Palette | 'drop' | null {
  if (DROP.test(id)) return 'drop';
  if (id === 'background') return 'land';
  if (/^water|waterway/.test(id) && !/label|name/.test(id)) return 'water';
  if (/landcover_(wood|grass|ice|wetland)|^park/.test(id)) return 'green';
  if (/^landuse/.test(id)) return 'builtUp';
  if (/^building/.test(id)) return 'building';
  if (/^boundary/.test(id)) return 'boundary';
  if (/motorway|trunk/.test(id)) return /casing/.test(id) ? 'motorwayCasing' : 'motorway';
  if (/^(road|bridge|tunnel)/.test(id)) return /casing/.test(id) ? 'roadCasing' : 'roadFill';
  return null;
}

/** Symbol layers are text; they take ink and a halo, not a fill. */
function isLabel(layer: LayerSpecification): boolean {
  return layer.type === 'symbol';
}

export function buildSurveyStyle(
  base: StyleSpecification,
  theme: MapTheme,
): StyleSpecification {
  const p = PALETTES[theme];

  const layers = base.layers
    .filter((layer) => categorise(layer.id) !== 'drop')
    .map((layer) => {
      // Structural clone — never mutate the cached base style, or the second
      // theme switch repaints an already-repainted map.
      const next = JSON.parse(JSON.stringify(layer)) as LayerSpecification;
      const paint = { ...((next as { paint?: Record<string, unknown> }).paint ?? {}) };

      if (isLabel(next)) {
        // Minor labels recede so town and city names carry the orientation.
        const minor = /poi|housenum|water_name|waterway|highway-name/.test(next.id);
        paint['text-color'] = minor ? p.labelMinor : p.label;
        paint['text-halo-color'] = p.halo;
        paint['text-halo-width'] = 1.4;
        // Shields are drawn from the sprite, which we no longer recolour;
        // dropping the icon keeps the road numbers as plain text.
        delete paint['icon-color'];
      } else {
        const role = categorise(next.id);
        const colour = role && role !== 'drop' ? p[role] : null;
        if (colour) {
          if (next.type === 'line') paint['line-color'] = colour;
          else if (next.type === 'fill') paint['fill-color'] = colour;
          else if (next.type === 'background') paint['background-color'] = colour;
          else if (next.type === 'fill-extrusion') paint['fill-extrusion-color'] = colour;
        }
        // Liberty outlines fills in stock green/blue; drop them and let the
        // fill carry the shape, which is quieter and reads better small.
        if (next.type === 'fill') delete paint['fill-outline-color'];
      }

      (next as { paint?: Record<string, unknown> }).paint = paint;
      return next;
    });

  return { ...base, layers };
}

const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
let cached: Promise<StyleSpecification> | null = null;

/** Fetched once per session; both themes are built from the same document. */
export function loadBaseStyle(): Promise<StyleSpecification> {
  cached ??= fetch(STYLE_URL).then((r) => r.json() as Promise<StyleSpecification>);
  return cached;
}
