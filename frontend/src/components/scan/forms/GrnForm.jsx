import React, { useId, useMemo, useState } from "react";
import { FileCheck } from "lucide-react";
import { spareFlowService } from "../../../services/spareFlowService.js";
import { fmtDate } from "../../../lib/format.js";
import { RECEIPT_STATUS } from "../../../lib/scanStatus.js";
import { DocPicker, EmptyNote, Facts, Field, FormShell, GoneNote, Note, Segmented } from "./FormKit.jsx";
import {
  clean, fmtQty, inputCls, isFuture, todayLocal, useActionFlow, useDepartments, useDocChoice,
} from "./flow.js";
import { ReceiptCard } from "./DocCards.jsx";

// RECORD_GRN (spec 1 / 9, steps 5-6): the supervisor has created the GRN in ERP
// and the material goes to the Maintenance / Tool Room ERP ID for inspection.
// This records that GRN no. against the receipt — ERP is read-only from here,
// so nothing is posted to ERP and nothing is labelled "ERP updated". Stock is
// still not added: that waits for the quality clearance.

// The two departments that inspect spare material (spec 1). Matched against the
// department master by name, so an inactive or renamed master entry is visible
// as missing rather than silently typed in.
const QUALITY_DEPTS = ["maintenance", "tool room"];

export default function GrnForm({ scan, target, onDone, onCancel }) {
  const uid = useId();
  const { part } = scan;
  const flow = useActionFlow(onDone);
  const receipts = useMemo(
    () => (scan.open_receipts || []).filter((r) => r.status === "RECEIVED"),
    [scan.open_receipts]);
  const pick = useDocChoice(receipts, target);
  const depts = useDepartments();
  const qualityOptions = useMemo(
    () => (depts.data || [])
      .filter((d) => QUALITY_DEPTS.includes(String(d.name).trim().toLowerCase()))
      .map((d) => ({ value: d.name, label: d.name, hint: "Inspects the material under its ERP ID" })),
    [depts.data]);

  const [grnNo, setGrnNo] = useState("");
  const [grnDate, setGrnDate] = useState(todayLocal);
  const [qualityBy, setQualityBy] = useState("");
  const [remarks, setRemarks] = useState("");
  const [tried, setTried] = useState(false);

  // Kept on the confirm step while a write is in flight: this terminal's own
  // write empties the list (SSE refresh) before its response arrives.
  if (!receipts.length && !flow.review) {
    return (
      <EmptyNote onCancel={onCancel}>
        No receipt of this part is waiting for its GRN. Receive the material first — a GRN is recorded against a receipt.
      </EmptyNote>
    );
  }

  const r = pick.doc;
  const errors = {
    receipt: !r ? "Pick the receipt this GRN is for" : null,
    grnNo: !clean(grnNo) ? "Enter the GRN no. created in ERP" : null,
    grnDate: isFuture(grnDate) ? "GRN date cannot be in the future" : null,
    qualityBy: !qualityBy ? "Choose who inspects it" : null,
  };
  const valid = !Object.values(errors).some(Boolean);
  const show = (k) => (tried ? errors[k] : null);

  const review = () => {
    setTried(true);
    if (!valid) return;
    const payload = {
      grn_no: clean(grnNo), grn_date: grnDate || undefined, quality_by: qualityBy, remarks: clean(remarks),
    };
    const receipt = r;
    flow.open({
      title: "Record GRN", icon: FileCheck, part, qty: receipt.qty_received, uom: part.uom,
      moves: [{ from: RECEIPT_STATUS.RECEIVED, to: RECEIPT_STATUS.QUALITY_PENDING }],
      fields: [
        { label: "Receipt", value: receipt.receipt_no },
        { label: "GRN no. (ERP)", value: payload.grn_no },
        { label: "GRN date", value: grnDate ? fmtDate(grnDate) : null },
        { label: "Quality inspection by", value: qualityBy },
        { label: "Supplier", value: receipt.ven_name },
        { label: "Remarks", value: payload.remarks },
      ],
      note: `Recorded in this app with your ERP GRN no. — nothing is posted to ERP. Stock is still NOT added: the material now waits for ${qualityBy} quality clearance.`,
      confirmLabel: "Confirm GRN",
      submit: () => flow.run(
        () => spareFlowService.recordGrn(receipt.id, payload),
        `GRN no. ${payload.grn_no} recorded on ${receipt.receipt_no} — waiting for ${qualityBy} quality clearance`,
      ),
    });
  };

  return (
    <FormShell flow={flow} onCancel={onCancel} onReview={review} reviewLabel="Review GRN"
      verify={
        <Facts items={[
          { label: "Part No.", value: part.part_no, strong: true },
          { label: "Description", value: part.part_name },
          { label: "Received qty", value: r ? fmtQty(r.qty_received, part.uom) : null, empty: "Pick a receipt" },
        ]} />
      }>
      <DocPicker legend="Receipt" name={`${uid}-receipt`} docs={receipts} value={pick.id} onChange={pick.setId}
        error={show("receipt")} render={(d) => <ReceiptCard r={d} />} />
      {pick.gone && <GoneNote />}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="GRN no. (created in ERP)" required htmlFor={`${uid}-grn`} error={show("grnNo")}>
          <input id={`${uid}-grn`} value={grnNo} maxLength={40} onChange={(e) => setGrnNo(e.target.value)}
            className={inputCls(show("grnNo"), "text-base font-mono")} placeholder="As shown in ERP" />
        </Field>
        <Field label="GRN date" htmlFor={`${uid}-grnd`} error={show("grnDate")}>
          <input id={`${uid}-grnd`} type="date" value={grnDate} max={todayLocal()}
            onChange={(e) => setGrnDate(e.target.value)} className={inputCls(show("grnDate"))} />
        </Field>
      </div>
      <Field label="Quality inspection by" required error={show("qualityBy")}>
        {depts.isPending ? (
          <div className="skeleton h-12 w-full" aria-label="Loading departments" />
        ) : depts.isError ? (
          <p className="text-xs text-rose-600 dark:text-rose-400" role="alert">
            Couldn&apos;t load the department master.{" "}
            <button type="button" onClick={() => depts.refetch()} className="font-semibold underline underline-offset-2">Retry</button>
          </p>
        ) : qualityOptions.length === 0 ? (
          <Note tone="warn">
            Neither Maintenance nor Tool Room is an active department in the department master — ask an admin to add it.
          </Note>
        ) : (
          <Segmented label="Quality inspection by" options={qualityOptions} value={qualityBy} onChange={setQualityBy}
            columns={2} error={show("qualityBy")} />
        )}
      </Field>
      <Field label="Remarks" htmlFor={`${uid}-rem`}>
        <input id={`${uid}-rem`} value={remarks} maxLength={255} onChange={(e) => setRemarks(e.target.value)}
          className="input-field" placeholder="Optional" />
      </Field>
      <Note>
        Record the GRN you created in ERP — this app does not post to ERP. Stock is added only after the quality clearance.
      </Note>
    </FormShell>
  );
}
