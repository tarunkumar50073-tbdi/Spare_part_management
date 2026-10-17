import React from "react";
import { ArrowLeft, ArrowRight, Check, CircleCheck, LoaderCircle, Lock } from "lucide-react";
import Can from "../Can.jsx";
import { statusMeta } from "../../lib/scanStatus.js";
import { num } from "../../lib/format.js";

// The CONFIRM step of SCAN -> IDENTIFY -> VERIFY -> ACTION -> CONFIRM (spec 28).
// Every Scan Part form ends here: one calm read-back of exactly what will be
// written — the part, the quantity, where it moves from and to, and the fields
// that go with it — before anything touches the server. What is shown is the
// payload the form built when the operator pressed Review, so what they read is
// what is sent.
//
// Props:
//   title         "Issue", "RGP GRN", ... (the action being confirmed)
//   icon          lucide component for the action
//   part          { part_no, part_name }
//   qty, uom      the quantity the action moves (omit for a location change)
//   moves         [{ qty?, from, to }] status badges; from / to are a
//                 lib/scanStatus SCAN_STATUS key or a { label, badge, dot? } meta
//   changes       [{ label, from, to }] plain before -> after values (location, machine…)
//   fields        [{ label, value }] key fields; empty values read "Not recorded"
//   note          what this does NOT do yet (e.g. "Stock is not added now")
//   confirmLabel  the button text ("Confirm Issue")
//   busy          a write is in flight — both buttons are locked
//   onBack()      back to the form, values kept
//   onConfirm()   send it
//   canSave       optional: whether this user may save it (FormShell passes it,
//                 since a form can name a right of its own); left out, it is
//                 Scan Part edit, as before
//   lockedText    optional: what shows in place of the button when they may not

// Receipt / RGP / issue status metas carry only a badge class; the dot colour
// follows the badge tone so every status reads with the same visual language.
const DOT_BY_BADGE = {
  "badge-success": "bg-emerald-500",
  "badge-warning": "bg-amber-500",
  "badge-danger": "bg-red-500",
  "badge-info": "bg-sky-500",
  "badge-neutral": "bg-slate-400",
};

const toMeta = (s) => (typeof s === "string" ? statusMeta(s) : s || statusMeta(null));

/** A status as a badge with its coloured dot (the spec's status colours). */
export function StatusBadge({ status, className = "" }) {
  const m = toMeta(status);
  const dot = m.dot || DOT_BY_BADGE[m.badge] || "bg-slate-400";
  return (
    <span className={`badge ${m.badge || "badge-neutral"} gap-1.5 ${className}`}>
      <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
      {m.label}
    </span>
  );
}

const shown = (v) => (v == null || v === "" ? null : v);

export default function ActionConfirm({
  title, icon: Icon = CircleCheck, part, qty, uom, moves = [], changes = [], fields = [],
  note, confirmLabel = "Confirm", busy = false, onBack, onConfirm, canSave, lockedText,
}) {
  const locked = (
    <span className="inline-flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
      <Lock size={14} aria-hidden="true" />{lockedText || "View only — saving needs the Scan Part edit right"}
    </span>
  );
  // Deliberately NOT auto-focused: a scan gun ends every read with Enter, and a
  // focused Confirm would turn the next scan into a write.
  const confirmButton = (
    <button type="button" className="btn-primary px-5 py-2.5 text-base disabled:cursor-not-allowed disabled:opacity-60"
      onClick={onConfirm} disabled={busy} aria-busy={busy}>
      {busy ? <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> : <Check size={18} aria-hidden="true" />}
      {busy ? "Saving…" : confirmLabel}
    </button>
  );
  return (
    <section aria-label={`Confirm ${title}`} className="space-y-4">
      <StepLabel n={3} label="Confirm" />

      <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4 dark:border-navy-700 dark:bg-navy-800/40">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white text-toyotared shadow-card dark:bg-navy-900">
            <Icon size={20} aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="kpi-label">{title}</p>
            <p className="truncate text-lg font-bold text-slate-900 dark:text-white">{part?.part_no || "—"}</p>
            {part?.part_name && (
              <p className="truncate text-sm text-slate-500 dark:text-slate-400" title={part.part_name}>{part.part_name}</p>
            )}
          </div>
          {qty != null && (
            <div className="shrink-0 text-right">
              <p className="kpi-label">Quantity</p>
              <p className="kpi-value">{num(qty)}</p>
              {uom && <p className="text-xs text-slate-400">{uom}</p>}
            </div>
          )}
        </div>

        {moves.length > 0 && (
          <ul className="mt-4 space-y-2" aria-label="Status change">
            {moves.map((m, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2">
                {m.qty != null && moves.length > 1 && (
                  <span className="w-14 text-right text-sm font-semibold tabular-nums text-slate-700 dark:text-slate-200">{num(m.qty)}</span>
                )}
                <StatusBadge status={m.from} />
                <ArrowRight size={16} className="text-slate-400" aria-label="to" />
                <StatusBadge status={m.to} />
              </li>
            ))}
          </ul>
        )}

        {changes.length > 0 && (
          <dl className="mt-4 space-y-1.5">
            {changes.map((c) => (
              <div key={c.label} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
                <dt className="w-28 shrink-0 text-slate-500 dark:text-slate-400">{c.label}</dt>
                <dd className="flex min-w-0 flex-wrap items-center gap-2">
                  {/* Nothing recorded before: just the new value, no struck-out "Not recorded". */}
                  {shown(c.from) != null && (
                    <>
                      <span className="text-slate-400 line-through decoration-slate-300 dark:decoration-navy-600">{shown(c.from)}</span>
                      <ArrowRight size={14} className="text-slate-400" aria-label="to" />
                    </>
                  )}
                  <span className="font-semibold text-slate-900 dark:text-white">{shown(c.to) ?? "Not recorded"}</span>
                </dd>
              </div>
            ))}
          </dl>
        )}

        {fields.length > 0 && (
          <dl className="mt-4 grid grid-cols-1 gap-x-4 gap-y-2 border-t border-slate-200 pt-3 sm:grid-cols-2 dark:border-navy-700">
            {fields.map((f) => (
              <div key={f.label} className="min-w-0">
                <dt className="text-[11px] uppercase tracking-wide text-slate-400">{f.label}</dt>
                <dd className={`break-words text-sm ${shown(f.value) != null ? "font-semibold text-slate-800 dark:text-slate-100" : "text-slate-400"}`}>
                  {shown(f.value) ?? "Not recorded"}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>

      {note && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          {note}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3 dark:border-navy-800">
        <button type="button" className="btn-secondary" onClick={onBack} disabled={busy}>
          <ArrowLeft size={16} aria-hidden="true" />Back
        </button>
        {canSave === undefined
          ? <Can mod="scan_part" edit fallback={locked}>{confirmButton}</Can>
          : canSave ? confirmButton : locked}
      </div>
    </section>
  );
}

/** Section heading of the form's own steps — "1 Verify", "2 Action", "3 Confirm"
 *  — matching the workstation's SCAN -> ... -> CONFIRM indicator above. */
export function StepLabel({ n, label }) {
  return (
    <p className="mb-2 flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-slate-800 text-[10px] text-white dark:bg-slate-200 dark:text-navy-900">{n}</span>
      {label}
    </p>
  );
}
