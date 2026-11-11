/**
 * Bundle format 3 (pipeline 0.3.0, D-025): bundle.json + geometry.<hash>.bin. Layout is defined in
 * pipeline/src/chronos_pipeline/build.py; every section is a little-endian typed array aligned to 8 bytes.
 */
export interface SectionSpec {
  dtype: string;
  offset: number;
  length: number;
}

export interface WikidataLink {
  value: string;
  label: string | null;
  status: "asserted" | "verified" | "corrected" | "rejected" | string;
  flags: string[];
  corrected_to?: { value: string; label: string | null };
}

export interface PolityMeta {
  id: string;
  name: string;
  start: number;
  end: number;
  colour: number;
  qa: string[];
  wikidata: WikidataLink[];
}

export interface SourceMeta {
  id: string;
  title: string;
  citation: string;
  url: string | null;
  license: string;
  license_name: string;
  license_url: string | null;
  access_tier: string;
  evidence: string | null;
}

export interface FileEntry {
  path: string;
  sha256?: string;
  bytes?: number;
  br?: number;
  gz?: number;
}

export interface BundleMeta {
  format: number;
  release_id: string;
  profile: string;
  pipeline_version: string;
  years: { min: number; max: number; numbering: string };
  polities: PolityMeta[];
  palette: { colours: string[]; names: string[]; note: string };
  sources: SourceMeta[];
  coverage: { land: string; step_years: number; rule: string; samples: [number, number, number][] };
  overlaps: { regions: number; slots: number; kind_codes: Record<string, number>; by_kind: Record<string, { regions: number; km2: number }> };
  geometry: {
    file: string;
    sections: Record<string, SectionSpec>;
    bytes: number;
    territories: number;
    parts: number;
    vertices: number;
    triangles: number;
    overlap_regions: number;
    overlap_vertices: number;
  };
  files: {
    geometry: FileEntry;
    catalog: FileEntry;
    basemap_land: FileEntry;
    basemap_coastline: FileEntry;
    basemap_lakes: FileEntry;
    basemap_rivers: FileEntry;
    attributions: FileEntry;
    trace: FileEntry;
    relief: { template: string; tile_size: number; minzoom: number; maxzoom: number };
  };
  attribution: string[];
}

/** A triangulated mesh: territories, or overlap regions (D-026). */
export interface Mesh {
  positions: Float32Array;          // lon, lat per vertex
  ringStart: Uint32Array;
  partRingStart: Uint32Array;
  partOwner: Uint32Array;           // territory index, or region index
  partTriangleStart: Uint32Array;   // index counts, parts + 1
  triangles: Uint32Array;           // global vertex indices
}

export interface Geometry {
  territories: Mesh;
  edgeFlags: Uint8Array;            // bit 0: edge v -> v+1 is a grid cut or the antimeridian
  territoryStart: Int32Array;
  territoryEnd: Int32Array;
  territoryPolity: Uint32Array;
  territoryRow: Uint32Array;        // Cliopatria row index (the locator)
  territoryArea: Float64Array;      // km2, EPSG:6933, as given by the source (float64: float32 mis-rounds large areas)
  territoryLabel: Float32Array;     // lon, lat of a point well inside the largest part
  overlaps: Mesh;
  regionStart: Int32Array;
  regionEnd: Int32Array;
  regionTerritories: Uint32Array;   // slots per region, NO_OWNER-padded
  regionArea: Float64Array;
  regionKind: Uint8Array;
  regionSlots: number;
}

export const NO_OWNER = 0xffffffff;
export const EDGE_SYNTHETIC = 1;

type Ctor = Float32ArrayConstructor | Float64ArrayConstructor | Uint32ArrayConstructor | Int32ArrayConstructor | Uint8ArrayConstructor;
const CTORS: Record<string, Ctor> = { "<f4": Float32Array, "<f8": Float64Array, "<u4": Uint32Array, "<i4": Int32Array, "|u1": Uint8Array };

export function section<T>(meta: BundleMeta, buf: ArrayBuffer, name: string): T {
  const spec = meta.geometry.sections[name];
  if (!spec) throw new Error(`bundle: missing section ${name}`);
  const C = CTORS[spec.dtype];
  if (!C) throw new Error(`bundle: unsupported dtype ${spec.dtype}`);
  if (spec.offset % C.BYTES_PER_ELEMENT) throw new Error(`bundle: section ${name} is misaligned`);
  if (spec.offset + spec.length * C.BYTES_PER_ELEMENT > buf.byteLength) throw new Error(`bundle: section ${name} overruns the file`);
  return new C(buf, spec.offset, spec.length) as T;
}

/**
 * Decode varint triangle indices (per-part delta + zigzag + LEB128) into global vertex indices.
 * One sequential pass; the inverse of chronos_pipeline.encode.encode_triangles.
 */
export function decodeTriangles(bytes: Uint8Array, partTriangleStart: Uint32Array, partFirstVertex: ArrayLike<number>): Uint32Array {
  const parts = partTriangleStart.length - 1;
  const out = new Uint32Array(partTriangleStart[parts] as number);
  let pos = 0;
  let k = 0;
  for (let p = 0; p < parts; p++) {
    const n = (partTriangleStart[p + 1] as number) - (partTriangleStart[p] as number);
    const first = partFirstVertex[p] as number;
    let local = 0;
    for (let i = 0; i < n; i++) {
      let v = 0;
      let shift = 0;
      let b: number;
      do {
        b = bytes[pos++] as number;
        v += (b & 0x7f) * 2 ** shift;          // multiplication keeps values above 2^31 exact
        shift += 7;
      } while (b & 0x80);
      local += v % 2 === 1 ? -(v + 1) / 2 : v / 2;   // unzigzag
      out[k++] = first + local;
    }
  }
  if (pos !== bytes.length) throw new Error(`bundle: triangle stream has ${bytes.length - pos} trailing bytes`);
  return out;
}

/** First vertex of every part (deck.gl's startIndices for binary polygons). */
export function partFirstVertices(ringStart: Uint32Array, partRingStart: Uint32Array): Uint32Array {
  const parts = partRingStart.length - 1;
  const first = new Uint32Array(parts);
  for (let p = 0; p < parts; p++) first[p] = ringStart[partRingStart[p] as number] as number;
  return first;
}

/** Decode one mesh's varint triangles (the expensive step; the loader runs it in a worker). */
export function meshTriangles(meta: BundleMeta, buf: ArrayBuffer, prefix: "" | "ov_"): { triangles: Uint32Array; first: Uint32Array } {
  const first = partFirstVertices(section(meta, buf, `${prefix}ring_start`), section(meta, buf, `${prefix}part_ring_start`));
  return { first, triangles: decodeTriangles(section(meta, buf, `${prefix}triangles_varint`), section(meta, buf, `${prefix}part_triangle_start`), first) };
}

function mesh(meta: BundleMeta, buf: ArrayBuffer, prefix: "" | "ov_", triangles: Uint32Array): Mesh {
  return {
    positions: section<Float32Array>(meta, buf, `${prefix}positions`),
    ringStart: section<Uint32Array>(meta, buf, `${prefix}ring_start`),
    partRingStart: section<Uint32Array>(meta, buf, `${prefix}part_ring_start`),
    partTriangleStart: section<Uint32Array>(meta, buf, `${prefix}part_triangle_start`),
    partOwner: section<Uint32Array>(meta, buf, prefix ? "ov_part_region" : "part_territory"),
    triangles,
  };
}

export function decodeGeometry(meta: BundleMeta, buf: ArrayBuffer): Geometry {
  return assembleGeometry(meta, buf, meshTriangles(meta, buf, "").triangles, meshTriangles(meta, buf, "ov_").triangles);
}

/** Views over the bundle buffer plus already-decoded triangles. */
export function assembleGeometry(meta: BundleMeta, buf: ArrayBuffer, triangles: Uint32Array, ovTriangles: Uint32Array): Geometry {
  if (meta.format !== 3) throw new Error(`bundle: format ${meta.format} is not supported (expected 3)`);
  const g: Geometry = {
    territories: mesh(meta, buf, "", triangles),
    edgeFlags: section<Uint8Array>(meta, buf, "edge_flags"),
    territoryStart: section<Int32Array>(meta, buf, "territory_start"),
    territoryEnd: section<Int32Array>(meta, buf, "territory_end"),
    territoryPolity: section<Uint32Array>(meta, buf, "territory_polity"),
    territoryRow: section<Uint32Array>(meta, buf, "territory_row"),
    territoryArea: section<Float64Array>(meta, buf, "territory_area_km2"),
    territoryLabel: section<Float32Array>(meta, buf, "territory_label"),
    overlaps: mesh(meta, buf, "ov_", ovTriangles),
    regionStart: section<Int32Array>(meta, buf, "region_start"),
    regionEnd: section<Int32Array>(meta, buf, "region_end"),
    regionTerritories: section<Uint32Array>(meta, buf, "region_territories"),
    regionArea: section<Float64Array>(meta, buf, "region_area_km2"),
    regionKind: section<Uint8Array>(meta, buf, "region_kind"),
    regionSlots: meta.overlaps.slots,
  };
  if (g.territories.partOwner.length !== meta.geometry.parts) throw new Error("bundle: part count mismatch");
  if (g.territoryStart.length !== meta.geometry.territories) throw new Error("bundle: territory count mismatch");
  if (g.edgeFlags.length !== meta.geometry.vertices) throw new Error("bundle: edge flag count mismatch");
  return g;
}

/** Vertex range [v0, v1) of render part p. */
export function partVertices(m: Mesh, p: number): [number, number] {
  return [m.ringStart[m.partRingStart[p] as number] as number, m.ringStart[m.partRingStart[p + 1] as number] as number];
}
