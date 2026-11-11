#!/usr/bin/env node
/**
 * Reproducible engine benchmark runner (milestone 1.1).
 *
 *   node bench/run.mjs [--engines app,deck,maplibre] [--reps 3] [--picks 10000] [--step 5] [--headed] [--label m2]
 *
 * Engine "app" (milestone 1.3) is the real application (index.html?bench=1): the same protocol runs against the
 * React UI, the Strata stage and the StrataExtension layers, opened at the protocol's view (117 CE, 30 E 30 N).
 *
 * Starts the Vite dev server (serving data/build/current), drives the locally installed Google Chrome
 * through playwright-core (no browser download), runs the protocol in src/bench/protocol.ts for each
 * engine and repetition, saves a 117 CE screenshot per engine, and writes everything to docs/spikes/results/.
 */
import { execFileSync } from "node:child_process";
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
const variants = arg("variants", "binary").split(",");   // deck.gl variants (see src/bench/engines.ts)
const cycles = Number(arg("cycles", "5"));
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


function footprints() {
  const ps = execFileSync("ps", ["-axo", "pid=,rss=,command="], { encoding: "utf8" });
  const dir = ps.split("\n").map((l) => l.match(/--user-data-dir=(\S*playwright_chromiumdev_profile-\S+)/)).find(Boolean)?.[1];
  const out = {};
  for (const line of ps.split("\n")) {
    if (!dir || !line.includes(dir)) continue;
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const type = m[3].match(/--type=([\w-]+)/)?.[1] ?? "browser";
    let fp = null;
    try {
      const t = execFileSync("footprint", ["-p", m[1]], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const f = t.match(/Footprint:\s*([\d.]+)\s*(KB|MB|GB)/);
      if (f) fp = Math.round(Number(f[1]) * { KB: 1 / 1024, MB: 1, GB: 1024 }[f[2]]);
    } catch { /* unavailable */ }
    out[type] = (out[type] ?? 0) + (fp ?? 0);
  }
  return out;
}

const runs = [];
try {
  const plan = engines.flatMap((e) => (e === "deck" ? variants.map((v) => [e, v]) : [[e, null]]));
  for (const [engine, variant] of plan) {
    for (let rep = 1; rep <= reps; rep++) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
      const logs = [];
      page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") logs.push(`${m.type()}: ${m.text()}`.slice(0, 300)); });
      page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`.slice(0, 300)));
      // Fail fast: any uncaught error or a worker load failure ends the run instead of waiting for the timeout.
      page.on("console", (m) => { if (m.type() === "error" && /Worker failed|WebGL|context lost/i.test(m.text())) void page.evaluate((t) => { window.__BENCH_ERROR__ = t; }, m.text()).catch(() => {}); });
      const t0 = Date.now();
      const url = engine === "app"
        ? `${base}/?test=1&bench=1&run=1&picks=${picks}&step=${step}&cycles=${cycles}${extra}#t=117&c=30.000,30.000,1.40`
        : `${base}/bench.html?engine=${engine}${variant ? `&variant=${variant}` : ""}&run=1&picks=${picks}&step=${step}&cycles=${cycles}${extra}`;
      await page.goto(url);
      await page.waitForFunction(() => window.__BENCH__ || window.__BENCH_ERROR__, null, { timeout: timeoutMs, polling: 1000 });
      const res = await page.evaluate(() => window.__BENCH__ ?? { error: window.__BENCH_ERROR__ });
      // Memory after the protocol: forced GC through DevTools, then on-heap and ArrayBuffer backing stores separately.
      try {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("HeapProfiler.collectGarbage");
        await page.waitForTimeout(500);
        await cdp.send("HeapProfiler.collectGarbage");
        const u = await cdp.send("Runtime.getHeapUsage");
        const mb = (b) => Math.round(((b ?? 0) / 1048576) * 10) / 10;
        res.memoryAfterProtocol = { jsHeapNoGcMB: res.jsHeapMB ?? null, onHeapAfterGcMB: mb(u.usedSize),
                                    arrayBuffersAfterGcMB: mb(u.backingStorageSize), totalAfterGcMB: mb((u.usedSize ?? 0) + (u.backingStorageSize ?? 0)),
                                    processes: footprints() };
        await cdp.detach();
      } catch (e) { res.memoryAfterProtocol = { error: String(e) }; }
      if (rep === 1) {
        await page.evaluate(() => new Promise((r) => setTimeout(r, 1500)));
        await page.screenshot({ path: resolve(imgDir, `${label}-${engine}${variant ? "-" + variant : ""}-117ce.png`) });
      }
      runs.push({ rep, variant, wallMs: Date.now() - t0, consoleIssues: logs.slice(0, 20), ...res });
      const s = res.sweep?.frames;
      if (!res.error && !s) { console.log(`${engine} #${rep}: load ${JSON.stringify(res.load)} heap ${res.jsHeapMB} MB`); await page.close(); continue; }
      const mem = res.memoryAfterProtocol ?? {};
      console.log(`${engine}${variant ? "/" + variant : ""} #${rep}: ${res.error ? "ERROR " + res.error.slice(0, 200) :
        `tti ${res.load.timeToInteractiveMs} ms | sweep p50 ${s.p50} p95 ${s.p95} ms jank ${(s.jankShare * 100).toFixed(1)}% stale ${(res.sweep.staleShare * 100).toFixed(1)}% | ` +
        `europe p95 ${res.regionalSweep.frames.p95} stale ${(res.regionalSweep.staleShare * 100).toFixed(1)}% | ` +
        `latency p50 ${res.latencyMs.p50} p95 ${res.latencyMs.p95} ms | picks ${res.picks.correct}/${res.picks.n} | ` +
        `first pick ${res.load.timeToFirstCorrectPickMs} ms | explore p95 ${res.explore?.frames?.p95} stale ${((res.explore?.staleShare ?? 0) * 100).toFixed(1)}% | ` +
        `heap no-GC ${res.jsHeapMB} MB, after GC ${mem.onHeapAfterGcMB}+${mem.arrayBuffersAfterGcMB} MB | endurance heap ${(res.endurance?.results ?? []).map((c) => c.heapMB).join("/")}`}`);
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
  options: { engines, variants, reps, picks, step, cycles, headed, query: extra }, runs }, null, 1) + "\n");
console.log(`results -> ${file.replace(repo + "/", "")}`);
