import React, { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { ClipboardCheck, Save } from "lucide-react";
import Badge from "../components/Badge.jsx";
import ExcelActions from "../components/ExcelActions.jsx";
import Modal from "../components/Modal.jsx";
import UploadReportModal from "../components/UploadReportModal.jsx";
import { stockCountService } from "../services/stockCountService.js";
import { downloadFile } from "../utils/download.js";

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

export default function StockCount() {
  const [date, setDate] = useState(todayStr());
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploadReport, setUploadReport] = useState(null);
  const [pendingFile, setPendingFile] = useState(null);
  const [sheetChoices, setSheetChoices] = useState([]);

  const load = async (d) => {
    setLoading(true);
    try {
      const res = await stockCountService.sheet(d);
      setRows(res.data.data);
    } catch (_) {
      /* handled globally */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load(date);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date]);

  const updateQty = (partId, value) => {
    setRows((prev) => prev.map((r) => (r.part_id === partId ? { ...r, counted_qty: value } : r)));
  };

  const handleSave = async () => {
    const entries = rows
      .filter((r) => r.counted_qty !== "" && r.counted_qty !== null && r.counted_qty !== undefined)
      .map((r) => ({ part_id: r.part_id, counted_qty: Number(r.counted_qty) }));
    if (entries.length === 0) {
      toast.error("Enter at least one counted qty");
      return;
    }
    setSaving(true);
    try {
      await stockCountService.submit({ count_date: date, entries });
      toast.success("Stock count saved");
      load(date);
    } catch (_) {
      /* handled globally */
    } finally {
      setSaving(false);
    }
  };

  const runImport = async (file, sheet) => {
    try {
      const res = await stockCountService.import(file, date, sheet);
      setUploadReport(res.data.data);
      setSheetChoices([]);
      setPendingFile(null);
      load(date);
    } catch (err) {
      // A workbook that keeps several months side by side can't be resolved
      // server-side without guessing which one is today's count, so it comes
      // back with the candidate sheet names. Hold on to the file and ask,
      // rather than making someone edit the source workbook every month.
      const sheets = err?.response?.data?.errors?.sheets;
      if (sheets?.length) {
        setPendingFile(file);
        setSheetChoices(sheets);
      }
      /* every other failure is already toasted by the api interceptor */
    }
  };

  const handleUpload = (file) => runImport(file, null);

  const closeSheetPicker = () => {
    setSheetChoices([]);
    setPendingFile(null);
  };

  const handleDownloadTemplate = () => downloadFile("/stock-count/template", "daily_stock_count_template.xlsx");
  const handleExport = () => downloadFile(`/stock-count/export?date=${date}`, `daily_stock_count_${date}.xlsx`);

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold text-slate-800 dark:text-white flex items-center gap-2">
            <ClipboardCheck size={18} className="text-toyotared" /> Daily Stock Count
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Physical child-part count for the day — replaces the Excel count sheet. COV Days / Short-Excess update
            live off the latest saved count.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="date"
            className="input-field"
            value={date}
            max={todayStr()}
            onChange={(e) => setDate(e.target.value)}
          />
          <button className="btn-primary" onClick={handleSave} disabled={saving}>
            <Save size={16} /> {saving ? "Saving..." : "Save Count"}
          </button>
          <ExcelActions
            onUpload={handleUpload}
            onDownloadTemplate={handleDownloadTemplate}
            onExport={handleExport}
          />
        </div>
      </div>

      <div className="card">
        <div className="rounded-xl border border-slate-200 dark:border-navy-800 overflow-x-auto">
          <table className="w-full text-sm min-w-full">
            <thead className="bg-slate-50 dark:bg-navy-800 text-slate-600 dark:text-slate-300">
              <tr>
                <th className="text-left font-semibold px-3 py-3">Part No</th>
                <th className="text-left font-semibold px-3 py-3">Part Name</th>
                <th className="text-left font-semibold px-3 py-3">UOM</th>
                <th className="text-left font-semibold px-3 py-3">Counted Qty ({date})</th>
                <th className="text-left font-semibold px-3 py-3">Peak Daily Requirement</th>
                <th className="text-left font-semibold px-3 py-3">COV Days</th>
                <th className="text-left font-semibold px-3 py-3">Indicator</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-navy-800 bg-white dark:bg-navy-900">
              {loading ? (
                <tr><td colSpan={7} className="text-center text-slate-400 py-8">Loading...</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={7} className="text-center text-slate-400 py-8">No active parts</td></tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.part_id} className="hover:bg-slate-50 dark:hover:bg-navy-800/60">
                    <td className="px-3 py-3 whitespace-nowrap">{r.part_no}</td>
                    <td className="px-3 py-3 whitespace-nowrap">{r.part_name}</td>
                    <td className="px-3 py-3 whitespace-nowrap">{r.uom}</td>
                    <td className="px-3 py-3">
                      <input
                        type="number" step="0.01"
                        className="input-field w-32"
                        value={r.counted_qty ?? ""}
                        onChange={(e) => updateQty(r.part_id, e.target.value)}
                      />
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap">{r.peak_daily_requirement ?? "—"}</td>
                    <td className="px-3 py-3 whitespace-nowrap">{r.cov_days ?? "—"}</td>
                    <td className="px-3 py-3 whitespace-nowrap">
                      {r.indicator ? <Badge status={r.indicator} /> : <span className="text-slate-300 dark:text-slate-600 text-xs">No forecast</span>}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <UploadReportModal report={uploadReport} onClose={() => setUploadReport(null)} />

      <Modal
        open={sheetChoices.length > 0}
        onClose={closeSheetPicker}
        title="Which sheet holds this count?"
        footer={<button className="btn-secondary" onClick={closeSheetPicker}>Cancel</button>}
      >
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-3">
          This workbook has more than one sheet with a Part No and a quantity column — plant reports often keep
          several months side by side. Pick the sheet holding the count for <span className="font-semibold">{date}</span>.
        </p>
        <div className="space-y-2">
          {sheetChoices.map((name) => (
            <button
              key={name}
              className="w-full text-left px-3 py-2.5 rounded-lg border border-slate-200 dark:border-navy-800 hover:border-toyotared hover:bg-slate-50 dark:hover:bg-navy-800 text-sm font-medium text-slate-800 dark:text-white transition-colors"
              onClick={() => runImport(pendingFile, name)}
            >
              {name}
            </button>
          ))}
        </div>
      </Modal>
    </div>
  );
}
