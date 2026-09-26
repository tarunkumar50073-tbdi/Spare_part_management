import React from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowRight, BellOff, CircleCheck, Clock, Info, Lock, Package, RefreshCw, Siren, TriangleAlert,
} from "lucide-react";
import ErrorState from "../../components/ErrorState.jsx";
import { useAuth } from "../../context/AuthContext.jsx";
import { useStores } from "../../context/StoreContext.jsx";
import { usePartDrawer } from "../../context/PartDrawerContext.jsx";
import { fmtStamp, parseServerTime } from "../../lib/format.js";
import {
  ALERTS_REFRESH_MS, alertsKey, alertsStoreFor, canOpenAction, fetchAlerts,
} from "../../services/spareAlertsService.js";

// The Notification Center: every alert the Spare Parts Store raises right now,
// worst first. The server works them out from live rows on each call, so there
// is nothing to mark read or dismiss: an alert leaves once its cause is fixed.

const SEVERITY = {
  critical: {
    label: "Critical", Icon: Siren, chip: "bg-rose-600 text-white", rail: "bg-rose-600",
    tile: "bg-rose-50 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300",
  },
  warning: {
    label: "Warning", Icon: TriangleAlert, chip: "bg-amber-500 text-white", rail: "bg-amber-500",
    tile: "bg-amber-50 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300",
  },
  info: {
    label: "Info", Icon: Info, chip: "bg-blue-600 text-white", rail: "bg-blue-500",
    tile: "bg-blue-50 text-blue-600 dark:bg-blue-500/15 dark:text-blue-300",
  },
};

const FILTERS = [
  { key: "", label: "All" },
  { key: "critical", label: "Critical" },
  { key: "warning", label: "Warning" },
  { key: "info", label: "Info" },
];

const EMPTY_SUMMARY = { critical: 0, warning: 0, info: 0, total: 0 };

// generated_at is a server UTC stamp; parseServerTime keeps it in UTC even if
// the zone suffix is ever dropped, so the browser shows the plant's clock.
const clock = (iso) => {
  const d = parseServerTime(iso);
  return d ? d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : null;
};

function AlertRow({ alert, canOpen, onAction, onPart }) {
  const sev = SEVERITY[alert.severity] || SEVERITY.info;
  const hasPart = alert.part_id != null;
  // Per-part / per-issue lines sit indented under the headline that counts them.
  const child = Boolean(alert.parent);
  return (
    <li
      className={`relative ${hasPart ? "cursor-pointer hover:bg-slate-50/80 dark:hover:bg-navy-800/40" : ""}`}
      onClick={hasPart ? () => onPart(alert.part_id) : undefined}
    >
      <span className={`absolute left-0 top-0 h-full w-1 ${sev.rail} ${child ? "opacity-40" : ""}`} aria-hidden="true" />
      <div className={`flex flex-col gap-2 py-3 pr-4 sm:flex-row sm:items-center sm:gap-4 ${child ? "pl-5 sm:pl-12" : "pl-5"}`}>
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${sev.tile}`}>
            <sev.Icon size={16} aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${sev.chip}`}>
                {sev.label}
              </span>
              <h3 className="text-sm font-semibold text-slate-800 dark:text-white">{alert.title}</h3>
              {hasPart && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onPart(alert.part_id); }}
                  className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-[11px]
                    text-slate-600 hover:border-toyotared hover:text-toyotared dark:border-navy-700 dark:bg-navy-800 dark:text-slate-300"
                  title="Open this part"
                >
                  <Package size={11} aria-hidden="true" />{alert.part_no}
                </button>
              )}
            </div>
            <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">{alert.message}</p>
            <p
              className="mt-1 inline-flex items-center gap-1 text-[11px] text-slate-400"
              title={alert.at ? "When this happened" : "A condition that holds right now, as of the last check"}
            >
              <Clock size={11} aria-hidden="true" />
              {alert.at ? fmtStamp(alert.at) : "Now"}
            </p>
          </div>
        </div>
        {alert.action && (
          <div className="flex shrink-0 pl-11 sm:pl-0">
            {canOpen ? (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onAction(alert.action.to); }}
                className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-600
                  hover:border-toyotared hover:text-toyotared dark:border-navy-700 dark:text-slate-300"
              >
                {alert.action.label} <ArrowRight size={12} aria-hidden="true" />
              </button>
            ) : (
              <span
                className="inline-flex items-center gap-1 rounded-md border border-dashed border-slate-200 px-2 py-1 text-[11px]
                  text-slate-400 dark:border-navy-700"
                title="Your account has no right to open this screen. Ask an administrator under User Management."
              >
                <Lock size={11} aria-hidden="true" /> No access to this screen
              </span>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

function ListSkeleton() {
  return (
    <div className="card space-y-3" aria-busy="true" aria-label="Loading alerts">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="flex items-center gap-3">
          <div className="skeleton h-8 w-8 shrink-0" />
          <div className="flex-1 space-y-1.5">
            <div className="skeleton h-3.5 w-1/3" />
            <div className="skeleton h-3 w-2/3" />
          </div>
          <div className="skeleton h-6 w-24" />
        </div>
      ))}
    </div>
  );
}

export default function NotificationCenter() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { openPart } = usePartDrawer();
  const { activeCode, activeStore, loading: storesLoading } = useStores();
  const code = alertsStoreFor(activeCode);
  const [params, setParams] = useSearchParams();
  const severity = SEVERITY[params.get("severity")] ? params.get("severity") : "";

  const { data, isPending, isError, error, refetch, isFetching } = useQuery({
    queryKey: alertsKey(code),
    queryFn: () => fetchAlerts(code),
    enabled: Boolean(code),
    refetchInterval: ALERTS_REFRESH_MS,
  });

  const setSeverity = (key) => {
    const next = new URLSearchParams(params);
    if (key) next.set("severity", key);
    else next.delete("severity");
    setParams(next, { replace: true });
  };

  const alerts = data?.alerts || [];
  const summary = data?.summary || EMPTY_SUMMARY;
  const shown = severity ? alerts.filter((a) => a.severity === severity) : alerts;
  const storeName = activeStore?.name || "this store";

  let body;
  if (!code) {
    body = storesLoading ? <ListSkeleton /> : (
      <div className="card flex flex-col items-center py-12 text-center">
        <BellOff size={26} strokeWidth={1.6} className="text-slate-300 dark:text-slate-600" aria-hidden="true" />
        <p className="mt-2 text-sm font-medium text-slate-600 dark:text-slate-300">
          Alerts cover the Spare Parts Store
        </p>
        <p className="mt-1 text-xs text-slate-400">
          {activeCode ? "Switch to the Spare Parts Store to see its alerts." : "No store is open for your account."}
        </p>
      </div>
    );
  } else if (isPending) {
    body = <ListSkeleton />;
  } else if (isError && !data) {
    body = (
      <div className="card">
        <ErrorState
          title="Could not load the alerts"
          message="The alert check did not answer. Your data is unchanged; try again."
          error={error}
          onRetry={() => refetch()}
        />
      </div>
    );
  } else if (summary.total === 0) {
    body = (
      <div className="card flex flex-col items-center py-12 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300">
          <CircleCheck size={24} aria-hidden="true" />
        </span>
        <p className="mt-3 text-sm font-semibold text-slate-800 dark:text-white">
          No alerts — nothing in {storeName} needs attention right now.
        </p>
        <p className="mt-1 max-w-md text-xs text-slate-400">
          No part at zero stock or below minimum, no issue waiting for confirmation, no SRV pending,
          and the ERP stock snapshot is current.
        </p>
      </div>
    );
  } else {
    body = (
      <div className="card !p-0 overflow-hidden">
        {shown.length === 0 ? (
          <div className="flex flex-col items-center px-4 py-10 text-center">
            <CircleCheck size={22} className="text-emerald-500" aria-hidden="true" />
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
              No {SEVERITY[severity].label.toLowerCase()} alerts right now.
            </p>
            <button type="button" onClick={() => setSeverity("")} className="mt-2 text-xs font-semibold text-toyotared hover:underline">
              Show all {summary.total} {summary.total === 1 ? "alert" : "alerts"}
            </button>
          </div>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-navy-800">
            {shown.map((a) => (
              <AlertRow
                key={a.id}
                alert={a}
                canOpen={canOpenAction(user, a.action)}
                onAction={(to) => navigate(to)}
                onPart={openPart}
              />
            ))}
          </ul>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-800 dark:text-white">Notifications</h2>
          <p className="text-xs text-slate-400 mt-0.5">
            {storeName} · worked out from the store's own data on every check, so an alert clears once its cause is fixed
          </p>
        </div>
        {code && (
          <div className="flex items-center gap-2">
            {data?.generated_at && (
              <span className="text-[11px] text-slate-400">Checked {clock(data.generated_at)}</span>
            )}
            <button
              type="button"
              onClick={() => refetch()}
              disabled={isFetching}
              className="btn-secondary inline-flex items-center gap-1.5 !py-1.5 text-xs"
            >
              <RefreshCw size={13} className={isFetching ? "animate-spin" : ""} aria-hidden="true" />
              Refresh
            </button>
          </div>
        )}
      </div>

      {code && data && summary.total > 0 && (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter by severity">
          {FILTERS.map((f) => {
            const active = severity === f.key;
            const count = f.key ? summary[f.key] : summary.total;
            const on = f.key ? SEVERITY[f.key].chip : "bg-navy-900 text-white dark:bg-white dark:text-navy-900";
            return (
              <button
                key={f.key || "all"}
                type="button"
                aria-pressed={active}
                onClick={() => setSeverity(f.key)}
                title={`${count} ${f.key ? `${f.key} ` : ""}${count === 1 ? "alert" : "alerts"}; the parts and issues listed under an alert are part of it`}
                className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors
                  ${active
                    ? `border-transparent ${on}`
                    : "border-slate-200 bg-white text-slate-600 hover:border-toyotared hover:text-toyotared dark:border-navy-700 dark:bg-navy-900 dark:text-slate-300"}`}
              >
                {f.label}
                <span className={`tabular rounded px-1.5 text-[11px] ${active ? "bg-white/20" : "bg-slate-100 dark:bg-navy-800"}`}>
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {isError && data && (
        <p className="text-xs text-amber-700 dark:text-amber-300">
          The last refresh failed — showing the alerts as of {clock(data.generated_at)}.
        </p>
      )}

      {body}

      {code && data && (
        <p className="text-[11px] leading-relaxed text-slate-400">
          Checked every 2 minutes and whenever stock moves. “Now” marks a condition that holds at the last
          check; a time marks when the event happened. Counts are alerts: the parts and issues listed
          under one belong to it and are not counted again.
          {(data.omitted || []).map((o) => (
            <span key={o.type}> Not alerted: {o.type.replace(/_/g, " ")} — {o.reason}</span>
          ))}
        </p>
      )}
    </div>
  );
}
