# CHRONOS: Decision Log

Short ADR-style records. Status values: **proposed** (awaiting approval), **accepted**, **superseded**.

---

### D-001: MapLibre GL JS + deck.gl as the atlas engine, not CesiumJS
**Status:** accepted 2026-11-11 after spike 001 ([docs/spikes/001-engine.md](spikes/001-engine.md)). The spike measured, on the M2 in Chrome 157:
- 60 fps scrubbing with 0% stale frames;
- 1.25 s to first correct pick;
- 343/343 pick accuracy.

Time-dynamic layers use deck.gl GPU filtering. MapLibre-native filtering was rejected: its frames lagged the requested year 100% of the time while scrubbing.

**Context:** the core visual is ~14k time-varying vector polygons on a globe, plus a flat map. The product needs strong art direction, fast scrubbing and atlas-quality labels.

**Decision:**
- MapLibre (BSD-3) handles the basemap, globe projection, camera, labels and relief.
- deck.gl (MIT), interleaved into the same WebGL2 context, handles time-dynamic thematic layers with GPU time filtering.
- Both sit behind an `AtlasEngine` interface.

**Consequences:**
- We get vector tiles, PMTiles, label collision and a lighter bundle.
- We give up photoreal terrain and 3D Tiles; these are reconsidered for a future Cesium "site mode".
- WebGL2 becomes a requirement.

### D-002: Static-first delivery of time-dynamic geometry
**Status:** proposed.

**Decision:** each data release compiles to static PMTiles plus JSON indices served from a CDN, with `from`/`to` attributes on every feature. The API serves questions (profiles, core samples, analytics), not frames.

**Consequences:** scrubbing never waits on the network, caching is trivial, and the app works with a cold or offline API. Releases must be rebuilt to publish data changes.

### D-003: Astronomical decimal years internally
**Status:** proposed.

**Decision:** `0 = 1 BCE`; fractions carry sub-year precision. Each adapter declares its source's convention.

**Consequence:** a single display formatter, and correct arithmetic across the BCE/CE boundary.

**Evidence:** Cliopatria v0.2.1 has rows ending at `0` and resuming at `1`, while its negative years read as BCE. Its convention must therefore be mapped explicitly, not assumed.

### D-004: Claims with provenance on every fact row
**Status:** proposed.

**Decision:**
- Every fact table carries `source_id`, `release_id`, `locator`, `evidence`, `confidence`, `dispute_id` and `is_preferred`.
- Quantities are ranges.
- Machine-drafted narrative can't be published without review (a schema constraint).

**Consequence:** a little more verbosity per table, in exchange for traceability and the ability to hold competing interpretations.

### D-005: Cliopatria v0.2.1 is the Phase 1 political spine
**Status:** proposed.

**Decision:** Cliopatria (CC BY 4.0) is the only dataset found that is global, continuous from 3400 BCE to 2024 CE, polygonal, documented, maintained and commercially reusable.

**Consequences:** we inherit its coverage biases and coarse geometry, which the evidence-density and near-miss handling address. Aggregate "(…)" grouping and RELATION rows are modelled as relations, not as territories.

### D-006: No border morphing; cross-dissolve plus gain/loss
**Status:** proposed.

**Decision:** transitions between attested states cross-dissolve. Gained and lost areas are precomputed and pulsed. Interpolated states appear only when a source provides them, and they are rendered hatched as `modeled`.

**Consequence:** honest motion. It is less "smooth" than a morph, and more informative.

### D-007: License gate at build time
**Status:** accepted 2026-11-11, revised by D-010.

**Decision:** no source enters any build without a `license` row and an `access_tier`. There are two build profiles:

- **`public`:** the app, public exports and anything distributed. Only `access_tier = 'public'` sources.
- **`research`:** local analysis only, never published.

Attributions and the credits page are generated from the registry. QA-012 fails the build if a research-only source reaches a public artifact.

### D-008: Monorepo with pnpm (web) and uv (Python) workspaces
**Status:** proposed.

**Decision:** the monorepo holds `apps/web`, `services/api`, `pipeline`, `db` and `docs`. Data artifacts are gitignored and reproducible from `data/manifest.lock.json`.

### D-009: PostGIS runs in a dedicated, digest-pinned Docker container
**Status:** accepted 2026-11-11.

**Decision:**
- Image: `postgis/postgis:17-3.6`, pinned by digest.
- Bound to `127.0.0.1:5433`, with data in a named volume.
- The existing Homebrew PostgreSQL 15 is never touched.
- Configuration is prepared in `infra/postgis/`. Docker installation and the first start wait for milestone 1.2.

**Consequence:** the official image is amd64-only, so it runs under Rosetta on Apple silicon. A native arm64 fallback (official `postgres:17` + the PGDG PostGIS package, both pinned) is documented if performance requires it.

### D-010: Non-commercial datasets are research-only
**Status:** accepted 2026-11-11.

**Decision:**
- NC-licensed datasets (Seshat Equinox, CShapes 2.0, Smithsonian GVP, NC-licensed WHG datasets) and datasets of unknown license default to `access_tier = 'research_only'`.
- They never appear in the public application, production database exports or commercially distributed features.
- The only exceptions are a recorded `source_permission` or a suitable alternative license.

**Consequence:** the public app needs commercial-safe substitutes. For example, NOAA NCEI replaces GVP for eruptions, once its license is verified.

### D-011: Polity identity is CHRONOS's own; source cross-references are hints
**Status:** accepted 2026-11-11 (from validation 0001).

**Decision:** polities get CHRONOS ids. A Cliopatria name, or the QID it supplies, is never treated as identity.

- Rows with the same name are split into separate polities at unexplained gaps (QA-006).
- Source-supplied QIDs are stored as `external_id` rows with `status = 'asserted'`.
- Only verified QIDs populate `polity.wikidata_qid`.
- Corrections are editorial rows. Cliopatria's data is never edited.

**Consequence:** one more table, plus a review queue. This prevents errors like Han Dynasty → "Chauhan", or medieval rows inheriting the modern Kingdom of Italy.

### D-012: Three area measures, and no claim of "control"
**Status:** accepted 2026-11-11.

**Decision:** every area figure names its measure:

- **combined polygon area:** sum per polity; overlaps counted per claimant;
- **unique mapped area:** area of the union;
- **unique mapped land area:** union ∩ land, ice-free.

Wording is always "mapped" / "in Cliopatria". It is never "controlled" or "ruled", because the source records an atlas interpretation, not verified control. Every aggregate carries a coverage statement (e.g. "polities mapped over 15.7% of ice-free land").

### D-013: Every visualization is traceable
**Status:** accepted 2026-11-11.

**Decision:** each built artifact (tiles, JSON indices, charts) ships a `trace.json` with:
- source release ids and sha256;
- licences and access tiers;
- the method id and script version;
- parameters;
- QA rule results.

Each number in the UI links to its trace entry ("How is this calculated?"). A visualization without a trace entry fails review.

### D-014: Local Git with branches and reviewed merges
**Status:** accepted 2026-11-11.

**Decision:** the repository stays local for now. `main` holds reviewed work only. Each milestone is developed on its own branch in small, descriptive commits and merged after review. A private GitHub repository will be created after the foundation is reviewed.

### D-015: The 1.1 benchmark harness is framework-free; React and Tailwind wait for the UI milestones
**Status:** accepted 2026-11-11.

**Decision:** `apps/web` contains only a TypeScript benchmark harness (Vite, Vitest, MapLibre, deck.gl). React and Tailwind are added when application UI starts (1.3+).

**Trade-off:** this deviates from the 1.1 spec's "React 19, Tailwind v4". It keeps framework cost out of the engine measurements and honours "do not begin the complete application UI yet".

### D-016: Identity splitting rule
**Status:** accepted 2026-11-11 (proposed in validation 0001, tuned on the data).

**Decision:** rows sharing a name are split into separate polities at an internal gap of more than 50 years. The exception is when aggregate rows that list the polity in `Components` (or a grouping named exactly after it) cover at least 50% of the gap.

**Evidence:**
- The Holy Roman Empire's 1260–1618 gap is 100% covered, so it is kept as one polity.
- Later Zhou, Kingdom of Italy, Kingdom of Serbia and Georgia gaps are 0–1% covered, so they are split.

**Consequence:** 93 splits are flagged for review (QA-006 warnings). Linking by substring was rejected because "Han" would match "Chauhan".

### D-017: Render full-resolution geometry, split on a 5° grid
**Status:** accepted 2026-11-11.

**Decision:** no simplification. Polygons are split into cells of at most 5° so triangles follow the globe's curvature.

**Evidence:** Cliopatria is already atlas-scale. Simplifying at 0.05° removes only 10% of 2.65 M vertices, while the grid split adds 30% (3.44 M vertices, 229,020 parts).

**Trade-off:** about 30 MB of geometry and more GPU memory, in exchange for zero simplification error.

### D-018: Wikidata is a pinned snapshot, never queried during a build
**Status:** accepted 2026-11-11.

**Decision:** `snapshot-wikidata` queries every asserted QID once and writes a deterministic snapshot. Its sha256 is pinned in the manifest, and builds read only the snapshot.

**Consequence:** builds are reproducible and offline. Refreshing Wikidata is a deliberate, reviewable change.

### D-019: deck.gl joins MapLibre through `@deck.gl/maplibre`, with explicit depth handling
**Status:** accepted 2026-11-11 (from the engine spike).

**Decision:** use `MapLibreOverlay` (interleaved). Polygons are drawn with `depthCompare: "always"` and no depth writes.

**Evidence:**
- `@deck.gl/mapbox` 9.4.0 crashes against MapLibre 6 in interleaved mode.
- With default depth testing, polygons z-fight with MapLibre's globe surface and render speckled with holes.
- A far-side check (Pacific view, 1914) shows deck's globe projection already clips the back hemisphere, so disabling the depth test leaks nothing.

**Trade-off:** depth-based occlusion by future 3D objects needs revisiting when terrain or extrusions arrive.

> **Correction (2026-11-11, milestone 1.2, spike 002):** the far-side evidence above was misread. deck.gl's globe projection does **not** clip the back hemisphere. What hid it in Spike 001 was back-face culling left enabled by MapLibre's globe pass: seen through the globe, far-side triangles face away from the camera. Disabling culling made Europe and Africa paint over the Pacific (3.0% of pixels differed from MapLibre). Culling is now explicit (D-022).

### D-020: Transitions are time-based, never year-based soft filters
**Status:** accepted 2026-11-11.

**Decision:** cross-dissolves run over wall-clock time after the year changes. deck.gl's `filterSoftRange` is not used.

**Reason:** a soft year range draws a polity, faded, in years when it was not valid. That trades data accuracy for visual smoothness, which the project rules out.

### D-021: Territories are pre-triangulated in the pipeline and rendered from binary buffers
**Status:** accepted 2026-11-11 (milestone 1.2, spike 002).

**Decision:** the pipeline triangulates every render part and ships the triangles in bundle format 2.
- Triangulation uses earcut (mapbox-earcut, ISC), with a GEOS constrained-Delaunay fallback.
- It runs in Web Mercator, deck.gl's own triangulation plane, on the float32 coordinates that are rendered.
- deck.gl's `SolidPolygonLayer` takes positions and triangles as views of the bundle buffer (`_normalize: false`), plus per-vertex colour and `[start, end]` typed arrays.
- The browser no longer creates per-part objects, normalises rings, or triangulates.

**Accuracy guard:** QA-013 checks, per part, that the triangles reproduce the polygon's area. Parts that are invalid *in the triangulation plane* are repaired (18). Earcut results that deviate fall back to GEOS (812). The largest remaining mis-drawn area is 9 m² per part, 0.033 km² in total. Errors above 1 km² stop the build.

**Trade-off:** the uncompressed bundle grows from 30.5 MB to 64.5 MB (triangles), in exchange for less memory and no client triangulation. Compressed sizes are in spike 003.

### D-022: Explicit back-face culling with pipeline-fixed winding
**Status:** accepted 2026-11-11.

**Decision:** the deck.gl territory layer sets `cullMode: "back"`, and the pipeline orients every triangle counter-clockwise in lon/lat.

**Evidence (render agreement against MapLibre, spike 002):**
- back: ≤ 0.1% of pixels differ (edge anti-aliasing);
- none: far side bleeds through (3.0% in the Pacific view);
- front: near side disappears (79% at zoom 7);
- inherited MapLibre state: identical to back, which is how Spike 001 rendered.

**Consequence:** correctness no longer depends on GL state left behind by MapLibre.

### D-023: Exact typed-array allocation for deck.gl
**Status:** accepted 2026-11-11.

**Decision:** `_typedArrayManagerProps: { overAlloc: 1, poolSize: 0 }` on the overlay.

**Evidence:** deck.gl's defaults allocate 2× and keep up to 100 released buffers for reuse. On the Spike 001 path that retained about 387 MB of buffers no attribute used. With static geometry, nothing is gained from over-allocation.

### D-024: Delivery: one precompressed bundle now; time chunks next; tiles only for high-zoom regional layers
**Status:** accepted 2026-11-11 (spike 003).

**Decision:** the global territory layer ships as one full-resolution, pre-triangulated binary bundle, precompressed with brotli (7.1 MiB) under an immutable content-hashed URL. The next format adds delta-coded triangle indices (about 2.5 MiB, lossless). Time chunks are added when first-view load matters. PMTiles are reserved for future high-zoom regional layers.

**Evidence:**
- MVT tiles at the globe's zooms change polygons by 6–3,362 km² (z0–z2).
- Each low-zoom tile carries every era (12,064 rows at z0).
- Tiles bring back client triangulation, undoing spike 002's gains.

**Trade-off:** today's first visit downloads all of time (7.1 MiB) rather than just the current era (0.21 MiB). That is acceptable on desktop, and the time-chunk plan covers mobile.
