import { describe, expect, it } from "vitest";

import { type BundleMeta, decodeGeometry, partItems, territoryFeatures } from "../src/bench/bundle";

/** Build a bundle exactly as the pipeline writes it: one territory with a square part that has a square hole. */
function makeBundle() {
  const outer = [0, 0, 4, 0, 4, 4, 0, 4, 0, 0];
  const hole = [1, 1, 1, 2, 2, 2, 2, 1, 1, 1];
  const second = [10, 10, 11, 10, 11, 11, 10, 10];
  const arrays: [string, Float32Array | Uint32Array | Int32Array][] = [
    ["positions", new Float32Array([...outer, ...hole, ...second])],
    ["ring_start", new Uint32Array([0, 5, 10, 14])],
    ["part_ring_start", new Uint32Array([0, 2, 3])],
    ["part_territory", new Uint32Array([0, 1])],
    ["territory_start", new Int32Array([-26, 100])],
    ["territory_end", new Int32Array([394, 200])],
    ["territory_polity", new Uint32Array([3, 7])],
    ["territory_row", new Uint32Array([11, 12])],
    ["territory_area_km2", new Float32Array([1.5, 2.5])],
  ];
  const sections: BundleMeta["geometry"]["sections"] = {};
  let offset = 0;
  const parts: Uint8Array[] = [];
  for (const [name, a] of arrays) {
    const dtype = a instanceof Float32Array ? "<f4" : a instanceof Int32Array ? "<i4" : "<u4";
    sections[name] = { dtype, offset, length: a.length };
    parts.push(new Uint8Array(a.buffer));
    offset += a.byteLength;
  }
  const buf = new Uint8Array(offset);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.byteLength; }
  const meta = { geometry: { file: "geometry.bin", sections, territories: 2, parts: 2, rings: 3, vertices: 14, bytes: offset } } as unknown as BundleMeta;
  return { meta, buf: buf.buffer };
}

describe("bundle decoding", () => {
  it("decodes every section and validates counts", () => {
    const { meta, buf } = makeBundle();
    const g = decodeGeometry(meta, buf);
    expect(Array.from(g.territoryStart)).toEqual([-26, 100]);
    expect(g.positions.length).toBe(28);
  });
  it("deck items use coordinate offsets (vertex x 2) for holes", () => {
    const { meta, buf } = makeBundle();
    const items = partItems(decodeGeometry(meta, buf));
    expect(items[0]?.polygon.holeIndices).toEqual([10]);   // the hole starts at vertex 5 -> coordinate 10
    expect(items[0]?.polygon.positions.length).toBe(20);
    expect(items[1]?.polygon.holeIndices).toEqual([]);
    expect(items[0]?.start).toBe(-26);
    expect(items[1]?.end).toBe(200);
  });
  it("GeoJSON features group parts per territory with rings intact", () => {
    const { meta, buf } = makeBundle();
    const fc = territoryFeatures(decodeGeometry(meta, buf));
    expect(fc.features.length).toBe(2);
    const first = fc.features[0];
    expect(first?.geometry.coordinates[0]?.length).toBe(2);           // exterior + hole
    expect(first?.geometry.coordinates[0]?.[1]?.[1]).toEqual([1, 2]);
    expect(first?.properties).toMatchObject({ s: -26, e: 394, p: 3, t: 0 });
  });
  it("rejects a section that overruns the file", () => {
    const { meta, buf } = makeBundle();
    (meta.geometry.sections["positions"] as { length: number }).length = 10_000;
    expect(() => decodeGeometry(meta, buf)).toThrow(/overruns/);
  });
});
