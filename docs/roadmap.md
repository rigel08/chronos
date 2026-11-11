# CHRONOS: Roadmap, Risks and Open Decisions

> Status: **proposal v0.1** (2026-11-11). Phases follow the brief; the changes I propose are marked ✦. Sizes are relative (S ≈ a day or two, M ≈ several days, L ≈ a week or more) and don't promise calendar dates.

## Phase 1: "The Living Map" (vertical slice)

**Goal:** someone opens CHRONOS, the globe appears, they drag time from 3400 BCE to 2024 CE, and they watch real, sourced polities rise and fall. Then they click anywhere on Earth and see *who ruled this ground* across 5,000 years.

| # | Milestone | Size | Contents |
|---|---|---|---|
| **1.1** | **Foundations, data spine v0, engine spike** (first; detailed below) | M | Repo tooling; the Cliopatria adapter through `validate`, with the QA rules from validation 0001; a static spike bundle with `trace.json`; the MapLibre + deck.gl spike page with measurements. This is the go/no-go for D-001. |
| 1.2 | **Data & rendering foundation** (done, 2026-11-11; spikes [002](spikes/002-memory-and-rendering.md), [003](spikes/003-data-delivery.md)) | M | Memory 821 → 254 MB with accuracy and smoothness unchanged; pre-triangulated binary bundle (format 2, QA-013); explicit culling; render-agreement and memory tooling; measured delivery recommendation (D-021 to D-024). *Replaced the originally planned "Database & tiles": spike 003 showed tiles aren't the right delivery for the territory layer, and no 1.2 feature needed PostGIS.* |
| **1.3** | **First vertical slice: the Strata stage, time engine and loading path** (built 2026-11-11 on `m1.3/first-usable-slice`; [plan](plans/m1.3-first-usable-slice.md), [report 004](spikes/004-first-usable-slice.md)) | M | Globe and basemap styling; TimeEngine and scrubber; brotli-precompressed format 3 (delta triangles) with real readiness gating; polity selection and highlight; polity card with QA and trace; client-side core sample |
| 1.4 | Database & API | M | PostGIS container up (D-009); Alembic migration from `db/schema.sql`; load with `qa_flag` and `external_id`; FastAPI `/v1/polities/{id}`, `/v1/at`, `/v1/search` (when server-side features need them) |
| 1.5 | Inspect depth | M | Names in many scripts, fuzzy dates, three area measures, evidence/source/licence chips, "How is this calculated?" trace, overlap display rule |
| 1.6 | Polish, accessibility, performance, tests | M | ✦ Label spines, loading choreography, reduced motion, screen-reader "describe this moment", Playwright and screenshot tests, performance budget check |

### Milestone 1.1 in detail (the first implementation milestone)

> **Status (2026-11-11): done, merged to `main` (`d3ee0aa`).**
> - Pipeline: 47 tests; byte-identical real-data builds.
> - QA: validation 0001 reproduced.
> - Licence gate: enforced and tested.
> - Engine spike: **GO** for MapLibre + deck.gl with GPU time filtering; see [spike 001](spikes/001-engine.md).
>
> Deviations from the spec below:
> - The harness is framework-free (D-015).
> - The pipeline renders full-resolution geometry (D-017).
> - The real-data rebuild takes about 55 s.

**Goal:** before building any product UI, prove three things on the real data:
1. The rendering stack scrubs about 12,000 time-varying polygons smoothly on this Mac.
2. The pipeline turns Cliopatria into a validated, traceable, licence-gated bundle.
3. Every QA finding from validation 0001 is detected automatically.

**Branch:** `m1.1/foundations-spike`, merged to `main` after your review (D-014).

| Part | Deliverables |
|---|---|
| Foundations | pnpm workspace (`apps/web`: React 19, TS strict, Vite, Tailwind v4, Vitest) · uv workspace (`pipeline`: Python 3.12, ruff, mypy, pytest) · `Makefile` (`setup`, `lint`, `test`, `data`, `spike`) · editorconfig · a CI workflow file, prepared and inactive until the repo is hosted |
| Registries | `pipeline/registry/licenses.yaml` and `sources.yaml`, with `access_tier`; `data/manifest.lock.json` pinning Cliopatria v0.2.1 and Natural Earth by sha256 |
| Cliopatria adapter v0 | `fetch` (pinned URL, sha256 check, raw files outside git) → `normalize` (year mapping per D-003; aggregates separated; identity split at gaps per D-011; asserted QIDs kept apart) → `validate` (QA-001 to QA-012, each a tested function) |
| Spike bundle | `data/build/spike/`: per-polity-row geometry (simplified), `from`/`to` attributes, `qa_report.json`, `trace.json` (D-013). Public profile only; QA-012 enforced. |
| Engine spike page | `apps/web` route `/spike`: MapLibre globe with a Natural Earth basemap; deck.gl polygons interleaved with GPU time filtering; a plain scrubber covering 3400 BCE–2024 CE with play; picking that shows name, years, source, licence, release and QA flags; an FPS/frame-time overlay; a toggle comparing MapLibre-native filtering with deck.gl GPU filtering |
| Measurements | `docs/spikes/001-engine.md`: median and p95 frame time during continuous scrub, time to interactive, JS heap and picking latency, in Chrome and Safari on the M2/8 GB. Ends in a go/no-go recommendation for D-001. |

**Acceptance criteria**
- On a clean checkout, `make setup && make test` passes.
- `make data` rebuilds the spike bundle with byte-identical outputs from the pinned inputs.
- The QA report reproduces the validation-0001 findings:
  - the five Wikidata mismatches;
  - the Later Zhou, Kingdom of Italy, Kingdom of Serbia and Georgia name collisions;
  - the Soissons stray part;
  - the Rome gaps;
  - 207 km² of overlap and 15.7% coverage in 117 CE.
- A test proves that a research-only source fed into the public profile fails the build.
- Spike: median frame time ≤ 16.7 ms and p95 ≤ 33 ms while scrubbing all rows in Chrome on the M2; time to interactive ≤ 3 s locally. If these targets are missed, D-001 is reopened with numbers.

**Out of scope for 1.1:** Docker and PostGIS (1.2), FastAPI, Strata visual design, core sample UI, label spines, time stream, journeys.

**What you will review:** the spike page running locally, `docs/spikes/001-engine.md`, the QA report, and the commit series.

**Exit criteria**

1. The globe is interactive in under 2.5 s on broadband.
2. Scrubbing 3400 BCE → 2024 CE holds 60 fps on Apple-silicon laptops.
3. Clicking any polity opens its card with source, licence, confidence, QA flags and the area measure used. Every number links to its trace entry.
4. Clicking any point shows its core sample, with gaps and overlaps drawn honestly.
5. A URL deep link reproduces the exact view.
6. The credits page lists every source used, and no research-only source appears in any public artifact.
7. Every aggregate shows its coverage statement; unmapped land is textured, never blank.
8. All tests pass.

### Milestone 1.3 in detail

> **Status (2026-11-11): built on `m1.3/first-usable-slice`, awaiting review.** The plan's work packages and their results are in [report 004](spikes/004-first-usable-slice.md).
>
> Deviations from the spec below:
> - Contemporaries dimming became dimming of everything except the selected polity. The contemporaries *lens* stays in Phase 2.
> - Label spines stay in 1.6.
> - The Safari run is prepared (`compat.html`) and needs one manual session.
> - The 5° grid "seams" turned out to be culled triangles and long-edge chords, both fixed (D-028).

**Goal:** the first experience a person can use. They see a styled Strata globe, scrub 3400 BCE → 2024 CE, select a polity, read its card with sources and QA flags, and click anywhere for a core sample. It must hold every 1.2 guarantee: 0% stale frames, 343/343 picks, heap under 400 MB.

| Part | Scope |
|---|---|
| Loading path | Bundle format 3 (delta + zigzag triangle indices); brotli-precompressed build output; content-hashed file names; a "loading territories" state gated on real readiness (first correct pick), not the engine signal |
| Strata stage | Natural Earth relief, coastlines and rivers style; atmosphere; globe ↔ flat; `flyTo`; the Strata tokens from design-direction.md |
| TimeEngine | Scrubber (zoomable), play/pause/speed, year/decade/century steps, BCE/CE/ka labels, keyboard; time-based transitions (D-020); state in the URL |
| Selection | Shader extension: a per-vertex polity id against a uniform, for highlight and "contemporaries" dimming, with no geometry re-upload. Memory measured against the 400 MB budget. |
| Polity card | Name, years, combined vs unique area, Wikidata as given / corrected, QA flags, source and licence, trace link |
| Core sample | Client-side point query over the bundle's triangles in a Web Worker (no server). Same exact/near/gap/overlap semantics as the pipeline's `PointIndex`, tested against it for Rome. |
| Quality | React 19 + Tailwind enter here (D-015); the benchmark protocol, render agreement and pick accuracy run against the real UI build in CI-ready scripts |

**Acceptance:**
- every 1.2 guarantee holds on the UI build;
- the core sample matches the pipeline's Rome result exactly;
- the first view at 117 CE becomes interactive within 1.5 s on this M2 (local);
- a Safari manual run is recorded.

**Out of scope:** PostGIS/API (1.4), events/routes layers, journeys.

## Phase 2: "Who, Where, What"

- **Polity profiles:** the full lineage trajectory, rulers (Wikidata, verified), capitals (Pleiades/Wikidata), predecessors/successors, polygon area over time (a named measure, D-012).
- **Event system:** battles, sieges, treaties and foundings with fuzzy dates and locations. Each event carries the "seven questions" narrative format at three reading levels.
- **Cities & places layer** (Pleiades, Reba et al. urban populations once the license is verified).
- **Layer panel:** political, military and urban first, all built on the LayerRegistry.
- ✦ **Contemporaries lens:** pin a polity; everything that didn't coexist with it dims; overlap bars show who shared its centuries.
- ✦ **Time Stream:** a regional stream of combined polygon area, with the unique-area envelope, beneath the timeline that recomposes as you rotate the globe.
- ✦ **Evidence density layer:** where the historical record is thick, and where it's thin.
- Regional views (saved camera + region presets) and multilingual search.

## Phase 3: "Compare & Connect"

- Compare two dates (a swipe divider across the globe) and compare two polities (trajectories aligned by founding year).
- **Dominance analytics on honest variables only:** unique mapped land area and polygon area (derived, D-012) and sourced population ranges. Overlapping ranges show as ties.
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
| **Crosswalk errors.** Cliopatria's Wikidata column is a topical link: 299 of 1,545 name–QID pairs fail checks, and 5 of 19 famous polities are mislinked (e.g. Han Dynasty → "Chauhan"; ancient Roman Republic → the 1798 republic). | Wrong links and merged identities | D-011: CHRONOS ids; QIDs stored as assertions; verified overrides; QA-007/008 |
| **Licensing:** NC sources (CShapes, Seshat Equinox, GVP, some WHG data) and copyleft data (historical-basemaps) | Blocks commercialization | License registry + build-time gate; `open` vs `commercial` profiles from day one |
| **Contested modern borders** (Kashmir, Crimea, Western Sahara, Taiwan, Palestine…) | Political sensitivity, trust | Written policy: show de facto control and claims as separate `control_kind` rows, with sources. Never silently pick a side. |
| **Performance:** 13.8k complex polygons on a globe, mid-range GPUs, mobile | Janky scrubbing | Tiles + per-zoom simplification + GPU filtering; the spike decides before we build on it; mobile gets a reduced-detail profile |
| **Editorial scale:** thousands of events need explanations | A bottleneck, or a hallucination risk if text is generated | Narratives cite stored claims; machine-drafted text can't publish without review (enforced in schema); start with curated journeys |
| **Calendar and year-zero conversions** | Off-by-one dates around 1 BCE/1 CE | Per-source convention declared in the adapter; unit tests pin it (Cliopatria already observed to need explicit handling) |
| **Machine constraints:** 8 GB RAM; no PostGIS, GDAL or Docker installed yet | Setup friction | Processing fits easily (the 173 MB GeoJSON parses in seconds); PostGIS runs in a pinned Docker container from 1.2 (D-009) |
| **Single-source dependence on Cliopatria** | One historiography dominates | `dispute`/`is_preferred` lets other sources' territories coexist; source switcher on the card (Phase 3) |

---

## Decisions

**Resolved 2026-11-11**

1. **PostGIS:** Docker, with a dedicated, digest-pinned container. The local PostgreSQL stays untouched. The configuration is prepared now and installed at 1.2 (D-009).
2. **Non-commercial datasets:** research only. They are excluded from the public app, production exports and commercial features unless permission or a suitable licence is obtained (D-010).
3. **Hosting:** local Git with branches and reviewed merges. A private GitHub repository follows once the foundation is reviewed (D-014).

**Awaiting your approval**

4. **Visual direction:** Strata, subject to your review of the updated studies.
5. **Technical validation:** [validation 0001](validation/0001-cliopatria-117ce.md).
6. **Milestone 1.1** as specified above. It is also the test for D-001 (MapLibre + deck.gl).
