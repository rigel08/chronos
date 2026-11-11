#!/usr/bin/env node
/**
 * Reproducible engine benchmark runner (milestone 1.1).
 *
 *   node bench/run.mjs [--engines deck,maplibre] [--reps 3] [--picks 10000] [--step 5] [--headed] [--label m2]
 *
 * Starts the Vite dev server (serving data/build/current), drives the locally installed Google Chrome
 * through playwright-core (no browser download), runs the protocol in src/bench/protocol.ts for each
 * engine and repetition, saves a 117 CE screenshot per engine, and writes everything to docs/spikes/results/.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";
import { createServer } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? dflt : process.argv[i + 1];
};
const flag = (name) => process.argv.includes(`--${name}`);
const engines = arg("engines", "deck,maplibre").split(",");
const reps = Number(arg("reps", "3"));
const picks = Number(arg("picks", "10000"));
const step = Number(arg("step", "5"));
const headed = flag("headed");
const label = arg("label", headed ? "chrome-headed" : "chrome-headless");
const timeoutMs = Number(arg("timeout", String(20 * 60 * 1000)));
const extra = arg("query", "");

const outDir = resolve(repo, "docs/spikes/results");
const imgDir = resolve(repo, "docs/spikes/img");
mkdirSync(outDir, { recursive: true });
mkdirSync(imgDir, { recursive: true });

const server = await createServer({ configFile: resolve(here, "../vite.config.ts"), root: resolve(here, ".."), logLevel: "warn" });
await server.listen();
const base = `http://localhost:${server.config.server.port}`;
const browser = await chromium.launch({
  channel: "chrome", headless: !headed,
  args: ["--ignore-gpu-blocklist", "--enable-gpu-rasterization", "--disable-renderer-backgrounding",
         "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--enable-precise-memory-info"],
});

const runs = [];
try {
  for (const engine of engines) {
    for (let rep = 1; rep <= reps; rep++) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
      const logs = [];
      page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") logs.push(`${m.type()}: ${m.text()}`.slice(0, 300)); });
      page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`.slice(0, 300)));
      // Fail fast: any uncaught error or a worker load failure ends the run instead of waiting for the timeout.
      page.on("console", (m) => { if (m.type() === "error" && /Worker failed|WebGL|context lost/i.test(m.text())) void page.evaluate((t) => { window.__BENCH_ERROR__ = t; }, m.text()).catch(() => {}); });
      const t0 = Date.now();
      await page.goto(`${base}/bench.html?engine=${engine}&run=1&picks=${picks}&step=${step}${extra}`);
      await page.waitForFunction(() => window.__BENCH__ || window.__BENCH_ERROR__, null, { timeout: timeoutMs, polling: 1000 });
      const res = await page.evaluate(() => window.__BENCH__ ?? { error: window.__BENCH_ERROR__ });
      if (rep === 1) {
        await page.evaluate(() => new Promise((r) => setTimeout(r, 1500)));
        await page.screenshot({ path: resolve(imgDir, `${label}-${engine}-117ce.png`) });
      }
      runs.push({ rep, wallMs: Date.now() - t0, consoleIssues: logs.slice(0, 20), ...res });
      const s = res.sweep?.frames;
      if (!res.error && !s) { console.log(`${engine} #${rep}: load ${JSON.stringify(res.load)} heap ${res.jsHeapMB} MB`); await page.close(); continue; }
      console.log(`${engine} #${rep}: ${res.error ? "ERROR " + res.error.slice(0, 200) :
        `tti ${res.load.timeToInteractiveMs} ms | sweep p50 ${s.p50} p95 ${s.p95} ms jank ${(s.jankShare * 100).toFixed(1)}% stale ${(res.sweep.staleShare * 100).toFixed(1)}% | ` +
        `europe p95 ${res.regionalSweep.frames.p95} stale ${(res.regionalSweep.staleShare * 100).toFixed(1)}% | ` +
        `latency p50 ${res.latencyMs.p50} p95 ${res.latencyMs.p95} ms | picks ${res.picks.correct}/${res.picks.n} | heap ${res.jsHeapMB} MB`}`);
      await page.close();
    }
  }
} finally {
  await browser.close();
  await server.close();
}

const bundle = JSON.parse(readFileSync(resolve(repo, "data/build/current/bundle.json"), "utf8"));
const stamp = new Date().toISOString().slice(0, 10);
const file = resolve(outDir, `${stamp}-${label}${extra.includes("mode=load") ? "" : picks < 10000 || step !== 5 ? "-quick" : ""}.json`);
writeFileSync(file, JSON.stringify({ label, release: bundle.release_id, chrome: browser.version?.() ?? null,
  options: { engines, reps, picks, step, headed, query: extra }, runs }, null, 1) + "\n");
console.log(`results -> ${file.replace(repo + "/", "")}`);
