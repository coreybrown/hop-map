---
target: Hop Map app UI (map-app.tsx, brewery-map.tsx, stop-row.tsx)
total_score: 23
p0_count: 2
p1_count: 3
timestamp: 2026-08-24T23-26-50Z
slug: app-components-map-app-tsx
---
⚠️ DEGRADED: single-context (session policy — sub-agents not invoked without an explicit user request)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 2 | No loading state while tiles fetch; filter changes give no confirmation |
| 2 | Match System / Real World | 3 | Raw OSM hours leak: "Mo-We 11:00-23:00; Th 11:00-24:00" |
| 3 | User Control and Freedom | 2 | Browser Back is dead (replaceState); no clear-filters; no reset-view |
| 4 | Consistency and Standards | 3 | No text search, no "near me" geolocation, no "search this area" |
| 5 | Error Prevention | 3 | Route allows same from/to |
| 6 | Recognition Rather Than Recall | 2 | 8 of 24 markers occlude each other; no hover labels |
| 7 | Flexibility and Efficiency | 2 | No keyboard nav on map; 15 equal-weight chips; no sort |
| 8 | Aesthetic and Minimalist Design | 3 | Basemap solid; panel dense — 1.8 rows visible at a time |
| 9 | Error Recovery | 2 | Route fallback to straight line is never disclosed |
| 10 | Help and Documentation | 1 | Marker colour legend was dropped; "with evidence" unexplained |
| **Total** | | **23/40** | **Needs work — strong bones, unfinished surface** |

## Anti-Patterns Verdict

**Deterministic scan**: `detect.mjs` over `components/` and `app/` returned `[]` — zero findings. No gradient text, no side-stripe borders, no eyebrow scaffolding, no identical card grids.

**LLM assessment**: Does not read as AI-generated. The basemap restyle is a committed, specific choice; ruled rows instead of cards; mono for measurements. The tell it avoids is genericness — this looks like a considered product. The remaining weaknesses are unfinished, not generic.

## What's Working

1. **The honesty rule renders visually.** Copper = award-backed, teal = catalog-only, in the list AND on the map. The product's central claim is legible without reading a word.
2. **Basemap hierarchy is correct now.** Hue separates surfaces, value separates roads, chroma is reserved for markers and the route.
3. **Real road geometry.** The route traces the 401 rather than a chord across Lake Ontario, and detour is measured off the actual road.

## Priority Issues

**[P0] 8 of 24 markers are occluded**
Measured at 1440×900: eight marker pairs sit within 20px. In the Toronto screenshot an orange (award-backed) marker is completely hidden behind #23 — the highest-value pin on the map is invisible.
*Why it matters*: The map's one job is showing where things are. A hidden marker is a brewery that does not exist to the user, and it is disproportionately hiding the ones with evidence.
*Fix*: Cluster at low zoom with a count badge, expanding on zoom-in. MapLibre supports this natively via `cluster: true` on a GeoJSON source.
*Command*: `/impeccable layout`

**[P0] The marker legend was dropped in the map rewrite**
The SVG version carried a legend explaining copper vs teal. The MapLibre version has none.
*Why it matters*: The colour distinction IS the product thesis. Unexplained, it's decoration.
*Command*: `/impeccable clarify`

**[P1] Only 1.8 result rows are visible at once**
Rows are 256px tall in a 472px scroller.
*Why it matters*: The list is how you compare stops. You cannot compare what you cannot see side by side.
*Fix*: Collapse rows to name + distance + knownFor; expand the selected one.
*Command*: `/impeccable distill`

**[P1] Browser Back is broken**
`replaceState` on every filter change means Back leaves the app entirely.
*Why it matters*: Back is the most-used control in any browser. Users will lose their trip.
*Fix*: `pushState` on committed changes (place/route), `replaceState` on chip toggles.
*Command*: `/impeccable harden`

**[P1] Route fallback is silently undisclosed**
`DrivingRoute.approximated` is set when OSRM fails, and never surfaced. The user sees a straight line presented as a route.
*Why it matters*: This violates the product's own governing rule — never claim more than the data supports. It is the exact failure the data pipeline exists to prevent, reappearing in the UI.
*Command*: `/impeccable harden`

## Persona Red Flags

**Jordan (First-Timer)**: Lands on a map with 24 numbered circles in two colours and no legend. Cannot tell why 11 is orange and 13 is teal. No hover labels, so identifying a pin costs a click. "3 with evidence" is unexplained jargon.

**Alex (Power User)**: No keyboard access to the map. Cannot search by brewery name — only 15 preset city dropdowns. No "near me". Cannot sort by distance vs. reputation. Back button loses everything.

**Sam (Mobile, in a car)**: Bottom sheet covers 58% of screen. Raw OSM opening-hours string requires parsing while driving. No offline state.

## Minor Observations

- `Save this plan` sits above the results, holding the position a result summary should occupy.
- 15 style chips at equal weight; most users want one or two.
- Markers have no `title`, so no native tooltip.
- No same-origin/destination guard in route mode.
- Attribution is compact-collapsed; ODbL wants it legible.

## Questions to Consider

- If the map is the product, why is the search a dropdown of 15 cities rather than a text field over the whole registry?
- Should the list collapse to a single line per brewery, with detail on selection — the way every map app resolves this tension?
- What does this look like with 5 results instead of 24? The design assumes density it may not always have.
