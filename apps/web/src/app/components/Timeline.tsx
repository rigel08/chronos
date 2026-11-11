import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { useStore } from "../../lib/store";
import { parseYearInput, SPEEDS, ticks, yearLabel } from "../../lib/years";
import { setYear } from "../actions";
import { appData, timeStore, uiStore } from "../state";

const MIN_SPAN = 20;

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export function Timeline() {
  const phase = useStore(uiStore, (s) => s.phase);
  const t = useStore(timeStore, (s) => s.t);
  const playing = useStore(timeStore, (s) => s.playing);
  const speed = useStore(timeStore, (s) => s.speed);
  const win = useStore(timeStore, (s) => s.window);
  const d = phase === "ready" ? appData() : null;
  const min = d?.meta.years.min ?? -3399;
  const max = d?.meta.years.max ?? 2024;
  const [goto, setGoto] = useState("");

  // Keep the playhead inside the detail window.
  useEffect(() => {
    const [a, b] = timeStore.get().window;
    if (t < a || t > b) {
      const span = b - a;
      const na = Math.max(min, Math.min(max - span, t - span / 2));
      timeStore.set({ window: [na, na + span] });
    }
  }, [t, min, max]);

  const step = (n: number) => setYear(timeStore.get().t + n, true);
  return (
    <section className="glass absolute inset-x-0 bottom-0 z-20 border-x-0 border-b-0 px-5 pb-3 pt-2.5" aria-label="Timeline">
      <div className="flex items-center gap-2">
        <button type="button" className="btn w-9 px-0" aria-label={playing ? "Pause" : "Play"} disabled={!d}
                onClick={() => timeStore.set({ playing: !playing })}>
          {playing
            ? <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="2" y="1.5" width="3" height="9" fill="currentColor" /><rect x="7" y="1.5" width="3" height="9" fill="currentColor" /></svg>
            : <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 1.5v9l7.5-4.5z" fill="currentColor" /></svg>}
        </button>
        <label className="flex items-center gap-1.5 text-[11px] text-slate-400">
          <span className="sr-only">Playback speed</span>
          <select className="btn h-7 appearance-none px-2 font-mono text-[11px]" value={speed}
                  onChange={(e) => timeStore.set({ speed: Number(e.target.value) })}>
            {SPEEDS.map((s) => <option key={s} value={s}>{s} yr/s</option>)}
          </select>
        </label>
        <div className="ml-2 flex items-center gap-1" role="group" aria-label="Step through time">
          {[-100, -10, -1].map((n) => (
            <button key={n} type="button" className="btn h-7 px-2 font-mono text-[11px]" onClick={() => step(n)} disabled={!d}
                    aria-label={`Back ${-n} ${n === -1 ? "year" : "years"}`}>{n}</button>
          ))}
          <span className="mx-1 h-4 w-px bg-graphite" aria-hidden="true" />
          {[1, 10, 100].map((n) => (
            <button key={n} type="button" className="btn h-7 px-2 font-mono text-[11px]" onClick={() => step(n)} disabled={!d}
                    aria-label={`Forward ${n} ${n === 1 ? "year" : "years"}`}>+{n}</button>
          ))}
        </div>
        <form className="ml-3 flex items-center gap-1.5" onSubmit={(e) => {
          e.preventDefault();
          const y = parseYearInput(goto);
          if (y !== null) { setYear(y, true); setGoto(""); (e.currentTarget.querySelector("input") as HTMLInputElement).blur(); }
        }}>
          <label className="sr-only" htmlFor="goto">Go to year</label>
          <input id="goto" value={goto} onChange={(e) => setGoto(e.target.value)} placeholder="Go to year · 500 BCE"
                 className="h-7 w-[150px] rounded-md border border-[color-mix(in_oklab,var(--color-bone-100)_12%,transparent)] bg-ink-900/70 px-2 font-mono text-[11px] text-bone-100 placeholder:text-slate-500" />
        </form>
        <p className="ml-auto hidden text-[11px] text-slate-500 lg:block">
          <kbd className="font-mono">← →</kbd> year · <kbd className="font-mono">⇧</kbd> 10 · <kbd className="font-mono">⌥</kbd> 100 · <kbd className="font-mono">space</kbd> play · wheel on the track to zoom
        </p>
      </div>
      <Overview min={min} max={max} t={t} win={win} />
      <Detail t={t} win={win} min={min} max={max} enabled={!!d} />
    </section>
  );
}

function Overview({ min, max, t, win }: { min: number; max: number; t: number; win: [number, number] }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ mode: "pan" | "jump"; dx: number } | null>(null);
  const phase = useStore(uiStore, (s) => s.phase);
  const x = (y: number) => ((y - min) / (max - min)) * w;
  const yAt = (px: number) => min + (px / w) * (max - min);

  useEffect(() => {
    const d = appData();
    const c = canvas.current;
    if (!c || !w || !d) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(w * dpr);
    c.height = Math.round(26 * dpr);
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, 26);
    const series = d.mappedPerYear;
    let peak = 1;
    for (const v of series) peak = Math.max(peak, v);
    ctx.fillStyle = "rgba(233, 226, 210, 0.32)";
    for (let px = 0; px < w; px++) {
      const y0 = Math.floor(yAt(px)) - min, y1 = Math.max(y0 + 1, Math.floor(yAt(px + 1)) - min);
      let m = 0;
      for (let i = y0; i < y1 && i < series.length; i++) m = Math.max(m, series[i] as number);
      const h = Math.sqrt(m / peak) * 22;
      ctx.fillRect(px, 26 - h, 1, h);
    }
  }, [w, phase, min, max]);

  const onDown = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const px = e.clientX - r.left;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (px >= x(win[0]) && px <= x(win[1])) drag.current = { mode: "pan", dx: px - x(win[0]) };
    else {
      drag.current = { mode: "jump", dx: 0 };
      const y = yAt(px);
      const span = win[1] - win[0];
      const a = Math.max(min, Math.min(max - span, y - span / 2));
      timeStore.set({ window: [a, a + span] });
      setYear(y, true);
    }
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current || drag.current.mode !== "pan") return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const span = win[1] - win[0];
    const a = Math.max(min, Math.min(max - span, yAt(e.clientX - r.left - drag.current.dx)));
    timeStore.set({ window: [a, a + span] });
  };
  return (
    <div ref={ref} className="relative mt-2.5 h-[26px] cursor-pointer touch-none select-none" onPointerDown={onDown} onPointerMove={onMove}
         onPointerUp={() => { drag.current = null; }} title="Mapped polities per year (record density). Drag the window, or click to jump.">
      <canvas ref={canvas} className="absolute inset-0 h-[26px] w-full" aria-hidden="true" />
      {w > 0 && (
        <>
          <div className="absolute inset-y-0 rounded-[3px] border border-bone-400/50 bg-bone-100/[0.06]"
               style={{ left: x(win[0]), width: Math.max(2, x(win[1]) - x(win[0])) }} />
          <div className="absolute inset-y-0 w-px bg-bone-100" style={{ left: x(t) }} />
        </>
      )}
      <span className="pointer-events-none absolute -bottom-0.5 left-0 font-mono text-[9.5px] text-slate-500">{yearLabel(min)}</span>
      <span className="pointer-events-none absolute -bottom-0.5 right-0 font-mono text-[9.5px] text-slate-500">{yearLabel(max)}</span>
    </div>
  );
}

function Detail({ t, win, min, max, enabled }: { t: number; win: [number, number]; min: number; max: number; enabled: boolean }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const scrubbing = useRef(false);
  const [a, b] = win;
  const x = (y: number) => ((y - a) / (b - a)) * w;
  const yAt = useCallback((px: number) => a + (px / Math.max(1, w)) * (b - a), [a, b, w]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const [wa, wb] = timeStore.get().window;
      const span = wb - wa;
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const dy = ((e.shiftKey ? e.deltaY : e.deltaX) / r.width) * span;
        const na = Math.max(min, Math.min(max - span, wa + dy));
        timeStore.set({ window: [na, na + span] });
        return;
      }
      const at = wa + ((e.clientX - r.left) / r.width) * span;
      const ns = Math.max(MIN_SPAN, Math.min(max - min, span * Math.exp(e.deltaY * 0.0016)));
      let na = at - ((at - wa) / span) * ns;
      na = Math.max(min, Math.min(max - ns, na));
      timeStore.set({ window: [na, na + ns] });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [min, max, ref]);

  const scrubTo = (clientX: number) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    setYear(yAt(clientX - r.left), false);       // scrubbing cuts: no dissolve while the hand is on time
  };
  const tk = w ? ticks(a, b, w) : [];
  return (
    <div ref={ref} role="slider" tabIndex={0} aria-label="Year" aria-valuemin={min} aria-valuemax={max} aria-valuenow={t}
         aria-valuetext={yearLabel(t)} aria-disabled={!enabled}
         className="relative mt-2 h-[46px] cursor-ew-resize touch-none select-none rounded-md bg-ink-900/40"
         onPointerDown={(e) => { if (!enabled) return; scrubbing.current = true; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); scrubTo(e.clientX); }}
         onPointerMove={(e) => { if (scrubbing.current) scrubTo(e.clientX); }}
         onPointerUp={() => { scrubbing.current = false; }}>
      <svg className="absolute inset-0 h-full w-full overflow-visible" aria-hidden="true">
        {tk.map((k) => (
          <g key={k.year} transform={`translate(${x(k.year)},0)`}>
            <line y1={k.major ? 0 : 6} y2={k.major ? 14 : 11} stroke="rgba(233,226,210,0.35)" strokeWidth={1} />
            {Math.abs(x(k.year) - x(t)) > 44 && x(k.year) > 22 && x(k.year) < w - 22 && (
              <text y={27} textAnchor="middle" className="fill-slate-400 font-mono" style={{ fontSize: 10.5 }}>{k.label}</text>
            )}
          </g>
        ))}
        {t >= a && t <= b && (
          <g transform={`translate(${x(t)},0)`}>
            <line y1={0} y2={46} stroke="#e9e2d2" strokeWidth={1.5} />
            <rect x={-30} y={30} width={60} height={15} rx={3} fill="#e9e2d2" />
            <text y={41} textAnchor="middle" className="font-mono" style={{ fontSize: 10.5, fill: "#0d1014", fontWeight: 500 }}>{yearLabel(t)}</text>
          </g>
        )}
      </svg>
    </div>
  );
}
