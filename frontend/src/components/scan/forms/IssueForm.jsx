import React, { useId, useState } from "react";
import { ArrowUpFromLine } from "lucide-react";
import QtyStepper from "../../QtyStepper.jsx";
import { spareFlowService } from "../../../services/spareFlowService.js";
import { num } from "../../../lib/format.js";
import { DepartmentSelect, Facts, Field, FormShell, Note } from "./FormKit.jsx";
import { clean, fmtQty, qtyError, qtyOf, stepMin, useActionFlow } from "./flow.js";

// ISSUE (spec 11): the store hands the part to a department + person. Only
// what the store knows at the counter is asked — Line / Machine / Die are NOT
// mandatory here; they are added to the same issue after installation
// (Update Line / Machine). The quantity can never exceed what is available.

export default function IssueForm({ scan, source, onDone, onCancel }) {
  const uid = useId();
  const { part } = scan;
  const available = qtyOf(scan.buckets?.available);
  const flow = useActionFlow(onDone);
  const [qty, setQty] = useState(() => stepMin(available));
  const [department, setDepartment] = useState("");
  const [issuedTo, setIssuedTo] = useState("");
  const [remarks, setRemarks] = useState("");
  const [tried, setTried] = useState(false);

  const errors = {
    qty: available <= 0
      ? "Nothing available to issue"
      : qtyError(qty, { max: available, maxText: `Only ${fmtQty(available, part.uom)} available — cannot issue more` }),
    department: !department ? "Choose the department" : null,
  };
  const valid = !Object.values(errors).some(Boolean);
  const show = (k) => (tried || k === "qty" ? errors[k] : null);

  const review = () => {
    setTried(true);
    if (!valid) return;
    const payload = {
      qty: qtyOf(qty), department, issued_to: clean(issuedTo), remarks: clean(remarks),
      scan_source: source || undefined,
    };
    const who = payload.issued_to ? ` · ${payload.issued_to}` : "";
    flow.open({
      title: "Issue", icon: ArrowUpFromLine, part, qty: payload.qty, uom: part.uom,
      moves: [{ from: "STOCK_AVAILABLE", to: "ISSUED" }],
      fields: [
        { label: "Department", value: department },
        { label: "Issued to", value: payload.issued_to },
        { label: "From location", value: part.location },
        { label: "Available after issue", value: fmtQty(Math.round((available - payload.qty) * 100) / 100, part.uom) },
        { label: "Remarks", value: payload.remarks },
      ],
      note: "Line / Machine / Die are added after installation — scan this part and choose Update Line / Machine.",
      confirmLabel: "Confirm Issue",
      submit: () => flow.run(
        () => spareFlowService.issue(part.id, payload),
        `Issued ${fmtQty(payload.qty, part.uom)} to ${department}${who} — add Line / Machine / Die after installation`,
      ),
    });
  };

  return (
    <FormShell flow={flow} onCancel={onCancel} onReview={review} reviewLabel="Review issue" blocked={available <= 0}
      verify={
        <Facts items={[
          { label: "Part No.", value: part.part_no, strong: true },
          { label: "Description", value: part.part_name },
          { label: "Current location", value: part.location, empty: "Not set" },
          { label: "Available qty", value: fmtQty(available, part.uom), strong: true },
        ]} />
      }>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Department" required htmlFor={`${uid}-dept`} error={show("department")}>
          <DepartmentSelect id={`${uid}-dept`} value={department} onChange={setDepartment} error={show("department")} />
        </Field>
        <Field label="Issued to (person)" htmlFor={`${uid}-to`}>
          <input id={`${uid}-to`} value={issuedTo} maxLength={80} onChange={(e) => setIssuedTo(e.target.value)}
            className="input-field text-base" placeholder="Who took the part" />
        </Field>
        <Field label="Issue qty" required htmlFor={`${uid}-qty`} error={show("qty")}
          hint={`Up to ${num(available)}${part.uom ? ` ${part.uom}` : ""}`}>
          <QtyStepper id={`${uid}-qty`} value={qty} onChange={setQty} min={stepMin(available)} max={available}
            disabled={available <= 0} size="lg" label="Issue quantity" />
        </Field>
        <Field label="Remarks" htmlFor={`${uid}-rem`}>
          <input id={`${uid}-rem`} value={remarks} maxLength={255} onChange={(e) => setRemarks(e.target.value)}
            className="input-field" placeholder="Optional" />
        </Field>
      </div>
      <Note>Line / Machine / Die can be added after installation.</Note>
    </FormShell>
  );
}
