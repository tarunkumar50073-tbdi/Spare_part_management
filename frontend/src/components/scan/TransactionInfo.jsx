import React, { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowUpFromLine, ChevronDown, ChevronRight, ClipboardCheck, Clock, FileCheck2, TriangleAlert, Truck } from "lucide-react";
import { IssueAge, IssueStatusPill, isAwaitingConfirmation, issueAge, useMinuteClock } from "../spare/IssueLifecycle.jsx";
import { useCan } from "../Can.jsx";
import ErpAsOf from "./ErpAsOf.jsx";
import { fmtDate, num } from "../../lib/format.js";
import { ACTIONS, RETURN_STATUS, RGP_STATUS, erpLineMeta, reasonLabel } from "../../lib/scanStatus.js";

// (d) The part's OPEN documents (spec 30: who was it issued to, which line /
// machine / die, was it returned, which supplier has it, which RGP): issues
// still out, returns waiting for inspection, RGPs with a supplier — and, read
// only, the part's GRNs as ERP has them (receiving, the GRN and quality
// clearance are done in ERP; the app reads them, it records none by hand).
// Compact — three rows per kind, the rest on request — so the actions below
// stay in reach. A row offers the action that moves THAT document on,
// pre-selected in the form (only when the action is open to this user now).
const SHOW = 3;

// ERP GRN lines still waiting on ERP (quality) or on the app (to be added /
// checked); POSTED ones are the latest receipts already in store stock.
const ERP_OPEN = new Set(["QUALITY_PENDING", "WILL_POST", "CHECK"]);

// How long an issue has been out. Amber after two days only while it still
// waits for the fitter's Stage-2 confirmation — the Waiting list's own rule
// (isAwaitingConfirmation: never confirmed, still out; an issue partly returned
// before anyone confirmed it waits too). The open issues also carry fitted ones
// (INSTALLED / PARTIALLY_USED, or confirmed and then partly returned) — out on
// the line, possibly for weeks, and rightly so: those just say when they went out.
function IssuedWhen({ issue, now }) {
  if (isAwaitingConfirmation(issue)) return <IssueAge at={issue.issued_at} now={now} />;
  const age = issueAge(issue.issued_at, now);
  if (!age) return <span className="text-[11px] text-slate-400">Issue time not recorded</span>;
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap px-1.5 py-0.5 text-[11px] font-semibold tabular text-slate-500 dark:text-slate-400">
      <Clock size={12} aria-hidden="true" />issued {age.text}
    </span>
  );
}

function DocAction({ actionKey, target, canAct, onAction }) {
  if (!canAct(actionKey)) return null;
  return (
    <button type="button" onClick={() => onAction(actionKey, target)}
      className="inline-flex items-center gap-0.5 whitespace-nowrap rounded text-xs font-semibold text-toyotared hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-toyotared/40">
      {ACTIONS[actionKey]?.label || actionKey}<ChevronRight size={13} aria-hidden="true" />
    </button>
  );
}

function GroupTitle({ icon: Icon, title, count }) {
  return (
    <h3 className="mb-1.5 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">
      <Icon size={13} aria-hidden="true" />{title}{count != null && <span className="tabular">({count})</span>}
    </h3>
  );
}

function Group({ icon, title, rows, render, rowKey = (r) => r.id, footer = null }) {
  const [all, setAll] = useState(false);
  if (!rows.length) return null;
  const shown = all ? rows : rows.slice(0, SHOW);
  return (
    <div>
      <GroupTitle icon={icon} title={title} count={rows.length} />
      <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-navy-800 dark:border-navy-700">
        {shown.map((r) => <li key={rowKey(r)} className="px-3 py-2">{render(r)}</li>)}
      </ul>
      {rows.length > SHOW && (
        <button type="button" onClick={() => setAll((a) => !a)}
          className="mt-1 text-xs font-semibold text-slate-500 hover:text-toyotared dark:text-slate-400">
          {all ? "Show fewer" : `Show all ${rows.length}`}
        </button>
      )}
      {footer}
    </div>
  );
}

// One ERP GRN line of the part, as ERP has it (ErpGrnPostingService line):
// GRN no. + date, supplier, received / accepted / rejected, and what the app
// does with it. Nothing here can be changed in the app.
function ErpLine({ l }) {
  const st = erpLineMeta(l.state);
  const supplier = l.ven_name ? `${l.ven_name}${l.ven_cd ? ` · ${l.ven_cd}` : ""}` : l.ven_cd || "Supplier not in the ERP row";
  return (
    <div className="min-w-0">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold text-slate-800 dark:text-slate-100">
        <span className="font-mono">GRN {l.grn_no}</span>
        <span className={`badge ${st.badge}`}>{st.label}</span>
        <span className="text-[11px] font-normal text-slate-400">{l.grn_date ? fmtDate(l.grn_date) : "GRN date not in ERP"}</span>
      </p>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        {supplier}{l.invoice_no && ` · Inv ${l.invoice_no}`}
      </p>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        Received <b className="tabular font-semibold text-slate-700 dark:text-slate-200">{num(l.receipt_qty)}</b>
        {" · "}Accepted{" "}
        {l.accept_qty == null
          ? <span className="text-slate-400">not yet entered in ERP</span>
          : <b className="tabular font-semibold text-slate-700 dark:text-slate-200">{num(l.accept_qty)}</b>}
        {Number(l.reject_qty) > 0 && <> · Rejected <b className="tabular font-semibold text-rose-600 dark:text-rose-400">{num(l.reject_qty)}</b></>}
      </p>
      {l.reason && <p className="text-[11px] text-slate-400">{l.reason}</p>}
    </div>
  );
}

// scan.erp_receiving — { lines, erp: { synced_at, newest_grn_date } }. Always
// shown with the mirror's freshness, and a way to the Receiving & GRN page.
function ErpReceiving({ block }) {
  const mayOpen = useCan("receiving");
  const lines = [...(block.lines || [])]
    .sort((a, b) => Number(ERP_OPEN.has(b.state)) - Number(ERP_OPEN.has(a.state)));
  const title = "Receiving — ERP GRN (read-only)";
  const footer = (
    <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <ErpAsOf erp={block.erp} />
      {mayOpen && (
        <Link to="/receiving"
          className="inline-flex items-center gap-0.5 whitespace-nowrap rounded text-xs font-semibold text-toyotared hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-toyotared/40">
          Receiving &amp; GRN<ChevronRight size={13} aria-hidden="true" />
        </Link>
      )}
    </div>
  );
  if (!lines.length) {
    return (
      <div>
        <GroupTitle icon={FileCheck2} title={title} />
        <p className="text-sm text-slate-500 dark:text-slate-400">
          No GRN of this part is waiting for quality or to be added to store stock in the ERP data.
        </p>
        {footer}
      </div>
    );
  }
  return (
    <Group icon={FileCheck2} title={title} rows={lines} rowKey={(l) => l.grn_no}
      render={(l) => <ErpLine l={l} />} footer={footer} />
  );
}

// "Line 03 / Machine Press-07 / Die Die-12". A line name that already says
// "Line …" is not prefixed again.
const lineOf = (r) => {
  const line = [r.line_name, r.line_no].filter(Boolean).join(" ");
  return [
    line && (/^line\b/i.test(line) ? line : `Line ${line}`),
    r.machine && `Machine ${r.machine}`,
    r.die_no && `Die ${r.die_no}`,
  ].filter(Boolean).join(" / ");
};

/**
 * canAct(key)            the action is enabled for this part AND the user may do it
 * onAction(key, target)  open that action's form with the document pre-selected
 * collapsed              an action form is open — show a one-line summary only
 */
export default function TransactionInfo({ scan, canAct, onAction, collapsed = false }) {
  const nowMs = useMinuteClock();
  const [expanded, setExpanded] = useState(false);
  const issues = scan.open_issues || [];
  const returns = scan.open_returns || [];
  const rgps = scan.open_rgps || [];
  const erp = scan.erp_receiving || null;
  const erpOpen = (erp?.lines || []).filter((l) => ERP_OPEN.has(l.state)).length;
  const docs = issues.length + returns.length + rgps.length;
  const total = docs + erpOpen;
  const shown = !collapsed || expanded;
  const summary = [
    issues.length && `${issues.length} issue${issues.length === 1 ? "" : "s"} out`,
    returns.length && `${returns.length} return${returns.length === 1 ? "" : "s"}`,
    rgps.length && `${rgps.length} RGP${rgps.length === 1 ? "" : "s"}`,
    erpOpen && `${erpOpen} GRN${erpOpen === 1 ? "" : "s"} in ERP`,
  ].filter(Boolean).join(" · ");

  return (
    <section className="card p-4" aria-label="Open transactions">
      <button type="button" onClick={() => collapsed && setExpanded((e) => !e)}
        aria-expanded={shown} disabled={!collapsed}
        className="flex w-full items-center justify-between gap-2 text-left disabled:cursor-default">
        <span className="kpi-label">Transaction information</span>
        <span className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
          {total === 0 ? "Nothing open" : summary}
          {collapsed && <ChevronDown size={14} className={`transition-transform ${shown ? "rotate-180" : ""}`} aria-hidden="true" />}
        </span>
      </button>

      {shown && (
        <div className="mt-3 space-y-4">
          {docs === 0 && (
            <p className="text-sm text-slate-500 dark:text-slate-400">
              No open documents — nothing issued out, returned or with a supplier.
            </p>
          )}

          <Group icon={ArrowUpFromLine} title="Issued — on the line" rows={issues} render={(r) => {
            const where = lineOf(r);
            return (
              <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                    <span className="tabular">{num(r.outstanding_qty)}</span> out
                    {Number(r.issued_qty) !== Number(r.outstanding_qty) && <span className="font-normal text-slate-500"> of {num(r.issued_qty)}</span>}
                    {" · "}{r.department || "Department not recorded"}
                    {r.issued_to && <span className="font-normal text-slate-500"> → {r.issued_to}</span>}
                  </p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {where}
                  </p>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <IssueStatusPill issue={r} />
                    <IssuedWhen issue={r} now={nowMs} />
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <DocAction actionKey="RETURN" target={r.id} canAct={canAct} onAction={onAction} />
                </div>
              </div>
            );
          }} />

          <Group icon={ClipboardCheck} title="Returned — store inspection" rows={returns} render={(r) => {
            const st = RETURN_STATUS[r.status];
            const split = [
              Number(r.qty_pending) > 0 && `${num(r.qty_pending)} to inspect`,
              Number(r.qty_hold) > 0 && `${num(r.qty_hold)} on hold`,
              Number(r.qty_damaged) > 0 && `${num(r.qty_damaged)} damaged`,
            ].filter(Boolean).join(" · ");
            const age = issueAge(r.created_at, nowMs);
            const heldOrDamaged = Number(r.qty_hold) + Number(r.qty_damaged) > 0;
            return (
              <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-100">
                    <span className="font-mono">{r.return_no}</span>
                    <span className={`badge ${st?.badge || "badge-neutral"}`}>{st?.label || r.status}</span>
                  </p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {split || `Qty ${num(r.qty)}`} · {reasonLabel(r.reason)}
                    {r.department && ` · from ${r.department}`}{r.issued_to && ` (${r.issued_to})`}
                  </p>
                  {lineOf(r) && <p className="text-[11px] text-slate-400">Was on {lineOf(r)}</p>}
                </div>
                <div className="flex flex-col items-end gap-1">
                  {age && <span className="text-[11px] text-slate-400">returned {age.text}</span>}
                  <DocAction actionKey="INSPECT" target={r.id} canAct={canAct} onAction={onAction} />
                  {heldOrDamaged && <DocAction actionKey="RGP_OUT" target={r.id} canAct={canAct} onAction={onAction} />}
                </div>
              </div>
            );
          }} />

          <Group icon={Truck} title="RGP — supplier rework" rows={rgps} render={(r) => {
            const st = RGP_STATUS[r.status];
            return (
              <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-100">
                    <span className="font-mono">{r.rgp_no}</span>
                    <span className={`badge ${st?.badge || "badge-neutral"}`}>{st?.label || r.status}</span>
                  </p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {r.ven_name || "Supplier not recorded"}
                    {Number(r.qty_with_supplier) > 0 && ` · ${num(r.qty_with_supplier)} with supplier`}
                    {Number(r.qty_grn_pending) > 0 && ` · ${num(r.qty_grn_pending)} back, RGP GRN pending`}
                    {r.rework_reason && ` · ${r.rework_reason}`}
                  </p>
                  <p className="text-[11px] text-slate-400">
                    Out {fmtDate(r.rgp_date)}
                    {r.expected_return_date ? ` · expected back ${fmtDate(r.expected_return_date)}` : " · no expected return date"}
                    {r.erp_challan_no && ` · ERP challan ${r.erp_challan_no}`}
                  </p>
                  {r.rework_bin && (
                    <p className="text-[11px] text-amber-700 dark:text-amber-300">Back to the rework bin {r.rework_bin}</p>
                  )}
                  {r.overdue && (
                    <p className="mt-0.5 inline-flex items-center gap-1 rounded-md bg-rose-100 px-1.5 py-0.5 text-[11px] font-bold text-rose-700 dark:bg-rose-500/15 dark:text-rose-300">
                      <TriangleAlert size={12} aria-hidden="true" />Overdue — past the expected return date
                    </p>
                  )}
                </div>
                <div className="flex flex-col items-end gap-1">
                  {Number(r.qty_with_supplier) > 0 && <DocAction actionKey="RGP_RETURN" target={r.id} canAct={canAct} onAction={onAction} />}
                  {Number(r.qty_grn_pending) > 0 && <DocAction actionKey="RGP_GRN" target={r.id} canAct={canAct} onAction={onAction} />}
                </div>
              </div>
            );
          }} />

          {erp && <ErpReceiving block={erp} />}
        </div>
      )}
    </section>
  );
}
