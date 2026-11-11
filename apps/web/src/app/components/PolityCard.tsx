import { useCallback, useMemo, useState } from "react";

import type { WikidataLink } from "../../lib/bundle";
import { useStore } from "../../lib/store";
import { spanLabel, yearLabel } from "../../lib/years";
import { setYear } from "../actions";
import { fetchCatalog, fetchTrace, useLoaded } from "../catalog";
import { appData, regionsAt, rowAt, selectionStore, timeStore } from "../state";

const km2 = (n: number) => `${Math.round(n).toLocaleString()} km²`;
const KIND_TEXT: Record<string, string> = {
  linked: "a grouping or alliance row links them",
  sliver: "small (under 1,000 km² or 1% of the smaller), likely a digitisation edge",
  unlinked: "no relationship recorded: contested, dual claim or digitisation",
  multiple: "three or more polities",
};

export function PolityCard() {
  const polity = useStore(selectionStore, (s) => s.polity);
  const t = useStore(timeStore, (s) => s.t);
  const d = appData();
  const loadCatalog = useCallback(() => (d ? fetchCatalog(d.meta) : Promise.reject(new Error("no data"))), [d]);
  const catalog = useLoaded(d ? loadCatalog : null);
  if (!d || polity < 0) return null;
  const p = d.meta.polities[polity];
  if (!p) return null;
  const g = d.g;
  const colour = d.meta.palette.colours[p.colour] ?? "#888";
  const row = rowAt(d, polity, t);
  const rows = d.territoriesOf[polity] ?? [];
  const clio = d.meta.sources.find((s) => s.id === "cliopatria");
  const shared = row !== null ? regionsAt(d, new Set([row]), t) : [];
  const cat = catalog.value;
  const pf = cat?.polities[p.id];
  const rowKey = row !== null ? String(g.territoryRow[row]) : null;
  const rf = rowKey && cat ? cat.rows[rowKey] : undefined;

  return (
    <article className="space-y-5" aria-label={`${p.name}, polity card`}>
      <header>
        <div className="eyebrow">Polity mapped in Cliopatria</div>
        <h2 className="mt-1 flex items-start gap-2.5 font-display text-[27px] leading-tight text-bone-100">
          <span className="mt-[11px] inline-block size-3 shrink-0 rounded-[3px]" style={{ background: colour }} aria-hidden="true" />
          <span>{p.name}</span>
        </h2>
        <p className="mt-1 text-[12.5px] text-bone-400">
          Mapped {spanLabel(p.start, p.end)} <span className="text-slate-500">· {rows.length} {rows.length === 1 ? "row" : "rows"} · id <span className="font-mono">{p.id}</span></span>
        </p>
      </header>

      {row !== null ? (
        <section>
          <div className="eyebrow">In {yearLabel(t)}</div>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12.5px]">
            <dt className="text-slate-400">Row</dt>
            <dd className="tabular">{spanLabel(g.territoryStart[row] as number, g.territoryEnd[row] as number)} <span className="text-slate-500">· source row {g.territoryRow[row]}</span></dd>
            <dt className="text-slate-400">Polygon area</dt>
            <dd className="tabular">{km2(g.territoryArea[row] as number)} <span className="text-slate-500">(EPSG:6933, as given by the source)</span></dd>
            <dt className="text-slate-400">Shared ground</dt>
            <dd>
              {shared.length === 0 ? <span className="text-bone-400">none: no other polity is mapped on this row's ground in {yearLabel(t)}</span> : (
                <ul className="space-y-1">
                  {shared.map((r) => (
                    <li key={r.region} className="text-bone-400">
                      <span className="text-bone-100">{r.territories.filter((x) => x !== row).map((x) => d.meta.polities[g.territoryPolity[x] as number]?.name).join(", ")}</span>
                      {" "}<span className="tabular">· {km2(r.km2)}</span>
                      <span className="block text-[11.5px] text-slate-500">Both mapped here in Cliopatria; {KIND_TEXT[r.kind] ?? r.kind}.</span>
                    </li>
                  ))}
                </ul>
              )}
            </dd>
          </dl>
        </section>
      ) : (
        <section className="rounded-lg border border-graphite p-3 text-[12.5px] text-bone-400">
          Not mapped in {yearLabel(t)}.
          <span className="mt-2 flex flex-wrap gap-2">
            <button type="button" className="btn" onClick={() => setYear(p.start, true)}>Go to {yearLabel(p.start)}</button>
            <button type="button" className="btn" onClick={() => setYear(p.end, true)}>Go to {yearLabel(p.end)}</button>
          </span>
        </section>
      )}

      <AreaSparkline polity={polity} t={t} />

      {(pf?.notes.length || rf?.notes.length) ? (
        <section className="rounded-lg border border-orpiment/40 bg-orpiment/[0.06] p-3">
          <div className="eyebrow text-orpiment">Under review</div>
          {[...(rf?.notes ?? []), ...(pf?.notes ?? [])].map((n, i) => (
            <p key={i} className="mt-1.5 text-[12px] leading-relaxed text-bone-400">
              {((s) => s.charAt(0).toUpperCase() + s.slice(1))(n.note.replace(/^Under review:\s*/, ""))}
              <span className="mt-1 block text-[11px] text-slate-500">CHRONOS editorial note · {n.reference} · {n.added_on}</span>
            </p>
          ))}
        </section>
      ) : null}

      <section>
        <div className="eyebrow">Wikidata link</div>
        {p.wikidata.length === 0 ? <p className="mt-1.5 text-[12.5px] text-bone-400">Not given by the source.</p>
          : p.wikidata.map((w) => <WikidataRow key={w.value} w={w} />)}
      </section>

      <section>
        <div className="eyebrow">Quality flags</div>
        {catalog.error && <p className="mt-1.5 text-[12px] text-cinnabar">Could not load the QA catalogue: {catalog.error}</p>}
        {!cat && !catalog.error && <p className="mt-1.5 text-[12px] text-slate-500">Loading…</p>}
        {cat && (() => {
          const items = [...(pf?.findings ?? []), ...(rf?.findings ?? [])].filter((f) => f.severity !== "info" || f.rule === "QA-006");
          if (!items.length) return <p className="mt-1.5 text-[12.5px] text-bone-400">No QA rule flags this polity or its current row.</p>;
          return (
            <ul className="mt-1.5 space-y-2">
              {items.map((f, i) => (
                <li key={i} className="text-[12px] leading-relaxed">
                  <span className={`font-mono text-[11px] ${f.severity === "warning" ? "text-orpiment" : "text-slate-400"}`}>{f.rule}</span>
                  <span className="text-slate-400"> · {cat.rules[f.rule] ?? ""}</span>
                  <span className="block text-bone-400">{f.message}</span>
                </li>
              ))}
            </ul>
          );
        })()}
      </section>

      <section>
        <div className="eyebrow">Source and evidence</div>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12.5px]">
          <dt className="text-slate-400">Source</dt>
          <dd>{clio ? <a className="underline decoration-slate-500 underline-offset-2 hover:text-bone-100" href={clio.url ?? "#"} target="_blank" rel="noreferrer">{clio.citation.split(". ")[0]}</a> : "Cliopatria"}</dd>
          <dt className="text-slate-400">Licence</dt>
          <dd>{clio ? <a className="underline decoration-slate-500 underline-offset-2 hover:text-bone-100" href={clio.license_url ?? "#"} target="_blank" rel="noreferrer">{clio.license_name}</a> : "—"} <span className="text-slate-500">· {clio?.access_tier}</span></dd>
          <dt className="text-slate-400">Evidence</dt>
          <dd>{clio?.evidence === "interpreted" ? "Interpreted: an atlas's reading of past territory" : (clio?.evidence ?? "not stated")}</dd>
          <dt className="text-slate-400">Confidence</dt>
          <dd className="text-bone-400">Not stated by the source</dd>
          <dt className="text-slate-400">Release</dt>
          <dd className="break-all font-mono text-[10.5px] text-slate-400">{d.meta.release_id}</dd>
        </dl>
        <HowCalculated />
      </section>
    </article>
  );
}

function WikidataRow({ w }: { w: WikidataLink }) {
  const link = (q: string, label: string | null) => (
    <a className="underline decoration-slate-500 underline-offset-2 hover:text-bone-100" href={`https://www.wikidata.org/wiki/${q}`} target="_blank" rel="noreferrer">
      <span className="font-mono">{q}</span>{label ? ` (${label})` : ""}
    </a>
  );
  return (
    <div className="mt-1.5 text-[12.5px] leading-relaxed text-bone-400">
      {w.status === "corrected" && w.corrected_to ? (
        <>The source gives {link(w.value, w.label)}, which is a different item. Verified correction: {link(w.corrected_to.value, w.corrected_to.label)}.</>
      ) : (
        <>{link(w.value, w.label)} <span className="text-slate-500">· {w.status === "verified" ? "verified" : "as given by the source"}</span></>
      )}
      {w.flags.length > 0 && (
        <span className="mt-1 flex flex-wrap gap-1">{w.flags.map((f) => <span key={f} className="chip">{f.replace(/_/g, " ")}</span>)}</span>
      )}
    </div>
  );
}

function AreaSparkline({ polity, t }: { polity: number; t: number }) {
  const d = appData();
  const pts = useMemo(() => {
    if (!d) return [];
    return (d.territoriesOf[polity] ?? []).map((r) => ({ r, s: d.g.territoryStart[r] as number, e: d.g.territoryEnd[r] as number, a: d.g.territoryArea[r] as number }));
  }, [d, polity]);
  if (!d || pts.length < 2) return null;
  const s0 = Math.min(...pts.map((p) => p.s)), e0 = Math.max(...pts.map((p) => p.e)), amax = Math.max(...pts.map((p) => p.a));
  const W = 348, H = 56;
  const x = (y: number) => ((y - s0) / Math.max(1, e0 + 1 - s0)) * W;
  const y = (a: number) => H - 4 - (a / amax) * (H - 10);
  return (
    <section>
      <div className="eyebrow">Polygon area of each row</div>
      <svg width={W} height={H + 14} className="mt-2 block" role="img" aria-label={`Polygon area per row, peak ${km2(amax)}`}>
        {pts.map((p) => (
          <rect key={p.r} x={x(p.s)} y={y(p.a)} width={Math.max(1, x(p.e + 1) - x(p.s) - 0.5)} height={H - 4 - y(p.a)}
                fill="rgba(233,226,210,0.22)" stroke="rgba(233,226,210,0.5)" strokeWidth={0.5}>
            <title>{`${spanLabel(p.s, p.e)}: ${km2(p.a)}`}</title>
          </rect>
        ))}
        {t >= s0 && t <= e0 && <line x1={x(t)} x2={x(t)} y1={0} y2={H - 4} stroke="#e9e2d2" strokeWidth={1.2} />}
        <text x={0} y={H + 10} className="fill-slate-500 font-mono" style={{ fontSize: 10 }}>{yearLabel(s0)}</text>
        <text x={W} y={H + 10} textAnchor="end" className="fill-slate-500 font-mono" style={{ fontSize: 10 }}>{yearLabel(e0)}</text>
        <text x={W} y={9} textAnchor="end" className="fill-slate-500 font-mono" style={{ fontSize: 10 }}>{km2(amax)}</text>
      </svg>
    </section>
  );
}

function HowCalculated() {
  const [open, setOpen] = useState(false);
  const trace = useLoaded(open ? fetchTrace : null);
  return (
    <div className="mt-3">
      <button type="button" className="text-[12px] text-bone-400 underline decoration-slate-500 underline-offset-2 hover:text-bone-100"
              aria-expanded={open} onClick={() => setOpen(!open)}>How is this calculated?</button>
      {open && (
        <div className="mt-2 space-y-2 rounded-lg border border-graphite p-3 text-[11.5px] leading-relaxed text-bone-400">
          {!trace.value ? <p>{trace.error ?? "Loading the trace…"}</p> : (
            <>
              {(["years", "identity", "areas", "render", "overlaps", "colours"] as const).map((k) => (
                <p key={k}><span className="font-mono text-[10.5px] text-slate-400">{k}</span><br />{trace.value?.methods[k]}</p>
              ))}
              <p className="text-slate-500">Inputs:</p>
              <ul className="space-y-1">
                {trace.value.inputs.map((i) => (
                  <li key={i.source} className="break-all"><span className="text-bone-100">{i.source}</span> {i.release} · {i.license} · <span className="font-mono text-[10px] text-slate-500">{i.sha256?.slice(0, 16) ?? "editorial"}</span></li>
                ))}
              </ul>
              <a className="inline-block underline decoration-slate-500 underline-offset-2" href="/trace.json" target="_blank" rel="noreferrer">Full trace.json</a>
            </>
          )}
        </div>
      )}
    </div>
  );
}
