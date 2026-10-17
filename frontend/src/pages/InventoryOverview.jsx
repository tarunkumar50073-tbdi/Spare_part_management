import React, { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Search, Download, ArrowRight, Layers, Globe, Wrench, Package, Boxes } from "lucide-react";
import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip } from "recharts";
import Table from "../components/Table.jsx";
import Badge from "../components/Badge.jsx";
import Pagination from "../components/Pagination.jsx";
import { inventoryOverviewService } from "../services/inventoryOverviewService.js";
import { useStoreCategories } from "../constants/categories.js";
import { downloadFile } from "../utils/download.js";
import { compactMoney, num } from "../lib/format.js";

const STATUSES = ["Healthy", "Short", "Excess", "Dead Stock", "Unknown"];
const CATEGORY_META = {
  "BOP": { icon: Layers, color: "#8b5cf6" },
  "Import": { icon: Globe, color: "#06b6d4" },
  "Maintenance/Tool Room": { icon: Wrench, color: "#f59e0b" },
  "Consumable": { icon: Package, color: "#14b8a6" },
  "In-Parts": { icon: Boxes, color: "#eb0a1e" },
};
const STATUS_COLORS = {
  "Healthy": "#10b981", "Short": "#f43f5e", "Excess": "#f59e0b",
  "Dead Stock": "#64748b", "Unknown": "#94a3b8",
};

const DETAIL_COLUMNS = [
  { key: "part_no", label: "Part No" },
  { key: "part_name", label: "Part Description" },
  { key: "category", label: "Category", render: (r) => r.category || "—" },
  { key: "sub_category", label: "Sub Category", render: (r) => r.sub_category || "—" },
  { key: "rack_no", label: "Rack No", render: (r) => r.rack_no || "—" },
  { key: "live_stock", label: "In Stock", render: (r) => r.live_stock ?? "—" },
  { key: "unit_price", label: "Unit Price (₹)", render: (r) => r.unit_price ?? "—" },
  { key: "total_value", label: "Total Value (₹)", render: (r) => r.total_value ?? "—" },
  { key: "stock_status", label: "Stock Status", render: (r) => <Badge status={r.stock_status} /> },
];

function CategoryCard({ card, onFilter }) {
  const meta = CATEGORY_META[card.category] || {};
  const Icon = meta.icon || Layers;
  return (
    <div className="card">
      <div className="flex items-center gap-2 mb-3">
        <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0" style={{ backgroundColor: `${meta.color}1a`, color: meta.color }}>
          <Icon size={18} />
        </div>
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide truncate" style={{ color: meta.color }}>{card.category}</p>
          <p className="text-xs text-slate-400">{card.total} Parts</p>
        </div>
      </div>
      {card.sub_categories.length === 0 ? (
        <p className="text-xs text-slate-400 py-3">No parts categorized yet</p>
      ) : (
        <div className="space-y-1.5">
          {card.sub_categories.map((s) => (
            <div key={s.name} className="flex items-center justify-between text-xs">
              <span className="text-slate-500 dark:text-slate-400 truncate">{s.name}</span>
              <span className="font-semibold text-slate-800 dark:text-white">{s.count}</span>
            </div>
          ))}
        </div>
      )}
      <button
        onClick={() => onFilter(card.category)}
        className="text-xs font-medium text-toyotared flex items-center gap-1 mt-3 hover:underline"
      >
        View Details <ArrowRight size={12} />
      </button>
    </div>
  );
}

// `centre` formats the total shown in the ring's hole; `unit` is the small
// word under it.
function DonutCard({ title, data, colors, centre = num, unit }) {
  const total = data.reduce((sum, d) => sum + d.value, 0);
  return (
    <div className="card">
      <h3 className="font-semibold text-slate-800 dark:text-white mb-3 text-sm">{title}</h3>
      {total === 0 ? (
        <p className="text-sm text-slate-400 text-center py-16">No data yet</p>
      ) : (
        <div className="flex items-center gap-4">
          <div className="relative w-[130px] h-[130px] shrink-0">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={data} dataKey="value" nameKey="name" innerRadius={38} outerRadius={60} paddingAngle={2}>
                  {data.map((d) => <Cell key={d.name} fill={colors[d.name] || "#94a3b8"} />)}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
              <p className="text-[15px] font-bold leading-none tabular text-slate-900 dark:text-white">{centre(total)}</p>
              {unit && <p className="mt-1 text-[10px] leading-none text-slate-400">{unit}</p>}
            </div>
          </div>
          <div className="space-y-1.5 flex-1 min-w-0">
            {data.map((d) => (
              <div key={d.name} className="flex items-center gap-1.5 text-xs">
                <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: colors[d.name] || "#94a3b8" }} />
                <span className="text-slate-500 dark:text-slate-400 truncate flex-1">{d.name}</span>
                <span className="font-semibold text-slate-800 dark:text-white shrink-0">{d.value}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function InventoryOverview() {
  const CATEGORIES = useStoreCategories();
  const [searchParams, setSearchParams] = useSearchParams();
  const [categoryCards, setCategoryCards] = useState([]);
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState(null);
  const [valueByCategory, setValueByCategory] = useState({});
  const [stockStatusSummary, setStockStatusSummary] = useState({});
  const [topShort, setTopShort] = useState([]);
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState("");
  const [category, setCategory] = useState(searchParams.get("category") || "");
  const [status, setStatus] = useState(searchParams.get("status") || "");
  const [page, setPage] = useState(1);

  const loadTable = async (p = page) => {
    setLoading(true);
    try {
      const res = await inventoryOverviewService.list({
        page: p, per_page: 10,
        keyword: keyword || undefined, category: category || undefined, status: status || undefined,
      });
      setRows(res.data.data);
      setMeta(res.data.meta);
    } catch (_) {
      /* handled globally */
    } finally {
      setLoading(false);
    }
  };

  const loadOverview = async () => {
    try {
      const [cats, val, statusSummary, top] = await Promise.all([
        inventoryOverviewService.categories(),
        inventoryOverviewService.valueByCategory(),
        inventoryOverviewService.stockStatusSummary(),
        inventoryOverviewService.topShortParts(),
      ]);
      setCategoryCards(cats.data.data);
      setValueByCategory(val.data.data);
      setStockStatusSummary(statusSummary.data.data);
      setTopShort(top.data.data);
    } catch (_) {
      /* handled globally */
    }
  };

  useEffect(() => {
    setPage(1);
    loadTable(1);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      category ? next.set("category", category) : next.delete("category");
      status ? next.set("status", status) : next.delete("status");
      return next;
    }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyword, category, status]);

  useEffect(() => {
    loadOverview();
  }, []);

  const handleExport = () => downloadFile(
    `/inventory-overview/export?${new URLSearchParams({
      ...(keyword ? { keyword } : {}),
      ...(category ? { category } : {}),
      ...(status ? { status } : {}),
    }).toString()}`,
    "inventory_overview_export.xlsx"
  );

  return (
    <div className="space-y-4">
      <h2 className="font-semibold text-slate-800 dark:text-white">Inventory Overview</h2>
      <p className="text-xs text-slate-400 -mt-2">Complete view of all inventory across all categories and locations.</p>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        {categoryCards.map((c) => (
          <CategoryCard key={c.category} card={c} onFilter={setCategory} />
        ))}
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex flex-col sm:flex-row gap-3 flex-1">
          <div className="relative w-full sm:w-64">
            <Search className="absolute left-3 top-2.5 text-slate-400" size={16} />
            <input
              className="input-field pl-9"
              placeholder="Search Part No or Description..."
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
            />
          </div>
          <select className="input-field w-full sm:w-48" value={category} onChange={(e) => setCategory(e.target.value)}>
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
        <Table columns={DETAIL_COLUMNS} rows={rows} loading={loading} emptyMessage="No parts found" />
        <Pagination meta={meta} onPageChange={(p) => { setPage(p); loadTable(p); }} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Colours come from the full meta rather than this store's category
            list: the values are whatever the server returns, and a category
            outside the store's list would otherwise be drawn with none. */}
        <DonutCard
          title="Inventory Value by Category (₹)"
          centre={compactMoney} unit="total"
          colors={Object.fromEntries(Object.entries(CATEGORY_META).map(([c, m]) => [c, m.color]))}
          data={Object.entries(valueByCategory).map(([name, value]) => ({ name, value }))}
        />
        <DonutCard
          title="Stock Status Summary"
          unit="parts"
          colors={STATUS_COLORS}
          data={Object.entries(stockStatusSummary).map(([name, value]) => ({ name, value }))}
        />
        <div className="card">
          <h3 className="font-semibold text-slate-800 dark:text-white mb-3 text-sm">Top 5 Short Parts</h3>
          {topShort.length === 0 ? (
            <p className="text-sm text-slate-400 text-center py-10">No short parts right now</p>
          ) : (
            <div className="space-y-2">
              {topShort.map((r) => (
                <div key={r.part_id} className="flex items-center justify-between text-xs border-b border-slate-100 dark:border-navy-800 pb-1.5 last:border-0">
                  <div className="min-w-0">
                    <p className="font-medium text-slate-800 dark:text-white truncate">{r.part_no}</p>
                    <p className="text-slate-400 truncate">{r.part_name}</p>
                  </div>
                  <span className="font-semibold text-rose-600 dark:text-rose-400 shrink-0 ml-2">{r.cov_days ?? "OOS"}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
