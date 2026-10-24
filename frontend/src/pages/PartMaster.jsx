import React, { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import toast from "react-hot-toast";
import { Pencil, Trash2, Search, Repeat2, Camera, Factory, ImageOff, ImagePlus, X } from "lucide-react";
import Table from "../components/Table.jsx";
import Badge from "../components/Badge.jsx";
import Modal from "../components/Modal.jsx";
import PhotoCapture from "../components/PhotoCapture.jsx";
import { useConfirm } from "../components/ConfirmDialog.jsx";
import Pagination from "../components/Pagination.jsx";
import ExcelActions from "../components/ExcelActions.jsx";
import Can, { useCan } from "../components/Can.jsx";
import { partService } from "../services/partService.js";
import { supplierService } from "../services/supplierService.js";
import { barcodeService } from "../services/barcodeService.js";
import { useStoreCategories } from "../constants/categories.js";
import { useStores } from "../context/StoreContext.jsx";
import { downloadFile } from "../utils/download.js";
import { shrinkPhoto } from "../utils/shrinkPhoto.js";

const EMPTY_FORM = {
  part_no: "", part_name: "", uom: "PCS", barcode: "", part_type: "OTHER",
  min_stock_level: 0, reorder_level: "", max_stock_level: "", is_active: true, discontinued: false,
  category: "", sub_category: "", specification: "", model_no: "", new_part_no: "", old_part_no: "",
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
  { key: "photo", label: "Missing Photo" },
];

// The list's filters (21 Oct 2026: "location wise and catogerry and section
// wise bhi fliter kar saken"). Rack is the text before the first "-" of the
// location, as the store reads it; the server lists the values with counts.
const NO_FILTERS = { section_id: "", rack: "", category: "", sub_category: "" };

export default function PartMaster() {
  const storeCategories = useStoreCategories();
  // Part Master is one screen shared by both stores, reached from each store's
  // own menu. Without this scope it listed all 739 parts whichever store the
  // sidebar was on — the same class of bug PartRepository.get_active()
  // documents ("turned Total Active Parts from 253 into 738").
  const { activeCode, activeStore } = useStores();
  const sections = activeStore?.sections || [];
  const sectionName = (id) => sections.find((s) => s.id === id)?.name || "";

  // The top bar's search lands here for every store but Child Parts, so the
  // keyword it carried has to actually filter the list — otherwise picking a
  // part out of the dropdown dropped you on all 481 of them.
  const [searchParams] = useSearchParams();
  const urlKeyword = searchParams.get("keyword") || "";

  const confirm = useConfirm();
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState(urlKeyword);
  const [missing, setMissing] = useState("");
  const [filters, setFilters] = useState(NO_FILTERS);
  const [filterOpts, setFilterOpts] = useState(null);
  // The photo being looked at (a part row), and the part a new photo is for.
  const [viewing, setViewing] = useState(null);
  const [photoBusy, setPhotoBusy] = useState(null);
  const photoInput = useRef(null);
  const fileInput = useRef(null);
  const photoFor = useRef(null);
  // A camera shot being checked before Save: { part, file }.
  const [capture, setCapture] = useState(null);
  const canEdit = useCan("part_master", "update");     // E: edit a part, its photo
  const canCreate = useCan("part_master", "create");   // C: Add Part
  const [counts, setCounts] = useState(null);
  const [page, setPage] = useState(1);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [suppliers, setSuppliers] = useState([]);
  // {id, field} of the cell being typed into — Max and Rate only.
  const [editCell, setEditCell] = useState(null);
  const [editValue, setEditValue] = useState("");
  // Barcode label printing (Spare Parts store only).
  const [labelConfig, setLabelConfig] = useState(null);

  useEffect(() => {
    barcodeService.labelConfig().then((res) => setLabelConfig(res.data.data)).catch(() => {});
  }, []);

  // Only the suppliers this store's parts are linked to. The supplier master
  // is the Child Part store's list, and offering its 26 vendors on a spare
  // ("ye supplier to h hi nhi part store k" — the store, 21 Oct 2026) invited
  // linking a spare to a vendor that never supplies it.
  useEffect(() => {
    if (!activeCode) return;
    supplierService.list({ per_page: 500, store_code: activeCode })
      .then((res) => setSuppliers(res.data.data)).catch(() => setSuppliers([]));
  }, [activeCode]);

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

  const load = async (p = page, kw = keyword, miss = missing, f = filters) => {
    if (!activeCode) return;
    setLoading(true);
    try {
      const res = await partService.list({
        page: p, per_page: 10,
        keyword: kw || undefined,
        store_code: activeCode,
        missing: miss || undefined,
        section_id: f.section_id || undefined,
        rack: f.rack || undefined,
        category: f.category || undefined,
        sub_category: f.sub_category || undefined,
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
    load(1, keyword, missing, filters);
    loadCounts();
    setPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyword, missing, activeCode, filters]);

  // A store switch starts the filters afresh — another store has other racks.
  useEffect(() => { setFilters(NO_FILTERS); }, [activeCode]);

  // The racks / categories offered follow the section picked, so a rack that
  // exists only in another section is never offered.
  useEffect(() => {
    if (!activeCode) return;
    partService.filterOptions({ store_code: activeCode, section_id: filters.section_id || undefined })
      .then((res) => setFilterOpts(res.data.data))
      .catch(() => setFilterOpts(null));
  }, [activeCode, filters.section_id]);

  const setFilter = (key, value) =>
    setFilters((f) => ({ ...f, [key]: value, ...(key === "section_id" ? { rack: "" } : {}) }));
  const anyFilter = Object.values(filters).some(Boolean);

  // ---- the part's photo ----
  // The camera straight away by default (📷 is one tap, 21 Oct 2026), its shot
  // checked before Save — Retake / + Another angle (components/PhotoCapture.jsx,
  // 23 Oct 2026); the photo viewer also offers a saved picture from the
  // gallery / a file, saved as picked.
  const pickPhoto = (row, fromFile = false) => {
    photoFor.current = row;
    const input = fromFile ? fileInput.current : photoInput.current;
    if (input) {
      input.value = "";
      input.click();
    }
  };
  const patchRow = (part) => {
    setRows((prev) => prev.map((r) => (r.id === part.id ? { ...r, image_file: part.image_file } : r)));
    setViewing((v) => (v && v.id === part.id ? { ...v, image_file: part.image_file } : v));
  };
  const pickedPhoto = (file, check) => {
    const row = photoFor.current;
    if (!file || !row) return;
    if (!file.type.startsWith("image/")) {
      toast.error("Choose a photo (JPG / PNG)");
      return;
    }
    if (check) setCapture({ part: row, file });
    else uploadPhoto(row, file);
  };
  const uploadPhoto = async (row, file) => {
    setPhotoBusy(row.id);
    try {
      const res = await partService.uploadImage(row.id, await shrinkPhoto(file));
      patchRow(res.data.data);
      loadCounts();
      setCapture(null);
      toast.success(`Photo saved for ${row.part_no}`);
    } catch (_) {
      /* handled globally */
    } finally {
      setPhotoBusy(null);
    }
  };
  const removePhoto = async (row) => {
    if (!(await confirm({ title: "Remove photo", message: `Remove the photo of ${row.part_no}?`, confirmText: "Remove" }))) return;
    try {
      const res = await partService.removeImage(row.id);
      patchRow(res.data.data);
      loadCounts();
      toast.success("Photo removed");
    } catch (_) {
      /* handled globally */
    }
  };
  const photoCell = (r) => {
    const thumb = partService.imageUrl(r, true);
    if (photoBusy === r.id) {
      return <span className="block h-11 w-11 animate-pulse rounded-lg bg-slate-200 dark:bg-navy-700" aria-label="Saving photo" />;
    }
    if (thumb) {
      return (
        <button type="button" onClick={() => setViewing(r)} title="Open the photo"
          className="block h-11 w-11 overflow-hidden rounded-lg ring-1 ring-slate-200 hover:ring-2 hover:ring-toyotared dark:ring-navy-700">
          <img src={thumb} alt={`Photo of ${r.part_no}`} loading="lazy" className="h-full w-full object-cover" />
        </button>
      );
    }
    return canEdit ? (
      <button type="button" onClick={() => pickPhoto(r)} title="Take a photo of this part"
        className="flex h-11 w-11 items-center justify-center rounded-lg border border-dashed border-slate-300 text-slate-400
          hover:border-toyotared hover:text-toyotared dark:border-navy-600">
        <Camera size={18} aria-hidden="true" />
        <span className="sr-only">Add photo of {r.part_no}</span>
      </button>
    ) : (
      <span className="flex h-11 w-11 items-center justify-center text-slate-300 dark:text-slate-600" title="No photo yet">
        <ImageOff size={16} aria-hidden="true" />
      </span>
    );
  };

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
      reorder_level: row.reorder_level ?? "",
      max_stock_level: row.max_stock_level ?? "",
      is_active: row.is_active,
      discontinued: Boolean(row.discontinued),
      category: row.category ?? "",
      sub_category: row.sub_category ?? "",
      specification: row.specification ?? "",
      model_no: row.model_no ?? "",
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
      reorder_level: form.reorder_level === "" ? null : Number(form.reorder_level),
      max_stock_level: form.max_stock_level === "" ? null : Number(form.max_stock_level),
      category: form.category || null,
      sub_category: form.sub_category.trim() === "" ? null : form.sub_category.trim(),
      specification: form.specification.trim() === "" ? null : form.specification.trim(),
      model_no: form.model_no.trim() === "" ? null : form.model_no.trim(),
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
      load(page, keyword, missing, filters);
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
      <Can
        mod="part_master"
        edit
        fallback={
          <span className={`px-1.5 py-0.5 ${unset ? "text-amber-600 dark:text-amber-400" : ""}`}>
            {unset ? "—" : format(value)}
          </span>
        }
      >
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
      </Can>
    );
  };

  const handleDelete = async (row) => {
    if (!(await confirm({ title: "Delete part", message: `Delete part ${row.part_no}?`, confirmText: "Delete" }))) return;
    await partService.remove(row.id);
    toast.success("Part deleted");
    load(page, keyword, missing, filters);
    loadCounts();
  };

  // Scoped to the store on screen: the export is the input to the import, so
  // a spares keeper filling in maximums gets their 485 rows, not all 739.
  const handleExport = () =>
    downloadFile(
      "/parts/export",
      `part_master_${(activeCode || "all").toLowerCase()}.xlsx`,
      activeCode ? { store_code: activeCode } : undefined,
    );

  const columns = [
    { key: "photo", label: "Photo", exportValue: (r) => (r.image_file ? "Yes" : ""), render: photoCell },
    { key: "part_no", label: "Part No" },
    { key: "part_name", label: "Part Name" },
    { key: "specification", label: "Specification", render: (r) => r.specification || "—" },
    { key: "model_no", label: "Model No", render: (r) => r.model_no || <span className="text-slate-300 dark:text-slate-600">—</span> },
    { key: "uom", label: "UOM" },
    { key: "barcode", label: "Barcode", render: (r) => r.barcode || <span className="text-slate-300 dark:text-slate-600">—</span> },
    // Section, not Category, beside the sub category: every spare is filed under
    // the one category "Maintenance/Tool Room", while the section (Maintenance /
    // General / Press Tool Room) tells parts apart (the store, 22 Oct 2026).
    // Category stays in the Columns menu, hidden.
    {
      key: "section", label: "Section", exportValue: (r) => sectionName(r.section_id),
      render: (r) => sectionName(r.section_id) || <span className="text-slate-300 dark:text-slate-600">—</span>,
    },
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
            <Repeat2 size={12} aria-hidden="true" /> {r.rework_location}
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
    {
      key: "is_active", label: "Status",
      exportValue: (r) => [r.is_active ? "Active" : "Inactive", r.discontinued && "Discontinued"].filter(Boolean).join(" · "),
      render: (r) => (
        <span className="inline-flex flex-wrap gap-1">
          <Badge status={r.is_active ? "Active" : "Inactive"} />
          {r.discontinued && <Badge status="Discontinued" />}
        </span>
      ),
    },
    {
      key: "actions",
      label: "Actions",
      render: (r) => (
        <div className="flex gap-2">
          <Can mod="part_master" edit>
            <button onClick={() => openEdit(r)} className="text-navy-700 dark:text-slate-300 hover:text-toyotared">
              <Pencil size={16} />
            </button>
          </Can>
          <Can mod="part_master" action="delete">
            <button onClick={() => handleDelete(r)} className="text-rose-500 hover:text-rose-700">
              <Trash2 size={16} />
            </button>
          </Can>
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
            placeholder="Search part no, description, spec or supplier…"
            aria-label="Search by part no, old or new part no, description, specification or supplier — any part of it"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
        </div>
        {/* No Excel upload here since 21 Oct 2026 ("store stock m h to part
            master me kya jarurat h" — the store): the physical count goes in on
            Store Stock, and a part is added / changed with Add Part / Edit.
            Add is a part_master mutation, hidden from a view-only user. */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Rack-by-rack photos on a tablet (21 Oct 2026). */}
          <Link to="/part-photos" className="btn-secondary">
            <Camera size={16} aria-hidden="true" /> Photo Mode
          </Link>
          {/* The Line / Machine / Die list the issue and install screens pick
              from: no menu item of its own since 23 Oct 2026 ("ye module hta de
              iski kya jarurat h"); a wrong name is still put right from here. */}
          <Link to="/equipment" className="btn-secondary">
            <Factory size={16} aria-hidden="true" /> Line / Machine / Die
          </Link>
          <ExcelActions
            addLabel="Add Part"
            canEdit={canCreate}
            onAddNew={openCreate}
            onExport={handleExport}
          />
        </div>
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

      {/* Section, rack (from the location), category and sub category —
          each list is the store's own values with their part counts. */}
      <div className="flex flex-wrap items-end gap-2">
        {sections.length > 1 && (
          <label className="text-xs font-medium text-slate-500">
            <span className="mb-1 block">Section</span>
            <select className="input-field py-1.5 text-sm w-44" value={filters.section_id}
              onChange={(e) => setFilter("section_id", e.target.value)}>
              <option value="">All sections</option>
              {sections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
        )}
        <label className="text-xs font-medium text-slate-500">
          <span className="mb-1 block">Rack</span>
          <select className="input-field py-1.5 text-sm w-44" value={filters.rack}
            onChange={(e) => setFilter("rack", e.target.value)}>
            <option value="">All racks</option>
            {(filterOpts?.racks || []).map((r) => <option key={r.value} value={r.value}>{r.value} ({r.count})</option>)}
          </select>
        </label>
        {(filterOpts?.categories || []).length > 1 && (
          <label className="text-xs font-medium text-slate-500">
            <span className="mb-1 block">Category</span>
            <select className="input-field py-1.5 text-sm w-48" value={filters.category}
              onChange={(e) => setFilter("category", e.target.value)}>
              <option value="">All categories</option>
              {filterOpts.categories.map((c) => <option key={c.value} value={c.value}>{c.value} ({c.count})</option>)}
            </select>
          </label>
        )}
        <label className="text-xs font-medium text-slate-500">
          <span className="mb-1 block">Sub Category</span>
          {/* 470-odd values: typed to narrow, picked from the list. */}
          <input className="input-field py-1.5 text-sm w-52" list="pm-sub-categories" placeholder="All — type to pick"
            value={filters.sub_category} onChange={(e) => setFilter("sub_category", e.target.value)} />
          <datalist id="pm-sub-categories">
            {(filterOpts?.sub_categories || []).map((c) => <option key={c.value} value={c.value}>{`${c.count} parts`}</option>)}
          </datalist>
        </label>
        {anyFilter && (
          <button type="button" onClick={() => setFilters(NO_FILTERS)}
            className="mb-1 inline-flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-toyotared">
            <X size={13} aria-hidden="true" /> Clear filters
          </button>
        )}
      </div>

      <div className="card">
        <Table columns={columns} rows={rows} loading={loading} columnToggle defaultHidden={["category"]} />
        <Pagination meta={meta} onPageChange={(p) => { setPage(p); load(p, keyword, missing, filters); }} />
      </div>

      {/* One pair of pickers for every row. `capture` opens a phone / tablet
          camera straight away; a laptop shows its file picker for both. */}
      <input ref={photoInput} type="file" accept="image/*" capture="environment" className="hidden"
        onChange={(e) => pickedPhoto(e.target.files?.[0], true)} />
      <input ref={fileInput} type="file" accept="image/*" className="hidden"
        onChange={(e) => pickedPhoto(e.target.files?.[0], false)} />
      {capture && (
        <PhotoCapture part={capture.part} first={capture.file}
          onSave={(file) => uploadPhoto(capture.part, file)} onClose={() => setCapture(null)} />
      )}

      <Modal open={Boolean(viewing)} onClose={() => setViewing(null)} size="xl"
        title={viewing ? `${viewing.part_no} — ${viewing.part_name}` : "Photo"}
        footer={viewing && canEdit ? (
          <>
            <button type="button" className="btn-danger" onClick={() => removePhoto(viewing)}>Remove photo</button>
            <button type="button" className="btn-secondary" onClick={() => pickPhoto(viewing, true)}>
              <ImagePlus size={15} aria-hidden="true" /> From gallery / file
            </button>
            <button type="button" className="btn-primary" onClick={() => pickPhoto(viewing)}>
              <Camera size={15} aria-hidden="true" /> Take new photo
            </button>
          </>
        ) : null}>
        {viewing && partService.imageUrl(viewing) && (
          <img src={partService.imageUrl(viewing)} alt={`Photo of ${viewing.part_no}`}
            className="mx-auto max-h-[70vh] w-auto rounded-lg" />
        )}
        {viewing && !viewing.image_file && <p className="text-sm text-slate-400">No photo.</p>}
      </Modal>

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
          {/* The two the Part Master list shows beside the name. */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-slate-500">Specification</label>
              <input
                className="input-field mt-1"
                maxLength={255}
                value={form.specification}
                onChange={(e) => setForm({ ...form, specification: e.target.value })}
              />
            </div>
            <div>
              <label className="text-xs font-medium text-slate-500">Model No</label>
              <input
                className="input-field mt-1"
                maxLength={60}
                value={form.model_no}
                placeholder="e.g. XVC1B3HK"
                onChange={(e) => setForm({ ...form, model_no: e.target.value })}
              />
            </div>
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
          {/* Shown only where the store has suppliers of its own (or the part
              already has one) — the Spare Parts Store has none in the master. */}
          {(suppliers.length > 0 || form.supplier_id !== "") && (
            <div>
              <label className="text-xs font-medium text-slate-500">Supplier</label>
              <select
                className="input-field mt-1"
                value={form.supplier_id}
                onChange={(e) => setForm({ ...form, supplier_id: e.target.value })}
              >
                <option value="">— None —</option>
                {form.supplier_id !== "" && !suppliers.some((x) => String(x.id) === String(form.supplier_id)) && (
                  <option value={form.supplier_id}>Current supplier</option>
                )}
                {suppliers.map((s) => <option key={s.id} value={s.id}>{s.vendor_code} — {s.supplier_name}</option>)}
              </select>
            </div>
          )}
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
          <div className="grid grid-cols-3 gap-3">
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
              <label className="text-xs font-medium text-slate-500">Reorder Level</label>
              <input
                type="number" step="0.01"
                className="input-field mt-1"
                value={form.reorder_level}
                placeholder="Order at"
                onChange={(e) => setForm({ ...form, reorder_level: e.target.value })}
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
          {/* Not required any more (22 Oct 2026): the part and its stock stay
              listed; it is never short, never on a reorder list or mail, and no
              min / max is asked of it. */}
          <label className="flex items-start gap-2 rounded-lg border border-slate-200 px-3 py-2 dark:border-navy-700">
            <input type="checkbox" className="mt-0.5" checked={form.discontinued}
              onChange={(e) => setForm({ ...form, discontinued: e.target.checked })} />
            <span>
              <span className="block text-sm font-medium text-slate-700 dark:text-slate-200">Discontinued — not required any more</span>
              <span className="block text-[11px] text-slate-400">Stays in the lists with its stock, but is never short, never reordered and needs no Min / Max.</span>
            </span>
          </label>
        </form>
      </Modal>

    </div>
  );
}
