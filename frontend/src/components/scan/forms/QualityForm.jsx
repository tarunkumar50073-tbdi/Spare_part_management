import React, { useId, useMemo, useState } from "react";
import { ShieldCheck } from "lucide-react";
import QtyStepper from "../../QtyStepper.jsx";
import { spareFlowService } from "../../../services/spareFlowService.js";
import { num } from "../../../lib/format.js";
import { RECEIPT_STATUS } from "../../../lib/scanStatus.js";
import { DocPicker, EmptyNote, Facts, Field, FormError, FormShell, GoneNote, Note } from "./FormKit.jsx";
import { clean, fmtQty, inputCls, qtyError, qtyOf, useActionFlow, useDocChoice } from "./flow.js";
import { ReceiptCard } from "./DocCards.jsx";

// QUALITY_CLEARANCE (spec 1 / 9, steps 7-8): Maintenance / Tool Room have
// physically inspected the material. The accepted quantity becomes Store Stock
// (one RECEIPT ledger row, the only place a supplier receipt adds stock); the
// rejected quantity is recorded as rejected. Accepted + rejected must add up
// to what was received — every piece is accounted for.

export default function QualityForm({ scan, target, onDone, onCancel }) {
  const uid = useId();
  const { part } = scan;
  const flow = useActionFlow(onDone);
  const receipts = useMemo(
    () => (scan.open_receipts || []).filter((r) => r.status === "QUALITY_PENDING"),
    [scan.open_receipts]);
  const pick = useDocChoice(receipts, target);
  const r = pick.doc;
  const received = qtyOf(r?.qty_received);

  // Accepted starts at everything received; the two steppers keep each other
  // balanced so the sum rule holds while the operator types.
  const [accepted, setAccepted] = useState(() => received);
  const [rejected, setRejected] = useState(0);
  const [remarks, setRemarks] = useState("");
  const [tried, setTried] = useState(false);
  const [forId, setForId] = useState(pick.id);
  if (forId !== pick.id) {
    // Another receipt picked — start its split afresh.
    setForId(pick.id);
    setAccepted(received);
    setRejected(0);
  }

  // Kept on the confirm step while a write is in flight: this terminal's own
  // write empties the list (SSE refresh) before its response arrives.
  if (!receipts.length && !flow.review) {
    return (
      <EmptyNote onCancel={onCancel}>
        No receipt of this part is waiting for quality clearance. A receipt reaches quality once its GRN is recorded.
      </EmptyNote>
    );
  }

  const round2 = (v) => Math.round(v * 100) / 100;
  const onAccepted = (v) => {
    setAccepted(v);
    if (Number.isFinite(Number(v)) && v !== "") setRejected(Math.max(0, round2(received - Number(v))));
  };
  const onRejected = (v) => {
    setRejected(v);
    if (Number.isFinite(Number(v)) && v !== "") setAccepted(Math.max(0, round2(received - Number(v))));
  };

  const a = Number(accepted);
  const j = Number(rejected);
  const errors = {
    receipt: !r ? "Pick the receipt that was inspected" : null,
    accepted: r ? qtyError(accepted, { max: received, allowZero: true, maxText: `Only ${num(received)} received` }) : null,
    rejected: r ? qtyError(rejected, { max: received, allowZero: true, maxText: `Only ${num(received)} received` }) : null,
    sum: r && Number.isFinite(a) && Number.isFinite(j) && Math.abs(a + j - received) > 0.005
      ? `Accepted + rejected must equal the ${num(received)} received (now ${num(round2(a + j))})` : null,
    remarks: j > 0 && !clean(remarks) ? "Say why quality rejected it" : null,
  };
  const valid = !Object.values(errors).some(Boolean);
  const show = (k) => (tried || k === "accepted" || k === "rejected" || k === "sum" ? errors[k] : null);

  const review = () => {
    setTried(true);
    if (!valid) return;
    const payload = { accepted_qty: a, rejected_qty: j, remarks: clean(remarks) };
    const receipt = r;
    const moves = [];
    if (a > 0) moves.push({ qty: a, from: RECEIPT_STATUS.QUALITY_PENDING, to: "STOCK_AVAILABLE" });
    if (j > 0) moves.push({ qty: j, from: RECEIPT_STATUS.QUALITY_PENDING, to: RECEIPT_STATUS.REJECTED });
    flow.open({
      title: "Quality clearance", icon: ShieldCheck, part, qty: received, uom: part.uom, moves,
      fields: [
        { label: "Receipt", value: receipt.receipt_no },
        { label: "GRN no.", value: receipt.grn_no },
        { label: "Inspected by", value: receipt.quality_by },
        { label: "Accepted", value: fmtQty(a, part.uom) },
        { label: "Rejected", value: fmtQty(j, part.uom) },
        { label: "Remarks", value: payload.remarks },
      ],
      note: a > 0
        ? `Adds ${fmtQty(a, part.uom)} to Store Stock — available for issue.`
        : "Nothing is added to stock — the whole receipt is recorded as rejected.",
      confirmLabel: "Confirm Clearance",
      submit: () => flow.run(
        () => spareFlowService.qualityClear(receipt.id, payload),
        a > 0
          ? `Quality cleared on ${receipt.receipt_no} — ${fmtQty(a, part.uom)} added to Store Stock${j > 0 ? `, ${fmtQty(j, part.uom)} rejected` : ""}`
          : `${receipt.receipt_no} rejected by quality — nothing added to stock`,
      ),
    });
  };

  return (
    <FormShell flow={flow} onCancel={onCancel} onReview={review} reviewLabel="Review clearance"
      verify={
        <Facts items={[
          { label: "Part No.", value: part.part_no, strong: true },
          { label: "Description", value: part.part_name },
          { label: "Received qty", value: r ? fmtQty(r.qty_received, part.uom) : null, empty: "Pick a receipt" },
          r && { label: "GRN no.", value: r.grn_no },
          r && { label: "Inspected by", value: r.quality_by },
        ]} />
      }>
      <DocPicker legend="Receipt" name={`${uid}-receipt`} docs={receipts} value={pick.id} onChange={pick.setId}
        error={show("receipt")} render={(d) => <ReceiptCard r={d} />} />
      {pick.gone && <GoneNote />}
      {r && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Accepted (to stock)" required htmlFor={`${uid}-acc`} error={show("accepted")}>
              <QtyStepper id={`${uid}-acc`} value={accepted} onChange={onAccepted} min={0} max={received} size="lg"
                label="Accepted quantity" />
            </Field>
            <Field label="Rejected" required htmlFor={`${uid}-rej`} error={show("rejected")}>
              <QtyStepper id={`${uid}-rej`} value={rejected} onChange={onRejected} min={0} max={received} size="lg"
                label="Rejected quantity" />
            </Field>
          </div>
          <FormError>{show("sum")}</FormError>
          <Field label="Remarks" required={j > 0} htmlFor={`${uid}-rem`} error={show("remarks")}>
            <input id={`${uid}-rem`} value={remarks} maxLength={255} onChange={(e) => setRemarks(e.target.value)}
              className={inputCls(show("remarks"))} placeholder={j > 0 ? "Why it was rejected" : "Optional"} />
          </Field>
          <Note>Only the accepted quantity is added to Store Stock. Rejected material is not stock.</Note>
        </>
      )}
    </FormShell>
  );
}
