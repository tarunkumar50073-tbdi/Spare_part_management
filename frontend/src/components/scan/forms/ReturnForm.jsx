import React, { useId, useMemo, useState } from "react";
import { ArrowDownToLine } from "lucide-react";
import QtyStepper from "../../QtyStepper.jsx";
import EmployeeLookup from "../../EmployeeLookup.jsx";
import { spareFlowService } from "../../../services/spareFlowService.js";
import { RETURN_REASONS } from "../../../lib/scanStatus.js";
import { fmtStamp, num } from "../../../lib/format.js";
import { DocPicker, EmptyNote, Facts, Field, FormShell, GoneNote, Note } from "./FormKit.jsx";
import { clean, fmtQty, inputCls, qtyError, qtyOf, stepMin, useActionFlow, useDocChoice } from "./flow.js";
import { IssueCard } from "./DocCards.jsx";

// RETURN (spec 13): a department sends a part back. It is recorded against the
// ORIGINAL issue — never as a new, unrelated receipt — so the return carries
// that issue's department / person / line / machine / die. The store's rule
// (14 Oct 2026): no inspection — the quantity goes straight back into store
// stock the moment the return is confirmed.
// Installed parts may come back too (removed from the machine).
// Who handed it back is optional: found by mobile number on the Employee
// master (as on the Issue), or just typed.

const NO_PERSON = { employee: null, mobile: null, typed: "" };

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
  const available = qtyOf(scan.buckets?.available);

  const [qty, setQty] = useState(() => stepMin(outstanding));
  const [reason, setReason] = useState("");
  const [returnedBy, setReturnedBy] = useState("");
  const [returner, setReturner] = useState(NO_PERSON);
  const byEmp = returner.employee;
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
    // A picked person wins over the typed name (the box is hidden while one is picked).
    const payload = { qty: qtyOf(qty), reason, note: clean(note), returned_by: byEmp ? byEmp.name : clean(returnedBy) };
    const it = issue;
    flow.open({
      title: "Return to store", icon: ArrowDownToLine, part, qty: payload.qty, uom: part.uom,
      moves: [{ from: "ISSUED", to: "STOCK_AVAILABLE" }],
      fields: [
        { label: "Original issue", value: `${fmtQty(it.issued_qty, part.uom)} on ${fmtStamp(it.issued_at)}` },
        { label: "Original department", value: it.department },
        { label: "Issued to", value: it.issued_to },
        { label: "Line / Machine / Die", value: [it.line_name, it.line_no, it.machine, it.die_no].filter(Boolean).join(" · ") },
        { label: "Return reason", value: reason },
        {
          label: "Returned by",
          value: byEmp ? `${byEmp.name}${byEmp.employee_code ? ` (${byEmp.employee_code})` : ""}` : payload.returned_by,
        },
        { label: "Note", value: payload.note },
        { label: "Available after return", value: fmtQty(Math.round((available + payload.qty) * 100) / 100, part.uom) },
      ],
      note: "Goes back into store stock as soon as you confirm — no inspection.",
      confirmLabel: "Confirm Return",
      submit: () => flow.run(
        () => spareFlowService.returnToStore(it.id, payload),
        (res) => {
          const d = res?.data?.data || {};
          const no = d.return_no || d.return?.return_no;
          return `${no || "Return"} recorded — ${fmtQty(payload.qty, part.uom)} back in store stock`;
        },
      ),
    });
  };

  return (
    <FormShell flow={flow} right="create" onCancel={onCancel} onReview={review} reviewLabel="Review return"
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
            <div className="space-y-2 sm:col-span-2">
              <EmployeeLookup value={returner} onChange={setReturner} required={false}
                defaultDepartment={issue.department || undefined} label="Returned by — mobile no. (optional)" />
              {!byEmp && (
                <Field label="Or type who handed it back" htmlFor={`${uid}-by`}>
                  <input id={`${uid}-by`} value={returnedBy} maxLength={80} onChange={(e) => setReturnedBy(e.target.value)}
                    className="input-field" placeholder="Name" />
                </Field>
              )}
            </div>
            <Field label="Note" required={reason === "Other"} htmlFor={`${uid}-note`} error={show("note")} className="sm:col-span-2">
              <input id={`${uid}-note`} value={note} maxLength={255} onChange={(e) => setNote(e.target.value)}
                className={inputCls(show("note"))} placeholder={reason === "Other" ? "Describe the reason" : "Optional"} />
            </Field>
          </div>
          <Note>
            Goes straight back into store stock when you confirm — no inspection.
          </Note>
        </>
      )}
    </FormShell>
  );
}
