// Diagnostic: open the harness for one engine, print console output and status for up to 60 s, optionally screenshot.
// node bench/diagnose.mjs deck|maplibre [screenshot.png]
import { chromium } from "playwright-core";
import { createServer } from "vite";
const web = new URL("..", import.meta.url).pathname, engine = process.argv[2] ?? "deck";
const server = await createServer({ configFile: web + "/vite.config.ts", root: web, logLevel: "error" });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const seen = new Set();
page.on("console", (m) => { const t = `${m.type()}: ${m.text()}`.slice(0, 400); if (!seen.has(t)) { seen.add(t); console.log(t); } });
page.on("pageerror", (e) => console.log("pageerror:", e.message.slice(0, 400)));
await page.goto(`http://localhost:5174/bench.html?engine=${engine}${process.argv[4] ?? ""}`);
for (let i = 0; i < 12; i++) { await page.waitForTimeout(5000); console.log(`[${(i + 1) * 5}s] status:`, (await page.textContent("#status"))?.slice(0, 200)); if ((await page.textContent("#status")).includes("ready")) break; }
console.log("renderer:", await page.evaluate(() => { const gl = document.createElement("canvas").getContext("webgl2"); const e = gl.getExtension("WEBGL_debug_renderer_info"); return gl.getParameter(e.UNMASKED_RENDERER_WEBGL); }));
if (process.argv[3]) await page.screenshot({ path: process.argv[3] });
await browser.close(); await server.close();
