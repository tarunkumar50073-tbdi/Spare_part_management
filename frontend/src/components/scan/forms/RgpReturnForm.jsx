import React, { useId, useMemo, useState } from "react";
import { PackageOpen, Undo2 } from "lucide-react";
import QtyStepper from "../../QtyStepper.jsx";
import { StatusBadge } from "../ActionConfirm.jsx";
import { spareFlowService } from "../../../services/spareFlowService.js";
import { fmtDate, num } from "../../../lib/format.js";
import { DocPicker, EmptyNote, Facts, Field, FormShell, GoneNote, Note } from "./FormKit.jsx";
import { clean, fmtQty, qtyError, qtyOf, stepMin, useActionFlow, useDocChoice } from "./flow.js";
import { RgpCard } from "./DocCards.jsx";

// RGP_RETURN (spec 18): the reworked material is back from the supplier. The
// operator scans the same QR, the open RGP is found, and the store receives the
// quantity against it. This is NOT stock yet — the Store Supervisor completes
// the RGP GRN next, and only that adds it back to Store Stock (spec 19).

const RECEIVED = { label: "Supplier Material Received", badge: "badge-success", dot: "bg-emerald-500" };

export default function RgpReturnForm({ scan, target, onDone, onCancel }) {
  const uid = useId();
  const { part } = scan;
  const flow = useActionFlow(onDone);
  const rgps = useMemo(() => (scan.open_rgps || []).filter((g) => qtyOf(g.qty_with_supplier) > 0), [scan.open_rgps]);
  const pick = useDocChoice(rgps, target);
  const rgp = pick.doc;
  const withSupplier = qtyOf(rgp?.qty_with_supplier);

  const [qty, setQty] = useState(() => withSupplier);
  const [remarks, setRemarks] = useState("");
  const [tried, setTried] = useState(false);
  const [forId, setForId] = useState(pick.id);
  if (forId !== pick.id) {
    setForId(pick.id);
    setQty(withSupplier);
  }

  // Kept on the confirm step while a write is in flight: this terminal's own
  // write empties the list (SSE refresh) before its response arrives.
  if (!rgps.length && !flow.review) {
    return <EmptyNote onCancel={onCancel}>No RGP of this part is with a supplier — nothing to receive back.</EmptyNote>;
  }

  const errors = {
    rgp: !rgp ? "Pick the RGP the material came back on" : null,
    qty: rgp ? qtyError(qty, { max: withSupplier, maxText: `Only ${fmtQty(withSupplier, part.uom)} is with the supplier on this RGP` }) : null,
  };
  const valid = !Object.values(errors).some(Boolean);
  const show = (k) => (tried || k === "qty" ? errors[k] : null);

  const review = () => {
    setTried(true);
    if (!valid) return;
    const g = rgp;
    const payload = { qty: qtyOf(qty), remarks: clean(remarks) };
    flow.open({
      title: "RGP Return", icon: Undo2, part, qty: payload.qty, uom: part.uom,
      moves: [{ from: "WITH_SUPPLIER", to: "RGP_GRN_PENDING" }],
      fields: [
        { label: "RGP No.", value: g.rgp_no },
        { label: "Supplier", value: g.ven_name ? `${g.ven_name}${g.ven_cd ? ` · ${g.ven_cd}` : ""}` : null },
        { label: "RGP out date", value: fmtDate(g.rgp_date) },
        { label: "Still with supplier after this", value: fmtQty(Math.round((withSupplier - payload.qty) * 100) / 100, part.uom) },
        { label: "Remarks", value: payload.remarks },
      ],
      note: "Not added to stock yet — the Store Supervisor records the RGP GRN next, and that adds it back to Store Stock.",
      confirmLabel: "Receive Against RGP",
      submit: () => flow.run(
        () => spareFlowService.rgpSupplierReturn(g.id, payload),
        `${g.rgp_no}: ${fmtQty(payload.qty, part.uom)} received from ${g.ven_name || "the supplier"} — RGP GRN pending, not in stock yet`,
      ),
    });
  };

  return (
    <FormShell flow={flow} onCancel={onCancel} onReview={review} reviewLabel="Receive Against RGP" reviewIcon={PackageOpen}
      verify={
        <div className="space-y-2">
          <p className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">RGP Return</span>
            <StatusBadge status={RECEIVED} />
          </p>
          <Facts items={[
            { label: "RGP No.", value: rgp?.rgp_no, strong: true, empty: "Pick the RGP" },
            { label: "Supplier", value: rgp?.ven_name, empty: rgp ? "Not recorded" : "—" },
            { label: "Part No.", value: part.part_no },
            { label: "Description", value: part.part_name },
            { label: "Qty with supplier", value: rgp ? fmtQty(withSupplier, part.uom) : null },
            { label: "RGP out date", value: rgp ? fmtDate(rgp.rgp_date) : null },
          ]} />
        </div>
      }>
      <DocPicker legend="Open RGP" name={`${uid}-rgp`} docs={rgps} value={pick.id} onChange={pick.setId}
        error={show("rgp")}
        render={(d) => <RgpCard g={d} qty={d.qty_with_supplier} qtyLabel="with supplier" />} />
      {pick.gone && <GoneNote />}
      {rgp && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Quantity received back" required htmlFor={`${uid}-qty`} error={show("qty")}
              hint={`Up to ${num(withSupplier)}${part.uom ? ` ${part.uom}` : ""}`}>
              <QtyStepper id={`${uid}-qty`} value={qty} onChange={setQty} min={stepMin(withSupplier)} max={withSupplier}
                size="lg" label="Quantity received back" />
            </Field>
            <Field label="Remarks" htmlFor={`${uid}-rem`}>
              <input id={`${uid}-rem`} value={remarks} maxLength={255} onChange={(e) => setRemarks(e.target.value)}
                className="input-field" placeholder="Supplier challan / condition (optional)" />
            </Field>
          </div>
          <Note>The RGP GRN comes next: the Store Supervisor records it, and only then is the material back in Store Stock.</Note>
        </>
      )}
    </FormShell>
  );
}
