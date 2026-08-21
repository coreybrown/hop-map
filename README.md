# Hop Map

Find the Ontario breweries worth the detour — matched to the beer you actually
like, along your route or around where you're staying, **with the reasons why**.

Two shapes of one question:

- *"I'm in Toronto — where's a good lager?"*
- *"I'm driving Kingston to Toronto — what's worth stopping for?"*

## Why reasons instead of ratings

A star average can't tell you that a well-reviewed lager house is the wrong
stop for someone who wants a hazy IPA. So every recommendation shows its
working:

```
01  Burdock Brewery          Toronto            +9.0 km detour
    Known for  Pilsner & Lager
    · Wide range, but it's the Pilsner & Lager people go for
    · Also pours Hazy IPA
    Silver, European Style Lager (Pilsner), Canadian Brewing Awards 2022
```

That last line is the point. It's checkable.

## The rule the data follows

**No source, no label.** Two fields, never collapsed:

| Field | Means | From |
|---|---|---|
| `offers` | what they stock | catalog crawls |
| `knownFor` | what's worth the trip | blind-judged competition medals |

Only `knownFor` drives a recommendation, and only `knownFor` can do harm — a
confident wrong answer costs someone a real drive. So a brewery with reputation
evidence and one that merely stocks the style **do not look alike** in the UI,
and a result set with no reputation evidence says so plainly rather than
implying confidence it hasn't earned.

Right now that's 25 of 246 breweries. The interface is honest about it.

## Current coverage

| | |
|---|---|
| Breweries (active) | 246 |
| Geocoded | all |
| With `offers` | 104 |
| With `knownFor` | 25 |
| Harmful recommendations vs. held-out test set | **0** |

## How it's built

Next.js 16, React 19, Tailwind v4. No database, no runtime API calls — the
registry is static JSON refreshed by the scripts in `scripts/`. No accounts:
the trip encodes into the URL, so sharing a plan and saving one are the same
action.

```
scripts/fetch-osm-breweries.mjs   coverage + contact/hours from OpenStreetMap
scripts/fetch-awards.mjs          Canadian Brewing Awards medals -> knownFor
scripts/check-sites.mjs           which websites still belong to the brewery
scripts/fetch-store-catalogs.mjs  Shopify/Woo/Squarespace product APIs
scripts/render-catalogs.mjs       headless crawl for the rest
scripts/classify-styles.mjs       catalogs -> offers
scripts/build-registry.mjs        merge everything
scripts/score-styles.mjs          score against held-out answers
```

`data/corrections.json` holds human judgements that survive a rebuild — closed
breweries, and 18 records that turned out to be pubs rather than breweries.

## Status

Prototype. The data is incomplete by design rather than by accident, and the
interface says which parts are thin. Reputation coverage is the next
gap to close.

## Attribution

Contains data from OpenStreetMap contributors, licensed under
[ODbL](https://opendatacommons.org/licenses/odbl/). Competition results from
the Canadian Brewing Awards.
