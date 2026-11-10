# CHRONOS: Data Model

> Status: **draft v0.1**. The DDL lives in [`db/schema.sql`](../db/schema.sql). It was checked on 2026-11-11 by loading it into a scratch PostgreSQL 15 database with PostGIS types stubbed: 30 tables after the Phase 1 additions, constraints and helper functions behave as intended. A full PostGIS run happens once PostGIS is installed (see roadmap, open decisions).

## The idea in one sentence

CHRONOS stores **claims, not facts**. A border, a date, a ruler or a population figure is a row that says *who asserts it, in which release, how it was produced, and how confident we are*. Several such rows can disagree.

## The five ideas everything else follows

### 1. Provenance on every fact row

Every fact table carries the same block:

| Column | Meaning |
|---|---|
| `source_id` → `source` → `license` | Who says so, and under what terms we may show it |
| `release_id` → `source_release` | Which pinned version (with sha256) we ingested |
| `locator` | Where inside the source: page, row id, feature id |
| `evidence` | `measured` · `documented` · `estimated` · `modeled` · `derived` · `interpreted` |
| `confidence` | `high` · `medium` · `low` · `speculative` |
| `dispute_id`, `is_preferred` | Competing interpretations of one question; one is the editorial default |

`evidence` is what lets the UI keep its promise to *"clearly distinguish measured data, historical estimates and qualitative interpretations"*. Examples:

- An atlas-drawn border is `interpreted`.
- A polygon's area computed by us is `derived`, and the UI labels it with its measure name, for example "polygon area" (see "Derived measures").
- A HYDE population grid is `modeled`.
- A census figure is `measured`.

### 2. Fuzzy time, stored as intervals

Each start and end is a `[min, max]` pair of **astronomical decimal years**, plus a precision (`day` … `millennium`) and a qualifier (`circa`, `before`, `after`, `traditional`, `floruit`…). A generated `span` column (`yearrange`, a custom float8 range type) holds the *possible* lifespan, `[start_min, end_max]`, and is GiST-indexed. That makes "alive in year *t*" a single indexed `span @> t`.

| Written | start_min | start_max | Precision / qualifier |
|---|---|---|---|
| 27 BCE | −26 | −26 | year / exact |
| c. 322 BCE | −330 | −315 | year / circa |
| 753 BCE (traditional founding of Rome) | −752 | −752 | year / **traditional**: rendered hatched and labelled "traditional date" |
| 29 May 1453 | 1453.41 | 1453.41 | day / exact |

### 3. Polities, phases and lineages

Sources often split one tradition into phases. For example, Seshat separates the Roman Principate from the Dominate. CHRONOS keeps each phase as its own `polity` and groups them with a `lineage`. The lineage drives:

- the **profile page**, which shows the whole trajectory;
- the **colour family** on the globe: successive phases share a pigment, so continuity is visible at a glance;
- **successor/predecessor** edges through `polity_relation`, which also covers vassalage, unions and splits.

### 4. Territory is time-sliced and typed

A `territory` row is one source's view of the land a polity held over an interval. Two extra fields keep the map honest:

- **`boundary_kind`**: `delimited` (treaty/surveyed line), `zonal` (frontier zone), `claimed`, `nominal`. Pre-modern frontiers render **feathered**; modern treaty borders render as crisp lines.
- **`control_kind`**: `direct`, `tributary`, `client`, `contested`, `claimed`. Tributaries and client states render with a lighter tint and hatching, not as solid ownership.

### 5. Quantities are always ranges

`estimate` holds `value_low` / `value_best` / `value_high`, a reference date range, a method and provenance. A check constraint requires at least one value and keeps the values ordered. The **"never create fake numerical rankings"** rule is enforced structurally: analytics may only rank variables that have estimates, and they rank *ranges*. Overlapping ranges are shown as ties, not as a fake ordering.

## Table map

| Group | Tables | Phase |
|---|---|---|
| Provenance | `license`, `source`, `source_release`, `dispute` | P1 (dispute P2) |
| Political spine | `lineage`, `polity_kind`, `polity`, `polity_name`, `territory`, `polity_relation`, `period` | P1 |
| People & places | `place`, `polity_capital`, `person`, `dynasty`, `office_tenure` | P2 |
| Events | `event_kind` (mapped to the nine layer groups), `event`, `event_participant` | P2 |
| Movement | `route` (`MultiLineStringM`: the M value is the year at each vertex, so voyages and campaigns animate at their attested pace) | P3 |
| Quantities | `region`, `variable`, `estimate` | P3 |
| Editorial | `narrative` (the 7 questions × 3 reading levels), `narrative_citation`, `journey`, `journey_step` | P2–P3 |

## Rules that guard against hallucination

1. **No source, no row.** `source_id` is `NOT NULL` on every fact table.
2. **Machine-drafted text is quarantined.** `narrative.generated_by` marks drafted text. A check constraint makes `status = 'published'` impossible without `reviewed_by`. Narrative sentences cite stored rows through `narrative_citation.claim`.
3. **No free-floating numbers.** Any number shown in the UI resolves to an `estimate` row, or to a `derived` computation over stored geometry.
4. **Wikidata is a crosswalk, not an authority.** We use it for ids, multilingual names and leads, and verify its claims against a cited source before they become `documented`.

## Mapping Cliopatria (Phase 1 ingest)

The facts below were observed in **v0.2.1** (sha256 `e10a4e42…cd4eed4`, retrieved 2026-11-11). The release has 13,797 rows covering 1,637 distinct names: 13,412 `POLITY` rows and 385 `RELATION` rows. Each row has `Name`, `geometry` (Polygon/MultiPolygon, EPSG:4326), `Area` (km², EPSG:6933), `Type`, `FromYear`/`ToYear`, `Wikipedia`, `Wikidata`, `SeshatID`, `Components` and `MemberOf`.

| Cliopatria | CHRONOS |
|---|---|
| distinct `Name`, plain names | `polity` (slugged id; lifespan = min FromYear … max ToYear) |
| each plain-name row | `territory` (`evidence = interpreted`, `locator` = row index, `release_id` = v0.2.1) |
| names in parentheses, e.g. "(Allegiance of Seleucid Empire to Roman Republic)", "(Warring States China)" | **Aggregates**, not territories: 1,733 rows, both alliances/allegiances (`RELATION`) and collective groupings. They map to `polity_relation` (`member_of`, `vassal_of`, `tributary_of`) using `Components`/`MemberOf`. They are excluded from area sums, because they would double-count their members. |
| `Area` | cross-checked against our own EPSG:6933 area (validation flags differences > 1%) |
| `Wikidata` | `polity.wikidata_qid`, as a lead only (see the QA findings below) |
| `SeshatID` | `polity.seshat_id`. Relations carry a `;`-separated list. |

### Findings from the v0.2.1 data (they shape the pipeline)

1. **Year convention needs explicit mapping.** Consecutive rows abut with a gap of exactly 1 in 11,403 cases. Six rows end at `ToYear = 0` and the next row starts at `1`; for example, the Roman Empire runs `(-14, 0)` and then `(1, 5)`. `FromYear = 0` never occurs. Negative years read as BCE: the Roman Empire begins at `-31`, the year of Actium, 31 BCE. The adapter therefore maps negative `y` to astronomical `y + 1`, keeps `0` as the 1 BCE end bound, and leaves positive years unchanged. Unit tests pin this.
2. **Coarse polygons cause point near-misses.** At Rome's coordinates, the Roman Kingdom polygon misses by under 5 km. The core-sample query uses a small tolerance and flags such hits as "near" instead of "exact".
3. **Gaps are real.** At Rome, no row covers 476–499 (Odoacer's kingdom isn't mapped there) or 1944. The UI shows gaps as *unmapped*, never as continuity.
4. **Overlaps are real.** At Rome, the Byzantine Empire (633–767) and the Papal States (755–1798) overlap from 755 to 767. Overlap is shown side by side.
5. **The Wikidata column is a topical link, not identity** (validation 0001 §3). *Correction:* `Q175881` is Wikidata's 1798–1799 Roman Republic. The **ancient** Roman Republic rows are mislinked; the revolutionary row is right. Other examples: Roman Empire → Q12544 (Byzantine Empire), Han Dynasty → Q1068371 ("Chauhan"). 299 of 1,545 name–QID pairs fail automatic checks, and that count is a lower bound. Handling: D-011, the `external_id` table and [`crosswalk_overrides.csv`](../research/phase0/crosswalk_overrides.csv).
6. **Shared names are not shared identity.** "Later Zhou" spans 750–257 BCE *and* 960 CE. "Kingdom of Italy" covers 587–774, 887–969 and 1862–1946. Both carry a single QID throughout. Rows are split into separate polities at unexplained gaps (QA-006).
7. **Subordination and disputes are not encoded for 117 CE.** No grouping or allegiance rows are active and there are no `MemberOf` links. Overlaps total 207 km² (edge slivers). Client states appear as separate, unlinked polygons.
8. **Stray geometry exists.** The Kingdom of Soissons row for 476–479 has a part reaching the Adriatic (QA-009).
9. **Coverage is partial.** In 117 CE, polities are mapped over 15.7% of ice-free land.

## Derived measures (D-012)

Every area shown names one of these. None of them is called "controlled".

| Measure | Definition | Notes |
|---|---|---|
| **Combined polygon area** | Σ area of each polity's own polygon in the year | Overlaps are counted once per claimant. This is what a stacked chart shows. |
| **Unique mapped area** | Area of the union of all polygons alive in the year | Each km² counted once |
| **Unique mapped land area** | Union ∩ Natural Earth 10m land, north of 60° S | Removes coastline mismatch and water |
| **Coverage share** | Unique mapped land ÷ ice-free land | Printed next to every aggregate |
| **Overlap area** (per pair) | Area(A ∩ B) | Classed as *linked* (a sourced relation exists), *sliver* (< 1,000 km² or < 1% of the smaller polity) or *unlinked* |

All areas use EPSG:6933. Each value is stored with `evidence = 'derived'` and a trace entry (D-013).

## Licence tiers and identity (Phase 1 additions to the schema)

- **`source.access_tier`** (`public` | `research_only`, default `research_only`) plus **`source_permission`** implement D-010.
- **`external_id`** separates identifiers a source *asserts* from those CHRONOS has *verified*, *rejected* or *corrected* (D-011).
- **`qa_flag`** stores every QA finding as data, with a UI message, so missing data and uncertainty are shown and never silently fixed.
