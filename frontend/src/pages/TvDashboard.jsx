import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ResponsiveContainer, PieChart, Pie, Cell, ComposedChart, BarChart, Bar, Line, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ReferenceArea,
} from "recharts";
import {
  Database, AlertTriangle, Boxes, ClipboardList,
  FileBarChart, PackagePlus, Sun, Moon, ArrowLeft, RefreshCw, RotateCw,
  Maximize, Minimize, ArrowDownToLine, ArrowUpFromLine, ArrowLeftRight,
  Hourglass, ListChecks, TrendingUp,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { spareStockService } from "../services/spareStockService.js";
import { spareFlowService } from "../services/spareFlowService.js";
import { managementService } from "../services/managementService.js";
import { partService } from "../services/partService.js";
import { storeService } from "../services/storeService.js";
import { NO_ROWS } from "../lib/stockQueries.js";
import { fmtStamp, parseServerTime } from "../lib/format.js";
import { erpLineMeta } from "../lib/scanStatus.js";
import { erpFreshness } from "../services/erpGrnService.js";
import useRealtime from "../hooks/useRealtime.js";
import { useCan } from "../components/Can.jsx";

// A full-screen wallboard for a 64" PORTRAIT LED — no menu, no scroll, a tall
// single-store (Spare) board. Real figures come from the spare-stock API; the
// header switches between the store's sections (auto-rotating on the wall).
// The wallboard re-pulls the full store list + ERP gap on this timer; at 30s
// that was ~10 heavy requests every 30s, saturating the backend and re-rendering
// every chart (so clicks near a tick stalled). Store stock doesn't move that
// fast — 2 minutes keeps it live enough at a quarter of the load.
const REFRESH_MS = 120000;

const STORE = "MAINTENANCE";

// The day/night choice is sticky across navigation and reloads: a manual toggle
// is remembered in localStorage so leaving the board and returning keeps night
// as night. Absent / unreadable = follow the plant clock.
const SHIFT_KEY = "dx-tv-shift";
function readShift() {
  try {
    const v = localStorage.getItem(SHIFT_KEY);
    return v === "day" ? true : v === "night" ? false : null;
  } catch { return null; }
}

// Live on top of the poll: re-run `fn` when the server pushes a stock change
// (SSE → `dx:realtime`, see hooks/useRealtime), debounced so a burst of
// movements costs one refetch. Returns the cleanup.
function onStockPush(fn) {
  let t;
  const handler = (e) => {
    if (e.detail?.event !== "stock") return;
    clearTimeout(t);
    t = setTimeout(fn, 800);
  };
  window.addEventListener("dx:realtime", handler);
  return () => { clearTimeout(t); window.removeEventListener("dx:realtime", handler); };
}
// Sentinel section: the combined view over the whole store (no section filter).
const ALL_SECTIONS = "ALL";

const C = {
  blue: "#2563eb", green: "#059669", red: "#dc2626", amber: "#d97706",
  purple: "#7c3aed", cyan: "#0891b2", slate: "#334155",
  rose: "#e11d48", orange: "#ea580c", reorder: "#f97316", muted: "#64748b",
};
const PIE = [C.blue, C.green, C.amber, C.purple, C.cyan, "#ec4899", C.red];

// Canonical stock-status colours — identical to the desktop dashboard's
// STATUS_COLOR (components/spare/OverviewPanels.jsx), so a given status reads
// the SAME colour on the wall as on the desktop: Out of Stock rose, Below
// Minimum amber, Reorder orange, Above Maximum blue, Healthy green, Not Counted
// slate. (The board's own `C` palette stays for non-status / categorical use.)
const STATUS = {
  out: "#e11d48", below: "#f59e0b", reorder: "#f97316",
  above: "#3b82f6", healthy: "#10b981", none: "#94a3b8",
};

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
  "#e11d48": ["#fb7185", "#e11d48"],
  "#ea580c": ["#fb923c", "#ea580c"],
  "#f97316": ["#fdba74", "#f97316"],
  "#64748b": ["#94a3b8", "#64748b"],
  // Canonical status hues (STATUS) so their gauges / tiles keep the 3D gradient.
  "#f59e0b": ["#fbbf24", "#f59e0b"],
  "#3b82f6": ["#60a5fa", "#3b82f6"],
  "#10b981": ["#34d399", "#10b981"],
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

// Every datum the board loads is undefined while its call is in flight and
// null once it failed — so a failed fetch renders "—" or an error, never a
// zero that reads as a healthy store.
const stateOf = (x) => (x === undefined ? "loading" : x === null ? "error" : "ok");
const fetchData = (pr) => pr.then((r) => r.data?.data ?? null).catch(() => null);
const asList = (x) => (Array.isArray(x) ? x : null);
const asObj = (x) => (x && typeof x === "object" && !Array.isArray(x) ? x : null);
// A problem count tints its tile only when there is something to see; zero or
// unknown stays neutral (a glowing red "0" reads as an alarm).
const hot = (n, color) => (n ? color : C.muted);

// Local calendar day as "YYYY-MM-DD" — the month-to-date window of the
// department split, on the plant's own clock (as the backend reads it).
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const todayISO = () => isoDay(new Date());
const monthStartISO = () => { const d = new Date(); return isoDay(new Date(d.getFullYear(), d.getMonth(), 1)); };

// The overview needs the Spare Store view right, but a wallboard account may
// hold only the Live Dashboard right. Refused, the board rebuilds the figures
// it shows from the parts list (the same rows the overview reads) by the
// overview's own rules (backend spare_dashboard_service), so both agree.
// `today` / `deptMonth` are null when their call failed — kept null, never 0.
function overviewFromList(rows, today, deptMonth) {
  const health = {};
  const bySec = {};
  let counted = 0, valued = 0, value = 0, excessValue = 0;
  rows.forEach((r) => {
    health[r.status] = (health[r.status] || 0) + 1;
    if (r.qty_on_hand != null) counted += 1;
    if (r.stock_value != null) {
      valued += 1;
      value += r.stock_value;
      if (r.stock_value) bySec[r.section_id] = (bySec[r.section_id] || 0) + r.stock_value;
    }
    if (r.status === "Above Maximum" && r.unit_price && r.max_stock_level) {
      excessValue += (r.qty_on_hand - r.max_stock_level) * r.unit_price;
    }
  });
  // Worst status first; within it the dearest restock (the overview's order).
  const rank = { "Out of Stock": 0, "Below Minimum": 1 };
  const cost = (r) => (r.shortfall != null ? r.shortfall : Math.max((r.min_stock_level || 0) - (r.qty_on_hand || 0), 0)) * (r.unit_price || 0);
  const critical = rows.filter((r) => r.status in rank)
    .sort((a, b) => rank[a.status] - rank[b.status] || cost(b) - cost(a))
    .slice(0, 10);
  const dept = deptMonth ? deptMonth.slice().sort((a, b) => (b.value || 0) - (a.value || 0)) : null;
  return {
    fallback: true,
    kpis: {
      total_parts: rows.length, counted_parts: counted, uncounted_parts: rows.length - counted,
      stock_value: value, valued_parts: valued, today,
    },
    health: Object.entries(health).map(([status, count]) => ({ status, count })),
    value: {
      total: value, excess: excessValue,
      by_section: Object.entries(bySec)
        .map(([sid, v]) => ({ section_id: sid === "null" ? null : Number(sid), value: v }))
        .sort((a, b) => b.value - a.value),
    },
    critical_parts: critical,
    consumption: dept && {
      this_month_by_department: dept.slice(0, 5),
      comparison: { current: { value: dept.reduce((s, d) => s + (d.value || 0), 0) } },
    },
  };
}
// The ERP stock snapshot's date and age, off the ERP-vs-physical rows (the
// fallback for the overview's `erp.stock_snapshot`). Stale after 24 h, as the
// overview rules; an unreadable age is reported stale, never fresh.
function snapshotOf(rows) {
  const last = rows.reduce((m, r) => (r.erp_synced_at && (!m || r.erp_synced_at > m) ? r.erp_synced_at : m), null);
  if (!last) return { state: "NONE", synced_at: null, age_hours: null };
  // A naive ISO stamp from the DB is UTC.
  const t = parseServerTime(last);
  const age = t ? Math.round(((Date.now() - t.getTime()) / 3600000) * 10) / 10 : null;
  return { state: age == null || age > 24 ? "STALE" : "SYNCED", synced_at: last, age_hours: age };
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
// The tooltip of every bar / line chart on the board. Recharts' own is a white
// box with black text and a grey hover band — a glaring patch on the night
// theme, and it hid the bars beside it. This is the dark glass the drill donut
// uses (readable by day and by night), sized off the screen height, one line
// per series with its colour; a series the hovered point has no figure for is
// left out, and `fmt` formats the values (rupees on the in-vs-out chart).
function BoardTip({ active, payload, label, fmt = fmtInt }) {
  if (!active || !payload) return null;
  const rows = payload.filter((it) => it && it.value != null);
  if (!rows.length) return null;
  const text = "max(11px, 1.25vh)";
  // A lone unnamed series (dataKey "value") needs no caption beside its figure.
  const named = rows.length > 1 || (rows[0].name && rows[0].name !== "value");
  const dot = (it) => {
    const c = it.color || it.fill || it.stroke;
    return typeof c === "string" && !c.startsWith("url(") ? c : "#60a5fa";
  };
  return (
    <div style={{ background: "rgba(10,20,40,0.96)", border: "1px solid rgba(125,195,255,0.4)", borderRadius: 8, padding: "0.6vh 1vh", boxShadow: "0 10px 30px rgba(0,0,0,0.5)", pointerEvents: "none" }}>
      {label != null && label !== "" && <div style={{ color: "#fff", fontWeight: 700, fontSize: text, marginBottom: "0.2vh" }}>{label}</div>}
      {rows.map((it) => (
        <div key={String(it.dataKey ?? it.name)} style={{ display: "flex", alignItems: "center", gap: "0.6vh", fontSize: text, lineHeight: 1.5, color: "#b4c5e0", whiteSpace: "nowrap" }}>
          <span style={{ width: "0.9vh", height: "0.9vh", minWidth: 7, minHeight: 7, borderRadius: "50%", background: dot(it) }} />
          {named && <span>{it.name}</span>}
          <span style={{ marginLeft: "auto", paddingLeft: named ? "1.4vh" : 0, color: "#fff", fontWeight: 700 }}>{fmt(it.value)}</span>
        </div>
      ))}
    </div>
  );
}
const monthLabel = (period) => {
  // "2026-09" -> "Sep"
  const [y, m] = (period || "").split("-");
  const names = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return m ? names[Number(m)] || period : (y || period);
};
// Server stamps (ledger / ERP sync) are UTC without a zone — parseServerTime
// reads them as UTC so they show on the plant's clock, not 5 h 30 m early.
const timeOf = (iso) => {
  const d = iso ? parseServerTime(iso) : null;
  return d ? d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "—";
};
// "2026-08-10…" -> "10 Aug" (day-month, clearer than the ambiguous "08-10").
const dayLabel = (d, iso) => (d && !isNaN(d.getTime())
  ? d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" }) : String(iso).slice(5, 10));
const fmtDay = (iso) => (iso ? dayLabel(parseServerTime(iso), iso) : "");
// ERP's gate-entry time is the plant's own wall clock (the window reports judge
// it that way), so it is read as local — never shifted as if it were UTC.
const fmtPlantDay = (iso) => (iso ? dayLabel(new Date(iso), iso) : "");
// A bare calendar date ("2026-10-31") as "31 Oct". Read field by field — handed
// to Date() as a string it is taken as UTC midnight and can land on the day
// before in a zone behind UTC.
const fmtIsoDay = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
  return m ? dayLabel(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])), iso) : "";
};
// A server stamp's calendar day ("YYYY-MM-DD") on the plant's clock — slicing
// the UTC string would put a 00:00–05:30 movement on the day before.
const dayISOOf = (iso) => {
  const d = iso ? parseServerTime(iso) : null;
  return d ? isoDay(d) : String(iso || "").slice(0, 10);
};
// Today's movements by clock time, older ones by date — a bare "10:15" on a
// weeks-old row would read as this morning.
const whenOf = (iso) => {
  if (!iso) return "—";
  const d = parseServerTime(iso);
  if (!d) return "—";
  return d.toDateString() === new Date().toDateString() ? timeOf(iso) : fmtDay(iso);
};

// ---- small building blocks -------------------------------------------------

function Card({ children, className = "", style, ...rest }) {
  // Glassmorphism: a translucent gradient pane with a soft inner highlight and a
  // deep drop shadow. The glass tokens flip with the day/night theme. NOTE: no
  // backdrop-blur — on a wallboard with ~15 cards at 4K it made every frame
  // expensive to composite (charts opened slowly); the translucent gradient alone
  // reads as glass and stays fast.
  return (
    <div className={`rounded-2xl border ${className}`} {...rest}
      style={{ background: "var(--dx-glass)", borderColor: "var(--dx-glass-brd)", boxShadow: "var(--dx-glass-shadow)", ...style }}>
      {children}
    </div>
  );
}

// A panel body that has nothing to draw yet: loading (a pulsing block), a
// failed call (says so, with Retry) or an honest empty reading.
function PanelState({ state, empty, onRetry, h = "13vh" }) {
  if (state === "loading") {
    return <div className="animate-pulse rounded-xl" style={{ height: h, background: "var(--dx-track)" }} aria-label="Loading" />;
  }
  if (state === "error") {
    return (
      <div className="flex flex-col items-center justify-center gap-[0.8vh] text-center" style={{ height: h }}>
        <span className="text-[1.5vh] font-semibold text-[var(--dx-t3)]">Couldn't load this panel</span>
        {onRetry && (
          <button type="button" onClick={onRetry}
            className="inline-flex items-center gap-[0.5vh] rounded-full px-[1.3vh] py-[0.35vh] text-[1.3vh] font-bold text-[var(--dx-t1)] hover:brightness-110"
            style={{ background: "var(--dx-track)" }}>
            <RotateCw size={14} aria-hidden="true" /> Retry
          </button>
        )}
      </div>
    );
  }
  return <div className="flex items-center justify-center px-[1vh] text-center text-[1.6vh] text-[var(--dx-t4)]" style={{ height: h }}>{empty}</div>;
}

// Header status chips: what the board knows about ERP, said plainly — the
// stock snapshot's date and age (a snapshot, never a live feed) and whether
// movements are written back. Read from the overview's store-wide `erp` block.
function ErpChips({ erp, state }) {
  const chip = "inline-flex items-center gap-[0.5vh] rounded-full border px-[1vh] py-[0.2vh] text-[1.15vh] font-bold whitespace-nowrap";
  const tone = {
    amber: { background: "rgba(245,158,11,0.18)", borderColor: "rgba(251,191,36,0.55)", color: "#fcd34d" },
    green: { background: "rgba(16,185,129,0.16)", borderColor: "rgba(52,211,153,0.5)", color: "#6ee7b7" },
    slate: { background: "rgba(255,255,255,0.08)", borderColor: "rgba(255,255,255,0.22)", color: "rgba(255,255,255,0.8)" },
  };
  if (!erp) {
    return (
      <span className={chip} style={tone.slate}>
        <Database size={12} aria-hidden="true" />{state === "loading" ? "ERP status loading…" : "ERP status unavailable"}
      </span>
    );
  }
  // Either half can be missing when its call failed — it says so, rather than
  // "none received" / "off" that would read as a known state.
  const snap = erp.stock_snapshot;
  const days = snap?.age_hours != null ? Math.floor(snap.age_hours / 24) : null;
  const day = snap?.synced_at ? fmtDay(snap.synced_at) : null;
  const snapLabel = !snap ? "ERP stock snapshot: status unavailable"
    : snap.state === "NONE" || !day ? "ERP stock snapshot: none received"
      : snap.state === "STALE" ? `ERP stock snapshot STALE · ${day}${days != null ? ` (${days} d)` : ""}`
        : `ERP stock snapshot · ${day} ${timeOf(snap.synced_at)}`;
  const w = erp.write;
  return (
    <>
      <span className={chip} style={snap?.state === "SYNCED" ? tone.green : snap?.state === "STALE" ? tone.amber : tone.slate}
        title="Quantities ERP last reported for this store's parts — a snapshot, not a live feed">
        <Database size={12} aria-hidden="true" />{snapLabel}
      </span>
      <span className={chip} style={w?.active ? tone.green : tone.slate} title={w?.reason || undefined}>
        <RefreshCw size={12} aria-hidden="true" />
        {w ? `ERP write-back ${w.active ? "on" : "off"}${w.pending ? ` · ${fmtInt(w.pending)} queued` : ""}` : "ERP write-back: status unavailable"}
      </span>
    </>
  );
}

// Sized in vh like everything else on the board. It used to be a fixed 36px icon
// with a 12px gap — fine on the tall wall, but ~6.6% of a laptop screen per card,
// which alone pushed the landscape board past one screen. The title truncates
// instead of pushing the action off the card. `tight` = the card is half-width on
// the portrait wall, so the action keeps only its arrow there; `note` is plain
// right-hand text (not a button).
function PanelHead({ icon: Icon, color, title, action, onAction, note, tight = false }) {
  return (
    <div className="flex items-center justify-between gap-[1vh] mb-[0.4vh] landscape:mb-[0.6vh]">
      <div className="flex items-center gap-[0.8vh] min-w-0">
        <span className="w-[2.4vh] h-[2.4vh] landscape:w-[3vh] landscape:h-[3vh] rounded-[0.8vh] flex items-center justify-center shrink-0 [&>svg]:w-[1.45vh] [&>svg]:h-[1.45vh] landscape:[&>svg]:w-[1.7vh] landscape:[&>svg]:h-[1.7vh]" style={{ background: `${color}22`, boxShadow: `inset 0 0 0 1px ${color}22` }}>
          <Icon size={20} style={{ color }} />
        </span>
        <h3 className="dx-radiant text-[1.45vh] landscape:text-[1.6vh] font-bold text-[var(--dx-t1)] truncate">{title}</h3>
      </div>
      {note && <span className="shrink-0 text-[1.05vh] landscape:text-[1.1vh] text-[var(--dx-t4)] whitespace-nowrap">{note}</span>}
      {action && (
        <button onClick={onAction} className="shrink-0 text-[1.2vh] landscape:text-[1.35vh] font-semibold flex items-center gap-[0.4vh] whitespace-nowrap" style={{ color }}>
          <span className={tight ? "hidden landscape:inline" : ""}>{action}</span><span>→</span>
        </button>
      )}
    </div>
  );
}

// A headline tile, sized to be read across the store floor. `state` is the
// fetch state of its source: loading shows a pulsing bar, a failed call keeps
// the "—" the caller passes and says so — never a zero. Tapping opens the
// tile's list in the board's own drill.
// A slim band that titles a row of cards in the LANDSCAPE layout, the way the QMP
// live board titles its sections. Hidden on the portrait wall, where height is
// the scarce axis. `tone` is a CSS colour (a --pill-* var keeps it readable in
// both the day and night themes).
function SectionBar({ title, hint, tone = "var(--pill-blue)", className = "" }) {
  return (
    <div className={`hidden landscape:flex landscape:col-span-4 items-center gap-[1.2vh] rounded-lg px-[1.2vh] py-[0.2vh] ${className}`}
      style={{ background: `color-mix(in srgb, ${tone} 9%, transparent)`, border: `1px solid color-mix(in srgb, ${tone} 26%, transparent)` }}>
      <span className="text-[1.15vh] font-extrabold uppercase tracking-[0.22em] whitespace-nowrap" style={{ color: tone }}>{title}</span>
      {hint && <span className="text-[1.05vh] text-[var(--dx-t4)] truncate">{hint}</span>}
    </div>
  );
}

// KPI tile styled like the desktop dashboard's KpiCard (featured layout): the
// plain glass card — NO glowing coloured border — with a soft-tinted chip in the
// top-right corner, the label above, and a tone-coloured figure. The colour
// lives in the chip and the number, not a border halo.
// On the PORTRAIT wall the six tiles sit three across in two rows, so the tile
// goes compact there: no corner chip, the `short` title, a slightly smaller
// figure and the one-line `subShort`. Landscape (six across) keeps the full tile.
function Kpi({ icon: Icon, title, short, value, extra, sub, subShort, color, state = "ok", onClick }) {
  const open = (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick?.(); }
  };
  return (
    <Card className="min-w-0 px-[0.9vh] py-[0.5vh] landscape:px-[1.1vh] landscape:py-[0.9vh] cursor-pointer transition hover:brightness-[1.03] focus:outline-none focus-visible:ring-2 focus-visible:ring-toyotared/50"
      role="button" tabIndex={0} aria-label={`${title}: ${value}. Open the list`} onClick={onClick} onKeyDown={open}>
      <div className="relative">
        <span className="absolute top-0 right-0 hidden landscape:grid place-items-center rounded-xl shrink-0"
          style={{ width: "3.4vh", height: "3.4vh", background: `${color}22`, color }}>
          <Icon size={16} />
        </span>
        <div className="landscape:pr-[4vh] text-[1.1vh] landscape:text-[1.3vh] font-semibold uppercase tracking-wide text-[var(--dx-t3)] truncate">
          <span className="landscape:hidden">{short || title}</span><span className="hidden landscape:inline">{title}</span>
        </div>
        {state === "loading" ? (
          <span className="block mt-[0.5vh] h-[2.6vh] w-[9vh] max-w-full rounded-md animate-pulse" style={{ background: "var(--dx-track)" }} />
        ) : (
          <div className="mt-[0.2vh] landscape:mt-[0.3vh] flex items-baseline gap-[0.6vh] landscape:gap-[0.8vh] min-w-0">
            <span className="text-[2.3vh] landscape:text-[2.7vh] font-extrabold leading-none tabular-nums shrink-0" style={{ color }}>{value}</span>
            {extra && <span className="text-[1.15vh] landscape:text-[1.5vh] font-bold truncate" style={{ color }}>{extra}</span>}
          </div>
        )}
        <div className="mt-[0.2vh] landscape:mt-[0.3vh] text-[1vh] landscape:text-[1.1vh] leading-tight text-[var(--dx-t4)] line-clamp-1 landscape:line-clamp-2">
          {state === "error" ? "Couldn't load — see the alert bar" : (
            <><span className="landscape:hidden">{subShort || sub}</span><span className="hidden landscape:inline">{sub}</span></>
          )}
        </div>
      </div>
    </Card>
  );
}

// A figure inside a panel (a gauge, a band, a department, a small tile) that
// opens the list behind it in the board's drill — a pointer, a soft highlight
// on hover, and Enter / Space like the KPI tiles. `hover` is the highlight: a
// tint by default, a ring on a tile that is already tinted.
function Tap({ onOpen, label, className = "", hover = "hover:bg-[var(--dx-track)]", style, children }) {
  const key = (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen?.(); }
  };
  return (
    <div role="button" tabIndex={0} aria-label={label} title={label} onClick={onOpen} onKeyDown={key} style={style}
      className={`cursor-pointer transition focus:outline-none focus-visible:ring-2 focus-visible:ring-toyotared/50 ${hover} ${className}`}>
      {children}
    </div>
  );
}

// An in / out bar with a figure keeps a 3 px sliver, so a month whose ₹ is tiny
// next to the axis is still a bar that can be tapped; ₹0 or no figure draws none.
const tapSliver = (v) => (v > 0 ? 3 : 0);

// A month under the in-vs-out bars, drawn as a focusable button: Enter / Space
// (or a tap) opens that month's movements, both sides. Like a Tap tile it is
// tinted on hover and ringed when reached by the keyboard (an SVG <g> draws no
// focus ring of its own).
function MonthTick({ x, y, payload, fill, fontSize, onOpen }) {
  const [hover, setHover] = useState(false);
  const [ring, setRing] = useState(false);
  const open = (e) => { e.stopPropagation(); onOpen?.(payload?.value); };
  const keyFocus = (el) => { try { return el.matches(":focus-visible"); } catch { return true; } };
  const w = Math.max(3, String(payload?.value ?? "").length) * fontSize * 0.62 + 8;
  return (
    <g transform={`translate(${x},${y})`} role="button" tabIndex={0} style={{ cursor: "pointer", outline: "none" }}
      aria-label={`${payload?.value}: open that month's movements`} onClick={open}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(e); } }}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      onFocus={(e) => setRing(keyFocus(e.currentTarget))} onBlur={() => setRing(false)}>
      {(hover || ring) && (
        <rect x={-w / 2} y={-2} width={w} height={fontSize * 1.35} rx={4}
          style={{ fill: "var(--dx-track)", stroke: ring ? "rgba(235,10,30,0.5)" : "none", strokeWidth: 2 }} />
      )}
      <text dy="0.71em" textAnchor="middle" fill={fill} fontSize={fontSize}>{payload?.value}</text>
    </g>
  );
}

// ERP vs physical in figures, over any set of comparison rows — the panel's
// whole list, or the slice a tile opens (so a drill's chips tie out to it).
function erpSummary(list) {
  const reconciled = list.filter((r) => r.gap_qty != null);
  const matched = reconciled.filter((r) => r.status === "MATCH").length;
  const by = (s) => list.filter((r) => r.status === s).length;
  return {
    total: list.length, matched, reconciled: reconciled.length,
    short: by("SHORT"), excess: by("EXCESS"), no_physical: by("NO_PHYSICAL"), not_synced: by("NOT_SYNCED"),
    accuracy_pct: reconciled.length ? Math.round((matched / reconciled.length) * 10000) / 100 : null,
    // Both unit totals over the SAME parts — those with an ERP figure AND a
    // count — or the two sums would set ERP's few hundred parts against every
    // part the store has counted.
    erp_units: reconciled.reduce((s, r) => s + (r.erp_qty || 0), 0),
    physical_units: reconciled.reduce((s, r) => s + (r.physical_qty || 0), 0),
  };
}

function Gauge({ pct, color, label, sub, w = "13vh" }) {
  const p = Math.max(0, Math.min(100, pct || 0));
  const gid = `gg-${color.replace("#", "")}`;
  const g = GRAD[color] || [color, color];
  return (
    <div className="flex flex-row landscape:flex-col items-center gap-[0.7vh] landscape:gap-0 min-w-0">
      <svg viewBox="0 0 120 68" className="shrink-0" style={{ width: w }}>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor={g[0]} /><stop offset="1" stopColor={g[1]} />
          </linearGradient>
        </defs>
        <path d="M12 60 A48 48 0 0 1 108 60" fill="none" style={{ stroke: "var(--dx-gauge)" }} strokeWidth="13" strokeLinecap="round" pathLength="100" />
        <path d="M12 60 A48 48 0 0 1 108 60" fill="none" stroke={`url(#${gid})`} strokeWidth="13" strokeLinecap="round" pathLength="100" strokeDasharray={`${p} 100`} style={{ filter: `drop-shadow(0 2px 4px ${color}66)` }} />
        <text x="60" y="54" textAnchor="middle" fontSize="26" fontWeight="800" style={{ fill: "var(--dx-t1)" }}>{Math.round(p)}%</text>
      </svg>
      <div className="min-w-0 text-left landscape:text-center landscape:-mt-[0.6vh]">
        <div className="text-[1.3vh] landscape:text-[1.4vh] font-bold leading-tight flex items-center justify-start landscape:justify-center gap-[0.5vh]" style={{ color }}>
          <span className="w-[1vh] h-[1vh] rounded-full inline-block shrink-0" style={{ background: color }} />{label}
        </div>
        <div className="text-[1.1vh] landscape:text-[1.2vh] leading-tight text-[var(--dx-t3)] whitespace-nowrap">{sub}</div>
      </div>
    </div>
  );
}

function DeptBar({ name, value, pct, color }) {
  return (
    <div className="flex items-center gap-[1vh]">
      <span className="w-[8vh] landscape:w-[13vh] shrink-0 text-[1.25vh] landscape:text-[1.35vh] font-medium text-[var(--dx-t2)] truncate">{name}</span>
      <div className="flex-1 h-[1.5vh] rounded-full bg-[var(--dx-track)] overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: gradCss(color, 90), boxShadow: `0 1px 4px ${color}55` }} />
      </div>
      <span className="w-[5vh] text-right text-[1.4vh] font-bold text-[var(--dx-t1)]">{fmtInt(value)}</span>
      <span className="hidden landscape:inline w-[4vh] text-right text-[1.3vh] text-[var(--dx-t4)]">{Math.round(pct)}%</span>
    </div>
  );
}

// One band of the excess-aging card: how much of the money above max last came
// in that long ago. The portrait wall card is half width, so it shows the short
// label and drops the part count; landscape has room for both.
const AGE_TONE = { "0-30": STATUS.healthy, "31-90": STATUS.below, "91+": STATUS.reorder, none: STATUS.out };
const AGE_SHORT = { "0-30": "0–30 d", "31-90": "31–90 d", "91+": "91+ d", none: "No inward" };
function AgeRow({ b, max, since }) {
  const color = AGE_TONE[b.key] || C.muted;
  // A band with money always shows a sliver, so a small amount is not read as none.
  const pct = max > 0 && b.value > 0 ? Math.max((b.value / max) * 100, 2) : 0;
  return (
    <div className="flex items-center gap-[0.8vh] text-[1.15vh] landscape:text-[1.3vh] leading-none">
      <span className="w-[6.2vh] landscape:w-[16.5vh] shrink-0 truncate text-[var(--dx-t2)]">
        <span className="landscape:hidden">{AGE_SHORT[b.key] || b.label}</span>
        <span className="hidden landscape:inline">{b.key === "none" && since ? `No inward since ${since}` : b.label}</span>
      </span>
      <div className="flex-1 h-[1.1vh] landscape:h-[1.5vh] rounded-full bg-[var(--dx-track)] overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: gradCss(color, 90), boxShadow: `0 1px 4px ${color}55` }} />
      </div>
      <span className="hidden landscape:inline w-[4vh] shrink-0 text-right tabular-nums text-[var(--dx-t4)]">{fmtInt(b.parts)}</span>
      <span className="w-[7vh] landscape:w-[8.5vh] shrink-0 text-right font-bold tabular-nums text-[var(--dx-t1)]">{fmtMoney(b.value)}</span>
    </div>
  );
}

// The action tracker's columns. On the portrait wall (~55vh wide) there is room
// for the problem, its count, the money, WHO must act and the status; landscape
// adds what has to be done and the target date. Header and rows share this one
// template so the columns line up.
const TRK_COLS = "grid items-center gap-x-[1vh] grid-cols-[minmax(0,1.5fr)_4.6vh_7.4vh_minmax(0,1.2fr)_5.6vh] landscape:grid-cols-[minmax(0,1.5fr)_7vh_11vh_minmax(0,1.3fr)_minmax(0,1fr)_8vh_8vh]";
// Shorter names for the half-height wall rows; landscape shows the full label.
const TRK_SHORT = {
  srv_pending: "GRN / quality pending",
  returns_pending: "Returns to inspect", erp_pending: "Not yet in ERP",
};
const SEV_RANK = { critical: 0, warning: 1, info: 2, ok: 3 };
function TrackerRow({ it, wallHidden, onOpen }) {
  const clear = it.status === "CLEAR";
  const tone = clear ? C.muted
    : it.severity === "critical" ? STATUS.out : it.severity === "warning" ? STATUS.below
      : it.severity === "info" ? STATUS.above : C.muted;
  const [pill, pillColor, rgb] = it.overdue ? ["OVERDUE", "var(--pill-red)", "244,63,94"]
    : it.status === "OPEN" ? (it.severity === "critical" ? ["OPEN", "var(--pill-red)", "244,63,94"] : ["OPEN", "var(--pill-amber)", "245,158,11"])
      : clear ? ["CLEAR", "var(--pill-green)", "16,185,129"] : ["—", "var(--pill-slate)", "148,163,184"];
  const Row = onOpen ? "button" : "div";
  return (
    <Row {...(onOpen ? { type: "button", onClick: onOpen } : {})}
      className={`${TRK_COLS} ${wallHidden ? "hidden landscape:grid" : ""} w-full text-left px-[0.6vh] py-[0.3vh] landscape:py-[0.45vh] border-b border-[var(--dx-divide)] last:border-b-0 text-[1.15vh] landscape:text-[1.35vh] leading-tight ${clear ? "opacity-55" : ""} ${onOpen ? "cursor-pointer hover:bg-[var(--dx-track)] transition-colors" : ""}`}>
      <span className="min-w-0 flex items-center gap-[0.7vh]">
        <span className="w-[0.9vh] h-[0.9vh] rounded-full shrink-0" style={{ background: tone }} />
        <span className="min-w-0 truncate landscape:shrink-0 font-semibold text-[var(--dx-t1)]">
          <span className="landscape:hidden">{TRK_SHORT[it.key] || it.label}</span><span className="hidden landscape:inline">{it.label}</span>
        </span>
        {it.detail && <span className="hidden landscape:inline min-w-0 truncate text-[1.15vh] text-[var(--dx-t4)]" title={it.detail}>{it.detail}</span>}
      </span>
      <span className="text-right font-extrabold tabular-nums" style={{ color: tone }}>{fmtInt(it.count)}</span>
      <span className="text-right font-semibold tabular-nums whitespace-nowrap text-[var(--dx-t1)]">
        {it.value != null ? fmtMoney(it.value) : <span className="text-[var(--dx-t4)]">—</span>}
      </span>
      <span className="hidden landscape:block min-w-0 truncate text-[var(--dx-t2)]">{it.action}</span>
      <span className="min-w-0 truncate font-semibold text-[var(--dx-t2)]">{it.owner || "—"}</span>
      <span className="hidden landscape:block whitespace-nowrap tabular-nums" style={{ color: it.overdue ? "var(--pill-red)" : "var(--dx-t3)" }}>
        {it.target_date ? fmtIsoDay(it.target_date) : "—"}
      </span>
      <span className="flex justify-end">
        <span className="rounded px-[0.7vh] py-[0.15vh] text-[1vh] landscape:text-[1.1vh] font-bold whitespace-nowrap" style={{ background: `rgba(${rgb},0.16)`, color: pillColor }}>{pill}</span>
      </span>
    </Row>
  );
}

// The live clock ticks once a second. It lives in its own component so that tick
// re-renders ONLY the clock, never the whole board (and its heavy charts).
// Kept narrow on purpose (~20vh): on a 9:16 portrait wall the header has only
// ~50vh of width, and the old wide card (date, weekday/year column, clock, toggle
// stacked beside each other) left the title no room. The time leads; the small
// line under it carries the weekday and when the board figures last refreshed.
function HeaderClock({ isDay, onToggle, updated }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const hms = { hour: "2-digit", minute: "2-digit", second: "2-digit" };
  const clock = now.toLocaleTimeString("en-GB", hms);
  const dayNum = now.toLocaleDateString("en-GB", { day: "2-digit" });
  const monthShort = now.toLocaleDateString("en-GB", { month: "short" }).toUpperCase();
  const weekday = now.toLocaleDateString("en-GB", { weekday: "short" });
  const stamp = updated ? updated.toLocaleTimeString("en-GB", hms) : null;
  return (
    <div className="shrink-0 flex items-center gap-[0.8vh] rounded-2xl px-[1vh] py-[0.35vh] landscape:py-[0.45vh] landscape:order-4"
      style={isDay
        ? { background: "#f8fafc", border: "1px solid #e2e8f0" }
        : { background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.14)" }}>
      <div className={`w-[3.2vh] h-[3.2vh] landscape:w-[3.5vh] landscape:h-[3.5vh] rounded-xl bg-white flex flex-col items-center justify-center leading-none shrink-0 shadow-md ${isDay ? "border border-slate-200" : ""}`}>
        <span className="text-[0.85vh] font-extrabold text-rose-500 uppercase tracking-widest">{monthShort}</span>
        <span className="text-[1.75vh] font-extrabold text-[#0f172a]">{dayNum}</span>
      </div>
      <div className="leading-none">
        <div className={`text-[2.25vh] font-extrabold tabular-nums leading-none ${isDay ? "text-slate-900" : ""}`}>{clock}</div>
        <div className={`mt-[0.4vh] flex items-center gap-[0.5vh] text-[1.05vh] font-semibold leading-none whitespace-nowrap ${isDay ? "text-slate-500" : "text-white/60"}`}>
          <span>{weekday}</span>
          {stamp && (
            <span className="inline-flex items-center gap-[0.35vh] tabular-nums" title="When the board figures last refreshed">
              <span aria-hidden="true">·</span>
              <RefreshCw style={{ width: "1vh", height: "1vh" }} aria-hidden="true" />
              <span className="sr-only">Updated</span>{stamp}
            </span>
          )}
        </div>
      </div>
      <button onClick={onToggle}
        title={isDay ? "Day shift — click to switch to night" : "Night shift — click to switch to day"}
        className="shrink-0 inline-flex items-center justify-center rounded-full w-[2.8vh] h-[2.8vh] text-white shadow-md transition hover:brightness-110 active:scale-90"
        style={{ background: isDay ? "#10b981" : "#6366f1" }}>
        {isDay ? <Sun size={16} /> : <Moon size={16} />}
      </button>
    </div>
  );
}

// ---- main ------------------------------------------------------------------

export default function TvDashboard() {
  const navigate = useNavigate();
  // The exit pill opens the store's dashboard, which a Live Board login (store's
  // role templates, 17 Oct 2026: the board and nothing else) may not open — it
  // would land on "Access restricted" inside the full app. Such a login gets no
  // exit: the board is all that device shows.
  const canOpenStore = useCan("spare_store");
  // The wallboard lives outside MainLayout, so it opens its own SSE connection —
  // stock moves then refresh the TV immediately instead of on the 2-min poll.
  useRealtime();
  const [data, setData] = useState({});
  const [hour, setHour] = useState(() => new Date().getHours()); // only for day/night auto — the ticking clock lives in <HeaderClock/> so it doesn't re-render the charts every second
  const [sections, setSections] = useState([]);
  const [sectionId, setSectionId] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });
  const menuAnchor = useRef(null);
  const [isFs, setIsFs] = useState(false);
  const [stack, setStack] = useState([]); // Explore-Data drill frames (in-board)
  const [trendView, setTrendView] = useState("month"); // the value trend's Day / Week / Month / Year
  const [lastUpdated, setLastUpdated] = useState(null); // when the board figures last refreshed (header "Updated" stamp)
  // Sticky day/night: seeded from localStorage so a choice survives leaving the
  // board (e.g. to the Spare Store) and coming back, and reloads — it stays until
  // toggled again. null = follow the plant clock.
  const [shiftOverride, setShiftOverride] = useState(readShift);
  useEffect(() => {
    try {
      if (shiftOverride == null) localStorage.removeItem(SHIFT_KEY);
      else localStorage.setItem(SHIFT_KEY, shiftOverride ? "day" : "night");
    } catch { /* storage may be unavailable (private mode) — fall back to in-memory */ }
  }, [shiftOverride]);
  // Bumped by a Retry tap: both loaders re-run now instead of waiting out the poll.
  const [retry, setRetry] = useState(0);
  const reload = () => setRetry((n) => n + 1);
  // True while the overview refuses this account (403): the board then builds
  // its figures from the store-access endpoints instead (overviewFromList).
  const [ovDenied, setOvDenied] = useState(false);
  const frameSeq = useRef(0);

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
        const real = (stores.find((s) => s.code === STORE) || {}).sections || [];
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

  // Section-scoped data — refetched when the section changes (and on the poll or
  // a stock push). A section's KPIs, health, value split, critical list, this
  // shift's movements and this month's department split all come from ONE
  // overview call (the same figures the desktop dashboard shows); "All
  // Sections" reads the store overview the loader below already holds, so the
  // whole-store view never asks twice. The parts list feeds the charts and
  // drills; the management block feeds the tracker, aging and in-vs-out
  // panels.
  useEffect(() => {
    if (sectionId == null) return undefined;
    let alive = true;
    // A new section starts blank (loading), so its name never sits over the
    // previous section's figures; a refresh of the same section keeps them.
    const key = `${sectionId}|${ovDenied}`;
    setData((d) => (d.secFor === key ? d
      : { ...d, secFor: key, secOv: undefined, list: undefined, mgmt: undefined }));
    const load = async () => {
      const sec = sectionId === ALL_SECTIONS ? undefined : sectionId;
      // This view needs its own overview: a section always, and "All Sections"
      // too when the store overview was refused (it is then rebuilt here).
      const ownOv = ovDenied || sec !== undefined;
      const [secOv, list, mgmt, today, deptMonth] = await Promise.all([
        ownOv && !ovDenied ? fetchData(spareStockService.overview(STORE, sec)) : undefined,
        fetchData(spareStockService.list({ store_code: STORE, section_id: sec })),
        // The management block (action tracker, excess aging, receipt vs issue) —
        // silent, so a wall left on an older backend shows its
        // panels as "couldn't load" without a toast every refresh.
        fetchData(managementService.get(STORE, sec, undefined, { silent: true })),
        ovDenied ? fetchData(spareStockService.today(STORE, sec)) : undefined,
        ovDenied ? fetchData(spareStockService.consumption(STORE, "department", sec, undefined, monthStartISO(), todayISO())) : undefined,
      ]);
      if (!alive) return;
      const rows = asList(list);
      const built = !ownOv ? undefined
        : ovDenied ? (rows ? overviewFromList(rows, asObj(today), asList(deptMonth)) : null)
          : asObj(secOv);
      setData((d) => ({ ...d, secFor: key, secOv: built, list: rows, mgmt: asObj(mgmt) }));
      setLastUpdated(new Date());
    };
    load();
    const id = setInterval(load, REFRESH_MS);
    const offPush = onStockPush(load);
    return () => { alive = false; clearInterval(id); offPush(); };
  }, [sectionId, retry, ovDenied]);

  // Store-wide data — NOT per section, so switching sections never re-pulls it:
  // the store overview (All-Sections figures, GRN / quality pending, ERP state,
  // recent movements), the ERP-vs-physical rows and the confirmation queue. The
  // queue stays its own call: the overview's confirm count covers one of the two
  // statuses the queue holds, and the ticker's count must tie out to its drill.
  // The SRV register's size (flow) tells an empty register from "0 pending" —
  // needed only by an older overview that has no receiving_pending block.
  useEffect(() => {
    let alive = true;
    const load = async () => {
      let denied = false;
      const [storeOv, erpGap, flow] = await Promise.all([
        spareStockService.overview(STORE).then((r) => r.data?.data ?? null)
          .catch((e) => { denied = e?.response?.status === 403; return null; }),
        fetchData(spareStockService.erpGap(STORE)),
        fetchData(spareStockService.flow(STORE)),
      ]);
      const gapRows = asList(erpGap);
      let ovObj = asObj(storeOv);
      if (denied) {
        // Refused the overview: its store-level readings (GRN / quality
        // pending, ERP state, recent movements) come from the store-access
        // endpoints. A failed one stays null, so it reads "—", never a healthy
        // zero. GRN / quality pending (ERP) is read off the work queue's ERP
        // GRN lines — the QUALITY_PENDING ones are the overview's total, the
        // CHECK ones its `check`, so the tile says the same either way.
        const [srv, write, recent, queues] = await Promise.all([
          fetchData(spareStockService.pending(STORE)),
          fetchData(spareStockService.erpPending(STORE)),
          fetchData(spareStockService.activity(STORE, 6)),
          fetchData(spareFlowService.queues(STORE)),
        ]);
        const qc = asObj(asObj(queues)?.counts);
        const qLines = asList(asObj(queues)?.quality);
        const byState = (s) => (qLines || []).filter((r) => r.state === s).length;
        const qp = qLines && qLines.some((r) => r.state) ? byState("QUALITY_PENDING") : qc?.quality ?? null;
        ovObj = {
          fallback: true,
          receiving_pending: qp != null
            ? { total: qp, quality_pending: qp, check: qLines ? byState("CHECK") : null, erp: asObj(asObj(queues)?.erp) || undefined }
            : undefined,
          attention: [{ key: "srv_pending", count: asObj(srv)?.total ?? null }],
          erp: { stock_snapshot: gapRows ? snapshotOf(gapRows) : null, write: asObj(write) },
          recent_activity: asList(recent),
        };
      }
      if (!alive) return;
      setOvDenied(denied);
      setData((d) => ({ ...d, storeOv: ovObj, erpGap: gapRows, flow: asObj(flow) }));
    };
    load();
    const id = setInterval(load, REFRESH_MS);
    const offPush = onStockPush(load);
    return () => { alive = false; clearInterval(id); offPush(); };
  }, [retry]);

  const P = data;
  const secView = sectionId !== ALL_SECTIONS;
  // The overview this view reads: the section's own, or the store's for "All
  // Sections" — unless the store's was refused, when this view built its own.
  const ownOv = secView || ovDenied;
  const ov = ownOv ? P.secOv : P.storeOv;
  const ovState = stateOf(ov);
  const rowsState = stateOf(P.list);
  // The store's recent movements (a failed fallback call leaves them null).
  const recent = P.storeOv == null ? P.storeOv : asList(P.storeOv.recent_activity);
  const recentState = stateOf(recent);
  const rows = P.list || NO_ROWS;
  const kpis = ov?.kpis || null;
  const health = useMemo(() => Object.fromEntries((ov?.health || []).map((h) => [h.status, h.count])), [ov]);
  // A status count off the overview — null until it has loaded (renders "—").
  const countOf = (status) => (ov ? health[status] ?? 0 : null);
  const zero = countOf("Out of Stock");
  const belowMin = countOf("Below Minimum");
  const reorderN = countOf("Reorder");
  const excess = countOf("Above Maximum");
  const healthy = countOf("Healthy");
  const critical = ov ? zero + belowMin : null;
  const counted = kpis?.counted_parts ?? null;
  // A discontinued part (not required any more) has no levels to be healthy or
  // short against: the four health shares are of the counted parts without it,
  // so they still add to 100%.
  const discontinuedN = countOf("Discontinued");
  const healthBase = counted != null ? Math.max(0, counted - discontinuedN) : null;
  // Nothing counted means every Min/Max status is empty by definition — the
  // tiles say so rather than show zeros that read as a healthy store.
  const noneCounted = counted === 0;
  const statusVal = (n) => (noneCounted ? "—" : fmtInt(n));
  const excessValue = ov?.value?.excess ?? null;
  const today = kpis?.today || null;
  // This shift's issues and stock-ins — "—" (null) when the figure failed, a
  // real 0 otherwise. The shift starts 08:30 on the plant clock (`since` is
  // already plant-local, so it is read as written).
  const issuedQty = today ? today.issued_qty ?? 0 : null;
  const receivedQty = today ? today.received_qty ?? 0 : null;
  const receivedLines = today?.received_lines ?? 0;
  const sinceT = today?.since ? new Date(today.since) : null;
  const sinceWord = sinceT && !isNaN(sinceT.getTime())
    ? `since ${sinceT.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}` : "this shift";
  // Month-to-date department split; a failed fallback call is an error, not
  // "no issue this month".
  const deptState = ovState !== "ok" ? ovState : ov.consumption ? "ok" : "error";
  // Store-level readings — receiving, confirmations and ERP are never per section.
  const attn = (key) => (P.storeOv?.attention || []).find((a) => a.key === key);
  // Spec 1: spare receiving has no separate SRV step, and the GRN and the
  // quality clearance are done in ERP. The tile counts the ERP GRN lines still
  // waiting for ERP's quality clearance (overview.receiving_pending), with the
  // ERP mirror's freshness; an older overview without that block still
  // carries its SRV figure.
  const receiving = asObj(P.storeOv?.receiving_pending);
  const srvCount = P.storeOv ? receiving?.total ?? attn("srv_pending")?.count ?? null : null;
  const receivingFresh = receiving?.erp ? erpFreshness(receiving.erp) : null;
  // Only on that older figure: the app's SRV register has never held an SRV
  // for this store, so pending SRVs are not tracked here and the tile shows "—"
  // and says so — a 0 would read as "no material waiting".
  const srvUntracked = !receiving && P.flow ? P.flow.srv_total === 0 : false;
  const srvState = P.storeOv === undefined ? "loading" : srvCount == null && !srvUntracked ? "error" : "ok";
  const erp = P.storeOv?.erp ?? ov?.erp ?? null;
  const pendingErp = erp?.write?.pending ?? 0;
  // Money tied up above the maximum — (on-hand − max) × rate for each excess part.
  const excessOf = (r) => Math.max(0, (r.qty_on_hand || 0) - (r.max_stock_level || 0)) * (r.unit_price || 0);
  const excessValueRows = useMemo(
    () => rows.reduce((s, r) => (r.status === "Above Maximum" ? s + excessOf(r) : s), 0),
    [rows],
  );
  // Discontinued parts (never reordered) and the stock still on their racks —
  // the money management has to decide on: scrap, return or move elsewhere.
  const disc = useMemo(() => {
    const all = rows.filter((r) => r.discontinued);
    const held = all.filter((r) => (r.qty_on_hand || 0) > 0);
    return {
      all, held,
      cleared: all.filter((r) => r.qty_on_hand != null && r.qty_on_hand <= 0),
      // never counted: no stock figure at all, so neither "with stock" nor
      // "no stock left" — said on the With-stock tile so the three add up.
      uncounted: all.filter((r) => r.qty_on_hand == null).length,
      value: held.reduce((s, r) => s + (r.stock_value || 0), 0),
      noRate: held.filter((r) => r.stock_value == null).length,
      top: held.reduce((b, r) => ((r.stock_value || 0) > (b?.stock_value || 0) ? r : b), null),
    };
  }, [rows]);
  // The list's own reading of "nothing counted", for the panels drawn from it.
  const rowsNoneCounted = useMemo(() => rows.length > 0 && !rows.some((r) => r.qty_on_hand != null), [rows]);

  // In-board drill: Explore Data opens a full-screen view WITHIN the board
  // (it never leaves the dashboard) — a parts list with a chart, and each part
  // drills into its own stock-history charts + movement ledger.
  const openStack = (frame) => setStack([frame]);
  const pushFrame = (frame) => setStack((s) => [...s, frame]);
  const popTo = (i) => setStack((s) => s.slice(0, i + 1));
  // A drill whose rows come off the network opens at once, loading; the answer
  // then fills THAT frame only — if it has since been closed or replaced, a
  // late response is dropped instead of taking over the screen.
  const openAsync = (frame, load, { push = false } = {}) => {
    const token = ++frameSeq.current;
    const f = { ...frame, token, loading: true };
    if (push) pushFrame(f); else openStack(f);
    Promise.resolve().then(load).catch(() => ({ error: true }))
      .then((patch) => setStack((s) => (s.some((x) => x.token === token)
        ? s.map((x) => (x.token === token ? { ...x, ...patch, loading: false } : x))
        : s)));
  };
  // Every parts drill reads the section's list; it carries the list's fetch
  // state so an unloaded list never shows as "no parts".
  const openParts = (frame) => openStack({ kind: "partList", rowsState, ...frame });
  const shortBy = (r) => Math.max(0, (r.min_stock_level || 0) - (r.qty_on_hand || 0));
  const byStatus = (...st) => rows.filter((r) => st.includes(r.status));
  const openCritical = () => openParts({ title: "Critical Parts", rows: byStatus("Out of Stock", "Below Minimum"), valueLabel: "Short by", valueOf: shortBy });
  const openReorder = () => openParts({ title: "Reorder", rows: byStatus("Reorder"), valueLabel: "Stock", valueOf: (r) => r.qty_on_hand });
  // A Top 10 only where the list's question is money — Excess ₹ and Stock
  // Value (`top10`); a short / reorder / healthy list is the list alone (the
  // store's chart rule, 17 Oct 2026).
  const openExcess = () => openParts({ title: "Excess Parts", rows: byStatus("Above Maximum"), valueLabel: "Excess ₹", valueOf: excessOf, valueFmt: fmtMoney, top10: true });
  const sectionName = useMemo(() => Object.fromEntries((sections || []).map((s) => [s.id, s.name])), [sections]);

  // Stock value by section, straight off the overview — the same split the
  // desktop dashboard's value panel shows. A slice drills to that section's
  // parts, by value.
  const valueBySection = useMemo(
    () => (ov?.value?.by_section || [])
      .map((s, i) => ({
        sid: s.section_id, name: s.name || sectionName[s.section_id] || "Unassigned",
        value: Math.round(s.value || 0), color: PIE[i % PIE.length],
      })),
    [ov, sectionName],
  );
  const totalStockValue = ov?.value?.total ?? null;
  const openValueSection = (sid) => {
    if (sid == null) return;
    const secRows = rows.filter((r) => r.section_id === sid && r.stock_value != null);
    openParts({ title: `Stock Value — ${sectionName[sid] || "Section"}`, rows: secRows, valueLabel: "Value", valueOf: (r) => r.stock_value, valueFmt: fmtMoney, top10: true });
  };
  const openStockValue = () => openParts({ title: "Stock Value", rows: rows.filter((r) => r.stock_value != null), valueLabel: "Value", valueOf: (r) => r.stock_value, valueFmt: fmtMoney, chart: "bySection", sectionNames: sectionName });
  // A money list, so it carries the Top 10 (the store's chart rule).
  const openTrend = (view) => openStack({ kind: "valueTrend", title: `Stock Value Trend${secView ? ` — ${activeName}` : ""}`, trend, view });
  // Discontinued parts are a line of the excess panel (their own panel gave
  // way to the value trend on 24 Oct 2026).
  const discRow = rowsState === "ok" && disc.all.length > 0;
  const openDiscontinued = () => openParts({ title: "Discontinued Stock", rows: disc.held, valueLabel: "Value", valueOf: (r) => r.stock_value, valueFmt: fmtMoney, top10: true });
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
    openParts(cat === "Others"
      ? { title: "Others — by category", rows: catRows, valueLabel: "Stock", valueOf: (r) => r.qty_on_hand || 0, chart: "byType" }
      : { title: `${cat} parts`, rows: catRows, valueLabel: "Stock", valueOf: (r) => r.qty_on_hand || 0 });
  };

  // The management block: one call, four panels. Undefined while loading, null
  // when it failed (an older backend without the endpoint, or a refused call).
  const mgState = stateOf(P.mgmt);
  const aging = asObj(P.mgmt?.excess_aging);
  const movement = asObj(P.mgmt?.movement);
  const tracker = asObj(P.mgmt?.tracker);
  // What the stock was worth, day by day up to year by year: null when nothing
  // in the scope has a rate, undefined from a backend without it.
  const trend = P.mgmt ? P.mgmt.value_trend : undefined;
  const trendPts = trend?.series?.[trendView] || [];
  const trendDelta = trendPts.length > 1 ? trendPts[trendPts.length - 1].value - trendPts[trendPts.length - 2].value : null;
  const agingMax = useMemo(() => Math.max(0, ...(aging?.buckets || []).map((b) => b.value || 0)), [aging]);
  const agingIdlePct = aging?.total?.value ? Math.round(((aging.idle?.value || 0) / aging.total.value) * 100) : null;
  // Rupees received (ERP GRN) and issued (app) per month. A month the source
  // does not cover stays null — no bar — rather than a zero that reads as "nothing moved".
  const moveData = useMemo(
    // `i` = the month's place in movement.months, for the bars' drill.
    () => (movement?.months || []).map((m, i) => ({ name: m.label || monthLabel(m.period), in: m.in_value ?? null, out: m.out_value ?? null, i })),
    [movement],
  );
  const moveHasData = moveData.some((m) => m.in || m.out);
  // Worst first, as the server tags them (a clear line is "ok", so it sinks);
  // the wall shows the first six, landscape eight.
  const trackerRows = useMemo(
    () => (tracker?.items || []).map((it, i) => ({ it, i }))
      .sort((a, b) => (SEV_RANK[a.it.severity] ?? 2) - (SEV_RANK[b.it.severity] ?? 2) || a.i - b.i)
      .map((x) => x.it).slice(0, 8),
    [tracker],
  );

  // This month's issues as the Issuance & Consumption Report counts them
  // (overview.consumption.issue_month): issued / returned / consumed, per
  // consuming department, and where the parts were used. Absent on the
  // stock-list fallback, which keeps the plain department split below.
  const issueMonth = ov?.consumption?.issue_month || null;
  const deptData = useMemo(() => {
    if (issueMonth) {
      const tot = issueMonth.total?.qty || 0;
      return (issueMonth.departments || []).filter((d) => d.qty > 0)
        .map((d, i) => ({ name: d.name, value: d.qty, pct: tot ? (d.qty / tot) * 100 : 0, color: PIE[i % PIE.length] }));
    }
    const top = ov?.consumption?.this_month_by_department || [];
    // Denominator is the WHOLE month's issuance (the overview's this-month
    // total), not just the top-5 subtotal, so each department's % is its real
    // share of consumption.
    const topSum = top.reduce((s, d) => s + (d.value || 0), 0);
    const totAll = Math.max(ov?.consumption?.comparison?.current?.value || 0, topSum) || 1;
    return top.map((d, i) => ({ name: d.name, value: Math.round(d.value || 0), pct: ((d.value || 0) / totAll) * 100, color: PIE[i % PIE.length] }));
  }, [ov, issueMonth]);


  // ERP current stock (store-wide) + its match against the store's physical count.
  const erpState = stateOf(P.erpGap);
  const erpRows = P.erpGap || NO_ROWS;
  const erpSum = useMemo(() => erpSummary(erpRows), [erpRows]);
  const erpGapCount = erpSum.short + erpSum.excess;
  // The ERP figures are a dated snapshot; its date and age travel with them.
  const snap = erp?.stock_snapshot || null;
  const snapAt = snap?.synced_at ?? erpRows.find((r) => r.erp_synced_at)?.erp_synced_at ?? null;
  const snapDay = snapAt ? fmtDay(snapAt) : null;
  const snapT = snapAt ? parseServerTime(snapAt) : null;
  const snapDays = snap?.age_hours != null ? Math.floor(snap.age_hours / 24)
    : snapT ? Math.max(0, Math.floor((Date.now() - snapT.getTime()) / 86400000)) : null;
  const snapWord = snapDay ? `${snapDay} snapshot${snapDays ? ` (${snapDays} d old)` : ""}` : null;

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

  // A row of an issue / movement list carries little more than the part's no.
  // and name, so the header read In Stock, Min, Max, Value and Location as "—"
  // (the store, 22 Oct 2026): take the part's own figures off the board's stock
  // list when it is there.
  const openHistory = (row) => {
    const full = rows.find((r) => r.part_id === row.part_id);
    return openHistoryOf(full ? { ...row, ...full } : row);
  };
  const openHistoryOf = (part) => openAsync(
    { kind: "partHistory", title: part.part_no, part, history: [] },
    () => fetchData(spareStockService.history(part.part_id, 100))
      .then((h) => ({ history: asList(h) || [], error: !Array.isArray(h) })),
    { push: true },
  );
  // A transaction feed drill (for Today's Issue / Pending ERP) — off the ledger.
  // opts.fetch lets a caller supply an exact list (e.g. only the pending-ERP
  // movements, or only this shift's issues) so the drill ties out to its KPI;
  // without it, the generic recent-activity feed is shown. A failed fetch opens
  // the drill saying so, not as "No movements". opts.noteOf(list) rewrites the
  // note from the rows that came back, so a figure the header does not count
  // (a qty, a store-wide total) is stated off the list itself.
  const openTxns = (title, opts = {}) => openAsync(
    { kind: "txnList", title, rows: [], note: opts.note, empty: opts.empty },
    async () => {
      const fetcher = opts.fetch || (() => spareStockService.activity(STORE, 60).then((r) => r.data.data));
      const a = await fetcher().catch(() => null);
      let list = Array.isArray(a) ? a : [];
      if (opts.filter) list = list.filter(opts.filter);
      const ok = Array.isArray(a);
      return { rows: list, error: !ok, ...(ok && opts.noteOf ? { note: opts.noteOf(list) } : {}) };
    },
  );
  const openErpGap = () => openStack({
    kind: "erpGap", title: "Current Stock — ERP vs Physical", rows: erpRows, summary: erpSum, error: erpState === "error",
    note: snapWord
      ? `Physical is the store's own count in this app; ERP is the ${snapWord} — not a live feed.`
      : "No ERP stock snapshot has been received, so there is nothing to compare against.",
  });
  // The drill lists the ERP GRN lines behind the tile (the work queue's GRN /
  // quality list: awaiting quality in ERP, or to check); on an older overview,
  // the SRV register lines as before.
  const openSrv = () => (receiving
    ? openAsync(
      { kind: "srvList", title: "GRN / Quality pending (ERP)", rows: [], receipts: true, erp: receiving.erp || null },
      () => fetchData(spareFlowService.queues(STORE))
        .then((q) => {
          const list = asList(asObj(q)?.quality);
          const erp = asObj(asObj(q)?.erp);
          return { rows: list || [], error: !list, ...(erp ? { erp } : {}) };
        }),
    )
    : openAsync(
      { kind: "srvList", title: "GRN / Quality pending (ERP)", rows: [], untracked: srvUntracked },
      () => fetchData(spareStockService.pendingList(STORE, "all"))
        .then((list) => ({ rows: asList(list) || [], error: !Array.isArray(list) })),
    ));
  // This shift's issues and stock-ins, in the same section scope as their
  // tiles (and the ticker), so each list ties out to its figure.
  // Today's issues only. The month's department split it used to carry above
  // the list did not match it ("is chart se kuch samajh nhi aa rha" — 0 issues
  // today under a chart of the month, 22 Oct 2026); the month lives on the
  // board's Issue & Consumption panel.
  const openTodayIssues = () => openTxns("Today's Issue", {
    empty: "No issue yet today",
    fetch: () => spareStockService.todayIssues(STORE, secView ? sectionId : undefined).then((r) => r.data.data || []),
  });
  const openTodayReceipts = () => openTxns("Today Added to Stock", {
    fetch: () => spareStockService.todayReceipts(STORE, secView ? sectionId : undefined).then((r) => r.data.data || []),
  });
  const openMovements = () => openTxns("Recent Movements");

  // ---- every panel figure opens the list behind it ("ye chart clickable nhi
  // h" — the store, 17 Oct 2026). Each list is read by its figure's own rule,
  // so its count is the figure that was tapped.
  // A figure with no list behind it says so in the drill, rather than a tap
  // that does nothing (which reads as a broken board).
  const openNoList = (title, note) => openStack({ kind: "txnList", title, rows: [], note });
  // Stock health: the parts in that status, off the same rows the gauges count.
  const openHealthy = () => openParts({ title: "Healthy Parts", rows: byStatus("Healthy"), valueLabel: "Stock", valueOf: (r) => r.qty_on_hand });
  // Excess aging: the excess parts of a band, by the server's own band of each
  // part (excess_aging.part_buckets) — exactly the parts the band counts.
  const agingBands = asObj(aging?.part_buckets);
  const agingAges = asObj(aging?.part_ages);
  const agingSince = aging?.horizon ? fmtIsoDay(aging.horizon) : null;
  const ageTitle = (b) => `Excess Aging — ${b.key === "none" && agingSince ? `No inward since ${agingSince}` : b.label}`;
  const openAgeBands = (keys, title) => {
    if (!agingBands) {
      return openNoList(title, "The parts behind this band come with the updated server — the list opens after the app's server has restarted.");
    }
    const want = new Set(keys);
    // Each part says how long it has waited since its last ERP inward — "kitne
    // din se pending" (the store, 22 Oct 2026) — and the longest waits come first.
    const ageOf = (r) => agingAges?.[r.part_id] || {};
    const waited = (r) => (r.age_days == null ? Infinity : r.age_days);
    const list = rows.filter((r) => want.has(agingBands[r.part_id]))
      .map((r) => ({ ...r, age_days: ageOf(r).days ?? null, last_inward: ageOf(r).last_inward ?? null }))
      .sort((a, b) => (waited(b) - waited(a)) || (excessOf(b) - excessOf(a)));
    return openParts({ title, rows: list, valueLabel: "Excess ₹", valueOf: excessOf, valueFmt: fmtMoney, top10: true,
      ageCol: agingAges ? { horizonDays: aging?.horizon_days, since: agingSince } : null });
  };
  const openAgingAll = () => openAgeBands((aging?.buckets || []).map((b) => b.key), "Excess Aging — all excess parts");
  // The management block's lists (in / out of a month, a department's
  // issues), in this view's section scope unless `storeWide`. null =
  // the call failed, so the drill says so instead of "no movements".
  const mgmtRows = (kind, key, storeWide = false) => managementService
    .list(STORE, kind, key, secView && !storeWide ? sectionId : undefined, { silent: true })
    .then((r) => asList(r.data?.data?.rows));
  // Receipt vs Issue: one month's movements behind its bars — Receipt = the ERP
  // GRN lines, Out = the app's issues — so the lines and ₹ are the bar's. A
  // side the chart has no figure for that month (outside the ERP register, or
  // before the app's ledger started) has no bar, and is left out.
  const openMonth = (i, side = "both") => {
    const m = movement?.months?.[i];
    if (!m) return undefined;
    const month = `${m.label || monthLabel(m.period)} ${String(m.period || "").slice(0, 4)}`.trim();
    const title = side === "in" ? `Receipt · ${month} (ERP GRN)` : side === "out" ? `Issue · ${month}` : `Receipt vs Issue · ${month}`;
    const sides = (side === "both" ? ["in", "out"] : [side]).filter((s) => (s === "in" ? m.in_value : m.out_value) != null);
    if (!sides.length) {
      return openNoList(title, `${month} has no Receipt or Issue figure on the chart — the ERP GRN register does not hold the whole month and no issue was recorded in the app then — so there is no list behind it.`);
    }
    const says = sides.map((s) => (s === "in"
      ? `Receipt: ${fmtInt(m.in_lines)} ERP GRN line(s) · ${fmtMoney(m.in_value)} (receipt qty × current rate)`
      : `Issue: ${fmtInt(m.out_lines)} issue line(s) · ${fmtMoney(m.out_value)} (issued qty × current rate)`));
    return openTxns(title, {
      fetch: () => Promise.all(sides.map((s) => mgmtRows(s, m.period)))
        .then((lists) => (lists.every(Array.isArray)
          ? lists.flat().map((r) => (r.txn_type === "GRN" && r.grn_no ? { ...r, txn_type: `GRN ${r.grn_no}` } : r))
          : null)),
      note: `${says.join(" · ")}. Tap a row for that part's history.`,
    });
  };
  // A bar opens its own side (the month's band under it is not reached).
  const onMoveBar = (side) => (d, _i, e) => {
    e?.stopPropagation?.();
    const i = d?.payload?.i ?? d?.i;
    if (i != null) openMonth(i, side);
  };
  const openMonthNamed = (name) => {
    const i = moveData.findIndex((m) => m.name === name);
    if (i >= 0) openMonth(moveData[i].i, "both");
  };
  // Dept. issue this month: that department's issues, by the panel's rule. The
  // panel's figure is the issued QTY, while the drill header counts issue
  // lines, so the note states the qty the lines add up to.
  const deptRule = "the department that owns the part's section, as the panel counts it; cancelled issues are left out. Tap a row for that part's history.";
  const openDept = (d) => openTxns(`${d.name} · issued this month`, {
    fetch: () => mgmtRows("dept", d.name),
    note: `${fmtInt(d.value)} issued (qty) this month for ${d.name} — ${deptRule}`,
    noteOf: (list) => {
      const qty = Math.round(list.reduce((s, r) => s + (Number(r.qty ?? Math.abs(r.qty_delta || 0)) || 0), 0) * 100) / 100;
      return `${fmtInt(qty)} issued (qty) this month for ${d.name} in ${fmtInt(list.length)} issue line(s) — the qty is the panel's figure; ${deptRule}`;
    },
  });
  // ERP vs physical tiles: the comparison list, cut to what each tile counts
  // (its chips summarise the rows shown).
  // Accuracy is a figure of the whole comparison: a slice holding only some of
  // the parts in both (With Gap — none of which match) would chip a 0% the
  // board does not have, so such a slice shows no accuracy chip.
  const openErpSlice = (title, list, note) => {
    const summary = erpSummary(list);
    if (summary.reconciled !== erpSum.reconciled) summary.accuracy_pct = null;
    return openStack({
      kind: "erpGap", title, rows: list, summary, error: erpState === "error",
      note: `${note}${snapWord ? ` ERP is the ${snapWord} — not a live feed.` : ""}`,
    });
  };
  const erpInBoth = () => erpRows.filter((r) => r.gap_qty != null);
  const erpOpen = {
    "ERP Stock": () => openErpSlice("ERP vs Physical — ERP stock", erpInBoth(),
      `${fmtInt(erpSum.reconciled)} parts have both an ERP figure and a count: ERP ${fmtInt(Math.round(erpSum.erp_units))} units against ${fmtInt(Math.round(erpSum.physical_units))} counted.`),
    "Physical Stock": () => openErpSlice("ERP vs Physical — physical stock", erpInBoth(),
      `${fmtInt(erpSum.reconciled)} parts have both an ERP figure and a count: ${fmtInt(Math.round(erpSum.physical_units))} units counted against ERP ${fmtInt(Math.round(erpSum.erp_units))}.`),
    "Match Accuracy": () => openErpSlice("ERP vs Physical — match accuracy", erpInBoth(),
      `${fmtInt(erpSum.matched)} of ${fmtInt(erpSum.reconciled)} parts in both match${erpSum.accuracy_pct != null ? ` (${erpSum.accuracy_pct}%)` : ""}.`),
    "With Gap": () => openErpSlice("ERP vs Physical — with gap", erpRows.filter((r) => r.status === "SHORT" || r.status === "EXCESS"),
      `${fmtInt(erpGapCount)} parts differ from ERP: ${fmtInt(erpSum.short)} short, ${fmtInt(erpSum.excess)} excess.`),
  };
  // A tracker line opens the same drill as its tile / alert, where the board has one.
  const trackerOpen = {
    critical: openCritical, reorder: openReorder, excess: openExcess,
    srv_pending: openSrv, erp_gap: openErpGap,
  };

  // Live Alerts — derived from the board's own real spare figures (there is no
  // spare notification feed yet), so the ticker always shows what needs eyes.
  // A feed that failed to load is itself an alert: its figures read "—", and
  // tapping the alert retries.
  const fb = P.storeOv?.fallback ? P.storeOv : null;
  const failedFeeds = [
    P.storeOv === null && "store overview",
    ownOv && P.secOv === null && (secView ? "section figures" : "store figures"),
    fb && srvCount == null && "GRN / quality pending (ERP)",
    fb && !fb.erp.write && "ERP write-back status",
    fb && !recent && "recent movements",
    ov?.fallback && !ov.kpis.today && "this shift's issues",
    ov?.fallback && !ov.consumption && "this month's issues",
    P.list === null && "parts list",
    P.mgmt === null && "management panels",
    P.erpGap === null && "ERP comparison",
    P.pending === null && "confirmation queue",
    !receiving && P.flow === null && "SRV register",
  ].filter(Boolean);
  const plural = (n, word) => `${fmtInt(n)} ${word}${n > 1 ? "s" : ""}`;
  const liveAlerts = [];
  if (failedFeeds.length) liveAlerts.push({ color: "#94a3b8", onClick: reload,
    text: `Could not load: ${failedFeeds.join(", ")} — tap to retry` });
  // One critical alert, not one for zero stock and another for below minimum:
  // "critical" already means both, so the split only repeated the same parts.
  if (critical) liveAlerts.push({ color: STATUS.out, onClick: openCritical,
    text: `${plural(critical, "part")} CRITICAL · ${fmtInt(zero)} zero stock · ${fmtInt(belowMin)} below minimum` });
  if (reorderN) liveAlerts.push({ color: STATUS.reorder, text: `${plural(reorderN, "part")} at reorder level`, onClick: openReorder });
  if (excess) liveAlerts.push({ color: STATUS.above, text: `${plural(excess, "part")} above maximum · ${fmtMoney(excessValue ?? excessValueRows)} tied up`, onClick: openExcess });
  // Said the way the store reads it (the store, 24 Oct 2026: "is line ko thik
  // meaning me likho" — "differ from the ERP 10 Aug snapshot" read as a puzzle):
  // the store's count against ERP's, which way each part is off, and that the
  // ERP side is a dated figure, not live.
  if (erpGapCount) liveAlerts.push({ color: C.cyan, onClick: openErpGap,
    text: `ERP vs Physical mismatch: ${plural(erpGapCount, "part")} (${fmtInt(erpSum.short)} short, ${fmtInt(erpSum.excess)} excess)${snapDay ? ` · as on ${snapDay}` : ""}` });
  if (pendingErp) liveAlerts.push({ color: C.purple, text: `${plural(pendingErp, "movement")} queued for ERP (write-back ${erp?.write?.active ? "on" : "off"})`,
    onClick: () => openTxns("Pending ERP", {
      fetch: () => spareStockService.erpPendingList(STORE).then((r) => r.data.data?.rows || []),
      note: `${fmtInt(pendingErp)} stock movement(s) queued to push to ERP — each waits here while the ERP write is off. Tap a row for that part's history.`,
    }) });
  const issuedLines = today?.issued_lines ?? 0;
  if (issuedLines) liveAlerts.push({ color: C.blue, text: `${fmtInt(issuedQty)} issued this shift · ${plural(issuedLines, "line")}`,
    onClick: openTodayIssues });
  const overdueActions = tracker?.summary?.overdue || 0;
  if (overdueActions) liveAlerts.push({ color: STATUS.out, text: `${plural(overdueActions, "action")} past the target date — see the action tracker` });
  // The wall has no room for the movements table, so its newest line runs here.
  const lastMove = recent && recent[0];
  if (lastMove) liveAlerts.push({ color: C.green, onClick: openMovements,
    text: `Latest movement: ${whenOf(lastMove.at || lastMove.created_at)} · ${lastMove.txn_type} · ${lastMove.part_no} × ${fmtInt(Math.abs(lastMove.qty_delta ?? lastMove.qty ?? 0))}` });
  const cycle = (dir) => {
    setSectionId((cur) => {
      const i = Math.max(0, sectionOpts.findIndex((o) => o === cur));
      return sectionOpts[(i + dir + sectionOpts.length) % sectionOpts.length];
    });
  };

  const autoDay = hour >= 8 && hour < 20;
  const isDay = shiftOverride == null ? autoDay : shiftOverride;
  // Whole-board theme, flipped by the day/night button. Every surface/text below
  // reads these CSS variables, so one switch re-themes the entire dashboard.
  // Base theme mirrors the desktop dashboard EXACTLY (index.css body + .card), so
  // the wall and the main board read as the same product day and night: a soft
  // light ground with a faint Toyota-red (top-right) + navy (bottom-left) glow
  // and white-glass cards by day; a navy ground with a red + blue glow and navy-
  // glass cards by night. Radii are scaled up for the 64" board; colours/opacities
  // are the desktop's own. Status/pill hues come from the shared STATUS palette.
  const themeVars = isDay
    ? {
        "--dx-bg": "#eef2f8", "--dx-card": "#ffffff", "--dx-border": "rgba(226,232,240,0.7)", "--dx-t1": "#0f172a", "--dx-t2": "#334155", "--dx-t3": "#64748b", "--dx-t4": "#94a3b8", "--dx-track": "#eef3fb", "--dx-divide": "#eef2f7", "--dx-gauge": "#e5e7eb",
        "--dx-glass": "linear-gradient(162deg,rgba(255,255,255,0.95),rgba(246,249,253,0.86))",
        "--dx-t1-grad": "linear-gradient(160deg,#0f172a 0%,#334e73 100%)",
        "--pill-red": "#e11d48", "--pill-green": "#047857", "--pill-amber": "#b45309", "--pill-orange": "#c2410c", "--pill-blue": "#1d4ed8", "--pill-slate": "#475569",
        "--dx-glass-brd": "rgba(226,232,240,0.7)",
        "--dx-glass-shadow": "0 1px 2px rgba(15,31,56,0.04), 0 10px 24px rgba(15,31,56,0.06), inset 0 1px 0 rgba(255,255,255,0.6)",
        "--dx-board": "radial-gradient(1200px 560px at 100% -8%, rgba(235,10,30,0.05), transparent 62%), radial-gradient(1120px 680px at -6% 112%, rgba(15,31,56,0.05), transparent 60%), linear-gradient(160deg,#f6f8fc 0%,#eef2f8 55%,#f3f1f6 100%)",
      }
    : {
        "--dx-bg": "#0a1220", "--dx-card": "#101d34", "--dx-border": "rgba(22,49,79,0.8)", "--dx-t1": "#e4ecfb", "--dx-t2": "#a9bad7", "--dx-t3": "#6f82a0", "--dx-t4": "#586a8c", "--dx-track": "rgba(30,48,84,0.6)", "--dx-divide": "rgba(94,165,235,0.12)", "--dx-gauge": "#243350",
        "--dx-glass": "linear-gradient(162deg,rgba(23,40,68,0.9),rgba(14,24,44,0.86))",
        "--dx-t1-grad": "linear-gradient(160deg,#e6eefb 0%,#9fb6d8 100%)",
        "--pill-red": "#fb7185", "--pill-green": "#34d399", "--pill-amber": "#fbbf24", "--pill-orange": "#fb923c", "--pill-blue": "#60a5fa", "--pill-slate": "#94a3b8",
        "--dx-glass-brd": "rgba(22,49,79,0.9)",
        "--dx-glass-shadow": "0 1px 2px rgba(0,0,0,0.25), 0 14px 30px rgba(0,0,0,0.38), inset 0 1px 0 rgba(255,255,255,0.05)",
        "--dx-board": "radial-gradient(1320px 620px at 100% -8%, rgba(235,10,30,0.10), transparent 62%), radial-gradient(1180px 740px at -6% 112%, rgba(37,99,235,0.12), transparent 60%), linear-gradient(160deg,#0a1220 0%,#0c1830 55%,#0a1424 100%)",
      };
  // recharts axis/grid become SVG attributes and can't read CSS vars, so keep JS
  // twins of the theme for chart ticks and gridlines (readable in both modes).
  const axisColor = isDay ? "#64748b" : "#94a3b8";
  const gridColor = isDay ? "#e2e8f0" : "rgba(148,163,184,0.18)";
  // Chart ticks are SVG attributes in px, so they are scaled off the screen
  // height here — a fixed 13px was unreadable on the 1920px-tall wall.
  const tickPx = Math.max(11, Math.round((typeof window !== "undefined" ? window.innerHeight : 800) * 0.0125));

  return (
    <div className="min-h-screen w-full flex flex-col gap-[0.5vh] p-[0.7vh] text-[var(--dx-t2)] transition-colors duration-300 [--dx-donut:8.4vh] landscape:[--dx-donut:12vh] [--dx-gauge-w:min(6vh,11vw)] landscape:[--dx-gauge-w:min(8.6vh,4.9vw)]" style={{ ...themeVars, background: "var(--dx-board)" }}>

      {/* ---------- header ---------- */}
      <div className={`shrink-0 rounded-2xl px-[1.4vh] py-[0.4vh] landscape:py-[0.7vh] overflow-hidden relative ${isDay ? "text-slate-900" : "text-white"}`}
        style={isDay ? {
          background: "linear-gradient(120deg,#ffffff 0%,#f5f8fd 50%,#ffffff 100%)",
          boxShadow: "0 10px 30px rgba(15,31,56,0.08), inset 0 1px 0 #ffffff",
          borderBottom: "2px solid rgba(235,10,30,0.85)",
        } : {
          background: "radial-gradient(760px 320px at 82% -50%, rgba(235,10,30,0.30), transparent 62%), radial-gradient(560px 260px at 10% 150%, rgba(29,67,104,0.45), transparent 60%), linear-gradient(120deg,#0f1f38 0%,#1d4368 48%,#0f1f38 100%)",
          boxShadow: "0 14px 40px rgba(10,32,70,0.40), inset 0 1px 0 rgba(255,255,255,0.08)",
        }}>
      {/* Two rows, because a 9:16 portrait wall leaves only ~50vh of width: in one
          row the logo, title, section switch, clock and exit could not all fit, so
          the title collapsed to "T…" and the section pill wrapped over its
          neighbours. Row 1 = brand · title · exit; row 2 = section switch · clock
          · fullscreen. In LANDSCAPE (a laptop / wide monitor) width is plentiful
          and height is not, so both rows dissolve (`contents`) into one slim
          row, ordered: brand · section switch · title · clock · fullscreen · exit. */}
      <div className="flex flex-col gap-[0.35vh] landscape:flex-row landscape:items-center landscape:gap-[1.2vh]">
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-[1vh] landscape:contents">
        {/* Just the brand mark — not a navigation control. Leaving the board is a
            deliberate tap on the "Main Dashboard" button on the right. */}
        <div className="flex items-center gap-[1vh] min-w-0 landscape:order-1 landscape:shrink-0">
          <span className="shrink-0 rounded-lg">
            <img src="/toyota-boshoku-logo.png" alt="Toyota Boshoku" className="h-[3.6vh] landscape:h-[4.2vh] w-auto bg-white/95 rounded-lg p-[0.4vh] block" draggable={false} />
          </span>
          <div className="hidden xl:block leading-tight shrink-0">
            <div className="text-[1.6vh] font-bold">Toyota Boshoku</div>
            <div className={`text-[1.2vh] ${isDay ? "text-slate-500" : "text-white/60"}`}>Device India Pvt. Ltd.</div>
          </div>
        </div>

        <div className="text-center min-w-0 landscape:order-3 landscape:flex-1">
          <div className="text-[1.7vh] font-extrabold leading-none tracking-normal truncate"
            style={{ backgroundImage: isDay ? "linear-gradient(92deg,#ff7a18 0%,#eb0a1e 48%,#c81d77 100%)" : "linear-gradient(180deg,#ffffff 0%,#bcd6ff 100%)", WebkitBackgroundClip: "text", backgroundClip: "text", WebkitTextFillColor: "transparent", color: "transparent", filter: isDay ? "drop-shadow(0 2px 8px rgba(235,10,30,0.22))" : "drop-shadow(0 2px 12px rgba(120,180,255,0.55))" }}>
            TBDI Digital SMP
          </div>
          <div className="mt-[0.3vh] flex items-center justify-center gap-[1vh]">
            <span className="h-px w-[3.2vh]" style={{ background: isDay ? "linear-gradient(90deg,transparent,#cbd5e1)" : "linear-gradient(90deg,transparent,rgba(255,255,255,0.55))" }} />
            <span className={`flex items-center gap-[0.7vh] text-[1.25vh] font-bold tracking-[0.42em] ${isDay ? "text-slate-500" : "text-white/85"}`}>
              {/* Green only while every feed loaded; a failed call turns it amber
                  (the ticker says which) rather than pulse "live" over stale data. */}
              <span className={`w-[0.9vh] h-[0.9vh] rounded-full ${failedFeeds.length ? "bg-amber-400" : "bg-emerald-400 animate-pulse"}`}
                style={{ boxShadow: failedFeeds.length ? "0 0 8px #fbbf24" : "0 0 8px #34d399" }}
                title={failedFeeds.length ? "Some figures failed to load — see the alert bar" : "Refreshes on every stock movement"} />
              LIVE BOARD
            </span>
            <span className="h-px w-[3.2vh]" style={{ background: isDay ? "linear-gradient(90deg,#cbd5e1,transparent)" : "linear-gradient(90deg,rgba(255,255,255,0.55),transparent)" }} />
          </div>
        </div>

        {/* Deliberate exit — top-right, QMP-style pill (the logo no longer navigates). */}
        <div className="flex justify-end min-w-0 landscape:order-6 landscape:shrink-0">
          {canOpenStore && <button type="button" onClick={() => navigate("/store/MAINTENANCE")}
            title="Go to the main dashboard" aria-label="Go to the main dashboard"
            className={`shrink-0 inline-flex items-center gap-[0.5vh] rounded-full pl-[0.9vh] pr-[1.3vh] py-[0.6vh] text-[1.3vh] font-semibold whitespace-nowrap transition-colors focus:outline-none focus-visible:ring-2 ${isDay ? "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 focus-visible:ring-slate-400" : "border border-white/25 bg-white/10 text-white/85 hover:bg-white/20 hover:text-white focus-visible:ring-white/60"}`}>
            <ArrowLeft size={15} aria-hidden="true" /> Main Dashboard
          </button>}
        </div>
      </div>

      <div className="flex items-center gap-[1vh] landscape:contents">
        {/* The section switch takes whatever the clock leaves and truncates a long
            name rather than wrapping (it used to break onto two lines). */}
        <div className="flex-1 min-w-0 flex landscape:order-2 landscape:flex-none">
          {sections.length > 0 && (
            <div ref={menuAnchor} className="inline-flex items-center gap-[1vh] rounded-full px-[1.4vh] py-[0.4vh] min-w-0 max-w-full"
              style={isDay
                ? { background: "#ffffff", border: "1px solid #cbd5e1", boxShadow: "0 1px 2px rgba(15,31,56,0.06)" }
                : { background: "linear-gradient(120deg,rgba(255,255,255,0.14),rgba(255,255,255,0.05))", border: "1px solid rgba(255,255,255,0.28)", boxShadow: "0 0 18px rgba(0,0,0,0.18), inset 0 1px 0 rgba(255,255,255,0.18)" }}>
              <button onClick={() => cycle(-1)} title="Previous section" className={`shrink-0 ${isDay ? "text-slate-400 hover:text-slate-800" : "text-white/60 hover:text-white"} text-[2vh] leading-none`}>‹</button>
              {/* Tap the name for the full section list; ‹ › still step through. */}
              <button onClick={toggleSectionMenu} title="Pick a section"
                className="flex items-center gap-[0.6vh] animate-rise min-w-0">
                <span key={String(sectionId)} className={`truncate text-[1.5vh] font-extrabold tracking-[0.08em] uppercase ${isDay ? "text-slate-900" : "text-white"}`}>{activeName}</span>
                <span className={`shrink-0 ${isDay ? "text-slate-400" : "text-white/70"} text-[1.2vh] leading-none transition-transform ${menuOpen ? "rotate-180" : ""}`}>▾</span>
              </button>
              <button onClick={() => cycle(1)} title="Next section" className={`shrink-0 ${isDay ? "text-slate-400 hover:text-slate-800" : "text-white/60 hover:text-white"} text-[2vh] leading-none`}>›</button>
            </div>
          )}
        </div>

          {/* Section list — a fixed layer so the header's overflow can't clip it. */}
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-[60]" onClick={() => setMenuOpen(false)} />
              <div className="fixed z-[61] -translate-x-1/2 min-w-[26vh] max-h-[70vh] overflow-auto py-[0.6vh] rounded-[1.4vh]"
                style={{ top: menuPos.top, left: menuPos.left, background: "linear-gradient(135deg,rgba(15,31,56,0.98),rgba(10,20,40,0.98))", border: "1px solid rgba(94,165,235,0.25)", boxShadow: "0 14px 44px rgba(0,0,0,0.55), 0 0 22px rgba(15,31,56,0.5)", backdropFilter: "blur(14px)" }}>
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

        {/* date · clock · last refresh · shift toggle */}
        <HeaderClock isDay={isDay} updated={lastUpdated} onToggle={() => setShiftOverride(!isDay)} />

        <button onClick={toggleFs} title={isFs ? "Exit fullscreen" : "Fullscreen"} className={`shrink-0 landscape:order-5 ${isDay ? "text-slate-400 hover:text-slate-700" : "text-white/60 hover:text-white"}`}>{isFs ? <Minimize size={16} /> : <Maximize size={16} />}</button>
      </div>
      </div>
      </div>

      {/* ---------- live alert ticker (below the heading) ---------- */}
      {liveAlerts.length > 0 && (
        <div className="shrink-0 flex items-center gap-[1.2vh] overflow-hidden rounded-xl px-[1.2vh] py-[0.35vh] landscape:py-[0.5vh] text-white"
          style={{ background: "linear-gradient(90deg,#0a2a4f,#0d3a6b)" }}>
          <span className="shrink-0 flex items-center gap-[0.6vh] rounded-md px-[1.1vh] py-[0.3vh] text-[1.3vh] font-extrabold tracking-wide" style={{ background: "linear-gradient(120deg,#ef4444,#dc2626)", boxShadow: "0 0 16px rgba(239,68,68,0.55)" }}>
            <span className="h-[1vh] w-[1vh] rounded-full bg-white animate-pulse" /> LIVE ALERTS
          </span>
          {/* Hovering the track pauses the marquee (see .ticker-track-x:hover in
              index.css) so a moving alert can be clicked; clickable alerts drill
              into their rows, the rest stay plain text. */}
          <div className="relative flex-1 overflow-hidden">
            <div className="ticker-track-x flex w-max items-center gap-[3.5vh] whitespace-nowrap"
              style={{ "--ticker-duration": `${Math.max(20, liveAlerts.length * 9)}s` }}>
              {[...liveAlerts, ...liveAlerts].map((a, i) => (
                a.onClick ? (
                  <button key={i} type="button" onClick={a.onClick}
                    className="flex items-center gap-[0.8vh] text-[1.45vh] font-semibold text-white cursor-pointer hover:underline focus:outline-none">
                    <span className="h-[1.1vh] w-[1.1vh] shrink-0 rounded-full" style={{ background: a.color, boxShadow: `0 0 0.7vh ${a.color}` }} />
                    {a.text}
                    <span className="text-[1.15vh] opacity-70">›</span>
                  </button>
                ) : (
                  <span key={i} className="flex items-center gap-[0.8vh] text-[1.45vh] font-semibold">
                    <span className="h-[1.1vh] w-[1.1vh] shrink-0 rounded-full" style={{ background: a.color, boxShadow: `0 0 0.7vh ${a.color}` }} />
                    {a.text}
                  </span>
                )
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ---------- KPI cards ---------- */}
      {/* Six tiles: three across in two rows on the portrait wall, one row of
          six in landscape (see Kpi). Zero stock and below minimum are NOT
          separate tiles: "Critical" is exactly those two added together, so
          showing all three repeated the same parts; the critical tile carries
          the split in its sub-line. The last two are the desktop dashboard's
          "Today Added to Stock" / "Today Issued", off the same figures. */}
      <div className="grid grid-cols-3 gap-[0.5vh] landscape:grid-cols-6 landscape:gap-[0.8vh]">
        {/* The headline figures, all off the overview — the same numbers the
            desktop dashboard shows. Each tile opens its list in the board's
            drill. Total parts sits in the part-type donut; Pending ERP in the
            header's write-back chip; this shift's issues beside the
            department split (and in the ticker when there are any). */}
        <Kpi icon={AlertTriangle} title="Critical Parts" short="Critical" state={ovState} value={statusVal(critical)} color={hot(critical, C.red)}
          sub={noneCounted ? "No part counted yet" : `${fmtInt(zero)} zero stock · ${fmtInt(belowMin)} below minimum`}
          subShort={noneCounted ? "No part counted yet" : `${fmtInt(zero)} zero · ${fmtInt(belowMin)} below min`} onClick={openCritical} />
        <Kpi icon={Boxes} title="Excess Parts" short="Excess" state={ovState} value={statusVal(excess)} color={hot(excess, STATUS.above)}
          extra={excess && excessValue ? fmtMoney(excessValue) : null}
          sub={noneCounted ? "No part counted yet" : "Above max · ₹ tied up (qty × rate)"}
          subShort={noneCounted ? "No part counted yet" : "Above max · ₹ tied up"} onClick={openExcess} />
        {/* Receiving is store-level: a section view still shows the store's
            figure, and says so rather than pass it off as the section's. The
            source is named — ERP's GRN lines, read with the mirror's freshness. */}
        <Kpi icon={ClipboardList} title="GRN / Quality Pending (ERP)" short="GRN / Quality" state={srvState}
          value={srvUntracked ? "—" : fmtInt(srvCount)} color={srvUntracked ? C.muted : hot(srvCount, C.purple)}
          sub={receiving
            ? [
              secView ? "Whole store" : "Awaiting quality in ERP",
              receiving.check ? `${fmtInt(receiving.check)} to check` : null,
              receivingFresh
                ? (receivingFresh.empty ? "no ERP data yet"
                  : receivingFresh.stale ? `ERP data ${receivingFresh.ageDays} d old`
                    : `ERP as of ${fmtStamp(receiving.erp.synced_at)}`)
                : null,
            ].filter(Boolean).join(" · ")
            : srvUntracked ? "No SRV recorded in the app yet" : secView ? "Whole store · app SRV register" : "Awaiting SRV · app SRV register"}
          subShort={srvUntracked ? "No SRV recorded yet" : secView ? "Whole store · ERP" : "Awaiting ERP quality"}
          onClick={openSrv} />
        <Kpi icon={Database} title="Stock Value" short="Stock Value" state={ovState} color={C.green} onClick={openStockValue}
          value={kpis?.valued_parts === 0 ? "—" : fmtMoney(kpis?.stock_value)}
          sub={kpis?.valued_parts === 0 ? "No counted part has a rate yet" : "Physical qty × std rate"} />
        {/* This shift's stock-ins and issues — a real "0" reads as a reading,
            "—" when the figure failed — each opening its own list. */}
        <Kpi icon={ArrowDownToLine} title="Added Today" short="Added Today" state={ovState} color={hot(receivedQty, C.green)} onClick={openTodayReceipts}
          value={fmtInt(receivedQty)}
          sub={`${receivedLines ? plural(receivedLines, "stock-in line") : "No stock-in yet"} · ${sinceWord}`}
          subShort={`${fmtInt(receivedLines)} line${receivedLines === 1 ? "" : "s"} · ${sinceWord}`} />
        <Kpi icon={ArrowUpFromLine} title="Issued Today" short="Issued Today" state={ovState} color={hot(issuedQty, C.rose)} onClick={openTodayIssues}
          value={fmtInt(issuedQty)}
          sub={`${issuedLines ? plural(issuedLines, "issue line") : "No issue yet"} · ${sinceWord}`}
          subShort={`${fmtInt(issuedLines)} line${issuedLines === 1 ? "" : "s"} · ${sinceWord}`} />
      </div>

      {/* ---------- the panels ----------
          ONE grid in both orientations; each card carries its own place.
          PORTRAIT (the 9:16 wall, ~55vh wide): two columns.
            stock health (full width)
            value by section | excess aging
            receipt vs issue | issue & consumption
            management action tracker (full width)
            stock value trend | ERP vs physical
          LANDSCAPE (laptop / wide monitor): four columns in three titled rows:
            Stock overview      health · value by section · part mix · excess aging
            Movement & control  receipt vs issue · issue & consumption · stock value trend · ERP vs physical
            Management action   action tracker (3 columns wide) · recent movements
          The last landscape row takes whatever height is left, so the board
          fills exactly one screen instead of scrolling.
          Not on the wall, to keep it to one screen: the part-mix donut and the
          recent-movements table (its newest line runs in the ticker, and the
          in-vs-out card opens the full list). */}
      <div className="grid grid-cols-2 gap-[0.6vh] landscape:grid-cols-4 landscape:flex-1 landscape:grid-rows-[auto_auto_auto_auto_auto_1fr]">
      <SectionBar className="landscape:order-1" title="Stock Overview" hint="Stock health · value by section · part mix · excess & discontinued" tone="var(--pill-blue)" />
      <SectionBar className="landscape:order-6" title="Movement & Control" hint="Receipt vs issue · issue & consumption · stock value trend · ERP vs physical" tone="var(--pill-green)" />
      <SectionBar className="landscape:order-11" title="Management Action" hint="What is wrong · how much money · who must act · latest movements" tone="var(--pill-red)" />

      {/* ---------- stock health ---------- */}
        <Card className="min-w-0 p-[0.7vh] order-1 col-span-2 landscape:col-span-1 landscape:order-2">
          <PanelHead icon={HeartMini} color={C.green} title="Stock Health"
            note={ovState === "ok" && healthBase ? `Share of ${fmtInt(healthBase)} counted parts${discontinuedN ? ` · ${fmtInt(discontinuedN)} discontinued apart` : ""}` : undefined} />
          {/* Shares of the COUNTED parts, all four bands, so they add to 100% —
              a part nobody has counted has no status to judge, and says so. */}
          {ovState !== "ok" ? <PanelState state={ovState} onRetry={reload} h="7vh" />
            : !healthBase ? <PanelState empty="No part counted yet — stock health needs a physical count" h="7vh" />
              : (
                <>
                  <div className="flex items-center justify-around pt-[0.3vh]">
                    {/* --dx-gauge-w: capped by width in both orientations, so four
                        gauges fit the full-width wall card and the one-quarter-
                        width landscape card alike. */}
                    {/* Each gauge opens the parts in its status (the same rows it counts). */}
                    <Tap className="min-w-0 rounded-xl px-[0.3vh]" onOpen={openHealthy} label={`Healthy: ${fmtInt(healthy)} parts. Open the list`}>
                      <Gauge w="var(--dx-gauge-w)" pct={(healthy / healthBase) * 100} color={STATUS.healthy} label="Healthy" sub={`${fmtInt(healthy)} Parts`} />
                    </Tap>
                    <Tap className="min-w-0 rounded-xl px-[0.3vh]" onOpen={openReorder} label={`Reorder: ${fmtInt(reorderN)} parts. Open the list`}>
                      <Gauge w="var(--dx-gauge-w)" pct={(reorderN / healthBase) * 100} color={STATUS.reorder} label="Reorder" sub={`${fmtInt(reorderN)} Parts`} />
                    </Tap>
                    <Tap className="min-w-0 rounded-xl px-[0.3vh]" onOpen={openCritical} label={`Critical: ${fmtInt(critical)} parts. Open the list`}>
                      <Gauge w="var(--dx-gauge-w)" pct={(critical / healthBase) * 100} color={C.red} label="Critical" sub={`${fmtInt(critical)} Parts`} />
                    </Tap>
                    <Tap className="min-w-0 rounded-xl px-[0.3vh]" onOpen={openExcess} label={`Excess: ${fmtInt(excess)} parts. Open the list`}>
                      <Gauge w="var(--dx-gauge-w)" pct={(excess / healthBase) * 100} color={STATUS.above} label="Excess" sub={`${fmtInt(excess)} Parts`} />
                    </Tap>
                  </div>
                </>
              )}
        </Card>

      {/* ---------- stock value by section ---------- */}
      <Card className="min-w-0 p-[0.7vh] order-2 landscape:order-3">
        <PanelHead tight icon={Database} color={C.green} title="Stock Value by Section"
          action="View Details" onAction={openStockValue} />
        {ovState !== "ok" ? <PanelState state={ovState} onRetry={reload} h="var(--dx-donut)" /> : valueBySection.length ? (
          <div className="flex items-center gap-[1vh]">
            <div className="w-[var(--dx-donut)] h-[var(--dx-donut)] relative shrink-0" style={{ filter: "drop-shadow(0 8px 14px rgba(20,120,80,0.22))" }}>
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
                  <Pie data={valueBySection} dataKey="value" nameKey="name" innerRadius="55%" outerRadius="92%"
                    paddingAngle={1} stroke="none" isAnimationActive={false}
                    onClick={(s) => openValueSection(s && (s.sid ?? (s.payload && s.payload.sid)))}>
                    {valueBySection.map((c, i) => <Cell key={i} fill={`url(#vsg-${i})`} cursor="pointer" />)}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
              <DonutHub value={fmtMoney(totalStockValue)} label="Total value" size="calc(var(--dx-donut) * 0.096)" />
            </div>
            <DonutLegend note="Tap a section for its parts"
              items={valueBySection.map((c) => ({ key: c.sid ?? "none", name: c.name, color: c.color, value: fmtMoney(c.value), onClick: () => openValueSection(c.sid) }))} />
          </div>
        ) : (
          <div className="h-[var(--dx-donut)] flex items-center justify-center text-center text-[1.4vh] text-[var(--dx-t4)]">No valued stock yet — needs a count and a rate</div>
        )}
      </Card>

      {/* ---------- stock by part type (landscape only — see the note above) ---------- */}
        <Card className="min-w-0 p-[0.7vh] hidden landscape:block landscape:order-4">
          <PanelHead icon={PieChartMini} color={C.blue} title="Stock by Category" />
          {rowsState !== "ok" ? <PanelState state={rowsState} onRetry={reload} h="var(--dx-donut)" /> : (
          <div className="flex items-center gap-[1vh]">
            <div className="w-[var(--dx-donut)] h-[var(--dx-donut)] relative shrink-0" style={{ filter: "drop-shadow(0 8px 14px rgba(30,60,120,0.22))" }}>
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
                    innerRadius="55%" outerRadius="92%" paddingAngle={1} stroke="none" isAnimationActive={false}
                    onClick={(s) => cats.length && openCat(s && (s.name ?? (s.payload && s.payload.name)))}>
                    {(cats.length ? cats : [{ color: "#e2e8f0" }]).map((c, i) => <Cell key={i} fill={`url(#pieg-${i})`} cursor={cats.length ? "pointer" : "default"} />)}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
              <DonutHub value={fmtInt(rows.length)} label="Total Parts" size="calc(var(--dx-donut) * 0.12)" />
            </div>
            <DonutLegend empty="No parts in this section"
              items={cats.map((c) => ({ key: c.name, name: c.name, color: c.color, value: fmtInt(c.value), onClick: () => openCat(c.name) }))} />
          </div>
          )}
        </Card>

      {/* ---------- excess aging · tied-up value ---------- */}
      {/* How long the money above max has sat idle, by the part's last ERP inward
          (GRN / gate entry). The ERP mirror only reaches back to its horizon, so
          the last band is "no inward since then" — a floor, not an exact age. */}
      <Card className="min-w-0 p-[0.7vh] order-3 landscape:order-5">
        <PanelHead tight icon={Hourglass} color={STATUS.above} title="Tied-up ₹ · Excess & Discontinued"
          action="View Details" onAction={agingBands ? openAgingAll : openExcess} />
        {mgState !== "ok" || !aging ? <PanelState state={mgState === "ok" ? "error" : mgState} onRetry={reload} h="8.6vh" />
          : !aging.total?.parts ? (
            <PanelState h="8.6vh" empty={noneCounted || rowsNoneCounted ? "No part counted yet — excess needs a physical count" : "No excess stock — nothing above its maximum"} />
          ) : (
            <>
              {/* The idle money and each band open their excess parts. */}
              <Tap className="flex items-center gap-[0.8vh] min-w-0 rounded-lg px-[0.3vh] -mx-[0.3vh]"
                onOpen={() => openAgeBands(["91+", "none"], "Excess Aging — idle 91+ days or no inward")}
                label={`Idle 91+ days or no inward: ${fmtInt(aging.idle?.parts)} parts, ${fmtMoney(aging.idle?.value)}. Open the list`}>
                <span className="shrink-0 text-[2.1vh] landscape:text-[2.6vh] font-extrabold leading-none tabular-nums" style={{ color: "var(--pill-red)" }}>{fmtMoney(aging.idle?.value)}</span>
                <span className="min-w-0 text-[1.05vh] landscape:text-[1.2vh] leading-tight text-[var(--dx-t3)] line-clamp-2">
                  idle 91+ days or no inward{agingIdlePct != null ? ` · ${agingIdlePct}% of ${fmtMoney(aging.total.value)} above max` : ""}
                </span>
              </Tap>
              <div className="mt-[0.4vh] landscape:mt-[0.7vh] space-y-[0.3vh] landscape:space-y-[0.5vh]"
                title={`Age = days since the last ERP inward (GRN / gate)${aging.horizon ? ` · ERP history from ${fmtIsoDay(aging.horizon)}` : ""}`}>
                {(aging.buckets || []).map((b) => (
                  <Tap key={b.key} className="rounded-md px-[0.3vh] -mx-[0.3vh]" onOpen={() => openAgeBands([b.key], ageTitle(b))}
                    label={`${ageTitle(b)}: ${fmtInt(b.parts)} parts, ${fmtMoney(b.value)}. Open the list`}>
                    <AgeRow b={b} max={agingMax} since={aging.horizon ? fmtIsoDay(aging.horizon) : null} />
                  </Tap>
                ))}
              </div>
              {/* The age note gives its line to the discontinued row when there is
                  one (the board must stay one screen); it is still the bands' hover text. */}
              {!discRow && (
                <div className="hidden landscape:block mt-[0.6vh] text-[1.1vh] leading-tight text-[var(--dx-t4)] truncate">
                  Age = days since the last ERP inward (GRN / gate){aging.horizon ? ` · ERP history from ${fmtIsoDay(aging.horizon)}` : ""}
                </div>
              )}
            </>
          )}
        {/* Discontinued stock: money that will not be used either. It had its
            own panel until 24 Oct 2026, when that place went to the value
            trend ("discontinue wala excess aging me hi aa sakta h"). Opens its parts. */}
        {discRow && (
          <Tap className="block mt-[0.4vh] pt-[0.4vh] landscape:mt-[0.5vh] landscape:pt-[0.5vh] border-t border-[var(--dx-divide)] rounded-md px-[0.3vh] -mx-[0.3vh]"
            onOpen={openDiscontinued}
            label={`Discontinued: ${fmtInt(disc.held.length)} parts with stock, ${fmtMoney(disc.value)}. Open the list`}>
            <div className="flex items-center gap-[0.8vh] text-[1.15vh] landscape:text-[1.3vh] leading-none">
              <span className="shrink-0 font-semibold text-[var(--dx-t2)]">Discontinued</span>
              <span className="flex-1 min-w-0 truncate text-[var(--dx-t4)]">
                {fmtInt(disc.held.length)} with stock<span className="hidden landscape:inline"> · scrap / return / move</span>
              </span>
              <span className="shrink-0 font-bold tabular-nums" style={{ color: C.amber }}>{fmtMoney(disc.value)}</span>
            </div>
          </Tap>
        )}
      </Card>

      {/* ---------- material movement: receipt vs issue ---------- */}
      {/* Rupees per month. In = what ERP's GRN register received; Out = what the
          app's issue ledger issued — both at the part's current rate. A month a
          source does not cover has no bar (it is unknown, not zero). */}
      <Card className="min-w-0 p-[0.7vh] order-4 landscape:order-7">
        <PanelHead tight icon={ArrowLeftRight} color={C.green} title="Receipt vs Issue · ₹"
          action="Movements" onAction={openMovements} />
        {mgState !== "ok" || !movement ? <PanelState state={mgState === "ok" ? "error" : mgState} onRetry={reload} h="8.8vh" />
          : !moveHasData ? <PanelState h="8.8vh" empty="No receipt or issue on record yet" />
            : (
              <>
                <div className="flex items-center gap-[1.2vh] text-[1.05vh] landscape:text-[1.2vh] leading-tight text-[var(--dx-t2)] px-[0.4vh] pb-[0.2vh] whitespace-nowrap overflow-hidden">
                  <span className="flex items-center gap-[0.4vh]"><span className="w-[1.1vh] h-[1.1vh] rounded-sm shrink-0" style={{ background: STATUS.healthy }} />Receipt<span className="hidden landscape:inline"> · ERP GRN</span></span>
                  <span className="flex items-center gap-[0.4vh]"><span className="w-[1.1vh] h-[1.1vh] rounded-sm shrink-0" style={{ background: STATUS.out }} />Issue<span className="hidden landscape:inline"> · app</span></span>
                  <span className="ml-auto text-[var(--dx-t4)]">₹ lakh / month</span>
                </div>
                <div className="h-[5.9vh] landscape:h-[10.5vh]">
                  <ResponsiveContainer width="100%" height="100%">
                    {/* A bar opens that month's In (ERP GRN lines) or Out (issues);
                        the month itself — its band or its label — opens both. */}
                    <BarChart data={moveData} margin={{ top: 6, right: 6, left: 0, bottom: 0 }} barGap={2}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={gridColor} />
                      {/* An invisible band per month, under the bars: a tap anywhere
                          in the month's column opens it, with or without a hover first
                          (the chart's own click knows the month only after a hover). */}
                      {moveData.map((m) => (
                        <ReferenceArea key={m.i} x1={m.name} x2={m.name} fill={axisColor} fillOpacity={0} stroke="none"
                          cursor="pointer" onClick={() => openMonth(m.i, "both")} />
                      ))}
                      <XAxis dataKey="name" interval={0} axisLine={{ stroke: gridColor }} tickLine={false} height={Math.round(tickPx * 1.7)}
                        tick={(p) => <MonthTick {...p} fill={axisColor} fontSize={tickPx} onOpen={openMonthNamed} />} />
                      <YAxis tick={{ fontSize: tickPx, fill: axisColor }} axisLine={false} tickLine={false} width={Math.round(tickPx * 2.2)}
                        tickFormatter={(v) => Math.round(v / 1e5)} />
                      <Tooltip content={<BoardTip fmt={fmtMoney} />} cursor={{ fill: "var(--dx-track)" }} />
                      <Bar dataKey="in" name="Receipt (ERP GRN)" fill={STATUS.healthy} radius={[4, 4, 0, 0]} maxBarSize={tickPx * 2} isAnimationActive={false}
                        cursor="pointer" onClick={onMoveBar("in")} activeBar={{ fillOpacity: 0.8, stroke: axisColor, strokeWidth: 1 }} minPointSize={tapSliver} />
                      <Bar dataKey="out" name="Issue" fill={STATUS.out} radius={[4, 4, 0, 0]} maxBarSize={tickPx * 2} isAnimationActive={false}
                        cursor="pointer" onClick={onMoveBar("out")} activeBar={{ fillOpacity: 0.8, stroke: axisColor, strokeWidth: 1 }} minPointSize={tapSliver} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div className="mt-[0.2vh] text-[1.05vh] landscape:text-[1.15vh] leading-tight truncate" style={{ color: movement.issues_recorded ? "var(--dx-t3)" : "var(--pill-amber)" }}>
                  {movement.issues_recorded ? (
                    <>
                      This month:{" "}
                      {movement.this_month?.in_value != null
                        ? <Tap className="inline rounded-sm px-[0.2vh]" onOpen={() => openMonth(moveData.length - 1, "in")} label="This month's Receipt (ERP GRN lines). Open the list">receipt {fmtMoney(movement.this_month.in_value)}</Tap>
                        : <>receipt {fmtMoney(movement.this_month?.in_value)}</>}
                      {" · "}
                      {movement.this_month?.out_value != null
                        ? <Tap className="inline rounded-sm px-[0.2vh]" onOpen={() => openMonth(moveData.length - 1, "out")} label="This month's Issue. Open the list">issue {fmtMoney(movement.this_month.out_value)}</Tap>
                        : <>issue {fmtMoney(movement.this_month?.out_value)}</>}
                    </>
                  ) : "No issue recorded in the app yet"}
                </div>
              </>
            )}
      </Card>

      {/* ---------- department-wise issue ---------- */}
        <Card className="min-w-0 p-[0.7vh] order-5 landscape:order-8">
          {/* This shift's issues have their own tile (Issued Today). Here, the
              month: how much went out and where it was used (the store, 22 Oct
              2026: "kitna issue hua and kahan consume hua wo data mile"). */}
          <PanelHead icon={FileBarChart} color={C.purple} title="Issue & Consumption · This Month" />
          {deptState !== "ok" ? <PanelState state={deptState} onRetry={reload} h="8vh" /> : (
            <div className="space-y-[0.5vh] landscape:space-y-[0.8vh] pt-[0.3vh]">
              {issueMonth && issueMonth.total?.issues > 0 && (
                <div className="grid grid-cols-3 gap-[0.5vh]">
                  {[
                    { label: "Issued", value: fmtInt(issueMonth.total.qty), sub: `${fmtInt(issueMonth.total.issues)} issues · ${fmtMoney(issueMonth.total.value)}`, color: STATUS.out },
                    { label: "Returned", value: fmtInt(issueMonth.total.returned), sub: "came back", color: C.muted },
                    { label: "Consumed", value: fmtInt(issueMonth.total.net_qty), sub: fmtMoney(issueMonth.total.net_value), color: C.purple },
                  ].map((t) => (
                    <div key={t.label} className="min-w-0 rounded-xl px-[0.8vh] py-[0.4vh]" style={{ background: "var(--dx-track)" }}>
                      <div className="text-[1.05vh] landscape:text-[1.2vh] leading-tight text-[var(--dx-t3)] truncate">{t.label}</div>
                      <div className="text-[1.7vh] landscape:text-[2.1vh] font-extrabold leading-none tabular-nums" style={{ color: t.color }}>{t.value}</div>
                      <div className="hidden landscape:block mt-[0.2vh] text-[1.05vh] leading-tight text-[var(--dx-t4)] truncate">{t.sub}</div>
                    </div>
                  ))}
                </div>
              )}
              {/* Each consuming department, the most issued first; each opens its issues this month. */}
              {deptData.length ? deptData.slice(0, 4).map((d) => (
                <Tap key={d.name} className="rounded-md px-[0.3vh] -mx-[0.3vh]" onOpen={() => openDept(d)}
                  label={`${d.name}: ${fmtInt(d.value)} issued this month. Open the list`}>
                  <DeptBar {...d} />
                </Tap>
              ))
                : <div className="text-[1.4vh] text-[var(--dx-t4)] py-[2.2vh] text-center">No issue recorded this month</div>}
              {/* No "Used at" line / machine list since 28 Oct 2026: nothing
                  records one since Confirm Installation went. */}
            </div>
          )}
        </Card>

      {/* ---------- stock value trend ---------- */}
      {/* What the stock was worth, day by day up to year by year (the store,
          24 Oct 2026: "graph me dikhe ki inventory ka trand kya chal rha h month
          wise year wise"), in the place the discontinued panel had. Worked back
          from today's stock through the ledger at today's rate
          (SpareManagementService._value_trend): a block of stock loaded from
          Excel shows as a step, named under the chart, never as buying. */}
      <Card className="min-w-0 p-[0.7vh] order-7 landscape:order-9 flex flex-col">
        <PanelHead tight icon={TrendingUp} color={C.blue} title="Stock Value Trend · ₹"
          action="View Details" onAction={trend ? () => openTrend(trendView) : undefined} />
        {mgState !== "ok" ? <PanelState state={mgState} onRetry={reload} h="8.3vh" />
          : !trend ? <PanelState h="8.3vh" empty={trend === null ? "No stock with a rate yet" : "Not available on this server yet"} /> : (
            <>
              <div className="flex items-center gap-[0.8vh] min-w-0 pb-[0.2vh]">
                <span className="shrink-0 text-[1.8vh] landscape:text-[2.2vh] font-extrabold leading-none tabular-nums" style={{ color: C.blue }}>{fmtMoney(trend.value)}</span>
                {trendDelta != null && (
                  <span className="min-w-0 truncate text-[1.05vh] landscape:text-[1.2vh] font-semibold leading-tight text-[var(--dx-t3)]">
                    {trendDelta === 0 ? "no change" : `${trendDelta > 0 ? "▲" : "▼"} ${fmtMoney(Math.abs(trendDelta))}`} vs {trendViewOf(trendView).prev}
                  </span>
                )}
                <span className="ml-auto shrink-0"><TrendSelect view={trendView} setView={setTrendView} /></span>
              </div>
              <div className="h-[6.2vh] landscape:h-auto landscape:flex-1 landscape:min-h-[9vh]">
                <TrendChart points={trendPts} axis={axisColor} grid={gridColor} tickPx={tickPx} onOpen={() => openTrend(trendView)} />
              </div>
              <div className="hidden landscape:block mt-[0.3vh] text-[1.1vh] leading-tight text-[var(--dx-t4)] truncate">
                At today's rate{trend.loads?.[0] ? ` · ${fmtIsoDay(trend.loads[0].date)}: ${fmtMoney(trend.loads[0].value)} Excel load` : ""}
              </div>
            </>
          )}
      </Card>

      {/* ---------- ERP current stock ---------- */}
      <Card className="min-w-0 p-[0.7vh] order-8 landscape:order-10 flex flex-col">
        <PanelHead tight icon={Database} color={C.cyan} title={`ERP vs Physical${secView ? " (store)" : ""}`}
          action="View Details" onAction={openErpGap} />
        {erpState !== "ok" ? <PanelState state={erpState} onRetry={reload} h="9vh" /> : (
          <>
            {/* Units are summed over the parts in BOTH — an ERP figure and a
                count — so the two totals describe the same parts. */}
            {/* Two by two: the card is half the wall's width and one column
                of four in landscape. */}
            <div className="grid grid-cols-2 gap-[0.5vh] landscape:flex-1">
              {[
                { label: "ERP Stock", value: erpSum.reconciled ? fmtInt(Math.round(erpSum.erp_units)) : "—", sub: `units · ${snapDay ? `${snapDay} snapshot` : "no snapshot"}`, color: C.cyan },
                { label: "Physical Stock", value: erpSum.reconciled ? fmtInt(Math.round(erpSum.physical_units)) : "—", sub: "units · store count, same parts", color: C.blue },
                { label: "Match Accuracy", value: erpSum.accuracy_pct != null ? `${erpSum.accuracy_pct}%` : "—", sub: `of ${fmtInt(erpSum.reconciled)} parts in both`, color: C.green },
                { label: "With Gap", value: erpSum.reconciled ? fmtInt(erpGapCount) : "—", sub: "short / excess vs snapshot", color: C.amber },
              ].map((s) => (
                // Each tile opens the comparison list, cut to what it counts.
                <Tap key={s.label} onOpen={erpOpen[s.label]} label={`${s.label}: ${s.value}. Open the list`} hover="hover:ring-1 hover:ring-slate-400/60"
                  className="min-w-0 rounded-xl px-[0.9vh] py-[0.3vh] landscape:px-[1.3vh] flex flex-col justify-center" style={{ background: "var(--dx-track)" }}>
                  <div className="text-[1.05vh] landscape:text-[1.25vh] leading-tight text-[var(--dx-t3)] truncate">{s.label}</div>
                  <div className="mt-[0.2vh] landscape:mt-[0.25vh] text-[1.8vh] landscape:text-[2.3vh] font-extrabold leading-none tabular-nums" style={{ color: s.color }}>{s.value}</div>
                  {/* the sub-line would only be cut off in the narrow wall tile */}
                  <div className="hidden landscape:block mt-[0.25vh] text-[1.1vh] leading-tight text-[var(--dx-t4)] truncate">{s.sub}</div>
                </Tap>
              ))}
            </div>
            <div className="hidden landscape:block mt-[0.5vh] text-[1.1vh] leading-tight text-[var(--dx-t4)] truncate">
              {snapWord
                ? <>ERP = the <span className={snapDays ? "font-semibold text-amber-600" : ""}>{snapWord}</span>, not a live feed</>
                : "No ERP stock snapshot received yet"}
            </div>
          </>
        )}
      </Card>

      {/* ---------- management action tracker ---------- */}
      {/* Which problem, how big, how much money, and WHO must act — the same
          lines, owners and target dates as the app's Action Tracker page. A
          line opens its list where the board has one. */}
      <Card className="min-w-0 p-[0.7vh] order-6 col-span-2 landscape:col-span-3 landscape:order-12">
        <PanelHead icon={ListChecks} color={C.red} title="Management Action Tracker"
          note={tracker ? `${fmtInt(tracker.summary?.open)} open${tracker.summary?.overdue ? ` · ${fmtInt(tracker.summary.overdue)} overdue` : ""} · worst first` : undefined} />
        {mgState !== "ok" || !tracker ? <PanelState state={mgState === "ok" ? "error" : mgState} onRetry={reload} h="12vh" /> : (
          <div className="min-w-0">
            <div className={`${TRK_COLS} px-[0.6vh] pb-[0.3vh] text-[1vh] landscape:text-[1.15vh] font-bold uppercase tracking-wide text-[var(--dx-t4)] border-b border-[var(--dx-border)]`}>
              <span>Problem</span><span className="text-right">Count</span><span className="text-right">₹ at stake</span>
              <span className="hidden landscape:block">Action needed</span><span>Action by</span>
              <span className="hidden landscape:block">Target</span><span className="text-right">Status</span>
            </div>
            {trackerRows.map((it, i) => <TrackerRow key={it.key} it={it} wallHidden={i >= 6} onOpen={trackerOpen[it.key]} />)}
            {!trackerRows.length && <div className="py-[2.5vh] text-center text-[1.4vh] text-[var(--dx-t4)]">Nothing to track yet</div>}
          </div>
        )}
      </Card>

      {/* ---------- recent transactions (landscape only — on the wall the newest line runs in the ticker) ---------- */}
      <Card className="min-w-0 p-[0.7vh] hidden landscape:block landscape:order-[13]">
        <PanelHead icon={PackagePlus} color={C.green} title={`Recent Transactions${secView ? " (whole store)" : ""}`} />
        <div>
        {recentState !== "ok" ? <PanelState state={recentState} onRetry={reload} h="10vh" /> : (
        <table className="w-full text-[1.4vh]">
          <thead>
            <tr className="text-left text-[1.2vh] uppercase tracking-wide text-[var(--dx-t4)] border-b border-[var(--dx-border)]">
              <th className="py-[0.4vh] pr-[1vh]">When</th><th className="pr-[1vh]">Type</th><th className="pr-[1vh]">Part No.</th>
              <th className="pr-[1vh] text-center">Qty</th><th className="pr-[1vh]">Dept.</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--dx-divide)]">
            {recent.slice(0, 7).map((r, i) => {
              return (
                <tr key={i}>
                  <td className="py-[0.4vh] pr-[1vh] text-[var(--dx-t3)] tabular-nums whitespace-nowrap">{whenOf(r.at || r.created_at)}</td>
                  <td className="pr-[1vh]">
                    {/* The drills' colours: an OPENING count is slate, not a green receipt. */}
                    <span className="rounded px-[0.9vh] py-[0.2vh] text-[1.2vh] font-bold" style={typeStyle(r.txn_type)}>{r.txn_type}</span>
                  </td>
                  <td className="pr-[1vh] font-semibold text-[var(--dx-t1)]">{r.part_no}</td>
                  <td className="pr-[1vh] text-center font-bold">{fmtInt(Math.abs(r.qty_delta ?? r.qty ?? 0))}</td>
                  <td className="pr-[1vh] text-[var(--dx-t3)] truncate max-w-[14vh]">{r.department || "—"}</td>
                </tr>
              );
            })}
            {!recent.length && <tr><td colSpan={5} className="py-[2.5vh] text-center text-[var(--dx-t4)] text-[1.5vh]">No movement recorded yet</td></tr>}
          </tbody>
        </table>
        )}
        </div>
      </Card>
      </div>{/* /the panels */}

      {/* ---------- Explore-Data drill (opens WITHIN the board) ---------- */}
      {stack.length > 0 && (
        <div className="fixed inset-0 z-50 text-[var(--dx-t2)] flex flex-col p-[1.6vh] gap-[1.4vh] overflow-auto" style={{ ...themeVars, background: "var(--dx-board)" }}>
          <div className="rounded-2xl px-[2vh] py-[1.3vh] flex items-center gap-[1.5vh] text-white shrink-0 overflow-hidden"
            style={{ background: "radial-gradient(680px 280px at 88% -50%, rgba(235,10,30,0.28), transparent 62%), linear-gradient(120deg,#0f1f38 0%,#1d4368 50%,#0f1f38 100%)", boxShadow: "0 12px 34px rgba(10,32,70,0.38), inset 0 1px 0 rgba(255,255,255,0.08)" }}>
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
          {/* Every frame of the trail stays mounted, one layer each, only the
              last one shown: a part opened from a list sits OVER that list, so
              Back finds it exactly as it was left — scrolled to the same row,
              the same type / section bar still picked — instead of building it
              again from the top (the store, 23 Oct 2026: "back button se wapis
              usi screen par aani chahiye", as on the Spare Store dashboard).
              Each layer scrolls on its own, so each keeps its own place. */}
          <div className="relative flex-1 min-h-0">
            {stack.map((f, i) => {
              const top = i === stack.length - 1;
              return (
                // Keyed by what the frame shows, so another part opened in the
                // same place starts fresh (photo closed) rather than inheriting.
                <div key={`${i}-${f.kind}-${f.title}`} aria-hidden={!top} className={`absolute inset-0 overflow-auto ${top ? "" : "invisible"}`}>
                  {f.kind === "partHistory"
                    ? <PartHistoryView frame={f} axis={axisColor} grid={gridColor} />
                    : f.kind === "valueTrend"
                    ? <ValueTrendView frame={f} axis={axisColor} grid={gridColor} />
                    : f.kind === "txnList"
                      ? <TxnListView frame={f} onOpen={openHistory} axis={axisColor} grid={gridColor} />
                      : f.kind === "erpGap"
                        ? <ErpGapView frame={f} onOpen={openHistory} axis={axisColor} grid={gridColor} />
                        : f.kind === "srvList"
                          ? <SrvListView frame={f} />
                          : <PartListView frame={f} onOpen={openHistory} axis={axisColor} grid={gridColor} />}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Explore-Data drill views ---------------------------------------------

// The stock value trend's views (management.value_trend.series).
const TREND_VIEWS = [
  { key: "day", short: "D", label: "Day", prev: "yesterday" },
  { key: "week", short: "W", label: "Week", prev: "last week" },
  { key: "month", short: "M", label: "Month", prev: "last month" },
  { key: "year", short: "Y", label: "Year", prev: "last year" },
];
const trendViewOf = (key) => TREND_VIEWS.find((v) => v.key === key) || TREND_VIEWS[2];
// A rupee axis in the unit its figures need: crore once any point reaches one.
const trendUnit = (points) => (Math.max(0, ...points.map((p) => p.value || 0)) >= 1e7
  ? { div: 1e7, unit: "₹ Cr" } : { div: 1e5, unit: "₹ lakh" });

// Day wise / Week wise / Month wise / Year wise, as one dropdown on the chart
// (the store, 24 Oct 2026: "drop down laga graph me"). The list it opens is the
// browser's own, so its options keep dark text on white in the night theme too.
function TrendSelect({ view, setView, big = false }) {
  return (
    <select value={view} onChange={(e) => setView(e.target.value)} onClick={(e) => e.stopPropagation()}
      aria-label="Trend by" title="Show the trend day / week / month / year wise"
      className={`rounded-md border border-[var(--dx-border)] bg-[var(--dx-track)] font-semibold text-[var(--dx-t1)] cursor-pointer focus:outline-none focus:ring-1 focus:ring-blue-400 ${big ? "px-[1vh] py-[0.4vh] text-[1.5vh]" : "px-[0.5vh] py-[0.1vh] text-[1.1vh] landscape:text-[1.2vh]"}`}>
      {TREND_VIEWS.map((v) => (
        <option key={v.key} value={v.key} style={{ color: "#0f172a", background: "#fff" }}>{v.label} wise</option>
      ))}
    </select>
  );
}

function TrendChart({ points, axis, grid, tickPx, onOpen }) {
  const { div } = trendUnit(points);
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={points} margin={{ top: 6, right: 8, left: 0, bottom: 0 }} onClick={onOpen}
        style={onOpen ? { cursor: "pointer" } : undefined}>
        <defs>
          <linearGradient id="dxTrendFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={C.blue} stopOpacity={0.32} />
            <stop offset="100%" stopColor={C.blue} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={grid} />
        <XAxis dataKey="label" axisLine={{ stroke: grid }} tickLine={false} tick={{ fontSize: tickPx, fill: axis }}
          interval="preserveStartEnd" minTickGap={10} height={Math.round(tickPx * 1.7)} />
        <YAxis domain={[0, "auto"]} tick={{ fontSize: tickPx, fill: axis }} axisLine={false} tickLine={false}
          width={Math.round(tickPx * 2.4)} tickFormatter={(v) => +(v / div).toFixed(div === 1e7 ? 1 : 0)} />
        <Tooltip content={<BoardTip fmt={fmtMoney} />} cursor={{ stroke: axis, strokeDasharray: "3 3" }} />
        <Area type="monotone" dataKey="value" stroke="none" fill="url(#dxTrendFill)" tooltipType="none" isAnimationActive={false} />
        <Line type="monotone" dataKey="value" name="Stock value" stroke={C.blue} strokeWidth={2.5}
          dot={points.length <= 14 ? { r: 3, fill: C.blue, strokeWidth: 0 } : false} activeDot={{ r: 4 }} isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

// The value trend, full size: the chart and, per period, what the stock was
// worth at its end and how far that moved from the period before.
function ValueTrendView({ frame, axis = "#64748b", grid = "#e2e8f0" }) {
  const t = frame.trend || {};
  const [view, setView] = useState(frame.view || "month");
  const v = trendViewOf(view);
  const pts = t.series?.[view] || [];
  const tickPx = Math.max(12, Math.round((typeof window !== "undefined" ? window.innerHeight : 800) * 0.014));
  const rows = pts.map((p, i) => {
    const before = i ? pts[i - 1].value : null;
    return { ...p, change: before != null ? p.value - before : null, pct: before ? ((p.value - before) / before) * 100 : null };
  }).reverse();
  const span = (p) => (p.from === p.to ? fmtIsoDay(p.to) : `${fmtIsoDay(p.from)} – ${fmtIsoDay(p.to)}`);
  return (
    <div className="flex flex-col gap-[1.4vh]">
      <Card className="p-[1.5vh] text-[1.55vh] font-medium text-[var(--dx-t2)] border-l-4" style={{ borderLeftColor: C.blue }}>
        Stock value today {fmtMoney(t.value)}. Each point is what the stock was worth at the end of that {v.label.toLowerCase()}:
        today's stock worked back through the app's ledger, all at today's rate.
        {t.unrated_parts ? ` ${fmtInt(t.unrated_parts)} part(s) with stock but no rate are not counted.` : ""}
        {(t.loads || []).map((l) => ` ${fmtIsoDay(l.date)}: ${fmtMoney(l.value)} came in by an Excel load (${fmtInt(l.parts)} parts) — a load, not buying.`).join("")}
      </Card>
      <Card className="p-[1.6vh] flex flex-col">
        <div className="flex flex-wrap items-center justify-between gap-[1vh] mb-[1vh]">
          <h3 className="dx-radiant text-[1.8vh] font-bold text-[var(--dx-t1)]">By {v.label.toLowerCase()} · {trendUnit(pts).unit}</h3>
          <TrendSelect view={view} setView={setView} big />
        </div>
        <div className="h-[38vh]">
          <TrendChart points={pts} axis={axis} grid={grid} tickPx={tickPx} />
        </div>
      </Card>
      <Card className="p-[1.6vh]">
        <table className="w-full text-[1.45vh]">
          <thead>
            <tr className="text-left text-[1.2vh] uppercase tracking-wide text-[var(--dx-t4)] border-b border-[var(--dx-border)]">
              <th className="py-[0.7vh] pr-[1vh]">{v.label}</th><th className="pr-[1vh]">Period</th>
              <th className="pr-[1vh] text-right">Stock value</th><th className="pr-[1vh] text-right">Change</th><th className="text-right">%</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--dx-divide)]">
            {rows.map((r) => (
              <tr key={r.key}>
                <td className="py-[0.8vh] pr-[1vh] font-bold text-[var(--dx-t1)] whitespace-nowrap">{r.label}</td>
                <td className="pr-[1vh] text-[var(--dx-t3)] whitespace-nowrap">{span(r)}</td>
                <td className="pr-[1vh] text-right font-semibold tabular-nums text-[var(--dx-t1)]">{fmtMoney(r.value)}</td>
                <td className="pr-[1vh] text-right tabular-nums text-[var(--dx-t2)]">
                  {r.change == null ? "—" : r.change === 0 ? "no change" : `${r.change > 0 ? "▲" : "▼"} ${fmtMoney(Math.abs(r.change))}`}
                </td>
                <td className="text-right tabular-nums text-[var(--dx-t3)]">{r.pct == null ? "—" : Math.abs(r.pct) < 0.05 ? "0.0%" : `${r.pct > 0 ? "+" : ""}${r.pct.toFixed(1)}%`}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={5} className="py-[2.5vh] text-center text-[var(--dx-t4)]">No stock value on record</td></tr>}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function typeStyle(t) {
  if (t === "ISSUE") return { background: "rgba(244,63,94,0.16)", color: "var(--pill-red)" };
  if (t === "RECEIPT") return { background: "rgba(16,185,129,0.18)", color: "var(--pill-green)" };
  if (t === "RETURN") return { background: "rgba(59,130,246,0.18)", color: "var(--pill-blue)" };
  return { background: "rgba(148,163,184,0.18)", color: "var(--pill-slate)" };
}
function StatusPill({ status }) {
  // Same status, same colour as the desktop dashboard, via the --pill-* vars so
  // each stays readable in both the day and night board themes: Out of Stock
  // rose, Below Minimum amber, Reorder orange, Above Maximum blue, Healthy green,
  // anything else (incl. Not Counted) slate.
  const [pill, rgb] = status === "Out of Stock" ? ["red", "244,63,94"]
    : status === "Below Minimum" ? ["amber", "245,158,11"]
      : status === "Reorder" ? ["orange", "249,115,22"]
        : status === "Above Maximum" ? ["blue", "59,130,246"]
          : status === "Healthy" ? ["green", "16,185,129"]
            : ["slate", "148,163,184"];
  return <span className="rounded-full px-[1vh] py-[0.2vh] text-[1.2vh] font-bold whitespace-nowrap"
    style={{ background: `rgba(${rgb},0.16)`, color: `var(--pill-${pill})` }}>{status || "—"}</span>;
}
function Stat({ label, value }) {
  return (
    <div className="text-center">
      <div className="text-[1.2vh] text-[var(--dx-t4)]">{label}</div>
      <div className="text-[1.9vh] font-bold text-[var(--dx-t1)]">{value}</div>
    </div>
  );
}
// The centre of a donut — a bold gradient number with a soft glow and a small
// uppercase caption. One style for every donut on the board.
// The legend beside a donut. A real grid rather than a centred flex-wrap: the
// swatches line up in columns and the figures line up on the right, so the
// entries read in order (row by row) instead of every row being centred on its
// own. Two columns once there are more than three entries; `note` spans the
// full width underneath. items: [{ key, name, color, value, onClick }].
function DonutLegend({ items, note, empty }) {
  // A short legend (three sections or fewer) has long names and long money
  // figures. On the narrow portrait card those cannot share a line without the
  // name being cut to "Mainte…", so there each entry is two lines: name, then
  // figure. Longer legends (part types, landscape only) keep one line per
  // entry in a single column — two columns cut the longer type names short in
  // the quarter-width card.
  const stack = items.length <= 3;
  return (
    <div className="flex-1 min-w-0 flex items-center justify-center">
      <div className={`grid w-full grid-cols-1 max-w-[30vh] gap-y-[0.15vh] ${stack ? "landscape:gap-y-[0.5vh]" : ""}`}>
        {items.map((it) => (
          <button key={it.key} type="button" onClick={it.onClick}
            className={`flex ${stack ? "flex-wrap landscape:flex-nowrap landscape:text-[1.35vh] landscape:leading-normal landscape:py-[0.15vh]" : "landscape:text-[1.25vh] landscape:leading-tight"} items-center gap-x-[0.8vh] min-w-0 text-[1.15vh] leading-[1.12] rounded-md px-[0.5vh] py-[0.1vh] hover:bg-[var(--dx-track)] transition-colors`}>
            <span className="w-[1.2vh] h-[1.2vh] landscape:w-[1.4vh] landscape:h-[1.4vh] rounded-full shrink-0" style={{ background: gradCss(it.color), boxShadow: `0 1px 4px ${it.color}66` }} />
            <span className={`flex-1 min-w-0 text-left text-[var(--dx-t2)] truncate ${stack ? "basis-[calc(100%-2.2vh)] landscape:basis-0" : ""}`}>{it.name}</span>
            <span className="ml-auto dx-radiant font-bold text-[var(--dx-t1)] whitespace-nowrap shrink-0 tabular-nums">{it.value}</span>
          </button>
        ))}
        {!items.length && empty && <div className="col-span-full text-center text-[1.5vh] text-[var(--dx-t4)]">{empty}</div>}
        {/* the hint is a nicety there is no room for on the wall card */}
        {note && <div className="hidden landscape:block col-span-full text-center text-[1.2vh] leading-tight text-[var(--dx-t4)] pt-[0.2vh]">{note}</div>}
      </div>
    </div>
  );
}

function DonutHub({ value, label, size = "2.5vh" }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none px-[0.6vh] text-center">
      <span className="dx-radiant font-black tabular-nums leading-none tracking-tight max-w-[56%]"
        style={{ fontSize: size, filter: "drop-shadow(0 2px 10px rgba(90,130,230,0.30))" }}>{value}</span>
      <span className="mt-[0.15vh] max-w-[62%] truncate text-[0.6vh] font-semibold uppercase tracking-normal text-[var(--dx-t4)]">{label}</span>
    </div>
  );
}

// How long an excess part has waited since its last ERP inward. With no inward in
// the ERP history the wait is at least the history's length ("145+ days").
function AgeCell({ r, age }) {
  const days = r.age_days;
  const color = days == null || days > 90 ? "var(--pill-red)" : days > 30 ? "var(--pill-amber)" : "var(--pill-green)";
  return (
    <>
      <span className="font-bold tabular-nums" style={{ color }}>
        {days != null ? `${fmtInt(days)} days` : age.horizonDays != null ? `${fmtInt(age.horizonDays)}+ days` : "—"}
      </span>
      <span className="ml-[0.7vh] text-[1.2vh] text-[var(--dx-t4)]">
        {days != null ? `since ${fmtIsoDay(r.last_inward)}` : age.since ? `no inward since ${age.since}` : "no inward on record"}
      </span>
    </>
  );
}

function PartListView({ frame, onOpen, axis = "#64748b", grid = "#e2e8f0" }) {
  const rows = frame.rows || [];
  // `valueOf` is also every object's inherited method, so only the frame's OWN
  // one counts — a list opened without one fell on Object.prototype.valueOf and crashed.
  const valueOf = Object.prototype.hasOwnProperty.call(frame, "valueOf") ? frame.valueOf : (r) => r.qty_on_hand || 0;
  const fmtV = frame.valueFmt || fmtInt;
  // The table always shows Stock; a 2nd value column only when the frame carries
  // a DIFFERENT measure (Value ₹, Short by, Excess by), never a duplicate "Stock".
  const showValue = Boolean(frame.valueLabel) && frame.valueLabel !== "Stock";
  // Tap a "Parts by category" bar to filter the list to that type (how many die
  // parts, how many sensors…). Cleared whenever the data reloads.
  const [pick, setPick] = useState(null);
  const [secPick, setSecPick] = useState(null);
  useEffect(() => { setPick(null); setSecPick(null); }, [rows]);
  const sectionNames = frame.sectionNames || {};
  // An excess-aging list: each row's wait since its last inward replaces the status.
  const age = frame.ageCol || null;
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
  // The drill was opened before the board's parts list arrived (or after it
  // failed) — say that, rather than an empty list that reads as "no parts".
  if (frame.rowsState && frame.rowsState !== "ok") {
    return (
      <Card className="p-[3vh] text-center text-[1.8vh] text-[var(--dx-t3)]">
        {frame.rowsState === "error"
          ? "The parts list could not be loaded, so this list can't be shown. Close it and tap the retry alert on the board."
          : "The parts list is still loading — close this and open it again in a moment."}
      </Card>
    );
  }
  const isByType = frame.chart === "byType";
  const isBySection = frame.chart === "bySection";
  // No chart at all on a list that is not about money (Critical, Reorder,
  // Healthy, a type's parts): ranking pcs / sets / metres against each other
  // says nothing ("is type k jitne bhi chart wo horizontal" — 22 Oct 2026).
  const hasChart = isByType || isBySection || Boolean(frame.top10);
  const chartData = isByType ? byType : isBySection ? bySection : top;
  const chartTotal = chartData.reduce((s, d) => s + (d.value || 0), 0);
  const chartTitle = isByType ? "Parts by category"
    : isBySection ? `${frame.valueLabel || "Value"} by section`
      : `Top ${top.length} by ${frame.valueLabel || "Stock"}`;
  const shown = secPick != null ? rows.filter((r) => r.section_id === secPick)
    : pick ? rows.filter((r) => (r.sub_category || "Others") === pick) : rows;
  const onBarClick = (d) => {
    const name = d && (d.name ?? d.payload?.name);
    if (isByType) { if (name) setPick((p) => (p === name ? null : name)); return; }
    if (isBySection) { const sid = d && (d.sid ?? d.payload?.sid); if (sid != null) setSecPick((p) => (p === sid ? null : sid)); return; }
    const r = name && rows.find((x) => x.part_no === name); if (r) onOpen(r);
  };
  return (
    <div className={`grid grid-cols-1 ${hasChart ? "xl:grid-cols-2" : ""} gap-[1.4vh] h-full`}>
      {hasChart && (
      <Card className="p-[1.6vh] flex flex-col">
        <h3 className="dx-radiant text-[1.8vh] font-bold text-[var(--dx-t1)] mb-[1vh]">{chartTitle}</h3>
        <div className="flex-1 min-h-[36vh]">
          {!chartData.length ? (
            <div className="h-full flex items-center justify-center text-[var(--dx-t4)] text-[1.6vh]">No parts</div>
          ) : isByType ? (
            // Ranked horizontal bars (not a donut) — tap a type to filter the list.
            <div className="h-full overflow-auto pr-[0.4vh] space-y-[0.6vh]">
              {chartData.map((c, i) => {
                const col = PIE[i % PIE.length];
                const active = pick === c.name;
                return (
                  <button key={c.name} onClick={() => setPick((p) => (p === c.name ? null : c.name))}
                    className={`w-full flex items-center gap-[1.2vh] text-[1.5vh] rounded-md px-[0.6vh] py-[0.55vh] transition-colors ${active ? "bg-[var(--dx-track)]" : "hover:bg-[var(--dx-track)]"}`}>
                    <span className="w-[1.4vh] h-[1.4vh] rounded-full shrink-0" style={{ background: gradCss(col), boxShadow: `0 1px 4px ${col}66` }} />
                    <span className="w-[16vh] shrink-0 text-left text-[var(--dx-t2)] truncate">{c.name}</span>
                    <span className="flex-1 h-[1.5vh] rounded-full overflow-hidden bg-[var(--dx-track)]">
                      <span className="block h-full rounded-full" style={{ width: `${Math.max(3, (c.value / (chartData[0]?.value || 1)) * 100)}%`, background: gradCss(col, 90) }} />
                    </span>
                    <span className="dx-radiant font-bold text-[var(--dx-t1)] whitespace-nowrap w-[8vh] text-right">{fmtInt(c.value)}</span>
                    <span className="w-[5vh] text-right text-[var(--dx-t4)]">{Math.round((c.value / (chartTotal || 1)) * 100)}%</span>
                  </button>
                );
              })}
              <div className="text-[1.2vh] text-[var(--dx-t4)] pt-[0.3vh] pl-[0.6vh]">Tap a type to filter the list</div>
            </div>
          ) : isBySection ? (
            <div className="h-full flex items-center gap-[1.5vh]">
              <div className="h-full aspect-square relative shrink-0" style={{ maxWidth: "36vh" }}>
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <defs>
                      {chartData.map((c, i) => {
                        const g = GRAD[c.color] || [c.color, c.color];
                        return <linearGradient key={i} id={`sg-${i}`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor={g[0]} /><stop offset="1" stopColor={g[1]} /></linearGradient>;
                      })}
                    </defs>
                    <Pie data={chartData} dataKey="value" nameKey="name" innerRadius="60%" outerRadius="88%"
                      paddingAngle={1} stroke="none" isAnimationActive={false} onClick={onBarClick}>
                      {chartData.map((c, i) => <Cell key={i} fill={`url(#sg-${i})`} cursor="pointer" />)}
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>
                <DonutHub value={fmtV(chartTotal)} label="Total value" size="3.4vh" />
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
            // A ranking reads across: HORIZONTAL bars, the part no. and its
            // description beside each, the money at the bar's end (the store's
            // chart rule, 17 Oct 2026 — vertical bars are for time only). Tap a
            // part for its history.
            <div className="h-full flex flex-col">
              <div className="flex-1 min-h-0 overflow-auto pr-[0.4vh] space-y-[0.4vh]">
                {top.map((c, i) => (
                  <button key={c.name} type="button" onClick={() => onBarClick(c)} title={`${c.name} — ${c.desc || ""}`}
                    className="w-full text-left rounded-md px-[0.6vh] py-[0.45vh] hover:bg-[var(--dx-track)] transition-colors">
                    <span className="flex items-baseline gap-[1vh] text-[1.45vh]">
                      <span className="w-[2.4vh] shrink-0 text-right tabular-nums text-[var(--dx-t4)]">{i + 1}</span>
                      <span className="shrink-0 font-bold text-[var(--dx-t1)]">{c.name}</span>
                      <span className="min-w-0 flex-1 truncate text-[1.3vh] text-[var(--dx-t3)]">{c.desc}</span>
                      <span className="dx-radiant shrink-0 whitespace-nowrap font-bold text-[var(--dx-t1)]">{fmtV(c.value)}</span>
                    </span>
                    <span className="ml-[3.4vh] mt-[0.3vh] block h-[1.1vh] rounded-full bg-[var(--dx-track)] overflow-hidden">
                      <span className="block h-full rounded-full"
                        style={{ width: `${Math.max(2, (c.value / (top[0]?.value || 1)) * 100)}%`, background: gradCss(C.blue, 90) }} />
                    </span>
                  </button>
                ))}
              </div>
              <div className="mt-[0.4vh] flex items-center justify-between border-t border-[var(--dx-border)] pt-[0.7vh] px-[0.4vh]">
                <span className="text-[1.25vh] font-semibold uppercase tracking-wide text-[var(--dx-t4)]">Top {top.length} total</span>
                <span className="dx-radiant text-[2.2vh] font-extrabold text-[var(--dx-t1)]">{fmtV(chartTotal)}</span>
              </div>
            </div>
          )}
        </div>
      </Card>
      )}
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
              <th className="pr-[1vh]">{age ? "Pending since" : "Status"}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--dx-divide)]">
            {shown.map((r) => (
              <tr key={r.part_id} onClick={() => onOpen(r)} className="cursor-pointer hover:bg-[var(--dx-track)] transition-colors">
                <td className="py-[0.9vh] pr-[1vh] font-bold text-[var(--dx-t1)]">{r.part_no}</td>
                <td className="pr-[1vh] text-[var(--dx-t2)] truncate max-w-[24vh]">{r.part_name}</td>
                <td className="pr-[1vh] text-center">{fmtInt(r.qty_on_hand)}</td>
                {showValue && <td className="pr-[1vh] text-center font-semibold text-[var(--dx-t1)]">{fmtV(valueOf(r))}</td>}
                <td className="pr-[1vh] whitespace-nowrap">{age ? <AgeCell r={r} age={age} /> : <StatusPill status={r.status} />}</td>
              </tr>
            ))}
            {!shown.length && <tr><td colSpan={showValue ? 5 : 4} className="py-[3vh] text-center text-[var(--dx-t4)] text-[1.6vh]">{pick ? `No ${pick} parts` : "No parts in this list"}</td></tr>}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

// The stock-history hover: what happened at that point — the movement, its qty
// and the balance after it — not the balance alone (the store, 22 Oct 2026:
// "jo lable aata h cursior se wo bhi check kar").
function HistTip({ active, payload }) {
  const p = active && payload?.[0]?.payload;
  if (!p) return null;
  const text = "max(11px, 1.25vh)";
  const line = (k, v, color = "#fff") => (
    <div style={{ display: "flex", gap: "1.4vh", fontSize: text, lineHeight: 1.5, color: "#b4c5e0", whiteSpace: "nowrap" }}>
      <span>{k}</span><span style={{ marginLeft: "auto", color, fontWeight: 700 }}>{v}</span>
    </div>
  );
  return (
    <div style={{ background: "rgba(10,20,40,0.96)", border: "1px solid rgba(125,195,255,0.4)", borderRadius: 8, padding: "0.6vh 1vh", boxShadow: "0 10px 30px rgba(0,0,0,0.5)", pointerEvents: "none" }}>
      <div style={{ color: "#fff", fontWeight: 700, fontSize: text, marginBottom: "0.2vh" }}>{p.d}</div>
      {p.type
        ? line(p.type, `${p.qty > 0 ? "+" : ""}${fmtInt(p.qty)}`, p.qty < 0 ? "#fb7185" : "#34d399")
        : line("No movement since", "—")}
      {line(p.type ? "Balance after" : "In stock", fmtInt(p.bal))}
    </div>
  );
}

function PartHistoryView({ frame, axis = "#64748b", grid = "#e2e8f0" }) {
  const part = frame.part || {};
  const [bigPhoto, setBigPhoto] = useState(false);
  const photo = partService.imageUrl({ id: part.part_id, image_file: part.image_file }, true);
  // Stock movements only: an installation entry in the part's history moves no
  // stock, so it is neither a "movement" here nor a point on the balance line.
  const hist = (frame.history || []).filter((h) => h.row_kind !== "installation");
  // Stock holds its level until the next movement — a step, never a slope
  // between two dates — and the last level runs on to today.
  const chart = hist.slice().reverse().map((h) => ({
    d: fmtDay(h.at || h.created_at), bal: Number(h.balance_after ?? 0), type: h.txn_type, qty: Number(h.qty_delta ?? 0),
  }));
  if (chart.length && chart[chart.length - 1].d !== fmtDay(new Date().toISOString())) {
    chart.push({ d: "Today", bal: chart[chart.length - 1].bal, type: null });
  }
  const emptyText = frame.error ? "Couldn't load this part's history — close and tap the part again" : "No movement recorded yet";
  // Still fetching: nothing below may read as "no movement" or "since …" yet.
  const loading = Boolean(frame.loading);
  // "Kab se pada" — how long it has sat unused: since the last issue if any, else
  // since its earliest recorded movement / count. The ledger only starts when the
  // app did, so with no issue on record this is "no issue recorded since", never
  // "in stock since" — the part may well have sat there long before.
  const lastIssue = hist.find((h) => h.txn_type === "ISSUE");
  const sinceAt = (lastIssue && (lastIssue.at || lastIssue.created_at))
    || (hist.length && (hist[hist.length - 1].at || hist[hist.length - 1].created_at))
    || part.last_counted_at || null;
  const sinceT = sinceAt ? parseServerTime(sinceAt) : null;
  const lyingDays = sinceT ? Math.max(0, Math.floor((Date.now() - sinceT.getTime()) / 86400000)) : null;
  return (
    <div className="flex flex-col gap-[1.4vh]">
      <Card className="p-[1.6vh]">
        <div className="flex items-center gap-[2vh] flex-wrap">
          {photo && (
            <button type="button" onClick={() => setBigPhoto(true)} title="Open the photo"
              className="shrink-0 w-[8vh] h-[8vh] rounded-lg overflow-hidden bg-[var(--dx-track)] hover:ring-2 hover:ring-slate-400/60">
              <img src={photo} alt={`${part.part_no} photo`} className="w-full h-full object-cover" />
            </button>
          )}
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
            {part.rework_location && <Stat label="Rework bin" value={part.rework_location} />}
            <Stat label={lastIssue ? "Not issued since" : "No issue recorded since"}
              value={!loading && sinceAt ? `${fmtDay(sinceAt)}${lyingDays != null ? ` · ${lyingDays}d` : ""}` : "—"} />
          </div>
        </div>
      </Card>

      {bigPhoto && (
        <div className="fixed inset-0 z-[70] bg-black/80 flex items-center justify-center p-[3vh] cursor-zoom-out" onClick={() => setBigPhoto(false)}>
          <img src={partService.imageUrl({ id: part.part_id, image_file: part.image_file })} alt={`${part.part_no} photo`}
            className="max-w-full max-h-full rounded-xl shadow-2xl" />
        </div>
      )}
      <Card className="p-[1.6vh]">
        <h3 className="dx-radiant text-[1.8vh] font-bold text-[var(--dx-t1)] mb-[1vh]">Stock Level History</h3>
        <div className="h-[32vh]">
          {loading ? <PanelState state="loading" h="100%" /> : chart.length ? (
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chart} margin={{ top: 8, right: 54, left: -12, bottom: 0 }}>
                <defs>
                  <linearGradient id="dg-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#2563eb" stopOpacity="0.35" /><stop offset="1" stopColor="#2563eb" stopOpacity="0" /></linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke={grid} vertical={false} />
                <XAxis dataKey="d" tick={{ fontSize: 12, fill: axis }} />
                <YAxis tick={{ fontSize: 12, fill: axis }} width={42} />
                <Tooltip content={<HistTip />} cursor={{ fill: "var(--dx-track)" }} />
                {part.max_stock_level != null && (
                  <ReferenceLine y={part.max_stock_level} stroke="#d97706" strokeDasharray="6 4" ifOverflow="extendDomain"
                    label={{ value: `Max ${part.max_stock_level}`, position: "right", fill: "#d97706", fontSize: 11, fontWeight: 700 }} />
                )}
                {/* The area only shades under the line: one "Balance" in the tooltip, not two. */}
                <Area type="stepAfter" dataKey="bal" stroke="none" fill="url(#dg-area)" tooltipType="none" />
                <Line type="stepAfter" dataKey="bal" name="Balance" stroke="#2563eb" strokeWidth={2.5} dot={{ r: 3, fill: "#2563eb" }} />
              </ComposedChart>
            </ResponsiveContainer>
          ) : <div className="h-full flex items-center justify-center text-[var(--dx-t4)] text-[1.6vh]">{emptyText}</div>}
        </div>
      </Card>

      <Card className="p-[1.6vh] overflow-auto">
        <h3 className="dx-radiant text-[1.8vh] font-bold text-[var(--dx-t1)] mb-[1vh]">{loading ? "Movements" : `Movements (${hist.length})`}</h3>
        {loading ? <PanelState state="loading" h="14vh" /> : (
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
                {/* Signed both ways — a +1 shown without its −1 read as a wrong balance
                    ("add karke dikha rha h to less karke bhi dikha" — the store, 22 Oct 2026). */}
                <td className="pr-[1vh] text-center font-bold tabular-nums"
                  style={{ color: Number(h.qty_delta) < 0 ? "var(--pill-red)" : Number(h.qty_delta) > 0 ? "var(--pill-green)" : undefined }}>
                  {Number(h.qty_delta) > 0 ? "+" : ""}{fmtInt(h.qty_delta)}
                </td>
                <td className="pr-[1vh] text-center">{fmtInt(h.balance_after)}</td>
                <td className="pr-[1vh] text-[var(--dx-t3)]">{h.department || "—"}</td>
                <td className="pr-[1vh] text-[var(--dx-t3)]">{h.machine || "—"}</td>
                <td className="pr-[1vh] text-[var(--dx-t3)]">{h.created_by || h.confirmed_by || "—"}</td>
              </tr>
            ))}
            {!hist.length && <tr><td colSpan={7} className="py-[3vh] text-center text-[var(--dx-t4)] text-[1.6vh]">{emptyText}</td></tr>}
          </tbody>
        </table>
        )}
      </Card>
    </div>
  );
}

function TxnListView({ frame, onOpen, axis = "#64748b", grid = "#e2e8f0" }) {
  const rows = frame.rows || [];
  return (
    <div className="flex flex-col gap-[1.4vh] h-full">
      {frame.note && (
        <Card className="p-[1.5vh] text-[1.55vh] font-medium text-[var(--dx-t2)] border-l-4" style={{ borderLeftColor: "#7c3aed" }}>{frame.note}</Card>
      )}
      <Card className="p-[1.6vh] overflow-auto flex-1">
        <h3 className="dx-radiant text-[1.8vh] font-bold text-[var(--dx-t1)] mb-[1vh]">
          {frame.loading ? "Loading movements…" : `${rows.length} movement(s) · tap a row for that part's history`}
        </h3>
        {frame.loading ? <PanelState state="loading" h="30vh" /> : (
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
                <td className="py-[0.8vh] pr-[1vh] text-[var(--dx-t3)] tabular-nums">{dayISOOf(r.at)}</td>
                <td className="pr-[1vh]"><span className="rounded px-[0.9vh] py-[0.2vh] text-[1.2vh] font-bold" style={typeStyle(r.txn_type)}>{r.txn_type}</span></td>
                <td className="pr-[1vh] font-bold text-[var(--dx-t1)]">{r.part_no}</td>
                <td className="pr-[1vh] text-[var(--dx-t2)] truncate max-w-[22vh]">{r.part_name}</td>
                <td className="pr-[1vh] text-center font-semibold">{fmtInt(r.qty_delta)}</td>
                <td className="pr-[1vh] text-center">{fmtInt(r.balance_after)}</td>
              </tr>
            ))}
            {!rows.length && (
              <tr><td colSpan={6} className="py-[3vh] text-center text-[var(--dx-t4)] text-[1.6vh]">
                {frame.error ? "Couldn't load these movements — close and try again" : frame.empty || "No movements"}
              </td></tr>
            )}
          </tbody>
        </table>
        )}
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
    { k: "not_synced", label: "Not in ERP snapshot", color: "#64748b" },
  ];
  const statusStyle = (st) =>
    st === "MATCH" ? { background: "rgba(16,185,129,0.18)", color: "var(--pill-green)" }
      : st === "SHORT" ? { background: "rgba(244,63,94,0.16)", color: "var(--pill-red)" }
        : st === "EXCESS" ? { background: "rgba(245,158,11,0.18)", color: "var(--pill-amber)" }
          : { background: "rgba(148,163,184,0.18)", color: "var(--pill-slate)" };
  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-[1.4vh] h-full">
      <Card className="p-[1.6vh] flex flex-col">
        <h3 className="dx-radiant mb-[1vh] text-[1.8vh] font-bold text-[var(--dx-t1)]">Biggest ERP vs Physical gaps</h3>
        {frame.note && <p className="mb-[1vh] text-[1.4vh] text-[var(--dx-t3)]">{frame.note}</p>}
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
                <Tooltip content={<BoardTip />} cursor={{ fill: "var(--dx-track)" }} />
                <Bar dataKey="value" fill="url(#dg-hcyan)" radius={[0, 6, 6, 0]} barSize={16} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-full items-center justify-center text-center text-[1.6vh] text-[var(--dx-t4)]">
              {frame.error ? "Couldn't load the ERP comparison — close and tap the retry alert on the board"
                : s.reconciled ? "No gaps — ERP matches physical on every part in both"
                  : "No part has both an ERP figure and a count yet"}
            </div>
          )}
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
            {!rows.length && (
              <tr><td colSpan={6} className="py-[3vh] text-center text-[var(--dx-t4)] text-[1.6vh]">
                {frame.error ? "Couldn't load the ERP comparison" : "No part has an ERP figure or a count yet"}
              </td></tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

// GRN / Quality pending (ERP) — the rows behind the tile (fetched when the
// drill opens). Store-level: receiving is not per section. `frame.receipts`
// rows are ERP GRN lines (the work queue's quality list): waiting for the
// Maintenance / Tool Room quality clearance in ERP, or to be checked against
// ERP (spec 1/9 — read from ERP, never recorded in the app); without it (an
// older overview) they are the SRV register's lines.
function SrvListView({ frame }) {
  const rows = frame.rows || [];
  const rc = Boolean(frame.receipts);
  const unit = rc ? "ERP GRN line" : "line";
  const fresh = rc && frame.erp ? erpFreshness(frame.erp) : null;
  return (
    <div className="flex flex-col gap-[1.4vh] h-full">
      <Card className="p-[1.5vh] text-[1.55vh] font-medium text-[var(--dx-t2)] border-l-4" style={{ borderLeftColor: "#7c3aed" }}>
        {rc
          ? "ERP GRN lines of this store's parts waiting for the Maintenance / Tool Room quality clearance in ERP, or to be checked against ERP — read from ERP. Not store stock until ERP accepts them; the accepted qty is then added once, by itself."
          : "Material that has arrived and is waiting for an SRV to be raised or for an engineer's clearance — as recorded in this app's SRV register."}
        {fresh && (
          <span className="block mt-[0.5vh] text-[1.3vh]" style={{ color: fresh.stale ? "#d97706" : "var(--dx-t4)" }}>
            {fresh.text}{fresh.stale && fresh.staleText ? ` — ${fresh.staleText}` : ""}
          </span>
        )}
      </Card>
      <Card className="p-[1.6vh] overflow-auto flex-1">
        <h3 className="dx-radiant text-[1.8vh] font-bold text-[var(--dx-t1)] mb-[1vh]">
          {frame.loading ? `Loading pending ${unit}s…`
            : frame.error ? "GRN / Quality pending (ERP)" : `${rows.length} pending ${unit}${rows.length === 1 ? "" : "s"}`}
        </h3>
        {frame.loading ? <PanelState state="loading" h="30vh" /> : (
        <table className="w-full text-[1.45vh]">
          <thead>
            <tr className="text-left text-[1.2vh] uppercase tracking-wide text-[var(--dx-t4)] border-b border-[var(--dx-border)]">
              <th className="py-[0.7vh] pr-[1vh]">{rc ? "GRN No." : "SRV No."}</th><th className="pr-[1vh]">Part No.</th><th className="pr-[1vh]">Description</th>
              <th className="pr-[1vh]">Supplier</th><th className="pr-[1vh]">{rc ? "GRN Date" : "Gate Entry"}</th>
              <th className="pr-[1vh] text-center">{rc ? "Received" : "Qty"}</th><th className="pr-[1vh]">{rc ? "State (ERP)" : "Status"}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--dx-divide)]">
            {rows.map((r) => (
              <tr key={rc ? `${r.part_id}|${r.grn_no}` : r.id}>
                <td className="py-[0.8vh] pr-[1vh] font-bold text-[var(--dx-t1)]">{(rc ? r.grn_no : r.srv_no) || "—"}</td>
                <td className="pr-[1vh] font-semibold text-[var(--dx-t1)]">{r.part_no || "—"}</td>
                <td className="pr-[1vh] text-[var(--dx-t2)] truncate max-w-[22vh]">{r.part_name || "—"}</td>
                <td className="pr-[1vh] text-[var(--dx-t3)] truncate max-w-[18vh]">{(rc ? r.ven_name || r.ven_cd : r.supplier_name) || "—"}</td>
                <td className="pr-[1vh] text-[var(--dx-t3)] whitespace-nowrap">
                  {rc
                    ? (r.grn_date ? fmtPlantDay(r.grn_date) : "—")
                    : <>{r.gate_entry_no || "—"}{r.gate_entry_time ? ` · ${fmtPlantDay(r.gate_entry_time)}` : ""}</>}
                </td>
                <td className="pr-[1vh] text-center font-semibold">{fmtInt(rc ? r.receipt_qty : r.qty_received ?? r.qty_invoiced)}</td>
                <td className="pr-[1vh]">
                  <span className="rounded-full px-[1vh] py-[0.2vh] text-[1.2vh] font-bold whitespace-nowrap" style={{ background: "rgba(124,58,237,0.16)", color: "#8b5cf6" }}
                    title={rc ? r.reason || undefined : undefined}>
                    {rc ? erpLineMeta(r.state).label : String(r.status || "—").replace(/_/g, " ")}
                  </span>
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr><td colSpan={7} className="py-[3vh] text-center text-[var(--dx-t4)] text-[1.6vh]">
                {rc
                  ? (frame.error ? "Couldn't load the ERP GRN lines — close and tap the tile again"
                    : "Nothing pending — no ERP GRN line is waiting for quality clearance or a check")
                  : frame.error ? "Couldn't load the SRV list — close and tap the tile again"
                    : frame.untracked ? "No SRV has been recorded in this app for the store yet, so pending SRVs are not tracked here"
                      : "Nothing pending — no SRV line is waiting in the app's register"}
              </td></tr>
            )}
          </tbody>
        </table>
        )}
      </Card>
    </div>
  );
}

// tiny inline icons used in a couple of panel heads (kept local to avoid more imports)
function PieChartMini(props) {
  // The standard pie-chart glyph: a circle with one wedge lifted out. (The old
  // hand-drawn paths rendered as a broken "C".)
  return <svg viewBox="0 0 24 24" width={props.size || 20} height={props.size || 20} fill="none" stroke={props.style?.color || "currentColor"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21.21 15.89A10 10 0 1 1 8 2.83" /><path d="M22 12A10 10 0 0 0 12 2v10z" /></svg>;
}
function HeartMini(props) {
  return <svg viewBox="0 0 24 24" width={props.size || 20} height={props.size || 20} fill="none" stroke={props.style?.color || "currentColor"} strokeWidth="2"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z" /></svg>;
}
