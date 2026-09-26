import React, { useId, useMemo, useState } from "react";
import { ClipboardCheck } from "lucide-react";
import QtyStepper from "../../QtyStepper.jsx";
import { spareFlowService } from "../../../services/spareFlowService.js";
import { INSPECTION_RESULTS, reasonLabel } from "../../../lib/scanStatus.js";
import { num } from "../../../lib/format.js";
import { DocPicker, EmptyNote, Facts, Field, FormShell, GoneNote, Note, Segmented } from "./FormKit.jsx";
import { clean, fmtQty, placeText, qtyError, qtyOf, stepMin, useActionFlow, useDocChoice } from "./flow.js";
import { ReturnCard } from "./DocCards.jsx";

// INSPECT (spec 14): the store inspects a part a department returned. Only
// Good / Reusable goes back to Store Stock; Inspection Required holds it,
// Damaged sets it aside (for RGP rework or scrap), Scrap disposes of it. A
// return never becomes available stock without this step.
//
// A return's quantity can sit in three not-yet-decided places; which results
// each may take is the backend rule (contract "Inspect"):
//   PENDING -> Good | Inspection Required | Damaged | Scrap
//   HOLD    -> Good | Damaged | Scrap
//   DAMAGED -> Scrap   (damaged material leaves by RGP rework or scrap)
const FROM = {
  PENDING: { col: "qty_pending", label: "Returned – to inspect", status: "RETURN_INSPECTION",
    results: ["GOOD", "INSPECTION_REQUIRED", "DAMAGED", "SCRAP"] },
  HOLD: { col: "qty_hold", label: "Return hold", status: "RETURN_HOLD", results: ["GOOD", "DAMAGED", "SCRAP"] },
  DAMAGED: { col: "qty_damaged", label: "Damaged", status: "DAMAGED", results: ["SCRAP"] },
};
const FROM_ORDER = ["PENDING", "HOLD", "DAMAGED"];

// Where each result lands, as a status badge for the confirm step.
const TO_STATUS = {
  GOOD: "STOCK_AVAILABLE",
  INSPECTION_REQUIRED: "RETURN_HOLD",
  DAMAGED: "DAMAGED",
  SCRAP: { label: "Scrap / Disposal", badge: "badge-neutral", dot: "bg-slate-800 dark:bg-slate-300" },
};

// The backend's own default (contract): pending first, then hold, then damaged.
const defaultFrom = (r) => FROM_ORDER.find((k) => qtyOf(r?.[FROM[k].col]) > 0) || "PENDING";

export default function InspectForm({ scan, target, onDone, onCancel }) {
  const uid = useId();
  const { part } = scan;
  const flow = useActionFlow(onDone);
  const returns = useMemo(
    () => (scan.open_returns || []).filter((r) => FROM_ORDER.some((k) => qtyOf(r[FROM[k].col]) > 0)),
    [scan.open_returns]);
  const pick = useDocChoice(returns, target);
  const ret = pick.doc;

  const [from, setFrom] = useState(() => defaultFrom(ret));
  const bucketQty = qtyOf(ret?.[FROM[from].col]);
  const [result, setResult] = useState("");
  const [qty, setQty] = useState(() => bucketQty);
  const [remarks, setRemarks] = useState("");
  const [tried, setTried] = useState(false);
  const [forId, setForId] = useState(pick.id);
  if (forId !== pick.id) {
    // Another return picked — its own default bucket and full quantity.
    const f = defaultFrom(ret);
    setForId(pick.id);
    setFrom(f);
    setQty(qtyOf(ret?.[FROM[f].col]));
    setResult("");
  }

  // Kept on the confirm step while a write is in flight: this terminal's own
  // write empties the list (SSE refresh) before its response arrives.
  if (!returns.length && !flow.review) {
    return (
      <EmptyNote onCancel={onCancel}>
        No returned material of this part is waiting for inspection.
      </EmptyNote>
    );
  }

  const fromChoices = ret ? FROM_ORDER.filter((k) => qtyOf(ret[FROM[k].col]) > 0) : [];
  const chooseFrom = (f) => {
    setFrom(f);
    setQty(qtyOf(ret?.[FROM[f].col]));
    if (!FROM[f].results.includes(result)) setResult("");
  };
  // The return was refreshed (another terminal inspected part of it) and the
  // chosen state is now empty — move to what is left instead of a dead end.
  if (ret && bucketQty <= 0 && fromChoices.length) chooseFrom(defaultFrom(ret));
  const allowed = INSPECTION_RESULTS.filter((x) => FROM[from].results.includes(x.key));

  const errors = {
    ret: !ret ? "Pick the return being inspected" : null,
    from: ret && bucketQty <= 0 ? "Nothing of this return is in that state — pick another" : null,
    result: !result ? "Choose the condition" : null,
    qty: ret ? qtyError(qty, { max: bucketQty, maxText: `Only ${fmtQty(bucketQty, part.uom)} is ${FROM[from].label.toLowerCase()}` }) : null,
  };
  const valid = !Object.values(errors).some(Boolean);
  const show = (k) => (tried || k === "qty" ? errors[k] : null);

  const review = () => {
    setTried(true);
    if (!valid) return;
    const r = ret;
    const res = INSPECTION_RESULTS.find((x) => x.key === result);
    const payload = {
      result, qty: qtyOf(qty), remarks: clean(remarks),
      // Always the bucket the operator confirmed. Left out, the server works
      // its default out again inside the lock from the return as it is THEN:
      // if another terminal inspected the pending quantity meanwhile, "1 good
      // from Returned – to inspect" would silently take 1 from the hold. Sent,
      // an emptied bucket is refused with a clear message instead.
      from_bucket: from,
    };
    const q = fmtQty(payload.qty, part.uom);
    const outcome = {
      GOOD: `${q} good / reusable — back in Store Stock`,
      INSPECTION_REQUIRED: `${q} kept in return hold (inspection required) — not available`,
      DAMAGED: `${q} marked damaged — can go for RGP rework or scrap`,
      SCRAP: `${q} scrapped — out of the store`,
    }[result];
    flow.open({
      title: "Return inspection", icon: ClipboardCheck, part, qty: payload.qty, uom: part.uom,
      moves: [{ from: FROM[from].status, to: TO_STATUS[result] }],
      fields: [
        { label: "Return", value: r.return_no },
        { label: "Condition", value: res?.label },
        { label: "Return reason", value: reasonLabel(r.reason) },
        { label: "From", value: `${r.department || "—"}${r.issued_to ? ` · ${r.issued_to}` : ""}` },
        { label: "Remarks", value: payload.remarks },
      ],
      note: result === "GOOD"
        ? `Adds ${q} back to Store Stock — available for issue.`
        : result === "SCRAP"
          ? "Scrapped material leaves the store for disposal — it is not stock and cannot come back through this screen."
          : "Not added to stock — it stays in the store, set aside, until a later decision.",
      confirmLabel: "Confirm Inspection",
      submit: () => flow.run(
        () => spareFlowService.inspect(r.id, payload),
        `${r.return_no}: ${outcome}`,
      ),
    });
  };

  return (
    <FormShell flow={flow} onCancel={onCancel} onReview={review} reviewLabel="Review inspection"
      verify={
        <Facts items={[
          { label: "Part No.", value: part.part_no, strong: true },
          { label: "Description", value: part.part_name },
          { label: "Waiting inspection", value: fmtQty(scan.buckets?.return_pending ?? 0, part.uom) },
          ret && { label: "Return reason", value: reasonLabel(ret.reason) },
          ret && { label: "From", value: `${ret.department || "—"}${ret.issued_to ? ` · ${ret.issued_to}` : ""}` },
          ret && { label: "Was at", value: placeText(ret), empty: "Not recorded" },
        ]} />
      }>
      <DocPicker legend="Return" name={`${uid}-ret`} docs={returns} value={pick.id} onChange={pick.setId}
        error={show("ret")} render={(d) => <ReturnCard r={d} />} />
      {pick.gone && <GoneNote />}
      {ret && (
        <>
          {fromChoices.length > 1 && (
            <Field label="Inspect the quantity that is" required error={show("from")}>
              <Segmented label="Inspect from" value={from} onChange={chooseFrom} columns={fromChoices.length}
                options={fromChoices.map((k) => ({
                  value: k, label: FROM[k].label, hint: `${num(ret[FROM[k].col])}${part.uom ? ` ${part.uom}` : ""}`,
                }))} />
            </Field>
          )}
          <Field label="Condition" required error={show("result")}>
            <Segmented label="Condition" size="lg" value={result} onChange={setResult} error={show("result")}
              columns={allowed.length >= 4 ? 4 : allowed.length}
              options={allowed.map((x) => ({ value: x.key, label: x.label, hint: x.hint, dot: x.dot }))} />
          </Field>
          {from === "DAMAGED" && (
            <Note>Damaged material can only be scrapped here — to send it for supplier rework use RGP (Rework).</Note>
          )}
          {from === "HOLD" && (
            <Note>Already held for inspection — decide it now: Good, Damaged or Scrap.</Note>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Quantity" required htmlFor={`${uid}-qty`} error={show("qty")}
              hint={`Up to ${num(bucketQty)}${part.uom ? ` ${part.uom}` : ""}`}>
              <QtyStepper id={`${uid}-qty`} value={qty} onChange={setQty} min={stepMin(bucketQty)} max={bucketQty}
                size="lg" label="Inspected quantity" />
            </Field>
            <Field label="Remarks" htmlFor={`${uid}-rem`}>
              <input id={`${uid}-rem`} value={remarks} maxLength={255} onChange={(e) => setRemarks(e.target.value)}
                className="input-field" placeholder="What was found (optional)" />
            </Field>
          </div>
        </>
      )}
    </FormShell>
  );
}
