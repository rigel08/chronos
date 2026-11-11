/** Astronomical years (0 = 1 BCE, -1 = 2 BCE), matching the pipeline (D-003). */
export function yearLabel(y: number): string {
  return y <= 0 ? `${1 - y} BCE` : `${y} CE`;
}

/** Is a territory valid in year `t`? Bounds are inclusive astronomical years. */
export function aliveAt(start: number, end: number, t: number): boolean {
  return start <= t && t <= end;
}

/**
 * deck.gl DataFilterExtension range for "start <= t <= end" with filter values [start, end].
 * Integer years are encoded exactly in float32, so +/-0.5 margins make the test exact without
 * ever admitting a neighbouring year.
 */
export function yearFilterRange(t: number): [[number, number], [number, number]] {
  return [[-1e7, t + 0.5], [t - 0.5, 1e7]];
}
