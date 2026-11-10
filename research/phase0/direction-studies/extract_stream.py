"""Direction studies: combined polygon area of the 14 largest polities, 500 BCE..700 CE in 5-year steps (aggregate rows excluded).

    uv run --no-project --python 3.11 --with 'shapely==2.1.*' python -I extract_stream.py <cliopatria.geojson> <work>/extract
"""
import json, sys, collections
from shapely.geometry import shape, Point
src, out = sys.argv[1], sys.argv[2]
fs = json.load(open(src))["features"]
base = [f for f in fs if f["properties"]["Type"] == "POLITY" and not f["properties"]["Name"].startswith("(")]
groups = [f for f in fs if f["properties"]["Name"].startswith("(")]
print("grouping rows '(...)':", len(groups), "e.g.", sorted({f["properties"]["Name"] for f in groups})[:6])
print("sample grouping props:", {k: groups[0]["properties"][k] for k in ("Name","Type","Components","MemberOf")})

def core(pt, tol):
    hits = []
    probe = pt.buffer(tol) if tol else pt
    for f in base:
        p = f["properties"]; g = shape(f["geometry"])
        b = g.bounds
        if b[0]-tol <= pt.x <= b[2]+tol and b[1]-tol <= pt.y <= b[3]+tol and g.intersects(probe):
            hits.append((p["FromYear"], p["ToYear"], p["Name"], p["Wikidata"], p["MemberOf"]))
    hits.sort(); spans = []
    for a, b, n, wd, mo in hits:
        m = next((s for s in reversed(spans) if s["name"] == n and a - s["to"] <= 1), None)
        if m: m["to"] = max(m["to"], b)
        else: spans.append({"name": n, "from": a, "to": b, "wd": wd, "memberOf": mo})
    return spans
rome = Point(12.4964, 41.9028)
exact = core(rome, 0)
buf = core(rome, 0.05)
print("\nexact point:", [(s['from'], s['to'], s['name']) for s in exact])
print("\n~5 km tolerance adds:", [(s['from'], s['to'], s['name']) for s in buf if s['name'] not in {e['name'] for e in exact}])
json.dump(exact, open(f"{out}/core_rome.json", "w"), indent=1)

years = list(range(-500, 701, 5))
area = collections.defaultdict(lambda: [0.0] * len(years))
for f in base:
    p = f["properties"]
    for i, y in enumerate(years):
        if p["FromYear"] <= y <= p["ToYear"]:
            area[p["Name"]][i] += p["Area"]
top = sorted(area, key=lambda n: -sum(area[n]))[:14]
stream = {"years": years, "series": [{"name": n, "area": [round(v) for v in area[n]]} for n in top],
          "other": [round(sum(area[n][i] for n in area if n not in top)) for i in range(len(years))],
          "source": "Cliopatria v0.2.1 (CC BY 4.0), mapped extent km², grouping rows excluded"}
json.dump(stream, open(f"{out}/stream_-500_700.json", "w"), separators=(",", ":"))
print("\nstream top:", top)
tot = [sum(s["area"][i] for s in stream["series"]) + stream["other"][i] for i in range(len(years))]
print("max total mapped area (M km²):", round(max(tot)/1e6, 1), "at", years[tot.index(max(tot))])
