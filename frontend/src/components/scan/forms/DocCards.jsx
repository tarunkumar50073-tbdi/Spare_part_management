import React from "react";
import { StatusBadge } from "../ActionConfirm.jsx";
import { ISSUE_STATUS } from "../../spare/IssueLifecycle.jsx";
import { RECEIPT_STATUS, RETURN_STATUS, RGP_STATUS, reasonLabel } from "../../../lib/scanStatus.js";
import { fmtDate, fmtStamp, fmtWhen, num } from "../../../lib/format.js";
import { placeText } from "./flow.js";

// One card body per open document, used by the pick lists of the Scan Part
// forms (scan_result.open_receipts / open_issues / open_returns / open_rgps).
// Only what the document records is shown; a missing value reads as missing.

const ageText = (days) => (days == null ? null : days <= 0 ? "today" : `${num(days)} d ago`);

function Head({ no, status, qty, qtyLabel }) {
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="font-mono text-sm font-bold text-slate-900 dark:text-white">{no || "—"}</span>
      {status}
      {qty != null && (
        <span className="ml-auto text-sm font-semibold tabular-nums text-slate-800 dark:text-slate-100">
          {num(qty)}{" "}<span className="text-[11px] font-normal text-slate-400">{qtyLabel}</span>
        </span>
      )}
    </span>
  );
}

function Line({ children }) {
  return <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">{children}</span>;
}

export function ReceiptCard({ r }) {
  const supplier = r.ven_name ? `${r.ven_name}${r.ven_cd ? ` · ${r.ven_cd}` : ""}` : "Supplier not recorded";
  const invoice = r.invoice_no ? `Invoice ${r.invoice_no}${r.invoice_date ? ` (${fmtDate(r.invoice_date)})` : ""}` : "No invoice no.";
  return (
    <>
      <Head no={r.receipt_no} qty={r.qty_received} qtyLabel="received"
        status={<StatusBadge status={RECEIPT_STATUS[r.status] || r.status} />} />
      <Line>{supplier} · {invoice}{r.check_result ? ` · Check ${r.check_result}` : ""}</Line>
      {r.grn_no && (
        <Line>GRN no. {r.grn_no}{r.grn_date ? ` (${fmtDate(r.grn_date)})` : ""}{r.quality_by ? ` · Quality: ${r.quality_by}` : ""}</Line>
      )}
      <Line>
        Received {fmtStamp(r.created_at)}{r.received_by ? ` by ${r.received_by}` : ""}
        {ageText(r.age_days) ? ` · ${ageText(r.age_days)}` : ""}
      </Line>
    </>
  );
}

export function IssueCard({ i, uom }) {
  const meta = ISSUE_STATUS[i.status];
  return (
    <>
      <Head no={`Issue #${i.id}`} qty={i.outstanding_qty} qtyLabel={`${uom ? `${uom} ` : ""}still out`}
        status={meta ? <StatusBadge status={meta} /> : null} />
      <Line>
        {i.department || "Department not recorded"}{i.issued_to ? ` · ${i.issued_to}` : ""} · issued {fmtStamp(i.issued_at)}
      </Line>
      <Line>
        Issued {num(i.issued_qty)}{Number(i.returned_qty) > 0 ? ` · ${num(i.returned_qty)} returned` : ""}
        {i.actual_qty != null ? ` · ${num(i.actual_qty)} used` : ""}
      </Line>
      <Line>{placeText(i) || "Line / machine / die not recorded yet"}</Line>
    </>
  );
}

export function ReturnCard({ r }) {
  const split = [
    ["to inspect", r.qty_pending], ["hold", r.qty_hold], ["damaged", r.qty_damaged],
    ["good", r.qty_good], ["scrap", r.qty_scrap], ["on RGP", r.qty_rgp],
  ].filter(([, q]) => Number(q) > 0);
  return (
    <>
      <Head no={r.return_no} qty={r.qty} qtyLabel="returned"
        status={<StatusBadge status={RETURN_STATUS[r.status] || r.status} />} />
      <Line>
        {reasonLabel(r.reason)} · from {r.department || "—"}{r.issued_to ? ` · ${r.issued_to}` : ""}
        {r.returned_by ? ` · handed back by ${r.returned_by}` : ""}
      </Line>
      <Line>Returned {fmtStamp(r.created_at)} · issued {fmtWhen(r.issue_date)}{placeText(r) ? ` · ${placeText(r)}` : ""}</Line>
      {split.length > 0 && <Line>{split.map(([k, q]) => `${num(q)} ${k}`).join(" · ")}</Line>}
    </>
  );
}

export function RgpCard({ g, qty, qtyLabel }) {
  return (
    <>
      <Head no={g.rgp_no} qty={qty} qtyLabel={qtyLabel}
        status={<StatusBadge status={RGP_STATUS[g.status] || g.status} />} />
      <Line>{g.ven_name || "Supplier not recorded"}{g.ven_cd ? ` · ${g.ven_cd}` : ""}{g.erp_challan_no ? ` · ERP challan ${g.erp_challan_no}` : ""}</Line>
      <Line>
        Out {fmtDate(g.rgp_date)} · sent {num(g.qty_out)}
        {Number(g.qty_returned) > 0 ? ` · ${num(g.qty_returned)} back` : ""}
        {Number(g.qty_grn) > 0 ? ` · ${num(g.qty_grn)} GRN done` : ""}
        {g.expected_return_date ? ` · expected ${fmtDate(g.expected_return_date)}` : ""}
        {g.overdue && <> · <span className="font-semibold text-rose-600 dark:text-rose-400">Overdue</span></>}
      </Line>
      {g.rework_reason && <Line>Rework: {g.rework_reason}</Line>}
    </>
  );
}
