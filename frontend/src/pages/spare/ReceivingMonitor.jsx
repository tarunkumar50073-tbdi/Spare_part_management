import React, { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  ChevronRight, CircleCheck, CircleDashed, CircleDot, ClipboardCheck, Database, FileCheck2, FileText, Hourglass,
  PackageCheck, PackagePlus, ShieldCheck, Truck, Workflow,
} from "lucide-react";
import CardHead from "../../components/CardHead.jsx";
import ErrorState from "../../components/ErrorState.jsx";
import KpiCard from "../../components/KpiCard.jsx";
import Table from "../../components/Table.jsx";
import { useStores } from "../../context/StoreContext.jsx";
import { usePartDrawer } from "../../context/PartDrawerContext.jsx";
import { receivingMonitorService } from "../../services/receivingMonitorService.js";
import { RECEIPT_STATUS } from "../../lib/scanStatus.js";
import { fmtDate, fmtStamp, num, parseServerTime } from "../../lib/format.js";

const WINDOWS = [30, 90, 180];
// Spec 1: spare receiving is ONE flow — received, GRN, quality, stock — with no
// separate SRV step. "GRN / Quality" (the app's receipts, payload `flow`) leads;
// the SRV register is kept as an ERP reference list, not as a step. The flow
// tab shows only when the server sends that block.
const TABS = [
  { key: "flow", label: "GRN / Quality" },
  { key: "grn", label: "ERP GRN lines" },
  { key: "receipts", label: "Added to stock" },
  { key: "srv", label: "ERP inbound register" },
  { key: "gate", label: "At gate, not received" },
];

// Receipts still waiting on a person (spare_receipts.status).
const RECEIPT_OPEN = new Set(["RECEIVED", "QUALITY_PENDING"]);
// Ledger RECEIPT rows whose stock-in happened in ERP through the GRN the
// supervisor created there (ERP_ORIGIN_RECEIPT_STATUSES, models/spare_stock.py)
// — the app never pushes them, so "Not pushed" would be the wrong word.
const ERP_ORIGIN = { STOCK_AVAILABLE: "Quality cleared", RGP_GRN: "RGP GRN — back from rework" };

const count = (n, word) => `${num(n)} ${word}${n === 1 ? "" : "s"}`;

const LEDGER_WORDS = { OPENING: "opening count", ISSUE: "issue", RETURN: "return", ADJUSTMENT: "adjustment" };

const dash = <span className="text-slate-300 dark:text-slate-600">—</span>;

// Exports carry the same local time the table shows, with the year — never the
// raw UTC string the API sends.
const localStamp = (iso) => {
  const d = parseServerTime(iso);
  if (!d) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

// Age past 3 days is worth a look, past 7 it is late — for a line still
// waiting. `muted` is for a finished event (a GRN, a cleared receipt, a closed
// inbound line): its age is history, not a delay.
function Age({ days, muted = false }) {
  if (days == null) return dash;
  const tone = muted
    ? "bg-slate-100 text-slate-500 dark:bg-navy-800 dark:text-slate-400"
    : days > 7
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

const Chip = ({ tone = "neutral", children, title }) => {
  const tones = {
    neutral: "bg-slate-100 text-slate-600 dark:bg-navy-800 dark:text-slate-300",
    green: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300",
    amber: "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300",
    red: "bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300",
    blue: "bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300",
  };
  return (
    <span title={title} className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap ${tones[tone]}`}>
      {children}
    </span>
  );
};

const CHECK_TONE = { OK: "green", SHORT: "amber", EXCESS: "amber", DAMAGED: "red" };
const PIPELINE_TONE = {
  "Verification Pending": "amber", Created: "blue", "Engineer Pending": "amber",
  Approved: "green", Rejected: "red", "ERP Updated": "green",
};

const partCol = {
  key: "part_no", label: "Part", sortable: true,
  searchValue: (r) => `${r.part_no} ${r.part_name || ""}`,
  exportValue: (r) => `${r.part_no}${r.part_name ? ` ${r.part_name}` : ""}`,
  render: (r) => (
    <div className="min-w-0">
      <div className="font-medium text-slate-800 dark:text-white">{r.part_no}</div>
      <div className="max-w-[220px] truncate text-[11px] text-slate-400">{r.part_name}</div>
    </div>
  ),
};
const sectionCol = { key: "section", label: "Section", sortable: true, render: (r) => r.section || dash };
const qtyCol = (key, label) => ({
  key, label, align: "right", sortable: true, render: (r) => (r[key] == null ? dash : num(r[key])),
});

const GRN_COLUMNS = [
  { key: "grn_date", label: "GRN date", sortable: true, render: (r) => fmtDate(r.grn_date) },
  { key: "grn_no", label: "GRN no", sortable: true, render: (r) => r.grn_no || dash },
  partCol,
  { key: "description", label: "Description (ERP)", render: (r) => <span className="block max-w-[240px] truncate">{r.description || "—"}</span> },
  qtyCol("qty", "Accepted"),
  {
    key: "reject_qty", label: "Rejected", align: "right", sortable: true,
    render: (r) => (r.reject_qty ? <span className="font-semibold text-rose-600 dark:text-rose-400">{num(r.reject_qty)}</span> : dash),
  },
  { key: "supplier", label: "Supplier", sortable: true, render: (r) => r.supplier || dash },
  { key: "invoice_no", label: "Invoice / challan", render: (r) => r.invoice_no || dash },
  sectionCol,
  { key: "age_days", label: "Days since GRN", align: "right", sortable: true, render: (r) => <Age days={r.age_days} muted /> },
];

// The app's receipts through the spec 9 flow (payload flow.receipts). The GRN
// no is what the supervisor typed from ERP — shown as recorded, not as an ERP
// posting.
const FLOW_COLUMNS = [
  {
    key: "created_at", label: "Received", sortable: true,
    exportValue: (r) => localStamp(r.created_at), render: (r) => fmtStamp(r.created_at),
  },
  { key: "receipt_no", label: "Receipt no", sortable: true, render: (r) => <span className="font-mono text-[12px]">{r.receipt_no || "—"}</span> },
  partCol,
  qtyCol("qty_received", "Received"),
  {
    key: "ven_name", label: "Supplier", sortable: true,
    searchValue: (r) => `${r.ven_name || ""} ${r.ven_cd || ""}`,
    render: (r) => r.ven_name || dash,
  },
  { key: "invoice_no", label: "Invoice", render: (r) => r.invoice_no || dash },
  {
    key: "grn_no", label: "GRN no (recorded)", sortable: true,
    exportValue: (r) => (r.grn_no ? `${r.grn_no}${r.grn_date ? ` (${r.grn_date})` : ""}` : ""),
    render: (r) => (r.grn_no ? (
      <div>
        <div>{r.grn_no}</div>
        {r.grn_date && <div className="text-[11px] text-slate-400">{fmtDate(r.grn_date)}</div>}
      </div>
    ) : <span className="text-[11px] text-slate-400">not yet</span>),
  },
  { key: "quality_by", label: "Quality by", sortable: true, render: (r) => r.quality_by || dash },
  {
    key: "status", label: "Status", sortable: true,
    exportValue: (r) => RECEIPT_STATUS[r.status]?.label || r.status,
    render: (r) => (
      <span className={`badge ${RECEIPT_STATUS[r.status]?.badge || "badge-neutral"}`}>{RECEIPT_STATUS[r.status]?.label || r.status || "—"}</span>
    ),
  },
  {
    key: "qty_accepted", label: "Accepted / rejected", align: "right",
    exportValue: (r) => (r.qty_accepted == null ? "" : `${r.qty_accepted} / ${r.qty_rejected ?? 0}`),
    render: (r) => (r.qty_accepted == null ? dash : (
      <span>
        {num(r.qty_accepted)}
        {Number(r.qty_rejected) > 0 && <span className="font-semibold text-rose-600 dark:text-rose-400"> / {num(r.qty_rejected)}</span>}
      </span>
    )),
  },
  {
    key: "age_days", label: "Age", align: "right", sortable: true,
    render: (r) => <Age days={r.age_days} muted={!RECEIPT_OPEN.has(r.status)} />,
  },
];

const RECEIPT_COLUMNS = [
  {
    key: "received_at", label: "Added", sortable: true,
    exportValue: (r) => localStamp(r.received_at), render: (r) => fmtStamp(r.received_at),
  },
  partCol,
  qtyCol("qty", "Qty"),
  { key: "invoice_no", label: "Invoice", render: (r) => r.invoice_no || dash },
  {
    key: "check_result", label: "Physical check", sortable: true,
    render: (r) => (r.check_result ? <Chip tone={CHECK_TONE[r.check_result] || "neutral"}>{r.check_result}</Chip> : dash),
  },
  {
    key: "status_label", label: "Status (as recorded)", sortable: true,
    exportValue: (r) => ERP_ORIGIN[r.status] || r.status_label,
    render: (r) => ERP_ORIGIN[r.status] || r.status_label,
  },
  { key: "received_by", label: "Booked by", sortable: true, render: (r) => r.received_by || dash },
  { key: "supplier", label: "Supplier", render: (r) => r.supplier || dash },
  { key: "reference", label: "Reference", render: (r) => r.reference || dash },
  {
    key: "erp_pushed_at", label: "In ERP",
    exportValue: (r) => (ERP_ORIGIN[r.status]
      ? "By ERP GRN (nothing for the app to push)"
      : r.erp_pushed_at ? `Pushed ${localStamp(r.erp_pushed_at)}` : "Not pushed"),
    render: (r) => (ERP_ORIGIN[r.status]
      ? (
        <Chip tone="blue"
          title="Nothing for the app to push: this stock comes in through the ERP GRN the supervisor recorded (GRN / RGP no. under Reference). The app does not read back ERP's posting.">
          By ERP GRN
        </Chip>
      )
      : r.erp_pushed_at ? <Chip tone="green" title={fmtStamp(r.erp_pushed_at)}>Pushed</Chip> : <Chip>Not pushed</Chip>),
  },
  sectionCol,
  { key: "age_days", label: "Days since added", align: "right", sortable: true, render: (r) => <Age days={r.age_days} muted /> },
];

const SRV_COLUMNS = [
  {
    key: "started_at", label: "Entered", sortable: true,
    exportValue: (r) => localStamp(r.started_at), render: (r) => fmtStamp(r.started_at),
  },
  { key: "srv_no", label: "Inbound no", sortable: true, render: (r) => r.srv_no || <span className="text-slate-400">not raised</span> },
  partCol,
  { key: "supplier", label: "Supplier", sortable: true, render: (r) => r.supplier || dash },
  qtyCol("qty_invoiced", "Invoiced"),
  qtyCol("qty_received", "Received"),
  {
    key: "pipeline_status", label: "Monitor status", sortable: true,
    exportValue: (r) => r.pipeline_status || `Unmapped (${r.status})`,
    render: (r) => (r.pipeline_status
      ? <Chip tone={PIPELINE_TONE[r.pipeline_status]} title={r.status_note}>{r.pipeline_status}</Chip>
      : <Chip title={r.status_note}>Unmapped</Chip>),
  },
  { key: "status", label: "Inbound status", sortable: true, render: (r) => <span className="font-mono text-[11px]">{r.status}</span> },
  sectionCol,
  {
    key: "age_days", label: "Age", align: "right", sortable: true,
    render: (r) => <Age days={r.age_days} muted={!r.open} />,
  },
];

const GATE_COLUMNS = [
  { key: "gate_entry_dt", label: "Gate date", sortable: true, render: (r) => fmtDate(r.gate_entry_dt) },
  { key: "gate_entry_no", label: "Gate entry", sortable: true, render: (r) => r.gate_entry_no || dash },
  partCol,
  { key: "description", label: "Description (ERP)", render: (r) => <span className="block max-w-[240px] truncate">{r.description || "—"}</span> },
  qtyCol("qty", "Qty"),
  { key: "supplier", label: "Supplier", sortable: true, render: (r) => r.supplier || dash },
  { key: "po_no", label: "PO", render: (r) => r.po_no || dash },
  { key: "last_grn_date", label: "Earlier GRN in window", sortable: true, render: (r) => (r.last_grn_date ? fmtDate(r.last_grn_date) : dash) },
  {
    key: "beyond_grn_data", label: "GRN data",
    exportValue: (r) => (r.beyond_grn_data
      ? "GRN mirror ends before this date"
      : "GRN mirror reaches this date — no GRN found"),
    render: (r) => (r.beyond_grn_data
      ? <Chip tone="blue" title="The ERP GRN mirror has no line dated on or after this arrival yet">Mirror not there yet</Chip>
      : <span className="text-[11px] text-slate-400" title="The GRN mirror holds lines up to or past this date, yet none for this part on or after the arrival">
        Mirror reaches this date
      </span>),
  },
  sectionCol,
  { key: "age_days", label: "Days at gate", align: "right", sortable: true, render: (r) => <Age days={r.age_days} /> },
];

const STATE = {
  tracked: { label: "Tracked", icon: CircleCheck, cls: "text-emerald-600 dark:text-emerald-400" },
  partial: { label: "Partial", icon: CircleDot, cls: "text-amber-600 dark:text-amber-400" },
  not_tracked: { label: "Not tracked yet", icon: CircleDashed, cls: "text-slate-400" },
};

// Spec 1: the spare store has ONE GRN step — no separate SRV step is named on
// screen, whatever older label the server still sends for it.
const STEP_LABEL = { srv_grn: "GRN" };

function Stepper({ steps }) {
  return (
    <div className="card">
      <CardHead icon={Workflow} tone="violet" title="Receiving workflow — what the app can see"
        hint="Each step says where its data comes from and how many rows it holds in this window" />
      <ol className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {steps.map((s, i) => {
          const st = STATE[s.state] || STATE.not_tracked;
          const Icon = st.icon;
          const label = STEP_LABEL[s.key] || s.label;
          return (
            <li key={s.key} className="rounded-lg border border-slate-200 p-3 dark:border-navy-700">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Step {i + 1}</span>
                <span className={`inline-flex items-center gap-1 text-[11px] font-semibold ${st.cls}`}>
                  <Icon size={13} aria-hidden="true" /> {st.label}
                </span>
              </div>
              <p className="mt-1 text-sm font-semibold text-slate-800 dark:text-white">{label}</p>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">{s.source}</p>
              <p className="mt-1 text-xs tabular text-slate-700 dark:text-slate-200">
                {s.count == null
                  ? <span className="text-slate-400">no source to count</span>
                  : s.count ? `${num(s.count)} in this window` : <span className="text-slate-400">nothing in this window</span>}
              </p>
              <p className="mt-1 text-[11px] leading-snug text-slate-400">{s.note}</p>
            </li>
          );
        })}
      </ol>
      <p className="mt-3 text-[11px] text-slate-400">
        Tracked — a real source feeds the step · Partial — only part of the step is recorded · Not tracked yet — nothing in the app records it
      </p>
    </div>
  );
}

// Spec 9 status flow of a spare receipt. Labels and notes come from the
// server's flow.steps; these are the icons and the fallback wording for each
// key. A step's count is a funnel — every receipt that has REACHED it — so the
// fallback hints say what reaching the step means, never "waiting here now".
const FLOW_STEP = {
  RECEIVED: { label: "Received", Icon: PackagePlus, hint: "Recorded by the store on arrival — not stock yet" },
  GRN_CREATED: { label: "GRN created", Icon: FileCheck2, hint: "Supervisor recorded the ERP GRN no." },
  QUALITY_PENDING: { label: "Quality pending", Icon: Hourglass, hint: "Handed to Maintenance / Tool Room for inspection" },
  QUALITY_CLEARED: { label: "Quality cleared", Icon: ShieldCheck, hint: "Inspection passed some or all of the qty" },
  STOCK_AVAILABLE: { label: "Stock available", Icon: PackageCheck, hint: "Accepted qty added to store stock — issuable" },
};
const FLOW_ORDER = Object.keys(FLOW_STEP);

function FlowStepper({ flow }) {
  // The server's order when it sends one; any key it leaves out is shown as
  // "—" rather than as a zero it never measured.
  const byKey = Object.fromEntries((flow.steps || []).map((s) => [s.key, s]));
  const keys = [...FLOW_ORDER, ...(flow.steps || []).map((s) => s.key).filter((k) => !FLOW_STEP[k])];
  return (
    <div className="card">
      {/* flow.receipts is the window's receipts PLUS any older one still open —
          an open receipt is waiting on someone however old it is. */}
      <CardHead icon={Workflow} tone="blue" title="Receiving status flow"
        hint="Received → GRN created → Quality pending → Quality cleared → Stock available · receipts received in this window + any still open" />
      <ol className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {keys.map((k, i) => {
          const meta = FLOW_STEP[k] || { label: k.replace(/_/g, " ").toLowerCase(), Icon: CircleDot };
          const step = byKey[k];
          const n = step?.count;
          // Only RECEIVED and QUALITY_PENDING can hold a receipt; the server
          // sends `waiting` for those and null for the steps passed in the same
          // action that reaches them — so no "0 waiting" is invented there.
          const waiting = step?.waiting;
          const hint = step?.note || meta.hint;
          return (
            <li key={k} className="relative rounded-lg border border-slate-200 p-3 dark:border-navy-700">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Step {i + 1}</span>
                <meta.Icon size={15} className={n ? "text-toyotared" : "text-slate-300 dark:text-slate-600"} aria-hidden="true" />
              </div>
              <p className="mt-1 text-sm font-semibold text-slate-800 dark:text-white">{step?.label || meta.label}</p>
              <p className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5 leading-tight">
                <span className={`text-xl font-bold tabular ${n ? "text-slate-900 dark:text-white" : "text-slate-300 dark:text-slate-600"}`}>
                  {n == null ? "—" : num(n)}
                </span>
                {n != null && (
                  <span className="text-[11px] text-slate-400" title="Receipts that have reached this step, including those gone past it">
                    reached{step?.qty != null ? ` · qty ${num(step.qty)}` : ""}
                  </span>
                )}
              </p>
              {waiting != null && (
                <p className={`mt-0.5 text-[11px] font-semibold tabular ${waiting
                  ? "text-amber-600 dark:text-amber-400" : "text-slate-400"}`}>
                  {num(waiting)} waiting now
                </p>
              )}
              {hint && <p className="mt-1 text-[11px] leading-snug text-slate-400">{hint}</p>}
              {i < keys.length - 1 && (
                <ChevronRight size={14} aria-hidden="true"
                  className="absolute -right-2.5 top-1/2 hidden -translate-y-1/2 rounded-full bg-white text-slate-300 dark:bg-navy-900 dark:text-slate-600 lg:block" />
              )}
            </li>
          );
        })}
      </ol>
      <p className="mt-3 text-[11px] leading-relaxed text-slate-400">
        Each step counts the receipts that reached it, so a receipt that has gone further is counted at every step it
        passed; &ldquo;waiting now&rdquo; is how many are stopped there. Cancelled receipts are not counted. On Scan Part,
        the store supervisor records the ERP GRN no., and the quality clearance is recorded after the Maintenance / Tool
        Room inspection — the app does not write to ERP. Printing a QR label moves nothing along: it adds no stock,
        completes no GRN and clears no quality.
      </p>
    </div>
  );
}

// `muted` for lists of finished events: how long ago a GRN was is not a delay.
function AgingStrip({ aging, basis, muted = false }) {
  const plain = "text-slate-700 dark:text-slate-200";
  const tone = {
    "0-3": plain,
    "4-7": muted ? plain : "text-amber-600 dark:text-amber-400",
    "8-15": muted ? plain : "text-rose-600 dark:text-rose-400",
    ">15": muted ? plain : "text-rose-700 dark:text-rose-400",
  };
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      {Object.entries(aging || {}).map(([label, n]) => (
        <div key={label} className="rounded-lg border border-slate-200 px-3 py-1.5 dark:border-navy-700">
          <span className="text-[11px] text-slate-400">{label} days</span>
          <span className={`ml-2 text-sm font-bold tabular ${n ? tone[label] : "text-slate-300 dark:text-slate-600"}`}>{num(n)}</span>
        </div>
      ))}
      {basis && <span className="text-[11px] text-slate-400">{basis}</span>}
    </div>
  );
}

function SourcesLine({ sources, window: win }) {
  const sync = sources.erp_sync;
  // A failed run leaves the last good time in place, so the failure has to be
  // said out loud or the mirrors would read fresher than they are.
  const lastGood = sync.last_sync_at
    ? `last successful run ${fmtStamp(sync.last_sync_at)}`
    : "no successful run since the server started";
  const syncItem = !sync.configured
    ? { text: "ERP DB sync not configured" }
    : sync.last_error
      ? { text: `Last ERP sync attempt failed: ${sync.last_error} — ${lastGood}`, warn: true }
      : sync.last_sync_at
        ? { text: `ERP sync last ran ${fmtStamp(sync.last_sync_at)} (since this server started)` }
        : { text: "ERP sync has not run since the server started (its status is kept in memory only)" };
  const items = [
    { text: `Window ${fmtDate(win.from)} – ${fmtDate(win.to)}` },
    { text: sources.grn_mirror.rows
      ? `GRN mirror: ${count(sources.grn_mirror.rows, "line")}, latest ${fmtDate(sources.grn_mirror.latest_date)}`
      : "GRN mirror is empty" },
    { text: sources.gate_mirror.rows
      ? `Gate mirror: latest arrival ${fmtDate(sources.gate_mirror.latest_date)}`
      : "Gate mirror is empty" },
    { text: sources.store_ledger.starts
      ? `App ledger starts ${fmtDate(parseServerTime(sources.store_ledger.starts))} · ${count(sources.store_ledger.receipts_ever, "stock-in row")} ever`
      : "App ledger has no rows yet" },
    syncItem,
  ];
  return (
    <div className="card flex flex-wrap items-start gap-x-4 gap-y-1.5 py-3">
      <Database size={16} className="mt-0.5 shrink-0 text-slate-400" aria-hidden="true" />
      {items.map(({ text, warn }) => (
        <span key={text} title={warn ? text : undefined}
          className={warn
            ? "max-w-full break-words text-[11px] font-medium text-rose-600 dark:text-rose-400"
            : "text-[11px] text-slate-500 dark:text-slate-400"}>
          {text}
        </span>
      ))}
    </div>
  );
}

function SrvPipeline({ data }) {
  const s = data.summary.srv_pipeline;
  // A monitor status no SRV line can rest in is "not recorded", not a measured
  // zero — unless a line really is there, which is then shown as counted.
  const notCountable = data.pipeline_not_countable || {};
  const unrecorded = data.pipeline_statuses.filter((p) => p in notCountable && !s.by_status[p]);
  return (
    <div className="mb-3 space-y-2">
      <div className="flex flex-wrap gap-2">
        {data.pipeline_statuses.map((p) => (
          <div key={p} className="rounded-lg border border-slate-200 px-3 py-1.5 dark:border-navy-700"
            title={unrecorded.includes(p) ? notCountable[p] : undefined}>
            <span className="text-[11px] text-slate-400">{p}</span>
            <span className="ml-2 text-sm font-bold tabular text-slate-700 dark:text-slate-200">
              {unrecorded.includes(p)
                ? <span className="text-[11px] font-medium text-slate-400">not recorded</span>
                : num(s.by_status[p] || 0)}
            </span>
          </div>
        ))}
        {Object.entries(s.unmapped).map(([raw, n]) => (
          <div key={raw} className="rounded-lg border border-dashed border-slate-300 px-3 py-1.5 dark:border-navy-700">
            <span className="font-mono text-[11px] text-slate-400">{raw}</span>
            <span className="ml-2 text-sm font-bold tabular text-slate-700 dark:text-slate-200">{num(n)}</span>
          </div>
        ))}
      </div>
      {unrecorded.length > 0 && (
        <ul className="space-y-0.5 text-[11px] text-slate-400">
          {unrecorded.map((p) => <li key={p}><span className="font-medium">{p}</span> not recorded — {notCountable[p]}</li>)}
        </ul>
      )}
      <details className="text-[11px] text-slate-500 dark:text-slate-400">
        <summary className="cursor-pointer select-none font-medium text-slate-600 dark:text-slate-300">
          How inbound (SRV register) statuses map to the monitor
        </summary>
        <div className="mt-2 overflow-x-auto">
          <table className="min-w-full text-left">
            <tbody>
              {data.srv_status_map.map((m) => (
                <tr key={m.status} className="border-t border-slate-100 dark:border-navy-800">
                  <td className="py-1 pr-3 font-mono whitespace-nowrap">{m.status}</td>
                  <td className="py-1 pr-3 whitespace-nowrap">{m.maps_to || <span className="italic">Unmapped — shown as is</span>}</td>
                  <td className="py-1">
                    {m.note}
                    {m.rest_note && <span className="block italic text-slate-400">No line rests here: {m.rest_note}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

// The monitor's aging buckets (receiving_monitor_service.AGING_BUCKETS), for
// the one list the client counts itself: open receipts of the flow.
const agingOf = (ages) => {
  const out = { "0-3": 0, "4-7": 0, "8-15": 0, ">15": 0 };
  ages.forEach((a) => {
    if (a == null) return;
    if (a <= 3) out["0-3"] += 1;
    else if (a <= 7) out["4-7"] += 1;
    else if (a <= 15) out["8-15"] += 1;
    else out[">15"] += 1;
  });
  return out;
};

// Receiving & GRN monitor for the spare store: the app's receipts through the
// GRN / quality flow, ERP GRN lines, what was added to stock, the ERP inbound
// (SRV) register and gate arrivals with no receipt yet — each from its real
// source, with the source's reach shown so an empty list can be read.
export default function ReceivingMonitor() {
  const { activeCode, activeStore } = useStores();
  const code = activeCode || "MAINTENANCE";
  const { openPart } = usePartDrawer();
  const [params, setParams] = useSearchParams();
  const days = WINDOWS.includes(Number(params.get("days"))) ? Number(params.get("days")) : 90;
  const setParam = (key, value) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    next.set(key, String(value));
    return next;
  }, { replace: true });

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ["stock", "receiving", code, days],
    queryFn: () => receivingMonitorService.monitor(code, days).then((r) => r.data.data),
    placeholderData: keepPreviousData,
  });

  const lists = useMemo(() => ({
    flow: Array.isArray(data?.flow?.receipts) ? data.flow.receipts : [],
    grn: data?.grn || [],
    receipts: data?.store_receipts || [],
    srv: data?.srv_pipeline || [],
    gate: data?.gate_not_received || [],
  }), [data]);

  const onRowClick = (r) => { if (r.part_id) openPart(r.part_id); };

  const header = (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-lg font-bold text-slate-800 dark:text-white">Receiving &amp; GRN</h2>
        <p className="text-xs text-slate-400 mt-0.5">
          What arrived for {activeStore?.name || "this store"} and what each source says about it — receipts waiting
          for the GRN / quality, ERP GRN lines, what was added to stock and gate arrivals with no receipt yet
        </p>
      </div>
      <div className="flex items-center gap-2">
        {isFetching && !isLoading && <span className="text-[11px] text-slate-400">Updating…</span>}
        <div role="group" aria-label="Window"
          className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5 dark:border-navy-700 dark:bg-navy-900">
          {WINDOWS.map((d) => (
            <button key={d} type="button" aria-pressed={days === d} onClick={() => setParam("days", d)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${days === d
                ? "bg-toyotared text-white"
                : "text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-navy-800"}`}>
              {d} days
            </button>
          ))}
        </div>
      </div>
    </div>
  );

  if (isLoading) {
    return (
      <div className="space-y-6">
        {header}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => <KpiCard key={i} loading />)}
        </div>
        <div className="card space-y-2">
          {Array.from({ length: 6 }).map((_, i) => <div key={i} className="skeleton h-10 w-full" />)}
        </div>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="space-y-6">
        {header}
        <div className="card">
          <ErrorState title="Could not load receiving data"
            message={error?.response?.data?.message || "The receiving monitor did not answer."}
            onRetry={() => refetch()} />
        </div>
      </div>
    );
  }

  const s = data.summary;
  const src = data.sources;
  const range = `${fmtDate(data.window.from)} – ${fmtDate(data.window.to)}`;

  // The GRN / quality flow is a newer block of the payload — without it the
  // page is the monitor it was, minus the SRV step wording.
  const flow = data.flow && typeof data.flow === "object" ? data.flow : null;
  const shownTabs = TABS.filter((t) => t.key !== "flow" || flow);
  const asked = params.get("tab");
  const tab = shownTabs.some((t) => t.key === asked) ? asked : flow ? "flow" : "grn";
  const openReceipts = lists.flow.filter((r) => RECEIPT_OPEN.has(r.status));
  const awaitingGrn = openReceipts.filter((r) => r.status === "RECEIVED").length;
  // Ledger stock-ins the app could push but has not — those that came in by an
  // ERP GRN are never pushed, so they are not "missing" from ERP.
  const notPushed = lists.receipts.filter((r) => !r.erp_pushed_at && !ERP_ORIGIN[r.status]).length;

  // What the ledger does hold, from its own counts — e.g. "472 opening counts, 1 issue".
  const ledgerHolds = Object.entries(src.store_ledger.txn_counts || {})
    .filter(([t, n]) => t !== "RECEIPT" && n)
    .map(([t, n]) => count(n, LEDGER_WORDS[t] || t.toLowerCase()))
    .join(", ");

  const tabs = {
    flow: {
      columns: FLOW_COLUMNS, aging: agingOf(openReceipts.map((r) => r.age_days)),
      basis: "Open receipts only (GRN or quality pending) — days since received", exportName: "receiving_grn_quality",
      intro: "Receipts recorded on Scan Part (Receive). Spare receiving is one flow: received, the supervisor records "
        + "the ERP GRN no., Maintenance / Tool Room clears quality, and only the accepted qty becomes store stock. "
        + "Until then the material is not issuable.",
      empty: `No receipt recorded in the app between ${range}.`,
    },
    grn: {
      columns: GRN_COLUMNS, aging: s.grn.aging, basis: s.grn.aging_basis, muted: true, exportName: "receiving_erp_grn",
      intro: "ERP's GRN register (mirror of srv_report) — lines whose item code is a part in this store. "
        + "Accepted is ERP's accepted qty, or its receipt qty where no accepted figure was given.",
      empty: src.grn_mirror.rows
        ? `No GRN line for this store's parts between ${range}.`
        : "The GRN mirror is empty — no ERP sync has loaded it, so no GRN line can be shown.",
    },
    receipts: {
      columns: RECEIPT_COLUMNS, aging: s.store_receipts.aging, basis: s.store_receipts.aging_basis, muted: true,
      exportName: "receiving_added_to_stock",
      intro: "Every stock-in row of the app's ledger — each one raised the part's available stock: receipts whose GRN "
        + "was recorded and quality cleared, RGP GRNs of reworked material, and older direct receipts (status as "
        + "recorded when booked).",
      empty: !src.store_ledger.receipts_ever
        ? `Nothing has been added to stock in the app yet${src.store_ledger.starts
          ? ` — the ledger starts ${fmtDate(parseServerTime(src.store_ledger.starts))}${ledgerHolds ? ` and holds ${ledgerHolds}` : ""}` : ""}.`
        : `Nothing added to stock between ${range}.`,
    },
    srv: {
      columns: SRV_COLUMNS, aging: s.srv_pipeline.aging, basis: s.srv_pipeline.aging_basis, exportName: "receiving_erp_inbound",
      intro: "Inbound lines ERP pushed into the app's SRV register for this store's parts, mapped onto the monitor's "
        + "statuses — an ERP reference list, not a separate step: spare receiving is tracked under GRN / Quality. "
        + "An open line stays listed even when it entered before the window.",
      empty: src.srv.rows_ever
        ? "No inbound line in this window, and none still open."
        : "No inbound line has been pushed by ERP for this store's parts yet.",
    },
    gate: {
      columns: GATE_COLUMNS, aging: s.gate_not_received.aging, basis: s.gate_not_received.aging_basis,
      exportName: "receiving_at_gate_not_received",
      intro: "Arrived at gate, no receipt recorded yet: gate arrivals of this store's parts with no GRN line and no "
        + "store receipt on or after the arrival date. A possible pending — not a finding that material is lost.",
      empty: s.gate_not_received.gate_lines_in_window
        ? "Every gate arrival in this window has a GRN line or a store receipt on or after it."
        : `No gate arrival of this store's parts between ${range}.`,
    },
  };
  const active = tabs[tab];
  const counts = {
    flow: lists.flow.length, grn: s.grn.lines, receipts: s.store_receipts.lines,
    srv: s.srv_pipeline.lines, gate: s.gate_not_received.lines,
  };
  const gate = s.gate_not_received;

  return (
    <div className="space-y-6">
      {header}

      <SourcesLine sources={src} window={data.window} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard featured tone="blue" label="ERP GRN lines" icon={ClipboardCheck} value={s.grn.lines}
          hint={s.grn.lines ? `${count(s.grn.parts, "part")} · ${num(s.grn.with_rejection)} with rejection` : `none in the last ${days} days`}
          onClick={() => setParam("tab", "grn")} />
        <KpiCard featured tone="navy" label="Added to stock" icon={PackageCheck} value={s.store_receipts.lines}
          hint={src.store_ledger.receipts_ever
            ? `${num(notPushed)} not pushed to ERP`
            : "nothing added in the app yet"}
          onClick={() => setParam("tab", "receipts")} />
        {/* Spec 1: the spare store's pending receiving is GRN / quality — the SRV
            register only stands in when the server has no flow block. */}
        {flow ? (
          <KpiCard featured tone={openReceipts.length ? "amber" : "navy"} label="GRN / Quality pending" icon={ShieldCheck}
            value={openReceipts.length}
            hint={openReceipts.length
              ? `${num(awaitingGrn)} awaiting GRN · ${num(openReceipts.length - awaitingGrn)} awaiting quality`
              : `of ${count(lists.flow.length, "receipt")} in this window`}
            onClick={() => setParam("tab", "flow")} />
        ) : (
          <KpiCard featured tone={s.srv_pipeline.open ? "amber" : "navy"} label="ERP inbound open" icon={FileText}
            value={s.srv_pipeline.open}
            hint={src.srv.rows_ever ? `${count(s.srv_pipeline.lines, "inbound line")} listed` : "none pushed by ERP for these parts"}
            onClick={() => setParam("tab", "srv")} />
        )}
        <KpiCard featured tone={gate.over_7_days ? "red" : gate.lines ? "amber" : "navy"} label="At gate, no receipt"
          icon={Truck} value={gate.lines}
          hint={gate.lines
            ? `${count(gate.parts, "part")} · ${num(gate.over_7_days)} over 7 days`
            : `of ${count(gate.gate_lines_in_window, "gate arrival")}`}
          onClick={() => setParam("tab", "gate")} />
      </div>

      {flow && <FlowStepper flow={flow} />}

      <Stepper steps={data.steps} />

      <div className="card">
        <div role="tablist" aria-label="Receiving lists" className="mb-3 flex flex-wrap gap-2">
          {shownTabs.map((t) => (
            <button key={t.key} type="button" role="tab" aria-selected={tab === t.key}
              onClick={() => setParam("tab", t.key)}
              className={`rounded-full border px-3 py-1.5 text-xs transition-colors ${tab === t.key
                ? "border-toyotared bg-toyotared text-white"
                : "border-slate-200 text-slate-600 hover:border-toyotared dark:border-navy-700 dark:text-slate-300"}`}>
              {t.label}
              <span className="ml-1.5 opacity-70 tabular">{num(counts[t.key])}</span>
            </button>
          ))}
        </div>
        <p className="mb-3 text-xs leading-relaxed text-slate-500 dark:text-slate-400">{active.intro}</p>
        {tab === "srv" && <SrvPipeline data={data} />}
        {tab === "gate" && gate.beyond_grn_data > 0 && (
          <p className="mb-3 rounded-lg bg-blue-50 px-3 py-2 text-[11px] text-blue-700 dark:bg-blue-500/10 dark:text-blue-300">
            {num(gate.beyond_grn_data)} of these arrived after the latest GRN in the mirror
            ({fmtDate(src.grn_mirror.latest_date)}) — their GRN may exist in ERP but not be synced here yet.
          </p>
        )}
        <AgingStrip aging={active.aging} basis={active.basis} muted={active.muted} />
        <Table
          key={tab}
          columns={active.columns}
          rows={lists[tab]}
          searchable="Search part, supplier, document no…"
          exportName={active.exportName}
          maxHeight="60vh"
          onRowClick={onRowClick}
          emptyMessage={active.empty}
        />
      </div>
    </div>
  );
}
