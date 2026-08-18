# Ontario Beer Survey

> Derived from `../core-loop.md`, `../discovery-document.md` and `../HANDOFF.md`
> rather than from an interview — every field below is already settled in those
> documents. They remain the source of truth; this file is the summary the
> design tooling reads.

## Register

**product** — design serves the product. This is a tool someone uses to make a
decision, not a page that sells them something. There is no marketing surface
in this app; the "Press" direction was chosen for marketing and lives
elsewhere.

## Platform

**web** — Next.js 16.3.1, React 19. Planned at a desk, executed on a phone, so
mobile is a first-class target rather than a narrowed-down desktop view.

## Users

Beer enthusiasts in Ontario deciding where to go. Two shapes of one question:

- **"I'm in / going to Ottawa"** — a point.
- **"I'm driving Kingston to Toronto"** — a route.

They are not browsing. They have a trip and a taste, and they want the short
list that justifies a detour. Often deciding on behalf of a group.

## Purpose

Given where you're going and what beer you like, name the breweries worth the
detour **and say why** — then survive until travel day.

Going to the brewery is the job. Delivery is a different job and is out of
scope; it appears as an outbound link where the data exists, never a feature.

## Positioning

The category default is a star average over a map pin. A bare rating is one
more aggregate to distrust, and it cannot tell you that a 4.6 lager house is
the wrong stop for someone who wants hazy IPA.

This product's whole claim is the **reason line**: style-normalized quality,
honest detour cost, venue signal, and a fresh release you can only get by
showing up. Reasons are first-class output of the ranking engine, not UI
garnish added afterwards.

Its second claim is that the plan is a **link**. No accounts, no backend, no
app to install — sharing the plan and saving the plan are the same action, and
the group coming along is inherent to the use case.

## Brand personality

**Survey** — ordnance-survey map language. Oxidized copper against near-white,
contour orange for wayfinding, a faint grid beneath the map, and mono for
anything measurable. Precision as respect for the craft.

Both themes are first-class: planning happens at a desk in daylight, execution
happens on a phone in a car at dusk.

The tokens are committed in `app/globals.css` and are not up for redesign.

## Anti-references

- **The taproom-chalkboard costume** the category defaults to — hand-lettered
  scripts, kraft-paper textures, hop-cone iconography. Named explicitly in
  `globals.css` as what Survey exists to avoid.
- **Check-ins, badges, social feeds.** The explicit anti-reference from
  discovery. This is not Untappd.
- **A browsable release feed.** Beer Finder occupies that ground and it demands
  exhaustive coverage or it recreates the regret it set out to fix. Releases
  appear only as evidence inside a recommendation.
- **The star average.** See Positioning.

## Strategic design principles

1. **Never claim more than the data supports.** `knownFor` currently covers 25
   of 246 breweries. The interface must be honest about that rather than
   dressing an `offers` match up as a reputation. This is the product's
   governing rule — a confidently wrong recommendation costs someone a real
   drive, which is the failure the whole data pipeline is built to avoid.
2. **Show the working.** Every reason carries its evidence; a medal cites its
   category and year. If we can't say why, we don't say it.
3. **Absence is not a negative.** Unknown opening hours, unmapped patio,
   unmedalled brewery — none of these are failures to render as "no". Three
   states, not two.
4. **The link is the plan.** Any state worth keeping belongs in the URL.
5. **Measurable things are mono and tabular.** Distances, detours, dates,
   coordinates — so a column of numbers can be scanned.

## Accessibility

- Keyboard focus visible everywhere, never removed (already enforced in
  `globals.css`).
- Both colour schemes are real targets, not an afterthought toggle.
- `prefers-reduced-motion` honoured.
- 19+ age gate wraps the whole shell, including a shared link opened cold by
  someone who has never seen the site.
