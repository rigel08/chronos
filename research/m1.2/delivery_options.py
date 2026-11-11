"""Milestone 1.2, spike 003: measure delivery options for historical territory geometry.

Research code. Reads the current public build (data/build/current) and the pinned Cliopatria input,
writes docs/spikes/results/<date>-delivery.json. Nothing here changes the pipeline or the bundle.

    uv run --no-project --python 3.11 --with 'shapely==2.1.*' --with 'pyproj==3.7.*' --with numpy \
        --with 'brotli==1.1.*' --with 'zstandard==0.23.*' --with 'mapbox-vector-tile==2.1.*' \
        python -I research/m1.2/delivery_options.py --repo . --out docs/spikes/results/<date>-delivery.json

Options measured:
  A. single bundle (format 2), whole and per section, gzip / brotli / zstd
  B. single bundle without triangles (browser triangulates): what shipping triangles costs on the wire
  C. byte-shuffled float32 positions and delta-coded triangle indices (still lossless)
  D. time-sliced chunks: rows overlapping each 250-year window; what a first view needs
  E. Mapbox Vector Tiles z0..5 (extent 4096) with per-zoom simplification: archive size, view bytes, and the
     geometric error that simplification introduces (the accuracy cost of tiles)
"""
from __future__ import annotations

import argparse
import gzip
import json
import math
import time
from pathlib import Path

import brotli
import numpy as np
import zstandard


def sizes(b: bytes) -> dict:
    return {"raw": len(b), "gzip9": len(gzip.compress(b, 9)), "brotli11": len(brotli.compress(b, quality=11)),
            "zstd19": len(zstandard.ZstdCompressor(level=19).compress(b))}


def mb(n: int) -> float:
    return round(n / 1048576, 2)


def shuffle(a: np.ndarray) -> bytes:
    """Byte-plane shuffle (as in Blosc): group the k-th byte of every element together."""
    return a.view(np.uint8).reshape(-1, a.dtype.itemsize).T.copy().tobytes()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", type=Path, default=Path("."))
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--max-zoom", type=int, default=5)
    a = ap.parse_args()
    build = a.repo / "data" / "build" / "current"
    bundle = json.loads((build / "bundle.json").read_text())
    raw = (build / "geometry.bin").read_bytes()
    secs = bundle["geometry"]["sections"]
    arr = {n: np.frombuffer(raw, s["dtype"], s["length"], s["offset"]) for n, s in secs.items()}
    meta = (build / "bundle.json").read_bytes()
    out: dict = {"release": bundle["release_id"], "geometry": {k: bundle["geometry"][k] for k in ("territories", "parts", "vertices", "triangles", "bytes")}}

    # A. whole bundle and per section
    t = time.time()
    out["A_single_bundle"] = {"geometry_bin": sizes(raw), "bundle_json": sizes(meta),
                              "per_section": {n: sizes(arr[n].tobytes()) for n in secs}}
    # B. without triangles
    no_tri = b"".join(arr[n].tobytes() for n in secs if n not in ("triangles", "part_triangle_start"))
    out["B_without_triangles"] = sizes(no_tri)
    # C. lossless re-encodings
    tri = arr["triangles"].astype(np.int64)
    pts = arr["part_triangle_start"]
    tri_local = tri.copy()
    rs, prs = arr["ring_start"], arr["part_ring_start"]
    for p in range(len(pts) - 1):                     # indices relative to the part's first vertex
        tri_local[pts[p]:pts[p + 1]] -= int(rs[prs[p]])
    tri_delta = np.diff(np.concatenate([[0], tri_local])).astype(np.int32)
    zig = ((tri_delta << 1) ^ (tri_delta >> 31)).astype(np.uint32)
    enc = shuffle(arr["positions"]) + shuffle(zig) + b"".join(arr[n].tobytes() for n in secs if n not in ("positions", "triangles"))
    out["C_shuffled_delta"] = {"positions_shuffled": sizes(shuffle(arr["positions"])), "triangles_local_delta_zigzag_shuffled": sizes(shuffle(zig)),
                               "whole": sizes(enc)}
    out["timing_A_to_C_s"] = round(time.time() - t, 1)

    # D. time-sliced chunks: each chunk carries every territory row overlapping its window
    starts, ends = arr["territory_start"], arr["territory_end"]
    part_terr = arr["part_territory"]
    window = 250
    lo, hi = int(starts.min()), int(ends.max())
    chunks = []
    for w0 in range(lo, hi + 1, window):
        w1 = w0 + window - 1
        terr = np.nonzero((starts <= w1) & (ends >= w0))[0]
        parts = np.nonzero(np.isin(part_terr, terr))[0]
        verts = int(sum(rs[prs[p + 1]] - rs[prs[p]] for p in parts))
        tris = int(sum(pts[p + 1] - pts[p] for p in parts)) // 3
        nbytes = verts * 8 + tris * 12 + len(parts) * 12 + len(terr) * 20      # positions + triangles + part/territory arrays
        chunks.append({"from": w0, "to": w1, "territories": int(len(terr)), "parts": int(len(parts)), "vertices": verts,
                       "triangles": tris, "raw_bytes_est": nbytes})
    total_dup = sum(c["raw_bytes_est"] for c in chunks)
    first = next(c for c in chunks if c["from"] <= 117 <= c["to"])
    # compressed size of the 117 CE chunk, measured on the real arrays
    terr = np.nonzero((starts <= first["to"]) & (ends >= first["from"]))[0]
    parts = np.nonzero(np.isin(part_terr, terr))[0]
    vsel = np.concatenate([np.arange(rs[prs[p]], rs[prs[p + 1]]) for p in parts])
    tsel = np.concatenate([np.arange(pts[p], pts[p + 1]) for p in parts])
    chunk_bytes = arr["positions"].reshape(-1, 2)[vsel].tobytes() + arr["triangles"][tsel].tobytes()
    out["D_time_chunks"] = {"window_years": window, "chunks": len(chunks), "sum_raw_with_duplication_MB": mb(total_dup),
                            "duplication_factor": round(total_dup / max(1, len(raw)), 2), "largest_chunk": max(chunks, key=lambda c: c["raw_bytes_est"]),
                            "chunk_for_117ce": first, "chunk_for_117ce_measured": sizes(chunk_bytes), "all": chunks}

    # E. vector tiles (MVT) with per-zoom simplification, built from the full-resolution source rows
    out["E_vector_tiles"] = vector_tiles(a.repo, a.max_zoom)
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(json.dumps(out, indent=1) + "\n")
    print(json.dumps({k: v for k, v in out.items() if k not in ("D_time_chunks",)}, indent=1)[:6000])
    print("D:", {k: v for k, v in out["D_time_chunks"].items() if k != "all"})


def vector_tiles(repo: Path, max_zoom: int) -> dict:
    import mapbox_vector_tile
    import pyproj
    import shapely
    from shapely.geometry import box, shape
    from shapely.strtree import STRtree

    man = json.loads((repo / "data" / "manifest.lock.json").read_text())["sources"]["cliopatria"]
    src = repo / "data" / "raw" / "cliopatria" / man["release"] / "members" / "cliopatria_polities_only_v021.geojson"
    feats = [f for f in json.loads(src.read_text())["features"]
             if f["properties"]["Type"] == "POLITY" and not f["properties"]["Name"].startswith("(")]
    to3857 = pyproj.Transformer.from_crs("EPSG:4326", "EPSG:3857", always_xy=True)
    R = 20037508.342789244

    def proj(g):
        def fn(xy):
            x, y = to3857.transform(xy[:, 0], np.clip(xy[:, 1], -85.0511, 85.0511))
            return np.column_stack([x, y])
        return shapely.make_valid(shapely.transform(g, fn))

    t0 = time.time()
    geoms = [proj(shapely.make_valid(shape(f["geometry"]))) for f in feats]
    props = [(int(f["properties"]["FromYear"]), int(f["properties"]["ToYear"])) for f in feats]
    tree = STRtree(geoms)
    per_zoom = {}
    errors = {}
    for z in range(0, max_zoom + 1):
        n = 2 ** z
        size = 2 * R / n
        tol = size / 4096 * 0.5                     # half a tile pixel at extent 4096
        tiles, total, biggest, feats_per_tile = 0, 0, 0, []
        sample_err = []
        for tx in range(n):
            for ty in range(n):
                x0, y1 = -R + tx * size, R - ty * size
                tb = box(x0, y1 - size, x0 + size, y1)
                cand = tree.query(tb)
                if len(cand) == 0:
                    continue
                clipped = shapely.clip_by_rect(np.asarray([geoms[i] for i in cand], dtype=object), x0, y1 - size, x0 + size, y1)
                layer = []
                for i, g in zip(cand, clipped, strict=True):
                    if g.is_empty:
                        continue
                    s = shapely.simplify(g, tol, preserve_topology=True)
                    if s.is_empty:
                        continue
                    if len(sample_err) < 400 and g.area > 0:
                        sample_err.append(abs(shapely.area(shapely.symmetric_difference(g, s))) / 1e6)
                    layer.append({"geometry": s, "properties": {"s": props[i][0], "e": props[i][1], "row": int(i)}})
                if not layer:
                    continue
                pbf = mapbox_vector_tile.encode([{"name": "territories", "features": layer}],
                                                default_options={"quantize_bounds": (x0, y1 - size, x0 + size, y1), "extents": 4096})
                gz = len(gzip.compress(pbf, 6))
                tiles += 1
                total += gz
                biggest = max(biggest, gz)
                feats_per_tile.append(len(layer))
        per_zoom[z] = {"tiles": tiles, "gzip_total_MB": mb(total), "largest_tile_KB": round(biggest / 1024, 1),
                       "features_per_tile_mean": round(float(np.mean(feats_per_tile)), 1) if feats_per_tile else 0,
                       "features_per_tile_max": int(max(feats_per_tile)) if feats_per_tile else 0,
                       "simplify_tolerance_m": round(tol, 1)}
        errors[z] = {"sampled_features": len(sample_err),
                     "mean_area_changed_km2": round(float(np.mean(sample_err)), 3) if sample_err else 0,
                     "max_area_changed_km2": round(float(np.max(sample_err)), 3) if sample_err else 0}
        print(f"z{z}: {per_zoom[z]} | simplification error {errors[z]}", flush=True)
    total_archive = sum(v["gzip_total_MB"] for v in per_zoom.values())
    # Bytes a client needs: globe overview ~ all z1 tiles (4); a regional view at z4 ~ 4 x 3 tiles (worst case: Europe)
    return {"source_rows": len(feats), "max_zoom": max_zoom, "per_zoom": per_zoom, "simplification_error": errors,
            "archive_gzip_MB_sum": round(total_archive, 2), "build_seconds": round(time.time() - t0, 1),
            "note": "Every tile carries every year's rows that touch it; the GPU year filter then needs per-feature "
                    "start/end in the tile. Geometry beyond max_zoom is over-zoomed from max_zoom tiles."}


if __name__ == "__main__":
    main()
