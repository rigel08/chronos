# CHRONOS: Product readiness of the technical foundation

> Milestone 1.2 review, 2026-11-11; **updated for milestone 1.3** (the first usable slice) the same day. Rows changed in 1.3 are marked ✦. No product screens are built yet. This review checks that the foundation can carry each planned experience **without a rewrite**, and names what each one still needs.
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
| **Immersive 3D globe** ✦ | Ready | MapLibre globe + atmosphere; deck.gl interleaved; 60 fps at 3.4 M vertices with headroom | 1.3 built: the Strata stage, hillshade, globe ↔ flat, readiness on the first correct pick. Still to do: label spines (1.6). |
| **Historical timeline** ✦ | Ready / Extend | GPU year filter costs 0.1–0.4 ms per change; astronomical years end to end; BCE/CE formatting tested | 1.3 built: scrubber, zoomable track, record-density overview, steps, playback, keyboard, URL state, and the D-020 dissolve. Still to do: era bands from PeriodO (needs that source). |
| **Empire / civilisation selection** ✦ | Ready | Picking returns a polity index in every frame; polity catalogue with QA flags and Wikidata status in `bundle.json` | 1.3: StrataExtension (D-029). Highlight, dim and hover are uniforms; the polity code is packed into one float per vertex, which replaced the colour attribute, so memory is unchanged. |
| **Location core samples** ✦ | Ready | `PointIndex` in the pipeline (exact/near hits, gaps, overlaps; Rome test passes) | 1.3: client-side on the main thread. The index is built once (115 ms) on the first sample; each query takes a median of 0.27 ms and at most 3 ms, so no worker is needed. Equals the pipeline's Rome result exactly and agrees with all 343 test points. |
| **Contemporary civilisations** | Extend | Territory `[start, end]` per row; polity spans in the catalogue | A "contemporaries" query (overlapping spans) is a pure function over the catalogue. Dimming non-contemporaries uses the same shader extension as selection. |
| **Historical events** | Gap → Extend | Schema `event` / `event_participant` with fuzzy dates; layer groups defined | An event source adapter (e.g. Wikidata, verified), bundle format 3 with point/line layers, and a deck.gl `ScatterplotLayer` with the same GPU year filter |
| **Trade and migration layers** | Gap → Extend | Schema `route` with `LineStringM` (time per vertex); Itiner-e identified as a CC BY source | Route adapter; `PathLayer`/`TripsLayer` with time attributes; source licence checks through the existing gate |
| **Historical comparison** | Extend | One binary dataset can feed two layers with different `filterRange` | Each deck.gl layer uploads its own GPU buffers, so two-date comparison roughly doubles GPU memory for territories. After 1.2 the territory layer costs a renderer of about 400 MB and a GPU process of 566–721 MB (spike 002), so a second layer is plausible on 8 GB; measure before building. |
| **Guided learning** | Extend | URL-addressable state planned; journeys schema (`journey_step` with camera, time, layers) | Journey player and authoring; narratives stay human-reviewed (schema constraint) |
| **Uncertainty display** ✦ | Gap → Extend | QA flags per polity; QA-010 near hits; gaps; overlaps | 1.3 shows on the card: the source's evidence kind (*interpreted*), "confidence not stated by the source", QA flags with messages, and editorial "under review" notes. Fuzzy dates and per-territory confidence still wait for a second source. |
| **Attribution and licence display** ✦ | Ready | `attributions.json` per build; trace per output | 1.3: a credits page generated from the registry, and source, licence and trace on every card |

## Architectural risks found in this review

1. ~~**Overlapping territories are drawn in data order.**~~ **Resolved in 1.3 (D-026).** Overlap regions are explicit and striped in every claimant's colour; the 420 CE Kidarites × White Huns overlap shows both.
2. **GPU memory is per layer instance.** Every additional time layer or comparison view multiplies GPU buffers. Budget layers explicitly; spike 002 gives the territory layer's measured cost.
3. **One render bundle covers the whole world and all time.** That's fine at 61.5 MiB raw, 7.1 MiB brotli, or about 2.5 MiB with delta-coded triangles (spike 003). It won't hold once high-detail regional sources arrive. Spike 003 sets the thresholds for time chunks (first-view load) and for PMTiles (high-zoom regional layers).
4. **Server-side features are not started.** The API and PostGIS are configured but not installed (D-009). Nothing in this review *requires* them before 1.4; core samples can run client-side.
