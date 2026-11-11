"""Wikidata: a pinned snapshot (built once, then checksum-locked) and cross-reference QA (QA-007, QA-008).

Builds never query Wikidata live. `snapshot-wikidata` writes a deterministic snapshot of every QID
Cliopatria asserts; its sha256 is then pinned in data/manifest.lock.json like any other input.
"""
from __future__ import annotations

import csv
import difflib
import json
import re
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

from ..qa.findings import Finding

ENDPOINT = "https://query.wikidata.org/sparql"
USER_AGENT = "CHRONOS-pipeline/0.1 (Wikidata snapshot; research use)"
QUERY = """
SELECT ?item (SAMPLE(?l) AS ?label) (SAMPLE(?d) AS ?desc)
       (GROUP_CONCAT(DISTINCT ?a; separator="\\u001f") AS ?aliases)
       (GROUP_CONCAT(DISTINCT ?il; separator="\\u001f") AS ?types)
       (MIN(?inc) AS ?inception) (MAX(?dis) AS ?dissolved) WHERE {
  VALUES ?item { %s }
  OPTIONAL { ?item rdfs:label ?l FILTER(LANG(?l) = "en") }
  OPTIONAL { ?item schema:description ?d FILTER(LANG(?d) = "en") }
  OPTIONAL { ?item skos:altLabel ?a FILTER(LANG(?a) = "en") }
  OPTIONAL { ?item wdt:P31 ?i . ?i rdfs:label ?il FILTER(LANG(?il) = "en") }
  OPTIONAL { ?item wdt:P571 ?inc }
  OPTIONAL { ?item wdt:P576 ?dis }
} GROUP BY ?item
"""
SEP = "\u001f"


def xsd_year(v: str | None) -> int | None:
    """WDQS dates use XSD 1.1 years, which are astronomical (0000 = 1 BCE). Kept astronomical."""
    if not v:
        return None
    m = re.match(r"^(-?)(\d+)-", v)
    return None if not m else int(m.group(2)) * (-1 if m.group(1) else 1)


def build_snapshot(qids: list[str], generated_on: str, batch: int = 200) -> dict:
    items: dict[str, dict] = {}
    for i in range(0, len(qids), batch):
        part = qids[i:i + batch]
        body = urllib.parse.urlencode({"query": QUERY % " ".join("wd:" + q for q in part)}).encode()
        req = urllib.request.Request(ENDPOINT, data=body, headers={
            "User-Agent": USER_AGENT, "Accept": "application/sparql-results+json",
            "Content-Type": "application/x-www-form-urlencoded"})
        with urllib.request.urlopen(req, timeout=120) as r:
            for b in json.load(r)["results"]["bindings"]:
                q = b["item"]["value"].rsplit("/", 1)[-1]
                g = lambda k, b=b: b.get(k, {}).get("value")
                items[q] = {"label": g("label"), "description": g("desc"),
                            "aliases": sorted(x for x in (g("aliases") or "").split(SEP) if x),
                            "types": sorted(x for x in (g("types") or "").split(SEP) if x),
                            "inception": xsd_year(g("inception")), "dissolved": xsd_year(g("dissolved"))}
        time.sleep(1.0)
    for q in qids:
        items.setdefault(q, {"label": None, "description": None, "aliases": [], "types": [],
                             "inception": None, "dissolved": None})
    return {"format": 1, "generated_on": generated_on, "endpoint": ENDPOINT,
            "years": "astronomical (XSD 1.1)", "items": dict(sorted(items.items()))}


def write_snapshot(snapshot: dict, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(snapshot, indent=1, sort_keys=True, ensure_ascii=False) + "\n")


# --------------------------------------------------------------------------- checks

POLITY_WORDS = ("state", "country", "empire", "kingdom", "dynasty", "polity", "confedera", "khanate", "khaganate",
                "caliphate", "sultanate", "republic", "principality", "duchy", "county", "chiefdom", "tribe", "people",
                "ethnic group", "civilization", "culture", "protectorate", "colony", "territory", "monarchy", "realm",
                "emirate", "satrap", "vassal", "nation", "government", "regime", "federation", "league", "union",
                "dominion", "march", "margraviate", "city", "polis", "janapada", "mahajanapada", "imamate", "shogunate")
_STOP = r"\b(the|of|kingdom|empire|dynasty|state|states|sultanate|khanate|republic|city-states|confederation)\b"


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", re.sub(_STOP, " ", s.lower())).strip()


def name_similarity(name: str, labels: list[str]) -> float:
    """Whole-word matching only: "Han" must not match "Chauhan" (validation 0001)."""
    best = 0.0
    for lab in labels:
        if not lab:
            continue
        r = difflib.SequenceMatcher(None, name.lower(), lab.lower()).ratio()
        a, b = _norm(name), _norm(lab)
        if a and b:
            r = max(r, difflib.SequenceMatcher(None, a, b).ratio())
            ta, tb = set(a.split()), set(b.split())
            if ta == tb:
                r = 1.0
            elif ta <= tb or tb <= ta:
                r = max(r, 0.9)
        best = max(best, r)
    return round(best, 3)


def looks_like_polity(types: list[str]) -> bool | None:
    if not types:
        return None
    return any(w in t.lower() for t in types for w in POLITY_WORDS)


@dataclass(frozen=True)
class Override:
    name: str
    asserted_qid: str
    proposed_qid: str
    proposed_label: str
    scope: str
    status: str
    evidence: str

    def applies(self, polity_name: str, qid: str, end: int) -> bool:
        if polity_name != self.name or qid != self.asserted_qid:
            return False
        if self.scope == "rows before 1 CE":
            return end <= 0
        return self.scope == "all rows with this name"


def load_overrides(path: Path) -> list[Override]:
    with open(path, newline="") as fh:
        return [Override(name=r["cliopatria_name"], asserted_qid=r["cliopatria_qid"], proposed_qid=r["proposed_qid"],
                         proposed_label=r["proposed_label"], scope=r["scope"], status=r["status"],
                         evidence=r["evidence"]) for r in csv.DictReader(fh)]


def crosswalk(polities: list, snapshot: dict, overrides: list[Override],
              min_similarity: float = 0.7) -> tuple[list[dict], list[Finding]]:
    """Return one external_id record per (polity, asserted QID), plus QA-007 and QA-008 findings."""
    items = snapshot["items"]
    records: list[dict] = []
    findings: list[Finding] = []
    by_qid: dict[str, list[str]] = defaultdict(list)
    for p in polities:
        shown = p.name if "@" not in p.id else f"{p.name} [{p.id}]"   # disambiguate identity splits
        for q in p.asserted_qids:
            by_qid[q].append(p.id)
            w = items.get(q)
            flags: list[str] = []
            if not w or not w["label"]:
                flags.append("missing_or_unlabelled")
                sim = 0.0
            else:
                sim = name_similarity(p.name, [w["label"], *w["aliases"]])
                if sim < min_similarity:
                    flags.append("name_mismatch")
                if looks_like_polity(w["types"]) is False:
                    flags.append("not_a_polity_item")
                inc, dis = w["inception"], w["dissolved"]
                if inc is not None and dis is not None and (p.end < inc - 50 or p.start > dis + 50):
                    flags.append("no_temporal_overlap")
                elif (inc is not None and abs(p.start - inc) > 150) or (dis is not None and abs(p.end - dis) > 150):
                    flags.append("lifespan_differs_150y")
            fix = next((o for o in overrides if o.status == "verified" and o.applies(p.name, q, p.end)), None)
            research = next((o for o in overrides if o.name == p.name and o.asserted_qid == q
                             and o.status == "needs research"), None)
            label = w["label"] if w else None
            rec = {"polity_id": p.id, "scheme": "wikidata", "value": q, "label": label,
                   "status": "corrected" if fix is not None else "asserted",
                   "asserted_by": "cliopatria", "flags": flags, "name_similarity": sim}
            if fix is not None:
                rec["corrected_to"] = {"value": fix.proposed_qid, "label": fix.proposed_label,
                                       "asserted_by": "chronos-editorial", "evidence": fix.evidence}
            records.append(rec)
            strong = [f for f in flags if f != "lifespan_differs_150y"]
            if fix is not None:
                findings.append(Finding("QA-008", "info", "external_id", f"{p.id}:{q}",
                                        f"{shown}: Cliopatria links {q} “{label}”; corrected to "
                                        f"{fix.proposed_qid} “{fix.proposed_label}” (verified).",
                                        {"flags": flags, "override": fix.proposed_qid}))
            elif strong or research:
                why = ", ".join(strong) if strong else "identity under research"
                findings.append(Finding("QA-008", "warning", "external_id", f"{p.id}:{q}",
                                        f"{shown}: Cliopatria links {q} “{label}” ({why}). Shown as given; "
                                        "not used as identity.", {"flags": flags, "similarity": sim,
                                                                  "needs_research": bool(research)}))
            elif flags:
                findings.append(Finding("QA-008", "info", "external_id", f"{p.id}:{q}",
                                        f"{shown}: {q} dates differ from Wikidata's by more than 150 years.",
                                        {"flags": flags}))
    for q, pids in sorted(by_qid.items()):
        if len(pids) > 1:
            findings.append(Finding("QA-007", "warning", "external_id", q,
                                    f"{q} is asserted for {len(pids)} CHRONOS polities: {', '.join(sorted(pids))}.",
                                    {"polities": sorted(pids)}))
    return records, findings
