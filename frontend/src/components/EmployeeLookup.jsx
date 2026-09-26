import React, { useEffect, useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, Phone, RotateCcw, UserCheck, UserPlus, UserX, X } from "lucide-react";
import { useCan } from "./Can.jsx";
import { departmentService } from "../services/departmentService.js";
import { employeeService, normaliseMobile } from "../services/employeeService.js";

// "Who is taking the part?" by mobile number. The operator types the number;
// a person on the Employee master fills in by themselves (name, code,
// department). A number not on the master opens a short "add this person"
// entry right here, so the issue never waits on a separate screen. An
// inactive person is shown but never handed to the parent.
//
// Props:
//   value        { employee, mobile, typed? } — what onChange last gave the parent
//   onChange({ employee, mobile, typed })
//                employee  the picked ACTIVE person, else null
//                mobile    the typed number normalised to 10 digits, null while incomplete
//                typed     the raw text, so a form can tell "half typed" from "empty"
//   defaultDepartment   the quick-add's department to start with
//   required     shows the red asterisk (the parent decides what it blocks)
//   error        the parent's message while no one is picked (e.g. after Review)
//   disabled, label
// The typed text is this component's own once mounted — key it to start over.
const INPUT = "input-field text-base"; // 16px: a tablet does not zoom into the box
const ERR = "mt-1 text-[11px] font-semibold text-rose-600 dark:text-rose-400";
const LOOKUP_DELAY_MS = 300;           // look up once the typing pauses
const IDLE = { status: "idle", result: null };
const EMPTY_DRAFT = { name: "", employee_code: "", department: "", designation: "", company: "" };
const FIELD_NAMES = {
  mobile: "Mobile", name: "Name", employee_code: "Employee code", department: "Department",
  designation: "Designation", company: "Company",
};

/** Digits a number needs before it is looked up: half-way through
 *  "+91 98765 43210" there are already ten ("9198765432"), and that passes
 *  for a mobile number — so with "+" wait for all twelve, and the same for
 *  "91 " / "91-" (the country code typed without the "+"); with "0" for
 *  eleven. "919876543210" run together stays ambiguous at ten digits. */
const digitsNeeded = (t) => (t.startsWith("+") || /^91\D/.test(t) ? 12 : t.startsWith("0") ? 11 : 10);

/** The number to look up, or null while it is still being typed / not a mobile. */
function lookupNumber(text) {
  const t = String(text || "").trim();
  return t.replace(/\D/g, "").length >= digitsNeeded(t) ? normaliseMobile(t) : null;
}

/** The server's reason in the operator's words (a 422 lists its fields). */
function reasonOf(e, fallback) {
  if (!e?.response) return `${fallback} — no answer from the server. Check the connection and try again.`;
  const { message, errors } = e.response.data || {};
  const fields = errors && typeof errors === "object"
    ? Object.entries(errors).map(([k, v]) => `${FIELD_NAMES[k] || k}: ${[].concat(v).join(" ")}`).join(" · ")
    : "";
  return fields || message || fallback;
}

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
        // A finger-sized target: this is used on the store's tablet.
        <button type="button" onClick={onClear} aria-label="Change the person" title="Change the person"
          className="-m-1 shrink-0 rounded-md p-2 text-slate-400 hover:bg-emerald-100 hover:text-slate-600 dark:hover:bg-emerald-500/20 dark:hover:text-slate-200">
          <X size={18} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

export default function EmployeeLookup({
  value, onChange, defaultDepartment, disabled = false, required = true, error,
  label = "Mobile number of the person taking the part",
}) {
  const id = useId();
  const qc = useQueryClient();
  // Both hooks always run (a short-circuit would change the hook order).
  const canScan = useCan("scan_part", "edit");
  const canMaster = useCan("employees", "edit");
  const canAdd = canScan || canMaster;
  const emp = value?.employee || null;
  const [typed, setTyped] = useState(() => value?.typed ?? value?.mobile ?? "");
  const [state, setState] = useState(() => (emp ? { status: "found", result: null } : IDLE));
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  // Every change of the number takes a new ticket; an answer that comes back
  // for an older number (slow network, a digit deleted meanwhile, the form
  // closed) is dropped instead of filling in the wrong person.
  const seq = useRef(0);
  const timer = useRef(null);
  const typedRef = useRef(typed);
  const inputRef = useRef(null);
  const nameRef = useRef(null);
  const focusNext = useRef(null); // "input" | "name": where the caret goes after this render
  // Set by Enter / Retry: the operator has finished the number, so a "not on
  // the master" answer may move the caret on to Name. The look-up after a
  // pause never does — it can land while the number is still being typed
  // ("919876543210" is a valid mobile at its tenth digit), and the last
  // digits would go into Name. Any edit of the number clears it.
  const askedRef = useRef(false);
  // The parent's latest onChange, so an answer arriving later reports to the
  // form as it is now (a parent may pass a fresh arrow each render).
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; });
  const send = (employee, mobile) => onChangeRef.current?.({ employee, mobile, typed: typedRef.current });

  // Same cache as the forms' department select.
  const depts = useQuery({
    queryKey: ["departments", "active"],
    queryFn: () => departmentService.list(true).then((r) => r.data.data || []),
    staleTime: 5 * 60_000,
    enabled: state.status === "missing" && canAdd,
  });

  const apply = (data, mobile) => {
    if (data.found && data.active) {
      setState({ status: "found", result: data });
      send(data.employee, mobile);
      return;
    }
    if (!data.found) {
      // The quick-add opens with the form's department, and the caret moves to
      // Name when the operator asked for this answer and has not gone to
      // another box meanwhile (after Retry the focus is nowhere: its button is gone).
      setDraft((d) => ({ ...d, department: d.department || defaultDepartment || "" }));
      const at = document.activeElement;
      if (askedRef.current && (at === inputRef.current || at === document.body)) focusNext.current = "name";
    }
    setState({ status: data.found ? "inactive" : "missing", result: data });
    send(null, mobile);
  };

  const lookUp = async (mobile, ticket) => {
    try {
      const res = await employeeService.lookup(mobile, { silent: true });
      if (ticket === seq.current) apply(res.data.data, mobile);
    } catch (e) {
      if (ticket === seq.current) setState({ status: "error", result: reasonOf(e, "Could not look the number up") });
    }
  };

  /** Look the typed number up now: Enter, Retry, or a number already there on mount. */
  const lookUpNow = () => {
    const mobile = lookupNumber(typedRef.current);
    if (!mobile) return;
    clearTimeout(timer.current);
    timer.current = null;
    const ticket = ++seq.current;
    setState({ status: "loading", result: null });
    lookUp(mobile, ticket);
  };

  const retry = () => {
    askedRef.current = true;
    lookUpNow();
  };

  const onType = (text) => {
    typedRef.current = text;
    askedRef.current = false;
    setTyped(text);
    setErr(null);
    clearTimeout(timer.current);
    timer.current = null;
    const ticket = ++seq.current;
    const mobile = lookupNumber(text);
    if (mobile) {
      setState({ status: "loading", result: null });
      timer.current = setTimeout(() => { timer.current = null; lookUp(mobile, ticket); }, LOOKUP_DELAY_MS);
    } else {
      setState(IDLE);
    }
    send(null, mobile);
  };

  // Enter looks the number up at once instead of waiting for the pause (an
  // answer already on its way is not asked for twice, it moves the caret on
  // when it lands), and on a number not on the master steps to Name.
  const onNumberKey = (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    askedRef.current = true;
    if (timer.current || state.status === "error") lookUpNow();
    else if (state.status === "missing") nameRef.current?.focus();
  };

  useEffect(() => {
    // Back from a confirm step with a number but no one picked: look it up again.
    if (!emp && lookupNumber(typedRef.current)) lookUpNow();
    return () => { clearTimeout(timer.current); seq.current += 1; };
    // Mount / unmount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!focusNext.current) return;
    (focusNext.current === "name" ? nameRef : inputRef).current?.focus();
    focusNext.current = null;
  });

  const clear = () => {
    clearTimeout(timer.current);
    timer.current = null;
    seq.current += 1;
    typedRef.current = "";
    askedRef.current = false;
    setTyped("");
    setState(IDLE);
    setDraft(EMPTY_DRAFT);
    setErr(null);
    focusNext.current = "input";
    send(null, null);
  };

  const addPerson = async () => {
    const mobile = lookupNumber(typedRef.current);
    if (!mobile) { setErr("Enter a valid 10-digit mobile number first"); return; }
    if (!draft.name.trim()) { setErr("Name is required"); return; }
    if (!draft.department) { setErr("Department is required"); return; }
    const ticket = seq.current;
    setSaving(true);
    setErr(null);
    try {
      const res = await employeeService.create({
        mobile, name: draft.name.trim(), employee_code: draft.employee_code.trim() || null,
        department: draft.department, designation: draft.designation.trim() || null,
        company: draft.company.trim() || null,
      }, { silent: true });
      qc.invalidateQueries({ queryKey: ["employees"] });
      if (ticket !== seq.current) return;
      setDraft(EMPTY_DRAFT);
      apply({ mobile, found: true, active: true, employee: res.data.data }, mobile);
    } catch (e) {
      // 409: the number may have been added meanwhile (another terminal, the
      // master screen) — then that record is the person; otherwise it is the
      // employee code that clashes, and the message says whose it is.
      if (e?.response?.status === 409) {
        const now = await employeeService.lookup(mobile, { silent: true }).then((r) => r.data.data).catch(() => null);
        if (ticket !== seq.current) return;
        if (now?.found) { apply(now, mobile); return; }
      }
      if (ticket === seq.current) setErr(reasonOf(e, "Could not add the person"));
    } finally {
      setSaving(false);
    }
  };

  const setField = (k) => (e) => {
    const v = e.target.value;
    setDraft((d) => ({ ...d, [k]: v }));
    setErr(null);
  };

  // Enter steps to the next box (the tablet keyboard's "Next") and from the
  // last one to the Add button — it never saves by itself, so a gun scan that
  // ends in Enter cannot add a person.
  const onDraftKey = (e) => {
    if (e.key !== "Enter" || e.target.tagName === "BUTTON") return;
    e.preventDefault();
    const boxes = [...e.currentTarget.querySelectorAll("input,select,button:not(:disabled)")];
    boxes[boxes.indexOf(e.target) + 1]?.focus();
  };

  const heading = (
    <>{label}{required && <span className="text-rose-500" aria-hidden="true"> *</span>}</>
  );

  if (emp) {
    return (
      <div>
        <p className="text-sm text-slate-600 dark:text-slate-300">{heading}</p>
        <div className="mt-1"><PersonCard emp={emp} onClear={clear} disabled={disabled} /></div>
      </div>
    );
  }

  const invalid = typed.replace(/\D/g, "").length >= digitsNeeded(typed.trim()) && !lookupNumber(typed);
  const loading = state.status === "loading";
  // The parent's message, unless one of our own already says more.
  const showError = Boolean(error) && !invalid && !loading && state.status !== "error";
  const who = state.result?.employee;

  return (
    <div className="space-y-2">
      <div>
        <label htmlFor={id} className="text-sm text-slate-600 dark:text-slate-300">{heading}</label>
        <div className="relative mt-1">
          <Phone size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden="true" />
          {/* The phone pad (inputMode "tel"): a tablet's number pad has no "+" key for "+91". */}
          <input
            id={id} ref={inputRef} type="tel" inputMode="tel" enterKeyHint="search" autoComplete="off"
            maxLength={16} disabled={disabled || saving}
            className={`${INPUT} !pl-9 tabular ${invalid || showError ? "border-rose-400 dark:border-rose-500/60" : ""}`}
            placeholder="10-digit mobile no." value={typed}
            onChange={(e) => onType(e.target.value)} onKeyDown={onNumberKey}
            aria-invalid={invalid || showError || undefined} aria-required={required || undefined}
          />
          {loading && (
            <LoaderCircle size={16} className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-slate-400" aria-hidden="true" />
          )}
        </div>
        {loading && <span className="sr-only" role="status">Looking the number up…</span>}
        {invalid && <p className={ERR} role="alert">Not a valid 10-digit mobile number.</p>}
        {showError && <p className={ERR} role="alert">{error}</p>}
        {state.status === "error" && (
          <p className={`${ERR} flex flex-wrap items-center gap-x-2`} role="alert">
            <span>{state.result}</span>
            <button type="button" onClick={retry} className="inline-flex items-center gap-1 underline underline-offset-2">
              <RotateCcw size={12} aria-hidden="true" />Retry
            </button>
          </p>
        )}
      </div>
      {state.status === "inactive" && (
        <p className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          <UserX size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            {who?.name}{who?.employee_code ? ` (${who.employee_code})` : ""} is marked inactive in the Employee Master, so
            they can&apos;t be picked. {canMaster ? "Make them active there" : "Ask an administrator to make them active"}, or
            type another number.
          </span>
        </p>
      )}
      {state.status === "missing" && (canAdd ? (
        <div onKeyDown={onDraftKey}
          className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-navy-700 dark:bg-navy-800/50">
          <p className="flex items-center gap-2 text-xs font-semibold text-slate-700 dark:text-slate-200">
            <UserPlus size={15} aria-hidden="true" /> +91 {state.result?.mobile} is not on the Employee Master — add them
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            <input ref={nameRef} className={INPUT} placeholder="Name *" value={draft.name} maxLength={80}
              onChange={setField("name")} autoCapitalize="words" enterKeyHint="next" aria-label="Name" aria-required="true" />
            <input className={INPUT} placeholder="Employee code" value={draft.employee_code} maxLength={30}
              onChange={setField("employee_code")} autoCapitalize="characters" enterKeyHint="next" aria-label="Employee code" />
            <select className={INPUT} value={draft.department} onChange={setField("department")} disabled={depts.isPending}
              aria-label="Department" aria-required="true">
              <option value="">{depts.isPending ? "Loading departments…" : "Department *"}</option>
              {(depts.data || []).map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
            </select>
            <input className={INPUT} placeholder="Designation" value={draft.designation} maxLength={60}
              onChange={setField("designation")} enterKeyHint="next" aria-label="Designation" />
            <input className={`${INPUT} sm:col-span-2`} placeholder="Company / contractor (if not TBDI)" value={draft.company}
              maxLength={80} onChange={setField("company")} enterKeyHint="next" aria-label="Company" />
          </div>
          {depts.isError && (
            <p className={ERR} role="alert">
              Couldn&apos;t load the department master.{" "}
              <button type="button" onClick={() => depts.refetch()} className="underline underline-offset-2">Retry</button>
            </p>
          )}
          {err && <p className={ERR} role="alert">{err}</p>}
          <div className="flex justify-end">
            <button type="button" className="btn-primary disabled:cursor-not-allowed disabled:opacity-60" onClick={addPerson}
              disabled={saving || disabled} aria-busy={saving}>
              {saving
                ? <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />
                : <UserPlus size={16} aria-hidden="true" />}
              {saving ? "Saving…" : "Add person & use"}
            </button>
          </div>
        </div>
      ) : (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          +91 {state.result?.mobile} is not on the Employee Master — ask a supervisor to add them, or type another number.
        </p>
      ))}
    </div>
  );
}
