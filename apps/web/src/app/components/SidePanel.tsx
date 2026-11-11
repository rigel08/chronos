import { useStore } from "../../lib/store";
import { sampleStore, selectionStore, uiStore } from "../state";
import { CoreSamplePanel } from "./CoreSamplePanel";
import { PolityCard } from "./PolityCard";

export function SidePanel() {
  const panel = useStore(uiStore, (s) => s.panel);
  const polity = useStore(selectionStore, (s) => s.polity);
  const at = useStore(sampleStore, (s) => s.at);
  if (panel === "none") return null;
  const tabs: { id: "polity" | "sample"; label: string; enabled: boolean }[] = [
    { id: "polity", label: "Polity", enabled: polity >= 0 },
    { id: "sample", label: "Core sample", enabled: !!at },
  ];
  const close = () => { uiStore.set({ panel: "none" }); selectionStore.set({ polity: -1 }); sampleStore.set({ at: null, result: null }); };
  return (
    <aside className="glass absolute bottom-[164px] right-4 top-[70px] z-20 flex w-[392px] flex-col overflow-hidden rounded-xl" aria-label="Details">
      <div className="flex items-center gap-1 border-b border-graphite px-3 py-2">
        <div role="tablist" className="flex gap-1">
          {tabs.map((tb) => (
            <button key={tb.id} type="button" role="tab" aria-selected={panel === tb.id} disabled={!tb.enabled}
                    className={`rounded-md px-2.5 py-1 text-[12px] ${panel === tb.id ? "bg-bone-100/[0.1] text-bone-100" : "text-slate-400 hover:text-bone-100"} disabled:opacity-35`}
                    onClick={() => uiStore.set({ panel: tb.id })}>{tb.label}</button>
          ))}
        </div>
        <button type="button" className="ml-auto rounded-md px-2 py-1 text-[12px] text-slate-400 hover:text-bone-100" onClick={close} aria-label="Close details">Close</button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-5 pt-4 [scrollbar-color:#262c34_transparent]">
        {panel === "polity" ? <PolityCard /> : <CoreSamplePanel />}
      </div>
    </aside>
  );
}
