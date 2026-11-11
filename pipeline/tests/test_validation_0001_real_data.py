"""Reproduce validation 0001 on the real pinned inputs (skipped when data/raw is not fetched)."""
from __future__ import annotations

import pytest

from chronos_pipeline.core_sample import PointIndex
from chronos_pipeline.geo import area_km2, ice_free, to_equal_area, topojson_land
from chronos_pipeline.manifest import verified_member
from chronos_pipeline.measures import overlaps, year_measures
from chronos_pipeline.qa import rules
from chronos_pipeline.sources.wikidata import crosswalk, load_overrides

pytestmark = pytest.mark.data


def test_counts(real):
    assert len(real["rows"]) == 13797 and len(real["base"]) == 12064 and len(real["aggs"]) == 1733


def test_117_ce_area_measures_and_overlaps(real, real_paths):
    alive = [r for r in real["base"] if r.start <= 117 <= r.end]
    assert len(alive) == 36
    ea = [to_equal_area(r.geometry) for r in alive]
    land = to_equal_area(ice_free(topojson_land(verified_member(real_paths.raw, real["pins"]["natural-earth-land"],
                                                                "package/land-10m.json"))))
    m = year_measures(117, ea, land, area_km2(land))
    assert round(m.combined_polygon_area_km2) == 20_806_040
    assert round(m.unique_mapped_area_km2) == 20_805_833
    assert round(m.counted_twice_km2) == 207
    assert round(m.unique_mapped_land_km2) == 20_593_830
    assert round(m.coverage, 3) == 0.157
    pairs = overlaps([real["polity_of_row"][r.index][0] for r in alive], ea, set(), 1000, 0.01)
    assert len(pairs) == 5 and {p["kind"] for p in pairs} == {"sliver"}


def test_rome_core_sample(real):
    s = PointIndex(real["base"], real["polity_of_row"]).sample(12.4964, 41.9028, 5.0)
    assert len(s.strata) == 22
    assert s.gaps == [(476, 499), (1944, 1944)]
    near = [x for x in s.strata if not x.exact]
    assert [x.name for x in near] == ["Roman Kingdom"] and near[0].distance_km < 5


def test_name_collisions_are_split_and_hre_is_kept(real):
    ids = {p.id for p in real["polities"]}
    for name in ("later-zhou", "kingdom-of-italy", "kingdom-of-serbia", "georgia"):
        assert sum(i.startswith(name + "@") for i in ids) >= 2, name
        assert name not in ids
    assert "holy-roman-empire" in ids


def test_known_wikidata_errors_are_corrected_or_flagged(real, real_paths):
    recs, findings = crosswalk(real["polities"], real["snapshot"], load_overrides(real_paths.registry / "crosswalk_overrides.csv"))
    corrected = {(r["polity_id"].split("@")[0], r["value"], r["corrected_to"]["value"]) for r in recs if r["status"] == "corrected"}
    for expected in {("roman-empire", "Q12544", "Q2277"), ("roman-republic", "Q175881", "Q17167"),
                     ("byzantine-empire", "Q112039853", "Q12544"), ("han-dynasty", "Q1068371", "Q7209"),
                     ("sasanian-empire", "Q1661685", "Q83891")}:
        assert expected in corrected
    rev = next(r for r in recs if r["polity_id"] == "revolutionary-roman-republic")
    assert rev["status"] == "asserted" and rev["value"] == "Q175881"        # this one was always right
    assert sum(f.rule == "QA-008" and f.severity == "warning" for f in findings) > 250


def test_soissons_stray_part_is_flagged(real):
    soissons = [p for p in real["polities"] if p.name == "Kingdom of Soissons"]
    rows = [r for r in real["base"] if r.name == "Kingdom of Soissons"]
    q = real["cfg"]["qa"]
    f = rules.qa009_stray_parts(rows, soissons, q["stray_part_km"], q["stray_part_fraction"])
    # the 476-479 row's Dalmatian part (14.5-19.5 E), absent in 480-489
    assert any(x.severity == "warning" and x.detail["part_bounds"][2] > 19 and x.detail["part_bounds"][1] > 42 for x in f)


def test_overlap_regions_reproduce_qa004_and_find_the_420_ce_overlap(real):
    from chronos_pipeline.overlaps import overlap_regions
    q = real["cfg"]["qa"]
    regions, findings = overlap_regions(real["base"], real["polity_of_row"], real["aggs"], q["sliver_km2"],
                                        q["sliver_fraction"], real["cfg"]["overlaps"]["max_level"])
    assert not [f for f in findings if f.severity == "error"]
    pid = lambda i: real["polity_of_row"][real["base"][i].index][0]
    kw = [r for r in regions if {pid(i) for i in r.rows} == {"kidarites", "white-huns"} and r.start <= 420 <= r.end]
    assert kw and kw[0].kind == "unlinked" and kw[0].km2 > 400_000          # validation: 488,437 km2 in 420 CE
    at117 = sum(r.km2 for r in regions if len(r.rows) == 2 and r.start <= 117 <= r.end)
    assert round(at117) == 207                                               # the five slivers of validation 0001
    assert max(len(r.rows) for r in regions) <= 4
