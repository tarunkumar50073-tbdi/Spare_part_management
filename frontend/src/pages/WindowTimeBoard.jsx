import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Truck, CalendarClock, CheckCircle2, AlarmClock, Clock, XCircle, Timer,
  TrendingUp, Route, AlertTriangle, Info, RefreshCw, ShieldAlert,
} from "lucide-react";
import { supplierWindowScheduleService } from "../services/supplierWindowScheduleService.js";

// Window Time — a live control tower over the day's supplier delivery windows:
// KPI counts, a derived severity-tagged alert feed, and a severity summary. All
// from the ERP-fed window-vs-arrival status. Defaults to the latest day the ERP
// has data for, so it shows real numbers rather than a wall of false "not
// arrived" while the ERP feed catches up. Overstay / gate-out need a Gate Exit
// source ERP does not expose yet, so those read "ERP pending".
const REFRESH_MS = 30000;
const num = (v) => (v === null || v === undefined ? "—" : Number(v).toLocaleString());

const KPI = [
  { key: "total", label: "Today's Vehicles", sub: "Total expected", icon: Truck, tone: "text-slate-700 dark:text-slate-200", ring: "bg-slate-100 dark:bg-navy-800" },
  { key: "window_open", label: "Window Open", sub: "Open now", icon: CalendarClock, tone: "text-blue-600 dark:text-blue-400", ring: "bg-blue-50 dark:bg-blue-500/10" },
  { key: "on_time", label: "Arrived On-Time", sub: "Within window", icon: CheckCircle2, tone: "text-emerald-600 dark:text-emerald-400", ring: "bg-emerald-50 dark:bg-emerald-500/10" },
  { key: "late", label: "Late Arrivals", sub: "After window", icon: AlarmClock, tone: "text-amber-600 dark:text-amber-400", ring: "bg-amber-50 dark:bg-amber-500/10" },
  { key: "upcoming", label: "Upcoming", sub: "Yet to open", icon: Clock, tone: "text-indigo-600 dark:text-indigo-400", ring: "bg-indigo-50 dark:bg-indigo-500/10" },
  { key: "not_arrived", label: "Not Arrived", sub: "Window missed", icon: XCircle, tone: "text-rose-600 dark:text-rose-400", ring: "bg-rose-50 dark:bg-rose-500/10" },
  { key: "overstay", label: "Overstay", sub: "ERP pending", icon: Timer, tone: "text-purple-600 dark:text-purple-400", ring: "bg-purple-50 dark:bg-purple-500/10" },
  { key: "on_time_pct", label: "On-Time %", sub: "Of settled", icon: TrendingUp, tone: "text-teal-600 dark:text-teal-400", ring: "bg-teal-50 dark:bg-teal-500/10", pct: true },
  { key: "milkrun_trips", label: "Milkrun Trips", sub: "Active groups", icon: Route, tone: "text-sky-600 dark:text-sky-400", ring: "bg-sky-50 dark:bg-sky-500/10" },
];

const SEV = {
  critical: { label: "Critical", icon: ShieldAlert, border: "border-l-rose-500", chip: "bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300", ico: "text-rose-500", ring: "bg-rose-50 dark:bg-rose-500/10" },
  warning: { label: "Warning", icon: AlertTriangle, border: "border-l-amber-500", chip: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300", ico: "text-amber-500", ring: "bg-amber-50 dark:bg-amber-500/10" },
  info: { label: "Info", icon: Info, border: "border-l-blue-500", chip: "bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300", ico: "text-blue-500", ring: "bg-blue-50 dark:bg-blue-500/10" },
};

const fmtDate = (iso) => {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric", weekday: "short" });
};

export default function WindowTimeBoard() {
  const [date, setDate] = useState("");          // "" = latest ERP-data day
  const [board, setBoard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("all");
  const [updatedAt, setUpdatedAt] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await supplierWindowScheduleService.board(date || undefined);
      setBoard(res.data.data);
      setUpdatedAt(new Date());
    } catch {
      /* handled globally */
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => {
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  const k = board?.kpis || {};
  const alerts = useMemo(
    () => (board?.alerts || []).filter((a) => filter === "all" || a.severity === filter),
    [board, filter],
  );
  const summary = board?.summary || { critical: 0, warning: 0, info: 0 };
  const totalAlerts = summary.critical + summary.warning + summary.info;

  const tabs = [
    { key: "all", label: "All", count: totalAlerts, chip: "bg-toyotared text-white" },
    { key: "critical", label: "Critical", count: summary.critical, chip: SEV.critical.chip },
    { key: "warning", label: "Warning", count: summary.warning, chip: SEV.warning.chip },
    { key: "info", label: "Info", count: summary.info, chip: SEV.info.chip },
  ];

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold text-lg text-slate-800 dark:text-white flex items-center gap-2">
            <Truck size={20} className="text-toyotared" /> Vehicle Management — Window Time
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Live supplier window status from the ERP mirror.
            {board && !board.is_today && (
              <span className="text-amber-600 dark:text-amber-400">
                {" "}Showing {fmtDate(board.date)} — the latest day ERP has data for
                {board.latest_data_date ? "" : ""} (today's data not loaded yet).
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <input
            type="date"
            className="input-field py-1.5 text-[13px] max-w-[9.5rem]"
            value={date || board?.date || ""}
            max={board?.latest_data_date || undefined}
            onChange={(e) => { setLoading(true); setDate(e.target.value); }}
          />
          {date && (
            <button className="btn-secondary py-1.5 text-[13px]" onClick={() => { setLoading(true); setDate(""); }}>
              Latest
            </button>
          )}
          <button className="btn-secondary py-1.5 text-[13px]" onClick={load} title="Refresh now">
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-9 gap-3">
        {KPI.map((c) => (
          <div key={c.key} className="card !p-3">
            <div className="flex items-center gap-2 mb-1.5">
              <span className={`w-7 h-7 rounded-lg flex items-center justify-center ${c.ring}`}>
                <c.icon size={15} className={c.tone} />
              </span>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 leading-tight">{c.label}</p>
            </div>
            <p className={`text-2xl font-bold tabular ${c.tone}`}>
              {c.pct ? (k[c.key] === null || k[c.key] === undefined ? "—" : `${k[c.key]}%`) : num(k[c.key])}
            </p>
            <p className="text-[10px] text-slate-400 mt-0.5">{c.sub}</p>
          </div>
        ))}
      </div>

      {/* Alerts + summary */}
      <div className="grid grid-cols-1 xl:grid-cols-4 gap-4">
        <div className="xl:col-span-3 card">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <h3 className="font-semibold text-slate-800 dark:text-white flex items-center gap-2">
              <AlarmClock size={16} className="text-toyotared" /> Live Alerts
              <span className="text-xs font-normal text-slate-400">({totalAlerts})</span>
            </h3>
            <div className="flex flex-wrap gap-1.5">
              {tabs.map((t) => (
                <button
                  key={t.key}
                  onClick={() => setFilter(t.key)}
                  className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                    filter === t.key ? t.chip : "bg-slate-100 dark:bg-navy-800 text-slate-500 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-navy-700"
                  }`}
                >
                  {t.label} <span className="tabular">{t.count}</span>
                </button>
              ))}
            </div>
          </div>

          {loading && !board ? (
            <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => <div key={i} className="skeleton h-16 w-full" />)}</div>
          ) : alerts.length === 0 ? (
            <div className="text-center text-slate-400 py-10 flex flex-col items-center gap-2">
              <CheckCircle2 size={28} className="text-emerald-500" />
              {filter === "all" ? "No alerts — every window is on track." : `No ${filter} alerts.`}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {alerts.map((a, i) => {
                const s = SEV[a.severity] || SEV.info;
                return (
                  <div key={i} className={`rounded-xl border border-slate-200 dark:border-navy-800 border-l-4 ${s.border} p-3 flex items-start gap-3`}>
                    <span className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${s.ring}`}>
                      <s.icon size={16} className={s.ico} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-[11px] font-semibold text-slate-500 dark:text-slate-400">{a.type}</p>
                        <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${s.chip}`}>{s.label}</span>
                      </div>
                      <p className="text-sm font-medium text-slate-800 dark:text-slate-100 truncate" title={a.title}>{a.title}</p>
                      <p className="text-[11px] text-slate-400 mt-0.5">
                        {a.when && <span>{a.when}</span>}{a.when && a.window ? "  ·  " : ""}{a.window && <span>Window {a.window}</span>}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Alert summary */}
        <div className="card">
          <h3 className="font-semibold text-slate-800 dark:text-white flex items-center gap-2 mb-3">
            <ShieldAlert size={16} className="text-toyotared" /> Alert Summary
          </h3>
          <div className="space-y-2">
            {["critical", "warning", "info"].map((sev) => {
              const s = SEV[sev];
              return (
                <button
                  key={sev}
                  onClick={() => setFilter(sev)}
                  className={`w-full flex items-center justify-between rounded-xl border border-slate-200 dark:border-navy-800 p-3 transition-colors hover:bg-slate-50 dark:hover:bg-navy-800/60 ${filter === sev ? "ring-2 ring-toyotared/40" : ""}`}
                >
                  <span className="flex items-center gap-2">
                    <span className={`w-8 h-8 rounded-lg flex items-center justify-center ${s.ring}`}>
                      <s.icon size={16} className={s.ico} />
                    </span>
                    <span className="text-sm font-medium text-slate-700 dark:text-slate-200">{s.label}</span>
                  </span>
                  <span className={`text-lg font-bold tabular ${s.ico}`}>{summary[sev]}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400 px-1">
        <span className="flex items-center gap-1.5">
          <CheckCircle2 size={13} className="text-emerald-500" /> All times IST · Auto-refresh every 30 sec
        </span>
        <span className="flex items-center gap-1.5">
          <Clock size={13} /> Last updated: {updatedAt ? updatedAt.toLocaleTimeString() : "—"}
        </span>
      </div>
    </div>
  );
}
