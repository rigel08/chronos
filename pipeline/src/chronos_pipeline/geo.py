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


# --------------------------------------------------------------------------- triangulation (D-021)

MERCATOR_MAX_LAT = 85.051129


def web_mercator(lonlat: np.ndarray) -> np.ndarray:
    """deck.gl's common space for lng/lat (projectFlat): Web Mercator scaled to a 512-unit world.

    deck.gl triangulates lng/lat polygons in this space, so pre-triangulating here keeps parity with the
    renderer's own behaviour (milestone 1.2).
    """
    lon = lonlat[:, 0]
    lat = np.clip(lonlat[:, 1], -MERCATOR_MAX_LAT, MERCATOR_MAX_LAT)
    x = (lon + 180.0) / 360.0 * 512.0
    y = (180.0 - np.degrees(np.log(np.tan(np.pi / 4 + np.radians(lat) / 2)))) / 360.0 * 512.0
    return np.column_stack([x, y])


def inverse_web_mercator(xy: np.ndarray) -> np.ndarray:
    lon = xy[:, 0] / 512.0 * 360.0 - 180.0
    lat = np.degrees(2 * np.arctan(np.exp(np.radians(180.0 - xy[:, 1] / 512.0 * 360.0))) - np.pi / 2)
    return np.column_stack([lon, lat])


KM_PER_MERCATOR_UNIT = 40075.017 / 512.0   # at the equator; times cos(latitude) elsewhere


def _shoelace(xy: np.ndarray) -> float:
    x, y = xy[:, 0], xy[:, 1]
    return 0.5 * float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))


def _deviation(merc: list[np.ndarray], idx: np.ndarray) -> tuple[float, float]:
    """(relative, absolute) area difference between triangles and polygon, absolute in Mercator units squared."""
    verts = np.vstack(merc)
    polygon_area = abs(_shoelace(merc[0])) - sum(abs(_shoelace(h)) for h in merc[1:])
    t = verts[idx.reshape(-1, 3)] if len(idx) else np.zeros((0, 3, 2))
    tri_area = float(np.abs(0.5 * ((t[:, 1, 0] - t[:, 0, 0]) * (t[:, 2, 1] - t[:, 0, 1])
                                   - (t[:, 2, 0] - t[:, 0, 0]) * (t[:, 1, 1] - t[:, 0, 1]))).sum())
    diff = abs(tri_area - polygon_area)
    rel = diff / polygon_area if polygon_area > 0 else (0.0 if diff == 0 else 1.0)
    return rel, diff


def _earcut(merc: list[np.ndarray]) -> np.ndarray:
    import mapbox_earcut
    ends = np.cumsum([len(r) for r in merc]).astype(np.uint32)
    return mapbox_earcut.triangulate_float64(np.vstack(merc), ends).astype(np.uint32)


def _constrained_delaunay(merc: list[np.ndarray]) -> np.ndarray | None:
    """GEOS constrained Delaunay in the same plane; None if it introduced vertices we cannot index."""
    verts = np.vstack(merc)
    lookup: dict[tuple[float, float], int] = {}
    for i, (x, y) in enumerate(verts):
        lookup.setdefault((float(x), float(y)), i)
    tris = shapely.constrained_delaunay_triangles(Polygon(merc[0], merc[1:]))
    out: list[int] = []
    for tri in getattr(tris, "geoms", []):
        for x, y in list(tri.exterior.coords)[:3]:
            j = lookup.get((float(x), float(y)))
            if j is None:
                return None
            out.append(j)
    return np.asarray(out, dtype=np.uint32)


class RenderPiece:
    """One renderable polygon: float32-exact lon/lat rings, triangle indices into them, and its quality."""

    __slots__ = ("rings", "indices", "relative_deviation", "absolute_km2", "method", "repaired")

    def __init__(self, rings, indices, relative_deviation, absolute_km2, method, repaired):
        self.rings, self.indices = rings, indices
        self.relative_deviation, self.absolute_km2 = relative_deviation, absolute_km2
        self.method, self.repaired = method, repaired


def triangulate(rings: list[np.ndarray], fallback_rel: float = 1e-9) -> list[RenderPiece]:
    """Triangulate one render part in Web Mercator, deck.gl's triangulation plane (D-021, QA-013).

    `rings` are float32-exact lon/lat rings (exterior first). A part that is invalid in the Mercator plane
    (lon/lat validity does not survive the projection or float32 rounding) is repaired with make_valid in
    that plane and may become several pieces. Earcut is tried first; if its triangles do not reproduce the
    polygon's area, GEOS constrained Delaunay is used when it does better. The remaining error is reported,
    never hidden.
    """
    merc = [web_mercator(r) for r in rings]
    mpoly = Polygon(merc[0], merc[1:])
    candidates: list[tuple[list[np.ndarray], bool]]
    if mpoly.is_valid:
        candidates = [(rings, False)]
    else:
        candidates = []
        for q in polygons(shapely.make_valid(mpoly)):
            ll = [inverse_web_mercator(np.asarray(r.coords)[:, :2]).astype("<f4").astype(np.float64)
                  for r in [q.exterior, *q.interiors]]
            candidates.append((ll, True))
    pieces = []
    for ll, repaired in candidates:
        m = [web_mercator(r) for r in ll]
        idx, method = _earcut(m), "earcut"
        rel, absu = _deviation(m, idx)
        if rel > fallback_rel:
            cdt = _constrained_delaunay(m)
            if cdt is not None:
                rel2, abs2 = _deviation(m, cdt)
                if abs2 < absu:
                    idx, rel, absu, method = cdt, rel2, abs2, "constrained-delaunay"
        lat = float(np.mean(ll[0][:, 1]))
        km2 = absu * (KM_PER_MERCATOR_UNIT * np.cos(np.radians(lat))) ** 2
        pieces.append(RenderPiece(ll, orient_outward(np.vstack(ll), idx), rel, km2, method, repaired))
    return pieces


def globe_xyz(lonlat: np.ndarray) -> np.ndarray:
    """deck.gl's globe common space (project_globe_ in its project shader), on the unit sphere."""
    lam, phi = np.radians(lonlat[:, 0]), np.radians(lonlat[:, 1])
    return np.column_stack([np.sin(lam) * np.cos(phi), -np.cos(lam) * np.cos(phi), np.sin(phi)])


def orient_outward(lonlat: np.ndarray, idx: np.ndarray) -> np.ndarray:
    """Make every triangle face outward as deck.gl draws it on the globe: a flat triangle through its three
    projected vertices, with its normal pointing away from the Earth's centre (milestone 1.3, D-028).

    For ordinary triangles this is the same as counter-clockwise in lon/lat (D-022). It differs for long slivers,
    typically along a cut on a parallel at high latitude: counter-clockwise in lon/lat, but facing inward once
    their vertices sit on the sphere, so back-face culling removed them and left a gap (spike 002's "seams").
    Triangles that are degenerate in 3D keep their lon/lat orientation.
    """
    if len(idx) == 0:
        return idx
    t = orient_ccw(lonlat, idx).reshape(-1, 3).copy()
    xyz = globe_xyz(lonlat)
    a, b, c = xyz[t[:, 0]], xyz[t[:, 1]], xyz[t[:, 2]]
    facing = np.einsum("ij,ij->i", np.cross(b - a, c - a), a + b + c)
    flip = facing < 0
    t[flip, 1], t[flip, 2] = t[flip, 2], t[flip, 1].copy()
    return t.reshape(-1).astype(np.uint32)


def densify(ring: np.ndarray, max_deg: float, mask: np.ndarray | None = None) -> np.ndarray:
    """Insert points so no edge (where `mask` allows) is longer than `max_deg` degrees, on the lon/lat straight line.

    GeoJSON edges are straight in lon/lat; deck.gl draws each edge as a straight chord in 3D on the globe. A long
    chord drifts from the lon/lat line (up to about 5 km for a 5-degree edge at mid-latitudes), so long real borders
    are densified (milestone 1.3, D-028). Inserted points are float32-rounded like every rendered vertex.
    """
    if max_deg <= 0 or len(ring) < 2:
        return ring
    a, b = ring[:-1], ring[1:]
    length = np.hypot(b[:, 0] - a[:, 0], b[:, 1] - a[:, 1])
    n = np.where(length > max_deg, np.ceil(length / max_deg), 1).astype(int)
    if mask is not None:
        n = np.where(mask[:-1], n, 1)
    if (n == 1).all():
        return ring
    out = [ring[:1]]
    for i in range(len(a)):
        k = n[i]
        if k > 1:
            f = (np.arange(1, k) / k)[:, None]
            out.append((a[i] + (b[i] - a[i]) * f).astype("<f4").astype(np.float64))
        out.append(ring[i + 1:i + 2])
    return np.vstack(out)


def orient_ccw(lonlat: np.ndarray, idx: np.ndarray) -> np.ndarray:
    """Make every triangle counter-clockwise in lon/lat (north up), so no renderer's face culling can hide one.

    Earcut and GEOS return triangles in whichever orientation their plane produced; Web Mercator here has
    y pointing south. Degenerate (zero-area) triangles are left as they are.
    """
    if len(idx) == 0:
        return idx
    t = idx.reshape(-1, 3).copy()
    a, b, c = lonlat[t[:, 0]], lonlat[t[:, 1]], lonlat[t[:, 2]]
    cross = (b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1]) - (c[:, 0] - a[:, 0]) * (b[:, 1] - a[:, 1])
    flip = cross < 0
    t[flip, 1], t[flip, 2] = t[flip, 2], t[flip, 1].copy()
    return t.reshape(-1).astype(np.uint32)
