"""Build: pinned inputs -> QA (all rules) -> licence-gated, traceable spike bundle.

Outputs in data/build/<release_id>/ (and data/build/current -> that directory):
  bundle.json, geometry.bin   render geometry and metadata for the engine benchmark
  basemap_land.geojson        Natural Earth 1:50m land, ice-free
  testpoints.json             ground truth for pick-accuracy benchmarks
  qa_report.json / .md        every QA finding
  attributions.json           citations and licences of every source used
  trace.json                  inputs with sha256, parameters, methods, output checksums (D-013)
The same code and the same pinned inputs always give byte-identical outputs.
"""
from __future__ import annotations

import dataclasses
import hashlib
import json
import math
from collections import defaultdict
from itertools import combinations
from pathlib import Path

import numpy as np
import shapely
import yaml
from shapely.geometry import mapping
from shapely.strtree import STRtree

from . import __version__
from .core_sample import PointIndex
from .geo import area_km2, ice_free, render_parts, to_equal_area, topojson_land, triangulate
from .manifest import load_manifest, verified_file, verified_member
from .measures import YearMeasures, overlaps, year_measures
from .paths import Paths
from .qa import rules
from .qa.findings import Finding, sort_key, summarize
from .registry import load_registry
from .sources.cliopatria import assign_identities, read_rows, split_aggregates
from .sources.wikidata import crosswalk, load_overrides
from .years import label

CLIOPATRIA_MEMBER = "cliopatria_polities_only_v021.geojson"
REGISTRY_FILES = ("licenses.yaml", "sources.yaml", "permissions.yaml", "build.yaml", "crosswalk_overrides.csv")


class BuildError(RuntimeError):
    pass


def _dump(obj, path: Path, indent: int | None = None) -> None:
    text = json.dumps(obj, sort_keys=True, ensure_ascii=False, indent=indent,
                      separators=None if indent else (",", ":"))
    path.write_text(text + "\n")


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def code_fingerprint(paths: Paths) -> str:
    """Hash of the pipeline source and registry: identifies the code that produced a build."""
    h = hashlib.sha256()
    base = paths.root / "pipeline"
    # Only the registry files the pipeline reads: stray copies in the folder (e.g. editor or sync conflict copies
    # such as "build 2.yaml") must not change the fingerprint.
    files = sorted(list((base / "src").rglob("*.py")) + [paths.registry / n for n in REGISTRY_FILES])
    for f in files:
        if f.is_file():
            h.update(str(f.relative_to(base)).encode() + b"\0" + f.read_bytes() + b"\0")
    return h.hexdigest()


def run(paths: Paths, profile: str = "public", log=print) -> Path:
    cfg = yaml.safe_load((paths.registry / "build.yaml").read_text())
    reg = load_registry(paths.registry)
    source_ids = list(cfg["pipeline_profile_sources"])
    reg.check_profile(profile, source_ids)                     # QA-012: raises before anything is read
    pins = load_manifest(paths.manifest)
    missing = [s for s in source_ids if s not in pins and reg.sources[s].kind != "editorial"]
    if missing:
        raise BuildError(f"no pinned release for {missing}; see data/manifest.lock.json")

    clio = verified_member(paths.raw, pins["cliopatria"], CLIOPATRIA_MEMBER)
    land10 = verified_member(paths.raw, pins["natural-earth-land"], "package/land-10m.json")
    land50 = verified_member(paths.raw, pins["natural-earth-land"], "package/land-50m.json")
    snapshot = json.loads(verified_file(paths.raw, pins["wikidata"]).read_text())
    overrides = load_overrides(paths.registry / "crosswalk_overrides.csv")

    log("reading Cliopatria ...")
    rows = read_rows(clio)
    base, aggs = split_aggregates(rows)
    findings: list[Finding] = [rules.qa012_gate(profile, source_ids)]
    findings += rules.qa001_years(rows)
    findings += rules.qa002_aggregates(base, aggs)
    polities, f6 = assign_identities(base, aggs, **cfg["identity"])
    findings += f6
    polity_of_row = {ri: (p.id, p.name) for p in polities for ri in p.rows}

    log("projecting to equal area ...")
    ea = rules.equal_area_index(base)
    findings += rules.qa003_area(base, ea, cfg["qa"]["area_tolerance"])
    land10_ea = to_equal_area(ice_free(topojson_land(land10)))
    land50_ll = ice_free(topojson_land(land50))
    land50_ea = to_equal_area(land50_ll)

    log("checkpoint years (QA-004, QA-005) ...")
    checkpoints = []
    for y in cfg["qa"]["checkpoint_years"]:
        alive = [r for r in base if r.start <= y <= r.end]
        ids = [polity_of_row[r.index][0] for r in alive]
        linked = _linked_pairs(y, alive, aggs, polity_of_row)
        pairs = overlaps(ids, [ea[r.index] for r in alive], linked, cfg["qa"]["sliver_km2"], cfg["qa"]["sliver_fraction"])
        findings += rules.qa004_overlaps(y, pairs)
        m = year_measures(y, [ea[r.index] for r in alive], land10_ea, area_km2(land10_ea))
        findings.append(rules.qa005_measures(m))
        checkpoints.append(m)

    log("coverage samples (QA-011) ...")
    lo, hi = min(r.start for r in base), max(r.end for r in base)
    step = cfg["qa"]["coverage_step_years"]
    sample_years = list(range(lo, hi + 1, step)) + ([hi] if (hi - lo) % step else [])
    cache: dict[frozenset, YearMeasures] = {}
    land50_km2 = area_km2(land50_ea)
    samples = []
    for y in sample_years:
        alive = [r for r in base if r.start <= y <= r.end]
        key = frozenset(r.index for r in alive)
        if key not in cache:
            cache[key] = year_measures(y, [ea[r.index] for r in alive], land50_ea, land50_km2)
        c = cache[key]
        samples.append(dataclasses.replace(c, year=y))
    findings.append(rules.qa011_coverage(samples, "1:50m"))

    log("cross-references (QA-007, QA-008) ...")
    external_ids, f78 = crosswalk(polities, snapshot, overrides)
    findings += f78
    log("stray parts (QA-009) ...")
    findings += rules.qa009_stray_parts(base, polities, cfg["qa"]["stray_part_km"], cfg["qa"]["stray_part_fraction"])
    log("point checks (QA-010) ...")
    index = PointIndex(base, polity_of_row)
    point_samples = {}
    for pc in cfg["qa"]["point_checks"]:
        s = index.sample(pc["lon"], pc["lat"], pc["tolerance_km"])
        point_samples[pc["name"]] = s.as_dict()
        findings += rules.qa010_point(pc["name"], s)

    log("render geometry and triangulation (QA-013) ...")
    pol_index = {p.id: i for i, p in enumerate(polities)}
    render_arrays, render_stats, f13 = render_geometry(base, polity_of_row, pol_index, cfg["render"])
    findings += f13

    findings.sort(key=sort_key)
    errors = [f for f in findings if f.severity == "error"]
    if errors:
        raise BuildError(f"{len(errors)} QA errors, e.g. {errors[0].rule}: {errors[0].message}")

    fingerprint = code_fingerprint(paths)
    release_id = (f"chronos-{__version__}-{profile}-cliopatria-{pins['cliopatria'].release}-wikidata-{pins['wikidata'].release}"
                  f"-{fingerprint[:12]}")
    out = paths.build / release_id
    out.mkdir(parents=True, exist_ok=True)

    log("render bundle ...")
    bundle = _write_geometry(out, render_arrays, render_stats)
    qa_by_polity: dict[str, set[str]] = defaultdict(set)
    for f in findings:
        if f.severity != "info" and f.subject_type in ("polity", "external_id"):
            qa_by_polity[f.subject_id.split(":")[0]].add(f.rule)
    ext_by_polity: dict[str, list[dict]] = defaultdict(list)
    for e in external_ids:
        ext_by_polity[e["polity_id"]].append({k: e[k] for k in ("value", "label", "status", "flags")}
                                             | ({"corrected_to": e["corrected_to"]} if "corrected_to" in e else {}))
    bundle |= {
        "format": 2, "release_id": release_id, "profile": profile, "pipeline_version": __version__,
        "years": {"min": lo, "max": hi, "numbering": "astronomical (0 = 1 BCE)"},
        "polities": [{"id": p.id, "name": p.name, "start": p.start, "end": p.end,
                      "qa": sorted(qa_by_polity.get(p.id, ())), "wikidata": ext_by_polity.get(p.id, [])}
                     for p in polities],
        "attribution": [reg.sources[s].citation for s in source_ids],
    }
    _dump(bundle, out / "bundle.json")
    _dump({"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {},
           "geometry": _round_geojson(mapping(land50_ll), 4)}]}, out / "basemap_land.geojson")

    log("test points ...")
    _dump(_testpoints(base, polity_of_row, land50_ll, cfg["testpoints"], lo, hi), out / "testpoints.json")

    report = {"release_id": release_id, "profile": profile, "summary": summarize(findings),
              "checkpoints": [m.as_dict() for m in checkpoints], "coverage": [m.as_dict() for m in samples],
              "point_checks": point_samples, "findings": [f.as_dict() for f in findings]}
    _dump(report, out / "qa_report.json", indent=1)
    (out / "qa_report.md").write_text(_report_md(report, polities))
    _dump([{"source": s, "title": reg.sources[s].title, "citation": reg.sources[s].citation,
            "license": reg.license_of(s).id, "license_name": reg.license_of(s).name,
            "license_url": reg.license_of(s).url, "access_tier": reg.sources[s].access_tier}
           for s in source_ids], out / "attributions.json", indent=1)

    outputs = {p.name: _sha(p) for p in sorted(out.iterdir()) if p.name != "trace.json"}
    trace = {
        "release_id": release_id, "profile": profile, "pipeline_version": __version__, "code_fingerprint": fingerprint,
        "inputs": [{"source": s, "release": pins[s].release if s in pins else None,
                    "sha256": pins[s].sha256 if s in pins else None,
                    "members": pins[s].members if s in pins else {}, "license": reg.sources[s].license,
                    "access_tier": reg.sources[s].access_tier, "citation": reg.sources[s].citation}
                   for s in source_ids],
        "editorial_inputs": {"crosswalk_overrides.csv": _sha(paths.registry / "crosswalk_overrides.csv")},
        "parameters": cfg,
        "methods": {
            "years": "Cliopatria -n -> astronomical -(n-1); 0 -> 0 (1 BCE end bound). QA-001.",
            "identity": "Rows sharing a name split at gaps > identity.max_gap_years unless aggregates cover the gap. QA-006, D-016.",
            "areas": "EPSG:6933 via pyproj; combined = sum per polity, unique = union, land = union with ice-free Natural Earth land. D-012.",
            "checkpoint_land": "Natural Earth 1:10m", "coverage_land": "Natural Earth 1:50m",
            "render": "full-resolution Cliopatria polygons, split on a grid of render.grid_split_deg degrees, RFC 7946 winding. D-017.",
            "triangulation": ("earcut (mapbox-earcut) per render part in Web Mercator, on float32-rounded coordinates; "
                              "area deviation checked per part. QA-013, D-021."),
            "testpoints": "seeded random points >= margin_km from every alive boundary; expected polities by point-in-polygon.",
        },
        "outputs": outputs,
        "qa_summary": summarize(findings),
    }
    _dump(trace, out / "trace.json", indent=1)
    current = paths.build / "current"
    if current.is_symlink() or current.exists():
        current.unlink()
    current.symlink_to(release_id)
    log(f"built {release_id}")
    return out


def _linked_pairs(year: int, alive: list, aggs: list, polity_of_row: dict) -> set[frozenset]:
    by_name = defaultdict(set)
    for r in alive:
        by_name[r.name].add(polity_of_row[r.index][0])
    linked: set[frozenset] = set()
    for a in aggs:
        if a.start <= year <= a.end:
            ids = sorted({pid for c in a.components for pid in by_name.get(c, ())})
            linked.update(frozenset(p) for p in combinations(ids, 2))
    for r in alive:
        for m in r.member_of:
            for pid in by_name.get(m, ()):
                linked.add(frozenset((polity_of_row[r.index][0], pid)))
    return linked


def render_geometry(base: list, polity_of_row: dict, pol_index: dict, render_cfg: dict) -> tuple[dict, dict, list[Finding]]:
    """Render arrays for the bundle, with every part triangulated and checked (D-021, QA-013).

    Triangulation runs on the float32-rounded coordinates that are actually rendered.
    """
    terr = sorted(base, key=lambda r: (r.start, polity_of_row[r.index][0], r.index))
    positions: list[np.ndarray] = []
    triangles: list[np.ndarray] = []
    ring_start = [0]
    part_ring_start = [0]
    part_triangle_start = [0]
    part_territory: list[int] = []
    nverts = 0
    ntri_idx = 0
    findings: list[Finding] = []
    warn_km2, error_km2 = render_cfg["triangulation_warn_km2"], render_cfg["triangulation_error_km2"]
    worst_rel, worst_km2, total_km2, repaired, fallbacks = 0.0, 0.0, 0.0, 0, 0
    for ti, r in enumerate(terr):
        for poly in render_parts(r.geometry, render_cfg["grid_split_deg"], render_cfg["simplify_deg"]):
            rings = [np.asarray(ring.coords, dtype=np.float64)[:, :2].astype("<f4").astype(np.float64)
                     for ring in [poly.exterior, *poly.interiors]]
            for piece in triangulate(rings):
                part = len(part_territory)
                worst_rel, worst_km2 = max(worst_rel, piece.relative_deviation), max(worst_km2, piece.absolute_km2)
                total_km2 += piece.absolute_km2
                repaired += piece.repaired
                fallbacks += piece.method != "earcut"
                detail = {"part": part, "relative_deviation": piece.relative_deviation,
                          "absolute_km2": round(piece.absolute_km2, 6), "method": piece.method, "repaired": piece.repaired}
                where = f"{r.name} ({label(r.start)}-{label(r.end)}), render part {part}"
                if piece.absolute_km2 > error_km2:
                    findings.append(Finding("QA-013", "error", "territory", str(r.index),
                                            f"{where}: triangles mis-draw {piece.absolute_km2:,.2f} km\u00b2.", detail))
                elif piece.absolute_km2 > warn_km2:
                    findings.append(Finding("QA-013", "warning", "territory", str(r.index),
                                            f"{where}: triangles mis-draw {piece.absolute_km2:,.3f} km\u00b2.", detail))
                if piece.repaired:
                    findings.append(Finding("QA-013", "warning", "territory", str(r.index),
                                            f"{where}: invalid in the triangulation plane (Web Mercator, float32); repaired "
                                            "with make_valid before triangulation.", detail))
                triangles.append(piece.indices + np.uint32(nverts))
                ntri_idx += len(piece.indices)
                part_triangle_start.append(ntri_idx)
                for c in piece.rings:
                    positions.append(c)
                    nverts += len(c)
                    ring_start.append(nverts)
                part_ring_start.append(len(ring_start) - 1)
                part_territory.append(ti)
    arrays = {
        "positions": np.concatenate(positions).astype("<f4").ravel(),
        "ring_start": np.asarray(ring_start, dtype="<u4"),
        "part_ring_start": np.asarray(part_ring_start, dtype="<u4"),
        "part_territory": np.asarray(part_territory, dtype="<u4"),
        "triangles": np.concatenate(triangles).astype("<u4"),
        "part_triangle_start": np.asarray(part_triangle_start, dtype="<u4"),
        "territory_start": np.asarray([r.start for r in terr], dtype="<i4"),
        "territory_end": np.asarray([r.end for r in terr], dtype="<i4"),
        "territory_polity": np.asarray([pol_index[polity_of_row[r.index][0]] for r in terr], dtype="<u4"),
        "territory_row": np.asarray([r.index for r in terr], dtype="<u4"),
        "territory_area_km2": np.asarray([r.area_src for r in terr], dtype="<f4"),
    }
    findings.insert(0, Finding("QA-013", "info", "dataset", "render",
                               f"{len(part_territory):,} render parts triangulated in Web Mercator ({fallbacks} with constrained "
                               f"Delaunay, {repaired} repaired). Largest mis-drawn area {worst_km2:.4f} km\u00b2; total "
                               f"{total_km2:.3f} km\u00b2 across all parts and years.",
                               {"parts": len(part_territory), "triangles": int(ntri_idx // 3), "max_relative_deviation": worst_rel,
                                "max_absolute_km2": round(worst_km2, 6), "total_absolute_km2": round(total_km2, 6),
                                "constrained_delaunay_fallbacks": fallbacks, "repaired_parts": repaired,
                                "warn_km2": warn_km2, "error_km2": error_km2}))
    stats = {"territories": len(terr), "parts": len(part_territory), "rings": len(ring_start) - 1, "vertices": nverts,
             "triangles": int(ntri_idx // 3)}
    return arrays, stats, findings


def _write_geometry(out: Path, arrays: dict, stats: dict) -> dict:
    sections, offset = {}, 0
    with open(out / "geometry.bin", "wb") as fh:
        for name, arr in arrays.items():
            b = arr.tobytes()
            sections[name] = {"dtype": arr.dtype.str, "offset": offset, "length": int(arr.size)}
            fh.write(b)
            offset += len(b)
    return {"geometry": {"file": "geometry.bin", "sections": sections, "bytes": offset, **stats}}


def _round_geojson(geom: dict, nd: int) -> dict:
    def r(c):
        return [r(x) for x in c] if isinstance(c, (list, tuple)) and c and isinstance(c[0], (list, tuple)) \
            else [round(float(v), nd) for v in c]
    return {"type": geom["type"], "coordinates": r(geom["coordinates"])}


def _testpoints(base: list, polity_of_row: dict, land_ll, cfg: dict, lo: int, hi: int) -> dict:
    rng = np.random.default_rng(cfg["seed"])
    margin = cfg["margin_km"]
    land_parts = list(getattr(land_ll, "geoms", [land_ll]))
    land_tree = STRtree(land_parts)
    points = []

    def clear_of_boundaries(pt, geoms, tree) -> bool:
        lat = pt.y
        km_per_deg = 111.32 * math.cos(math.radians(min(89.0, abs(lat) + 1.0)))   # conservative (lon-compressed)
        r_deg = margin / km_per_deg
        for i in tree.query(pt.buffer(r_deg)):
            if shapely.distance(geoms[int(i)].boundary, pt) * km_per_deg < margin:
                return False
        return True

    years = sorted(int(y) for y in rng.integers(lo, hi + 1, size=cfg["years"]))
    for y in years:
        alive = [r for r in base if r.start <= y <= r.end]
        if not alive:
            continue
        geoms = [r.geometry for r in alive]
        tree = STRtree(geoms)
        weights = np.sqrt(np.asarray([r.area_src for r in alive]))
        picks = rng.choice(len(alive), size=min(cfg["inside_per_year"], len(alive)), replace=False,
                           p=weights / weights.sum())
        for k in sorted(int(p) for p in picks):
            g = geoms[k]
            x0, y0, x1, y1 = g.bounds
            for _ in range(300):
                pt = shapely.Point(rng.uniform(x0, x1), rng.uniform(y0, y1))
                if shapely.covers(g, pt) and clear_of_boundaries(pt, geoms, tree):
                    exp = sorted({polity_of_row[alive[int(i)].index][0] for i in tree.query(pt)
                                  if shapely.covers(geoms[int(i)], pt)})
                    points.append({"year": y, "lon": round(pt.x, 5), "lat": round(pt.y, 5), "kind": "inside",
                                   "expected": exp})
                    break
        for _ in range(cfg["unmapped_per_year"]):
            for _ in range(2000):
                lat = math.degrees(math.asin(rng.uniform(math.sin(math.radians(-55)), math.sin(math.radians(72)))))
                pt = shapely.Point(rng.uniform(-180, 180), lat)
                on_land = any(shapely.covers(land_parts[int(i)], pt) for i in land_tree.query(pt))
                if on_land and not any(shapely.covers(geoms[int(i)], pt) for i in tree.query(pt)) \
                        and clear_of_boundaries(pt, geoms, tree):
                    points.append({"year": y, "lon": round(pt.x, 5), "lat": round(pt.y, 5), "kind": "unmapped",
                                   "expected": []})
                    break
    return {"seed": cfg["seed"], "margin_km": margin, "count": len(points), "points": points,
            "note": "Each point is at least margin_km from every boundary alive in its year, so a correct renderer "
                    "must return exactly the expected polities (or none) at that pixel."}


def _report_md(report: dict, polities: list) -> str:
    names = {p.id: p.name for p in polities}
    f = report["findings"]
    L = [f"# QA report: {report['release_id']}", "",
         "Generated by `chronos-pipeline build`. Every finding is data, kept and shown; nothing was silently fixed.", "",
         "| Rule | info | warning | error |", "|---|---|---|---|"]
    for rule, sev in report["summary"].items():
        L.append(f"| {rule} | {sev.get('info', 0)} | {sev.get('warning', 0)} | {sev.get('error', 0)} |")
    L += ["", "## Area measures at checkpoint years (QA-005, Natural Earth 1:10m land)", "",
          "| Year | Polities | Combined polygon area km² | Unique mapped km² | Counted twice km² | Unique mapped land km² | Share of ice-free land |",
          "|---|---|---|---|---|---|---|"]
    for m in report["checkpoints"]:
        L.append(f"| {label(m['year'])} | {m['polities']} | {m['combined_polygon_area_km2']:,} | {m['unique_mapped_area_km2']:,} "
                 f"| {m['counted_twice_km2']:,} | {m['unique_mapped_land_km2']:,} | {m['share_of_ice_free_land']:.1%} |")
    def section(title: str, rule: str, sev: tuple[str, ...] = ("warning", "error"), limit: int = 60) -> None:
        items = [x for x in f if x["rule"] == rule and x["severity"] in sev]
        L.extend(["", f"## {title} ({len(items)})", ""])
        L.extend(f"- {x['message']}" for x in items[:limit])
        if len(items) > limit:
            L.append(f"- ... {len(items) - limit} more in qa_report.json")
    section("Identity splits at long gaps (QA-006)", "QA-006", ("warning",))
    switches = [x for x in f if x["rule"] == "QA-006" and x["severity"] == "info" and "aggregate rows" in x["message"]]
    L.extend(["", f"## Representation switches kept as one polity (QA-006) ({len(switches)})", ""])
    L.extend(f"- {x['message']}" for x in switches)
    corrected = [x for x in f if x["rule"] == "QA-008" and x["severity"] == "info" and "corrected to" in x["message"]]
    L.extend(["", f"## Cross-references corrected by verified editorial overrides (QA-008) ({len(corrected)})", ""])
    L.extend(f"- {x['message']}" for x in corrected)
    section("Cross-reference warnings (QA-008)", "QA-008", ("warning",), 40)
    section("Shared QIDs (QA-007)", "QA-007", ("warning",), 20)
    section("Stray polygon parts (QA-009)", "QA-009", ("warning",), 40)
    section("Unlinked overlaps at checkpoint years (QA-004)", "QA-004", ("warning",), 40)
    for name, s in report["point_checks"].items():
        L += ["", f"## Core sample: {name} ({s['lat']}, {s['lon']}, tolerance {s['tolerance_km']} km) (QA-010)", "",
              "| Polity | From | To | Hit |", "|---|---|---|---|"]
        for st in s["strata"]:
            hit = "exact" if st["exact"] else f"near ({st['distance_km']} km)"
            L.append(f"| {names.get(st['polity_id'], st['name'])} | {label(st['start'])} | {label(st['end'])} | {hit} |")
        L.append("")
        L.extend(f"- Unmapped: {label(a)} to {label(b)}" for a, b in s["gaps"])
    return "\n".join(L) + "\n"
