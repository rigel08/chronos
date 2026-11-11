"""Derived area measures (D-012). All areas in EPSG:6933, all labelled with their measure name."""
from __future__ import annotations

from dataclasses import dataclass

import shapely
from shapely.strtree import STRtree

from .geo import area_km2


@dataclass(frozen=True)
class YearMeasures:
    year: int
    polities: int
    combined_polygon_area_km2: float      # sum per polity; shared ground counted once per claimant
    unique_mapped_area_km2: float         # area of the union
    unique_mapped_land_km2: float         # union intersected with ice-free land
    land_km2: float

    @property
    def counted_twice_km2(self) -> float:
        return self.combined_polygon_area_km2 - self.unique_mapped_area_km2

    @property
    def coverage(self) -> float:
        return self.unique_mapped_land_km2 / self.land_km2 if self.land_km2 else 0.0

    def as_dict(self) -> dict:
        return {"year": self.year, "polities": self.polities,
                "combined_polygon_area_km2": round(self.combined_polygon_area_km2),
                "unique_mapped_area_km2": round(self.unique_mapped_area_km2),
                "counted_twice_km2": round(self.counted_twice_km2),
                "unique_mapped_land_km2": round(self.unique_mapped_land_km2),
                "share_of_ice_free_land": round(self.coverage, 4)}


def year_measures(year: int, geoms_ea: list, land_ea, land_km2: float) -> YearMeasures:
    combined = sum(area_km2(g) for g in geoms_ea)
    union = shapely.union_all(geoms_ea) if geoms_ea else shapely.Polygon()
    unique = area_km2(union)
    unique_land = area_km2(shapely.intersection(union, land_ea)) if geoms_ea else 0.0
    return YearMeasures(year, len(geoms_ea), combined, unique, unique_land, land_km2)


def overlaps(ids: list[str], geoms_ea: list, linked: set[frozenset], sliver_km2: float,
             sliver_fraction: float) -> list[dict]:
    """Pairwise overlaps among polygons alive in one year, classed linked / sliver / unlinked (QA-004)."""
    tree = STRtree(geoms_ea)
    out = []
    for i, gi in enumerate(geoms_ea):
        for j in tree.query(gi):
            if j <= i:
                continue
            inter = area_km2(shapely.intersection(gi, geoms_ea[j]))
            if inter <= 0:
                continue
            smaller = min(area_km2(gi), area_km2(geoms_ea[j]))
            pair = frozenset((ids[i], ids[j]))
            if pair in linked:
                kind = "linked"
            elif inter < sliver_km2 or inter / smaller < sliver_fraction:
                kind = "sliver"
            else:
                kind = "unlinked"
            out.append({"a": min(ids[i], ids[j]), "b": max(ids[i], ids[j]), "km2": round(inter),
                        "pct_of_smaller": round(100 * inter / smaller, 2), "kind": kind})
    return sorted(out, key=lambda o: (-o["km2"], o["a"], o["b"]))
