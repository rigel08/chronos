import { useEffect, useRef } from "react";

import { AtlasEngine } from "../atlas/engine";
import { loadAtlas } from "../atlas/loader";
import type { BundleMeta } from "../lib/bundle";
import { useStore } from "../lib/store";
import { formatHash, parseHash } from "../lib/url";
import { clampYear } from "../lib/years";
import { runSample, setYear, transitionNext } from "./actions";
import { Credits } from "./components/Credits";
import { Header } from "./components/Header";
import { HoverTip } from "./components/HoverTip";
import { LoadingVeil } from "./components/LoadingVeil";
import { SidePanel } from "./components/SidePanel";
import { Timeline } from "./components/Timeline";
import { TopControls } from "./components/TopControls";
import { appData, deriveIndices, initialView, sampleStore, selectionStore, setAppData, timeStore, uiStore } from "./state";

declare global {
  interface Window { __CHRONOS__?: { engine: AtlasEngine; meta: BundleMeta; readyMs: number; timings: Record<string, number> } }
}

const params = new URLSearchParams(location.search);
const TEST = params.get("test") === "1";

export function App() {
  const mapRef = useRef<HTMLDivElement>(null);
  const phase = useStore(uiStore, (s) => s.phase);

  useEffect(() => {
    let engine: AtlasEngine | null = null;
    let cancelled = false;
    const tNav = performance.now();
    (async () => {
      let metaResolve: (m: BundleMeta) => void = () => {};
      const metaPromise = new Promise<BundleMeta>((r) => { metaResolve = r; });
      const loading = loadAtlas({
        onMeta: (m) => {
          uiStore.set({ phase: "loading", total: m.files.geometry.bytes ?? m.geometry.bytes, territories: m.geometry.territories,
                        years: [m.years.min, m.years.max] });
          metaResolve(m);
        },
        onProgress: (loaded, total) => uiStore.set({ loaded, total }),
      });
      loading.catch(() => {});                      // reported below
      const meta = await Promise.race([metaPromise, loading.then((l) => l.meta)]);
      if (cancelled || !mapRef.current) return;
      engine = await AtlasEngine.create(mapRef.current, meta, {
        center: initialView.center, zoom: initialView.zoom, projection: uiStore.get().projection, year: timeStore.get().t,
        reducedMotion: uiStore.get().reducedMotion, dissolveMs: TEST ? 0 : 240, mask: params.get("mask") === "1",
      }, {
        onHover: (h) => selectionStore.set({ hover: h }),
        onClick: ({ lngLat, polities, onLand }) => {
          const current = selectionStore.get().polity;
          const next = polities.includes(current) && polities.length > 1
            ? (polities[(polities.indexOf(current) + 1) % polities.length] as number) : (polities[0] ?? -1);
          selectionStore.set({ polity: next });
          sampleStore.set({ at: lngLat, onLand });
          uiStore.set({ panel: next >= 0 ? "polity" : "sample" });
        },
        onMove: () => scheduleHash(),
      });
      const loaded = await loading;
      if (cancelled) return;
      uiStore.set({ phase: "uploading" });
      const t = clampYear(timeStore.get().t, loaded.meta.years.min, loaded.meta.years.max);
      timeStore.set({ t });
      engine.setYear(t);
      await engine.attach(loaded);
      const derived = deriveIndices(loaded.meta, loaded.geometry);
      setAppData({ meta: loaded.meta, g: loaded.geometry, loaded, engine, sampleIndex: null, ...derived });
      // Readiness: the first frame in which a visible territory is picked back correctly (not the engine signal).
      let ready: boolean | null = false;
      for (let i = 0; i < 600 && ready === false; i++) {
        ready = engine.probe();
        if (ready === false) await new Promise((r) => requestAnimationFrame(r));
      }
      const readyMs = Math.round(performance.now() - tNav);
      if (initialView.polityId) {
        const p = derived.polityIndex.get(initialView.polityId);
        if (p !== undefined) { selectionStore.set({ polity: p }); uiStore.set({ panel: "polity" }); }
      }
      if (sampleStore.get().at) {
        runSample();
        if (uiStore.get().panel === "none") uiStore.set({ panel: "sample" });
      }
      uiStore.set({ phase: "ready", readyMs });
      // A handle for the test tools only (?test=1 benchmarks, ?debug=1 smoke and compat); not exposed otherwise.
      if (TEST || params.get("debug") === "1") {
        window.__CHRONOS__ = { engine, meta: loaded.meta, readyMs, timings: { ...loaded.timings, engineDataReadyMs: engine.dataReadyMs } };
      }
      if (params.get("bench") === "1") void import("./benchHook").then((m) => m.runBench(engine as AtlasEngine, loaded.meta, tNav));
    })().catch((err: unknown) => {
      uiStore.set({ phase: "error", error: err instanceof Error ? err.message : String(err) });
    });
    return () => { cancelled = true; engine?.destroy(); };
  }, []);

  // Keep the engine in step with the stores.
  useEffect(() => timeStore.subscribe(() => {
    const d = appData();
    if (!d) return;
    const t = timeStore.get().t;
    if (d.engine.year !== t) d.engine.setYear(t, transitionNext.value && !timeStore.get().playing);
    transitionNext.value = false;
    scheduleHash();
  }), []);
  useEffect(() => selectionStore.subscribe(() => { appData()?.engine.setSelected(selectionStore.get().polity); scheduleHash(); }), []);
  useEffect(() => sampleStore.subscribe(() => appData()?.engine.setSample(sampleStore.get().at)), []);
  useEffect(() => uiStore.subscribe(() => {
    const d = appData();
    const s = uiStore.get();
    d?.engine.setProjection(s.projection);
    d?.engine.setReducedMotion(s.reducedMotion);
  }), []);
  useEffect(() => {
    const mq = matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => uiStore.set({ reducedMotion: mq.matches });
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  useEffect(() => {
    const onHash = () => {
      const d = appData();
      if (!d || location.hash === lastHash.value) return;
      const v = parseHash(location.hash);
      if (v.t !== undefined) setYear(v.t, true);
      if (v.center && v.zoom !== undefined) d.engine.flyTo(v.center, v.zoom);
      if (v.projection) uiStore.set({ projection: v.projection });
      const p = v.polity ? d.polityIndex.get(v.polity) ?? -1 : -1;
      selectionStore.set({ polity: p });
      sampleStore.set({ at: v.sample ?? null });
      uiStore.set({ panel: p >= 0 ? "polity" : v.sample ? "sample" : "none" });
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useKeyboard();
  usePlayback();

  return (
    <div className="relative h-dvh w-screen overflow-hidden">
      <div className="stage-space absolute inset-0" />
      <div className="absolute inset-0">
        <div ref={mapRef} style={{ width: "100%", height: "100%" }} aria-label="Globe of mapped historical polities" role="application" />
      </div>
      <div className="stage-vignette pointer-events-none absolute inset-0" />
      <Header />
      <TopControls />
      {phase === "ready" && <SidePanel />}
      <Timeline />
      <HoverTip />
      <LoadingVeil />
      <Credits />
    </div>
  );
}

let hashTimer = 0;
const lastHash = { value: location.hash };
function scheduleHash() {
  clearTimeout(hashTimer);
  hashTimer = window.setTimeout(() => {
    const d = appData();
    if (!d) return;
    const c = d.engine.map.getCenter();
    const sel = selectionStore.get().polity;
    const hash = formatHash({
      t: timeStore.get().t, center: [c.lng, c.lat], zoom: d.engine.map.getZoom(),
      polity: sel >= 0 ? d.meta.polities[sel]?.id : undefined, sample: sampleStore.get().at ?? undefined,
      projection: uiStore.get().projection,
    });
    if (hash !== location.hash) { lastHash.value = hash; history.replaceState(null, "", hash); }
  }, 250);
}

function useKeyboard() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      const d = appData();
      if (!d) return;
      const t = timeStore.get().t;
      const step = e.altKey ? 100 : e.shiftKey ? 10 : 1;
      if (e.key === "ArrowRight") { setYear(t + step, step > 1); e.preventDefault(); }
      else if (e.key === "ArrowLeft") { setYear(t - step, step > 1); e.preventDefault(); }
      else if (e.key === " ") { timeStore.set({ playing: !timeStore.get().playing }); e.preventDefault(); }
      else if (e.key === "Home") { setYear(d.meta.years.min, true); e.preventDefault(); }
      else if (e.key === "End") { setYear(d.meta.years.max, true); e.preventDefault(); }
      else if (e.key === "Escape") { selectionStore.set({ polity: -1 }); uiStore.set({ panel: "none", credits: false }); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

function usePlayback() {
  const playing = useStore(timeStore, (s) => s.playing);
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    let acc = 0;
    let raf = 0;
    const tick = (now: number) => {
      const d = appData();
      const s = timeStore.get();
      acc += ((now - last) / 1000) * s.speed;
      last = now;
      const whole = Math.floor(acc);
      if (whole >= 1 && d) {
        acc -= whole;
        const next = s.t + whole;
        if (next >= d.meta.years.max) { setYear(d.meta.years.max); timeStore.set({ playing: false }); return; }
        setYear(next);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);
}

