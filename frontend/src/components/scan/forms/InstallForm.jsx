import React, { useId, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Wrench } from "lucide-react";
import QtyStepper from "../../QtyStepper.jsx";
import { ISSUE_STATUS } from "../../spare/IssueLifecycle.jsx";
import { useStores } from "../../../context/StoreContext.jsx";
import { spareFlowService } from "../../../services/spareFlowService.js";
import { spareStockService } from "../../../services/spareStockService.js";
import { fmtStamp, num } from "../../../lib/format.js";
import { DocPicker, EmptyNote, Facts, Field, FormError, FormShell, GoneNote, Note } from "./FormKit.jsx";
import { clean, fmtQty, placeText, qtyError, qtyOf, useActionFlow, useDocChoice } from "./flow.js";
import { IssueCard } from "./DocCards.jsx";

// UPDATE_INSTALLATION (spec 11 / 12): after the store issue, record where the
// part went — Line, Machine, Die — and how much was actually used. Repeatable:
// each update sets the issue's CURRENT values and journals an INSTALLATION row
// with the before / after, so an earlier line or machine is never lost. The QR
// itself is never rewritten; the database holds where the part is now.

const trimmed = (v) => String(v ?? "").trim();
// Field hint for a place already recorded: emptying the box clears it (a part
// moved to a machine with no die must not keep showing the old die).
const nowHint = (v) => (v ? `Now: ${v} — empty the box to clear it` : undefined);

export default function InstallForm({ scan, target, onDone, onCancel }) {
  const uid = useId();
  const { part } = scan;
  const { activeCode } = useStores();
  const storeCode = activeCode || "MAINTENANCE";
  const flow = useActionFlow(onDone);
  const issues = useMemo(
    () => (scan.open_issues || []).filter((i) => qtyOf(i.outstanding_qty) > 0),
    [scan.open_issues]);
  const pick = useDocChoice(issues, target);
  const issue = pick.doc;
  const outstanding = qtyOf(issue?.outstanding_qty);

  // Machines already recorded in this store — the same machine is then always
  // spelled the same way (free text is still allowed for a new one).
  const machines = useQuery({
    queryKey: ["stock", "machines", storeCode],
    queryFn: () => spareStockService.machines(storeCode).then((r) => r.data.data || []),
    staleTime: 5 * 60_000,
  });

  const startFrom = (i) => ({
    line_name: i?.line_name || "", line_no: i?.line_no || "", machine: i?.machine || "", die_no: i?.die_no || "",
    // Default: everything still out was used (contract); a previous figure is
    // kept when it is still possible.
    actual: i?.actual_qty != null && qtyOf(i.actual_qty) <= qtyOf(i.outstanding_qty)
      ? qtyOf(i.actual_qty) : qtyOf(i?.outstanding_qty),
  });
  const [form, setForm] = useState(() => startFrom(issue));
  const [remarks, setRemarks] = useState("");
  const [tried, setTried] = useState(false);
  const [forId, setForId] = useState(pick.id);
  if (forId !== pick.id) {
    // Another issue picked — show ITS current values to edit.
    setForId(pick.id);
    setForm(startFrom(issue));
  }
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  // Kept on the confirm step while a write is in flight: this terminal's own
  // write empties the list (SSE refresh) before its response arrives.
  if (!issues.length && !flow.review) {
    return (
      <EmptyNote onCancel={onCancel}>
        No issue of this part is still out — there is nothing to record a line / machine against.
      </EmptyNote>
    );
  }

  const actual = Number(form.actual);
  const hasPlace = ["line_name", "line_no", "machine", "die_no"].some((k) => trimmed(form[k]));
  const unchanged = issue
    && ["line_name", "line_no", "machine", "die_no"].every((k) => trimmed(form[k]) === trimmed(issue[k]))
    && issue.actual_qty != null && Math.abs(actual - qtyOf(issue.actual_qty)) < 0.005;
  const errors = {
    issue: !issue ? "Pick the issue that was installed" : null,
    actual: issue ? qtyError(form.actual, {
      max: outstanding, allowZero: true, maxText: `Only ${fmtQty(outstanding, part.uom)} of this issue is out`,
    }) : null,
    place: issue && actual > 0 && !hasPlace ? "Enter at least the line, machine or die it went on" : null,
    unchanged: unchanged ? "Nothing changed — these are already the recorded values" : null,
  };
  const valid = !Object.values(errors).some(Boolean);
  const show = (k) => (tried || k === "actual" ? errors[k] : null);
  const newStatus = actual >= outstanding - 0.005 ? "INSTALLED" : "PARTIALLY_USED";

  const review = () => {
    setTried(true);
    if (!valid) return;
    // The four place fields are the issue's CURRENT values, so each is always
    // sent — a field the operator emptied goes as null (cleared), not omitted.
    // The confirm route tells the two apart: a left-out key keeps the stored
    // value, a null one clears it on the issue and in the INSTALLATION journal.
    const payload = {
      line_name: clean(form.line_name) ?? null, line_no: clean(form.line_no) ?? null,
      machine: clean(form.machine) ?? null, die_no: clean(form.die_no) ?? null,
      actual_qty: actual, remarks: clean(remarks),
    };
    const it = issue;
    const noneUsed = actual === 0;
    flow.open({
      title: "Update Line / Machine", icon: Wrench, part, qty: actual, uom: part.uom,
      moves: [{
        from: ISSUE_STATUS[it.status] || { label: it.status || "Status not recorded", badge: "badge-neutral" },
        to: noneUsed ? { label: "Confirmed — none used", badge: "badge-neutral" } : ISSUE_STATUS[newStatus],
      }],
      changes: [
        { label: "Line name", from: it.line_name, to: payload.line_name },
        { label: "Line no.", from: it.line_no, to: payload.line_no },
        { label: "Machine", from: it.machine, to: payload.machine },
        { label: "Die", from: it.die_no, to: payload.die_no },
        { label: "Actual usage", from: it.actual_qty != null ? num(it.actual_qty) : null, to: num(actual) },
      ].filter((c) => trimmed(c.from) !== trimmed(c.to))
        // A change to nothing is the operator emptying a recorded value: say it
        // is cleared, not the neutral "Not recorded" the read-back would show.
        .map((c) => (c.to == null ? { ...c, to: "Cleared" } : c)),
      fields: [
        { label: "Issue", value: `${fmtQty(it.issued_qty, part.uom)} to ${it.department || "—"}${it.issued_to ? ` · ${it.issued_to}` : ""}` },
        { label: "Issued", value: fmtStamp(it.issued_at) },
        { label: "Still out", value: fmtQty(outstanding, part.uom) },
        { label: "Remarks", value: payload.remarks },
      ],
      note: "No stock moves here — it left the store at the issue. The previous line / machine stays in the part's history.",
      confirmLabel: "Confirm Update",
      submit: () => flow.run(
        () => spareFlowService.updateInstallation(it.id, payload),
        noneUsed
          ? "Recorded — none of this issue used"
          : `Installation recorded — ${placeText(payload) || "location updated"}`,
      ),
    });
  };

  return (
    <FormShell flow={flow} onCancel={onCancel} onReview={review} reviewLabel="Review update"
      verify={
        <Facts items={[
          { label: "Part No.", value: part.part_no, strong: true },
          { label: "Description", value: part.part_name },
          { label: "Issued out", value: fmtQty(scan.buckets?.issued_out ?? 0, part.uom) },
          issue && { label: "Now recorded at", value: placeText(issue), empty: "Line / machine / die not recorded yet", wide: true },
        ]} />
      }>
      <DocPicker legend="Issue" name={`${uid}-issue`} docs={issues} value={pick.id} onChange={pick.setId}
        error={show("issue")} render={(d) => <IssueCard i={d} uom={part.uom} />} />
      {pick.gone && <GoneNote />}
      {issue && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Line name" htmlFor={`${uid}-ln`} hint={nowHint(issue.line_name)}>
              <input id={`${uid}-ln`} value={form.line_name} maxLength={60} onChange={(e) => set("line_name")(e.target.value)}
                className="input-field" placeholder="Seat slider, recliner…" />
            </Field>
            <Field label="Line no." htmlFor={`${uid}-lno`} hint={nowHint(issue.line_no)}>
              <input id={`${uid}-lno`} value={form.line_no} maxLength={30} onChange={(e) => set("line_no")(e.target.value)}
                className="input-field" placeholder="Line-03" />
            </Field>
            <Field label="Machine" htmlFor={`${uid}-mc`} hint={nowHint(issue.machine) || "Pick a known machine or type a new one"}>
              <input id={`${uid}-mc`} value={form.machine} maxLength={60} list={`${uid}-machines`}
                onChange={(e) => set("machine")(e.target.value)} className="input-field" placeholder="Press-07" autoComplete="off" />
              <datalist id={`${uid}-machines`}>
                {(machines.data || []).map((m) => <option key={m} value={m} />)}
              </datalist>
            </Field>
            <Field label="Die" htmlFor={`${uid}-die`} hint={nowHint(issue.die_no)}>
              <input id={`${uid}-die`} value={form.die_no} maxLength={60} onChange={(e) => set("die_no")(e.target.value)}
                className="input-field" placeholder="Die-12" />
            </Field>
            <Field label="Actual usage" required htmlFor={`${uid}-act`} error={show("actual")}
              hint={`0 – ${num(outstanding)}${part.uom ? ` ${part.uom}` : ""} (still out on this issue)`}>
              <QtyStepper id={`${uid}-act`} value={form.actual} onChange={set("actual")} min={0} max={outstanding}
                size="lg" label="Actual usage" />
            </Field>
            <Field label="Remarks" htmlFor={`${uid}-rem`}>
              <input id={`${uid}-rem`} value={remarks} maxLength={255} onChange={(e) => setRemarks(e.target.value)}
                className="input-field" placeholder="Optional" />
            </Field>
          </div>
          <FormError>{show("place")}</FormError>
          <FormError>{show("unchanged")}</FormError>
          <Note>
            Status after saving: {actual === 0 ? "confirmed — none used" : ISSUE_STATUS[newStatus].label.toLowerCase()}.
            Installed parts can still be returned later if they are removed from the machine.
          </Note>
        </>
      )}
    </FormShell>
  );
}
