"""Render meshes for bundle format 3: territories and overlap regions (D-017, D-021, D-025, D-026).

A mesh is a list of owners (territory rows or overlap regions). Each owner's geometry is split on the
`grid_split_deg` grid, triangulated in Web Mercator on float32 coordinates and checked against its own area
(QA-013). Territories also carry per-vertex edge flags: bit 0 marks the edge from this vertex to the next as
synthetic (a grid cut or the antimeridian), so outlines can follow real borders only.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

import numpy as np
import shapely

from .geo import densify, polygons, render_parts, triangulate
from .qa.findings import Finding

EDGE_SYNTHETIC = 1


@dataclass
class Mesh:
    positions: np.ndarray          # <f4, 2 per vertex
    ring_start: np.ndarray         # <u4, rings + 1
    part_ring_start: np.ndarray    # <u4, parts + 1
    part_owner: np.ndarray         # <u4, parts
    triangles: np.ndarray          # <u4 global vertex indices
    part_triangle_start: np.ndarray  # <u4, parts + 1 (index counts)
    edge_flags: np.ndarray | None  # |u1 per vertex, territories only
    stats: dict

    @property
    def part_first_vertex(self) -> np.ndarray:
        return self.ring_start[self.part_ring_start[:-1]]


def _edge_flags(ring: np.ndarray, original, grid_deg: float) -> np.ndarray:
    a, b = ring[:-1], ring[1:]
    flags = np.zeros(len(ring), np.uint8)
    if len(ring) < 2:
        return flags
    dateline = (np.abs(a[:, 0]) == 180.0) & (a[:, 0] == b[:, 0])
    on_grid = np.zeros(len(a), bool)
    if grid_deg > 0:
        on_grid = ((a[:, 0] == b[:, 0]) & (np.mod(a[:, 0], grid_deg) == 0)) | \
                  ((a[:, 1] == b[:, 1]) & (np.mod(a[:, 1], grid_deg) == 0))
    cand = on_grid & ~dateline
    synthetic = dateline.copy()
    if cand.any():
        mid = (a[cand] + b[cand]) / 2.0
        synthetic[cand] = shapely.contains_xy(original, mid[:, 0], mid[:, 1])
    flags[:-1] = np.where(synthetic, EDGE_SYNTHETIC, 0)
    return flags


def build_mesh(owners: list[tuple[Any, str, str]], render_cfg: dict, with_edge_flags: bool,
               subject_type: str) -> tuple[Mesh, list[Finding]]:
    """`owners`: (geometry, subject id, human label) per owner, in output order."""
    grid = render_cfg["grid_split_deg"]
    warn_km2, error_km2 = render_cfg["triangulation_warn_km2"], render_cfg["triangulation_error_km2"]
    positions: list[np.ndarray] = []
    triangles: list[np.ndarray] = []
    flags: list[np.ndarray] = []
    ring_start, part_ring_start, part_triangle_start = [0], [0], [0]
    part_owner: list[int] = []
    nverts = ntri_idx = 0
    findings: list[Finding] = []
    worst_rel = worst_km2 = total_km2 = 0.0
    repaired = fallbacks = 0
    for oi, (geom, sid, where_label) in enumerate(owners):
        if with_edge_flags:
            shapely.prepare(geom)
        for poly in render_parts(geom, grid, render_cfg["simplify_deg"]):
            rings = [np.asarray(ring.coords, dtype=np.float64)[:, :2].astype("<f4").astype(np.float64)
                     for ring in [poly.exterior, *poly.interiors]]
            # long real borders follow the lon/lat line on the globe (D-028); grid cuts are shared chords and stay as they are
            max_edge = float(render_cfg.get("max_edge_deg", 0.0))
            if max_edge > 0:
                rings = [densify(r, max_edge, (_edge_flags(r, geom, grid) & EDGE_SYNTHETIC) == 0 if with_edge_flags else None)
                         for r in rings]
            for piece in triangulate(rings):
                part = len(part_owner)
                worst_rel, worst_km2 = max(worst_rel, piece.relative_deviation), max(worst_km2, piece.absolute_km2)
                total_km2 += piece.absolute_km2
                repaired += piece.repaired
                fallbacks += piece.method != "earcut"
                detail = {"part": part, "relative_deviation": piece.relative_deviation,
                          "absolute_km2": round(piece.absolute_km2, 6), "method": piece.method, "repaired": piece.repaired}
                where = f"{where_label}, render part {part}"
                if piece.absolute_km2 > error_km2:
                    findings.append(Finding("QA-013", "error", subject_type, sid,
                                            f"{where}: triangles mis-draw {piece.absolute_km2:,.2f} km².", detail))
                elif piece.absolute_km2 > warn_km2:
                    findings.append(Finding("QA-013", "warning", subject_type, sid,
                                            f"{where}: triangles mis-draw {piece.absolute_km2:,.3f} km².", detail))
                if piece.repaired:
                    findings.append(Finding("QA-013", "warning", subject_type, sid,
                                            f"{where}: invalid in the triangulation plane (Web Mercator, float32); repaired "
                                            "with make_valid before triangulation.", detail))
                triangles.append(piece.indices + np.uint32(nverts))
                ntri_idx += len(piece.indices)
                part_triangle_start.append(ntri_idx)
                for c in piece.rings:
                    positions.append(c)
                    if with_edge_flags:
                        flags.append(_edge_flags(c, geom, grid))
                    nverts += len(c)
                    ring_start.append(nverts)
                part_ring_start.append(len(ring_start) - 1)
                part_owner.append(oi)
    empty2 = np.zeros((0, 2))
    mesh = Mesh(
        positions=np.concatenate(positions or [empty2]).astype("<f4").ravel(),
        ring_start=np.asarray(ring_start, dtype="<u4"),
        part_ring_start=np.asarray(part_ring_start, dtype="<u4"),
        part_owner=np.asarray(part_owner, dtype="<u4"),
        triangles=np.concatenate(triangles or [np.zeros(0, np.uint32)]).astype("<u4"),
        part_triangle_start=np.asarray(part_triangle_start, dtype="<u4"),
        edge_flags=np.concatenate(flags).astype(np.uint8) if with_edge_flags else None,
        stats={"owners": len(owners), "parts": len(part_owner), "rings": len(ring_start) - 1, "vertices": nverts,
               "triangles": int(ntri_idx // 3)})
    findings.insert(0, Finding("QA-013", "info", "dataset", f"render:{subject_type}",
                               f"{len(part_owner):,} {subject_type} render parts triangulated in Web Mercator ({fallbacks} "
                               f"with constrained Delaunay, {repaired} repaired). Largest mis-drawn area {worst_km2:.4f} "
                               f"km²; total {total_km2:.3f} km².",
                               {"parts": len(part_owner), "triangles": int(ntri_idx // 3), "max_relative_deviation": worst_rel,
                                "max_absolute_km2": round(worst_km2, 6), "total_absolute_km2": round(total_km2, 6),
                                "constrained_delaunay_fallbacks": fallbacks, "repaired_parts": repaired,
                                "warn_km2": warn_km2, "error_km2": error_km2}))
    return mesh, findings


def label_points(geoms: list, tolerance_deg: float) -> np.ndarray:
    """A point well inside each geometry's largest part (pole of inaccessibility): <f4, 2 per geometry."""
    out = np.zeros((len(geoms), 2), np.float64)
    for i, g in enumerate(geoms):
        parts = polygons(g)
        if not parts:
            continue
        big = max(parts, key=lambda p: p.area * math.cos(math.radians(p.centroid.y)))
        c = shapely.get_point(shapely.maximum_inscribed_circle(big, tolerance_deg), 0)
        out[i] = (c.x, c.y)
    return out.astype("<f4")
