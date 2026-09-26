import React from "react";
import { MapPinned } from "lucide-react";
import { num } from "../../lib/format.js";
import ErpAsOf from "./ErpAsOf.jsx";
import { LOCATION_ICON, TONE_CHIP } from "./scanIcons.js";

// Where the part's quantity physically is (spec 22 "CURRENT LOCATION", spec 30
// "Where is it?"): the store rack, Quality (ERP GRNs whose quality clearance
// ERP has not recorded yet), each line / machine / die it was issued to, the
// return-hold area, each supplier with rework. Rows are built by the server
// from the open documents and the ERP GRN lines — part level, so a line row
// means "N of this part were issued there", never that a particular piece is
// on that machine. `erp` is the GRN mirror's freshness, shown with the Quality
// rows read from ERP.
const KIND_TONE = { STORE: "success", QUALITY: "warning", LINE: "info", RETURN_HOLD: "warning", SUPPLIER: "warning" };

// The server's label already names the department / line / supplier where it
// matters ("Issued – Maintenance · …", "With ABC – rework (RGP-…)"); the line
// under it adds only what the label doesn't say yet — typically who has it.
const detailOf = (l) => {
  const said = String(l.label || "").toLowerCase();
  const line = [l.line_name, l.line_no].filter(Boolean).join(" ");
  return [
    [l.department, l.department],
    [l.issued_to, l.issued_to && `to ${l.issued_to}`],
    [line, line && (/^line\b/i.test(line) ? line : `Line ${line}`)],
    [l.machine, l.machine && `Machine ${l.machine}`],
    [l.die_no, l.die_no && `Die ${l.die_no}`],
    [l.supplier, l.supplier],
  ].filter(([raw, text]) => text && !said.includes(String(raw).toLowerCase()))
    .map(([, text]) => text)
    .join(" · ");
};

export default function LocationList({ locations = [], uom, erp = null }) {
  const fromErp = erp && locations.some((l) => l.kind === "QUALITY");
  return (
    <section className="card p-4" aria-label="Current location">
      <h2 className="kpi-label mb-2.5 flex items-center gap-1.5">
        <MapPinned size={14} aria-hidden="true" />Current location
      </h2>
      {locations.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          No quantity is recorded anywhere for this part — not counted in the store, nothing issued, returned or with a supplier.
        </p>
      ) : (
        <ul className="space-y-2">
          {locations.map((l, i) => {
            const Icon = LOCATION_ICON[l.kind] || MapPinned;
            const detail = detailOf(l);
            // One document can sit in two places (a return part pending, part
            // held), so the position is part of the key.
            return (
              <li key={`${l.kind}-${l.ref_type || ""}-${l.ref_id ?? ""}-${i}`} className="flex items-start gap-3">
                <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${TONE_CHIP[KIND_TONE[l.kind]] || TONE_CHIP.neutral}`}>
                  <Icon size={15} aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{l.label}</p>
                  {detail && <p className="break-words text-xs text-slate-500 dark:text-slate-400">{detail}</p>}
                </div>
                <span className="shrink-0 text-sm font-bold tabular text-slate-800 dark:text-white">
                  {num(l.qty)}{uom && <span className="ml-0.5 text-[11px] font-medium text-slate-400">{uom}</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {fromErp && <ErpAsOf erp={erp} className="mt-2.5" />}
    </section>
  );
}
