# Spike 002: memory, accuracy and rendering foundation (milestone 1.2)

> 2026-11-11, branch `m1.2/data-rendering-foundation`. Same machine, browser and protocol as [Spike 001](001-engine.md): Apple M2 (8 GB), Chrome 157 headless on the real GPU ("ANGLE Metal Renderer: Apple M2"), 1440×900 at device pixel ratio 2. Raw results are in [`results/`](results/).

## Outcome

| | Spike 001 configuration (rerun today) | **1.2 binary path** | Target |
|---|---|---|---|
| JS heap after the protocol (`usedJSHeapSize`, no forced GC; the Spike 001 metric) | 821 / 817 / 834 MB | **255 / 248 / 254 MB** | < 400 MB |
| Retained after forced GC: on-heap + typed-array buffers | 58 + 748 MB | **29 + 217 MB** | |
| Heap across 5 back-to-back sweeps (no GC), worst run | 810–901 MB | **248–333 MB** | no growth |
| Time to first correct pick | 1.29 / 1.31 / 1.36 s | **0.52 / 0.63 / 0.58 s** | |
| Frame time p50 / p95, every phase (sweep, Europe, jumps, explore, endurance) | 16.7 / ≤ 16.8 ms | 16.7 / ≤ 16.8 ms | 60 fps |
| Stale frames, every phase | 0% | **0%** | 0% |
| Year change → frame fully current, p95 | 33.7–35.0 ms | 33.6–35.1 ms | |
| Pick accuracy (343 ground-truth points) | 343/343 ×3 | **343/343 ×3** | 100% |
| Render agreement with MapLibre (6 views) | ≤ 0.10% of pixels | ≤ 0.10% of pixels | |

**The memory target is met with margin, and accuracy, smoothness and staleness are unchanged.** Where three values are given, they are the three runs in order.

## 1. Where the ~820 MB actually was (measured, not inferred)

The method: forced-GC staged probes in the page, Chrome DevTools `Runtime.getHeapUsage` (on-heap objects and ArrayBuffer backing stores reported separately), a sampling heap profile of live objects, an inventory of every deck.gl attribute buffer, and `footprint` for every Chrome process. Tool: [`apps/web/bench/profile-memory.mjs`](../../apps/web/bench/profile-memory.mjs).

| Finding | Evidence |
|---|---|
| **`usedJSHeapSize` includes typed-array memory** in this Chrome | 770 MB reported after GC = **54 MB of JS objects + 715 MB of ArrayBuffer backing stores** |
| My 1.1 guess (normalisation copying into JS arrays) **was wrong** | Normalised rings are transient garbage. The live JS objects are 38 MB, mostly the harness's own per-part wrappers. |
| deck.gl attribute buffers held **328 MB**, about 2× what the data needs | vertex positions Float64 157.6 MB (data needs 82.6 MB) · filter values 52.5 · indices 52.5 · colours 26.3 · row indexes 26.3 · vertex-valid flags 13.1 |
| The remaining **~387 MB** sat in deck.gl's typed-array pool | deck.gl's `TypedArrayManager` defaults to `overAlloc: 2` and keeps up to 100 released buffers. Triangulation grows the index buffer polygon by polygon, filling the pool. |
| A probe taken right after the allocation burst is unreliable | Typed-array memory is freed by a background sweeper after GC: one probe read 1,145 MB while DevTools showed 293 + 54 MB moments later |

## 2. What was changed

| Step | Change | Effect (after GC, at first correct pick) |
|---|---|---|
| V1 | Exact allocation, no buffer pool (`_typedArrayManagerProps: { overAlloc: 1, poolSize: 0 }`; D-023) | Buffers 715 → **293 MB** |
| V2 | **Pre-triangulated binary geometry** (D-021): the pipeline ships triangles; deck.gl reads positions and triangles as views of the bundle buffer (`_normalize: false`) | Buffers → **216 MB** (including the 64.5 MB bundle, now shared instead of copied); JS objects 54 → **25 MB**; no Float64 copy of positions |
| — | Explicit `cullMode: "back"` and pipeline-fixed counter-clockwise triangles (D-022) | Required for correctness; see §4 |

Process footprint, all Chrome processes, at first correct pick (memory profiler): **1,740 MB → 1,148 MB**. After the full protocol (benchmark runner): renderer **870–881 → 401–405 MB**; GPU process **906–921 → 566–721 MB**.

## 3. Accuracy regression

| Check | Result |
|---|---|
| 343-point ground truth, inside polities and on unmapped land | 343/343 in all 3 binary runs; also 343/343 for the Spike 001 configuration and MapLibre |
| Render agreement, binary vs Spike 001 path, 6 views (117 CE globe; Pacific 1914; Europe 1500; Near East 500 BCE; India 1765 at zoom 7; Lithuania 1265 at zoom 5) | 0–135 differing pixels of 1.3 M (≤ 0.010%) |
| Render agreement, binary vs MapLibre native (independent triangulation, depth-correct) | ≤ 0.098% of pixels, all along edges (anti-aliasing) |
| Globe far-side clipping | Pacific 1914: 144 px differ from MapLibre (0.011%). Without back-face culling, 39,362 px (3.0%) differed because Europe and Africa bled through. |
| Triangulation (QA-013, every part) | 229,026 parts. 18 repaired because they were invalid in the triangulation plane; 812 used the GEOS fallback. Largest mis-drawn area 9 m², total 0.033 km². |
| Pipeline tests | 54 passed. New tests: triangulation area, repair, winding, part ranges, real-data parts. Earlier tests unchanged: BCE/CE conversion, temporal validity, gaps, overrides, combined vs unique area, licence gate. |

## 4. Findings that changed earlier conclusions

1. **D-019 was right for the wrong reason.** Spike 001 concluded that deck.gl's globe projection clips the far hemisphere. It doesn't. MapLibre's globe pass leaves back-face culling enabled, and seen through the globe, far-side triangles face away. With culling off, the far side paints through (3.0% of pixels in the Pacific view; 12.7% at zoom 7 over India). Culling is now explicit.
2. **The binary path initially rendered almost nothing.** The pipeline's triangles came out with the opposite winding, so inherited culling removed them. The memory profile taken in that state was discarded and redone. Fixed by orienting every triangle counter-clockwise in the pipeline.
3. **"The 1.1 renderer over-draws 2,214 km² at the Mughal Empire" was not true.** Plain earcut does mis-triangulate that part *in the pipeline's plane* (6,724 km² summed over the affected rows). deck.gl's in-browser triangulation of the same part renders identically to the corrected pipeline output (0 px difference). QA-013 remains as a guard, but it did not fix a visible 1.1 defect.
4. **Overlapping territories are drawn in data order.** That's acceptable for picking, which accepts any expected polity, but the display needs a deliberate overlap treatment (see [product-readiness.md](../product-readiness.md)).

## 5. MapLibre native (continuity)

Run once more for continuity (3 runs; MapLibre's code path is unchanged since 1.1):

| | MapLibre native |
|---|---|
| Time to first correct pick | 12.7 / 11.7 / 9.8 s (Spike 001: 7.3 s) |
| Stale frames while scrubbing | **100%** in every phase, as in Spike 001 |
| Worst frame per phase | 100–733 ms; up to 5 long tasks per phase |
| Year change → current, p95 | 67–100 ms |
| Pick accuracy (after settling) | 343/343 ×3 |
| JS heap after protocol (no GC) | 351–959 MB; after GC 209–215 MB of objects + 42–45 MB of buffers |
| **Renderer process footprint** | **≈ 3.8 GB**, dominated by GeoJSON tiling in its workers |

This doesn't change D-001: MapLibre remains the globe and basemap, and deck.gl the time layers. MapLibre-native time filtering stays rejected.

## Browsers

| Browser | Status |
|---|---|
| Chrome 157 headless (Metal GPU) | Measured: the full protocol, 3 runs per path |
| **Chrome 157 headed**, real display | Measured: 1 run of the binary path ([`results/2026-11-11-m2-chrome157-headed-m12.json`](results/2026-11-11-m2-chrome157-headed-m12.json)). 343/343 picks, 0% stale, frame p50 16.7 / p95 17.6 ms (display vsync jitter), no frame over 33 ms, heap 264 MB. |
| Safari 27.0.1 | **Not measured.** Automation requires enabling "Allow Remote Automation" (a system setting), which was not changed. Manual check: start `pnpm --dir apps/web dev`, open `http://localhost:5174/bench.html?engine=deck&variant=binary&run=1` in Safari, and read the JSON on the page. |
| Firefox | **Not measured.** It isn't installed, and Playwright's Firefox build isn't downloaded. |
| Static requirements | WebGL2 and module workers: Safari ≥ 15, Firefox ≥ 114, Chrome ≥ 80. The harness uses no Chrome-only APIs on its rendering path; `performance.memory` is Chrome-only and used only for measurement. |

## 6. Reproduce

```bash
make data
cd apps/web && node bench/run.mjs --engines deck,maplibre --variants spike001,binary --reps 3 --cycles 5 --label m2-chrome157-headless-m12
node bench/profile-memory.mjs --engine deck --variant binary --label deck-v2-binary
node bench/compare-render.mjs --label m2-chrome157-headless
```

## 7. Not covered

- **Safari and Firefox:** see Browsers.
- **GPU memory per attribute:** WebGL exposes no per-buffer accounting. Only the GPU process footprint is measured (binary: 566–721 MB after the protocol; Spike 001 configuration: 906–921 MB).
- **The 1-pixel seams:** two short seams along 5° grid lines (Scandinavia) differ between deck.gl and MapLibre in the 1500 CE view. This is edge-level; worth a look when the Strata styling lands.

> **Resolved in milestone 1.3 (D-028, [report 004](004-first-usable-slice.md)).** These were not grid artefacts.
> - 16,487 triangles (0.6%) faced inward on the globe and were removed by back-face culling, leaving gaps (up to 0.22 deg² per triangle).
> - Long real edges drifted up to 4.95 km from the lon/lat line.
>
> Both are fixed in the pipeline. The 1.2 render-agreement figures above were measured before the fix.
