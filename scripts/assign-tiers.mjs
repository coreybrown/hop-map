/**
 * Wide-harvest stage 3: confidence tiers from independent source classes,
 * scored against Corey's held-out ground truth.
 *
 * Tier is a function of how many INDEPENDENT third-party source classes
 * support a claim — never of how much evidence there is. Three community
 * threads are one class. (reputation-strategy.md, "Confidence tiers".)
 *
 *   A  2+ independent third-party classes agree
 *   B  exactly 1 third-party class
 *   C  self-reported / promotional only (self, retail, tourism-for-beer)
 *   D  nothing
 *
 * Class independence rules:
 *  - third-party for BEER dims:        juried, editorial, community
 *  - third-party for EXPERIENCE dims:  juried, editorial, community, tourism
 *  - never third-party:                self, retail
 * Tourism boards promote every member, so their word counts for what a place
 * is LIKE, not for whether the beer is good.
 *
 * Juried cross-check: beer.style claims are joined to the registry's
 * reputationEvidence (CBA 2014-2024 medal table). A matching medal adds the
 * juried class from OUR OWN parsed data rather than prose. Medals older than
 * 8 years are counted but flagged stale — recency work is still owed.
 *
 * Scoring (the pilot's whole point):
 *  - hit:      ground-truth goFor style at tier A/B
 *  - miss:     goFor style at C/D/absent (under-claiming is SAFE)
 *  - HARMFUL:  a notFor style reaching tier A/B with polarity 'for' —
 *              must be zero, same gate as score-styles.mjs
 *  - Bellweiser assertion: bellwoods pilsner-lager must land C or D.
 *    Retail copy calls it iconic; nobody drives to Ossington for a lager.
 *
 *   node scripts/assign-tiers.mjs
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLAIMS = path.join(here, '..', 'data', 'claims');
const REGISTRY = path.join(here, '..', 'data', 'registry.json');
const GT = path.join(here, '..', 'data', 'ground-truth.json');
const OUT = path.join(CLAIMS, 'tiers.json');

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function classesOf(sourceClass) {
  if (!sourceClass) return [];
  const out = new Set();
  for (const part of sourceClass.split('+')) {
    const p = part.trim();
    if (p.includes('pending')) { out.add('self'); continue; } // not juried until cross-checked
    if (p.startsWith('juried')) out.add('juried');
    else if (p.startsWith('editorial') || p === 'news') out.add('editorial');
    else if (p.startsWith('aggregator')) out.add('community');
    else if (p.startsWith('tourism')) out.add('tourism');
    else if (p.startsWith('retail')) out.add('retail');
    else if (p.startsWith('self')) out.add('self');
  }
  return [...out];
}

const isBeerDim = (d) => d.startsWith('beer.');
const THIRD_BEER = new Set(['juried', 'editorial', 'community']);
const THIRD_EXP = new Set(['juried', 'editorial', 'community', 'tourism']);

function tierFor(dim, classes) {
  const third = new Set(
    classes.filter((c) => (isBeerDim(dim) ? THIRD_BEER : THIRD_EXP).has(c)),
  );
  if (third.size >= 2) return 'A';
  if (third.size === 1) return 'B';
  return classes.length ? 'C' : 'D';
}

async function main() {
  const registry = JSON.parse(await readFile(REGISTRY, 'utf8')).breweries;
  const gt = JSON.parse(await readFile(GT, 'utf8')).breweries;

  const findReg = (entity, brand) =>
    registry.find((b) => b.id === entity) ??
    registry.find((b) => norm(entity).includes(norm(b.id)) || norm(b.id).includes(norm(entity).replace(/brewery|brewing|brew/g, ''))) ??
    registry.find((b) => norm(b.name) === norm(brand)) ??
    registry.find((b) => norm(brand).includes(norm(b.name)) || norm(b.name).includes(norm(brand)));

  const tiers = {};
  const files = (await readdir(CLAIMS)).filter(
    (f) => f.endsWith('.json') && !f.startsWith('corrections') && f !== 'tiers.json',
  );

  for (const file of files) {
    const doc = JSON.parse(await readFile(path.join(CLAIMS, file), 'utf8'));
    const reg = findReg(doc.entity, doc.brand);
    const dims = {};

    const collect = (claim) => {
      if (claim.claims) {
        /*
         * Conflict container. Contested is not the same as unsupported: the
         * FOR side still has witnesses, and dropping their classes tiered
         * Steam Whistle's pilsner at D as though nobody had ever praised it.
         * Harvest classes from the FOR sub-claims (falling back to the
         * container's sourceClass, which describes the mix) and let the
         * contested flag carry the disagreement into ranking.
         */
        const d = (dims[claim.dimension] ??= { classes: new Set(), polarity: [], contested: false, evidence: 0 });
        d.contested = true;
        for (const sub of claim.claims) {
          d.polarity.push(sub.polarity);
          d.evidence++;
          if (sub.polarity === 'for')
            for (const c of classesOf(sub.sourceClass ?? claim.sourceClass)) d.classes.add(c);
          if (sub.quoteVerified) d.verified = (d.verified ?? 0) + 1;
        }
        return;
      }
      if (!claim.dimension) return;
      const d = (dims[claim.dimension] ??= { classes: new Set(), polarity: [], contested: false, evidence: 0 });
      d.evidence++;
      d.polarity.push(claim.polarity);
      if (claim.polarity === 'for' || claim.polarity === 'tempered')
        for (const c of classesOf(claim.sourceClass)) d.classes.add(c);
      if (claim.ordinal) d.ordinal = claim.ordinal;
      if (claim.quoteVerified) d.verified = (d.verified ?? 0) + 1;
    };
    for (const c of doc.claims ?? []) collect(c);

    // Juried join from our own medal table.
    if (reg) {
      for (const ev of reg.reputationEvidence ?? []) {
        const dim = `beer.style.${ev.style}`;
        const d = (dims[dim] ??= { classes: new Set(), polarity: ['for'], contested: false, evidence: 0 });
        d.classes.add('juried');
        d.evidence++;
        const yr = Number((ev.detail.match(/\b(20\d\d)\b/) ?? [])[1]);
        d.juried = ev.detail;
        if (yr && yr < new Date().getFullYear() - 8) d.juriedStale = true;
      }
    }

    tiers[doc.entity] = {
      brand: doc.brand,
      registryId: reg?.id ?? null,
      status: reg?.status ?? 'unknown',
      dims: Object.fromEntries(
        Object.entries(dims).map(([dim, d]) => [dim, {
          tier: d.polarity.includes('against') && !d.polarity.includes('for') ? '—' : tierFor(dim, [...d.classes]),
          classes: [...d.classes].sort(),
          contested: d.contested || undefined,
          ordinal: d.ordinal || undefined,
          juried: d.juried || undefined,
          juriedStale: d.juriedStale || undefined,
          verifiedQuotes: d.verified || 0,
          evidence: d.evidence,
        }]),
      ),
    };
  }

  // ---- score against ground truth ----
  console.log('\n══ TIERS (beer style dims) ══');
  for (const [e, t] of Object.entries(tiers)) {
    const styleDims = Object.entries(t.dims).filter(([d]) => d.startsWith('beer.style.'));
    const s = styleDims.map(([d, v]) => `${d.replace('beer.style.', '')}:${v.tier}${v.contested ? '!' : ''}`).join('  ');
    console.log(`  ${e.padEnd(26)} ${t.status === 'closed' ? 'CLOSED — excluded from routing' : s || '(no style claims)'}`);
  }

  console.log('\n══ GROUND-TRUTH SCORE (pilot entities present in the held-out set) ══');
  let hits = 0, misses = 0, harmful = 0;
  const findGt = (entity) =>
    Object.entries(gt).find(([k]) => !k.startsWith('_') && (norm(entity).includes(norm(k)) || norm(k).includes(norm(entity).replace(/brewery|brewing|brew/g, ''))));
  for (const [e, t] of Object.entries(tiers)) {
    if (t.status === 'closed') continue;
    const g = findGt(e);
    if (!g) continue;
    const [gk, gv] = g;
    const rows = [];
    for (const s of gv.goFor ?? []) {
      const v = t.dims[`beer.style.${s}`];
      const ok = v && ['A', 'B'].includes(v.tier);
      if (ok) hits++; else misses++;
      rows.push(`${ok ? '✓' : '·'} goFor ${s}${v ? ` [${v.tier}]` : ' [absent]'}`);
    }
    for (const s of gv.notFor ?? []) {
      const v = t.dims[`beer.style.${s}`];
      const harm = v && ['A', 'B'].includes(v.tier) && !v.contested;
      if (harm) { harmful++; rows.push(`✗ HARMFUL notFor ${s} reached ${v.tier}`); }
      else rows.push(`✓ notFor ${s} stayed ${v ? v.tier : 'absent'}`);
    }
    console.log(`  ${e} (gt: ${gk})\n     ${rows.join('\n     ')}`);
  }

  const bell = tiers['bellwoods-brewery']?.dims['beer.style.pilsner-lager'];
  const bellPass = !bell || ['C', 'D'].includes(bell.tier);
  console.log('\n══ GATES ══');
  console.log(`  goFor hits          ${hits}`);
  console.log(`  goFor misses        ${misses}   (under-claiming — safe)`);
  console.log(`  HARMFUL             ${harmful}   ← must be 0`);
  console.log(`  Bellweiser test     ${bellPass ? `PASS (pilsner-lager: ${bell ? bell.tier : 'absent'})` : `FAIL (${bell.tier})`}`);
  if (harmful > 0 || !bellPass) process.exitCode = 1;

  await writeFile(OUT, `${JSON.stringify({ generatedAt: new Date().toISOString().slice(0, 10), tiers }, null, 1)}\n`);
  console.log(`\nWrote ${path.relative(process.cwd(), OUT)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
