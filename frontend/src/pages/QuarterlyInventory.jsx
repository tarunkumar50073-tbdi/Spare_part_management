import React, { useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { Search, Upload, FileDown } from "lucide-react";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from "recharts";
import Card from "../components/Card.jsx";
import Table from "../components/Table.jsx";
import Badge from "../components/Badge.jsx";
import Modal from "../components/Modal.jsx";
import UploadReportModal from "../components/UploadReportModal.jsx";
import { quarterlyInventoryService } from "../services/quarterlyInventoryService.js";
import { useStoreCategories } from "../constants/categories.js";
import { downloadFile } from "../utils/download.js";

const QUARTERS = ["Q1", "Q2", "Q3", "Q4"];
const STATUSES = ["MATCH", "SHORT", "EXCESS"];
const TABS = ["Dashboard", "Detail", "FY Comparison", "Quarter Comparison", "Charts"];

const DETAIL_COLUMNS = [
  { key: "part_no", label: "Part No" },
  { key: "part_name", label: "Part Name" },
  { key: "category", label: "Category", render: (r) => r.category || "—" },
  { key: "sub_category", label: "Sub Category", render: (r) => r.sub_category || "—" },
  { key: "erp_quantity", label: "ERP Qty" },
  { key: "physical_quantity", label: "Physical Qty" },
  { key: "gap_quantity", label: "Gap Qty" },
  { key: "gap_value", label: "Gap Value" },
  { key: "status", label: "Status", render: (r) => <Badge status={r.status} /> },
];

export default function QuarterlyInventory() {
  const CATEGORIES = useStoreCategories();
  const [activeTab, setActiveTab] = useState("Dashboard");
  const [fiscalYears, setFiscalYears] = useState([]);
  const [fiscalYear, setFiscalYear] = useState("");
  const [quarter, setQuarter] = useState("Q1");

  const [summary, setSummary] = useState(null);
  const [detailRows, setDetailRows] = useState([]);
  const [fyRows, setFyRows] = useState([]);
  const [quarterRows, setQuarterRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploadReport, setUploadReport] = useState(null);
  const [pendingFile, setPendingFile] = useState(null);
  const [sheetChoices, setSheetChoices] = useState([]);

  const [keyword, setKeyword] = useState("");
  const [category, setCategory] = useState("");
  const [status, setStatus] = useState("");

  useEffect(() => {
    quarterlyInventoryService.fiscalYears().then((res) => {
      const years = res.data.data;
      setFiscalYears(years);
      if (years.length > 0) setFiscalYear((fy) => fy || years[0]);
    }).catch(() => {});
  }, []);

  const loadPeriodData = async () => {
    if (!fiscalYear || !quarter) {
      // No period picked yet — there is nothing to fetch, so drop out of the
      // loading state. Returning while `loading` stayed true left every card
      // showing a skeleton for ever, which reads as a page that never loaded.
      setSummary(null);
      setDetailRows([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [s, d] = await Promise.all([
        quarterlyInventoryService.summary(fiscalYear, quarter),
        quarterlyInventoryService.list(fiscalYear, quarter, {
          keyword: keyword || undefined, category: category || undefined, status: status || undefined,
        }),
      ]);
      setSummary(s.data.data);
      setDetailRows(d.data.data);
    } catch (_) {
      /* handled globally */
    } finally {
      setLoading(false);
    }
  };

  const loadComparisons = async () => {
    try {
      const [fy, q] = await Promise.all([
        quarterlyInventoryService.fyComparison(),
        fiscalYear ? quarterlyInventoryService.quarterComparison(fiscalYear) : Promise.resolve({ data: { data: [] } }),
      ]);
      setFyRows(fy.data.data);
      setQuarterRows(q.data.data);
    } catch (_) {
      /* handled globally */
    }
  };

  useEffect(() => {
    loadPeriodData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fiscalYear, quarter, keyword, category, status]);

  useEffect(() => {
    loadComparisons();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fiscalYear]);

  const handleUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Say why nothing happened. This used to return silently, so picking a
    // file with the Fiscal Year box still empty looked like a broken upload.
    if (!fiscalYear || !quarter) {
      toast.error("Enter a Fiscal Year and pick a Quarter before uploading — the file is filed against that period.");
      e.target.value = "";
      return;
    }
    e.target.value = "";
    runImport(file, null);
  };

  const runImport = async (file, sheet) => {
    try {
      const res = await quarterlyInventoryService.import(file, fiscalYear, quarter, sheet);
      setUploadReport(res.data.data);
      setSheetChoices([]);
      setPendingFile(null);
      loadPeriodData();
      loadComparisons();
      quarterlyInventoryService.fiscalYears().then((r) => setFiscalYears(r.data.data)).catch(() => {});
    } catch (err) {
      // The plant workbook keeps the current count and the previous approval
      // sheet side by side, each with its own ERP-stock column — so which one
      // is meant can't be guessed. Hold the file and ask.
      const sheets = err?.response?.data?.errors?.sheets;
      if (sheets?.length) {
        setPendingFile(file);
        setSheetChoices(sheets);
      }
      /* every other failure is already toasted by the api interceptor */
    }
  };

  const closeSheetPicker = () => {
    setSheetChoices([]);
    setPendingFile(null);
  };

  const handleDownloadTemplate = () => downloadFile("/quarterly-inventory/template", "quarterly_inventory_template.xlsx");

  const categoryVariance = useMemo(() => {
    const groups = {};
    for (const r of detailRows) {
      const key = r.category || "Uncategorized";
      groups[key] = groups[key] || { category: key, match: 0, short: 0, excess: 0 };
      if (r.status === "MATCH") groups[key].match += 1;
      else if (r.status === "SHORT") groups[key].short += 1;
      else if (r.status === "EXCESS") groups[key].excess += 1;
    }
    return Object.values(groups);
  }, [detailRows]);

  return (
    <div className="space-y-4">
      <h2 className="font-semibold text-slate-800 dark:text-white">Quarterly Inventory</h2>
      <p className="text-xs text-slate-400 -mt-2">
        Periodic ERP-vs-physical reconciliation, uploaded manually via Excel per Fiscal Year + Quarter — separate from Daily Stock Count.
      </p>

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex flex-col sm:flex-row gap-3">
          <div>
            <label className="text-xs font-medium text-slate-500 block mb-1">Fiscal Year</label>
            <input
              className="input-field w-40"
              list="fiscal-years"
              placeholder="e.g. 2026-27"
              value={fiscalYear}
              onChange={(e) => setFiscalYear(e.target.value)}
            />
            <datalist id="fiscal-years">
              {fiscalYears.map((fy) => <option key={fy} value={fy} />)}
            </datalist>
          </div>
          <div>
            <label className="text-xs font-medium text-slate-500 block mb-1">Quarter</label>
            <select className="input-field w-28" value={quarter} onChange={(e) => setQuarter(e.target.value)}>
              {QUARTERS.map((q) => <option key={q} value={q}>{q}</option>)}
            </select>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 self-end">
          <input type="file" accept=".xlsx,.xlsm,.xls,.csv" className="hidden" id="qty-inv-upload" onChange={handleUpload} />
          <label
            htmlFor="qty-inv-upload"
            title={fiscalYear ? "Upload the count for this Fiscal Year + Quarter" : "Enter a Fiscal Year first"}
            className={`btn-secondary ${fiscalYear ? "cursor-pointer" : "cursor-not-allowed opacity-50"}`}
          >
            <Upload size={16} /> Upload Excel
          </label>
          <button className="btn-secondary" onClick={handleDownloadTemplate}>
            <FileDown size={16} /> Download Template
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-1 border-b border-slate-200 dark:border-navy-800">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setActiveTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === t
                ? "border-toyotared text-toyotared"
                : "border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-white"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {activeTab === "Dashboard" && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
            <Card title="Total Parts Counted" value={summary?.total_parts_counted ?? "—"} loading={loading} accent="navy" />
            <Card title="Matched Parts" value={summary?.matched_parts ?? "—"} loading={loading} accent="green" />
            <Card title="Variance Parts" value={summary?.variance_parts ?? "—"} loading={loading} accent="amber" />
            <Card title="Short Count" value={summary?.short_count ?? "—"} loading={loading} accent="red" />
            <Card title="Excess Count" value={summary?.excess_count ?? "—"} loading={loading} accent="amber" />
            <Card title="Inventory Accuracy" value={summary ? `${summary.inventory_accuracy_pct}%` : "—"} loading={loading} accent="green" />
            <Card title="Physical Inventory Value" value={summary?.physical_inventory_value ?? "—"} loading={loading} accent="navy" />
            <Card title="ERP Value" value={summary?.erp_value ?? "—"} loading={loading} accent="navy" />
            <Card title="Gap Value" value={summary?.gap_value ?? "—"} loading={loading} accent="amber" />
          </div>
        </div>
      )}

      {activeTab === "Detail" && (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative w-full sm:w-64">
              <Search className="absolute left-3 top-2.5 text-slate-400" size={16} />
              <input
                className="input-field pl-9"
                placeholder="Search part no or name..."
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
          <div className="card">
            <Table columns={DETAIL_COLUMNS} rows={detailRows} loading={loading} emptyMessage="No inventory data for this period" />
          </div>
        </div>
      )}

      {activeTab === "FY Comparison" && (
        <div className="space-y-4">
          <div className="card">
            <h3 className="font-semibold text-slate-800 dark:text-white mb-4">Inventory Accuracy by Fiscal Year</h3>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={fyRows} margin={{ top: 10, right: 10, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="fiscal_year" tick={{ fontSize: 11 }} />
                <YAxis allowDecimals={false} />
                <Tooltip />
                <Bar dataKey="inventory_accuracy_pct" name="Accuracy %" fill="#10b981" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="card">
            <Table
              columns={[
                { key: "fiscal_year", label: "Fiscal Year" },
                { key: "total_parts", label: "Total Parts" },
                { key: "variance_parts", label: "Variance Parts" },
                { key: "inventory_accuracy_pct", label: "Accuracy %" },
                { key: "gap_value", label: "Gap Value" },
              ]}
              rows={fyRows}
              loading={loading}
              emptyMessage="No Quarterly Inventory data uploaded yet"
            />
          </div>
        </div>
      )}

      {activeTab === "Quarter Comparison" && (
        <div className="space-y-4">
          <div className="card">
            <h3 className="font-semibold text-slate-800 dark:text-white mb-4">Inventory Accuracy by Quarter — FY {fiscalYear || "—"}</h3>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={quarterRows} margin={{ top: 10, right: 10, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="quarter" tick={{ fontSize: 11 }} />
                <YAxis allowDecimals={false} />
                <Tooltip />
                <Bar dataKey="inventory_accuracy_pct" name="Accuracy %" fill="#1a2b4c" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="card">
            <Table
              columns={[
                { key: "quarter", label: "Quarter" },
                { key: "total_parts", label: "Total Parts" },
                { key: "variance_parts", label: "Variance Parts" },
                { key: "inventory_accuracy_pct", label: "Accuracy %" },
                { key: "gap_value", label: "Gap Value" },
              ]}
              rows={quarterRows}
              loading={loading}
              emptyMessage="No Quarterly Inventory data uploaded yet for this fiscal year"
            />
          </div>
        </div>
      )}

      {activeTab === "Charts" && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="card">
            <h3 className="font-semibold text-slate-800 dark:text-white mb-4">Gap Value Trend — Quarter Comparison</h3>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={quarterRows} margin={{ top: 10, right: 10, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="quarter" tick={{ fontSize: 11 }} />
                <YAxis />
                <Tooltip />
                <Bar dataKey="gap_value" name="Gap Value" fill="#eb0a1e" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="card">
            <h3 className="font-semibold text-slate-800 dark:text-white mb-4">Category-wise Variance — {fiscalYear || "—"} {quarter}</h3>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={categoryVariance} margin={{ top: 10, right: 10, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="category" tick={{ fontSize: 11 }} />
                <YAxis allowDecimals={false} />
                <Tooltip />
                <Legend />
                <Bar dataKey="match" name="Match" fill="#10b981" radius={[4, 4, 0, 0]} />
                <Bar dataKey="short" name="Short" fill="#eb0a1e" radius={[4, 4, 0, 0]} />
                <Bar dataKey="excess" name="Excess" fill="#f59e0b" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      <UploadReportModal report={uploadReport} onClose={() => setUploadReport(null)} />

      <Modal
        open={sheetChoices.length > 0}
        onClose={closeSheetPicker}
        title="Which sheet holds this count?"
        footer={<button className="btn-secondary" onClick={closeSheetPicker}>Cancel</button>}
      >
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-3">
          More than one sheet in this workbook has Part No, ERP Qty and Physical Qty — inventory files usually keep the
          previous approval sheet alongside the current count. Pick the one for{" "}
          <span className="font-semibold">{fiscalYear} {quarter}</span>.
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
