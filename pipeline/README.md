# chronos-pipeline

The source-aware historical data pipeline. It turns pinned inputs into a licence-gated, traceable bundle and runs every QA rule found in [validation 0001](../docs/validation/0001-cliopatria-117ce.md).

```
data/manifest.lock.json ──► fetch (sha256-verified) ──► normalize ──► QA-001 … QA-014 ──► build ──► data/build/<release>/
pipeline/registry/*.yaml ─┘     licence gate (QA-012) runs before any input is read ─┘
```

## Commands (from the repo root)

| Command | What it does |
|---|---|
| `make fetch` | Download the pinned inputs into `data/raw/` and verify every sha256 (network) |
| `make verify` | Re-check every pinned file against the manifest |
| `make data` | Run all QA rules, triangulate, compute overlap regions and colours, render relief tiles, compress, and write the public bundle to `data/build/current` (about 2 min 45 s on the M2, about 1.2 GB peak memory) |
| `make test` / `make test-fast` | All tests / tests that need no data |
| `make reproducible` | Build twice and require byte-identical outputs: every file, including the brotli/gzip copies and relief tiles |
| `PYTHONPATH=pipeline/src uv run --no-sync python -m chronos_pipeline core-sample --lon 12.4964 --lat 41.9028` | Every polity that held a point |
| `... snapshot-wikidata --date YYYY-MM-DD --lock` | Take a new Wikidata snapshot and pin it (network; never run during a build) |

## Registry (`pipeline/registry/`)

| File | Purpose |
|---|---|
| `licenses.yaml` | Licence terms, including `commercial_use` |
| `sources.yaml` | Every source, with its licence and `access_tier`. The tier defaults to `research_only`. The loader rejects a non-commercial source marked public unless `permissions.yaml` records an active permission (D-010). |
| `permissions.yaml` | Written permissions from rights holders (empty) |
| `crosswalk_overrides.csv` | Editorial Wikidata corrections, verified against Wikidata. Source data is never edited. |
| `build.yaml` | Every build parameter; copied into `trace.json` |
| `review_notes.csv` | CHRONOS editorial "under review" notes on rows or polities, each citing where the concern was documented. Shown on the polity card; Cliopatria's data is never edited. |

## QA rules

| Rule | Checks | Validation 0001 case it reproduces |
|---|---|---|
| QA-001 | Year convention applied (negative n is n BCE; 0 is the 1 BCE end bound); rows of one polity don't overlap | Roman Empire (−14, 0) then (1, 5) |
| QA-002 | Aggregate "(…)" and RELATION rows kept apart from territories | 1,733 aggregate rows |
| QA-003 | Recomputed EPSG:6933 area within 1% of the source | Exact match |
| QA-004 | Overlaps per checkpoint year, classed linked / sliver / unlinked | 117 CE: 5 slivers, 207 km² |
| QA-005 | Combined, unique and unique-land area per checkpoint year | 117 CE: 20,806,040 / 20,805,833 / 20,593,830 km² |
| QA-006 | Identity split at gaps > 50 years unless aggregate rows cover the gap | Later Zhou, Kingdom of Italy, Kingdom of Serbia and Georgia split; Holy Roman Empire kept |
| QA-007 | One QID asserted for several polities | Q175881 |
| QA-008 | QID name mismatch (whole words), not a polity item, no temporal overlap; verified overrides applied | Han Dynasty → "Chauhan" and four others |
| QA-009 | Polygon part far from the main body and absent from neighbouring rows | Kingdom of Soissons 476–479 (Dalmatian part) |
| QA-010 | Point histories record exact versus near (≤ 5 km) hits, gaps and overlaps | Rome: 22 strata, gaps 476–499 and 1944 |
| QA-011 | Share of ice-free land with a mapped polity, sampled through time | 117 CE: 15.7% |
| QA-012 | Licence gate: no research-only or unregistered source in a public build | Seshat Equinox blocked |
| QA-013 | Every render part's triangles reproduce its area (Web Mercator, float32); parts invalid in that plane are repaired; > 1 km² mis-drawn stops the build. Also run on overlap regions. | 30 repaired, 822 GEOS fallbacks, worst 9 m² (spike 002, 1.3) |
| QA-014 | Neighbour-separating colours: neighbouring polities that share a colour (D-027) | 13 of 6,751 pairs |
| QA-004 (1.3) | All-years overlap regions reproduce the per-year QA-004 totals at every checkpoint year (an error otherwise) | 420 CE: 489,037 km² both ways |

## Outputs (`data/build/<release_id>/`)

**Loaded by the app:**
- `bundle.json` (format 3): the catalogue, palette, sources, coverage samples, and the file manifest.
- `geometry.<hash>.bin`: territory and overlap meshes, with varint triangles, edge flags and label points (D-025, D-026, D-028).
- `catalog.<hash>.json`: QA findings and review notes.
- `basemap-{land,coastline,lakes,rivers}.<hash>.json`.
- `relief-<hash>/{z}/{x}/{y}.webp`.

The JSON and binary files the app loads also get deterministic `.br` and `.gz` copies (D-024, D-031).

**Also written:**
- `testpoints.json`: ground truth for pick accuracy.
- `qa_report.json` / `qa_report.md`.
- `attributions.json`.
- `trace.json`: inputs with sha256, licences, access tiers, parameters, methods, and the sha256 of every output.
