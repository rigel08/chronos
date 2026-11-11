/// <reference lib="webworker" />
/**
 * Loading path (D-024, D-025), off the main thread:
 *   bundle.json (revalidated) -> geometry.<hash>.bin (immutable; brotli or gzip on the wire, chosen by the server)
 *   -> sha256 check against bundle.json -> varint triangles decoded -> per-vertex attributes built -> transferred.
 * Progress is reported in decoded bytes against the size bundle.json declares, so it is real progress.
 */
import { type BundleMeta, meshTriangles, NO_OWNER, section } from "../lib/bundle";

export interface LoadedPayload {
  meta: BundleMeta;
  buffer: ArrayBuffer;
  triangles: Uint32Array;
  ovTriangles: Uint32Array;
  startIndices: Uint32Array;
  ovStartIndices: Uint32Array;
  time: Float32Array;        // [start, end] per territory vertex
  code: Float32Array;        // polity * 16 + palette index per territory vertex
  ovTime: Float32Array;      // [start, end] per overlap vertex
  ovCodes: Float32Array;     // four codes per overlap vertex, -1 padded
  timings: Record<string, number>;
  transfer: { encodedBytes: number | null; decodedBytes: number; sha256: "verified" | "unavailable" };
}

export type LoaderMessage =
  | { type: "meta"; meta: BundleMeta }
  | { type: "progress"; loaded: number; total: number }
  | { type: "ready"; payload: LoadedPayload }
  | { type: "error"; message: string };

const post = (m: LoaderMessage, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(m, transfer);

async function fetchWithProgress(url: string, total: number): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
  const out = new Uint8Array(total);
  const reader = res.body.getReader();
  let loaded = 0;
  let lastPost = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (loaded + value.length > total) throw new Error(`${url}: larger than the ${total} bytes bundle.json declares`);
    out.set(value, loaded);
    loaded += value.length;
    const now = performance.now();
    if (now - lastPost > 50) { post({ type: "progress", loaded, total }); lastPost = now; }
  }
  if (loaded !== total) throw new Error(`${url}: received ${loaded} of ${total} bytes`);
  post({ type: "progress", loaded, total });
  return out.buffer;
}

async function sha256Hex(buf: ArrayBuffer): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null;            // not a secure context: cannot verify here
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function load(base: string) {
  const t0 = performance.now();
  const meta = (await (await fetch(`${base}bundle.json`, { cache: "no-cache" })).json()) as BundleMeta;
  if (meta.format !== 3) throw new Error(`bundle format ${meta.format}; this app reads format 3`);
  post({ type: "meta", meta });
  const tMeta = performance.now();
  const file = meta.files.geometry;
  const url = `${base}${file.path}`;
  const buffer = await fetchWithProgress(url, file.bytes ?? meta.geometry.bytes);
  const tFetched = performance.now();
  const digest = await sha256Hex(buffer);
  if (digest !== null && digest !== file.sha256) throw new Error(`${file.path}: sha256 mismatch (expected ${file.sha256}, got ${digest})`);
  const tVerified = performance.now();
  const tri = meshTriangles(meta, buffer, "");
  const ov = meshTriangles(meta, buffer, "ov_");
  const tDecoded = performance.now();

  // Per-vertex attributes: [start, end] and polity code, from each part's territory.
  const ringStart = section<Uint32Array>(meta, buffer, "ring_start");
  const partRingStart = section<Uint32Array>(meta, buffer, "part_ring_start");
  const partTerritory = section<Uint32Array>(meta, buffer, "part_territory");
  const tStart = section<Int32Array>(meta, buffer, "territory_start");
  const tEnd = section<Int32Array>(meta, buffer, "territory_end");
  const tPolity = section<Uint32Array>(meta, buffer, "territory_polity");
  const vertices = meta.geometry.vertices;
  const time = new Float32Array(vertices * 2);
  const code = new Float32Array(vertices);
  const colourOf = meta.polities.map((p) => p.colour);
  for (let p = 0; p < partTerritory.length; p++) {
    const t = partTerritory[p] as number;
    const v0 = ringStart[partRingStart[p] as number] as number;
    const v1 = ringStart[partRingStart[p + 1] as number] as number;
    const s = tStart[t] as number, e = tEnd[t] as number;
    const pol = tPolity[t] as number;
    const c = pol * 16 + (colourOf[pol] ?? 0);
    for (let v = v0; v < v1; v++) { time[2 * v] = s; time[2 * v + 1] = e; code[v] = c; }
  }
  const ovRingStart = section<Uint32Array>(meta, buffer, "ov_ring_start");
  const ovPartRingStart = section<Uint32Array>(meta, buffer, "ov_part_ring_start");
  const ovPartRegion = section<Uint32Array>(meta, buffer, "ov_part_region");
  const rStart = section<Int32Array>(meta, buffer, "region_start");
  const rEnd = section<Int32Array>(meta, buffer, "region_end");
  const rTerr = section<Uint32Array>(meta, buffer, "region_territories");
  const slots = meta.overlaps.slots;
  const ovVertices = meta.geometry.overlap_vertices;
  const ovTime = new Float32Array(ovVertices * 2);
  const ovCodes = new Float32Array(ovVertices * 4).fill(-1);
  for (let p = 0; p < ovPartRegion.length; p++) {
    const r = ovPartRegion[p] as number;
    const v0 = ovRingStart[ovPartRingStart[p] as number] as number;
    const v1 = ovRingStart[ovPartRingStart[p + 1] as number] as number;
    const codes = [-1, -1, -1, -1];
    for (let k = 0; k < Math.min(4, slots); k++) {
      const t = rTerr[r * slots + k] as number;
      if (t === NO_OWNER) continue;
      const pol = tPolity[t] as number;
      codes[k] = pol * 16 + (colourOf[pol] ?? 0);
    }
    for (let v = v0; v < v1; v++) {
      ovTime[2 * v] = rStart[r] as number;
      ovTime[2 * v + 1] = rEnd[r] as number;
      ovCodes.set(codes, 4 * v);
    }
  }
  const tBuilt = performance.now();
  const entry = performance.getEntriesByName(new URL(url, self.location.href).href)[0] as PerformanceResourceTiming | undefined;
  const payload: LoadedPayload = {
    meta, buffer, triangles: tri.triangles, ovTriangles: ov.triangles, startIndices: tri.first, ovStartIndices: ov.first,
    time, code, ovTime, ovCodes,
    timings: { metaMs: tMeta - t0, fetchMs: tFetched - tMeta, verifyMs: tVerified - tFetched, decodeMs: tDecoded - tVerified,
               attributesMs: tBuilt - tDecoded, totalMs: tBuilt - t0 },
    transfer: { encodedBytes: entry?.encodedBodySize || null, decodedBytes: buffer.byteLength,
                sha256: digest === null ? "unavailable" : "verified" },
  };
  post({ type: "ready", payload }, [buffer, tri.triangles.buffer, ov.triangles.buffer, tri.first.buffer, ov.first.buffer,
                                     time.buffer, code.buffer, ovTime.buffer, ovCodes.buffer]);
}

self.onmessage = (ev: MessageEvent<{ type: "load"; base: string }>) => {
  if (ev.data?.type !== "load") return;
  load(ev.data.base).catch((err: unknown) => post({ type: "error", message: err instanceof Error ? err.message : String(err) }));
};
