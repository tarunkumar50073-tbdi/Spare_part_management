import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import Badge from "../components/Badge.jsx";
import CardHead from "../components/CardHead.jsx";
import DonutChart from "../components/DonutChart.jsx";
import HorizontalBars from "../components/HorizontalBars.jsx";
import KpiCard from "../components/KpiCard.jsx";
import Modal from "../components/Modal.jsx";
import NotCaptured from "../components/NotCaptured.jsx";
import ProcessFlow from "../components/ProcessFlow.jsx";
import RadialGauge from "../components/RadialGauge.jsx";
import Table from "../components/Table.jsx";
import { storeService } from "../services/storeService.js";
import { partService } from "../services/partService.js";
import { spareStockService } from "../services/spareStockService.js";
import { srvService } from "../services/srvService.js";

const STORE_CODE = "MAINTENANCE";

// A glyph per section, matched on its name so a section added later still
// gets one without a code change. Emoji rather than an icon set, to stay with
// the vocabulary the sidebar and the KPI cards already use.
const SECTION_EMOJI = [
  [/press/i, "🔨"],
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
// the same rows the table shows. per_page is capped at 200 server-side, so
// asking for 1000 silently returned 200 of the 485 press-shop parts and the
// screen looked complete while a third of the list was missing.
const PER_PAGE = 200;

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
      dearest: [...rated]
        .sort((a, b) => Number(b.unit_price) - Number(a.unit_price))
        .slice(0, 8),
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
                <p className="text-[11px] uppercase font-semibold text-slate-400">On Hand</p>
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
    ]).then(([today, flow, pending, activity, excess, uncounted, analytics, consumption, machineConsumption]) =>
      setOps({ today, flow, pending, activity, excess, uncounted, analytics, consumption, machineConsumption }));
  }, [enabled]);

  useEffect(() => { reload(); }, [reload]);
  return ops;
}

const STOCK_STATUS_TONE = {
  "Out of Stock": "bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300",
  "Below Minimum": "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300",
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
  { key: "qty_on_hand", label: "On Hand", sortable: true, align: "right", render: (r) => num(r.qty_on_hand) },
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
const FLOW_EMOJI = ["🚚", "📥", "🔍", "📝", "🛠️", "🏬", "🏭"];

const ACTION_TONE = {
  red: "bg-rose-50 dark:bg-rose-500/10 border-rose-200 dark:border-rose-500/30 text-rose-700 dark:text-rose-300",
  amber: "bg-amber-50 dark:bg-amber-500/10 border-amber-200 dark:border-amber-500/30 text-amber-700 dark:text-amber-300",
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
function GaugeCard({ title, emoji, g, polarity, note, empty }) {
  return (
    <div className="card !p-4 flex flex-col items-center text-center">
      <div className="flex items-center gap-1.5 mb-2 min-w-0">
        <span className="text-sm leading-none shrink-0" aria-hidden="true">{emoji}</span>
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 truncate">
          {title}
        </h4>
      </div>
      <RadialGauge
        value={g?.pct ?? null}
        size={104}
        thickness={11}
        polarity={polarity}
        caption={g?.caption}
        tooltip={note}
        emptyNote={empty || "Nothing to measure against yet"}
      />
    </div>
  );
}

const EXCESS_COLUMNS = [
  { key: "part_no", label: "Part No", sortable: true },
  { key: "part_name", label: "Description", sortable: true },
  { key: "location", label: "Location", render: (r) => r.location || "—" },
  { key: "qty_on_hand", label: "Current", sortable: true, align: "right", render: (r) => num(r.qty_on_hand) },
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
  { key: "qty_on_hand", label: "On Hand", sortable: true, align: "right", render: (r) => num(r.qty_on_hand) },
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
        <ol className="pt-1">
          <TraceStep emoji="🏭" label="Supplier" done={Boolean(receipt?.supplier_name || data.part.supplier_id)}>
            {receipt?.supplier_name || (data.part.supplier_id
              ? `Supplier #${data.part.supplier_id}`
              : <span className="text-slate-400">No supplier mapped to this part yet</span>)}
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
              ? <>On hand <span className="font-semibold text-slate-700 dark:text-slate-200">{num(data.stock.qty_on_hand)}</span>
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
      )}
    </Modal>
  );
}

// A shelf count is not a part count: "448 shelf locations" opens the shelves,
// with how many parts sit on each, or the list would not add up to the figure
// that was clicked.
const LOCATION_COLUMNS = [
  { key: "location", label: "Location", sortable: true },
  { key: "rack", label: "Rack", sortable: true },
  { key: "parts", label: "Parts", sortable: true, align: "right", render: (r) => num(r.parts) },
];

// Every headline figure opens the list behind it. A KPI you cannot open is a
// number the floor has to take on trust — and the first question anyone asks
// about "3 below minimum" is which three.
function DrillDown({ drill, onClose }) {
  return (
    <Modal open={!!drill} onClose={onClose} size="full" title={drill ? drill.title : ""}>
      {drill && (
        <div className="space-y-3">
          {drill.subtitle && (
            <p className="text-xs text-slate-400 -mt-1">
              {drill.subtitle}
              <span className="ml-1.5 font-semibold text-slate-500 dark:text-slate-300">
                · {num(drill.rows.length)} row{drill.rows.length === 1 ? "" : "s"}
              </span>
            </p>
          )}
          <Table
            columns={drill.columns}
            rows={drill.rows}
            // Opening a part closes this list rather than stacking a second
            // dialog over it — two modals deep, Escape stops meaning anything.
            onRowClick={drill.onRowClick && ((row) => { onClose(); drill.onRowClick(row); })}
            searchable={drill.rows.length > 10 ? "Search this list…" : false}
            // No paging: the whole list is here and scrolls under a pinned
            // header. Twenty pages of 25 is not a list anyone reads — it is a
            // list you give up on halfway through.
            pageSize={0}
            maxHeight="60vh"
            exportName={drill.exportName}
            emptyMessage="Nothing in this list — the figure is zero"
          />
        </div>
      )}
    </Modal>
  );
}

// A stock row is not a part row — it carries part_id, and the detail modal
// needs the part itself. The parent already holds the list, so it resolves.
function SpareDashboard({ stats, loading, totalHint, onPartClick, onStockClick, stock, belowMin,
  parts = [], stockRows = [], ops = null, onTrace }) {
  const [pendingOpen, setPendingOpen] = useState(false);
  const [pendingRows, setPendingRows] = useState([]);

  useEffect(() => {
    if (!pendingOpen) return;
    spareStockService.pendingList(STORE_CODE, "all")
      .then((r) => setPendingRows(r.data.data)).catch(() => setPendingRows([]));
  }, [pendingOpen]);

  const plannedPct = stats.total ? Math.round((stats.planned / stats.total) * 100) : 0;
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

  // Shelves with what sits on each — the list behind the location count.
  const shelves = useMemo(() => {
    const by = {};
    parts.forEach((p) => {
      if (!p.location) return;
      by[p.location] = (by[p.location] || 0) + 1;
    });
    return Object.entries(by)
      .map(([location, count]) => ({ location, rack: rackOf(location) || "—", parts: count }))
      .sort((a, b) => b.parts - a.parts || a.location.localeCompare(b.location));
  }, [parts]);

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
  // Issued quantity per part, off the ledger. Real usage, not a forecast —
  // and only as deep as the activity feed goes, which is why the card says
  // what it is measuring rather than calling itself a trend.
  const consumptionByPart = useMemo(() => {
    const by = {};
    (ops?.activity || []).forEach((a) => {
      if (a.txn_type !== "ISSUE" || !a.part_no) return;
      by[a.part_no] = (by[a.part_no] || 0) + Math.abs(a.qty_delta);
    });
    return Object.entries(by)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8);
  }, [ops]);

  const bandRows = useMemo(() => {
    const severity = { "Out of Stock": 0, "Below Minimum": 1, "Above Maximum": 2, "Healthy": 3 };
    return [...counted]
      .sort((a, b) => (severity[a.status] ?? 9) - (severity[b.status] ?? 9)
        || (b.unit_price || 0) - (a.unit_price || 0))
      .slice(0, 6);
  }, [stockRows]);

  // The dearest parts, with what is actually on the shelf against them. The
  // rate alone said which parts matter; the stock beside it says which of
  // those are currently a problem.
  const dearest = useMemo(() => {
    const byPart = Object.fromEntries(stockRows.map((r) => [r.part_id, r]));
    return stats.dearest.map((p) => ({
      ...p,
      qty_on_hand: byPart[p.id]?.qty_on_hand ?? null,
      status: byPart[p.id]?.status || "Not Counted",
      stock_value: byPart[p.id]?.stock_value ?? null,
    }));
  }, [stats.dearest, stockRows]);

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

  const flowStages = ops?.flow ? FLOW_EMOJI.map((e, i) => ({
    ...ops.flow.stages[i], emoji: e,
    tone: ["gate_entry", "received", "verified", "srv_created", "with_engineer"].includes(
      ops.flow.stages[i]?.key) ? "waiting" : ops.flow.stages[i]?.key === "in_store" ? "active" : "done",
  })).filter((s) => s.key) : [];

  return (
    <>
      {/* ---- Operational KPIs: what the store is doing right now ---- */}
      {ops && (
        <section>
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <h3 className="section-title">Store Status</h3>
              <p className="section-hint">
                Movements since the {new Date(ops.today?.since || Date.now())
                  .toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} shift start
              </p>
            </div>
          </div>
          {/* Four across, two rows — not eight across. At eight the card is
              ~175px, and once the chip takes its column the label truncates to
              "TOT…" and the figure clips. A KPI you cannot read is not a KPI. */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <KpiCard featured tone="blue" label="Total Spare Parts" icon="🔧" value={stats.total} loading={loading}
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
              })} />
            {/* Below Minimum, Above Maximum and SRV Pending are not repeated
                here — they are the Action Required tiles below, where they can
                be acted on. This row is the store's headline flow and value. */}
            <KpiCard featured tone="green" label="Today Received" icon="📥"
              value={ops.today?.received_qty ?? 0} unit="pcs"
              hint={`${ops.today?.received_lines ?? 0} receipt line${ops.today?.received_lines === 1 ? "" : "s"}`} />
            <KpiCard featured tone="red" label="Today Issued" icon="📤"
              value={ops.today?.issued_qty ?? 0} unit="pcs"
              hint={`${ops.today?.issued_lines ?? 0} issue line${ops.today?.issued_lines === 1 ? "" : "s"}`} />
          </div>
        </section>
      )}

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
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <ActionTile tone="red" emoji="🚨" label="Zero Stock" value={stock.out_of_stock}
              hint="Counted and found empty"
              onClick={() => setDrill(stockDrill("Zero Stock", "Counted, and nothing on the shelf",
                byStatus("Out of Stock"), "spares_zero_stock"))} />
            <ActionTile tone="amber" emoji="⚠️" label="Below Minimum" value={stock.below_minimum}
              hint="Reorder before they run out"
              onClick={() => setDrill(stockDrill("Below Minimum", "On hand has fallen under the minimum",
                byStatus("Below Minimum"), "spares_below_minimum"))} />
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

      {/* ---- Material flow: where inbound material is sitting ---- */}
      {ops?.flow && (
        <section>
          <div className="mb-3">
            <h3 className="section-title">Material Flow</h3>
            <p className="section-hint">
              Gate entry through to ERP consumption
              {ops.flow.srv_total === 0 && " — no gate entry has been recorded for this store yet"}
            </p>
          </div>
          <div className="card">
            <ProcessFlow stages={flowStages}
              onStageClick={(s) => s.source === "srv" && setPendingOpen(true)} />
            <p className="text-[11px] text-slate-400 mt-3 pt-3 border-t border-slate-100 dark:border-navy-800">
              Store Stock counts parts with a counted quantity; the rest read SRV lines.
              Issue and ERP consumption fill in once material starts being issued.
            </p>
          </div>
        </section>
      )}

      {/* ---- Gauges: every percentage the store is judged on, in one band ---- */}
      {ops?.analytics && (
        <section>
          <div className="mb-3">
            <h3 className="section-title">Store Analytics</h3>
            <p className="section-hint">
              Percentages worked out server-side — a ring with no denominator stays blank rather than reading 0%
            </p>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3">
            <GaugeCard title="Stock Utilisation" emoji="📦" g={ops.analytics.gauges.stock_utilisation}
              polarity="higher-worse" note="On hand against planned maximum" />
            <GaugeCard title="Inventory Health" emoji="🩺" g={ops.analytics.gauges.inventory_health}
              polarity="higher-better" note="Counted parts sitting inside Min/Max" />
            {/* Min-Max and Planning coverage live in Master Data Completeness
                below, which shows all three master-data gaps together and
                opens the missing parts. Repeating them as gauges said the same
                thing twice in two shapes. */}
            <GaugeCard title="Stock Counted" emoji="🔢" g={ops.analytics.gauges.stock_counted}
              polarity="higher-better" note="Share of the list ever counted" />
            <GaugeCard title="Critical Parts" emoji="🚨" g={ops.analytics.gauges.critical_parts}
              polarity="higher-worse" note="Below minimum or empty" />
            <GaugeCard title="Excess Stock" emoji="📈" g={ops.analytics.gauges.excess_stock}
              polarity="higher-worse" note="Counted parts above maximum" />
            <GaugeCard title="SRV Clearance" emoji="🛠️"
              g={{
                pct: ops.analytics.srv_clearance?.pct,
                caption: ops.analytics.srv_clearance
                  ? `${ops.analytics.srv_clearance.pending} pending · ${ops.analytics.srv_clearance.cleared} cleared`
                  : null,
              }}
              polarity="higher-better"
              note="Maintenance / Tool Room engineer clearance"
              empty="No SRV has reached clearance yet" />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-4">
            <div className="card">
              <CardHead icon="🍩" tone="green" title="Inventory Status Distribution"
                hint="Counted parts, by how they sit against Min/Max" />
              <DonutChart
                data={ops.analytics.status_distribution}
                colors={{
                  "Healthy": "#10b981", "Below Minimum": "#f59e0b",
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
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="card">
              <CardHead icon="🛠️" tone="blue" title="Tool Room"
                hint="Forwarded to the Tool Room engineer" />
              <div className="grid grid-cols-2 gap-3">
                <ClearanceStat label="Pending" value={ops.pending.tool_room.pending} tone="amber"
                  onClick={() => setPendingOpen(true)} />
                <ClearanceStat label="Cleared" value={ops.pending.tool_room.cleared} tone="green" />
              </div>
            </div>
            <div className="card">
              <CardHead icon="🔧" tone="violet" title="Maintenance"
                hint="Forwarded to the Maintenance engineer" />
              <NotCaptured
                what="Maintenance clearance is not recorded yet"
                needs="An SRV carries a Tool Room forward and clearance timestamp but has no Maintenance equivalent, so pending and cleared cannot be split out. Adding those two fields fills this card from the same data."
                endpoint="GET /spare-stock/pending → pending.maintenance"
              />
            </div>
          </div>
        </section>
      )}

      {belowMin && belowMin.length > 0 && (
        <section>
          <div className="mb-3">
            <h3 className="section-title">Needs Reordering</h3>
            <p className="section-hint">Out of stock first, then furthest below its minimum</p>
          </div>
          <div className="card">
            <Table
              columns={BELOW_MIN_COLUMNS}
              rows={belowMin}
              onRowClick={onStockClick}
              searchable={belowMin.length > 10 ? "Search part no or description…" : false}
              pageSize={belowMin.length > 25 ? 25 : 0}
              exportName="spares_below_minimum"
              emptyMessage="Nothing below its minimum"
            />
          </div>
        </section>
      )}

      {/* ---- Excess: which parts are tying money up, not just how many ---- */}
      {ops && ops.excess.length > 0 && (
        <section>
          <div className="mb-3">
            {/* Named for the parts, not the metric — "Excess Stock" is the
                gauge above, and two things with one name read as a repeat. */}
            <h3 className="section-title">Excess Parts — which ones</h3>
            <p className="section-hint">Above maximum, furthest over first, with the value tied up</p>
          </div>
          <div className="card">
            <Table
              columns={EXCESS_COLUMNS}
              rows={ops.excess}
              onRowClick={onStockClick}
              searchable={ops.excess.length > 10 ? "Search part no or description…" : false}
              pageSize={0}
              maxHeight={ops.excess.length > 12 ? "45vh" : ""}
              exportName="spares_excess"
              emptyMessage="Nothing above its maximum"
            />
          </div>
        </section>
      )}

      {/* ---- Consumption: laid out and waiting on a capture point ---- */}
      {ops && (
        <section>
          <div className="mb-3">
            <h3 className="section-title">Consumption</h3>
            <p className="section-hint">By department, and over time</p>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="card">
              <CardHead icon="🏭" tone="violet" title="Department-wise Consumption"
                hint="Press Shop · Maintenance · Tool Room" />
              {ops.consumption && ops.consumption.length > 0 ? (
                <HorizontalBars
                  data={ops.consumption}
                  color="#8b5cf6"
                  emptyMessage="Nothing issued yet"
                />
              ) : (
                <NotCaptured
                  what="Nothing has been issued yet"
                  needs="Issue a spare to a department from the Store Stock screen (the Issue button on each part). Each issue is tagged with its department, so this splits the total by Press Shop / Maintenance / Tool Room."
                  endpoint="GET /spare-stock/consumption?group_by=department"
                />
              )}
            </div>
            <div className="card">
              <CardHead icon="⚙️" tone="green" title="Machine-wise Consumption"
                hint="Which machine eats the most spares" />
              {ops.machineConsumption && ops.machineConsumption.length > 0 ? (
                <HorizontalBars data={ops.machineConsumption} color="#0f8d7e" emptyMessage="Nothing issued yet" />
              ) : (
                <NotCaptured
                  what="No machine recorded yet"
                  needs="Issue a spare from Store Stock and type the machine it was fitted on — this ranks machines by spares consumed, so the heaviest-consuming machine (often the one needing attention) stands out."
                  endpoint="GET /spare-stock/consumption?group_by=machine"
                />
              )}
            </div>
            <div className="card">
              <CardHead icon="📉" tone="blue" title="Consumption Trend"
                hint="Daily, weekly and monthly usage" />
              {ops.activity.some((a) => a.txn_type === "ISSUE") ? (
                <HorizontalBars
                  data={consumptionByPart}
                  color="#6366f1"
                  emptyMessage="Nothing issued yet"
                  onBarClick={(d) => {
                    const row = stockRows.find((r) => r.part_no === d.name);
                    if (row && onStockClick) onStockClick(row);
                  }}
                />
              ) : (
                <NotCaptured
                  what="Nothing has been issued yet"
                  needs="The ledger already records every ISSUE with its quantity and date, so this chart fills itself as soon as parts start being issued from the store."
                  endpoint="GET /spare-stock/activity"
                />
              )}
            </div>
          </div>
        </section>
      )}

      {/* Master data, not operations — it sits below the operational bands so
          the top of the page stays about what the store is doing today. */}
      <section>
        <div className="mb-3">
          <h3 className="section-title">Master Data</h3>
          <p className="section-hint">What the list itself carries</p>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <KpiCard featured tone="blue" label="Total Spares" icon="🔧" value={stats.total} loading={loading} hint={totalHint}
            onClick={opener(partsDrill("Total Spares", `Every active part in this list`, parts, "spares_all"))} />
          <KpiCard featured label="Min/Max Planned" icon="📋" tone={plannedPct < 50 ? "amber" : "green"}
            value={stats.planned} unit={`of ${stats.total}`} loading={loading}
            hint={`${stats.unplanned} still without a maximum`}
            onClick={opener(partsDrill("Min/Max Planned",
              "Parts with a maximum set — these are the ones that can be reordered against",
              parts.filter((p) => Number(p.max_stock_level || 0) > 0), "spares_planned"))} />
          <KpiCard featured tone="amber" label="Rework Parts" icon="🔁" value={stats.rework} loading={loading}
            hint="Have a second shelf for rework"
            onClick={opener(partsDrill("Rework Parts", "Parts that also keep a rework shelf",
              parts.filter((p) => p.rework_location), "spares_rework"))} />
          <KpiCard featured tone="violet" label="Rated Parts" icon="🏷️" value={stats.rated} loading={loading}
            hint={stats.unrated ? `${stats.unrated} carry no rate` : "Every part is rated"}
            onClick={opener(partsDrill("Rated Parts", "Parts carrying a rate, so they can be valued",
              parts.filter((p) => Number(p.unit_price || 0) > 0), "spares_rated"))} />
          <KpiCard featured tone="cyan" label="Shelf Locations" icon="📍" value={stats.locations} loading={loading}
            hint={`${stats.racks.length} rack${stats.racks.length === 1 ? "" : "s"} in use`}
            onClick={opener({
              title: "Shelf Locations", columns: LOCATION_COLUMNS, rows: shelves,
              exportName: "spare_locations",
              subtitle: `${num(shelves.length)} shelves in use across ${stats.racks.length} rack${stats.racks.length === 1 ? "" : "s"}`,
            })} />
        </div>
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
        </div>

        {/* Top Racks is gone: the Parts by Rack donut above carries the same
            three numbers and opens the same lists. Value Bands stays — it
            groups by rate, which nothing else on the page does. */}
        <div className="mt-4">
          <div className="card">
            <CardHead icon="💰" tone="green" title="Value Bands" hint="Rated parts grouped by unit rate" />
            <HorizontalBars data={stats.bands} emptyMessage="No rates recorded yet"
              onBarClick={(d) => setDrill(bandDrill(d.name))} />
          </div>
        </div>
      </section>

      <section>
        <div className="mb-3">
          <h3 className="section-title">Highest Value Spares</h3>
          <p className="section-hint">The parts worth planning first</p>
        </div>
        <div className="card">
          <Table
            columns={[
              { key: "part_no", label: "Part No" },
              { key: "part_name", label: "Description" },
              { key: "location", label: "Location", render: (r) => r.location || "—" },
              {
                key: "qty_on_hand", label: "Current", align: "right",
                render: (r) => (r.qty_on_hand == null
                  ? <span className="text-slate-400 text-[11px]">not counted</span>
                  : num(r.qty_on_hand)),
              },
              {
                key: "max_stock_level", label: "Max", align: "right",
                render: (r) => (r.max_stock_level == null
                  ? <span className="text-amber-600 dark:text-amber-400 text-[11px] font-medium">not planned</span>
                  : num(r.max_stock_level)),
              },
              {
                key: "unit_price", label: "Rate", align: "right",
                render: (r) => <span className="font-semibold">{money(r.unit_price)}</span>,
              },
              {
                key: "stock_value", label: "Stock Value", align: "right",
                render: (r) => (r.stock_value == null ? "—" : money(r.stock_value)),
              },
              { key: "status", label: "Status", render: (r) => <StockStatus status={r.status} /> },
            ]}
            rows={dearest}
            loading={loading}
            onRowClick={onPartClick}
            emptyMessage="No rated parts yet"
          />
        </div>
      </section>

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

function SectionDetail({ section, onBack }) {
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

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-toyotared transition-colors"
          title="Back to the whole store"
        >
          <ArrowLeft size={16} />
        </button>
        <span className="w-11 h-11 rounded-xl flex items-center justify-center text-xl shrink-0
          bg-toyotared/[0.07] dark:bg-toyotared/15">
          {emojiFor(section.name)}
        </span>
        <div>
          <h2 className="font-semibold text-slate-800 dark:text-white">{section.name}</h2>
          <p className="text-xs text-slate-400">Section of the Spare Parts Store</p>
        </div>
      </div>

      {/* The same dashboard as the store's, scoped to this section. Clicking a
          section used to drop you onto a bare table — a step down from the
          page you came from, when what you wanted was that page for this
          section. */}
      <SpareDashboard
        stats={stats}
        loading={loading}
        totalHint={`In ${section.name}`}
        onPartClick={setSelected}
        onStockClick={(row) => setSelected(rows.find((p) => p.id === row.part_id) || null)}
        stock={stock}
        belowMin={belowMin}
        parts={rows}
        stockRows={stockRows}
      />

      <section>
        <div className="mb-3">
          <h3 className="section-title">All Parts</h3>
          <p className="section-hint">Searchable and exportable</p>
        </div>
        <div className="card">
          <Table
            columns={COLUMNS}
            rows={rows}
            loading={loading}
            onRowClick={setSelected}
            searchable="Search part no, description or location…"
            exportName={`${section.name.toLowerCase().replace(/\s+/g, "_")}_parts`}
            pageSize={25}
            emptyMessage="No parts in this section yet"
          />
        </div>
      </section>

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
  const [parts, setParts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    Promise.all([
      storeService.sections(STORE_CODE).then((res) => res.data.data).catch(() => []),
      fetchAllParts({ store_code: STORE_CODE, is_active: true }).catch(() => []),
    ])
      .then(([secs, all]) => {
        setSections(secs);
        setParts(all);
      })
      .finally(() => setLoading(false));
  }, []);

  const stats = useStoreStats(parts);
  // Skipped when a section is open: this component still runs its hooks before
  // handing off to SectionDetail, and the store-wide figures would go unused.
  const { stock, belowMin, stockRows } = useSpareStock(undefined, !sectionId);
  // Operational data is the whole store's, so it is fetched only for the store
  // dashboard — a section screen must not show it as if it were its own.
  const ops = useSpareOps(!sectionId);
  const [tracing, setTracing] = useState(null);

  // Which section is open comes from the URL, so the sidebar's section links
  // and the cards below land in exactly the same place.
  const openSection = sectionId ? sections.find((s) => String(s.id) === sectionId) : null;
  if (sectionId && openSection) {
    return <SectionDetail section={openSection} onBack={() => navigate(`/store/${STORE_CODE}`)} />;
  }

  return (
    // No banner of its own: the top bar already carries the store's name and
    // the plant's, and the 485 it showed is the first KPI below. A header that
    // repeats the header above it just pushes the real figures down the page.
    <div className="space-y-8">
      <SpareDashboard
        stats={stats}
        loading={loading}
        totalHint={`Across ${sections.length} section${sections.length === 1 ? "" : "s"}`}
        onPartClick={setSelected}
        onStockClick={(row) => setSelected(parts.find((p) => p.id === row.part_id) || null)}
        stock={stock}
        belowMin={belowMin}
        parts={parts}
        stockRows={stockRows}
        ops={ops}
      />

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
