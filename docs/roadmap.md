# CHRONOS: Roadmap, Risks and Open Decisions

> Status: **proposal v0.1** (2026-11-11). Phases follow the brief; the changes I propose are marked ✦. Sizes are relative (S ≈ a day or two, M ≈ several days, L ≈ a week or more) and don't promise calendar dates.

## Phase 1: "The Living Map" (vertical slice)

**Goal:** someone opens CHRONOS, the globe appears, they drag time from 3400 BCE to 2024 CE, and they watch real, sourced polities rise and fall. Then they click anywhere on Earth and see *who ruled this ground* across 5,000 years.

| # | Milestone | Size | Contents |
|---|---|---|---|
| 1.0 | Foundations | S | pnpm + uv workspaces, TS strict, ruff/mypy, ESLint/Prettier, Makefile, CI skeleton, docs |
| 1.1 | **Engine spike** (go/no-go for D-001) | S | MapLibre globe + deck.gl interleaved, with all 13,797 Cliopatria rows. Measure scrub FPS, picking and memory on M2/8 GB. Compare native filters with GPU `DataFilterExtension`. |
| 1.2 | Data spine | M | Cliopatria adapter (fetch → normalize → validate), year-convention tests, PostGIS load, PMTiles build with `from`/`to`, gain/loss diffs, `catalog.json`, `attributions.json`, QA report |
| 1.3 | Globe & basemap | M | Custom style from Natural Earth (relief, coastlines, rivers, lakes), atmosphere, globe ↔ flat transition, cinematic `flyTo` arcs |
| 1.4 | Time engine & timeline | M | Zoomable scrubber plus a piecewise-log overview strip; play/pause/rewind/speed; step by year, decade, century or millennium; BCE/CE/ka formatting; jump-to-year; keyboard control; GPU-filtered polities with cross-dissolve and gain/loss pulses |
| 1.5 | Inspect | M | Hover names; polity card (names, fuzzy dates, lineage, mapped-extent sparkline, source + license chip); ✦ **core sample** at any point via `GET /v1/at` |
| 1.6 | Polish, accessibility, performance, tests | M | ✦ Label spines, loading choreography, reduced motion, screen-reader "describe this moment", Playwright and screenshot tests, performance budget check |

**Exit criteria**

1. The globe is interactive in under 2.5 s on broadband.
2. Scrubbing 3400 BCE → 2024 CE holds 60 fps on Apple-silicon laptops.
3. Clicking any polity opens its card with source, license and confidence.
4. Clicking any point shows its core sample, with gaps and overlaps drawn honestly.
5. A URL deep link reproduces the exact view.
6. The credits page lists every source used.
7. All tests pass.

## Phase 2: "Who, Where, What"

- **Polity profiles:** the full lineage trajectory, rulers (Wikidata, verified), capitals (Pleiades/Wikidata), predecessors/successors, mapped extent over time.
- **Event system:** battles, sieges, treaties and foundings with fuzzy dates and locations. Each event carries the "seven questions" narrative format at three reading levels.
- **Cities & places layer** (Pleiades, Reba et al. urban populations once the license is verified).
- **Layer panel:** political, military and urban first, all built on the LayerRegistry.
- ✦ **Contemporaries lens:** pin a polity; everything that didn't coexist with it dims; overlap bars show who shared its centuries.
- ✦ **Time Stream:** a regional stream of mapped extent beneath the timeline that recomposes as you rotate the globe.
- ✦ **Evidence density layer:** where the historical record is thick, and where it's thin.
- Regional views (saved camera + region presets) and multilingual search.

## Phase 3: "Compare & Connect"

- Compare two dates (a swipe divider across the globe) and compare two polities (trajectories aligned by founding year).
- **Dominance analytics on honest variables only:** mapped extent (derived) and sourced population ranges. Overlapping ranges show as ties.
- Movement layers: Itiner-e Roman roads, trade routes, voyages and campaigns as `LineStringM` paths that animate at their attested pace, and migration flows.
- **Journeys:** the storytelling engine (camera + time + layers + narrative), starting with the eight journeys named in the brief.
- ✦ **Paleo-coastlines:** sea level over deep time (Doggerland, Beringia, Sundaland) from bathymetry and a published sea-level curve. Prehistory needs its own visual grammar, since there are no polities to draw.

## Phase 4: Learning

- Guided tours, beginner/advanced explanations and topic paths.
- ✦ **Knowledge checks generated from the database, not from a language model.** Example: "Which of these existed at the same time as the Han dynasty?" Every answer is computable and sourced.
- Educator mode: assign journeys, see progress.
- Expanded coverage, with specialist sources for Africa, the Americas and Oceania.

## Phase 5: Premium, institutional, creator

- Journey editor for creators and teachers; embeds; API access; classroom dashboards.
- **Commercial build profile audit:** every source re-checked against `commercial_use`.

---

## Where I'm pushing back on the brief

1. **No border morphing.** Interpolating between dated borders invents states no source attests. The plan uses cross-dissolves, gain/loss pulses, and interpolation only when a source provides it (see [architecture.md §6](architecture.md)).
2. **Most "power" layers can't be numeric.** Military capability, economic influence, cultural influence and religious influence have no comparable measurements across most of history. Scoring them would fabricate the rankings the brief forbids. The plan keeps measured or derived variables, sourced ranges, and qualitative influence shown as narrative plus an evidence map. Seshat Equinox can support careful military-technology comparisons, but it's non-commercial.
3. **Depth before breadth.** A beautiful, trustworthy political spine with one excellent inspection flow beats nine shallow layers. The layer system is designed for breadth; Phase 1 proves depth.
4. **Prehistory is a different medium.** Before about 3400 BCE there are no polities to draw. Deep time gets sites, flows, climate and coastlines instead of an empty political map.

---

## Risks and trade-offs

| Risk | Impact | Mitigation |
|---|---|---|
| **Coverage bias:** atlas data is Eurasia-heavy, and Cliopatria omits polities under 5,000 km² or 50 years | Misleading "empty" regions; Eurocentric story | "Unmapped ≠ empty" texture, evidence density layer, targeted regional sources (Phase 4) |
| **False precision:** pre-modern frontiers were zones, not lines | Over-confident maps | `boundary_kind` → feathered frontiers; `control_kind` → tributary hatching; confidence shown on every card |
| **Coarse geometry:** point queries miss small or coarse polygons. Rome sits under 5 km outside Cliopatria's Roman Kingdom polygon. | Wrong "core sample" answers | Query with tolerance, flag near-misses as "within ~5 km", show gaps as gaps |
| **Crosswalk errors.** Example: the 1799 Revolutionary Roman Republic carries the ancient Roman Republic's Wikidata ID in Cliopatria. | Wrong links and merges | QA rule: one QID on non-contiguous polities is a warning; Wikidata is never the authority |
| **Licensing:** NC sources (CShapes, Seshat Equinox, GVP, some WHG data) and copyleft data (historical-basemaps) | Blocks commercialization | License registry + build-time gate; `open` vs `commercial` profiles from day one |
| **Contested modern borders** (Kashmir, Crimea, Western Sahara, Taiwan, Palestine…) | Political sensitivity, trust | Written policy: show de facto control and claims as separate `control_kind` rows, with sources. Never silently pick a side. |
| **Performance:** 13.8k complex polygons on a globe, mid-range GPUs, mobile | Janky scrubbing | Tiles + per-zoom simplification + GPU filtering; the spike decides before we build on it; mobile gets a reduced-detail profile |
| **Editorial scale:** thousands of events need explanations | A bottleneck, or a hallucination risk if text is generated | Narratives cite stored claims; machine-drafted text can't publish without review (enforced in schema); start with curated journeys |
| **Calendar and year-zero conversions** | Off-by-one dates around 1 BCE/1 CE | Per-source convention declared in the adapter; unit tests pin it (Cliopatria already observed to need explicit handling) |
| **Machine constraints:** 8 GB RAM; no PostGIS, GDAL or Docker installed yet | Setup friction | Processing fits easily (the 173 MB GeoJSON parses in seconds); PostGIS install path is an open decision below |
| **Single-source dependence on Cliopatria** | One historiography dominates | `dispute`/`is_preferred` lets other sources' territories coexist; source switcher on the card (Phase 3) |

---

## Open decisions (yours)

1. **Rendering engine:** approve MapLibre + deck.gl over CesiumJS, subject to the milestone 1.1 spike? (Recommended)
2. **Visual direction:** approve *Strata* (see [design-direction.md](design-direction.md))?
3. **PostGIS:** how should it be installed on this Mac? Options:
   - `brew install postgis`, which brings a newer PostgreSQL alongside your running 15;
   - Postgres.app, which bundles PostGIS;
   - Docker Desktop.
4. **Commercial intent:** should non-commercial sources (Seshat Equinox, CShapes, GVP) appear in the public open build, or stay research-only until licensed?
5. **Repository hosting:** keep this local for now, or create a GitHub repository?
