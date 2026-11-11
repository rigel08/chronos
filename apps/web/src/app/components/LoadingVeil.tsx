import { useStore } from "../../lib/store";
import { spanLabel } from "../../lib/years";
import { uiStore } from "../state";

const mb = (n: number) => (n / 1048576).toFixed(1);

/** Shown until the first correct pick (real readiness), not until an engine "loaded" signal. */
export function LoadingVeil() {
  const phase = useStore(uiStore, (s) => s.phase);
  const loaded = useStore(uiStore, (s) => s.loaded);
  const total = useStore(uiStore, (s) => s.total);
  const error = useStore(uiStore, (s) => s.error);
  const territories = useStore(uiStore, (s) => s.territories);
  const years = useStore(uiStore, (s) => s.years);
  if (phase === "ready") return null;
  const pct = total ? Math.min(100, (loaded / total) * 100) : 0;
  const label = phase === "error" ? "Could not load the atlas"
    : phase === "uploading" ? "Drawing territories"
    : phase === "loading" ? "Loading territories" : "Preparing the globe";
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-[190px] z-30 flex justify-center">
      <div className="glass pointer-events-auto w-[340px] rounded-xl px-5 py-4" role="status" aria-live="polite">
        <div className="flex items-baseline justify-between">
          <span className="font-display text-[19px] italic text-bone-100">{label}</span>
          {phase === "loading" && total > 0 && <span className="font-mono text-[11px] tabular text-slate-400">{mb(loaded)} / {mb(total)} MB</span>}
        </div>
        {phase !== "error" ? (
          <>
            <div className="mt-3 h-[2px] overflow-hidden rounded bg-graphite">
              <div className="h-full bg-bone-100 transition-[width] duration-150 ease-linear"
                   style={{ width: `${phase === "uploading" ? 100 : pct}%`, opacity: phase === "uploading" ? 0.6 : 1 }} />
            </div>
            {territories > 0 && (
              <p className="mt-2.5 text-[11.5px] leading-relaxed text-slate-400">
                {territories.toLocaleString()} dated territories from Cliopatria, {spanLabel(years[0], years[1])}, at full resolution
                {globalThis.crypto?.subtle ? ", checked against the build's checksum before drawing." : ". (This connection is not secure, so the checksum cannot be verified here.)"}
              </p>
            )}
          </>
        ) : (
          <>
            <p className="mt-2 text-[12px] leading-relaxed text-bone-400">{error}</p>
            <button type="button" className="btn mt-3" onClick={() => location.reload()}>Try again</button>
          </>
        )}
      </div>
    </div>
  );
}
