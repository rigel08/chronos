"""Physical basemap for the Strata stage (milestone 1.3): Natural Earth land, coastline, lakes, rivers and relief.

The basemap is modern physical geography (Natural Earth, public domain), shown as context only. Territories
never depend on it.

Relief: Natural Earth 1:50m shaded relief (8-bit, flat ground = `flat`) becomes transparent hillshade tiles in
Web Mercator. Pixels darker than flat ground become shadow colour, brighter ones highlight colour, with alpha
proportional to the departure from flat. Flat ground and sea stay fully transparent, so the hillshade can sit
above the territory fills without tinting them.
"""
from __future__ import annotations

import hashlib
import io
import json
from pathlib import Path

import numpy as np
import shapely
from shapely.geometry import LineString, MultiLineString, MultiPolygon, mapping

from .geo import polygons


def _round(geom: dict, nd: int) -> dict:
    def r(c):
        if not c:
            return []
        if isinstance(c[0], (int, float)):
            return [round(float(c[0]), nd), round(float(c[1]), nd)]
        return [x for x in (r(y) for y in c) if x]          # drops empty parts (Natural Earth has a few)
    return {"type": geom["type"], "coordinates": r(geom["coordinates"])}


def _has_coords(geom: dict | None) -> bool:
    def any_point(c) -> bool:
        return bool(c) and (isinstance(c[0], (int, float)) or any(any_point(x) for x in c))
    return geom is not None and any_point(geom.get("coordinates"))


def coastline(land) -> MultiLineString:
    """Land boundaries without the artificial edges Natural Earth adds at the antimeridian and the south pole."""
    lines = []
    for poly in polygons(land):
        for ring in [poly.exterior, *poly.interiors]:
            c = np.asarray(ring.coords)[:, :2]
            artificial = ((np.abs(c[:-1, 0]) >= 179.9999) & (np.abs(c[1:, 0]) >= 179.9999)) | \
                         ((c[:-1, 1] <= -89.9999) & (c[1:, 1] <= -89.9999))
            run: list[np.ndarray] = []
            for i, bad in enumerate(artificial):
                if bad:
                    if len(run) >= 2:
                        lines.append(LineString(np.vstack(run)))
                    run = []
                else:
                    if not run:
                        run.append(c[i])
                    run.append(c[i + 1])
            if len(run) >= 2:
                lines.append(LineString(np.vstack(run)))
    return MultiLineString(lines)


def dropped_features(fc: dict) -> list[str]:
    """Names of features without any coordinates (Natural Earth 1:50m v5.1.2 has one: the Loire)."""
    return sorted(str(f["properties"].get("name")) for f in fc["features"] if not _has_coords(f.get("geometry")))


def vector_layers(land, lakes_fc: dict, rivers_fc: dict, nd: int = 4) -> dict:
    def fc(features):
        return {"type": "FeatureCollection", "features": features}
    lakes = [{"type": "Feature", "properties": {"r": int(f["properties"].get("scalerank") or 0)},
              "geometry": _round(mapping(shapely.make_valid(shapely.geometry.shape(f["geometry"]))), nd)}
             for f in lakes_fc["features"] if _has_coords(f.get("geometry"))]
    rivers = [{"type": "Feature", "properties": {"r": int(f["properties"].get("scalerank") or 0)},
               "geometry": _round(f["geometry"], nd)}
              for f in rivers_fc["features"] if _has_coords(f.get("geometry"))]
    land = MultiPolygon(polygons(land))          # make_valid can return a collection with stray lines
    return {"land": fc([{"type": "Feature", "properties": {}, "geometry": _round(mapping(land), nd)}]),
            "coastline": fc([{"type": "Feature", "properties": {}, "geometry": _round(mapping(coastline(land)), nd)}]),
            "lakes": fc(lakes), "rivers": fc(rivers)}


def _world_file(path: Path) -> tuple[float, float, float, float]:
    a, _, _, e, c, f = (float(x) for x in path.read_text().split())
    return a, e, c, f          # pixel width, pixel height (negative), x and y of the upper-left pixel centre


def hillshade_tiles(tif: Path, tfw: Path, out_dir: Path, cfg: dict) -> dict:
    """Write {z}/{x}/{y}.webp tiles; returns the tile manifest (count, bytes, sha256 over all tiles)."""
    from PIL import Image
    Image.MAX_IMAGE_PIXELS = None
    src = np.asarray(Image.open(tif), dtype=np.float32)
    h, w = src.shape
    px, py, x0, y0 = _world_file(tfw)
    flat, lo, hi = float(cfg["flat"]), float(src.min()), float(src.max())
    shadow_rgb = np.array([int(cfg["shadow_rgb"][i:i + 2], 16) for i in (1, 3, 5)], np.uint8)
    light_rgb = np.array([int(cfg["highlight_rgb"][i:i + 2], 16) for i in (1, 3, 5)], np.uint8)
    size = int(cfg["tile_size"])
    digest = hashlib.sha256()
    count, total = 0, 0
    for z in range(int(cfg["minzoom"]), int(cfg["maxzoom"]) + 1):
        n = 2 ** z
        world = size * n
        for ty in range(n):
            yy = (ty * size + np.arange(size) + 0.5) / world
            lat = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * yy))))
            fr = (lat - y0) / py                                  # fractional source row
            for tx in range(n):
                xx = (tx * size + np.arange(size) + 0.5) / world
                lon = xx * 360.0 - 180.0
                fc = (lon - x0) / px
                v = _bilinear(src, fr, fc, h, w)
                dead = float(cfg["deadband"])                         # flat ground varies by a few levels
                dark = np.clip((flat - dead - v) / (flat - dead - lo), 0, 1) ** float(cfg["gamma"]) * float(cfg["shadow_alpha"])
                light = np.clip((v - flat - dead) / (hi - flat - dead), 0, 1) ** float(cfg["gamma"]) * float(cfg["highlight_alpha"])
                rgba = np.zeros((size, size, 4), np.uint8)
                is_dark = dark >= light
                rgba[..., :3] = np.where(is_dark[..., None], shadow_rgb, light_rgb)
                step = 256 // int(cfg["alpha_levels"])
                rgba[..., 3] = (np.round(np.where(is_dark, dark, light) * 255 / step) * step).clip(0, 255).astype(np.uint8)
                rgba[rgba[..., 3] == 0, :3] = 0                       # fully transparent pixels: one value, compresses away
                buf = io.BytesIO()
                Image.fromarray(rgba, "RGBA").save(buf, "WEBP", quality=int(cfg["webp_quality"]),
                                                   alpha_quality=int(cfg["webp_alpha_quality"]), method=4)
                data = buf.getvalue()
                p = out_dir / str(z) / str(tx) / f"{ty}.webp"
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes(data)
                digest.update(f"{z}/{tx}/{ty}:".encode() + hashlib.sha256(data).digest())
                count += 1
                total += len(data)
    return {"tiles": count, "bytes": total, "sha256": digest.hexdigest()}


def _bilinear(src: np.ndarray, fr: np.ndarray, fc: np.ndarray, h: int, w: int) -> np.ndarray:
    r = np.clip(fr, 0, h - 1)
    c = fc % w                                                # wraps across the antimeridian
    r0 = np.floor(r).astype(np.int64)
    c0 = np.floor(c).astype(np.int64)
    r1 = np.minimum(r0 + 1, h - 1)
    c1 = (c0 + 1) % w
    dr = (r - r0)[:, None]
    dc = (c - c0)[None, :]
    a = src[np.ix_(r0, c0)]
    b = src[np.ix_(r0, c1)]
    cc = src[np.ix_(r1, c0)]
    d = src[np.ix_(r1, c1)]
    return (a * (1 - dc) + b * dc) * (1 - dr) + (cc * (1 - dc) + d * dc) * dr


def dumps(obj) -> bytes:
    return json.dumps(obj, separators=(",", ":"), sort_keys=True, ensure_ascii=False).encode()
