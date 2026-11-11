/**
 * "Who is mapped here?": the core sample of one point, in the browser (milestone 1.3).
 *
 * Same semantics as the pipeline's PointIndex (pipeline/src/chronos_pipeline/core_sample.py), so the two
 * can be compared exactly (Rome, QA-010):
 *   - a row is an exact hit if its polygon covers the point, a near hit if it lies within `toleranceKm`;
 *   - hits are ordered by (start, end, source row) and consecutive rows of one polity merge into a stratum
 *     when they abut (next start - previous end <= 1);
 *   - gaps are year ranges no stratum covers between the first and the last; overlaps are pairs of strata
 *     that share years.
 * Geometry: the bundle's float32 render parts (full resolution, split on the 5° grid). Distances use a local
 * WGS84 tangent plane centred on the point (accurate to well under 0.1% within 5 km).
 */
import { type BundleMeta, type Geometry, partVertices } from "./bundle";

export interface Stratum {
  polity: number;
  polityId: string;
  name: string;
  start: number;
  end: number;
  exact: boolean;
  distanceKm: number;
  rows: number[];            // Cliopatria row indices (locators)
  territories: number[];     // bundle territory indices
}

export interface CoreSample {
  lon: number;
  lat: number;
  toleranceKm: number;
  strata: Stratum[];
  gaps: [number, number][];
  overlaps: [string, string, number, number][];
  ms: number;
}

export interface SampleIndex {
  cell: number;
  cells: Map<number, number[]>;
  box: Float32Array;          // minLon, minLat, maxLon, maxLat per part
}

const key = (cx: number, cy: number) => cx * 1000 + cy;

/** Part bounding boxes and a coarse grid over them (built once, about 3.6 MB for 229k parts). */
export function buildIndex(g: Geometry, cell = 2): SampleIndex {
  const m = g.territories;
  const parts = m.partOwner.length;
  const box = new Float32Array(parts * 4);
  const cells = new Map<number, number[]>();
  for (let p = 0; p < parts; p++) {
    const [v0, v1] = partVertices(m, p);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let v = v0; v < v1; v++) {
      const x = m.positions[2 * v] as number;
      const y = m.positions[2 * v + 1] as number;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    box.set([x0, y0, x1, y1], p * 4);
    for (let cx = Math.floor((x0 + 180) / cell); cx <= Math.floor((x1 + 180) / cell); cx++) {
      for (let cy = Math.floor((y0 + 90) / cell); cy <= Math.floor((y1 + 90) / cell); cy++) {
        const k = key(cx, cy);
        const list = cells.get(k);
        if (list) list.push(p);
        else cells.set(k, [p]);
      }
    }
  }
  return { cell, cells, box };
}

function inPart(g: Geometry, p: number, lon: number, lat: number): boolean {
  const m = g.territories;
  let inside = false;
  for (let r = m.partRingStart[p] as number; r < (m.partRingStart[p + 1] as number); r++) {
    const a = m.ringStart[r] as number;
    const b = m.ringStart[r + 1] as number;
    for (let i = a, j = b - 1; i < b; j = i++) {
      const xi = m.positions[2 * i] as number, yi = m.positions[2 * i + 1] as number;
      const xj = m.positions[2 * j] as number, yj = m.positions[2 * j + 1] as number;
      if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

// WGS84 local scale (metres per radian) at latitude phi: prime vertical N (east) and meridional M (north).
const A = 6378137;
const E2 = 0.00669437999014;
function scales(lat: number): [number, number] {
  const s = Math.sin((lat * Math.PI) / 180);
  const w = 1 - E2 * s * s;
  const n = A / Math.sqrt(w);
  return [n * Math.cos((lat * Math.PI) / 180), (A * (1 - E2)) / (w * Math.sqrt(w))];
}

function partDistanceKm(g: Geometry, p: number, lon: number, lat: number, kx: number, ky: number): number {
  const m = g.territories;
  const d2r = Math.PI / 180;
  let best = Infinity;
  const px = (v: number) => {
    let dl = (m.positions[2 * v] as number) - lon;
    if (dl > 180) dl -= 360;
    else if (dl < -180) dl += 360;
    return dl * d2r * kx;
  };
  const py = (v: number) => ((m.positions[2 * v + 1] as number) - lat) * d2r * ky;
  for (let r = m.partRingStart[p] as number; r < (m.partRingStart[p + 1] as number); r++) {
    const a = m.ringStart[r] as number;
    const b = m.ringStart[r + 1] as number;
    for (let i = a; i < b - 1; i++) {
      const x1 = px(i), y1 = py(i), x2 = px(i + 1), y2 = py(i + 1);
      const dx = x2 - x1, dy = y2 - y1;
      const len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? Math.max(0, Math.min(1, -(x1 * dx + y1 * dy) / len2)) : 0;
      const ex = x1 + t * dx, ey = y1 + t * dy;
      const d = ex * ex + ey * ey;
      if (d < best) best = d;
    }
  }
  return Math.sqrt(best) / 1000;
}

export function sample(g: Geometry, meta: BundleMeta, index: SampleIndex, lon: number, lat: number, toleranceKm = 5): CoreSample {
  const t0 = performance.now();
  const pad = toleranceKm / 111.32 / Math.max(0.05, Math.abs(Math.cos((lat * Math.PI) / 180))) + 0.01;
  const [kx, ky] = scales(lat);
  const seen = new Set<number>();
  const hit = new Map<number, { exact: boolean; d: number }>();       // territory -> best hit
  const c = index.cell;
  for (let cx = Math.floor((lon - pad + 180) / c); cx <= Math.floor((lon + pad + 180) / c); cx++) {
    for (let cy = Math.floor((lat - pad + 90) / c); cy <= Math.floor((lat + pad + 90) / c); cy++) {
      for (const p of index.cells.get(key(cx, cy)) ?? []) {
        if (seen.has(p)) continue;
        seen.add(p);
        const b = index.box;
        if ((b[p * 4] as number) > lon + pad || (b[p * 4 + 2] as number) < lon - pad ||
            (b[p * 4 + 1] as number) > lat + pad || (b[p * 4 + 3] as number) < lat - pad) continue;
        const t = g.territories.partOwner[p] as number;
        const prev = hit.get(t);
        if (prev?.exact) continue;
        if (inPart(g, p, lon, lat)) { hit.set(t, { exact: true, d: 0 }); continue; }
        const d = partDistanceKm(g, p, lon, lat, kx, ky);
        if (!prev || d < prev.d) hit.set(t, { exact: false, d });
      }
    }
  }
  const hits = [...hit.entries()]
    .filter(([, h]) => h.exact || h.d <= toleranceKm)
    .map(([t, h]) => ({ t, exact: h.exact, d: h.exact ? 0 : Math.round(h.d * 100) / 100 }))
    .sort((x, y) => (g.territoryStart[x.t] as number) - (g.territoryStart[y.t] as number)
      || (g.territoryEnd[x.t] as number) - (g.territoryEnd[y.t] as number)
      || (g.territoryRow[x.t] as number) - (g.territoryRow[y.t] as number));
  const strata: Stratum[] = [];
  for (const h of hits) {
    const polity = g.territoryPolity[h.t] as number;
    const start = g.territoryStart[h.t] as number;
    const end = g.territoryEnd[h.t] as number;
    let s: Stratum | undefined;
    for (let i = strata.length - 1; i >= 0; i--) {
      const x = strata[i] as Stratum;
      if (x.polity === polity && start - x.end <= 1) { s = x; break; }
    }
    if (s) {
      s.end = Math.max(s.end, end);
      s.exact = s.exact || h.exact;
      s.distanceKm = s.exact ? 0 : Math.min(s.distanceKm, h.d);
      s.rows.push(g.territoryRow[h.t] as number);
      s.territories.push(h.t);
    } else {
      const pm = meta.polities[polity];
      strata.push({ polity, polityId: pm?.id ?? String(polity), name: pm?.name ?? "?", start, end, exact: h.exact,
                    distanceKm: h.d, rows: [g.territoryRow[h.t] as number], territories: [h.t] });
    }
  }
  const gaps: [number, number][] = [];
  if (strata.length) {
    const ordered = [...strata].sort((a, b) => a.start - b.start || a.end - b.end);
    let hi = (ordered[0] as Stratum).end;
    for (const s of ordered.slice(1)) {
      if (s.start > hi + 1) gaps.push([hi + 1, s.start - 1]);
      hi = Math.max(hi, s.end);
    }
  }
  const overlaps: [string, string, number, number][] = [];
  strata.forEach((a, i) => {
    for (const b of strata.slice(i + 1)) {
      if (b.start <= a.end && b.end >= a.start) overlaps.push([a.polityId, b.polityId, Math.max(a.start, b.start), Math.min(a.end, b.end)]);
    }
  });
  return { lon, lat, toleranceKm, strata, gaps, overlaps, ms: performance.now() - t0 };
}
