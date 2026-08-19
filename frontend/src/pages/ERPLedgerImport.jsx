import React, { useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import { BookOpen, Upload, ShoppingCart, Factory, FolderInput, RefreshCw, CheckCircle2, AlertTriangle, Database } from "lucide-react";
import UploadReportModal from "../components/UploadReportModal.jsx";
import { erpLedgerService } from "../services/erpLedgerService.js";
import { erpSyncService } from "../services/erpSyncService.js";

function fmt(v) {
  return v === null || v === undefined ? "—" : Number(v).toLocaleString();
}

function fmtTime(iso) {
  if (!iso) return "Never";
  return new Date(iso).toLocaleString();
}

export default function ERPLedgerImport() {
  const fileInputRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState(null);
  const [uploadReport, setUploadReport] = useState(null);
  const [inbox, setInbox] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [erpSync, setErpSync] = useState(null);
  const [erpSyncing, setErpSyncing] = useState(false);

  const loadStatus = async () => {
    try {
      const res = await erpLedgerService.inboxStatus();
      setInbox(res.data.data);
    } catch (_) {
      /* handled globally */
    }
  };

  const loadErpSync = async () => {
    try {
      const res = await erpSyncService.status();
      setErpSync(res.data.data);
    } catch (_) {
      /* handled globally */
    }
  };

  useEffect(() => {
    loadStatus();
    loadErpSync();
  }, []);

  const handleErpSync = async () => {
    setErpSyncing(true);
    try {
      const res = await erpSyncService.run();
      const data = res.data.data;
      if (data.configured === false) {
        toast.error("ERP DB not configured — set ERP_DB_* in backend .env");
      } else {
        toast.success(res.data.message || "Synced from ERP");
      }
      await loadErpSync();
    } catch (_) {
      /* handled globally */
    } finally {
      setErpSyncing(false);
    }
  };

  const handleFileChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const res = await erpLedgerService.import(file);
      const data = res.data.data;
      setResult(data);
      setUploadReport(data);
      toast.success(res.data.message || "Ledger imported");
    } catch (_) {
      /* handled globally */
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleScanNow = async () => {
    setScanning(true);
    try {
      const res = await erpLedgerService.scanNow();
      setInbox(res.data.data.status);
      toast.success(res.data.message || "Scan complete");
    } catch (_) {
      /* handled globally */
    } finally {
      setScanning(false);
    }
  };

  const cards = result && [
    { label: "BOP Received (Purchase / SR)", value: result.buy_qty, icon: ShoppingCart, tone: "text-sky-600 dark:text-sky-400" },
    { label: "In-House Made (Production / PP)", value: result.make_qty, icon: Factory, tone: "text-emerald-600 dark:text-emerald-400" },
    { label: "Rows Imported", value: result.created, icon: BookOpen, tone: "text-slate-800 dark:text-white" },
    { label: "Skipped (duplicate / other)", value: (result.skipped_duplicate || 0) + (result.skipped_other || 0), icon: BookOpen, tone: "text-slate-500" },
  ];

  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-semibold text-slate-800 dark:text-white flex items-center gap-2">
          <BookOpen size={18} className="text-toyotared" /> ERP Stock Ledger Import
        </h2>
        <p className="text-xs text-slate-400 mt-0.5 max-w-3xl">
          One-time bridge until the ERP API is live. Each part's{" "}
          <span className="font-medium">BOP (supplier / SR)</span> and{" "}
          <span className="font-medium">In-House (production / PP)</span> receipts are read from the ERP "Stock Ledger
          Valuation" Excel and shown in a part's Source Breakdown. De-duped by Doc No, so re-processing the same rows
          never double-counts. Coating-out, waste and opening rows are skipped for now.
        </p>
      </div>

      {/* ERP Report Sync — read-only pull of Gate Entry + Receiving Register from the ERP DB (termsdb) */}
      <div className="card border-l-4 border-toyotared">
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
          <div>
            <h3 className="font-semibold text-slate-800 dark:text-white flex items-center gap-2">
              <Database size={16} className="text-toyotared" /> ERP Report Sync (read-only)
            </h3>
            <p className="text-xs text-slate-400 mt-0.5 max-w-2xl">
              Pulls <span className="font-medium">Gate Entry</span> (vehicle-in / material arrival) and{" "}
              <span className="font-medium">Receiving Register</span> (GRN receiving history) straight from the plant ERP
              database (schema <span className="font-mono">termsdb</span>) into the app — read-only, last{" "}
              {erpSync?.since_days ?? "—"} days
              {erpSync?.poll_seconds > 0
                ? `, auto every ${Math.round(erpSync.poll_seconds / 60)} min`
                : " (auto-sync off — use the button)"}
              .
              {erpSync && erpSync.configured === false && (
                <span className="text-amber-600 dark:text-amber-400">
                  {" "}
                  ERP DB not configured yet — set ERP_DB_* in the backend .env.
                </span>
              )}
            </p>
          </div>
          <button
            className="btn-secondary whitespace-nowrap"
            onClick={handleErpSync}
            disabled={erpSyncing || (erpSync && erpSync.configured === false)}
          >
            <RefreshCw size={16} className={erpSyncing ? "animate-spin" : ""} /> {erpSyncing ? "Syncing..." : "Sync from ERP"}
          </button>
        </div>

        <div className="mt-3 grid grid-cols-2 lg:grid-cols-4 gap-3 text-sm">
          <div className="rounded-lg border border-slate-200 dark:border-navy-800 p-3">
            <p className="text-[11px] text-slate-400 mb-1">ERP DB</p>
            <p className="text-xs font-medium text-slate-700 dark:text-slate-200">
              {erpSync?.configured ? "Connected" : "Not configured"}
            </p>
          </div>
          <div className="rounded-lg border border-slate-200 dark:border-navy-800 p-3">
            <p className="text-[11px] text-slate-400 mb-1">Last sync</p>
            <p className="text-xs text-slate-700 dark:text-slate-200">{fmtTime(erpSync?.last_sync_at)}</p>
          </div>
          <div className="rounded-lg border border-slate-200 dark:border-navy-800 p-3">
            <p className="text-[11px] text-slate-400 mb-1">Gate Entry rows</p>
            <p className="text-xs font-semibold tabular-nums text-slate-700 dark:text-slate-200">
              {fmt(erpSync?.last_result?.gate_entry)}
            </p>
          </div>
          <div className="rounded-lg border border-slate-200 dark:border-navy-800 p-3">
            <p className="text-[11px] text-slate-400 mb-1">Receiving rows</p>
            <p className="text-xs font-semibold tabular-nums text-slate-700 dark:text-slate-200">
              {fmt(erpSync?.last_result?.receiving_register)}
            </p>
          </div>
        </div>
        {erpSync?.last_error && (
          <p className="mt-2 text-[11px] text-rose-600 dark:text-rose-400 flex items-center gap-1">
            <AlertTriangle size={12} /> Last error: {erpSync.last_error}
          </p>
        )}
      </div>

      {/* Auto-import: drop the file in a folder, no daily manual upload */}
      <div className="card">
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
          <div>
            <h3 className="font-semibold text-slate-800 dark:text-white flex items-center gap-2">
              <FolderInput size={16} className="text-toyotared" /> Auto-Import (Folder Drop)
            </h3>
            <p className="text-xs text-slate-400 mt-0.5 max-w-2xl">
              Drop the daily ERP ledger Excel into the folder below — the app imports it automatically
              {inbox?.poll_seconds > 0
                ? ` every ${Math.round(inbox.poll_seconds / 60)} min`
                : " (background poller off — use Scan Now)"}
              , then moves it to a <span className="font-medium">processed</span> sub-folder. No daily upload needed.
            </p>
          </div>
          <button className="btn-secondary whitespace-nowrap" onClick={handleScanNow} disabled={scanning}>
            <RefreshCw size={16} className={scanning ? "animate-spin" : ""} /> {scanning ? "Scanning..." : "Scan Now"}
          </button>
        </div>

        <div className="mt-3 grid grid-cols-1 lg:grid-cols-3 gap-3 text-sm">
          <div className="rounded-lg border border-slate-200 dark:border-navy-800 p-3 lg:col-span-2">
            <p className="text-[11px] text-slate-400 mb-1">Watched folder</p>
            <p className="font-mono text-xs break-all text-slate-700 dark:text-slate-200">{inbox?.inbox_path || "—"}</p>
          </div>
          <div className="rounded-lg border border-slate-200 dark:border-navy-800 p-3">
            <p className="text-[11px] text-slate-400 mb-1">Last scan</p>
            <p className="text-xs text-slate-700 dark:text-slate-200">{fmtTime(inbox?.last_scan_at)}</p>
            <p className="text-[11px] text-slate-400 mt-2">
              Pending in folder: <span className="font-semibold">{inbox?.pending_files?.length ?? 0}</span>
            </p>
          </div>
        </div>

        {inbox?.recent?.length > 0 && (
          <div className="mt-3 rounded-lg border border-slate-200 dark:border-navy-800 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 dark:bg-navy-800 text-slate-500">
                <tr>
                  <th className="text-left px-3 py-2">File</th>
                  <th className="text-left px-3 py-2">Result</th>
                  <th className="text-right px-3 py-2">Imported</th>
                  <th className="text-right px-3 py-2">BOP</th>
                  <th className="text-right px-3 py-2">In-House</th>
                  <th className="text-left px-3 py-2">When</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-navy-800">
                {inbox.recent.map((r, i) => (
                  <tr key={i}>
                    <td className="px-3 py-2 font-mono break-all">{r.file}</td>
                    <td className="px-3 py-2">
                      {r.ok ? (
                        <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                          <CheckCircle2 size={13} /> OK
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 text-rose-600 dark:text-rose-400" title={r.error}>
                          <AlertTriangle size={13} /> Failed
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.ok ? fmt(r.created) : "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.ok ? fmt(r.buy_qty) : "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.ok ? fmt(r.make_qty) : "—"}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-slate-400">{fmtTime(r.at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Manual upload (fallback / one-off) */}
      <div className="card">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold text-slate-800 dark:text-white flex items-center gap-2">
              <Upload size={16} className="text-toyotared" /> Manual Upload
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">One-off import without using the folder.</p>
          </div>
          <div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xlsm"
              className="hidden"
              id="erp-ledger-upload"
              onChange={handleFileChange}
            />
            <label
              htmlFor="erp-ledger-upload"
              className={`btn-primary cursor-pointer whitespace-nowrap ${uploading ? "opacity-60 pointer-events-none" : ""}`}
            >
              <Upload size={16} /> {uploading ? "Importing..." : "Upload ERP Ledger"}
            </label>
          </div>
        </div>

        {result && (
          <div className="mt-3 grid grid-cols-2 lg:grid-cols-4 gap-3">
            {cards.map((c) => (
              <div key={c.label} className="rounded-lg border border-slate-200 dark:border-navy-800 p-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-1 flex items-center gap-1.5">
                  <c.icon size={13} /> {c.label}
                </p>
                <p className={`text-xl font-bold tabular-nums ${c.tone}`}>{fmt(c.value)}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      <p className="text-xs text-slate-400">
        Open any imported part from the dashboard to see its month-wise BOP vs In-House split under{" "}
        <span className="font-medium">Source Breakdown</span>.
      </p>

      <UploadReportModal report={uploadReport} onClose={() => setUploadReport(null)} />
    </div>
  );
}
