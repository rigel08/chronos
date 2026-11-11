/** A minimal external store (no dependency): state outside React, read with useSyncExternalStore. */
import { useSyncExternalStore } from "react";

export interface Store<T extends object> {
  get(): T;
  set(patch: Partial<T> | ((s: T) => Partial<T>)): void;
  subscribe(listener: () => void): () => void;
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(patch) {
      const p = typeof patch === "function" ? patch(state) : patch;
      let changed = false;
      for (const k of Object.keys(p) as (keyof T)[]) {
        if (!Object.is(state[k], p[k])) { changed = true; break; }
      }
      if (!changed) return;
      state = { ...state, ...p };
      for (const l of listeners) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Subscribe a component to one slice. The selector must return a primitive or a stable reference. */
export function useStore<T extends object, S>(store: Store<T>, selector: (s: T) => S): S {
  return useSyncExternalStore(store.subscribe, () => selector(store.get()), () => selector(store.get()));
}
