"""QA rules derived from validation 0001. Each returns findings; none modifies data."""
from __future__ import annotations

from collections import defaultdict

import shapely

from ..geo import area_km2, polygons, to_equal_area
from ..measures import YearMeasures
from ..years import label
from .findings import Finding


def qa001_years(rows: list) -> list[Finding]:
    """Year convention applied, and row ordering sane."""
    out = [Finding("QA-001", "info", "dataset", "cliopatria",
                   "Cliopatria years mapped to astronomical years: negative n is n BCE (astronomical n+1), and 0 is "
                   "the 1 BCE end bound. Inferred from the data, so BCE bounds carry +/-1 year of convention "
                   "uncertainty.",
                   {"rows_to_year_0": sum(r.to_src == 0 for r in rows),
                    "rows_from_year_0": sum(r.from_src == 0 for r in rows)})]
    for r in rows:
        if r.start > r.end:
            out.append(Finding("QA-001", "error", "territory", str(r.index),
                               f"{r.name}: row starts after it ends ({r.from_src} > {r.to_src}).", {}))
    by_name = defaultdict(list)
    for r in rows:
        if not r.aggregate:
            by_name[r.name].append(r)
    for name, rs in sorted(by_name.items()):
        rs.sort(key=lambda r: (r.start, r.end))
        for a, b in zip(rs, rs[1:], strict=False):
            if b.start <= a.end:
                out.append(Finding("QA-001", "warning", "territory", f"{a.index}+{b.index}",
                                   f"{name}: rows {a.index} and {b.index} overlap in time "
                                   f"({label(b.start)}-{label(min(a.end, b.end))}).",
                                   {"rows": [a.index, b.index]}))
    return out


def qa002_aggregates(base: list, aggs: list) -> list[Finding]:
    bad = [r for r in base if r.aggregate]
    out = [Finding("QA-002", "info", "dataset", "cliopatria",
                   f"{len(aggs)} aggregate rows (alliances, allegiances, groupings) kept apart from {len(base)} "
                   "territory rows; never summed as land.",
                   {"aggregate_rows": len(aggs), "by_type": {t: sum(r.type == t for r in aggs) for t in ("POLITY", "RELATION")},
                    "territory_rows": len(base)})]
    out += [Finding("QA-002", "error", "territory", str(r.index), f"Aggregate row {r.name!r} entered territories.", {})
            for r in bad]
    return out


def qa003_area(base: list, ea: dict[int, object], tolerance: float) -> list[Finding]:
    worst = 0.0
    out = []
    for r in base:
        ours = area_km2(ea[r.index])
        rel = (ours - r.area_src) / r.area_src if r.area_src else 0.0
        worst = max(worst, abs(rel))
        if abs(rel) > tolerance:
            out.append(Finding("QA-003", "warning", "territory", str(r.index),
                               f"{r.name} ({label(r.start)}-{label(r.end)}): recomputed area differs from the source "
                               f"by {rel:+.1%}.", {"source_km2": round(r.area_src), "recomputed_km2": round(ours)}))
    out.insert(0, Finding("QA-003", "info", "dataset", "cliopatria",
                          f"Largest relative difference between recomputed EPSG:6933 area and the source Area field: "
                          f"{worst:.2e}.", {"max_relative_difference": round(worst, 8), "tolerance": tolerance}))
    return out


def qa004_overlaps(year: int, pairs: list[dict]) -> list[Finding]:
    kinds: dict[str, dict[str, int]] = defaultdict(lambda: {"pairs": 0, "km2": 0})
    for p in pairs:
        kinds[p["kind"]]["pairs"] += 1
        kinds[p["kind"]]["km2"] += p["km2"]
    out = [Finding("QA-004", "info", "dataset", f"year:{year}",
                   f"{label(year)}: {len(pairs)} overlapping pairs, "
                   + ", ".join(f"{k} {v['pairs']} ({v['km2']:,} km²)" for k, v in sorted(kinds.items())) + "."
                   if pairs else f"{label(year)}: no overlapping polygons.",
                   {"year": year, "by_kind": dict(kinds), "pairs": pairs})]
    out += [Finding("QA-004", "warning", "dataset", f"year:{year}:{p['a']}|{p['b']}",
                    f"{label(year)}: {p['a']} and {p['b']} overlap by {p['km2']:,} km² with no recorded "
                    "relationship (contested, dual claim or digitisation).", p)
            for p in pairs if p["kind"] == "unlinked"]
    return out


def qa005_measures(m: YearMeasures) -> Finding:
    d = m.as_dict()
    ratio = m.combined_polygon_area_km2 / m.unique_mapped_area_km2 if m.unique_mapped_area_km2 else 1.0
    return Finding("QA-005", "info", "dataset", f"year:{m.year}",
                   f"{label(m.year)}: combined polygon area {d['combined_polygon_area_km2']:,} km², unique mapped "
                   f"area {d['unique_mapped_area_km2']:,} km² ({d['counted_twice_km2']:,} counted twice), unique "
                   f"mapped land {d['unique_mapped_land_km2']:,} km².", d | {"combined_over_unique": round(ratio, 4)})


def qa009_stray_parts(base: list, polities: list, stray_km: float, stray_fraction: float) -> list[Finding]:
    """Transient stray parts: far from the main body, smaller than it, and absent from the polity's neighbouring rows.

    Distance and size alone also describe every island and overseas possession, so a part is only
    suspicious when it appears in one row and not in the rows before and after it (e.g. Kingdom of
    Soissons 476-479, whose row includes a 32,925 km2 part on the Dalmatian coast that is gone by 480).
    """
    from ..geo import _aeqd, _apply  # local projection helpers
    by_index = {r.index: r for r in base}
    out = []
    for p in polities:
        rows = sorted((by_index[i] for i in p.rows), key=lambda r: (r.start, r.end, r.index))
        for k, r in enumerate(rows):
            parts = polygons(r.geometry)
            if len(parts) < 2:
                continue
            main = max(parts, key=lambda q: q.area)
            neighbours = [rows[j].geometry for j in (k - 1, k + 1) if 0 <= j < len(rows)]
            for part in parts:
                if part is main or part.area >= stray_fraction * main.area:
                    continue
                if shapely.distance(part, main) * 111.7 < stray_km:   # 1 degree <= 111.7 km, so this bounds km above
                    continue
                if any(shapely.intersects(part, n) for n in neighbours):
                    continue                                            # persists across rows: a real possession
                c = main.representative_point()
                t = _aeqd(round(c.x, 6), round(c.y, 6))
                km = float(shapely.distance(_apply(t, part), _apply(t, main))) / 1000
                if km < stray_km:
                    continue
                rp = part.representative_point()
                sev = "warning" if neighbours else "info"
                why = "absent from the rows before and after it" if neighbours else "the polity has only this row"
                out.append(Finding("QA-009", sev, "territory", str(r.index),
                                   f"{r.name} ({label(r.start)}-{label(r.end)}): a polygon part {km:,.0f} km from the main "
                                   f"body, near {rp.x:.2f}\u00b0, {rp.y:.2f}\u00b0, {why}.",
                                   {"polity_id": p.id, "distance_km": round(km), "part_point": [round(rp.x, 2), round(rp.y, 2)],
                                    "part_bounds": [round(v, 2) for v in part.bounds], "neighbour_rows": len(neighbours)}))
    return out


def qa010_point(name: str, sample) -> list[Finding]:
    near = [s for s in sample.strata if not s.exact]
    out = [Finding("QA-010", "info", "point", name,
                   f"{name}: {len(sample.strata)} strata, {len(sample.gaps)} unmapped gaps, {len(sample.overlaps)} "
                   f"overlaps, {len(near)} near hits within {sample.tolerance_km:g} km.", sample.as_dict())]
    out += [Finding("QA-010", "info", "point", f"{name}:{s.polity_id}",
                    f"{name}: {s.name} ({label(s.start)}-{label(s.end)}) is a near hit, {s.distance_km} km from the "
                    "point (coarse polygon).", {"distance_km": s.distance_km}) for s in near]
    out += [Finding("QA-010", "warning", "point", f"{name}:gap:{a}",
                    f"{name}: no polygon covers the point {label(a)}-{label(b)}.", {"gap": [a, b]})
            for a, b in sample.gaps]
    return out


def qa011_coverage(samples: list[YearMeasures], land_resolution: str) -> Finding:
    rows = [m.as_dict() for m in samples]
    peak = max(samples, key=lambda m: m.coverage)
    return Finding("QA-011", "info", "dataset", "coverage",
                   f"Share of ice-free land with a mapped polity peaks at {peak.coverage:.1%} in {label(peak.year)} "
                   f"(sampled every {samples[1].year - samples[0].year} years, Natural Earth {land_resolution}). "
                   "Unmapped land is not empty land.",
                   {"land": land_resolution, "samples": rows})


def qa012_gate(profile: str, sources: list[str]) -> Finding:
    return Finding("QA-012", "info", "dataset", profile,
                   f"Licence gate passed for the {profile} profile: {', '.join(sources)}.", {"sources": sources})


def equal_area_index(rows: list) -> dict[int, object]:
    return {r.index: to_equal_area(r.geometry) for r in rows}
