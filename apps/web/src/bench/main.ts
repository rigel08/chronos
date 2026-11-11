/**
 * Engine benchmark harness (milestone 1.1). Not application UI: a status line, a year slider and a run button.
 * URL parameters: engine=deck|maplibre, run=1 (auto-run the protocol), picks=N, step=N.
 * Results are written to window.__BENCH__ and shown as JSON on the page.
 */
import "maplibre-gl/dist/maplibre-gl.css";

import { yearLabel } from "../lib/years";
import { type BundleMeta, decodeGeometry } from "./bundle";
import { createEngine, type EngineName, setLandUrl, VARIANT } from "./engines";
import { heapMB, probe } from "./memory";
import { runProtocol, type TestPoint } from "./protocol";

declare global {
  interface Window { __BENCH__?: unknown; __BENCH_ERROR__?: string }
}

const params = new URLSearchParams(location.search);
const engineName = (params.get("engine") === "maplibre" ? "maplibre" : "deck") as EngineName;
const status = document.getElementById("status") as HTMLElement;
const out = document.getElementById("out") as HTMLElement;
const slider = document.getElementById("year") as HTMLInputElement;
const yearText = document.getElementById("yeartext") as HTMLElement;
const num = (k: string, d: number) => (params.has(k) ? Number(params.get(k)) : d);
const VIEW = { center: [num("lon", 30), num("lat", 30)] as [number, number], zoom: num("zoom", 1.4) };
const START_YEAR = num("year", 117);

function webglRenderer(): string {
  const c = document.createElement("canvas");
  const gl = c.getContext("webgl2");
  if (!gl) return "no WebGL2";
  const ext = gl.getExtension("WEBGL_debug_renderer_info");
  return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
}

const PROBE = params.get("probe") === "1";

async function main() {
  const tNav = performance.now();
  if (PROBE) await probe("page start");
  status.textContent = `loading bundle (${engineName}) ...`;
  const meta = await fetch("/bundle.json").then((r) => r.json() as Promise<BundleMeta>);
  const [buf, tp] = await Promise.all([
    fetch(`/${meta.files.geometry.path}`).then((r) => r.arrayBuffer()),
    fetch("/testpoints.json").then((r) => r.json() as Promise<{ points: TestPoint[] }>),
  ]);
  setLandUrl(`/${meta.files.basemap_land.path}`);
  const tFetched = performance.now();
  const g = decodeGeometry(meta, buf);
  const tDecoded = performance.now();
  if (PROBE) await probe("bundle fetched and decoded");
  const engine = await createEngine(engineName, document.getElementById("map") as HTMLElement, g, START_YEAR, VIEW);
  const tReady = performance.now();
  (window as unknown as { __BENCH_MAP__?: unknown }).__BENCH_MAP__ = engine.map;     // tooling: bench/seams.mjs unprojects pixels
  // Stricter readiness: the first frame in which the engine can actually report a drawn territory at the
  // screen centre (30 E, 30 N is Roman Egypt in 117 CE). "Ready" signals alone can precede real geometry.
  let firstPickMs: number | null = null;
  if (START_YEAR === 117) {
    const canvas = engine.map.getCanvas();
    for (let i = 0; i < 1800; i++) {
      if (engine.pick(canvas.clientWidth / 2, canvas.clientHeight / 2).length) { firstPickMs = Math.round(performance.now() - tNav); break; }
      await new Promise((r) => requestAnimationFrame(r));
    }
  }
  if (PROBE) await probe("first correct pick");
  const load = {
    fetchMs: Math.round(tFetched - tNav), decodeMs: Math.round(tDecoded - tFetched),
    engineDataReadyMs: engine.dataReadyMs, timeToInteractiveMs: Math.round(tReady - tNav), timeToFirstCorrectPickMs: firstPickMs,
  };
  status.textContent = `${engineName} ready in ${load.timeToInteractiveMs} ms · ${meta.geometry.territories.toLocaleString()} territories, ` +
    `${meta.geometry.parts.toLocaleString()} parts, ${meta.geometry.vertices.toLocaleString()} vertices · ${meta.release_id}`;

  slider.min = String(meta.years.min);
  slider.max = String(meta.years.max);
  slider.value = String(START_YEAR);
  const show = () => { const t = Number(slider.value); engine.setYear(t); yearText.textContent = yearLabel(t); };
  slider.addEventListener("input", show);
  show();

  const run = async () => {
    status.textContent = `${engineName}: running protocol ...`;
    const res = await runProtocol(engine, meta.years, tp.points, meta.polities.map((p) => p.id), {
      sweepStep: Number(params.get("step") ?? 5), jumpFrames: 300, latencySamples: 40,
      pickLimit: Number(params.get("picks") ?? 10000), pickZoom: 3, seed: 20261111, view: VIEW,
      enduranceCycles: Number(params.get("cycles") ?? 5),
      onProgress: (m) => { status.textContent = `${engineName}: ${m} ...`; },
    });
    const heapNoGc = heapMB();
    const afterGc = PROBE ? await probe("after protocol") : null;
    const result = {
      engine: engineName, variant: engineName === "deck" ? VARIANT : null, release: meta.release_id, load, ...res,
      jsHeapMB: heapNoGc === null ? null : Math.round(heapNoGc),
      jsHeapAfterGcMB: afterGc ? afterGc.usedMB : null,
      memoryStages: window.__MEM__ ?? [],
      env: { renderer: webglRenderer(), userAgent: navigator.userAgent, dpr: devicePixelRatio,
             viewport: [innerWidth, innerHeight], hardwareConcurrency: navigator.hardwareConcurrency },
      geometry: { territories: meta.geometry.territories, parts: meta.geometry.parts, vertices: meta.geometry.vertices },
    };
    window.__BENCH__ = result;
    out.textContent = JSON.stringify(result, null, 1);
    status.textContent = `${engineName}: done`;
    engine.map.jumpTo(VIEW);
    show();
  };
  (document.getElementById("run") as HTMLButtonElement).addEventListener("click", () => void run());
  if (params.get("mode") === "load") {
    const heapNoGc = heapMB();
    window.__BENCH__ = { engine: engineName, release: meta.release_id, load, jsHeapMB: heapNoGc === null ? null : Math.round(heapNoGc),
                         memoryStages: window.__MEM__ ?? [],
                         env: { renderer: webglRenderer(), dpr: devicePixelRatio, viewport: [innerWidth, innerHeight] } };
    out.textContent = JSON.stringify(window.__BENCH__, null, 1);
  } else if (params.get("run") === "1") await run();
}

main().catch((e: unknown) => {
  window.__BENCH_ERROR__ = String(e instanceof Error ? e.stack ?? e.message : e);
  status.textContent = `error: ${window.__BENCH_ERROR__}`;
});
