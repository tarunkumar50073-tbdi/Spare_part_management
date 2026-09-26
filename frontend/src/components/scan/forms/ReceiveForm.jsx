import React, { useId, useState } from "react";
import { PackagePlus } from "lucide-react";
import QtyStepper from "../../QtyStepper.jsx";
import { spareFlowService } from "../../../services/spareFlowService.js";
import { fmtDate } from "../../../lib/format.js";
import { RECEIPT_STATUS } from "../../../lib/scanStatus.js";
import { Facts, Field, FormShell, Note, Segmented } from "./FormKit.jsx";
import {
  clean, fmtQty, inputCls, isFuture, NO_SUPPLIER, qtyError, qtyOf, supplierLabel, supplierPayload, todayLocal,
  useActionFlow,
} from "./flow.js";
import SupplierPicker from "./SupplierPicker.jsx";

// RECEIVE (spec 1 / 9, steps 1-4): supplier material physically arrives and the
// store supervisor checks Part No. + Quantity + Invoice. This records THAT only —
// a SpareReceipt waiting for the supervisor's ERP GRN and the Maintenance /
// Tool Room quality clearance. Available stock does not move here; the internal
// QR label can be printed straight after, and printing adds no stock either.

const CHECKS = [
  { value: "OK", label: "OK", hint: "Matches the invoice", dot: "bg-emerald-500" },
  { value: "SHORT", label: "Short", hint: "Less than invoiced", dot: "bg-amber-500" },
  { value: "EXCESS", label: "Excess", hint: "More than invoiced", dot: "bg-amber-500" },
  { value: "DAMAGED", label: "Damaged", hint: "Arrived damaged", dot: "bg-red-500" },
];

export default function ReceiveForm({ scan, source, onDone, onCancel }) {
  const uid = useId();
  const { part, buckets } = scan;
  const flow = useActionFlow(onDone);
  const [qty, setQty] = useState(1);
  const [supplier, setSupplier] = useState(NO_SUPPLIER);
  const [invoiceNo, setInvoiceNo] = useState("");
  const [invoiceDate, setInvoiceDate] = useState("");
  const [check, setCheck] = useState("OK");
  const [remarks, setRemarks] = useState("");
  const [printLabel, setPrintLabel] = useState(true);
  const [tried, setTried] = useState(false);

  const errors = {
    qty: qtyError(qty),
    supplier: supplier.choice === "OTHER" && !clean(supplier.ven_name) ? "Enter the supplier name" : null,
    invoiceDate: isFuture(invoiceDate) ? "Invoice date cannot be in the future" : null,
    remarks: check !== "OK" && !clean(remarks) ? "Say what was short / excess / damaged" : null,
  };
  const valid = !Object.values(errors).some(Boolean);
  const show = (k) => (tried || k === "qty" ? errors[k] : null);

  const review = () => {
    setTried(true);
    if (!valid) return;
    const payload = {
      part_id: part.id,
      qty: qtyOf(qty),
      ...supplierPayload(supplier),
      invoice_no: clean(invoiceNo),
      invoice_date: invoiceDate || undefined,
      check_result: check,
      remarks: clean(remarks),
      scan_source: source || undefined,
    };
    const wantLabel = printLabel;
    flow.open({
      title: "Receive from supplier", icon: PackagePlus, part, qty: payload.qty, uom: part.uom,
      // Spec 9 flow: RECEIVED -> GRN CREATED -> QUALITY PENDING -> ... -> STOCK AVAILABLE.
      moves: [{ from: { label: "Supplier material", badge: "badge-neutral" }, to: RECEIPT_STATUS.RECEIVED }],
      fields: [
        { label: "Supplier", value: supplierLabel(supplier) },
        { label: "Invoice", value: [payload.invoice_no, invoiceDate && fmtDate(invoiceDate)].filter(Boolean).join(" · ") },
        { label: "Physical check", value: CHECKS.find((c) => c.value === check)?.label },
        { label: "Remarks", value: payload.remarks },
        { label: "Internal QR label", value: wantLabel ? "Print right after saving" : "Not now" },
      ],
      note: "Stock is NOT added now — it becomes available only after the GRN is recorded and Maintenance / Tool Room clear quality. Printing the QR label adds no stock and completes no GRN.",
      confirmLabel: "Confirm Receive",
      submit: () => flow.run(
        () => spareFlowService.receive(payload),
        (res) => {
          const no = res?.data?.data?.receipt_no;
          return `Received ${fmtQty(payload.qty, part.uom)}${no ? ` on ${no}` : ""} — waiting for GRN, not in stock yet`;
        },
        wantLabel ? { next: "PRINT_LABEL" } : undefined,
      ),
    });
  };

  return (
    <FormShell flow={flow} onCancel={onCancel} onReview={review} reviewLabel="Review receipt"
      verify={
        <Facts items={[
          { label: "Part No.", value: part.part_no, strong: true },
          { label: "Description", value: part.part_name },
          { label: "Location", value: part.location, empty: "Not set" },
          { label: "Available now", value: fmtQty(buckets?.available ?? 0, part.uom) },
          qtyOf(buckets?.quality_pending) > 0 && {
            label: "Already awaiting GRN / quality", value: fmtQty(buckets.quality_pending, part.uom),
          },
        ]} />
      }>
      {qtyOf(buckets?.quality_pending) > 0 && (
        <Note tone="warn">
          {fmtQty(buckets.quality_pending, part.uom)} of this part is already received and waiting for GRN / quality.
          Make sure this is a new delivery, not the same one again.
        </Note>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Received quantity" required htmlFor={`${uid}-qty`} error={show("qty")}
          hint={part.uom ? `In ${part.uom}` : undefined}>
          <QtyStepper id={`${uid}-qty`} value={qty} onChange={setQty} min={1} size="lg" label="Received quantity" />
        </Field>
        <Field label="Supplier" htmlFor={`${uid}-sup`} error={show("supplier")}
          hint="ERP vendors this part came from are listed first">
          <SupplierPicker id={`${uid}-sup`} partId={part.id} value={supplier} onChange={setSupplier}
            error={show("supplier")} />
        </Field>
        <Field label="Invoice no." htmlFor={`${uid}-inv`}>
          <input id={`${uid}-inv`} value={invoiceNo} maxLength={60} onChange={(e) => setInvoiceNo(e.target.value)}
            className="input-field" placeholder="As on the supplier invoice" />
        </Field>
        <Field label="Invoice date" htmlFor={`${uid}-invd`} error={show("invoiceDate")}>
          <input id={`${uid}-invd`} type="date" value={invoiceDate} max={todayLocal()}
            onChange={(e) => setInvoiceDate(e.target.value)} className={inputCls(show("invoiceDate"))} />
        </Field>
      </div>
      <Field label="Physical check (Part No. + quantity + invoice)" required>
        <Segmented label="Physical check" options={CHECKS} value={check} onChange={setCheck} />
      </Field>
      <Field label="Remarks" required={check !== "OK"} htmlFor={`${uid}-rem`} error={show("remarks")}>
        <input id={`${uid}-rem`} value={remarks} maxLength={255} onChange={(e) => setRemarks(e.target.value)}
          className={inputCls(show("remarks"))}
          placeholder={check === "OK" ? "Optional" : "What was short / excess / damaged"} />
      </Field>
      <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
        <input type="checkbox" checked={printLabel} onChange={(e) => setPrintLabel(e.target.checked)}
          className="h-4 w-4 accent-toyotared" />
        Print internal QR label now
      </label>
      <Note>
        Stock is NOT added now — it becomes available after GRN + Maintenance / Tool Room quality clearance.
      </Note>
    </FormShell>
  );
}
