#!/usr/bin/env node
/**
 * Delivery check (D-024, D-031): what does the server send for each Accept-Encoding a browser may offer?
 * Starts the dev server and the preview server (production build) in-process, requests every file the app loads
 * with several Accept-Encoding values, and compares Content-Encoding and Content-Length with the files on disk.
 *
 *   node bench/delivery-headers.mjs [--no-preview]
 */
import { readFileSync, realpathSync, statSync } from "node:fs";
import { request } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createServer, preview } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const data = realpathSync(resolve(here, "../../../data/build/current"));
const bundle = JSON.parse(readFileSync(resolve(data, "bundle.json"), "utf8"));
const files = [
  ["bundle.json", "bundle.json"],
  [bundle.files.geometry.path, "geometry"],
  [bundle.files.catalog.path, "catalog"],
  [bundle.files.basemap_land.path, "basemap land"],
  [bundle.files.relief.template.replace("{z}/{x}/{y}", "1/1/0"), "relief tile"],
];
// The offers tested. Chrome's is measured (compat-check.mjs); the gzip-only offer is what Safari appears to send over
// plain HTTP (17.24 MiB received = the .gz copy), which compat.html's /__echo row confirms or refutes on the next run.
const OFFERS = {
  "gzip only (Safari, plain HTTP?)": "gzip, deflate",
  "gzip + br (secure connection)": "gzip, deflate, br",
  "Chrome 157 (measured)": "gzip, deflate, br, zstd",
  "none": "",
};

const get = (base, path, ae) => new Promise((ok, fail) => {
  const req = request(`${base}/${path}`, { method: "GET", headers: ae ? { "accept-encoding": ae } : {} }, (res) => {
    let n = 0;
    res.on("data", (c) => { n += c.length; });
    res.on("end", () => ok({ status: res.statusCode, encoding: res.headers["content-encoding"] ?? null, length: Number(res.headers["content-length"] ?? -1),
                              received: n, cache: res.headers["cache-control"] ?? null, vary: res.headers.vary ?? null, type: res.headers["content-type"] ?? null }));
  });
  req.on("error", fail);
  req.end();
});

const size = (p) => { try { return statSync(resolve(data, p)).size; } catch { return null; } };
const rows = [];
async function check(label, base) {
  for (const [path, name] of files) {
    for (const [who, ae] of Object.entries(OFFERS)) {
      const r = await get(base, path, ae);
      const expectEnc = ae.includes("br") && size(`${path}.br`) !== null ? "br" : ae.includes("gzip") && size(`${path}.gz`) !== null ? "gzip" : null;
      const expectLen = expectEnc === "br" ? size(`${path}.br`) : expectEnc === "gzip" ? size(`${path}.gz`) : size(path);
      const ok = r.status === 200 && r.encoding === expectEnc && r.received === expectLen;
      rows.push({ server: label, file: name, browser: who, ...r, expected: { encoding: expectEnc, bytes: expectLen }, ok });
    }
  }
}

const dev = await createServer({ configFile: resolve(root, "vite.config.ts"), root, logLevel: "error" });
await dev.listen();
try { await check("dev", `http://localhost:${dev.config.server.port}`); } finally { await dev.close(); }
if (!process.argv.includes("--no-preview")) {
  const pv = await preview({ configFile: resolve(root, "vite.config.ts"), root, logLevel: "error" });
  try { await check("preview", pv.resolvedUrls.local[0].replace(/\/$/, "")); } finally { await new Promise((r) => pv.httpServer.close(r)); }
}
const mib = (b) => (b / 1048576).toFixed(2);
for (const r of rows) {
  console.log(`${r.ok ? "ok  " : "FAIL"} ${r.server.padEnd(7)} ${r.file.padEnd(12)} ${r.browser.padEnd(32)} ${String(r.encoding).padEnd(5)} ${mib(r.received).padStart(7)} MiB  ${r.cache}  vary=${r.vary}`);
}
console.log(JSON.stringify({ checked: rows.length, failed: rows.filter((r) => !r.ok).length }));
process.exit(rows.some((r) => !r.ok) ? 1 : 0);
