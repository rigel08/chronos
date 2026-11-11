import { describe, expect, it } from "vitest";

import { formatHash, parseHash } from "../src/lib/url";
import { parseYearInput, spanLabel, ticks, yearLabel, yearParts } from "../src/lib/years";

describe("year labels and spans", () => {
  it("never shows a year 0, and steps across 1 BCE / 1 CE by one year", () => {
    expect(yearLabel(0)).toBe("1 BCE");
    expect(yearLabel(0 + 1)).toBe("1 CE");
    expect(yearLabel(-499)).toBe("500 BCE");
    expect(yearParts(-26)).toEqual({ num: "27", era: "BCE" });
  });
  it("writes the era once when both ends share it", () => {
    expect(spanLabel(750, 969)).toBe("750–969 CE");
    expect(spanLabel(-749, -550)).toBe("750–551 BCE");
    expect(spanLabel(-26, 476)).toBe("27 BCE – 476 CE");
    expect(spanLabel(117, 117)).toBe("117 CE");
  });
});

describe("timeline ticks", () => {
  it("fall on round historical years on both sides of the era boundary, never on year 0", () => {
    const tk = ticks(-300, 300, 1200, 60);
    const labels = tk.map((t) => t.label);
    expect(labels).toContain("100 BCE");
    expect(labels).toContain("100 CE");
    expect(labels.some((l) => l.startsWith("0 "))).toBe(false);
    for (const t of tk) expect(t.label).toBe(yearLabel(t.year));
    const bce100 = tk.find((t) => t.label === "100 BCE");
    expect(bce100?.year).toBe(-99);
  });
  it("adapt their step to the zoom: millennia for the whole range, single years for a decade", () => {
    const wide = ticks(-3399, 2024, 1400);
    expect(wide.length).toBeGreaterThan(3);
    expect(wide.length).toBeLessThan(25);
    const narrow = ticks(1500, 1510, 1400);
    expect(narrow.map((t) => t.year)).toEqual([1500, 1501, 1502, 1503, 1504, 1505, 1506, 1507, 1508, 1509, 1510]);
  });
  it("keep a minimum spacing in pixels", () => {
    for (const [a, b, w] of [[-3399, 2024, 900], [-600, 900, 1300], [100, 140, 800]] as const) {
      const tk = ticks(a, b, w);
      const xs = tk.map((t) => ((t.year - a) / (b - a)) * w);
      for (let i = 1; i < xs.length; i++) expect((xs[i] as number) - (xs[i - 1] as number)).toBeGreaterThanOrEqual(60);
    }
  });
});

describe("go-to-year input", () => {
  it("reads BCE/CE and plain astronomical numbers", () => {
    expect(parseYearInput("500 BCE")).toBe(-499);
    expect(parseYearInput("500 bc")).toBe(-499);
    expect(parseYearInput("1066")).toBe(1066);
    expect(parseYearInput("1066 CE")).toBe(1066);
    expect(parseYearInput("AD 1066")).toBeNull();
    expect(parseYearInput("0 BCE")).toBeNull();
    expect(parseYearInput("-499")).toBe(-499);
  });
});

describe("URL state", () => {
  it("round-trips a view", () => {
    const v = { t: -499, center: [12.5, 41.9] as [number, number], zoom: 4.25, polity: "kingdom-of-italy@887", sample: [12.4964, 41.9028] as [number, number], projection: "flat" as const };
    const back = parseHash(formatHash(v));
    expect(back.t).toBe(-499);
    expect(back.center?.[0]).toBeCloseTo(12.5, 3);
    expect(back.zoom).toBeCloseTo(4.25, 2);
    expect(back.polity).toBe("kingdom-of-italy@887");
    expect(back.sample).toEqual([12.4964, 41.9028]);
    expect(back.projection).toBe("flat");
  });
  it("ignores malformed parts instead of guessing", () => {
    expect(parseHash("#t=12.5&c=1,2&p=<script>&s=200,0")).toEqual({});
  });
});
