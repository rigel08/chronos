/** Frame-time and latency statistics for the benchmark. */
export interface Summary {
  n: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] as number;
  const b = sorted[hi] as number;
  return a + (b - a) * (pos - lo);
}

export function summarize(values: number[]): Summary {
  const s = [...values].sort((x, y) => x - y);
  const mean = s.reduce((acc, v) => acc + v, 0) / (s.length || 1);
  const r = (v: number) => Math.round(v * 100) / 100;
  return { n: s.length, mean: r(mean), p50: r(quantile(s, 0.5)), p95: r(quantile(s, 0.95)), p99: r(quantile(s, 0.99)), max: r(s.at(-1) ?? Number.NaN) };
}

/** Frame intervals from rAF timestamps, plus the share of frames slower than a budget. */
export function frameStats(timestamps: number[], budgetMs = 33.4): Summary & { jankShare: number; fps: number } {
  const intervals: number[] = [];
  for (let i = 1; i < timestamps.length; i++) intervals.push((timestamps[i] as number) - (timestamps[i - 1] as number));
  const s = summarize(intervals);
  const total = (timestamps.at(-1) ?? 0) - (timestamps[0] ?? 0);
  return {
    ...s,
    jankShare: Math.round((intervals.filter((v) => v > budgetMs).length / (intervals.length || 1)) * 10000) / 10000,
    fps: total > 0 ? Math.round((intervals.length / total) * 100000) / 100 : 0,
  };
}
