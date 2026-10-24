import React, { useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileDown, FileUp, Pencil, Phone, UserPlus, Users } from "lucide-react";
import Table from "../components/Table.jsx";
import Modal from "../components/Modal.jsx";
import { useCan } from "../components/Can.jsx";
import { departmentService } from "../services/departmentService.js";
import { employeeService, normaliseMobile } from "../services/employeeService.js";
import { downloadXlsx } from "../utils/excel.js";
import { fmtStamp } from "../lib/format.js";

// Employee Master — the people spare parts are issued to. At the counter the
// operator types only a mobile number and the rest (name, code, department)
// comes from here; a number not on the list is added right there. This screen
// keeps the list correct: add, edit, switch off (never delete — past issues
// point at the person), and load it from Excel.
const TEMPLATE_HEADERS = ["Mobile No", "Name", "Employee Code", "Department", "Designation", "Company"];
const EMPTY = { mobile: "", name: "", employee_code: "", department: "", designation: "", company: "", is_active: true };
const FILTERS = [{ key: "active", label: "Active" }, { key: "inactive", label: "Inactive" }, { key: "all", label: "All" }];

function EditDialog({ open, initial, departments, onClose, onSaved }) {
  const [form, setForm] = useState(initial || EMPTY);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const isNew = !initial?.id;
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });

  const save = async () => {
    if (!normaliseMobile(form.mobile)) { setErr("Enter a valid 10-digit mobile number"); return; }
    if (!form.name.trim()) { setErr("Name is required"); return; }
    if (!form.department) { setErr("Department is required"); return; }
    setSaving(true);
    setErr(null);
    const payload = {
      mobile: form.mobile, name: form.name.trim(), employee_code: form.employee_code?.trim() || null,
      department: form.department, designation: form.designation?.trim() || null,
      company: form.company?.trim() || null,
    };
    try {
      if (isNew) await employeeService.create(payload);
      else await employeeService.update(initial.id, { ...payload, is_active: form.is_active });
      toast.success(isNew ? `${payload.name} added` : `${payload.name} updated`);
      onSaved();
    } catch (e) {
      setErr(e?.response?.data?.message || "Could not save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={isNew ? "Add person" : `Edit — ${initial.name}`}
      footer={(
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="btn-primary" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
        </>
      )}>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">Mobile number *
          <input className="input-field mt-1 tabular" inputMode="numeric" value={form.mobile} onChange={set("mobile")} maxLength={16} />
        </label>
        <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">Name *
          <input className="input-field mt-1" value={form.name} onChange={set("name")} maxLength={80} />
        </label>
        <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">Employee code
          <input className="input-field mt-1" value={form.employee_code || ""} onChange={set("employee_code")} maxLength={30} />
        </label>
        <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">Department *
          <select className="input-field mt-1" value={form.department || ""} onChange={set("department")}>
            <option value="">Select…</option>
            {departments.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
          </select>
        </label>
        <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">Designation
          <input className="input-field mt-1" value={form.designation || ""} onChange={set("designation")} maxLength={60} />
        </label>
        <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">Company / contractor
          <input className="input-field mt-1" value={form.company || ""} onChange={set("company")} maxLength={80} />
        </label>
        {!isNew && (
          <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200 sm:col-span-2">
            <input type="checkbox" checked={!!form.is_active} onChange={set("is_active")} />
            Active — can be issued parts (switch off instead of deleting; past issues keep the name)
          </label>
        )}
      </div>
      {err && <p className="mt-3 text-sm text-rose-600">{err}</p>}
    </Modal>
  );
}

export default function EmployeeMaster() {
  const qc = useQueryClient();
  const canEdit = useCan("employees", "update");             // E: a row's edit
  const canCreate = useCan("employees", "create");           // C: add, seed
  const canImport = useCan("employees", ["create", "update"]); // an import adds and changes
  const [filter, setFilter] = useState("active");
  const [editing, setEditing] = useState(null);
  const [importing, setImporting] = useState(false);
  const [report, setReport] = useState(null);
  const fileRef = useRef(null);

  const list = useQuery({
    queryKey: ["employees", filter],
    queryFn: () => employeeService.list({ active: filter === "all" ? "all" : filter === "active" ? 1 : 0 })
      .then((r) => r.data.data),
  });
  const depts = useQuery({
    queryKey: ["departments", "active"],
    queryFn: () => departmentService.list(true).then((r) => r.data.data),
    staleTime: 5 * 60_000,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["employees"] });

  const columns = useMemo(() => [
    { key: "mobile", label: "Mobile", sortable: true, render: (r) => <span className="tabular">+91 {r.mobile}</span>,
      exportValue: (r) => r.mobile },
    { key: "name", label: "Name", sortable: true,
      render: (r) => <span className="font-medium text-slate-800 dark:text-white">{r.name}</span> },
    { key: "employee_code", label: "Code", sortable: true, render: (r) => r.employee_code || "—" },
    { key: "department", label: "Department", sortable: true, render: (r) => r.department || "—" },
    { key: "designation", label: "Designation", render: (r) => r.designation || "—" },
    { key: "company", label: "Company", render: (r) => r.company || "—" },
    { key: "is_active", label: "Status", sortable: true, exportValue: (r) => (r.is_active ? "Active" : "Inactive"),
      render: (r) => <span className={`badge ${r.is_active ? "badge-success" : "badge-neutral"}`}>{r.is_active ? "Active" : "Inactive"}</span> },
    { key: "updated_at", label: "Last changed", sortable: true, exportValue: (r) => r.updated_at,
      render: (r) => <span className="text-xs text-slate-500">{fmtStamp(r.updated_at)}{r.updated_by ? ` · ${r.updated_by}` : ""}</span> },
    ...(canEdit ? [{ key: "_edit", label: "", render: (r) => (
      <button type="button" className="rounded p-1 text-slate-400 hover:text-toyotared" aria-label={`Edit ${r.name}`}
        onClick={(e) => { e.stopPropagation(); setEditing(r); }}>
        <Pencil size={15} aria-hidden="true" />
      </button>
    ) }] : []),
  ], [canEdit]);

  const onImport = async (file) => {
    if (!file) return;
    setImporting(true);
    setReport(null);
    try {
      const res = await employeeService.import(file);
      setReport(res.data.data);
      toast.success(`${res.data.data.created} row(s) imported`);
      refresh();
    } catch { /* interceptor toasts */ } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="section-title flex items-center gap-2"><Users size={20} aria-hidden="true" /> Employee Master</h1>
          <p className="section-hint">
            The people spare parts are issued to. At the counter only the mobile number is typed — name, code and
            department fill in from here; a number not on the list can be added right there.
          </p>
        </div>
        {canCreate && (
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-secondary" onClick={() => downloadXlsx("employee_master_template.xlsx", TEMPLATE_HEADERS, [])}>
              <FileDown size={16} aria-hidden="true" /> Template
            </button>
            <button type="button" className="btn-secondary" onClick={() => fileRef.current?.click()} disabled={importing || !canImport}
              title={canImport ? undefined : "Importing needs both the Create and Edit rights"}>
              <FileUp size={16} aria-hidden="true" /> {importing ? "Importing…" : "Import Excel"}
            </button>
            <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden"
              onChange={(e) => onImport(e.target.files?.[0])} />
            <button type="button" className="btn-primary" onClick={() => setEditing({ ...EMPTY })}>
              <UserPlus size={16} aria-hidden="true" /> Add person
            </button>
          </div>
        )}
      </div>

      {report && (
        <div className="card p-4 text-sm">
          <div className="font-medium text-slate-800 dark:text-white">
            Import: {report.created} of {report.total_rows} row(s) added or updated
            {report.error_count ? ` · ${report.error_count} not imported` : ""}
          </div>
          {report.errors?.length > 0 && (
            <ul className="mt-2 max-h-40 list-disc overflow-auto pl-5 text-xs text-rose-600">
              {report.errors.map((e) => <li key={e.row}>Row {e.row}: {e.reason}</li>)}
            </ul>
          )}
          <p className="mt-2 text-xs text-slate-500">A known mobile number updates that person; a new one is added.</p>
        </div>
      )}

      <div className="card p-4">
        <Table
          columns={columns}
          rows={list.data || []}
          loading={list.isLoading}
          searchable="Search name, code or mobile…"
          exportName="employee_master"
          pageSize={50}
          onRowClick={canEdit ? (r) => setEditing(r) : undefined}
          emptyMessage={filter === "active" ? "No active people yet — add one, import the list, or add them from the issue counter." : "No one here."}
          toolbar={(
            <div className="flex gap-1" role="group" aria-label="Show">
              {FILTERS.map((f) => (
                <button key={f.key} type="button" onClick={() => setFilter(f.key)}
                  className={`rounded-full px-3 py-1 text-xs font-semibold ${filter === f.key
                    ? "bg-toyotared text-white" : "bg-slate-100 text-slate-600 dark:bg-navy-800 dark:text-slate-300"}`}>
                  {f.label}
                </button>
              ))}
            </div>
          )}
        />
        <p className="mt-3 flex items-center gap-1.5 text-xs text-slate-500">
          <Phone size={13} aria-hidden="true" /> The mobile number is the lookup key, so each number belongs to one person.
        </p>
      </div>

      {editing && (
        <EditDialog open initial={editing.id ? editing : null} departments={depts.data || []}
          onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} />
      )}
    </div>
  );
}
