import React, { useMemo } from "react";
import { Printer, QrCode, TriangleAlert } from "lucide-react";
import { fmtStamp, num } from "../../lib/format.js";
import { qrSvgString } from "../../utils/barcodeRender.js";

// The part as its physical label shows it (spec 3 / 29): the QR — which
// carries ONLY the Part No. — beside Part No., description and location.
// Nothing dynamic is on the label; this card just mirrors it, plus the label's
// own print record so a missing or out-of-date label is noticed at the rack.

function QrImage({ value, size }) {
  // Encoded locally from the Part No. (no request). The markup is built by
  // qrSvgString from the matrix alone, with the value escaped in its label.
  const svg = useMemo(() => {
    try { return qrSvgString(value, { size }); } catch { return null; }
  }, [value, size]);
  if (!svg) {
    return (
      <div className="flex items-center justify-center rounded bg-slate-100 text-slate-400" style={{ width: size, height: size }}>
        <QrCode size={32} aria-hidden="true" />
      </div>
    );
  }
  return <div className="shrink-0 leading-none [&>svg]:h-auto [&>svg]:max-w-full" dangerouslySetInnerHTML={{ __html: svg }} />;
}

export function PartVisualPlaceholder() {
  return (
    <section className="card flex flex-col items-center p-6 text-center" aria-label="Part visual">
      <span className="flex h-14 w-14 items-center justify-center rounded-xl bg-slate-100 text-slate-400 dark:bg-navy-800">
        <QrCode size={28} aria-hidden="true" />
      </span>
      <p className="mt-3 text-sm font-semibold text-slate-700 dark:text-slate-200">No part on screen</p>
      <p className="mt-1 max-w-xs text-xs text-slate-500 dark:text-slate-400">
        Scan a part — its QR label, where it is and its history appear here.
      </p>
    </section>
  );
}

/**
 * part      scan.part
 * label     scan.label (print record)
 * onReprint opens the reprint dialog; null when a reprint isn't open to this user
 */
export default function PartVisual({ part, label, onReprint }) {
  const printed = Number(label?.printed_count) > 0;
  return (
    <section className="card p-4" aria-label="Part label">
      <h2 className="kpi-label mb-3">QR label</h2>
      {/* Always drawn black-on-white, as the printed label is — a QR needs the
          contrast in dark mode too. */}
      <div className="flex items-center gap-4 rounded-lg border border-slate-300 bg-white p-3 text-black shadow-sm">
        <QrImage value={part.part_no} size={132} />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold text-slate-500">Part No.</p>
          <p className="break-all font-mono text-lg font-bold leading-tight">{part.part_no}</p>
          <p className="mt-1.5 line-clamp-2 text-sm leading-snug">{part.part_name || "—"}</p>
          <p className="mt-1.5 text-sm"><span className="text-slate-500">Location: </span><b>{part.location || "—"}</b></p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
        <span className="inline-flex items-center gap-1.5">
          <Printer size={13} aria-hidden="true" />
          {printed ? (
            <span>
              Printed {num(label.printed_count)}×
              {Number(label.copies_total) > Number(label.printed_count) && ` (${num(label.copies_total)} labels)`}
              {label.last_printed_at && ` · last ${fmtStamp(label.last_printed_at)}`}
              {label.last_printed_by && ` by ${label.last_printed_by}`}
            </span>
          ) : (
            <span>No label printed yet</span>
          )}
        </span>
      </div>

      {label?.location_changed_since_print && (
        <div className="mt-2 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
          <TriangleAlert size={14} className="mt-px shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            The location changed since the last label was printed
            {label.last_location_printed ? <> (it says <b>{label.last_location_printed}</b>)</> : ""} — reprint so the label matches the rack.
          </span>
          {onReprint && (
            <button type="button" onClick={onReprint} className="shrink-0 font-semibold underline underline-offset-2">Reprint</button>
          )}
        </div>
      )}
    </section>
  );
}
