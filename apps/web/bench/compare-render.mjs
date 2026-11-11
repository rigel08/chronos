#!/usr/bin/env node
/**
 * Render agreement (milestone 1.2): does the optimised path draw the same map as the reference paths?
 *
 *   node bench/compare-render.mjs [--label name]
 *
 * For each view (camera + year) it renders deck.gl "spike001" (Spike 001 configuration), deck.gl "binary"
 * (pre-triangulated, the 1.2 default) and MapLibre native (a depth-correct reference with its own
 * triangulation), screenshots the map area, and counts pixels whose colour differs by more than a threshold.
 * Views include the Pacific in 1914 (far-side clipping) and the two areas where plain earcut, run in the pipeline's own plane, mis-drew polygons
 * (Mughal Empire 1765, Grand Duchy of Lithuania 1265). Writes docs/spikes/results/<date>-render-<label>.json and
 * difference images for any view that differs.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";
import { createServer } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : process.argv[i + 1]; };
const label = arg("label", "m2-chrome-headless");
const THRESHOLD = 24;   // max channel difference (0-255) above which a pixel counts as different

const ONLY = arg("only", "");
const VIEWS_ALL = [
  { id: "117ce-globe", lon: 30, lat: 30, zoom: 1.4, year: 117 },
  { id: "1914-pacific-far-side", lon: -160, lat: 0, zoom: 1.4, year: 1914 },
  { id: "1500-europe", lon: 10, lat: 48, zoom: 4, year: 1500 },
  { id: "500bce-near-east", lon: 45, lat: 33, zoom: 3.5, year: -499 },
  { id: "1765-mughal-area", lon: 73.54, lat: 24.78, zoom: 7, year: 1765 },
  { id: "1265-lithuania-area", lon: 24, lat: 55, zoom: 5, year: 1265 },
];
const VIEWS = ONLY ? VIEWS_ALL.filter((v) => ONLY.split(",").includes(v.id)) : VIEWS_ALL;
const PATHS_ALL = [
  { id: "deck-binary", q: "engine=deck&variant=binary" },
  { id: "deck-spike001", q: "engine=deck&variant=spike001" },
  { id: "maplibre", q: "engine=maplibre" },
];
const EXTRA = arg("query", "");     // e.g. "&cull=front" to test a deck.gl culling mode
const PATHS = PATHS_ALL.map((p) => (p.id.startsWith("deck") ? { ...p, q: p.q + EXTRA } : p));

const server = await createServer({ configFile: resolve(here, "../vite.config.ts"), root: resolve(here, ".."), logLevel: "warn" });
await server.listen();
const base = `http://localhost:${server.config.server.port}`;
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--ignore-gpu-blocklist"] });
const shots = {};
for (const v of VIEWS) {
  for (const p of PATHS) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    await page.goto(`${base}/bench.html?${p.q}&mode=load&lon=${v.lon}&lat=${v.lat}&zoom=${v.zoom}&year=${v.year}`);
    await page.waitForFunction(() => window.__BENCH__ || window.__BENCH_ERROR__, null, { timeout: 180000 });
    const err = await page.evaluate(() => window.__BENCH_ERROR__);
    if (err) throw new Error(`${p.id} ${v.id}: ${err}`);
    await page.waitForTimeout(2500);                                       // let tiles and the last frame settle
    await page.addStyleTag({ content: "#bar, #out { display: none !important; }" });
    await page.waitForTimeout(300);
    const png = await page.screenshot({ type: "png" });
    shots[`${v.id}|${p.id}`] = png.toString("base64");
    if (process.env.SHOTS_DIR) writeFileSync(resolve(process.env.SHOTS_DIR, `${v.id}-${p.id}.png`), png);
    await page.close();
  }
}

// Pixel comparison in the browser (decodes PNGs with the platform's own decoder).
const cmpPage = await browser.newPage();
const diff = async (a, b) => cmpPage.evaluate(async ([a64, b64, thr]) => {
  const load = async (b64) => createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
  const [ia, ib] = await Promise.all([load(a64), load(b64)]);
  const w = ia.width, h = ia.height;
  const ctx = (img) => { const c = new OffscreenCanvas(w, h); const x = c.getContext("2d"); x.drawImage(img, 0, 0); return x; };
  const da = ctx(ia).getImageData(0, 0, w, h).data, db = ctx(ib).getImageData(0, 0, w, h).data;
  const out = new OffscreenCanvas(w, h); const ox = out.getContext("2d"); const od = ox.createImageData(w, h);
  let n = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let i = 0; i < da.length; i += 4) {
    const d = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]));
    const p = i / 4, x = p % w, y = (p - x) / w;
    if (d > thr) { n++; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); od.data[i] = 255; od.data[i + 3] = 255; }
    else { od.data[i] = od.data[i + 1] = od.data[i + 2] = da[i] >> 2; od.data[i + 3] = 255; }
  }
  ox.putImageData(od, 0, 0);
  const png = n ? await out.convertToBlob({ type: "image/png" }).then((b) => b.arrayBuffer()).then((ab) => Array.from(new Uint8Array(ab))) : null;
  return { differingPixels: n, share: Math.round((n / (w * h)) * 1e6) / 1e6, bbox: n ? [x0, y0, x1, y1] : null, png };
}, [a, b, THRESHOLD]);

const results = [];
const imgDir = resolve(repo, "docs/spikes/img");
mkdirSync(imgDir, { recursive: true });
for (const v of VIEWS) {
  for (const [a, b] of [["deck-binary", "deck-spike001"], ["deck-binary", "maplibre"], ["deck-spike001", "maplibre"]]) {
    const r = await diff(shots[`${v.id}|${a}`], shots[`${v.id}|${b}`]);
    if (r.png && r.share > 0.0005) writeFileSync(resolve(imgDir, `render-diff-${v.id}-${a}-vs-${b}.png`), Buffer.from(r.png));
    delete r.png;
    results.push({ view: v.id, a, b, ...r });
    console.log(`${v.id.padEnd(22)} ${a} vs ${b}: ${r.differingPixels} px (${(r.share * 100).toFixed(4)}%) ${r.bbox ? "bbox " + r.bbox.join(",") : ""}`);
  }
}
await browser.close();
await server.close();
const out = resolve(repo, `docs/spikes/results/${new Date().toISOString().slice(0, 10)}-render-${label}.json`);
writeFileSync(out, JSON.stringify({ threshold: THRESHOLD, viewport: [1440, 900], views: VIEWS, results }, null, 1) + "\n");
console.log(`-> ${out.replace(repo + "/", "")}`);
