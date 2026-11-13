import React, { useEffect, useId, useRef, useState } from "react";
import { ArrowUpFromLine, IdCard, TriangleAlert, X } from "lucide-react";
import PersonPicker from "../../PersonPicker.jsx";
import useGunEnd from "../../../hooks/useGunEnd.js";
import { packetService } from "../../../services/packetService.js";
import { fmtDate, fmtStamp } from "../../../lib/format.js";
import { DepartmentSelect, Facts, Field, FormShell, LineMachinePicker, NO_PLACE, Note, machineText, useMachines } from "./FormKit.jsx";
import { clean, fmtQty, isStoreDepartment, useActionFlow, useDepartments } from "./flow.js";

// ISSUE of a whole packet or one individual unit — what a packet / unit QR
// opens on Scan Part (the store's spec of 27 Oct 2026). One scan names one
// packet; its whole quantity goes, once. There is no quantity to type. The
// department and person are asked as for any issue. A packet from a newer
// receipt while an older one still has packets needs a reason (FIFO), kept
// with the issue.
//
// One person taking more of the SAME part (10 Nov 2026: "agar user 1 baar me
// same part 4 qty. le jaayega" … "1 baar me scan karke 4 nhi jud sakte" … "ek
// hi part jaise cntr1541 … agar part hi alag alaag h to wo to alag alag hi
// issue hone chahiye" … "tabhi to part ki history banegei"): the next labels of
// this part are scanned into the same issue, the person and department given
// once, and all go out together (each label still its own ISSUE line). A label
// of another part is refused — it is issued on its own.

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
  // Where the part goes: line + machine, optional (13 Nov 2026).
  const [place, setPlace] = useState(NO_PLACE);
  const { data: machineList } = useMachines(department);
  const [reason, setReason] = useState("");
  const [tried, setTried] = useState(false);
  // The other labels of this part in this issue, as the server checked them,
  // and the FIFO answer for all of them together.
  const [more, setMore] = useState([]);
  const [setFifo, setSetFifo] = useState(null);
  const [next, setNext] = useState("");
  const [adding, setAdding] = useState(false);
  const [addMsg, setAddMsg] = useState(null);
  const nextRef = useRef(null);
  const emp = person.employee;
  const available = packet.status === "AVAILABLE";
  const all = [packet, ...more];
  const many = more.length > 0;
  const fifo = many ? setFifo : packet.fifo;
  const older = fifo && fifo.ok === false ? fifo.oldest : null;
  const totalQty = all.reduce((sum, p) => sum + Number(p.qty || 0), 0);

  const check = async (codes) => {
    const d = (await packetService.issueCheck(codes, { silent: true })).data.data;
    setMore(d.packets.slice(1));
    setSetFifo(d.fifo);
    return d;
  };
  const addLabel = async () => {
    const text = next.trim();
    if (!text || adding) return;
    setAddMsg(null);
    setAdding(true);
    try {
      const d = await check([...all.map((p) => p.code), text]);
      if (d.count === all.length) setAddMsg("This label is already in the list");
    } catch (e) {
      setAddMsg(e?.response?.data?.message || "Could not add the label — check the network and scan again");
    } finally {
      setAdding(false);
      setNext("");
      setTimeout(() => nextRef.current?.focus(), 0);
    }
  };
  // A scanner that sends no Enter adds the label when its burst goes quiet.
  const gunEnd = useGunEnd(() => addLabel());
  const removeLabel = async (code) => {
    setAddMsg(null);
    const rest = all.map((p) => p.code).filter((c) => c !== code);
    if (rest.length === 1) {
      setMore([]);
      setSetFifo(null);
      return;
    }
    try {
      await check(rest);
    } catch (e) {
      setAddMsg(e?.response?.data?.message || "Could not update the list");
    }
  };

  const pickPerson = (chosen) => {
    const was = person.employee;
    setPerson(chosen);
    if ((chosen.employee?.id ?? null) === (was?.id ?? null)) return;
    if (department && department !== autoDept) return;
    const dept = chosen.employee?.department;
    const fill = dept && !isStoreDepartment(dept) && (!depts || depts.some((d) => d.name === dept)) ? dept : "";
    setDepartment(fill);
    setAutoDept(fill || null);
  };

  const dirty = Boolean(department || emp || person.typed?.trim() || remarks.trim() || place.line || reason.trim() || many);
  useEffect(() => { onDirty?.(dirty); }, [dirty, onDirty]);

  const errors = {
    person: emp ? null : person.typed?.trim()
      ? "Pick the person from the list — a part is issued only to someone on today's roster"
      : "Pick the person taking the packet (code or name)",
    department: !department ? "Choose the department"
      : isStoreDepartment(department) ? "The store hands parts out — choose the department the part is for"
        : depts && !depts.some((d) => d.name === department) ? `${department} is not in the Department master — choose one` : null,
    reason: older && !reason.trim()
      ? `Older stock is waiting — say why ${many ? "these labels go" : "this packet goes"} first` : null,
  };
  const valid = available && !Object.values(errors).some(Boolean);
  const show = (k) => (tried ? errors[k] : null);
  const qtyText = fmtQty(totalQty, packet.uom || part.uom);
  const oneText = fmtQty(packet.qty, packet.uom || part.uom);
  const what = packet.kind === "UNIT" ? "individual part" : "packet";

  const review = () => {
    setTried(true);
    if (!valid) return;
    const payload = {
      department, remarks: clean(remarks), employee_id: emp.id, issued_to: emp.name,
      line_name: place.line || undefined, machine: place.machine || undefined,
      override_reason: older ? reason.trim() : undefined,
      scan_source: source || undefined,
    };
    const code = emp.employee_code ? ` (${emp.employee_code})` : "";
    const codes = all.map((p) => p.code);
    const days = [...new Set(all.map((p) => fmtDate(p.receipt.received_on)))].join(", ");
    flow.open({
      title: many ? `Issue ${all.length} labels` : `Issue ${what}`, icon: ArrowUpFromLine, part, qty: totalQty,
      uom: packet.uom || part.uom,
      moves: [{ from: "STOCK_AVAILABLE", to: "ISSUED" }],
      fields: [
        many ? { label: `Labels (${all.length})`, value: codes.join(", ") } : { label: "Packet", value: packet.code },
        { label: "Issued to", value: emp.name },
        { label: "Employee code", value: emp.employee_code },
        { label: "Department", value: department },
        { label: "Shift", value: emp.shift },
        { label: "Line", value: place.line ? place.line.replace(/_/g, " ") : null },
        { label: "Machine", value: machineText(machineList?.lines, place) },
        many ? { label: "Received", value: days }
          : { label: "Received", value: `${fmtDate(packet.receipt.received_on)} · ${packet.receipt.receipt_no}` },
        { label: "From location", value: packet.location || part.location },
        older ? { label: "FIFO skipped", value: reason.trim() } : null,
        { label: "Remarks", value: payload.remarks },
      ].filter(Boolean),
      note: many ? `All ${all.length} labels of ${part.part_no} — ${qtyText} — go out together.`
        : `The whole ${what} — ${qtyText} — goes out.`,
      confirmLabel: `Confirm Issue`,
      submit: () => flow.run(
        () => (many ? packetService.issueMany({ ...payload, codes }) : packetService.issue(packet.code, payload)),
        many ? `Issued ${all.length} labels of ${part.part_no} — ${qtyText} to ${emp.name}${code} · ${department}`
          : `Issued ${what} ${packet.code} — ${qtyText} to ${emp.name}${code} · ${department}`,
      ),
    });
  };

  return (
    <FormShell flow={flow} right="create" onCancel={onCancel} onReview={review} reviewLabel={many ? `Review issue of ${all.length} labels` : `Review ${what} issue`}
      blocked={!available}
      verify={
        <Facts items={[
          { label: "Packet", value: packet.code, strong: true },
          ...(packet.supplier_code ? [{ label: "Supplier label", value: packet.supplier_code }] : []),
          { label: "Part No.", value: part.part_no, strong: true },
          { label: "Item Description", value: part.part_name },
          { label: packet.kind === "UNIT" ? "Individual part" : "Packet qty (whole)", value: oneText, strong: true },
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
          <div className="rounded-lg border border-slate-200 p-3 dark:border-navy-700">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-[13px] font-bold text-slate-700 dark:text-slate-200">Labels in this issue — {part.part_no}</p>
              <p className="text-[13px] font-bold text-slate-800 dark:text-white">
                {all.length} label{all.length === 1 ? "" : "s"} · {qtyText}
              </p>
            </div>
            <ul className="mt-1.5 divide-y divide-slate-100 dark:divide-navy-700">
              {all.map((p, i) => (
                <li key={p.code} className="flex items-center gap-2 py-1.5 text-[13px]">
                  <span className="min-w-0 flex-1 truncate font-mono font-semibold text-slate-800 dark:text-white">{p.code}</span>
                  <span className="shrink-0 text-slate-500">
                    {fmtQty(p.qty, p.uom || part.uom)} · {fmtDate(p.receipt.received_on)}{p.location ? ` · ${p.location}` : ""}
                  </span>
                  {i > 0 ? (
                    <button type="button" onClick={() => removeLabel(p.code)} aria-label={`Remove ${p.code}`}
                      className="shrink-0 rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10">
                      <X size={14} aria-hidden="true" />
                    </button>
                  ) : <span className="w-[22px] shrink-0" aria-hidden="true" />}
                </li>
              ))}
            </ul>
            <Field label={`Taking more of ${part.part_no}? Scan the next label`} htmlFor={`${uid}-next`} className="mt-2"
              error={addMsg} hint={`Only labels of ${part.part_no} — another part is issued on its own, so each part keeps its history.`}>
              <input id={`${uid}-next`} ref={nextRef} value={next} autoFocus autoComplete="off" disabled={adding}
                onChange={(e) => setNext(e.target.value)}
                onKeyDown={(e) => { gunEnd(e); if (e.key === "Enter") { e.preventDefault(); addLabel(); } }}
                className="input-field font-mono" placeholder={adding ? "Checking…" : "Scan the next label of this part"} />
            </Field>
          </div>
          {older && (
            <div className="space-y-2">
              {/* The whole bar blinks, red text always solid (10 Nov 2026:
                  "warning red color me blink karti huyi dikhayi de … aise note
                  koi nhi padega" … "text red backgrond app wala sahi h" …
                  "pura bar bling ho only text nhi"). */}
              <div role="alert" className="bar-blink flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-3 text-[14px] font-semibold leading-snug text-red-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-red-300">
                <TriangleAlert size={22} className="mt-0.5 shrink-0" aria-hidden="true" />
                <p>
                  <span className="font-extrabold uppercase tracking-wide">Older stock first!</span>{" "}
                  Packet <span className="font-mono font-bold">{older.code}</span> (received {fmtDate(older.receipt.received_on)}, {fmtQty(older.qty, older.uom)}
                  {older.location ? ` at ${older.location}` : ""}) should go before {many ? "these" : "this one"} (received {many
                    ? [...new Set(all.map((p) => fmtDate(p.receipt.received_on)))].join(", ") : fmtDate(packet.receipt.received_on)}).
                  Issue that one — or give a reason to issue {many ? "these" : "this one"}.
                </p>
              </div>
              <Field label={many ? "Reason to issue these first" : "Reason to issue this one first"} required htmlFor={`${uid}-why`} error={show("reason")}>
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
                {qtyText} <span className="ml-2 text-[12px] font-medium text-slate-500">{many ? `${all.length} labels, each whole` : `whole ${what}`}</span>
              </p>
            </Field>
            <LineMachinePicker id={`${uid}-place`} department={department} value={place} onChange={setPlace} />
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
