/** Decode the pipeline's spike bundle (bundle.json + geometry.bin). Layout is defined in pipeline build.py. */
export interface SectionSpec {
  dtype: string;
  offset: number;
  length: number;
}

export interface BundleMeta {
  format: number;
  release_id: string;
  profile: string;
  years: { min: number; max: number; numbering: string };
  polities: { id: string; name: string; start: number; end: number; qa: string[] }[];
  geometry: { file: string; sections: Record<string, SectionSpec>; territories: number; parts: number; rings: number; vertices: number; bytes: number };
  attribution: string[];
}

export interface Geometry {
  positions: Float32Array;
  ringStart: Uint32Array;
  partRingStart: Uint32Array;
  partTerritory: Uint32Array;
  territoryStart: Int32Array;
  territoryEnd: Int32Array;
  territoryPolity: Uint32Array;
  territoryRow: Uint32Array;
  territoryArea: Float32Array;
  /** Format 2: pre-computed triangles (global vertex indices, 3 per triangle) and each part's first index. */
  triangles: Uint32Array | null;
  partTriangleStart: Uint32Array | null;
}

const CTORS: Record<string, Float32ArrayConstructor | Uint32ArrayConstructor | Int32ArrayConstructor> = {
  "<f4": Float32Array,
  "<u4": Uint32Array,
  "<i4": Int32Array,
};

export function decodeGeometry(meta: BundleMeta, buf: ArrayBuffer): Geometry {
  const s = meta.geometry.sections;
  const view = <T>(name: string, optional = false): T => {
    const spec = s[name];
    if (!spec) {
      if (optional) return null as T;
      throw new Error(`bundle: missing section ${name}`);
    }
    const Ctor = CTORS[spec.dtype];
    if (!Ctor) throw new Error(`bundle: unsupported dtype ${spec.dtype}`);
    if (spec.offset + spec.length * Ctor.BYTES_PER_ELEMENT > buf.byteLength) throw new Error(`bundle: section ${name} overruns file`);
    return new Ctor(buf, spec.offset, spec.length) as T;
  };
  const g: Geometry = {
    positions: view<Float32Array>("positions"),
    ringStart: view<Uint32Array>("ring_start"),
    partRingStart: view<Uint32Array>("part_ring_start"),
    partTerritory: view<Uint32Array>("part_territory"),
    territoryStart: view<Int32Array>("territory_start"),
    territoryEnd: view<Int32Array>("territory_end"),
    territoryPolity: view<Uint32Array>("territory_polity"),
    territoryRow: view<Uint32Array>("territory_row"),
    territoryArea: view<Float32Array>("territory_area_km2"),
    triangles: view<Uint32Array | null>("triangles", true),
    partTriangleStart: view<Uint32Array | null>("part_triangle_start", true),
  };
  if (g.partTerritory.length !== meta.geometry.parts) throw new Error("bundle: part count mismatch");
  if (g.territoryStart.length !== meta.geometry.territories) throw new Error("bundle: territory count mismatch");
  return g;
}

/** One deck.gl item per polygon part, in deck's flat complex-polygon format. */
export interface PartItem {
  polygon: { positions: Float32Array; holeIndices: number[] };
  territory: number;
  start: number;
  end: number;
}

export function partItems(g: Geometry): PartItem[] {
  const items: PartItem[] = new Array(g.partTerritory.length);
  for (let p = 0; p < g.partTerritory.length; p++) {
    const r0 = g.partRingStart[p] as number;
    const r1 = g.partRingStart[p + 1] as number;
    const v0 = g.ringStart[r0] as number;
    const v1 = g.ringStart[r1] as number;
    // deck.gl holeIndices are offsets into the flat positions array (vertex index * 2 for XY), not vertex indices.
    const holeIndices: number[] = [];
    for (let r = r0 + 1; r < r1; r++) holeIndices.push(((g.ringStart[r] as number) - v0) * 2);
    const t = g.partTerritory[p] as number;
    items[p] = {
      polygon: { positions: g.positions.subarray(v0 * 2, v1 * 2), holeIndices },
      territory: t,
      start: g.territoryStart[t] as number,
      end: g.territoryEnd[t] as number,
    };
  }
  return items;
}

/** One GeoJSON feature per territory (MultiPolygon of its parts), for MapLibre's native path. */
export function territoryFeatures(g: Geometry): GeoJSON.FeatureCollection<GeoJSON.MultiPolygon> {
  const coords: GeoJSON.Position[][][][] = Array.from({ length: g.territoryStart.length }, () => []);
  for (let p = 0; p < g.partTerritory.length; p++) {
    const poly: GeoJSON.Position[][] = [];
    for (let r = g.partRingStart[p] as number; r < (g.partRingStart[p + 1] as number); r++) {
      const ring: GeoJSON.Position[] = [];
      for (let v = g.ringStart[r] as number; v < (g.ringStart[r + 1] as number); v++) ring.push([g.positions[2 * v] as number, g.positions[2 * v + 1] as number]);
      poly.push(ring);
    }
    (coords[g.partTerritory[p] as number] as GeoJSON.Position[][][]).push(poly);
  }
  return {
    type: "FeatureCollection",
    features: coords.map((c, t) => ({
      type: "Feature",
      id: t,
      properties: { s: g.territoryStart[t], e: g.territoryEnd[t], p: g.territoryPolity[t], t },
      geometry: { type: "MultiPolygon", coordinates: c },
    })),
  };
}

/**
 * deck.gl binary input for SolidPolygonLayer (milestone 1.2, D-021): positions and triangles are views of the
 * bundle's own buffer; per-vertex colour and [start, end] are built once in typed arrays. No per-part
 * objects, no normalisation and no triangulation in the browser. Use with `_normalize: false`.
 */
export interface DeckBinary {
  length: number;
  startIndices: Uint32Array;
  attributes: {
    getPolygon: { value: Float32Array; size: 2 };
    indices: Uint32Array;
    getFillColor: { value: Uint8Array; size: 4; normalized: true };
    getFilterValue: { value: Float32Array; size: 2 };
  };
}

export function deckBinaryData(g: Geometry, colourOf: (polity: number) => [number, number, number, number]): DeckBinary {
  if (!g.triangles) throw new Error("bundle: format 2 (triangles) required for binary rendering");
  const parts = g.partTerritory.length;
  const vertexCount = g.positions.length / 2;
  const startIndices = new Uint32Array(parts);
  const colours = new Uint8Array(vertexCount * 4);
  const filters = new Float32Array(vertexCount * 2);
  for (let p = 0; p < parts; p++) {
    const v0 = g.ringStart[g.partRingStart[p] as number] as number;
    const v1 = g.ringStart[g.partRingStart[p + 1] as number] as number;
    startIndices[p] = v0;
    const t = g.partTerritory[p] as number;
    const [r, gg, b, a] = colourOf(g.territoryPolity[t] as number);
    const s = g.territoryStart[t] as number;
    const e = g.territoryEnd[t] as number;
    for (let v = v0; v < v1; v++) {
      colours[4 * v] = r; colours[4 * v + 1] = gg; colours[4 * v + 2] = b; colours[4 * v + 3] = a;
      filters[2 * v] = s; filters[2 * v + 1] = e;
    }
  }
  return {
    length: parts, startIndices,
    attributes: {
      getPolygon: { value: g.positions, size: 2 },
      indices: g.triangles,
      getFillColor: { value: colours, size: 4, normalized: true },
      getFilterValue: { value: filters, size: 2 },
    },
  };
}
