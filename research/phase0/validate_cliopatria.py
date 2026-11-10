"""Phase 0 technical validation of Cliopatria for the 117 CE studies.

Reproduces every figure in docs/validation/0001-cliopatria-117ce.md.

Usage (from the repo root, with the inputs downloaded outside the repo):

    uv run --no-project --with shapely==2.1.* --with pyproj==3.7.* \
        python -I research/phase0/validate_cliopatria.py \
        --cliopatria <path>/cliopatria_polities_only_v021.geojson \
        --land10m <path>/world-atlas/land-10m.json \
        --out <output dir>

Inputs
  * Cliopatria v0.2.1 (Seshat Global History Databank, CC BY 4.0),
    zip sha256 e10a4e429fca708788ff9e7572a95fce801fae55852d217cffabc1c59cd4eed4
  * Natural Earth 1:10m land via world-atlas 2.0.2 (public domain / ISC)

Definitions (see docs/data-model.md, "Derived measures")
  * combined polygon area: sum over polities of each polity's own polygon area.
    Overlapping ground is counted once per polity that claims it.
  * unique mapped area: area of the union of all polygons. Each km2 counted once.
  * unique mapped land area: unique mapped area intersected with land, excluding
    Antarctica (south of 60 S).
  * Areas are computed in EPSG:6933 (WGS 84 / NSIDC EASE-Grid 2.0 Global, equal
    area), the projection Cliopatria uses for its own Area field.
"""
from __future__ import annotations

import argparse
import collections
import json
import pathlib

import pyproj
import shapely
from shapely.geometry import MultiPolygon, Polygon, Point, box, shape
from shapely.strtree import STRtree

YEAR = 117
ROME = (12.4964, 41.9028)
EA = pyproj.Transformer.from_crs("EPSG:4326", "EPSG:6933", always_xy=True)
AEQD_ROME = pyproj.Transformer.from_crs(
    "EPSG:4326", f"+proj=aeqd +lat_0={ROME[1]} +lon_0={ROME[0]} +units=m", always_xy=True)


def to_ea(g):
    # Reprojection can introduce ring self-intersections, so repair afterwards too.
    return shapely.make_valid(shapely.transform(g, lambda xy: _tx(EA, xy)))


def _tx(t, xy):
    x, y = t.transform(xy[:, 0], xy[:, 1])
    import numpy as np
    return np.column_stack([x, y])


def km2(g) -> float:
    return g.area / 1e6


def is_group(name: str) -> bool:
    return name.startswith("(")


def topo_land(path: pathlib.Path):
    """Minimal TopoJSON decoder for world-atlas land files (one MultiPolygon object)."""
    t = json.loads(path.read_text())
    sx, sy = t["transform"]["scale"]
    tx, ty = t["transform"]["translate"]
    arcs = []
    for arc in t["arcs"]:
        x = y = 0
        pts = []
        for dx, dy in arc:
            x += dx
            y += dy
            pts.append((x * sx + tx, y * sy + ty))
        arcs.append(pts)

    def ring(idx):
        out = []
        for i in idx:
            a = arcs[i] if i >= 0 else arcs[~i][::-1]
            out.extend(a if not out else a[1:])
        return out

    geom = t["objects"]["land"]["geometries"][0] if "geometries" in t["objects"]["land"] else t["objects"]["land"]
    polys = []
    for p in geom["arcs"] if geom["type"] == "MultiPolygon" else [geom["arcs"]]:
        rings = [ring(r) for r in p]
        polys.append(Polygon(rings[0], rings[1:]))
    return shapely.make_valid(MultiPolygon(polys))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cliopatria", required=True, type=pathlib.Path)
    ap.add_argument("--land10m", required=True, type=pathlib.Path)
    ap.add_argument("--out", required=True, type=pathlib.Path)
    a = ap.parse_args()
    a.out.mkdir(parents=True, exist_ok=True)

    rows = json.loads(a.cliopatria.read_text())["features"]
    for i, f in enumerate(rows):
        f["properties"]["_row"] = i
    base = [f for f in rows if f["properties"]["Type"] == "POLITY" and not is_group(f["properties"]["Name"])]
    groups = [f for f in rows if is_group(f["properties"]["Name"])]
    report: dict = {"inputs": {"rows": len(rows), "base_rows": len(base), "grouping_rows": len(groups),
                               "grouping_rows_by_type": dict(collections.Counter(f["properties"]["Type"] for f in groups))}}

    alive = lambda f, y: f["properties"]["FromYear"] <= y <= f["properties"]["ToYear"]

    # ---------------------------------------------------------------- 117 CE
    b117 = [f for f in base if alive(f, YEAR)]
    g117 = [f for f in groups if alive(f, YEAR)]
    geo = {f["properties"]["Name"]: shapely.make_valid(shape(f["geometry"])) for f in b117}
    ea = {n: to_ea(g) for n, g in geo.items()}
    attr = {f["properties"]["Name"]: f["properties"]["Area"] for f in b117}
    ours = {n: km2(g) for n, g in ea.items()}
    area_check = sorted(((n, attr[n], ours[n], (ours[n] - attr[n]) / attr[n]) for n in ea), key=lambda r: -abs(r[3]))

    combined_attr = sum(attr.values())
    combined = sum(ours.values())
    union = shapely.union_all(list(ea.values()))
    unique = km2(union)

    # Land (ice-free = excluding Antarctica south of 60 S)
    land = topo_land(a.land10m)
    land = shapely.make_valid(shapely.intersection(land, box(-180, -60, 180, 90)))
    land_ea = to_ea(land)
    land_total = km2(land_ea)
    union_land = shapely.intersection(union, land_ea)
    unique_land = km2(union_land)

    # Pairwise overlaps
    names = list(ea)
    tree = STRtree([ea[n] for n in names])
    member_of = {f["properties"]["Name"]: f["properties"]["MemberOf"] for f in b117}
    links = collections.defaultdict(list)  # frozenset({a,b}) -> grouping names
    for g in g117:
        comps = [c for c in g["properties"]["Components"].split(";") if c]
        for i in range(len(comps)):
            for j in range(i + 1, len(comps)):
                links[frozenset((comps[i], comps[j]))].append(g["properties"]["Name"])
    overlaps = []
    for i, n in enumerate(names):
        for j in tree.query(ea[n]):
            if j <= i:
                continue
            m = names[j]
            inter = shapely.intersection(ea[n], ea[m])
            ar = km2(inter)
            if ar <= 0:
                continue
            smaller = min(ours[n], ours[m])
            via = links.get(frozenset((n, m)), [])
            if member_of.get(n) == m or member_of.get(m) == n:
                via = via + ["MemberOf field"]
            if via:
                kind = "linked (subordinate or allied)"
            elif ar < 1000 or ar / smaller < 0.01:
                kind = "sliver (likely edge artifact)"
            else:
                kind = "unlinked overlap (contested, dual claim, or digitisation)"
            overlaps.append({"a": n, "b": m, "km2": round(ar), "pct_of_smaller": round(100 * ar / smaller, 1),
                             "kind": kind, "linked_via": via})
    overlaps.sort(key=lambda o: -o["km2"])
    by_kind = collections.defaultdict(lambda: {"pairs": 0, "km2": 0})
    for o in overlaps:
        by_kind[o["kind"]]["pairs"] += 1
        by_kind[o["kind"]]["km2"] += o["km2"]

    report["y117"] = {
        "polities": len(b117),
        "grouping_rows_alive": [{"name": g["properties"]["Name"], "type": g["properties"]["Type"],
                                 "components": g["properties"]["Components"], "area_km2": round(g["properties"]["Area"])}
                                for g in g117],
        "member_of_fields": {n: m for n, m in member_of.items() if m},
        "combined_polygon_area_km2_attr": round(combined_attr),
        "combined_polygon_area_km2": round(combined),
        "unique_mapped_area_km2": round(unique),
        "overlap_counted_twice_km2": round(combined - unique),
        "unique_mapped_land_km2": round(unique_land),
        "mapped_area_over_water_km2": round(unique - unique_land),
        "ice_free_land_km2": round(land_total),
        "share_of_ice_free_land_mapped": round(unique_land / land_total, 4),
        "area_field_vs_recomputed_max_rel_diff": round(max(abs(r[3]) for r in area_check), 5),
        "area_field_vs_recomputed_worst": [{"name": r[0], "attr": round(r[1]), "ours": round(r[2]), "rel": round(r[3], 5)}
                                           for r in area_check[:5]],
        "overlap_by_kind": by_kind,
        "overlaps": overlaps,
    }

    # Overlap geometries for the studies (simplified, lon/lat, clockwise for d3)
    feats = []
    for o in overlaps:
        if o["kind"].startswith("sliver"):
            continue
        g = shapely.intersection(geo[o["a"]], geo[o["b"]])
        g = shapely.set_precision(g.simplify(0.04, preserve_topology=True), 0.01)
        polys = [p for p in getattr(g, "geoms", [g]) if isinstance(p, Polygon) and not p.is_empty]
        if not polys:
            continue
        mp = MultiPolygon([shapely.geometry.polygon.orient(p, sign=-1.0) for p in polys])
        feats.append({"type": "Feature", "geometry": shapely.geometry.mapping(mp),
                      "properties": {k: o[k] for k in ("a", "b", "km2", "pct_of_smaller", "kind", "linked_via")}})
    (a.out / "overlaps_117.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": feats}, separators=(",", ":")))

    # ------------------------------------------- unique vs combined, 500 BCE..700 CE
    years = list(range(-500, 701, 5))
    simp = {}
    cache = {}
    series = {"years": years, "combined_km2": [], "unique_km2": []}
    for y in years:
        live = [f for f in base if alive(f, y)]
        key = frozenset(f["properties"]["_row"] for f in live)
        if key not in cache:
            gs = []
            for f in live:
                r = f["properties"]["_row"]
                if r not in simp:
                    simp[r] = to_ea(shapely.make_valid(shape(f["geometry"])).simplify(0.01))
                gs.append(simp[r])
            cache[key] = (sum(f["properties"]["Area"] for f in live), km2(shapely.union_all(gs)) if gs else 0.0)
        c, u = cache[key]
        series["combined_km2"].append(round(c))
        series["unique_km2"].append(round(u))
    (a.out / "stream_unique_-500_700.json").write_text(json.dumps(series, separators=(",", ":")))
    ratio = [c / u for c, u in zip(series["combined_km2"], series["unique_km2"]) if u]
    report["stream"] = {"years": f"{years[0]}..{years[-1]} step 5", "max_combined_over_unique": round(max(ratio), 3),
                        "year_of_max": years[ratio.index(max(ratio))], "mean_combined_over_unique": round(sum(ratio) / len(ratio), 3)}

    # ------------------------------------------------------------- temporal gaps
    byname = collections.defaultdict(list)
    for f in base:
        p = f["properties"]
        byname[p["Name"]].append((p["FromYear"], p["ToYear"]))
    internal = []
    for n, rs in byname.items():
        rs.sort()
        hi = rs[0][1]
        for a0, b0 in rs[1:]:
            if a0 > hi + 1:
                internal.append({"name": n, "gap_from": hi + 1, "gap_to": a0 - 1, "years": a0 - hi - 1})
            hi = max(hi, b0)
    internal.sort(key=lambda g: -g["years"])
    report["internal_gaps"] = {"polities_with_gaps": len({g["name"] for g in internal}), "gaps": len(internal),
                               "polities_total": len(byname), "longest": internal[:15]}

    rome_pt = Point(ROME)

    def near_rome(y0, y1, km=400):
        out = []
        for f in base:
            p = f["properties"]
            if p["FromYear"] <= y1 and p["ToYear"] >= y0:
                g = shapely.make_valid(shape(f["geometry"]))
                if g.distance(rome_pt) > 8:   # cheap degree prefilter
                    continue
                d = shapely.transform(g, lambda xy: _tx(AEQD_ROME, xy)).distance(Point(0, 0)) / 1000
                if d <= km:
                    out.append({"name": p["Name"], "from": p["FromYear"], "to": p["ToYear"], "distance_km": round(d, 1),
                                "wikidata": p["Wikidata"]})
        return sorted(out, key=lambda r: (r["from"], r["distance_km"]))

    report["rome_gaps"] = {
        "476_499": near_rome(476, 499),
        "1944": near_rome(1944, 1944),
        "names_matching_odoacer": sorted({f["properties"]["Name"] for f in rows if "doacer" in f["properties"]["Name"]}),
        "names_matching_italian_social": sorted({f["properties"]["Name"] for f in rows if "Social Republic" in f["properties"]["Name"]}),
    }

    # ----------------------------------------------------- Wikidata QID inventory
    qids = collections.defaultdict(set)
    for f in base:
        p = f["properties"]
        for q in (p["Wikidata"] or "").split(";"):
            if q:
                qids[q].add(p["Name"])
    shared = {q: sorted(ns) for q, ns in qids.items() if len(ns) > 1}
    report["wikidata"] = {"distinct_qids": len(qids), "shared_qids": len(shared),
                          "names_without_qid": sorted(n for n in byname if not any(n in v for v in qids.values()))[:50]}
    (a.out / "qids.json").write_text(json.dumps({"by_qid": {q: sorted(v) for q, v in qids.items()}, "shared": shared}, indent=1))
    (a.out / "validation_117.json").write_text(json.dumps(report, indent=1, ensure_ascii=False))

    y = report["y117"]
    print(f"117 CE: {y['polities']} polities | combined {y['combined_polygon_area_km2']/1e6:.2f} M km2 "
          f"(attr {y['combined_polygon_area_km2_attr']/1e6:.2f}) | unique {y['unique_mapped_area_km2']/1e6:.2f} | "
          f"double-counted {y['overlap_counted_twice_km2']:,} km2 | unique land {y['unique_mapped_land_km2']/1e6:.2f} "
          f"| over water {y['mapped_area_over_water_km2']:,} | land total {y['ice_free_land_km2']/1e6:.1f} "
          f"| share {100*y['share_of_ice_free_land_mapped']:.1f}% | area field max rel diff {y['area_field_vs_recomputed_max_rel_diff']}")
    print("grouping rows alive:", [(g["name"], g["components"]) for g in y["grouping_rows_alive"]])
    print("MemberOf:", y["member_of_fields"])
    for k, v in y["overlap_by_kind"].items():
        print(f"  {k}: {v['pairs']} pairs, {v['km2']:,} km2")
    for o in y["overlaps"][:14]:
        print(f"   {o['km2']:>9,} km2 ({o['pct_of_smaller']:>5}% of smaller)  {o['a']} x {o['b']}  [{o['kind']}] {o['linked_via']}")
    print("stream:", report["stream"])
    print("internal gaps:", {k: v for k, v in report["internal_gaps"].items() if k != "longest"})
    for g in report["internal_gaps"]["longest"][:8]:
        print("   ", g)
    print("Rome 476-499 within 400 km:", report["rome_gaps"]["476_499"])
    print("Rome 1944 within 400 km:", report["rome_gaps"]["1944"])
    print("odoacer names:", report["rome_gaps"]["names_matching_odoacer"], "| ISR names:", report["rome_gaps"]["names_matching_italian_social"])
    print("QIDs:", {k: v for k, v in report["wikidata"].items() if k != "names_without_qid"}, "| names without QID:", len(report["wikidata"]["names_without_qid"]))


if __name__ == "__main__":
    main()
