/**
 * AtlasEngine: MapLibre (globe, basemap, camera) plus deck.gl (territories, overlaps, outline, sample pin),
 * interleaved in one WebGL2 context (D-001, D-019). React never talks to either library directly.
 *
 * Kept from 1.2 (spike 002): binary pre-triangulated geometry with `_normalize: false`, explicit back-face
 * culling on the globe (D-022), depth test off for fills on the globe surface (D-019), exact typed-array
 * allocation (D-023). New in 1.3: StrataExtension instead of DataFilterExtension (exact years plus a
 * wall-clock dissolve, selection and overlap stripes as uniforms).
 */
import "./maplibreWorker";

import { PathLayer, ScatterplotLayer, SolidPolygonLayer } from "@deck.gl/layers";
import { MapLibreOverlay } from "@deck.gl/maplibre";
import { type IControl, Map as MapLibreMap, type MapMouseEvent } from "maplibre-gl";

import { EDGE_SYNTHETIC, type BundleMeta, type Geometry } from "../lib/bundle";
import { FarSideExtension } from "./farSideExtension";
import type { Loaded } from "./loader";
import { StrataExtension, type StrataExtensionProps } from "./strataExtension";
import { strataStyle, TERRITORY_BEFORE, TOKENS } from "./style";

export type Projection = "globe" | "flat";

export interface EngineEvents {
  onHover?(e: { x: number; y: number; polities: number[] } | null): void;
  onClick?(e: { lngLat: [number, number]; polities: number[]; onLand: boolean }): void;
  onMove?(view: { center: [number, number]; zoom: number }): void;
}

export interface EngineOptions {
  center: [number, number];
  zoom: number;
  projection: Projection;
  year: number;
  reducedMotion: boolean;
  dissolveMs?: number;
  /** Render-agreement mode: territories pure white on black; no basemap, atmosphere or overlap stripes. */
  mask?: boolean;
}

const BONE: [number, number, number] = [233, 226, 210];
const WHITE: [number, number, number, number] = [255, 255, 255, 255];
const LINE_PARAMS = { depthCompare: "always" as const, depthWriteEnabled: false };
const GLOW: [number, number, number, number] = [...BONE, 46];
const LINE: [number, number, number, number] = [...BONE, 235];
const HALO: [number, number, number, number] = [...BONE, 200];
const DOT: [number, number, number, number] = [...BONE, 255];
const samplePosition = (o: { p: [number, number] }) => o.p;
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
const absolute = (path: string) => `${location.origin}/${path}`;

export class AtlasEngine {
  readonly name = "app";
  readonly map: MapLibreMap;
  dataReadyMs = 0;
  private overlay: MapLibreOverlay | null = null;
  private data: Loaded | null = null;
  private fillExt: StrataExtension | null = null;
  private stripeExt: StrataExtension | null = null;
  private readonly farSide = new FarSideExtension();
  private t: number;
  private tPrev: number;
  private mix = 1;
  private animStart = 0;
  private animFrame = 0;
  private selected = -1;
  private hovered = -1;
  private sampleAt: [number, number] | null = null;
  private outline: { polity: number; t: number; data: unknown } | null = null;
  private territoryData: unknown = null;       // stable references: deck.gl must never see new data on a year change
  private overlapData: unknown = null;
  private sampleData: { p: [number, number] }[] = [];
  private params = { depthCompare: "always" as const, depthWriteEnabled: false, cullMode: "back" as "back" | "none" };
  private projection: Projection;
  private reducedMotion: boolean;
  private dissolveMs: number;
  private firstPart: Uint32Array | null = null;
  private pendingFrame: Promise<void> = Promise.resolve();
  private hoverQueued = false;
  private mask = false;
  private overlapBox: Float32Array = new Float32Array(0);
  private lastPointer: { x: number; y: number } | null = null;

  private constructor(map: MapLibreMap, o: EngineOptions, private readonly events: EngineEvents) {
    this.map = map;
    this.t = o.year;
    this.tPrev = o.year;
    this.projection = o.projection;
    this.reducedMotion = o.reducedMotion;
    this.dissolveMs = o.dissolveMs ?? 240;
    this.updateParameters();
  }

  /** Create the map as soon as bundle.json is known: the stage (globe, land, relief) appears before territories. */
  static async create(container: HTMLElement, meta: BundleMeta, o: EngineOptions, events: EngineEvents): Promise<AtlasEngine> {
    const f = meta.files;
    const style = strataStyle(
      { tiles: absolute(f.relief.template), tileSize: f.relief.tile_size, minzoom: f.relief.minzoom, maxzoom: f.relief.maxzoom },
      null, o.projection === "globe" ? "globe" : "mercator");
    if (o.mask) {
      style.layers = [{ id: "ocean", type: "background", paint: { "background-color": "#000000" } },
                      { id: "relief", type: "background", paint: { "background-opacity": 0 } }];
      style.sky = { "atmosphere-blend": 0 };
    }
    const map = new MapLibreMap({
      container, style, center: o.center, zoom: o.zoom, attributionControl: false, fadeDuration: 0,
      canvasContextAttributes: { antialias: true, preserveDrawingBuffer: false }, maxPitch: 60, renderWorldCopies: false,
    });
    map.keyboard.disable();                 // the timeline owns arrow keys; map keys would conflict
    await new Promise<void>((resolve, reject) => {
      const watchdog = setTimeout(() => reject(new Error("the map did not load within 60 s")), 60_000);
      map.once("load", () => { clearTimeout(watchdog); resolve(); });
      map.on("error", (ev) => { if (!map.loaded()) { clearTimeout(watchdog); reject(ev.error ?? new Error("map error")); } });
    });
    // Basemap layers: MapLibre fetches and parses each file in its own worker.
    for (const key of (o.mask ? [] : ["land", "coastline", "lakes", "rivers"]) as ("land" | "coastline" | "lakes" | "rivers")[]) {
      const src = map.getSource(key) as { setData(d: string): void } | undefined;
      src?.setData(absolute(f[`basemap_${key}`].path));
    }
    const engine = new AtlasEngine(map, o, events);
    engine.mask = !!o.mask;
    map.on("mousemove", (e: MapMouseEvent) => engine.queueHover(e.point.x, e.point.y));
    map.on("mouseout", () => { engine.lastPointer = null; engine.setHovered(-1); events.onHover?.(null); });
    map.on("click", (e: MapMouseEvent) => {
      const polities = engine.claimantsAt(e.point.x, e.point.y);
      const onLand = map.queryRenderedFeatures(e.point, { layers: ["land"] }).length > 0;   // modern Natural Earth land
      events.onClick?.({ lngLat: [e.lngLat.lng, e.lngLat.lat], polities, onLand });
    });
    map.on("movestart", () => { engine.setHovered(-1); events.onHover?.(null); });
    map.on("moveend", () => {
      const c = map.getCenter();
      events.onMove?.({ center: [c.lng, c.lat], zoom: map.getZoom() });
    });
    map.on("zoom", () => engine.render());
    return engine;
  }

  /** Upload territories and overlaps. Resolves after the first frame that contains them. */
  async attach(data: Loaded): Promise<void> {
    const t0 = performance.now();
    this.data = data;
    const palette = this.mask ? ["#ffffff"] : data.meta.palette.colours;
    this.fillExt = new StrataExtension({ palette, stripes: false, wash: this.mask ? 0 : 0.14 });
    this.stripeExt = new StrataExtension({ palette, stripes: true });
    const g = data.geometry;
    const first = new Uint32Array(g.territoryStart.length + 1).fill(0xffffffff);
    for (let p = g.territories.partOwner.length - 1; p >= 0; p--) first[g.territories.partOwner[p] as number] = p;
    first[g.territoryStart.length] = g.territories.partOwner.length;
    for (let t = g.territoryStart.length - 1; t >= 0; t--) if (first[t] === 0xffffffff) first[t] = first[t + 1] as number;
    this.firstPart = first;
    const v = data.vertex;
    this.territoryData = { length: g.territories.partOwner.length, startIndices: v.startIndices,
                           attributes: { getPolygon: { value: g.territories.positions, size: 2 }, indices: g.territories.triangles,
                                         getStrataTime: { value: v.time, size: 2 }, getStrataCode: { value: v.code, size: 1 } } };
    this.overlapBox = boxes(g.overlaps.positions, g.overlaps.ringStart, g.overlaps.partRingStart);
    this.overlapData = { length: g.overlaps.partOwner.length, startIndices: v.ovStartIndices,
                         attributes: { getPolygon: { value: g.overlaps.positions, size: 2 }, indices: g.overlaps.triangles,
                                       getStrataTime: { value: v.ovTime, size: 2 }, getStrataCodes: { value: v.ovCodes, size: 4 } } };
    this.overlay = new MapLibreOverlay({ interleaved: true, layers: this.layers(), _typedArrayManagerProps: { overAlloc: 1, poolSize: 0 } });
    this.map.addControl(this.overlay as unknown as IControl);
    await this.settled();
    this.dataReadyMs = Math.round(performance.now() - t0);
  }

  // ------------------------------------------------------------------ layers

  private updateParameters() {
    // Globe: explicit back-face culling with pipeline-fixed winding (D-022). Flat: no far side, no culling needed.
    this.params = { depthCompare: "always", depthWriteEnabled: false, cullMode: this.projection === "globe" ? "back" : "none" };
  }

  private strataProps(): StrataExtensionProps {
    return { strataYears: [this.t, this.tPrev, this.mix], strataSelected: this.selected, strataHovered: this.hovered };
  }

  private layers() {
    if (!this.data || !this.fillExt || !this.stripeExt) return [];
    const pxPerDeg = (512 * 2 ** this.map.getZoom()) / 360;
    const common = { _normalize: false, positionFormat: "XY" as const, extruded: false, filled: true, getFillColor: WHITE,
                     parameters: this.params, beforeId: TERRITORY_BEFORE, ...this.strataProps() };
    const layers: unknown[] = [
      new SolidPolygonLayer({ id: "territories", pickable: true, extensions: [this.fillExt], ...common, data: this.territoryData } as never),
    ];
    if (!this.mask) {
      layers.push(new SolidPolygonLayer({ id: "overlaps", pickable: false, extensions: [this.stripeExt], strataStripes: [5, pxPerDeg], ...common,
                                          data: this.overlapData } as never));
    }
    const outline = this.outlineData();
    if (outline) {
      const base = { data: outline as never, positionFormat: "XY" as const, _pathType: "open" as const, widthUnits: "pixels" as const,
                     extensions: [this.farSide], parameters: LINE_PARAMS };
      layers.push(new PathLayer({ id: "outline-glow", ...base, getWidth: 7, getColor: GLOW }));
      layers.push(new PathLayer({ id: "outline", ...base, getWidth: 1.6, getColor: LINE }));
    }
    if (this.sampleAt) {
      const base = { data: this.sampleData, getPosition: samplePosition, radiusUnits: "pixels" as const,
                     extensions: [this.farSide], parameters: LINE_PARAMS };
      layers.push(new ScatterplotLayer({ id: "sample-halo", ...base, getRadius: 11, filled: false, stroked: true, lineWidthUnits: "pixels",
                                         getLineWidth: 1.5, getLineColor: HALO }));
      layers.push(new ScatterplotLayer({ id: "sample-dot", ...base, getRadius: 3, getFillColor: DOT }));
    }
    return layers as never[];
  }

  /** Real borders of the selected polity's rows valid at t (grid cuts and the antimeridian left out). */
  private outlineData() {
    const d = this.data;
    if (!d || this.selected < 0 || !this.firstPart) return null;
    if (this.outline && this.outline.polity === this.selected && this.outline.t === this.t) return this.outline.data;
    const g = d.geometry;
    const m = g.territories;
    const pos: number[] = [];
    const starts: number[] = [];
    for (let t = 0; t < g.territoryStart.length; t++) {
      if (g.territoryPolity[t] !== this.selected || (g.territoryStart[t] as number) > this.t || (g.territoryEnd[t] as number) < this.t) continue;
      for (let p = this.firstPart[t] as number; p < (this.firstPart[t + 1] as number); p++) {
        for (let r = m.partRingStart[p] as number; r < (m.partRingStart[p + 1] as number); r++) {
          const a = m.ringStart[r] as number;
          const b = m.ringStart[r + 1] as number;
          let open = false;
          for (let i = a; i < b - 1; i++) {
            const real = ((g.edgeFlags[i] as number) & EDGE_SYNTHETIC) === 0;
            if (real) {
              if (!open) { starts.push(pos.length / 2); pos.push(m.positions[2 * i] as number, m.positions[2 * i + 1] as number); open = true; }
              pos.push(m.positions[2 * i + 2] as number, m.positions[2 * i + 3] as number);
            } else open = false;
          }
        }
      }
    }
    const data = starts.length ? { length: starts.length, startIndices: new Uint32Array(starts),
                                   attributes: { getPath: { value: new Float32Array(pos), size: 2 } } } : null;
    this.outline = { polity: this.selected, t: this.t, data };
    return data;
  }

  private render() {
    if (!this.overlay) return;
    this.overlay.setProps({ layers: this.layers() });
    this.pendingFrame = new Promise<void>((r) => this.map.once("render", () => r()));
    this.map.triggerRepaint();
  }

  // ------------------------------------------------------------------ time

  /** Apply year t. With `transition`, attested states cross-dissolve over wall-clock time (D-020). Returns main-thread ms. */
  setYear(t: number, transition = false): number {
    const a = performance.now();
    if (t === this.t && this.mix >= 1) return 0;
    const animate = transition && !this.reducedMotion && this.dissolveMs > 0;
    cancelAnimationFrame(this.animFrame);
    if (animate) {
      this.tPrev = this.mix >= 0.5 ? this.t : this.tPrev;      // dissolve from the state most visible now
      this.t = t;
      this.mix = 0;
      this.animStart = performance.now();
      const step = () => {
        this.mix = Math.min(1, (performance.now() - this.animStart) / this.dissolveMs);
        if (this.mix >= 1) this.tPrev = this.t;
        this.render();
        if (this.mix < 1) this.animFrame = requestAnimationFrame(step);
      };
      this.animFrame = requestAnimationFrame(step);
    } else {
      this.t = t;
      this.tPrev = t;
      this.mix = 1;
    }
    this.render();
    return performance.now() - a;
  }

  get year(): number { return this.t; }

  setReducedMotion(on: boolean) { this.reducedMotion = on; }

  // ------------------------------------------------------------------ selection, hover, sample

  setSelected(polity: number) {
    if (polity === this.selected) return;
    this.selected = polity;
    this.render();
  }

  setHovered(polity: number) {
    if (polity === this.hovered) return;
    this.hovered = polity;
    this.render();
  }

  setSample(lonLat: [number, number] | null) {
    this.sampleAt = lonLat;
    this.sampleData = lonLat ? [{ p: lonLat }] : [];
    this.render();
  }

  private queueHover(x: number, y: number) {
    this.lastPointer = { x, y };
    if (this.hoverQueued) return;
    this.hoverQueued = true;
    requestAnimationFrame(() => {
      this.hoverQueued = false;
      const p = this.lastPointer;
      if (!p || !this.overlay) return;
      const polities = this.claimantsAt(p.x, p.y);
      this.setHovered(polities[0] ?? -1);
      this.events.onHover?.(polities.length ? { x: p.x, y: p.y, polities } : null);
    });
  }

  /**
   * Polities at a screen pixel for hover and click: one picking pass for the polity drawn on top, then every other
   * claimant from the explicit overlap regions (D-026), tested on the CPU. Unlike a multi-pass pick, this uploads
   * nothing: deck.gl's depth picking re-uploads picking-colour ranges to exclude objects already found (~1.9 MB per
   * hover, measured). The top polity comes first.
   */
  claimantsAt(x: number, y: number): number[] {
    if (!this.overlay || !this.data) return [];
    const g = this.data.geometry;
    const hit = this.overlay.pickObject({ x, y, radius: 0, layerIds: ["territories"] });
    if (!hit) return [];
    const top = g.territoryPolity[g.territories.partOwner[hit.index] as number] as number;
    const ll = this.map.unproject([x, y]);
    const others = new Set<number>();
    const m = g.overlaps;
    const box = this.overlapBox;
    for (let p = 0; p < m.partOwner.length; p++) {
      if (ll.lng < (box[4 * p] as number) || ll.lng > (box[4 * p + 2] as number) || ll.lat < (box[4 * p + 1] as number) || ll.lat > (box[4 * p + 3] as number)) continue;
      const r = m.partOwner[p] as number;
      if ((g.regionStart[r] as number) > this.t || (g.regionEnd[r] as number) < this.t) continue;
      if (!insideRings(m.positions, m.ringStart, m.partRingStart[p] as number, m.partRingStart[p + 1] as number, ll.lng, ll.lat)) continue;
      for (let k = 0; k < g.regionSlots; k++) {
        const t = g.regionTerritories[r * g.regionSlots + k] as number;
        if (t !== 0xffffffff) others.add(g.territoryPolity[t] as number);
      }
    }
    if (!others.has(top)) return [top];        // the pixel is outside every shared region valid now
    others.delete(top);
    return [top, ...[...others].sort((a, b) => a - b)];
  }

  /** Polity indices drawn at a screen pixel in the current year (all claimants), by multi-pass picking. Benchmarks use this. */
  pick(x: number, y: number, depth = 8): number[] {
    if (!this.overlay || !this.data) return [];
    const g = this.data.geometry;
    const hits = this.overlay.pickMultipleObjects({ x, y, radius: 0, depth, layerIds: ["territories"] });
    return [...new Set(hits.map((h) => g.territoryPolity[g.territories.partOwner[h.index] as number] as number))].sort((a, b) => a - b);
  }

  // ------------------------------------------------------------------ camera

  setProjection(p: Projection) {
    if (p === this.projection) return;
    this.projection = p;
    this.updateParameters();
    this.map.setProjection({ type: p === "globe" ? "globe" : "mercator" });
    this.render();
  }

  flyTo(center: [number, number], zoom?: number) {
    const opts = { center, zoom: zoom ?? this.map.getZoom() };
    if (this.reducedMotion) this.map.jumpTo(opts);
    else this.map.flyTo({ ...opts, duration: 1400, essential: false });
  }

  /** Bring a polity's rows valid at t into view. */
  fitPolity(polity: number) {
    const d = this.data;
    if (!d || !this.firstPart) return;
    const g = d.geometry;
    let x0 = 180, y0 = 90, x1 = -180, y1 = -90;
    for (let t = 0; t < g.territoryStart.length; t++) {
      if (g.territoryPolity[t] !== polity || (g.territoryStart[t] as number) > this.t || (g.territoryEnd[t] as number) < this.t) continue;
      for (let p = this.firstPart[t] as number; p < (this.firstPart[t + 1] as number); p++) {
        const m = g.territories;
        for (let v = m.ringStart[m.partRingStart[p] as number] as number; v < (m.ringStart[m.partRingStart[p + 1] as number] as number); v++) {
          const x = m.positions[2 * v] as number, y = m.positions[2 * v + 1] as number;
          x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
        }
      }
    }
    if (x0 > x1) return;
    const cam = this.map.cameraForBounds([[x0, y0], [x1, y1]], { padding: { top: 120, bottom: 220, left: 80, right: 460 }, maxZoom: 6 });
    if (cam?.center) this.flyTo([(cam.center as { lng: number }).lng, (cam.center as { lat: number }).lat], cam.zoom);
  }

  // ------------------------------------------------------------------ readiness and benchmark interface

  /** A frame reflecting the current state has been rendered. */
  async settled(): Promise<void> {
    this.map.triggerRepaint();
    await this.pendingFrame;
    await nextFrame();
    if (!this.map.loaded()) await new Promise<void>((r) => this.map.once("idle", () => r()));
  }

  /** Current means: no dissolve in progress (filter changes are uniform updates applied in the next frame). */
  isCurrent(): boolean {
    return this.mix >= 1;
  }

  /**
   * Readiness gate (D-019 note, roadmap 1.3): the first frame in which a territory valid at t, visible on screen,
   * is actually picked back at its label point. Returns false if nothing suitable is in view.
   */
  probe(): boolean | null {
    const d = this.data;
    if (!d) return false;
    const g = d.geometry;
    const canvas = this.map.getCanvas();
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const c = this.map.getCenter();
    let best = -1, bestArea = 0;
    for (let t = 0; t < g.territoryStart.length; t++) {
      if ((g.territoryStart[t] as number) > this.t || (g.territoryEnd[t] as number) < this.t) continue;
      const area = g.territoryArea[t] as number;
      if (area <= bestArea) continue;
      const lon = g.territoryLabel[2 * t] as number, lat = g.territoryLabel[2 * t + 1] as number;
      if (this.projection === "globe" && angularDistance(c.lng, c.lat, lon, lat) > 70) continue;
      const p = this.map.project([lon, lat]);
      if (p.x < 20 || p.y < 20 || p.x > w - 20 || p.y > h - 20) continue;
      best = t;
      bestArea = area;
    }
    if (best < 0) return null;
    const p = this.map.project([g.territoryLabel[2 * best] as number, g.territoryLabel[2 * best + 1] as number]);
    return this.pick(p.x, p.y, 4).includes(g.territoryPolity[best] as number);
  }

  destroy() {
    cancelAnimationFrame(this.animFrame);
    this.overlay?.finalize();
    this.map.remove();
  }
}

/** Bounding box (minLon, minLat, maxLon, maxLat) of every part of a mesh. */
function boxes(pos: Float32Array, ringStart: Uint32Array, partRingStart: Uint32Array): Float32Array {
  const parts = partRingStart.length - 1;
  const out = new Float32Array(parts * 4);
  for (let p = 0; p < parts; p++) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let v = ringStart[partRingStart[p] as number] as number; v < (ringStart[partRingStart[p + 1] as number] as number); v++) {
      const x = pos[2 * v] as number, y = pos[2 * v + 1] as number;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    out.set([x0, y0, x1, y1], 4 * p);
  }
  return out;
}

/** Even-odd point-in-polygon over rings [r0, r1) of a mesh. */
function insideRings(pos: Float32Array, ringStart: Uint32Array, r0: number, r1: number, lon: number, lat: number): boolean {
  let inside = false;
  for (let r = r0; r < r1; r++) {
    const a = ringStart[r] as number, b = ringStart[r + 1] as number;
    for (let i = a, j = b - 1; i < b; j = i++) {
      const xi = pos[2 * i] as number, yi = pos[2 * i + 1] as number, xj = pos[2 * j] as number, yj = pos[2 * j + 1] as number;
      if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

function angularDistance(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const r = Math.PI / 180;
  const c = Math.sin(lat1 * r) * Math.sin(lat2 * r) + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r);
  return Math.acos(Math.min(1, Math.max(-1, c))) / r;
}

export { TOKENS };
