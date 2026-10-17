import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import toast from "react-hot-toast";
import { PackageSearch, MapPin, CheckCircle2, TriangleAlert, Send, RotateCcw, Package, ArrowLeft } from "lucide-react";
import PartSearch from "../../components/scan/PartSearch.jsx";
import EmployeeLookup from "../../components/EmployeeLookup.jsx";
import QtyStepper from "../../components/QtyStepper.jsx";
import { DepartmentSelect, Field } from "../../components/scan/forms/FormKit.jsx";
import { useDepartments } from "../../components/scan/forms/flow.js";
import { useStores } from "../../context/StoreContext.jsx";
import { partRequestService } from "../../services/partRequestService.js";
import { partBins } from "../../utils/binLocation.js";
import { num } from "../../lib/format.js";

// Kiosk (outside the locked store): a requester searches a part, identifies
// themselves from the Employee master, picks a quantity, and submits. The
// request lands on the supervisor's screen; the requester gets a reference no.
// Touchscreen-friendly: large targets, one simple flow, resets for the next
// person after each submit. It only CREATES a request — nothing is issued here.
// A part with a rework location shows both bins (Fresh / Rework).

const NO_PERSON = { employee: null, mobile: null, typed: "" };

export default function KioskRequest() {
  const { activeCode } = useStores();
  const storeCode = activeCode || "MAINTENANCE";
  const { data: depts } = useDepartments();
  const navigate = useNavigate();

  // Small corner link back to the app (for setup/admin). A real kiosk device runs
  // the browser in kiosk mode, where this is out of the requester's reach.
  const exitBtn = (
    <button type="button" onClick={() => navigate("/")}
      className="fixed left-4 top-4 z-20 inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white/80 px-3 py-1.5 text-xs font-medium text-slate-500 shadow-sm hover:text-slate-800 dark:border-navy-700 dark:bg-navy-900/70 dark:text-slate-300">
      <ArrowLeft size={14} aria-hidden="true" /> Exit
    </button>
  );

  const [part, setPart] = useState(null);
  const [person, setPerson] = useState(NO_PERSON);
  const [department, setDepartment] = useState("");
  const [autoDept, setAutoDept] = useState(null);
  const [qty, setQty] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [tried, setTried] = useState(false);
  const [done, setDone] = useState(null);     // the created request

  const emp = person.employee;
  const available = part ? part.qty_on_hand : null;
  const bins = part ? partBins(part.location, part.rework_location) : [];

  const reset = () => {
    setPart(null); setPerson(NO_PERSON); setDepartment(""); setAutoDept(null);
    setQty(1); setTried(false); setDone(null);
  };

  // Picking a person fills the department from their record (unless the user
  // already chose a different one) — same rule as the issue counter.
  const pickPerson = (next) => {
    setPerson(next);
    const dept = next.employee?.department;
    if (department && department !== autoDept) return;
    const fill = dept && (!depts || depts.some((d) => d.name === dept)) ? dept : "";
    setDepartment(fill);
    setAutoDept(fill || null);
  };

  const errors = {
    part: part ? null : "Search for a part first",
    person: emp ? null : "Select your name / ID from the Employee master",
    department: department ? null : "Choose the department",
    qty: Number(qty) > 0 ? null : "Quantity must be 1 or more",
  };
  const valid = !Object.values(errors).some(Boolean);
  const show = (k) => (tried ? errors[k] : null);

  const submit = async () => {
    setTried(true);
    if (!valid || submitting) return;
    setSubmitting(true);
    try {
      const res = await partRequestService.create(storeCode, {
        part_id: part.part_id,
        requested_qty: Number(qty),
        employee_id: emp.id,
        requester_mobile: emp.mobile,
        requester_name: emp.name,
        department,
      }).then((r) => r.data.data);
      setDone(res);
      toast.success(`Request ${res.reference_no} sent`);
    } catch {
      /* handled globally */
    } finally {
      setSubmitting(false);
    }
  };

  // ---- Success screen ----
  if (done) {
    const doneBins = partBins(done.assigned_location, done.rework_location);
    return (
      <div className="mx-auto max-w-lg px-2 py-6">
        {exitBtn}
        <div className="rounded-xl2 bg-emerald-50 p-6 text-center dark:bg-emerald-500/10">
          <CheckCircle2 className="mx-auto text-emerald-600 dark:text-emerald-400" size={56} aria-hidden="true" />
          <p className="mt-2 text-2xl font-extrabold text-emerald-700 dark:text-emerald-300">Request sent</p>
          <p className="mt-1 text-sm text-emerald-800 dark:text-emerald-200">Sent to the store supervisor — collect the part at the service window.</p>
          <div className="mt-4 overflow-hidden rounded-lg border border-emerald-200 bg-white text-left text-sm dark:border-emerald-500/30 dark:bg-navy-900/40">
            {[
              ["Reference No.", done.reference_no],
              ["Part No.", done.part_no],
              ["Description", done.part_name],
              ...(doneBins.length ? doneBins.map((b) => [b.label ? `${b.label} Location` : "Location", b.location])
                : [["Location", "—"]]),
              ["Requested Qty", num(done.requested_qty)],
              ["Requested by", `${done.requester_name || "—"}${done.requester_code ? ` (${done.requester_code})` : ""}`],
              ["Department", done.department || "—"],
              ["Status", done.status],
            ].map(([k, v]) => (
              <div key={k} className="flex items-center justify-between gap-3 border-b border-emerald-100 px-3 py-1.5 last:border-b-0 dark:border-emerald-500/20">
                <span className="text-slate-500 dark:text-slate-400">{k}</span>
                <span className="text-right font-semibold text-slate-800 dark:text-slate-100">{v}</span>
              </div>
            ))}
          </div>
          <button type="button" onClick={reset}
            className="btn-primary mt-5 inline-flex w-full items-center justify-center gap-2 !py-3 text-base">
            <RotateCcw size={18} aria-hidden="true" /> New Request
          </button>
        </div>
      </div>
    );
  }

  // ---- Request form ----
  return (
    <div className="mx-auto max-w-lg px-2 py-4">
      {exitBtn}
      <div className="mb-4 text-center">
        <h1 className="text-2xl font-extrabold text-slate-800 dark:text-white">Part Request</h1>
        <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">Choose a part, enter your name, pick a quantity and submit.</p>
      </div>

      <div className="space-y-4">
        {/* 1. Part */}
        <div className="card p-4">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">1 · Part</p>
          {!part ? (
            <>
              <PartSearch storeCode={storeCode} onPick={(p) => { setPart(p); return true; }}
                placeholder="Part No., name, spec or location…" label="Search part" />
              {show("part") && <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">{errors.part}</p>}
            </>
          ) : (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-navy-700 dark:bg-navy-800/50">
              <div className="flex items-start gap-2">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-toyotared/10 text-toyotared">
                  <Package size={20} aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-bold text-slate-800 dark:text-white">{part.part_no}</p>
                  <p className="text-sm text-slate-600 dark:text-slate-300">{part.part_name}</p>
                  {(bins.length ? bins.map((b) => `${b.label ? `${b.label}: ` : ""}${b.location}`) : ["No location set"]).map((line) => (
                    <p key={line} className="mt-1 flex items-center gap-1.5 text-sm text-slate-500 dark:text-slate-400">
                      <MapPin size={14} aria-hidden="true" /> {line}
                    </p>
                  ))}
                  {available == null ? (
                    <p className="mt-1 flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                      <TriangleAlert size={13} aria-hidden="true" /> Stock data not loaded — availability unknown
                    </p>
                  ) : (
                    <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Available: <b>{num(available)}</b>{part.uom ? ` ${part.uom}` : ""}</p>
                  )}
                </div>
                <button type="button" onClick={() => setPart(null)} className="btn-secondary !py-1 text-[11px]">Change</button>
              </div>
            </div>
          )}
        </div>

        {/* 2. Requester */}
        <div className="card p-4">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">2 · Who is requesting</p>
          <EmployeeLookup value={person} onChange={pickPerson} defaultDepartment={department || undefined}
            error={show("person")} />
          <div className="mt-3">
            <Field label="Department" required error={show("department")}>
              <DepartmentSelect value={department} onChange={setDepartment} error={show("department")} />
            </Field>
          </div>
        </div>

        {/* 3. Quantity */}
        <div className="card p-4">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">3 · Quantity</p>
          <QtyStepper value={qty} onChange={setQty} min={1} max={99999} size="lg" label="Requested quantity" />
          {show("qty") && <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">{errors.qty}</p>}
        </div>

        <button type="button" onClick={submit} disabled={submitting}
          className="btn-primary inline-flex w-full items-center justify-center gap-2 !py-3 text-base disabled:opacity-60">
          <Send size={18} aria-hidden="true" /> {submitting ? "Submitting…" : "Submit Request"}
        </button>
      </div>
    </div>
  );
}
