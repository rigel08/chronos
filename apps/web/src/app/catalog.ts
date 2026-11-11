/** Lazily loaded companions of the bundle: the catalogue (QA findings, review notes) and the trace (D-013). */
import { useEffect, useState } from "react";

import type { BundleMeta } from "../lib/bundle";

export interface Finding { rule: string; severity: "info" | "warning" | "error"; message: string }
export interface Note { note: string; reference: string; added_on: string; source: string }
export interface Catalog {
  rules: Record<string, string>;
  polities: Record<string, { findings: Finding[]; notes: Note[] }>;
  rows: Record<string, { findings: Finding[]; notes: Note[] }>;
}
export interface Trace {
  release_id: string;
  code_fingerprint: string;
  pipeline_version: string;
  inputs: { source: string; release: string | null; sha256: string | null; license: string; access_tier: string; citation: string }[];
  methods: Record<string, string>;
  parameters: Record<string, unknown>;
  qa_summary: Record<string, Record<string, number>>;
}

const cache = new Map<string, Promise<unknown>>();
function once<T>(url: string): Promise<T> {
  let p = cache.get(url);
  if (!p) {
    p = fetch(url).then((r) => { if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.json(); });
    cache.set(url, p);
  }
  return p as Promise<T>;
}

export const fetchCatalog = (meta: BundleMeta) => once<Catalog>(`/${meta.files.catalog.path}`);
export const fetchTrace = () => once<Trace>("/trace.json");

export function useLoaded<T>(load: (() => Promise<T>) | null): { value: T | null; error: string | null } {
  const [state, setState] = useState<{ value: T | null; error: string | null }>({ value: null, error: null });
  useEffect(() => {
    if (!load) return;
    let live = true;
    load().then((value) => live && setState({ value, error: null }), (e: unknown) => live && setState({ value: null, error: String(e) }));
    return () => { live = false; };
  }, [load]);
  return state;
}
