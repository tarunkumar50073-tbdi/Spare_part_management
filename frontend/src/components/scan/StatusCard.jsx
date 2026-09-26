import React from "react";
import { Activity, Info } from "lucide-react";
import Badge from "../Badge.jsx";
import ErpAsOf from "./ErpAsOf.jsx";
import { fmtStamp, num } from "../../lib/format.js";
import { statusMeta } from "../../lib/scanStatus.js";

// (c) Where the part stands (spec 22 "CURRENT STATUS"). The QR is part-level,
// so several things can be true at once — 3 in stock, 1 on a line, 1 with a
// supplier: one headline (primary_status, decided by the server) plus a chip
// per non-zero bucket with its quantity, and the quantity that may be issued.
// "Quality pending" is read from ERP (GRNs whose accepted qty ERP has not got
// yet), so it carries the ERP data's age. It promises nothing about stock: an
// accepted GRN may be skipped (part never counted, GRN on/before the stock
// baseline or before the post-from date) or auto-add may be off — the
// Receiving & GRN page shows each line's outcome and why.
export default function StatusCard({ scan, dataStatus }) {
  const head = scan.primary_status || null;
  const headMeta = statusMeta(head?.key);
  const statuses = scan.statuses || [];
  const stock = scan.stock || {};
  const uom = scan.part?.uom;
  const qualityFromErp = Number(scan.buckets?.quality_pending) > 0 && scan.erp_receiving?.erp;
  return (
    <section className="card p-4" aria-label="Current status">
      <div className="flex items-center gap-2">
        <Activity size={15} className="text-slate-400" aria-hidden="true" />
        <h2 className="kpi-label">Current status</h2>
      </div>

      <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          {/* The app's badge tint, at headline size (utilities beat .badge). */}
          <p className={`badge ${headMeta.badge} gap-2 rounded-lg px-3 py-1.5 text-base font-bold`}>
            <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${headMeta.dot}`} aria-hidden="true" />
            {head?.label || headMeta.label}
          </p>
          {statuses.length > 0 && (
            <ul className="mt-2.5 flex flex-wrap gap-1.5" aria-label="Quantity by status">
              {statuses.map((s) => {
                const m = statusMeta(s.key);
                return (
                  <li key={s.key} className={`badge ${m.badge} gap-1.5`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${m.dot}`} aria-hidden="true" />
                    {s.label || m.label}
                    <span className="tabular font-bold">{num(s.qty)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="text-right">
          <p className="kpi-label">Available to issue</p>
          <p className="kpi-value">
            {num(scan.buckets?.available ?? stock.qty_on_hand ?? 0)}
            {uom && <span className="ml-1 text-sm font-semibold text-slate-400">{uom}</span>}
          </p>
          {/* The stock-health label (min / reorder / max) — for a part never
              counted there is no health to judge, so it just says so. */}
          <div className="mt-1.5 flex items-center justify-end gap-1.5 text-[11px] text-slate-400">
            {stock.counted === false ? (
              <span>Never counted in the store</span>
            ) : (
              <>
                {stock.status && <Badge status={stock.status} />}
                {stock.last_counted_at && <span>counted {fmtStamp(stock.last_counted_at)}</span>}
              </>
            )}
          </div>
        </div>
      </div>

      {qualityFromErp && (
        <p className="mt-3 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-slate-500 dark:text-slate-400">
          <span>Quality pending is read from ERP GRNs and is not in store stock. Whether an accepted qty is added
            to stock is decided per GRN — Receiving &amp; GRN shows each line and why.</span>
          <ErpAsOf erp={scan.erp_receiving.erp} />
        </p>
      )}

      {/* Where the figure comes from, said plainly (BarcodeService._data_status):
          without a live ERP feed it is the store's own physical figure. Only a
          scan carries this — a part opened from a link does not. */}
      {dataStatus?.warning && (
        <p className="mt-3 flex items-start gap-1.5 text-xs text-slate-500 dark:text-slate-400">
          <Info size={13} className="mt-px shrink-0" aria-hidden="true" />{dataStatus.warning}
        </p>
      )}
    </section>
  );
}
