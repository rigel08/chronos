-- =============================================================================
-- CHRONOS core schema: DRAFT v0.1 (proposal; the first Alembic migration is
-- cut from this file once reviewed). See docs/data-model.md for rationale.
--
-- Target: PostgreSQL 15+ with PostGIS 3.4+.
--
-- Conventions
--   * Years are ASTRONOMICAL decimal years: ... -1.0 = 2 BCE, 0.0 = 1 BCE,
--     1.0 = 1 CE. Sub-year precision is a fraction (29 May 1453 ~ 1453.41).
--   * A fuzzy instant is [min, max] + precision + qualifier.
--     A fuzzy span is a fuzzy start + a fuzzy end (end NULL = ongoing).
--   * Every FACT row carries provenance: source_id, release_id, locator,
--     evidence, confidence, and optionally dispute_id + is_preferred so that
--     competing interpretations can coexist.
--   * Geometries are EPSG:4326.
--   * [P1]..[P4] = phase in which the table is first needed.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- A range type over decimal years, for GiST "alive at year t" lookups.
CREATE TYPE yearrange AS RANGE (subtype = float8, subtype_diff = float8mi);

CREATE TYPE date_precision AS ENUM
  ('day', 'month', 'year', 'decade', 'century', 'millennium', 'era');

CREATE TYPE date_qualifier AS ENUM
  ('exact', 'circa', 'before', 'after', 'between', 'traditional', 'floruit');

CREATE TYPE confidence_level AS ENUM ('high', 'medium', 'low', 'speculative');

CREATE TYPE evidence_kind AS ENUM (
  'measured',     -- instrument- or census-grade measurement
  'documented',   -- stated in primary/secondary sources
  'estimated',    -- scholarly estimate, usually a range
  'modeled',      -- output of a model (e.g. HYDE grids, interpolated borders)
  'derived',      -- computed by CHRONOS from other stored data (e.g. polygon area)
  'interpreted'   -- scholarly/editorial interpretation (e.g. atlas-drawn borders)
);

-- =============================================================================
-- Provenance
-- =============================================================================

CREATE TABLE license (                                                    -- [P1]
  id                   text PRIMARY KEY,        -- SPDX id where one exists, e.g. 'CC-BY-4.0'
  name                 text NOT NULL,
  url                  text,
  attribution_required boolean NOT NULL,
  share_alike          boolean NOT NULL,
  commercial_use       boolean NOT NULL,        -- false => excluded from the commercial build
  notes                text
);

CREATE TABLE source (                                                     -- [P1]
  id          text PRIMARY KEY,                 -- stable slug, e.g. 'cliopatria'
  kind        text NOT NULL CHECK (kind IN
                ('dataset', 'book', 'article', 'map', 'archive', 'website', 'editorial')),
  title       text NOT NULL,
  authors     text[],
  publisher   text,
  year        int,
  url         text,
  doi         text,
  license_id  text NOT NULL REFERENCES license (id),
  citation    text NOT NULL,                    -- attribution string as rendered in the UI
  -- D-010: 'research_only' sources never reach the public app, public exports or
  -- commercial features. Only an explicit permission row (below) or a suitable
  -- licence can move a source to 'public'. The pipeline enforces this (QA-012).
  access_tier text NOT NULL DEFAULT 'research_only' CHECK (access_tier IN ('public', 'research_only')),
  notes       text
);

-- Explicit permission obtained from a rights holder (for example, written consent to
-- use an NC dataset in the public app). Without a row here, NC sources stay research-only.
CREATE TABLE source_permission (                                          -- [P1]
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id     text NOT NULL REFERENCES source (id),
  granted_by    text NOT NULL,
  scope         text NOT NULL,                  -- what exactly is permitted
  document_ref  text NOT NULL,                  -- where the written permission is archived
  granted_on    date NOT NULL,
  expires_on    date
);

CREATE TABLE source_release (                                             -- [P1]
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id    text NOT NULL REFERENCES source (id),
  version      text NOT NULL,                   -- e.g. Cliopatria git tag / Zenodo version
  origin_url   text NOT NULL,
  sha256       text NOT NULL,
  retrieved_at timestamptz NOT NULL,
  UNIQUE (source_id, version)
);

-- A historical question on which sources disagree. Competing fact rows point
-- at the same dispute; exactly one is the editorial default (is_preferred).
CREATE TABLE dispute (                                                    -- [P2]
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  question  text NOT NULL,                      -- "Eastern extent of Kushan control, c. 150 CE"
  summary   text
);

-- =============================================================================
-- Political entities
-- =============================================================================

-- A lineage groups successive phases of one political tradition
-- (Roman Kingdom -> Republic -> Principate -> Dominate -> Eastern Roman Empire).
-- Used for profile pages and for colour families on the globe.
CREATE TABLE lineage (                                                    -- [P1]
  id            text PRIMARY KEY,               -- 'roman'
  name          text NOT NULL,
  color_family  text                            -- design-token name, e.g. 'cinnabar'
);

CREATE TABLE polity_kind (                                                -- [P1]
  id           text PRIMARY KEY,                -- 'empire', 'kingdom', 'city_state', 'caliphate',
  label        text NOT NULL,                   -- 'sultanate', 'khaganate', 'confederation',
  description  text                             -- 'chiefdom', 'republic', 'colony', 'mandate', ...
);

CREATE TABLE polity (                                                     -- [P1]
  id               text PRIMARY KEY,            -- stable slug: 'roman-empire-principate'
  name             text NOT NULL,               -- default English display name
  kind_id          text REFERENCES polity_kind (id),
  lineage_id       text REFERENCES lineage (id),
  wikidata_qid     text,                        -- VERIFIED identity only (D-011); source-asserted
                                                -- links live in external_id. Not unique: phases can share one.
  seshat_id        text,
  summary          text,
  -- lifespan (fuzzy span)
  start_min        float8 NOT NULL,
  start_max        float8 NOT NULL,
  end_min          float8,
  end_max          float8,
  start_precision  date_precision NOT NULL DEFAULT 'year',
  end_precision    date_precision,
  start_qualifier  date_qualifier NOT NULL DEFAULT 'exact',
  end_qualifier    date_qualifier,
  span             yearrange GENERATED ALWAYS AS
                     (yearrange(start_min, coalesce(end_max, 'infinity'::float8), '[]')) STORED,
  -- provenance
  source_id        text NOT NULL REFERENCES source (id),
  release_id       bigint REFERENCES source_release (id),
  locator          text,
  evidence         evidence_kind NOT NULL,
  confidence       confidence_level NOT NULL DEFAULT 'medium',
  CHECK (start_min <= start_max),
  CHECK (end_min IS NULL OR (end_min <= end_max AND start_min <= end_max))
);
CREATE INDEX polity_span_gix ON polity USING gist (span);
CREATE INDEX polity_name_trgm ON polity USING gin (name gin_trgm_ops);

-- Identifiers in other systems, as asserted by a source and as verified by CHRONOS.
-- Validation 0001 found Cliopatria's Wikidata column is a topical link, not an identity
-- key (e.g. "Han Dynasty" -> Q1068371 "Chauhan"), so assertions and verifications are kept apart.
CREATE TABLE external_id (                                                -- [P1]
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  polity_id    text NOT NULL REFERENCES polity (id) ON DELETE CASCADE,
  scheme       text NOT NULL CHECK (scheme IN ('wikidata', 'seshat', 'pleiades', 'geonames', 'periodo')),
  value        text NOT NULL,
  status       text NOT NULL CHECK (status IN ('asserted', 'verified', 'rejected', 'corrected')),
  asserted_by  text REFERENCES source (id),     -- who supplied the link
  verified_on  date,
  evidence     text,                            -- how it was checked
  replaces_id  bigint REFERENCES external_id (id)
);
CREATE INDEX external_id_lookup ON external_id (scheme, value);

CREATE TABLE polity_name (                                                -- [P1]
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  polity_id   text NOT NULL REFERENCES polity (id) ON DELETE CASCADE,
  name        text NOT NULL,
  lang        text,                             -- BCP 47: 'la', 'grc', 'fa', 'zh-Hant', ...
  script      text,                             -- ISO 15924: 'Latn', 'Grek', 'Arab', 'Hant'
  name_type   text NOT NULL CHECK (name_type IN
                ('endonym', 'exonym', 'official', 'short', 'historical', 'transliteration')),
  valid_from  float8,                           -- optional: when this name was in use
  valid_to    float8,
  source_id   text NOT NULL REFERENCES source (id),
  locator     text
);
CREATE INDEX polity_name_trgm_ix ON polity_name USING gin (name gin_trgm_ops);

-- The territory a polity held during an interval, according to one source.
-- Several rows may cover the same polity and time when sources disagree.
CREATE TABLE territory (                                                  -- [P1]
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  polity_id        text NOT NULL REFERENCES polity (id) ON DELETE CASCADE,
  geom             geometry (MultiPolygon, 4326) NOT NULL,
  area_km2         float8 NOT NULL,             -- equal-area (EPSG:6933), computed in pipeline
  boundary_kind    text NOT NULL DEFAULT 'zonal' CHECK (boundary_kind IN
                     ('delimited',              -- surveyed / treaty line
                      'zonal',                  -- frontier zone; drawn feathered
                      'claimed',                -- de jure claim without control
                      'nominal')),              -- suzerainty / tributary relationship
  control_kind     text NOT NULL DEFAULT 'direct' CHECK (control_kind IN
                     ('direct', 'tributary', 'client', 'contested', 'claimed')),
  -- validity interval (fuzzy span)
  start_min        float8 NOT NULL,
  start_max        float8 NOT NULL,
  end_min          float8,
  end_max          float8,
  start_precision  date_precision NOT NULL DEFAULT 'year',
  end_precision    date_precision,
  span             yearrange GENERATED ALWAYS AS
                     (yearrange(start_min, coalesce(end_max, 'infinity'::float8), '[]')) STORED,
  -- provenance
  source_id        text NOT NULL REFERENCES source (id),
  release_id       bigint REFERENCES source_release (id),
  locator          text,                        -- e.g. Cliopatria row id
  evidence         evidence_kind NOT NULL,      -- atlas borders => 'interpreted'
  confidence       confidence_level NOT NULL DEFAULT 'medium',
  dispute_id       bigint REFERENCES dispute (id),
  is_preferred     boolean NOT NULL DEFAULT true,
  CHECK (start_min <= start_max),
  CHECK (end_min IS NULL OR (end_min <= end_max AND start_min <= end_max))
);
CREATE INDEX territory_geom_span_gix ON territory USING gist (geom, span);
CREATE INDEX territory_polity_ix ON territory (polity_id, start_min);

CREATE TABLE polity_relation (                                            -- [P1]
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject_id  text NOT NULL REFERENCES polity (id) ON DELETE CASCADE,
  relation    text NOT NULL CHECK (relation IN
                ('successor_of', 'split_from', 'merged_into', 'part_of', 'member_of',
                 'vassal_of', 'tributary_of', 'personal_union_with', 'conquered_by')),
  object_id   text NOT NULL REFERENCES polity (id) ON DELETE CASCADE,
  valid_from  float8,
  valid_to    float8,
  source_id   text NOT NULL REFERENCES source (id),
  locator     text,
  evidence    evidence_kind NOT NULL,
  confidence  confidence_level NOT NULL DEFAULT 'medium',
  CHECK (subject_id <> object_id)
);

-- Named historical periods (PeriodO-backed). Regional by design: the
-- "Iron Age" in Anatolia and in Scandinavia are different rows.
CREATE TABLE period (                                                     -- [P1]
  id                text PRIMARY KEY,
  label             text NOT NULL,
  periodo_id        text,                       -- PeriodO ark/id
  spatial_coverage  text,                       -- as stated by the defining source
  geom              geometry (MultiPolygon, 4326),
  start_min float8 NOT NULL, start_max float8 NOT NULL,
  end_min   float8 NOT NULL, end_max   float8 NOT NULL,
  source_id text NOT NULL REFERENCES source (id),
  locator   text
);

-- =============================================================================
-- Places, people, events
-- =============================================================================

CREATE TABLE place (                                                      -- [P2]
  id                    text PRIMARY KEY,
  name                  text NOT NULL,
  kind                  text NOT NULL CHECK (kind IN
                          ('city', 'town', 'settlement', 'site', 'fortress', 'port',
                           'sanctuary', 'mine', 'region')),
  geom                  geometry (Point, 4326) NOT NULL,
  location_precision_m  int,                    -- how well we know WHERE it was
  pleiades_id           text,
  wikidata_qid          text,
  start_min float8, start_max float8, end_min float8, end_max float8,
  source_id   text NOT NULL REFERENCES source (id),
  locator     text,
  evidence    evidence_kind NOT NULL,
  confidence  confidence_level NOT NULL DEFAULT 'medium'
);
CREATE INDEX place_geom_gix ON place USING gist (geom);

CREATE TABLE polity_capital (                                             -- [P2]
  polity_id   text NOT NULL REFERENCES polity (id) ON DELETE CASCADE,
  place_id    text NOT NULL REFERENCES place (id),
  valid_from  float8,
  valid_to    float8,
  source_id   text NOT NULL REFERENCES source (id),
  locator     text,
  PRIMARY KEY (polity_id, place_id, source_id)
);

CREATE TABLE person (                                                     -- [P2]
  id            text PRIMARY KEY,
  name          text NOT NULL,
  wikidata_qid  text,
  birth_min float8, birth_max float8,
  death_min float8, death_max float8,
  source_id     text NOT NULL REFERENCES source (id),
  locator       text
);

CREATE TABLE dynasty (                                                    -- [P2]
  id          text PRIMARY KEY,
  name        text NOT NULL,
  lineage_id  text REFERENCES lineage (id),
  source_id   text NOT NULL REFERENCES source (id)
);

-- Who held which office in which polity, when (rulers, consuls, caliphs...).
CREATE TABLE office_tenure (                                              -- [P2]
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  person_id   text NOT NULL REFERENCES person (id),
  polity_id   text NOT NULL REFERENCES polity (id),
  dynasty_id  text REFERENCES dynasty (id),
  title       text NOT NULL,                    -- 'emperor', 'consul', 'caliph', 'shah', ...
  start_min float8 NOT NULL, start_max float8 NOT NULL,
  end_min   float8,          end_max   float8,
  source_id   text NOT NULL REFERENCES source (id),
  locator     text,
  evidence    evidence_kind NOT NULL,
  confidence  confidence_level NOT NULL DEFAULT 'medium',
  dispute_id  bigint REFERENCES dispute (id),
  is_preferred boolean NOT NULL DEFAULT true
);

CREATE TABLE event_kind (                                                 -- [P2]
  id     text PRIMARY KEY,                      -- 'battle', 'siege', 'treaty', 'eruption', ...
  layer  text NOT NULL CHECK (layer IN
           ('political', 'military', 'human', 'economic', 'cultural',
            'scientific', 'environmental', 'exploration', 'urban')),
  label  text NOT NULL
);

CREATE TABLE event (                                                      -- [P2]
  id                    text PRIMARY KEY,
  title                 text NOT NULL,
  kind_id               text NOT NULL REFERENCES event_kind (id),
  geom                  geometry (Geometry, 4326),   -- point / line / area; NULL if aspatial
  location_precision_m  int,
  wikidata_qid          text,
  start_min float8 NOT NULL, start_max float8 NOT NULL,
  end_min   float8,          end_max   float8,
  start_precision date_precision NOT NULL DEFAULT 'year',
  span yearrange GENERATED ALWAYS AS
         (yearrange(start_min, coalesce(end_max, start_max), '[]')) STORED,
  source_id   text NOT NULL REFERENCES source (id),
  locator     text,
  evidence    evidence_kind NOT NULL,
  confidence  confidence_level NOT NULL DEFAULT 'medium',
  dispute_id  bigint REFERENCES dispute (id),
  is_preferred boolean NOT NULL DEFAULT true,
  CHECK (start_min <= start_max)
);
CREATE INDEX event_geom_span_gix ON event USING gist (geom, span);

CREATE TABLE event_participant (                                          -- [P2]
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id   text NOT NULL REFERENCES event (id) ON DELETE CASCADE,
  polity_id  text REFERENCES polity (id),
  person_id  text REFERENCES person (id),
  role       text NOT NULL,                     -- 'belligerent', 'victor', 'signatory', 'commander'
  side       smallint,                          -- groups belligerents into sides
  source_id  text NOT NULL REFERENCES source (id),
  CHECK (num_nonnulls(polity_id, person_id) = 1)
);

-- =============================================================================
-- Movement: trade routes, roads, voyages, campaigns, migrations
-- =============================================================================

CREATE TABLE route (                                                      -- [P3]
  id          text PRIMARY KEY,
  name        text NOT NULL,
  kind        text NOT NULL CHECK (kind IN
                ('trade', 'road', 'voyage', 'campaign', 'migration', 'pilgrimage')),
  -- M coordinate = decimal year at each vertex, so a voyage or campaign can be
  -- animated along its path at the pace the sources attest.
  geom        geometry (MultiLineStringM, 4326) NOT NULL,
  start_min float8 NOT NULL, start_max float8 NOT NULL,
  end_min   float8,          end_max   float8,
  source_id   text NOT NULL REFERENCES source (id),
  locator     text,
  evidence    evidence_kind NOT NULL,
  confidence  confidence_level NOT NULL DEFAULT 'medium'
);
CREATE INDEX route_geom_gix ON route USING gist (geom);

-- =============================================================================
-- Quantities: population, GDP, army sizes... always ranges, always sourced
-- =============================================================================

CREATE TABLE region (                                                     -- [P3]
  id          text PRIMARY KEY,                 -- 'indian-subcontinent'
  name        text NOT NULL,
  geom        geometry (MultiPolygon, 4326) NOT NULL,
  definition  text NOT NULL,                    -- how the region is defined, and by whom
  source_id   text NOT NULL REFERENCES source (id)
);

CREATE TABLE variable (                                                   -- [P3]
  id           text PRIMARY KEY,                -- 'population', 'gdp_per_capita_2011usd', ...
  label        text NOT NULL,
  unit         text NOT NULL,
  description  text
);

CREATE TABLE estimate (                                                   -- [P3]
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  variable_id  text NOT NULL REFERENCES variable (id),
  polity_id    text REFERENCES polity (id),
  place_id     text REFERENCES place (id),
  region_id    text REFERENCES region (id),
  year_min     float8 NOT NULL,                 -- the date the estimate refers to
  year_max     float8 NOT NULL,
  value_low    float8,
  value_best   float8,
  value_high   float8,
  method       text,
  source_id    text NOT NULL REFERENCES source (id),
  locator      text,
  evidence     evidence_kind NOT NULL,
  confidence   confidence_level NOT NULL DEFAULT 'medium',
  dispute_id   bigint REFERENCES dispute (id),
  is_preferred boolean NOT NULL DEFAULT true,
  CHECK (num_nonnulls(polity_id, place_id, region_id) = 1),
  CHECK (year_min <= year_max),
  CHECK (num_nonnulls(value_low, value_best, value_high) >= 1),
  CHECK (value_low  IS NULL OR value_best IS NULL OR value_low  <= value_best),
  CHECK (value_best IS NULL OR value_high IS NULL OR value_best <= value_high)
);

-- =============================================================================
-- Editorial layer: narratives and journeys (human-reviewed before publish)
-- =============================================================================

CREATE TABLE narrative (                                                  -- [P2]
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject_type    text NOT NULL CHECK (subject_type IN
                    ('polity', 'event', 'place', 'person', 'route', 'period')),
  subject_id      text NOT NULL,
  reading_level   text NOT NULL CHECK (reading_level IN ('intro', 'standard', 'advanced')),
  what            text,
  when_text       text,
  where_text      text,
  who             text,
  causes          text,
  consequences    text,
  why_it_matters  text,
  body_md         text,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'reviewed', 'published')),
  generated_by    text,                         -- non-NULL if machine-drafted
  author          text,
  reviewed_by     text,
  reviewed_at     timestamptz,
  CHECK (status <> 'published' OR reviewed_by IS NOT NULL)
);

CREATE TABLE narrative_citation (                                         -- [P2]
  narrative_id  bigint NOT NULL REFERENCES narrative (id) ON DELETE CASCADE,
  source_id     text NOT NULL REFERENCES source (id),
  locator       text,
  claim         text,                           -- the sentence this citation supports
  PRIMARY KEY (narrative_id, source_id, locator)
);

CREATE TABLE journey (                                                    -- [P3]
  id       text PRIMARY KEY,                    -- 'rise-and-fall-of-rome'
  title    text NOT NULL,
  summary  text,
  status   text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'reviewed', 'published'))
);

CREATE TABLE journey_step (                                               -- [P3]
  journey_id    text NOT NULL REFERENCES journey (id) ON DELETE CASCADE,
  ord           int NOT NULL,
  title         text NOT NULL,
  camera        jsonb NOT NULL,                 -- {lon, lat, zoom, bearing, pitch}
  t_start       float8 NOT NULL,
  t_end         float8,                         -- if set, the step plays time forward
  layers        text[] NOT NULL DEFAULT '{}',
  focus_polities text[] NOT NULL DEFAULT '{}',
  narrative_id  bigint REFERENCES narrative (id),
  PRIMARY KEY (journey_id, ord)
);

-- =============================================================================
-- Data quality: QA findings are data, kept and shown, never silently fixed
-- =============================================================================

CREATE TABLE qa_flag (                                                    -- [P1]
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rule_id       text NOT NULL,                  -- 'QA-006', see docs/validation/0001
  severity      text NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
  subject_type  text NOT NULL CHECK (subject_type IN
                  ('polity', 'territory', 'external_id', 'source_release', 'place', 'event')),
  subject_id    text NOT NULL,
  release_id    bigint REFERENCES source_release (id),
  detail        jsonb NOT NULL,                 -- machine-readable evidence (distances, years, QIDs)
  message       text NOT NULL,                  -- the sentence the UI shows
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'confirmed', 'resolved', 'wont_fix')),
  resolution    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX qa_flag_subject_ix ON qa_flag (subject_type, subject_id);

-- =============================================================================
-- Query helpers
-- =============================================================================

-- Polities whose (preferred) territory is possibly alive at decimal year y.
CREATE FUNCTION territories_at(y float8)
RETURNS SETOF territory
LANGUAGE sql STABLE AS $$
  SELECT * FROM territory WHERE span @> y AND is_preferred
$$;

-- "The ground beneath you": every polity that held this point, oldest first.
CREATE FUNCTION core_sample(lon float8, lat float8)
RETURNS TABLE (
  polity_id   text,
  polity_name text,
  lineage_id  text,
  start_min   float8,
  start_max   float8,
  end_min     float8,
  end_max     float8,
  evidence    evidence_kind,
  confidence  confidence_level,
  source_id   text
)
LANGUAGE sql STABLE AS $$
  SELECT t.polity_id, p.name, p.lineage_id,
         t.start_min, t.start_max, t.end_min, t.end_max,
         t.evidence, t.confidence, t.source_id
  FROM territory t
  JOIN polity p ON p.id = t.polity_id
  WHERE t.is_preferred
    AND ST_Intersects(t.geom, ST_SetSRID(ST_MakePoint(lon, lat), 4326))
  ORDER BY t.start_min, p.name
$$;
