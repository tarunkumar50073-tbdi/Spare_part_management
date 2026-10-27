import React, { useEffect, useId, useState } from "react";
import { ArrowUpFromLine, IdCard } from "lucide-react";
import QtyStepper from "../../QtyStepper.jsx";
import PersonPicker from "../../PersonPicker.jsx";
import { spareFlowService } from "../../../services/spareFlowService.js";
import { num } from "../../../lib/format.js";
import { partBins } from "../../../utils/binLocation.js";
import { DepartmentSelect, Facts, Field, FormShell, Note } from "./FormKit.jsx";
import PacketIssueForm from "./PacketIssueForm.jsx";
import { clean, fmtQty, isStoreDepartment, qtyError, qtyOf, stepMin, useActionFlow, useDepartments } from "./flow.js";

// ISSUE (spec 11): the store hands the part to a department + person. Only
// what the store knows at the counter is asked — Line / Machine / Die are NOT
// mandatory here; they are added to the same issue after installation
// (Update Line / Machine). The quantity can never exceed what is available.
// Scanning is mainly for issuance: the workstation opens this form by itself
// as soon as a part with stock is identified.
// The person is picked by code or name from today's Maintenance / Tool Room
// rosters (PersonPicker — no mobile number since 27 Oct 2026), and the
// Department is pre-filled from the person's record (still a choice — the part
// may be for another department); a part is never issued to someone off the
// master or marked inactive.
// The store is never the department: it hands parts out ("issuance me store
// dikha rha h jabki store to issue karta h" — the store, 18 Oct 2026). Its
// staff are on the master as Store, so their record fills nothing in and the
// list does not offer it — the operator picks the department the part is for.

const NO_PERSON = { employee: null, mobile: null, typed: "" };

/** "Issued to": the picked person's name and code, read-only — it comes from
 *  the Employee master, never typed. */
function IssuedTo({ emp }) {
  if (!emp) {
    return (
      <p className="flex min-h-[42px] items-center rounded-lg border border-dashed border-slate-300 px-3 py-2 text-sm text-slate-400 dark:border-navy-700">
        Fills in when the person is picked
      </p>
    );
  }
  return (
    <p className="flex min-h-[42px] flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 dark:border-navy-700 dark:bg-navy-800/60">
      <span className="text-base font-semibold text-slate-800 dark:text-white">{emp.name}</span>
      {emp.employee_code ? (
        <span className="badge badge-neutral gap-1 tabular">
          <IdCard size={12} aria-hidden="true" />{emp.employee_code}
        </span>
      ) : (
        <span className="text-xs text-slate-400">no employee code</span>
      )}
    </p>
  );
}

// A packet / unit QR (27 Oct 2026) issues that whole packet; anything else is
// an issue by quantity, of the loose stock only.
export default function IssueForm(props) {
  return props.scan.packet
    ? <PacketIssueForm key={props.scan.packet.code} {...props} />
    : <QtyIssueForm {...props} />;
}

function QtyIssueForm({ scan, source, onDone, onCancel, onDirty }) {
  const uid = useId();
  const { part } = scan;
  // What sits in QR-labelled packets goes out a whole packet at a time, by
  // scanning the packet; by quantity only the loose stock (the server refuses
  // more).
  const packed = Number(scan.packets?.packed_available) || 0;
  const onShelf = qtyOf(scan.buckets?.available);
  const available = packed > 0 ? Math.max(0, Math.min(onShelf, Number(scan.packets.loose) || 0)) : onShelf;
  const flow = useActionFlow(onDone);
  const { data: depts } = useDepartments();
  const [startQty] = useState(() => stepMin(available));
  const [qty, setQty] = useState(startQty);
  const [person, setPerson] = useState(NO_PERSON);
  const [department, setDepartment] = useState("");
  // The department the picked person's record filled in: another person
  // replaces it and clearing the person empties it — a department the
  // operator chose is never overwritten.
  const [autoDept, setAutoDept] = useState(null);
  const [remarks, setRemarks] = useState("");
  const [tried, setTried] = useState(false);
  const emp = person.employee;
  // A part with a rework location sits in two bins — Fresh (new parts) and
  // Rework (back from rework) — and shows both; otherwise the one `single` fact.
  const labelledBins = partBins(part.location, part.rework_location).filter((b) => b.label);
  const binFacts = (single) => (labelledBins.length
    ? labelledBins.map((b) => ({ label: `${b.label} location`, value: b.location })) : [single]);

  const pickPerson = (next) => {
    const was = person.employee;
    setPerson(next);
    if ((next.employee?.id ?? null) === (was?.id ?? null)) return;
    if (department && department !== autoDept) return;
    const dept = next.employee?.department;
    const fill = dept && !isStoreDepartment(dept) && (!depts || depts.some((d) => d.name === dept)) ? dept : "";
    setDepartment(fill);
    setAutoDept(fill || null);
  };

  // Has the operator entered anything? An untouched form that the workstation
  // opened by itself is dropped without a question when the next part is scanned.
  const dirty = Boolean(department || emp || person.typed?.trim() || remarks.trim()) || Number(qty) !== Number(startQty);
  useEffect(() => { onDirty?.(dirty); }, [dirty, onDirty]);

  // The picked person's record says Store: nothing was filled in, and why is said.
  const storeRecord = Boolean(emp) && isStoreDepartment(emp.department);
  const storeText = storeRecord ? `${emp.name}'s record says ${emp.department} — choose the department the part is for` : null;
  const errors = {
    person: emp ? null : person.typed?.trim()
      ? "Pick the person from the list — a part is issued only to someone on today's roster"
      : "Pick the person taking the part (code or name)",
    qty: available <= 0
      ? "Nothing available to issue"
      : qtyError(qty, { max: available, maxText: `Only ${fmtQty(available, part.uom)} available — cannot issue more` }),
    department: !department
      ? storeText || "Choose the department"
      : isStoreDepartment(department) ? "The store hands parts out — choose the department the part is for"
        : depts && !depts.some((d) => d.name === department) ? `${department} is not in the Department master — choose one` : null,
  };
  const valid = !Object.values(errors).some(Boolean);
  const show = (k) => (tried || k === "qty" ? errors[k] : null);

  const deptHint = !emp ? null
    : department && department === autoDept ? `From ${emp.name}'s record — change it if the part is for another department`
      : storeRecord && !department ? storeText
        : emp.department && department !== emp.department ? `${emp.name}'s record says ${emp.department}` : null;

  const review = () => {
    setTried(true);
    if (!valid) return;
    const payload = {
      qty: qtyOf(qty), department, remarks: clean(remarks),
      employee_id: emp.id, issued_to: emp.name,
      scan_source: source || undefined,
    };
    const code = emp.employee_code ? ` (${emp.employee_code})` : "";
    flow.open({
      title: "Issue", icon: ArrowUpFromLine, part, qty: payload.qty, uom: part.uom,
      moves: [{ from: "STOCK_AVAILABLE", to: "ISSUED" }],
      fields: [
        { label: "Issued to", value: emp.name },
        { label: "Employee code", value: emp.employee_code },
        { label: "Department", value: department },
        { label: "Shift", value: emp.shift },
        ...binFacts({ label: "From location", value: part.location }),
        { label: "Available after issue", value: fmtQty(Math.round((available - payload.qty) * 100) / 100, part.uom) },
        { label: "Remarks", value: payload.remarks },
      ],
      note: "Line / Machine / Die are added after installation — scan this part and choose Update Line / Machine.",
      confirmLabel: "Confirm Issue",
      submit: () => flow.run(
        () => spareFlowService.issue(part.id, payload),
        `Issued ${fmtQty(payload.qty, part.uom)} to ${emp.name}${code} · ${department} — add Line / Machine / Die after installation`,
      ),
    });
  };

  return (
    <FormShell flow={flow} right="create" onCancel={onCancel} onReview={review} reviewLabel="Review issue" blocked={available <= 0}
      verify={
        <Facts items={[
          { label: "Part No.", value: part.part_no, strong: true },
          { label: "Description", value: part.part_name },
          ...binFacts({ label: "Location", value: part.location, empty: "Not set" }),
          { label: "Available qty", value: fmtQty(available, part.uom), strong: true },
        ]} />
      }>
      <PersonPicker value={person} onChange={pickPerson} error={show("person")} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Issued to (person)">
          <IssuedTo emp={emp} />
        </Field>
        <Field label="Department" required htmlFor={`${uid}-dept`} error={show("department")} hint={deptHint}>
          <DepartmentSelect id={`${uid}-dept`} value={department} onChange={setDepartment} error={show("department")} noStore />
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
      {packed > 0 && (
        <Note tone="warn">
          {fmtQty(packed, part.uom)} of this part is in QR-labelled packets — scan a packet&apos;s QR to issue a whole packet.
          {available > 0 ? ` By quantity, only the loose ${fmtQty(available, part.uom)}.` : " Nothing is loose."}
        </Note>
      )}
      <Note>Line / Machine / Die can be added after installation.</Note>
    </FormShell>
  );
}
