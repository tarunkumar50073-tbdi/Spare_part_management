import React, { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import toast from "react-hot-toast";
import { Pencil, Trash2, Search, Printer } from "lucide-react";
import Table from "../components/Table.jsx";
import Badge from "../components/Badge.jsx";
import Modal from "../components/Modal.jsx";
import Pagination from "../components/Pagination.jsx";
import ExcelActions from "../components/ExcelActions.jsx";
import PartImportModal from "../components/PartImportModal.jsx";
import PrintBarcodeModal from "../components/PrintBarcodeModal.jsx";
import { partService } from "../services/partService.js";
import { supplierService } from "../services/supplierService.js";
import { barcodeService } from "../services/barcodeService.js";
import { useStoreCategories } from "../constants/categories.js";
import { useStores } from "../context/StoreContext.jsx";
import { downloadFile } from "../utils/download.js";

const EMPTY_FORM = {
  part_no: "", part_name: "", uom: "PCS", barcode: "", part_type: "OTHER",
  min_stock_level: 0, max_stock_level: "", is_active: true,
  category: "", sub_category: "", new_part_no: "", old_part_no: "",
  package_standard: "", supplier_id: "", daily_consumption: "", unit_price: "",
  // Without these two the create form could not say which store a part
  // belonged to, so every part added here landed with store_code = NULL and
  // showed up in neither store's dashboard count.
  section_id: "", location: "", rework_location: "",
};

// The three "still to fill in" views. Keys match the API's `missing` values
// and the counts endpoint's keys, so a chip cannot ask for one thing and
// count another.
const MISSING_FILTERS = [
  { key: "", label: "All" },
  { key: "max", label: "Missing Max" },
  { key: "rate", label: "Missing Rate" },
  { key: "location", label: "Missing Location" },
];

export default function PartMaster() {
  const storeCategories = useStoreCategories();
  // Part Master is one screen shared by both stores, reached from each store's
  // own menu. Without this scope it listed all 739 parts whichever store the
  // sidebar was on — the same class of bug PartRepository.get_active()
  // documents ("turned Total Active Parts from 253 into 738").
  const { activeCode, activeStore } = useStores();
  const sections = activeStore?.sections || [];

  // The top bar's search lands here for every store but Child Parts, so the
  // keyword it carried has to actually filter the list — otherwise picking a
  // part out of the dropdown dropped you on all 481 of them.
  const [searchParams] = useSearchParams();
  const urlKeyword = searchParams.get("keyword") || "";

  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState(urlKeyword);
  const [missing, setMissing] = useState("");
  const [counts, setCounts] = useState(null);
  const [page, setPage] = useState(1);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [importFile, setImportFile] = useState(null);
  const [suppliers, setSuppliers] = useState([]);
  // {id, field} of the cell being typed into — Max and Rate only.
  const [editCell, setEditCell] = useState(null);
  const [editValue, setEditValue] = useState("");
  // Barcode label printing (Spare Parts store only).
  const [printPart, setPrintPart] = useState(null);
  const [labelConfig, setLabelConfig] = useState(null);

  useEffect(() => {
    supplierService.list({ per_page: 500 }).then((res) => setSuppliers(res.data.data)).catch(() => {});
    barcodeService.labelConfig().then((res) => setLabelConfig(res.data.data)).catch(() => {});
  }, []);

  // Follows the URL rather than only seeding from it: searching again from the
  // top bar while this screen is already open changes the query string without
  // remounting, and the list has to move with it.
  useEffect(() => { setKeyword(urlKeyword); }, [urlKeyword]);

  // Counted over exactly the rows the table lists — including inactive parts,
  // which the master shows. Scoping the counts to active while the list was
  // unscoped read as an error on screen: "All 254" beside "Missing Max 253".
  // The Spare Parts figures are unaffected either way (all 485 are active),
  // so this still matches the store dashboard's "still without a maximum".
  const loadCounts = () => {
    if (!activeCode) return;
    partService.missingCounts({ store_code: activeCode })
      .then((res) => setCounts(res.data.data))
      .catch(() => setCounts(null));
  };

  // The active store's categories, plus whatever the part being edited is
  // already filed under. Without that second half, opening a Maintenance part
  // while the Child Parts store is in scope would show a select with no
  // matching option — and saving would silently blank the part's category.
  const categoryOptions = form.category && !storeCategories.includes(form.category)
    ? [...storeCategories, form.category]
    : storeCategories;

  const load = async (p = page, kw = keyword, miss = missing) => {
    if (!activeCode) return;
    setLoading(true);
    try {
      const res = await partService.list({
        page: p, per_page: 10,
        keyword: kw || undefined,
        store_code: activeCode,
        missing: miss || undefined,
      });
      setRows(res.data.data);
      setMeta(res.data.meta);
    } catch (_) {
      /* handled globally */
    } finally {
      setLoading(false);
    }
  };

  // Search, filter and store switch all reset to page 1 — page 4 of "missing
  // max" is meaningless once the filter changes under it.
  useEffect(() => {
    load(1, keyword, missing);
    loadCounts();
    setPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyword, missing, activeCode]);

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setModalOpen(true);
  };

  const openEdit = (row) => {
    setEditing(row);
    setForm({
      part_no: row.part_no,
      part_name: row.part_name,
      uom: row.uom,
      barcode: row.barcode ?? "",
      part_type: row.part_type,
      min_stock_level: row.min_stock_level,
      max_stock_level: row.max_stock_level ?? "",
      is_active: row.is_active,
      category: row.category ?? "",
      sub_category: row.sub_category ?? "",
      new_part_no: row.new_part_no ?? "",
      old_part_no: row.old_part_no ?? "",
      package_standard: row.package_standard ?? "",
      supplier_id: row.supplier_id ?? "",
      daily_consumption: row.daily_consumption ?? "",
      unit_price: row.unit_price ?? "",
      section_id: row.section_id ?? "",
      location: row.location ?? "",
      rework_location: row.rework_location ?? "",
    });
    setModalOpen(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const payload = {
      ...form,
      barcode: form.barcode.trim() === "" ? null : form.barcode.trim(),
      min_stock_level: Number(form.min_stock_level) || 0,
      max_stock_level: form.max_stock_level === "" ? null : Number(form.max_stock_level),
      category: form.category || null,
      sub_category: form.sub_category.trim() === "" ? null : form.sub_category.trim(),
      new_part_no: form.new_part_no.trim() === "" ? null : form.new_part_no.trim(),
      old_part_no: form.old_part_no.trim() === "" ? null : form.old_part_no.trim(),
      package_standard: form.package_standard === "" ? null : Number(form.package_standard),
      supplier_id: form.supplier_id === "" ? null : Number(form.supplier_id),
      daily_consumption: form.daily_consumption === "" ? null : Number(form.daily_consumption),
      unit_price: form.unit_price === "" ? null : Number(form.unit_price),
      location: form.location.trim() === "" ? null : form.location.trim(),
      rework_location: form.rework_location.trim() === "" ? null : form.rework_location.trim(),
      section_id: form.section_id === "" ? null : Number(form.section_id),
      // Whichever store the sidebar is in. A part with no store is invisible
      // to both dashboards, which count only parts that have one.
      store_code: activeCode || null,
    };
    try {
      if (editing) {
        const { part_no, ...updatable } = payload;
        await partService.update(editing.id, updatable);
        toast.success("Part updated");
      } else {
        await partService.create(payload);
        toast.success("Part created");
      }
      setModalOpen(false);
      load(page, keyword, missing);
      loadCounts();
    } catch (_) {
      /* error toast handled globally */
    }
  };

  // Inline edit, Max and Rate only. With 298 maximums to fill, opening a
  // twenty-field modal per part is the wrong tool; the Excel round trip is
  // the bulk path and this is for corrections.
  const startEdit = (row, field) => {
    setEditCell({ id: row.id, field });
    setEditValue(row[field] == null ? "" : String(row[field]));
  };

  const commitEdit = async (row, field) => {
    const raw = editValue.trim();
    const next = raw === "" ? null : Number(raw);
    setEditCell(null);
    if (next !== null && (Number.isNaN(next) || next < 0)) {
      toast.error("Enter a number of 0 or more");
      return;
    }
    if (String(row[field] ?? "") === String(next ?? "")) return;
    try {
      await partService.update(row.id, { [field]: next });
      // Patch the row in place rather than refetching the page — a reload
      // here would scroll the keeper back to the top of a 298-row list
      // between every edit.
      setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, [field]: next } : r)));
      loadCounts();
    } catch (_) {
      /* handled globally */
    }
  };

  const editableCell = (row, field, format) => {
    if (editCell?.id === row.id && editCell.field === field) {
      return (
        <input
          autoFocus
          type="number"
          min="0"
          step="any"
          className="w-24 rounded border border-toyotared/50 bg-white dark:bg-navy-900 px-1.5 py-0.5 text-sm
            focus:outline-none focus:ring-2 focus:ring-toyotared/40"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={() => commitEdit(row, field)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); commitEdit(row, field); }
            if (e.key === "Escape") { e.preventDefault(); setEditCell(null); }
          }}
        />
      );
    }
    const value = row[field];
    const unset = value == null || Number(value) === 0;
    return (
      <button
        type="button"
        onClick={() => startEdit(row, field)}
        title="Click to edit"
        className={`w-full text-left px-1.5 py-0.5 rounded hover:bg-slate-100 dark:hover:bg-navy-800 transition-colors ${
          unset ? "text-amber-600 dark:text-amber-400" : ""
        }`}
      >
        {unset ? "set…" : format(value)}
      </button>
    );
  };

  const handleDelete = async (row) => {
    if (!window.confirm(`Delete part ${row.part_no}?`)) return;
    await partService.remove(row.id);
    toast.success("Part deleted");
    load(page, keyword, missing);
    loadCounts();
  };

  // Open the preview modal instead of importing immediately — the user reviews
  // per-row INSERT/UPDATE/ERROR and confirms before anything is written.
  const handleUpload = async (file) => {
    setImportFile(file);
  };

  const handleDownloadTemplate = () => downloadFile("/parts/template", "part_master_template.xlsx");
  // Scoped to the store on screen: the export is the input to the import, so
  // a spares keeper filling in maximums gets their 485 rows, not all 739.
  const handleExport = () =>
    downloadFile(
      "/parts/export",
      `part_master_${(activeCode || "all").toLowerCase()}.xlsx`,
      activeCode ? { store_code: activeCode } : undefined,
    );

  const columns = [
    { key: "part_no", label: "Part No" },
    { key: "part_name", label: "Part Name" },
    { key: "uom", label: "UOM" },
    { key: "barcode", label: "Barcode", render: (r) => r.barcode || <span className="text-slate-300 dark:text-slate-600">—</span> },
    { key: "category", label: "Category", render: (r) => r.category || "—" },
    { key: "sub_category", label: "Sub Category", render: (r) => r.sub_category || "—" },
    { key: "part_type", label: "Routing", render: (r) => <Badge status={r.part_type} /> },
    { key: "location", label: "Location", render: (r) => r.location || <span className="text-slate-300 dark:text-slate-600">—</span> },
    {
      key: "rework_location",
      label: "Rework",
      // The same amber pill the Spare Parts Store's own list uses, so the two
      // screens read as one thing rather than two views of it.
      render: (r) =>
        r.rework_location ? (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full
            bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
            🔁 {r.rework_location}
          </span>
        ) : (
          <span className="text-slate-300 dark:text-slate-600">—</span>
        ),
    },
    { key: "min_stock_level", label: "Min Stock" },
    {
      key: "max_stock_level", label: "Max Stock",
      exportValue: (r) => r.max_stock_level ?? "",
      render: (r) => editableCell(r, "max_stock_level", (v) => Number(v).toLocaleString("en-IN")),
    },
    {
      key: "unit_price", label: "Rate",
      exportValue: (r) => r.unit_price ?? "",
      render: (r) => editableCell(r, "unit_price", (v) => `₹${Number(v).toLocaleString("en-IN")}`),
    },
    { key: "is_active", label: "Status", render: (r) => <Badge status={r.is_active ? "Active" : "Inactive"} /> },
    {
      key: "actions",
      label: "Actions",
      render: (r) => (
        <div className="flex gap-2">
          <button onClick={() => openEdit(r)} className="text-navy-700 dark:text-slate-300 hover:text-toyotared">
            <Pencil size={16} />
          </button>
          {activeCode === "MAINTENANCE" && (
            <button onClick={() => setPrintPart(r)} title="Print barcode label"
              className="text-navy-700 dark:text-slate-300 hover:text-toyotared">
              <Printer size={16} />
            </button>
          )}
          <button onClick={() => handleDelete(r)} className="text-rose-500 hover:text-rose-700">
            <Trash2 size={16} />
          </button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-3 top-2.5 text-slate-400" size={16} />
          <input
            className="input-field pl-9"
            placeholder="Search part no or name..."
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
        </div>
        <ExcelActions
          addLabel="Add Part"
          onAddNew={openCreate}
          onUpload={handleUpload}
          onDownloadTemplate={handleDownloadTemplate}
          onExport={handleExport}
        />
      </div>

      {/* The store's own to-do list. Counts come from the server over the
          whole store, not the page on screen, so "Missing Max 298" means 298
          parts and not "298 of the ten you can see". */}
      <div className="flex flex-wrap items-center gap-2">
        {MISSING_FILTERS.map(({ key, label }) => {
          // All reads its own total from the counts endpoint, not from the list
          // response — that response is the filtered page, so selecting
          // "Missing Max" made All report 293 as though the store had shrunk to
          // the parts it was complaining about.
          const count = counts?.[key || "total"];
          const active = missing === key;
          return (
            <button
              key={key || "all"}
              type="button"
              onClick={() => setMissing(key)}
              className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium ring-1 ring-inset transition ${
                active
                  ? "bg-toyotared text-white ring-toyotared"
                  : "bg-white dark:bg-navy-900 text-slate-600 dark:text-slate-300 ring-slate-200 dark:ring-navy-700 hover:bg-slate-50 dark:hover:bg-navy-800"
              }`}
            >
              {label}
              {count != null && (
                <span className={`tabular font-bold ${active ? "" : "text-slate-400"}`}>{count}</span>
              )}
            </button>
          );
        })}
      </div>

      <div className="card">
        <Table columns={columns} rows={rows} loading={loading} />
        <Pagination meta={meta} onPageChange={(p) => { setPage(p); load(p, keyword, missing); }} />
      </div>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? "Edit Part" : "Add Part"}
        footer={
          <>
            <button className="btn-secondary" onClick={() => setModalOpen(false)}>Cancel</button>
            <button className="btn-primary" onClick={handleSubmit}>{editing ? "Update" : "Create"}</button>
          </>
        }
      >
        <form className="space-y-3" onSubmit={handleSubmit}>
          <div>
            <label className="text-xs font-medium text-slate-500">Part No</label>
            <input
              className="input-field mt-1"
              value={form.part_no}
              disabled={!!editing}
              onChange={(e) => setForm({ ...form, part_no: e.target.value })}
              required
            />
          </div>
          <div>
            <label className="text-xs font-medium text-slate-500">Part Name</label>
            <input
              className="input-field mt-1"
              value={form.part_name}
              onChange={(e) => setForm({ ...form, part_name: e.target.value })}
              required
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-slate-500">UOM</label>
              <input
                className="input-field mt-1"
                value={form.uom}
                onChange={(e) => setForm({ ...form, uom: e.target.value })}
              />
            </div>
            <div>
              <label className="text-xs font-medium text-slate-500">Barcode</label>
              <input
                className="input-field mt-1"
                value={form.barcode}
                placeholder="Falls back to Part No if blank"
                onChange={(e) => setForm({ ...form, barcode: e.target.value })}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-slate-500">New Part No</label>
              <input
                className="input-field mt-1"
                value={form.new_part_no}
                onChange={(e) => setForm({ ...form, new_part_no: e.target.value })}
              />
            </div>
            <div>
              <label className="text-xs font-medium text-slate-500">Old Part No</label>
              <input
                className="input-field mt-1"
                value={form.old_part_no}
                onChange={(e) => setForm({ ...form, old_part_no: e.target.value })}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-slate-500">Category</label>
              <select
                className="input-field mt-1"
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
              >
                <option value="">— None —</option>
                {categoryOptions.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-slate-500">Sub Category</label>
              <input
                className="input-field mt-1"
                value={form.sub_category}
                onChange={(e) => setForm({ ...form, sub_category: e.target.value })}
              />
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-slate-500">Supplier</label>
            <select
              className="input-field mt-1"
              value={form.supplier_id}
              onChange={(e) => setForm({ ...form, supplier_id: e.target.value })}
            >
              <option value="">— None —</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.vendor_code} — {s.supplier_name}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="text-xs font-medium text-slate-500">Package Standard</label>
              <input
                type="number" step="0.01"
                className="input-field mt-1"
                value={form.package_standard}
                onChange={(e) => setForm({ ...form, package_standard: e.target.value })}
              />
            </div>
            <div>
              <label className="text-xs font-medium text-slate-500">Daily Consumption</label>
              <input
                type="number" step="0.01"
                className="input-field mt-1"
                value={form.daily_consumption}
                onChange={(e) => setForm({ ...form, daily_consumption: e.target.value })}
              />
            </div>
            <div>
              <label className="text-xs font-medium text-slate-500">Unit Price</label>
              <input
                type="number" step="0.01"
                className="input-field mt-1"
                value={form.unit_price}
                onChange={(e) => setForm({ ...form, unit_price: e.target.value })}
              />
            </div>
          </div>
          {/* Where the part physically sits. These are the two fields the
              Spare Parts Store is organised around — its dashboard groups by
              the rack parsed out of Location and flags rework parts by Rework
              Location — and until now neither could be typed anywhere. */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-slate-500">Location</label>
              <input
                className="input-field mt-1"
                placeholder="R4-S1-B1 (1)"
                value={form.location}
                onChange={(e) => setForm({ ...form, location: e.target.value })}
              />
            </div>
            <div>
              <label className="text-xs font-medium text-slate-500">Rework Location</label>
              <input
                className="input-field mt-1"
                placeholder="Blank if it never goes for rework"
                value={form.rework_location}
                onChange={(e) => setForm({ ...form, rework_location: e.target.value })}
              />
            </div>
          </div>

          {sections.length > 0 && (
            <div>
              <label className="text-xs font-medium text-slate-500">
                Section in {activeStore?.name}
              </label>
              <select
                className="input-field mt-1"
                value={form.section_id}
                onChange={(e) => setForm({ ...form, section_id: e.target.value })}
              >
                <option value="">— None —</option>
                {sections.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="text-xs font-medium text-slate-500">Material Routing (manual-override reference only — SRV routing is decided by ERP's qc_required flag)</label>
            <select
              className="input-field mt-1"
              value={form.part_type}
              onChange={(e) => setForm({ ...form, part_type: e.target.value })}
            >
              <option value="DOL">DOL</option>
              <option value="OTHER">Others / BOP</option>
              <option value="TOOL_ROOM">Tool Room</option>
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-slate-500">Min Stock Level</label>
              <input
                type="number" step="0.01"
                className="input-field mt-1"
                value={form.min_stock_level}
                onChange={(e) => setForm({ ...form, min_stock_level: e.target.value })}
              />
            </div>
            <div>
              <label className="text-xs font-medium text-slate-500">Max Stock Level</label>
              <input
                type="number" step="0.01"
                className="input-field mt-1"
                value={form.max_stock_level}
                placeholder="No limit"
                onChange={(e) => setForm({ ...form, max_stock_level: e.target.value })}
              />
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-slate-500">Status</label>
            <select
              className="input-field mt-1"
              value={form.is_active ? "Active" : "Inactive"}
              onChange={(e) => setForm({ ...form, is_active: e.target.value === "Active" })}
            >
              <option>Active</option>
              <option>Inactive</option>
            </select>
          </div>
        </form>
      </Modal>

      <PartImportModal
        file={importFile}
        storeCode={activeCode}
        sectionId={sections.length === 1 ? sections[0].id : undefined}
        onClose={() => setImportFile(null)}
        onImported={() => { load(page, keyword, missing); loadCounts(); }}
      />

      <PrintBarcodeModal
        open={!!printPart}
        part={printPart}
        config={labelConfig}
        onClose={() => setPrintPart(null)}
      />
    </div>
  );
}
