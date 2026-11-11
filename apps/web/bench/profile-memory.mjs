#!/usr/bin/env node
/**
 * Memory profiler (milestone 1.2). Attributes the renderer's memory instead of guessing.
 *
 *   node bench/profile-memory.mjs [--engine deck] [--variant default] [--protocol] [--label name]
 *
 * For one engine it records, in local Chrome with --expose-gc:
 *   1. staged retained JS heap (forced GC) from the page's probes: page start, bundle decoded, map loaded,
 *      engine-specific stages, first correct pick, and (with --protocol) after the full benchmark protocol;
 *   2. CDP Runtime.getHeapUsage: on-heap used size AND ArrayBuffer backing stores (external to the JS heap);
 *   3. a sampling heap profile of live objects, aggregated by allocating function and by package;
 *   4. physical footprint of every Chrome process of this run (renderer, GPU, browser), via `footprint`.
 * Writes docs/spikes/results/<date>-memory-<label>.json.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";
import { createServer } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : process.argv[i + 1]; };
const engine = arg("engine", "deck");
const variant = arg("variant", "");
const label = arg("label", `${engine}${variant ? "-" + variant : ""}`);
const protocol = process.argv.includes("--protocol");

const server = await createServer({ configFile: resolve(here, "../vite.config.ts"), root: resolve(here, ".."), logLevel: "warn" });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true,
  args: ["--js-flags=--expose-gc", "--enable-precise-memory-info", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const cdp = await page.context().newCDPSession(page);
await cdp.send("HeapProfiler.enable");
await cdp.send("HeapProfiler.startSampling", { samplingInterval: 16384 });

const q = `engine=${engine}&probe=1${variant ? `&variant=${variant}` : ""}${protocol ? "&run=1" : "&mode=load"}`;
await page.goto(`http://localhost:${server.config.server.port}/bench.html?${q}`);
await page.waitForFunction(() => window.__BENCH__ || window.__BENCH_ERROR__, null, { timeout: 30 * 60 * 1000, polling: 1000 });
const bench = await page.evaluate(() => window.__BENCH__ ?? { error: window.__BENCH_ERROR__ });
if (bench.error) throw new Error(bench.error);

// --- typed arrays held by deck.gl (only when the deck engine exposed its overlay) ---------------------
const deckBuffers = await page.evaluate(() => {
  const ov = globalThis.__CHRONOS_OVERLAY__;
  const deck = ov?._deck;
  if (!deck) return null;
  const mb = (n) => Math.round((n / 1048576) * 10) / 10;
  const seen = new Set();
  const size = (v) => {
    if (!v || !ArrayBuffer.isView(v)) return 0;
    if (seen.has(v.buffer)) return 0;        // count each backing store once
    seen.add(v.buffer);
    return v.buffer.byteLength;
  };
  const out = { attributes: {}, tesselator: {}, pool: 0, input: 0 };
  for (const layer of deck.layerManager.getLayers()) {
    const am = layer.getAttributeManager?.();
    for (const [name, attr] of Object.entries(am?.getAttributes?.() ?? {})) {
      const b = size(attr.value) + size(attr.value64Low ?? attr.state?.value64Low);
      if (b) out.attributes[`${layer.id}.${name}:${attr.value?.constructor?.name}`] = mb(b);
    }
    const tess = layer.state?.polygonTesselator;
    for (const [name, v] of Object.entries(tess?.attributes ?? {})) {
      const b = size(v);
      if (b) out.tesselator[`${name}:${v.constructor.name}`] = mb(b);
    }
    for (const [name, v] of Object.entries(tess ?? {})) {
      if (ArrayBuffer.isView(v)) { const b = size(v); if (b) out.tesselator[`${name}:${v.constructor.name}`] = mb(b); }
    }
  }
  const pool = deck.layerManager?.context?.typedArrayManager?._pool ?? globalThis.__deckTypedArrayPool;
  if (Array.isArray(pool)) out.pool = mb(pool.reduce((a, v) => a + size(v), 0));
  return out;
});

await cdp.send("HeapProfiler.collectGarbage");
const usage = await cdp.send("Runtime.getHeapUsage");
const { profile } = await cdp.send("HeapProfiler.getSamplingProfile");
await cdp.send("HeapProfiler.stopSampling");

// --- aggregate the sampling profile (live objects) ---------------------------------------------------
const byFunction = new Map();
const byPackage = new Map();
const pkgOf = (url) => {
  if (!url) return "(native/V8)";
  const m = url.match(/node_modules\/(?:\.vite\/deps\/)?((?:@[^/]+\/)?[^/?]+)/);
  if (m) return m[1].replace(/_\w+$/, "");
  if (url.includes("/src/")) return "chronos src";
  return url.replace(/^https?:\/\/[^/]+/, "").slice(0, 60);
};
let total = 0;
(function walk(node, stack) {
  const fr = node.callFrame;
  const here = { fn: fr.functionName || "(anonymous)", url: fr.url, line: fr.lineNumber };
  const st = [...stack, here];
  if (node.selfSize) {
    total += node.selfSize;
    const key = `${here.fn} @ ${pkgOf(here.url)}:${here.line + 1}`;
    byFunction.set(key, (byFunction.get(key) ?? 0) + node.selfSize);
    // attribute to the innermost frame that is not V8/native, so builtins count toward their caller's package
    const owner = [...st].reverse().find((f) => f.url) ?? here;
    const pkg = pkgOf(owner.url);
    byPackage.set(pkg, (byPackage.get(pkg) ?? 0) + node.selfSize);
  }
  for (const c of node.children ?? []) walk(c, st);
})(profile.head, []);
const toMB = (b) => Math.round((b / 1048576) * 10) / 10;
const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ key: k, MB: toMB(v) }));

// --- process footprints (renderer, GPU, browser) -----------------------------------------------------
function footprints() {
  const ps = execFileSync("ps", ["-axo", "pid=,rss=,command="], { encoding: "utf8" });
  const dir = ps.split("\n").map((l) => l.match(/--user-data-dir=(\S*playwright_chromiumdev_profile-\S+)/)).find(Boolean)?.[1];
  const rows = [];
  for (const line of ps.split("\n")) {
    if (!dir || !line.includes(dir) && !line.includes("Google Chrome Helper")) continue;
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const [, pid, rss, cmd] = m;
    if (!cmd.includes(dir)) continue;
    const type = cmd.match(/--type=([\w-]+)/)?.[1] ?? "browser";
    let footprintMB = null;
    try {
      const fp = execFileSync("footprint", ["-p", pid], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const fm = fp.match(/Footprint:\s*([\d.]+)\s*(KB|MB|GB)/);
      if (fm) footprintMB = Math.round(Number(fm[1]) * { KB: 1 / 1024, MB: 1, GB: 1024 }[fm[2]]);
    } catch { /* footprint unavailable */ }
    rows.push({ pid: Number(pid), type, rssMB: Math.round(Number(rss) / 1024), footprintMB });
  }
  return rows;
}
const procs = footprints();

const result = {
  engine, variant: variant || "default", protocol, release: bench.release,
  memoryStages: bench.memoryStages, load: bench.load,
  heapAfterProtocolNoGcMB: bench.jsHeapMB ?? null, heapAfterProtocolGcMB: bench.jsHeapAfterGcMB ?? null,
  cdpHeapUsage: { usedMB: toMB(usage.usedSize), totalMB: toMB(usage.totalSize),
                  embedderMB: toMB(usage.embedderHeapUsedSize ?? 0), arrayBufferBackingStoresMB: toMB(usage.backingStorageSize ?? 0) },
  samplingProfile: { liveSampledMB: toMB(total), byPackage: top(byPackage, 12), byFunction: top(byFunction, 25) },
  deckBuffers,
  processes: procs,
  processTotals: {
    rssMB: procs.reduce((a, p) => a + p.rssMB, 0),
    footprintMB: procs.every((p) => p.footprintMB !== null) ? procs.reduce((a, p) => a + p.footprintMB, 0) : null,
  },
  picks: bench.picks ? { correct: bench.picks.correct, n: bench.picks.n } : null,
};
await browser.close();
await server.close();
mkdirSync(resolve(repo, "docs/spikes/results"), { recursive: true });
const out = resolve(repo, `docs/spikes/results/${new Date().toISOString().slice(0, 10)}-memory-${label}.json`);
writeFileSync(out, JSON.stringify(result, null, 1) + "\n");
console.log(JSON.stringify({ deckBuffers, stages: result.memoryStages.map((s) => `${s.label}: ${s.usedMB} MB`), cdp: result.cdpHeapUsage,
  byPackage: result.samplingProfile.byPackage.slice(0, 8), byFunction: result.samplingProfile.byFunction.slice(0, 12),
  processes: result.processes, totals: result.processTotals, heapAfterProtocol: [result.heapAfterProtocolNoGcMB, result.heapAfterProtocolGcMB], picks: result.picks }, null, 1));
console.log(`-> ${out.replace(repo + "/", "")}`);
