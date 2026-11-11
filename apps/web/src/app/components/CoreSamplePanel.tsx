import type { Stratum } from "../../lib/coreSample";
import { useStore } from "../../lib/store";
import { spanLabel, yearLabel } from "../../lib/years";
import { setYear } from "../actions";
import { appData, sampleStore, selectionStore, timeStore, uiStore } from "../state";

const coord = (v: number, pos: string, neg: string) => `${Math.abs(v).toFixed(4)}° ${v >= 0 ? pos : neg}`;

/**
 * Time slices for the column: between consecutive start/end boundaries, the polities mapped in that slice share
 * the column's width equally. One polity takes the full width; overlaps split it, only for the years they share.
 */
function slices(strata: Stratum[]): { a: number; b: number; active: Stratum[] }[] {
  const order = [...strata].sort((x, y) => x.start - y.start || x.end - y.end);
  const cuts = [...new Set(order.flatMap((s) => [s.start, s.end + 1]))].sort((x, y) => x - y);
  const out: { a: number; b: number; active: Stratum[] }[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const a = cuts[i] as number, b = (cuts[i + 1] as number) - 1;
    const active = order.filter((s) => s.start <= a && s.end >= b);
    if (active.length) out.push({ a, b, active });
  }
  return out;
}

export function CoreSamplePanel() {
  const result = useStore(sampleStore, (s) => s.result);
  const at = useStore(sampleStore, (s) => s.at);
  const t = useStore(timeStore, (s) => s.t);
  const selected = useStore(selectionStore, (s) => s.polity);
  const d = appData();
  if (!d || !at) return null;
  if (!result) return <p className="text-[12px] text-slate-500">Sampling…</p>;
  const { strata, gaps } = result;
  const header = (
    <header>
      <div className="eyebrow">Core sample</div>
      <h2 className="mt-1 font-display text-[24px] leading-tight text-bone-100">Who is mapped here</h2>
      <p className="mt-1 font-mono text-[11px] text-slate-400">{coord(result.lat, "N", "S")}, {coord(result.lon, "E", "W")} · within {result.toleranceKm} km</p>
    </header>
  );
  if (!strata.length) {
    return (
      <div className="space-y-4">
        {header}
        <p className="text-[12.5px] leading-relaxed text-bone-400">
          Cliopatria maps no polity at this point in any year. Unmapped is not empty: the dataset leaves out polities under 5,000 km²
          or 50 years, and its coverage is thinnest outside Eurasia.
        </p>
      </div>
    );
  }
  const lo = Math.min(...strata.map((s) => s.start)), hi = Math.max(...strata.map((s) => s.end));
  const cols = slices(strata);
  const H = 300, W = 104, pad = 6;
  const y = (yr: number) => pad + ((hi + 1 - yr) / Math.max(1, hi + 1 - lo)) * (H - 2 * pad);
  const colourOf = (s: Stratum) => d.meta.palette.colours[d.meta.polities[s.polity]?.colour ?? 0] ?? "#888";
  const select = (s: Stratum) => {
    selectionStore.set({ polity: s.polity });
    uiStore.set({ panel: "polity" });
    if (t < s.start || t > s.end) setYear(Math.max(s.start, Math.min(s.end, t)), true);
  };

  return (
    <div className="space-y-4">
      {header}
      <p className="text-[12.5px] leading-relaxed text-bone-400">
        Cliopatria maps <span className="text-bone-100">{strata.length}</span> {strata.length === 1 ? "polity" : "polities"} here between {spanLabel(lo, hi)}.
        {gaps.length > 0 && <> Years with no mapped polity are hatched as unmapped, never filled in.</>}
      </p>
      <div className="flex gap-4">
        <svg width={W} height={H} className="shrink-0" role="img" aria-label="Strata column, oldest at the bottom">
          <defs>
            <pattern id="unmapped" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2="6" stroke="rgba(233,226,210,0.4)" strokeWidth="1" />
            </pattern>
          </defs>
          <rect x={0.5} y={pad} width={W - 1} height={H - 2 * pad} fill="none" stroke="rgba(233,226,210,0.12)" />
          {gaps.map(([a, b]) => (
            <rect key={`g${a}`} x={1} y={y(b + 1)} width={W - 2} height={Math.max(1.5, y(a) - y(b + 1))} fill="url(#unmapped)">
              <title>{`Unmapped ${spanLabel(a, b)}`}</title>
            </rect>
          ))}
          {cols.flatMap(({ a, b, active }) => active.map((s, k) => {
            const w = (W - 2) / active.length;
            return (
              <rect key={`${s.polityId}-${s.start}-${a}`} x={1 + k * w} y={y(b + 1)} width={w - (active.length > 1 ? 1 : 0)}
                    height={Math.max(1.2, y(a) - y(b + 1))} fill={colourOf(s)}
                    fillOpacity={s.exact ? (s.polity === selected ? 1 : 0.85) : 0.3}
                    stroke={s.exact ? (s.polity === selected ? "#e9e2d2" : "none") : "#e9e2d2"} strokeWidth={s.exact ? 1.2 : 1}
                    strokeDasharray={s.exact ? undefined : "3 2"} className="cursor-pointer" onClick={() => select(s)}>
                <title>{`${s.name}, ${spanLabel(s.start, s.end)}${s.exact ? "" : ` (near: ${s.distanceKm} km)`}${active.length > 1 ? ` · shared ${spanLabel(a, b)}` : ""}`}</title>
              </rect>
            );
          }))}
          {t >= lo && t <= hi && <line x1={0} x2={W} y1={y(t + 0.5)} y2={y(t + 0.5)} stroke="#e9e2d2" strokeWidth={1.5} />}
        </svg>
        <div className="flex min-w-0 flex-col justify-between py-1 font-mono text-[10.5px] text-slate-500">
          <span>{yearLabel(hi)}</span>
          {t >= lo && t <= hi && <span className="text-bone-100">now: {yearLabel(t)}</span>}
          <span>{yearLabel(lo)}</span>
        </div>
      </div>
      <ol className="space-y-1.5 text-[12.5px]" aria-label="Strata, newest first">
        {[...strata].sort((a, b) => b.start - a.start).map((s) => (
          <li key={`${s.polityId}-${s.start}`}>
            <button type="button" onClick={() => select(s)}
                    className={`flex w-full items-start gap-2 rounded-md px-1.5 py-1 text-left hover:bg-bone-100/[0.05] ${s.polity === selected ? "bg-bone-100/[0.07]" : ""}`}>
              <span className={`mt-[5px] inline-block size-2.5 shrink-0 rounded-[2px] ${s.exact ? "" : "border border-dashed border-bone-400"}`}
                    style={{ background: s.exact ? colourOf(s) : "transparent" }} aria-hidden="true" />
              <span className="min-w-0">
                <span className="text-bone-100">{s.name}</span>
                <span className="block font-mono text-[10.5px] text-slate-400">
                  {spanLabel(s.start, s.end)}{s.exact ? "" : ` · near hit, ${s.distanceKm} km from its polygon`}
                </span>
              </span>
            </button>
          </li>
        ))}
        {gaps.map(([a, b]) => (
          <li key={`gap${a}`} className="flex items-start gap-2 px-1.5 py-1 text-slate-400">
            <span className="hatch-unmapped mt-[5px] inline-block size-2.5 shrink-0 rounded-[2px]" aria-hidden="true" />
            <span>Unmapped <span className="font-mono text-[10.5px]">{spanLabel(a, b)}</span></span>
          </li>
        ))}
      </ol>
      {result.overlaps.length > 0 && (
        <section>
          <div className="eyebrow">Shared years</div>
          <ul className="mt-1.5 space-y-1 text-[12px] text-bone-400">
            {result.overlaps.map(([a, b, s, e]) => {
              const na = d.meta.polities[d.polityIndex.get(a) ?? -1]?.name ?? a;
              const nb = d.meta.polities[d.polityIndex.get(b) ?? -1]?.name ?? b;
              return <li key={`${a}${b}${s}`}>{na} and {nb} are both mapped here, <span className="font-mono text-[10.5px]">{spanLabel(s, e)}</span>.</li>;
            })}
          </ul>
        </section>
      )}
      <p className="text-[11px] leading-relaxed text-slate-500">
        Exact: a row's polygon covers the point. Near: within {result.toleranceKm} km of a row's polygon (atlas borders are coarse). Computed in your
        browser from the bundle in {result.ms.toFixed(1)} ms; same rules as the pipeline's QA-010 check.
      </p>
    </div>
  );
}
