/**
 * A format-3 bundle built exactly as the pipeline lays it out (8-byte aligned sections). The varint triangle
 * bytes were produced by the pipeline's own encoder (chronos_pipeline.encode.encode_triangles), so decoding them
 * here checks the two implementations against each other.
 *
 * Territory 0 (polity 3, -26..394): two unit squares at (0,0) and (2,0). Territory 1 (polity 7, 100..200): a unit
 * square at (5,5). One overlap region (territories 0 and 1, 100..200) drawn as a unit square at (0,0).
 */
import type { BundleMeta } from "../src/lib/bundle";

const sq = (x: number, y: number) => [x, y, x + 1, y, x + 1, y + 1, x, y + 1, x, y];

export function fixture() {
  const arrays: [string, Float32Array | Float64Array | Uint32Array | Int32Array | Uint8Array][] = [
    ["positions", new Float32Array([...sq(0, 0), ...sq(2, 0), ...sq(5, 5)])],
    ["ring_start", new Uint32Array([0, 5, 10, 15])],
    ["part_ring_start", new Uint32Array([0, 1, 2, 3])],
    ["part_territory", new Uint32Array([0, 0, 1])],
    ["part_triangle_start", new Uint32Array([0, 6, 12, 18])],
    ["territory_start", new Int32Array([-26, 100])],
    ["territory_end", new Int32Array([394, 200])],
    ["territory_polity", new Uint32Array([3, 7])],
    ["territory_row", new Uint32Array([11, 12])],
    ["territory_area_km2", new Float64Array([1, 2])],
    ["territory_label", new Float32Array([0.5, 0.5, 5.5, 5.5])],
    ["ov_positions", new Float32Array(sq(0, 0))],
    ["ov_ring_start", new Uint32Array([0, 5])],
    ["ov_part_ring_start", new Uint32Array([0, 1])],
    ["ov_part_region", new Uint32Array([0])],
    ["ov_part_triangle_start", new Uint32Array([0, 6])],
    ["region_start", new Int32Array([100])],
    ["region_end", new Int32Array([200])],
    ["region_territories", new Uint32Array([0, 1, 0xffffffff, 0xffffffff])],
    ["region_area_km2", new Float64Array([12345])],
    // pipeline encode_triangles([0,1,2,0,2,3, 5,6,7,5,7,8, 10,11,12,10,12,13], [0,6,12,18], [0,5,10])
    ["triangles_varint", new Uint8Array([0, 2, 2, 3, 4, 2, 0, 2, 2, 3, 4, 2, 0, 2, 2, 3, 4, 2])],
    ["ov_triangles_varint", new Uint8Array([0, 2, 2, 3, 4, 2])],
    // vertex 1 -> 2 of the first square is a grid cut (x = 1 is not a grid line here; the flag is what matters)
    ["edge_flags", new Uint8Array([0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])],
    ["region_kind", new Uint8Array([2])],
  ];
  const sections: BundleMeta["geometry"]["sections"] = {};
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (const [name, a] of arrays) {
    const dtype = a instanceof Float32Array ? "<f4" : a instanceof Float64Array ? "<f8" : a instanceof Int32Array ? "<i4" : a instanceof Uint8Array ? "|u1" : "<u4";
    sections[name] = { dtype, offset, length: a.length };
    const pad = (8 - (a.byteLength % 8)) % 8;
    const c = new Uint8Array(a.byteLength + pad);
    c.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
    chunks.push(c);
    offset += c.byteLength;
  }
  const buf = new Uint8Array(offset);
  let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.byteLength; }
  const polities = Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, name: `Polity ${i}`, start: -26, end: 394, colour: i % 3, qa: [], wikidata: [] }));
  const meta = {
    format: 3, release_id: "test", profile: "public", pipeline_version: "0.3.0",
    years: { min: -3399, max: 2024, numbering: "astronomical" }, polities,
    palette: { colours: ["#cf5637", "#4b70c6", "#d9a845"], names: ["a", "b", "c"], note: "" },
    sources: [], coverage: { land: "", step_years: 100, rule: "QA-011", samples: [[-3399, 0.0002, 1], [101, 0.157, 36]] },
    overlaps: { regions: 1, slots: 4, kind_codes: { linked: 0, sliver: 1, unlinked: 2, multiple: 3 }, by_kind: {} },
    geometry: { file: "geometry.x.bin", sections, bytes: offset, territories: 2, parts: 3, vertices: 15, triangles: 6, overlap_regions: 1, overlap_vertices: 5 },
    files: {}, attribution: [],
  } as unknown as BundleMeta;
  return { meta, buf: buf.buffer };
}
