"""End-to-end build on a synthetic mini-repository: determinism, licence gate, trace and outputs."""
from __future__ import annotations

import hashlib
import json

import pytest
import yaml

from chronos_pipeline.build import run
from chronos_pipeline.manifest import FetchError
from chronos_pipeline.registry import LicenceGateError


def _hashes(d):
    return {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(d.iterdir())}


def test_build_is_byte_identical_across_runs(mini_repo):
    first = _hashes(run(mini_repo, "public", log=lambda *_: None))
    second = _hashes(run(mini_repo, "public", log=lambda *_: None))
    assert first == second
    assert set(first) == {"attributions.json", "basemap_land.geojson", "bundle.json", "geometry.bin", "qa_report.json",
                          "qa_report.md", "testpoints.json", "trace.json"}


def test_trace_records_inputs_licences_parameters_and_outputs(mini_repo):
    out = run(mini_repo, "public", log=lambda *_: None)
    trace = json.loads((out / "trace.json").read_text())
    assert {i["source"] for i in trace["inputs"]} == {"cliopatria", "natural-earth-land", "wikidata", "chronos-editorial"}
    assert all(i["access_tier"] == "public" for i in trace["inputs"])
    assert trace["parameters"]["render"]["simplify_deg"] == 0.0
    for name, digest in trace["outputs"].items():
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
    assert b["geometry"]["territories"] == 5
    g = b["geometry"]["sections"]
    raw = (out / "geometry.bin").read_bytes()
    assert sum(s["length"] * int(s["dtype"][-1]) for s in g.values()) == len(raw)     # sections tile the file exactly
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
