# CHRONOS: System Architecture

> Status: **proposal v0.1** (2026-11-11). Nothing here is built yet. This is the plan the first vertical slice will follow.
> Companion docs: [data-model.md](data-model.md) · [data-sources.md](data-sources.md) · [design-direction.md](design-direction.md) · [roadmap.md](roadmap.md) · [decisions.md](decisions.md)

## 1. The product, in one paragraph

CHRONOS is a globe you can travel through in time. The **political spine** is a set of time-stamped polity territories (who held which land in which year). That spine is the reference frame for every other layer: events, cities, routes, people, climate and evidence. Every border, date and number on screen traces back to a stored source with a license and a confidence level. If a claim has no source, CHRONOS does not draw it.

## 2. Principles that drive the architecture

1. **Evidence before pixels.** Facts are stored as *claims with provenance* (source, release, locator, evidence kind, confidence). Rendering reads from claims and never from hand-tuned constants.
2. **Static-first, API-second.** Everything the globe needs to draw *any year* ships as static, versioned, CDN-cacheable files (PMTiles plus JSON indices). Scrubbing through time never waits on the network. The API answers *questions*: entity profiles, "who ruled this spot?", analytics and search.
3. **One time model, end to end.** Years are astronomical decimal years from pipeline to database to tile attributes to GPU uniforms. There is one conversion to BCE/CE, at display time only.
4. **Uncertainty is data, and it gets drawn.** Fuzzy dates, frontier zones and competing interpretations are first-class columns. The UI renders them; it doesn't flatten them.
5. **One spine, many layers.** Each layer (political, military, urban, trade, climate…) is a plugin against the same layer registry and time engine. Adding a layer must not mean touching the core.
6. **Grow by datasets, not by code.** A new source should need a new ingest adapter and a license entry. It should not need a schema change.

## 3. System overview

```
           ┌──────────────────────── SOURCES ─────────────────────────┐
           │ Cliopatria · Natural Earth · Wikidata · PeriodO ·        │
           │ Pleiades · Itiner-e · Maddison · OpenHistoricalMap · …   │
           └──────────────────────────┬───────────────────────────────┘
                                      │ pinned versions + sha256 (data/manifest.lock.json)
                         ┌────────────▼────────────┐
                         │ pipeline/  (Python/uv)  │  fetch → normalize → validate → load → build
                         │ GeoPandas · Shapely ·   │  license gate · QA reports · attributions
                         │ pyogrio · tippecanoe    │
                         └──────┬─────────────┬────┘
                                │             │
                   ┌────────────▼───┐   ┌─────▼──────────────────────────┐
                   │ PostgreSQL +   │   │ build/<release>/  (static)     │
                   │ PostGIS        │──▶│  polities.pmtiles  (from/to    │
                   │ source of truth│   │    attributes on every feature)│
                   └────────┬───────┘   │  catalog.json · timeline.json  │
                            │           │  search.json · attributions.json│
                   ┌────────▼───────┐   └─────┬──────────────────────────┘
                   │ services/api   │         │ static host / CDN (HTTP range requests)
                   │ FastAPI        │         │
                   │ /polities/{id} │         │
                   │ /at?lon&lat    │         │
                   │ /search        │         │
                   └────────┬───────┘         │
                            │ JSON            │ tiles + indices
                     ┌──────▼─────────────────▼──────┐
                     │ apps/web  (React · TS · Vite) │
                     │  AtlasEngine: MapLibre globe  │
                     │   + deck.gl time layers       │
                     │  TimeEngine · LayerRegistry   │
                     │  UI (Tailwind tokens)         │
                     └───────────────────────────────┘
```

**Why PostGIS *and* static tiles?** PostGIS is the editable, queryable source of truth: joins, spatial queries, disputes, QA. Tiles are a *compiled* output of it for one release. A browser can't run a point-in-polygon query over 5,000 years in real time against a database 200 ms away. It can, however, filter 14,000 GPU-resident polygons by year in under a millisecond.

## 4. Rendering engine

The spec names CesiumJS as a preference. I recommend **MapLibre GL JS + deck.gl** for this product and want to explain why before committing.

| | CesiumJS 1.147 (Apache-2.0) | **MapLibre GL JS 6.x (BSD-3) + deck.gl 9.4 (MIT)** | Custom three.js globe |
|---|---|---|---|
| Globe + flat map | Yes (3D, 2D, Columbus) | Yes. Globe projection since v5 (Jan 2025), with a built-in globe→Mercator transition as you zoom | Must build both |
| Time-varying vector polygons at scale | Entities and GeoJsonDataSource get heavy at ~10k+ complex polygons. Styling is limited. | **GPU time filtering** (`DataFilterExtension` with `filterRange`/`filterSoftRange` on `[from, to]`): scrubbing is a uniform update, with no re-tessellation | Must build |
| Vector tiles, labels, collision, styling | Not native; plugins needed | Native: vector tiles, PMTiles, symbol collision, line-placed labels, data-driven styles | Must build |
| Art direction (atmosphere, custom shaders) | Good, but tends toward the "GIS app" look | `sky`/atmosphere spec plus custom WebGL layers; full control over palette | Total control, at total cost |
| Weight | Several MB of JS and workers; designed around streamed imagery and terrain | Smaller; vector-first | Smallest, but most code |
| What it's best at | Photoreal terrain, 3D Tiles, CZML | **Thematic, data-driven, art-directed cartography (us)** | Bespoke visuals |

**Decision (proposed, D-001):** MapLibre owns the basemap, globe, camera, labels and relief. deck.gl, interleaved into the same WebGL2 context (supported with MapLibre's globe since the deck.gl 9.2 line), owns the time-dynamic thematic layers: polities, events, flows and routes. Both sit behind an `AtlasEngine` interface, so React never talks to either library directly. That also keeps a door open for a **Cesium "site mode"** later (3D reconstructions of one city), which is the one job Cesium does better.

**De-risking:** milestone 1 of Phase 1 is a 2-day engine spike. It measures scrub FPS with all ~14k Cliopatria features on this M2/8 GB machine, compares MapLibre-native year filters (`setFilter`/global state) against deck.gl GPU filtering, and confirms picking works on the globe. If the spike fails, we fall back to Cesium with a primitive-based polygon renderer, and this doc gets updated.

## 5. Time model

- **Internal numbering is astronomical:** `… −1 = 2 BCE, 0 = 1 BCE, 1 = 1 CE`. Historians' numbering has no year zero, so naive subtraction across the BCE/CE boundary is off by one. Each source adapter declares its convention, and ingestion normalizes it. Unit tests pin the edge cases.
- **Decimal years** carry sub-year precision where it exists, e.g. 29 May 1453 ≈ `1453.41`. Computation uses the proleptic Gregorian calendar. The source's original calendar and date string are kept as display metadata.
- **Fuzzy instants:** `{min, max, precision, qualifier}`. Example: "c. 322 BCE" is stored as `min=−330, max=−315, precision=year, qualifier=circa`. The width comes from the source when the source gives one; otherwise it's a documented default per precision.
- **Fuzzy spans:** a fuzzy start plus a fuzzy end. The *possible* extent is `[start_min, end_max]` and the *certain* extent is `[start_max, end_min]`. The UI draws the certain core solid and the possible margins as "whiskers" or hatching.
- **Deep time:** before about 10,000 BCE, the display switches to "ka" (thousands of years ago) and "BP". The same numeric model underlies both.
- **On the GPU:** every feature carries `from` and `to` float attributes. The current year `t` is a uniform. `filterSoftRange` adds a short fade margin, so polities dissolve in and out as time passes instead of popping.

### TimeEngine (frontend)

The TimeEngine is a single store holding `t`, `playing`, `rate`, `range`, and `compareT` (for two-date comparison). Playback runs on `requestAnimationFrame` with a speed measured in years per second. Era-aware presets apply: deep prehistory moves in millennia per second, and the 20th century in months per second.

The scrubber is **linear inside the current zoom window**. An overview strip above it uses a **piecewise-logarithmic scale**, so 300 ka → today fits in one strip and the last few millennia stay legible. Era bands come from PeriodO (regional, with competing periodizations shown as parallel tracks rather than one "true" sequence). Event ticks and a **record density** histogram show where the historical record is thick and where it's thin.

## 6. Territorial transitions: deliberately not morphing

The spec asks for smooth interpolation between dated datasets "where justified". For borders, it almost never is. A morph from the 100 CE border to the 200 CE border invents fifty intermediate borders that no source attests.

CHRONOS does this instead:

1. **Cross-dissolve** between attested states, using the GPU soft range.
2. **Gain/loss pulse:** at build time, the pipeline computes `ST_Difference` between consecutive territory rows of the same polity. When `t` crosses a change, the gained area glows briefly in the polity's color and the lost area fades to ash. You *see what changed* without being shown a fiction.
3. **Campaign vectors:** only when a sourced event or route exists (a dated campaign, a treaty).
4. **True interpolation** only where a source supplies dated intermediate states. The territory row is flagged `evidence = 'modeled'` and drawn hatched.

## 7. Frontend architecture (`apps/web`)

- **Stack:** React 19, TypeScript (strict), Vite 8, Tailwind CSS v4 (design tokens as CSS variables via `@theme`), zustand (time, camera, layers, selection), TanStack Query (API), Vitest and Playwright.
- **URL is state:** time, camera, layers, selection and comparison are all encoded in the URL, so every view is a shareable "moment" link. This is cheap to build and high-value for classrooms and sharing.
- **AtlasEngine** (imperative, outside React) wraps MapLibre and deck.gl and exposes `setTime`, `flyTo`, `setLayers`, `pick` and `onHover`. React components subscribe to stores and send intents.
- **LayerRegistry:** each layer is a module of the shape `{ id, group, sources, timeAccessor, render(engine), legend(), inspect(feature), attribution }`. The political layer is just the first plugin.
- **Performance budgets** (to be confirmed by the spike): 60 fps scrub on Apple-silicon laptops, 30 fps floor on a mid-range Windows laptop, first globe in under 2.5 s on broadband, and code-split panels.
- **Accessibility:** a full keyboard path through time (←/→ step, Shift for coarse steps, Space to play), a screen-reader "describe this moment" summary generated from data, `prefers-reduced-motion` respected (crossfades become cuts and the auto-rotating camera stops), and colors that are never the only channel (labels, patterns).

## 8. Backend (`services/api`)

- **Stack:** Python 3.12 via uv, FastAPI, Pydantic v2, psycopg 3 with hand-written SQL for the geospatial queries (clearer than an ORM for PostGIS work), and Alembic migrations. `db/schema.sql` is the reviewed source the first migration is cut from.
- **Phase 1–2 endpoints:**
  - `GET /v1/at?lon=&lat=`: **core sample**. Every polity that held this point, in chronological order, with confidence and sources.
  - `GET /v1/polities/{id}`: profile (names, dates, lineage, predecessor/successor, area over time, sources).
  - `GET /v1/polities?year=&bbox=`: polities alive in a window, for panels and the time stream.
  - `GET /v1/sources/{id}` and `GET /v1/search?q=` (pg_trgm, multilingual names).
- **Caching:** every response is immutable within a dataset release. The `ETag` is the release id, with long `Cache-Control`.

## 9. Data pipeline (`pipeline/`)

The pipeline runs these stages per source:

`fetch` (pinned URL + sha256 into `data/raw/<source>/<version>/`) → `normalize` (CRS to EPSG:4326, `make_valid`, years to astronomical, names, ids) → `validate` (date ordering, geometry validity, registered license, no orphan ids, area sanity versus the source's own value) → `load` (COPY into PostGIS) → `build`.

The `build` stage produces:
- `polities.pmtiles` via tippecanoe, with zoom-dependent simplification and `from`/`to`/`polity`/`lineage`/`confidence` attributes.
- Gain/loss diff geometries for transitions.
- **Label spines:** a precomputed curved line through each territory, so names can be letter-spaced across the land the way classic atlases do it.
- `catalog.json` and `timeline.json`.
- `attributions.json`, generated from the license registry, plus an automatic credits page.
- A QA report: coverage by region × century and records per millennium.

**Licence gate (D-007, D-010):** two build profiles.

- **`public`** feeds the app, exports and anything distributed. It accepts only sources with `access_tier = 'public'`.
- **`research`** is local analysis only.

Non-commercial and unknown-licence sources are `research_only` unless a `source_permission` row exists. QA-012 fails the build if a research-only source reaches a public artifact.

**Traceability (D-013):** every build artifact ships a `trace.json` listing source releases with sha256, licences and access tiers, method ids with script versions, parameters, and QA results. Every number in the UI resolves to a trace entry; the "How is this calculated?" affordance opens it.

**Independent datasets:** each new source is an adapter plus registry rows (`license`, `source`, `source_release`). Its territories, events and estimates sit beside Cliopatria's as separate claim rows with their own provenance. Nothing is merged into another source's rows, so every dataset keeps its own licence and can be switched off, or dropped from the public profile, independently.

**Reproducibility:** `data/manifest.lock.json` pins every source version and checksum. Each build is stamped with a release id that the UI shows in its credits.

## 10. Repository layout (target)

```
CHRONOS/
├── apps/web/            React + TS + Vite + Tailwind. The atlas
├── services/api/        FastAPI service
├── pipeline/            Python ingest/build (uv project)
│   ├── chronos_pipeline/sources/   one adapter per source
│   └── tests/fixtures/  small, license-clean subsets for golden tests
├── db/                  schema.sql → migrations/
├── data/                raw/ staged/ build/  (gitignored, reproducible from manifest)
├── docs/                these documents + decisions log
└── pnpm-workspace.yaml · pyproject.toml (uv workspace) · Makefile
```

## 11. Testing strategy

| Layer | What we test |
|---|---|
| Pipeline | Year-zero and BCE/CE normalization; fuzzy date parsing; geometry validity after simplification; idempotent loads; golden test on a ~20-polity Cliopatria fixture (rows in → tiles and attributes out) |
| Database | Migration up/down; `core_sample()` against fixtures; constraint behaviour (date ordering, single-subject estimates) |
| API | pytest against a PostGIS test database; response schemas; ETag/caching |
| Web (unit) | TimeEngine stepping and playback; date formatting (BCE/CE/ka); scale transforms; URL state round-trip |
| Web (e2e) | Playwright: the globe renders, scrubbing changes the year and the visible polities, clicking opens a card with a source, and reduced-motion mode works. Screenshot diffs of a few canonical moments (e.g. 117 CE, 1279 CE, 1914 CE). |
| Data QA | Automated report: polities per century per macro-region, so coverage gaps are visible and tracked |
