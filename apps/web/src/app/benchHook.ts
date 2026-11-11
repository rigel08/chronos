/**
 * Runs the 1.2 benchmark protocol (src/bench/protocol.ts) against the real application: React UI, Strata
 * stage, StrataExtension, overlap stripes. Loaded only with ?bench=1; results go to window.__BENCH__ exactly as
 * the benchmark page reports them, so bench/run.mjs treats the app as one more engine ("app").
 */
import type { AtlasEngine } from "../atlas/engine";
import type { Engine } from "../bench/engines";
import { heapMB, probe } from "../bench/memory";
import { runProtocol, type TestPoint } from "../bench/protocol";
import type { BundleMeta } from "../lib/bundle";

declare global {
  interface Window { __BENCH__?: unknown; __BENCH_ERROR__?: string }
}

function webglRenderer(): string {
  const gl = document.createElement("canvas").getContext("webgl2");
  if (!gl) return "no WebGL2";
  const ext = gl.getExtension("WEBGL_debug_renderer_info");
  return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
}

export async function runBench(engine: AtlasEngine, meta: BundleMeta, _tNav: number) {
  const params = new URLSearchParams(location.search);
  try {
    const app = window.__CHRONOS__;
    const load = { ...(app?.timings ?? {}), timeToFirstCorrectPickMs: app?.readyMs ?? null, engineDataReadyMs: engine.dataReadyMs,
                   timeToInteractiveMs: app?.readyMs ?? null };
    if (params.get("run") !== "1") {
      window.__BENCH__ = { engine: "app", release: meta.release_id, load, jsHeapMB: heapMB(), env: { renderer: webglRenderer() } };
      return;
    }
    const tp = (await (await fetch("/testpoints.json")).json()) as { points: TestPoint[] };
    const c = engine.map.getCenter();
    const res = await runProtocol(engine as unknown as Engine, meta.years, tp.points, meta.polities.map((p) => p.id), {
      sweepStep: Number(params.get("step") ?? 5), jumpFrames: 300, latencySamples: 40,
      pickLimit: Number(params.get("picks") ?? 10000), pickZoom: 3, seed: 20261111,
      view: { center: [c.lng, c.lat], zoom: engine.map.getZoom() },
      enduranceCycles: Number(params.get("cycles") ?? 5),
    });
    const heapNoGc = heapMB();
    const afterGc = params.get("probe") === "1" ? await probe("after protocol") : null;
    window.__BENCH__ = {
      engine: "app", variant: "strata", release: meta.release_id, load, ...res,
      jsHeapMB: heapNoGc === null ? null : Math.round(heapNoGc), jsHeapAfterGcMB: afterGc ? afterGc.usedMB : null,
      env: { renderer: webglRenderer(), userAgent: navigator.userAgent, dpr: devicePixelRatio, viewport: [innerWidth, innerHeight],
             hardwareConcurrency: navigator.hardwareConcurrency },
      geometry: { territories: meta.geometry.territories, parts: meta.geometry.parts, vertices: meta.geometry.vertices,
                  overlapRegions: meta.geometry.overlap_regions },
    };
  } catch (e) {
    window.__BENCH_ERROR__ = String(e instanceof Error ? e.stack ?? e.message : e);
  }
}
