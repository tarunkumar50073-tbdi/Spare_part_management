import React, { useEffect, useRef, useState } from "react";
import { Loader2, Phone, UserCheck, UserPlus, UserX, X } from "lucide-react";
import { useCan } from "./Can.jsx";
import { departmentService } from "../services/departmentService.js";
import { employeeService, normaliseMobile } from "../services/employeeService.js";

// "Who is taking the part?" by mobile number. The operator types the number;
// a person on the Employee master fills in by themselves (name, code,
// department). A number not on the master opens a short "add this person"
// entry right here, so the issue never waits on a separate screen. The
// parent gets onChange({ employee, mobile }) — employee null until one is
// picked. An inactive person is shown but not selectable.
const INPUT = "input-field";

function PersonCard({ emp, onClear, disabled }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-emerald-200 bg-emerald-50/70 px-3 py-2.5 dark:border-emerald-500/30 dark:bg-emerald-500/10">
      <UserCheck size={18} className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
      <div className="min-w-0 flex-1 text-sm">
        <div className="font-semibold text-slate-800 dark:text-white">{emp.name}</div>
        <div className="text-xs text-slate-600 dark:text-slate-300">
          {[emp.employee_code && `Code ${emp.employee_code}`, emp.department, emp.designation, emp.company]
            .filter(Boolean).join(" · ") || "No code / department recorded"}
        </div>
        <div className="text-[11px] text-slate-400 tabular">+91 {emp.mobile}</div>
      </div>
      {!disabled && (
        <button type="button" className="rounded p-1 text-slate-400 hover:text-slate-600" onClick={onClear}
          aria-label="Change the person" title="Change the person">
          <X size={16} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

export default function EmployeeLookup({ value, onChange, defaultDepartment, disabled = false, label = "Mobile number of the person taking the part" }) {
  // Both hooks always run (a short-circuit would change the hook order).
  const canScan = useCan("scan_part", "edit");
  const canMaster = useCan("employees", "edit");
  const canAdd = canScan || canMaster;
  const [typed, setTyped] = useState(value?.mobile || "");
  const [state, setState] = useState({ status: value?.employee ? "found" : "idle", result: null });
  const [depts, setDepts] = useState([]);
  const [draft, setDraft] = useState({ name: "", employee_code: "", department: defaultDepartment || "", designation: "", company: "" });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const seq = useRef(0);
  const emp = value?.employee || null;

  // Look the number up as soon as it is a valid 10-digit mobile.
  useEffect(() => {
    const mobile = normaliseMobile(typed);
    if (!mobile || (emp && emp.mobile === mobile)) return undefined;
    const my = ++seq.current;
    setState({ status: "loading", result: null });
    const t = setTimeout(async () => {
      try {
        const res = await employeeService.lookup(mobile, { silent: true });
        if (my !== seq.current) return;
        const data = res.data.data;
        if (data.found && data.active) {
          setState({ status: "found", result: data });
          onChange?.({ employee: data.employee, mobile });
        } else if (data.found) {
          setState({ status: "inactive", result: data });
          onChange?.({ employee: null, mobile });
        } else {
          setState({ status: "missing", result: data });
          onChange?.({ employee: null, mobile });
        }
      } catch (e) {
        if (my !== seq.current) return;
        setState({ status: "error", result: e?.response?.data?.message || "Could not look the number up" });
      }
    }, 250);
    return () => clearTimeout(t);
    // onChange is a callback from the parent form; the lookup depends on the number only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typed]);

  useEffect(() => {
    if (state.status !== "missing" || depts.length) return;
    departmentService.list(true).then((r) => setDepts(r.data.data || [])).catch(() => setDepts([]));
  }, [state.status, depts.length]);

  useEffect(() => {
    if (defaultDepartment && !draft.department) setDraft((d) => ({ ...d, department: defaultDepartment }));
  }, [defaultDepartment, draft.department]);

  const clear = () => {
    seq.current += 1;
    setTyped("");
    setState({ status: "idle", result: null });
    setErr(null);
    onChange?.({ employee: null, mobile: null });
  };

  const addPerson = async () => {
    const mobile = normaliseMobile(typed);
    if (!draft.name.trim()) { setErr("Name is required"); return; }
    if (!draft.department) { setErr("Department is required"); return; }
    setSaving(true);
    setErr(null);
    try {
      const res = await employeeService.create({
        mobile, name: draft.name.trim(), employee_code: draft.employee_code.trim() || null,
        department: draft.department, designation: draft.designation.trim() || null,
        company: draft.company.trim() || null,
      });
      setState({ status: "found", result: { found: true, employee: res.data.data } });
      onChange?.({ employee: res.data.data, mobile });
    } catch (e) {
      setErr(e?.response?.data?.message || "Could not add the person");
    } finally {
      setSaving(false);
    }
  };

  if (emp) return <PersonCard emp={emp} onClear={clear} disabled={disabled} />;

  const digits = typed.replace(/\D/g, "");
  const invalid = digits.length >= 10 && !normaliseMobile(typed);

  return (
    <div className="space-y-2">
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">{label} *</span>
        <div className="relative">
          <Phone size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden="true" />
          <input
            type="tel" inputMode="numeric" autoComplete="off" maxLength={16} disabled={disabled}
            className={`${INPUT} !pl-9 tabular`} placeholder="10-digit mobile no."
            value={typed} onChange={(e) => setTyped(e.target.value)} aria-invalid={invalid || undefined}
          />
          {state.status === "loading" && (
            <Loader2 size={15} className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-slate-400" aria-hidden="true" />
          )}
        </div>
      </label>
      {invalid && <p className="text-xs text-rose-600">Not a valid 10-digit mobile number.</p>}
      {state.status === "error" && <p className="text-xs text-rose-600">{state.result}</p>}
      {state.status === "inactive" && (
        <p className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          <UserX size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
          {state.result?.employee?.name} is marked inactive in the Employee Master — an administrator must
          reactivate them before a part can be issued to them.
        </p>
      )}
      {state.status === "missing" && (
        canAdd ? (
          <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-navy-700 dark:bg-navy-800/50">
            <div className="flex items-center gap-2 text-xs font-semibold text-slate-700 dark:text-slate-200">
              <UserPlus size={15} aria-hidden="true" /> No one on the Employee Master has +91 {state.result?.mobile} — add them
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <input className={INPUT} placeholder="Name *" value={draft.name} maxLength={80}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })} aria-label="Name" />
              <input className={INPUT} placeholder="Employee code" value={draft.employee_code} maxLength={30}
                onChange={(e) => setDraft({ ...draft, employee_code: e.target.value })} aria-label="Employee code" />
              <select className={INPUT} value={draft.department} aria-label="Department"
                onChange={(e) => setDraft({ ...draft, department: e.target.value })}>
                <option value="">Department *</option>
                {depts.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
              </select>
              <input className={INPUT} placeholder="Designation" value={draft.designation} maxLength={60}
                onChange={(e) => setDraft({ ...draft, designation: e.target.value })} aria-label="Designation" />
              <input className={`${INPUT} sm:col-span-2`} placeholder="Company / contractor (if not TBDI)" value={draft.company} maxLength={80}
                onChange={(e) => setDraft({ ...draft, company: e.target.value })} aria-label="Company" />
            </div>
            {err && <p className="text-xs text-rose-600">{err}</p>}
            <div className="flex justify-end">
              <button type="button" className="btn-primary" onClick={addPerson} disabled={saving}>
                {saving ? "Saving…" : "Add person & use"}
              </button>
            </div>
          </div>
        ) : (
          <p className="text-xs text-slate-500">
            +91 {state.result?.mobile} is not on the Employee Master — ask a supervisor to add them.
          </p>
        )
      )}
    </div>
  );
}
