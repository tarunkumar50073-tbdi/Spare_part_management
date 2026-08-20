import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ResponsiveContainer, PieChart, Pie, Cell, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
} from "recharts";
import { Bell, Moon, Sun, ArrowLeft, Maximize, Minimize, Layers, X, Truck } from "lucide-react";
import { spareStockService } from "../services/spareStockService.js";
import { storeDashboardService } from "../services/storeDashboardService.js";
import { supplierWindowScheduleService } from "../services/supplierWindowScheduleService.js";
import { rgpService } from "../services/rgpService.js";

// A full-screen wallboard for a 53" LED — no menu, no scroll, fluid 16:9. Split
// top/bottom: the Spare Parts store on top, the Child Parts store below, each a
// compact strip of KPIs + charts. Real figures come straight from the app's own
// APIs (spare-stock for the top, the store dashboard for the bottom); demo
// values fill any gap so the board reads complete for a trial.
const REFRESH_MS = 30000;

const C = {
  blue: "#3b82f6", green: "#10b981", purple: "#a855f7", amber: "#f59e0b",
  red: "#ef4444", cyan: "#06b6d4", indigo: "#6366f1",
};
const PIE = [C.blue, C.green, C.amber, C.purple, C.cyan, C.indigo, C.red];

// Emoji per KPI / panel, matching the icon-per-card style of the app dashboards.
const KPI_ICON = {
  "Total Parts": "🔧", "Stock Value": "💰", "Today's Consumption": "📈",
  "Short Parts": "⚠️", "Excess Parts": "📦", "Pending SRV": "📋", "Pending RGP": "🔁",
};

const THEMES = {
  dark: { bg: "#0a0f1e", panel: "#111a30", panel2: "#0e1526", border: "#1e2a44", heading: "#ffffff", text: "#e2e8f0", muted: "#94a3b8", dim: "#64748b" },
  light: { bg: "#eef2f7", panel: "#ffffff", panel2: "#f8fafc", border: "#e2e8f0", heading: "#0f172a", text: "#334155", muted: "#64748b", dim: "#94a3b8" },
};

const fmtInt = (n) => (n == null ? "—" : Number(n).toLocaleString("en-IN"));
const fmtMoney = (v) => {
  if (v == null) return "—";
  if (v >= 1e7) return `₹ ${(v / 1e7).toFixed(2)} Cr`;
  if (v >= 1e5) return `₹ ${(v / 1e5).toFixed(2)} L`;
  return `₹ ${Number(v).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
};
const toCatArray = (obj) =>
  Object.entries(obj || {}).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
    .map(([name, value], i) => ({ name, value, color: PIE[i % PIE.length] }));

// On-time% -> traffic-light colour, reused across the supplier-performance view.
const pctColor = (p) => (p == null ? C.indigo : p >= 80 ? C.green : p >= 50 ? C.amber : C.red);

// A glossy digital ring gauge (SVG, vh-scaled) with a soft colour glow.
function Ring({ pct, color, P }) {
  const r = 42, circ = 2 * Math.PI * r;
  const off = circ * (1 - Math.max(0, Math.min(100, pct || 0)) / 100);
  return (
    <svg viewBox="0 0 100 100" style={{ width: "8.6vh", height: "8.6vh", filter: `drop-shadow(0 0 0.7vh ${color}55)` }}>
      <circle cx="50" cy="50" r={r} fill="none" stroke={P.border} strokeWidth="9" />
      <circle cx="50" cy="50" r={r} fill="none" stroke={color} strokeWidth="9" strokeLinecap="round"
        strokeDasharray={circ} strokeDashoffset={off} transform="rotate(-90 50 50)"
        style={{ transition: "stroke-dashoffset 0.9s ease" }} />
      <text x="50" y="53" dominantBaseline="central" textAnchor="middle" fill={P.heading} fontWeight="800" fontSize="23">
        {pct == null ? "—" : `${Math.round(pct)}%`}
      </text>
    </svg>
  );
}

// On-Time / Late / Not-Arrived proportions as one animated stacked bar.
function StackedBar({ onTime, late, na }) {
  const tot = Math.max(1, onTime + late + na);
  const seg = (v, color) => (v > 0 ? <div style={{ width: `${(v / tot) * 100}%`, background: color, transition: "width .8s ease" }} /> : null);
  return (
    <div className="flex h-[1.3vh] rounded-full overflow-hidden" style={{ background: "#8080802e" }}>
      {seg(onTime, C.green)}{seg(late, C.amber)}{seg(na, C.red)}
    </div>
  );
}

function PerfSummaryCard({ label, value, color, P, grad }) {
  return (
    <div className="rounded-[1vh] p-[1.3vh] flex flex-col gap-[0.6vh]"
      style={{ background: grad || P.panel, border: `1px solid ${P.border}`, boxShadow: `0 0.4vh 1.3vh ${color}22` }}>
      <div className="text-[1.5vh] font-semibold" style={{ color: P.muted }}>{label}</div>
      <div className="text-[3.4vh] font-black tabular-nums leading-none" style={{ color }}>{value}</div>
    </div>
  );
}

// The colourful, digital drill for "Supplier Performance — this month": KPI
// summary + a ring/gauge card per supplier (worst first), all theme-aware.
function SupplierPerfView({ data, P }) {
  const rows = data.rows || [];
  const sum = rows.reduce((a, s) => ({
    on_time: a.on_time + (s.on_time || 0), late: a.late + (s.late || 0), not_arrived: a.not_arrived + (s.not_arrived || 0),
  }), { on_time: 0, late: 0, not_arrived: 0 });
  const settled = sum.on_time + sum.late + sum.not_arrived;
  const overall = settled ? Math.round((sum.on_time / settled) * 1000) / 10 : null;
  const monthLabel = new Date(data.year, (data.month || 1) - 1, 1).toLocaleString(undefined, { month: "long", year: "numeric" });
  const through = data.judged_through
    ? new Date(data.judged_through + "T00:00:00").toLocaleDateString(undefined, { day: "2-digit", month: "short" })
    : null;
  return (
    <div className="p-[1.5vh] space-y-[1.5vh]">
      {/* Scope: whole month, but only through the latest day ERP has data for. */}
      <div className="flex items-center justify-between gap-[1.5vh] flex-wrap">
        <div className="text-[1.8vh]">
          <span className="font-bold" style={{ color: P.heading }}>{monthLabel}</span>
          {through && (
            <span style={{ color: P.muted }}> · through <span style={{ color: P.text }}>{through}</span> · <span style={{ color: C.amber }}>latest ERP data</span></span>
          )}
        </div>
        <div className="text-[1.7vh] font-semibold" style={{ color: P.dim }}>{fmtInt(settled)} windows judged</div>
      </div>
      <div className="grid grid-cols-3 xl:grid-cols-6 gap-[1.2vh]">
        <PerfSummaryCard label="Suppliers" value={fmtInt(rows.length)} color={C.blue} P={P} />
        <PerfSummaryCard label="Windows" value={fmtInt(settled)} color={P.heading} P={P} />
        <PerfSummaryCard label="On-Time" value={fmtInt(sum.on_time)} color={C.green} P={P} grad={`linear-gradient(135deg, ${C.green}26, ${P.panel})`} />
        <PerfSummaryCard label="Late" value={fmtInt(sum.late)} color={C.amber} P={P} grad={`linear-gradient(135deg, ${C.amber}26, ${P.panel})`} />
        <PerfSummaryCard label="Not Arrived" value={fmtInt(sum.not_arrived)} color={C.red} P={P} grad={`linear-gradient(135deg, ${C.red}26, ${P.panel})`} />
        <div className="rounded-[1vh] p-[1vh] flex items-center gap-[1.1vh]"
          style={{ background: P.panel, border: `1px solid ${P.border}`, boxShadow: `0 0.4vh 1.3vh ${pctColor(overall)}33` }}>
          <Ring pct={overall} color={pctColor(overall)} P={P} />
          <div className="leading-tight">
            <div className="text-[1.6vh] font-semibold" style={{ color: P.muted }}>Overall</div>
            <div className="text-[1.5vh]" style={{ color: P.dim }}>On-Time %</div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-[1.2vh]">
        {rows.map((s, i) => {
          const col = pctColor(s.on_time_pct);
          const bad = s.late + s.not_arrived > s.on_time;
          return (
            <div key={i} className="rounded-[1vh] p-[1.3vh] flex items-center gap-[1.4vh]"
              style={{ background: P.panel, border: `1px solid ${P.border}`, borderLeft: `0.55vh solid ${col}`, boxShadow: bad ? `0 0 1.5vh ${C.red}22` : "none" }}>
              <Ring pct={s.on_time_pct} color={col} P={P} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-[0.9vh]">
                  <span className="text-[1.5vh] font-bold flex items-center justify-center rounded-full shrink-0"
                    style={{ width: "2.7vh", height: "2.7vh", background: `${col}26`, color: col }}>{i + 1}</span>
                  <span className="text-[2vh] font-bold truncate" style={{ color: P.heading }} title={s.supplier}>{s.supplier}</span>
                </div>
                <div className="mt-[1vh]"><StackedBar onTime={s.on_time} late={s.late} na={s.not_arrived} /></div>
                <div className="flex items-center gap-[1.4vh] mt-[1vh] text-[1.6vh] font-semibold tabular-nums">
                  <span style={{ color: C.green }}>● {s.on_time} On-Time</span>
                  <span style={{ color: C.amber }}>● {s.late} Late</span>
                  <span style={{ color: C.red }}>● {s.not_arrived} NA</span>
                  <span className="ml-auto" style={{ color: P.dim }}>{s.windows} windows</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---- nested drill frames ----
// A frame is { title, columns, rows }; a row is { cells: [...], open?: () => Frame }.
// A row with `open` is clickable and pushes the next (nested) level onto the stack.
const detailFrame = (title, pairs) => ({
  title, columns: ["Field", "Value"], rows: pairs.map(([k, v]) => ({ cells: [k, v] })),
});
const spareDetail = (r) => detailFrame(r.part_no, [
  ...(r.old_part_no ? [["Old Part No (Reference)", r.old_part_no]] : []),
  ["Description", r.part_name], ["Part Type", r.sub_category || "—"],
  ["In Stock", fmtInt(r.qty_on_hand)], ["Min", fmtInt(r.min_stock_level)], ["Max", fmtInt(r.max_stock_level)],
  ["Rate", fmtMoney(r.unit_price)], ["Stock Value", fmtMoney(r.stock_value)],
  ["Status", r.status], ["Location", r.location || "—"],
]);
const childDetail = (r) => detailFrame(r.part_no, [
  ...(r.old_part_no ? [["Old Part No (Reference)", r.old_part_no]] : []),
  ["Description", r.part_name], ["Category", r.category || "—"],
  ["In Stock", fmtInt(r.total_qty)], ["Min", fmtInt(r.min_stock_level)], ["Max", fmtInt(r.max_stock_level)],
  ["Rate", fmtMoney(r.unit_price)], ["Stock Value", fmtMoney(r.total_value)],
  ["Status", r.indicator || "—"], ["COV Days", r.cov_days ?? "—"],
]);
const spareList = (title, rows) => ({
  title, cards: true, columns: ["Part No", "Description", "In Stock", "Status"],
  rows: rows.map((r) => ({ cells: [r.part_no, r.part_name, fmtInt(r.qty_on_hand), r.status], ref: r.old_part_no, open: () => spareDetail(r) })),
});
const childList = (title, rows) => ({
  title, cards: true, columns: ["Part No", "Description", "In Stock", "Status"],
  rows: rows.map((r) => ({ cells: [r.part_no, r.part_name, fmtInt(r.total_qty), r.indicator || "—"], ref: r.old_part_no, open: () => childDetail(r) })),
});
// Per-supplier window performance — who was On-Time / Late / Not-Arrived, worst
// first. Drilling a supplier shows its own windows. (Today's windows; a
// multi-day "how many times late" view needs a backend history endpoint.)
const supplierPerfFrame = (windows) => {
  const by = {};
  windows.forEach((w) => {
    const s = by[w.supplier] || (by[w.supplier] = { name: w.supplier, total: 0, onTime: 0, late: 0, notArrived: 0, pending: 0 });
    s.total += 1;
    if (w.status === "On-Time") s.onTime += 1;
    else if (w.status === "Late") s.late += 1;
    else if (w.status === "Not Arrived") s.notArrived += 1;
    else s.pending += 1;
  });
  const rows = Object.values(by).sort((a, b) =>
    (b.late + b.notArrived) - (a.late + a.notArrived) || (a.onTime / a.total) - (b.onTime / b.total));
  return {
    title: "Supplier Performance — today",
    // The on-screen table is today's; the download is this MONTH's full report.
    downloads: [
      { label: "This month · Excel", href: "/api/v1/supplier-window-schedules/performance/export?format=xlsx" },
      { label: "This month · PDF", href: "/api/v1/supplier-window-schedules/performance/export?format=pdf" },
      { label: "Late report · Excel", href: "/api/v1/supplier-window-schedules/late-report/export?format=xlsx" },
      { label: "Late report · PDF", href: "/api/v1/supplier-window-schedules/late-report/export?format=pdf" },
      { label: "Window-Time sheet · Excel", href: "/api/v1/supplier-window-schedules/window-time-report" },
    ],
    columns: ["Supplier", "Windows", "On-Time", "Late", "Not Arrived", "On-Time %"],
    rows: rows.map((s) => ({
      cells: [s.name, s.total, s.onTime, s.late, s.notArrived, `${Math.round((s.onTime / Math.max(1, s.total)) * 100)}%`],
      open: () => ({
        title: s.name,
        columns: ["Window", "Status"],
        rows: windows.filter((w) => w.supplier === s.name).map((w) => ({ cells: [`${w.start}–${w.end}`, w.status] })),
      }),
    })),
  };
};
const windowsFrame = (windows) => ({
  title: "Today's Windows",
  columns: ["Window", "Supplier", "Arrived", "Status"],
  rows: windows.map((w) => ({ cells: [`${w.start}–${w.end}`, w.supplier, w.arrival || "—", w.status] })),
});
// The category donut's own drill: group -> that group's parts -> a part's detail.
// Colourful drill for the Stock-by-Part-Type / Stock-by-Category donut: a big
// donut + a card per group (share bar + %), each clickable into its parts list.
function CategoryBreakdownView({ vm, P, onSelect }) {
  const cats = vm.category || [];
  const total = cats.reduce((s, c) => s + c.value, 0) || 1;
  return (
    <div className="p-[1.5vh] space-y-[1.4vh]">
      <div className="flex items-center justify-between gap-[1.5vh] flex-wrap">
        <div className="text-[2vh] font-bold" style={{ color: P.heading }}>{vm.catTitle || "Breakdown"}</div>
        <div className="text-[1.7vh] font-semibold" style={{ color: P.dim }}>{fmtInt(total)} parts · {cats.length} groups</div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-[1vh]">
          {cats.map((c, i) => {
            const pct = Math.round((c.value / total) * 100);
            return (
              <button key={i} type="button"
                onClick={() => onSelect(() => vm.listFn(c.name, (vm.parts || []).filter((r) => (r[vm.groupKey] || "—") === c.name)))}
                className="text-left rounded-[1vh] p-[1.2vh] flex items-center gap-[1.2vh] transition-transform hover:-translate-y-[0.3vh]"
                style={{ background: `linear-gradient(135deg, ${c.color}22, ${P.panel} 62%)`, border: `1px solid ${P.border}`, borderLeft: `0.55vh solid ${c.color}`, boxShadow: `0 0.4vh 1.3vh ${c.color}22` }}>
                <span className="rounded-full shrink-0" style={{ width: "1.8vh", height: "1.8vh", background: c.color, boxShadow: `0 0 0.9vh ${c.color}66` }} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-[1vh]">
                    <span className="text-[2vh] font-bold truncate" style={{ color: P.heading }} title={c.name}>{c.name}</span>
                    <span className="text-[2.3vh] font-black tabular-nums shrink-0" style={{ color: c.color }}>{fmtInt(c.value)}</span>
                  </div>
                  <div className="mt-[0.8vh] flex items-center gap-[1vh]">
                    <div className="flex-1 h-[1.2vh] rounded-full overflow-hidden" style={{ background: "#8080802e" }}>
                      <div className="h-full" style={{ width: `${pct}%`, background: c.color, transition: "width .8s ease" }} />
                    </div>
                    <span className="text-[1.6vh] font-semibold tabular-nums shrink-0" style={{ color: P.muted }}>{pct}%</span>
                  </div>
                </div>
                <span className="shrink-0 text-[2vh]" style={{ color: P.dim }}>›</span>
              </button>
            );
          })}
      </div>
    </div>
  );
}

// Status text -> traffic-light colour, for the list-drill pills.
const STATUS_COLOR = {
  short: C.red, "not arrived": C.red, critical: C.red, out: C.red, rejected: C.red, overdue: C.red,
  excess: C.amber, late: C.amber, pending: C.amber, "pending arrival": C.amber, warning: C.amber, hold: C.amber,
  healthy: C.green, ok: C.green, "on-time": C.green, "in stock": C.green, transferred: C.green, consumed: C.green, accepted: C.green, cleared: C.green,
};
const statusColorOf = (v) => STATUS_COLOR[String(v == null ? "" : v).trim().toLowerCase()];
function statusPill(val, P) {  // eslint-disable-line no-unused-vars
  const color = statusColorOf(val);
  if (!color) return val;
  return (
    <span className="inline-flex items-center gap-[0.6vh] rounded-full px-[1.1vh] py-[0.3vh] text-[1.6vh] font-semibold"
      style={{ background: `${color}22`, color }}>
      <span className="rounded-full" style={{ width: "0.9vh", height: "0.9vh", background: color }} />{val}
    </span>
  );
}
const numCol = (label) => /stock|parts|value|qty|days|arrived|\blate\b|on-time|count|total|balance|receipt|accept|reject|closing/i.test(String(label || ""));

// Premium/digital table for the list drills (KPI tiles, category parts, by-date):
// a summary strip (row count + status breakdown), an uppercase sticky header, and
// colour-coded status pills + right-aligned bold numbers.
function TableDrill({ frame, P, onOpen }) {
  const cols = frame.columns || [];
  const rows = frame.rows || [];
  const statusIdx = cols.findIndex((c) => /status/i.test(c));
  const counts = {};
  if (statusIdx >= 0) rows.forEach((r) => { const v = String(r.cells[statusIdx] ?? "").trim(); if (v) counts[v] = (counts[v] || 0) + 1; });
  return (
    <div>
      <div className="flex items-center gap-[1.5vh] flex-wrap px-[1.6vh] py-[1.1vh] border-b" style={{ borderColor: P.border, background: P.panel2 }}>
        <span className="text-[2vh] font-black tabular-nums" style={{ color: P.heading }}>{fmtInt(rows.length)}</span>
        <span className="text-[1.7vh]" style={{ color: P.muted }}>rows</span>
        {Object.entries(counts).map(([s, n]) => {
          const col = statusColorOf(s) || P.dim;
          return (
            <span key={s} className="inline-flex items-center gap-[0.6vh] text-[1.7vh] font-semibold tabular-nums" style={{ color: col }}>
              <span className="rounded-full" style={{ width: "1vh", height: "1vh", background: col }} />{s} {n}
            </span>
          );
        })}
      </div>
      <table className="w-full text-[1.9vh]">
        <thead>
          <tr className="text-left sticky top-0 z-10" style={{ background: P.panel2 }}>
            {cols.map((c) => (
              <th key={c} className={`py-[1.3vh] px-[1.6vh] text-[1.5vh] font-bold uppercase tracking-wide border-b ${numCol(c) ? "text-right" : ""}`}
                style={{ color: P.dim, borderColor: P.border }}>{c}</th>
            ))}
            <th className="border-b" style={{ borderColor: P.border }} />
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={cols.length + 1} className="py-[5vh] text-center" style={{ color: P.dim }}>No rows</td></tr>
          ) : rows.map((r, i) => (
            <tr key={i} onClick={r.open ? () => onOpen(r.open) : undefined}
              className={r.open ? "cursor-pointer hover:bg-[#8080801f]" : ""}>
              {r.cells.map((cell, j) => (
                <td key={j} className={`py-[1.2vh] px-[1.6vh] border-t ${numCol(cols[j]) ? "text-right tabular-nums font-semibold" : ""}`}
                  style={{ color: P.text, borderColor: P.border }}>
                  {j === statusIdx ? statusPill(cell, P) : cell}
                </td>
              ))}
              <td className="text-right px-[1.4vh] border-t" style={{ color: P.dim, borderColor: P.border }}>{r.open ? "›" : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Premium card grid for list drills (part lists, value lists, category counts):
// one card per row — rank, title, sub, primary value + share bar + status pill.
function CardListView({ frame, P, onOpen }) {
  const cols = frame.columns || [];
  const rows = frame.rows || [];
  const statusIdx = cols.findIndex((c) => /status/i.test(c));
  let valIdx = -1;
  cols.forEach((c, j) => { if (numCol(c)) valIdx = j; });
  const numOf = (cell) => { const n = parseFloat(String(cell == null ? "" : cell).replace(/[^\d.-]/g, "")); return Number.isNaN(n) ? 0 : n; };
  const maxVal = valIdx >= 0 ? Math.max(1, ...rows.map((r) => numOf(r.cells[valIdx]))) : 0;
  // The share bar only reads as meaningful where the value IS the point (a
  // category count / stock value — bigger = longer). On a part list the Status
  // pill is the real indicator, so a qty-vs-max bar there just confused; drop it.
  const showBar = valIdx >= 0 && statusIdx < 0;
  return (
    <div className="p-[1.4vh]">
      <div className="mb-[1.2vh] text-[1.9vh]">
        <span className="font-black tabular-nums" style={{ color: P.heading }}>{fmtInt(rows.length)}</span> <span style={{ color: P.muted }}>items</span>
      </div>
      {rows.length === 0 ? (
        <div className="py-[5vh] text-center" style={{ color: P.dim }}>No rows</div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-[1vh]">
          {rows.map((r, i) => {
            const status = statusIdx >= 0 ? r.cells[statusIdx] : null;
            const accent = statusColorOf(status) || C.blue;
            const barPct = valIdx >= 0 && maxVal ? Math.round((numOf(r.cells[valIdx]) / maxVal) * 100) : 0;
            const sub = statusIdx !== 1 && valIdx !== 1 && r.cells[1] != null && r.cells[1] !== r.cells[0] ? r.cells[1] : null;
            return (
              <button key={i} type="button" onClick={r.open ? () => onOpen(r.open) : undefined}
                className={`text-left rounded-[1vh] p-[1.2vh] flex items-center gap-[1.2vh] transition-transform ${r.open ? "hover:-translate-y-[0.3vh]" : ""}`}
                style={{ background: `linear-gradient(135deg, ${accent}1c, ${P.panel} 60%)`, border: `1px solid ${P.border}`, borderLeft: `0.5vh solid ${accent}`, boxShadow: `0 0.4vh 1.2vh ${accent}1f` }}>
                <span className="text-[1.5vh] font-bold flex items-center justify-center rounded-full shrink-0"
                  style={{ width: "2.7vh", height: "2.7vh", background: `${accent}26`, color: accent }}>{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-[1vh]">
                    <span className="text-[1.9vh] font-bold truncate" style={{ color: P.heading }} title={String(r.cells[0])}>{r.cells[0]}</span>
                    {valIdx >= 0 && <span className="text-[2.1vh] font-black tabular-nums shrink-0" style={{ color: accent }}>{r.cells[valIdx]}</span>}
                  </div>
                  {r.ref && <div className="text-[1.5vh] font-semibold truncate" style={{ color: P.dim }} title={`Reference / Old Part No: ${r.ref}`}>Ref: {r.ref}</div>}
                  {sub && <div className="text-[1.6vh] truncate" style={{ color: P.muted }} title={String(sub)}>{sub}</div>}
                  <div className="mt-[0.7vh] flex items-center gap-[1vh]">
                    {showBar && (
                      <div className="flex-1 h-[1vh] rounded-full overflow-hidden" style={{ background: "#8080802e" }}>
                        <div className="h-full" style={{ width: `${barPct}%`, background: accent, transition: "width .8s ease" }} />
                      </div>
                    )}
                    {status != null && String(status).trim() !== "" && <span className="shrink-0">{statusPill(status, P)}</span>}
                  </div>
                </div>
                {r.open && <span className="shrink-0 text-[2vh]" style={{ color: P.dim }}>›</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

const categoryFrame = (vm, P) => ({
  title: vm.catTitle || "Stock by Category",
  custom: (push) => (
    <CategoryBreakdownView vm={vm} P={P}
      onSelect={async (openFn) => { const f = await openFn(); if (f) push(f); }} />
  ),
  columns: [vm.catTitle === "Stock by Part Type" ? "Part Type" : "Category", "Parts"],
  rows: (vm.category || []).map((c) => ({
    cells: [c.name, fmtInt(c.value)],
    open: () => vm.listFn(c.name, (vm.parts || []).filter((r) => (r[vm.groupKey] || "Uncategorized") === c.name)),
  })),
});

// ---- demo fallbacks (overridden by real values where the API answers) ----
const DEMO_SPARE = {
  title: "Spare Parts Store", accent: C.blue, catTitle: "Stock by Part Type",
  parts: [], listFn: spareList, groupKey: "sub_category",
  kpis: { total: 481 }, real: {},
  cards: [
    { label: "Total Parts", value: "481", color: C.blue },
    { label: "Stock Value", value: "₹ 2.45 Cr", color: C.green },
    { label: "Today's Consumption", value: "1,256", color: C.purple },
    { label: "Short Parts", value: "16", color: C.red },
    { label: "Excess Parts", value: "255", color: C.cyan },
  ],
  category: [
    { name: "Rail Die part", value: 131, color: C.blue }, { name: "Punch", value: 63, color: C.green },
    { name: "Pin", value: 52, color: C.amber }, { name: "Spring", value: 42, color: C.purple },
  ],
  status: { healthy: 210, short: 16, excess: 255 },
  trend: [],
  lists: {},
};
const DEMO_CHILD = {
  title: "Child Parts Store", accent: C.green,
  parts: [], listFn: childList, groupKey: "category",
  kpis: { total: 1130 }, real: {},
  cards: [
    { label: "Total Parts", value: "1,130", color: C.blue },
    { label: "Stock Value", value: "₹ 6.71 Cr", color: C.green },
    { label: "Short Parts", value: "40", color: C.red },
    { label: "Excess Parts", value: "110", color: C.amber },
    { label: "Today's Consumption", value: "85", color: C.purple },
    { label: "Pending SRV", value: "0", color: C.cyan },
    { label: "Pending RGP", value: "—", color: C.indigo, real: true },
  ],
  category: [
    { name: "BOP", value: 620, color: C.blue }, { name: "Import", value: 240, color: C.green },
    { name: "In-Parts", value: 180, color: C.amber }, { name: "Consumable", value: 90, color: C.purple },
  ],
  status: { healthy: 980, short: 40, excess: 110 },
  supplierPerf: [
    { name: "On-Time", value: 12, color: C.green }, { name: "Pending Arrival", value: 4, color: C.amber },
    { name: "Late", value: 3, color: C.red }, { name: "Not Arrived", value: 3, color: "#64748b" },
  ],
  windows: [
    { start: "08:30", end: "10:00", supplier: "SAR Coating LLP", status: "On-Time", arrival: "08:42" },
    { start: "09:20", end: "11:30", supplier: "Talu Auto Tech", status: "Pending Arrival", arrival: null },
    { start: "11:30", end: "13:00", supplier: "Lucas TVS", status: "Late", arrival: "13:18" },
    { start: "13:00", end: "14:30", supplier: "Bosch (Milkrun)", status: "Not Arrived", arrival: null },
  ],
};

// ---------------------------------------------------------------- primitives
function IconBtn({ onClick, title, p, children, badge }) {
  return (
    <button type="button" onClick={onClick} title={title}
      className="relative rounded-full border p-[0.9vh] hover:brightness-125 transition-[filter]"
      style={{ background: p.panel, borderColor: p.border, color: p.text }}>
      {children}
      {badge != null && badge > 0 && (
        <span className="absolute -top-[0.3vh] -right-[0.3vh] rounded-full bg-red-500 text-white text-[1.45vh] px-[0.6vh] font-bold">{badge}</span>
      )}
    </button>
  );
}

function Panel({ title, children, p, onClick, icon }) {
  return (
    <div onClick={onClick}
      className={`flex flex-col min-h-0 rounded-[0.9vh] border p-[0.9vh] ${onClick ? "cursor-pointer hover:brightness-[1.05] transition-[filter]" : ""}`}
      style={{ background: `linear-gradient(180deg, ${p.panel}, ${p.panel2})`, borderColor: p.border, boxShadow: "0 0.5vh 1.4vh rgba(0,0,0,0.14)" }}>
      <h3 className="text-[1.8vh] font-bold mb-[0.6vh] shrink-0 flex items-center justify-between gap-2" style={{ color: p.heading }}>
        <span className="flex items-center gap-[0.7vh] min-w-0">
          {icon && (
            <span className="shrink-0 rounded-[0.6vh] flex items-center justify-center text-[1.9vh] leading-none"
              style={{ width: "3vh", height: "3vh", background: p.panel2, border: `1px solid ${p.border}` }}>{icon}</span>
          )}
          <span className="truncate">{title}</span>
        </span>
        {onClick && <span className="shrink-0" style={{ color: p.dim }}>›</span>}
      </h3>
      <div className="flex-1 min-h-0">{children}</div>
    </div>
  );
}

function MiniKpi({ label, value, color, note, onClick, p }) {
  const icon = KPI_ICON[label];
  return (
    <button type="button" onClick={onClick}
      className="flex-1 min-w-0 text-left rounded-[0.9vh] border p-[0.9vh] flex flex-col justify-center transition-transform hover:-translate-y-[0.3vh]"
      style={{
        background: `linear-gradient(135deg, ${color}24, ${p.panel} 62%)`,
        borderColor: p.border, borderLeft: `0.55vh solid ${color}`,
        boxShadow: `0 0.5vh 1.5vh ${color}26`,
      }}>
      <div className="flex items-center justify-between gap-[0.6vh] min-w-0">
        <p className="text-[1.6vh] font-semibold truncate" style={{ color: p.muted }}>{label}</p>
        {icon && (
          <span className="shrink-0 rounded-full flex items-center justify-center text-[1.9vh] leading-none"
            style={{ width: "3.4vh", height: "3.4vh", background: `${color}30`, boxShadow: `0 0 0.9vh ${color}44` }}>{icon}</span>
        )}
      </div>
      <p className="text-[3.2vh] font-black leading-tight whitespace-nowrap overflow-hidden text-ellipsis tabular-nums"
        style={{ color, textShadow: `0 0 1.4vh ${color}40` }}>{value}</p>
      {note && <p className="text-[1.4vh] font-medium truncate" style={{ color: note.color || p.dim }}>{note.text}</p>}
    </button>
  );
}

function StatusBar({ healthy, short, excess, p, onSelect }) {
  const total = (healthy || 0) + (short || 0) + (excess || 0) || 1;
  const clickable = !!onSelect;
  const seg = (v, c, sel) => (v > 0 ? (
    <div onClick={clickable ? () => onSelect(sel) : undefined} title={clickable ? `${sel} (${v})` : undefined}
      className={clickable ? "cursor-pointer hover:brightness-110 transition-[filter]" : ""}
      style={{ width: `${(v / total) * 100}%`, background: c }} />
  ) : null);
  const Leg = ({ c, t, n, sel }) => (
    <button type="button" onClick={clickable ? () => onSelect(sel) : undefined}
      className={`flex items-center gap-[0.5vh] rounded-[0.5vh] px-[0.6vh] py-[0.2vh] ${clickable ? "cursor-pointer hover:bg-[#8080801f]" : ""}`}
      style={{ color: p.text }}>
      <span className="rounded-full" style={{ width: "1.1vh", height: "1.1vh", background: c }} />{t} <b style={{ color: p.heading }}>{fmtInt(n)}</b>
    </button>
  );
  return (
    <div className="flex flex-col h-full justify-center gap-[1.2vh]">
      <div className="flex h-[3.2vh] rounded-[0.5vh] overflow-hidden" style={{ background: p.panel2 }}>
        {seg(healthy, C.green, "healthy")}{seg(short, C.red, "short")}{seg(excess, C.amber, "excess")}
      </div>
      <div className="flex flex-wrap gap-x-[1.6vh] gap-y-[0.5vh] text-[1.8vh]">
        <Leg c={C.green} t="Healthy" n={healthy} sel="healthy" /><Leg c={C.red} t="Short" n={short} sel="short" /><Leg c={C.amber} t="Excess" n={excess} sel="excess" />
      </div>
    </div>
  );
}

function Donut({ data, centerTop, centerSub, p, animate }) {
  const total = data.reduce((s, c) => s + c.value, 0);
  return (
    <div className="flex h-full items-center gap-[1vh]">
      <div className="relative h-full" style={{ width: "42%" }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="name" innerRadius="60%" outerRadius="92%" paddingAngle={2} stroke="none" isAnimationActive={animate} animationDuration={500}>
              {data.map((c) => <Cell key={c.name} fill={c.color} />)}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <span className="text-[2.6vh] font-extrabold" style={{ color: p.heading }}>{centerTop}</span>
          <span className="text-[1.45vh]" style={{ color: p.muted }}>{centerSub}</span>
        </div>
      </div>
      <div className="flex-1 flex flex-col justify-center gap-[0.6vh] min-w-0">
        {data.slice(0, 4).map((c) => (
          <div key={c.name} className="flex items-center gap-[0.7vh] text-[1.75vh]">
            <span className="rounded-full shrink-0" style={{ width: "1.2vh", height: "1.2vh", background: c.color }} />
            <span className="flex-1 truncate" style={{ color: p.text }}>{c.name}</span>
            <span className="font-semibold tabular-nums" style={{ color: p.heading }}>{fmtInt(c.value)}</span>
            <span className="w-[4.5vh] text-right tabular-nums" style={{ color: p.dim }}>{total ? ((c.value / total) * 100).toFixed(0) : 0}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function RackGauge({ pct, p }) {
  const SEMI = Math.PI * 80;
  const arc = Math.max(0, Math.min(100, pct));
  return (
    <svg viewBox="0 0 200 120" className="w-full h-full">
      <path d="M 20 104 A 80 80 0 0 1 180 104" fill="none" stroke={p.border} strokeWidth="16" strokeLinecap="round" />
      <path d="M 20 104 A 80 80 0 0 1 180 104" fill="none" stroke={C.amber} strokeWidth="16" strokeLinecap="round"
        strokeDasharray={`${(arc / 100) * SEMI} ${SEMI * 2}`} />
      <text x="100" y="92" textAnchor="middle" fontSize="30" fontWeight="800" fill={p.heading}>{Math.round(pct)}%</text>
      <text x="100" y="112" textAnchor="middle" fontSize="12" fill={p.muted}>Occupied</text>
    </svg>
  );
}

const WIN_META = {
  "On-Time": { color: C.green, label: (w) => `Arrived ${w.arrival || ""}`.trim() },
  "Late": { color: "#f97316", label: (w) => `Arrived ${w.arrival || ""} · Late`.trim() },
  "Pending Arrival": { color: C.amber, label: () => "Upcoming" },
  "Not Arrived": { color: C.red, label: () => "Not Arrived" },
};
const toMin = (t) => { const [h, m] = (t || "0:0").split(":").map(Number); return h * 60 + m; };

// Today's supplier delivery windows as a live timeline: each row is the window
// span (start ━●━ end) with a coloured marker for how the vehicle did, then the
// supplier and its arrival status. Child Parts only.
function VehicleTimeline({ windows, p }) {
  if (!windows.length) return <div className="h-full flex items-center justify-center text-[1.7vh]" style={{ color: p.dim }}>No windows today</div>;
  return (
    <div className="flex flex-col h-full justify-center gap-[1.4vh] overflow-hidden">
      {windows.slice(0, 4).map((w, i) => {
        const meta = WIN_META[w.status] || { color: p.dim, label: () => w.status };
        const s = toMin(w.start), e = toMin(w.end);
        const frac = w.arrival
          ? Math.max(0.06, Math.min(0.94, (toMin(w.arrival) - s) / Math.max(1, e - s)))
          : (w.status === "Not Arrived" ? 0.94 : 0.5);
        return (
          <div key={i}>
            <div className="flex items-center gap-[0.7vh] text-[1.5vh]">
              <span className="tabular-nums shrink-0" style={{ color: p.muted }}>{w.start}</span>
              <div className="relative flex-1 rounded-full" style={{ height: "0.35vh", background: p.border }}>
                <span className="absolute flex items-center justify-center rounded-full p-[0.3vh]" style={{
                  left: `${frac * 100}%`, top: "50%", transform: "translate(-50%, -50%)",
                  background: p.panel, boxShadow: `0 0 0 0.25vh ${meta.color}33`,
                }}>
                  <Truck style={{ width: "2.6vh", height: "2.6vh", color: meta.color }} />
                </span>
              </div>
              <span className="tabular-nums shrink-0" style={{ color: p.muted }}>{w.end}</span>
            </div>
            <div className="mt-[0.3vh] flex items-center gap-[0.6vh] text-[1.5vh]">
              <span className="font-semibold truncate" style={{ color: p.text }}>{w.supplier}</span>
              <span style={{ color: p.dim }}>→</span>
              <span className="font-semibold truncate" style={{ color: meta.color }}>{meta.label(w)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// One store's compact strip: header + KPI row + a chart row.
function StoreStrip({ vm, p, animate, onOpen, onSearch, onSupplierPerf, onDateView }) {
  const total = vm.category.reduce((s, c) => s + c.value, 0);
  const tone = (real) => ({ text: real ? "live" : "demo", color: real ? C.green : p.dim });
  const [sq, setSq] = useState("");
  return (
    <section className="flex flex-col min-h-0 gap-[0.8vh]" style={{ flex: "1 0 0" }}>
      <div className="flex items-center gap-[1vh] shrink-0">
        <span className="rounded-[0.6vh] px-[1.2vh] py-[0.4vh] text-[2vh] font-bold text-white" style={{ background: vm.accent }}>{vm.title}</span>
        <span className="text-[1.7vh]" style={{ color: p.muted }}>{fmtInt(vm.kpis.total)} parts</span>
        {onSearch && (
          <form className="ml-auto flex items-center gap-[0.6vh]" onSubmit={(e) => { e.preventDefault(); onSearch(sq); }}>
            <div className="flex items-center rounded-[0.7vh] border px-[1vh]" style={{ background: p.panel, borderColor: p.border, height: "3.4vh" }}>
              <span className="text-[1.7vh]" style={{ color: p.dim }}>🔍</span>
              <input value={sq} onChange={(e) => setSq(e.target.value)} placeholder="Search part no / ref / name…"
                className="bg-transparent outline-none ml-[0.7vh] text-[1.6vh]" style={{ color: p.text, width: "19vh" }} />
              {sq && <button type="button" onClick={() => setSq("")} className="text-[2vh] leading-none px-[0.4vh]" style={{ color: p.dim }}>×</button>}
            </div>
            <button type="submit" className="rounded-[0.7vh] px-[1.4vh] text-[1.6vh] font-semibold text-white" style={{ background: vm.accent, height: "3.4vh" }}>Go</button>
          </form>
        )}
      </div>

      <div className="flex gap-[0.8vh] min-h-0" style={{ flex: "38 0 0" }}>
        {vm.cards.map((c) => (
          <MiniKpi key={c.label} label={c.label} value={c.value} color={c.color} p={p}
            note={c.note != null ? c.note : c.viaErp ? { text: "via ERP", color: p.dim } : c.real != null ? tone(c.real) : null} onClick={c.onClick} />
        ))}
      </div>

      <div className={`grid ${vm.windows ? "grid-cols-4" : "grid-cols-3"} gap-[0.8vh] min-h-0`} style={{ flex: "62 0 0" }}>
        <Panel title={vm.catTitle || "Stock by Category"} icon="🍩" p={p} onClick={() => onOpen(categoryFrame(vm, p))}>
          <Donut data={vm.category} centerTop={fmtInt(total)} centerSub="Parts" p={p} animate={animate} />
        </Panel>
        <Panel title="Stock Health" icon="🩺" p={p}>
          <StatusBar healthy={vm.status.healthy} short={vm.status.short} excess={vm.status.excess} p={p}
            onSelect={vm.health ? (sel) => vm.health[sel] && onOpen(vm.health[sel]) : undefined} />
        </Panel>
        {vm.supplierPerf ? (
          <Panel title="Supplier Performance (Windows)" icon="🚚" p={p} onClick={() => onSupplierPerf(vm.windows || [])}>
            <Donut data={vm.supplierPerf} centerTop={fmtInt(vm.supplierPerf.reduce((s, x) => s + x.value, 0))} centerSub="Windows" p={p} animate={animate} />
          </Panel>
        ) : vm.third === "rack" ? (
          <Panel title="Rack Utilization" icon="🗄️" p={p}><RackGauge pct={vm.rackPct} p={p} /></Panel>
        ) : (
          <Panel title="Consumption Trend (7 Days)" icon="📉" p={p}>
            {vm.trend && vm.trend.some((t) => t.qty > 0) ? (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={vm.trend} margin={{ top: 6, right: 8, left: -22, bottom: -6 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={p.border} vertical={false} />
                <XAxis dataKey="d" tick={{ fill: p.muted, fontSize: 14 }} tickLine={false} axisLine={{ stroke: p.border }} />
                <YAxis tick={{ fill: p.muted, fontSize: 14 }} tickLine={false} axisLine={false} width={30} />
                <Tooltip contentStyle={{ background: p.panel2, border: `1px solid ${p.border}`, borderRadius: 8, fontSize: 12, color: p.text }} />
                <Line type="monotone" dataKey="qty" stroke={vm.accent} strokeWidth={2.5} dot={{ r: 3, fill: vm.accent }} isAnimationActive={animate} animationDuration={600} />
              </LineChart>
            </ResponsiveContainer>
            ) : (
              <div className="flex flex-col items-center justify-center h-full gap-[0.6vh] text-center" style={{ color: p.dim }}>
                <span className="text-[2.4vh]">📉</span>
                <span className="text-[1.8vh]">No consumption data yet</span>
              </div>
            )}
          </Panel>
        )}
        {vm.windows && (
          <Panel title="Today's Vehicle Status" icon="🚛" p={p} onClick={() => onDateView(vm.windows)}>
            <VehicleTimeline windows={vm.windows} p={p} />
          </Panel>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- main
export default function TvDashboard() {
  const navigate = useNavigate();
  const [spare, setSpare] = useState(DEMO_SPARE);
  const [child, setChild] = useState(DEMO_CHILD);
  const [now, setNow] = useState(() => new Date());
  const [stack, setStack] = useState([]); // nested drill: a breadcrumb stack of frames
  const [isFs, setIsFs] = useState(false);
  const [dark, setDark] = useState(false); // default to Day (light) on the LED
  const [animate, setAnimate] = useState(true);
  const [lastUpdated, setLastUpdated] = useState(null);
  const P = dark ? THEMES.dark : THEMES.light;

  // Charts animate once on open, then freeze — so the 30s auto-refresh doesn't
  // replay the donut's "slow open" every time.
  useEffect(() => {
    const t = setTimeout(() => setAnimate(false), 1200);
    return () => clearTimeout(t);
  }, []);

  const goBack = () => (window.history.length > 1 ? navigate(-1) : navigate("/store/MAINTENANCE"));
  const toggleFullscreen = () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
    else document.exitFullscreen?.();
  };
  // Nested drill: openStack starts a fresh window, pushFrame goes a level
  // deeper, popTo jumps back to a breadcrumb level.
  const openStack = (frame) => setStack([frame]);
  const pushFrame = (frame) => setStack((s) => [...s, frame]);
  const popTo = (i) => setStack((s) => s.slice(0, i + 1));
  // A flat, single-level drill (no nesting) — rows are plain arrays of cells.
  const openDrill = (title, columns, rows) => setStack([{ title, columns, rows: rows.map((r) => ({ cells: r })) }]);

  // Per-store part search — each split panel has its own box. Matches part no /
  // name / old no / new no (case-insensitive), opens a drill of the hits whose
  // rows go to that part's detail. `field`/`detail` differ per store, the rest
  // is shared.
  const runSearch = (query, { rows, title, qtyKey, statusKey, detail }) => {
    const q = (query || "").trim();
    if (!q) return;
    const ql = q.toLowerCase();
    const hit = (r) => `${r.part_no || ""} ${r.part_name || ""} ${r.old_part_no || ""} ${r.new_part_no || ""}`.toLowerCase().includes(ql);
    const hits = (rows || []).filter(hit)
      .map((r) => ({ cells: [r.part_no, r.part_name, fmtInt(r[qtyKey]), r[statusKey] || "—"], ref: r.old_part_no, open: () => detail(r) }));
    openStack({ title: `${title} — “${q}” · ${hits.length} found`, cards: true, columns: ["Part No", "Description", "In Stock", "Status"], rows: hits });
  };
  const searchSpare = (query) => runSearch(query, { rows: spare.rows, title: "Spare search", qtyKey: "qty_on_hand", statusKey: "status", detail: spareDetail });
  const searchChild = (query) => runSearch(query, { rows: child.crows, title: "Child search", qtyKey: "total_qty", statusKey: "indicator", detail: childDetail });

  // This month's per-supplier performance (how many times late / not-arrived),
  // fetched from the server. Falls back to today's view if the route isn't up
  // yet (backend not restarted).
  const openMonthlyPerf = async (todayWindows) => {
    const data = await supplierWindowScheduleService.performance().then((r) => r.data.data).catch(() => null);
    if (data && Array.isArray(data.rows) && data.rows.length) {
      openStack({
        title: "Supplier Performance — this month",
        downloads: [
          { label: "Excel", href: "/api/v1/supplier-window-schedules/performance/export?format=xlsx" },
          { label: "PDF", href: "/api/v1/supplier-window-schedules/performance/export?format=pdf" },
          { label: "Late report · Excel", href: "/api/v1/supplier-window-schedules/late-report/export?format=xlsx" },
          { label: "Late report · PDF", href: "/api/v1/supplier-window-schedules/late-report/export?format=pdf" },
          { label: "Window-Time sheet · Excel", href: "/api/v1/supplier-window-schedules/window-time-report" },
        ],
        custom: <SupplierPerfView data={data} P={P} />,
        columns: ["Supplier", "Windows", "On-Time", "Late", "Not Arrived", "On-Time %"],
        rows: data.rows.map((s) => ({
          cells: [s.supplier, s.windows, s.on_time, s.late, s.not_arrived, s.on_time_pct != null ? `${s.on_time_pct}%` : "—"],
        })),
      });
    } else {
      openStack(supplierPerfFrame(todayWindows || []));
    }
  };

  // By-date view: a list of the month's days -> click a day -> who came late /
  // not-arrived that day. Falls back to today's windows if the route isn't up.
  const openDateView = async (todayWindows) => {
    const data = await supplierWindowScheduleService.monthDaily().then((r) => r.data.data).catch(() => null);
    const dayFrame = (dateStr) => async () => {
      const w = await supplierWindowScheduleService.dayStatus(dateStr).then((r) => r.data.data).catch(() => []);
      return {
        title: dateStr,
        columns: ["Window", "Supplier", "Arrived", "Status"],
        rows: (w || []).map((x) => ({
          cells: [`${(x.window_start || "").slice(0, 5)}–${(x.window_end || "").slice(0, 5)}`,
            x.supplier_name, x.actual_arrival ? x.actual_arrival.slice(11, 16) : "—", x.status],
        })),
      };
    };
    if (data && Array.isArray(data.rows) && data.rows.length) {
      openStack({
        title: "Vehicle Status — by date",
        columns: ["Date", "Windows", "On-Time", "Late", "Not Arrived"],
        rows: data.rows.map((d) => ({ cells: [d.date, d.windows, d.on_time, d.late, d.not_arrived], open: dayFrame(d.date) })),
      });
    } else {
      openStack(windowsFrame(todayWindows || []));
    }
  };

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    const on = () => setIsFs(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);

  // Spare Parts store — from the spare-stock API.
  useEffect(() => {
    let alive = true;
    const grab = (pr) => pr.then((r) => r.data.data).catch(() => null);
    const load = async () => {
      const [sum, today, ana, list, trend] = await Promise.all([
        grab(spareStockService.summary("MAINTENANCE")),
        grab(spareStockService.today("MAINTENANCE")),
        grab(spareStockService.analytics("MAINTENANCE")),
        grab(spareStockService.list({ store_code: "MAINTENANCE" })),
        grab(spareStockService.consumptionTrend("MAINTENANCE", 7)),
      ]);
      if (!alive) return;
      setSpare((prev) => {
        const next = { ...prev, real: {} };
        const total = sum?.total_parts;
        next.kpis = { total: total ?? prev.kpis.total };
        let short = null, excess = null, healthy = null;
        if (ana && Array.isArray(ana.status_distribution)) {
          const by = Object.fromEntries(ana.status_distribution.map((s) => [s.name, s.value]));
          short = (by["Below Minimum"] || 0) + (by["Zero Stock"] || 0);
          excess = by["Above Maximum"] || 0;
          healthy = by["Healthy"] || 0;
          next.status = { healthy, short, excess };
        }
        // Spare parts all carry one blanket category ("Maintenance/Tool Room"),
        // so grouping on that gives a useless single slice. The Press-Shop
        // stamping spares are far more telling split by part type (sub_category:
        // Punch / Pin / Spring / Rail Die part …).
        if (Array.isArray(list) && list.some((r) => r.sub_category)) next.category = toCatArray(
          list.reduce((m, r) => { const c = r.sub_category || "Uncategorised"; m[c] = (m[c] || 0) + 1; return m; }, {}));
        if (Array.isArray(trend)) next.trend = trend.map((t) => ({ d: t.d.slice(0, 2), qty: t.qty }));
        next.rows = Array.isArray(list) ? list : (prev.rows || []);
        next.parts = next.rows;
        next.health = {
          short: spareList("Short — below minimum", next.rows.filter((r) => r.status === "Below Minimum" || r.status === "Out of Stock")),
          excess: spareList("Excess — above maximum", next.rows.filter((r) => r.status === "Above Maximum")),
          healthy: spareList("Healthy parts", next.rows.filter((r) => r.status !== "Below Minimum" && r.status !== "Out of Stock" && r.status !== "Above Maximum")),
        };
        next.cards = [
          // Total Parts -> part types -> that type's parts -> a part's detail.
          { label: "Total Parts", value: fmtInt(total), color: C.blue, real: total != null,
            onClick: () => openStack({ title: "Total Parts", cards: true, columns: ["Part Type", "Parts"],
              rows: next.category.map((c) => ({ cells: [c.name, fmtInt(c.value)],
                open: () => spareList(c.name, next.rows.filter((r) => (r.sub_category || "Uncategorised") === c.name)) })) }) },
          { label: "Stock Value", value: fmtMoney(sum?.stock_value), color: C.green, real: sum?.stock_value != null,
            onClick: () => openStack({ title: "Stock Value (high → low)", cards: true, columns: ["Part No", "Description", "Stock Value"],
              rows: next.rows.filter((r) => r.stock_value != null).sort((a, b) => b.stock_value - a.stock_value)
                .map((r) => ({ cells: [r.part_no, r.part_name, fmtMoney(r.stock_value)], open: () => spareDetail(r) })) }) },
          { label: "Today's Consumption", value: fmtInt(today?.issued_qty), color: C.purple, real: today?.issued_qty != null,
            onClick: () => openDrill("Spare — consumption (last 7 days)", ["Day", "Qty issued"], next.trend.map((t) => [t.d, fmtInt(t.qty)])) },
          { label: "Short Parts", value: fmtInt(short), color: C.red, real: short != null,
            onClick: () => openStack(spareList("Short — below minimum",
              next.rows.filter((r) => r.status === "Below Minimum" || r.status === "Out of Stock")
                .sort((a, b) => (b.min_stock_level - b.qty_on_hand) - (a.min_stock_level - a.qty_on_hand)))) },
          { label: "Excess Parts", value: fmtInt(excess), color: C.cyan, real: excess != null,
            onClick: () => openStack(spareList("Excess — above maximum",
              next.rows.filter((r) => r.status === "Above Maximum")
                .sort((a, b) => (b.qty_on_hand - (b.max_stock_level || 0)) - (a.qty_on_hand - (a.max_stock_level || 0))))) },
        ];
        return next;
      });
      setLastUpdated(new Date());
    };
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => { alive = false; clearInterval(id); };
  }, []);

  // Child Parts store — from the store dashboard API.
  useEffect(() => {
    let alive = true;
    const grab = (pr) => pr.then((r) => r.data.data).catch(() => null);
    const load = async () => {
      const [sum, win, parts, rgpCount, rgpList] = await Promise.all([
        grab(storeDashboardService.summary()),
        grab(supplierWindowScheduleService.todayStatus()),
        grab(storeDashboardService.partSummary()),
        grab(rgpService.pendingCount("CHILD_PART")),
        grab(rgpService.list("CHILD_PART", true)),
      ]);
      // Pending RGP — real app data (ERP will feed the same endpoint later).
      const rgpVal = rgpCount && rgpCount.pending != null ? rgpCount.pending : null;
      const rgpRows = Array.isArray(rgpList) ? rgpList : [];
      if (!alive) return;
      // Inventory value = sum of every part's stock value, the way the child
      // store's own dashboard computes it.
      const value = Array.isArray(parts) ? parts.reduce((s, p) => s + (p.total_value || 0), 0) : null;
      setChild((prev) => {
        const next = { ...prev };
        if (sum) {
          const total = sum.total_parts;
          const short = sum.low_stock, excess = sum.excess_stock;
          next.kpis = { total: total ?? prev.kpis.total };
          next.status = { healthy: Math.max(0, (total || 0) - (short || 0) - (excess || 0)), short: short || 0, excess: excess || 0 };
          if (sum.category_counts) {
            next.category = toCatArray(sum.category_counts);
            // Parts with no category aren't in category_counts, so the donut
            // summed to less than Total Parts — add the remainder as one slice
            // so the donut centre matches the Total Parts count.
            const catSum = next.category.reduce((s, c) => s + c.value, 0);
            if (total != null && total > catSum) next.category = [...next.category, { name: "Uncategorized", value: total - catSum, color: "#94a3b8" }];
          }
          next.crows = Array.isArray(parts) ? parts : (prev.crows || []);
          next.parts = next.crows;
          const isShort = (r) => String(r.indicator || "").toLowerCase().includes("short");
          const isExcess = (r) => String(r.indicator || "").toLowerCase().includes("excess");
          next.health = {
            healthy: childList("Healthy parts", next.crows.filter((r) => !isShort(r) && !isExcess(r))),
            short: childList("Short parts", next.crows.filter(isShort)),
            excess: childList("Excess parts", next.crows.filter(isExcess)),
          };
          next.cards = [
            { label: "Total Parts", value: fmtInt(total), color: C.blue, real: total != null,
              onClick: () => openStack({ title: "Total Parts", cards: true, columns: ["Category", "Parts"],
                rows: next.category.map((c) => ({ cells: [c.name, fmtInt(c.value)],
                  open: () => childList(c.name, next.crows.filter((r) => (r.category || "Uncategorized") === c.name)) })) }) },
            { label: "Stock Value", value: value ? fmtMoney(value) : "—", color: C.green, real: value != null,
              note: value ? null : { text: "no stock qty yet", color: C.amber },
              onClick: () => openStack({ title: "Stock Value (high → low)", cards: true, columns: ["Part No", "Description", "Stock Value"],
                rows: next.crows.filter((r) => r.total_value != null).sort((a, b) => b.total_value - a.total_value)
                  .map((r) => ({ cells: [r.part_no, r.part_name, fmtMoney(r.total_value)], open: () => childDetail(r) })) }) },
            { label: "Short Parts", value: fmtInt(short), color: C.red, real: short != null,
              onClick: () => openStack(childList("Short parts", next.crows.filter(isShort))) },
            { label: "Excess Parts", value: fmtInt(excess), color: C.amber, real: excess != null,
              onClick: () => openStack(childList("Excess parts", next.crows.filter(isExcess))) },
            { label: "Today's Consumption", value: fmtInt(sum.todays_issue), color: C.purple, real: sum.todays_issue != null,
              onClick: () => openDrill("Today's Movement", ["Metric", "Count"], [["Issued today", fmtInt(sum.todays_issue)], ["Put-away today", fmtInt(sum.todays_put_away)], ["Receipts (SRV) today", fmtInt(sum.todays_srv)]]) },
            { label: "Pending SRV", value: fmtInt(sum.pending_srv), color: C.cyan, real: sum.pending_srv != null,
              onClick: () => openDrill("Pending — receiving pipeline", ["Stage", "Count"], [["Pending SRV", fmtInt(sum.pending_srv)], ["Pending Put-Away", fmtInt(sum.pending_put_away)], ["Pending RQC (Inspection)", fmtInt(sum.pending_rqc)]]) },
            { label: "Pending RGP", value: rgpVal != null ? fmtInt(rgpVal) : "—", color: C.indigo, real: true,
              onClick: () => openStack({
                title: "Pending RGP",
                columns: ["Challan No", "Vendor", "Item", "Balance Qty", "Pend Days", "Target Dt"],
                rows: rgpRows.map((r) => ({
                  cells: [r.challan_no || "—", r.ven_name || r.ven_cd || "—", r.item_desc || r.item_cd || "—",
                    fmtInt(r.balance_qty), r.pend_days ?? "—", r.target_dt || "—"],
                })),
              }) },
          ];
        }
        // Today's supplier delivery windows (Child Parts only) + the window-wise
        // supplier-performance breakdown built from the same statuses.
        if (Array.isArray(win)) {
          next.windows = win.map((w) => ({
            supplier: w.supplier_name,
            start: (w.window_start || "").slice(0, 5),
            end: (w.window_end || "").slice(0, 5),
            arrival: w.actual_arrival ? w.actual_arrival.slice(11, 16) : null,
            status: w.status,
          }));
          const cc = {};
          next.windows.forEach((w) => { cc[w.status] = (cc[w.status] || 0) + 1; });
          const order = [["On-Time", C.green], ["Pending Arrival", C.amber], ["Late", C.red], ["Not Arrived", "#64748b"]];
          next.supplierPerf = order.filter(([s]) => cc[s]).map(([name, color]) => ({ name, value: cc[name], color }));
        }
        return next;
      });
      setLastUpdated(new Date());
    };
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const clock = useMemo(() => {
    const date = now.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
    const time = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
    return `${date} | ${time}`;
  }, [now]);

  return (
    <div className="h-screen w-screen overflow-hidden flex flex-col p-[1vh] gap-[1vh]"
      style={{ background: P.bg, color: P.text }}>

      <header className="shrink-0 flex items-center justify-between gap-[1.5vh]" style={{ height: "7vh" }}>
        <div className="flex items-center gap-[1.2vh] min-w-0">
          <IconBtn onClick={goBack} title="Back to app" p={P}><ArrowLeft style={{ width: "2.2vh", height: "2.2vh" }} /></IconBtn>
          <div className="flex items-center gap-[1vh] min-w-0">
            <Layers style={{ width: "2.8vh", height: "2.8vh", color: C.blue }} />
            <div className="min-w-0">
              <h1 className="text-[3.1vh] font-extrabold leading-tight" style={{ color: P.heading }}>Part Store — Live Dashboard</h1>
              <p className="text-[1.7vh]" style={{ color: P.muted }}>Spare Parts &amp; Child Parts · real-time</p>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-[0.9vh]">
          <div className="hidden lg:flex flex-col items-end leading-tight">
            <span className="text-[1.5vh]" style={{ color: P.muted }}>Last Updated: {lastUpdated ? lastUpdated.toLocaleTimeString("en-GB") : "—:—:—"}</span>
            <span className="text-[1.35vh]" style={{ color: P.dim }}>Auto-refresh · 30 sec</span>
          </div>
          <div className="hidden md:flex items-center rounded-[0.7vh] border px-[1.2vh] py-[0.9vh]" style={{ background: P.panel, borderColor: P.border }}>
            <span className="text-[1.9vh] tabular-nums" style={{ color: P.text }}>{clock}</span>
          </div>
          <IconBtn onClick={() => openDrill("Alerts", ["Store", "Alert"], [
            ...["Spare"].flatMap(() => [[`Spare`, `${spare.status.short} short · ${spare.status.excess} excess`]]),
            [`Child`, `${child.status.short} short · ${child.status.excess} excess`],
          ])} title="Alerts" p={P} badge={(spare.status.short || 0) + (child.status.short || 0)}>
            <Bell style={{ width: "2.2vh", height: "2.2vh" }} />
          </IconBtn>
          <IconBtn onClick={() => setDark((d) => !d)} title={dark ? "Switch to light" : "Switch to dark"} p={P}>
            {dark ? <Sun style={{ width: "2.2vh", height: "2.2vh" }} /> : <Moon style={{ width: "2.2vh", height: "2.2vh" }} />}
          </IconBtn>
          <IconBtn onClick={toggleFullscreen} title={isFs ? "Exit fullscreen" : "Fullscreen"} p={P}>
            {isFs ? <Minimize style={{ width: "2.2vh", height: "2.2vh" }} /> : <Maximize style={{ width: "2.2vh", height: "2.2vh" }} />}
          </IconBtn>
        </div>
      </header>

      <StoreStrip vm={spare} p={P} animate={animate} onOpen={openStack} onSearch={searchSpare} onSupplierPerf={openMonthlyPerf} onDateView={openDateView} />
      <div className="shrink-0 border-t" style={{ borderColor: P.border }} />
      <StoreStrip vm={child} p={P} animate={animate} onOpen={openStack} onSearch={searchChild} onSupplierPerf={openMonthlyPerf} onDateView={openDateView} />

      {/* Nested drill as a FULL-SCREEN view — same theme as the board, a
          breadcrumb to walk back up, and clickable rows that go a level deeper. */}
      {stack.length > 0 && (
        <div className="fixed inset-0 z-50 flex flex-col p-[1.2vh] gap-[1.2vh]" style={{ background: P.bg, color: P.text }}>
          <header className="shrink-0 flex items-center justify-between gap-[1.5vh]" style={{ height: "7vh" }}>
            <div className="flex items-center gap-[1.2vh] min-w-0">
              <IconBtn onClick={() => setStack((s) => (s.length > 1 ? s.slice(0, -1) : []))} title="Back" p={P}>
                <ArrowLeft style={{ width: "2.2vh", height: "2.2vh" }} />
              </IconBtn>
              <div className="flex items-center gap-[0.8vh] flex-wrap text-[2.2vh] min-w-0">
                {stack.map((f, i) => (
                  <React.Fragment key={i}>
                    {i > 0 && <span style={{ color: P.dim }}>›</span>}
                    <button type="button" onClick={() => popTo(i)} className="truncate max-w-[40vw]"
                      style={{ color: i === stack.length - 1 ? P.heading : P.muted, fontWeight: i === stack.length - 1 ? 800 : 500 }}>
                      {f.title}
                    </button>
                  </React.Fragment>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-[0.8vh] shrink-0">
              {stack[stack.length - 1].downloads?.map((d) => (
                <a key={d.label} href={d.href} download
                  className="rounded-[0.7vh] border px-[1.4vh] py-[0.9vh] text-[1.6vh] font-semibold hover:brightness-110 transition-[filter]"
                  style={{ background: P.panel, borderColor: P.border, color: P.text }}>⬇ {d.label}</a>
              ))}
              <IconBtn onClick={() => setStack([])} title="Close" p={P}><X style={{ width: "2.2vh", height: "2.2vh" }} /></IconBtn>
            </div>
          </header>
          <div className="flex-1 min-h-0 overflow-auto rounded-[0.8vh] border" style={{ background: P.panel, borderColor: P.border }}>
            {stack[stack.length - 1].custom ? (
              typeof stack[stack.length - 1].custom === "function"
                ? stack[stack.length - 1].custom(pushFrame)
                : stack[stack.length - 1].custom
            ) : stack[stack.length - 1].cards ? (
              <CardListView frame={stack[stack.length - 1]} P={P}
                onOpen={async (openFn) => { const f = await openFn(); if (f) pushFrame(f); }} />
            ) : (
            <TableDrill frame={stack[stack.length - 1]} P={P}
              onOpen={async (openFn) => { const f = await openFn(); if (f) pushFrame(f); }} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
