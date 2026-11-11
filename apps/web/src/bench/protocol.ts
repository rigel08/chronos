/**
 * Benchmark protocol (docs/spikes/001-engine.md). Same steps, same years, same camera for both engines.
 *   1. sweep:   scrub 3400 BCE -> 2024 CE, one step per frame (frame intervals, long tasks)
 *   2. jumps:   a random year every frame (worst case for caches)
 *   3. latency: set a random year, wait until a frame showing it is fully rendered
 *   4. picks:   ground-truth points from the pipeline; the drawn polity at that pixel must match exactly
 */
import { yearLabel } from "../lib/years";
import type { Engine } from "./engines";
import { heapMB } from "./memory";
import { frameStats, summarize } from "./stats";

export interface TestPoint {
  year: number;
  lon: number;
  lat: number;
  kind: "inside" | "unmapped";
  expected: string[];
}

export interface Options {
  sweepStep: number;
  jumpFrames: number;
  latencySamples: number;
  pickLimit: number;
  pickZoom: number;
  seed: number;
  enduranceCycles: number;
  view: { center: [number, number]; zoom: number };
  onProgress?: (msg: string) => void;
}

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const frame = () => new Promise<number>((r) => requestAnimationFrame((ts) => r(ts)));

async function scrub(engine: Engine, years: number[]) {
  const longTasks: number[] = [];
  let obs: PerformanceObserver | null = null;
  try {
    obs = new PerformanceObserver((list) => list.getEntries().forEach((e) => longTasks.push(e.duration)));
    obs.observe({ type: "longtask", buffered: false });
  } catch { /* longtask not supported */ }
  const stamps: number[] = [];
  const cpu: number[] = [];
  let stale = 0;
  let run = 0;
  let maxRun = 0;
  for (const y of years) {
    stamps.push(await frame());
    // Was the frame just shown current for the previous request? Count frames drawn with stale data.
    if (stamps.length > 1) {
      if (engine.isCurrent()) run = 0;
      else { stale++; run++; maxRun = Math.max(maxRun, run); }
    }
    cpu.push(engine.setYear(y));
  }
  stamps.push(await frame());
  const tEnd = performance.now();
  await engine.settled();
  const catchUpMs = Math.round(performance.now() - tEnd);
  obs?.disconnect();
  return { frames: frameStats(stamps), setYearCpuMs: summarize(cpu), staleFrames: stale, staleShare: Math.round((stale / Math.max(1, years.length - 1)) * 10000) / 10000, maxConsecutiveStaleFrames: maxRun, longTasks: { count: longTasks.length, totalMs: Math.round(longTasks.reduce((a, b) => a + b, 0)) }, catchUpMs };
}

export async function runProtocol(engine: Engine, years: { min: number; max: number }, points: TestPoint[],
                                  polityIds: string[], opts: Options) {
  const say = opts.onProgress ?? (() => {});
  const r = rng(opts.seed);
  const map = engine.map;
  map.jumpTo({ center: opts.view.center, zoom: opts.view.zoom });
  await engine.settled();
  // warm-up
  for (let i = 0; i < 30; i++) { engine.setYear(years.min + Math.floor(r() * (years.max - years.min))); await frame(); }
  await engine.settled();

  say("sweep");
  const sweepYears: number[] = [];
  for (let y = years.min; y <= years.max; y += opts.sweepStep) sweepYears.push(y);
  const sweep = await scrub(engine, sweepYears);

  say("regional sweep");
  map.jumpTo({ center: [15, 48], zoom: 3.5 });
  await engine.settled();
  const regionYears: number[] = [];
  for (let y = 500; y <= years.max; y += 2) regionYears.push(y);
  const regional = await scrub(engine, regionYears);
  map.jumpTo({ center: opts.view.center, zoom: opts.view.zoom });
  await engine.settled();

  say("jumps");
  const jumpYears = Array.from({ length: opts.jumpFrames }, () => years.min + Math.floor(r() * (years.max - years.min + 1)));
  const jumps = await scrub(engine, jumpYears);

  say("latency");
  const lat: number[] = [];
  for (let i = 0; i < opts.latencySamples; i++) {
    const y = years.min + Math.floor(r() * (years.max - years.min + 1));
    await frame();
    const a = performance.now();
    engine.setYear(y);
    await engine.settled();
    lat.push(performance.now() - a);
  }

  say("picks");
  const index = new Map(polityIds.map((id, i) => [id, i]));
  const canvas = map.getCanvas();
  const cx = canvas.clientWidth / 2;
  const cy = canvas.clientHeight / 2;
  const results = { n: 0, correct: 0, wrong: 0, missed: 0, extra: 0, byKind: {} as Record<string, { n: number; correct: number }>, failures: [] as unknown[] };
  for (const p of points.slice(0, opts.pickLimit)) {
    map.jumpTo({ center: [p.lon, p.lat], zoom: opts.pickZoom });
    engine.setYear(p.year);
    await engine.settled();
    const got = engine.pick(cx, cy);
    const want = p.expected.map((id) => index.get(id)).filter((v): v is number => v !== undefined).sort((a, b) => a - b);
    // A pixel can show only what is drawn on top; with overlaps, any expected polity counts as correct.
    const ok = want.length === 0 ? got.length === 0 : got.length > 0 && got.every((g) => want.includes(g));
    results.n++;
    const k = (results.byKind[p.kind] ??= { n: 0, correct: 0 });
    k.n++;
    if (ok) { results.correct++; k.correct++; continue; }
    if (want.length && !got.length) results.missed++;
    else if (!want.length && got.length) results.extra++;
    else results.wrong++;
    if (results.failures.length < 25) results.failures.push({ year: yearLabel(p.year), lon: p.lon, lat: p.lat, want: p.expected, got: got.map((i) => polityIds[i]) });
  }
  // ---- milestone 1.2 additions (after the Spike 001 phases, so those stay comparable) ----
  say("explore");
  // Regional exploration: the camera moves between regions and zoom levels while time advances 1 year per frame.
  const waypoints: [number, number, number][] = [[30, 30, 1.4], [10, 48, 4], [105, 32, 4], [78, 22, 4.5], [-75, 10, 3], [20, 5, 3.5], [30, 30, 1.4]];
  const exploreStamps: number[] = [];
  let exploreStale = 0;
  let exploreYear = 600;
  for (let leg = 0; leg < waypoints.length - 1; leg++) {
    const [a, b] = [waypoints[leg] as [number, number, number], waypoints[leg + 1] as [number, number, number]];
    for (let f = 0; f < 120; f++) {
      const k = f / 120;
      map.jumpTo({ center: [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k], zoom: a[2] + (b[2] - a[2]) * k });
      engine.setYear(exploreYear++);
      exploreStamps.push(await frame());
      if (exploreStamps.length > 1 && !engine.isCurrent()) exploreStale++;
    }
  }
  const explore = { frames: frameStats(exploreStamps), staleShare: Math.round((exploreStale / Math.max(1, exploreStamps.length - 1)) * 10000) / 10000 };
  map.jumpTo({ center: opts.view.center, zoom: opts.view.zoom });
  await engine.settled();

  say("endurance");
  // Repeated timeline interaction: full sweeps back to back; heap (no forced GC) after each cycle shows growth.
  const cycles: { cycle: number; heapMB: number | null; p95: number; staleShare: number }[] = [];
  for (let c = 1; c <= opts.enduranceCycles; c++) {
    const res = await scrub(engine, sweepYears);
    cycles.push({ cycle: c, heapMB: heapMB(), p95: res.frames.p95, staleShare: res.staleShare });
  }

  return {
    explore, endurance: { cycles: opts.enduranceCycles, framesPerCycle: sweepYears.length, results: cycles },
    sweep: { years: sweepYears.length, step: opts.sweepStep, ...sweep },
    regionalSweep: { view: "Europe, zoom 3.5", years: regionYears.length, step: 2, from: 500, ...regional },
    jumps: { years: jumpYears.length, ...jumps },
    latencyMs: summarize(lat),
    picks: { ...results, accuracy: results.n ? Math.round((results.correct / results.n) * 10000) / 10000 : null },
  };
}
