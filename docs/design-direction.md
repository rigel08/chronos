# CHRONOS: Design Direction

> Status: **proposal v0.1** (2026-11-11). The live direction studies are at **https://claude.ai/artifact/8hfBjCbM1XVRAuiscmvX36** (private until shared). Each study renders the *same real moment*: 36 Cliopatria v0.2.1 polities valid in 117 CE, the polygons beneath Rome from 750 BCE to 2024 CE, and the mapped-extent stream from 500 BCE to 700 CE.

## The three directions

| | A · Nocturne | B · Vellum | **C · Strata (recommended)** |
|---|---|---|---|
| Thesis | History as light: polities glow on a night-side Earth | The cartographer's table: ink, watercolour, letter-spaced lettering | **Time as depth:** the globe is the surface, every place has layers beneath it |
| Type | Geist (one family, hairline to medium) | Cormorant SC + EB Garamond | Newsreader (names, narrative) · IBM Plex Sans (UI) · IBM Plex Mono (dates, measures) |
| Signature | Additive glow; contested ground brightens | Pigment pooling at wash edges; dotted-ink frontiers | **Core sample** (who ruled this ground) + **time stream** (who held how much land, when) |
| Breaks down | Neon soup in dense eras, glow implies certainty, generic "space-tech" | Fantasy-map kitsch, wrong for the modern era, low analytic contrast, colonial-atlas nostalgia | More UI at once; needs progressive disclosure on phones |

**Strata borrows** Nocturne's *stage* (the night-side globe and atmospheric rim for the opening shot and deep-time zoom-outs) and Vellum's *lettering* (names letter-spaced along each territory's spine; a paper print skin for classroom handouts later).

## Why Strata

The interface itself answers the brief's hardest questions:

- **"Who ruled here?"** Click any point to drill a **core sample**: chronological strata of every polity whose territory covers that ground. Gaps are hatched (*unmapped*, never implied continuity), near-misses are dashed (*within ~5 km of a coarse polygon*), and overlaps split the column (*shared or contested*).
- **"Who coexisted, and who was largest?"** The **time stream** under the timeline stacks *mapped extent* (derived from real polygons) for the polities in view. It recomposes as the globe rotates. It is labelled as mapped land, never as "power".
- **"Where is the record thin?"** The overview strip is a **record-density histogram** (polities mapped per 50 years), so the archive's gaps are visible before anyone draws conclusions.

## Strata design system (v0, to be built as Tailwind v4 `@theme` tokens)

### Colour

- **Ground:** `ink-950 #0d1014` (night ink, blue-black), `ink-900 #10161e` (ocean), `ink-800 #1a222c` (unclaimed land), `graphite #262c34` (rules, "other").
- **Text:** `bone-100 #e9e2d2`, `bone-400 #b9b2a3`, `slate-400 #8d949d`, `slate-500 #6f7680`.
- **Polity pigments.** These are named after historical pigments and assigned by **lineage family**, so successive phases share a hue:

| Pigment | Hex (base) | Example use in the studies |
|---|---|---|
| cinnabar | `#cf5637` | Roman |
| lapis | `#4b70c6` | Chinese imperial dynasties |
| orpiment | `#d9a845` | Iranian empires |
| verdigris | `#4fae9f` | Steppe confederations |
| malachite | `#57a067` | South Asian polities |
| madder | `#b25c87` | Hellenistic |
| smalt | `#7a6fb0` | Germanic successor kingdoms |
| papal gold | `#d8b54a` | Papal States |

Family assignment is an *editorial* layer stored on `lineage.color_family`, not inferred from data.

- **Semantic colours** (data quality, kept separate from pigments): *exact* is solid fill; *near* is a dashed bone outline at 30% fill; *unmapped* is a 45° bone hatch at 35%; *modeled* is a fine dot screen.
- **Light theme:** a "bone" variant for print and classroom use comes later. The atlas itself is dark-first, because polity colours carry more data on dark ground.

### Type scale

| Role | Face | Sizes |
|---|---|---|
| Display year | Newsreader italic 300 | 48 / 64 / 96 |
| Entity names | Newsreader 400 | 22 / 24 / 32 |
| Narrative | Newsreader 400 | 17 / 1.6 |
| Interface | Plex Sans 400/500 | 12 / 13 / 15 |
| Dates, measures, coordinates | Plex Mono 400/500 | 10 / 11 / 12, tabular numerals |
| Labels on the map | Plex Sans 600, uppercase, letter-spaced, sized by √area | 8.5–12 |

### Motion principles

1. **Motion explains change.** It is used for time passing, territory gained or lost, and camera moves between places. It is never decoration.
2. **One choreography per transition.** The camera flies first, then time moves, then panels settle.
3. **Honest transitions.** Polities cross-dissolve and gained or lost areas pulse (see [architecture.md §6](architecture.md)). There is no morphing.
4. **`prefers-reduced-motion`:** cuts instead of flights; no sway or pulse.

## Integrity rules for every screen (from validation 0001)

1. **Say "mapped", never "ruled" or "controlled".** Use "Mapped extent in Cliopatria" and "polities mapped". The data is one atlas's interpretation.
2. **Name the area measure.** Use *combined polygon area*, *unique mapped area* or *unique mapped land*. A stacked chart shows combined area, so it also draws the unique envelope.
3. **State coverage beside every aggregate**, for example "Polities are mapped over 15.7% of ice-free land in 117 CE." Never write a sentence that implies the map is complete.
4. **Keep the holes.** Gaps are hatched and labelled *unmapped*. Near-misses are dashed. Overlaps split. Missing relationships read "not recorded in this dataset".
5. **Show source links as given.** A Wikidata link from Cliopatria is labelled "as given by source" with the linked item's own name. A mismatch is shown with its QA flag, and a verified correction appears beside it.
6. **Every number is traceable.** "How is this calculated?" opens the trace entry: dataset release and sha256, method, parameters, licence.

### Component inventory (Phase 1)

Globe stage · time scrubber (zoomable, with an overview density strip) · era bands · polity card (names, fuzzy dates, mapped extent, evidence chip, source + license chip) · core sample panel (with time lenses) · layer chips · search · tooltip · credits page.
