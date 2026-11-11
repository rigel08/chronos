/** Astronomical years (0 = 1 BCE, -1 = 2 BCE), matching the pipeline (D-003). The only BCE/CE conversion. */
export function yearLabel(y: number): string {
  return y <= 0 ? `${1 - y} BCE` : `${y} CE`;
}

/** Number and era separately, for typography that sets them in different weights. */
export function yearParts(y: number): { num: string; era: "BCE" | "CE" } {
  return y <= 0 ? { num: String(1 - y), era: "BCE" } : { num: String(y), era: "CE" };
}

/** A span such as "27 BCE – 476 CE" or "750–969 CE" (the era is written once when both ends share it). */
export function spanLabel(a: number, b: number): string {
  if (a === b) return yearLabel(a);
  const pa = yearParts(a);
  const pb = yearParts(b);
  return pa.era === pb.era ? `${pa.num}–${pb.num} ${pb.era}` : `${yearLabel(a)} – ${yearLabel(b)}`;
}

/** Inclusive length of a span in years. Astronomical numbering has a year 0, so plain subtraction is right. */
export function spanYears(a: number, b: number): number {
  return b - a + 1;
}

/** Is a territory valid in year `t`? Bounds are inclusive astronomical years. */
export function aliveAt(start: number, end: number, t: number): boolean {
  return start <= t && t <= end;
}

/**
 * deck.gl DataFilterExtension range for "start <= t <= end" with filter values [start, end].
 * Integer years are encoded exactly in float32, so +/-0.5 margins make the test exact without
 * ever admitting a neighbouring year. (Used by the 1.2 benchmark harness; the app uses StrataExtension.)
 */
export function yearFilterRange(t: number): [[number, number], [number, number]] {
  return [[-1e7, t + 0.5], [t - 0.5, 1e7]];
}

export function clampYear(t: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(t)));
}

/** Historical round-number tick steps, in years. */
const STEPS = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];

export interface Tick { year: number; label: string; major: boolean }

/**
 * Ticks for the window [a, b] drawn `px` wide, at least `minGap` px apart. Ticks fall on round *historical*
 * years (… 200 BCE, 100 BCE, 100 CE, 200 CE …), never on a "year 0" that does not exist: in astronomical
 * numbering k BCE is 1 - k. The gap between 100 BCE and 100 CE is therefore 199 years, as it was.
 */
export function ticks(a: number, b: number, px: number, minGap = 72): Tick[] {
  const span = Math.max(1, b - a);
  const step = STEPS.find((s) => (s / span) * px >= minGap) ?? 1000 * Math.ceil((span * minGap) / px / 1000);
  const major = step >= 1000 ? step * 5 : STEPS.find((s) => s >= step * 5) ?? step * 5;
  const out: Tick[] = [];
  const firstCE = Math.max(step, Math.ceil(a / step) * step);
  for (let y = firstCE; y <= b; y += step) out.push({ year: y, label: yearLabel(y), major: y % major === 0 });
  // BCE: k BCE = 1 - k for k = step, 2*step, ... within [a, b]
  const kMin = Math.max(step, Math.ceil((1 - b) / step) * step);
  for (let k = kMin; 1 - k >= a; k += step) out.push({ year: 1 - k, label: `${k} BCE`, major: k % major === 0 });
  return out.sort((x, y) => x.year - y.year);
}

/** Playback speeds in years per second. Deep time moves faster; recent centuries slower (architecture §5). */
export const SPEEDS = [1, 5, 10, 25, 50, 100] as const;

export function defaultSpeed(t: number): number {
  return t < -1000 ? 50 : t < 1500 ? 25 : 5;
}

/** "500 BCE", "500 bc", "1066", "1066 CE", "-499" (astronomical) -> astronomical year, or null. */
export function parseYearInput(s: string): number | null {
  const m = s.trim().match(/^(-?\d{1,5})\s*(bce|bc|b\.c\.e?\.?|ce|ad|a\.d\.)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const era = (m[2] ?? "").toLowerCase().replace(/\./g, "");
  if (era.startsWith("b")) return n >= 1 ? 1 - n : null;
  return n;
}
