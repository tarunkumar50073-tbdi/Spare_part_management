import React, { useEffect, useMemo, useState } from "react";
import { useStores } from "../context/StoreContext.jsx";
import { spareStockService } from "../services/spareStockService.js";
import { downloadXlsx } from "../utils/excel.js";

// Part Ledger rendered as the ERP "Stock Ledger (Valuation)": search/scan a part,
// then its FULL ledger shows automatically (opening + every receipt + every issue
// with where it went) — the only optional filter is a date range, like ERP.
const fmt = (v) => (v == null || v === "" ? "—" : v);

// ERP "Stock Ledger (Valuation)" helpers — the app ledger stores qty + running
// balance per movement; rate/value use the part's single current standard rate
// (unit_price) until ERP feeds real per-transaction rates.
const DOC_TYPE = { OPENING: "OP", RECEIPT: "RC", ISSUE: "IS", RETURN: "RT", ADJUSTMENT: "AD" };
const q3 = (n) => (Number(n) || 0).toFixed(3);   // quantities: 265.000
const m2 = (n) => (Number(n) || 0).toFixed(2);   // rates / values: 11.19
const erpDate = (v) => (v ? new Date(v).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }).replace(/ /g, "-") : "—");

function Field({ label, value }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] uppercase tracking-wide text-slate-400">{label}</div>
      <div className="truncate text-sm font-semibold text-slate-800 dark:text-slate-100">{value}</div>
    </div>
  );
}

export default function SparePartHistory() {
  const { activeCode } = useStores();
  const storeCode = activeCode || "MAINTENANCE";

  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [allParts, setAllParts] = useState([]);
  const [part, setPart] = useState(null);
  const [rows, setRows] = useState([]);
  const [locs, setLocs] = useState([]);
  // ERP-style: no type/department/machine filters — the full ledger shows on pick;
  // an optional From/To date range narrows it (and adds an opening-balance row).
  const [filters, setFilters] = useState({ from: "", to: "" });

  useEffect(() => {
    spareStockService.list({ store_code: storeCode }).then((r) => setAllParts(r.data.data || [])).catch(() => {});
  }, [storeCode]);

  // Fetch every movement once; the filters below are applied instantly on the
  // client so changing a dropdown updates the table with no re-fetch / Apply.
  const loadHistory = async (partId) => {
    const [h, l] = await Promise.all([
      spareStockService.history(partId, 500),
      spareStockService.locationHistory(partId),
    ]);
    setRows(h.data.data || []);
    setLocs(l.data.data || []);
  };

  // Partial, case-insensitive match on part no / name / ref (old) no — so a
  // search finds EVERY matching part, not just one exact code.
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return allParts
      .filter((p) => `${p.part_no || ""} ${p.part_name || ""} ${p.old_part_no || ""}`.toLowerCase().includes(q))
      .slice(0, 50);
  }, [query, allParts]);

  const pick = async (p) => {
    setPart(p);
    setQuery(p.part_no);   // reflect the chosen part in the search box
    setOpen(false);        // and close the suggestion list
    await loadHistory(p.part_id);
  };

  // Only an optional date range narrows the ledger — it applies instantly on the
  // client, no Apply/Enter. Everything else (every type, every department) shows.
  const shown = useMemo(() => rows.filter((r) => {
    if (r.at) {
      const d = r.at.slice(0, 10);
      if (filters.from && d < filters.from) return false;
      if (filters.to && d > filters.to) return false;
    }
    return true;
  }), [rows, filters]);

  // ERP-style valuation ledger: one row per movement, opening/recv/issue/closing
  // qty derived from qty_delta + the stored running balance, rate/value from the
  // part's current standard rate. Chronological (oldest first) so it reads like a
  // ledger — opening flows down to the latest closing.
  const ledger = useMemo(() => {
    const rate = Number(part?.unit_price) || 0;
    const base = {
      group: part?.category || "—",
      subGroup: part?.sub_category || "—",
      itemCd: part?.part_no,
      itemDesc: part?.part_name,
      uom: part?.uom || "—",
      openingRate: rate,
      recvRate: rate,
      issueRate: rate,
      closingRate: rate,
    };
    const list = [...shown]
      .sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0))
      .map((r) => {
        const delta = Number(r.qty_delta) || 0;
        const closing = Number(r.balance_after) || 0;
        const isIn = delta >= 0;
        // "where it went" — department / person / machine on an issue.
        const dest = [r.department, r.issued_to].filter(Boolean).join(" / ")
          + (r.machine ? `${(r.department || r.issued_to) ? " · " : ""}${r.machine}` : "");
        return {
          ...base,
          id: r.id,
          tranDt: r.at || null,
          docNo: r.reference || r.invoice_no || r.return_no || "—",
          docType: DOC_TYPE[r.txn_type] || r.txn_type,
          tranType: isIn ? "R" : "I",
          dest: dest || "—",
          openingQty: closing - delta,
          recvQty: isIn ? delta : 0,
          issueQty: isIn ? 0 : -delta,
          closingStock: closing,
          closingValue: closing * rate,
        };
      });
    // ERP shows the opening balance carried into the From date as the first row,
    // so "opening kitni thi" is always visible even when a date range hides the
    // original opening/receipts. Balance as of From = the last balance before it.
    if (filters.from) {
      const before = rows.filter((r) => r.at && r.at.slice(0, 10) < filters.from);
      if (before.length) {
        const ob = Number([...before].sort((a, b) => new Date(b.at) - new Date(a.at))[0].balance_after) || 0;
        list.unshift({
          ...base, id: "opening-balance", tranDt: filters.from, docNo: "—", docType: "OB",
          tranType: "—", dest: "—", openingQty: ob, recvQty: 0, issueQty: 0,
          closingStock: ob, closingValue: ob * rate,
        });
      }
    }
    return list;
  }, [shown, part, rows, filters.from]);

  const totals = useMemo(
    () => ledger.reduce((a, l) => ({ recv: a.recv + l.recvQty, issue: a.issue + l.issueQty }), { recv: 0, issue: 0 }),
    [ledger],
  );

  const exportLedger = () => {
    if (!ledger.length) return;
    const headers = ["Group", "Sub Group", "Item Cd", "Item Desc", "UOM", "Tran Dt", "Doc No", "Doc Type", "Tran Type", "Dept / Issued To / Machine",
      "Opening Qty", "Opening Rate", "Recv Qty", "Recv Rate", "Issue Qty", "Issue Rate", "Closing Stock", "Closing Rate", "Closing Value"];
    const body = ledger.map((l) => [
      l.group, l.subGroup, l.itemCd, l.itemDesc, l.uom, erpDate(l.tranDt), l.docNo, l.docType, l.tranType, l.dest,
      Number(l.openingQty), Number(l.openingRate), Number(l.recvQty), Number(l.recvRate),
      Number(l.issueQty), Number(l.issueRate), Number(l.closingStock), Number(l.closingRate), Number(l.closingValue),
    ]);
    downloadXlsx(`stock_ledger_${part.part_no}`, headers, body, "Stock Ledger");
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold text-slate-900 dark:text-white">Part Ledger</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">Search by part no / ref / name, then pick a part to see its full ledger — what came in, what went out, and where it went.</p>
      </div>

      <div className="rounded-xl2 border border-slate-200 bg-white p-4 dark:border-navy-800 dark:bg-navy-900">
        <input value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onKeyDown={(e) => { if (e.key === "Enter" && matches.length) { e.preventDefault(); pick(matches[0]); } }}
          placeholder="Search part no / ref / name… (e.g. cntr, 2025)" className="input-field w-full text-lg" />
        {open && query.trim() && (
          <div className="mt-2 max-h-60 overflow-auto rounded-lg border border-slate-100 dark:border-navy-800">
            {matches.length === 0 ? (
              <div className="px-3 py-3 text-sm text-slate-400">No matching parts</div>
            ) : matches.map((p) => (
              <button key={p.part_id} type="button" onClick={() => pick(p)}
                className={`flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-slate-50 dark:hover:bg-navy-800 ${part?.part_id === p.part_id ? "bg-slate-50 dark:bg-navy-800" : ""}`}>
                <span className="font-mono shrink-0">{p.part_no}</span>
                <span className="flex-1 truncate text-slate-500 dark:text-slate-400">{p.part_name}</span>
                {p.old_part_no && <span className="shrink-0 text-xs text-slate-400">{p.old_part_no}</span>}
              </button>
            ))}
          </div>
        )}
        {open && matches.length >= 50 && <p className="mt-1 text-xs text-slate-400">Showing first 50 — refine your search.</p>}
      </div>

      {part && (
        <>
          <div className="rounded-xl2 border border-slate-200 bg-white p-4 dark:border-navy-800 dark:bg-navy-900">
            <div className="mb-1 text-base font-bold text-slate-900 dark:text-white">Stock Ledger (Valuation — Std. Rate)</div>
            {/* ERP-style item identity strip + Excel export */}
            <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
              <div className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3 lg:grid-cols-6">
                <Field label="Item Cd" value={part.part_no} />
                <Field label="Item Desc" value={part.part_name || "—"} />
                <Field label="UOM" value={part.uom || "—"} />
                <Field label="Group" value={part.category || "—"} />
                <Field label="Sub Group" value={part.sub_category || "—"} />
                <Field label="Std Rate (₹)" value={part.unit_price != null ? m2(part.unit_price) : "—"} />
              </div>
              <button className="btn-secondary shrink-0" onClick={exportLedger} disabled={!ledger.length}>⬇ Export Excel</button>
            </div>

            {/* Optional date range only — like ERP; the full ledger shows without it. */}
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-slate-500 dark:text-slate-400">From</span>
              <input type="date" value={filters.from} onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))} className="input-field text-sm" />
              <span className="text-xs font-medium text-slate-500 dark:text-slate-400">To</span>
              <input type="date" value={filters.to} onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))} className="input-field text-sm" />
              {(filters.from || filters.to) && (
                <button className="btn-secondary" onClick={() => setFilters({ from: "", to: "" })}>Clear</button>
              )}
            </div>

            <div className="overflow-auto">
              <table className="w-full text-sm whitespace-nowrap">
                <thead className="text-left text-xs uppercase text-slate-400">
                  <tr>
                    <th className="py-1 pr-3">Group</th>
                    <th className="pr-3">Sub Group</th>
                    <th className="pr-3">Item Cd</th>
                    <th className="pr-3">Item Desc</th>
                    <th className="pr-3">UOM</th>
                    <th className="pr-3">Tran Dt</th>
                    <th className="pr-3">Doc No</th>
                    <th className="pr-3">Doc Type</th>
                    <th className="pr-3">Tran Type</th>
                    <th className="pr-3">Dept / Issued To · Machine</th>
                    <th className="pr-3 text-right">Opening Qty</th>
                    <th className="pr-3 text-right">Opening Rate</th>
                    <th className="pr-3 text-right">Recv Qty</th>
                    <th className="pr-3 text-right">Recv Rate</th>
                    <th className="pr-3 text-right">Issue Qty</th>
                    <th className="pr-3 text-right">Issue Rate</th>
                    <th className="pr-3 text-right">Closing Stock</th>
                    <th className="pr-3 text-right">Closing Rate</th>
                    <th className="pr-3 text-right">Closing Value</th>
                  </tr>
                </thead>
                <tbody>
                  {ledger.map((l) => (
                    <tr key={l.id} className="border-t border-slate-100 dark:border-navy-800">
                      <td className="py-1 pr-3">{l.group}</td>
                      <td className="pr-3">{l.subGroup}</td>
                      <td className="pr-3 font-mono">{l.itemCd}</td>
                      <td className="pr-3 text-slate-500 dark:text-slate-400">{l.itemDesc}</td>
                      <td className="pr-3">{l.uom}</td>
                      <td className="pr-3 tabular-nums">{erpDate(l.tranDt)}</td>
                      <td className="pr-3">{l.docNo}</td>
                      <td className="pr-3">{l.docType}</td>
                      <td className="pr-3">{l.tranType}</td>
                      <td className="pr-3 text-slate-600 dark:text-slate-300">{l.dest}</td>
                      <td className="pr-3 text-right tabular-nums">{q3(l.openingQty)}</td>
                      <td className="pr-3 text-right tabular-nums">{m2(l.openingRate)}</td>
                      <td className="pr-3 text-right tabular-nums">{q3(l.recvQty)}</td>
                      <td className="pr-3 text-right tabular-nums">{l.recvQty ? m2(l.recvRate) : "—"}</td>
                      <td className="pr-3 text-right tabular-nums">{q3(l.issueQty)}</td>
                      <td className="pr-3 text-right tabular-nums">{l.issueQty ? m2(l.issueRate) : "—"}</td>
                      <td className="pr-3 text-right tabular-nums">{q3(l.closingStock)}</td>
                      <td className="pr-3 text-right tabular-nums">{m2(l.closingRate)}</td>
                      <td className="pr-3 text-right font-semibold tabular-nums">{m2(l.closingValue)}</td>
                    </tr>
                  ))}
                  {ledger.length === 0 && (
                    <tr><td colSpan={19} className="py-6 text-center text-slate-400">No movements yet for this part.</td></tr>
                  )}
                </tbody>
                {ledger.length > 0 && (
                  <tfoot>
                    <tr className="border-t-2 border-slate-200 font-semibold dark:border-navy-700">
                      <td className="py-1 pr-3 text-right" colSpan={12}>Total</td>
                      <td className="pr-3 text-right tabular-nums">{q3(totals.recv)}</td>
                      <td className="pr-3"></td>
                      <td className="pr-3 text-right tabular-nums">{q3(totals.issue)}</td>
                      <td colSpan={4}></td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
            <p className="mt-2 text-xs text-slate-400">
              Rate &amp; value use the part's current standard rate (₹{part.unit_price != null ? m2(part.unit_price) : "—"}/unit) for every row; real per-transaction ERP rates will apply once ERP feeds this ledger.
            </p>
          </div>

          <div className="rounded-xl2 border border-slate-200 bg-white p-4 dark:border-navy-800 dark:bg-navy-900">
            <div className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-200">Location history</div>
            {locs.length === 0 ? (
              <p className="text-sm text-slate-400">No location moves recorded.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase text-slate-400">
                  <tr><th className="py-1">When</th><th>From</th><th>To</th><th>Reason</th><th>By</th></tr>
                </thead>
                <tbody>
                  {locs.map((l) => (
                    <tr key={l.id} className="border-t border-slate-100 dark:border-navy-800">
                      <td className="py-1 tabular-nums whitespace-nowrap">{l.at ? new Date(l.at).toLocaleString("en-GB") : "—"}</td>
                      <td>{fmt(l.old_location)}</td><td>{fmt(l.new_location)}</td>
                      <td>{fmt(l.reason)}</td><td>{fmt(l.moved_by)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}
