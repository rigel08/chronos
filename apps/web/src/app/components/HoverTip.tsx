import { useStore } from "../../lib/store";
import { spanLabel } from "../../lib/years";
import { appData, rowAt, selectionStore, timeStore } from "../state";

export function HoverTip() {
  const hover = useStore(selectionStore, (s) => s.hover);
  const t = useStore(timeStore, (s) => s.t);
  const d = appData();
  if (!hover || !d) return null;
  return (
    <div className="glass pointer-events-none absolute z-30 max-w-[260px] rounded-lg px-3 py-2 text-[12px]"
         style={{ left: hover.x + 14, top: hover.y + 14 }} role="tooltip">
      {hover.polities.map((p) => {
        const m = d.meta.polities[p];
        const r = rowAt(d, p, t);
        return (
          <div key={p} className="flex items-start gap-2">
            <span className="mt-[4px] inline-block size-2.5 shrink-0 rounded-[2px]" style={{ background: d.meta.palette.colours[m?.colour ?? 0] }} />
            <span>
              <span className="text-bone-100">{m?.name}</span>
              {r !== null && <span className="block font-mono text-[10.5px] text-slate-400">row {spanLabel(d.g.territoryStart[r] as number, d.g.territoryEnd[r] as number)}</span>}
            </span>
          </div>
        );
      })}
      {hover.polities.length > 1 && (
        <div className="mt-1 text-[11px] text-slate-400">
          {hover.polities.length === 2 ? "Both" : `All ${hover.polities.length}`} mapped on this ground in Cliopatria. Click again to switch.
        </div>
      )}
    </div>
  );
}
