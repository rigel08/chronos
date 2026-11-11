"""End-to-end build on a synthetic mini-repository: determinism, licence gate, trace and outputs."""
from __future__ import annotations

import gzip
import hashlib
import json
import re

import brotli  # type: ignore[import-untyped]
import pytest
import yaml

from chronos_pipeline.build import run
from chronos_pipeline.manifest import FetchError
from chronos_pipeline.registry import LicenceGateError


def _hashes(d):
    return {str(p.relative_to(d)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(d.rglob("*")) if p.is_file()}


def test_build_is_byte_identical_across_runs(mini_repo):
    first = _hashes(run(mini_repo, "public", log=lambda *_: None))
    second = _hashes(run(mini_repo, "public", log=lambda *_: None))
    assert first == second
    top = {re.sub(r"\.[0-9a-f]{12}\.", ".<hash>.", n) for n in first if "/" not in n}
    plain = {"attributions.json", "bundle.json", "trace.json"}
    hashed = {"geometry.<hash>.bin", "catalog.<hash>.json"} | {f"basemap-{n}.<hash>.json" for n in ("land", "coastline", "lakes", "rivers")}
    assert top == ({"qa_report.json", "qa_report.md", "testpoints.json"} | plain | hashed
                   | {f"{n}.{e}" for n in plain | hashed for e in ("br", "gz")})
    relief = [n for n in first if n.startswith("relief-")]
    assert len(relief) == 1 + 4                                          # zooms 0 and 1 in the mini build


def test_precompressed_copies_and_content_hashes(mini_repo):
    out = run(mini_repo, "public", log=lambda *_: None)
    b = json.loads((out / "bundle.json").read_text())
    for key in ("geometry", "catalog", "basemap_land", "basemap_rivers", "attributions", "bundle"):
        f = b["files"][key] if key != "bundle" else {"path": "bundle.json"}
        raw = (out / f["path"]).read_bytes()
        assert gzip.decompress((out / (f["path"] + ".gz")).read_bytes()) == raw
        assert brotli.decompress((out / (f["path"] + ".br")).read_bytes()) == raw
        if key in ("geometry", "catalog", "basemap_land", "basemap_rivers"):
            assert hashlib.sha256(raw).hexdigest().startswith(f["path"].split(".")[1]) and f["sha256"] == hashlib.sha256(raw).hexdigest()
    assert b["files"]["relief"]["template"].startswith("relief-") and b["files"]["relief"]["tiles"] == 5


def test_trace_records_inputs_licences_parameters_and_outputs(mini_repo):
    out = run(mini_repo, "public", log=lambda *_: None)
    trace = json.loads((out / "trace.json").read_text())
    assert {i["source"] for i in trace["inputs"]} == {"cliopatria", "natural-earth-land", "natural-earth-lakes", "natural-earth-rivers",
                                                     "natural-earth-relief", "wikidata", "chronos-editorial"}
    assert all(i["access_tier"] == "public" for i in trace["inputs"])
    assert trace["parameters"]["render"]["simplify_deg"] == 0.0
    for name, digest in trace["outputs"].items():
        if name.endswith("/"):
            continue                                                     # the relief directory, checked below
        assert hashlib.sha256((out / name).read_bytes()).hexdigest() == digest
    assert (mini_repo.build / "current").resolve() == out.resolve()


def test_public_build_refuses_research_only_source_before_reading_data(mini_repo):
    cfg_path = mini_repo.registry / "build.yaml"
    cfg = yaml.safe_load(cfg_path.read_text())
    cfg["pipeline_profile_sources"].append("seshat-equinox")
    cfg_path.write_text(yaml.safe_dump(cfg))
    with pytest.raises(LicenceGateError, match="QA-012"):
        run(mini_repo, "public", log=lambda *_: None)


def test_build_refuses_unverified_inputs(mini_repo):
    member = mini_repo.raw / "cliopatria" / "v0.2.1" / "members" / "cliopatria_polities_only_v021.geojson"
    member.write_text(member.read_text().replace("Alpha", "Alphx"))
    with pytest.raises(FetchError, match="does not match"):
        run(mini_repo, "public", log=lambda *_: None)


def test_bundle_contents(mini_repo):
    out = run(mini_repo, "public", log=lambda *_: None)
    b = json.loads((out / "bundle.json").read_text())
    ids = sorted(p["id"] for p in b["polities"])
    assert ids == ["alpha", "beta", "gamma@10", "gamma@300"]          # aggregate excluded, Gamma split at its gap
    assert b["format"] == 3 and b["geometry"]["territories"] == 5
    g = b["geometry"]["sections"]
    raw = (out / b["geometry"]["file"]).read_bytes()
    spans = sorted((s["offset"], s["offset"] + s["length"] * int(s["dtype"][-1])) for s in g.values())
    assert all(o % 8 == 0 for o, _ in spans) and all(e <= n for (_, e), (n, _) in zip(spans, spans[1:], strict=False))
    assert spans[-1][1] <= len(raw) < spans[-1][1] + 8                  # sections tile the file (8-byte aligned)
    assert g["positions"]["dtype"] == "<f4"
    alpha = next(p for p in b["polities"] if p["id"] == "alpha")
    assert alpha["start"] == -99 and alpha["end"] == 99                 # -100 -> -99 astronomical
    beta = next(p for p in b["polities"] if p["id"] == "beta")
    assert beta["wikidata"][0]["label"] == "Chauhan" and "name_mismatch" in beta["wikidata"][0]["flags"]
    report = json.loads((out / "qa_report.json").read_text())
    rules_seen = set(report["summary"])
    assert {"QA-001", "QA-002", "QA-003", "QA-004", "QA-005", "QA-006", "QA-007", "QA-008", "QA-010", "QA-011",
            "QA-012"} <= rules_seen
    overlap = next(c for c in report["checkpoints"] if c["year"] == 5)
    assert overlap["counted_twice_km2"] > 0                             # Alpha and Beta overlap in year 5
    tp = json.loads((out / "testpoints.json").read_text())
    assert tp["count"] > 0 and all(set(p) == {"year", "lon", "lat", "kind", "expected"} for p in tp["points"])
