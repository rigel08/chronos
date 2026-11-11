/** Application state: small external stores, plus the loaded data and what is derived from it once. */
import type { Loaded } from "../atlas/loader";
import type { AtlasEngine, Projection } from "../atlas/engine";
import type { BundleMeta, Geometry } from "../lib/bundle";
import type { CoreSample, SampleIndex } from "../lib/coreSample";
import { createStore } from "../lib/store";
import { parseHash } from "../lib/url";
import { defaultSpeed } from "../lib/years";

const initial = parseHash(location.hash);
export const DEFAULT_YEAR = 117;

export const timeStore = createStore({
  t: initial.t ?? DEFAULT_YEAR,
  playing: false,
  speed: defaultSpeed(initial.t ?? DEFAULT_YEAR),
  /** Detail window of the timeline, astronomical years. */
  window: [-600, 900] as [number, number],
});

export const selectionStore = createStore({
  polity: -1,
  hover: null as { x: number; y: number; polities: number[] } | null,
});

export const sampleStore = createStore({
  at: (initial.sample ?? null) as [number, number] | null,
  result: null as CoreSample | null,
});

export type Phase = "starting" | "meta" | "loading" | "uploading" | "ready" | "error";

export const uiStore = createStore({
  phase: "starting" as Phase,
  loaded: 0,
  total: 0,
  error: "",
  projection: (initial.projection ?? "globe") as Projection,
  panel: "none" as "none" | "polity" | "sample",
  credits: false,
  reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
  readyMs: 0,
  territories: 0,
  years: [0, 0] as [number, number],
});

export const initialView = {
  center: initial.center ?? ([30, 32] as [number, number]),
  zoom: initial.zoom ?? 1.55,
  polityId: initial.polity ?? null,
};

/** Everything loaded once, plus derived lookups. Filled by App before the UI shows data. */
export interface AppData {
  meta: BundleMeta;
  g: Geometry;
  loaded: Loaded;
  engine: AtlasEngine;
  polityIndex: Map<string, number>;
  /** Territories of each polity, sorted by start year. */
  territoriesOf: number[][];
  /** Mapped polities per year (index t - years.min): the record-density series for the timeline. */
  mappedPerYear: Uint16Array;
  sampleIndex: SampleIndex | null;
}

let data: AppData | null = null;
export const setAppData = (d: AppData) => { data = d; };
export const appData = (): AppData | null => data;

export function deriveIndices(meta: BundleMeta, g: Geometry) {
  const polityIndex = new Map(meta.polities.map((p, i) => [p.id, i]));
  const territoriesOf: number[][] = meta.polities.map(() => []);
  for (let t = 0; t < g.territoryStart.length; t++) territoriesOf[g.territoryPolity[t] as number]?.push(t);
  for (const list of territoriesOf) list.sort((a, b) => (g.territoryStart[a] as number) - (g.territoryStart[b] as number));
  const { min, max } = meta.years;
  const diff = new Int32Array(max - min + 2);
  for (let t = 0; t < g.territoryStart.length; t++) {
    const a = (g.territoryStart[t] as number) - min;
    const b = (g.territoryEnd[t] as number) - min + 1;
    diff[a] = (diff[a] as number) + 1;
    diff[b] = (diff[b] as number) - 1;
  }
  const mappedPerYear = new Uint16Array(max - min + 1);
  let run = 0;
  for (let i = 0; i < mappedPerYear.length; i++) { run += diff[i] as number; mappedPerYear[i] = run; }
  return { polityIndex, territoriesOf, mappedPerYear };
}

/** The polity's row valid at t, if any. */
export function rowAt(d: AppData, polity: number, t: number): number | null {
  for (const r of d.territoriesOf[polity] ?? []) {
    if ((d.g.territoryStart[r] as number) <= t && t <= (d.g.territoryEnd[r] as number)) return r;
  }
  return null;
}

/** QA-011 coverage sample nearest to t (samples are every `step_years`; the sample year is always shown). */
export function coverageNear(meta: BundleMeta, t: number): { year: number; share: number; polities: number } | null {
  let best: [number, number, number] | null = null;
  for (const s of meta.coverage.samples) if (!best || Math.abs(s[0] - t) < Math.abs(best[0] - t)) best = s;
  return best ? { year: best[0], share: best[1], polities: best[2] } : null;
}

/** Overlap regions valid at t that involve one of the given territories. */
export function regionsAt(d: AppData, territories: Set<number>, t: number) {
  const g = d.g;
  const out: { region: number; territories: number[]; km2: number; kind: string }[] = [];
  const kinds = Object.fromEntries(Object.entries(d.meta.overlaps.kind_codes).map(([k, v]) => [v, k]));
  for (let r = 0; r < g.regionStart.length; r++) {
    if ((g.regionStart[r] as number) > t || (g.regionEnd[r] as number) < t) continue;
    const ts: number[] = [];
    for (let k = 0; k < g.regionSlots; k++) {
      const x = g.regionTerritories[r * g.regionSlots + k] as number;
      if (x !== 0xffffffff) ts.push(x);
    }
    if (ts.some((x) => territories.has(x))) out.push({ region: r, territories: ts, km2: g.regionArea[r] as number, kind: kinds[g.regionKind[r] as number] ?? "?" });
  }
  return out.sort((a, b) => b.km2 - a.km2);
}
