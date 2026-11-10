"""Direction studies: 117 CE polities (simplified 0.04 deg, clockwise rings for d3), lifespans, and polities mapped per 50 years.

    uv run --no-project --python 3.11 --with 'shapely==2.1.*' python -I extract_world_117.py <cliopatria.geojson> <work>/extract
"""
import json, sys, collections
from shapely.geometry import shape, mapping, Polygon, MultiPolygon
from shapely.geometry.polygon import orient
from shapely.ops import polylabel
from shapely import set_precision
src, out = sys.argv[1], sys.argv[2]
fs = json.load(open(src))["features"]
base = [f for f in fs if f["properties"]["Type"] == "POLITY" and not f["properties"]["Name"].startswith("(")]
life = {}
for f in base:
    p = f["properties"]; n = p["Name"]
    a, b = life.get(n, (10**9, -10**9)); life[n] = (min(a, p["FromYear"]), max(b, p["ToYear"]))

def cw(g):  # d3-geo wants clockwise exterior rings
    if isinstance(g, Polygon): return orient(g, sign=-1.0)
    if isinstance(g, MultiPolygon): return MultiPolygon([orient(x, sign=-1.0) for x in g.geoms])
    return g

Y = 117
feats = []
for f in base:
    p = f["properties"]
    if not (p["FromYear"] <= Y <= p["ToYear"]): continue
    g0 = shape(f["geometry"])
    g = cw(set_precision(g0.simplify(0.04, preserve_topology=True), 0.01))
    if g.is_empty: continue
    big = max(getattr(g0, "geoms", [g0]), key=lambda x: x.area)
    lp = polylabel(big, tolerance=0.1)
    lf, lt = life[p["Name"]]
    feats.append({"type": "Feature", "geometry": mapping(g), "properties": {
        "name": p["Name"], "from": p["FromYear"], "to": p["ToYear"], "area": round(p["Area"]),
        "life": [lf, lt], "wd": p["Wikidata"], "lx": round(lp.x, 2), "ly": round(lp.y, 2)}})
feats.sort(key=lambda f: -f["properties"]["area"])
json.dump({"type": "FeatureCollection", "features": feats}, open(f"{out}/world_117.geojson", "w"), separators=(",", ":"))

# polities mapped per 50-year bin (distinct base names alive at any point in the bin)
bins = list(range(-3400, 2025, 50))
cnt = []
for b0 in bins:
    b1 = b0 + 49
    cnt.append(len({f["properties"]["Name"] for f in base if f["properties"]["FromYear"] <= b1 and f["properties"]["ToYear"] >= b0}))
json.dump({"bins": bins, "count": cnt, "width": 50}, open(f"{out}/density.json", "w"), separators=(",", ":"))
print("features", len(feats), "| density max", max(cnt), "at", bins[cnt.index(max(cnt))], "| at -3400:", cnt[0], "| 100-149:", cnt[bins.index(100)])
