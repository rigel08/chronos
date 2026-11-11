import { useStore } from "../../lib/store";
import { yearLabel, yearParts } from "../../lib/years";
import { appData, coverageNear, timeStore, uiStore } from "../state";

/** The year, and an honest statement of what is mapped in it (design-direction.md, integrity rules 1–3). */
export function Header() {
  const t = useStore(timeStore, (s) => s.t);
  const phase = useStore(uiStore, (s) => s.phase);
  const d = phase === "ready" ? appData() : null;
  const { num, era } = yearParts(t);
  const mapped = d ? (d.mappedPerYear[t - d.meta.years.min] ?? 0) : null;
  const cov = d ? coverageNear(d.meta, t) : null;
  return (
    <>
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-[210px] bg-gradient-to-b from-ink-950/85 via-ink-950/45 to-transparent" aria-hidden="true" />
      <div className="pointer-events-none absolute left-5 top-4 z-10 select-none">
        <div className="text-[12px] font-semibold tracking-[0.34em] text-bone-100">CHRONOS</div>
        <div className="mt-0.5 text-[11px] text-slate-400">Strata · first slice</div>
      </div>
      <header className="pointer-events-none absolute inset-x-0 top-3 z-10 flex flex-col items-center select-none" aria-live="polite">
        <h1 className="sr-only">CHRONOS, {yearLabel(t)}</h1>
        <div className="flex items-baseline gap-2" aria-hidden="true">
          <span className="font-display text-[60px] font-light italic leading-none tracking-tight tabular text-bone-100 drop-shadow-[0_2px_12px_rgba(0,0,0,0.6)]">{num}</span>
          <span className="font-mono text-[13px] font-medium tracking-[0.2em] text-bone-400">{era}</span>
        </div>
        {d && mapped !== null && (
          <p className="mt-1.5 text-center text-[12.5px] text-bone-400">
            <span className="tabular text-bone-100">{mapped.toLocaleString()}</span> {mapped === 1 ? "polity" : "polities"} mapped in Cliopatria
            {cov && (
              <>
                <span className="mx-2 text-slate-500">·</span>
                <span title={`${d.meta.coverage.rule}: unique mapped land / ice-free land (${d.meta.coverage.land}), sampled every ${d.meta.coverage.step_years} years`}>
                  {(cov.share * 100).toFixed(1)}% of ice-free land
                  <span className="text-slate-500"> (sampled {yearLabel(cov.year)})</span>
                </span>
              </>
            )}
          </p>
        )}
        {d && (
          <p className="mt-1 flex items-center gap-3 text-[11px] text-slate-500">
            <span>Colours separate neighbours; they carry no meaning</span>
            <span className="inline-block h-2.5 w-5 rounded-[2px]" style={{ background: "repeating-linear-gradient(135deg, #cf5637 0 3px, #4b70c6 3px 6px)" }} aria-hidden="true" />
            <span>ground mapped to more than one polity</span>
          </p>
        )}
      </header>
    </>
  );
}
