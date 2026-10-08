import React from "react";
import {
  ArrowRight, CircleCheck, Database, HeartPulse, IndianRupee, Info, MapPin, RefreshCw, ShieldCheck, Siren,
  TriangleAlert,
} from "lucide-react";
import CardHead from "../CardHead.jsx";
import HorizontalBars from "../HorizontalBars.jsx";
import { parseServerTime } from "../../lib/format.js";

// The top of the Spare Parts Store dashboard, drawn from ONE server response
// (/dashboard/spare/overview). Built so a manager can answer, in seconds:
// what is wrong, how serious, where, how much money, and what to do next.

const num = (v) => (v == null ? "—" : Number(v).toLocaleString("en-IN"));
const money = (v) =>
  v == null ? "—" : `₹${Number(v).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
export const compactMoney = (v) => {
  if (v == null) return "—";
  const n = Number(v);
  if (n >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`;
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(2)} L`;
  if (n >= 1e3) return `₹${(n / 1e3).toFixed(1)} K`;
  return money(n);
};

// One palette for stock status everywhere on the page (health bar, legend,
// drills) — the same hues the dashboard has always used for these states.
export const STATUS_COLOR = {
  "Out of Stock": "#e11d48",
  "Below Minimum": "#f59e0b",
  "Reorder": "#f97316",
  "Above Maximum": "#3b82f6",
  "Healthy": "#10b981",
  "Not Counted": "#94a3b8",
};
const STATUS_LABEL = { "Out of Stock": "Zero stock", "Above Maximum": "Excess (above max)" };

const SEVERITY = {
  critical: { label: "Critical", Icon: Siren, pill: "bg-rose-600 text-white", rail: "bg-rose-600", text: "text-rose-700 dark:text-rose-300" },
  warning: { label: "Warning", Icon: TriangleAlert, pill: "bg-amber-500 text-white", rail: "bg-amber-500", text: "text-amber-700 dark:text-amber-300" },
  info: { label: "Info", Icon: Info, pill: "bg-blue-600 text-white", rail: "bg-blue-500", text: "text-blue-700 dark:text-blue-300" },
  ok: { label: "OK", Icon: CircleCheck, pill: "bg-emerald-600 text-white", rail: "bg-emerald-500", text: "text-emerald-700 dark:text-emerald-300" },
};
const SEV_ORDER = { critical: 0, warning: 1, info: 2, ok: 3 };

// Server stamps are UTC (often zone-less) — parseServerTime reads them as UTC.
const fmtStamp = (iso) =>
  iso && parseServerTime(iso) ? parseServerTime(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";

// ---------------------------------------------------------------- status strip

/** What the numbers below are built from — stated, not implied. The ERP stock
 *  figure is a snapshot with an age; the write-back is off until ERP's endpoint
 *  exists; the data-completeness figure is the master's own fill rate. */
export function ErpStatusStrip({ erp, quality, generatedAt, onQuality }) {
  if (!erp) return null;
  const snap = erp.stock_snapshot || {};
  const days = snap.age_hours != null ? Math.floor(snap.age_hours / 24) : null;
  const snapTone = snap.state === "SYNCED"
    ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300"
    : snap.state === "STALE"
      ? "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300"
      : "border-slate-200 bg-slate-50 text-slate-600 dark:border-navy-700 dark:bg-navy-800 dark:text-slate-300";
  const chip = "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium";
  return (
    <div className="flex flex-wrap items-center gap-2" aria-label="Data status">
      <span className={`${chip} ${snapTone}`} title="Quantities ERP reported for this store's parts (a snapshot, not a live feed)">
        <Database size={12} aria-hidden="true" />
        ERP stock snapshot: <b className="font-semibold">{snap.state === "NONE" ? "none received" : snap.state}</b>
        {snap.synced_at && <> · {fmtStamp(snap.synced_at)}{days != null && days >= 1 ? ` (${days} d old)` : ""}</>}
      </span>
      <span className={`${chip} border-slate-200 bg-white text-slate-600 dark:border-navy-700 dark:bg-navy-900 dark:text-slate-300`}
        title={erp.write?.reason}>
        <RefreshCw size={12} aria-hidden="true" />
        ERP write-back: <b className="font-semibold">{erp.write?.active ? "on" : "off"}</b>
        {erp.write?.pending ? ` · ${num(erp.write.pending)} movement${erp.write.pending === 1 ? "" : "s"} queued` : ""}
      </span>
      {quality?.completeness_pct != null && (
        <button type="button" onClick={onQuality}
          className={`${chip} border-slate-200 bg-white text-slate-600 hover:border-toyotared hover:text-toyotared dark:border-navy-700 dark:bg-navy-900 dark:text-slate-300`}
          title="Share of Max / Min / Reorder / Rate / Location filled in across all parts">
          <ShieldCheck size={12} aria-hidden="true" />
          Master data complete: <b className="font-semibold">{quality.completeness_pct}%</b>
        </button>
      )}
      {generatedAt && (
        <span className="text-[11px] text-slate-400">Updated {new Date(generatedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</span>
      )}
    </div>
  );
}

// ------------------------------------------------------------- attention board

/** WHAT is wrong · HOW serious · WHERE · HOW MUCH · WHAT to do — one row each,
 *  worst first. Zero-count lines stay (dimmed): "nothing is out of stock" is an
 *  answer, not a gap. */
export function AttentionBoard({ items = [], onOpen, onAction }) {
  const rows = [...items].sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
  const critical = rows.filter((r) => r.severity === "critical").length;
  return (
    <div className="card !p-0 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3 dark:border-navy-800">
        <div>
          <h3 className="text-sm font-semibold text-slate-800 dark:text-white">What needs attention</h3>
          <p className="text-[11px] text-slate-400">Worst first · click a line for its parts</p>
        </div>
        <span className={`rounded-md px-2 py-1 text-[11px] font-bold ${critical ? "bg-rose-600 text-white" : "bg-emerald-600 text-white"}`}>
          {critical ? `${critical} critical` : "No critical issue"}
        </span>
      </div>
      <ul className="divide-y divide-slate-100 dark:divide-navy-800">
        {rows.map((it) => {
          const sev = SEVERITY[it.severity] || SEVERITY.info;
          const dim = it.severity === "ok";
          return (
            <li key={it.key} className={`relative ${dim ? "opacity-60" : ""}`}>
              <span className={`absolute left-0 top-0 h-full w-1 ${sev.rail}`} aria-hidden="true" />
              <div className="grid grid-cols-1 items-center gap-2 py-3 pl-5 pr-4 md:grid-cols-[minmax(0,2.2fr)_minmax(0,0.8fr)_minmax(0,1.3fr)_minmax(0,1.6fr)_auto]">
                <button type="button" onClick={() => onOpen?.(it)}
                  className="flex min-w-0 items-start gap-2.5 text-left group"
                  aria-label={`${it.label}: ${it.count}. ${sev.label}. Open the parts`}>
                  <span className={`mt-0.5 inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${sev.pill}`}>
                    <sev.Icon size={11} aria-hidden="true" />{sev.label}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold text-slate-800 group-hover:text-toyotared dark:text-white">{it.label}</span>
                    <span className="block truncate text-[11px] text-slate-400">{it.hint}</span>
                  </span>
                </button>
                <div className={`text-2xl font-bold tabular leading-none ${dim ? "text-slate-400" : sev.text}`}>{num(it.count)}</div>
                <div className="min-w-0">
                  {it.value ? (
                    <>
                      <div className="text-sm font-semibold tabular text-slate-800 dark:text-white" title={money(it.value)}>{compactMoney(it.value)}</div>
                      <div className="truncate text-[11px] text-slate-400">{it.value_label}</div>
                    </>
                  ) : <span className="text-[11px] text-slate-300 dark:text-slate-600">—</span>}
                </div>
                <div className="flex min-w-0 flex-wrap gap-1">
                  {(it.sections || []).map((s) => (
                    <span key={s.section_id ?? "none"} className="inline-flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600 dark:bg-navy-800 dark:text-slate-300">
                      <MapPin size={10} aria-hidden="true" />{s.name} <b className="tabular">{num(s.count)}</b>
                    </span>
                  ))}
                </div>
                <div className="flex justify-end">
                  {it.action && !dim && (
                    <button type="button" onClick={() => onAction?.(it)}
                      className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-600 hover:border-toyotared hover:text-toyotared dark:border-navy-700 dark:text-slate-300">
                      {it.action.label} <ArrowRight size={12} aria-hidden="true" />
                    </button>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ------------------------------------------------------------------ health bar

/** Every part, once, by status — a single 100% bar plus a legend that opens
 *  each status. Replaces four decorative gauges that re-told the same split. */
export function HealthBar({ health = [], total, onStatus }) {
  const rows = health.filter((h) => h.count > 0);
  return (
    <div className="card">
      <CardHead icon={HeartPulse} tone="green" title="Inventory Health" hint={`All ${num(total)} parts, by stock status`} />
      <div className="flex h-4 w-full overflow-hidden rounded-md bg-slate-100 dark:bg-navy-800" role="img"
        aria-label={rows.map((h) => `${h.status} ${h.count}`).join(", ")}>
        {rows.map((h) => (
          <button key={h.status} type="button" onClick={() => onStatus?.(h.status)}
            title={`${h.status}: ${num(h.count)} (${h.pct}%)`}
            className="h-full transition-opacity hover:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-toyotared"
            style={{ width: `${h.pct}%`, background: STATUS_COLOR[h.status] }} />
        ))}
      </div>
      <table className="mt-3 w-full text-xs">
        <thead className="sr-only"><tr><th>Status</th><th>Parts</th><th>Share</th><th>Value</th></tr></thead>
        <tbody>
          {health.map((h) => (
            <tr key={h.status} className="border-b border-slate-100 last:border-0 dark:border-navy-800">
              <td className="py-1.5">
                <button type="button" onClick={() => onStatus?.(h.status)}
                  className="inline-flex items-center gap-2 text-left text-slate-600 hover:text-toyotared dark:text-slate-300">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: STATUS_COLOR[h.status] }} aria-hidden="true" />
                  {STATUS_LABEL[h.status] || h.status}
                </button>
              </td>
              <td className="py-1.5 text-right font-semibold tabular text-slate-800 dark:text-white">{num(h.count)}</td>
              <td className="w-14 py-1.5 text-right tabular text-slate-400">{h.pct == null ? "—" : `${h.pct}%`}</td>
              <td className="w-20 py-1.5 text-right tabular text-slate-500 dark:text-slate-400" title={money(h.value)}>{h.value ? compactMoney(h.value) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------------ value panel

/** Where the money on the shelf is: the two numbers that move working capital
 *  (to restock, tied up above max), then by section. Every bar and figure opens
 *  the parts behind it. The by-part-type split lives in its own "Stock value by
 *  category" panel above (section tabs + drill), so it is not repeated here. */
export function ValuePanel({ value, onRestock, onExcess, onSection }) {
  if (!value) return null;
  const callout = "rounded-lg border px-3 py-2 text-left transition-colors hover:border-toyotared";
  return (
    <div className="card">
      <CardHead icon={IndianRupee} tone="amber" title="Stock Value" hint="Physical qty × std rate — click to open the parts" />
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <span className="text-2xl font-bold tabular text-slate-900 dark:text-white" title={money(value.total)}>{compactMoney(value.total)}</span>
        <span className="text-[11px] text-slate-400">on the shelf</span>
      </div>
      <div className="mb-4 grid grid-cols-2 gap-2">
        <button type="button" onClick={onRestock} className={`${callout} border-rose-200 bg-rose-50/60 dark:border-rose-500/30 dark:bg-rose-500/10`}>
          <span className="block text-[10px] font-semibold uppercase tracking-wide text-rose-700 dark:text-rose-300">To restock short parts</span>
          <span className="block text-base font-bold tabular text-rose-800 dark:text-rose-200" title={money(value.to_restock)}>{compactMoney(value.to_restock)}</span>
        </button>
        <button type="button" onClick={onExcess} className={`${callout} border-blue-200 bg-blue-50/60 dark:border-blue-500/30 dark:bg-blue-500/10`}>
          <span className="block text-[10px] font-semibold uppercase tracking-wide text-blue-700 dark:text-blue-300">Tied up above max</span>
          <span className="block text-base font-bold tabular text-blue-800 dark:text-blue-200" title={money(value.excess)}>{compactMoney(value.excess)}</span>
        </button>
      </div>
      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">By section</p>
      <HorizontalBars data={(value.by_section || []).map((s) => ({ ...s, name: s.name }))}
        color="#0f8d7e" valueFormat={compactMoney} emptyMessage="No valued stock yet"
        onBarClick={onSection} />
    </div>
  );
}
