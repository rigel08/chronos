#!/usr/bin/env node
/**
 * Render agreement of the application (milestone 1.3): does the app draw exactly the territory coverage the 1.2
 * binary path draws? Both render in mask mode (territories white on black, no basemap, atmosphere or overlap
 * stripes) at the six views of spike 002 plus 420 CE; the app's UI is hidden. Counts differing pixels.
 *
 *   node bench/agreement.mjs [--label name]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";
import { createServer } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : process.argv[i + 1]; };
const label = arg("label", "m2-chrome157-headless");
const THRESHOLD = 24;
const VIEWS = [
  { id: "117ce-globe", lon: 30, lat: 30, zoom: 1.4, year: 117 },
  { id: "1914-pacific-far-side", lon: -160, lat: 0, zoom: 1.4, year: 1914 },
  { id: "1500-europe", lon: 10, lat: 48, zoom: 4, year: 1500 },
  { id: "500bce-near-east", lon: 45, lat: 33, zoom: 3.5, year: -499 },
  { id: "1765-mughal-area", lon: 73.54, lat: 24.78, zoom: 7, year: 1765 },
  { id: "1265-lithuania-area", lon: 24, lat: 55, zoom: 5, year: 1265 },
  { id: "420ce-central-asia", lon: 66, lat: 37, zoom: 3.8, year: 420 },
];

const server = await createServer({ configFile: resolve(here, "../vite.config.ts"), root: resolve(here, ".."), logLevel: "warn" });
await server.listen();
const base = `http://localhost:${server.config.server.port}`;
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--ignore-gpu-blocklist"] });

async function shot(url, ready, hideCss) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await page.goto(url);
  await page.waitForFunction(ready, null, { timeout: 180000 });
  await page.addStyleTag({ content: hideCss });
  await page.waitForTimeout(2500);
  const png = await page.screenshot({ type: "png" });
  await page.close();
  return png;
}

const results = [];
const imgDir = resolve(repo, "docs/spikes/img/m13");
mkdirSync(imgDir, { recursive: true });
const cmp = await browser.newPage();
try {
  for (const v of VIEWS) {
    const app = await shot(`${base}/?test=1&mask=1#t=${v.year}&c=${v.lon.toFixed(3)},${v.lat.toFixed(3)},${v.zoom.toFixed(2)}`,
                           () => window.__CHRONOS__, "#root > div > *:not(:has([role=application])) { display: none !important; }");
    const harness = await shot(`${base}/bench.html?engine=deck&variant=binary&mask=1&mode=load&lon=${v.lon}&lat=${v.lat}&zoom=${v.zoom}&year=${v.year}`,
                               () => window.__BENCH__ || window.__BENCH_ERROR__, "#bar, #out { display: none !important; }");
    const r = await cmp.evaluate(async ([a64, b64, thr]) => {
      const load = async (s) => createImageBitmap(await (await fetch(`data:image/png;base64,${s}`)).blob());
      const [ia, ib] = await Promise.all([load(a64), load(b64)]);
      const w = ia.width, h = ia.height;
      const px = (img) => { const c = new OffscreenCanvas(w, h); const x = c.getContext("2d"); x.drawImage(img, 0, 0); return x.getImageData(0, 0, w, h).data; };
      const da = px(ia), db = px(ib);
      let n = 0, covered = 0;
      for (let i = 0; i < da.length; i += 4) {
        if (da[i] > 127) covered++;
        if (Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2])) > thr) n++;
      }
      return { differingPixels: n, share: Math.round((n / (w * h)) * 1e6) / 1e6, coveredPixels: covered };
    }, [app.toString("base64"), harness.toString("base64"), THRESHOLD]);
    results.push({ view: v.id, ...r });
    console.log(`${v.id.padEnd(24)} app vs 1.2 binary path: ${r.differingPixels} px differ (${(r.share * 100).toFixed(4)}%), ${r.coveredPixels} px covered`);
    if (v.id === "420ce-central-asia") writeFileSync(resolve(imgDir, "agreement-420ce-app-mask.png"), app);
  }
} finally {
  await browser.close();
  await server.close();
}
const out = resolve(repo, `docs/spikes/results/${new Date().toISOString().slice(0, 10)}-agreement-${label}.json`);
writeFileSync(out, JSON.stringify({ threshold: THRESHOLD, viewport: [1440, 900], views: VIEWS, results }, null, 1) + "\n");
console.log(`-> ${out.replace(repo + "/", "")}`);
