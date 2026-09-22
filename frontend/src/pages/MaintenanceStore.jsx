import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Printer, X } from "lucide-react";
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
import { srvService } from "../services/srvService.js";

const STORE_CODE = "MAINTENANCE";

// A glyph per section, matched on its name so a section added later still
// gets one without a code change. Emoji rather than an icon set, to stay with
// the vocabulary the sidebar and the KPI cards already use.
const SECTION_EMOJI = [
  [/press|stamp|misumi|die/i, "🔨"],
  [/nut|bolt|fasten/i, "🔩"],
  [/thin|recliner|rec\b/i, "💺"],
  [/bin|wash/i, "🚿"],
  [/maint/i, "🔧"],
  [/tool/i, "🛠️"],
  [/seat|slider/i, "💺"],
  [/weld/i, "🔥"],
  [/paint|coat/i, "🎨"],
  [/electric|electr/i, "⚡"],
];
const emojiFor = (name) => (SECTION_EMOJI.find(([re]) => re.test(name || "")) || [null, "🧰"])[1];

const num = (v) => (v == null ? "—" : Number(v).toLocaleString("en-IN"));
const money = (v) =>
  v == null ? "—" : `₹${Number(v).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

// Crores and lakhs for the headline figure, the way the mock-up reads it and
// the way the plant says it out loud. A KPI tile is 211px wide at 1440 — the
// full ₹29,34,640 does not fit beside the badge, and a clipped number is worse
// than a rounded one. The exact rupee stays in the tooltip and the export.
const compactMoney = (v) => {
  if (v == null) return "—";
  const n = Number(v);
  if (n >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`;
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(2)} L`;
  if (n >= 1e3) return `₹${(n / 1e3).toFixed(1)} K`;
  return money(n);
};

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
        <span className="text-base leading-none">{emojiFor(r.name)}</span>
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

// The figures and charts a spares list can honestly answer, over whatever set
// of parts it is given. Rendered for the whole store on its dashboard and for
// one section on the section's own page, so the two never drift apart.
function DetailRow({ label, value }) {
  return (
    <div className="flex justify-between py-1.5 text-sm border-b border-slate-100 dark:border-navy-800 last:border-0">
      <span className="text-slate-500">{label}</span>
      <span className="font-medium text-slate-800 dark:text-white text-right">{value ?? "—"}</span>
    </div>
  );
}

// One spare, with every receipt it has ever had. The receipt history is the
// answer to "which supplier did this come from, and when" — a spare bought
// from more than one supplier lists each arrival separately, because the
// supplier rides on the gate entry (SRV.supplier_name), not on the part.
function SparePartDetail({ part, onClose, onTrace }) {
  const [srvs, setSrvs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [stock, setStock] = useState(null);
  const [moves, setMoves] = useState([]);

  useEffect(() => {
    if (!part) return;
    setLoading(true);
    setStock(null);
    setMoves([]);
    Promise.all([
      srvService.list({ part_id: part.id, per_page: 25 })
        .then((res) => res.data.data).catch(() => []),
      spareStockService.forPart(part.id).then((res) => res.data.data).catch(() => null),
      spareStockService.history(part.id, 10).then((res) => res.data.data).catch(() => []),
    ])
      .then(([receipts, stockRow, ledger]) => {
        setSrvs(receipts);
        setStock(stockRow);
        setMoves(ledger || []);
      })
      .finally(() => setLoading(false));
  }, [part]);

  return (
    <Modal
      open={!!part}
      onClose={onClose}
      size="xl"
      title={part ? `${part.part_no} — ${part.part_name}` : ""}
    >
      {part && (
        <div className="space-y-5">
          {onTrace && (
            <button
              type="button"
              onClick={() => onTrace(part)}
              className="w-full rounded-lg border border-slate-200 dark:border-navy-700 px-3 py-2
                text-xs font-medium text-slate-600 dark:text-slate-300 hover:border-toyotared
                hover:text-toyotared transition-colors flex items-center justify-center gap-1.5"
            >
              🔗 Trace this part — supplier to consumption
            </button>
          )}
          <div>
            <h4 className="text-xs font-semibold uppercase text-slate-400 mb-2">Where & How Much</h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6">
              <DetailRow label="Location" value={part.location} />
              <DetailRow
                label="Rework Location"
                value={part.rework_location
                  ? <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full
                      bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">🔁 {part.rework_location}</span>
                  : null}
              />
              <DetailRow label="Minimum Stock" value={num(part.min_stock_level)} />
              <DetailRow label="Reorder Level" value={part.reorder_level == null ? null : num(part.reorder_level)} />
              <DetailRow label="Maximum Stock" value={part.max_stock_level == null ? null : num(part.max_stock_level)} />
              <DetailRow label="Rate" value={part.unit_price == null ? null : money(part.unit_price)} />
              <DetailRow label="UOM" value={part.uom} />
              <DetailRow label="Category" value={part.category} />
              <DetailRow label="Sub Category" value={part.sub_category} />
            </div>
            {/* An uncounted part still says so in words rather than showing a
                zero — "nobody has counted this" and "there are none" are
                different facts, and only one of them is a shortage. */}
            <div className="mt-3 rounded-lg border border-slate-200 dark:border-navy-800 px-3 py-2.5
              flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-[11px] uppercase font-semibold text-slate-400">In Stock</p>
                {stock && stock.qty_on_hand != null ? (
                  <p className="text-lg font-semibold text-slate-800 dark:text-white tabular">
                    {num(stock.qty_on_hand)} <span className="text-xs font-normal text-slate-400">{part.uom || "pcs"}</span>
                  </p>
                ) : (
                  <p className="text-sm text-slate-400">Never counted</p>
                )}
              </div>
              {stock && (
                <div className="text-right">
                  <StockStatus status={stock.status} />
                  <p className="text-[11px] text-slate-400 mt-1">
                    {stock.shortfall != null
                      ? `${num(stock.shortfall)} more to reach the maximum`
                      : stock.last_counted_at
                        ? `Counted ${new Date(stock.last_counted_at).toLocaleDateString()}`
                        : "No count recorded"}
                  </p>
                </div>
              )}
            </div>
          </div>

          {moves.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold uppercase text-slate-400 mb-2">Stock Movement</h4>
              <div className="rounded-lg border border-slate-200 dark:border-navy-800 overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 dark:bg-navy-800 text-slate-500">
                    <tr>
                      <th className="text-left px-2 py-2">When</th>
                      <th className="text-left px-2 py-2">Type</th>
                      <th className="text-right px-2 py-2">Change</th>
                      <th className="text-right px-2 py-2">Balance</th>
                      <th className="text-left px-2 py-2">By</th>
                      <th className="text-left px-2 py-2">Remarks</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-navy-800">
                    {moves.map((m) => (
                      <tr key={m.id}>
                        <td className="px-2 py-2 whitespace-nowrap tabular">
                          {m.at ? new Date(m.at).toLocaleDateString() : "—"}
                        </td>
                        <td className="px-2 py-2">{m.txn_type}</td>
                        <td className={`px-2 py-2 text-right tabular font-medium
                          ${m.qty_delta < 0 ? "text-rose-600 dark:text-rose-400" : "text-emerald-600 dark:text-emerald-400"}`}>
                          {m.qty_delta > 0 ? "+" : ""}{num(m.qty_delta)}
                        </td>
                        <td className="px-2 py-2 text-right tabular">{num(m.balance_after)}</td>
                        <td className="px-2 py-2">{m.created_by || "—"}</td>
                        <td className="px-2 py-2 text-slate-500">{m.remarks || m.reference || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div>
            <h4 className="text-xs font-semibold uppercase text-slate-400 mb-2">Receipt History</h4>
            {loading ? (
              <div className="skeleton h-16 w-full" />
            ) : srvs.length === 0 ? (
              <p className="text-sm text-slate-400">
                No receipts recorded for this part yet — a gate entry from ERP is what fills this in.
              </p>
            ) : (
              <div className="rounded-lg border border-slate-200 dark:border-navy-800 overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 dark:bg-navy-800 text-slate-500">
                    <tr>
                      <th className="text-left px-2 py-2">Received On</th>
                      <th className="text-left px-2 py-2">Supplier</th>
                      <th className="text-left px-2 py-2">Invoice</th>
                      <th className="text-left px-2 py-2">Vehicle</th>
                      <th className="text-right px-2 py-2">Qty</th>
                      <th className="text-left px-2 py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-navy-800">
                    {srvs.map((s) => (
                      <tr key={s.id}>
                        <td className="px-2 py-2 whitespace-nowrap tabular">
                          {s.gate_entry_time ? new Date(s.gate_entry_time).toLocaleString() : "—"}
                        </td>
                        <td className="px-2 py-2">
                          <span className="block">{s.supplier_name || s.vendor_code}</span>
                          {s.supplier_name && <span className="text-[10px] text-slate-400">{s.vendor_code}</span>}
                        </td>
                        <td className="px-2 py-2">{s.invoice_no || "—"}</td>
                        <td className="px-2 py-2">{s.vehicle_no || "—"}</td>
                        <td className="px-2 py-2 text-right tabular">{s.qty_received ?? s.qty_invoiced ?? "—"}</td>
                        <td className="px-2 py-2"><Badge status={s.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

// Stock is fetched apart from the parts list: nothing else on this page needs
// it, and a store with no count yet must still draw the rest of the dashboard
// rather than fail whole. sectionId scopes both calls to one section.
function useSpareStock(sectionId, enabled = true) {
  const [stock, setStock] = useState(null);
  const [belowMin, setBelowMin] = useState([]);
  const [stockRows, setStockRows] = useState([]);

  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    Promise.all([
      spareStockService.summary(STORE_CODE, sectionId).then((r) => r.data.data).catch(() => null),
      spareStockService.belowMinimum(STORE_CODE, 50, sectionId).then((r) => r.data.data).catch(() => []),
      // The full list, for the lists behind each stock figure. The summary and
      // the below-minimum sort stay server-side rather than being recomputed
      // here — the status rules live in one place and this screen reads them.
      spareStockService.list({ store_code: STORE_CODE, section_id: sectionId })
        .then((r) => r.data.data).catch(() => []),
    ]).then(([sum, low, rows]) => {
      if (!live) return;
      setStock(sum);
      setBelowMin(low || []);
      setStockRows(rows || []);
    });
    return () => { live = false; };
  }, [sectionId, enabled]);

  return { stock, belowMin, stockRows };
}

// The store's operational picture: what is moving, what is stuck, what just
// happened. Deliberately store-level and never section-scoped — a section
// screen showing the whole store's receipts would be quoting someone else's
// figures under its own heading.
function useSpareOps(enabled = true) {
  const [ops, setOps] = useState(null);

  const reload = useCallback(() => {
    if (!enabled) return;
    Promise.all([
      spareStockService.today(STORE_CODE).then((r) => r.data.data).catch(() => null),
      spareStockService.flow(STORE_CODE).then((r) => r.data.data).catch(() => null),
      spareStockService.pending(STORE_CODE).then((r) => r.data.data).catch(() => null),
      spareStockService.activity(STORE_CODE, 15).then((r) => r.data.data).catch(() => []),
      spareStockService.excess(STORE_CODE).then((r) => r.data.data).catch(() => []),
      spareStockService.byStatus(STORE_CODE, "Not Counted").then((r) => r.data.data).catch(() => []),
      spareStockService.analytics(STORE_CODE).then((r) => r.data.data).catch(() => null),
      spareStockService.consumption(STORE_CODE).then((r) => r.data.data).catch(() => []),
      spareStockService.consumption(STORE_CODE, "machine").then((r) => r.data.data).catch(() => []),
      spareStockService.consumption(STORE_CODE, "type").then((r) => r.data.data).catch(() => []),
    ]).then(([today, flow, pending, activity, excess, uncounted, analytics, consumption, machineConsumption, typeConsumption]) =>
      setOps({ today, flow, pending, activity, excess, uncounted, analytics, consumption, machineConsumption, typeConsumption }));
  }, [enabled]);

  useEffect(() => { reload(); }, [reload]);
  return ops;
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

const ACTION_TONE = {
  red: "bg-rose-50 dark:bg-rose-500/10 border-rose-200 dark:border-rose-500/30 text-rose-700 dark:text-rose-300",
  amber: "bg-amber-50 dark:bg-amber-500/10 border-amber-200 dark:border-amber-500/30 text-amber-700 dark:text-amber-300",
  orange: "bg-orange-50 dark:bg-orange-500/10 border-orange-200 dark:border-orange-500/30 text-orange-700 dark:text-orange-300",
  blue: "bg-blue-50 dark:bg-blue-500/10 border-blue-200 dark:border-blue-500/30 text-blue-700 dark:text-blue-300",
  violet: "bg-violet-50 dark:bg-violet-500/10 border-violet-200 dark:border-violet-500/30 text-violet-700 dark:text-violet-300",
  slate: "bg-slate-50 dark:bg-navy-800 border-slate-200 dark:border-navy-700 text-slate-600 dark:text-slate-300",
};

// Deliberately louder than a KPI tile: this row is the one a supervisor is
// meant to act on, so the number carries the colour rather than the card
// carrying a chip. A zero stays coloured — "nothing below minimum" is a
// reading worth seeing, not an absence worth greying out.
function ActionTile({ tone, emoji, label, value, hint, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-xl border px-3.5 py-3 text-left transition-all cursor-pointer
        hover:-translate-y-0.5 hover:shadow-card ${ACTION_TONE[tone] || ACTION_TONE.slate}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide truncate">{label}</span>
        <span className="text-sm leading-none shrink-0" aria-hidden="true">{emoji}</span>
      </div>
      <p className="text-2xl font-bold tabular mt-1.5 leading-none">{num(value)}</p>
      <p className="text-[10px] opacity-75 mt-1 truncate">{hint}</p>
    </button>
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

function ClearanceStat({ label, value, tone, onClick }) {
  const tones = {
    amber: "bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-300",
    green: "bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  };
  const Tag = onClick && value > 0 ? "button" : "div";
  return (
    <Tag
      type={onClick && value > 0 ? "button" : undefined}
      onClick={onClick && value > 0 ? onClick : undefined}
      className={`rounded-xl px-3 py-3 text-left ${tones[tone]}
        ${onClick && value > 0 ? "cursor-pointer hover:-translate-y-0.5 transition-transform" : ""}`}
    >
      <p className="text-[11px] font-semibold uppercase tracking-wide opacity-80">{label}</p>
      <p className="text-2xl font-bold tabular mt-1 leading-none">{num(value)}</p>
    </Tag>
  );
}

// One gauge in its own card. `g.pct` of null means the metric has no
// denominator — the ring is left blank and says why, rather than drawing a
// confident 0%.
// Store Analytics gauges: a half-dial with the reading in the mouth of the arc
// and a status pill beneath it, so the colour, the number and a plain word all
// say the same thing at a glance. The pill's word and colour come from the very
// same good/warn/bad logic that colours the arc — never a green ring under a
// "Critical" tag.
const G_GREEN = "#059669";
const G_AMBER = "#f59e0b";
const G_ROSE = "#e11d48";
const SEMI_LEN = Math.PI * 80; // length of a radius-80 semicircle arc

// good / warn / bad from the value, its polarity and any per-gauge band edges —
// the same ramp RadialGauge uses, kept here because these cards draw their own
// half-arc rather than a full ring.
function gaugeTone(pct, polarity, thresholds) {
  if (pct == null) return { key: "none", color: "#cbd5e1" };
  if (polarity === "higher-better") {
    if (pct >= (thresholds?.green ?? 80)) return { key: "good", color: G_GREEN };
    if (pct >= (thresholds?.amber ?? 50)) return { key: "warn", color: G_AMBER };
    return { key: "bad", color: G_ROSE };
  }
  if (pct >= (thresholds?.red ?? 90)) return { key: "bad", color: G_ROSE };
  if (pct >= (thresholds?.amber ?? 70)) return { key: "warn", color: G_AMBER };
  return { key: "good", color: G_GREEN };
}

const DEFAULT_BADGE = { good: "OK", warn: "Watch", bad: "Alert" };

function GaugeCard({ title, emoji, g, polarity, note, empty, thresholds, badges }) {
  const pct = g?.pct ?? null;
  const measured = pct != null;
  const tone = gaugeTone(measured ? pct : null, polarity, thresholds);
  // The arc can only draw up to a full half-dial, so it clamps at 100; the
  // number does not — 145% has to read 145%, not a reassuring 100%.
  const arc = measured ? Math.max(0, Math.min(100, pct)) : 0;
  const shown = measured ? Math.max(0, Math.round(pct)) : null;
  const badge = measured ? (badges?.[tone.key] ?? DEFAULT_BADGE[tone.key]) : null;

  return (
    <div className="card !p-4 flex flex-col items-center text-center">
      <div className="flex items-center gap-1.5 mb-1 min-w-0">
        <span className="text-sm leading-none shrink-0" aria-hidden="true">{emoji}</span>
        <h4 className="text-[12px] font-bold tracking-wide text-slate-700 dark:text-slate-200 truncate">
          {title}
        </h4>
      </div>

      <div className="relative w-full max-w-[190px]" title={note || undefined}>
        <svg viewBox="0 0 200 118" className="w-full"
          role="img" aria-label={measured ? `${title}: ${shown}%` : `${title}: not measurable yet`}>
          <path d="M 20 104 A 80 80 0 0 1 180 104" fill="none" strokeWidth="16" strokeLinecap="round"
            className="stroke-slate-100 dark:stroke-navy-800" />
          {measured && (
            <path d="M 20 104 A 80 80 0 0 1 180 104" fill="none" stroke={tone.color}
              strokeWidth="16" strokeLinecap="round"
              strokeDasharray={`${(arc / 100) * SEMI_LEN} ${SEMI_LEN * 2}`}
              className="transition-[stroke-dasharray] duration-700 ease-enterprise motion-reduce:transition-none" />
          )}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-end pb-1">
          <span className="kpi-value text-[28px] leading-none">{measured ? `${shown}%` : "—"}</span>
          {badge && (
            <span className="mt-1 inline-block rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white"
              style={{ backgroundColor: tone.color }}>
              {badge}
            </span>
          )}
        </div>
      </div>

      <p className="text-[11px] mt-2 text-center leading-tight text-slate-500 dark:text-slate-400">
        {measured ? g?.caption : (empty || "Nothing to measure against yet")}
      </p>
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

// A ledger type, said the way the store says it.
const TXN_LABEL = {
  OPENING: { label: "Opening Count", emoji: "📋", tone: "bg-slate-100 text-slate-600 dark:bg-navy-800 dark:text-slate-300" },
  RECEIPT: { label: "Material Received", emoji: "📥", tone: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300" },
  ISSUE: { label: "Part Issued", emoji: "📤", tone: "bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300" },
  ADJUSTMENT: { label: "Stock Corrected", emoji: "✏️", tone: "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300" },
};

// Times come off the ISO string as stored rather than through the browser's
// timezone — the same reason the vehicle in/out times are read literally.
const fmtStamp = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("en-GB", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
  });
};

// Date-only (gate-entry date carries no time), so fmtStamp's 00:00 is dropped.
const fmtDate = (iso) => {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit", month: "short", year: "numeric",
  });
};

// The ledger mixes ERP gate dates (date-only) with store events (timestamped);
// show each at its own precision.
const fmtWhen = (ts) => (!ts ? "—" : ts.length <= 10 ? fmtDate(ts) : fmtStamp(ts));

// One label per ledger event, said the way the store says it.
const LEDGER_EVENT = {
  GATE_ARRIVAL: { label: "Arrival", emoji: "🚚", tone: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300" },
  RECEIPT: { label: "Received", emoji: "📥", tone: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300" },
  OPENING: { label: "Opening", emoji: "📋", tone: "bg-slate-100 text-slate-600 dark:bg-navy-800 dark:text-slate-300" },
  ISSUE: { label: "Issued", emoji: "📤", tone: "bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300" },
  RETURN: { label: "Returned", emoji: "↩️", tone: "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300" },
  ADJUSTMENT: { label: "Corrected", emoji: "✏️", tone: "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300" },
};

const ACTIVITY_COLUMNS = [
  { key: "at", label: "Time", sortable: true, render: (r) => <span className="tabular">{fmtStamp(r.at)}</span> },
  {
    key: "txn_type", label: "Activity",
    render: (r) => {
      const t = TXN_LABEL[r.txn_type] || { label: r.txn_type, emoji: "•", tone: "bg-slate-100 text-slate-600" };
      return (
        <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap ${t.tone}`}>
          <span aria-hidden="true">{t.emoji}</span>{t.label}
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

// One part's journey. Every step is drawn whether or not it has data — a gap
// in the chain is the answer someone opened this to find, so a step with
// nothing recorded says so instead of being quietly skipped.
function TraceStep({ emoji, label, done, children, last }) {
  return (
    <li className="flex gap-3">
      <div className="flex flex-col items-center shrink-0">
        <span className={`w-8 h-8 rounded-full flex items-center justify-center text-sm
          ${done ? "bg-emerald-50 dark:bg-emerald-500/15" : "bg-slate-100 dark:bg-navy-800"}`}>
          <span className={done ? "" : "opacity-40 grayscale"} aria-hidden="true">{emoji}</span>
        </span>
        {!last && <span className={`w-px flex-1 my-1 ${done ? "bg-emerald-200 dark:bg-emerald-500/30" : "bg-slate-200 dark:bg-navy-700"}`} />}
      </div>
      <div className={`min-w-0 flex-1 ${last ? "" : "pb-4"}`}>
        <p className={`text-xs font-semibold ${done ? "text-slate-700 dark:text-slate-200" : "text-slate-400"}`}>
          {label}
        </p>
        <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">{children}</div>
      </div>
    </li>
  );
}

// "From / To" and "Reference" are each built from several fields, so the ledger
// table, its search, its CSV export and its print view all read them from here.
const ledgerFromTo = (e) =>
  e.direction === "out"
    ? [e.department, e.issued_to, e.machine, e.line].filter(Boolean).join(" · ")
    : [e.supplier_name, e.supplier_code].filter(Boolean).join("  ");
const ledgerRef = (e) => [e.reference, e.invoice_no, e.po_no].filter(Boolean).join(" · ");
const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const LEDGER_COLUMNS = [
  {
    key: "ts", label: "Date", sortable: true, sortValue: (r) => r.ts || "",
    render: (r) => <span className="tabular">{fmtWhen(r.ts)}</span>,
    exportValue: (r) => (r.ts ? fmtWhen(r.ts) : ""),
  },
  {
    key: "kind", label: "Event",
    searchValue: (r) => LEDGER_EVENT[r.kind]?.label || r.kind,
    exportValue: (r) => LEDGER_EVENT[r.kind]?.label || r.kind,
    render: (r) => {
      const ev = LEDGER_EVENT[r.kind] || { label: r.kind, emoji: "•", tone: "bg-slate-100 text-slate-600 dark:bg-navy-800 dark:text-slate-300" };
      return (
        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap ${ev.tone}`}>
          <span aria-hidden="true">{ev.emoji}</span>{ev.label}
        </span>
      );
    },
  },
  {
    key: "qty", label: "In / Out", align: "right", sortable: true, sortValue: (r) => r.qty ?? 0,
    exportValue: (r) => (r.qty == null ? "" : r.qty),
    render: (r) => {
      const q = r.qty == null ? null : Math.abs(r.qty);
      if (q == null) return <span className="text-slate-400">—</span>;
      if (r.direction === "in") return <span className="text-emerald-600 dark:text-emerald-400 font-semibold">+{num(q)}</span>;
      if (r.direction === "out") return <span className="text-rose-600 dark:text-rose-400 font-semibold">−{num(q)}</span>;
      return <span className="text-slate-500 dark:text-slate-300">{num(q)}</span>;
    },
  },
  {
    key: "fromto", label: "From / To",
    searchValue: (r) => ledgerFromTo(r),
    exportValue: (r) => ledgerFromTo(r),
    render: (r) => {
      const ft = ledgerFromTo(r);
      return (
        <div>
          {ft ? <span className="text-slate-600 dark:text-slate-300">{ft}</span> : <span className="text-slate-400">—</span>}
          {r.remarks && <span className="block text-[10px] text-slate-400">{r.remarks}</span>}
        </div>
      );
    },
  },
  {
    key: "ref", label: "Reference",
    searchValue: (r) => ledgerRef(r),
    exportValue: (r) => ledgerRef(r),
    render: (r) => <span className="tabular text-slate-500 dark:text-slate-400">{ledgerRef(r) || "—"}</span>,
  },
  {
    key: "balance_after", label: "Balance", align: "right", sortable: true,
    sortValue: (r) => (r.balance_after ?? null),
    exportValue: (r) => (r.balance_after == null ? "" : r.balance_after),
    render: (r) => (r.balance_after == null ? "—" : num(r.balance_after)),
  },
];

function LedgerStat({ label, value, tone, small }) {
  return (
    <div className="rounded-xl border border-slate-200 dark:border-navy-800 bg-slate-50/60 dark:bg-navy-800/30 px-3 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
      <p className={`${small ? "text-sm" : "text-lg"} font-bold tabular leading-tight ${tone}`}>{value}</p>
    </div>
  );
}

// The part's whole life on one timeline — every arrival, opening, issue, return
// and correction — with a summary, event/date/supplier filters, CSV export and
// a print view. All the standard things a proper history screen carries.
function PartLedger({ ledger, partNo, stock }) {
  const [kind, setKind] = useState("ALL");
  const [vendor, setVendor] = useState("ALL");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const kinds = useMemo(() => [...new Set(ledger.map((e) => e.kind))], [ledger]);
  const vendors = useMemo(
    () => [...new Set(ledger.filter((e) => e.supplier_name).map((e) => e.supplier_name))].sort(),
    [ledger],
  );

  const summary = useMemo(() => {
    let inQty = 0, outQty = 0, lastTs = null;
    const sup = new Set();
    for (const e of ledger) {
      if (e.direction === "in") inQty += Math.abs(e.qty || 0);
      else if (e.direction === "out") outQty += Math.abs(e.qty || 0);
      if (e.supplier_name) sup.add(e.supplier_name);
      if (e.ts && (!lastTs || e.ts > lastTs)) lastTs = e.ts;
    }
    const bal = ledger.find((e) => e.balance_after != null)?.balance_after;
    return { inQty, outQty, suppliers: sup.size, lastTs, balance: bal != null ? bal : (stock?.qty_on_hand ?? null) };
  }, [ledger, stock]);

  const filtered = useMemo(
    () => ledger.filter((e) => {
      if (kind !== "ALL" && e.kind !== kind) return false;
      if (vendor !== "ALL" && e.supplier_name !== vendor) return false;
      const d = (e.ts || "").slice(0, 10);
      if (from && d && d < from) return false;
      if (to && d && d > to) return false;
      return true;
    }),
    [ledger, kind, vendor, from, to],
  );

  const hasFilter = kind !== "ALL" || vendor !== "ALL" || Boolean(from) || Boolean(to);

  const printLedger = () => {
    const w = window.open("", "_blank", "width=900,height=700");
    if (!w) return;
    const body = filtered.map((e) => {
      const q = e.qty == null ? "" : (e.direction === "in" ? "+" : e.direction === "out" ? "−" : "") + num(Math.abs(e.qty));
      return `<tr><td>${escapeHtml(fmtWhen(e.ts))}</td><td>${escapeHtml(LEDGER_EVENT[e.kind]?.label || e.kind)}</td><td style="text-align:right">${q}</td><td>${escapeHtml(ledgerFromTo(e))}</td><td>${escapeHtml(ledgerRef(e))}</td><td style="text-align:right">${e.balance_after == null ? "" : num(e.balance_after)}</td></tr>`;
    }).join("");
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Part Ledger — ${escapeHtml(partNo)}</title>
      <style>body{font-family:system-ui,Arial,sans-serif;margin:24px;color:#111}h2{margin:0 0 2px}p{color:#666;margin:0 0 16px;font-size:12px}
      table{width:100%;border-collapse:collapse;font-size:12px}th,td{border:1px solid #ddd;padding:6px 8px;text-align:left}
      th{background:#f3f4f6}@media print{body{margin:0}}</style></head>
      <body><h2>Part Ledger — ${escapeHtml(partNo)}</h2>
      <p>Received ${num(summary.inQty)} · Issued ${num(summary.outQty)} · Balance ${summary.balance == null ? "—" : num(summary.balance)} · ${filtered.length} entries${hasFilter ? " (filtered)" : ""}</p>
      <table><thead><tr><th>Date</th><th>Event</th><th style="text-align:right">In/Out</th><th>From / To</th><th>Reference</th><th style="text-align:right">Balance</th></tr></thead>
      <tbody>${body}</tbody></table></body></html>`);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 200);
  };

  const chip = (val, label) => (
    <button
      key={val}
      onClick={() => setKind(val)}
      className={`px-2.5 py-1 rounded-full text-[11px] font-semibold transition-colors ${
        kind === val
          ? "bg-toyotared text-white"
          : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-navy-800 dark:text-slate-300 dark:hover:bg-navy-700"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="mt-7 pt-5 border-t border-slate-200 dark:border-navy-700">
      <div className="mb-3">
        <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Part Ledger</h4>
        <p className="text-[11px] text-slate-400">
          {ledger.length > 0
            ? `Every movement of ${partNo} — arrivals, opening, issues and returns on one timeline, newest first`
            : `No movement recorded for ${partNo} yet`}
        </p>
      </div>

      {ledger.length > 0 && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-2.5 mb-4">
            <LedgerStat label="Received" value={num(summary.inQty)} tone="text-emerald-600 dark:text-emerald-400" />
            <LedgerStat label="Issued" value={num(summary.outQty)} tone="text-rose-600 dark:text-rose-400" />
            <LedgerStat label="Balance" value={summary.balance == null ? "—" : num(summary.balance)} tone="text-slate-800 dark:text-white" />
            <LedgerStat label="Suppliers" value={num(summary.suppliers)} tone="text-slate-800 dark:text-white" />
            <LedgerStat label="Last Movement" value={summary.lastTs ? fmtWhen(summary.lastTs) : "—"} tone="text-slate-800 dark:text-white" small />
          </div>

          <div className="flex flex-wrap items-center gap-2 mb-3">
            <div className="flex flex-wrap items-center gap-1.5">
              {chip("ALL", "All")}
              {kinds.map((k) => chip(k, LEDGER_EVENT[k]?.label || k))}
            </div>
            {vendors.length > 0 && (
              <select
                value={vendor}
                onChange={(e) => setVendor(e.target.value)}
                className="input-field py-1.5 text-[13px] max-w-[200px]"
                title="Filter by supplier"
              >
                <option value="ALL">All suppliers</option>
                {vendors.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            )}
            <div className="flex items-center gap-1">
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="input-field py-1.5 text-[13px]" title="From date" />
              <span className="text-slate-400 text-xs">–</span>
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="input-field py-1.5 text-[13px]" title="To date" />
            </div>
            {hasFilter && (
              <button
                onClick={() => { setKind("ALL"); setVendor("ALL"); setFrom(""); setTo(""); }}
                className="btn-secondary py-1.5 text-[13px]"
                title="Clear all filters"
              >
                <X size={14} /> Clear
              </button>
            )}
          </div>

          <Table
            columns={LEDGER_COLUMNS}
            rows={filtered}
            searchable="Search event, supplier, dept, machine, reference…"
            pageSize={15}
            exportName={`part_ledger_${partNo}`}
            emptyMessage={hasFilter ? "No entries match these filters" : "No movement recorded yet"}
            toolbar={
              <button onClick={printLedger} className="btn-secondary py-1.5 text-[13px]" title="Print / save as PDF">
                <Printer size={14} /> Print
              </button>
            }
          />
        </>
      )}
    </div>
  );
}

function Traceability({ part, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!part) return;
    setLoading(true);
    setData(null);
    spareStockService.traceability(part.id)
      .then((r) => setData(r.data.data))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [part]);

  const receipt = data?.receipts?.[0];
  const issues = (data?.movements || []).filter((m) => m.txn_type === "ISSUE");
  const none = <span className="text-slate-400">Nothing recorded</span>;

  return (
    <Modal open={!!part} onClose={onClose} size="xl"
      title={part ? `Traceability — ${part.part_no}` : ""}>
      {loading ? (
        <div className="skeleton h-64 w-full" />
      ) : !data ? (
        <p className="text-sm text-slate-400">Could not load this part&apos;s history.</p>
      ) : (
        <>
        <ol className="pt-1">
          <TraceStep emoji="🏭" label="Supplier"
            done={(data.gate_suppliers?.length > 0) || Boolean(receipt?.supplier_name || data.part.supplier_id)}>
            {data.gate_suppliers?.length > 0 ? (
              <div className="space-y-1">
                {data.gate_suppliers.map((s, i) => (
                  <div key={i} className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-medium text-slate-700 dark:text-slate-200">
                      {s.ven_name || s.ven_cd}
                    </span>
                    {s.ven_cd && <span className="text-slate-400 tabular">{s.ven_cd}</span>}
                    <span className="text-slate-400">
                      · {s.arrivals} arrival{s.arrivals === 1 ? "" : "s"}
                      {s.last_dt ? ` · last ${fmtDate(s.last_dt)}` : ""}
                    </span>
                  </div>
                ))}
                <p className="text-[10px] text-slate-400">
                  {data.gate_suppliers.length > 1
                    ? "Multiple suppliers — read live from ERP gate entries (item_code)"
                    : "From ERP gate entries (item_code) — a part can come from several suppliers"}
                </p>
              </div>
            ) : receipt?.supplier_name ? (
              receipt.supplier_name
            ) : data.part.supplier_id ? (
              `Supplier #${data.part.supplier_id}`
            ) : (
              <span className="text-slate-400">No gate entry recorded for this part yet</span>
            )}
          </TraceStep>
          <TraceStep emoji="🧾" label="Invoice" done={Boolean(receipt?.invoice_no)}>
            {receipt?.invoice_no || none}
          </TraceStep>
          <TraceStep emoji="🚚" label="Gate Entry" done={Boolean(receipt?.gate_entry_time)}>
            {receipt?.gate_entry_time
              ? `${receipt.gate_entry_no || "—"} · ${fmtStamp(receipt.gate_entry_time)}`
              : none}
          </TraceStep>
          <TraceStep emoji="🔍" label="Material Verification" done={Boolean(receipt?.verified_at)}>
            {receipt?.verified_at ? fmtStamp(receipt.verified_at) : none}
          </TraceStep>
          <TraceStep emoji="📝" label="SRV / GRN" done={Boolean(receipt?.srv_created_at)}>
            {receipt?.srv_created_at
              ? `${receipt.srv_no || "—"} · ${fmtStamp(receipt.srv_created_at)}`
              : none}
          </TraceStep>
          <TraceStep emoji="🛠️" label="Engineer Clearance" done={Boolean(receipt?.tool_room_cleared_at)}>
            {receipt?.tool_room_cleared_at
              ? `Tool Room cleared · ${fmtStamp(receipt.tool_room_cleared_at)}`
              : <span className="text-slate-400">
                  Not recorded — Tool Room clearance is captured, Maintenance clearance is not
                </span>}
          </TraceStep>
          <TraceStep emoji="🏬" label="Store Stock" done={data.stock.qty_on_hand != null}>
            {data.stock.qty_on_hand != null
              ? <>In Stock <span className="font-semibold text-slate-700 dark:text-slate-200">{num(data.stock.qty_on_hand)}</span>
                  {data.stock.last_counted_at && ` · counted ${fmtStamp(data.stock.last_counted_at)}`}</>
              : <span className="text-slate-400">Never counted</span>}
          </TraceStep>
          <TraceStep emoji="📤" label="Issued" done={issues.length > 0}>
            {issues.length > 0
              ? `${issues.length} issue${issues.length === 1 ? "" : "s"} · ${num(
                  issues.reduce((s, m) => s + Math.abs(m.qty_delta), 0))} out`
              : none}
          </TraceStep>
          <TraceStep emoji="✅" label="ERP Consumption" done={Boolean(receipt?.consumed_at)} last>
            {receipt?.consumed_at ? fmtStamp(receipt.consumed_at) : none}
          </TraceStep>
        </ol>

        <PartLedger ledger={data.ledger || []} partNo={data.part.part_no} stock={data.stock} />
        </>
      )}
    </Modal>
  );
}

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
          className="w-10 h-10 rounded-lg bg-white/10 hover:bg-white/20 flex items-center justify-center text-2xl leading-none shrink-0">✕</button>
      </div>

      {topValueRows.length > 0 && (
        <div className="card shrink-0">
          <CardHead icon="💎" tone="blue" title="Top 10 by value"
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
            <CardHead icon="📊" tone="violet" title="By status" hint="How this list splits up" />
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

// A stock row is not a part row — it carries part_id, and the detail modal
// needs the part itself. The parent already holds the list, so it resolves.
function SpareDashboard({ stats, loading, onPartClick, onStockClick, stock, belowMin,
  parts = [], stockRows = [], ops = null, onTrace, reorderPlanned = true, onReorderExport }) {
  const [pendingOpen, setPendingOpen] = useState(false);
  const [pendingRows, setPendingRows] = useState([]);

  useEffect(() => {
    if (!pendingOpen) return;
    spareStockService.pendingList(STORE_CODE, "all")
      .then((r) => setPendingRows(r.data.data)).catch(() => setPendingRows([]));
  }, [pendingOpen]);

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

  const deptData = rangedCons ? rangedCons.department : (ops?.consumption || []);
  const machineData = rangedCons ? rangedCons.machine : (ops?.machineConsumption || []);
  const typeData = rangedCons ? rangedCons.type : (ops?.typeConsumption || []);

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
    { key: "department", icon: "🏭", tone: "violet", title: "By Department", pageTitle: "Department-wise", hint: "Share of issues by department", data: deptData, total: consTotal, empty: "Nothing issued in this range" },
    { key: "machine", icon: "⚙️", tone: "green", title: "By Machine", pageTitle: "Machine-wise", hint: "Which machine eats the most spares", data: machineData, total: machineTotal, empty: "No machine recorded yet" },
    { key: "type", icon: "🔩", tone: "amber", title: "By Part Type", pageTitle: "Part-type", hint: "Sensor · Cylinder · Pin · Punch …", data: typeData, total: typeTotal, empty: "No part-type consumption yet" },
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

  const counted = stockRows.filter((r) => r.qty_on_hand != null);
  const byStatus = (status) => stockRows.filter((r) => r.status === status);

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
              Movements since the {new Date(ops?.today?.since || Date.now())
                .toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} shift start
            </p>
          </div>
        </div>
        {/* Four across, two rows — not eight across. At eight the card is
            ~175px, and once the chip takes its column the label truncates to
            "TOT…" and the figure clips. A KPI you cannot read is not a KPI. */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <KpiCard featured tone="blue" label="Total Spare Parts" icon="🔧" value={stats.total}
            onClick={opener(partsDrill("Total Spare Parts", "Every active part in this list", parts, "spares_all"))} />
          <KpiCard featured tone="navy" label="Live Stock" icon="📦" value={stock ? stock.total_qty : 0} unit="pcs"
            hint={stock ? `${num(stock.counted_parts)} of ${num(stock.total_parts)} counted` : ""}
            onClick={opener(stockDrill("Live Stock", "Counted parts and what is on the shelf", counted, "spare_live_stock"))} />
          <KpiCard featured tone="green" label="Stock Value" icon="💰"
            value={compactMoney(stock?.stock_value || null)} valueTitle={money(stock?.stock_value)}
            hint={stock?.valued_parts ? `${num(stock.valued_parts)} carry a rate` : "No rated part counted yet"}
            onClick={opener({
              title: "Stock Value", exportName: "spare_stock_value", onRowClick: onStockClick,
              subtitle: `${money(stock?.stock_value)} across ${num(stock?.valued_parts)} counted parts that carry a rate`,
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
          <KpiCard featured tone="green" label="Today Received" icon="📥"
            value={ops?.today?.received_qty ?? 0} unit="pcs"
            hint={`${ops?.today?.received_lines ?? 0} receipt line${ops?.today?.received_lines === 1 ? "" : "s"}`} />
          <KpiCard featured tone="red" label="Today Issued" icon="📤"
            value={ops?.today?.issued_qty ?? 0} unit="pcs"
            hint={`${ops?.today?.issued_lines ?? 0} issue line${ops?.today?.issued_lines === 1 ? "" : "s"}`} />
        </div>
      </section>

      {/* Master Data has no KPI strip — the same story is told by the charts in
          Coverage & Spread (Parts by Rack, Master Data Completeness, Parts by
          Price), and Total Spares already sits in Store Status above. */}

      {/* ---- Action Required ---- */}
      {ops && stock && (
        <section>
          <div className="mb-3">
            <h3 className="section-title">Action Required</h3>
            <p className="section-hint">Each opens the parts behind it</p>
          </div>
          {/* With nothing counted, four of these five tiles cannot have a
              value — every one of them compares a quantity against Min/Max,
              and there is no quantity. Four zeros beside "481 never counted"
              read as a healthy store, which is the opposite of the truth. So
              until the first count exists, the section says the one thing
              that is actually required. */}
          {stock.counted_parts === 0 ? (
            <div className="card border-amber-200 dark:border-amber-500/30 bg-amber-50/50 dark:bg-amber-500/[0.07]">
              <div className="flex flex-wrap items-center gap-4">
                <span className="text-3xl leading-none" aria-hidden="true">📋</span>
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-slate-800 dark:text-white">
                    No stock has been counted yet
                  </p>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
                    All {num(stock.total_parts)} parts have a Min and Max, but none has a quantity to
                    compare against them — so short, zero and excess cannot be worked out. Upload one
                    opening-stock sheet and this section, the gauges and the whole health view fill in.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setDrill(stockDrill("Never Counted",
                    "No count has ever been recorded — these are not judged against Min/Max",
                    ops.uncounted, "spares_never_counted"))}
                  className="shrink-0 rounded-lg bg-toyotared text-white text-xs font-semibold px-4 py-2.5
                    hover:opacity-90 transition-opacity"
                >
                  See all {num(stock.uncounted_parts)} parts
                </button>
              </div>
            </div>
          ) : (
          <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
            <ActionTile tone="red" emoji="🚨" label="Zero Stock" value={stock.out_of_stock}
              hint="Counted and found empty"
              onClick={() => setDrill(stockDrill("Zero Stock", "Counted, and nothing on the shelf",
                byStatus("Out of Stock"), "spares_zero_stock"))} />
            <ActionTile tone="amber" emoji="⚠️" label="Below Minimum" value={stock.below_minimum}
              hint="Under the minimum — order now"
              onClick={() => setDrill(stockDrill("Below Minimum", "In stock has fallen under the minimum",
                byStatus("Below Minimum"), "spares_below_minimum"))} />
            <ActionTile tone="orange" emoji="🛒" label="Reorder" value={stock.reorder}
              hint="At/below reorder level"
              onClick={() => setDrill(stockDrill("Reorder", "At or below the reorder level — time to order",
                byStatus("Reorder"), "spares_reorder"))} />
            <ActionTile tone="blue" emoji="📈" label="Excess Parts" value={ops.excess.length}
              hint="Money tied up on the shelf"
              onClick={() => setDrill({
                title: "Excess Parts", subtitle: "Above the maximum, furthest over first",
                rows: ops.excess, columns: EXCESS_COLUMNS, onRowClick: onStockClick,
                exportName: "spares_excess",
              })} />
            <ActionTile tone="violet" emoji="📝" label="SRV Pending" value={ops.pending?.total ?? 0}
              hint="Awaiting SRV or engineer clearance"
              onClick={() => setPendingOpen(true)} />
            <ActionTile tone="slate" emoji="❓" label="Never Counted" value={stock.uncounted_parts}
              hint="No stock figure at all yet"
              onClick={() => setDrill(stockDrill("Never Counted",
                "No count has ever been recorded — these are not judged against Min/Max",
                ops.uncounted, "spares_never_counted"))} />
          </div>
          )}
        </section>
      )}

      {/* ---- Gauges: every percentage the store is judged on, in one band ---- */}
      {ops?.analytics && (
        <section>
          <div className="mb-3">
            <h3 className="section-title">Store Analytics</h3>
            <p className="section-hint">
              Store capacity · inventory health · reorder focus — the colour, the number and the pill all say the same thing
            </p>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {/* Master-data coverage (ever-counted, Min-Max, Planning) isn't a
                gauge here — a spares store counts physically only at the
                quarterly stocktake, so those figures sit at a flat ~100% and
                say nothing day to day. The Master Data Completeness section
                below carries the gaps and opens the missing parts. */}
            <GaugeCard title="Capacity Used" emoji="📦" g={ops.analytics.gauges.stock_utilisation}
              polarity="higher-worse" note="How full the store is against its max limit — over 100% means more in stock than the max says to hold"
              badges={{ good: "OK", warn: "High", bad: "Over Limit" }} />
            <GaugeCard title="Inventory Health" emoji="🩺" g={ops.analytics.gauges.inventory_health}
              polarity="higher-better" note="Counted parts sitting inside Min/Max"
              badges={{ good: "Healthy", warn: "Fair", bad: "Low" }} />
            <GaugeCard title="Critical Parts" emoji="🚨" g={ops.analytics.gauges.critical_parts}
              polarity="higher-worse" note="Below minimum or empty"
              badges={{ good: "OK", warn: "Elevated", bad: "Critical" }} />
            {/* Tighter bands than the default 70/90: a store where a large
                share of parts sit over their maximum is money tied up, so it
                should read amber past 40% and red past 60%, not calm green —
                and line up with Capacity Used rather than contradict it. */}
            <GaugeCard title="Excess Stock" emoji="📈" g={ops.analytics.gauges.excess_stock}
              polarity="higher-worse" note="Counted parts above maximum"
              thresholds={{ amber: 40, red: 60 }}
              badges={{ good: "OK", warn: "Watch", bad: "High" }} />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-4">
            <div className="card">
              <CardHead icon="🍩" tone="green" title="Inventory Status Distribution"
                hint="Counted parts, by how they sit against Min/Max" />
              <DonutChart
                data={ops.analytics.status_distribution}
                colors={{
                  "Healthy": "#10b981", "Below Minimum": "#f59e0b", "Reorder": "#f97316",
                  "Above Maximum": "#3b82f6", "Zero Stock": "#f43f5e",
                }}
                size={128}
                centerValue={num(ops.analytics.counted_parts)}
                centerLabel="counted parts"
                emptyMessage="No part has been counted yet"
                onSliceClick={(d) => setDrill(stockDrill(d.name,
                  `Counted parts reading ${d.name.toLowerCase()}`,
                  byStatus(d.name === "Zero Stock" ? "Out of Stock" : d.name),
                  `spares_${d.name.toLowerCase().replace(/\s+/g, "_")}`))}
              />
            </div>

            <div className="card">
              <CardHead icon="💰" tone="amber" title="Stock Value Distribution"
                hint="Where the money on the shelf is sitting" />
              <DonutChart
                data={ops.analytics.value_distribution}
                colors={{ "Normal Stock": "#10b981", "Critical Stock": "#f43f5e", "Excess Stock": "#3b82f6" }}
                size={128}
                centerValue={compactMoney(ops.analytics.total_value || null)}
                centerLabel="total stock value"
                emptyMessage="No counted part carries a rate yet"
              />
            </div>

            {/* Min · Current · Max moved here from Inventory Health, which is
                where the status donut already lives. The two together are the
                whole stock picture; apart, each half repeated the other. */}
            <div className="card">
              <CardHead icon="📊" tone="blue" title="Min · Current · Max"
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

      {/* ---- SRV / engineer clearance ---- */}
      {ops?.pending && (
        <section>
          <div className="mb-3">
            <h3 className="section-title">SRV · Engineer Clearance</h3>
            <p className="section-hint">Material waiting on Maintenance and Tool Room</p>
          </div>
          {/* One card, two halves — Tool Room and Maintenance side by side, each
              showing how many SRVs' quality clearance is pending at that end. */}
          <div className="card">
            <CardHead icon="🧪" tone="violet" title="Pending Quality Clearance"
              hint="SRVs waiting on the engineer's quality check after SRV making" />
            <div className="grid grid-cols-2 gap-3">
              <ClearanceStat label="Tool Room" value={ops.pending.tool_room.pending} tone="amber"
                onClick={() => setPendingOpen(true)} />
              {/* An SRV has no Maintenance clearance field yet, so this half stays
                  honestly blank until that data exists. */}
              <div className="rounded-xl px-3 py-3 text-left bg-violet-50 dark:bg-violet-500/10 text-violet-700 dark:text-violet-300">
                <p className="text-[11px] font-semibold uppercase tracking-wide opacity-80">Maintenance</p>
                <p className="text-2xl font-bold tabular mt-1 leading-none">
                  {ops.pending.maintenance?.pending != null ? num(ops.pending.maintenance.pending) : "—"}
                </p>
                {ops.pending.maintenance?.pending == null && (
                  <p className="text-[10px] opacity-70 mt-1 normal-case font-normal">not tracked on the SRV yet</p>
                )}
              </div>
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
                ⬇ Excel (section &amp; category-wise, with order qty)
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
              pageSize={belowMin.length > 25 ? 25 : 0}
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
      {ops && (
        <section>
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="section-title">Consumption</h3>
              <p className="text-xs font-medium text-slate-400 dark:text-slate-500">Spare Parts Store Analytics · {consRangeTitle}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              {/* Filter purely by a calendar From–To range; clear it (✕) for
                  all-time. It scopes every chart, the drill and the Excel. */}
              <div className={`inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 ${custom ? "border-toyotared bg-toyotared/5" : "border-slate-200 dark:border-navy-700"}`}>
                <span className="text-[15px]" aria-hidden="true">📅</span>
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
                    className="text-slate-400 hover:text-toyotared text-sm leading-none px-0.5">✕</button>
                )}
              </div>
              <button className="btn-secondary shrink-0"
                onClick={() => downloadFile(
                  "/spare-stock/consumption/export",
                  `spare_consumption_${custom ? `${consFrom}_${consTo}` : "all"}.xlsx`,
                  { store_code: STORE_CODE, from: qFrom, to: qTo },
                )}>
                ⬇ Excel
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
          <h3 className="section-title">Coverage & Spread</h3>
          <p className="section-hint">Planning, racks and rates</p>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* A ring with the count in the middle rather than bars: with three
              racks this is a composition — what share of the store sits where —
              and the total belongs in the hole, not in a separate line. */}
          <div className="card">
            <CardHead icon="📍" tone="blue" title="Parts by Rack" hint="Where the spares physically live" />
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
            <CardHead icon="✅" tone="green" title="Master Data Completeness"
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
            <CardHead icon="💰" tone="green" title="Parts by Price" hint="Grouped by unit price" />
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
      {ops && (
        <section>
          <div className="mb-3">
            <h3 className="section-title">Recent Activity</h3>
            <p className="section-hint">Every movement recorded against this store&apos;s stock</p>
          </div>
          <div className="card">
            {ops.activity.length === 0 ? (
              <NotCaptured
                what="Nothing has moved yet"
                needs="Every opening count, receipt, issue and correction writes a ledger row and appears here with its time, part, quantity and who did it."
                endpoint="GET /spare-stock/activity"
              />
            ) : (
              <Table
                columns={ACTIVITY_COLUMNS}
                rows={ops.activity}
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
              ⬇ Excel
            </button>
            <button onClick={() => setConsDrill(null)} title="Close"
              className="w-10 h-10 rounded-lg bg-white/10 hover:bg-white/20 flex items-center justify-center text-2xl leading-none shrink-0">✕</button>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="card">
              <CardHead icon={consFocus.icon} tone={consFocus.tone} title={consFocus.title} hint={consFocus.hint} />
              <DonutChart data={consFocus.data} colors={consColors(consFocus.data)} size={150}
                centerValue={num(consFocus.total)} centerLabel="pcs" emptyMessage={consFocus.empty} />
            </div>
            <div className="card">
              <CardHead icon="📈" tone="blue" title="Consumption Trend"
                hint={custom ? `Daily issued qty · ${consRangeTitle}` : "Daily issued qty · last 90 days"} />
              {consDetailLoading
                ? <div className="h-56 flex items-center justify-center"><div className="skeleton h-40 w-full rounded-xl" /></div>
                : <TrendArea data={trendData} />}
            </div>
          </div>

          <div className="card">
            <div className="flex items-start justify-between gap-2">
              <CardHead icon="📋" tone="violet" title="Consumed parts — by quantity"
                hint="Ranked by quantity issued, labelled with the part description" />
              <button className="btn-secondary py-1.5 text-[13px] shrink-0"
                onClick={() => downloadXlsx(
                  `spare_consumed_${custom ? `${consFrom}_${consTo}` : "all"}`,
                  ["Part No", "Description", "Qty Issued"],
                  consumedParts.map((p) => [p.part_no, p.part_name || "", Number(p.qty) || 0]),
                  "Consumed",
                )}>
                ⬇ Excel (full list)
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

      {/* SRV lines waiting on an SRV being raised or on an engineer. */}
      <Modal open={pendingOpen} onClose={() => setPendingOpen(false)} size="full"
        title="SRV Pending">
        <div className="space-y-3">
          <p className="text-xs text-slate-400 -mt-1">
            Arrived but no SRV raised, or the SRV is with an engineer for clearance
          </p>
          {pendingRows.length === 0 ? (
            <NotCaptured
              what="No inbound line is waiting"
              needs="Gate entry and SRV lines for this store appear here as soon as ERP pushes them. No gate entry has been recorded against a spare part yet."
              endpoint="GET /spare-stock/pending/list"
            />
          ) : (
            <Table columns={PENDING_COLUMNS} rows={pendingRows} pageSize={0} maxHeight="60vh"
              searchable={pendingRows.length > 10 ? "Search SRV, part or supplier…" : false}
              exportName="spares_srv_pending" emptyMessage="Nothing pending" />
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
          🔁 {r.rework_location}
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
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [tracing, setTracing] = useState(null);

  useEffect(() => {
    setLoading(true);
    fetchAllParts({ store_code: STORE_CODE, section_id: section.id, is_active: true })
      .then(setRows)
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [section.id]);

  const stats = useStoreStats(rows);
  const { stock, belowMin, stockRows } = useSpareStock(section.id);
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
        loading={loading}
        onPartClick={setSelected}
        onStockClick={(row) => setSelected(rows.find((p) => p.id === row.part_id) || null)}
        stock={stock}
        belowMin={belowMin}
        parts={rows}
        stockRows={stockRows}
        reorderPlanned={reorderPlanned}
      />

      {/* "All Parts" table removed — the Master Data "Total Spares" card already
          drills to this same full list, so a second copy below was redundant. */}

      <SparePartDetail
        part={selected}
        onClose={() => setSelected(null)}
        onTrace={(p) => { setSelected(null); setTracing(p); }}
      />
      <Traceability part={tracing} onClose={() => setTracing(null)} />
    </div>
  );
}

export default function MaintenanceStore() {
  const { sectionId } = useParams();
  const navigate = useNavigate();
  const [sections, setSections] = useState([]);
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    storeService.sections(STORE_CODE).then((res) => res.data.data).catch(() => []).then(setSections);
  }, []);

  // Skipped when a section is open: this component still runs its hooks before
  // handing off to SectionDetail, and the store-wide figures would go unused.
  const { stock, belowMin, stockRows } = useSpareStock(undefined, !sectionId);
  // `parts` is derived from the stock list rather than fetched separately — the
  // stock rows already carry every part field (plus on-hand / status / value),
  // so pulling the ~4,800-row part master a SECOND time on load was pure
  // duplicate payload. `id` is aliased from part_id so the detail modal and the
  // drills (which resolve a part by id) keep working unchanged.
  const parts = useMemo(() => stockRows.map((r) => ({ ...r, id: r.part_id })), [stockRows]);
  const stats = useStoreStats(parts);
  const loading = !sectionId && stock == null;
  // Operational data is the whole store's, so it is fetched only for the store
  // dashboard — a section screen must not show it as if it were its own.
  const ops = useSpareOps(!sectionId);
  const [tracing, setTracing] = useState(null);

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
        loading={loading}
        onPartClick={setSelected}
        onStockClick={(row) => setSelected(parts.find((p) => p.id === row.part_id) || null)}
        stock={stock}
        belowMin={belowMin}
        parts={parts}
        stockRows={stockRows}
        ops={ops}
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
              ⬇ Excel (section &amp; category-wise, with order qty)
            </button>
            <button className="btn-primary" onClick={() => setReorderPopup(false)}>Got it</button>
          </div>
        }
      >
        <div className="-mx-5 -mt-4 mb-4 px-5 py-4 text-white"
          style={{ background: "linear-gradient(120deg,#8f0713 0%,#eb0a1e 55%,#ff6a3d 100%)" }}>
          <div className="flex items-center gap-3">
            <span className="w-12 h-12 rounded-2xl bg-white/15 flex items-center justify-center text-2xl shrink-0">⚠️</span>
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

      <SparePartDetail
        part={selected}
        onClose={() => setSelected(null)}
        onTrace={(p) => { setSelected(null); setTracing(p); }}
      />
      <Traceability part={tracing} onClose={() => setTracing(null)} />
    </div>
  );
}
