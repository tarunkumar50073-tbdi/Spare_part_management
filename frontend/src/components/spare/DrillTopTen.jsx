import React, { useMemo, useState } from "react";
import { Gem } from "lucide-react";
import { money, num } from "../../lib/format.js";

// The Top 10 inside a dashboard drill. Store, 17 Oct 2026, on the Excess Parts
// list: "is type k value wale me top 10 ka chart bhi hona chahiye". Agreed the
// same day: a Top 10 only where the list's question is MONEY — Excess Parts (₹
// tied up) and Stock Value (₹ on the shelf). The short / reorder / critical
// lists get none: there the status ring and the worst-first order already
// answer "what to order first", and a bar chart of shortfalls only repeats it.
//
// Bars run sideways, one row per part, largest on top, because a part is read
// by its number AND its description — ten tilted part numbers under columns
// (the first try) left the description in a hover card nobody finds on the
// floor screen. The figure sits at the end of each bar, so the eye never has to
// travel to an axis.
//
// `spec` names the list's columns:
//   { value: { key, title, hint }, qty?: { key, title, hint } }
// `value` ranks by rupees. `qty`, when given, adds a "₹ Value | Qty" switch —
// Excess only, where most rows carry no rate yet and a ₹ ranking alone would
// silently drop them.

// Below this many rated parts a ₹ ranking is two or three bars with the rest of
// the list missing, so the chart opens on quantity instead and says why.
const MIN_RATED = 5;

const toNum = (v) => (v == null || v === "" ? null : Number(v));

// The ten largest by `key`, from exactly the rows the list shows — no second
// fetch, so the bars and the list can never disagree. A row without the figure
// (no rate) is left out rather than ranked as zero.
function rankTop(rows, key, n = 10) {
  return rows
    .filter((r) => toNum(r[key]) > 0)
    .sort((a, b) => toNum(b[key]) - toNum(a[key]))
    .slice(0, n);
}

// One unit for a set of rows when they all share it ("NOS"), else none — a
// total of 40 NOS + 3 SET is a count, not "43 NOS".
const commonUom = (rows) => {
  const set = new Set(rows.map((r) => (r.uom || "").trim()).filter(Boolean));
  return set.size === 1 ? [...set][0] : "";
};

export default function DrillTopTen({ rows, spec, onPick, wide = false }) {
  const hasQty = Boolean(spec.qty);
  // Two different counts: parts with a rupee figure to rank (> 0), and parts
  // with NO figure at all (no rate). A counted part at zero stock is worth ₹0 —
  // it is rated, just not worth ranking — so only the second makes the note.
  const { valuedCount, unratedCount } = useMemo(() => rows.reduce((acc, r) => {
    const v = toNum(r[spec.value.key]);
    if (v == null || Number.isNaN(v)) acc.unratedCount += 1;
    else if (v > 0) acc.valuedCount += 1;
    return acc;
  }, { valuedCount: 0, unratedCount: 0 }), [rows, spec]);
  // Only a list genuinely missing rates falls back — a short list whose every
  // part is rated is still best ranked by money.
  const fewRated = hasQty && valuedCount < MIN_RATED && valuedCount < rows.length;
  const [mode, setMode] = useState(fewRated ? "qty" : "value");
  const byQty = hasQty && mode === "qty";
  const col = byQty ? spec.qty : spec.value;

  const top = useMemo(() => rankTop(rows, col.key), [rows, col.key]);
  const listTotal = useMemo(
    () => rows.reduce((s, r) => s + (toNum(r[col.key]) > 0 ? toNum(r[col.key]) : 0), 0), [rows, col.key]);
  const topTotal = top.reduce((s, r) => s + toNum(r[col.key]), 0);
  const max = top.length ? toNum(top[0][col.key]) : 0;
  const listUom = byQty ? commonUom(rows) : "";
  const fmt = (v, uom) => (byQty ? `${num(v)}${uom ? ` ${uom}` : ""}` : money(v));
  const share = listTotal > 0 ? Math.round((topTotal / listTotal) * 100) : null;

  const note = byQty
    ? (fewRated ? `Only ${num(valuedCount)} of ${num(rows.length)} parts have a rate — ranked by quantity` : null)
    : (unratedCount > 0
      ? `Ranked over the ${num(rows.length - unratedCount)} of ${num(rows.length)} parts that carry a rate${hasQty ? " — Qty ranks them all" : ""}`
      : null);

  // Side panel (and any phone): part on one line, its bar under it. Spanning the
  // drill from md up: part · bar · figure on ONE line, so ten rows stay short
  // enough to leave the list its height.
  const gridCls = wide
    ? "grid-cols-[1.25rem_minmax(0,1fr)] md:grid-cols-[1.25rem_minmax(0,17rem)_minmax(0,1fr)] lg:grid-cols-[1.25rem_minmax(0,24rem)_minmax(0,1fr)]"
    : "grid-cols-[1.25rem_minmax(0,1fr)]";
  const rankCls = wide ? "row-span-2 md:row-span-1" : "row-span-2";
  const barCls = wide ? "col-start-2 row-start-2 md:col-start-3 md:row-start-1" : "col-start-2 row-start-2";
  // The side panel (Excess) shares the drill's height with nothing, so on a
  // 1366×768 screen its two-line rows ran the total off the bottom: tighter
  // rows there, and from xl a column whose bars alone scroll — the title, the
  // rate note and the total always stay in view.
  const rowCls = wide ? "gap-y-1 py-1.5 md:py-1" : "gap-y-0.5 py-1";

  return (
    <div className={wide ? "min-w-0" : "min-w-0 xl:flex xl:min-h-0 xl:flex-col"}>
      <div className="mb-2.5 flex shrink-0 flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-600 dark:bg-blue-500/15 dark:text-blue-300">
            <Gem size={16} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold leading-tight text-slate-800 dark:text-white">{col.title}</h3>
            <p className="mt-0.5 text-[11px] leading-tight text-slate-400">{col.hint} · tap a part to open it</p>
          </div>
        </div>
        {hasQty && (
          <div role="group" aria-label="Rank the top 10 by"
            className="inline-flex shrink-0 rounded-lg border border-slate-200 bg-white p-0.5 dark:border-navy-700 dark:bg-navy-900">
            {[["value", "₹ Value"], ["qty", "Qty"]].map(([k, text]) => (
              <button key={k} type="button" aria-pressed={mode === k} onClick={() => setMode(k)}
                className={`rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors ${mode === k
                  ? "bg-toyotared text-white"
                  : "text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-navy-800"}`}>
                {text}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Above the bars, so the reader knows what was ranked before reading it. */}
      {note && <p className="mb-2 shrink-0 px-1 text-[11px] leading-snug text-slate-400">{note}</p>}

      {top.length === 0 ? (
        <p className="py-10 text-center text-sm text-slate-400">
          {byQty ? "Nothing in this list to rank" : `No part in this list carries a rate yet${hasQty ? " — switch to Qty" : ""}`}
        </p>
      ) : (
        <ol className={wide ? "space-y-0.5" : "xl:min-h-0 xl:overflow-y-auto"} aria-label={col.title}>
          {top.map((r, i) => {
            const v = toNum(r[col.key]);
            const figure = fmt(v, (r.uom || "").trim());
            const full = `${r.part_no || "—"}${r.part_name ? ` — ${r.part_name}` : ""}`;
            return (
              <li key={`${r.part_id ?? r.part_no}-${i}`}>
                <button type="button" onClick={() => onPick && onPick(r)} title={`${full}\n${figure}`}
                  aria-label={`${i + 1}. ${full}: ${figure}`}
                  className={`group grid w-full items-center gap-x-3 rounded-lg px-1.5 ${rowCls} text-left transition-colors hover:bg-slate-100/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-toyotared/40 dark:hover:bg-navy-800/60 ${gridCls}`}>
                  <span className={`col-start-1 row-start-1 self-center text-right text-[11px] font-bold tabular text-slate-400 ${rankCls}`}>{i + 1}</span>
                  <span className="col-start-2 row-start-1 block min-w-0 truncate text-xs">
                    <span className="font-mono font-bold text-slate-800 group-hover:text-toyotared dark:text-white">{r.part_no || "—"}</span>
                    {r.part_name && <span className="text-slate-500 dark:text-slate-400"> · {r.part_name}</span>}
                  </span>
                  <span className={`flex min-w-0 items-center gap-2 ${barCls}`}>
                    {/* Scaled to the largest bar (this compares parts, it is not a
                        share of the list); 6.5rem kept back for the figure. */}
                    <span className="block h-2.5 shrink-0 rounded-full"
                      style={{
                        width: `calc((100% - 6.5rem) * ${max > 0 ? v / max : 0})`, minWidth: 3,
                        background: "linear-gradient(90deg,#2563eb,#60a5fa)",
                      }} />
                    <span className="shrink-0 whitespace-nowrap text-xs font-semibold tabular text-slate-800 dark:text-white">{figure}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}

      {top.length > 0 && (
        <div className="mt-2 flex shrink-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-t border-slate-200 px-1 pt-2.5 dark:border-navy-800">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Top {top.length} total</span>
          <span className="text-right">
            <span className="text-lg font-extrabold tabular text-slate-800 dark:text-white">{fmt(topTotal, listUom)}</span>
            <span className="ml-1.5 text-[11px] text-slate-400">
              of {fmt(listTotal, listUom)} in this list{share != null ? ` · ${share}%` : ""}
            </span>
          </span>
        </div>
      )}
    </div>
  );
}
