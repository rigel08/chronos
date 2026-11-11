/** Main-thread side of the loading path: starts the worker and assembles the geometry views it hands over. */
import { assembleGeometry, type BundleMeta, type Geometry } from "../lib/bundle";
import type { LoadedPayload, LoaderMessage } from "./loader.worker";

export interface Loaded {
  meta: BundleMeta;
  geometry: Geometry;
  vertex: Pick<LoadedPayload, "startIndices" | "ovStartIndices" | "time" | "code" | "ovTime" | "ovCodes">;
  timings: Record<string, number>;
  transfer: LoadedPayload["transfer"];
}

export interface LoadCallbacks {
  onMeta?(meta: BundleMeta): void;
  onProgress?(loaded: number, total: number): void;
}

export const DATA_BASE = "/";

export function loadAtlas(cb: LoadCallbacks = {}): Promise<Loaded> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./loader.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (ev: MessageEvent<LoaderMessage>) => {
      const m = ev.data;
      if (m.type === "meta") cb.onMeta?.(m.meta);
      else if (m.type === "progress") cb.onProgress?.(m.loaded, m.total);
      else if (m.type === "error") { worker.terminate(); reject(new Error(m.message)); }
      else if (m.type === "ready") {
        worker.terminate();
        const p = m.payload;
        const t = performance.now();
        const geometry = assembleGeometry(p.meta, p.buffer, p.triangles, p.ovTriangles);
        resolve({ meta: p.meta, geometry, timings: { ...p.timings, assembleMs: performance.now() - t }, transfer: p.transfer,
                  vertex: { startIndices: p.startIndices, ovStartIndices: p.ovStartIndices, time: p.time, code: p.code,
                            ovTime: p.ovTime, ovCodes: p.ovCodes } });
      }
    };
    worker.onerror = (ev) => { worker.terminate(); reject(new Error(ev.message || "loader worker failed")); };
    worker.postMessage({ type: "load", base: DATA_BASE });
  });
}
