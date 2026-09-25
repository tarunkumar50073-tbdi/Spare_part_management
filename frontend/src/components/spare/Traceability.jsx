import React, { useEffect, useMemo, useState } from "react";
import {
  ArrowDownToLine, ArrowUpFromLine, CircleCheck, ClipboardList, Factory, FilePen, HardHat, Pencil,
  Printer, ReceiptText, Search, Store, Truck, Undo2, X,
} from "lucide-react";
import Glyph from "../Glyph.jsx";
import Modal from "../Modal.jsx";
import Table from "../Table.jsx";
import { spareStockService } from "../../services/spareStockService.js";
import { escapeHtml, fmtDate, fmtStamp, fmtWhen, num } from "../../lib/format.js";

// A spare's journey, supplier to consumption: the nine-step trace and the
// full part ledger (arrivals + movements on one timeline). Moved out of the
// store dashboard so the part drawer can open it from anywhere.

// One label per ledger event, said the way the store says it.
const LEDGER_EVENT = {
  GATE_ARRIVAL: { label: "Arrival", icon: Truck, tone: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300" },
  RECEIPT: { label: "Received", icon: ArrowDownToLine, tone: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300" },
  OPENING: { label: "Opening", icon: ClipboardList, tone: "bg-slate-100 text-slate-600 dark:bg-navy-800 dark:text-slate-300" },
  ISSUE: { label: "Issued", icon: ArrowUpFromLine, tone: "bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300" },
  RETURN: { label: "Returned", icon: Undo2, tone: "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300" },
  ADJUSTMENT: { label: "Corrected", icon: Pencil, tone: "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300" },
};

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

const LEDGER_COLUMNS = [
  {
    key: "ts", label: "Date", sortable: true, sortValue: (r) => r.ts || "",
    render: (r) => <span className="tabular">{fmtWhen(r.ts)}</span>,
    exportValue: (r) => (r.ts ? fmtWhen(r.ts) : ""),
  },
  {
    key: "kind", label: "Event",
    searchValue: (r) => LEDGER_EVENT[r.kind]?.label || r.kind,
    exportValue: (r) => LEDGER_EVENT[r.kind]?.label || r.kind,
    render: (r) => {
      const ev = LEDGER_EVENT[r.kind] || { label: r.kind, icon: null, tone: "bg-slate-100 text-slate-600 dark:bg-navy-800 dark:text-slate-300" };
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
      if (e.ts && (!lastTs || e.ts > lastTs)) lastTs = e.ts;
    }
    const bal = ledger.find((e) => e.balance_after != null)?.balance_after;
    return { inQty, outQty, suppliers: sup.size, lastTs, balance: bal != null ? bal : (stock?.qty_on_hand ?? null) };
  }, [ledger, stock]);

  const filtered = useMemo(
    () => ledger.filter((e) => {
      if (kind !== "ALL" && e.kind !== kind) return false;
      if (vendor !== "ALL" && e.supplier_name !== vendor) return false;
      const d = (e.ts || "").slice(0, 10);
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
      return `<tr><td>${escapeHtml(fmtWhen(e.ts))}</td><td>${escapeHtml(LEDGER_EVENT[e.kind]?.label || e.kind)}</td><td style="text-align:right">${q}</td><td>${escapeHtml(ledgerFromTo(e))}</td><td>${escapeHtml(ledgerRef(e))}</td><td style="text-align:right">${e.balance_after == null ? "" : num(e.balance_after)}</td></tr>`;
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
              {kinds.map((k) => chip(k, LEDGER_EVENT[k]?.label || k))}
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

export default function Traceability({ part, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!part) return;
    setLoading(true);
    setData(null);
    spareStockService.traceability(part.id)
      .then((r) => setData(r.data.data))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [part]);

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
              ? `${receipt.gate_entry_no || "—"} · ${fmtStamp(receipt.gate_entry_time)}`
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

        <PartLedger ledger={data.ledger || []} partNo={data.part.part_no} stock={data.stock} />
        </>
      )}
    </Modal>
  );
}
