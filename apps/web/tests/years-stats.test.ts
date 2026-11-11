import { describe, expect, it } from "vitest";

import { aliveAt, yearFilterRange, yearLabel } from "../src/lib/years";
import { frameStats, quantile, summarize } from "../src/bench/stats";

describe("years (astronomical, D-003)", () => {
  it("labels year 0 as 1 BCE and negatives as n+1 BCE", () => {
    expect(yearLabel(0)).toBe("1 BCE");
    expect(yearLabel(-30)).toBe("31 BCE");
    expect(yearLabel(117)).toBe("117 CE");
  });
  it("treats bounds as inclusive", () => {
    expect(aliveAt(-26, 394, -26)).toBe(true);
    expect(aliveAt(-26, 394, 394)).toBe(true);
    expect(aliveAt(-26, 394, 395)).toBe(false);
  });
  it("GPU filter range admits exactly the inclusive interval for every integer year", () => {
    // emulate DataFilterExtension: value v passes range [lo, hi] if lo <= v <= hi (float32)
    const f32 = (x: number) => Math.fround(x);
    for (const [s, e] of [[-3399, -3000], [-26, 394], [1, 1], [2024, 2024]] as const) {
      for (let t = s - 3; t <= e + 3; t++) {
        const [[lo0, hi0], [lo1, hi1]] = yearFilterRange(t);
        const pass = f32(lo0) <= f32(s) && f32(s) <= f32(hi0) && f32(lo1) <= f32(e) && f32(e) <= f32(hi1);
        expect(pass).toBe(aliveAt(s, e, t));
      }
    }
  });
});

describe("stats", () => {
  it("quantiles interpolate", () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(summarize([5, 1, 3]).p50).toBe(3);
  });
  it("frame stats from timestamps", () => {
    const ts = [0, 16.7, 33.4, 50.1, 100.1];
    const s = frameStats(ts);
    expect(s.n).toBe(4);
    expect(s.max).toBe(50);
    expect(s.jankShare).toBe(0.25);
  });
});
