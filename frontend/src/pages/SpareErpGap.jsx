import React, { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { Scale, Download, Upload } from "lucide-react";
import Badge from "../components/Badge.jsx";
import Can from "../components/Can.jsx";
import { spareStockService } from "../services/spareStockService.js";
import { downloadFile } from "../utils/download.js";
import { useStores } from "../context/StoreContext.jsx";
import { useStoreCategories } from "../constants/categories.js";

const STATUSES = ["MATCH", "SHORT", "EXCESS", "NOT_SYNCED", "NO_PHYSICAL"];

// MATCH/SHORT/EXCESS keep the coloured Badge; the two data-gap states read as
// plain text so they don't look like a stock problem.
const SOFT_LABEL = { NOT_SYNCED: "Awaiting ERP", NO_PHYSICAL: "Not counted yet" };

function fmtQty(v) {
  return v === null || v === undefined ? "—" : Number(v).toLocaleString();
}

function GapCell({ value }) {
  if (value === null || value === undefined) {
    return <span className="text-slate-300 dark:text-slate-600">—</span>;
  }
  const cls = value === 0
    ? "text-slate-500"
    : value > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400";
  const sign = value > 0 ? "+" : "";
  return <span className={`font-semibold tabular-nums ${cls}`}>{sign}{Number(value).toLocaleString()}</span>;
}

export default function SpareErpGap() {
  const { activeCode } = useStores();
  const CATEGORIES = useStoreCategories();
  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState("");
  const [category, setCategory] = useState("");
  const [status, setStatus] = useState("");
  const [uploading, setUploading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  // Load the ERP side from Excel (stand-in until the ERP API is connected), then
  // refresh the comparison.
  const onUpload = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploading(true);
    try {
      const res = await spareStockService.erpStockImport(file, activeCode);
      const r = res.data?.data || {};
      toast.success(`${r.updated ?? 0} part(s) ERP stock updated${r.error_count ? ` · ${r.error_count} skipped` : ""}`);
      setReloadKey((k) => k + 1);
    } catch { /* the global handler shows the error toast */ }
    finally { setUploading(false); }
  };

  useEffect(() => {
    if (!activeCode) return undefined;
    let cancelled = false;
    setLoading(true);
    const params = {};
    if (keyword) params.keyword = keyword;
    if (category) params.category = category;
    if (status) params.status = status;
    Promise.all([
      spareStockService.erpGap(activeCode, params),
      spareStockService.erpGapSummary(activeCode),
    ])
      .then(([gap, sum]) => {
        if (cancelled) return;
        setRows(gap.data.data);
        setSummary(sum.data.data);
      })
      .catch(() => { /* handled globally */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    // A newer store/filter selection must win even if an older request is
    // slower — ignore the stale response rather than let it overwrite.
    return () => { cancelled = true; };
  }, [activeCode, keyword, category, status, reloadKey]);

  const cards = [
    { label: "Matched", value: summary?.matched, tone: "text-emerald-600 dark:text-emerald-400" },
    { label: "Short (Physical < ERP)", value: summary?.short, tone: "text-rose-600 dark:text-rose-400" },
    { label: "Excess (Physical > ERP)", value: summary?.excess, tone: "text-amber-600 dark:text-amber-400" },
    { label: "Accuracy", value: summary?.accuracy_pct != null ? `${summary.accuracy_pct}%` : "—", tone: "text-slate-800 dark:text-white" },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-semibold text-slate-800 dark:text-white flex items-center gap-2">
            <Scale size={18} className="text-toyotared" /> ERP vs Physical
          </h2>
          <p className="text-xs text-slate-400 mt-0.5 max-w-2xl">
            ERP stock against this store&apos;s physical count. The physical column comes from your Store Stock counts;
            load the ERP column from Excel here — a stand-in until the ERP API is connected, after which it syncs automatically.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button type="button" className="btn-secondary"
            onClick={() => downloadFile("/spare-stock/erp-stock/template", "spare_erp_stock_template.xlsx", { store_code: activeCode })}>
            <Download size={14} aria-hidden="true" /> Template
          </button>
          {/* The upload writes ERP stock (Store Stock edit on the server); a
              view-only login — the Manager template, 17 Oct 2026 — reads the gap
              without a button that would only be refused. */}
          <Can mod="store_stock" edit>
            <label className={`btn-primary cursor-pointer ${uploading ? "opacity-60 pointer-events-none" : ""}`}>
              <Upload size={14} aria-hidden="true" /> {uploading ? "Uploading…" : "Upload ERP Stock"}
              <input type="file" accept=".xlsx,.xls" className="hidden" onChange={onUpload} disabled={uploading} />
            </label>
          </Can>
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

      {summary && (summary.not_synced > 0 || summary.no_physical > 0) && (
        <p className="-mt-1 text-[11px] text-slate-400">
          {[
            summary.not_synced ? `${summary.not_synced.toLocaleString()} part(s) have no ERP stock loaded yet` : null,
            summary.no_physical ? `${summary.no_physical.toLocaleString()} not counted yet` : null,
          ].filter(Boolean).join(" · ")}
        </p>
      )}

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
                <th className="text-left font-semibold px-3 py-3">Location</th>
                <th className="text-right font-semibold px-3 py-3">ERP Stock</th>
                <th className="text-right font-semibold px-3 py-3">In Stock (Physical)</th>
                <th className="text-right font-semibold px-3 py-3">Gap</th>
                <th className="text-left font-semibold px-3 py-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-navy-800 bg-white dark:bg-navy-900">
              {loading ? (
                <tr><td colSpan={7} className="text-center text-slate-400 py-8">Loading...</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={7} className="text-center text-slate-400 py-8">No data yet — count stock in Store Stock, or wait for ERP to sync.</td></tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.part_id} className="hover:bg-slate-50 dark:hover:bg-navy-800/60">
                    <td className="px-3 py-3 whitespace-nowrap font-medium">{r.part_no}</td>
                    <td className="px-3 py-3">{r.part_name}</td>
                    <td className="px-3 py-3 whitespace-nowrap">{r.location || "—"}</td>
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
    </div>
  );
}
