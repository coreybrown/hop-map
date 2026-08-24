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
 * Roads read as ink-on-paper rather than as coloured ribbons: the hierarchy
 * comes from width and from the casing contrast, which is how a survey sheet
 * separates a highway from a lane without shouting in yellow.
 */
const PALETTES: Record<MapTheme, Palette> = {
  light: {
    land: '#e9f3ee', // --map-bg
    water: '#cfe3e0',
    green: '#dceadf',
    builtUp: '#e2ece8',
    building: '#d9e5e1',
    roadFill: '#ffffff',
    roadCasing: '#ccd7d6', // --line
    // Deliberately NOT the accent. Accent belongs to the route overlay alone —
    // painting every highway copper made the road you're actually driving
    // indistinguishable from every other highway on screen.
    motorway: '#ffffff',
    motorwayCasing: '#8fa3a2',
    boundary: '#acbbba', // --line-strong
    label: '#142224', // --ink
    labelMinor: '#566768', // --muted
    halo: '#e9f3ee',
  },
  dark: {
    land: '#061615', // --map-bg
    water: '#03100f',
    green: '#0a1c19',
    builtUp: '#0a1a1a',
    building: '#122426',
    roadFill: '#33474a',
    roadCasing: '#0d1c1e',
    motorway: '#5b7276',
    motorwayCasing: '#16302f',
    boundary: '#3b4b4d', // --line-strong
    label: '#eaf0f0', // --ink
    labelMinor: '#8f9b9c', // --muted
    halo: '#061615',
  },
};

/** Stock POI and transit clutter. Our markers are the only points that matter. */
const DROP = /^(poi|airport|aeroway_taxiway|building-3d|natural_earth)/;

function categorise(id: string): keyof Palette | 'drop' | null {
  if (DROP.test(id)) return 'drop';
  if (id === 'background') return 'land';
  if (/^water|waterway/.test(id) && !/label|name/.test(id)) return 'water';
  if (/landcover_(wood|grass|ice|wetland)|^park/.test(id)) return 'green';
  if (/^landuse|aeroway_fill/.test(id)) return 'builtUp';
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
