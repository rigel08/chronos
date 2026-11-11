/**
 * Manual compatibility check (milestone 1.3), for browsers we cannot automate here (Safari without changing a
 * system setting). Open http://localhost:5174/compat.html in the browser under test:
 *   1. automatic checks run at once (WebGL2, the shader features StrataExtension uses, content encoding, APIs);
 *   2. "Run app benchmark" loads the real app in a frame and runs the same protocol as Chrome (343 picks, sweeps);
 *   3. the checklist records what a person sees; 4. "Save" writes everything to docs/compat/ via the dev server.
 */
import "../app/styles.css";

type Check = { id: string; label: string; ok: boolean | null; detail: string };
const checks: Check[] = [];
const manual: Record<string, { result: "pass" | "fail" | "n/a" | null; note: string }> = {};
let bench: unknown = null;

const MANUAL = [
  ["globe", "The globe appears with relief, a faint coastline and the atmospheric rim; the loading card ends with territories drawn."],
  ["territories", "At 117 CE the Roman Empire, Parthia, Han China and their neighbours are drawn; neighbours have different colours."],
  ["hover", "Hovering a territory shows its name and row years; the territory lightens."],
  ["select", "Clicking a territory opens its card; it stays bright with a bone outline while the rest recede."],
  ["card", "The card shows source, licence, evidence, Wikidata, QA flags; 'How is this calculated?' opens the trace."],
  ["sample", "The Core sample tab shows a strata column with hatched unmapped years (try Rome)."],
  ["overlap", "At 420 CE in Central Asia (Kidarites and White Huns) the shared ground is striped in both colours."],
  ["scrub", "Dragging on the timeline track changes the year smoothly; the map follows without lag."],
  ["keys", "Arrow keys step a year, Shift+arrow ten, Option+arrow a hundred, Space plays and pauses."],
  ["dissolve", "Stepping 100 years cross-fades briefly; with Reduce Motion on it cuts instead."],
  ["flat", "The Flat button switches to a flat map and back."],
  ["type", "The year is set in an italic serif (Newsreader); labels in IBM Plex Sans and Plex Mono."],
] as const;

function add(id: string, label: string, ok: boolean | null, detail: string) { checks.push({ id, label, ok, detail }); }

function shaderCheck(gl: WebGL2RenderingContext): [boolean, string] {
  // The same constructs StrataExtension and FarSideExtension use: flat varyings, a const vec3 array indexed at run time,
  // a std140 uniform block, discard.
  const vs = `#version 300 es
  layout(std140) uniform strataFillUniforms { float tCur; float tPrev; float mixT; float selected; } strataFill;
  in vec2 strataTime; in float strataCode; flat out float vCode; out float vAlpha;
  void main() { vCode = strataCode; vAlpha = strataTime.x <= strataFill.tCur + 0.5 ? 1.0 : 0.0; gl_Position = vec4(0.0); }`;
  const fs = `#version 300 es
  precision highp float;
  const vec3 P[3] = vec3[3](vec3(1.0, 0.0, 0.0), vec3(0.0, 1.0, 0.0), vec3(0.0, 0.0, 1.0));
  flat in float vCode; in float vAlpha; out vec4 c;
  void main() { if (vAlpha <= 0.0) discard; int i = int(mod(vCode, 16.0) + 0.5); c = vec4(P[clamp(i, 0, 2)], 1.0); }`;
  const compile = (type: number, src: string) => {
    const s = gl.createShader(type);
    if (!s) return "createShader failed";
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? null : gl.getShaderInfoLog(s) ?? "compile failed";
  };
  const e1 = compile(gl.VERTEX_SHADER, vs);
  const e2 = compile(gl.FRAGMENT_SHADER, fs);
  return [!e1 && !e2, e1 ?? e2 ?? "flat varyings, const arrays, std140 blocks compile"];
}

async function automatic() {
  add("ua", "Browser", null, navigator.userAgent);
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2");
  if (!gl) add("webgl2", "WebGL2", false, "not available: CHRONOS needs WebGL2");
  else {
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    add("webgl2", "WebGL2", true, ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER)));
    const [ok, d] = shaderCheck(gl);
    add("glsl", "Shader features (StrataExtension)", ok, d);
    add("maxtex", "Max texture size", null, String(gl.getParameter(gl.MAX_TEXTURE_SIZE)));
  }
  // A browser without module workers ignores `type` silently; it only reads the option if it supports it.
  let moduleWorkers = false;
  try {
    const probe = { get type() { moduleWorkers = true; return "module" as const; } };
    new Worker(URL.createObjectURL(new Blob([""], { type: "text/javascript" })), probe).terminate();
  } catch { /* unsupported */ }
  add("workers", "Module workers", moduleWorkers, "the loader decodes geometry in a module worker");
  add("subtle", "crypto.subtle (sha256 check)", !!globalThis.crypto?.subtle, globalThis.crypto?.subtle ? "available" : "unavailable: geometry is drawn without the checksum check");
  add("css", "CSS: color-mix, backdrop-filter", CSS.supports("color", "color-mix(in oklab, red, blue)") && (CSS.supports("backdrop-filter", "blur(2px)") || CSS.supports("-webkit-backdrop-filter", "blur(2px)")), "glass panels and tokens");
  add("motion", "prefers-reduced-motion", null, matchMedia("(prefers-reduced-motion: reduce)").matches ? "reduce" : "no-preference");
  add("dpr", "Device pixel ratio / viewport", null, `${devicePixelRatio} · ${innerWidth}×${innerHeight}`);
  try {
    const echo = (await (await fetch("/__echo", { cache: "no-store" })).json()) as { acceptEncoding: string | null; protocol: string };
    const offered = echo.acceptEncoding ?? "";
    add("offer", "Accept-Encoding this browser sent (as the server saw it)", null, `${offered || "(none)"} · ${echo.protocol}`);
    const meta = await (await fetch("/bundle.json", { cache: "no-cache" })).json();
    const url = `/${meta.files.geometry.path}`;
    const t0 = performance.now();
    const res = await fetch(url, { cache: "no-store" });
    const encoding = res.headers.get("content-encoding");
    const buf = await res.arrayBuffer();
    const ms = performance.now() - t0;
    const entry = performance.getEntriesByName(new URL(url, location.href).href).pop() as PerformanceResourceTiming | undefined;
    const wire = entry && entry.encodedBodySize ? entry.encodedBodySize : null;
    const brOffered = /\bbr\b/.test(offered);
    const best = brOffered ? "br" : /\bgzip\b/.test(offered) ? "gzip" : null;
    add("negotiation", "Server sent the best encoding offered (D-031)", encoding === best,
        `offered ${offered || "(none)"} -> received ${encoding ?? "identity"} (expected ${best ?? "identity"})`);
    const mib = (n: number) => (n / 1048576).toFixed(2);
    add("encoding", "Brotli geometry on the wire, at most 3 MiB (D-024)", encoding === "br" && wire !== null && wire <= 3 * 1048576,
        `received ${encoding ?? "identity"}, ${wire ? mib(wire) + " MiB" : "size not reported"} on the wire, ${mib(buf.byteLength)} MiB decoded, ${ms.toFixed(0)} ms` +
        (brOffered ? "" : `; this browser did not offer br on this ${echo.protocol} connection`));
    add("cache", "Immutable caching header", (res.headers.get("cache-control") ?? "").includes("immutable"), res.headers.get("cache-control") ?? "none");
  } catch (e) {
    add("encoding", "Bundle fetch", false, String(e));
  }
}

function render() {
  const root = document.getElementById("root") as HTMLElement;
  const row = (c: Check) => `<tr class="border-b border-graphite align-top">
    <td class="py-1.5 pr-3 text-bone-100">${c.label}</td>
    <td class="py-1.5 pr-3 font-mono text-[11px] ${c.ok === true ? "text-[#57a067]" : c.ok === false ? "text-cinnabar" : "text-slate-400"}">${c.ok === true ? "pass" : c.ok === false ? "FAIL" : "info"}</td>
    <td class="py-1.5 font-mono text-[11px] text-slate-400 break-all">${c.detail.replace(/</g, "&lt;")}</td></tr>`;
  root.innerHTML = `
  <main class="mx-auto max-w-[980px] px-6 py-8 text-[13px]">
    <div class="eyebrow">CHRONOS · milestone 1.3</div>
    <h1 class="mt-1 font-display text-[34px] italic">Compatibility check</h1>
    <p class="mt-2 max-w-[70ch] text-bone-400">For browsers that cannot be automated here (Safari). Nothing on this page changes a system setting.
    Run the app benchmark, tick what you see in the app (open it in another tab: <a class="underline" href="/" target="_blank">/</a>), then save.</p>
    <h2 class="eyebrow mt-8">1 · Automatic checks</h2>
    <table class="mt-2 w-full"><tbody>${checks.map(row).join("")}</tbody></table>
    <h2 class="eyebrow mt-8">2 · App benchmark (same protocol as Chrome: sweeps, jumps, 343 picks)</h2>
    <p class="mt-2 text-bone-400">Takes about two minutes. Keep this tab in front.</p>
    <button id="bench" class="btn mt-2">Run app benchmark</button>
    <pre id="benchout" class="mt-2 max-h-[220px] overflow-auto whitespace-pre-wrap rounded-lg bg-ink-900 p-3 font-mono text-[11px] text-slate-400">${bench ? JSON.stringify(summary(bench), null, 1) : "not run"}</pre>
    <iframe id="frame" class="mt-3 hidden h-[620px] w-full rounded-lg border border-graphite" title="CHRONOS under test"></iframe>
    <h2 class="eyebrow mt-8">3 · What you see</h2>
    <ol class="mt-2 space-y-2">${MANUAL.map(([id, text]) => `<li class="rounded-lg border border-graphite p-3">
      <div class="text-bone-100">${text}</div>
      <div class="mt-2 flex flex-wrap items-center gap-2">${["pass", "fail", "n/a"].map((r) => `<button class="btn" data-id="${id}" data-r="${r}" aria-pressed="${manual[id]?.result === r}">${r}</button>`).join("")}
      <input data-note="${id}" value="${(manual[id]?.note ?? "").replace(/"/g, "&quot;")}" placeholder="note (optional)" class="h-7 flex-1 rounded-md border border-graphite bg-ink-900 px-2 text-[12px]"></div></li>`).join("")}</ol>
    <h2 class="eyebrow mt-8">4 · Save</h2>
    <button id="save" class="btn mt-2">Save results to docs/compat/</button>
    <a id="download" class="btn ml-2">Download JSON</a>
    <p id="saved" class="mt-2 text-slate-400"></p>
  </main>`;
  root.querySelectorAll<HTMLButtonElement>("button[data-id]").forEach((b) => b.addEventListener("click", () => {
    const id = b.dataset.id as string;
    manual[id] = { result: b.dataset.r as "pass", note: manual[id]?.note ?? "" };
    render();
  }));
  root.querySelectorAll<HTMLInputElement>("input[data-note]").forEach((i) => i.addEventListener("change", () => {
    const id = i.dataset.note as string;
    manual[id] = { result: manual[id]?.result ?? null, note: i.value };
  }));
  (document.getElementById("bench") as HTMLButtonElement).onclick = runBench;
  (document.getElementById("save") as HTMLButtonElement).onclick = save;
  const dl = document.getElementById("download") as HTMLAnchorElement;
  dl.href = URL.createObjectURL(new Blob([JSON.stringify(record(), null, 1)], { type: "application/json" }));
  dl.download = "chronos-compat.json";
}

function summary(b: unknown) {
  const r = b as Record<string, any>;
  if (!r || r.error) return r;
  return { firstCorrectPickMs: r.load?.timeToFirstCorrectPickMs, picks: r.picks && `${r.picks.correct}/${r.picks.n}`,
           sweep: r.sweep && { p50: r.sweep.frames.p50, p95: r.sweep.frames.p95, stale: r.sweep.staleShare },
           europe: r.regionalSweep && { p95: r.regionalSweep.frames.p95, stale: r.regionalSweep.staleShare },
           explore: r.explore && { p95: r.explore.frames.p95, stale: r.explore.staleShare }, heapMB: r.jsHeapMB ?? "not exposed by this browser" };
}

async function runBench() {
  const frame = document.getElementById("frame") as HTMLIFrameElement;
  frame.classList.remove("hidden");
  frame.src = "/?test=1&bench=1&run=1&cycles=1#t=117&c=30.000,30.000,1.40";
  const out = document.getElementById("benchout") as HTMLElement;
  out.textContent = "running…";
  const t0 = performance.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000));
    const w = frame.contentWindow as (Window & { __BENCH__?: unknown; __BENCH_ERROR__?: string }) | null;
    if (w?.__BENCH__) { bench = w.__BENCH__; break; }
    if (w?.__BENCH_ERROR__) { bench = { error: w.__BENCH_ERROR__ }; break; }
    if (performance.now() - t0 > 15 * 60_000) { bench = { error: "timed out" }; break; }
    out.textContent = `running… ${Math.round((performance.now() - t0) / 1000)} s`;
  }
  render();
}

function record() {
  return { recordedAt: new Date().toISOString(), page: location.href, userAgent: navigator.userAgent, checks, manual, bench };
}

async function save() {
  const p = document.getElementById("saved") as HTMLElement;
  try {
    const r = await fetch("/__compat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(record()) });
    p.textContent = r.ok ? `Saved: ${await r.text()}` : `The dev server refused (${r.status}); use Download instead.`;
  } catch (e) {
    p.textContent = `Could not reach the dev server (${String(e)}); use Download instead.`;
  }
}

automatic().then(render, (e) => { add("error", "Automatic checks", false, String(e)); render(); })
  .finally(() => { (window as unknown as { __COMPAT__?: unknown }).__COMPAT__ = record(); });   // for automated runs in Chrome
