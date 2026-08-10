import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import {
  AlertTriangle, TrendingUp, Boxes, Clock,
  Package, Layers, Globe, ArrowRight, ClipboardCheck, History, FileSpreadsheet, Wrench,
  Activity,
} from "lucide-react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Legend, LineChart, Line,
} from "recharts";
import Badge from "../components/Badge.jsx";
import CardHead from "../components/CardHead.jsx";
import DonutChart from "../components/DonutChart.jsx";
import HorizontalBars from "../components/HorizontalBars.jsx";
import KpiCard from "../components/KpiCard.jsx";
import Modal from "../components/Modal.jsx";
import RadialGauge from "../components/RadialGauge.jsx";
import { storeDashboardService } from "../services/storeDashboardService.js";
import { rackBinService } from "../services/rackBinService.js";
import { srvService } from "../services/srvService.js";
import { liveStockService } from "../services/liveStockService.js";
import { inventoryOverviewService } from "../services/inventoryOverviewService.js";
import { supplierVehicleService } from "../services/supplierVehicleService.js";
import { supplierWindowScheduleService } from "../services/supplierWindowScheduleService.js";
import { auditLogService } from "../services/auditLogService.js";
import { useStoreCategories } from "../constants/categories.js";

const CATEGORY_META = {
  "BOP": { icon: Layers, color: "#8b5cf6" },
  "Import": { icon: Globe, color: "#06b6d4" },
  "Maintenance/Tool Room": { icon: Wrench, color: "#f59e0b" },
  "Consumable": { icon: Package, color: "#14b8a6" },
  "In-Parts": { icon: Boxes, color: "#eb0a1e" },
};

const ALERT_BUCKETS = [
  { key: "fifo_warning", label: "FIFO Warning", icon: AlertTriangle, color: "text-rose-600 dark:text-rose-400" },
  { key: "holding_pending", label: "Holding Parts Pending", icon: Boxes, color: "text-amber-600 dark:text-amber-400" },
  { key: "long_pending_holding", label: "Long Pending Holding Parts", icon: Clock, color: "text-rose-600 dark:text-rose-400" },
];

const QUICK_ACCESS_DEFS = [
  { to: "/live-stock", label: "Live Stock", icon: Boxes, accent: "navy" },
  { to: "/short-parts", label: "Short Parts", icon: AlertTriangle, accent: "red" },
  { to: "/excess-parts", label: "Excess Parts", icon: TrendingUp, accent: "amber" },
  { to: "/quarterly-inventory", label: "Quarterly Inventory", icon: ClipboardCheck, accent: "navy" },
  { to: "/reports", label: "Reports", icon: FileSpreadsheet, accent: "navy" },
  { to: "/audit-trail", label: "Audit Trail", icon: History, accent: "navy" },
];

// Marquee travel speed. Slow enough to read a long part name as it passes;
// the duration is derived from this and the measured strip width.
const TICKER_PIXELS_PER_SECOND = 55;

const STOCK_STATUS_COLORS = {
  "Healthy": "#10b981", "Short": "#f43f5e", "Excess": "#f59e0b",
  "Dead Stock": "#64748b", "Unknown": "#94a3b8",
};

// Vehicle arrival outcomes, coloured along one axis of severity so the row
// can be read without reading the word:
//   green   On-Time         — came inside its window
//   amber   Pending Arrival — window still open, nothing wrong yet
//   orange  Late            — window closed, but it did turn up
//   red     Not Arrived     — window closed and nothing came at all
// Late and Not Arrived were one label until now, which hid the difference
// between a truck running behind and one that never left the supplier.
const ARRIVAL_COLORS = {
  "On-Time": "#10b981",
  "Pending Arrival": "#f59e0b",
  "Late": "#f97316",
  "Not Arrived": "#f43f5e",
};
const ARRIVAL_ORDER = ["On-Time", "Pending Arrival", "Late", "Not Arrived"];

// Coloured bullet + label. Reads faster than a pill at a glance from across
// the floor, which is where this screen lives.
function ArrivalStatus({ status }) {
  const color = ARRIVAL_COLORS[status] || "#94a3b8";
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span className="h-2 w-2 rounded-full shrink-0" style={{ background: color }} />
      <span className="text-slate-600 dark:text-slate-300">{status}</span>
    </span>
  );
}

// Clock time straight off the stamp, deliberately not converted to the
// browser's timezone. The planned window is a bare "08:30" printed as-is, and
// the server judges on-time/late against it in that same frame — converting
// only the arrival made a vehicle that came at 09:05 read as 02:35 PM beside
// an 08:30–10:00 window, so the row looked wrong while the status was right.
const fmtTime = (iso) => {
  if (!iso) return "—";
  const m = /T(\d{2}:\d{2})/.exec(iso);
  return m ? m[1] : "—";
};

// Dark navy gradient hero banner — top of the dashboard, matching the SQA
// Command Center reference: title + subtitle left, "Today"/date right.
function HeroBanner() {
  const dateStr = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  return (
    <div className="rounded-xl2 bg-gradient-to-br from-navy-800 via-navy-900 to-navy-950 text-white px-6 py-5 shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl md:text-2xl font-bold">Store Control Tower</h2>
          <p className="text-sm text-slate-300 mt-1">Part Store Operations · Toyota Boshoku Device India</p>
        </div>
        <p className="text-sm md:text-base font-semibold">{dateStr}</p>
      </div>
    </div>
  );
}

// Live status ticker — red "LIVE" pill + a single scrolling strip mixing
// per-part short-stock chips (clickable) with aggregate alert counts
// (excess/FIFO/holding), matching the reference's command-center ticker
// bar. All figures reuse data already fetched for the rest of the
// dashboard — nothing new is computed server-side for this.
//
// Every chip is actionable: a per-part one opens that part's detail modal,
// an aggregate count drills through to the screen that lists the parts
// behind the number ("15 excess part(s)" → the Excess Parts screen), so a
// count on the ticker is never a dead end.
function LiveStatusTicker({ shortRows, excessCount, excessAddedToday, excessVsYesterday, alerts, loading, onRowClick }) {
  const navigate = useNavigate();
  const boxRef = useRef(null);
  const copyRef = useRef(null);
  const [needsScroll, setNeedsScroll] = useState(false);
  const [trackWidth, setTrackWidth] = useState(0);

  const items = shortRows.map((row) => ({
    key: `short-${row.part_id}`,
    onClick: () => onRowClick(row),
    title: `View ${row.part_no} details`,
    icon: AlertTriangle,
    color: "text-rose-600 dark:text-rose-400",
    text: `${row.part_name} (${row.part_no}) — ${row.out_of_stock ? "Out of Stock" : `${row.cov_days} day(s)`}`,
  }));
  if (excessCount > 0) {
    items.push({
      key: "excess", icon: TrendingUp, color: "text-amber-600 dark:text-amber-400",
      text: `${excessCount} excess part(s)${excessSuffix(excessAddedToday, excessVsYesterday)}`,
      // #all-excess so the click lands on the full list, not the Top 10 card.
      onClick: () => navigate("/excess-parts#all-excess"), title: "View all excess parts",
    });
  }
  // The three alert buckets below are all Holding-Area conditions (FIFO risk
  // and rack-full both resolve by clearing that part's holding queue), so
  // they all drill through to the same screen.
  const fifo = alerts?.fifo_warning?.length || 0;
  if (fifo > 0) items.push({ key: "fifo", icon: AlertTriangle, color: "text-rose-600 dark:text-rose-400", text: `${fifo} FIFO warning(s)`, onClick: () => navigate("/holding-area"), title: "Open Holding Area" });
  const holding = alerts?.holding_pending?.length || 0;
  if (holding > 0) items.push({ key: "holding", icon: Boxes, color: "text-amber-600 dark:text-amber-400", text: `${holding} holding part(s) pending`, onClick: () => navigate("/holding-area"), title: "Open Holding Area" });
  const longHolding = alerts?.long_pending_holding?.length || 0;
  if (longHolding > 0) items.push({ key: "long-holding", icon: Clock, color: "text-rose-600 dark:text-rose-400", text: `${longHolding} long-pending holding part(s)`, onClick: () => navigate("/holding-area"), title: "Open Holding Area" });

  // Scroll when the strip is genuinely wider than the bar, measured rather
  // than guessed from the item count. Counting got this wrong in both
  // directions: two alerts with long part names overflow and used to sit
  // there clipped with no way to read the rest, while five short ones fit
  // fine and scrolled for no reason. Only the first copy is measured — the
  // second exists solely to make the loop seamless.
  const contentKey = items.map((it) => it.text).join("|");
  useLayoutEffect(() => {
    const box = boxRef.current;
    const copy = copyRef.current;
    if (!box || !copy) return undefined;
    const measure = () => {
      const width = copy.scrollWidth;
      setTrackWidth(width);
      setNeedsScroll(width > box.clientWidth + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    observer.observe(copy);
    return () => observer.disconnect();
  }, [contentKey, loading]);

  // Pace the marquee off how wide the strip actually is, so it always travels
  // at a readable speed. The old `items.length * 6` fixed a duration without
  // knowing the distance, so a dozen long part names had to cover several
  // times the width in barely more time and flew past.
  const duration = Math.max(Math.round(trackWidth / TICKER_PIXELS_PER_SECOND), 30);

  const renderChip = (it, idx, focusable) => {
    const Icon = it.icon;
    return (
      <div
        key={`${it.key}-${idx}`}
        onClick={it.onClick}
        role={it.onClick ? "button" : undefined}
        tabIndex={it.onClick && focusable ? 0 : undefined}
        onKeyDown={it.onClick ? (e) => e.key === "Enter" && it.onClick() : undefined}
        title={it.title}
        className={`inline-flex items-center gap-1.5 px-4 py-3 shrink-0 whitespace-nowrap text-sm font-medium ${it.color} ${it.onClick ? "cursor-pointer hover:opacity-70 hover:underline underline-offset-4" : ""}`}
      >
        <Icon size={14} />
        {it.text}
        <span className="text-slate-300 dark:text-navy-700 ml-3">|</span>
      </div>
    );
  };

  if (loading) return <div className="skeleton h-12 w-full rounded-xl2" />;

  return (
    <div className="rounded-xl2 bg-white dark:bg-navy-900 shadow-card overflow-hidden flex items-stretch">
      <div className="bg-toyotared text-white text-xs font-bold px-4 flex items-center gap-1.5 shrink-0">
        <span className="w-2 h-2 rounded-full bg-white animate-pulse" /> LIVE
      </div>
      <div ref={boxRef} className="overflow-hidden relative flex-1">
        {items.length === 0 ? (
          <p className="px-4 py-3.5 text-sm text-emerald-600 dark:text-emerald-400 font-medium">✅ All systems normal — no active alerts</p>
        ) : (
          <div
            className={`inline-flex h-full items-center ${needsScroll ? "ticker-track-x" : ""}`}
            style={needsScroll ? { "--ticker-duration": `${duration}s` } : undefined}
          >
            {/* Two equal copies — the keyframes translate the track by -50%,
                which is exactly one copy, so the loop has no visible seam. */}
            <div ref={copyRef} className="inline-flex h-full items-center">
              {items.map((it, idx) => renderChip(it, idx, true))}
            </div>
            {needsScroll && (
              <div className="inline-flex h-full items-center" aria-hidden="true">
                {items.map((it, idx) => renderChip(it, idx, false))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// A titled band of the dashboard. The page was previously one long run of
// cards with nothing saying where one concern ended and the next began; a
// heading plus real space between bands is what lets someone find the part
// they came for instead of scanning the whole page.
function Section({ title, hint, actions, children }) {
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <h3 className="section-title">{title}</h3>
          {hint && <p className="section-hint mt-0.5">{hint}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

// Small count pill for a section header — the size of the problem, readable
// before you start on the detail underneath. Muted on purpose: these sit next
// to headings all down the page, and a row of bright pills would compete with
// the alerts they are summarising.
const CHIP_TONES = {
  red: "bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-500/20",
  amber: "bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/20",
  slate: "bg-slate-100 text-slate-600 ring-slate-200 dark:bg-navy-800 dark:text-slate-300 dark:ring-navy-700",
};

function StatusChip({ label, value, tone = "slate", loading, onClick }) {
  if (loading) return <span className="skeleton h-6 w-24 rounded-full" />;
  const Tag = onClick ? "button" : "span";
  return (
    <Tag
      type={onClick ? "button" : undefined}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 ring-inset
        ${CHIP_TONES[tone]} ${onClick ? "hover:brightness-95 transition" : ""}`}
    >
      <span className="font-bold tabular">{value}</span>
      {label}
    </Tag>
  );
}

// Horizontal segmented distribution bar — matches the reference's
// "Supplier Tier Distribution" widget, reused here for Stock Status.
function StatDistributionBar({ title, data, colors, loading, viewDetailsTo }) {
  const total = data.reduce((sum, d) => sum + d.value, 0);
  return (
    <div className="card">
      <CardHead icon="📊" tone="violet" title={title} hint="Every active part, by how it is holding" />
      {loading ? (
        <div className="skeleton h-9 w-full" />
      ) : total === 0 ? (
        <p className="text-sm text-slate-400 text-center py-10">No data yet</p>
      ) : (
        <>
          <div className="flex w-full h-9 rounded-lg overflow-hidden">
            {data.filter((d) => d.value > 0).map((d) => (
              <div
                key={d.name}
                className="flex items-center justify-center text-white text-xs font-bold"
                style={{ width: `${(d.value / total) * 100}%`, backgroundColor: colors[d.name] || "#94a3b8" }}
                title={`${d.name}: ${d.value}`}
              >
                {(d.value / total) * 100 >= 6 ? d.value : ""}
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5 mt-3">
            {data.map((d) => (
              <div key={d.name} className="flex items-center gap-1.5 text-xs">
                <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: colors[d.name] || "#94a3b8" }} />
                <span className="text-slate-500 dark:text-slate-400">{d.name}</span>
                <span className="font-semibold text-slate-800 dark:text-white">{d.value}</span>
              </div>
            ))}
          </div>
        </>
      )}
      {viewDetailsTo && (
        <Link to={viewDetailsTo} className="text-xs font-medium text-toyotared flex items-center gap-1 mt-3 hover:underline">
          View Details <ArrowRight size={12} />
        </Link>
      )}
    </div>
  );
}

// Indian money at a glance. A KPI tile is read from across the room, and
// "67,089,371.6" is a string to decode; "6.71 Cr" is a quantity. The exact
// figure still goes in the hint underneath for anyone who needs it.
function formatINR(value) {
  if (value == null) return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`;
  if (Math.abs(n) >= 1e5) return `₹${(n / 1e5).toFixed(2)} L`;
  return `₹${Math.round(n).toLocaleString("en-IN")}`;
}

function NoDataNote({ text = "No data available yet" }) {
  return <span className="text-[11px] text-slate-400 italic">{text}</span>;
}

// Same delta VsYesterday renders on the KPI cards, flattened to plain text so
// it fits the ticker's single nowrap line. Empty until a prior day's snapshot
// exists — the ticker has no room for a "No prior data yet" placeholder.
function vsYesterdaySuffix(delta) {
  if (delta == null) return "";
  if (delta === 0) return " · No change vs yesterday";
  return ` · ${delta > 0 ? "+" : "-"}${Math.abs(delta)} vs yesterday`;
}

// What follows the excess count on the ticker. "Added today" is membership —
// which parts joined the list — and wins whenever there are any, because it's
// the fact worth acting on. The vs-yesterday delta is only a count difference
// and would read "No change" on a day where 3 parts dropped off and 3 new ones
// joined, so it's the fallback for days with no new entries.
function excessSuffix(addedToday, delta) {
  if (addedToday > 0) return ` · +${addedToday} added today`;
  return vsYesterdaySuffix(delta);
}

// Risk-Matrix-style panel — each row is a monitored signal with its raw
// count and a severity chip.
function severityFor(count) {
  if (count === 0) return { label: "Low", cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400" };
  if (count <= 2) return { label: "Medium", cls: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400" };
  return { label: "High", cls: "bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-400" };
}

function RiskMatrixPanel({ alerts, lastSync, loading }) {
  return (
    <div className="card">
      <CardHead icon="⚠️" tone="red" title="Risk Matrix" hint="Open exceptions and how stale the ERP feed is" />
      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => <div key={i} className="skeleton h-8 w-full" />)}
        </div>
      ) : (
        <div className="space-y-2.5">
          {ALERT_BUCKETS.map((def) => {
            const count = alerts?.[def.key]?.length || 0;
            const sev = severityFor(count);
            return (
              <div key={def.key} className="flex items-center justify-between text-sm">
                <span className="text-slate-600 dark:text-slate-300 truncate">{def.label} · {count}</span>
                <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full shrink-0 ${sev.cls}`}>{sev.label}</span>
              </div>
            );
          })}
          <div className="flex items-center justify-between text-sm pt-2 border-t border-slate-100 dark:border-navy-800">
            <span className="text-slate-600 dark:text-slate-300">Last ERP Sync</span>
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
              {lastSync ? new Date(lastSync).toLocaleString() : "Not synced yet"}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function InventoryTrendChart({ rows, loading }) {
  return (
    <div className="card">
      <CardHead icon="📈" tone="blue" title="Inventory Trend" hint="Total vs short parts, last 7 days" />
      {loading ? (
        <div className="skeleton h-64 w-full" />
      ) : rows.length === 0 ? (
        <p className="text-sm text-slate-400 text-center py-20">No trend data yet — check back tomorrow.</p>
      ) : (
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={rows} margin={{ top: 10, right: 10, left: 0, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="date" tick={{ fontSize: 11 }} />
            <YAxis allowDecimals={false} />
            <Tooltip />
            <Legend />
            <Line type="monotone" dataKey="total_parts" name="Total Parts" stroke="#3b82f6" strokeWidth={2} dot={{ r: 3 }} />
            <Line type="monotone" dataKey="short_parts" name="Short Parts" stroke="#f43f5e" strokeWidth={2} dot={{ r: 3 }} />
            <Line type="monotone" dataKey="excess_parts" name="Excess Parts" stroke="#f59e0b" strokeWidth={2} dot={{ r: 3 }} />
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

function ReceiptTrendChart({ rows, loading, days }) {
  return (
    <div className="card">
      <CardHead
        icon="📥" tone="green" title="Receipt vs Issue"
        hint="Issue side isn't fed by ERP here yet"
        action={<span className="text-[11px] text-slate-400">Last {days} Days</span>}
      />
      {loading ? (
        <div className="skeleton h-56 w-full" />
      ) : rows.length === 0 ? (
        <p className="text-sm text-slate-400 text-center py-16">No receiving activity recorded in this window yet.</p>
      ) : (
        <ResponsiveContainer width="100%" height={230}>
          <BarChart data={rows} margin={{ top: 10, right: 10, left: 0, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="day" tick={{ fontSize: 11 }} />
            <YAxis allowDecimals={false} />
            <Tooltip />
            <Bar dataKey="count" name="Lines Received" fill="#1a2b4c" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

function QuickActionsCard() {
  return (
    <div className="card">
      <CardHead icon="⚡" tone="amber" title="Quick Actions" hint="The screens this store opens most" />
      {/* Laid out across the width rather than as a tall stack: this card now
          closes the page as its own band, where a single column of six links
          would leave most of the row empty. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-2">
        {QUICK_ACCESS_DEFS.map((q) => {
          const Icon = q.icon;
          return (
            <Link
              key={q.to}
              to={q.to}
              className="flex items-center gap-2.5 rounded-lg border border-slate-200 dark:border-navy-800 px-3 py-2.5 text-sm font-medium text-slate-700 dark:text-slate-200 hover:border-toyotared hover:text-toyotared transition-colors"
            >
              <Icon size={16} />
              <span className="flex-1 truncate">{q.label}</span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

const STATUS_LEVEL_META = {
  green: { bg: "bg-emerald-50 dark:bg-emerald-500/10", border: "border-emerald-500", text: "text-emerald-700 dark:text-emerald-400", label: "Normal" },
  amber: { bg: "bg-amber-50 dark:bg-amber-500/10", border: "border-amber-500", text: "text-amber-700 dark:text-amber-400", label: "Attention Needed" },
  red: { bg: "bg-rose-50 dark:bg-rose-500/10", border: "border-rose-500", text: "text-rose-700 dark:text-rose-400", label: "Critical" },
};

// Production Status executive card — Green/Amber/Red banner derived from
// the live Short Parts count (COVService.is_short), plus Most Affected Supplier/Category
// computed by joining the short-parts list against the part-wise summary
// (client-side join across two existing endpoints, no new API).
// One "Most Affected X" tile. Inert when there is nothing to drill into, so
// an em dash never looks like a dead button.
function AffectedTile({ label, top, onOpen }) {
  const clickable = Boolean(top);
  return (
    <div
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? () => onOpen(top[0]) : undefined}
      onKeyDown={clickable ? (e) => e.key === "Enter" && onOpen(top[0]) : undefined}
      title={clickable ? `Show short parts for ${top[0]}` : undefined}
      className={clickable ? "cursor-pointer group" : undefined}
    >
      <p className="text-slate-400 text-xs">{label}</p>
      <p className={`font-semibold text-slate-800 dark:text-white ${clickable ? "group-hover:text-toyotared group-hover:underline underline-offset-4 transition-colors" : ""}`}>
        {top ? `${top[0]} (${top[1]})` : "—"}
      </p>
    </div>
  );
}

function ProductionStatusCard({ shortRows, partInfoMap, loading }) {
  const navigate = useNavigate();
  if (loading) {
    return <div className="card"><div className="skeleton h-20 w-full" /></div>;
  }
  const count = shortRows.length;
  const level = count === 0 ? "green" : count <= 3 ? "amber" : "red";
  const meta = STATUS_LEVEL_META[level];

  const supplierCounts = {};
  const categoryCounts = {};
  shortRows.forEach((r) => {
    const info = partInfoMap.get(r.part_id);
    if (info?.supplier_name) supplierCounts[info.supplier_name] = (supplierCounts[info.supplier_name] || 0) + 1;
    if (info?.category) categoryCounts[info.category] = (categoryCounts[info.category] || 0) + 1;
  });
  const topOf = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1])[0];
  const topSupplier = topOf(supplierCounts);
  const topCategory = topOf(categoryCounts);

  return (
    <div className={`card border-l-4 ${meta.border} ${meta.bg}`}>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className={`text-xs font-bold uppercase tracking-wide ${meta.text}`}>Production Status — {meta.label}</p>
          <p className="text-2xl font-bold text-slate-800 dark:text-white mt-1">
            {count} Short Part{count === 1 ? "" : "s"} <span className="text-sm font-normal text-slate-400">(under 1 day cover or out of stock)</span>
          </p>
        </div>
        {/* Both drill through to the Short Parts screen — someone asking
            "which parts are short?" wants that list, SOB grouping and all,
            not the full Live Stock table filtered down to it. */}
        <div className="flex gap-6 text-sm">
          <AffectedTile
            label="Most Affected Supplier"
            top={topSupplier}
            onOpen={(name) => navigate(`/short-parts?supplier=${encodeURIComponent(name)}`)}
          />
          <AffectedTile
            label="Most Affected Category"
            top={topCategory}
            onOpen={(name) => navigate(`/short-parts?category=${encodeURIComponent(name)}`)}
          />
        </div>
      </div>
    </div>
  );
}

// Category Wise Stock — one card per category with Total/Healthy/Short/Excess.
// The Short/Excess rows are independently clickable, jumping straight to
// Live Stock pre-filtered by both category AND status (e.g. Import + Short)
// — the whole-card click still goes to just the category filter.
function CategoryStockCard({ category, total, short, excess, onClick, onFilterClick }) {
  const meta = CATEGORY_META[category] || {};
  const Icon = meta.icon || Layers;
  const healthy = Math.max(total - short - excess, 0);
  return (
    <div
      onClick={onClick}
      role="button" tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && onClick()}
      className="card cursor-pointer hover:-translate-y-0.5 transition-transform"
    >
      <div className="flex items-center gap-2 mb-3">
        <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0" style={{ backgroundColor: `${meta.color}1a`, color: meta.color }}>
          <Icon size={18} />
        </div>
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide truncate" style={{ color: meta.color }}>{category}</p>
          <p className="text-lg font-bold text-slate-800 dark:text-white">{total}</p>
        </div>
      </div>
      <div className="space-y-1 text-xs">
        <div className="flex justify-between"><span className="text-slate-400">Healthy</span><span className="font-medium text-emerald-600 dark:text-emerald-400">{healthy}</span></div>
        <div
          className="flex justify-between rounded px-1 -mx-1 hover:bg-rose-50 dark:hover:bg-rose-500/10"
          onClick={(e) => { e.stopPropagation(); onFilterClick("Short"); }}
        >
          <span className="text-slate-400">Short</span><span className="font-medium text-rose-600 dark:text-rose-400">{short}</span>
        </div>
        <div
          className="flex justify-between rounded px-1 -mx-1 hover:bg-amber-50 dark:hover:bg-amber-500/10"
          onClick={(e) => { e.stopPropagation(); onFilterClick("Excess"); }}
        >
          <span className="text-slate-400">Excess</span><span className="font-medium text-amber-600 dark:text-amber-400">{excess}</span>
        </div>
      </div>
    </div>
  );
}

// Rack Utilization panel — real occupancy status counts (Empty/Partial/
// Full/Blocked) computed from Rack/Bin Master, plus the fill-rate % when
// available (null when no rack has any bins_allocated yet — an honest gap,
// not a fabricated number).
function RackUtilizationPanel({ pct, rows, loading }) {
  const statusCounts = rows.reduce((acc, r) => {
    acc[r.rack_status] = (acc[r.rack_status] || 0) + 1;
    return acc;
  }, {});
  const ORDER = ["Empty", "Partial", "Full", "Blocked"];
  const COLORS = { Empty: "text-slate-400", Partial: "text-amber-600 dark:text-amber-400", Full: "text-emerald-600 dark:text-emerald-400", Blocked: "text-rose-600 dark:text-rose-400" };

  // Fill rate per storage zone (A1, MEZZANINE, PRESS SHOP AREA…). One number
  // for the whole store hides the case that matters — a plant is rarely full
  // everywhere at once, it is full in one aisle while another sits empty.
  const zones = [];
  const byLocation = new Map();
  rows.forEach((r) => {
    const key = r.location || "Unassigned";
    if (!byLocation.has(key)) {
      const zone = { name: key, racks: 0, allocated: 0, occupied: 0, blocked: 0 };
      byLocation.set(key, zone);
      zones.push(zone);
    }
    const zone = byLocation.get(key);
    zone.racks += 1;
    zone.allocated += r.bins_allocated || 0;
    zone.occupied += r.bins_occupied || 0;
    if (r.is_blocked) zone.blocked += 1;
  });
  zones.sort((a, b) => b.racks - a.racks);
  const anyAllocated = zones.some((z) => z.allocated > 0);

  // Heat scale. Empty is deliberately near-invisible: the eye should be pulled
  // to the aisles that are filling up, not to the ones with room.
  const heatFor = (zone) => {
    if (zone.blocked === zone.racks && zone.racks > 0) return "bg-rose-500/70 text-white";
    if (!zone.allocated) return "bg-slate-100 dark:bg-navy-800 text-slate-400";
    const fill = (zone.occupied / zone.allocated) * 100;
    if (fill >= 90) return "bg-rose-500 text-white";
    if (fill >= 70) return "bg-amber-400 text-amber-950";
    if (fill >= 40) return "bg-emerald-400 text-emerald-950";
    return "bg-emerald-100 dark:bg-emerald-500/20 text-emerald-800 dark:text-emerald-300";
  };

  return (
    <div className="card">
      <CardHead icon="🗃️" tone="navy" title="Rack Utilization" hint="Average bin fill rate across allocated racks" />
      {loading ? (
        <div className="skeleton h-40 w-full mt-3" />
      ) : (
        <>
          <div className="flex items-center gap-4">
            <RadialGauge value={pct} size={112} label="fill rate" emptyNote="Fill rate not available yet — no rack has bins allocated." />
            <div className="min-w-0 flex-1 space-y-1.5">
              {ORDER.map((s) => (
                <div key={s} className="flex items-center justify-between text-sm">
                  <span className="text-slate-500 dark:text-slate-400">{s}</span>
                  <span className={`font-semibold tabular ${COLORS[s]}`}>{statusCounts[s] || 0}</span>
                </div>
              ))}
            </div>
          </div>

          {zones.length > 0 && (
            <div className="mt-4 pt-3 border-t border-slate-100 dark:border-navy-800">
              <p className="text-[11px] text-slate-400 mb-2">
                By storage zone {anyAllocated ? "— shaded by fill rate" : "— rack count only, nothing allocated yet"}
              </p>
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-1.5">
                {zones.map((z) => {
                  const fill = z.allocated ? Math.round((z.occupied / z.allocated) * 100) : null;
                  return (
                    <div
                      key={z.name}
                      title={`${z.name} — ${z.racks} rack(s)${fill == null ? ", no bins allocated" : `, ${fill}% full`}`}
                      className={`rounded-md px-1.5 py-1.5 text-center ${heatFor(z)}`}
                    >
                      <p className="text-[9px] font-semibold uppercase tracking-wide truncate leading-tight">{z.name}</p>
                      <p className="text-xs font-bold tabular leading-tight mt-0.5">
                        {fill == null ? z.racks : `${fill}%`}
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Generic Top Parts table — used for both Top Short Parts and Top Excess
// Parts, both sourced from the existing /live-stock endpoint (already
// carries rack_no/supplier_name, unlike the dedicated short/excess routes).
function TopPartsTable({ title, rows, loading, columns, emptyMessage, onRowClick, icon, tone, hint }) {
  return (
    <div className="card">
      <CardHead icon={icon} tone={tone} title={title} hint={hint} />
      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => <div key={i} className="skeleton h-8 w-full" />)}
        </div>
      ) : rows.length === 0 ? (
        <p className="text-sm text-slate-400 text-center py-10">{emptyMessage}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-slate-400">
              <tr>
                {columns.map((c) => <th key={c.key} className="text-left font-semibold px-2 py-2">{c.label}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-navy-800">
              {rows.map((r) => (
                <tr
                  key={r.part_id}
                  onClick={onRowClick ? () => onRowClick(r) : undefined}
                  className={onRowClick ? "cursor-pointer hover:bg-slate-50 dark:hover:bg-navy-800 transition-colors" : undefined}
                >
                  {columns.map((c) => (
                    <td key={c.key} className="px-2 py-2 whitespace-nowrap">{c.render ? c.render(r) : (r[c.key] ?? "—")}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Store Activities — Today's Receipt/Verification/Rack Allocation/Issue are
// real (already tracked KPIs); Adjustment/Returns/Cycle Count have no data
// source yet in this app, shown as honest no-data rows instead of zeros.
function StoreActivitiesCard({ summary, loading }) {
  const REAL = [
    { label: "Today's Receipt", value: summary?.todays_srv },
    { label: "Today's Verification", value: summary?.todays_verification },
    { label: "Today's Rack Allocation", value: summary?.todays_put_away },
    { label: "Today's Issue", value: summary?.todays_issue },
  ];
  const NO_DATA = ["Stock Adjustment", "Returns", "Cycle Count"];
  return (
    <div className="card">
      <CardHead icon="📋" tone="blue" title="Store Activities — Today" hint="What has moved through the store since midnight" />
      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => <div key={i} className="skeleton h-6 w-full" />)}
        </div>
      ) : (
        <div className="space-y-2 text-sm">
          {REAL.map((r) => (
            <div key={r.label} className="flex items-center justify-between">
              <span className="text-slate-500 dark:text-slate-400">{r.label}</span>
              <span className="font-semibold text-slate-800 dark:text-white">{r.value ?? 0}</span>
            </div>
          ))}
          {NO_DATA.map((label) => (
            <div key={label} className="flex items-center justify-between">
              <span className="text-slate-500 dark:text-slate-400">{label}</span>
              <NoDataNote />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Supplier Performance — sourced from Supplier Vehicle Management's arrival
// tracking (On-Time / Pending Arrival / Late / Not Arrived).
function SupplierPerformanceCard({ rows, loading }) {
  const statusCounts = rows.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});
  // Both failures count against a supplier: turning up late and not turning up
  // at all are the two ways it let the line down, and ranking on only one of
  // them would let the worse offender sit below the merely tardy one.
  const missedBySupplier = {};
  rows.filter((r) => r.status === "Late" || r.status === "Not Arrived").forEach((r) => {
    const name = r.supplier_name || r.vendor_code;
    missedBySupplier[name] = (missedBySupplier[name] || 0) + 1;
  });
  const topLate = Object.entries(missedBySupplier).sort((a, b) => b[1] - a[1]).slice(0, 3);

  return (
    <div className="card">
      <CardHead icon="🚛" tone="green" title="Supplier Performance" hint="How today's vehicles landed against their windows" />
      {loading ? (
        <div className="skeleton h-32 w-full" />
      ) : rows.length === 0 ? (
        <p className="text-sm text-slate-400 text-center py-10">No supplier vehicle windows recorded yet.</p>
      ) : (
        <>
          {/* Pending Arrival is in the ring rather than left out: on a day
              whose vehicles have not landed yet, zeros said nothing, while
              "8 still awaited" is the actual position. */}
          <DonutChart
            data={ARRIVAL_ORDER.map((s) => ({ name: s, value: statusCounts[s] || 0 }))}
            colors={ARRIVAL_COLORS}
            size={116}
            emptyMessage="No arrivals recorded against a window yet"
          />
          {topLate.length > 0 && (
            <div className="mt-4 pt-3 border-t border-slate-100 dark:border-navy-800">
              <p className="text-[11px] text-slate-400 mb-2">Most Missed Windows</p>
              <HorizontalBars
                data={topLate.map(([name, value]) => ({ name, value }))}
                color={ARRIVAL_COLORS["Not Arrived"]}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Today's Vehicle Status — fully API-driven: the standard recurring
// Window Schedule (real, entered once) matched against today's actual
// ERP-pushed gate-entry arrivals — zero manual per-day/per-vehicle entry
// needed, unlike the old version of this table which depended on someone
// creating a SupplierVehicleWindow row for today by hand. Milkrun-grouped
// suppliers already collapse into one row server-side.
function VehicleStatusTable({ rows, loading }) {
  return (
    <div className="card">
      <CardHead
        icon="🚚" tone="blue" title="Today's Vehicle Status"
        hint="Planned window against the real ERP gate in/out times"
        action={
          <Link to="/supplier-vehicles" className="text-xs font-medium text-toyotared hover:underline">
            View Schedule
          </Link>
        }
      />
      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => <div key={i} className="skeleton h-8 w-full" />)}
        </div>
      ) : rows.length === 0 ? (
        <p className="text-sm text-slate-400 text-center py-10">No suppliers scheduled for today.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-slate-400">
              <tr>
                <th className="text-left font-semibold px-2 py-2">Supplier</th>
                <th className="text-left font-semibold px-2 py-2">Planned Window</th>
                <th className="text-left font-semibold px-2 py-2">Vehicle</th>
                <th className="text-left font-semibold px-2 py-2">In Time</th>
                <th className="text-left font-semibold px-2 py-2">Out Time</th>
                <th className="text-left font-semibold px-2 py-2">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-navy-800">
              {rows.map((r) => (
                <tr key={`${r.vendor_code}-${r.window_start}`}>
                  <td className="px-2 py-2 whitespace-nowrap">
                    {r.supplier_name}
                    {r.milkrun_group && <span className="ml-1.5 text-[10px] text-blue-600 dark:text-blue-400">(Milkrun)</span>}
                  </td>
                  <td className="px-2 py-2 whitespace-nowrap tabular">{r.window_start.slice(0, 5)} – {r.window_end.slice(0, 5)}</td>
                  <td className="px-2 py-2 whitespace-nowrap">{r.actual_vehicle_no || "—"}</td>
                  <td className="px-2 py-2 whitespace-nowrap tabular">{fmtTime(r.actual_arrival)}</td>
                  <td className="px-2 py-2 whitespace-nowrap tabular">{fmtTime(r.actual_out)}</td>
                  <td className="px-2 py-2 whitespace-nowrap"><ArrivalStatus status={r.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Total vehicles today = standard Window Schedule rows (always have a fixed
// window) + today's ad-hoc Supplier Vehicle Management entries, split by
// whether a Decided Window was given. The no-window ones are listed
// separately below the count strip since VehicleStatusTable above only
// covers the schedule-driven half.
function TodaysVehiclesSummary({ scheduledRows, adhocRows, loading }) {
  const today = todayISO();
  const todaysAdhoc = adhocRows.filter((r) => r.expected_date === today);
  const adhocWithWindow = todaysAdhoc.filter((r) => r.has_window);
  const adhocNoWindow = todaysAdhoc.filter((r) => !r.has_window);
  const windowFixedCount = scheduledRows.length + adhocWithWindow.length;
  const noWindowCount = adhocNoWindow.length;
  const total = windowFixedCount + noWindowCount;

  return (
    <div className="card">
      <CardHead
        icon="🚛" tone="amber" title="Today's Vehicles"
        hint="Standard schedule plus today's ad-hoc entries"
        action={
          <Link to="/supplier-vehicles" className="text-xs font-medium text-toyotared hover:underline">
            Manage Ad-hoc Entries
          </Link>
        }
      />
      {loading ? (
        <div className="skeleton h-16 w-full" />
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3 mb-4">
            <div className="text-center">
              <p className="text-2xl font-bold text-slate-800 dark:text-white">{total}</p>
              <p className="text-[11px] text-slate-400">Total Vehicles</p>
            </div>
            <div className="text-center">
              <p className="text-2xl font-bold text-slate-800 dark:text-white">{windowFixedCount}</p>
              <p className="text-[11px] text-slate-400">Window Time Fixed</p>
            </div>
            <div className="text-center">
              <p className="text-2xl font-bold text-slate-800 dark:text-white">{noWindowCount}</p>
              <p className="text-[11px] text-slate-400">No Window Decided</p>
            </div>
          </div>
          {adhocNoWindow.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-slate-400">
                  <tr>
                    <th className="text-left font-semibold px-2 py-2">Supplier</th>
                    <th className="text-left font-semibold px-2 py-2">Vehicle No</th>
                    <th className="text-left font-semibold px-2 py-2">Actual Arrival</th>
                    <th className="text-left font-semibold px-2 py-2">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-navy-800">
                  {adhocNoWindow.map((r) => (
                    <tr key={r.id}>
                      <td className="px-2 py-2 whitespace-nowrap">{r.supplier_name}</td>
                      <td className="px-2 py-2 whitespace-nowrap">{r.vehicle_no}</td>
                      <td className="px-2 py-2 whitespace-nowrap">
                        {r.actual_arrival ? new Date(r.actual_arrival).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"}
                      </td>
                      <td className="px-2 py-2 whitespace-nowrap"><Badge status={r.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

const AUDIT_ACTION_LABELS = {
  RACK_CHANGE: "Rack Updated", HOLDING_TRANSFER: "Holding → Rack Transfer", FIFO_WARNING: "FIFO Warning",
  QC_APPROVED: "QC Approved", QC_REJECTED: "QC Rejected", STOCK_SYNC: "Stock Synced",
};

// Live Activity feed — reuses the Audit Trail API.
function LiveActivityFeed({ rows, loading }) {
  return (
    <div className="card">
      <CardHead icon="🕘" tone="violet" title="Live Activity" hint="Latest entries from the audit trail" />
      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => <div key={i} className="skeleton h-8 w-full" />)}
        </div>
      ) : rows.length === 0 ? (
        <p className="text-sm text-slate-400 text-center py-10">No recent activity recorded yet.</p>
      ) : (
        <div className="space-y-2.5 max-h-64 overflow-y-auto">
          {rows.map((r) => (
            <div key={r.id} className="flex items-start gap-2 text-xs border-b border-slate-100 dark:border-navy-800 pb-2 last:border-0">
              <Activity size={13} className="text-toyotared shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1">
                <p className="font-medium text-slate-700 dark:text-slate-200">
                  {AUDIT_ACTION_LABELS[r.action] || r.action} <span className="text-slate-400 font-normal">· {r.entity_type}{r.entity_id ? `#${r.entity_id}` : ""}</span>
                </p>
                {r.remarks && <p className="text-slate-400 truncate">{r.remarks}</p>}
              </div>
              <span className="text-slate-400 shrink-0">{new Date(r.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DetailRow({ label, value }) {
  return (
    <div className="flex justify-between py-1.5 text-sm border-b border-slate-100 dark:border-navy-800 last:border-0">
      <span className="text-slate-500">{label}</span>
      <span className="font-medium text-slate-800 dark:text-white">{value ?? "—"}</span>
    </div>
  );
}

// Detail-modal formatters — all return null for a missing value so DetailRow's
// own "—" fallback is the single place an empty field is rendered.
const detailNum = (v) => (v == null ? null : Number(v).toLocaleString());
const detailMoney = (v) => (v == null ? null : `₹${Number(v).toLocaleString()}`);
const detailDateTime = (v) => (v ? new Date(v).toLocaleString() : null);

// Part.part_type is the Material Routing target — the raw code alone doesn't
// say much on screen, so pair it with what it actually routes to.
const PART_TYPE_LABELS = {
  DOL: "DOL — direct to Store Location",
  OTHER: "OTHER — RQC Inspection (BOP)",
  TOOL_ROOM: "TOOL_ROOM — Maintenance",
};

function PendingSrvModal({ open, data, onClose }) {
  const rows = data?.rows || [];
  return (
    <Modal open={open} onClose={onClose} title="Pending SRV — Arrived, Not Yet SRV-Created" size="xl">
      {rows.length === 0 ? (
        <p className="text-sm text-slate-400 text-center py-10">No pending SRV lines right now.</p>
      ) : (
        <div className="rounded-lg border border-slate-200 dark:border-navy-800 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 dark:bg-navy-800 text-slate-500">
              <tr>
                <th className="text-left px-3 py-2">Supplier</th>
                <th className="text-left px-3 py-2">Part No</th>
                <th className="text-left px-3 py-2">Part Name</th>
                <th className="text-left px-3 py-2">Vehicle No</th>
                <th className="text-left px-3 py-2">Status</th>
                <th className="text-left px-3 py-2">Date</th>
                <th className="text-left px-3 py-2">Time</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-navy-800">
              {rows.map((r) => {
                const dt = r.gate_entry_time ? new Date(r.gate_entry_time) : null;
                return (
                  <tr key={r.srv_id}>
                    <td className="px-3 py-2">{r.supplier_name}</td>
                    <td className="px-3 py-2">{r.part_no}</td>
                    <td className="px-3 py-2">{r.part_name}</td>
                    <td className="px-3 py-2">{r.vehicle_no || "—"}</td>
                    <td className="px-3 py-2"><Badge status={r.status} /></td>
                    <td className="px-3 py-2">{dt ? dt.toLocaleDateString() : "—"}</td>
                    <td className="px-3 py-2">{dt ? dt.toLocaleTimeString() : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

function TodaysReceiptsModal({ open, rows, onClose }) {
  return (
    <Modal open={open} onClose={onClose} title="Today's Receipt — Store Receipt Vouchers" size="xl">
      {rows.length === 0 ? (
        <p className="text-sm text-slate-400 text-center py-10">No SRVs received today yet.</p>
      ) : (
        <div className="rounded-lg border border-slate-200 dark:border-navy-800 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 dark:bg-navy-800 text-slate-500">
              <tr>
                <th className="text-left px-3 py-2">SRV No</th>
                <th className="text-left px-3 py-2">Vendor</th>
                <th className="text-left px-3 py-2">Part No</th>
                <th className="text-left px-3 py-2">Part Name</th>
                <th className="text-left px-3 py-2">Qty Received</th>
                <th className="text-left px-3 py-2">Status</th>
                <th className="text-left px-3 py-2">Time</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-navy-800">
              {rows.map((r) => (
                <tr key={r.srv_id}>
                  <td className="px-3 py-2">{r.srv_no || "—"}</td>
                  <td className="px-3 py-2">{r.vendor_code}</td>
                  <td className="px-3 py-2">{r.part_no}</td>
                  <td className="px-3 py-2">{r.part_name}</td>
                  <td className="px-3 py-2 font-medium">{r.qty_received ?? "—"}</td>
                  <td className="px-3 py-2"><Badge status={r.status} /></td>
                  <td className="px-3 py-2">{new Date(r.time).toLocaleTimeString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

function TodaysIssuesModal({ open, rows, onClose }) {
  return (
    <Modal open={open} onClose={onClose} title="Today's Issue — Production Consumption" size="xl">
      {rows.length === 0 ? (
        <p className="text-sm text-slate-400 text-center py-10">No production consumption confirmed by ERP yet today.</p>
      ) : (
        <div className="rounded-lg border border-slate-200 dark:border-navy-800 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 dark:bg-navy-800 text-slate-500">
              <tr>
                <th className="text-left px-3 py-2">Part No</th>
                <th className="text-left px-3 py-2">Part Name</th>
                <th className="text-left px-3 py-2">Qty Issued</th>
                <th className="text-left px-3 py-2">Time</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-navy-800">
              {rows.map((r, i) => (
                <tr key={i}>
                  <td className="px-3 py-2">{r.part_no}</td>
                  <td className="px-3 py-2">{r.part_name}</td>
                  <td className="px-3 py-2 font-medium">{r.qty}</td>
                  <td className="px-3 py-2">{new Date(r.time).toLocaleTimeString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

// "2026-07" -> "Jul 2026" for the month-wise Source Breakdown table.
function formatMonth(ym) {
  const [y, m] = (ym || "").split("-");
  const idx = Number(m) - 1;
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return idx >= 0 && idx < 12 ? `${MONTHS[idx]} ${y}` : ym;
}

function PartDetailModal({ part, sob, onClose }) {
  const [rackBins, setRackBins] = useState([]);
  const [srvs, setSrvs] = useState([]);
  const [consumption, setConsumption] = useState([]);
  const [sourceMonthly, setSourceMonthly] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!part) return;
    setLoading(true);
    Promise.all([
      rackBinService.list(),
      srvService.list({ part_id: part.part_id, per_page: 10 }),
      storeDashboardService.partConsumptionHistory(part.part_id),
      storeDashboardService.partSourceBreakdownMonthly(part.part_id),
    ])
      .then(([rb, srv, consumed, srcMonthly]) => {
        setRackBins(rb.data.data.filter((r) => r.part_no === part.part_no));
        setSrvs(srv.data.data);
        setConsumption(consumed.data.data);
        setSourceMonthly(srcMonthly.data.data);
      })
      .catch(() => {
        /* handled globally */
      })
      .finally(() => setLoading(false));
  }, [part]);

  return (
    <Modal open={!!part} onClose={onClose} title={part ? `${part.part_no} — ${part.part_name}` : ""} size="xl">
      {part && (
        <div className="space-y-5">
          <div>
            <h4 className="text-xs font-semibold uppercase text-slate-400 mb-2">Live Stock & COV</h4>
            <div className="grid grid-cols-2 gap-x-6">
              {part.has_ledger_stock && (
                <>
                  <DetailRow label="Receiving Store" value={detailNum(part.receiving_store_qty)} />
                  <DetailRow label="Part Store" value={detailNum(part.part_store_qty)} />
                </>
              )}
              <DetailRow label="Total Stock" value={detailNum(part.total_qty)} />
              <DetailRow label="Stock Value" value={detailMoney(part.total_value)} />
              <DetailRow label="COV Days" value={part.cov_days} />
              <DetailRow label="Daily Consumption" value={detailNum(part.daily_consumption)} />
              <DetailRow label="Target COV Min (Days)" value={detailNum(part.target_cov_days_min)} />
              <DetailRow label="Target COV Max (Days)" value={detailNum(part.target_cov_days_max)} />
              <DetailRow label="Min / Max Stock" value={`${detailNum(part.min_stock_level) ?? "—"} / ${detailNum(part.max_stock_level) ?? "—"}`} />
              <DetailRow label="Indication" value={<Badge status={part.indicator} />} />
              <DetailRow label="Short Since" value={detailDateTime(part.short_since)} />
              <DetailRow label="Excess Since" value={detailDateTime(part.excess_since)} />
            </div>
            <p className="text-[11px] text-slate-400 mt-2">
              {part.has_ledger_stock
                ? "Total Stock is the latest Daily Stock Count; the Receiving/Part Store split above comes from SRV movements."
                : "Total Stock is the latest Daily Stock Count — this part hasn't moved through an SRV yet, so there is no Receiving/Part Store split to show."}{" "}
              COV Days = that stock ÷ Daily Consumption, so it stays blank until both are set. Target COV Max falling
              back to 5 days when blank is what Excess is judged against.
            </p>
          </div>

          {/* Same part, other suppliers. Sits directly under the stock figures
              because it is the first thing worth knowing when a part reads
              short — the stock is often already in the building under another
              supplier's part number. */}
          {sob?.siblings?.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold uppercase text-slate-400 mb-2">Same Part — Other Suppliers (SOB)</h4>
              <div className="rounded-lg border border-blue-200 dark:border-blue-500/30 overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="bg-blue-50 dark:bg-blue-500/10 text-slate-600 dark:text-slate-300">
                    <tr>
                      <th className="text-left px-3 py-2 font-semibold">Part No</th>
                      <th className="text-left px-3 py-2 font-semibold">Supplier</th>
                      <th className="text-right px-3 py-2 font-semibold">Live Stock</th>
                      <th className="text-right px-3 py-2 font-semibold">Coverage Day</th>
                      <th className="text-left px-3 py-2 font-semibold">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-navy-800">
                    {sob.siblings.map((s) => (
                      <tr key={s.part_id}>
                        <td className="px-3 py-2 font-medium text-slate-800 dark:text-white">{s.part_no}</td>
                        <td className="px-3 py-2 text-slate-600 dark:text-slate-300">{s.supplier_name || "—"}</td>
                        <td className="px-3 py-2 text-right font-semibold text-slate-800 dark:text-white">{detailNum(s.live_stock) ?? "—"}</td>
                        <td className="px-3 py-2 text-right text-slate-600 dark:text-slate-300">{s.cov_days ?? "—"}</td>
                        <td className="px-3 py-2"><Badge status={s.status} /></td>
                      </tr>
                    ))}
                    <tr className="bg-slate-50 dark:bg-navy-800/60">
                      <td className="px-3 py-2 font-semibold text-slate-700 dark:text-slate-200" colSpan={2}>
                        SOB total (incl. {part.part_no})
                      </td>
                      <td className="px-3 py-2 text-right font-bold text-blue-700 dark:text-blue-400">{detailNum(sob.total) ?? "—"}</td>
                      <td colSpan={2} />
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div>
            <h4 className="text-xs font-semibold uppercase text-slate-400 mb-2">Part Master</h4>
            <div className="grid grid-cols-2 gap-x-6">
              <DetailRow label="UOM" value={part.uom} />
              <DetailRow label="Part Type" value={PART_TYPE_LABELS[part.part_type] || part.part_type} />
              <DetailRow label="Category" value={part.category} />
              <DetailRow label="Sub Category" value={part.sub_category} />
              <DetailRow label="New Part No" value={part.new_part_no} />
              <DetailRow label="Old Part No" value={part.old_part_no} />
              <DetailRow label="Supplier" value={part.supplier_name} />
              <DetailRow label="Barcode" value={part.barcode} />
              <DetailRow label="Package Standard" value={detailNum(part.package_standard)} />
              <DetailRow label="Bin Capacity" value={detailNum(part.bin_capacity)} />
              <DetailRow label="Unit Price" value={detailMoney(part.unit_price)} />
              <DetailRow
                label="Status"
                value={part.is_active == null ? null : <Badge status={part.is_active ? "Active" : "Inactive"} />}
              />
            </div>
          </div>

          {(part.erp_stock != null || part.physical_stock != null) && (
            <div>
              <h4 className="text-xs font-semibold uppercase text-slate-400 mb-2">ERP vs Physical</h4>
              <div className="grid grid-cols-3 gap-3">
                <div className="rounded-lg border border-slate-200 dark:border-navy-800 p-3">
                  <p className="text-[11px] text-slate-400">ERP Stock</p>
                  <p className="text-lg font-semibold text-slate-800 dark:text-white">{part.erp_stock != null ? Number(part.erp_stock).toLocaleString() : "—"}</p>
                </div>
                <div className="rounded-lg border border-slate-200 dark:border-navy-800 p-3">
                  <p className="text-[11px] text-slate-400">Physical Stock</p>
                  <p className="text-lg font-semibold text-slate-800 dark:text-white">{part.physical_stock != null ? Number(part.physical_stock).toLocaleString() : "—"}</p>
                </div>
                <div className="rounded-lg border border-slate-200 dark:border-navy-800 p-3">
                  <p className="text-[11px] text-slate-400">Gap (Physical − ERP)</p>
                  <p className={`text-lg font-semibold ${part.erp_gap == null ? "text-slate-400" : part.erp_gap === 0 ? "text-slate-500" : part.erp_gap > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
                    {part.erp_gap == null ? "—" : `${part.erp_gap > 0 ? "+" : ""}${Number(part.erp_gap).toLocaleString()}`}
                  </p>
                </div>
              </div>
              {part.erp_stock == null && <p className="text-[11px] text-slate-400 mt-2">ERP hasn't synced this part yet — gap shows once ERP pushes its figure.</p>}
            </div>
          )}

          {part.supplier_sources && part.supplier_sources.length > 1 && (
            <div>
              <h4 className="text-xs font-semibold uppercase text-slate-400 mb-2">Supplier Breakdown</h4>
              <p className="text-[11px] text-slate-400 mb-2">
                This part is sourced from more than one supplier — stock shown here splits by source; the Total Stock above is the combined figure ERP reports for this part.
              </p>
              <div className="rounded-lg border border-slate-200 dark:border-navy-800 overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 dark:bg-navy-800 text-slate-500">
                    <tr>
                      <th className="text-left px-3 py-2">Supplier</th>
                      <th className="text-left px-3 py-2">Qty</th>
                      <th className="text-left px-3 py-2">SOB %</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-navy-800">
                    {part.supplier_sources.map((s) => (
                      <tr key={s.supplier_name}>
                        <td className="px-3 py-2">{s.supplier_name}</td>
                        <td className="px-3 py-2 font-medium">{s.qty ?? "—"}</td>
                        <td className="px-3 py-2 font-medium">{s.share_pct != null ? `${s.share_pct}%` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {part.source_breakdown && (
            <div>
              <h4 className="text-xs font-semibold uppercase text-slate-400 mb-2">Source Breakdown</h4>
              <p className="text-[11px] text-slate-400 mb-2">
                Cumulative received to date — how much of this part_no has come in via Purchase (SRV) vs In-House Production. Not a live current-stock split (consumption isn't tracked by source).
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-lg border border-slate-200 dark:border-navy-800 p-3">
                  <p className="text-[11px] text-slate-400">Purchased Qty (BOP)</p>
                  <p className="text-lg font-semibold text-slate-800 dark:text-white">{part.source_breakdown.purchased_qty ?? 0}</p>
                </div>
                <div className="rounded-lg border border-slate-200 dark:border-navy-800 p-3">
                  <p className="text-[11px] text-slate-400">In-House Made Qty</p>
                  <p className="text-lg font-semibold text-slate-800 dark:text-white">{part.source_breakdown.inhouse_qty ?? 0}</p>
                </div>
              </div>

              {sourceMonthly.length > 0 && (
                <div className="mt-3 rounded-lg border border-slate-200 dark:border-navy-800 overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50 dark:bg-navy-800 text-slate-500">
                      <tr>
                        <th className="text-left px-2 py-2">Month</th>
                        <th className="text-right px-2 py-2">Purchased (BOP)</th>
                        <th className="text-right px-2 py-2">In-House Made</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sourceMonthly.map((m) => (
                        <tr key={m.month} className="border-t border-slate-100 dark:border-navy-800">
                          <td className="px-2 py-2 text-slate-600 dark:text-slate-300">{formatMonth(m.month)}</td>
                          <td className="px-2 py-2 text-right text-slate-800 dark:text-white">{m.purchased_qty ?? 0}</td>
                          <td className="px-2 py-2 text-right text-slate-800 dark:text-white">{m.inhouse_qty ?? 0}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          <div>
            <h4 className="text-xs font-semibold uppercase text-slate-400 mb-2">Rack / Bin Allocation</h4>
            {loading ? (
              <div className="skeleton h-16 w-full" />
            ) : rackBins.length === 0 ? (
              <p className="text-sm text-slate-400">No rack/bin entries for this part.</p>
            ) : (
              <div className="rounded-lg border border-slate-200 dark:border-navy-800 overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 dark:bg-navy-800 text-slate-500">
                    <tr>
                      <th className="text-left px-2 py-2">Location</th>
                      <th className="text-left px-2 py-2">Rack</th>
                      <th className="text-left px-2 py-2">Bin Capacity</th>
                      <th className="text-left px-2 py-2">Bins Allocated</th>
                      <th className="text-left px-2 py-2">Target COV</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-navy-800">
                    {rackBins.map((rb) => (
                      <tr key={rb.id}>
                        <td className="px-2 py-2">{rb.location}</td>
                        <td className="px-2 py-2">{rb.rack_no}</td>
                        <td className="px-2 py-2">{rb.bin_capacity}</td>
                        <td className="px-2 py-2">{rb.bins_allocated}</td>
                        <td className="px-2 py-2">{rb.target_cov_days}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div>
            <h4 className="text-xs font-semibold uppercase text-slate-400 mb-2">Consumption History</h4>
            {loading ? (
              <div className="skeleton h-16 w-full" />
            ) : consumption.length === 0 ? (
              <p className="text-sm text-slate-400">No production consumption recorded for this part yet.</p>
            ) : (
              <div className="rounded-lg border border-slate-200 dark:border-navy-800 overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 dark:bg-navy-800 text-slate-500">
                    <tr>
                      <th className="text-left px-2 py-2">Date/Time</th>
                      <th className="text-left px-2 py-2">Qty Issued</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-navy-800">
                    {consumption.map((c, i) => (
                      <tr key={i}>
                        <td className="px-2 py-2">{new Date(c.time).toLocaleString()}</td>
                        <td className="px-2 py-2">{c.qty}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div>
            <h4 className="text-xs font-semibold uppercase text-slate-400 mb-2">Recent SRV History</h4>
            {/* Cumulative SRV totals — already in the part-summary payload but
                previously never shown, so the SRV table below had no running
                figure to sit against. */}
            <div className="grid grid-cols-3 gap-3 mb-3">
              <div className="rounded-lg border border-slate-200 dark:border-navy-800 p-3">
                <p className="text-[11px] text-slate-400">Total Invoiced</p>
                <p className="text-lg font-semibold text-slate-800 dark:text-white">{detailNum(part.total_invoiced) ?? "—"}</p>
              </div>
              <div className="rounded-lg border border-slate-200 dark:border-navy-800 p-3">
                <p className="text-[11px] text-slate-400">Total Received</p>
                <p className="text-lg font-semibold text-slate-800 dark:text-white">{detailNum(part.total_received) ?? "—"}</p>
              </div>
              <div className="rounded-lg border border-slate-200 dark:border-navy-800 p-3">
                <p className="text-[11px] text-slate-400">Total Short</p>
                <p className={`text-lg font-semibold ${part.total_short ? "text-rose-600 dark:text-rose-400" : "text-slate-800 dark:text-white"}`}>
                  {detailNum(part.total_short) ?? "—"}
                </p>
              </div>
            </div>
            {loading ? (
              <div className="skeleton h-16 w-full" />
            ) : srvs.length === 0 ? (
              <p className="text-sm text-slate-400">No SRVs recorded for this part yet.</p>
            ) : (
              <div className="rounded-lg border border-slate-200 dark:border-navy-800 overflow-x-auto">
                {/* Received On and the supplier's name, not just its code. The
                    table already knew both — gate_entry_time and supplier_name
                    ride on every SRV row — but showed neither, so a part bought
                    from three suppliers listed three vendor codes with no way
                    to tell which arrival came when. */}
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 dark:bg-navy-800 text-slate-500">
                    <tr>
                      <th className="text-left px-2 py-2">Received On</th>
                      <th className="text-left px-2 py-2">Supplier</th>
                      <th className="text-left px-2 py-2">SRV No</th>
                      <th className="text-left px-2 py-2">Qty Rcvd</th>
                      <th className="text-left px-2 py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-navy-800">
                    {srvs.map((s) => (
                      <tr key={s.id}>
                        <td className="px-2 py-2 whitespace-nowrap tabular">{detailDateTime(s.gate_entry_time) || "—"}</td>
                        <td className="px-2 py-2">
                          <span className="block">{s.supplier_name || s.vendor_code}</span>
                          {s.supplier_name && <span className="text-[10px] text-slate-400">{s.vendor_code}</span>}
                        </td>
                        <td className="px-2 py-2">{s.srv_no || "—"}</td>
                        <td className="px-2 py-2">{s.qty_received ?? "—"}</td>
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

const CHART_DAYS_LABEL = 14;

// Every row of Live Stock, used for the Live Stock / Inventory Value KPIs
// and (filtered client-side) the Top Short / Top Excess tables. Pages after
// the first are fetched in parallel — sequential paging was a waterfall,
// and each page costs a full server-side parts scan.
async function fetchAllLiveStock() {
  const first = await liveStockService.list({ page: 1, per_page: 200 });
  const totalPages = first.data.meta.total_pages;
  if (totalPages <= 1) return first.data.data;

  const rest = await Promise.all(
    Array.from({ length: totalPages - 1 }, (_, i) =>
      liveStockService.list({ page: i + 2, per_page: 200 })
    )
  );
  return rest.reduce((rows, res) => rows.concat(res.data.data), first.data.data);
}

export default function StoreDashboard() {
  const CATEGORIES = useStoreCategories();
  const navigate = useNavigate();
  const [summary, setSummary] = useState(null);
  const [parts, setParts] = useState([]);
  const [liveStockAll, setLiveStockAll] = useState([]);
  const [productionCritical, setProductionCritical] = useState([]);
  const [dailyReceiving, setDailyReceiving] = useState([]);
  const [rackBins, setRackBins] = useState([]);
  const [alerts, setAlerts] = useState(null);
  const [analytics, setAnalytics] = useState(null);
  const [stockStatusSummary, setStockStatusSummary] = useState({});
  const [supplierVehicles, setSupplierVehicles] = useState([]);
  const [todayVehicleStatus, setTodayVehicleStatus] = useState([]);
  const [auditLogs, setAuditLogs] = useState([]);
  const [todaysIssues, setTodaysIssues] = useState([]);
  const [showTodaysIssues, setShowTodaysIssues] = useState(false);
  const [todaysReceipts, setTodaysReceipts] = useState([]);
  const [showTodaysReceipts, setShowTodaysReceipts] = useState(false);
  const [pendingSrv, setPendingSrv] = useState(null);
  const [showPendingSrv, setShowPendingSrv] = useState(false);
  const [selectedPart, setSelectedPart] = useState(null);

  // Per-section loading flags rather than one global gate: each card
  // renders the moment its own request lands, so the fast KPIs aren't held
  // hostage by the slowest call (the full Live Stock fetch). Every endpoint
  // hits the same SQLite-backed server, which serializes them, so the
  // spread between first and last response is real.
  const [loaded, setLoaded] = useState({});
  const markLoaded = (key) => setLoaded((prev) => (prev[key] ? prev : { ...prev, [key]: true }));

  function loadAll() {
    const run = (key, promise, apply) =>
      promise
        .then((res) => apply(res))
        .catch(() => {
          /* handled globally */
        })
        .finally(() => markLoaded(key));

    run("summary", storeDashboardService.summary(), (r) => setSummary(r.data.data));
    run("parts", storeDashboardService.partSummary(), (r) => setParts(r.data.data));
    run("liveStock", fetchAllLiveStock(), (rows) => setLiveStockAll(rows));
    run("critical", storeDashboardService.productionCriticalParts(), (r) => setProductionCritical(r.data.data));
    run("receiving", storeDashboardService.dailyReceiving(), (r) => setDailyReceiving(r.data.data));
    run("racks", rackBinService.list(), (r) => setRackBins(r.data.data));
    run("alerts", storeDashboardService.alerts(), (r) => setAlerts(r.data.data));
    run("analytics", storeDashboardService.analytics(), (r) => setAnalytics(r.data.data));
    run("stockStatus", inventoryOverviewService.stockStatusSummary(), (r) => setStockStatusSummary(r.data.data));
    run("suppliers", supplierVehicleService.list({ per_page: 200 }), (r) => setSupplierVehicles(r.data.data));
    run("todayVehicleStatus", supplierWindowScheduleService.todayStatus(), (r) => setTodayVehicleStatus(r.data.data));
    run("activity", auditLogService.list({ per_page: 8 }), (r) => setAuditLogs(r.data.data));
    run("todaysIssues", storeDashboardService.todaysIssues(), (r) => setTodaysIssues(r.data.data));
    run("todaysReceipts", storeDashboardService.todaysReceipts(), (r) => setTodaysReceipts(r.data.data));
    run("pendingSrv", storeDashboardService.pendingSrv(), (r) => setPendingSrv(r.data.data));
  }

  useEffect(() => {
    loadAll();
    const id = setInterval(loadAll, 30000);
    return () => clearInterval(id);
  }, []);

  // part_id -> {category, supplier_name} — client-side join used by the
  // Production Status card (Most Affected Supplier/Category) and Category
  // Wise Stock cards, sourced from the already-fetched part-wise summary.
  const partInfoMap = new Map(parts.map((p) => [p.part_id, { category: p.category, supplier_name: p.supplier_name, max_stock_level: p.max_stock_level }]));

  // part_id -> real counted stock (from Daily Stock Count via /live-stock) —
  // authoritative live quantity; the SRV-ledger-derived total_qty in
  // part-summary is 0 for parts that haven't moved through an SRV yet.
  const liveRowMap = new Map(liveStockAll.map((r) => [r.part_id, r]));

  // part_id -> the same part's other supplier variants. Grouped off the
  // server's sob_key so the rule lives in one place, and built from
  // liveStockAll so the quantities are the same counted stock the Short Parts
  // screen shows rather than the SRV-ledger total.
  const sobByKey = new Map();
  liveStockAll.forEach((r) => {
    if (!r.sob_key) return;
    if (!sobByKey.has(r.sob_key)) sobByKey.set(r.sob_key, []);
    sobByKey.get(r.sob_key).push(r);
  });
  const sobSiblingsFor = (partId) => {
    const row = liveStockAll.find((r) => r.part_id === partId);
    const family = row ? sobByKey.get(row.sob_key) : null;
    if (!family || family.length < 2) return null;
    const stocks = family.map((f) => f.live_stock).filter((v) => v != null);
    return {
      siblings: family.filter((f) => f.part_id !== partId).sort((a, b) => a.part_no.localeCompare(b.part_no)),
      total: stocks.length ? stocks.reduce((sum, v) => sum + v, 0) : null,
    };
  };
  const mergedParts = parts.map((p) => {
    const live = liveRowMap.get(p.part_id);
    const counted = live?.live_stock;
    const useCounted = counted != null;
    return {
      ...p,
      total_qty: useCounted ? counted : p.total_qty,
      // Value has to follow whichever quantity is actually on screen. It was
      // still coming off the SRV ledger, so a part holding 2,100 counted units
      // showed its stock correctly and its value as ₹0.
      total_value: useCounted ? live.total_value : p.total_value,
      // The Receiving/Part Store split is only meaningful once a part has moved
      // through an SRV. Until then the ledger holds nothing, and printing
      // "0 / 0" beside a real Total reads as a contradiction rather than as
      // "this stock came from the count sheet".
      has_ledger_stock: (p.receiving_store_qty || 0) + (p.part_store_qty || 0) > 0,
    };
  });

  const totalLiveStock = liveStockAll.reduce((sum, r) => sum + (r.live_stock || 0), 0);

  // No sparkline on Total Active Parts. A sparkline scales to its own
  // min/max, so the part master going 238 → 253 when fifteen parts were added
  // on 29 July was drawn as a full-height cliff — it read as the part count
  // having doubled. The series also has no entry for days nobody counted
  // (26-27 July), which the line joined up as if they were consecutive. The
  // Inventory Trend chart below plots the same figures with a real axis.

  const shortByCategory = { ...Object.fromEntries(CATEGORIES.map((c) => [c, 0])) };
  productionCritical.forEach((r) => {
    const cat = partInfoMap.get(r.part_id)?.category;
    if (cat in shortByCategory) shortByCategory[cat] += 1;
  });

  const totalInventoryValue = liveStockAll.reduce((sum, r) => sum + (r.total_value || 0), 0);
  const hasValueData = liveStockAll.some((r) => r.unit_price != null);

  // Top Short / Top Excess tables — filtered from the rows already fetched
  // above. These are the exact same rows `/live-stock?status=...` returns
  // (same server-side `_all_rows()` source), so filtering here instead of
  // making two more requests avoids two extra full parts scans per refresh.
  const topShort = liveStockAll.filter((r) => r.status === "Short").slice(0, 10);
  const topExcess = liveStockAll.filter((r) => r.status === "Excess").slice(0, 10);

  // Open part detail — prefer the fuller part-summary row (min/max, invoiced
  // totals) for the same part_id, falling back to the row that was clicked.
  const openPartDetail = (row) => {
    const full = mergedParts.find((p) => p.part_id === row.part_id);
    setSelectedPart(full || row);
  };

  return (
    <div className="space-y-8">
      <HeroBanner />

      {/* 1 — Critical Alerts. Anything that needs someone to act today comes
          before anything that merely describes the store. */}
      <Section
        title="Critical Alerts"
        hint="Live shortages and open exceptions — act on these first"
        actions={
          <div className="flex items-center gap-2">
            <StatusChip
              label="short" value={productionCritical.length} tone="red"
              loading={!loaded.critical} onClick={() => navigate("/short-parts")}
            />
            <StatusChip
              label="excess" value={summary?.excess_stock ?? 0} tone="amber"
              loading={!loaded.summary} onClick={() => navigate("/excess-parts#all-excess")}
            />
          </div>
        }
      >
        <LiveStatusTicker
          shortRows={productionCritical}
          excessCount={summary?.excess_stock ?? 0}
          excessAddedToday={summary?.excess_added_today ?? 0}
          excessVsYesterday={summary?.vs_yesterday?.excess_stock ?? null}
          alerts={alerts}
          loading={!loaded.critical || !loaded.alerts}
          onRowClick={openPartDetail}
        />
        <ProductionStatusCard shortRows={productionCritical} partInfoMap={partInfoMap} loading={!loaded.critical} />
      </Section>

      {/* 2 — Executive KPIs. */}
      <Section title="Key Performance Indicators" hint="Compared with yesterday's closing position">
      {/* Denser than the rest of the page on purpose — a KPI strip is read as
          one row of figures, so the cards sit close and stay short. Four wide
          rather than seven: at seven, "Total Stock Qty" ran to 11,370,017 and
          was clipped mid-number, which is worse than a longer row. */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        <KpiCard
          label="Total Active Parts" icon="🔩" tone="navy" loading={!loaded.summary}
          value={summary?.total_parts ?? "—"}
          delta={summary?.vs_yesterday?.total_parts ?? null}
          onClick={() => navigate("/live-stock")}
        />
        <KpiCard
          label="Total Stock Qty" icon="📦" tone="navy" unit="pcs" loading={!loaded.liveStock}
          value={totalLiveStock}
          hint="Combined units across all parts"
          onClick={() => navigate("/live-stock")}
        />
        <KpiCard
          label="Pending SRV" icon="📋" tone="amber" loading={!loaded.summary}
          value={summary?.pending_srv ?? 0}
          onClick={() => setShowPendingSrv(true)}
        />
        <KpiCard
          label="Today's Receipt" icon="📥" tone="navy" loading={!loaded.summary}
          value={summary?.todays_srv ?? 0}
          onClick={() => setShowTodaysReceipts(true)}
        />
        <KpiCard
          label="Today's Issue" icon="📤" tone="navy" loading={!loaded.summary}
          value={summary?.todays_issue ?? 0}
          onClick={() => setShowTodaysIssues(true)}
        />
        {/* Short Parts / Excess Parts KPI cards intentionally absent — both
            counts already ride the LIVE ticker above (short as per-part chips,
            excess as its own drill-through chip), so a card each was duplicate
            surface. Quick Access below still links to both screens. */}
        <KpiCard
          label="Inventory Value" icon="💰" tone="navy" loading={!loaded.liveStock}
          value={hasValueData ? formatINR(totalInventoryValue) : "—"}
          hint={hasValueData
            ? `₹${Math.round(totalInventoryValue).toLocaleString("en-IN")}`
            : "Unit Price not set for any part yet"}
        />
        <KpiCard
          label="Rack Utilization" icon="🗃️" tone="navy" loading={!loaded.summary}
          value={summary?.rack_utilization != null ? `${summary.rack_utilization}%` : "—"}
          hint={summary?.rack_utilization == null ? "No racks with bins allocated yet" : undefined}
        />
      </div>
      </Section>

      {/* 3 — Inventory Summary: what the store is holding, by category and by
          status, plus the parts at either end of the range. */}
      <Section title="Inventory Summary" hint="Holdings by category and stock status">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {CATEGORIES.map((c) => (
            <CategoryStockCard
              key={c}
              category={c}
              total={summary?.category_counts?.[c] ?? 0}
              short={shortByCategory[c] ?? 0}
              excess={analytics?.excess_by_category?.[c] ?? 0}
              onClick={() => navigate(`/live-stock?category=${encodeURIComponent(c)}`)}
              onFilterClick={(status) => navigate(`/live-stock?category=${encodeURIComponent(c)}&status=${status}`)}
            />
          ))}
        </div>

        <StatDistributionBar
          title="Stock Status Distribution"
          loading={!loaded.stockStatus}
          colors={STOCK_STATUS_COLORS}
          viewDetailsTo="/inventory-overview"
          data={Object.entries(stockStatusSummary).map(([name, value]) => ({ name, value }))}
        />

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <TopPartsTable
          title="Top Short Parts"
          icon="🚨" tone="red" hint="Lowest coverage first — click a row for detail"
          rows={topShort}
          loading={!loaded.liveStock}
          emptyMessage="No short parts right now"
          onRowClick={openPartDetail}
          columns={[
            { key: "part_no", label: "Part No" },
            { key: "part_name", label: "Part Name" },
            { key: "supplier_name", label: "Supplier", render: (r) => r.supplier_name || "—" },
            { key: "live_stock", label: "Stock", render: (r) => r.live_stock ?? "—" },
            { key: "cov_days", label: "Coverage", render: (r) => r.cov_days ?? "—" },
            { key: "rack_no", label: "Rack", render: (r) => r.rack_no || "—" },
            { key: "status", label: "Status", render: (r) => <Badge status={r.status} /> },
          ]}
        />
        <TopPartsTable
          title="Top Excess Parts"
          icon="📈" tone="amber" hint="Holding well above target — click a row for detail"
          rows={topExcess}
          loading={!loaded.liveStock}
          emptyMessage="No excess parts right now"
          onRowClick={openPartDetail}
          columns={[
            { key: "part_no", label: "Part No" },
            { key: "live_stock", label: "Current Qty", render: (r) => r.live_stock ?? "—" },
            {
              key: "max", label: "Maximum Qty",
              render: (r) => partInfoMap.get(r.part_id)?.max_stock_level ?? "—",
            },
            { key: "rack_no", label: "Rack", render: (r) => r.rack_no || "—" },
            { key: "cov_days", label: "Coverage", render: (r) => r.cov_days ?? "—" },
          ]}
        />
        </div>
      </Section>

      {/* 4 — Operational Analytics: how the store and its inbound flow are
          performing, as opposed to what it is holding. */}
      <Section
        title="Operational Analytics"
        hint="Storage, risk and inbound vehicle performance"
        actions={
          <StatusChip
            label="vehicles scheduled today" value={todayVehicleStatus.length}
            loading={!loaded.todayVehicleStatus} onClick={() => navigate("/supplier-vehicles")}
          />
        }
      >
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <RackUtilizationPanel pct={summary?.rack_utilization ?? null} rows={rackBins} loading={!loaded.racks} />
          <RiskMatrixPanel alerts={alerts} lastSync={analytics?.last_erp_sync} loading={!loaded.alerts} />
          <SupplierPerformanceCard rows={supplierVehicles} loading={!loaded.suppliers} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <TodaysVehiclesSummary
            scheduledRows={todayVehicleStatus}
            adhocRows={supplierVehicles}
            loading={!loaded.todayVehicleStatus || !loaded.suppliers}
          />
          <VehicleStatusTable rows={todayVehicleStatus} loading={!loaded.todayVehicleStatus} />
        </div>
      </Section>

      {/* 5 — Charts: the same numbers over time. */}
      <Section title="Trends" hint={`Inventory and receipts over the last ${CHART_DAYS_LABEL} days`}>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <InventoryTrendChart rows={analytics?.trend || []} loading={!loaded.analytics} />
          <ReceiptTrendChart rows={dailyReceiving} loading={!loaded.receiving} days={CHART_DAYS_LABEL} />
        </div>
      </Section>

      {/* 6 — Live Activity: what has actually happened in the store today. */}
      <Section title="Live Activity" hint="Today's movements and the latest audit entries">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2">
            <LiveActivityFeed rows={auditLogs} loading={!loaded.activity} />
          </div>
          <StoreActivitiesCard summary={summary} loading={!loaded.summary} />
        </div>
      </Section>

      {/* 7 — Reports & shortcuts, last: navigation rather than information. */}
      <Section title="Reports & Quick Access">
        <QuickActionsCard />
      </Section>

      <PartDetailModal
        part={selectedPart}
        sob={selectedPart ? sobSiblingsFor(selectedPart.part_id) : null}
        onClose={() => setSelectedPart(null)}
      />
      <TodaysIssuesModal open={showTodaysIssues} rows={todaysIssues} onClose={() => setShowTodaysIssues(false)} />
      <TodaysReceiptsModal open={showTodaysReceipts} rows={todaysReceipts} onClose={() => setShowTodaysReceipts(false)} />
      <PendingSrvModal open={showPendingSrv} data={pendingSrv} onClose={() => setShowPendingSrv(false)} />
    </div>
  );
}
