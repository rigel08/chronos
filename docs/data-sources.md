# CHRONOS: Historical Data Sources

> **Access policy (D-010):** every source carries an `access_tier`. Non-commercial and unknown-licence sources are **research only**. They never appear in the public application, production exports or commercially distributed features unless explicit permission (`source_permission`) or a suitable licence is obtained.
>
> Researched 2026-11-11. **✓ verified** means the license was read at the primary source (the repo LICENSE file or the official dataset page) during this research. **⚠ to verify** means it was not confirmed and must be checked before ingest. Nothing enters a build without a `license` row (see [data-model.md](data-model.md)).

## Tier 1: Phase 1 spine (all commercially reusable)

| Source | What it gives us | Coverage | Precision | License | Commercial | Role |
|---|---|---|---|---|---|---|
| **Cliopatria** (Seshat Global History Databank). GitHub `Seshat-Global-History-Databank/cliopatria`; Zenodo 13363121; paper: *Scientific Data* (2025), doi:10.1038/s41597-025-04516-9 | Polity polygons. About 14K rows, more than 1,600 entities, with Wikidata and Seshat ids | 3400 BCE–2024 CE, worldwide | Atlas scale. Year ranges per row. Inclusion threshold of ≥5,000 km² and ≥50 years, with exceptions such as the Vatican and Singapore | **CC BY 4.0 ✓** (repo LICENSE.md) | Yes, with attribution | **Political spine** |
| **Natural Earth** | Land, coastlines, rivers, lakes, shaded relief, modern admin areas | Global | 1:10m / 1:50m / 1:110m | Public domain | Yes | Basemap |
| **Wikidata** | Stable ids, multilingual names, dates *with a precision field*, capitals, rulers, battles | Global; quality varies | Varies | CC0 | Yes | Crosswalk and enrichment. A tertiary source, so claims get verified before they are marked `documented` |
| **PeriodO** | Published period definitions, each with its spatial and temporal extent | Global | Per defining source | CC0 ⚠ to verify | Expected yes | Timeline era bands; competing periodizations shown side by side |

**Why Cliopatria is the spine:** it is the only dataset found that is all of the following at once: global, continuous from the earliest states to today, polygon-based, academically documented, actively maintained (pushed Oct 2026), crosswalked to Wikidata, *and* CC BY. The maintainers say plainly that it represents *one version* of past territories. The schema's `dispute` / `is_preferred` design exists so that other versions can sit beside it later.

## Tier 2: Phases 2–3 layers

| Source | What | Coverage | License | Commercial | Notes |
|---|---|---|---|---|---|
| **Pleiades** | Gazetteer of ancient places | Greco-Roman core, expanding | CC BY 3.0 ✓ | Yes | Cities and sites for antiquity; `place.pleiades_id` |
| **Itiner-e** (*Scientific Data* 2025, doi:10.1038/s41597-025-06140-z; Zenodo 17122148) | Roman road network, 299,171 km | Roman Empire | CC BY 4.0 ✓ | Yes | Only **2.7%** of roads have precisely known locations, an ideal showcase for drawing uncertainty |
| **Maddison Project Database 2023** (Bolt & van Zanden) | GDP per capita and population | 169 countries; sparse from 1 CE, dense after 1820 | CC BY 4.0 ✓ | Yes | Economic layer. Ranges only; no GDP totals invented |
| **OpenHistoricalMap** | Time-tagged features, detailed in places | Uneven | CC0 default since 3 Aug 2022 ✓; *per-feature `license=*` tags override it* | Mostly | High-detail regional borders, cities, roads. The per-feature license must be honoured |
| **World Historical Gazetteer** | An aggregator of historical place datasets | Global | Per dataset. Public datasets are CC BY 4.0; the platform default reads as NC ⚠ | Per dataset | Ingest dataset by dataset, never in bulk; NC datasets are research only |
| **Glottolog** | Languages and families | Global | CC BY 4.0 ✓ (per its maintainers' publications) | Yes | **Point locations only**, not areas. We must not draw language "territories" from it |
| **HYDE 3.3 / 3.4** (Utrecht / PBL) | Gridded population and land use | 10,000 BCE–2023 CE | ⚠ to verify (3.4 supersedes 3.3) | ⚠ | `modeled` evidence; a demographic heatmap, always labelled as a model |
| **Historical Urban Population 3700 BC–AD 2000** (Reba, Reitsma & Seto 2016; SEDAC doi:10.7927/H4ZG6QBX) | City population series, 1,599 geolocated cities, digitized from Chandler and Modelski | Global, gappy | ⚠ to verify | ⚠ | City growth layer; carries a reliability rank per record |
| **Smithsonian GVP: Volcanoes of the World v5.3.x** | Holocene volcanoes and eruptions | Global | Smithsonian Terms of Use: non-commercial without permission ⚠ | **No** (without permission) | **Research only** (D-010). The public app uses NOAA NCEI instead, once its licence is verified, unless the Smithsonian grants permission |
| **NOAA NCEI hazard databases** | Significant earthquakes, tsunamis, eruptions | Global | US government, likely public domain ⚠ to verify | Expected yes | Commercial-safe alternative to GVP for major eruptions |

## Tier 3: Use with care (license or quality constraints)

| Source | Why it's attractive | Constraint | Plan |
|---|---|---|---|
| **aourednik/historical-basemaps** | About 50 world snapshots, including deep prehistory; widely used | **GPL-3.0 ✓**: copyleft applied to data is legally murky. The author also warns about accuracy | QA cross-check only; not shipped |
| **CShapes 2.0** (ETH Zürich) | High-precision state borders, 1886–2019 | **Non-commercial.** Records disagree on the version and on share-alike (CC BY-NC 4.0 vs BY-NC-SA 4.0) ⚠ | **Research only** (D-010) unless ETH grants a licence |
| **Seshat Equinox-2020** | Coded variables: social complexity, military technology, religion | **CC BY-NC-SA ✓** (official download page). Its GitHub mirror's LICENSE conflicts | **Research only** (D-010). It is the best candidate for honest "military capability" comparisons if permission is obtained |
| **DARMC**, **ORBIS** (Roman network model) | Roman/medieval infrastructure; travel-cost model | ⚠ to verify | Phase 3 research |
| **GeaCron**, **Euratlas** | Annual / centennial commercial border atlases | Commercial license | Candidates if we need higher-fidelity borders for commercial use |
| **Chronas** (open-source project) | Prior art: a Wikipedia-driven historical globe | ⚠ to verify | Study the UX and data approach; don't copy the data |

## Known coverage gaps (and what we do about them)

Atlas-derived datasets reflect where historians have drawn maps. That means coverage is dense for Eurasia and the Mediterranean and thin for sub-Saharan Africa, the pre-Columbian Americas, Oceania, steppe confederations, and **non-state societies**. Cliopatria's ≥5,000 km² rule also filters out most small polities.

1. **"Unmapped" is not "empty".** Land with no polity in the data renders with a subtle texture, plus an explicit "no polity mapped in this dataset" tooltip. It never renders as blank wilderness. Blank space on historical maps carries a *terra nullius* implication, and we won't repeat it.
2. **The map of what we don't know.** An *evidence density* layer shows records per region per century. That turns the archive's bias into something users can see and learn from.
3. **Targeted sourcing.** Phase 4 sets a goal to add region-specialist datasets for Africa, the Americas and Oceania, working with specialists and Indigenous knowledge holders where appropriate.

## Ingestion architecture (source-aware)

```python
class SourceAdapter(Protocol):
    source_id: str                     # matches source.id
    year_convention: Literal["astronomical", "historical_no_zero"]

    def fetch(self, version: str) -> RawArtifact: ...        # pinned URL, sha256 recorded in manifest
    def normalize(self, raw: RawArtifact) -> Staged: ...     # canonical columns, EPSG:4326, astronomical years
    def validate(self, staged: Staged) -> QAReport: ...      # hard failures block load; warnings go to the report
```

- `data/manifest.lock.json` pins `{source, version, url, sha256, license}` for every input. Builds are reproducible from it.
- Raw downloads are treated as untrusted data. They are unpacked into their own directories and parsed with `pyogrio`/GeoPandas, never executed.
- The **licence gate** (D-007, D-010) produces `public` and `research` build profiles. QA-012 fails a public build that contains a research-only source. The gate also generates `attributions.json` plus the in-app credits page from the `license`/`source` tables.

## Sources consulted

- Cliopatria: [repo](https://github.com/Seshat-Global-History-Databank/cliopatria) · [paper (PMC)](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC11822181/) · [Zenodo](https://zenodo.org/records/13363121) · [Seshat docs](https://seshat-global-history-databank.github.io/seshat/researcher/cliopatria.html)
- [aourednik/historical-basemaps](https://github.com/aourednik/historical-basemaps)
- CShapes 2.0: [ETH record](https://www.research-collection.ethz.ch/handle/20.500.11850/487987?show=full) · [BTAA catalog](https://geo.btaa.org/catalog/b23a624e-f1ab-4989-8c94-f99f6e6fa414)
- OpenHistoricalMap: [license key wiki](https://wiki.osm.org/wiki/OpenHistoricalMap/Tags/Key/license) · [copyright](https://www.openhistoricalmap.org/copyright?locale=ja)
- HYDE: [Utrecht catalog](https://catalog.data.uu.nl/dataset/oai-10-24416-uu01-67uhb4) · [HYDE 3.2 paper (ESSD)](https://essd.copernicus.org/articles/9/927/2017/essd-9-927-2017.pdf)
- [Maddison Project Database 2023](https://www.rug.nl/ggdc/historicaldevelopment/maddison/releases/maddison-project-database-2023)
- Pleiades: [Pleiades Datasets on Zenodo](https://zenodo.org/records/8206033/latest) · [NYU archive](https://archive.nyu.edu/handle/2451/34305)
- Itiner-e: [About](https://www.itiner-e.org/about) · [Zenodo static release](https://zenodo.org/records/17122148)
- World Historical Gazetteer: [licensing](https://whgazetteer.org/licensing) · [public data](https://whgazetteer.org/public_data)
- Smithsonian GVP: [terms of use](https://volcano.si.edu/gvp_termsofuse.cfm) · [citation](https://volcano.si.edu/gvp_cite.cfm)
- Reba et al. 2016: [paper (PMC)](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC4896125/) · [NASA catalog](https://data.nasa.gov/dataset/historical-urban-population-3700-bc-ad-2000)
- Seshat Equinox: [Seshat downloads](https://seshat-db.com/downloads_page) · [DataHub mirror](https://datahub.io/@rufuspollock/seshat)
- Glottolog: [Forkel & Hammarström, Semantic Web](https://sage.cnpereading.com/doi/10.3233/SW-212843)
- Rendering stack: [MapLibre globe roadmap](https://maplibre.org/roadmap/maplibre-gl-js/globe-view) · [MapLibre v5.0.0 release](https://newreleases.io/project/github/maplibre/maplibre-gl-js/release/v5.0.0) · [deck.gl × MapLibre](https://deck.gl/docs/api-reference/maplibre/overview) · [deck.gl what's new](https://deck.gl/docs/whats-new)
