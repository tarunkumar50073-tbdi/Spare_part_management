import React, { useId, useMemo, useState } from "react";
import { ArrowDownToLine, Wrench } from "lucide-react";
import QtyStepper from "../../QtyStepper.jsx";
import PersonPicker from "../../PersonPicker.jsx";
import { spareFlowService } from "../../../services/spareFlowService.js";
import { RETURN_REASONS } from "../../../lib/scanStatus.js";
import { fmtStamp, num } from "../../../lib/format.js";
import { DocPicker, EmptyNote, Facts, Field, FormShell, GoneNote, Note } from "./FormKit.jsx";
import { clean, fmtQty, inputCls, qtyError, qtyOf, stepMin, useActionFlow, useDocChoice } from "./flow.js";
import { IssueCard } from "./DocCards.jsx";

// RETURN (spec 13): a part comes back, always against its ORIGINAL issue —
// never as a new, unrelated receipt — so the return carries that issue's
// department / person / line / machine / die. Two kinds since 27 Oct 2026 (the
// store's spec "Part Return, Job Work Return & Pending RGP"):
//   Fresh / unused — could not be used (size, wrong part, not required): the
//     supervisor counts it and confirms, and it goes straight back into stock
//     (the 14 Oct rule: no inspection). A part issued as a packet comes back
//     only as the whole packet, on the shelf again with the same QR.
//   Job work — worn / damaged, needs repair: no inspection and NOT stock; it
//     waits as Pending RGP until the RGP another store employee makes in ERP
//     is linked to it (Job Work & RGP screen). The app never makes an RGP.
// The part is found by its QR (packet / part label) or by Part No. search —
// which one is recorded. Who handed it back is picked by code or name.

const NO_PERSON = { employee: null, mobile: null, typed: "" };
const JOB_REASONS = ["Worn out", "Damaged", "Repair required", "Reconditioning required", "Other"];
const KINDS = [
  { key: "UNUSED_RETURN", title: "Fresh / unused", sub: "Could not be used — size, wrong part, not required. Back into stock.", icon: ArrowDownToLine },
  { key: "JOB_WORK_RETURN", title: "Job work", sub: "Worn / damaged, needs repair. Not stock — waits for its RGP.", icon: Wrench },
];
// The ways a part is found that are a label scan, not a search.
const SCANNED = new Set(["QR_SCAN", "SUPPLIER_BARCODE"]);

export default function ReturnForm({ scan, target, source, onDone, onCancel }) {
  const uid = useId();
  const { part } = scan;
  const flow = useActionFlow(onDone);
  const issues = useMemo(
    () => (scan.open_issues || []).filter((i) => qtyOf(i.outstanding_qty) > 0),
    [scan.open_issues]);
  // A packet's QR names its own issue: that one is picked.
  const packetIssue = scan.packet ? issues.find((i) => i.packet?.code === scan.packet.code)?.id : undefined;
  const pick = useDocChoice(issues, target ?? packetIssue);
  const issue = pick.doc;
  const packet = issue?.packet || null;
  const outstanding = qtyOf(issue?.outstanding_qty);
  const available = qtyOf(scan.buckets?.available);

  const [kind, setKind] = useState("UNUSED_RETURN");
  const [qty, setQty] = useState(() => stepMin(outstanding));
  const [reason, setReason] = useState("");
  const [returnedBy, setReturnedBy] = useState("");
  const [returner, setReturner] = useState(NO_PERSON);
  const byEmp = returner.employee;
  const [note, setNote] = useState("");
  const [counted, setCounted] = useState(false);
  const [tried, setTried] = useState(false);
  const [forId, setForId] = useState(pick.id);
  if (forId !== pick.id) {
    setForId(pick.id);
    setQty(stepMin(outstanding));
    setCounted(false);
  }
  const job = kind === "JOB_WORK_RETURN";
  const backQty = packet ? qtyOf(packet.qty) : qtyOf(qty);

  // Kept on the confirm step while a write is in flight: this terminal's own
  // write empties the list (SSE refresh) before its response arrives.
  if (!issues.length && !flow.review) {
    return (
      <EmptyNote onCancel={onCancel}>
        No issue of this part is still out — there is nothing to return against. A return is always recorded against its original issue.
      </EmptyNote>
    );
  }

  const reasons = job ? JOB_REASONS : RETURN_REASONS;
  const what = packet ? (packet.kind === "UNIT" ? "individual part" : "packet") : null;
  const errors = {
    issue: !issue ? "Pick the original issue this part came from" : null,
    qty: issue && !packet ? qtyError(qty, { max: outstanding, maxText: `Only ${fmtQty(outstanding, part.uom)} of this issue is still out` }) : null,
    reason: !reason ? (job ? "Choose why it needs job work" : "Choose the return reason") : null,
    note: reason === "Other" && !clean(note) ? "Describe the reason" : null,
    counted: !job && !counted ? "Count what came back and tick that it is verified" : null,
  };
  const valid = !Object.values(errors).some(Boolean);
  const show = (k) => (tried || k === "qty" ? errors[k] : null);

  const review = () => {
    setTried(true);
    if (!valid) return;
    // A picked person wins over the typed name (the box is hidden while one is picked).
    const payload = {
      qty: backQty, reason, note: clean(note), returned_by: byEmp ? byEmp.name : clean(returnedBy),
      return_type: kind, verified: job ? undefined : true,
      identified_by: SCANNED.has(source) ? "QR" : "MANUAL", scan_source: source || undefined,
      scanned_code: (scan.packet && packet?.code === scan.packet.code ? scan.packet.code : scan.scanned_code) || undefined,
    };
    const it = issue;
    flow.open({
      title: job ? "Job work return" : "Return to store", icon: job ? Wrench : ArrowDownToLine, part, qty: payload.qty, uom: part.uom,
      moves: job ? [] : [{ from: "ISSUED", to: "STOCK_AVAILABLE" }],
      fields: [
        packet && { label: what === "packet" ? "Packet (whole)" : "Individual part", value: packet.code },
        { label: "Original issue", value: `${fmtQty(it.issued_qty, part.uom)} on ${fmtStamp(it.issued_at)}` },
        { label: "Original department", value: it.department },
        { label: "Issued to", value: it.issued_to },
        // Only an older issue has one (nothing records it since 27 Oct 2026).
        (it.line_name || it.line_no || it.machine || it.die_no)
          && { label: "Line / Machine / Die", value: [it.line_name, it.line_no, it.machine, it.die_no].filter(Boolean).join(" · ") },
        { label: job ? "Job work reason" : "Return reason", value: reason },
        { label: "Returned by", value: byEmp ? `${byEmp.name}${byEmp.employee_code ? ` (${byEmp.employee_code})` : ""}` : payload.returned_by },
        { label: "Found by", value: payload.identified_by === "QR" ? "QR / barcode scan" : "Part No. search (manual)" },
        { label: "Note", value: payload.note },
        job ? { label: "Status", value: "Pending RGP — not stock" }
          : { label: "Available after return", value: fmtQty(Math.round((available + payload.qty) * 100) / 100, part.uom) },
      ].filter(Boolean),
      note: job
        ? "Kept apart in the store — NOT added to stock. The RGP is made in ERP; then link it on Job Work & RGP."
        : `Counted and verified — goes back into store stock as soon as you confirm${packet ? `, and ${packet.code} is on the shelf again` : ""}.`,
      confirmLabel: job ? "Confirm Job Work Return" : "Confirm Return",
      submit: () => flow.run(
        () => spareFlowService.returnToStore(it.id, payload),
        (res) => {
          const d = res?.data?.data || {};
          const no = d.return_no || d.return?.return_no || "Return";
          return job ? `${no} recorded — ${fmtQty(payload.qty, part.uom)} kept for job work, Pending RGP`
            : `${no} recorded — ${fmtQty(payload.qty, part.uom)} back in store stock`;
        },
      ),
    });
  };

  return (
    <FormShell flow={flow} right="create" onCancel={onCancel} onReview={review} reviewLabel={job ? "Review job work return" : "Review return"}
      verify={
        <Facts items={[
          { label: "Part No.", value: part.part_no, strong: true },
          { label: "Description", value: part.part_name },
          packet && { label: what === "packet" ? "Packet" : "Individual part", value: `${packet.code} · ${fmtQty(packet.qty, part.uom)}`, strong: true },
          { label: "Original department", value: issue?.department, empty: issue ? "Not recorded" : "Pick the issue" },
          issue && { label: "Issued to", value: issue.issued_to, empty: "Not recorded" },
          issue && (issue.line_name || issue.line_no)
            && { label: "Line", value: [issue.line_name, issue.line_no].filter(Boolean).join(" / ") },
          issue?.machine && { label: "Machine", value: issue.machine },
          issue && { label: "Issue date", value: fmtStamp(issue.issued_at) },
          issue && {
            label: "Issued qty",
            value: `${fmtQty(issue.issued_qty, part.uom)}${qtyOf(issue.returned_qty) > 0 ? ` · ${num(issue.returned_qty)} already back` : ""}`,
          },
        ].filter(Boolean)} />
      }>
      <fieldset className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <legend className="mb-1 text-sm text-slate-600 dark:text-slate-300">Return type <span className="text-rose-500">*</span></legend>
        {KINDS.map((k) => (
          <button key={k.key} type="button" onClick={() => { setKind(k.key); setReason(""); }} aria-pressed={kind === k.key}
            className={`flex items-start gap-2.5 rounded-xl border-2 p-3 text-left transition ${kind === k.key ? "border-toyotared bg-toyotared/5" : "border-slate-200 hover:border-slate-300 dark:border-navy-700"}`}>
            <k.icon size={18} className="mt-0.5 shrink-0 text-slate-500" aria-hidden="true" />
            <span><span className="block text-[14px] font-bold text-slate-800 dark:text-white">{k.title}</span>
              <span className="block text-[12px] text-slate-500">{k.sub}</span></span>
          </button>
        ))}
      </fieldset>
      <DocPicker legend="Original issue" name={`${uid}-issue`} docs={issues} value={pick.id} onChange={pick.setId}
        error={show("issue")} render={(d) => <IssueCard i={d} uom={part.uom} />} />
      {pick.gone && <GoneNote />}
      {scan.packet && scan.packet.status !== "ISSUED" && (
        <Note tone="warn">Packet {scan.packet.code} is {String(scan.packet.status || "").toLowerCase()} — not out on an issue, so it cannot come back.</Note>
      )}
      {issue && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {packet ? (
              <Field label="Return qty">
                <p className="flex min-h-[42px] items-center rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[15px] font-bold text-slate-800 dark:border-navy-700 dark:bg-navy-800/60 dark:text-white">
                  {fmtQty(packet.qty, part.uom)} <span className="ml-2 text-[12px] font-medium text-slate-500">whole {what} {packet.code} — never part of it</span>
                </p>
              </Field>
            ) : (
              <Field label="Return qty" required htmlFor={`${uid}-qty`} error={show("qty")}
                hint={`Up to ${num(outstanding)}${part.uom ? ` ${part.uom}` : ""} still out on this issue`}>
                <QtyStepper id={`${uid}-qty`} value={qty} onChange={setQty} min={stepMin(outstanding)} max={outstanding}
                  size="lg" label="Return quantity" />
              </Field>
            )}
            <Field label={job ? "Job work reason" : "Return reason"} required htmlFor={`${uid}-rsn`} error={show("reason")}>
              <select id={`${uid}-rsn`} value={reason} onChange={(e) => setReason(e.target.value)}
                className={inputCls(show("reason"), "text-base")}>
                <option value="">Select reason…</option>
                {reasons.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </Field>
            <div className="space-y-2 sm:col-span-2">
              <PersonPicker value={returner} onChange={setReturner} required={false}
                label="Returned by — code or name (optional)" />
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
            {!job && (
              <label className={`flex items-start gap-2 rounded-lg border px-3 py-2.5 text-[13px] sm:col-span-2 ${show("counted") ? "border-rose-300 bg-rose-50/60 dark:border-rose-500/40" : "border-slate-200 dark:border-navy-700"}`}>
                <input type="checkbox" className="mt-0.5" checked={counted} onChange={(e) => setCounted(e.target.checked)} />
                <span className="text-slate-700 dark:text-slate-200">
                  <b>Verified by me (supervisor):</b> counted {fmtQty(backQty, part.uom)}{packet ? ` — the ${what} is complete` : ""}, unused, fit to go back on the shelf
                  {show("counted") && <span className="mt-0.5 block text-[11px] font-semibold text-rose-600">{errors.counted}</span>}
                </span>
              </label>
            )}
          </div>
          <Note tone={job ? "warn" : undefined}>
            {job ? "Not added to stock. It stays apart as Pending RGP; the RGP is made in ERP and then linked on Job Work & RGP."
              : "Goes straight back into store stock when you confirm — no quality inspection, only your count."}
          </Note>
        </>
      )}
    </FormShell>
  );
}
