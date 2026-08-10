import React, { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Search, Download } from "lucide-react";
import Table from "../components/Table.jsx";
import Badge from "../components/Badge.jsx";
import Pagination from "../components/Pagination.jsx";
import { liveStockService } from "../services/liveStockService.js";
import { useStoreCategories } from "../constants/categories.js";
import { downloadFile } from "../utils/download.js";

const STATUSES = ["Short", "Normal", "Excess", "OutOfStock"];

const COLUMNS = [
  {
    key: "part_no", label: "Part No",
    render: (r) => (
      <div>
        <div>{r.part_no}</div>
        {r.old_part_no && (
          <div className="text-[11px] text-slate-400">Old: {r.old_part_no}</div>
        )}
      </div>
    ),
  },
  { key: "part_name", label: "Part Name" },
  { key: "category", label: "Category", render: (r) => r.category || "—" },
  { key: "sub_category", label: "Sub Category", render: (r) => r.sub_category || "—" },
  { key: "supplier_name", label: "Supplier", render: (r) => r.supplier_name || "—" },
  { key: "rack_no", label: "Rack Number", render: (r) => r.rack_no || "—" },
  { key: "live_stock", label: "Live Stock", render: (r) => r.live_stock ?? "—" },
  { key: "cov_days", label: "Coverage Day", render: (r) => r.cov_days ?? "—" },
  { key: "status", label: "Status", render: (r) => <Badge status={r.status} /> },
  {
    key: "last_erp_sync", label: "Last ERP Sync Time",
    render: (r) => (r.last_erp_sync ? new Date(r.last_erp_sync).toLocaleString() : "—"),
  },
];

export default function LiveStock() {
  const CATEGORIES = useStoreCategories();
  const [searchParams, setSearchParams] = useSearchParams();
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState(searchParams.get("keyword") || "");
  const [category, setCategory] = useState(searchParams.get("category") || "");
  const [status, setStatus] = useState(searchParams.get("status") || "");
  // Arrives from the dashboard's "Most Affected Supplier" drill-through.
  // No dropdown for it — the supplier list is long and this filter is only
  // ever set by a link, so it shows as a chip that can be cleared.
  const [supplier, setSupplier] = useState(searchParams.get("supplier") || "");
  // Production Status drill-through: Coverage under a day OR out of stock,
  // Dead Stock excluded — the server owns that rule so this page and the
  // dashboard card can never drift apart on what counts as critical.
  const [critical, setCritical] = useState(searchParams.get("critical") === "1");
  const [page, setPage] = useState(1);

  // Topbar's global search navigates here with ?keyword= — pick up changes
  // even when this page is already mounted.
  useEffect(() => {
    const kw = searchParams.get("keyword");
    if (kw !== null && kw !== keyword) setKeyword(kw);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const load = async (p = page) => {
    setLoading(true);
    try {
      const res = await liveStockService.list({
        page: p, per_page: 20,
        keyword: keyword || undefined,
        category: category || undefined,
        status: status || undefined,
        supplier: supplier || undefined,
        critical: critical ? 1 : undefined,
      });
      setRows(res.data.data);
      setMeta(res.data.meta);
    } catch (_) {
      /* handled globally */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setPage(1);
    load(1);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      keyword ? next.set("keyword", keyword) : next.delete("keyword");
      category ? next.set("category", category) : next.delete("category");
      status ? next.set("status", status) : next.delete("status");
      supplier ? next.set("supplier", supplier) : next.delete("supplier");
      critical ? next.set("critical", "1") : next.delete("critical");
      return next;
    }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyword, category, status, supplier, critical]);

  const handleExport = () => downloadFile(
    `/live-stock/export?${new URLSearchParams({
      ...(keyword ? { keyword } : {}),
      ...(category ? { category } : {}),
      ...(status ? { status } : {}),
      ...(supplier ? { supplier } : {}),
      ...(critical ? { critical: 1 } : {}),
    }).toString()}`,
    "live_stock_export.xlsx"
  );

  return (
    <div className="space-y-4">
      <h2 className="font-semibold text-slate-800 dark:text-white">Live Stock</h2>
      {(supplier || critical) && (
        <div className="flex flex-wrap items-center gap-2 -mt-2">
          {critical && (
            <span className="inline-flex items-center gap-2 text-xs font-medium px-2.5 py-1 rounded-full bg-rose-100 dark:bg-rose-500/15 text-rose-700 dark:text-rose-300">
              Production critical (&lt;1 day or out of stock)
              <button onClick={() => setCritical(false)} className="text-rose-400 hover:text-toyotared" title="Clear critical filter">x</button>
            </span>
          )}
          {supplier && (
            <span className="inline-flex items-center gap-2 text-xs font-medium px-2.5 py-1 rounded-full bg-slate-100 dark:bg-navy-800 text-slate-700 dark:text-slate-200">
              Supplier: {supplier}
              <button onClick={() => setSupplier("")} className="text-slate-400 hover:text-toyotared" title="Clear supplier filter">x</button>
            </span>
          )}
        </div>
      )}

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex flex-col sm:flex-row gap-3 flex-1">
          <div className="relative w-full sm:w-64">
            <Search className="absolute left-3 top-2.5 text-slate-400" size={16} />
            <input
              className="input-field pl-9"
              placeholder="Search part no, old part no or name..."
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
            />
          </div>
          <select className="input-field w-full sm:w-40" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">All Categories</option>
            {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select className="input-field w-full sm:w-40" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All Status</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <button className="btn-secondary" onClick={handleExport}>
          <Download size={16} /> Export Excel
        </button>
      </div>

      <div className="card">
        <Table columns={COLUMNS} rows={rows} loading={loading} emptyMessage="No parts found" />
        <Pagination meta={meta} onPageChange={(p) => { setPage(p); load(p); }} />
      </div>
    </div>
  );
}
