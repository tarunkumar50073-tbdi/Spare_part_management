import React, { useCallback, useEffect, useState } from "react";
import { useStores } from "../context/StoreContext.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { barcodeService } from "../services/barcodeService.js";
import { parseServerTime } from "../lib/format.js";

// Admin-only scan-audit trail: every barcode scan (camera / gun / manual),
// success or failure, across all modes — the /barcode/scan-audit endpoint.
const RESULTS = ["", "SUCCESS", "UNKNOWN_BARCODE", "INACTIVE_BARCODE", "FAILED"];
const MODES = ["", "LOOKUP", "ISSUE", "RECEIVE", "UPDATE_LOCATION", "HISTORY", "MAPPING"];
const SOURCES = ["", "TABLET_CAMERA", "USB_SCANNER", "BLUETOOTH_SCANNER", "MANUAL_ENTRY"];
const RESULT_CLASS = {
  SUCCESS: "text-emerald-600 dark:text-emerald-400",
  UNKNOWN_BARCODE: "text-rose-600 dark:text-rose-400",
  INACTIVE_BARCODE: "text-amber-600 dark:text-amber-400",
  FAILED: "text-rose-600 dark:text-rose-400",
};

export default function ScanAudit() {
  const { activeCode } = useStores();
  const { user } = useAuth();
  const storeCode = activeCode || "MAINTENANCE";
  const isAdmin = !!user?.is_admin;

  const [rows, setRows] = useState([]);
  const [filters, setFilters] = useState({ result: "", scan_mode: "", scan_source: "" });
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    if (!isAdmin) return;
    setLoading(true);
    barcodeService.scanAudit({
      store_code: storeCode,
      result: filters.result || undefined,
      scan_mode: filters.scan_mode || undefined,
      scan_source: filters.scan_source || undefined,
      limit: 300,
    })
      .then((r) => setRows(r.data.data || []))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [isAdmin, storeCode, filters]);

  useEffect(() => { load(); }, [load]);

  if (!isAdmin) {
    return <div className="rounded-lg bg-amber-50 p-4 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
      Scan audit is an administrator view.</div>;
  }

  const Sel = ({ k, opts }) => (
    <select value={filters[k]} onChange={(e) => setFilters((f) => ({ ...f, [k]: e.target.value }))}
      className="input-field text-sm">
      {opts.map((o) => <option key={o} value={o}>{o || `All ${k.replace("scan_", "")}`}</option>)}
    </select>
  );

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold text-slate-900 dark:text-white">Scan Audit</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">Every barcode scan in this store — success or failure.</p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Sel k="result" opts={RESULTS} />
        <Sel k="scan_mode" opts={MODES} />
        <Sel k="scan_source" opts={SOURCES} />
        <button className="btn-secondary" onClick={load}>Refresh</button>
      </div>

      <div className="overflow-auto rounded-xl2 border border-slate-200 bg-white dark:border-navy-800 dark:bg-navy-900">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500 dark:bg-navy-800 dark:text-slate-300">
            <tr>
              <th className="px-3 py-2">When</th><th className="px-3 py-2">Code</th>
              <th className="px-3 py-2">Part</th><th className="px-3 py-2">Mode</th>
              <th className="px-3 py-2">Source</th><th className="px-3 py-2">Result</th><th className="px-3 py-2">User</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-navy-800">
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="px-3 py-1.5 whitespace-nowrap tabular-nums">{parseServerTime(r.at)?.toLocaleString("en-GB") || "—"}</td>
                <td className="px-3 py-1.5 font-mono">{r.scanned_code}</td>
                <td className="px-3 py-1.5">{r.part_no || "—"}</td>
                <td className="px-3 py-1.5">{r.scan_mode}</td>
                <td className="px-3 py-1.5">{r.scan_source}</td>
                <td className={`px-3 py-1.5 font-semibold ${RESULT_CLASS[r.result] || ""}`}>{r.result}</td>
                <td className="px-3 py-1.5">{r.user || "—"}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-400">{loading ? "Loading…" : "No scans"}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
