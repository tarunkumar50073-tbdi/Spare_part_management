import React, { useId, useMemo, useState } from "react";
import { PackageCheck } from "lucide-react";
import QtyStepper from "../../QtyStepper.jsx";
import { spareFlowService } from "../../../services/spareFlowService.js";
import { fmtDate, num } from "../../../lib/format.js";
import { DocPicker, EmptyNote, Facts, Field, FormShell, GoneNote, Note } from "./FormKit.jsx";
import {
  clean, fmtQty, inputCls, isFuture, qtyError, qtyOf, stepMin, todayLocal, useActionFlow, useDocChoice,
} from "./flow.js";
import { RgpCard } from "./DocCards.jsx";

// RGP_GRN (spec 18 / 19): the Store Supervisor has completed the RGP GRN in
// ERP for material the supplier brought back. Recording it here with that GRN
// no. adds the quantity back to Store Stock (a RECEIPT ledger row) and closes
// the RGP once everything sent is back. Nothing is posted to ERP from here.

export default function RgpGrnForm({ scan, target, onDone, onCancel }) {
  const uid = useId();
  const { part } = scan;
  const flow = useActionFlow(onDone);
  const rgps = useMemo(() => (scan.open_rgps || []).filter((g) => qtyOf(g.qty_grn_pending) > 0), [scan.open_rgps]);
  const pick = useDocChoice(rgps, target);
  const rgp = pick.doc;
  const pending = qtyOf(rgp?.qty_grn_pending);

  const [qty, setQty] = useState(() => pending);
  const [grnNo, setGrnNo] = useState("");
  const [grnDate, setGrnDate] = useState(todayLocal);
  const [remarks, setRemarks] = useState("");
  const [tried, setTried] = useState(false);
  const [forId, setForId] = useState(pick.id);
  if (forId !== pick.id) {
    setForId(pick.id);
    setQty(pending);
  }

  // Kept on the confirm step while a write is in flight: this terminal's own
  // write empties the list (SSE refresh) before its response arrives.
  if (!rgps.length && !flow.review) {
    return (
      <EmptyNote onCancel={onCancel}>
        No RGP of this part is waiting for its GRN. Receive the supplier&apos;s return first (RGP Return).
      </EmptyNote>
    );
  }

  const errors = {
    rgp: !rgp ? "Pick the RGP this GRN is for" : null,
    qty: rgp ? qtyError(qty, { max: pending, maxText: `Only ${fmtQty(pending, part.uom)} is back and waiting for GRN on this RGP` }) : null,
    grnNo: !clean(grnNo) ? "Enter the RGP GRN no. created in ERP" : null,
    grnDate: isFuture(grnDate) ? "GRN date cannot be in the future" : null,
  };
  const valid = !Object.values(errors).some(Boolean);
  const show = (k) => (tried || k === "qty" ? errors[k] : null);

  const review = () => {
    setTried(true);
    if (!valid) return;
    const g = rgp;
    const payload = { qty: qtyOf(qty), grn_no: clean(grnNo), grn_date: grnDate || undefined, remarks: clean(remarks) };
    // Closes when this GRN brings the whole RGP quantity back (contract rule).
    const closes = qtyOf(g.qty_grn) + payload.qty >= qtyOf(g.qty_out) - 0.005;
    flow.open({
      title: "RGP GRN", icon: PackageCheck, part, qty: payload.qty, uom: part.uom,
      moves: [{ from: "RGP_GRN_PENDING", to: "STOCK_AVAILABLE" }],
      fields: [
        { label: "RGP No.", value: g.rgp_no },
        { label: "Supplier", value: g.ven_name },
        { label: "RGP GRN no. (ERP)", value: payload.grn_no },
        { label: "GRN date", value: grnDate ? fmtDate(grnDate) : null },
        { label: "RGP after this", value: closes ? "Closed — everything sent is back in stock" : "Stays open" },
        { label: "Remarks", value: payload.remarks },
      ],
      note: `Adds ${fmtQty(payload.qty, part.uom)} back to Store Stock — available for issue. Recorded in this app with your ERP GRN no. — nothing is posted to ERP.`,
      confirmLabel: "Confirm RGP GRN",
      submit: () => flow.run(
        () => spareFlowService.rgpGrn(g.id, payload),
        `RGP GRN no. ${payload.grn_no} recorded — ${fmtQty(payload.qty, part.uom)} back in Store Stock${closes ? ` · ${g.rgp_no} closed` : ""}`,
      ),
    });
  };

  return (
    <FormShell flow={flow} onCancel={onCancel} onReview={review} reviewLabel="Review RGP GRN"
      verify={
        <Facts items={[
          { label: "RGP No.", value: rgp?.rgp_no, strong: true, empty: "Pick the RGP" },
          { label: "Supplier", value: rgp?.ven_name, empty: rgp ? "Not recorded" : "—" },
          { label: "Part No.", value: part.part_no },
          { label: "Description", value: part.part_name },
          { label: "Back, GRN pending", value: rgp ? fmtQty(pending, part.uom) : null },
          { label: "RGP out date", value: rgp ? fmtDate(rgp.rgp_date) : null },
        ]} />
      }>
      <DocPicker legend="RGP waiting for GRN" name={`${uid}-rgp`} docs={rgps} value={pick.id} onChange={pick.setId}
        error={show("rgp")}
        render={(d) => <RgpCard g={d} qty={d.qty_grn_pending} qtyLabel="GRN pending" />} />
      {pick.gone && <GoneNote />}
      {rgp && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Quantity" required htmlFor={`${uid}-qty`} error={show("qty")}
              hint={`Up to ${num(pending)}${part.uom ? ` ${part.uom}` : ""}`}>
              <QtyStepper id={`${uid}-qty`} value={qty} onChange={setQty} min={stepMin(pending)} max={pending}
                size="lg" label="RGP GRN quantity" />
            </Field>
            <Field label="RGP GRN no. (created in ERP)" required htmlFor={`${uid}-grn`} error={show("grnNo")}>
              <input id={`${uid}-grn`} value={grnNo} maxLength={40} onChange={(e) => setGrnNo(e.target.value)}
                className={inputCls(show("grnNo"), "text-base font-mono")} placeholder="As shown in ERP" />
            </Field>
            <Field label="GRN date" htmlFor={`${uid}-gd`} error={show("grnDate")}>
              <input id={`${uid}-gd`} type="date" value={grnDate} max={todayLocal()}
                onChange={(e) => setGrnDate(e.target.value)} className={inputCls(show("grnDate"))} />
            </Field>
            <Field label="Remarks" htmlFor={`${uid}-rem`}>
              <input id={`${uid}-rem`} value={remarks} maxLength={255} onChange={(e) => setRemarks(e.target.value)}
                className="input-field" placeholder="Optional" />
            </Field>
          </div>
          <Note>Stock is added back to Store Stock once you confirm.</Note>
        </>
      )}
    </FormShell>
  );
}
