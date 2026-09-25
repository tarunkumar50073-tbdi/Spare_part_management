import React, { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { Pencil, Trash2, Warehouse, Lock, Unlock } from "lucide-react";
import Table from "../components/Table.jsx";
import Badge from "../components/Badge.jsx";
import Modal from "../components/Modal.jsx";
import { useConfirm } from "../components/ConfirmDialog.jsx";
import ExcelActions from "../components/ExcelActions.jsx";
import UploadReportModal from "../components/UploadReportModal.jsx";
import { rackBinService } from "../services/rackBinService.js";
import { partService } from "../services/partService.js";
import { downloadFile } from "../utils/download.js";

const EMPTY_FORM = { location: "", rack_no: "", part_no: "", bin_capacity: "", bins_allocated: "" };

export default function RackBinMaster() {
  const confirm = useConfirm();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [parts, setParts] = useState([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [uploadReport, setUploadReport] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = await rackBinService.list();
      setRows(res.data.data);
    } catch (_) {
      /* handled globally */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    partService.list({ is_active: "true", per_page: 200 }).then((res) => setParts(res.data.data));
  }, []);

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setModalOpen(true);
  };

  const openEdit = (row) => {
    setEditing(row);
    setForm({
      location: row.location, rack_no: row.rack_no, part_no: row.part_no,
      bin_capacity: row.bin_capacity, bins_allocated: row.bins_allocated,
    });
    setModalOpen(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      if (editing) {
        await rackBinService.update(editing.id, {
          bin_capacity: Number(form.bin_capacity),
          bins_allocated: Number(form.bins_allocated) || 0,
        });
        toast.success("Rack/Bin entry updated");
      } else {
        await rackBinService.create({
          location: form.location,
          rack_no: form.rack_no,
          part_no: form.part_no,
          bin_capacity: Number(form.bin_capacity),
          bins_allocated: Number(form.bins_allocated) || 0,
        });
        toast.success("Rack/Bin entry created");
      }
      setModalOpen(false);
      load();
    } catch (_) {
      /* handled globally */
    }
  };

  const handleDelete = async (row) => {
    if (!(await confirm({ title: "Delete rack/bin", message: `Delete ${row.location}/${row.rack_no} — ${row.part_no}?`, confirmText: "Delete" }))) return;
    await rackBinService.remove(row.id);
    toast.success("Rack/Bin entry deleted");
    load();
  };

  const handleToggleBlock = async (row) => {
    await rackBinService.update(row.id, { is_blocked: !row.is_blocked });
    toast.success(row.is_blocked ? `${row.location}/${row.rack_no} unblocked` : `${row.location}/${row.rack_no} blocked`);
    load();
  };

  const handleUpload = async (file) => {
    try {
      const res = await rackBinService.import(file);
      setUploadReport(res.data.data);
      load();
    } catch (_) {
      /* handled globally */
    }
  };

  const handleDownloadTemplate = () => downloadFile("/rack-bins/template", "rack_bin_master_template.xlsx");
  const handleExport = () => downloadFile("/rack-bins/export", "rack_bin_master_export.xlsx");

  const columns = [
    { key: "location", label: "Location", sortable: true },
    { key: "rack_no", label: "Rack", sortable: true },
    { key: "part_no", label: "Part No", sortable: true },
    { key: "part_name", label: "Part Name", sortable: true },
    { key: "bin_capacity", label: "Bin Capacity", sortable: true, align: "right" },
    { key: "bins_allocated", label: "Bins Allocated", sortable: true, align: "right" },
    { key: "bins_occupied", label: "Occupied", sortable: true, align: "right" },
    { key: "available_bins", label: "Available", sortable: true, align: "right" },
    { key: "rack_status", label: "Occupancy", sortable: true, render: (r) => <Badge status={r.rack_status} /> },
    {
      key: "actions",
      label: "Actions",
      render: (r) => (
        <div className="flex gap-2">
          <button onClick={() => openEdit(r)} className="text-navy-700 dark:text-slate-300 hover:text-toyotared">
            <Pencil size={16} />
          </button>
          <button
            onClick={() => handleToggleBlock(r)}
            className={r.is_blocked ? "text-emerald-600 hover:text-emerald-700" : "text-amber-600 hover:text-amber-700"}
            title={r.is_blocked ? "Unblock rack" : "Block rack"}
          >
            {r.is_blocked ? <Unlock size={16} /> : <Lock size={16} />}
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
        <div>
          <h2 className="font-semibold text-slate-800 dark:text-white flex items-center gap-2">
            <Warehouse size={18} className="text-toyotared" /> Rack/Bin Master
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Occupied/Available/Occupancy reflect real-time rack fill — updated by Rack Allocation, Holding Area
            transfers, and production consumption.
          </p>
        </div>
        <ExcelActions
          addLabel="Add Rack/Bin Entry"
          onAddNew={openCreate}
          onUpload={handleUpload}
          onDownloadTemplate={handleDownloadTemplate}
          onExport={handleExport}
        />
      </div>

      <div className="card">
        <Table
          columns={columns}
          rows={rows}
          loading={loading}
          searchable="Search location, rack or part…"
          exportName="rack_bins"
          pageSize={25}
          emptyMessage="No rack/bin entries defined"
        />
      </div>

      <UploadReportModal report={uploadReport} onClose={() => setUploadReport(null)} />

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? "Edit Rack/Bin Entry" : "Add Rack/Bin Entry"}
        footer={
          <>
            <button className="btn-secondary" onClick={() => setModalOpen(false)}>Cancel</button>
            <button className="btn-primary" onClick={handleSubmit}>{editing ? "Update" : "Create"}</button>
          </>
        }
      >
        <form className="space-y-3" onSubmit={handleSubmit}>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-slate-500">Location</label>
              <input
                className="input-field mt-1"
                value={form.location}
                disabled={!!editing}
                onChange={(e) => setForm({ ...form, location: e.target.value })}
                placeholder="A1"
                required
              />
            </div>
            <div>
              <label className="text-xs font-medium text-slate-500">Rack No</label>
              <input
                className="input-field mt-1"
                value={form.rack_no}
                disabled={!!editing}
                onChange={(e) => setForm({ ...form, rack_no: e.target.value })}
                placeholder="R1"
                required
              />
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-slate-500">Part</label>
            <select
              className="input-field mt-1"
              value={form.part_no}
              disabled={!!editing}
              onChange={(e) => setForm({ ...form, part_no: e.target.value })}
              required
            >
              <option value="" disabled>Select part</option>
              {parts.map((p) => (
                <option key={p.part_no} value={p.part_no}>{p.part_no} — {p.part_name}</option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-slate-500">Bin Capacity</label>
              <input
                type="number" step="0.01"
                className="input-field mt-1"
                value={form.bin_capacity}
                onChange={(e) => setForm({ ...form, bin_capacity: e.target.value })}
                required
              />
            </div>
            <div>
              <label className="text-xs font-medium text-slate-500">Bins Allocated</label>
              <input
                type="number"
                className="input-field mt-1"
                value={form.bins_allocated}
                onChange={(e) => setForm({ ...form, bins_allocated: e.target.value })}
              />
            </div>
          </div>
        </form>
      </Modal>
    </div>
  );
}
