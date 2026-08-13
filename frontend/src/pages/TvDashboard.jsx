import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ResponsiveContainer, PieChart, Pie, Cell, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
} from "recharts";
import { Bell, Moon, Sun, ArrowLeft, Maximize, Minimize, Layers } from "lucide-react";
import Modal from "../components/Modal.jsx";
import { spareStockService } from "../services/spareStockService.js";
import { storeDashboardService } from "../services/storeDashboardService.js";
import { supplierWindowScheduleService } from "../services/supplierWindowScheduleService.js";

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

// ---- demo fallbacks (overridden by real values where the API answers) ----
const DEMO_SPARE = {
  title: "Spare Parts Store", accent: C.blue, catTitle: "Stock by Part Type",
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
  trend: [
    { d: "07", qty: 8 }, { d: "08", qty: 12 }, { d: "09", qty: 6 }, { d: "10", qty: 14 },
    { d: "11", qty: 7 }, { d: "12", qty: 9 }, { d: "13", qty: 5 },
  ],
  lists: {},
};
const DEMO_CHILD = {
  title: "Child Parts Store", accent: C.green,
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

function Panel({ title, children, p }) {
  return (
    <div className="flex flex-col min-h-0 rounded-[0.7vh] border p-[0.9vh]" style={{ background: p.panel, borderColor: p.border }}>
      <h3 className="text-[1.8vh] font-semibold mb-[0.5vh] shrink-0" style={{ color: p.heading }}>{title}</h3>
      <div className="flex-1 min-h-0">{children}</div>
    </div>
  );
}

function MiniKpi({ label, value, color, note, onClick, p }) {
  return (
    <button type="button" onClick={onClick}
      className="flex-1 min-w-0 text-left rounded-[0.7vh] border p-[0.9vh] flex flex-col justify-center transition-transform hover:-translate-y-[0.2vh]"
      style={{ background: p.panel, borderColor: p.border, borderLeft: `0.5vh solid ${color}` }}>
      <p className="text-[1.6vh] truncate" style={{ color: p.muted }}>{label}</p>
      <p className="text-[3.1vh] font-extrabold leading-tight whitespace-nowrap overflow-hidden text-ellipsis" style={{ color: p.heading }}>{value}</p>
      {note && <p className="text-[1.4vh] truncate" style={{ color: note.color || p.dim }}>{note.text}</p>}
    </button>
  );
}

function StatusBar({ healthy, short, excess, p }) {
  const total = (healthy || 0) + (short || 0) + (excess || 0) || 1;
  const seg = (v, c) => (v > 0 ? <div style={{ width: `${(v / total) * 100}%`, background: c }} /> : null);
  const Leg = ({ c, t, n }) => (
    <span className="flex items-center gap-[0.5vh]" style={{ color: p.text }}>
      <span className="rounded-full" style={{ width: "1.1vh", height: "1.1vh", background: c }} />{t} <b style={{ color: p.heading }}>{fmtInt(n)}</b>
    </span>
  );
  return (
    <div className="flex flex-col h-full justify-center gap-[1.2vh]">
      <div className="flex h-[3.2vh] rounded-[0.5vh] overflow-hidden" style={{ background: p.panel2 }}>
        {seg(healthy, C.green)}{seg(short, C.red)}{seg(excess, C.amber)}
      </div>
      <div className="flex flex-wrap gap-x-[1.6vh] gap-y-[0.5vh] text-[1.8vh]">
        <Leg c={C.green} t="Healthy" n={healthy} /><Leg c={C.red} t="Short" n={short} /><Leg c={C.amber} t="Excess" n={excess} />
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
                <span className="absolute rounded-full" style={{
                  left: `${frac * 100}%`, top: "50%", transform: "translate(-50%, -50%)",
                  width: "1.8vh", height: "1.8vh", background: meta.color, boxShadow: `0 0 0 0.4vh ${meta.color}33`,
                }} />
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
function StoreStrip({ vm, p, animate }) {
  const total = vm.category.reduce((s, c) => s + c.value, 0);
  const tone = (real) => ({ text: real ? "live" : "demo", color: real ? C.green : p.dim });
  return (
    <section className="flex flex-col min-h-0 gap-[0.8vh]" style={{ flex: "1 0 0" }}>
      <div className="flex items-center gap-[1vh] shrink-0">
        <span className="rounded-[0.6vh] px-[1.2vh] py-[0.4vh] text-[2vh] font-bold text-white" style={{ background: vm.accent }}>{vm.title}</span>
        <span className="text-[1.7vh]" style={{ color: p.muted }}>{fmtInt(vm.kpis.total)} parts</span>
      </div>

      <div className="flex gap-[0.8vh] min-h-0" style={{ flex: "38 0 0" }}>
        {vm.cards.map((c) => (
          <MiniKpi key={c.label} label={c.label} value={c.value} color={c.color} p={p}
            note={c.viaErp ? { text: "via ERP", color: p.dim } : c.real != null ? tone(c.real) : null} onClick={c.onClick} />
        ))}
      </div>

      <div className={`grid ${vm.windows ? "grid-cols-4" : "grid-cols-3"} gap-[0.8vh] min-h-0`} style={{ flex: "62 0 0" }}>
        <Panel title={vm.catTitle || "Stock by Category"} p={p}>
          <Donut data={vm.category} centerTop={fmtInt(total)} centerSub="Parts" p={p} animate={animate} />
        </Panel>
        <Panel title="Stock Health" p={p}>
          <StatusBar healthy={vm.status.healthy} short={vm.status.short} excess={vm.status.excess} p={p} />
        </Panel>
        {vm.supplierPerf ? (
          <Panel title="Supplier Performance (Windows)" p={p}>
            <Donut data={vm.supplierPerf} centerTop={fmtInt(vm.supplierPerf.reduce((s, x) => s + x.value, 0))} centerSub="Windows" p={p} animate={animate} />
          </Panel>
        ) : vm.third === "rack" ? (
          <Panel title="Rack Utilization" p={p}><RackGauge pct={vm.rackPct} p={p} /></Panel>
        ) : (
          <Panel title="Consumption Trend (7 Days)" p={p}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={vm.trend} margin={{ top: 6, right: 8, left: -22, bottom: -6 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={p.border} vertical={false} />
                <XAxis dataKey="d" tick={{ fill: p.muted, fontSize: 14 }} tickLine={false} axisLine={{ stroke: p.border }} />
                <YAxis tick={{ fill: p.muted, fontSize: 14 }} tickLine={false} axisLine={false} width={30} />
                <Tooltip contentStyle={{ background: p.panel2, border: `1px solid ${p.border}`, borderRadius: 8, fontSize: 12, color: p.text }} />
                <Line type="monotone" dataKey="qty" stroke={vm.accent} strokeWidth={2.5} dot={{ r: 3, fill: vm.accent }} isAnimationActive={animate} animationDuration={600} />
              </LineChart>
            </ResponsiveContainer>
          </Panel>
        )}
        {vm.windows && (
          <Panel title="Today's Vehicle Status" p={p}><VehicleTimeline windows={vm.windows} p={p} /></Panel>
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
  const [drill, setDrill] = useState(null);
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
  const openDrill = (title, columns, rows) => setDrill({ title, columns, rows });

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
        if (Array.isArray(trend) && trend.some((t) => t.qty > 0)) next.trend = trend.map((t) => ({ d: t.d.slice(0, 2), qty: t.qty }));
        next.rows = Array.isArray(list) ? list : (prev.rows || []);
        next.cards = [
          { label: "Total Parts", value: fmtInt(total), color: C.blue, real: total != null,
            onClick: () => openDrill("Spare Parts — all", ["Part No", "Description", "Part Type", "On hand", "Status"],
              next.rows.map((r) => [r.part_no, r.part_name, r.sub_category || "—", fmtInt(r.qty_on_hand), r.status])) },
          { label: "Stock Value", value: fmtMoney(sum?.stock_value), color: C.green, real: sum?.stock_value != null,
            onClick: () => openDrill("Spare — by stock value (high → low)", ["Part No", "Description", "On hand", "Rate", "Stock Value"],
              next.rows.filter((r) => r.stock_value != null).sort((a, b) => b.stock_value - a.stock_value)
                .map((r) => [r.part_no, r.part_name, fmtInt(r.qty_on_hand), fmtMoney(r.unit_price), fmtMoney(r.stock_value)])) },
          { label: "Today's Consumption", value: fmtInt(today?.issued_qty), color: C.purple, real: today?.issued_qty != null,
            onClick: () => openDrill("Spare — consumption (last 7 days)", ["Day", "Qty issued"], next.trend.map((t) => [t.d, fmtInt(t.qty)])) },
          { label: "Short Parts", value: fmtInt(short), color: C.red, real: short != null,
            onClick: () => openDrill("Spare — short (below minimum)", ["Part No", "Description", "On hand", "Min", "Status"],
              next.rows.filter((r) => r.status === "Below Minimum" || r.status === "Out of Stock")
                .sort((a, b) => (b.min_stock_level - b.qty_on_hand) - (a.min_stock_level - a.qty_on_hand))
                .map((r) => [r.part_no, r.part_name, fmtInt(r.qty_on_hand), fmtInt(r.min_stock_level), r.status])) },
          { label: "Excess Parts", value: fmtInt(excess), color: C.cyan, real: excess != null,
            onClick: () => openDrill("Spare — excess (above maximum)", ["Part No", "Description", "On hand", "Max", "Over by"],
              next.rows.filter((r) => r.status === "Above Maximum")
                .sort((a, b) => (b.qty_on_hand - (b.max_stock_level || 0)) - (a.qty_on_hand - (a.max_stock_level || 0)))
                .map((r) => [r.part_no, r.part_name, fmtInt(r.qty_on_hand), fmtInt(r.max_stock_level), fmtInt(r.qty_on_hand - (r.max_stock_level || 0))])) },
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
      const [sum, win, parts, rgp] = await Promise.all([
        grab(storeDashboardService.summary()),
        grab(supplierWindowScheduleService.todayStatus()),
        grab(storeDashboardService.partSummary()),
        grab(storeDashboardService.pendingRgp()),
      ]);
      // Pending RGP comes only from ERP; null until the ERP API is live.
      const rgpVal = rgp && rgp.pending_rgp != null ? rgp.pending_rgp : null;
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
          if (sum.category_counts) next.category = toCatArray(sum.category_counts);
          next.crows = Array.isArray(parts) ? parts : (prev.crows || []);
          const isShort = (r) => String(r.indicator || "").toLowerCase().includes("short");
          const isExcess = (r) => String(r.indicator || "").toLowerCase().includes("excess");
          next.cards = [
            { label: "Total Parts", value: fmtInt(total), color: C.blue, real: total != null,
              onClick: () => openDrill("Child Parts — all", ["Part No", "Description", "Category", "On hand", "Status"],
                next.crows.map((r) => [r.part_no, r.part_name, r.category || "—", fmtInt(r.total_qty), r.indicator || "—"])) },
            { label: "Stock Value", value: fmtMoney(value), color: C.green, real: value != null,
              onClick: () => openDrill("Child Parts — by stock value (high → low)", ["Part No", "Description", "On hand", "Rate", "Stock Value"],
                next.crows.filter((r) => r.total_value != null).sort((a, b) => b.total_value - a.total_value)
                  .map((r) => [r.part_no, r.part_name, fmtInt(r.total_qty), fmtMoney(r.unit_price), fmtMoney(r.total_value)])) },
            { label: "Short Parts", value: fmtInt(short), color: C.red, real: short != null,
              onClick: () => openDrill("Child Parts — short", ["Part No", "Description", "On hand", "Min", "COV Days"],
                next.crows.filter(isShort).map((r) => [r.part_no, r.part_name, fmtInt(r.total_qty), fmtInt(r.min_stock_level), r.cov_days ?? "—"])) },
            { label: "Excess Parts", value: fmtInt(excess), color: C.amber, real: excess != null,
              onClick: () => openDrill("Child Parts — excess", ["Part No", "Description", "On hand", "Max", "COV Days"],
                next.crows.filter(isExcess).map((r) => [r.part_no, r.part_name, fmtInt(r.total_qty), fmtInt(r.max_stock_level), r.cov_days ?? "—"])) },
            { label: "Today's Consumption", value: fmtInt(sum.todays_issue), color: C.purple, real: sum.todays_issue != null,
              onClick: () => openDrill("Today's Movement", ["Metric", "Count"], [["Issued today", fmtInt(sum.todays_issue)], ["Put-away today", fmtInt(sum.todays_put_away)], ["Receipts (SRV) today", fmtInt(sum.todays_srv)]]) },
            { label: "Pending SRV", value: fmtInt(sum.pending_srv), color: C.cyan, real: sum.pending_srv != null,
              onClick: () => openDrill("Pending — receiving pipeline", ["Stage", "Count"], [["Pending SRV", fmtInt(sum.pending_srv)], ["Pending Put-Away", fmtInt(sum.pending_put_away)], ["Pending RQC (Inspection)", fmtInt(sum.pending_rqc)]]) },
            { label: "Pending RGP", value: rgpVal != null ? fmtInt(rgpVal) : "—", color: C.indigo, real: true,
              onClick: () => openDrill("Pending RGP", ["Info"], [[rgpVal != null ? `${fmtInt(rgpVal)} returnable gate passes pending (from ERP).` : "Sourced from ERP — will populate when the ERP API (ERP_API_BASE_URL) is live."]]) },
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

      <StoreStrip vm={spare} p={P} animate={animate} />
      <div className="shrink-0 border-t" style={{ borderColor: P.border }} />
      <StoreStrip vm={child} p={P} animate={animate} />

      <Modal open={!!drill} onClose={() => setDrill(null)} title={drill?.title} size="xl">
        {drill && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-slate-500 border-b border-slate-200 dark:border-navy-800">
                  {drill.columns.map((c) => <th key={c} className="py-2 pr-4 font-semibold">{c}</th>)}
                </tr>
              </thead>
              <tbody>
                {drill.rows.length === 0 ? (
                  <tr><td colSpan={drill.columns.length} className="py-6 text-center text-slate-400">No rows</td></tr>
                ) : drill.rows.map((r, i) => (
                  <tr key={i} className="border-b border-slate-100 dark:border-navy-800">
                    {r.map((cell, j) => <td key={j} className="py-2 pr-4 text-slate-700 dark:text-slate-200">{cell}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Modal>
    </div>
  );
}
