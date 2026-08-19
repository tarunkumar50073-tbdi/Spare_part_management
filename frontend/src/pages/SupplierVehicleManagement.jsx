import React, { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { Plus, Pencil, Trash2, Truck, Clock, FileSpreadsheet, Mail } from "lucide-react";
import Table from "../components/Table.jsx";
import Badge from "../components/Badge.jsx";
import Modal from "../components/Modal.jsx";
import { supplierVehicleService } from "../services/supplierVehicleService.js";
import { supplierWindowScheduleService } from "../services/supplierWindowScheduleService.js";
import { supplierService } from "../services/supplierService.js";
import { milkrunGroupService } from "../services/milkrunGroupService.js";

const FREQUENCIES = ["Daily", "Alternate Day", "Weekly"];

const EMPTY_VEHICLE_FORM = {
  vendor_code: "", vehicle_no: "", expected_date: "", window_start_time: "", window_end_time: "", notes: "",
};

const EMPTY_SCHEDULE_FORM = {
  vendor_code: "", window_start: "", window_end: "", frequency: "Daily",
  effective_from: "", status: "Active",
};

function fmt(dt) {
  return dt ? new Date(dt).toLocaleString() : "—";
}

// Vehicle windows carry a full datetime; schedule slots carry a bare time —
// hence the two formatters.
function fmtDateTimeAsTime(dt) {
  return dt ? new Date(dt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";
}

function fmtTime(t) {
  return t ? t.slice(0, 5) : "—";
}

export default function SupplierVehicleManagement() {
  const [vehicles, setVehicles] = useState([]);
  const [schedules, setSchedules] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [milkrunGroups, setMilkrunGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [emailing, setEmailing] = useState(false);

  const [vehicleModalOpen, setVehicleModalOpen] = useState(false);
  const [editingVehicle, setEditingVehicle] = useState(null);
  const [vehicleForm, setVehicleForm] = useState(EMPTY_VEHICLE_FORM);

  const [scheduleModalOpen, setScheduleModalOpen] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState(null);
  const [scheduleForm, setScheduleForm] = useState(EMPTY_SCHEDULE_FORM);

  const load = async () => {
    setLoading(true);
    try {
      const [veh, sched] = await Promise.all([
        supplierVehicleService.list(),
        supplierWindowScheduleService.list(),
      ]);
      setVehicles(veh.data.data);
      setSchedules(sched.data.data);
    } catch (_) {
      /* handled globally */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    supplierService.list({ per_page: 500, vehicle_tracking: true }).then((res) => setSuppliers(res.data.data)).catch(() => {});
    milkrunGroupService.list().then((res) => setMilkrunGroups(res.data.data)).catch(() => {});
  }, []);

  // vendor_code -> milkrun group name, for the schedule table's "Milkrun Group"
  // column — grouped suppliers share one vehicle, so this ties their rows
  // together visually.
  const vendorToMilkrun = {};
  milkrunGroups.forEach((g) => {
    g.suppliers.forEach((s) => { vendorToMilkrun[s.vendor_code] = g.group_name; });
  });

  // A vehicle counts as having a window if it carries its own decided window
  // OR its supplier has a standing slot to be judged against; everything else
  // is a genuine ad-hoc arrival with no benchmark. Inactive slots still count
  // — the supplier appears in the schedule table above either way, so calling
  // its vehicles "without window time" would contradict what's on screen.
  const scheduledVendors = new Set(schedules.map((s) => s.vendor_code));
  const hasWindowTime = (v) => v.has_window || scheduledVendors.has(v.vendor_code);
  const scheduledVehicles = vehicles.filter(hasWindowTime);
  const adhocVehicles = vehicles.filter((v) => !hasWindowTime(v));

  // ---- Vehicle entry CRUD ----

  const openVehicleCreate = () => {
    setEditingVehicle(null);
    setVehicleForm(EMPTY_VEHICLE_FORM);
    setVehicleModalOpen(true);
  };

  const openVehicleEdit = (row) => {
    setEditingVehicle(row);
    setVehicleForm({
      vendor_code: row.vendor_code,
      vehicle_no: row.vehicle_no,
      expected_date: row.expected_date,
      window_start_time: row.window_start ? row.window_start.slice(11, 16) : "",
      window_end_time: row.window_end ? row.window_end.slice(11, 16) : "",
      notes: row.notes || "",
    });
    setVehicleModalOpen(true);
  };

  const handleVehicleSubmit = async (e) => {
    e.preventDefault();
    // A decided window needs a date to hang the times on — an ad-hoc vehicle
    // with no date is logged with no window.
    const hasWindow = vehicleForm.window_start_time && vehicleForm.window_end_time && vehicleForm.expected_date;
    const payload = {
      vendor_code: vehicleForm.vendor_code,
      vehicle_no: vehicleForm.vehicle_no.trim() === "" ? null : vehicleForm.vehicle_no.trim(),
      expected_date: vehicleForm.expected_date === "" ? null : vehicleForm.expected_date,
      window_start: hasWindow ? `${vehicleForm.expected_date}T${vehicleForm.window_start_time}:00` : null,
      window_end: hasWindow ? `${vehicleForm.expected_date}T${vehicleForm.window_end_time}:00` : null,
      notes: vehicleForm.notes.trim() === "" ? null : vehicleForm.notes.trim(),
    };
    try {
      if (editingVehicle) {
        const { vendor_code, ...updatable } = payload;
        await supplierVehicleService.update(editingVehicle.id, updatable);
        toast.success("Vehicle window updated");
      } else {
        await supplierVehicleService.create(payload);
        toast.success("Vehicle window created");
      }
      setVehicleModalOpen(false);
      load();
    } catch (_) {
      /* error toast handled globally */
    }
  };

  const handleVehicleDelete = async (row) => {
    if (!window.confirm(`Delete vehicle window for ${row.vehicle_no}?`)) return;
    await supplierVehicleService.remove(row.id);
    toast.success("Vehicle window deleted");
    load();
  };

  // ---- Standing window slot CRUD ----

  const emailWindowTime = async () => {
    setEmailing(true);
    try {
      const res = await supplierWindowScheduleService.emailReport();
      const { status, reason, to = [], cc = [] } = res.data.data;
      if (status === "sent") {
        toast.success(`Emailed to ${to.join(", ")}${cc.length ? ` (cc ${cc.join(", ")})` : ""}`);
      } else {
        const why = {
          smtp_not_configured: "SMTP not set up yet",
          no_recipient_email: "no To address in Report Recipients",
          report_build_failed: "report build failed",
          send_failed: "mail server rejected it",
        }[reason] || reason;
        toast(`Not sent: ${why}`, { icon: "⚠️" });
      }
    } catch {
      /* api interceptor already toasts */
    } finally {
      setEmailing(false);
    }
  };

  const openScheduleCreate = () => {
    setEditingSchedule(null);
    setScheduleForm(EMPTY_SCHEDULE_FORM);
    setScheduleModalOpen(true);
  };

  const openScheduleEdit = (row) => {
    setEditingSchedule(row);
    setScheduleForm({
      vendor_code: row.vendor_code,
      window_start: fmtTime(row.window_start),
      window_end: fmtTime(row.window_end),
      frequency: row.frequency,
      effective_from: row.effective_from,
      status: row.status,
    });
    setScheduleModalOpen(true);
  };

  const handleScheduleSubmit = async (e) => {
    e.preventDefault();
    const payload = {
      vendor_code: scheduleForm.vendor_code,
      window_start: `${scheduleForm.window_start}:00`,
      window_end: `${scheduleForm.window_end}:00`,
      frequency: scheduleForm.frequency,
      effective_from: scheduleForm.effective_from,
      status: scheduleForm.status,
    };
    try {
      if (editingSchedule) {
        const { vendor_code, ...updatable } = payload;
        await supplierWindowScheduleService.update(editingSchedule.id, updatable);
        toast.success("Window schedule updated");
      } else {
        await supplierWindowScheduleService.create(payload);
        toast.success("Window schedule created");
      }
      setScheduleModalOpen(false);
      load();
    } catch (_) {
      /* error toast handled globally */
    }
  };

  const handleScheduleDelete = async (row) => {
    if (!window.confirm(`Delete this window slot for ${row.supplier_name}?`)) return;
    await supplierWindowScheduleService.remove(row.id);
    toast.success("Window schedule deleted");
    load();
  };

  const actionsColumn = (onEdit, onDelete) => ({
    key: "actions", label: "Actions",
    render: (r) => (
      <div className="flex gap-2">
        <button onClick={() => onEdit(r)} className="text-navy-700 dark:text-slate-300 hover:text-toyotared">
          <Pencil size={16} />
        </button>
        <button onClick={() => onDelete(r)} className="text-rose-500 hover:text-rose-700">
          <Trash2 size={16} />
        </button>
      </div>
    ),
  });

  const scheduleColumns = [
    { key: "vendor_code", label: "Vendor", render: (r) => `${r.vendor_code} — ${r.supplier_name || "?"}` },
    {
      key: "milkrun", label: "Milkrun Group",
      render: (r) => vendorToMilkrun[r.vendor_code]
        ? <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-400"><Truck size={11} />{vendorToMilkrun[r.vendor_code]}</span>
        : <span className="text-slate-400 text-xs">—</span>,
    },
    { key: "window", label: "Window Time", render: (r) => `${fmtTime(r.window_start)} - ${fmtTime(r.window_end)}` },
    { key: "frequency", label: "Frequency" },
    { key: "effective_from", label: "Effective From" },
    { key: "status", label: "Status", render: (r) => <Badge status={r.status === "Active" ? "Active" : "Inactive"} /> },
    actionsColumn(openScheduleEdit, handleScheduleDelete),
  ];

  const vehicleColumns = [
    { key: "vendor_code", label: "Vendor", render: (r) => `${r.vendor_code} — ${r.supplier_name || "?"}` },
    { key: "vehicle_no", label: "Vehicle No" },
    { key: "expected_date", label: "Expected Date" },
    {
      key: "window", label: "Decided Window",
      render: (r) => (r.has_window ? `${fmtDateTimeAsTime(r.window_start)} - ${fmtDateTimeAsTime(r.window_end)}` : <span className="text-slate-400 italic">No window decided</span>),
    },
    { key: "actual_arrival", label: "Actual Arrival", render: (r) => fmt(r.actual_arrival) },
    { key: "status", label: "Status", render: (r) => <Badge status={r.status} /> },
    { key: "notes", label: "Notes", render: (r) => r.notes || "—" },
    actionsColumn(openVehicleEdit, handleVehicleDelete),
  ];

  return (
    <div className="space-y-4">
      <h2 className="font-semibold text-slate-800 dark:text-white flex items-center gap-2">
        <Truck size={18} className="text-toyotared" /> Supplier Vehicle Management
      </h2>
      <p className="text-xs text-slate-400 -mt-2">
        Standing window slots and one-off vehicle arrivals in one place, split by whether the supplier has a decided
        window time. Actual arrival always comes from ERP's gate entry — status is computed automatically.
      </p>

      {milkrunGroups.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {milkrunGroups.map((g) => (
            <div key={g.id} className="card">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-8 h-8 rounded-lg bg-blue-100 text-blue-600 dark:bg-blue-500/15 dark:text-blue-400 flex items-center justify-center shrink-0">
                  <Truck size={16} />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-slate-800 dark:text-white">{g.group_name}</p>
                  <p className="text-[11px] text-slate-400">
                    1 vehicle · {g.supplier_count} suppliers · {fmtTime(g.window_start)}-{fmtTime(g.window_end)}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {g.suppliers.map((s) => (
                  <span key={s.vendor_code} className="text-[11px] px-2 py-0.5 rounded-full bg-slate-100 dark:bg-navy-800 text-slate-600 dark:text-slate-300">
                    {s.supplier_name || s.vendor_code}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="card border-l-4 border-emerald-500">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-1">
          <h3 className="font-semibold text-slate-800 dark:text-white flex items-center gap-2">
            <Clock size={16} className="text-emerald-600" /> With Window Time
            {!loading && <span className="text-xs font-normal text-slate-400">({schedules.length} slot{schedules.length === 1 ? "" : "s"})</span>}
          </h3>
          <div className="flex items-center gap-2">
            <a
              className="btn-secondary"
              href="/api/v1/supplier-window-schedules/window-time-report"
              download
              title="Auto-filled 'VEHICLE WINDOW TIME' sheet for this month — colour-coded On-Time / Late / Not Come, ready to mail"
            >
              <FileSpreadsheet size={16} /> Window-Time Excel
            </a>
            <button
              className="btn-secondary"
              onClick={emailWindowTime}
              disabled={emailing}
              title="E-mail this month's window-time sheet to the report recipients now"
            >
              <Mail size={16} /> {emailing ? "Sending…" : "Email now"}
            </button>
            <button className="btn-primary" onClick={openScheduleCreate}>
              <Plus size={16} /> Add Window Slot
            </button>
          </div>
        </div>
        <p className="text-[11px] text-slate-400 mb-3">
          Standard recurring delivery slot per supplier (Daily / Alternate Day / Weekly) — a fixed schedule, not tied to
          any specific vehicle or date. A supplier can have more than one slot a day. This is the reference window
          on-time/late is judged against.
        </p>
        <Table columns={scheduleColumns} rows={schedules} loading={loading} emptyMessage="No window slots defined yet" />

        {scheduledVehicles.length > 0 && (
          <>
            <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mt-5 mb-1">
              One-off vehicles for these suppliers
            </h4>
            <p className="text-[11px] text-slate-400 mb-3">
              Individual vehicle entries that either carry their own decided window or belong to a supplier scheduled above.
            </p>
            <Table columns={vehicleColumns} rows={scheduledVehicles} loading={loading} emptyMessage="None" />
          </>
        )}
      </div>

      <div className="card border-l-4 border-amber-500">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-1">
          <h3 className="font-semibold text-slate-800 dark:text-white flex items-center gap-2">
            <Truck size={16} className="text-amber-600" /> Without Window Time
            {!loading && <span className="text-xs font-normal text-slate-400">({adhocVehicles.length} vehicle{adhocVehicles.length === 1 ? "" : "s"})</span>}
          </h3>
          <button className="btn-primary" onClick={openVehicleCreate}>
            <Plus size={16} /> Add Vehicle
          </button>
        </div>
        <p className="text-[11px] text-slate-400 mb-3">
          Suppliers with no standing slot and no decided window — these arrivals are logged and matched to ERP gate
          entries, but not scored On-Time/Late since there's no benchmark to judge them against.
        </p>
        <Table columns={vehicleColumns} rows={adhocVehicles} loading={loading} emptyMessage="No ad-hoc vehicles logged" />
      </div>

      <Modal
        open={scheduleModalOpen}
        onClose={() => setScheduleModalOpen(false)}
        title={editingSchedule ? "Edit Window Slot" : "Add Window Slot"}
        footer={
          <>
            <button className="btn-secondary" onClick={() => setScheduleModalOpen(false)}>Cancel</button>
            <button className="btn-primary" onClick={handleScheduleSubmit}>{editingSchedule ? "Update" : "Create"}</button>
          </>
        }
      >
        <form className="space-y-3" onSubmit={handleScheduleSubmit}>
          <div>
            <label className="text-xs font-medium text-slate-500">Supplier</label>
            <select
              className="input-field mt-1"
              value={scheduleForm.vendor_code}
              disabled={!!editingSchedule}
              onChange={(e) => setScheduleForm({ ...scheduleForm, vendor_code: e.target.value })}
              required
            >
              <option value="">— Select —</option>
              {suppliers.map((s) => <option key={s.id} value={s.vendor_code}>{s.vendor_code} — {s.supplier_name}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-slate-500">Window Start</label>
              <input
                type="time"
                className="input-field mt-1"
                value={scheduleForm.window_start}
                onChange={(e) => setScheduleForm({ ...scheduleForm, window_start: e.target.value })}
                required
              />
            </div>
            <div>
              <label className="text-xs font-medium text-slate-500">Window End</label>
              <input
                type="time"
                className="input-field mt-1"
                value={scheduleForm.window_end}
                onChange={(e) => setScheduleForm({ ...scheduleForm, window_end: e.target.value })}
                required
              />
            </div>
          </div>
          <p className="text-[11px] text-slate-400 -mt-2">Window End before Window Start is fine — it means the slot crosses midnight.</p>
          <div>
            <label className="text-xs font-medium text-slate-500">Frequency</label>
            <select
              className="input-field mt-1"
              value={scheduleForm.frequency}
              onChange={(e) => setScheduleForm({ ...scheduleForm, frequency: e.target.value })}
              required
            >
              {FREQUENCIES.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-slate-500">Effective From</label>
            <input
              type="date"
              className="input-field mt-1"
              value={scheduleForm.effective_from}
              onChange={(e) => setScheduleForm({ ...scheduleForm, effective_from: e.target.value })}
              required
            />
          </div>
          <div>
            <label className="text-xs font-medium text-slate-500">Status</label>
            <select
              className="input-field mt-1"
              value={scheduleForm.status}
              onChange={(e) => setScheduleForm({ ...scheduleForm, status: e.target.value })}
              required
            >
              <option value="Active">Active</option>
              <option value="Inactive">Inactive</option>
            </select>
          </div>
        </form>
      </Modal>

      <Modal
        open={vehicleModalOpen}
        onClose={() => setVehicleModalOpen(false)}
        title={editingVehicle ? "Edit Vehicle Window" : "Add Vehicle Window"}
        footer={
          <>
            <button className="btn-secondary" onClick={() => setVehicleModalOpen(false)}>Cancel</button>
            <button className="btn-primary" onClick={handleVehicleSubmit}>{editingVehicle ? "Update" : "Create"}</button>
          </>
        }
      >
        <form className="space-y-3" onSubmit={handleVehicleSubmit}>
          <div>
            <label className="text-xs font-medium text-slate-500">Supplier</label>
            <select
              className="input-field mt-1"
              value={vehicleForm.vendor_code}
              disabled={!!editingVehicle}
              onChange={(e) => setVehicleForm({ ...vehicleForm, vendor_code: e.target.value })}
              required
            >
              <option value="">— Select —</option>
              {suppliers.map((s) => <option key={s.id} value={s.vendor_code}>{s.vendor_code} — {s.supplier_name}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-slate-500">Vehicle No <span className="text-slate-400">(optional)</span></label>
            <input
              className="input-field mt-1"
              placeholder="Leave blank if the supplier has no fixed vehicle"
              value={vehicleForm.vehicle_no}
              onChange={(e) => setVehicleForm({ ...vehicleForm, vehicle_no: e.target.value })}
            />
          </div>
          <div>
            <label className="text-xs font-medium text-slate-500">Expected Date <span className="text-slate-400">(optional)</span></label>
            <input
              type="date"
              className="input-field mt-1"
              value={vehicleForm.expected_date}
              onChange={(e) => setVehicleForm({ ...vehicleForm, expected_date: e.target.value })}
            />
            <p className="text-[11px] text-slate-400 mt-1">Blank = today (for an ad-hoc vehicle logged now).</p>
          </div>
          <div>
            <label className="text-xs font-medium text-slate-500">Decided Window (optional)</label>
            <p className="text-[11px] text-slate-400 mb-1">Leave both blank for an ad-hoc vehicle with no fixed time — it'll just be logged, not scored On-Time/Late.</p>
            <div className="grid grid-cols-2 gap-3">
              <input
                type="time"
                className="input-field"
                placeholder="Start"
                value={vehicleForm.window_start_time}
                onChange={(e) => setVehicleForm({ ...vehicleForm, window_start_time: e.target.value })}
              />
              <input
                type="time"
                className="input-field"
                placeholder="End"
                value={vehicleForm.window_end_time}
                onChange={(e) => setVehicleForm({ ...vehicleForm, window_end_time: e.target.value })}
              />
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-slate-500">Notes</label>
            <input
              className="input-field mt-1"
              value={vehicleForm.notes}
              onChange={(e) => setVehicleForm({ ...vehicleForm, notes: e.target.value })}
            />
          </div>
        </form>
      </Modal>
    </div>
  );
}
