import React, { useContext, useEffect, useRef } from "react";
import { ArrowRight, CircleAlert, Info, Lock, TriangleAlert } from "lucide-react";
import ActionConfirm, { StepLabel } from "../ActionConfirm.jsx";
import { useCan } from "../../Can.jsx";
import { FlowStepContext, inputCls, isStoreDepartment, useDepartments } from "./flow.js";

// The visual building blocks shared by every Scan Part action form
// (components/scan/forms; the state machine and helpers are in flow.js).
// Each form is VERIFY (facts read from the scan result) -> ACTION (the inputs)
// -> CONFIRM (ActionConfirm, a read-back of the exact payload). The pieces here
// keep that path identical on every action, so an operator who has done one
// has done them all.

/**
 * The frame of every form: VERIFY facts, ACTION inputs, then [Cancel] [Review].
 * While a review is open it renders ActionConfirm in place of the form (the
 * form's state lives in the form component, so Back returns to it intact).
 * `flow` is the form's useActionFlow().
 * `editRight` { mod, label } names a second right that may save this form, for
 * a write whose endpoint accepts it as well as Scan Part edit.
 */
export function FormShell({
  flow, verify, children, onCancel, onReview, reviewLabel = "Review", reviewIcon: ReviewIcon = ArrowRight,
  blocked = false, editRight = null, right = "update",
}) {
  // Saving needs Scan Part edit — or the form's own right: the install update
  // saves with Confirm Installation edit too (the confirm endpoint accepts it),
  // so a Line User login is not shown "View only" with no Confirm button on the
  // one screen it is for (store's role templates, 17 Oct 2026). Both hooks always
  // run; with no editRight the second asks the same as the first.
  // `right` is the form's CRUD action (24 Oct 2026): "create" for an issue,
  // return or RGP out, "update" for the rest.
  const mayScan = useCan("scan_part", right);
  const mayOwn = useCan(editRight?.mod || "scan_part", right);
  const mayEdit = mayScan || mayOwn;
  const word = right === "create" ? "Create" : "Edit";
  const rightText = editRight ? `the Scan Part or ${editRight.label} ${word} right` : `the Scan Part ${word} right`;
  // Tell the workstation's step indicator where the operator is. Through a
  // ref, so a parent passing a fresh arrow each render does not re-fire it.
  const onStep = useContext(FlowStepContext);
  const onStepRef = useRef(onStep);
  useEffect(() => { onStepRef.current = onStep; });
  const step = flow.review ? "CONFIRM" : "ACTION";
  useEffect(() => { onStepRef.current?.(step); }, [step]);

  if (flow.review) {
    return (
      <ActionConfirm {...flow.review} busy={flow.busy} onBack={flow.back}
        canSave={mayEdit} lockedText={`View only — saving needs ${rightText}`}
        onConfirm={() => flow.review.submit()} />
    );
  }
  return (
    <div className="space-y-4">
      {!mayEdit && (
        <p className="flex items-center gap-1.5 rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-600 dark:bg-navy-800 dark:text-slate-300">
          <Lock size={13} aria-hidden="true" />View only — you can fill this in and review it, but saving needs {rightText}.
        </p>
      )}
      {verify && (
        <div>
          <StepLabel n={1} label="Verify" />
          {verify}
        </div>
      )}
      <div>
        <StepLabel n={verify ? 2 : 1} label="Action" />
        <div className="space-y-3">{children}</div>
      </div>
      {flow.failure && <FailureNote kind={flow.failure} />}
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 pt-3 dark:border-navy-800">
        <button type="button" className="btn-secondary" onClick={onCancel}>Cancel</button>
        <button type="button" onClick={onReview} disabled={blocked}
          className="btn-primary px-5 py-2.5 text-base disabled:cursor-not-allowed disabled:opacity-50">
          {reviewLabel}<ReviewIcon size={18} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

function FailureNote({ kind }) {
  return (
    <div role="alert" className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300">
      <CircleAlert size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
      {kind === "no-answer"
        ? "No answer from the server — it is not known whether this was saved. Check the part's history before trying again."
        : "Not saved — the server refused it (the reason is in the message shown). Nothing changed; correct the entry and review again."}
    </div>
  );
}

// ---- layout pieces -------------------------------------------------------------

/** The VERIFY block: read-only facts from the scan result.
 *  items: [{ label, value, empty?, strong?, wide? }] — falsy items are skipped. */
export function Facts({ items }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border border-slate-200 bg-slate-50/70 p-3 sm:grid-cols-3 dark:border-navy-700 dark:bg-navy-800/40">
      {items.filter(Boolean).map((f) => {
        const missing = f.value == null || f.value === "";
        return (
          <div key={f.label} className={`min-w-0 ${f.wide ? "col-span-2 sm:col-span-3" : ""}`}>
            <dt className="text-[11px] uppercase tracking-wide text-slate-400">{f.label}</dt>
            <dd className={`break-words ${f.strong ? "text-base" : "text-sm"} ${missing
              ? "font-normal text-slate-400" : `${f.strong ? "font-bold" : "font-semibold"} text-slate-800 dark:text-slate-100`}`}>
              {missing ? (f.empty || "—") : f.value}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/** A labelled input with its inline error (or hint). */
export function Field({ label, required, error, hint, htmlFor, className = "", children }) {
  return (
    <div className={className}>
      <label htmlFor={htmlFor} className="text-sm text-slate-600 dark:text-slate-300">
        {label}{required && <span className="text-rose-500" aria-hidden="true"> *</span>}
      </label>
      <div className="mt-1">{children}</div>
      {error ? (
        <p className="mt-1 text-[11px] font-semibold text-rose-600 dark:text-rose-400" role="alert">{error}</p>
      ) : hint ? (
        <p className="mt-1 text-[11px] text-slate-400">{hint}</p>
      ) : null}
    </div>
  );
}

/** A form-level inline error that belongs to no single field. */
export function FormError({ children }) {
  if (!children) return null;
  return <p className="text-[11px] font-semibold text-rose-600 dark:text-rose-400" role="alert">{children}</p>;
}

/** "What happens next" note — the honest line about stock and ERP. */
export function Note({ children, tone = "info" }) {
  const tones = {
    info: "border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-200",
    warn: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200",
  };
  const Icon = tone === "warn" ? TriangleAlert : Info;
  return (
    <p className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${tones[tone]}`}>
      <Icon size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

/** Nothing to act on (e.g. a deep link to a document already closed). */
export function EmptyNote({ children, onCancel }) {
  return (
    <div className="space-y-3">
      <p className="rounded-lg border border-dashed border-slate-300 px-3 py-4 text-sm text-slate-500 dark:border-navy-700 dark:text-slate-400">
        {children}
      </p>
      <div className="flex justify-end">
        <button type="button" className="btn-secondary" onClick={onCancel}>Close</button>
      </div>
    </div>
  );
}

/**
 * Large radio buttons (check result, quality department, which bucket …).
 * options: [{ value, label, hint?, dot? }]
 */
export function Segmented({ options, value, onChange, label, error, columns, size = "md" }) {
  const cols = columns || Math.min(options.length, 4);
  const grid = { 1: "grid-cols-1", 2: "grid-cols-2", 3: "grid-cols-3", 4: "grid-cols-2 sm:grid-cols-4" }[cols] || "grid-cols-2";
  return (
    <div role="radiogroup" aria-label={label} className={`grid gap-2 ${grid}`}>
      {options.map((o) => {
        const on = value === o.value;
        return (
          <button key={o.value} type="button" role="radio" aria-checked={on} onClick={() => onChange(o.value)}
            className={`rounded-lg border text-left transition-colors ${size === "lg" ? "px-4 py-4" : "px-3 py-2"} ${on
              ? "border-toyotared bg-rose-50/60 ring-1 ring-toyotared dark:bg-rose-500/10"
              : error
                ? "border-rose-300 bg-white hover:border-slate-300 dark:border-rose-500/40 dark:bg-navy-900"
                : "border-slate-200 bg-white hover:border-slate-300 dark:border-navy-700 dark:bg-navy-900 dark:hover:border-navy-600"}`}>
            <span className={`flex items-center gap-2 font-semibold text-slate-800 dark:text-slate-100 ${size === "lg" ? "text-base" : "text-sm"}`}>
              {o.dot && <span className={`${size === "lg" ? "h-3.5 w-3.5" : "h-2.5 w-2.5"} shrink-0 rounded-full ${o.dot}`} aria-hidden="true" />}
              {o.label}
            </span>
            {o.hint && <span className="mt-0.5 block text-[11px] text-slate-500 dark:text-slate-400">{o.hint}</span>}
          </button>
        );
      })}
    </div>
  );
}

// ---- open-document pick lists ----------------------------------------------------

/** Radio cards for the open documents (pick from flow.js useDocChoice);
 *  `render(doc)` draws one card's body. */
export function DocPicker({ legend, docs, value, onChange, render, name, error }) {
  return (
    <fieldset>
      <legend className="text-sm text-slate-600 dark:text-slate-300">
        {legend}{docs.length > 1 ? ` — ${docs.length} open` : ""}
      </legend>
      <div className="mt-1 max-h-80 space-y-2 overflow-y-auto pr-0.5">
        {docs.map((d) => {
          const on = String(value) === String(d.id);
          return (
            <label key={d.id}
              className={`block cursor-pointer rounded-lg border p-3 transition-colors ${on
                ? "border-toyotared bg-rose-50/40 ring-1 ring-toyotared dark:bg-rose-500/5"
                : error
                  ? "border-rose-300 dark:border-rose-500/40"
                  : "border-slate-200 hover:border-slate-300 dark:border-navy-700 dark:hover:border-navy-600"}`}>
              <span className="flex items-start gap-3">
                <input type="radio" name={name} value={d.id} checked={on} onChange={() => onChange(d.id)}
                  className="mt-1 h-4 w-4 shrink-0 accent-toyotared" />
                <span className="block min-w-0 flex-1">{render(d)}</span>
              </span>
            </label>
          );
        })}
      </div>
      <FormError>{error}</FormError>
    </fieldset>
  );
}

/** Shown when the picked document was closed while the form was open. */
export function GoneNote() {
  return (
    <Note tone="warn">
      The document you picked is no longer open — it may have been completed on another terminal. Pick another, or cancel.
    </Note>
  );
}

// ---- masters ------------------------------------------------------------------

/** Department <select> fed by the master — never a free-typed department.
 *  `noStore` leaves the store's own department out: an issue is for the
 *  department the part goes to, never the store that hands it out. */
export function DepartmentSelect({ id, value, onChange, error, noStore = false }) {
  const { data, isPending, isError, refetch } = useDepartments();
  const shown = (data || []).filter((d) => !noStore || !isStoreDepartment(d.name));
  if (isError) {
    return (
      <p className="text-xs text-rose-600 dark:text-rose-400" role="alert">
        Couldn&apos;t load the department master.{" "}
        <button type="button" onClick={() => refetch()} className="font-semibold underline underline-offset-2">Retry</button>
      </p>
    );
  }
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)} disabled={isPending}
      className={inputCls(error, "text-base")}>
      <option value="">{isPending ? "Loading departments…" : "Select department…"}</option>
      {shown.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
    </select>
  );
}
