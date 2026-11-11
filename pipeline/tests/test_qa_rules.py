"""Unit tests for the QA rules on small synthetic inputs (each rule from validation 0001)."""
from __future__ import annotations

import shapely
from shapely.geometry import box

from chronos_pipeline.core_sample import PointIndex
from chronos_pipeline.geo import render_parts, to_equal_area
from chronos_pipeline.measures import overlaps, year_measures
from chronos_pipeline.qa import rules
from chronos_pipeline.sources.cliopatria import Polity, Row, assign_identities, slug, split_aggregates
from chronos_pipeline.sources.wikidata import Override, crosswalk, looks_like_polity, name_similarity


def row(i, name, start, end, geom, typ="POLITY", comps=(), qids=()):
    return Row(index=i, name=name, type=typ, from_src=start, to_src=end, start=start, end=end, area_src=1.0,
               wikidata=tuple(qids), seshat=(), components=tuple(comps), member_of=(), wikipedia="", geometry=geom)


# QA-002
def test_aggregates_are_separated_and_never_territories():
    rows = [row(0, "A", 0, 10, box(0, 0, 1, 1)), row(1, "(Alliance between A and B)", 0, 10, box(0, 0, 2, 2), "RELATION"),
            row(2, "(Warring States)", 0, 10, box(0, 0, 3, 3))]
    base, aggs = split_aggregates(rows)
    assert [r.name for r in base] == ["A"] and len(aggs) == 2
    assert all(f.severity == "info" for f in rules.qa002_aggregates(base, aggs))
    assert any(f.severity == "error" for f in rules.qa002_aggregates(base + aggs, []))


# QA-001
def test_overlapping_rows_of_one_polity_are_warned():
    rows = [row(0, "A", 0, 10, box(0, 0, 1, 1)), row(1, "A", 10, 20, box(0, 0, 1, 1))]
    assert any(f.rule == "QA-001" and f.severity == "warning" for f in rules.qa001_years(rows))


# QA-006 / D-016
def test_identity_split_short_gap_and_representation_switch():
    base = [row(0, "Later Zhou", -750, -257, box(0, 0, 1, 1)), row(1, "Later Zhou", 960, 960, box(0, 0, 1, 1)),
            row(2, "Rome", 0, 10, box(5, 5, 6, 6)), row(3, "Rome", 20, 30, box(5, 5, 6, 6)),
            row(4, "Holy Roman Empire", 962, 1259, box(7, 7, 8, 8)), row(5, "Holy Roman Empire", 1619, 1621, box(7, 7, 8, 8))]
    aggs = [row(9, "(Allegiance of X to Holy Roman Empire)", 1260, 1618, box(7, 7, 9, 9), comps=("X", "Holy Roman Empire"))]
    polities, findings = assign_identities(base, aggs, max_gap_years=50, switch_coverage=0.5)
    ids = sorted(p.id for p in polities)
    assert ids == ["holy-roman-empire", "later-zhou@-750", "later-zhou@960", "rome"]
    split = [f for f in findings if f.severity == "warning"]
    assert len(split) == 1 and split[0].subject_id == "later-zhou@-750" and split[0].detail["split_into"] == "later-zhou@960"
    assert any("aggregate rows" in f.message for f in findings)          # HRE kept as one polity
    assert any("10-year gap" not in f.message and f.detail["years"] == 9 for f in findings)


def test_aggregates_link_by_recorded_components_not_substrings():
    base = [row(0, "Han", 0, 10, box(0, 0, 1, 1)), row(1, "Han", 200, 210, box(0, 0, 1, 1))]
    aggs = [row(9, "(Allegiance of Chauhan to Y)", 0, 300, box(0, 0, 1, 1), comps=("Chauhan", "Y"))]
    polities, _ = assign_identities(base, aggs, max_gap_years=50, switch_coverage=0.5)
    assert len(polities) == 2          # "Han" is not inside "Chauhan" for linking purposes


def test_slug_is_ascii_and_stable():
    assert slug("Anurādhapura") == "anuradhapura" and slug("(Warring States China)") == "warring-states-china"


# QA-008 heuristics
def test_whole_word_name_matching():
    assert name_similarity("Han Dynasty", ["Chauhan"]) < 0.7
    assert name_similarity("Han Dynasty", ["Han dynasty"]) == 1.0
    assert name_similarity("Byzantine Empire", ["Foreign relations of the Byzantine Empire"]) >= 0.7
    assert looks_like_polity(["foreign relations"]) is False
    assert looks_like_polity(["historical country"]) is True
    assert looks_like_polity([]) is None


def test_crosswalk_flags_corrects_and_never_uses_assertion_as_identity():
    pols = [Polity("roman-republic", "Roman Republic", -479, -31, [0], ("Q175881",), ()),
            Polity("revolutionary-roman-republic", "Revolutionary Roman Republic", 1799, 1799, [1], ("Q175881",), ()),
            Polity("han-dynasty", "Han Dynasty", -205, 220, [2], ("Q1068371",), ())]
    snap = {"items": {
        "Q175881": {"label": "Roman Republic", "aliases": [], "types": ["historical country"], "inception": 1798, "dissolved": 1799},
        "Q1068371": {"label": "Chauhan", "aliases": [], "types": ["clan"], "inception": None, "dissolved": None}}}
    ov = [Override("Roman Republic", "Q175881", "Q17167", "Roman Republic (509-27 BC)", "rows before 1 CE", "verified", "wd")]
    recs, findings = crosswalk(pols, snap, ov)
    by = {(r["polity_id"], r["value"]): r for r in recs}
    assert by[("roman-republic", "Q175881")]["status"] == "corrected"
    assert by[("roman-republic", "Q175881")]["corrected_to"]["value"] == "Q17167"
    assert by[("revolutionary-roman-republic", "Q175881")]["status"] == "asserted"      # scope excludes modern rows
    assert "name_mismatch" in by[("han-dynasty", "Q1068371")]["flags"]
    assert any(f.rule == "QA-007" and f.subject_id == "Q175881" for f in findings)
    assert any(f.rule == "QA-008" and f.severity == "warning" and "Chauhan" in f.message for f in findings)


# QA-004 / QA-005 / D-012
def test_combined_unique_and_land_area_are_different_measures():
    a, b = to_equal_area(box(0, 0, 2, 2)), to_equal_area(box(1, 0, 3, 2))
    land = to_equal_area(box(0, 0, 2.5, 2))
    m = year_measures(0, [a, b], land, 1.0)
    assert m.combined_polygon_area_km2 > m.unique_mapped_area_km2 > m.unique_mapped_land_km2
    assert abs(m.counted_twice_km2 - shapely.area(shapely.intersection(a, b)) / 1e6) < 1e-6
    pairs = overlaps(["a", "b"], [a, b], set(), sliver_km2=1000, sliver_fraction=0.01)
    assert pairs[0]["kind"] == "unlinked"
    assert overlaps(["a", "b"], [a, b], {frozenset(("a", "b"))}, 1000, 0.01)[0]["kind"] == "linked"


# QA-009
def test_transient_stray_part_is_flagged_but_persistent_possession_is_not():
    main = box(0, 40, 10, 50)
    stray = box(19, 41, 19.5, 41.5)                 # about 700 km away, tiny
    with_stray = shapely.MultiPolygon([main, stray])
    soissons = [row(0, "Soissons", 476, 479, with_stray), row(1, "Soissons", 480, 489, main)]
    colony = [row(2, "Empire", 0, 10, with_stray), row(3, "Empire", 11, 20, with_stray)]
    pols = [Polity("soissons", "Soissons", 476, 489, [0, 1], (), ()), Polity("empire", "Empire", 0, 20, [2, 3], (), ())]
    f = rules.qa009_stray_parts(soissons + colony, pols, stray_km=500, stray_fraction=0.05)
    assert [x.subject_id for x in f if x.severity == "warning"] == ["0"]


# QA-010
def test_core_sample_exact_near_gap_and_overlap():
    base = [row(0, "A", 0, 10, box(0, 0, 1, 1)), row(1, "B", 20, 30, box(1.03, 0, 2, 1)),
            row(2, "C", 25, 40, box(0, 0, 1, 1))]
    idx = PointIndex(base, {0: ("a", "A"), 1: ("b", "B"), 2: ("c", "C")})
    s = idx.sample(0.99, 0.5, tolerance_km=5)
    assert [(x.polity_id, x.exact) for x in s.strata] == [("a", True), ("b", False), ("c", True)]
    assert s.gaps == [(11, 19)]
    assert s.overlaps == [("b", "c", 25, 30)]
    assert 0 < s.strata[1].distance_km <= 5


# render preparation
def test_grid_split_preserves_area_and_winding():
    poly = box(-7, 3, 12, 14)
    parts = render_parts(poly, grid_deg=5)
    assert len(parts) > 1
    assert abs(sum(p.area for p in parts) - poly.area) < 1e-9
    assert all(p.exterior.is_ccw for p in parts)                         # RFC 7946 exterior winding
    assert all(p.bounds[2] - p.bounds[0] <= 5 + 1e-9 for p in parts)
