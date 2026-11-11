"""Cliopatria adapter: read rows, separate aggregates (QA-002), assign polity identities (D-011, D-016)."""
from __future__ import annotations

import json
import re
import unicodedata
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import shapely
from shapely.geometry import shape

from ..qa.findings import Finding
from ..years import cliopatria_to_astronomical

SOURCE_ID = "cliopatria"


def _split(v: str | None) -> tuple[str, ...]:
    return tuple(x.strip() for x in (v or "").split(";") if x.strip())


@dataclass
class Row:
    index: int                 # position in the source file: the locator for every derived claim
    name: str
    type: str                  # POLITY | RELATION
    from_src: int              # years exactly as Cliopatria gives them
    to_src: int
    start: int                 # astronomical, inclusive
    end: int
    area_src: float
    wikidata: tuple[str, ...]
    seshat: tuple[str, ...]
    components: tuple[str, ...]
    member_of: tuple[str, ...]
    wikipedia: str
    geometry: Any = field(repr=False)

    @property
    def aggregate(self) -> bool:
        """Names in parentheses are groupings, alliances or allegiances, not territories (validation 0001)."""
        return self.name.startswith("(") or self.type == "RELATION"


def read_rows(path: Path) -> list[Row]:
    feats = json.loads(path.read_text())["features"]
    rows = []
    for i, f in enumerate(feats):
        p = f["properties"]
        rows.append(Row(
            index=i, name=p["Name"], type=p["Type"], from_src=int(p["FromYear"]), to_src=int(p["ToYear"]),
            start=cliopatria_to_astronomical(int(p["FromYear"])), end=cliopatria_to_astronomical(int(p["ToYear"])),
            area_src=float(p["Area"]), wikidata=_split(p.get("Wikidata")), seshat=_split(p.get("SeshatID")),
            components=_split(p.get("Components")), member_of=_split(p.get("MemberOf")),
            wikipedia=p.get("Wikipedia") or "", geometry=shapely.make_valid(shape(f["geometry"]))))
    return rows


def split_aggregates(rows: list[Row]) -> tuple[list[Row], list[Row]]:
    base = [r for r in rows if not r.aggregate]
    aggs = [r for r in rows if r.aggregate]
    return base, aggs


def slug(name: str) -> str:
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-") or "polity"


@dataclass
class Polity:
    id: str
    name: str
    start: int
    end: int
    rows: list[int]                         # source row indices
    asserted_qids: tuple[str, ...]          # as given by Cliopatria (external_id status 'asserted')
    seshat_ids: tuple[str, ...]


def _aggregate_cover(name: str, a: int, b: int, aggs_by_component: dict[str, list[Row]]) -> float:
    years: set[int] = set()
    for r in aggs_by_component.get(name, []):
        if r.start <= b and r.end >= a:
            years.update(range(max(a, r.start), min(b, r.end) + 1))
    return len(years) / (b - a + 1)


def assign_identities(base: list[Row], aggs: list[Row], max_gap_years: int,
                      switch_coverage: float) -> tuple[list[Polity], list[Finding]]:
    """Give rows CHRONOS polity ids. A name is never identity on its own (D-011).

    Rows sharing a name are split at an internal gap longer than `max_gap_years`, unless aggregate
    rows naming that polity cover at least `switch_coverage` of the gap (a representation switch,
    as with the Holy Roman Empire 1260-1618). Every gap produces a QA-006 finding.
    """
    by_name: dict[str, list[Row]] = defaultdict(list)
    for r in base:
        by_name[r.name].append(r)
    # Aggregates are linked to polities only through recorded fields: Components, or a grouping whose
    # parenthesised name is exactly a polity name, e.g. "(Holy Roman Empire)". Substring matching would
    # link "Han" to "(Allegiance of Chauhan ...)".
    aggs_by_component: dict[str, list[Row]] = defaultdict(list)
    for r in aggs:
        inner = r.name[1:-1] if r.name.startswith("(") and r.name.endswith(")") else None
        for c in set(r.components) | ({inner} if inner in by_name else set()):
            aggs_by_component[c].append(r)

    # 1. Segment each name's rows at gaps; remember every gap and the decision taken.
    segments: list[tuple[str, list[Row]]] = []
    gaps: list[tuple[int, dict, str]] = []   # (index of the segment the gap follows, detail, decision)
    for name in sorted(by_name):
        rows = sorted(by_name[name], key=lambda r: (r.start, r.end, r.index))
        current = [rows[0]]
        hi = rows[0].end
        for r in rows[1:]:
            if r.start > hi + 1:
                gap_a, gap_b = hi + 1, r.start - 1
                length = gap_b - gap_a + 1
                cover = _aggregate_cover(name, gap_a, gap_b, aggs_by_component)
                detail = {"name": name, "gap_start": gap_a, "gap_end": gap_b, "years": length,
                          "aggregate_coverage": round(cover, 3)}
                if length > max_gap_years and cover < switch_coverage:
                    segments.append((name, current))
                    gaps.append((len(segments) - 1, detail, "split"))
                    current = []
                else:
                    gaps.append((len(segments), detail, "switch" if length > max_gap_years else "short"))
            current.append(r)
            hi = max(hi, r.end)
        segments.append((name, current))

    # 2. Assign ids: one segment keeps the plain slug; several segments are suffixed with their start year.
    counts: dict[str, int] = defaultdict(int)
    for name, _ in segments:
        counts[name] += 1
    polities: list[Polity] = []
    used: set[str] = set()
    for name, rows in segments:
        pid = slug(name) if counts[name] == 1 else f"{slug(name)}@{rows[0].start}"
        if pid in used:   # different names that slug identically ("Hán" / "Han")
            n = 2
            while f"{pid}~{n}" in used:
                n += 1
            pid = f"{pid}~{n}"
        used.add(pid)
        polities.append(Polity(id=pid, name=name, start=min(r.start for r in rows), end=max(r.end for r in rows),
                               rows=[r.index for r in rows],
                               asserted_qids=tuple(sorted({q for r in rows for q in r.wikidata})),
                               seshat_ids=tuple(sorted({s for r in rows for s in r.seshat}))))

    # 3. Findings, attached to the polity the gap follows (QA-006).
    findings: list[Finding] = []
    for seg_index, d, decision in gaps:
        pid, name, n = polities[seg_index].id, d["name"], d["years"]
        if decision == "split":
            findings.append(Finding("QA-006", "warning", "polity", pid,
                                    f"{name}: {n}-year gap; split into separate polities pending review "
                                    "(likely different polities sharing a name).", d | {"split_into": polities[seg_index + 1].id}))
        elif decision == "switch":
            findings.append(Finding("QA-006", "info", "polity", pid,
                                    f"{name}: {n}-year gap drawn through aggregate rows "
                                    f"({d['aggregate_coverage']:.0%} coverage); kept as one polity.", d))
        else:
            findings.append(Finding("QA-006", "info", "polity", pid,
                                    f"{name}: {n}-year gap kept within one polity and shown as unmapped.", d))
    return polities, findings
