import React from "react";
import { RefreshCw } from "lucide-react";
import { usePrinterStatus } from "./usePrinterStatus";
import { fmtStamp } from "../../lib/format";

// The store label printer and its status, honestly (spec 8 + contract):
// labels go out through the browser print dialog, which tells the page nothing
// about the printer — so a browser printer is "Status not detectable", never a
// made-up Online / Offline. Only a network printer an admin configured gets a
// real answer: the server tries a TCP connect to its host:port and says
// Reachable / Not reachable, with the time it checked.

const STATUS = {
  REACHABLE: { label: "Reachable", badge: "badge-success", dot: "bg-emerald-500" },
  UNREACHABLE: { label: "Not reachable", badge: "badge-danger", dot: "bg-red-500" },
  NOT_DETECTABLE: {
    label: "Status not detectable — browser print dialog", badge: "badge-neutral", dot: "bg-slate-400",
  },
};

// The status chip (+ "Check again" for a network printer, or after a failed
// check). Renders from the shared query, so it can sit anywhere.
export default function PrinterStatus({ enabled = true, className = "" }) {
  const q = usePrinterStatus({ enabled });
  const p = q.data;
  const checking = q.isFetching;
  const recheck = (
    <button
      type="button"
      onClick={() => q.refetch()}
      disabled={checking}
      className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-500 hover:text-toyotared disabled:opacity-50"
    >
      <RefreshCw size={12} className={checking ? "animate-spin" : ""} aria-hidden="true" />
      {checking ? "Checking…" : "Check again"}
    </button>
  );

  if (q.isPending) {
    return (
      <span className={`inline-flex items-center gap-2 ${className}`}>
        <span className="badge badge-neutral gap-1.5">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-slate-400" aria-hidden="true" />
          Checking printer…
        </span>
      </span>
    );
  }
  if (q.isError || !p) {
    return (
      <span className={`inline-flex flex-wrap items-center gap-2 ${className}`}>
        <span className="badge badge-neutral gap-1.5"
          title={q.error?.response?.data?.message || q.error?.message || undefined}>
          <span className="h-1.5 w-1.5 rounded-full bg-slate-400" aria-hidden="true" />
          Printer status unavailable
        </span>
        {recheck}
      </span>
    );
  }

  const meta = STATUS[p.status] || STATUS.NOT_DETECTABLE;
  const network = p.connection === "NETWORK";
  return (
    <span className={`inline-flex flex-wrap items-center gap-2 ${className}`}>
      <span className={`badge ${meta.badge} gap-1.5`} title={p.detail || undefined}>
        <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} aria-hidden="true" />
        {meta.label}
      </span>
      {network && p.checked_at && (
        <span className="text-[11px] text-slate-400">checked {fmtStamp(p.checked_at)}</span>
      )}
      {network && recheck}
    </span>
  );
}

// "Printer" field of the print dialogs: the one configured store printer (a
// select, so a second printer is a config change, not a UI change) and its
// status chip. The name shown is the name recorded with the print.
export function PrinterPicker({ id, enabled = true }) {
  const q = usePrinterStatus({ enabled });
  const name = q.data?.name;
  return (
    <div className="space-y-1.5">
      <select id={id} className="input-field" value={name || ""} disabled={!name}
        onChange={() => { /* one printer configured — nothing to switch to */ }}>
        <option value={name || ""}>
          {name || (q.isPending ? "Checking printer…" : "Browser print dialog")}
        </option>
      </select>
      <PrinterStatus enabled={enabled} />
    </div>
  );
}
