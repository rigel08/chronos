# CHRONOS

An interactive atlas of human history: a globe you travel through in time. Real, sourced polity territories rise and fall from 3400 BCE to today. Click anywhere on Earth to see every power that held that ground.

> **Status: milestone 1.1, technical proof.** A source-aware data pipeline with automated QA and licence enforcement, plus a MapLibre + deck.gl rendering benchmark. There is no application UI yet (by design).

## Quick start

```bash
make setup      # locked Python (uv) and web (pnpm) dependencies
make fetch      # pinned inputs into data/raw, sha256-verified (about 47 MB download)
make data       # all QA rules + the licence-gated public bundle (data/build/current)
make test       # pipeline + web tests, including the real-data reproduction of validation 0001
make bench      # engine benchmark in local Google Chrome; results in docs/spikes/results/
```

The Wikidata snapshot is created once with `snapshot-wikidata` and pinned (see [pipeline/README.md](pipeline/README.md)).

## Documents


| Document | What it covers |
|---|---|
| [docs/architecture.md](docs/architecture.md) | System design, rendering engine choice, time model, pipeline, testing |
| [docs/data-model.md](docs/data-model.md) | Claim-based data model, fuzzy dates, Cliopatria mapping and findings |
| [db/schema.sql](db/schema.sql) | Draft PostgreSQL/PostGIS schema (30 tables) |
| [docs/data-sources.md](docs/data-sources.md) | Evaluated historical datasets, licenses, coverage gaps, ingestion design |
| [docs/design-direction.md](docs/design-direction.md) | Three visual directions, the recommendation (Strata), design tokens |
| [docs/roadmap.md](docs/roadmap.md) | Phases 1–5, the vertical slice, risks, decisions |
| [docs/decisions.md](docs/decisions.md) | Architecture decision log |
| [docs/validation/0001-cliopatria-117ce.md](docs/validation/0001-cliopatria-117ce.md) | Technical validation of the 117 CE data: areas, overlaps, coverage, cross-references, gaps |
| [research/phase0/](research/phase0/README.md) | The scripts that produced every Phase 0 figure, plus verified cross-reference corrections |
| [infra/postgis/](infra/postgis/README.md) | Prepared (not installed) digest-pinned PostGIS container |
| [pipeline/](pipeline/README.md) | The data pipeline: registry, QA rules QA-001 to QA-012, outputs |
| [docs/spikes/001-engine.md](docs/spikes/001-engine.md) | Engine benchmark: method, results on the M2, go/no-go |

## Planned stack

React 19 · TypeScript · Vite · Tailwind CSS v4 · MapLibre GL JS + deck.gl (globe and time layers) · FastAPI · PostgreSQL + PostGIS · Python (GeoPandas, Shapely) · PMTiles.

## Data

The political spine is **Cliopatria** (Seshat Global History Databank, CC BY 4.0). Every source CHRONOS uses is listed with its license in [docs/data-sources.md](docs/data-sources.md), and attribution will be generated automatically into the app's credits page.
