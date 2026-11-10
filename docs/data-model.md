# CHRONOS: Data Model

> Status: **draft v0.1**. The DDL lives in [`db/schema.sql`](../db/schema.sql). It was checked on 2026-11-11 by loading it into a scratch PostgreSQL 15 database with PostGIS types stubbed: 27 tables, constraints and helper functions behave as intended. A full PostGIS run happens once PostGIS is installed (see roadmap, open decisions).

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
- A polygon's area computed by us is `derived`, and the UI labels it "mapped extent".
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
5. **QIDs aren't unique identifiers.** The 1799 "Revolutionary Roman Republic" carries `Q175881`, the same QID as the ancient Roman Republic. QA rule: a QID shared by non-contiguous polities raises a warning.
