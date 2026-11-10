"""Check every Wikidata QID in Cliopatria against Wikidata itself.

For each QID: English label, aliases, description, instance-of labels, inception (P571)
and dissolution (P576). Each Cliopatria polity name is then compared with the label
(name similarity) and with the dates (lifespan agreement). The output lists QA flags;
it does not change any data.

Usage:
    python3 -I research/phase0/wikidata_crosswalk.py \
        --cliopatria <path>/cliopatria_polities_only_v021.geojson --out <output dir>

Wikidata content is CC0. Dates come from the Wikidata Query Service RDF, which uses
XSD 1.1 years (year 0 = 1 BCE); they are converted to Cliopatria's numbering
(negative = BCE) before comparison.
"""
from __future__ import annotations

import argparse
import collections
import difflib
import json
import pathlib
import re
import time
import urllib.parse
import urllib.request

ENDPOINT = "https://query.wikidata.org/sparql"
UA = "CHRONOS-phase0-validation/0.1 (research script; python urllib)"
QUERY = """
SELECT ?item (SAMPLE(?l) AS ?label) (SAMPLE(?d) AS ?desc)
       (GROUP_CONCAT(DISTINCT ?a; separator="|") AS ?aliases)
       (GROUP_CONCAT(DISTINCT ?il; separator="|") AS ?types)
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


def sparql(qids: list[str]) -> list[dict]:
    body = urllib.parse.urlencode({"query": QUERY % " ".join("wd:" + q for q in qids)}).encode()
    req = urllib.request.Request(ENDPOINT, data=body, headers={
        "User-Agent": UA, "Accept": "application/sparql-results+json",
        "Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)["results"]["bindings"]


def year(v: str | None) -> int | None:
    """XSD 1.1 dateTime year -> Cliopatria-style year (negative = BCE, no year 0)."""
    if not v:
        return None
    m = re.match(r"^(-?)(\d+)-", v)
    if not m:
        return None
    y = int(m.group(2)) * (-1 if m.group(1) else 1)
    return y if y > 0 else y - 1   # XSD 0 -> 1 BCE (-1), XSD -1 -> 2 BCE (-2)


def norm(s: str) -> str:
    s = s.lower()
    s = re.sub(r"\b(the|of|kingdom|empire|dynasty|state|states|sultanate|khanate|republic|city-states|confederation)\b", " ", s)
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


def similarity(name: str, labels: list[str]) -> float:
    """Best match of the Cliopatria name against the Wikidata label and aliases.

    Substring matches are deliberately NOT accepted ("han" is inside "chauhan");
    only whole-word subsets count as a near-exact match.
    """
    best = 0.0
    for lab in labels:
        if not lab:
            continue
        a, b = norm(name), norm(lab)
        r = difflib.SequenceMatcher(None, name.lower(), lab.lower()).ratio()
        if a and b:
            r = max(r, difflib.SequenceMatcher(None, a, b).ratio())
            ta, tb = set(a.split()), set(b.split())
            if ta == tb:
                r = 1.0
            elif ta <= tb or tb <= ta:
                r = max(r, 0.9)
        best = max(best, r)
    return round(best, 3)


POLITY_WORDS = ("state", "country", "empire", "kingdom", "dynasty", "polity", "confedera", "khanate", "khaganate",
                "caliphate", "sultanate", "republic", "principality", "duchy", "county", "chiefdom", "tribe", "people",
                "ethnic group", "civilization", "culture", "protectorate", "colony", "territory", "monarchy", "realm",
                "emirate", "satrap", "vassal", "nation", "government", "regime", "federation", "league", "union",
                "dominion", "march", "margraviate", "city", "polis", "janapada", "mahajanapada", "imamate", "shogunate")


def looks_like_polity(types: list[str]) -> bool | None:
    if not types:
        return None
    return any(w in t.lower() for t in types for w in POLITY_WORDS)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cliopatria", required=True, type=pathlib.Path)
    ap.add_argument("--out", required=True, type=pathlib.Path)
    a = ap.parse_args()
    rows = json.loads(a.cliopatria.read_text())["features"]
    span = {}
    qnames = collections.defaultdict(set)
    for f in rows:
        p = f["properties"]
        if p["Type"] != "POLITY" or p["Name"].startswith("("):
            continue
        lo, hi = span.get(p["Name"], (10**9, -10**9))
        span[p["Name"]] = (min(lo, p["FromYear"]), max(hi, p["ToYear"]))
        for q in (p["Wikidata"] or "").split(";"):
            if q.strip():
                qnames[q.strip()].add(p["Name"])
    qids = sorted(qnames)
    wd = {}
    for i in range(0, len(qids), 200):
        for b in sparql(qids[i:i + 200]):
            q = b["item"]["value"].rsplit("/", 1)[-1]
            g = lambda k: b.get(k, {}).get("value")
            wd[q] = {"label": g("label"), "desc": g("desc"),
                     "aliases": [x for x in (g("aliases") or "").split("|") if x],
                     "types": [x for x in (g("types") or "").split("|") if x],
                     "inception": year(g("inception")), "dissolved": year(g("dissolved"))}
        time.sleep(1.0)

    checks = []
    for q, names in qnames.items():
        w = wd.get(q)
        for n in sorted(names):
            lo, hi = span[n]
            c = {"qid": q, "name": n, "cliopatria_span": [lo, hi], "flags": []}
            if not w or not w["label"]:
                c["flags"].append("qid_missing_or_unlabelled")
                checks.append(c)
                continue
            c.update(wd_label=w["label"], wd_desc=w["desc"], wd_types=w["types"][:4],
                     wd_span=[w["inception"], w["dissolved"]])
            c["name_similarity"] = similarity(n, [w["label"], *w["aliases"]])
            if c["name_similarity"] < 0.7:
                c["flags"].append("name_mismatch")
            if looks_like_polity(w["types"]) is False:
                c["flags"].append("not_a_polity_item")
            inc, dis = w["inception"], w["dissolved"]
            if inc is not None and dis is not None and (hi < inc - 50 or lo > dis + 50):
                c["flags"].append("no_temporal_overlap")
            elif (inc is not None and abs(lo - inc) > 150) or (dis is not None and abs(hi - dis) > 150):
                c["flags"].append("lifespan_differs_150y")
            if len(names) > 1:
                c["flags"].append("qid_shared_by_%d_names" % len(names))
            checks.append(c)
    flagged = [c for c in checks if c["flags"]]
    counts = collections.Counter(fl.split("_by_")[0] if fl.startswith("qid_shared") else fl for c in checks for fl in c["flags"])
    out = {"qids_checked": len(qids), "qids_resolved": len(wd), "name_qid_pairs": len(checks),
           "flag_counts": dict(counts), "flagged": flagged, "checks": checks}
    a.out.mkdir(parents=True, exist_ok=True)
    (a.out / "wikidata_crosswalk.json").write_text(json.dumps(out, indent=1, ensure_ascii=False))
    print(json.dumps({k: v for k, v in out.items() if k not in ("flagged", "checks")}, indent=1))
    strong = [c for c in flagged if {"no_temporal_overlap", "name_mismatch", "not_a_polity_item", "qid_missing_or_unlabelled"} & set(c["flags"])]
    out["strong_suspects"] = len(strong)
    (a.out / "wikidata_crosswalk.json").write_text(json.dumps(out, indent=1, ensure_ascii=False))
    print(f"\nstrong suspects (name mismatch, not a polity item, no temporal overlap, or missing): {len(strong)}")
    for c in sorted(strong, key=lambda c: c.get("name_similarity", 0))[:25]:
        print(f"  {c['qid']:>11}  {c['name']!r} {c['cliopatria_span']}  ->  {c.get('wd_label')!r} {c.get('wd_span')}  sim={c.get('name_similarity')}  {c['flags']}")
    for q in ("Q175881", "Q12544", "Q112039853", "Q1154556", "Q172579", "Q4962", "Q241748", "Q2277"):
        w = wd.get(q)
        print(f"  {q}: {w and w['label']!r} | {w and w['desc']!r} | span {w and [w['inception'], w['dissolved']]} | used by {sorted(qnames.get(q, []))}")


if __name__ == "__main__":
    main()
