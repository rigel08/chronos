"""Assemble the direction-studies page from the template and the Phase 0 outputs.

    python3 -I research/phase0/direction-studies/build_page.py --work <dir> --out <page.html>

<dir> must contain:
  dl-worldatlas/package/land-110m.json   (world-atlas 2.0.2)
  extract/world_117.geojson, extract/core_rome.json, extract/stream_-500_700.json, extract/density.json
                                          (extract_world_117.py, extract_core_rome.py, extract_stream.py)
  validation/stream_unique_-500_700.json, validation/wikidata_crosswalk.json
                                          (validate_cliopatria.py, wikidata_crosswalk.py)
The built page embeds Cliopatria-derived data (CC BY 4.0, attributed in the page) and is not committed.
"""
from __future__ import annotations

import argparse
import csv
import json
import pathlib
import re

HERE = pathlib.Path(__file__).resolve().parent


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", required=True, type=pathlib.Path)
    ap.add_argument("--out", required=True, type=pathlib.Path)
    a = ap.parse_args()
    W = a.work
    world = json.loads((W / "extract/world_117.geojson").read_text())
    core = json.loads((W / "extract/core_rome.json").read_text())

    # QA map: one entry per polity name shown on the page.
    names = {f["properties"]["name"] for f in world["features"]} | {c["name"] for c in core}
    cw = json.loads((W / "validation/wikidata_crosswalk.json").read_text())
    fixes = {}
    with open(HERE.parents[2] / "pipeline/registry/crosswalk_overrides.csv", newline="") as fh:
        for r in csv.DictReader(fh):
            if r["status"] == "verified":
                fixes[r["cliopatria_name"]] = {"qid": r["proposed_qid"], "label": r["proposed_label"]}
    qa = {}
    for c in cw["checks"]:
        if c["name"] in names and c["name"] not in qa:
            qa[c["name"]] = {"qid": c["qid"], "label": c.get("wd_label"), "span": c.get("wd_span"),
                             "flags": c["flags"], "fix": fixes.get(c["name"])}
    missing = sorted(names - set(qa))
    if missing:
        raise SystemExit(f"no Wikidata check for: {missing}")

    data = {
        "land": json.loads((W / "dl-worldatlas/package/land-110m.json").read_text()),
        "world": world,
        "core": core,
        "stream": json.loads((W / "extract/stream_-500_700.json").read_text()),
        "uniq": json.loads((W / "validation/stream_unique_-500_700.json").read_text()),
        "density": json.loads((W / "extract/density.json").read_text()),
        "qa": qa,
    }
    tpl = (HERE / "template.html").read_text()
    out = tpl.replace("/*__DATA__*/", "const DATA = " + json.dumps(data, separators=(",", ":"), ensure_ascii=False) + ";")
    a.out.write_text(out)
    (a.out.parent / "_check.js").write_text("\n".join(re.findall(r"<script>(.*?)</script>", out, re.S)))
    warn = sorted(n for n, q in qa.items() if q["fix"] or {"name_mismatch", "not_a_polity_item", "no_temporal_overlap"} & set(q["flags"]))
    print(f"page bytes: {len(out.encode()):,} | QA entries: {len(qa)} | flagged on page: {warn}")


if __name__ == "__main__":
    main()
