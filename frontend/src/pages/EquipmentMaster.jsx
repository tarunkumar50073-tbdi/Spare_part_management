import React, { useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Factory, FileDown, FileUp, Pencil, Plus, Wand2 } from "lucide-react";
import Table from "../components/Table.jsx";
import Modal from "../components/Modal.jsx";
import { useCan } from "../components/Can.jsx";
import { equipmentService, EQUIPMENT_KINDS } from "../services/equipmentService.js";
import { downloadXlsx } from "../utils/excel.js";
import { fmtStamp } from "../lib/format.js";

// Line / Machine / Die Master — the pick-lists the install screen uses to record
// where a part went. One screen, three tabs (Lines / Machines / Dies). Add,
// edit, switch off (never delete — past installations keep the name), load from
// Excel, or seed the whole thing from the values already on past installations.
const TEMPLATE_HEADERS = ["Kind (LINE/MACHINE/DIE)", "Name", "Code"];
const FILTERS = [{ key: "active", label: "Active" }, { key: "inactive", label: "Inactive" }, { key: "all", label: "All" }];
const label = (k) => EQUIPMENT_KINDS.find((x) => x.key === k)?.label || k;

function EditDialog({ open, initial, kind, onClose, onSaved }) {
  const isNew = !initial?.id;
  const [form, setForm] = useState(initial || { kind, name: "", code: "", is_active: true });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });

  const save = async () => {
    if (!form.name.trim()) { setErr("Name is required"); return; }
    setSaving(true);
    setErr(null);
    const payload = { kind: form.kind, name: form.name.trim(), code: form.code?.trim() || null };
    try {
      if (isNew) await equipmentService.create(payload);
      else await equipmentService.update(initial.id, { ...payload, is_active: form.is_active });
      toast.success(isNew ? `${payload.name} added` : `${payload.name} updated`);
      onSaved();
    } catch (e) {
      setErr(e?.response?.data?.message || "Could not save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={isNew ? `Add ${label(form.kind).toLowerCase()}` : `Edit — ${initial.name}`}
      footer={(
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="btn-primary" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
        </>
      )}>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">Type *
          <select className="input-field mt-1" value={form.kind} onChange={set("kind")} disabled={!isNew}>
            {EQUIPMENT_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
          </select>
        </label>
        <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
          {form.kind === "LINE" ? "Line name *" : "Name *"}
          <input className="input-field mt-1" value={form.name} onChange={set("name")} maxLength={80} />
        </label>
        <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 sm:col-span-2">
          {form.kind === "LINE" ? "Line no. (fills the Line no. box on the install screen)" : "Code (optional)"}
          <input className="input-field mt-1" value={form.code || ""} onChange={set("code")} maxLength={40}
            placeholder={form.kind === "LINE" ? "L-03" : "Optional"} />
        </label>
        {!isNew && (
          <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200 sm:col-span-2">
            <input type="checkbox" checked={!!form.is_active} onChange={set("is_active")} />
            Active — appears in the install dropdown (switch off instead of deleting; history keeps the name)
          </label>
        )}
      </div>
      {err && <p className="mt-3 text-sm text-rose-600">{err}</p>}
    </Modal>
  );
}

export default function EquipmentMaster() {
  const qc = useQueryClient();
  // The Line / Machine / Die master is the Part Master right's (23 Oct 2026).
  const canEdit = useCan("part_master", "edit");
  const [kind, setKind] = useState("LINE");
  const [filter, setFilter] = useState("active");
  const [editing, setEditing] = useState(null);
  const [importing, setImporting] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [report, setReport] = useState(null);
  const fileRef = useRef(null);

  const list = useQuery({
    queryKey: ["equipment", kind, filter],
    queryFn: () => equipmentService.list({
      kind, active: filter === "all" ? "all" : filter === "active" ? 1 : 0,
    }).then((r) => r.data.data),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["equipment"] });

  const columns = useMemo(() => [
    { key: "name", label: kind === "LINE" ? "Line name" : "Name", sortable: true,
      render: (r) => <span className="font-medium text-slate-800 dark:text-white">{r.name}</span> },
    { key: "code", label: kind === "LINE" ? "Line no." : "Code", sortable: true, render: (r) => r.code || "—" },
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
  ], [canEdit, kind]);

  const onImport = async (file) => {
    if (!file) return;
    setImporting(true);
    setReport(null);
    try {
      const res = await equipmentService.import(file);
      setReport(res.data.data);
      toast.success(`${res.data.data.created} row(s) imported`);
      refresh();
    } catch { /* interceptor toasts */ } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const onSeed = async () => {
    setSeeding(true);
    try {
      const res = await equipmentService.seed();
      const a = res.data.data || {};
      const total = (a.LINE || 0) + (a.MACHINE || 0) + (a.DIE || 0);
      toast.success(total
        ? `Seeded ${a.LINE || 0} line(s), ${a.MACHINE || 0} machine(s), ${a.DIE || 0} die(s)`
        : "Already up to date — nothing new to add");
      refresh();
    } catch { /* interceptor toasts */ } finally {
      setSeeding(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="section-title flex items-center gap-2"><Factory size={20} aria-hidden="true" /> Line / Machine / Die Master</h1>
          <p className="section-hint">
            The pick-lists the install screen uses to record where a part went. Picking a line fills both the line name and
            its number; a value not on the list can still be typed on the floor and added here.
          </p>
        </div>
        {canEdit && (
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-secondary" onClick={onSeed} disabled={seeding}>
              <Wand2 size={16} aria-hidden="true" /> {seeding ? "Seeding…" : "Seed from installations"}
            </button>
            <button type="button" className="btn-secondary" onClick={() => downloadXlsx("line_machine_die_template.xlsx", TEMPLATE_HEADERS, [])}>
              <FileDown size={16} aria-hidden="true" /> Template
            </button>
            <button type="button" className="btn-secondary" onClick={() => fileRef.current?.click()} disabled={importing}>
              <FileUp size={16} aria-hidden="true" /> {importing ? "Importing…" : "Import Excel"}
            </button>
            <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden"
              onChange={(e) => onImport(e.target.files?.[0])} />
            <button type="button" className="btn-primary" onClick={() => setEditing({ kind, name: "", code: "", is_active: true })}>
              <Plus size={16} aria-hidden="true" /> Add {label(kind).toLowerCase()}
            </button>
          </div>
        )}
      </div>

      <div className="flex gap-1" role="tablist" aria-label="Kind">
        {EQUIPMENT_KINDS.map((k) => (
          <button key={k.key} type="button" role="tab" aria-selected={kind === k.key} onClick={() => setKind(k.key)}
            className={`rounded-full px-4 py-1.5 text-sm font-semibold ${kind === k.key
              ? "bg-toyotared text-white" : "bg-slate-100 text-slate-600 dark:bg-navy-800 dark:text-slate-300"}`}>
            {k.plural}
          </button>
        ))}
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
          <p className="mt-2 text-xs text-slate-500">Each row needs a Kind (LINE / MACHINE / DIE) and a Name; a known one updates, a new one is added.</p>
        </div>
      )}

      <div className="card p-4">
        <Table
          columns={columns}
          rows={list.data || []}
          loading={list.isLoading}
          searchable="Search name or code…"
          exportName={`${kind.toLowerCase()}_master`}
          pageSize={50}
          onRowClick={canEdit ? (r) => setEditing(r) : undefined}
          emptyMessage={filter === "active"
            ? "Nothing here yet — add one, import a list, or click “Seed from installations”."
            : "None here."}
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
        <EditDialog open initial={editing.id ? editing : null} kind={editing.kind || kind}
          onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} />
      )}
    </div>
  );
}
