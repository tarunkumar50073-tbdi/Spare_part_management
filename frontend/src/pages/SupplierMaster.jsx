import React, { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { Pencil, Trash2, Search } from "lucide-react";
import Table from "../components/Table.jsx";
import Badge from "../components/Badge.jsx";
import Modal from "../components/Modal.jsx";
import Pagination from "../components/Pagination.jsx";
import ExcelActions from "../components/ExcelActions.jsx";
import UploadReportModal from "../components/UploadReportModal.jsx";
import { supplierService } from "../services/supplierService.js";
import { downloadFile } from "../utils/download.js";

const EMPTY_FORM = { vendor_code: "", supplier_name: "", status: "Active" };

export default function SupplierMaster() {
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState("");
  const [page, setPage] = useState(1);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [uploadReport, setUploadReport] = useState(null);

  const load = async (p = page, kw = keyword) => {
    setLoading(true);
    try {
      const res = await supplierService.list({ page: p, per_page: 10, keyword: kw || undefined });
      setRows(res.data.data);
      setMeta(res.data.meta);
    } catch (_) {
      /* handled globally */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load(1, keyword);
    setPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyword]);

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setModalOpen(true);
  };

  const openEdit = (row) => {
    setEditing(row);
    setForm({ vendor_code: row.vendor_code, supplier_name: row.supplier_name, status: row.status });
    setModalOpen(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      if (editing) {
        await supplierService.update(editing.id, { supplier_name: form.supplier_name, status: form.status });
        toast.success("Supplier updated");
      } else {
        await supplierService.create(form);
        toast.success("Supplier created");
      }
      setModalOpen(false);
      load(page, keyword);
    } catch (_) {
      /* error toast handled globally */
    }
  };

  const handleDelete = async (row) => {
    if (!window.confirm(`Delete supplier ${row.supplier_name}?`)) return;
    await supplierService.remove(row.id);
    toast.success("Supplier deleted");
    load(page, keyword);
  };

  const handleUpload = async (file) => {
    try {
      const res = await supplierService.import(file);
      setUploadReport(res.data.data);
      load(page, keyword);
    } catch (_) {
      /* handled globally */
    }
  };

  const handleDownloadTemplate = () => downloadFile("/suppliers/template", "supplier_master_template.xlsx");
  const handleExport = () => downloadFile("/suppliers/export", "supplier_master_export.xlsx");

  const columns = [
    { key: "vendor_code", label: "Vendor Code" },
    { key: "supplier_name", label: "Supplier Name" },
    { key: "status", label: "Status", render: (r) => <Badge status={r.status} /> },
    {
      key: "actions",
      label: "Actions",
      render: (r) => (
        <div className="flex gap-2">
          <button onClick={() => openEdit(r)} className="text-navy-700 dark:text-slate-300 hover:text-toyotared">
            <Pencil size={16} />
          </button>
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
            placeholder="Search vendor code or name..."
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
        </div>
        <ExcelActions
          addLabel="Add Supplier"
          onAddNew={openCreate}
          onUpload={handleUpload}
          onDownloadTemplate={handleDownloadTemplate}
          onExport={handleExport}
        />
      </div>

      <div className="card">
        <Table columns={columns} rows={rows} loading={loading} />
        <Pagination meta={meta} onPageChange={(p) => { setPage(p); load(p, keyword); }} />
      </div>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? "Edit Supplier" : "Add Supplier"}
        footer={
          <>
            <button className="btn-secondary" onClick={() => setModalOpen(false)}>Cancel</button>
            <button className="btn-primary" onClick={handleSubmit}>{editing ? "Update" : "Create"}</button>
          </>
        }
      >
        <form className="space-y-3" onSubmit={handleSubmit}>
          <div>
            <label className="text-xs font-medium text-slate-500">Vendor Code</label>
            <input
              className="input-field mt-1"
              value={form.vendor_code}
              disabled={!!editing}
              onChange={(e) => setForm({ ...form, vendor_code: e.target.value })}
              required
            />
          </div>
          <div>
            <label className="text-xs font-medium text-slate-500">Supplier Name</label>
            <input
              className="input-field mt-1"
              value={form.supplier_name}
              onChange={(e) => setForm({ ...form, supplier_name: e.target.value })}
              required
            />
          </div>
          <div>
            <label className="text-xs font-medium text-slate-500">Status</label>
            <select
              className="input-field mt-1"
              value={form.status}
              onChange={(e) => setForm({ ...form, status: e.target.value })}
            >
              <option>Active</option>
              <option>Inactive</option>
            </select>
          </div>
        </form>
      </Modal>

      <UploadReportModal report={uploadReport} onClose={() => setUploadReport(null)} />
    </div>
  );
}
