/**
 * The brief's demo query, end to end: "Toronto to Kingston, hazy IPA fan."
 *
 * Ranks the corridor's breweries LEXICOGRAPHICALLY: claim tier for the queried
 * dimension first (A beats B; C/D are never style answers), then strength
 * (juried presence, ordinal language, evidence volume), then detour. A weakly
 * evidenced brewery never outranks a well-evidenced one on convenience —
 * reputation-strategy.md, "The ranking rule".
 *
 * HONESTY CONSTRAINTS built in:
 *  - closed breweries are excluded, with the exclusion printed
 *  - contested claims carry their flag into the output
 *  - breweries with no swept claims are listed as UNSWEPT, not ranked — the
 *    map may show them; the recommendation may not pretend to know them
 *  - every reason line cites its quote
 *
 * Geometry note: straight-line corridor with equirectangular distances — the
 * app's real route mode uses OSRM road geometry (lib/route.ts); this demo is
 * about the CLAIMS layer, so the simpler corridor is fine and is labelled.
 *
 *   node scripts/corridor-demo.mjs                       # Toronto→Kingston, hazy-ipa
 *   node scripts/corridor-demo.mjs kingston toronto sour # any direction/style
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY = path.join(here, '..', 'data', 'registry.json');
const TIERS = path.join(here, '..', 'data', 'claims', 'tiers.json');
// NOT in data/claims/ — that directory is the tier scanner's input glob.
const OUT = path.join(here, '..', 'data', 'corridor-demo.json');

const PLACES = {
  toronto: { lat: 43.6532, lng: -79.3832 },
  kingston: { lat: 44.2312, lng: -76.4860 },
  barrie: { lat: 44.3894, lng: -79.6903 },
  ottawa: { lat: 45.4215, lng: -75.6972 },
};

const [fromArg = 'toronto', toArg = 'kingston', styleArg = 'hazy-ipa'] = process.argv.slice(2);
const DIM = `beer.style.${styleArg}`;
const DETOUR_CAP_KM = 25;

/** Equirectangular projection around the corridor's mid-latitude. */
function projector(a, b) {
  const midLat = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const kmLat = 110.574;
  const kmLng = 111.32 * Math.cos(midLat);
  return (p) => ({ x: p.lng * kmLng, y: p.lat * kmLat });
}

/** Distance from the corridor and progress along it, both in km. */
function corridorPosition(project, a, b, p) {
  const A = project(a), B = project(b), P = project(p);
  const dx = B.x - A.x, dy = B.y - A.y;
  const len2 = dx * dx + dy * dy;
  const t = Math.max(0, Math.min(1, ((P.x - A.x) * dx + (P.y - A.y) * dy) / len2));
  const cx = A.x + t * dx, cy = A.y + t * dy;
  return { detourKm: Math.hypot(P.x - cx, P.y - cy), along: t };
}

/** Strength inside a tier: juried > ordinal language > evidence volume. */
function strength(dim) {
  let s = 0;
  if (dim.juried) s += dim.juriedStale ? 1.5 : 3;
  if (dim.ordinal) s += 2;
  s += Math.min(2, (dim.evidence ?? 0) * 0.4);
  s += Math.min(1, (dim.verifiedQuotes ?? 0) * 0.5);
  if (dim.contested) s -= 1;
  return Number(s.toFixed(2));
}

async function main() {
  const from = PLACES[fromArg], to = PLACES[toArg];
  if (!from || !to) throw new Error(`unknown place; know: ${Object.keys(PLACES).join(', ')}`);
  const registry = JSON.parse(await readFile(REGISTRY, 'utf8')).breweries;
  const { tiers } = JSON.parse(await readFile(TIERS, 'utf8'));
  const byRegistryId = new Map(
    Object.entries(tiers).filter(([, t]) => t.registryId).map(([e, t]) => [t.registryId, { entity: e, ...t }]),
  );

  const project = projector(from, to);
  const excluded = [];
  const candidates = [];
  for (const b of registry) {
    if (!Number.isFinite(b.lat) || !Number.isFinite(b.lng)) continue;
    const pos = corridorPosition(project, from, to, { lat: b.lat, lng: b.lng });
    if (pos.detourKm > DETOUR_CAP_KM) continue;
    if (b.status === 'closed') { excluded.push(`${b.name} — closed`); continue; }
    if ((b.venue?.isBrewery === false)) { excluded.push(`${b.name} — not a brewery`); continue; }
    candidates.push({ b, pos, swept: byRegistryId.get(b.id) ?? null });
  }

  const ranked = [];
  const unswept = [];
  for (const c of candidates) {
    const dim = c.swept?.dims?.[DIM];
    if (!c.swept) { unswept.push(c); continue; }
    if (!dim || !['A', 'B'].includes(dim.tier)) continue; // C/D never answer a style query
    ranked.push({ ...c, dim, strength: strength(dim) });
  }
  ranked.sort((x, y) =>
    x.dim.tier !== y.dim.tier ? x.dim.tier.localeCompare(y.dim.tier)
    : y.strength !== x.strength ? y.strength - x.strength
    : x.pos.detourKm - y.pos.detourKm);

  // The crawl: the ranked stops, replayed in driving order.
  const crawl = [...ranked].sort((x, y) => x.pos.along - y.pos.along);

  const line = '─'.repeat(64);
  console.log(`\n${line}\n  ${fromArg.toUpperCase()} → ${toArg.toUpperCase()}  ·  ${styleArg}  ·  detour cap ${DETOUR_CAP_KM} km`);
  console.log(`  straight-line corridor (demo); the app uses OSRM road geometry\n${line}`);
  console.log(`\nRANKED — tier, then strength, then detour:`);
  ranked.forEach((r, i) => {
    console.log(`\n  ${i + 1}. ${r.b.name}  [${r.dim.tier}${r.dim.contested ? ' contested' : ''}]  str ${r.strength}  detour ${r.pos.detourKm.toFixed(1)} km  (${r.b.city || '—'})`);
    if (r.dim.juried) console.log(`     medal: ${r.dim.juried}${r.dim.juriedStale ? '  (stale — decayed)' : ''}`);
    if (r.dim.ordinal) console.log(`     ordinal: ${r.dim.ordinal}`);
  });
  if (!ranked.length) console.log('  (nothing on this corridor holds A/B evidence for this style — say so, recommend nothing)');

  console.log(`\nTHE CRAWL, in driving order:`);
  crawl.forEach((r) => console.log(`  ${(r.pos.along * 100).toFixed(0).padStart(3)}%  ${r.b.name}  [${r.dim.tier}]`));

  console.log(`\nHONESTY LEDGER:`);
  console.log(`  swept but no A/B ${styleArg} claim: ${candidates.filter(c => c.swept && !ranked.find(r => r.b.id === c.b.id)).map(c => c.b.name).join(', ') || 'none'}`);
  console.log(`  on the corridor, UNSWEPT (${unswept.length}): shown on the map, not ranked — the production sweep's to-do`);
  for (const u of unswept.slice(0, 12)) console.log(`     · ${u.b.name} (${u.b.city || '—'})`);
  if (unswept.length > 12) console.log(`     … and ${unswept.length - 12} more`);
  if (excluded.length) console.log(`  excluded: ${excluded.join('; ')}`);

  await writeFile(OUT, JSON.stringify({
    generatedAt: new Date().toISOString().slice(0, 10),
    query: { from: fromArg, to: toArg, style: styleArg, detourCapKm: DETOUR_CAP_KM, geometry: 'straight-line demo' },
    ranked: ranked.map((r, i) => ({
      rank: i + 1, name: r.b.name, id: r.b.id, city: r.b.city, tier: r.dim.tier,
      contested: r.dim.contested ?? false, strength: r.strength,
      detourKm: Number(r.pos.detourKm.toFixed(1)), along: Number(r.pos.along.toFixed(3)),
      juried: r.dim.juried ?? null, ordinal: r.dim.ordinal ?? null,
    })),
    unswept: unswept.map((u) => ({ name: u.b.name, id: u.b.id, city: u.b.city })),
    excluded,
  }, null, 1) + '\n');
  console.log(`\nWrote ${path.relative(process.cwd(), OUT)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
