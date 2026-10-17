import React from "react";
import { Ban, ExternalLink, MapPin, X } from "lucide-react";

// (b) What this part is (spec 22 "PART"): the green "Part Identified" line with
// HOW it was identified, then Part No., description and rack location — large,
// because the operator checks them against the part in hand (the VERIFY step).

// How the part was named -> the "via …" line. Only a supplier barcode repeats
// the code: that is the one the operator may want to check against the box.
function viaText({ source, code, origin }) {
  if (origin === "LINK") return "Opened from a link";
  if (source === "SUPPLIER_BARCODE") return `via Supplier barcode ${code || ""}`.trim();
  if (source === "QR_SCAN") return "via Internal QR";
  if (source === "ERP_SEARCH") return "via Part No. search";
  if (source === "MANUAL_ENTRY") return "via Manual entry";
  return "";
}

export default function IdentityCard({ part, ident, onOpenDetails, onClear }) {
  const meta = [part.uom && `UOM ${part.uom}`, part.section_name, part.sub_category || part.category].filter(Boolean);
  return (
    <section className="card p-4" aria-label="Part identified">
      <div className="flex items-start justify-between gap-3">
        <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
          <span className="inline-flex items-center gap-1.5 font-bold text-emerald-700 dark:text-emerald-300">
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-500 ring-4 ring-emerald-500/15" aria-hidden="true" />
            Part Identified
          </span>
          <span className="text-slate-500 dark:text-slate-400">{viaText(ident)}</span>
        </p>
        <div className="flex shrink-0 items-center gap-1">
          <button type="button" onClick={onOpenDetails}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold text-slate-500 hover:bg-slate-100 hover:text-toyotared dark:text-slate-400 dark:hover:bg-navy-800">
            <ExternalLink size={13} aria-hidden="true" />Part details
          </button>
          <button type="button" onClick={onClear} aria-label="Clear — scan another part"
            className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-navy-800 dark:hover:text-slate-200">
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <div className="min-w-0">
          <p className="kpi-label">Part No.</p>
          <p className="break-all font-mono text-2xl font-bold tracking-tight text-slate-900 dark:text-white sm:text-3xl">{part.part_no}</p>
          <p className="mt-1 text-base font-medium text-slate-700 dark:text-slate-200">
            {part.part_name || <span className="text-slate-400">No description in Part Master</span>}
          </p>
          {meta.length > 0 && <p className="mt-0.5 text-xs text-slate-400">{meta.join(" · ")}</p>}
        </div>
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 dark:border-navy-700 dark:bg-navy-800/60">
          {/* A part can sit in two places — the shelf for new parts and, separately,
              the rework shelf — so both are shown when set, labelled New / Rework
              (the store's words). */}
          <p className="kpi-label">{part.rework_location ? "Location · New" : "Location"}</p>
          <p className="flex items-center gap-1.5 text-lg font-bold text-slate-900 dark:text-white">
            <MapPin size={16} className="text-toyotared" aria-hidden="true" />
            {part.location || <span className="text-sm font-medium text-slate-400">No location set</span>}
          </p>
          {part.rework_location && (
            <p className="mt-1.5 flex items-center gap-1.5 text-base font-bold text-amber-700 dark:text-amber-300">
              <MapPin size={15} aria-hidden="true" />
              <span className="text-[11px] font-semibold uppercase tracking-wide">Rework</span>
              {part.rework_location}
            </p>
          )}
        </div>
      </div>

      {part.is_active === false && (
        <p className="mt-3 flex items-center gap-2 rounded-lg bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
          <Ban size={15} aria-hidden="true" />Part is inactive — nothing can be issued, returned or labelled until it is reactivated.
        </p>
      )}
    </section>
  );
}
