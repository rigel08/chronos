import { describe, expect, it } from "vitest";

import { type BundleMeta, decodeGeometry, deckBinaryData } from "../src/bench/bundle";

/** Two territories, three parts, with pipeline-style triangles (format 2). */
function bundle() {
  const sq = (x: number, y: number) => [x, y, x + 1, y, x + 1, y + 1, x, y + 1, x, y];
  const arrays: [string, Float32Array | Uint32Array | Int32Array][] = [
    ["positions", new Float32Array([...sq(0, 0), ...sq(2, 0), ...sq(5, 5)])],
    ["ring_start", new Uint32Array([0, 5, 10, 15])],
    ["part_ring_start", new Uint32Array([0, 1, 2, 3])],
    ["part_territory", new Uint32Array([0, 0, 1])],
    ["triangles", new Uint32Array([0, 1, 2, 0, 2, 3, 5, 6, 7, 5, 7, 8, 10, 11, 12, 10, 12, 13])],
    ["part_triangle_start", new Uint32Array([0, 6, 12, 18])],
    ["territory_start", new Int32Array([-26, 100])],
    ["territory_end", new Int32Array([394, 200])],
    ["territory_polity", new Uint32Array([3, 7])],
    ["territory_row", new Uint32Array([11, 12])],
    ["territory_area_km2", new Float32Array([1, 2])],
  ];
  const sections: BundleMeta["geometry"]["sections"] = {};
  let offset = 0;
  const parts: Uint8Array[] = [];
  for (const [name, a] of arrays) {
    sections[name] = { dtype: a instanceof Float32Array ? "<f4" : a instanceof Int32Array ? "<i4" : "<u4", offset, length: a.length };
    parts.push(new Uint8Array(a.buffer));
    offset += a.byteLength;
  }
  const buf = new Uint8Array(offset);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.byteLength; }
  const meta = { geometry: { file: "geometry.bin", sections, territories: 2, parts: 3, rings: 3, vertices: 15, bytes: offset } } as unknown as BundleMeta;
  return decodeGeometry(meta, buf.buffer);
}

describe("deck.gl binary data (D-021)", () => {
  it("passes positions and triangles through as views, without copying", () => {
    const g = bundle();
    const d = deckBinaryData(g, (p) => [p, p, p, 255]);
    expect(d.attributes.getPolygon.value).toBe(g.positions);
    expect(d.attributes.indices).toBe(g.triangles);
    expect(Array.from(d.startIndices)).toEqual([0, 5, 10]);
    expect(d.length).toBe(3);
  });
  it("writes each vertex's territory colour and [start, end]", () => {
    const d = deckBinaryData(bundle(), (p) => [p, 0, 0, 200]);
    const c = d.attributes.getFillColor.value;
    const f = d.attributes.getFilterValue.value;
    expect([c[0], c[3]]).toEqual([3, 200]);            // vertex 0: territory 0 -> polity 3
    expect([c[4 * 9], c[4 * 10]]).toEqual([3, 7]);     // last vertex of part 1, first of part 2
    expect([f[0], f[1], f[2 * 14], f[2 * 14 + 1]]).toEqual([-26, 394, 100, 200]);
  });
  it("refuses a format-1 bundle with no triangles", () => {
    const g = { ...bundle(), triangles: null };
    expect(() => deckBinaryData(g, () => [0, 0, 0, 0])).toThrow(/format 2/);
  });
});
