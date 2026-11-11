import { beforeAll, describe, expect, it } from "vitest";

import { decodeGeometry } from "../src/lib/bundle";
import { fixture } from "./fixture";

// state.ts reads the URL and the motion preference at load; give it a minimal browser-like environment.
let S: typeof import("../src/app/state");
beforeAll(async () => {
  Object.assign(globalThis, { location: { hash: "", search: "" }, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  S = await import("../src/app/state");
});

describe("derived data for the header, card and timeline", () => {
  it("counts polities mapped per year from row spans (inclusive bounds)", () => {
    const { meta, buf } = fixture();
    const g = decodeGeometry(meta, buf);
    const d = S.deriveIndices(meta, g);
    const at = (t: number) => d.mappedPerYear[t - meta.years.min];
    expect([at(-27), at(-26), at(99), at(100), at(200), at(201), at(394), at(395)]).toEqual([0, 1, 1, 2, 2, 1, 1, 0]);
    expect(d.territoriesOf[3]).toEqual([0]);
    expect(d.polityIndex.get("p7")).toBe(7);
  });
  it("names the coverage sample it uses (nearest sample, with its own year)", () => {
    const { meta } = fixture();
    expect(S.coverageNear(meta, 117)).toEqual({ year: 101, share: 0.157, polities: 36 });
    expect(S.coverageNear(meta, -3000)?.year).toBe(-3399);
  });
  it("finds the overlap regions a row shares in a given year, and only then", () => {
    const { meta, buf } = fixture();
    const g = decodeGeometry(meta, buf);
    const d = { ...S.deriveIndices(meta, g), meta, g } as unknown as Parameters<typeof S.regionsAt>[0];
    expect(S.regionsAt(d, new Set([0]), 150)).toEqual([{ region: 0, territories: [0, 1], km2: 12345, kind: "unlinked" }]);
    expect(S.regionsAt(d, new Set([0]), 99)).toEqual([]);
    expect(S.regionsAt(d, new Set([1]), 200)).toHaveLength(1);
  });
});
