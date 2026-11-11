import { describe, expect, it } from "vitest";

import { decodeGeometry as decodeForHarness, deckBinaryData, partItems, territoryFeatures } from "../src/bench/bundle";
import { decodeGeometry, decodeTriangles, partVertices } from "../src/lib/bundle";
import { fixture } from "./fixture";

describe("bundle format 3 (D-025)", () => {
  it("decodes the pipeline's varint triangles exactly (cross-language)", () => {
    // pipeline: encode_triangles([0,1,2,0,2,3,7,9,8], part_triangle_start [0,6,6,9], first [0,4,7]) with an empty part
    const bytes = new Uint8Array([0, 2, 2, 3, 4, 2, 0, 4, 1]);
    expect(Array.from(decodeTriangles(bytes, new Uint32Array([0, 6, 6, 9]), [0, 4, 7]))).toEqual([0, 1, 2, 0, 2, 3, 7, 9, 8]);
  });
  it("decodes multi-byte varints and rejects trailing bytes", () => {
    // pipeline: leb128(zigzag([200, -300, 70000])), read as one part
    const bytes = new Uint8Array([144, 3, 215, 4, 224, 197, 8]);
    // zigzag deltas 200, -300, 70000 accumulate to local indices 200, -100, 69900; first vertex 1000 makes them valid
    expect(Array.from(decodeTriangles(bytes, new Uint32Array([0, 3]), [1000]))).toEqual([1200, 900, 70900]);
    expect(() => decodeTriangles(new Uint8Array([0, 0, 0, 5]), new Uint32Array([0, 3]), [0])).toThrow(/trailing/);
  });
  it("decodes every section, with views over one buffer", () => {
    const { meta, buf } = fixture();
    const g = decodeGeometry(meta, buf);
    expect(Array.from(g.territoryStart)).toEqual([-26, 100]);
    expect(Array.from(g.territories.triangles)).toEqual([0, 1, 2, 0, 2, 3, 5, 6, 7, 5, 7, 8, 10, 11, 12, 10, 12, 13]);
    expect(g.territories.positions.buffer).toBe(buf);
    expect(partVertices(g.territories, 1)).toEqual([5, 10]);
    expect(Array.from(g.overlaps.triangles)).toEqual([0, 1, 2, 0, 2, 3]);
    expect(Array.from(g.regionTerritories.slice(0, 2))).toEqual([0, 1]);
    expect(g.edgeFlags[1]).toBe(1);
  });
  it("rejects other formats, misaligned or overrunning sections", () => {
    const a = fixture();
    expect(() => decodeGeometry({ ...a.meta, format: 2 }, a.buf)).toThrow(/format 2/);
    const b = fixture();
    (b.meta.geometry.sections["positions"] as { length: number }).length = 10_000;
    expect(() => decodeGeometry(b.meta, b.buf)).toThrow(/overruns/);
    const c = fixture();
    (c.meta.geometry.sections["territory_start"] as { offset: number }).offset += 2;
    expect(() => decodeGeometry(c.meta, c.buf)).toThrow(/misaligned/);
  });
});

describe("benchmark harness on format 3", () => {
  it("keeps the 1.2 binary path: positions and triangles passed through without copying", () => {
    const { meta, buf } = fixture();
    const g = decodeForHarness(meta, buf);
    const d = deckBinaryData(g, (p) => [p, 0, 0, 200]);
    expect(d.attributes.getPolygon.value).toBe(g.positions);
    expect(d.attributes.indices).toBe(g.triangles);
    expect(Array.from(d.startIndices)).toEqual([0, 5, 10]);
    const c = d.attributes.getFillColor.value;
    expect([c[0], c[4 * 10]]).toEqual([3, 7]);
  });
  it("still builds the Spike 001 and MapLibre inputs", () => {
    const { meta, buf } = fixture();
    const g = decodeForHarness(meta, buf);
    expect(partItems(g).map((i) => i.territory)).toEqual([0, 0, 1]);
    const fc = territoryFeatures(g);
    expect(fc.features[0]?.geometry.coordinates.length).toBe(2);
    expect(fc.features[1]?.properties).toMatchObject({ s: 100, e: 200, p: 7 });
  });
});
