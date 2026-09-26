import React, { useId, useMemo, useState } from "react";
import { ArrowDownToLine } from "lucide-react";
import QtyStepper from "../../QtyStepper.jsx";
import { spareFlowService } from "../../../services/spareFlowService.js";
import { RETURN_REASONS } from "../../../lib/scanStatus.js";
import { fmtStamp, num } from "../../../lib/format.js";
import { DocPicker, EmptyNote, Facts, Field, FormShell, GoneNote, Note } from "./FormKit.jsx";
import { clean, fmtQty, inputCls, qtyError, qtyOf, stepMin, useActionFlow, useDocChoice } from "./flow.js";
import { IssueCard } from "./DocCards.jsx";

// RETURN (spec 13): a department sends a part back. It is recorded against the
// ORIGINAL issue — never as a new, unrelated receipt — so the return carries
// that issue's department / person / line / machine / die. It goes to Return
// Inspection (spec 14): nothing is added to stock until the store inspects it.
// Installed parts may come back too (removed from the machine).

export default function ReturnForm({ scan, target, onDone, onCancel }) {
  const uid = useId();
  const { part } = scan;
  const flow = useActionFlow(onDone);
  const issues = useMemo(
    () => (scan.open_issues || []).filter((i) => qtyOf(i.outstanding_qty) > 0),
    [scan.open_issues]);
  const pick = useDocChoice(issues, target);
  const issue = pick.doc;
  const outstanding = qtyOf(issue?.outstanding_qty);

  const [qty, setQty] = useState(() => stepMin(outstanding));
  const [reason, setReason] = useState("");
  const [returnedBy, setReturnedBy] = useState("");
  const [note, setNote] = useState("");
  const [tried, setTried] = useState(false);
  const [forId, setForId] = useState(pick.id);
  if (forId !== pick.id) {
    setForId(pick.id);
    setQty(stepMin(outstanding));
  }

  // Kept on the confirm step while a write is in flight: this terminal's own
  // write empties the list (SSE refresh) before its response arrives.
  if (!issues.length && !flow.review) {
    return (
      <EmptyNote onCancel={onCancel}>
        No issue of this part is still out — there is nothing to return against. A return is always recorded against its original issue.
      </EmptyNote>
    );
  }

  const errors = {
    issue: !issue ? "Pick the original issue this part came from" : null,
    qty: issue ? qtyError(qty, { max: outstanding, maxText: `Only ${fmtQty(outstanding, part.uom)} of this issue is still out` }) : null,
    reason: !reason ? "Choose the return reason" : null,
    note: reason === "Other" && !clean(note) ? "Describe the reason" : null,
  };
  const valid = !Object.values(errors).some(Boolean);
  const show = (k) => (tried || k === "qty" ? errors[k] : null);

  const review = () => {
    setTried(true);
    if (!valid) return;
    const payload = { qty: qtyOf(qty), reason, note: clean(note), returned_by: clean(returnedBy) };
    const it = issue;
    flow.open({
      title: "Return to store", icon: ArrowDownToLine, part, qty: payload.qty, uom: part.uom,
      moves: [{ from: "ISSUED", to: "RETURN_INSPECTION" }],
      fields: [
        { label: "Original issue", value: `${fmtQty(it.issued_qty, part.uom)} on ${fmtStamp(it.issued_at)}` },
        { label: "Original department", value: it.department },
        { label: "Issued to", value: it.issued_to },
        { label: "Line / Machine / Die", value: [it.line_name, it.line_no, it.machine, it.die_no].filter(Boolean).join(" · ") },
        { label: "Return reason", value: reason },
        { label: "Returned by", value: payload.returned_by },
        { label: "Note", value: payload.note },
      ],
      note: "Goes to Return Inspection — NOT added to stock until the store inspects it.",
      confirmLabel: "Confirm Return",
      submit: () => flow.run(
        () => spareFlowService.returnToStore(it.id, payload),
        (res) => {
          const d = res?.data?.data || {};
          const no = d.return_no || d.return?.return_no;
          return `${no || "Return"} recorded — ${fmtQty(payload.qty, part.uom)} waiting for store inspection, not added to stock`;
        },
      ),
    });
  };

  return (
    <FormShell flow={flow} onCancel={onCancel} onReview={review} reviewLabel="Review return"
      verify={
        <Facts items={[
          { label: "Part No.", value: part.part_no, strong: true },
          { label: "Description", value: part.part_name },
          { label: "Original department", value: issue?.department, empty: issue ? "Not recorded" : "Pick the issue" },
          issue && { label: "Issued to", value: issue.issued_to, empty: "Not recorded" },
          issue && { label: "Line", value: [issue.line_name, issue.line_no].filter(Boolean).join(" / "), empty: "Not recorded" },
          issue && { label: "Machine", value: issue.machine, empty: "Not recorded" },
          issue && { label: "Die", value: issue.die_no, empty: "Not recorded" },
          issue && { label: "Issue date", value: fmtStamp(issue.issued_at) },
          issue && {
            label: "Issued qty",
            value: `${fmtQty(issue.issued_qty, part.uom)}${qtyOf(issue.returned_qty) > 0 ? ` · ${num(issue.returned_qty)} already back` : ""}`,
          },
        ]} />
      }>
      <DocPicker legend="Original issue" name={`${uid}-issue`} docs={issues} value={pick.id} onChange={pick.setId}
        error={show("issue")} render={(d) => <IssueCard i={d} uom={part.uom} />} />
      {pick.gone && <GoneNote />}
      {issue && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Return qty" required htmlFor={`${uid}-qty`} error={show("qty")}
              hint={`Up to ${num(outstanding)}${part.uom ? ` ${part.uom}` : ""} still out on this issue`}>
              <QtyStepper id={`${uid}-qty`} value={qty} onChange={setQty} min={stepMin(outstanding)} max={outstanding}
                size="lg" label="Return quantity" />
            </Field>
            <Field label="Return reason" required htmlFor={`${uid}-rsn`} error={show("reason")}>
              <select id={`${uid}-rsn`} value={reason} onChange={(e) => setReason(e.target.value)}
                className={inputCls(show("reason"), "text-base")}>
                <option value="">Select reason…</option>
                {RETURN_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </Field>
            <Field label="Returned by (person)" htmlFor={`${uid}-by`}>
              <input id={`${uid}-by`} value={returnedBy} maxLength={80} onChange={(e) => setReturnedBy(e.target.value)}
                className="input-field" placeholder="Who handed it back" />
            </Field>
            <Field label="Note" required={reason === "Other"} htmlFor={`${uid}-note`} error={show("note")}>
              <input id={`${uid}-note`} value={note} maxLength={255} onChange={(e) => setNote(e.target.value)}
                className={inputCls(show("note"))} placeholder={reason === "Other" ? "Describe the reason" : "Optional"} />
            </Field>
          </div>
          <Note tone="warn">
            Goes to Return Inspection — not added to stock until the store inspects it.
          </Note>
        </>
      )}
    </FormShell>
  );
}
