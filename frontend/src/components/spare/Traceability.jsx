import React, { useEffect, useMemo, useState } from "react";
import {
  ArrowDownToLine, ArrowUpFromLine, CircleCheck, ClipboardCheck, ClipboardList, Factory, FileCheck2, FilePen,
  HardHat, PackageCheck, Pencil, Printer, ReceiptText, Search, ShieldCheck, Store, Truck, Undo2, X,
} from "lucide-react";
import Glyph from "../Glyph.jsx";
import Modal from "../Modal.jsx";
import Table from "../Table.jsx";
import PartTimeline, { usePartTimeline } from "./PartTimeline.jsx";
import { scanIcon } from "../scan/scanIcons.js";
import { spareStockService } from "../../services/spareStockService.js";
import { TIMELINE_KIND } from "../../lib/scanStatus.js";
import { escapeHtml, fmtDate, fmtStamp, fmtWhen, num, parseServerTime } from "../../lib/format.js";

// A spare's journey, supplier to consumption: the nine-step trace, the part's
// QR-traceability history (receive -> GRN -> quality -> issue -> line / machine
// -> return -> RGP -> stock) and the full part ledger (arrivals + movements on
// one table). Moved out of the store dashboard so the part drawer can open it
// from anywhere.

const PILL = {
  green: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300",
  red: "bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300",
  amber: "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300",
  sky: "bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300",
  slate: "bg-slate-100 text-slate-600 dark:bg-navy-800 dark:text-slate-300",
};
// TIMELINE_KIND tone -> the ledger's pill colours.
const TONE_PILL = { success: PILL.green, info: PILL.sky, warning: PILL.amber, danger: PILL.red, neutral: PILL.slate };

// One label per ledger event, said the way the store says it. RECEIVED is the
// ERP receiving register's GRN (accepted qty) — the counted inflow when a part
// has GRNs; RECEIPT is a stock-in recorded in this app.
const LEDGER_EVENT = {
  GATE_ARRIVAL: { label: "Arrival", icon: Truck, tone: PILL.green },
  RECEIVED: { label: "Received (ERP GRN)", icon: FileCheck2, tone: PILL.green },
  RECEIPT: { label: "Received", icon: ArrowDownToLine, tone: PILL.green },
  OPENING: { label: "Opening", icon: ClipboardList, tone: PILL.slate },
  ISSUE: { label: "Issued", icon: ArrowUpFromLine, tone: PILL.red },
  RETURN: { label: "Returned", icon: Undo2, tone: PILL.amber },
  ADJUSTMENT: { label: "Corrected", icon: Pencil, tone: PILL.amber },
  // A new part sent from stock for coating / job work on its ERP challan.
  JOB_WORK_OUT: { label: "Sent for job work", icon: ArrowUpFromLine, tone: PILL.amber },
};

// Stock-ins of the QR flow are RECEIPT / RETURN rows told apart by their
// status (models/spare_stock.py): the accepted qty of a quality clearance, an
// RGP GRN, a return inspected good. Named for what happened, so none of them
// reads as a plain "Received" / "Returned". A return taken straight back into
// stock (store rule, 14 Oct 2026) arrives with no status and reads "Returned".
const BY_STATUS = {
  RECEIPT: {
    STOCK_AVAILABLE: { label: "Quality cleared", icon: ShieldCheck, tone: PILL.green },
    RGP_GRN: { label: "RGP GRN", icon: PackageCheck, tone: PILL.green },
  },
  RETURN: {
    INSPECTED_GOOD: { label: "Return inspected — good", icon: ClipboardCheck, tone: PILL.green },
  },
};

// Any other kind (a journal kind the ledger may carry) reads as the part
// timeline names it, never as a raw code.
const eventForKind = (kind) => {
  if (LEDGER_EVENT[kind]) return LEDGER_EVENT[kind];
  const t = TIMELINE_KIND[kind];
  if (t) return { label: t.label, icon: scanIcon(t.icon), tone: TONE_PILL[t.tone] || PILL.slate };
  const words = String(kind || "Event").replace(/_/g, " ").toLowerCase();
  return { label: words.charAt(0).toUpperCase() + words.slice(1), icon: null, tone: PILL.slate };
};
const ledgerEvent = (row) => BY_STATUS[row.kind]?.[row.status] || eventForKind(row.kind);

// One part's journey. Every step is drawn whether or not it has data — a gap
// in the chain is the answer someone opened this to find, so a step with
// nothing recorded says so instead of being quietly skipped.
function TraceStep({ icon, label, done, children, last }) {
  return (
    <li className="flex gap-3">
      <div className="flex flex-col items-center shrink-0">
        <span className={`w-8 h-8 rounded-full flex items-center justify-center text-sm
          ${done ? "bg-emerald-50 dark:bg-emerald-500/15" : "bg-slate-100 dark:bg-navy-800"}`}>
          <Glyph icon={icon} size={15}
            className={done ? "text-emerald-600 dark:text-emerald-300" : "text-slate-400 dark:text-slate-500"} />
        </span>
        {!last && <span className={`w-px flex-1 my-1 ${done ? "bg-emerald-200 dark:bg-emerald-500/30" : "bg-slate-200 dark:bg-navy-700"}`} />}
      </div>
      <div className={`min-w-0 flex-1 ${last ? "" : "pb-4"}`}>
        <p className={`text-xs font-semibold ${done ? "text-slate-700 dark:text-slate-200" : "text-slate-400"}`}>
          {label}
        </p>
        <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">{children}</div>
      </div>
    </li>
  );
}

// "From / To" and "Reference" are each built from several fields, so the ledger
// table, its search, its CSV export and its print view all read them from here.
const ledgerFromTo = (e) =>
  e.direction === "out"
    ? [e.department, e.issued_to, e.machine, e.line].filter(Boolean).join(" · ")
    : [e.supplier_name, e.supplier_code].filter(Boolean).join("  ");

const ledgerRef = (e) => [e.reference, e.invoice_no, e.po_no].filter(Boolean).join(" · ");

// A ledger "ts" is either an ERP date-only string (gate / GRN date, plant-local
// already) or a UTC store stamp with no zone. For sorting, "latest" and the
// date filter both are brought to the plant's clock, so a 01:30 IST issue sits
// on its IST day rather than the previous UTC one.
const pad2 = (n) => String(n).padStart(2, "0");
const ledgerKey = (ts) => {
  if (!ts) return "";
  if (ts.length <= 10) return ts;
  const d = parseServerTime(ts);
  if (!d) return ts;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
    + `T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`;
};

// SRV.gate_entry_time is the ERP's own gate clock reading (plant wall clock,
// compared as-is with the supplier windows on the backend), not a utcnow()
// stamp — so it is shown literally, never shifted from UTC like fmtStamp does.
const fmtPlantStamp = (iso) => {
  if (!iso) return "—";
  const d = new Date(String(iso).trim().replace(" ", "T").replace(/(\.\d{3})\d+/, "$1"));
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-GB", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
  });
};

const LEDGER_COLUMNS = [
  {
    key: "ts", label: "Date", sortable: true, sortValue: (r) => ledgerKey(r.ts),
    render: (r) => <span className="tabular">{fmtWhen(r.ts)}</span>,
    exportValue: (r) => (r.ts ? fmtWhen(r.ts) : ""),
  },
  {
    key: "kind", label: "Event",
    searchValue: (r) => ledgerEvent(r).label,
    exportValue: (r) => ledgerEvent(r).label,
    render: (r) => {
      const ev = ledgerEvent(r);
      return (
        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap ${ev.tone}`}>
          <Glyph icon={ev.icon} size={12} />{ev.label}
        </span>
      );
    },
  },
  {
    key: "qty", label: "In / Out", align: "right", sortable: true, sortValue: (r) => r.qty ?? 0,
    exportValue: (r) => (r.qty == null ? "" : r.qty),
    render: (r) => {
      const q = r.qty == null ? null : Math.abs(r.qty);
      if (q == null) return <span className="text-slate-400">—</span>;
      if (r.direction === "in") return <span className="text-emerald-600 dark:text-emerald-400 font-semibold">+{num(q)}</span>;
      if (r.direction === "out") return <span className="text-rose-600 dark:text-rose-400 font-semibold">−{num(q)}</span>;
      return <span className="text-slate-500 dark:text-slate-300">{num(q)}</span>;
    },
  },
  {
    key: "fromto", label: "From / To",
    searchValue: (r) => ledgerFromTo(r),
    exportValue: (r) => ledgerFromTo(r),
    render: (r) => {
      const ft = ledgerFromTo(r);
      return (
        <div>
          {ft ? <span className="text-slate-600 dark:text-slate-300">{ft}</span> : <span className="text-slate-400">—</span>}
          {r.remarks && <span className="block text-[10px] text-slate-400">{r.remarks}</span>}
        </div>
      );
    },
  },
  {
    key: "ref", label: "Reference",
    searchValue: (r) => ledgerRef(r),
    exportValue: (r) => ledgerRef(r),
    render: (r) => <span className="tabular text-slate-500 dark:text-slate-400">{ledgerRef(r) || "—"}</span>,
  },
  {
    key: "balance_after", label: "Balance", align: "right", sortable: true,
    sortValue: (r) => (r.balance_after ?? null),
    exportValue: (r) => (r.balance_after == null ? "" : r.balance_after),
    render: (r) => (r.balance_after == null ? "—" : num(r.balance_after)),
  },
];

function LedgerStat({ label, value, tone, small }) {
  return (
    <div className="rounded-xl border border-slate-200 dark:border-navy-800 bg-slate-50/60 dark:bg-navy-800/30 px-3 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
      <p className={`${small ? "text-sm" : "text-lg"} font-bold tabular leading-tight ${tone}`}>{value}</p>
    </div>
  );
}

// The part's whole life on one timeline — every arrival, opening, issue, return
// and correction — with a summary, event/date/supplier filters, CSV export and
// a print view. All the standard things a proper history screen carries.
function PartLedger({ ledger, partNo, stock }) {
  const [kind, setKind] = useState("ALL");
  const [vendor, setVendor] = useState("ALL");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const kinds = useMemo(() => [...new Set(ledger.map((e) => e.kind))], [ledger]);
  const vendors = useMemo(
    () => [...new Set(ledger.filter((e) => e.supplier_name).map((e) => e.supplier_name))].sort(),
    [ledger],
  );

  const summary = useMemo(() => {
    let inQty = 0, outQty = 0, lastTs = null;
    const sup = new Set();
    for (const e of ledger) {
      if (e.direction === "in") inQty += Math.abs(e.qty || 0);
      else if (e.direction === "out") outQty += Math.abs(e.qty || 0);
      if (e.supplier_name) sup.add(e.supplier_name);
      if (e.ts && (!lastTs || ledgerKey(e.ts) > ledgerKey(lastTs))) lastTs = e.ts;
    }
    const bal = ledger.find((e) => e.balance_after != null)?.balance_after;
    return { inQty, outQty, suppliers: sup.size, lastTs, balance: bal != null ? bal : (stock?.qty_on_hand ?? null) };
  }, [ledger, stock]);

  const filtered = useMemo(
    () => ledger.filter((e) => {
      if (kind !== "ALL" && e.kind !== kind) return false;
      if (vendor !== "ALL" && e.supplier_name !== vendor) return false;
      const d = ledgerKey(e.ts).slice(0, 10);
      if (from && d && d < from) return false;
      if (to && d && d > to) return false;
      return true;
    }),
    [ledger, kind, vendor, from, to],
  );

  const hasFilter = kind !== "ALL" || vendor !== "ALL" || Boolean(from) || Boolean(to);

  const printLedger = () => {
    const w = window.open("", "_blank", "width=900,height=700");
    if (!w) return;
    const body = filtered.map((e) => {
      const q = e.qty == null ? "" : (e.direction === "in" ? "+" : e.direction === "out" ? "−" : "") + num(Math.abs(e.qty));
      return `<tr><td>${escapeHtml(fmtWhen(e.ts))}</td><td>${escapeHtml(ledgerEvent(e).label)}</td><td style="text-align:right">${q}</td><td>${escapeHtml(ledgerFromTo(e))}</td><td>${escapeHtml(ledgerRef(e))}</td><td style="text-align:right">${e.balance_after == null ? "" : num(e.balance_after)}</td></tr>`;
    }).join("");
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Part Ledger — ${escapeHtml(partNo)}</title>
      <style>body{font-family:system-ui,Arial,sans-serif;margin:24px;color:#111}h2{margin:0 0 2px}p{color:#666;margin:0 0 16px;font-size:12px}
      table{width:100%;border-collapse:collapse;font-size:12px}th,td{border:1px solid #ddd;padding:6px 8px;text-align:left}
      th{background:#f3f4f6}@media print{body{margin:0}}</style></head>
      <body><h2>Part Ledger — ${escapeHtml(partNo)}</h2>
      <p>Received ${num(summary.inQty)} · Issued ${num(summary.outQty)} · Balance ${summary.balance == null ? "—" : num(summary.balance)} · ${filtered.length} entries${hasFilter ? " (filtered)" : ""}</p>
      <table><thead><tr><th>Date</th><th>Event</th><th style="text-align:right">In/Out</th><th>From / To</th><th>Reference</th><th style="text-align:right">Balance</th></tr></thead>
      <tbody>${body}</tbody></table></body></html>`);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 200);
  };

  const chip = (val, label) => (
    <button
      key={val}
      onClick={() => setKind(val)}
      className={`px-2.5 py-1 rounded-full text-[11px] font-semibold transition-colors ${
        kind === val
          ? "bg-toyotared text-white"
          : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-navy-800 dark:text-slate-300 dark:hover:bg-navy-700"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="mt-7 pt-5 border-t border-slate-200 dark:border-navy-700">
      <div className="mb-3">
        <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Part Ledger</h4>
        <p className="text-[11px] text-slate-400">
          {ledger.length > 0
            ? `Every movement of ${partNo} — arrivals, opening, issues and returns on one timeline, newest first`
            : `No movement recorded for ${partNo} yet`}
        </p>
      </div>

      {ledger.length > 0 && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-2.5 mb-4">
            <LedgerStat label="Received" value={num(summary.inQty)} tone="text-emerald-600 dark:text-emerald-400" />
            <LedgerStat label="Issued" value={num(summary.outQty)} tone="text-rose-600 dark:text-rose-400" />
            <LedgerStat label="Balance" value={summary.balance == null ? "—" : num(summary.balance)} tone="text-slate-800 dark:text-white" />
            <LedgerStat label="Suppliers" value={num(summary.suppliers)} tone="text-slate-800 dark:text-white" />
            <LedgerStat label="Last Movement" value={summary.lastTs ? fmtWhen(summary.lastTs) : "—"} tone="text-slate-800 dark:text-white" small />
          </div>

          <div className="flex flex-wrap items-center gap-2 mb-3">
            <div className="flex flex-wrap items-center gap-1.5">
              {chip("ALL", "All")}
              {kinds.map((k) => chip(k, eventForKind(k).label))}
            </div>
            {vendors.length > 0 && (
              <select
                value={vendor}
                onChange={(e) => setVendor(e.target.value)}
                className="input-field py-1.5 text-[13px] max-w-[200px]"
                title="Filter by supplier"
              >
                <option value="ALL">All suppliers</option>
                {vendors.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            )}
            <div className="flex items-center gap-1">
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="input-field py-1.5 text-[13px]" title="From date" />
              <span className="text-slate-400 text-xs">–</span>
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="input-field py-1.5 text-[13px]" title="To date" />
            </div>
            {hasFilter && (
              <button
                onClick={() => { setKind("ALL"); setVendor("ALL"); setFrom(""); setTo(""); }}
                className="btn-secondary py-1.5 text-[13px]"
                title="Clear all filters"
              >
                <X size={14} /> Clear
              </button>
            )}
          </div>

          <Table
            columns={LEDGER_COLUMNS}
            rows={filtered}
            searchable="Search event, supplier, dept, machine, reference…"
            pageSize={15}
            exportName={`part_ledger_${partNo}`}
            emptyMessage={hasFilter ? "No entries match these filters" : "No movement recorded yet"}
            toolbar={
              <button onClick={printLedger} className="btn-secondary py-1.5 text-[13px]" title="Print / save as PDF">
                <Printer size={14} /> Print
              </button>
            }
          />
        </>
      )}
    </div>
  );
}

// The part's QR-traceability history (spec 21) — the same timeline the Scan
// Part workstation shows under "View History", from the same cache. The first
// few events, the rest on request; a failure here leaves the trace and the
// ledger below untouched.
const HISTORY_PREVIEW = 8;

function PartHistory({ partId, partNo }) {
  const [all, setAll] = useState(false);
  const { data, isPending, isError, refetch } = usePartTimeline(partId);
  const rows = data?.rows || [];
  return (
    <div className="mt-7 pt-5 border-t border-slate-200 dark:border-navy-700">
      <div className="mb-3">
        <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Part History</h4>
        <p className="text-[11px] text-slate-400">
          Received, GRN, quality, issued, line / machine / die, returned, inspected, supplier rework and back to stock — newest first
        </p>
      </div>
      {isPending ? (
        <div className="skeleton h-32 w-full" />
      ) : isError ? (
        <p className="text-sm text-slate-400">
          Could not load the history of {partNo}.{" "}
          <button type="button" onClick={() => refetch()} className="font-semibold text-toyotared hover:underline">Retry</button>
        </p>
      ) : (
        <>
          <PartTimeline rows={all ? rows : rows.slice(0, HISTORY_PREVIEW)} emptyText={`Nothing recorded for ${partNo} yet.`} />
          {rows.length > HISTORY_PREVIEW && (
            <button type="button" onClick={() => setAll((a) => !a)}
              className="mt-2 text-xs font-semibold text-slate-500 hover:text-toyotared dark:text-slate-400">
              {all ? "Show the latest only" : `Show all ${rows.length}${data?.has_more ? "+" : ""} events`}
            </button>
          )}
        </>
      )}
    </div>
  );
}

export default function Traceability({ part, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  // Keyed on the id, not the object: callers pass `part` inline, and a new
  // object on every parent render must not refetch the trace.
  const partId = part?.id ?? null;

  useEffect(() => {
    if (partId == null) return undefined;
    let live = true; // a late answer for a part no longer shown is dropped
    setLoading(true);
    setData(null);
    spareStockService.traceability(partId)
      .then((r) => { if (live) setData(r.data.data); })
      .catch(() => { if (live) setData(null); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [partId]);

  const receipt = data?.receipts?.[0];
  const issues = (data?.movements || []).filter((m) => m.txn_type === "ISSUE");
  const none = <span className="text-slate-400">Nothing recorded</span>;

  return (
    <Modal open={!!part} onClose={onClose} size="xl"
      title={part ? `Traceability — ${part.part_no}` : ""}>
      {loading ? (
        <div className="skeleton h-64 w-full" />
      ) : !data ? (
        <p className="text-sm text-slate-400">Could not load this part&apos;s history.</p>
      ) : (
        <>
        <ol className="pt-1">
          <TraceStep icon={Factory} label="Supplier"
            done={(data.gate_suppliers?.length > 0) || Boolean(receipt?.supplier_name || data.part.supplier_id)}>
            {data.gate_suppliers?.length > 0 ? (
              <div className="space-y-1">
                {data.gate_suppliers.map((s, i) => (
                  <div key={i} className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-medium text-slate-700 dark:text-slate-200">
                      {s.ven_name || s.ven_cd}
                    </span>
                    {s.ven_cd && <span className="text-slate-400 tabular">{s.ven_cd}</span>}
                    <span className="text-slate-400">
                      · {s.arrivals} arrival{s.arrivals === 1 ? "" : "s"}
                      {s.last_dt ? ` · last ${fmtDate(s.last_dt)}` : ""}
                    </span>
                  </div>
                ))}
                <p className="text-[10px] text-slate-400">
                  {data.gate_suppliers.length > 1
                    ? "Multiple suppliers — read live from ERP gate entries (item_code)"
                    : "From ERP gate entries (item_code) — a part can come from several suppliers"}
                </p>
              </div>
            ) : receipt?.supplier_name ? (
              receipt.supplier_name
            ) : data.part.supplier_id ? (
              `Supplier #${data.part.supplier_id}`
            ) : (
              <span className="text-slate-400">No gate entry recorded for this part yet</span>
            )}
          </TraceStep>
          <TraceStep icon={ReceiptText} label="Invoice" done={Boolean(receipt?.invoice_no)}>
            {receipt?.invoice_no || none}
          </TraceStep>
          <TraceStep icon={Truck} label="Gate Entry" done={Boolean(receipt?.gate_entry_time)}>
            {receipt?.gate_entry_time
              ? `${receipt.gate_entry_no || "—"} · ${fmtPlantStamp(receipt.gate_entry_time)}`
              : none}
          </TraceStep>
          <TraceStep icon={Search} label="Material Verification" done={Boolean(receipt?.verified_at)}>
            {receipt?.verified_at ? fmtStamp(receipt.verified_at) : none}
          </TraceStep>
          <TraceStep icon={FilePen} label="SRV / GRN" done={Boolean(receipt?.srv_created_at)}>
            {receipt?.srv_created_at
              ? `${receipt.srv_no || "—"} · ${fmtStamp(receipt.srv_created_at)}`
              : none}
          </TraceStep>
          <TraceStep icon={HardHat} label="Engineer Clearance" done={Boolean(receipt?.tool_room_cleared_at)}>
            {receipt?.tool_room_cleared_at
              ? `Tool Room cleared · ${fmtStamp(receipt.tool_room_cleared_at)}`
              : <span className="text-slate-400">
                  Not recorded — Tool Room clearance is captured, Maintenance clearance is not
                </span>}
          </TraceStep>
          <TraceStep icon={Store} label="Store Stock" done={data.stock.qty_on_hand != null}>
            {data.stock.qty_on_hand != null
              ? <>In Stock <span className="font-semibold text-slate-700 dark:text-slate-200">{num(data.stock.qty_on_hand)}</span>
                  {data.stock.last_counted_at && ` · counted ${fmtStamp(data.stock.last_counted_at)}`}</>
              : <span className="text-slate-400">Never counted</span>}
          </TraceStep>
          <TraceStep icon={ArrowUpFromLine} label="Issued" done={issues.length > 0}>
            {issues.length > 0
              ? `${issues.length} issue${issues.length === 1 ? "" : "s"} · ${num(
                  issues.reduce((s, m) => s + Math.abs(m.qty_delta), 0))} out`
              : none}
          </TraceStep>
          <TraceStep icon={CircleCheck} label="ERP Consumption" done={Boolean(receipt?.consumed_at)} last>
            {receipt?.consumed_at ? fmtStamp(receipt.consumed_at) : none}
          </TraceStep>
        </ol>

        <PartHistory partId={partId} partNo={data.part.part_no} />

        <PartLedger ledger={data.ledger || []} partNo={data.part.part_no} stock={data.stock} />
        </>
      )}
    </Modal>
  );
}
