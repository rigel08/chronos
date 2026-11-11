import { useStore } from "../../lib/store";
import { uiStore } from "../state";

export function TopControls() {
  const projection = useStore(uiStore, (s) => s.projection);
  return (
    <div className="absolute right-4 top-4 z-20 flex items-center gap-2">
      <div className="flex overflow-hidden rounded-md" role="group" aria-label="Projection">
        <button type="button" className="btn rounded-r-none" aria-pressed={projection === "globe"} onClick={() => uiStore.set({ projection: "globe" })}>Globe</button>
        <button type="button" className="btn rounded-l-none border-l-0" aria-pressed={projection === "flat"} onClick={() => uiStore.set({ projection: "flat" })}>Flat</button>
      </div>
      <button type="button" className="btn" onClick={() => uiStore.set({ credits: true })}>Sources &amp; credits</button>
    </div>
  );
}
