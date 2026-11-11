/**
 * Memory probes for the benchmark (milestone 1.2).
 *
 * `performance.memory.usedJSHeapSize` is the metric Spike 001 reported. It counts V8 on-heap objects; the
 * backing stores of ArrayBuffers (typed arrays) are external to it, so the profiler runner also records
 * CDP Runtime.getHeapUsage().backingStorageSize and process footprints. Never report the heap alone when
 * data has been moved into typed arrays.
 *
 * With Chrome started with --js-flags=--expose-gc, each probe forces two full collections first, so the
 * number is retained memory rather than retained-plus-garbage.
 */
export interface MemoryStage {
  label: string;
  usedMB: number;
  totalMB: number;
  gc: boolean;
  t: number;
}

declare global {
  interface Window { __MEM__?: MemoryStage[]; gc?: () => void }
}

const mb = (b: number) => Math.round((b / 1048576) * 10) / 10;

export function heapMB(): number | null {
  const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return m ? mb(m.usedJSHeapSize) : null;
}

export async function probe(label: string): Promise<MemoryStage | null> {
  const m = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory;
  if (!m) return null;
  const gc = typeof window.gc === "function";
  if (gc) {
    window.gc?.();
    await new Promise((r) => setTimeout(r, 0));
    window.gc?.();
  }
  const stage = { label, usedMB: mb(m.usedJSHeapSize), totalMB: mb(m.totalJSHeapSize), gc, t: Math.round(performance.now()) };
  (window.__MEM__ ??= []).push(stage);
  return stage;
}
