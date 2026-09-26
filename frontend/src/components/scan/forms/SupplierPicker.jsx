import React from "react";
import { useQuery } from "@tanstack/react-query";
import { spareFlowService } from "../../../services/spareFlowService.js";
import { fmtDate } from "../../../lib/format.js";
import { NO_SUPPLIER, inputCls } from "./flow.js";

// Supplier for a receipt or an RGP. The ERP vendors this part has actually come
// from (gate entries, then GRNs) are offered first, then the app's supplier
// master, each labelled by where it came from. A vendor code only ever arrives
// with an ERP / master option — it is never typed. "Other (name only)" records
// just a name, with supplier_source NAME_ONLY and no code, so a guess can never
// pass for an ERP vendor. `value` is the form's supplier state (flow.js
// NO_SUPPLIER / supplierPayload / supplierLabel read it).

const SOURCE = {
  GATE_ENTRY: { group: "ERP vendors — gate entries of this part", chip: "ERP vendor · gate entry" },
  ERP_GRN: { group: "ERP vendors — GRNs of this part", chip: "ERP vendor · GRN" },
  SUPPLIER_MASTER: { group: "Supplier master", chip: "Supplier master" },
};
const OTHER = "OTHER";
// A stable key per option: the list is refetched on every "stock" push, and an
// index would silently point at a different vendor if the order moved.
const keyOf = (o) => [o.source, o.ven_cd || "", o.supplier_id ?? "", o.ven_name || ""].join("|");

export default function SupplierPicker({ partId, value, onChange, id, error }) {
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ["stock", "supplier-options", partId],
    queryFn: () => spareFlowService.supplierOptions(partId).then((r) => r.data.data || []),
    enabled: Boolean(partId),
    staleTime: 5 * 60_000,
  });
  const options = data || [];

  const pick = (key) => {
    if (key === "") return onChange(NO_SUPPLIER);
    if (key === OTHER) {
      return onChange({ choice: OTHER, supplier_id: null, ven_cd: null, ven_name: "", supplier_source: "NAME_ONLY" });
    }
    const o = options.find((x) => keyOf(x) === key);
    if (!o) return onChange(NO_SUPPLIER);
    onChange({
      choice: key, supplier_id: o.supplier_id ?? null, ven_cd: o.ven_cd ?? null,
      ven_name: o.ven_name || "", supplier_source: o.source,
    });
  };

  // De-duplicated server-side; the key guard only keeps React's keys unique.
  const seen = new Set();
  const unique = options.filter((o) => !seen.has(keyOf(o)) && seen.add(keyOf(o)));
  const groups = Object.keys(SOURCE)
    .map((src) => ({ src, rows: unique.filter((o) => o.source === src) }))
    .filter((g) => g.rows.length);
  const chosen = value?.choice && value.choice !== OTHER ? value : null;

  return (
    <div className="space-y-2">
      <select id={id} value={value?.choice || ""} onChange={(e) => pick(e.target.value)}
        disabled={isPending && !isError} className={inputCls(error && value?.choice !== OTHER, "text-base")}>
        <option value="">{isPending && !isError ? "Loading suppliers…" : "Select supplier…"}</option>
        {groups.map((g) => (
          <optgroup key={g.src} label={SOURCE[g.src].group}>
            {g.rows.map((o) => (
              <option key={keyOf(o)} value={keyOf(o)}>
                {o.ven_name}{o.ven_cd ? ` · ${o.ven_cd}` : ""}{o.last_date ? ` · last ${fmtDate(o.last_date)}` : ""}
              </option>
            ))}
          </optgroup>
        ))}
        <option value={OTHER}>Other (name only)…</option>
      </select>

      {isError && (
        <p className="text-xs text-rose-600 dark:text-rose-400" role="alert">
          Couldn&apos;t load this part&apos;s suppliers — you can still enter a name only.{" "}
          <button type="button" onClick={() => refetch()} className="font-semibold underline underline-offset-2">Retry</button>
        </p>
      )}
      {!isPending && !isError && options.length === 0 && (
        <p className="text-[11px] text-slate-400">No ERP vendor or supplier-master entry found for this part — use Other (name only).</p>
      )}

      {value?.choice === OTHER && (
        <input value={value.ven_name} maxLength={160} placeholder="Supplier name as on the invoice / challan"
          aria-label="Supplier name" autoFocus
          onChange={(e) => onChange({ ...value, ven_name: e.target.value })}
          className={inputCls(error)} />
      )}

      {chosen && (
        <p className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400">
          <span className="badge badge-neutral">{SOURCE[chosen.supplier_source]?.chip || chosen.supplier_source}</span>
          {chosen.ven_cd ? <span>Vendor code <span className="font-mono font-semibold">{chosen.ven_cd}</span></span>
            : <span>No vendor code on record</span>}
        </p>
      )}
      {value?.choice === OTHER && (
        <p className="text-[11px] text-slate-400">Recorded as a name only — no vendor code is stored for it.</p>
      )}
    </div>
  );
}
