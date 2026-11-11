"""Shared fixtures: a synthetic mini-repository (fast, license-clean) and the real pinned data (marker `data`)."""
from __future__ import annotations

import hashlib
import io
import json
import shutil
import tarfile
import zipfile
from pathlib import Path

import pytest

from chronos_pipeline.paths import Paths

REPO = Path(__file__).resolve().parents[2]


def _sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def square(x0: float, y0: float, x1: float, y1: float) -> dict:
    return {"type": "Polygon", "coordinates": [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]}


def feature(name, frm, to, geom, typ="POLITY", wikidata="", components="", member_of="", area=None):
    return {"type": "Feature", "geometry": geom,
            "properties": {"Name": name, "FromYear": frm, "ToYear": to, "Area": area if area is not None else 1.0,
                           "Type": typ, "Wikipedia": name, "Wikidata": wikidata, "SeshatID": "",
                           "Components": components, "MemberOf": member_of}}


def mini_features() -> list[dict]:
    """Six rows exercising aggregates, overlaps, a long identity gap and a representation switch."""
    return [
        feature("Alpha", -100, 0, square(0, 0, 4, 4), wikidata="Q1"),         # Cliopatria's "ends at 0, resumes at 1"
        feature("Alpha", 1, 99, square(0, 0, 5, 4), wikidata="Q1"),
        feature("Beta", -50, 50, square(4, 0, 8, 4), wikidata="Q2"),          # overlaps Alpha(0..99) by 1x4 deg
        feature("Gamma", 10, 20, square(10, 10, 12, 12), wikidata="Q9"),
        feature("Gamma", 300, 320, square(10, 10, 12, 12), wikidata="Q9"),    # 279-year gap -> identity split
        feature("(Alliance between Alpha and Beta)", 0, 50, square(0, 0, 8, 4), typ="RELATION",
                components="Alpha;Beta"),
    ]


def topo_square(x0, y0, x1, y1) -> dict:
    # world-atlas style: quantized, delta-encoded arcs with scale 1 and a translate.
    pts = [(x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0)]
    q = [(int(x - x0), int(y - y0)) for x, y in pts]
    delta = [list(q[0])] + [[q[i][0] - q[i - 1][0], q[i][1] - q[i - 1][1]] for i in range(1, len(q))]
    return {"type": "Topology", "transform": {"scale": [1, 1], "translate": [x0, y0]}, "arcs": [delta],
            "objects": {"land": {"type": "GeometryCollection", "geometries": [{"type": "MultiPolygon", "arcs": [[[0]]]}]}}}


def _synthetic_relief() -> dict[str, bytes]:
    """A 1-degree shaded-relief stand-in: flat (206) with one lit and one shaded ridge, plus its world file."""
    import numpy as np
    from PIL import Image
    a = np.full((180, 360), 206, np.uint8)
    a[80:90, 180:190] = 250
    a[90:100, 180:190] = 120
    buf = io.BytesIO()
    Image.fromarray(a, "L").save(buf, "TIFF")
    return {"SR_50M.tif": buf.getvalue(), "SR_50M.tfw": b"1.0\n0.0\n0.0\n-1.0\n-179.5\n89.5\n", "SR_50M.VERSION.txt": b"2.0.0"}


@pytest.fixture
def mini_repo(tmp_path: Path) -> Paths:
    """A complete, tiny repository: real registry files, synthetic pinned inputs, a pinned Wikidata snapshot."""
    root = tmp_path / "repo"
    shutil.copytree(REPO / "pipeline" / "registry", root / "pipeline" / "registry")
    shutil.copytree(REPO / "pipeline" / "src", root / "pipeline" / "src")
    raw = root / "data" / "raw"

    geo = json.dumps({"type": "FeatureCollection", "features": mini_features()}).encode()
    zbuf = io.BytesIO()
    with zipfile.ZipFile(zbuf, "w") as z:
        z.writestr("cliopatria_polities_only_v021.geojson", geo)
    zbytes = zbuf.getvalue()

    land = json.dumps(topo_square(-20, -20, 40, 40)).encode()
    tbuf = io.BytesIO()
    with tarfile.open(fileobj=tbuf, mode="w:gz") as t:
        for name, data in {"package/land-10m.json": land, "package/land-50m.json": land, "package/LICENSE": b"ISC"}.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mtime = 0
            t.addfile(info, io.BytesIO(data))
    tbytes = tbuf.getvalue()

    snapshot = {"format": 1, "generated_on": "2000-01-01", "endpoint": "test", "years": "astronomical", "items": {
        "Q1": {"label": "Alpha", "description": "", "aliases": [], "types": ["state"], "inception": -99, "dissolved": 99},
        "Q2": {"label": "Chauhan", "description": "", "aliases": [], "types": ["clan"], "inception": None, "dissolved": None},
        "Q9": {"label": "Gamma", "description": "", "aliases": [], "types": ["kingdom"], "inception": 10, "dissolved": 320}}}
    sbytes = (json.dumps(snapshot, indent=1, sort_keys=True) + "\n").encode()

    lakes = json.dumps({"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {"scalerank": 0, "name": "Lake"}, "geometry": square(1, 1, 2, 2)}]}).encode()
    rivers = json.dumps({"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {"scalerank": 1, "name": "River"},
         "geometry": {"type": "LineString", "coordinates": [[0.5, 0.5], [3.5, 3.5]]}}]}).encode()
    relief_members = _synthetic_relief()
    rbuf = io.BytesIO()
    with zipfile.ZipFile(rbuf, "w") as z:
        for name, data in relief_members.items():
            z.writestr(zipfile.ZipInfo(name, (2000, 1, 1, 0, 0, 0)), data)
    rbytes = rbuf.getvalue()

    for rel, data in {"cliopatria/v0.2.1/cliopatria.geojson.zip": zbytes,
                      "natural-earth-land/world-atlas@2.0.2/world-atlas-2.0.2.tgz": tbytes,
                      "natural-earth-lakes/v5.1.2/ne_50m_lakes.geojson": lakes,
                      "natural-earth-rivers/v5.1.2/ne_50m_rivers_lake_centerlines.geojson": rivers,
                      "natural-earth-relief/SR_50M-2.0.0/SR_50M.zip": rbytes,
                      "wikidata/2000-01-01/snapshot.json": sbytes}.items():
        p = raw / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
    manifest = {"version": 1, "sources": {
        "cliopatria": {"release": "v0.2.1", "url": "test://", "filename": "cliopatria.geojson.zip", "sha256": _sha(zbytes),
                       "archive": "zip", "members": {"cliopatria_polities_only_v021.geojson": _sha(geo)}},
        "natural-earth-land": {"release": "world-atlas@2.0.2", "url": "test://", "filename": "world-atlas-2.0.2.tgz",
                               "sha256": _sha(tbytes), "archive": "tgz",
                               "members": {"package/land-10m.json": _sha(land), "package/land-50m.json": _sha(land),
                                           "package/LICENSE": _sha(b"ISC")}},
        "natural-earth-lakes": {"release": "v5.1.2", "url": "test://", "filename": "ne_50m_lakes.geojson", "sha256": _sha(lakes)},
        "natural-earth-rivers": {"release": "v5.1.2", "url": "test://", "filename": "ne_50m_rivers_lake_centerlines.geojson",
                                 "sha256": _sha(rivers)},
        "natural-earth-relief": {"release": "SR_50M-2.0.0", "url": "test://", "filename": "SR_50M.zip", "sha256": _sha(rbytes),
                                 "archive": "zip", "members": {n: _sha(d) for n, d in relief_members.items()}},
        "wikidata": {"release": "2000-01-01", "url": "test://", "filename": "snapshot.json", "sha256": _sha(sbytes),
                     "generated_by": "test"}}}
    (root / "data").mkdir(exist_ok=True)
    (root / "data" / "manifest.lock.json").write_text(json.dumps(manifest, indent=2))
    # small, fast build parameters
    cfg = (root / "pipeline" / "registry" / "build.yaml").read_text()
    cfg = cfg.replace("checkpoint_years: [-499, 117, 420, 1000, 1500, 1914]", "checkpoint_years: [5, 310]")
    cfg = cfg.replace("coverage_step_years: 100", "coverage_step_years: 50")
    cfg = cfg.replace("years: 80", "years: 6").replace("margin_km: 60", "margin_km: 20")
    rome = "    - {name: Rome, lon: 12.4964, lat: 41.9028, tolerance_km: 5.0}"
    cfg = cfg.replace(rome, "    - {name: Origin, lon: 1.0, lat: 1.0, tolerance_km: 5.0}")
    cfg = cfg.replace("    maxzoom: 4\n    tile_size: 512", "    maxzoom: 1\n    tile_size: 32")
    (root / "pipeline" / "registry" / "build.yaml").write_text(cfg)
    # review notes must point at rows that exist: here, the first Gamma row (source row 3)
    (root / "pipeline" / "registry" / "review_notes.csv").write_text(
        "subject_type,subject_id,note,reference,added_on\n"
        'row,3,"Under review: test note.",tests,2000-01-01\n'
        'polity,beta,"Under review: polity note.",tests,2000-01-01\n')
    from chronos_pipeline.manifest import fetch, load_manifest
    for pin in load_manifest(root / "data" / "manifest.lock.json").values():
        if not pin.generated_by:
            fetch(pin, raw)   # extracts members from the files already in place (no network)
    return Paths(root)


@pytest.fixture(scope="session")
def real_paths() -> Paths:
    paths = Paths(REPO)
    from chronos_pipeline.manifest import FetchError, load_manifest, verified_member
    try:
        pins = load_manifest(paths.manifest)
        verified_member(paths.raw, pins["cliopatria"], "cliopatria_polities_only_v021.geojson")
    except (FetchError, KeyError, FileNotFoundError):
        pytest.skip("real pinned data not fetched (run `make fetch`)")
    return paths


@pytest.fixture(scope="session")
def real(real_paths: Paths):
    """Real Cliopatria rows, identities and indices, loaded once per session (about 20 s)."""
    import yaml

    from chronos_pipeline.manifest import load_manifest, verified_file, verified_member
    from chronos_pipeline.sources.cliopatria import assign_identities, read_rows, split_aggregates
    cfg = yaml.safe_load((real_paths.registry / "build.yaml").read_text())
    pins = load_manifest(real_paths.manifest)
    rows = read_rows(verified_member(real_paths.raw, pins["cliopatria"], "cliopatria_polities_only_v021.geojson"))
    base, aggs = split_aggregates(rows)
    polities, f6 = assign_identities(base, aggs, **cfg["identity"])
    snapshot = json.loads(verified_file(real_paths.raw, pins["wikidata"]).read_text())
    return {"cfg": cfg, "pins": pins, "rows": rows, "base": base, "aggs": aggs, "polities": polities, "f6": f6,
            "snapshot": snapshot, "polity_of_row": {ri: (p.id, p.name) for p in polities for ri in p.rows}}
