"""Point histories ("the ground beneath you"), with exact and near hits kept apart (QA-010)."""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import shapely
from shapely.strtree import STRtree

from .geo import distance_km


@dataclass
class Stratum:
    polity_id: str
    name: str
    start: int
    end: int
    exact: bool                 # some row's polygon covers the point
    distance_km: float          # 0 for exact hits; otherwise the near-miss distance
    rows: list[int] = field(default_factory=list)


@dataclass
class CoreSample:
    lon: float
    lat: float
    tolerance_km: float
    strata: list[Stratum]
    gaps: list[tuple[int, int]]          # astronomical year ranges no polygon covers
    overlaps: list[tuple[str, str, int, int]]

    def as_dict(self) -> dict:
        return {"lon": self.lon, "lat": self.lat, "tolerance_km": self.tolerance_km,
                "strata": [s.__dict__ for s in self.strata], "gaps": [list(g) for g in self.gaps],
                "overlaps": [list(o) for o in self.overlaps]}


class PointIndex:
    def __init__(self, rows: list, polity_of_row: dict[int, tuple[str, str]]):
        self.rows = rows
        self.polity_of_row = polity_of_row
        self.tree = STRtree([r.geometry for r in rows])

    def sample(self, lon: float, lat: float, tolerance_km: float) -> CoreSample:
        pt = shapely.Point(lon, lat)
        pad = tolerance_km / 111.32 / max(0.05, abs(math.cos(math.radians(lat)))) + 0.01
        hits = []
        for i in self.tree.query(shapely.box(lon - pad, lat - pad, lon + pad, lat + pad)):
            r = self.rows[int(i)]
            if shapely.covers(r.geometry, pt):
                hits.append((r, True, 0.0))
            else:
                d = distance_km(r.geometry, lon, lat)
                if d <= tolerance_km:
                    hits.append((r, False, round(d, 2)))
        hits.sort(key=lambda h: (h[0].start, h[0].end, h[0].index))
        strata: list[Stratum] = []
        for r, exact, d in hits:
            pid, name = self.polity_of_row[r.index]
            s = next((s for s in reversed(strata) if s.polity_id == pid and r.start - s.end <= 1), None)
            if s:
                s.end = max(s.end, r.end)
                s.exact = s.exact or exact
                s.distance_km = 0.0 if s.exact else min(s.distance_km, d)
                s.rows.append(r.index)
            else:
                strata.append(Stratum(pid, name, r.start, r.end, exact, d, [r.index]))
        gaps: list[tuple[int, int]] = []
        if strata:
            ordered = sorted(strata, key=lambda s: (s.start, s.end))
            hi = ordered[0].end
            for s in ordered[1:]:
                if s.start > hi + 1:
                    gaps.append((hi + 1, s.start - 1))
                hi = max(hi, s.end)
        ov = [(a.polity_id, b.polity_id, max(a.start, b.start), min(a.end, b.end))
              for i, a in enumerate(strata) for b in strata[i + 1:] if b.start <= a.end and b.end >= a.start]
        return CoreSample(lon, lat, tolerance_km, strata, gaps, ov)
