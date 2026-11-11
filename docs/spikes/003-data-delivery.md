# Spike 003: delivering historical territory data (milestone 1.2)

> 2026-11-11. Measured on release `chronos-0.2.0-public-cliopatria-v0.2.1-wikidata-2026-11-11-5adf473e176e`: 12,064 territory rows, 229,026 render parts, 3.44 M vertices, 2.75 M triangles. Script: [`research/m1.2/delivery_options.py`](../../research/m1.2/delivery_options.py). Raw: [`results/2026-11-11-delivery.json`](results/2026-11-11-delivery.json).

## Measurements

| Option | Raw | gzip -9 | **brotli -11** | zstd -19 | Notes |
|---|---|---|---|---|---|
| **A. Single bundle, format 2** (full resolution + triangles) | 61.5 MiB | 23.5 | **7.12** | 9.44 | Today's bundle. `bundle.json` adds 0.04 MiB. |
| ↳ positions only | 26.3 | 13.4 | 1.12 | 1.26 | Repeated geometry across eras compresses well, but only with brotli/zstd's long windows. gzip's 32 KB window misses it. |
| ↳ triangles only | 31.5 | 9.0 | 5.38 | 7.03 | The cost of shipping triangles |
| **B. Without triangles** (browser triangulates, as in 1.1) | 29.1 | 14.1 | **1.71** | 1.83 | Smaller on the wire, but costs the memory and time-to-first-pick that 1.2 removed (spike 002) |
| **C. Lossless re-encoding:** triangles as per-part delta + zigzag, byte-shuffled | 61.5 | 10.8 | **3.37** | 3.49 | Triangles drop from 5.38 → **0.50** MiB brotli. Byte-shuffling *positions* hurts brotli (1.12 → 1.98), so the best mix is raw positions + delta triangles ≈ 2.5 MiB (estimated from the per-section figures). |
| **D. Time chunks** (250-year windows, rows overlapping each) | 22 chunks | | | | Duplication factor only 1.02 |
| ↳ chunk containing 117 CE | 1.74 | 0.50 | **0.21** | 0.28 | What a first view at 117 CE needs |
| ↳ largest chunk (1851–2100) | 19.7 | | | | Modern borders dominate the volume |
| **E. Mapbox Vector Tiles** z0–z5 (extent 4096, simplified to ½ tile pixel) | 590 tiles | 7.26 total | | | Built in 119 s (Python research code) |

**Vector tiles, per zoom level:**

| Zoom | Tiles | gzip MiB | Largest tile | Features per tile, mean / max | Simplification: mean / max area changed per feature |
|---|---|---|---|---|---|
| 0 | 1 | 0.88 | 903 KB | 12,064 / 12,064 | **506 / 3,362 km²** |
| 1 | 4 | 0.96 | 735 KB | 3,640 / 10,630 | 94 / 724 km² |
| 2 | 12 | 1.01 | 601 KB | 1,393 / 9,162 | 6.0 / 141 km² |
| 3 | 41 | 1.14 | 303 KB | 582 / 5,268 | 0.05 / 1.3 km² |
| 4 | 131 | 1.37 | 226 KB | 287 / 4,188 | 0.005 / 0.09 km² |
| 5 | 397 | 1.90 | 81 KB | 179 / 2,032 | 0.005 / 0.05 km² |

Area changes are measured in Web Mercator (EPSG:3857) on a 400-feature sample per zoom, so they're inflated at high latitudes. Treat them as orders of magnitude.

**Exact geometry repetition:** only 8.3% of rows (3.4% of vertices) repeat the previous row's geometry exactly, so merging identical rows would save little. brotli's gains come from *partially* repeated geometry (shared border stretches across eras).

## What this means

1. **Time, not space, is what's big.** Every spatial tile carries every era that touches it: the single z0 tile holds all 12,064 rows. Spatial tiling doesn't reduce what a time scrub needs; time slicing does.
2. **Tiles cost accuracy at the zooms where the globe lives.** At the globe's working zooms (≈ 1–3), tile simplification changes polygons by tens to thousands of km². Keeping full geometry in low-zoom tiles would rebuild the single bundle, one tile at a time.
3. **Tiles also undo the 1.2 rendering gains.** MVT polygons are triangulated in the browser per tile, which brings back the CPU and memory costs that pre-triangulation removed (spike 002).
4. **The single bundle is small when compressed correctly:** 7.1 MiB with brotli, about 2.5 MiB with delta-coded triangles. gzip is the wrong codec for this data (23.5 MiB).

## Recommendation (D-024)

**Now, at Cliopatria scale:** keep the **single full-resolution, pre-triangulated binary bundle**.
- Publish it **precompressed with brotli** (zstd as an alternative), under a content-hashed, immutable URL with long cache lifetimes.
- At the next format bump, add **delta + zigzag triangle indices** (lossless; about 7.1 → 2.5 MiB). It decodes with one prefix-sum pass.
- Not built in 1.2. It changes the bundle format, so it belongs with the first real loading path (1.3).

**When the first view's load time matters** (mobile, slow networks): add **time chunks**. Load the window around the opening year first (0.21 MiB for 117 CE), then prefetch outward along the timeline. The GPU year filter works unchanged on concatenated chunks.

**When data exceeds what one bundle should hold** (rough threshold: > 25–30 MiB compressed, or zoom > 7 detail such as OpenHistoricalMap borders, roads or cities): add **PMTiles** for those *high-zoom, regional* layers, keeping the global territory layer as is.
- Use custom binary, pre-triangulated tiles where the GPU year filter is needed.
- MVT is acceptable for points and lines.
- PMTiles keeps static hosting (HTTP range requests, no tile server), consistent with D-002.

**Not recommended:** MVT/PMTiles for the global territory layer, and a dynamic tile server. Neither fits the data's shape (time-heavy, globe-scale) nor today's size.

**Preserved:** the full-resolution source is untouched in `data/raw` (pinned, sha256-verified). Every option above is derived from it and can be regenerated.
