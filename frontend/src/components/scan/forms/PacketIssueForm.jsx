import React, { useEffect, useId, useState } from "react";
import { ArrowUpFromLine, IdCard } from "lucide-react";
import PersonPicker from "../../PersonPicker.jsx";
import { packetService } from "../../../services/packetService.js";
import { fmtDate, fmtStamp } from "../../../lib/format.js";
import { DepartmentSelect, Facts, Field, FormShell, Note } from "./FormKit.jsx";
import { clean, fmtQty, isStoreDepartment, useActionFlow, useDepartments } from "./flow.js";

// ISSUE of a whole packet or one individual unit — what a packet / unit QR
// opens on Scan Part (the store's spec of 27 Oct 2026). One scan names one
// packet; its whole quantity goes, once. There is no quantity to type. The
// department and person are asked as for any issue. A packet from a newer
// receipt while an older one still has packets needs a reason (FIFO), kept
// with the issue.

const NO_PERSON = { employee: null, mobile: null, typed: "" };

export default function PacketIssueForm({ scan, source, onDone, onCancel, onDirty }) {
  const uid = useId();
  const { part, packet } = scan;
  const flow = useActionFlow(onDone);
  const { data: depts } = useDepartments();
  const [person, setPerson] = useState(NO_PERSON);
  const [department, setDepartment] = useState("");
  const [autoDept, setAutoDept] = useState(null);
  const [remarks, setRemarks] = useState("");
  const [reason, setReason] = useState("");
  const [tried, setTried] = useState(false);
  const emp = person.employee;
  const available = packet.status === "AVAILABLE";
  const older = packet.fifo && packet.fifo.ok === false ? packet.fifo.oldest : null;

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

  const dirty = Boolean(department || emp || person.typed?.trim() || remarks.trim() || reason.trim());
  useEffect(() => { onDirty?.(dirty); }, [dirty, onDirty]);

  const errors = {
    person: emp ? null : person.typed?.trim()
      ? "Pick the person from the list — a part is issued only to someone on today's roster"
      : "Pick the person taking the packet (code or name)",
    department: !department ? "Choose the department"
      : isStoreDepartment(department) ? "The store hands parts out — choose the department the part is for"
        : depts && !depts.some((d) => d.name === department) ? `${department} is not in the Department master — choose one` : null,
    reason: older && !reason.trim() ? "Older stock is waiting — say why this packet goes first" : null,
  };
  const valid = available && !Object.values(errors).some(Boolean);
  const show = (k) => (tried ? errors[k] : null);
  const qtyText = fmtQty(packet.qty, packet.uom || part.uom);
  const what = packet.kind === "UNIT" ? "individual part" : "packet";

  const review = () => {
    setTried(true);
    if (!valid) return;
    const payload = {
      department, remarks: clean(remarks), employee_id: emp.id, issued_to: emp.name,
      override_reason: older ? reason.trim() : undefined,
      scan_source: source || undefined,
    };
    const code = emp.employee_code ? ` (${emp.employee_code})` : "";
    flow.open({
      title: `Issue ${what}`, icon: ArrowUpFromLine, part, qty: Number(packet.qty), uom: packet.uom || part.uom,
      moves: [{ from: "STOCK_AVAILABLE", to: "ISSUED" }],
      fields: [
        { label: "Packet", value: packet.code },
        { label: "Issued to", value: emp.name },
        { label: "Employee code", value: emp.employee_code },
        { label: "Department", value: department },
        { label: "Shift", value: emp.shift },
        { label: "Received", value: `${fmtDate(packet.receipt.received_on)} · ${packet.receipt.receipt_no}` },
        { label: "From location", value: packet.location || part.location },
        older ? { label: "FIFO skipped", value: reason.trim() } : null,
        { label: "Remarks", value: payload.remarks },
      ].filter(Boolean),
      note: `The whole ${what} — ${qtyText} — goes out. Line / Machine / Die are added after installation.`,
      confirmLabel: `Confirm Issue`,
      submit: () => flow.run(
        () => packetService.issue(packet.code, payload),
        `Issued ${what} ${packet.code} — ${qtyText} to ${emp.name}${code} · ${department}`,
      ),
    });
  };

  return (
    <FormShell flow={flow} right="create" onCancel={onCancel} onReview={review} reviewLabel={`Review ${what} issue`}
      blocked={!available}
      verify={
        <Facts items={[
          { label: "Packet", value: packet.code, strong: true },
          ...(packet.supplier_code ? [{ label: "Supplier label", value: packet.supplier_code }] : []),
          { label: "Part No.", value: part.part_no, strong: true },
          { label: "Description", value: part.part_name },
          { label: packet.kind === "UNIT" ? "Individual part" : "Packet qty (whole)", value: qtyText, strong: true },
          { label: "Received", value: `${fmtDate(packet.receipt.received_on)} · ${packet.receipt.receipt_no}` },
          { label: "Location", value: packet.location || part.location, empty: "Not set" },
        ]} />
      }>
      {!available ? (
        <Note tone="warn">
          {packet.status === "QC_PENDING"
            ? `This ${what} waits for quality (QC) in ERP — it can be issued once ERP accepts its GRN.`
            : packet.status === "ISSUED"
            ? `This ${what} was already issued${packet.issued_at ? ` on ${fmtStamp(packet.issued_at)}` : ""}${packet.department ? ` to ${packet.department}` : ""}${packet.issued_to ? ` · ${packet.issued_to}` : ""}. It cannot be issued again.`
            : `This ${what} was cancelled${packet.cancel_reason ? ` (${packet.cancel_reason})` : ""} — it cannot be issued. Remove its label.`}
        </Note>
      ) : (
        <>
          {older && (
            <div className="space-y-2">
              <Note tone="warn">
                Older stock first: packet {older.code} (received {fmtDate(older.receipt.received_on)}, {fmtQty(older.qty, older.uom)}
                {older.location ? ` at ${older.location}` : ""}) should go before this one (received {fmtDate(packet.receipt.received_on)}).
                Issue that one — or give a reason to issue this one.
              </Note>
              <Field label="Reason to issue this one first" required htmlFor={`${uid}-why`} error={show("reason")}>
                <input id={`${uid}-why`} value={reason} maxLength={255} onChange={(e) => setReason(e.target.value)}
                  className="input-field" placeholder="e.g. older packet damaged, user asked for this lot" />
              </Field>
            </div>
          )}
          <PersonPicker value={person} onChange={pickPerson} error={show("person")} />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Issued to (person)">
              {emp ? (
                <p className="flex min-h-[42px] flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 dark:border-navy-700 dark:bg-navy-800/60">
                  <IdCard size={15} aria-hidden="true" className="text-slate-400" />
                  <span className="font-semibold text-slate-800 dark:text-white">{emp.name}</span>
                  {emp.employee_code && <span className="text-[12px] text-slate-500">{emp.employee_code}</span>}
                </p>
              ) : (
                <p className="flex min-h-[42px] items-center rounded-lg border border-dashed border-slate-300 px-3 py-2 text-sm text-slate-400 dark:border-navy-700">
                  Fills in when the person is picked
                </p>
              )}
            </Field>
            <Field label="Department" required htmlFor={`${uid}-dept`} error={show("department")}>
              <DepartmentSelect id={`${uid}-dept`} value={department} onChange={setDepartment} error={show("department")} noStore />
            </Field>
            <Field label="Issue qty">
              <p className="flex min-h-[42px] items-center rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[15px] font-bold text-slate-800 dark:border-navy-700 dark:bg-navy-800/60 dark:text-white">
                {qtyText} <span className="ml-2 text-[12px] font-medium text-slate-500">whole {what}</span>
              </p>
            </Field>
            <Field label="Remarks" htmlFor={`${uid}-rem`}>
              <input id={`${uid}-rem`} value={remarks} maxLength={200} onChange={(e) => setRemarks(e.target.value)}
                className="input-field" placeholder="Optional" />
            </Field>
          </div>
        </>
      )}
    </FormShell>
  );
}
