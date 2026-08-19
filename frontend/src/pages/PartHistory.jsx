import React, { useState } from "react";
import { Search, PackageSearch, Truck, ClipboardList } from "lucide-react";
import Table from "../components/Table.jsx";
import { receivingRegisterService } from "../services/receivingRegisterService.js";
import { gateService } from "../services/gateService.js";

// Part History — search an item code and see its full story from the ERP mirror:
// its GRN receiving history (what was received / accepted / rejected) and its
// gate arrivals (when material came in). Both are read-only, fed by the ERP sync.
const fmtNum = (v) => (v === null || v === undefined ? "—" : Number(v).toLocaleString());
const fmtDate = (v) => v || "—";

const RECEIVING_COLS = [
  { key: "grn_no", label: "GRN No", sortable: true },
  { key: "grn_date", label: "GRN Date", sortable: true, render: (r) => fmtDate(r.grn_date) },
  { key: "ven_cd", label: "Vendor", render: (r) => `${r.ven_cd || "—"}${r.ven_name ? ` · ${r.ven_name}` : ""}`, searchValue: (r) => `${r.ven_cd} ${r.ven_name}` },
  { key: "challan_qty", label: "Challan", align: "right", sortable: true, render: (r) => fmtNum(r.challan_qty) },
  { key: "receipt_qty", label: "Receipt", align: "right", sortable: true, render: (r) => fmtNum(r.receipt_qty) },
  { key: "accept_qty", label: "Accept", align: "right", sortable: true, render: (r) => fmtNum(r.accept_qty) },
  { key: "reject_qty", label: "Reject", align: "right", sortable: true, render: (r) => fmtNum(r.reject_qty) },
];

const ARRIVAL_COLS = [
  { key: "gate_entry_dt", label: "Date", sortable: true, render: (r) => fmtDate(r.gate_entry_dt) },
  { key: "gate_entry_time", label: "Time" },
  { key: "gate_entry_no", label: "Gate Entry No", sortable: true },
  { key: "ven_cd", label: "Vendor", render: (r) => `${r.ven_cd || "—"}${r.ven_name ? ` · ${r.ven_name}` : ""}`, searchValue: (r) => `${r.ven_cd} ${r.ven_name}` },
  { key: "reference_code", label: "Reference" },
  { key: "qty", label: "Qty", align: "right", sortable: true, render: (r) => fmtNum(r.qty) },
];

export default function PartHistory() {
  const [code, setCode] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [receiving, setReceiving] = useState(null); // { rows, totals }
  const [arrivals, setArrivals] = useState([]);

  const search = async () => {
    const c = code.trim();
    if (!c) return;
    setQuery(c);
    setLoading(true);
    try {
      const [rr, ga] = await Promise.all([
        receivingRegisterService.history(c).then((r) => r.data.data).catch(() => null),
        gateService.entries({ item_code: c }).then((r) => r.data.data).catch(() => []),
      ]);
      setReceiving(rr);
      setArrivals(ga || []);
    } finally {
      setLoading(false);
    }
  };

  const totals = receiving?.totals;
  const stat = [
    { label: "Receipts", value: totals?.receipts, icon: ClipboardList, tone: "text-slate-800 dark:text-white" },
    { label: "Receipt Qty", value: totals?.receipt_qty, icon: PackageSearch, tone: "text-sky-600 dark:text-sky-400" },
    { label: "Accepted", value: totals?.accept_qty, icon: PackageSearch, tone: "text-emerald-600 dark:text-emerald-400" },
    { label: "Rejected", value: totals?.reject_qty, icon: PackageSearch, tone: "text-rose-600 dark:text-rose-400" },
  ];

  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-semibold text-slate-800 dark:text-white flex items-center gap-2">
          <PackageSearch size={18} className="text-toyotared" /> Part History
        </h2>
        <p className="text-xs text-slate-400 mt-0.5 max-w-3xl">
          Enter a part / item code to see its GRN receiving history and its gate arrivals (when material came in),
          straight from the ERP mirror. Read-only.
        </p>
      </div>

      <div className="card">
        <div className="flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1 max-w-md">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
            <input
              className="input-field pl-9"
              placeholder="Item code — e.g. 7S111-X0000"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") search(); }}
            />
          </div>
          <button className="btn-primary" onClick={search} disabled={loading || !code.trim()}>
            <Search size={16} /> {loading ? "Searching…" : "Search"}
          </button>
        </div>
      </div>

      {query && (
        <>
          {totals && (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              {stat.map((c) => (
                <div key={c.label} className="card !p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-1 flex items-center gap-1.5">
                    <c.icon size={13} /> {c.label}
                  </p>
                  <p className={`text-xl font-bold tabular ${c.tone}`}>{fmtNum(c.value)}</p>
                </div>
              ))}
            </div>
          )}

          <div className="card">
            <h3 className="font-semibold text-slate-800 dark:text-white flex items-center gap-2 mb-3">
              <ClipboardList size={16} className="text-toyotared" /> Receiving (GRN) — {query}
            </h3>
            <Table
              columns={RECEIVING_COLS}
              rows={receiving?.rows || []}
              loading={loading}
              pageSize={15}
              exportName={`receiving_${query}`}
              emptyMessage="No receiving records for this item"
            />
          </div>

          <div className="card">
            <h3 className="font-semibold text-slate-800 dark:text-white flex items-center gap-2 mb-3">
              <Truck size={16} className="text-toyotared" /> Gate Arrivals — {query}
            </h3>
            <Table
              columns={ARRIVAL_COLS}
              rows={arrivals}
              loading={loading}
              pageSize={15}
              exportName={`arrivals_${query}`}
              emptyMessage="No gate arrivals for this item"
            />
          </div>
        </>
      )}
    </div>
  );
}
