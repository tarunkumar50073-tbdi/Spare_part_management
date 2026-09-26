import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { NO_ROWS, stockKeys, useStockList, useStockOverview } from "../lib/stockQueries.js";
import { AttentionBoard, ErpStatusStrip, HealthBar, ValuePanel } from "../components/spare/OverviewPanels.jsx";
import { usePartDrawer } from "../context/PartDrawerContext.jsx";
import { compactMoney, fmtDate, fmtStamp, money, num, parseServerTime } from "../lib/format.js";
import {
  ArrowDownToLine, ArrowLeft, ArrowUpFromLine, Bolt, CalendarDays, ChartColumn, CircleCheck,
  ClipboardList, Download, Factory, Gem, IndianRupee, MapPin, Package, Pencil, Repeat2,
  Settings, TrendingUp, TriangleAlert, Truck, Wrench, X,
} from "lucide-react";
import Glyph, { sectionIcon } from "../components/Glyph.jsx";
import Badge from "../components/Badge.jsx";
import CardHead from "../components/CardHead.jsx";
import DonutChart from "../components/DonutChart.jsx";
import HorizontalBars from "../components/HorizontalBars.jsx";
import KpiCard from "../components/KpiCard.jsx";
import Modal from "../components/Modal.jsx";
import NotCaptured from "../components/NotCaptured.jsx";
import { downloadFile } from "../utils/download.js";
import { downloadXlsx } from "../utils/excel.js";
import RadialGauge from "../components/RadialGauge.jsx";
import Table from "../components/Table.jsx";
import { BarChart, Bar, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer } from "recharts";
import { storeService } from "../services/storeService.js";
import { partService } from "../services/partService.js";
import { spareStockService } from "../services/spareStockService.js";
import { spareFlowService } from "../services/spareFlowService.js";
import { erpLineMeta } from "../lib/scanStatus.js";
import { erpFreshness } from "../services/erpGrnService.js";

const STORE_CODE = "MAINTENANCE";


// The whole store in one list, so every figure on this page is counted from
// the same rows the table shows. The server now caps per_page at 5000, so the
// ~4.8k-part store comes back in ONE request; the paging loop below stays as a
// fallback if the list ever grows past a page.
const PER_PAGE = 5000;

async function fetchAllParts(params) {
  const first = await partService.list({ ...params, page: 1, per_page: PER_PAGE });
  const totalPages = first.data.meta.total_pages;
  if (totalPages <= 1) return first.data.data;

  const rest = await Promise.all(
    Array.from({ length: totalPages - 1 }, (_, i) =>
      partService.list({ ...params, page: i + 2, per_page: PER_PAGE })
    )
  );
  return rest.reduce((all, res) => all.concat(res.data.data), first.data.data);
}

// "R3-S1-B2(1)" -> "R3". The sheets encode rack/shelf/bin in one string, and
// the rack is the part anyone standing on the floor actually navigates by.
const rackOf = (location) => (location || "").split("-")[0].trim() || null;

// Value bands, in the order they should read. A spares list is not worth
// planning uniformly: a ₹1.8 lakh die and a ₹15 grinding wheel need different
// attention, and the band split is the fastest way to show that.
const VALUE_BANDS = [
  { label: "Under ₹1k", test: (v) => v < 1000, color: "#94a3b8" },
  { label: "₹1k – ₹10k", test: (v) => v < 10000, color: "#3b82f6" },
  { label: "₹10k – ₹50k", test: (v) => v < 50000, color: "#f59e0b" },
  { label: "₹50k and above", test: () => true, color: "#f43f5e" },
];

function useStoreStats(parts) {
  return useMemo(() => {
    const planned = parts.filter((p) => Number(p.max_stock_level || 0) > 0);
    const rated = parts.filter((p) => Number(p.unit_price || 0) > 0);
    const rework = parts.filter((p) => p.rework_location);

    const byRack = {};
    parts.forEach((p) => {
      const rack = rackOf(p.location);
      if (rack) byRack[rack] = (byRack[rack] || 0) + 1;
    });

    const bands = VALUE_BANDS.map((b) => ({ name: b.label, value: 0, color: b.color }));
    rated.forEach((p) => {
      const v = Number(p.unit_price);
      bands[VALUE_BANDS.findIndex((b) => b.test(v))].value += 1;
    });

    return {
      total: parts.length,
      planned: planned.length,
      unplanned: parts.length - planned.length,
      rated: rated.length,
      unrated: parts.length - rated.length,
      rework: rework.length,
      // Two different questions: how many distinct shelves the list occupies,
      // and how many parts have been given one at all.
      locations: new Set(parts.map((p) => p.location).filter(Boolean)).size,
      locationSet: parts.filter((p) => p.location).length,
      racks: Object.entries(byRack)
        .map(([name, value]) => ({ name, value }))
        .sort((a, b) => b.value - a.value),
      bands,
    };
  }, [parts]);
}

// Rack colours, assigned by size order rather than fixed per rack name — the
// racks in a spares store are whatever the sheet happens to use (R3, R4, R12
// today), so a hardcoded map would leave a new rack uncoloured.
const RACK_PALETTE = ["#3b82f6", "#10b981", "#f59e0b", "#8b5cf6", "#f43f5e", "#06b6d4"];
const RACK_COLORS = (racks) =>
  Object.fromEntries(racks.map((r, i) => [r.name, RACK_PALETTE[i % RACK_PALETTE.length]]));

// Planning coverage as a bar, not just a percentage: a section that is 20%
// planned and one that is 90% should be tellable apart without reading.
function CoverageBar({ done, total }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  const tone = pct >= 75 ? "bg-emerald-500" : pct >= 40 ? "bg-amber-500" : "bg-rose-500";
  return (
    <div className="flex items-center gap-2 min-w-[8rem]">
      <div className="flex-1 h-1.5 rounded-full bg-slate-100 dark:bg-navy-800 overflow-hidden">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[11px] font-semibold tabular text-slate-600 dark:text-slate-300 w-9 text-right">{pct}%</span>
    </div>
  );
}

const SECTION_COLUMNS = [
  {
    key: "name", label: "Section", sortable: true,
    render: (r) => (
      <span className="flex items-center gap-2 font-medium text-slate-800 dark:text-white">
        <Glyph icon={sectionIcon(r.name)} size={16} className="text-slate-500 dark:text-slate-400 shrink-0" />
        {r.name}
      </span>
    ),
  },
  {
    key: "total_parts", label: "Parts", sortable: true, align: "right",
    render: (r) => <span className="font-semibold tabular">{num(r.total_parts)}</span>,
  },
  {
    key: "planned", label: "Min/Max Planned",
    sortable: true,
    sortValue: (r) => (r.total_parts ? r.with_min_max / r.total_parts : 0),
    exportValue: (r) => `${r.with_min_max} of ${r.total_parts}`,
    render: (r) => <CoverageBar done={r.with_min_max} total={r.total_parts} />,
  },
  {
    key: "with_rework", label: "Rework", sortable: true, align: "right",
    render: (r) => (r.with_rework
      ? <span className="tabular text-amber-700 dark:text-amber-400">{num(r.with_rework)}</span>
      : <span className="text-slate-300 dark:text-slate-600">—</span>),
  },
  {
    key: "locations", label: "Locations", sortable: true, align: "right",
    render: (r) => <span className="tabular">{num(r.locations)}</span>,
  },
];

// The dashboard's data, both from the shared stock cache (lib/stockQueries):
//  - `overview`: ONE server call with everything above the fold — KPIs, the
//    attention list (what / how serious / where / how much / what to do),
//    health by status, value by section and type, ERP state, data quality,
//    consumption splits and recent activity (backend SpareDashboardService);
//  - `stockRows`: the store's (or section's) full list — the same cached copy
//    Store Stock, Part Ledger and Ctrl+K read — for the drill lists and the
//    cards that chart individual parts. It loads alongside, so the top of the
//    page paints from the overview without waiting for 4,800 rows.
// A server "stock" push invalidates both, so the page stays live.
function useSpareDashboardData(sectionId, enabled = true) {
  const sid = sectionId ?? null;
  const ov = useStockOverview(STORE_CODE, sid, { enabled });
  const list = useStockList(STORE_CODE, sid, { enabled });
  return { overview: ov.data ?? null, stockRows: list.data ?? NO_ROWS };
}

// Needs Reordering: the worst 50 — empty, then below minimum, then at the
// reorder level; within each, furthest short of the level that flags it (the
// same order the backend's below-minimum feed used).
const REORDER_ORDER = { "Out of Stock": 0, "Below Minimum": 1, "Reorder": 2 };
function deriveBelowMin(rows, limit = 50) {
  const gap = (r) => {
    const level = r.status !== "Reorder" ? r.min_stock_level : (r.reorder_level || 0);
    return -(level - (r.qty_on_hand || 0));
  };
  return rows
    .filter((r) => r.status in REORDER_ORDER)
    .sort((a, b) => REORDER_ORDER[a.status] - REORDER_ORDER[b.status] || gap(a) - gap(b))
    .slice(0, limit);
}

const STOCK_STATUS_TONE = {
  "Out of Stock": "bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300",
  "Below Minimum": "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300",
  "Reorder": "bg-orange-100 text-orange-700 dark:bg-orange-500/20 dark:text-orange-300",
  "Above Maximum": "bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300",
  "Healthy": "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300",
  "Not Counted": "bg-slate-100 text-slate-500 dark:bg-navy-800 dark:text-slate-400",
};

function StockStatus({ status }) {
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap
      ${STOCK_STATUS_TONE[status] || STOCK_STATUS_TONE["Not Counted"]}`}>
      {status}
    </span>
  );
}

const BELOW_MIN_COLUMNS = [
  { key: "part_no", label: "Part No", sortable: true },
  { key: "part_name", label: "Description", sortable: true },
  { key: "location", label: "Location", render: (r) => r.location || "—" },
  { key: "qty_on_hand", label: "In Stock", sortable: true, align: "right", render: (r) => num(r.qty_on_hand) },
  { key: "min_stock_level", label: "Min", sortable: true, align: "right", render: (r) => num(r.min_stock_level) },
  { key: "max_stock_level", label: "Max", align: "right", render: (r) => (r.max_stock_level == null ? "—" : num(r.max_stock_level)) },
  {
    // What it would take to get back to the maximum — the reorder quantity,
    // ready for the day someone raises one.
    key: "shortfall", label: "To Max", sortable: true, align: "right",
    render: (r) => (r.shortfall == null ? "—" : <span className="font-semibold">{num(r.shortfall)}</span>),
  },
  { key: "status", label: "Status", render: (r) => <StockStatus status={r.status} /> },
];

// One glyph per flow stage, in the order the service returns them.

// This calendar month's issued quantity with month-over-month and year-over-year
// deltas. Direction is shown but left colour-neutral in tone — more or less
// consumption is not inherently good or bad — with a "—" where a baseline of
// zero makes a percentage meaningless (no invented number).
function ConsumptionCompare({ c }) {
  const cur = c.current?.value || 0;
  const Chip = ({ label, pct }) => (
    <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500 dark:bg-navy-800 dark:text-slate-400">
      {label}
      {pct == null ? (
        <span className="text-slate-400">—</span>
      ) : (
        <span className={pct > 0 ? "text-amber-600 dark:text-amber-400" : pct < 0 ? "text-emerald-600 dark:text-emerald-400" : ""}>
          {pct > 0 ? "▲" : pct < 0 ? "▼" : ""}{Math.abs(pct)}%
        </span>
      )}
    </span>
  );
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
      <span className="font-semibold text-slate-700 dark:text-slate-200">This month: {num(cur)} issued</span>
      <Chip label="vs last month" pct={c.previous?.change_pct} />
      <Chip label="vs last year" pct={c.year_ago?.change_pct} />
    </div>
  );
}

// Where the current figure sits between Min and Max. The track runs to the
// maximum (or to the current figure when it is over), so a bar that overshoots
// its marker is over-stocked and one that stops short of it is under — legible
// without reading the three numbers beside it.
function MinMaxBar({ row }) {
  const qty = Number(row.qty_on_hand || 0);
  const min = Number(row.min_stock_level || 0);
  const max = row.max_stock_level == null ? null : Number(row.max_stock_level);
  const scale = Math.max(max || 0, qty, min, 1);
  const pct = (v) => `${Math.min((v / scale) * 100, 100)}%`;
  const fill = {
    "Out of Stock": "bg-rose-500",
    "Below Minimum": "bg-amber-500",
    "Reorder": "bg-orange-500",
    "Above Maximum": "bg-blue-500",
  }[row.status] || "bg-emerald-500";

  return (
    <div className="relative h-2 rounded-full bg-slate-100 dark:bg-navy-800 overflow-hidden">
      <div className={`h-full rounded-full ${fill}`} style={{ width: pct(qty) }} />
      {/* Min and Max as ticks on the same track — limits, not quantities. */}
      {min > 0 && (
        <span className="absolute inset-y-0 w-px bg-slate-400/70 dark:bg-slate-500"
          style={{ left: pct(min) }} title={`Min ${min}`} />
      )}
      {max != null && max > 0 && (
        <span className="absolute inset-y-0 w-px bg-slate-600 dark:bg-slate-300"
          style={{ left: pct(max) }} title={`Max ${max}`} />
      )}
    </div>
  );
}

const EXCESS_COLUMNS = [
  { key: "part_no", label: "Part No", sortable: true },
  { key: "part_name", label: "Description", sortable: true },
  { key: "location", label: "Location", render: (r) => r.location || "—" },
  { key: "qty_on_hand", label: "In Stock", sortable: true, align: "right", render: (r) => num(r.qty_on_hand) },
  { key: "max_stock_level", label: "Maximum", align: "right", render: (r) => num(r.max_stock_level) },
  {
    key: "excess_qty", label: "Excess", sortable: true, align: "right",
    render: (r) => <span className="font-semibold text-blue-700 dark:text-blue-300">+{num(r.excess_qty)}</span>,
  },
  {
    key: "stock_value", label: "Value Tied Up", sortable: true, align: "right",
    render: (r) => (r.unit_price == null ? "—" : money(r.excess_qty * r.unit_price)),
  },
];

// A ledger type, said the way the store says it. A RECEIPT row is a stock-in:
// receiving itself happens in ERP, and the row is written when the qty quality
// accepted there is added to store stock (By "ERP-GRN" when the sync did it).
const TXN_LABEL = {
  OPENING: { label: "Opening Count", icon: ClipboardList, tone: "bg-slate-100 text-slate-600 dark:bg-navy-800 dark:text-slate-300" },
  RECEIPT: { label: "Added to Stock", icon: ArrowDownToLine, tone: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300" },
  ISSUE: { label: "Part Issued", icon: ArrowUpFromLine, tone: "bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300" },
  ADJUSTMENT: { label: "Stock Corrected", icon: Pencil, tone: "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300" },
};

const ACTIVITY_COLUMNS = [
  {
    key: "at", label: "Time", sortable: true,
    render: (r) => <span className="tabular">{fmtStamp(r.at)}</span>,
    // `at` is naive UTC from the server; export the local (IST) time, with the year.
    exportValue: (r) => parseServerTime(r.at)?.toLocaleString("en-GB", {
      day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
    }) || "",
  },
  {
    key: "txn_type", label: "Activity",
    render: (r) => {
      const t = TXN_LABEL[r.txn_type] || { label: r.txn_type, icon: null, tone: "bg-slate-100 text-slate-600" };
      return (
        <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap ${t.tone}`}>
          <Glyph icon={t.icon} size={12} />{t.label}
        </span>
      );
    },
  },
  { key: "part_no", label: "Part No", sortable: true },
  { key: "part_name", label: "Description" },
  {
    key: "qty_delta", label: "Qty", align: "right",
    render: (r) => (
      <span className={`font-semibold ${r.qty_delta < 0
        ? "text-rose-600 dark:text-rose-400" : "text-emerald-600 dark:text-emerald-400"}`}>
        {r.qty_delta > 0 ? "+" : ""}{num(r.qty_delta)}
      </span>
    ),
  },
  { key: "balance_after", label: "Balance", align: "right", render: (r) => num(r.balance_after) },
  { key: "created_by", label: "By", render: (r) => r.created_by || "—" },
  { key: "reference", label: "Reference", render: (r) => r.reference || r.remarks || "—" },
];

const PENDING_COLUMNS = [
  { key: "srv_no", label: "SRV No", sortable: true, render: (r) => r.srv_no || "—" },
  { key: "part_no", label: "Part No", sortable: true },
  { key: "part_name", label: "Description" },
  { key: "supplier_name", label: "Supplier", render: (r) => r.supplier_name || "—" },
  { key: "invoice_no", label: "Invoice", render: (r) => r.invoice_no || "—" },
  { key: "qty_received", label: "Qty", align: "right", render: (r) => num(r.qty_received ?? r.qty_invoiced) },
  { key: "status", label: "Stage", render: (r) => <Badge status={r.status} /> },
];

// GRN / Quality pending (ERP) — the ERP GRN lines of the store's parts still
// waiting for ERP's quality clearance, or to be checked (the work queue's
// quality list; spec 1/9: receiving, GRN and quality are done in ERP and read
// here). PENDING_COLUMNS stays for an older overview.
const ERP_LINE_PENDING_COLUMNS = [
  {
    key: "grn_no", label: "GRN No", sortable: true,
    exportValue: (r) => `${r.grn_no || ""}${r.grn_date ? ` (${r.grn_date})` : ""}`,
    render: (r) => (
      <div>
        <div className="font-mono text-[12px] font-semibold">{r.grn_no || "—"}</div>
        <div className="text-[11px] text-slate-400">{r.grn_date ? fmtDate(r.grn_date) : "no GRN date in ERP"}</div>
      </div>
    ),
  },
  { key: "part_no", label: "Part No", sortable: true },
  { key: "part_name", label: "Description" },
  { key: "ven_name", label: "Supplier", render: (r) => r.ven_name || r.ven_cd || "—" },
  { key: "invoice_no", label: "Invoice", render: (r) => r.invoice_no || "—" },
  { key: "receipt_qty", label: "Received", align: "right", render: (r) => num(r.receipt_qty) },
  {
    key: "state", label: "State (ERP)", exportValue: (r) => erpLineMeta(r.state).label,
    render: (r) => <span className={`badge whitespace-nowrap ${erpLineMeta(r.state).badge}`}>{erpLineMeta(r.state).label}</span>,
  },
  {
    key: "reason", label: "Reason",
    render: (r) => <span className="block max-w-[280px] text-[12px] leading-snug text-slate-500 dark:text-slate-400">{r.reason || "—"}</span>,
  },
];
const erpLineKey = (r) => `${r.part_id}|${r.grn_no}`;

// Value asked the question, so value is what this list is ordered and shown
// by — rate and stock value rather than Min/Max.
const STOCK_VALUE_COLUMNS = [
  { key: "part_no", label: "Part No", sortable: true },
  { key: "part_name", label: "Description", sortable: true },
  { key: "location", label: "Location", render: (r) => r.location || "—" },
  { key: "qty_on_hand", label: "In Stock", sortable: true, align: "right", render: (r) => num(r.qty_on_hand) },
  { key: "unit_price", label: "Rate", sortable: true, align: "right", render: (r) => money(r.unit_price) },
  {
    key: "stock_value", label: "Stock Value", sortable: true, align: "right",
    render: (r) => <span className="font-semibold">{money(r.stock_value)}</span>,
  },
];

// Today's movements, as the two "today" tiles open them — the ledger rows since
// the shift started, newest first. Times are server stamps (UTC) → fmtStamp.
const whenCol = {
  key: "at", label: "Time", sortable: true, sortValue: (r) => r.at || "",
  render: (r) => <span className="whitespace-nowrap tabular">{fmtStamp(r.at)}</span>, exportValue: (r) => fmtStamp(r.at),
};
const partCol = {
  key: "part_no", label: "Part", sortable: true, searchValue: (r) => `${r.part_no || ""} ${r.part_name || ""}`,
  render: (r) => (
    <div className="min-w-0">
      <div className="font-mono text-[13px] font-medium text-slate-800 dark:text-white">{r.part_no || "—"}</div>
      <div className="max-w-[260px] truncate text-[11px] text-slate-400">{r.part_name}</div>
    </div>
  ),
};
const TODAY_IN_COLUMNS = [
  whenCol, partCol,
  { key: "qty_delta", label: "Added", sortable: true, align: "right",
    render: (r) => <span className="font-semibold text-emerald-600">+{num(r.qty_delta)} {r.uom || ""}</span> },
  { key: "reference", label: "GRN / RGP no.", sortable: true, render: (r) => r.reference || "—" },
  { key: "source", label: "From", sortable: true, render: (r) => r.source || "—" },
  { key: "supplier", label: "Supplier", sortable: true, render: (r) => r.supplier || "—" },
  { key: "balance_after", label: "In stock after", align: "right", render: (r) => num(r.balance_after) },
];
const TODAY_OUT_COLUMNS = [
  whenCol, partCol,
  { key: "qty_delta", label: "Issued", sortable: true, align: "right",
    render: (r) => <span className="font-semibold text-rose-600">{num(Math.abs(r.qty_delta))} {r.uom || ""}</span>,
    exportValue: (r) => Math.abs(r.qty_delta) },
  { key: "department", label: "Department", sortable: true, render: (r) => r.department || "—" },
  { key: "issued_to", label: "Issued to", sortable: true,
    render: (r) => (r.issued_to ? `${r.issued_to}${r.issued_to_code ? ` (${r.issued_to_code})` : ""}` : "—") },
  { key: "machine", label: "Machine", render: (r) => r.machine || "—" },
  { key: "created_by", label: "By", render: (r) => r.created_by || "—" },
];

// Every headline figure opens the list behind it. A KPI you cannot open is a
// number the floor has to take on trust — and the first question anyone asks
// about "3 below minimum" is which three.
const DRILL_STATUS_COLORS = {
  "Out of Stock": "#e11d48", "Zero Stock": "#e11d48", "Below Minimum": "#fb7185",
  "Reorder": "#f97316", "Above Maximum": "#f59e0b", "Healthy": "#10b981",
  "Not Counted": "#94a3b8",
};
const REORDER_BAR_COLORS = ["#eb0a1e", "#f97316", "#f59e0b", "#c026d3", "#7c3aed", "#0ea5e9"];

// Hover card for the value bars — part no, description and the exact rupee.
function ValueTip({ active, payload }) {
  if (!active || !payload || !payload.length) return null;
  const p = payload[0].payload;
  return (
    <div className="rounded-lg bg-navy-900 text-white px-3 py-2 shadow-xl max-w-[240px] border border-white/10">
      <p className="font-bold text-sm leading-tight">{p.part_no}</p>
      {p.part_name && <p className="text-[11px] text-slate-300 leading-snug mt-0.5">{p.part_name}</p>}
      <p className="text-blue-300 font-bold text-sm mt-1">{money(p.value)}</p>
    </div>
  );
}

// The "Top 10 by Value" graphic, rebuilt from the Live Dashboard against this
// page's light/dark theme: a ranked column chart of stock value with a hover
// card and the combined total beneath it. Tapping a bar opens that part.
function TopValueChart({ data, onBarClick }) {
  if (!data.length) {
    return <p className="text-sm text-slate-400 text-center py-12">No counted stock value yet</p>;
  }
  const total = data.reduce((s, d) => s + (Number(d.value) || 0), 0);
  return (
    <div className="flex flex-col">
      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 8, left: 4, bottom: 36 }}>
            <defs>
              <linearGradient id="hv-blue" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#60a5fa" />
                <stop offset="1" stopColor="#2563eb" />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(148,163,184,0.25)" />
            <XAxis dataKey="part_no" interval={0} angle={-32} textAnchor="end" height={48}
              tick={{ fontSize: 10, fill: "#94a3b8" }} />
            <YAxis tickFormatter={compactMoney} width={62} tick={{ fontSize: 11, fill: "#94a3b8" }} />
            <RechartsTooltip content={<ValueTip />} cursor={{ fill: "rgba(148,163,184,0.12)" }} />
            <Bar dataKey="value" fill="url(#hv-blue)" radius={[5, 5, 0, 0]} maxBarSize={34}
              cursor="pointer" isAnimationActive={false}
              onClick={(entry) => entry && onBarClick && onBarClick(entry)} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-1 flex items-center justify-between border-t border-slate-200 dark:border-navy-800 pt-2.5 px-1">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Top {data.length} total</span>
        <span className="text-lg font-extrabold text-slate-800 dark:text-white tabular">{money(total)}</span>
      </div>
    </div>
  );
}

// A full-screen drill in the Live Dashboard's style: a premium header, a status
// ring at a glance (when the list carries one), and the whole searchable list —
// a row opens that part. Replaces the old centred dialog.
function DrillDown({ drill, onClose }) {
  if (!drill) return null;
  const rows = drill.rows || [];
  const hasStatus = rows.some((r) => r.status);
  const statusData = hasStatus
    ? Object.entries(rows.reduce((acc, r) => { const s = r.status || "—"; acc[s] = (acc[s] || 0) + 1; return acc; }, {}))
        .map(([name, value]) => ({ name, value }))
        .sort((a, b) => b.value - a.value)
    : [];
  const statusColors = Object.fromEntries(statusData.map((d) => [d.name, DRILL_STATUS_COLORS[d.name] || "#8b5cf6"]));
  // Top 10 by the money on the shelf — only when the drill asks for it (the
  // Stock Value tile), computed from the very rows the list shows.
  const topValueRows = drill.valueChart
    ? rows.filter((r) => Number(r.stock_value) > 0)
        .slice()
        .sort((a, b) => Number(b.stock_value) - Number(a.stock_value))
        .slice(0, 10)
        .map((r) => ({ ...r, value: Number(r.stock_value) }))
    : [];
  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col gap-4 p-4 lg:p-6 overflow-auto bg-slate-50 dark:bg-navy-950 animate-[fadeIn_0.15s_ease-out]">
      <div className="shrink-0 rounded-2xl px-5 py-3.5 flex items-center gap-4 text-white shadow-[0_12px_34px_rgba(10,32,70,0.35)]"
        style={{ background: "linear-gradient(120deg,#0a2340 0%,#123a6b 55%,#0a2038 100%)" }}>
        <button onClick={onClose} title="Back"
          className="w-10 h-10 rounded-lg bg-white/10 hover:bg-white/20 flex items-center justify-center shrink-0">
          <ArrowLeft size={20} />
        </button>
        <div className="min-w-0 flex-1">
          <h2 className="text-xl lg:text-2xl font-extrabold truncate"
            style={{ backgroundImage: "linear-gradient(92deg,#ff9a4d,#ff5a6a,#ffd9b0)", WebkitBackgroundClip: "text", backgroundClip: "text", WebkitTextFillColor: "transparent", color: "transparent" }}>
            {drill.title}
          </h2>
          <p className="text-xs text-white/70 truncate">
            {drill.subtitle ? `${drill.subtitle} · ` : ""}{num(rows.length)} row{rows.length === 1 ? "" : "s"}
          </p>
        </div>
        <button onClick={onClose} title="Close"
          className="w-10 h-10 rounded-lg bg-white/10 hover:bg-white/20 flex items-center justify-center shrink-0"><X size={20} aria-hidden="true" /></button>
      </div>

      {topValueRows.length > 0 && (
        <div className="card shrink-0">
          <CardHead icon={Gem} tone="blue" title="Top 10 by value"
            hint="Highest stock value on the shelf — tap a bar to open the part" />
          <TopValueChart
            data={topValueRows}
            onBarClick={(entry) => { onClose(); if (drill.onRowClick) drill.onRowClick(entry); }}
          />
        </div>
      )}

      <div className={`flex-1 min-h-0 grid grid-cols-1 gap-4 ${hasStatus ? "xl:grid-cols-[minmax(0,340px)_minmax(0,1fr)]" : ""}`}>
        {hasStatus && (
          <div className="card h-fit">
            <CardHead icon={ChartColumn} tone="violet" title="By status" hint="How this list splits up" />
            <DonutChart data={statusData} colors={statusColors} size={132}
              centerValue={num(rows.length)} centerLabel="parts" emptyMessage="—" />
          </div>
        )}
        <div className="card min-w-0">
          <Table
            columns={drill.columns}
            rows={rows}
            // Opening a part closes this drill rather than stacking a dialog over it.
            onRowClick={drill.onRowClick && ((row) => { onClose(); drill.onRowClick(row); })}
            searchable={rows.length > 10 ? "Search this list…" : false}
            pageSize={0}
            maxHeight="68vh"
            // A drill can be the whole store (4.8k rows) — window the long ones
            // so opening it doesn't mount every row at once.
            virtualize={rows.length > 300}
            exportName={drill.exportName}
            emptyMessage="Nothing in this list — the figure is zero"
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}

// Donut palette for the consumption breakdowns — assigned by rank so the biggest
// slice is always the same lead colour across dept / machine / type.
const CONS_DONUT = ["#8b5cf6", "#0f8d7e", "#d0902a", "#2563eb", "#eb0a1e", "#c026d3", "#0891b2", "#65a30d"];
const consColors = (rows) => Object.fromEntries(rows.map((r, i) => [r.name, CONS_DONUT[i % CONS_DONUT.length]]));

// Hover card for the trend area.
function TrendTip({ active, payload, label }) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div className="rounded-lg bg-navy-900 text-white px-2.5 py-1.5 shadow-lg text-xs">
      <p className="font-semibold">{label}</p>
      <p className="text-indigo-300 font-semibold">{payload[0].value} issued</p>
    </div>
  );
}

// Daily issued quantity as a soft gradient area — the shape of usage over the
// chosen window.
function TrendArea({ data }) {
  if (!data.length || data.every((d) => !d.qty)) {
    return <p className="text-sm text-slate-400 text-center py-14">Nothing issued in this range</p>;
  }
  return (
    <div className="h-56">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
          <defs>
            <linearGradient id="cons-trend" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#6366f1" stopOpacity={0.35} />
              <stop offset="1" stopColor="#6366f1" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(148,163,184,0.2)" />
          <XAxis dataKey="d" tick={{ fontSize: 10, fill: "#94a3b8" }} interval="preserveStartEnd" minTickGap={24} />
          <YAxis tick={{ fontSize: 10, fill: "#94a3b8" }} width={30} allowDecimals={false} />
          <RechartsTooltip content={<TrendTip />} cursor={{ stroke: "rgba(148,163,184,0.4)" }} />
          <Area type="monotone" dataKey="qty" stroke="#6366f1" strokeWidth={2} fill="url(#cons-trend)" isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// On-hand value by each part's LAST gate-entry supplier. A spare arrives from
// several vendors over time (the supplier is read live from the gate entries,
// never stored on the part), so this credits what is on the shelf to whoever
// brought it most recently — and says so, rather than passing an approximation
// off as a per-supplier ledger. Opening stock that never came through the gate
// is kept out of the ranking (it would swamp every bar) and shown beside it, so
// the bars and the total still reconcile. A bar opens exactly its parts.
function SupplierValueCard({ sectionId, stockRows, onDrill, onStockClick }) {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: stockKeys.valueBySupplier(STORE_CODE, sectionId),
    queryFn: () => spareStockService.valueBySupplier(STORE_CODE, sectionId).then((r) => r.data.data),
    staleTime: 60_000,
  });

  const drillOf = (title, subtitle, ids, exportName) => {
    const want = new Set(ids);
    onDrill({
      title, subtitle, exportName, columns: STOCK_VALUE_COLUMNS, onRowClick: onStockClick, valueChart: true,
      rows: stockRows.filter((r) => want.has(r.part_id))
        .sort((a, b) => (b.stock_value || 0) - (a.stock_value || 0)),
    });
  };

  const pct = (v) => (data && data.total ? Math.round((v / data.total) * 100) : 0);
  const bars = (data?.suppliers || []).map((s) => ({
    ...s,
    // Two vendor codes can share a trading name; the code keeps them apart.
    name: s.ven_cd && s.ven_cd !== s.name ? `${s.name} · ${s.ven_cd}` : s.name,
  }));
  const none = data?.unattributed;

  return (
    <div className="card">
      <CardHead icon={Truck} tone="violet" title="Stock Value by Supplier"
        hint="Credited to each part's last gate-entry supplier" />
      {isLoading ? (
        <div className="space-y-2.5 py-2">
          {Array.from({ length: 5 }).map((_, i) => <div key={i} className="skeleton h-6 w-full rounded" />)}
        </div>
      ) : isError || !data ? (
        <div className="text-sm text-slate-400 text-center py-6">
          Couldn&apos;t load supplier values.{" "}
          <button type="button" onClick={() => refetch()} className="text-toyotared font-medium hover:underline">
            Retry
          </button>
        </div>
      ) : !data.total ? (
        <NotCaptured
          what="No counted part carries a rate yet"
          needs="Stock value needs a count and a unit rate; once parts have both, their value is credited here to the supplier who last brought them."
        />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          <div className="lg:col-span-2 min-w-0">
            <HorizontalBars
              data={bars}
              color="#8b5cf6"
              valueFormat={money}
              emptyMessage="No valued part has a gate entry yet — suppliers appear here once the ERP gate feed covers them"
              onBarClick={(d) => drillOf(
                d.name,
                `${money(d.value)} on hand · the last supplier of each of these parts`,
                d.part_ids,
                `spares_value_${(d.ven_cd || d.name).replace(/[^\w-]+/g, "_").toLowerCase()}`,
              )}
            />
            {data.others.count > 0 && (
              <p className="text-xs text-slate-400 mt-3">
                + {num(data.others.count)} more supplier{data.others.count === 1 ? "" : "s"} holding{" "}
                {money(data.others.value)} across {num(data.others.parts)} parts.
              </p>
            )}
          </div>

          <div className="rounded-xl bg-slate-50 dark:bg-navy-800/60 p-4 space-y-3 min-w-0 lg:self-start">
            <div>
              <p className="text-[11px] uppercase tracking-wide text-slate-400">Total on-hand value</p>
              <p className="text-xl font-semibold tabular text-slate-800 dark:text-white" title={money(data.total)}>
                {compactMoney(data.total)}
              </p>
            </div>
            <div className="h-2 rounded-full bg-slate-200 dark:bg-navy-700 overflow-hidden flex"
              role="img" aria-label={`${pct(data.attributed)}% of the value has a known supplier`}>
              <div className="h-full bg-violet-500" style={{ width: `${pct(data.attributed)}%` }} />
            </div>
            <ul className="space-y-2 text-xs">
              <li className="flex items-baseline justify-between gap-2">
                <span className="text-slate-500 dark:text-slate-400 min-w-0">
                  <span className="inline-block w-2 h-2 rounded-full bg-violet-500 mr-1.5" />
                  {num(data.supplier_count)} supplier{data.supplier_count === 1 ? "" : "s"}
                </span>
                <span className="font-semibold tabular text-slate-800 dark:text-white shrink-0">
                  {money(data.attributed)} · {pct(data.attributed)}%
                </span>
              </li>
              <li>
                <button type="button" disabled={!none.parts}
                  onClick={() => drillOf(
                    "No gate entry",
                    `${money(none.value)} on hand · never seen at the gate — opening stock or pre-ERP arrivals`,
                    none.part_ids,
                    "spares_value_no_gate_entry",
                  )}
                  className="w-full flex items-baseline justify-between gap-2 group disabled:cursor-default">
                  <span className={`text-slate-500 dark:text-slate-400 min-w-0 text-left ${none.parts ? "group-hover:text-toyotared" : ""}`}>
                    <span className="inline-block w-2 h-2 rounded-full bg-slate-300 dark:bg-navy-600 mr-1.5" />
                    No gate entry · {num(none.parts)} part{none.parts === 1 ? "" : "s"}
                  </span>
                  <span className="font-semibold tabular text-slate-800 dark:text-white shrink-0">
                    {money(none.value)} · {pct(none.value)}%
                  </span>
                </button>
              </li>
            </ul>
            <p className="text-[11px] leading-snug text-slate-400">
              A part bought from several vendors counts under the most recent one — an
              approximation from the gate feed, not a per-supplier stock ledger.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// A stock row is not a part row — it carries part_id, and the detail modal
// needs the part itself. The parent already holds the list, so it resolves.
function SpareDashboard({ stats, onPartClick, onStockClick, overview = null,
  parts = [], stockRows = [], reorderPlanned = true, onReorderExport, sectionId }) {
  const navigate = useNavigate();
  const kpi = overview?.kpis || null;
  // Store-wide figures (consumption, receiving) are never quoted on a section page.
  const storeLevel = sectionId == null;
  const belowMin = useMemo(() => deriveBelowMin(stockRows), [stockRows]);
  const [pendingOpen, setPendingOpen] = useState(false);
  // Rows kept with the source they came from, so the columns always match them;
  // `state` keeps a load or a failure from reading as "nothing waiting".
  const [pending, setPending] = useState({ receipts: false, rows: [], state: "idle" });
  const pendingRows = pending.rows;

  // Spec 1: spare receiving has no separate SRV step, and the GRN and the
  // quality clearance are done in ERP. The overview's ERP count
  // (receiving_pending: ERP GRN lines awaiting quality in ERP) is the figure on
  // that attention line, with the ERP mirror's freshness, and its drill lists
  // those lines; an older overview without the block keeps its SRV figure.
  const receiving = overview?.receiving_pending ?? null;
  const attention = useMemo(() => (overview?.attention || []).map((it) => {
    if (it.key !== "srv_pending") return it;
    if (!receiving) return { ...it, label: "GRN / Quality pending (ERP)" };
    const count = receiving.total ?? receiving.quality_pending ?? it.count;
    const fresh = receiving.erp ? erpFreshness(receiving.erp) : null;
    const extra = [
      receiving.check ? `${num(receiving.check)} to check with ERP` : null,
      receiving.to_add ? `${num(receiving.to_add)} accepted, to be added` : null,
    ].filter(Boolean).join(" · ");
    return {
      ...it, label: "GRN / Quality pending (ERP)", count,
      hint: [
        "ERP GRN lines awaiting quality clearance in ERP",
        extra,
        fresh ? `${fresh.text}${fresh.stale && !fresh.empty ? ` (${fresh.ageDays} d old)` : ""}` : null,
      ].filter(Boolean).join(" · "),
      severity: count || receiving.check ? "warning" : "ok",
    };
  }), [overview, receiving]);

  const fromReceipts = Boolean(receiving);
  useEffect(() => {
    if (!pendingOpen) return undefined;
    let alive = true;
    setPending({ receipts: fromReceipts, rows: [], state: "loading" });
    // Silent: the modal shows its own "Couldn't load" line on a failure.
    const load = fromReceipts
      ? spareFlowService.queues(STORE_CODE, { silent: true }).then((r) => r.data.data?.quality || [])
      : spareStockService.pendingList(STORE_CODE, "all").then((r) => r.data.data || []);
    load.then((rows) => { if (alive) setPending({ receipts: fromReceipts, rows, state: "ok" }); })
      .catch(() => { if (alive) setPending({ receipts: fromReceipts, rows: [], state: "error" }); });
    return () => { alive = false; };
  }, [pendingOpen, fromReceipts]);

  // Three things a spares master either has or does not. Averaged rather than
  // weighted — there is no basis yet for saying a missing rate matters more
  // than a missing maximum, and inventing one would be a number about nothing.
  const pct = (n) => (stats.total ? Math.round((n / stats.total) * 100) : 0);
  // Each row opens what is *missing*, not what is set: "Rate set 74%" is read
  // by someone whose job is the other 26%, and the title says which list it is
  // so the figure and the list can never be confused for each other.
  const completeness = {
    parts: [
      {
        label: "Min/Max set", pct: pct(stats.planned), missingLabel: "No Maximum Set",
        missing: parts.filter((p) => !(Number(p.max_stock_level || 0) > 0)),
        missingHint: "Nothing to reorder these against until a maximum is set",
      },
      {
        label: "Rate set", pct: pct(stats.rated), missingLabel: "No Rate Set",
        missing: parts.filter((p) => !(Number(p.unit_price || 0) > 0)),
        missingHint: "These cannot be valued until a rate is entered",
      },
      {
        label: "Location set", pct: pct(stats.locationSet), missingLabel: "No Location Set",
        missing: parts.filter((p) => !p.location),
        missingHint: "Nobody can be told where to find these on the floor",
      },
    ],
    score: 0,
  };
  completeness.score = Math.round(
    completeness.parts.reduce((sum, c) => sum + c.pct, 0) / completeness.parts.length
  );

  const [drill, setDrill] = useState(null);

  // Consumption filters purely by a calendar From–To range now — no presets.
  // With no range set it shows all-time, straight off `ops` (no fetch); a range
  // re-queries the three breakdowns. The cancel flag stops a fast re-pick from
  // landing an older range's rows after a newer one.
  const [consFrom, setConsFrom] = useState("");
  const [consTo, setConsTo] = useState("");
  // A native date input can't show a custom placeholder, so each field starts as
  // a text box reading "From"/"To" and flips to a real date picker on focus —
  // the type is in state so React never reconciles it back mid-interaction.
  const [fromType, setFromType] = useState("text");
  const [toType, setToType] = useState("text");
  const [rangedCons, setRangedCons] = useState(null);
  const [consLoading, setConsLoading] = useState(false);
  const custom = Boolean(consFrom && consTo);
  const qFrom = custom ? consFrom : undefined;
  const qTo = custom ? consTo : undefined;

  useEffect(() => {
    if (!custom) { setRangedCons(null); setConsLoading(false); return; }
    let cancelled = false;
    setConsLoading(true);
    Promise.all([
      spareStockService.consumption(STORE_CODE, "department", undefined, undefined, qFrom, qTo).then((r) => r.data.data).catch(() => []),
      spareStockService.consumption(STORE_CODE, "machine", undefined, undefined, qFrom, qTo).then((r) => r.data.data).catch(() => []),
      spareStockService.consumption(STORE_CODE, "type", undefined, undefined, qFrom, qTo).then((r) => r.data.data).catch(() => []),
    ]).then(([department, machine, type]) => {
      if (cancelled) return;
      setRangedCons({ department, machine, type });
      setConsLoading(false);
    });
    return () => { cancelled = true; };
  }, [custom, qFrom, qTo]);

  const deptData = rangedCons ? rangedCons.department : (overview?.consumption?.by_department || []);
  const machineData = rangedCons ? rangedCons.machine : (overview?.consumption?.by_machine || []);
  const typeData = rangedCons ? rangedCons.type : (overview?.consumption?.by_type || []);

  // The single donut opens a full-detail drill: machine + part-type breakdowns,
  // the daily trend and the whole consumed-parts list. All of it is fetched only
  // when the drill is opened (and refetched if the range changes while open), so
  // the summary page stays a single light request. `consDrill` names which of
  // the three donuts was drilled — that dimension leads the drill, with the
  // daily trend and the consumed-parts list (labelled by description) below.
  const [consDrill, setConsDrill] = useState(null);
  const [consumedParts, setConsumedParts] = useState([]);
  const [trendData, setTrendData] = useState([]);
  const [consDetailLoading, setConsDetailLoading] = useState(false);
  useEffect(() => {
    if (!consDrill) return;
    let cancelled = false;
    setConsDetailLoading(true);
    Promise.all([
      spareStockService.topConsumed(STORE_CODE, 300, 3650, qFrom, qTo).then((r) => r.data.data).catch(() => []),
      spareStockService.consumptionTrend(STORE_CODE, 90, undefined, qFrom, qTo).then((r) => r.data.data).catch(() => []),
    ]).then(([consumed, trend]) => {
      if (cancelled) return;
      setConsumedParts(consumed);
      setTrendData(trend);
      setConsDetailLoading(false);
    });
    return () => { cancelled = true; };
  }, [consDrill, qFrom, qTo]);

  const consTotal = deptData.reduce((s, d) => s + (Number(d.value) || 0), 0);
  const typeTotal = typeData.reduce((s, d) => s + (Number(d.value) || 0), 0);
  const machineTotal = machineData.reduce((s, d) => s + (Number(d.value) || 0), 0);
  const consRangeTitle = custom ? `${consFrom} → ${consTo}` : "All time";
  // One config drives both the three page donuts and the drill each opens.
  const CONS_DIMS = [
    { key: "department", icon: Factory, tone: "violet", title: "By Department", pageTitle: "Department-wise", hint: "Share of issues by department", data: deptData, total: consTotal, empty: "Nothing issued in this range" },
    { key: "machine", icon: Settings, tone: "green", title: "By Machine", pageTitle: "Machine-wise", hint: "Which machine eats the most spares", data: machineData, total: machineTotal, empty: "No machine recorded yet" },
    { key: "type", icon: Bolt, tone: "amber", title: "By Part Type", pageTitle: "Part-type", hint: "Sensor · Cylinder · Pin · Punch …", data: typeData, total: typeTotal, empty: "No part-type consumption yet" },
  ];
  const consFocus = CONS_DIMS.find((d) => d.key === consDrill) || null;

  // Every tile opens, including one reading zero: a tile that silently does
  // nothing reads as broken, and "nothing is below its minimum" is worth
  // confirming rather than having to infer from a card that won't respond.
  const opener = (drillDown) => () => setDrill(drillDown);

  const partsDrill = (title, subtitle, rows, exportName) => ({
    title, subtitle, rows, exportName, columns: COLUMNS, onRowClick: onPartClick,
  });
  const stockDrill = (title, subtitle, rows, exportName) => ({
    title, subtitle, rows, exportName, columns: BELOW_MIN_COLUMNS, onRowClick: onStockClick,
  });

  // The two "today" tiles: their rows are fetched when opened (same shift-start
  // boundary as the card, so the list always ties out to the figure). A failed
  // read is toasted by the api interceptor and nothing opens.
  const openToday = async (dir) => {
    const inbound = dir === "in";
    try {
      const res = inbound
        ? await spareStockService.todayReceipts(STORE_CODE, sectionId ?? undefined)
        : await spareStockService.todayIssues(STORE_CODE, sectionId ?? undefined);
      const rows = res.data.data || [];
      const qty = rows.reduce((s, r) => s + Math.abs(Number(r.qty_delta) || 0), 0);
      setDrill({
        title: inbound ? "Today Added to Stock" : "Today Issued",
        subtitle: inbound
          ? `${num(qty)} pcs added since the shift started — stock-ins read from ERP GRNs / RGP GRNs`
          : `${num(qty)} pcs issued since the shift started`,
        rows, columns: inbound ? TODAY_IN_COLUMNS : TODAY_OUT_COLUMNS,
        exportName: inbound ? "spare_today_added" : "spare_today_issued",
        onRowClick: onStockClick,
      });
    } catch { /* interceptor toasts */ }
  };

  const counted = stockRows.filter((r) => r.qty_on_hand != null);
  const byStatus = (status) => stockRows.filter((r) => r.status === status);

  // Above-max parts with how far over, furthest first — the excess drill.
  const excessRows = useMemo(() => stockRows
    .filter((r) => r.status === "Above Maximum")
    .map((r) => ({ ...r, excess_qty: Math.round((r.qty_on_hand - (r.max_stock_level || 0)) * 100) / 100 }))
    .sort((a, b) => b.excess_qty - a.excess_qty), [stockRows]);
  // Every short part (empty / below min / at reorder), worst first.
  const shortRows = useMemo(() => deriveBelowMin(stockRows, Infinity), [stockRows]);

  // One opener per stock status, shared by the health bar, the attention list
  // and the KPI drills — so a status always opens the same list.
  const STATUS_DRILL = {
    "Out of Stock": ["Zero Stock", "Counted, and nothing on the shelf", "spares_zero_stock"],
    "Below Minimum": ["Below Minimum", "In stock has fallen under the minimum", "spares_below_minimum"],
    "Reorder": ["Reorder", "At or below the reorder level — time to order", "spares_reorder"],
    "Healthy": ["Healthy", "Counted and inside Min / Max", "spares_healthy"],
    "Not Counted": ["Never Counted", "No count has ever been recorded — these are not judged against Min/Max", "spares_never_counted"],
  };
  const openStatus = (status) => {
    if (status === "Above Maximum") {
      setDrill({
        title: "Excess Parts", subtitle: "Above the maximum, furthest over first",
        rows: excessRows, columns: EXCESS_COLUMNS, onRowClick: onStockClick, exportName: "spares_excess",
      });
      return;
    }
    const [title, sub, file] = STATUS_DRILL[status] || [status, "", "spares"];
    setDrill(stockDrill(title, sub, byStatus(status), file));
  };
  const ATTENTION_STATUS = {
    zero_stock: "Out of Stock", below_min: "Below Minimum", reorder: "Reorder",
    excess: "Above Maximum", never_counted: "Not Counted",
  };
  // A line opens its parts on this page; its action button goes to the screen
  // that fixes it (Store Stock pre-filtered to that status, Scan Part, ...).
  const openAttention = (it) => {
    if (ATTENTION_STATUS[it.key]) { openStatus(ATTENTION_STATUS[it.key]); return; }
    if (it.key === "srv_pending") { setPendingOpen(true); return; }
    if (it.action?.to) navigate(it.action.to);
  };
  const actAttention = (it) => {
    if (!it.action) return;
    navigate(it.action.status ? `${it.action.to}?status=${encodeURIComponent(it.action.status)}` : it.action.to);
  };
  const valueDrill = (title, subtitle, rows, file) => setDrill({
    title, subtitle, exportName: file, onRowClick: onStockClick, columns: STOCK_VALUE_COLUMNS, valueChart: true,
    rows: rows.filter((r) => r.stock_value != null).sort((a, b) => b.stock_value - a.stock_value),
  });

  // Worst out-of-band first, so the six rows on screen are the six worth
  // looking at rather than whichever part numbers sort first.
  const bandRows = useMemo(() => {
    const severity = { "Out of Stock": 0, "Below Minimum": 1, "Reorder": 2, "Above Maximum": 3, "Healthy": 4 };
    return [...counted]
      .sort((a, b) => (severity[a.status] ?? 9) - (severity[b.status] ?? 9)
        || (b.unit_price || 0) - (a.unit_price || 0))
      .slice(0, 6);
  }, [stockRows]);

  // Both the rack donut and the Top Racks bars open the same list.
  const rackDrill = (rack) => partsDrill(
    `Rack ${rack}`, `Parts shelved on rack ${rack}`,
    parts.filter((p) => rackOf(p.location) === rack),
    `spares_rack_${rack}`,
  );

  // Bands are first-match, not overlapping ranges — the same rule useStoreStats
  // counts with, so the list can never disagree with the bar it came from.
  const bandDrill = (bandName) => {
    const index = VALUE_BANDS.findIndex((b) => b.label === bandName);
    return partsDrill(
      bandName, `Rated parts in the ${bandName} band`,
      parts.filter((p) => {
        const rate = Number(p.unit_price || 0);
        return rate > 0 && VALUE_BANDS.findIndex((b) => b.test(rate)) === index;
      }),
      `spares_band_${index + 1}`,
    );
  };

  return (
    <>
      {/* ---- Operational KPIs: what the store is doing right now. Rendered even
           while `ops`/`stock` are still loading (skeleton tiles) so this headline
           strip always anchors the TOP of the page, instead of popping in above
           Coverage / Needs Reordering once its background calls return. ---- */}
      <section>
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h3 className="section-title">Store Status</h3>
            <p className="section-hint">
              Movements since the {new Date(kpi?.today?.since || Date.now())
                .toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} shift start
            </p>
          </div>
          <ErpStatusStrip erp={overview?.erp} quality={overview?.data_quality}
            generatedAt={overview?.generated_at} onQuality={() => navigate("/parts")} />
        </div>
        {/* Four across, two rows — not eight across. At eight the card is
            ~175px, and once the chip takes its column the label truncates to
            "TOT…" and the figure clips. A KPI you cannot read is not a KPI. */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <KpiCard featured tone="blue" label="Total Spare Parts" icon={Wrench} value={stats.total}
            onClick={opener(partsDrill("Total Spare Parts", "Every active part in this list", parts, "spares_all"))} />
          <KpiCard featured tone="navy" label="Live Stock" icon={Package} value={kpi ? kpi.total_qty : 0} unit="pcs"
            hint={kpi ? `${num(kpi.counted_parts)} of ${num(kpi.total_parts)} counted` : ""}
            onClick={opener(stockDrill("Live Stock", "Counted parts and what is on the shelf", counted, "spare_live_stock"))} />
          <KpiCard featured tone="green" label="Stock Value" icon={IndianRupee}
            value={compactMoney(kpi?.stock_value || null)} valueTitle={money(kpi?.stock_value)}
            hint={kpi?.valued_parts ? `${num(kpi.valued_parts)} carry a rate` : "No rated part counted yet"}
            onClick={opener({
              title: "Stock Value", exportName: "spare_stock_value", onRowClick: onStockClick,
              subtitle: `${money(kpi?.stock_value)} across ${num(kpi?.valued_parts)} counted parts that carry a rate`,
              rows: counted.filter((r) => r.stock_value != null).sort((a, b) => b.stock_value - a.stock_value),
              columns: STOCK_VALUE_COLUMNS,
              // Opens with the Live-Dashboard "Top 10 by Value" bar chart above
              // the list — the highest-value spares, graphically, on drill.
              valueChart: true,
            })} />
          {/* All five tiles always show, each with its fallback figure (0 / —)
              until the data lands — no skeletons that could sit blank. Today
              Received / Issued simply stay 0 on a section page, which has no
              store-wide ops. */}
          {/* Stock-ins, not arrivals: receiving happens in ERP, and a line is
              added here when the qty quality accepted in ERP reaches store stock. */}
          <KpiCard featured tone="green" label="Today Added to Stock" icon={ArrowDownToLine}
            value={kpi?.today?.received_qty ?? 0} unit="pcs"
            hint={`${kpi?.today?.received_lines ?? 0} stock-in line${kpi?.today?.received_lines === 1 ? "" : "s"}`}
            onClick={() => openToday("in")} />
          <KpiCard featured tone="red" label="Today Issued" icon={ArrowUpFromLine}
            value={kpi?.today?.issued_qty ?? 0} unit="pcs"
            hint={`${kpi?.today?.issued_lines ?? 0} issue line${kpi?.today?.issued_lines === 1 ? "" : "s"}`}
            onClick={() => openToday("out")} />
        </div>
      </section>

      {/* Master Data has no KPI strip — the same story is told by the charts in
          Coverage & Spread (Parts by Rack, Master Data Completeness, Parts by
          Price), and Total Spares already sits in Store Status above. */}

      {/* ---- Action Required: what is wrong, how serious, where, how much, and
           what to do — one server-computed list, worst first. ---- */}
      {overview && kpi && (
        <section>
          <div className="mb-3">
            <h3 className="section-title">Action Required</h3>
            <p className="section-hint">Each opens the parts behind it</p>
          </div>
          {/* With nothing counted, every line that compares a quantity against
              Min/Max is empty by definition — four zeros beside "4,816 never
              counted" would read as a healthy store. So until the first count
              exists, the section says the one thing that is actually required. */}
          {kpi.counted_parts === 0 ? (
            <div className="card border-amber-200 dark:border-amber-500/30 bg-amber-50/50 dark:bg-amber-500/[0.07]">
              <div className="flex flex-wrap items-center gap-4">
                <ClipboardList size={30} strokeWidth={1.75} className="shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-slate-800 dark:text-white">No stock has been counted yet</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
                    None of the {num(kpi.total_parts)} parts has a quantity to compare against its Min and Max —
                    so short, zero and excess cannot be worked out. Upload one opening-stock sheet and this
                    section and the whole health view fill in.
                  </p>
                </div>
                <button type="button" onClick={() => openStatus("Not Counted")}
                  className="shrink-0 rounded-lg bg-toyotared text-white text-xs font-semibold px-4 py-2.5 hover:opacity-90 transition-opacity">
                  See all {num(kpi.uncounted_parts)} parts
                </button>
              </div>
            </div>
          ) : (
            <AttentionBoard items={attention} onOpen={openAttention} onAction={actAttention} />
          )}
        </section>
      )}

      {/* ---- Inventory health + value: every part once by status (a bar, not
           four gauges), where the money is, and the Min · Current · Max band. ---- */}
      {overview && kpi && (
        <section>
          <div className="mb-3">
            <h3 className="section-title">Inventory Health &amp; Value</h3>
            <p className="section-hint">Every status and every bar opens its parts</p>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <HealthBar health={overview.health} total={kpi.total_parts} onStatus={openStatus} />
            <ValuePanel
              value={overview.value}
              onRestock={() => setDrill({
                title: "Short parts — restock to max", exportName: "spares_short_restock",
                subtitle: `${money(overview.value.to_restock)} to bring every empty, below-minimum and at-reorder part back to its maximum`,
                rows: shortRows, columns: BELOW_MIN_COLUMNS, onRowClick: onStockClick,
              })}
              onExcess={() => openStatus("Above Maximum")}
              onSection={(d) => valueDrill(`${d.name} — stock value`, `${money(d.value)} on the shelf in this section`,
                stockRows.filter((r) => r.section_id === d.section_id), `spares_value_section_${d.section_id}`)}
              onType={(d) => valueDrill(`${d.name} — stock value`, `${money(d.value)} across ${num(d.parts)} parts of this type`,
                stockRows.filter((r) => ((r.sub_category || "").trim() || "Uncategorised") === d.name),
                `spares_value_type_${d.name.replace(/[^\w-]+/g, "_").toLowerCase()}`)}
            />
            {/* Min · Current · Max moved here from Inventory Health, which is
                where the status donut already lives. The two together are the
                whole stock picture; apart, each half repeated the other. */}
            <div className="card">
              <CardHead icon={ChartColumn} tone="blue" title="Min · Current · Max"
                hint="Counted parts, furthest out of band first"
                action={counted.length > 5 ? (
                  <button type="button"
                    onClick={() => setDrill(stockDrill("Min · Current · Max",
                      "Every counted part against its limits", counted, "spare_min_max"))}
                    className="text-[11px] font-medium text-toyotared hover:underline">
                    View all {num(counted.length)}
                  </button>
                ) : null} />
              {counted.length === 0 ? (
                <NotCaptured
                  what="No part has been counted yet"
                  needs="Count a part on the Store Stock screen and it appears here against its Min and Max."
                />
              ) : (
                <ul className="space-y-2.5">
                  {bandRows.slice(0, 5).map((r) => (
                    <li key={r.part_id}>
                      <button type="button" onClick={() => onStockClick && onStockClick(r)}
                        className="w-full text-left group">
                        <div className="flex items-baseline justify-between gap-2 text-xs mb-1">
                          <span className="truncate text-slate-600 dark:text-slate-300 group-hover:text-toyotared">
                            {r.part_no}
                          </span>
                          <span className="shrink-0 tabular text-slate-500 dark:text-slate-400">
                            {num(r.min_stock_level)} · <span className="font-semibold text-slate-800 dark:text-white">{num(r.qty_on_hand)}</span> · {r.max_stock_level == null ? "—" : num(r.max_stock_level)}
                          </span>
                        </div>
                        <MinMaxBar row={r} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </section>
      )}

      {reorderPlanned && belowMin && belowMin.length > 0 && (
        <section>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-xl font-extrabold text-toyotared dark:text-red-400">Needs Reordering</h3>
            {onReorderExport && (
              <button className="btn-secondary py-1.5 text-[13px]" onClick={onReorderExport}
                title="Reorder list, section & category-wise, with the quantity to order — for the concerned department">
                <Download size={14} aria-hidden="true" /> Excel (section &amp; category-wise, with order qty)
              </button>
            )}
          </div>
          <div className="card">
            <Table
              columns={BELOW_MIN_COLUMNS}
              rows={belowMin}
              onRowClick={onStockClick}
              rowClassName={() => "text-red-600 dark:text-red-400 font-semibold"}
              searchable={belowMin.length > 10 ? "Search part no or description…" : false}
              pageSize={0}
              maxHeight="62vh"
              exportName="spares_below_minimum"
              emptyMessage="Nothing below its minimum"
            />
          </div>
        </section>
      )}

      {/* Excess has no standalone list here — the Inventory Status Distribution
          donut (Above Maximum slice) and the "Excess Parts" tile in Action
          Required both drill to the same list, and that drill carries its own
          Export button. A third copy as a flat table was redundant. */}

      {/* ---- Consumption analytics: a headline strip over four charts, all
           scoped by one range picker ---- */}
      {overview && storeLevel && (
        <section>
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="section-title">Consumption</h3>
              <p className="text-xs font-medium text-slate-400 dark:text-slate-500">Spare Parts Store Analytics · {consRangeTitle}</p>
              {overview.consumption?.comparison && <ConsumptionCompare c={overview.consumption.comparison} />}
            </div>
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              {/* Filter purely by a calendar From–To range; clear it (X) for
                  all-time. It scopes every chart, the drill and the Excel. */}
              <div className={`inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 ${custom ? "border-toyotared bg-toyotared/5" : "border-slate-200 dark:border-navy-700"}`}>
                <CalendarDays size={15} className="shrink-0 text-slate-400" aria-hidden="true" />
                <input type={fromType} placeholder="From" value={consFrom} max={consTo || undefined}
                  aria-label="From date"
                  onFocus={(e) => { e.target.type = "date"; setFromType("date"); try { e.target.showPicker?.(); } catch { /* not user-activated */ } }}
                  onBlur={() => { if (!consFrom) setFromType("text"); }}
                  onChange={(e) => setConsFrom(e.target.value)}
                  className="bg-transparent text-xs text-slate-600 dark:text-slate-300 placeholder:text-slate-400 outline-none w-[86px] cursor-pointer" />
                <span className="text-slate-400 text-xs">–</span>
                <input type={toType} placeholder="To" value={consTo} min={consFrom || undefined}
                  aria-label="To date"
                  onFocus={(e) => { e.target.type = "date"; setToType("date"); try { e.target.showPicker?.(); } catch { /* not user-activated */ } }}
                  onBlur={() => { if (!consTo) setToType("text"); }}
                  onChange={(e) => setConsTo(e.target.value)}
                  className="bg-transparent text-xs text-slate-600 dark:text-slate-300 placeholder:text-slate-400 outline-none w-[70px] cursor-pointer" />
                {custom && (
                  <button type="button" title="Clear the range — back to all-time"
                    onClick={() => { setConsFrom(""); setConsTo(""); setFromType("text"); setToType("text"); }}
                    className="text-slate-400 hover:text-toyotared leading-none px-0.5"><X size={14} aria-hidden="true" /></button>
                )}
              </div>
              <button className="btn-secondary shrink-0"
                onClick={() => downloadFile(
                  "/spare-stock/consumption/export",
                  `spare_consumption_${custom ? `${consFrom}_${consTo}` : "all"}.xlsx`,
                  { store_code: STORE_CODE, from: qFrom, to: qTo },
                )}>
                <Download size={14} aria-hidden="true" /> Excel
              </button>
            </div>
          </div>

          {/* Three donuts side by side — the wide row had the room. Tapping any
              one opens its own drill with the daily trend and consumed parts. */}
          <div className={`grid grid-cols-1 md:grid-cols-3 gap-4 transition-opacity ${consLoading ? "opacity-50" : ""}`}>
            {CONS_DIMS.map((dim) => (
              <div key={dim.key} role="button" tabIndex={0}
                onClick={() => setConsDrill(dim.key)}
                onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setConsDrill(dim.key)}
                className="card card-interactive">
                <div className="flex items-start justify-between gap-2">
                  <CardHead icon={dim.icon} tone={dim.tone} title={`${dim.pageTitle} Consumption`} hint={dim.hint} />
                  <span className="text-xs font-semibold text-slate-400 shrink-0 mt-0.5">Drill →</span>
                </div>
                <DonutChart data={dim.data} colors={consColors(dim.data)} size={128}
                  centerValue={num(dim.total)} centerLabel="pcs" emptyMessage={dim.empty} />
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <div className="mb-3">
          <h3 className="section-title">Value by Supplier</h3>
          <p className="section-hint">Who last supplied the stock on the shelf, from the ERP gate entries</p>
        </div>
        <SupplierValueCard sectionId={sectionId} stockRows={stockRows}
          onDrill={setDrill} onStockClick={onStockClick} />
      </section>

      <section>
        <div className="mb-3">
          <h3 className="section-title">Coverage & Spread</h3>
          <p className="section-hint">Planning, racks and rates</p>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* A ring with the count in the middle rather than bars: with three
              racks this is a composition — what share of the store sits where —
              and the total belongs in the hole, not in a separate line. */}
          <div className="card">
            <CardHead icon={MapPin} tone="blue" title="Parts by Rack" hint="Where the spares physically live" />
            <DonutChart
              data={stats.racks.slice(0, 6)}
              colors={RACK_COLORS(stats.racks)}
              size={124}
              centerValue={num(stats.total)}
              centerLabel="parts"
              emptyMessage="No locations recorded yet"
              onSliceClick={(d) => setDrill(rackDrill(d.name))}
            />
          </div>

          {/* Deliberately "Master Data Completeness", not "Store Health". A
              health score implies something about the stock — and this store
              has no stock figure at all yet. What it can honestly score is how
              much of its own master is filled in. */}
          <div className="card">
            <CardHead icon={CircleCheck} tone="green" title="Master Data Completeness"
              hint="How much of the list is filled in — not a stock reading" />
            <div className="flex items-center gap-4">
              <RadialGauge value={completeness.score} size={110} label="complete" />
              <ul className="min-w-0 flex-1 space-y-2">
                {completeness.parts.map((c) => (
                  <li key={c.label}>
                    <button
                      type="button"
                      onClick={() => setDrill(partsDrill(
                        c.missingLabel,
                        `${num(c.missing.length)} of ${num(stats.total)} parts — ${c.missingHint}`,
                        c.missing,
                        `spares_${c.missingLabel.toLowerCase().replace(/\s+/g, "_")}`,
                      ))}
                      className="w-full group cursor-pointer"
                    >
                      <div className="flex items-baseline justify-between gap-2 text-xs">
                        <span className="text-slate-500 dark:text-slate-400 truncate group-hover:text-toyotared">
                          {c.label}
                        </span>
                        <span className="font-semibold tabular text-slate-800 dark:text-white">{c.pct}%</span>
                      </div>
                      <div className="h-1.5 mt-1 rounded-full bg-slate-100 dark:bg-navy-800 overflow-hidden">
                        <div className="h-full rounded-full bg-emerald-500" style={{ width: `${c.pct}%` }} />
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* Grouped by unit rate — a ring beside the rack ring, each band a slice,
              the rated-part total in the hole. */}
          <div className="card">
            <CardHead icon={IndianRupee} tone="green" title="Parts by Price" hint="Grouped by unit price" />
            <DonutChart
              data={stats.bands}
              colors={Object.fromEntries(stats.bands.map((b) => [b.name, b.color]))}
              size={124}
              centerValue={num(stats.bands.reduce((s, b) => s + b.value, 0))}
              centerLabel="rated parts"
              emptyMessage="No rates recorded yet"
              onSliceClick={(d) => setDrill(bandDrill(d.name))}
            />
          </div>
        </div>
      </section>

      {/* No standalone "Highest Value Spares" section — the Top-10-by-value bar
          chart now opens inside the Stock Value tile's drill (valueChart), the
          way the Live Dashboard does it. */}

      {/* ---- Recent Activity: what has actually happened to stock ---- */}
      {overview && (
        <section>
          <div className="mb-3">
            <h3 className="section-title">Recent Activity</h3>
            <p className="section-hint">Every movement recorded against this store&apos;s stock</p>
          </div>
          <div className="card">
            {overview.recent_activity.length === 0 ? (
              <NotCaptured
                what="Nothing has moved yet"
                needs="Every opening count, receipt, issue and correction writes a ledger row and appears here with its time, part, quantity and who did it."
                endpoint="GET /dashboard/spare/overview"
              />
            ) : (
              <Table
                columns={ACTIVITY_COLUMNS}
                rows={overview.recent_activity}
                onRowClick={(r) => {
                  const row = stockRows.find((s) => s.part_id === r.part_id);
                  if (row && onStockClick) onStockClick(row);
                }}
                pageSize={0}
                exportName="spare_activity"
                emptyMessage="No activity yet"
              />
            )}
          </div>
        </section>
      )}

      <DrillDown drill={drill} onClose={() => setDrill(null)} />

      {/* The drilled donut's detail: that dimension's breakdown, the daily trend
          and the consumed-parts list — labelled by description, like the Live
          Dashboard. */}
      {consFocus && createPortal(
        <div className="fixed inset-0 z-50 flex flex-col gap-4 p-4 lg:p-6 overflow-auto bg-slate-50 dark:bg-navy-950 animate-[fadeIn_0.15s_ease-out]">
          <div className="shrink-0 rounded-2xl px-5 py-3.5 flex items-center gap-3 text-white shadow-[0_12px_34px_rgba(10,32,70,0.35)]"
            style={{ background: "linear-gradient(120deg,#0a2340 0%,#123a6b 55%,#0a2038 100%)" }}>
            <button onClick={() => setConsDrill(null)} title="Back"
              className="w-10 h-10 rounded-lg bg-white/10 hover:bg-white/20 flex items-center justify-center shrink-0">
              <ArrowLeft size={20} />
            </button>
            <div className="min-w-0 flex-1">
              <h2 className="text-xl lg:text-2xl font-extrabold truncate"
                style={{ backgroundImage: "linear-gradient(92deg,#ff9a4d,#ff5a6a,#ffd9b0)", WebkitBackgroundClip: "text", backgroundClip: "text", WebkitTextFillColor: "transparent", color: "transparent" }}>
                Consumption · {consFocus.title} · {consRangeTitle}
              </h2>
              <p className="text-xs text-white/70 truncate">{num(consFocus.total)} pcs · with the daily trend and the consumed-parts list</p>
            </div>
            <button className="btn-secondary py-1.5 text-[13px] shrink-0"
              onClick={() => downloadFile("/spare-stock/consumption/export",
                `spare_consumption_${custom ? `${consFrom}_${consTo}` : "all"}.xlsx`,
                { store_code: STORE_CODE, from: qFrom, to: qTo })}>
              <Download size={14} aria-hidden="true" /> Excel
            </button>
            <button onClick={() => setConsDrill(null)} title="Close"
              className="w-10 h-10 rounded-lg bg-white/10 hover:bg-white/20 flex items-center justify-center shrink-0"><X size={20} aria-hidden="true" /></button>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="card">
              <CardHead icon={consFocus.icon} tone={consFocus.tone} title={consFocus.title} hint={consFocus.hint} />
              <DonutChart data={consFocus.data} colors={consColors(consFocus.data)} size={150}
                centerValue={num(consFocus.total)} centerLabel="pcs" emptyMessage={consFocus.empty} />
            </div>
            <div className="card">
              <CardHead icon={TrendingUp} tone="blue" title="Consumption Trend"
                hint={custom ? `Daily issued qty · ${consRangeTitle}` : "Daily issued qty · last 90 days"} />
              {consDetailLoading
                ? <div className="h-56 flex items-center justify-center"><div className="skeleton h-40 w-full rounded-xl" /></div>
                : <TrendArea data={trendData} />}
            </div>
          </div>

          <div className="card">
            <div className="flex items-start justify-between gap-2">
              <CardHead icon={ClipboardList} tone="violet" title="Consumed parts — by quantity"
                hint="Ranked by quantity issued, labelled with the part description" />
              <button className="btn-secondary py-1.5 text-[13px] shrink-0"
                onClick={() => downloadXlsx(
                  `spare_consumed_${custom ? `${consFrom}_${consTo}` : "all"}`,
                  ["Part No", "Description", "Qty Issued"],
                  consumedParts.map((p) => [p.part_no, p.part_name || "", Number(p.qty) || 0]),
                  "Consumed",
                )}>
                <Download size={14} aria-hidden="true" /> Excel (full list)
              </button>
            </div>
            {consDetailLoading ? (
              <div className="space-y-2.5 py-2">
                {Array.from({ length: 6 }).map((_, i) => <div key={i} className="skeleton h-6 w-full rounded" />)}
              </div>
            ) : (
              <>
                <HorizontalBars
                  data={consumedParts.slice(0, 20).map((p) => ({
                    ...p,
                    name: p.part_name ? `${p.part_name} · ${p.part_no}` : p.part_no,
                    value: Number(p.qty) || 0,
                  }))}
                  color="#6366f1"
                  valueSuffix=" pcs"
                  emptyMessage="Nothing issued in this range"
                  onBarClick={(d) => {
                    const row = stockRows.find((r) => r.part_no === d.part_no);
                    if (row && onStockClick) { setConsDrill(null); onStockClick(row); }
                  }}
                />
                {consumedParts.length > 20 && (
                  <p className="text-xs text-slate-400 mt-3">Showing the top 20 of {num(consumedParts.length)} — download for the full list.</p>
                )}
              </>
            )}
          </div>
        </div>,
        document.body,
      )}

      {/* ERP GRN lines waiting for ERP's quality clearance or to be checked
          (or, on an older overview, SRV lines waiting on an SRV or an engineer). */}
      <Modal open={pendingOpen} onClose={() => setPendingOpen(false)} size="full"
        title="GRN / Quality Pending (ERP)">
        <div className="space-y-3">
          <p className="text-xs text-slate-400 -mt-1">
            {pending.receipts
              ? "ERP GRN lines of this store's parts waiting for the Maintenance / Tool Room quality clearance in ERP, or to be checked against ERP — not store stock until ERP accepts them. Read from ERP; nothing to record in the app."
              : "Arrived but no SRV raised, or the SRV is with an engineer for clearance"}
          </p>
          {pending.receipts && receiving?.erp && (() => {
            const fresh = erpFreshness(receiving.erp);
            return (
              <p className={`-mt-1 text-[11px] ${fresh.stale ? "font-medium text-amber-700 dark:text-amber-300" : "text-slate-500 dark:text-slate-400"}`}>
                {fresh.text}{fresh.stale && fresh.staleText ? ` — ${fresh.staleText}` : ""}
              </p>
            );
          })()}
          {pending.state === "loading" ? (
            <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="skeleton h-10 w-full" />)}</div>
          ) : pending.state === "error" ? (
            <p className="py-8 text-center text-sm text-slate-500 dark:text-slate-400">
              Couldn&apos;t load the pending list — close and open it again.
            </p>
          ) : pendingRows.length === 0 ? (
            pending.receipts ? (
              <NotCaptured
                what="No ERP GRN line is waiting"
                needs="ERP GRN lines of this store's parts are listed here until quality accepts them in ERP — then the accepted qty is added to store stock by itself."
                endpoint="GET /spare-flow/queues"
              />
            ) : (
              <NotCaptured
                what="No inbound line is waiting"
                needs="Gate entry and SRV lines for this store appear here as soon as ERP pushes them. No gate entry has been recorded against a spare part yet."
                endpoint="GET /spare-stock/pending/list"
              />
            )
          ) : (
            <Table key={pending.receipts ? "erp-lines" : "srv"}
              columns={pending.receipts ? ERP_LINE_PENDING_COLUMNS : PENDING_COLUMNS} rows={pendingRows} pageSize={0} maxHeight="60vh"
              rowKey={pending.receipts ? erpLineKey : undefined}
              searchable={pendingRows.length > 10 ? "Search GRN, part or supplier…" : false}
              exportName={pending.receipts ? "spares_grn_quality_pending_erp" : "spares_srv_pending"} emptyMessage="Nothing pending" />
          )}
        </div>
      </Modal>
    </>
  );
}

const COLUMNS = [
  { key: "part_no", label: "Part No", sortable: true },
  { key: "part_name", label: "Description", sortable: true },
  { key: "location", label: "Location", sortable: true, render: (r) => r.location || "—" },
  {
    key: "rework_location",
    label: "Rework Location",
    sortable: true,
    // Called out rather than left as plain text: these are the parts that
    // leave their shelf for rework, which is the thing the sheet's own
    // "REWORK LOCATION" column exists to flag.
    render: (r) =>
      r.rework_location ? (
        <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full
          bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
          <Repeat2 size={12} aria-hidden="true" /> {r.rework_location}
        </span>
      ) : (
        <span className="text-slate-300 dark:text-slate-600">—</span>
      ),
  },
  { key: "uom", label: "UOM", render: (r) => r.uom || "—" },
  {
    key: "min_stock_level", label: "Min", sortable: true, align: "right",
    sortValue: (r) => Number(r.min_stock_level || 0),
    render: (r) => num(r.min_stock_level),
  },
  {
    key: "max_stock_level", label: "Max", sortable: true, align: "right",
    sortValue: (r) => Number(r.max_stock_level || 0),
    render: (r) => (r.max_stock_level == null
      ? <span className="text-slate-300 dark:text-slate-600">—</span>
      : num(r.max_stock_level)),
  },
  {
    key: "unit_price", label: "Rate", sortable: true, align: "right",
    sortValue: (r) => Number(r.unit_price || 0),
    exportValue: (r) => (r.unit_price == null ? "" : r.unit_price),
    render: (r) => (r.unit_price == null
      ? <span className="text-slate-300 dark:text-slate-600">—</span>
      : money(r.unit_price)),
  },
];

function SectionDetail({ section }) {
  const [rows, setRows] = useState([]);
  const { openPart } = usePartDrawer();

  useEffect(() => {
    fetchAllParts({ store_code: STORE_CODE, section_id: section.id, is_active: true })
      .then(setRows)
      .catch(() => setRows([]));
  }, [section.id]);

  const stats = useStoreStats(rows);
  const { overview, stockRows } = useSpareDashboardData(section.id);
  // Bin Washing M/C spares are ordered as the machine needs them, not planned
  // to a min/max, so the reorder panel is noise there even though the rows
  // carry limits. Other sections plan against their maximum as usual.
  const reorderPlanned = !/bin\s*wash/i.test(section.name || "");

  return (
    <div className="space-y-8">
      {/* The section's back arrow + name/icon are gone from here — its name and
          icon now sit in the top header, so the content starts straight away. */}

      {/* The same dashboard as the store's, scoped to this section. Clicking a
          section used to drop you onto a bare table — a step down from the
          page you came from, when what you wanted was that page for this
          section. */}
      <SpareDashboard
        stats={stats}
        onPartClick={(p) => openPart(p.id)}
        onStockClick={(row) => openPart(row.part_id)}
        overview={overview}
        parts={rows}
        stockRows={stockRows}
        reorderPlanned={reorderPlanned}
        sectionId={section.id}
      />

      {/* "All Parts" table removed — the Master Data "Total Spares" card already
          drills to this same full list, so a second copy below was redundant. */}

    </div>
  );
}

export default function MaintenanceStore() {
  const { sectionId } = useParams();
  const navigate = useNavigate();
  const [sections, setSections] = useState([]);
  const { openPart } = usePartDrawer();

  useEffect(() => {
    storeService.sections(STORE_CODE).then((res) => res.data.data).catch(() => []).then(setSections);
  }, []);

  // Skipped when a section is open: this component still runs its hooks before
  // handing off to SectionDetail, and the store-wide figures would go unused.
  const { overview, stockRows } = useSpareDashboardData(undefined, !sectionId);
  // `parts` is derived from the stock list rather than fetched separately — the
  // stock rows already carry every part field (plus on-hand / status / value),
  // so pulling the ~4,800-row part master a SECOND time on load was pure
  // duplicate payload. `id` is aliased from part_id so the detail modal and the
  // drills (which resolve a part by id) keep working unchanged.
  const parts = useMemo(() => stockRows.map((r) => ({ ...r, id: r.part_id })), [stockRows]);
  const stats = useStoreStats(parts);
  const loading = !sectionId && overview == null;

  // The reorder alert: pop it up once when the app first lands on the main
  // store screen (not on every section), with a section-wise breakdown of what
  // needs ordering. Computed off the full stock list, so the counts are real.
  const [reorderPopup, setReorderPopup] = useState(false);
  const sectionName = useMemo(
    () => Object.fromEntries(sections.map((s) => [String(s.id), s.name])), [sections]);
  const reorderParts = useMemo(
    () => stockRows.filter((r) => ["Out of Stock", "Below Minimum", "Reorder"].includes(r.status)),
    [stockRows]);
  const reorderBySection = useMemo(() => {
    const by = {};
    reorderParts.forEach((r) => { const k = String(r.section_id ?? "—"); by[k] = (by[k] || 0) + 1; });
    return Object.entries(by)
      .map(([sid, count]) => ({ name: sectionName[sid] || "Unassigned", count }))
      .sort((a, b) => b.count - a.count);
  }, [reorderParts, sectionName]);

  // The reorder list as a section- and category-wise Excel with the quantity to
  // order per part — what a store hand attaches when raising the shortage with
  // the concerned department. Order qty = the gap up to the maximum (the same
  // figure the backend's reorder feed uses), falling back to the gap up to the
  // minimum when no maximum is planned.
  const downloadReorderExcel = () => {
    const orderQty = (r) => {
      if (r.shortfall != null) return r.shortfall;
      const gap = (r.min_stock_level || 0) - (r.qty_on_hand || 0);
      return gap > 0 ? Math.round(gap * 100) / 100 : null;
    };
    const sec = (r) => sectionName[String(r.section_id)] || "Unassigned";
    const cat = (r) => r.sub_category || "Uncategorised";
    const sorted = [...reorderParts].sort((a, b) =>
      sec(a).localeCompare(sec(b))
      || cat(a).localeCompare(cat(b))
      || String(a.part_no || "").localeCompare(String(b.part_no || "")));
    const headers = ["Section", "Category", "Part No", "Description", "Location",
      "In Stock", "Reorder Level", "Min", "Max", "Order Qty", "Rate", "Order Value", "Status"];
    const body = sorted.map((r) => {
      const q = orderQty(r);
      return [
        sec(r), cat(r), r.part_no || "", r.part_name || "", r.location || "",
        r.qty_on_hand ?? 0, r.reorder_level ?? "", r.min_stock_level ?? "", r.max_stock_level ?? "",
        q ?? "", r.unit_price ?? "",
        q != null && r.unit_price != null ? Math.round(q * r.unit_price * 100) / 100 : "",
        r.status,
      ];
    });
    downloadXlsx(`reorder_list_${new Date().toISOString().slice(0, 10)}`, headers, body, "Reorder");
  };
  useEffect(() => {
    if (sectionId || reorderParts.length === 0) return;
    let seen = false;
    try { seen = sessionStorage.getItem("dx_reorder_popup_shown") === "1"; } catch { /* private mode */ }
    if (!seen) {
      setReorderPopup(true);
      try { sessionStorage.setItem("dx_reorder_popup_shown", "1"); } catch { /* ignore */ }
    }
  }, [reorderParts.length, sectionId]);

  // Which section is open comes from the URL, so the sidebar's section links
  // and the cards below land in exactly the same place.
  const openSection = sectionId ? sections.find((s) => String(s.id) === sectionId) : null;
  if (sectionId && openSection) {
    return <SectionDetail section={openSection} />;
  }

  return (
    // No banner of its own: the top bar already carries the store's name and
    // the plant's, and the 485 it showed is the first KPI below. A header that
    // repeats the header above it just pushes the real figures down the page.
    <div className="space-y-8">
      <SpareDashboard
        stats={stats}
        onPartClick={(p) => openPart(p.id)}
        onStockClick={(row) => openPart(row.part_id)}
        overview={overview}
        parts={parts}
        stockRows={stockRows}
        onReorderExport={downloadReorderExcel}
      />

      {/* Reorder alert — premium, section-wise; shown once when the app opens. */}
      <Modal
        open={reorderPopup}
        onClose={() => setReorderPopup(false)}
        size="xl"
        footer={
          <div className="flex flex-wrap gap-2 justify-end">
            <button className="btn-secondary" onClick={downloadReorderExcel}>
              <Download size={14} aria-hidden="true" /> Excel (section &amp; category-wise, with order qty)
            </button>
            <button className="btn-primary" onClick={() => setReorderPopup(false)}>Got it</button>
          </div>
        }
      >
        <div className="-mx-5 -mt-4 mb-4 px-5 py-4 text-white"
          style={{ background: "linear-gradient(120deg,#8f0713 0%,#eb0a1e 55%,#ff6a3d 100%)" }}>
          <div className="flex items-center gap-3">
            <span className="w-12 h-12 rounded-2xl bg-white/15 flex items-center justify-center shrink-0"><TriangleAlert size={24} aria-hidden="true" /></span>
            <div className="min-w-0">
              <h3 className="text-2xl font-extrabold leading-tight">Needs Reordering</h3>
              <p className="text-sm text-white/80">
                {reorderParts.length} part{reorderParts.length === 1 ? "" : "s"} out of stock, below minimum, or at reorder level
              </p>
            </div>
          </div>
        </div>

        {reorderBySection.length > 0 && (
          <div className="mb-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">By section — where the shortage is</p>
            <div className="space-y-2">
              {reorderBySection.map((s, i) => (
                <div key={s.name} className="flex items-center gap-3 text-sm">
                  <span className="w-32 shrink-0 truncate font-medium text-slate-600 dark:text-slate-300">{s.name}</span>
                  <span className="flex-1 h-3 rounded-full bg-slate-100 dark:bg-navy-800 overflow-hidden">
                    <span className="block h-full rounded-full" style={{
                      width: `${Math.max(6, (s.count / (reorderBySection[0]?.count || 1)) * 100)}%`,
                      background: REORDER_BAR_COLORS[i % REORDER_BAR_COLORS.length],
                    }} />
                  </span>
                  <span className="w-8 text-right font-extrabold tabular text-slate-800 dark:text-white">{s.count}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">The parts</p>
        <div className="rounded-xl border border-red-200 dark:border-red-500/30 divide-y divide-red-100 dark:divide-red-500/20 max-h-[38vh] overflow-y-auto">
          {reorderParts.map((r) => (
            <div key={r.part_id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <div className="min-w-0">
                <span className="font-semibold text-red-600 dark:text-red-400">{r.part_no}</span>
                <span className="text-slate-500 dark:text-slate-400 ml-2">{r.part_name}</span>
                <span className="text-[11px] text-slate-400 ml-2">· {sectionName[String(r.section_id)] || "—"}</span>
              </div>
              <span className="shrink-0 text-xs font-semibold text-red-600 dark:text-red-400 whitespace-nowrap">
                {r.qty_on_hand ?? 0} in stock · {r.status}
              </span>
            </div>
          ))}
        </div>
      </Modal>

      {/* Only once there is something to compare. The sidebar is where you go
          to a section; this table is where you see which section is planned
          and which is not. With a single section that comparison is one row
          repeating the strip above, so it reads as the section's name printed
          twice — which is exactly how it looked. */}
      {sections.length > 1 && (
        <section>
          <div className="mb-3">
            <h3 className="section-title">By Section</h3>
            <p className="section-hint">Parts and planning coverage in each section</p>
          </div>
          <div className="card">
            <Table
              columns={SECTION_COLUMNS}
              rows={sections}
              loading={loading}
              onRowClick={(s) => navigate(`/store/${STORE_CODE}/${s.id}`)}
              emptyMessage="No sections defined yet"
            />
          </div>
        </section>
      )}

      {!loading && sections.length === 0 && (
        <div className="card">
          <p className="text-sm text-slate-500 dark:text-slate-400">No sections defined for this store yet.</p>
          <p className="text-xs text-slate-400 mt-2">
            A section — Press Shop, Tool Room, Seat Slider — appears in the sidebar the moment its row exists.
          </p>
        </div>
      )}

    </div>
  );
}
