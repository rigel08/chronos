import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { type BundleMeta, decodeGeometry } from "../src/lib/bundle";
import { buildIndex, sample } from "../src/lib/coreSample";
import { fixture } from "./fixture";

describe("core sample (synthetic)", () => {
  const { meta, buf } = fixture();
  const g = decodeGeometry(meta, buf);
  const idx = buildIndex(g);
  it("finds an exact hit inside a part", () => {
    const s = sample(g, meta, idx, 0.5, 0.5, 5);
    expect(s.strata.map((x) => [x.polity, x.start, x.end, x.exact])).toEqual([[3, -26, 394, true]]);
    expect(s.gaps).toEqual([]);
  });
  it("reports a near hit with its distance, and nothing beyond the tolerance", () => {
    const near = sample(g, meta, idx, 1.02, 0.5, 5);           // 0.02 degrees east of the first square: about 2.2 km
    expect(near.strata[0]?.exact).toBe(false);
    expect(near.strata[0]?.distanceKm).toBeGreaterThan(2.1);
    expect(near.strata[0]?.distanceKm).toBeLessThan(2.4);
    expect(sample(g, meta, idx, 1.2, 0.5, 5).strata).toEqual([]);
  });
});

// Real data: the browser core sample must reproduce the pipeline's QA-010 result for Rome exactly, and agree with
// every ground-truth test point. Skipped when no build exists (run `make data`).
const DATA = resolve(import.meta.dirname, "../../../data/build/current");
const has = existsSync(resolve(DATA, "bundle.json"));
describe.skipIf(!has)("core sample (real bundle)", () => {
  const root = has ? realpathSync(DATA) : "";
  const meta = has ? (JSON.parse(readFileSync(resolve(root, "bundle.json"), "utf8")) as BundleMeta) : (null as unknown as BundleMeta);
  const load = () => {
    const b = readFileSync(resolve(root, meta.files.geometry.path));
    return decodeGeometry(meta, b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
  };
  it("Rome equals the pipeline's QA-010 point check", () => {
    const g = load();
    const report = JSON.parse(readFileSync(resolve(root, "qa_report.json"), "utf8"));
    const want = report.point_checks.Rome;
    const got = sample(g, meta, buildIndex(g), want.lon, want.lat, want.tolerance_km);
    expect(got.strata.length).toBe(want.strata.length);
    got.strata.forEach((s, i) => {
      const w = want.strata[i];
      expect([s.polityId, s.name, s.start, s.end, s.exact]).toEqual([w.polity_id, w.name, w.start, w.end, w.exact]);
      expect([...s.rows].sort((a, b) => a - b)).toEqual([...w.rows].sort((a: number, b: number) => a - b));
      if (!w.exact) expect(Math.abs(s.distanceKm - w.distance_km)).toBeLessThanOrEqual(Math.max(0.01, w.distance_km * 0.01));
    });
    expect(got.gaps).toEqual(want.gaps);
    expect(got.overlaps).toEqual(want.overlaps);
  }, 60_000);
  it("agrees with all ground-truth test points", () => {
    const g = load();
    const idx = buildIndex(g);
    const tp = JSON.parse(readFileSync(resolve(root, "testpoints.json"), "utf8")) as { points: { year: number; lon: number; lat: number; kind: string; expected: string[] }[] };
    let checked = 0;
    for (const p of tp.points) {
      const s = sample(g, meta, idx, p.lon, p.lat, 5);
      const exactAt = s.strata.filter((x) => x.exact && x.start <= p.year && p.year <= x.end).map((x) => x.polityId).sort();
      expect(exactAt, `${p.kind} point ${p.lon},${p.lat} in ${p.year}`).toEqual([...p.expected].sort());
      checked++;
    }
    expect(checked).toBe(tp.points.length);
  }, 120_000);
});
