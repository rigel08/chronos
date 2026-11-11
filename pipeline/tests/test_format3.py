"""Bundle format 3 (milestone 1.3): varint triangles, edge flags, overlap regions, colours, catalogue."""
from __future__ import annotations

import json

import numpy as np
import pytest
import shapely
from shapely.geometry import box

from chronos_pipeline.build import run
from chronos_pipeline.colours import assign_colours, similarity
from chronos_pipeline.encode import decode_triangles, encode_triangles, leb128, read_leb128, unzigzag, zigzag
from chronos_pipeline.render import EDGE_SYNTHETIC, _edge_flags


def test_zigzag_and_leb128_round_trip_at_byte_boundaries():
    d = np.array([0, -1, 1, -64, 63, 64, -65, 8191, -8192, 8192, 2**20, -(2**27), 2**30], dtype=np.int64)
    assert np.array_equal(unzigzag(zigzag(d)), d)
    v = zigzag(d)
    buf = leb128(v)
    assert np.array_equal(read_leb128(buf, len(v)), v)
    assert leb128(np.array([0, 127, 128, 16383, 16384], np.uint64)) == bytes([0, 127, 0x80, 1, 0xFF, 0x7F, 0x80, 0x80, 1])


def test_triangle_encoding_is_lossless_with_empty_parts():
    # three parts: 2 triangles over vertices 0-3, an empty part, 1 triangle over vertices 7-9
    tri = np.array([0, 1, 2, 0, 2, 3, 7, 9, 8], dtype=np.uint32)
    pts = np.array([0, 6, 6, 9], dtype=np.uint32)
    first = np.array([0, 4, 7], dtype=np.uint32)
    enc = encode_triangles(tri, pts, first)
    assert len(enc) == 9                                                # every delta fits one byte
    assert np.array_equal(decode_triangles(enc, pts, first), tri)


def test_edge_flags_mark_grid_cuts_and_antimeridian_but_not_borders_on_grid_lines():
    original = shapely.union_all([box(0, 0, 10, 4), box(170, 0, 180, 4)])
    shapely.prepare(original)
    # the left half of box(0,0,10,4) after a 5-degree cut: its edge on x=5 is a cut, its edge on x=0 is a real border
    ring = np.array([[0, 0], [5, 0], [5, 4], [0, 4], [0, 0]], dtype=np.float64)
    f = _edge_flags(ring, original, 5.0)
    assert list(f) == [0, EDGE_SYNTHETIC, 0, 0, 0]                    # (5,0)->(5,4) is the cut; (0,4)->(0,0) is a border
    east = np.array([[175, 0], [180, 0], [180, 4], [175, 4], [175, 0]], dtype=np.float64)
    fe = _edge_flags(east, original, 5.0)
    assert fe[1] == EDGE_SYNTHETIC and fe[3] == EDGE_SYNTHETIC          # antimeridian and the x=175 cut


def test_colours_separate_a_triangle_of_neighbours_and_prefer_distinct_hues():
    palette = ["#cf5637", "#4b70c6", "#d9a845", "#cf5638"]            # the 4th is the 1st, one unit off
    w = {("a", "b"): 10, ("b", "c"): 10, ("a", "c"): 10}
    col, stats = assign_colours(["a", "b", "c"], w, palette, 0.12)
    assert len({col["a"], col["b"], col["c"]}) == 3 and stats["same_colour_pairs"] == 0
    assert stats["similar_colour_pairs"] == 0                          # never both cinnabar and its near twin
    s = similarity(palette, 0.12)
    assert s[0, 3] > 0.9 and s[0, 1] == 0


def test_mini_build_overlap_regions_colours_and_catalogue(mini_repo):
    out = run(mini_repo, "public", log=lambda *_: None)
    b = json.loads((out / "bundle.json").read_text())
    raw = (out / b["geometry"]["file"]).read_bytes()
    S = b["geometry"]["sections"]
    sec = lambda n: np.frombuffer(raw, S[n]["dtype"], S[n]["length"], S[n]["offset"])
    # Alpha 1..99 [0,5]x[0,4] overlaps Beta -49..50 [4,8]x[0,4] on [4,5]x[0,4] in years 1..50; the alliance row links them
    assert b["overlaps"]["regions"] == 1
    assert list(sec("region_start")) == [1] and list(sec("region_end")) == [50]
    assert list(sec("region_kind")) == [b["overlaps"]["kind_codes"]["linked"]]
    terr = sec("region_territories").reshape(-1, b["overlaps"]["slots"])[0]
    polity = sec("territory_polity")
    names = {b["polities"][polity[t]]["id"] for t in terr if t != 0xFFFFFFFF}
    assert names == {"alpha", "beta"}
    assert 40_000 < float(sec("region_area_km2")[0]) < 50_000          # 1 x 4 degrees near the equator
    ov_tri = decode_triangles(sec("ov_triangles_varint").tobytes(), sec("ov_part_triangle_start"),
                              sec("ov_ring_start")[sec("ov_part_ring_start")[:-1]])
    assert len(ov_tri) == 6                                             # one rectangle, two triangles
    # neighbours (Alpha touches Beta) get different colours; colours are indices into the palette
    colour = {p["id"]: p["colour"] for p in b["polities"]}
    assert colour["alpha"] != colour["beta"] and all(0 <= c < len(b["palette"]["colours"]) for c in colour.values())
    # labels lie inside their territory
    lab = sec("territory_label").reshape(-1, 2)
    starts = sec("territory_start")
    assert lab.shape[0] == len(starts)
    # catalogue: findings with messages, review notes on a row and on a polity
    cat = json.loads((out / b["files"]["catalog"]["path"]).read_text())
    assert cat["rows"]["3"]["notes"][0]["note"].startswith("Under review")
    assert cat["polities"]["beta"]["notes"] and any(f["rule"] == "QA-008" for f in cat["polities"]["beta"]["findings"])
    assert "QA-004" in cat["rules"]
    # sources carry licence and evidence; the citation no longer claims simplification (D-017)
    clio = next(s for s in b["sources"] if s["id"] == "cliopatria")
    assert clio["license"] == "CC-BY-4.0" and clio["evidence"] == "interpreted" and "not simplified" in clio["citation"]
    assert all(s["access_tier"] == "public" for s in b["sources"])
    report = json.loads((out / "qa_report.json").read_text())
    checks = [f for f in report["findings"] if f["subject_id"].startswith("overlaps:check:")]
    assert checks and all(f["severity"] == "info" and f["detail"]["ok"] for f in checks)


def test_review_note_for_unknown_row_fails_the_build(mini_repo):
    from chronos_pipeline.build import BuildError
    (mini_repo.registry / "review_notes.csv").write_text("subject_type,subject_id,note,reference,added_on\nrow,999,x,y,z\n")
    with pytest.raises(BuildError, match="review note"):
        run(mini_repo, "public", log=lambda *_: None)
