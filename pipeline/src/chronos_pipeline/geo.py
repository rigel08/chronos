"""Geometry helpers: equal-area measurement, local distances, TopoJSON decoding, render preparation."""
from __future__ import annotations

import json
import math
from functools import lru_cache
from pathlib import Path

import numpy as np
import pyproj
import shapely
from shapely.geometry import MultiPolygon, Polygon, box
from shapely.geometry.polygon import orient

EQUAL_AREA = "EPSG:6933"   # the projection Cliopatria uses for its Area field
_EA = pyproj.Transformer.from_crs("EPSG:4326", EQUAL_AREA, always_xy=True)


def _apply(transformer: pyproj.Transformer, geom):
    def fn(xy: np.ndarray) -> np.ndarray:
        x, y = transformer.transform(xy[:, 0], xy[:, 1])
        return np.column_stack([x, y])
    # Reprojection can introduce ring self-intersections, so repair afterwards (validation 0001).
    return shapely.make_valid(shapely.transform(geom, fn))


def to_equal_area(geom):
    return _apply(_EA, geom)


def area_km2(geom_ea) -> float:
    return float(shapely.area(geom_ea)) / 1e6


@lru_cache(maxsize=64)
def _aeqd(lon: float, lat: float) -> pyproj.Transformer:
    return pyproj.Transformer.from_crs("EPSG:4326", f"+proj=aeqd +lat_0={lat} +lon_0={lon} +units=m +datum=WGS84",
                                       always_xy=True)


def distance_km(geom, lon: float, lat: float) -> float:
    """Exact-enough distance from (lon, lat) to `geom`, in an azimuthal equidistant projection centred there."""
    return float(shapely.distance(_apply(_aeqd(round(lon, 6), round(lat, 6)), geom), shapely.Point(0, 0))) / 1000


def polygons(geom) -> list[Polygon]:
    """Polygon parts of any geometry (make_valid can return collections with lines and points)."""
    if geom is None or geom.is_empty:
        return []
    if isinstance(geom, Polygon):
        return [geom]
    out: list[Polygon] = []
    for g in getattr(geom, "geoms", []):
        out.extend(polygons(g))
    return [p for p in out if p.area > 0]


def topojson_land(path: Path):
    """Decode a world-atlas land TopoJSON file (quantized, delta-encoded arcs) into a valid MultiPolygon."""
    t = json.loads(path.read_text())
    (sx, sy), (tx, ty) = t["transform"]["scale"], t["transform"]["translate"]
    arcs = []
    for arc in t["arcs"]:
        a = np.cumsum(np.asarray(arc, dtype=np.float64), axis=0)
        arcs.append(np.column_stack([a[:, 0] * sx + tx, a[:, 1] * sy + ty]))

    def ring(indices: list[int]) -> np.ndarray:
        pieces = [arcs[i] if i >= 0 else arcs[~i][::-1] for i in indices]
        return np.vstack([pieces[0]] + [p[1:] for p in pieces[1:]])

    obj = t["objects"]["land"]
    geoms = obj["geometries"] if obj.get("type") == "GeometryCollection" else [obj]
    polys = []
    for g in geoms:
        for poly in (g["arcs"] if g["type"] == "MultiPolygon" else [g["arcs"]]):
            rings = [ring(r) for r in poly]
            polys.append(Polygon(rings[0], rings[1:]))
    return shapely.make_valid(MultiPolygon(polys))


def ice_free(geom):
    """Clip to north of 60 degrees S (excludes Antarctica), as in validation 0001."""
    return shapely.make_valid(shapely.intersection(geom, box(-180, -60, 180, 90)))


def render_parts(geom, grid_deg: float, simplify_deg: float = 0.0) -> list[Polygon]:
    """Polygons ready for rendering: optional simplification, split on a lon/lat grid, RFC 7946 winding.

    Splitting keeps every triangle within one grid cell so tessellated fills follow the globe's curvature
    (a 5 degree chord sags about 6 km below the sphere, under a pixel at globe zoom levels).
    """
    g = shapely.simplify(geom, simplify_deg, preserve_topology=True) if simplify_deg > 0 else geom
    out: list[Polygon] = []
    for poly in polygons(g):
        if grid_deg <= 0:
            out.append(orient(poly, sign=1.0))
            continue
        x0, y0, x1, y1 = poly.bounds
        xs = np.arange(math.floor(x0 / grid_deg) * grid_deg, x1, grid_deg)
        ys = np.arange(math.floor(y0 / grid_deg) * grid_deg, y1, grid_deg)
        if len(xs) <= 1 and len(ys) <= 1:
            pieces = [poly]
        else:
            cells = np.array([box(x, y, x + grid_deg, y + grid_deg) for x in xs for y in ys], dtype=object)
            pieces = [p for c in shapely.intersection(poly, cells) for p in polygons(c)]
        out.extend(orient(p, sign=1.0) for p in pieces)
    return out
