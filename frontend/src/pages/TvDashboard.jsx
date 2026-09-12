import React, { useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer, PieChart, Pie, Cell, ComposedChart, BarChart, Bar, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from "recharts";
import {
  Box, Database, AlertTriangle, Boxes, ClipboardList, ShoppingCart,
  FileBarChart, PackagePlus, Sun, Moon, ArrowLeft,
  Maximize, Minimize,
} from "lucide-react";
import { spareStockService } from "../services/spareStockService.js";
import { storeService } from "../services/storeService.js";

// A full-screen wallboard for a 64" PORTRAIT LED — no menu, no scroll, a tall
// single-store (Spare) board. Real figures come from the spare-stock API; the
// header switches between the store's sections (auto-rotating on the wall).
const REFRESH_MS = 30000;

const C = {
  blue: "#2563eb", green: "#059669", red: "#dc2626", amber: "#d97706",
  purple: "#7c3aed", cyan: "#0891b2", slate: "#334155",
};
const PIE = [C.blue, C.green, C.amber, C.purple, C.cyan, "#ec4899", C.red];

// Demo-only sections so the switcher can be shown before the real section
// master is filled in. Delete once real sections exist in the store master.
const DUMMY_SECTIONS = [
  { id: -101, name: "Maintenance", dummy: true },
  { id: -102, name: "Sensor", dummy: true },
  { id: -103, name: "Cylinder", dummy: true },
];

const fmtInt = (n) => (n == null ? "—" : Number(n).toLocaleString("en-IN"));
const fmtMoney = (v) => {
  if (v == null) return "—";
  if (v >= 1e7) return `₹ ${(v / 1e7).toFixed(2)} Cr`;
  if (v >= 1e5) return `₹ ${(v / 1e5).toFixed(2)} L`;
  return `₹ ${Number(v).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
};
const monthLabel = (period) => {
  // "2026-09" -> "Sep"
  const [y, m] = (period || "").split("-");
  const names = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return m ? names[Number(m)] || period : (y || period);
};
const timeOf = (iso) => (iso ? new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "—");

// ---- small building blocks -------------------------------------------------

function Card({ children, className = "", style }) {
  return (
    <div className={`rounded-2xl bg-[var(--dx-card)] border border-[var(--dx-border)] shadow-[0_1px_3px_rgba(15,31,56,0.06),0_6px_20px_rgba(15,31,56,0.05)] ${className}`} style={style}>
      {children}
    </div>
  );
}

function PanelHead({ icon: Icon, color, title, action, onAction }) {
  return (
    <div className="flex items-center justify-between mb-3">
      <div className="flex items-center gap-2.5">
        <span className="w-9 h-9 rounded-lg flex items-center justify-center" style={{ background: `${color}1a` }}>
          <Icon size={20} style={{ color }} />
        </span>
        <h3 className="text-[1.6vh] font-bold text-[var(--dx-t1)]">{title}</h3>
      </div>
      {action && (
        <button onClick={onAction} className="text-[1.35vh] font-semibold flex items-center gap-1" style={{ color }}>
          {action} <span>→</span>
        </button>
      )}
    </div>
  );
}

function Kpi({ icon: Icon, title, value, trend, trendUp = true, sub, color, onClick }) {
  return (
    <Card className="p-[1.6vh] flex flex-col">
      <div className="flex items-start justify-between">
        <span className="w-[5.2vh] h-[5.2vh] rounded-full flex items-center justify-center shadow-sm" style={{ background: color }}>
          <Icon size={26} className="text-white" />
        </span>
        <FileBarChart size={20} className="opacity-25" style={{ color }} />
      </div>
      <div className="mt-[1vh] text-[1.55vh] font-bold text-[var(--dx-t2)]">{title}</div>
      <div className="flex items-end gap-[1vh]">
        <span className="text-[4vh] font-extrabold leading-none text-[var(--dx-t1)]">{value}</span>
        {trend != null && (
          <span className={`text-[1.5vh] font-bold ${trendUp ? "text-emerald-600" : "text-rose-600"}`}>
            {trendUp ? "↑" : "↓"} {trend}
          </span>
        )}
      </div>
      <div className="text-[1.3vh] text-[var(--dx-t4)] mt-[0.4vh]">{sub}</div>
      <button onClick={onClick}
        className="mt-[1.2vh] rounded-lg text-white text-[1.45vh] font-bold py-[1vh] transition hover:brightness-110 active:scale-[0.98]"
        style={{ background: color }}>
        <span className="cta-blink">View Details →</span>
      </button>
    </Card>
  );
}

function Gauge({ pct, color, label, sub }) {
  const p = Math.max(0, Math.min(100, pct || 0));
  return (
    <div className="flex flex-col items-center">
      <svg viewBox="0 0 120 68" className="w-[15vh]">
        <path d="M12 60 A48 48 0 0 1 108 60" fill="none" style={{ stroke: "var(--dx-gauge)" }} strokeWidth="13" strokeLinecap="round" pathLength="100" />
        <path d="M12 60 A48 48 0 0 1 108 60" fill="none" stroke={color} strokeWidth="13" strokeLinecap="round" pathLength="100" strokeDasharray={`${p} 100`} />
        <text x="60" y="54" textAnchor="middle" fontSize="26" fontWeight="800" style={{ fill: "var(--dx-t1)" }}>{Math.round(p)}%</text>
      </svg>
      <div className="text-center -mt-[0.6vh]">
        <div className="text-[1.5vh] font-bold flex items-center justify-center gap-1.5" style={{ color }}>
          <span className="w-[1vh] h-[1vh] rounded-full inline-block" style={{ background: color }} />{label}
        </div>
        <div className="text-[1.25vh] text-[var(--dx-t3)]">{sub}</div>
      </div>
    </div>
  );
}

function DeptBar({ name, value, pct, color }) {
  return (
    <div className="flex items-center gap-[1vh]">
      <span className="w-[13vh] text-[1.4vh] font-medium text-[var(--dx-t2)] truncate">{name}</span>
      <div className="flex-1 h-[1.6vh] rounded-full bg-[var(--dx-track)] overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="w-[5vh] text-right text-[1.45vh] font-bold text-[var(--dx-t1)]">{fmtInt(value)}</span>
      <span className="w-[4vh] text-right text-[1.35vh] text-[var(--dx-t4)]">{Math.round(pct)}%</span>
    </div>
  );
}

// ---- main ------------------------------------------------------------------

export default function TvDashboard() {
  const [data, setData] = useState({});
  const [now, setNow] = useState(() => new Date());
  const [sections, setSections] = useState([]);
  const [sectionId, setSectionId] = useState(null);
  const [isFs, setIsFs] = useState(false);
  const [stack, setStack] = useState([]); // Explore-Data drill frames (in-board)
  const [shiftOverride, setShiftOverride] = useState(null); // null = follow the clock; true = day, false = night

  const toggleFs = () => (document.fullscreenElement ? document.exitFullscreen?.() : document.documentElement.requestFullscreen?.());

  // clock
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    const on = () => setIsFs(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);

  // sections (real + dummy)
  useEffect(() => {
    let alive = true;
    const check = () => storeService.list()
      .then((r) => {
        if (!alive) return;
        const stores = r.data.data || [];
        const real = (stores.find((s) => s.code === "MAINTENANCE") || {}).sections || [];
        setSections([...real, ...DUMMY_SECTIONS]);
      })
      .catch(() => setSections([...DUMMY_SECTIONS]));
    check();
    const id = setInterval(check, REFRESH_MS);
    return () => { alive = false; clearInterval(id); };
  }, []);

  // land on the first section, never a stale id
  useEffect(() => {
    setSectionId((cur) => {
      if (sections.length && (cur == null || !sections.some((s) => s.id === cur))) return sections[0].id;
      return cur;
    });
  }, [sections]);

  // Sections change only when someone taps ‹ / › — no auto-rotation.
  const sectionOpts = useMemo(() => sections.map((s) => s.id), [sections]);

  // Section-scoped data — refetched ONLY when the section changes, kept light (6
  // calls) so switching sections is snappy. Waits for the first section to be
  // picked so we don't fire a whole-store load that a section load replaces.
  useEffect(() => {
    if (sectionId == null) return undefined;
    let alive = true;
    const g = (pr) => pr.then((r) => r.data.data).catch(() => null);
    const load = async () => {
      const sec = sectionId;
      const [sum, ana, today, list, monthly, dept] = await Promise.all([
        g(spareStockService.summary("MAINTENANCE", sec)),
        g(spareStockService.analytics("MAINTENANCE", sec)),
        g(spareStockService.today("MAINTENANCE", sec)),
        g(spareStockService.list({ store_code: "MAINTENANCE", section_id: sec })),
        g(spareStockService.consumptionByPeriod("MAINTENANCE", "month", sec)),
        g(spareStockService.consumption("MAINTENANCE", "department", sec)),
      ]);
      if (!alive) return;
      setData((d) => ({ ...d, sum, ana, today, list: Array.isArray(list) ? list : [], monthly: monthly || [], dept: dept || [] }));
    };
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => { alive = false; clearInterval(id); };
  }, [sectionId]);

  // Store-wide data — fetched once (and on the refresh cadence), NOT per section,
  // so switching sections never re-pulls the heavy ERP list. The ERP match
  // summary is derived here instead of a second server call.
  useEffect(() => {
    let alive = true;
    const g = (pr) => pr.then((r) => r.data.data).catch(() => null);
    const load = async () => {
      const [activity, pending, erpPend, erpGapRaw] = await Promise.all([
        g(spareStockService.activity("MAINTENANCE", 6)),
        g(spareStockService.pendingConfirmations("MAINTENANCE")),
        g(spareStockService.erpPending("MAINTENANCE")),
        g(spareStockService.erpGap("MAINTENANCE")),
      ]);
      if (!alive) return;
      const erpGap = Array.isArray(erpGapRaw) ? erpGapRaw : [];
      const reconciled = erpGap.filter((r) => r.gap_qty != null);
      const matched = reconciled.filter((r) => r.status === "MATCH").length;
      const erpSum = {
        total: erpGap.length, matched,
        short: erpGap.filter((r) => r.status === "SHORT").length,
        excess: erpGap.filter((r) => r.status === "EXCESS").length,
        no_physical: erpGap.filter((r) => r.status === "NO_PHYSICAL").length,
        not_synced: erpGap.filter((r) => r.status === "NOT_SYNCED").length,
        accuracy_pct: reconciled.length ? Math.round((matched / reconciled.length) * 10000) / 100 : null,
      };
      setData((d) => ({ ...d, activity: activity || [], pending: pending || [], erpPend, erpGap, erpSum }));
    };
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const P = data;
  const rows = P.list || [];
  const dist = useMemo(() => Object.fromEntries((P.ana?.status_distribution || []).map((s) => [s.name, s.value])), [P.ana]);
  const healthy = dist["Healthy"] || 0;
  const short = (dist["Below Minimum"] || 0) + (dist["Zero Stock"] || 0);
  const excess = dist["Above Maximum"] || 0;
  const counted = healthy + short + excess || 1;
  const total = P.sum?.total_parts ?? rows.length;

  const cats = useMemo(() => {
    const by = {};
    rows.forEach((r) => { const c = r.sub_category || "Others"; by[c] = (by[c] || 0) + 1; });
    const arr = Object.entries(by).sort((a, b) => b[1] - a[1]);
    const top = arr.slice(0, 5).map(([name, value], i) => ({ name, value, color: PIE[i % PIE.length] }));
    const rest = arr.slice(5).reduce((s, [, v]) => s + v, 0);
    if (rest > 0) top.push({ name: "Others", value: rest, color: "#94a3b8" });
    return top;
  }, [rows]);

  const monthlyData = useMemo(
    () => (P.monthly || []).slice(-6).map((m) => ({ name: monthLabel(m.period), qty: Math.round(m.qty || 0) })),
    [P.monthly],
  );

  const deptData = useMemo(() => {
    const all = P.dept || [];
    // Denominator is the WHOLE month's issuance, not just the top-5 subtotal, so
    // each department's % is its real share of consumption.
    const totAll = all.reduce((s, d) => s + (d.value || 0), 0) || 1;
    return all.slice().sort((a, b) => b.value - a.value).slice(0, 5)
      .map((d, i) => ({ name: d.name, value: Math.round(d.value || 0), pct: ((d.value || 0) / totAll) * 100, color: PIE[i % PIE.length] }));
  }, [P.dept]);

  const topShort = useMemo(
    () => rows.filter((r) => r.status === "Below Minimum" || r.status === "Out of Stock")
      .sort((a, b) => ((b.min_stock_level || 0) - (b.qty_on_hand || 0)) - ((a.min_stock_level || 0) - (a.qty_on_hand || 0)))
      .slice(0, 5),
    [rows],
  );

  // ERP current stock (store-wide) + its match against the store's physical count.
  const erpRows = P.erpGap || [];
  const erpTotal = erpRows.reduce((s, r) => s + (r.erp_qty || 0), 0);
  const physTotal = erpRows.reduce((s, r) => s + (r.physical_qty || 0), 0);
  const erpGapCount = (P.erpSum?.short || 0) + (P.erpSum?.excess || 0);
  const erpSyncedAt = erpRows.find((r) => r.erp_synced_at)?.erp_synced_at;

  const activeSection = sections.find((s) => s.id === sectionId);
  const activeName = activeSection?.name || sections[0]?.name || "—";

  // Live Alerts — derived from the board's own real spare figures (there is no
  // spare notification feed yet), so the panel always shows what needs eyes.
  const pendingCount = (P.pending || []).length;
  const outOfStock = dist["Zero Stock"] || 0;
  const belowMin = dist["Below Minimum"] || 0;
  const liveAlerts = [];
  if (outOfStock) liveAlerts.push({ color: C.red, text: `${outOfStock} part${outOfStock > 1 ? "s" : ""} OUT OF STOCK`,
    onClick: () => openStack({ kind: "partList", title: "Out of Stock", rows: rows.filter((r) => r.status === "Out of Stock"), valueLabel: "Stock", valueOf: (r) => r.qty_on_hand }) });
  if (belowMin) liveAlerts.push({ color: C.red, text: `${belowMin} part${belowMin > 1 ? "s" : ""} below minimum`,
    onClick: () => openStack({ kind: "partList", title: "Short Parts", rows: rows.filter((r) => r.status === "Below Minimum"), valueLabel: "Short by", valueOf: (r) => Math.max(0, (r.min_stock_level || 0) - (r.qty_on_hand || 0)) }) });
  if (excess) liveAlerts.push({ color: C.amber, text: `${excess} part${excess > 1 ? "s" : ""} above maximum (excess)`,
    onClick: () => openStack({ kind: "partList", title: "Excess Parts", rows: rows.filter((r) => r.status === "Above Maximum"), valueLabel: "Excess by", valueOf: (r) => Math.max(0, (r.qty_on_hand || 0) - (r.max_stock_level || 0)) }) });
  if (pendingCount) liveAlerts.push({ color: C.purple, text: `${pendingCount} issue${pendingCount > 1 ? "s" : ""} awaiting user confirmation` });
  if (erpGapCount) liveAlerts.push({ color: C.cyan, text: `${erpGapCount} part${erpGapCount > 1 ? "s" : ""} differ from ERP`, onClick: () => openErpGap() });
  const cycle = (dir) => {
    setSectionId((cur) => {
      const i = Math.max(0, sectionOpts.findIndex((o) => o === cur));
      return sectionOpts[(i + dir + sectionOpts.length) % sectionOpts.length];
    });
  };

  // In-board drill: Explore Data opens a full-screen view WITHIN the board
  // (it never leaves the dashboard) — a parts list with a chart, and each part
  // drills into its own stock-history charts + movement ledger.
  const openStack = (frame) => setStack([frame]);
  const pushFrame = (frame) => setStack((s) => [...s, frame]);
  const popTo = (i) => setStack((s) => s.slice(0, i + 1));
  const openHistory = async (part) => {
    const h = await spareStockService.history(part.part_id, 100).then((r) => r.data.data).catch(() => []);
    pushFrame({ kind: "partHistory", title: part.part_no, part, history: Array.isArray(h) ? h : [] });
  };
  // A transaction feed drill (for Today's Issue / Pending ERP) — off the ledger.
  const openTxns = async (title, opts = {}) => {
    const a = await spareStockService.activity("MAINTENANCE", 60).then((r) => r.data.data).catch(() => []);
    let list = Array.isArray(a) ? a : [];
    if (opts.filter) list = list.filter(opts.filter);
    openStack({ kind: "txnList", title, rows: list, note: opts.note, deptData: opts.deptData });
  };
  const openErpGap = () => openStack({ kind: "erpGap", title: "Current Stock — ERP vs Physical", rows: erpRows, summary: P.erpSum });

  const clock = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const dayNum = now.toLocaleDateString("en-GB", { day: "2-digit" });
  const monthShort = now.toLocaleDateString("en-GB", { month: "short" }).toUpperCase();
  const weekday = now.toLocaleDateString("en-GB", { weekday: "short" });
  const yearNum = now.getFullYear();
  const autoDay = now.getHours() >= 8 && now.getHours() < 20;
  const isDay = shiftOverride == null ? autoDay : shiftOverride;
  // Whole-board theme, flipped by the day/night button. Every surface/text below
  // reads these CSS variables, so one switch re-themes the entire dashboard.
  const themeVars = isDay
    ? { "--dx-bg": "#eef2f7", "--dx-card": "#ffffff", "--dx-border": "rgba(226,232,240,0.85)", "--dx-t1": "#0f172a", "--dx-t2": "#334155", "--dx-t3": "#64748b", "--dx-t4": "#94a3b8", "--dx-track": "#f1f5f9", "--dx-divide": "#eef2f7", "--dx-gauge": "#e5e7eb" }
    : { "--dx-bg": "#0a1424", "--dx-card": "#111c30", "--dx-border": "rgba(148,163,184,0.16)", "--dx-t1": "#f1f5f9", "--dx-t2": "#cbd5e1", "--dx-t3": "#94a3b8", "--dx-t4": "#7c8aa0", "--dx-track": "#1b2740", "--dx-divide": "rgba(148,163,184,0.12)", "--dx-gauge": "#334155" };
  // recharts axis/grid become SVG attributes and can't read CSS vars, so keep JS
  // twins of the theme for chart ticks and gridlines (readable in both modes).
  const axisColor = isDay ? "#64748b" : "#94a3b8";
  const gridColor = isDay ? "#e2e8f0" : "rgba(148,163,184,0.18)";

  return (
    <div className="min-h-screen w-full flex flex-col gap-[1.4vh] p-[1.4vh] bg-[var(--dx-bg)] text-[var(--dx-t2)] transition-colors duration-300" style={themeVars}>

      {/* ---------- header ---------- */}
      <div className="rounded-2xl px-[2vh] py-[1.4vh] flex items-center gap-[2vh] text-white"
        style={{ background: "linear-gradient(120deg,#0a2a4f 0%,#0d3a6b 55%,#0a2a4f 100%)" }}>
        <img src="/toyota-boshoku-logo.png" alt="Toyota Boshoku" className="h-[5.4vh] w-auto bg-white/95 rounded-lg p-[0.5vh] shrink-0" draggable={false} />
        <div className="hidden xl:block leading-tight shrink-0">
          <div className="text-[1.6vh] font-bold">Toyota Boshoku</div>
          <div className="text-[1.2vh] text-white/60">Device India Pvt. Ltd.</div>
        </div>

        <div className="flex-1 text-center min-w-0">
          <div className="text-[3.4vh] font-extrabold leading-none">Spare Parts Store</div>
          <div className="text-[1.5vh] font-semibold tracking-[0.4em] text-white/70 mt-[0.3vh]">LIVE DASHBOARD</div>
          {sections.length > 0 && (
            <div className="mt-[0.9vh] flex items-center justify-center gap-[1.2vh]">
              <button onClick={() => cycle(-1)} title="Previous section" className="text-white/50 hover:text-white text-[2.6vh] leading-none">‹</button>
              <div className="flex items-center gap-[0.7vh]">
                <span key={String(sectionId)} className="animate-rise text-[2.3vh] font-extrabold text-white tracking-wide uppercase">{activeName}</span>
                {activeSection?.dummy && <span className="text-[1vh] font-bold px-[0.6vh] py-[0.1vh] rounded bg-amber-300 text-amber-900">dummy</span>}
              </div>
              <button onClick={() => cycle(1)} title="Next section" className="text-white/50 hover:text-white text-[2.6vh] leading-none">›</button>
            </div>
          )}
        </div>

        {/* modern date · clock · shift toggle */}
        <div className="shrink-0 flex items-center gap-[1.5vh] rounded-2xl px-[1.6vh] py-[1.1vh]"
          style={{ background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.14)" }}>
          <div className="flex items-center gap-[1vh]">
            <div className="w-[5vh] h-[5vh] rounded-xl bg-white flex flex-col items-center justify-center leading-none shrink-0 shadow-md">
              <span className="text-[1vh] font-extrabold text-rose-500 uppercase tracking-widest">{monthShort}</span>
              <span className="text-[2.4vh] font-extrabold text-[#0f172a]">{dayNum}</span>
            </div>
            <div className="text-left leading-tight">
              <div className="text-[1.55vh] font-bold text-white">{weekday}</div>
              <div className="text-[1.15vh] text-white/50">{yearNum}</div>
            </div>
          </div>
          <div className="w-px h-[4.6vh] bg-white/15" />
          <div className="text-center leading-tight">
            <div className="text-[3.3vh] font-extrabold tabular-nums leading-none">{clock}</div>
            <button onClick={() => setShiftOverride(!isDay)}
              title={isDay ? "Day shift — click to switch to night" : "Night shift — click to switch to day"}
              className="mt-[0.7vh] inline-flex items-center justify-center rounded-full w-[3.6vh] h-[3.6vh] text-white shadow-md transition hover:brightness-110 active:scale-90"
              style={{ background: isDay ? "#10b981" : "#6366f1" }}>
              {isDay ? <Sun size={19} /> : <Moon size={19} />}
            </button>
          </div>
        </div>

        <div className="shrink-0">
          <button onClick={toggleFs} title={isFs ? "Exit fullscreen" : "Fullscreen"} className="text-white/60 hover:text-white">{isFs ? <Minimize size={16} /> : <Maximize size={16} />}</button>
        </div>
      </div>

      {/* ---------- live alert ticker (below the heading) ---------- */}
      {liveAlerts.length > 0 && (
        <div className="shrink-0 flex items-center gap-[1.2vh] overflow-hidden rounded-xl px-[1.2vh] py-[0.8vh] text-white"
          style={{ background: "linear-gradient(90deg,#0a2a4f,#0d3a6b)" }}>
          <span className="shrink-0 flex items-center gap-[0.6vh] rounded-md px-[1.1vh] py-[0.35vh] text-[1.35vh] font-extrabold tracking-wide" style={{ background: "#dc2626" }}>
            <span className="h-[1vh] w-[1vh] rounded-full bg-white animate-pulse" /> LIVE ALERTS
          </span>
          <div className="relative flex-1 overflow-hidden">
            <div className="ticker-track-x flex w-max items-center gap-[3.5vh] whitespace-nowrap"
              style={{ "--ticker-duration": `${Math.max(20, liveAlerts.length * 9)}s` }}>
              {[...liveAlerts, ...liveAlerts].map((a, i) => (
                <span key={i} className="flex items-center gap-[0.8vh] text-[1.55vh] font-semibold">
                  <span className="h-[1.1vh] w-[1.1vh] shrink-0 rounded-full" style={{ background: a.color, boxShadow: `0 0 0.7vh ${a.color}` }} />
                  {a.text}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ---------- KPI cards ---------- */}
      <div className="grid grid-cols-3 gap-[1.4vh]">
        <Kpi icon={Box} title="Total Parts" value={fmtInt(total)} trend={P.today?.received_lines ? `+${P.today.received_lines}` : null}
          sub="Active parts in store" color={C.blue}
          onClick={() => openStack({ kind: "partList", title: "All Parts", rows, valueLabel: "Stock", valueOf: (r) => r.qty_on_hand, chart: "byType" })} />
        <Kpi icon={Database} title="Stock Value" value={fmtMoney(P.sum?.stock_value)} sub="As per ERP (Live)" color={C.green}
          onClick={() => openStack({ kind: "partList", title: "Stock Value", rows: rows.filter((r) => r.stock_value != null), valueLabel: "Value", valueOf: (r) => r.stock_value, valueFmt: fmtMoney })} />
        <Kpi icon={AlertTriangle} title="Short Parts" value={fmtInt(short)} sub="Below minimum stock" color={C.red}
          onClick={() => openStack({ kind: "partList", title: "Short Parts", rows: rows.filter((r) => r.status === "Below Minimum" || r.status === "Out of Stock"), valueLabel: "Short by", valueOf: (r) => Math.max(0, (r.min_stock_level || 0) - (r.qty_on_hand || 0)) })} />
        <Kpi icon={Boxes} title="Excess Parts" value={fmtInt(excess)} sub="Above maximum stock" color={C.amber}
          onClick={() => openStack({ kind: "partList", title: "Excess Parts", rows: rows.filter((r) => r.status === "Above Maximum"), valueLabel: "Excess by", valueOf: (r) => Math.max(0, (r.qty_on_hand || 0) - (r.max_stock_level || 0)) })} />
        <Kpi icon={ClipboardList} title="Pending ERP" value={fmtInt(P.erpPend?.pending ?? 0)} sub="Movements pending in ERP" color={C.purple}
          onClick={() => openTxns("Pending ERP", { note: `${fmtInt(P.erpPend?.pending ?? 0)} stock movement(s) queued to push to ERP — every move waits here while the ERP write is off. Tap a row for that part's history.` })} />
        <Kpi icon={ShoppingCart} title="Today's Issue" value={fmtInt(P.today?.issued_qty)} trend={P.today?.issued_lines ? `${P.today.issued_lines} lines` : null}
          sub="Parts issued this shift" color={C.blue}
          onClick={() => openTxns("Today's Issue", { filter: (r) => r.txn_type === "ISSUE", deptData })} />
      </div>

      {/* ---------- charts ---------- */}
      <div className="grid grid-cols-2 gap-[1.4vh]">
        <Card className="p-[1.6vh]">
          <PanelHead icon={PieChartMini} color={C.blue} title="Stock by Part Type" />
          <div className="flex items-center gap-[1vh]">
            <div className="w-[24vh] h-[24vh] relative shrink-0">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={cats.length ? cats : [{ name: "—", value: 1, color: "#e2e8f0" }]} dataKey="value" nameKey="name"
                    innerRadius="62%" outerRadius="92%" paddingAngle={2} stroke="none">
                    {(cats.length ? cats : [{ color: "#e2e8f0" }]).map((c, i) => <Cell key={i} fill={c.color} />)}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
              <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                <span className="text-[3vh] font-extrabold text-[var(--dx-t1)] leading-none">{fmtInt(total)}</span>
                <span className="text-[1.3vh] text-[var(--dx-t4)]">Total Parts</span>
              </div>
            </div>
            <div className="flex-1 space-y-[0.9vh]">
              {(cats.length ? cats : []).map((c) => (
                <div key={c.name} className="flex items-center gap-[1vh] text-[1.5vh]">
                  <span className="w-[1.4vh] h-[1.4vh] rounded-sm" style={{ background: c.color }} />
                  <span className="flex-1 text-[var(--dx-t2)] truncate">{c.name}</span>
                  <span className="font-bold text-[var(--dx-t1)]">{fmtInt(c.value)}</span>
                  <span className="w-[5vh] text-right text-[var(--dx-t4)]">{Math.round((c.value / (total || 1)) * 100)}%</span>
                </div>
              ))}
              {!cats.length && <div className="text-[1.5vh] text-[var(--dx-t4)]">No parts in this section</div>}
            </div>
          </div>
        </Card>

        <Card className="p-[1.6vh]">
          <PanelHead icon={FileBarChart} color={C.green} title="Monthly Consumption / Issue" />
          <div className="h-[24vh]">
            {monthlyData.length ? (
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={monthlyData} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={gridColor} />
                  <XAxis dataKey="name" tick={{ fontSize: 13, fill: axisColor }} axisLine={{ stroke: gridColor }} tickLine={false} />
                  <YAxis tick={{ fontSize: 13, fill: axisColor }} axisLine={false} tickLine={false} width={40} />
                  <Tooltip />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="qty" name="Issued Qty" fill={C.blue} radius={[4, 4, 0, 0]} barSize={26} />
                  <Line type="monotone" dataKey="qty" name="Trend" stroke={C.green} strokeWidth={2.5} dot={{ r: 3, fill: C.green }} />
                </ComposedChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full flex items-center justify-center text-[1.6vh] text-[var(--dx-t4)]">No consumption data yet</div>
            )}
          </div>
        </Card>
      </div>

      {/* ---------- health + dept ---------- */}
      <div className="grid grid-cols-2 gap-[1.4vh]">
        <Card className="p-[1.6vh]">
          <PanelHead icon={HeartMini} color={C.green} title="Stock Health" />
          <div className="flex items-center justify-around pt-[1vh]">
            <Gauge pct={(healthy / counted) * 100} color={C.green} label="Healthy" sub={`${fmtInt(healthy)} Parts`} />
            <Gauge pct={(excess / counted) * 100} color={C.amber} label="Excess" sub={`${fmtInt(excess)} Parts`} />
            <Gauge pct={(short / counted) * 100} color={C.red} label="Short" sub={`${fmtInt(short)} Parts`} />
          </div>
        </Card>

        <Card className="p-[1.6vh]">
          <PanelHead icon={FileBarChart} color={C.purple} title="Department-wise Issue (This Month)" />
          <div className="space-y-[1.1vh] pt-[0.6vh]">
            {deptData.length ? deptData.map((d) => <DeptBar key={d.name} {...d} />)
              : <div className="text-[1.5vh] text-[var(--dx-t4)] py-[3vh] text-center">No issues this month</div>}
          </div>
        </Card>
      </div>

      {/* ---------- ERP current stock ---------- */}
      <Card className="p-[1.6vh]">
        <PanelHead icon={Database} color={C.cyan} title="Current Stock — ERP vs Physical" action="View Details" onAction={openErpGap} />
        <div className="grid grid-cols-4 gap-[1.4vh]">
          {[
            { label: "ERP Stock", value: fmtInt(Math.round(erpTotal)), sub: "units · from ERP", color: C.cyan },
            { label: "Physical Stock", value: fmtInt(Math.round(physTotal)), sub: "units · store count", color: C.blue },
            { label: "Match Accuracy", value: P.erpSum?.accuracy_pct != null ? `${P.erpSum.accuracy_pct}%` : "—", sub: "ERP = physical", color: C.green },
            { label: "With Gap", value: fmtInt(erpGapCount), sub: "short / excess vs ERP", color: C.amber },
          ].map((s) => (
            <div key={s.label} className="rounded-xl p-[1.3vh]" style={{ background: "var(--dx-track)" }}>
              <div className="text-[1.3vh] text-[var(--dx-t3)]">{s.label}</div>
              <div className="mt-[0.4vh] text-[2.7vh] font-extrabold leading-none" style={{ color: s.color }}>{s.value}</div>
              <div className="mt-[0.3vh] text-[1.15vh] text-[var(--dx-t4)]">{s.sub}</div>
            </div>
          ))}
        </div>
        {erpSyncedAt && (
          <div className="mt-[1vh] text-[1.25vh] text-[var(--dx-t4)]">
            ERP snapshot: {new Date(erpSyncedAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })} · updates live once ERP starts pushing spare stock
          </div>
        )}
      </Card>

      {/* ---------- top short parts ---------- */}
      <Card className="p-[1.6vh]">
        <PanelHead icon={AlertTriangle} color={C.red} title="Top Short Parts (Below Minimum)" />
        <table className="w-full text-[1.45vh]">
          <thead>
            <tr className="text-left text-[1.25vh] uppercase tracking-wide text-[var(--dx-t4)] border-b border-[var(--dx-border)]">
              <th className="py-[0.8vh] pr-[1vh]">#</th><th className="pr-[1vh]">Part No.</th><th className="pr-[1vh]">Description</th>
              <th className="pr-[1vh] text-center">Stock</th><th className="pr-[1vh] text-center">Min</th>
              <th className="pr-[1vh] text-center">Short By</th><th className="pr-[1vh]">Location</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--dx-divide)]">
            {topShort.length ? topShort.map((r, i) => (
              <tr key={r.part_id}>
                <td className="py-[0.9vh] pr-[1vh] text-[var(--dx-t4)]">{i + 1}</td>
                <td className="pr-[1vh] font-bold text-[var(--dx-t1)]">{r.part_no}</td>
                <td className="pr-[1vh] text-[var(--dx-t2)] truncate max-w-[26vh]">{r.part_name}</td>
                <td className="pr-[1vh] text-center font-bold text-rose-600">{fmtInt(r.qty_on_hand)}</td>
                <td className="pr-[1vh] text-center text-[var(--dx-t3)]">{fmtInt(r.min_stock_level)}</td>
                <td className="pr-[1vh] text-center">
                  <span className="inline-block rounded-full bg-rose-50 text-rose-600 font-bold px-[1.2vh] py-[0.3vh]">
                    {fmtInt(Math.max(0, (r.min_stock_level || 0) - (r.qty_on_hand || 0)))}
                  </span>
                </td>
                <td className="pr-[1vh] text-[var(--dx-t3)]">{r.location || "—"}</td>
              </tr>
            )) : (
              <tr><td colSpan={7} className="py-[3vh] text-center text-[1.5vh] text-emerald-600 font-semibold">✓ No parts below minimum</td></tr>
            )}
          </tbody>
        </table>
      </Card>

      {/* ---------- recent transactions (Live Alerts now runs in the top ticker) ---------- */}
      <Card className="p-[1.6vh]">
        <PanelHead icon={PackagePlus} color={C.green} title="Recent Transactions" />
        <table className="w-full text-[1.4vh]">
          <thead>
            <tr className="text-left text-[1.2vh] uppercase tracking-wide text-[var(--dx-t4)] border-b border-[var(--dx-border)]">
              <th className="py-[0.7vh] pr-[1vh]">Time</th><th className="pr-[1vh]">Type</th><th className="pr-[1vh]">Part No.</th>
              <th className="pr-[1vh] text-center">Qty</th><th className="pr-[1vh]">Dept.</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--dx-divide)]">
            {(P.activity || []).slice(0, 6).map((r, i) => {
              const issue = r.txn_type === "ISSUE";
              return (
                <tr key={i}>
                  <td className="py-[0.8vh] pr-[1vh] text-[var(--dx-t3)] tabular-nums">{timeOf(r.at || r.created_at)}</td>
                  <td className="pr-[1vh]">
                    <span className={`rounded px-[0.9vh] py-[0.2vh] text-[1.2vh] font-bold ${issue ? "bg-rose-50 text-rose-600" : "bg-emerald-50 text-emerald-600"}`}>{r.txn_type}</span>
                  </td>
                  <td className="pr-[1vh] font-semibold text-[var(--dx-t1)]">{r.part_no}</td>
                  <td className="pr-[1vh] text-center font-bold">{fmtInt(Math.abs(r.qty_delta ?? r.qty ?? 0))}</td>
                  <td className="pr-[1vh] text-[var(--dx-t3)] truncate max-w-[14vh]">{r.department || "—"}</td>
                </tr>
              );
            })}
            {!(P.activity || []).length && <tr><td colSpan={5} className="py-[2.5vh] text-center text-[var(--dx-t4)] text-[1.5vh]">No recent activity</td></tr>}
          </tbody>
        </table>
      </Card>

      {/* ---------- footer ---------- */}
      <div className="rounded-2xl px-[2vh] py-[1.2vh] flex items-center justify-between text-white text-[1.35vh]"
        style={{ background: "linear-gradient(120deg,#0a2a4f,#0d3a6b)" }}>
        <div><span className="font-extrabold text-[1.7vh]">DX Store</span><span className="text-white/60 ml-[1vh]">Digitize · Simplify · Improve</span></div>
        <div className="italic text-white/80 font-semibold">"Right Parts | Right Time | For Smooth Production"</div>
        <div className="text-white/60">Toyota Boshoku Device India Pvt. Ltd.</div>
      </div>

      {/* ---------- Explore-Data drill (opens WITHIN the board) ---------- */}
      {stack.length > 0 && (
        <div className="fixed inset-0 z-50 bg-[var(--dx-bg)] text-[var(--dx-t2)] flex flex-col p-[1.6vh] gap-[1.4vh] overflow-auto" style={themeVars}>
          <div className="rounded-2xl px-[2vh] py-[1.3vh] flex items-center gap-[1.5vh] text-white shrink-0"
            style={{ background: "linear-gradient(120deg,#0a2a4f,#0d3a6b)" }}>
            <button onClick={() => setStack((s) => s.slice(0, -1))} title="Back"
              className="w-[4.4vh] h-[4.4vh] rounded-lg bg-white/10 hover:bg-white/20 flex items-center justify-center"><ArrowLeft size={22} /></button>
            <div className="flex-1 flex items-center gap-[1vh] text-[2.1vh] font-bold min-w-0 flex-wrap">
              {stack.map((f, i) => (
                <React.Fragment key={i}>
                  {i > 0 && <span className="text-white/40">›</span>}
                  <button onClick={() => popTo(i)} className={i === stack.length - 1 ? "text-white" : "text-white/60"}>{f.title}</button>
                </React.Fragment>
              ))}
            </div>
            <button onClick={() => setStack([])} title="Close"
              className="w-[4.4vh] h-[4.4vh] rounded-lg bg-white/10 hover:bg-white/20 flex items-center justify-center text-[2.4vh] leading-none">✕</button>
          </div>
          <div className="flex-1 min-h-0">
            {stack[stack.length - 1].kind === "partHistory"
              ? <PartHistoryView frame={stack[stack.length - 1]} axis={axisColor} grid={gridColor} />
              : stack[stack.length - 1].kind === "txnList"
                ? <TxnListView frame={stack[stack.length - 1]} onOpen={openHistory} axis={axisColor} grid={gridColor} />
                : stack[stack.length - 1].kind === "erpGap"
                  ? <ErpGapView frame={stack[stack.length - 1]} onOpen={openHistory} axis={axisColor} grid={gridColor} />
                  : <PartListView frame={stack[stack.length - 1]} onOpen={openHistory} axis={axisColor} grid={gridColor} />}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Explore-Data drill views ---------------------------------------------

function typeStyle(t) {
  if (t === "ISSUE") return { background: "#fee2e2", color: "#b91c1c" };
  if (t === "RECEIPT") return { background: "#d1fae5", color: "#047857" };
  if (t === "RETURN") return { background: "#dbeafe", color: "#1d4ed8" };
  return { background: "#f1f5f9", color: "#475569" };
}
function StatusPill({ status }) {
  const red = status === "Below Minimum" || status === "Out of Stock";
  const amber = status === "Above Maximum";
  const c = red ? { background: "#fee2e2", color: "#b91c1c" }
    : amber ? { background: "#fef3c7", color: "#b45309" }
      : { background: "#d1fae5", color: "#047857" };
  return <span className="rounded-full px-[1vh] py-[0.2vh] text-[1.2vh] font-bold whitespace-nowrap" style={c}>{status || "—"}</span>;
}
function Stat({ label, value }) {
  return (
    <div className="text-center">
      <div className="text-[1.2vh] text-[var(--dx-t4)]">{label}</div>
      <div className="text-[1.9vh] font-bold text-[var(--dx-t1)]">{value}</div>
    </div>
  );
}

function PartListView({ frame, onOpen, axis = "#64748b", grid = "#e2e8f0" }) {
  const rows = frame.rows || [];
  const valueOf = frame.valueOf || ((r) => r.qty_on_hand || 0);
  const fmtV = frame.valueFmt || fmtInt;
  const top = rows.slice().sort((a, b) => (valueOf(b) || 0) - (valueOf(a) || 0)).slice(0, 10)
    .map((r) => ({ name: r.part_no, value: Math.round(valueOf(r) || 0) }));
  const byType = (() => {
    const by = {};
    rows.forEach((r) => { const c = r.sub_category || "Others"; by[c] = (by[c] || 0) + 1; });
    return Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, value]) => ({ name, value }));
  })();
  const chartData = frame.chart === "byType" ? byType : top;
  const chartTitle = frame.chart === "byType" ? "Parts by type" : `Top 10 by ${frame.valueLabel || "Stock"}`;
  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-[1.4vh] h-full">
      <Card className="p-[1.6vh] flex flex-col">
        <h3 className="text-[1.8vh] font-bold text-[var(--dx-t1)] mb-[1vh]">{chartTitle}</h3>
        <div className="flex-1 min-h-[36vh]">
          {chartData.length ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart layout="vertical" data={chartData} margin={{ left: 8, right: 24, top: 4, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke={grid} />
                <XAxis type="number" tick={{ fontSize: 12, fill: axis }} />
                <YAxis type="category" dataKey="name" width={92} tick={{ fontSize: 12, fill: axis }} />
                <Tooltip />
                <Bar dataKey="value" fill="#2563eb" radius={[0, 4, 4, 0]} barSize={16} />
              </BarChart>
            </ResponsiveContainer>
          ) : <div className="h-full flex items-center justify-center text-[var(--dx-t4)] text-[1.6vh]">No parts</div>}
        </div>
      </Card>
      <Card className="p-[1.6vh] overflow-auto">
        <h3 className="text-[1.8vh] font-bold text-[var(--dx-t1)] mb-[1vh]">{rows.length} parts · tap a row for its history</h3>
        <table className="w-full text-[1.45vh]">
          <thead>
            <tr className="text-left text-[1.2vh] uppercase tracking-wide text-[var(--dx-t4)] border-b border-[var(--dx-border)]">
              <th className="py-[0.7vh] pr-[1vh]">Part No.</th><th className="pr-[1vh]">Description</th>
              <th className="pr-[1vh] text-center">Stock</th><th className="pr-[1vh] text-center">{frame.valueLabel || "Value"}</th>
              <th className="pr-[1vh]">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--dx-divide)]">
            {rows.map((r) => (
              <tr key={r.part_id} onClick={() => onOpen(r)} className="cursor-pointer hover:bg-blue-50/60 transition-colors">
                <td className="py-[0.9vh] pr-[1vh] font-bold text-[var(--dx-t1)]">{r.part_no}</td>
                <td className="pr-[1vh] text-[var(--dx-t2)] truncate max-w-[24vh]">{r.part_name}</td>
                <td className="pr-[1vh] text-center">{fmtInt(r.qty_on_hand)}</td>
                <td className="pr-[1vh] text-center font-semibold text-[var(--dx-t1)]">{fmtV(valueOf(r))}</td>
                <td className="pr-[1vh]"><StatusPill status={r.status} /></td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={5} className="py-[3vh] text-center text-[var(--dx-t4)] text-[1.6vh]">No parts in this section</td></tr>}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function PartHistoryView({ frame, axis = "#64748b", grid = "#e2e8f0" }) {
  const part = frame.part || {};
  const hist = frame.history || [];
  const chart = hist.slice().reverse().map((h) => ({ d: (h.at || h.created_at || "").slice(5, 10), bal: Number(h.balance_after ?? 0) }));
  return (
    <div className="flex flex-col gap-[1.4vh]">
      <Card className="p-[1.6vh]">
        <div className="flex items-center gap-[2vh] flex-wrap">
          <div>
            <div className="text-[1.3vh] text-[var(--dx-t4)]">Part No.</div>
            <div className="text-[2.4vh] font-extrabold text-[var(--dx-t1)] leading-none">{part.part_no}</div>
          </div>
          <div className="text-[1.7vh] text-[var(--dx-t2)]">{part.part_name}</div>
          <div className="ml-auto flex items-center gap-[2.2vh]">
            <Stat label="In Stock" value={fmtInt(part.qty_on_hand)} />
            <Stat label="Min" value={fmtInt(part.min_stock_level)} />
            <Stat label="Max" value={fmtInt(part.max_stock_level)} />
            <Stat label="Value" value={fmtMoney(part.stock_value)} />
            <Stat label="Location" value={part.location || "—"} />
          </div>
        </div>
      </Card>

      <Card className="p-[1.6vh]">
        <h3 className="text-[1.8vh] font-bold text-[var(--dx-t1)] mb-[1vh]">Stock Level History</h3>
        <div className="h-[32vh]">
          {chart.length ? (
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chart} margin={{ top: 8, right: 14, left: -12, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={grid} vertical={false} />
                <XAxis dataKey="d" tick={{ fontSize: 12, fill: axis }} />
                <YAxis tick={{ fontSize: 12, fill: axis }} width={42} />
                <Tooltip />
                <Line type="monotone" dataKey="bal" name="Balance" stroke="#2563eb" strokeWidth={2.5} dot={{ r: 2, fill: "#2563eb" }} />
              </ComposedChart>
            </ResponsiveContainer>
          ) : <div className="h-full flex items-center justify-center text-[var(--dx-t4)] text-[1.6vh]">No movement history yet</div>}
        </div>
      </Card>

      <Card className="p-[1.6vh] overflow-auto">
        <h3 className="text-[1.8vh] font-bold text-[var(--dx-t1)] mb-[1vh]">Movements ({hist.length})</h3>
        <table className="w-full text-[1.4vh]">
          <thead>
            <tr className="text-left text-[1.2vh] uppercase tracking-wide text-[var(--dx-t4)] border-b border-[var(--dx-border)]">
              <th className="py-[0.7vh] pr-[1vh]">Date</th><th className="pr-[1vh]">Type</th>
              <th className="pr-[1vh] text-center">Qty</th><th className="pr-[1vh] text-center">Balance</th>
              <th className="pr-[1vh]">Dept</th><th className="pr-[1vh]">Machine</th><th className="pr-[1vh]">By</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--dx-divide)]">
            {hist.map((h, i) => (
              <tr key={i}>
                <td className="py-[0.7vh] pr-[1vh] text-[var(--dx-t3)] tabular-nums">{(h.at || h.created_at || "").slice(0, 10)}</td>
                <td className="pr-[1vh]"><span className="rounded px-[0.9vh] py-[0.2vh] text-[1.2vh] font-bold" style={typeStyle(h.txn_type)}>{h.txn_type}</span></td>
                <td className="pr-[1vh] text-center font-semibold">{fmtInt(h.qty_delta)}</td>
                <td className="pr-[1vh] text-center">{fmtInt(h.balance_after)}</td>
                <td className="pr-[1vh] text-[var(--dx-t3)]">{h.department || "—"}</td>
                <td className="pr-[1vh] text-[var(--dx-t3)]">{h.machine || "—"}</td>
                <td className="pr-[1vh] text-[var(--dx-t3)]">{h.created_by || h.confirmed_by || "—"}</td>
              </tr>
            ))}
            {!hist.length && <tr><td colSpan={7} className="py-[3vh] text-center text-[var(--dx-t4)] text-[1.6vh]">No movements recorded</td></tr>}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function TxnListView({ frame, onOpen, axis = "#64748b", grid = "#e2e8f0" }) {
  const rows = frame.rows || [];
  const dept = frame.deptData || [];
  return (
    <div className="flex flex-col gap-[1.4vh] h-full">
      {frame.note && (
        <Card className="p-[1.5vh] text-[1.55vh] font-medium text-[var(--dx-t2)] border-l-4" style={{ borderLeftColor: "#7c3aed" }}>{frame.note}</Card>
      )}
      {dept.length > 0 && (
        <Card className="p-[1.6vh]">
          <h3 className="text-[1.8vh] font-bold text-[var(--dx-t1)] mb-[1vh]">Issued qty by department (this month)</h3>
          <div className="h-[22vh]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={dept} margin={{ top: 8, right: 12, left: -14, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={grid} />
                <XAxis dataKey="name" tick={{ fontSize: 12, fill: axis }} />
                <YAxis tick={{ fontSize: 12, fill: axis }} width={40} />
                <Tooltip />
                <Bar dataKey="value" fill="#7c3aed" radius={[4, 4, 0, 0]} barSize={26} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      )}
      <Card className="p-[1.6vh] overflow-auto flex-1">
        <h3 className="text-[1.8vh] font-bold text-[var(--dx-t1)] mb-[1vh]">{rows.length} movement(s) · tap a row for that part's history</h3>
        <table className="w-full text-[1.45vh]">
          <thead>
            <tr className="text-left text-[1.2vh] uppercase tracking-wide text-[var(--dx-t4)] border-b border-[var(--dx-border)]">
              <th className="py-[0.7vh] pr-[1vh]">Date</th><th className="pr-[1vh]">Type</th><th className="pr-[1vh]">Part No.</th>
              <th className="pr-[1vh]">Description</th><th className="pr-[1vh] text-center">Qty</th><th className="pr-[1vh] text-center">Balance</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--dx-divide)]">
            {rows.map((r, i) => (
              <tr key={i} onClick={() => r.part_id && onOpen({ part_id: r.part_id, part_no: r.part_no, part_name: r.part_name })}
                className="cursor-pointer hover:bg-blue-50/60 transition-colors">
                <td className="py-[0.8vh] pr-[1vh] text-[var(--dx-t3)] tabular-nums">{(r.at || "").slice(0, 10)}</td>
                <td className="pr-[1vh]"><span className="rounded px-[0.9vh] py-[0.2vh] text-[1.2vh] font-bold" style={typeStyle(r.txn_type)}>{r.txn_type}</span></td>
                <td className="pr-[1vh] font-bold text-[var(--dx-t1)]">{r.part_no}</td>
                <td className="pr-[1vh] text-[var(--dx-t2)] truncate max-w-[22vh]">{r.part_name}</td>
                <td className="pr-[1vh] text-center font-semibold">{fmtInt(r.qty_delta)}</td>
                <td className="pr-[1vh] text-center">{fmtInt(r.balance_after)}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={6} className="py-[3vh] text-center text-[var(--dx-t4)] text-[1.6vh]">No movements</td></tr>}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function ErpGapView({ frame, onOpen, axis = "#64748b", grid = "#e2e8f0" }) {
  const rows = frame.rows || [];
  const s = frame.summary || {};
  const top = rows.filter((r) => r.gap_qty != null && r.gap_qty !== 0)
    .slice(0, 10).map((r) => ({ name: r.part_no, value: Math.round(Math.abs(r.gap_qty)) }));
  const chips = [
    { k: "matched", label: "Matched", color: "#059669" },
    { k: "short", label: "Short vs ERP", color: "#dc2626" },
    { k: "excess", label: "Excess vs ERP", color: "#d97706" },
    { k: "no_physical", label: "Not counted", color: "#64748b" },
    { k: "not_synced", label: "Not in ERP", color: "#64748b" },
  ];
  const statusStyle = (st) =>
    st === "MATCH" ? { background: "#d1fae5", color: "#047857" }
      : st === "SHORT" ? { background: "#fee2e2", color: "#b91c1c" }
        : st === "EXCESS" ? { background: "#fef3c7", color: "#b45309" }
          : { background: "#f1f5f9", color: "#475569" };
  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-[1.4vh] h-full">
      <Card className="p-[1.6vh] flex flex-col">
        <h3 className="mb-[1vh] text-[1.8vh] font-bold text-[var(--dx-t1)]">Biggest ERP ↔ Physical gaps</h3>
        <div className="min-h-[30vh] flex-1">
          {top.length ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart layout="vertical" data={top} margin={{ left: 8, right: 24, top: 4, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke={grid} />
                <XAxis type="number" tick={{ fontSize: 12, fill: axis }} />
                <YAxis type="category" dataKey="name" width={92} tick={{ fontSize: 12, fill: axis }} />
                <Tooltip />
                <Bar dataKey="value" fill="#0891b2" radius={[0, 4, 4, 0]} barSize={16} />
              </BarChart>
            </ResponsiveContainer>
          ) : <div className="flex h-full items-center justify-center text-[1.6vh] text-[var(--dx-t4)]">No gaps — ERP matches physical</div>}
        </div>
        <div className="mt-[1vh] flex flex-wrap gap-[0.8vh]">
          {chips.map((ch) => (
            <span key={ch.k} className="rounded-full px-[1.2vh] py-[0.3vh] text-[1.3vh] font-bold" style={{ background: `${ch.color}1a`, color: ch.color }}>
              {ch.label}: {fmtInt(s[ch.k] ?? 0)}
            </span>
          ))}
          {s.accuracy_pct != null && (
            <span className="rounded-full px-[1.2vh] py-[0.3vh] text-[1.3vh] font-bold" style={{ background: "#05966922", color: "#047857" }}>Accuracy: {s.accuracy_pct}%</span>
          )}
        </div>
      </Card>
      <Card className="p-[1.6vh] overflow-auto">
        <h3 className="mb-[1vh] text-[1.8vh] font-bold text-[var(--dx-t1)]">{rows.length} parts · tap a row for its history</h3>
        <table className="w-full text-[1.45vh]">
          <thead>
            <tr className="text-left text-[1.2vh] uppercase tracking-wide text-[var(--dx-t4)] border-b border-[var(--dx-border)]">
              <th className="py-[0.7vh] pr-[1vh]">Part No.</th><th className="pr-[1vh]">Description</th>
              <th className="pr-[1vh] text-center">ERP</th><th className="pr-[1vh] text-center">Physical</th>
              <th className="pr-[1vh] text-center">Gap</th><th className="pr-[1vh]">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--dx-divide)]">
            {rows.map((r) => (
              <tr key={r.part_id} onClick={() => onOpen({ part_id: r.part_id, part_no: r.part_no, part_name: r.part_name, location: r.location })}
                className="cursor-pointer transition-colors hover:bg-blue-50/60">
                <td className="py-[0.9vh] pr-[1vh] font-bold text-[var(--dx-t1)]">{r.part_no}</td>
                <td className="pr-[1vh] text-[var(--dx-t2)] truncate max-w-[22vh]">{r.part_name}</td>
                <td className="pr-[1vh] text-center">{r.erp_qty == null ? "—" : fmtInt(r.erp_qty)}</td>
                <td className="pr-[1vh] text-center">{r.physical_qty == null ? "—" : fmtInt(r.physical_qty)}</td>
                <td className="pr-[1vh] text-center font-semibold" style={{ color: r.gap_qty > 0 ? "#d97706" : r.gap_qty < 0 ? "#dc2626" : "#059669" }}>
                  {r.gap_qty == null ? "—" : `${r.gap_qty > 0 ? "+" : ""}${fmtInt(r.gap_qty)}`}
                </td>
                <td className="pr-[1vh]"><span className="rounded-full px-[1vh] py-[0.2vh] text-[1.2vh] font-bold" style={statusStyle(r.status)}>{r.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

// tiny inline icons used in a couple of panel heads (kept local to avoid more imports)
function PieChartMini(props) {
  return <svg viewBox="0 0 24 24" width={props.size || 20} height={props.size || 20} fill="none" stroke={props.style?.color || "currentColor"} strokeWidth="2"><path d="M12 2v10l7 3A10 10 0 1 0 12 2z" /><path d="M12 2a10 10 0 0 1 9 6" /></svg>;
}
function HeartMini(props) {
  return <svg viewBox="0 0 24 24" width={props.size || 20} height={props.size || 20} fill="none" stroke={props.style?.color || "currentColor"} strokeWidth="2"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z" /></svg>;
}
