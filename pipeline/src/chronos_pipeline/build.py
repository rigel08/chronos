"""Build: pinned inputs -> QA (all rules) -> licence-gated, traceable bundle (format 3).

Outputs in data/build/<release_id>/ (and data/build/current -> that directory):
  bundle.json                 catalogue, years, palette, sources, coverage samples and the file manifest
  geometry.<hash>.bin         territory and overlap meshes: float32 positions, varint triangles (D-021, D-025, D-026)
  catalog.<hash>.json         per-polity and per-row QA findings and review notes, for the polity card
  basemap.<hash>.json         Natural Earth land, coastline, lakes and rivers (modern physical geography)
  relief-<hash>/{z}/{x}/{y}.webp  transparent hillshade tiles from Natural Earth shaded relief
  testpoints.json             ground truth for pick-accuracy benchmarks
  qa_report.json / .md        every QA finding
  attributions.json           citations and licences of every source used
  trace.json                  inputs with sha256, parameters, methods, output checksums (D-013)
JSON and binary files the app loads also get deterministic .br and .gz copies (D-024).
The same code and the same pinned inputs always give byte-identical outputs.
"""
from __future__ import annotations

import dataclasses
import hashlib
import json
import math
import shutil
from collections import defaultdict
from itertools import combinations
from pathlib import Path

import numpy as np
import shapely
import yaml
from shapely.strtree import STRtree

from . import __version__
from .basemap import dropped_features, dumps, hillshade_tiles, vector_layers
from .colours import assign_colours
from .core_sample import PointIndex
from .encode import compressed, content_name, decode_triangles, encode_triangles
from .geo import area_km2, ice_free, to_equal_area, topojson_land
from .manifest import load_manifest, verified_file, verified_member
from .measures import YearMeasures, overlaps, year_measures
from .overlaps import neighbour_weights, overlap_regions, region_label
from .paths import Paths
from .qa import rules
from .qa.findings import Finding, sort_key, summarize
from .registry import load_registry
from .render import Mesh, build_mesh, label_points
from .sources.cliopatria import assign_identities, read_rows, split_aggregates
from .sources.wikidata import crosswalk, load_overrides
from .years import label

CLIOPATRIA_MEMBER = "cliopatria_polities_only_v021.geojson"
REGISTRY_FILES = ("licenses.yaml", "sources.yaml", "permissions.yaml", "build.yaml", "crosswalk_overrides.csv",
                  "review_notes.csv")
FORMAT = 3
KIND_CODES = {"linked": 0, "sliver": 1, "unlinked": 2, "multiple": 3}
NO_OWNER = 0xFFFFFFFF


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

    log("overlap regions across all years (D-026) ...")
    regions, f_ov = overlap_regions(base, polity_of_row, aggs, cfg["qa"]["sliver_km2"], cfg["qa"]["sliver_fraction"],
                                    cfg["overlaps"]["max_level"])
    findings += f_ov
    findings += _check_regions_against_qa004(regions, findings, cfg["qa"]["checkpoint_years"])

    log("render meshes and triangulation (QA-013) ...")
    terr = sorted(range(len(base)), key=lambda i: (base[i].start, polity_of_row[base[i].index][0], base[i].index))
    terr_of_base = {bi: ti for ti, bi in enumerate(terr)}
    pol_index = {p.id: i for i, p in enumerate(polities)}
    tmesh, f13 = build_mesh([(base[bi].geometry, str(base[bi].index),
                              f"{base[bi].name} ({label(base[bi].start)}-{label(base[bi].end)})") for bi in terr],
                            cfg["render"], with_edge_flags=True, subject_type="territory")
    findings += f13
    omesh, f13o = build_mesh([(r.geom, "|".join(str(base[i].index) for i in r.rows), region_label(r, base)) for r in regions],
                             cfg["render"], with_edge_flags=False, subject_type="overlap")
    findings += f13o
    labels = label_points([base[bi].geometry for bi in terr], 0.05)

    log("neighbour-separating colours (D-027) ...")
    ccfg = cfg["colours"]
    colour_of, colour_stats = assign_colours([p.id for p in polities], neighbour_weights(base, polity_of_row, ccfg["neighbour_gap_deg"]),
                                             ccfg["palette"], ccfg["distinct_at"])
    findings.append(Finding("QA-014", "info", "dataset", "colours",
                            f"{colour_stats['neighbour_pairs']:,} neighbouring polity pairs; {colour_stats['same_colour_pairs']} share "
                            f"a colour ({colour_stats['same_colour_shared_years']:,} of {colour_stats['total_shared_years']:,} "
                            "shared years). Colours separate neighbours and carry no meaning (D-027).", colour_stats))

    findings.sort(key=sort_key)
    errors = [f for f in findings if f.severity == "error"]
    if errors:
        raise BuildError(f"{len(errors)} QA errors, e.g. {errors[0].rule}: {errors[0].message}")

    fingerprint = code_fingerprint(paths)
    release_id = (f"chronos-{__version__}-{profile}-cliopatria-{pins['cliopatria'].release}-wikidata-{pins['wikidata'].release}"
                  f"-{fingerprint[:12]}")
    out = paths.build / release_id
    if out.exists():
        shutil.rmtree(out)                    # a rebuild of the same release replaces it entirely
    out.mkdir(parents=True)
    dcfg = cfg["delivery"]
    files: dict[str, dict] = {}

    def publish(key: str, stem: str, ext: str, data: bytes, hashed: bool = True, precompress: bool = True) -> str:
        name = content_name(stem, data, ext, dcfg["hash_length"]) if hashed else f"{stem}{ext}"
        (out / name).write_bytes(data)
        entry = {"path": name, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}
        if precompress:
            for enc, blob in compressed(data, dcfg["brotli_quality"], dcfg["brotli_lgwin"], dcfg["gzip_level"]).items():
                (out / f"{name}.{enc}").write_bytes(blob)
                entry[enc] = len(blob)
        files[key] = entry
        return name

    log("geometry (format 3) ...")
    tri_bytes, tri_check = _encode_checked(tmesh)
    otri_bytes, _ = _encode_checked(omesh)
    slots = max((len(r.rows) for r in regions), default=2)
    region_terr = np.full((len(regions), slots), NO_OWNER, dtype="<u4")
    for k, r in enumerate(regions):
        region_terr[k, :len(r.rows)] = sorted(terr_of_base[i] for i in r.rows)
    sections = {
        "positions": tmesh.positions, "ring_start": tmesh.ring_start, "part_ring_start": tmesh.part_ring_start,
        "part_territory": tmesh.part_owner, "part_triangle_start": tmesh.part_triangle_start,
        "territory_start": np.asarray([base[bi].start for bi in terr], dtype="<i4"),
        "territory_end": np.asarray([base[bi].end for bi in terr], dtype="<i4"),
        "territory_polity": np.asarray([pol_index[polity_of_row[base[bi].index][0]] for bi in terr], dtype="<u4"),
        "territory_row": np.asarray([base[bi].index for bi in terr], dtype="<u4"),
        "territory_area_km2": np.asarray([base[bi].area_src for bi in terr], dtype="<f4"),
        "territory_label": labels.ravel(),
        "ov_positions": omesh.positions, "ov_ring_start": omesh.ring_start, "ov_part_ring_start": omesh.part_ring_start,
        "ov_part_region": omesh.part_owner, "ov_part_triangle_start": omesh.part_triangle_start,
        "region_start": np.asarray([r.start for r in regions], dtype="<i4"),
        "region_end": np.asarray([r.end for r in regions], dtype="<i4"),
        "region_territories": region_terr.ravel(),
        "region_area_km2": np.asarray([r.km2 for r in regions], dtype="<f4"),
        "triangles_varint": np.frombuffer(tri_bytes, np.uint8), "ov_triangles_varint": np.frombuffer(otri_bytes, np.uint8),
        "edge_flags": _required(tmesh.edge_flags), "region_kind": np.asarray([KIND_CODES[r.kind] for r in regions], dtype="u1"),
    }
    geo_blob, layout = _pack(sections)
    geometry_name = publish("geometry", "geometry", ".bin", geo_blob)

    log("catalogue, basemap and relief ...")
    publish("catalog", "catalog", ".json", dumps(_catalog(findings, polities, base, paths)))
    land50_full = topojson_land(land50)
    lakes = json.loads(verified_file(paths.raw, pins["natural-earth-lakes"]).read_text())
    rivers = json.loads(verified_file(paths.raw, pins["natural-earth-rivers"]).read_text())
    publish("basemap", "basemap", ".json", dumps(vector_layers(land50_full, lakes, rivers, cfg["basemap"]["vector_decimals"])))
    files["basemap"]["dropped_empty"] = {"lakes": dropped_features(lakes), "rivers": dropped_features(rivers)}
    rcfg = cfg["basemap"]["relief"]
    tmp = out / "relief-tmp"
    relief = hillshade_tiles(verified_member(paths.raw, pins["natural-earth-relief"], "SR_50M.tif"),
                             verified_member(paths.raw, pins["natural-earth-relief"], "SR_50M.tfw"), tmp, rcfg)
    relief_dir = f"relief-{relief['sha256'][:dcfg['hash_length']]}"
    tmp.rename(out / relief_dir)
    files["relief"] = {"template": relief_dir + "/{z}/{x}/{y}.webp", "tile_size": rcfg["tile_size"], "minzoom": rcfg["minzoom"],
                       "maxzoom": rcfg["maxzoom"], "tiles": relief["tiles"], "bytes": relief["bytes"], "sha256": relief["sha256"]}

    qa_by_polity: dict[str, set[str]] = defaultdict(set)
    for f in findings:
        if f.severity != "info" and f.subject_type in ("polity", "external_id"):
            qa_by_polity[f.subject_id.split(":")[0]].add(f.rule)
    ext_by_polity: dict[str, list[dict]] = defaultdict(list)
    for e in external_ids:
        ext_by_polity[e["polity_id"]].append({k: e[k] for k in ("value", "label", "status", "flags")}
                                             | ({"corrected_to": e["corrected_to"]} if "corrected_to" in e else {}))
    by_kind: dict[str, dict] = defaultdict(lambda: {"regions": 0, "km2": 0})
    for r in regions:
        by_kind[r.kind]["regions"] += 1
        by_kind[r.kind]["km2"] += round(r.km2)
    bundle = {
        "format": FORMAT, "release_id": release_id, "profile": profile, "pipeline_version": __version__,
        "years": {"min": lo, "max": hi, "numbering": "astronomical (0 = 1 BCE)"},
        "polities": [{"id": p.id, "name": p.name, "start": p.start, "end": p.end, "colour": colour_of[p.id],
                      "qa": sorted(qa_by_polity.get(p.id, ())), "wikidata": ext_by_polity.get(p.id, [])}
                     for p in polities],
        "palette": {"colours": ccfg["palette"], "names": ccfg["palette_names"],
                    "note": "Colours separate neighbouring polities; they carry no meaning (D-027)."},
        "sources": [{"id": s, "title": reg.sources[s].title, "citation": reg.sources[s].citation, "url": reg.sources[s].url,
                     "license": reg.license_of(s).id, "license_name": reg.license_of(s).name,
                     "license_url": reg.license_of(s).url, "access_tier": reg.sources[s].access_tier,
                     "evidence": reg.sources[s].evidence} for s in source_ids],
        "coverage": {"land": "Natural Earth 1:50m, ice-free (north of 60° S)", "step_years": step, "rule": "QA-011",
                     "samples": [[m.year, round(m.coverage, 4), m.polities] for m in samples]},
        "overlaps": {"regions": len(regions), "by_kind": dict(by_kind), "kind_codes": KIND_CODES, "slots": slots,
                     "by_level": {str(n): sum(len(r.rows) == n for r in regions) for n in range(2, slots + 1)}},
        "geometry": {"file": geometry_name, "sections": layout, "bytes": len(geo_blob),
                     "territories": len(terr), "parts": tmesh.stats["parts"], "rings": tmesh.stats["rings"],
                     "vertices": tmesh.stats["vertices"], "triangles": tmesh.stats["triangles"],
                     "overlap_regions": len(regions), "overlap_parts": omesh.stats["parts"],
                     "overlap_vertices": omesh.stats["vertices"], "overlap_triangles": omesh.stats["triangles"],
                     "edge_flags": {"synthetic": 1}, "triangle_check": tri_check},
        "files": files,
        "attribution": sorted({reg.sources[s].citation for s in source_ids}, key=[reg.sources[s].citation for s in source_ids].index),
    }

    log("test points ...")
    _dump(_testpoints(base, polity_of_row, land50_ll, cfg["testpoints"], lo, hi), out / "testpoints.json")
    report = {"release_id": release_id, "profile": profile, "summary": summarize(findings),
              "checkpoints": [m.as_dict() for m in checkpoints], "coverage": [m.as_dict() for m in samples],
              "point_checks": point_samples, "findings": [f.as_dict() for f in findings]}
    _dump(report, out / "qa_report.json", indent=1)
    (out / "qa_report.md").write_text(_report_md(report, polities))
    attributions = [{"source": s, "title": reg.sources[s].title, "citation": reg.sources[s].citation,
                     "license": reg.license_of(s).id, "license_name": reg.license_of(s).name,
                     "license_url": reg.license_of(s).url, "access_tier": reg.sources[s].access_tier}
                    for s in source_ids]
    publish("attributions", "attributions", ".json", (json.dumps(attributions, sort_keys=True, ensure_ascii=False, indent=1)
                                                      + "\n").encode(), hashed=False)
    files["trace"] = {"path": "trace.json"}
    publish("bundle", "bundle", ".json", (json.dumps(bundle, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
                                          + "\n").encode(), hashed=False)

    outputs = {str(p.relative_to(out)): _sha(p) for p in sorted(out.iterdir()) if p.is_file() and p.name != "trace.json"}
    outputs[relief_dir + "/"] = relief["sha256"]
    trace = {
        "release_id": release_id, "profile": profile, "pipeline_version": __version__, "code_fingerprint": fingerprint,
        "format": FORMAT,
        "inputs": [{"source": s, "release": pins[s].release if s in pins else None,
                    "sha256": pins[s].sha256 if s in pins else None,
                    "members": pins[s].members if s in pins else {}, "license": reg.sources[s].license,
                    "access_tier": reg.sources[s].access_tier, "citation": reg.sources[s].citation}
                   for s in source_ids],
        "editorial_inputs": {n: _sha(paths.registry / n) for n in ("crosswalk_overrides.csv", "review_notes.csv")},
        "parameters": cfg,
        "methods": {
            "years": "Cliopatria -n -> astronomical -(n-1); 0 -> 0 (1 BCE end bound). QA-001.",
            "identity": "Rows sharing a name split at gaps > identity.max_gap_years unless aggregates cover the gap. QA-006, D-016.",
            "areas": "EPSG:6933 via pyproj; combined = sum per polity, unique = union, land = union with ice-free Natural Earth land. D-012.",
            "checkpoint_land": "Natural Earth 1:10m", "coverage_land": "Natural Earth 1:50m",
            "render": "full-resolution Cliopatria polygons, split on a grid of render.grid_split_deg degrees, RFC 7946 winding. D-017.",
            "triangulation": ("earcut (mapbox-earcut) per render part in Web Mercator, on float32-rounded coordinates; "
                              "area deviation checked per part. QA-013, D-021."),
            "triangle_encoding": ("per-part local indices, delta-coded, zigzag-mapped, LEB128 varints; decoded and compared "
                                  "with the source triangles during the build. D-025."),
            "edge_flags": "bit 0 = the edge from this vertex to the next is a grid cut or the antimeridian, not a border.",
            "overlaps": ("intersection of every pair of base rows sharing interior while both are valid, span = intersection "
                         "of their years, area EPSG:6933, kind by the QA-004 rule; regions of 3+ rows built from pairs. D-026."),
            "colours": "DSatur colouring of the polity neighbour graph (rows within colours.neighbour_gap_deg while both valid). D-027.",
            "labels": "pole of inaccessibility of each row's largest part (GEOS maximum inscribed circle, 0.05 degree tolerance).",
            "basemap": "Natural Earth 1:50m land (full, including Antarctica), coastline without antimeridian/pole edges, lakes, rivers.",
            "relief": "Natural Earth SR_50M re-projected to Web Mercator tiles (bilinear), departure from flat ground -> alpha.",
            "delivery": "content-hashed file names; brotli and gzip copies (deterministic, gzip mtime 0). D-024.",
            "testpoints": "seeded random points >= margin_km from every alive boundary; expected polities by point-in-polygon.",
        },
        "outputs": outputs,
        "qa_summary": summarize(findings),
    }
    _dump(trace, out / "trace.json", indent=1)
    for enc, blob in compressed((out / "trace.json").read_bytes(), dcfg["brotli_quality"], dcfg["brotli_lgwin"],
                                dcfg["gzip_level"]).items():
        (out / f"trace.json.{enc}").write_bytes(blob)
    current = paths.build / "current"
    if current.is_symlink() or current.exists():
        current.unlink()
    current.symlink_to(release_id)
    log(f"built {release_id}")
    return out


def _encode_checked(mesh: Mesh) -> tuple[bytes, dict]:
    """Varint-encode a mesh's triangles and prove the encoding lossless by decoding it again (D-025)."""
    enc = encode_triangles(mesh.triangles, mesh.part_triangle_start, mesh.part_first_vertex)
    if not np.array_equal(decode_triangles(enc, mesh.part_triangle_start, mesh.part_first_vertex), mesh.triangles):
        raise BuildError("triangle encoding is not lossless")
    return enc, {"indices": int(len(mesh.triangles)), "varint_bytes": len(enc), "lossless": True}


def _required(a: np.ndarray | None) -> np.ndarray:
    if a is None:
        raise BuildError("missing array")
    return a


def _pack(sections: dict[str, np.ndarray]) -> tuple[bytes, dict]:
    """Concatenate sections, each aligned to 8 bytes so the browser can view them in place."""
    layout, chunks, offset = {}, [], 0
    for name, arr in sections.items():
        b = arr.tobytes()
        layout[name] = {"dtype": arr.dtype.str, "offset": offset, "length": int(arr.size)}
        pad = (-len(b)) % 8
        chunks.append(b + b"\0" * pad)
        offset += len(b) + pad
    return b"".join(chunks), layout


def _check_regions_against_qa004(regions: list, findings: list[Finding], years: list[int]) -> list[Finding]:
    """The all-years overlap regions must reproduce QA-004's per-year overlap totals at every checkpoint."""
    out = []
    for y in years:
        qa = next((f for f in findings if f.rule == "QA-004" and f.subject_id == f"year:{y}"), None)
        if qa is None:
            continue
        expect = sum(p["km2"] for p in qa.detail.get("pairs", []))
        got = sum(r.km2 for r in regions if len(r.rows) == 2 and r.start <= y <= r.end)
        ok = abs(got - expect) <= max(len(qa.detail.get("pairs", [])) * 1.0, expect * 0.001)
        out.append(Finding("QA-004", "info" if ok else "error", "dataset", f"overlaps:check:{y}",
                           f"{label(y)}: overlap regions give {got:,.0f} km², QA-004 pairs give {expect:,} km².",
                           {"year": y, "regions_km2": round(got), "qa004_km2": expect, "ok": ok}))
    return out


def _read_review_notes(path: Path) -> list[dict]:
    import csv
    with open(path, newline="") as fh:
        return [dict(r) for r in csv.DictReader(fh)]


def _catalog(findings: list[Finding], polities: list, base: list, paths: Paths) -> dict:
    """What the polity card shows beyond the bundle: findings with messages and editorial review notes."""
    by_polity: dict[str, dict] = defaultdict(lambda: {"findings": [], "notes": []})
    by_row: dict[str, dict] = defaultdict(lambda: {"findings": [], "notes": []})
    ids = {p.id for p in polities}
    for f in findings:
        item = {"rule": f.rule, "severity": f.severity, "message": f.message}
        if f.subject_type in ("polity", "external_id"):
            pid = f.subject_id.split(":")[0]
            if pid in ids:
                by_polity[pid]["findings"].append(item)
        elif f.subject_type == "territory":
            by_row[f.subject_id]["findings"].append(item)
    rows = {str(r.index) for r in base}
    for n in _read_review_notes(paths.registry / "review_notes.csv"):
        note = {"note": n["note"], "reference": n["reference"], "added_on": n["added_on"], "source": "chronos-editorial"}
        if n["subject_type"] == "row" and n["subject_id"] in rows:
            by_row[n["subject_id"]]["notes"].append(note)
        elif n["subject_type"] == "polity" and n["subject_id"] in ids:
            by_polity[n["subject_id"]]["notes"].append(note)
        else:
            raise BuildError(f"review note for unknown {n['subject_type']} {n['subject_id']}")
    return {"rules": rules.RULE_TITLES, "polities": dict(by_polity), "rows": dict(by_row)}


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
