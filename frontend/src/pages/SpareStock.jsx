import React, { useCallback, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import toast from "react-hot-toast";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check, CircleCheck, ClipboardList, Download, Hourglass, IndianRupee, LayoutGrid, Package, ShoppingCart,
  TriangleAlert, Undo2, Wrench, X,
} from "lucide-react";
import CardHead from "../components/CardHead.jsx";
import ExcelActions from "../components/ExcelActions.jsx";
import KpiCard from "../components/KpiCard.jsx";
import Table from "../components/Table.jsx";
import Can, { useCan } from "../components/Can.jsx";
import UploadReportModal from "../components/UploadReportModal.jsx";
import { useConfirm } from "../components/ConfirmDialog.jsx";
import { spareStockService } from "../services/spareStockService.js";
import { NO_ROWS, invalidateStock, stockKeys, useStockList } from "../lib/stockQueries.js";
import { useStores } from "../context/StoreContext.jsx";
import { downloadFile } from "../utils/download.js";
import { downloadXlsx } from "../utils/excel.js";
import BinSheetPrintModal from "../components/label/BinSheetPrintModal.jsx";
import BinPickerModal from "../components/label/BinPickerModal.jsx";
import { storeService } from "../services/storeService.js";
import { barcodeService } from "../services/barcodeService.js";
import { GAP_FILTERS, STATUS_RANK, fmtDay, matchesGap, splitLocation, typeOf } from "../lib/inventory.js";
import { BulkBar, InventoryFilters, SavedViews } from "../components/spare/InventoryToolbar.jsx";
import { usePartDrawer } from "../context/PartDrawerContext.jsx";

const num = (v) => (v == null ? "—" : Number(v).toLocaleString("en-IN"));
const money = (v) =>
  v == null ? "—" : `₹${Number(v).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

const STATUS_TONE = {
  "Out of Stock": "bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300",
  "Below Minimum": "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300",
  "Reorder": "bg-orange-100 text-orange-700 dark:bg-orange-500/20 dark:text-orange-300",
  "Above Maximum": "bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300",
  "Healthy": "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300",
  "Not Counted": "bg-slate-100 text-slate-500 dark:bg-navy-800 dark:text-slate-400",
  Discontinued: "bg-slate-200 text-slate-700 dark:bg-slate-600/40 dark:text-slate-200",
};

// A chip filters to its own status. "Critical" is the exception: it is not a
// status a part carries but the dashboard's ONE figure for zero stock + below
// minimum, so its chip (and ?status=Critical, where the dashboard's "Open list"
// lands) matches both — the single-status chips stay for telling them apart.
const FILTERS = [
  { key: "", label: "All" },
  { key: "Critical", label: "Critical", statuses: ["Out of Stock", "Below Minimum"] },
  { key: "Not Counted", label: "Never Counted" },
  // Not required any more: kept with its stock, never ordered (22 Oct 2026).
  { key: "Discontinued", label: "Discontinued" },
  { key: "Out of Stock", label: "Zero Stock" },
  { key: "Below Minimum", label: "Below Min" },
  { key: "Reorder", label: "Reorder" },
  { key: "Above Maximum", label: "Above Max" },
  { key: "Healthy", label: "Healthy" },
];
const statusesOf = (key) => FILTERS.find((f) => f.key === key)?.statuses || [key];

// Reorder list — its own table (the parts at/below minimum, with the qty to
// order). Rendered through the shared Table so it gets search / sort / export
// and, crucially, virtualization: this list can run into the thousands.
const REORDER_COLUMNS = [
  { key: "part_no", label: "Part", sortable: true,
    searchValue: (r) => `${r.part_no} ${r.part_name || ""}`,
    exportValue: (r) => `${r.part_no}${r.part_name ? ` ${r.part_name}` : ""}`,
    render: (r) => (<><span className="font-medium">{r.part_no}</span> <span className="text-slate-400">{r.part_name}</span></>) },
  { key: "qty_on_hand", label: "In Stock", align: "right", sortable: true, render: (r) => num(r.qty_on_hand) },
  { key: "min_stock_level", label: "Min", align: "right", sortable: true, render: (r) => num(r.min_stock_level) },
  { key: "reorder_qty", label: "Reorder Qty", align: "right", sortable: true,
    render: (r) => <span className="font-semibold text-amber-600 dark:text-amber-400">{r.reorder_qty == null ? "—" : num(r.reorder_qty)}</span> },
  { key: "reorder_value", label: "Est. Value", align: "right", sortable: true,
    exportValue: (r) => r.reorder_value ?? "",
    render: (r) => (r.reorder_value == null ? "—" : money(r.reorder_value)) },
  { key: "status", label: "Status",
    render: (r) => <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap ${STATUS_TONE[r.status] || STATUS_TONE["Not Counted"]}`}>{r.status}</span> },
];

// The rows of the last upload that were NOT applied because the uploaded file
// is an old copy of Download Template (store, 16 Oct 2026, "Chhote data fix"):
// the part's stock moved after that template was made and the file's figure
// differs from today's — it may be the old stock rather than a count, so it was
// not put back. The import report lists them too; this card stays on the page
// (until dismissed) with what the file said against today's stock.
function StaleTemplateRows({ stale, onDownload, onDismiss }) {
  const n = stale.rows.length;
  return (
    <div role="alert" className="card border-amber-300 bg-amber-50/70 dark:border-amber-500/40 dark:bg-amber-500/[0.08]">
      <div className="flex flex-wrap items-start gap-3">
        <TriangleAlert size={22} strokeWidth={1.75} className="shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-slate-800 dark:text-white">
            {num(n)} row{n === 1 ? "" : "s"} not applied — stock moved since this template was made
            {stale.madeAt ? ` (${stale.madeAt})` : ""}
          </p>
          <p className="mt-0.5 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
            These parts had an issue, receipt, return or count after the template was downloaded, and the
            file&apos;s figure is not today&apos;s stock — it may be the old figure, not a count, so it was not put back.
            The rest of the file was applied. Download a fresh template (or count these parts one at a time in the
            table below) and upload again.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button type="button" onClick={onDownload} className="btn-secondary inline-flex items-center gap-1.5 !py-1.5 text-xs">
            <Download size={13} aria-hidden="true" /> Download fresh template
          </button>
          <button type="button" onClick={onDismiss} aria-label="Dismiss"
            className="rounded-md p-1.5 text-slate-400 hover:bg-amber-100 hover:text-slate-600 dark:hover:bg-amber-500/20">
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="mt-3 max-h-64 overflow-auto rounded-lg border border-amber-200 bg-white dark:border-amber-500/30 dark:bg-navy-900">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-amber-50 text-slate-600 dark:bg-navy-800 dark:text-slate-300">
            <tr>
              <th className="px-3 py-2 text-left font-semibold">Part</th>
              <th className="px-3 py-2 text-right font-semibold">In the file</th>
              <th className="px-3 py-2 text-right font-semibold">Stock now</th>
              <th className="px-3 py-2 text-left font-semibold">Last movement</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-navy-800">
            {stale.rows.map((r, i) => (
              <tr key={`${r.part_id}-${i}`}>
                <td className="px-3 py-2">
                  <span className="font-medium text-slate-800 dark:text-slate-100">{r.part_no}</span>
                  {r.part_name && <span className="text-slate-400"> {r.part_name}</span>}
                </td>
                <td className="px-3 py-2 text-right tabular text-slate-500 line-through decoration-amber-500/70">{num(r.file_qty)}</td>
                <td className="px-3 py-2 text-right tabular font-semibold text-slate-800 dark:text-slate-100">
                  {r.current_qty == null ? "Not counted" : num(r.current_qty)}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-slate-500 dark:text-slate-400">{r.last_moved_at || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Store Stock — the screen that turns a shelf count into the figure every
// gauge, donut and health reading on the dashboard is built from. Until a
// quantity exists here, Min and Max have nothing to be compared against.
export default function SpareStock() {
  const { activeCode, activeStore } = useStores();
  // Import (opening stock upload) is a store_stock write — hide it, and the
  // toolbar's Add button, from a view-only user; Template/Export stay visible.
  const canEditStock = useCan("store_stock", "edit");
  const confirm = useConfirm();
  const qc = useQueryClient();
  const { openPart } = usePartDrawer();
  // Every filter lives in the URL (?status=Below Minimum&section=3&type=Sensor
  // &gap=rate), so the dashboard's "Open list" buttons land here pre-filtered,
  // the browser's back button undoes a filter, and a view can be sent to someone.
  const [params, setParams] = useSearchParams();
  const filter = FILTERS.some((f) => f.key === params.get("status")) ? params.get("status") : "";
  const section = params.get("section") || "";
  const type = params.get("type") || "";
  const rack = params.get("rack") || "";
  const gap = GAP_FILTERS.some((g) => g.key === params.get("gap")) ? params.get("gap") : "";
  const setParam = (key, value) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    if (value) next.set(key, value); else next.delete(key);
    return next;
  }, { replace: true });
  const setFilter = (key) => setParam("status", key);
  const applyView = (f) => setParams(() => {
    const next = new URLSearchParams();
    Object.entries(f || {}).forEach(([k, v]) => { if (v) next.set(k, v); });
    return next;
  }, { replace: true });
  // Bulk selection, by part_id — kept across filter changes, cleared on demand.
  const [selected, setSelected] = useState(() => new Set());
  // The selected parts whose labels are being printed (the bulk print dialog).
  const [binParts, setBinParts] = useState(null);
  // The whole store's parts while the bin picker ("print by bin / rack") is open.
  const [pickParts, setPickParts] = useState(null);
  const [report, setReport] = useState(null);
  // Rows of the last upload skipped as an old template's figures: { rows, madeAt } or null.
  const [stale, setStale] = useState(null);
  // {partId} of the row being typed into, and the value typed so far.
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState("");
  const [erpSyncing, setErpSyncing] = useState(false);

  // On the shared stock cache (lib/stockQueries): the list is the same copy the
  // dashboard and Part Ledger read, so arriving from there is instant, and a
  // server "stock" push refreshes this screen live — a count made on another
  // PC, or an issue at the scan gun, shows here without a reload.
  const on = Boolean(activeCode);
  const listQ = useStockList(activeCode);
  const { data: summary = null } = useQuery({
    queryKey: stockKeys.summary(activeCode, null), enabled: on,
    queryFn: () => spareStockService.summary(activeCode).then((r) => r.data.data),
  });
  const { data: returnables = NO_ROWS } = useQuery({    // outstanding returnable issues
    queryKey: stockKeys.returnables(activeCode), enabled: on,
    queryFn: () => spareStockService.returnables(activeCode).then((r) => r.data.data || []),
  });
  const { data: reorder = null } = useQuery({           // reorder list {items,count,total}
    queryKey: stockKeys.reorder(activeCode), enabled: on,
    queryFn: () => spareStockService.reorder(activeCode).then((r) => r.data.data),
  });
  const { data: erpPending = 0 } = useQuery({           // movements awaiting ERP push
    queryKey: stockKeys.erpPending(activeCode), enabled: on,
    queryFn: () => spareStockService.erpPending(activeCode).then((r) => r.data.data?.pending ?? 0),
  });
  const rows = listQ.data ?? NO_ROWS;
  const loading = listQ.isPending;
  const { data: sections = NO_ROWS } = useQuery({
    queryKey: ["sections", activeCode], enabled: on, staleTime: 5 * 60_000,
    queryFn: () => storeService.sections(activeCode).then((r) => r.data.data || []),
  });
  // Last issue / 90-day issued / last gate supplier per part (keyed by part_id).
  const { data: facts = {} } = useQuery({
    queryKey: stockKeys.facts(activeCode), enabled: on,
    queryFn: () => spareStockService.partFacts(activeCode).then((r) => r.data.data || {}),
  });
  const { data: labelConfig = null } = useQuery({
    queryKey: ["label-config"], staleTime: 10 * 60_000,
    queryFn: () => barcodeService.labelConfig().then((r) => r.data.data),
  });
  // After a write from this screen: refresh every stock view, here and on any
  // other open screen that reads the same cache.
  const load = useCallback(() => invalidateStock(qc), [qc]);

  const downloadTemplate = () => downloadFile(
    "/spare-stock/template", "spare_opening_stock_template.xlsx", { store_code: activeCode });

  const handleUpload = async (file) => {
    try {
      const res = await spareStockService.import(file, activeCode);
      const result = res.data.data;
      setReport(result);
      const staleRows = Array.isArray(result?.stale_rows) ? result.stale_rows : [];
      setStale(staleRows.length ? { code: activeCode, rows: staleRows, madeAt: result.template_made_at } : null);
      toast.success(res.data.message || "Opening stock uploaded");
      if (staleRows.length) {
        toast.error(`${staleRows.length} row${staleRows.length === 1 ? "" : "s"} not applied — `
          + "stock moved since this template was made. Download a fresh template.", { duration: 8000 });
      }
      load();
    } catch (err) {
      toast.error(err?.response?.data?.message || "Upload failed");
    }
  };

  const saveQty = async (row) => {
    const qty = Number(draft);
    if (draft === "" || Number.isNaN(qty) || qty < 0) {
      toast.error("Enter a quantity of zero or more");
      return;
    }
    try {
      await spareStockService.setQuantity(row.part_id, {
        qty_on_hand: qty,
        // A first count is an opening figure; changing one afterwards is a
        // correction. The ledger keeps them apart so a recount is never read
        // as a receipt.
        txn_type: row.qty_on_hand == null ? "OPENING" : "ADJUSTMENT",
        remarks: row.qty_on_hand == null ? "Counted on Store Stock screen" : "Recount",
      });
      toast.success(`${row.part_no} set to ${qty}`);
      setEditing(null);
      setDraft("");
      load();
    } catch (err) {
      toast.error(err?.response?.data?.message || "Could not save");
    }
  };

  const handleErpSync = async () => {
    setErpSyncing(true);
    try {
      const res = await spareStockService.erpSync(activeCode);
      const d = res.data.data;
      if (!d.configured) {
        toast(`ERP endpoint not live yet — ${d.pending} movement${d.pending === 1 ? "" : "s"} will sync once it's set`, { icon: <Hourglass size={18} className="text-amber-500 shrink-0" /> });
      } else {
        toast.success(`Pushed ${d.pushed} movement${d.pushed === 1 ? "" : "s"} to ERP`);
      }
      load();
    } catch (err) {
      toast.error(err?.response?.data?.message || "Sync failed");
    } finally {
      setErpSyncing(false);
    }
  };

  const handleReturn = async (ledgerId, partNo) => {
    if (!(await confirm({ title: "Return to store", message: `Return ${partNo} to store?`, confirmText: "Return", danger: false }))) return;
    try {
      const res = await spareStockService.returnItem(ledgerId, { reason: "Returnable tool/die returned" });
      const slip = res?.data?.data?.return_no;
      toast.success(slip ? `${partNo} returned · slip ${slip}` : `${partNo} returned to store`);
      load();
    } catch (err) {
      toast.error(err?.response?.data?.message || "Could not return");
    }
  };

  const sectionName = useMemo(
    () => Object.fromEntries(sections.map((sc) => [sc.id, sc.name])), [sections]);
  // Each row with what the table shows beside the master: section name, rack /
  // bin split out of the location, and the per-part facts.
  const enriched = useMemo(() => rows.map((r) => ({
    ...r,
    section_name: sectionName[r.section_id] || null,
    type_name: typeOf(r),
    ...splitLocation(r.location),
    ...(facts[r.part_id] || {}),
  })), [rows, sectionName, facts]);
  const types = useMemo(() => {
    const by = {};
    enriched.forEach((r) => { by[r.type_name] = (by[r.type_name] || 0) + 1; });
    return Object.entries(by).map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }, [enriched]);
  // The distinct racks (the "R13" head of a location), for the rack filter that
  // drives the whole-rack bin-sheet print.
  const racks = useMemo(() => {
    const set = new Set();
    enriched.forEach((r) => { if (r.rack) set.add(r.rack); });
    return Array.from(set).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }, [enriched]);
  // Section / type / data-gap first; the status chips count within that, so
  // "Below Min 12" means twelve of the rows the other filters left.
  const scoped = useMemo(() => enriched.filter((r) =>
    (!section || String(r.section_id) === section)
    && (!type || r.type_name === type)
    && (!rack || r.rack === rack)
    && matchesGap(r, gap)), [enriched, section, type, rack, gap]);
  const visible = useMemo(
    () => (filter ? scoped.filter((r) => statusesOf(filter).includes(r.status)) : scoped),
    [scoped, filter],
  );
  const counts = useMemo(() => {
    const by = {};
    scoped.forEach((r) => { by[r.status] = (by[r.status] || 0) + 1; });
    return by;
  }, [scoped]);
  const filtersActive = Boolean(filter || section || type || gap || rack);

  // ---- bulk actions on the selected parts ----
  const selectedRows = useMemo(
    () => enriched.filter((r) => selected.has(r.part_id)), [enriched, selected]);
  // One workbook shape for every client-side part export (selected rows, or the
  // current filtered view) — same columns as the server's full-store export.
  const EXPORT_HEADERS = ["Part No", "Description", "Specification", "Type", "Section", "Location", "In Stock", "Min",
    "Reorder", "Max", "UoM", "Rate", "Stock Value", "Status", "Last issue", "Last supplier (gate)", "Last counted"];
  const toExportRow = (r) => [
    r.part_no, r.part_name || "", r.specification || "", r.type_name, r.section_name || "", r.location || "",
    r.qty_on_hand ?? "", r.min_stock_level ?? "", r.reorder_level ?? "", r.max_stock_level ?? "",
    r.uom || "", r.unit_price ?? "", r.stock_value ?? "", r.status,
    fmtDay(r.last_issue_at) || "", r.supplier || "", fmtDay(r.last_counted_at) || "",
  ];
  const exportSelected = () => downloadXlsx(
    `spare_selected_${new Date().toISOString().slice(0, 10)}`,
    EXPORT_HEADERS, selectedRows.map(toExportRow), "Selected");
  // The header "Export": with a filter active (e.g. opened from a dashboard line
  // such as "Critical parts" or "At reorder level"), export ONLY the rows on screen —
  // so the file matches the list you are looking at, not the whole store. With no
  // filter it stays the full-store workbook built by the server.
  const exportVisible = () => {
    if (!filtersActive) {
      downloadFile("/spare-stock/export", "spare_stock.xlsx", { store_code: activeCode });
      return;
    }
    const slug = (filter || type || gap || "filtered").replace(/[^A-Za-z0-9]+/g, "_");
    downloadXlsx(`spare_stock_${slug}_${new Date().toISOString().slice(0, 10)}`,
      EXPORT_HEADERS, visible.map(toExportRow), (filter || "Filtered").slice(0, 28));
  };
  // Labels are printed first and recorded only after the operator confirms
  // they came out (source STORE_STOCK) — the dialog owns that flow, including
  // which parts already carry a label and need a reprint reason.
  const toPrintPart = (r) => ({
    part_id: r.part_id, part_no: r.part_no, part_name: r.part_name, location: r.location,
    // A part can have TWO locations — fresh (location) and rework (rework_location);
    // both are tagged (the part shows in both bins, each row marked FRESH / REWORK).
    rework_location: r.rework_location,
    specification: r.specification,
    // Section travels with the part so a bin tag is per section AND location —
    // the same rack number exists in more than one section (R3 in Press and in
    // Maintenance), and must not be merged onto one tag.
    section_id: r.section_id, section_name: r.section_name,
    min_stock_level: r.min_stock_level, max_stock_level: r.max_stock_level,
  });
  const selectedForPrint = () => selectedRows.map(toPrintPart);
  const printBinSheets = () => {
    if (!selectedRows.length || selectedRows.length > 300) return;
    setBinParts(selectedForPrint());
  };
  // Every bin sheet for the parts currently in view (use the section filter):
  // groups them by rack location and prints one 130x90 sheet per bin — no need
  // to tick each part.
  const printSectionBins = () => {
    if (!visible.length) return;
    setBinParts(visible.map(toPrintPart));
  };
  // Pick the bins (or whole racks) to print, from every bin of the store — the
  // store asked (17 Oct 2026) for bin-wise tags: "location qr me bin wise bhi tag
  // nikalne ka option add kar de", picked rack first, then the bin: "rack k ander
  // se bin chunna h jaise R4 me B5". The whole store's list, not the filtered
  // view, so any bin can be added; the page's section / rack filter is only
  // where the picker starts.
  const openBinPicker = () => {
    if (!enriched.length) return;
    setPickParts(enriched.map(toPrintPart));
  };

  const dash = <span className="text-slate-300 dark:text-slate-600">—</span>;
  const columns = [
    { key: "part_no", label: "Part No", sortable: true },
    { key: "part_name", label: "Description", sortable: true },
    { key: "specification", label: "Specification", sortable: true, render: (r) => r.specification || dash },
    { key: "type_name", label: "Type", sortable: true },
    { key: "section_name", label: "Section", sortable: true, render: (r) => r.section_name || dash },
    { key: "rack", label: "Rack", sortable: true, render: (r) => r.rack || dash },
    { key: "bin", label: "Shelf · Bin", render: (r) => r.bin || dash },
    { key: "location", label: "Location", render: (r) => r.location || dash },
    { key: "uom", label: "UoM", render: (r) => r.uom || dash },
    {
      key: "qty_on_hand", label: "In Stock", align: "right", sortable: true,
      render: (r) => (editing === r.part_id ? (
        <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          <input
            autoFocus
            type="number"
            min="0"
            step="any"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveQty(r);
              if (e.key === "Escape") { setEditing(null); setDraft(""); }
            }}
            className="w-20 rounded border border-toyotared px-1.5 py-0.5 text-right text-xs
              bg-white dark:bg-navy-900 focus:outline-none"
          />
          <button onClick={() => saveQty(r)} className="text-emerald-600 hover:text-emerald-700" title="Save">
            <Check size={14} />
          </button>
          <button onClick={() => { setEditing(null); setDraft(""); }}
            className="text-slate-400 hover:text-slate-600" title="Cancel">
            <X size={14} />
          </button>
        </div>
      ) : (
        <Can
          mod="store_stock"
          edit
          fallback={
            <span className={r.qty_on_hand == null ? "text-slate-400 italic text-[11px]" : "font-semibold"}>
              {r.qty_on_hand == null ? "—" : num(r.qty_on_hand)}
            </span>
          }
        >
          <button
            onClick={(e) => {
              e.stopPropagation();
              setEditing(r.part_id);
              setDraft(r.qty_on_hand == null ? "" : String(r.qty_on_hand));
            }}
            className={`px-2 py-0.5 rounded hover:bg-slate-100 dark:hover:bg-navy-800 transition-colors
              ${r.qty_on_hand == null ? "text-slate-400 italic text-[11px]" : "font-semibold"}`}
            title="Click to count this part"
          >
            {r.qty_on_hand == null ? "count" : num(r.qty_on_hand)}
          </button>
        </Can>
      )),
    },
    { key: "min_stock_level", label: "Min", align: "right", sortable: true, render: (r) => num(r.min_stock_level) },
    {
      key: "reorder_level", label: "Reorder", align: "right", sortable: true,
      render: (r) => (r.reorder_level == null ? dash : num(r.reorder_level)),
    },
    {
      key: "max_stock_level", label: "Max", align: "right", sortable: true,
      render: (r) => (r.max_stock_level == null ? dash : num(r.max_stock_level)),
    },
    { key: "unit_price", label: "Rate", align: "right", render: (r) => money(r.unit_price) },
    {
      key: "stock_value", label: "Stock Value", align: "right", sortable: true,
      render: (r) => (r.stock_value == null ? "—" : money(r.stock_value)),
    },
    {
      key: "status", label: "Status", sortable: true, sortValue: (r) => STATUS_RANK[r.status] ?? 9,
      render: (r) => (
        <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap
          ${STATUS_TONE[r.status] || STATUS_TONE["Not Counted"]}`}>{r.status}</span>
      ),
    },
    {
      key: "last_issue_at", label: "Last issue", sortable: true, sortValue: (r) => r.last_issue_at || "",
      exportValue: (r) => fmtDay(r.last_issue_at) || "",
      render: (r) => (r.last_issue_at
        ? <span title={`${num(r.issued_90d)} issued in the last 90 days`}>{fmtDay(r.last_issue_at)}</span>
        : dash),
    },
    {
      key: "supplier", label: "Last supplier (gate)", sortable: true,
      render: (r) => (r.supplier
        ? <span title={`${r.supplier_code || ""} · last arrived ${fmtDay(r.last_arrival) || "—"}`}>{r.supplier}</span>
        : dash),
    },
    {
      key: "last_counted_at", label: "Last counted", sortable: true, sortValue: (r) => r.last_counted_at || "",
      exportValue: (r) => fmtDay(r.last_counted_at) || "",
      render: (r) => fmtDay(r.last_counted_at) || dash,
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-800 dark:text-white">Store Stock</h2>
          <p className="text-xs text-slate-400 mt-0.5">
            In-stock quantity for {activeStore?.name || "this store"} — the figure Min and Max are judged against
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Scanning-to-issue lives on the dedicated Scan Part screen now — no
              duplicate here. This screen is for counting stock + opening upload. */}
          <ExcelActions
            addLabel="Stock"
            canEdit={canEditStock}
            onUpload={handleUpload}
            onDownloadTemplate={downloadTemplate}
            onExport={exportVisible}
          />
        </div>
      </div>

      {stale && stale.code === activeCode && (
        <StaleTemplateRows stale={stale} onDownload={downloadTemplate} onDismiss={() => setStale(null)} />
      )}

      {erpPending > 0 && (
        <div className="card bg-amber-50/60 dark:bg-amber-500/[0.08] border-amber-200 dark:border-amber-500/30 flex flex-wrap items-center justify-between gap-3 py-3">
          <p className="text-sm text-slate-700 dark:text-slate-200">
            <b>{erpPending}</b> stock movement{erpPending === 1 ? "" : "s"} pending ERP sync
            <span className="text-slate-400"> — pushes automatically once the ERP endpoint is live</span>
          </p>
          <Can mod="store_stock" edit>
            <button onClick={handleErpSync} disabled={erpSyncing} className="btn-secondary whitespace-nowrap">
              {erpSyncing ? "Syncing…" : "Sync to ERP now"}
            </button>
          </Can>
        </div>
      )}

      {/* The template arrives pre-filled with the store's own part numbers, so
          the count is one column to type rather than 481 rows to retype. */}
      <div className="card bg-blue-50/50 dark:bg-blue-500/[0.07] border-blue-200 dark:border-blue-500/30">
        <div className="flex flex-wrap items-start gap-3">
          <ClipboardList size={24} strokeWidth={1.75} className="shrink-0 text-blue-600 dark:text-blue-400" aria-hidden="true" />
          <div className="min-w-0 flex-1 text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
            <p className="font-semibold text-slate-800 dark:text-white mb-1">How to load physical inventory</p>
            <p>
              <b>Download Template</b> — it comes pre-filled with every part number in this store.
              Fill the <b>Qty On Hand</b> column with your <b>physical count</b> and upload it back.
              A blank cell is skipped, not read as zero, so a part you have not counted stays uncounted.
              Use a fresh template each time: if a part&apos;s stock moved after the template was downloaded and
              your figure is not today&apos;s stock, that row is not applied (it could be the old figure).
              You can also click any figure in the table below to count one part at a time.
              (ERP’s live stock will come through the ERP API later — this page stays for the physical count.)
            </p>
          </div>
        </div>
      </div>

      {summary && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <KpiCard featured tone="blue" label="Parts in Store" icon={Wrench} value={summary.total_parts} />
          <KpiCard featured tone="green" label="Counted" icon={CircleCheck} value={summary.counted_parts}
            hint={`${num(summary.uncounted_parts)} still to count`} />
          <KpiCard featured tone="navy" label="In Stock" icon={Package} value={summary.total_qty} unit="pcs" />
          <KpiCard featured tone="amber" label="Stock Value" icon={IndianRupee}
            value={summary.stock_value ? money(summary.stock_value) : "—"}
            hint={`${num(summary.valued_parts)} parts carry a rate`} />
        </div>
      )}

      <div className="card">
        <CardHead icon={Package} tone="navy" title="Every part in this store"
          hint="Click a row to open the part · click its In Stock figure to count it" />
        <div className="flex flex-wrap gap-2 mb-3">
          {FILTERS.map((f) => (
            <button
              key={f.key || "all"}
              onClick={() => setFilter(f.key)}
              className={`text-xs px-3 py-1.5 rounded-full border transition-colors
                ${filter === f.key
                  ? "bg-toyotared text-white border-toyotared"
                  : "border-slate-200 dark:border-navy-700 text-slate-600 dark:text-slate-300 hover:border-toyotared"}`}
            >
              {f.label}
              <span className="ml-1.5 opacity-70">
                {f.key ? statusesOf(f.key).reduce((sum, s) => sum + (counts[s] || 0), 0) : rows.length}
              </span>
            </button>
          ))}
        </div>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <InventoryFilters
            sections={sections} types={types} racks={racks} section={section} type={type} rack={rack} gap={gap}
            onChange={setParam} active={filtersActive} onClear={() => applyView({})} />
          <div className="flex flex-wrap items-center gap-2">
            {canEditStock && (
              <button type="button" onClick={openBinPicker} disabled={Boolean(binParts || pickParts) || !enriched.length}
                title="Pick a section, a rack and its bins (e.g. R4 → B5) to print their 130×90 mm location sheets"
                className="btn-secondary py-1 text-[13px] disabled:opacity-40">
                <LayoutGrid size={14} aria-hidden="true" /> Bin sheets by rack / bin
              </button>
            )}
            {(section || rack) && canEditStock && (
              <button type="button" onClick={printSectionBins} disabled={Boolean(binParts) || !visible.length}
                title="Print one 130×90 mm location sheet per bin for the current filter (whole section or rack) — grouped by rack location"
                className="btn-secondary py-1 text-[13px] disabled:opacity-40">
                <LayoutGrid size={14} aria-hidden="true" /> All bin sheets ({visible.length.toLocaleString("en-IN")})
              </button>
            )}
            <SavedViews current={{ status: filter, section, type, gap }} onApply={applyView} canSave={filtersActive} />
          </div>
        </div>
        <div className="mb-3">
          <BulkBar count={selected.size} onExport={exportSelected} onPrintBins={printBinSheets}
            printing={Boolean(binParts)} canPrint={canEditStock} onClear={() => setSelected(new Set())} />
        </div>
        <Table
          columns={columns}
          rows={visible}
          loading={loading}
          searchable="Search part no, description, rack or supplier…"
          pageSize={0}
          maxHeight="60vh"
          exportName="spare_store_stock"
          columnToggle
          defaultHidden={["location", "uom"]}
          stickyFirst
          selectable
          selected={selected}
          onSelectedChange={setSelected}
          rowKey={(r) => r.part_id}
          onRowClick={(r) => openPart(r.part_id)}
          virtualize
          emptyMessage={filtersActive ? "No part matches these filters" : "No parts in this store yet"}
        />
      </div>

      {reorder && reorder.items && reorder.items.length > 0 && (
        <div className="card">
          <CardHead icon={ShoppingCart} tone="red" title={`Reorder list — ${reorder.count} part${reorder.count === 1 ? "" : "s"} at or below minimum`}
            hint={reorder.total_reorder_value ? `Est. ${money(reorder.total_reorder_value)} to restock everything to maximum` : "Order these before they run out"} />
          <Table
            columns={REORDER_COLUMNS}
            rows={reorder.items}
            pageSize={0}
            maxHeight="50vh"
            virtualize
            searchable={reorder.items.length > 10 ? "Search part no or name…" : false}
            exportName="reorder_list"
            emptyMessage="Nothing to reorder"
          />
        </div>
      )}

      {returnables.length > 0 && (
        <div className="card">
          <CardHead icon={Undo2} tone="amber" title="Out on the floor — returnable tools"
            hint="Returnable issues still to come back" />
          <div className="rounded-xl border border-slate-200 dark:border-navy-800 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 dark:bg-navy-800 text-slate-600 dark:text-slate-300">
                <tr>
                  <th className="text-left font-semibold px-3 py-2.5">Part</th>
                  <th className="text-right font-semibold px-3 py-2.5">Qty</th>
                  <th className="text-left font-semibold px-3 py-2.5">Department</th>
                  <th className="text-left font-semibold px-3 py-2.5">Machine</th>
                  <th className="px-3 py-2.5"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-navy-800">
                {returnables.map((r) => (
                  <tr key={r.id}>
                    <td className="px-3 py-2.5">
                      <span className="font-medium">{r.part_no}</span>{" "}
                      <span className="text-slate-400">{r.part_name}</span>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{num(r.qty)}</td>
                    <td className="px-3 py-2.5">{r.department || "—"}</td>
                    <td className="px-3 py-2.5">{r.machine || "—"}</td>
                    <td className="px-3 py-2.5 text-right">
                      <Can mod="scan_part" edit>
                        <button
                          onClick={() => handleReturn(r.id, r.part_no)}
                          className="text-xs px-2.5 py-1 rounded bg-emerald-600 text-white hover:opacity-90"
                        >
                          Return
                        </button>
                      </Can>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <UploadReportModal report={report} onClose={() => setReport(null)} />
      {binParts && (
        <BinSheetPrintModal parts={binParts} config={labelConfig}
          onClose={() => setBinParts(null)} />
      )}
      {pickParts && (
        <BinPickerModal parts={pickParts} initialSection={section} initialRack={rack} config={labelConfig}
          onClose={() => setPickParts(null)} />
      )}
    </div>
  );
}
