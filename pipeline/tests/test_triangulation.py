"""Pre-triangulation (D-021) and its accuracy check (QA-013)."""
from __future__ import annotations

import json

import numpy as np
import pytest

from chronos_pipeline.build import run
from chronos_pipeline.encode import decode_triangles
from chronos_pipeline.geo import _deviation, inverse_web_mercator, orient_ccw, render_parts, triangulate, web_mercator


def ring(coords):
    return np.asarray(coords, dtype=np.float64)


def ccw_all(lonlat, idx):
    t = idx.reshape(-1, 3)
    a, b, c = lonlat[t[:, 0]], lonlat[t[:, 1]], lonlat[t[:, 2]]
    return bool(np.all((b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1]) - (c[:, 0] - a[:, 0]) * (b[:, 1] - a[:, 1]) >= 0))


def test_mercator_round_trip():
    pts = ring([[-170.3, -55.8], [0, 0], [12.5, 41.9], [180, 83.7]])
    assert np.allclose(inverse_web_mercator(web_mercator(pts)), pts, atol=1e-9)


def test_square_with_hole_preserves_area_and_is_ccw():
    outer = ring([[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]])
    hole = ring([[1, 1], [1, 2], [2, 2], [2, 1], [1, 1]])
    [piece] = triangulate([outer, hole])
    assert not piece.repaired
    assert piece.relative_deviation < 1e-9 and piece.absolute_km2 < 1e-6
    assert len(piece.indices) == 3 * 8
    assert ccw_all(np.vstack([outer, hole]), piece.indices)


def test_self_intersecting_part_is_repaired_not_mis_drawn():
    bowtie = ring([[0, 0], [2, 2], [2, 0], [0, 2], [0, 0]])          # crosses itself at (1, 1)
    pieces = triangulate([bowtie])
    assert pieces and all(p.repaired for p in pieces)
    assert len(pieces) == 2
    assert all(p.absolute_km2 < 1e-3 for p in pieces)


def test_orient_ccw_flips_only_clockwise_triangles():
    pts = ring([[0, 0], [1, 0], [0, 1]])
    assert list(orient_ccw(pts, np.array([0, 2, 1], dtype=np.uint32))) == [0, 1, 2]
    assert list(orient_ccw(pts, np.array([0, 1, 2], dtype=np.uint32))) == [0, 1, 2]


def test_deviation_detects_missing_triangles():
    m = [web_mercator(ring([[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]]))]
    rel, _ = _deviation(m, np.array([0, 1, 2], dtype=np.uint32))        # only half the square
    assert rel == pytest.approx(0.5, rel=1e-3)


def test_bundle_triangles_stay_inside_their_parts_and_match_area(mini_repo):
    out = run(mini_repo, "public", log=lambda *_: None)
    b = json.loads((out / "bundle.json").read_text())
    assert b["format"] == 3
    raw = (out / b["geometry"]["file"]).read_bytes()
    sec = lambda n: np.frombuffer(raw, b["geometry"]["sections"][n]["dtype"], b["geometry"]["sections"][n]["length"],
                                  b["geometry"]["sections"][n]["offset"])
    pos = sec("positions").reshape(-1, 2).astype(np.float64)
    pts = sec("part_triangle_start")
    rs, prs = sec("ring_start"), sec("part_ring_start")
    tri = decode_triangles(sec("triangles_varint").tobytes(), pts, rs[prs[:-1]])
    for p in range(len(prs) - 1):
        v0, v1 = rs[prs[p]], rs[prs[p + 1]]
        t = tri[pts[p]:pts[p + 1]]
        assert len(t) and t.min() >= v0 and t.max() < v1
        rings = [pos[rs[r]:rs[r + 1]] for r in range(prs[p], prs[p + 1])]
        rel, _ = _deviation([web_mercator(r) for r in rings], (t - v0).astype(np.uint32))
        assert rel < 1e-9
        assert ccw_all(pos, t)
    report = json.loads((out / "qa_report.json").read_text())
    assert "QA-013" in report["summary"] and "error" not in report["summary"]["QA-013"]


@pytest.mark.data
def test_parts_mis_drawn_by_plain_earcut_are_now_exact(real):
    # Validation of milestone 1.2: plain earcut over-drew ~2,214 km2 (Mughal Empire 1762-1771) and ~42 km2
    # (Grand Duchy of Lithuania 1260-1293). The pipeline's triangulation must draw them within 0.001 km2.
    targets = [r for r in real["base"] if (r.name == "Mughal Empire" and 1762 <= r.from_src <= 1769)
               or (r.name == "Grand Duchy of Lithuania" and r.from_src in (1260, 1272))]
    assert len(targets) == 5
    for r in targets:
        for poly in render_parts(r.geometry, 5.0):
            rings = [np.asarray(x.coords, dtype=np.float64)[:, :2].astype("<f4").astype(np.float64)
                     for x in [poly.exterior, *poly.interiors]]
            for piece in triangulate(rings):
                assert piece.absolute_km2 < 1e-3, (r.name, r.from_src, piece.absolute_km2)
