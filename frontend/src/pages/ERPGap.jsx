import React, { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { Scale, Trash2 } from "lucide-react";
import Badge from "../components/Badge.jsx";
import ExcelActions from "../components/ExcelActions.jsx";
import UploadReportModal from "../components/UploadReportModal.jsx";
import { useConfirm } from "../components/ConfirmDialog.jsx";
import { erpGapService } from "../services/erpGapService.js";
import { useStoreCategories } from "../constants/categories.js";
import { downloadFile } from "../utils/download.js";

const STATUSES = ["MATCH", "SHORT", "EXCESS", "NOT_SYNCED", "NO_PHYSICAL"];

// Friendly text for the data-gap states; MATCH/SHORT/EXCESS keep the colored Badge.
const SOFT_LABEL = { NOT_SYNCED: "Awaiting ERP", NO_PHYSICAL: "No physical count" };

function fmtQty(v) {
  return v === null || v === undefined ? "—" : Number(v).toLocaleString();
}

function GapCell({ value }) {
  if (value === null || value === undefined) return <span className="text-slate-300 dark:text-slate-600">—</span>;
  const cls = value === 0 ? "text-slate-500" : value > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400";
  const sign = value > 0 ? "+" : "";
  return <span className={`font-semibold tabular-nums ${cls}`}>{sign}{Number(value).toLocaleString()}</span>;
}

export default function ERPGap() {
  const CATEGORIES = useStoreCategories();
  const confirm = useConfirm();
  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState("");
  const [category, setCategory] = useState("");
  const [status, setStatus] = useState("");
  const [uploadReport, setUploadReport] = useState(null);
  const [clearing, setClearing] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const params = {};
      if (keyword) params.keyword = keyword;
      if (category) params.category = category;
      if (status) params.status = status;
      const [gap, sum] = await Promise.all([erpGapService.list(params), erpGapService.summary()]);
      setRows(gap.data.data);
      setSummary(sum.data.data);
    } catch (_) {
      /* handled globally */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyword, category, status]);

  const handleUpload = async (file) => {
    try {
      const res = await erpGapService.import(file);
      setUploadReport(res.data.data);
      load();
    } catch (_) {
      /* handled globally */
    }
  };

  const handleRemovePhysical = async () => {
    if (!(await confirm({ title: "Remove physical stock", message: "Remove today's uploaded physical stock? ERP data is untouched.", confirmText: "Remove" }))) return;
    setClearing(true);
    try {
      const res = await erpGapService.clearPhysical();
      toast.success(res.data.message || "Physical data removed");
      load();
    } catch (_) {
      /* handled globally */
    } finally {
      setClearing(false);
    }
  };

  const handleDownloadTemplate = () => downloadFile("/erp-gap/template", "physical_stock_template.xlsx");
  const handleExport = () => {
    const qs = new URLSearchParams();
    if (keyword) qs.set("keyword", keyword);
    if (category) qs.set("category", category);
    if (status) qs.set("status", status);
    downloadFile(`/erp-gap/export?${qs.toString()}`, "erp_vs_physical_gap.xlsx");
  };

  const cards = [
    { label: "Matched", value: summary?.matched, tone: "text-emerald-600 dark:text-emerald-400" },
    { label: "Short (Physical < ERP)", value: summary?.short, tone: "text-rose-600 dark:text-rose-400" },
    { label: "Excess (Physical > ERP)", value: summary?.excess, tone: "text-amber-600 dark:text-amber-400" },
    { label: "Accuracy", value: summary?.accuracy_pct != null ? `${summary.accuracy_pct}%` : "—", tone: "text-slate-800 dark:text-white" },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold text-slate-800 dark:text-white flex items-center gap-2">
            <Scale size={18} className="text-toyotared" /> ERP vs Physical Gap
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            ERP-pushed stock vs the latest physical count. Upload the physical Excel to fill the physical column and
            surface the gap; ERP stock arrives automatically from ERP Stock Sync.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn-secondary text-rose-600 dark:text-rose-400" onClick={handleRemovePhysical} disabled={clearing}>
            <Trash2 size={16} /> {clearing ? "Removing..." : "Remove Physical Data"}
          </button>
          <ExcelActions
            onUpload={handleUpload}
            onDownloadTemplate={handleDownloadTemplate}
            onExport={handleExport}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {cards.map((c) => (
          <div key={c.label} className="card py-4">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-1">{c.label}</p>
            <p className={`text-2xl font-bold ${c.tone}`}>{loading || summary == null ? "—" : c.value ?? 0}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        <input
          className="input-field flex-1 min-w-48"
          placeholder="Search Part No or Name..."
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        <select className="input-field" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">All Categories</option>
          {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select className="input-field" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All Status</option>
          {STATUSES.map((s) => <option key={s} value={s}>{SOFT_LABEL[s] || s}</option>)}
        </select>
      </div>

      <div className="card">
        <div className="rounded-xl border border-slate-200 dark:border-navy-800 overflow-x-auto">
          <table className="w-full text-sm min-w-full">
            <thead className="bg-slate-50 dark:bg-navy-800 text-slate-600 dark:text-slate-300">
              <tr>
                <th className="text-left font-semibold px-3 py-3">Part No</th>
                <th className="text-left font-semibold px-3 py-3">Part Name</th>
                <th className="text-left font-semibold px-3 py-3">Category</th>
                <th className="text-right font-semibold px-3 py-3">ERP Stock</th>
                <th className="text-right font-semibold px-3 py-3">Physical Stock</th>
                <th className="text-right font-semibold px-3 py-3">Gap</th>
                <th className="text-left font-semibold px-3 py-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-navy-800 bg-white dark:bg-navy-900">
              {loading ? (
                <tr><td colSpan={7} className="text-center text-slate-400 py-8">Loading...</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={7} className="text-center text-slate-400 py-8">No data yet — upload a physical stock Excel to begin.</td></tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.part_id} className="hover:bg-slate-50 dark:hover:bg-navy-800/60">
                    <td className="px-3 py-3 whitespace-nowrap font-medium">{r.part_no}</td>
                    <td className="px-3 py-3">{r.part_name}</td>
                    <td className="px-3 py-3 whitespace-nowrap">{r.category || "—"}</td>
                    <td className="px-3 py-3 text-right tabular-nums whitespace-nowrap">{fmtQty(r.erp_qty)}</td>
                    <td className="px-3 py-3 text-right tabular-nums whitespace-nowrap">{fmtQty(r.physical_qty)}</td>
                    <td className="px-3 py-3 text-right whitespace-nowrap"><GapCell value={r.gap_qty} /></td>
                    <td className="px-3 py-3 whitespace-nowrap">
                      {SOFT_LABEL[r.status]
                        ? <span className="text-xs text-slate-400">{SOFT_LABEL[r.status]}</span>
                        : <Badge status={r.status} />}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <UploadReportModal report={uploadReport} onClose={() => setUploadReport(null)} />
    </div>
  );
}
