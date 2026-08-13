import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ResponsiveContainer, PieChart, Pie, Cell,
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  LineChart, Line,
} from "recharts";
import {
  Search, Bell, Moon, Package, IndianRupee, TrendingUp, Download,
  AlertTriangle, Boxes, FileText, ArrowRightLeft, Factory,
  PackageCheck, ListChecks, FileBarChart,
} from "lucide-react";
import Modal from "../components/Modal.jsx";
import { spareStockService } from "../services/spareStockService.js";

// A full-screen wallboard for a 53" LED — no menu, no scroll, fluid 16:9. It
// lives outside MainLayout so nothing frames it; the whole viewport is the
// board. Real spare-store figures fill in where the API has them (parts, value,
// today's consumption, short, excess); the rest is representative demo data so
// the board reads "complete" for a trial run. Every tile opens a detail popup.
const STORE = "MAINTENANCE";
const REFRESH_MS = 30000;

const C = {
  bg: "#0a0f1e", panel: "#111a30", panel2: "#0e1526", border: "#1e2a44",
  blue: "#3b82f6", green: "#10b981", purple: "#a855f7", amber: "#f59e0b",
  red: "#ef4444", cyan: "#06b6d4", indigo: "#6366f1", slate: "#64748b",
};

const fmtInt = (n) => (n == null ? "—" : Number(n).toLocaleString("en-IN"));
const fmtMoney = (v) => {
  if (v == null) return "—";
  if (v >= 1e7) return `₹ ${(v / 1e7).toFixed(2)} Cr`;
  if (v >= 1e5) return `₹ ${(v / 1e5).toFixed(2)} L`;
  return `₹ ${Number(v).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
};

// ---- representative demo data (overridden by real values where available) ----
const DEMO = {
  kpis: {
    liveParts: 12458, value: 24500000, todayConsumption: 1256,
    pendingPutAway: 78, shortParts: 23, excessParts: 156,
  },
  deltas: { liveParts: 5.2, value: 3.8, todayConsumption: 7.6 },
  category: [
    { name: "BOP Parts", value: 6245, color: C.blue },
    { name: "Import Parts", value: 3215, color: C.green },
    { name: "Local Parts", value: 2198, color: C.amber },
    { name: "MRO / Others", value: 800, color: C.purple },
  ],
  status: [
    { name: "BOP Parts", Available: 5621, Short: 12, Excess: 68 },
    { name: "Import Parts", Available: 2901, Short: 7, Excess: 34 },
    { name: "Local Parts", Available: 1982, Short: 3, Excess: 28 },
    { name: "MRO / Others", Available: 754, Short: 1, Excess: 26 },
  ],
  trend: [
    { d: "07 Aug", qty: 860 }, { d: "08 Aug", qty: 1120 }, { d: "09 Aug", qty: 760 },
    { d: "10 Aug", qty: 1265 }, { d: "11 Aug", qty: 640 }, { d: "12 Aug", qty: 820 },
    { d: "13 Aug", qty: 760 },
  ],
  top5: [
    { no: "SP-10023", desc: "CUTTING TIP 16ER AG60", qty: 1245 },
    { no: "SP-10047", desc: "DRILL BIT HSS 6.5mm", qty: 987 },
    { no: "SP-10089", desc: "INSERT CNMG 120408", qty: 876 },
    { no: "SP-10102", desc: "GRINDING WHEEL 5\"", qty: 765 },
    { no: "SP-10115", desc: "TAP M8 X 1.25", qty: 654 },
  ],
  rack: { occupiedPct: 72, total: 120, full: 28, available: 34 },
  txns: [
    { key: "grn", label: "GRN / Receiving", unit: "Documents", value: 15, icon: FileText, color: C.blue },
    { key: "issue", label: "Issue / Consumption", unit: "Documents", value: 48, icon: PackageCheck, color: C.green },
    { key: "transfer", label: "Stock Transfer", unit: "Documents", value: 6, icon: ArrowRightLeft, color: C.cyan },
    { key: "production", label: "Production Issue", unit: "Requests", value: 5, icon: Factory, color: C.purple },
  ],
  alerts: [
    { tone: "red", text: "23 Parts are short (Less than 1 Day)", time: "10:15 AM" },
    { tone: "amber", text: "78 Items pending for Put Away", time: "10:05 AM" },
    { tone: "amber", text: "Rack A1-2 is 100% Occupied", time: "09:50 AM" },
    { tone: "green", text: "156 Parts are in Excess", time: "09:30 AM" },
  ],
  pending: [
    { srv: "SRV-0826-015", grn: "GRN-0826-112", no: "SP-10023", desc: "CUTTING TIP 16ER AG60", qty: 120, date: "13 Aug 2026" },
    { srv: "SRV-0826-016", grn: "GRN-0826-113", no: "SP-10047", desc: "DRILL BIT HSS 6.5mm", qty: 200, date: "13 Aug 2026" },
    { srv: "SRV-0826-017", grn: "GRN-0826-114", no: "SP-10089", desc: "INSERT CNMG 120408", qty: 150, date: "13 Aug 2026" },
  ],
};

const QUICK_ACTIONS = [
  { label: "GRN / Receiving", icon: Download, to: "/store-stock-spare" },
  { label: "Issue / Consumption", icon: PackageCheck, to: "/store-stock-spare" },
  { label: "Production Issue", icon: Factory, to: "/store-stock-spare" },
  { label: "Stock Transfer", icon: ArrowRightLeft, to: "/store-stock-spare" },
  { label: "Inventory Count", icon: ListChecks, to: "/store-stock-spare" },
  { label: "Reports", icon: FileBarChart, to: "/spare-erp-gap" },
];

// ---------------------------------------------------------------- primitives
function Panel({ title, action, children, onClick, className = "" }) {
  return (
    <div
      onClick={onClick}
      className={`flex flex-col min-h-0 rounded-[0.8vh] border p-[1.1vh] ${onClick ? "cursor-pointer hover:border-slate-500 transition-colors" : ""} ${className}`}
      style={{ background: C.panel, borderColor: C.border }}
    >
      {title && (
        <div className="flex items-center justify-between mb-[0.8vh] shrink-0">
          <h3 className="text-[1.5vh] font-semibold text-slate-100">{title}</h3>
          {action}
        </div>
      )}
      <div className="flex-1 min-h-0">{children}</div>
    </div>
  );
}

function Kpi({ label, value, sub, subTone, icon: Icon, color, onClick }) {
  return (
    <button
      type="button" onClick={onClick}
      className="text-left flex flex-col justify-between rounded-[0.8vh] border p-[1.2vh] min-h-0 transition-transform hover:-translate-y-[0.3vh]"
      style={{ background: C.panel, borderColor: C.border, borderTop: `0.4vh solid ${color}` }}
    >
      <div className="flex items-start justify-between gap-[0.6vh]">
        <div className="min-w-0">
          <p className="text-[1.3vh] text-slate-400 leading-tight">{label}</p>
          <p className="text-[2.9vh] font-extrabold leading-tight text-white whitespace-nowrap overflow-hidden text-ellipsis">{value}</p>
        </div>
        <span className="shrink-0 rounded-full p-[1vh] flex items-center justify-center"
          style={{ background: `${color}22`, color }}>
          <Icon style={{ width: "2.2vh", height: "2.2vh" }} />
        </span>
      </div>
      <p className={`text-[1.3vh] mt-[0.4vh] ${subTone || "text-slate-400"}`}>{sub}</p>
    </button>
  );
}

// A half-dial for rack utilisation (semicircle arc + centred reading).
function RackGauge({ pct }) {
  const SEMI = Math.PI * 80;
  const arc = Math.max(0, Math.min(100, pct));
  return (
    <svg viewBox="0 0 200 120" className="w-full h-full">
      <path d="M 20 104 A 80 80 0 0 1 180 104" fill="none" stroke={C.border} strokeWidth="16" strokeLinecap="round" />
      <path d="M 20 104 A 80 80 0 0 1 180 104" fill="none" stroke={C.amber} strokeWidth="16" strokeLinecap="round"
        strokeDasharray={`${(arc / 100) * SEMI} ${SEMI * 2}`} />
      <text x="100" y="92" textAnchor="middle" fontSize="30" fontWeight="800" fill="#fff">{Math.round(pct)}%</text>
      <text x="100" y="112" textAnchor="middle" fontSize="12" fill="#94a3b8">Occupied</text>
    </svg>
  );
}

const ALERT_DOT = { red: C.red, amber: C.amber, green: C.green };

// ---------------------------------------------------------------- main
export default function TvDashboard() {
  const navigate = useNavigate();
  const [vm, setVm] = useState(DEMO);
  const [now, setNow] = useState(() => new Date());
  const [drill, setDrill] = useState(null); // { title, columns, rows }

  // Live clock.
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // Real spare-store figures where the API has them; demo values stay for the rest.
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const grab = (p) => p.then((r) => r.data.data).catch(() => null);
      const [sum, today, ana] = await Promise.all([
        grab(spareStockService.summary(STORE)),
        grab(spareStockService.today(STORE)),
        grab(spareStockService.analytics(STORE)),
      ]);
      if (!alive) return;
      setVm((prev) => {
        const next = { ...prev, kpis: { ...prev.kpis }, real: {} };
        if (sum) {
          if (sum.total_parts != null) { next.kpis.liveParts = sum.total_parts; next.real.liveParts = true; }
          if (sum.stock_value != null) { next.kpis.value = sum.stock_value; next.real.value = true; }
        }
        if (today && today.issued_qty != null) { next.kpis.todayConsumption = today.issued_qty; next.real.todayConsumption = true; }
        if (ana && Array.isArray(ana.status_distribution)) {
          const by = Object.fromEntries(ana.status_distribution.map((s) => [s.name, s.value]));
          const short = (by["Below Minimum"] || 0) + (by["Zero Stock"] || 0);
          next.kpis.shortParts = short; next.real.shortParts = true;
          if (by["Above Maximum"] != null) { next.kpis.excessParts = by["Above Maximum"]; next.real.excessParts = true; }
        }
        return next;
      });
    };
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const clock = useMemo(() => {
    const d = now;
    const date = d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
    const time = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
    return `${date} | ${time}`;
  }, [now]);

  const openDrill = (title, columns, rows) => setDrill({ title, columns, rows });

  const K = vm.kpis;
  const R = vm.real || {};
  const tag = (isReal) => (isReal ? "text-emerald-400" : "text-slate-500");

  return (
    <div className="h-screen w-screen overflow-hidden flex flex-col p-[1.1vh] gap-[1.1vh]"
      style={{ background: C.bg, color: "#e2e8f0" }}>

      {/* Header */}
      <header className="shrink-0 flex items-center justify-between gap-[1.5vh]" style={{ height: "8vh" }}>
        <div className="min-w-0">
          <h1 className="text-[2.8vh] font-extrabold text-white leading-tight">Dashboard</h1>
          <p className="text-[1.4vh] text-slate-400">Real-time overview of Consumable Spare Part Store</p>
        </div>
        <div className="hidden md:flex items-center gap-[0.8vh] rounded-[0.8vh] border px-[1.2vh] py-[1vh] w-[32vw] max-w-[520px]"
          style={{ background: C.panel, borderColor: C.border }}>
          <Search style={{ width: "2vh", height: "2vh" }} className="text-slate-500" />
          <span className="text-[1.5vh] text-slate-500">Search Part, Rack, Document…</span>
        </div>
        <div className="flex items-center gap-[1vh]">
          <div className="flex items-center gap-[0.8vh] rounded-[0.8vh] border px-[1.2vh] py-[1vh]"
            style={{ background: C.panel, borderColor: C.border }}>
            <span className="text-[1.5vh] text-slate-200 tabular-nums">{clock}</span>
          </div>
          <span className="relative rounded-full p-[1vh] border" style={{ background: C.panel, borderColor: C.border }}>
            <Bell style={{ width: "2.2vh", height: "2.2vh" }} className="text-slate-300" />
            <span className="absolute -top-[0.3vh] -right-[0.3vh] rounded-full bg-red-500 text-white text-[1vh] px-[0.6vh] font-bold">8</span>
          </span>
          <span className="rounded-full p-[1vh] border" style={{ background: C.panel, borderColor: C.border }}>
            <Moon style={{ width: "2.2vh", height: "2.2vh" }} className="text-slate-300" />
          </span>
        </div>
      </header>

      {/* KPI row */}
      <section className="grid grid-cols-6 gap-[1.1vh] min-h-0" style={{ flex: "15 0 0" }}>
        <Kpi label="Total Live Parts" value={fmtInt(K.liveParts)} icon={Package} color={C.blue}
          sub={<span className={tag(R.liveParts)}>{R.liveParts ? "live" : `+${vm.deltas.liveParts}% vs yesterday`}</span>}
          onClick={() => openDrill("Total Live Parts", ["Category", "Parts"], vm.category.map((c) => [c.name, fmtInt(c.value)]))} />
        <Kpi label="Total Value (INR)" value={fmtMoney(K.value)} icon={IndianRupee} color={C.green}
          sub={<span className={tag(R.value)}>{R.value ? "live" : `+${vm.deltas.value}% vs yesterday`}</span>}
          onClick={() => openDrill("Total Stock Value", ["Category", "Parts"], vm.category.map((c) => [c.name, fmtInt(c.value)]))} />
        <Kpi label="Today's Consumption" value={fmtInt(K.todayConsumption)} icon={TrendingUp} color={C.purple}
          sub={<span className={tag(R.todayConsumption)}>{R.todayConsumption ? "live" : `+${vm.deltas.todayConsumption}% vs yesterday`}</span>}
          onClick={() => openDrill("Today's Consumption", ["Part No", "Description", "Qty"], vm.top5.map((t) => [t.no, t.desc, fmtInt(t.qty)]))} />
        <Kpi label="Pending Put Away" value={fmtInt(K.pendingPutAway)} icon={Download} color={C.amber}
          sub={<span className="text-slate-400">View Details</span>}
          onClick={() => openDrill("Pending Put Away", ["SRV", "GRN", "Part No", "Qty"], vm.pending.map((p) => [p.srv, p.grn, p.no, fmtInt(p.qty)]))} />
        <Kpi label="Short Parts (< 1 Day)" value={fmtInt(K.shortParts)} icon={AlertTriangle} color={C.red}
          sub={<span className={tag(R.shortParts)}>{R.shortParts ? "live" : "View Details"}</span>}
          onClick={() => openDrill("Short Parts (< 1 Day)", ["Part No", "Description", "Qty"], vm.top5.slice(0, 3).map((t) => [t.no, t.desc, fmtInt(t.qty)]))} />
        <Kpi label="Excess Parts" value={fmtInt(K.excessParts)} icon={Boxes} color={C.cyan}
          sub={<span className={tag(R.excessParts)}>{R.excessParts ? "live" : "View Details"}</span>}
          onClick={() => openDrill("Excess Parts", ["Part No", "Description", "Qty"], vm.top5.map((t) => [t.no, t.desc, fmtInt(t.qty)]))} />
      </section>

      {/* Charts row */}
      <section className="grid grid-cols-3 gap-[1.1vh] min-h-0" style={{ flex: "27 0 0" }}>
        <Panel title="Live Stock by Part Category">
          <div className="flex h-full items-center gap-[1vh]">
            <div className="relative h-full" style={{ width: "45%" }}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={vm.category} dataKey="value" nameKey="name" innerRadius="62%" outerRadius="92%" paddingAngle={2} stroke="none">
                    {vm.category.map((c) => <Cell key={c.name} fill={c.color} />)}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
              <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                <span className="text-[2.4vh] font-extrabold text-white">{fmtInt(vm.category.reduce((s, c) => s + c.value, 0))}</span>
                <span className="text-[1.2vh] text-slate-400">Total Parts</span>
              </div>
            </div>
            <div className="flex-1 flex flex-col justify-center gap-[0.7vh]">
              {vm.category.map((c) => {
                const total = vm.category.reduce((s, x) => s + x.value, 0);
                return (
                  <div key={c.name} className="flex items-center gap-[0.8vh] text-[1.35vh]">
                    <span className="rounded-full" style={{ width: "1.2vh", height: "1.2vh", background: c.color }} />
                    <span className="text-slate-300 flex-1 truncate">{c.name}</span>
                    <span className="font-semibold text-white tabular-nums">{fmtInt(c.value)}</span>
                    <span className="text-slate-500 w-[5vh] text-right tabular-nums">{((c.value / total) * 100).toFixed(1)}%</span>
                  </div>
                );
              })}
            </div>
          </div>
        </Panel>

        <Panel title="Stock Status Overview">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={vm.status} margin={{ top: 8, right: 6, left: -18, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
              <XAxis dataKey="name" tick={{ fill: "#94a3b8", fontSize: 10 }} tickLine={false} axisLine={{ stroke: C.border }} />
              <YAxis tick={{ fill: "#94a3b8", fontSize: 10 }} tickLine={false} axisLine={false} />
              <Tooltip contentStyle={{ background: C.panel2, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12, color: "#e2e8f0" }} cursor={{ fill: "#ffffff08" }} />
              <Bar dataKey="Available" fill={C.green} radius={[3, 3, 0, 0]} />
              <Bar dataKey="Short" fill={C.red} radius={[3, 3, 0, 0]} />
              <Bar dataKey="Excess" fill={C.amber} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Panel>

        <Panel title="Consumption Trend (Last 7 Days)">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={vm.trend} margin={{ top: 8, right: 10, left: -18, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
              <XAxis dataKey="d" tick={{ fill: "#94a3b8", fontSize: 10 }} tickLine={false} axisLine={{ stroke: C.border }} />
              <YAxis tick={{ fill: "#94a3b8", fontSize: 10 }} tickLine={false} axisLine={false} />
              <Tooltip contentStyle={{ background: C.panel2, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12, color: "#e2e8f0" }} />
              <Line type="monotone" dataKey="qty" stroke={C.blue} strokeWidth={2.5} dot={{ r: 3, fill: C.blue }} activeDot={{ r: 5 }} />
            </LineChart>
          </ResponsiveContainer>
        </Panel>
      </section>

      {/* Mid row */}
      <section className="grid grid-cols-3 gap-[1.1vh] min-h-0" style={{ flex: "27 0 0" }}>
        <Panel title="Top 5 Consumed Parts (This Month)">
          <table className="w-full text-[1.35vh]">
            <thead>
              <tr className="text-slate-500 text-left">
                <th className="font-medium pb-[0.6vh]">Part No.</th>
                <th className="font-medium pb-[0.6vh]">Part Description</th>
                <th className="font-medium pb-[0.6vh] text-right">Consumed Qty</th>
              </tr>
            </thead>
            <tbody>
              {vm.top5.map((t) => (
                <tr key={t.no} className="border-t" style={{ borderColor: C.border }}>
                  <td className="py-[0.7vh] text-slate-300">{t.no}</td>
                  <td className="py-[0.7vh] text-slate-200 truncate">{t.desc}</td>
                  <td className="py-[0.7vh] text-right font-semibold text-white tabular-nums">{fmtInt(t.qty)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <Panel title="Rack Utilization">
          <div className="flex h-full items-center gap-[1vh]">
            <div className="h-full" style={{ width: "52%" }}><RackGauge pct={vm.rack.occupiedPct} /></div>
            <div className="flex-1 flex flex-col justify-center gap-[1.2vh]">
              <div><p className="text-[1.3vh] text-slate-400">Total Racks</p><p className="text-[2.4vh] font-bold text-white">{vm.rack.total}</p></div>
              <div><p className="text-[1.3vh] text-slate-400">Full Racks</p><p className="text-[2.4vh] font-bold" style={{ color: C.red }}>{vm.rack.full}</p></div>
              <div><p className="text-[1.3vh] text-slate-400">Available Racks</p><p className="text-[2.4vh] font-bold" style={{ color: C.green }}>{vm.rack.available}</p></div>
            </div>
          </div>
        </Panel>

        <Panel title="Store Transaction Summary (Today)">
          <div className="grid grid-cols-2 gap-[1vh] h-full">
            {vm.txns.map((t) => (
              <button key={t.key} type="button"
                onClick={() => openDrill(t.label, ["Reference", "Type", "Qty"], vm.pending.map((p) => [p.grn, t.label, fmtInt(p.qty)]))}
                className="flex flex-col items-center justify-center rounded-[0.8vh] border transition-colors hover:border-slate-500"
                style={{ borderColor: C.border, background: C.panel2 }}>
                <span className="rounded-full p-[1vh] mb-[0.5vh]" style={{ background: `${t.color}22`, color: t.color }}>
                  <t.icon style={{ width: "2.4vh", height: "2.4vh" }} />
                </span>
                <span className="text-[1.3vh] text-slate-300 text-center px-[0.5vh] leading-tight">{t.label}</span>
                <span className="text-[2.6vh] font-extrabold text-white leading-tight">{t.value}</span>
                <span className="text-[1.1vh] text-slate-500">{t.unit}</span>
              </button>
            ))}
          </div>
        </Panel>
      </section>

      {/* Bottom row */}
      <section className="grid gap-[1.1vh] min-h-0" style={{ flex: "23 0 0", gridTemplateColumns: "1fr 1.6fr 1fr" }}>
        <Panel title="Recent Alerts"
          action={<span className="text-[1.2vh] text-slate-500 cursor-pointer hover:text-slate-300"
            onClick={() => openDrill("All Alerts", ["Alert", "Time"], vm.alerts.map((a) => [a.text, a.time]))}>View All</span>}>
          <div className="flex flex-col gap-[0.8vh] h-full justify-center">
            {vm.alerts.map((a, i) => (
              <div key={i} className="flex items-center gap-[0.8vh] text-[1.35vh]">
                <span className="rounded-full shrink-0" style={{ width: "1vh", height: "1vh", background: ALERT_DOT[a.tone] }} />
                <span className="text-slate-200 flex-1 truncate">{a.text}</span>
                <span className="text-slate-500 tabular-nums">{a.time}</span>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Pending Put Away List"
          action={<span className="text-[1.2vh] text-slate-500 cursor-pointer hover:text-slate-300"
            onClick={() => openDrill("Pending Put Away List", ["SRV No", "GRN No", "Part No", "Description", "Qty", "Date"],
              vm.pending.map((p) => [p.srv, p.grn, p.no, p.desc, fmtInt(p.qty), p.date]))}>View All</span>}>
          <table className="w-full text-[1.3vh]">
            <thead>
              <tr className="text-slate-500 text-left">
                <th className="font-medium pb-[0.6vh]">SRV No.</th>
                <th className="font-medium pb-[0.6vh]">GRN No.</th>
                <th className="font-medium pb-[0.6vh]">Part No.</th>
                <th className="font-medium pb-[0.6vh]">Description</th>
                <th className="font-medium pb-[0.6vh] text-right">Qty</th>
                <th className="font-medium pb-[0.6vh] text-center">Status</th>
              </tr>
            </thead>
            <tbody>
              {vm.pending.map((p) => (
                <tr key={p.srv} className="border-t" style={{ borderColor: C.border }}>
                  <td className="py-[0.7vh] text-slate-300">{p.srv}</td>
                  <td className="py-[0.7vh] text-slate-300">{p.grn}</td>
                  <td className="py-[0.7vh] text-slate-300">{p.no}</td>
                  <td className="py-[0.7vh] text-slate-200 truncate">{p.desc}</td>
                  <td className="py-[0.7vh] text-right text-white tabular-nums">{fmtInt(p.qty)}</td>
                  <td className="py-[0.7vh] text-center">
                    <span className="rounded px-[0.8vh] py-[0.2vh] text-[1.1vh] font-semibold" style={{ background: `${C.amber}22`, color: C.amber }}>Pending</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <Panel title="Quick Actions">
          <div className="grid grid-cols-3 gap-[0.9vh] h-full">
            {QUICK_ACTIONS.map((q) => (
              <button key={q.label} type="button" onClick={() => navigate(q.to)}
                className="flex flex-col items-center justify-center rounded-[0.8vh] border transition-colors hover:border-slate-500 p-[0.6vh]"
                style={{ borderColor: C.border, background: C.panel2 }}>
                <q.icon style={{ width: "2.4vh", height: "2.4vh" }} className="text-slate-300 mb-[0.5vh]" />
                <span className="text-[1.15vh] text-slate-300 text-center leading-tight">{q.label}</span>
              </button>
            ))}
          </div>
        </Panel>
      </section>

      {/* Drill-down popup */}
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
