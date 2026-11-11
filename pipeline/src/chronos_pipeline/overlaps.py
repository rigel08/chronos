"""Overlapping territories across all years, and the neighbour graph used for colouring (milestone 1.3, D-026).

An overlap region is the ground two (or more) base rows both cover while both are valid. Its span is the
intersection of their year ranges. Regions are classed with QA-004's rule (linked / sliver / unlinked); a
region shared by three or more rows is "multiple". Nothing here decides who held the ground: the display
shows every claimant (stripes), and the card names them.
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field

import numpy as np
import shapely
from shapely.strtree import STRtree

from .geo import area_km2, polygons, to_equal_area
from .qa.findings import Finding
from .years import label


@dataclass
class Region:
    rows: tuple[int, ...]            # indices into `base`, sorted
    start: int
    end: int
    geom: object                     # lon/lat (Multi)Polygon
    km2: float
    kind: str                        # linked | sliver | unlinked | multiple
    linked_by: list[str] = field(default_factory=list)


def candidate_pairs(geoms: np.ndarray, starts: np.ndarray, ends: np.ndarray, polity: np.ndarray,
                    pad_deg: float = 0.0) -> tuple[np.ndarray, np.ndarray]:
    """Row pairs (i < j) of different polities whose boxes (padded) meet while both are valid. Cheap filters only."""
    boxes = np.asarray(shapely.box(*np.asarray(shapely.bounds(geoms)).T))
    query = shapely.buffer(boxes, pad_deg, join_style="mitre") if pad_deg > 0 else boxes
    a, b = STRtree(boxes).query(query)
    keep = (a < b) & (starts[a] <= ends[b]) & (starts[b] <= ends[a]) & (polity[a] != polity[b])
    return a[keep], b[keep]


def _linked(names_a: str, names_b: str, start: int, end: int, aggs: list, member_of: dict[str, set[str]]) -> list[str]:
    out = [g.name for g in aggs if g.start <= end and g.end >= start and names_a in g.components and names_b in g.components]
    if names_b in member_of.get(names_a, set()) or names_a in member_of.get(names_b, set()):
        out.append("MemberOf")
    return sorted(set(out))


def overlap_regions(base: list, polity_of_row: dict, aggs: list, sliver_km2: float, sliver_fraction: float,
                    max_level: int = 4) -> tuple[list[Region], list[Finding]]:
    geoms = np.array([r.geometry for r in base], dtype=object)
    shapely.prepare(geoms)
    starts = np.array([r.start for r in base])
    ends = np.array([r.end for r in base])
    pid = np.array([polity_of_row[r.index][0] for r in base], dtype=object)
    a, b = candidate_pairs(geoms, starts, ends, pid)
    inside = shapely.relate_pattern(geoms[a], geoms[b], "T********") if len(a) else np.zeros(0, bool)
    a, b = a[inside], b[inside]
    member_of: dict[str, set[str]] = defaultdict(set)
    for r in base:
        member_of[r.name].update(r.member_of)
    own_km2 = {}
    regions: list[Region] = []
    for i, j, g in zip(a, b, shapely.intersection(geoms[a], geoms[b]), strict=True):
        parts = polygons(g)
        if not parts:
            continue
        geom = shapely.union_all(parts) if len(parts) > 1 else parts[0]
        km2 = area_km2(to_equal_area(geom))
        if km2 <= 0:
            continue
        for k in (i, j):
            if k not in own_km2:
                own_km2[k] = float(base[k].area_src)
        s, e = int(max(starts[i], starts[j])), int(min(ends[i], ends[j]))
        linked = _linked(base[i].name, base[j].name, s, e, aggs, member_of)
        smaller = min(own_km2[i], own_km2[j]) or km2
        kind = "linked" if linked else ("sliver" if km2 < sliver_km2 or km2 / smaller < sliver_fraction else "unlinked")
        regions.append(Region((int(i), int(j)), s, e, geom, km2, kind, linked))
    by_level = {2: regions}
    findings: list[Finding] = []
    seen = {r.rows for r in regions}
    level = 2
    while level < max_level and by_level[level]:
        cur = by_level[level]
        cg = np.array([r.geom for r in cur], dtype=object)
        cs, ce = np.array([r.start for r in cur]), np.array([r.end for r in cur])
        x, y = STRtree(cg).query(cg)
        keep = (x < y) & (cs[x] <= ce[y]) & (cs[y] <= ce[x])
        x, y = x[keep], y[keep]
        rows_union = [tuple(sorted(set(cur[i].rows) | set(cur[j].rows))) for i, j in zip(x, y, strict=True)]
        keep = np.array([len(u) == level + 1 and u not in seen for u in rows_union], dtype=bool)
        nxt: list[Region] = []
        if keep.any():
            x, y = x[keep], y[keep]
            rows_union = [u for u, k in zip(rows_union, keep, strict=True) if k]
            for u, g in zip(rows_union, shapely.intersection(cg[x], cg[y]), strict=True):
                if u in seen:
                    continue
                parts = polygons(g)
                if not parts:
                    continue
                geom = shapely.union_all(parts) if len(parts) > 1 else parts[0]
                km2 = area_km2(to_equal_area(geom))
                if km2 <= 0:
                    continue
                seen.add(u)
                nxt.append(Region(u, int(max(starts[list(u)])), int(min(ends[list(u)])), geom, km2, "multiple"))
        by_level[level + 1] = nxt
        level += 1
    if by_level.get(max_level):
        findings.append(Finding("QA-004", "error", "dataset", "overlaps:max-level",
                                f"Overlap regions shared by {max_level} rows exist; raise overlaps.max_level.",
                                {"max_level": max_level}))
    out = [r for lv in sorted(by_level) for r in by_level[lv]]
    out.sort(key=lambda r: (len(r.rows), r.start, r.rows))
    counts: dict[str, dict[str, float]] = defaultdict(lambda: {"regions": 0, "km2": 0.0})
    for r in out:
        counts[r.kind]["regions"] += 1
        counts[r.kind]["km2"] += r.km2
    findings.insert(0, Finding(
        "QA-004", "info", "dataset", "overlaps:all-years",
        f"{len(out):,} overlap regions across all years: "
        + ", ".join(f"{k} {int(v['regions']):,} ({v['km2']:,.0f} km²)" for k, v in sorted(counts.items()))
        + ". Drawn as stripes of every claimant (D-026).",
        {"by_kind": {k: {"regions": int(v["regions"]), "km2": round(v["km2"])} for k, v in counts.items()},
         "by_level": {str(k): len(v) for k, v in by_level.items()}}))
    return out, findings


def region_label(r: Region, base: list) -> str:
    names = " × ".join(base[i].name for i in r.rows)
    return f"{names} ({label(r.start)}–{label(r.end)})"


def neighbour_weights(base: list, polity_of_row: dict, gap_deg: float) -> dict[tuple[str, str], int]:
    """Polity pairs whose rows touch or nearly touch (within gap_deg) while both are valid, weighted by shared years."""
    geoms = np.array([r.geometry for r in base], dtype=object)
    shapely.prepare(geoms)
    starts = np.array([r.start for r in base])
    ends = np.array([r.end for r in base])
    pid = np.array([polity_of_row[r.index][0] for r in base], dtype=object)
    a, b = candidate_pairs(geoms, starts, ends, pid, pad_deg=gap_deg)
    near = shapely.dwithin(geoms[a], geoms[b], gap_deg) if len(a) else np.zeros(0, bool)
    w: dict[tuple[str, str], int] = defaultdict(int)
    for i, j in zip(a[near], b[near], strict=True):
        p, q = sorted((pid[i], pid[j]))
        w[(p, q)] += int(min(ends[i], ends[j]) - max(starts[i], starts[j]) + 1)
    return dict(w)
