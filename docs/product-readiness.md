# CHRONOS: Product readiness of the technical foundation

> Milestone 1.2 review, 2026-11-11. No product screens are built yet. This review checks that the foundation can carry each planned experience **without a rewrite**, and names what each one still needs.
> Status keys: **Ready** = supported by working, tested code. **Extend** = needs new code on existing seams, no redesign. **Gap** = needs a design decision or component that doesn't exist yet.

## What the foundation provides today

| Component | State (tested) |
|---|---|
| Source-aware pipeline | Pinned inputs; 13 QA rules; licence gate (public vs research-only); `trace.json`; byte-identical builds |
| Bundle format 2 | Territories with polity index and `[start, end]` years; full-resolution geometry; pre-computed triangles; attributions |
| Time-filtered rendering | deck.gl binary layer on the MapLibre globe; GPU year filter; 0% stale frames; back-face culling explicit (D-022) |
| Accuracy guards | 343-point pick test; render agreement against MapLibre; QA-013 triangulation check |
| Data model | Claim-based schema covering polities, territories, relations, events, routes, estimates, narratives and journeys (`db/schema.sql`, 30 tables; not yet loaded) |

## Experience by experience

| Experience | Status | What supports it | What is still needed |
|---|---|---|---|
| **Immersive 3D globe** | Ready (engine) / Extend (art) | MapLibre globe + atmosphere; deck.gl interleaved; 60 fps at 3.4 M vertices with headroom | Strata styling, label spines (pipeline), loading state gated on real readiness (D-019 note) |
| **Historical timeline** | Extend | GPU year filter costs 0.1–0.4 ms per change; astronomical years end to end; BCE/CE formatting tested | The TimeEngine UI (scrubber, zoomable overview, era bands from PeriodO); time-based transitions (D-020) |
| **Empire / civilisation selection** | Extend | Picking returns a polity index in every frame; polity catalogue with QA flags and Wikidata status in `bundle.json` | Highlighting a selected polity without re-uploading geometry. Proposed: a small shader extension comparing a per-vertex polity id with a uniform. The id attribute adds 13.8 MB (Uint32) or 6.9 MB (Uint16; there are 1,637 polities). |
| **Location core samples** | Extend | `PointIndex` in the pipeline (exact/near hits, gaps, overlaps; Rome test passes) | Browser access. Either the 1.3 API (`GET /v1/at`, PostGIS) or a client-side worker over the bundle's triangles. Recommendation: client-side first, since the data is already in memory and it needs no server. |
| **Contemporary civilisations** | Extend | Territory `[start, end]` per row; polity spans in the catalogue | A "contemporaries" query (overlapping spans) is a pure function over the catalogue. Dimming non-contemporaries uses the same shader extension as selection. |
| **Historical events** | Gap → Extend | Schema `event` / `event_participant` with fuzzy dates; layer groups defined | An event source adapter (e.g. Wikidata, verified), bundle format 3 with point/line layers, and a deck.gl `ScatterplotLayer` with the same GPU year filter |
| **Trade and migration layers** | Gap → Extend | Schema `route` with `LineStringM` (time per vertex); Itiner-e identified as a CC BY source | Route adapter; `PathLayer`/`TripsLayer` with time attributes; source licence checks through the existing gate |
| **Historical comparison** | Extend | One binary dataset can feed two layers with different `filterRange` | Each deck.gl layer uploads its own GPU buffers, so two-date comparison roughly doubles GPU memory for territories. After 1.2 the territory layer costs a renderer of about 400 MB and a GPU process of 566–721 MB (spike 002), so a second layer is plausible on 8 GB; measure before building. |
| **Guided learning** | Extend | URL-addressable state planned; journeys schema (`journey_step` with camera, time, layers) | Journey player and authoring; narratives stay human-reviewed (schema constraint) |
| **Uncertainty display** | Gap | QA flags per polity; QA-010 near hits; gaps; overlaps | Territory-level `evidence`/`confidence` and fuzzy start/end are in the schema but **not yet in the bundle**. Cliopatria gives single years and one interpretation. Add these fields when the first second source arrives. |
| **Attribution and licence display** | Extend | `attributions.json` per build; trace per output | Credits page; per-layer attribution in the UI |

## Architectural risks found in this review

1. **Overlapping territories are drawn in data order.** Where polities overlap (e.g. 420 CE Kidarites × White Huns, 488,437 km²), whichever is drawn last wins the pixel. The pick test accepts any expected polity, but the *display* should show overlap deliberately (hatching, or both colours). Needs a rule before the overlap layer is designed.
2. **GPU memory is per layer instance.** Every additional time layer or comparison view multiplies GPU buffers. Budget layers explicitly; spike 002 gives the territory layer's measured cost.
3. **One render bundle covers the whole world and all time.** That's fine at 61.5 MiB raw, 7.1 MiB brotli, or about 2.5 MiB with delta-coded triangles (spike 003). It won't hold once high-detail regional sources arrive. Spike 003 sets the thresholds for time chunks (first-view load) and for PMTiles (high-zoom regional layers).
4. **Server-side features are not started.** The API and PostGIS are configured but not installed (D-009). Nothing in this review *requires* them before 1.4; core samples can run client-side.
