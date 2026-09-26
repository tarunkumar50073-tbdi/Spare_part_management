import React from "react";
import { Database } from "lucide-react";
import { fmtDate, fmtStamp, parseServerTime } from "../../lib/format.js";

// How fresh an ERP mirror is — said next to every figure read from ERP, so a
// stale mirror is never read as today's truth. `erp` is { synced_at,
// newest_grn_date } for the GRN register (ErpGrnPostingService.mirror_freshness)
// or { synced_at, newest_gate_date } for the gate entries (GateLabelService).
// Amber once the mirror is more than a day old (or has never been filled).

const DAY_MS = 24 * 60 * 60 * 1000;

function erpAsOf(erp) {
  const synced = parseServerTime(erp?.synced_at);
  const ageDays = synced ? Math.floor((Date.now() - synced.getTime()) / DAY_MS) : null;
  const parts = [
    synced ? `ERP data as of ${fmtStamp(erp.synced_at)}${ageDays >= 1 ? ` (${ageDays} d old)` : ""}` : "ERP data not read yet",
    erp?.newest_grn_date && `newest GRN ${fmtDate(erp.newest_grn_date)}`,
    erp?.newest_gate_date && `newest gate entry ${fmtDate(erp.newest_gate_date)}`,
  ].filter(Boolean);
  return { text: parts.join(" · "), stale: !synced || ageDays >= 1 };
}

export default function ErpAsOf({ erp, className = "" }) {
  if (!erp) return null;
  const { text, stale } = erpAsOf(erp);
  const register = erp.newest_gate_date !== undefined ? "gate entries" : "GRN register";
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] ${stale
      ? "text-amber-700 dark:text-amber-300" : "text-slate-400"} ${className}`}
      title={`The last time the app's copy of the ERP ${register} took in data — a mirror, not a live feed`}>
      <Database size={12} className="shrink-0" aria-hidden="true" />{text}
    </span>
  );
}
