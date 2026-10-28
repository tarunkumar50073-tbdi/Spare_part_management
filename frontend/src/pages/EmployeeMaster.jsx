import React, { useMemo, useState } from "react";
import toast from "react-hot-toast";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Pencil, RefreshCw, Users } from "lucide-react";
import Table from "../components/Table.jsx";
import Modal from "../components/Modal.jsx";
import { useCan } from "../components/Can.jsx";
import { departmentService } from "../services/departmentService.js";
import { employeeService } from "../services/employeeService.js";
import { fmtStamp } from "../lib/format.js";
import { ShiftBadge } from "../components/PersonPicker.jsx";

// Employee Master — the people spare parts are issued to. Since 27 Oct 2026
// they come from the Maintenance and Tool Room rosters (their own apps, read
// only): a new person is added there and shows here by himself, someone
// removed there turns inactive here — "user k employee detail tool room and
// maintenance k db me h wahan se leni h" (the store). No mobile number — "meri
// app me hta de mobile number wala". This screen shows who is on the list and
// on duty today; it is where past issues still find their person. A person
// added here by hand earlier (no roster) can only be edited or switched off.
const FILTERS = [{ key: "active", label: "Active" }, { key: "inactive", label: "Inactive" }, { key: "all", label: "All" }];
const FROM = { MAINTENANCE: "Maintenance roster", TOOL_ROOM: "Tool Room roster" };

function EditDialog({ initial, departments, onClose, onSaved }) {
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });

  const save = async () => {
    if (!form.name.trim()) { setErr("Name is required"); return; }
    if (!form.department) { setErr("Department is required"); return; }
    setSaving(true);
    setErr(null);
    const payload = {
      name: form.name.trim(), employee_code: form.employee_code?.trim() || null, department: form.department,
      designation: form.designation?.trim() || null, company: form.company?.trim() || null, is_active: form.is_active,
    };
    try {
      await employeeService.update(initial.id, payload);
      toast.success(`${payload.name} updated`);
      onSaved();
    } catch (e) {
      setErr(e?.response?.data?.message || "Could not save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={`Edit — ${initial.name}`}
      footer={(
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="btn-primary" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
        </>
      )}>
      <p className="mb-3 text-xs text-slate-500">Added here by hand, not from a roster. People from the rosters are changed in the Maintenance / Tool Room app.</p>
      <div className="grid gap-3 sm:grid-cols-2">
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
        <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200 sm:col-span-2">
          <input type="checkbox" checked={!!form.is_active} onChange={set("is_active")} />
          Active — can be issued parts (switch off instead of deleting; past issues keep the name)
        </label>
      </div>
      {err && <p className="mt-3 text-sm text-rose-600">{err}</p>}
    </Modal>
  );
}

export default function EmployeeMaster() {
  const qc = useQueryClient();
  const canEdit = useCan("employees", "update");
  const [filter, setFilter] = useState("active");
  const [editing, setEditing] = useState(null);
  const [reading, setReading] = useState(false);

  // Reading today's duty also brings the master in line with the rosters, so
  // the list is asked for after it.
  const duty = useQuery({
    queryKey: ["employees", "on-duty"],
    queryFn: () => employeeService.onDuty({}, { silent: true }).then((r) => r.data.data),
    staleTime: 60_000,
    // An open page keeps up too (the store, 28 Oct 2026: "employee master
    // autoupdate hota rhe"); the server reads the rosters by itself as well.
    refetchInterval: 60_000,
  });
  const list = useQuery({
    queryKey: ["employees", filter],
    queryFn: () => employeeService.list({ active: filter === "all" ? "all" : filter === "active" ? 1 : 0 })
      .then((r) => r.data.data),
    enabled: duty.isFetched,
    refetchInterval: 60_000,
  });
  const depts = useQuery({
    queryKey: ["departments", "active"],
    queryFn: () => departmentService.list(true).then((r) => r.data.data),
    staleTime: 5 * 60_000,
    enabled: Boolean(editing),
  });
  const shiftOf = useMemo(() => new Map((duty.data?.rows || []).map((r) => [r.id, r.shift])), [duty.data]);

  const readNow = async () => {
    setReading(true);
    try {
      await employeeService.onDuty({ refresh: true });
      await qc.invalidateQueries({ queryKey: ["employees"] });
      toast.success("Rosters read again");
    } catch { /* interceptor toasts */ } finally {
      setReading(false);
    }
  };

  const columns = useMemo(() => [
    { key: "name", label: "Name", sortable: true,
      render: (r) => <span className="font-medium text-slate-800 dark:text-white">{r.name}</span> },
    { key: "employee_code", label: "Code", sortable: true, render: (r) => r.employee_code || "—" },
    { key: "department", label: "Department", sortable: true, render: (r) => r.department || "—" },
    { key: "designation", label: "Designation", render: (r) => r.designation || "—" },
    { key: "source", label: "From", sortable: true, exportValue: (r) => FROM[r.source] || "Added here",
      render: (r) => <span className={`text-xs ${r.source ? "text-slate-600 dark:text-slate-300" : "text-amber-700"}`}>{FROM[r.source] || "Added here (no roster)"}</span> },
    { key: "_shift", label: "Today", exportValue: (r) => shiftOf.get(r.id) || "",
      render: (r) => (shiftOf.get(r.id) ? <ShiftBadge shift={shiftOf.get(r.id)} /> : <span className="text-xs text-slate-400">Off duty</span>) },
    { key: "is_active", label: "Status", sortable: true, exportValue: (r) => (r.is_active ? "Active" : "Inactive"),
      render: (r) => <span className={`badge ${r.is_active ? "badge-success" : "badge-neutral"}`}>{r.is_active ? "Active" : "Inactive"}</span> },
    { key: "updated_at", label: "Last changed", sortable: true, exportValue: (r) => r.updated_at,
      render: (r) => <span className="text-xs text-slate-500">{fmtStamp(r.updated_at)}{r.updated_by ? ` · ${r.updated_by}` : ""}</span> },
    ...(canEdit ? [{ key: "_edit", label: "", render: (r) => (!r.source && (
      <button type="button" className="rounded p-1 text-slate-400 hover:text-toyotared" aria-label={`Edit ${r.name}`}
        onClick={(e) => { e.stopPropagation(); setEditing(r); }}>
        <Pencil size={15} aria-hidden="true" />
      </button>
    )) }] : []),
  ], [canEdit, shiftOf]);

  const rosters = duty.data?.rosters || [];
  const failed = rosters.filter((x) => !x.ok);
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="section-title flex items-center gap-2"><Users size={20} aria-hidden="true" /> Employee Master</h1>
          <p className="section-hint">
            The people spare parts are issued to — from the Maintenance and Tool Room rosters. Add, change or remove a person
            in the Maintenance / Tool Room app; he shows here by himself. At the counter he is picked by code or name.
          </p>
          {duty.data?.read_at && (
            <p className="mt-1 text-[11px] text-slate-400">
              Updates by itself{duty.data.poll_seconds ? ` every ${Math.round(duty.data.poll_seconds / 60)} min` : ""}
              {" · "}last read {fmtStamp(duty.data.read_at)}
            </p>
          )}
        </div>
        <button type="button" className="btn-secondary" onClick={readNow} disabled={reading}>
          <RefreshCw size={16} className={reading ? "animate-spin" : ""} aria-hidden="true" /> {reading ? "Reading…" : "Read rosters now"}
        </button>
      </div>

      {rosters.length > 0 && (
        <div className="flex flex-wrap gap-2 text-xs">
          {rosters.map((x) => (
            <span key={x.source} className={`rounded-full px-3 py-1 font-semibold ${x.ok ? "bg-slate-100 text-slate-700 dark:bg-navy-800 dark:text-slate-200" : "bg-rose-100 text-rose-700"}`}>
              {x.department}: {x.ok ? `${x.on_duty} on duty today of ${x.people}${x.marked ? "" : " (attendance not marked yet)"}` : "roster not reachable"}
            </span>
          ))}
        </div>
      )}
      {failed.length > 0 && (
        <p className="flex items-start gap-2 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
          <AlertTriangle size={14} className="mt-px shrink-0" aria-hidden="true" />
          {failed.map((x) => `${x.department}: ${x.error}`).join(" · ")} — the people already here stay; their shift is not known.
        </p>
      )}

      <div className="card p-4">
        <Table
          columns={columns}
          rows={list.data || []}
          loading={list.isLoading || duty.isLoading}
          searchable="Search name or code…"
          exportName="employee_master"
          pageSize={50}
          onRowClick={canEdit ? (r) => (!r.source ? setEditing(r) : undefined) : undefined}
          emptyMessage={filter === "active" ? "No one yet — the rosters are read when this screen opens." : "No one here."}
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
      </div>

      {editing && (
        <EditDialog initial={editing} departments={depts.data || []}
          onClose={() => setEditing(null)} onSaved={() => { setEditing(null); qc.invalidateQueries({ queryKey: ["employees"] }); }} />
      )}
    </div>
  );
}
