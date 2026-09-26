import React, { useId, useMemo, useState } from "react";
import { Truck } from "lucide-react";
import QtyStepper from "../../QtyStepper.jsx";
import { spareFlowService } from "../../../services/spareFlowService.js";
import { reasonLabel } from "../../../lib/scanStatus.js";
import { fmtDate, num } from "../../../lib/format.js";
import { DocPicker, EmptyNote, Facts, Field, FormShell, GoneNote, Note, Segmented } from "./FormKit.jsx";
import {
  clean, fmtQty, inputCls, isFuture, NO_SUPPLIER, qtyError, qtyOf, stepMin, supplierLabel, supplierPayload,
  todayLocal, useActionFlow, useDocChoice,
} from "./flow.js";
import { ReturnCard } from "./DocCards.jsx";
import SupplierPicker from "./SupplierPicker.jsx";

// RGP_OUT (spec 15-17): send returned material to a supplier for rework under
// an RGP challan ("RGP OUT – REWORK"). There is NO direct RGP: the quantity is
// always drawn from a return the store has inspected and set aside (Inspection
// Required hold or Damaged). While with the supplier it is not stock.

const FROM = {
  DAMAGED: { col: "qty_damaged", label: "Damaged", status: "DAMAGED" },
  RETURN_HOLD: { col: "qty_hold", label: "Return hold", status: "RETURN_HOLD" },
};
const FROM_ORDER = ["DAMAGED", "RETURN_HOLD"];
// Backend default (contract): damaged first, else the hold.
const defaultFrom = (r) => (qtyOf(r?.qty_damaged) > 0 ? "DAMAGED" : "RETURN_HOLD");
const eligible = (r) => qtyOf(r?.qty_hold) + qtyOf(r?.qty_damaged);

export default function RgpOutForm({ scan, target, onDone, onCancel }) {
  const uid = useId();
  const { part } = scan;
  const flow = useActionFlow(onDone);
  const returns = useMemo(() => (scan.open_returns || []).filter((r) => eligible(r) > 0), [scan.open_returns]);
  const pick = useDocChoice(returns, target);
  const ret = pick.doc;

  const [from, setFrom] = useState(() => defaultFrom(ret));
  const bucketQty = qtyOf(ret?.[FROM[from].col]);
  const [qty, setQty] = useState(() => bucketQty);
  const [supplier, setSupplier] = useState(NO_SUPPLIER);
  const [reason, setReason] = useState("");
  const [remarks, setRemarks] = useState("");
  const [rgpDate, setRgpDate] = useState(todayLocal);
  const [expected, setExpected] = useState("");
  const [challan, setChallan] = useState("");
  const [tried, setTried] = useState(false);
  const [forId, setForId] = useState(pick.id);
  if (forId !== pick.id) {
    const f = defaultFrom(ret);
    setForId(pick.id);
    setFrom(f);
    setQty(qtyOf(ret?.[FROM[f].col]));
  }

  // Kept on the confirm step while a write is in flight: this terminal's own
  // write empties the list (SSE refresh) before its response arrives.
  if (!returns.length && !flow.review) {
    return (
      <EmptyNote onCancel={onCancel}>
        Nothing of this part can go for rework. An RGP is made only from returned material the store has inspected and
        held (Inspection Required) or marked Damaged — there is no direct RGP from stock.
      </EmptyNote>
    );
  }

  const fromChoices = ret ? FROM_ORDER.filter((k) => qtyOf(ret[FROM[k].col]) > 0) : [];
  const chooseFrom = (f) => { setFrom(f); setQty(qtyOf(ret?.[FROM[f].col])); };
  if (ret && bucketQty <= 0 && fromChoices.length) chooseFrom(defaultFrom(ret));

  const errors = {
    ret: !ret ? "Pick the return to send for rework" : null,
    qty: ret ? qtyError(qty, { max: bucketQty, maxText: `Only ${fmtQty(bucketQty, part.uom)} is ${FROM[from].label.toLowerCase()}` }) : null,
    supplier: !clean(supplier.ven_name) ? (supplier.choice === "OTHER" ? "Enter the supplier name" : "Choose the supplier") : null,
    reason: !clean(reason) ? "Enter the rework reason" : null,
    rgpDate: !rgpDate ? "Enter the RGP date" : isFuture(rgpDate) ? "RGP date cannot be in the future" : null,
    expected: expected && rgpDate && expected < rgpDate ? "Expected return cannot be before the RGP date" : null,
  };
  const valid = !Object.values(errors).some(Boolean);
  const show = (k) => (tried || k === "qty" ? errors[k] : null);

  const review = () => {
    setTried(true);
    if (!valid) return;
    const r = ret;
    const payload = {
      qty: qtyOf(qty),
      // Always the bucket the operator confirmed — the server re-derives its
      // default after the lock, so an omitted bucket could send hold material
      // when another terminal scrapped the damaged quantity meanwhile.
      from_bucket: from,
      ...supplierPayload(supplier),
      rework_reason: clean(reason),
      remarks: clean(remarks),
      rgp_date: rgpDate,
      expected_return_date: expected || undefined,
      erp_challan_no: clean(challan),
    };
    flow.open({
      title: "RGP Out – Rework", icon: Truck, part, qty: payload.qty, uom: part.uom,
      moves: [{ from: FROM[from].status, to: "WITH_SUPPLIER" }],
      fields: [
        { label: "Supplier", value: supplierLabel(supplier) },
        { label: "Rework reason", value: payload.rework_reason },
        { label: "From return", value: r.return_no },
        { label: "RGP date", value: fmtDate(rgpDate) },
        { label: "Expected return", value: expected ? fmtDate(expected) : null },
        { label: "ERP challan no.", value: payload.erp_challan_no },
        { label: "Remarks", value: payload.remarks },
      ],
      note: "With Supplier – Rework is NOT available stock. It comes back through RGP Return and the RGP GRN.",
      confirmLabel: "Create RGP",
      submit: () => flow.run(
        () => spareFlowService.rgpOut(r.id, payload),
        (res) => {
          const d = res?.data?.data || {};
          const no = d.rgp_no || d.rgp?.rgp_no;
          return `${no || "RGP"} created — ${fmtQty(payload.qty, part.uom)} With Supplier – Rework, not available stock`;
        },
      ),
    });
  };

  return (
    <FormShell flow={flow} onCancel={onCancel} onReview={review} reviewLabel="Review RGP"
      verify={
        <Facts items={[
          { label: "Part No.", value: part.part_no, strong: true },
          { label: "Description", value: part.part_name },
          { label: "Returned qty eligible", value: ret ? fmtQty(eligible(ret), part.uom) : fmtQty(
            qtyOf(scan.buckets?.return_hold) + qtyOf(scan.buckets?.damaged), part.uom), strong: true },
          { label: "Current location",
            value: scan.locations?.find((l) => l.kind === "RETURN_HOLD")?.label || "In store — set aside after return inspection" },
          { label: "Rack location", value: part.location, empty: "Not set" },
          part.rework_location && { label: "Rework shelf", value: part.rework_location },
        ]} />
      }>
      <DocPicker legend="Returned material" name={`${uid}-ret`} docs={returns} value={pick.id} onChange={pick.setId}
        error={show("ret")} render={(d) => <ReturnCard r={d} />} />
      {pick.gone && <GoneNote />}
      {ret && (
        <>
          {fromChoices.length > 1 && (
            <Field label="Send the quantity that is" required>
              <Segmented label="Send from" value={from} onChange={chooseFrom} columns={2}
                options={fromChoices.map((k) => ({
                  value: k, label: FROM[k].label, hint: `${num(ret[FROM[k].col])}${part.uom ? ` ${part.uom}` : ""}`,
                }))} />
            </Field>
          )}
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Returned by {ret.department || "—"}{ret.issued_to ? ` · ${ret.issued_to}` : ""} · reason {reasonLabel(ret.reason)}
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Supplier" required htmlFor={`${uid}-sup`} error={show("supplier")}
              hint="ERP vendors this part came from are listed first">
              <SupplierPicker id={`${uid}-sup`} partId={part.id} value={supplier} onChange={setSupplier}
                error={show("supplier")} />
            </Field>
            <Field label="Quantity" required htmlFor={`${uid}-qty`} error={show("qty")}
              hint={`Up to ${num(bucketQty)}${part.uom ? ` ${part.uom}` : ""}`}>
              <QtyStepper id={`${uid}-qty`} value={qty} onChange={setQty} min={stepMin(bucketQty)} max={bucketQty}
                size="lg" label="RGP quantity" />
            </Field>
            <Field label="Rework reason" required htmlFor={`${uid}-rsn`} error={show("reason")} className="sm:col-span-2">
              <input id={`${uid}-rsn`} value={reason} maxLength={120} onChange={(e) => setReason(e.target.value)}
                className={inputCls(show("reason"))} placeholder="What the supplier must repair" />
            </Field>
            <Field label="RGP date" required htmlFor={`${uid}-rd`} error={show("rgpDate")}>
              <input id={`${uid}-rd`} type="date" value={rgpDate} max={todayLocal()}
                onChange={(e) => setRgpDate(e.target.value)} className={inputCls(show("rgpDate"))} />
            </Field>
            <Field label="Expected return date" htmlFor={`${uid}-ed`} error={show("expected")}>
              <input id={`${uid}-ed`} type="date" value={expected} min={rgpDate || undefined}
                onChange={(e) => setExpected(e.target.value)} className={inputCls(show("expected"))} />
            </Field>
            <Field label="ERP challan no." htmlFor={`${uid}-ch`} hint="If the RGP challan is already made in ERP">
              <input id={`${uid}-ch`} value={challan} maxLength={40} onChange={(e) => setChallan(e.target.value)}
                className="input-field font-mono" placeholder="Optional" />
            </Field>
            <Field label="Remarks" htmlFor={`${uid}-rem`}>
              <input id={`${uid}-rem`} value={remarks} maxLength={255} onChange={(e) => setRemarks(e.target.value)}
                className="input-field" placeholder="Optional" />
            </Field>
          </div>
          <Note tone="warn">After this the material is With Supplier – Rework — never shown as available stock.</Note>
        </>
      )}
    </FormShell>
  );
}
