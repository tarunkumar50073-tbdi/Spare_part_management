import React from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight, CircleCheck, ClipboardCheck, Database, Lock, PackageCheck, RefreshCw, ShieldCheck, TriangleAlert, Truck, Wrench,
} from "lucide-react";
import ErrorState from "../../components/ErrorState.jsx";
import Table from "../../components/Table.jsx";
import { IssueAge, IssueStatusPill, useMinuteClock } from "../../components/spare/IssueLifecycle.jsx";
import { useCan } from "../../components/Can.jsx";
import { usePartDrawer } from "../../context/PartDrawerContext.jsx";
import { spareFlowService } from "../../services/spareFlowService.js";
import { erpFreshness, erpGrnService } from "../../services/erpGrnService.js";
import { ACTIONS, RETURN_STATUS, erpLineMeta as lineState, reasonLabel } from "../../lib/scanStatus.js";
import { fmtDate, fmtStamp, num, parseServerTime } from "../../lib/format.js";

// Work Queue — every spare document waiting on a person, one tab per kind of
// wait: ERP GRN lines waiting for ERP's quality clearance (read-only — the GRN
// and the quality clearance are done in ERP), returns for the store inspection,
// RGPs with the supplier or waiting for their RGP GRN, and issues the fitter
// has not yet confirmed on a line / machine. The page only lists; every action
// is a deep link into Scan Part (which owns the forms), with the part open, the
// action chosen and the document preselected. ERP GRN lines link to Receiving
// & GRN instead — there is nothing to record for them in the app.

// The QR flow exists only for the Spare Parts Store.
const STORE = "MAINTENANCE";

const TABS = [
  { key: "quality", label: "GRN / Quality (ERP)", Icon: ShieldCheck },
  { key: "inspection", label: "Return Inspection", Icon: ClipboardCheck },
  { key: "with_supplier", label: "With Supplier", Icon: Truck },
  { key: "rgp_grn_pending", label: "RGP GRN Pending", Icon: PackageCheck },
  { key: "awaiting_confirmation", label: "Awaiting Installation Confirmation", Icon: Wrench },
];

// What an empty tab means — said plainly, so "nothing here" is never mistaken
// for "not loaded".
const EMPTY = {
  quality: "No ERP GRN line is waiting for quality clearance in ERP, and none needs a check.",
  inspection: "No returned part is waiting for the store inspection, on hold or damaged.",
  with_supplier: "No part is with a supplier for rework.",
  rgp_grn_pending: "No supplier return is waiting for its RGP GRN.",
  awaiting_confirmation: "Every issued part has had its line / machine confirmed.",
};

const DAY_MS = 86_400_000;
const dash = <span className="text-slate-300 dark:text-slate-600">—</span>;
const qty = (v) => Number(v) || 0;

// /scan-part?part=&action=&target= — the deep link Scan Part reads (contract).
const scanLink = (partId, action, target) => {
  const q = new URLSearchParams({ part: String(partId), action });
  if (target != null) q.set("target", String(target));
  return `/scan-part?${q.toString()}`;
};

// /receiving?state=&part_no= — Receiving & GRN opens its ERP GRN lines filtered
// to this part and state.
const receivingLink = (row) => {
  const q = new URLSearchParams();
  if (row.state) q.set("state", row.state);
  if (row.part_no) q.set("part_no", row.part_no);
  return `/receiving?${q.toString()}`;
};

// ERP lines have no id of their own — one per part and GRN no.
const lineKey = (r) => `${r.part_id}|${r.grn_no}`;

// Whole days since a server stamp, on the plant clock. The payload's own
// age_days wins when it carries one, so the page and the server agree.
const ageOf = (row, stamp, now) => {
  if (row.age_days != null) return row.age_days;
  const t = parseServerTime(row[stamp])?.getTime();
  return t == null ? null : Math.max(0, Math.floor((now - t) / DAY_MS));
};

// Past 3 days is worth a look, past 7 it is late — the Receiving monitor's scale.
function Age({ days }) {
  if (days == null) return dash;
  const tone = days > 7
    ? "bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300"
    : days > 3
      ? "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300"
      : "bg-slate-100 text-slate-600 dark:bg-navy-800 dark:text-slate-300";
  return (
    <span className={`inline-block min-w-[2.75rem] rounded-full px-2 py-0.5 text-center text-[11px] font-semibold tabular ${tone}`}>
      {days} d
    </span>
  );
}

/** One action button: a link into Scan Part, or a locked chip for view-only users. */
function ActionLink({ row, action, target, canAct, primary = true }) {
  const meta = ACTIONS[action] || { label: action };
  if (!canAct) {
    return (
      <span title="Your account can view Scan Part but not record on it. Ask an administrator under User Management."
        className="inline-flex items-center gap-1 rounded-md border border-dashed border-slate-200 px-2 py-1 text-[11px] text-slate-400 dark:border-navy-700">
        <Lock size={11} aria-hidden="true" /> {meta.label}
      </span>
    );
  }
  return (
    <Link to={scanLink(row.part_id, action, target)} onClick={(e) => e.stopPropagation()}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-md px-2 py-1 text-[11px] font-semibold transition-colors ${primary
        ? "bg-toyotared text-white hover:brightness-110"
        : "border border-slate-200 text-slate-600 hover:border-toyotared hover:text-toyotared dark:border-navy-700 dark:text-slate-300"}`}>
      {meta.label} <ArrowRight size={12} aria-hidden="true" />
    </Link>
  );
}

const partCol = {
  key: "part_no", label: "Part", sortable: true,
  searchValue: (r) => `${r.part_no || ""} ${r.part_name || ""}`,
  exportValue: (r) => `${r.part_no || ""}${r.part_name ? ` ${r.part_name}` : ""}`,
  render: (r) => (
    <div className="min-w-0">
      <div className="font-mono text-[13px] font-medium text-slate-800 dark:text-white">{r.part_no || "—"}</div>
      <div className="max-w-[220px] truncate text-[11px] text-slate-400">{r.part_name}</div>
    </div>
  ),
};

const supplierCol = {
  key: "ven_name", label: "Supplier", sortable: true,
  searchValue: (r) => `${r.ven_name || ""} ${r.ven_cd || ""}`,
  render: (r) => (r.ven_name ? (
    <div className="min-w-0">
      <div className="max-w-[200px] truncate text-slate-700 dark:text-slate-200">{r.ven_name}</div>
      {/* A vendor code is only ever ERP's own — absent means none was on record. */}
      {r.ven_cd && <div className="font-mono text-[11px] text-slate-400">{r.ven_cd}</div>}
    </div>
  ) : dash),
};

const docCol = (key, label, stampKey) => ({
  key, label, sortable: true,
  exportValue: (r) => r[key] || "",
  render: (r) => (
    <div>
      <div className="font-mono text-[12px] font-semibold text-slate-800 dark:text-slate-100">{r[key] || "—"}</div>
      {stampKey && r[stampKey] && <div className="text-[11px] text-slate-400">{fmtStamp(r[stampKey])}</div>}
    </div>
  ),
});

// "Line L-03 · Machine Press-07 · Die D-12" — only what was recorded.
const whereUsed = (r) => {
  const line = [r.line_name, r.line_no].filter(Boolean).join(" ");
  return [line && `Line ${line}`, r.machine && `Machine ${r.machine}`, r.die_no && `Die ${r.die_no}`]
    .filter(Boolean).join(" · ");
};

// Whole plant days since a date-only ERP date ("2026-09-20"), counted from
// local midnight — not from UTC midnight, which is 05:30 here.
const daysSinceDay = (day, now) => {
  const [y, m, d] = String(day || "").slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return null;
  return Math.max(0, Math.floor((now - new Date(y, m - 1, d).getTime()) / DAY_MS));
};

function columnsFor(tab, { canAct, canViewReceiving, now }) {
  const actionCol = (render) => ({ key: "_action", label: "Action", render });
  const ageCol = (stamp) => ({
    key: "_age", label: "Age", align: "right",
    sortValue: (r) => ageOf(r, stamp, now), exportValue: (r) => ageOf(r, stamp, now),
    render: (r) => <Age days={ageOf(r, stamp, now)} />,
  });

  // ERP GRN lines (read-only): the GRN and the quality clearance are done in
  // ERP, so the only way on is to look at the line in Receiving & GRN.
  if (tab === "quality") {
    const grnAge = (r) => r.age_days ?? daysSinceDay(r.grn_date, now);
    return [
      {
        key: "grn_no", label: "GRN no · date", sortable: true,
        sortValue: (r) => `${r.grn_date || ""} ${r.grn_no || ""}`,
        searchValue: (r) => `${r.grn_no || ""} ${r.invoice_no || ""}`,
        exportValue: (r) => `${r.grn_no || ""}${r.grn_date ? ` (${r.grn_date})` : ""}`,
        render: (r) => (
          <div>
            <div className="font-mono text-[12px] font-semibold text-slate-800 dark:text-slate-100">{r.grn_no || "—"}</div>
            <div className="text-[11px] text-slate-400">{r.grn_date ? fmtDate(r.grn_date) : "no GRN date in ERP"}</div>
          </div>
        ),
      },
      partCol,
      {
        key: "receipt_qty", label: "Qty", align: "right", sortable: true,
        exportValue: (r) => `Received ${qty(r.receipt_qty)}${r.accept_qty != null ? ` / accepted ${qty(r.accept_qty)}` : ""}`
          + `${r.reject_qty != null ? ` / rejected ${qty(r.reject_qty)}` : ""}${qty(r.posted_qty) ? ` / added ${qty(r.posted_qty)}` : ""}`,
        render: (r) => (
          <div>
            <div className="font-semibold text-slate-800 dark:text-white">{num(r.receipt_qty)}</div>
            <div className="whitespace-nowrap text-[11px] text-slate-400">
              {r.accept_qty == null && r.reject_qty == null
                ? "received · not accepted yet"
                : `accepted ${num(r.accept_qty ?? 0)} · rejected ${num(r.reject_qty ?? 0)}`}
            </div>
            {qty(r.posted_qty) > 0 && (
              <div className="whitespace-nowrap text-[11px] text-slate-400">added to stock {num(r.posted_qty)}</div>
            )}
          </div>
        ),
      },
      supplierCol,
      {
        key: "state", label: "State", sortable: true,
        exportValue: (r) => lineState(r.state).label, searchValue: (r) => lineState(r.state).label,
        render: (r) => <span className={`badge whitespace-nowrap ${lineState(r.state).badge}`}>{lineState(r.state).label}</span>,
      },
      {
        key: "reason", label: "Reason",
        render: (r) => <span className="block max-w-[280px] text-[12px] leading-snug text-slate-500 dark:text-slate-400">{r.reason || "—"}</span>,
      },
      {
        key: "_age", label: "Days since GRN", align: "right",
        sortValue: grnAge, exportValue: grnAge,
        render: (r) => <Age days={grnAge(r)} />,
      },
      actionCol((r) => (canViewReceiving ? (
        <Link to={receivingLink(r)} onClick={(e) => e.stopPropagation()}
          className="inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-600 transition-colors hover:border-toyotared hover:text-toyotared dark:border-navy-700 dark:text-slate-300">
          View in Receiving &amp; GRN <ArrowRight size={12} aria-hidden="true" />
        </Link>
      ) : (
        <span title="Your account cannot open Receiving & GRN. Ask an administrator under User Management."
          className="inline-flex items-center gap-1 rounded-md border border-dashed border-slate-200 px-2 py-1 text-[11px] text-slate-400 dark:border-navy-700">
          <Lock size={11} aria-hidden="true" /> Receiving &amp; GRN
        </span>
      ))),
    ];
  }

  if (tab === "inspection") {
    return [
      docCol("return_no", "Return no", "created_at"),
      partCol,
      {
        key: "qty", label: "Qty", sortable: true,
        exportValue: (r) => `To inspect ${qty(r.qty_pending)} / Hold ${qty(r.qty_hold)} / Damaged ${qty(r.qty_damaged)}`,
        render: (r) => (
          <div className="flex flex-wrap gap-1">
            {qty(r.qty_pending) > 0 && <span className="badge badge-warning">To inspect {num(r.qty_pending)}</span>}
            {qty(r.qty_hold) > 0 && <span className="badge badge-warning">Hold {num(r.qty_hold)}</span>}
            {qty(r.qty_damaged) > 0 && <span className="badge badge-danger">Damaged {num(r.qty_damaged)}</span>}
            <span className="text-[11px] text-slate-400 self-center">of {num(r.qty)} returned</span>
          </div>
        ),
      },
      {
        key: "reason", label: "Reason", sortable: true,
        exportValue: (r) => reasonLabel(r.reason), searchValue: (r) => reasonLabel(r.reason),
        render: (r) => reasonLabel(r.reason),
      },
      {
        key: "department", label: "Came back from", sortable: true,
        searchValue: (r) => `${r.department || ""} ${r.issued_to || ""} ${whereUsed(r)}`,
        exportValue: (r) => [r.department, r.issued_to, whereUsed(r)].filter(Boolean).join(" · "),
        render: (r) => (
          <div className="min-w-0">
            <div className="text-slate-700 dark:text-slate-200">
              {[r.department, r.issued_to].filter(Boolean).join(" · ") || "Department not recorded"}
            </div>
            <div className="max-w-[260px] truncate text-[11px] text-slate-400">{whereUsed(r) || "Line / machine / die not recorded"}</div>
          </div>
        ),
      },
      {
        key: "status", label: "Status", sortable: true,
        exportValue: (r) => RETURN_STATUS[r.status]?.label || r.status,
        render: (r) => (
          <span className={`badge ${RETURN_STATUS[r.status]?.badge || "badge-neutral"}`}>
            {RETURN_STATUS[r.status]?.label || r.status || "—"}
          </span>
        ),
      },
      ageCol("created_at"),
      actionCol((r) => (
        <div className="flex flex-wrap gap-1.5">
          <ActionLink row={r} action="INSPECT" target={r.id} canAct={canAct} />
          {/* A return's held / damaged quantity can go to a supplier for rework from here. */}
          {qty(r.qty_hold) + qty(r.qty_damaged) > 0 && (
            <ActionLink row={r} action="RGP_OUT" target={r.id} canAct={canAct} primary={false} />
          )}
        </div>
      )),
    ];
  }

  if (tab === "with_supplier" || tab === "rgp_grn_pending") {
    const withSupplier = tab === "with_supplier";
    return [
      {
        key: "rgp_no", label: "RGP no", sortable: true,
        searchValue: (r) => `${r.rgp_no || ""} ${r.erp_challan_no || ""} ${r.return_no || ""}`,
        render: (r) => (
          <div>
            <div className="font-mono text-[12px] font-semibold text-slate-800 dark:text-slate-100">{r.rgp_no || "—"}</div>
            {r.erp_challan_no && <div className="text-[11px] text-slate-400">ERP challan {r.erp_challan_no}</div>}
            {r.return_no && <div className="text-[11px] text-slate-400">from {r.return_no}</div>}
            {r.rework_bin && <div className="text-[11px] text-amber-700 dark:text-amber-300">back to the rework bin {r.rework_bin}</div>}
          </div>
        ),
      },
      partCol,
      supplierCol,
      withSupplier
        ? {
          key: "qty_with_supplier", label: "With supplier", align: "right", sortable: true,
          render: (r) => (
            <span>
              <b className="font-semibold">{num(r.qty_with_supplier)}</b>
              {qty(r.qty_out) !== qty(r.qty_with_supplier) && <span className="text-[11px] text-slate-400"> of {num(r.qty_out)}</span>}
            </span>
          ),
        }
        : {
          key: "qty_grn_pending", label: "Returned, GRN pending", align: "right", sortable: true,
          render: (r) => (
            <span>
              <b className="font-semibold">{num(r.qty_grn_pending)}</b>
              <span className="text-[11px] text-slate-400"> of {num(r.qty_out)} sent</span>
            </span>
          ),
        },
      {
        key: "rework_reason", label: "Rework reason",
        render: (r) => <span className="block max-w-[200px] truncate" title={r.rework_reason || undefined}>{r.rework_reason || "—"}</span>,
      },
      { key: "rgp_date", label: "RGP date", sortable: true, exportValue: (r) => r.rgp_date || "", render: (r) => fmtDate(r.rgp_date) },
      {
        key: "expected_return_date", label: "Expected return", sortable: true,
        exportValue: (r) => (r.expected_return_date ? `${r.expected_return_date}${r.overdue ? " (overdue)" : ""}` : ""),
        render: (r) => (!r.expected_return_date ? <span className="text-[11px] text-slate-400">Not set</span> : (
          <span className={r.overdue && withSupplier ? "font-semibold text-rose-600 dark:text-rose-400" : ""}>
            {fmtDate(r.expected_return_date)}
            {r.overdue && withSupplier && <span className="ml-1.5 badge badge-danger">Overdue</span>}
          </span>
        )),
      },
      actionCol((r) => (withSupplier
        ? <ActionLink row={r} action="RGP_RETURN" target={r.id} canAct={canAct} />
        : <ActionLink row={r} action="RGP_GRN" target={r.id} canAct={canAct} />)),
    ];
  }

  // awaiting_confirmation — pending_confirmations rows (ISSUE ledger rows).
  return [
    {
      key: "issued_at", label: "Issued", sortable: true,
      exportValue: (r) => fmtStamp(r.issued_at),
      render: (r) => (
        <div>
          <div className="text-slate-700 dark:text-slate-200">{fmtStamp(r.issued_at)}</div>
          <IssueAge at={r.issued_at} now={now} prefix="" />
        </div>
      ),
    },
    partCol,
    // What is still out with the user, not the issued qty: an issue partly
    // returned before anyone confirmed it waits here too (the Waiting list
    // rule, 16 Oct 2026) — "2 out of 3 · 1 returned", as Confirm Installation
    // and Scan Part show it. A row from an older server has no outstanding_qty.
    {
      key: "qty", label: "Qty out", align: "right", sortable: true,
      sortValue: (r) => Number(r.outstanding_qty ?? r.qty ?? 0),
      exportValue: (r) => Number(r.outstanding_qty ?? r.qty ?? 0),
      render: (r) => (Number(r.returned_qty) > 0 ? (
        <div className="whitespace-nowrap">
          <span className="tabular">{num(r.outstanding_qty)}</span>
          <span className="text-slate-500 dark:text-slate-400"> out of {num(r.qty)}</span>
          <div className="text-[11px] text-slate-400">{num(r.returned_qty)} returned</div>
        </div>
      ) : num(r.qty)),
    },
    {
      key: "department", label: "Department / issued to", sortable: true,
      searchValue: (r) => `${r.department || ""} ${r.issued_to || ""}`,
      exportValue: (r) => [r.department, r.issued_to].filter(Boolean).join(" · "),
      render: (r) => [r.department, r.issued_to].filter(Boolean).join(" · ") || dash,
    },
    {
      key: "_where", label: "Line / machine / die",
      searchValue: whereUsed, exportValue: whereUsed,
      render: (r) => whereUsed(r) || <span className="text-[11px] text-slate-400">Not given yet</span>,
    },
    {
      key: "status", label: "Status", sortable: true,
      render: (r) => <IssueStatusPill issue={r} />,
    },
    actionCol((r) => <ActionLink row={r} action="UPDATE_INSTALLATION" target={r.id} canAct={canAct} />),
  ];
}

function QueueSkeleton() {
  return (
    <div className="card space-y-2" aria-busy="true" aria-label="Loading the work queue">
      {Array.from({ length: 6 }).map((_, i) => <div key={i} className="skeleton h-10 w-full" />)}
    </div>
  );
}

export default function WorkQueue() {
  const { openPart } = usePartDrawer();
  const canAct = useCan("scan_part", "edit");
  const canViewReceiving = useCan("spare_store", "view");
  // GET /erp-grn/preview is any-of (spare_store, store_stock) view. Each hook
  // is called on every render, never inside a short-circuit.
  const canViewStock = useCan("store_stock", "view");
  const canReadErpGrn = canViewReceiving || canViewStock;
  const now = useMinuteClock();
  const [params, setParams] = useSearchParams();

  // Under the shared "stock" key: an issue, return or GRN anywhere (the SSE
  // "stock" event) refreshes the queue live. Silent: the page says itself when
  // the queue fails (ErrorState, or the "last refresh failed" line) — a toast
  // too would repeat on every stock event while the endpoint is down.
  const { data, isPending, isError, error, refetch, isFetching, dataUpdatedAt } = useQuery({
    queryKey: ["stock", "flow-queues", STORE],
    queryFn: () => spareFlowService.queues(STORE, { silent: true }).then((r) => r.data.data),
  });

  const listOf = (key) => (Array.isArray(data?.[key]) ? data[key] : []);
  const countOf = (key) => (data?.counts?.[key] ?? listOf(key).length);

  // ?tab= keeps the tab across a reload / a shared link. With none, open on the
  // first tab that has something waiting.
  const asked = params.get("tab");
  const tab = TABS.some((t) => t.key === asked) ? asked
    : (data && TABS.find((t) => countOf(t.key) > 0)?.key) || TABS[0].key;
  const setTab = (key) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    next.set("tab", key);
    return next;
  }, { replace: true });

  const total = data ? TABS.reduce((s, t) => s + countOf(t.key), 0) : null;
  const rows = listOf(tab);
  const active = TABS.find((t) => t.key === tab);

  // The GRN / Quality lines are ERP data, so they carry the GRN mirror's
  // freshness: from the queue payload when it sends it, else from the ERP GRN
  // read Receiving & GRN shares (same cache key — one call for both).
  const queueErp = data?.erp || data?.quality_erp || null;
  const { data: erpPreview, isError: erpFailed } = useQuery({
    queryKey: ["stock", "erp-grn", STORE],
    queryFn: () => erpGrnService.preview(STORE, { silent: true }).then((r) => r.data.data),
    enabled: Boolean(data) && !queueErp && tab === "quality" && canReadErpGrn,
  });
  const erpSource = queueErp || erpPreview?.erp || null;
  const fresh = erpSource ? erpFreshness(erpSource, now) : null;

  const header = (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="text-lg font-bold text-slate-800 dark:text-white">Work Queue</h2>
        <p className="mt-0.5 text-xs text-slate-400">
          Spare Parts Store · everything waiting on a person. Each action opens the part on Scan Part with the form
          ready and the document picked. GRN / Quality is ERP&apos;s own list — cleared in ERP, shown here read-only.
        </p>
      </div>
      <div className="flex items-center gap-2">
        {data && dataUpdatedAt > 0 && (
          <span className="text-[11px] text-slate-400">
            Updated {new Date(dataUpdatedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
          </span>
        )}
        <button type="button" onClick={() => refetch()} disabled={isFetching}
          className="btn-secondary inline-flex items-center gap-1.5 !py-1.5 text-xs">
          <RefreshCw size={13} className={isFetching ? "animate-spin" : ""} aria-hidden="true" />
          Refresh
        </button>
      </div>
    </div>
  );

  let body;
  if (isPending) {
    body = <QueueSkeleton />;
  } else if (isError && !data) {
    body = (
      <div className="card">
        <ErrorState title="Could not load the work queue"
          message={error?.response?.data?.message || "The queue did not answer. Nothing has changed; try again."}
          onRetry={() => refetch()} />
      </div>
    );
  } else {
    body = (
      <div className="card">
        <div role="tablist" aria-label="Work queues" className="mb-4 flex flex-wrap gap-2">
          {TABS.map((t) => {
            const on = tab === t.key;
            const n = countOf(t.key);
            return (
              <button key={t.key} type="button" role="tab" aria-selected={on} onClick={() => setTab(t.key)}
                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${on
                  ? "border-toyotared bg-toyotared text-white"
                  : "border-slate-200 text-slate-600 hover:border-toyotared dark:border-navy-700 dark:text-slate-300"}`}>
                <t.Icon size={13} aria-hidden="true" />
                {t.label}
                <span className={`tabular rounded-full px-1.5 text-[11px] font-semibold ${on
                  ? "bg-white/20"
                  : n ? "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300" : "bg-slate-100 text-slate-400 dark:bg-navy-800"}`}>
                  {num(n)}
                </span>
              </button>
            );
          })}
        </div>

        {tab === "quality" && (
          <div className="mb-3 space-y-2">
            <p className={`flex items-center gap-1.5 text-[11px] ${fresh?.stale
              ? "font-medium text-amber-700 dark:text-amber-300" : "text-slate-500 dark:text-slate-400"}`}>
              <Database size={13} aria-hidden="true" />
              {fresh ? fresh.text
                : !canReadErpGrn || erpFailed
                  ? "Read from the ERP GRN register — how fresh the ERP data is could not be read"
                  : "Reading how fresh the ERP data is…"}
            </p>
            {fresh?.stale && (
              <p className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
                <TriangleAlert size={14} className="mt-px shrink-0" aria-hidden="true" />
                <span>
                  {fresh.empty
                    ? "The ERP GRN mirror is empty, so this list cannot show anything yet."
                    : `ERP data is ${fresh.staleText}`}
                </span>
              </p>
            )}
          </div>
        )}

        {rows.length === 0 ? (
          <div className="flex flex-col items-center py-12 text-center">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300">
              <CircleCheck size={22} aria-hidden="true" />
            </span>
            <p className="mt-3 text-sm font-semibold text-slate-800 dark:text-white">Nothing waiting</p>
            <p className="mt-1 max-w-md text-xs text-slate-400">{EMPTY[tab]}</p>
          </div>
        ) : (
          <Table
            key={tab}
            columns={columnsFor(tab, { canAct, canViewReceiving, now })}
            rows={rows}
            rowKey={tab === "quality" ? lineKey : undefined}
            searchable={rows.length > 8 ? "Search part, document, supplier…" : false}
            exportName={`work_queue_${tab}`}
            maxHeight="62vh"
            onRowClick={(r) => { if (r.part_id != null) openPart(r.part_id); }}
            emptyMessage="Nothing waiting"
          />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {header}
      {isError && data && (
        <p className="text-xs text-amber-700 dark:text-amber-300">
          The last refresh failed — showing the queue as last loaded.
        </p>
      )}
      {data && total === 0 && (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          All clear — no ERP GRN line, return, RGP or issue is waiting on anyone.
        </p>
      )}
      {body}
      {data && (
        <p className="text-[11px] leading-relaxed text-slate-400">
          {active?.label}: tap a row to open the part. This page only lists — each action is recorded on Scan Part.
          Receiving, the GRN and the Maintenance / Tool Room quality clearance are done in ERP: the app reads them, and
          the qty quality accepts in ERP is added to store stock once, by itself — nothing to record here, and the app
          does not write to ERP. Returned parts go straight back into store stock; material with a supplier is
          not stock until its RGP GRN.
        </p>
      )}
    </div>
  );
}
