# Validation 0001: Cliopatria v0.2.1 behind the 117 CE studies

> Run 2026-11-11 on branch `phase-0/validation`. Every number here comes from the scripts in [`research/phase0/`](../../research/phase0/README.md) and can be reproduced from the pinned inputs.

**Inputs**
- Cliopatria v0.2.1 (Seshat Global History Databank, CC BY 4.0). Zip sha256 `e10a4e429fca708788ff9e7572a95fce801fae55852d217cffabc1c59cd4eed4`. It contains 13,797 rows: 12,064 base polity rows and 1,733 aggregate "(…)" rows, of which 1,348 are typed POLITY and 385 RELATION.
- Natural Earth 1:10m land, via world-atlas 2.0.2.
- Wikidata, through the Query Service, on 2026-11-11.

**Method:** areas use EPSG:6933 (equal area), the same projection Cliopatria uses for its `Area` field. Our recomputed areas match the field exactly (maximum relative difference < 10⁻⁵).

## Verdict by requirement

| Requirement | Finding | Consequence for CHRONOS |
|---|---|---|
| Overlapping polygons in 117 CE | **Effectively none.** Five edge slivers totalling **207 km²** across 36 polities. | Combined and unique area agree to 0.001% in this year. We still report both everywhere, because they diverge in other years (up to 2.1% in 500 BCE–700 CE). |
| Subordinate polities | **Not encoded for 117 CE.** No allegiance or alliance rows are active and no `MemberOf` links exist. Client states appear as separate, unlinked polygons; the Cimmerian Bosporus is one example. | Cliopatria can't tell us who was subordinate to whom in 117. Subordination has to come from separately sourced `polity_relation` rows; until then the UI says "relationship not recorded". |
| Disputed territories | **Not encoded.** Cliopatria assigns one owner per place-year. | Disputes must be modelled as `dispute` records with competing sourced rows. The UI must never present a Cliopatria border as uncontested fact. |
| Combined vs unique area | 117 CE: combined polygon area **20,806,040 km²**; unique mapped area **20,805,833 km²**; unique mapped *land* **20,593,830 km²**. **212,003 km²** of mapped area falls outside the Natural Earth coastline. | Three named measures (see "Derived measures" in data-model.md). The word "controlled" is not used: the data records a mapped interpretation, not verified control. |
| Completeness | Polities are mapped over **15.7%** of Earth's ice-free land (131.5 M km²) in 117 CE. | Coverage is stated next to every aggregate. Unmapped land is textured and labelled, never blank. |
| Cross-references | **The Wikidata column is a topical link, not an identity key.** 299 of 1,545 name–QID pairs fail automatic checks, and that count is a lower bound: 5 of 19 famous polities are wrong. | Never use Cliopatria's QIDs as identity. Verified corrections live in an override table; unverified links are shown as "as given by source". |
| Temporal gaps | 279 of 1,544 polities have internal gaps (414 gaps). Many are **different polities sharing a name**. Rome's two gaps are real absences in the dataset. | Polity identity is split at unexplained gaps. Gaps are drawn as *unmapped*, never as continuity. |
| Traceability | Each number above links back to a script, a pinned input and a parameter. | The same pattern becomes the `trace` manifest for every built artifact (D-013). |

## 1. Area in 117 CE

| Measure | km² | Definition |
|---|---|---|
| Combined polygon area | 20,806,040 | Sum of each polity's own polygon area. Shared ground counts once per claimant. |
| Unique mapped area | 20,805,833 | Area of the union of all polygons |
| Counted twice | 207 | Combined minus unique |
| Unique mapped land | 20,593,830 | Union ∩ Natural Earth 10m land, excluding Antarctica |
| Mapped area beyond the coastline | 212,003 | Coastline mismatch between datasets, plus polygons that cover water bodies |
| Ice-free land, total | 131,512,873 | Natural Earth 10m land north of 60° S |

**The five overlaps.** All are classed as slivers (< 1,000 km², or < 1% of the smaller polity):

- Roman Empire × Parthian Empire, 105 km²
- Lazica × Roman Empire, 48 km²
- Hadhramaut × Himyarite Kingdom, 42 km²
- Early Cheras × Early Pandyas, 6 km²
- Early Cheras × Early Cholas, 6 km²

These are digitisation edges, not claims.

**The Roman 117–126 row deserves a flag.** It is the Roman Empire's largest polygon area in the dataset (5,263,199 km²). Point tests show the polygon includes Ctesiphon, Babylon and Artaxata, meaning Mesopotamia and Armenia. The neighbouring rows do not: 114–116 includes Artaxata only, and 127–153 includes none of them. Standard accounts date Hadrian's withdrawal from these eastern provinces to 117–118. The row therefore likely holds that extent for about nine years longer than history supports. **Status:** flagged for review against a cited source before CHRONOS presents 117 CE as a "peak".

## 2. Time stream, 500 BCE–700 CE

Combined ÷ unique area averages **1.002**. It peaks at **1.021 in 420 CE**, where the stacked stream overstates unique mapped area by 2.1%. The updated Strata study draws the unique area as a dashed envelope around the stack, so the difference is visible.

## 3. Wikidata cross-references

**Correction to the Phase 0 docs.** The earlier docs said the 1799 Revolutionary Roman Republic carried the ancient Republic's QID. It's the reverse. Q175881 is Wikidata's *1798–1799* Roman Republic, so the revolutionary row is right. The **ancient** "Roman Republic" rows are wrong.

Automatic checks over 1,404 QIDs (1,545 name–QID pairs):

| Flag | Pairs |
|---|---|
| name doesn't match label or aliases (whole-word rule) | 105 |
| linked item is not a polity (a war, person, era, disambiguation or "foreign relations" page…) | 204 |
| no temporal overlap with the linked item | 43 |
| lifespan differs by more than 150 years | 280 (often legitimate: Cliopatria splits phases) |
| QID shared by several names | 256 |
| any strong flag (first three rows, or missing item) | **299** |

**Spot check of 19 major polities:** 14 correct, **5 wrong**.

| Cliopatria name | QID given | That QID is | Verified correction |
|---|---|---|---|
| Roman Empire | Q12544 | Byzantine Empire (395–1453) | **Q2277** Roman Empire |
| Roman Republic | Q175881 | Roman Republic, 1798–1799 | **Q17167** Roman Republic (509–27 BC) |
| Byzantine Empire | Q112039853 | Foreign relations of the Byzantine Empire | **Q12544** Byzantine Empire |
| Han Dynasty | Q1068371 | Chauhan (a Rajput clan) | **Q7209** Han dynasty |
| Sasanian Empire | Q1661685 | Indo-Sassanids | **Q83891** Sasanian Empire |

The Sasanian case shows that even the stricter heuristics miss errors ("Sasanian" and "Indo-Sassanids" look alike). Automatic flags are a triage tool, and review is required. Verified corrections are recorded in [`pipeline/registry/crosswalk_overrides.csv`](../../pipeline/registry/crosswalk_overrides.csv) as CHRONOS editorial rows. Cliopatria's data is never edited.

## 4. Temporal gaps

**At Rome** (exact point query, 750 BCE–2024 CE):

- **476–499: no polygon covers Rome.** No polity named for Odoacer exists anywhere in the dataset. The nearest mapped polities in those years are the Ostrogoths (203 km away in 490–499), the Vandal Kingdom (242 km) and the Kingdom of Soissons (320 km; see §5).
- **1944: no polygon covers Rome.** There is no Kingdom of Italy row for 1944, and no Italian Social Republic in the dataset at all. The 1944 "Nazi Germany" polygon ends **13.3 km** from Rome's coordinates. Year-level rows can't show the city changing hands on 4 June 1944.

**Across the dataset:** 414 internal gaps in 279 of 1,544 polities. They fall into three kinds:

| Kind | Examples (same name, same QID across the gap) | Handling |
|---|---|---|
| **Name collision**: different polities share a name | "Later Zhou": rows for 750–257 BCE carry Q1154556, the 951–960 CE dynasty. "Kingdom of Italy": 587–774, 887–969 and 1862–1946, all under Q172579 (the 1861–1946 kingdom). "Kingdom of Serbia": 1188–1351 and 1880–1884, under Q241748 (the 1882–1918 kingdom). "Georgia": rows from 567 to 2024 under Q4962, a disambiguation page. | Split into separate CHRONOS polities at the gap; identity proposed for review |
| **Representation switch**: the polity continues, drawn differently | Holy Roman Empire, 1260–1618, represented by 101 "(Allegiance of … to Holy Roman Empire)" rows | Model as `polity_relation`; the lineage stays continuous |
| **Unexplained** | Elam, 2700–2201 BCE | Drawn as a gap, flagged for specialist review |

## 5. Geometry outliers

The **Kingdom of Soissons** row for 476–479 has a bounding box reaching **19.46° E, 42.24° N**, while its representative point is in northern Gaul (1.59° E, 48.85° N). The 480–489 row has normal bounds.

*Corrected in milestone 1.1:* inspecting the parts shows this is not a small stray. It is a **32,925 km² part on the Dalmatian coast** (14.5–19.5° E). That is 26% the size of the 125,260 km² Gaulish core, and it is absent from the next row.

*Hypothesis, not yet sourced:* the location matches Dalmatia, which standard accounts give to the deposed western emperor Julius Nepos until 480. The row may therefore merge two Roman rump states under one name.

QA-009 flags parts that are far from the main body *and* absent from the polity's neighbouring rows. Size alone is a poor signal, because islands and overseas possessions are also small and far.

## 6. QA rules to implement in Milestone 1 (pipeline `validate` stage)

| ID | Rule | Severity |
|---|---|---|
| QA-001 | Year convention: map negative years to BCE, `ToYear = 0` to the 1 BCE end bound; rows must abut | error |
| QA-002 | Aggregate "(…)" rows are separated from territories and never summed | error |
| QA-003 | Recomputed EPSG:6933 area within 1% of the source `Area` | warning |
| QA-004 | Pairwise overlaps per year, classed as linked / sliver / unlinked; published per year | info |
| QA-005 | Combined, unique and unique-land area computed per year; ratio published | info |
| QA-006 | Internal gap within a polity name → candidate identity split | warning |
| QA-007 | Same QID on non-contiguous rows or different names | warning |
| QA-008 | QID label mismatch (whole-word rule) / not a polity item / no temporal overlap | warning |
| QA-009 | Polygon part farther than 500 km from the main body, smaller than it, and absent from the polity's neighbouring rows (revised in M1.1; see §5) | warning |
| QA-010 | Point queries: an exact hit versus within-tolerance (≈5 km) hit, recorded on every result | info |
| QA-011 | Coverage share of ice-free land, per year | info |
| QA-012 | A research-only source must not be present in any public artifact | **error (blocks build)** |
