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
**Status:** proposed.

**Decision:** no source enters a build without a `license` row. There are two profiles: `open` and `commercial` (which excludes NC and unknown licenses). Attributions and the credits page are generated from the registry.

### D-008: Monorepo with pnpm (web) and uv (Python) workspaces
**Status:** proposed.

**Decision:** the monorepo holds `apps/web`, `services/api`, `pipeline`, `db` and `docs`. Data artifacts are gitignored and reproducible from `data/manifest.lock.json`.
