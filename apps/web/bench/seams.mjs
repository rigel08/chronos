#!/usr/bin/env node
/**
 * Grid-seam investigation (milestone 1.3, spike 002 §7). Spike 002 found two short lines (1500 CE, Europe view)
 * where deck.gl and MapLibre disagree. This script locates every line-like cluster of differing pixels in that
 * view, unprojects it to lon/lat, then renders both engines zoomed in on each spot (zoom 8) and records which
 * engine shows what on the line. Pixels and coordinates go to seams.json for the edge analysis.
 *
 *   node bench/seams.mjs [--out DIR] [--year 1500] [--lon 10] [--lat 48] [--zoom 4]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";
import { createServer } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : process.argv[i + 1]; };
const out = resolve(arg("out", resolve(repo, "docs/spikes/img/m13-seams")));
const view = { lon: Number(arg("lon", 10)), lat: Number(arg("lat", 48)), zoom: Number(arg("zoom", 4)), year: Number(arg("year", 1500)) };
mkdirSync(out, { recursive: true });
const THRESHOLD = 24;
const DECKQ = arg("deckq", "");          // extra deck.gl query, e.g. "&cull=none" to test the culling hypothesis

const server = await createServer({ configFile: resolve(here, "../vite.config.ts"), root: resolve(here, ".."), logLevel: "warn" });
await server.listen();
const base = `http://localhost:${server.config.server.port}`;
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--ignore-gpu-blocklist"] });

async function render(q, v) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await page.goto(`${base}/bench.html?${q}&mode=load&lon=${v.lon}&lat=${v.lat}&zoom=${v.zoom}&year=${v.year}`);
  await page.waitForFunction(() => window.__BENCH__ || window.__BENCH_ERROR__, null, { timeout: 180000 });
  await page.waitForTimeout(2500);
  await page.addStyleTag({ content: "#bar, #out { display: none !important; }" });
  await page.waitForTimeout(300);
  return page;
}

async function differing(page, a, b) {
  return page.evaluate(async ([a64, b64, thr]) => {
    const load = async (s) => createImageBitmap(await (await fetch(`data:image/png;base64,${s}`)).blob());
    const [ia, ib] = await Promise.all([load(a64), load(b64)]);
    const w = ia.width, h = ia.height;
    const px = (img) => { const c = new OffscreenCanvas(w, h); const x = c.getContext("2d"); x.drawImage(img, 0, 0); return x.getImageData(0, 0, w, h).data; };
    const da = px(ia), db = px(ib);
    const pts = [];
    for (let i = 0; i < da.length; i += 4) {
      if (Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2])) > thr) {
        const p = i / 4;
        pts.push([p % w, Math.floor(p / w), da[i], da[i + 1], da[i + 2], db[i], db[i + 1], db[i + 2]]);
      }
    }
    return pts;
  }, [a.toString("base64"), b.toString("base64"), THRESHOLD]);
}

const report = { view, threshold: THRESHOLD, clusters: [], zoomed: [] };
try {
  const deck = await render(`engine=deck&variant=binary${DECKQ}`, view);
  const ml = await render("engine=maplibre", view);
  const a = await deck.screenshot();
  const b = await ml.screenshot();
  writeFileSync(resolve(out, "overview-deck.png"), a);
  writeFileSync(resolve(out, "overview-maplibre.png"), b);
  const pts = await differing(deck, a, b);
  report.differingPixels = pts.length;
  // Line-like clusters: 24 px cells holding >= 10 differing pixels; neighbouring cells merged.
  const cell = new Map();
  for (const p of pts) { const k = `${Math.floor(p[0] / 24)},${Math.floor(p[1] / 24)}`; (cell.get(k) ?? cell.set(k, []).get(k)).push(p); }
  const dense = [...cell.entries()].filter(([, v]) => v.length >= 10);
  const seen = new Set();
  for (const [k] of dense) {
    if (seen.has(k)) continue;
    const stack = [k];
    const members = [];
    while (stack.length) {
      const c = stack.pop();
      if (seen.has(c) || !cell.has(c) || cell.get(c).length < 10) continue;
      seen.add(c);
      members.push(...cell.get(c));
      const [x, y] = c.split(",").map(Number);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) stack.push(`${x + dx},${y + dy}`);
    }
    const xs = members.map((m) => m[0]), ys = members.map((m) => m[1]);
    const bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    const cx = (bbox[0] + bbox[2]) / 2, cy = (bbox[1] + bbox[3]) / 2;
    const [lon, lat] = await deck.evaluate(([x, y]) => { const ll = window.__BENCH_MAP__.unproject([x, y]); return [ll.lng, ll.lat]; }, [cx, cy]);
    const ends = await deck.evaluate(([b]) => [window.__BENCH_MAP__.unproject([b[0], b[1]]), window.__BENCH_MAP__.unproject([b[2], b[3]])].map((ll) => [ll.lng, ll.lat]), [bbox]);
    const sample = members.slice(0, 6).map((m) => ({ px: [m[0], m[1]], deck: m.slice(2, 5), maplibre: m.slice(5, 8) }));
    report.clusters.push({ pixels: members.length, bbox, center: [lon, lat], bboxLonLat: ends, sample });
  }
  await deck.close();
  await ml.close();
  // Zoom in on every cluster with both engines.
  for (const [i, c] of report.clusters.entries()) {
    const v = { lon: c.center[0], lat: c.center[1], zoom: 8, year: view.year };
    const dz = await render(`engine=deck&variant=binary${DECKQ}`, v);
    const mz = await render("engine=maplibre", v);
    const za = await dz.screenshot();
    const zb = await mz.screenshot();
    writeFileSync(resolve(out, `seam-${i}-deck.png`), za);
    writeFileSync(resolve(out, `seam-${i}-maplibre.png`), zb);
    const zp = await differing(dz, za, zb);
    // Where do the engines disagree on the ground? Unproject an evenly spaced subset of the differing pixels.
    const step = Math.max(1, Math.floor(zp.length / 12));
    const probes = zp.filter((_, k) => k % step === 0).slice(0, 12);
    const lonlat = await dz.evaluate((ps) => ps.map(([x, y]) => { const l = window.__BENCH_MAP__.unproject([x, y]); return [l.lng, l.lat]; }), probes.map((m) => [m[0], m[1]]));
    report.zoomed.push({ cluster: i, view: v, differingPixels: zp.length,
                         sample: probes.map((m, k) => ({ px: [m[0], m[1]], lonlat: lonlat[k], deck: m.slice(2, 5), maplibre: m.slice(5, 8) })) });
    await dz.close();
    await mz.close();
  }
} finally {
  await browser.close();
  await server.close();
}
writeFileSync(resolve(out, "seams.json"), JSON.stringify(report, null, 1) + "\n");
console.log(JSON.stringify({ differingPixels: report.differingPixels, clusters: report.clusters.map((c) => ({ pixels: c.pixels, center: c.center.map((x) => +x.toFixed(3)), bboxLonLat: c.bboxLonLat.map((p) => p.map((x) => +x.toFixed(3))), sample: c.sample.slice(0, 2) })), zoomed: report.zoomed.map((z) => ({ cluster: z.cluster, differingPixels: z.differingPixels, sample: z.sample.slice(0, 3) })) }, null, 1));
