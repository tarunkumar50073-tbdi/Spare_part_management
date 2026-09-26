import React, { memo } from "react";
import { Check } from "lucide-react";

// SCAN -> IDENTIFY -> VERIFY -> ACTION -> CONFIRM (spec 28): the operator's
// progress through one part, always on screen so "what do I do now" is never a
// guess. The workstation decides the current step from what is on screen; this
// only draws it. `complete` marks every step done (the action was recorded);
// `action` is an optional control shown beside the steps (the next step).
const STEPS = [
  { key: "SCAN", label: "Scan" },
  { key: "IDENTIFY", label: "Identify" },
  { key: "VERIFY", label: "Verify" },
  { key: "ACTION", label: "Action" },
  { key: "CONFIRM", label: "Confirm" },
];

function StepIndicator({ current, complete = false, hint, action = null }) {
  const at = Math.max(0, STEPS.findIndex((s) => s.key === current));
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl2 border border-slate-200 bg-white px-3 py-2.5 dark:border-navy-800 dark:bg-navy-900 sm:px-4">
      <div className="min-w-[15rem] flex-1">
        <ol className="flex items-center gap-1.5 sm:gap-2" aria-label="Scan progress">
          {STEPS.map((s, i) => {
            const done = complete || i < at;
            const now = !complete && i === at;
            return (
              <li key={s.key} className="flex min-w-0 flex-1 items-center gap-1.5 sm:gap-2"
                aria-current={now ? "step" : undefined}>
                <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold transition-colors ${
                  done ? "bg-emerald-500 text-white"
                    : now ? "bg-toyotared text-white ring-4 ring-toyotared/15"
                      : "bg-slate-100 text-slate-400 dark:bg-navy-800 dark:text-slate-500"}`}>
                  {done ? <Check size={13} strokeWidth={3} aria-hidden="true" /> : i + 1}
                </span>
                {/* On a phone only the current step keeps its word; the numbers
                    still show where the operator is. */}
                <span className={`truncate text-[11px] font-bold uppercase tracking-wider ${
                  now ? "text-toyotared" : done ? "hidden text-emerald-700 dark:text-emerald-300 sm:inline"
                    : "hidden text-slate-400 sm:inline"}`}>
                  {s.label}
                  <span className="sr-only">{done ? " (done)" : now ? " (current step)" : ""}</span>
                </span>
                {i < STEPS.length - 1 && (
                  <span className={`h-0.5 min-w-[0.75rem] flex-1 rounded-full ${done ? "bg-emerald-400" : "bg-slate-200 dark:bg-navy-700"}`}
                    aria-hidden="true" />
                )}
              </li>
            );
          })}
        </ol>
        {hint && <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400" aria-live="polite">{hint}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export default memo(StepIndicator);
