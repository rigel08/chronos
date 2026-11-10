# Phase 0 research scripts

These scripts produced every figure in [`docs/validation/0001-cliopatria-117ce.md`](../../docs/validation/0001-cliopatria-117ce.md) and in the direction studies. They are research code: deliberately simple, and replaced by the `pipeline/` package in Milestone 1.

| File | What it does |
|---|---|
| `validate_cliopatria.py` | Areas in 117 CE (combined, unique, land), overlaps, coverage, unique area for 500 BCE–700 CE, temporal gaps, gaps at Rome, QID inventory |
| `wikidata_crosswalk.py` | Checks each Cliopatria QID against Wikidata (label, type, dates) and writes QA flags |
| `crosswalk_overrides.csv` | Editorial corrections verified against Wikidata. Cliopatria data is never edited. |
| `direction-studies/` | Source of the three visual studies (template + build script). The built page embeds derived data and is not committed. |

## Inputs (downloaded outside the repo, never committed)

| Input | Where | Pin |
|---|---|---|
| Cliopatria v0.2.1 | `https://raw.githubusercontent.com/Seshat-Global-History-Databank/cliopatria/v0.2.1/cliopatria.geojson.zip` | sha256 `e10a4e429fca708788ff9e7572a95fce801fae55852d217cffabc1c59cd4eed4` |
| world-atlas 2.0.2 (Natural Earth) | `npm pack world-atlas@2.0.2` | npm integrity of the package |

## Reproduce

```bash
uv run --no-project --python 3.11 --with 'shapely==2.1.*' --with 'pyproj==3.7.*' \
  python -I research/phase0/validate_cliopatria.py \
  --cliopatria <dir>/cliopatria_polities_only_v021.geojson \
  --land10m <dir>/package/land-10m.json --out <out>
```

```bash
python3 -I research/phase0/wikidata_crosswalk.py --cliopatria <dir>/cliopatria_polities_only_v021.geojson --out <out>
```

The Wikidata script queries the live Wikidata Query Service, so its results can drift as Wikidata is edited. The run used in validation 0001 was on 2026-11-11.
