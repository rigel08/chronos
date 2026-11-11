/**
 * Two candidate engines behind one interface, sharing the same MapLibre globe and basemap:
 *   - "maplibre": native fill layer; year filter via a global-state expression (re-evaluated in workers).
 *   - "deck":     deck.gl SolidPolygonLayer interleaved into MapLibre; year filter on the GPU (DataFilterExtension).
 * Both draw exactly the same polygons from the same bundle.
 */
import { MapLibreOverlay } from "@deck.gl/maplibre";
import { DataFilterExtension, type DataFilterExtensionProps } from "@deck.gl/extensions";
import { SolidPolygonLayer } from "@deck.gl/layers";
import { type ExpressionSpecification, type IControl, Map as MapLibreMap, type StyleSpecification } from "maplibre-gl";

import { yearFilterRange } from "../lib/years";
import { deckBinaryData, type Geometry, partItems, type PartItem, territoryFeatures } from "./bundle";
import { probe } from "./memory";

export type EngineName = "maplibre" | "deck";

export interface Engine {
  name: EngineName;
  map: MapLibreMap;
  /** Apply year t. Returns the synchronous main-thread cost in ms. */
  setYear(t: number): number;
  /** Resolve once a frame reflecting the current year has been fully rendered. */
  settled(): Promise<void>;
  /** Polity indices drawn at a screen pixel. */
  pick(x: number, y: number): number[];
  /** True when the last rendered frame reflects the last year set (no pending worker re-evaluation). */
  isCurrent(): boolean;
  dataReadyMs: number;
}

const PIGMENTS = ["#cf5637", "#4b70c6", "#d9a845", "#4fae9f", "#57a067", "#b25c87", "#7a6fb0", "#d8b54a", "#8f7457", "#6c8791", "#c58f2e", "#e08a6c"];
const hex = (c: string): [number, number, number] => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
const PIGMENTS_RGB = PIGMENTS.map(hex);

export function baseStyle(): StyleSpecification {
  return {
    version: 8,
    projection: { type: "globe" },
    sky: { "atmosphere-blend": 0.6 },
    sources: { land: { type: "geojson", data: "/basemap_land.geojson" } },
    layers: [
      { id: "ocean", type: "background", paint: { "background-color": "#10161e" } },
      { id: "land", type: "fill", source: "land", paint: { "fill-color": "#1a222c" } },
    ],
  };
}

// Depth handling for polygons drawn on MapLibre's globe surface (see docs/spikes/001-engine.md).
// Overridable from the URL (?depth=default|always) so the variants can be compared on screenshots.
const DEPTH = new URLSearchParams(globalThis.location?.search ?? "").get("depth") ?? "always";
const CURRENT_CHECK = new URLSearchParams(globalThis.location?.search ?? "").get("current");
const PROBE = new URLSearchParams(globalThis.location?.search ?? "").get("probe") === "1";
// Engine variants for the memory work (milestone 1.2); default stays the Spike 001 configuration until replaced.
//   spike001: per-part objects, deck.gl normalises and triangulates in the browser (the Spike 001 configuration)
//   alloc:    spike001 with exact typed-array allocation and no buffer pool
//   binary:   pre-triangulated binary geometry from the pipeline (D-021) with exact allocation (the 1.2 default)
export const VARIANT = new URLSearchParams(globalThis.location?.search ?? "").get("variant") ?? "binary";
const ALLOCATOR = VARIANT === "spike001" ? undefined : { overAlloc: 1, poolSize: 0 };
// Face culling (milestone 1.2, D-022). In interleaved mode deck.gl draws inside MapLibre's GL context; Spike 001
// rendered correctly only because MapLibre's globe pass left back-face culling enabled, which also hid the far
// hemisphere (seen through the globe, far-side triangles face away). Culling is now explicit, with triangle
// winding fixed by the pipeline (counter-clockwise in lon/lat). ?cull=back|front|none|inherit for experiments.
const CULL = new URLSearchParams(globalThis.location?.search ?? "").get("cull") ?? "back";
const DECK_PARAMETERS = { ...(DEPTH === "default" ? {} : { depthCompare: "always" as const, depthWriteEnabled: false }),
                          ...(CULL === "inherit" ? {} : { cullMode: CULL as "back" | "front" | "none" }) };

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

export async function createEngine(name: EngineName, container: HTMLElement, g: Geometry, initialYear: number,
                                   view: { center: [number, number]; zoom: number }): Promise<Engine> {
  const map = new MapLibreMap({
    container, style: baseStyle(), center: view.center, zoom: view.zoom, attributionControl: false,
    canvasContextAttributes: { antialias: true, preserveDrawingBuffer: false },
    fadeDuration: 0,
  });
  await new Promise<void>((resolve, reject) => {
    const watchdog = setTimeout(() => reject(new Error("map did not load within 120 s")), 120_000);
    map.once("load", () => { clearTimeout(watchdog); resolve(); });
    map.on("error", (ev) => { clearTimeout(watchdog); reject(ev.error ?? new Error("map error")); });
  });
  if (PROBE) await probe("map loaded, no territories");
  const t0 = performance.now();
  const engine = name === "maplibre" ? await maplibreEngine(map, g, initialYear) : await deckEngine(map, g, initialYear);
  await engine.settled();
  engine.dataReadyMs = Math.round(performance.now() - t0);
  return engine;
}

async function maplibreEngine(map: MapLibreMap, g: Geometry, year: number): Promise<Engine> {
  map.setGlobalStateProperty("year", year);
  map.addSource("polities", { type: "geojson", data: territoryFeatures(g), tolerance: 0 });
  const colour = ["match", ["%", ["get", "p"], PIGMENTS.length],
    ...PIGMENTS.flatMap((c, i) => [i, c]), "#888888"] as unknown as ExpressionSpecification;
  map.addLayer({
    id: "polities", type: "fill", source: "polities",
    filter: ["all", ["<=", ["get", "s"], ["global-state", "year"]], [">=", ["get", "e"], ["global-state", "year"]]],
    paint: { "fill-color": colour, "fill-opacity": 0.85, "fill-antialias": false },
  });
  return {
    name: "maplibre", map, dataReadyMs: 0,
    setYear(t) {
      const a = performance.now();
      map.setGlobalStateProperty("year", t);
      return performance.now() - a;
    },
    async settled() {
      // A global-state change re-evaluates the filter in the workers; the map is current only when idle.
      if (!map.loaded() || !map.areTilesLoaded()) await new Promise<void>((r) => map.once("idle", () => r()));
      else { map.triggerRepaint(); await new Promise<void>((r) => map.once("idle", () => r())); }
    },
    isCurrent() {
      return map.loaded() && map.areTilesLoaded();
    },
    pick(x, y) {
      const hits = map.queryRenderedFeatures([x, y], { layers: ["polities"] });
      return [...new Set(hits.map((f) => Number(f.properties["p"])))].sort((a, b) => a - b);
    },
  };
}

async function deckEngine(map: MapLibreMap, g: Geometry, year: number): Promise<Engine> {
  const extension = new DataFilterExtension({ filterSize: 2 });
  const colourOf = (polity: number): [number, number, number, number] =>
    [...(PIGMENTS_RGB[polity % PIGMENTS_RGB.length] as [number, number, number]), 217];
  let make: (t: number) => SolidPolygonLayer<never, DataFilterExtensionProps<never>>;
  let polityAt: (index: number, object: unknown) => number;
  if (VARIANT === "binary") {
    const data = deckBinaryData(g, colourOf);
    if (PROBE) await probe("deck: binary attributes built");
    make = (t) => new SolidPolygonLayer<never, DataFilterExtensionProps<never>>({
      id: "polities", data: data as never, _normalize: false, positionFormat: "XY", extruded: false, filled: true,
      pickable: true, filterRange: yearFilterRange(t), extensions: [extension], parameters: DECK_PARAMETERS,
    });
    polityAt = (index) => g.territoryPolity[g.partTerritory[index] as number] as number;
  } else {
    const data = partItems(g);
    if (PROBE) await probe("deck: part items built");
    make = (t) => new SolidPolygonLayer<PartItem, DataFilterExtensionProps<PartItem>>({
      id: "polities", data, positionFormat: "XY", extruded: false, filled: true, pickable: true,
      getPolygon: (d) => d.polygon,
      getFillColor: (d) => colourOf(g.territoryPolity[d.territory] as number),
      getFilterValue: (d) => [d.start, d.end],
      filterRange: yearFilterRange(t),
      extensions: [extension],
      parameters: DECK_PARAMETERS,
    }) as unknown as SolidPolygonLayer<never, DataFilterExtensionProps<never>>;
    polityAt = (_index, object) => g.territoryPolity[(object as PartItem).territory] as number;
  }
  const overlay = new MapLibreOverlay({ interleaved: true, layers: [make(year)], ...(ALLOCATOR ? { _typedArrayManagerProps: ALLOCATOR } : {}) });
  map.addControl(overlay as unknown as IControl);
  if (PROBE) (globalThis as unknown as { __CHRONOS_OVERLAY__?: unknown }).__CHRONOS_OVERLAY__ = overlay;   // memory profiler only
  let pendingFrame: Promise<void> = Promise.resolve();
  return {
    name: "deck", map, dataReadyMs: 0,
    setYear(t) {
      const a = performance.now();
      overlay.setProps({ layers: [make(t)] });
      pendingFrame = new Promise<void>((r) => map.once("render", () => r()));
      return performance.now() - a;
    },
    async settled() {
      // Filter changes are uniform updates: the next rendered frame is current. Wait for it, then one more.
      map.triggerRepaint();
      await pendingFrame;
      await nextFrame();
      if (!map.loaded()) await new Promise<void>((r) => map.once("idle", () => r()));
    },
    isCurrent() {
      // A filter change is a uniform update applied in the next rendered frame. With ?current=maploaded the
      // map's own load state is used instead, as a control for the staleness metric (docs/spikes/001-engine.md).
      return CURRENT_CHECK === "maploaded" ? map.loaded() && map.areTilesLoaded() : true;
    },
    pick(x, y) {
      const hits = overlay.pickMultipleObjects({ x, y, radius: 0, depth: 8, layerIds: ["polities"] });
      return [...new Set(hits.map((h) => polityAt(h.index, h.object)))].sort((a, b) => a - b);
    },
  };
}
