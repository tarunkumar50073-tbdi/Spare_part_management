import React, { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Boxes, Gauge, History, Hourglass, IndianRupee, Info, RefreshCw, ShoppingCart, Siren, TrendingDown,
  TriangleAlert, X,
} from "lucide-react";
import CardHead from "../../components/CardHead.jsx";
import Table from "../../components/Table.jsx";
import { useStores } from "../../context/StoreContext.jsx";
import { usePartDrawer } from "../../context/PartDrawerContext.jsx";
import { inventoryControlService } from "../../services/inventoryControlService.js";
import { storeService } from "../../services/storeService.js";
import { NO_ROWS } from "../../lib/stockQueries.js";
import { compactMoney, fmtDate, money, num, parseServerTime } from "../../lib/format.js";
import { STATUS_RANK, fmtDay } from "../../lib/inventory.js";

// Inventory Control: the four lists a store controller acts on, from ONE server
// response (/inventory-control), so the tabs can never disagree with each other
// or with Store Stock. Critical = empty or about to be; Short = under the
// planned minimum; Reorder = what to order and for how much; Excess = money held
// above max, and for how long. Only counted parts are judged: a part nobody has
// counted is not a part with none.

const TABS = [
  { key: "critical", label: "Critical", icon: Siren, tone: "red" },
  { key: "short", label: "Short", icon: TrendingDown, tone: "amber" },
  { key: "reorder", label: "Reorder", icon: ShoppingCart, tone: "orange" },
  { key: "excess", label: "Excess", icon: Boxes, tone: "blue" },
];
const TAB_KEYS = TABS.map((t) => t.key);

// .card paints its own gradient, so the selected tab is marked by ring + rail
// rather than a background tint.
const TAB_TONE = {
  red: { ring: "ring-2 ring-rose-400/60 border-rose-300 dark:border-rose-500/50", rail: "bg-rose-600",
    chip: "bg-rose-50 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300", count: "text-rose-700 dark:text-rose-300" },
  amber: { ring: "ring-2 ring-amber-400/60 border-amber-300 dark:border-amber-500/50", rail: "bg-amber-500",
    chip: "bg-amber-50 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300", count: "text-amber-700 dark:text-amber-300" },
  orange: { ring: "ring-2 ring-orange-400/60 border-orange-300 dark:border-orange-500/50", rail: "bg-orange-500",
    chip: "bg-orange-50 text-orange-600 dark:bg-orange-500/15 dark:text-orange-300", count: "text-orange-700 dark:text-orange-300" },
  blue: { ring: "ring-2 ring-blue-400/60 border-blue-300 dark:border-blue-500/50", rail: "bg-blue-500",
    chip: "bg-blue-50 text-blue-600 dark:bg-blue-500/15 dark:text-blue-300", count: "text-blue-700 dark:text-blue-300" },
};

const PILL = "inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap";
const REASONS = ["Zero stock", "Below minimum", "Low cover (est.)"];
const REASON_TONE = {
  "Zero stock": "bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300",
  "Below minimum": "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300",
  "Low cover (est.)": "bg-orange-100 text-orange-700 dark:bg-orange-500/20 dark:text-orange-300",
};
const REASON_COUNT = { "Zero stock": "critical_zero", "Below minimum": "critical_below_min", "Low cover (est.)": "critical_low_cover" };
const STATUS_TONE = {
  "Out of Stock": REASON_TONE["Zero stock"],
  "Below Minimum": REASON_TONE["Below minimum"],
  "Reorder": "bg-orange-100 text-orange-700 dark:bg-orange-500/20 dark:text-orange-300",
};
const STATUS_LABEL = { "Out of Stock": "Zero stock", "Below Minimum": "Below min", "Reorder": "At reorder" };

// Excess aging. The dated buckets are one blue ramp, light to dark with age
// (validated ordinal steps, stepped separately for the dark surface); the
// buckets the ledger cannot date are grey AND hatched, so "not dated" never
// reads as one more shade of age.
const AGE_FILL = {
  "0-30": "bg-[#86b6ef] dark:bg-[#184f95]",
  "31-60": "bg-[#3987e5] dark:bg-[#2a78d6]",
  "61-90": "bg-[#1c5cab] dark:bg-[#6da7ec]",
  "90+": "bg-[#0d366b] dark:bg-[#b7d3f6]",
  before_tracking: "bg-slate-400 dark:bg-slate-500",
  no_ledger: "bg-slate-500 dark:bg-slate-400",
  unknown: "bg-slate-300 dark:bg-slate-600",
};
const HATCH = { backgroundImage: "repeating-linear-gradient(135deg, rgba(255,255,255,0.45) 0 2px, transparent 2px 6px)" };
const UNDATED = new Set(["before_tracking", "no_ledger", "unknown"]);
// Shown only when they hold a part; "Before tracking" always has its slot.
const RARE_BUCKETS = new Set(["no_ledger", "unknown"]);
const AGE_ORDER = { "0-30": 0, "31-60": 1, "61-90": 2, "90+": 3, before_tracking: 4, no_ledger: 5, unknown: 6 };

// Why a listed part has no order quantity (order_basis from the server).
const NO_QTY_LABEL = { no_levels: "no min / max", no_max: "no max set", at_max: "at or above max" };
const BASIS_LABEL = { max: "Max", min: "Min (no max set)" };

const dash = <span className="text-slate-300 dark:text-slate-600">—</span>;
const qtyCell = (v) => (v == null ? dash : num(v));
// Money that is unknown (no rate) rather than zero.
const moneyOrNoRate = (v) => (v == null ? "no rate" : money(v));

function agingText(r) {
  switch (r.aging_basis) {
    case "crossing": return `Since ${fmtDay(r.excess_since)}`;
    case "above_at_first_row": return `Before tracking (over at ${fmtDay(r.excess_since_at_least)})`;
    case "no_ledger":
      return r.excess_since_at_least ? `No ledger row (over at ${fmtDay(r.excess_since_at_least)})` : "No ledger row";
    case "ledger_not_above": return "Change not recorded";
    default: return "";
  }
}

function agingTitle(r, ledgerSince) {
  switch (r.aging_basis) {
    case "crossing":
      return `Balance went above today's max on ${fmtDate(r.excess_since)} and has stayed above since`;
    case "above_at_first_row":
      return `Already above max at its first ledger row (${fmtDate(r.excess_since_at_least)}); when it first went over cannot be dated`;
    case "no_ledger":
      return `No movement recorded for this part in the app's ledger${ledgerSince ? ` (the ledger starts ${fmtDate(ledgerSince)})` : ""}. `
        + (r.excess_since_at_least
          ? `Its quantity was last recorded on ${fmtDate(r.excess_since_at_least)}, already above today's max; `
          : "When its quantity was recorded is not known; ")
        + "when it first went over max cannot be dated.";
    case "ledger_not_above":
      return "The ledger's last balance is not above max, so the change that put this part over max was not recorded";
    default: return "";
  }
}

// ---------------------------------------------------------------- columns

const qtyCol = (key, label, extra = {}) => ({
  key, label, align: "right", sortable: true, render: (r) => qtyCell(r[key]), ...extra,
});
const moneyCol = (key, label, extra = {}) => ({
  key, label, align: "right", sortable: true, exportValue: (r) => r[key] ?? "",
  render: (r) => (r[key] == null ? dash : money(r[key])), ...extra,
});
const PART_NO = {
  key: "part_no", label: "Part No", sortable: true,
  render: (r) => <span className="font-medium text-slate-800 dark:text-white">{r.part_no}</span>,
};
const DESCRIPTION = {
  key: "part_name", label: "Description", sortable: true,
  render: (r) => <span className="block max-w-[240px] truncate" title={r.part_name || ""}>{r.part_name || "—"}</span>,
};
const SECTION = { key: "section", label: "Section", sortable: true };
const LOCATION = { key: "location", label: "Location", sortable: true, render: (r) => r.location || dash };
const IN_STOCK = qtyCol("qty_on_hand", "In Stock", { render: (r) => <span className="font-semibold">{num(r.qty_on_hand)}</span> });
const ISSUED = qtyCol("issued_90d", "Issued 90 d", { render: (r) => (r.issued_90d ? num(r.issued_90d) : dash) });
const LAST_ISSUE = {
  key: "last_issue_at", label: "Last issue", sortable: true,
  exportValue: (r) => fmtDay(r.last_issue_at) || "", render: (r) => fmtDay(r.last_issue_at) || dash,
};
const SUPPLIER = {
  key: "supplier", label: "Last supplier (gate)", sortable: true,
  render: (r) => (r.supplier
    ? <span title={`${r.supplier_code || ""} · last gate arrival ${fmtDay(r.last_arrival) || "—"}`}>{r.supplier}</span>
    : dash),
};

const CRITICAL_COLS = [
  PART_NO, DESCRIPTION, SECTION, LOCATION,
  {
    key: "reason", label: "Why", sortValue: (r) => REASONS.indexOf(r.reason),
    exportValue: (r) => r.reasons.join(", "),
    render: (r) => (
      <span className="inline-flex gap-1">
        {r.reasons.map((x) => <span key={x} className={`${PILL} ${REASON_TONE[x]}`}>{x}</span>)}
      </span>
    ),
  },
  IN_STOCK, qtyCol("min_stock_level", "Min"), qtyCol("short_qty", "Short"),
  qtyCol("days_cover", "Est. days cover", {
    render: (r) => (r.days_cover == null ? dash
      : <span title="Estimate: in stock / average daily issue. Not a forecast.">{num(r.days_cover)} d</span>),
  }),
  ISSUED, LAST_ISSUE, SUPPLIER,
  { key: "recommended_action", label: "Action" },
];

const SHORT_COLS = [
  PART_NO, DESCRIPTION, SECTION, LOCATION,
  IN_STOCK, qtyCol("min_stock_level", "Min"), qtyCol("max_stock_level", "Max"),
  qtyCol("short_qty", "Short qty", {
    render: (r) => <span className="font-semibold text-amber-700 dark:text-amber-400">{num(r.short_qty)}</span>,
  }),
  { key: "recommended_action", label: "Recommended action" },
  moneyCol("order_value", "Order value"),
  ISSUED, LAST_ISSUE, SUPPLIER,
];

const REORDER_COLS = [
  PART_NO, DESCRIPTION,
  {
    key: "status", label: "Status", sortValue: (r) => STATUS_RANK[r.status] ?? 9, exportValue: (r) => r.status,
    render: (r) => <span className={`${PILL} ${STATUS_TONE[r.status] || ""}`}>{STATUS_LABEL[r.status] || r.status}</span>,
  },
  SECTION, LOCATION,
  IN_STOCK, qtyCol("min_stock_level", "Min"), qtyCol("reorder_level", "Reorder"), qtyCol("max_stock_level", "Max"),
  qtyCol("recommended_order_qty", "Order qty", {
    exportValue: (r) => r.recommended_order_qty ?? NO_QTY_LABEL[r.order_basis] ?? "",
    render: (r) => (r.recommended_order_qty == null
      ? <span className="text-[11px] italic text-slate-400" title={r.recommended_action}>{NO_QTY_LABEL[r.order_basis] || "none"}</span>
      : <span className="font-semibold text-orange-700 dark:text-orange-400">{num(r.recommended_order_qty)}</span>),
  }),
  {
    key: "order_basis", label: "Up to", sortable: true,
    exportValue: (r) => BASIS_LABEL[r.order_basis] || "",
    render: (r) => BASIS_LABEL[r.order_basis] || dash,
  },
  moneyCol("unit_price", "Rate"),
  moneyCol("order_value", "Order value", {
    render: (r) => (r.order_value != null ? <span className="font-semibold">{money(r.order_value)}</span>
      : r.recommended_order_qty ? <span className="text-[11px] italic text-slate-400">no rate</span> : dash),
  }),
  SUPPLIER, LAST_ISSUE,
];

const excessCols = (ledgerSince) => [
  PART_NO, DESCRIPTION, SECTION, LOCATION,
  IN_STOCK, qtyCol("max_stock_level", "Max"),
  qtyCol("excess_qty", "Excess qty", {
    render: (r) => <span className="font-semibold text-blue-700 dark:text-blue-300">{num(r.excess_qty)}</span>,
  }),
  qtyCol("excess_pct", "Excess %", { render: (r) => `${num(r.excess_pct)}%` }),
  moneyCol("excess_value", "Excess value", {
    render: (r) => (r.excess_value == null
      ? <span className="text-[11px] italic text-slate-400">no rate</span>
      : <span className="font-semibold">{money(r.excess_value)}</span>),
  }),
  qtyCol("days_in_excess", "Days over max", {
    render: (r) => (r.days_in_excess == null ? dash
      : <span title={agingTitle(r, ledgerSince)}>{num(r.days_in_excess)} d</span>),
  }),
  {
    key: "aging_bucket", label: "Aging", sortValue: (r) => AGE_ORDER[r.aging_bucket] ?? 9,
    exportValue: agingText, searchValue: agingText,
    render: (r) => (
      <span className={UNDATED.has(r.aging_bucket) ? "text-slate-500 dark:text-slate-400" : ""}
        title={agingTitle(r, ledgerSince)}>{agingText(r)}</span>
    ),
  },
  LAST_ISSUE, ISSUED, SUPPLIER,
];

// ---------------------------------------------------------------- pieces

function Note({ children }) {
  return (
    <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
      <Info size={13} className="mt-px shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

function FilterChip({ on, onClick, children }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on}
      className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${on
        ? "bg-toyotared text-white border-toyotared"
        : "border-slate-200 dark:border-navy-700 text-slate-600 dark:text-slate-300 hover:border-toyotared"}`}>
      {children}
    </button>
  );
}

function Headline({ icon: Icon, label, value, children }) {
  return (
    <div className="card">
      <div className="flex items-center justify-between gap-2">
        <p className="kpi-label">{label}</p>
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-navy-900/[0.06] text-navy-900 dark:bg-white/10 dark:text-white">
          <Icon size={16} aria-hidden="true" />
        </span>
      </div>
      {/* null = parts are listed but none has a rate: unknown, never a firm 0. */}
      {value == null
        ? <p className="kpi-value mt-2 text-slate-400 dark:text-slate-500" title="No part in this list has a rate">No rate</p>
        : <p className="kpi-value mt-2" title={money(value)}>{compactMoney(value)}</p>}
      <div className="mt-2 space-y-1">{children}</div>
    </div>
  );
}

/** One bar split by how long the excess parts have been over max (width = part
 *  count), with a legend that carries the counts and the money. Clicking a
 *  bucket filters the list below; clicking it again clears. */
function AgingBar({ buckets, active, onPick, ledgerSince }) {
  const shown = buckets.filter((b) => !RARE_BUCKETS.has(b.key) || b.count > 0);
  const total = shown.reduce((s, b) => s + b.count, 0);
  const label = (b) => b.label;
  // A bucket's money: unknown when every part in it is unrated.
  const worth = (b) => `${moneyOrNoRate(b.value)}${b.unrated && b.value != null ? ` + ${b.unrated} unrated` : ""}`;
  if (!total) return <p className="py-4 text-center text-sm text-slate-400">No counted part is above its maximum.</p>;
  return (
    <div>
      {/* The bar is a picture (mouse shortcut only); the legend buttons below
          are the keyboard and screen-reader control. */}
      <div className="flex h-3 w-full gap-[2px] overflow-hidden rounded" role="img"
        aria-label={shown.filter((b) => b.count).map((b) => `${label(b)}: ${b.count} parts`).join(", ")}>
        {shown.filter((b) => b.count > 0).map((b) => (
          <button key={b.key} type="button" onClick={() => onPick(b.key)} tabIndex={-1} aria-hidden="true"
            title={`${label(b)}: ${num(b.count)} part${b.count === 1 ? "" : "s"} · ${worth(b)}`}
            className={`h-full transition-opacity ${AGE_FILL[b.key]} ${active && active !== b.key ? "opacity-30" : ""}`}
            style={{ width: `${(b.count / total) * 100}%`, minWidth: 4, ...(UNDATED.has(b.key) ? HATCH : {}) }} />
        ))}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {shown.map((b) => (
          <button key={b.key} type="button" disabled={!b.count} onClick={() => onPick(b.key)} aria-pressed={active === b.key}
            className={`rounded-lg border px-2.5 py-2 text-left transition-colors disabled:cursor-default disabled:opacity-50 ${active === b.key
              ? "border-toyotared ring-1 ring-toyotared/30"
              : "border-slate-200 hover:border-slate-300 dark:border-navy-700 dark:hover:border-navy-600"}`}>
            <span className="flex items-center gap-1.5 text-[11px] font-medium text-slate-500 dark:text-slate-400">
              <span className={`h-2.5 w-2.5 shrink-0 rounded-sm ${AGE_FILL[b.key]}`} style={UNDATED.has(b.key) ? HATCH : undefined} aria-hidden="true" />
              {label(b)}
            </span>
            <span className="mt-0.5 block text-sm font-semibold tabular text-slate-800 dark:text-white">
              {num(b.count)} <span className="text-[11px] font-normal text-slate-400">part{b.count === 1 ? "" : "s"}</span>
            </span>
            <span className="block text-[11px] tabular text-slate-500 dark:text-slate-400">{worth(b)}</span>
            {b.key === "before_tracking" && ledgerSince && (
              <span className="block text-[10px] text-slate-400">ledger starts {fmtDate(ledgerSince)}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- page

export default function InventoryControl() {
  const { activeCode, activeStore } = useStores();
  const { openPart } = usePartDrawer();
  // Tab and section live in the URL, so a link lands on the right list and the
  // back button undoes a switch.
  const [params, setParams] = useSearchParams();
  const tab = TAB_KEYS.includes(params.get("tab")) ? params.get("tab") : "critical";
  const section = params.get("section") || "";
  const setParam = (key, value) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    if (value) next.set(key, value); else next.delete(key);
    return next;
  }, { replace: true });
  const [reason, setReason] = useState("");
  const [age, setAge] = useState("");

  const on = Boolean(activeCode);
  const sectionsQ = useQuery({
    queryKey: ["sections", activeCode], enabled: on, staleTime: 5 * 60_000,
    queryFn: () => storeService.sections(activeCode).then((r) => r.data.data || []),
  });
  const sections = sectionsQ.data ?? NO_ROWS;
  // A stale ?section= (a section since removed) falls back to the whole store
  // instead of showing four empty lists.
  const sectionId = section && (!sectionsQ.isSuccess || sections.some((s) => String(s.id) === section))
    ? (Number(section) || null) : null;

  // Under "stock", so the app's SSE stock push (issue, receipt, count, part
  // master edit) refreshes these lists with every other stock screen.
  const q = useQuery({
    queryKey: ["stock", "inventory-control", activeCode, sectionId],
    enabled: on,
    queryFn: () => inventoryControlService.overview(activeCode, sectionId ?? undefined).then((r) => r.data.data),
  });
  const d = q.data;
  const t = d?.totals;
  const loading = on && q.isPending;
  const ledgerSince = d?.ledger_since || null;

  const criticalRows = useMemo(() => {
    const rows = d?.critical ?? NO_ROWS;
    return reason ? rows.filter((r) => r.reasons.includes(reason)) : rows;
  }, [d, reason]);
  const excessRows = useMemo(() => {
    const rows = d?.excess ?? NO_ROWS;
    return age ? rows.filter((r) => r.aging_bucket === age) : rows;
  }, [d, age]);
  const EXCESS_COLS = useMemo(() => excessCols(ledgerSince), [ledgerSince]);

  const errorMsg = q.error?.response?.data?.message || q.error?.message || "Unknown error";
  const nothingCounted = t && t.counted === 0;
  const empty = (text) => (nothingCounted
    ? "No part in this view has been counted yet, so nothing can be judged"
    : text);

  const sub = {
    critical: t ? `${num(t.critical_zero)} zero · ${num(t.critical_below_min)} below min · ${num(t.critical_low_cover)} low cover` : "",
    short: t ? "Below the planned minimum" : "",
    // restock / excess value is null when parts are listed but none is rated.
    reorder: !t ? "" : !t.reorder ? "Nothing at or below reorder"
      : t.restock_value ? `${compactMoney(t.restock_value)} to order`
        : t.restock_value == null ? "No rated order value" : "No order quantity worked out",
    excess: !t ? "" : !t.excess ? "Nothing above max"
      : t.excess_value ? `${compactMoney(t.excess_value)} above max` : "No rated excess value",
  };
  const toOrder = t ? t.reorder - t.reorder_no_qty : 0;

  // Keyed by tab at each use, so search / sort start fresh on every list.
  const tableProps = (rows) => ({
    rows,
    loading,
    searchable: "Search part no, description, location or supplier…",
    pageSize: 0,
    maxHeight: "60vh",
    virtualize: rows.length > 80,
    exportName: `inventory_${tab}`,
    columnToggle: true,
    rowKey: (r) => r.part_id,
    onRowClick: (r) => openPart(r.part_id),
  });

  const header = (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-lg font-bold text-slate-800 dark:text-white">Inventory Control</h2>
        <p className="text-xs text-slate-400 mt-0.5">
          Critical, short, reorder and excess parts in {activeStore?.name || "this store"}: counted stock judged
          against each part's planned min, reorder level and max
        </p>
      </div>
      {on && (
        <label className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
          Section
          <select className="input-field w-auto py-1.5 text-[13px]" value={sectionId ? String(sectionId) : ""}
            onChange={(e) => { setParam("section", e.target.value); setAge(""); setReason(""); }}>
            <option value="">All sections</option>
            {sections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
      )}
    </div>
  );

  if (!on) {
    return (
      <div className="space-y-6">
        {header}
        <div className="card text-sm text-slate-500">No store selected. Pick a store in the sidebar to see its lists.</div>
      </div>
    );
  }

  if (q.isError && !d) {
    return (
      <div className="space-y-6">
        {header}
        <div className="card flex flex-wrap items-center justify-between gap-3">
          <p className="flex items-center gap-2 text-sm text-rose-700 dark:text-rose-300">
            <TriangleAlert size={16} aria-hidden="true" /> Could not load the inventory control lists: {errorMsg}
          </p>
          <button type="button" className="btn-secondary" onClick={() => q.refetch()}>
            <RefreshCw size={14} aria-hidden="true" /> Retry
          </button>
        </div>
      </div>
    );
  }

  const chip = "inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-600 dark:border-navy-700 dark:bg-navy-900 dark:text-slate-300";

  return (
    <div className="space-y-6">
      {header}

      {q.isError && d && (
        <div className="card flex flex-wrap items-center justify-between gap-3 !py-3">
          <p className="flex items-center gap-2 text-xs text-amber-700 dark:text-amber-300">
            <TriangleAlert size={14} aria-hidden="true" /> Could not refresh ({errorMsg}); showing the last loaded figures.
          </p>
          <button type="button" className="btn-secondary !py-1.5 text-[13px]" onClick={() => q.refetch()}>
            <RefreshCw size={14} aria-hidden="true" /> Retry
          </button>
        </div>
      )}

      {/* What the figures below are built from, stated rather than implied. */}
      {d && (
        <div className="flex flex-wrap items-center gap-2" aria-label="Data basis">
          <span className={chip} title="Issues, aging and cover are read from the app's own stock ledger">
            <History size={12} aria-hidden="true" />
            {ledgerSince ? <>App ledger starts <b className="font-semibold">{fmtDate(ledgerSince)}</b></> : "No ledger movement recorded yet"}
          </span>
          <span className={chip} title={d.cover.basis}>
            <Gauge size={12} aria-hidden="true" />
            Days of cover: estimate from {num(d.cover.window_days)} days of issues
          </span>
          {t.not_counted > 0 && (
            <Link to={`/store-stock-spare?status=Not%20Counted${sectionId ? `&section=${sectionId}` : ""}`}
              className={`${chip} hover:border-toyotared hover:text-toyotared`}
              title="A part nobody has counted cannot be judged short or excess">
              <Info size={12} aria-hidden="true" />
              {num(t.not_counted)} never counted: not in any list
            </Link>
          )}
          {d.generated_at && (
            <span className="text-[11px] text-slate-400">
              Updated {parseServerTime(d.generated_at)?.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
            </span>
          )}
        </div>
      )}

      <div role="tablist" aria-label="Inventory control lists" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {TABS.map((tb) => {
          const sel = tab === tb.key;
          const tone = TAB_TONE[tb.tone];
          return (
            <button key={tb.key} type="button" role="tab" id={`ic-tab-${tb.key}`} aria-selected={sel} aria-controls="ic-panel"
              onClick={() => setParam("tab", tb.key)}
              className={`card relative overflow-hidden !p-3.5 text-left ${sel ? tone.ring : "hover:border-slate-300 dark:hover:border-navy-600"}`}>
              {sel && <span className={`absolute inset-x-0 top-0 h-[3px] ${tone.rail}`} aria-hidden="true" />}
              <span className="flex items-center gap-2">
                <span className={`flex h-7 w-7 items-center justify-center rounded-lg ${tone.chip}`}>
                  <tb.icon size={15} aria-hidden="true" />
                </span>
                <span className="kpi-label">{tb.label}</span>
              </span>
              {loading ? (
                <><span className="skeleton mt-3 block h-6 w-14" /><span className="skeleton mt-2 block h-3 w-28" /></>
              ) : (
                <>
                  <span className={`mt-2 block text-2xl font-bold leading-tight tabular ${tone.count}`}>{num(t?.[tb.key])}</span>
                  <span className="mt-0.5 block truncate text-[11px] text-slate-400">{sub[tb.key]}</span>
                </>
              )}
            </button>
          );
        })}
      </div>

      <div id="ic-panel" role="tabpanel" aria-labelledby={`ic-tab-${tab}`} className="space-y-4">
        {tab === "critical" && (
          <div className="card">
            <CardHead icon={Siren} tone="red" title="Critical parts"
              hint={d?.rules.critical || "Zero stock, below minimum, or low on estimated cover"} />
            {t && (
              <div className="mb-3 flex flex-wrap gap-2">
                <FilterChip on={!reason} onClick={() => setReason("")}>
                  All <span className="ml-1 opacity-70">{num(t.critical)}</span>
                </FilterChip>
                {REASONS.map((x) => (
                  <FilterChip key={x} on={reason === x} onClick={() => setReason(reason === x ? "" : x)}>
                    {x} <span className="ml-1 opacity-70">{num(t[REASON_COUNT[x]])}</span>
                  </FilterChip>
                ))}
              </div>
            )}
            {d && (
              <div className="mb-3">
                <Note>
                  Low cover. {d.cover.basis} Only parts with an issue recorded in the app can be flagged.
                </Note>
              </div>
            )}
            <Table key={tab} {...tableProps(criticalRows)} columns={CRITICAL_COLS}
              emptyMessage={empty(reason ? `No critical part for "${reason}"` : "No counted part is at zero stock, below its minimum, or low on estimated cover")} />
          </div>
        )}

        {tab === "short" && (
          <div className="card">
            <CardHead icon={TrendingDown} tone="amber" title="Short: below the planned minimum"
              hint={d?.rules.short || "In stock below the planned minimum"} />
            <div className="mb-3">
              <Note>Recommended action orders up to max, or up to min where no max is set. Lead time and safety stock are not tracked.</Note>
            </div>
            <Table key={tab} {...tableProps(d?.short ?? NO_ROWS)} columns={SHORT_COLS}
              emptyMessage={empty("No counted part is below its planned minimum")} />
          </div>
        )}

        {tab === "reorder" && (
          <>
            {d && (
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
                <Headline icon={IndianRupee} label="Total order value" value={t.restock_value}>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    To bring {num(toOrder)} part{toOrder === 1 ? "" : "s"} up
                    to max (or min where no max is set), at each part's master rate
                  </p>
                  {t.restock_unrated > 0 && (
                    <p className="text-[11px] text-amber-700 dark:text-amber-400">
                      {t.restock_value == null
                        ? `None of ${toOrder === 1 ? "this part" : `these ${num(toOrder)} parts`} has a rate, so the order value is unknown`
                        : `${num(t.restock_unrated)} part${t.restock_unrated === 1 ? " has" : "s have"} no rate and ${t.restock_unrated === 1 ? "is" : "are"} not in this total`}
                    </p>
                  )}
                </Headline>
                <div className="card">
                  <CardHead icon={ShoppingCart} tone="amber" title="How the order quantity is worked out" />
                  <div className="space-y-1.5">
                    <p className="text-sm text-slate-700 dark:text-slate-200">{d.rules.reorder}</p>
                    <Note>Listed: every counted part at or below its reorder level, below minimum, or at zero stock.</Note>
                    {/* Each no-quantity case named for what is actually missing. */}
                    {t.reorder_no_levels > 0 && (
                      <Note>
                        {num(t.reorder_no_levels)} part{t.reorder_no_levels === 1 ? " has" : "s have"} neither a min nor a max,
                        so no order quantity can be worked out. Set the levels in Part Master.
                      </Note>
                    )}
                    {t.reorder_no_max > 0 && (
                      <Note>
                        {num(t.reorder_no_max)} part{t.reorder_no_max === 1 ? " has" : "s have"} a min but no max and{" "}
                        {t.reorder_no_max === 1 ? "is" : "are"} already at or above the min: set a max to size the order.
                      </Note>
                    )}
                    {t.reorder_at_max > 0 && (
                      <Note>
                        {num(t.reorder_at_max)} part{t.reorder_at_max === 1 ? " is" : "s are"} at or below the reorder level
                        but already at or above max (the reorder level is set at or above the max), so no order is needed by
                        the levels. Check the levels in Part Master.
                      </Note>
                    )}
                  </div>
                </div>
              </div>
            )}
            <div className="card">
              <CardHead icon={ShoppingCart} tone="amber" title="Reorder list" hint="Worst status first, then the largest order value" />
              <Table key={tab} {...tableProps(d?.reorder ?? NO_ROWS)} columns={REORDER_COLS}
                emptyMessage={empty("No counted part is at or below its reorder level")} />
            </div>
          </>
        )}

        {tab === "excess" && (
          <>
            {d && (
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
                <Headline icon={IndianRupee} label="Total excess value" value={t.excess_value}>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Working capital held above the planned maximum across {num(t.excess)} part{t.excess === 1 ? "" : "s"},
                    at each part's master rate
                  </p>
                  {t.excess_unrated > 0 && (
                    <p className="text-[11px] text-amber-700 dark:text-amber-400">
                      {t.excess_value == null
                        ? `None of ${t.excess === 1 ? "this part" : `these ${num(t.excess)} parts`} has a rate, so the value held above max is unknown`
                        : `${num(t.excess_unrated)} excess part${t.excess_unrated === 1 ? " has" : "s have"} no rate and ${t.excess_unrated === 1 ? "is" : "are"} not in this total`}
                    </p>
                  )}
                </Headline>
                <div className="card">
                  <CardHead icon={Hourglass} tone="blue" title="How long above max"
                    hint="Bar width = number of parts · click a bucket to filter the list" />
                  <AgingBar buckets={d.aging.buckets} active={age} ledgerSince={ledgerSince}
                    onPick={(k) => setAge((cur) => (cur === k ? "" : k))} />
                  <div className="mt-3 space-y-1">
                    {d.aging.notes.map((n) => <Note key={n}>{n}</Note>)}
                  </div>
                </div>
              </div>
            )}
            <div className="card">
              <CardHead icon={Boxes} tone="blue" title="Excess parts"
                hint={d?.rules.excess || "In stock above the planned maximum"}
                action={age ? (
                  <button type="button" onClick={() => setAge("")}
                    className="inline-flex items-center gap-1 rounded-full border border-toyotared px-2.5 py-1 text-[11px] font-medium text-toyotared">
                    {d?.aging.buckets.find((b) => b.key === age)?.label || age} <X size={12} aria-label="Clear the aging filter" />
                  </button>
                ) : null} />
              <Table key={tab} {...tableProps(excessRows)} columns={EXCESS_COLS}
                emptyMessage={empty(age ? "No excess part in this aging bucket" : "No counted part is above its planned maximum")} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
