import { createReadStream, existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

const DATA = resolve(import.meta.dirname, "../../data/build/current");
const TYPES: Record<string, string> = {
  ".json": "application/json; charset=utf-8", ".bin": "application/octet-stream", ".webp": "image/webp",
  ".geojson": "application/geo+json", ".md": "text/markdown; charset=utf-8",
};

/**
 * Serves the pipeline's build (data/build/current) the way a static host should (D-024):
 *   - the precompressed copy the client accepts (brotli, else gzip, else the raw file) with Content-Encoding;
 *   - content-hashed files (name.<12 hex>.ext, relief-<hash>/) as immutable, everything else revalidated.
 * Used by the dev server and by `vite preview`; production hosting must do the same (README).
 */
function precompressedData(): Plugin {
  const handler = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const path = decodeURIComponent((req.url ?? "").split("?")[0] ?? "");
    if (!path || path === "/" || path.includes("..") || (req.method !== "GET" && req.method !== "HEAD")) return next();
    let root: string;
    try { root = realpathSync(DATA); } catch { return next(); }
    const file = join(root, path);
    if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) return next();
    const accept = String(req.headers["accept-encoding"] ?? "");
    let body = file;
    let encoding: string | null = null;
    if (/\bbr\b/.test(accept) && existsSync(`${file}.br`)) { body = `${file}.br`; encoding = "br"; }
    else if (/\bgzip\b/.test(accept) && existsSync(`${file}.gz`)) { body = `${file}.gz`; encoding = "gzip"; }
    const immutable = /\.[0-9a-f]{12}\.[a-z]+$/.test(path) || path.startsWith("/relief-");
    res.setHeader("Content-Type", TYPES[extname(path)] ?? "application/octet-stream");
    if (encoding) res.setHeader("Content-Encoding", encoding);
    res.setHeader("Vary", "Accept-Encoding");
    res.setHeader("Cache-Control", immutable ? "public, max-age=31536000, immutable" : "no-cache");
    res.setHeader("Content-Length", String(statSync(body).size));
    if (req.method === "HEAD") { res.end(); return; }
    createReadStream(body).pipe(res);
  };
  return {
    name: "chronos-precompressed-data",
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
  };
}

/**
 * Dev server only: the compatibility page (compat.html) POSTs its record here and it is written to docs/compat/.
 * Accepts JSON up to 2 MB from the local machine; the file name comes from the server's clock and the user agent.
 */
function compatRecorder(): Plugin {
  const dir = resolve(import.meta.dirname, "../../docs/compat");
  return {
    name: "chronos-compat-recorder",
    configureServer(server) {
      server.middlewares.use("/__compat", (req, res) => {
        const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "");
        if (req.method !== "POST" || !local) { res.statusCode = 403; res.end("local POST only"); return; }
        const chunks: Buffer[] = [];
        let size = 0;
        req.on("data", (c: Buffer) => { size += c.length; if (size <= 2_000_000) chunks.push(c); });
        req.on("end", () => {
          try {
            if (size > 2_000_000) throw new Error("too large");
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { userAgent?: string };
            const ua = String(body.userAgent ?? "");
            const browser = /Firefox\//.test(ua) ? "firefox" : /Edg\//.test(ua) ? "edge" : /Chrome\//.test(ua) ? "chrome" : /Safari\//.test(ua) ? "safari" : "browser";
            const version = (ua.match(/Version\/([\d.]+)/) ?? ua.match(/(?:Chrome|Firefox)\/([\d.]+)/))?.[1] ?? "unknown";
            mkdirSync(dir, { recursive: true });
            const name = `${new Date().toISOString().slice(0, 10)}-${browser}-${version.replace(/[^\d.]/g, "")}.json`;
            writeFileSync(join(dir, name), JSON.stringify(body, null, 1) + "\n");
            res.end(`docs/compat/${name}`);
          } catch (e) {
            res.statusCode = 400;
            res.end(String(e));
          }
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [precompressedData(), compatRecorder(), react(), tailwindcss()],
  publicDir: false,
  build: {
    target: "es2022",
    rollupOptions: { input: { index: resolve(import.meta.dirname, "index.html"), bench: resolve(import.meta.dirname, "bench.html"),
                              compat: resolve(import.meta.dirname, "compat.html") } },
  },
  worker: { format: "es" },
  // MapLibre 6 is ESM-only and loads its worker from a sibling file by relative URL; pre-bundling breaks that.
  optimizeDeps: { exclude: ["maplibre-gl"] },
  server: { port: 5174, strictPort: true },
  preview: { port: 5175, strictPort: true },
  test: { include: ["tests/**/*.test.ts"], environment: "node" },
});
