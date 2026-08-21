import type { Brewery, ScoredBrewery } from '@/lib/types';
import { PLACES } from '@/lib/data';

/**
 * The map, drawn as a survey plot rather than a slippy map.
 *
 * A Google-style tile map would fight the design and drag in a tile provider,
 * a licence and a client-side map library for something this page can express
 * with geometry it already has. The Survey direction was built for exactly
 * this — `--map-bg` and `--grid` have been sitting in globals.css unused,
 * described there as "the faint survey grid beneath the map".
 *
 * So: inline SVG, server-rendered, no dependencies, no JavaScript, no tiles.
 * Orientation comes from labelled control points (the cities people actually
 * name) rather than from coastline, which is how a survey sheet works.
 *
 * Every marker is an anchor into its row in the list below, so the map is a
 * navigation control and not decoration.
 */

/**
 * A deliberately small coordinate space. The SVG scales to its container, so
 * a tighter viewBox makes every marker proportionally larger — at 335px wide
 * on a phone, an 800-unit box rendered the badges at ~4.6px, too small to read
 * or tap. This gets them to roughly 8px.
 *
 * The map is still an overview on a phone; the list remains the primary
 * interaction there.
 */
const W = 640;
const H = 400;
const PAD = 38;

interface Point {
  lat: number;
  lng: number;
}

/**
 * Equirectangular with a cosine correction on x. Ontario spans ~4° of latitude
 * in the populated south, where an unprojected plot stretches noticeably
 * east-west; the correction is one multiply and removes the distortion.
 */
function makeProjection(points: Point[]) {
  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);

  let minLat = Math.min(...lats);
  let maxLat = Math.max(...lats);
  let minLng = Math.min(...lngs);
  let maxLng = Math.max(...lngs);

  // A single-brewery result would otherwise divide by zero.
  const padLat = Math.max((maxLat - minLat) * 0.12, 0.15);
  const padLng = Math.max((maxLng - minLng) * 0.12, 0.2);
  minLat -= padLat;
  maxLat += padLat;
  minLng -= padLng;
  maxLng += padLng;

  const meanLat = ((minLat + maxLat) / 2) * (Math.PI / 180);
  const kx = Math.cos(meanLat);

  const spanX = (maxLng - minLng) * kx;
  const spanY = maxLat - minLat;

  // Preserve aspect ratio: fit the wider dimension, centre the other.
  const scale = Math.min((W - PAD * 2) / spanX, (H - PAD * 2) / spanY);
  const offsetX = (W - spanX * scale) / 2;
  const offsetY = (H - spanY * scale) / 2;

  return (p: Point) => ({
    x: offsetX + (p.lng - minLng) * kx * scale,
    y: offsetY + (maxLat - p.lat) * scale,
  });
}

export function SurveyMap({
  results,
  all,
  origin,
  destination,
  label,
}: {
  results: ScoredBrewery[];
  all: Brewery[];
  origin?: string;
  destination?: string;
  label: string;
}) {
  const originPt = origin ? PLACES[origin] : undefined;
  const destPt = destination ? PLACES[destination] : undefined;

  // Frame on what the answer actually contains, plus the trip's endpoints —
  // not on the whole province, which would shrink every result to a speck.
  const framing: Point[] = [
    ...results.map((r) => ({ lat: r.brewery.lat!, lng: r.brewery.lng! })),
    ...(originPt ? [originPt] : []),
    ...(destPt ? [destPt] : []),
  ].filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));

  if (framing.length === 0) return null;

  const project = makeProjection(framing);
  const shown = results.slice(0, 20);
  const shownIds = new Set(shown.map((r) => r.brewery.id));

  // Context dots: every other brewery that happens to fall inside the frame.
  // They say "this is a real place with more in it" without competing.
  const context = all
    .filter((b) => !shownIds.has(b.id) && Number.isFinite(b.lat) && Number.isFinite(b.lng))
    .map((b) => ({ b, p: project({ lat: b.lat!, lng: b.lng! }) }))
    .filter(({ p }) => p.x > 4 && p.x < W - 4 && p.y > 4 && p.y < H - 4);

  const o = originPt ? project(originPt) : null;
  const d = destPt ? project(destPt) : null;

  /**
   * Displace overlapping markers, and draw a hairline back to the true point.
   *
   * Fifteen of twenty results for a Kingston→Toronto search are IN Toronto, so
   * at this framing they land on nearly the same pixel and the map turns to
   * mush — 59 pairwise collisions before this. Jittering positions silently
   * would be a lie on a map that calls itself a survey; a leader line is the
   * cartographic answer, and it is honest: the dot stays where the brewery is,
   * the badge moves only as far as it must, and the line ties them together.
   *
   * Placement spirals outward so displacement stays as small as possible.
   */
  const R = 14;
  const placed: { x: number; y: number }[] = [];
  const markers = shown.map((r, i) => {
    const truePt = project({ lat: r.brewery.lat!, lng: r.brewery.lng! });
    let pos = truePt;
    for (let step = 0; step < 60; step++) {
      const clash = placed.some(
        (q) => Math.hypot(q.x - pos.x, q.y - pos.y) < R * 2 + 3,
      );
      if (!clash) break;
      // Golden-angle spiral: even coverage, no preferred direction.
      const angle = step * 2.399963;
      const radius = R * 1.9 * Math.sqrt(step + 1) * 0.8;
      pos = {
        x: Math.min(W - R - 2, Math.max(R + 2, truePt.x + Math.cos(angle) * radius)),
        y: Math.min(H - R - 2, Math.max(R + 2, truePt.y + Math.sin(angle) * radius)),
      };
    }
    placed.push(pos);
    return { result: r, index: i, truePt, pos, displaced: Math.hypot(pos.x - truePt.x, pos.y - truePt.y) > 1 };
  });

  return (
    <figure className="survey-grid-bg overflow-hidden rounded-survey-lg border border-line">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="block h-auto w-full"
        role="img"
        aria-label={`Map of ${shown.length} recommended breweries for ${label}`}
      >
        {/* The corridor, dotted — the wayfinding language of the design. */}
        {o && d && (
          <>
            <line
              x1={o.x}
              y1={o.y}
              x2={d.x}
              y2={d.y}
              stroke="var(--accent)"
              strokeWidth={1.5}
              strokeDasharray="5 5"
              opacity={0.75}
            />
            <CityMark x={o.x} y={o.y} label={PLACES[origin!].label} />
            <CityMark x={d.x} y={d.y} label={PLACES[destination!].label} />
          </>
        )}

        {/* Anchor mode: one control point, with its search radius implied. */}
        {!o && d && <CityMark x={d.x} y={d.y} label={PLACES[destination!].label} />}

        {context.map(({ b, p }) => (
          <circle key={b.id} cx={p.x} cy={p.y} r={2.5} fill="var(--line-strong)" opacity={0.55}>
            <title>{b.name}</title>
          </circle>
        ))}

        {/* Leader lines first, so badges sit on top of them. */}
        {markers
          .filter((m) => m.displaced)
          .map((m) => (
            <g key={`lead-${m.result.brewery.id}`}>
              <line
                x1={m.truePt.x}
                y1={m.truePt.y}
                x2={m.pos.x}
                y2={m.pos.y}
                stroke="var(--line-strong)"
                strokeWidth={0.75}
              />
              <circle cx={m.truePt.x} cy={m.truePt.y} r={1.75} fill="var(--line-strong)" />
            </g>
          ))}

        {markers.map(({ result: r, index: i, pos: p }) => {
          const known = r.brewery.styles.knownFor.length > 0;
          return (
            <a key={r.brewery.id} href={`#stop-${i + 1}`}>
              <circle
                cx={p.x}
                cy={p.y}
                r={R}
                fill={known ? 'var(--accent)' : 'var(--surface-raised)'}
                stroke={known ? 'var(--accent)' : 'var(--primary)'}
                strokeWidth={1.5}
              />
              <text
                x={p.x}
                y={p.y}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={12}
                fontWeight={600}
                fill={known ? 'var(--on-accent)' : 'var(--primary)'}
                style={{ fontFamily: 'var(--font-plex-mono), ui-monospace, monospace' }}
              >
                {i + 1}
              </text>
              <title>
                {r.brewery.name}
                {r.brewery.city ? ` — ${r.brewery.city}` : ''}
              </title>
            </a>
          );
        })}
      </svg>

      <figcaption className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line bg-surface px-3 py-2 text-xs text-muted">
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-2.5 rounded-full bg-accent" aria-hidden="true" />
          Reputation evidence
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block size-2.5 rounded-full border border-primary"
            aria-hidden="true"
          />
          Matched on what they stock
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-1.5 rounded-full bg-line-strong" aria-hidden="true" />
          Other breweries nearby
        </span>
      </figcaption>
    </figure>
  );
}

/** A labelled control point — the town you named, not a brewery. */
function CityMark({ x, y, label }: { x: number; y: number; label: string }) {
  return (
    <g>
      <line x1={x - 7} y1={y} x2={x + 7} y2={y} stroke="var(--ink)" strokeWidth={1.25} />
      <line x1={x} y1={y - 7} x2={x} y2={y + 7} stroke="var(--ink)" strokeWidth={1.25} />
      <text
        x={x}
        y={y - 12}
        textAnchor="middle"
        fontSize={12}
        fontWeight={600}
        fill="var(--ink)"
        letterSpacing="0.04em"
        style={{ fontFamily: 'var(--font-plex-mono), ui-monospace, monospace' }}
      >
        {label.toUpperCase()}
      </text>
    </g>
  );
}
