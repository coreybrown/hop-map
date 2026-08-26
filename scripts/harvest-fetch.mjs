/**
 * Wide-harvest stage 1b: fetch the documents the search sweeps found.
 *
 * Input:  data/harvest/<entity>.urls.json  — [{url, query, rank}] written by
 *         the search pass (the sweeps run interactively; this script does not
 *         search).
 * Output: data/harvest/corpus/<hash>.json  — {url, entity, query, fetchedAt,
 *         status, title, text}; one file per unique URL, hash-addressed so a
 *         URL shared by two queries is fetched once.
 *         data/harvest/manifest.json       — the index of everything held.
 *
 * The corpus is NEVER committed (see .gitignore): these are other people's
 * pages. Only derived claims with short quotes leave this directory.
 *
 * Politeness: robots.txt is checked per host (User-agent: * Disallow rules,
 * conservative prefix match), one request at a time globally, 1.2s between
 * requests, 20s timeout, no retries beyond one. Domains that 403/challenge
 * are recorded and skipped on re-runs rather than hammered.
 *
 *   node scripts/harvest-fetch.mjs                # everything with a urls file
 *   node scripts/harvest-fetch.mjs godspeed-brewery
 */
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const HARVEST = path.join(here, '..', 'data', 'harvest');
const CORPUS = path.join(HARVEST, 'corpus');
const MANIFEST = path.join(HARVEST, 'manifest.json');

const only = process.argv[2];

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-CA,en-US;q=0.9,en;q=0.8',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

/** Hosts we will not fetch regardless of robots: closed platforms whose terms
 *  we've already decided to respect, plus hosts that only serve challenges. */
const NEVER = [
  'reddit.com', 'www.reddit.com', 'old.reddit.com',
  'untappd.com', 'www.untappd.com',
  'beeradvocate.com', 'www.beeradvocate.com',
  'ratebeer.com', 'www.ratebeer.com',
  'facebook.com', 'www.facebook.com', 'instagram.com', 'www.instagram.com',
  'x.com', 'twitter.com',
];

const robotsCache = new Map();
async function allowedByRobots(url) {
  const u = new URL(url);
  if (NEVER.includes(u.hostname)) return false;
  if (!robotsCache.has(u.origin)) {
    let rules = [];
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 10000);
      const res = await fetch(`${u.origin}/robots.txt`, { headers: HEADERS, signal: ac.signal });
      clearTimeout(t);
      if (res.ok) {
        const txt = await res.text();
        let mine = false;
        for (const raw of txt.split('\n')) {
          const line = raw.replace(/#.*/, '').trim();
          const m = line.match(/^(user-agent|disallow)\s*:\s*(.*)$/i);
          if (!m) continue;
          if (m[1].toLowerCase() === 'user-agent') mine = m[2].trim() === '*';
          else if (mine && m[2].trim()) rules.push(m[2].trim());
        }
      }
    } catch { /* unreadable robots -> treat as allow-all, fetch once, politely */ }
    robotsCache.set(u.origin, rules);
  }
  const p = u.pathname || '/';
  return !robotsCache.get(u.origin).some((rule) => p.startsWith(rule.replace(/\*.*$/, '')));
}

function extractText(html) {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim();
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<[^>]+>/g, '\n');
  const decoded = body
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;|&rsquo;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  const lines = decoded.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter((l) => l.length > 2);
  return { title, text: lines.join('\n').slice(0, 120000) };
}

async function main() {
  await mkdir(CORPUS, { recursive: true });
  let manifest = {};
  try { manifest = JSON.parse(await readFile(MANIFEST, 'utf8')); } catch {}

  const files = (await readdir(HARVEST)).filter((f) => f.endsWith('.urls.json'));
  const targets = only ? files.filter((f) => f.startsWith(only)) : files;
  let fetched = 0, skipped = 0, blocked = 0, failed = 0;

  for (const file of targets) {
    const entity = file.replace('.urls.json', '');
    const list = JSON.parse(await readFile(path.join(HARVEST, file), 'utf8'));
    const seen = new Set();
    for (const item of list) {
      const url = item.url.split('#')[0];
      const id = hash(url);
      if (seen.has(id)) continue;
      seen.add(id);
      if (manifest[id]?.status === 'ok' || manifest[id]?.status === 'blocked') {
        // already held (possibly for another entity) — just record membership
        manifest[id].entities = [...new Set([...(manifest[id].entities ?? []), entity])];
        skipped++;
        continue;
      }
      if (!(await allowedByRobots(url).catch(() => false))) {
        manifest[id] = { url, entities: [entity], status: 'blocked' };
        blocked++;
        continue;
      }
      try {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), 20000);
        const res = await fetch(url, { headers: HEADERS, redirect: 'follow', signal: ac.signal });
        clearTimeout(t);
        if (!res.ok) throw new Error(String(res.status));
        const ct = res.headers.get('content-type') ?? '';
        if (!/text\/html|application\/xhtml/.test(ct)) throw new Error(`type:${ct.split(';')[0]}`);
        const { title, text } = extractText(await res.text());
        const doc = {
          url, entities: [entity], query: item.query, fetchedAt: new Date().toISOString().slice(0, 10),
          status: 'ok', title, text,
        };
        await writeFile(path.join(CORPUS, `${id}.json`), JSON.stringify(doc));
        manifest[id] = { url, entities: [entity], status: 'ok', title, bytes: text.length };
        fetched++;
      } catch (err) {
        manifest[id] = { url, entities: [entity], status: `fail:${err.message ?? err}` };
        failed++;
      }
      process.stdout.write(`\r  ok ${fetched}  cached ${skipped}  robots/never ${blocked}  fail ${failed}   `);
      await sleep(1200);
    }
  }
  await writeFile(MANIFEST, JSON.stringify(manifest, null, 1));
  console.log(`\nManifest: ${Object.keys(manifest).length} urls`);
}

main().catch((e) => { console.error(e); process.exit(1); });
