#!/usr/bin/env node
/**
 * Application smoke test (milestone 1.3): opens the real app in local Chrome (playwright-core, no download),
 * waits for real readiness, drives the main interactions and saves a screenshot per step.
 *
 *   node bench/smoke.mjs [--out DIR] [--headed] [--steps load,select,overlap,sample,flat,dissolve]
 *
 * Fails (exit 1) on page errors, console errors, a missing first correct pick, or a failed assertion.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";
import { createServer } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : process.argv[i + 1]; };
const out = resolve(arg("out", resolve(repo, "docs/spikes/img/m13")));
const steps = arg("steps", "load,select,overlap,sample,flat,dissolve").split(",");
mkdirSync(out, { recursive: true });

const server = await createServer({ configFile: resolve(here, "../vite.config.ts"), root: resolve(here, ".."), logLevel: "warn" });
await server.listen();
const base = `http://localhost:${server.config.server.port}`;
const browser = await chromium.launch({ channel: "chrome", headless: !process.argv.includes("--headed"),
                                        args: ["--ignore-gpu-blocklist", "--enable-gpu-rasterization"] });
const report = { steps: [], errors: [], warnings: [] };
const fail = (m) => { report.errors.push(m); };
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  page.on("pageerror", (e) => fail(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") fail(`console: ${m.text()}`.slice(0, 400));
    else if (m.type() === "warning") report.warnings.push(m.text().slice(0, 300));
  });
  const responses = [];
  page.on("response", (r) => { if (r.status() >= 400) report.warnings.push(`HTTP ${r.status()} ${r.url().replace(base, "")}`); });
  page.on("response", (r) => { if (/geometry\.|bundle\.json|catalog\./.test(r.url())) responses.push({ url: r.url().replace(base, ""), status: r.status(), encoding: r.headers()["content-encoding"] ?? null, cache: r.headers()["cache-control"] ?? null }); });
  const shot = async (name) => { await page.waitForTimeout(400); await page.screenshot({ path: resolve(out, `${name}.png`) }); };
  const t0 = Date.now();
  await page.goto(`${base}/?step=1#t=117&c=30.000,32.000,1.55`);
  await page.waitForFunction(() => window.__CHRONOS__ || document.querySelector('[role="status"]')?.textContent?.includes("Could not"), null, { timeout: 60_000 });
  const ready = await page.evaluate(() => window.__CHRONOS__ ? { readyMs: window.__CHRONOS__.readyMs, timings: window.__CHRONOS__.timings } : null);
  if (!ready) fail("app did not become ready");
  report.load = { ...ready, wallMs: Date.now() - t0, responses };
  if (steps.includes("load")) { await shot("01-117ce-globe"); report.steps.push("load"); }
  const engine = (fn, ...a) => page.evaluate(fn, ...a);

  if (steps.includes("select")) {
    // Click on Rome's territory near Rome itself at 117 CE: the Roman Empire should be selected and outlined.
    const p = await engine(() => { const m = window.__CHRONOS__.engine.map; m.jumpTo({ center: [14, 40], zoom: 3.6 }); return null; });
    await page.waitForTimeout(800);
    const xy = await engine(() => { const pt = window.__CHRONOS__.engine.map.project([12.4964, 41.9028]); return [pt.x, pt.y]; });
    await page.mouse.click(xy[0], xy[1]);
    await page.waitForTimeout(600);
    const title = await page.locator("article h2").first().textContent().catch(() => null);
    if (!title?.includes("Roman Empire")) fail(`select: expected the Roman Empire card, got ${title}`);
    await shot("02-select-roman-empire");
    report.steps.push({ select: title, p });
  }
  if (steps.includes("overlap")) {
    // 420 CE: Kidarites and White Huns overlap by about 488,000 km2 (QA-004). The overlap must render striped.
    await engine(() => { const e = window.__CHRONOS__.engine; e.map.jumpTo({ center: [66, 37], zoom: 3.8 }); });
    await page.keyboard.press("Escape");
    await page.goto(`${base}/?step=2#t=420&c=66.000,37.000,3.80`);
    await page.waitForFunction(() => window.__CHRONOS__, null, { timeout: 60_000 });
    await shot("03-overlap-420ce");
    report.steps.push("overlap");
  }
  if (steps.includes("sample")) {
    await page.goto(`${base}/?step=3#t=1500&c=12.500,41.900,4.50&s=12.4964,41.9028`);
    await page.waitForFunction(() => window.__CHRONOS__, null, { timeout: 60_000 });
    await page.waitForTimeout(500);
    await page.getByRole("tab", { name: "Core sample" }).click().catch(() => fail("sample: no core sample tab"));
    await page.waitForTimeout(400);
    const n = await page.locator('ol[aria-label="Strata, newest first"] li').count();
    if (n < 20) fail(`sample: expected about 22 strata and 2 gaps at Rome, got ${n} list items`);
    await shot("04-core-sample-rome");
    report.steps.push({ sample: n });
  }
  if (steps.includes("flat")) {
    await page.goto(`${base}/?step=4#t=1914&c=20.000,20.000,1.40&proj=flat`);
    await page.waitForFunction(() => window.__CHRONOS__, null, { timeout: 60_000 });
    await shot("05-flat-1914");
    report.steps.push("flat");
  }
  if (steps.includes("dissolve")) {
    await page.goto(`${base}/?step=5#t=1500&c=15.000,48.000,3.20`);
    await page.waitForFunction(() => window.__CHRONOS__, null, { timeout: 60_000 });
    await page.keyboard.press("Alt+ArrowRight");
    const mid = await engine(() => new Promise((r) => setTimeout(() => r(window.__CHRONOS__.engine.isCurrent()), 60)));
    await page.screenshot({ path: resolve(out, "06-dissolve-mid.png") });
    await page.waitForTimeout(400);
    const done = await engine(() => [window.__CHRONOS__.engine.isCurrent(), window.__CHRONOS__.engine.year]);
    if (mid !== false || done[0] !== true || done[1] !== 1600) fail(`dissolve: mid ${mid}, after ${JSON.stringify(done)}`);
    await shot("07-after-dissolve-1600");
    report.steps.push({ dissolve: { mid, done } });
  }
} finally {
  await browser.close();
  await server.close();
}
writeFileSync(resolve(out, "smoke.json"), JSON.stringify(report, null, 1) + "\n");
console.log(JSON.stringify({ load: report.load, steps: report.steps, errors: report.errors, warnings: report.warnings.slice(0, 8) }, null, 1));
process.exit(report.errors.length ? 1 : 0);
