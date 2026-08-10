import React, { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AlertTriangle, X } from "lucide-react";
import Badge from "../components/Badge.jsx";
import Table from "../components/Table.jsx";
import { liveStockService } from "../services/liveStockService.js";

const num = (v) => (v == null ? "—" : Number(v).toLocaleString());

const COLUMNS = [
  {
    // One row per part, so a part bought from three suppliers lists whichever
    // of its part numbers are short here and the rest in the SOB column —
    // rather than appearing once per short variant, which read as duplicates.
    key: "short_variants",
    label: "Short Part No",
    sortValue: (r) => r.short_variants[0]?.part_no,
    searchValue: (r) => r.short_variants.map((s) => s.part_no).join(" "),
    exportValue: (r) => r.short_variants.map((s) => `${s.part_no} (${s.live_stock})`).join(" | "),
    render: (r) => (
      <div className="space-y-1">
        {r.short_variants.map((s) => (
          <div key={s.part_no} className="flex items-center gap-2">
            <span className="font-medium text-slate-800 dark:text-white">{s.part_no}</span>
            <span className="text-slate-400 text-xs">·</span>
            <span className="text-xs font-semibold text-rose-600 dark:text-rose-400">{num(s.live_stock)}</span>
            <span className="text-[11px] text-slate-400">
              {s.cov_days == null ? "Out of Stock" : `${s.cov_days} day(s)`}
            </span>
          </div>
        ))}
      </div>
    ),
  },
  { key: "part_name", label: "Part Name", sortable: true },
  { key: "category", label: "Category", sortable: true, render: (r) => r.category || "—" },
  { key: "sub_category", label: "Sub Category", sortable: true, render: (r) => r.sub_category || "—" },
  {
    key: "other_suppliers",
    label: "Same Part — Other Suppliers (SOB)",
    searchValue: (r) => r.other_suppliers.map((s) => `${s.part_no} ${s.supplier_name || ""}`).join(" "),
    exportValue: (r) => r.other_suppliers.map((s) => `${s.part_no} (${s.live_stock}, ${s.supplier_name || "—"})`).join(" | "),
    render: (r) =>
      !r.other_suppliers?.length ? (
        <span className="text-slate-300 dark:text-slate-600">Single source</span>
      ) : (
        <div className="space-y-1">
          {r.other_suppliers.map((s) => (
            <div key={s.part_no} className="flex items-center gap-2 text-xs">
              <span className="font-medium text-slate-700 dark:text-slate-200">{s.part_no}</span>
              <span className="text-slate-400">·</span>
              <span className="font-semibold text-slate-800 dark:text-white">{num(s.live_stock)}</span>
              <span className="text-slate-400">·</span>
              <span className="text-slate-500 dark:text-slate-400 truncate max-w-[13rem]">{s.supplier_name || "—"}</span>
              <Badge status={s.status} />
            </div>
          ))}
        </div>
      ),
  },
  {
    key: "sob_total",
    label: "SOB Total Stock",
    sortable: true,
    align: "right",
    render: (r) =>
      r.sob_total == null ? (
        <span className="text-slate-300 dark:text-slate-600">—</span>
      ) : (
        <span className="font-semibold text-blue-700 dark:text-blue-400">{num(r.sob_total)}</span>
      ),
  },
  {
    key: "short_since",
    label: "Short Since",
    sortable: true,
    render: (r) => (r.short_since ? new Date(r.short_since).toLocaleString() : "—"),
  },
];

export default function ShortParts() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  // Set by the dashboard's Most Affected tiles. No dropdowns for them — the
  // filters only ever arrive by link, so they show as chips you can clear.
  const category = searchParams.get("category") || "";
  const supplier = searchParams.get("supplier") || "";

  const clearFilter = (key) =>
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete(key);
      return next;
    }, { replace: true });

  const load = async () => {
    setLoading(true);
    try {
      const res = await liveStockService.short({
        category: category || undefined,
        supplier: supplier || undefined,
      });
      setRows(res.data.data);
    } catch (_) {
      /* handled globally */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category, supplier]);

  const covered = rows.filter((r) => r.other_suppliers?.length).length;

  return (
    <div className="space-y-4">
      <h2 className="font-semibold text-slate-800 dark:text-white flex items-center gap-2">
        <AlertTriangle size={18} className="text-rose-600" /> Short Parts
      </h2>
      <p className="text-xs text-slate-400 -mt-2">
        Coverage Day under 1 day or Out of Stock — one row per part, sorted longest-short-first. A part bought from
        several suppliers carries a separate part number per supplier; the short ones are on the left and what the
        remaining suppliers hold is on the right. Short/Excess is still judged per part number.
      </p>

      {(category || supplier) && (
        <div className="flex flex-wrap items-center gap-2 -mt-2">
          {supplier && (
            <span className="inline-flex items-center gap-2 text-xs font-medium px-2.5 py-1 rounded-full bg-slate-100 dark:bg-navy-800 text-slate-700 dark:text-slate-200">
              Supplier: {supplier}
              <button onClick={() => clearFilter("supplier")} className="text-slate-400 hover:text-toyotared" title="Clear supplier filter">
                <X size={12} />
              </button>
            </span>
          )}
          {category && (
            <span className="inline-flex items-center gap-2 text-xs font-medium px-2.5 py-1 rounded-full bg-slate-100 dark:bg-navy-800 text-slate-700 dark:text-slate-200">
              Category: {category}
              <button onClick={() => clearFilter("category")} className="text-slate-400 hover:text-toyotared" title="Clear category filter">
                <X size={12} />
              </button>
            </span>
          )}
        </div>
      )}

      {covered > 0 && (
        <div className="card border-l-4 border-blue-400 py-3">
          <p className="text-sm text-slate-600 dark:text-slate-300">
            <span className="font-semibold">{covered}</span> of these have stock under another supplier&apos;s part
            number — check SOB Total Stock before raising a shortage.
          </p>
        </div>
      )}

      <div className="card">
        <Table
          columns={COLUMNS}
          rows={rows}
          loading={loading}
          searchable="Search part no, name or supplier…"
          exportName="short_parts"
          emptyMessage="No short parts right now"
        />
      </div>
    </div>
  );
}
