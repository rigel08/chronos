import { useStore } from "../../lib/store";
import { appData, uiStore } from "../state";

const SOFTWARE = [
  ["MapLibre GL JS 6.16", "BSD-3-Clause", "https://github.com/maplibre/maplibre-gl-js"],
  ["deck.gl 9.4", "MIT", "https://github.com/visgl/deck.gl"],
  ["React 19", "MIT", "https://github.com/facebook/react"],
  ["Newsreader (Production Type)", "SIL Open Font License 1.1", "https://github.com/productiontype/Newsreader"],
  ["IBM Plex Sans and Plex Mono", "SIL Open Font License 1.1", "https://github.com/IBM/plex"],
] as const;

/** Every source used by this build, generated from the licence registry (D-007), and the software it runs on. */
export function Credits() {
  const open = useStore(uiStore, (s) => s.credits);
  const phase = useStore(uiStore, (s) => s.phase);
  if (!open) return null;
  const d = phase === "ready" ? appData() : null;
  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-ink-950/60" onClick={() => uiStore.set({ credits: false })}>
      <div role="dialog" aria-modal="true" aria-labelledby="credits-title" className="glass max-h-[80vh] w-[560px] overflow-y-auto rounded-xl p-6"
           onClick={(e) => e.stopPropagation()}>
        <div className="flex items-baseline justify-between">
          <h2 id="credits-title" className="font-display text-[26px] text-bone-100">Sources &amp; credits</h2>
          <button type="button" className="btn" onClick={() => uiStore.set({ credits: false })}>Close</button>
        </div>
        {!d ? <p className="mt-4 text-slate-400">Loading…</p> : (
          <>
            <p className="mt-2 text-[12.5px] leading-relaxed text-bone-400">
              Every border on this globe is one source's interpretation: Cliopatria, an atlas of past polities. It is not a record of who
              controlled the ground, it is incomplete, and it is shown as given. Only sources whose licence allows public, commercial use
              are in this build (QA-012).
            </p>
            <ul className="mt-4 space-y-3">
              {d.meta.sources.map((s) => (
                <li key={s.id} className="text-[12.5px]">
                  <div className="text-bone-100">{s.title}</div>
                  <div className="text-bone-400">{s.citation}</div>
                  <div className="text-[11.5px] text-slate-500">
                    {s.license_url ? <a className="underline underline-offset-2" href={s.license_url} target="_blank" rel="noreferrer">{s.license_name}</a> : s.license_name}
                    {" · "}{s.access_tier}{s.evidence ? ` · evidence: ${s.evidence}` : ""}
                    {s.url && <> · <a className="underline underline-offset-2" href={s.url} target="_blank" rel="noreferrer">source</a></>}
                  </div>
                </li>
              ))}
            </ul>
            <h3 className="eyebrow mt-6">Colours</h3>
            <p className="mt-1.5 text-[12.5px] text-bone-400">{d.meta.palette.note} Pigments: {d.meta.palette.names.join(", ")}.</p>
            <h3 className="eyebrow mt-6">Software and type</h3>
            <ul className="mt-1.5 space-y-1 text-[12.5px] text-bone-400">
              {SOFTWARE.map(([name, lic, url]) => (
                <li key={name}><a className="underline decoration-slate-500 underline-offset-2" href={url} target="_blank" rel="noreferrer">{name}</a> · {lic}</li>
              ))}
            </ul>
            <h3 className="eyebrow mt-6">This build</h3>
            <p className="mt-1.5 break-all font-mono text-[11px] text-slate-400">{d.meta.release_id}</p>
            <p className="mt-1 text-[12px] text-bone-400">
              <a className="underline underline-offset-2" href="/trace.json" target="_blank" rel="noreferrer">trace.json</a>: inputs with checksums,
              methods, parameters and QA results for every output (D-013).
            </p>
          </>
        )}
      </div>
    </div>
  );
}
