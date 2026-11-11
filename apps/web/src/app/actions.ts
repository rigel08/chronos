/** Actions shared by components: time changes (with or without a dissolve) and the core sample. */
import { buildIndex, sample } from "../lib/coreSample";
import { clampYear } from "../lib/years";
import { appData, sampleStore, timeStore } from "./state";

/** Set before a time change that should cross-dissolve (steps and jumps, not scrubbing). */
export const transitionNext = { value: false };

export function setYear(t: number, transition = false) {
  const meta = appData()?.meta;
  const c = meta ? clampYear(t, meta.years.min, meta.years.max) : Math.round(t);
  transitionNext.value = transition;
  timeStore.set({ t: c });
}

export function runSample() {
  const d = appData();
  const at = sampleStore.get().at;
  if (!d || !at) return;
  if (!d.sampleIndex) d.sampleIndex = buildIndex(d.g);
  sampleStore.set({ result: sample(d.g, d.meta, d.sampleIndex, at[0], at[1], 5) });
}
sampleStore.subscribe(() => {
  const s = sampleStore.get();
  if (s.at && (!s.result || s.result.lon !== s.at[0] || s.result.lat !== s.at[1])) setTimeout(runSample, 0);
});

