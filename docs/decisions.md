# CHRONOS: Decision Log

Short ADR-style records. Status values: **proposed** (awaiting approval), **accepted**, **superseded**.

---

### D-001: MapLibre GL JS + deck.gl as the atlas engine, not CesiumJS
**Status:** proposed. A spike (milestone 1.1) must confirm it.

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
