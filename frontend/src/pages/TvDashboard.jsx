import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ResponsiveContainer, PieChart, Pie, Cell, ComposedChart, BarChart, Bar, Line, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ReferenceLine,
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
// Sentinel section: the combined view over the whole store (no section filter).
const ALL_SECTIONS = "ALL";

const C = {
  blue: "#2563eb", green: "#059669", red: "#dc2626", amber: "#d97706",
  purple: "#7c3aed", cyan: "#0891b2", slate: "#334155",
};
const PIE = [C.blue, C.green, C.amber, C.purple, C.cyan, "#ec4899", C.red];

// Premium look: a soft two-stop gradient per accent, for 3D icon tiles, gradient
// buttons, donut segments and gauges. Falls back to the solid colour if unknown.
const GRAD = {
  "#2563eb": ["#3b82f6", "#2563eb"],
  "#059669": ["#34d399", "#059669"],
  "#dc2626": ["#f43f5e", "#dc2626"],
  "#d97706": ["#f59e0b", "#d97706"],
  "#7c3aed": ["#8b5cf6", "#7c3aed"],
  "#0891b2": ["#22d3ee", "#0891b2"],
  "#ec4899": ["#f472b6", "#ec4899"],
};
const gradCss = (c, deg = 140) => {
  const g = GRAD[c];
  return g ? `linear-gradient(${deg}deg,${g[0]},${g[1]})` : c;
};

const fmtInt = (n) => (n == null ? "—" : Number(n).toLocaleString("en-IN"));
const fmtMoney = (v) => {
  if (v == null) return "—";
  if (v >= 1e7) return `₹ ${(v / 1e7).toFixed(2)} Cr`;
  if (v >= 1e5) return `₹ ${(v / 1e5).toFixed(2)} L`;
  return `₹ ${Number(v).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
};
// Excess-value chart tooltip: the part code, its description, and the money tied up.
function ExcessTip({ active, payload }) {
  if (!active || !payload || !payload.length) return null;
  const d = payload[0].payload || {};
  return (
    <div style={{ background: "rgba(10,20,40,0.96)", border: "1px solid rgba(125,195,255,0.4)", borderRadius: 8, padding: "8px 11px", maxWidth: 340, boxShadow: "0 10px 30px rgba(0,0,0,0.5)" }}>
      <div style={{ color: "#fff", fontWeight: 700, fontSize: 13 }}>{d.name}</div>
      {d.desc ? <div style={{ color: "#b4c5e0", fontSize: 12, marginTop: 2, lineHeight: 1.35 }}>{d.desc}</div> : null}
      <div style={{ color: "#fbbf24", fontWeight: 700, fontSize: 13, marginTop: 5 }}>Excess value: {fmtMoney(d.value)}</div>
    </div>
  );
}
// Generic tooltip for the drill donut: a part's code, description and its value.
function PartValTip({ active, payload, fmt, label }) {
  if (!active || !payload || !payload.length) return null;
  const d = payload[0].payload || {};
  const f = fmt || fmtInt;
  return (
    <div style={{ background: "rgba(10,20,40,0.96)", border: "1px solid rgba(125,195,255,0.4)", borderRadius: 8, padding: "8px 11px", maxWidth: 340, boxShadow: "0 10px 30px rgba(0,0,0,0.5)" }}>
      <div style={{ color: "#fff", fontWeight: 700, fontSize: 13 }}>{d.name}</div>
      {d.desc ? <div style={{ color: "#b4c5e0", fontSize: 12, marginTop: 2, lineHeight: 1.35 }}>{d.desc}</div> : null}
      <div style={{ color: "#60a5fa", fontWeight: 700, fontSize: 13, marginTop: 5 }}>{label || "Value"}: {f(d.value)}</div>
    </div>
  );
}
const monthLabel = (period) => {
  // "2026-09" -> "Sep"
  const [y, m] = (period || "").split("-");
  const names = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return m ? names[Number(m)] || period : (y || period);
};
const timeOf = (iso) => (iso ? new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "—");
// "2026-08-10…" -> "10 Aug" (day-month, clearer than the ambiguous "08-10").
const fmtDay = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? String(iso).slice(5, 10) : d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
};

// ---- small building blocks -------------------------------------------------

function Card({ children, className = "", style }) {
  // Glassmorphism: a translucent gradient pane with a soft inner highlight and a
  // deep drop shadow. The glass tokens flip with the day/night theme. NOTE: no
  // backdrop-blur — on a wallboard with ~15 cards at 4K it made every frame
  // expensive to composite (charts opened slowly); the translucent gradient alone
  // reads as glass and stays fast.
  return (
    <div className={`rounded-2xl border ${className}`}
      style={{ background: "var(--dx-glass)", borderColor: "var(--dx-glass-brd)", boxShadow: "var(--dx-glass-shadow)", ...style }}>
      {children}
    </div>
  );
}

function PanelHead({ icon: Icon, color, title, action, onAction }) {
  return (
    <div className="flex items-center justify-between mb-3">
      <div className="flex items-center gap-2.5">
        <span className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: `${color}22`, boxShadow: `inset 0 0 0 1px ${color}22` }}>
          <Icon size={20} style={{ color }} />
        </span>
        <h3 className="dx-radiant text-[1.6vh] font-bold text-[var(--dx-t1)]">{title}</h3>
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
    <Card className="p-[1vh] flex flex-col"
      style={{ borderColor: `${color}55`, boxShadow: `var(--dx-glass-shadow), 0 0 26px ${color}30, inset 0 0 22px ${color}12` }}>
      <div className="flex items-center gap-[1vh]">
        <span className="w-[3.4vh] h-[3.4vh] rounded-xl flex items-center justify-center shrink-0"
          style={{ background: gradCss(color), boxShadow: `0 6px 14px ${color}66, inset 0 2px 3px rgba(255,255,255,0.45), inset 0 -3px 5px rgba(0,0,0,0.18)` }}>
          <Icon size={17} className="text-white" />
        </span>
        <span className="text-[1.4vh] font-bold text-[var(--dx-t2)] flex-1 truncate">{title}</span>
        {trend != null && (
          <span className={`shrink-0 text-[1.2vh] font-bold ${trendUp ? "text-emerald-600" : "text-rose-600"}`}>
            {trendUp ? "↑" : "↓"} {trend}
          </span>
        )}
      </div>
      <div className="dx-radiant mt-[0.4vh] text-[2.9vh] font-extrabold leading-none text-[var(--dx-t1)]">{value}</div>
      <div className="text-[1.05vh] text-[var(--dx-t4)] mt-[0.2vh]">{sub}</div>
      <button onClick={onClick}
        className="relative mt-[0.6vh] rounded-xl text-white text-[1.2vh] font-bold py-[0.65vh] transition hover:brightness-110 active:scale-[0.98]"
        style={{ background: gradCss(color), boxShadow: `0 6px 14px ${color}44` }}>
        <span className="cta-blink">View Details →</span>
        <span className="absolute right-[0.7vh] top-1/2 -translate-y-1/2 w-[2.2vh] h-[2.2vh] rounded-full bg-white/25 flex items-center justify-center text-[1.4vh] leading-none">›</span>
      </button>
    </Card>
  );
}

function Gauge({ pct, color, label, sub }) {
  const p = Math.max(0, Math.min(100, pct || 0));
  const gid = `gg-${color.replace("#", "")}`;
  const g = GRAD[color] || [color, color];
  return (
    <div className="flex flex-col items-center">
      <svg viewBox="0 0 120 68" className="w-[13vh]">
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor={g[0]} /><stop offset="1" stopColor={g[1]} />
          </linearGradient>
        </defs>
        <path d="M12 60 A48 48 0 0 1 108 60" fill="none" style={{ stroke: "var(--dx-gauge)" }} strokeWidth="13" strokeLinecap="round" pathLength="100" />
        <path d="M12 60 A48 48 0 0 1 108 60" fill="none" stroke={`url(#${gid})`} strokeWidth="13" strokeLinecap="round" pathLength="100" strokeDasharray={`${p} 100`} style={{ filter: `drop-shadow(0 2px 4px ${color}66)` }} />
        <text x="60" y="54" textAnchor="middle" fontSize="26" fontWeight="800" style={{ fill: "var(--dx-t1)" }}>{Math.round(p)}%</text>
      </svg>
      <div className="text-center -mt-[0.6vh]">
        <div className="text-[1.4vh] font-bold flex items-center justify-center gap-1.5" style={{ color }}>
          <span className="w-[1vh] h-[1vh] rounded-full inline-block" style={{ background: color }} />{label}
        </div>
        <div className="text-[1.2vh] text-[var(--dx-t3)]">{sub}</div>
      </div>
    </div>
  );
}

function DeptBar({ name, value, pct, color }) {
  return (
    <div className="flex items-center gap-[1vh]">
      <span className="w-[13vh] text-[1.35vh] font-medium text-[var(--dx-t2)] truncate">{name}</span>
      <div className="flex-1 h-[1.5vh] rounded-full bg-[var(--dx-track)] overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: gradCss(color, 90), boxShadow: `0 1px 4px ${color}55` }} />
      </div>
      <span className="w-[5vh] text-right text-[1.4vh] font-bold text-[var(--dx-t1)]">{fmtInt(value)}</span>
      <span className="w-[4vh] text-right text-[1.3vh] text-[var(--dx-t4)]">{Math.round(pct)}%</span>
    </div>
  );
}

// The live clock ticks once a second. It lives in its own component so that tick
// re-renders ONLY the clock, never the whole board (and its heavy charts).
function HeaderClock({ isDay, onToggle }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const clock = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const dayNum = now.toLocaleDateString("en-GB", { day: "2-digit" });
  const monthShort = now.toLocaleDateString("en-GB", { month: "short" }).toUpperCase();
  const weekday = now.toLocaleDateString("en-GB", { weekday: "short" });
  const yearNum = now.getFullYear();
  return (
    <div className="shrink-0 flex items-center gap-[1.2vh] rounded-2xl px-[1.3vh] py-[0.7vh]"
      style={{ background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.14)" }}>
      <div className="flex items-center gap-[0.9vh]">
        <div className="w-[4.2vh] h-[4.2vh] rounded-xl bg-white flex flex-col items-center justify-center leading-none shrink-0 shadow-md">
          <span className="text-[0.9vh] font-extrabold text-rose-500 uppercase tracking-widest">{monthShort}</span>
          <span className="text-[2vh] font-extrabold text-[#0f172a]">{dayNum}</span>
        </div>
        <div className="text-left leading-tight">
          <div className="text-[1.4vh] font-bold text-white">{weekday}</div>
          <div className="text-[1.05vh] text-white/50">{yearNum}</div>
        </div>
      </div>
      <div className="w-px h-[3.8vh] bg-white/15" />
      <div className="text-center leading-tight">
        <div className="text-[2.6vh] font-extrabold tabular-nums leading-none">{clock}</div>
        <button onClick={onToggle}
          title={isDay ? "Day shift — click to switch to night" : "Night shift — click to switch to day"}
          className="mt-[0.4vh] inline-flex items-center justify-center rounded-full w-[3vh] h-[3vh] text-white shadow-md transition hover:brightness-110 active:scale-90"
          style={{ background: isDay ? "#10b981" : "#6366f1" }}>
          {isDay ? <Sun size={16} /> : <Moon size={16} />}
        </button>
      </div>
    </div>
  );
}

// ---- main ------------------------------------------------------------------

export default function TvDashboard() {
  const [data, setData] = useState({});
  const [hour, setHour] = useState(() => new Date().getHours()); // only for day/night auto — the ticking clock lives in <HeaderClock/> so it doesn't re-render the charts every second
  const [sections, setSections] = useState([]);
  const [sectionId, setSectionId] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });
  const menuAnchor = useRef(null);
  const [isFs, setIsFs] = useState(false);
  const [stack, setStack] = useState([]); // Explore-Data drill frames (in-board)
  const [shiftOverride, setShiftOverride] = useState(null); // null = follow the clock; true = day, false = night

  const toggleFs = () => (document.fullscreenElement ? document.exitFullscreen?.() : document.documentElement.requestFullscreen?.());

  // Only track the hour (for day/night auto), updated once a minute — the parent
  // must NOT re-render every second or every chart re-renders with it.
  useEffect(() => {
    const id = setInterval(() => setHour(new Date().getHours()), 60000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    const on = () => setIsFs(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);

  // sections — the real Spare-store sections from the store master
  useEffect(() => {
    let alive = true;
    const check = () => storeService.list()
      .then((r) => {
        if (!alive) return;
        const stores = r.data.data || [];
        const real = (stores.find((s) => s.code === "MAINTENANCE") || {}).sections || [];
        setSections(real);
      })
      .catch(() => setSections([]));
    check();
    const id = setInterval(check, REFRESH_MS);
    return () => { alive = false; clearInterval(id); };
  }, []);

  // Land on the combined "All Sections" view, and never hold a stale section id.
  useEffect(() => {
    setSectionId((cur) => (cur === ALL_SECTIONS || sections.some((s) => s.id === cur)) ? cur : ALL_SECTIONS);
  }, [sections]);

  // Sections change only when someone taps ‹ / › — no auto-rotation. "All
  // Sections" leads, so the wall shows the whole store first, then each section.
  const sectionOpts = useMemo(() => [ALL_SECTIONS, ...sections.map((s) => s.id)], [sections]);

  // Section-scoped data — refetched ONLY when the section changes, kept light (6
  // calls) so switching sections is snappy. Waits for the first section to be
  // picked so we don't fire a whole-store load that a section load replaces.
  useEffect(() => {
    if (sectionId == null) return undefined;
    let alive = true;
    const g = (pr) => pr.then((r) => r.data.data).catch(() => null);
    const load = async () => {
      // Combined view: no section filter, so every call returns the whole store.
      const sec = sectionId === ALL_SECTIONS ? undefined : sectionId;
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
  // Money tied up above the maximum — (on-hand − max) × rate for each excess part.
  const excessOf = (r) => Math.max(0, (r.qty_on_hand || 0) - (r.max_stock_level || 0)) * (r.unit_price || 0);
  const excessValue = useMemo(
    () => rows.reduce((s, r) => (r.status === "Above Maximum" ? s + excessOf(r) : s), 0),
    [rows],
  );
  // Top excess parts by the money tied up above their maximum — the main-screen
  // "Excess Stock Value" chart.
  // Excess value grouped by SECTION — which of the store's sections hold the most
  // money above max. A slice drills to that section's excess parts, by value.
  const sectionName = useMemo(() => Object.fromEntries((sections || []).map((s) => [s.id, s.name])), [sections]);
  const excessSections = useMemo(() => {
    const by = {};
    rows.forEach((r) => {
      if (r.status !== "Above Maximum") return;
      const v = excessOf(r);
      if (v > 0 && r.section_id != null) by[r.section_id] = (by[r.section_id] || 0) + v;
    });
    return Object.entries(by)
      .map(([sid, value]) => ({ sid: Number(sid), name: sectionName[sid] || "—", value: Math.round(value) }))
      .sort((a, b) => b.value - a.value)
      .map((it, i) => ({ ...it, color: PIE[i % PIE.length] }));
  }, [rows, sectionName]);
  const openExcessSection = (sid) => {
    if (sid == null) return;
    const secRows = rows.filter((r) => r.status === "Above Maximum" && excessOf(r) > 0 && r.section_id === sid);
    openStack({ kind: "partList", title: `Excess — ${sectionName[sid] || "Section"}`, rows: secRows, valueLabel: "Excess ₹", valueOf: excessOf, valueFmt: fmtMoney });
  };

  // Total stock value grouped by section — for the main-screen "Stock Value by
  // Section" donut. A slice drills to that section's parts, by value.
  const valueBySection = useMemo(() => {
    const by = {};
    rows.forEach((r) => { if (r.section_id != null && r.stock_value != null) by[r.section_id] = (by[r.section_id] || 0) + r.stock_value; });
    return Object.entries(by)
      .map(([sid, value]) => ({ sid: Number(sid), name: sectionName[sid] || "—", value: Math.round(value) }))
      .sort((a, b) => b.value - a.value)
      .map((it, i) => ({ ...it, color: PIE[i % PIE.length] }));
  }, [rows, sectionName]);
  const totalStockValue = useMemo(() => valueBySection.reduce((s, c) => s + c.value, 0), [valueBySection]);
  const openValueSection = (sid) => {
    if (sid == null) return;
    const secRows = rows.filter((r) => r.section_id === sid && r.stock_value != null);
    openStack({ kind: "partList", title: `Stock Value — ${sectionName[sid] || "Section"}`, rows: secRows, valueLabel: "Value", valueOf: (r) => r.stock_value, valueFmt: fmtMoney });
  };

  const cats = useMemo(() => {
    const by = {};
    rows.forEach((r) => { const c = r.sub_category || "Others"; by[c] = (by[c] || 0) + 1; });
    // "Others" (uncategorised parts) is folded into the single trailing slice, so
    // it never both wins a top-5 seat AND labels the remainder — which showed
    // "Others" twice in the legend.
    const named = Object.entries(by).filter(([name]) => name !== "Others").sort((a, b) => b[1] - a[1]);
    const top = named.slice(0, 5).map(([name, value], i) => ({ name, value, color: PIE[i % PIE.length] }));
    const rest = named.slice(5).reduce((s, [, v]) => s + v, 0) + (by["Others"] || 0);
    if (rest > 0) top.push({ name: "Others", value: rest, color: "#94a3b8" });
    return top;
  }, [rows]);
  const catTopNamed = useMemo(() => new Set(cats.filter((c) => c.name !== "Others").map((c) => c.name)), [cats]);
  const openCat = (cat) => {
    if (!cat) return;
    const catRows = rows.filter((r) => {
      const c = r.sub_category || "Others";
      return cat === "Others" ? !catTopNamed.has(c) : c === cat;
    });
    // "Others" holds many types, so its drill charts them by type (what's inside);
    // a single type charts its parts by stock.
    openStack(cat === "Others"
      ? { kind: "partList", title: "Others — by type", rows: catRows, valueLabel: "Stock", valueOf: (r) => r.qty_on_hand || 0, chart: "byType" }
      : { kind: "partList", title: `${cat} parts`, rows: catRows, valueLabel: "Stock", valueOf: (r) => r.qty_on_hand || 0 });
  };

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
  const nameOf = (id) => (id === ALL_SECTIONS ? "All Sections" : (sections.find((s) => s.id === id)?.name || "—"));
  const activeName = nameOf(sectionId);
  // The section list drops from a fixed layer (the header clips overflow), so it
  // is anchored to the switcher's on-screen position when opened.
  const toggleSectionMenu = () => {
    if (menuOpen) { setMenuOpen(false); return; }
    const r = menuAnchor.current?.getBoundingClientRect();
    if (r) setMenuPos({ top: r.bottom + 8, left: r.left + r.width / 2 });
    setMenuOpen(true);
  };

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
  const reorderN = dist["Reorder"] || 0;
  if (reorderN) liveAlerts.push({ color: "#f97316", text: `${reorderN} part${reorderN > 1 ? "s" : ""} at reorder level`,
    onClick: () => openStack({ kind: "partList", title: "Reorder", rows: rows.filter((r) => r.status === "Reorder"), valueLabel: "Stock", valueOf: (r) => r.qty_on_hand }) });
  if (excess) liveAlerts.push({ color: C.amber, text: `${excess} part${excess > 1 ? "s" : ""} above maximum · ${fmtMoney(excessValue)} tied up`,
    onClick: () => openStack({ kind: "partList", title: "Excess Parts", rows: rows.filter((r) => r.status === "Above Maximum"), valueLabel: "Excess ₹", valueOf: excessOf, valueFmt: fmtMoney }) });
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

  const autoDay = hour >= 8 && hour < 20;
  const isDay = shiftOverride == null ? autoDay : shiftOverride;
  // Whole-board theme, flipped by the day/night button. Every surface/text below
  // reads these CSS variables, so one switch re-themes the entire dashboard.
  const themeVars = isDay
    ? {
        "--dx-bg": "#eef2f7", "--dx-card": "#ffffff", "--dx-border": "rgba(226,232,240,0.85)", "--dx-t1": "#0f172a", "--dx-t2": "#334155", "--dx-t3": "#64748b", "--dx-t4": "#94a3b8", "--dx-track": "#eef3fb", "--dx-divide": "#eef2f7", "--dx-gauge": "#e5e7eb",
        "--dx-glass": "linear-gradient(160deg,rgba(255,255,255,0.9),rgba(237,244,255,0.78))",
        "--dx-t1-grad": "linear-gradient(160deg,#0f172a 0%,#33507e 100%)",
        "--pill-red": "#e11d48", "--pill-green": "#047857", "--pill-amber": "#b45309", "--pill-blue": "#1d4ed8", "--pill-slate": "#475569",
        "--dx-glass-brd": "rgba(255,255,255,0.85)",
        "--dx-glass-shadow": "0 10px 30px rgba(29,63,120,0.13), inset 0 1px 0 rgba(255,255,255,0.9)",
        "--dx-board": "radial-gradient(1200px 620px at 12% -6%, rgba(96,165,250,0.30), transparent 60%), radial-gradient(950px 520px at 96% -2%, rgba(45,212,191,0.20), transparent 55%), radial-gradient(1050px 720px at 50% 112%, rgba(129,140,248,0.20), transparent 60%), linear-gradient(160deg,#e9f0ff 0%,#eef4fb 42%,#f3f0fb 100%)",
      }
    : {
        "--dx-bg": "#070d1a", "--dx-card": "#0e1a30", "--dx-border": "rgba(94,165,235,0.22)", "--dx-t1": "#b4c5e0", "--dx-t2": "#8a9dbe", "--dx-t3": "#6f82a0", "--dx-t4": "#586a8c", "--dx-track": "rgba(30,48,84,0.6)", "--dx-divide": "rgba(94,165,235,0.12)", "--dx-gauge": "#243350",
        "--dx-glass": "linear-gradient(160deg,rgba(24,40,74,0.9),rgba(11,20,40,0.82))",
        "--dx-t1-grad": "linear-gradient(160deg,#cfe0f6 0%,#7ea3d2 100%)",
        "--pill-red": "#fb7185", "--pill-green": "#34d399", "--pill-amber": "#fbbf24", "--pill-blue": "#60a5fa", "--pill-slate": "#94a3b8",
        "--dx-glass-brd": "rgba(94,165,235,0.28)",
        "--dx-glass-shadow": "0 14px 38px rgba(0,0,0,0.55), 0 0 22px rgba(37,99,235,0.10), inset 0 1px 0 rgba(255,255,255,0.08)",
        "--dx-board": "radial-gradient(1100px 560px at 50% -8%, rgba(56,189,248,0.28), transparent 62%), radial-gradient(900px 520px at 96% 0%, rgba(13,148,136,0.20), transparent 55%), radial-gradient(1000px 700px at 8% 108%, rgba(124,58,237,0.22), transparent 60%), radial-gradient(1200px 800px at 50% 50%, rgba(9,20,40,0.4), rgba(4,9,20,0.75) 80%), linear-gradient(160deg,#050a16 0%,#081324 46%,#060c1a 100%)",
      };
  // recharts axis/grid become SVG attributes and can't read CSS vars, so keep JS
  // twins of the theme for chart ticks and gridlines (readable in both modes).
  const axisColor = isDay ? "#64748b" : "#94a3b8";
  const gridColor = isDay ? "#e2e8f0" : "rgba(148,163,184,0.18)";

  return (
    <div className="min-h-screen w-full flex flex-col gap-[1.2vh] p-[1.2vh] text-[var(--dx-t2)] transition-colors duration-300" style={{ ...themeVars, background: "var(--dx-board)" }}>

      {/* ---------- header ---------- */}
      <div className="shrink-0 rounded-2xl px-[2vh] py-[0.8vh] flex items-center gap-[1.6vh] text-white overflow-hidden relative"
        style={{
          background: "radial-gradient(720px 300px at 82% -50%, rgba(56,189,248,0.42), transparent 62%), radial-gradient(520px 240px at 10% 150%, rgba(37,99,235,0.32), transparent 60%), linear-gradient(120deg,#0a2340 0%,#123a6b 48%,#0a2038 100%)",
          boxShadow: "0 14px 40px rgba(10,32,70,0.40), inset 0 1px 0 rgba(255,255,255,0.08)",
        }}>
        <img src="/toyota-boshoku-logo.png" alt="Toyota Boshoku" className="h-[4.6vh] w-auto bg-white/95 rounded-lg p-[0.5vh] shrink-0" draggable={false} />
        <div className="hidden xl:block leading-tight shrink-0">
          <div className="text-[1.6vh] font-bold">Toyota Boshoku</div>
          <div className="text-[1.2vh] text-white/60">Device India Pvt. Ltd.</div>
        </div>

        <div className="flex-1 text-center min-w-0">
          <div className="text-[2.9vh] font-extrabold leading-none tracking-wide"
            style={{ backgroundImage: "linear-gradient(180deg,#ffffff 0%,#bcd6ff 100%)", WebkitBackgroundClip: "text", backgroundClip: "text", WebkitTextFillColor: "transparent", color: "transparent", filter: "drop-shadow(0 2px 12px rgba(120,180,255,0.55))" }}>
            Spare Parts Store
          </div>
          <div className="mt-[0.45vh] flex items-center justify-center gap-[1vh]">
            <span className="h-px w-[3.2vh]" style={{ background: "linear-gradient(90deg,transparent,rgba(56,189,248,0.75))" }} />
            <span className="flex items-center gap-[0.7vh] text-[1.25vh] font-bold tracking-[0.42em] text-cyan-100/90">
              <span className="w-[0.9vh] h-[0.9vh] rounded-full bg-emerald-400 animate-pulse" style={{ boxShadow: "0 0 8px #34d399" }} />
              LIVE DASHBOARD
            </span>
            <span className="h-px w-[3.2vh]" style={{ background: "linear-gradient(90deg,rgba(56,189,248,0.75),transparent)" }} />
          </div>
          {sections.length > 0 && (
            <div className="mt-[0.6vh] flex justify-center">
              <div ref={menuAnchor} className="inline-flex items-center gap-[1vh] rounded-full px-[1.6vh] py-[0.4vh]"
                style={{ background: "linear-gradient(120deg,rgba(56,189,248,0.22),rgba(37,99,235,0.16))", border: "1px solid rgba(125,195,255,0.5)", boxShadow: "0 0 22px rgba(56,189,248,0.32), inset 0 1px 0 rgba(255,255,255,0.18)" }}>
                <button onClick={() => cycle(-1)} title="Previous section" className="text-cyan-200/70 hover:text-white text-[2vh] leading-none">‹</button>
                {/* Tap the name for the full section list; ‹ › still step through. */}
                <button onClick={toggleSectionMenu} title="Pick a section"
                  className="flex items-center gap-[0.6vh] animate-rise">
                  <span key={String(sectionId)} className="text-[1.8vh] font-extrabold text-white tracking-[0.15em] uppercase">{activeName}</span>
                  <span className={`text-cyan-200/80 text-[1.2vh] leading-none transition-transform ${menuOpen ? "rotate-180" : ""}`}>▾</span>
                </button>
                <button onClick={() => cycle(1)} title="Next section" className="text-cyan-200/70 hover:text-white text-[2vh] leading-none">›</button>
              </div>
            </div>
          )}

          {/* Section list — a fixed layer so the header's overflow can't clip it. */}
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-[60]" onClick={() => setMenuOpen(false)} />
              <div className="fixed z-[61] -translate-x-1/2 min-w-[26vh] max-h-[70vh] overflow-auto py-[0.6vh] rounded-[1.4vh]"
                style={{ top: menuPos.top, left: menuPos.left, background: "linear-gradient(135deg,rgba(12,24,48,0.98),rgba(8,16,34,0.98))", border: "1px solid rgba(125,195,255,0.45)", boxShadow: "0 14px 44px rgba(0,0,0,0.55), 0 0 22px rgba(56,189,248,0.28)", backdropFilter: "blur(14px)" }}>
                {sectionOpts.map((id) => {
                  const on = id === sectionId;
                  return (
                    <button key={String(id)} onClick={() => { setSectionId(id); setMenuOpen(false); }}
                      className={`w-full text-left px-[1.6vh] py-[0.75vh] text-[1.5vh] font-bold tracking-wide uppercase transition-colors flex items-center gap-[1vh]
                        ${on ? "text-white" : "text-cyan-100/70 hover:text-white hover:bg-white/10"}`}
                      style={on ? { background: "linear-gradient(90deg,rgba(56,189,248,0.28),transparent)" } : undefined}>
                      <span className={`w-[0.8vh] h-[0.8vh] rounded-full shrink-0 ${on ? "bg-emerald-400" : "border border-cyan-200/40"}`}
                        style={on ? { boxShadow: "0 0 8px #34d399" } : undefined} />
                      <span className="truncate">{nameOf(id)}</span>
                      {id === ALL_SECTIONS && <span className="ml-auto text-[1.05vh] text-cyan-200/50 normal-case tracking-normal">combined</span>}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {/* modern date · clock · shift toggle */}
        <HeaderClock isDay={isDay} onToggle={() => setShiftOverride(!isDay)} />

        <div className="shrink-0">
          <button onClick={toggleFs} title={isFs ? "Exit fullscreen" : "Fullscreen"} className="text-white/60 hover:text-white">{isFs ? <Minimize size={16} /> : <Maximize size={16} />}</button>
        </div>
      </div>

      {/* ---------- live alert ticker (below the heading) ---------- */}
      {liveAlerts.length > 0 && (
        <div className="shrink-0 flex items-center gap-[1.2vh] overflow-hidden rounded-xl px-[1.2vh] py-[0.6vh] text-white"
          style={{ background: "linear-gradient(90deg,#0a2a4f,#0d3a6b)" }}>
          <span className="shrink-0 flex items-center gap-[0.6vh] rounded-md px-[1.1vh] py-[0.3vh] text-[1.3vh] font-extrabold tracking-wide" style={{ background: "linear-gradient(120deg,#ef4444,#dc2626)", boxShadow: "0 0 16px rgba(239,68,68,0.55)" }}>
            <span className="h-[1vh] w-[1vh] rounded-full bg-white animate-pulse" /> LIVE ALERTS
          </span>
          <div className="relative flex-1 overflow-hidden">
            <div className="ticker-track-x flex w-max items-center gap-[3.5vh] whitespace-nowrap"
              style={{ "--ticker-duration": `${Math.max(20, liveAlerts.length * 9)}s` }}>
              {[...liveAlerts, ...liveAlerts].map((a, i) => (
                <span key={i} className="flex items-center gap-[0.8vh] text-[1.45vh] font-semibold">
                  <span className="h-[1.1vh] w-[1.1vh] shrink-0 rounded-full" style={{ background: a.color, boxShadow: `0 0 0.7vh ${a.color}` }} />
                  {a.text}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ---------- KPI cards ---------- */}
      <div className="grid grid-cols-3 gap-[1.2vh]">
        <Kpi icon={Box} title="Total Parts" value={fmtInt(total)} trend={P.today?.received_lines ? `+${P.today.received_lines}` : null}
          sub="Active parts in store" color={C.blue}
          onClick={() => openStack({ kind: "partList", title: "All Parts", rows, valueLabel: "Stock", valueOf: (r) => r.qty_on_hand, chart: "byType" })} />
        <Kpi icon={Database} title="Stock Value" value={fmtMoney(P.sum?.stock_value)} sub="As per ERP (Live)" color={C.green}
          onClick={() => openStack({ kind: "partList", title: "Stock Value", rows: rows.filter((r) => r.stock_value != null), valueLabel: "Value", valueOf: (r) => r.stock_value, valueFmt: fmtMoney })} />
        <Kpi icon={AlertTriangle} title="Short Parts" value={fmtInt(short)} sub="Below minimum stock" color={C.red}
          onClick={() => openStack({ kind: "partList", title: "Short Parts", rows: rows.filter((r) => r.status === "Below Minimum" || r.status === "Out of Stock"), valueLabel: "Short by", valueOf: (r) => Math.max(0, (r.min_stock_level || 0) - (r.qty_on_hand || 0)) })} />
        <Kpi icon={Boxes} title="Excess Parts" value={fmtInt(excess)} sub={`${fmtMoney(excessValue)} over max`} color={C.amber}
          onClick={() => openStack({ kind: "partList", title: "Excess Parts", rows: rows.filter((r) => r.status === "Above Maximum"), valueLabel: "Excess ₹", valueOf: excessOf, valueFmt: fmtMoney })} />
        <Kpi icon={ClipboardList} title="Pending ERP" value={fmtInt(P.erpPend?.pending ?? 0)} sub="Movements pending in ERP" color={C.purple}
          onClick={() => openTxns("Pending ERP", { note: `${fmtInt(P.erpPend?.pending ?? 0)} stock movement(s) queued to push to ERP — every move waits here while the ERP write is off. Tap a row for that part's history.` })} />
        <Kpi icon={ShoppingCart} title="Today's Issue" value={fmtInt(P.today?.issued_qty)} trend={P.today?.issued_lines ? `${P.today.issued_lines} lines` : null}
          sub="Parts issued this shift" color={C.blue}
          onClick={() => openTxns("Today's Issue", { filter: (r) => r.txn_type === "ISSUE", deptData })} />
      </div>

      {/* ---------- charts ---------- */}
      <div className="grid grid-cols-2 gap-[1.2vh]">
        <Card className="p-[1.4vh]">
          <PanelHead icon={PieChartMini} color={C.blue} title="Stock by Part Type" />
          <div className="flex items-center gap-[1vh]">
            <div className="w-[24vh] h-[24vh] relative shrink-0" style={{ filter: "drop-shadow(0 8px 14px rgba(30,60,120,0.22))" }}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <defs>
                    {(cats.length ? cats : [{ color: "#e2e8f0" }]).map((c, i) => {
                      const g = GRAD[c.color] || [c.color, c.color];
                      return (
                        <linearGradient key={i} id={`pieg-${i}`} x1="0" y1="0" x2="1" y2="1">
                          <stop offset="0" stopColor={g[0]} /><stop offset="1" stopColor={g[1]} />
                        </linearGradient>
                      );
                    })}
                  </defs>
                  <Pie data={cats.length ? cats : [{ name: "—", value: 1, color: "#e2e8f0" }]} dataKey="value" nameKey="name"
                    innerRadius="48%" outerRadius="92%" paddingAngle={2} stroke="none" isAnimationActive={false}
                    onClick={(s) => cats.length && openCat(s && (s.name ?? (s.payload && s.payload.name)))}>
                    {(cats.length ? cats : [{ color: "#e2e8f0" }]).map((c, i) => <Cell key={i} fill={`url(#pieg-${i})`} cursor={cats.length ? "pointer" : "default"} />)}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
              <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                <span className="dx-radiant text-[3vh] font-extrabold text-[var(--dx-t1)] leading-none">{fmtInt(total)}</span>
                <span className="text-[1.3vh] text-[var(--dx-t4)]">Total Parts</span>
              </div>
            </div>
            <div className="flex-1 space-y-[0.9vh]">
              {(cats.length ? cats : []).map((c) => (
                <button key={c.name} onClick={() => openCat(c.name)}
                  className="w-full flex items-center gap-[1vh] text-[1.5vh] rounded-md px-[0.5vh] py-[0.25vh] hover:bg-[var(--dx-track)] transition-colors">
                  <span className="w-[1.4vh] h-[1.4vh] rounded-full shrink-0" style={{ background: gradCss(c.color), boxShadow: `0 1px 4px ${c.color}66` }} />
                  <span className="flex-1 text-left text-[var(--dx-t2)] truncate">{c.name}</span>
                  <span className="dx-radiant font-bold text-[var(--dx-t1)]">{fmtInt(c.value)}</span>
                  <span className="w-[5vh] text-right text-[var(--dx-t4)]">{Math.round((c.value / (total || 1)) * 100)}%</span>
                </button>
              ))}
              {!cats.length && <div className="text-[1.5vh] text-[var(--dx-t4)]">No parts in this section</div>}
            </div>
          </div>
        </Card>

        <Card className="p-[1.4vh]">
          <PanelHead icon={FileBarChart} color={C.green} title="Monthly Consumption / Issue" />
          <div className="h-[24vh]">
            {monthlyData.length ? (
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={monthlyData} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                  <defs>
                    <linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0" stopColor="#60a5fa" /><stop offset="1" stopColor="#2563eb" />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={gridColor} />
                  <XAxis dataKey="name" tick={{ fontSize: 13, fill: axisColor }} axisLine={{ stroke: gridColor }} tickLine={false} />
                  <YAxis tick={{ fontSize: 13, fill: axisColor }} axisLine={false} tickLine={false} width={40} />
                  <Tooltip />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="qty" name="Issued Qty" fill="url(#barGrad)" radius={[5, 5, 0, 0]} barSize={26} isAnimationActive={false} />
                  <Line type="monotone" dataKey="qty" name="Trend" stroke={C.green} strokeWidth={2.5} dot={{ r: 3, fill: C.green }} isAnimationActive={false} />
                </ComposedChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full flex items-center justify-center text-[1.6vh] text-[var(--dx-t4)]">No consumption data yet</div>
            )}
          </div>
        </Card>
      </div>

      {/* ---------- health + dept ---------- */}
      <div className="grid grid-cols-2 gap-[1.2vh]">
        <Card className="p-[1.4vh]">
          <PanelHead icon={HeartMini} color={C.green} title="Stock Health" />
          <div className="flex items-center justify-around pt-[1vh]">
            <Gauge pct={(healthy / counted) * 100} color={C.green} label="Healthy" sub={`${fmtInt(healthy)} Parts`} />
            <Gauge pct={(excess / counted) * 100} color={C.amber} label="Excess" sub={`${fmtInt(excess)} Parts`} />
            <Gauge pct={(short / counted) * 100} color={C.red} label="Short" sub={`${fmtInt(short)} Parts`} />
          </div>
        </Card>

        <Card className="p-[1.4vh]">
          <PanelHead icon={FileBarChart} color={C.purple} title="Department-wise Issue (This Month)" />
          <div className="space-y-[1.1vh] pt-[0.6vh]">
            {deptData.length ? deptData.map((d) => <DeptBar key={d.name} {...d} />)
              : <div className="text-[1.5vh] text-[var(--dx-t4)] py-[3vh] text-center">No issues this month</div>}
          </div>
        </Card>
      </div>

      {/* ---------- stock value by section ---------- */}
      <Card className="p-[1.4vh]">
        <PanelHead icon={Database} color={C.green} title="Stock Value by Section"
          action="View Details" onAction={() => openStack({ kind: "partList", title: "Stock Value", rows: rows.filter((r) => r.stock_value != null), valueLabel: "Value", valueOf: (r) => r.stock_value, valueFmt: fmtMoney, chart: "bySection", sectionNames: sectionName })} />
        {valueBySection.length ? (
          <div className="flex items-center gap-[1vh]">
            <div className="w-[24vh] h-[24vh] relative shrink-0" style={{ filter: "drop-shadow(0 8px 14px rgba(20,120,80,0.22))" }}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <defs>
                    {valueBySection.map((c, i) => {
                      const g = GRAD[c.color] || [c.color, c.color];
                      return (
                        <linearGradient key={i} id={`vsg-${i}`} x1="0" y1="0" x2="1" y2="1">
                          <stop offset="0" stopColor={g[0]} /><stop offset="1" stopColor={g[1]} />
                        </linearGradient>
                      );
                    })}
                  </defs>
                  <Pie data={valueBySection} dataKey="value" nameKey="name" innerRadius="48%" outerRadius="92%"
                    paddingAngle={2} stroke="none" isAnimationActive={false}
                    onClick={(s) => openValueSection(s && (s.sid ?? (s.payload && s.payload.sid)))}>
                    {valueBySection.map((c, i) => <Cell key={i} fill={`url(#vsg-${i})`} cursor="pointer" />)}
                  </Pie>
                  <Tooltip content={<PartValTip fmt={fmtMoney} label="Value" />} />
                </PieChart>
              </ResponsiveContainer>
              <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                <span className="dx-radiant text-[2.1vh] font-extrabold text-[var(--dx-t1)] leading-none">{fmtMoney(totalStockValue)}</span>
                <span className="text-[1.3vh] text-[var(--dx-t4)]">Total value</span>
              </div>
            </div>
            <div className="flex-1 min-w-0 space-y-[0.5vh]">
              {valueBySection.map((c) => (
                <button key={c.sid} onClick={() => openValueSection(c.sid)}
                  className="w-full flex items-center gap-[1.2vh] text-[1.6vh] rounded-md px-[0.6vh] py-[0.55vh] hover:bg-[var(--dx-track)] transition-colors">
                  <span className="w-[1.4vh] h-[1.4vh] rounded-full shrink-0" style={{ background: gradCss(c.color), boxShadow: `0 1px 4px ${c.color}66` }} />
                  <span className="w-[18vh] shrink-0 text-left text-[var(--dx-t2)] truncate">{c.name}</span>
                  <span className="flex-1 h-[1.3vh] rounded-full overflow-hidden bg-[var(--dx-track)]">
                    <span className="block h-full rounded-full" style={{ width: `${Math.max(3, (c.value / (valueBySection[0].value || 1)) * 100)}%`, background: gradCss(c.color, 90) }} />
                  </span>
                  <span className="dx-radiant font-bold text-[var(--dx-t1)] whitespace-nowrap w-[12vh] text-right">{fmtMoney(c.value)}</span>
                  <span className="w-[5vh] text-right text-[var(--dx-t4)]">{Math.round((c.value / (totalStockValue || 1)) * 100)}%</span>
                </button>
              ))}
              <div className="text-[1.2vh] text-[var(--dx-t4)] pt-[0.3vh] pl-[0.6vh]">Tap a section for its parts</div>
            </div>
          </div>
        ) : (
          <div className="h-[24vh] flex items-center justify-center text-[1.6vh] text-[var(--dx-t4)]">No stock value yet</div>
        )}
      </Card>

      {/* ---------- excess stock value ---------- */}
      <Card className="p-[1.4vh]">
        <PanelHead icon={Boxes} color={C.amber} title="Excess Stock Value"
          action="View Details" onAction={() => openStack({ kind: "partList", title: "Excess Parts", rows: rows.filter((r) => r.status === "Above Maximum"), valueLabel: "Excess ₹", valueOf: excessOf, valueFmt: fmtMoney })} />
        {excessSections.length ? (
          <div className="flex items-center gap-[1vh]">
            <div className="w-[24vh] h-[24vh] relative shrink-0" style={{ filter: "drop-shadow(0 8px 14px rgba(120,80,20,0.22))" }}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <defs>
                    {excessSections.map((c, i) => {
                      const g = GRAD[c.color] || [c.color, c.color];
                      return (
                        <linearGradient key={i} id={`exg-${i}`} x1="0" y1="0" x2="1" y2="1">
                          <stop offset="0" stopColor={g[0]} /><stop offset="1" stopColor={g[1]} />
                        </linearGradient>
                      );
                    })}
                  </defs>
                  <Pie data={excessSections} dataKey="value" nameKey="name" innerRadius="48%" outerRadius="92%"
                    paddingAngle={2} stroke="none" isAnimationActive={false}
                    onClick={(s) => openExcessSection(s && (s.sid ?? (s.payload && s.payload.sid)))}>
                    {excessSections.map((c, i) => <Cell key={i} fill={`url(#exg-${i})`} cursor="pointer" />)}
                  </Pie>
                  <Tooltip content={<ExcessTip />} />
                </PieChart>
              </ResponsiveContainer>
              <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                <span className="dx-radiant text-[2.1vh] font-extrabold text-[var(--dx-t1)] leading-none">{fmtMoney(excessValue)}</span>
                <span className="text-[1.3vh] text-[var(--dx-t4)]">Excess Value</span>
              </div>
            </div>
            <div className="flex-1 min-w-0 space-y-[0.5vh]">
              {excessSections.map((c) => (
                <button key={c.sid} onClick={() => openExcessSection(c.sid)}
                  className="w-full flex items-center gap-[1.2vh] text-[1.6vh] rounded-md px-[0.6vh] py-[0.55vh] hover:bg-[var(--dx-track)] transition-colors">
                  <span className="w-[1.4vh] h-[1.4vh] rounded-full shrink-0" style={{ background: gradCss(c.color), boxShadow: `0 1px 4px ${c.color}66` }} />
                  <span className="w-[18vh] shrink-0 text-left text-[var(--dx-t2)] truncate">{c.name}</span>
                  <span className="flex-1 h-[1.3vh] rounded-full overflow-hidden bg-[var(--dx-track)]">
                    <span className="block h-full rounded-full" style={{ width: `${Math.max(3, (c.value / (excessSections[0].value || 1)) * 100)}%`, background: gradCss(c.color, 90) }} />
                  </span>
                  <span className="dx-radiant font-bold text-[var(--dx-t1)] whitespace-nowrap w-[12vh] text-right">{fmtMoney(c.value)}</span>
                  <span className="w-[5vh] text-right text-[var(--dx-t4)]">{Math.round((c.value / (excessValue || 1)) * 100)}%</span>
                </button>
              ))}
              <div className="text-[1.2vh] text-[var(--dx-t4)] pt-[0.3vh] pl-[0.6vh]">Tap a section for its excess parts</div>
            </div>
          </div>
        ) : (
          <div className="h-[24vh] flex items-center justify-center text-[1.6vh] text-[var(--dx-t4)]">No excess stock — nothing above its maximum</div>
        )}
      </Card>

      {/* ---------- ERP current stock ---------- */}
      <Card className="p-[1.4vh]">
        <PanelHead icon={Database} color={C.cyan} title="Current Stock — ERP vs Physical" action="View Details" onAction={openErpGap} />
        <div className="grid grid-cols-4 gap-[1.2vh]">
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
      <Card className="p-[1.4vh]">
        <PanelHead icon={AlertTriangle} color={C.red} title="Top Short Parts (Below Minimum)" />
        <div>
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
                  <span className="inline-block rounded-full font-bold px-[1.2vh] py-[0.3vh]" style={{ background: "rgba(244,63,94,0.16)", color: "var(--pill-red)" }}>
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
        </div>
      </Card>

      {/* ---------- recent transactions (Live Alerts now runs in the top ticker) ---------- */}
      <Card className="p-[1.4vh]">
        <PanelHead icon={PackagePlus} color={C.green} title="Recent Transactions" />
        <div>
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
                    <span className="rounded px-[0.9vh] py-[0.2vh] text-[1.2vh] font-bold" style={issue ? { background: "rgba(244,63,94,0.16)", color: "var(--pill-red)" } : { background: "rgba(16,185,129,0.18)", color: "var(--pill-green)" }}>{r.txn_type}</span>
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
        </div>
      </Card>

      {/* ---------- footer ---------- */}
      <div className="rounded-2xl px-[2vh] py-[1vh] flex items-center justify-between text-white text-[1.35vh]"
        style={{ background: "linear-gradient(120deg,#0a2a4f,#0d3a6b)" }}>
        <div className="font-semibold text-white/80">Digitize · Simplify · Improve</div>
        <div className="italic text-white/80 font-semibold">"Right Parts | Right Time | For Smooth Production"</div>
        <div className="text-white/60">Toyota Boshoku Device India Pvt. Ltd.</div>
      </div>

      {/* ---------- Explore-Data drill (opens WITHIN the board) ---------- */}
      {stack.length > 0 && (
        <div className="fixed inset-0 z-50 text-[var(--dx-t2)] flex flex-col p-[1.6vh] gap-[1.4vh] overflow-auto" style={{ ...themeVars, background: "var(--dx-board)" }}>
          <div className="rounded-2xl px-[2vh] py-[1.3vh] flex items-center gap-[1.5vh] text-white shrink-0 overflow-hidden"
            style={{ background: "radial-gradient(640px 260px at 88% -50%, rgba(56,189,248,0.38), transparent 62%), linear-gradient(120deg,#0a2340 0%,#123a6b 50%,#0a2038 100%)", boxShadow: "0 12px 34px rgba(10,32,70,0.38), inset 0 1px 0 rgba(255,255,255,0.08)" }}>
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
  if (t === "ISSUE") return { background: "rgba(244,63,94,0.16)", color: "var(--pill-red)" };
  if (t === "RECEIPT") return { background: "rgba(16,185,129,0.18)", color: "var(--pill-green)" };
  if (t === "RETURN") return { background: "rgba(59,130,246,0.18)", color: "var(--pill-blue)" };
  return { background: "rgba(148,163,184,0.18)", color: "var(--pill-slate)" };
}
function StatusPill({ status }) {
  const red = status === "Below Minimum" || status === "Out of Stock";
  const reorder = status === "Reorder";
  const amber = status === "Above Maximum";
  const c = red ? { background: "rgba(244,63,94,0.16)", color: "var(--pill-red)" }
    : reorder ? { background: "rgba(249,115,22,0.18)", color: "#fb923c" }
      : amber ? { background: "rgba(245,158,11,0.18)", color: "var(--pill-amber)" }
        : { background: "rgba(16,185,129,0.18)", color: "var(--pill-green)" };
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
  // The table always shows Stock; a 2nd value column only when the frame carries
  // a DIFFERENT measure (Value ₹, Short by, Excess by), never a duplicate "Stock".
  const showValue = Boolean(frame.valueLabel) && frame.valueLabel !== "Stock";
  // Tap a "Parts by type" bar to filter the list to that type (how many die
  // parts, how many sensors…). Cleared whenever the data reloads.
  const [pick, setPick] = useState(null);
  const [secPick, setSecPick] = useState(null);
  useEffect(() => { setPick(null); setSecPick(null); }, [rows]);
  const sectionNames = frame.sectionNames || {};
  const top = rows.slice().sort((a, b) => (valueOf(b) || 0) - (valueOf(a) || 0)).slice(0, 10)
    .map((r) => ({ name: r.part_no, desc: r.part_name, value: Math.round(valueOf(r) || 0) }));
  const byType = (() => {
    const by = {};
    rows.forEach((r) => { const c = r.sub_category || "Others"; by[c] = (by[c] || 0) + 1; });
    return Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, value]) => ({ name, value }));
  })();
  const bySection = (() => {
    const by = {};
    rows.forEach((r) => { if (r.section_id != null) by[r.section_id] = (by[r.section_id] || 0) + (valueOf(r) || 0); });
    return Object.entries(by).map(([sid, value]) => ({ sid: Number(sid), name: sectionNames[sid] || "—", value: Math.round(value) }))
      .sort((a, b) => b.value - a.value).map((it, i) => ({ ...it, color: PIE[i % PIE.length] }));
  })();
  const isByType = frame.chart === "byType";
  const isBySection = frame.chart === "bySection";
  const chartData = isByType ? byType : isBySection ? bySection : top;
  const chartTotal = chartData.reduce((s, d) => s + (d.value || 0), 0);
  const chartTitle = isByType ? "Parts by type"
    : isBySection ? `${frame.valueLabel || "Value"} by section`
      : `Top ${top.length} by ${frame.valueLabel || "Stock"}`;
  // The bar is a COUNT of parts on the by-type chart, a stock figure on the
  // top-10 — so the tooltip says which, instead of a bare "value".
  const unit = isByType ? "Parts" : (frame.valueLabel || "Qty");
  const shown = secPick != null ? rows.filter((r) => r.section_id === secPick)
    : pick ? rows.filter((r) => (r.sub_category || "Others") === pick) : rows;
  const onBarClick = (d) => {
    const name = d && (d.name ?? d.payload?.name);
    if (isByType) { if (name) setPick((p) => (p === name ? null : name)); return; }
    if (isBySection) { const sid = d && (d.sid ?? d.payload?.sid); if (sid != null) setSecPick((p) => (p === sid ? null : sid)); return; }
    const r = name && rows.find((x) => x.part_no === name); if (r) onOpen(r);
  };
  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-[1.4vh] h-full">
      <Card className="p-[1.6vh] flex flex-col">
        <h3 className="dx-radiant text-[1.8vh] font-bold text-[var(--dx-t1)] mb-[1vh]">{chartTitle}</h3>
        <div className="flex-1 min-h-[36vh]">
          {!chartData.length ? (
            <div className="h-full flex items-center justify-center text-[var(--dx-t4)] text-[1.6vh]">No parts</div>
          ) : isByType ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart layout="vertical" data={chartData} margin={{ left: 8, right: 24, top: 4, bottom: 4 }} accessibilityLayer={false}>
                <defs>
                  <linearGradient id="dg-hblue" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#60a5fa" /><stop offset="1" stopColor="#2563eb" /></linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke={grid} />
                <XAxis type="number" tick={{ fontSize: 12, fill: axis }} allowDecimals={false} />
                <YAxis type="category" dataKey="name" width={92} tick={{ fontSize: 12, fill: axis }} />
                <Tooltip formatter={(v) => [fmtInt(v), unit]} cursor={{ fill: "var(--dx-track)" }} />
                <Bar dataKey="value" radius={[0, 6, 6, 0]} barSize={16} cursor="pointer" onClick={onBarClick}>
                  {chartData.map((d, i) => (
                    <Cell key={i} fill={pick && d.name === pick ? "#1e3a8a" : "url(#dg-hblue)"} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : isBySection ? (
            <div className="h-full flex items-center gap-[1.5vh]">
              <div className="h-full aspect-square relative shrink-0" style={{ maxWidth: "30vh" }}>
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <defs>
                      {chartData.map((c, i) => {
                        const g = GRAD[c.color] || [c.color, c.color];
                        return <linearGradient key={i} id={`sg-${i}`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor={g[0]} /><stop offset="1" stopColor={g[1]} /></linearGradient>;
                      })}
                    </defs>
                    <Pie data={chartData} dataKey="value" nameKey="name" innerRadius="52%" outerRadius="88%"
                      paddingAngle={2} stroke="none" isAnimationActive={false} onClick={onBarClick}>
                      {chartData.map((c, i) => <Cell key={i} fill={`url(#sg-${i})`} cursor="pointer" />)}
                    </Pie>
                    <Tooltip content={<PartValTip fmt={fmtV} label={frame.valueLabel} />} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                  <span className="dx-radiant text-[2.4vh] font-extrabold text-[var(--dx-t1)] leading-none">{fmtV(chartTotal)}</span>
                  <span className="text-[1.3vh] text-[var(--dx-t4)]">Total value</span>
                </div>
              </div>
              <div className="flex-1 min-w-0 space-y-[0.5vh]">
                {chartData.map((c) => (
                  <button key={c.sid} onClick={() => setSecPick((p) => (p === c.sid ? null : c.sid))}
                    className={`w-full flex items-center gap-[1vh] text-[1.6vh] rounded-md px-[0.6vh] py-[0.5vh] transition-colors ${secPick === c.sid ? "bg-[var(--dx-track)]" : "hover:bg-[var(--dx-track)]"}`}>
                    <span className="w-[1.4vh] h-[1.4vh] rounded-full shrink-0" style={{ background: gradCss(c.color), boxShadow: `0 1px 4px ${c.color}66` }} />
                    <span className="flex-1 text-left text-[var(--dx-t2)] truncate">{c.name}</span>
                    <span className="dx-radiant font-bold text-[var(--dx-t1)] whitespace-nowrap">{fmtV(c.value)}</span>
                    <span className="w-[5vh] text-right text-[var(--dx-t4)]">{Math.round((c.value / (chartTotal || 1)) * 100)}%</span>
                  </button>
                ))}
                <div className="text-[1.2vh] text-[var(--dx-t4)] pt-[0.3vh] pl-[0.6vh]">Tap a section to filter the list</div>
              </div>
            </div>
          ) : (
            <div className="h-full flex items-center justify-center">
              <div className="relative w-[32vh] h-[32vh] max-w-full max-h-full">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <defs>
                    {chartData.map((c, i) => {
                      const col = PIE[i % PIE.length];
                      const g = GRAD[col] || [col, col];
                      return (
                        <linearGradient key={i} id={`tg-${i}`} x1="0" y1="0" x2="1" y2="1">
                          <stop offset="0" stopColor={g[0]} /><stop offset="1" stopColor={g[1]} />
                        </linearGradient>
                      );
                    })}
                  </defs>
                  <Pie data={chartData} dataKey="value" nameKey="name" innerRadius="52%" outerRadius="88%"
                    paddingAngle={2} stroke="none" isAnimationActive={false} onClick={onBarClick}>
                    {chartData.map((c, i) => <Cell key={i} fill={`url(#tg-${i})`} cursor="pointer" />)}
                  </Pie>
                  <Tooltip content={<PartValTip fmt={fmtV} label={frame.valueLabel} />} />
                </PieChart>
              </ResponsiveContainer>
              <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                <span className="dx-radiant text-[2.6vh] font-extrabold text-[var(--dx-t1)] leading-none">{fmtV(chartTotal)}</span>
                <span className="text-[1.4vh] text-[var(--dx-t4)]">Top {chartData.length} total</span>
              </div>
              </div>
            </div>
          )}
        </div>
      </Card>
      <Card className="p-[1.6vh] overflow-auto">
        <h3 className="dx-radiant text-[1.8vh] font-bold text-[var(--dx-t1)] mb-[1vh] flex items-center gap-[1vh] flex-wrap">
          {secPick != null ? (
            <>
              <span>{shown.length} × {sectionNames[secPick] || "Section"}</span>
              <button onClick={() => setSecPick(null)}
                className="text-[1.2vh] px-[1vh] py-[0.3vh] rounded-full bg-[var(--dx-track)] text-[var(--dx-t4)] hover:text-[var(--dx-t1)] transition-colors">
                ✕ clear
              </button>
            </>
          ) : pick ? (
            <>
              <span>{shown.length} × {pick}</span>
              <button onClick={() => setPick(null)}
                className="text-[1.2vh] px-[1vh] py-[0.3vh] rounded-full bg-[var(--dx-track)] text-[var(--dx-t4)] hover:text-[var(--dx-t1)] transition-colors">
                ✕ clear
              </button>
            </>
          ) : (
            <span>{rows.length} parts · tap a bar to filter · tap a row for history</span>
          )}
        </h3>
        <table className="w-full text-[1.45vh]">
          <thead>
            <tr className="text-left text-[1.2vh] uppercase tracking-wide text-[var(--dx-t4)] border-b border-[var(--dx-border)]">
              <th className="py-[0.7vh] pr-[1vh]">Part No.</th><th className="pr-[1vh]">Description</th>
              <th className="pr-[1vh] text-center">Stock</th>
              {showValue && <th className="pr-[1vh] text-center">{frame.valueLabel}</th>}
              <th className="pr-[1vh]">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--dx-divide)]">
            {shown.map((r) => (
              <tr key={r.part_id} onClick={() => onOpen(r)} className="cursor-pointer hover:bg-[var(--dx-track)] transition-colors">
                <td className="py-[0.9vh] pr-[1vh] font-bold text-[var(--dx-t1)]">{r.part_no}</td>
                <td className="pr-[1vh] text-[var(--dx-t2)] truncate max-w-[24vh]">{r.part_name}</td>
                <td className="pr-[1vh] text-center">{fmtInt(r.qty_on_hand)}</td>
                {showValue && <td className="pr-[1vh] text-center font-semibold text-[var(--dx-t1)]">{fmtV(valueOf(r))}</td>}
                <td className="pr-[1vh]"><StatusPill status={r.status} /></td>
              </tr>
            ))}
            {!shown.length && <tr><td colSpan={showValue ? 5 : 4} className="py-[3vh] text-center text-[var(--dx-t4)] text-[1.6vh]">{pick ? `No ${pick} parts` : "No parts in this section"}</td></tr>}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function PartHistoryView({ frame, axis = "#64748b", grid = "#e2e8f0" }) {
  const part = frame.part || {};
  const hist = frame.history || [];
  const chart = hist.slice().reverse().map((h) => ({ d: fmtDay(h.at || h.created_at), bal: Number(h.balance_after ?? 0) }));
  // "Kab se pada" — how long it has sat unused: since the last issue if any, else
  // since its earliest recorded movement / count.
  const lastIssue = hist.find((h) => h.txn_type === "ISSUE");
  const sinceAt = (lastIssue && (lastIssue.at || lastIssue.created_at))
    || (hist.length && (hist[hist.length - 1].at || hist[hist.length - 1].created_at))
    || part.last_counted_at || null;
  const lyingDays = sinceAt ? Math.max(0, Math.floor((Date.now() - new Date(sinceAt).getTime()) / 86400000)) : null;
  return (
    <div className="flex flex-col gap-[1.4vh]">
      <Card className="p-[1.6vh]">
        <div className="flex items-center gap-[2vh] flex-wrap">
          <div>
            <div className="text-[1.3vh] text-[var(--dx-t4)]">Part No.</div>
            <div className="dx-radiant text-[2.4vh] font-extrabold text-[var(--dx-t1)] leading-none">{part.part_no}</div>
          </div>
          <div className="text-[1.7vh] text-[var(--dx-t2)]">{part.part_name}</div>
          <div className="ml-auto flex items-center gap-[2.2vh]">
            <Stat label="In Stock" value={fmtInt(part.qty_on_hand)} />
            <Stat label="Min" value={fmtInt(part.min_stock_level)} />
            <Stat label="Max" value={fmtInt(part.max_stock_level)} />
            <Stat label="Value" value={fmtMoney(part.stock_value)} />
            <Stat label="Location" value={part.location || "—"} />
            <Stat label={lastIssue ? "Not issued since" : "In stock since"}
              value={sinceAt ? `${fmtDay(sinceAt)}${lyingDays != null ? ` · ${lyingDays}d` : ""}` : "—"} />
          </div>
        </div>
      </Card>

      <Card className="p-[1.6vh]">
        <h3 className="dx-radiant text-[1.8vh] font-bold text-[var(--dx-t1)] mb-[1vh]">Stock Level History</h3>
        <div className="h-[32vh]">
          {chart.length ? (
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chart} margin={{ top: 8, right: 54, left: -12, bottom: 0 }}>
                <defs>
                  <linearGradient id="dg-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#2563eb" stopOpacity="0.35" /><stop offset="1" stopColor="#2563eb" stopOpacity="0" /></linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke={grid} vertical={false} />
                <XAxis dataKey="d" tick={{ fontSize: 12, fill: axis }} />
                <YAxis tick={{ fontSize: 12, fill: axis }} width={42} />
                <Tooltip />
                {part.max_stock_level != null && (
                  <ReferenceLine y={part.max_stock_level} stroke="#d97706" strokeDasharray="6 4" ifOverflow="extendDomain"
                    label={{ value: `Max ${part.max_stock_level}`, position: "right", fill: "#d97706", fontSize: 11, fontWeight: 700 }} />
                )}
                <Area type="monotone" dataKey="bal" stroke="none" fill="url(#dg-area)" />
                <Line type="monotone" dataKey="bal" name="Balance" stroke="#2563eb" strokeWidth={2.5} dot={{ r: 3, fill: "#2563eb" }} />
              </ComposedChart>
            </ResponsiveContainer>
          ) : <div className="h-full flex items-center justify-center text-[var(--dx-t4)] text-[1.6vh]">No movement history yet</div>}
        </div>
      </Card>

      <Card className="p-[1.6vh] overflow-auto">
        <h3 className="dx-radiant text-[1.8vh] font-bold text-[var(--dx-t1)] mb-[1vh]">Movements ({hist.length})</h3>
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
                <td className="py-[0.7vh] pr-[1vh] text-[var(--dx-t3)] tabular-nums">{fmtDay(h.at || h.created_at)}</td>
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
          <h3 className="dx-radiant text-[1.8vh] font-bold text-[var(--dx-t1)] mb-[1vh]">Issued qty by department (this month)</h3>
          <div className="h-[22vh]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={dept} margin={{ top: 8, right: 12, left: -14, bottom: 0 }}>
                <defs>
                  <linearGradient id="dg-vpurple" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#a78bfa" /><stop offset="1" stopColor="#7c3aed" /></linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={grid} />
                <XAxis dataKey="name" tick={{ fontSize: 12, fill: axis }} />
                <YAxis tick={{ fontSize: 12, fill: axis }} width={40} />
                <Tooltip />
                <Bar dataKey="value" fill="url(#dg-vpurple)" radius={[5, 5, 0, 0]} barSize={26} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      )}
      <Card className="p-[1.6vh] overflow-auto flex-1">
        <h3 className="dx-radiant text-[1.8vh] font-bold text-[var(--dx-t1)] mb-[1vh]">{rows.length} movement(s) · tap a row for that part's history</h3>
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
                className="cursor-pointer hover:bg-[var(--dx-track)] transition-colors">
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
    st === "MATCH" ? { background: "rgba(16,185,129,0.18)", color: "var(--pill-green)" }
      : st === "SHORT" ? { background: "rgba(244,63,94,0.16)", color: "var(--pill-red)" }
        : st === "EXCESS" ? { background: "rgba(245,158,11,0.18)", color: "var(--pill-amber)" }
          : { background: "rgba(148,163,184,0.18)", color: "var(--pill-slate)" };
  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-[1.4vh] h-full">
      <Card className="p-[1.6vh] flex flex-col">
        <h3 className="dx-radiant mb-[1vh] text-[1.8vh] font-bold text-[var(--dx-t1)]">Biggest ERP ↔ Physical gaps</h3>
        <div className="min-h-[30vh] flex-1">
          {top.length ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart layout="vertical" data={top} margin={{ left: 8, right: 24, top: 4, bottom: 4 }}>
                <defs>
                  <linearGradient id="dg-hcyan" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#22d3ee" /><stop offset="1" stopColor="#0891b2" /></linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke={grid} />
                <XAxis type="number" tick={{ fontSize: 12, fill: axis }} />
                <YAxis type="category" dataKey="name" width={92} tick={{ fontSize: 12, fill: axis }} />
                <Tooltip />
                <Bar dataKey="value" fill="url(#dg-hcyan)" radius={[0, 6, 6, 0]} barSize={16} />
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
        <h3 className="dx-radiant mb-[1vh] text-[1.8vh] font-bold text-[var(--dx-t1)]">{rows.length} parts · tap a row for its history</h3>
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
                className="cursor-pointer transition-colors hover:bg-[var(--dx-track)]">
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
