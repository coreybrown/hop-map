---
target: Hop Map app UI (map-app.tsx, brewery-map.tsx, stop-row.tsx, place-search.tsx)
total_score: 31
p0_count: 0
p1_count: 0
timestamp: 2026-08-25T00-29-55Z
slug: app-components-map-app-tsx
---
⚠️ DEGRADED: single-context (session policy — sub-agents not invoked without an explicit user request)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Routing + fallback now disclosed; still no tile-loading state |
| 2 | Match System / Real World | 3 | Raw OSM hours still leak: "Mo-We 11:00-23:00; Th 11:00-24:00" |
| 3 | User Control and Freedom | 3 | Back/Forward fixed; still no clear-filters and no reset-view |
| 4 | Consistency and Standards | 4 | Real combobox search with proper roles; no "near me" yet |
| 5 | Error Prevention | 3 | Route still allows the same town as origin and destination |
| 6 | Recognition Rather Than Recall | 4 | 0 occluded markers, tooltips, legend restored |
| 7 | Flexibility and Efficiency | 3 | Search + keyboard nav; no map keyboard nav, no sort |
| 8 | Aesthetic and Minimalist Design | 3 | Density fixed (8 rows); 15 equal-weight chips still dominate |
| 9 | Error Recovery | 3 | Fallback disclosed; empty state still one line |
| 10 | Help and Documentation | 2 | Legend back; "3 with evidence" still unexplained, no onboarding |
| **Total** | | **31/40** | **Good — the remaining gaps are refinements, not defects** |

## Anti-Patterns Verdict

**Deterministic scan**: `detect.mjs` over `components/` and `app/` returned `[]` again — zero findings across both runs.

**LLM assessment**: Still does not read as AI-generated. The basemap restyle, the clustering with copper rings on groups, and the collapse-to-compare list are all specific decisions with reasons behind them. The interface now looks like someone's opinion about how to choose a brewery, which is the opposite of the slop failure mode.

## What's Working

1. **The honesty rule now survives every density.** Copper vs teal reads in the list, in the collapsed summary, on individual markers, AND on clusters that merely contain an award-backed brewery. That consistency is doing real work.
2. **The map earns its place.** Real road geometry, neutral basemap with chroma reserved for markers, zero occlusion. It answers "is this near where I'll be" faster than any list could.
3. **Failure is disclosed rather than hidden.** The dashed straight-line fallback with its notice is the product's governing rule showing up in the interface, not just the data pipeline.

## Priority Issues

**[P2] Fifteen style chips at equal weight dominate the panel**
They occupy the largest block above the results, all identically weighted, and most users want one or two. There is also no way to clear them once set.
*Fix*: Show 5-6 common styles, collapse the rest behind "More styles", and add a clear control once any are active.
*Command*: `/impeccable distill`

**[P2] Raw OSM opening hours are shown verbatim**
`Mo-We 11:00-23:00; Th 11:00-24:00; Fr,Sa 11:00-01:00; Su 11:00-22:00` is a machine format, presented to a human deciding whether to drive somewhere.
*Fix*: Parse to "Open until 11pm today" with the week behind a toggle. This is the single highest-value copy fix — it is the field a user checks last before leaving.
*Command*: `/impeccable clarify`

**[P2] "3 with evidence" is unexplained jargon**
It is the most important number in the interface and nothing says what it means.
*Command*: `/impeccable clarify`

**[P3] The search dropdown is one CSS change away from clipping**
It is `position: absolute` inside a panel with `overflow-hidden`. Measured: it does not clip today, but only because `max-h-64` caps it at 256px against 64px of mobile headroom. Raise that cap, or shrink the sheet, and it silently truncates.
*Fix*: Portal it, or switch to the popover API.
*Command*: `/impeccable harden`

**[P3] Route mode accepts the same town as origin and destination**
Produces a zero-length route and a meaningless corridor.
*Command*: `/impeccable harden`

## Persona Red Flags

**Jordan (First-Timer)**: Legend and tooltips fixed the biggest gaps. Still meets "3 with evidence" with no explanation, and a wall of 15 style chips before any results.

**Alex (Power User)**: Search solved the main complaint. Still cannot sort by distance vs reputation, cannot clear all filters in one action, and cannot drive the map from the keyboard.

**Sam (Mobile, in a car)**: Bottom sheet at 58dvh with 8 scannable rows is a real improvement. Still parsing a raw OSM hours string while driving, and the search dropdown has only 64px of headroom before it would clip.

## Minor Observations

- `PRODUCT.md` still titled "Ontario Beer Survey"; the product is Hop Map.
- MapLibre's attribution links render at 14px — ODbL asks for legible attribution.
- "Save this plan" still holds the position a result summary should occupy.
- No reset-view control once you have panned away from the results.
- Empty state is a single line; it could name the specific filter to relax.

## Questions to Consider

- What is the ONE number a user should read first? Right now "24 breweries · 3 with evidence" competes with itself.
- If someone opens a shared link on Saturday at the brewery, what do they need on screen? That is the trip-day view, and it does not exist yet.
- Should the 15 chips be a taste profile you set once, rather than a filter you rebuild every search?
