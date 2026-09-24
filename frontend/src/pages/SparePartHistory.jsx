import React, { useEffect, useMemo, useState } from "react";
import { useStores } from "../context/StoreContext.jsx";
import { spareStockService } from "../services/spareStockService.js";
import { departmentService } from "../services/departmentService.js";

// Standalone, filterable Complete Part History (spec §15) — search or scan a
// part, then see its full chronological ledger (with the two-stage issue detail
// the old view dropped) plus its location-move trail. Filters: txn type,
// department, machine (server-side) and date range (client-side).
const TXN_TYPES = ["", "ISSUE", "RECEIPT", "RETURN", "OPENING", "ADJUSTMENT"];
const fmt = (v) => (v == null || v === "" ? "—" : v);

export default function SparePartHistory() {
  const { activeCode } = useStores();
  const storeCode = activeCode || "MAINTENANCE";

  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [allParts, setAllParts] = useState([]);
  const [part, setPart] = useState(null);
  const [rows, setRows] = useState([]);
  const [locs, setLocs] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [filters, setFilters] = useState({ txn_type: "", department: "", machine: "", from: "", to: "" });

  useEffect(() => {
    departmentService.list(true).then((r) => setDepartments(r.data.data || [])).catch(() => {});
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

  // All filters (type / department / machine / date range) apply instantly on
  // the client — changing any control updates the table with no Apply, no Enter.
  const shown = useMemo(() => rows.filter((r) => {
    if (filters.txn_type && r.txn_type !== filters.txn_type) return false;
    if (filters.department && r.department !== filters.department) return false;
    if (filters.machine && !(r.machine || "").toLowerCase().includes(filters.machine.trim().toLowerCase())) return false;
    if (r.at) {
      const d = r.at.slice(0, 10);
      if (filters.from && d < filters.from) return false;
      if (filters.to && d > filters.to) return false;
    }
    return true;
  }), [rows, filters]);

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
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-lg font-bold text-slate-900 dark:text-white">{part.part_no}</div>
                <div className="text-sm text-slate-500 dark:text-slate-400">{part.part_name}</div>
              </div>
            </div>

            {/* filters */}
            <div className="mb-3 flex flex-wrap gap-2">
              <select value={filters.txn_type} onChange={(e) => setFilters((f) => ({ ...f, txn_type: e.target.value }))} className="input-field text-sm">
                {TXN_TYPES.map((t) => <option key={t} value={t}>{t || "All types"}</option>)}
              </select>
              <select value={filters.department} onChange={(e) => setFilters((f) => ({ ...f, department: e.target.value }))} className="input-field text-sm">
                <option value="">All departments</option>
                {departments.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
              </select>
              <input value={filters.machine} onChange={(e) => setFilters((f) => ({ ...f, machine: e.target.value }))} placeholder="Machine" className="input-field text-sm" />
              <input type="date" value={filters.from} onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))} className="input-field text-sm" />
              <input type="date" value={filters.to} onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))} className="input-field text-sm" />
              {(filters.txn_type || filters.department || filters.machine || filters.from || filters.to) && (
                <button className="btn-secondary" onClick={() => setFilters({ txn_type: "", department: "", machine: "", from: "", to: "" })}>Clear</button>
              )}
            </div>

            <div className="overflow-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase text-slate-400">
                  <tr>
                    <th className="py-1">When</th><th>Type</th><th>Qty</th><th>Bal</th>
                    <th>Dept / To</th><th>Line / Machine</th><th>Status</th><th>Ref</th><th>By</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((h) => (
                    <tr key={h.id} className="border-t border-slate-100 dark:border-navy-800">
                      <td className="py-1 tabular-nums whitespace-nowrap">{h.at ? new Date(h.at).toLocaleString("en-GB") : "—"}</td>
                      <td>{h.txn_type}</td>
                      <td className="tabular-nums">{h.qty_delta}</td>
                      <td className="tabular-nums">{h.balance_after}</td>
                      <td>{fmt(h.department)}{h.issued_to ? ` / ${h.issued_to}` : ""}</td>
                      <td>{fmt(h.line_name)}{h.machine ? ` / ${h.machine}` : ""}</td>
                      <td>{fmt(h.status)}</td>
                      <td>{fmt(h.reference || h.invoice_no)}</td>
                      <td>{fmt(h.created_by || h.confirmed_by)}</td>
                    </tr>
                  ))}
                  {shown.length === 0 && (
                    <tr><td colSpan={9} className="py-6 text-center text-slate-400">No movements match.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
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
