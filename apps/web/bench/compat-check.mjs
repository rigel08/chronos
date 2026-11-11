#!/usr/bin/env node
/** Runs compat.html's automatic checks in local Chrome (the page itself is for browsers we cannot automate). */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";
import { createServer } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const server = await createServer({ configFile: resolve(here, "../vite.config.ts"), root: resolve(here, ".."), logLevel: "warn" });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--ignore-gpu-blocklist"] });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://localhost:${server.config.server.port}/compat.html`);
  await page.waitForFunction(() => window.__COMPAT__, null, { timeout: 60000 });
  const rec = await page.evaluate(() => window.__COMPAT__);
  for (const c of rec.checks) console.log(`${c.ok === true ? "pass" : c.ok === false ? "FAIL" : "info"}  ${c.label}: ${c.detail}`);
  if (errors.length) console.log("page errors:", errors);
} finally {
  await browser.close();
  await server.close();
}
