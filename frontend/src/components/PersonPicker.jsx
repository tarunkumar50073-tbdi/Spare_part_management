import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, RefreshCw, Search, UserCheck, X } from "lucide-react";
import { employeeService } from "../services/employeeService.js";

// "Who is taking the part?" — picked from today's Maintenance and Tool Room
// rosters by employee code or name (the store, 27 Oct 2026: "jab koi material
// lene aayega to hum uske code number ya naam se usme search karenge and wo
// select kar lenge"; "mobile number ki jarurat nhi"). Everyone on duty today is
// listed with his shift; a person not on the list is added in the Maintenance /
// Tool Room app, never here.
//
// The same contract as EmployeeLookup, which it replaced at the counter:
//   value        { employee, mobile, typed } — what onChange last gave the parent
//   onChange({ employee, mobile, typed })   employee = the picked person, else null
//   required, error, disabled, label
const INPUT = "input-field text-base"; // 16px: a tablet does not zoom into the box
const ERR = "mt-1 text-[11px] font-semibold text-rose-600 dark:text-rose-400";
const SHOW_MAX = 40;
const SHIFT_PILL = {
  A: "bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-200",
  B: "bg-violet-100 text-violet-800 dark:bg-violet-500/15 dark:text-violet-200",
  G: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300",
};

export function ShiftBadge({ shift }) {
  if (!shift) return null;
  const short = ["A", "B", "G"].includes(shift);
  return (
    <span className={`badge whitespace-nowrap ${SHIFT_PILL[shift] || "bg-slate-100 text-slate-600 dark:bg-navy-800 dark:text-slate-300"}`}>
      {short ? `${shift} shift` : shift}
    </span>
  );
}

function PersonCard({ emp, onClear, disabled }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-emerald-200 bg-emerald-50/70 px-3 py-2.5 dark:border-emerald-500/30 dark:bg-emerald-500/10">
      <UserCheck size={18} className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
      <div className="min-w-0 flex-1 text-sm">
        <div className="flex flex-wrap items-center gap-2 font-semibold text-slate-800 dark:text-white">{emp.name} <ShiftBadge shift={emp.shift} /></div>
        <div className="text-xs text-slate-600 dark:text-slate-300">
          {[emp.employee_code && `Code ${emp.employee_code}`, emp.department, emp.designation].filter(Boolean).join(" · ")}
        </div>
      </div>
      {!disabled && (
        <button type="button" onClick={onClear} aria-label="Change the person" title="Change the person"
          className="-m-1 shrink-0 rounded-md p-2 text-slate-400 hover:bg-emerald-100 hover:text-slate-600 dark:hover:bg-emerald-500/20 dark:hover:text-slate-200">
          <X size={18} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

export default function PersonPicker({
  value, onChange, disabled = false, required = true, error,
  label = "Person taking the part — code or name",
}) {
  const id = useId();
  const qc = useQueryClient();
  const emp = value?.employee || null;
  const [typed, setTyped] = useState(value?.typed || "");
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(-1);
  const [reading, setReading] = useState(false);
  const inputRef = useRef(null);
  const duty = useQuery({
    queryKey: ["employees", "on-duty"],
    queryFn: () => employeeService.onDuty({}, { silent: true }).then((r) => r.data.data),
    staleTime: 60_000,
  });
  const rows = duty.data?.rows || [];
  const failed = (duty.data?.rosters || []).filter((x) => !x.ok);
  const matches = useMemo(() => {
    const t = typed.trim().toLowerCase();
    const hit = t ? rows.filter((r) => (r.name || "").toLowerCase().includes(t) || (r.employee_code || "").toLowerCase().includes(t)) : rows;
    // An exact code first: a typed "455" puts code 455 on top, not 1455.
    return [...hit].sort((a, b) => Number((b.employee_code || "").toLowerCase() === t) - Number((a.employee_code || "").toLowerCase() === t))
      .slice(0, SHOW_MAX);
  }, [rows, typed]);

  const send = (employee, text) => onChange?.({ employee, mobile: employee?.mobile || null, typed: text });
  const pick = (p) => { setOpen(false); setHi(-1); setTyped(""); send(p, ""); };
  const clear = () => { setTyped(""); send(null, ""); setTimeout(() => inputRef.current?.focus(), 0); };
  useEffect(() => { setHi(matches.length ? 0 : -1); }, [typed]); // eslint-disable-line react-hooks/exhaustive-deps

  const onKey = (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      if (matches.length) setHi((h) => (h + (e.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (open && hi >= 0 && matches[hi]) pick(matches[hi]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };
  const readAgain = async () => {
    setReading(true);
    try {
      await employeeService.onDuty({ refresh: true }, { silent: true });
      await qc.invalidateQueries({ queryKey: ["employees", "on-duty"] });
    } catch { /* the note below stays */ } finally {
      setReading(false);
    }
  };

  const heading = <>{label}{required && <span className="text-rose-500" aria-hidden="true"> *</span>}</>;
  if (emp) {
    return (
      <div>
        <p className="text-sm text-slate-600 dark:text-slate-300">{heading}</p>
        <div className="mt-1"><PersonCard emp={emp} onClear={clear} disabled={disabled} /></div>
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-sm text-slate-600 dark:text-slate-300">{heading}</label>
      <div className="relative">
        <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden="true" />
        <input id={id} ref={inputRef} className={`${INPUT} !pl-9 ${error ? "border-rose-400 dark:border-rose-500/60" : ""}`}
          placeholder="Employee code or name" value={typed} disabled={disabled} autoComplete="off"
          onChange={(e) => { setTyped(e.target.value); setOpen(true); send(null, e.target.value); }}
          onFocus={() => setOpen(true)} onClick={() => setOpen(true)} onBlur={() => setOpen(false)} onKeyDown={onKey}
          role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={`${id}-list`} aria-invalid={Boolean(error) || undefined} />
        {duty.isLoading && <LoaderCircle size={16} className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-slate-400" aria-hidden="true" />}
        {open && !duty.isLoading && (
          matches.length > 0 ? (
            <ul id={`${id}-list`} role="listbox" aria-label="On duty today"
              className="absolute inset-x-0 top-full z-30 mt-1 max-h-72 overflow-y-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg dark:border-navy-700 dark:bg-navy-900">
              {matches.map((p, i) => (
                <li key={p.id} role="option" aria-selected={i === hi}>
                  {/* mousedown: the box keeps the focus, so its blur does not close the list first */}
                  <button type="button" tabIndex={-1} onMouseDown={(e) => { e.preventDefault(); pick(p); }} onMouseEnter={() => setHi(i)}
                    className={`flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm ${i === hi ? "bg-slate-100 dark:bg-navy-800" : "hover:bg-slate-50 dark:hover:bg-navy-800/60"}`}>
                    <span className="w-14 shrink-0 font-semibold tabular text-slate-800 dark:text-white">{p.employee_code || "—"}</span>
                    <span className="min-w-0 flex-1 truncate text-slate-700 dark:text-slate-200">{p.name}</span>
                    <span className="hidden shrink-0 text-[11px] text-slate-400 sm:inline">{p.department}</span>
                    <ShiftBadge shift={p.shift} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p id={`${id}-list`} className="absolute inset-x-0 top-full z-30 mt-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-500 shadow-lg dark:border-navy-700 dark:bg-navy-900 dark:text-slate-400">
              {rows.length ? `No one on duty today matches "${typed.trim()}".` : "No one on duty today in the rosters."} A new person is added in the Maintenance / Tool Room app.
            </p>
          )
        )}
      </div>
      {error && <p className={ERR} role="alert">{error}</p>}
      {(failed.length > 0 || duty.isError) && (
        <p className="flex flex-wrap items-center gap-x-2 text-[11px] text-amber-700 dark:text-amber-300">
          {duty.isError ? "The rosters could not be read." : `${failed.map((x) => x.department).join(" and ")} roster not reachable — its people show as "Shift not known".`}
          <button type="button" onClick={readAgain} disabled={reading} className="inline-flex items-center gap-1 font-semibold underline underline-offset-2">
            <RefreshCw size={11} className={reading ? "animate-spin" : ""} aria-hidden="true" />Read again
          </button>
        </p>
      )}
    </div>
  );
}
