import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// Milestone 1.1: the only page is the engine benchmark harness. The pipeline's current build
// (data/build/current, a symlink written by `chronos-pipeline build`) is served as static files.
export default defineConfig({
  publicDir: resolve(import.meta.dirname, "../../data/build/current"),
  build: {
    copyPublicDir: false,
    rollupOptions: { input: { index: resolve(import.meta.dirname, "index.html"), bench: resolve(import.meta.dirname, "bench.html") } },
  },
  // MapLibre 6 is ESM-only and loads its worker from a sibling file by relative URL; pre-bundling breaks that.
  optimizeDeps: { exclude: ["maplibre-gl"] },
  server: { port: 5174, strictPort: true },
  test: { include: ["tests/**/*.test.ts"], environment: "node" },
});
