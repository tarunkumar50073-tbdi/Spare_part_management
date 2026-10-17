import React from "react";
import {
  ArrowRight, CircleCheck, Database, HeartPulse, IndianRupee, Info, MapPin, RefreshCw, ShieldCheck, Siren,
  TriangleAlert,
} from "lucide-react";
import CardHead from "../CardHead.jsx";
import HorizontalBars from "../HorizontalBars.jsx";
import DonutChart from "../DonutChart.jsx";
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
  // The summary's one figure for zero stock + below minimum — the zero-stock rose.
  "Critical": "#e11d48",
};
const STATUS_LABEL = { "Out of Stock": "Zero stock", "Above Maximum": "Excess (above max)" };

// "Critical" already MEANS zero stock + below minimum, so a dashboard SUMMARY
// shows the two as one figure with the split in small print. Per-part labels,
// filters and exports keep the two statuses apart.
export const CRITICAL_STATUSES = ["Out of Stock", "Below Minimum"];

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

// An Action Tracker target is a plant calendar date ("YYYY-MM-DD"), not an
// instant — it is read and printed in UTC, so the viewer's own time zone can
// never move it to the day before.
const fmtTarget = (ymd) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? ymd : d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" });
};
// "Target 31 Oct", or "Overdue 3 d" once the date has passed (the server counts
// the days against the plant's own date); null when no target has been set.
const dueText = (t) => {
  if (!t?.target_date) return null;
  if (!t.overdue) return `Target ${fmtTarget(t.target_date)}`;
  return t.days_to_target == null ? "Overdue" : `Overdue ${num(Math.abs(t.days_to_target))} d`;
};

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

/** WHAT is wrong · HOW serious · WHERE · HOW MUCH · WHO must act · WHAT to do —
 *  grouped into worst-first severity blocks, each with its own pre-summed count,
 *  under a summary header (open lines, critical parts, money to restock / tied
 *  up). Zero-count lines stay (dimmed, last): "nothing is out of stock" is an
 *  answer, not a gap. `tracker` is the Action Tracker's items keyed by line key
 *  (owner, target date); it is optional — while it loads, or if that call fails,
 *  the board is unchanged and every owner reads "—". `toRestock` is the restock
 *  spend of every short part, for the header tile. */
export function AttentionBoard({ items = [], onOpen, onAction, tracker = null, toRestock = null }) {
  // item.value is a NUMBER from the server (_money -> round(v,2)) or null, so it
  // is formatted with compactMoney, exactly as the live app does — rendering it
  // raw would regress "₹8.6 L" to "860000". fmtVal also passes a pre-formatted
  // string straight through, so the panel survives if that contract ever changes.
  const fmtVal = (v) => (v == null ? null : typeof v === "string" ? v : compactMoney(v));
  const valTitle = (v) => (typeof v === "number" ? money(v) : undefined);
  // compactMoney/fmtVal already prefix "₹"; where a separate ₹ glyph is shown,
  // drop the one in the text so a figure reads "₹ 8.6 L", not "₹ ₹8.6 L".
  const magnitude = (v) => {
    const s = fmtVal(v);
    return typeof s === "string" ? s.replace(/^\s*₹\s?/, "") : s;
  };

  // Effective severity: a zero-count line reads as "OK" (nothing is wrong there)
  // and is dimmed, whatever the server tagged it — defensive even though the
  // server already normalises a zero count to "ok". Unknown severities -> info.
  const rows = React.useMemo(() => {
    const eff = (it) =>
      Number(it.count) === 0 || it.severity === "ok" ? "ok" : SEVERITY[it.severity] ? it.severity : "info";
    return [...items]
      .map((it) => ({ ...it, _sev: eff(it) }))
      .sort((a, b) => SEV_ORDER[a._sev] - SEV_ORDER[b._sev]);
  }, [items]);

  // Worst-first blocks; empty severities drop out so the eye only meets live risk.
  const blocks = ["critical", "warning", "info", "ok"]
    .map((sev) => ({ sev, rows: rows.filter((r) => r._sev === sev) }))
    .filter((b) => b.rows.length);

  // Headline verdict — read straight off the data, nothing fabricated.
  const active = rows.filter((r) => r._sev !== "ok");
  const openLines = active.length;
  // "Critical" counts PARTS, not lines: zero stock + below minimum arrive folded
  // into the one line keyed "critical", whose split is the small print beneath.
  const critical = rows.find((r) => r.key === "critical");
  const criticalParts = Number(critical?.count) || 0;
  // Money is split by NATURE, never summed: restock spend (`toRestock`, for all
  // short parts — the critical and reorder lines below each carry their own
  // share of it) and capital tied up above max (excess) — the same two figures,
  // and the same rose/blue coding, as the Stock Value panel.
  const excess = rows.find((r) => r.key === "excess" && r.value);

  // Subtle severity tints for the block strips — the light canvas stays light,
  // dark glows faintly; every colour is paired for dark mode.
  const BLOCK = {
    critical: { bg: "bg-rose-50 dark:bg-rose-500/10", edge: "border-rose-200/70 dark:border-rose-500/20", text: "text-rose-700 dark:text-rose-300" },
    warning: { bg: "bg-amber-50 dark:bg-amber-500/10", edge: "border-amber-200/70 dark:border-amber-500/20", text: "text-amber-700 dark:text-amber-300" },
    info: { bg: "bg-blue-50 dark:bg-blue-500/10", edge: "border-blue-200/70 dark:border-blue-500/20", text: "text-blue-700 dark:text-blue-300" },
    ok: { bg: "bg-slate-50 dark:bg-navy-800/60", edge: "border-slate-200/70 dark:border-navy-800", text: "text-slate-500 dark:text-slate-400" },
  };

  // One shared column template drives the quiet header row AND every data row, so
  // Count / Value / Where line up in fixed columns across all blocks on a wall screen.
  // From lg a sixth track carries "Action by", and the last (action) track is a
  // fixed width there: the header and each row are separate grids, so an `auto`
  // track would be sized per row and let the columns drift. Below lg there is no
  // room for the column — the owner rides under the Issue label instead.
  const COLS =
    "md:grid-cols-[minmax(0,2.4fr)_minmax(0,0.7fr)_minmax(0,1.3fr)_minmax(0,1.6fr)_auto] "
    + "lg:grid-cols-[minmax(0,2.1fr)_minmax(0,0.7fr)_minmax(0,1.2fr)_minmax(0,1.4fr)_minmax(0,1fr)_11rem]";
  const tile = "rounded-lg border px-3 py-1.5 text-right leading-tight";

  return (
    <div className="card !p-0 overflow-hidden">
      {/* Header: what this is + the one-glance verdict */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 bg-gradient-to-b from-white to-slate-50/60 px-5 py-4 dark:border-navy-800 dark:from-navy-900 dark:to-navy-950/40">
        <div className="flex items-center gap-2.5">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-navy-900 text-white dark:bg-white dark:text-navy-900">
            <Siren size={16} aria-hidden="true" />
          </span>
          <div>
            <h3 className="text-sm font-semibold text-slate-800 dark:text-white">What needs attention</h3>
            <p className="text-[11px] text-slate-400">Worst first · click a line for its parts</p>
          </div>
        </div>
        <div className="flex flex-wrap items-stretch gap-2">
          <div className={`${tile} border-slate-200/70 bg-white dark:border-navy-700 dark:bg-navy-900`}>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Open</div>
            <div className="text-lg font-extrabold tabular text-slate-900 dark:text-white">{num(openLines)}</div>
          </div>
          {criticalParts ? (
            <div className={`${tile} border-rose-200 bg-rose-50 dark:border-rose-500/30 dark:bg-rose-500/10`}>
              <div className="flex items-center justify-end gap-1 text-[10px] font-semibold uppercase tracking-wider text-rose-600/90 dark:text-rose-300/90">
                <Siren size={11} aria-hidden="true" />Critical
              </div>
              <div className="text-lg font-extrabold tabular text-rose-700 dark:text-rose-300">{num(criticalParts)}</div>
              {critical.split && (
                <div className="text-[11px] tabular text-rose-600/90 dark:text-rose-300/90">
                  {num(critical.split.zero)} zero · {num(critical.split.below)} below min
                </div>
              )}
            </div>
          ) : (
            <div className={`${tile} border-emerald-200 bg-emerald-50 dark:border-emerald-500/30 dark:bg-emerald-500/10`}>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-emerald-600/90 dark:text-emerald-300/90">Critical</div>
              <div className="flex items-center justify-end gap-1 text-sm font-bold text-emerald-700 dark:text-emerald-300">
                <CircleCheck size={14} aria-hidden="true" />None
              </div>
            </div>
          )}
          {toRestock > 0 && (
            <div className={`${tile} border-rose-200/70 bg-rose-50/60 dark:border-rose-500/30 dark:bg-rose-500/10`} title={valTitle(toRestock)}>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-rose-600/90 dark:text-rose-300/90">To restock</div>
              <div className="text-lg font-extrabold tabular text-rose-800 dark:text-rose-200">{fmtVal(toRestock)}</div>
            </div>
          )}
          {excess && (
            <div className={`${tile} border-blue-200/70 bg-blue-50/60 dark:border-blue-500/30 dark:bg-blue-500/10`} title={valTitle(excess.value)}>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-blue-600/90 dark:text-blue-300/90">Tied up</div>
              <div className="text-lg font-extrabold tabular text-blue-800 dark:text-blue-200">{fmtVal(excess.value)}</div>
            </div>
          )}
        </div>
      </div>

      {/* Quiet column header (md+) — the alignment key for the columns below */}
      <div className={`hidden gap-3 border-b border-slate-100 pl-5 pr-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:border-navy-800 dark:text-slate-500 md:grid md:items-center ${COLS}`}>
        <span>Issue</span>
        <span>Count</span>
        <span>Value</span>
        <span>Where</span>
        <span className="hidden lg:block">Action by</span>
        <span className="sr-only">Action</span>
      </div>

      {/* Severity blocks, worst first */}
      {blocks.map((block) => {
        const sev = SEVERITY[block.sev];
        const b = BLOCK[block.sev];
        const isCritical = block.sev === "critical";
        const blockCount = block.rows.reduce((s, r) => s + (Number(r.count) || 0), 0);
        return (
          <section key={block.sev} aria-label={`${sev.label} items`}>
            {/* Tinted strip: severity · line count · pre-summed combined count */}
            <div className={`flex items-center justify-between gap-2 border-b ${b.edge} ${b.bg} px-5 py-1.5`}>
              <span className={`inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider ${b.text}`}>
                <sev.Icon size={13} aria-hidden="true" />
                {sev.label}
                <span className="font-semibold normal-case text-slate-400 dark:text-slate-500">· {num(block.rows.length)} {block.rows.length === 1 ? "line" : "lines"}</span>
              </span>
              <span className={`tabular text-[11px] font-bold ${b.text}`}>{num(blockCount)}</span>
            </div>

            <ul className="divide-y divide-slate-100 dark:divide-navy-800">
              {block.rows.map((it) => {
                const dim = it._sev === "ok";
                // Who must act on this line and by when; absent -> "—".
                const who = tracker?.[it.key] || null;
                const due = dueText(who);
                const dueTone = who?.overdue ? "font-semibold text-rose-600 dark:text-rose-400" : "text-slate-400";
                return (
                  <li
                    key={it.key}
                    className={`group relative ${dim ? "opacity-60" : ""} ${
                      isCritical ? "bg-rose-50/40 dark:bg-rose-500/5" : dim ? "" : "transition-colors hover:bg-slate-50 dark:hover:bg-navy-800/40"
                    }`}
                  >
                    {/* Severity rail — widens a touch on hover for a crisp affordance */}
                    <span
                      className={`absolute left-0 top-0 h-full w-1 rounded-r-full transition-all ${!dim ? "group-hover:w-1.5" : ""} ${sev.rail}`}
                      aria-hidden="true"
                    />

                    {/* Whole-row click target → onOpen. Empty button (no interactive
                        children), so the action button below can be a valid sibling. */}
                    <button
                      type="button"
                      onClick={() => onOpen?.(it)}
                      aria-label={`${it.label}: ${num(it.count)}. ${sev.label}.${it.value ? ` ${valTitle(it.value) || fmtVal(it.value)}.` : ""}${who?.owner ? ` Action by ${who.owner.replace(/\.+$/, "")}${due ? `, ${due}` : ""}.` : ""} Open the parts`}
                      className="absolute inset-0 z-[1] focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-toyotared/50"
                    />

                    {/* Content sits above the click target but lets clicks fall through
                        (pointer-events-none); only the action re-enables them. */}
                    <div className={`pointer-events-none relative z-[2] grid grid-cols-1 items-center gap-2 pl-5 pr-4 ${isCritical ? "py-3.5" : "py-3"} md:gap-3 ${COLS}`}>
                      {/* WHAT + why — severity is carried by the strip, rail and count colour */}
                      <div className="min-w-0">
                        <div className={`truncate font-semibold text-slate-800 transition-colors group-hover:text-toyotared dark:text-white ${isCritical ? "text-[15px]" : "text-sm"}`}>{it.label}</div>
                        <div className="truncate text-[11px] text-slate-400">{it.hint}</div>
                        {/* Below lg the "Action by" column is folded away — the owner rides here */}
                        {who?.owner && (
                          <div className="truncate text-[11px] text-slate-400 lg:hidden">
                            Action by <b className="font-semibold text-slate-700 dark:text-slate-200">{who.owner}</b>
                            {due && <span className={dueTone}> · {due}</span>}
                          </div>
                        )}
                      </div>

                      {/* HOW MANY — the hero figure, in the severity colour */}
                      <div className="flex items-baseline gap-2 md:block">
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 md:hidden">Count</span>
                        <span className={`font-bold tabular leading-none ${dim ? "text-slate-400" : sev.text} ${isCritical ? "text-3xl" : "text-2xl"}`}>{num(it.count)}</span>
                      </div>

                      {/* HOW MUCH — lifted into a boxed ₹ metric so it stops hiding in body text */}
                      <div className="min-w-0">
                        {it.value ? (
                          <>
                            <span className="inline-flex items-center gap-1.5 rounded-md border border-slate-200/70 bg-slate-50 px-2 py-0.5 dark:border-navy-700 dark:bg-navy-800/60" title={valTitle(it.value)}>
                              <span className="grid h-4 w-4 place-items-center rounded bg-white text-slate-500 dark:bg-navy-900 dark:text-slate-300">
                                <IndianRupee size={10} aria-hidden="true" />
                              </span>
                              <span className="text-sm font-bold tabular text-slate-900 dark:text-white">{magnitude(it.value)}</span>
                            </span>
                            {/* Wraps rather than truncates: on the critical line this label is what
                                says the money covers ALL short parts, so it must stay readable. */}
                            {it.value_label && <div className="mt-1 text-[11px] leading-snug text-slate-400">{it.value_label}</div>}
                          </>
                        ) : (
                          <span className="text-[11px] text-slate-300 dark:text-slate-600">—</span>
                        )}
                      </div>

                      {/* WHERE — the worst sections holding these parts. A chip never grows past
                          its column (the name gives way first), so on a narrow screen it cannot
                          run into "Action by" beside it. */}
                      <div className="flex min-w-0 flex-wrap gap-1">
                        {(it.sections || []).map((s) => (
                          <span key={s.section_id ?? "none"} className="inline-flex max-w-full items-center gap-1 rounded border border-slate-200/70 bg-white px-1.5 py-0.5 text-[11px] text-slate-600 dark:border-navy-700 dark:bg-navy-900 dark:text-slate-300">
                            <MapPin size={10} className="shrink-0 text-slate-400" aria-hidden="true" /><span className="truncate">{s.name}</span> <b className="tabular text-slate-800 dark:text-white">{num(s.count)}</b>
                          </span>
                        ))}
                      </div>

                      {/* WHO must act, and by when — the Action Tracker's owner and target
                          date. Plain text (no control), so the row click still falls through. */}
                      <div className="hidden min-w-0 lg:block">
                        {who?.owner ? (
                          <>
                            <div className="line-clamp-2 break-words text-xs font-semibold leading-snug text-slate-700 dark:text-slate-200">{who.owner}</div>
                            {due && <div className={`mt-0.5 text-[11px] leading-snug ${dueTone}`}>{due}</div>}
                          </>
                        ) : (
                          <span className="text-[11px] text-slate-300 dark:text-slate-600">—</span>
                        )}
                      </div>

                      {/* WHAT TO DO — always visible when an action exists on a live line
                          (never hover-gated), so it reads on a non-interactive wall screen */}
                      <div className="flex md:justify-end">
                        {it.action && !dim && (
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); onAction?.(it); }}
                            className="pointer-events-auto relative z-[3] inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-slate-600 shadow-sm transition-colors hover:border-toyotared hover:text-toyotared focus:outline-none focus-visible:ring-2 focus-visible:ring-toyotared/50 dark:border-navy-700 dark:bg-navy-900 dark:text-slate-300"
                          >
                            {it.action.label} <ArrowRight size={12} aria-hidden="true" />
                          </button>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ health bar

/** Every part, once, by status — a donut ring (total parts in the centre) over
 *  a legend that carries each status's count, share and value, every row
 *  opening its parts. (Was a 100% stacked bar; the ring reads as a composition
 *  at a glance, the figures stay in the legend where they can be compared.) */
export function HealthBar({ health = [], total, onStatus, onCard }) {
  // Drop "Not Counted": a physical count happens only quarterly and stock will
  // come from ERP, so an uncounted part is not a status to judge here. The ring
  // and the legend show the COUNTED parts by stock status, and the shares are of
  // the counted (not of the whole master). Keys on the DISPLAY label so the
  // colour map lines up; carries the raw status through for the click handler.
  // Zero stock + below minimum are folded into ONE "Critical" slice and legend
  // row (count, share and value summed, the split in small print); its click
  // hands "Critical" to the opener, which lists the parts of both.
  const zero = health.find((h) => h.status === "Out of Stock");
  const below = health.find((h) => h.status === "Below Minimum");
  const shown = [
    ...(zero || below ? [{
      status: "Critical",
      count: (zero?.count || 0) + (below?.count || 0),
      value: (zero?.value || 0) + (below?.value || 0),
      split: `${num(zero?.count || 0)} zero stock · ${num(below?.count || 0)} below minimum`,
    }] : []),
    ...health.filter((h) => h.status !== "Not Counted" && !CRITICAL_STATUSES.includes(h.status)),
  ];
  const counted = shown.reduce((s, h) => s + (h.count || 0), 0);
  const donutData = shown.map((h) => ({
    name: STATUS_LABEL[h.status] || h.status, value: h.count, _status: h.status,
  }));
  const donutColors = Object.fromEntries(
    shown.map((h) => [STATUS_LABEL[h.status] || h.status, STATUS_COLOR[h.status] || "#94a3b8"]));
  return (
    <div
      className={`card ${onCard ? "cursor-pointer transition-shadow hover:border-toyotared/40 hover:shadow-lg" : ""}`}
      onClick={onCard ? (e) => { if (!e.target.closest("button,a,input,select,textarea,[role=button]")) onCard(); } : undefined}
    >
      <CardHead icon={HeartPulse} tone="green" title="Inventory Health" hint={`${num(counted)} counted parts, by stock status`} />
      <div className="flex flex-col items-center gap-3">
        <DonutChart data={donutData} colors={donutColors} size={136} thickness={16}
          centerValue={num(counted)} centerLabel="parts" hideLegend
          onSliceClick={(d) => onStatus?.(d._status)} emptyMessage="No counted parts yet" />
        <table className="w-full text-xs">
          <thead className="sr-only"><tr><th>Status</th><th>Parts</th><th>Share</th><th>Value</th></tr></thead>
          <tbody>
            {shown.map((h) => (
              <tr key={h.status} className="border-b border-slate-100 last:border-0 dark:border-navy-800">
                <td className="py-1.5">
                  <button type="button" onClick={() => onStatus?.(h.status)}
                    className="inline-flex items-center gap-2 text-left text-slate-600 hover:text-toyotared dark:text-slate-300">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: STATUS_COLOR[h.status] }} aria-hidden="true" />
                    {STATUS_LABEL[h.status] || h.status}
                  </button>
                  {/* Indented past the swatch (10px + 8px gap) to sit under the label */}
                  {h.split && <div className="pl-[18px] text-[11px] leading-snug text-slate-400">{h.split}</div>}
                </td>
                <td className="py-1.5 text-right align-top font-semibold tabular text-slate-800 dark:text-white">{num(h.count)}</td>
                <td className="w-14 py-1.5 text-right align-top tabular text-slate-400">{counted ? `${Math.round((h.count / counted) * 100)}%` : "—"}</td>
                <td className="w-20 py-1.5 text-right align-top tabular text-slate-500 dark:text-slate-400" title={money(h.value)}>{h.value ? compactMoney(h.value) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ value panel

/** Where the money on the shelf is: the two numbers that move working capital
 *  (to restock, tied up above max), then by section. Every bar and figure opens
 *  the parts behind it. The by-part-type split lives in its own "Stock value by
 *  category" panel above (section tabs + drill), so it is not repeated here. */
export function ValuePanel({ value, onRestock, onExcess, onSection, onCard }) {
  if (!value) return null;
  const callout = "rounded-lg border px-3 py-2 text-left transition-colors hover:border-toyotared";
  return (
    <div
      className={`card ${onCard ? "cursor-pointer transition-shadow hover:border-toyotared/40 hover:shadow-lg" : ""}`}
      onClick={onCard ? (e) => { if (!e.target.closest("button,a,input,select,textarea,[role=button]")) onCard(); } : undefined}
    >
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
