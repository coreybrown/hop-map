/**
 * Reddit threads where people ask each other where to go for a style of beer.
 *
 * WHY THIS SOURCE. Awards gave us 25 breweries with `knownFor` and then hit a
 * hard ceiling: only 41 Ontario breweries have ever medaled, because entering
 * costs money and the most-discussed breweries don't bother. Bellwoods,
 * Godspeed, Blood Brothers, Left Field and Halo have zero medals between them.
 * Reddit is the only proposed source that reaches them, which makes it
 * load-bearing rather than supplementary.
 *
 * WHAT WE ASK FOR. Not brewery names — recommendation-seeking threads. "Best
 * lager in Ontario" pulls a post whose entire comment section is people naming
 * breweries for a specific style, unprompted. That is as close to "what would
 * a knowledgeable local say first" as a public source gets, and it is exactly
 * the definition `knownFor` carries in types.ts.
 *
 * HOW IT IS COUNTED — see classify-reputation.mjs. Distinct AUTHORS across
 * distinct THREADS, never raw mentions. Raw counts measure hype, thread size
 * and population; one enthusiast posting six times, or a brewery astroturfing
 * its own name, would otherwise outrank a genuine consensus.
 *
 * CREDENTIALS. Reddit blocks unauthenticated JSON entirely (403 on every
 * endpoint since 2023), so this needs a free registered app:
 *
 *   1. https://www.reddit.com/prefs/apps  →  "create another app..."
 *   2. Choose type "script". Redirect URI can be http://localhost:8080
 *   3. export REDDIT_CLIENT_ID=<the id under the app name>
 *      export REDDIT_CLIENT_SECRET=<the secret>
 *
 * Only those two are needed — this uses application-only OAuth, so it never
 * sees or wants an account password, and it only ever reads public posts.
 *
 *   node scripts/fetch-reddit.mjs             # everything not yet cached
 *   node scripts/fetch-reddit.mjs --force     # re-fetch all
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, '..', 'data', 'reddit-threads.json');

const FORCE = process.argv.includes('--force');

const CLIENT_ID = process.env.REDDIT_CLIENT_ID;
const CLIENT_SECRET = process.env.REDDIT_CLIENT_SECRET;
const UA = 'script:ontario-beer-survey:0.1 (by /u/ontariobeersurvey)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Where Ontario beer is actually discussed. City subs matter as much as the
 * beer subs — and more for the regions our coverage is thinnest in. Ottawa
 * Valley has 62 breweries and 3 with any reputation data, so r/ottawa is
 * worth more here than r/CraftBeer.
 */
const SUBREDDITS = [
  'ontariobeer',
  'TheOntarioBeerScene',
  'CraftBeerOntario',
  'toronto',
  'askTO',
  'ottawa',
  'kingston',
  'HamiltonOntario',
  'londonontario',
  'waterloo',
  'kitchener',
  'windsorontario',
  'ontario',
];

/**
 * Style-seeking queries. Each names a style the taxonomy holds, because a
 * thread about "best patio" tells us about venues and nothing about beer.
 */
const QUERIES = [
  'best lager', 'best pilsner', 'best IPA', 'best hazy IPA', 'best west coast IPA',
  'best stout', 'best porter', 'best sour beer', 'best saison', 'best pale ale',
  'best kolsch', 'best non alcoholic beer', 'best amber ale', 'best wheat beer',
  'best barrel aged', 'best brewery for lagers', 'best brewery for sours',
  'brewery recommendations', 'favourite Ontario brewery', 'favorite Ontario brewery',
  'underrated brewery', 'best brewery in Ontario',
];

async function token() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error(
      'REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET are not set — see the header of this file',
    );
  }
  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`auth HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const json = await res.json();
  if (!json.access_token) throw new Error('no access_token in response');
  return json.access_token;
}

async function api(url, tok) {
  // Reddit's documented limit is 100 requests/minute for OAuth clients. One
  // request per second stays comfortably under it without needing backoff.
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${tok}`, 'User-Agent': UA },
    signal: AbortSignal.timeout(25_000),
  });
  if (res.status === 429) {
    await sleep(15_000);
    return api(url, tok);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Search one subreddit for one query, newest-relevant first. */
async function search(sub, query, tok) {
  const url =
    `https://oauth.reddit.com/r/${sub}/search?` +
    new URLSearchParams({
      q: query,
      restrict_sr: '1',
      sort: 'relevance',
      t: 'all',
      limit: '25',
    });
  const json = await api(url, tok);
  return (json?.data?.children ?? [])
    .map((c) => c.data)
    .filter((p) => p && !p.over_18)
    .map((p) => ({
      id: p.id,
      subreddit: p.subreddit,
      title: p.title,
      selftext: (p.selftext ?? '').slice(0, 4000),
      author: p.author,
      score: p.score,
      numComments: p.num_comments,
      createdUtc: p.created_utc,
      permalink: p.permalink,
      matchedQuery: query,
    }));
}

/** Every comment on a post, flattened. The comments ARE the data. */
async function comments(sub, postId, tok) {
  const json = await api(
    `https://oauth.reddit.com/r/${sub}/comments/${postId}?limit=500&depth=6`,
    tok,
  );
  const out = [];
  const walk = (node) => {
    if (!node) return;
    const children = node?.data?.children ?? [];
    for (const c of children) {
      if (c.kind !== 't1' || !c.data) continue;
      const d = c.data;
      if (d.body && d.author && d.author !== '[deleted]') {
        out.push({
          id: d.id,
          author: d.author,
          body: d.body.slice(0, 3000),
          score: d.score ?? 0,
          createdUtc: d.created_utc,
        });
      }
      if (d.replies) walk(d.replies);
    }
  };
  if (Array.isArray(json)) json.forEach(walk);
  return out;
}

async function main() {
  const cached =
    existsSync(OUT) && !FORCE ? JSON.parse(await readFile(OUT, 'utf8')).threads : {};

  const tok = await token();
  console.log('authenticated (application-only, read-only)\n');

  const threads = { ...cached };
  let searched = 0;
  let fetched = 0;
  let skipped = 0;

  for (const sub of SUBREDDITS) {
    for (const query of QUERIES) {
      let posts = [];
      try {
        posts = await search(sub, query, tok);
        searched++;
      } catch (err) {
        console.log(`  r/${sub} "${query}" — ${String(err.message).slice(0, 40)}`);
        await sleep(1000);
        continue;
      }

      for (const post of posts) {
        if (threads[post.id]) {
          skipped++;
          continue;
        }
        // A thread nobody answered carries no consensus to read.
        if (post.numComments < 3) continue;
        try {
          post.comments = await comments(sub, post.id, tok);
          threads[post.id] = post;
          fetched++;
          if (fetched % 10 === 0) {
            await writeFile(
              OUT,
              JSON.stringify(
                { generatedAt: new Date().toISOString(), count: Object.keys(threads).length, threads },
                null,
                2,
              ),
            );
          }
        } catch {
          /* skip this thread */
        }
        await sleep(1100);
      }
      console.log(
        `  r/${sub.padEnd(20)} "${query.slice(0, 28).padEnd(30)}" ${String(posts.length).padStart(3)} posts`,
      );
      await sleep(1100);
    }
  }

  await writeFile(
    OUT,
    JSON.stringify(
      { generatedAt: new Date().toISOString(), count: Object.keys(threads).length, threads },
      null,
      2,
    ),
  );

  const totalComments = Object.values(threads).reduce((n, t) => n + (t.comments?.length ?? 0), 0);
  console.log(`\n${searched} searches, ${fetched} new threads (${skipped} already cached).`);
  console.log(`${Object.keys(threads).length} threads, ${totalComments} comments total.`);
  console.log(`Wrote ${path.relative(process.cwd(), OUT)}`);
}

main().catch((err) => {
  console.error(`\n${err.message}\n`);
  process.exit(1);
});
