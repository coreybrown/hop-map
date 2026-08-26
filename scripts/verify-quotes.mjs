/**
 * Wide-harvest stage 2b: verify claims against the fetched corpus.
 *
 * Claims were extracted at the SEARCH layer, which paraphrases. This pass
 * checks each claim's quote against the actual fetched documents and, where
 * the text is really there, attaches the verbatim line and flips
 * quoteVerified. Non-destructive: the recorded quote is kept as-is so the
 * extraction stays auditable; `verbatim` carries what the page actually says.
 *
 * Matching is fragment-based: the quote is split on ellipses/semicolons and a
 * fragment counts as found when its normalized 6-word shingles appear in the
 * normalized document. A claim verifies when >= half its fragments are found
 * in ONE document (the strongest doc wins).
 *
 *   node scripts/verify-quotes.mjs           # report + write
 *   node scripts/verify-quotes.mjs --dry     # report only
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLAIMS = path.join(here, '..', 'data', 'claims');
const CORPUS = path.join(here, '..', 'data', 'harvest', 'corpus');
const MANIFEST = path.join(here, '..', 'data', 'harvest', 'manifest.json');
const DRY = process.argv.includes('--dry');

const norm = (s) =>
  s.toLowerCase()
   .replace(/[‘’']/g, '')
   .replace(/[“”"]/g, '')
   .replace(/[^a-z0-9\s]/g, ' ')
   .replace(/\s+/g, ' ')
   .trim();

/** 6-word shingles; short fragments fall back to the whole fragment. */
function shingles(fragment) {
  const w = norm(fragment).split(' ').filter(Boolean);
  if (w.length <= 6) return w.length >= 3 ? [w.join(' ')] : [];
  const out = [];
  for (let i = 0; i + 6 <= w.length; i += 3) out.push(w.slice(i, i + 6).join(' '));
  return out;
}

function findVerbatim(docText, fragment) {
  const target = shingles(fragment);
  if (!target.length) return null;
  const nDoc = norm(docText);
  const hit = target.filter((s) => nDoc.includes(s));
  if (hit.length / target.length < 0.5) return null;
  // Pull the surrounding original line for the first matched shingle.
  const firstWords = hit[0].split(' ').slice(0, 3).join(' ');
  const lines = docText.split('\n');
  const line = lines.find((l) => norm(l).includes(hit[0])) ??
               lines.find((l) => norm(l).includes(firstWords));
  return line ? line.trim().slice(0, 300) : '(matched, line spans breaks)';
}

async function main() {
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
  const byEntity = {};
  for (const [id, m] of Object.entries(manifest)) {
    if (m.status !== 'ok') continue;
    for (const e of m.entities ?? []) (byEntity[e] ??= []).push(id);
  }
  const docCache = new Map();
  const getDoc = async (id) => {
    if (!docCache.has(id))
      docCache.set(id, JSON.parse(await readFile(path.join(CORPUS, `${id}.json`), 'utf8')));
    return docCache.get(id);
  };

  let flipped = 0, unmatched = 0, already = 0;
  for (const file of (await readdir(CLAIMS)).filter((f) => f.endsWith('.json') && !f.startsWith('corrections') && f !== 'tiers.json')) {
    const p = path.join(CLAIMS, file);
    const doc = JSON.parse(await readFile(p, 'utf8'));
    const entity = doc.entity;
    const docIds = byEntity[entity] ?? [];
    const walk = async (claim) => {
      if (claim.claims) { for (const c of claim.claims) await walk(c); return; }
      if (!claim.quote) return;
      if (claim.quoteVerified === true) { already++; return; }
      const fragments = claim.quote.split(/…|\.\.\.|;/).map((f) => f.trim()).filter((f) => f.length > 15);
      let best = null;
      for (const id of docIds) {
        const d = await getDoc(id);
        const found = fragments
          .map((f) => ({ f, line: findVerbatim(d.text, f) }))
          .filter((x) => x.line);
        if (found.length && (!best || found.length > best.found.length))
          best = { url: d.url, found };
      }
      if (best && best.found.length >= Math.max(1, Math.ceil(fragments.length / 2))) {
        claim.quoteVerified = true;
        claim.verbatim = { url: best.url, lines: best.found.map((x) => x.line) };
        flipped++;
        console.log(`  ✓ ${entity} :: ${claim.dimension ?? '(sub)'}\n      ${best.found[0].line.slice(0, 110)}`);
      } else {
        unmatched++;
        console.log(`  ✗ ${entity} :: ${claim.dimension ?? '(sub)'} — not found in ${docIds.length} docs`);
      }
    };
    for (const c of doc.claims ?? []) await walk(c);
    for (const c of doc.counter_evidence ?? []) await walk(c);
    if (!DRY) await writeFile(p, `${JSON.stringify(doc, null, 1)}\n`);
  }
  console.log(`\nverified ${flipped} · already ${already} · unmatched ${unmatched}${DRY ? '  (dry run, nothing written)' : ''}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
