"""Direction studies: every base polity polygon within ~5 km (0.05 deg) of Rome's coordinates, merged into strata, with exact/near flags.

    uv run --no-project --python 3.11 --with 'shapely==2.1.*' python -I extract_core_rome.py <cliopatria.geojson> <work>/extract/core_rome.json
"""
import json, sys
from shapely.geometry import shape, Point
fs = json.load(open(sys.argv[1]))["features"]
base = [f for f in fs if f["properties"]["Type"] == "POLITY" and not f["properties"]["Name"].startswith("(")]
pt = Point(12.4964, 41.9028); probe = pt.buffer(0.05)
rows = []
for f in base:
    p = f["properties"]; g = shape(f["geometry"]); b = g.bounds
    if b[0]-.05 <= pt.x <= b[2]+.05 and b[1]-.05 <= pt.y <= b[3]+.05 and g.intersects(probe):
        rows.append((p["FromYear"], p["ToYear"], p["Name"], p["Wikidata"], bool(g.contains(pt))))
rows.sort(); spans = []
for a, b, n, wd, exact in rows:
    m = next((s for s in reversed(spans) if s["name"] == n and a - s["to"] <= 1), None)
    if m: m["to"] = max(m["to"], b); m["exact"] = m["exact"] or exact
    else: spans.append({"name": n, "from": a, "to": b, "wd": wd, "exact": exact})
json.dump(spans, open(sys.argv[2], "w"), indent=0)
for s in spans: print(s)
