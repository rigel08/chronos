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
import { build, createServer, preview } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : process.argv[i + 1]; };
const out = resolve(arg("out", resolve(here, "out/smoke")));       // git-ignored; pass --out to keep a record elsewhere
const steps = arg("steps", "load,uploads,claimants,select,overlap,sample,flat,dissolve").split(",");
mkdirSync(out, { recursive: true });

// --preview: run against the production build (vite build + vite preview) instead of the dev server.
const usePreview = process.argv.includes("--preview");
let server;
let base;
if (usePreview) {
  await build({ configFile: resolve(here, "../vite.config.ts"), root: resolve(here, ".."), logLevel: "warn" });
  server = await preview({ configFile: resolve(here, "../vite.config.ts"), root: resolve(here, ".."), logLevel: "warn" });
  base = server.resolvedUrls.local[0].replace(/\/$/, "");
} else {
  server = await createServer({ configFile: resolve(here, "../vite.config.ts"), root: resolve(here, ".."), logLevel: "warn" });
  await server.listen();
  base = `http://localhost:${server.config.server.port}`;
}
const browser = await chromium.launch({ channel: "chrome", headless: !process.argv.includes("--headed"),
                                        args: ["--ignore-gpu-blocklist", "--enable-gpu-rasterization"] });
const report = { build: usePreview ? "production (vite preview)" : "dev server", steps: [], errors: [], warnings: [] };
const fail = (m) => { report.errors.push(m); };
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  page.on("pageerror", (e) => fail(`pageerror: ${e.message}`));
  // Count bytes uploaded to GPU buffers, to show that time, hover and selection changes re-upload no geometry.
  await page.addInitScript(() => {
    window.__UPLOADS__ = 0;
    window.__UPLOAD_BY__ = {};
    const P = WebGL2RenderingContext.prototype;
    for (const name of ["bufferData", "bufferSubData"]) {
      const orig = P[name];
      P[name] = function (target, data, ...rest) {
        const n = typeof data === "number" ? data : (data?.byteLength ?? 0);
        window.__UPLOADS__ += n;
        // Who uploaded: deck.gl/luma.gl (our layers) or MapLibre (basemap tiles, its own buffers)
        const st = new Error().stack ?? "";
        const who = /maplibre/i.test(st) && !/deck|luma/i.test(st) ? "maplibre" : /deck|luma/i.test(st) ? "deck.gl" : "other";
        window.__UPLOAD_BY__[who] = (window.__UPLOAD_BY__[who] ?? 0) + n;
        return orig.call(this, target, data, ...rest);
      };
    }
  });
  page.on("console", (m) => {
    if (m.type() === "error") fail(`console: ${m.text()}`.slice(0, 400));
    else if (m.type() === "warning") report.warnings.push(m.text().slice(0, 300));
  });
  const responses = [];
  page.on("response", (r) => { if (r.status() >= 400) report.warnings.push(`HTTP ${r.status()} ${r.url().replace(base, "")}`); });
  page.on("response", (r) => { if (/geometry\.|bundle\.json|catalog\./.test(r.url())) responses.push({ url: r.url().replace(base, ""), status: r.status(), encoding: r.headers()["content-encoding"] ?? null, cache: r.headers()["cache-control"] ?? null }); });
  const shot = async (name) => { await page.waitForTimeout(400); await page.screenshot({ path: resolve(out, `${name}.png`) }); };
  const t0 = Date.now();
  await page.goto(`${base}/?debug=1&step=1#t=117&c=30.000,32.000,1.55`);
  await page.waitForFunction(() => window.__CHRONOS__ || document.querySelector('[role="status"]')?.textContent?.includes("Could not"), null, { timeout: 60_000 });
  const ready = await page.evaluate(() => window.__CHRONOS__ ? { readyMs: window.__CHRONOS__.readyMs, timings: window.__CHRONOS__.timings } : null);
  if (!ready) fail("app did not become ready");
  report.load = { ...ready, wallMs: Date.now() - t0, responses };
  if (steps.includes("load")) { await shot("01-117ce-globe"); report.steps.push("load"); }
  const engine = (fn, ...a) => page.evaluate(fn, ...a);

  if (steps.includes("uploads")) {
    const idle = () => page.evaluate(() => new Promise((r) => {
      const m = window.__CHRONOS__.engine.map;
      if (m.loaded() && m.areTilesLoaded()) r(null); else m.once("idle", () => r(null));
    }));
    const measure = async (label, fn) => {
      await idle();
      await page.waitForTimeout(300);
      const before = await page.evaluate(() => ({ ...window.__UPLOAD_BY__ }));
      await fn();
      await page.waitForTimeout(400);
      const after = await page.evaluate(() => ({ ...window.__UPLOAD_BY__ }));
      const by = Object.fromEntries(Object.keys(after).map((k) => [k, after[k] - (before[k] ?? 0)]).filter(([, v]) => v > 0));
      return { label, bytes: Object.values(by).reduce((a, b) => a + b, 0), by };
    };
    await idle();
    const geometryBytes = await page.evaluate(() => ({ total: window.__UPLOADS__, by: window.__UPLOAD_BY__ }));
    const roman = await page.evaluate(() => window.__CHRONOS__.meta.polities.findIndex((p) => p.id === "roman-empire"));
    const u = [
      await measure("control: no interaction", () => Promise.resolve()),
      await measure("year change (117 -> 118 -> 117)", () => page.keyboard.press("ArrowRight").then(() => page.keyboard.press("ArrowLeft"))),
      await measure("hover over a territory", () => page.mouse.move(720, 470).then(() => page.mouse.move(724, 474))),
      await measure("hover again elsewhere", () => page.mouse.move(800, 430).then(() => page.mouse.move(804, 434))),
      await measure("select the Roman Empire (adds its outline)", () => page.evaluate((p) => window.__CHRONOS__.engine.setSelected(p), roman)),
      await measure("deselect", () => page.evaluate(() => window.__CHRONOS__.engine.setSelected(-1))),
    ];
    // Any re-upload of territory geometry would be at least one attribute: 3.55 M vertices x 4 bytes = 14 MB.
    for (const x of u) if ((x.by["deck.gl"] ?? 0) > 2_000_000) fail(`uploads: ${x.label} uploaded ${x.by["deck.gl"]} bytes from deck.gl`);
    report.uploads = { initialBytes: geometryBytes, changes: u };
    report.steps.push({ uploads: u.map((x) => `${x.label}: ${JSON.stringify(x.by)}`) });
  }
  if (steps.includes("claimants")) {
    // Hover and click use one picking pass plus the overlap regions on the CPU; the benchmark's multi-pass pick is the
    // reference. Compare them on a grid over views with heavy overlap.
    const views = ["#t=420&c=66.000,37.000,3.80", "#t=-499&c=118.000,32.000,4.20", "#t=1500&c=10.000,48.000,4.00"];
    const claim = [];
    for (const [i, h] of views.entries()) {
      await page.goto(`${base}/?debug=1&claim=${i}${h}`);
      await page.waitForFunction(() => window.__CHRONOS__, null, { timeout: 60_000 });
      await page.waitForTimeout(800);
      const r = await page.evaluate(() => {
        const e = window.__CHRONOS__.engine;
        let n = 0, agree = 0, shared = 0;
        const bad = [];
        for (let x = 120; x <= 1320; x += 24) {
          for (let y = 240; y <= 700; y += 24) {
            const a = e.claimantsAt(x, y).slice().sort((p, q) => p - q);
            const b = e.pick(x, y, 8);
            n++;
            if (b.length > 1) shared++;
            if (a.length === b.length && a.every((v, k) => v === b[k])) agree++;
            else if (bad.length < 5) bad.push({ x, y, claimants: a, pick: b });
          }
        }
        return { points: n, agree, sharedPoints: shared, mismatches: bad };
      });
      claim.push({ view: h, ...r });
      if (r.agree !== r.points) fail(`claimants: ${r.points - r.agree} of ${r.points} points differ from the multi-pass pick in ${h}`);
    }
    report.claimants = claim;
    report.steps.push({ claimants: claim.map((c) => `${c.view}: ${c.agree}/${c.points} agree (${c.sharedPoints} on shared ground)`) });
  }
  if (steps.includes("select")) {
    // Click on Rome itself at 117 CE (its own page, whatever ran before): the Roman Empire should be selected and outlined.
    await page.goto(`${base}/?debug=1&step=select#t=117&c=14.000,40.000,3.60`);
    await page.waitForFunction(() => window.__CHRONOS__, null, { timeout: 60_000 });
    const p = null;
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
    await page.goto(`${base}/?debug=1&step=2#t=420&c=66.000,37.000,3.80`);
    await page.waitForFunction(() => window.__CHRONOS__, null, { timeout: 60_000 });
    await shot("03-overlap-420ce");
    report.steps.push("overlap");
  }
  if (steps.includes("sample")) {
    await page.goto(`${base}/?debug=1&step=3#t=1500&c=12.500,41.900,4.50&s=12.4964,41.9028`);
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
    await page.goto(`${base}/?debug=1&step=4#t=1914&c=20.000,20.000,1.40&proj=flat`);
    await page.waitForFunction(() => window.__CHRONOS__, null, { timeout: 60_000 });
    await shot("05-flat-1914");
    report.steps.push("flat");
  }
  if (steps.includes("dissolve")) {
    await page.goto(`${base}/?debug=1&step=5#t=1500&c=15.000,48.000,3.20`);
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
  await (usePreview ? new Promise((r) => server.httpServer.close(r)) : server.close());
}
writeFileSync(resolve(out, "smoke.json"), JSON.stringify(report, null, 1) + "\n");
console.log(JSON.stringify({ load: report.load, steps: report.steps, errors: report.errors, warnings: report.warnings.slice(0, 8) }, null, 1));
process.exit(report.errors.length ? 1 : 0);
